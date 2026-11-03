// Release child processes (archive inspection, git, the release Python, xcodebuild, gh) must get an
// explicit minimal environment: never a publication token, Apple credential, or a variable that
// changes how Node, Python or Git behave.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { inspectZips } = require('../scripts/release-artifacts');
const { actionsContext, toolchain, localToken } = require('../scripts/release-control');
const { KEYS, PATH } = require('../scripts/release-env');
const { makeBuild } = require('./helpers/release-fixtures');

const SENTINELS = {
  SOURCE_TOKEN: 'sentinel-source-token',
  RELEASES_REPO_TOKEN: 'sentinel-releases-token',
  GH_TOKEN: 'sentinel-gh-token',
  GITHUB_TOKEN: 'sentinel-github-token',
  APPLE_ID: 'sentinel-apple-id',
  APPLE_APP_SPECIFIC_PASSWORD: 'sentinel-apple-password',
  ASC_API_KEY_P8: 'sentinel-api-key',
  MACOS_CERTIFICATE_PASSWORD: 'sentinel-certificate-password',
  NODE_OPTIONS: '--require=/sentinel/node-options.js',
  PYTHONPATH: '/sentinel/pythonpath',
  PYTHONHOME: '/sentinel/pythonhome',
  GIT_CONFIG_GLOBAL: '/sentinel/gitconfig',
  GIT_CONFIG_COUNT: '1',
};
const SOURCE = 'a'.repeat(40);
const PYTHON = '/opt/release-venv/bin/python';
const XCODE = '/Applications/Xcode_16.4.app/Contents/Developer';

test('release child processes get only the minimal environment, never a credential', { skip: process.platform !== 'darwin' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-release-env-'));
  const saved = { ...process.env };
  const real = childProcess.execFileSync;
  const calls = [];
  try {
    makeBuild(dir, { version: '1.0.35', channel: 'stable', source: SOURCE });
    Object.assign(process.env, SENTINELS, {
      DEVELOPER_DIR: XCODE, TMPDIR: dir, GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'ReperioHealth/repo-radar',
      GITHUB_REF: 'refs/heads/main', GITHUB_SHA: SOURCE, REPO_RADAR_RELEASE_PYTHON: PYTHON,
    });
    // Records every call's actual options. unzip and plutil really run on the archives; git, the
    // release Python, xcodebuild and gh answer with canned output.
    childProcess.execFileSync = (file, args, opts) => {
      calls.push({ file, args, opts });
      if (file === 'git') return args[1] === 'HEAD' ? `${SOURCE}\n` : `${'e'.repeat(40)}\n`;
      if (file === PYTHON) return '3.14.10\n';
      if (file === 'xcodebuild') return 'Xcode 16.4\nBuild version 16F6\n';
      if (file === 'gh') return 'gho_canned_for_test\n';
      return real(file, args, opts);
    };

    assert.strictEqual(inspectZips(dir, { version: '1.0.35', channel: 'stable', source: SOURCE }).length, 2);
    assert.strictEqual(actionsContext().plan.sourceCommit, SOURCE);
    assert.strictEqual(toolchain(process.env).python, '3.14.10');
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    assert.strictEqual(localToken(process.env), 'gho_canned_for_test');
  } finally {
    childProcess.execFileSync = real;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  assert.deepStrictEqual([...new Set(calls.map((c) => c.file))].sort(), ['/usr/bin/plutil', '/usr/bin/unzip', PYTHON, 'gh', 'git', 'xcodebuild'].sort());
  for (const { file, args, opts } of calls) {
    const label = `${file} ${args.join(' ')}`;
    assert.ok(opts && opts.env, `${label} has an explicit env`);
    for (const key of Object.keys(opts.env)) assert.ok(key === 'PATH' || KEYS.includes(key), `${label} passes ${key}`);
    for (const value of Object.values(opts.env)) assert.ok(!value.includes('sentinel'), `${label} leaks a sentinel`);
    assert.strictEqual(opts.env.PATH, PATH);
    assert.strictEqual(opts.env.DEVELOPER_DIR, XCODE, `${label} keeps the pinned Xcode`);
    assert.strictEqual(opts.env.TMPDIR, dir, `${label} keeps the temporary directory`);
  }
  assert.ok(calls.find((c) => c.file === 'gh').args.includes('--hostname'));
});
