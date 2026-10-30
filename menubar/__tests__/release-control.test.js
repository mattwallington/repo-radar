// Release reservation and publication against an in-memory GitHub: version numbering, retries reusing
// their reservation, stale sources refused, and an already-published source treated as done.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { artifactNames, fileIdentity } = require('../scripts/release-artifacts');
const { finalize } = require('../scripts/release-dmg');
const { planVersion, reserve, publish, bootstrap, recordOf } = require('../scripts/release-control');
const { makeBuild, appleTools, appZip, writeFeed } = require('./helpers/release-fixtures');

const NOW = new Date('2026-10-30T01:00:00Z');
const sha = (n) => String(n).repeat(40).slice(0, 40);

// The releases repository and the source branches, as the controller sees them through its client.
function fakeGitHub() {
  const state = { releases: [], branches: {}, ancestors: {}, bytes: new Map(), nextId: 1 };
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
    onBranch: async (commit, branch) => (state.ancestors[branch] || []).includes(commit),
  };
  return { state, client };
}

function context(client, plan) {
  return {
    client, plan, floor: '1.0.32', now: () => NOW, log: () => {},
    toolchain: { node: 'test' }, run: { id: '1' }, appleRun: appleTools().run,
  };
}

const planFor = (channel, commit) => ({
  channel, branch: channel === 'stable' ? 'main' : 'dev', sourceRepo: 'ReperioHealth/repo-radar', sourceCommit: commit, sourceTree: sha('e'),
});

