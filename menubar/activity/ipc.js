'use strict';
// Task 4.1: the main-side Activity IPC surface -- the ONLY door between the Activity renderer and
// this subsystem. Everything the window can ever ask for goes through the four channels below;
// nothing else is registered, so the renderer has no reach into the filesystem, no un-redacted
// text, and no unbounded payload.
//
// Ruling P4-2: this module is Electron-free at module load (no `require('electron')` anywhere --
// under plain `node --test` that require resolves to the Electron BINARY PATH STRING, or fails
// outright when devDependencies aren't installed). `shell`, `dialog` and `writeFile` therefore
// arrive by injection from main.js, which is the only file that touches Electron. That keeps the
// whole boundary unit-testable in plain Node (activity/__tests__/ipc.test.js).
//
// Four invariants this file exists to hold:
//   1. REJECT, never clamp. A filter or activity id that violates limits.js is a caller bug; it
//      comes back as an error, not as a quietly-corrected request (a clamped `limit` would train
//      the renderer to send whatever it likes).
//   2. No unvalidated text ever reaches a filesystem path. `activity:reveal` validates the id at
//      this boundary BEFORE `paths.activityDir` is called (which validates again, independently).
//   3. Bounded, generic errors. Renderer-supplied values are never echoed back, and no stack
//      frame or absolute path crosses the bridge -- Electron serializes a thrown handler error's
//      STACK as well as its message, so `ActivityIpcError` replaces its own stack with the
//      bounded text.
//   4. Redaction is wired, not merely available: every read runs through the Redactor built from
//      the app's configured secrets (Ruling P4-3), on top of redact.js's built-in patterns.
const fs = require('fs');
const read = require('./read'); // referenced as `read.listActivities` (etc) at call time, never
// destructured, so a test can inject a failing reader by monkeypatching the module export -- the
// same seam convention read.js/quota.js use for their own dependencies.
const ids = require('./ids');
const paths = require('./paths');
const triggerGlue = require('./trigger-glue');

// The allowlist. `register` wires exactly these and nothing else, and the dedicated preload
// (renderer/activity-preload.js) exposes exactly one method per entry, in this order.
const CHANNELS = Object.freeze([
  'activity:list',
  'activity:get',
  'activity:export',
  'activity:reveal',
]);

// The error codes this module can produce. Their messages (see `_guard`) are fixed constants
// rather than the underlying error's text: read.js's InvalidFilter messages quote the offending
// value (`invalid level: "trace"`), which would echo renderer-supplied text straight back across
// the bridge, and an unexpected error's message routinely carries absolute paths.
//
// NOTE (Ruling P4-7): the renderer never BRANCHES on any of these -- Electron's error
// serialization may not even preserve `code`. They exist for the main side's own bookkeeping:
// which rejections get logged, and which are ordinary conditions rather than failures.
const INVALID_REQUEST = 'invalid-request';
const INTERNAL = 'internal';
// The requested activity is not on disk any more -- retention pruned it between the list render
// and the click. An ordinary outcome, not an internal failure: not logged.
const NOT_FOUND = 'not-found';

class ActivityIpcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ActivityIpcError';
    this.code = code;
    // Electron serializes a rejected handler's stack across the bridge, so a real stack would
    // hand the renderer main-process file paths. Replace it with the bounded text itself.
    this.stack = `${this.name}: ${this.message}`;
  }
}

// -------------------------------------------------------------------------------------------
// Validation at the boundary
// -------------------------------------------------------------------------------------------

// read.validateFilter owns every bound in limits.js. The one thing it does not know about is the
// `system` diagnostics flag (Ruling P4-1), which rides on `activity:list` rather than earning a
// fifth channel: validated here as a strict boolean, then passed through untouched (Task 4.3
// attaches the diagnostics themselves).
function _validateFilter(filter) {
  read.validateFilter(filter);
  if (filter && filter.system !== undefined && typeof filter.system !== 'boolean') {
    throw new read.InvalidFilter('system must be a boolean');
  }
}

