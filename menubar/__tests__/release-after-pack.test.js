// The afterPack hook gives Dev its own updater cache. electron-builder ignores a configured
// updaterCacheDirName, so the hook is the only thing that separates the caches.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');
const { afterPack } = require('../scripts/release-after-pack');

const root = path.join(__dirname, '..', '..');
const BUILDER_YML = 'owner: ReperioHealth\nrepo: repo-radar-releases\nprovider: github\nupdaterCacheDirName: repo-radar-updater\n';

// A packed app as electron-builder hands it to afterPack, with the app-update.yml it just wrote.
function packContext(dir, { version, id, targets = ['dir', 'dmg', 'zip'], yml = BUILDER_YML }) {
  const resources = path.join(dir, 'Repo Radar.app', 'Contents', 'Resources');
  fs.mkdirSync(resources, { recursive: true });
  if (yml !== null) fs.writeFileSync(path.join(resources, 'app-update.yml'), yml);
  return {
    electronPlatformName: 'darwin',
    appOutDir: dir,
    targets: targets.map((name) => ({ name })),
    packager: { appInfo: { version, id }, getResourcesDir: () => resources },
    file: path.join(resources, 'app-update.yml'),
  };
}

test('afterPack sets the channel cache and refuses a mismatched or missing configuration', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-after-pack-'));
  try {
    const dev = packContext(path.join(dir, 'dev'), { version: '1.0.35-dev.20261030010000', id: 'com.mattwallington.repo-radar-dev' });
    await afterPack(dev);
    assert.deepStrictEqual(yaml.load(fs.readFileSync(dev.file, 'utf8')),
      { owner: 'ReperioHealth', repo: 'repo-radar-releases', provider: 'github', updaterCacheDirName: 'repo-radar-dev-updater' });

    const stable = packContext(path.join(dir, 'stable'), { version: '1.0.35', id: 'com.mattwallington.repo-radar' });
    await afterPack(stable);
    assert.strictEqual(yaml.load(fs.readFileSync(stable.file, 'utf8')).updaterCacheDirName, 'repo-radar-updater');

    await assert.rejects(afterPack(packContext(path.join(dir, 'a'), { version: '1.0.35-dev.1', id: 'com.mattwallington.repo-radar' })), /bundle ID/);
    await assert.rejects(afterPack(packContext(path.join(dir, 'b'), { version: '1.0.35', id: 'com.mattwallington.repo-radar', yml: null })), /no app-update\.yml/);
    await assert.rejects(afterPack(packContext(path.join(dir, 'c'), { version: '1.0.35', id: 'com.mattwallington.repo-radar', yml: BUILDER_YML.replace('ReperioHealth', 'mattwallington') })), /owner/);
    // A dir-only package has no updater configuration to fix.
    await afterPack(packContext(path.join(dir, 'd'), { version: '1.0.35', id: 'com.mattwallington.repo-radar', targets: ['dir'], yml: null }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The real check: an unsigned ZIP build with the locked electron-builder, this repository's packaging
// configuration and the hook, in a disposable copy of the committed tree. Signing and notarization are
// turned off only on this command line. It installs dependencies and packages Electron, so it runs only
// when REPO_RADAR_PACKAGING_TEST=1.
test('a real unsigned Dev ZIP gets the Dev cache and keeps its identity; stable keeps its cache',
  { skip: process.env.REPO_RADAR_PACKAGING_TEST !== '1' || process.platform !== 'darwin', timeout: 1_800_000 }, () => {
    const scratch = fs.mkdtempSync('/private/tmp/rr-dev-packaging-');
    try {
      const tree = path.join(scratch, 'repo');
      fs.mkdirSync(tree);
      execFileSync('/bin/sh', ['-c', `git -C "${root}" archive HEAD | tar -x -C "${tree}"`]);
      const menubar = path.join(tree, 'menubar');
      execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: menubar, stdio: 'ignore' });

      const build = (channel, version) => {
        const dev = channel === 'dev';
        fs.writeFileSync(path.join(menubar, 'build-info.json'), JSON.stringify({ version, channel }));
        const args = ['--mac', 'zip', '--arm64', '--publish', 'never',
          '-c.mac.identity=null', '-c.forceCodeSigning=false', '-c.mac.notarize=false',
          `-c.extraMetadata.version=${version}`, `-c.directories.output=dist-${channel}`];
        if (dev) args.push('-c.appId=com.mattwallington.repo-radar-dev', '-c.productName=Repo Radar Dev', '-c.mac.icon=assets/icon-dev.icns');
        execFileSync(path.join(menubar, 'node_modules', '.bin', 'electron-builder'), args, {
          cwd: menubar, stdio: 'ignore', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
        });
        const dist = path.join(menubar, `dist-${channel}`);
        const zip = path.join(dist, `repo-radar-${version}-arm64-mac.zip`);
        assert.ok(fs.existsSync(zip), `artifact prefix and name unchanged: ${path.basename(zip)}`);
        assert.ok(fs.existsSync(path.join(dist, 'latest-mac.yml')), 'the update-file writer ran');
        const out = path.join(scratch, `unzipped-${channel}`);
        execFileSync('/usr/bin/ditto', ['-x', '-k', zip, out]);
        const product = dev ? 'Repo Radar Dev' : 'Repo Radar';
        const app = path.join(out, `${product}.app`);
        const plist = (key) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
        assert.strictEqual(plist('CFBundleIdentifier'), dev ? 'com.mattwallington.repo-radar-dev' : 'com.mattwallington.repo-radar');
        assert.strictEqual(plist('CFBundleShortVersionString'), version);
        // The packaged-app check build-local.sh runs on every real build.
        execFileSync('node', [path.join(menubar, 'scripts', 'release-artifacts.js'), 'check-app-update', app, channel], { stdio: 'ignore' });
        return yaml.load(fs.readFileSync(path.join(app, 'Contents', 'Resources', 'app-update.yml'), 'utf8'));
      };

      assert.strictEqual(build('dev', '1.0.35-dev.20261030010000').updaterCacheDirName, 'repo-radar-dev-updater');
      assert.strictEqual(build('stable', '1.0.35').updaterCacheDirName, 'repo-radar-updater');
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
