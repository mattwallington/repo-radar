'use strict';
// Node mirror of the key scenarios in repo_radar/tests/test_activity_quota.py (Task 2.2b),
// adapted to Ruling B (Node never unlinks the ledger entry ITSELF; corrupt-clearing and
// over-ceiling pruning are delegated to python -m repo_radar.activity.prune, proven separately
// by quota-delegation.test.js). See ../quota.js's header comment for the full architecture,
// including the Codex B3(a)/(b)/(c) fixes: settle() now (b3c) excludes a durable-terminal entry
// from `_charge` and proactively (best-effort, never-raises) delegates a bounded reap -- but that
// reap can only physically remove an entry once its owner.lock is free, so a scenario with the
// lease still HELD (like the one directly below) still legitimately leaves the entry on disk,
// exactly as before.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../index');
const { quota } = A;

// Tracks every tmp home this file mints so a single after() sweep can clean them all up (the
// suite has had disk-exhausting tmp accumulation -- see the brief for Codex B3).
const _tmpHomes = [];
function tmpHome() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-quota-'));
  _tmpHomes.push(h);
  return h;
}
after(() => {
  for (const h of _tmpHomes) {
    try { fs.rmSync(h, { recursive: true, force: true }); } catch (e) { /* best-effort */ }
  }
});

function newActivity(home) {
  const aid = A.mintActivityId();
  A.secureMkdir(A.activityDir(home, aid));
  const l = A.acquire(A.ownerLockPath(home, aid));
  return [aid, l];
}

function readEntry(home, aid) {
  return JSON.parse(fs.readFileSync(A.ledgerEntryPath(home, aid), 'utf8'));
}

// Writes a durable (fsynced) `terminal` record straight into the activity's segment, the same
// shape writer.js's terminal() durably appends -- without driving the full ActivityWriter
// machinery, so tests here can exercise `_hasTerminal`/`_charge` in isolation.
function writeTerminalRecord(home, aid, outcome = 'succeeded') {
  const rec = {
    schema_version: 1, activity_id: aid, type: 'terminal', seq: 1,
    ts: '2026-08-14T00:00:00-07:00', outcome, summary: {}, by: A.mintToken(),
  };
  const seg = A.segmentPath(home, aid, 'electron', 'deadbeef');
  const fd = A.secureOpenAppend(seg);
  fs.writeSync(fd, Buffer.from(`${JSON.stringify(rec)}\n`));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
}

test('admit writes a {reserved, granted} JSON ledger entry; settle leaves it in place while the lease is still held', () => {
  const home = tmpHome();
  const [aid, l] = newActivity(home);
  assert.strictEqual(quota.admit(home, aid, l), true);
  assert.deepStrictEqual(readEntry(home, aid), { reserved: quota.RESERVE, granted: 0 });

  assert.doesNotThrow(() => quota.settle(home, aid));
  // No durable terminal exists yet (only admit() ran -- no start/terminal record), and the lease
  // `l` is still HELD (never released) -- so neither the charge exclusion nor the delegated reap
  // apply here: the entry legitimately remains, and still counts as outstanding. Codex
  // B3(c)'s fix is exercised by the dedicated tests below (a durable terminal present, and/or
  // the lease released first).
  assert.ok(fs.existsSync(A.ledgerEntryPath(home, aid)), 'settle must not remove an entry with no durable terminal / a still-held lease');
});

