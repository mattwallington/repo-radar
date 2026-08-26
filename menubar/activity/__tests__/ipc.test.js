'use strict';
// Task 4.1: the main-side Activity IPC surface (`activity/ipc.js`). These tests run under plain
// `node --test` with NO Electron present -- that is the point of Ruling P4-2: `ipc.js` must be
// Electron-free at module load and take `shell`/`dialog`/`writeFile` by injection, so the whole
// boundary is testable here rather than only inside a packaged app.
//
// Seeding style mirrors read.test.js (raw JSONL written straight onto segment paths via paths.js,
// bypassing writer.js/records.buildRecord) since these tests exercise the READ side only. Every
// tmp dir is prefixed `rr-ipc-` and removed in a `finally`, per the repo's tmp-dir policy.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../index');
const read = require('../read');
const paths = require('../paths');
const limits = require('../limits');
const ipc = require('../ipc');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-ipc-'));
}

function cleanup(home) {
  fs.rmSync(home, { recursive: true, force: true });
}

// --- minimal valid v1 records (same shapes as read.test.js) --------------------------------
function startRec(aid, seq, ts, over = {}) {
  return {
    schema_version: 1, activity_id: aid, type: 'start', seq, ts,
    kind: 'sync', channel: 'stable', trigger: 'cli', created_by: 'python', ...over,
  };
}
function eventRec(aid, seq, ts, level, name, over = {}) {
  return {
    schema_version: 1, activity_id: aid, type: 'event', seq, ts,
    level, event: name, fields: {}, ...over,
  };
}
function terminalRec(aid, seq, ts, outcome, over = {}) {
  return {
    schema_version: 1, activity_id: aid, type: 'terminal', seq, ts,
    outcome, summary: {}, by: 'deadbeef', ...over,
  };
}

function seedSegment(home, aid, records, producer = 'python', writerId = 'deadbeef') {
  A.secureMkdir(A.activityDir(home, aid));
  const text = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(A.segmentPath(home, aid, producer, writerId), text);
}

const AID = '00000000-0000-4000-8000-00000000000a';

// One complete, unremarkable activity.
function seedOne(home, aid = AID, over = {}) {
  seedSegment(home, aid, [
    startRec(aid, 0, '2026-08-10T00:00:00-07:00', over),
    eventRec(aid, 1, '2026-08-10T00:00:01-07:00', 'info', 'repo.synced', { detail: 'ok' }),
    eventRec(aid, 2, '2026-08-10T00:00:02-07:00', 'warn', 'repo.degraded'),
    terminalRec(aid, 3, '2026-08-10T00:05:00-07:00', 'succeeded-with-warnings'),
  ]);
  return aid;
}

// Handlers wired to recording fakes for the three injected Electron/fs seams.
function makeHandlers(home, over = {}) {
  const calls = { revealed: [], dialogs: [], writes: [], logs: [] };
  const chosen = path.join(home, 'activity-export.txt');
  const handlers = ipc.createHandlers({
    home,
    shell: { showItemInFinder: (p) => { calls.revealed.push(p); } },
    dialog: {
      showSaveDialog: async (opts) => { calls.dialogs.push(opts); return { canceled: false, filePath: chosen }; },
    },
    writeFile: (p, data, opts) => { calls.writes.push({ path: p, data, opts }); },
    log: (line) => { calls.logs.push(line); },
    ...over,
  });
  return { handlers, calls, chosen };
}

async function rejects(fn, code, label) {
  let err = null;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, `${label}: expected a rejection`);
  assert.ok(err instanceof ipc.ActivityIpcError, `${label}: expected ActivityIpcError, got ${err && err.name}`);
  assert.strictEqual(err.code, code, `${label}: wrong error code`);
  return err;
}

// -----------------------------------------------------------------------------------------------
// 1. Shape of the surface itself.
// -----------------------------------------------------------------------------------------------
test('createHandlers exposes exactly the four allowlisted channels', () => {
  const home = tmpHome();
  try {
    const { handlers } = makeHandlers(home);
    assert.deepStrictEqual(Object.keys(handlers).sort(),
      ['activity:export', 'activity:get', 'activity:list', 'activity:reveal']);
    assert.deepStrictEqual([...ipc.CHANNELS].sort(),
      ['activity:export', 'activity:get', 'activity:list', 'activity:reveal']);
    assert.ok(Object.isFrozen(ipc.CHANNELS), 'CHANNELS must be frozen');
    for (const ch of ipc.CHANNELS) assert.strictEqual(typeof handlers[ch], 'function', `${ch} handler`);
  } finally {
    cleanup(home);
  }
});

