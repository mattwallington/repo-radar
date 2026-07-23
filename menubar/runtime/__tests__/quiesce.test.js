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
  // inject a no-loaded-job launchctl stub so the check doesn't consult the real machine
  assert.strictEqual(detectStableManaged({ home, exec: () => ({ status: 1, out: '' }) }).managed, true);
});

test('detectStableManaged: false on a misleading plist or a stale loaded job (round-5 §3.3)', { timeout: 180000 }, async () => {
  const { ensureRuntime } = require('../index');
  const { detectStableManaged } = require('../quiesce');
  const WT = path.join(__dirname, '..', '..', '..');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-plist-'));
  const bd = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-')); fs.writeFileSync(path.join(bd, 'VERSION'), '1.0.27\n');
  const bundle = { repoRadarDir: path.join(WT, 'repo_radar'), launcher: path.join(WT, 'repo-radar'), versionFile: path.join(bd, 'VERSION') };
  await ensureRuntime({ home, channel: 'stable', appVersion: '1.0.27', bundle, _skipQuiesce: true });
  const L = layout(home, 'stable');
  const noJob = () => ({ status: 1, out: '' }); // launchctl print: no loaded job
  assert.strictEqual(detectStableManaged({ home, exec: noJob }).managed, true, 'managed baseline');

  // a MISLEADING plist: ProgramArguments launches a legacy binary, but the managed path is
  // mentioned only in an env var. plutil -extract must reject it (text search would pass).
  const plistDir = path.join(home, 'Library', 'LaunchAgents'); fs.mkdirSync(plistDir, { recursive: true });
  const plist = path.join(plistDir, 'com.user.repo-radar.plist');
  fs.writeFileSync(plist,
    '<?xml version="1.0"?><!DOCTYPE plist><plist version="1.0"><dict>' +
    '<key>ProgramArguments</key><array><string>/tmp/legacy-1.0.26</string></array>' +
    `<key>EnvironmentVariables</key><dict><key>NOTE</key><string>${L.runSync}</string></dict>` +
    '</dict></plist>');
  assert.strictEqual(detectStableManaged({ home, exec: noJob }).managed, false, 'misleading plist rejected');
  fs.rmSync(plist);

  // a STALE loaded job whose program is not the managed runner -> unmanaged
  const staleJob = () => ({ status: 0, out: 'program = /tmp/legacy-1.0.26\n' });
  assert.strictEqual(detectStableManaged({ home, exec: staleJob }).managed, false, 'stale loaded job rejected');
});
