// Feed integrity: the published feed must describe the exact ZIP and DMG bytes for both architectures,
// and finalizing the DMGs (which changes their bytes) must update only the feed's DMG entries.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { artifactNames, identity, inspectFeed, dumpFeed, checkFeedDir, SIGNING_IDENTITY } = require('../scripts/release-artifacts');
const { finalize } = require('../scripts/release-dmg');

// A dist directory shaped like electron-builder's: both ZIPs, both DMGs, their blockmaps and the feed.
function dist(version, channel) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-release-feed-'));
  const names = artifactNames(version, channel);
  const ids = {};
  for (const name of [...names.zips, ...names.dmgs, ...names.zipBlockmaps, ...names.dmgBlockmaps]) {
    const bytes = crypto.randomBytes(512);
    fs.writeFileSync(path.join(dir, name), bytes);
    ids[name] = identity(bytes);
  }
  const files = [...names.zips, ...names.dmgs].map((url) => ({ url, sha512: ids[url].sha512, size: ids[url].size }));
  files[2].blockMapSize = 123; // a pre-staple DMG blockmap the finalizer must drop
  const doc = { version, files, path: names.zips[0], sha512: ids[names.zips[0]].sha512, releaseDate: '2026-10-30T00:00:00.000Z' };
  fs.writeFileSync(path.join(dir, names.feed), dumpFeed(doc));
  return { dir, names, ids, doc };
}

// Stands in for codesign, notarytool, stapler and spctl. Stapling appends to the DMG, as the real one does.
function appleTools({ notaryStatus = 'Accepted' } = {}) {
  const calls = [];
  const ok = (stdout = '', stderr = '') => ({ status: 0, stdout, stderr, timedOut: false, truncated: false, error: null });
  const run = async (argv) => {
    const dmg = argv[argv.length - 1];
    calls.push(`${path.basename(argv[0])} ${argv[1]}`);
    if (argv[1] === '--display') {
      return ok('', `Authority=${SIGNING_IDENTITY}\nAuthority=Developer ID Certification Authority\nTimestamp=Oct 30, 2026\nTeamIdentifier=F8UY7565VM\n`);
    }
    if (argv[1] === 'notarytool') {
      return { ...ok(JSON.stringify({ id: crypto.randomUUID(), status: notaryStatus })), status: notaryStatus === 'Accepted' ? 0 : 1 };
    }
    if (argv[1] === 'stapler' && argv[2] === 'staple') fs.appendFileSync(dmg, 'ticket');
    if (argv[0] === '/usr/sbin/spctl') return ok('', `${dmg}: accepted\nsource=Notarized Developer ID\n`);
    return ok();
  };
  return { run, calls };
}

test('the feed must describe both architectures and the exact bytes', () => {
  const { dir, names, ids, doc } = dist('1.0.35', 'stable');
  try {
    assert.doesNotThrow(() => checkFeedDir(dir, { version: '1.0.35', channel: 'stable' }));
    const check = (mutate) => {
      const copy = JSON.parse(JSON.stringify(doc));
      mutate(copy);
      return () => inspectFeed(dumpFeed(copy), { version: '1.0.35', channel: 'stable', ids });
    };
    assert.throws(check((d) => { d.files[0].size += 1; }), /does not match its bytes/);
    assert.throws(check((d) => { d.files = d.files.filter((f) => !f.url.includes('arm64-mac.zip')); }), /does not list .*arm64-mac\.zip/);
    assert.throws(check((d) => { d.files.push({ ...d.files[0], url: 'repo-radar-1.0.34-x64-mac.zip' }); }), /foreign file/);
    assert.throws(check((d) => { d.version = '1.0.34'; }), /not 1\.0\.35/);
    assert.throws(check((d) => { d.sha512 = d.files[1].sha512; }), /top-level sha512/);
    // A Dev release's feed is dev-mac.yml, and a stable version can't be checked as Dev.
    assert.strictEqual(artifactNames('1.0.35-dev.20261030010000', 'dev').feed, 'dev-mac.yml');
    assert.throws(() => artifactNames('1.0.35', 'dev'), /not a dev version/);
    assert.ok(names.zips.every((n) => fs.existsSync(path.join(dir, n))));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('finalizing updates only the DMG entries and drops the stale DMG blockmaps', async () => {
  const version = '1.0.35-dev.20261030010000';
  const { dir, names, ids } = dist(version, 'dev');
  try {
    const tools = appleTools();
    const result = await finalize({ dir, version, run: tools.run, env: {} });

    assert.strictEqual(tools.calls.filter((c) => c === 'xcrun notarytool').length, 2);
    const feed = require('js-yaml').load(fs.readFileSync(path.join(dir, names.feed), 'utf8'));
    for (const dmg of names.dmgs) {
      const bytes = fs.readFileSync(path.join(dir, dmg));
      const entry = feed.files.find((f) => f.url === dmg);
      assert.strictEqual(entry.sha512, identity(bytes).sha512, `${dmg} entry describes the stapled bytes`);
      assert.strictEqual(entry.blockMapSize, undefined);
      assert.strictEqual(result.dmgs.find((d) => d.name === dmg).sha256, identity(bytes).sha256);
    }
    for (const zip of names.zips) assert.strictEqual(feed.files.find((f) => f.url === zip).sha512, ids[zip].sha512);
    assert.ok(names.dmgBlockmaps.every((n) => !fs.existsSync(path.join(dir, n))));
    assert.ok(names.zipBlockmaps.every((n) => fs.existsSync(path.join(dir, n))));
    assert.doesNotThrow(() => checkFeedDir(dir, { version, channel: 'dev', finalized: true }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a notary result other than Accepted stops finalization and leaves the feed alone', async () => {
  const { dir, names } = dist('1.0.35', 'stable');
  try {
    const before = fs.readFileSync(path.join(dir, names.feed), 'utf8');
    const tools = appleTools({ notaryStatus: 'Invalid' });
    await assert.rejects(finalize({ dir, version: '1.0.35', run: tools.run, env: {} }), /Invalid", not Accepted/);
    assert.ok(!tools.calls.includes('xcrun stapler'), 'nothing is stapled after a rejected submission');
    assert.strictEqual(fs.readFileSync(path.join(dir, names.feed), 'utf8'), before);
    assert.ok(names.dmgBlockmaps.every((n) => fs.existsSync(path.join(dir, n))));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
