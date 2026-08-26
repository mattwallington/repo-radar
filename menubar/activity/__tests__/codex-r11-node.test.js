'use strict';
// Ruling 71 (Codex Round-11 BLOCKER, Node half): Ruling 70 (cc192e7) made `paths.
// listOwnedSubdirsDetailed` `continue` past ANY non-UUID root entry before measuring anything, so
// a 64 MiB `activity/junk/python-deadbeef.jsonl` contributed 0 bytes to the committed charge with
// `uncertain:false` and admission proceeded -- violating spec §7's sum-of-actual-bytes contract
// (renaming a real activity dir to `junk` hid its bytes from the ceiling entirely).
//
// Ruling 71: foreign entries are MEASURED, never MANAGED. A "foreign" root entry is any non-UUID
// name other than `quota`. Directory -> opened O_NOFOLLOW|O_DIRECTORY, each entry lstat'd:
// regular file -> bytes counted; anything else (subdir/symlink/fifo) -> uncertain; unopenable /
// unlistable -> uncertain. Regular file at the root -> lstat bytes counted. Any other non-UUID
// root entry (symlink, fifo, unstat-able) -> uncertain. Snapshot: measured += SUM foreign bytes;
// uncertain |= any foreign uncertain. Foreign entries are NEVER classified, reconciled,
// synthesized, read or rendered as activities (every Ruling 69/70 id guard stands), and Node
// still never deletes anything (Ruling B). Python implements the identical rule; the shared
// `accounting_vectors.json` fixture gains an optional `foreign` input (see
// `accounting-parity.test.js`).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../index');
const paths = require('../paths');
const { quota } = A;

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-r11-node-'));
}

const rootOf = (home) => path.dirname(A.quotaDir(home));

// A non-UUID directory directly under `activity/` holding ONE segment-named file of `nbytes`
// (sparse via truncate -- Codex's repro is 64 MiB and we never need the bytes to exist on disk).
function seedJunk(root, name, nbytes) {
  const d = path.join(root, name);
  fs.mkdirSync(d, { mode: 0o700 });
  const f = path.join(d, 'python-deadbeef.jsonl');
  fs.writeFileSync(f, '', { mode: 0o600 });
  fs.truncateSync(f, nbytes);
  return d;
}

function seedSettled(home, nbytes) {
  const aid = A.mintActivityId();
  A.secureMkdir(A.activityDir(home, aid));
  fs.writeFileSync(A.segmentPath(home, aid, 'python', 'deadbeef'), Buffer.alloc(nbytes, 0x0a), { mode: 0o600 });
  return aid;
}

function newLiveActivity(home) {
  const aid = A.mintActivityId();
  A.secureMkdir(A.activityDir(home, aid));
  const l = A.acquire(A.ownerLockPath(home, aid));
  return [aid, l];
}

function withNoPython(fn) {
  const orig = quota.PYTHON_BIN;
  quota.PYTHON_BIN = '/nonexistent/python3-r11-test';
  try { return fn(); } finally { quota.PYTHON_BIN = orig; }
}

const certain = (charge) => ({ charge, uncertain: false, corrupt: false });

