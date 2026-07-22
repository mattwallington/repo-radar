'use strict';
const fs = require('fs');
const path = require('path');
const { layout } = require('./paths');
const { hashTree, hashFile } = require('./hashing');
const { schemaCompatible } = require('./desired');
const { selectFor, verifyInstalledSet } = require('./deps');
const { probe } = require('./interpreter');

function _readMarker(genDir) {
  try { return JSON.parse(fs.readFileSync(path.join(genDir, '.runtime.json'), 'utf8')); }
  catch (e) { return null; }
}

function _activatedPath(home, channel) {
  return path.join(layout(home, channel).channelDir, 'activated.json');
}
function _readActivated(home, channel) {
  try { return new Set(JSON.parse(fs.readFileSync(_activatedPath(home, channel), 'utf8'))); }
  catch (e) { return new Set(); }
}
function _recordActivated(home, channel, genId) {
  const s = _readActivated(home, channel); s.add(genId);
  const p = _activatedPath(home, channel);
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify([...s]), { mode: 0o600 });
  fs.renameSync(tmp, p);
}

// The full healthy predicate (spec §3.3). Returns {ok, reasons:[]}; callers fail
// closed on !ok. `desired` is the published intent record for the channel.
function verifyRuntime({ home, channel, genDir, desired }) {
  const reasons = [];
  const L = layout(home, channel);
  let real;
  try { real = fs.realpathSync(genDir); } catch (e) { return { ok: false, reasons: ['genDir missing'] }; }
  if (!real.startsWith(fs.realpathSync(L.generations) + path.sep)) reasons.push('outside generations tree');

  const marker = _readMarker(genDir);
  if (!marker || !schemaCompatible(marker)) return { ok: false, reasons: [...reasons, 'marker missing/incompatible'] };
  if (!desired || !schemaCompatible(desired)) return { ok: false, reasons: [...reasons, 'desired missing/incompatible'] };

  // current + marker must match desired intent
  for (const k of ['genId', 'versionSha', 'sourceSha', 'launcherSha', 'lockSha']) {
    if (marker[k] !== desired[k]) reasons.push(`marker.${k} != desired.${k}`);
  }
  // live payload must match the marker (catches post-provision tampering)
  try {
    if (hashTree(path.join(genDir, 'repo_radar')) !== marker.sourceSha) reasons.push('live sourceSha != marker');
    if (hashFile(path.join(genDir, 'repo-radar')) !== marker.launcherSha) reasons.push('live launcherSha != marker');
    if (hashFile(path.join(genDir, 'VERSION')) !== marker.versionSha) reasons.push('live versionSha != marker');
  } catch (e) { reasons.push(`payload hash error: ${e.message}`); }

  // interpreter fingerprint + ABI of the venv python match the marker
  const venvPy = path.join(genDir, 'venv', 'bin', 'python');
  const info = probe(venvPy);
  const fp = info ? `${info.impl}-${info.version.join('.')}-${info.arch}` : null;
  if (fp !== marker.fingerprint) reasons.push(`venv fingerprint ${fp} != marker ${marker.fingerprint}`);
  if (marker.abi != null && (!info || info.abi !== marker.abi)) reasons.push(`venv ABI ${info && info.abi} != marker ${marker.abi}`);

  // venv installed set == expected manifest for the env; manifest & marker agree on the lock
  try {
    const { manifestPath } = selectFor(marker.fingerprint);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.lockSha256 != null && manifest.lockSha256 !== marker.lockSha) reasons.push('manifest lockSha256 != marker lockSha');
    const setCheck = verifyInstalledSet(venvPy, manifest);
    if (!setCheck.ok) reasons.push(`installed set != manifest: ${JSON.stringify(setCheck)}`);
  } catch (e) { reasons.push(`installed-set check error: ${e.message}`); }

  return { ok: reasons.length === 0, reasons };
}

// Atomic activation commit point: swap the `current` symlink via temp+rename
// (atomic within the channel dir on macOS), and record the genId as activated so
// GC never removes it.
function flipCurrent(home, channel, genDir) {
  const L = layout(home, channel);
  // Journal retention BEFORE the flip (Codex I4): a crash in the gap must leave an
  // extra never-activated record (harmless — GC retains it) rather than a genuinely
  // activated generation that is unrecorded (which a later GC could then delete).
  _recordActivated(home, channel, path.basename(genDir));
  const tmp = `${L.current}.tmp-${process.pid}`;
  try { fs.unlinkSync(tmp); } catch (_) { /* no prior temp */ }
  fs.symlinkSync(genDir, tmp);
  fs.renameSync(tmp, L.current);
}

// Find a complete generation whose marker matches the ENTIRE desired identity and
// that passes verifyRuntime. Used to skip a rebuild when a valid generation exists.
function adopt({ home, channel, desired }) {
  const L = layout(home, channel);
  if (!fs.existsSync(L.generations)) return null;
  for (const name of fs.readdirSync(L.generations)) {
    if (name.includes('.staging-')) continue;
    const genDir = path.join(L.generations, name);
    if (!fs.existsSync(path.join(genDir, '.runtime.json'))) continue;
    const marker = _readMarker(genDir);
    if (!marker || marker.genId !== desired.genId) continue;
    if (verifyRuntime({ home, channel, genDir, desired }).ok) return genDir;
  }
  return null;
}

// 2A GC (Codex R6 minor): remove only incomplete `*.staging-*` dirs and complete-but-
// NEVER-ACTIVATED generations. Retain every previously-activated generation and the
// current target. Must be called while holding the channel activation lock.
function gcOrphans(home, channel) {
  const L = layout(home, channel);
  if (!fs.existsSync(L.generations)) return [];
  const activated = _readActivated(home, channel);
  let curTarget = null;
  try { curTarget = path.basename(fs.realpathSync(L.current)); } catch (_) { /* no current */ }
  const removed = [];
  for (const name of fs.readdirSync(L.generations)) {
    const full = path.join(L.generations, name);
    if (name.includes('.staging-')) { fs.rmSync(full, { recursive: true, force: true }); removed.push(name); continue; }
    if (name === curTarget) continue;      // never remove the active generation
    if (activated.has(name)) continue;     // retain previously-activated generations
    fs.rmSync(full, { recursive: true, force: true }); removed.push(name); // never-activated orphan
  }
  return removed;
}

module.exports = { verifyRuntime, flipCurrent, adopt, gcOrphans };
