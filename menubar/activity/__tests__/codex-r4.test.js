'use strict';
// Codex review Round 4 (Node half): Rulings 45-48.
//   R4-1 (Ruling 45): an activity DIRECTORY that exists but cannot be measured must not vanish
//        from the 64 MiB accounting -- `paths.statOwnedSegmentsDetailed` reports `uncertain`,
//        `quota._charge` charges such an activity its max liability (PER_ACTIVITY_CAP), and
//        `admit`/`grant` refuse while any activity is unmeasurable. A dir proven absent is 0.
//   R4-2 (Ruling 46): `trigger-glue._hasAckSignal` / `quota._hasTerminal` only parse CONFORMING
//        segment names (`paths.parseSegmentName`), like reconcile.js/read.js already did.
//   R4-3 (Ruling 47): invalid UTF-8 is decoded FATALLY on the read path -- a line with a raw 0xff
//        byte is `corrupt-record`, never U+FFFD-repaired into a valid record (Python parity).
//   R4-4 (Ruling 48): `seq` must be an integer in 0..Number.MAX_SAFE_INTEGER.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../index');
const paths = require('../paths');
const records = require('../records');
const { parseSegment } = require('../parse');
const triggerGlue = require('../trigger-glue');
const { quota, reconcile: reconcileMod } = A;

const ONE_MIB = 1024 * 1024;
const TS = '2026-08-14T00:00:00-07:00';
const isRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-r4-'));
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

function appendRaw(home, aid, name, bytes) {
  const p = path.join(A.activityDir(home, aid), name);
  const fd = fs.openSync(p, 'a', 0o600);
  fs.writeSync(fd, bytes);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
}

const rec = (aid, o) => Buffer.from(`${JSON.stringify({ schema_version: 1, activity_id: aid, ts: TS, ...o })}\n`);
const startRec = (aid) => rec(aid, { type: 'start', seq: 0, kind: 'sync', channel: 'stable', trigger: 'cli', created_by: 'python' });
const termRec = (aid) => rec(aid, { type: 'terminal', seq: 1, outcome: 'succeeded', summary: {}, by: 'deadbeef' });
const handoffRec = (aid) => rec(aid, {
  type: 'ownership', seq: 1, role: 'handoff', owner_token: 'cafebabe', producer: 'dispatcher',
  pid: 4242, boot_id: 'boot-abc', proc_birth: TS,
});

// Point quota's prune delegation at a nonexistent binary so `admit`'s release->spawn->re-evaluate
// path cannot prune anything (never throws; admit re-evaluates from disk regardless).
function withNoPython(fn) {
  const orig = quota.PYTHON_BIN;
  quota.PYTHON_BIN = '/nonexistent/python3-r4-test';
  try { return fn(); } finally { quota.PYTHON_BIN = orig; }
}

// ---------------------------------------------------------------------------------------------
// R4-1 / Ruling 45
// ---------------------------------------------------------------------------------------------

