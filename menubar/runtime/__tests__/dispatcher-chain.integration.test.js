'use strict';
// Task 2.7 (Codex Phase-2 gate mandate): the REAL cross-process macOS production chain --
// `menubar/activity` (mint/lease/admit/start) -> `runSync`'s fd-4 remap -> the REAL generated
// `/bin/sh` dispatcher (`emitRunSync`) -> a REAL `exec` into a REAL `python -m repo_radar.cli` ->
// `cli.py`'s `_establish_activity()` -> `lease.adopt()` (fstat + flock reassert) -> `sync_mode` ->
// a durable terminal. Nothing here is mocked or stubbed at the identity/lease/handoff/terminal
// layer: every process is real, every fd is really inherited across a real `exec`, every flock is
// a real kernel lock (`/usr/bin/lockf` <-> Python `fcntl.flock`, proven-conflicting in
// __tests__/lock-interop.test.js), and every record is read back off real disk. The ONLY
// simplification vs a real end-user run is the WORKLOAD sync_mode performs once it's running (a
// zero-repository config, so the "real chain" proof isn't gated on network/git availability) --
// the machinery this task exists to prove (identity/lease/handoff/terminal) is never touched.
//
// Builds on the real-process harness Task 2.4 introduced (dispatcher-activity.test.js's
// `fakeActiveGeneration`/`runScript`, which used a STUB python planted at `$GEN/venv/bin/python`
// only to prove the SHELL's own ordering/branching). This file replaces the stub with a REAL
// python (a symlink to the system interpreter) and a REAL `repo_radar` package (symlinked source,
// exactly as production's generation holds copied source) so the entrypoints Tasks 1.8/2.5/2.6
// built (`bootstrap.py`/`finalize.py`/`cli.py`/`sync_mode`) run unmodified, for real.
//
// Scenarios (spec Phase-2 acceptance / Codex's fd-inheritance-through-exec mandate):
//   1. Happy path (manual/Electron path): one continuous owner_token from mint through the
//      handoff ownership record to the terminal's `by`; lock free afterward.
//   2. Root contention, SCHEDULED (minting) path: the dispatcher itself is the sole finalizer
//      (`skipped`), via a REAL `python -m repo_radar.activity.finalize`.
//   3. Root contention, MANUAL (inherited) path: the dispatcher exits 75 WITHOUT finalizing;
//      Electron's own `runSync`-reject `onContention` is the sole finalizer (Round-3 #2).
//   4. Failed descriptor validation (manual path): an "unlocked look-alike" fd -- right file
//      (fstat identity passes), but a foreign open-file-description that never held the flock --
//      makes the REAL `lease.adopt()` step-4 reassert fail for real; the exec'd python exits 66
//      with NO ack; Electron's `handOff()` is the sole finalizer (`failed`), and the worker is
//      never signalled.
//   5. Simulated crash -> interrupted: SIGKILL after a real handoff, then
//      `reconcile.synthesizeTerminal` synthesizes a durable `interrupted` (also covers a non-66
//      crash exit, Round-5 #4 -- the child dies by signal, not via the 66 rejection path).
//   6. Cancel -> cancelled: same as (5), but a `control{cancel_requested}` record lands (via the
//      real, post-handoff-capable `writer.control()`/`onCancel()`) before the kill.
//
// macOS-only (like every sibling file here): /usr/bin/lockf, real exec/fork/signal semantics.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const { emitRunSync } = require('../dispatchers');
const { runSync } = require('../index');
const { layout } = require('../paths');
const { withLock } = require('../lock');
const act = require('../../activity');
const { ActivityWriter } = act.writer;
const glue = require('../../activity/trigger-glue');

// Repo root: __tests__ -> runtime -> menubar -> repo root (matches fix-regressions.test.js's `WT`).
const REPO_ROOT = path.join(__dirname, '..', '..', '..');

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// A tmp HOME for one scenario, auto-removed when its test finishes (pass OR fail) via the
// TestContext's own `after` hook (Codex B5 hygiene finding: without this, every run leaves a
// `rr-chain-*` dir behind -- this suite alone filled the disk during earlier work on this file).
function tmpHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-chain-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* best-effort */ } });
  return home;
}

