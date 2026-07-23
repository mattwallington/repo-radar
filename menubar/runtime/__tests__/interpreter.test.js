'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { resolveBaseInterpreter, probe, NoInterpreterError } = require('../interpreter');

const PY310 = '/opt/homebrew/opt/python@3.10/bin/python3.10';

test('probe returns version/impl/arch for a real interpreter', () => {
  const info = probe(PY310);
  assert.ok(info);
  assert.deepStrictEqual(info.version.slice(0, 2), [3, 10]);
  assert.strictEqual(info.impl, 'cpython');
  assert.ok(['arm64', 'x86_64'].includes(info.arch));
});

test('probe returns null for a non-interpreter', () => {
  assert.strictEqual(probe('/no/such/python'), null);
});

test('resolveBaseInterpreter picks a valid 3.10-3.14 real exe from candidates', () => {
  const r = resolveBaseInterpreter({ candidates: ['/no/such/py', PY310] });
  assert.match(r.exe, /python3.10/); assert.ok(require('fs').existsSync(r.exe)); // resolved real exe
  assert.ok(r.version[1] >= 10 && r.version[1] < 15);
});

test('resolveBaseInterpreter fails closed when nothing valid', () => {
  assert.throws(() => resolveBaseInterpreter({ candidates: ['/no/such/py'] }), NoInterpreterError);
});

test('resolveBaseInterpreter honors opts.accept (coverage gate)', () => {
  const PY310 = '/opt/homebrew/opt/python@3.10/bin/python3.10';
  assert.match(resolveBaseInterpreter({ candidates: [PY310], accept: () => true }).exe, /python3.10/);
  assert.throws(() => resolveBaseInterpreter({ candidates: [PY310], accept: () => false }), NoInterpreterError);
});
