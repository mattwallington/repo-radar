'use strict';
// Task 2.2b: proves Ruling B's delegation mechanism actually works, end to end, against a REAL
// Python subprocess (not a mock) -- an `admit` that first fails because a corrupt ledger entry
// stands (spec §7 refuse-while-corrupt) spawns the real `python -m repo_radar.activity.prune`,
// which reconciles + evidence-clears it (Python's B2 state machine, unchanged), and the
// re-evaluated Node `admit` then succeeds where it first failed.
//
// The "false-before" half is proven by pointing quota.js's PYTHON_BIN test seam at a
// nonexistent binary FIRST (so the exact same real `admit()` codepath attempts delegation via a
// real spawnSync call, finds no interpreter, and -- per the brief's "spawnSync, never throws"
// contract -- fails closed rather than crashing) and observing admit still return false with the
// corrupt entry untouched. Restoring PYTHON_BIN to the real interpreter and calling `admit`
// again is the "true-after" half, via a REAL python3 child process. Both calls exercise
// admit()'s single, real, internal release->spawn->reacquire->reevaluate sequence (see
// ../quota.js) -- nothing about the sequence itself is mocked, only which binary is available to
// spawn.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('child_process');
const A = require('../index');
const { quota } = A;

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-quota-delegation-'));
}

function hasPython3() {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

test('admit false-before / true-after: a corrupt-blocking refusal delegates to the real python prune entrypoint', { skip: !hasPython3() && 'python3 not found on PATH' }, () => {
  const home = tmpHome();
  const originalPythonBin = quota.PYTHON_BIN;

  try {
    // A corrupt ledger entry with NO activity dir at all -> owner.lock was never created ->
    // Python's prune reconcile pass evidence-clears it via the "owner provably gone" path
    // (spec line 78 / §7 Gap 2b) -- the exact same fixture as
    // test_corrupt_entry_with_no_owner_lock_clears_via_owner_gone_path in
    // repo_radar/tests/test_activity_quota.py.
    A.secureMkdir(A.quotaDir(home));
    const staleAid = A.mintActivityId();
    const staleEntry = A.ledgerEntryPath(home, staleAid);
    fs.writeFileSync(staleEntry, '{not valid json', { mode: 0o600 });
    assert.strictEqual(quota._hasCorrupt(home), true);

    const [aid, l] = (() => {
      const id = A.mintActivityId();
      A.secureMkdir(A.activityDir(home, id));
      return [id, A.acquire(A.ownerLockPath(home, id))];
    })();
    assert.ok(l !== null);

    // -- false-before: delegation attempted (real spawnSync call) but no interpreter available.
    quota.PYTHON_BIN = '/nonexistent/python3-does-not-exist-for-this-test';
    assert.strictEqual(quota.admit(home, aid, l), false, 'must refuse: corrupt entry still stands, delegation unavailable');
    assert.ok(fs.existsSync(staleEntry), 'stale corrupt entry must be untouched -- Node never unlinks it itself');
    assert.strictEqual(quota._hasCorrupt(home), true);

    // -- true-after: same real admit() call, now with a real python3 available to delegate to.
    quota.PYTHON_BIN = originalPythonBin;
    assert.strictEqual(quota.admit(home, aid, l), true, 'must succeed: real python prune cleared the corrupt entry');
    assert.ok(!fs.existsSync(staleEntry), 'python prune -- not Node -- physically removed the corrupt entry');
    assert.strictEqual(quota._hasCorrupt(home), false);
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(A.ledgerEntryPath(home, aid), 'utf8')),
      { reserved: quota.RESERVE, granted: 0 },
    );
  } finally {
    quota.PYTHON_BIN = originalPythonBin;
  }
});

test('a spawn failure (missing python3) never throws out of admit -- it fails closed', () => {
  const home = tmpHome();
  const originalPythonBin = quota.PYTHON_BIN;
  try {
    A.secureMkdir(A.quotaDir(home));
    const staleAid = A.mintActivityId();
    fs.writeFileSync(A.ledgerEntryPath(home, staleAid), '{not valid json', { mode: 0o600 });

    const aid = A.mintActivityId();
    A.secureMkdir(A.activityDir(home, aid));
    const l = A.acquire(A.ownerLockPath(home, aid));

    quota.PYTHON_BIN = '/nonexistent/python3-does-not-exist-for-this-test';
    assert.doesNotThrow(() => {
      const result = quota.admit(home, aid, l);
      assert.strictEqual(result, false);
    });
  } finally {
    quota.PYTHON_BIN = originalPythonBin;
  }
});
