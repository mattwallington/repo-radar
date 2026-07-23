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
function _writeActivatedList(home, channel, list) {
  const p = _activatedPath(home, channel);
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 });
  fs.renameSync(tmp, p); // atomic within the channel dir
}
function _recordActivated(home, channel, genId) {
  const s = _readActivated(home, channel); s.add(genId);
  _writeActivatedList(home, channel, [...s]);
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

  // current + marker must match desired intent (incl. the anchored verifier/manifest, Codex I4)
  for (const k of ['genId', 'versionSha', 'sourceSha', 'launcherSha', 'lockSha', 'verifySha', 'manifestSha']) {
    if (marker[k] !== desired[k]) reasons.push(`marker.${k} != desired.${k}`);
  }
  // live payload must match the marker (catches post-provision tampering, incl. verify.py/manifest)
  try {
    if (hashTree(path.join(genDir, 'repo_radar')) !== marker.sourceSha) reasons.push('live sourceSha != marker');
    if (hashFile(path.join(genDir, 'repo-radar')) !== marker.launcherSha) reasons.push('live launcherSha != marker');
    if (hashFile(path.join(genDir, 'VERSION')) !== marker.versionSha) reasons.push('live versionSha != marker');
    if (marker.verifySha != null && hashFile(path.join(genDir, 'verify.py')) !== marker.verifySha) reasons.push('live verifySha != marker');
    if (marker.manifestSha != null && hashFile(path.join(genDir, 'manifest.json')) !== marker.manifestSha) reasons.push('live manifestSha != marker');
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
  // extra never-activated record (harmless — a later GC just prunes it) rather than a
  // genuinely activated generation that is unrecorded (which a later GC could then
  // delete). GC always retains `current`, so recording-before-flip keeps it safe.
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

// 2A GC (Codex R6 minor + final-review retention cap). Removes incomplete `*.staging-*` dirs,
// complete-but-NEVER-ACTIVATED generations, AND previously-activated generations older than the
// one most-recent inactive one — retaining ONLY `current` plus that single most-recent inactive
// activated generation (the rollback target). Without the cap, `adopt` never re-hits (genId is
// nonce-unique) so every reconcile rebuilds a fresh ~150–250 MB venv while retention kept them
// all forever → unbounded disk growth on an auto-updating install. `activated.json` is atomically
// compacted to the retained genIds so the journal can't grow unbounded or name a deleted gen.
// Must be called while holding the channel activation lock (root+channel) — the provision helper
// owns both, so the readdir/rm/compaction sequence can't race a concurrent activation.
function gcOrphans(home, channel) {
  const L = layout(home, channel);
  if (!fs.existsSync(L.generations)) return [];
  const activatedList = [..._readActivated(home, channel)]; // insertion (= activation) order
  let curTarget = null;
  try { curTarget = path.basename(fs.realpathSync(L.current)); } catch (_) { /* no current */ }
  // the single most-recent inactive activated generation still on disk = the rollback target
  let keepInactive = null;
  for (let i = activatedList.length - 1; i >= 0; i--) {
    const g = activatedList[i];
    if (g === curTarget) continue;
    if (fs.existsSync(path.join(L.generations, g))) { keepInactive = g; break; }
  }
  const retain = new Set([curTarget, keepInactive].filter(Boolean));
  const removed = [];
  for (const name of fs.readdirSync(L.generations)) {
    const full = path.join(L.generations, name);
    if (name.includes('.staging-')) { fs.rmSync(full, { recursive: true, force: true }); removed.push(name); continue; }
    if (retain.has(name)) continue;        // keep current + the one most-recent inactive
    fs.rmSync(full, { recursive: true, force: true }); removed.push(name); // orphan or older-activated
  }
  // Atomically compact the journal to the retained genIds (activation order preserved).
  const compacted = activatedList.filter((g) => retain.has(g));
  if (curTarget && !compacted.includes(curTarget)) compacted.push(curTarget);
  _writeActivatedList(home, channel, compacted);
  return removed;
}

module.exports = { verifyRuntime, flipCurrent, adopt, gcOrphans };
