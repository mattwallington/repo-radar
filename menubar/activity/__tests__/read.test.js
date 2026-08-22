'use strict';
// Task 3.6: read.js -- the reader capstone. Composes parse/merge/reconcile/redact into bounded,
// redacted, reader-facing DTOs. Mirrors reconcile.test.js's seeding style (raw JSONL written
// directly onto segment paths via paths.js primitives, bypassing writer.js/records.buildRecord
// entirely) since these tests exercise the READ side only. Every tmp dir this file creates is
// removed in a `finally` (prefixed `rr-read-`), per the repo's post-incident tmp-dir policy.
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
    assert.strictEqual(newer.events.length, 1);
    assert.strictEqual(newer.events[0].event, 'repo.failed');

    const older = result.items[1];
    assert.strictEqual(older.outcome, 'succeeded-with-warnings');
    assert.strictEqual(older.errorCount, 0);
    assert.strictEqual(older.warnCount, 1);
    assert.strictEqual(older.events.length, 2);
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
    assert.strictEqual(again.items[0].duplicateTerminals.length, 0);
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

    const result = read.listActivities(home, {}, { configuredSecrets: [secret] });
    const item = result.items[0];
    assert.strictEqual(item.events.length, 1);
    const detail = item.events[0].detail;
    assert.ok(!detail.includes('ghp_abcdefghijklmnopqrst1234'), 'github token must be masked');
    assert.ok(!detail.includes(secret), 'configured secret must be masked');
    assert.ok(detail.includes('[REDACTED'), 'a redaction marker must be present');

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
    assert.deepStrictEqual(result, { items: [], truncated: false, available: true, incomplete: false });
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
    assert.ok(result.items[0].problems.some((p) => /corrupt/i.test(p.kind)));
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
    assert.ok(result.items[0].problems.some((p) => /uncertain/i.test(p.kind)));
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
