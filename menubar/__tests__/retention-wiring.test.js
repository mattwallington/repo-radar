'use strict';
// Task 5.2: retention wiring landmarks in main.js -- the Python `retain` entrypoint
// (`activityQuota._spawnPythonRetain`, Task 3.5) is spawned at exactly two points: once at app
// start (after the tray exists) and once per sync completion (currentSyncProcess's `close`
// handler), in the latter case AFTER that handler's existing `_refreshViewErrorsTarget()` +
// `updateTrayMenu()` pair so this tick's menu still reflects pre-retention state (the spawned
// Python runs async in spirit -- the next 30s tick or the next sync's own refresh sees whatever
// retention pruned). Node performs NO deletion of its own (Ruling B) and the legacy
// `_rotate_sync_logs` (repo_radar/sync.py:107-122) is independent and untouched -- this file also
// asserts main.js never itself calls a delete primitive anywhere near the activity subsystem.
//
// main.js cannot be require()'d outside a running Electron process (it destructures
// `{ app, Tray, ... }` off `require('electron')` and calls `app.requestSingleInstanceLock()` at
// module load), so this follows the established view-errors-wiring.test.js /
// activity-ipc-wiring.test.js precedent: assert main.js still parses, and assert the wiring is
// actually present in the source. `codeOf`/`between`/`inOrder` are duplicated from
// view-errors-wiring.test.js's own helpers (same file-local-helper precedent that file itself
// documents) -- NOTE its comment that `functionBody('triggerSync')` does NOT work on destructured
// params (triggerSync's `{ showWindow = true, ... } = {}` signature opens/closes a brace before
// the body does); this file doesn't need functionBody at all, so that helper isn't duplicated here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MENUBAR = path.join(__dirname, '..');
const MAIN_JS = path.join(MENUBAR, 'main.js');

const rawText = fs.readFileSync(MAIN_JS, 'utf8');
const rawLines = rawText.split('\n');

// Comment-stripped source, line-based so a `//` inside a string literal is never touched --
// mirrors view-errors-wiring.test.js's `codeOf`.
function codeOf(text) {
  return text.split('\n')
    .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
    .join('\n');
}

const src = codeOf(rawText);

// The source between two anchors, both of which must be unique.
function between(startAnchor, endAnchor) {
  const a = src.indexOf(startAnchor);
  assert.notStrictEqual(a, -1, `anchor not found: ${startAnchor}`);
  assert.strictEqual(src.indexOf(startAnchor, a + 1), -1, `anchor is not unique: ${startAnchor}`);
  const b = src.indexOf(endAnchor, a + startAnchor.length);
  assert.notStrictEqual(b, -1, `end anchor not found after ${startAnchor}: ${endAnchor}`);
  return src.slice(a, b);
}

// Asserts `markers` appear in the given order (each at least once) inside `slice`.
function inOrder(slice, markers, label) {
  let last = -1;
  markers.forEach((marker, i) => {
    const at = slice.indexOf(marker);
    assert.notStrictEqual(at, -1, `${label}: missing ${marker}`);
    assert.ok(at > last, `${label}: ${marker} must come after ${markers[i - 1]}`);
    last = at;
  });
}

test('main.js still parses', () => {
  execFileSync(process.execPath, ['--check', MAIN_JS], { stdio: 'pipe' });
});

test('_spawnPythonRetain is called exactly twice: startup and post-sync close', () => {
  const calls = (src.match(/activityQuota\._spawnPythonRetain\(/g) || []).length;
  assert.strictEqual(calls, 2,
    'exactly two retain spawns in main.js: once at startup, once in the sync close handler');
});

test('the startup retain spawn sits in the tray-setup region, adjacent to the seed refresh, ' +
  'and never inside the 30s interval', () => {
  // Same startup region view-errors-wiring.test.js's P4-14(b) test anchors: tray creation through
  // the tray click handler -- this also spans the 30s setInterval tick, so a spawn accidentally
  // placed inside that interval (re-running retain every 30s, not "once at startup") would still
  // be caught by this same region, which is why the interval is excluded explicitly below too.
  const startup = between("'Tray creation failed silently, quitting to avoid invisible process'", "tray.on('click'");
  const count = (startup.match(/activityQuota\._spawnPythonRetain\(/g) || []).length;
  assert.strictEqual(count, 1, 'one retain spawn in the startup/tray-setup region');

  const interval = between('setInterval(() => {\n    _refreshViewErrorsTarget();', '}, 30000);');
  assert.strictEqual(/activityQuota\._spawnPythonRetain\(/.test(interval), false,
    'the retain spawn must not run on the 30s tick -- startup only, per the brief');

  assert.ok(/try\s*\{\s*activityQuota\._spawnPythonRetain\(os\.homedir\(\)\);?\s*\}\s*catch/.test(startup),
    'the startup call site guards the spawn (belt-and-suspenders; _spawnPythonRetain itself never throws)');
});

test('the close-handler retain spawn comes after the refresh + tray rebuild', () => {
  const close = between("currentSyncProcess.on('close'", "currentSyncProcess.on('error'");
  const count = (close.match(/activityQuota\._spawnPythonRetain\(/g) || []).length;
  assert.strictEqual(count, 1, 'one retain spawn in the close handler');
  inOrder(close, ['_refreshViewErrorsTarget()', 'updateTrayMenu()', 'activityQuota._spawnPythonRetain('],
    'sync close: refresh, then rebuild, then retain (so this tick\'s menu reflects pre-retention state)');
});

test('main.js never itself deletes anything near the activity subsystem (Ruling B)', () => {
  // Node performs NO deletion of its own for activity data -- all destructive cleanup (retention,
  // pruning, corrupt-entry clearing) is delegated to Python (quota.js's header comment). main.js
  // legitimately calls fs.unlink*/fs.rmdir*/fs.rmSync elsewhere today (uninstallApp's
  // CONFIG_DIR/log-dir/channel-dir removal at ~line 769/779/805, its LaunchAgent plist/CLI
  // dispatcher/legacy-launcher unlinks, and cleanupOrphans' orphaned-plist unlink) -- none of
  // those lines, or any trailing comment on them, mention "activity" in any form. The targeted,
  // least-brittle assertion (per the task brief) is therefore: a delete-primitive call and the
  // substring "activity" never co-occur on one RAW source line (comments included, so a delete
  // call whose own trailing comment happens to mention "activity" is still caught, while a comment
  // mentioning "activity" on a DIFFERENT line never produces a false positive). No delete call
  // site in this file spans multiple lines, so a per-line check is sufficient today.
  const deletePattern = /\b(fs\.unlinkSync|fs\.unlink|fs\.rmdirSync|fs\.rmdir|fs\.rmSync)\s*\(/;
  const offenders = [];
  rawLines.forEach((line, i) => {
    if (deletePattern.test(line) && /activity/i.test(line)) {
      offenders.push(`line ${i + 1}: ${line.trim()}`);
    }
  });
  assert.deepStrictEqual(offenders, [],
    'no fs.unlink*/fs.rmdir*/fs.rmSync call may co-occur with "activity" on one source line');
});
