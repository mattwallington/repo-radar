'use strict';
// Task 5.3 -- FINAL ACCEPTANCE: the motivating failure is now VISIBLE.
//
// The spec's Goal: "Every sync attempt and every pre-attempt system incident becomes a durable,
// inspectable record with an authoritative outcome -- so a blocked/failed/crashed run is always
// visible in the app, not buried in a terminal."
//
// The failure that Goal exists to close, exactly as it used to happen: a manual "Sync Now" on a
// dev build is refused by a guard BEFORE Python is ever spawned (an interpreter fingerprint the
// pinned lock set does not cover -- `runtime/deps.js` throws `unsupported env: <fingerprint>`,
// `ensureRuntime` fails, `surfaceRuntimeError` sets `runtimeDisabled` + `runtimeDisabledReason`,
// and `main.js`'s `runtimeDisabled || !runtimeChannel` guard refuses the run). Because Python
// never ran, `_open_sync_logger` never created a `sync-<ISO>.log`, and because no repo was ever
// touched, the old "Sync Errors" window -- which rendered `status.json`'s per-repo error list --
// had nothing to draw. The attempt therefore existed NOWHERE: no log file, no error window
// content, no history. The user clicked Sync Now and the app appeared to do nothing at all.
//
// This file drives that scenario through the REAL producer code path Electron runs
// (`activity/trigger-glue.js`: `beginManualActivity` -> `onGuardBlock`, called from `main.js`'s
// guard at :1233) against a temp HOME, and then asks the READER the four questions the brief
// requires, plus the two that make the closure total:
//   (a) `listActivities` lists a `blocked` item for the refused attempt;
//   (b) `viewErrorsTarget` (the tray's "⚠️ View Errors" affordance) points AT it;
//   (c) the item's Problems lens carries the guard's reason;
//   (d) `systemDiagnostics` still surfaces the shared `sync.error.log` stream alongside it;
//   (e) NO `sync-*.log` exists for the attempt -- the old surface is still empty, and the
//       incident is visible anyway (that contrast IS the acceptance);
//   (f) the id `viewErrorsTarget` returns survives the renderer's own deep-link gate
//       (`focusIdFromHash`, the UUIDv4 fragment check), so the tray -> window link resolves.
//
// The second test is the counterfactual: the same reader over a store where the attempt was
// never recorded answers "nothing, anywhere" -- so the assertions above cannot pass vacuously.
//
// -------------------------------------------------------------------------------------------
// MANUAL ACCEPTANCE SCRIPT (Step 2)
//
// Performed for real on 2026-08-31 (recorded in
// `.superpowers/sdd/2026-08-14-activity-history/progress.md`, "MANUAL ACCEPTANCE PASSED @
// 2957275"); that run found and closed three real bugs. Re-run it on any dev build after a
// change to the guard paths, the reader, or the Activity window:
//
//   1. Run the dev build unpacked (`cd menubar && npm start`) so no `build-info.json` resolves:
//      the runtime stays disabled and the `runtimeDisabled || !runtimeChannel` guard will fire on
//      the next sync -- the live stand-in for the fingerprint-mismatch refusal.
//   2. Confirm the tray shows the dev (orange) icon, and note whether "⚠️ View Errors" is
//      currently in the menu.
//   3. Click "Sync Now".
//   4. Confirm NO progress window appears and no repo grid hangs at "Starting sync…" -- the
//      Activity window opens instead, deep-linked (Ruling P4-21).
//   5. Confirm the newest row is a `blocked` chip, timestamped now, showing the dev channel and
//      the manual trigger, and that it is the row already selected.
//   6. Open the Problems lens on it; confirm a terminal row reading `blocked` whose reason text
//      is the guard's message.
//   7. Close the Activity window, open the tray menu, click "⚠️ View Errors"; confirm it reopens
//      on that SAME item rather than on an empty page.
//   8. Click Refresh in the Activity window; confirm the blocked item is still there -- it is on
//      disk, not in memory.
//   9. Scroll to the System section; confirm `sync.error.log` is listed with its tail, marked
//      uncorrelated.
//  10. In a terminal run `ls ~/Library/Logs/repo-radar/sync-*.log`; confirm no new file exists for
//      this attempt. The old surface is still empty -- and the incident is visible anyway.
//
// Every tmp dir is prefixed `rr-` and removed in a `finally`, per the repo's tmp-dir policy.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const read = require('../read');
const glue = require('../trigger-glue');
// The renderer module, required directly (it is wrapped in an IIFE that still exports under Node)
// so the deep-link gate the Activity window actually applies is the one asserted here -- no
// Electron, no second copy of the regex.
const R = require(path.join(__dirname, '..', '..', 'renderer', 'activity.js'));

