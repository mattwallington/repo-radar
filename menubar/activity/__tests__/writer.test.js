'use strict';
// Node mirror of the meaningful scenarios in repo_radar/tests/test_activity_writer.py (Task
// 2.2c), MINUS the two threading/concurrency tests (test_post_terminal_control_is_dropped_...,
// test_concurrent_start_and_terminal_writes_single_start) -- moot in Node, whose event loop makes
// the race those tests drive impossible to construct in the first place (see writer.js's header
// comment for why the RLock + I4 under-lock recheck are not ported). Plus coverage for
// dropLocalReference()/_handedOff, the Node-only parent-side handoff primitive writer.py has no
// analog for (see the brief and writer.js's own comment on that method).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../index');
const { writer, quota, reconcile } = A;
const { ActivityWriter } = writer;
const lease = require('../lease');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-writer-'));
}

function mkWriter(home, opts = {}) {
  return new ActivityWriter(home, {
    kind: 'sync', channel: 'stable', trigger: 'cli', producer: 'electron', ...opts,
  });
}

// Mirrors test_activity_writer.py's `_read_all` helper: raw json.loads/JSON.parse over every
// *.jsonl segment for an activity, sorted by filename -- deliberately NOT the validated
// parseValid, so a malformed/poisoned line would throw here exactly like Python's bare
// `json.loads` would (tests that expect a poisoned segment read it via the validator directly
// instead, same as the Python suite does).
function readAll(home, aid) {
  const dir = A.activityDir(home, aid);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
  } catch (e) {
    return [];
  }
  const recs = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      recs.push(JSON.parse(line));
    }
  }
  return recs;
}

test('full lifecycle: mint, start, event, terminal settles the ledger and releases the lease', () => {
  const home = tmpHome();
  const w = mkWriter(home);
  const ownerToken = w._lease.ownerToken; // capture before terminal() releases the lease
  w.start();
  w.event('repos_loaded', 'info', { count: 30 });
  w.terminal('succeeded', { repos_changed: 2, errors: 0, warns: 0 });

  const recs = readAll(home, w.activityId);
  const types = recs.map((r) => r.type);
  assert.strictEqual(types.filter((t) => t === 'start').length, 1);
  assert.ok(types.includes('event'));
  assert.strictEqual(types[types.length - 1], 'terminal');
  assert.strictEqual(recs[recs.length - 1].outcome, 'succeeded');
  assert.strictEqual(recs[recs.length - 1].by, ownerToken);
  // Ruling B: Node's quota.settle() is a documented no-op on the ledger (Python's settle
  // unlinks the entry; Node delegates that removal to a later Python prune pass -- see
  // quota.js's header comment and quota.test.js's own "settle is a no-op" test). So unlike the
  // Python original, the ledger entry legitimately REMAINS on disk here -- what writer.js
  // actually owns and must get right is that the LEASE was released.
  assert.ok(fs.existsSync(A.ledgerEntryPath(home, w.activityId)), 'Ruling B: settle() must not remove the ledger entry');
  assert.strictEqual(lease.probe(A.ownerLockPath(home, w.activityId)), lease.FREE, 'lease released after terminal()');
});

test('cancel_requested control is idempotent and uses the reserve slot', () => {
  const home = tmpHome();
  const w = mkWriter(home);
  w.start();
  w.control('cancel_requested');
  w.control('cancel_requested');
  const cancels = readAll(home, w.activityId).filter((r) => r.type === 'control' && r.name === 'cancel_requested');
  assert.strictEqual(cancels.length, 1); // one-shot slot
});

test('dropped-events integrity note is one-shot, and terminal still lands via the reserve', () => {
  const home = tmpHome();
  const w = mkWriter(home);
  w.start();
  const realGrant = quota.grant;
  quota.grant = () => false; // ordinary capacity gone
  try {
    w.event('dropped1', 'info', { x: 1 });
    w.event('dropped2', 'info', { x: 2 }); // both refused
    const notes = readAll(home, w.activityId).filter((r) => r.type === 'integrity' && r.kind === 'dropped-events');
    assert.strictEqual(notes.length, 1); // emitted at most once
    w.terminal('failed', { repos_changed: 0, errors: 1, warns: 0 }); // reserve bypasses grant
  } finally {
    quota.grant = realGrant;
  }
  assert.ok(readAll(home, w.activityId).some((r) => r.type === 'terminal'));
});

