'use strict';
// Task 3.6: read.js -- the reader capstone. Composes parse/merge/reconcile/redact into bounded,
// redacted, reader-facing DTOs. Mirrors reconcile.test.js's seeding style (raw JSONL written
// directly onto segment paths via paths.js primitives, bypassing writer.js/records.buildRecord
// entirely) since these tests exercise the READ side only. Every tmp dir this file creates is
// removed in a `finally` (prefixed `rr-read-`), per the repo's post-incident tmp-dir policy.
//
// Codex R1 (B1-B4/I3): `listActivities` now returns SUMMARY DTOs only; lens assertions
// (`events`/`problems`/`duplicateTerminals`) live against `getActivity`. `detail(home, aid, opts)`
// below is the shorthand every such assertion uses.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../index');
const read = require('../read');
const limits = require('../limits');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-read-'));
}

function cleanup(home) {
  fs.rmSync(home, { recursive: true, force: true });
}

function detail(home, aid, opts = {}) {
  const r = read.getActivity(home, aid, opts);
  assert.ok(r.item, `getActivity(${aid}) returned no item: ${r.reason}`);
  return r.item;
}

// Minimal valid v1 record builders (mirrors reconcile.test.js's writeRecord/writeStart, but
// local to this file since each test needs several activities with distinct ids/timestamps).
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

// Writes one segment (`${producer}-${writerId}.jsonl`) containing `records` in order, creating
// the activity dir first. A second call with a different writerId appends a second segment
// (multi-writer scenarios), never overwriting the first.
function seedSegment(home, aid, records, producer = 'python', writerId = 'deadbeef') {
  A.secureMkdir(A.activityDir(home, aid));
  const text = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(A.segmentPath(home, aid, producer, writerId), text);
}

// -----------------------------------------------------------------------------------------------
// 1. End-to-end over a seeded store with a couple of complete activities.
// -----------------------------------------------------------------------------------------------
test('listActivities: end-to-end over two complete activities -- DTO shape, counts, newest-first', () => {
  const home = tmpHome();
  try {
    const aidOld = '00000000-0000-4000-8000-00000000000a';
    const aidNew = '00000000-0000-4000-8000-00000000000b';

    seedSegment(home, aidOld, [
      startRec(aidOld, 0, '2026-08-10T00:00:00-07:00', { channel: 'stable', trigger: 'cli' }),
      eventRec(aidOld, 1, '2026-08-10T00:00:01-07:00', 'info', 'repo.synced'),
      eventRec(aidOld, 2, '2026-08-10T00:00:02-07:00', 'warn', 'repo.degraded'),
      terminalRec(aidOld, 3, '2026-08-10T00:05:00-07:00', 'succeeded-with-warnings'),
    ]);

    seedSegment(home, aidNew, [
      startRec(aidNew, 0, '2026-08-12T00:00:00-07:00', { channel: 'dev', trigger: 'scheduled' }),
      eventRec(aidNew, 1, '2026-08-12T00:00:01-07:00', 'error', 'repo.failed'),
      terminalRec(aidNew, 2, '2026-08-12T00:02:00-07:00', 'failed'),
    ]);

    const result = read.listActivities(home);
    assert.strictEqual(result.available, true);
    assert.strictEqual(result.incomplete, false);
    assert.strictEqual(result.truncated, false);
    assert.strictEqual(result.items.length, 2);

    // newest-first
    assert.strictEqual(result.items[0].id, aidNew);
    assert.strictEqual(result.items[1].id, aidOld);

    const newer = result.items[0];
    assert.strictEqual(newer.outcome, 'failed');
    assert.strictEqual(newer.channel, 'dev');
    assert.strictEqual(newer.trigger, 'scheduled');
    assert.strictEqual(newer.kind, 'sync');
    assert.strictEqual(newer.errorCount, 1);
    assert.strictEqual(newer.warnCount, 0);
    assert.strictEqual(newer.startedAt, '2026-08-12T00:00:00-07:00');
    assert.strictEqual(newer.endedAt, '2026-08-12T00:02:00-07:00');
    assert.strictEqual(typeof newer.duration, 'number');
    assert.ok(newer.duration > 0);
    assert.strictEqual(newer.incomplete, false);
    assert.strictEqual(newer.synthesized, false);
    // Summary DTOs carry NO lens arrays (Codex R1 B4).
    assert.ok(!('events' in newer) && !('problems' in newer) && !('duplicateTerminals' in newer));

    const newerDetail = detail(home, aidNew);
    assert.strictEqual(newerDetail.events.length, 1);
    assert.strictEqual(newerDetail.events[0].event, 'repo.failed');
    assert.strictEqual(newerDetail.events[0].writerId, 'deadbeef');
    assert.strictEqual(newerDetail.events[0].producer, 'python');

    const older = result.items[1];
    assert.strictEqual(older.outcome, 'succeeded-with-warnings');
    assert.strictEqual(older.errorCount, 0);
    assert.strictEqual(older.warnCount, 1);
    assert.strictEqual(detail(home, aidOld).events.length, 2);
  } finally {
    cleanup(home);
  }
});

// -----------------------------------------------------------------------------------------------
// 2. A crashed `running` item (durable start, no terminal, no held lock) reconciles to
//    `interrupted` -- the Phase-3 gate.
// -----------------------------------------------------------------------------------------------
test('listActivities: a crashed running activity (start, no terminal, no lock) reconciles to interrupted', () => {
  const home = tmpHome();
  try {
    const aid = '00000000-0000-4000-8000-00000000000c';
    seedSegment(home, aid, [
      startRec(aid, 0, '2026-08-11T00:00:00-07:00'),
    ]);
    // deliberately no owner.lock file at all -- the default probe folds lock-absent to FREE.

    const result = read.listActivities(home);
    assert.strictEqual(result.items.length, 1);
    const item = result.items[0];
    assert.strictEqual(item.id, aid);
    assert.strictEqual(item.outcome, 'interrupted'); // synthesized, durable, visible to the reader
    assert.strictEqual(item.endedAt !== null, true); // the synthetic terminal's ts is now readable

    // Read-triggering it durably wrote a terminal -- a second read must see the SAME outcome
    // without re-synthesizing (idempotent, no duplicate terminal storm).
    const again = read.listActivities(home);
    assert.strictEqual(again.items[0].outcome, 'interrupted');
    assert.strictEqual(detail(home, aid).duplicateTerminals.length, 0);
  } finally {
    cleanup(home);
  }
});

// -----------------------------------------------------------------------------------------------
// 3. Redaction on a DTO -- a credential form AND a configured secret.
// -----------------------------------------------------------------------------------------------
test('listActivities: redacts a credential form and a configured secret from event text', () => {
  const home = tmpHome();
  try {
    const aid = '00000000-0000-4000-8000-00000000000d';
    const secret = 'my-configured-secret-xyz';
    seedSegment(home, aid, [
      startRec(aid, 0, '2026-08-13T00:00:00-07:00'),
      eventRec(aid, 1, '2026-08-13T00:00:01-07:00', 'error', 'auth.failed', {
        detail: `token ghp_abcdefghijklmnopqrst1234 rejected; secret ${secret} also leaked`,
        fields: { note: `contains ${secret} inline` },
      }),
      terminalRec(aid, 2, '2026-08-13T00:01:00-07:00', 'failed'),
    ]);

    const item = detail(home, aid, { configuredSecrets: [secret] });
    assert.strictEqual(item.events.length, 1);
    const text = item.events[0].detail;
    assert.ok(!text.includes('ghp_abcdefghijklmnopqrst1234'), 'github token must be masked');
    assert.ok(!text.includes(secret), 'configured secret must be masked');
    assert.ok(text.includes('[REDACTED'), 'a redaction marker must be present');

    const note = item.events[0].fields.note;
    assert.ok(!note.includes(secret), 'configured secret must be masked in fields too');
    assert.ok(note.includes('[REDACTED]'));
  } finally {
    cleanup(home);
  }
});

