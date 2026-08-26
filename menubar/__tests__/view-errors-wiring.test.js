'use strict';
// Task 4.4: static wiring landmarks for the tray's "⚠️ View Errors" affordance in main.js.
// main.js cannot be require()'d outside a running Electron process (it destructures
// `{ app, Tray, ... }` off `require('electron')` and calls `app.requestSingleInstanceLock()` at
// module load), so this follows the established activity-ipc-wiring.test.js /
// model-notice-wiring.test.js / activity-window-security.test.js precedent: assert main.js still
// parses, and assert the wiring is actually present in the source. The BEHAVIOUR of the reader
// half is proven by activity/__tests__/view-errors-target.test.js.
//
// What must hold (Rulings P4-6, P4-12, P4-14):
//   * the menu item is gated on the CACHED target, not on `status.hasErrors` -- an
//     empty-but-flagged status can no longer produce an affordance that opens nothing;
//   * clicking it opens the ACTIVITY window focused on that id;
//   * a menu build NEVER calls the reader (P4-14 (a)): `updateTrayMenu` runs on the sync path
//     itself, on every tray click and several times per progress event, and the reader walks the
//     whole activity store;
//   * the cache is refreshed at the event points that can change it, and only there (P4-14 (b)):
//     startup, the sync child's `close`, and each of the three pre-attempt failures -- in each of
//     those three, AFTER the terminal is written and BEFORE the menu is rebuilt, which is the
//     ordering bug this fix round exists to close -- plus the existing 30s tick;
//   * the legacy `showErrorWindow` entry point routes to the Activity window too, so the log
//     window's error-stat click (`open-error-window`) can never resurrect the old empty view.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MENUBAR = path.join(__dirname, '..');
const MAIN_JS = path.join(MENUBAR, 'main.js');

// Every assertion below is about CODE. main.js's comments discuss the very things these tests
// assert are gone (this whole hunk is documented in prose next to it), so comment lines are
// dropped first -- line-based, so a `//` inside a string literal is never touched.
function codeOf(text) {
  return text.split('\n')
    .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
    .join('\n');
}

const src = codeOf(fs.readFileSync(MAIN_JS, 'utf8'));

