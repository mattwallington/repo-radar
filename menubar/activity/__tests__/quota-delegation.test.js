'use strict';
// Task 2.2b: proves Ruling B's delegation mechanism actually works, end to end, against a REAL
// Python subprocess (not a mock) -- an `admit` that first fails because the accounting is
// CERTAIN, NON-CORRUPT and merely over the 64 MiB ceiling spawns the real
// `python -m repo_radar.activity.prune <headroom>`, which reconciles + prunes settled activities
// (Python's `_prune_locked`, unchanged), and the re-evaluated Node `admit` then succeeds where it
// first failed.
//
// Codex R7 B2 / Ruling 61 (this file's fixture changed): the original fixture here was a CORRUPT
// ledger entry that admit's delegation got Python to evidence-clear. Under Ruling 61 an
// uncertain OR corrupt snapshot refuses admission OUTRIGHT with NO prune delegation (a
// floor/sentinel charge handed to the prune loop deleted every prunable activity), so a corrupt
// entry is no longer something Node's admission path clears. The delegation mechanism itself is
// unchanged and is now proven on the only trigger that remains: a measured, certain shortfall.
// (The "corrupt -> NOT delegated" half lives in codex-r7.test.js.)
//
// The "false-before" half is proven by pointing quota.js's PYTHON_BIN test seam at a
// nonexistent binary FIRST (so the exact same real `admit()` codepath attempts delegation via a
// real spawnSync call, finds no interpreter, and -- per the brief's "spawnSync, never throws"
// contract -- fails closed rather than crashing) and observing admit still return false with
// every settled activity untouched. Restoring PYTHON_BIN to the real interpreter and calling
// `admit` again is the "true-after" half, via a REAL python3 child process. Both calls exercise
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
const TS = '2026-08-14T00:00:00-07:00';

// A SETTLED, PRUNABLE activity of `nbytes`: a conforming segment carrying a durable start +
// terminal (so Python's `_classify` sees a reconciled, routine run -- never 'running'), grown to
// `nbytes` with a SPARSE tail (an unterminated final line, ignored by both parsers; costs no real
// disk). No ledger entry, no owner.lock.
function seedPrunable(home, nbytes) {
  const aid = A.mintActivityId();
  A.secureMkdir(A.activityDir(home, aid));
  const seg = A.segmentPath(home, aid, 'python', 'deadbeef');
  const lines = [
    { schema_version: 1, activity_id: aid, type: 'start', seq: 0, ts: TS, kind: 'sync', channel: 'stable', trigger: 'cli', created_by: 'python' },
    { schema_version: 1, activity_id: aid, type: 'terminal', seq: 1, ts: TS, outcome: 'succeeded', summary: {}, by: 'deadbeef' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(seg, lines, { mode: 0o600 });
  fs.truncateSync(seg, nbytes);
  return aid;
}

// The CERTAIN, NON-CORRUPT, OVER-CEILING fixture (Ruling 61's only delegation trigger): 16 x
// 4 MiB settled activities == exactly CEILING, so `charge + RESERVE > CEILING` and a fresh
// admission needs the prune to free room. Plus the fresh, admittable activity.
function fullPlusFreshActivity(home) {
  const settled = [];
  for (let i = 0; i < 16; i++) settled.push(seedPrunable(home, quota.PER_ACTIVITY_CAP));
  const aid = A.mintActivityId();
  A.secureMkdir(A.activityDir(home, aid));
  const l = A.acquire(A.ownerLockPath(home, aid));
  return { settled, aid, l };
}

const settledDirsRemaining = (home, settled) => settled.filter((s) => fs.existsSync(A.activityDir(home, s))).length;

test('admit false-before / true-after: a certain over-ceiling refusal delegates to the real python prune entrypoint', { skip: !hasPython3() && 'python3 not found on PATH' }, () => {
  const home = tmpHome();
  const originalPythonBin = quota.PYTHON_BIN;

  try {
    const { settled, aid, l } = fullPlusFreshActivity(home);
    assert.ok(l !== null);
    assert.deepStrictEqual(quota._accountingSnapshot(home), { charge: quota.CEILING, uncertain: false, corrupt: false }, 'sanity: certain, non-corrupt, exactly full');

    // -- false-before: delegation attempted (real spawnSync call) but no interpreter available.
    quota.PYTHON_BIN = '/nonexistent/python3-does-not-exist-for-this-test';
    assert.strictEqual(quota.admit(home, aid, l), false, 'must refuse: still full, delegation unavailable');
    assert.strictEqual(settledDirsRemaining(home, settled), 16, 'nothing pruned -- Node never deletes anything itself');
    assert.ok(!fs.existsSync(A.ledgerEntryPath(home, aid)), 'no reservation written');

    // -- true-after: same real admit() call, now with a real python3 available to delegate to.
    quota.PYTHON_BIN = originalPythonBin;
    assert.strictEqual(quota.admit(home, aid, l), true, 'must succeed: real python prune freed the headroom');
    assert.ok(settledDirsRemaining(home, settled) < 16, 'python prune -- not Node -- physically removed settled activities');
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(A.ledgerEntryPath(home, aid), 'utf8')),
      { reserved: quota.RESERVE, granted: 0 },
    );
    const after_ = quota._accountingSnapshot(home);
    assert.ok(after_.charge <= quota.CEILING && !after_.uncertain && !after_.corrupt);
  } finally {
    quota.PYTHON_BIN = originalPythonBin;
  }
});

