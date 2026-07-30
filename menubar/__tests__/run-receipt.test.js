// Receipt reconciliation. Exercises the PRODUCTION module (../run-receipt), not a mirror — a
// copied implementation in the test file stays green even if the real function returns early or
// its semantics drift, which is exactly how a synthesis fix once shipped as dead code.
// Landmarks below additionally assert main.js is wired to call it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { planReconcile, validateReceipt, qualifiesForSchedule, needsCatchUp, SCHEMA,
        EXIT_SKIPPED_NO_WORK } = require('../run-receipt');
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
  const gates = MAIN.match(/if \(runtimeChannel === SCHEDULING_CHANNEL\) \{/g) || [];
  assert.ok(gates.length >= 2,
    `both lastSync writers must be channel-gated (found ${gates.length})`);
  // and no ungated assignment may remain
  const ungated = MAIN.split('\n').filter((l, i, all) =>
    /status\.lastSync = new Date\(\)\.toISOString\(\);/.test(l)
    && !/SCHEDULING_CHANNEL/.test(all.slice(Math.max(0, i - 6), i).join('\n')));
  assert.strictEqual(ungated.length, 0,
    `found ${ungated.length} ungated status.lastSync write(s)`);
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

console.log('run-receipt OK: production planReconcile + validation + main.js wiring landmarks');