// -----------------------------------------------------------------------------------------------
// 4. `truncated` flag when seeded activity count exceeds LIST_MAX.
// -----------------------------------------------------------------------------------------------
test('listActivities: sets truncated=true and caps items.length at LIST_MAX when over budget', () => {
  const home = tmpHome();
  const origListMax = limits.LIST_MAX;
  try {
    limits.LIST_MAX = 2; // monkeypatch the shared constants module (property, not destructured)
    const aids = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
    ];
    aids.forEach((aid, i) => {
      seedSegment(home, aid, [
        startRec(aid, 0, `2026-08-1${i}T00:00:00-07:00`),
        terminalRec(aid, 1, `2026-08-1${i}T00:01:00-07:00`, 'succeeded'),
      ]);
    });

    const result = read.listActivities(home);
    assert.strictEqual(result.truncated, true);
    assert.strictEqual(result.items.length, 2);
  } finally {
    limits.LIST_MAX = origListMax;
    cleanup(home);
  }
});

// -----------------------------------------------------------------------------------------------
// 5. The three store states.
// -----------------------------------------------------------------------------------------------
test('listActivities: a missing activity root is normal empty history (available, not incomplete)', () => {
  const home = tmpHome(); // freshly created tmp dir -- Library/Logs/repo-radar/activity never made
  try {
    const result = read.listActivities(home);
    assert.deepStrictEqual(result, { items: [], truncated: false, available: true, incomplete: false, problems: [] });
  } finally {
    cleanup(home);
  }
});

test('listActivities: an unreadable activity root is reported unavailable', (t) => {
  if (process.getuid && process.getuid() === 0) {
    t.skip('running as root -- permission bits are not enforced');
    return;
  }
  const home = tmpHome();
  const base = path.join(home, 'Library', 'Logs', 'repo-radar', 'activity');
  fs.mkdirSync(base, { recursive: true });
  fs.chmodSync(base, 0o000);
  try {
    const result = read.listActivities(home);
    assert.strictEqual(result.available, false);
    assert.deepStrictEqual(result.items, []);
    assert.strictEqual(result.truncated, false);
    assert.strictEqual(result.incomplete, false);
  } finally {
    fs.chmodSync(base, 0o700); // restore before cleanup, or rmSync can itself fail
    cleanup(home);
  }
});

test('listActivities: a corrupt interior segment line marks the store incomplete', () => {
  const home = tmpHome();
  try {
    const aid = '00000000-0000-4000-8000-00000000000e';
    A.secureMkdir(A.activityDir(home, aid));
    const lines = [
      JSON.stringify(startRec(aid, 0, '2026-08-14T00:00:00-07:00')),
      '{not valid json at all',
      JSON.stringify(terminalRec(aid, 1, '2026-08-14T00:01:00-07:00', 'succeeded')),
    ];
    fs.writeFileSync(A.segmentPath(home, aid, 'python', 'deadbeef'), lines.join('\n') + '\n');

    const result = read.listActivities(home);
    assert.strictEqual(result.available, true);
    assert.strictEqual(result.incomplete, true);
    assert.strictEqual(result.items[0].outcome, 'succeeded'); // the valid records are still readable
    assert.strictEqual(result.items[0].incomplete, true);
    assert.ok(detail(home, aid).problems.some((p) => /corrupt/i.test(p.kind)));
  } finally {
    cleanup(home);
  }
});

test('listActivities: an UNCERTAIN lease probe (non-regular owner.lock) marks the store incomplete', () => {
  const home = tmpHome();
  try {
    const aid = '00000000-0000-4000-8000-00000000000f';
    seedSegment(home, aid, [startRec(aid, 0, '2026-08-14T00:00:00-07:00')]);
    // A directory in place of owner.lock -- lease.probe's open fails non-ELOOP, caught as UNCERTAIN.
    fs.mkdirSync(A.ownerLockPath(home, aid));

    const result = read.listActivities(home);
    assert.strictEqual(result.incomplete, true);
    assert.strictEqual(result.items[0].outcome, 'running'); // never guesses a dead owner
    assert.ok(detail(home, aid).problems.some((p) => /uncertain/i.test(p.kind)));
  } finally {
    cleanup(home);
  }
});

// -----------------------------------------------------------------------------------------------
// 6. buildExport + validateFilter.
// -----------------------------------------------------------------------------------------------
test('buildExport: returns redacted, human-readable text covering seeded activities', () => {
  const home = tmpHome();
  try {
    const aid = '00000000-0000-4000-8000-000000000010';
    const secret = 'export-secret-value-1';
    seedSegment(home, aid, [
      startRec(aid, 0, '2026-08-14T00:00:00-07:00'),
      eventRec(aid, 1, '2026-08-14T00:00:01-07:00', 'error', 'auth.failed', {
        detail: `leaked ${secret}`,
      }),
      terminalRec(aid, 2, '2026-08-14T00:01:00-07:00', 'failed'),
    ]);

    const text = read.buildExport(home, {}, { configuredSecrets: [secret] });
    assert.strictEqual(typeof text, 'string');
    assert.ok(text.includes(aid));
    assert.ok(text.includes('auth.failed'));
    assert.ok(!text.includes(secret), 'export must not leak the configured secret');
    assert.ok(text.includes('[REDACTED]'));
  } finally {
    cleanup(home);
  }
});

test('buildExport: truncates at EXPORT_MAX_BYTES with a visible marker', () => {
  const home = tmpHome();
  const orig = limits.EXPORT_MAX_BYTES;
  try {
    limits.EXPORT_MAX_BYTES = 2048; // monkeypatch small so a modest seed overflows it
    const aid = '00000000-0000-4000-8000-000000000011';
    const recs = [startRec(aid, 0, '2026-08-14T00:00:00-07:00')];
    for (let i = 1; i <= 200; i++) {
      recs.push(eventRec(aid, i, '2026-08-14T00:00:01-07:00', 'info', `event.number.${i}`, {
        detail: 'padding '.repeat(20),
      }));
    }
    recs.push(terminalRec(aid, 201, '2026-08-14T00:05:00-07:00', 'succeeded'));
    seedSegment(home, aid, recs);

    const text = read.buildExport(home);
    assert.ok(Buffer.byteLength(text, 'utf8') <= limits.EXPORT_MAX_BYTES + 200); // marker overhead
    assert.ok(text.includes('truncated'), 'a visible truncation marker must be present');
  } finally {
    limits.EXPORT_MAX_BYTES = orig;
    cleanup(home);
  }
});

test('validateFilter: rejects an invalid level, an over-length search, and is used by both entry points', () => {
  assert.throws(() => read.validateFilter({ level: 'nope' }), read.InvalidFilter);
  assert.throws(() => read.validateFilter({ search: 'x'.repeat(limits.SEARCH_MAX + 1) }), read.InvalidFilter);
  assert.doesNotThrow(() => read.validateFilter({}));
  assert.doesNotThrow(() => read.validateFilter());

  const home = tmpHome();
  try {
    assert.throws(() => read.listActivities(home, { level: 'nope' }), read.InvalidFilter);
    assert.throws(() => read.buildExport(home, { search: 'x'.repeat(300) }), read.InvalidFilter);
  } finally {
    cleanup(home);
  }
});