test('a spawn failure (missing python3) never throws out of admit -- it fails closed', () => {
  const home = tmpHome();
  const originalPythonBin = quota.PYTHON_BIN;
  try {
    const { aid, l } = fullPlusFreshActivity(home);
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

test('B3(a): admit\'s over-ceiling prune delegation uses the CONFIGURED runner, not the bare PYTHON_BIN fallback', { skip: !hasPython3() && 'python3 not found on PATH' }, () => {
  const home = tmpHome();
  const originalPythonBin = quota.PYTHON_BIN;
  try {
    const { settled, aid, l } = fullPlusFreshActivity(home);

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
    assert.ok(settledDirsRemaining(home, settled) < 16, 'the configured runner\'s python prune -- not the PYTHON_BIN fallback -- freed the room');
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

    const { settled, aid, l } = fullPlusFreshActivity(home);
    assert.strictEqual(quota.admit(home, aid, l), true, 'the packaged-style venv/bin/python + repo_radar layout must resolve and successfully delegate');
    assert.ok(settledDirsRemaining(home, settled) < 16);
  } finally {
    quota.PYTHON_BIN = originalPythonBin;
    quota.configurePythonRunner(null);
  }
});

// -------------------------------------------------------------------------------------------
// Codex B3(b): a failed delegated spawn must be surfaced (bounded warn/log), never throw, and
// admit must stay fail-closed while the shortfall stands.
// -------------------------------------------------------------------------------------------

test('B3(b): a missing configured interpreter is surfaced via a warn line, never throws, and admit stays fail-closed', () => {
  const home = tmpHome();
  const warnings = [];
  const realConsoleError = console.error;
  console.error = (msg) => warnings.push(String(msg));
  try {
    const { settled, aid, l } = fullPlusFreshActivity(home);
    quota.configurePythonRunner({ python: '/nonexistent/python3-does-not-exist-for-this-test', cwd: os.tmpdir(), env: {} });

    let result;
    assert.doesNotThrow(() => { result = quota.admit(home, aid, l); });
    assert.strictEqual(result, false, 'fail-closed: still full, delegation unavailable');
    assert.strictEqual(settledDirsRemaining(home, settled), 16, 'settled activities untouched -- Node never deletes anything itself');
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
    const { settled, aid, l } = fullPlusFreshActivity(home);
    quota.configurePythonRunner({ python: fakeScript, cwd: os.tmpdir(), env: {} });

    let result;
    assert.doesNotThrow(() => { result = quota.admit(home, aid, l); });
    assert.strictEqual(result, false);
    assert.strictEqual(settledDirsRemaining(home, settled), 16);
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
