'use strict';
const fs = require('fs');
const { layout, cliPath } = require('./paths');

// Generic, self-verifying POSIX-sh dispatcher. Acquires the root execution lock
// (fd-mode lockf, -t 0) FIRST, then resolves `current` and validates the marker
// against desired.json + live VERSION/launcher hashes, then execs the venv python
// against the resolved generation (inheriting the locked fd 9 for the child's life).
// `channel` is baked in; everything else resolves at run time. `tail` is the args
// appended to the launcher invocation (sync mode adds `sync --status-server`).
//
// Activity History (Task 2.4, fix round 1): `withActivity` originally scoped the ENTIRE
// activity lifecycle to the sync runner only (`emitRunSync`), generating NONE of it for the
// generic CLI dispatcher. Codex's Phase-2 gate (fix round 2, Ruling 16/B1 + Ruling 17/B2)
// found that design still had two BLOCKERs, both fixed here:
//
//  B1 -- durable identity before EVERY shell gate:
//   (a) the durable `start` (the bootstrap write) now runs BEFORE the root `.exec.lock`
//       acquisition -- right after mint-or-inherit, not after it -- so a root-contention
//       loser (`exit 75`) always has a real `start` to finalize `skipped` against.
//       Previously bootstrap ran AFTER the root lock, so a contention loser had a minted
//       lease but no durable start; its `finalize --outcome skipped` was a
//       terminal-with-no-start (invalid, refused) and the attempt was silently lost.
//   (b) the installed CLI dispatcher (`emitCliDispatcher`, used for EVERY subcommand --
//       `--version`/`analyze`/`configure`/`clean`/`sync`) now ALSO carries the activity
//       lifecycle source, but gated at RUNTIME by a `_ACT_ON` variable instead of omitted at
//       GENERATION time: `emitRunSync` sets `_ACT_ON=1` unconditionally (its tail IS the
//       hardcoded `sync` subcommand -- there is no `$1` to inspect); `emitCliDispatcher` sets
//       it only when the CALLER's own `$1` is literally `sync`
//       (`if [ "${1:-}" = sync ]; then _ACT_ON=1; fi`). Every activity step (mint, the
//       moved-up bootstrap, the trap install, the contention finalize, the guard-blocked
//       finalize, the last-resort) is wrapped in `if [ -n "${_ACT_ON:-}" ]; then ... fi`, so
//       `repo-radar sync` from a terminal now gets identity-before-gates exactly like the
//       scheduled runner, while `repo-radar --version`/`analyze`/`configure`/`clean` still
//       execute NONE of it at runtime -- same end behavior as the Ruling-13 fix, just reached
//       by a runtime skip instead of the code never having been emitted.
//
//  B2 -- the scheduled/CLI shell mint refuses a symlinked activity root: before the mint
//   `mkdir`/open, a `test -L` walk checks the activity root (`~/Library/Logs/repo-radar/
//   activity`) and every ancestor down to `$HOME/Library/Logs` for a symlink -- the sh
//   equivalent of the accepted Node non-destructive lstat-walk (menubar/activity/paths.js).
//   On any hit, mint refuses outright: nothing is created under the suspect path, and
//   activity degrades best-effort -- the sync itself still proceeds untouched.
//
// Manual (Electron-inherited) path is unchanged: Electron establishes identity BEFORE
// spawning (menubar/activity/trigger-glue.js), so the shell only ever INHERITS via env; it
// never mints, regardless of `_ACT_ON`.
function _script(channel, tail, { activityGate = 'cli' } = {}) {
  // dev must not touch the shared data plane unless stable is provably managed AND healthy
  // (Codex I3). Runs UNDER the root lock (no TOCTOU) and validates stable via its OWN
  // anchored verify.py — NOT ~/.local/bin/repo-radar presence (that IS the managed stable
  // dispatcher). Only the legacy launcher ~/.repo-radar/repo-radar signals an unmanaged stable.
  const devGuard = channel === 'dev' ? `
if [ -e "$ROOT/repo-radar" ]; then
  echo "repo-radar-dev: legacy stable install present; run dev in an isolated HOME" >&2; exit 1
fi
# unloaded-but-installed old stable can reload its own plist outside the root lock. Inspect
# the EXACT ProgramArguments[0] (raw, not json — avoids plutil's / -> \\/ escaping) + the
# LOADED job's actual first argument, and fail closed on ambiguous launchctl errors (round-7).
SPLIST="$HOME/Library/LaunchAgents/com.user.repo-radar.plist"
if [ -f "$SPLIST" ]; then
  SPROG="$(/usr/bin/plutil -extract ProgramArguments.0 raw -o - "$SPLIST" 2>/dev/null || true)"
  [ "$SPROG" = "$ROOT/stable/run-sync.sh" ] \\
    || { echo "repo-radar-dev: stable LaunchAgent does not launch the managed runner; run dev in an isolated HOME" >&2; exit 1; }
fi
# capture inside an if-condition so set -e does NOT abort on a nonzero launchctl (a missing
# service exits 113) before we can classify it (Codex round-7 finding 3).
if LP="$(launchctl print "gui/$(id -u)/com.user.repo-radar" 2>&1)"; then LPRC=0; else LPRC=$?; fi
if [ "$LPRC" -eq 0 ]; then
  # REAL macOS launchctl print has a "program = <path>" line and an "arguments = { <path> }"
  # block with NO "0 =>" index — parse the program field, which is ProgramArguments[0].
  LPROG="$(printf '%s\\n' "$LP" | awk -F' = ' '/^[[:space:]]*program[[:space:]]*=/{print $2; exit}')"
  [ "$LPROG" = "$ROOT/stable/run-sync.sh" ] \\
    || { echo "repo-radar-dev: a stale stable job is loaded; run dev in an isolated HOME" >&2; exit 1; }
elif ! printf '%s' "$LP" | grep -qi 'could not find'; then
  echo "repo-radar-dev: cannot verify stable launchd state; run dev in an isolated HOME" >&2; exit 1
fi
# a legacy 1.0.26 stable sync (home launcher, ~/.config wrapper, or the app's BUNDLED launcher)
# IGNORES the root lock and can corrupt the shared data plane even while we hold it — refuse if
# one is running, and FAIL CLOSED if ps itself fails (Codex round-7 §2). This guards the CLI /
# transient-launchd path, which never runs Electron's detectStableManaged().
if ! SPS="$(ps -axo command 2>/dev/null)"; then
  echo "repo-radar-dev: cannot scan for legacy processes; run dev in an isolated HOME" >&2; exit 1
fi
if printf '%s\\n' "$SPS" | awk -v L="$HOME/.repo-radar/repo-radar" -v W="$HOME/.config/repo-radar/run-sync.sh" '
    index($0, L" ") || substr($0, length($0)-length(L)+1)==L || index($0, W) || /\\/Contents\\/Resources\\/resources\\/repo-radar([ \\t]|$)/ {f=1}
    END { exit(f?0:1) }'; then
  echo "repo-radar-dev: a legacy stable sync is running; run dev in an isolated HOME" >&2; exit 1
fi
SCUR="$ROOT/stable/current"; SDES="$ROOT/stable/desired.json"
{ [ -L "$SCUR" ] && [ -f "$SDES" ] && [ -f "$ROOT/stable/run-sync.sh" ] && grep -q '"status": *"active"' "$SDES"; } \\
  || { echo "repo-radar-dev: stable is not managed; run dev in an isolated HOME" >&2; exit 1; }
SGEN="$(cd "$SCUR" && pwd -P)"
SGENS="$(cd "$ROOT/stable/generations" 2>/dev/null && pwd -P || echo /nonexistent)"
case "$SGEN" in "$SGENS/"*) : ;; *) echo "repo-radar-dev: stable runtime outside tree" >&2; exit 1 ;; esac
SAPP="/Applications/Repo Radar.app/Contents/Resources/VERSION"
if [ -f "$SAPP" ] && [ -f "$SGEN/VERSION" ] && [ "$(cat "$SAPP" 2>/dev/null)" != "$(cat "$SGEN/VERSION" 2>/dev/null)" ]; then
  echo "repo-radar-dev: installed stable app version != managed runtime; run dev in an isolated HOME" >&2; exit 1
fi
# anchor stable's verify.py + manifest against stable's desired BEFORE executing it
SVSHA="$(/usr/bin/shasum -a 256 "$SGEN/verify.py" | awk '{print $1}')"
SMSHA="$(/usr/bin/shasum -a 256 "$SGEN/manifest.json" | awk '{print $1}')"
grep -q "\\"verifySha\\": *\\"$SVSHA\\"" "$SDES" || { echo "repo-radar-dev: stable verifier hash mismatch" >&2; exit 1; }
grep -q "\\"manifestSha\\": *\\"$SMSHA\\"" "$SDES" || { echo "repo-radar-dev: stable manifest hash mismatch" >&2; exit 1; }
"$SGEN/venv/bin/python" "$SGEN/verify.py" "$SGEN" "$SDES" "$SGEN/manifest.json" \\
  || { echo "repo-radar-dev: stable runtime is not healthy; run dev in an isolated HOME" >&2; exit 1; }
` : '';
  // Fix-A/B1(b): `_ACT_ON` decides, AT RUNTIME, whether THIS invocation participates in the
  // activity lifecycle at all -- every activity step below is wrapped in
  // `if [ -n "${_ACT_ON:-}" ]; then ... fi`. `activityGate: 'always'` (emitRunSync) hardcodes
  // it on: the tail IS the literal `sync` subcommand, so there's no `$1` worth inspecting.
  // `activityGate: 'cli'` (emitCliDispatcher) inspects the CALLER's own first argument, so
  // `repo-radar sync` opts in while every other subcommand stays fully activity-free.
  const actGateSet = activityGate === 'always'
    ? `_ACT_ON=1\n`
    : `if [ "\${1:-}" = sync ]; then _ACT_ON=1; fi\n`;
  // Activity History (Task 2.4; reordered under Fix-A/B1(a)): mint-or-inherit the activity
  // lease. Manual/Electron path: REPO_RADAR_ACTIVITY_ID/_OWNER_TOKEN/_LOCK_FD already arrived
  // via env + fd-inheritance (runSync remaps the parent's held fd to child fd 4) -- inherit,
  // never mint. Scheduled/launchd/CLI-sync path: mint our own identity and hold our own lease
  // on fd 4 (same open-then-lockf pattern as the root .exec.lock just below, on a private
  // fd/file). Every step is set -e-safe (guarded by if/&&, never a bare failing statement) and
  // best-effort -- activity recording must never abort or delay the sync itself. Wrapped in
  // `_ACT_ON` (Fix-A/B1(b)): a non-sync CLI invocation runs none of this.
  const actMint = `if [ -n "\${_ACT_ON:-}" ]; then
  # --- Activity History (Task 2.4): mint-or-inherit the activity lease ---
  _ACT_MINTED=""
  if [ -z "\${REPO_RADAR_ACTIVITY_ID:-}" ]; then
    _AID="$(/usr/bin/uuidgen 2>/dev/null | tr 'A-F' 'a-f' || true)"
    _ATOK="$(/usr/bin/openssl rand -hex 4 2>/dev/null || true)"
    if [ -n "$_AID" ] && [ -n "$_ATOK" ]; then
      # Fix-A/B2: refuse a symlinked activity root before minting anything under it -- a
      # \`test -L\` walk from a trusted prefix ($HOME/Library/Logs) down to the activity root
      # (the sh equivalent of the accepted Node non-destructive lstat-walk in
      # menubar/activity/paths.js; the residual validate-then-create TOCTOU is the same
      # bounded one the Node side already accepts). A symlinked
      # ~/Library/Logs/repo-radar/activity can no longer place the minted UUID dir (and its
      # owner.lock/segments) outside the owned tree. On refusal: mint NOTHING under the
      # suspect path, and degrade best-effort -- the sync itself still proceeds untouched.
      _ACT_ROOT="$HOME/Library/Logs/repo-radar/activity"
      _ACT_SAFE=1
      for _ACT_ANC in "$HOME/Library/Logs" "$HOME/Library/Logs/repo-radar" "$_ACT_ROOT"; do
        if [ -L "$_ACT_ANC" ]; then _ACT_SAFE=""; fi
      done
      if [ -n "$_ACT_SAFE" ]; then
        mkdir -p "$HOME/Library/Logs/repo-radar" 2>/dev/null || true
        mkdir -m 700 "$_ACT_ROOT" 2>/dev/null || true
        _ADIR="$_ACT_ROOT/$_AID"
        if mkdir -m 700 "$_ADIR" 2>/dev/null && touch "$_ADIR/owner.lock" 2>/dev/null && chmod 600 "$_ADIR/owner.lock" 2>/dev/null && exec 4>"$_ADIR/owner.lock"; then
          if /usr/bin/lockf -t 0 4 2>/dev/null; then
            export REPO_RADAR_ACTIVITY_ID="$_AID"
            export REPO_RADAR_ACTIVITY_OWNER_TOKEN="$_ATOK"
            export REPO_RADAR_ACTIVITY_LOCK_FD=4
            _ACT_MINTED=1
          else
            exec 4>&- 2>/dev/null || true
          fi
        fi
      fi
    fi
  fi
  # A resolvable interpreter + PYTHONPATH for the activity subsystem's OWN use (bootstrap/
  # finalize below) -- deliberately UNVERIFIED (no anchor-hash / healthy-predicate check
  # against it): the motivating failure is a runtime that EXECUTES but is later rejected by
  # the trust checks below, and Activity recording must survive that (this interpreter only
  # ever runs repo_radar.activity.*, never the real sync). repo_radar is copied SOURCE in the
  # generation, not an installed distributable package, so it needs PYTHONPATH=<gen> to
  # import (same as the generation's own smoke test). Empty when unresolvable (no active
  # runtime yet, or a missing/non-executable venv python).
  _ACT_PY=""
  _ACT_GENDIR=""
  if [ -n "\${REPO_RADAR_ACTIVITY_ID:-}" ] && [ -L "$CUR" ]; then
    _ACAND="$(cd "$CUR" && pwd -P 2>/dev/null || true)"
    if [ -n "$_ACAND" ] && [ -x "$_ACAND/venv/bin/python" ]; then
      _ACT_PY="$_ACAND/venv/bin/python"
      _ACT_GENDIR="$_ACAND"
    fi
  fi
  # Last-resort (finding 1): the activity python cannot execute at all -- ONE bounded,
  # redacted line to the System diagnostic stream, NEVER an un-quota'd Activity segment. The
  # stage argument is always one of a small set of fixed words (never free text);
  # channel/trigger are themselves fixed values -- this line can never carry a secret or
  # unbounded user data.
  _act_last_resort() {
    _ELOG="$HOME/Library/Logs/repo-radar/sync.error.log"
    mkdir -p "$(dirname "$_ELOG")" 2>/dev/null || true
    printf '%s repo-radar: activity recording unavailable (channel=%s trigger=%s stage=%s)\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)" "$CH" "$REPO_RADAR_TRIGGER" "$1" >> "$_ELOG" 2>/dev/null || true
  }
fi
`;
  // Fix-A/B1(a): the durable `start` (bootstrap) now runs BEFORE the root `.exec.lock`
  // acquisition -- right after mint-or-inherit, not after it -- so identity + a durable
  // `start` exist before the FIRST shell gate (the root-contention check immediately below).
  // A root-lock-busy loser's `finalize --outcome skipped` now always has a real `start` to
  // finalize against; previously bootstrap ran AFTER the root lock, so a contention loser had
  // a minted lease but no durable start and its finalize was a terminal-with-no-start
  // (invalid, refused) -- the attempt was lost. Manual path: never bootstraps here -- the
  // exec'd python (cli.py/sync_mode, Tasks 2.5/2.6) is the adopter, and its own handoff
  // `ownership` write IS Electron's ack. Wrapped in `_ACT_ON` (Fix-A/B1(b)).
  const actBootstrap = `if [ -n "\${_ACT_ON:-}" ] && [ -n "$_ACT_MINTED" ]; then
  if [ -n "$_ACT_PY" ]; then
    PYTHONPATH="$_ACT_GENDIR" "$_ACT_PY" -m repo_radar.activity.bootstrap --kind sync --channel "$CH" --trigger "$REPO_RADAR_TRIGGER" >/dev/null 2>&1 || true
  else
    _act_last_resort start
  fi
fi
`;
  // Root exec-lock acquisition (fd 9) -- the acquisition mechanics (`exec 9>...`; `lockf -t 0
  // 9`) are unconditional for every invocation; only the on-contention body's activity
  // finalize is `_ACT_ON`-gated (Round-3 #2 / Fix-A/B1(b)): the scheduled path AND a CLI-sync
  // invocation finalize "skipped" here -- exactly one terminal authority. The manual path
  // leaves it to Electron's own runSync reject handler, so a manual double-click never
  // produces two terminals for the same busy attempt. By the time this runs, `actBootstrap`
  // has already written the durable `start` (Fix-A/B1(a)), so this finalize always has a real
  // start to close out.
  const rootLockAcquire = `if /usr/bin/lockf -t 0 9; then :; else
  if [ -n "\${_ACT_ON:-}" ] && [ -n "$_ACT_MINTED" ]; then
    if [ -n "$_ACT_PY" ]; then
      PYTHONPATH="$_ACT_GENDIR" "$_ACT_PY" -m repo_radar.activity.finalize --kind sync --channel "$CH" --trigger "$REPO_RADAR_TRIGGER" --outcome skipped >/dev/null 2>&1 || true
    else
      _act_last_resort skipped
    fi
  fi
  echo "repo-radar: another sync is running" >&2
  exit 75
fi`;
  // Activity History (Task 2.4): a dev/verify guard failure below finalizes `blocked` before
  // this script exits -- on the manual path that terminal ALSO satisfies Electron's handOff
  // ack (it waits for ownership-handoff OR any terminal). An EXIT trap (rather than touching
  // each of the guards' many individual exit points below) keeps every existing guard
  // message/exit-code byte-for-byte unchanged; it never fires on the root-lock-busy branch
  // above (already exited before the trap is installed) or on the final `exec` below (`exec`
  // replaces the process image -- no shell EXIT ever occurs). Best-effort: the reason is one
  // of two fixed phase words, never free text. Wrapped in `_ACT_ON` (Fix-A/B1(b)): a non-sync
  // CLI invocation installs no trap at all, so a devGuard/verify failure there is untouched by
  // activity (byte-identical exit code/message to the pre-activity script).
  const actTrap = `if [ -n "\${_ACT_ON:-}" ]; then
  _ACT_PHASE="dev_guard"
  _act_guard_blocked() {
    _rc=$?
    if [ "$_rc" -ne 0 ] && [ -n "\${REPO_RADAR_ACTIVITY_ID:-}" ] && [ -n "$_ACT_PY" ]; then
      PYTHONPATH="$_ACT_GENDIR" "$_ACT_PY" -m repo_radar.activity.finalize --kind sync --channel "$CH" --trigger "$REPO_RADAR_TRIGGER" --outcome blocked --reason "$_ACT_PHASE" >/dev/null 2>&1 || true
    fi
    exit "$_rc"
  }
  trap _act_guard_blocked 0
fi
`;
  const actPhaseReset = `if [ -n "\${_ACT_ON:-}" ]; then _ACT_PHASE="runtime_verify"; fi\n`;
  return `#!/bin/sh
set -eu
ROOT="$HOME/.repo-radar"
CH="${channel}"
# Export the channel so the Python side can scope its completion receipt: without this a dev
# build's receipt would be written as (and could advance) the stable channel's watermark.
export REPO_RADAR_CHANNEL="$CH"
# Declare provenance for a direct dispatcher/CLI invocation, but never override an invoker that
# already declared one — the LaunchAgent sets "scheduled" and that must win.
: "\${REPO_RADAR_TRIGGER:=cli}"
export REPO_RADAR_TRIGGER
CUR="$ROOT/$CH/current"
DES="$ROOT/$CH/desired.json"
${actGateSet}mkdir -p "$ROOT" 2>/dev/null || true
${actMint}${actBootstrap}# --- acquire the ROOT execution lock FIRST (fd 9 rides the exec'd worker) ---
exec 9>"$ROOT/.exec.lock"
${rootLockAcquire}
# handshake: signal a Node parent (runSync) that the lock is ACQUIRED, via fd 3. The
# group + 2>/dev/null makes it a clean no-op when fd 3 isn't open (launchd/CLI/direct).
# The worker may inherit fd 3 harmlessly; runSync only needs the one byte, not the close.
{ printf 'L' >&3; } 2>/dev/null || true
${actTrap}${devGuard}${actPhaseReset}# --- only AFTER the lock do we resolve + verify current ---
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
exec "$GEN/venv/bin/python" "$GEN/repo-radar"${tail} "$@"
`;
}

