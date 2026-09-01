'use strict';
// Task 3.2: tests for merge.js's mergeHeads -- the read-side k-way segment merge (Phase 3's
// log-viewer reader). Step-1 test is lifted verbatim from the task brief (the backwards-clock
// property); the rest cover the edge cases called out alongside it: empty inputs, a lone
// segment (identity, even with backward ts), a clean two-segment interleave, a ts tie broken by
// writerId, and a 3-segment merge exercising re-comparison after each pop.
const test = require('node:test');
const assert = require('node:assert');
const { mergeHeads } = require('../merge');

test('per-writer append order survives a backwards wall-clock step', () => {
  const segA = [                                   // writerId 'aaaaaaaa'
    { ts: '2026-08-14T10:00:02', writerId: 'aaaaaaaa', seq: 0, event: 'A0' },
    { ts: '2026-08-14T10:00:01', writerId: 'aaaaaaaa', seq: 1, event: 'A1' }, // clock went back
  ];
  const segB = [{ ts: '2026-08-14T10:00:01', writerId: 'bbbbbbbb', seq: 0, event: 'B0' }];
  const merged = mergeHeads([segA, segB]).map(r => r.event);
  // A0 must precede A1 regardless of ts; B0 interleaves by (ts, writerId)
  assert.ok(merged.indexOf('A0') < merged.indexOf('A1'));
});

test('mergeHeads([]) returns []', () => {
  assert.deepStrictEqual(mergeHeads([]), []);
});

test('all-empty inner arrays returns []', () => {
  assert.deepStrictEqual(mergeHeads([[], []]), []);
});

test('a single segment returns its records in the same order (identity), even with a backward ts', () => {
  const seg = [
    { ts: '2026-08-14T10:00:05', writerId: 'aaaaaaaa', seq: 0, event: 'X0' },
    { ts: '2026-08-14T10:00:01', writerId: 'aaaaaaaa', seq: 1, event: 'X1' }, // clock went back
    { ts: '2026-08-14T10:00:03', writerId: 'aaaaaaaa', seq: 2, event: 'X2' },
  ];
  const merged = mergeHeads([seg]);
  assert.strictEqual(merged.length, 3);
  assert.deepStrictEqual(merged.map(r => r.event), ['X0', 'X1', 'X2']);
  // identity: same record objects, same order -- not resorted
  assert.strictEqual(merged[0], seg[0]);
  assert.strictEqual(merged[1], seg[1]);
  assert.strictEqual(merged[2], seg[2]);
});

test('a clean interleave: two segments whose heads alternate by ts', () => {
  const segA = [
    { ts: '2026-08-14T10:00:00', writerId: 'aaaaaaaa', seq: 0, event: 'A0' },
    { ts: '2026-08-14T10:00:02', writerId: 'aaaaaaaa', seq: 1, event: 'A1' },
    { ts: '2026-08-14T10:00:04', writerId: 'aaaaaaaa', seq: 2, event: 'A2' },
  ];
  const segB = [
    { ts: '2026-08-14T10:00:01', writerId: 'bbbbbbbb', seq: 0, event: 'B0' },
    { ts: '2026-08-14T10:00:03', writerId: 'bbbbbbbb', seq: 1, event: 'B1' },
  ];
  const merged = mergeHeads([segA, segB]).map(r => r.event);
  assert.deepStrictEqual(merged, ['A0', 'B0', 'A1', 'B1', 'A2']);
});

test('a ts tie across two segments is broken deterministically by writerId', () => {
  const segA = [{ ts: '2026-08-14T10:00:00', writerId: 'bbbbbbbb', seq: 0, event: 'A0' }];
  const segB = [{ ts: '2026-08-14T10:00:00', writerId: 'aaaaaaaa', seq: 0, event: 'B0' }];
  // segments passed in [A(writerId b), B(writerId a)] order -- writerId tie-break should still
  // put 'aaaaaaaa' (segB's head) first, regardless of which segment array index it came from.
  const merged = mergeHeads([segA, segB]).map(r => r.event);
  assert.deepStrictEqual(merged, ['B0', 'A0']);
});

test('a full tie on both ts and writerId breaks deterministically by lowest segment index', () => {
  const segA = [{ ts: '2026-08-14T10:00:00', writerId: 'aaaaaaaa', seq: 0, event: 'A0' }];
  const segB = [{ ts: '2026-08-14T10:00:00', writerId: 'aaaaaaaa', seq: 0, event: 'B0' }];
  const merged = mergeHeads([segA, segB]).map(r => r.event);
  assert.deepStrictEqual(merged, ['A0', 'B0']); // lower segment index (0) wins the tie
});

