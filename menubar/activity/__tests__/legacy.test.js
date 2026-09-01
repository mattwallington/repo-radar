'use strict';
// Task 5.1: the OPAQUE legacy `sync-*.log` adapter.
//
// The pre-Activity history surface is a directory of per-run text logs
// (`~/Library/Logs/repo-radar/sync-<YYYY-MM-DD>T<HH-MM-SS>.log`, written by
// repo_radar/modes/sync.py's SyncLogger and rotated to the newest 10 by `_rotate_sync_logs`).
// Task 5.1 makes those visible in the Activity window WITHOUT pretending they are activities:
// each file becomes ONE self-contained, clearly-marked `legacy: true` summary DTO whose id
// (`legacy:sync-<ISO>`) is never a valid activity id, never crosses `activity:get`/`activity:reveal`,
// and never reaches a filesystem path.
//
// Every tmp dir here is `rr-`-prefixed and removed in a `finally`, per the repo's tmp-dir policy.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const legacy = require('../legacy');
const read = require('../read');
const ids = require('../ids');
const limits = require('../limits');
const A = require('../index');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-legacy-'));
}

function cleanup(home) {
  fs.rmSync(home, { recursive: true, force: true });
}

function logDir(home) {
  return path.join(home, 'Library', 'Logs', 'repo-radar');
}

function seedLog(home, name, text) {
  const dir = logDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), text);
  return path.join(dir, name);
}

// A realistic per-run log: `[HH:MM:SS] event_name k=v k=v`, with an indented stderr block under
// an error line (SyncLogger.error writes up to 8 such lines).
const SAMPLE = [
  '[09:31:05] repos_loaded count=3',
  '[09:31:07] repo_unchanged repo=owner/alpha',
  '[09:32:00] metadata_degraded repo=owner/beta reason=llm_timeout',
  '[09:32:40] clone_failed repo=owner/gamma',
  '    fatal: could not read from remote repository',
  '    please make sure you have the correct access rights',
  '[09:33:10] sync_complete total=3 updated=1 cloned=0 skipped=1 errors=1',
  '',
].join('\n');

