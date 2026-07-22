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
# --- only AFTER the lock do we resolve + verify current ---
[ -L "$CUR" ] || { echo "repo-radar: no active runtime" >&2; exit 1; }
GEN="$(cd "$CUR" && pwd -P)"
[ -f "$DES" ] && [ -f "$GEN/.runtime.json" ] || { echo "repo-radar: runtime not managed" >&2; exit 1; }
"$GEN/venv/bin/python" - "$GEN" "$DES" <<'PY' || { echo "repo-radar: runtime failed verification" >&2; exit 1; }
import json, sys, hashlib, os
gen, des = sys.argv[1], sys.argv[2]
m = json.load(open(os.path.join(gen, '.runtime.json')))
d = json.load(open(des))
def sh(p):
    with open(p, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()
ok = (m.get('genId') == d.get('genId')
      and m.get('versionSha') == d.get('versionSha')
      and sh(os.path.join(gen, 'VERSION')) == m.get('versionSha')
      and sh(os.path.join(gen, 'repo-radar')) == m.get('launcherSha'))
sys.exit(0 if ok else 1)
PY
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
