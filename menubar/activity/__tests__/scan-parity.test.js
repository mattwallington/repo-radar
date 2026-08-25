'use strict';
// Codex R3 (R3-4): scan-generation parity between Python's quota.py `_scan` (the source of the
// shared `scan_vectors.json` fixture) and Node's parse.js `parseSegment`. Each vector is a set of
// raw segment texts (some deliberately lacking a final `\n` -- Ruling 41: an unterminated tail is
// ignored by BOTH runtimes, never parsed, never a finding) plus what the Python scan produced for
// it: accepted record count, sorted distinct top-level types, sorted finding kinds, and whether an
// accepted `control{name:'cancel_requested'}` was seen. Node must agree on every field.
//
// The fixture is authored on the Python side; if it is absent this file skips (never invents a
// schema of its own).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseSegment } = require('../parse');

const AID = '00000000-0000-4000-8000-000000000000';
const VECTORS = path.join(__dirname, '../../../repo_radar/tests/data/scan_vectors.json');

function scanNode(segments) {
  const records = [];
  const findings = [];
  for (const seg of segments) {
    const r = parseSegment(Buffer.from(seg.text, 'utf8'), AID);
    records.push(...r.records);
    findings.push(...r.integrity);
  }
  return {
    record_count: records.length,
    types: [...new Set(records.map((r) => r.type))].sort(),
    findings: findings.map((f) => f.kind).sort(),
    cancel_requested: records.some((r) => r.type === 'control' && r.name === 'cancel_requested'),
  };
}

if (!fs.existsSync(VECTORS)) {
  test.skip(`scan parity: ${VECTORS} not present (authored by the Python side; nothing to compare yet)`);
} else {
  const vectors = JSON.parse(fs.readFileSync(VECTORS, 'utf8'));
  assert.ok(Array.isArray(vectors) && vectors.length > 0, 'scan_vectors.json must be a non-empty array');
  for (const v of vectors) {
    test(`scan parity: ${v.name}`, () => {
      const got = scanNode(v.segments);
      const exp = v.expected;
      assert.strictEqual(got.record_count, exp.record_count, 'record_count');
      assert.deepStrictEqual(got.types, [...exp.types].sort(), 'types');
      assert.deepStrictEqual(got.findings, [...exp.findings].sort(), 'findings');
      assert.strictEqual(got.cancel_requested, Boolean(exp.cancel_requested), 'cancel_requested');
    });
  }
}
