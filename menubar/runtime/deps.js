'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PYDEPS = () =>
  path.join(process.resourcesPath || path.join(__dirname, '..', '..'), 'resources', 'pydeps');

function selectFor(fingerprint) {
  // "cpython-3.10.20-arm64" -> cp310-arm64
  const m = /^cpython-3\.(\d+)\.\d+-(arm64|x86_64)$/.exec(fingerprint);
  if (!m) throw new Error(`unsupported env: ${fingerprint}`);
  const tag = `cp3${m[1]}-${m[2]}`;
  return { lockPath: path.join(PYDEPS(), `${tag}.lock`), manifestPath: path.join(PYDEPS(), `${tag}.manifest.json`) };
}

function verifyInstalledSet(venvPython, manifest) {
  const listed = JSON.parse(
    execFileSync(venvPython, ['-m', 'pip', 'list', '--format=json'], { encoding: 'utf8' })
  );
  const boot = new Set(Object.keys(manifest.bootstrap).map((s) => s.toLowerCase()));
  const got = {};
  for (const d of listed) {
    const n = d.name.toLowerCase();
    if (!boot.has(n)) got[n] = d.version;
  }
  const want = manifest.dists;
  const extra = [];
  const missing = [];
  const mismatched = [];
  for (const n of Object.keys(got)) if (!(n in want)) extra.push(n);
  for (const n of Object.keys(want)) {
    if (!(n in got)) missing.push(n);
    else if (got[n] !== want[n]) mismatched.push(n);
  }
  return { ok: !extra.length && !missing.length && !mismatched.length, extra, missing, mismatched };
}

// True iff a checked-in hash-pinned lock AND expected manifest exist for `fingerprint`.
// The supported interpreter matrix == the set of envs we have locks for (spec §3.6);
// an interpreter without a lock cannot be provisioned and must be skipped/fail-closed.
function isCovered(fingerprint) {
  try {
    const { lockPath, manifestPath } = selectFor(fingerprint);
    return fs.existsSync(lockPath) && fs.existsSync(manifestPath);
  } catch (_) {
    return false;
  }
}

module.exports = { selectFor, verifyInstalledSet, isCovered };