// -----------------------------------------------------------------------------------------------
// Review R1 fixes (base commit a5f319c):
//   I1 -- channel/trigger/kind bypassed the redactor.
//   I2 -- the store-root probe followed symlinks (statSync), misreporting a symlinked root as
//         normal empty history instead of unavailable.
//   I3 -- validateFilter's limit/offset rejection paths were untested.
// -----------------------------------------------------------------------------------------------

test('listActivities/buildExport: redacts a configured secret embedded in channel/trigger (I1)', () => {
  const home = tmpHome();
  try {
    const aid = '00000000-0000-4000-8000-000000000012';
    const secret = 'channel-secret-value-1';
    seedSegment(home, aid, [
      startRec(aid, 0, '2026-08-14T00:00:00-07:00', {
        channel: `stable-${secret}`,
        trigger: `cli-${secret}`,
      }),
      terminalRec(aid, 1, '2026-08-14T00:01:00-07:00', 'succeeded'),
    ]);

    const result = read.listActivities(home, {}, { configuredSecrets: [secret] });
    const item = result.items[0];
    assert.ok(!item.channel.includes(secret), 'DTO channel must be masked');
    assert.ok(item.channel.includes('[REDACTED]'));
    assert.ok(!item.trigger.includes(secret), 'DTO trigger must be masked');
    assert.ok(item.trigger.includes('[REDACTED]'));

    const text = read.buildExport(home, {}, { configuredSecrets: [secret] });
    assert.ok(!text.includes(secret), 'export text must not leak the secret via channel/trigger');
    assert.ok(text.includes('[REDACTED]'));
  } finally {
    cleanup(home);
  }
});