test('Ruling 71 (Codex repro): a 64 MiB file inside activity/junk/ is charged in full, certain, and admission/grant refuse while it fills the ceiling', () => {
  const home = tmpHome();
  try {
    A.secureMkdir(A.quotaDir(home));
    const root = rootOf(home);
    seedJunk(root, 'junk', quota.CEILING);

    // pre-fix: charge 0 / uncertain false -> admitted. Now: the bytes ARE the charge.
    assert.strictEqual(quota._charge(home), quota.CEILING);
    assert.deepStrictEqual(quota._accountingSnapshot(home), certain(quota.CEILING));
    assert.strictEqual(quota._committed(home), quota.CEILING, '`_committed` (the plain unlocked sum) agrees');

    const [live, lease] = newLiveActivity(home);
    try {
      // certain and over the ceiling -> admit delegates a prune (no Python here -> no-op), re-snapshots,
      // and must still refuse: nothing was freed (Node never deletes a foreign entry, Ruling B).
      withNoPython(() => assert.strictEqual(quota.admit(home, live, lease), false, 'admission refused: junk bytes fill the ceiling'));
      assert.ok(!fs.existsSync(A.ledgerEntryPath(home, live)), 'no reservation was written');
      assert.ok(fs.existsSync(path.join(root, 'junk', 'python-deadbeef.jsonl')), 'Node never deleted the foreign file');

      // grant against an existing entry likewise refuses on the global ceiling.
      const [other, lease2] = newLiveActivity(home);
      try {
        fs.mkdirSync(A.quotaDir(home), { recursive: true });
        quota._writeEntry(home, other, quota.RESERVE, 0);
        assert.strictEqual(quota.grant(home, other, 1), false, 'grant refused: junk bytes + 1 exceed the ceiling');
      } finally { lease2.release(); }
    } finally { lease.release(); }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 71: foreign bytes add to real activity bytes; quota/ stays excluded; locked and unlocked accounting agree; junk never becomes an activity input', () => {
  const home = tmpHome();
  try {
    A.secureMkdir(A.quotaDir(home));
    const root = rootOf(home);
    seedJunk(root, 'junk', 330);
    const aid = seedSettled(home, 4096);
    fs.writeFileSync(path.join(A.quotaDir(home), 'stray-in-quota'), Buffer.alloc(777), { mode: 0o600 }); // inside quota/: not foreign

    assert.strictEqual(quota._charge(home), 4096 + 330);
    assert.deepStrictEqual(quota._accountingSnapshot(home), certain(4096 + 330));
    assert.strictEqual(quota._committed(home), 4096 + 330);

    const ctx = quota._quotaLock(home);
    try {
      const gathered = quota._gatherAccounting(home, ctx);
      assert.deepStrictEqual(gathered.activities.map((a) => a.aid), [aid], '"junk" never became an accounting activity input');
      assert.deepStrictEqual(gathered.foreign, [{ name: 'junk', onDisk: 330, uncertain: false }, { name: 'quota.lock', onDisk: 0, uncertain: false }].sort((x, y) => (x.name < y.name ? -1 : 1)));
      assert.deepStrictEqual(quota._accountingSnapshot(home, ctx), certain(4096 + 330), 'locked == unlocked');
    } finally {
      quota._unlock(ctx);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 71: a foreign directory holding anything but regular files (symlink / subdir / fifo) makes the accounting uncertain -- partial bytes kept, entry takes max(bytes, cap)', () => {
  const home = tmpHome();
  try {
    A.secureMkdir(A.quotaDir(home));
    const root = rootOf(home);
    const CAP = quota.PER_ACTIVITY_CAP;

    seedJunk(root, 'junk', 100);
    assert.deepStrictEqual(quota._accountingSnapshot(home), certain(100));

    fs.symlinkSync(home, path.join(root, 'junk', 'link'));
    assert.deepStrictEqual(paths.listOwnedSubdirsDetailed(root).foreign.find((f) => f.name === 'junk'), { name: 'junk', bytes: 100, uncertain: true }, 'partial bytes kept');
    assert.deepStrictEqual(quota._accountingSnapshot(home), { charge: CAP, uncertain: true, corrupt: false }, 'a symlink inside junk/ -> uncertain; the entry is charged max(100, PER_ACTIVITY_CAP) like an uncertain activity (fixture parity)');
    fs.unlinkSync(path.join(root, 'junk', 'link'));
    assert.deepStrictEqual(quota._accountingSnapshot(home), certain(100), 'back to certain once removed');

    fs.mkdirSync(path.join(root, 'junk', 'nested'));
    assert.deepStrictEqual(quota._accountingSnapshot(home), { charge: CAP, uncertain: true, corrupt: false }, 'a nested directory is never descended into -> uncertain');
    // a big partial measurement is never discarded: max(bytes, cap) keeps the bytes
    fs.truncateSync(path.join(root, 'junk', 'python-deadbeef.jsonl'), CAP + 1);
    assert.deepStrictEqual(quota._accountingSnapshot(home), { charge: CAP + 1, uncertain: true, corrupt: false });

    const [live, lease] = newLiveActivity(home);
    try {
      withNoPython(() => assert.strictEqual(quota.admit(home, live, lease), false, 'uncertain -> refused (Ruling 61)'));
    } finally { lease.release(); }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 71: a stray regular file at the root is counted; a stray symlink at the root is uncertain; an unlistable foreign directory is uncertain', () => {
  const home = tmpHome();
  try {
    A.secureMkdir(A.quotaDir(home));
    const root = rootOf(home);

    fs.writeFileSync(path.join(root, 'notes.txt'), Buffer.alloc(500), { mode: 0o600 });
    assert.deepStrictEqual(quota._accountingSnapshot(home), certain(500));

    const CAP = quota.PER_ACTIVITY_CAP;
    fs.symlinkSync(home, path.join(root, 'stray-link'));
    assert.deepStrictEqual(quota._accountingSnapshot(home), { charge: 500 + CAP, uncertain: true, corrupt: false }, 'stray symlink -> uncertain foreign entry charged the cap; notes.txt still counted');
    fs.unlinkSync(path.join(root, 'stray-link'));
    assert.deepStrictEqual(quota._accountingSnapshot(home), certain(500));

    const junk = seedJunk(root, 'junk', 42);
    assert.deepStrictEqual(quota._accountingSnapshot(home), certain(542));
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root ignores modes
    fs.chmodSync(junk, 0o000);
    try {
      assert.deepStrictEqual(quota._accountingSnapshot(home), { charge: 500 + CAP, uncertain: true, corrupt: false }, 'unlistable junk/ -> uncertain (cap), other bytes kept');
    } finally {
      fs.chmodSync(junk, 0o700);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 71: listOwnedSubdirsDetailed reports foreign entries separately from subdirs/rejected, and read-side enumeration never surfaces them', () => {
  const home = tmpHome();
  try {
    A.secureMkdir(A.quotaDir(home));
    const root = rootOf(home);
    seedJunk(root, 'junk', 7);
    fs.writeFileSync(path.join(root, 'notes.txt'), Buffer.alloc(3), { mode: 0o600 });
    fs.symlinkSync(home, path.join(root, 'stray-link'));
    const validAid = A.mintActivityId();
    A.secureMkdir(A.activityDir(home, validAid));

    const r = paths.listOwnedSubdirsDetailed(root);
    assert.deepStrictEqual(r.subdirs, [validAid]);
    assert.deepStrictEqual(r.rejected, []);
    assert.strictEqual(r.uncertain, false, 'activity-shaped uncertainty is unchanged: no activity-shaped entry was refused');
    assert.deepStrictEqual(
      [...r.foreign].sort((x, y) => (x.name < y.name ? -1 : 1)),
      [
        { name: 'junk', bytes: 7, uncertain: false },
        { name: 'notes.txt', bytes: 3, uncertain: false },
        { name: 'stray-link', bytes: 0, uncertain: true },
      ],
    );
    assert.ok(!r.foreign.some((f) => f.name === 'quota'), 'quota/ is never foreign');
    assert.deepStrictEqual(paths.listOwnedSubdirs(root), [validAid], 'legacy wrapper unchanged');

    // read side: the activity listing is built from `subdirs` only -- foreign names never render.
    const listed = A.read.listActivities(home);
    assert.strictEqual(listed.available, true);
    assert.ok(listed.items.every((i) => i.id === validAid), `foreign names must never render as activities: ${JSON.stringify(listed.items.map((i) => i.id))}`);
    assert.deepStrictEqual(listed.problems, [], 'foreign entries are not rejected-activity problems either');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 71: _computeSnapshot is pure over foreign inputs -- absent means empty; bytes add to measured; uncertain propagates; Ruling 62 rules still apply on top', () => {
  const C = { CEILING: quota.CEILING, PER_ACTIVITY_CAP: quota.PER_ACTIVITY_CAP, RESERVE: quota.RESERVE };
  const base = { rootListable: true, ledgerListable: true, activities: [{ aid: 'a', onDisk: 10, uncertain: false }], rejectedRootIds: [], ledger: [] };
  assert.deepStrictEqual(quota._computeSnapshot(base, C), certain(10), 'no `foreign` key -> empty list');
  assert.deepStrictEqual(quota._computeSnapshot({ ...base, foreign: [] }, C), certain(10));
  assert.deepStrictEqual(quota._computeSnapshot({ ...base, foreign: [{ name: 'j', onDisk: 5, uncertain: false }] }, C), certain(15));
  assert.deepStrictEqual(quota._computeSnapshot({ ...base, foreign: [{ name: 'j', onDisk: 5, uncertain: true }] }, C), { charge: 10 + quota.PER_ACTIVITY_CAP, uncertain: true, corrupt: false }, 'uncertain foreign entry takes max(bytes, cap), same as an uncertain activity');
  assert.deepStrictEqual(quota._computeSnapshot({ ...base, foreign: [{ name: 'j', onDisk: quota.PER_ACTIVITY_CAP + 7, uncertain: true }] }, C), { charge: 10 + quota.PER_ACTIVITY_CAP + 7, uncertain: true, corrupt: false }, 'measured bytes above the cap are never discarded');
  // unlistable ledger: max(SUM measured incl. foreign, CEILING)
  assert.deepStrictEqual(
    quota._computeSnapshot({ ...base, ledgerListable: false, activities: [{ aid: 'a', onDisk: quota.CEILING, uncertain: false }], foreign: [{ name: 'j', onDisk: 5, uncertain: false }] }, C),
    { charge: quota.CEILING + 5, uncertain: true, corrupt: false },
  );
});
