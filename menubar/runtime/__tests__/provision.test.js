'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { provision, ProvisionError } = require('../provision');

const WORKTREE_ROOT = path.join(__dirname, '..', '..', '..');
const BUNDLE = {
  repoRadarDir: path.join(WORKTREE_ROOT, 'repo_radar'),
  launcher: path.join(WORKTREE_ROOT, 'repo-radar'),
  // NOTE: intentionally NOT the worktree's own VERSION file (still reads 1.0.26) — a
  // fixture is written per-test below containing 1.0.27 to match identity.version.
  versionFile: null,
};

function makeTmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-provision-test-'));
}

function writeVersionFixture(dir, version) {
  const p = path.join(dir, 'VERSION');
  fs.writeFileSync(p, `${version}\n`);
  return p;
}

test(
  'provision builds a self-contained generation with venv+source+launcher+VERSION+marker',
  { timeout: 180000 },
  () => {
    const TMP = makeTmpHome();
    const LOG = path.join(TMP, 'provision.log');
    const bundle = {
      ...BUNDLE,
      versionFile: writeVersionFixture(TMP, '1.0.27'),
    };

    const res = provision({
      home: TMP,
      channel: 'stable',
      identity: { version: '1.0.27' },
      bundle,
      logPath: LOG,
    });

    const g = res.genDir;
    assert.ok(fs.existsSync(path.join(g, 'venv', 'bin', 'python')), 'venv/bin/python exists');
    assert.ok(
      fs.existsSync(path.join(g, 'repo_radar', '__init__.py')),
      'repo_radar/__init__.py exists'
    );
    assert.ok(fs.existsSync(path.join(g, 'repo-radar')), 'repo-radar launcher exists');
    assert.strictEqual(fs.readFileSync(path.join(g, 'VERSION'), 'utf8').trim(), '1.0.27');

    // runtime reports the right version via the CLI's --version flag
    const v = execFileSync(
      path.join(g, 'venv', 'bin', 'python'),
      [path.join(g, 'repo-radar'), '--version'],
      { encoding: 'utf8', env: { ...process.env, PYTHONPATH: g } }
    );
    assert.match(v, /1\.0\.27/);

    // and independently via the package's own VERSION constant. NOTE: `cwd` must NOT be
    // the worktree root here — `python -c` puts cwd ('') at sys.path[0] ahead of
    // PYTHONPATH, and the worktree root itself contains a real (1.0.26) repo_radar/
    // package that would silently shadow the generation's own copy in genDir. Running
    // from TMP (a fresh tmpdir with no repo_radar/ of its own) avoids that entirely.
    const vImport = execFileSync(
      path.join(g, 'venv', 'bin', 'python'),
      ['-c', 'import repo_radar;print(repo_radar.VERSION)'],
      { encoding: 'utf8', cwd: TMP, env: { ...process.env, PYTHONPATH: g } }
    );
    assert.match(vImport, /1\.0\.27/);

    // marker records hashes + installed-set ok
    assert.ok(fs.existsSync(path.join(g, '.runtime.json')));
    assert.strictEqual(res.marker.version, '1.0.27');
    assert.ok(res.marker.installedSetOk);
    assert.strictEqual(res.marker.channel, 'stable');
    assert.strictEqual(res.marker.genId, res.genId);
    assert.match(res.marker.sourceSha, /^[0-9a-f]{64}$/);
    assert.match(res.marker.launcherSha, /^[0-9a-f]{64}$/);
    assert.match(res.marker.versionSha, /^[0-9a-f]{64}$/);
    assert.match(res.marker.lockSha, /^[0-9a-f]{64}$/);

    // marker on disk matches the returned marker
    const onDisk = JSON.parse(fs.readFileSync(path.join(g, '.runtime.json'), 'utf8'));
    assert.deepStrictEqual(onDisk, res.marker);

    // directories/files are private-mode as required
    assert.strictEqual(fs.statSync(g).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(path.join(g, '.runtime.json')).mode & 0o777, 0o600);

    // no leftover staging dir
    const leftovers = fs
      .readdirSync(path.join(TMP, '.repo-radar', 'stable', 'generations'))
      .filter((n) => n.includes('.staging-'));
    assert.deepStrictEqual(leftovers, []);
  }
);

test('provision cleans up staging and logs a redacted reason on failure', () => {
  const TMP = makeTmpHome();
  const LOG = path.join(TMP, 'provision.log');
  const bundle = {
    ...BUNDLE,
    versionFile: writeVersionFixture(TMP, '1.0.27'),
    // a nonexistent launcher path forces a failure well after staging/venv exist,
    // without paying for a real dependency install in this fast/negative test.
    repoRadarDir: path.join(TMP, 'no-such-repo-radar-src'),
  };

  assert.throws(
    () =>
      provision({
        home: TMP,
        channel: 'stable',
        identity: { version: '1.0.27' },
        bundle,
        logPath: LOG,
      }),
    ProvisionError
  );

  const genRoot = path.join(TMP, '.repo-radar', 'stable', 'generations');
  const leftovers = fs.existsSync(genRoot)
    ? fs.readdirSync(genRoot).filter((n) => n.includes('.staging-'))
    : [];
  assert.deepStrictEqual(leftovers, [], 'staging dir must be removed on failure');

  assert.ok(fs.existsSync(LOG), 'log file created');
  const logText = fs.readFileSync(LOG, 'utf8');
  assert.match(logText, /\[provision /);
  assert.strictEqual(fs.statSync(LOG).mode & 0o777, 0o600);
});
