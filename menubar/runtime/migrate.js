'use strict';
const fs = require('fs');
const path = require('path');
const { emitCliDispatcher } = require('./dispatchers');
const { cliPath, layout } = require('./paths');

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
  if (!fs.existsSync(cliPath(home, 'stable'))) return null; // dispatcher must exist first
  try { fs.lstatSync(layout(home, 'stable').current); } catch (e) { return null; } // need a first activation
  const dst = path.join(home, '.repo-radar', `legacy-${now}`);
  fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
  const movedTo = path.join(dst, 'repo-radar');
  fs.renameSync(legacy, movedTo); // move, never delete
  return movedTo;
}

module.exports = { installDispatcher, retireLegacyLauncher };
