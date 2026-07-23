'use strict';
// 7a scripted logic harness — orchestration-level adversarial cases that complement the
// per-module tests (which already cover: kernel lock auto-release-on-kill [lock.test],
// verifyRuntime tamper-fails + GC retain-activated [activation.test], fail-closed on
// quiescence + busy [index.test], redaction [hashing/provision]).
const test = require('node:test'); const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
const { ensureRuntime } = require('../index');
const { layout } = require('../paths');
const { readDesired } = require('../desired');

const WT = path.join(__dirname, '..', '..', '..');
function bundleFor(version) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-bundle-'));
  fs.writeFileSync(path.join(d, 'VERSION'), `${version}\n`);
  return { repoRadarDir: path.join(WT, 'repo_radar'), launcher: path.join(WT, 'repo-radar'), versionFile: path.join(d, 'VERSION') };
}
const activeVersion = (L) => fs.readFileSync(path.join(fs.realpathSync(L.current), 'VERSION'), 'utf8').trim();

test('downgrade/rollback: ensureRuntime to an older managed version reports+runs it', { timeout: 360000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-rollback-'));
  const L = layout(home, 'stable');
  assert.strictEqual((await ensureRuntime({ home, channel: 'stable', appVersion: '1.0.27', bundle: bundleFor('1.0.27'), _skipQuiesce: true })).status, 'ok');
  assert.strictEqual((await ensureRuntime({ home, channel: 'stable', appVersion: '1.0.28', bundle: bundleFor('1.0.28'), _skipQuiesce: true })).status, 'ok');
  assert.strictEqual(activeVersion(L), '1.0.28');
  // roll BACK to 1.0.27 (direction-agnostic managed update)
  const back = await ensureRuntime({ home, channel: 'stable', appVersion: '1.0.27', bundle: bundleFor('1.0.27'), _skipQuiesce: true });
  assert.strictEqual(back.status, 'ok', back.reason);
  assert.strictEqual(readDesired(L.desired).version, '1.0.27');
  assert.strictEqual(activeVersion(L), '1.0.27');
});

test('tamper -> next ensureRuntime builds a replacement generation and flips (no pre-flip mutation)', { timeout: 360000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-tamper-'));
  const L = layout(home, 'stable');
  const r1 = await ensureRuntime({ home, channel: 'stable', appVersion: '1.0.27', bundle: bundleFor('1.0.27'), _skipQuiesce: true });
  assert.strictEqual(r1.status, 'ok');
  const tamperedGen = fs.realpathSync(L.current);

  // tamper the ACTIVE payload
  fs.writeFileSync(path.join(tamperedGen, 'VERSION'), '6.6.6\n');

  // next reconcile: fast-path verify fails -> rebuild -> flip to a fresh healthy gen
  const r2 = await ensureRuntime({ home, channel: 'stable', appVersion: '1.0.27', bundle: bundleFor('1.0.27'), _skipQuiesce: true });
  assert.strictEqual(r2.status, 'ok', r2.reason);
  const newGen = fs.realpathSync(L.current);
  assert.notStrictEqual(newGen, tamperedGen, 'current flipped to a new generation');
  assert.strictEqual(activeVersion(L), '1.0.27', 'new generation reports the correct version');
  // the tampered generation is NOT mutated pre-flip (still tampered on disk, just no longer current)
  assert.strictEqual(fs.readFileSync(path.join(tamperedGen, 'VERSION'), 'utf8').trim(), '6.6.6');
});
