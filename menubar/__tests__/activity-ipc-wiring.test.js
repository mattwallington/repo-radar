'use strict';
// Task 4.1: static wiring landmarks for the Activity IPC registration in main.js. main.js can't
// be require()'d outside a running Electron process (it destructures `{ app, Tray, ... }` off
// `require('electron')` and calls `app.requestSingleInstanceLock()` at module load), so this
// mirrors the existing model-notice-wiring.test.js / main-runtime-wiring.test.js precedent: check
// that main.js still parses and that the registration is actually present in the source. The
// BEHAVIOUR of every handler is proven by activity/__tests__/ipc.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const mainJsPath = path.join(__dirname, '..', 'main.js');
const src = fs.readFileSync(mainJsPath, 'utf8');

test('main.js parses and registers the Activity IPC handlers exactly once', () => {
  execFileSync(process.execPath, ['--check', mainJsPath], { stdio: 'pipe' });

  assert.ok(/require\(['"]\.\/activity\/ipc['"]\)/.test(src), "main.js must require('./activity/ipc')");
  assert.ok(/\bshell\b/.test(src.split('\n')[0]), 'main.js must destructure `shell` off electron for activity:reveal');
  assert.strictEqual((src.match(/activityIpc\.createHandlers\(/g) || []).length, 1,
    'handlers are built exactly once');
  assert.strictEqual((src.match(/activityIpc\.register\(\s*ipcMain/g) || []).length, 1,
    'register(ipcMain, handlers) is called exactly once');
  // The real Electron seams and the real HOME must be the injected ones.
  const build = src.slice(src.indexOf('activityIpc.createHandlers('));
  const call = build.slice(0, build.indexOf(')') + 1);
  for (const key of ['home', 'shell', 'dialog']) {
    assert.ok(new RegExp(`\\b${key}\\b`).test(call), `createHandlers must be given ${key}`);
  }
});

test('main.js never names an activity IPC channel itself', () => {
  assert.strictEqual(src.match(/['"]activity:[a-z]+['"]/g), null,
    'the four channel strings live only in activity/ipc.js -- main.js registers them via register()');
});
