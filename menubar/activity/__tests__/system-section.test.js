'use strict';
// Task 4.3: the System section -- bounded, redacted, explicitly UNCORRELATED tails of the app's
// shared log streams plus the legacy `~/.config/repo-radar/status.json` error surface.
//
// What these tests pin, beyond "it returns something":
//   * the four streams are always reported, in a fixed order, with `menubar.log` (which has no
//     in-tree writer) honestly reported ABSENT rather than invented;
//   * a stream is never read whole -- only the last SYSTEM_TAIL_MAX_BYTES, with a visible leading
//     marker and a UTF-8-safe leading cut;
//   * a symlink where a log should be is REFUSED, never followed (the same O_NOFOLLOW posture
//     paths.js holds for the owned subtree);
//   * the legacy status surface is bounded on BOTH axes (50 newest entries, 64 KiB of errorLog)
//     and every string on it -- `stackTrace` included -- is redacted;
//   * redaction is WIRED, not merely available: a configured secret that matches none of
//     redact.js's built-in patterns is masked in the diagnostics object, in the `activity:list`
//     `system` payload, and in the export text;
//   * nothing ever throws out of `systemDiagnostics` -- an unexpected failure is reported as data.
//
// Every tmp dir is prefixed `rr-sys-` and removed in a `finally`, per the repo's tmp-dir policy.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const read = require('../read');
const system = require('../system');
const limits = require('../limits');
const ipc = require('../ipc');

// A secret matching NONE of redact.js's built-in credential forms: proof the CONFIGURED-secret
// wiring reaches every string, not just the pattern sweep.
const SECRET = 'qz8Vt3nLp0Xw2Rk9';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-sys-'));
}

function cleanup(home) {
  fs.rmSync(home, { recursive: true, force: true });
}

function logDir(home) {
  return path.join(home, 'Library', 'Logs', 'repo-radar');
}

function seedStream(home, name, text) {
  const dir = logDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), text);
  return path.join(dir, name);
}

function seedStatus(home, status) {
  const dir = path.join(home, '.config', 'repo-radar');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status.json'), typeof status === 'string' ? status : JSON.stringify(status));
  return path.join(dir, 'status.json');
}

function streamsByName(diag) {
  const out = {};
  for (const s of diag.streams) out[s.name] = s;
  return out;
}

function errorEntry(over = {}) {
  return {
    timestamp: '2026-08-14T10:00:00.000Z',
    repo: 'acme/widgets',
    message: 'clone failed',
    fullError: 'fatal: could not read from remote repository',
    stackTrace: null,
    ...over,
  };
}

// -------------------------------------------------------------------------------------------
// Shape and stream enumeration
// -------------------------------------------------------------------------------------------
test('systemDiagnostics reports the four shared streams in a fixed order, marked uncorrelated', () => {
  const home = tmpHome();
  try {
    const diag = system.systemDiagnostics(home, { configuredSecrets: [] });
    assert.strictEqual(diag.uncorrelated, true, 'the payload says, in data, that it is uncorrelated');
    assert.deepStrictEqual(diag.streams.map((s) => s.name),
      ['sync.error.log', 'menubar.log', 'sync.log', 'renderer.log']);
    assert.deepStrictEqual(diag.streams.map((s) => s.onDemand), [false, false, true, true]);
    for (const s of diag.streams) {
      assert.strictEqual(s.present, false, 'nothing on disk yet');
      assert.strictEqual(s.redactedTail, '');
      assert.strictEqual(s.bytes, 0);
      assert.strictEqual(s.truncated, false);
      assert.strictEqual(s.error, undefined, 'a merely-absent stream is not an error');
    }
  } finally {
    cleanup(home);
  }
});

test('menubar.log is reported absent rather than invented (no in-tree writer)', () => {
  const home = tmpHome();
  try {
    seedStream(home, 'sync.error.log', 'boom\n');
    const s = streamsByName(system.systemDiagnostics(home, {}));
    assert.strictEqual(s['sync.error.log'].present, true);
    assert.strictEqual(s['menubar.log'].present, false);
    assert.strictEqual(s['menubar.log'].redactedTail, '');
  } finally {
    cleanup(home);
  }
});

