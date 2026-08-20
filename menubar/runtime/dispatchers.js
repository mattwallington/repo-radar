'use strict';
const fs = require('fs');
const { layout, cliPath } = require('./paths');

// Generic, self-verifying POSIX-sh dispatcher. Acquires the root execution lock
// (fd-mode lockf, -t 0) FIRST, then resolves `current` and validates the marker
// against desired.json + live VERSION/launcher hashes, then execs the venv python
// against the resolved generation (inheriting the locked fd 9 for the child's life).
// `channel` is baked in; everything else resolves at run time. `tail` is the args
// appended to the launcher invocation (sync mode adds `sync --status-server`).
function _script(channel, tail) {
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
mkdir -p "$ROOT" 2>/dev/null || true
# --- Activity History (Task 2.4): mint-or-inherit the activity lease BEFORE the root lock, so a
# root-lock-busy reject and a later dev/verify guard failure both have identity to finalize
# against. Manual/Electron path: REPO_RADAR_ACTIVITY_ID/_OWNER_TOKEN/_LOCK_FD already arrived via
# env + fd-inheritance (runSync remaps the parent's held fd to child fd 4) -- inherit, never mint.
# Scheduled/launchd/CLI path: mint our own identity and hold our own lease on fd 4 (same
# open-then-lockf pattern as the root .exec.lock just below, on a private fd/file). Every step is
# set -e-safe (guarded by if/&&, never a bare failing statement) and best-effort -- activity
# recording must never abort or delay the sync itself.
_ACT_MINTED=""
if [ -z "\${REPO_RADAR_ACTIVITY_ID:-}" ]; then
  _AID="$(/usr/bin/uuidgen 2>/dev/null | tr 'A-F' 'a-f' || true)"
  _ATOK="$(/usr/bin/openssl rand -hex 4 2>/dev/null || true)"
  if [ -n "$_AID" ] && [ -n "$_ATOK" ]; then
    mkdir -p "$HOME/Library/Logs/repo-radar" 2>/dev/null || true
    mkdir -m 700 "$HOME/Library/Logs/repo-radar/activity" 2>/dev/null || true
    _ADIR="$HOME/Library/Logs/repo-radar/activity/$_AID"
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
# A resolvable interpreter + PYTHONPATH for the activity subsystem's OWN use (bootstrap/finalize
# below) -- deliberately UNVERIFIED (no anchor-hash / healthy-predicate check against it): the
# motivating failure is a runtime that EXECUTES but is later rejected by the trust checks below,
# and Activity recording must survive that (this interpreter only ever runs repo_radar.activity.*,
# never the real sync). repo_radar is copied SOURCE in the generation, not an installed
# distributable package, so it needs PYTHONPATH=<gen> to import (same as the generation's own
# smoke test). Empty when unresolvable (no active runtime yet, or a missing/non-executable venv
# python).
_ACT_PY=""
_ACT_GENDIR=""
if [ -n "\${REPO_RADAR_ACTIVITY_ID:-}" ] && [ -L "$CUR" ]; then
  _ACAND="$(cd "$CUR" && pwd -P 2>/dev/null || true)"
  if [ -n "$_ACAND" ] && [ -x "$_ACAND/venv/bin/python" ]; then
    _ACT_PY="$_ACAND/venv/bin/python"
    _ACT_GENDIR="$_ACAND"
  fi
fi
# Last-resort (finding 1): the activity python cannot execute at all -- ONE bounded, redacted line
# to the System diagnostic stream, NEVER an un-quota'd Activity segment. The stage argument is
# always one of a small set of fixed words (never free text); channel/trigger are themselves fixed
# values -- this line can never carry a secret or unbounded user data.
_act_last_resort() {
  _ELOG="$HOME/Library/Logs/repo-radar/sync.error.log"
  mkdir -p "$(dirname "$_ELOG")" 2>/dev/null || true
  printf '%s repo-radar: activity recording unavailable (channel=%s trigger=%s stage=%s)\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)" "$CH" "$REPO_RADAR_TRIGGER" "$1" >> "$_ELOG" 2>/dev/null || true
}
# --- acquire the ROOT execution lock FIRST (fd 9 rides the exec'd worker) ---
exec 9>"$ROOT/.exec.lock"
if /usr/bin/lockf -t 0 9; then :; else
  # Root-lock contention: SCHEDULED path only finalizes "skipped" here -- exactly one terminal
  # authority (Round-3 #2). The manual path leaves it to Electron's own runSync reject handler, so
  # a manual double-click never produces two terminals for the same busy attempt.
  if [ -n "$_ACT_MINTED" ]; then
    if [ -n "$_ACT_PY" ]; then
      PYTHONPATH="$_ACT_GENDIR" "$_ACT_PY" -m repo_radar.activity.finalize --kind sync --channel "$CH" --trigger "$REPO_RADAR_TRIGGER" --outcome skipped >/dev/null 2>&1 || true
    else
      _act_last_resort skipped
    fi
  fi
  echo "repo-radar: another sync is running" >&2
  exit 75
fi
# handshake: signal a Node parent (runSync) that the lock is ACQUIRED, via fd 3. The
# group + 2>/dev/null makes it a clean no-op when fd 3 isn't open (launchd/CLI/direct).
# The worker may inherit fd 3 harmlessly; runSync only needs the one byte, not the close.
{ printf 'L' >&3; } 2>/dev/null || true
# Activity History (Task 2.4): scheduled-path bootstrap -- BEFORE the dev guard/verify checks
# below, so a run later BLOCKED by those guards still gets a durable \`start\` (the motivating
# failure: "blocked before Python ever ran" must not mean "never recorded"). Manual path: never
# bootstrap here -- the exec'd python (cli.py/sync_mode, Tasks 2.5/2.6) is the adopter, and its
# own handoff \`ownership\` write IS Electron's ack.
if [ -n "$_ACT_MINTED" ]; then
  if [ -n "$_ACT_PY" ]; then
    PYTHONPATH="$_ACT_GENDIR" "$_ACT_PY" -m repo_radar.activity.bootstrap --kind sync --channel "$CH" --trigger "$REPO_RADAR_TRIGGER" >/dev/null 2>&1 || true
  else
    _act_last_resort start
  fi
fi
# Activity History (Task 2.4): a dev/verify guard failure below finalizes \`blocked\` before this
# script exits -- on the manual path that terminal ALSO satisfies Electron's handOff ack (it waits
# for ownership-handoff OR any terminal). An EXIT trap (rather than touching each of the guards'
# many individual exit points below) keeps every existing guard message/exit-code byte-for-byte
# unchanged; it never fires on the root-lock-busy branch above (already exited before the trap is
# installed) or on the final \`exec\` below (\`exec\` replaces the process image -- no shell EXIT
# ever occurs). Best-effort: the reason is one of two fixed phase words, never free text.
_ACT_PHASE="dev_guard"
_act_guard_blocked() {
  _rc=$?
  if [ "$_rc" -ne 0 ] && [ -n "\${REPO_RADAR_ACTIVITY_ID:-}" ] && [ -n "$_ACT_PY" ]; then
    PYTHONPATH="$_ACT_GENDIR" "$_ACT_PY" -m repo_radar.activity.finalize --kind sync --channel "$CH" --trigger "$REPO_RADAR_TRIGGER" --outcome blocked --reason "$_ACT_PHASE" >/dev/null 2>&1 || true
  fi
  exit "$_rc"
}
trap _act_guard_blocked 0
${devGuard}_ACT_PHASE="runtime_verify"
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
exec "$GEN/venv/bin/python" "$GEN/repo-radar"${tail} "$@"
`;
}

function _atomicWrite(p, content, mode) {
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, p);
}

// The scheduled/manual sync runner: appends `sync --status-server`.
function emitRunSync(home, channel) {
  const p = layout(home, channel).runSync;
  fs.mkdirSync(require('path').dirname(p), { recursive: true, mode: 0o700 });
  _atomicWrite(p, _script(channel, ' sync --status-server'), 0o700);
  return p;
}

// The CLI dispatcher (`repo-radar` / `repo-radar-dev`): forwards all args verbatim.
function emitCliDispatcher(home, channel) {
  const p = cliPath(home, channel);
  fs.mkdirSync(require('path').dirname(p), { recursive: true, mode: 0o700 });
  _atomicWrite(p, _script(channel, ''), 0o700);
  return p;
}

module.exports = { emitRunSync, emitCliDispatcher, _script };
