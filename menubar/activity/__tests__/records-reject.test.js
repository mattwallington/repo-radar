'use strict';
// Fix round 1: proves the two encoders are symmetric on REJECTION of a numeric-like field key,
// not just on successful encoding (the golden harness only covers the latter). A canonical-
// integer-string key ("0", "1", "42"...) would otherwise silently reorder ahead of other keys
// in a JS plain object (at JSON.parse/object-creation time, before any of our code runs) while
// Python preserves its original insertion order -- so instead of letting that byte-level drift
// happen, both `records.py` and `records.js` refuse the key outright. This test -- together
// with its companion assertion in repo_radar/tests/test_activity_golden.py -- is the committed
// proof that both sides agree on rejection; either side dropping the guard fails its half.
const test = require('node:test');
const assert = require('node:assert');
const { buildRecord, InvalidRecord } = require('../records');

const AID = '00000000-0000-4000-8000-000000000000';
const TS = '2026-08-14T00:00:00-07:00';

test('buildRecord rejects a canonical-integer-string field key', () => {
  assert.throws(
    () => buildRecord('event', {
      seq: 0, activity_id: AID, ts: TS, level: 'info', event: 'x',
      fields: { 0: 1, a: 2 }, // JS coerces the numeric key 0 to the string "0"
    }),
    InvalidRecord,
  );
});

test('buildRecord rejects a canonical-integer-string summary key (terminal)', () => {
  assert.throws(
    () => buildRecord('terminal', {
      seq: 1, activity_id: AID, ts: TS, outcome: 'failed',
      summary: { '42': 1 }, by: 'reconciler',
    }),
    InvalidRecord,
  );
});

test('buildRecord still accepts non-canonical numeric-looking keys ("01", "1.0", "-1")', () => {
  // Only an EXACT canonical-integer string ("0" | [1-9]\d*) is rejected -- these are NOT that.
  const rec = buildRecord('event', {
    seq: 2, activity_id: AID, ts: TS, level: 'info', event: 'x',
    fields: { '01': 1, '1.0': 2, '-1': 3 },
  });
  assert.deepStrictEqual(rec.fields, { '01': 1, '1.0': 2, '-1': 3 });
});
