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
# --- acquire the ROOT execution lock FIRST (fd 9 rides the exec'd worker) ---
exec 9>"$ROOT/.exec.lock"
/usr/bin/lockf -t 0 9 || { echo "repo-radar: another sync is running" >&2; exit 75; }
# handshake: signal a Node parent (runSync) that the lock is ACQUIRED, via fd 3. The
# group + 2>/dev/null makes it a clean no-op when fd 3 isn't open (launchd/CLI/direct).
# The worker may inherit fd 3 harmlessly; runSync only needs the one byte, not the close.
{ printf 'L' >&3; } 2>/dev/null || true
${devGuard}# --- only AFTER the lock do we resolve + verify current ---
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

module.exports = { emitRunSync, emitCliDispatcher };