test('a present stream carries its tail, its size and a home-free display path', () => {
  const home = tmpHome();
  try {
    seedStream(home, 'sync.error.log', 'first\nsecond\n');
    const s = streamsByName(system.systemDiagnostics(home, {}))['sync.error.log'];
    assert.strictEqual(s.present, true);
    assert.strictEqual(s.redactedTail, 'first\nsecond\n');
    assert.strictEqual(s.bytes, 13);
    assert.strictEqual(s.truncated, false);
    assert.strictEqual(s.path, '~/Library/Logs/repo-radar/sync.error.log');
    assert.ok(!s.path.includes(home), 'the real home directory never crosses the bridge');
  } finally {
    cleanup(home);
  }
});

// -------------------------------------------------------------------------------------------
// Bounding
// -------------------------------------------------------------------------------------------
test('a stream larger than SYSTEM_TAIL_MAX_BYTES yields only the LAST 64 KiB, marked', () => {
  const home = tmpHome();
  try {
    const filler = 'x'.repeat(70 * 1024);
    const seeded = `HEAD-MARKER\n${filler}\nTAIL-MARKER\n`;
    seedStream(home, 'sync.error.log', seeded);
    const s = streamsByName(system.systemDiagnostics(home, {}))['sync.error.log'];

    assert.strictEqual(s.truncated, true);
    assert.ok(s.redactedTail.startsWith('--- tail truncated at 64 KiB ---\n'),
      `expected a leading truncation marker, got: ${JSON.stringify(s.redactedTail.slice(0, 60))}`);
    assert.ok(s.redactedTail.includes('TAIL-MARKER'), 'the NEWEST bytes are what survive');
    assert.ok(!s.redactedTail.includes('HEAD-MARKER'), 'the oldest bytes are dropped');
    assert.strictEqual(s.bytes, Buffer.byteLength(seeded, 'utf8'),
      '`bytes` is the file size on disk, not the tail size');
    const tailBytes = Buffer.byteLength(s.redactedTail, 'utf8');
    assert.ok(tailBytes <= limits.SYSTEM_TAIL_MAX_BYTES + 64,
      `tail must stay within the bound (+marker), got ${tailBytes}`);
  } finally {
    cleanup(home);
  }
});

test('a truncated tail never begins with a broken UTF-8 code point', () => {
  const home = tmpHome();
  try {
    // 30720 x '\u20ac' = 92160 bytes of 3-byte sequences. The cut at `size - 64 KiB` lands
    // 92160 - 65536 = 26624 bytes in, and 26624 % 3 == 2 -- i.e. INSIDE a sequence. An unguarded
    // slice would strand a continuation byte at the front and decode it as U+FFFD.
    seedStream(home, 'sync.log', '\u20ac'.repeat(30 * 1024));
    const s = streamsByName(system.systemDiagnostics(home, {}))['sync.log'];
    assert.strictEqual(s.truncated, true);
    const afterMarker = s.redactedTail.slice(s.redactedTail.indexOf('\n') + 1);
    assert.ok(!afterMarker.includes('\ufffd'), 'a partial leading code point is dropped, not decoded');
    assert.ok(afterMarker.startsWith('\u20ac'));
  } finally {
    cleanup(home);
  }
});

test('the truncation marker names whatever bound is in force', () => {
  const home = tmpHome();
  const original = limits.SYSTEM_TAIL_MAX_BYTES;
  try {
    limits.SYSTEM_TAIL_MAX_BYTES = 128; // read through the module object at call time
    seedStream(home, 'sync.error.log', 'y'.repeat(300));
    const s = streamsByName(system.systemDiagnostics(home, {}))['sync.error.log'];
    assert.strictEqual(s.truncated, true);
    assert.ok(s.redactedTail.startsWith('--- tail truncated at 128 bytes ---\n'),
      `got: ${JSON.stringify(s.redactedTail.slice(0, 60))}`);
  } finally {
    limits.SYSTEM_TAIL_MAX_BYTES = original;
    cleanup(home);
  }
});

