// Receipt reconciliation. Exercises the PRODUCTION module (../run-receipt), not a mirror — a
// copied implementation in the test file stays green even if the real function returns early or
// its semantics drift, which is exactly how a synthesis fix once shipped as dead code.
// Landmarks below additionally assert main.js is wired to call it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { planReconcile, validateReceipt, qualifiesForSchedule, completionQualifies,
        needsCatchUp, SCHEMA, EXIT_SKIPPED_NO_WORK,
        indexDroppedOf, runSucceeded, statsFromReceipt,
        warningOf, statusNeedsAttention } = require('../run-receipt');
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const receipt = (over = {}) => ({
  schema: SCHEMA, channel: 'stable', trigger: 'scheduled', mode: 'full',
  completed: true, qualifiesForSchedule: true, finishedAt: iso(60_000),
  stats: { total: 30, errors: 3, metadataGenerated: 2 }, ...over,
});

// ── the bug this exists for: a scheduled run finished while the app was closed ───────────
{
  const stale = iso(6 * 3600_000);
  const r = receipt();
  const plan = planReconcile(r, { lastSync: stale });
  assert.ok(plan.adopt && plan.advanceLastSync, 'a qualifying newer run must advance lastSync');
  assert.strictEqual(plan.status.lastSync, r.finishedAt);
  const st = plan.status.channels.stable;
  assert.strictEqual(st.trigger, 'scheduled');
  assert.strictEqual(st.errors, 3, 'error count recorded');
  assert.strictEqual(st.receiptAt, r.finishedAt, 'per-channel watermark set');
  assert.strictEqual(st.qualifies, true, 'derived qualification recorded');
}

// per-repo errors do not stop adoption: the run COMPLETED
assert.ok(planReconcile(receipt({ stats: { errors: 3 } }), { lastSync: iso(6 * 3600_000) }).adopt,
  'a completed run with known per-repo errors still counts as completed');

// ── observability must land even when lastSync is already newer ──────────────────────────
// Python writes the receipt just before exiting; Electron then stamps a NEWER lastSync for an
// app-launched run. Comparing against lastSync alone would discard the receipt and never record
// how ordinary runs were triggered.
{
  const newerLastSync = iso(60_000);                       // captured, so the compare is real
  // A full manual run now qualifies (freshness), so use an older receipt to exercise the
  // "newer lastSync already recorded" path rather than the non-qualifying path.
  const r = receipt({ trigger: 'manual', finishedAt: iso(120_000) });
  const plan = planReconcile(r, { lastSync: newerLastSync });
  assert.ok(plan.adopt, 'must still absorb the receipt for observability');
  assert.strictEqual(plan.advanceLastSync, false, 'but must not rewind lastSync');
  assert.strictEqual(plan.status.lastSync, newerLastSync, 'lastSync must be byte-identical');
  assert.strictEqual(plan.status.channels.stable.trigger, 'manual', 'provenance recorded anyway');
  assert.strictEqual(plan.status.channels.stable.receiptAt, r.finishedAt, 'watermark advanced');
  assert.strictEqual(plan.reason, 'observability-only');
}

// ── a partial run completes but must NOT suppress the full schedule ──────────────────────
{
  const r = receipt({ mode: 'skip-metadata', qualifiesForSchedule: false, trigger: 'manual' });
  const plan = planReconcile(r, { lastSync: iso(6 * 3600_000) });
  assert.ok(plan.adopt, 'still absorbed');
  assert.strictEqual(plan.advanceLastSync, false,
    'a --skip-metadata run did not do the scheduled work, so it must not satisfy the schedule');
  assert.strictEqual(plan.status.channels.stable.mode, 'skip-metadata');
}

// ── channel isolation: a dev run must never advance stable ───────────────────────────────
assert.strictEqual(planReconcile(receipt({ channel: 'dev' }), {}, { channel: 'stable' }).adopt,
  false, 'a dev receipt must be ignored by the stable channel');
assert.ok(planReconcile(receipt({ channel: 'dev' }), {}, { channel: 'dev' }).adopt,
  'a dev receipt is valid for the dev channel');

// ── idempotence: the same receipt must not be absorbed twice ─────────────────────────────
{
  const r = receipt();
  const first = planReconcile(r, { lastSync: iso(6 * 3600_000) });
  const second = planReconcile(r, first.status);
  assert.strictEqual(second.adopt, false, 'already-absorbed receipts are no-ops');
  assert.strictEqual(second.reason, 'already-absorbed');
}

// ── type validation, not mere presence ──────────────────────────────────────────────────
const rejects = {
  'foreign schema': { schema: 99 },
  'not completed': { completed: false },
  'unknown trigger': { trigger: 'sideways' },
  'unknown channel': { channel: 'beta' },
  'numeric timestamp': { finishedAt: 1234567890 },
  'unparseable timestamp': { finishedAt: 'not-a-date' },
  'future timestamp': { finishedAt: new Date(Date.now() + 9e8).toISOString() },
  'string error count': { stats: { errors: '3' } },
  'missing stats': { stats: undefined },
  'non-boolean qualification': { qualifiesForSchedule: 'yes' },
};
for (const [label, over] of Object.entries(rejects)) {
  assert.strictEqual(validateReceipt(receipt(over)), null, `must reject: ${label}`);
}
assert.strictEqual(validateReceipt(null), null, 'null is rejected, not thrown on');
assert.strictEqual(validateReceipt('a string'), null, 'a non-object is rejected');

