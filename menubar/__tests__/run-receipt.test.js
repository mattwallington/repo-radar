// Receipt reconciliation. Exercises the PRODUCTION module (../run-receipt), not a mirror — a
// copied implementation in the test file stays green even if the real function returns early or
// its semantics drift, which is exactly how a synthesis fix once shipped as dead code.
// Landmarks below additionally assert main.js is wired to call it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { planReconcile, validateReceipt, satisfiesSchedule, SCHEMA } = require('../run-receipt');
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
  assert.strictEqual(plan.status.lastRunTrigger, 'scheduled');
  assert.strictEqual(plan.status.lastRunErrors, 3, 'error count recorded');
  assert.strictEqual(plan.status.lastRunReceiptAt, r.finishedAt, 'receipt watermark set');
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
  const r = receipt({ trigger: 'manual', finishedAt: iso(120_000) });
  const plan = planReconcile(r, { lastSync: newerLastSync });
  assert.ok(plan.adopt, 'must still absorb the receipt for observability');
  assert.strictEqual(plan.advanceLastSync, false, 'but must not rewind lastSync');
  assert.strictEqual(plan.status.lastSync, newerLastSync, 'lastSync must be byte-identical');
  assert.strictEqual(plan.status.lastRunTrigger, 'manual', 'provenance recorded anyway');
  assert.strictEqual(plan.status.lastRunReceiptAt, r.finishedAt, 'watermark advanced');
  assert.strictEqual(plan.reason, 'observability-only');
}

// ── a partial run completes but must NOT suppress the full schedule ──────────────────────
{
  const r = receipt({ mode: 'skip-metadata', qualifiesForSchedule: false, trigger: 'manual' });
  const plan = planReconcile(r, { lastSync: iso(6 * 3600_000) });
  assert.ok(plan.adopt, 'still absorbed');
  assert.strictEqual(plan.advanceLastSync, false,
    'a --skip-metadata run did not do the scheduled work, so it must not satisfy the schedule');
  assert.strictEqual(plan.status.lastRunMode, 'skip-metadata');
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

// ── schedule equivalence ────────────────────────────────────────────────────────────────
assert.ok(satisfiesSchedule(receipt({ trigger: 'scheduled' })), 'scheduled satisfies');
assert.ok(satisfiesSchedule(receipt({ trigger: 'catchup' })), 'catch-up stands in for a miss');
// manual/cli mean "a user asked for a sync now", which is not the same as the scheduled
// occurrence having happened, so they do not satisfy the schedule even when mode is full.
assert.strictEqual(satisfiesSchedule(receipt({ trigger: 'manual' })), false,
  'a manual run is not the scheduled occurrence');
assert.strictEqual(satisfiesSchedule(receipt({ trigger: 'cli' })), false,
  'a direct CLI run is not the scheduled occurrence');
assert.strictEqual(satisfiesSchedule(receipt({ trigger: 'scheduled', qualifiesForSchedule: false })),
  false, 'a partial scheduled run does not satisfy the schedule either');
assert.strictEqual(satisfiesSchedule(null), false, 'null is false, not a throw');

// ── main.js wiring landmarks ────────────────────────────────────────────────────────────
assert.ok(/require\('\.\/run-receipt'\)/.test(MAIN), 'main.js must use the shared module');
assert.ok(/function reconcileRunReceipt\(/.test(MAIN) && /reconcileRunReceipt\(\)/.test(MAIN),
  'reconcileRunReceipt must exist AND be called');
assert.ok(/function hardenExistingConfig\(/.test(MAIN) && /hardenExistingConfig\(\)/.test(MAIN),
  'startup config hardening must exist AND be called');
assert.ok(/function scheduleCatchUpSync\(/.test(MAIN),
  'delayed catch-up must go through the revalidating helper');
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

console.log('run-receipt OK: production planReconcile + validation + main.js wiring landmarks');
