// Reconciling a completion receipt written by a sync that ran while the app was closed.
//
// The reconciler is embedded in main.js (which needs Electron), so the *logic* is mirrored here
// against real files and asserted, plus landmark checks that main.js is actually wired the way
// these tests describe. That pairing is deliberate: a logic test alone would have happily
// passed while main.js never called the reconciler at all.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

// ── landmarks: main.js is wired as described ────────────────────────────────────────────
assert.ok(/function reconcileRunReceipt\(/.test(MAIN), 'reconcileRunReceipt must exist');
assert.ok(/reconcileRunReceipt\(\);/.test(MAIN), 'it must actually be CALLED, not just defined');
{
  // It must run BEFORE lastSync is read for the missed-sync decision, or a completed
  // scheduled run still looks missed and gets repeated.
  const fn = MAIN.slice(MAIN.indexOf('function checkMissedSync()'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(body.indexOf('reconcileRunReceipt()') < body.indexOf('const status = loadStatus()'),
    'reconcileRunReceipt() must precede loadStatus() inside checkMissedSync');
}
assert.ok(/addEnvVar\('REPO_RADAR_TRIGGER', 'scheduled'\)/.test(MAIN),
  'the LaunchAgent must declare its trigger explicitly');
assert.ok(/writeFileSync\(configFile,[\s\S]*?\{ mode: 0o600 \}\)/.test(MAIN),
  'config must be created 0600');
assert.ok(/chmodSync\(configFile, 0o600\)/.test(MAIN),
  'config must be chmod-ed 0600 so pre-existing loose files are tightened');

// ── the reconcile rule, exercised against real files ───────────────────────────────────
// Mirrors main.js: adopt only a completed, schema-1, non-future receipt, and only forward.
function reconcile(dir) {
  const statusFile = path.join(dir, 'status.json');
  const receiptFile = path.join(dir, 'last-run.json');
  if (!fs.existsSync(receiptFile)) return null;
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8')); } catch { return null; }
  if (!receipt || receipt.schema !== 1 || !receipt.completed || !receipt.finishedAt) return null;
  const finished = new Date(receipt.finishedAt);
  if (Number.isNaN(finished.getTime()) || finished > new Date()) return null;
  const status = fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, 'utf8')) : {};
  const known = status.lastSync ? new Date(status.lastSync) : null;
  if (known && !(finished > known)) return null;
  status.lastSync = receipt.finishedAt;
  status.lastRunTrigger = receipt.trigger || null;
  fs.writeFileSync(statusFile, JSON.stringify(status, null, 2));
  return receipt;
}

function ctx(status, receipt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-receipt-'));
  if (status) fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(status));
  if (receipt) fs.writeFileSync(path.join(dir, 'last-run.json'), JSON.stringify(receipt));
  return dir;
}
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const good = (over) => ({ schema: 1, completed: true, trigger: 'scheduled',
  finishedAt: iso(60_000), stats: { errors: 3 }, ...over });

// the actual bug: a scheduled run finished while the app was closed
{
  const receipt = good();                      // capture: good() re-derives finishedAt each call
  const stale = iso(6 * 3600_000);
  const d = ctx({ lastSync: stale }, receipt);
  assert.ok(reconcile(d), 'a newer completed run must be adopted');
  const st = JSON.parse(fs.readFileSync(path.join(d, 'status.json'), 'utf8'));
  assert.strictEqual(st.lastSync, receipt.finishedAt, 'lastSync must equal the receipt exactly');
  assert.ok(new Date(st.lastSync) > new Date(stale), 'lastSync moved forward');
  assert.strictEqual(st.lastRunTrigger, 'scheduled', 'provenance recorded');
}
// errors do not prevent adoption — the run COMPLETED
{
  const d = ctx({ lastSync: iso(6 * 3600_000) }, good({ stats: { errors: 3 } }));
  assert.ok(reconcile(d), 'a completed run with known per-repo errors is still a completed run');
}
// never move backwards
{
  const recent = iso(1000);
  const d = ctx({ lastSync: recent }, good({ finishedAt: iso(3600_000) }));
  assert.strictEqual(reconcile(d), null, 'an older receipt must not rewind lastSync');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(d, 'status.json'), 'utf8')).lastSync,
    recent, 'lastSync unchanged');
}
// no status file yet (first ever run)
{
  const d = ctx(null, good());
  assert.ok(reconcile(d), 'a first run with no prior status must be adopted');
}
// junk is ignored rather than trusted
assert.strictEqual(reconcile(ctx({}, good({ schema: 99 }))), null, 'foreign schema ignored');
assert.strictEqual(reconcile(ctx({}, good({ completed: false }))), null, 'incomplete ignored');
assert.strictEqual(reconcile(ctx({}, good({ finishedAt: 'not-a-date' }))), null, 'bad date ignored');
assert.strictEqual(reconcile(ctx({}, good({ finishedAt: new Date(Date.now() + 9e8).toISOString() }))),
  null, 'a future timestamp must not be adopted (clock skew / tampering)');
assert.strictEqual(reconcile(ctx({}, null)), null, 'absent receipt is a no-op');
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-receipt-'));
  fs.writeFileSync(path.join(d, 'last-run.json'), '{ not json');
  assert.strictEqual(reconcile(d), null, 'corrupt receipt must not throw');
}

console.log('run-receipt OK: reconcile rule + main.js wiring landmarks');
