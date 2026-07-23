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
// (non-destructive) ONLY after the stable dispatcher is in place AND a current
// activation exists (Codex R1-4 / R2-1). Returns the moved-to path, or null if
// there is nothing to retire or the guards aren't satisfied yet.
function retireLegacyLauncher(home, { now = Date.now() } = {}) {
  const legacy = path.join(home, '.repo-radar', 'repo-radar');
  if (!fs.existsSync(legacy)) return null;
  // The generic stable dispatcher must already own the PATH CLI first (it overwrites the
  // legacy ~/.local/bin/repo-radar symlink) — then retiring is safe even pre-first-activation,
  // so a bootstrap identity failure still neutralizes the legacy launcher (Codex Crit1).
  if (!fs.existsSync(cliPath(home, 'stable'))) return null;
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