// Boundary check for the two id-taking channels. read.getActivity and paths.activityDir each
// validate again on their own -- this one exists so an unsafe id is refused BEFORE any code that
// could build a path from it runs at all.
function _validateId(activityId) {
  if (!ids.validActivityId(activityId)) {
    throw new read.InvalidActivityId('invalid activity id');
  }
}

// The main-side record of an `internal` failure. The renderer deliberately gets a stack-stripped
// generic error, and Electron's ipcMain.handle only ever console.errors the error it was THROWN --
// i.e. the generic one -- so without this the root cause of an internal failure (an EACCES on the
// user's chosen export path, a corrupt segment escaping read.js's containment) would leave no
// trace anywhere in the app. The original is logged here, on the main side only, bounded so a
// pathological error text can't flood the log. Never attached as `cause`: that would ride along
// on Electron's error serialization and undo the whole point of the generic message.
const LOG_MAX_CHARS = 4000;

function _logInternal(log, channel, e) {
  try {
    const detail = String((e && e.stack) || e);
    const suffix = detail.length > LOG_MAX_CHARS ? ' …[truncated]' : '';
    log(`[activity] ${channel} failed: ${detail.slice(0, LOG_MAX_CHARS)}${suffix}`);
  } catch (_) {
    // A failing logger must never turn an internal failure into a different one.
  }
}

// Wraps a handler so every rejection leaving this module is an ActivityIpcError: caller-input
// failures (InvalidFilter, and its InvalidActivityId subclass) as `invalid-request`, anything
// else as `internal` -- the latter recorded on the main side first.
//
// Neither `invalid-request` nor an error a handler RAISED ITSELF is logged. The first is fully
// attributable renderer input, the UI surfaces it immediately, and read.js's InvalidFilter
// messages quote the offending value -- which would drop renderer-supplied text (a `search`
// string the user typed) into the shared diagnostic stream Task 4.3 puts back on screen. The
// second is already bounded and already deliberate (`not-found`), so it passes through untouched
// rather than being flattened into `internal` and written to the log as if something broke.
function _guard(channel, log, fn) {
  return async (arg) => {
    try {
      return await fn(arg);
    } catch (e) {
      if (e instanceof ActivityIpcError) throw e;
      if (e instanceof read.InvalidFilter) {
        throw new ActivityIpcError(INVALID_REQUEST, 'invalid activity request');
      }
      _logInternal(log, channel, e);
      throw new ActivityIpcError(INTERNAL, 'the activity request could not be completed');
    }
  };
}

function _exportFileName() {
  // A bare filename, not a path: the save dialog resolves it against its own default directory,
  // and the only path this module ever writes to is the one the USER picks there.
  return `repo-radar-activity-${new Date().toISOString().slice(0, 10)}.txt`;
}

// -------------------------------------------------------------------------------------------
// Handlers
// -------------------------------------------------------------------------------------------

