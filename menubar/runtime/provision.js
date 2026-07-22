'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { resolveBaseInterpreter } = require('./interpreter');
const { newNonce, generationId } = require('./identity');
const { hashTree, hashFile, redact } = require('./hashing');
const { selectFor, verifyInstalledSet, isCovered } = require('./deps');
const { layout } = require('./paths');

class ProvisionError extends Error {}

function _cpDir(src, dst) {
  fs.cpSync(src, dst, {
    recursive: true,
    filter: (p) => !p.includes('__pycache__') && !p.endsWith('.pyc'),
  });
}

function provision({ home, channel, identity, bundle, logPath }) {
  const L = layout(home, channel);
  fs.mkdirSync(L.generations, { recursive: true, mode: 0o700 });
  // Only accept an interpreter whose env has a checked-in hash-pinned lock+manifest
  // (spec §3.6): skip uncovered interpreters (e.g. a homebrew 3.14 with no cp314 lock)
  // and fail closed if none of the host's interpreters is covered.
  const base = resolveBaseInterpreter({
    accept: (exe, info) => isCovered(`${info.impl}-${info.version.join('.')}-${info.arch}`),
  });
  const fp = `${base.impl}-${base.version.join('.')}-${base.arch}`;
  const nonce = newNonce();
  const genId = generationId(identity.version, fp, nonce);
  const staging = path.join(L.generations, `${genId}.staging-${process.pid}`);
  const genDir = path.join(L.generations, genId);
  try {
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    execFileSync(base.exe, ['-m', 'venv', path.join(staging, 'venv')], { stdio: 'pipe' });
    const venvPy = path.join(staging, 'venv', 'bin', 'python');
    const { lockPath, manifestPath } = selectFor(fp);
    if (!fs.existsSync(lockPath)) throw new ProvisionError(`no dependency lock for env ${fp}`);
    execFileSync(venvPy, ['-m', 'pip', 'install', '--require-hashes', '-r', lockPath], {
      stdio: 'pipe',
    });
    _cpDir(bundle.repoRadarDir, path.join(staging, 'repo_radar'));
    fs.copyFileSync(bundle.launcher, path.join(staging, 'repo-radar'));
    fs.chmodSync(path.join(staging, 'repo-radar'), 0o755);
    fs.copyFileSync(bundle.versionFile, path.join(staging, 'VERSION'));
    // smoke: import + exact-version + installed-set
    // NOTE: litellm's module uses PEP 562 __getattr__ lazy-loading and does not expose
    // `__version__` (confirmed against the real litellm==1.93.0 wheel: accessing it raises
    // AttributeError). Use importlib.metadata, which reflects the installed distribution
    // version regardless of what the package's own namespace exposes.
    execFileSync(
      venvPy,
      [
        '-c',
        'import repo_radar, importlib.metadata as m; assert m.version("litellm").startswith("1.93")',
      ],
      { stdio: 'pipe', env: { ...process.env, PYTHONPATH: staging } }
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const setCheck = verifyInstalledSet(venvPy, manifest);
    if (!setCheck.ok) throw new ProvisionError(`installed set != manifest: ${JSON.stringify(setCheck)}`);
    const marker = {
      schema: 1,
      version: identity.version,
      channel,
      genId,
      fingerprint: fp,
      sourceSha: hashTree(path.join(staging, 'repo_radar')),
      launcherSha: hashFile(path.join(staging, 'repo-radar')),
      versionSha: hashFile(path.join(staging, 'VERSION')),
      versionValue: identity.version,
      lockSha: hashFile(lockPath),
      installedSetOk: true,
    };
    fs.writeFileSync(path.join(staging, '.runtime.json'), JSON.stringify(marker, null, 2), {
      mode: 0o600,
    });
    fs.renameSync(staging, genDir); // atomic: staging complete -> immutable generation
    return { genId, genDir, marker };
  } catch (e) {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch (_) {
      // best-effort cleanup
    }
    try {
      fs.appendFileSync(logPath, redact(`[provision ${genId}] ${e.stack || e.message}\n`), {
        mode: 0o600,
      });
    } catch (_) {
      // best-effort logging
    }
    throw e instanceof ProvisionError ? e : new ProvisionError(e.message);
  }
}

module.exports = { ProvisionError, provision };