// Minimal durable-activity seeding (mirrors read.test.js's helpers, kept local to this file).
function startRec(aid, seq, ts) {
  return {
    schema_version: 1, activity_id: aid, type: 'start', seq, ts,
    kind: 'sync', channel: 'stable', trigger: 'cli', created_by: 'python',
  };
}
function terminalRec(aid, seq, ts, outcome) {
  return {
    schema_version: 1, activity_id: aid, type: 'terminal', seq, ts,
    outcome, summary: {}, by: 'deadbeef',
  };
}
function seedActivity(home, aid, records) {
  A.secureMkdir(A.activityDir(home, aid));
  fs.writeFileSync(A.segmentPath(home, aid, 'python', 'deadbeef'),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// -------------------------------------------------------------------------------------------
// 1. One seeded log -> one opaque legacy DTO with a reconstructed timestamp (brief's first case)
// -------------------------------------------------------------------------------------------
test('a seeded sync-*.log becomes ONE opaque legacy DTO with a reconstructed timestamp', () => {
  const home = tmpHome();
  try {
    seedLog(home, 'sync-2026-08-14T09-31-05.log', SAMPLE);

    const items = legacy.legacyItems(home, { configuredSecrets: [] });
    assert.strictEqual(items.length, 1);
    const it = items[0];

    assert.strictEqual(it.legacy, true, 'the DTO is clearly marked legacy');
    assert.strictEqual(it.id, 'legacy:sync-2026-08-14T09:31:05');
    assert.strictEqual(ids.validActivityId(it.id), false,
      'a legacy id can never be mistaken for an activity id');

    // Run start comes from the filename (a complete local wall-clock stamp); the end comes from
    // the LAST `[HH:MM:SS]` line, dated by the filename's date.
    assert.strictEqual(it.startedAt, '2026-08-14T09:31:05');
    assert.strictEqual(it.endedAt, '2026-08-14T09:33:10');
    assert.strictEqual(it.duration, 125000);

    // Nothing about the run's verdict is claimed -- the old logs record none.
    assert.strictEqual(it.outcome, 'unknown');
    assert.strictEqual(it.channel, 'legacy');
    assert.strictEqual(it.trigger, 'unknown');
    assert.strictEqual(it.kind, 'sync');
    assert.strictEqual(it.synthesized, false);
    assert.strictEqual(it.source, 'sync-2026-08-14T09-31-05.log');

    // The excerpt is the file's (bounded, redacted) tail, carried INLINE for local rendering.
    assert.ok(it.excerpt.includes('clone_failed repo=owner/gamma'));
    assert.ok(it.excerpt.includes('fatal: could not read from remote repository'));
    assert.strictEqual(it.excerptTruncated, false);
    assert.strictEqual(it.incomplete, false);
    assert.strictEqual(it.error, undefined);
  } finally {
    cleanup(home);
  }
});

// -------------------------------------------------------------------------------------------
// 2. Derived levels (legacy data only)
// -------------------------------------------------------------------------------------------
test('levels are derived from the record line NAME, never from a continuation line', () => {
  const home = tmpHome();
  try {
    seedLog(home, 'sync-2026-08-14T09-31-05.log', SAMPLE);
    const it = legacy.legacyItems(home)[0];
    // clone_failed -> error; metadata_degraded -> warn. `sync_complete ... errors=1` must NOT be
    // counted (the word "errors" is in the FIELDS, not the name), and neither of the two indented
    // stderr lines may add a count of its own.
    assert.strictEqual(it.errorCount, 1);
    assert.strictEqual(it.warnCount, 1);
    assert.strictEqual(it.problemCount, 2);
    assert.strictEqual(it.hasProblems, true);
  } finally {
    cleanup(home);
  }
});

// Fix round 1 (review, promoted minor): an earlier draft also counted any line containing `⚠` as a
// warning -- dead against the real producer (SyncLogger never writes it into a sync-*.log) and a
// direct contradiction of the "event NAME only" rule, since a FIELD VALUE could trip it.
test('a field value can never set the level -- only the event name can', () => {
  const home = tmpHome();
  try {
    seedLog(home, 'sync-2026-08-14T09-31-05.log', [
      '[09:31:05] repo_unchanged repo=owner/a note=⚠ odd',
      '[09:31:06] repos_loaded count=1 last_error=clone_failed',
      '[09:31:07] sync_complete total=1 errors=0 warnings=0',
      '',
    ].join('\n'));
    const it = legacy.legacyItems(home)[0];
    assert.strictEqual(it.warnCount, 0, 'a ⚠ in a field is not a warning record');
    assert.strictEqual(it.errorCount, 0, 'nor is an error name quoted in a field an error record');
    assert.strictEqual(it.hasProblems, false);
  } finally {
    cleanup(home);
  }
});

test('a log with nothing problem-shaped reports zero counts and no problems', () => {
  const home = tmpHome();
  try {
    seedLog(home, 'sync-2026-08-14T09-31-05.log',
      '[09:31:05] repos_loaded count=1\n[09:31:20] sync_complete total=1 errors=0\n');
    const it = legacy.legacyItems(home)[0];
    assert.strictEqual(it.errorCount, 0);
    assert.strictEqual(it.warnCount, 0);
    assert.strictEqual(it.hasProblems, false);
  } finally {
    cleanup(home);
  }
});

// -------------------------------------------------------------------------------------------
// 3. Timestamp reconstruction edge cases
// -------------------------------------------------------------------------------------------
test('a run that crosses midnight rolls the end date forward exactly one day', () => {
  const home = tmpHome();
  try {
    seedLog(home, 'sync-2026-08-14T23-59-30.log',
      '[23:59:30] repos_loaded count=1\n[00:00:40] sync_complete total=1\n');
    const it = legacy.legacyItems(home)[0];
    assert.strictEqual(it.startedAt, '2026-08-14T23:59:30');
    assert.strictEqual(it.endedAt, '2026-08-15T00:00:40');
    assert.strictEqual(it.duration, 70000);
  } finally {
    cleanup(home);
  }
});

test('a log with no timestamped line has no end and no duration', () => {
  const home = tmpHome();
  try {
    seedLog(home, 'sync-2026-08-14T09-31-05.log', '');
    const it = legacy.legacyItems(home)[0];
    assert.strictEqual(it.startedAt, '2026-08-14T09:31:05');
    assert.strictEqual(it.endedAt, null);
    assert.strictEqual(it.duration, null);
    assert.strictEqual(it.excerpt, '');
  } finally {
    cleanup(home);
  }
});

// -------------------------------------------------------------------------------------------
// 4. The filename contract: nothing else in the shared log directory is ever opened
// -------------------------------------------------------------------------------------------
test('only strictly-conforming sync-<stamp>.log names are read; everything else is ignored', () => {
  const home = tmpHome();
  try {
    seedLog(home, 'sync-2026-08-14T09-31-05.log', '[09:31:05] repos_loaded count=1\n');
    // The SHARED streams the System section owns -- these must never become items.
    seedLog(home, 'sync.log', 'shared stdout\n');
    seedLog(home, 'sync.error.log', 'shared stderr\n');
    seedLog(home, 'renderer.log', 'renderer\n');
    // Near-misses.
    seedLog(home, 'sync-oops.log', 'nope\n');
    seedLog(home, 'sync-2026-13-45T99-99-99.log', 'nope\n');
    seedLog(home, 'sync-2026-08-14T09-31-05.log.bak', 'nope\n');
    seedLog(home, 'sync-2026-08-14T09-31-05.txt', 'nope\n');
    // A DIFFERENT stamp, because macOS's default filesystem is case-insensitive: reusing the
    // conforming stamp here would overwrite the real log rather than test the pattern.
    seedLog(home, 'Sync-2026-08-13T09-31-05.log', 'nope\n');

    const items = legacy.legacyItems(home);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].source, 'sync-2026-08-14T09-31-05.log');
    for (const it of items) {
      assert.ok(!it.excerpt.includes('nope'), 'a near-miss name is never opened');
      assert.ok(!it.excerpt.includes('shared'), 'a shared stream is never opened');
    }
  } finally {
    cleanup(home);
  }
});