test('a 3-segment merge exercises re-comparison after each pop', () => {
  const segA = [
    { ts: '2026-08-14T10:00:00', writerId: 'aaaaaaaa', seq: 0, event: 'A0' },
    { ts: '2026-08-14T10:00:03', writerId: 'aaaaaaaa', seq: 1, event: 'A1' },
  ];
  const segB = [
    { ts: '2026-08-14T10:00:01', writerId: 'bbbbbbbb', seq: 0, event: 'B0' },
    { ts: '2026-08-14T10:00:02', writerId: 'bbbbbbbb', seq: 1, event: 'B1' },
  ];
  const segC = [
    { ts: '2026-08-14T10:00:00', writerId: 'cccccccc', seq: 0, event: 'C0' },
    { ts: '2026-08-14T10:00:05', writerId: 'cccccccc', seq: 1, event: 'C1' },
  ];
  const merged = mergeHeads([segA, segB, segC]).map(r => r.event);
  // ties at 10:00:00 between A0/C0 break by writerId ('aaaaaaaa' < 'cccccccc')
  assert.deepStrictEqual(merged, ['A0', 'C0', 'B0', 'B1', 'A1', 'C1']);
});

test('does not mutate the input segment arrays or record objects', () => {
  const segA = [{ ts: '2026-08-14T10:00:00', writerId: 'aaaaaaaa', seq: 0, event: 'A0' }];
  const segB = [{ ts: '2026-08-14T10:00:01', writerId: 'bbbbbbbb', seq: 0, event: 'B0' }];
  const segACopy = segA.slice();
  const segBCopy = segB.slice();
  mergeHeads([segA, segB]);
  assert.deepStrictEqual(segA, segACopy);
  assert.deepStrictEqual(segB, segBCopy);
  assert.strictEqual(segA.length, 1);
  assert.strictEqual(segB.length, 1);
});

// --- Codex R1 finding I2: ts is compared as an INSTANT, not lexically, so records from writers
// with different (or shifting) UTC offsets still merge in true chronological order. ---

test('cross-offset ordering: an earlier instant with a +02:00 offset sorts before a later ' +
  'instant with a +00:00 offset, even though it sorts LATER lexically', () => {
  // '...10:00:00+02:00' is 08:00Z; '...09:00:00+00:00' is 09:00Z. Lexically the first string
  // would sort after the second (because '1' > '0' at the hour digit), but 08:00Z is the earlier
  // instant, so it must come first.
  const segA = [{ ts: '2026-08-14T10:00:00+02:00', writerId: 'aaaaaaaa', seq: 0, event: 'A0' }];
  const segB = [{ ts: '2026-08-14T09:00:00+00:00', writerId: 'bbbbbbbb', seq: 0, event: 'B0' }];
  const merged = mergeHeads([segA, segB]).map(r => r.event);
  assert.deepStrictEqual(merged, ['A0', 'B0']);
});

test('a DST-style offset shift mid-segment keeps append order, and a second writer interleaves ' +
  'by true instant (not lexically)', () => {
  const segA = [ // writerId 'aaaaaaaa' -- offset shifts -07:00 -> -08:00, instant moves forward
    { ts: '2026-08-14T01:00:00-07:00', writerId: 'aaaaaaaa', seq: 0, event: 'A0' }, // 08:00Z
    { ts: '2026-08-14T01:30:00-08:00', writerId: 'aaaaaaaa', seq: 1, event: 'A1' }, // 09:30Z
  ];
  const segB = [
    { ts: '2026-08-14T08:45:00+00:00', writerId: 'bbbbbbbb', seq: 0, event: 'B0' }, // 08:45Z
  ];
  const merged = mergeHeads([segA, segB]).map(r => r.event);
  // A0 must still precede A1 (append order, unconditional); B0's true instant (08:45Z) falls
  // between A0 (08:00Z) and A1 (09:30Z) -- a lexical comparison of the raw strings would instead
  // place B0 after both, since '08:45:00+00:00' sorts lexically after '01:30:00-08:00'.
  assert.ok(merged.indexOf('A0') < merged.indexOf('A1'));
  assert.deepStrictEqual(merged, ['A0', 'B0', 'A1']);
});

test('Z and an equal-instant explicit +00:00 tie, broken deterministically by writerId', () => {
  const segA = [{ ts: '2026-08-14T10:00:00Z', writerId: 'bbbbbbbb', seq: 0, event: 'A0' }];
  const segB = [{ ts: '2026-08-14T10:00:00+00:00', writerId: 'aaaaaaaa', seq: 0, event: 'B0' }];
  const merged = mergeHeads([segA, segB]).map(r => r.event);
  assert.deepStrictEqual(merged, ['B0', 'A0']); // writerId 'aaaaaaaa' < 'bbbbbbbb'
});

test('an unparseable ts on one head does not throw and falls back to lexical ts comparison', () => {
  const segA = [{ ts: 'not-a-real-timestamp', writerId: 'aaaaaaaa', seq: 0, event: 'A0' }];
  const segB = [{ ts: '2026-08-14T10:00:00Z', writerId: 'bbbbbbbb', seq: 0, event: 'B0' }];
  let merged;
  assert.doesNotThrow(() => {
    merged = mergeHeads([segA, segB]).map(r => r.event);
  });
  // lexically '2026-08-14T10:00:00Z' < 'not-a-real-timestamp' (digit < letter), so B0 wins.
  assert.deepStrictEqual(merged, ['B0', 'A0']);
});
