'use strict';
// Codex R3 (fix-review round 3, BLOCKER): the LAST narrow ceiling-invariant window. Post-handoff,
// Electron retains authority to write `control{cancel_requested}` (writer.js's `allowHandedOff`
// exception) even after `dropLocalReference()`. Meanwhile the Python child (the executing owner)
// can durably write its `terminal` and `settle()` -- which reaps (removes) the ledger entry --
// BEFORE Electron observes the child's exit. A settled activity's only remaining charge term is
// its on-disk `committed` size (fstat-only, `_charge`); an append landing AFTER the ledger entry
// is gone has NO liability term to catch it, so it silently escapes `_charge`'s accounting.
// Codex's measured repro: charge 687 vs actual committed 861, undercount 174.
//
// Codex is explicit: a "does the ledger exist?" PRECHECK is insufficient -- the reap can land in
// the gap between the check and the write. The fix (quota.js's `appendReserveIfLive`) serializes
// the DECISION and the WRITE against settlement by acquiring the SAME cross-process `quota.lock`
// settlement removes the entry under, re-reading the ledger under that lock, and only appending
// if it is still live -- all inside one lock hold.
//
// These tests reproduce Codex's exact scenario deterministically, reusing the interleaving-hook
// technique from quota-charge-interleaving.test.js (hooking `paths.statOwnedSegmentsDetailed` -- the sole
// primitive `_charge` uses for sizing -- so a "concurrent" cancel-append attempt can be triggered
// at the exact moment `_charge` scans the target activity's segments):
//   1. NEGATIVE (the race itself): admit+grant+write real committed bytes, write a durable
//      terminal, then REAP the ledger entry (simulating the Python child's own settle() having
//      already removed it). While `_charge()` is scanning, attempt a handed-off cancel via
//      `quota.appendReserveIfLive`. Assert the cancel is a NO-OP (settled activity, no reservation
//      left) AND that `_charge` never undercounts the true committed bytes.
//   2. POSITIVE (still-live case): the same shape, but WITHOUT reaping the ledger -- the cancel
//      DOES append (the reservation covers it) and `_charge` still does not undercount.
//
// Verified against a NAIVE pre-fix stand-in (append unconditionally, no lock/live-check) that this
// negative case fails red (the appended bytes land mid-`_charge` with no ledger term to cover
// them, producing exactly Codex's undercount shape) before the real serialized
// `quota.appendReserveIfLive` was implemented, and passes green after.
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
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-quota-cancel-race-'));
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

// Local copy of quota-charge-interleaving.test.js's own hook (same shared `pathsMod.statOwnedSegmentsDetailed`
// object via Node's require cache -- quota.js's own `paths` reference resolves to it too). Kept as
// an independent copy rather than importing the sibling test file's internals, matching this
// codebase's established "duplicate small test helper" precedent (see trigger-glue.js's
// `_splitLines` comment for the production-code analog).
function hookStatOwnedSegmentsDetailedAppendOnce(targetDir, doInterleave) {
  const real = pathsMod.statOwnedSegmentsDetailed;
  const state = { fired: false };
  pathsMod.statOwnedSegmentsDetailed = (directory, suffix) => {
    const result = real(directory, suffix); // snapshot BEFORE the simulated concurrent action
    if (!state.fired && directory === targetDir) {
      state.fired = true;
      doInterleave();
    }
    return result;
  };
  return { state, restore: () => { pathsMod.statOwnedSegmentsDetailed = real; } };
}

function writeOrdinaryEvent(home, aid) {
  const rec = {
    schema_version: 1, activity_id: aid, type: 'event', seq: 1,
    ts: '2026-08-14T00:00:00-07:00', level: 'info', event: 'real-sync-data',
  };
  const line = Buffer.from(`${JSON.stringify(rec)}\n`);
  const seg = A.segmentPath(home, aid, 'python', 'cafebabe');
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
  const seg = A.segmentPath(home, aid, 'python', 'deadbeef');
  const fd = A.secureOpenAppend(seg);
  fs.writeSync(fd, line);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  return line.length;
}

// Mirrors what writer.js's control('cancel_requested') actually does under the hood via `_emit`
// (`{ reserve: true, fsync: true, slot: 'cancel', allowHandedOff: true }`): a segment-only append,
// never touching the ledger. This is the exact shape `appendFn` takes at the real call site
// (trigger-glue.js's `onCancel`).
function writeCancelRequestedRecord(home, aid) {
  const rec = {
    schema_version: 1, activity_id: aid, type: 'control', seq: 42,
    ts: '2026-08-14T00:00:01-07:00', name: 'cancel_requested', fields: {},
  };
  const line = Buffer.from(`${JSON.stringify(rec)}\n`);
  const seg = A.segmentPath(home, aid, 'electron', 'ca1ce1ed');
  const fd = A.secureOpenAppend(seg);
  fs.writeSync(fd, line);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  return line.length;
}

function hasCancelRequestedRecord(home, aid) {
  for (const seg of A.readOwnedSegments(A.activityDir(home, aid))) {
    const text = seg.data.toString('utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      let rec;
      try { rec = JSON.parse(line); } catch (e) { continue; }
      if (rec && rec.type === 'control' && rec.name === 'cancel_requested') return true;
    }
  }
  return false;
}

