'use strict';
const fs = require('fs');
const path = require('path');
const { emitCliDispatcher } = require('./dispatchers');
const { cliPath } = require('./paths');

// Install the generic CLI dispatcher: stable -> repo-radar, dev -> repo-radar-dev.
function installDispatcher(home, channel) {
  return emitCliDispatcher(home, channel);
}

// STABLE-ONLY: move the legacy 1.0.26 ~/.repo-radar/repo-radar launcher aside
// (non-destructive). By default this requires the generic stable dispatcher to already
// own the PATH CLI (so `repo-radar` still resolves to a runnable dispatcher, Codex
// R1-4/R2-1); it does NOT require a current activation. `failClosed` retires even before
// the dispatcher exists (Codex round-9). Returns the moved-to path, or null if there is
// nothing to retire or (default only) the dispatcher guard isn't met.
function retireLegacyLauncher(home, { now = Date.now(), failClosed = false } = {}) {
  const legacy = path.join(home, '.repo-radar', 'repo-radar');
  if (!fs.existsSync(legacy)) return null;
  // Normally we retire only AFTER the generic dispatcher owns the PATH CLI (it overwrites the
  // legacy ~/.local/bin/repo-radar symlink), so `repo-radar` on PATH always resolves to a
  // runnable dispatcher (Codex R1-4/R2-1). But on a FAIL-CLOSED bootstrap (Codex round-9) the
  // hard-block contract prefers a temporarily-dangling PATH symlink over serving stale Python if
  // the dispatcher install fails — so `failClosed` skips that guard and retires unconditionally.
  if (!failClosed && !fs.existsSync(cliPath(home, 'stable'))) return null;
  const dst = path.join(home, '.repo-radar', `legacy-${now}`);
  fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
  const movedTo = path.join(dst, 'repo-radar');
  fs.renameSync(legacy, movedTo); // move, never delete
  return movedTo;
}

// Durably neutralize the legacy 1.0.26 stable SCHEDULE (Codex round-4 Crit1): move the
// LaunchAgent plist + its wrapper aside so launchd can't reload them at next login,
// regardless of what path they embed (home launcher OR the app's bundled resources path).
// fs-only (no launchctl), so it runs even when the launchctl bootout is skipped/absent.
// On a successful activation the managed plist is (re)created by Electron; on failure the
// legacy schedule stays disabled -> fail closed.
function disableLegacySchedule(home) {
  const moved = [];
  const targets = [
    path.join(home, 'Library', 'LaunchAgents', 'com.user.repo-radar.plist'),
    path.join(home, '.config', 'repo-radar', 'run-sync.sh'),
  ];
  for (const p of targets) {
    if (fs.existsSync(p)) {
      const dst = `${p}.legacy-disabled`;
      try { fs.rmSync(dst, { force: true }); } catch (_) { /* */ }
      fs.renameSync(p, dst);
      moved.push(dst);
    }
  }
  return moved;
}

module.exports = { installDispatcher, retireLegacyLauncher, disableLegacySchedule };