test('terminal append failure does not settle or swallow the reservation', () => {
  const home = tmpHome();
  const w = mkWriter(home);
  w.start(); // real fsync, succeeds
  const realFsync = fs.fsyncSync;
  fs.fsyncSync = () => { throw new Error('no fsync'); };
  try {
    w.terminal('succeeded', { repos_changed: 0, errors: 0, warns: 0 }); // durable write fails
  } finally {
    fs.fsyncSync = realFsync;
  }
  assert.ok(fs.existsSync(A.ledgerEntryPath(home, w.activityId)), 'reservation PRESERVED');
  // a later reconcile pass can synthesize from the freed lease + preserved reserve
});

test('best-effort write failure never raises (segment open throws on start())', () => {
  const home = tmpHome();
  const w = mkWriter(home);
  const paths = require('../paths');
  const realOpen = paths.secureOpenAppend;
  paths.secureOpenAppend = () => { throw new Error('disk full'); };
  const errs = [];
  const realErr = console.error;
  console.error = (msg) => errs.push(msg);
  try {
    assert.doesNotThrow(() => w.start());
  } finally {
    paths.secureOpenAppend = realOpen;
    console.error = realErr;
  }
  assert.ok(errs.some((m) => /activity/i.test(m)));
});

test('an adopter has no cancellation authority', () => {
  const home = tmpHome();
  const minter = mkWriter(home);
  minter.start();
  const dupFd = fs.openSync(`/dev/fd/${minter._lease.fd}`, 'r+'); // simulate an inherited fd
  const adopter = mkWriter(home, {
    producer: 'dispatcher', inheritedId: minter.activityId, inheritedFd: dupFd, ownerToken: minter._lease.ownerToken,
  });
  adopter.control('cancel_requested'); // must be a no-op (not the authority)
  const cancels = readAll(home, minter.activityId).filter((r) => r.type === 'control' && r.name === 'cancel_requested');
  assert.deepStrictEqual(cancels, []);
});

test('construction failure yields an inactive writer, never raises', () => {
  const home = tmpHome();
  const paths = require('../paths');
  const realMkdir = paths.secureMkdir;
  paths.secureMkdir = () => { throw new Error('mkdir denied'); };
  let w;
  try {
    assert.doesNotThrow(() => { w = mkWriter(home); });
  } finally {
    paths.secureMkdir = realMkdir;
  }
  assert.strictEqual(w._active, false);
  assert.deepStrictEqual(w.handOffEnv(), {}); // never exposes a dead fd
  assert.doesNotThrow(() => { w.start(); w.event('x', 'info'); w.terminal('succeeded'); w.dropLocalReference(); });
});

test('admission refusal leaves handOffEnv empty', () => {
  const home = tmpHome();
  const realAdmit = quota.admit;
  quota.admit = () => false;
  let w;
  try {
    w = mkWriter(home);
  } finally {
    quota.admit = realAdmit;
  }
  assert.strictEqual(w._active, false);
  assert.deepStrictEqual(w.handOffEnv(), {});
});

test('settle failure during terminal still frees the lock', () => {
  const home = tmpHome();
  const w = mkWriter(home);
  const aid = w.activityId;
  w.start();
  const realSettle = quota.settle;
  quota.settle = () => { throw new Error('boom'); };
  const errs = [];
  const realErr = console.error;
  console.error = (msg) => errs.push(msg);
  try {
    assert.doesNotThrow(() => w.terminal('succeeded', { repos_changed: 0, errors: 0, warns: 0 }));
  } finally {
    quota.settle = realSettle;
    console.error = realErr;
  }
  assert.ok(errs.some((m) => /activity/i.test(m)));
  // the lease MUST be released even though settle threw -> lock is FREE
  assert.strictEqual(lease.probe(A.ownerLockPath(home, aid)), lease.FREE);
});

test('terminal ensures exactly one start when none was written first', () => {
  const home = tmpHome();
  const w = mkWriter(home, { kind: 'system', channel: 'dev', trigger: 'scheduled' });
  w.terminal('blocked', { reason: 'x' }); // no explicit start() first
  const types = readAll(home, w.activityId).map((r) => r.type);
  assert.strictEqual(types.filter((t) => t === 'start').length, 1);
  assert.strictEqual(types[types.length - 1], 'terminal');
});

