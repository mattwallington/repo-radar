'use strict';
// Node mirror of the key scenarios in repo_radar/tests/test_activity_reconcile.py (Task 2.2b),
// plus coverage for the Node-specific gating reconcile.js folds in (see ../reconcile.js's header
// comment: Node's synthesizeTerminal derives has-start/has-terminal itself, since there is no
// separate `_reconcileOneLocked` wrapper on the Node side).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../index');
// Local var name kept distinct from the Task 3.3 read-side `reconcile` FUNCTION imported below
// (`../reconcile`'s own `reconcile` export) -- this one is the reconcile.js MODULE namespace, as
// re-exported (namespaced, not flattened) by index.js.
const { reconcile: reconcileMod } = A;

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-reconcile-'));
}

function newActivity(home) {
  const aid = A.mintActivityId();
  A.secureMkdir(A.activityDir(home, aid));
  const l = A.acquire(A.ownerLockPath(home, aid));
  return [aid, l];
}

function writeRecord(home, aid, rec) {
  const full = { schema_version: 1, activity_id: aid, ts: '2026-08-14T00:00:00-07:00', ...rec };
  const seg = A.segmentPath(home, aid, 'python', 'deadbeef');
  const fd = A.secureOpenAppend(seg);
  fs.writeSync(fd, Buffer.from(`${JSON.stringify(full)}\n`));
  fs.closeSync(fd);
}

function writeStart(home, aid) {
  writeRecord(home, aid, {
    type: 'start', seq: 0, kind: 'sync', channel: 'stable', trigger: 'cli', created_by: 'python',
  });
}

function topTerminalOutcomes(home, aid) {
  const out = [];
  for (const seg of A.readOwnedSegments(A.activityDir(home, aid))) {
    for (const line of seg.data.toString('utf8').split('\n')) {
      if (!line) continue;
      const obj = A.parseValid(line, aid);
      if (obj !== null && obj.type === 'terminal') out.push([obj.outcome, obj.by]);
    }
  }
  return out;
}

