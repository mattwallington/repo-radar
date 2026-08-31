'use strict';
// Task 3.5: proves the Node-side half of the retention matrix -- `_spawnPythonRetain` invokes the
// Python `retain` entrypoint (`-m repo_radar.activity.retain`) via the SAME configured-runner seam
// `_spawnPythonPrune` already uses (Codex B3a), and that Node's own retain-invocation code path
// performs NO filesystem deletion itself (Ruling B: all destructive deletion is the descriptor-
// relative Python `unlink_owned_tree` -- Node only spawns). Mirrors quota-delegation.test.js's
// fake-script/seam approach rather than inventing a new one.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../index');
const { quota } = A;

// Tracks every tmp dir this file mints so a single after() sweep cleans them all up (the suite
// has had disk-exhausting tmp accumulation -- see quota-delegation.test.js's own header).
const _tmpDirs = [];
function tmpHome() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-retain-invoke-'));
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

test('_spawnPythonRetain invokes the interpreter with -m repo_radar.activity.retain via the configured runner', () => {
  const home = tmpHome();
  const scriptDir = tmpDir('rr-retain-stub-script-');
  const argvCapture = path.join(scriptDir, 'argv.txt');
  const fakeScript = path.join(scriptDir, 'fake-python');
  // A tiny stub that records its own argv (mirrors quota-delegation.test.js's fake-python
  // approach) and does nothing else -- in particular, no deletion of any kind. Written to a
  // separate file (not stdout) so this test can also assert stdio was left alone.
  fs.writeFileSync(
    fakeScript,
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argvCapture)}\nexit 0\n`,
    { mode: 0o755 },
  );

  try {
    quota.configurePythonRunner({ python: fakeScript, cwd: scriptDir, env: {} });
    const result = quota._spawnPythonRetain(home);

    assert.strictEqual(result.status, 0, `stub must have run cleanly: ${JSON.stringify(result)}`);
    const recordedArgv = fs.readFileSync(argvCapture, 'utf8').trim().split('\n');
    assert.deepStrictEqual(recordedArgv, ['-m', 'repo_radar.activity.retain']);
  } finally {
    quota.configurePythonRunner(null);
  }
});

test('a failed retain spawn is surfaced via a warn line and never throws', () => {
  const home = tmpHome();
  const warnings = [];
  const realConsoleError = console.error;
  console.error = (msg) => warnings.push(String(msg));
  try {
    quota.configurePythonRunner({ python: '/nonexistent/python3-does-not-exist-for-this-test', cwd: os.tmpdir(), env: {} });
    let result;
    assert.doesNotThrow(() => { result = quota._spawnPythonRetain(home); });
    assert.ok(result.error, 'spawn should report the missing interpreter');
    assert.ok(
      warnings.some((m) => /activity/i.test(m) && /retain/i.test(m)),
      `expected a surfaced retain-failure warning, got: ${JSON.stringify(warnings)}`,
    );
  } finally {
    console.error = realConsoleError;
    quota.configurePythonRunner(null);
  }
});

test('Ruling B: the Node retain path performs no filesystem deletion itself', () => {
  const home = tmpHome();
  const scriptDir = tmpDir('rr-retain-noop-script-');
  const fakeScript = path.join(scriptDir, 'fake-python');
  // A no-op stub: it does NOT delete anything (it can't -- it's not the real Python retain
  // entrypoint). If, after calling _spawnPythonRetain, the fixture files below are gone, the
  // deletion could only have come from Node's own code -- which Ruling B forbids.
  fs.writeFileSync(fakeScript, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  // A realistic activity fixture: an activity dir with a segment file, plus a quota ledger entry
  // -- exactly the kind of on-disk state a real retain pass would consider pruning.
  A.secureMkdir(A.quotaDir(home));
  const aid = A.mintActivityId();
  A.secureMkdir(A.activityDir(home, aid));
  const segPath = path.join(A.activityDir(home, aid), 'python-deadbeef.jsonl');
  fs.writeFileSync(segPath, JSON.stringify({ schema_version: 1, activity_id: aid, type: 'start' }) + '\n', { mode: 0o600 });
  const ledgerPath = A.ledgerEntryPath(home, aid);
  fs.writeFileSync(ledgerPath, JSON.stringify({ reserved: quota.RESERVE, granted: 0 }), { mode: 0o600 });

  try {
    quota.configurePythonRunner({ python: fakeScript, cwd: scriptDir, env: {} });
    quota._spawnPythonRetain(home);

    assert.ok(fs.existsSync(segPath), 'activity segment must be untouched -- Node never deletes activity data itself');
    assert.ok(fs.existsSync(A.activityDir(home, aid)), 'activity dir must be untouched');
    assert.ok(fs.existsSync(ledgerPath), 'ledger entry must be untouched -- Node never unlinks it itself');
  } finally {
    quota.configurePythonRunner(null);
  }
});
