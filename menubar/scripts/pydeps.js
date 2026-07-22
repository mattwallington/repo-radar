#!/usr/bin/env node
'use strict';
// Regenerate / verify checked-in pip dependency locks + expected-distribution manifests.
//
//   pydeps.js --emit-manifest <python> <out>
//     Runs `<python> -m pip list --format=json` against an already-installed venv and writes
//     an expected-distribution manifest (bootstrap vs. dists, plus pyMinor/arch/lockSha256) to
//     <out>. <out> must be named resources/pydeps/<tag>.manifest.json where <tag> is
//     cp3<minor>-<arch> (e.g. cp310-arm64) so the sibling <tag>.lock can be located and hashed.
//
//   pydeps.js --check
//     Freshness check: for each resources/pydeps/*.lock whose arch matches this host, recompile
//     requirements.txt with pip-compile (using an interpreter matching that lock's Python minor)
//     and diff the result against the checked-in lock. Exits nonzero if any covered lock has
//     drifted from requirements.txt. Locks for a different arch, or minors with no interpreter
//     available on this host, are skipped (reported, not failed) since they cannot be verified
//     locally.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { probe } = require('../runtime/interpreter');
const { hashFile } = require('../runtime/hashing');

const REPO_ROOT = path.join(__dirname, '..', '..');
const PYDEPS_DIR = path.join(REPO_ROOT, 'resources', 'pydeps');
const BOOTSTRAP = new Set(['pip', 'setuptools', 'wheel']);

function pipListJson(python) {
  const out = execFileSync(python, ['-m', 'pip', 'list', '--format=json'], { encoding: 'utf8' });
  return JSON.parse(out);
}

function emitManifest(python, out) {
  const base = path.basename(out);
  const nameMatch = /^(cp3\d+-(?:arm64|x86_64))\.manifest\.json$/.exec(base);
  if (!nameMatch) {
    throw new Error(`--emit-manifest: <out> must be named <tag>.manifest.json, got "${base}"`);
  }
  const tag = nameMatch[1];
  const [, minorStr, tagArch] = /^cp3(\d+)-(arm64|x86_64)$/.exec(tag);

  const lockPath = path.join(path.dirname(out), `${tag}.lock`);
  if (!fs.existsSync(lockPath)) {
    throw new Error(`expected lock file not found: ${lockPath}`);
  }

  const info = probe(python);
  if (!info) throw new Error(`cannot probe interpreter: ${python}`);
  if (String(info.version[1]) !== minorStr || info.arch !== tagArch) {
    throw new Error(
      `interpreter/tag mismatch: ${tag} expects cp3${minorStr}-${tagArch}, ` +
        `${python} reports cpython-${info.version.join('.')}-${info.arch}`
    );
  }

  const listed = pipListJson(python);
  const bootstrap = {};
  const dists = {};
  for (const { name, version } of listed) {
    const key = name.toLowerCase();
    if (BOOTSTRAP.has(key)) bootstrap[key] = version;
    else dists[key] = version;
  }

  const manifest = {
    pyMinor: Number(minorStr),
    arch: tagArch,
    lockSha256: hashFile(lockPath),
    bootstrap,
    dists,
  };

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
  console.log(
    `wrote ${out} (${Object.keys(dists).length} dists, ${Object.keys(bootstrap).length} bootstrap, ` +
      `lockSha256=${manifest.lockSha256.slice(0, 12)}...)`
  );
}

function hostArch() {
  const a = os.arch();
  if (a === 'x64') return 'x86_64';
  return a; // 'arm64' already matches platform.machine()'s spelling
}

function findInterpreterForMinor(minor) {
  const candidates = [
    `/opt/homebrew/opt/python@3.${minor}/bin/python3.${minor}`,
    `/usr/local/opt/python@3.${minor}/bin/python3.${minor}`,
  ];
  try {
    const pyenvRoot = execFileSync('pyenv', ['root'], { encoding: 'utf8' }).trim();
    const versionsDir = path.join(pyenvRoot, 'versions');
    const match = fs.readdirSync(versionsDir).find((v) => v.startsWith(`3.${minor}.`));
    if (match) candidates.push(path.join(versionsDir, match, 'bin', `python3.${minor}`));
  } catch (e) {
    // pyenv not available or no matching version; fall through to PATH lookup below.
  }
  candidates.push(`python3.${minor}`);
  for (const exe of candidates) {
    const info = probe(exe);
    if (info && info.version[1] === minor) return exe;
  }
  return null;
}