// The guard's reason, in the shape `main.js:1222` passes to `onGuardBlock`: for an interpreter
// the pinned lock set does not cover, `runtime/deps.js:12` throws `unsupported env: <fingerprint>`
// and that text becomes `runtimeDisabledReason`.
const BLOCK_REASON = 'unsupported env: cpython-3.13.0-arm64';

// One line in the exact shape `runtime/dispatchers.js`'s `_act_last_resort` appends -- the shared
// stream is process-wide and uncorrelated, which is precisely why it must still be reported
// NEXT TO the activity rather than instead of it.
const SYNC_ERROR_LINE =
  '2026-08-31T16:14:02Z repo-radar: activity recording unavailable (channel=dev trigger=manual stage=bootstrap)\n';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-accept-'));
}

function logDir(home) {
  return path.join(home, 'Library', 'Logs', 'repo-radar');
}

// The pre-contract per-run log files, `sync-<YYYY-MM-DD>T<HH-MM-SS>.log` (never `sync.error.log`,
// which is a shared stream and does not match this shape).
function syncLogFiles(home) {
  let names;
  try {
    names = fs.readdirSync(logDir(home));
  } catch (e) {
    return [];
  }
  return names.filter((n) => /^sync-.*\.log$/.test(n));
}

// The shared stream that DOES exist regardless of whether an attempt ever ran.
function seedSyncErrorLog(home) {
  fs.mkdirSync(logDir(home), { recursive: true });
  fs.writeFileSync(path.join(logDir(home), 'sync.error.log'), SYNC_ERROR_LINE);
}

function streamNamed(diag, name) {
  return (diag.streams || []).find((s) => s.name === name) || null;
}

// -------------------------------------------------------------------------------------------

