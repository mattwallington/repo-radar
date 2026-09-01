'use strict';
// Ruling P6-1: when the root exec lock refuses a manual sync, the progress window that this very
// attempt just opened must be TOLD. Before this fix the LockBusy branch fired a Notification,
// recorded the contention, and returned -- leaving the window it had already opened stuck on
// "Starting sync..." with every repo row reading "Waiting..." forever (hit in production at 13:19
// on 2026-09-01, right after an auto-update: the old instance's shutdown still held the lock).
//
// This is the same class of bug Ruling P4-21 fixed for the runtime-disabled guard by moving it
// ABOVE showLogWindow(). Contention cannot move: the lock is only attempted inside runSync(), long
// after the window exists. So the window has to be told instead.
//
// main.js cannot be require()'d outside a running Electron process (it destructures
// `{ app, Tray, ... }` off `require('electron')` and calls `app.requestSingleInstanceLock()` at
// module load), so this follows the established view-errors-wiring.test.js /
// activity-ipc-wiring.test.js precedent: assert main.js still parses, and assert the wiring is
// present in the source. The DOM half's BEHAVIOUR is proven by sync-refused-dom.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MENUBAR = path.join(__dirname, '..');
const MAIN_JS = path.join(MENUBAR, 'main.js');
const RENDERER_JS = path.join(MENUBAR, 'renderer', 'renderer.js');
const INDEX_HTML = path.join(MENUBAR, 'renderer', 'index.html');

// Every assertion below is about CODE, and both files document this hunk in prose right next to
// it -- so comment lines are dropped first (line-based, so a `//` inside a string is untouched).
function codeOf(text) {
  return text.split('\n')
    .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
    .join('\n');
}

const src = codeOf(fs.readFileSync(MAIN_JS, 'utf8'));
const rendererSrc = codeOf(fs.readFileSync(RENDERER_JS, 'utf8'));

// The source between two anchors, both of which must be unique.
function between(startAnchor, endAnchor, text = src) {
  const a = text.indexOf(startAnchor);
  assert.notStrictEqual(a, -1, `anchor not found: ${startAnchor}`);
  assert.strictEqual(text.indexOf(startAnchor, a + 1), -1, `anchor is not unique: ${startAnchor}`);
  const b = text.indexOf(endAnchor, a + startAnchor.length);
  assert.notStrictEqual(b, -1, `end anchor not found after ${startAnchor}: ${endAnchor}`);
  return text.slice(a, b);
}

// Asserts `markers` appear in the given order inside `slice`, each exactly once.
function inOrder(slice, markers, label) {
  let last = -1;
  markers.forEach((marker, i) => {
    const at = slice.indexOf(marker);
    assert.notStrictEqual(at, -1, `${label}: missing ${marker}`);
    assert.strictEqual(slice.indexOf(marker, at + 1), -1, `${label}: ${marker} appears more than once`);
    assert.ok(at > last, `${label}: ${marker} must come after ${markers[i - 1]}`);
    last = at;
  });
}

test('main.js still parses', () => {
  execFileSync(process.execPath, ['--check', MAIN_JS], { stdio: 'pipe' });
});

test('renderer.js still parses', () => {
  execFileSync(process.execPath, ['--check', RENDERER_JS], { stdio: 'pipe' });
});

test('the LockBusy branch tells the progress window it was refused', () => {
  // The catch's LockBusy arm, from its `e.code === 75` test to its own `return`.
  const branch = between('if (e && e.code === 75) {', "activityGlue.onContention(activity.writer, 'root-busy');");

  assert.ok(/refuseProgressWindow\('already-running'\)/.test(branch),
    'the LockBusy branch must refuse the progress window it already opened, with its own reason');

  // The two existing effects are untouched -- this fix ADDS a third.
  assert.ok(/Notification\.isSupported\(\)/.test(branch), 'the macOS Notification stays');
  assert.ok(/A sync is already running\./.test(branch), 'the Notification body stays');
});

test("runSync's OTHER rejection arm hangs the same window, and refuses it too", () => {
  // verifyRuntime failed, or venv/python resolution did: no child, no progress event ever, and
  // the errorLog + tray work in this arm is invisible from inside the progress window.
  const arm = between("console.error('runSync failed to start sync:', e);", 'function showLogWindow(');

  assert.ok(/refuseProgressWindow\('failed-to-start'\)/.test(arm),
    "the failure arm must refuse the window it left on 'Starting sync...'");
  assert.strictEqual(/refuseProgressWindow\([^)]*e\.message/.test(arm), false,
    'the error text must never cross the bridge -- the reason is a bare selector');

  // UI first is fine; the existing terminal -> refresh -> rebuild ordering must survive intact.
  inOrder(arm, [
    "refuseProgressWindow('failed-to-start')",
    "activity.writer.terminal('failed')",
    '_refreshViewErrorsTarget()',
    'updateTrayMenu()',
  ], 'the failure arm');
});

