'use strict';
// Codex review Round 5 (Node half): Rulings 49, 50, 52.
//   R5-1 (Ruling 49): the Activity ROOT enumeration must not hide an activity from quota. The
//        lossy `paths.listOwnedSubdirs` silently skipped a UUID-shaped entry whose lstat failed
//        with a non-ENOENT error (Codex injected EIO on one of 16 x 4 MiB settled -> charge 60
//        MiB, `uncertain:false`, admitted, restore -> 67,170,304 bytes > ceiling).
//        `listOwnedSubdirsDetailed` now reports `uncertain` (+ reason 'stat-failed'), and every
//        quota accounting path consumes the detailed form. ENOENT (proven gone) is NOT uncertain.
//   R5-3 (Ruling 50): `charge` and `uncertain` come from ONE accounting snapshot
//        (`quota._accountingSnapshot`) -- exactly one `statOwnedSegmentsDetailed` per activity per
//        decision, so a staged transition can never combine a fallback charge from one scan with
//        `uncertain:false` from another.
//   R5-4 (Ruling 52): the ledger is decoded STRICTLY (`records.decodeUtf8Fatal`): a raw 0xff or
//        a retained BOM is CORRUPT, matching Python's `json.loads`. (Fixture-driven parity lives
//        in ledger-parity.test.js.)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../index');
const paths = require('../paths');
const { quota } = A;

const isRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-r5-'));
}

// A SETTLED activity: segment bytes on disk, no ledger entry, no lock.
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
  quota.PYTHON_BIN = '/nonexistent/python3-r5-test';
  try { return fn(); } finally { quota.PYTHON_BIN = orig; }
}

// Inject an lstat failure for ONE exact path (paths.js calls `fs.lstatSync` through the shared
// `fs` module object, so the stub is seen by the real enumeration). Every other path is real.
function withLstatFailure(targetPath, code, fn) {
  const real = fs.lstatSync;
  const err = Object.assign(new Error(`${code}: injected lstat failure`), { code });
  fs.lstatSync = (p, ...rest) => {
    if (p === targetPath) throw err;
    return real(p, ...rest);
  };
  try { return fn(); } finally { fs.lstatSync = real; }
}

// Stage `paths.statOwnedSegmentsDetailed` (the hook seam quota-charge-interleaving /
// quota-cancel-settle-race also wrap) per activity directory: `stages[dir]` is the sequence of
// `uncertain` values to OVERLAY on the real result, one per call (the last value repeats). Counts
// every call per directory so a test can assert "one scan per activity per decision".
function withStagedStat(stages, fn) {
  const real = paths.statOwnedSegmentsDetailed;
  const calls = new Map();
  paths.statOwnedSegmentsDetailed = (directory, suffix) => {
    const result = real(directory, suffix);
    const n = (calls.get(directory) || 0) + 1;
    calls.set(directory, n);
    const seq = stages[directory];
    if (seq && seq.length > 0) {
      const uncertain = seq[Math.min(n, seq.length) - 1];
      return { entries: result.entries, uncertain };
    }
    return result;
  };
  try { return fn(calls); } finally { paths.statOwnedSegmentsDetailed = real; }
}

const rootOf = (home) => path.dirname(A.quotaDir(home));

// ---------------------------------------------------------------------------------------------
// R5-1 / Ruling 49
// ---------------------------------------------------------------------------------------------

