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
//
// Ruling 71 (Codex Round-11 BLOCKER) SUPERSEDES the "charged 0" half of the above: ignoring the
// junk directory as an ACTIVITY was right, ignoring its BYTES was the bug (a 64 MiB junk file
// slipped under the ceiling with `uncertain:false`). Junk is now MEASURED as a foreign entry --
// its bytes count, it still never becomes an activity input / subdir / rejection. The charge
// assertions below were updated accordingly; see `codex-r11-node.test.js` for the full rule.
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

test('Ruling 70 + 71: a non-UUID junk directory under activity/ is never an accounting ACTIVITY, but its bytes ARE charged (unlocked AND locked accounting agree); a real activity alongside it still is', () => {
  const home = tmpHome();
  try {
    A.secureMkdir(A.quotaDir(home)); // activity/ + activity/quota/ exist
    const root = rootOf(home);
    seedJunk(root, 'junk', 330);

    // junk alone: Ruling 70 charged 0 here; Ruling 71 charges the 330 measured bytes (certain)
    // -- matches Python's Round-11 rule exactly.
    assert.strictEqual(quota._charge(home), 330);
    assert.deepStrictEqual(quota._accountingSnapshot(home), { charge: 330, uncertain: false, corrupt: false });

    // a real activity alongside the junk directory is still measured and charged normally --
    // the fix must not also start hiding LEGITIMATE activities.
    const aid = seedSettled(home, 4096);
    assert.strictEqual(quota._charge(home), 4096 + 330, 'the junk bytes AND the real activity are both counted');
    assert.deepStrictEqual(quota._accountingSnapshot(home), { charge: 4096 + 330, uncertain: false, corrupt: false });

    // the LOCKED accounting path (`_gatherAccounting`/`_accountingSnapshot` under a lock context
    // -- what `admit`/`grant`/`settle` actually use) must agree with the unlocked path above.
    const ctx = quota._quotaLock(home);
    try {
      const gathered = quota._gatherAccounting(home, ctx);
      assert.deepStrictEqual(gathered.activities.map((a) => a.aid), [aid], '"junk" never became an accounting activity input');
      assert.ok(gathered.foreign.some((f) => f.name === 'junk' && f.onDisk === 330 && f.uncertain === false), 'junk is a FOREIGN input (Ruling 71)');
      assert.deepStrictEqual(quota._accountingSnapshot(home, ctx), { charge: 4096 + 330, uncertain: false, corrupt: false });
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

test('Ruling 70 counterfactual (as amended by Ruling 71): with ids.validActivityId patched to accept any string, the junk directory becomes an ACTIVITY input -- the guard prevents management, not measurement', () => {
  const home = tmpHome();
  try {
    A.secureMkdir(A.quotaDir(home));
    const root = rootOf(home);
    seedJunk(root, 'junk', 330);
    assert.strictEqual(quota._charge(home), 330); // guard in place: junk measured as foreign
    let g = quota._gatherAccounting(home);
    assert.deepStrictEqual(g.activities, [], 'guard in place: junk is not an activity input');
    assert.ok(g.foreign.some((f) => f.name === 'junk'), 'guard in place: junk is a foreign input');

    const real = ids.validActivityId;
    ids.validActivityId = (s) => typeof s === 'string'; // every guard in paths.js/quota.js keys off this one predicate
    try {
      g = quota._gatherAccounting(home);
      assert.ok(g.activities.some((a) => a.aid === 'junk'), 'BUG reproduced (pre-Ruling-70 behavior): junk is CLASSIFIED as an activity once id validation is bypassed');
      assert.ok(!g.foreign.some((f) => f.name === 'junk'), 'and is no longer a foreign entry');
      assert.strictEqual(quota._charge(home), 330, 'the bytes are charged either way (Ruling 71) -- the guard is about identity, not bytes');
    } finally {
      ids.validActivityId = real;
    }
    g = quota._gatherAccounting(home);
    assert.deepStrictEqual(g.activities, [], 'guard restored: junk is foreign again');
    assert.strictEqual(quota._charge(home), 330);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
