'use strict';
// Node mirror of repo_radar/tests/test_activity_lease.py (Task 2.2a), plus additional §5
// truth-table coverage the brief calls out explicitly (step-1 bad token, step-2 identity
// mismatch, step-4 reassert-fails) that the Python suite exercises implicitly across fewer
// scenarios. See ../lease.js for the mechanism (shells out to /usr/bin/lockf since stock Node
// has no flock(2) binding); repo_radar/activity/lease.py is the source of truth for semantics.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const paths = require('../paths');
const ids = require('../ids');
const { FREE, BUSY, UNCERTAIN, HandoffRejected, acquire, probe, probeBusy, adopt } = require('../lease');

const VALID = '00000000-0000-4000-8000-000000000000';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-lease-'));
}

function lockFor(home) {
  const d = paths.activityDir(home, VALID);
  paths.secureMkdir(d);
  return paths.ownerLockPath(home, VALID);
}

test('acquire is exclusive; probe reflects BUSY/FREE across the acquire/release transition', () => {
  const lp = lockFor(tmpHome());
  const l1 = acquire(lp);
  assert.ok(l1 !== null, 'first acquire must succeed');
  assert.strictEqual(ids.validToken(l1.ownerToken), true);
  assert.strictEqual(probeBusy(lp), true, 'independent probe must see it held');
  assert.strictEqual(probe(lp), BUSY);
  assert.strictEqual(acquire(lp), null, 'second acquire must fail while held (BUSY)');

  l1.release();
  assert.strictEqual(probeBusy(lp), false);
  assert.strictEqual(probe(lp), FREE);

  const l2 = acquire(lp);
  assert.ok(l2 !== null, 'acquire must succeed again now that it is free');
  l2.release();
});

test('adopt ACCEPTS a genuinely dup\'d/inherited fd whose identity matches (§5, all four steps pass)', () => {
  const lp = lockFor(tmpHome());
  const holder = acquire(lp);
  assert.ok(holder !== null);
  // /dev/fd/<n> is a genuine dup at the OS level (same open-file-description, so it carries the
  // held flock with it) -- the Node analog of Python's `os.dup(holder.fd)`; stock Node's fs
  // module has no direct dup() binding.
  const dupFd = fs.openSync(`/dev/fd/${holder.fd}`, 'r+');
  const adopted = adopt(dupFd, holder.ownerToken, lp);
  assert.ok(adopted !== null);
  assert.strictEqual(adopted.ownerToken, holder.ownerToken, 'adopt carries the SAME token -- one logical lease');
  assert.strictEqual(adopted.fd, dupFd);

  holder.dropLocalReference(); // our copy only; the adopted fd still shares the OFD
  assert.strictEqual(probeBusy(lp), true, 'still held via the adopted fd');
  adopted.release();
  assert.strictEqual(probeBusy(lp), false);
});

test('adopt REJECTS an unlocked look-alike fd (step 3: independent probe is not BUSY)', () => {
  const lp = lockFor(tmpHome());
  acquire(lp).release(); // create the lock FILE (unheld) so 'r+' below has something to open
  // Right inode (it IS lockPath), but nobody holds the lock -- an independent probe would
  // succeed (see FREE), so step 3 must reject before ever reasserting.
  const fd = fs.openSync(lp, 'r+');
  assert.throws(() => adopt(fd, 'deadbeef', lp), HandoffRejected);
  fs.closeSync(fd);
});

test('adopt REJECTS a fd whose identity does not match lockPath (step 2: fstat identity mismatch)', () => {
  const home = tmpHome();
  const lp = lockFor(home);
  const decoy = path.join(home, 'not-the-owner-lock');
  fs.writeFileSync(decoy, '');
  const fd = fs.openSync(decoy, 'r+'); // a regular file, but a DIFFERENT inode than lockPath
  assert.throws(() => adopt(fd, 'deadbeef', lp), HandoffRejected);
  fs.closeSync(fd);
});

test('adopt REJECTS a fresh fd on an inode a DIFFERENT lease holds (step 4: reassert on an independent OFD fails)', () => {
  const lp = lockFor(tmpHome());
  const other = acquire(lp); // a DIFFERENT lease genuinely holds the flock
  assert.ok(other !== null);
  // Fresh, INDEPENDENT open-file-description on the same inode -- does NOT share other's OFD, so
  // step 3's independent probe correctly reports BUSY (other holds it), but step 4's reassert on
  // THIS fd contends with other's lock and must fail.
  const fd = fs.openSync(lp, 'r+');
  assert.throws(() => adopt(fd, 'deadbeef', lp), HandoffRejected);
  fs.closeSync(fd);
  other.release();
});