test('synthesizes an interrupted terminal when the lease is free and a start is durable', () => {
  const home = tmpHome();
  try {
    const [aid, l] = newActivity(home);
    writeStart(home, aid);
    l.release(); // crash after start, before terminal

    assert.strictEqual(reconcileMod.synthesizeTerminal(home, aid), true);
    assert.deepStrictEqual(topTerminalOutcomes(home, aid), [['interrupted', 'reconciler']]);

    // the lease was released again -> a fresh acquire must succeed
    const fresh = A.acquire(A.ownerLockPath(home, aid));
    assert.ok(fresh !== null);
    fresh.release();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('synthesizes a cancelled terminal when a cancel_requested control record is present', () => {
  const home = tmpHome();
  try {
    const [aid, l] = newActivity(home);
    writeStart(home, aid);
    writeRecord(home, aid, { type: 'control', seq: 1, name: 'cancel_requested' });
    l.release();

    assert.strictEqual(reconcileMod.synthesizeTerminal(home, aid), true);
    assert.deepStrictEqual(topTerminalOutcomes(home, aid), [['cancelled', 'reconciler']]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('preserves (does not write) when the lease is still held', () => {
  const home = tmpHome();
  try {
    const [aid, l] = newActivity(home); // lease still HELD, no crash
    writeStart(home, aid);
    assert.strictEqual(reconcileMod.synthesizeTerminal(home, aid), false);
    assert.deepStrictEqual(topTerminalOutcomes(home, aid), []);
    l.release();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('nothing to synthesize when there is no durable start at all (owner-gone-pre-start case)', () => {
  const home = tmpHome();
  try {
    const [aid, l] = newActivity(home); // no start record written
    l.release();
    assert.strictEqual(reconcileMod.synthesizeTerminal(home, aid), false);
    assert.deepStrictEqual(topTerminalOutcomes(home, aid), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('nothing to synthesize when a terminal already exists (idempotent, no double terminal)', () => {
  const home = tmpHome();
  try {
    const [aid, l] = newActivity(home);
    writeStart(home, aid);
    writeRecord(home, aid, { type: 'terminal', seq: 9, outcome: 'succeeded', summary: {}, by: 'deadbeef' });
    l.release();
    assert.strictEqual(reconcileMod.synthesizeTerminal(home, aid), false);
    assert.deepStrictEqual(topTerminalOutcomes(home, aid), [['succeeded', 'deadbeef']]); // unchanged
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('fs error path returns false, never throws, and still releases the lease it acquired', () => {
  const home = tmpHome();
  try {
    const [aid, l] = newActivity(home);
    writeStart(home, aid);
    l.release();

    const realFsync = fs.fsyncSync;
    fs.fsyncSync = () => { throw new Error('no fsync'); };
    let result;
    try {
      result = reconcileMod.synthesizeTerminal(home, aid);
    } finally {
      fs.fsyncSync = realFsync;
    }
    assert.strictEqual(result, false); // never durable, never raises

    // failure still releases the lease it acquired, so the activity remains reclaimable
    const fresh = A.acquire(A.ownerLockPath(home, aid));
    assert.ok(fresh !== null);
    fresh.release();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a throwing lease.release() is contained: synthesizeTerminal still returns true for a durable write, never throws', () => {
  const home = tmpHome();
  const leaseModule = require('../lease');
  const realAcquire = leaseModule.acquire;
  try {
    const [aid, l] = newActivity(home);
    writeStart(home, aid);
    l.release(); // crash after start, before terminal -- lease is free for synthesizeTerminal to acquire

    // Monkeypatch lease.acquire (the SAME cached module reconcile.js itself requires) to hand
    // back a Lease whose release() actually closes the fd (no leak) but then throws -- simulating
    // fs.closeSync raising EIO/EBADF, per the I3 finding.
    leaseModule.acquire = (lockPath) => {
      const real = realAcquire(lockPath);
      if (real === null) return null;
      const originalRelease = real.release.bind(real);
      real.release = () => {
        originalRelease();
        throw new Error('boom: simulated EIO on lease release');
      };
      return real;
    };

    let result;
    assert.doesNotThrow(() => { result = reconcileMod.synthesizeTerminal(home, aid); });
    // The terminal was already durably written (fsync'd) before release() ran, so a contained
    // release failure must NOT downgrade the result -- the terminal IS durable.
    assert.strictEqual(result, true);
    assert.deepStrictEqual(topTerminalOutcomes(home, aid), [['interrupted', 'reconciler']]);
  } finally {
    leaseModule.acquire = realAcquire;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a top-level start whose fields nest type:"terminal" is not mistaken for a real terminal', () => {
  const home = tmpHome();
  try {
    const [aid, l] = newActivity(home);
    writeRecord(home, aid, {
      type: 'start', seq: 0, kind: 'sync', channel: 'stable', trigger: 'cli', created_by: 'python',
      fields: { type: 'terminal' },
    });
    l.release();
    assert.strictEqual(reconcileMod.synthesizeTerminal(home, aid), true); // still synthesizes
    assert.deepStrictEqual(topTerminalOutcomes(home, aid), [['interrupted', 'reconciler']]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Task 3.3: reconcile(home, activityId, { _probe } = {}) -- the READ-side counterpart, mirroring
// the Step-1 scenarios from task-3.3-brief.md verbatim (tri-state lease.probe branching,
// duplicate/conflicting terminal handling). Every test below creates its own tmp `home` via
// `fresh()` and removes it in a `finally` (and releases any lease it holds) -- no leaked scratch
// dirs, per this repo's post-incident tmp-dir-cleanup policy.
const { reconcile } = require('../reconcile');
const { activityDir, ownerLockPath, segmentPath, secureMkdir } = require('../paths');
const { acquire } = require('../lease');

const AID = '00000000-0000-4000-8000-000000000000';
// seed FULLY VALID v1 records (Round-5 #6) so the canonical parser accepts them
const START = { schema_version:1, activity_id:AID, type:'start', seq:0, ts:'2026-08-14T00:00:00-07:00',
                kind:'sync', channel:'stable', trigger:'cli', created_by:'python' };
function seed(home, lines) {
  secureMkdir(activityDir(home, AID));
  fs.writeFileSync(segmentPath(home, AID, 'python', 'deadbeef'),
    lines.map(o => JSON.stringify(o)).join('\n') + '\n');
}
// enumerate ALL segments (the reconciler writes its OWN writer-instance segment)
function allText(home) {
  const d = activityDir(home, AID);
  return fs.readdirSync(d).filter(f => f.endsWith('.jsonl'))
    .map(f => fs.readFileSync(path.join(d, f), 'utf8')).join('');
}
const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'act-'));

test('freed lock + no cancel => interrupted (synthesized, durable, in a NEW segment)', () => {
  const home = fresh();
  try {
    seed(home, [START]);
    const r = reconcile(home, AID);
    assert.strictEqual(r.outcome, 'interrupted'); assert.ok(r.synthesized);
    assert.match(allText(home), /"type":"terminal".*"by":"reconciler"/);   // scan ALL segments
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('held lock => stays running', () => {
  const home = fresh();
  let held = null;
  try {
    seed(home, [START]);
    held = acquire(ownerLockPath(home, AID));
    assert.strictEqual(reconcile(home, AID).outcome, null);
  } finally {
    if (held) held.release();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

const control = () => ({ schema_version:1, activity_id:AID, type:'control', seq:1,
  ts:'2026-08-14T00:00:00-07:00', name:'cancel_requested', fields:{} });
const term = (seq, outcome, by='deadbeef') => ({ schema_version:1, activity_id:AID, type:'terminal',
  seq, ts:'2026-08-14T00:00:00-07:00', outcome, summary:{}, by });

test('cancel_requested + freed lock => cancelled', () => {
  const home = fresh();
  try {
    seed(home, [START, control()]);
    assert.strictEqual(reconcile(home, AID).outcome, 'cancelled');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('UNCERTAIN probe => stays running + a System integrity Problem', () => {
  const home = fresh();
  try {
    seed(home, [START]);
    // reconcile exposes a `_probe` injection seam (default: lease.probe); force UNCERTAIN
    const r = reconcile(home, AID, { _probe: () => 'uncertain' });
    assert.strictEqual(r.outcome, null);                  // never guesses a dead owner
    assert.ok(r.problems.some(p => /uncertain/i.test(p.kind || String(p))));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('duplicate terminals (same outcome) group with a count', () => {
  const home = fresh();
  try {
    seed(home, [START, term(1,'succeeded'), term(2,'succeeded')]);
    const r = reconcile(home, AID);
    assert.strictEqual(r.outcome, 'succeeded');
    assert.ok(r.duplicateTerminalCounts.succeeded >= 2);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('conflicting terminals (different outcomes) => interrupted + integrity Problem', () => {
  const home = fresh();
  try {
    seed(home, [START, term(1,'succeeded'), term(2,'failed')]);
    const r = reconcile(home, AID);
    assert.strictEqual(r.outcome, 'interrupted'); assert.ok(r.problems.length >= 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Extra coverage beyond the brief's 6 (an explicit-injected-probe BUSY branch, and confirming
// duplicateTerminalCounts is populated on the conflict path too -- both branches the 6 above
// exercise only implicitly or not at all).
test('explicit BUSY probe => stays running (case-insensitive injected value)', () => {
  const home = fresh();
  try {
    seed(home, [START]);
    const r = reconcile(home, AID, { _probe: () => 'BUSY' });
    assert.strictEqual(r.outcome, null);
    assert.strictEqual(r.synthesized, false);
    assert.strictEqual(r.problems.length, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('reconcile() does not throw when the internal synthesizeTerminal lease release throws', () => {
  const home = fresh();
  const leaseModule = require('../lease');
  const realAcquire = leaseModule.acquire;
  try {
    seed(home, [START]);
    // Same seam as the synthesizeTerminal-level test above: reconcile()'s FREE-lease path calls
    // synthesizeTerminal internally, which calls lease.acquire -- patch it to hand back a Lease
    // whose release() throws after actually closing.
    leaseModule.acquire = (lockPath) => {
      const real = realAcquire(lockPath);
      if (real === null) return null;
      const originalRelease = real.release.bind(real);
      real.release = () => {
        originalRelease();
        throw new Error('boom: simulated EIO on lease release');
      };
      return real;
    };

    let r;
    assert.doesNotThrow(() => { r = reconcile(home, AID); });
    assert.strictEqual(r.outcome, 'interrupted');
    assert.ok(r.synthesized);
  } finally {
    leaseModule.acquire = realAcquire;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('conflicting terminals also populate duplicateTerminalCounts per outcome', () => {
  const home = fresh();
  try {
    seed(home, [START, term(1, 'succeeded'), term(2, 'failed')]);
    const r = reconcile(home, AID);
    assert.strictEqual(r.duplicateTerminalCounts.succeeded, 1);
    assert.strictEqual(r.duplicateTerminalCounts.failed, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// F-E parity fix: a non-conforming filename (not `${producer}-${writerId}.jsonl` for a known
// producer + 8-hex token) must NEVER be treated as a real segment by the lifecycle helpers, even
// though `readOwnedSegments` itself will happily read its bytes (it has no naming opinion). Write
// a `start` record directly into a bad-named file (bypassing `segmentPath`'s own validation,
// which would refuse to construct such a path) and confirm the lock-absent/FREE path does NOT
// synthesize off the back of it.
function seedBadName(home, name, lines) {
  secureMkdir(activityDir(home, AID));
  fs.writeFileSync(
    path.join(activityDir(home, AID), name),
    lines.map((o) => JSON.stringify(o)).join('\n') + '\n',
  );
}

test('a bad-named segment holding a start is ignored: synthesizeTerminal writes nothing, no lock needed', () => {
  const home = fresh();
  try {
    seedBadName(home, 'python-s3cr3t.jsonl', [START]); // "producer-writerId" but writerId isn't valid hex
    // no owner.lock ever created -> lease-free
    assert.strictEqual(reconcileMod.synthesizeTerminal(home, AID), false);
    const before = fs.readdirSync(activityDir(home, AID)).filter((f) => f.endsWith('.jsonl'));
    assert.deepStrictEqual(before, ['python-s3cr3t.jsonl']); // no new segment appeared
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a bad-named segment holding a start is ignored by reconcile(): outcome null, not synthesized', () => {
  const home = fresh();
  try {
    seedBadName(home, 'junk.jsonl', [START]); // not even producer-shaped
    const r = reconcile(home, AID);
    assert.strictEqual(r.outcome, null);
    assert.strictEqual(r.synthesized, false);
    const after = fs.readdirSync(activityDir(home, AID)).filter((f) => f.endsWith('.jsonl'));
    assert.deepStrictEqual(after, ['junk.jsonl']); // still no new segment
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Codex R2 B1 / Ruling 38: reconciliation must never synthesize from a PARTIAL view. A conforming
// segment the reader REFUSED (chmod 000, or a symlink swapped onto the name) may hold the very
// terminal whose absence would justify synthesis -- so the view is uncertain, nothing is written,
// and reconcile() reports `reconcile-view-uncertain` instead of a verdict. Codex's repro: readable
// start + unreadable `succeeded` terminal + free lock used to yield a SYNTHESIZED `interrupted`
// terminal, and restoring the perms then exposed two conflicting terminals.
function seedHidden(home, name, lines) {
  const p = path.join(activityDir(home, AID), name);
  fs.writeFileSync(p, lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
  return p;
}
function segmentNames(home) {
  return fs.readdirSync(activityDir(home, AID)).filter((f) => f.endsWith('.jsonl')).sort();
}

test('R2: unreadable (0o000) conforming terminal segment => synthesizeTerminal returns false and writes nothing', (t) => {
  if (process.getuid && process.getuid() === 0) {
    t.skip('running as root -- permission bits are not enforced');
    return;
  }
  const home = fresh();
  let hidden;
  try {
    seed(home, [START]);
    hidden = seedHidden(home, 'electron-cafef00d.jsonl', [term(1, 'succeeded')]);
    fs.chmodSync(hidden, 0o000);
    // no owner.lock -> lease FREE; the only thing standing between us and a bogus terminal is the gate
    assert.strictEqual(reconcileMod.synthesizeTerminal(home, AID), false);
    assert.deepStrictEqual(segmentNames(home), ['electron-cafef00d.jsonl', 'python-deadbeef.jsonl']);
    // the lease it acquired for the check was released again
    const l = acquire(ownerLockPath(home, AID));
    assert.ok(l !== null);
    l.release();
  } finally {
    if (hidden) fs.chmodSync(hidden, 0o600); // restore BEFORE rmSync
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('R2: unreadable conforming terminal segment => reconcile() outcome null, not synthesized, view-uncertain problem; restore => succeeded', (t) => {
  if (process.getuid && process.getuid() === 0) {
    t.skip('running as root -- permission bits are not enforced');
    return;
  }
  const home = fresh();
  let hidden;
  try {
    seed(home, [START]);
    hidden = seedHidden(home, 'electron-cafef00d.jsonl', [term(1, 'succeeded')]);
    fs.chmodSync(hidden, 0o000);

    const r = reconcile(home, AID);
    assert.strictEqual(r.outcome, null);
    assert.strictEqual(r.synthesized, false);
    const p = r.problems.find((x) => x.kind === 'reconcile-view-uncertain');
    assert.ok(p, 'reconcile-view-uncertain problem present');
    assert.deepStrictEqual(p.rejected, [{ name: 'electron-cafef00d.jsonl', reason: 'denied' }]);
    assert.ok(!r.problems.some((x) => x.kind === 'reconcile-synthesize-raced'));
    assert.deepStrictEqual(segmentNames(home), ['electron-cafef00d.jsonl', 'python-deadbeef.jsonl']);

    fs.chmodSync(hidden, 0o600);
    const after = reconcile(home, AID);
    assert.strictEqual(after.outcome, 'succeeded');
    assert.strictEqual(after.synthesized, false);
    assert.deepStrictEqual(after.problems, []);
    assert.deepStrictEqual(after.duplicateTerminalCounts, { succeeded: 1 }); // no manufactured conflict
  } finally {
    if (hidden) fs.chmodSync(hidden, 0o600);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('R2: a symlink squatting on a conforming segment name => uncertain view, no synthesis, no write', () => {
  const home = fresh();
  try {
    seed(home, [START]);
    const victim = path.join(home, 'victim.jsonl');
    fs.writeFileSync(victim, JSON.stringify(term(1, 'succeeded')) + '\n');
    fs.symlinkSync(victim, path.join(activityDir(home, AID), 'electron-cafef00d.jsonl'));

    assert.strictEqual(reconcileMod.synthesizeTerminal(home, AID), false);
    const r = reconcile(home, AID);
    assert.strictEqual(r.outcome, null);
    assert.strictEqual(r.synthesized, false);
    const p = r.problems.find((x) => x.kind === 'reconcile-view-uncertain');
    assert.ok(p);
    assert.deepStrictEqual(p.rejected, [{ name: 'electron-cafef00d.jsonl', reason: 'symlink' }]);
    assert.deepStrictEqual(segmentNames(home), ['electron-cafef00d.jsonl', 'python-deadbeef.jsonl']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('R2: a NON-conforming rejected entry is not uncertainty: synthesis still proceeds', () => {
  const home = fresh();
  try {
    seed(home, [START]);
    const victim = path.join(home, 'victim.jsonl');
    fs.writeFileSync(victim, JSON.stringify(term(1, 'succeeded')) + '\n');
    fs.symlinkSync(victim, path.join(activityDir(home, AID), 'junk.jsonl')); // rejected, but never a segment
    const r = reconcile(home, AID);
    assert.strictEqual(r.outcome, 'interrupted');
    assert.ok(r.synthesized);
    assert.ok(!r.problems.some((x) => x.kind === 'reconcile-view-uncertain'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('R2: a READABLE terminal still reports its outcome when another conforming segment is unreadable (no guess involved)', (t) => {
  if (process.getuid && process.getuid() === 0) {
    t.skip('running as root -- permission bits are not enforced');
    return;
  }
  const home = fresh();
  let hidden;
  try {
    seed(home, [START, term(1, 'succeeded')]);
    hidden = seedHidden(home, 'electron-cafef00d.jsonl', [{ schema_version: 1, activity_id: AID, type: 'event',
      seq: 5, ts: '2026-08-14T00:00:00-07:00', level: 'info', event: 'hidden', fields: {} }]);
    fs.chmodSync(hidden, 0o000);
    const r = reconcile(home, AID);
    assert.strictEqual(r.outcome, 'succeeded'); // a durable, readable terminal is a fact, not an inference
    assert.strictEqual(r.synthesized, false);
    assert.deepStrictEqual(segmentNames(home), ['electron-cafef00d.jsonl', 'python-deadbeef.jsonl']);
  } finally {
    if (hidden) fs.chmodSync(hidden, 0o600);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
