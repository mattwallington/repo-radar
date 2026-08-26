'use strict';
// Codex review Round 6 (Node half): Rulings 54, 56, 57, 58, 59.
//   R6-1 (Ruling 54, BLOCKER): the LEDGER DIRECTORY enumeration must not collapse a failure to
//        "no ledgers". `paths.listOwnedEntries` mapped every validate/readdir failure to `[]`, so a
//        transient EIO on `quota/` dropped every outstanding reservation out of the charge
//        (`{ charge: 0, uncertain: false, corrupt: false }`), a reservation was admitted, and the
//        restore left 67,170,304 bytes > ceiling. `listOwnedEntriesDetailed` reports `uncertain`;
//        the snapshot floors the charge at CEILING and admit/grant refuse. A MISSING quota dir
//        (ENOENT) is still proven "no ledgers yet".
//   R6-4 (Ruling 56, IMPORTANT): ONE normalized charge rule, pure and vector-driven
//        (`quota._computeSnapshot`; fixture parity in accounting-parity.test.js). An UNCERTAIN
//        activity (rejected root entry / unmeasurable stat) is charged EXACTLY PER_ACTIVITY_CAP --
//        never CAP + its ledger liability (4,255,844 pre-fix vs Python's 4,194,304). An unlistable
//        root or ledger dir is EXACTLY CEILING.
//   R6-3 (Ruling 58, BLOCKER): `ownership.pid` must be an integer LITERAL (`1.0` is invalid, as in
//        Python), so `_hasAckSignal` cannot ack on a record Python would reject.
//   R6-5 (Ruling 57): `schema_version` must be EXACTLY the integer literal 1 -- `1.0` is
//        `unsupported-schema` (not `corrupt-record`), matching Python.
//   R6-6 (Ruling 59, SUGGESTION): the strict-integer fallback tokenizer decides on the LAST
//        top-level occurrence of a duplicated key, like the reviver path and Python.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../index');
const paths = require('../paths');
const records = require('../records');
const { parseSegment } = require('../parse');
const trigger = require('../trigger-glue');
const { quota } = A;

const AID = '00000000-0000-4000-8000-000000000000';
const TS = '2026-08-14T00:00:00-07:00';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-r6-'));
}

// A SETTLED activity: segment bytes on disk, no ledger entry, no lock.
function seedSettled(home, nbytes) {
  const aid = A.mintActivityId();
  A.secureMkdir(A.activityDir(home, aid));
  fs.writeFileSync(A.segmentPath(home, aid, 'python', 'deadbeef'), Buffer.alloc(nbytes, 0x0a), { mode: 0o600 });
  return aid;
}

function newLiveActivity(home) {
  const aid = A.mintActivityId();
  A.secureMkdir(A.activityDir(home, aid));
  const l = A.acquire(A.ownerLockPath(home, aid));
  return [aid, l];
}

function withNoPython(fn) {
  const orig = quota.PYTHON_BIN;
  quota.PYTHON_BIN = '/nonexistent/python3-r6-test';
  try { return fn(); } finally { quota.PYTHON_BIN = orig; }
}

// Inject a readdir failure for ONE exact directory (paths.js calls `fs.readdirSync` through the
// shared `fs` module object, so the stub is seen by the real enumeration). Everything else is real.
function withReaddirFailure(targetDir, code, fn) {
  const real = fs.readdirSync;
  const err = Object.assign(new Error(`${code}: injected readdir failure`), { code });
  fs.readdirSync = (p, ...rest) => {
    if (p === targetDir) throw err;
    return real(p, ...rest);
  };
  try { return fn(); } finally { fs.readdirSync = real; }
}

// Inject an lstat failure for ONE exact path (same technique as codex-r5.test.js).
function withLstatFailure(targetPath, code, fn) {
  const real = fs.lstatSync;
  const err = Object.assign(new Error(`${code}: injected lstat failure`), { code });
  fs.lstatSync = (p, ...rest) => {
    if (p === targetPath) throw err;
    return real(p, ...rest);
  };
  try { return fn(); } finally { fs.lstatSync = real; }
}

