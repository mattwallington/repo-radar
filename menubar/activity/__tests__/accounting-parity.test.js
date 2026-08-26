'use strict';
// Codex R6 (R6-4 / Ruling 56) -> Codex R7 (R7-3 / Ruling 62): charge-arithmetic parity between
// Python's quota.py `_compute_snapshot` (the source of the shared `accounting_vectors.json`
// fixture) and Node's quota.js `_computeSnapshot`. Each vector is the already-gathered accounting
// INPUT (root/ledger listability, per-activity `{ on_disk: int, uncertain: bool }` -- schema v2:
// the PARTIAL measurement is always carried, never nulled -- rejected root ids, and the ledger
// entries) plus the constants it was computed under and the `{ charge, uncertain, corrupt }`
// Python produced. Node must agree on every field -- the function is PURE, so this is
// arithmetic parity with no filesystem involved.
//
// The fixture is authored on the Python side; if it is absent this file skips (never invents a
// schema of its own). A v1-shaped fixture (`on_disk: null` for unmeasurable, no `uncertain`
// field) FAILS loudly here rather than being silently coerced -- v1 and v2 disagree on the rule.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { quota } = require('../index');

const VECTORS = path.join(__dirname, '../../../repo_radar/tests/data/accounting_vectors.json');

// Fixture `inputs` (snake_case, as the Python side gathers them) -> Node's `_gatherAccounting`
// output shape (camelCase). Field-for-field, no interpretation. Throws on a v1-shaped activity.
function toNodeInputs(inp, name) {
  return {
    rootListable: Boolean(inp.root_listable),
    ledgerListable: Boolean(inp.ledger_listable),
    activities: (inp.activities || []).map((a) => {
      assert.ok(Number.isInteger(a.on_disk), `${name}: fixture is not schema v2 -- activity ${a.aid} has on_disk=${JSON.stringify(a.on_disk)} (expected an integer; v1 used null)`);
      assert.strictEqual(typeof a.uncertain, 'boolean', `${name}: fixture is not schema v2 -- activity ${a.aid} lacks a boolean "uncertain"`);
      return { aid: a.aid, onDisk: a.on_disk, uncertain: a.uncertain };
    }),
    rejectedRootIds: [...(inp.rejected_root_ids || [])],
    ledger: (inp.ledger || []).map((e) => (e.corrupt === true
      ? { aid: e.aid, corrupt: true }
      : { aid: e.aid, reserved: e.reserved, granted: e.granted })),
  };
}

if (!fs.existsSync(VECTORS)) {
  test.skip(`accounting parity: ${VECTORS} not present (authored by the Python side; nothing to compare yet)`);
} else {
  const vectors = JSON.parse(fs.readFileSync(VECTORS, 'utf8'));
  assert.ok(Array.isArray(vectors) && vectors.length > 0, 'accounting_vectors.json must be a non-empty array');
  for (const v of vectors) {
    test(`accounting parity: ${v.name}`, () => {
      const got = quota._computeSnapshot(toNodeInputs(v.inputs, v.name), v.constants);
      assert.deepStrictEqual(
        { charge: got.charge, uncertain: got.uncertain, corrupt: got.corrupt },
        { charge: v.expected.charge, uncertain: Boolean(v.expected.uncertain), corrupt: Boolean(v.expected.corrupt) },
      );
    });
  }
}