test('Codex R2: a durable terminal ALONE (no reap yet) does NOT zero _charge -- the old _hasTerminal visibility-exclusion is removed; only settle()\'s reap (which removes the ledger entry -- see quota-delegation.test.js\'s full-lifecycle B3(c) test) can', () => {
  const home = tmpHome();
  const [aid, l] = newActivity(home);
  assert.strictEqual(quota.admit(home, aid, l), true);
  assert.strictEqual(quota.grant(home, aid, 1000), true);

  const before = quota._charge(home);
  const committedBefore = quota._committed(home);
  assert.ok(before > committedBefore, 'before a terminal lands, the reserve+granted is genuinely outstanding');
  assert.ok(before - committedBefore > 50000, `outstanding should be on the order of the ~60 KiB RESERVE (got ${before - committedBefore})`);

  writeTerminalRecord(home, aid);
  assert.strictEqual(quota._hasTerminal(home, aid), true, 'the terminal is visible on disk');
  assert.ok(fs.existsSync(A.ledgerEntryPath(home, aid)), 'terminal VISIBILITY alone must not reap the entry');

  // Codex R2: terminal visibility is not settlement (Codex's own ruling) -- with no reap, this
  // entry is still live and must be charged conservatively: committed bytes (now including the
  // terminal's own bytes) PLUS whatever of reserved+granted isn't yet on disk. This is exactly
  // the single-scan formula max(size, reserved+granted), never an exclusion down to 0.
  const onDisk = quota._onDisk(home, aid);
  const expectedOutstanding = Math.max(0, quota.RESERVE + 1000 - onDisk);
  const after = quota._charge(home);
  assert.strictEqual(
    after, quota._committed(home) + expectedOutstanding,
    'a visible-but-not-reaped terminal must still charge conservatively (max(size, reserved+granted)), never drop to 0',
  );
  assert.ok(expectedOutstanding > 0, 'sanity: this scenario is genuinely still outstanding, not a coincidental 0');
});

test('_hasTerminal reflects a durable terminal record on disk, not merely a start', () => {
  const home = tmpHome();
  const [aid] = newActivity(home);
  assert.strictEqual(quota._hasTerminal(home, aid), false, 'no records at all yet');

  const startRec = {
    schema_version: 1, activity_id: aid, type: 'start', seq: 0,
    ts: '2026-08-14T00:00:00-07:00', kind: 'sync', channel: 'stable', trigger: 'cli', created_by: 'python',
  };
  const startSeg = A.segmentPath(home, aid, 'python', 'cafebabe');
  const sfd = A.secureOpenAppend(startSeg);
  fs.writeSync(sfd, Buffer.from(`${JSON.stringify(startRec)}\n`));
  fs.closeSync(sfd);
  assert.strictEqual(quota._hasTerminal(home, aid), false, 'a start record alone is not a terminal');

  writeTerminalRecord(home, aid);
  assert.strictEqual(quota._hasTerminal(home, aid), true);
});

// Ruling 41 (trailing-line contract, universal): a segment's final remainder that lacks a
// terminating `\n` is IGNORED everywhere, even when it happens to be valid JSON -- the
// durability contract is record+`\n`, and a missing newline is a torn write. `_hasTerminal` now
// routes through `parse.parseSegment`, the one shared implementation of this rule (previously it
// had its own private byte-splitter that would accept a newline-less-but-parseable tail).
test('Ruling 41: _hasTerminal ignores a terminal record with no trailing newline (torn write), then sees it once the newline lands', () => {
  const home = tmpHome();
  const [aid] = newActivity(home);
  const rec = {
    schema_version: 1, activity_id: aid, type: 'terminal', seq: 1,
    ts: '2026-08-14T00:00:00-07:00', outcome: 'succeeded', summary: {}, by: A.mintToken(),
  };
  const seg = A.segmentPath(home, aid, 'electron', 'deadbeef');
  const fd = A.secureOpenAppend(seg);
  fs.writeSync(fd, Buffer.from(JSON.stringify(rec))); // NO trailing \n -- a torn write
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  assert.strictEqual(
    quota._hasTerminal(home, aid), false,
    'a newline-less-but-valid-JSON tail must be ignored, not counted as a durable terminal',
  );

  // The exact same record bytes, now durably terminated with the missing `\n`.
  const fd2 = A.secureOpenAppend(seg);
  fs.writeSync(fd2, Buffer.from('\n'));
  fs.fsyncSync(fd2);
  fs.closeSync(fd2);
  assert.strictEqual(quota._hasTerminal(home, aid), true, 'once `\\n`-terminated, the same record is seen');
});

