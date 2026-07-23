'use strict';
// Regressions for the Codex fix-confirmation findings (Crit1, I2, I4).
const test = require('node:test'); const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path'); const cp = require('child_process');
const { ensureRuntime } = require('../index');
const { layout } = require('../paths');
const { readDesired } = require('../desired');
const { neutralizeLegacyStableThenQuiesce } = require('../provision-helper');
const { installDispatcher } = require('../migrate');
const { emitRunSync } = require('../dispatchers');

const WT = path.join(__dirname, '..', '..', '..');
function bundleFor(version) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-')); fs.writeFileSync(path.join(d, 'VERSION'), `${version}\n`);
  return { repoRadarDir: path.join(WT, 'repo_radar'), launcher: path.join(WT, 'repo-radar'), versionFile: path.join(d, 'VERSION') };
}

test('fix regressions: fail-closed identity + verifier anchor + /tmp containment', { timeout: 300000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-reg-')); // /tmp -> /private/tmp: symlinked ancestor
  const L = layout(home, 'stable');
  assert.strictEqual((await ensureRuntime({ home, channel: 'stable', appVersion: '1.0.27', bundle: bundleFor('1.0.27'), _skipQuiesce: true })).status, 'ok');
  const gen = fs.realpathSync(L.current);

  // I2 + I4: swap the shipped verify.py -> run-sync.sh (a) passes the CANONICALIZED containment
  // check despite the /tmp symlink, then (b) rejects at the trusted shasum anchor with the
  // RIGHT reason before ever executing the swapped verifier.
  fs.writeFileSync(path.join(gen, 'verify.py'), 'import sys; sys.exit(0)\n');
  const out = cp.spawnSync('/bin/sh', [L.runSync], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.notStrictEqual(out.status, 0, 'swapped verifier is rejected');
  assert.match(out.stderr, /verifier hash mismatch/, 'rejected by the anchor (not "outside tree" -> containment passed)');

  // Crit1: reconcile with a mismatched bundled VERSION (authoritative identity fails) MUST
  // leave desired at PROVISIONING (fail-closed) rather than keep serving the prior ACTIVE runtime.
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-')); fs.writeFileSync(path.join(bad, 'VERSION'), '1.0.99\n');
  const r = await ensureRuntime({ home, channel: 'stable', appVersion: '1.0.27',
    bundle: { ...bundleFor('1.0.27'), versionFile: path.join(bad, 'VERSION') }, _skipQuiesce: true });
  assert.strictEqual(r.status, 'failed');
  assert.strictEqual(readDesired(L.desired).status, 'provisioning', 'identity failure -> fail-closed provisioning');
});

test('Crit1 bootstrap: identity failure with a seeded legacy launcher leaves nothing runnable', { timeout: 120000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-boot-'));
  // seed a 1.0.26 legacy launcher on PATH
  fs.mkdirSync(path.join(home, '.repo-radar'), { recursive: true });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.repo-radar', 'repo-radar'), '#!/bin/sh\necho legacy\n');
  fs.chmodSync(path.join(home, '.repo-radar', 'repo-radar'), 0o755);
  fs.symlinkSync(path.join(home, '.repo-radar', 'repo-radar'), path.join(home, '.local', 'bin', 'repo-radar'));
  // ...and the legacy LaunchAgent + wrapper (the plist here embeds the bundled resources path variant)
  fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
  fs.mkdirSync(path.join(home, '.config', 'repo-radar'), { recursive: true });
  const legacyPlist = path.join(home, 'Library', 'LaunchAgents', 'com.user.repo-radar.plist');
  fs.writeFileSync(legacyPlist, '<plist><string>/Applications/Repo Radar.app/Contents/Resources/resources/repo-radar</string></plist>');
  fs.writeFileSync(path.join(home, '.config', 'repo-radar', 'run-sync.sh'), '#!/bin/sh\n# legacy wrapper\n');

  // reconcile with a MISMATCHED bundled VERSION -> authoritative identity fails, but quiesce/
  // dispatcher-install/legacy-retire happen FIRST, so nothing legacy remains runnable.
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-')); fs.writeFileSync(path.join(bad, 'VERSION'), '9.9.9\n');
  const bundle = { repoRadarDir: path.join(WT, 'repo_radar'), launcher: path.join(WT, 'repo-radar'), versionFile: path.join(bad, 'VERSION') };
  const r = await ensureRuntime({ home, channel: 'stable', appVersion: '1.0.27', bundle, _skipQuiesce: true });
  assert.strictEqual(r.status, 'failed');
  const L = layout(home, 'stable');
  assert.strictEqual(readDesired(L.desired).status, 'provisioning', 'fail-closed');
  assert.ok(!fs.existsSync(path.join(home, '.repo-radar', 'repo-radar')), 'legacy launcher retired');
  assert.ok(!fs.existsSync(L.current), 'no active runtime');
  const cli = fs.readFileSync(path.join(home, '.local', 'bin', 'repo-radar'), 'utf8');
  assert.match(cli, /lockf|verify\.py|another sync/, 'PATH CLI is now the generic fail-closed dispatcher');
  // the legacy LaunchAgent + wrapper are durably disabled (can't reload at login)
  assert.ok(!fs.existsSync(legacyPlist), 'legacy plist disabled');
  assert.ok(fs.existsSync(`${legacyPlist}.legacy-disabled`), 'legacy plist moved aside');
  assert.ok(!fs.existsSync(path.join(home, '.config', 'repo-radar', 'run-sync.sh')), 'legacy wrapper disabled');
});

test('Imp2 round4: swapping a healthy generation verify.py forces replacement on reconcile', { timeout: 180000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-vtamper-'));
  const L = layout(home, 'stable');
  assert.strictEqual((await ensureRuntime({ home, channel: 'stable', appVersion: '1.0.27', bundle: bundleFor('1.0.27'), _skipQuiesce: true })).status, 'ok');
  const gen1 = fs.realpathSync(L.current);
  fs.writeFileSync(path.join(gen1, 'verify.py'), 'import sys; sys.exit(0)\n'); // swap the verifier, same bundle
  const r = await ensureRuntime({ home, channel: 'stable', appVersion: '1.0.27', bundle: bundleFor('1.0.27'), _skipQuiesce: true });
  assert.strictEqual(r.status, 'ok', r.reason);
  assert.notStrictEqual(fs.realpathSync(L.current), gen1, 'anchored full verify rejected the swap -> replacement generation');
});

test('Imp2: a corrupt venv on reconcile triggers a replacement generation', { timeout: 180000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-corrupt-'));
  const L = layout(home, 'stable');
  assert.strictEqual((await ensureRuntime({ home, channel: 'stable', appVersion: '1.0.27', bundle: bundleFor('1.0.27'), _skipQuiesce: true })).status, 'ok');
  const gen1 = fs.realpathSync(L.current);
  fs.rmSync(path.join(gen1, 'venv', 'bin', 'python'), { force: true }); // corrupt the venv
  const r = await ensureRuntime({ home, channel: 'stable', appVersion: '1.0.27', bundle: bundleFor('1.0.27'), _skipQuiesce: true });
  assert.strictEqual(r.status, 'ok', r.reason);
  assert.notStrictEqual(fs.realpathSync(L.current), gen1, 'reconcile flipped to a replacement generation');
});

test('Crit round8: every legacy entry point is neutralized BEFORE the quiescence scan', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-toctou-'));
  // seed a full 1.0.26 stable footprint: home launcher, legacy PATH CLI symlink, plist, wrapper
  fs.mkdirSync(path.join(home, '.repo-radar'), { recursive: true });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
  fs.mkdirSync(path.join(home, '.config', 'repo-radar'), { recursive: true });
  const legacyLauncher = path.join(home, '.repo-radar', 'repo-radar');
  fs.writeFileSync(legacyLauncher, '#!/bin/sh\necho legacy\n'); fs.chmodSync(legacyLauncher, 0o755);
  const pathCli = path.join(home, '.local', 'bin', 'repo-radar');
  fs.symlinkSync(legacyLauncher, pathCli); // legacy PATH CLI -> legacy launcher
  const plist = path.join(home, 'Library', 'LaunchAgents', 'com.user.repo-radar.plist');
  fs.writeFileSync(plist, '<plist/>');
  const wrapper = path.join(home, '.config', 'repo-radar', 'run-sync.sh');
  fs.writeFileSync(wrapper, '#!/bin/sh\n# legacy wrapper\n');

  // Inject a quiesce that captures the filesystem state AT the scan boundary — i.e. exactly what a
  // legacy CLI start attempted right then would reach. This is the TOCTOU that round-8 closes.
  let atScan = null;
  const quiesce = async ({ home: h }) => {
    atScan = {
      pathCli: fs.readFileSync(path.join(h, '.local', 'bin', 'repo-radar'), 'utf8'),
      legacyLauncherExists: fs.existsSync(path.join(h, '.repo-radar', 'repo-radar')),
      plistDisabled: fs.existsSync(`${plist}.legacy-disabled`),
      wrapperDisabled: !fs.existsSync(wrapper),
    };
    return { quiesced: true, reason: 'test scan' };
  };
  await neutralizeLegacyStableThenQuiesce({
    home,
    installDispatchers: () => { installDispatcher(home, 'stable'); emitRunSync(home, 'stable'); },
    skipQuiesce: false,
    quiesce,
  });
  // At the scan boundary every future legacy entry point is already closed, so an attempted legacy
  // CLI start reaches only the generic fail-closed dispatcher, never the old launcher.
  assert.match(atScan.pathCli, /lockf|verify\.py|another sync/, 'PATH CLI is the generic dispatcher at scan time');
  assert.strictEqual(atScan.legacyLauncherExists, false, 'legacy home launcher already retired at scan time');
  assert.ok(atScan.plistDisabled, 'legacy schedule plist already disabled at scan time');
  assert.ok(atScan.wrapperDisabled, 'legacy wrapper already disabled at scan time');
});

