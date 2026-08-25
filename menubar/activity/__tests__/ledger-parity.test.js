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
