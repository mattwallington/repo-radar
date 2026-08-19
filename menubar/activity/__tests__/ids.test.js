'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validActivityId, mintActivityId, mintToken, validToken } = require('../ids');

test('mintActivityId produces a value validActivityId accepts', () => {
  for (let i = 0; i < 20; i++) {
    assert.strictEqual(validActivityId(mintActivityId()), true);
  }
});

test('validActivityId accepts a well-formed v4 UUID (any valid variant nibble)', () => {
  assert.strictEqual(validActivityId('00000000-0000-4000-8000-000000000000'), true);
  for (const variant of ['8', '9', 'a', 'b']) {
    assert.strictEqual(validActivityId(`12345678-1234-4234-${variant}234-123456789abc`), true);
  }
});

test('validActivityId rejects non-v4 / non-RFC4122-variant / malformed strings', () => {
  assert.strictEqual(validActivityId('12345678-1234-1234-8234-123456789abc'), false); // version nibble != 4
  assert.strictEqual(validActivityId('12345678-1234-4234-1234-123456789abc'), false); // variant nibble not in 89ab
  assert.strictEqual(validActivityId('12345678-1234-4234-8234-123456789ABC'), false); // uppercase hex rejected
  assert.strictEqual(validActivityId('12345678-1234-4234-8234-123456789ab'), false); // too short
  assert.strictEqual(validActivityId('12345678-1234-4234-8234-123456789abcx'), false); // too long
  assert.strictEqual(validActivityId('not-a-uuid'), false);
  assert.strictEqual(validActivityId('12345678-1234-4234-8234-123456789abc\n'), false); // trailing newline
  assert.strictEqual(validActivityId(''), false);
});

test('validActivityId rejects non-string input', () => {
  assert.strictEqual(validActivityId(null), false);
  assert.strictEqual(validActivityId(undefined), false);
  assert.strictEqual(validActivityId(1234), false);
  assert.strictEqual(validActivityId({}), false);
});

test('mintToken produces a value validToken accepts', () => {
  for (let i = 0; i < 20; i++) {
    const t = mintToken();
    assert.strictEqual(validToken(t), true);
    assert.strictEqual(t.length, 8);
  }
});

test('validToken accepts exactly 8 lowercase hex chars', () => {
  assert.strictEqual(validToken('deadbeef'), true);
  assert.strictEqual(validToken('00000000'), true);
  assert.strictEqual(validToken('a1b2c3d4'), true);
});

test('validToken rejects malformed tokens', () => {
  assert.strictEqual(validToken('DEADBEEF'), false); // uppercase
  assert.strictEqual(validToken('deadbee'), false); // too short
  assert.strictEqual(validToken('deadbeef0'), false); // too long
  assert.strictEqual(validToken('deadbeeg'), false); // non-hex char
  assert.strictEqual(validToken('deadbeef\n'), false); // trailing newline
  assert.strictEqual(validToken(''), false);
  assert.strictEqual(validToken(12345678), false); // non-string
  assert.strictEqual(validToken(null), false);
});

test('mintToken values are not trivially repeated across calls', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(mintToken());
  assert.ok(seen.size > 1, 'expected randomized tokens, got a constant value');
});
