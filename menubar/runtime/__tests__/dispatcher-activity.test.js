'use strict';
// Task 2.4: the dispatcher carries the activity lease (mint-or-inherit), delegates identity
// establishment to Python (bootstrap before the dev/verify guards; finalize on guard-failure/
// root-contention), and last-resorts to the System diagnostic stream when even that can't run.
//
// Fix round 1 (Ruling 13): the ENTIRE activity lifecycle was scoped to the sync runner only,
// via `_script(channel, tail, { withActivity })` -- `emitRunSync` true, `emitCliDispatcher`
// false (omitted at GENERATION time).
//
// Fix-A (Codex Phase-2 gate, Rulings 16/B1 + 17/B2) revises that design:
//  B1(a) -- the durable `start` (bootstrap) now runs BEFORE the root `.exec.lock`
//    acquisition, not after it, so a root-contention loser always has a real `start` to
//    finalize `skipped` against.
//  B1(b) -- `withActivity` is replaced by `activityGate` ('always' | 'cli') plus a RUNTIME
//    `_ACT_ON` variable: the activity SOURCE is now always present in both generated scripts,
//    but every step is wrapped in `if [ -n "${_ACT_ON:-}" ]; then ... fi`. `emitRunSync`
//    hardcodes `_ACT_ON=1` (its tail is the literal `sync` subcommand). `emitCliDispatcher`
//    sets it only when the CALLER's own `$1` is literally `sync`, so `repo-radar sync` now
//    gets identity-before-gates too, while every other subcommand still runs none of it.
//  B2 -- the mint block now refuses a symlinked activity root (or any ancestor down to
//    `$HOME/Library/Logs`) via a `test -L` walk, BEFORE creating anything under it.
//
// Three layers:
//  (1) STRING-LEVEL assertions on the generated `_script()` text (fast, exact wording/ordering).
//  (2) `activityGate` SCOPING assertions: both `_script()` renderings (raw flag and real
//      emitter) now carry the SAME activity source; only the `_ACT_ON`-setting prelude differs.
//      A REAL-PROCESS runtime comparison proves a non-sync CLI invocation is byte-identical
//      (status/stdout/stderr) to the pre-activity script, and a `sync` CLI invocation runs the
//      full lifecycle exactly like the scheduled runner.
//  (3) A REAL-PROCESS integration that spawns the actual generated script against a STUB `python`
//      planted at the resolved generation's `venv/bin/python` (the dispatcher never searches
//      PATH for python -- it always uses the anchored `$GEN/venv/bin/python`), so the assertions
//      prove the ordering EXECUTES, not merely that the right substrings appear in the source.
//
// What's deferred to later tasks: the stub python never really adopts fd 4 or writes activity
// records (that's repo_radar.activity.bootstrap/finalize, already covered by
// repo_radar/tests/test_activity_entrypoints.py) and the exec'd sync worker never really becomes
// cli.py/sync_mode (Tasks 2.5/2.6 -- already built and covered elsewhere; Task 2.7 covers the
// real cross-process chain). This file proves the SHELL's own ordering/branching/env/fd/scoping
// plumbing only.
const test = require('node:test'); const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const cp = require('child_process');
const { _script, emitRunSync, emitCliDispatcher } = require('../dispatchers');
const { runSync } = require('../index');
const { layout, cliPath } = require('../paths');
const { withLock } = require('../lock');

// ---------------------------------------------------------------------------------------------
// Layer 1: string-level assertions on the generated script (sync runner: activityGate: 'always')
// ---------------------------------------------------------------------------------------------

test('scheduled script: bootstrap precedes verify; finalize handles block AND skipped', () => {
  const s = _script('stable', ' sync --status-server', { activityGate: 'always' });
  const iBootstrap = s.indexOf('activity.bootstrap');
  const iVerify = s.indexOf('verify.py');
  assert.ok(iBootstrap > 0 && iVerify > 0 && iBootstrap < iVerify, 'bootstrap precedes verify');
  assert.ok(/activity\.finalize[^\n]*--outcome[= ]blocked/.test(s), 'blocked on guard failure');
  assert.ok(/activity\.finalize[^\n]*--outcome[= ]skipped/.test(s), 'skipped on root contention');
  assert.ok(s.includes('REPO_RADAR_ACTIVITY_ID'), 'exports identity');
});