test('the exported filename pattern is the strict one, and rejects traversal outright', () => {
  assert.ok(legacy.LEGACY_FILENAME_RE.test('sync-2026-08-14T09-31-05.log'));
  for (const bad of ['../sync-2026-08-14T09-31-05.log', 'sync-2026-08-14T09-31-05.log/..',
    'sync-../../etc/passwd.log', 'sync-2026-08-14T09-31-05.log\n', 'sync-.log', 'sync.log']) {
    assert.strictEqual(legacy.LEGACY_FILENAME_RE.test(bad), false, bad);
  }
});

// -------------------------------------------------------------------------------------------
// 5. Redaction (defense in depth) -- the same Redactor every other reader path uses
// -------------------------------------------------------------------------------------------
test('a configured secret that matches NO built-in pattern is masked in the excerpt', () => {
  const home = tmpHome();
  try {
    const secret = 'qz8Vt3nLp0Xw2Rk9'; // no pattern matches this; only the configured list can
    seedLog(home, 'sync-2026-08-14T09-31-05.log',
      `[09:31:05] repos_loaded count=1\n[09:32:00] clone_failed repo=owner/x\n    remote: token ${secret} rejected\n`);

    const it = legacy.legacyItems(home, { configuredSecrets: [secret] })[0];
    assert.ok(!it.excerpt.includes(secret), 'the configured secret must not survive into the DTO');
    assert.ok(it.excerpt.includes('[REDACTED]'));

    // And with no configured secrets it is (correctly) still there -- proving the test above is
    // exercising the Redactor rather than an incidental truncation.
    const bare = legacy.legacyItems(home, { configuredSecrets: [] })[0];
    assert.ok(bare.excerpt.includes(secret));
  } finally {
    cleanup(home);
  }
});

test('a built-in credential pattern is masked even with no configured secrets', () => {
  const home = tmpHome();
  try {
    seedLog(home, 'sync-2026-08-14T09-31-05.log',
      '[09:31:05] clone_failed repo=owner/x\n    remote: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 denied\n');
    const it = legacy.legacyItems(home)[0];
    assert.ok(!it.excerpt.includes('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'));
    assert.ok(it.excerpt.includes('[REDACTED github token]'));
  } finally {
    cleanup(home);
  }
});