test('Codex R3: a settled (reaped) activity\'s handed-off cancel is a NO-OP, and _charge does not undercount the interleaved attempt', () => {
  const home = tmpHome();
  const [aid, l] = newActivity(home);
  assert.strictEqual(quota.admit(home, aid, l), true);
  assert.strictEqual(quota.grant(home, aid, 2000), true);
  writeOrdinaryEvent(home, aid); // real committed bytes, mirrors genuine sync data
  writeTerminalEvent(home, aid); // the Python child's own durable terminal

  // Simulate settle()'s reap having already completed (the Python child's terminal->settle ran to
  // completion before Electron observed the exit): the ledger entry is gone. Node itself never
  // unlinks (Ruling B) -- this stands in for the delegated Python-side reap actually landing.
  fs.unlinkSync(A.ledgerEntryPath(home, aid));
  assert.strictEqual(fs.existsSync(A.ledgerEntryPath(home, aid)), false, 'ledger must be reaped (settled) before the race');

  const targetDir = A.activityDir(home, aid);
  let cancelAttempted = false;
  let cancelApplied = null;
  const { state, restore } = hookStatOwnedSegmentsDetailedAppendOnce(targetDir, () => {
    // The exact handed-off cancel path (trigger-glue.js's onCancel), firing WHILE _charge's single
    // fstat scan of this activity is in flight -- the precise race window Codex identified.
    cancelAttempted = true;
    cancelApplied = quota.appendReserveIfLive(home, aid, () => writeCancelRequestedRecord(home, aid));
  });
  let charge;
  try {
    charge = quota._charge(home);
  } finally {
    restore();
  }

  assert.ok(state.fired, 'the interleaving hook must actually have fired');
  assert.ok(cancelAttempted, 'the handed-off cancel must actually have been attempted mid-_charge');
  assert.strictEqual(cancelApplied, false, 'appendReserveIfLive must refuse to append on a settled (reaped) ledger entry');
  assert.strictEqual(
    hasCancelRequestedRecord(home, aid), false,
    'no cancel_requested record may land on an already-settled activity -- it must never escape accounting',
  );

  const trueCommitted = quota._committed(home); // fresh rescan, real function restored
  assert.ok(
    charge >= trueCommitted,
    `_charge undercounted: charged ${charge} < true committed ${trueCommitted} (Codex's exact shape: an append escaping accounting on a settled activity)`,
  );
});

test('Codex R3: a cancel on a still-LIVE (unsettled, ledger-present) activity DOES append, and _charge does not undercount', () => {
  const home = tmpHome();
  const [aid, l] = newActivity(home);
  assert.strictEqual(quota.admit(home, aid, l), true);
  assert.strictEqual(quota.grant(home, aid, 2000), true);
  writeOrdinaryEvent(home, aid);
  // No terminal, no reap -- the ledger entry is still live (this is the ordinary
  // cancel-before-SIGTERM path, unaffected by the R3 fix).
  assert.ok(fs.existsSync(A.ledgerEntryPath(home, aid)), 'ledger must still be live for this case');

  const targetDir = A.activityDir(home, aid);
  let cancelApplied = null;
  const { state, restore } = hookStatOwnedSegmentsDetailedAppendOnce(targetDir, () => {
    cancelApplied = quota.appendReserveIfLive(home, aid, () => writeCancelRequestedRecord(home, aid));
  });
  let charge;
  try {
    charge = quota._charge(home);
  } finally {
    restore();
  }

  assert.ok(state.fired, 'the interleaving hook must actually have fired');
  assert.strictEqual(cancelApplied, true, 'a live ledger entry must allow the cancel append through');
  assert.ok(hasCancelRequestedRecord(home, aid), 'the cancel_requested record must actually be on disk for a still-live activity');

  const trueCommitted = quota._committed(home);
  assert.ok(charge >= trueCommitted, `_charge undercounted a still-live cancel append: charged ${charge} < true committed ${trueCommitted}`);
  assert.ok(charge >= quota.RESERVE + 2000, `_charge undercounted vs the entry's own reservation ceiling: charged ${charge} < ${quota.RESERVE + 2000}`);
});

test('Codex R3: appendReserveIfLive never throws (best-effort) even when quota.lock cannot be acquired', () => {
  // A `home` that is itself a plain FILE (not a directory) makes secureMkdir's own
  // fs.mkdirSync(..., {recursive:true}) fail with ENOTDIR -- a genuine durability/safety failure,
  // distinct from the ordinary "no ledger entry" no-op paths exercised above. appendReserveIfLive
  // must swallow it and report false, never let it escape.
  const brokenHome = path.join(os.tmpdir(), `rr-quota-cancel-race-broken-home-${process.pid}-${Date.now()}`);
  fs.writeFileSync(brokenHome, 'not a directory');
  _tmpHomes.push(brokenHome); // cleanup: fs.rmSync(..., {recursive:true,force:true}) also removes plain files
  const aid = A.mintActivityId();
  let applied;
  assert.doesNotThrow(() => {
    applied = quota.appendReserveIfLive(brokenHome, aid, () => {
      throw new Error('must never be reached');
    });
  });
  assert.strictEqual(applied, false);
});
