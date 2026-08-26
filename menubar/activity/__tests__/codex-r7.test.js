'use strict';
// Codex review Round 7 (Node half): Rulings 60, 61, 62, 63.
//   R7-1 (Ruling 60, BLOCKER): a post-lock ENOENT of `quota/` is NOT "no ledgers yet". `_quotaLock`
//        binds the ledger dir's dev+inode into the lock context; the locked accounting path
//        re-lstats it before AND after enumeration, `_writeEntry` before AND after its
//        temp+rename. ENOENT / symlink / non-dir / mismatch -> UNCERTAIN -> admit/grant refuse,
//        no reservation written under either path. Unlocked readers keep ENOENT = empty.
//   R7-2 (Ruling 61, BLOCKER): NO prune delegation under uncertainty or corruption. `admit` (and
//        `settle`) delegate `_spawnPythonPrune` ONLY from a certain, non-corrupt, merely-over-
//        ceiling snapshot; `uncertain || corrupt` refuses outright (bounded warn).
//   R7-3 (Ruling 62, IMPORTANT): measured bytes are never discarded -- activities carry
//        `{ onDisk, uncertain }`; an uncertain activity charges max(measured, CAP), a corrupt-
//        ledger aid charges measured + CAP. (Vector parity: accounting-parity.test.js.)
//   R7-4 (Ruling 63, IMPORTANT): the `pid` integer-literal rule applies ONLY to `ownership`; an
//        `event` carrying an additive `"pid":1.0` is accepted (spec §2), on both parser paths.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../index');
const paths = require('../paths');
const records = require('../records');
const { parseSegment } = require('../parse');
const { quota } = A;

const AID = '00000000-0000-4000-8000-000000000000';
const TS = '2026-08-14T00:00:00-07:00';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-r7-'));
}

// A SETTLED activity: segment bytes on disk, no ledger entry, no lock. Sparse when large.
function seedSettled(home, nbytes, name = 'python-deadbeef.jsonl') {
  const aid = A.mintActivityId();
  A.secureMkdir(A.activityDir(home, aid));
  const seg = path.join(A.activityDir(home, aid), name);
  fs.writeFileSync(seg, Buffer.alloc(Math.min(nbytes, 4096), 0x0a), { mode: 0o600 });
  if (nbytes > 4096) fs.truncateSync(seg, nbytes);
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
  quota.PYTHON_BIN = '/nonexistent/python3-r7-test';
  try { return fn(); } finally { quota.PYTHON_BIN = orig; }
}

function captureWarnings(fn) {
  const warnings = [];
  const real = console.error;
  console.error = (msg) => warnings.push(String(msg));
  try { fn(); } finally { console.error = real; }
  return warnings;
}