// -------------------------------------------------------------------------------------------
// 6. Bounded reads: a tail, never a whole file, with the partial first line dropped
// -------------------------------------------------------------------------------------------
test('the excerpt bound is 16 KiB of UTF-8 and is enforced with a visible marker', () => {
  assert.strictEqual(limits.LEGACY_EXCERPT_MAX_BYTES, 16 * 1024);

  const home = tmpHome();
  const saved = limits.LEGACY_EXCERPT_MAX_BYTES;
  try {
    limits.LEGACY_EXCERPT_MAX_BYTES = 256; // read at call time, so this is observed immediately
    const filler = Array.from({ length: 40 }, (_, i) => `[09:31:${String(i % 60).padStart(2, '0')}] repo_unchanged repo=owner/r${i}`).join('\n');
    seedLog(home, 'sync-2026-08-14T09-31-05.log', `${filler}\n[09:33:10] sync_complete total=40\n`);

    const it = legacy.legacyItems(home)[0];
    // The BODY is bounded to the limit; the one-line marker rides on top of it, exactly as a
    // System stream tail's does (system.js `_scrubTail` prepends it after both bounding passes).
    const marker = '--- tail truncated at 256 bytes ---\n';
    assert.ok(it.excerpt.startsWith(marker), `excerpt must lead with the marker, got ${JSON.stringify(it.excerpt.slice(0, 60))}`);
    const body = Buffer.byteLength(it.excerpt, 'utf8') - Buffer.byteLength(marker, 'utf8');
    assert.ok(body <= 256, `excerpt body must respect the bound, got ${body} bytes`);
    assert.strictEqual(it.excerptTruncated, true);
    assert.strictEqual(it.incomplete, true, 'a partial view of the file is an incomplete item');
    assert.ok(it.excerpt.includes('sync_complete'), 'the NEWEST bytes are the ones kept');
    // The end timestamp still comes off the last line in the tail.
    assert.strictEqual(it.endedAt, '2026-08-14T09:33:10');
  } finally {
    limits.LEGACY_EXCERPT_MAX_BYTES = saved;
    cleanup(home);
  }
});

test('a secret straddling the tail cut cannot survive as an unmatchable fragment', () => {
  const home = tmpHome();
  const saved = limits.LEGACY_EXCERPT_MAX_BYTES;
  try {
    const secret = 'qz8Vt3nLp0Xw2Rk9';
    limits.LEGACY_EXCERPT_MAX_BYTES = 64;
    // One long line whose tail window begins INSIDE the secret, then a short final line.
    seedLog(home, 'sync-2026-08-14T09-31-05.log',
      `[09:31:05] repos_loaded note=${'x'.repeat(200)}${secret}suffix-after-secret\n[09:33:10] sync_complete total=1\n`);

    const it = legacy.legacyItems(home, { configuredSecrets: [secret] })[0];
    assert.ok(!it.excerpt.includes(secret));
    assert.ok(!it.excerpt.includes('suffix-after-secret'),
      'the whole partial first line is dropped, so no fragment of it can leak');
    assert.ok(it.excerpt.includes('sync_complete'));
  } finally {
    limits.LEGACY_EXCERPT_MAX_BYTES = saved;
    cleanup(home);
  }
});

test('at most LEGACY_MAX_FILES logs are read, newest first', () => {
  const home = tmpHome();
  const saved = limits.LEGACY_MAX_FILES;
  try {
    limits.LEGACY_MAX_FILES = 3;
    for (let i = 0; i < 6; i += 1) {
      seedLog(home, `sync-2026-08-1${i}T09-31-05.log`, `[09:31:05] repos_loaded count=${i}\n`);
    }
    const items = legacy.legacyItems(home);
    assert.strictEqual(items.length, 3);
    assert.deepStrictEqual(items.map((i) => i.source), [
      'sync-2026-08-15T09-31-05.log',
      'sync-2026-08-14T09-31-05.log',
      'sync-2026-08-13T09-31-05.log',
    ]);
  } finally {
    limits.LEGACY_MAX_FILES = saved;
    cleanup(home);
  }
});

// -------------------------------------------------------------------------------------------
// 7. Refusal posture: never follow a symlink, never throw
// -------------------------------------------------------------------------------------------
test('a symlinked sync-*.log is REFUSED, not followed, and says so', () => {
  const home = tmpHome();
  try {
    const outside = path.join(home, 'elsewhere.txt');
    fs.writeFileSync(outside, '[09:31:05] attacker_content secret=hunter2\n');
    fs.mkdirSync(logDir(home), { recursive: true });
    fs.symlinkSync(outside, path.join(logDir(home), 'sync-2026-08-14T09-31-05.log'));

    const items = legacy.legacyItems(home);
    assert.strictEqual(items.length, 1, 'the refusal is VISIBLE, not silently dropped');
    const it = items[0];
    assert.strictEqual(it.error, 'symlink');
    assert.strictEqual(it.excerpt, '');
    assert.strictEqual(it.incomplete, true);
    assert.ok(!JSON.stringify(it).includes('hunter2'), 'the link target is never read');
  } finally {
    cleanup(home);
  }
});