// A build from `commit` that the DMG finalizer has completed (with stand-in Apple tools).
async function finalizedDist(version, channel, commit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-release-control-'));
  makeBuild(dir, { version, channel, source: commit });
  await finalize({ dir, version, source: commit, run: appleTools().run, env: {} });
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
  const dir = await finalizedDist(first.version, 'dev', sha('a'));
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
  const dir = await finalizedDist(version, 'stable', sha('c'));
  try {
    const result = await publish(ctx, dir);
    assert.deepStrictEqual(result, { published: true, version: '1.0.35' });
    const release = state.releases[0];
    assert.strictEqual(release.draft, false);
    assert.strictEqual(release.make_latest, 'true');
    const names = artifactNames(version, 'stable');
    assert.deepStrictEqual(release.assets.map((a) => a.name).sort(),
      [...names.zips, ...names.dmgs, ...names.zipBlockmaps, names.feed, 'release-receipt.json'].sort());
    const receipt = JSON.parse(state.bytes.get(release.assets.find((a) => a.name === 'release-receipt.json').id).toString());
    assert.strictEqual(receipt.finalization.source, sha('c'), 'the receipt carries the verified finalization result');
    assert.match(release.body, new RegExp(`^Built from \\[ccccccc\\]\\(https://github\\.com/ReperioHealth/repo-radar/commit/${sha('c')}\\)\\. See \\[CHANGELOG\\.md at ccccccc\\]\\(https://github\\.com/ReperioHealth/repo-radar/blob/${sha('c')}/CHANGELOG\\.md\\)`));

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

test('a build whose files changed after finalization is never uploaded', async () => {
  const { state, client } = fakeGitHub();
  state.branches.main = sha('c');
  const ctx = context(client, planFor('stable', sha('c')));
  const { version } = await reserve(ctx);
  const dir = await finalizedDist(version, 'stable', sha('c'));
  try {
    fs.appendFileSync(path.join(dir, artifactNames(version, 'stable').zips[1]), 'changed after the feed was written');
    await assert.rejects(publish(ctx, dir), /is not the file that was finalized/);
    assert.strictEqual(state.releases[0].assets.length, 0);
    assert.strictEqual(state.releases[0].draft, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Pins for a fixture build, the way BOOTSTRAP_BUILD pins the real 1.0.34.
function pinsFor(dir, source) {
  const names = artifactNames('1.0.34', 'stable');
  const original = {};
  for (const n of [...names.zips, ...names.dmgs, names.feed, ...names.zipBlockmaps]) original[n] = fileIdentity(path.join(dir, n)).sha256;
  return { version: '1.0.34', source, original };
}

function bootstrapFixture(state) {
  const nothingPublished = () => {
    assert.ok(state.releases.every((r) => r.draft && r.assets.length === 0), 'zero uploads, nothing published');
  };
  return { nothingPublished, scratch: fs.mkdtempSync(path.join(os.tmpdir(), 'rr-release-bootstrap-')) };
}

test('bootstrap publishes only a finalized build whose DMGs still pass the Apple checks', async () => {
  const { state, client } = fakeGitHub();
  const source = sha('f');
  state.ancestors.main = [source];
  const { nothingPublished, scratch } = bootstrapFixture(state);
  const build = (name) => {
    const dir = path.join(scratch, name);
    makeBuild(dir, { version: '1.0.34', channel: 'stable', source });
    return { dir, pins: pinsFor(dir, source) };
  };
  const ctxFor = (pins, appleRun = appleTools().run) => ({ ...context(client, planFor('stable', source)), bootstrapBuild: pins, appleRun });
  try {
    // The builder's own output: its feed has no DMG blockMapSize, so only the finalizer's record can tell.
    const raw = build('raw');
    await assert.rejects(bootstrap(ctxFor(raw.pins), raw.dir, '1.0.34'), /no release-finalization\.json/);
    nothingPublished();

    // Finalized, then a DMG changed.
    const changed = build('changed');
    await finalize({ dir: changed.dir, version: '1.0.34', source, pins: changed.pins, run: appleTools().run, env: {} });
    fs.appendFileSync(path.join(changed.dir, artifactNames('1.0.34', 'stable').dmgs[0]), 'x');
    await assert.rejects(bootstrap(ctxFor(changed.pins), changed.dir, '1.0.34'), /is not the file that was finalized/);
    nothingPublished();

    // Finalized, but a DMG no longer passes Gatekeeper.
    const good = build('good');
    await finalize({ dir: good.dir, version: '1.0.34', source, pins: good.pins, run: appleTools().run, env: {} });
    await assert.rejects(bootstrap(ctxFor(good.pins, appleTools({ fail: 'assess' }).run), good.dir, '1.0.34'), /assess exited 1/);
    nothingPublished();

    // Control: the same finalized build from the pinned source, ZIPs unchanged and checks passing, publishes as Latest.
    assert.deepStrictEqual(await bootstrap(ctxFor(good.pins), good.dir, '1.0.34'), { published: true, version: '1.0.34' });
    const published = state.releases.filter((r) => !r.draft);
    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].make_latest, 'true');
    assert.strictEqual(recordOf(published[0]).sourceCommit, source);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('bootstrap binds the pinned source and original ZIPs, read from inside the archives', async () => {
  const { state, client } = fakeGitHub();
  const real = sha('f');
  const parent = sha('9'); // also on main, so ancestry alone would accept it
  state.ancestors.main = [real, parent];
  const { nothingPublished, scratch } = bootstrapFixture(state);
  const names = artifactNames('1.0.34', 'stable');
  try {
    // A different source than the pinned one is refused before any draft.
    const dir = path.join(scratch, 'build');
    makeBuild(dir, { version: '1.0.34', channel: 'stable', source: real });
    const pins = pinsFor(dir, real);
    await finalize({ dir, version: '1.0.34', source: real, pins, run: appleTools().run, env: {} });
    const ctx = { ...context(client, planFor('stable', parent)), bootstrapBuild: pins };
    await assert.rejects(bootstrap(ctx, dir, '1.0.34'), /only the preserved 1\.0\.34 build from f+/);
    nothingPublished();

    // Pins that name the parent cannot be satisfied: the apps inside the ZIPs say they came from the real source.
    const claimed = path.join(scratch, 'claimed');
    makeBuild(claimed, { version: '1.0.34', channel: 'stable', source: real });
    const wrongPins = pinsFor(claimed, parent);
    await assert.rejects(finalize({ dir: claimed, version: '1.0.34', source: parent, pins: wrongPins, run: appleTools().run, env: {} }),
      new RegExp(`arm64-mac\\.zip: built from ${real}, not ${parent}`));
    await assert.rejects(bootstrap({ ...ctx, bootstrapBuild: wrongPins }, claimed, '1.0.34'), /no release-finalization\.json/);
    nothingPublished();

    // A replaced ZIP with a regenerated, self-consistent feed still fails the pinned ZIP identity.
    const replaced = path.join(scratch, 'replaced');
    makeBuild(replaced, { version: '1.0.34', channel: 'stable', source: real });
    const originalPins = pinsFor(replaced, real);
    fs.rmSync(path.join(replaced, names.zips[0]));
    appZip(replaced, names.zips[0], { version: '1.0.34', channel: 'stable', source: real, arch: 'arm64' });
    writeFeed(replaced, '1.0.34', 'stable');
    await assert.rejects(finalize({ dir: replaced, version: '1.0.34', source: real, pins: originalPins, run: appleTools().run, env: {} }),
      /arm64-mac\.zip is not the original 1\.0\.34 file/);
    await assert.rejects(bootstrap({ ...context(client, planFor('stable', real)), bootstrapBuild: originalPins }, replaced, '1.0.34'),
      /no release-finalization\.json/);
    nothingPublished();
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
