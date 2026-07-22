'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { layout } = require('./paths');
const { authoritativeIdentity } = require('./identity');
const { planGeneration, provision } = require('./provision');
const { SCHEMA, publishDesired, readDesired, schemaCompatible } = require('./desired');
const { verifyRuntime, flipCurrent, adopt, gcOrphans } = require('./activation');
const { emitRunSync } = require('./dispatchers');
const { installDispatcher, retireLegacyLauncher } = require('./migrate');
const { quiesceLegacyStable } = require('./quiesce');
const { withLock } = require('./lock');
const { redact } = require('./hashing');

function _desiredFor(channel, identity, plan) {
  return {
    schema: SCHEMA, channel, version: identity.version, genId: plan.genId,
    sourceSha: plan.expected.sourceSha, launcherSha: plan.expected.launcherSha,
    versionSha: plan.expected.versionSha, lockSha: plan.expected.lockSha,
  };
}

// Reconcile the channel runtime to the running build (spec §3.3). `quiesceFn` is
// injectable so tests never touch real launchctl. `hooks.onFailure(redactedMsg)`
// surfaces a hard-block; `hooks.repointSchedule()` re-points the stable LaunchAgent.
async function ensureRuntime({ home, channel, appVersion, bundle, hooks = {}, quiesceFn = quiesceLegacyStable }) {
  const L = layout(home, channel);
  let identity;
  try { identity = authoritativeIdentity({ appVersion, bundledVersionPath: bundle.versionFile }); }
  catch (e) { if (hooks.onFailure) hooks.onFailure(redact(String(e.message))); return { status: 'failed', reason: e.message }; }

  // Fast path: already healthy for THIS build -> no-op (no pip).
  const curDesired = readDesired(L.desired);
  if (curDesired && schemaCompatible(curDesired) && curDesired.version === identity.version) {
    try {
      const genDir = fs.realpathSync(L.current);
      if (verifyRuntime({ home, channel, genDir, desired: curDesired }).ok) return { status: 'ok', genDir };
    } catch (_) { /* no current yet -> fall through */ }
  }

  fs.mkdirSync(L.channelDir, { recursive: true, mode: 0o700 }); // lock file's dir must exist
  try {
    return await withLock(L.activationLock, 60, async () => {
      const legacyBootstrap = !fs.existsSync(L.desired);
      const plan = planGeneration({ identity, bundle });
      const desired = _desiredFor(channel, identity, plan);

      if (legacyBootstrap) {
        if (channel === 'stable') {
          const q = await quiesceFn({ home });
          if (!q.quiesced) throw new Error(`legacy not quiescent: ${q.reason}`);
        }
        installDispatcher(home, channel);
        emitRunSync(home, channel);
        if (hooks.repointSchedule && channel === 'stable') hooks.repointSchedule();
      }
      // Publish desired FIRST (managed update: the first fallible mutation; legacy:
      // the first activation-intent mutation). Runners fail closed until the flip.
      publishDesired(L.desired, desired);

      let genDir = adopt({ home, channel, desired }); // best-effort crash-retry reuse
      if (!genDir) genDir = provision({ home, channel, identity, bundle, logPath: L.provisionLog, plan }).genDir;

      const v = verifyRuntime({ home, channel, genDir, desired });
      if (!v.ok) throw new Error(`post-build verify failed: ${v.reasons.join('; ')}`);

      flipCurrent(home, channel, genDir); // commit point
      if (legacyBootstrap && channel === 'stable') retireLegacyLauncher(home);
      gcOrphans(home, channel);
      return { status: 'ok', genDir };
    });
  } catch (e) {
    if (hooks.onFailure) hooks.onFailure(redact(String(e.message)));
    return { status: 'failed', reason: e.message };
  }
}

// "Sync Now" runner: acquire the ROOT exec lock (-t 0), then resolve+verify current,
// then run the sync child holding the lock for its lifetime.
async function runSync({ home, channel }) {
  const L = layout(home, channel);
  fs.mkdirSync(L.root, { recursive: true, mode: 0o700 });
  return await withLock(L.execLock, 0, async () => {
    const desired = readDesired(L.desired);
    const genDir = fs.realpathSync(L.current);
    const v = verifyRuntime({ home, channel, genDir, desired });
    if (!v.ok) throw new Error(`runtime invalid: ${v.reasons.join('; ')}`);
    return await new Promise((resolve, reject) => {
      const child = spawn(
        path.join(genDir, 'venv', 'bin', 'python'),
        [path.join(genDir, 'repo-radar'), 'sync', '--status-server'],
        { env: { ...process.env, PYTHONPATH: genDir }, stdio: 'inherit' }
      );
      child.on('exit', (code) => resolve(code));
      child.on('error', reject);
    });
  });
}

module.exports = { ensureRuntime, runSync };