test('listActivities: a symlinked activity root is reported unavailable, not empty history (I2)', () => {
  const home = tmpHome();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-read-symtarget-'));
  try {
    const parentDir = path.join(home, 'Library', 'Logs', 'repo-radar');
    fs.mkdirSync(parentDir, { recursive: true });
    const base = path.join(parentDir, 'activity');
    fs.symlinkSync(target, base, 'dir'); // the root itself is a symlink, not a real directory

    const result = read.listActivities(home);
    assert.strictEqual(result.available, false);
    assert.deepStrictEqual(result.items, []);
    assert.strictEqual(result.truncated, false);
    assert.strictEqual(result.incomplete, false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true }); // removes the symlink entry, not its target
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('validateFilter: rejects limit > LIST_MAX, negative limit, and negative offset (I3)', () => {
  assert.throws(() => read.validateFilter({ limit: limits.LIST_MAX + 1 }), read.InvalidFilter);
  assert.throws(() => read.validateFilter({ limit: -1 }), read.InvalidFilter);
  assert.throws(() => read.validateFilter({ offset: -1 }), read.InvalidFilter);
  assert.doesNotThrow(() => read.validateFilter({ limit: limits.LIST_MAX, offset: 0 }));

  const home = tmpHome();
  try {
    assert.throws(() => read.listActivities(home, { limit: limits.LIST_MAX + 1 }), read.InvalidFilter);
    assert.throws(() => read.listActivities(home, { offset: -1 }), read.InvalidFilter);
    assert.throws(() => read.buildExport(home, { limit: -1 }), read.InvalidFilter);
  } finally {
    cleanup(home);
  }
});

// -----------------------------------------------------------------------------------------------
// Codex R1 fixes (B1-B4 / I3) -- see read.js header.
// -----------------------------------------------------------------------------------------------

// --- B1: Problems lens carries user-facing problems + isProblemBearing -------------------------

test('B1: a succeeded item with an error event is problem-bearing and its Problems lens carries the event', () => {
  const home = tmpHome();
  try {
    const aid = '00000000-0000-4000-8000-000000000020';
    seedSegment(home, aid, [
      startRec(aid, 0, '2026-08-14T00:00:00-07:00'),
      eventRec(aid, 1, '2026-08-14T00:00:01-07:00', 'info', 'repo.synced'),
      eventRec(aid, 2, '2026-08-14T00:00:02-07:00', 'error', 'repo.failed', {
        detail: 'boom', fields: { repo: 'x/y' },
      }),
      terminalRec(aid, 3, '2026-08-14T00:01:00-07:00', 'succeeded'),
    ]);

    const summary = read.listActivities(home).items[0];
    assert.strictEqual(summary.errorCount, 1);
    assert.strictEqual(summary.hasProblems, true);
    assert.strictEqual(summary.problemCount, 1);

    const item = detail(home, aid);
    assert.strictEqual(item.problems.length, 1);
    const p = item.problems[0];
    assert.strictEqual(p.kind, 'event');
    assert.strictEqual(p.level, 'error');
    assert.strictEqual(p.event, 'repo.failed');
    assert.strictEqual(p.detail, 'boom');
    assert.deepStrictEqual(p.fields, { repo: 'x/y' });
    assert.strictEqual(p.ts, '2026-08-14T00:00:02-07:00');
    assert.strictEqual(p.seq, 2);
    assert.strictEqual(p.writerId, 'deadbeef');
    assert.strictEqual(p.producer, 'python');
  } finally {
    cleanup(home);
  }
});

test('B1: a blocked terminal surfaces as a terminal problem carrying its (redacted) summary', () => {
  const home = tmpHome();
  try {
    const aid = '00000000-0000-4000-8000-000000000021';
    const secret = 'blocked-reason-secret-1';
    seedSegment(home, aid, [
      startRec(aid, 0, '2026-08-14T00:00:00-07:00'),
      terminalRec(aid, 1, '2026-08-14T00:00:05-07:00', 'blocked', {
        summary: { reason: `guard failed: ${secret}`, code: 7 },
      }),
    ]);

    const summary = read.listActivities(home, {}, { configuredSecrets: [secret] }).items[0];
    assert.strictEqual(summary.outcome, 'blocked');
    assert.strictEqual(summary.hasProblems, true);
    assert.strictEqual(summary.problemCount, 1);

    const item = detail(home, aid, { configuredSecrets: [secret] });
    assert.strictEqual(item.problems.length, 1);
    const p = item.problems[0];
    assert.strictEqual(p.kind, 'terminal');
    assert.strictEqual(p.outcome, 'blocked');
    assert.strictEqual(p.by, 'deadbeef');
    assert.strictEqual(p.summary.code, 7);
    assert.ok(!p.summary.reason.includes(secret));
    assert.ok(p.summary.reason.includes('[REDACTED]'));
    assert.strictEqual(p.writerId, 'deadbeef');

    const text = read.buildExport(home, {}, { configuredSecrets: [secret] });
    assert.ok(text.includes('[terminal]'));
    assert.ok(!text.includes(secret));
  } finally {
    cleanup(home);
  }
});

test('B1: succeeded/cancelled/skipped with only info events are NOT problem-bearing', () => {
  const home = tmpHome();
  try {
    const cases = [
      ['00000000-0000-4000-8000-000000000022', 'succeeded'],
      ['00000000-0000-4000-8000-000000000023', 'cancelled'],
      ['00000000-0000-4000-8000-000000000024', 'skipped'],
    ];
    for (const [aid, outcome] of cases) {
      seedSegment(home, aid, [
        startRec(aid, 0, '2026-08-14T00:00:00-07:00'),
        eventRec(aid, 1, '2026-08-14T00:00:01-07:00', 'info', 'fine'),
        terminalRec(aid, 2, '2026-08-14T00:01:00-07:00', outcome),
      ]);
    }
    const result = read.listActivities(home);
    assert.strictEqual(result.items.length, 3);
    for (const s of result.items) {
      assert.strictEqual(s.hasProblems, false, s.outcome);
      assert.strictEqual(s.problemCount, 0);
      assert.deepStrictEqual(detail(home, s.id).problems, []);
    }
  } finally {
    cleanup(home);
  }
});

test('B1: an integrity record is problem-bearing and rendered in the Problems lens', () => {
  const home = tmpHome();
  try {
    const aid = '00000000-0000-4000-8000-000000000025';
    seedSegment(home, aid, [
      startRec(aid, 0, '2026-08-14T00:00:00-07:00'),
      { schema_version: 1, activity_id: aid, type: 'integrity', seq: 1, ts: '2026-08-14T00:00:01-07:00', kind: 'observability-write-failed' },
      terminalRec(aid, 2, '2026-08-14T00:01:00-07:00', 'succeeded'),
    ]);
    const summary = read.listActivities(home).items[0];
    assert.strictEqual(summary.hasProblems, true);
    const item = detail(home, aid);
    assert.ok(item.problems.some((p) => p.kind === 'integrity' && p.reason === 'observability-write-failed' && p.writerId === 'deadbeef'));
  } finally {
    cleanup(home);
  }
});

test('B1/R2: isProblemBearing is pure and matches the Ruling-33/37 predicate over a scan', () => {
  const aid = '00000000-0000-4000-8000-000000000000';
  const t = '2026-08-14T00:00:00-07:00';
  const scan = (records, findings = [], rejected = []) => ({ records, findings, rejected });
  // (a)-(c): record-derived
  assert.strictEqual(read.isProblemBearing(scan([startRec(aid, 0, t), terminalRec(aid, 1, t, 'succeeded')])), false);
  assert.strictEqual(read.isProblemBearing(scan([startRec(aid, 0, t), eventRec(aid, 1, t, 'warn', 'x'), terminalRec(aid, 2, t, 'succeeded')])), true);
  assert.strictEqual(read.isProblemBearing(scan([startRec(aid, 0, t), terminalRec(aid, 1, t, 'interrupted')])), true);
  assert.strictEqual(read.isProblemBearing(scan([startRec(aid, 0, t), terminalRec(aid, 1, t, 'skipped')])), false);
  assert.strictEqual(read.isProblemBearing(scan([{ type: 'integrity', kind: 'x' }])), true);
  // (d) findings, (e) rejected (incl. bad-name)
  assert.strictEqual(read.isProblemBearing(scan([startRec(aid, 0, t)], [{ kind: 'corrupt-json' }])), true);
  assert.strictEqual(read.isProblemBearing(scan([startRec(aid, 0, t)], [], [{ name: 'python-s3cr3t.jsonl', reason: 'bad-name' }])), true);
  assert.strictEqual(read.isProblemBearing(scan([startRec(aid, 0, t)], [], [{ name: 'python-deadbeef.jsonl', reason: 'symlink' }])), true);
  // (f) >= 2 terminals: exact duplicate OR conflict
  assert.strictEqual(read.isProblemBearing(scan([startRec(aid, 0, t), terminalRec(aid, 1, t, 'succeeded'), terminalRec(aid, 2, t, 'succeeded')])), true);
  assert.strictEqual(read.isProblemBearing(scan([startRec(aid, 0, t), terminalRec(aid, 1, t, 'succeeded'), terminalRec(aid, 2, t, 'cancelled')])), true);
  // degenerate inputs
  assert.strictEqual(read.isProblemBearing(scan([])), false);
  assert.strictEqual(read.isProblemBearing({}), false);
  assert.strictEqual(read.isProblemBearing(null), false);
  // legacy bare-array shape is still accepted as `{ records }`
  assert.strictEqual(read.isProblemBearing([startRec(aid, 0, t), terminalRec(aid, 1, t, 'failed')]), true);
  assert.strictEqual(read.isProblemBearing([]), false);
});

// --- B2: honest lifecycle states -----------------------------------------------------------------

test('B2: an empty activity directory (reserve-before-start) yields NO item', () => {
  const home = tmpHome();
  try {
    const aid = '00000000-0000-4000-8000-000000000030';
    A.secureMkdir(A.activityDir(home, aid));
    const result = read.listActivities(home);
    assert.deepStrictEqual(result, { items: [], truncated: false, available: true, incomplete: false, problems: [] });
    const one = read.getActivity(home, aid);
    assert.strictEqual(one.item, null);
    assert.strictEqual(one.reason, 'not-started');
    assert.strictEqual(one.available, true);
    assert.ok(!read.buildExport(home).includes(aid));
  } finally {
    cleanup(home);
  }
});

test('B2: a start segment replaced by a symlink is unknown + rejected-segment + incomplete, never running', () => {
  const home = tmpHome();
  try {
    const aid = '00000000-0000-4000-8000-000000000031';
    A.secureMkdir(A.activityDir(home, aid));
    const victim = path.join(home, 'victim.jsonl');
    fs.writeFileSync(victim, JSON.stringify(startRec(aid, 0, '2026-08-14T00:00:00-07:00')) + '\n');
    fs.symlinkSync(victim, A.segmentPath(home, aid, 'python', 'deadbeef'));

    const result = read.listActivities(home);
    assert.strictEqual(result.items.length, 1);
    assert.strictEqual(result.incomplete, true);
    const s = result.items[0];
    assert.strictEqual(s.outcome, 'unknown');
    assert.strictEqual(s.incomplete, true);
    assert.strictEqual(s.startedAt, null);
    assert.strictEqual(s.hasProblems, true);

    const item = detail(home, aid);
    assert.ok(item.problems.some((p) => p.kind === 'rejected-segment' && p.reason === 'symlink' && p.name === 'python-deadbeef.jsonl'));
    assert.ok(item.problems.some((p) => p.kind === 'integrity' && p.reason === 'no-start'));
  } finally {
    cleanup(home);
  }
});

test('B2: records but no start is unknown + no-start integrity + incomplete', () => {
  const home = tmpHome();
  try {
    const aid = '00000000-0000-4000-8000-000000000032';
    seedSegment(home, aid, [
      eventRec(aid, 0, '2026-08-14T00:00:01-07:00', 'info', 'orphan'),
    ]);
    const result = read.listActivities(home);
    assert.strictEqual(result.items.length, 1);
    assert.strictEqual(result.incomplete, true);
    assert.strictEqual(result.items[0].outcome, 'unknown');
    assert.strictEqual(result.items[0].incomplete, true);
    const item = detail(home, aid);
    assert.ok(item.problems.some((p) => p.kind === 'integrity' && p.reason === 'no-start'));
    assert.strictEqual(item.events.length, 1); // the orphan event is still visible
  } finally {
    cleanup(home);
  }
});

test('B2: a start with a HELD owner.lock is running (not interrupted, not unknown)', () => {
  const home = tmpHome();
  let held = null;
  try {
    const aid = '00000000-0000-4000-8000-000000000033';
    seedSegment(home, aid, [startRec(aid, 0, '2026-08-14T00:00:00-07:00')]);
    held = A.acquire(A.ownerLockPath(home, aid));
    assert.ok(held, 'test setup: lease must be acquirable');

    const result = read.listActivities(home);
    assert.strictEqual(result.items[0].outcome, 'running');
    assert.strictEqual(result.items[0].endedAt, null);
    assert.strictEqual(result.items[0].incomplete, false);
    assert.strictEqual(detail(home, aid).outcome, 'running');
  } finally {
    if (held) { try { held.release(); } catch (e) { /* discarded */ } }
    cleanup(home);
  }
});

test('B2: a permission-denied segment is a rejected-segment problem and marks the item incomplete', (t) => {
  if (process.getuid && process.getuid() === 0) {
    t.skip('running as root -- permission bits are not enforced');
    return;
  }
  const home = tmpHome();
  const aid = '00000000-0000-4000-8000-000000000034';
  seedSegment(home, aid, [
    startRec(aid, 0, '2026-08-14T00:00:00-07:00'),
    terminalRec(aid, 1, '2026-08-14T00:01:00-07:00', 'succeeded'),
  ]);
  seedSegment(home, aid, [
    eventRec(aid, 5, '2026-08-14T00:00:30-07:00', 'info', 'hidden'),
  ], 'electron', 'cafef00d');
  const denied = A.segmentPath(home, aid, 'electron', 'cafef00d');
  fs.chmodSync(denied, 0o000);
  try {
    const result = read.listActivities(home);
    assert.strictEqual(result.incomplete, true);
    assert.strictEqual(result.items[0].outcome, 'succeeded');
    assert.strictEqual(result.items[0].incomplete, true);
    const item = detail(home, aid);
    assert.ok(item.problems.some((p) => p.kind === 'rejected-segment' && p.reason === 'denied' && p.name === 'electron-cafef00d.jsonl'));
  } finally {
    fs.chmodSync(denied, 0o600); // restore before cleanup
    cleanup(home);
  }
});

// --- B3: redaction covers every returned string ---------------------------------------------------

test('B3: a configured secret used as a field KEY is absent from the DTO and the export', () => {
  const home = tmpHome();
  try {
    const aid = '00000000-0000-4000-8000-000000000040';
    const secret = 'key-secret-value-abc';
    seedSegment(home, aid, [
      startRec(aid, 0, '2026-08-14T00:00:00-07:00'),
      eventRec(aid, 1, '2026-08-14T00:00:01-07:00', 'warn', 'x', { fields: { [secret]: 'v', [`pre-${secret}-post`]: 1 } }),
      terminalRec(aid, 2, '2026-08-14T00:01:00-07:00', 'failed', { summary: { [secret]: 'why' } }),
    ]);
    const item = detail(home, aid, { configuredSecrets: [secret] });
    const dumped = JSON.stringify(item);
    assert.ok(!dumped.includes(secret), 'secret key must not reach the DTO anywhere');
    assert.ok(Object.keys(item.events[0].fields).some((k) => k.includes('[REDACTED]')));
    const text = read.buildExport(home, {}, { configuredSecrets: [secret] });
    assert.ok(!text.includes(secret), 'secret key must not reach the export');
  } finally {
    cleanup(home);
  }
});

test('B3: a non-conforming segment name is never parsed as a writer; its name is scrubbed and reported as bad-name', () => {
  const home = tmpHome();
  try {
    const aid = '00000000-0000-4000-8000-000000000041';
    const secret = 's3cr3tvalue';
    seedSegment(home, aid, [
      startRec(aid, 0, '2026-08-14T00:00:00-07:00'),
      terminalRec(aid, 1, '2026-08-14T00:01:00-07:00', 'succeeded'),
    ]);
    // Bypass segmentPath's own validation: write a badly-named file straight into the dir.
    const bad = path.join(A.activityDir(home, aid), `python-${secret}.jsonl`);
    fs.writeFileSync(bad, JSON.stringify(eventRec(aid, 7, '2026-08-14T00:00:30-07:00', 'error', 'smuggled')) + '\n');

    const result = read.listActivities(home, {}, { configuredSecrets: [secret] });
    assert.strictEqual(result.incomplete, true);
    assert.strictEqual(result.items[0].incomplete, true);
    assert.strictEqual(result.items[0].errorCount, 0, 'records in a bad-named file are not counted');

    const item = detail(home, aid, { configuredSecrets: [secret] });
    const dumped = JSON.stringify(item);
    assert.ok(!dumped.includes(secret), 'filename-derived secret must not reach the DTO');
    assert.ok(!item.events.some((e) => e.event === 'smuggled'));
    const bn = item.problems.find((p) => p.kind === 'rejected-segment' && p.reason === 'bad-name');
    assert.ok(bn, 'bad-name problem present');
    assert.ok(bn.name.includes('[REDACTED]'));

    const text = read.buildExport(home, {}, { configuredSecrets: [secret] });
    assert.ok(!text.includes(secret));
    assert.ok(text.includes('bad-name'));
  } finally {
    cleanup(home);
  }
});

// --- B4: bounded DTO contract + summary/detail split -------------------------------------------

test('B4: a 100 KB channel is bounded (FIELD_MAX_BYTES on detail, SUMMARY_FIELD_MAX_BYTES on summary) with a marker', () => {
  const home = tmpHome();
  try {
    const aid = '00000000-0000-4000-8000-000000000050';
    const huge = 'c'.repeat(100 * 1024);
    seedSegment(home, aid, [
      startRec(aid, 0, '2026-08-14T00:00:00-07:00', { channel: huge, trigger: huge }),
      terminalRec(aid, 1, '2026-08-14T00:01:00-07:00', 'succeeded'),
    ]);
    const s = read.listActivities(home).items[0];
    assert.ok(Buffer.byteLength(s.channel, 'utf8') <= limits.SUMMARY_FIELD_MAX_BYTES);
    assert.ok(s.channel.endsWith('[truncated]'));
    assert.ok(Buffer.byteLength(JSON.stringify(s), 'utf8') <= limits.SUMMARY_MAX_BYTES);

    const item = detail(home, aid);
    assert.ok(Buffer.byteLength(item.channel, 'utf8') <= limits.FIELD_MAX_BYTES);
    assert.ok(item.channel.endsWith('[truncated]'));
    assert.ok(Buffer.byteLength(item.trigger, 'utf8') <= limits.FIELD_MAX_BYTES);
  } finally {
    cleanup(home);
  }
});

test('B4: 50k corrupt interior lines -> problems capped at PROBLEMS_MAX_ROWS+1, problemCount = total, item <= DETAIL_MAX_BYTES', () => {
  const home = tmpHome();
  try {
    const aid = '00000000-0000-4000-8000-000000000051';
    A.secureMkdir(A.activityDir(home, aid));
    const lines = [JSON.stringify(startRec(aid, 0, '2026-08-14T00:00:00-07:00'))];
    for (let i = 0; i < 50000; i++) lines.push('{corrupt line ' + i);
    lines.push(JSON.stringify(terminalRec(aid, 1, '2026-08-14T00:01:00-07:00', 'succeeded')));
    fs.writeFileSync(A.segmentPath(home, aid, 'python', 'deadbeef'), lines.join('\n') + '\n');

    const s = read.listActivities(home).items[0];
    assert.strictEqual(s.problemCount, 50000);
    assert.strictEqual(s.hasProblems, true);
    assert.strictEqual(s.incomplete, true);

    const item = detail(home, aid);
    assert.ok(item.problems.length <= limits.PROBLEMS_MAX_ROWS + 1);
    const marker = item.problems[item.problems.length - 1];
    assert.strictEqual(marker.kind, 'truncated');
    assert.strictEqual(marker.dropped, 50000 - limits.PROBLEMS_MAX_ROWS);
    assert.strictEqual(item.problemCount, 50000);
    assert.ok(Buffer.byteLength(JSON.stringify(item), 'utf8') <= limits.DETAIL_MAX_BYTES);
  } finally {
    cleanup(home);
  }
});

test('B4: whole-item cap -- an item over DETAIL_MAX_BYTES has events then problems dropped until it fits', () => {
  const home = tmpHome();
  const orig = limits.DETAIL_MAX_BYTES;
  try {
    limits.DETAIL_MAX_BYTES = 8 * 1024;
    const aid = '00000000-0000-4000-8000-000000000052';
    const recs = [startRec(aid, 0, '2026-08-14T00:00:00-07:00')];
    for (let i = 1; i <= 60; i++) {
      recs.push(eventRec(aid, i, '2026-08-14T00:00:01-07:00', i % 2 ? 'warn' : 'info', `e${i}`, { detail: 'p'.repeat(200) }));
    }
    recs.push(terminalRec(aid, 61, '2026-08-14T00:01:00-07:00', 'succeeded'));
    seedSegment(home, aid, recs);

    const item = detail(home, aid);
    assert.ok(Buffer.byteLength(JSON.stringify(item), 'utf8') <= limits.DETAIL_MAX_BYTES);
    assert.strictEqual(item.problemCount, 30);
    assert.ok(item.problems.length >= 1);
    assert.strictEqual(item.truncatedEvents, true);
    if (item.problems.length < 31) {
      const marker = item.problems[item.problems.length - 1];
      assert.strictEqual(marker.kind, 'truncated');
      assert.strictEqual(marker.dropped + (item.problems.length - 1), 30);
    }
  } finally {
    limits.DETAIL_MAX_BYTES = orig;
    cleanup(home);
  }
});

test('B4: listActivities summaries have no lens arrays and each is <= SUMMARY_MAX_BYTES', () => {
  const home = tmpHome();
  try {
    for (let i = 0; i < 5; i++) {
      const aid = `00000000-0000-4000-8000-00000000006${i}`;
      const recs = [startRec(aid, 0, `2026-08-1${i}T00:00:00-07:00`, { channel: 'x'.repeat(5000) })];
      for (let j = 1; j <= 50; j++) recs.push(eventRec(aid, j, `2026-08-1${i}T00:00:01-07:00`, 'error', 'e', { detail: 'd'.repeat(1000) }));
      recs.push(terminalRec(aid, 51, `2026-08-1${i}T00:01:00-07:00`, 'failed'));
      seedSegment(home, aid, recs);
    }
    const result = read.listActivities(home);
    assert.strictEqual(result.items.length, 5);
    for (const s of result.items) {
      assert.ok(!('events' in s));
      assert.ok(!('problems' in s));
      assert.ok(!('duplicateTerminals' in s));
      assert.ok(Buffer.byteLength(JSON.stringify(s), 'utf8') <= limits.SUMMARY_MAX_BYTES);
      assert.deepStrictEqual(Object.keys(s).sort(), [
        'channel', 'duration', 'endedAt', 'errorCount', 'hasProblems', 'id', 'incomplete', 'kind',
        'outcome', 'problemCount', 'startedAt', 'synthesized', 'trigger', 'warnCount',
      ]);
    }
  } finally {
    cleanup(home);
  }
});

test('B4: getActivity returns the lenses, applies level/search to Events only, and handles bad/missing ids as documented', () => {
  const home = tmpHome();
  try {
    const aid = '00000000-0000-4000-8000-000000000070';
    seedSegment(home, aid, [
      startRec(aid, 0, '2026-08-14T00:00:00-07:00'),
      eventRec(aid, 1, '2026-08-14T00:00:01-07:00', 'info', 'alpha'),
      eventRec(aid, 2, '2026-08-14T00:00:02-07:00', 'warn', 'beta'),
      terminalRec(aid, 3, '2026-08-14T00:01:00-07:00', 'succeeded-with-warnings'),
    ]);
    const full = read.getActivity(home, aid);
    assert.strictEqual(full.available, true);
    assert.strictEqual(full.item.id, aid);
    assert.strictEqual(full.item.events.length, 2);
    assert.strictEqual(full.item.problems.length, 2); // warn event + succeeded-with-warnings terminal
    assert.deepStrictEqual(full.item.duplicateTerminals, []);

    const filtered = read.getActivity(home, aid, { filter: { level: 'warn' } });
    assert.strictEqual(filtered.item.events.length, 1);
    assert.strictEqual(filtered.item.problems.length, 2); // filter never touches the Problems lens
    const searched = read.getActivity(home, aid, { filter: { search: 'alpha' } });
    assert.strictEqual(searched.item.events.length, 1);

    // Invalid id: a caller bug -> typed throw (InvalidActivityId extends InvalidFilter).
    assert.throws(() => read.getActivity(home, 'not-a-uuid'), read.InvalidActivityId);
    assert.throws(() => read.getActivity(home, '../../etc'), read.InvalidFilter);
    assert.throws(() => read.getActivity(home, aid, { filter: { level: 'nope' } }), read.InvalidFilter);

    // Missing id: a data condition -> item:null with a reason, never a throw.
    const missing = read.getActivity(home, '00000000-0000-4000-8000-0000000000ff');
    assert.deepStrictEqual(missing, { item: null, available: true, reason: 'missing' });

    // Also reachable via the barrel's `read` namespace.
    assert.strictEqual(A.read.getActivity, read.getActivity);
  } finally {
    cleanup(home);
  }
});

test('B4: getActivity against a missing root is missing, against an unreadable root is unavailable', (t) => {
  const aid = '00000000-0000-4000-8000-000000000071';
  const home = tmpHome();
  try {
    assert.deepStrictEqual(read.getActivity(home, aid), { item: null, available: true, reason: 'missing' });
  } finally {
    cleanup(home);
  }
  if (process.getuid && process.getuid() === 0) {
    t.skip('running as root -- permission bits are not enforced');
    return;
  }
  const home2 = tmpHome();
  const base = path.join(home2, 'Library', 'Logs', 'repo-radar', 'activity');
  fs.mkdirSync(base, { recursive: true });
  fs.chmodSync(base, 0o000);
  try {
    assert.deepStrictEqual(read.getActivity(home2, aid), { item: null, available: false, reason: 'unavailable' });
  } finally {
    fs.chmodSync(base, 0o700);
    cleanup(home2);
  }
});

// --- I3: per-activity failures are contained -----------------------------------------------------

test('I3: a throwing reconcile() is contained as an unknown/incomplete item with an internal-error problem, never thrown', () => {
  const home = tmpHome();
  const reconcileMod = require('../reconcile');
  const origReconcile = reconcileMod.reconcile;
  try {
    const aidOk = '00000000-0000-4000-8000-000000000080';
    const aidBad = '00000000-0000-4000-8000-000000000081';
    seedSegment(home, aidOk, [
      startRec(aidOk, 0, '2026-08-14T00:00:00-07:00'),
      terminalRec(aidOk, 1, '2026-08-14T00:01:00-07:00', 'succeeded'),
    ]);
    seedSegment(home, aidBad, [
      startRec(aidBad, 0, '2026-08-13T00:00:00-07:00'),
      terminalRec(aidBad, 1, '2026-08-13T00:01:00-07:00', 'succeeded'),
    ]);
    const secret = 'boom-secret-99';
    reconcileMod.reconcile = (h, aid) => {
      if (aid === aidBad) throw new Error(`simulated reconcile crash ${secret}`);
      return origReconcile(h, aid);
    };

    let result;
    assert.doesNotThrow(() => { result = read.listActivities(home, {}, { configuredSecrets: [secret] }); });
    assert.strictEqual(result.available, true);
    assert.strictEqual(result.incomplete, true);
    assert.strictEqual(result.items.length, 2);
    const bad = result.items.find((s) => s.id === aidBad);
    assert.strictEqual(bad.outcome, 'unknown');
    assert.strictEqual(bad.incomplete, true);
    assert.strictEqual(bad.hasProblems, true);
    const ok = result.items.find((s) => s.id === aidOk);
    assert.strictEqual(ok.outcome, 'succeeded');
    assert.strictEqual(ok.incomplete, false);

    const one = read.getActivity(home, aidBad, { configuredSecrets: [secret] });
    assert.strictEqual(one.item.outcome, 'unknown');
    assert.strictEqual(one.item.problems.length, 1);
    assert.strictEqual(one.item.problems[0].kind, 'internal-error');
    assert.ok(one.item.problems[0].reason.includes('simulated reconcile crash'));
    assert.ok(!one.item.problems[0].reason.includes(secret), 'error text is scrubbed');

    let text;
    assert.doesNotThrow(() => { text = read.buildExport(home, {}, { configuredSecrets: [secret] }); });
    assert.ok(text.includes('[internal-error]'));
    assert.ok(!text.includes(secret));
  } finally {
    reconcileMod.reconcile = origReconcile;
    cleanup(home);
  }
});

// --- Codex R2 (B1/B2/I): fail-closed reconcile view, grouped terminal problems, root rejections ----

// Every scan-derived signal the predicate counts is also a Problems row, and vice versa -- the
// invariant Ruling 37 exists to pin. Asserted on every item the R2 tests below build.
function assertParity(item) {
  assert.strictEqual(item.hasProblems, item.problemCount > 0, `hasProblems/problemCount disagree on ${item.id}`);
  assert.strictEqual(item.problemCount > 0, item.problems.length > 0, `problemCount/problems disagree on ${item.id}`);
}

test('R2-B1: getActivity over a readable start + unreadable (0o000) succeeded terminal never synthesizes; restore => succeeded', (t) => {
  if (process.getuid && process.getuid() === 0) {
    t.skip('running as root -- permission bits are not enforced');
    return;
  }
  const home = tmpHome();
  const aid = '00000000-0000-4000-8000-0000000000a1';
  seedSegment(home, aid, [startRec(aid, 0, '2026-08-14T00:00:00-07:00')]);
  seedSegment(home, aid, [terminalRec(aid, 1, '2026-08-14T00:01:00-07:00', 'succeeded')], 'electron', 'cafef00d');
  const hidden = A.segmentPath(home, aid, 'electron', 'cafef00d');
  fs.chmodSync(hidden, 0o000);
  try {
    // no owner.lock at all -> the lease is FREE; before Ruling 38 this synthesized `interrupted`.
    const before = fs.readdirSync(A.activityDir(home, aid)).filter((f) => f.endsWith('.jsonl')).sort();
    const item = detail(home, aid);
    // view-uncertain: the terminal's existence is unproven, so the verdict is 'unknown' (not
    // 'running', which would assert "no terminal" -- an assertion we can't back up here).
    assert.strictEqual(item.outcome, 'unknown');
    assert.strictEqual(item.synthesized, false);
    assert.strictEqual(item.incomplete, true);
    assert.ok(item.problems.some((p) => p.kind === 'reconcile-view-uncertain'));
    assert.ok(item.problems.some((p) => p.kind === 'rejected-segment' && p.reason === 'denied'));
    assertParity(item);
    const after = fs.readdirSync(A.activityDir(home, aid)).filter((f) => f.endsWith('.jsonl')).sort();
    assert.deepStrictEqual(after, before, 'no new (reconciler) segment may appear');
    const listed = read.listActivities(home);
    assert.strictEqual(listed.incomplete, true);
    assert.strictEqual(listed.items[0].outcome, 'unknown');

    fs.chmodSync(hidden, 0o600);
    const restored = detail(home, aid);
    assert.strictEqual(restored.outcome, 'succeeded');
    assert.strictEqual(restored.incomplete, false);
    assert.deepStrictEqual(restored.duplicateTerminals, []); // no manufactured conflict
    assert.deepStrictEqual(restored.problems, []);
  } finally {
    try { fs.chmodSync(hidden, 0o600); } catch (e) { /* already restored */ }
    cleanup(home);
  }
});

test('R2-B1: a conforming terminal segment replaced by a symlink is an uncertain view: no synthesis, incomplete', () => {
  const home = tmpHome();
  try {
    const aid = '00000000-0000-4000-8000-0000000000a2';
    seedSegment(home, aid, [startRec(aid, 0, '2026-08-14T00:00:00-07:00')]);
    const victim = path.join(home, 'victim.jsonl');
    fs.writeFileSync(victim, JSON.stringify(terminalRec(aid, 1, '2026-08-14T00:01:00-07:00', 'succeeded')) + '\n');
    fs.symlinkSync(victim, A.segmentPath(home, aid, 'electron', 'cafef00d'));

    const item = detail(home, aid);
    // readable start, no readable terminal, verdict withheld: view-uncertain -> 'unknown', not
    // 'running' -- whether a terminal exists behind the symlink is unproven, not absent.
    assert.strictEqual(item.outcome, 'unknown');
    assert.strictEqual(item.synthesized, false);
    assert.strictEqual(item.incomplete, true);
    assert.ok(item.problems.some((p) => p.kind === 'reconcile-view-uncertain'));
    assertParity(item);
    const names = fs.readdirSync(A.activityDir(home, aid)).filter((f) => f.endsWith('.jsonl')).sort();
    assert.deepStrictEqual(names, ['electron-cafef00d.jsonl', 'python-deadbeef.jsonl']);
  } finally {
    cleanup(home);
  }
});

test('R2-B2: two identical succeeded terminals are problem-bearing: one grouped terminal row (count 2) + duplicate-terminal', () => {
  const home = tmpHome();
  try {
    const aid = '00000000-0000-4000-8000-0000000000b1';
    seedSegment(home, aid, [
      startRec(aid, 0, '2026-08-14T00:00:00-07:00'),
      terminalRec(aid, 1, '2026-08-14T00:01:00-07:00', 'succeeded'),
      terminalRec(aid, 2, '2026-08-14T00:01:00-07:00', 'succeeded'),
    ]);
    const summary = read.listActivities(home).items[0];
    assert.strictEqual(summary.outcome, 'succeeded');
    assert.strictEqual(summary.hasProblems, true);
    assert.ok(summary.problemCount >= 1);

    const item = detail(home, aid);
    assertParity(item);
    // `succeeded` is a routine outcome: NO kind:'terminal' row for it, and never one per duplicate.
    assert.strictEqual(item.problems.filter((p) => p.kind === 'terminal').length, 0);
    const dup = item.problems.filter((p) => p.kind === 'duplicate-terminal');
    assert.deepStrictEqual(dup, [{ kind: 'duplicate-terminal', outcome: 'succeeded', count: 2 }]);
    assert.deepStrictEqual(item.duplicateTerminals, [{ outcome: 'succeeded', count: 2 }]);
    assert.ok(read.buildExport(home).includes('[duplicate-terminal] succeeded recorded 2 times'));
  } finally {
    cleanup(home);
  }
});

test('R2-B2: two identical failed terminals render ONE grouped terminal row with count 2 (not two) + duplicate-terminal', () => {
  const home = tmpHome();
  try {
    const aid = '00000000-0000-4000-8000-0000000000b2';
    seedSegment(home, aid, [
      startRec(aid, 0, '2026-08-14T00:00:00-07:00'),
      terminalRec(aid, 1, '2026-08-14T00:01:00-07:00', 'failed', { summary: { reason: 'first' } }),
      terminalRec(aid, 2, '2026-08-14T00:01:01-07:00', 'failed', { summary: { reason: 'second' }, by: 'cafef00d' }),
    ]);
    const item = detail(home, aid);
    assert.strictEqual(item.outcome, 'failed');
    assertParity(item);
    const terms = item.problems.filter((p) => p.kind === 'terminal');
    assert.strictEqual(terms.length, 1);
    assert.strictEqual(terms[0].outcome, 'failed');
    assert.strictEqual(terms[0].count, 2);
    assert.strictEqual(terms[0].ts, '2026-08-14T00:01:00-07:00'); // the FIRST terminal's
    assert.deepStrictEqual(terms[0].summary, { reason: 'first' });
    assert.deepStrictEqual(terms[0].by, ['deadbeef', 'cafef00d']); // disagreeing `by` -> list
    assert.ok(item.problems.some((p) => p.kind === 'duplicate-terminal' && p.outcome === 'failed' && p.count === 2));
    assert.strictEqual(item.problemCount, 2);
    const text = read.buildExport(home);
    assert.ok(text.includes('failed x2 by deadbeef, cafef00d'));
  } finally {
    cleanup(home);
  }
});

test('R2-B2: succeeded + failed terminals => conflict problem, interrupted verdict, parity holds', () => {
  const home = tmpHome();
  try {
    const aid = '00000000-0000-4000-8000-0000000000b3';
    seedSegment(home, aid, [
      startRec(aid, 0, '2026-08-14T00:00:00-07:00'),
      terminalRec(aid, 1, '2026-08-14T00:01:00-07:00', 'succeeded'),
      terminalRec(aid, 2, '2026-08-14T00:01:01-07:00', 'failed'),
    ]);
    const item = detail(home, aid);
    assert.strictEqual(item.outcome, 'interrupted');
    assert.strictEqual(item.hasProblems, true);
    assertParity(item);
    assert.ok(item.problems.some((p) => p.kind === 'reconcile-terminal-conflict'));
    assert.strictEqual(item.problems.filter((p) => p.kind === 'duplicate-terminal').length, 0); // 1 each: no dup
    assert.strictEqual(item.problems.filter((p) => p.kind === 'terminal').length, 1); // the failed one
    assert.deepStrictEqual(item.duplicateTerminals, []);
  } finally {
    cleanup(home);
  }
});

test('R2-B2: a corrupt interior line is problem-bearing on the summary and the predicate agrees with the lens', () => {
  const home = tmpHome();
  try {
    const aid = '00000000-0000-4000-8000-0000000000b4';
    A.secureMkdir(A.activityDir(home, aid));
    fs.writeFileSync(A.segmentPath(home, aid, 'python', 'deadbeef'), [
      JSON.stringify(startRec(aid, 0, '2026-08-14T00:00:00-07:00')),
      '{not valid json at all',
      JSON.stringify(terminalRec(aid, 1, '2026-08-14T00:01:00-07:00', 'succeeded')),
    ].join('\n') + '\n');
    const summary = read.listActivities(home).items[0];
    assert.strictEqual(summary.hasProblems, true);
    assert.strictEqual(summary.problemCount, 1);
    const item = detail(home, aid);
    assertParity(item);
    assert.strictEqual(item.problems[0].kind, 'corrupt-json');
  } finally {
    cleanup(home);
  }
});

test('R2-I: a valid-UUID symlink at the Activity root is a rejected-activity diagnostic, never clean empty history', () => {
  const home = tmpHome();
  try {
    const realAid = '00000000-0000-4000-8000-0000000000c1';
    const linkAid = '00000000-0000-4000-8000-0000000000c2';
    // A real activity living OUTSIDE the store, pointed at by a symlink named like an activity.
    const elsewhere = path.join(home, 'elsewhere', realAid);
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, 'python-deadbeef.jsonl'), [
      JSON.stringify(startRec(linkAid, 0, '2026-08-14T00:00:00-07:00')),
      JSON.stringify(terminalRec(linkAid, 1, '2026-08-14T00:01:00-07:00', 'succeeded')),
    ].join('\n') + '\n');
    const root = path.dirname(A.quotaDir(home));
    A.secureMkdir(root);
    fs.symlinkSync(elsewhere, path.join(root, linkAid));

    const result = read.listActivities(home);
    assert.deepStrictEqual(result.items, []); // the symlink is never followed
    assert.strictEqual(result.available, true);
    assert.strictEqual(result.incomplete, true);
    assert.deepStrictEqual(result.problems, [{ kind: 'rejected-activity', id: linkAid, reason: 'symlink' }]);

    const one = read.getActivity(home, linkAid);
    assert.strictEqual(one.item, null);
    assert.strictEqual(one.reason, 'unreadable');

    const text = read.buildExport(home);
    assert.ok(text.includes('incomplete: true'));
    assert.ok(text.includes(`[rejected-activity] symlink: ${linkAid}`));
    assert.ok(!text.includes('Activity ' + linkAid));
  } finally {
    cleanup(home);
  }
});