// ------------------------------------------------------------------------------------------
// Interpreter resolution (Codex B5, defect 1). The OLD version of this file just resolved
// whatever `python3` happened to be first on PATH and trusted it had repo-radar's runtime deps
// (litellm/requests/inquirer/rich). In Codex's clean reviewer shell that assumption was false:
// the ambient python3 had no deps, `check_dependencies()` failed, and even the HAPPY path exited
// 2 (`blocked/dependencies`) before ever reaching the identity/lease/handoff machinery this file
// exists to prove. Resolve a KNOWN dependency-complete interpreter instead -- verified by
// actually importing the four required packages, never assumed -- preferring, in order:
//   1. $REPO_RADAR_TEST_PYTHON -- an explicit override for a caller that already knows the
//      right interpreter (e.g. a CI step that installed deps into a specific venv).
//   2. $VIRTUAL_ENV/bin/python3 -- an active virtualenv, if any.
//   3. The interpreter backing `pytest` on PATH (read off its own shebang, no shelling out to
//      `which`) -- pytest passing repo_radar/tests/ proves whatever interpreter it runs under
//      already has every dep this file needs.
//   4. Ambient `python3` on PATH -- last resort, but still VERIFIED for deps below, never
//      trusted blindly (that blind trust is exactly what Codex found broken).
// Resolved ONCE at module load, so every test() call below can set its `skip` synchronously.
// If NONE of the above actually has the deps, every test in this file skips with a clear,
// deterministic reason instead of hanging/failing against a broken interpreter.
// ------------------------------------------------------------------------------------------

function _findOnPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* not here -- keep looking */ }
  }
  return null;
}

// Reads a `#!/path/to/interpreter` (or `#!/usr/bin/env python3`) shebang off a script, without
// shelling out. Returns null for anything that doesn't look like a text shebang (e.g. a compiled
// launcher) -- the caller just skips that candidate.
function _shebangInterpreter(scriptPath) {
  try {
    const fd = fs.openSync(scriptPath, 'r');
    const buf = Buffer.alloc(512);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const firstLine = buf.subarray(0, n).toString('utf8').split('\n')[0];
    const m = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(firstLine);
    if (!m) return null;
    if (path.basename(m[1]) === 'env' && m[2]) return m[2];
    return m[1];
  } catch {
    return null;
  }
}

