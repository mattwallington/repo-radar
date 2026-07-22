'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { layout } = require('./paths');
const { readDesired, schemaCompatible } = require('./desired');

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

// READ-ONLY (spec §3.3, Codex R5-3): is stable provably *managed*? Dev may share the
// data plane only when this is true. ANY legacy stable install/state or ambiguity
// means "unmanaged" -> dev must fail closed / isolate.
function detectStableManaged({ home, exec = _defaultExec } = {}) {
  const legacyLauncher = path.join(home, '.repo-radar', 'repo-radar');
  if (fs.existsSync(legacyLauncher)) return { managed: false, reason: 'legacy ~/.repo-radar/repo-radar present' };
  const L = layout(home, 'stable');
  const desired = readDesired(L.desired);
  if (!desired || !schemaCompatible(desired)) return { managed: false, reason: 'no compatible stable desired.json' };
  try { fs.lstatSync(L.current); } catch (e) { return { managed: false, reason: 'no stable current symlink' }; }
  return { managed: true, reason: 'stable has compatible desired.json + current' };
}

module.exports = { quiesceLegacyStable, detectStableManaged };