test('a failed (non-durable) start writes no terminal; the lease is freed', () => {
  // NOTE on fidelity: this globally mocks fs.fsyncSync exactly like the Python original mocks
  // the shared `os.fsync`, which -- in BOTH languages -- also breaks quota's OWN ledger-entry
  // fsync (paths.js's writeOwnedFileAtomic / Python's quota._write_entry), so `quota.grant`
  // itself fails and the 'start' emit returns _NOTHING (nothing written at all), not merely
  // "written but not durable". Verified empirically against the current repo_radar/activity
  // (Python): under this same global mock, `_read_all` after `w.start()` is genuinely `[]`. So
  // this test asserts exactly what the Python original actually asserts -- no terminal record,
  // lease released -- rather than a stronger "a start line landed" claim neither language's
  // behavior here actually supports.
  const home = tmpHome();
  const w = mkWriter(home);
  const aid = w.activityId;
  const realFsync = fs.fsyncSync;
  fs.fsyncSync = () => { throw new Error('no fsync'); };
  try {
    w.start();
    w.terminal('succeeded', { repos_changed: 0, errors: 0, warns: 0 });
  } finally {
    fs.fsyncSync = realFsync;
  }
  assert.ok(readAll(home, aid).every((r) => r.type !== 'terminal')); // writer wrote no terminal
  assert.strictEqual(lease.probe(A.ownerLockPath(home, aid)), lease.FREE); // lease released
  assert.strictEqual(reconcile._hasStart(home, aid), false); // nothing durable ever landed
});

test('a start LINE that is written but not fsync-confirmed (WROTE, not DURABLE) still yields no terminal-only item', () => {
  // Complementary to the test above: here the fsync failure is scoped to ONLY the segment fd
  // (via the same spy-on-secureOpenAppend technique the C1 close-failure test below uses), so
  // quota's own ledger fsync succeeds and the 'start' record's bytes genuinely land on disk --
  // exercising the true _WROTE (not _NOTHING) branch of the tri-state, distinct from the test
  // above.
  const home = tmpHome();
  const w = mkWriter(home);
  const aid = w.activityId;
  const paths = require('../paths');
  const realOpen = paths.secureOpenAppend;
  const segFds = [];
  paths.secureOpenAppend = (...a) => {
    const fd = realOpen(...a);
    segFds.push(fd);
    return fd;
  };
  const realFsync = fs.fsyncSync;
  fs.fsyncSync = (fd) => {
    if (segFds.includes(fd)) throw new Error('no fsync (segment only)');
    return realFsync(fd); // quota's own ledger fsync succeeds normally throughout
  };
  try {
    w.start();
    assert.strictEqual(reconcile._hasStart(home, aid), true); // the line genuinely landed
    assert.strictEqual(w._started, false); // ...but not confirmed durable

    w.terminal('succeeded', { repos_changed: 0, errors: 0, warns: 0 });
  } finally {
    paths.secureOpenAppend = realOpen;
    fs.fsyncSync = realFsync;
  }
  assert.ok(readAll(home, aid).every((r) => r.type !== 'terminal')); // still no terminal-only item
  assert.strictEqual(lease.probe(A.ownerLockPath(home, aid)), lease.FREE);
});

test('start retry after an fsync failure re-fsyncs the same line -- no duplicate start, strictly increasing seq', () => {
  const home = tmpHome();
  const w = mkWriter(home); // construct first (admission uses real fsync)
  const realFsync = fs.fsyncSync;
  let i = 0;
  fs.fsyncSync = (fd) => {
    i += 1;
    if (i === 1) throw new Error('transient'); // start line written; only its fsync fails
    return realFsync(fd);
  };
  try {
    w.start(); w.start(); // retry re-fsyncs the SAME line, then writes ownership
  } finally {
    fs.fsyncSync = realFsync;
  }
  const recs = readAll(home, w.activityId);
  assert.strictEqual(recs.filter((r) => r.type === 'start').length, 1);
  const seqs = recs.map((r) => r.seq);
  const sorted = [...seqs].sort((a, b) => a - b);
  assert.deepStrictEqual(seqs, sorted); // no seq regression (start < ownership)
  assert.strictEqual(new Set(seqs).size, seqs.length);
});