test('R2-I: a plain file squatting on an activity id is rejected as not-directory; real activities still list', () => {
  const home = tmpHome();
  try {
    const good = '00000000-0000-4000-8000-0000000000c3';
    const squat = '00000000-0000-4000-8000-0000000000c4';
    seedSegment(home, good, [
      startRec(good, 0, '2026-08-14T00:00:00-07:00'),
      terminalRec(good, 1, '2026-08-14T00:01:00-07:00', 'succeeded'),
    ]);
    fs.writeFileSync(path.join(path.dirname(A.quotaDir(home)), squat), 'not a dir\n');

    const result = read.listActivities(home);
    assert.strictEqual(result.items.length, 1);
    assert.strictEqual(result.items[0].id, good);
    assert.strictEqual(result.items[0].incomplete, false); // the item itself is fine
    assert.strictEqual(result.incomplete, true); // the RESPONSE is not
    assert.deepStrictEqual(result.problems, [{ kind: 'rejected-activity', id: squat, reason: 'not-directory' }]);
  } finally {
    cleanup(home);
  }
});

test('R2-I: a junk-named root entry (not an activity id) is ignored: no diagnostic, incomplete:false', () => {
  const home = tmpHome();
  try {
    const root = path.dirname(A.quotaDir(home));
    A.secureMkdir(root);
    fs.symlinkSync(home, path.join(root, 'not-an-activity'));
    fs.writeFileSync(path.join(root, 'quota.lock'), '');
    fs.mkdirSync(A.quotaDir(home));
    const result = read.listActivities(home);
    assert.deepStrictEqual(result, { items: [], truncated: false, available: true, incomplete: false, problems: [] });
  } finally {
    cleanup(home);
  }
});

test('R2-I: root diagnostics are bounded at ROOT_PROBLEMS_MAX with a truncated marker', () => {
  const home = tmpHome();
  const saved = limits.ROOT_PROBLEMS_MAX;
  try {
    limits.ROOT_PROBLEMS_MAX = 2;
    const root = path.dirname(A.quotaDir(home));
    A.secureMkdir(root);
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(path.join(root, `00000000-0000-4000-8000-0000000000d${i}`), '');
    }
    const result = read.listActivities(home);
    assert.strictEqual(result.problems.length, 3);
    assert.strictEqual(result.problems.filter((p) => p.kind === 'rejected-activity').length, 2);
    assert.deepStrictEqual(result.problems[2], { kind: 'truncated', dropped: 3 });
    assert.strictEqual(result.incomplete, true);
  } finally {
    limits.ROOT_PROBLEMS_MAX = saved;
    cleanup(home);
  }
});