// -------------------------------------------------------------------------------------------
// Refusals -- never follow a symlink, never mistake a refusal for absence
// -------------------------------------------------------------------------------------------
test('a symlink where a log should be is refused, never followed', () => {
  const home = tmpHome();
  try {
    const target = path.join(home, 'elsewhere.txt');
    fs.writeFileSync(target, 'CONTENT-BEHIND-THE-SYMLINK\n');
    fs.mkdirSync(logDir(home), { recursive: true });
    fs.symlinkSync(target, path.join(logDir(home), 'sync.error.log'));

    const s = streamsByName(system.systemDiagnostics(home, {}))['sync.error.log'];
    assert.strictEqual(s.present, false);
    assert.strictEqual(s.error, 'symlink');
    assert.strictEqual(s.redactedTail, '');
    assert.ok(!JSON.stringify(s).includes('CONTENT-BEHIND-THE-SYMLINK'),
      'the symlink target must never be read');
  } finally {
    cleanup(home);
  }
});

test('a non-regular entry (a directory) where a log should be is refused', () => {
  const home = tmpHome();
  try {
    fs.mkdirSync(path.join(logDir(home), 'renderer.log'), { recursive: true });
    const s = streamsByName(system.systemDiagnostics(home, {}))['renderer.log'];
    assert.strictEqual(s.present, false);
    assert.strictEqual(s.error, 'not-regular');
  } finally {
    cleanup(home);
  }
});

test('an unreadable stream is reported denied, not absent', { skip: process.getuid && process.getuid() === 0 ? 'root reads everything' : false }, () => {
  const home = tmpHome();
  try {
    const p = seedStream(home, 'sync.log', 'secret ops\n');
    fs.chmodSync(p, 0o000);
    const s = streamsByName(system.systemDiagnostics(home, {}))['sync.log'];
    assert.strictEqual(s.present, false);
    assert.strictEqual(s.error, 'denied');
  } finally {
    try { fs.chmodSync(path.join(logDir(home), 'sync.log'), 0o600); } catch (e) { /* best effort */ }
    cleanup(home);
  }
});

// -------------------------------------------------------------------------------------------
// The legacy status.json surface
// -------------------------------------------------------------------------------------------
test('status.json errorList is capped at the 50 NEWEST entries with an honest total', () => {
  const home = tmpHome();
  try {
    const errorList = [];
    for (let i = 0; i < 120; i++) errorList.push(errorEntry({ message: `failure-${i}` }));
    seedStatus(home, { errorLog: 'log text', errorList });

    const st = system.systemDiagnostics(home, {}).statusDiagnostics;
    assert.strictEqual(st.present, true);
    assert.strictEqual(st.errorList.total, 120);
    assert.strictEqual(st.errorList.truncated, true);
    assert.strictEqual(st.errorList.entries.length, limits.STATUS_ERROR_LIST_MAX);
    assert.strictEqual(st.errorList.entries[0].message, 'failure-0', 'the array is already newest-first');
    assert.strictEqual(st.errorList.entries[49].message, 'failure-49');
    assert.deepStrictEqual(Object.keys(st.errorList.entries[0]).sort(),
      ['fullError', 'message', 'repo', 'stackTrace', 'timestamp']);
  } finally {
    cleanup(home);
  }
});

test('a short errorList is returned whole, untruncated', () => {
  const home = tmpHome();
  try {
    seedStatus(home, { errorList: [errorEntry({ message: 'only one' })] });
    const st = system.systemDiagnostics(home, {}).statusDiagnostics;
    assert.strictEqual(st.errorList.total, 1);
    assert.strictEqual(st.errorList.truncated, false);
    assert.strictEqual(st.errorList.entries[0].message, 'only one');
  } finally {
    cleanup(home);
  }
});

test('status.json errorLog is bounded to its LAST 64 KiB with a leading marker', () => {
  const home = tmpHome();
  try {
    seedStatus(home, { errorLog: `OLDEST\n${'z'.repeat(70 * 1024)}\nNEWEST\n`, errorList: [] });
    const st = system.systemDiagnostics(home, {}).statusDiagnostics;
    assert.strictEqual(st.errorLog.truncated, true);
    assert.ok(st.errorLog.text.startsWith('--- tail truncated at 64 KiB ---\n'));
    assert.ok(st.errorLog.text.includes('NEWEST'));
    assert.ok(!st.errorLog.text.includes('OLDEST'));
    assert.ok(Buffer.byteLength(st.errorLog.text, 'utf8') <= limits.STATUS_ERROR_LOG_MAX_BYTES + 64);
  } finally {
    cleanup(home);
  }
});

