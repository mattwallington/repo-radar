'use strict';
// Lock-owning activation helper (Codex C1/I4). Invoked by index.js via:
//   sh -c 'exec 8>root.lock; lockf -t N 8; exec 9>channel.lock; lockf -t N 9; exec node THIS'
// so THIS node process INHERITS fds 8 (root exec) + 9 (channel activation) and OWNS both
// locks for its lifetime — the kernel releases them when it exits/dies, so a crashed
// Electron can never orphan a half-done activation. Args arrive as JSON on stdin.
const fs = require('fs');
const { layout } = require('./paths');
const { authoritativeIdentity } = require('./identity');
const { planGeneration, provision } = require('./provision');
const { SCHEMA, ACTIVE, publishDesired } = require('./desired');
const { verifyRuntime, flipCurrent, adopt, gcOrphans } = require('./activation');
const { emitRunSync } = require('./dispatchers');
const { installDispatcher, retireLegacyLauncher } = require('./migrate');
const { quiesceLegacyStable } = require('./quiesce');
const { redact } = require('./hashing');

async function main() {
  const args = JSON.parse(fs.readFileSync(0, 'utf8')); // stdin
  const { home, channel, appVersion, bundle, resultPath, skipQuiesce } = args;
  const L = layout(home, channel);
  const writeResult = (r) => { try { fs.writeFileSync(resultPath, JSON.stringify(r), { mode: 0o600 }); } catch (_) { /* */ } };
  try {
    const identity = authoritativeIdentity({ appVersion, bundledVersionPath: bundle.versionFile });

    // legacy bootstrap: no managed runtime has ever been activated for this channel.
    const legacyBootstrap = !fs.existsSync(L.current);
    if (legacyBootstrap && channel === 'stable' && !skipQuiesce) {
      const q = await quiesceLegacyStable({ home });
      if (!q.quiesced) throw new Error(`legacy not quiescent: ${q.reason}`);
    }
    // (Re)install the generic dispatchers on EVERY activation (Codex I2) so an app update
    // redeploys dispatcher fixes / schema changes, not only on first bootstrap.
    installDispatcher(home, channel);
    emitRunSync(home, channel);

    const plan = planGeneration({ identity, bundle });
    const active = {
      schema: SCHEMA, channel, version: identity.version, status: ACTIVE, genId: plan.genId,
      sourceSha: plan.expected.sourceSha, launcherSha: plan.expected.launcherSha,
      versionSha: plan.expected.versionSha, lockSha: plan.expected.lockSha,
      verifySha: plan.expected.verifySha, manifestSha: plan.expected.manifestSha,
    };

    let genDir = adopt({ home, channel, desired: active });
    if (!genDir) genDir = provision({ home, channel, identity, bundle, logPath: L.provisionLog, plan }).genDir;

    const v = verifyRuntime({ home, channel, genDir, desired: active });
    if (!v.ok) throw new Error(`post-build verify failed: ${v.reasons.join('; ')}`);

    // publish the complete ACTIVE identity BEFORE the atomic flip; until the flip,
    // current.marker.genId != active.genId, so dispatchers stay fail-closed.
    publishDesired(L.desired, active);
    flipCurrent(home, channel, genDir); // commit point
    if (legacyBootstrap && channel === 'stable') retireLegacyLauncher(home);
    gcOrphans(home, channel);
    writeResult({ status: 'ok', genDir });
    process.exit(0);
  } catch (e) {
    // desired stays at PROVISIONING (published by the parent) -> all entry points closed.
    try { fs.appendFileSync(L.provisionLog, redact(`[helper] ${e.stack || e.message}\n`), { mode: 0o600 }); } catch (_) { /* */ }
    writeResult({ status: 'failed', reason: e.message });
    process.exit(1);
  }
}

main();