test('Imp round9: a failing installDispatchers still retires the launcher, disables the schedule, attempts quiesce, and rejects', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-neut-fail-'));
  fs.mkdirSync(path.join(home, '.repo-radar'), { recursive: true });
  fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
  fs.mkdirSync(path.join(home, '.config', 'repo-radar'), { recursive: true });
  const legacyLauncher = path.join(home, '.repo-radar', 'repo-radar');
  fs.writeFileSync(legacyLauncher, '#!/bin/sh\necho legacy\n');
  const plist = path.join(home, 'Library', 'LaunchAgents', 'com.user.repo-radar.plist');
  fs.writeFileSync(plist, '<plist/>');
  const wrapper = path.join(home, '.config', 'repo-radar', 'run-sync.sh');
  fs.writeFileSync(wrapper, '#!/bin/sh\n# legacy\n');

  let quiesceAttempted = false;
  const quiesce = async () => { quiesceAttempted = true; return { quiesced: true, reason: 'test' }; };
  await assert.rejects(
    neutralizeLegacyStableThenQuiesce({
      home,
      installDispatchers: () => { throw new Error('install boom'); },
      skipQuiesce: false,
      quiesce,
    }),
    /neutralization failed|install boom/,
    'a failed neutralization step still rejects (hard-block)'
  );
  // Even though installDispatchers threw, EVERY other safety action ran (best-effort neutralization):
  assert.ok(!fs.existsSync(legacyLauncher), 'legacy home launcher retired fail-closed (no live launcher)');
  assert.ok(fs.existsSync(`${plist}.legacy-disabled`), 'legacy schedule plist disabled');
  assert.ok(!fs.existsSync(wrapper), 'legacy wrapper disabled');
  assert.ok(quiesceAttempted, 'quiescence/bootout was still attempted despite the earlier failure');
});

test('Imp2 round5: stable schedule reconciled on the healthy fast path too (crash-recovery)', { timeout: 180000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-sched-'));
  let repoints = 0;
  const hooks = { repointSchedule: () => { repoints += 1; return { success: true }; } };
  const r1 = await ensureRuntime({ home, channel: 'stable', appVersion: '1.0.27', bundle: bundleFor('1.0.27'), hooks, _skipQuiesce: true });
  assert.strictEqual(r1.status, 'ok', r1.reason);
  assert.strictEqual(repoints, 1, 'repointed on the activation path');
  const r2 = await ensureRuntime({ home, channel: 'stable', appVersion: '1.0.27', bundle: bundleFor('1.0.27'), hooks, _skipQuiesce: true });
  assert.strictEqual(r2.status, 'ok');
  assert.strictEqual(repoints, 2, 'the healthy FAST PATH also repoints (self-heals a crash-after-flip)');
});
