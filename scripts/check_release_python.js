#!/usr/bin/env node
'use strict';
// Release preflight: verify the interpreter release.sh will run the Python gates with.
//
//   check_release_python.js <absolute path to a release venv's python>
//
// Read-only. The interpreter must be CPython 3.10-3.14 inside a venv, its interpreter minor and
// architecture must have a checked-in lock + manifest under resources/pydeps/, its installed
// distributions must equal that manifest exactly, and `pip check` must pass. The supplied path
// is invoked as given, never resolved to its base interpreter, because resolving the venv's
// symlink would leave the venv. Never provisions or repairs anything.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { probe } = require('../menubar/runtime/interpreter');
const { selectFor, verifyInstalledSet, isCovered } = require('../menubar/runtime/deps');

const ENV = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };

function check(exe) {
  if (!exe || !path.isAbsolute(exe)) return [`not an absolute path: ${JSON.stringify(exe || '')}`];
  try {
    fs.accessSync(exe, fs.constants.X_OK);
  } catch (_) {
    return [`not an executable file: ${exe}`];
  }
  const info = probe(exe);
  if (!info) return [`cannot run ${exe}`];
  const [major, minor, micro] = info.version;
  if (info.impl !== 'cpython' || major !== 3 || minor < 10 || minor > 14) {
    return [`unsupported interpreter ${info.impl} ${info.version.join('.')} (need CPython 3.10-3.14)`];
  }
  let inVenv = '';
  try {
    inVenv = execFileSync(exe, ['-c', 'import sys;print(sys.prefix != sys.base_prefix)'],
      { encoding: 'utf8', timeout: 8000, env: ENV }).trim();
  } catch (_) { /* reported below */ }
  if (inVenv !== 'True') return [`${exe} is not inside a venv`];

  const fingerprint = `cpython-${major}.${minor}.${micro}-${info.arch}`;
  if (!isCovered(fingerprint)) return [`no checked-in dependency lock for ${fingerprint}`];
  const { manifestPath } = selectFor(fingerprint);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const failures = [];
  let set;
  try {
    set = verifyInstalledSet(exe, manifest);
  } catch (e) {
    return [`pip list failed: ${e.message.split('\n')[0]}`];
  }
  if (!set.ok) {
    const lockName = path.basename(manifestPath).replace('.manifest.json', '.lock');
    if (set.missing.length) failures.push(`missing distributions: ${set.missing.join(', ')}`);
    if (set.extra.length) failures.push(`distributions not in ${lockName}: ${set.extra.join(', ')}`);
    if (set.mismatched.length) failures.push(`versions differ from ${lockName}: ${set.mismatched.join(', ')}`);
  }
  try {
    execFileSync(exe, ['-m', 'pip', 'check'], { encoding: 'utf8', stdio: 'pipe', env: ENV });
  } catch (e) {
    failures.push(`pip check failed: ${String(e.stdout || e.message).trim()}`);
  }
  return failures;
}

function main() {
  const exe = process.argv[2];
  const failures = check(exe);
  if (failures.length) {
    console.error('RELEASE PYTHON CHECK FAILED:');
    for (const f of failures) console.error('  -', f);
    return 1;
  }
  console.log(`release python OK: ${exe}`);
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { check };
