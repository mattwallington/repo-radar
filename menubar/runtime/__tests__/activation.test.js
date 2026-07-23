'use strict';
const test = require('node:test'); const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
const { verifyRuntime, flipCurrent, adopt, gcOrphans } = require('../activation');
const { provision } = require('../provision');
const { layout } = require('../paths');

const WT = path.join(__dirname, '..', '..', '..');

function realGen(home) {
  const vfix = path.join(home, 'VERSION-fixture'); fs.writeFileSync(vfix, '1.0.27\n');
  return provision({
    home, channel: 'stable', identity: { version: '1.0.27' },
    bundle: { repoRadarDir: path.join(WT, 'repo_radar'), launcher: path.join(WT, 'repo-radar'), versionFile: vfix },
    logPath: path.join(home, 'p.log'),
  });
}
function desiredFromMarker(m) {
  return { schema: 1, channel: m.channel, version: m.version, genId: m.genId,
    sourceSha: m.sourceSha, launcherSha: m.launcherSha, versionSha: m.versionSha, lockSha: m.lockSha,
    verifySha: m.verifySha, manifestSha: m.manifestSha };
}

test('verify + adopt + flip on a real generation, then tamper fails closed', { timeout: 180000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-act-'));
  const { genDir, genId, marker } = realGen(home);
  const desired = desiredFromMarker(marker);

  assert.strictEqual(verifyRuntime({ home, channel: 'stable', genDir, desired }).ok, true);
  assert.strictEqual(adopt({ home, channel: 'stable', desired }), genDir);

  flipCurrent(home, 'stable', genDir);
  const L = layout(home, 'stable');
  assert.strictEqual(fs.realpathSync(L.current), fs.realpathSync(genDir));
  assert.ok(JSON.parse(fs.readFileSync(path.join(L.channelDir, 'activated.json'), 'utf8')).includes(genId));

  // tamper the active payload -> live versionSha != marker -> fail closed
  fs.writeFileSync(path.join(genDir, 'VERSION'), '9.9.9\n');
  const r = verifyRuntime({ home, channel: 'stable', genDir, desired });
  assert.strictEqual(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes('versionSha')), r.reasons.join('; '));
  assert.strictEqual(adopt({ home, channel: 'stable', desired }), null); // no longer adoptable
});

test('gcOrphans removes staging + never-activated, retains activated + current', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-act-'));
  const L = layout(home, 'stable'); fs.mkdirSync(L.generations, { recursive: true });
  for (const n of ['g-active', 'g-old-activated', 'g-orphan', 'g-x.staging-123']) fs.mkdirSync(path.join(L.generations, n));
  fs.symlinkSync(path.join(L.generations, 'g-active'), L.current);
  fs.writeFileSync(path.join(L.channelDir, 'activated.json'), JSON.stringify(['g-active', 'g-old-activated']));

  const removed = gcOrphans(home, 'stable');
  assert.ok(removed.includes('g-x.staging-123'), 'staging removed');
  assert.ok(removed.includes('g-orphan'), 'never-activated orphan removed');
  assert.ok(!removed.includes('g-active') && !removed.includes('g-old-activated'), 'activated retained');
  assert.ok(fs.existsSync(path.join(L.generations, 'g-active')));
  assert.ok(fs.existsSync(path.join(L.generations, 'g-old-activated')));
  assert.ok(!fs.existsSync(path.join(L.generations, 'g-orphan')));
});
