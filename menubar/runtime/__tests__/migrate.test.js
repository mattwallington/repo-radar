'use strict';
const test = require('node:test'); const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
const { installDispatcher, retireLegacyLauncher } = require('../migrate');
const { cliPath, layout } = require('../paths');

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-mig-')); }

test('installDispatcher writes the channel-correct CLI (0700); dev never writes repo-radar', () => {
  const home = tmpHome();
  installDispatcher(home, 'stable');
  assert.ok(fs.existsSync(cliPath(home, 'stable')));
  assert.strictEqual(fs.statSync(cliPath(home, 'stable')).mode & 0o777, 0o700);

  const home2 = tmpHome();
  installDispatcher(home2, 'dev');
  assert.ok(fs.existsSync(path.join(home2, '.local', 'bin', 'repo-radar-dev')));
  assert.ok(!fs.existsSync(path.join(home2, '.local', 'bin', 'repo-radar')), 'dev must not write repo-radar');
});

test('retireLegacyLauncher is a no-op without a legacy launcher or without guards', () => {
  const home = tmpHome();
  assert.strictEqual(retireLegacyLauncher(home), null); // nothing to retire
  // legacy present but no dispatcher/current -> guarded no-op (never destroys it)
  fs.mkdirSync(path.join(home, '.repo-radar'), { recursive: true });
  fs.writeFileSync(path.join(home, '.repo-radar', 'repo-radar'), '#legacy');
  assert.strictEqual(retireLegacyLauncher(home), null);
  assert.ok(fs.existsSync(path.join(home, '.repo-radar', 'repo-radar')), 'legacy left intact');
});

test('retireLegacyLauncher moves (not deletes) the legacy launcher once guards pass', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.repo-radar'), { recursive: true });
  fs.writeFileSync(path.join(home, '.repo-radar', 'repo-radar'), '#legacy');
  installDispatcher(home, 'stable'); // dispatcher in place
  const L = layout(home, 'stable'); fs.mkdirSync(L.generations, { recursive: true });
  const g = path.join(L.generations, 'g1'); fs.mkdirSync(g); fs.symlinkSync(g, L.current); // first activation

  const movedTo = retireLegacyLauncher(home, { now: 12345 });
  assert.strictEqual(movedTo, path.join(home, '.repo-radar', 'legacy-12345', 'repo-radar'));
  assert.ok(fs.existsSync(movedTo), 'moved, not deleted');
  assert.ok(!fs.existsSync(path.join(home, '.repo-radar', 'repo-radar')), 'legacy removed from original path');
});
