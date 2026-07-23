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
    if (cmd === 'launchctl' && args[0] === 'print') { printCalls++; return { status: printCalls >= 2 ? 1 : 0, out: printCalls >= 2 ? 'Could not find service "com.user.repo-radar" in domain for user gui: 501' : 'still loaded' }; }
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
    if (cmd === 'launchctl' && args[0] === 'print') return { status: 113, out: 'Could not find service' }; // label gone
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
  // inject stubs so the check doesn't consult the real machine: ps clean, launchctl no-job
  const stub = (cmd) => (cmd === 'ps' ? { status: 0, out: '' } : { status: 113, out: 'Could not find service' });
  assert.strictEqual(detectStableManaged({ home, exec: stub, appVersionPath: '/nonexistent/VERSION' }).managed, true);
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
  // stubs are cmd-aware: ps clean (no legacy) + the launchctl shape under test. detectStableManaged
  // now runs the tri-state process scan BEFORE launchctl, so a cmd-blind stub would fail the scan.
  const noJob = (cmd) => (cmd === 'ps' ? { status: 0, out: '' } : { status: 113, out: 'Could not find service' }); // no loaded job
  assert.strictEqual(detectStableManaged({ home, exec: noJob, appVersionPath: '/nonexistent/VERSION' }).managed, true, 'managed baseline');
  // a REAL macOS loaded-job shape (program = <path> + an arguments block with NO `0 =>` index)
  // whose program IS the managed runner must be ACCEPTED (round-7 §3 program-field parse).
  const validJob = (cmd) => (cmd === 'ps' ? { status: 0, out: '' } : { status: 0, out: `program = ${L.runSync}\narguments = {\n\t${L.runSync}\n}\n` });
  assert.strictEqual(detectStableManaged({ home, exec: validJob, appVersionPath: '/nonexistent/VERSION' }).managed, true, 'real program= managed job accepted');

  const plistDir = path.join(home, 'Library', 'LaunchAgents'); fs.mkdirSync(plistDir, { recursive: true });
  const plist = path.join(plistDir, 'com.user.repo-radar.plist');
  const plistHdr = '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>';
  // a VALID managed plist (ProgramArguments[0] == the managed runner) must be ACCEPTED —
  // regression for plutil's `/`->`\/` json escaping that had been false-rejecting it.
  fs.writeFileSync(plist, `${plistHdr}<key>ProgramArguments</key><array><string>${L.runSync}</string></array></dict></plist>`);
  assert.strictEqual(detectStableManaged({ home, exec: noJob, appVersionPath: '/nonexistent/VERSION' }).managed, true, 'valid managed plist accepted');

  // a MISLEADING plist: ProgramArguments launches a legacy binary, but the managed path is
  // mentioned only in an env var. plutil ProgramArguments.0 must reject it (text search would pass).
  fs.writeFileSync(plist, `${plistHdr}` +
    '<key>ProgramArguments</key><array><string>/tmp/legacy-1.0.26</string></array>' +
    `<key>EnvironmentVariables</key><dict><key>NOTE</key><string>${L.runSync}</string></dict>` +
    '</dict></plist>');
  assert.strictEqual(detectStableManaged({ home, exec: noJob, appVersionPath: '/nonexistent/VERSION' }).managed, false, 'misleading plist rejected');
  fs.rmSync(plist);

  // a STALE loaded job whose program is not the managed runner -> unmanaged (real macOS shape)
  const staleJob = (cmd) => (cmd === 'ps' ? { status: 0, out: '' } : { status: 0, out: 'program = /tmp/legacy-1.0.26\narguments = {\n\t/tmp/legacy-1.0.26\n}\n' });
  assert.strictEqual(detectStableManaged({ home, exec: staleJob, appVersionPath: '/nonexistent/VERSION' }).managed, false, 'stale loaded job rejected');
  // an ambiguous launchctl error (not "could not find") -> fail closed
  const ambiguous = (cmd) => (cmd === 'ps' ? { status: 0, out: '' } : { status: 5, out: 'Operation not permitted' });
  assert.strictEqual(detectStableManaged({ home, exec: ambiguous, appVersionPath: '/nonexistent/VERSION' }).managed, false, 'ambiguous launchctl error fails closed');
});

test('quiesceLegacyStable fails closed when a BUNDLED-path legacy sync is running (round-7 Crit1)', async () => {
  const home = '/tmp/rr-home-bundled';
  const exec = (cmd, args) => {
    if (cmd === 'launchctl' && args[0] === 'print') return { status: 113, out: 'Could not find' }; // label gone
    if (cmd === 'ps') return { status: 0, out: 'python3 /Applications/Repo Radar.app/Contents/Resources/resources/repo-radar sync --status-server\n' };
    return { status: 0, out: '' };
  };
  const r = await quiesceLegacyStable({ home, exec, sleep: fastSleep, uid: 501, timeoutMs: 300 });
  assert.strictEqual(r.quiesced, false, 'bundled-path legacy sync detected -> not quiescent');
});

