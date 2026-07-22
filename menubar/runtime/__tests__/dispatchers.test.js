'use strict';
const test = require('node:test'); const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
const cp = require('child_process');
const { emitRunSync, emitCliDispatcher } = require('../dispatchers');
const { withLock } = require('../lock');
const { layout } = require('../paths');

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-disp-')); }

test('emitRunSync writes a 0700 script that is syntactically valid and lock-first', () => {
  const home = tmpHome();
  const p = emitRunSync(home, 'stable');
  assert.strictEqual(fs.statSync(p).mode & 0o777, 0o700);
  cp.execFileSync('/bin/sh', ['-n', p]); // syntax check (throws on error)
  const s = fs.readFileSync(p, 'utf8');
  // lock acquisition must appear BEFORE resolving current
  const lockIdx = s.indexOf('/usr/bin/lockf -t 0 9');
  const resolveIdx = s.indexOf('GEN="$(cd "$CUR"');
  assert.ok(lockIdx > 0 && resolveIdx > lockIdx, 'lock-first-then-resolve ordering');
  assert.match(s, /exec 9>"\$ROOT\/\.exec\.lock"/);
  assert.match(s, /exec "\$GEN\/venv\/bin\/python" "\$GEN\/repo-radar" sync --status-server "\$@"/);
});

test('emitCliDispatcher forwards args (no sync subcommand) at repo-radar-dev for dev', () => {
  const home = tmpHome();
  const p = emitCliDispatcher(home, 'dev');
  assert.strictEqual(p, path.join(home, '.local', 'bin', 'repo-radar-dev'));
  const s = fs.readFileSync(p, 'utf8');
  assert.match(s, /exec "\$GEN\/venv\/bin\/python" "\$GEN\/repo-radar" "\$@"/);
});

test('run-sync fails closed (after acquiring the lock) when no active runtime', () => {
  const home = tmpHome();
  const p = emitRunSync(home, 'stable');
  const r = cp.spawnSync('/bin/sh', [p], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /no active runtime/);
});

test('run-sync exits 75 (busy) when the root exec lock is held', async () => {
  const home = tmpHome();
  const p = emitRunSync(home, 'stable');
  fs.mkdirSync(path.join(home, '.repo-radar'), { recursive: true });
  const lockFile = layout(home, 'stable').execLock;
  await withLock(lockFile, 0, async () => {
    const r = cp.spawnSync('/bin/sh', [p], { encoding: 'utf8', env: { ...process.env, HOME: home } });
    assert.strictEqual(r.status, 75);
    assert.match(r.stderr, /another sync is running/);
  });
});
