'use strict';
// Task 4.4: static wiring landmarks for the tray's "⚠️ View Errors" affordance in main.js.
// main.js cannot be require()'d outside a running Electron process (it destructures
// `{ app, Tray, ... }` off `require('electron')` and calls `app.requestSingleInstanceLock()` at
// module load), so this follows the established activity-ipc-wiring.test.js /
// model-notice-wiring.test.js / activity-window-security.test.js precedent: assert main.js still
// parses, and assert the wiring is actually present in the source. The BEHAVIOUR of the reader
// half is proven by activity/__tests__/view-errors-target.test.js.
//
// What must hold (Rulings P4-6 / P4-12):
//   * the menu item is gated on the MEMOIZED reader target, not on `status.hasErrors` -- an
//     empty-but-flagged status can no longer produce an affordance that opens nothing;
//   * clicking it opens the ACTIVITY window focused on that id;
//   * the legacy `showErrorWindow` entry point routes to the Activity window too, so the log
//     window's error-stat click (`open-error-window`) can never resurrect the old empty view;
//   * the memo is invalidated when a sync completes, so the menu built at completion is fresh.
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

test('main.js still parses', () => {
  execFileSync(process.execPath, ['--check', MAIN_JS], { stdio: 'pipe' });
});

test('the memo helper asks the reader, with configured secrets, and can never throw', () => {
  assert.ok(/require\(['"]\.\/activity\/read['"]\)/.test(src), "main.js must require('./activity/read')");
  const body = functionBody('_viewErrorsTarget');
  assert.ok(/activityRead\.viewErrorsTarget\(/.test(body), 'the helper delegates to the reader');
  assert.ok(/configuredSecrets/.test(body) && /loadConfiguredSecrets\(/.test(body),
    'redaction is defense-in-depth: the reader call is given the configured secrets');
  assert.ok(/Date\.now\(\)/.test(body), 'the memo is TTL-based');
  assert.ok(/try\s*\{/.test(body) && /catch/.test(body), 'a reader failure must degrade to null, never throw into the tray');
  assert.ok(/function _invalidateViewErrorsTarget\(/.test(src), 'there is an explicit invalidation seam');
});

test('the tray "View Errors" item is gated on the memoized target, not on status.hasErrors', () => {
  const body = functionBody('updateTrayMenu');
  const label = body.indexOf('View Errors');
  assert.notStrictEqual(label, -1, 'the tray still offers View Errors');

  assert.ok(/const viewErrorsId = _viewErrorsTarget\(\);/.test(body),
    'the item is built from the memoized reader target');
  assert.ok(/if \(viewErrorsId\) \{/.test(body), 'the item exists only when there is something to show');
  assert.ok(/click: \(\) => showActivityWindow\(viewErrorsId\)/.test(body),
    'the click deep-links the Activity window at that id');
  assert.strictEqual(/showErrorWindow/.test(body), false,
    'the tray no longer routes through the legacy error window');

  // `status.hasErrors` keeps driving the tray ICON and nothing else in this function.
  const hits = body.match(/status\.hasErrors/g) || [];
  assert.strictEqual(hits.length, 1, 'status.hasErrors survives only as the icon gate');
  assert.ok(body.indexOf('status.hasErrors') < body.indexOf('showErrorIcon()'),
    'the one surviving hasErrors read is the icon branch');

  // Evaluated only in the idle branch: the memo call comes after the `isSyncing()` split, on the
  // same side as "Sync Now". updateTrayMenu runs several times per progress event during a sync.
  assert.ok(body.indexOf('_viewErrorsTarget()') > body.indexOf("'▶ Sync Now'"),
    'the reader is never consulted while a sync is running');
  assert.strictEqual((body.match(/_viewErrorsTarget\(\)/g) || []).length, 1,
    'exactly one reader consultation per menu build');
});

test('showErrorWindow routes to the Activity window and creates no window of its own', () => {
  const body = functionBody('showErrorWindow');
  assert.ok(/showActivityWindow\(_viewErrorsTarget\(\)\)/.test(body),
    'the legacy entry point opens the Activity window at the memoized target');
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

test('the memo is invalidated when a sync completes', () => {
  const close = src.indexOf("currentSyncProcess.on('close'");
  assert.notStrictEqual(close, -1, 'the sync-completion path must still exist');
  const end = src.indexOf("currentSyncProcess.on('error'", close);
  assert.notStrictEqual(end, -1, 'the error handler follows the close handler');
  const body = src.slice(close, end);
  assert.ok(/_invalidateViewErrorsTarget\(\)/.test(body),
    'the completion path drops the memo so the menu it rebuilds is read fresh');
});