function toolchainPipCompile(pythonExe, tag) {
  const dir = path.join(os.tmpdir(), `rr-pydeps-toolchain-${tag}`);
  const pipCompile = path.join(dir, 'bin', 'pip-compile');
  if (fs.existsSync(pipCompile)) return pipCompile;
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  console.log(`provisioning pip-tools toolchain for ${tag} (${pythonExe})...`);
  execFileSync(pythonExe, ['-m', 'venv', dir], { stdio: 'pipe' });
  const pip = path.join(dir, 'bin', 'pip');
  execFileSync(pip, ['install', '-q', '--upgrade', 'pip'], { stdio: 'pipe' });
  // typing_extensions is a runtime dep of pip-tools' writer module that pip's resolver has been
  // observed to skip installing transitively; pin it explicitly so pip-compile actually runs.
  execFileSync(pip, ['install', '-q', 'pip-tools', 'typing_extensions'], { stdio: 'pipe' });
  return pipCompile;
}

function stripOutputFileLine(content) {
  // The only line that legitimately differs between a checked-in lock and a freshly recompiled
  // one is the autogenerated header's --output-file=<path>, since we recompile to a temp path.
  return content
    .split('\n')
    .filter((line) => !line.includes('--output-file='))
    .join('\n');
}

function check() {
  if (!fs.existsSync(PYDEPS_DIR)) {
    console.log('no resources/pydeps directory found; nothing to check');
    return 0;
  }
  const arch = hostArch();
  const lockFiles = fs.readdirSync(PYDEPS_DIR).filter((f) => f.endsWith('.lock')).sort();
  if (!lockFiles.length) {
    console.log('no lock files found in resources/pydeps');
    return 0;
  }

  let checked = 0;
  let drifted = 0;
  let skipped = 0;

  for (const file of lockFiles) {
    const m = /^cp3(\d+)-(arm64|x86_64)\.lock$/.exec(file);
    if (!m) {
      console.log(`SKIP ${file}: unrecognized lock filename`);
      skipped++;
      continue;
    }
    const [, minorStr, lockArch] = m;
    const minor = Number(minorStr);
    if (lockArch !== arch) {
      console.log(`SKIP ${file}: host arch is ${arch}, lock is for ${lockArch} (cannot verify cross-arch locally)`);
      skipped++;
      continue;
    }
    const python = findInterpreterForMinor(minor);
    if (!python) {
      console.log(`SKIP ${file}: no python3.${minor} interpreter found on this host`);
      skipped++;
      continue;
    }

    const tag = `cp3${minor}-${arch}`;
    const pipCompile = toolchainPipCompile(python, tag);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-pydeps-check-'));
    const tmpOut = path.join(tmpDir, `${tag}.lock`);
    // Run with cwd=REPO_ROOT and a relative input path so pip-compile's "# via -r requirements.txt"
    // provenance comments match the checked-in lock byte-for-byte (it was generated the same way).
    execFileSync(pipCompile, ['--generate-hashes', '--allow-unsafe', '-o', tmpOut, 'requirements.txt'], {
      stdio: 'pipe',
      cwd: REPO_ROOT,
    });

    const checkedIn = stripOutputFileLine(fs.readFileSync(path.join(PYDEPS_DIR, file), 'utf8'));
    const fresh = stripOutputFileLine(fs.readFileSync(tmpOut, 'utf8'));
    checked++;
    if (checkedIn !== fresh) {
      console.log(`DRIFT ${file}: does not match a fresh pip-compile of requirements.txt`);
      drifted++;
    } else {
      console.log(`OK ${file}: matches requirements.txt`);
    }
  }

  console.log(`\n${checked} checked, ${drifted} drifted, ${skipped} skipped`);
  return drifted > 0 ? 1 : 0;
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--emit-manifest') {
    const [, python, out] = args;
    if (!python || !out) {
      console.error('usage: pydeps.js --emit-manifest <python> <out>');
      process.exit(2);
    }
    emitManifest(python, out);
    return;
  }
  if (args[0] === '--check') {
    process.exit(check());
  }
  console.error('usage: pydeps.js --emit-manifest <python> <out> | --check');
  process.exit(2);
}

if (require.main === module) main();

module.exports = { emitManifest, check, findInterpreterForMinor, hostArch };
