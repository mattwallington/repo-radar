// build-local.sh must refuse a build whose notarization electron-builder skipped (electron-builder 24
// skips it with only a warning, and exits 0, when it finds no notary credential), and must refuse a
// checkout with untracked files, which electron-builder would package.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const root = path.join(__dirname, '..', '..');

function write(file, body, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode });
}

// A minimal checkout on dev with every gate stubbed to pass and record its call. Recording files,
// the fake release Python and the fake npm live outside the checkout, so they never make it dirty.
function fixture(dir) {
  const repo = path.join(dir, 'repo');
  const rec = path.join(dir, 'rec');
  const calls = path.join(rec, 'calls.txt');
  const record = (name) => `#!/bin/sh\necho ${name} >> "${calls}"\n`;
  fs.mkdirSync(rec, { recursive: true });
  fs.writeFileSync(calls, '');
  fs.mkdirSync(repo, { recursive: true });
  fs.copyFileSync(path.join(root, 'build-local.sh'), path.join(repo, 'build-local.sh'));
  fs.chmodSync(path.join(repo, 'build-local.sh'), 0o755);
  write(path.join(repo, 'VERSION'), '1.0.32\n');
  write(path.join(repo, 'menubar', 'package.json'), '{}\n');
  write(path.join(repo, 'scripts', 'check_release_python.js'), `require('fs').appendFileSync(${JSON.stringify(calls)}, 'check_release_python\\n');\n`);
  write(path.join(repo, 'menubar', 'scripts', 'pydeps.js'), `require('fs').appendFileSync(${JSON.stringify(calls)}, 'pydeps\\n');\n`);
  write(path.join(rec, 'fake-python'), record('python') + 'exit 0\n', 0o755);
  write(path.join(rec, 'bin', 'npm'), record('npm') + 'exit 0\n', 0o755);
  // The stub records the notary credentials it was given, then reports a skipped notarization.
  write(path.join(repo, 'menubar', 'node_modules', '.bin', 'electron-builder'),
    record('electron-builder') +
    `echo "APPLE_ID=\${APPLE_ID-unset} APPLE_API_KEY=\${APPLE_API_KEY-unset} PROFILE=\${APPLE_KEYCHAIN_PROFILE-unset}" > "${path.join(rec, 'builder-env.txt')}"\n` +
    'echo "  • skipped macOS notarization  reason=`notarize` options were unable to be generated"\n' +
    'exit 0\n', 0o755);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'dev');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');

  const run = (...args) => spawnSync(path.join(repo, 'build-local.sh'), args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${path.join(rec, 'bin')}:${process.env.PATH}`,
      REPO_RADAR_RELEASE_PYTHON: path.join(rec, 'fake-python'),
      TMPDIR: rec,
      APPLE_ID: 'someone@example.com',
      APPLE_API_KEY: 'stray-key',
    },
  });
  const recorded = () => fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean);
  return { repo, rec, run, recorded };
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-build-local-'));
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const darwinOnly = { skip: process.platform !== 'darwin' };

test('build-local.sh fails when electron-builder skips notarization', darwinOnly, () => withTempDir((dir) => {
  const { repo, rec, run, recorded } = fixture(dir);
  const result = run('--version', '1.0.33-dev.202610271200');

  assert.notStrictEqual(result.status, 0, `build-local.sh should fail:\n${result.stdout}`);
  assert.match(result.stderr, /Notarization was skipped/);
  assert.ok(recorded().includes('electron-builder'), recorded().join(','));
  // The builder saw only the keychain profile, and the bundled VERSION was put back.
  assert.strictEqual(fs.readFileSync(path.join(rec, 'builder-env.txt'), 'utf8').trim(), 'APPLE_ID=unset APPLE_API_KEY=unset PROFILE=reperio-notary');
  assert.strictEqual(fs.readFileSync(path.join(repo, 'VERSION'), 'utf8'), '1.0.32\n');
}));

test('build-local.sh refuses a checkout with an untracked file before any gate', darwinOnly, () => withTempDir((dir) => {
  const { repo, run, recorded } = fixture(dir);
  write(path.join(repo, 'menubar', 'stray.txt'), 'not committed\n');
  const result = run('--version', '1.0.33-dev.202610271200', '--dry-run');

  assert.notStrictEqual(result.status, 0, `build-local.sh should fail:\n${result.stdout}`);
  assert.match(result.stderr, /uncommitted changes or untracked files/);
  assert.deepStrictEqual(recorded(), [], 'no gate, install or builder may run');
  assert.strictEqual(fs.readFileSync(path.join(repo, 'VERSION'), 'utf8'), '1.0.32\n');
}));