test('an errorList entry field is bounded to FIELD_MAX_BYTES', () => {
  const home = tmpHome();
  try {
    seedStatus(home, { errorList: [errorEntry({ fullError: 'w'.repeat(limits.FIELD_MAX_BYTES * 2) })] });
    const entry = system.systemDiagnostics(home, {}).statusDiagnostics.errorList.entries[0];
    assert.ok(Buffer.byteLength(entry.fullError, 'utf8') <= limits.FIELD_MAX_BYTES);
    assert.ok(entry.fullError.endsWith('…[truncated]'));
  } finally {
    cleanup(home);
  }
});

test('a missing status.json is absent, not an error', () => {
  const home = tmpHome();
  try {
    const st = system.systemDiagnostics(home, {}).statusDiagnostics;
    assert.strictEqual(st.present, false);
    assert.strictEqual(st.error, undefined);
    assert.deepStrictEqual(st.errorList, { entries: [], total: 0, truncated: false });
    assert.deepStrictEqual(st.errorLog, { text: '', truncated: false });
  } finally {
    cleanup(home);
  }
});

test('an unparseable status.json reports a bounded error and echoes no path beyond the basename', () => {
  const home = tmpHome();
  try {
    seedStatus(home, '{ this is not json');
    const st = system.systemDiagnostics(home, {}).statusDiagnostics;
    assert.strictEqual(st.present, false);
    assert.strictEqual(typeof st.error, 'string');
    assert.ok(st.error.length > 0);
    assert.ok(!st.error.includes(home), 'no absolute path in the error text');
    assert.ok(!st.error.includes('/'), 'not even a relative path fragment');
    assert.deepStrictEqual(st.errorList.entries, []);
  } finally {
    cleanup(home);
  }
});

test('a symlinked status.json is refused, never followed', () => {
  const home = tmpHome();
  try {
    const target = path.join(home, 'real-status.json');
    fs.writeFileSync(target, JSON.stringify({ errorLog: 'CONTENT-BEHIND-THE-SYMLINK' }));
    const dir = path.join(home, '.config', 'repo-radar');
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(target, path.join(dir, 'status.json'));

    const st = system.systemDiagnostics(home, {}).statusDiagnostics;
    assert.strictEqual(st.present, false);
    assert.strictEqual(st.error, 'symlink');
    assert.ok(!JSON.stringify(st).includes('CONTENT-BEHIND-THE-SYMLINK'));
  } finally {
    cleanup(home);
  }
});

test('a status.json whose top level is not an object is refused', () => {
  const home = tmpHome();
  try {
    seedStatus(home, '[1,2,3]');
    const st = system.systemDiagnostics(home, {}).statusDiagnostics;
    assert.strictEqual(st.present, false);
    assert.strictEqual(typeof st.error, 'string');
  } finally {
    cleanup(home);
  }
});

test('a status.json with neither errorLog nor errorList is present and empty', () => {
  const home = tmpHome();
  try {
    seedStatus(home, { lastSync: '2026-08-14T10:00:00.000Z', repos: [] });
    const st = system.systemDiagnostics(home, {}).statusDiagnostics;
    assert.strictEqual(st.present, true);
    assert.deepStrictEqual(st.errorLog, { text: '', truncated: false });
    assert.deepStrictEqual(st.errorList, { entries: [], total: 0, truncated: false });
  } finally {
    cleanup(home);
  }
});

test('a hostile errorList (non-objects, missing fields) never throws and never leaks a nested object', () => {
  const home = tmpHome();
  try {
    seedStatus(home, { errorList: [null, 'a string', 42, { repo: { nested: 'object' } }] });
    const st = system.systemDiagnostics(home, {}).statusDiagnostics;
    assert.strictEqual(st.errorList.entries.length, 4);
    for (const e of st.errorList.entries) {
      for (const k of ['timestamp', 'repo', 'message', 'fullError', 'stackTrace']) {
        assert.ok(e[k] === null || typeof e[k] === 'string', `${k} must be a string or null`);
      }
    }
  } finally {
    cleanup(home);
  }
});

