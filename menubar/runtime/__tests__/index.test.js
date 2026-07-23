'use strict';
const test = require('node:test'); const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
const { ensureRuntime, runSync } = require('../index');
const { layout, cliPath } = require('../paths');
const { readDesired } = require('../desired');
const { withLock } = require('../lock');
const { emitRunSync } = require('../dispatchers');

const WT = path.join(__dirname, '..', '..', '..');

function bundleFor(version) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-bundle-'));
  fs.writeFileSync(path.join(d, 'VERSION'), `${version}\n`);
  return { repoRadarDir: path.join(WT, 'repo_radar'), launcher: path.join(WT, 'repo-radar'), versionFile: path.join(d, 'VERSION') };
}
const gens = (L) => fs.readdirSync(L.generations).filter((n) => !n.includes('.staging'));

test('ensureRuntime: legacy bootstrap -> idempotent no-op -> managed update (via lock-owning helper)', { timeout: 360000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-idx-'));
  const L = layout(home, 'stable');

  const r1 = await ensureRuntime({ home, channel: 'stable', appVersion: '1.0.27', bundle: bundleFor('1.0.27'), _skipQuiesce: true });
  assert.strictEqual(r1.status, 'ok', r1.reason);
  const d1 = readDesired(L.desired);
  assert.strictEqual(d1.version, '1.0.27');
  assert.strictEqual(d1.status, 'active', 'desired ends ACTIVE');
  assert.ok(fs.existsSync(cliPath(home, 'stable')), 'stable CLI dispatcher installed');
  assert.ok(fs.existsSync(L.runSync), 'run-sync.sh emitted');
  const g1 = fs.realpathSync(L.current);
  assert.match(fs.readFileSync(path.join(g1, 'VERSION'), 'utf8'), /1\.0\.27/);
  assert.ok(fs.existsSync(path.join(g1, 'verify.py')) && fs.existsSync(path.join(g1, 'manifest.json')), 'gen carries verifier + manifest');
  assert.strictEqual(gens(L).length, 1);

  // idempotent no-op (same bundle) -> fast path, no new generation, no helper
  const r2 = await ensureRuntime({ home, channel: 'stable', appVersion: '1.0.27', bundle: bundleFor('1.0.27'), _skipQuiesce: true });
  assert.strictEqual(r2.status, 'ok');
  assert.strictEqual(gens(L).length, 1, 'no rebuild when healthy');

  // managed update to 1.0.28
  const r3 = await ensureRuntime({ home, channel: 'stable', appVersion: '1.0.28', bundle: bundleFor('1.0.28'), _skipQuiesce: true });
  assert.strictEqual(r3.status, 'ok', r3.reason);
  const d3 = readDesired(L.desired);
  assert.strictEqual(d3.version, '1.0.28');
  assert.strictEqual(d3.status, 'active');
  assert.match(fs.readFileSync(path.join(fs.realpathSync(L.current), 'VERSION'), 'utf8'), /1\.0\.28/);
  const activated = JSON.parse(fs.readFileSync(path.join(L.channelDir, 'activated.json'), 'utf8'));
  assert.strictEqual(activated.length, 2, 'old + new generations both activated/retained');
});

test('ensureRuntime fails closed (desired stays provisioning) when identity is unsafe', { timeout: 20000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-idx-'));
  const L = layout(home, 'stable');
  const bundle = bundleFor('1.0.27');
  // app version 2.0.0 is the fictitious fallback -> authoritativeIdentity fails closed
  const r = await ensureRuntime({ home, channel: 'stable', appVersion: '2.0.0', bundle, _skipQuiesce: true });
  assert.strictEqual(r.status, 'failed');
  // no desired published (failed before the provisioning intent) or, if published, not active
  assert.ok(!fs.existsSync(L.current), 'no runtime activated');
});

test('runSync spawns run-sync.sh: no runtime -> non-zero exit; busy -> code 75 reject', { timeout: 20000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-idx-'));
  emitRunSync(home, 'stable'); // script present, but no active runtime
  fs.mkdirSync(path.join(home, '.repo-radar'), { recursive: true });
  const env = { HOME: home };
  // no current -> the script exits 1 (fail closed) and runSync resolves that code
  const code = await runSync({ home, channel: 'stable', env });
  assert.strictEqual(code, 1);
  // busy: hold the root exec lock, then runSync's run-sync.sh must get 75
  const L = layout(home, 'stable');
  await withLock(L.execLock, 0, async () => {
    await assert.rejects(runSync({ home, channel: 'stable', env }), (e) => e.code === 75);
  });
});