function _atomicWrite(p, content, mode) {
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, p);
}

// The scheduled/manual sync runner: appends `sync --status-server`. `activityGate: 'always'`
// -- there is no `$1` worth inspecting (the tail IS the hardcoded `sync` subcommand), so
// `_ACT_ON` is simply hardcoded on. See _script()'s doc comment for the full B1/B2 fix-round
// rationale.
function emitRunSync(home, channel) {
  const p = layout(home, channel).runSync;
  fs.mkdirSync(require('path').dirname(p), { recursive: true, mode: 0o700 });
  _atomicWrite(p, _script(channel, ' sync --status-server', { activityGate: 'always' }), 0o700);
  return p;
}

// The CLI dispatcher (`repo-radar` / `repo-radar-dev`): forwards all args verbatim, for EVERY
// subcommand (`--version`, `analyze`, `configure`, `clean`, `sync`, ...). Fix-A/B1(b) (Codex
// Phase-2 gate, Ruling 16): `activityGate: 'cli'` means the activity source is always
// present in the generated script, but RUNTIME-gated on the caller's own `$1` -- only a
// literal `sync` first argument sets `_ACT_ON`, so `repo-radar sync` now gets
// identity-before-gates exactly like the scheduled runner, while every other subcommand still
// executes none of it (same end behavior as the Ruling-13 fix; see _script()'s doc comment).
function emitCliDispatcher(home, channel) {
  const p = cliPath(home, channel);
  fs.mkdirSync(require('path').dirname(p), { recursive: true, mode: 0o700 });
  _atomicWrite(p, _script(channel, '', { activityGate: 'cli' }), 0o700);
  return p;
}

module.exports = { emitRunSync, emitCliDispatcher, _script };
