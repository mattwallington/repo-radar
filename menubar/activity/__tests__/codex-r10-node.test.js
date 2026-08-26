'use strict';
// Ruling 70 (G10-Node, parity with Python's Round-10 fix / Ruling 69, commit 593e0c2): Node's
// `paths.listOwnedSubdirsDetailed` pushed EVERY real directory into `subdirs` -- the
// `ids.validActivityId` check only ran on the non-directory branch -- so a non-UUID directory
// sitting directly under `activity/` (e.g. `activity/junk/`) was enumerated right alongside real
// activities. Neither `_committed` nor `_gatherAccounting` (quota.js's only two root-enumeration
// loops) had an id guard of its own to catch it, so `activity/junk/python-deadbeef.jsonl` (330
// bytes) was charged toward the 64 MiB quota ceiling where Python correctly charges 0 (Python's
// fd-bound, LOCKED root enumeration -- `list_owned_subdirs_dir_fd_detailed`, the counterpart
// `_gather_accounting` actually uses -- already filters to valid-activity-id names only, per
// Ruling 69). Node has no `dir_fd`, so `listOwnedSubdirsDetailed` is the SINGLE implementation
// both of quota.js's root-enumeration call sites go through; fixing it there closes the gap for
// both at once, and the explicit `ids.validActivityId` guards added to each loop are defense in
// depth (see quota.js `_committed`/`_gatherAccounting`).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../index');
const paths = require('../paths');
const ids = require('../ids');
const { quota } = A;

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-r10-node-'));
}

const rootOf = (home) => path.dirname(A.quotaDir(home));

// A non-UUID, activity-shaped directory sitting directly under `activity/` -- bypasses `paths.
// activityDir`'s id validation entirely (mirrors the Python repro's `_mk_junk`/`_write_junk_rec`:
// a segment-named file holding `nbytes` of segment-like content, so a scan that DID reach it
// would size it exactly like a real segment).
function seedJunk(root, name, nbytes) {
  const d = path.join(root, name);
  fs.mkdirSync(d, { mode: 0o700 });
  fs.writeFileSync(path.join(d, 'python-deadbeef.jsonl'), Buffer.alloc(nbytes, 0x0a), { mode: 0o600 });
  return d;
}

function seedSettled(home, nbytes) {
  const aid = A.mintActivityId();
  A.secureMkdir(A.activityDir(home, aid));
  fs.writeFileSync(A.segmentPath(home, aid, 'python', 'deadbeef'), Buffer.alloc(nbytes, 0x0a), { mode: 0o600 });
  return aid;
}

test('Ruling 70: a non-UUID junk directory under activity/ is never counted toward the charge (unlocked AND locked accounting agree); a real activity alongside it still is', () => {
  const home = tmpHome();
  try {
    A.secureMkdir(A.quotaDir(home)); // activity/ + activity/quota/ exist
    const root = rootOf(home);
    seedJunk(root, 'junk', 330);

    // junk alone: charge is 0, not 330 -- matches Python's Ruling 69 repro exactly.
    assert.strictEqual(quota._charge(home), 0);
    assert.deepStrictEqual(quota._accountingSnapshot(home), { charge: 0, uncertain: false, corrupt: false });

    // a real activity alongside the junk directory is still measured and charged normally --
    // the fix must not also start hiding LEGITIMATE activities.
    const aid = seedSettled(home, 4096);
    assert.strictEqual(quota._charge(home), 4096, 'the junk bytes stay excluded; the real activity is still counted');
    assert.deepStrictEqual(quota._accountingSnapshot(home), { charge: 4096, uncertain: false, corrupt: false });

    // the LOCKED accounting path (`_gatherAccounting`/`_accountingSnapshot` under a lock context
    // -- what `admit`/`grant`/`settle` actually use) must agree with the unlocked path above.
    const ctx = quota._quotaLock(home);
    try {
      const gathered = quota._gatherAccounting(home, ctx);
      assert.deepStrictEqual(gathered.activities.map((a) => a.aid), [aid], '"junk" never became an accounting activity input');
      assert.deepStrictEqual(quota._accountingSnapshot(home, ctx), { charge: 4096, uncertain: false, corrupt: false });
    } finally {
      quota._unlock(ctx);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 70: listOwnedSubdirsDetailed ignores junk/ and quota/ (real, non-UUID directories) while still reporting a valid-UUID symlink as rejected/uncertain', () => {
  const home = tmpHome();
  try {
    A.secureMkdir(A.quotaDir(home)); // creates root + quota/ (a real, non-UUID directory)
    const root = rootOf(home);
    seedJunk(root, 'junk', 0);

    const validAid = A.mintActivityId();
    A.secureMkdir(A.activityDir(home, validAid));

    const symlinkAid = A.mintActivityId();
    const outside = path.join(home, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, symlinkAid));

    const { subdirs, rejected, uncertain } = paths.listOwnedSubdirsDetailed(root);
    assert.deepStrictEqual(subdirs, [validAid], '`junk` and `quota` must not appear -- neither is a valid activity id');
    assert.deepStrictEqual(rejected, [{ name: symlinkAid, reason: 'symlink' }], 'a valid-UUID symlink is still reported as rejected -- unchanged semantics');
    assert.strictEqual(uncertain, true, 'an activity-shaped entry we refused to follow still makes this uncertain');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 70 counterfactual: with ids.validActivityId patched to accept any string, the junk directory is charged again -- documents exactly what the guard prevents', () => {
  const home = tmpHome();
  try {
    A.secureMkdir(A.quotaDir(home));
    const root = rootOf(home);
    seedJunk(root, 'junk', 330);
    assert.strictEqual(quota._charge(home), 0); // guard in place: junk excluded

    const real = ids.validActivityId;
    ids.validActivityId = (s) => typeof s === 'string'; // every guard in paths.js/quota.js keys off this one predicate
    try {
      assert.strictEqual(quota._charge(home), 330, 'BUG reproduced (pre-Ruling-70 behavior): junk bytes are charged once id validation is bypassed');
    } finally {
      ids.validActivityId = real;
    }
    assert.strictEqual(quota._charge(home), 0, 'guard restored: junk bytes excluded again');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
