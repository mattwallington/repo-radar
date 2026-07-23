'use strict';
const test = require('node:test'); const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
const { execFileSync } = require('child_process');
const { selectFor, verifyInstalledSet } = require('../deps');

const PY310 = '/opt/homebrew/opt/python@3.10/bin/python3.10';
const PYDEPS_DIR = path.join(__dirname, '..', '..', '..', 'resources', 'pydeps');
const LOCK = path.join(PYDEPS_DIR, 'cp310-arm64.lock');
const MANIFEST = path.join(PYDEPS_DIR, 'cp310-arm64.manifest.json');

test('selectFor maps fingerprint -> lock+manifest', () => {
  const s = selectFor('cpython-3.10.20-arm64');
  assert.match(s.lockPath, /cp310-arm64\.lock$/);
  assert.match(s.manifestPath, /cp310-arm64\.manifest\.json$/);

  const s2 = selectFor('cpython-3.13.4-x86_64');
  assert.match(s2.lockPath, /cp313-x86_64\.lock$/);
  assert.match(s2.manifestPath, /cp313-x86_64\.manifest\.json$/);

  assert.throws(() => selectFor('not-a-fingerprint'), /unsupported env/);
});

test(
  'verifyInstalledSet against a real clean venv built from the checked-in cp310 lock',
  { timeout: 300000 },
  () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    const venv = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-deps-test-'));
    execFileSync(PY310, ['-m', 'venv', venv]);
    const pip = path.join(venv, 'bin', 'pip');
    const python = path.join(venv, 'bin', 'python');
    execFileSync(pip, ['install', '-q', '--require-hashes', '-r', LOCK], {
      stdio: 'inherit',
      timeout: 240000,
    });

    // Exact clean install of the locked set matches the manifest exactly.
    const clean = verifyInstalledSet(python, manifest);
    assert.deepStrictEqual(clean, { ok: true, extra: [], missing: [], mismatched: [] });

    // Inject an extra (unmanifested) distribution.
    execFileSync(pip, ['install', '-q', '--no-deps', 'six']);
    const withExtra = verifyInstalledSet(python, manifest);
    assert.strictEqual(withExtra.ok, false);
    assert.deepStrictEqual(withExtra.missing, []);
    assert.deepStrictEqual(withExtra.mismatched, []);
    assert.ok(withExtra.extra.includes('six'));

    // Inject a version mismatch on a real manifest entry.
    assert.ok(manifest.dists.idna, 'expected idna in manifest.dists for this test to be meaningful');
    execFileSync(pip, ['install', '-q', '--no-deps', 'idna==3.4']);
    const withMismatch = verifyInstalledSet(python, manifest);
    assert.strictEqual(withMismatch.ok, false);
    assert.ok(withMismatch.mismatched.includes('idna'));

    // Remove a required distribution entirely (uninstall without cascading).
    execFileSync(pip, ['uninstall', '-y', '-q', 'six']);
    execFileSync(pip, ['install', '-q', '--no-deps', '--force-reinstall', `idna==${manifest.dists.idna}`]);
    execFileSync(pip, ['uninstall', '-y', '-q', 'certifi']);
    const withMissing = verifyInstalledSet(python, manifest);
    assert.strictEqual(withMissing.ok, false);
    assert.ok(withMissing.missing.includes('certifi'));
  }
);

test('isCovered reflects checked-in lock+manifest presence', () => {
  const { isCovered } = require('../deps');
  assert.strictEqual(isCovered('cpython-3.10.20-arm64'), true);   // cp310-arm64 checked in
  assert.strictEqual(isCovered('cpython-3.14.4-arm64'), true);    // cp314-arm64 now generated (10/10)
  assert.strictEqual(isCovered('cpython-3.9.0-arm64'), false);    // 3.9 is below the supported floor -> no lock
  assert.strictEqual(isCovered('pypy-3.10.0-arm64'), false);      // non-cpython impl unsupported
  assert.strictEqual(isCovered('garbage'), false);
});