test('ipc.js is Electron-free at module load', () => {
  // Requiring this file at the top of this test already proves it loads without Electron; the
  // source check below keeps it that way in a dev checkout where `require('electron')` WOULD
  // resolve (to the binary path string) instead of failing loudly. Line comments are stripped
  // first so prose about the rule can't be mistaken for the rule being broken.
  const src = fs.readFileSync(path.join(__dirname, '..', 'ipc.js'), 'utf8')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.ok(!/require\(\s*['"]electron['"]\s*\)/.test(src),
    'ipc.js must never require("electron") -- shell/dialog arrive by injection (Ruling P4-2)');
});

// -----------------------------------------------------------------------------------------------
// 2. activity:list -- bounded, redacted summaries; reject-not-clamp on a malformed filter.
// -----------------------------------------------------------------------------------------------
test('activity:list returns bounded summary DTOs with no lens arrays', async () => {
  const home = tmpHome();
  try {
    seedOne(home);
    const { handlers } = makeHandlers(home);
    const res = await handlers['activity:list']({});

    assert.strictEqual(res.available, true);
    assert.strictEqual(res.truncated, false);
    assert.strictEqual(res.incomplete, false);
    assert.strictEqual(res.items.length, 1);
    const item = res.items[0];
    assert.strictEqual(item.id, AID);
    assert.strictEqual(item.outcome, 'succeeded-with-warnings');
    assert.strictEqual(item.warnCount, 1);
    // Summaries carry no lens arrays and stay under the summary byte cap.
    assert.strictEqual(item.events, undefined);
    assert.strictEqual(item.problems, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(item), 'utf8') <= limits.SUMMARY_MAX_BYTES);
  } finally {
    cleanup(home);
  }
});

test('activity:list rejects a malformed filter instead of clamping it', async () => {
  const home = tmpHome();
  try {
    seedOne(home);
    const { handlers } = makeHandlers(home);
    const list = handlers['activity:list'];

    await rejects(() => list({ level: 'trace' }), 'invalid-request', 'bad level');
    await rejects(() => list({ limit: limits.LIST_MAX + 1 }), 'invalid-request', 'limit over LIST_MAX');
    await rejects(() => list({ limit: -1 }), 'invalid-request', 'negative limit');
    await rejects(() => list({ search: 'x'.repeat(limits.SEARCH_MAX + 1) }), 'invalid-request', 'search too long');
    await rejects(() => list({ offset: 1.5 }), 'invalid-request', 'fractional offset');
    await rejects(() => list([]), 'invalid-request', 'array filter');
    await rejects(() => list(null), 'invalid-request', 'null filter');
    await rejects(() => list({ system: 'yes' }), 'invalid-request', 'non-boolean system flag');
    await rejects(() => list({ system: 1 }), 'invalid-request', 'numeric system flag');
  } finally {
    cleanup(home);
  }
});

test('activity:list accepts the validated boolean system flag and passes the filter through', async () => {
  const home = tmpHome();
  const orig = read.listActivities;
  let seen = null;
  try {
    seedOne(home);
    const { handlers } = makeHandlers(home);

    assert.strictEqual((await handlers['activity:list']({ system: true })).items.length, 1);
    assert.strictEqual((await handlers['activity:list']({ system: false })).items.length, 1);
    assert.strictEqual((await handlers['activity:list']()).items.length, 1, 'an omitted filter is valid');

    read.listActivities = (h, filter) => { seen = filter; return { items: [], truncated: false, available: true, incomplete: false, problems: [] }; };
    await handlers['activity:list']({ system: true, level: 'warn', limit: 5 });
    assert.deepStrictEqual(seen, { system: true, level: 'warn', limit: 5 },
      'the validated filter (system flag included) must reach the reader unchanged');
  } finally {
    read.listActivities = orig;
    cleanup(home);
  }
});

test('search is a literal substring match, never compiled as a regex', async () => {
  const home = tmpHome();
  try {
    const aid = AID;
    seedSegment(home, aid, [
      startRec(aid, 0, '2026-08-10T00:00:00-07:00'),
      eventRec(aid, 1, '2026-08-10T00:00:01-07:00', 'info', 'repo.synced'),
      eventRec(aid, 2, '2026-08-10T00:00:02-07:00', 'info', 'reposynced'),
      terminalRec(aid, 3, '2026-08-10T00:05:00-07:00', 'succeeded'),
    ]);

    // `activity:export` is the filter-carrying channel whose OUTPUT shows which event rows
    // survived the filter, so it is where the literal-match contract is observable end to end.
    const exportWith = async (search) => {
      const { handlers, calls } = makeHandlers(home);
      await handlers['activity:export'](search === undefined ? {} : { search });
      return calls.writes[0].data;
    };

    const literal = await exportWith('repo.synced');
    assert.ok(literal.includes('repo.synced'), 'the literally-matching event survives');
    assert.ok(!literal.includes('INFO reposynced'),
      '`.` must be an ordinary character -- a regex would also have matched "reposynced"');

    const wildcard = await exportWith('.*');
    assert.ok(!wildcard.includes('INFO repo.synced') && !wildcard.includes('INFO reposynced'),
      '`.*` matches nothing literally -- a compiled regex would have matched every row');

    // Other metacharacters are accepted as ordinary characters, never rejected, never compiled
    // (an unbalanced `(`/`[` would throw if it were ever handed to the RegExp constructor).
    for (const search of ['(unclosed[', '\\', '$^|?+{2}']) {
      const text = await exportWith(search);
      assert.ok(text.startsWith('Repo Radar Activity Export'), `search ${JSON.stringify(search)} is accepted`);
    }
  } finally {
    cleanup(home);
  }
});

// -----------------------------------------------------------------------------------------------
// 3. activity:get -- one detail item; unsafe ids rejected before any path is built.
// -----------------------------------------------------------------------------------------------
test('activity:get returns one detail item carrying the Events and Problems lenses', async () => {
  const home = tmpHome();
  try {
    seedOne(home);
    const { handlers } = makeHandlers(home);
    const res = await handlers['activity:get'](AID);

    assert.strictEqual(res.available, true);
    assert.ok(res.item, 'expected a detail item');
    assert.strictEqual(res.item.id, AID);
    assert.ok(Array.isArray(res.item.events) && res.item.events.length === 2, 'Events lens');
    assert.ok(Array.isArray(res.item.problems) && res.item.problems.length >= 1, 'Problems lens');
    assert.ok(Buffer.byteLength(JSON.stringify(res.item), 'utf8') <= limits.DETAIL_MAX_BYTES);
  } finally {
    cleanup(home);
  }
});

test('activity:get rejects an unsafe or invalid activity id before any path is built', async () => {
  const home = tmpHome();
  const origDir = paths.activityDir;
  try {
    seedOne(home);
    const { handlers } = makeHandlers(home);
    let built = 0;
    paths.activityDir = (...args) => { built += 1; return origDir(...args); };

    for (const bad of [
      '../../etc/passwd',
      '..',
      `${AID}/../../etc`,
      'not-a-uuid',
      '00000000-0000-1000-8000-00000000000a', // v1, not v4
      `${AID}\n`,
      '',
      null,
      42,
      { id: AID },
    ]) {
      await rejects(() => handlers['activity:get'](bad), 'invalid-request', `get(${JSON.stringify(bad)})`);
    }
    assert.strictEqual(built, 0, 'no filesystem path may be built from an unvalidated activity id');
  } finally {
    paths.activityDir = origDir;
    cleanup(home);
  }
});

// -----------------------------------------------------------------------------------------------
// 4. activity:reveal -- only ever reveals the validated directory under activity/.
// -----------------------------------------------------------------------------------------------
test('activity:reveal reveals exactly the validated activity directory', async () => {
  const home = tmpHome();
  try {
    seedOne(home);
    const { handlers, calls } = makeHandlers(home);
    const ok = await handlers['activity:reveal'](AID);

    assert.strictEqual(ok, true);
    assert.deepStrictEqual(calls.revealed, [paths.activityDir(home, AID)]);
    assert.ok(calls.revealed[0].endsWith(path.join('Library', 'Logs', 'repo-radar', 'activity', AID)),
      'the revealed path must sit under the owned activity/ root');
  } finally {
    cleanup(home);
  }
});

// Fix round 1 (Task 4.5 review, Important): Reveal used to be a SILENT no-op once the activity
// was gone. `paths.activityDir` is a pure `path.join` -- it never touches the disk -- and
// `shell.showItemInFinder` on a nonexistent path does nothing at all on macOS, so the handler
// returned `true` and the window had nothing to report. Retention pruning the selected activity
// between the list render and the click is the ordinary way to reach that.
test('activity:reveal refuses a pruned activity instead of silently revealing nothing', async () => {
  const home = tmpHome();
  try {
    seedOne(home);
    const { handlers, calls } = makeHandlers(home);
    fs.rmSync(paths.activityDir(home, AID), { recursive: true, force: true }); // retention

    const err = await rejects(() => handlers['activity:reveal'](AID), 'not-found', 'pruned activity');
    assert.deepStrictEqual(calls.revealed, [], 'the shell is never asked to reveal a path that is not there');
    assert.deepStrictEqual(calls.logs, [],
      'a pruned activity is an ordinary condition, not an internal failure to log');
    assert.ok(!err.message.includes(home), 'no absolute path may cross the bridge');
    assert.ok(!err.message.includes(AID), 'nor the id that was asked for');
  } finally {
    cleanup(home);
  }
});

test('activity:reveal never follows a symlink standing in for an activity directory', async () => {
  const home = tmpHome();
  try {
    seedOne(home);
    const other = '00000000-0000-4000-8000-00000000000b';
    const link = paths.activityDir(home, other);
    fs.symlinkSync(paths.activityDir(home, AID), link);
    const { handlers, calls } = makeHandlers(home);

    await rejects(() => handlers['activity:reveal'](other), 'not-found', 'symlinked activity');
    assert.deepStrictEqual(calls.revealed, [], 'a link is treated as not-found, never revealed');
  } finally {
    cleanup(home);
  }
});

test('activity:reveal refuses a plain file sitting at an activity-shaped path', async () => {
  const home = tmpHome();
  try {
    seedOne(home);
    const other = '00000000-0000-4000-8000-00000000000c';
    fs.writeFileSync(paths.activityDir(home, other), 'not a directory');
    const { handlers, calls } = makeHandlers(home);

    await rejects(() => handlers['activity:reveal'](other), 'not-found', 'file at an activity path');
    assert.deepStrictEqual(calls.revealed, []);
  } finally {
    cleanup(home);
  }
});

test('activity:reveal rejects an unsafe id and never builds a path or calls the shell', async () => {
  const home = tmpHome();
  const origDir = paths.activityDir;
  try {
    seedOne(home);
    const { handlers, calls } = makeHandlers(home);
    let built = 0;
    paths.activityDir = (...args) => { built += 1; return origDir(...args); };

    for (const bad of ['../../etc/passwd', '..', 'not-a-uuid', '', null, 42, `${AID}/..`]) {
      await rejects(() => handlers['activity:reveal'](bad), 'invalid-request', `reveal(${JSON.stringify(bad)})`);
    }
    assert.strictEqual(built, 0, 'no path may be built from an unvalidated activity id');
    assert.deepStrictEqual(calls.revealed, [], 'the shell must never be asked to reveal anything');
  } finally {
    paths.activityDir = origDir;
    cleanup(home);
  }
});

// -----------------------------------------------------------------------------------------------
// 5. activity:export -- build in main, save dialog, 0600 write, path back (null on cancel).
// -----------------------------------------------------------------------------------------------
test('activity:export builds the text in main, writes it 0600 to the chosen path, returns the path', async () => {
  const home = tmpHome();
  try {
    seedOne(home);
    const { handlers, calls, chosen } = makeHandlers(home);
    const result = await handlers['activity:export']({});

    assert.strictEqual(result, chosen);
    assert.strictEqual(calls.dialogs.length, 1, 'the save dialog is shown exactly once');
    assert.strictEqual(typeof calls.dialogs[0].defaultPath, 'string');
    assert.strictEqual(calls.writes.length, 1, 'exactly one write');
    assert.strictEqual(calls.writes[0].path, chosen);
    assert.strictEqual(calls.writes[0].opts.mode, 0o600, 'the export must be written 0600');
    assert.ok(calls.writes[0].data.startsWith('Repo Radar Activity Export'), 'the built export text');
    assert.ok(calls.writes[0].data.includes(AID));
  } finally {
    cleanup(home);
  }
});

test('activity:export returns null and writes nothing when the user cancels', async () => {
  const home = tmpHome();
  try {
    seedOne(home);
    for (const outcome of [{ canceled: true, filePath: undefined }, { canceled: false, filePath: '' }]) {
      const { handlers, calls } = makeHandlers(home, {
        dialog: { showSaveDialog: async () => outcome },
      });
      assert.strictEqual(await handlers['activity:export']({}), null);
      assert.deepStrictEqual(calls.writes, []);
    }
  } finally {
    cleanup(home);
  }
});

test('activity:export rejects a bad filter before the save dialog is ever shown', async () => {
  const home = tmpHome();
  try {
    seedOne(home);
    const { handlers, calls } = makeHandlers(home);
    await rejects(() => handlers['activity:export']({ level: 'trace' }), 'invalid-request', 'export bad level');
    await rejects(() => handlers['activity:export']({ system: 'yes' }), 'invalid-request', 'export bad system flag');
    assert.deepStrictEqual(calls.dialogs, [], 'no dialog for a rejected filter');
    assert.deepStrictEqual(calls.writes, [], 'no write for a rejected filter');
  } finally {
    cleanup(home);
  }
});

// -----------------------------------------------------------------------------------------------
// 6. Unexpected failures: bounded, generic, no stack and no filesystem path.
// -----------------------------------------------------------------------------------------------
test('an unexpected failure surfaces as a bounded generic error with no path or stack', async () => {
  const home = tmpHome();
  const origList = read.listActivities;
  const origExport = read.buildExport;
  try {
    seedOne(home);
    const { handlers, calls } = makeHandlers(home);
    const boom = () => { throw new Error(`ENOSPC while writing ${home}/Library/Logs/repo-radar/activity`); };
    read.listActivities = boom;
    read.buildExport = boom;

    for (const [label, fn] of [
      ['list', () => handlers['activity:list']({})],
      ['export', () => handlers['activity:export']({})],
    ]) {
      const err = await rejects(fn, 'internal', label);
      assert.ok(!err.message.includes(home), `${label}: the home path must not reach the renderer`);
      assert.ok(!err.message.includes('ENOSPC'), `${label}: the underlying message must not be forwarded`);
      assert.ok(err.message.length <= 120, `${label}: the message must stay bounded`);
      assert.ok(!/\.js:\d+/.test(err.stack), `${label}: no stack frames may reach the renderer`);
      assert.ok(!err.stack.includes(home), `${label}: no path may reach the renderer via the stack`);
      assert.strictEqual(err.cause, undefined,
        `${label}: the original error must not ride along as \`cause\` across the bridge`);
    }
    assert.deepStrictEqual(calls.writes, [], 'a failed export writes nothing');

    // ...but the ORIGINAL error IS recorded on the main side, naming the channel, or an internal
    // failure would leave no trace anywhere in the app (Electron only console.errors the THROWN
    // error, which is the stack-stripped generic one).
    assert.strictEqual(calls.logs.length, 2, 'each internal failure is logged exactly once');
    assert.ok(calls.logs[0].includes('activity:list'), 'the log names the failing channel');
    assert.ok(calls.logs[1].includes('activity:export'), 'the log names the failing channel');
    for (const line of calls.logs) {
      assert.ok(line.includes('ENOSPC'), 'the ORIGINAL message is recorded main-side');
      assert.ok(line.includes(home), 'the original path is recorded main-side');
      assert.ok(/ipc\.js:\d+/.test(line), 'the original stack is recorded main-side');
    }
  } finally {
    read.listActivities = origList;
    read.buildExport = origExport;
    cleanup(home);
  }
});

test('a rejected filter never echoes the renderer-supplied value back', async () => {
  const home = tmpHome();
  try {
    const { handlers } = makeHandlers(home);
    const err = await rejects(() => handlers['activity:list']({ level: 'sup3r-s3cret-marker' }),
      'invalid-request', 'echo check');
    assert.ok(!err.message.includes('sup3r-s3cret-marker'), 'renderer input must not be echoed back');
    assert.ok(!/\.js:\d+/.test(err.stack), 'no stack frames may reach the renderer');
  } finally {
    cleanup(home);
  }
});

test('a rejected filter is not logged: renderer-supplied text stays out of the diagnostic stream', async () => {
  const home = tmpHome();
  try {
    const { handlers, calls } = makeHandlers(home);
    await rejects(() => handlers['activity:list']({ level: 'sup3r-s3cret-marker' }),
      'invalid-request', 'no-log check');
    assert.deepStrictEqual(calls.logs, [], 'attributable caller input must not be logged main-side');
  } finally {
    cleanup(home);
  }
});

test('an unlogged handler defaults to console.error and survives a failing logger', async () => {
  const home = tmpHome();
  const origList = read.listActivities;
  const origConsoleError = console.error;
  const captured = [];
  try {
    seedOne(home);
    read.listActivities = () => { throw new Error('kaboom'); };

    // Default sink: console.error (captured here so the test output stays pristine).
    console.error = (...args) => { captured.push(args.join(' ')); };
    const defaulted = ipc.createHandlers({ home, shell: {}, dialog: {}, writeFile: () => {} });
    await rejects(() => defaulted['activity:list']({}), 'internal', 'default logger');
    console.error = origConsoleError;
    assert.strictEqual(captured.length, 1);
    assert.ok(captured[0].includes('activity:list') && captured[0].includes('kaboom'));

    // A logger that itself throws must not change what the renderer sees.
    const hostile = ipc.createHandlers({
      home, shell: {}, dialog: {}, writeFile: () => {}, log: () => { throw new Error('logger down'); },
    });
    const err = await rejects(() => hostile['activity:list']({}), 'internal', 'failing logger');
    assert.ok(!err.message.includes('logger down'));
  } finally {
    console.error = origConsoleError;
    read.listActivities = origList;
    cleanup(home);
  }
});

// -----------------------------------------------------------------------------------------------
// 7. register(): exactly the four channels, event argument dropped.
// -----------------------------------------------------------------------------------------------
test('register wires exactly the four allowlisted channels and drops the IPC event argument', async () => {
  const registered = [];
  const fakeIpcMain = { handle: (channel, fn) => { registered.push([channel, fn]); } };
  const spy = async function (...args) { return { saw: args[0], count: args.length }; };
  const handlers = {
    'activity:list': spy,
    'activity:get': spy,
    'activity:export': spy,
    'activity:reveal': spy,
    'activity:evil': async () => 'must never be registered',
  };
  ipc.register(fakeIpcMain, handlers);

  assert.deepStrictEqual(registered.map((r) => r[0]), [...ipc.CHANNELS]);
  assert.ok(!registered.some((r) => r[0] === 'activity:evil'), 'only the allowlist is registered');

  for (const [channel, wrapper] of registered) {
    const sentinel = { channel };
    const out = await wrapper({ sender: 'renderer', preventDefault() {} }, sentinel);
    assert.strictEqual(out.saw, sentinel, `${channel}: the argument is passed through`);
    assert.strictEqual(out.count, 1, `${channel}: the IPC event object must never reach the handler`);
  }
});

test('register refuses to wire an incomplete handler set', () => {
  const fakeIpcMain = { handle: () => {} };
  assert.throws(() => ipc.register(fakeIpcMain, { 'activity:list': () => {} }), /activity:get/);
});

// -----------------------------------------------------------------------------------------------
// 8. Ruling P4-3: configured secrets are actually WIRED from config.json (not just the regexes).
// -----------------------------------------------------------------------------------------------
test('configured secrets from config.json are wired into list, get and export redaction', async () => {
  const home = tmpHome();
  try {
    // High-entropy but matching NONE of redact.js's built-in credential-shape patterns: if this
    // is masked, it can only be because config.json was actually read and threaded through.
    const secret = 'qz8Vt3nLp0Xw2Rk9';
    const configDir = path.join(home, '.config', 'repo-radar');
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ github_token: secret }), { mode: 0o600 });

    const aid = AID;
    seedSegment(home, aid, [
      startRec(aid, 0, '2026-08-10T00:00:00-07:00', { channel: `stable-${secret}` }),
      eventRec(aid, 1, '2026-08-10T00:00:01-07:00', 'error', 'auth.failed', { detail: `token ${secret} rejected` }),
      terminalRec(aid, 2, '2026-08-10T00:05:00-07:00', 'failed', { summary: { reason: secret } }),
    ]);

    const { handlers, calls } = makeHandlers(home);

    const list = await handlers['activity:list']({});
    const listJson = JSON.stringify(list);
    assert.ok(!listJson.includes(secret), 'activity:list must not leak a configured secret');
    assert.ok(list.items[0].channel.includes('[REDACTED]'), 'the summary channel is masked');

    const detail = await handlers['activity:get'](aid);
    const detailJson = JSON.stringify(detail);
    assert.ok(!detailJson.includes(secret), 'activity:get must not leak a configured secret');
    assert.ok(detailJson.includes('[REDACTED]'), 'the detail item is masked');

    await handlers['activity:export']({});
    const text = calls.writes[0].data;
    assert.ok(!text.includes(secret), 'the export text must not leak a configured secret');
    assert.ok(text.includes('[REDACTED]'), 'the export text is masked');
  } finally {
    cleanup(home);
  }
});
