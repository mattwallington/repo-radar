'use strict';
// Task 5.2: retention wiring landmarks in main.js -- the Python `retain` entrypoint
// (`activityQuota._spawnPythonRetain`, Task 3.5) is spawned at exactly two points: once at app
// start (inside the post-configuration missed-syncs setTimeout, alongside the startup prune
// delegation -- fix round 1: it must run AFTER `activityQuota.configurePythonRunner(...)`, or it
// falls back to a `python3` + repo-relative-root default that does not exist in a packaged app,
// silently no-op-ing behind a bounded console warn) and once per sync completion
// (currentSyncProcess's `close` handler), in BOTH cases BEFORE the `_refreshViewErrorsTarget()` +
// `updateTrayMenu()` pair that follows it (Ruling P5-4, fix round 2: `_spawnPythonRetain` is
// `spawnSync`, so retention has already deleted by the time it returns -- refreshing FIRST could
// cache an activity retention then removed, leaving the tray offering a dead "View Errors" deep
// link until the next 30s tick). Node performs NO deletion of its own
// (Ruling B) and the legacy `_rotate_sync_logs` (repo_radar/sync.py:107-122) is independent and
// untouched -- this file also asserts main.js never itself calls a delete primitive anywhere near
// the activity subsystem.
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

test('the startup retain spawn is ordered strictly after configurePythonRunner(...)', () => {
  // Fix round 1 (review): a retain spawn issued BEFORE configurePythonRunner(...) runs falls back
  // to quota.js's bare `python3` + repo-relative-root default, which does not exist in a packaged
  // app (see the configurePythonRunner call site's own comment a few lines above it in main.js) --
  // the spawn then silently fails closed with only a bounded console warn, invisible in practice.
  // This is the ordering assertion that would have caught that bug; a positional index check
  // (rather than `between`, which requires both anchors unique -- configurePythonRunner( only
  // ever appears once, so a plain indexOf pair is simplest here).
  const configureAt = src.indexOf('activityQuota.configurePythonRunner(');
  assert.notStrictEqual(configureAt, -1, 'main.js must still call configurePythonRunner');
  assert.strictEqual(src.indexOf('activityQuota.configurePythonRunner(', configureAt + 1), -1,
    'configurePythonRunner( must appear exactly once');
  const startupSpawnAt = src.indexOf('activityQuota._spawnPythonRetain(os.homedir());', configureAt);
  assert.notStrictEqual(startupSpawnAt, -1,
    'the startup retain spawn must appear AFTER configurePythonRunner(...) in source order');
});

test('the startup retain spawn sits in the post-configuration missed-syncs setTimeout, ' +
  'alongside the startup prune spawn, and never on the 30s tray-refresh interval', () => {
  // Same block the pre-existing startup prune delegation already uses -- main.js's own comment
  // there (and now the retain call's own comment) explains why: configurePythonRunner() must
  // already have run by the time this fires, and this setTimeout is registered after that call.
  // Anchored on code (not comments, which `src` has already stripped): the setTimeout's own body
  // opener through its unique `}, 2000);` closer.
  const missedSyncs = between('setTimeout(() => {\n    reconcileRunReceipt();', '}, 2000);');
  const count = (missedSyncs.match(/activityQuota\._spawnPythonRetain\(/g) || []).length;
  assert.strictEqual(count, 1, 'one retain spawn in the post-configuration missed-syncs setTimeout');

  inOrder(missedSyncs, ['activityQuota._spawnPythonPrune(', 'activityQuota._spawnPythonRetain('],
    'the startup retain spawn follows the startup prune delegation in the same block');

  assert.ok(/try\s*\{\s*activityQuota\._spawnPythonRetain\(os\.homedir\(\)\);?\s*\}\s*catch/.test(missedSyncs),
    'the startup call site guards the spawn (belt-and-suspenders; _spawnPythonRetain itself never throws)');

  // Ruling P5-4, startup half: the seed refresh near tray creation runs ~2s BEFORE this block, so
  // it necessarily reads the PRE-retention store. Without a second refresh + rebuild after the
  // retain call here, the first menu of the session can keep offering a "View Errors" target that
  // startup retention has already deleted -- until the 30s tick happens to correct it.
  inOrder(missedSyncs,
    ['activityQuota._spawnPythonRetain(', '_refreshViewErrorsTarget()', 'updateTrayMenu()'],
    'startup: the menu is rebuilt from the POST-retention store, after the retain spawn');

  // Guard against a regression that moves it onto the recurring 30s tray-refresh tick instead of
  // running once at startup.
  const interval = between('setInterval(() => {\n    _refreshViewErrorsTarget();', '}, 30000);');
  assert.strictEqual(/activityQuota\._spawnPythonRetain\(/.test(interval), false,
    'the retain spawn must not run on the 30s tray-refresh tick -- startup only, per the brief');
});

test('the close-handler retain spawn comes BEFORE the refresh + tray rebuild', () => {
  // Ruling P5-4 (Codex final verdict, BLOCKER): the original ordering here was refresh -> rebuild
  // -> retain, justified by "this tick's menu reflects pre-retention state". That justification was
  // wrong. `_spawnPythonRetain` is `spawnSync` -- retention has ALREADY finished deleting by the
  // time it returns -- so a refresh performed before it could cache an activity that retention then
  // deleted, and the tray kept offering "View Errors" for a target the deep link could no longer
  // open (reviewer repro: one 90-day-expired `failed` activity + 50 recent `succeeded` -- the old
  // one is selected, retention deletes it, a fresh lookup returns null). The cache must therefore be
  // recomputed from the POST-retention store: retain first, THEN refresh, THEN rebuild.
  const close = between("currentSyncProcess.on('close'", "currentSyncProcess.on('error'");
  const count = (close.match(/activityQuota\._spawnPythonRetain\(/g) || []).length;
  assert.strictEqual(count, 1, 'one retain spawn in the close handler');
  inOrder(close, ['activityQuota._spawnPythonRetain(', '_refreshViewErrorsTarget()', 'updateTrayMenu()'],
    'sync close: retain, then refresh, then rebuild (the cache must never name a just-deleted activity)');
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