// ── schedule equivalence, as PRODUCTION derives it ──────────────────────────────────────
// Derived from the run's properties, never read off receipt.qualifiesForSchedule — a receipt can
// carry mode:'metadata-only' with qualifies:true, and trusting the flag let a partial run
// suppress the schedule.
assert.ok(qualifiesForSchedule(receipt({ trigger: 'scheduled' })), 'stable full scheduled');
assert.ok(qualifiesForSchedule(receipt({ trigger: 'catchup' })), 'stable full catch-up');
// Freshness argument: checkMissedSync is freshness-based and Electron already stamps lastSync for
// a completed manual run, so re-running identical full work minutes later because the trigger was
// manual just spends money.
assert.ok(qualifiesForSchedule(receipt({ trigger: 'manual' })), 'a FULL manual run is fresh work');
assert.ok(qualifiesForSchedule(receipt({ trigger: 'cli' })), 'a FULL cli run is fresh work');
assert.strictEqual(qualifiesForSchedule(receipt({ mode: 'skip-metadata' })), false,
  'a partial run did not do the scheduled work');
assert.strictEqual(qualifiesForSchedule(receipt({ mode: 'metadata-only' })), false, 'partial');
assert.strictEqual(qualifiesForSchedule(receipt({ channel: 'dev' })), false, 'dev owns no schedule');
assert.strictEqual(qualifiesForSchedule(null), false, 'null is false, not a throw');

// contradictory fields: the flag says yes, the mode says partial -> derived answer wins
{
  const plan = planReconcile(receipt({ mode: 'metadata-only', qualifiesForSchedule: true }),
    { lastSync: iso(6 * 3600_000) });
  assert.strictEqual(plan.advanceLastSync, false,
    'a contradictory receipt must not advance lastSync on the strength of its own flag');
}

// ── channel isolation must survive a SHARED status object ───────────────────────────────
// The filenames are channel-scoped but status.json is not, so the earlier version let a dev app
// advance the shared lastSync and then block a stable receipt as already-absorbed.
{
  const shared = { lastSync: iso(6 * 3600_000) };
  const dev = planReconcile(receipt({ channel: 'dev' }), shared, { channel: 'dev' });
  assert.ok(dev.adopt, 'a dev app absorbs its own receipt');
  assert.strictEqual(dev.advanceLastSync, false, 'but must NOT advance the stable watermark');
  assert.strictEqual(dev.status.lastSync, shared.lastSync, 'stable lastSync byte-identical');

  const stable = planReconcile(receipt({ finishedAt: iso(120_000) }), dev.status,
    { channel: 'stable' });
  assert.ok(stable.adopt, 'a dev receipt must not consume the stable absorption watermark');
  assert.strictEqual(stable.reason, 'adopted', 'stable still advances after a dev run');
  assert.notStrictEqual(stable.status.lastSync, shared.lastSync, 'stable lastSync moved');
}

// ── needsCatchUp: one predicate for the initial and delayed decisions ───────────────────
{
  const at = (h, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };
  const daily = { schedule: { enabled: true, type: 'daily', time: '09:00' } };
  assert.ok(needsCatchUp(daily, { lastSync: at(8).toISOString() }, at(10)), 'daily missed');
  assert.strictEqual(needsCatchUp(daily, { lastSync: at(9, 30).toISOString() }, at(10)), false,
    'daily already satisfied today');

  // weekly previously fell through to the hourly interval branch, so a 09:00 weekly schedule with
  // lastSync at 08:00 was flagged missed and then cancelled an hour later.
  const weekly = { schedule: { enabled: true, type: 'weekly', time: '09:00',
    days: [new Date().getDay()] } };
  assert.ok(needsCatchUp(weekly, { lastSync: at(8).toISOString() }, at(10)), 'weekly missed');
  assert.strictEqual(needsCatchUp(weekly, { lastSync: at(9, 30).toISOString() }, at(10)), false,
    'weekly satisfied — must NOT fall through to an hourly interval');
  const otherDay = { schedule: { enabled: true, type: 'weekly', time: '09:00',
    days: [(new Date().getDay() + 3) % 7] } };
  assert.strictEqual(needsCatchUp(otherDay, { lastSync: at(8).toISOString() }, at(10)), false,
    'not a scheduled weekday');

  const hourly = { schedule: { enabled: true, type: 'hourly', interval: 6 } };
  assert.ok(needsCatchUp(hourly, { lastSync: iso(7 * 3600_000) }), 'hourly overdue');
  assert.strictEqual(needsCatchUp(hourly, { lastSync: iso(3600_000) }), false, 'hourly fresh');

  // things that must never launch a paid sync
  assert.ok(needsCatchUp(daily, {}), 'scheduling on and never synced -> yes');
  assert.strictEqual(needsCatchUp({ schedule: { enabled: false } }, {}), false, 'disabled');
  assert.strictEqual(needsCatchUp(null, {}), false, 'config vanished during the delay');
  assert.strictEqual(needsCatchUp({}, {}), false, 'no schedule block');
  assert.strictEqual(needsCatchUp(daily, { syncing: true }), false, 'already syncing');
  assert.strictEqual(needsCatchUp(daily, { lastSync: 'not-a-date' }), false, 'unusable lastSync');
}

