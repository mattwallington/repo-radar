'use strict';
// Task 2.4: the dispatcher carries the activity lease (mint-or-inherit), delegates identity
// establishment to Python (bootstrap before the dev/verify guards; finalize on guard-failure/
// root-contention), and last-resorts to the System diagnostic stream when even that can't run.
//
// Fix round 1: the ENTIRE activity lifecycle is scoped to the sync runner only, via
// `_script(channel, tail, { withActivity })`. `emitRunSync` (the sync runner) passes
// `withActivity: true`; `emitCliDispatcher` (the generic, user-facing `repo-radar`/
// `repo-radar-dev` CLI, which runs for EVERY subcommand -- `--version`, `analyze`, `configure`,
// `clean`, not just `sync`) passes nothing, defaulting to `false`. Getting this wrong means
// `repo-radar --version` mints a phantom "sync" activity that starts and never terminates
// (cli.py only calls sync_mode for the literal `sync` subcommand).
//
// Three layers:
//  (1) STRING-LEVEL assertions on the generated `_script()` text (fast, exact wording/ordering).
//  (2) withActivity SCOPING assertions: the CLI-dispatcher rendering (withActivity: false, both
//      via the raw flag and via the real `emitCliDispatcher`) contains NONE of the activity
//      additions and is BYTE-FOR-BYTE identical to the pre-Task-2.4 script; the sync-runner
//      rendering (withActivity: true, both via the raw flag and via the real `emitRunSync`)
//      still contains everything.
//  (3) A REAL-PROCESS integration that spawns the actual generated script against a STUB `python`
//      planted at the resolved generation's `venv/bin/python` (the dispatcher never searches
//      PATH for python -- it always uses the anchored `$GEN/venv/bin/python`), so the assertions
//      prove the ordering EXECUTES, not merely that the right substrings appear in the source.
//
// What's deferred to later tasks: the stub python never really adopts fd 4 or writes activity
// records (that's repo_radar.activity.bootstrap/finalize, already covered by
// repo_radar/tests/test_activity_entrypoints.py) and the exec'd sync worker never really becomes
// cli.py/sync_mode (Tasks 2.5/2.6 -- not yet built, so a live adopt-and-handoff chain is Task 2.7).
// This file proves the SHELL's own ordering/branching/env/fd/scoping plumbing only.
const test = require('node:test'); const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const cp = require('child_process');
const { _script, emitRunSync, emitCliDispatcher } = require('../dispatchers');
const { runSync } = require('../index');
const { layout, cliPath } = require('../paths');
const { withLock } = require('../lock');

// ---------------------------------------------------------------------------------------------
// Layer 1: string-level assertions on the generated script (sync runner: withActivity: true)
// ---------------------------------------------------------------------------------------------

test('scheduled script: bootstrap precedes verify; finalize handles block AND skipped', () => {
  const s = _script('stable', ' sync --status-server', { withActivity: true });
  const iBootstrap = s.indexOf('activity.bootstrap');
  const iVerify = s.indexOf('verify.py');
  assert.ok(iBootstrap > 0 && iVerify > 0 && iBootstrap < iVerify, 'bootstrap precedes verify');
  assert.ok(/activity\.finalize[^\n]*--outcome[= ]blocked/.test(s), 'blocked on guard failure');
  assert.ok(/activity\.finalize[^\n]*--outcome[= ]skipped/.test(s), 'skipped on root contention');
  assert.ok(s.includes('REPO_RADAR_ACTIVITY_ID'), 'exports identity');
});

test('last-resort writes to the System stream, not an activity segment', () => {
  const s = _script('stable', ' sync --status-server', { withActivity: true });
  assert.ok(s.includes('sync.error.log'), 'last-resort goes to System diagnostics');
  assert.ok(!/activity\/[^\n]*\.jsonl/.test(s.split('last-resort')[1] || ''),
            'last-resort never appends an activity segment');
});

test('mint-or-inherit: identity export and root-lock acquisition are both gated on the SAME conditional, and bootstrap/contention-finalize are gated on _ACT_MINTED (never set on the inherited/manual path)', () => {
  const s = _script('stable', ' sync --status-server', { withActivity: true });
  assert.match(s, /if \[ -z "\$\{REPO_RADAR_ACTIVITY_ID:-\}" \]; then/, 'mint only when identity is absent');
  assert.match(s, /_ACT_MINTED=1/, 'mint sets the scheduled-path marker');
  // Both the root-contention finalize AND the bootstrap call are inside `if [ -n "$_ACT_MINTED" ]`
  // blocks -- on the manual/inherited path (identity present, _ACT_MINTED never set) neither runs.
  const contentionBlock = s.slice(s.indexOf('another sync is running') - 400, s.indexOf('another sync is running'));
  assert.match(contentionBlock, /if \[ -n "\$_ACT_MINTED" \]/, 'contention-finalize gated on _ACT_MINTED');
  const bootstrapBlock = s.slice(s.indexOf('activity.bootstrap') - 200, s.indexOf('activity.bootstrap'));
  assert.match(bootstrapBlock, /if \[ -n "\$_ACT_MINTED" \]/, 'bootstrap gated on _ACT_MINTED');
});

test('devGuard is untouched: exact original guard messages and fd-9/fd-3 handshakes survive verbatim', () => {
  const s = _script('dev', ' sync --status-server', { withActivity: true });
  assert.match(s, /exec 9>"\$ROOT\/\.exec\.lock"/);
  assert.match(s, /\{ printf 'L' >&3; \} 2>\/dev\/null \|\| true/);
  assert.match(s, /repo-radar-dev: legacy stable install present; run dev in an isolated HOME/);
  assert.match(s, /repo-radar-dev: stable runtime is not healthy; run dev in an isolated HOME/);
  assert.match(s, /exec "\$GEN\/venv\/bin\/python" "\$GEN\/repo-radar" sync --status-server "\$@"/);
});