// Every probe subprocess below is stdio-suppressed (never 'inherit') -- a candidate that fails
// to resolve/import (wrong interpreter, missing deps, or -- see _looksLikeShell below -- a
// version-manager shim whose OWN shebang names a shell rather than python) is expected, routine
// fallthrough, not something that should ever print to this test file's own output.
function _sysExecutable(pythonPath) {
  return cp.execFileSync(pythonPath, ['-c', 'import sys; print(sys.executable)'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

// The actual gate: never assumed, always verified by really importing every dep
// repo_radar/dependencies.py's own check_dependencies() requires.
function _hasRepoRadarDeps(pythonPath) {
  try {
    cp.execFileSync(pythonPath, ['-c', 'import rich, litellm, requests, inquirer'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// A version-manager shim (pyenv/asdf/rbenv-style) fronts the real interpreter/script with a
// small SHELL wrapper; its own shebang names a shell, not python, so treat that as unresolved
// rather than actually spawning a shell with Python source as its `-c` argument.
function _looksLikeShell(interpPath) {
  return /^(bash|sh|zsh|dash|ksh)$/.test(path.basename(interpPath));
}

function _candidateInterpreters() {
  const list = [];
  if (process.env.REPO_RADAR_TEST_PYTHON) list.push(process.env.REPO_RADAR_TEST_PYTHON);
  if (process.env.VIRTUAL_ENV) list.push(path.join(process.env.VIRTUAL_ENV, 'bin', 'python3'));

  // The interpreter backing `pytest` on PATH -- pytest passing repo_radar/tests/ proves whatever
  // interpreter it runs under already has every dep this file needs. If `pytest` on PATH is a
  // pyenv shim (this machine's own setup: `#!/usr/bin/env bash`), `pyenv which pytest` resolves
  // straight through to the real, non-shim script when a real `pyenv` binary is reachable;
  // otherwise fall back to whatever `pytest` on PATH resolves to directly.
  let pytestScript = _findOnPath('pytest');
  const pyenvPath = _findOnPath('pyenv');
  if (pyenvPath) {
    try {
      const resolved = cp.execFileSync(pyenvPath, ['which', 'pytest'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (resolved) pytestScript = resolved;
    } catch { /* pyenv present but pytest isn't pyenv-managed -- keep the PATH-found script */ }
  }
  const pytestInterp = pytestScript ? _shebangInterpreter(pytestScript) : null;
  if (pytestInterp && !_looksLikeShell(pytestInterp)) list.push(pytestInterp);

  const python3Path = _findOnPath('python3');
  if (python3Path) list.push(python3Path);
  return list;
}

function _resolveDependencyCompletePython() {
  for (const candidate of _candidateInterpreters()) {
    let real;
    try { real = _sysExecutable(candidate); } catch { continue; }
    if (_hasRepoRadarDeps(real)) return real;
  }
  return null;
}

const PYTHON = _resolveDependencyCompletePython();
const PYTHON_SKIP_REASON = PYTHON === null
  ? 'no dependency-complete Python interpreter found (checked $REPO_RADAR_TEST_PYTHON, '
    + '$VIRTUAL_ENV, the interpreter backing `pytest` on PATH, and `python3` on PATH -- none '
    + "importable rich/litellm/requests/inquirer). Install repo-radar's deps for one of those, "
    + 'or set $REPO_RADAR_TEST_PYTHON to a deps-complete interpreter, to run this suite.'
  : null;

// Skip guard, matching this codebase's existing t.skip()-in-body convention (see
// dispatcher-activity.test.js's shellcheck test). Returns false (and skips `t`) when no
// dependency-complete interpreter was resolvable; every test calls this first.
function requirePython(t) {
  if (PYTHON === null) { t.skip(PYTHON_SKIP_REASON); return false; }
  return true;
}

// A REAL (not stubbed) active generation: `venv/bin/python` is a symlink to the resolved
// dependency-complete interpreter (verified above -- never ambient `python3` blindly trusted);
// `repo_radar` is symlinked to the real source tree (mirrors production's "copied source in the
// generation", per Task 2.4's own report: the launcher script's own directory is sys.path[0], so
// no PYTHONPATH is needed for the final `exec`); `repo-radar` is a byte-for-byte copy of the real
// launcher; `verify.py` is a trivial pass, anchored by a real shasum in `desired.json` so the
// dispatcher's own tamper-check is exercised for real (not bypassed).
function realActiveGeneration(home, channel) {
  if (PYTHON === null) throw new Error('realActiveGeneration called without a resolved interpreter -- caller must check requirePython(t) first');
  const L = layout(home, channel);
  fs.mkdirSync(L.generations, { recursive: true, mode: 0o700 });
  const genDir = path.join(L.generations, 'gen1');
  fs.mkdirSync(path.join(genDir, 'venv', 'bin'), { recursive: true });
  fs.symlinkSync(PYTHON, path.join(genDir, 'venv', 'bin', 'python'));
  fs.symlinkSync(path.join(REPO_ROOT, 'repo_radar'), path.join(genDir, 'repo_radar'));
  fs.copyFileSync(path.join(REPO_ROOT, 'repo-radar'), path.join(genDir, 'repo-radar'));
  fs.chmodSync(path.join(genDir, 'repo-radar'), 0o755);
  fs.writeFileSync(path.join(genDir, 'verify.py'), 'import sys\nsys.exit(0)\n');
  fs.writeFileSync(path.join(genDir, 'manifest.json'), '{}\n');
  fs.writeFileSync(path.join(genDir, '.runtime.json'), '{}\n');
  const verifySha = sha256(fs.readFileSync(path.join(genDir, 'verify.py')));
  const manifestSha = sha256(fs.readFileSync(path.join(genDir, 'manifest.json')));
  fs.writeFileSync(L.desired, JSON.stringify({ schema: 1, status: 'active', channel, verifySha, manifestSha }, null, 2));
  fs.symlinkSync(genDir, L.current);
  return genDir;
}

// Generation + the real generated dispatcher script, one call.
function setupChain(home, channel = 'stable') {
  realActiveGeneration(home, channel);
  return emitRunSync(home, channel);
}

// A real, minimal, valid config: zero repositories. `sync_mode`'s own "No repositories
// configured" branch is real, unmocked production code (not a test seam) -- it still runs the
// full identity/network-wait/config-load path, it just has no repo work to do, so the happy-path
// scenario is deterministic and hermetic beyond the one real TCP reachability probe
// `wait_for_network()` itself performs (no git, no AI calls, no filesystem work beyond the
// activity/receipt writes).
function zeroRepoConfig(home) {
  const dir = path.join(home, '.config', 'repo-radar');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ repositories: [] }));
}

// All validated records for one activity, across every segment file, in chronological (ts) order.
function readAllRecords(home, activityId) {
  const out = [];
  for (const seg of act.readOwnedSegments(act.activityDir(home, activityId))) {
    let start = 0;
    for (let i = 0; i <= seg.data.length; i++) {
      if (i === seg.data.length || seg.data[i] === 0x0a) {
        if (i > start) {
          const rec = act.parseValid(seg.data.subarray(start, i), activityId);
          if (rec !== null) out.push(rec);
        }
        start = i + 1;
      }
    }
  }
  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return out;
}

// The single activity id minted under `home` (for the scheduled/minting-path scenario, where the
// SHELL -- not this test -- generates the id). `activity/quota/` is a sibling ledger directory,
// not an activity id -- exclude it.
function soleActivityId(home) {
  const base = path.join(home, 'Library', 'Logs', 'repo-radar', 'activity');
  const ids = fs.readdirSync(base)
    .filter((n) => n !== 'quota' && fs.statSync(path.join(base, n)).isDirectory());
  assert.strictEqual(ids.length, 1, `expected exactly one minted activity dir, found: ${JSON.stringify(ids)}`);
  return ids[0];
}

async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error('waitFor: timed out waiting for condition');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ---------------------------------------------------------------------------------------------
// 1. Happy path: real fd-inheritance -> real exec -> real python-adopt -> real handoff -> real
//    terminal. Proves the lease survives spawn-inheritance + exec, and that exactly ONE
//    owner_token threads Electron (mint) -> the exec'd python (adopt/handoff) -> the terminal.
// ---------------------------------------------------------------------------------------------

test('happy path (real production chain): one continuous owner_token from mint through handoff to a clean terminal; owner.lock is free afterward', { timeout: 30000 }, async (t) => {
  if (!requirePython(t)) return;
  const home = tmpHome(t);
  setupChain(home, 'stable');
  zeroRepoConfig(home);

  const { writer, lockFd } = glue.beginManualActivity(home, { channel: 'stable', trigger: 'manual' });
  assert.ok(writer._active, 'Electron established a real, active writer');
  const activityId = writer.activityId;
  const ownerToken = writer._lease.ownerToken;

  let handOffPromise;
  const code = await runSync({
    home, channel: 'stable',
    env: { ...writer.handOffEnv(), HOME: home },
    lockFd,
    onChild: (child) => { handOffPromise = glue.handOff({ writer, child, home }); },
  });
  await handOffPromise;

  assert.strictEqual(code, 0, 'the real sync exited cleanly');

  const recs = readAllRecords(home, activityId);
  const starts = recs.filter((r) => r.type === 'start');
  assert.strictEqual(starts.length, 1, `exactly one start: ${JSON.stringify(recs)}`);

  const ownerships = recs.filter((r) => r.type === 'ownership');
  const initial = ownerships.find((r) => r.role === 'initial');
  const handoff = ownerships.find((r) => r.role === 'handoff');
  assert.ok(initial, 'Electron wrote the initial ownership record');
  assert.ok(handoff, 'the exec\'d python durably adopted and wrote the handoff ownership record');
  assert.strictEqual(initial.owner_token, ownerToken);
  assert.strictEqual(handoff.owner_token, ownerToken,
    'the SAME owner_token threads mint (Electron) -> adopt (exec\'d python) -- proves the advisory lease survived spawn-inheritance + exec, not a fresh/different lease');

  const terminals = recs.filter((r) => r.type === 'terminal');
  assert.strictEqual(terminals.length, 1, `exactly one terminal: ${JSON.stringify(recs)}`);
  assert.strictEqual(terminals[0].by, ownerToken, 'terminal.by is the SAME continuous owner_token');
  assert.strictEqual(terminals[0].outcome, 'succeeded');

  // Chronological order: start -> ownership(initial) -> ownership(handoff) -> terminal.
  const order = recs.map((r) => r.type + (r.role ? `:${r.role}` : ''));
  const iStart = order.indexOf('start');
  const iInitial = order.indexOf('ownership:initial');
  const iHandoff = order.indexOf('ownership:handoff');
  const iTerminal = order.lastIndexOf('terminal');
  assert.ok(iStart >= 0 && iStart < iInitial && iInitial < iHandoff && iHandoff < iTerminal,
    `expected start<initial<handoff<terminal, got order=${JSON.stringify(order)}`);

  assert.strictEqual(act.probeBusy(act.ownerLockPath(home, activityId)), false,
    'owner.lock is FREE after the whole process tree (Electron\'s dropped reference + the exec\'d python\'s own release) has gone away');
});

// ---------------------------------------------------------------------------------------------
// 2 & 3. Root contention, both paths (Round-4 #4): exactly one skipped terminal, one settlement,
//    one lock release, regardless of who mints.
// ---------------------------------------------------------------------------------------------

test('root contention, SCHEDULED (minting) path: the dispatcher itself is the sole finalizer via a REAL python finalize entrypoint (Electron absent)', { timeout: 20000 }, async (t) => {
  if (!requirePython(t)) return;
  const home = tmpHome(t);
  const scriptPath = setupChain(home, 'stable');
  const L = layout(home, 'stable');

  await withLock(L.execLock, 0, async () => {
    const r = cp.spawnSync('/bin/sh', [scriptPath], {
      encoding: 'utf8', env: { ...process.env, HOME: home }, timeout: 15000,
    });
    assert.strictEqual(r.status, 75, `expected exit 75 (root lock busy), stderr=${r.stderr}`);
  });

  const activityId = soleActivityId(home);
  const recs = readAllRecords(home, activityId);
  // Fix-A/B1(a) re-validation: bootstrap (the durable `start`) now runs BEFORE the root
  // .exec.lock acquisition, so a contention loser ALWAYS has a real start to finalize `skipped`
  // against -- assert that positively rather than only inferring it from the terminal existing.
  const starts = recs.filter((r) => r.type === 'start');
  assert.strictEqual(starts.length, 1, `expected exactly one durable start (Fix-A moved bootstrap before the root lock): ${JSON.stringify(recs)}`);
  const terminals = recs.filter((r) => r.type === 'terminal');
  assert.strictEqual(terminals.length, 1, `exactly one terminal, written by the REAL finalize entrypoint: ${JSON.stringify(recs)}`);
  assert.strictEqual(terminals[0].outcome, 'skipped');
  const ownership = recs.find((r) => r.type === 'ownership');
  assert.ok(ownership, 'the minting dispatcher\'s own owner_token was adopted by finalize.py');
  assert.strictEqual(terminals[0].by, ownership.owner_token, 'one continuous owner_token (shell-mint -> finalize.py adopt -> terminal)');
  assert.strictEqual(act.probeBusy(act.ownerLockPath(home, activityId)), false, 'owner.lock released once the whole dispatcher process tree exited');
});

test('root contention, MANUAL (inherited) path: the dispatcher exits 75 WITHOUT finalizing; Electron\'s own runSync-reject onContention is the sole finalizer', { timeout: 20000 }, async (t) => {
  if (!requirePython(t)) return;
  const home = tmpHome(t);
  setupChain(home, 'stable');
  const L = layout(home, 'stable');

  const { writer, lockFd } = glue.beginManualActivity(home, { channel: 'stable', trigger: 'manual' });
  const activityId = writer.activityId;
  const ownerToken = writer._lease.ownerToken;

  let onChildFired = false;
  await withLock(L.execLock, 0, async () => {
    let rejected = null;
    try {
      await runSync({
        home, channel: 'stable',
        env: { ...writer.handOffEnv(), HOME: home },
        lockFd,
        onChild: () => { onChildFired = true; },
      });
    } catch (e) { rejected = e; }
    assert.ok(rejected, 'runSync must reject on manual-path root contention');
    assert.strictEqual(rejected.code, 75, `expected LockBusy(75), got: ${rejected}`);
  });
  assert.strictEqual(onChildFired, false, 'never reached the fd-3 handshake -- the dispatcher never even resolved/verified `current`, let alone bootstrapped or execed');

  glue.onContention(writer, 'root-busy');

  const recs = readAllRecords(home, activityId);
  const terminals = recs.filter((r) => r.type === 'terminal');
  assert.strictEqual(terminals.length, 1, `exactly one terminal, written by Electron alone: ${JSON.stringify(recs)}`);
  assert.strictEqual(terminals[0].outcome, 'skipped');
  assert.strictEqual(terminals[0].by, ownerToken);
  assert.strictEqual(act.probeBusy(act.ownerLockPath(home, activityId)), false, 'owner.lock released by Electron\'s own terminal()');
});

// ---------------------------------------------------------------------------------------------
// 4. Failed descriptor validation (manual path): an "unlocked look-alike" fd -- the RIGHT file
//    (fstat identity, lease.adopt step 2, passes) but a foreign open-file-description that never
//    held the flock, so the REAL step-4 reassert genuinely fails (no mocking: the real writer's
//    fd keeps the real lock held throughout, so the look-alike fd's own flock attempt really does
//    conflict with it at the kernel level). Electron alone finalizes `failed`; the worker is never
//    signalled (it already exited on its own, by exit code, not by any signal).
// ---------------------------------------------------------------------------------------------

test('failed descriptor validation (manual path): python adopter rejects an unlocked look-alike fd for real, exits 66 with no ack; Electron is the sole finalizer of `failed`', { timeout: 20000 }, async (t) => {
  if (!requirePython(t)) return;
  const home = tmpHome(t);
  setupChain(home, 'stable');

  const { writer, lockFd } = glue.beginManualActivity(home, { channel: 'stable', trigger: 'manual' });
  const activityId = writer.activityId;
  const ownerToken = writer._lease.ownerToken;
  assert.strictEqual(act.probeBusy(act.ownerLockPath(home, activityId)), true, 'sanity: the real lease genuinely holds the flock');

  // The look-alike: a FRESH, independently opened fd on the SAME owner.lock path. Right file
  // (dev/ino match), but a different open-file-description that was never flocked -- `lockFd`
  // (the REAL, held lease fd) is deliberately kept open the whole time so the child's own
  // reassert genuinely conflicts with it.
  const lookAlikeFd = fs.openSync(act.ownerLockPath(home, activityId), 'r+');

  let capturedChild = null;
  const code = await runSync({
    home, channel: 'stable',
    env: { ...writer.handOffEnv(), HOME: home },
    lockFd: lookAlikeFd,
    onChild: (child) => { capturedChild = child; },
  });
  fs.closeSync(lookAlikeFd);

  assert.strictEqual(code, 66, 'the exec\'d python rejected the handoff (HANDOFF_REJECTED_EXIT)');
  assert.ok(capturedChild, 'the dispatcher did reach exec (root lock + fd-3 handshake are unrelated to the activity lease)');
  assert.strictEqual(capturedChild.exitCode, 66);
  assert.strictEqual(capturedChild.signalCode, null, 'the worker exited on its own (sys.exit) -- it was never signalled');

  const beforeHandOff = readAllRecords(home, activityId);
  assert.ok(!beforeHandOff.some((r) => r.type === 'ownership' && r.role === 'handoff'), 'no handoff ack was ever written (write-nothing-on-reject)');
  assert.ok(!beforeHandOff.some((r) => r.type === 'terminal'), 'the python side wrote no terminal at all -- no phantom terminal');

  // The child already exited before handOff() is even called, so its own 'exit' listener would
  // never fire naturally -- shrink the ack-wait so this test doesn't eat the full 5s default
  // (an intentional test seam per trigger-glue.js's own header comment).
  const origTimeout = glue._ackTimeoutMs;
  const origPoll = glue._ackPollMs;
  glue._ackTimeoutMs = 300;
  glue._ackPollMs = 15;
  try {
    await glue.handOff({ writer, child: capturedChild, home });
  } finally {
    glue._ackTimeoutMs = origTimeout;
    glue._ackPollMs = origPoll;
  }

  const after = readAllRecords(home, activityId);
  const terminals = after.filter((r) => r.type === 'terminal');
  assert.strictEqual(terminals.length, 1, `exactly one terminal, written by Electron (the sole remaining authority): ${JSON.stringify(after)}`);
  assert.strictEqual(terminals[0].outcome, 'failed');
  assert.strictEqual(terminals[0].by, ownerToken);
  assert.strictEqual(act.probeBusy(act.ownerLockPath(home, activityId)), false, 'owner.lock released once Electron finalized');
});

// ---------------------------------------------------------------------------------------------
// 5 & 6. Simulated crash -> interrupted; cancel -> cancelled. Both let the REAL exec'd python
//    durably adopt (proving the exec-chain lease survival + owner_token continuity one more time,
//    under a completely different failure mode) before SIGKILLing it, then hand reconciliation to
//    the real Node reconciler (`reconcile.synthesizeTerminal`, the same function
//    trigger-glue.js's own handOff() b2 branch uses in production).
// ---------------------------------------------------------------------------------------------

// Codex B5, defect 2: resolves the FIRST time a child becomes terminal, however that happens.
// Node sets `exitCode`/`signalCode` synchronously the moment a child becomes terminal, strictly
// BEFORE the async 'exit' event is emitted -- so checking them first, then falling back to an
// 'exit' listener, can never miss a child that already terminated before this attaches. The OLD
// version of this scenario attached its 'exit' listener only right before the kill -- well after
// the child could already have exited on its own for an unrelated reason (e.g. a fast dependency
// check failure with a non-deps-complete interpreter) -- so the listener raced an already-
// terminal child and the wait hung until the test timeout. Attaching via this helper the moment
// `capturedChild` exists (before anything else touches the child) closes that race.
function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function crashScenario(t, { cancelFirst }) {
  const home = tmpHome(t);
  setupChain(home, 'stable');
  // No config at all -- irrelevant here, since the process is killed long before it would ever
  // reach config load (a real network-connectivity wait alone takes several seconds; adoption
  // happens within milliseconds of process start).

  const { writer, lockFd } = glue.beginManualActivity(home, { channel: 'stable', trigger: 'manual' });
  const activityId = writer.activityId;
  const ownerToken = writer._lease.ownerToken;

  let handOffPromise;
  let capturedChild = null;
  let childExitPromise = null;
  const runPromise = runSync({
    home, channel: 'stable',
    env: { ...writer.handOffEnv(), HOME: home },
    lockFd,
    onChild: (child) => {
      capturedChild = child;
      // Attach BEFORE anything else that could let the child exit (Codex B5, defect 2) --
      // in particular before glue.handOff() below, which itself watches the child.
      childExitPromise = waitForChildExit(child);
      handOffPromise = glue.handOff({ writer, child, home });
    },
  });

  // Wait for the REAL exec'd python to durably adopt (the handoff ownership record on disk) --
  // this is the proof the lease survived spawn-inheritance + exec, BEFORE we ever touch the
  // process. Only after that do we crash it. (`start` is necessarily already durable too --
  // Electron's beginManualActivity() above writes it before spawning at all -- so a positive
  // handoff-ownership read is itself proof of "durable start+ownership, no terminal yet".)
  await waitFor(() => readAllRecords(home, activityId).some((r) => r.type === 'ownership' && r.role === 'handoff'));
  const handoffRec = readAllRecords(home, activityId).find((r) => r.type === 'ownership' && r.role === 'handoff');
  assert.strictEqual(handoffRec.owner_token, ownerToken, 'the adopted owner_token is the same one Electron minted, even in the crash path');

  if (cancelFirst) {
    glue.onCancel({ writer, home }); // records control(cancel_requested); no child passed -> no signal sent here
    await waitFor(() => readAllRecords(home, activityId).some((r) => r.type === 'control' && r.name === 'cancel_requested'));
  }

  assert.ok(capturedChild && typeof capturedChild.pid === 'number', 'have a real child pid to kill');
  // The whole point of this scenario is a SIGKILL while the worker is still genuinely running --
  // assert that positively (rather than let a child that already exited on its own for an
  // unrelated reason silently masquerade as "crashed"), so a real regression upstream (e.g. an
  // unexpectedly fast exit) fails LOUDLY here instead of quietly invalidating the scenario or
  // hanging until the test timeout.
  assert.strictEqual(capturedChild.exitCode, null,
    `the worker must still be running before the simulated crash, but it already exited with code=${capturedChild.exitCode}`);
  assert.strictEqual(capturedChild.signalCode, null,
    `the worker must still be running before the simulated crash, but it already died via signal=${capturedChild.signalCode}`);
  capturedChild.kill('SIGKILL'); // a real crash: dies by SIGNAL, not via the 66 rejection exit path
  await childExitPromise;

  await handOffPromise; // Electron's own hand-off settles (ack was already observed -> drop-only)
  await runPromise.catch(() => {});

  assert.strictEqual(act.probeBusy(act.ownerLockPath(home, activityId)), false,
    'owner.lock is FREE: Electron already dropped its reference (ack observed), and the killed child was the sole remaining holder');

  const before = readAllRecords(home, activityId);
  assert.ok(!before.some((r) => r.type === 'terminal'), 'no terminal exists yet -- the worker was killed before it could write one');

  const synthesized = act.reconcile.synthesizeTerminal(home, activityId);
  assert.strictEqual(synthesized, true, 'the reconciler wrote a synthetic terminal');

  const after = readAllRecords(home, activityId);
  const terminals = after.filter((r) => r.type === 'terminal');
  assert.strictEqual(terminals.length, 1, `exactly one synthesized terminal: ${JSON.stringify(after)}`);
  assert.strictEqual(terminals[0].by, 'reconciler');
  assert.strictEqual(act.probeBusy(act.ownerLockPath(home, activityId)), false, 'still free after reconciliation');
  return terminals[0];
}

test('simulated crash -> interrupted: SIGKILL after a real handoff, then reconcile.synthesizeTerminal writes a durable `interrupted` terminal (also covers a non-66 crash exit: the child dies by signal, never through the 66 rejection path)', { timeout: 20000 }, async (t) => {
  if (!requirePython(t)) return;
  const terminal = await crashScenario(t, { cancelFirst: false });
  assert.strictEqual(terminal.outcome, 'interrupted');
});

test('cancel -> cancelled: a control{cancel_requested} record lands before the kill, so reconcile.synthesizeTerminal synthesizes `cancelled` instead of `interrupted`', { timeout: 20000 }, async (t) => {
  if (!requirePython(t)) return;
  const terminal = await crashScenario(t, { cancelFirst: true });
  assert.strictEqual(terminal.outcome, 'cancelled');
});
