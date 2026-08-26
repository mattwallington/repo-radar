'use strict';
// Task 4.2 / Ruling P4-5: the Activity window is the ONE content window in this app that runs
// context-isolated. Every other window (`showLogWindow`, `showErrorWindow`, Settings) still runs
// `nodeIntegration:true` / `contextIsolation:false`, so "just copy the neighbouring window" is
// exactly the mistake that would silently hand the Activity renderer a `require`.
//
// The preferences therefore live in ONE frozen constant (`activity/window-options.js`) that this
// file asserts exactly, plus a source-level check that main.js's `showActivityWindow` actually
// spreads that constant and re-introduces neither of the two dangerous values inside its body.
// The behavioural half can't be exercised here: main.js cannot be require()'d outside a running
// Electron process (it destructures `{ app, Tray, ... }` off `require('electron')` and calls
// `app.requestSingleInstanceLock()` at module load), the same reason
// __tests__/activity-ipc-wiring.test.js is a source-landmark test.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MENUBAR = path.join(__dirname, '..');
const MAIN_JS = path.join(MENUBAR, 'main.js');
const OPTIONS_JS = path.join(MENUBAR, 'activity', 'window-options.js');
const ACTIVITY_HTML = path.join(MENUBAR, 'renderer', 'activity.html');

const { ACTIVITY_WEB_PREFERENCES } = require(OPTIONS_JS);
const mainSrc = fs.readFileSync(MAIN_JS, 'utf8');

// Returns the source text of `function <name>(...) { ... }`, brace-matched from its opening `{`.
function functionBody(src, name) {
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

test('ACTIVITY_WEB_PREFERENCES is exactly the hardened set, and frozen', () => {
  assert.deepStrictEqual(Object.keys(ACTIVITY_WEB_PREFERENCES),
    ['contextIsolation', 'nodeIntegration', 'sandbox', 'preload']);
  assert.strictEqual(ACTIVITY_WEB_PREFERENCES.contextIsolation, true);
  assert.strictEqual(ACTIVITY_WEB_PREFERENCES.nodeIntegration, false);
  assert.strictEqual(ACTIVITY_WEB_PREFERENCES.sandbox, true);
  assert.ok(Object.isFrozen(ACTIVITY_WEB_PREFERENCES), 'the constant must not be mutable at runtime');
});

test('the preload is the dedicated Activity preload, by absolute path, and exists', () => {
  const preload = ACTIVITY_WEB_PREFERENCES.preload;
  assert.strictEqual(typeof preload, 'string');
  assert.ok(path.isAbsolute(preload), 'preload must be an absolute path');
  assert.ok(preload.endsWith(path.join('renderer', 'activity-preload.js')),
    `preload must be renderer/activity-preload.js, got ${preload}`);
  assert.ok(fs.existsSync(preload), 'the preload file must exist');
  // Never the app's SHARED preload -- that one is loaded by the nodeIntegration windows.
  assert.ok(!preload.endsWith(path.join('menubar', 'preload.js')));
});

test('window-options.js depends on nothing but path (it is loaded by Electron-free tests)', () => {
  const src = fs.readFileSync(OPTIONS_JS, 'utf8');
  const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(requires, ['path']);
});

test('main.js showActivityWindow uses ACTIVITY_WEB_PREFERENCES and nothing weaker', () => {
  assert.ok(/require\(['"]\.\/activity\/window-options['"]\)/.test(mainSrc),
    "main.js must require('./activity/window-options')");

  const body = functionBody(mainSrc, 'showActivityWindow');
  assert.ok(/ACTIVITY_WEB_PREFERENCES/.test(body),
    'showActivityWindow must build its webPreferences from the shared constant');
  assert.strictEqual(/nodeIntegration\s*:\s*true/.test(body), false,
    'showActivityWindow must never enable nodeIntegration');
  assert.strictEqual(/contextIsolation\s*:\s*false/.test(body), false,
    'showActivityWindow must never disable contextIsolation');
  assert.strictEqual(/sandbox\s*:\s*false/.test(body), false,
    'showActivityWindow must never disable the sandbox');
  assert.strictEqual(/preload\s*:/.test(body), false,
    'the preload comes from the constant, never from a second literal that could drift');
  assert.ok(/webviewTag/.test(body) === false, 'no webview tag');
});

test('main.js showActivityWindow loads its own HTML and carries focusId in the fragment (P4-8)', () => {
  const body = functionBody(mainSrc, 'showActivityWindow');
  assert.ok(/activity\.html/.test(body), 'the Activity window loads renderer/activity.html');
  assert.ok(/hash\s*:/.test(body), 'the optional focus id rides on loadFile({ hash })');
  assert.strictEqual((body.match(/new BrowserWindow\(/g) || []).length, 1,
    'exactly one window is created');
  // Task 4.2 owns only this function: the legacy windows keep their own (weak) preferences and
  // the tray menu belongs to Task 4.5.
  assert.ok(/activityWindow/.test(body), 'the window is tracked so a reopen focuses it');
});

test('main.js still keeps the Activity window separate from the legacy log window', () => {
  const activityBody = functionBody(mainSrc, 'showActivityWindow');
  assert.strictEqual(/logWindow/.test(activityBody), false,
    'showActivityWindow must not reuse the nodeIntegration log window');
  assert.strictEqual(/errorWindow/.test(activityBody), false,
    'showActivityWindow must not reuse the nodeIntegration error window');
});

test('renderer/activity.html carries a strict CSP and loads its script from a file', () => {
  const html = fs.readFileSync(ACTIVITY_HTML, 'utf8');
  const csp = /<meta[^>]*http-equiv="Content-Security-Policy"[^>]*content="([^"]+)"/i.exec(html);
  assert.ok(csp, 'activity.html must declare a Content-Security-Policy meta');
  const policy = csp[1];
  assert.ok(/default-src\s+'none'/.test(policy), "default-src must be 'none'");
  assert.ok(/script-src\s+'self'/.test(policy), "script-src must be 'self'");
  assert.strictEqual(/unsafe-eval/.test(policy), false, 'no unsafe-eval');
  assert.strictEqual(/unsafe-inline/.test(policy.replace(/style-src[^;]*/g, '')), false,
    "'unsafe-inline' is allowed for style-src only");
  assert.strictEqual(/https?:/.test(policy), false, 'no remote origin may be allowed');

  assert.ok(/<script\s+src=["']activity\.js["']\s*><\/script>/.test(html),
    'the renderer is loaded from a file, never inlined');
  assert.strictEqual(/<script(?![^>]*\ssrc=)/i.test(html), false, 'no inline script block');
  assert.strictEqual(/\son[a-z]+=/i.test(html), false, 'no inline event-handler attributes');
  assert.strictEqual(/https?:\/\//.test(html), false, 'no remote asset may be referenced');
});
