'use strict';
// Ruling 33 parity: read.js's `isProblemBearing` and quota.py's `is_problem_bearing` are the SAME
// predicate, pinned by one shared fixture (repo_radar/tests/data/problem_bearing_vectors.json,
// an array of `{ name, records, problem_bearing }`) that both test suites run verbatim. Any drift
// between the two implementations fails one side or the other.
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
      assert.strictEqual(
        read.isProblemBearing(c.records), c.problem_bearing,
        `fixture case "${c.name}" expected problem_bearing=${c.problem_bearing}`,
      );
    }
  });

  test('isProblemBearing: the fixture exercises both outcomes', () => {
    assert.ok(cases.some((c) => c.problem_bearing === true));
    assert.ok(cases.some((c) => c.problem_bearing === false));
  });
}
