'use strict';
const test = require('node:test'); const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
const { authoritativeIdentity, interpreterFingerprint, generationId, newNonce, IdentityError } = require('../identity');
const PY310 = '/opt/homebrew/opt/python@3.10/bin/python3.10';

test('identity requires app version to match bundled VERSION and rejects 2.0.0', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-')); const vp = path.join(d, 'VERSION');
  fs.writeFileSync(vp, '1.0.27\n');
  assert.deepStrictEqual(authoritativeIdentity({ appVersion: '1.0.27', bundledVersionPath: vp }), { version: '1.0.27' });
  assert.throws(() => authoritativeIdentity({ appVersion: '2.0.0', bundledVersionPath: vp }), IdentityError);
  assert.throws(() => authoritativeIdentity({ appVersion: '1.0.26', bundledVersionPath: vp }), IdentityError);
  assert.throws(() => authoritativeIdentity({ appVersion: '', bundledVersionPath: vp }), IdentityError);
  assert.throws(() => authoritativeIdentity({ appVersion: '1.0.27', bundledVersionPath: '/no/such/VERSION' }), IdentityError);
});

test('fingerprint + generationId + nonce', () => {
  assert.match(interpreterFingerprint(PY310), /^cpython-3\.10\.\d+-(arm64|x86_64)$/);
  assert.strictEqual(generationId('1.0.27', 'cpython-3.10.20-arm64', 'abcd'), '1.0.27-cpython-3.10.20-arm64-abcd');
  assert.match(newNonce(), /^[0-9a-f]{12}$/);
});
