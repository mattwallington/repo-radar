'use strict';
const test = require('node:test'); const assert = require('node:assert');
const path = require('path'); const cp = require('child_process');
const { hashTree } = require('../hashing');

const WT = path.join(__dirname, '..', '..', '..');
const RUNTIME_DIR = path.join(__dirname, '..');
const PY = '/opt/homebrew/opt/python@3.10/bin/python3.10';

// verify.py (run by the shell/CLI dispatchers) re-hashes the live source tree and must
// match the Node-written marker.sourceSha. This pins hash_tree == hashTree byte-for-byte.
test('Python verify.hash_tree matches Node hashTree on repo_radar', () => {
  const repoRadar = path.join(WT, 'repo_radar');
  const nodeHash = hashTree(repoRadar);
  const pyHash = cp.execFileSync(
    PY, ['-c', 'import verify,sys; print(verify.hash_tree(sys.argv[1]))', repoRadar],
    { encoding: 'utf8', env: { ...process.env, PYTHONPATH: RUNTIME_DIR } }
  ).trim();
  assert.strictEqual(pyHash, nodeHash, 'cross-language source-tree hash parity');
});

test('Python verify.interpreter_fingerprint matches Node interpreterFingerprint form', () => {
  const { interpreterFingerprint } = require('../identity');
  const nodeFp = interpreterFingerprint(PY);
  const pyFp = cp.execFileSync(
    PY, ['-c', 'import verify; print(verify.interpreter_fingerprint())'],
    { encoding: 'utf8', env: { ...process.env, PYTHONPATH: RUNTIME_DIR } }
  ).trim();
  assert.strictEqual(pyFp, nodeFp, 'cross-language fingerprint parity');
});