// Codex round-7 §1: a FAILED diagnostic is not proof of safety. ps/launchctl errors must block.
test('quiesceLegacyStable fails closed when the process scan itself fails', async () => {
  const exec = (cmd, args) => {
    if (cmd === 'launchctl' && args[0] === 'print') return { status: 113, out: 'Could not find service' }; // label gone
    if (cmd === 'ps') return { status: 1, out: '' }; // ps failed -> cannot PROVE no legacy process
    return { status: 0, out: '' };
  };
  const r = await quiesceLegacyStable({ home: '/tmp/rr-psfail', exec, sleep: fastSleep, uid: 501, timeoutMs: 300 });
  assert.strictEqual(r.quiesced, false);
  assert.match(r.reason, /process scan failed/);
});

test('quiesceLegacyStable fails closed on an ambiguous launchctl print error (not "could not find")', async () => {
  const exec = (cmd, args) => {
    if (cmd === 'launchctl' && args[0] === 'print') return { status: 5, out: 'Operation not permitted' }; // NOT proof of absence
    if (cmd === 'ps') return { status: 0, out: '' };
    return { status: 0, out: '' };
  };
  const r = await quiesceLegacyStable({ home: '/tmp/rr-amb', exec, sleep: fastSleep, uid: 501, timeoutMs: 300 });
  assert.strictEqual(r.quiesced, false);
  assert.match(r.reason, /ambiguous/);
});

test('quiesceLegacyStable: an active legacy statusfile blocks quiescence, a stale one does not', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-sf-'));
  const sfDir = path.join(home, '.config', 'repo-radar'); fs.mkdirSync(sfDir, { recursive: true });
  const sf = path.join(sfDir, 'status.json');
  fs.writeFileSync(sf, JSON.stringify({ repos: [{ name: 'a/b', percent: 42 }] })); // in-flight, fresh mtime
  const exec = (cmd, args) => {
    if (cmd === 'launchctl' && args[0] === 'print') return { status: 113, out: 'Could not find service' }; // label gone
    if (cmd === 'ps') return { status: 0, out: '' }; // no legacy process
    return { status: 0, out: '' };
  };
  const active = await quiesceLegacyStable({ home, exec, sleep: fastSleep, uid: 501, timeoutMs: 300 });
  assert.strictEqual(active.quiesced, false, 'active statusfile blocks quiescence');
  assert.match(active.reason, /statusfile/);
  const old = Date.now() / 1000 - 3600; // backdate mtime past the recency window
  fs.utimesSync(sf, old, old);
  const stale = await quiesceLegacyStable({ home, exec, sleep: fastSleep, uid: 501, timeoutMs: 2000 });
  assert.strictEqual(stale.quiesced, true, 'stale statusfile does not block quiescence forever');
});

test('detectStableManaged fails closed when the process scan fails', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-psf-'));
  const exec = (cmd) => (cmd === 'ps' ? { status: 1, out: '' } : { status: 113, out: 'Could not find service' });
  const r = detectStableManaged({ home, exec, appVersionPath: '/nonexistent/VERSION' });
  assert.strictEqual(r.managed, false);
  assert.match(r.reason, /cannot scan/);
});

test('detectStableManaged: an active legacy statusfile means unmanaged; a stale one is not the gate', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-sfd-'));
  const sfDir = path.join(home, '.config', 'repo-radar'); fs.mkdirSync(sfDir, { recursive: true });
  const sf = path.join(sfDir, 'status.json');
  fs.writeFileSync(sf, JSON.stringify({ repos: [{ name: 'a/b', percent: 10 }] }));
  const exec = (cmd) => (cmd === 'ps' ? { status: 0, out: '' } : { status: 113, out: 'Could not find service' });
  const active = detectStableManaged({ home, exec, appVersionPath: '/nonexistent/VERSION' });
  assert.strictEqual(active.managed, false);
  assert.match(active.reason, /statusfile/);
  const old = Date.now() / 1000 - 3600; fs.utimesSync(sf, old, old);
  const stale = detectStableManaged({ home, exec, appVersionPath: '/nonexistent/VERSION' });
  assert.strictEqual(stale.managed, false, 'still unmanaged (no dispatcher), but for a LATER reason');
  assert.doesNotMatch(stale.reason, /statusfile/, 'stale statusfile no longer the gating reason');
});