test('a sync-*.log that is a DIRECTORY is refused as not-regular', () => {
  const home = tmpHome();
  try {
    fs.mkdirSync(path.join(logDir(home), 'sync-2026-08-14T09-31-05.log'), { recursive: true });
    const items = legacy.legacyItems(home);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].error, 'not-regular');
    assert.strictEqual(items[0].excerpt, '');
  } finally {
    cleanup(home);
  }
});

test('a symlinked LOG DIRECTORY yields nothing at all -- the walk refuses every component', () => {
  const home = tmpHome();
  try {
    const evil = path.join(home, 'evil-logs');
    fs.mkdirSync(evil, { recursive: true });
    fs.writeFileSync(path.join(evil, 'sync-2026-08-14T09-31-05.log'), '[09:31:05] planted\n');
    fs.mkdirSync(path.join(home, 'Library', 'Logs'), { recursive: true });
    fs.symlinkSync(evil, logDir(home));

    assert.deepStrictEqual(legacy.legacyItems(home), []);
  } finally {
    cleanup(home);
  }
});

test('legacyItems never throws: absent home, absent log dir, garbage input', () => {
  assert.deepStrictEqual(legacy.legacyItems(path.join(os.tmpdir(), 'rr-legacy-does-not-exist')), []);
  assert.deepStrictEqual(legacy.legacyItems(null), []);
  assert.deepStrictEqual(legacy.legacyItems(undefined), []);
  assert.deepStrictEqual(legacy.legacyItems(42), []);
  const home = tmpHome();
  try {
    assert.deepStrictEqual(legacy.legacyItems(home), [], 'no Library/Logs/repo-radar yet');
    assert.deepStrictEqual(legacy.legacyItems(home, { configuredSecrets: null }), []);
  } finally {
    cleanup(home);
  }
});

// -------------------------------------------------------------------------------------------
// 8. read.js integration (Ruling P5-2)
// -------------------------------------------------------------------------------------------
test('listActivities merges legacy items with durable activities, newest-first', () => {
  const home = tmpHome();
  try {
    const aidOld = '00000000-0000-4000-8000-00000000000a';
    const aidNew = '00000000-0000-4000-8000-00000000000b';
    seedActivity(home, aidOld, [
      startRec(aidOld, 0, '2026-08-13T00:00:00-07:00'),
      terminalRec(aidOld, 1, '2026-08-13T00:05:00-07:00', 'succeeded'),
    ]);
    seedActivity(home, aidNew, [
      startRec(aidNew, 0, '2026-08-16T00:00:00-07:00'),
      terminalRec(aidNew, 1, '2026-08-16T00:05:00-07:00', 'succeeded'),
    ]);
    // Between the two durable activities in wall-clock order.
    seedLog(home, 'sync-2026-08-14T09-31-05.log', SAMPLE);
    // Older than both.
    seedLog(home, 'sync-2026-08-10T09-31-05.log', '[09:31:05] repos_loaded count=1\n');

    const result = read.listActivities(home);
    assert.strictEqual(result.available, true);
    assert.strictEqual(result.incomplete, false, 'legacy items never make the RESPONSE incomplete');
    assert.strictEqual(result.truncated, false);
    assert.deepStrictEqual(result.items.map((i) => i.id), [
      aidNew,
      'legacy:sync-2026-08-14T09:31:05',
      aidOld,
      'legacy:sync-2026-08-10T09:31:05',
    ]);
    // The durable summaries are unchanged in shape (no `legacy` key at all).
    assert.strictEqual('legacy' in result.items[0], false);
    // The legacy item still carries its whole self -- the renderer never calls back for it.
    assert.strictEqual(result.items[1].legacy, true);
    assert.ok(result.items[1].excerpt.includes('clone_failed'));
  } finally {
    cleanup(home);
  }
});

test('with NO durable store at all, the legacy logs ARE the history', () => {
  // The headline case: someone who has never synced under the new contract. The store is MISSING
  // (ordinary empty history), and the window must still show what actually happened.
  const home = tmpHome();
  try {
    seedLog(home, 'sync-2026-08-14T09-31-05.log', SAMPLE);
    seedLog(home, 'sync-2026-08-10T09-31-05.log', '[09:31:05] repos_loaded count=1\n');

    const result = read.listActivities(home);
    assert.strictEqual(result.available, true);
    assert.strictEqual(result.incomplete, false);
    assert.deepStrictEqual(result.problems, []);
    assert.deepStrictEqual(result.items.map((i) => i.id), [
      'legacy:sync-2026-08-14T09:31:05',
      'legacy:sync-2026-08-10T09:31:05',
    ]);
  } finally {
    cleanup(home);
  }
});