test('Ruling 49: listOwnedSubdirsDetailed -- a non-ENOENT lstat failure on an activity-shaped entry is stat-failed + uncertain; ENOENT is gone, not uncertain; junk names never matter', () => {
  const home = tmpHome();
  try {
    const aid = seedSettled(home, 4096);
    const other = seedSettled(home, 4096);
    const root = rootOf(home);
    fs.writeFileSync(path.join(root, 'junk'), 'x');

    assert.deepStrictEqual(paths.listOwnedSubdirsDetailed(root), {
      subdirs: paths.listOwnedSubdirsDetailed(root).subdirs, rejected: [],
      foreign: [{ name: 'junk', bytes: 1, uncertain: false }], // Ruling 71: measured, not managed
      uncertain: false,
    });
    assert.deepStrictEqual(paths.listOwnedSubdirsDetailed(root).subdirs.sort(), [aid, other].sort());

    withLstatFailure(path.join(root, aid), 'EIO', () => {
      const r = paths.listOwnedSubdirsDetailed(root);
      assert.deepStrictEqual(r.subdirs, [other]);
      assert.deepStrictEqual(r.rejected, [{ name: aid, reason: 'stat-failed' }]);
      assert.strictEqual(r.uncertain, true, 'a refused activity-shaped entry may hide bytes');
      assert.deepStrictEqual(paths.listOwnedSubdirs(root), [other], 'the .subdirs wrapper is unchanged (still lossy by contract)');
    });
    withLstatFailure(path.join(root, aid), 'EACCES', () => {
      const r = paths.listOwnedSubdirsDetailed(root);
      assert.deepStrictEqual(r.rejected, [{ name: aid, reason: 'stat-failed' }]);
      assert.strictEqual(r.uncertain, true);
    });
    withLstatFailure(path.join(root, aid), 'ENOENT', () => {
      const r = paths.listOwnedSubdirsDetailed(root);
      assert.deepStrictEqual(r.subdirs, [other]);
      assert.deepStrictEqual(r.rejected, [{ name: aid, reason: 'gone' }]);
      assert.strictEqual(r.uncertain, false, 'proven gone hides nothing');
    });
    // a failure on a NON-activity name is not an activity being hidden (activity-shaped
    // `rejected`/`uncertain` stay clean) -- but Ruling 71 says its BYTES may be: it is reported
    // as an uncertain foreign entry for the accounting to fold in.
    withLstatFailure(path.join(root, 'junk'), 'EIO', () => {
      const r = paths.listOwnedSubdirsDetailed(root);
      assert.deepStrictEqual(r.rejected, []);
      assert.strictEqual(r.uncertain, false);
      assert.deepStrictEqual(r.foreign, [{ name: 'junk', bytes: 0, uncertain: true }]);
    });
    // a symlink / plain file squatting on an activity id is refused AND uncertain
    const linkAid = A.mintActivityId();
    fs.symlinkSync(A.activityDir(home, aid), path.join(root, linkAid));
    const r = paths.listOwnedSubdirsDetailed(root);
    assert.deepStrictEqual(r.rejected, [{ name: linkAid, reason: 'symlink' }]);
    assert.strictEqual(r.uncertain, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 49: listOwnedSubdirsDetailed -- a missing base is not uncertain; a base that exists but cannot be listed is', (t) => {
  const home = tmpHome();
  const root = rootOf(home);
  try {
    assert.deepStrictEqual(paths.listOwnedSubdirsDetailed(root), { subdirs: [], rejected: [], foreign: [], uncertain: false });
    seedSettled(home, 16);
    assert.strictEqual(paths.listOwnedSubdirsDetailed(root).uncertain, false);
    if (isRoot()) { t.diagnostic('root ignores permission bits; chmod-000 case skipped'); return; }
    fs.chmodSync(root, 0o000);
    try {
      const r = paths.listOwnedSubdirsDetailed(root);
      assert.deepStrictEqual(r, { subdirs: [], rejected: [], foreign: [], uncertain: true });
      assert.deepStrictEqual(paths.listOwnedSubdirs(root), []);
    } finally {
      fs.chmodSync(root, 0o700);
    }
  } finally {
    try { fs.chmodSync(root, 0o700); } catch (e) { /* best-effort */ }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 49 (Codex repro): 16 x 4 MiB settled + EIO on one root entry -> snapshot uncertain, charge >= ceiling, admit refused; ENOENT on that entry -> not uncertain, 60 MiB', () => {
  const home = tmpHome();
  try {
    const aids = [];
    for (let i = 0; i < 16; i++) aids.push(seedSettled(home, quota.PER_ACTIVITY_CAP));
    assert.deepStrictEqual(quota._accountingSnapshot(home), { charge: quota.CEILING, uncertain: false, corrupt: false });

    const victim = path.join(rootOf(home), aids[0]);
    const [live, lease] = newLiveActivity(home);
    withLstatFailure(victim, 'EIO', () => {
      const snap = quota._accountingSnapshot(home);
      assert.strictEqual(snap.uncertain, true, 'a hidden activity-shaped entry makes the accounting uncertain');
      assert.ok(snap.charge >= quota.CEILING, `charge ${snap.charge} must not drop below the ceiling (pre-fix: 60 MiB)`);
      assert.strictEqual(quota._charge(home), snap.charge);
      assert.strictEqual(quota._accountingUncertain(home), true);
      withNoPython(() => {
        assert.strictEqual(quota.admit(home, live, lease), false, 'admit refused while a root entry is unmeasurable');
      });
      assert.ok(!fs.existsSync(A.ledgerEntryPath(home, live)), 'no reservation was written');
    });

    withLstatFailure(victim, 'ENOENT', () => {
      const snap = quota._accountingSnapshot(home);
      assert.strictEqual(snap.uncertain, false, 'proven gone is not uncertain');
      assert.strictEqual(snap.charge, quota.CEILING - quota.PER_ACTIVITY_CAP, 'a gone activity contributes 0');
    });

    // restored: back to a full, certain ceiling -- still refused, but on the ceiling
    assert.deepStrictEqual(quota._accountingSnapshot(home), { charge: quota.CEILING, uncertain: false, corrupt: false });
    withNoPython(() => assert.strictEqual(quota.admit(home, live, lease), false));
    lease.release();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 49: grant is refused while a root entry is unmeasurable (EIO), works again once measurable', () => {
  const home = tmpHome();
  try {
    const [aid, lease] = newLiveActivity(home);
    withNoPython(() => assert.strictEqual(quota.admit(home, aid, lease), true));
    assert.strictEqual(quota.grant(home, aid, 100), true, 'baseline grant works');
    const settled = seedSettled(home, 4096);
    const victim = path.join(rootOf(home), settled);
    withLstatFailure(victim, 'EIO', () => {
      assert.strictEqual(quota._accountingUncertain(home), true);
      assert.strictEqual(quota._charge(home), quota.PER_ACTIVITY_CAP + quota.RESERVE + 100, 'hidden entry charged its max liability');
      assert.strictEqual(quota.grant(home, aid, 100), false, 'grant refused while unmeasurable');
      assert.deepStrictEqual(quota._readEntry(A.ledgerEntryPath(home, aid)), { reserved: quota.RESERVE, granted: 100 }, 'ledger untouched');
    });
    assert.strictEqual(quota._accountingUncertain(home), false);
    assert.strictEqual(quota._charge(home), 4096 + quota.RESERVE + 100);
    assert.strictEqual(quota.grant(home, aid, 100), true);
    lease.release();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// R5-3 / Ruling 50
// ---------------------------------------------------------------------------------------------

test('Ruling 50: one snapshot per decision -- grant scans each activity exactly once and decides from that single scan', () => {
  const home = tmpHome();
  try {
    const [aid, lease] = newLiveActivity(home);
    withNoPython(() => assert.strictEqual(quota.admit(home, aid, lease), true));
    const settled = seedSettled(home, 4096);
    const sDir = A.activityDir(home, settled);
    const aDir = A.activityDir(home, aid);

    // Staged: the settled activity is unmeasurable on the FIRST scan only. Pre-fix, grant called
    // `_accountingUncertain` (scan 1) then `_charge` (scan 2) -- two scans, two possibly
    // different truths. Now: exactly one scan per activity, and the decision follows it.
    withStagedStat({ [sDir]: [true, false] }, (calls) => {
      assert.strictEqual(quota.grant(home, aid, 100), false, 'refused: the one scan said uncertain');
      assert.strictEqual(calls.get(sDir), 1, 'exactly one scan of the settled activity for this decision');
      assert.strictEqual(calls.get(aDir), 1, 'exactly one scan of the live activity for this decision');
      assert.strictEqual(quota.grant(home, aid, 100), true, 'granted: the next decision\'s one scan said measurable');
      assert.strictEqual(calls.get(sDir), 2);
      assert.strictEqual(calls.get(aDir), 2);
    });
    assert.deepStrictEqual(quota._readEntry(A.ledgerEntryPath(home, aid)), { reserved: quota.RESERVE, granted: 100 });
    lease.release();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 50: a staged uncertain->measurable->uncertain transition across activities must NOT admit; exactly one scan per activity per decision (pre- and post-prune)', () => {
  const home = tmpHome();
  try {
    const s1 = seedSettled(home, 4096);
    const s2 = seedSettled(home, 4096);
    const d1 = A.activityDir(home, s1);
    const d2 = A.activityDir(home, s2);
    const [live, lease] = newLiveActivity(home);
    const dLive = A.activityDir(home, live);

    // Every snapshot sees SOME activity as unmeasurable, but each individual activity flips
    // between calls. A decision that mixed scans could see "all measurable" -- the unified
    // snapshot cannot.
    //
    // Codex R7 B2 / Ruling 61: an UNCERTAIN first snapshot now refuses OUTRIGHT -- no prune
    // delegation, no second snapshot -- so each decision is exactly ONE scan per activity (it
    // used to be two: snapshot -> delegate -> fresh snapshot).
    withStagedStat({ [d1]: [true, false], [d2]: [false, true] }, (calls) => {
      withNoPython(() => {
        assert.strictEqual(quota.admit(home, live, lease), false, 'must NOT admit: the one snapshot was uncertain');
      });
      assert.strictEqual(calls.get(d1), 1, 'one decision -> one scan of s1 (Ruling 61: no post-prune re-snapshot under uncertainty)');
      assert.strictEqual(calls.get(d2), 1, 'one decision -> one scan of s2');
      assert.strictEqual(calls.get(dLive), 1);
    });
    assert.ok(!fs.existsSync(A.ledgerEntryPath(home, live)), 'no reservation was written');

    // Permanently unmeasurable: refused, still exactly one scan per activity per decision.
    withStagedStat({ [d1]: [true] }, (calls) => {
      withNoPython(() => assert.strictEqual(quota.admit(home, live, lease), false));
      assert.strictEqual(calls.get(d1), 1);
      assert.strictEqual(calls.get(d2), 1);
    });

    // Snapshot consistency: a fallback charge is never reported with uncertain:false.
    withStagedStat({ [d1]: [true, false] }, () => {
      const a = quota._accountingSnapshot(home);
      assert.deepStrictEqual(a, { charge: quota.PER_ACTIVITY_CAP + 4096, uncertain: true, corrupt: false });
      const b = quota._accountingSnapshot(home);
      assert.deepStrictEqual(b, { charge: 8192, uncertain: false, corrupt: false });
    });
    lease.release();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 50 + Ruling 61: an uncertain snapshot refuses in ONE scan (no delegation, no re-snapshot); the NEXT decision, fully measurable, admits on its own single snapshot', () => {
  const home = tmpHome();
  try {
    const s1 = seedSettled(home, 4096);
    const d1 = A.activityDir(home, s1);
    const [live, lease] = newLiveActivity(home);
    // Pre-R7 this test expected: uncertain first snapshot -> prune delegated -> fresh measurable
    // snapshot -> ADMITTED (two scans). Ruling 61: uncertainty never delegates and never
    // re-snapshots; the decision is refused on its one scan. Only a fresh decision may admit.
    withStagedStat({ [d1]: [true, false] }, (calls) => {
      let ok;
      withNoPython(() => { ok = quota.admit(home, live, lease); });
      assert.strictEqual(calls.get(d1), 1, 'one snapshot, one scan -- refused without a post-prune re-snapshot');
      assert.strictEqual(ok, false, 'refused: the one snapshot was uncertain');
      assert.ok(!fs.existsSync(A.ledgerEntryPath(home, live)), 'no reservation was written');
      withNoPython(() => { ok = quota.admit(home, live, lease); });
      assert.strictEqual(calls.get(d1), 2, 'the next decision is its own single scan');
      assert.strictEqual(ok, true, 'admitted on a fully measurable snapshot');
    });
    assert.deepStrictEqual(quota._readEntry(A.ledgerEntryPath(home, live)), { reserved: quota.RESERVE, granted: 0 });
    lease.release();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// R5-4 / Ruling 52
// ---------------------------------------------------------------------------------------------

test('Ruling 52: _parseEntry decodes strictly -- raw 0xff in an ignored field and a retained BOM are CORRUPT; clean entries parse', () => {
  const home = tmpHome();
  try {
    const good = Buffer.from(JSON.stringify({ reserved: quota.RESERVE, granted: 7 }), 'utf8');
    assert.deepStrictEqual(quota._parseEntry(good), { reserved: quota.RESERVE, granted: 7 });

    // invalid UTF-8 inside a string value the validator never looks at: lossy toString() would
    // have repaired it to U+FFFD and accepted the entry; Python's json.loads rejects the bytes.
    const withFF = Buffer.concat([
      Buffer.from(`{"reserved":${quota.RESERVE},"granted":7,"note":"`, 'utf8'),
      Buffer.from([0xff]),
      Buffer.from('"}', 'utf8'),
    ]);
    assert.strictEqual(quota._parseEntry(withFF), quota.CORRUPT, 'raw 0xff -> CORRUPT');

    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), good]);
    assert.strictEqual(quota._parseEntry(bom), quota.CORRUPT, 'UTF-8 BOM -> CORRUPT (Python: "Unexpected UTF-8 BOM")');

    // and through the on-disk read path
    const aid = A.mintActivityId();
    A.secureMkdir(A.quotaDir(home));
    const p = A.ledgerEntryPath(home, aid);
    fs.writeFileSync(p, withFF, { mode: 0o600 });
    assert.strictEqual(quota._readEntry(p), quota.CORRUPT);
    assert.strictEqual(quota._hasCorrupt(home), true);
    assert.strictEqual(quota._accountingSnapshot(home).corrupt, true);
    fs.writeFileSync(p, good, { mode: 0o600 });
    assert.deepStrictEqual(quota._readEntry(p), { reserved: quota.RESERVE, granted: 7 });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
