// Feed integrity: the published feed must describe the exact ZIP and DMG bytes for both architectures,
// finalizing the DMGs (which changes their bytes) must update only the feed's DMG entries, and only a
// completed finalization leaves the record the publisher requires.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { identity, inspectFeed, dumpFeed, checkFeedDir, fileIdentity, inspectZips } = require('../scripts/release-artifacts');
const { finalize, verifyFinalized, FINALIZATION } = require('../scripts/release-dmg');
const { makeBuild, appleTools, appZip } = require('./helpers/release-fixtures');

const SOURCE = '4'.repeat(40);
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rr-release-feed-'));

test('the feed must describe both architectures and the exact bytes', () => {
  const dir = tempDir();
  try {
    const names = makeBuild(dir, { version: '1.0.35', channel: 'stable', source: SOURCE });
    assert.doesNotThrow(() => checkFeedDir(dir, { version: '1.0.35', channel: 'stable' }));
    const ids = Object.fromEntries([...names.zips, ...names.dmgs].map((n) => [n, identity(fs.readFileSync(path.join(dir, n)))]));
    const doc = yaml.load(fs.readFileSync(path.join(dir, names.feed), 'utf8'));
    const check = (mutate, finalized = false) => {
      const copy = JSON.parse(JSON.stringify(doc));
      mutate(copy);
      return () => inspectFeed(dumpFeed(copy), { version: '1.0.35', channel: 'stable', ids, finalized });
    };
    assert.throws(check((d) => { d.files[0].size += 1; }), /does not match its bytes/);
    assert.throws(check((d) => { d.files = d.files.filter((f) => !f.url.includes('x64-mac.zip')); }), /does not list .*x64-mac\.zip/);
    assert.throws(check((d) => { d.files.push({ ...d.files[0], url: 'repo-radar-1.0.34-x64-mac.zip' }); }), /foreign file/);
    assert.throws(check((d) => { d.version = '1.0.34'; }), /not 1\.0\.35/);
    assert.throws(check((d) => { d.sha512 = d.files[1].sha512; }), /top-level sha512/);
    // A DMG blockmap size is only a format error in a finalized feed; it is never proof of finalization.
    assert.throws(check((d) => { d.files[2].blockMapSize = 123; }, true), /pre-staple blockmap/);

    // The apps are read from inside the ZIPs: architecture from the Mach-O header, not the file name.
    assert.deepStrictEqual(inspectZips(dir, { version: '1.0.35', channel: 'stable', source: SOURCE }).map((a) => a.arch), ['arm64', 'x64']);
    fs.rmSync(path.join(dir, names.zips[0]));
    appZip(dir, names.zips[0], { version: '1.0.35', channel: 'stable', source: SOURCE, arch: 'x64' });
    assert.throws(() => inspectZips(dir, { version: '1.0.35', channel: 'stable', source: SOURCE }), /executable is x64, expected arm64/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('finalizing updates only the DMG entries, drops the DMG blockmaps and records the result last', async () => {
  const version = '1.0.35-dev.20261030010000';
  const dir = tempDir();
  try {
    const names = makeBuild(dir, { version, channel: 'dev', source: SOURCE });
    const zipsBefore = names.zips.map((n) => fileIdentity(path.join(dir, n)).sha256);
    const tools = appleTools();
    const env = { HOME: '/Users/ci', DEVELOPER_DIR: '/Applications/Xcode_16.4.app/Contents/Developer', APPLE_ID: 'x', ASC_API_KEY_P8: 'y',
      CSC_KEYCHAIN: '/runner/temp/repo-radar-release.keychain-db' };
    const result = await finalize({ dir, version, source: SOURCE, run: tools.run, env });

    assert.strictEqual(tools.calls.filter((c) => c.step === 'xcrun notarytool').length, 2);
    // notarytool is pointed at the throwaway keychain that holds the profile.
    for (const c of tools.calls.filter((x) => x.step === 'xcrun notarytool')) {
      assert.deepStrictEqual(c.argv.slice(4, 8), ['--keychain-profile', 'reperio-notary', '--keychain', env.CSC_KEYCHAIN]);
    }
    // Apple tools run on the pinned Xcode and never see credential variables.
    for (const c of tools.calls) {
      assert.deepStrictEqual(c.env, { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/Users/ci', DEVELOPER_DIR: env.DEVELOPER_DIR });
    }
    const feed = yaml.load(fs.readFileSync(path.join(dir, names.feed), 'utf8'));
    for (const dmg of names.dmgs) {
      const entry = feed.files.find((f) => f.url === dmg);
      assert.strictEqual(entry.sha512, identity(fs.readFileSync(path.join(dir, dmg))).sha512, `${dmg} entry describes the stapled bytes`);
    }
    assert.deepStrictEqual(names.zips.map((n) => fileIdentity(path.join(dir, n)).sha256), zipsBefore);
    assert.ok(names.dmgBlockmaps.every((n) => !fs.existsSync(path.join(dir, n))));
    assert.ok(names.zipBlockmaps.every((n) => fs.existsSync(path.join(dir, n))));
    const record = JSON.parse(fs.readFileSync(path.join(dir, FINALIZATION), 'utf8'));
    assert.deepStrictEqual(record, result);
    assert.strictEqual(record.source, SOURCE);
    assert.ok(record.dmgs.every((d) => /^[0-9a-f-]{36}$/.test(d.submission)));
    await verifyFinalized({ dir, version, source: SOURCE, run: appleTools().run });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed finalization leaves no record, even over an earlier one', async () => {
  const dir = tempDir();
  try {
    const names = makeBuild(dir, { version: '1.0.35', channel: 'stable', source: SOURCE });
    const before = fs.readFileSync(path.join(dir, names.feed), 'utf8');
    fs.writeFileSync(path.join(dir, FINALIZATION), '{"from":"an earlier attempt"}');
    const tools = appleTools({ notaryStatus: 'Invalid' });
    await assert.rejects(finalize({ dir, version: '1.0.35', source: SOURCE, run: tools.run, env: {} }), /Invalid", not Accepted/);
    assert.ok(!tools.calls.some((c) => c.step === 'xcrun stapler staple'), 'nothing is stapled after a rejected submission');
    assert.strictEqual(fs.readFileSync(path.join(dir, names.feed), 'utf8'), before);
    assert.ok(!fs.existsSync(path.join(dir, FINALIZATION)));
    await assert.rejects(verifyFinalized({ dir, version: '1.0.35', source: SOURCE, run: appleTools().run }), /no release-finalization\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
