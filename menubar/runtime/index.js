'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { layout } = require('./paths');
const { readDesired, publishDesired, isActive, PROVISIONING } = require('./desired');
const { selectFor } = require('./deps');
const { hashTree, hashFile, redact } = require('./hashing');

const HELPER = path.join(__dirname, 'provision-helper.js');

// Cheap CANDIDATE filter (Codex I6): does `current` even claim to be this bundle's ACTIVE
// runtime? File hashes only — NO interpreter probe / pip list (non-blocking on the Electron
// main loop). A pass here does NOT mean healthy; it just avoids a needless full verify.
function _fastCandidate(home, channel, appVersion, bundle) {
  const L = layout(home, channel);
  const desired = readDesired(L.desired);
  if (!isActive(desired) || desired.version !== appVersion) return false;
  let genDir;
  try { genDir = fs.realpathSync(L.current); } catch (_) { return false; }
  let marker;
  try { marker = JSON.parse(fs.readFileSync(path.join(genDir, '.runtime.json'), 'utf8')); } catch (_) { return false; }
  try {
    if (marker.sourceSha !== hashTree(bundle.repoRadarDir)) return false;
    if (marker.launcherSha !== hashFile(bundle.launcher)) return false;
    if (marker.versionSha !== hashFile(bundle.versionFile)) return false;
    const { lockPath } = selectFor(marker.fingerprint);
    if (marker.lockSha !== hashFile(lockPath)) return false;
  } catch (_) { return false; }
  return true;
}

// Run the FULL healthy predicate on `current` asynchronously via the shipped verify.py
// (Codex I6/I2): live payload + fingerprint + ABI + installed-set + pip check. Catches a
// corrupt/deleted venv, tampered payload, etc. — anything the cheap filter can't. Async
// spawn keeps the Electron main loop responsive.
function _fullVerifyCurrent(home, channel) {
  const L = layout(home, channel);
  return new Promise((resolve) => {
    let genDir;
    try { genDir = fs.realpathSync(L.current); } catch (_) { return resolve(false); }
    const desired = readDesired(L.desired);
    if (!isActive(desired)) return resolve(false);
    // ANCHOR the generation-controlled verify.py + manifest against the app-published
    // desired.json (trusted Node hashFile) BEFORE executing verify.py (Codex round-4 I2) —
    // a swapped verifier hashes differently and fails here, forcing reconcile.
    try {
      if (hashFile(path.join(genDir, 'verify.py')) !== desired.verifySha) return resolve(false);
      if (hashFile(path.join(genDir, 'manifest.json')) !== desired.manifestSha) return resolve(false);
    } catch (_) { return resolve(false); }
    const py = path.join(genDir, 'venv', 'bin', 'python');
    const child = spawn(py, [path.join(genDir, 'verify.py'), genDir, L.desired, path.join(genDir, 'manifest.json')], { stdio: 'ignore' });
    child.on('error', () => resolve(false)); // e.g. python missing
    child.on('exit', (code) => resolve(code === 0));
  });
}

// Spawn the lock-owning activation helper. A wrapping /bin/sh acquires the ROOT then
// CHANNEL locks (fd 8, fd 9) and `exec`s the node helper, which INHERITS both fds and
// OWNS the locks for its lifetime (kernel releases on its death) — Electron never holds
// the lock and stays responsive (async spawn). Result comes back via a file.
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
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
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
// fail-closed PROVISIONING intent BEFORE any fallible identity/interpreter/dependency
// validation (Codex Crit1) — so an identity/interpreter failure on the new build can
// never leave the previous ACTIVE runtime servable. Authoritative identity + the whole
// activation run inside the lock-owning helper. `_skipQuiesce` is test-only.
async function ensureRuntime({ home, channel, appVersion, bundle, hooks = {}, _skipQuiesce = false }) {
  const L = layout(home, channel);
  // cheap candidate filter, then confirm with the FULL predicate (async) before no-op'ing
  if (_fastCandidate(home, channel, appVersion, bundle) && (await _fullVerifyCurrent(home, channel))) {
    return { status: 'ok' };
  }

  fs.mkdirSync(L.channelDir, { recursive: true, mode: 0o700 });
  publishDesired(L.desired, { channel, version: appVersion, status: PROVISIONING });

  const res = await _runActivationHelper({ home, channel, appVersion, bundle, skipQuiesce: _skipQuiesce });
  if (res.status === 'ok') { if (channel === 'stable' && hooks.repointSchedule) hooks.repointSchedule(); }
  else if (hooks.onFailure) hooks.onFailure(redact(String(res.reason || 'provision failed')));
  return res;
}

// "Sync Now" runner: spawn the channel's generic run-sync.sh so the exec'd Python worker
// OWNS the inherited lock fd (Codex C1). `onChild` fires ONLY after the script signals
// (fd 3) that it acquired the lock (Codex I5) — so a busy contention (exit 75 before the
// handshake) rejects cleanly without ever being exposed as the active sync.
function runSync({ home, channel, env = {}, onChild } = {}) {
  const L = layout(home, channel);
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', [L.runSync], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'], // fd 3 = lock-acquired handshake
    });
    let started = false;
    const start = () => { if (!started) { started = true; if (typeof onChild === 'function') onChild(child); } };
    if (child.stdio[3]) child.stdio[3].on('data', start);
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!started && code === 75) { const e = new Error('another sync is already running'); e.code = 75; return reject(e); }
      start(); // exited without a handshake (e.g. no active runtime, exit 1) — expose it, then report the code
      resolve(code);
    });
  });
}

module.exports = { ensureRuntime, runSync };