// ---------------------------------------------------------------------------------------------
// Layer 2: withActivity scoping -- the bug this fix round closes. The generic CLI dispatcher
// (emitCliDispatcher, tail='') MUST carry NONE of the activity additions, for BOTH channels, via
// both the raw flag and the real emitter; the sync runner (emitRunSync) MUST carry all of them.
// ---------------------------------------------------------------------------------------------

function assertNoActivity(s, label) {
  assert.ok(!s.includes('activity.bootstrap'), `${label}: no bootstrap call`);
  assert.ok(!s.includes('--kind sync'), `${label}: no --kind sync`);
  assert.ok(!s.includes('_act_guard_blocked'), `${label}: no guard-blocked trap`);
  assert.ok(!/trap .* 0/.test(s), `${label}: no EXIT trap at all`);
  assert.ok(!s.includes('activity.finalize'), `${label}: no finalize call`);
  assert.ok(!s.includes('sync.error.log'), `${label}: no last-resort System-stream write`);
  assert.ok(!s.includes('REPO_RADAR_ACTIVITY_ID'), `${label}: no identity export/check at all`);
  assert.ok(!s.includes('_ACT_MINTED'), `${label}: no mint marker`);
  assert.ok(!s.includes('owner.lock'), `${label}: no lease file`);
}

function assertHasActivity(s, label) {
  assert.ok(s.includes('activity.bootstrap'), `${label}: has bootstrap call`);
  assert.ok(s.includes('--kind sync'), `${label}: has --kind sync`);
  assert.ok(s.includes('_act_guard_blocked'), `${label}: has guard-blocked trap`);
  assert.ok(s.includes('activity.finalize'), `${label}: has finalize call`);
  assert.ok(s.includes('sync.error.log'), `${label}: has last-resort System-stream write`);
  assert.ok(s.includes('REPO_RADAR_ACTIVITY_ID'), `${label}: has identity export/check`);
}

test('CLI dispatcher rendering (withActivity: false, both channels): NONE of the activity additions, via the raw flag', () => {
  assertNoActivity(_script('stable', '', { withActivity: false }), 'stable CLI (explicit false)');
  assertNoActivity(_script('dev', '', { withActivity: false }), 'dev CLI (explicit false)');
});

test('CLI dispatcher rendering (default, no options object at all): withActivity defaults to false', () => {
  assertNoActivity(_script('stable', ''), 'stable CLI (default)');
  assertNoActivity(_script('dev', ''), 'dev CLI (default)');
});

test('sync-runner rendering (withActivity: true, both channels): has every activity addition', () => {
  assertHasActivity(_script('stable', ' sync --status-server', { withActivity: true }), 'stable sync');
  assertHasActivity(_script('dev', ' sync --status-server', { withActivity: true }), 'dev sync');
});

test('withActivity: false is byte-for-byte identical to the pre-Task-2.4 script (both channels, both a sync-shaped and an empty tail)', () => {
  // Pinned from git show f272808:menubar/runtime/dispatchers.js (the commit immediately before
  // Task 2.4 landed) -- the exact pre-activity generic dispatcher, byte for byte.
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
  assert.strictEqual(_script('stable', '', { withActivity: false }), PRE_TASK_2_4_STABLE_CLI);
  assert.strictEqual(_script('stable', ''), PRE_TASK_2_4_STABLE_CLI); // default (no options) matches too
});

test('emitCliDispatcher (the real emitter) writes a script with none of the activity additions; emitRunSync (the real emitter) writes one with all of them', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-actscope-'));
  const cliPathStable = emitCliDispatcher(home, 'stable');
  const cliPathDev = emitCliDispatcher(home, 'dev');
  const runSyncPath = emitRunSync(home, 'stable');
  assertNoActivity(fs.readFileSync(cliPathStable, 'utf8'), 'emitCliDispatcher stable');
  assertNoActivity(fs.readFileSync(cliPathDev, 'utf8'), 'emitCliDispatcher dev');
  assertHasActivity(fs.readFileSync(runSyncPath, 'utf8'), 'emitRunSync stable');
  cp.execFileSync('/bin/sh', ['-n', cliPathStable]); // still syntactically valid
  cp.execFileSync('/bin/sh', ['-n', runSyncPath]);
});

// ---------------------------------------------------------------------------------------------
// Layer 2: real-process integration against a stub `python` planted at $GEN/venv/bin/python
// ---------------------------------------------------------------------------------------------

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

test('integration (scheduled, root-lock contention): finalize --outcome skipped runs, script exits 75, never reaches bootstrap/verify', async () => {
  const home = tmpHome();
  fakeActiveGeneration(home, 'stable');
  const L = layout(home, 'stable');
  await withLock(L.execLock, 0, async () => {
    const { status, log } = runScript(home, 'stable', {});
    assert.strictEqual(status, 75);
    const iSkipped = log.findIndex((l) => l.startsWith('MODULE repo_radar.activity.finalize') && l.includes('--outcome skipped'));
    assert.ok(iSkipped >= 0, `skipped finalize ran: ${JSON.stringify(log)}`);
    assert.ok(!log.some((l) => l.startsWith('MODULE repo_radar.activity.bootstrap')), 'never reached bootstrap (root lock never acquired)');
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