// -------------------------------------------------------------------------------------------
// Redaction -- wired, not merely available
// -------------------------------------------------------------------------------------------
test('a configured secret is masked in a stream tail, in errorLog and in a stackTrace', () => {
  const home = tmpHome();
  try {
    seedStream(home, 'sync.error.log', `token=${SECRET} used\n`);
    seedStream(home, 'sync.log', `also ${SECRET}\n`);
    seedStatus(home, {
      errorLog: `\n⚠️ auth failed with ${SECRET}\n`,
      errorList: [errorEntry({ stackTrace: `at auth (${SECRET})`, fullError: `bad ${SECRET}` })],
    });

    const diag = system.systemDiagnostics(home, { configuredSecrets: [SECRET] });
    const blob = JSON.stringify(diag);
    assert.ok(!blob.includes(SECRET), 'the configured secret must appear nowhere in the payload');
    assert.ok(blob.includes('[REDACTED]'), 'and it must be visibly masked, not silently dropped');

    const s = streamsByName(diag);
    assert.strictEqual(s['sync.error.log'].redactedTail, 'token=[REDACTED] used\n');
    assert.ok(s['sync.log'].redactedTail.includes('[REDACTED]'));
    assert.ok(diag.statusDiagnostics.errorLog.text.includes('[REDACTED]'));
    assert.strictEqual(diag.statusDiagnostics.errorList.entries[0].stackTrace, 'at auth ([REDACTED])');
    assert.ok(diag.statusDiagnostics.errorList.entries[0].fullError.includes('[REDACTED]'));
  } finally {
    cleanup(home);
  }
});

test("redact.js's built-in credential forms are masked too", () => {
  const home = tmpHome();
  try {
    seedStream(home, 'sync.error.log', 'remote: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n');
    seedStatus(home, { errorLog: 'https://user:pw@github.com/acme/widgets.git failed', errorList: [] });
    const diag = system.systemDiagnostics(home, { configuredSecrets: [] });
    assert.ok(streamsByName(diag)['sync.error.log'].redactedTail.includes('[REDACTED github token]'));
    assert.ok(diag.statusDiagnostics.errorLog.text.includes('//<redacted>@'));
  } finally {
    cleanup(home);
  }
});

test('redaction expansion can never push a tail past the bound', () => {
  const home = tmpHome();
  const original = limits.SYSTEM_TAIL_MAX_BYTES;
  try {
    limits.SYSTEM_TAIL_MAX_BYTES = 256;
    // 32 x a 4-char secret -> 32 x '[REDACTED]' (10 chars): the scrubbed text is far longer than
    // the bytes read, so the bound has to be re-applied AFTER scrubbing.
    seedStream(home, 'sync.error.log', 'abcd'.repeat(64));
    const s = streamsByName(system.systemDiagnostics(home, { configuredSecrets: ['abcd'] }))['sync.error.log'];
    assert.ok(Buffer.byteLength(s.redactedTail, 'utf8') <= limits.SYSTEM_TAIL_MAX_BYTES + 64,
      `scrubbed tail must still be bounded, got ${Buffer.byteLength(s.redactedTail, 'utf8')}`);
    assert.strictEqual(s.truncated, true);
  } finally {
    limits.SYSTEM_TAIL_MAX_BYTES = original;
    cleanup(home);
  }
});

// -------------------------------------------------------------------------------------------
// Containment
// -------------------------------------------------------------------------------------------
test('systemDiagnostics never throws -- an unexpected failure is reported as data', () => {
  const diag = system.systemDiagnostics(42, {});
  assert.strictEqual(diag.uncorrelated, true);
  assert.deepStrictEqual(diag.streams, []);
  assert.strictEqual(typeof diag.error, 'string');
  assert.strictEqual(diag.statusDiagnostics.present, false);
});

test('read.js re-exports systemDiagnostics', () => {
  assert.strictEqual(read.systemDiagnostics, system.systemDiagnostics);
});

// -------------------------------------------------------------------------------------------
// The `activity:list` branch (Ruling P4-1: no fifth channel)
// -------------------------------------------------------------------------------------------
function handlersFor(home) {
  return ipc.createHandlers({
    home,
    loadConfiguredSecrets: () => [SECRET],
    shell: { showItemInFinder: () => {} },
    dialog: { showSaveDialog: async () => ({ canceled: true }) },
    writeFile: () => {},
    log: () => {},
  });
}