test('configurePythonRunner is a function; a falsy/invalid value un-configures back to the source-checkout default (never throws)', () => {
  assert.strictEqual(typeof quota.configurePythonRunner, 'function');
  assert.doesNotThrow(() => quota.configurePythonRunner(null));
  assert.doesNotThrow(() => quota.configurePythonRunner({}));
  assert.doesNotThrow(() => quota.configurePythonRunner({ python: '' }));
  assert.doesNotThrow(() => quota.configurePythonRunner(undefined));
});

test('grant enforces both the per-activity cap and the global ceiling', () => {
  const home = tmpHome();
  const [aid, l] = newActivity(home);
  quota.admit(home, aid, l);
  assert.strictEqual(quota.grant(home, aid, quota.ORDINARY_CAP), true);
  assert.strictEqual(quota.grant(home, aid, 1), false); // per-activity cap hit
  assert.strictEqual(readEntry(home, aid).granted, quota.ORDINARY_CAP);
});

test('_parseEntry rejects impossible/malformed counters', () => {
  const good = quota._parseEntry(Buffer.from(JSON.stringify({ reserved: quota.RESERVE, granted: 0 })));
  assert.deepStrictEqual(good, { reserved: quota.RESERVE, granted: 0 });

  const cases = [
    JSON.stringify({ reserved: 0, granted: 0 }), // reserved must equal RESERVE
    JSON.stringify({ reserved: quota.RESERVE, granted: quota.PER_ACTIVITY_CAP }), // over cap
    JSON.stringify({ reserved: quota.RESERVE, granted: -1 }), // negative granted
    JSON.stringify({ reserved: quota.RESERVE, granted: true }), // boolean, not int
    JSON.stringify({ reserved: quota.RESERVE, granted: 1.5 }), // non-integer
    JSON.stringify({ reserved: quota.RESERVE }), // missing granted
    '{not valid json',
    JSON.stringify([1, 2, 3]), // not an object
    JSON.stringify('a string'),
  ];
  for (const c of cases) {
    assert.strictEqual(quota._parseEntry(Buffer.from(c)), quota.CORRUPT, c);
  }
});

test('_writeEntry rejects a path-traversal or absolute activity_id before touching disk', () => {
  const home = tmpHome();
  A.secureMkdir(A.quotaDir(home));
  for (const bad of ['../../evil', '/abs/evil', '..', 'a/b', 'id\nwith\nnewline', '']) {
    assert.throws(() => quota._writeEntry(home, bad, quota.RESERVE, 0), A.UnsafePath, bad);
  }
});

test('admit rejects a traversal activity_id via the public entrypoint (fails closed, nothing escapes)', () => {
  const home = tmpHome();
  const [, l] = newActivity(home);
  assert.strictEqual(quota.admit(home, '../../evil', l), false);
  assert.ok(!fs.existsSync(path.join(path.dirname(home), 'evil.json')));
});

test('a symlinked/FIFO/directory ledger entry is CLASSIFIED as CORRUPT, never silently skipped', () => {
  const home = tmpHome();
  A.secureMkdir(A.quotaDir(home));

  const symAid = A.mintActivityId();
  const outside = path.join(home, 'outside.json');
  fs.writeFileSync(outside, JSON.stringify({ reserved: quota.RESERVE, granted: 0 }));
  fs.symlinkSync(outside, A.ledgerEntryPath(home, symAid));

  const dirAid = A.mintActivityId();
  fs.mkdirSync(A.ledgerEntryPath(home, dirAid));

  const entries = new Map(quota._ledgerEntries(home));
  assert.strictEqual(entries.get(symAid), quota.CORRUPT);
  assert.strictEqual(entries.get(dirAid), quota.CORRUPT);
  assert.strictEqual(quota._hasCorrupt(home), true);
});