test('an UNREADABLE store draws no history at all -- legacy items included', () => {
  const home = tmpHome();
  try {
    seedLog(home, 'sync-2026-08-14T09-31-05.log', SAMPLE);
    // A plain file squatting where the activity root belongs: the reader refuses to report any
    // history over a store it could not read, and must not paper over that with legacy items.
    fs.writeFileSync(path.join(logDir(home), 'activity'), 'not a directory');

    const result = read.listActivities(home);
    assert.strictEqual(result.available, false);
    assert.deepStrictEqual(result.items, []);
  } finally {
    cleanup(home);
  }
});

test('LIST_MAX is applied to the MERGED list and `truncated` reports the merged total', () => {
  const home = tmpHome();
  const saved = limits.LIST_MAX;
  try {
    const aid = '00000000-0000-4000-8000-00000000000b';
    seedActivity(home, aid, [
      startRec(aid, 0, '2026-08-16T00:00:00-07:00'),
      terminalRec(aid, 1, '2026-08-16T00:05:00-07:00', 'succeeded'),
    ]);
    seedLog(home, 'sync-2026-08-14T09-31-05.log', '[09:31:05] repos_loaded count=1\n');
    seedLog(home, 'sync-2026-08-10T09-31-05.log', '[09:31:05] repos_loaded count=1\n');

    assert.strictEqual(read.listActivities(home).items.length, 3);

    limits.LIST_MAX = 2;
    const capped = read.listActivities(home);
    assert.strictEqual(capped.items.length, 2);
    assert.strictEqual(capped.truncated, true, 'the third (legacy) item is beyond the page');
    assert.deepStrictEqual(capped.items.map((i) => i.id), [aid, 'legacy:sync-2026-08-14T09:31:05']);
  } finally {
    limits.LIST_MAX = saved;
    cleanup(home);
  }
});

test('a legacy item never becomes an incident target and is never scanned as an activity', () => {
  const home = tmpHome();
  try {
    // A legacy log FULL of errors, and a clean durable activity: the tray affordance must stay
    // silent -- legacy logs are not activities and carry no reconciled outcome to act on.
    seedLog(home, 'sync-2026-08-14T09-31-05.log',
      '[09:31:05] clone_failed repo=owner/x\n[09:32:00] repo_exception repo=owner/y\n');
    const aid = '00000000-0000-4000-8000-00000000000b';
    seedActivity(home, aid, [
      startRec(aid, 0, '2026-08-16T00:00:00-07:00'),
      terminalRec(aid, 1, '2026-08-16T00:05:00-07:00', 'succeeded'),
    ]);

    assert.strictEqual(read.viewErrorsTarget(home), null);
  } finally {
    cleanup(home);
  }
});

test('a legacy id is refused by getActivity -- it is not, and can never be, an activity id', () => {
  const home = tmpHome();
  try {
    seedLog(home, 'sync-2026-08-14T09-31-05.log', SAMPLE);
    const id = read.listActivities(home).items[0].id;
    assert.strictEqual(id, 'legacy:sync-2026-08-14T09:31:05');
    assert.throws(() => read.getActivity(home, id), read.InvalidActivityId);
  } finally {
    cleanup(home);
  }
});

// -------------------------------------------------------------------------------------------
// 8b. The export declares what it is NOT carrying (Ruling P5-3, fix round 1)
// -------------------------------------------------------------------------------------------
test('the export names how many legacy logs are present but not included', () => {
  const home = tmpHome();
  try {
    const aid = '00000000-0000-4000-8000-00000000000b';
    seedActivity(home, aid, [
      startRec(aid, 0, '2026-08-16T00:00:00-07:00'),
      terminalRec(aid, 1, '2026-08-16T00:05:00-07:00', 'succeeded'),
    ]);
    seedLog(home, 'sync-2026-08-14T09-31-05.log', SAMPLE);
    seedLog(home, 'sync-2026-08-10T09-31-05.log', '[09:31:05] repos_loaded count=1\n');
    seedLog(home, 'sync.log', 'a shared stream, not a per-run log\n'); // must not be counted

    const text = read.buildExport(home);
    assert.ok(text.includes('2 legacy sync log(s) present; not included in this export'),
      `the export must declare the omission, got:\n${text}`);
    // ...and it really is an omission: no legacy item is rendered into the document.
    assert.ok(!text.includes('legacy:sync-'), 'a legacy item is never an export item');
    assert.ok(!text.includes('clone_failed'), 'nor is its excerpt');
    assert.ok(text.includes(`Activity ${aid}`), 'the durable activity is still there');
  } finally {
    cleanup(home);
  }
});

