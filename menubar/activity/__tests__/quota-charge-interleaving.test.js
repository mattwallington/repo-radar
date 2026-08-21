'use strict';
// Codex fix-review round 2 (BLOCKER): `_charge` must not undercount a concurrent segment append,
// or the 64 MiB hard ceiling can be breached. Writers get their grant under quota.lock, RELEASE
// the lock, THEN append -- so a real append can land concurrently with a later `_charge()` call.
//
// Pre-fix `_charge` scanned `_committed(home)` (every activity's bytes, via `statOwnedSegments`)
// and then, separately, `_onDisk(home, aid)` for each live ledger entry (a SECOND
// `statOwnedSegments` call for just that one activity) -- two scans of the SAME activity at two
// DIFFERENT times. An append landing between them was excluded from `committed` (scanned before)
// AND netted out of `outstanding` via the now-larger `_onDisk` read (scanned after) -- a
// double-miss undercount (Codex's measured Node terminal repro: charged 498 vs committed 687).
//
// These tests reproduce that interleaving deterministically by hooking `paths.statOwnedSegments`
// (the ONLY primitive `_charge` uses for sizing) so that the FIRST scan of the target activity's
// directory performs a REAL append immediately afterward -- simulating a concurrent writer that
// released quota.lock and appended -- before returning its (pre-append) result. Against the
// pre-fix two-scan `_charge` this reproduces the exact undercount (and, for the terminal case,
// the additional `_hasTerminal` visibility-exclusion undercount Fix-B/B3(c) had added); against
// the fixed single-scan `_charge` there is only one call per activity, so the append is either
// fully counted or fully deferred to the next `_charge()` call, never split.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../index');
const { quota } = A;
const pathsMod = require('../paths');

const _tmpHomes = [];
function tmpHome() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-quota-interleave-'));
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

// Hooks `paths.statOwnedSegments` (the shared module object -- quota.js's own `paths` reference
// resolves to the SAME object via Node's require cache) so that the FIRST call whose `directory`
// argument matches `targetDir` performs `doAppend()` right after computing that call's (pre-
// append) result, then returns that already-computed result. Returns a restore function and a
// state object with `fired`.
function hookStatOwnedSegmentsAppendOnce(targetDir, doAppend) {
  const real = pathsMod.statOwnedSegments;
  const state = { fired: false };
  pathsMod.statOwnedSegments = (directory, suffix) => {
    const result = real(directory, suffix); // snapshot BEFORE the simulated concurrent append
    if (!state.fired && directory === targetDir) {
      state.fired = true;
      doAppend();
    }
    return result;
  };
  return { state, restore: () => { pathsMod.statOwnedSegments = real; } };
}

function writeOrdinaryEvent(home, aid) {
  const rec = {
    schema_version: 1, activity_id: aid, type: 'event', seq: 1,
    ts: '2026-08-14T00:00:00-07:00', level: 'info', event: 'concurrent-append',
  };
  const line = Buffer.from(`${JSON.stringify(rec)}\n`);
  const seg = A.segmentPath(home, aid, 'electron', 'cafebabe');
  const fd = A.secureOpenAppend(seg);
  fs.writeSync(fd, line);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  return line.length;
}

function writeTerminalEvent(home, aid) {
  const rec = {
    schema_version: 1, activity_id: aid, type: 'terminal', seq: 9,
    ts: '2026-08-14T00:00:00-07:00', outcome: 'succeeded', summary: {}, by: A.mintToken(),
  };
  const line = Buffer.from(`${JSON.stringify(rec)}\n`);
  const seg = A.segmentPath(home, aid, 'electron', 'deadbeef');
  const fd = A.secureOpenAppend(seg);
  fs.writeSync(fd, line);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  return line.length;
}

test('Codex R2: _charge does not undercount an ORDINARY event append landing mid-scan (single-scan-per-activity fix)', () => {
  const home = tmpHome();
  const [aid, l] = newActivity(home);
  assert.strictEqual(quota.admit(home, aid, l), true);
  assert.strictEqual(quota.grant(home, aid, 2000), true); // headroom for the "concurrent" append

  const targetDir = A.activityDir(home, aid);
  let appendedBytes = 0;
  const { state, restore } = hookStatOwnedSegmentsAppendOnce(targetDir, () => {
    appendedBytes = writeOrdinaryEvent(home, aid);
  });
  let charge;
  try {
    charge = quota._charge(home);
  } finally {
    restore();
  }

  assert.ok(state.fired, 'the interleaving hook must actually have fired');
  assert.ok(appendedBytes > 0);
  const trueCommitted = quota._committed(home); // fresh rescan, real function restored
  assert.ok(charge >= trueCommitted, `_charge undercounted a mid-scan append: charged ${charge} < true committed ${trueCommitted}`);
  assert.ok(charge >= quota.RESERVE + 2000, `_charge undercounted vs the entry's own reservation ceiling: charged ${charge} < ${quota.RESERVE + 2000}`);
});

test('Codex R2: _charge does not undercount a TERMINAL append landing mid-scan (removes the old _hasTerminal visibility-shortcut undercount too)', () => {
  const home = tmpHome();
  const [aid, l] = newActivity(home);
  assert.strictEqual(quota.admit(home, aid, l), true);
  assert.strictEqual(quota.grant(home, aid, 2000), true);

  const targetDir = A.activityDir(home, aid);
  let appendedBytes = 0;
  const { state, restore } = hookStatOwnedSegmentsAppendOnce(targetDir, () => {
    appendedBytes = writeTerminalEvent(home, aid);
  });
  let charge;
  try {
    charge = quota._charge(home);
  } finally {
    restore();
  }

  assert.ok(state.fired, 'the interleaving hook must actually have fired');
  assert.ok(appendedBytes > 0);
  assert.strictEqual(quota._hasTerminal(home, aid), true, 'the terminal really landed on disk');
  assert.ok(fs.existsSync(A.ledgerEntryPath(home, aid)), 'no reap happened here -- this test targets _charge, not settle()');
  const trueCommitted = quota._committed(home);
  assert.ok(charge >= trueCommitted, `_charge undercounted a mid-scan terminal append: charged ${charge} < true committed ${trueCommitted}`);
  assert.ok(charge >= quota.RESERVE + 2000, `_charge undercounted vs the entry's own reservation ceiling: charged ${charge} < ${quota.RESERVE + 2000}`);
});