test('Fix-A/B1(a): scheduled script -- durable start (bootstrap) precedes the root .exec.lock acquisition, and the fd-3 handshake still stays AFTER the root-lock (unchanged)', () => {
  const s = _script('stable', ' sync --status-server', { activityGate: 'always' });
  const iBootstrap = s.indexOf('activity.bootstrap');
  const iRootLock = s.indexOf('exec 9>"$ROOT/.exec.lock"');
  const iHandshake = s.indexOf("printf 'L' >&3");
  assert.ok(iBootstrap > 0 && iRootLock > 0 && iHandshake > 0, 'all three present');
  assert.ok(iBootstrap < iRootLock, 'a root-contention loser now has a real durable start to finalize skipped against');
  assert.ok(iRootLock < iHandshake, 'the fd-3 lock-acquired handshake still fires only AFTER the root-lock');
});

test('last-resort writes to the System stream, not an activity segment', () => {
  const s = _script('stable', ' sync --status-server', { activityGate: 'always' });
  assert.ok(s.includes('sync.error.log'), 'last-resort goes to System diagnostics');
  assert.ok(!/activity\/[^\n]*\.jsonl/.test(s.split('last-resort')[1] || ''),
            'last-resort never appends an activity segment');
});

test('mint-or-inherit: identity export is gated on identity being absent; bootstrap and contention-finalize are both gated on `_ACT_ON && _ACT_MINTED` (never on the inherited/manual path)', () => {
  const s = _script('stable', ' sync --status-server', { activityGate: 'always' });
  assert.match(s, /if \[ -z "\$\{REPO_RADAR_ACTIVITY_ID:-\}" \]; then/, 'mint only when identity is absent');
  assert.match(s, /_ACT_MINTED=1/, 'mint sets the scheduled-path marker');
  const bootstrapBlock = s.slice(s.indexOf('activity.bootstrap') - 200, s.indexOf('activity.bootstrap'));
  assert.match(bootstrapBlock, /if \[ -n "\$\{_ACT_ON:-\}" \] && \[ -n "\$_ACT_MINTED" \]; then/, 'bootstrap gated on _ACT_ON && _ACT_MINTED');
  const contentionBlock = s.slice(s.indexOf('another sync is running') - 400, s.indexOf('another sync is running'));
  assert.match(contentionBlock, /if \[ -n "\$\{_ACT_ON:-\}" \] && \[ -n "\$_ACT_MINTED" \]; then/, 'contention-finalize gated on _ACT_ON && _ACT_MINTED');
});

test('devGuard is untouched: exact original guard messages and fd-9/fd-3 handshakes survive verbatim', () => {
  const s = _script('dev', ' sync --status-server', { activityGate: 'always' });
  assert.match(s, /exec 9>"\$ROOT\/\.exec\.lock"/);
  assert.match(s, /\{ printf 'L' >&3; \} 2>\/dev\/null \|\| true/);
  assert.match(s, /repo-radar-dev: legacy stable install present; run dev in an isolated HOME/);
  assert.match(s, /repo-radar-dev: stable runtime is not healthy; run dev in an isolated HOME/);
  assert.match(s, /exec "\$GEN\/venv\/bin\/python" "\$GEN\/repo-radar" sync --status-server "\$@"/);
});

// ---------------------------------------------------------------------------------------------
// Layer 2: activityGate scoping -- the bug this fix round (Fix-A/B1b) closes. Both the sync
// runner (emitRunSync) AND the generic CLI dispatcher (emitCliDispatcher, tail='') now ALWAYS
// carry the full activity source; only the `_ACT_ON`-setting prelude differs (hardcoded-on vs
// gated on the caller's own `$1`). A real-process runtime comparison proves the CLI dispatcher's
// behavior for a non-sync invocation is unchanged from the pre-activity script.
// ---------------------------------------------------------------------------------------------

test('both _script() renderings now ALWAYS emit the activity source (Fix-A/B1b): only the _ACT_ON gate-setting prelude differs', () => {
  const runSyncScript = _script('stable', ' sync --status-server', { activityGate: 'always' });
  const cliScript = _script('stable', '', { activityGate: 'cli' });
  for (const [label, s] of [['run-sync', runSyncScript], ['cli', cliScript]]) {
    assert.ok(s.includes('activity.bootstrap'), `${label}: bootstrap source present`);
    assert.ok(s.includes('--kind sync'), `${label}: --kind sync present`);
    assert.ok(s.includes('_act_guard_blocked'), `${label}: guard-blocked trap present`);
    assert.ok(s.includes('activity.finalize'), `${label}: finalize present`);
    assert.ok(s.includes('sync.error.log'), `${label}: last-resort present`);
    assert.ok(s.includes('REPO_RADAR_ACTIVITY_ID'), `${label}: identity export/check present`);
  }
  assert.match(runSyncScript, /^_ACT_ON=1$/m, 'run-sync hardcodes _ACT_ON on -- no $1 worth inspecting');
  assert.ok(!runSyncScript.includes('${1:-}'), 'run-sync never inspects $1 for the gate');
  assert.match(cliScript, /if \[ "\$\{1:-\}" = sync \]; then _ACT_ON=1; fi/, "cli gates _ACT_ON on the caller's own $1");
});