// ── main.js wiring landmarks ────────────────────────────────────────────────────────────
assert.ok(/require\('\.\/run-receipt'\)/.test(MAIN), 'main.js must use the shared module');
assert.ok(/function reconcileRunReceipt\(/.test(MAIN) && /reconcileRunReceipt\(\)/.test(MAIN),
  'reconcileRunReceipt must exist AND be called');
assert.ok(/function hardenExistingConfig\(/.test(MAIN) && /hardenExistingConfig\(\)/.test(MAIN),
  'startup config hardening must exist AND be called');
assert.ok(/function scheduleCatchUpSync\(/.test(MAIN),
  'delayed catch-up must go through the revalidating helper');
assert.ok(/needsCatchUp\(config, loadStatus\(\)/.test(MAIN),
  'main.js must use the SHARED predicate, not a second diverging copy');
assert.ok(/REPO_RADAR_CATCHUP_NOT_BEFORE/.test(MAIN),
  'catch-up must carry the watermark its decision was based on, for the lock-held re-check');
{
  const region = MAIN.slice(MAIN.indexOf('app.whenReady().then'));
  const harden = region.indexOf('hardenExistingConfig()');
  const tray = region.indexOf('updateTrayMenu()');
  const runtime = region.indexOf('ensureRuntime');
  assert.ok(harden >= 0 && harden < tray && harden < runtime,
    'config must be tightened BEFORE the tray render and before async runtime provisioning');
}
assert.ok(!/setTimeout\(\(\) => triggerSync\(/.test(MAIN),
  'no delayed catch-up may bypass revalidation with a bare setTimeout');
assert.ok(/shellEnv\.REPO_RADAR_TRIGGER =/.test(MAIN),
  'the in-app path must DECLARE its trigger, not rely on the variable being absent');
assert.ok(/addEnvVar\('REPO_RADAR_TRIGGER', 'scheduled'\)/.test(MAIN),
  'the LaunchAgent must declare scheduled');
assert.ok(/writeFileSync\(configFile,[\s\S]*?\{ mode: 0o600 \}\)/.test(MAIN)
  && /chmodSync\(configFile, 0o600\)/.test(MAIN), 'config must be created AND chmod-ed 0600');
{
  const fn = MAIN.slice(MAIN.indexOf('function checkMissedSync()'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(body.indexOf('reconcileRunReceipt()') < body.indexOf('const status = loadStatus()'),
    'reconcile must precede the lastSync read, or a completed run still looks missed');
}

// ── the schedule watermark has more writers than planReconcile ──────────────────────────
// planReconcile correctly refused dev receipts, but two unconditional writers bypassed it: the
// status-server 'complete' handler and the child zero-exit handler. A successful dev run therefore
// still suppressed stable's catch-up. Both are now channel-gated.
{
  // The real invariant: EVERY write to the schedule watermark is guarded by the shared rule —
  // either completionQualifies (live status-server path, which must judge channel AND mode) or the
  // channel comparison (child-close path). Counting a specific guard shape would go stale; this
  // asserts the property instead.
  const lines = MAIN.split('\n');
  const unguarded = lines.filter((line, i) => {
    if (!/status\.lastSync = new Date\(\)\.toISOString\(\);/.test(line)) return false;
    const preceding = lines.slice(Math.max(0, i - 8), i).join('\n');
    return !/completionQualifies\(|runtimeChannel === SCHEDULING_CHANNEL/.test(preceding);
  });
  assert.strictEqual(unguarded.length, 0,
    `${unguarded.length} write(s) to status.lastSync bypass the qualification rule`);
  const guarded = lines.filter((line) =>
    /status\.lastSync = new Date\(\)\.toISOString\(\);/.test(line));
  assert.strictEqual(guarded.length, 2,
    `expected exactly 2 schedule-watermark writers, found ${guarded.length} — a new one must be guarded too`);
}
// dev must neither run the missed-sync check nor install its periodic timer
assert.strictEqual((MAIN.match(/checkMissedSync\(\);/g) || []).length,
  (MAIN.match(/if \(runtimeChannel === SCHEDULING_CHANNEL\) checkMissedSync\(\);/g) || []).length,
  'every checkMissedSync() call must be channel-gated — dev owns no schedule');
// a declined catch-up must not be treated as a completion
assert.ok(/code === EXIT_SKIPPED_NO_WORK/.test(MAIN),
  'the child-close handler must distinguish a declined catch-up from a completed sync');
assert.strictEqual(EXIT_SKIPPED_NO_WORK, 66, 'must match receipts.EXIT_SKIPPED_NO_WORK');
// version is retained, so it is observability with a consumer rather than a write-only field
{
  const plan = planReconcile(receipt({ version: '1.0.28' }), { lastSync: iso(6 * 3600_000) });
  assert.strictEqual(plan.status.channels.stable.version, '1.0.28', 'version recorded');
}

// ── the live completion path must obey the same rule ────────────────────────────────────
// The channel gate alone let a stable PARTIAL run advance lastSync via
// `--skip-metadata --status-server`, because the payload carried no mode and the handler assumed
// "advance". planReconcile is forward-only, so nothing could undo it afterwards.
assert.strictEqual(completionQualifies({ channel: 'stable', mode: 'full', trigger: 'manual' }), true,
  'a full stable run may advance');
assert.strictEqual(completionQualifies({ channel: 'stable', mode: 'skip-metadata', trigger: 'manual' }),
  false, 'a stable --skip-metadata run must NOT advance lastSync');
assert.strictEqual(completionQualifies({ channel: 'stable', mode: 'metadata-only', trigger: 'cli' }),
  false, 'a stable --metadata-only run must NOT advance lastSync');
assert.strictEqual(completionQualifies({ channel: 'dev', mode: 'full', trigger: 'manual' }, 'stable'),
  false, 'a dev completion must not advance the stable watermark');
// unvalidated provenance fails CLOSED: refusing is recoverable (the receipt reconciles moments
// later); wrongly advancing is not, because forward-only reconciliation cannot undo it
assert.strictEqual(completionQualifies({ channel: 'stable', mode: 'full' }), false, 'no trigger');
assert.strictEqual(completionQualifies({ channel: 'stable', trigger: 'manual' }), false, 'no mode');
assert.strictEqual(completionQualifies({}), false, 'empty payload');
assert.strictEqual(completionQualifies(null), false, 'null payload');
assert.ok(/completionQualifies\(data, runtimeChannel\)/.test(MAIN),
  'the status-server complete handler must consult the shared rule, not just the channel');

// ── incomplete INDEX.md must not present as a successful sync ────────────────────────────
// Python counts index drops separately from per-repo errors so the "why was no metadata
// generated" diagnosis stays correct. That split is only safe if EVERY success/error consumer
// reads both — otherwise a run with errors:0 and indexDropped:3 gets a green icon, a
// "Successfully synced" balloon, and a status file that remembers it as clean.
{
  const dropped = (n) => receipt({ stats: { total: 30, errors: 0, metadataGenerated: 2, indexDropped: n } });

  // Validation: additive within schema 2. Absent must mean zero, not invalid — rejecting older
  // receipts would make the app believe no sync had ever run.
  assert.ok(validateReceipt(receipt()), 'a receipt with no indexDropped field is still valid');
  assert.strictEqual(indexDroppedOf(receipt()), 0, 'absent indexDropped reads as zero');
  assert.ok(validateReceipt(dropped(2)), 'an integer indexDropped is valid');
  assert.strictEqual(indexDroppedOf(dropped(2)), 2);
  assert.strictEqual(validateReceipt(receipt({
    stats: { total: 1, errors: 0, indexDropped: 'two' } })), null,
    'present-but-not-an-integer indexDropped is a corrupt receipt');

  // The success rule itself.
  assert.strictEqual(runSucceeded(receipt({ stats: { total: 1, errors: 0 } })), true,
    'no errors and no drops is a clean run');
  assert.strictEqual(runSucceeded(dropped(3)), false,
    'errors:0 with an incomplete index is NOT a successful run');
  assert.strictEqual(runSucceeded(dropped(0)), true, 'zero drops does not fail a clean run');
  assert.strictEqual(runSucceeded(receipt()), false, 'errors:3 still fails, drops or not');

  // Reconciliation must RETAIN the count. For an app-closed scheduled run the receipt is the
  // only record the run ever happened, so a drop lost here is lost permanently.
  const plan = planReconcile(dropped(2), { lastSync: iso(6 * 3600_000) });
  assert.ok(plan.adopt, 'an incomplete-index run is still adopted — it did complete');
  assert.strictEqual(plan.status.channels.stable.indexDropped, 2,
    'the drop count must survive reconciliation into the status file');
  assert.strictEqual(plan.status.channels.stable.errors, 0,
    'drops must not be folded into the per-repo error count');
  assert.strictEqual(plan.advanceLastSync, true,
    'schedule freshness is preserved: the run completed, so do not trigger a paid catch-up');

  const clean = planReconcile(receipt({ stats: { total: 1, errors: 0 } }), {});
  assert.strictEqual(clean.status.channels.stable.indexDropped, 0,
    'an older receipt without the field reconciles as zero, not undefined');
}

// ── ONE canonical latest-run outcome ─────────────────────────────────────────────────────
// The tray reads status.stats. Receipt adoption must normalize into it, ordered by statsAt.
// Before this, the per-channel receipt state and the live stats were two independently-stale
// representations and readers picked "whichever is non-zero" — which cannot model last-run state,
// because zero is exactly how a clean run says "no longer broken".
{
  const at = (h) => `2026-07-30T${String(h).padStart(2, '0')}:00:00.000Z`;
  const rec = (over, finishedAt) => receipt({ finishedAt, ...over });

  // 1. live index failure → newer clean receipt: the warning and the count must CLEAR.
  {
    const live = { stats: { total: 30, errors: 0, index_dropped: 4 }, statsAt: at(10),
                   hasErrors: true, errorLog: 'earlier failure' };
    const plan = planReconcile(rec({ stats: { total: 30, errors: 0, indexDropped: 0 } }, at(12)), live);
    assert.ok(plan.adopt && plan.isLatestOutcome);
    assert.strictEqual(plan.status.stats.index_dropped, 0,
      'a newer clean run must clear the stale drop count, not lose to it');
    assert.strictEqual(plan.status.hasErrors, false, 'and must clear the error state');
    assert.strictEqual(plan.status.errorLog, 'earlier failure',
      'history is append-only — success does not erase it');
  }

  // 2. live clean success → newer failed receipt: the current failure must APPEAR.
  {
    const live = { stats: { total: 30, errors: 0, index_dropped: 0 }, statsAt: at(10),
                   hasErrors: false };
    const plan = planReconcile(rec({ stats: { total: 30, errors: 0, indexDropped: 3 } }, at(12)), live);
    assert.strictEqual(plan.status.stats.index_dropped, 3);
    assert.strictEqual(plan.status.hasErrors, true);
  }

  // 3. the same two transitions for ordinary errors, not just index drops.
  {
    const live = { stats: { total: 30, errors: 5, index_dropped: 0 }, statsAt: at(10),
                   hasErrors: true };
    const cleared = planReconcile(rec({ stats: { total: 30, errors: 0, indexDropped: 0 } }, at(12)), live);
    assert.strictEqual(cleared.status.stats.errors, 0, 'a newer clean run clears stale errors');
    assert.strictEqual(cleared.status.hasErrors, false);

    const clean = { stats: { total: 30, errors: 0, index_dropped: 0 }, statsAt: at(10),
                    hasErrors: false };
    const failed = planReconcile(rec({ stats: { total: 30, errors: 7, indexDropped: 0 } }, at(12)), clean);
    assert.strictEqual(failed.status.stats.errors, 7);
    assert.strictEqual(failed.status.hasErrors, true);
  }

  // 4. ordering, not blind overwrite: an OLDER receipt must not clobber a newer live outcome.
  {
    const live = { stats: { total: 30, errors: 0, index_dropped: 6 }, statsAt: at(14),
                   hasErrors: true };
    const plan = planReconcile(rec({ stats: { total: 30, errors: 0, indexDropped: 0 } }, at(12)), live);
    assert.ok(plan.adopt, 'still adopted for scheduling/observability purposes');
    assert.strictEqual(plan.isLatestOutcome, false);
    assert.strictEqual(plan.status.stats.index_dropped, 6,
      'the newer live outcome must survive an older receipt');
    assert.strictEqual(plan.status.hasErrors, true);
    assert.strictEqual(plan.status.channels.stable.indexDropped, 0,
      'the per-channel record still tracks that receipt — it is history, not presentation');
  }

  // 5. a first receipt with no prior statsAt is the latest by default.
  {
    const plan = planReconcile(rec({ stats: { total: 30, errors: 0, indexDropped: 2 } }, at(12)), {});
    assert.strictEqual(plan.isLatestOutcome, true);
    assert.strictEqual(plan.status.stats.index_dropped, 2);
    assert.strictEqual(plan.status.statsAt, at(12), 'adoption must stamp the freshness marker');
  }

  // statsFromReceipt translates camelCase receipt stats into the snake_case shape the live path
  // writes, so both transports land in one representation.
  const s = statsFromReceipt(rec({ stats: { total: 30, updated: 4, cloned: 1, skipped: 2,
    errors: 3, metadataGenerated: 5, indexDropped: 6, apiCost: 1.25 } }, at(12)));
  assert.deepStrictEqual(s, { total: 30, updated: 4, cloned: 1, skipped: 2, errors: 3,
    metadata_generated: 5, index_dropped: 6, api_cost: 1.25 });
  assert.deepStrictEqual(statsFromReceipt({}), { total: 0, updated: 0, cloned: 0, skipped: 0,
    errors: 0, metadata_generated: 0, index_dropped: 0, api_cost: 0 }, 'missing fields read as zero');
}

// ── a run must not overwrite its own richer live result ──────────────────────────────────
// The live update and the receipt describe the SAME completion. Each used to stamp its own "now",
// so the receipt was always milliseconds later and read as a newer, cleaner run — silently
// clearing the warning the live path had just raised. Python now stamps one instant for both.
{
  const same = '2026-07-30T12:00:00.000Z';
  const warned = { schema: SCHEMA, channel: 'stable', trigger: 'manual', mode: 'full',
    completed: true, qualifiesForSchedule: true, finishedAt: same,
    warning: '⚠️ No metadata generated: ANTHROPIC_API_KEY not configured.',
    stats: { total: 30, errors: 0, metadataGenerated: 0, indexDropped: 0 } };

  const live = { stats: { total: 30, errors: 0, index_dropped: 0 }, statsAt: same,
                 hasErrors: true, errorLog: 'the warning' };
  const plan = planReconcile(warned, live);
  assert.strictEqual(plan.isLatestOutcome, false,
    "a run's own receipt is not newer than its own live update — same instant, same event");
  assert.strictEqual(plan.status.hasErrors, true,
    'the live warning must survive this run writing its own receipt');
  assert.strictEqual(plan.recordHistory, false,
    'the live path already logged this run — do not append it twice');

  // A warning is actionable even with zero errors, so an app-closed warning-only run must still
  // surface. Before this, the warning was computed only when someone was listening.
  assert.strictEqual(runSucceeded(warned), false, 'a warning means the run needs attention');
  const closed = planReconcile(warned, { statsAt: '2026-07-30T10:00:00.000Z' });
  assert.strictEqual(closed.status.hasErrors, true);
  assert.strictEqual(closed.recordHistory, true, 'nothing else recorded this one');
}

// ── upgrading from a build that predates statsAt ─────────────────────────────────────────
// v1.0.28 stored channels[channel].receiptAt but no statsAt and never normalized a receipt into
// status.stats. Equality with that already-absorbed receipt returned early, so the upgraded app
// kept stale presentation until some future sync happened to produce a newer receipt — which for
// a manual-only user could be never.
{
  const at = '2026-07-30T12:00:00.000Z';
  const legacy = {
    stats: { total: 30, errors: 0, index_dropped: 4 },   // stale: a since-fixed failure
    hasErrors: true,
    channels: { stable: { receiptAt: at, errors: 0, mode: 'full', qualifies: true } },
    lastSync: at,
  };
  const clean = receipt({ finishedAt: at,
    stats: { total: 30, errors: 0, metadataGenerated: 0, indexDropped: 0 } });
  const plan = planReconcile(clean, legacy);

  assert.strictEqual(plan.reason, 'presentation-backfill');
  assert.strictEqual(plan.status.stats.index_dropped, 0, 'stale presentation must be migrated');
  assert.strictEqual(plan.status.hasErrors, false);
  assert.strictEqual(plan.status.statsAt, at, 'and the marker backfilled so it happens once');
  assert.strictEqual(plan.advanceLastSync, false,
    'schedule state was already absorbed — backfill must not re-advance it');
  assert.strictEqual(plan.recordHistory, false, 'nor re-append an old failure to the log');
  assert.deepStrictEqual(plan.status.channels.stable, legacy.channels.stable,
    'history is untouched: this is a presentation-only migration');

  // Idempotent: once statsAt exists, the same receipt is inert.
  const again = planReconcile(clean, plan.status);
  assert.strictEqual(again.adopt, false);
  assert.strictEqual(again.reason, 'already-absorbed');
}

// ── markers we wrote ourselves are not automatically trustworthy ─────────────────────────
// Incoming receipts were validated from the start; the timestamps WE persist gate progress and
// were trusted blindly. Corrupt or future values froze reconciliation permanently.
{
  const now = new Date('2026-07-30T13:00:00.000Z');
  const r = receipt({ finishedAt: '2026-07-30T12:00:00.000Z',
    stats: { total: 30, errors: 0, metadataGenerated: 0, indexDropped: 0 } });

  for (const bad of ['not-a-date', '', '2099-01-01T00:00:00.000Z']) {
    assert.strictEqual(planReconcile(r, { statsAt: bad }, { now }).isLatestOutcome, true,
      `statsAt=${bad || '(empty)'} must read as absent, not freeze presentation forever`);
    const p = planReconcile(r, { channels: { stable: { receiptAt: bad } } }, { now });
    assert.strictEqual(p.adopt, true,
      `receiptAt=${bad || '(empty)'} must read as absent, not freeze schedule history forever`);
  }
  // A future lastSync must not permanently block advancing either.
  const p = planReconcile(r, { lastSync: '2099-01-01T00:00:00.000Z' }, { now });
  assert.strictEqual(p.advanceLastSync, true, 'a future lastSync must not wedge the watermark');
}

// ── the whole completion -> receipt -> child-close sequence ──────────────────────────────
// Three writers touch the outcome for a single run, and each one used to ask its own question.
// The shared instant fixed the receipt writer; the child-exit handler still asked "exit 0 and
// zero errors?" 500ms later and cleared a warning-only outcome the other two had preserved.
{
  const same = '2026-07-30T12:00:00.000Z';
  const WARNING = '⚠️ No metadata generated: ANTHROPIC_API_KEY not configured.';
  const warned = { schema: SCHEMA, channel: 'stable', trigger: 'manual', mode: 'full',
    completed: true, qualifiesForSchedule: true, finishedAt: same, warning: WARNING,
    stats: { total: 30, errors: 0, metadataGenerated: 0, indexDropped: 0 } };

  // 1. live completion writes the canonical outcome (what main.js does on 'complete')
  let status = { stats: { total: 30, errors: 0, index_dropped: 0 }, statsAt: same,
                 warning: WARNING, hasErrors: true };
  // 2. the same run's receipt is reconciled
  status = planReconcile(warned, status).status;
  assert.strictEqual(status.hasErrors, true, 'reconciliation preserves it');
  // 3. child exits 0 — the step that used to erase it
  assert.strictEqual(statusNeedsAttention(status), true,
    'exit 0 means the process finished, not that the run was clean');

  // The app-closed variant: no live completion at all, receipt is the only record.
  const closed = planReconcile(warned, { statsAt: '2026-07-30T10:00:00.000Z' }).status;
  assert.strictEqual(closed.warning, WARNING,
    'the REASON must reach presentation, not just the fact that something is wrong');
  assert.strictEqual(statusNeedsAttention(closed), true);

  // And a newer clean run clears it — last-run state, like hasErrors.
  const cleanRun = { ...warned, warning: null, finishedAt: '2026-07-30T13:00:00.000Z' };
  const after = planReconcile(cleanRun, closed).status;
  assert.strictEqual(after.warning, null, 'a newer clean outcome clears the warning');
  assert.strictEqual(statusNeedsAttention(after), false);

  // statusNeedsAttention covers all three inputs, not just warnings.
  assert.strictEqual(statusNeedsAttention({ stats: { errors: 2, index_dropped: 0 } }), true);
  assert.strictEqual(statusNeedsAttention({ stats: { errors: 0, index_dropped: 3 } }), true);
  assert.strictEqual(statusNeedsAttention({ stats: { errors: 0, index_dropped: 0 } }), false);
  assert.strictEqual(statusNeedsAttention({}), false, 'an empty status is not a failure');
}

// ── a future watermark must be repairable even when the receipt is already absorbed ──────
// parsePersistedInstant made a corrupt lastSync READ as absent, but advancement was gated on
// !absorbed — so the exact combination "receipt already absorbed + future lastSync" left the
// watermark wedged and needsCatchUp reporting the schedule satisfied until 2099.
{
  const at = '2026-07-30T12:00:00.000Z';
  const r = receipt({ finishedAt: at,
    stats: { total: 30, errors: 0, metadataGenerated: 0, indexDropped: 0 } });
  const wedged = { channels: { stable: { receiptAt: at } }, statsAt: at,
                   lastSync: '2099-01-01T00:00:00.000Z' };
  const plan = planReconcile(r, wedged, { now: new Date('2026-07-30T13:00:00.000Z') });

  assert.strictEqual(plan.reason, 'watermark-repair');
  assert.strictEqual(plan.advanceLastSync, true);
  assert.strictEqual(plan.status.lastSync, at, 'the impossible watermark must be repaired');
  assert.strictEqual(plan.recordHistory, false, 'repair must not re-log an absorbed run');
  assert.deepStrictEqual(plan.status.channels.stable, wedged.channels.stable,
    'nor rewrite history');

  // Idempotent: once repaired, the same receipt is inert again.
  const again = planReconcile(r, plan.status, { now: new Date('2026-07-30T13:00:00.000Z') });
  assert.strictEqual(again.adopt, false);
  assert.strictEqual(again.reason, 'already-absorbed');
}

// ── warning must be a string or absent ───────────────────────────────────────────────────
// Truthiness drives the success rule, so an object or a number would silently mean "failed".
{
  const base = { finishedAt: '2026-07-30T12:00:00.000Z',
    stats: { total: 1, errors: 0, metadataGenerated: 0, indexDropped: 0 } };
  for (const bad of [{ msg: 'x' }, ['x'], 42, true]) {
    assert.strictEqual(validateReceipt(receipt({ ...base, warning: bad })), null,
      `warning=${JSON.stringify(bad)} must be rejected, not coerced by truthiness`);
  }
  assert.ok(validateReceipt(receipt({ ...base, warning: null })), 'null means no warning');
  assert.ok(validateReceipt(receipt(base)), 'absent means no warning');
  assert.ok(validateReceipt(receipt({ ...base, warning: 'real' })), 'a string is a warning');
  assert.strictEqual(warningOf(receipt({ ...base, warning: '' })), null, 'empty is not a warning');
}

// ── the outcome rule must agree with itself in both shapes ───────────────────────────────
// It was written as two predicates — `errors === 0` for receipts, `errors > 0` for status — which
// agree only on the values we expected. A negative counter satisfied neither, so reconciliation
// set hasErrors=true and child-close cleared it again: the round-11 bypass, reachable through a
// state both validators accepted. One helper now backs both.
{
  for (const [errors, dropped, warning] of [[0, 0, null], [2, 0, null], [0, 3, null],
                                            [0, 0, 'w'], [-1, 0, null], [0, -1, null],
                                            [-1, 0, 'w']]) {
    const asReceipt = { stats: { errors, indexDropped: dropped }, warning };
    const asStatus = { stats: { errors, index_dropped: dropped }, warning };
    assert.strictEqual(!runSucceeded(asReceipt), statusNeedsAttention(asStatus),
      `the two shapes must reach the same verdict for errors=${errors} drops=${dropped}`);
  }
  // And an impossible counter must read as "needs attention", never as success.
  assert.strictEqual(runSucceeded({ stats: { errors: -1, indexDropped: 0 } }), false,
    'a negative counter is not a clean run');
  assert.strictEqual(statusNeedsAttention({ stats: { errors: 0, index_dropped: -1 } }), true);

  // Counters are non-negative, so a receipt carrying one is malformed and must not be usable.
  const base = { finishedAt: '2026-07-30T12:00:00.000Z' };
  assert.strictEqual(validateReceipt(receipt({ ...base,
    stats: { total: 1, errors: -1, metadataGenerated: 0, indexDropped: 0 } })), null,
    'a negative error count must be rejected');
  assert.strictEqual(validateReceipt(receipt({ ...base,
    stats: { total: 1, errors: 0, metadataGenerated: 0, indexDropped: -1 } })), null,
    'a negative drop count must be rejected');
  assert.strictEqual(validateReceipt(receipt({ ...base,
    stats: { total: 1, errors: 0, metadataGenerated: 0, indexDropped: null } })), null,
    'an explicitly null drop count is malformed — distinct from the field being absent');
  assert.ok(validateReceipt(receipt({ ...base,
    stats: { total: 1, errors: 0, metadataGenerated: 0 } })),
    'an ABSENT drop count is a pre-upgrade receipt and stays valid');
}

// main.js wiring landmarks for the two consumers Codex found still reporting success.
// NOTE the key difference: the live status-server payload carries Python's raw stats dict
// (snake_case index_dropped) while the durable receipt uses camelCase indexDropped. Both
// spellings are asserted here so a rename on either transport fails loudly.
assert.ok(/data\.stats\.index_dropped/.test(MAIN),
  'the live completion handler must read the drop count off the status-server payload');
assert.ok(/data\.stats\.errors > 0 \|\| indexDropped > 0/.test(MAIN),
  'the icon/hasErrors decision must treat an incomplete index as a failure');
assert.ok(/Sync Complete \(index incomplete\)/.test(MAIN),
  'an incomplete index needs its own notification, not "Successfully synced N repositories"');
assert.ok(/runSucceeded\(receipt\)/.test(MAIN),
  'receipt reconciliation must consult the shared success rule');
{
  const fn = MAIN.slice(MAIN.indexOf('function reconcileRunReceipt()'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  // Presentation state now belongs to planReconcile (asserted behaviourally above) so there is
  // one canonical outcome. main.js must not re-derive it here, and must gate its history append
  // on the same freshness ordering — an older receipt has no business writing "current" text.
  assert.ok(!/adopted\.hasErrors\s*=/.test(body),
    'main.js must not set hasErrors itself — planReconcile owns the canonical outcome');
  assert.ok(/if \(plan\.recordHistory\)/.test(body),
    'the errorLog append must be gated on the shared record-history decision, so a presentation '
    + 'backfill or a run the live path already logged cannot double-write history');
  assert.ok(/errorLog = \(adopted\.errorLog \|\| ''\)/.test(body),
    'errorLog is history and may only be appended to, never erased on success');
}

// The live path must stamp when its outcome was produced, or adoption cannot order the two.
// The child-exit handler must consult the shared rule rather than re-deriving a narrower one.
assert.ok(/if \(statusNeedsAttention\(status\)\)/.test(MAIN),
  'the child-close path must consult the canonical outcome, not just stats.errors');
assert.ok(!/if \(status\.stats && status\.stats\.errors > 0\) \{/.test(MAIN),
  'the old errors-only child-close check must be gone, not merely supplemented');
assert.ok(/status\.warning = \(typeof data\.warning === 'string'/.test(MAIN),
  'the live handler must record the warning into the canonical outcome');

assert.ok(/data\.finishedAt === 'string'/.test(MAIN) && /status\.statsAt = /.test(MAIN),
  "the live handler must prefer Python's shared completion instant when stamping statsAt, so a "
  + "run's own receipt cannot read as newer than its own live update");
{
  const fn = MAIN.slice(MAIN.indexOf('function trayIndexDropped(status)'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(!/channels/.test(body),
    'the tray must read ONE canonical source, not choose between live stats and channel state');
}

// The startup reset that erased the failure reconciled moments earlier. reconcileRunReceipt() runs
// during app.whenReady(); an unconditional `status.hasErrors = false` after it meant an app-closed
// failure flashed for one tray render and then "View Errors" vanished.
{
  const ready = MAIN.slice(MAIN.indexOf('app.whenReady().then'));
  assert.ok(!/status\.hasErrors = false;\s*\n\s*saveStatus\(status\);/.test(ready),
    'startup must not unconditionally clear the error state it just reconciled');
  assert.ok(/createTrayIcon\(status\.hasErrors \? 'red' : 'white', 0\)/.test(ready),
    'the first tray render must reflect the reconciled status, not a forced white icon');
}

// Index-only failures must not render as "Sync failed with 0 errors".
assert.ok(/function trayIndexDropped\(status\)/.test(MAIN),
  'the drop lookup must live in one place');
assert.ok(/Sync incomplete — \$\{dropped\} repositor/.test(MAIN),
  'an index-only failure needs its own tooltip, not a "0 errors" one');

console.log('run-receipt OK: production planReconcile + validation + index-drop propagation'
  + ' + main.js wiring landmarks');
