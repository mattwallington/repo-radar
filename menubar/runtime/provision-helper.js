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
const { installDispatcher, retireLegacyLauncher, disableLegacySchedule } = require('./migrate');
const { quiesceLegacyStable } = require('./quiesce');
const { redact } = require('./hashing');

// STABLE legacy-bootstrap neutralization (Codex round-8 Crit + round-9 Imp). Neutralize EVERY
// future legacy entry point BEFORE proving already-running children have exited, so a new 1.0.26
// sync cannot start from ~/.local/bin/repo-radar or ~/.repo-radar/repo-radar in the window between
// the final scan and the retire (that child ignores the root lock and could overlap the flip).
// Two properties, both load-bearing:
//   (a) FAIL-CLOSED order: retire the HOME launcher FIRST (its PATH symlink then dangles = fail
//       closed) so a later installDispatchers() failure can never leave a LIVE legacy launcher —
//       the hard-block contract prefers a temporarily-dangling PATH entry over serving stale
//       Python. installDispatchers() then overwrites that symlink with the generic dispatcher.
//   (b) BEST EFFORT: attempt every neutralization even if one throws, so a single failed mutation
//       never skips the remaining safety actions (esp. the bootout/scan). Errors are collected and
//       raised AFTER, so the caller still fails closed (desired stays PROVISIONING).
// Moving an entry point doesn't hide an already-running child from ps (argv keeps the old path),
// so the scan stays authoritative for existing children while the retire/install/disable prevent
// new ones. `installDispatchers` is passed in so the shared every-activation install runs at the
// exact same point in production and in tests.
async function neutralizeLegacyStableThenQuiesce({ home, installDispatchers, skipQuiesce, quiesce = quiesceLegacyStable }) {
  const errors = [];
  const attempt = (label, fn) => { try { fn(); } catch (e) { errors.push(`${label}: ${e.message}`); } };
  attempt('disableLegacySchedule', () => disableLegacySchedule(home));
  attempt('retireLegacyLauncher', () => retireLegacyLauncher(home, { failClosed: true }));
  attempt('installDispatchers', () => installDispatchers());
  if (!skipQuiesce) {
    let q;
    try { q = await quiesce({ home }); }
    catch (e) { q = { quiesced: false, reason: e.message }; }
    if (!q.quiesced) errors.push(`quiesce: ${q.reason || 'not quiescent'}`);
  }
  if (errors.length) throw new Error(`legacy neutralization failed: ${errors.join('; ')}`);
}

async function main() {
  const args = JSON.parse(fs.readFileSync(0, 'utf8')); // stdin
  const { home, channel, appVersion, bundle, resultPath, skipQuiesce } = args;
  const L = layout(home, channel);
  const writeResult = (r) => { try { fs.writeFileSync(resultPath, JSON.stringify(r), { mode: 0o600 }); } catch (_) { /* */ } };
  try {
    // legacy bootstrap: no managed runtime has ever been activated for this channel.
    const legacyBootstrap = !fs.existsSync(L.current);
    // (Re)install the generic dispatchers on EVERY activation (Codex I2) so an app update
    // redeploys dispatcher fixes / schema changes, not only on first bootstrap.
    const installDispatchers = () => { installDispatcher(home, channel); emitRunSync(home, channel); };
    // On the 1.0.26 bootstrap path, neutralize the legacy runtime BEFORE the fallible identity
    // check (Codex Crit1) AND before proving children exited (Codex round-8 Crit): all future
    // entry points closed first, then quiesce. A subsequent identity failure leaves NOTHING
    // legacy runnable (desired stays PROVISIONING).
    if (legacyBootstrap && channel === 'stable') {
      await neutralizeLegacyStableThenQuiesce({ home, installDispatchers, skipQuiesce });
    } else {
      installDispatchers();
    }

    // NOW the fallible identity validation — legacy is already neutralized.
    const identity = authoritativeIdentity({ appVersion, bundledVersionPath: bundle.versionFile });
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
    flipCurrent(home, channel, genDir); // commit point (legacy already retired pre-identity)
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

// Spawned as `node provision-helper.js` in production (require.main === module); require()d by
// tests to exercise neutralizeLegacyStableThenQuiesce without running main()/reading stdin.
if (require.main === module) main();

module.exports = { neutralizeLegacyStableThenQuiesce };