test('adopt REJECTS a syntactically invalid owner token or fd (step 1)', () => {
  const lp = lockFor(tmpHome());
  const holder = acquire(lp);
  assert.ok(holder !== null);
  assert.throws(() => adopt(holder.fd, 'not-a-valid-token', lp), HandoffRejected);
  assert.throws(() => adopt(holder.fd, '', lp), HandoffRejected);
  assert.throws(() => adopt(-1, 'deadbeef', lp), HandoffRejected);
  assert.throws(() => adopt(1.5, 'deadbeef', lp), HandoffRejected);
  holder.release();
});

test('dropLocalReference leaves the lock held for a live child sharing the OFD; the child\'s exit frees it', async () => {
  const lp = lockFor(tmpHome());
  const l = acquire(lp);
  assert.ok(l !== null);

  // A live child inherits l.fd directly (shares the SAME open-file-description) and just stays
  // alive holding it -- this is the scenario dropLocalReference() exists for (finding 5): a bare
  // close of OUR copy must not evict the child's lease.
  const child = spawn('/bin/sleep', ['5'], { stdio: ['ignore', 'ignore', 'ignore', l.fd] });
  await new Promise((resolve) => setTimeout(resolve, 200)); // let the child actually start

  l.dropLocalReference();
  assert.strictEqual(probeBusy(lp), true, 'dropLocalReference must NOT release a lock a live child still holds');

  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
  assert.strictEqual(probeBusy(lp), false, 'lock must be free once the child (the last OFD reference) exits');
});

test('acquire refuses a FIFO owner.lock promptly -- process-boundary timeout guard (no in-process hang)', () => {
  // Node has no stdlib equivalent of Python's `signal.alarm` that can interrupt a blocked
  // synchronous syscall from inside the SAME process, so the fixture runs as a CHILD process
  // under a wall-clock spawnSync timeout: a real regression that made acquire/probe block on a
  // FIFO would time out and get killed here, failing loudly, instead of hanging the whole
  // `node --test` run forever.
  const home = tmpHome();
  const fixture = path.join(__dirname, 'fixtures', 'fifo-acquire-check.js');
  const r = spawnSync(process.execPath, [fixture, home], { timeout: 5000, encoding: 'utf8' });
  assert.ifError(r.error);
  assert.strictEqual(r.signal, null, `fixture was killed (signal=${r.signal}) -- likely blocked on the FIFO`);
  assert.strictEqual(r.status, 0, `fixture failed:\n${r.stderr}`);
});

test('acquire refuses owner.lock under a symlinked INTERMEDIATE component', () => {
  const home = tmpHome();
  const lp = lockFor(home); // creates the real activity dir first
  const outside = path.join(home, 'outside');
  fs.mkdirSync(outside);
  const activityRoot = path.dirname(paths.quotaDir(home)); // .../repo-radar/activity
  fs.rmSync(activityRoot, { recursive: true, force: true });
  fs.symlinkSync(outside, activityRoot);
  assert.strictEqual(acquire(lp), null);
});

test('probe and failed acquire never leak fds (BUSY path)', () => {
  const home = tmpHome();
  const lp = lockFor(home);
  const missing = path.join(home, 'no-such-activity-dir', 'owner.lock');
  const holder = acquire(lp);
  assert.ok(holder !== null);

  const before = fs.readdirSync('/dev/fd').length;
  for (let i = 0; i < 40; i++) {
    assert.strictEqual(probe(lp), BUSY);           // independent open + contend + must close
    assert.strictEqual(probe(missing), UNCERTAIN); // open fails (missing dir) -> nothing to leak
    assert.strictEqual(acquire(lp), null);          // fails while held -> must close its own fd
  }
  const after = fs.readdirSync('/dev/fd').length;
  assert.ok(after - before <= 2, `fd count grew from ${before} to ${after} across 120 BUSY-path calls -- suspected leak`);

  holder.release();
});

test('probe never leaks fds on the FREE path (the FREE branch closes what it just locked)', () => {
  const lp = lockFor(tmpHome());
  // probe() opens WITHOUT O_CREAT (mirrors lease.py exactly) -- create+release once first so the
  // file exists and every loop iteration below exercises the real FREE branch (successful
  // lockf + close), not the "file doesn't exist yet" UNCERTAIN branch.
  acquire(lp).release();

  const before = fs.readdirSync('/dev/fd').length;
  for (let i = 0; i < 40; i++) {
    assert.strictEqual(probe(lp), FREE);
  }
  const after = fs.readdirSync('/dev/fd').length;
  assert.ok(after - before <= 2, `fd count grew from ${before} to ${after} across 40 FREE-path calls -- suspected leak`);
});
