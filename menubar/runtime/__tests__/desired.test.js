'use strict';
const test = require('node:test'); const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
const { publishDesired, readDesired, schemaCompatible } = require('../desired');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-desired-')); }

test('publishDesired writes atomically (0600) and readDesired round-trips', () => {
  const d = tmp(); const p = path.join(d, 'desired.json');
  const obj = { channel: 'stable', version: '1.0.27', genId: 'g1', sourceSha: 'a', launcherSha: 'b', versionSha: 'c', lockSha: 'd' };
  publishDesired(p, obj);
  const got = readDesired(p);
  assert.strictEqual(got.schema, 1);
  assert.strictEqual(got.genId, 'g1');
  assert.strictEqual(got.version, '1.0.27');
  assert.strictEqual(fs.statSync(p).mode & 0o777, 0o600);
  // no leftover temp file
  assert.deepStrictEqual(fs.readdirSync(d).filter((n) => n.includes('.tmp')), []);
});

test('readDesired returns null when absent', () => {
  assert.strictEqual(readDesired(path.join(tmp(), 'nope.json')), null);
});

test('schemaCompatible only accepts schema 1', () => {
  assert.strictEqual(schemaCompatible({ schema: 1 }), true);
  assert.strictEqual(schemaCompatible({ schema: 2 }), false);
  assert.strictEqual(schemaCompatible({}), false);
  assert.strictEqual(schemaCompatible(null), false);
});
