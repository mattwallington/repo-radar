'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { layout } = require('./paths');
const { authoritativeIdentity } = require('./identity');
const { readDesired, publishDesired, isActive, PROVISIONING } = require('./desired');
const { verifyRuntime } = require('./activation');
const { selectFor } = require('./deps');
const { hashTree, hashFile, redact } = require('./hashing');

const HELPER = path.join(__dirname, 'provision-helper.js');

// Fast path: current is a compatible ACTIVE runtime whose recorded hashes match THIS
// bundle (all bundle hashes, not just version — Codex C2). Cheap: no interpreter build.
function _fastHealthy(home, channel, identity, bundle) {
  const L = layout(home, channel);
  const desired = readDesired(L.desired);
  if (!isActive(desired) || desired.version !== identity.version) return false;
  let genDir;
  try { genDir = fs.realpathSync(L.current); } catch (_) { return false; }
  const markerPath = path.join(genDir, '.runtime.json');
  let marker;
  try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch (_) { return false; }
  try {
    if (marker.sourceSha !== hashTree(bundle.repoRadarDir)) return false;
    if (marker.launcherSha !== hashFile(bundle.launcher)) return false;
    if (marker.versionSha !== hashFile(bundle.versionFile)) return false;
    // the bundled lock for the marker's env must be unchanged
    const { lockPath } = selectFor(marker.fingerprint);
    if (marker.lockSha !== hashFile(lockPath)) return false;
  } catch (_) { return false; }
  return verifyRuntime({ home, channel, genDir, desired }).ok;
}

// Spawn the lock-owning activation helper. A wrapping /bin/sh acquires the ROOT then
// CHANNEL locks (fd 8, fd 9) and `exec`s the node helper, which INHERITS both fds and
// thus OWNS the locks for its lifetime (kernel releases on its death) — Electron never
// holds the lock and stays responsive (async spawn). Result comes back via a file.
function _runActivationHelper({ home, channel, appVersion, bundle, skipQuiesce }) {
  const L = layout(home, channel);
  const resultPath = path.join(L.channelDir, `.activation-result-${process.pid}.json`);
  const args = JSON.stringify({ home, channel, appVersion, bundle, resultPath, skipQuiesce: !!skipQuiesce });
  const sh =
    `exec 8>"${L.execLock}"; /usr/bin/lockf -t 300 8 || exit 75; ` +
    `exec 9>"${L.activationLock}"; /usr/bin/lockf -t 300 9 || exit 75; ` +
    `exec "${process.execPath}" "${HELPER}"`;
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', sh], {
      stdio: ['pipe', 'inherit', 'inherit'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, // run Electron's binary as node
    });
    child.stdin.write(args);
    child.stdin.end();
    child.on('error', (e) => resolve({ status: 'failed', reason: e.message }));
    child.on('exit', (code) => {
      let res;
      try { res = JSON.parse(fs.readFileSync(resultPath, 'utf8')); }
      catch (_) { res = { status: 'failed', reason: code === 75 ? 'activation lock busy' : `helper exit ${code}` }; }
      try { fs.unlinkSync(resultPath); } catch (_) { /* best effort */ }
      resolve(res);
    });
  });
}

// Reconcile the channel runtime to the running build (spec §3.3). Publishes a
// fail-closed PROVISIONING intent BEFORE interpreter/dependency selection can fail,
// then delegates the locked activation to the helper. `hooks.onFailure(msg)` /
// `hooks.repointSchedule()` are optional. `_skipQuiesce` is test-only.
async function ensureRuntime({ home, channel, appVersion, bundle, hooks = {}, _skipQuiesce = false }) {
  const L = layout(home, channel);
  let identity;
  try { identity = authoritativeIdentity({ appVersion, bundledVersionPath: bundle.versionFile }); }
  catch (e) { if (hooks.onFailure) hooks.onFailure(redact(String(e.message))); return { status: 'failed', reason: e.message }; }

  if (_fastHealthy(home, channel, identity, bundle)) return { status: 'ok' };

  fs.mkdirSync(L.channelDir, { recursive: true, mode: 0o700 });
  // fail-closed intent: no active runtime until the helper publishes ACTIVE + flips.
  publishDesired(L.desired, { channel, version: identity.version, status: PROVISIONING });

  const res = await _runActivationHelper({ home, channel, appVersion, bundle, skipQuiesce: _skipQuiesce });
  if (res.status === 'ok') { if (channel === 'stable' && hooks.repointSchedule) hooks.repointSchedule(); }
  else if (hooks.onFailure) hooks.onFailure(redact(String(res.reason || 'provision failed')));
  return res;
}

// "Sync Now" runner: spawn the channel's generic run-sync.sh so the exec'd Python
// worker OWNS the inherited lock fd (Codex C1) — the lock lives exactly as long as the
// worker, surviving an Electron crash. `env` (API keys/AI_MODEL/status port) is passed
// through; `onChild` hands back the process (PID preserved across the script's exec).
function runSync({ home, channel, env = {}, onChild } = {}) {
  const L = layout(home, channel);
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', [L.runSync], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (typeof onChild === 'function') onChild(child);
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 75) { const e = new Error('another sync is already running'); e.code = 75; return reject(e); }
      resolve(code);
    });
  });
}

module.exports = { ensureRuntime, runSync };
