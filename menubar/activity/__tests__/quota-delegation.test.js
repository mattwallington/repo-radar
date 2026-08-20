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
const { after } = test;
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('child_process');
const A = require('../index');
const { quota } = A;

// Tracks every tmp dir this file mints (homes + fixture roots) so a single after() sweep can
// clean them all up (the suite has had disk-exhausting tmp accumulation -- see the brief for
// Codex B3).
const _tmpDirs = [];
function tmpHome() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-quota-delegation-'));
  _tmpDirs.push(h);
  return h;
}
function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  _tmpDirs.push(d);
  return d;
}
after(() => {
  for (const d of _tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* best-effort */ }
  }
});

function hasPython3() {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

// Real path of whatever `python3` resolves to on PATH -- used to build a symlinked runner (a
// different absolute path than the bare 'python3' PYTHON_BIN fallback uses) so tests can prove
// the CONFIGURED runner, not the PYTHON_BIN fallback, is what got invoked.
function realPython3Path() {
  return execFileSync('/bin/sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim();
}

const REPO_ROOT = path.join(__dirname, '..', '..', '..');

// A corrupt ledger entry (no owner.lock ever created -> Python's prune reconcile evidence-clears
// it via the "owner provably gone" path) plus a fresh, admittable activity -- the same fixture
// admit false-before/true-after above uses, factored out for the B3 tests below.
function corruptPlusFreshActivity(home) {
  A.secureMkdir(A.quotaDir(home));
  const staleAid = A.mintActivityId();
  const staleEntry = A.ledgerEntryPath(home, staleAid);
  fs.writeFileSync(staleEntry, '{not valid json', { mode: 0o600 });
  const aid = A.mintActivityId();
  A.secureMkdir(A.activityDir(home, aid));
  const l = A.acquire(A.ownerLockPath(home, aid));
  return { staleEntry, aid, l };
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

// -------------------------------------------------------------------------------------------
// Codex B3(a): the delegated spawn must resolve the CONFIGURED runner (packaged-app-capable),
// not the hardcoded dev-only PYTHON_BIN/REPO_ROOT fallback.
// -------------------------------------------------------------------------------------------

test('B3(a): admit\'s corrupt-clearing delegation uses the CONFIGURED runner, not the bare PYTHON_BIN fallback', { skip: !hasPython3() && 'python3 not found on PATH' }, () => {
  const home = tmpHome();
  const originalPythonBin = quota.PYTHON_BIN;
  try {
    const { staleEntry, aid, l } = corruptPlusFreshActivity(home);

    // Poison the OLD fallback -- if _spawnPythonPrune ever fell back to PYTHON_BIN instead of
    // the configured runner, delegation would fail and admit would stay refused.
    quota.PYTHON_BIN = '/nonexistent/python3-does-not-exist-for-this-test';
    // Configure the runner at the real repo root/python3 -- functionally equivalent to the old
    // default, but reached exclusively via the NEW configured path.
    quota.configurePythonRunner({
      python: realPython3Path(),
      cwd: REPO_ROOT,
      env: { PYTHONPATH: REPO_ROOT },
    });

    assert.strictEqual(quota.admit(home, aid, l), true, 'must succeed via the CONFIGURED runner, proving PYTHON_BIN was not used');
    assert.ok(!fs.existsSync(staleEntry), 'the configured runner\'s python prune -- not the PYTHON_BIN fallback -- cleared the corrupt entry');
  } finally {
    quota.PYTHON_BIN = originalPythonBin;
    quota.configurePythonRunner(null);
  }
});

test('B3(a): a packaged-style layout (venv/bin/python + repo_radar under one root, mirroring runtime/provision.js\'s genDir shape) resolves and delegates correctly', { skip: !hasPython3() && 'python3 not found on PATH' }, () => {
  const home = tmpHome();
  const originalPythonBin = quota.PYTHON_BIN;
  const fakeRoot = tmpDir('rr-quota-packaged-');
  try {
    // Simulate `<channelDir>/current` (dev fallback: REPO_ROOT containing `repo_radar/`, with a
    // python interpreter reachable alongside it) as produced by runtime/provision.js: a
    // `repo_radar` package + a `venv/bin/python` sibling under ONE root, distinct from both
    // REPO_ROOT and the bare PYTHON_BIN fallback.
    fs.symlinkSync(path.join(REPO_ROOT, 'repo_radar'), path.join(fakeRoot, 'repo_radar'));
    fs.mkdirSync(path.join(fakeRoot, 'venv', 'bin'), { recursive: true });
    fs.symlinkSync(realPython3Path(), path.join(fakeRoot, 'venv', 'bin', 'python'));

    quota.PYTHON_BIN = '/nonexistent/python3-does-not-exist-for-this-test'; // prove the fallback is unused
    quota.configurePythonRunner({
      python: path.join(fakeRoot, 'venv', 'bin', 'python'),
      cwd: fakeRoot,
      env: { PYTHONPATH: fakeRoot },
    });

    const { staleEntry, aid, l } = corruptPlusFreshActivity(home);
    assert.strictEqual(quota.admit(home, aid, l), true, 'the packaged-style venv/bin/python + repo_radar layout must resolve and successfully delegate');
    assert.ok(!fs.existsSync(staleEntry));
  } finally {
    quota.PYTHON_BIN = originalPythonBin;
    quota.configurePythonRunner(null);
  }
});

// -------------------------------------------------------------------------------------------
// Codex B3(b): a failed delegated spawn must be surfaced (bounded warn/log), never throw, and
// admit must stay fail-closed while the corrupt entry stands.
// -------------------------------------------------------------------------------------------

test('B3(b): a missing configured interpreter is surfaced via a warn line, never throws, and admit stays fail-closed', () => {
  const home = tmpHome();
  const warnings = [];
  const realConsoleError = console.error;
  console.error = (msg) => warnings.push(String(msg));
  try {
    const { staleEntry, aid, l } = corruptPlusFreshActivity(home);
    quota.configurePythonRunner({ python: '/nonexistent/python3-does-not-exist-for-this-test', cwd: os.tmpdir(), env: {} });

    let result;
    assert.doesNotThrow(() => { result = quota.admit(home, aid, l); });
    assert.strictEqual(result, false, 'fail-closed: corrupt entry still stands, delegation unavailable');
    assert.ok(fs.existsSync(staleEntry), 'corrupt entry untouched -- Node never unlinks it itself');
    assert.ok(
      warnings.some((m) => /activity/i.test(m) && /prune/i.test(m)),
      `expected a surfaced prune-failure warning, got: ${JSON.stringify(warnings)}`,
    );
  } finally {
    console.error = realConsoleError;
    quota.configurePythonRunner(null);
  }
});

test('B3(b): a non-zero prune exit (not just a missing binary) is also surfaced with a bounded stderr excerpt, and never throws', () => {
  const home = tmpHome();
  const scriptDir = tmpDir('rr-quota-fail-script-');
  const fakeScript = path.join(scriptDir, 'fake-python');
  fs.writeFileSync(fakeScript, '#!/bin/sh\necho "boom on stderr from the fake interpreter" 1>&2\nexit 1\n', { mode: 0o755 });
  const warnings = [];
  const realConsoleError = console.error;
  console.error = (msg) => warnings.push(String(msg));
  try {
    const { staleEntry, aid, l } = corruptPlusFreshActivity(home);
    quota.configurePythonRunner({ python: fakeScript, cwd: os.tmpdir(), env: {} });

    let result;
    assert.doesNotThrow(() => { result = quota.admit(home, aid, l); });
    assert.strictEqual(result, false);
    assert.ok(fs.existsSync(staleEntry));
    assert.ok(
      warnings.some((m) => /boom on stderr from the fake interpreter/.test(m)),
      `expected the bounded stderr excerpt surfaced, got: ${JSON.stringify(warnings)}`,
    );
  } finally {
    console.error = realConsoleError;
    quota.configurePythonRunner(null);
  }
});

// -------------------------------------------------------------------------------------------
// Codex B3(c): a full Node lifecycle's durable terminal must not remain charged, and settle()'s
// bounded reap must actually remove the ledger entry once the lease is free (the measured bug).
// -------------------------------------------------------------------------------------------

test('B3(c): a full Node lifecycle (admit -> grant -> durable terminal) is no longer charged, and the bounded reap removes the ledger entry', { skip: !hasPython3() && 'python3 not found on PATH' }, () => {
  const home = tmpHome();
  const originalPythonBin = quota.PYTHON_BIN;
  try {
    quota.configurePythonRunner(null); // real default: python3 + REPO_ROOT
    quota.PYTHON_BIN = originalPythonBin;

    const { ActivityWriter } = A.writer;
    const w = new ActivityWriter(home, { kind: 'sync', channel: 'stable', trigger: 'manual', producer: 'electron' });
    assert.strictEqual(w._active, true, 'sanity: admission succeeded, writer is active');
    const aid = w.activityId;
    w.start();
    w.event('probe', 'info', { x: 1 });
    // The would-be-false-charge scenario: reserve (60 KiB) + a grant, well beyond what's
    // actually on disk at this point -- matches Codex's ~61,938-byte measurement shape.
    assert.strictEqual(quota.grant(home, aid, 1000), true);
    w.terminal('succeeded', { repos_changed: 1, errors: 0, warns: 0 });

    assert.strictEqual(
      quota._charge(home), quota._committed(home),
      'the settled reservation must no longer be charged as outstanding',
    );
    assert.ok(
      !fs.existsSync(A.ledgerEntryPath(home, aid)),
      'settle\'s bounded reap (release-before-settle) must have removed the ledger entry once the lease was free',
    );
  } finally {
    quota.PYTHON_BIN = originalPythonBin;
    quota.configurePythonRunner(null);
  }
});
