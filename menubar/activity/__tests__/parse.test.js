'use strict';
// Task 3.1: tests for parse.js's parseSegment -- the read-side per-segment JSONL parser (Phase
// 3's log-viewer reader). Step-1 tests are lifted verbatim from the task brief; the final test
// (cross-language validator parity) additionally proves the shared `record_validation_vectors.json`
// fixture is consumed identically by Node's records.parseValid and Python's records.parse_valid
// (Round-5 #3) -- there was previously no Node test doing so.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { parseSegment } = require('../parse');
const records = require('../records');

const AID = '00000000-0000-4000-8000-000000000000';
const TS = '2026-08-14T00:00:00-07:00';   // valid ISO-8601 with offset (Round-6 #2)
const j = (o) => JSON.stringify({ schema_version: 1, activity_id: AID, ts: TS, ...o }) + '\n';
const start = (seq) => j({ type: 'start', seq, kind: 'sync', channel: 'stable', trigger: 'cli', created_by: 'python' });
const ev = (seq) => j({ type: 'event', seq, level: 'info', event: 'x', fields: {} });
const term = (seq, outcome = 'succeeded') => j({ type: 'terminal', seq, outcome, summary: {}, by: 'deadbeef' });

test('drops a truncated trailing line silently, keeps the rest', () => {
  const { records: recs, integrity } = parseSegment(Buffer.from(start(0) + '{"type":"eve'), AID);
  assert.strictEqual(recs.length, 1); assert.strictEqual(integrity.length, 0);
});

test('interior corruption is an integrity finding but later lines survive', () => {
  const { records: recs, integrity } = parseSegment(Buffer.from(start(0) + 'GARBAGE\n' + term(1)), AID);
  assert.strictEqual(recs.length, 2);          // start + terminal preserved
  assert.strictEqual(integrity.length, 1);        // the interior garbage flagged
  assert.strictEqual(integrity[0].kind, 'corrupt-record');
});

// Codex R3 B2 / Ruling 41: the durability contract is record+`\n`. A final line lacking its
// terminating newline is a torn write and is IGNORED unconditionally -- even when the bytes
// happen to be a complete, valid JSON record -- with no finding. Python quota.py `_scan` has
// always applied this rule (`interior = lines[:-1]`); Node previously accepted the parseable tail,
// so the two runtimes could disagree on whether a terminal existed (Python synthesized
// `interrupted`, Node then reported a succeeded/interrupted conflict).
test('Ruling 41: a VALID-JSON terminal with no trailing newline is NOT parsed and is NOT a finding', () => {
  const text = start(0) + term(1).slice(0, -1); // strip the terminal's `\n`
  assert.ok(!text.endsWith('\n'));
  const { records: recs, integrity } = parseSegment(Buffer.from(text), AID);
  assert.deepStrictEqual(recs.map((r) => r.type), ['start']);
  assert.deepStrictEqual(integrity, []);
});

test('Ruling 41: the same bytes WITH the trailing newline parse the terminal', () => {
  const { records: recs, integrity } = parseSegment(Buffer.from(start(0) + term(1)), AID);
  assert.deepStrictEqual(recs.map((r) => r.type), ['start', 'terminal']);
  assert.deepStrictEqual(integrity, []);
});

test('Ruling 41: a lone newline-less record parses as nothing; a single terminated record parses as one', () => {
  assert.deepStrictEqual(parseSegment(Buffer.from(start(0).slice(0, -1)), AID), { records: [], integrity: [] });
  assert.strictEqual(parseSegment(Buffer.from(start(0)), AID).records.length, 1);
  assert.deepStrictEqual(parseSegment(Buffer.alloc(0), AID), { records: [], integrity: [] });
});

test('Ruling 41: an unterminated tail that is NOT valid JSON is equally silent (no finding)', () => {
  const { integrity } = parseSegment(Buffer.from(start(0) + 'GARBAGE'), AID);
  assert.deepStrictEqual(integrity, []);
});

test('canonical finding kinds: corrupt-record | unsupported-schema | seq-regression', () => {
  const bad = JSON.stringify({ schema_version: 1, activity_id: AID, type: 'terminal', seq: 1, ts: TS, outcome: 'bogus', summary: {}, by: 'deadbeef' }) + '\n';
  const { integrity } = parseSegment(Buffer.from(
    'not json\n' + '[1,2]\n' + '"str"\n' + bad
    + JSON.stringify({ schema_version: 2, activity_id: AID, type: 'start', seq: 0, ts: TS }) + '\n'
    + ev(5) + ev(2)), AID);
  assert.deepStrictEqual(integrity.map((f) => f.kind), [
    'corrupt-record', 'corrupt-record', 'corrupt-record', 'corrupt-record', 'unsupported-schema', 'seq-regression',
  ]);
  assert.deepStrictEqual([...require('../parse').FINDING_KINDS], ['corrupt-record', 'unsupported-schema', 'seq-regression']);
});

test('Ruling 42: seq-regression keeps the record and tracks the LAST accepted seq (no cascade)', () => {
  const { records: recs, integrity } = parseSegment(Buffer.from(ev(5) + ev(2) + ev(3) + ev(3)), AID);
  assert.deepStrictEqual(recs.map((r) => r.seq), [5, 2, 3, 3]);
  assert.deepStrictEqual(integrity.map((f) => [f.kind, f.index]), [['seq-regression', 1], ['seq-regression', 3]]);
});

test('unsupported schema_version does not parse as v1', () => {
  const { records: recs, integrity } = parseSegment(Buffer.from(
    JSON.stringify({ schema_version: 999, activity_id: AID, type: 'start', seq: 0, ts: 't' }) + '\n'), AID);
  assert.strictEqual(recs.length, 0);
  assert.match(integrity[0].kind, /unsupported-schema/);
});

test('seq regression within a segment is flagged', () => {
  const { integrity } = parseSegment(Buffer.from(ev(5) + ev(2)), AID);
  assert.ok(integrity.some((i) => /seq/.test(i.kind)));
});

test('invalid-outcome OR foreign-activity terminal is NOT a valid record (Round-4 #5)', () => {
  const foreign = JSON.stringify({
    schema_version: 1, activity_id: '11111111-1111-4111-8111-111111111111',
    type: 'terminal', seq: 1, ts: TS, outcome: 'succeeded', summary: {}, by: 'deadbeef',
  }) + '\n';
  const { records: recs } = parseSegment(Buffer.from(start(0) + term(1, 'bogus') + foreign), AID);
  assert.strictEqual(recs.filter((r) => r.type === 'terminal').length, 0);   // bogus outcome + foreign id
});

// Round-5 #3: prove Node's records.parseValid agrees with Python's records.parse_valid on the
// SAME committed vector file -- there was previously no Node test consuming these vectors (only
// repo_radar/tests/test_activity_records.py::test_shared_validation_vectors did, on the Python
// side).
test('cross-language validator parity: record_validation_vectors.json', () => {
  const vectorsPath = path.join(__dirname, '../../../repo_radar/tests/data/record_validation_vectors.json');
  const vectors = require(vectorsPath);
  assert.ok(vectors.length >= 11, `expected at least the 11 original vectors, got ${vectors.length}`);
  for (const v of vectors) {
    const accepted = records.parseValid(JSON.stringify(v.raw), '00000000-0000-4000-8000-000000000000') !== null;
    assert.strictEqual(accepted, v.accept, v.why);
  }
});