// Source text of `function <name>(...) { ... }`, brace-matched from its opening `{`.
function functionBody(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `main.js must define ${name}`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// The source between two anchors, both of which must be unique.
function between(startAnchor, endAnchor) {
  const a = src.indexOf(startAnchor);
  assert.notStrictEqual(a, -1, `anchor not found: ${startAnchor}`);
  assert.strictEqual(src.indexOf(startAnchor, a + 1), -1, `anchor is not unique: ${startAnchor}`);
  const b = src.indexOf(endAnchor, a + startAnchor.length);
  assert.notStrictEqual(b, -1, `end anchor not found after ${startAnchor}: ${endAnchor}`);
  return src.slice(a, b);
}

// Asserts `markers` appear in the given order inside `slice`. `unique` (the default) also requires
// each to appear exactly once -- true of the small guard-block slices, but not of the sync `close`
// handler, which legitimately rebuilds the menu more than once.
function inOrder(slice, markers, label, { unique = true } = {}) {
  let last = -1;
  markers.forEach((marker, i) => {
    const at = slice.indexOf(marker);
    assert.notStrictEqual(at, -1, `${label}: missing ${marker}`);
    if (unique) {
      assert.strictEqual(slice.indexOf(marker, at + 1), -1, `${label}: ${marker} appears more than once`);
    }
    assert.ok(at > last, `${label}: ${marker} must come after ${markers[i - 1]}`);
    last = at;
  });
}

test('main.js still parses', () => {
  execFileSync(process.execPath, ['--check', MAIN_JS], { stdio: 'pipe' });
});

test('the refresh helper asks the reader, with configured secrets, and can never throw', () => {
  assert.ok(/require\(['"]\.\/activity\/read['"]\)/.test(src), "main.js must require('./activity/read')");
  const body = functionBody('_refreshViewErrorsTarget');
  assert.ok(/activityRead\.viewErrorsTarget\(/.test(body), 'the helper delegates to the reader');
  assert.ok(/configuredSecrets/.test(body) && /loadConfiguredSecrets\(/.test(body),
    'the reader call is given the configured secrets, like every other reader call site');
  assert.ok(/try\s*\{/.test(body) && /catch/.test(body),
    'a reader failure must degrade to null, never throw into a tray/icon path');
  assert.ok(/console\.warn\(/.test(body) && /slice\(0,\s*\d+\)/.test(body),
    'one BOUNDED breadcrumb on failure, rather than failing silently');
  assert.ok(/let viewErrorsTargetId = null;/.test(src), 'the target is cached in a module variable');
  // Ruling P4-14 replaced the TTL memo outright -- no time-based staleness anywhere.
  assert.strictEqual(/VIEW_ERRORS_TTL|viewErrorsMemo|_invalidateViewErrorsTarget/.test(src), false,
    'the 5s TTL memo is gone, cache + event-point refresh replaced it');
});

test('the tray "View Errors" item is gated on the cached target, not on status.hasErrors', () => {
  const body = functionBody('updateTrayMenu');
  assert.notStrictEqual(body.indexOf('View Errors'), -1, 'the tray still offers View Errors');

  assert.ok(/const viewErrorsId = viewErrorsTargetId;/.test(body),
    'the item is built from the cached target');
  assert.ok(/if \(viewErrorsId\) \{/.test(body), 'the item exists only when there is something to show');
  assert.ok(/click: \(\) => showActivityWindow\(viewErrorsId\)/.test(body),
    'the click deep-links the Activity window at that id');
  assert.strictEqual(/showErrorWindow/.test(body), false,
    'the tray no longer routes through the legacy error window');

  // `status.hasErrors` keeps driving the tray ICON and nothing else in this function.
  assert.strictEqual((body.match(/status\.hasErrors/g) || []).length, 1,
    'status.hasErrors survives only as the icon gate');
  assert.ok(body.indexOf('status.hasErrors') < body.indexOf('showErrorIcon()'),
    'the one surviving hasErrors read is the icon branch');
});

test('P4-14 (a): a menu build never calls the reader', () => {
  const body = functionBody('updateTrayMenu');
  assert.strictEqual(/_refreshViewErrorsTarget/.test(body), false,
    'updateTrayMenu must not refresh -- it is on the sync path and runs per progress event');
  assert.strictEqual(/activityRead\./.test(body), false, 'updateTrayMenu must not reach the reader at all');

  // The tray-click handler rebuilds the menu; it must not pay for a store walk either.
  const click = between("tray.on('click'", '});');
  assert.ok(/updateTrayMenu\(\)/.test(click), 'guard: the click handler still rebuilds the menu');
  assert.strictEqual(/_refreshViewErrorsTarget/.test(click), false, 'a tray click must not walk the store');

  // triggerSync rebuilds the menu BEFORE the child is spawned (currentSyncProcess is still null,
  // so the idle branch runs). Its four refreshes are the two guard blocks, the child's `close`
  // and the runSync rejection -- the pre-spawn rebuild is not one of them.
  const trigger = between('function triggerSync(', 'function showLogWindow(');
  assert.strictEqual((trigger.match(/_refreshViewErrorsTarget\(\)/g) || []).length, 4,
    'exactly the four failure/completion refreshes inside triggerSync, none on the pre-spawn path');
});

test('P4-14 (b): the cache is refreshed at startup and on the 30s tick, in that order', () => {
  const startup = between("'Tray creation failed silently, quitting to avoid invisible process'", "tray.on('click'");
  assert.strictEqual((startup.match(/_refreshViewErrorsTarget\(\)/g) || []).length, 2,
    'once to seed the first menu, once per 30s tick');
  assert.strictEqual((startup.match(/_refreshViewErrorsTarget\(\);\s*updateTrayMenu\(\);/g) || []).length, 2,
    'each refresh immediately precedes the rebuild that reads it');
  assert.ok(/\}, 30000\);/.test(startup), 'the second one is the 30s tick');
});

test('P4-14 (b): the sync completion path refreshes before it rebuilds', () => {
  const close = between("currentSyncProcess.on('close'", "currentSyncProcess.on('error'");
  inOrder(close, ['_refreshViewErrorsTarget()', 'updateTrayMenu()'], 'sync close', { unique: false });
  assert.strictEqual((close.match(/_refreshViewErrorsTarget\(\)/g) || []).length, 1,
    'one refresh at completion -- the later rebuilds in this handler read what it cached');
});

test('P4-14 (b): each pre-attempt failure writes its terminal, THEN refreshes, THEN rebuilds', () => {
  // The ordering bug this fix round closes: these three rebuilt the tray before the
  // `blocked`/`failed` terminal existed, so the affordance was missing until the next 30s tick --
  // after exactly the incident the feature exists to surface.
  inOrder(between('const blockedStatus = loadStatus();', 'return;'),
    ['activityGlue.onGuardBlock(', '_refreshViewErrorsTarget()', 'updateTrayMenu()'],
    'dev-ownership guard block');

  inOrder(between("console.error('Sync disabled:', reason);", 'return;'),
    ['activityGlue.onGuardBlock(', '_refreshViewErrorsTarget()', 'updateTrayMenu()'],
    'runtime-disabled guard block');

  inOrder(between("console.error('runSync failed to start sync:', e);", '});'),
    ["activity.writer.terminal('failed')", '_refreshViewErrorsTarget()', 'updateTrayMenu()'],
    'runSync rejection');
});

test('showErrorWindow routes to the Activity window and creates no window of its own', () => {
  const body = functionBody('showErrorWindow');
  assert.ok(/showActivityWindow\(viewErrorsTargetId\)/.test(body),
    'the legacy entry point opens the Activity window at the cached target');
  assert.strictEqual(/new BrowserWindow\(/.test(body), false, 'no second error window is ever created');
  assert.strictEqual(/error\.html/.test(body), false, 'the legacy error page is never loaded');
});

test('the log window can still reach it: open-error-window survives and routes through', () => {
  // renderer/renderer.js's error-stat click still sends this channel, so the handler stays.
  const rendererSrc = codeOf(fs.readFileSync(path.join(MENUBAR, 'renderer', 'renderer.js'), 'utf8'));
  assert.ok(/ipcRenderer\.send\(['"]open-error-window['"]\)/.test(rendererSrc),
    'guard: if the renderer stops sending this, the handler below can go too');
  assert.ok(/ipcMain\.on\(['"]open-error-window['"]/.test(src), 'the handler is still registered');
});

test('the legacy Sync Errors window is gone -- page, data pump and its two channels', () => {
  assert.strictEqual(fs.existsSync(path.join(MENUBAR, 'renderer', 'error.html')), false,
    'renderer/error.html is removed (nothing loads it any more)');
  for (const gone of ['error.html', 'errorWindow', 'sendErrorData', 'load-error-log',
    'error-log-loaded', 'clear-errors']) {
    assert.strictEqual(src.includes(gone), false, `main.js must no longer mention ${gone}`);
  }
});
