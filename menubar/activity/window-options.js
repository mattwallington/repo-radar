'use strict';
// Task 4.2 / Ruling P4-5: the Activity window's `webPreferences`, in ONE place.
//
// The app's legacy content windows -- `showLogWindow`, Settings -- run
// `nodeIntegration:true` with `contextIsolation:false`, because they load renderers that
// `require()` Node modules directly. The Activity window is the opposite posture: its renderer
// is untrusted-input-facing (it displays text produced by external tooling), so it runs fully
// context-isolated, with the sandbox on and no Node integration at all, and reaches main only
// through the four allowlisted channels of `renderer/activity-preload.js`.
//
// That posture lives here rather than as an object literal inside main.js for two reasons:
// main.js cannot be require()'d outside a running Electron process, so an inline literal could
// only ever be checked by grepping source; and a constant is the thing a future edit to the
// window (size, title, a new option) cannot accidentally weaken. main.js spreads it, and
// __tests__/activity-window-security.test.js asserts both the constant's exact contents and that
// `showActivityWindow` still uses it.
//
// `path` is the ONLY dependency -- this module is loaded by Electron-free unit tests.
const path = require('path');

// Frozen: nothing at runtime may flip one of these to the permissive value before the window is
// constructed. main.js spreads a copy into `webPreferences`, so Electron never receives (or
// mutates) the constant itself.
const ACTIVITY_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  // The DEDICATED preload, not the app's shared `preload.js`: it exposes exactly
  // `window.activityApi = { list, get, export, reveal }` and nothing else.
  preload: path.join(__dirname, '..', 'renderer', 'activity-preload.js'),
});

module.exports = { ACTIVITY_WEB_PREFERENCES };