test('a partial write then error retries into exactly one clean start (segment write seam)', () => {
  const home = tmpHome();
  const w = mkWriter(home);
  const realWrite = writer._segWrite;
  let i = 0;
  writer._segWrite = (fd, buf, offset, length, position) => {
    i += 1;
    if (i === 1) {
      realWrite(fd, buf, offset, 5, position); // write a 5-byte prefix, then fail
      throw new Error('boom');
    }
    return realWrite(fd, buf, offset, length, position);
  };
  try {
    w.start(); // partial line truncated away -> _NOTHING
  } finally {
    writer._segWrite = realWrite;
  }
  w.start(); // retry -> exactly one CLEAN start, no partial line
  const recs = readAll(home, w.activityId); // parses cleanly (no orphan prefix)
  assert.strictEqual(recs.filter((r) => r.type === 'start').length, 1);
});

test('a rollback (ftruncate) failure rotates to a fresh segment, poisoning the old one', () => {
  const home = tmpHome();
  const records = require('../records');
  const w = mkWriter(home);
  const poisonedSeg = w._seg;
  const realWrite = writer._segWrite;
  const realFtruncate = writer._segFtruncate;
  writer._segWrite = (fd, buf, offset, length, position) => {
    realWrite(fd, buf, offset, 5, position); // a real partial write
    throw new Error('boom'); // ...then failure
  };
  writer._segFtruncate = () => { throw new Error('rollback also fails'); }; // e.g. ENOSPC
  try {
    w.start(); // write fails, rollback ALSO fails -> rotate
  } finally {
    writer._segWrite = realWrite;
    writer._segFtruncate = realFtruncate;
  }

  assert.notStrictEqual(w._seg, poisonedSeg); // rotated to a NEW segment path
  assert.ok(fs.existsSync(poisonedSeg));
  const poisonedBytes = fs.readFileSync(poisonedSeg);
  assert.strictEqual(poisonedBytes.length, 5); // exactly the un-rolled-back partial prefix
  assert.strictEqual(records.parseValid(poisonedBytes, w.activityId), null); // never parses as valid

  w.start(); // retry lands in the CLEAN (rotated) segment
  assert.strictEqual(w._started, true);
  const cleanRecs = fs.readFileSync(w._seg, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.strictEqual(cleanRecs.filter((r) => r.type === 'start').length, 1);
  // the poisoned segment is never touched again
  assert.deepStrictEqual(fs.readFileSync(poisonedSeg), poisonedBytes);
  // the injected failure only touched SEGMENT writes -- quota's own ledger persistence was
  // never corrupted by it
  assert.notStrictEqual(quota._readEntry(A.ledgerEntryPath(home, w.activityId)), quota.CORRUPT);
});

test('a rotation failure cannot escape the never-raises boundary even when rollback ALSO fails', () => {
  const home = tmpHome();
  const w = mkWriter(home);
  const realWrite = writer._segWrite;
  const realFtruncate = writer._segFtruncate;
  const realMintToken = require('../ids').mintToken;
  writer._segWrite = (fd, buf, offset, length, position) => {
    realWrite(fd, buf, offset, 5, position);
    throw new Error('boom');
  };
  writer._segFtruncate = () => { throw new Error('rollback also fails'); };
  require('../ids').mintToken = () => { throw new Error('crypto.randomBytes failed'); }; // rotation itself fails

  try {
    assert.doesNotThrow(() => w.start()); // must NOT raise, even though rotation ALSO fails
  } finally {
    writer._segWrite = realWrite;
    writer._segFtruncate = realFtruncate;
    require('../ids').mintToken = realMintToken;
  }

  assert.strictEqual(w._active, false); // degraded to inactive: no working segment left

  // a subsequent emit is a clean no-op (never-raises holds even after this degradation)
  assert.doesNotThrow(() => {
    w.event('x', 'info');
    w.terminal('succeeded', { repos_changed: 0, errors: 0, warns: 0 });
  });
  // mint_token failing meant rotation never reassigned w._seg, so the ONLY segment on disk is
  // still the poisoned one (5 raw garbage bytes) -- read it back via the canonical validator.
  const records = require('../records');
  const validTypes = [];
  for (const seg of A.readOwnedSegments(A.activityDir(home, w.activityId))) {
    for (const line of seg.data.toString('utf8').split('\n')) {
      if (!line) continue;
      const obj = records.parseValid(line, w.activityId);
      if (obj !== null) validTypes.push(obj.type);
    }
  }
  assert.ok(!validTypes.includes('terminal')); // nothing further was ever durably written
});

test('a refused start writes nothing at all -- no terminal-only item', () => {
  const home = tmpHome();
  const w = mkWriter(home);
  const aid = w.activityId;
  const realGrant = quota.grant;
  quota.grant = () => false; // even the start is refused
  try {
    w.start();
    w.terminal('succeeded', { repos_changed: 0, errors: 0, warns: 0 });
  } finally {
    quota.grant = realGrant;
  }
  assert.deepStrictEqual(readAll(home, aid), []);
  assert.strictEqual(lease.probe(A.ownerLockPath(home, aid)), lease.FREE);
});

test('an event is never appended when grant refuses it (grant-before-append ordering)', () => {
  const home = tmpHome();
  const w = mkWriter(home);
  w.start();
  const realGrant = quota.grant;
  quota.grant = () => false;
  try {
    w.event('x', 'info');
  } finally {
    quota.grant = realGrant;
  }
  assert.deepStrictEqual(readAll(home, w.activityId).filter((r) => r.type === 'event'), []);
});

test('a non-serializable field value never raises and just drops the event', () => {
  const home = tmpHome();
  const w = mkWriter(home);
  w.start();
  const circular = {};
  circular.self = circular; // JSON.stringify throws on this -- the JS analog of Python's object()
  assert.doesNotThrow(() => w.event('x', 'info', { bad: circular }));
  w.terminal('succeeded', { repos_changed: 0, errors: 0, warns: 0 }); // sync still finalizes cleanly
  assert.ok(readAll(home, w.activityId).some((r) => r.type === 'terminal'));
});

test('a nested field value is redacted', () => {
  const home = tmpHome();
  const w = mkWriter(home);
  w.start();
  w.event('x', 'error', { meta: { nested: 'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' } });
  const blob = JSON.stringify(readAll(home, w.activityId));
  assert.ok(!blob.includes('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'));
});

test('a configured non-pattern secret is masked on the write path (event field, detail, and control field)', () => {
  const home = tmpHome();
  const secret = 'my-configured-ci-token-9f8e7d6c5b4a';
  const w = mkWriter(home, { configuredSecrets: [secret] });
  w.start();
  w.event('x', 'info', { detail: `output contained ${secret} inline`, note: `token=${secret}` });
  w.control('note', { msg: `secret is ${secret}` });
  w.terminal('succeeded', { repos_changed: 0, errors: 0, warns: 0, hint: secret });
  const blob = JSON.stringify(readAll(home, w.activityId));
  assert.ok(!blob.includes(secret), 'configured secret must never appear verbatim on disk');
  assert.ok(blob.includes('[REDACTED]'));
});

// --- C1 (close() can raise), Ruling-7/C2 (adopted lease must not be force-unlocked) ------------

test('an emit close failure degrades to not-durable, never escapes (C1)', () => {
  const home = tmpHome();
  const w = mkWriter(home);
  const paths = require('../paths');
  const realOpen = paths.secureOpenAppend;
  const segFds = [];
  paths.secureOpenAppend = (...a) => {
    const fd = realOpen(...a);
    segFds.push(fd); // remember exactly which fd is the segment's
    return fd;
  };
  const realClose = fs.closeSync;
  fs.closeSync = (fd) => {
    if (segFds.includes(fd)) throw new Error('EIO on close'); // only the segment fd's close fails
    return realClose(fd); // unrelated closes (e.g. quota's lock fd) go through untouched
  };
  const errs = [];
  const realErr = console.error;
  console.error = (msg) => errs.push(msg);
  try {
    assert.doesNotThrow(() => w.start()); // write + fsync succeed; close() fails
  } finally {
    paths.secureOpenAppend = realOpen;
    fs.closeSync = realClose;
    console.error = realErr;
  }
  assert.ok(errs.some((m) => /activity/i.test(m)));
  assert.strictEqual(w._started, false); // close failure -> treated as not durable
});

test('terminal() on an adopted writer releases via dropLocalReference, never force-unlocking the shared lease (Ruling-7 / C2)', () => {
  const home = tmpHome();
  const minter = mkWriter(home);
  minter.start();
  const lockPath = A.ownerLockPath(home, minter.activityId);
  const siblingFd = fs.openSync(`/dev/fd/${minter._lease.fd}`, 'r+'); // simulates a still-open parent copy
  const dupForAdopter = fs.openSync(`/dev/fd/${minter._lease.fd}`, 'r+'); // the fd the adopter inherits
  const adopter = mkWriter(home, {
    producer: 'dispatcher', inheritedId: minter.activityId, inheritedFd: dupForAdopter, ownerToken: minter._lease.ownerToken,
  });
  adopter.terminal('cancelled');
  // siblingFd (and minter's own fd) are still open on the shared OFD -> the flock must still be
  // BUSY. If terminal() had wrongly called release() (a force-unlock in Python; in Node it's
  // mechanically the same bare close either way -- see writer.js's _releaseLease comment -- so
  // this specifically proves the CALLING DISCIPLINE, not just the mechanism.)
  assert.strictEqual(lease.probe(lockPath), lease.BUSY);
  fs.closeSync(siblingFd);
});

// --- Node-only: dropLocalReference()/_handedOff (parent-side handoff; no writer.py analog) ------

test('dropLocalReference() hands off cleanly: sets _handedOff, deactivates, and does NOT unlock a lease a live child shares', async () => {
  const home = tmpHome();
  const { spawn } = require('child_process');
  const w = mkWriter(home);
  w.start();
  const lockPath = A.ownerLockPath(home, w.activityId);
  const env = w.handOffEnv();
  assert.strictEqual(env.REPO_RADAR_ACTIVITY_ID, w.activityId);

  // a live child inherits the fd directly (shares the SAME OFD) and just stays alive holding it
  const child = spawn('/bin/sleep', ['5'], { stdio: ['ignore', 'ignore', 'ignore', w._lease.fd] });
  await new Promise((resolve) => { setTimeout(resolve, 200); }); // let the child actually start

  assert.doesNotThrow(() => w.dropLocalReference());
  assert.strictEqual(w._handedOff, true);
  assert.strictEqual(w._active, false);
  assert.strictEqual(lease.probeBusy(lockPath), true, 'dropLocalReference must NOT release a lock a live child still holds');

  // idempotent / never-raises: calling it again, or any other public method, is a safe no-op now
  assert.doesNotThrow(() => { w.dropLocalReference(); w.start(); w.event('x', 'info'); w.terminal('succeeded'); });
  assert.deepStrictEqual(w.handOffEnv(), {});

  child.kill('SIGKILL');
  await new Promise((resolve) => { child.once('exit', resolve); });
  assert.strictEqual(lease.probeBusy(lockPath), false, 'lock free once the child (the last OFD reference) exits');
});

test('dropLocalReference() on an inactive/never-active writer is a safe no-op', () => {
  const home = tmpHome();
  const paths = require('../paths');
  const realMkdir = paths.secureMkdir;
  paths.secureMkdir = () => { throw new Error('mkdir denied'); };
  let w;
  try {
    w = mkWriter(home);
  } finally {
    paths.secureMkdir = realMkdir;
  }
  assert.strictEqual(w._active, false);
  assert.doesNotThrow(() => w.dropLocalReference());
  assert.strictEqual(w._handedOff, false); // nothing to hand off -- never claims a handoff happened
});

test('handOffEnv() shape and inactive-writer emptiness', () => {
  const home = tmpHome();
  const w = mkWriter(home);
  const env = w.handOffEnv();
  assert.deepStrictEqual(Object.keys(env).sort(), [
    'REPO_RADAR_ACTIVITY_ID', 'REPO_RADAR_ACTIVITY_LOCK_FD', 'REPO_RADAR_ACTIVITY_OWNER_TOKEN',
  ]);
  assert.strictEqual(env.REPO_RADAR_ACTIVITY_ID, w.activityId);
  assert.strictEqual(env.REPO_RADAR_ACTIVITY_OWNER_TOKEN, w._lease.ownerToken);
  assert.strictEqual(env.REPO_RADAR_ACTIVITY_LOCK_FD, String(w._lease.fd));
  w.terminal('succeeded');
  assert.deepStrictEqual(w.handOffEnv(), {}); // inactive after terminal() -> empty
});