test('ACCEPTANCE: a dev sync blocked BEFORE Python ran is a durable, visible `blocked` Activity item', () => {
  const home = tmpHome();
  try {
    // --- the world at the moment of the click -------------------------------------------------
    // A shared error stream exists (it always does); no per-run `sync-*.log` does, and none ever
    // will for this attempt -- Python is never spawned.
    seedSyncErrorLog(home);
    assert.deepStrictEqual(syncLogFiles(home), [], 'precondition: no per-run sync log exists yet');

    // --- the attempt, through the REAL Electron code path -------------------------------------
    // main.js:1165 -- identity + lease + durable `start`, established BEFORE any gate.
    const { writer } = glue.beginManualActivity(home, { channel: 'dev', trigger: 'manual' });
    assert.strictEqual(writer._active, true, 'the attempt must have a real, durable identity');
    const attemptId = writer.activityId;

    // main.js:1233 -- the guard refuses the run and finalizes it. Python is never spawned.
    glue.onGuardBlock(writer, BLOCK_REASON);

    // --- (e) the OLD surfaces are exactly as empty as they always were ------------------------
    assert.deepStrictEqual(
      syncLogFiles(home), [],
      'no `sync-*.log` is written for a run blocked before Python -- the old surface stays empty',
    );

    // --- (a) the reader lists it, as `blocked` ------------------------------------------------
    const list = read.listActivities(home, {}, {});
    assert.strictEqual(list.available, true, 'the store must be readable');
    assert.ok(list.items.every((i) => i.legacy !== true),
      'there is no legacy `sync-*.log` item either -- the store is the ONLY place this attempt exists');
    const listed = list.items.find((i) => i.id === attemptId);
    assert.ok(listed, `the refused attempt must be listed; got ${JSON.stringify(list.items)}`);
    assert.strictEqual(listed.outcome, 'blocked', 'its authoritative outcome is `blocked`');
    assert.strictEqual(listed.hasProblems, true, 'it is problem-bearing, so the window flags it');
    assert.strictEqual(listed.channel, 'dev');
    assert.strictEqual(listed.trigger, 'manual');
    assert.strictEqual(listed.kind, 'sync');

    // --- (b) the tray's "⚠️ View Errors" points AT it ------------------------------------------
    const target = read.viewErrorsTarget(home, {});
    assert.strictEqual(
      target, attemptId,
      'the View Errors affordance must resolve to the blocked attempt -- never to an empty view',
    );

    // --- (c) its Problems lens carries the guard's reason --------------------------------------
    const detail = read.getActivity(home, target, {});
    assert.ok(detail.item, 'the deep-linked item must be fetchable by that id');
    assert.strictEqual(detail.item.outcome, 'blocked');
    const blockedRow = detail.item.problems.find((p) => p.kind === 'terminal' && p.outcome === 'blocked');
    assert.ok(blockedRow, `the Problems lens must carry the blocked terminal; got ${JSON.stringify(detail.item.problems)}`);
    assert.strictEqual(
      blockedRow.summary.reason, BLOCK_REASON,
      'the guard\'s reason is what the user reads -- the whole point of recording the refusal',
    );

    // --- (d) the shared System diagnostics are still reported alongside it ---------------------
    const diag = read.systemDiagnostics(home, {});
    assert.strictEqual(diag.uncorrelated, true, 'the System section says, in data, that it belongs to no attempt');
    const errStream = streamNamed(diag, 'sync.error.log');
    assert.ok(errStream, 'sync.error.log must be reported');
    assert.strictEqual(errStream.present, true, 'and present, since it exists on disk');
    assert.ok(errStream.redactedTail.includes('activity recording unavailable'),
      'with its tail -- the shared stream is not replaced by the Activity item, it sits next to it');

    // --- (f) the renderer's own deep-link gate accepts that id --------------------------------
    // main.js:1240 opens the Activity window with `loadFile(page, { hash: String(id) })`; the
    // renderer reads `window.location.hash` through `focusIdFromHash`, which admits a UUIDv4
    // fragment and nothing else. Proving the round trip here proves the tray -> window link
    // resolves, without Electron.
    assert.strictEqual(
      R.focusIdFromHash(`#${target}`), target,
      'the View Errors id must survive the renderer\'s UUIDv4 fragment gate -- otherwise the deep link silently drops',
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// The pre-feature world, asserted so the test above can never pass vacuously: over a HOME where
// the very same shared stream exists but the refused attempt was never RECORDED, the reader has
// nothing to list and the tray has nothing to offer. That is the exact "nothing anywhere" state
// the feature exists to end -- and it is what the assertions above discriminate against.
test('counterfactual: with the attempt unrecorded, the reader lists nothing and View Errors has no target', () => {
  const home = tmpHome();
  try {
    seedSyncErrorLog(home); // identical world, minus the durable record
    assert.deepStrictEqual(syncLogFiles(home), [], 'still no per-run sync log');

    const list = read.listActivities(home, {}, {});
    assert.deepStrictEqual(list.items, [], 'nothing to show: this is the failure the feature closes');
    assert.strictEqual(read.viewErrorsTarget(home, {}), null, 'and no incident for the tray to open');

    // ... while the shared stream is reported exactly as it was above, which is why it was never
    // sufficient on its own: it says nothing about THIS attempt.
    const errStream = streamNamed(read.systemDiagnostics(home, {}), 'sync.error.log');
    assert.ok(errStream && errStream.present === true, 'the shared stream alone is unchanged by the outcome');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
