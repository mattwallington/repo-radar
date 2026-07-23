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

test('gcOrphans caps retention: keeps current + the single most-recent inactive, prunes older activated + compacts the journal', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-gc-cap-'));
  const L = layout(home, 'stable'); fs.mkdirSync(L.generations, { recursive: true });
  // activation order oldest->newest: g1, g2, g3(current)
  for (const n of ['g1', 'g2', 'g3']) fs.mkdirSync(path.join(L.generations, n));
  fs.symlinkSync(path.join(L.generations, 'g3'), L.current);
  fs.writeFileSync(path.join(L.channelDir, 'activated.json'), JSON.stringify(['g1', 'g2', 'g3']));

  const removed = gcOrphans(home, 'stable');
  assert.ok(removed.includes('g1'), 'oldest activated pruned');
  assert.ok(!removed.includes('g2') && !removed.includes('g3'), 'current + most-recent inactive kept');
  assert.ok(fs.existsSync(path.join(L.generations, 'g2')) && fs.existsSync(path.join(L.generations, 'g3')));
  assert.ok(!fs.existsSync(path.join(L.generations, 'g1')));
  // journal compacted to retained genIds, activation order preserved
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(L.channelDir, 'activated.json'), 'utf8')), ['g2', 'g3']);
});

test('gcOrphans protects current even when absent from the journal', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-gc-cur-'));
  const L = layout(home, 'stable'); fs.mkdirSync(L.generations, { recursive: true });
  for (const n of ['gc', 'ga']) fs.mkdirSync(path.join(L.generations, n));
  fs.symlinkSync(path.join(L.generations, 'gc'), L.current);
  fs.writeFileSync(path.join(L.channelDir, 'activated.json'), JSON.stringify(['ga'])); // current 'gc' not journaled
  const removed = gcOrphans(home, 'stable');
  assert.ok(!removed.includes('gc'), 'current never removed');
  assert.ok(fs.existsSync(path.join(L.generations, 'gc')), 'current retained');
  assert.ok(fs.existsSync(path.join(L.generations, 'ga')), 'most-recent inactive retained');
  assert.ok(JSON.parse(fs.readFileSync(path.join(L.channelDir, 'activated.json'), 'utf8')).includes('gc'), 'current added to compacted journal');
});

test('gcOrphans keeps generations bounded (<=2) across repeated upgrades', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-gc-bound-'));
  const L = layout(home, 'stable'); fs.mkdirSync(L.generations, { recursive: true });
  const jp = path.join(L.channelDir, 'activated.json');
  for (let i = 1; i <= 6; i++) {
    const g = `gen${i}`;
    fs.mkdirSync(path.join(L.generations, g));
    // mirror flipCurrent journaling order: record THEN flip
    const cur = (() => { try { return JSON.parse(fs.readFileSync(jp, 'utf8')); } catch (_) { return []; } })();
    cur.push(g); fs.writeFileSync(jp, JSON.stringify(cur));
    try { fs.unlinkSync(L.current); } catch (_) { /* first iter */ }
    fs.symlinkSync(path.join(L.generations, g), L.current);
    gcOrphans(home, 'stable');
    const gens = fs.readdirSync(L.generations).filter((n) => !n.includes('.staging-'));
    assert.ok(gens.length <= 2, `after activation ${i}: ${gens.length} generations (must stay <= 2)`);
  }
  assert.deepStrictEqual(fs.readdirSync(L.generations).sort(), ['gen5', 'gen6']);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(jp, 'utf8')), ['gen5', 'gen6']);
});