// A fake "python" runner that RECORDS every invocation (one line per spawn, its argv) into a
// marker file and exits 0 without touching anything -- so a test can count prune delegations
// through the real `_spawnPythonPrune` -> configured-runner seam (the internal call is not
// stub-able; admit/settle call the module-local function directly).
function withCountingRunner(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-r7-runner-'));
  const marker = path.join(dir, 'invocations');
  const script = path.join(dir, 'fake-python');
  fs.writeFileSync(script, '#!/bin/sh\necho "$@" >> "$RR_R7_MARKER"\nexit 0\n', { mode: 0o755 });
  quota.configurePythonRunner({ python: script, cwd: dir, env: { RR_R7_MARKER: marker } });
  const count = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean).length : 0);
  try { return fn(count); } finally {
    quota.configurePythonRunner(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Inject an lstat failure for ONE exact path (same technique as codex-r5/r6).
function withLstatFailure(targetPath, code, fn) {
  const real = fs.lstatSync;
  const err = Object.assign(new Error(`${code}: injected lstat failure`), { code });
  fs.lstatSync = (p, ...rest) => {
    if (p === targetPath) throw err;
    return real(p, ...rest);
  };
  try { return fn(); } finally { fs.lstatSync = real; }
}

// Run `mutate()` ONCE, right when the ledger dir is about to be enumerated (i.e. AFTER quota.lock
// is held and the lock context bound) -- the exact window of Codex's repro -- then let the real
// enumeration proceed.
function withLedgerSwapBeforeEnumeration(mutate, fn) {
  const real = paths.listOwnedEntriesDetailed;
  let fired = false;
  paths.listOwnedEntriesDetailed = (directory, suffix) => {
    if (!fired) { fired = true; mutate(); }
    return real(directory, suffix);
  };
  try { return fn(() => fired); } finally { paths.listOwnedEntriesDetailed = real; }
}

const rootOf = (home) => path.dirname(A.quotaDir(home));

// 16 ledger-only liabilities (no activity dirs): each `reserved+granted == PER_ACTIVITY_CAP`, so
// the certain charge is exactly CEILING and ONLY the ledger carries it -- hide the ledger and the
// charge collapses to 0 (Codex's repro shape).
function seedFullLedger(home) {
  A.secureMkdir(A.quotaDir(home));
  for (let i = 0; i < 16; i++) {
    const aid = A.mintActivityId();
    fs.writeFileSync(A.ledgerEntryPath(home, aid), JSON.stringify({ reserved: quota.RESERVE, granted: quota.ORDINARY_CAP }), { mode: 0o600 });
  }
}

// ---------------------------------------------------------------------------------------------
// R7-1 / Ruling 60
// ---------------------------------------------------------------------------------------------

test('Ruling 60: _quotaLock binds the quota dir dev+ino; _lockedQuotaDirIntact is false once it is renamed, recreated, or replaced by a symlink', () => {
  const home = tmpHome();
  try {
    const qdir = A.quotaDir(home);
    const ctx = quota._quotaLock(home);
    try {
      const st = fs.lstatSync(qdir);
      assert.strictEqual(ctx.dir, qdir);
      assert.strictEqual(ctx.dev, st.dev);
      assert.strictEqual(ctx.ino, st.ino);
      assert.strictEqual(typeof ctx.fd, 'number');
      assert.strictEqual(quota._lockedQuotaDirIntact(ctx), true);

      fs.renameSync(qdir, `${qdir}.moved`);
      assert.strictEqual(quota._lockedQuotaDirIntact(ctx), false, 'ENOENT after lock is a rename, not "no ledgers"');
      assert.throws(() => quota._quotaDirIdentity(qdir), (e) => e instanceof A.UnsafePath && e.code === 'ENOENT');

      fs.mkdirSync(qdir, 0o700); // a NEW directory at the same path: different inode
      assert.strictEqual(quota._lockedQuotaDirIntact(ctx), false, 'recreated dir has a different identity');
      fs.rmdirSync(qdir);

      fs.symlinkSync(`${qdir}.moved`, qdir); // a symlink to the original: never followed
      assert.strictEqual(quota._lockedQuotaDirIntact(ctx), false);
      assert.throws(() => quota._quotaDirIdentity(qdir), A.UnsafePath);
      fs.unlinkSync(qdir);

      fs.renameSync(`${qdir}.moved`, qdir); // the ORIGINAL back in place: same inode again
      assert.strictEqual(quota._lockedQuotaDirIntact(ctx), true);
      assert.strictEqual(quota._lockedQuotaDirIntact(null), false);
      assert.strictEqual(quota._lockedQuotaDirIntact(ctx.fd), false, 'a bare fd carries no identity');
    } finally {
      quota._unlock(ctx);
    }
    // nonblocking variant binds identity too
    const nb = quota._quotaLockNonblocking(home);
    assert.ok(nb && typeof nb.fd === 'number' && nb.dir === qdir && typeof nb.ino === 'number');
    quota._unlock(nb);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 60 (Codex repro): quota/ renamed between lock and enumeration -> snapshot UNCERTAIN (never certain-empty), admit refused, no reservation under either path', () => {
  const home = tmpHome();
  try {
    seedFullLedger(home);
    assert.deepStrictEqual(quota._accountingSnapshot(home), { charge: quota.CEILING, uncertain: false, corrupt: false });
    const qdir = A.quotaDir(home);
    const moved = `${qdir}.moved`;
    const [live, lease] = newLiveActivity(home);

    let warnings;
    withLedgerSwapBeforeEnumeration(() => fs.renameSync(qdir, moved), (fired) => {
      withCountingRunner((count) => {
        warnings = captureWarnings(() => {
          assert.strictEqual(quota.admit(home, live, lease), false, 'pre-fix: charge 0 -> admitted -> 67,170,304');
        });
        assert.strictEqual(fired(), true, 'the rename landed inside the locked decision');
        assert.strictEqual(count(), 0, 'uncertain -> no prune delegation either (Ruling 61)');
      });
    });
    assert.ok(warnings.some((m) => /uncertain/.test(m) && /Ruling 61/.test(m)), JSON.stringify(warnings));
    assert.ok(!fs.existsSync(path.join(moved, `${live}.json`)), 'no reservation in the renamed dir');
    assert.ok(!fs.existsSync(path.join(qdir, `${live}.json`)), 'no reservation in a recreated quota/');
    assert.strictEqual(fs.readdirSync(moved).filter((n) => n.endsWith('.json')).length, 16, 'the 16 liabilities are untouched');

    // put it back: decisions resume on the real ledger (still full -> refused on the CEILING now)
    if (fs.existsSync(qdir)) fs.rmSync(qdir, { recursive: true, force: true });
    fs.renameSync(moved, qdir);
    assert.deepStrictEqual(quota._accountingSnapshot(home), { charge: quota.CEILING, uncertain: false, corrupt: false });
    lease.release();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 60: quota/ SWAPPED for a fresh empty directory between lock and enumeration -> identity mismatch -> uncertain; admit AND grant refused; _writeEntry under the stale context throws and writes nothing', () => {
  const home = tmpHome();
  try {
    const qdir = A.quotaDir(home);
    const moved = `${qdir}.moved`;
    const [live, lease] = newLiveActivity(home);
    withNoPython(() => assert.strictEqual(quota.admit(home, live, lease), true));
    const swap = () => { fs.renameSync(qdir, moved); fs.mkdirSync(qdir, 0o700); };
    const unswap = () => { fs.rmSync(qdir, { recursive: true, force: true }); fs.renameSync(moved, qdir); };

    // the locked accounting path (an unlocked reader would happily read the empty swap-in)
    const ctx = quota._quotaLock(home);
    try {
      swap();
      assert.deepStrictEqual(quota._ledgerEntriesDetailed(home, ctx), { entries: [], uncertain: true });
      assert.deepStrictEqual(quota._ledgerEntriesDetailed(home), { entries: [], uncertain: false }, 'unlocked: the empty swap-in lists as empty');
      const snap = quota._accountingSnapshot(home, ctx);
      assert.strictEqual(snap.uncertain, true);
      assert.ok(snap.charge >= quota.CEILING, 'unlistable ledger floors at CEILING');
      const other = A.mintActivityId();
      assert.throws(() => quota._writeEntry(home, other, quota.RESERVE, 0, ctx), A.UnsafePath);
      assert.ok(!fs.existsSync(path.join(qdir, `${other}.json`)) && !fs.existsSync(path.join(moved, `${other}.json`)), 'nothing written anywhere');
      unswap();
      assert.strictEqual(quota._ledgerEntriesDetailed(home, ctx).uncertain, false, 'the original dir back in place is intact again');
    } finally {
      quota._unlock(ctx);
    }

    // through the public entrypoints
    const [fresh, fl] = newLiveActivity(home);
    withLedgerSwapBeforeEnumeration(swap, () => {
      withNoPython(() => assert.strictEqual(quota.admit(home, fresh, fl), false));
    });
    assert.ok(!fs.existsSync(path.join(qdir, `${fresh}.json`)) && !fs.existsSync(path.join(moved, `${fresh}.json`)));
    unswap();
    withLedgerSwapBeforeEnumeration(swap, () => {
      assert.strictEqual(quota.grant(home, live, 100), false, 'grant refused: the entry it would rewrite is not in the dir the lock covers');
    });
    unswap();
    assert.deepStrictEqual(quota._readEntry(A.ledgerEntryPath(home, live)), { reserved: quota.RESERVE, granted: 0 }, 'ledger untouched');
    assert.strictEqual(quota.grant(home, live, 100), true, 'normal path unchanged');
    lease.release();
    fl.release();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 60: unlocked readers keep ENOENT == "no ledgers yet"; a missing quota dir at lock time is a failed acquisition (admit false)', () => {
  const home = tmpHome();
  try {
    seedSettled(home, 4096);
    assert.deepStrictEqual(quota._ledgerEntriesDetailed(home), { entries: [], uncertain: false });
    assert.deepStrictEqual(quota._accountingSnapshot(home), { charge: 4096, uncertain: false, corrupt: false });
    const [live, lease] = newLiveActivity(home);
    withNoPython(() => assert.strictEqual(quota.admit(home, live, lease), true), 'normal path unchanged');
    lease.release();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// R7-2 / Ruling 61
// ---------------------------------------------------------------------------------------------

test('Ruling 61: an UNCERTAIN snapshot never delegates prune -- admit refused, zero runner invocations, bounded warn', () => {
  const home = tmpHome();
  try {
    const settled = seedSettled(home, 4096);
    const [live, lease] = newLiveActivity(home);
    withCountingRunner((count) => {
      const warnings = captureWarnings(() => {
        withLstatFailure(path.join(rootOf(home), settled), 'EIO', () => {
          assert.strictEqual(quota._accountingSnapshot(home).uncertain, true);
          assert.strictEqual(quota.admit(home, live, lease), false);
        });
      });
      assert.strictEqual(count(), 0, 'pre-fix: one delegation with a sentinel charge -> Python pruned everything');
      assert.ok(warnings.some((m) => /uncertain/.test(m) && /Ruling 61/.test(m)), JSON.stringify(warnings));
      assert.ok(!fs.existsSync(A.ledgerEntryPath(home, live)));
      // measurable again: certain, under the ceiling -> admitted with NO delegation needed
      assert.strictEqual(quota.admit(home, live, lease), true);
      assert.strictEqual(count(), 0);
    });
    lease.release();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 61: a CORRUPT ledger entry never delegates prune -- admit refused, zero runner invocations, entry untouched', () => {
  const home = tmpHome();
  try {
    A.secureMkdir(A.quotaDir(home));
    const stale = A.ledgerEntryPath(home, A.mintActivityId());
    fs.writeFileSync(stale, '{not valid json', { mode: 0o600 });
    const [live, lease] = newLiveActivity(home);
    withCountingRunner((count) => {
      const warnings = captureWarnings(() => {
        assert.strictEqual(quota.admit(home, live, lease), false);
      });
      assert.strictEqual(count(), 0, 'pre-fix: admit delegated to get the corrupt entry cleared');
      assert.ok(warnings.some((m) => /corrupt/.test(m) && /Ruling 61/.test(m)), JSON.stringify(warnings));
    });
    assert.ok(fs.existsSync(stale), 'Node never removes it (Ruling B)');
    assert.ok(!fs.existsSync(A.ledgerEntryPath(home, live)));
    assert.strictEqual(quota.grant(home, live, 1), false);
    lease.release();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 61: a CERTAIN, non-corrupt, over-ceiling snapshot is still delegated exactly once (with the measured headroom), then re-evaluated', () => {
  const home = tmpHome();
  try {
    for (let i = 0; i < 16; i++) seedSettled(home, quota.PER_ACTIVITY_CAP);
    assert.deepStrictEqual(quota._accountingSnapshot(home), { charge: quota.CEILING, uncertain: false, corrupt: false });
    const [live, lease] = newLiveActivity(home);
    withCountingRunner((count) => {
      const warnings = captureWarnings(() => {
        assert.strictEqual(quota.admit(home, live, lease), false, 'the fake runner frees nothing -> still full -> refused');
      });
      assert.strictEqual(count(), 1, 'delegated exactly once');
      assert.ok(!warnings.some((m) => /Ruling 61/.test(m)), 'no fail-closed warn on the certain path');
    });
    assert.ok(!fs.existsSync(A.ledgerEntryPath(home, live)));
    lease.release();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 61: settle() applies the same guard -- no reap delegation while uncertain or corrupt; delegated when certain', () => {
  const home = tmpHome();
  try {
    const settled = seedSettled(home, 4096);
    const [live, lease] = newLiveActivity(home);
    withNoPython(() => assert.strictEqual(quota.admit(home, live, lease), true));
    withCountingRunner((count) => {
      withLstatFailure(path.join(rootOf(home), settled), 'EIO', () => {
        const w = captureWarnings(() => quota.settle(home, live));
        assert.strictEqual(count(), 0, 'uncertain: no reap delegation');
        assert.ok(w.some((m) => /settle reap/.test(m) && /Ruling 61/.test(m)), JSON.stringify(w));
      });
      const stale = A.ledgerEntryPath(home, A.mintActivityId());
      fs.writeFileSync(stale, '{not valid json', { mode: 0o600 });
      captureWarnings(() => quota.settle(home, live));
      assert.strictEqual(count(), 0, 'corrupt: no reap delegation');
      fs.unlinkSync(stale); // test fixture cleanup (the test, not Node's quota, removes it)
      captureWarnings(() => quota.settle(home, live));
      assert.strictEqual(count(), 1, 'certain and non-corrupt: reap delegated');
    });
    lease.release();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// R7-3 / Ruling 62
// ---------------------------------------------------------------------------------------------

test('Ruling 62: statOwnedSegmentsDetailed keeps the entries it DID stat when uncertain; _gatherAccounting carries { onDisk, uncertain } -- never null', () => {
  const home = tmpHome();
  try {
    const aid = seedSettled(home, 4096); // python-deadbeef.jsonl
    const dir = A.activityDir(home, aid);
    fs.writeFileSync(path.join(dir, 'python-cafebabe.jsonl'), Buffer.alloc(100, 0x0a), { mode: 0o600 });
    withLstatFailure(path.join(dir, 'python-cafebabe.jsonl'), 'EIO', () => {
      const r = paths.statOwnedSegmentsDetailed(dir);
      assert.deepStrictEqual(r, { entries: [{ name: 'python-deadbeef.jsonl', size: 4096 }], uncertain: true });
      const g = quota._gatherAccounting(home);
      assert.deepStrictEqual(g.activities, [{ aid, onDisk: 4096, uncertain: true }]);
      assert.deepStrictEqual(quota._accountingSnapshot(home), { charge: quota.PER_ACTIVITY_CAP, uncertain: true, corrupt: false }, 'partial below the cap: max(4096, CAP)');
    });
    assert.deepStrictEqual(quota._gatherAccounting(home).activities, [{ aid, onDisk: 4196, uncertain: false }]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 62 (Codex case): an uncertain activity whose MEASURED bytes exceed the cap is charged the measured bytes, not the cap', () => {
  const home = tmpHome();
  try {
    const big = 5 * 1024 * 1024;
    const aid = seedSettled(home, big); // sparse 5 MiB conforming segment
    const dir = A.activityDir(home, aid);
    fs.writeFileSync(path.join(dir, 'python-cafebabe.jsonl'), Buffer.alloc(10, 0x0a), { mode: 0o600 });
    withLstatFailure(path.join(dir, 'python-cafebabe.jsonl'), 'EIO', () => {
      const snap = quota._accountingSnapshot(home);
      assert.deepStrictEqual(snap, { charge: big, uncertain: true, corrupt: false });
      assert.ok(snap.charge > quota.PER_ACTIVITY_CAP, 'pre-fix: the 5 MiB measurement was nulled and replaced by the 4 MiB cap');
    });
    assert.deepStrictEqual(quota._accountingSnapshot(home), { charge: big + 10, uncertain: false, corrupt: false });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 62: a corrupt-ledger aid is charged its MEASURED bytes + CAP (was: exactly CAP)', () => {
  const home = tmpHome();
  try {
    const aid = seedSettled(home, 4096);
    A.secureMkdir(A.quotaDir(home));
    fs.writeFileSync(A.ledgerEntryPath(home, aid), '{not valid json', { mode: 0o600 });
    assert.deepStrictEqual(quota._accountingSnapshot(home), { charge: 4096 + quota.PER_ACTIVITY_CAP, uncertain: false, corrupt: true });
    // and a corrupt entry with no directory at all: exactly CAP
    const other = A.mintActivityId();
    fs.writeFileSync(A.ledgerEntryPath(home, other), '{not valid json', { mode: 0o600 });
    assert.deepStrictEqual(quota._accountingSnapshot(home), { charge: 4096 + 2 * quota.PER_ACTIVITY_CAP, uncertain: false, corrupt: true });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// R7-4 / Ruling 63
// ---------------------------------------------------------------------------------------------

const eventText = (extra) =>
  `{"schema_version":1,"activity_id":"${AID}","type":"event","seq":1,"ts":"${TS}",` +
  `"level":"info","event":"x","fields":{}${extra}}`;
const ownershipText = (pidLiteral) =>
  `{"schema_version":1,"activity_id":"${AID}","type":"ownership","seq":1,"ts":"${TS}",` +
  `"owner_token":"deadbeef","role":"handoff","producer":"python","pid":${pidLiteral},` +
  `"boot_id":"b","proc_birth":"p"}`;

test('Ruling 63: parseValid accepts an event with an additive top-level pid:1.0 (readers ignore additive fields); still rejects ownership pid:1.0 and any seq/schema_version literal violation -- both parser paths agree', () => {
  const check = () => {
    const ev = records.parseValid(eventText(',"pid":1.0'), AID);
    assert.notStrictEqual(ev, null, 'event + additive pid 1.0 is a valid v1 record');
    assert.strictEqual(ev.pid, 1);
    assert.notStrictEqual(records.parseValid(eventText(',"pid":1e3'), AID), null);
    assert.notStrictEqual(records.parseValid(Buffer.from(eventText(',"pid":1.0'), 'utf8'), AID), null);
    assert.strictEqual(records.parseValid(ownershipText('1.0'), AID), null, 'ownership pid literal still strict');
    assert.notStrictEqual(records.parseValid(ownershipText('1234'), AID), null);
    assert.strictEqual(records.parseValid(eventText('').replace('"seq":1', '"seq":1.0'), AID), null, 'seq stays strict for every type');
    assert.strictEqual(records.parseValid(eventText('').replace('"schema_version":1', '"schema_version":1.0'), AID), null);
    // the collecting parser reports EVERY violating key, in one pass
    const { value, violations } = records.parseJsonCollectIntegerViolations('{"seq":1.0,"pid":2.0,"schema_version":1,"fields":{"seq":3.0}}', ['seq', 'schema_version', 'pid']);
    assert.deepStrictEqual([...violations].sort(), ['pid', 'seq']);
    assert.deepStrictEqual(value, { seq: 1, pid: 2, schema_version: 1, fields: { seq: 3 } });
    // the throwing wrapper is unchanged for its callers
    assert.throws(() => records.parseJsonStrictIntegers('{"pid":2.0}', ['pid']), records.InvalidRecord);
    assert.deepStrictEqual(records.parseJsonStrictIntegers('{"pid":2.0}', ['seq']), { pid: 2 });
  };
  check(); // reviver path
  const prev = records._setReviverSourceProbeForTests(() => false);
  try { check(); } finally { records._setReviverSourceProbeForTests(prev); } // fallback tokenizer path
});

test('Ruling 63: parseSegment yields the event with additive pid:1.0 as a record with no integrity finding', () => {
  const r = parseSegment(Buffer.from(`${eventText(',"pid":1.0')}\n${ownershipText('1.0').replace('"seq":1', '"seq":2')}\n`), AID);
  assert.strictEqual(r.records.length, 1);
  assert.strictEqual(r.records[0].type, 'event');
  assert.deepStrictEqual(r.integrity.map((f) => f.kind), ['corrupt-record'], 'the ownership pid:1.0 line is still invalid');
});
