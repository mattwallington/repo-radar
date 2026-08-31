'use strict';
// Ruling 33 / Ruling 37 parity: read.js's `isProblemBearing` and quota.py's `is_problem_bearing`
// are the SAME predicate over a SCAN, pinned by one shared v2 fixture
// (repo_radar/tests/data/problem_bearing_vectors.json, an array of
// `{ name, scan: { records, findings, rejected }, problem_bearing }`) that both test suites run
// verbatim. Any drift between the two implementations fails one side or the other. A fixture
// still in the v1 shape (top-level `records`, no `scan`) fails loudly here rather than being
// silently adapted -- the contract is the scan, not the records.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const read = require('../read');

const FIXTURE = path.join(__dirname, '..', '..', '..', 'repo_radar', 'tests', 'data', 'problem_bearing_vectors.json');

if (!fs.existsSync(FIXTURE)) {
  test.skip(`problem-bearing parity: shared fixture missing at ${FIXTURE}`, () => {});
} else {
  const cases = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert.ok(Array.isArray(cases) && cases.length > 0, 'fixture must be a non-empty array');

  test(`isProblemBearing: matches the shared Python fixture (${cases.length} cases)`, () => {
    for (const c of cases) {
      assert.strictEqual(typeof c.problem_bearing, 'boolean', `${c.name}: fixture expectation must be boolean`);
      assert.ok(c.scan && typeof c.scan === 'object' && !Array.isArray(c.scan),
        `${c.name}: fixture is not v2-shaped (expected a \`scan\` object; got ${Object.keys(c).join(',')})`);
      for (const k of ['records', 'findings', 'rejected']) {
        assert.ok(Array.isArray(c.scan[k]), `${c.name}: scan.${k} must be an array`);
      }
      assert.strictEqual(
        read.isProblemBearing(c.scan), c.problem_bearing,
        `fixture case "${c.name}" expected problem_bearing=${c.problem_bearing}`,
      );
    }
  });

  test('isProblemBearing: the fixture exercises every scan-level rule (findings, rejected, >=2 terminals)', () => {
    const v2 = cases.filter((c) => c.scan && typeof c.scan === 'object');
    assert.ok(v2.some((c) => c.scan.findings.length > 0), 'a findings-only case');
    assert.ok(v2.some((c) => c.scan.rejected.length > 0), 'a rejected-only case');
    assert.ok(v2.some((c) => c.scan.records.filter((r) => r && r.type === 'terminal').length >= 2), 'a duplicate-terminal case');
  });

  test('isProblemBearing: the fixture exercises both outcomes', () => {
    assert.ok(cases.some((c) => c.problem_bearing === true));
    assert.ok(cases.some((c) => c.problem_bearing === false));
  });
}
