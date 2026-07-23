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
# the ACTUAL ProgramArguments (not text elsewhere) + any LOADED job (Codex round-5 §3.3).
SPLIST="$HOME/Library/LaunchAgents/com.user.repo-radar.plist"
if [ -f "$SPLIST" ]; then
  /usr/bin/plutil -extract ProgramArguments json -o - "$SPLIST" 2>/dev/null | grep -q "$ROOT/stable/run-sync.sh" \\
    || { echo "repo-radar-dev: stable LaunchAgent does not launch the managed runner; run dev in an isolated HOME" >&2; exit 1; }
fi
if launchctl print "gui/$(id -u)/com.user.repo-radar" >/dev/null 2>&1; then
  launchctl print "gui/$(id -u)/com.user.repo-radar" 2>/dev/null | grep -q "$ROOT/stable/run-sync.sh" \\
    || { echo "repo-radar-dev: a stale stable job is loaded; run dev in an isolated HOME" >&2; exit 1; }
fi
SCUR="$ROOT/stable/current"; SDES="$ROOT/stable/desired.json"
{ [ -L "$SCUR" ] && [ -f "$SDES" ] && [ -f "$ROOT/stable/run-sync.sh" ] && grep -q '"status": *"active"' "$SDES"; } \\
  || { echo "repo-radar-dev: stable is not managed; run dev in an isolated HOME" >&2; exit 1; }
SGEN="$(cd "$SCUR" && pwd -P)"
SGENS="$(cd "$ROOT/stable/generations" 2>/dev/null && pwd -P || echo /nonexistent)"
case "$SGEN" in "$SGENS/"*) : ;; *) echo "repo-radar-dev: stable runtime outside tree" >&2; exit 1 ;; esac
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