test('an export with no legacy logs omits the line entirely', () => {
  const home = tmpHome();
  try {
    const aid = '00000000-0000-4000-8000-00000000000b';
    seedActivity(home, aid, [
      startRec(aid, 0, '2026-08-16T00:00:00-07:00'),
      terminalRec(aid, 1, '2026-08-16T00:05:00-07:00', 'succeeded'),
    ]);
    const text = read.buildExport(home);
    assert.ok(!text.includes('not included in this export'),
      'with nothing missing there is nothing to declare');
  } finally {
    cleanup(home);
  }
});

test('the count is the cheap enumeration: every candidate, no file opened', () => {
  const home = tmpHome();
  const saved = limits.LEGACY_MAX_FILES;
  try {
    limits.LEGACY_MAX_FILES = 1; // the window would show ONE...
    for (let i = 0; i < 4; i += 1) {
      seedLog(home, `sync-2026-08-1${i}T09-31-05.log`, `[09:31:05] repos_loaded count=${i}\n`);
    }
    // ...but the export's line is about what is on DISK, so it counts all four.
    assert.strictEqual(legacy.legacyCandidateCount(home), 4);
    assert.strictEqual(read.listActivities(home).items.length, 1);
    assert.ok(read.buildExport(home).includes('4 legacy sync log(s) present; not included in this export'));
  } finally {
    limits.LEGACY_MAX_FILES = saved;
    cleanup(home);
  }
});

// -------------------------------------------------------------------------------------------
// Ruling P5-5 (Codex final verdict): the LEGACY_MAX_FILES cap must be REPORTED, not silent.
//
// `legacyItems` drops the oldest candidates beyond the cap; `listActivities` used to compute
// `truncated` purely from the already-capped merged array, so 26 valid logs produced
// `{ items: 25, truncated: false }` -- the window drew a complete-looking history that was
// silently missing a log. `legacyItemsDetailed` now reports how many candidates the cap omitted,
// and `listActivities` folds that into `truncated`.
// -------------------------------------------------------------------------------------------

// Distinct, sortable per-run log names: sync-2026-08-14T09-<MM>-05.log.
function seedNumberedLogs(home, n) {
  for (let i = 0; i < n; i += 1) {
    const mm = String(i).padStart(2, '0');
    seedLog(home, `sync-2026-08-14T09-${mm}-05.log`, `[09:${mm}:05] repos_loaded count=${i}\n`);
  }
}

test('legacyItemsDetailed reports the candidates the cap omitted', () => {
  const home = tmpHome();
  try {
    seedNumberedLogs(home, limits.LEGACY_MAX_FILES + 1);
    const detailed = legacy.legacyItemsDetailed(home);
    assert.strictEqual(detailed.items.length, limits.LEGACY_MAX_FILES);
    assert.strictEqual(detailed.omitted, 1, 'one candidate beyond the cap was dropped');
    // The thin wrapper is unchanged for every existing caller.
    assert.deepStrictEqual(legacy.legacyItems(home).map((i) => i.id),
      detailed.items.map((i) => i.id));
  } finally {
    cleanup(home);
  }
});

test('legacyItemsDetailed reports omitted:0 when nothing was dropped', () => {
  const home = tmpHome();
  try {
    seedNumberedLogs(home, limits.LEGACY_MAX_FILES);
    const detailed = legacy.legacyItemsDetailed(home);
    assert.strictEqual(detailed.items.length, limits.LEGACY_MAX_FILES);
    assert.strictEqual(detailed.omitted, 0);
  } finally {
    cleanup(home);
  }
});

test('26 legacy logs: listActivities reports truncated:true (the cap is no longer silent)', () => {
  const home = tmpHome();
  try {
    seedNumberedLogs(home, 26);                       // one more than LEGACY_MAX_FILES (25)
    const result = read.listActivities(home);
    assert.strictEqual(result.items.length, 25, 'the cap still bounds the page');
    assert.strictEqual(result.truncated, true,
      'the 26th log exists and is not shown -- the response must say so');
    // The export's own count is about what is on DISK and is unaffected by the cap.
    assert.strictEqual(legacy.legacyCandidateCount(home), 26);
    assert.ok(read.buildExport(home).includes('26 legacy sync log(s) present'));
  } finally {
    cleanup(home);
  }
});

