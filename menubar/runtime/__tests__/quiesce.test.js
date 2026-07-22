'use strict';
const test = require('node:test'); const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
const { quiesceLegacyStable, detectStableManaged } = require('../quiesce');
const { layout } = require('../paths');
const { publishDesired } = require('../desired');

const fastSleep = () => Promise.resolve();

test('quiesceLegacyStable succeeds when the label clears and no legacy process runs', async () => {
  let printCalls = 0;
  const exec = (cmd, args) => {
    if (cmd === 'launchctl' && args[0] === 'bootout') return { status: 0, out: '' };
    if (cmd === 'launchctl' && args[0] === 'print') { printCalls++; return { status: printCalls >= 2 ? 1 : 0, out: '' }; }
    if (cmd === 'ps') return { status: 0, out: '/Applications/Foo.app/bar\n/usr/bin/whatever' };
    return { status: 1, out: '' };
  };
  const r = await quiesceLegacyStable({ home: '/tmp/x', exec, sleep: fastSleep, uid: 501, timeoutMs: 2000 });
  assert.strictEqual(r.quiesced, true);
});

test('quiesceLegacyStable fails closed when the label never clears', async () => {
  const exec = (cmd, args) => {
    if (cmd === 'launchctl' && args[0] === 'print') return { status: 0, out: 'still loaded' }; // present forever
    return { status: 0, out: '' };
  };
  const r = await quiesceLegacyStable({ home: '/tmp/x', exec, sleep: fastSleep, uid: 501, timeoutMs: 300 });
  assert.strictEqual(r.quiesced, false);
});

test('quiesceLegacyStable fails closed when a legacy manual sync is still running', async () => {
  const home = '/tmp/rr-home-legacy';
  const legacy = path.join(home, '.repo-radar', 'repo-radar');
  const exec = (cmd, args) => {
    if (cmd === 'launchctl' && args[0] === 'print') return { status: 1, out: '' }; // label gone
    if (cmd === 'ps') return { status: 0, out: `python3 ${legacy} sync --status-server\n` }; // legacy proc alive
    return { status: 0, out: '' };
  };
  const r = await quiesceLegacyStable({ home, exec, sleep: fastSleep, uid: 501, timeoutMs: 300 });
  assert.strictEqual(r.quiesced, false);
});

test('detectStableManaged: false on legacy / incomplete / unhealthy state', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-mgd-'));
  // legacy launcher present -> unmanaged
  fs.mkdirSync(path.join(home, '.repo-radar'), { recursive: true });
  fs.writeFileSync(path.join(home, '.repo-radar', 'repo-radar'), '#legacy');
  assert.strictEqual(detectStableManaged({ home }).managed, false);
  // remove legacy, but no dispatcher / no ACTIVE desired / no healthy runtime -> still unmanaged
  fs.rmSync(path.join(home, '.repo-radar', 'repo-radar'));
  assert.strictEqual(detectStableManaged({ home }).managed, false);
  // a fake current + non-active desired is NOT enough (fails the strong predicate)
  const L = layout(home, 'stable');
  fs.mkdirSync(L.generations, { recursive: true });
  const g = path.join(L.generations, 'g1'); fs.mkdirSync(g);
  fs.symlinkSync(g, L.current);
  publishDesired(L.desired, { channel: 'stable', version: '1.0.27', genId: 'g1', status: 'provisioning' });
  assert.strictEqual(detectStableManaged({ home }).managed, false);
});

test('detectStableManaged: true only after a real managed+healthy stable bootstrap', { timeout: 180000 }, async () => {
  const { ensureRuntime } = require('../index');
  const WT = path.join(__dirname, '..', '..', '..');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-mgd-ok-'));
  const bd = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-')); fs.writeFileSync(path.join(bd, 'VERSION'), '1.0.27\n');
  const bundle = { repoRadarDir: path.join(WT, 'repo_radar'), launcher: path.join(WT, 'repo-radar'), versionFile: path.join(bd, 'VERSION') };
  const r = await ensureRuntime({ home, channel: 'stable', appVersion: '1.0.27', bundle, _skipQuiesce: true });
  assert.strictEqual(r.status, 'ok', r.reason);
  assert.strictEqual(detectStableManaged({ home }).managed, true);
});
