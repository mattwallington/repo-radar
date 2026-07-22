'use strict';
const test = require('node:test'); const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
const { ensureRuntime, runSync } = require('../index');
const { layout, cliPath } = require('../paths');
const { readDesired } = require('../desired');
const { withLock, LockBusy } = require('../lock');

const WT = path.join(__dirname, '..', '..', '..');
const stubQuiesce = async () => ({ quiesced: true, reason: 'stub' });

function bundleFor(version) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-bundle-'));
  fs.writeFileSync(path.join(d, 'VERSION'), `${version}\n`);
  return { repoRadarDir: path.join(WT, 'repo_radar'), launcher: path.join(WT, 'repo-radar'), versionFile: path.join(d, 'VERSION') };
}
const gens = (L) => fs.readdirSync(L.generations).filter((n) => !n.includes('.staging'));

test('ensureRuntime: legacy bootstrap -> idempotent no-op -> managed update', { timeout: 360000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-idx-'));
  const L = layout(home, 'stable');

  // 1. legacy bootstrap (no desired.json yet)
  const r1 = await ensureRuntime({ home, channel: 'stable', appVersion: '1.0.27', bundle: bundleFor('1.0.27'), quiesceFn: stubQuiesce });
  assert.strictEqual(r1.status, 'ok', r1.reason);
  assert.strictEqual(readDesired(L.desired).version, '1.0.27');
  assert.ok(fs.existsSync(cliPath(home, 'stable')), 'stable CLI dispatcher installed');
  assert.ok(fs.existsSync(L.runSync), 'run-sync.sh emitted');
  assert.match(fs.readFileSync(path.join(fs.realpathSync(L.current), 'VERSION'), 'utf8'), /1\.0\.27/);
  assert.strictEqual(gens(L).length, 1);

  // 2. idempotent no-op (same version) -> no new generation
  const r2 = await ensureRuntime({ home, channel: 'stable', appVersion: '1.0.27', bundle: bundleFor('1.0.27'), quiesceFn: stubQuiesce });
  assert.strictEqual(r2.status, 'ok');
  assert.strictEqual(gens(L).length, 1, 'no rebuild when healthy');

  // 3. managed update to 1.0.28 -> publish desired first, provision, flip; old retained
  const r3 = await ensureRuntime({ home, channel: 'stable', appVersion: '1.0.28', bundle: bundleFor('1.0.28'), quiesceFn: stubQuiesce });
  assert.strictEqual(r3.status, 'ok', r3.reason);
  assert.strictEqual(readDesired(L.desired).version, '1.0.28');
  assert.match(fs.readFileSync(path.join(fs.realpathSync(L.current), 'VERSION'), 'utf8'), /1\.0\.28/);
  const activated = JSON.parse(fs.readFileSync(path.join(L.channelDir, 'activated.json'), 'utf8'));
  assert.strictEqual(activated.length, 2, 'old + new generations both activated/retained');
});

test('ensureRuntime fails closed (no launchd) when quiescence fails', { timeout: 30000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-idx-'));
  const r = await ensureRuntime({ home, channel: 'stable', appVersion: '1.0.27', bundle: bundleFor('1.0.27'),
    quiesceFn: async () => ({ quiesced: false, reason: 'stuck' }) });
  assert.strictEqual(r.status, 'failed');
  assert.match(r.reason, /quiescent/);
});

test('runSync fails closed with no runtime, and is busy when the root lock is held', { timeout: 20000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-idx-'));
  await assert.rejects(runSync({ home, channel: 'stable' })); // no current -> throws
  const L = layout(home, 'stable');
  await withLock(L.execLock, 0, async () => {
    await assert.rejects(runSync({ home, channel: 'stable' }), (e) => e instanceof LockBusy || e.code === 75);
  });
});
