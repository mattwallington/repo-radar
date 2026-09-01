'use strict';
// Task 2.2b: the Node half of the shared cross-language behavior-vector harness. Reads the SAME
// committed behavior-vectors.json that repo_radar/tests/test_activity_behavior_vectors.py reads
// and asserts the exact `expect` block for each vector, proving both languages produce
// IDENTICAL OBSERVABLE OUTCOMES (admit/grant true/false, charge, ledger-entry field values) for
// the same scenario -- NOT identical mechanism: Node delegates all destructive cleanup to a
// spawned Python subprocess (Ruling B), Python does it in-process; none of these 4 vectors
// happen to need that delegation, so both sides can run entirely in-process here too. The
// delegation mechanism itself is proven separately by quota-delegation.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../index');
const { quota, reconcile } = A;

const VECTORS = JSON.parse(fs.readFileSync(path.join(__dirname, 'behavior-vectors.json'), 'utf8'));

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-behavior-vectors-'));
}

function newActivity(home) {
  const aid = A.mintActivityId();
  A.secureMkdir(A.activityDir(home, aid));
  const l = A.acquire(A.ownerLockPath(home, aid));
  return [aid, l];
}

function writeRecord(home, aid, rec) {
  const full = { schema_version: 1, activity_id: aid, ts: '2026-08-14T00:00:00-07:00', ...rec };
  const seg = A.segmentPath(home, aid, 'python', 'deadbeef');
  const fd = A.secureOpenAppend(seg);
  fs.writeSync(fd, Buffer.from(`${JSON.stringify(full)}\n`));
  fs.closeSync(fd);
}

function readEntry(home, aid) {
  return JSON.parse(fs.readFileSync(A.ledgerEntryPath(home, aid), 'utf8'));
}

const SCENARIOS = {
  grant_cap_and_reserve_partition(v) {
    const home = tmpHome();
    const [aid, l] = newActivity(home);
    const actual = {};
    actual.admit_result = quota.admit(home, aid, l);
    let entry = readEntry(home, aid);
    actual.reserved_after_admit = entry.reserved;
    actual.granted_after_admit = entry.granted;
    actual.grant_ordinary_cap_result = quota.grant(home, aid, v.params.ordinary_cap);
    entry = readEntry(home, aid);
    actual.granted_after_ordinary_grant = entry.granted;
    actual.grant_one_more_result = quota.grant(home, aid, 1);
    entry = readEntry(home, aid);
    actual.granted_after_refused_grant = entry.granted;
    actual.reserved_after_refused_grant = entry.reserved;
    return actual;
  },

  corrupt_ledger_charged_full_cap() {
    const home = tmpHome();
    A.secureMkdir(A.quotaDir(home));
    const aid = A.mintActivityId();
    fs.writeFileSync(A.ledgerEntryPath(home, aid), '{not valid json', { mode: 0o600 });
    return { charge_equals: quota._charge(home) };
  },

  refuse_while_corrupt_at_real_ceiling(v) {
    const home = tmpHome();
    const actual = {};

    const [live, ll] = newActivity(home);
    actual.live_admit_result = quota.admit(home, live, ll); // BEFORE any corruption exists

    const [held, hl] = newActivity(home); // owner.lock HELD -- deliberately never released
    void hl;
    fs.writeFileSync(A.ledgerEntryPath(home, held), '{not valid json', { mode: 0o600 });

    const [fresh, fl] = newActivity(home);
    actual.fresh_admit_result = quota.admit(home, fresh, fl);
    actual.live_grant_result = quota.grant(home, live, v.params.grant_nbytes);
    return actual;
  },

  terminal_durability_failure_preserves_reservation() {
    const home = tmpHome();
    const [aid, l] = newActivity(home);
    const actual = {};
    actual.admit_result = quota.admit(home, aid, l);
    writeRecord(home, aid, {
      type: 'start', seq: 0, kind: 'sync', channel: 'stable', trigger: 'cli', created_by: 'python',
    });
    l.release(); // simulate crash after start, before terminal

    const realFsync = fs.fsyncSync;
    fs.fsyncSync = () => { throw new Error('no fsync'); };
    try {
      actual.synthesize_result = reconcile.synthesizeTerminal(home, aid);
    } finally {
      fs.fsyncSync = realFsync;
    }
    actual.ledger_entry_survives = fs.existsSync(A.ledgerEntryPath(home, aid));
    return actual;
  },
};

for (const v of VECTORS) {
  test(`behavior-vector: ${v.name}`, () => {
    const run = SCENARIOS[v.scenario];
    assert.ok(run, `no Node runner registered for scenario "${v.scenario}"`);
    const actual = run(v);
    for (const [key, expected] of Object.entries(v.expect)) {
      assert.deepStrictEqual(actual[key], expected, `${v.name}: ${key}`);
    }
  });
}
