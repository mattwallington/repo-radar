'use strict';
const test = require('node:test'); const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
const { hashFile, hashTree, redact } = require('../hashing');

test('hashTree is order-independent and content-sensitive', () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-'));
  fs.mkdirSync(path.join(a, 'sub'));
  fs.writeFileSync(path.join(a, 'sub', 'b.py'), 'x'); fs.writeFileSync(path.join(a, 'a.py'), 'y');
  const h1 = hashTree(a);
  fs.mkdirSync(path.join(a, '__pycache__')); fs.writeFileSync(path.join(a, '__pycache__', 'c.pyc'), 'junk');
  assert.strictEqual(hashTree(a), h1, 'pycache excluded');
  fs.writeFileSync(path.join(a, 'a.py'), 'changed');
  assert.notStrictEqual(hashTree(a), h1, 'content change detected');
});

test('hashFile is stable and content-sensitive', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-'));
  const p = path.join(d, 'f'); fs.writeFileSync(p, 'hello');
  const h = hashFile(p);
  assert.strictEqual(hashFile(p), h);
  fs.writeFileSync(p, 'world');
  assert.notStrictEqual(hashFile(p), h);
});

test('redact strips index-url credentials', () => {
  assert.strictEqual(redact('installing from https://tok3n:secret@pypi.example/simple'),
    'installing from https://<redacted>@pypi.example/simple');
  assert.strictEqual(redact('no creds here https://pypi.org/simple'),
    'no creds here https://pypi.org/simple');
});
