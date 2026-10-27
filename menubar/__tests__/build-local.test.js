// build-local.sh must refuse a build whose notarization electron-builder skipped. electron-builder 24
// skips it with only a warning, and exits 0, when it finds no notary credential.
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

test('build-local.sh fails when electron-builder skips notarization', { skip: process.platform !== 'darwin' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-build-local-'));
  try {
    // A minimal checkout on dev with every gate stubbed to pass, so the run reaches the builder.
    fs.copyFileSync(path.join(root, 'build-local.sh'), path.join(dir, 'build-local.sh'));
    fs.chmodSync(path.join(dir, 'build-local.sh'), 0o755);
    write(path.join(dir, 'VERSION'), '1.0.32\n');
    write(path.join(dir, 'menubar', 'package.json'), '{}\n');
    write(path.join(dir, 'scripts', 'check_release_python.js'), 'process.exit(0);\n');
    write(path.join(dir, 'menubar', 'scripts', 'pydeps.js'), 'process.exit(0);\n');
    write(path.join(dir, 'fake-python'), '#!/bin/sh\nexit 0\n', 0o755);
    write(path.join(dir, 'bin', 'npm'), '#!/bin/sh\nexit 0\n', 0o755);
    // The stub records the notary credentials it was given, then reports a skipped notarization.
    write(path.join(dir, 'menubar', 'node_modules', '.bin', 'electron-builder'),
      '#!/bin/sh\n' +
      'echo "APPLE_ID=${APPLE_ID-unset} APPLE_API_KEY=${APPLE_API_KEY-unset} PROFILE=${APPLE_KEYCHAIN_PROFILE-unset}" > "$BUILDER_ENV_OUT"\n' +
      'echo "  • skipped macOS notarization  reason=`notarize` options were unable to be generated"\n' +
      'exit 0\n', 0o755);
    const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, stdio: 'ignore' });
    git('init', '-q', '-b', 'dev');
    git('add', '-A');
    git('commit', '-q', '-m', 'fixture');

    const envOut = path.join(dir, 'builder-env.txt');
    const result = spawnSync(path.join(dir, 'build-local.sh'), ['--version', '1.0.33-dev.202610271200'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`,
        REPO_RADAR_RELEASE_PYTHON: path.join(dir, 'fake-python'),
        BUILDER_ENV_OUT: envOut,
        TMPDIR: dir,
        APPLE_ID: 'someone@example.com',
        APPLE_API_KEY: 'stray-key',
      },
    });

    assert.notStrictEqual(result.status, 0, `build-local.sh should fail:\n${result.stdout}`);
    assert.match(result.stderr, /Notarization was skipped/);
    // The builder saw only the keychain profile, and the bundled VERSION was put back.
    assert.strictEqual(fs.readFileSync(envOut, 'utf8').trim(), 'APPLE_ID=unset APPLE_API_KEY=unset PROFILE=reperio-notary');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'VERSION'), 'utf8'), '1.0.32\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