test('25 legacy logs: listActivities reports truncated:false (nothing was hidden)', () => {
  const home = tmpHome();
  try {
    seedNumberedLogs(home, 25);
    const result = read.listActivities(home);
    assert.strictEqual(result.items.length, 25);
    assert.strictEqual(result.truncated, false, 'every candidate is on the page');
    assert.strictEqual(legacy.legacyCandidateCount(home), 25);
  } finally {
    cleanup(home);
  }
});

test('legacyCandidateCount never throws and refuses the same things legacyItems does', () => {
  assert.strictEqual(legacy.legacyCandidateCount(null), 0);
  assert.strictEqual(legacy.legacyCandidateCount(42), 0);
  assert.strictEqual(legacy.legacyCandidateCount(path.join(os.tmpdir(), 'rr-legacy-nope')), 0);
  const home = tmpHome();
  try {
    assert.strictEqual(legacy.legacyCandidateCount(home), 0, 'no log directory yet');
    // A symlinked log directory is refused here exactly as it is for the items.
    const evil = path.join(home, 'evil-logs');
    fs.mkdirSync(evil, { recursive: true });
    fs.writeFileSync(path.join(evil, 'sync-2026-08-14T09-31-05.log'), '[09:31:05] planted\n');
    fs.mkdirSync(path.join(home, 'Library', 'Logs'), { recursive: true });
    fs.symlinkSync(evil, logDir(home));
    assert.strictEqual(legacy.legacyCandidateCount(home), 0);
    assert.ok(!read.buildExport(home).includes('not included in this export'));
  } finally {
    cleanup(home);
  }
});

// -------------------------------------------------------------------------------------------
// 9. status.json stays System-ONLY (brief's second and third cases; spec finding 9)
// -------------------------------------------------------------------------------------------
test('status.json NEVER becomes a standalone item, but its errorLog/errorList DO appear in System', () => {
  const home = tmpHome();
  try {
    fs.mkdirSync(path.join(home, '.config', 'repo-radar'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'repo-radar', 'status.json'), JSON.stringify({
      errorLog: '\n⚠️ legacy failure while syncing owner/alpha',
      errorList: [{
        timestamp: '2026-08-13T04:05:06Z',
        repo: 'owner/alpha',
        message: 'clone failed',
        fullError: 'fatal: could not read from remote repository',
        stackTrace: 'Traceback (most recent call last): ...',
      }],
    }));
    seedLog(home, 'sync-2026-08-14T09-31-05.log', SAMPLE);

    // (a) Not an item -- not even with legacy adaptation switched on.
    const result = read.listActivities(home);
    assert.strictEqual(result.items.length, 1, 'only the sync log is an item');
    assert.strictEqual(result.items[0].id, 'legacy:sync-2026-08-14T09:31:05');
    const listed = JSON.stringify(result);
    assert.ok(!listed.includes('status.json'), 'status.json is never named as an item');
    assert.ok(!listed.includes('clone failed'), 'its error entries are not item content');

    // (b) But the legacy diagnostic surface IS present -- in the System section (Task 4.3).
    const diag = read.systemDiagnostics(home, { configuredSecrets: [] });
    assert.strictEqual(diag.uncorrelated, true);
    const st = diag.statusDiagnostics;
    assert.strictEqual(st.present, true);
    assert.ok(st.errorLog.text.includes('legacy failure while syncing owner/alpha'));
    assert.strictEqual(st.errorList.total, 1);
    assert.strictEqual(st.errorList.entries[0].repo, 'owner/alpha');
    assert.strictEqual(st.errorList.entries[0].message, 'clone failed');
    assert.ok(st.errorList.entries[0].stackTrace.includes('Traceback'));
  } finally {
    cleanup(home);
  }
});

test('the legacy adapter leaves the System streams alone (both surfaces, one directory)', () => {
  const home = tmpHome();
  try {
    seedLog(home, 'sync.error.log', 'shared stderr line\n');
    seedLog(home, 'sync-2026-08-14T09-31-05.log', SAMPLE);

    const diag = read.systemDiagnostics(home, { configuredSecrets: [] });
    const stream = diag.streams.find((s) => s.name === 'sync.error.log');
    assert.strictEqual(stream.present, true);
    assert.ok(stream.redactedTail.includes('shared stderr line'));
    // ...and the per-run log is NOT one of the four shared streams.
    assert.strictEqual(diag.streams.some((s) => s.name.startsWith('sync-')), false);
  } finally {
    cleanup(home);
  }
});
