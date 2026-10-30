// Release reservation and publication against an in-memory GitHub: version numbering, retries reusing
// their reservation, stale sources refused, and an already-published source treated as done.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { artifactNames, identity, dumpFeed } = require('../scripts/release-artifacts');
const { planVersion, reserve, publish, recordOf } = require('../scripts/release-control');

const NOW = new Date('2026-10-30T01:00:00Z');
const sha = (n) => String(n).repeat(40).slice(0, 40);

// The releases repository and the source branches, as the controller sees them through its client.
function fakeGitHub() {
  const state = { releases: [], branches: {}, bytes: new Map(), nextId: 1 };
  const find = (id) => state.releases.find((r) => r.id === id);
  const copy = (r) => JSON.parse(JSON.stringify(r));
  const client = {
    listReleases: async () => state.releases.map(copy),
    getRelease: async (id) => copy(find(id)),
    createRelease: async (p) => {
      const r = { id: state.nextId++, assets: [], upload_url: 'https://uploads.example/{?name,label}', ...p };
      state.releases.push(r);
      return copy(r);
    },
    updateRelease: async (id, patch) => { Object.assign(find(id), patch); },
    deleteAsset: async (asset) => {
      for (const r of state.releases) r.assets = r.assets.filter((a) => a.id !== asset.id);
    },
    uploadAsset: async (release, name, file) => {
      const r = find(release.id);
      if (!r.draft) throw new Error('uploads go to drafts only');
      const bytes = fs.readFileSync(file);
      const asset = { id: state.nextId++, name, size: bytes.length };
      state.bytes.set(asset.id, bytes);
      r.assets.push(asset);
    },
    assetSha256: async (asset) => crypto.createHash('sha256').update(state.bytes.get(asset.id)).digest('hex'),
    assetText: async (asset) => state.bytes.get(asset.id).toString('utf8'),
    branchSha: async (branch) => state.branches[branch],
  };
  return { state, client };
}

function context(client, plan) {
  return { client, plan, floor: '1.0.32', changelog: '## [Unreleased]\n\n- Sync fix\n', now: () => NOW, log: () => {}, toolchain: { node: 'test' }, run: { id: '1' } };
}

const planFor = (channel, commit) => ({
  channel, branch: channel === 'stable' ? 'main' : 'dev', sourceRepo: 'ReperioHealth/repo-radar', sourceCommit: commit, sourceTree: sha('e'),
});

// A finalized build directory: both ZIPs, both stapled DMGs and a feed describing them.
function finalizedDist(version, channel) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-release-control-'));
  const names = artifactNames(version, channel);
  const ids = {};
  for (const name of [...names.zips, ...names.dmgs, ...names.zipBlockmaps]) {
    const bytes = crypto.randomBytes(256);
    fs.writeFileSync(path.join(dir, name), bytes);
    ids[name] = identity(bytes);
  }
  const files = [...names.zips, ...names.dmgs].map((url) => ({ url, sha512: ids[url].sha512, size: ids[url].size }));
  fs.writeFileSync(path.join(dir, names.feed), dumpFeed({ version, files, path: names.zips[0], sha512: ids[names.zips[0]].sha512 }));
  return dir;
}

test('versions: next stable patch above every stable tag and the floor; Dev builds on that base with a rising suffix', () => {
  const plan = (versions, channel, floor = '1.0.32') => planVersion({ versions, channel, floor, now: NOW });
  assert.strictEqual(plan([], 'stable'), '1.0.35'); // bootstrap floor 1.0.34
  assert.strictEqual(plan(['1.0.35', '1.0.36', '1.0.36-dev.20261029000000'], 'stable'), '1.0.37'); // drafts count too
  assert.strictEqual(plan([], 'stable', '1.0.40'), '1.0.41'); // checkout VERSION raises the floor
  assert.strictEqual(plan([], 'dev'), '1.0.35-dev.20261030010000');
  assert.strictEqual(plan(['1.0.35'], 'dev'), '1.0.36-dev.20261030010000'); // follows the next stable base
  assert.strictEqual(plan(['1.0.35-dev.20991231235959'], 'dev'), '1.0.35-dev.20991231235960'); // strictly above existing suffixes
  assert.strictEqual(plan(['1.0.37-dev.20261029000000', '1.0.35'], 'dev'), '1.0.37-dev.20261030010000'); // highest Dev base wins
});

test('a retry reuses its reservation; a moved branch or newer release stops it', async () => {
  const { state, client } = fakeGitHub();
  state.branches.dev = sha('a');
  const ctx = context(client, planFor('dev', sha('a')));

  const first = await reserve(ctx);
  const again = await reserve(ctx);
  assert.deepStrictEqual(again, first);
  assert.strictEqual(state.releases.length, 1);
  const draft = state.releases[0];
  assert.ok(draft.draft && draft.prerelease, 'Dev reserves a prerelease draft');
  assert.strictEqual(recordOf(draft).sourceCommit, sha('a'));

  // A newer push moves dev: the old source can neither reserve nor publish.
  state.branches.dev = sha('b');
  await assert.rejects(reserve(ctx), /stale/);
  const dir = finalizedDist(first.version, 'dev');
  try {
    await assert.rejects(publish(ctx, dir), /stale/);
    // Even back on the old commit, a newer same-channel reservation supersedes the draft.
    const newer = await reserve(context(client, planFor('dev', sha('b'))));
    state.branches.dev = sha('a');
    await assert.rejects(publish(ctx, dir), new RegExp(`superseded by v${newer.version.replace(/\./g, '\\.')}`));
    assert.ok(state.releases.every((r) => r.draft), 'nothing was published');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('publishing uploads and verifies the full set; a published source is a no-op even on an old rerun', async () => {
  const { state, client } = fakeGitHub();
  state.branches.main = sha('c');
  const ctx = context(client, planFor('stable', sha('c')));
  const { version } = await reserve(ctx);
  const dir = finalizedDist(version, 'stable');
  try {
    const result = await publish(ctx, dir);
    assert.deepStrictEqual(result, { published: true, version: '1.0.35' });
    const release = state.releases[0];
    assert.strictEqual(release.draft, false);
    assert.strictEqual(release.make_latest, 'true');
    const names = artifactNames(version, 'stable');
    assert.deepStrictEqual(release.assets.map((a) => a.name).sort(),
      [...names.zips, ...names.dmgs, ...names.zipBlockmaps, names.feed, 'release-receipt.json'].sort());

    // main moves on; rerunning the old run reports the published release instead of building again.
    state.branches.main = sha('d');
    assert.deepStrictEqual(await reserve(ctx), { published: true, version: '1.0.35' });
    assert.strictEqual(state.releases.length, 1);

    // Published bytes that no longer match the receipt fail verification rather than passing as done.
    const dmg = release.assets.find((a) => a.name === names.dmgs[0]);
    state.bytes.set(dmg.id, Buffer.alloc(dmg.size));
    await assert.rejects(reserve(ctx), /hash differs/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a build whose feed does not match its files is never uploaded', async () => {
  const { state, client } = fakeGitHub();
  state.branches.main = sha('c');
  const ctx = context(client, planFor('stable', sha('c')));
  const { version } = await reserve(ctx);
  const dir = finalizedDist(version, 'stable');
  try {
    fs.appendFileSync(path.join(dir, artifactNames(version, 'stable').zips[1]), 'changed after the feed was written');
    await assert.rejects(publish(ctx, dir), /does not match its bytes/);
    assert.strictEqual(state.releases[0].assets.length, 0);
    assert.strictEqual(state.releases[0].draft, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
