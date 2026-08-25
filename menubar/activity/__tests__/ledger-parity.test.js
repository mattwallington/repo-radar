'use strict';
// Codex R5 (R5-4 / Ruling 52): ledger-decoding parity between Python's quota.py `_parse_entry`
// (the source of the shared `ledger_vectors.json` fixture) and Node's quota.js `_parseEntry`.
// Each vector is the RAW bytes of a ledger file (base64, since JSON strings cannot represent
// non-UTF-8 bytes) plus what Python produced for it: the CORRUPT sentinel, or the validated
// `{ reserved, granted }` object. Node must agree on every case -- both via `_parseEntry`
// directly and via `_readEntry` over a real on-disk file.
//
// The fixture is authored on the Python side; if it is absent this file skips (never invents a
// schema of its own).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../index');
const { quota } = A;
const records = require('../records');

const AID = '00000000-0000-4000-8000-000000000000';
const TS = '2026-08-14T00:00:00-07:00';
const validRecordText = (seq, schemaVersion = 1) =>
  `{"schema_version":${schemaVersion},"activity_id":"${AID}","type":"event","seq":${seq},` +
  `"ts":"${TS}","level":"info","event":"x","fields":{}}`;

const VECTORS = path.join(__dirname, '../../../repo_radar/tests/data/ledger_vectors.json');

function expectFor(v) {
  if (v.expected === 'corrupt' || v.expected === 'CORRUPT') return quota.CORRUPT;
  assert.ok(v.expected && typeof v.expected === 'object', `${v.name}: expected must be "corrupt" or {reserved, granted}`);
  return { reserved: v.expected.reserved, granted: v.expected.granted };
}

if (!fs.existsSync(VECTORS)) {
  test.skip(`ledger parity: ${VECTORS} not present (authored by the Python side; nothing to compare yet)`);
} else {
  const vectors = JSON.parse(fs.readFileSync(VECTORS, 'utf8'));
  assert.ok(Array.isArray(vectors) && vectors.length > 0, 'ledger_vectors.json must be a non-empty array');
  for (const v of vectors) {
    test(`ledger parity: ${v.name}`, () => {
      const bytes = Buffer.from(v.bytes_b64, 'base64');
      const expected = expectFor(v);
      assert.deepStrictEqual(quota._parseEntry(bytes), expected, '_parseEntry');

      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-ledger-parity-'));
      try {
        A.secureMkdir(A.quotaDir(home));
        const p = A.ledgerEntryPath(home, A.mintActivityId());
        fs.writeFileSync(p, bytes, { mode: 0o600 });
        assert.deepStrictEqual(quota._readEntry(p), expected, '_readEntry');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }
}

// G5-Node2: direct unit coverage for the strict-integer-literal fix, independent of the shared
// vectors file (the shared `record_validation_vectors.json` "raw" object shape round-trips
// through JS's own JSON.parse when building the parity test's input text, which already
// collapses `1.0`/`1e0` to the plain integer `1` before the literal ever reaches parseValid --
// so that fixture cannot exercise this fix on the Node side at all; see
// record_validation_vectors.json's "raw_text" cases for the cross-language-safe version of this,
// and parse.test.js's cross-language-validator-parity test for how raw_text is consumed there).
test('quota._parseEntry rejects non-integer JSON literals for reserved/granted', () => {
  const reject = (text) => assert.strictEqual(quota._parseEntry(Buffer.from(text, 'utf8')), quota.CORRUPT, text);
  const accept = (text, expected) => assert.deepStrictEqual(quota._parseEntry(Buffer.from(text, 'utf8')), expected, text);

  reject('{"reserved":61440.0,"granted":0}');   // integral float literal
  reject('{"reserved":61440,"granted":1e3}');   // exponent literal (1000 -- otherwise a legal granted value)
  reject('{"reserved":61440,"granted":1.5}');   // genuinely fractional
  accept('{"reserved":61440,"granted":0}', { reserved: 61440, granted: 0 });     // plain integers still accepted
  accept('{"reserved":61440,"granted":61440}', { reserved: 61440, granted: 61440 }); // 0 <= granted, plain integer
});

test('records.parseValid rejects non-integer JSON literals for seq/schema_version', () => {
  assert.strictEqual(records.parseValid(validRecordText('1.0'), AID), null);
  assert.strictEqual(records.parseValid(validRecordText('1e0'), AID), null);
  assert.strictEqual(records.parseValid(validRecordText(0, '1.0'), AID), null); // schema_version as a float
  assert.notStrictEqual(records.parseValid(validRecordText(1), AID), null);     // plain integer seq still accepted
});

test('records.parseValid does not over-reject a nested fields.seq float (top-level-only scoping)', () => {
  // `fields` legitimately carries a same-named key with a real float value (Round-3 #8 -- floats
  // are valid fields values); the top-level `seq` here is a plain integer, so this must accept.
  const text = `{"schema_version":1,"activity_id":"${AID}","type":"event","seq":3,` +
    `"ts":"${TS}","level":"info","event":"x","fields":{"seq":1.5}}`;
  const rec = records.parseValid(text, AID);
  assert.notStrictEqual(rec, null);
  assert.strictEqual(rec.seq, 3);
  assert.strictEqual(rec.fields.seq, 1.5);
});

test('parseJsonStrictIntegers accepts a "-0" literal (matches Python\'s int("-0") == 0)', () => {
  const obj = records.parseJsonStrictIntegers('{"reserved":-0,"granted":0}', ['reserved', 'granted']);
  assert.strictEqual(Object.is(obj.reserved, -0), true);
  assert.strictEqual(quota._parseEntry(Buffer.from('{"reserved":-0,"granted":0}', 'utf8')), quota.CORRUPT); // -0 !== RESERVE(61440)
});

// The reviver's `context.source` path is what actually runs on this repo's target runtimes (Node
// >=21 dev/test, Electron ^32.0.0 packaged -- both comfortably above the V8 11.4/Chrome 114
// threshold where `context.source` shipped), so the fallback pre-scan below is untested by every
// other case in this file. Stub the probe to force it and prove it independently agrees.
test('parseJsonStrictIntegers fallback pre-scan (stubbed probe) agrees with the reviver path', () => {
  const prev = records._setReviverSourceProbeForTests(() => false);
  try {
    assert.throws(() => records.parseJsonStrictIntegers('{"reserved":61440,"granted":1.0}', ['reserved', 'granted']));
    assert.throws(() => records.parseJsonStrictIntegers('{"reserved":61440,"granted":1e3}', ['reserved', 'granted']));
    const ok = records.parseJsonStrictIntegers('{"reserved":61440,"granted":0}', ['reserved', 'granted']);
    assert.deepStrictEqual(ok, { reserved: 61440, granted: 0 });
    // Same top-level-only scoping as the reviver path: a nested same-named float must not trip it.
    const nested = records.parseJsonStrictIntegers(
      `{"schema_version":1,"activity_id":"${AID}","type":"event","seq":3,` +
      `"ts":"${TS}","level":"info","event":"x","fields":{"seq":1.5}}`,
      ['seq', 'schema_version'],
    );
    assert.strictEqual(nested.seq, 3);
    assert.strictEqual(nested.fields.seq, 1.5);
    assert.throws(() => records.parseJsonStrictIntegers(validRecordText('1.0'), ['seq', 'schema_version']));
  } finally {
    records._setReviverSourceProbeForTests(prev);
  }
});