test('activity:list attaches `system` ONLY when the filter asks for it', async () => {
  const home = tmpHome();
  try {
    seedStream(home, 'sync.error.log', `boom ${SECRET}\n`);
    const list = handlersFor(home)['activity:list'];

    const plain = await list({});
    assert.strictEqual('system' in plain, false, 'absent flag => no diagnostics');

    const off = await list({ system: false });
    assert.strictEqual('system' in off, false, 'false => no diagnostics');

    const on = await list({ system: true });
    assert.ok(on.system, 'system:true => the diagnostics ride along on the same response');
    assert.strictEqual(on.system.uncorrelated, true);
    assert.ok(Array.isArray(on.items), 'the item list is still there');
    const blob = JSON.stringify(on.system);
    assert.ok(blob.includes('[REDACTED]'), 'the app-configured secrets are wired into this path');
    assert.ok(!blob.includes(SECRET));
  } finally {
    cleanup(home);
  }
});

test('activity:list still rejects a non-boolean system flag', async () => {
  const home = tmpHome();
  try {
    await assert.rejects(() => handlersFor(home)['activity:list']({ system: 'yes' }),
      (e) => e.code === 'invalid-request');
  } finally {
    cleanup(home);
  }
});

// -------------------------------------------------------------------------------------------
// Export -- self-contained, same bounds
// -------------------------------------------------------------------------------------------
test('buildExport ends with the System section, rendered from the same diagnostics', () => {
  const home = tmpHome();
  try {
    seedStream(home, 'sync.error.log', `sh incident: ${SECRET}\n`);
    seedStatus(home, {
      errorLog: `\n⚠️ auth failed with ${SECRET}\n`,
      errorList: [errorEntry({ message: 'clone failed', stackTrace: `at auth (${SECRET})` })],
    });

    const text = read.buildExport(home, {}, { configuredSecrets: [SECRET] });
    assert.ok(text.includes('--- System (uncorrelated diagnostics) ---'), 'the section header is present');
    assert.ok(text.indexOf('--- System (uncorrelated diagnostics) ---') > text.indexOf('Repo Radar Activity Export'),
      'the section is trailing');
    assert.ok(text.includes('sync.error.log'));
    assert.ok(text.includes('sh incident:'));
    assert.ok(text.includes('menubar.log'), 'an absent stream is still named');
    assert.ok(text.includes('clone failed'), 'the legacy errorList reaches the export');
    assert.ok(text.includes('[REDACTED]'));
    assert.ok(!text.includes(SECRET), 'no configured secret survives into the export text');
  } finally {
    cleanup(home);
  }
});

test('an export prints nothing below a failed diagnostics collection', () => {
  const home = tmpHome();
  const original = system.systemDiagnostics;
  try {
    // read.js calls `systemMod.systemDiagnostics` through the shared module object at call time
    // (the same injection seam reconcile/limits use), so this is observed immediately.
    system.systemDiagnostics = () => ({
      uncorrelated: true, streams: [],
      statusDiagnostics: { present: false, errorLog: { text: '', truncated: false }, errorList: { entries: [], total: 0, truncated: false } },
      error: 'diagnostics unavailable',
    });
    const text = read.buildExport(home, {}, { configuredSecrets: [] });
    assert.ok(text.includes('(diagnostics unavailable: diagnostics unavailable)'));
    assert.ok(!text.includes('[status]'), 'no surface is described when none was established');
    assert.ok(!text.includes('[stream]'));
  } finally {
    system.systemDiagnostics = original;
    cleanup(home);
  }
});

test('the System section counts toward EXPORT_MAX_BYTES', () => {
  const home = tmpHome();
  const original = limits.EXPORT_MAX_BYTES;
  try {
    limits.EXPORT_MAX_BYTES = 2048;
    seedStream(home, 'sync.error.log', 'q'.repeat(8 * 1024));
    const text = read.buildExport(home, {}, { configuredSecrets: [] });
    assert.ok(Buffer.byteLength(text, 'utf8') <= limits.EXPORT_MAX_BYTES + 64);
    assert.ok(text.includes('--- export truncated at'));
  } finally {
    limits.EXPORT_MAX_BYTES = original;
    cleanup(home);
  }
});