test('_committed / _onDisk use fstat sizes only -- SIZE accounting never reads segment content', () => {
  const home = tmpHome();
  const [aid, l] = newActivity(home);
  quota.admit(home, aid, l);
  const big = A.segmentPath(home, aid, 'python', 'cafebabe');
  fs.writeFileSync(big, Buffer.alloc(1024 * 1024, 0x78));

  // The pathsMod module object is shared by reference (Node's require cache): stubbing its
  // readOwnedSegments here also changes what quota.js's own `paths.readOwnedSegments` calls
  // resolve to, since quota.js did `const paths = require('./paths')` -- the same object.
  //
  // Scoped to `_onDisk`/`_committed` DIRECTLY (not routed through `grant`/`_charge`): Codex
  // B3(c)'s `_hasTerminal` legitimately performs a BOUNDED content read of its own, for lifecycle
  // detection (does a durable terminal exist), which `_charge` now also calls -- a deliberately
  // separate concern from the fstat-only SIZE accounting this test protects (see quota.js's
  // `_hasTerminal` comment). Stubbing readOwnedSegments to throw and then calling `grant()`
  // wholesale would trip over that unrelated, intentional read instead of proving this invariant.
  const pathsMod = require('../paths');
  const realReadOwnedSegments = pathsMod.readOwnedSegments;
  pathsMod.readOwnedSegments = () => {
    throw new Error('_onDisk/_committed must not read segment CONTENTS for size accounting');
  };
  let onDisk;
  let committed;
  try {
    onDisk = quota._onDisk(home, aid); // must succeed using fstat-only sizing (statOwnedSegments)
    committed = quota._committed(home);
  } finally {
    pathsMod.readOwnedSegments = realReadOwnedSegments;
  }

  const realTotal = fs.readdirSync(A.activityDir(home, aid))
    .filter((f) => f.endsWith('.jsonl'))
    .reduce((s, f) => s + fs.statSync(path.join(A.activityDir(home, aid), f)).size, 0);
  assert.strictEqual(onDisk, realTotal);
  assert.strictEqual(committed, realTotal);

  // grant() itself (readOwnedSegments restored) still works normally -- its `_charge` now also
  // calls `_hasTerminal` for lifecycle detection, a separate bounded content read, unrelated to
  // (and not a regression of) the fstat-only size accounting proven above.
  assert.strictEqual(quota.grant(home, aid, 100), true);
});

test('a swapped quota/ component (symlink) makes admit refuse rather than operate through it', () => {
  const home = tmpHome();
  const [aid, l] = newActivity(home);
  const qd = A.quotaDir(home);
  fs.rmSync(qd, { recursive: true, force: true });
  const outsideDir = path.join(home, 'evil');
  fs.mkdirSync(outsideDir);
  fs.symlinkSync(outsideDir, qd);
  assert.strictEqual(quota.admit(home, aid, l), false);
});

test('held corrupt entry refuses admit AND grant even far below the real 64 MiB ceiling', () => {
  const home = tmpHome();
  const [live, ll] = newActivity(home);
  assert.strictEqual(quota.admit(home, live, ll), true); // BEFORE any corruption exists

  const [held, hl] = newActivity(home); // owner.lock HELD -- never released
  void hl;
  fs.writeFileSync(A.ledgerEntryPath(home, held), '{not valid json', { mode: 0o600 });

  const [fresh, fl] = newActivity(home);
  assert.strictEqual(quota.admit(home, fresh, fl), false, 'refused: corrupt entry stands');
  assert.strictEqual(quota.grant(home, live, 100), false, 'grants refused too, unrelated activity');
});

test('grant durability failure (fsync throws) refuses the append, never writes a bad entry', () => {
  const home = tmpHome();
  const [aid, l] = newActivity(home);
  quota.admit(home, aid, l);
  const realFsync = fs.fsyncSync;
  fs.fsyncSync = () => { throw new Error('no fsync'); };
  try {
    assert.strictEqual(quota.grant(home, aid, 100), false);
  } finally {
    fs.fsyncSync = realFsync;
  }
  assert.strictEqual(readEntry(home, aid).granted, 0); // unchanged -- refused before commit
});
