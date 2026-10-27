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

// Regression (2026-10-26 outage): Homebrew's default python3 moved to 3.15 and the
// default search never tried the versioned 3.14 still installed. The 3.14 probe shape
// below is what the real /opt/homebrew/bin/python3.14 reported on Matt's Mac on
// 2026-10-27 (CPython 3.14.10, arm64, cpython-314-darwin, Cellar real path).
test('default discovery falls through an unsupported python3 to a versioned Homebrew python', () => {
  const REAL_314 = '/opt/homebrew/Cellar/python@3.14/3.14.10/Frameworks/Python.framework/Versions/3.14/bin/python3.14';
  const probes = {
    '/opt/homebrew/bin/python3': { exe: '/opt/homebrew/Cellar/python@3.15/3.15.1/bin/python3.15', version: [3, 15, 1], impl: 'cpython', arch: 'arm64', abi: 'cpython-315-darwin' },
    '/opt/homebrew/bin/python3.14': { exe: REAL_314, version: [3, 14, 10], impl: 'cpython', arch: 'arm64', abi: 'cpython-314-darwin' },
  };
  const tried = [];
  const r = resolveBaseInterpreter({
    probe: (exe) => { tried.push(exe); return probes[exe] || null; },
    pyenvWhich: () => null, // pyenv unavailable; PATH python3 probes as missing
    accept: (exe, info) => info.version.join('.') === '3.14.10' && info.arch === 'arm64',
  });
  assert.strictEqual(r.exe, REAL_314);
  assert.deepStrictEqual(tried, ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', 'python3', '/opt/homebrew/bin/python3.14']);
});
