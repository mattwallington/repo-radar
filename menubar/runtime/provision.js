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

// Deterministically plan a generation WITHOUT building it: resolve a covered base
// interpreter, mint a nonce-unique genId, and pre-hash the bundle + selected lock.
// ensureRuntime publishes desired.json from this plan BEFORE the (slow) build, so a
// newly-installed build fails closed rather than serving the previous runtime.
function planGeneration({ identity, bundle }) {
  const base = resolveBaseInterpreter({
    accept: (exe, info) => isCovered(`${info.impl}-${info.version.join('.')}-${info.arch}`),
  });
  const fp = `${base.impl}-${base.version.join('.')}-${base.arch}`;
  const { lockPath, manifestPath } = selectFor(fp);
  if (!fs.existsSync(lockPath)) throw new ProvisionError(`no dependency lock for env ${fp}`);
  const nonce = newNonce();
  const genId = generationId(identity.version, fp, nonce);
  const expected = {
    sourceSha: hashTree(bundle.repoRadarDir),
    launcherSha: hashFile(bundle.launcher),
    versionSha: hashFile(bundle.versionFile),
    lockSha: hashFile(lockPath),
  };
  return { base, fp, nonce, genId, lockPath, manifestPath, expected };
}

function provision({ home, channel, identity, bundle, logPath, plan }) {
  const L = layout(home, channel);
  fs.mkdirSync(L.generations, { recursive: true, mode: 0o700 });
  let staging = null;
  let genId = null;
  try {
    const p = plan || planGeneration({ identity, bundle });
    const { base, fp, lockPath, manifestPath } = p;
    genId = p.genId;
    staging = path.join(L.generations, `${genId}.staging-${process.pid}`);
    const genDir = path.join(L.generations, genId);
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    execFileSync(base.exe, ['-m', 'venv', path.join(staging, 'venv')], { stdio: 'pipe' });
    const venvPy = path.join(staging, 'venv', 'bin', 'python');
    execFileSync(venvPy, ['-m', 'pip', 'install', '--require-hashes', '-r', lockPath], {
      stdio: 'pipe',
    });
    _cpDir(bundle.repoRadarDir, path.join(staging, 'repo_radar'));
    fs.copyFileSync(bundle.launcher, path.join(staging, 'repo-radar'));
    fs.chmodSync(path.join(staging, 'repo-radar'), 0o755);
    fs.copyFileSync(bundle.versionFile, path.join(staging, 'VERSION'));
    // Ship the verifier + this env's expected manifest INTO the generation so the
    // shell/CLI dispatchers can enforce the full predicate standalone (Codex I5).
    fs.copyFileSync(bundle.verifyPy || path.join(__dirname, 'verify.py'), path.join(staging, 'verify.py'));
    fs.copyFileSync(manifestPath, path.join(staging, 'manifest.json'));
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
    if (staging) {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
    }
    try {
      fs.appendFileSync(logPath, redact(`[provision ${genId || '?'}] ${e.stack || e.message}\n`), {
        mode: 0o600,
      });
    } catch (_) {
      // best-effort logging
    }
    throw e instanceof ProvisionError ? e : new ProvisionError(e.message);
  }
}

module.exports = { ProvisionError, planGeneration, provision };
