'use strict';
// Regressions for the Codex fix-confirmation findings (Crit1, I2, I4).
const test = require('node:test'); const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path'); const cp = require('child_process');
const { ensureRuntime } = require('../index');
const { layout } = require('../paths');
const { readDesired } = require('../desired');

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
