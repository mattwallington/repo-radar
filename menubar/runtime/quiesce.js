'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { layout, cliPath } = require('./paths');
const { readDesired, isActive } = require('./desired');
const { verifyRuntime } = require('./activation');

function _defaultExec(cmd, args) {
  try { return { status: 0, out: cp.execFileSync(cmd, args, { encoding: 'utf8' }) }; }
  catch (e) { return { status: e.status == null ? 1 : e.status, out: (e.stdout || '') + (e.stderr || '') }; }
}

function _legacyProcessRunning(exec, home) {
  const legacyLauncher = path.join(home, '.repo-radar', 'repo-radar');
  const ps = exec('ps', ['-axo', 'command']);
  if (ps.status !== 0) return false;
  return ps.out.split('\n').some((l) => l.includes(legacyLauncher));
}

// STABLE-ONLY (spec §3.3): boot out the legacy 1.0.26 LaunchAgent, then verify the
// label is absent AND no legacy manual sync is running. Fail closed on timeout —
// the caller must NOT flip `current` if this returns {quiesced:false}.
async function quiesceLegacyStable({
  home, exec = _defaultExec, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  uid = process.getuid(), timeoutMs = 10000,
} = {}) {
  const label = 'com.user.repo-radar';
  exec('launchctl', ['bootout', `gui/${uid}/${label}`]); // idempotent; may already be gone
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const printed = exec('launchctl', ['print', `gui/${uid}/${label}`]);
    const labelGone = printed.status !== 0; // `print` fails when the label is absent
    if (labelGone && !_legacyProcessRunning(exec, home)) {
      return { quiesced: true, reason: 'label absent + no legacy process' };
    }
    if (Date.now() >= deadline) return { quiesced: false, reason: 'legacy job/process did not quiesce within timeout' };
    await sleep(200);
  }
}

// READ-ONLY (spec §3.3, Codex R5-3/I3): is stable provably *managed AND healthy*? Dev may
// share the data plane only when this is true. ANY legacy stable install/state, an
// incomplete managed footprint, or a runtime that doesn't verify means "unmanaged" ->
// dev must fail closed / isolate. Strong predicate, not just "a desired.json exists".
function detectStableManaged({ home, exec = _defaultExec } = {}) {
  const legacyLauncher = path.join(home, '.repo-radar', 'repo-radar');
  if (fs.existsSync(legacyLauncher)) return { managed: false, reason: 'legacy ~/.repo-radar/repo-radar present' };
  if (_legacyProcessRunning(exec, home)) return { managed: false, reason: 'a legacy stable process is running' };
  const L = layout(home, 'stable');
  // an unloaded-but-installed old stable can reload its own plist outside the root lock:
  // any stable LaunchAgent must point at the managed run-sync.sh (Codex round-4 §7b).
  const plist = path.join(home, 'Library', 'LaunchAgents', 'com.user.repo-radar.plist');
  if (fs.existsSync(plist)) {
    let content = '';
    try { content = fs.readFileSync(plist, 'utf8'); } catch (_) { /* */ }
    if (!content.includes(L.runSync)) return { managed: false, reason: 'an unmanaged stable LaunchAgent is installed' };
  }
  if (!fs.existsSync(cliPath(home, 'stable'))) return { managed: false, reason: 'no stable CLI dispatcher' };
  if (!fs.existsSync(L.runSync)) return { managed: false, reason: 'no stable run-sync dispatcher' };
  const desired = readDesired(L.desired);
  if (!isActive(desired)) return { managed: false, reason: 'stable desired is not ACTIVE' };
  let genDir;
  try { genDir = fs.realpathSync(L.current); } catch (e) { return { managed: false, reason: 'no stable current runtime' }; }
  if (!verifyRuntime({ home, channel: 'stable', genDir, desired }).ok) {
    return { managed: false, reason: 'stable runtime fails the healthy predicate' };
  }
  return { managed: true, reason: 'stable dispatcher + ACTIVE desired + healthy runtime' };
}

module.exports = { quiesceLegacyStable, detectStableManaged };
