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

// Extract the loaded job's executable from `launchctl print` output. REAL macOS output is:
//   program = /path/to/run-sync.sh
//   arguments = {
//       /path/to/run-sync.sh
//   }
// There is NO `0 =>` index inside the arguments block — an earlier parser assumed one and so
// false-rejected every real loaded job (Codex round-7 §3). We compare the `program =` line,
// which launchd sets to ProgramArguments[0] for our plist.
function _loadedJobProgram(out) {
  const m = String(out || '').match(/^\s*program\s*=\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

// TRI-STATE process scan (Codex round-7 Crit1/§1). A 1.0.26 sync may run the home launcher,
// the app's BUNDLED launcher, or the legacy wrapper — all must be detected, while the managed
// runtime (.../.repo-radar/<channel>/current/repo-radar) must NOT match. A FAILED `ps` is NOT
// proof of "no legacy process": return {ok:false} so callers fail CLOSED instead of open.
function _legacyProcessScan(exec, home) {
  const ps = exec('ps', ['-axo', 'command']);
  if (ps.status !== 0) return { ok: false, running: false };
  const legacyLauncher = path.join(home, '.repo-radar', 'repo-radar'); // exactly this, not .../current/...
  const legacyWrapper = path.join(home, '.config', 'repo-radar', 'run-sync.sh');
  const running = ps.out.split('\n').some((l) =>
    l.includes(`${legacyLauncher} `) || l.endsWith(legacyLauncher) ||
    l.includes(legacyWrapper) ||
    /\/Contents\/Resources\/resources\/repo-radar(\s|$)/.test(l)
  );
  return { ok: true, running };
}

// Corroborating signal for an IN-FLIGHT legacy MANUAL sync (spec §3.3 "process scan + legacy
// statusfile"), used ONLY by quiescence — NOT by detectStableManaged, where the root lock +
// tri-state process scan + full-runtime checks are the safety contract (Codex round-8). The
// legacy ~/.config/repo-radar/status.json is written by the Electron status server as a RESULTS
// snapshot, so a COMPLETED sync also has a fresh mtime — and its metadata "no files" path can
// legitimately leave a repo < 100%. So recent+sub-100 ALONE would false-flag a normal
// completion as in-flight and (with quiescence's 10s timeout) fail an upgrade. We treat the file
// as in-flight only when it is being written well AFTER the last recorded completion (lastSync
// far from the final mtime, or no lastSync yet) AND still shows an unfinished repo. This never
// PROVES safety — it only ADDS a reason to fail closed alongside the authoritative process scan.
const STATUSFILE_ACTIVE_MS = 90 * 1000;
const STATUSFILE_COMPLETE_TOL_MS = 5 * 1000; // a 'complete' write sets lastSync ~= the final mtime
function _legacyStatusfileActive(home, now = Date.now()) {
  const sf = path.join(home, '.config', 'repo-radar', 'status.json');
  let st;
  try { st = fs.statSync(sf); }
  catch (e) { return !(e && e.code === 'ENOENT'); }           // ENOENT -> absent; other stat error -> fail closed
  if (now - st.mtimeMs > STATUSFILE_ACTIVE_MS) return false;  // stale -> not active
  let j;
  try { j = JSON.parse(fs.readFileSync(sf, 'utf8')); }
  catch (_) { return true; }                                  // recent + torn/unreadable write -> fail closed
  const lastSyncMs = j && typeof j.lastSync === 'string' ? Date.parse(j.lastSync) : NaN;
  // a COMPLETED snapshot: the last write IS (about) the completion write -> not in flight. Use an
  // ABSOLUTE delta (Codex round-9) so a bogus FUTURE lastSync (mtime - lastSync is large negative)
  // can't slip under an upper-bound-only check and be misclassified as idle; it stays in flight.
  if (Number.isFinite(lastSyncMs) && Math.abs(st.mtimeMs - lastSyncMs) <= STATUSFILE_COMPLETE_TOL_MS) return false;
  return Array.isArray(j.repos) && j.repos.some((r) => typeof r.percent === 'number' && r.percent < 100);
}

// STABLE-ONLY (spec §3.3): boot out the legacy 1.0.26 LaunchAgent, then verify the
// label is absent AND no legacy manual sync is running. Fail closed on timeout —
// the caller must NOT flip `current` if this returns {quiesced:false}.
async function quiesceLegacyStable({
  home, exec = _defaultExec, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  uid = process.getuid(), timeoutMs = 10000, now = () => Date.now(),
} = {}) {
  const label = 'com.user.repo-radar';
  exec('launchctl', ['bootout', `gui/${uid}/${label}`]); // idempotent; may already be gone
  const deadline = Date.now() + timeoutMs;
  // TRI-STATE proof (Codex round-7 §1): quiescence requires the label PROVABLY absent
  // (`print` fails with "could not find") AND a SUCCESSFUL process scan showing none AND an
  // idle legacy statusfile. Any ambiguous launchctl/ps failure (permission/transport) is NOT
  // proof of safety — it blocks and eventually fails closed WITHOUT flipping `current`.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const printed = exec('launchctl', ['print', `gui/${uid}/${label}`]);
    const labelGone = printed.status !== 0 && /could not find/i.test(printed.out || '');
    const scan = _legacyProcessScan(exec, home);
    const statusfileActive = _legacyStatusfileActive(home, now());
    if (labelGone && scan.ok && !scan.running && !statusfileActive) {
      return { quiesced: true, reason: 'label absent + no legacy process + statusfile idle' };
    }
    if (Date.now() >= deadline) {
      const why = printed.status === 0 ? 'legacy label still loaded'
        : !labelGone ? 'launchctl print ambiguous (fail closed)'
        : !scan.ok ? 'process scan failed (fail closed)'
        : scan.running ? 'legacy process still running'
        : 'legacy statusfile still active';
      return { quiesced: false, reason: `legacy job/process did not quiesce within timeout: ${why}` };
    }
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
  const scan = _legacyProcessScan(exec, home);
  if (!scan.ok) return { managed: false, reason: 'cannot scan for legacy processes (fail closed)' };
  if (scan.running) return { managed: false, reason: 'a legacy stable process is running' };
  // NOTE: no statusfile leg here (Codex round-8). status.json is a results snapshot, not a
  // lifecycle marker; the tri-state process scan above + the full-runtime checks below (under
  // the root lock) are the safety contract for "is stable managed". The statusfile's completed-
  // snapshot ambiguity belongs only in quiescence, where it corroborates the process scan.
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
    if (_loadedJobProgram(printed.out) !== L.runSync) return { managed: false, reason: 'a stale stable job is loaded' };
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