const rootOf = (home) => path.dirname(A.quotaDir(home));

// ---------------------------------------------------------------------------------------------
// R6-1 / Ruling 54
// ---------------------------------------------------------------------------------------------

test('Ruling 54: listOwnedEntriesDetailed -- a missing quota dir is not uncertain; an EIO on readdir is; listOwnedEntries stays the .entries wrapper', () => {
  const home = tmpHome();
  try {
    const qdir = A.quotaDir(home);
    assert.deepStrictEqual(paths.listOwnedEntriesDetailed(qdir, '.json'), { entries: [], uncertain: false });
    assert.deepStrictEqual(paths.listOwnedEntries(qdir, '.json'), []);

    A.secureMkdir(qdir);
    fs.writeFileSync(path.join(qdir, `${AID}.json`), '{"reserved":61440,"granted":0}', { mode: 0o600 });
    fs.writeFileSync(path.join(qdir, 'junk.txt'), 'x', { mode: 0o600 });
    assert.deepStrictEqual(paths.listOwnedEntriesDetailed(qdir, '.json'), { entries: [`${AID}.json`], uncertain: false });
    assert.deepStrictEqual(paths.listOwnedEntriesDetailed(qdir).entries.sort(), [`${AID}.json`, 'junk.txt']);

    withReaddirFailure(qdir, 'EIO', () => {
      assert.deepStrictEqual(paths.listOwnedEntriesDetailed(qdir, '.json'), { entries: [], uncertain: true });
      assert.deepStrictEqual(paths.listOwnedEntries(qdir, '.json'), [], 'wrapper is lossy by contract');
    });
    // a readdir ENOENT (dir vanished between validate and list) is proven gone, not uncertain
    withReaddirFailure(qdir, 'ENOENT', () => {
      assert.deepStrictEqual(paths.listOwnedEntriesDetailed(qdir, '.json'), { entries: [], uncertain: false });
    });
    // a non-directory squatting on `quota` is refused by validation -> uncertain
    fs.rmSync(qdir, { recursive: true, force: true });
    fs.writeFileSync(qdir, 'not a dir', { mode: 0o600 });
    assert.strictEqual(paths.listOwnedEntriesDetailed(qdir, '.json').uncertain, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 54 (Codex repro): live reservation + EIO on the ledger dir -> uncertain, charge == CEILING, admit AND grant refused; ENOENT quota dir is not uncertain', () => {
  const home = tmpHome();
  try {
    // no quota dir at all: proven "no ledgers yet"
    const s = seedSettled(home, 4096);
    assert.deepStrictEqual(quota._ledgerEntriesDetailed(home), { entries: [], uncertain: false });
    assert.deepStrictEqual(quota._accountingSnapshot(home), { charge: 4096, uncertain: false, corrupt: false });

    const [live, lease] = newLiveActivity(home);
    withNoPython(() => assert.strictEqual(quota.admit(home, live, lease), true));
    assert.strictEqual(quota.grant(home, live, 100), true);
    assert.deepStrictEqual(quota._accountingSnapshot(home), { charge: 4096 + quota.RESERVE + 100, uncertain: false, corrupt: false });

    const [other, otherLease] = newLiveActivity(home);
    withReaddirFailure(A.quotaDir(home), 'EIO', () => {
      const led = quota._ledgerEntriesDetailed(home);
      assert.deepStrictEqual(led, { entries: [], uncertain: true });
      const snap = quota._accountingSnapshot(home);
      assert.deepStrictEqual(snap, { charge: quota.CEILING, uncertain: true, corrupt: false },
        'pre-fix: { charge: 4096, uncertain: false } -- the reservation vanished from the charge');
      assert.strictEqual(quota._charge(home), quota.CEILING);
      assert.strictEqual(quota._accountingUncertain(home), true);
      withNoPython(() => {
        assert.strictEqual(quota.admit(home, other, otherLease), false, 'admit refused while the ledger dir is unlistable');
      });
      assert.strictEqual(quota.grant(home, live, 100), false, 'grant refused while the ledger dir is unlistable');
    });
    assert.ok(!fs.existsSync(A.ledgerEntryPath(home, other)), 'no reservation was written');
    assert.deepStrictEqual(quota._readEntry(A.ledgerEntryPath(home, live)), { reserved: quota.RESERVE, granted: 100 }, 'ledger untouched');

    // restored: measurable again, decisions resume
    assert.deepStrictEqual(quota._accountingSnapshot(home), { charge: 4096 + quota.RESERVE + 100, uncertain: false, corrupt: false });
    assert.strictEqual(quota.grant(home, live, 100), true);
    withNoPython(() => assert.strictEqual(quota.admit(home, other, otherLease), true));
    void s;
    lease.release();
    otherLease.release();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// R6-4 / Ruling 56
// ---------------------------------------------------------------------------------------------

test('Ruling 56 (Codex case): a rejected root entry with a LIVE ledger entry is charged exactly PER_ACTIVITY_CAP (4,194,304), never CAP + its liability (4,255,844)', () => {
  const home = tmpHome();
  try {
    const [live, lease] = newLiveActivity(home);
    withNoPython(() => assert.strictEqual(quota.admit(home, live, lease), true));
    assert.strictEqual(quota.grant(home, live, 100), true);
    assert.deepStrictEqual(quota._accountingSnapshot(home), { charge: quota.RESERVE + 100, uncertain: false, corrupt: false });

    withLstatFailure(path.join(rootOf(home), live), 'EIO', () => {
      const inputs = quota._gatherAccounting(home);
      assert.deepStrictEqual(inputs.rejectedRootIds, [live]);
      assert.deepStrictEqual(inputs.ledger, [{ aid: live, reserved: quota.RESERVE, granted: 100 }]);
      const snap = quota._accountingSnapshot(home);
      assert.deepStrictEqual(snap, { charge: 4194304, uncertain: true, corrupt: false });
      assert.strictEqual(snap.charge, quota.PER_ACTIVITY_CAP);
      assert.notStrictEqual(snap.charge, 4255844, 'pre-fix double count');
    });
    lease.release();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 56: an unlistable Activity root is EXACTLY CEILING and uncertain (was max(total, CEILING) only when nothing was rejected; Python said 0)', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) { t.skip('root bypasses mode bits'); return; }
  const home = tmpHome();
  const root = rootOf(home);
  try {
    seedSettled(home, 4096);
    const [live, lease] = newLiveActivity(home);
    withNoPython(() => assert.strictEqual(quota.admit(home, live, lease), true));
    fs.chmodSync(root, 0o000);
    try {
      const inputs = quota._gatherAccounting(home);
      assert.strictEqual(inputs.rootListable, false);
      assert.deepStrictEqual(quota._accountingSnapshot(home), { charge: quota.CEILING, uncertain: true, corrupt: false });
    } finally {
      fs.chmodSync(root, 0o700);
    }
    assert.deepStrictEqual(quota._accountingSnapshot(home), { charge: 4096 + quota.RESERVE, uncertain: false, corrupt: false });
    lease.release();
  } finally {
    try { fs.chmodSync(root, 0o700); } catch (e) { /* best-effort */ }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Codex R7 I3 / Ruling 62 REPLACES the Round-6 arithmetic this test originally pinned: measured
// bytes are never discarded. Activities carry `{ onDisk: int, uncertain: bool }` (v2). Terms:
//   certain:   on_disk + (max(0, r+g - on_disk) if live entry)
//   uncertain: max(measured_partial, CAP)                (no ledger liability)
//   corrupt:   measured + CAP                            (was: exactly CAP)
//   unlistable ledger dir: max(sum measured, CEILING);  unlistable root: max(sum liabilities + corrupt caps, CEILING)
test('Ruling 56 -> Ruling 62: _computeSnapshot is pure -- the measurement-preserving rule, term by term, with an explicit constants override', () => {
  const C = { CEILING: 1000, PER_ACTIVITY_CAP: 100, RESERVE: 10 };
  const base = { rootListable: true, ledgerListable: true, activities: [], rejectedRootIds: [], ledger: [] };
  const snap = (over) => quota._computeSnapshot({ ...base, ...over }, C);

  assert.deepStrictEqual(snap({}), { charge: 0, uncertain: false, corrupt: false });
  // on_disk only
  assert.deepStrictEqual(snap({ activities: [{ aid: 'a', onDisk: 40, uncertain: false }] }), { charge: 40, uncertain: false, corrupt: false });
  // live entry above on_disk: on_disk + (reserved+granted - on_disk) == reserved+granted
  assert.deepStrictEqual(snap({ activities: [{ aid: 'a', onDisk: 5, uncertain: false }], ledger: [{ aid: 'a', reserved: 10, granted: 20 }] }),
    { charge: 30, uncertain: false, corrupt: false });
  // live entry below on_disk: on_disk wins, no negative liability
  assert.deepStrictEqual(snap({ activities: [{ aid: 'a', onDisk: 50, uncertain: false }], ledger: [{ aid: 'a', reserved: 10, granted: 20 }] }),
    { charge: 50, uncertain: false, corrupt: false });
  // live entry with no directory at all: on_disk 0
  assert.deepStrictEqual(snap({ ledger: [{ aid: 'z', reserved: 10, granted: 0 }] }), { charge: 10, uncertain: false, corrupt: false });
  // UNCERTAIN with a partial measurement BELOW the cap: max(partial, CAP) == CAP, liability NOT added
  assert.deepStrictEqual(snap({ activities: [{ aid: 'a', onDisk: 30, uncertain: true }], ledger: [{ aid: 'a', reserved: 10, granted: 20 }] }),
    { charge: 100, uncertain: true, corrupt: false });
  // UNCERTAIN with a partial measurement ABOVE the cap: the MEASURED bytes win (Ruling 62 -- never discarded)
  assert.deepStrictEqual(snap({ activities: [{ aid: 'a', onDisk: 150, uncertain: true }], ledger: [{ aid: 'a', reserved: 10, granted: 20 }] }),
    { charge: 150, uncertain: true, corrupt: false });
  // UNCERTAIN with nothing measured (0): exactly CAP
  assert.deepStrictEqual(snap({ activities: [{ aid: 'a', onDisk: 0, uncertain: true }] }), { charge: 100, uncertain: true, corrupt: false });
  // UNCERTAIN via rejected root id (not in activities): exactly CAP, liability not added
  assert.deepStrictEqual(snap({ rejectedRootIds: ['r'], ledger: [{ aid: 'r', reserved: 10, granted: 20 }] }),
    { charge: 100, uncertain: true, corrupt: false });
  // corrupt entry WITH measured bytes: measured + CAP (was: exactly CAP); corrupt flag set
  assert.deepStrictEqual(snap({ activities: [{ aid: 'a', onDisk: 40, uncertain: false }], ledger: [{ aid: 'a', corrupt: true }] }),
    { charge: 140, uncertain: false, corrupt: true });
  // corrupt entry whose aid has no directory: exactly CAP
  assert.deepStrictEqual(snap({ ledger: [{ aid: 'q', corrupt: true }] }), { charge: 100, uncertain: false, corrupt: true });
  // corrupt AND uncertain aid: corrupt rule applies (measured + CAP), uncertain flag still set
  assert.deepStrictEqual(snap({ activities: [{ aid: 'a', onDisk: 40, uncertain: true }], ledger: [{ aid: 'a', corrupt: true }] }),
    { charge: 140, uncertain: true, corrupt: true });
  // mixed: measurable 40 + uncertain max(7, CAP) + corrupt (0 + CAP) + live-only 10
  assert.deepStrictEqual(snap({
    activities: [{ aid: 'a', onDisk: 40, uncertain: false }, { aid: 'b', onDisk: 7, uncertain: true }],
    ledger: [{ aid: 'c', corrupt: true }, { aid: 'd', reserved: 10, granted: 0 }, { aid: 'b', reserved: 10, granted: 5 }],
  }), { charge: 40 + 100 + 100 + 10, uncertain: true, corrupt: true });
  // unlistable ROOT: max(sum live liabilities + corrupt caps, CEILING), uncertain, corrupt reported
  assert.deepStrictEqual(snap({ rootListable: false, ledger: [{ aid: 'a', reserved: 10, granted: 20 }] }),
    { charge: 1000, uncertain: true, corrupt: false });
  assert.deepStrictEqual(snap({ rootListable: false, ledger: [{ aid: 'a', reserved: 10, granted: 990 }, { aid: 'b', corrupt: true }] }),
    { charge: 1100, uncertain: true, corrupt: true });
  // unlistable LEDGER dir: max(sum measured (as certain, no liabilities), CEILING), uncertain
  assert.deepStrictEqual(snap({ ledgerListable: false, activities: [{ aid: 'a', onDisk: 40, uncertain: false }], ledger: [{ aid: 'a', corrupt: true }] }),
    { charge: 1000, uncertain: true, corrupt: true });
  assert.deepStrictEqual(snap({ ledgerListable: false, activities: [{ aid: 'a', onDisk: 900, uncertain: false }, { aid: 'b', onDisk: 300, uncertain: true }] }),
    { charge: 1200, uncertain: true, corrupt: false });
  // both unlistable: root rule (liabilities), still floored at CEILING
  assert.deepStrictEqual(snap({ rootListable: false, ledgerListable: false }), { charge: 1000, uncertain: true, corrupt: false });
  // no constants override -> module constants
  assert.deepStrictEqual(quota._computeSnapshot({ ...base, activities: [{ aid: 'a', onDisk: 0, uncertain: true }] }),
    { charge: quota.PER_ACTIVITY_CAP, uncertain: true, corrupt: false });
  assert.deepStrictEqual(quota._computeSnapshot({ ...base, rootListable: false }),
    { charge: quota.CEILING, uncertain: true, corrupt: false });
});

// ---------------------------------------------------------------------------------------------
// R6-3 / Ruling 58
// ---------------------------------------------------------------------------------------------

const ownershipText = (pidLiteral, seq = 1) =>
  `{"schema_version":1,"activity_id":"${AID}","type":"ownership","seq":${seq},"ts":"${TS}",` +
  `"owner_token":"deadbeef","role":"handoff","producer":"python","pid":${pidLiteral},` +
  `"boot_id":"b","proc_birth":"p"}`;

test('Ruling 58: parseValid rejects ownership{pid:1.0} (raw text) and accepts pid:1234; nested fields.pid floats are untouched', () => {
  assert.strictEqual(records.parseValid(ownershipText('1.0'), AID), null);
  assert.strictEqual(records.parseValid(ownershipText('1e3'), AID), null);
  assert.strictEqual(records.parseValid(Buffer.from(ownershipText('1.0'), 'utf8'), AID), null);
  const ok = records.parseValid(ownershipText('1234'), AID);
  assert.notStrictEqual(ok, null);
  assert.strictEqual(ok.pid, 1234);
  // top-level only: an event's `fields.pid` may be a float
  const ev = `{"schema_version":1,"activity_id":"${AID}","type":"event","seq":1,"ts":"${TS}",` +
    `"level":"info","event":"x","fields":{"pid":1.5}}`;
  assert.notStrictEqual(records.parseValid(ev, AID), null);
  // fallback tokenizer path agrees
  const prev = records._setReviverSourceProbeForTests(() => false);
  try {
    assert.strictEqual(records.parseValid(ownershipText('1.0'), AID), null);
    assert.notStrictEqual(records.parseValid(ownershipText('1234'), AID), null);
  } finally {
    records._setReviverSourceProbeForTests(prev);
  }
});

test('Ruling 58: _hasAckSignal is false for a conforming segment whose only ack record has pid:1.0, true with pid:1234', () => {
  const home = tmpHome();
  try {
    const aid = A.mintActivityId();
    A.secureMkdir(A.activityDir(home, aid));
    const seg = A.segmentPath(home, aid, 'python', 'deadbeef');
    const line = (pid) => ownershipText(pid).replace(AID, aid) + '\n';
    fs.writeFileSync(seg, line('1.0'), { mode: 0o600 });
    assert.strictEqual(trigger._hasAckSignal(home, aid), false, 'pid:1.0 is not a valid ownership record');
    fs.writeFileSync(seg, line('1234'), { mode: 0o600 });
    assert.strictEqual(trigger._hasAckSignal(home, aid), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// R6-5 / Ruling 57
// ---------------------------------------------------------------------------------------------

test('Ruling 57: schema_version must be EXACTLY the integer literal 1 -- true / 1.0 / "1" / missing / 2 are unsupported-schema, not corrupt-record', () => {
  const start = (sv) => `{"schema_version":${sv},"activity_id":"${AID}","type":"start","seq":0,"ts":"${TS}",` +
    `"kind":"sync","channel":"stable","trigger":"cli","created_by":"python"}\n`;
  for (const sv of ['true', '1.0', '1e0', '"1"', '2', 'null']) {
    const r = parseSegment(Buffer.from(start(sv)), AID);
    assert.deepStrictEqual(r.records, [], sv);
    assert.deepStrictEqual(r.integrity.map((f) => f.kind), ['unsupported-schema'], `schema_version=${sv}`);
  }
  const missing = start('1').replace('"schema_version":1,', '');
  assert.deepStrictEqual(parseSegment(Buffer.from(missing), AID).integrity.map((f) => f.kind), ['unsupported-schema']);
  const ok = parseSegment(Buffer.from(start('1')), AID);
  assert.strictEqual(ok.records.length, 1);
  assert.deepStrictEqual(ok.integrity, []);
  // the strict check is top-level only; a nested schema_version float is not the record's version
  const nested = `{"schema_version":1,"activity_id":"${AID}","type":"event","seq":0,"ts":"${TS}",` +
    `"level":"info","event":"x","fields":{"schema_version":1.0}}\n`;
  assert.deepStrictEqual(parseSegment(Buffer.from(nested), AID).integrity, []);
  // not-an-object and malformed JSON classifications are unchanged
  assert.deepStrictEqual(parseSegment(Buffer.from('[1.0]\n"s"\nnope\n'), AID).integrity.map((f) => f.kind),
    ['corrupt-record', 'corrupt-record', 'corrupt-record']);
});

// ---------------------------------------------------------------------------------------------
// R6-6 / Ruling 59
// ---------------------------------------------------------------------------------------------

test('Ruling 59: fallback tokenizer decides on the LAST top-level occurrence of a duplicated integer key (agrees with the reviver path)', () => {
  const firstBad = '{"seq":1.0,"seq":1}';
  const lastBad = '{"seq":1,"seq":1.0}';
  const nestedThenGood = '{"fields":{"seq":1.0},"seq":2,"seq":3}';
  // reviver path (what actually runs on Node >= 21 / Electron ^32)
  assert.deepStrictEqual(records.parseJsonStrictIntegers(firstBad, ['seq']), { seq: 1 });
  assert.throws(() => records.parseJsonStrictIntegers(lastBad, ['seq']), records.InvalidRecord);
  assert.strictEqual(records.parseJsonStrictIntegers(nestedThenGood, ['seq']).seq, 3);
  // forced fallback path
  const prev = records._setReviverSourceProbeForTests(() => false);
  try {
    assert.deepStrictEqual(records.parseJsonStrictIntegers(firstBad, ['seq']), { seq: 1 });
    assert.throws(() => records.parseJsonStrictIntegers(lastBad, ['seq']), records.InvalidRecord);
    assert.strictEqual(records.parseJsonStrictIntegers(nestedThenGood, ['seq']).seq, 3);
    assert.throws(() => records.parseJsonStrictIntegers('{"seq":1,"pid":2,"pid":2.0}', ['seq', 'pid']), records.InvalidRecord);
  } finally {
    records._setReviverSourceProbeForTests(prev);
  }
});