test('_script default (no options object at all): activityGate defaults to "cli" (the sync-gated, safer default)', () => {
  assert.match(_script('stable', ''), /if \[ "\$\{1:-\}" = sync \]; then _ACT_ON=1; fi/);
  assert.match(_script('dev', ''), /if \[ "\$\{1:-\}" = sync \]; then _ACT_ON=1; fi/);
});

test('emitCliDispatcher (the real emitter) writes a script with the CLI-gated _ACT_ON prelude, both channels; emitRunSync writes one with _ACT_ON hardcoded on', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-actscope-'));
  try {
    const cliPathStable = emitCliDispatcher(home, 'stable');
    const cliPathDev = emitCliDispatcher(home, 'dev');
    const runSyncPath = emitRunSync(home, 'stable');
    const cliStable = fs.readFileSync(cliPathStable, 'utf8');
    const cliDev = fs.readFileSync(cliPathDev, 'utf8');
    const runSyncScript = fs.readFileSync(runSyncPath, 'utf8');
    for (const s of [cliStable, cliDev]) {
      assert.match(s, /if \[ "\$\{1:-\}" = sync \]; then _ACT_ON=1; fi/, "CLI dispatcher gates _ACT_ON on the caller's own $1");
    }
    assert.match(runSyncScript, /^_ACT_ON=1$/m, 'run-sync hardcodes _ACT_ON on');
    cp.execFileSync('/bin/sh', ['-n', cliPathStable]); // still syntactically valid
    cp.execFileSync('/bin/sh', ['-n', cliPathDev]);
    cp.execFileSync('/bin/sh', ['-n', runSyncPath]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('shellcheck -s sh is clean on all four generated variants (stable/dev x run-sync/cli)', (t) => {
  const probe = cp.spawnSync('shellcheck', ['--version']);
  if (probe.error) { t.skip('shellcheck not installed on this machine'); return; }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-shellcheck-'));
  try {
    const variants = [
      emitRunSync(home, 'stable'),
      emitRunSync(home, 'dev'),
      emitCliDispatcher(home, 'stable'),
      emitCliDispatcher(home, 'dev'),
    ];
    for (const p of variants) {
      const r = cp.spawnSync('shellcheck', ['-s', 'sh', p], { encoding: 'utf8' });
      assert.strictEqual(r.status, 0, `shellcheck -s sh ${p}:\n${r.stdout}${r.stderr}`);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// Layer 3: real-process integration against a stub `python` planted at $GEN/venv/bin/python
// ---------------------------------------------------------------------------------------------

// Pinned from git show f272808:menubar/runtime/dispatchers.js (the commit immediately before
// Task 2.4 landed) -- the exact pre-activity generic dispatcher, byte for byte. Used below to
// prove a non-sync CLI invocation's RUNTIME behavior (not just its source) is unchanged.
const PRE_TASK_2_4_STABLE_CLI = `#!/bin/sh
set -eu
ROOT="$HOME/.repo-radar"
CH="stable"
# Export the channel so the Python side can scope its completion receipt: without this a dev
# build's receipt would be written as (and could advance) the stable channel's watermark.
export REPO_RADAR_CHANNEL="$CH"
# Declare provenance for a direct dispatcher/CLI invocation, but never override an invoker that
# already declared one — the LaunchAgent sets "scheduled" and that must win.
: "\${REPO_RADAR_TRIGGER:=cli}"
export REPO_RADAR_TRIGGER
CUR="$ROOT/$CH/current"
DES="$ROOT/$CH/desired.json"
mkdir -p "$ROOT" 2>/dev/null || true
# --- acquire the ROOT execution lock FIRST (fd 9 rides the exec'd worker) ---
exec 9>"$ROOT/.exec.lock"
/usr/bin/lockf -t 0 9 || { echo "repo-radar: another sync is running" >&2; exit 75; }
# handshake: signal a Node parent (runSync) that the lock is ACQUIRED, via fd 3. The
# group + 2>/dev/null makes it a clean no-op when fd 3 isn't open (launchd/CLI/direct).
# The worker may inherit fd 3 harmlessly; runSync only needs the one byte, not the close.
{ printf 'L' >&3; } 2>/dev/null || true
# --- only AFTER the lock do we resolve + verify current ---
[ -L "$CUR" ] || { echo "repo-radar: no active runtime" >&2; exit 1; }
GEN="$(cd "$CUR" && pwd -P)"
# containment against the CANONICALIZED generations dir (HOME may have symlinked ancestors)
GENS="$(cd "$ROOT/$CH/generations" 2>/dev/null && pwd -P || echo /nonexistent)"
case "$GEN" in "$GENS/"*) : ;; *) echo "repo-radar: runtime outside tree" >&2; exit 1 ;; esac
[ -f "$DES" ] && [ -f "$GEN/.runtime.json" ] && [ -f "$GEN/verify.py" ] && [ -f "$GEN/manifest.json" ] \\
  || { echo "repo-radar: runtime not managed" >&2; exit 1; }
# ANCHOR the verifier + manifest: trusted shasum vs the app-published desired.json BEFORE
# executing the verifier, so a swapped verify.py/manifest can't bypass tamper detection.
VSHA="$(/usr/bin/shasum -a 256 "$GEN/verify.py" | awk '{print $1}')"
MSHA="$(/usr/bin/shasum -a 256 "$GEN/manifest.json" | awk '{print $1}')"
grep -q "\\"verifySha\\": *\\"$VSHA\\"" "$DES" || { echo "repo-radar: verifier hash mismatch" >&2; exit 1; }
grep -q "\\"manifestSha\\": *\\"$MSHA\\"" "$DES" || { echo "repo-radar: manifest hash mismatch" >&2; exit 1; }
# full healthy predicate (desired ACTIVE, identity, live payload hashes, fingerprint, installed set, pip check)
"$GEN/venv/bin/python" "$GEN/verify.py" "$GEN" "$DES" "$GEN/manifest.json" \\
  || { echo "repo-radar: runtime failed verification" >&2; exit 1; }
exec "$GEN/venv/bin/python" "$GEN/repo-radar" "$@"
`;

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-actdisp-')); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// A minimal stub standing in for the generation's venv python (see dispatchers.js's own
// `_STUB_LOG`/verify-exit contract below). Every invocation is appended to `$_STUB_LOG` as one
// line: `MODULE <name> <rest of argv>` for `-m repo_radar.activity.X` calls, `VERIFY` for a
// verify.py invocation, or `EXEC <argv1..>` for the final launcher exec. verify.py's exit code is
// controlled by `$_STUB_VERIFY_EXIT` (default 0) so a single stub can drive both the happy path
// and the guard-failure path.
const STUB_PY = `#!/bin/sh
if [ "$1" = "-m" ]; then
  _mod="$2"; shift 2
  _line="MODULE $_mod"
  while [ $# -gt 0 ]; do _line="$_line $1"; shift; done
  printf '%s\\n' "$_line" >> "$_STUB_LOG"
  exit 0
fi
case "$1" in
  */verify.py)
    printf 'VERIFY\\n' >> "$_STUB_LOG"
    exit "\${_STUB_VERIFY_EXIT:-0}"
    ;;
  */repo-radar)
    shift
    printf 'EXEC %s\\n' "$*" >> "$_STUB_LOG"
    exit 0
    ;;
  *)
    printf 'OTHER %s\\n' "$*" >> "$_STUB_LOG"
    exit 0
    ;;
esac
`;

// Build a minimal fake ACTIVE generation (no real venv/pip -- just enough on-disk shape to
// satisfy the dispatcher's own structural + anchor-hash checks) whose venv/bin/python IS the
// stub above, and point `current` at it.
function fakeActiveGeneration(home, channel) {
  const L = layout(home, channel);
  fs.mkdirSync(L.generations, { recursive: true, mode: 0o700 });
  const genDir = path.join(L.generations, 'gen1');
  fs.mkdirSync(path.join(genDir, 'venv', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(genDir, 'venv', 'bin', 'python'), STUB_PY, { mode: 0o755 });
  fs.writeFileSync(path.join(genDir, 'verify.py'), '# stub target, content unused by the stub\n');
  fs.writeFileSync(path.join(genDir, 'manifest.json'), '{}\n');
  fs.writeFileSync(path.join(genDir, '.runtime.json'), '{}\n');
  fs.writeFileSync(path.join(genDir, 'repo-radar'), '#!/bin/sh\necho fake-launcher\n', { mode: 0o755 });
  const verifySha = sha256(fs.readFileSync(path.join(genDir, 'verify.py')));
  const manifestSha = sha256(fs.readFileSync(path.join(genDir, 'manifest.json')));
  fs.writeFileSync(L.desired, JSON.stringify({ schema: 1, status: 'active', channel, verifySha, manifestSha }, null, 2));
  fs.symlinkSync(genDir, L.current);
  return genDir;
}

function runScript(home, channel, extraEnv) {
  const p = emitRunSync(home, channel);
  const logPath = path.join(home, 'stub.log');
  fs.writeFileSync(logPath, '');
  const env = { ...process.env, HOME: home, _STUB_LOG: logPath, ...extraEnv };
  const r = cp.spawnSync('/bin/sh', [p], { encoding: 'utf8', env, timeout: 20000 });
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { ...r, log };
}

// Same as runScript, but against the CLI dispatcher (installed `repo-radar`), with the caller's
// own argv -- exercises the `activityGate: 'cli'` runtime path (Fix-A/B1b).
function runCliScript(home, channel, argv, extraEnv) {
  const p = emitCliDispatcher(home, channel);
  const logPath = path.join(home, 'stub.log');
  fs.writeFileSync(logPath, '');
  const env = { ...process.env, HOME: home, _STUB_LOG: logPath, ...extraEnv };
  const r = cp.spawnSync('/bin/sh', [p, ...argv], { encoding: 'utf8', env, timeout: 20000 });
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { ...r, log };
}

test('integration (scheduled, happy path): bootstrap -> verify -> exec, in that real execution order', () => {
  const home = tmpHome();
  fakeActiveGeneration(home, 'stable');
  const { status, log } = runScript(home, 'stable', {});
  assert.strictEqual(status, 0, `expected success, log=${JSON.stringify(log)}`);
  const iBoot = log.findIndex((l) => l.startsWith('MODULE repo_radar.activity.bootstrap'));
  const iVerify = log.findIndex((l) => l === 'VERIFY');
  const iExec = log.findIndex((l) => l.startsWith('EXEC'));
  assert.ok(iBoot >= 0 && iVerify >= 0 && iExec >= 0, `all three stages ran: ${JSON.stringify(log)}`);
  assert.ok(iBoot < iVerify && iVerify < iExec, `real execution order bootstrap<verify<exec: ${JSON.stringify(log)}`);
  assert.match(log[iBoot], /--channel stable/);
  assert.match(log[iBoot], /--trigger cli/); // no REPO_RADAR_TRIGGER supplied -> shell default
});

test('integration (scheduled, guard failure): bootstrap ran, then finalize --outcome blocked --reason runtime_verify, script exits 1', () => {
  const home = tmpHome();
  fakeActiveGeneration(home, 'stable');
  const { status, log } = runScript(home, 'stable', { _STUB_VERIFY_EXIT: '1' });
  assert.strictEqual(status, 1);
  const iBoot = log.findIndex((l) => l.startsWith('MODULE repo_radar.activity.bootstrap'));
  const iVerify = log.findIndex((l) => l === 'VERIFY');
  const iBlocked = log.findIndex((l) => l.startsWith('MODULE repo_radar.activity.finalize') && l.includes('--outcome blocked'));
  assert.ok(iBoot >= 0 && iVerify >= 0 && iBlocked >= 0, `all three ran: ${JSON.stringify(log)}`);
  assert.ok(iBoot < iVerify && iVerify < iBlocked, `order bootstrap<verify<blocked-finalize: ${JSON.stringify(log)}`);
  assert.match(log[iBlocked], /--reason runtime_verify/);
  // never reached the final exec
  assert.ok(!log.some((l) => l.startsWith('EXEC')), `no exec after a guard failure: ${JSON.stringify(log)}`);
});

test('integration (scheduled, root-lock contention): the durable start ALREADY ran (Fix-A/B1a), then finalize --outcome skipped runs, script exits 75, never reaches verify', async () => {
  const home = tmpHome();
  fakeActiveGeneration(home, 'stable');
  const L = layout(home, 'stable');
  await withLock(L.execLock, 0, async () => {
    const { status, log } = runScript(home, 'stable', {});
    assert.strictEqual(status, 75);
    const iBoot = log.findIndex((l) => l.startsWith('MODULE repo_radar.activity.bootstrap'));
    const iSkipped = log.findIndex((l) => l.startsWith('MODULE repo_radar.activity.finalize') && l.includes('--outcome skipped'));
    assert.ok(iBoot >= 0, `a durable start was written BEFORE the root-lock attempt: ${JSON.stringify(log)}`);
    assert.ok(iSkipped >= 0, `skipped finalize ran: ${JSON.stringify(log)}`);
    assert.ok(iBoot < iSkipped, `start precedes the skipped terminal it's finalizing: ${JSON.stringify(log)}`);
    assert.ok(!log.some((l) => l === 'VERIFY'), 'never reached verify');
  });
});

test('integration (manual/inherited path): identity pre-set -> NEVER bootstraps and NEVER finalizes root-lock contention (Electron is the sole terminal authority)', async () => {
  const home = tmpHome();
  fakeActiveGeneration(home, 'stable');
  const L = layout(home, 'stable');
  const manualEnv = {
    REPO_RADAR_ACTIVITY_ID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    REPO_RADAR_ACTIVITY_OWNER_TOKEN: 'deadbeef',
    REPO_RADAR_ACTIVITY_LOCK_FD: '4',
  };

  // (a) happy path: still never bootstraps (the exec'd python is the adopter, not the shell).
  {
    const { status, log } = runScript(home, 'stable', manualEnv);
    assert.strictEqual(status, 0, `expected success, log=${JSON.stringify(log)}`);
    assert.ok(!log.some((l) => l.startsWith('MODULE repo_radar.activity.bootstrap')), `manual path never bootstraps: ${JSON.stringify(log)}`);
    assert.ok(log.some((l) => l === 'VERIFY') && log.some((l) => l.startsWith('EXEC')), 'still verifies and execs');
  }

  // (b) root-lock contention: never finalizes -- Electron's own runSync reject handler owns it.
  await withLock(L.execLock, 0, async () => {
    const { status, log } = runScript(home, 'stable', manualEnv);
    assert.strictEqual(status, 75);
    assert.ok(!log.some((l) => l.startsWith('MODULE repo_radar.activity.finalize')), `manual contention never finalizes here: ${JSON.stringify(log)}`);
  });
});

test('integration: last-resort logs to sync.error.log (never an activity .jsonl) when no runtime is resolvable at all', () => {
  const home = tmpHome();
  // No fakeActiveGeneration() -- no `current` symlink at all, so the activity python peek fails
  // and both bootstrap's and (had it occurred) contention's last-resort path fire.
  const { status } = runScript(home, 'stable', {});
  assert.strictEqual(status, 1); // falls through to the real "no active runtime" guard
  const errLog = path.join(home, 'Library', 'Logs', 'repo-radar', 'sync.error.log');
  assert.ok(fs.existsSync(errLog), 'last-resort line was written to the System stream');
  const content = fs.readFileSync(errLog, 'utf8');
  assert.match(content, /activity recording unavailable/);
  assert.doesNotMatch(content, /\.jsonl/);
  // and no activity/ tree exists at all (mint still happened -- owner.lock is fine -- but no
  // *.jsonl segment was ever written, since no python ever ran to write one)
  const activityDir = path.join(home, 'Library', 'Logs', 'repo-radar', 'activity');
  if (fs.existsSync(activityDir)) {
    for (const id of fs.readdirSync(activityDir)) {
      const files = fs.readdirSync(path.join(activityDir, id));
      assert.ok(!files.some((f) => f.endsWith('.jsonl')), `no segment written for ${id}: ${files}`);
    }
  }
});

test('integration: mint creates a 0700 activity dir and a lockf-held owner.lock that outlives the process (fd survives exec, released on exit)', () => {
  const home = tmpHome();
  fakeActiveGeneration(home, 'stable');
  const { status } = runScript(home, 'stable', {});
  assert.strictEqual(status, 0);
  const activityBase = path.join(home, 'Library', 'Logs', 'repo-radar', 'activity');
  const ids = fs.readdirSync(activityBase);
  assert.strictEqual(ids.length, 1, `exactly one minted activity: ${ids}`);
  const dir = path.join(activityBase, ids[0]);
  assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
  assert.ok(fs.existsSync(path.join(dir, 'owner.lock')));
  assert.strictEqual(fs.statSync(path.join(dir, 'owner.lock')).mode & 0o777, 0o600);
  // the script has fully exited -- lockf held via an fd inherited across exec must be released
  // when the last process holding it (the stub's "EXEC" invocation) exits.
  const probe = cp.spawnSync('/usr/bin/lockf', ['-t', '0', path.join(dir, 'owner.lock'), '/usr/bin/true'], { encoding: 'utf8' });
  assert.strictEqual(probe.status, 0, 'lock is free after the process tree exited');
});

// ---------------------------------------------------------------------------------------------
// Fix-A/B1(b): emitCliDispatcher, `$1`-gated activity -- `repo-radar sync` now behaves exactly
// like the scheduled runner; every other subcommand stays fully activity-free.
// ---------------------------------------------------------------------------------------------

test("emitCliDispatcher, $1=sync: activity establishes identity + a durable start BEFORE the root lock, exactly like the scheduled runner (Fix-A/B1b)", () => {
  const home = tmpHome();
  fakeActiveGeneration(home, 'stable');
  const { status, log } = runCliScript(home, 'stable', ['sync', '--status-server'], {});
  assert.strictEqual(status, 0, `log=${JSON.stringify(log)}`);
  const iBoot = log.findIndex((l) => l.startsWith('MODULE repo_radar.activity.bootstrap'));
  const iVerify = log.findIndex((l) => l === 'VERIFY');
  const iExec = log.findIndex((l) => l.startsWith('EXEC'));
  assert.ok(iBoot >= 0 && iVerify >= 0 && iExec >= 0, `all three ran: ${JSON.stringify(log)}`);
  assert.ok(iBoot < iVerify && iVerify < iExec, `order: ${JSON.stringify(log)}`);
  assert.match(log[iExec], /^EXEC sync --status-server/, "forwards the caller's own args verbatim (no baked-in tail)");
  const activityBase = path.join(home, 'Library', 'Logs', 'repo-radar', 'activity');
  assert.strictEqual(fs.readdirSync(activityBase).length, 1, 'exactly one activity was minted');
});

test('emitCliDispatcher, $1=sync, root-lock contention: the durable start already ran, then skipped finalize, exits 75, never reaches verify (Fix-A/B1a via the CLI-sync path)', async () => {
  const home = tmpHome();
  fakeActiveGeneration(home, 'stable');
  const L = layout(home, 'stable');
  await withLock(L.execLock, 0, async () => {
    const { status, log } = runCliScript(home, 'stable', ['sync'], {});
    assert.strictEqual(status, 75);
    const iBoot = log.findIndex((l) => l.startsWith('MODULE repo_radar.activity.bootstrap'));
    const iSkipped = log.findIndex((l) => l.startsWith('MODULE repo_radar.activity.finalize') && l.includes('--outcome skipped'));
    assert.ok(iBoot >= 0, `bootstrap ran before the contention gate: ${JSON.stringify(log)}`);
    assert.ok(iSkipped >= 0, `skipped finalize ran: ${JSON.stringify(log)}`);
    assert.ok(iBoot < iSkipped, `durable start precedes the skipped terminal: ${JSON.stringify(log)}`);
    assert.ok(!log.some((l) => l === 'VERIFY'), 'never reached verify');
  });
});

test('emitCliDispatcher, non-sync $1: mints/runs NOTHING (no activity dir ever created), and its runtime output is byte-identical to the pre-activity script (Fix-A/B1b)', () => {
  const home = tmpHome();
  fakeActiveGeneration(home, 'stable');
  const oldScriptPath = path.join(home, 'pre-activity-cli.sh');
  fs.writeFileSync(oldScriptPath, PRE_TASK_2_4_STABLE_CLI, { mode: 0o700 });
  const newScriptPath = emitCliDispatcher(home, 'stable');

  const run = (scriptPath, argv) => {
    const logPath = path.join(home, 'stub.log');
    fs.writeFileSync(logPath, '');
    const env = { ...process.env, HOME: home, _STUB_LOG: logPath };
    const r = cp.spawnSync('/bin/sh', [scriptPath, ...argv], { encoding: 'utf8', env, timeout: 20000 });
    return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
  };

  const oldRun = run(oldScriptPath, ['--version']);
  const newRun = run(newScriptPath, ['--version']);
  assert.deepStrictEqual(newRun, oldRun, 'non-sync CLI runtime output (status/stdout/stderr) is byte-identical to the pre-activity script');
  assert.ok(!fs.existsSync(path.join(home, 'Library', 'Logs', 'repo-radar', 'activity')), 'no activity dir was ever created for a non-sync invocation');
  assert.ok(!fs.existsSync(path.join(home, 'Library', 'Logs', 'repo-radar', 'sync.error.log')), 'no last-resort line either -- the activity code truly never ran');
});

// ---------------------------------------------------------------------------------------------
// Fix-A/B2: the shell mint refuses a symlinked activity root before creating anything under it.
// ---------------------------------------------------------------------------------------------

test('Fix-A/B2: a symlinked activity root is refused before minting -- no UUID dir is created outside the owned tree, the outside sentinel is untouched, and the run degrades gracefully (no crash)', () => {
  const home = tmpHome();
  fakeActiveGeneration(home, 'stable');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-outside-'));
  const sentinel = path.join(outside, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'do-not-touch');
  try {
    const repoRadarDir = path.join(home, 'Library', 'Logs', 'repo-radar');
    fs.mkdirSync(repoRadarDir, { recursive: true });
    const activityLink = path.join(repoRadarDir, 'activity');
    fs.symlinkSync(outside, activityLink);

    const { status, log } = runScript(home, 'stable', {});
    assert.strictEqual(status, 0, `the run degraded gracefully -- the sync itself still completed: log=${JSON.stringify(log)}`);
    assert.ok(log.some((l) => l === 'VERIFY') && log.some((l) => l.startsWith('EXEC')), 'the sync itself still ran to completion');
    assert.ok(!log.some((l) => l.startsWith('MODULE repo_radar.activity')), 'mint was refused -- no activity was ever established');

    assert.ok(fs.lstatSync(activityLink).isSymbolicLink(), 'the symlink itself is untouched');
    assert.strictEqual(fs.readlinkSync(activityLink), outside, 'the symlink still points where it always did');
    assert.deepStrictEqual(fs.readdirSync(outside).sort(), ['sentinel.txt'], 'no UUID activity dir was created outside the owned tree');
    assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'do-not-touch', 'the outside sentinel content is untouched');
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// runSync() itself: the fd-4 remap + REPO_RADAR_ACTIVITY_LOCK_FD correction (index.js:132-149).
// A minimal hand-written script stands in for the real dispatcher here -- this proves runSync's
// OWN plumbing (independent of dispatchers.js's content, already covered above).
// ---------------------------------------------------------------------------------------------

test('runSync: a supplied lockFd rides child fd 4 (real fd-inheritance, not just an option) and REPO_RADAR_ACTIVITY_LOCK_FD is corrected from the parent-side number to the fixed child-side "4"', async () => {
  const home = tmpHome();
  const L = layout(home, 'stable');
  fs.mkdirSync(L.channelDir, { recursive: true });
  fs.writeFileSync(L.runSync, '#!/bin/sh\nprintf \'FD_ENV=%s\\n\' "$REPO_RADAR_ACTIVITY_LOCK_FD"\nprintf \'FD_CONTENT=%s\\n\' "$(cat <&4)"\n', { mode: 0o755 });

  const markerPath = path.join(home, 'lease-marker.txt');
  fs.writeFileSync(markerPath, 'lease-payload-xyz');
  const leaseFd = fs.openSync(markerPath, 'r');
  let out = '';
  try {
    const code = await runSync({
      home, channel: 'stable',
      env: {
        REPO_RADAR_ACTIVITY_ID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        REPO_RADAR_ACTIVITY_OWNER_TOKEN: 'deadbeef',
        REPO_RADAR_ACTIVITY_LOCK_FD: String(leaseFd), // the PARENT's own fd number (wrong for the child)
      },
      lockFd: leaseFd,
      onChild: (child) => { child.stdout.on('data', (d) => { out += d.toString(); }); },
    });
    assert.strictEqual(code, 0, `script exited nonzero, out=${out}`);
  } finally {
    fs.closeSync(leaseFd);
  }
  assert.match(out, /FD_ENV=4\n/, `env corrected to the fixed child-side fd 4: ${JSON.stringify(out)}`);
  assert.match(out, /FD_CONTENT=lease-payload-xyz/, `child fd 4 is the SAME open file as the parent's lockFd: ${JSON.stringify(out)}`);
});

test('runSync: no lockFd -> stdio stays 4-wide and REPO_RADAR_ACTIVITY_LOCK_FD is left untouched (pre-Task-2.4 behavior, unchanged)', async () => {
  const home = tmpHome();
  const L = layout(home, 'stable');
  fs.mkdirSync(L.channelDir, { recursive: true });
  fs.writeFileSync(L.runSync, '#!/bin/sh\nprintf \'FD_ENV=%s\\n\' "${REPO_RADAR_ACTIVITY_LOCK_FD:-unset}"\n', { mode: 0o755 });
  let out = '';
  const code = await runSync({
    home, channel: 'stable', env: {},
    onChild: (child) => { child.stdout.on('data', (d) => { out += d.toString(); }); },
  });
  assert.strictEqual(code, 0);
  assert.match(out, /FD_ENV=unset/, `no override when lockFd is absent: ${JSON.stringify(out)}`);
});
