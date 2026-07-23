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

// Extract the loaded job's first program argument from `launchctl print` output:
//   arguments = {\n\t\t0 => /path/to/run-sync.sh\n ...
function _loadedJobArg0(out) {
  const m = String(out || '').match(/arguments\s*=\s*\{[\s\S]*?\b0\s*=>\s*([^\n]+)/);
  return m ? m[1].trim() : null;
}

// A 1.0.26 sync may run the home launcher, the app's BUNDLED launcher, or the legacy
// wrapper — all must be detected (Codex round-7 Crit1), while the managed runtime (which
// runs .../.repo-radar/<channel>/current/repo-radar) must NOT match.
function _legacyProcessRunning(exec, home) {
  const ps = exec('ps', ['-axo', 'command']);
  if (ps.status !== 0) return false;
  const legacyLauncher = path.join(home, '.repo-radar', 'repo-radar'); // exactly this, not .../current/...
  const legacyWrapper = path.join(home, '.config', 'repo-radar', 'run-sync.sh');
  return ps.out.split('\n').some((l) =>
    l.includes(`${legacyLauncher} `) || l.endsWith(legacyLauncher) ||
    l.includes(legacyWrapper) ||
    /\/Contents\/Resources\/resources\/repo-radar(\s|$)/.test(l)
  );
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
function detectStableManaged({ home, exec = _defaultExec, appVersionPath = '/Applications/Repo Radar.app/Contents/Resources/VERSION' } = {}) {
  const legacyLauncher = path.join(home, '.repo-radar', 'repo-radar');
  if (fs.existsSync(legacyLauncher)) return { managed: false, reason: 'legacy ~/.repo-radar/repo-radar present' };
  if (_legacyProcessRunning(exec, home)) return { managed: false, reason: 'a legacy stable process is running' };
  const L = layout(home, 'stable');
  // an unloaded-but-installed old stable can reload its own plist outside the root lock.
  // Inspect the EXACT ProgramArguments[0] (raw, so the plutil `/`->`\/` json escaping can't
  // false-reject a valid plist) + the LOADED job's actual first argument (Codex round-7 §3.3).
  const plist = path.join(home, 'Library', 'LaunchAgents', 'com.user.repo-radar.plist');
  if (fs.existsSync(plist)) {
    let prog = null;
    try { prog = cp.execFileSync('/usr/bin/plutil', ['-extract', 'ProgramArguments.0', 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim(); } catch (_) { prog = null; }
    if (prog !== L.runSync) return { managed: false, reason: 'stable LaunchAgent does not launch the managed runner' };
  }
  const printed = exec('launchctl', ['print', `gui/${process.getuid()}/com.user.repo-radar`]);
  if (printed.status === 0) {
    if (_loadedJobArg0(printed.out) !== L.runSync) return { managed: false, reason: 'a stale stable job is loaded' };
  } else if (!/could not find/i.test(printed.out || '')) {
    return { managed: false, reason: 'cannot verify stable launchd state' }; // fail closed on ambiguous errors
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
  // an installed stable /Applications app must match the managed runtime version — a
  // rolled-back 1.0.26 app could otherwise launch later outside the lock (Codex round-7 §3.3).
  const appVer = appVersionPath;
  if (fs.existsSync(appVer)) {
    let av; try { av = fs.readFileSync(appVer, 'utf8').trim(); } catch (_) { return { managed: false, reason: 'cannot read installed stable app version' }; }
    let rv; try { rv = fs.readFileSync(path.join(genDir, 'VERSION'), 'utf8').trim(); } catch (_) { rv = null; }
    if (av !== rv) return { managed: false, reason: `installed stable app ${av} != managed runtime ${rv}` };
  }
  return { managed: true, reason: 'stable dispatcher + ACTIVE desired + healthy runtime + matching app' };
}

module.exports = { quiesceLegacyStable, detectStableManaged };