test('Ruling 45: statOwnedSegmentsDetailed -- absent dir is proven gone (not uncertain); chmod 000 dir is uncertain; restored dir is sized', (t) => {
  if (isRoot()) { t.skip('root ignores permission bits'); return; }
  const home = tmpHome();
  let dir;
  try {
    const aid = seedSettled(home, 4096);
    dir = A.activityDir(home, aid);
    const gone = A.activityDir(home, A.mintActivityId());
    assert.deepStrictEqual(paths.statOwnedSegmentsDetailed(gone), { entries: [], uncertain: false });
    assert.deepStrictEqual(paths.statOwnedSegments(gone), []);
    // a wholly absent prefix is proven gone too
    assert.deepStrictEqual(paths.statOwnedSegmentsDetailed(A.activityDir(path.join(home, 'nope'), aid)), { entries: [], uncertain: false });

    assert.deepStrictEqual(paths.statOwnedSegmentsDetailed(dir), { entries: [{ name: 'python-deadbeef.jsonl', size: 4096 }], uncertain: false });

    fs.chmodSync(dir, 0o000);
    assert.deepStrictEqual(paths.statOwnedSegmentsDetailed(dir), { entries: [], uncertain: true });
    assert.deepStrictEqual(paths.statOwnedSegments(dir), [], 'the entries-only wrapper is unchanged');

    // readable but not searchable: readdir works, lstat of the entry is refused -> uncertain
    fs.chmodSync(dir, 0o400);
    assert.strictEqual(paths.statOwnedSegmentsDetailed(dir).uncertain, true);

    fs.chmodSync(dir, 0o700);
    assert.deepStrictEqual(paths.statOwnedSegmentsDetailed(dir), { entries: [{ name: 'python-deadbeef.jsonl', size: 4096 }], uncertain: false });

    // a symlink squatting on the activity path is refused -> uncertain (it exists, bytes unknown)
    const linkAid = A.mintActivityId();
    fs.symlinkSync(dir, A.activityDir(home, linkAid));
    assert.strictEqual(paths.statOwnedSegmentsDetailed(A.activityDir(home, linkAid)).uncertain, true);
  } finally {
    if (dir) { try { fs.chmodSync(dir, 0o700); } catch (e) { /* best-effort */ } }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 45 (Codex repro): 16 x 4 MiB settled + chmod 000 one dir -> _charge does NOT drop below the ceiling; admit refused; restore -> real bytes, admissions work', (t) => {
  if (isRoot()) { t.skip('root ignores permission bits'); return; }
  const home = tmpHome();
  let victim;
  try {
    const aids = [];
    for (let i = 0; i < 16; i++) aids.push(seedSettled(home, quota.PER_ACTIVITY_CAP));
    assert.strictEqual(quota._charge(home), quota.CEILING, '16 x 4 MiB fills the 64 MiB ceiling exactly');
    assert.strictEqual(quota._accountingUncertain(home), false);

    victim = A.activityDir(home, aids[0]);
    fs.chmodSync(victim, 0o000);
    assert.strictEqual(quota._charge(home), quota.CEILING, 'the unlistable activity is charged its max liability (4 MiB), not 0');
    assert.strictEqual(quota._accountingUncertain(home), true);
    const [live, lease] = newLiveActivity(home);
    withNoPython(() => {
      assert.strictEqual(quota.admit(home, live, lease), false, 'admit refused while an activity is unmeasurable');
    });
    assert.ok(!fs.existsSync(A.ledgerEntryPath(home, live)), 'no reservation was written');

    fs.chmodSync(victim, 0o700);
    assert.strictEqual(quota._charge(home), quota.CEILING, 'restored: charge == real bytes');
    assert.strictEqual(quota._accountingUncertain(home), false);
    withNoPython(() => {
      assert.strictEqual(quota.admit(home, live, lease), false, 'still full -- refused on the ceiling, not on uncertainty');
    });

    // make real room (a genuinely deleted activity dir is 0, not uncertain) -> admission works
    fs.rmSync(victim, { recursive: true, force: true });
    assert.strictEqual(quota._charge(home), quota.CEILING - quota.PER_ACTIVITY_CAP);
    assert.strictEqual(quota._accountingUncertain(home), false);
    withNoPython(() => {
      assert.strictEqual(quota.admit(home, live, lease), true, 'admission works once every activity is measurable and there is room');
    });
    assert.strictEqual(quota._charge(home), quota.CEILING - quota.PER_ACTIVITY_CAP + quota.RESERVE);
    lease.release();
  } finally {
    if (victim) { try { fs.chmodSync(victim, 0o700); } catch (e) { /* best-effort */ } }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 45: grant is refused while ANY activity dir is unmeasurable (same outcome path as a corrupt ledger entry), and works again once restored', (t) => {
  if (isRoot()) { t.skip('root ignores permission bits'); return; }
  const home = tmpHome();
  let other;
  try {
    const [aid, lease] = newLiveActivity(home);
    withNoPython(() => assert.strictEqual(quota.admit(home, aid, lease), true));
    assert.strictEqual(quota.grant(home, aid, 100), true, 'baseline grant works');

    other = A.activityDir(home, seedSettled(home, 4096));
    fs.chmodSync(other, 0o000);
    assert.strictEqual(quota._accountingUncertain(home), true);
    assert.strictEqual(quota._charge(home), quota.PER_ACTIVITY_CAP + quota.RESERVE + 100);
    assert.strictEqual(quota.grant(home, aid, 100), false, 'grant refused while unmeasurable');
    assert.deepStrictEqual(quota._readEntry(A.ledgerEntryPath(home, aid)), { reserved: quota.RESERVE, granted: 100 }, 'ledger untouched by the refusal');

    fs.chmodSync(other, 0o700);
    assert.strictEqual(quota._accountingUncertain(home), false);
    assert.strictEqual(quota._charge(home), 4096 + quota.RESERVE + 100);
    assert.strictEqual(quota.grant(home, aid, 100), true, 'grant works again once measurable');
    lease.release();
  } finally {
    if (other) { try { fs.chmodSync(other, 0o700); } catch (e) { /* best-effort */ } }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// R4-2 / Ruling 46
// ---------------------------------------------------------------------------------------------

test('Ruling 46: _hasAckSignal ignores ownership{handoff} in a bad-name segment; sees it in a conforming one', () => {
  const home = tmpHome();
  try {
    const aid = A.mintActivityId();
    A.secureMkdir(A.activityDir(home, aid));
    appendRaw(home, aid, 'junk.jsonl', handoffRec(aid));
    appendRaw(home, aid, 'python-s3cr3t.jsonl', handoffRec(aid)); // non-hex token: not a segment
    assert.strictEqual(triggerGlue._hasAckSignal(home, aid), false, 'a bad-name file is not a segment -- never an ack');

    appendRaw(home, aid, 'dispatcher-deadbeef.jsonl', handoffRec(aid));
    assert.strictEqual(triggerGlue._hasAckSignal(home, aid), true, 'a conforming segment carrying the ack counts');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 46: quota._hasTerminal ignores a terminal in a bad-name segment; sees it in a conforming one', () => {
  const home = tmpHome();
  try {
    const aid = A.mintActivityId();
    A.secureMkdir(A.activityDir(home, aid));
    appendRaw(home, aid, 'junk.jsonl', termRec(aid));
    assert.strictEqual(quota._hasTerminal(home, aid), false);
    appendRaw(home, aid, 'python-deadbeef.jsonl', termRec(aid));
    assert.strictEqual(quota._hasTerminal(home, aid), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// R4-3 / Ruling 47
// ---------------------------------------------------------------------------------------------

// A newline-terminated terminal record whose `summary.note` string carries a raw 0xff byte --
// valid JSON once lossily decoded (0xff -> U+FFFD), invalid UTF-8 as bytes.
function badUtf8Terminal(aid) {
  const text = JSON.stringify({
    schema_version: 1, activity_id: aid, type: 'terminal', seq: 1, ts: TS,
    outcome: 'succeeded', summary: { note: '@' }, by: 'deadbeef',
  });
  const b = Buffer.from(`${text}\n`, 'utf8');
  const at = b.indexOf(0x40); // '@' placeholder -> raw 0xff
  b[at] = 0xff;
  return b;
}

test('Ruling 47: parseValid rejects a Buffer with invalid UTF-8 (fatal decode), where lossy decoding would have accepted it', () => {
  const aid = A.mintActivityId();
  const line = badUtf8Terminal(aid);
  assert.notStrictEqual(records.parseValid(line.toString('utf8'), aid), null, 'control: the U+FFFD-repaired text IS a valid record -- the old lossy path accepted it');
  assert.strictEqual(records.parseValid(line, aid), null, 'raw bytes with 0xff are an invalid record');
  assert.throws(() => records.decodeUtf8Fatal(Buffer.from([0x22, 0xff, 0x22])), TypeError);
  // a UTF-8 BOM is not silently stripped either (Python's json.loads rejects it)
  assert.strictEqual(records.parseValid(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), startRec(aid)]), aid), null);
  // and valid multi-byte UTF-8 still decodes normally
  const ok = rec(aid, { type: 'event', seq: 0, level: 'info', event: 'café ☃', fields: {} });
  assert.strictEqual(records.parseValid(ok, aid).event, 'café ☃');
});

test('Ruling 47: parseSegment classifies an invalid-UTF-8 line as corrupt-record, keeps the rest', () => {
  const aid = A.mintActivityId();
  const { records: recs, integrity } = parseSegment(Buffer.concat([startRec(aid), badUtf8Terminal(aid)]), aid);
  assert.deepStrictEqual(recs.map((r) => r.type), ['start']);
  assert.deepStrictEqual(integrity.map((f) => [f.kind, f.index, f.reason]), [['corrupt-record', 1, 'invalid UTF-8']]);
});

test('Ruling 47: reconcile sees NO terminal behind an invalid-UTF-8 terminal line -> synthesizes interrupted (Python parity)', () => {
  const home = tmpHome();
  try {
    const [aid, lease] = newLiveActivity(home);
    appendRaw(home, aid, 'python-deadbeef.jsonl', Buffer.concat([startRec(aid), badUtf8Terminal(aid)]));
    assert.strictEqual(quota._hasTerminal(home, aid), false);
    lease.release();
    assert.strictEqual(reconcileMod.synthesizeTerminal(home, aid), true, 'no valid terminal on disk -> reconcile synthesizes one');
    const outcomes = [];
    for (const seg of A.readOwnedSegments(A.activityDir(home, aid))) {
      for (const r of parseSegment(seg.data, aid).records) if (r.type === 'terminal') outcomes.push(r.outcome);
    }
    assert.deepStrictEqual(outcomes, ['interrupted']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// R4-4 / Ruling 48
// ---------------------------------------------------------------------------------------------

test('Ruling 48: seq must be an integer in 0..Number.MAX_SAFE_INTEGER', () => {
  const aid = A.mintActivityId();
  const ev = (seq) => `{"schema_version":1,"activity_id":"${aid}","type":"event","seq":${seq},"ts":"${TS}","level":"info","event":"x","fields":{}}`;
  assert.notStrictEqual(records.parseValid(ev('9007199254740991'), aid), null, 'MAX_SAFE_INTEGER is valid');
  assert.notStrictEqual(records.parseValid(ev('0'), aid), null);
  for (const bad of ['9007199254740992', '9007199254740993', '1e400', '-1', '1.5', 'true', '"1"', 'null']) {
    assert.strictEqual(records.parseValid(ev(bad), aid), null, `seq ${bad} must be rejected`);
  }
  assert.throws(() => records.buildRecord({ type: 'event', activity_id: aid, seq: Number.MAX_SAFE_INTEGER + 1, ts: TS, level: 'info', event: 'x' }), records.InvalidRecord);

  // the collision Codex found: ...992 and ...993 both parse to the same double -> no spurious
  // seq-regression, because neither is a valid record in the first place
  const seg = Buffer.from(`${ev('9007199254740992')}\n${ev('9007199254740993')}\n`);
  const { records: recs, integrity } = parseSegment(seg, aid);
  assert.strictEqual(recs.length, 0);
  assert.deepStrictEqual(integrity.map((f) => f.kind), ['corrupt-record', 'corrupt-record']);
});
