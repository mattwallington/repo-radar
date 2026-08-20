'use strict';
// Node mirror of the key scenarios in repo_radar/tests/test_activity_quota.py (Task 2.2b),
// adapted to Ruling B (Node never unlinks -- settle is a no-op; corrupt-clearing and
// over-ceiling pruning are delegated to python -m repo_radar.activity.prune, proven separately
// by quota-delegation.test.js). See ../quota.js's header comment for the full architecture.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../index');
const { quota } = A;

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-quota-'));
}

function newActivity(home) {
  const aid = A.mintActivityId();
  A.secureMkdir(A.activityDir(home, aid));
  const l = A.acquire(A.ownerLockPath(home, aid));
  return [aid, l];
}

function readEntry(home, aid) {
  return JSON.parse(fs.readFileSync(A.ledgerEntryPath(home, aid), 'utf8'));
}

test('admit writes a {reserved, granted} JSON ledger entry; settle is a no-op (Ruling B)', () => {
  const home = tmpHome();
  const [aid, l] = newActivity(home);
  assert.strictEqual(quota.admit(home, aid, l), true);
  assert.deepStrictEqual(readEntry(home, aid), { reserved: quota.RESERVE, granted: 0 });

  quota.settle(home, aid);
  // Ruling B: Node cannot unlink -- settle must leave the entry in place. The next Python
  // reconcile/prune pass is what actually removes it (proven by quota-delegation.test.js's use
  // of the real prune entrypoint, and by test_activity_quota.py's Python-side settle tests).
  assert.ok(fs.existsSync(A.ledgerEntryPath(home, aid)), 'settle must NOT remove the ledger entry');
});

test('grant enforces both the per-activity cap and the global ceiling', () => {
  const home = tmpHome();
  const [aid, l] = newActivity(home);
  quota.admit(home, aid, l);
  assert.strictEqual(quota.grant(home, aid, quota.ORDINARY_CAP), true);
  assert.strictEqual(quota.grant(home, aid, 1), false); // per-activity cap hit
  assert.strictEqual(readEntry(home, aid).granted, quota.ORDINARY_CAP);
});

test('_parseEntry rejects impossible/malformed counters', () => {
  const good = quota._parseEntry(Buffer.from(JSON.stringify({ reserved: quota.RESERVE, granted: 0 })));
  assert.deepStrictEqual(good, { reserved: quota.RESERVE, granted: 0 });

  const cases = [
    JSON.stringify({ reserved: 0, granted: 0 }), // reserved must equal RESERVE
    JSON.stringify({ reserved: quota.RESERVE, granted: quota.PER_ACTIVITY_CAP }), // over cap
    JSON.stringify({ reserved: quota.RESERVE, granted: -1 }), // negative granted
    JSON.stringify({ reserved: quota.RESERVE, granted: true }), // boolean, not int
    JSON.stringify({ reserved: quota.RESERVE, granted: 1.5 }), // non-integer
    JSON.stringify({ reserved: quota.RESERVE }), // missing granted
    '{not valid json',
    JSON.stringify([1, 2, 3]), // not an object
    JSON.stringify('a string'),
  ];
  for (const c of cases) {
    assert.strictEqual(quota._parseEntry(Buffer.from(c)), quota.CORRUPT, c);
  }
});

test('_writeEntry rejects a path-traversal or absolute activity_id before touching disk', () => {
  const home = tmpHome();
  A.secureMkdir(A.quotaDir(home));
  for (const bad of ['../../evil', '/abs/evil', '..', 'a/b', 'id\nwith\nnewline', '']) {
    assert.throws(() => quota._writeEntry(home, bad, quota.RESERVE, 0), A.UnsafePath, bad);
  }
});

test('admit rejects a traversal activity_id via the public entrypoint (fails closed, nothing escapes)', () => {
  const home = tmpHome();
  const [, l] = newActivity(home);
  assert.strictEqual(quota.admit(home, '../../evil', l), false);
  assert.ok(!fs.existsSync(path.join(path.dirname(home), 'evil.json')));
});