test('the refusal is gated on this attempt having opened the window, and its payload is a bare reason', () => {
  // The slice must END at the sender, or every assertion below can pass from sendSyncStartedWhenReady's
  // near-identical body next door (round-2 review finding: deleting the helper's own
  // destroyed-window guard left this test green).
  // (comment lines are stripped from `src`, so the end anchor is the sender's own declaration)
  const helper = between('const refuseProgressWindow = (reason) => {', 'const sendSyncStartedWhenReady');
  assert.strictEqual(/sendSyncStartedWhenReady/.test(helper), false,
    'guard: the slice must not bleed into the sync-started sender');

  assert.ok(/if \(!showWindow\) return;/.test(helper),
    'a scheduled sync (showWindow=false) opened no window -- there is nothing to refuse');
  assert.ok(/!attemptWindow \|\| logWindow !== attemptWindow/.test(helper),
    'the refusal is bound to the window THIS attempt opened, not to whatever logWindow is now');
  assert.ok(/attemptWindow\.isDestroyed\(\)/.test(helper), 'never send into a destroyed window');
  assert.ok(/attemptWindow\.webContents\.send\('sync-refused', \{ reason \}\)/.test(helper),
    'the payload carries the caller-chosen reason and nothing else -- no error text, nothing user-derived');
  assert.ok(/attemptWindow\.webContents\.isLoading\(\)/.test(helper),
    'a window still loading would drop the send -- wait for it, like sendSyncStartedWhenReady does');
  assert.ok(/syncRefusedForThisAttempt = true;/.test(helper),
    'the refusal must latch, so a pending sync-started can be short-circuited');
  assert.ok(/pendingFreshSync = false;/.test(helper),
    'the fresh-sync replay skip no longer applies once the attempt is refused');
});

test("the attempt's window is captured where it is opened", () => {
  const opener = between('if (showWindow) {\n    pendingFreshSync = true;', 'let syncRefusedForThisAttempt');
  assert.ok(/showLogWindow\(\);/.test(opener) && /attemptWindow = logWindow;/.test(opener),
    'attemptWindow is captured right after showLogWindow(), inside the showWindow branch');
  assert.ok(opener.indexOf('showLogWindow()') < opener.indexOf('attemptWindow = logWindow;'),
    'captured AFTER the window exists');

  const trigger = between('function triggerSync(', 'function showLogWindow(');
  assert.ok(/let attemptWindow = null;/.test(trigger), 'it is a per-attempt local');
  assert.strictEqual(/^let attemptWindow/m.test(src.slice(0, src.indexOf('function triggerSync('))), false,
    'the captured window must not be module state');
});

test('a refused attempt can never have a late sync-started painted over it', () => {
  const sender = between('const sendSyncStartedWhenReady = () => {', 'setTimeout(sendSyncStartedWhenReady, 300);');

  const guardAt = sender.indexOf('if (syncRefusedForThisAttempt)');
  assert.notStrictEqual(guardAt, -1, 'the sender must check the refusal latch');
  assert.ok(guardAt < sender.indexOf("logWindow.webContents.send('sync-started'"),
    'the latch is checked BEFORE the sync-started send -- the 300ms timer and the 100ms isLoading ' +
    'poll both re-enter here, and either could otherwise repaint the waiting grid over the refusal');

  // The latch is declared per-attempt (a closure variable of triggerSync), not module state --
  // two windows/attempts must never share it.
  const trigger = between('function triggerSync(', 'function showLogWindow(');
  assert.ok(/let syncRefusedForThisAttempt = false;/.test(trigger),
    'the latch is a per-attempt local, reset on every triggerSync call');
  assert.strictEqual(/^let syncRefusedForThisAttempt/m.test(src.slice(0, src.indexOf('function triggerSync('))), false,
    'the latch must not be module state');
});

test('the already-syncing guard returns before any window is opened, so it sends nothing', () => {
  // It sits at the very top of triggerSync, above the reset and above showLogWindow(): this
  // attempt opened no window, and any window that IS up is showing the LIVE sync's real progress.
  // Refusing it would wipe a running sync's grid.
  const guard = between("activityGlue.onContention(activity.writer, 'already-syncing');", "if (runtimeChannel === 'dev') {");
  assert.strictEqual(/sync-refused|refuseProgressWindow/.test(guard), false,
    'the already-syncing guard must NOT refuse a window it never opened');
  assert.ok(/return;/.test(guard), 'it returns');

  const trigger = between('function triggerSync(', 'function showLogWindow(');
  assert.ok(trigger.indexOf("'already-syncing'") < trigger.indexOf('showLogWindow()'),
    'the guard returns above showLogWindow() -- this attempt opened no window');
  assert.ok(trigger.indexOf("'already-syncing'") < trigger.indexOf('const refuseProgressWindow'),
    'and above refuseProgressWindow, which does not exist yet at that point');
});

test('the legacy progress renderer listens for sync-refused, in its existing ipcRenderer style', () => {
  // This window runs nodeIntegration:true / contextIsolation:false and renderer.js talks to
  // ipcRenderer directly (preload.js's `electronAPI` bridge exists but this file never uses it),
  // so the new listener is registered the same way as sync-complete / terminal-output.
  assert.ok(/ipcRenderer\.on\('sync-refused', \(event, data\) => \{/.test(rendererSrc),
    "renderer.js must register an ipcRenderer 'sync-refused' listener");

  const handler = between("ipcRenderer.on('sync-refused', (event, data) => {", "ipcRenderer.on('version-info'", rendererSrc);
  assert.ok(/applySyncRefused\(document, data && data\.reason\)/.test(handler),
    'the listener hands the bare reason to the pure DOM function (mapping proven by sync-refused-dom.test.js)');
  assert.strictEqual(/textContent|log\([^)]*reason/.test(handler), false,
    'the reason is a selector, never text: the handler neither renders nor logs it');
  assert.strictEqual(/innerHTML|outerHTML|insertAdjacentHTML/.test(handler), false,
    'no markup sink on the refusal path');
});

test('index.html loads the refusal module before renderer.js', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const refused = html.indexOf('src="sync-refused.js"');
  const renderer = html.indexOf('src="renderer.js"');
  assert.notStrictEqual(refused, -1, 'index.html must load sync-refused.js');
  assert.ok(refused < renderer, 'sync-refused.js must be loaded before renderer.js uses it');
});