// Builds the four channel handlers as plain `fn(arg)` functions -- no Electron, no `event`
// argument, nothing IPC-specific -- so they can be exercised directly in tests and wired to
// ipcMain by `register` below.
//
//   home                  the user's home directory (main.js passes process.env.HOME)
//   loadConfiguredSecrets () -> string[]: the app's configured secret VALUES, re-read per call so
//                         a token saved in Settings starts being masked immediately
//   shell                 Electron's shell (activity:reveal only)
//   dialog                Electron's dialog (activity:export only)
//   writeFile             fs.writeFileSync by default (activity:export only)
//   log                   main-side sink for the ORIGINAL error behind an `internal` rejection;
//                         console.error by default, matching main.js's own logging
function createHandlers({
  home,
  loadConfiguredSecrets = triggerGlue.loadConfiguredSecrets,
  shell,
  dialog,
  writeFile = fs.writeFileSync,
  log = console.error,
} = {}) {
  if (typeof home !== 'string' || home.length === 0) {
    throw new TypeError('createHandlers requires a home directory path');
  }

  const secrets = () => loadConfiguredSecrets(home);
  const guard = (channel, fn) => _guard(channel, log, fn);

  return {
    // filter -> { items, truncated, available, incomplete, problems }. Summary DTOs only, at most
    // limits.LIST_MAX of them, each already redacted and bounded by read.js.
    //
    // Ruling P4-1: `filter.system === true` additionally attaches `system` -- the bounded,
    // redacted, UNCORRELATED shared-stream + legacy-status diagnostics (Task 4.3). It rides here
    // rather than on a fifth channel because the renderer asks for it as part of the same view
    // refresh, and one channel is one thing to keep allowlisted. Absent or `false` means the
    // response has no `system` key at all -- the diagnostics are read only when asked for, so an
    // ordinary list refresh never touches the shared log files. The SAME secrets object feeds
    // both reads, so the two halves can never disagree about what is masked.
    'activity:list': guard('activity:list', async (filter) => {
      _validateFilter(filter);
      const configuredSecrets = secrets();
      const result = read.listActivities(home, filter, { configuredSecrets });
      if (filter && filter.system === true) {
        result.system = read.systemDiagnostics(home, { configuredSecrets });
      }
      return result;
    }),

    // activity id -> { item, available, reason? }. One detail item (Events + Problems lenses),
    // never larger than limits.DETAIL_MAX_BYTES.
    'activity:get': guard('activity:get', async (activityId) => {
      _validateId(activityId);
      return read.getActivity(home, activityId, { configuredSecrets: secrets() });
    }),

    // filter -> the saved path, or null if the user cancelled. The export TEXT is built here in
    // main (already redacted and byte-capped by read.buildExport); the renderer never sees it,
    // and never supplies the destination -- that comes from the OS save dialog.
    'activity:export': guard('activity:export', async (filter) => {
      _validateFilter(filter);
      const text = read.buildExport(home, filter, { configuredSecrets: secrets() });
      const result = await dialog.showSaveDialog({
        title: 'Export Activity History',
        defaultPath: _exportFileName(),
        filters: [{ name: 'Text', extensions: ['txt'] }],
      });
      if (!result || result.canceled || !result.filePath) return null;
      writeFile(result.filePath, text, { encoding: 'utf8', mode: 0o600 });
      return result.filePath;
    }),

    // activity id -> true once the reveal has been dispatched. The path is built ONLY by
    // paths.activityDir from an already-validated id, so it is always the activity's own
    // directory under the owned activity/ root and can never be renderer-controlled.
    //
    // The directory is confirmed to BE one before the shell is asked. Two reasons:
    //   1. Retention can prune the activity between the list render and the click, and
    //      `shell.showItemInFinder` on a path that is not there is a silent no-op on macOS -- the
    //      user would press Reveal, get no Finder window and no message, and have no way to tell
    //      whether the app was broken or the activity was gone. `not-found` gives the renderer
    //      something to say (it shows its own fixed line; it never reads this code -- P4-7).
    //   2. `lstat`, never `stat`: a symlink or a plain file sitting at an activity-shaped path is
    //      treated as not-found and never revealed, the same refusal read.js makes when it
    //      enumerates the root. Any lstat failure at all (ENOENT, EACCES on the parent) is
    //      not-found too -- it is not a claim about WHY, only that there is nothing to show.
    'activity:reveal': guard('activity:reveal', async (activityId) => {
      _validateId(activityId);
      const dir = paths.activityDir(home, activityId);
      let stat = null;
      try {
        stat = fs.lstatSync(dir);
      } catch (e) {
        stat = null;
      }
      if (!stat || !stat.isDirectory()) {
        throw new ActivityIpcError(NOT_FOUND, 'that activity is no longer on disk');
      }
      shell.showItemInFinder(dir);
      return true;
    }),
  };
}

// Wires the handlers onto ipcMain -- exactly the four allowlisted channels, in CHANNELS order,
// iterating the ALLOWLIST rather than the handlers object so an extra key can never be
// registered. The wrapper drops Electron's `event` argument: no handler may ever see (or be
// tempted to trust) the sender.
function register(ipcMain, handlers) {
  for (const channel of CHANNELS) {
    const handler = handlers ? handlers[channel] : undefined;
    if (typeof handler !== 'function') {
      throw new TypeError(`register: missing handler for ${channel}`);
    }
    ipcMain.handle(channel, (event, arg) => handler(arg));
  }
}

module.exports = { CHANNELS, ActivityIpcError, createHandlers, register };