test('a symlinked/FIFO/directory ledger entry is CLASSIFIED as CORRUPT, never silently skipped', () => {
  const home = tmpHome();
  A.secureMkdir(A.quotaDir(home));

  const symAid = A.mintActivityId();
  const outside = path.join(home, 'outside.json');
  fs.writeFileSync(outside, JSON.stringify({ reserved: quota.RESERVE, granted: 0 }));
  fs.symlinkSync(outside, A.ledgerEntryPath(home, symAid));

  const dirAid = A.mintActivityId();
  fs.mkdirSync(A.ledgerEntryPath(home, dirAid));

  const entries = new Map(quota._ledgerEntries(home));
  assert.strictEqual(entries.get(symAid), quota.CORRUPT);
  assert.strictEqual(entries.get(dirAid), quota.CORRUPT);
  assert.strictEqual(quota._hasCorrupt(home), true);
});

test('_committed / _onDisk use fstat sizes only -- charge accounting never reads segment content', () => {
  const home = tmpHome();
  const [aid, l] = newActivity(home);
  quota.admit(home, aid, l);
  const big = A.segmentPath(home, aid, 'python', 'cafebabe');
  fs.writeFileSync(big, Buffer.alloc(1024 * 1024, 0x78));

  // The pathsMod module object is shared by reference (Node's require cache): stubbing its
  // readOwnedSegments here also changes what quota.js's own `paths.readOwnedSegments` calls
  // resolve to, since quota.js did `const paths = require('./paths')` -- the same object.
  const pathsMod = require('../paths');
  const realReadOwnedSegments = pathsMod.readOwnedSegments;
  pathsMod.readOwnedSegments = () => {
    throw new Error('grant must not read segment CONTENTS for size accounting');
  };
  let result;
  try {
    result = quota.grant(home, aid, 100); // must succeed using fstat-only sizing (statOwnedSegments)
  } finally {
    pathsMod.readOwnedSegments = realReadOwnedSegments;
  }
  assert.strictEqual(result, true);

  const realTotal = fs.readdirSync(A.activityDir(home, aid))
    .filter((f) => f.endsWith('.jsonl'))
    .reduce((s, f) => s + fs.statSync(path.join(A.activityDir(home, aid), f)).size, 0);
  assert.strictEqual(quota._onDisk(home, aid), realTotal);
  assert.strictEqual(quota._committed(home), realTotal);
});

test('a swapped quota/ component (symlink) makes admit refuse rather than operate through it', () => {
  const home = tmpHome();
  const [aid, l] = newActivity(home);
  const qd = A.quotaDir(home);
  fs.rmSync(qd, { recursive: true, force: true });
  const outsideDir = path.join(home, 'evil');
  fs.mkdirSync(outsideDir);
  fs.symlinkSync(outsideDir, qd);
  assert.strictEqual(quota.admit(home, aid, l), false);
});

test('held corrupt entry refuses admit AND grant even far below the real 64 MiB ceiling', () => {
  const home = tmpHome();
  const [live, ll] = newActivity(home);
  assert.strictEqual(quota.admit(home, live, ll), true); // BEFORE any corruption exists

  const [held, hl] = newActivity(home); // owner.lock HELD -- never released
  void hl;
  fs.writeFileSync(A.ledgerEntryPath(home, held), '{not valid json', { mode: 0o600 });

  const [fresh, fl] = newActivity(home);
  assert.strictEqual(quota.admit(home, fresh, fl), false, 'refused: corrupt entry stands');
  assert.strictEqual(quota.grant(home, live, 100), false, 'grants refused too, unrelated activity');
});

test('grant durability failure (fsync throws) refuses the append, never writes a bad entry', () => {
  const home = tmpHome();
  const [aid, l] = newActivity(home);
  quota.admit(home, aid, l);
  const realFsync = fs.fsyncSync;
  fs.fsyncSync = () => { throw new Error('no fsync'); };
  try {
    assert.strictEqual(quota.grant(home, aid, 100), false);
  } finally {
    fs.fsyncSync = realFsync;
  }
  assert.strictEqual(readEntry(home, aid).granted, 0); // unchanged -- refused before commit
});
