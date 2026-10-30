#!/usr/bin/env node
'use strict';
// Reserves, publishes and verifies Repo Radar releases in ReperioHealth/repo-radar-releases.
//
//   release-control.js reserve                 GitHub Actions: reserve this commit's version as a draft,
//                                              or report that it is already published
//   release-control.js publish --dir <dist>    GitHub Actions: upload the finalized build to its draft,
//                                              verify the uploaded bytes, then publish it
//   release-control.js bootstrap --dir <dist> --version <x.y.z> --source <sha>
//                                              Operator, with local gh auth: publish the preserved 1.0.34
//                                              build from 4283e74 (pinned in release-artifacts.js), after
//                                              release-dmg.js has finalized its DMGs
//
// A release is keyed by channel plus source commit and tree, recorded in its body. Stable takes the next
// patch above every stable tag, the bootstrap floor and the checkout's VERSION; Dev takes the greater of
// that base and the highest Dev base, with a UTC timestamp suffix above any existing one. A retry reuses
// its reservation. Before reserving and again just before publishing, the branch must still point at the
// source commit and no newer same-channel release may exist. An already-published source is verified and
// treated as done, even on an old rerun. Published releases are never edited; only owned drafts are.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const { releaseEnv } = require('./release-env');
const { FEED_OWNER, FEED_REPO, STABLE_VERSION, DEV_VERSION, BOOTSTRAP_BUILD, channelOf, fileIdentity } = require('./release-artifacts');
const { verifyFinalized } = require('./release-dmg');

const SOURCE_REPO = 'ReperioHealth/repo-radar';
const RELEASES_REPO = `${FEED_OWNER}/${FEED_REPO}`;
const SCHEMA = 'repo-radar-release/1';
const BOOTSTRAP_FLOOR = '1.0.34';
const RECEIPT = 'release-receipt.json';
const MARKER = /<!-- repo-radar-release (\{[^\n]*\}) -->/;
const SHA = /^[0-9a-f]{40}$/;
const ROOT = path.join(__dirname, '..', '..');

// ---- versions -------------------------------------------------------------------------------------

function parseVersion(v) {
  const m = STABLE_VERSION.exec(v) || DEV_VERSION.exec(v);
  if (!m) return null;
  return { base: [BigInt(m[1]), BigInt(m[2]), BigInt(m[3])], dev: m[4] === undefined ? null : BigInt(m[4]) };
}

function compareBase(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

// Semver order: a Dev build precedes the stable release with the same base.
function compareVersion(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  const c = compareBase(x.base, y.base);
  if (c !== 0) return c;
  if (x.dev === null || y.dev === null) return x.dev === y.dev ? 0 : (x.dev === null ? 1 : -1);
  return x.dev === y.dev ? 0 : (x.dev > y.dev ? 1 : -1);
}

const baseString = (base) => base.join('.');
const maxBase = (bases) => bases.reduce((a, b) => (compareBase(a, b) >= 0 ? a : b));
const utcStamp = (now) => now.toISOString().replace(/[-:T]/g, '').slice(0, 14);

// `versions` are every version tagged in the releases repository, drafts included.
function planVersion({ versions, channel, floor, now }) {
  const parsed = versions.map(parseVersion).filter(Boolean);
  const stableBases = parsed.filter((p) => p.dev === null).map((p) => p.base);
  const floors = [parseVersion(BOOTSTRAP_FLOOR).base, ...(floor ? [parseVersion(floor).base] : [])];
  const top = maxBase([...floors, ...stableBases]);
  const nextStable = [top[0], top[1], top[2] + 1n];
  if (channel === 'stable') return baseString(nextStable);
  if (channel !== 'dev') throw new Error(`unknown channel: ${channel}`);
  const devs = parsed.filter((p) => p.dev !== null);
  const base = maxBase([nextStable, ...devs.map((p) => p.base)]);
  const taken = devs.filter((p) => compareBase(p.base, base) === 0).map((p) => p.dev);
  let suffix = BigInt(utcStamp(now));
  for (const t of taken) if (t >= suffix) suffix = t + 1n;
  return `${baseString(base)}-dev.${suffix}`;
}

// ---- release records ------------------------------------------------------------------------------

const versionOf = (release) => (/^v(.+)$/.exec(release.tag_name || '') || [])[1];

function recordOf(release) {
  const m = MARKER.exec(release.body || '');
  if (!m) return null;
  let r;
  try { r = JSON.parse(m[1]); } catch { return null; }
  if (!r || r.schema !== SCHEMA || channelOf(r.version) !== r.channel || release.tag_name !== `v${r.version}`) return null;
  if (!SHA.test(r.sourceCommit) || !SHA.test(r.sourceTree)) return null;
  if (Boolean(release.prerelease) !== (r.channel === 'dev')) return null;
  return r;
}

const sameSource = (r, plan) => Boolean(r) && r.channel === plan.channel
  && r.sourceCommit === plan.sourceCommit && r.sourceTree === plan.sourceTree;

function findOwn(releases, plan) {
  const own = releases.filter((r) => sameSource(recordOf(r), plan));
  if (own.length > 1) throw new Error(`more than one release claims ${plan.channel} source ${plan.sourceCommit}`);
  return own[0] || null;
}

// A newer same-channel release, draft or published, means this reservation can no longer publish.
function assertNotSuperseded(releases, own) {
  const version = recordOf(own).version;
  const channel = channelOf(version);
  const newer = releases.filter((r) => r.id !== own.id).map(versionOf)
    .filter((v) => v && channelOf(v) === channel && compareVersion(v, version) > 0);
  if (newer.length) throw new Error(`v${version} was superseded by v${newer.sort(compareVersion).pop()}`);
}

async function assertCurrent(ctx) {
  const head = await ctx.client.branchSha(ctx.plan.branch);
  if (head !== ctx.plan.sourceCommit) {
    throw new Error(`${ctx.plan.branch} moved to ${head}; this run's source ${ctx.plan.sourceCommit} is stale`);
  }
}

// Notes are fixed when the draft is reserved: what changed in the source since the previous published
// release of this channel, and the changelog as of this commit. The artifact repository's own generated
// notes would describe only its README commit.
function notesFor(releases, plan, version, { bootstrap = false } = {}) {
  const repo = `https://github.com/${plan.sourceRepo}`;
  const short = (sha) => sha.slice(0, 7);
  const changelog = `[CHANGELOG.md at ${short(plan.sourceCommit)}](${repo}/blob/${plan.sourceCommit}/CHANGELOG.md)`;
  const commit = `[${short(plan.sourceCommit)}](${repo}/commit/${plan.sourceCommit})`;
  if (bootstrap) return `First organization release, built from ${commit}. See ${changelog}.`;
  const previous = releases.filter((r) => !r.draft).map(recordOf)
    .filter((r) => r && r.channel === plan.channel && compareVersion(r.version, version) < 0)
    .sort((a, b) => compareVersion(a.version, b.version)).pop();
  if (!previous) return `Built from ${commit}. See ${changelog}.`;
  const range = `${previous.sourceCommit}...${plan.sourceCommit}`;
  return `Changes since v${previous.version}: [${short(previous.sourceCommit)}...${short(plan.sourceCommit)}](${repo}/compare/${range}). See ${changelog}.`;
}

function releaseBody(record, notes) {
  return [
    notes,
    '',
    '---',
    '',
    `This repository holds release files only: v${record.version} is an artifact tag on its README commit, not a source revision.`,
    '',
    `<!-- repo-radar-release ${JSON.stringify(record)} -->`,
  ].join('\n');
}

async function createDraft(ctx, releases, version, extra = {}) {
  const { plan, client } = ctx;
  const record = {
    schema: SCHEMA, channel: plan.channel, version, sourceRepo: plan.sourceRepo,
    sourceCommit: plan.sourceCommit, sourceTree: plan.sourceTree, ...extra,
  };
  const dev = plan.channel === 'dev';
  return client.createRelease({
    tag_name: `v${version}`,
    name: `${dev ? 'Repo Radar Dev' : 'Repo Radar'} v${version}`,
    body: releaseBody(record, notesFor(releases, plan, version, { bootstrap: Boolean(extra.bootstrap) })),
    draft: true,
    prerelease: dev,
  });
}

// ---- verification ---------------------------------------------------------------------------------

async function verifyPublished(ctx, release) {
  const r = recordOf(release);
  if (release.draft || !sameSource(r, ctx.plan)) throw new Error(`v${versionOf(release)} does not match this source`);
  const receiptAsset = release.assets.find((a) => a.name === RECEIPT);
  if (!receiptAsset) throw new Error(`v${r.version} has no ${RECEIPT}`);
  const receipt = JSON.parse(await ctx.client.assetText(receiptAsset));
  for (const key of ['schema', 'channel', 'version', 'sourceCommit', 'sourceTree']) {
    if (receipt[key] !== r[key]) throw new Error(`v${r.version} receipt ${key} differs from its release record`);
  }
  const expected = receipt.artifacts || [];
  if (release.assets.length !== expected.length + 1) throw new Error(`v${r.version} assets differ from its receipt`);
  for (const a of expected) {
    const asset = release.assets.find((x) => x.name === a.name);
    if (!asset || asset.size !== a.size) throw new Error(`v${r.version} asset ${a.name} differs from its receipt`);
    if (await ctx.client.assetSha256(asset) !== a.sha256) throw new Error(`v${r.version} asset ${a.name} hash differs`);
  }
  return r;
}

// The finalized build: both ZIPs, both stapled DMGs, the channel's feed and any ZIP blockmaps, exactly
// as the DMG finalizer recorded them, with both DMGs passing the read-only Apple checks again.
async function stage(ctx, dir, version) {
  const finalization = await verifyFinalized({ dir, version, source: ctx.plan.sourceCommit, pins: ctx.bootstrapBuild || BOOTSTRAP_BUILD, run: ctx.appleRun });
  const artifacts = [...finalization.zips, ...finalization.dmgs.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
    finalization.feed, ...finalization.zipBlockmaps];
  return { artifacts, finalization };
}

// Replaces everything on an owned draft with the staged files and receipt, checks every uploaded byte,
// then rechecks the source and ordering immediately before publishing.
async function publishDraft(ctx, own, dir, { recheck, receiptExtra }) {
  const { client, plan } = ctx;
  const record = recordOf(own);
  const { artifacts, finalization } = await stage(ctx, dir, record.version);
  const receipt = {
    schema: SCHEMA, channel: record.channel, version: record.version, sourceRepo: record.sourceRepo,
    sourceCommit: record.sourceCommit, sourceTree: record.sourceTree, artifacts, finalization, ...receiptExtra,
  };
  const receiptPath = path.join(dir, RECEIPT);
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const files = [...artifacts.map((a) => ({ ...a, file: path.join(dir, a.name) })),
    { name: RECEIPT, file: receiptPath, ...fileIdentity(receiptPath) }];

  for (const asset of own.assets) await client.deleteAsset(asset);
  for (const f of files) {
    ctx.log(`uploading ${f.name}`);
    await client.uploadAsset(own, f.name, f.file);
  }
  const uploaded = await client.getRelease(own.id);
  if (uploaded.assets.length !== files.length) throw new Error('the draft holds a different set of files than was uploaded');
  for (const f of files) {
    const asset = uploaded.assets.find((a) => a.name === f.name);
    if (!asset || asset.size !== f.size) throw new Error(`uploaded ${f.name} has the wrong size`);
    if (await client.assetSha256(asset) !== f.sha256) throw new Error(`uploaded ${f.name} hash differs`);
  }

  const releases = await client.listReleases();
  const still = releases.find((r) => r.id === own.id);
  if (!still || !still.draft || !sameSource(recordOf(still), plan)) throw new Error('the draft changed during upload');
  await recheck(releases, still);
  const dev = plan.channel === 'dev';
  await client.updateRelease(own.id, { draft: false, prerelease: dev, make_latest: dev ? 'false' : 'true' });
  ctx.log(`published v${record.version}`);
  return { published: true, version: record.version };
}

// ---- commands -------------------------------------------------------------------------------------

async function reserve(ctx) {
  const releases = await ctx.client.listReleases();
  const own = findOwn(releases, ctx.plan);
  if (own && !own.draft) {
    const r = await verifyPublished(ctx, own);
    ctx.log(`v${r.version} is already published from this source; nothing to do`);
    return { published: true, version: r.version };
  }
  await assertCurrent(ctx);
  if (own) {
    assertNotSuperseded(releases, own);
    return { published: false, version: recordOf(own).version };
  }
  const version = planVersion({ versions: releases.map(versionOf).filter(Boolean), channel: ctx.plan.channel, floor: ctx.floor, now: ctx.now() });
  if (releases.some((r) => r.tag_name === `v${version}`)) throw new Error(`v${version} is already taken`);
  await createDraft(ctx, releases, version);
  ctx.log(`reserved v${version}`);
  return { published: false, version };
}

async function publish(ctx, dir) {
  const releases = await ctx.client.listReleases();
  const own = findOwn(releases, ctx.plan);
  if (!own) throw new Error(`no reservation for ${ctx.plan.channel} source ${ctx.plan.sourceCommit}`);
  if (!own.draft) {
    const r = await verifyPublished(ctx, own);
    return { published: true, version: r.version, already: true };
  }
  await assertCurrent(ctx);
  assertNotSuperseded(releases, own);
  return publishDraft(ctx, own, dir, {
    receiptExtra: { toolchain: ctx.toolchain, run: ctx.run },
    recheck: async (latest, still) => { await assertCurrent(ctx); assertNotSuperseded(latest, still); },
  });
}

async function bootstrap(ctx, dir, version) {
  const { client, plan } = ctx;
  const pin = ctx.bootstrapBuild || BOOTSTRAP_BUILD;
  if (version !== pin.version || plan.sourceCommit !== pin.source) {
    throw new Error(`bootstrap publishes only the preserved ${pin.version} build from ${pin.source}`);
  }
  if (!await client.onBranch(plan.sourceCommit, plan.branch)) throw new Error(`${plan.sourceCommit} is not on ${plan.branch}`);
  const releases = await client.listReleases();
  let own = findOwn(releases, plan);
  if (own && !own.draft) {
    const r = await verifyPublished(ctx, own);
    return { published: true, version: r.version, already: true };
  }
  if (own && recordOf(own).version !== version) throw new Error(`this source is reserved as v${recordOf(own).version}, not v${version}`);
  await stage(ctx, dir, version); // before any draft exists
  if (!own) {
    if (releases.some((r) => r.tag_name === `v${version}`)) throw new Error(`v${version} belongs to another source`);
    own = await createDraft(ctx, releases, version, { bootstrap: true });
  }
  assertNotSuperseded(releases, own);
  return publishDraft(ctx, own, dir, {
    receiptExtra: { bootstrap: true, builtWith: 'build-local.sh' },
    recheck: async (latest, still) => { assertNotSuperseded(latest, still); },
  });
}

// ---- GitHub ---------------------------------------------------------------------------------------

function githubClient({ sourceRepo, sourceToken, releasesToken }) {
  async function call(url, { method = 'GET', token, body, accept = 'application/vnd.github+json', headers = {}, raw = false } = {}) {
    const res = await fetch(url, {
      method,
      headers: { Accept: accept, Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', ...headers },
      body,
      duplex: body && typeof body !== 'string' ? 'half' : undefined,
      signal: AbortSignal.timeout(600_000),
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${url.replace(/\?.*/, '')}: HTTP ${res.status}`);
    if (raw) return res;
    return res.status === 204 ? null : res.json();
  }
  const api = (repo, p, opts = {}) => call(`https://api.github.com/repos/${repo}/${p}`, {
    token: repo === RELEASES_REPO ? releasesToken : sourceToken, ...opts,
  });
  const json = (body) => ({ body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  const assetResponse = (asset) => api(RELEASES_REPO, `releases/assets/${asset.id}`, { accept: 'application/octet-stream', raw: true });
  return {
    async listReleases() {
      const all = [];
      for (let page = 1; ; page++) {
        const rows = await api(RELEASES_REPO, `releases?per_page=100&page=${page}`);
        all.push(...rows);
        if (rows.length < 100) return all;
      }
    },
    getRelease: (id) => api(RELEASES_REPO, `releases/${id}`),
    createRelease: (payload) => api(RELEASES_REPO, 'releases', { method: 'POST', ...json(payload) }),
    updateRelease: (id, patch) => api(RELEASES_REPO, `releases/${id}`, { method: 'PATCH', ...json(patch) }),
    deleteAsset: (asset) => api(RELEASES_REPO, `releases/assets/${asset.id}`, { method: 'DELETE' }),
    async uploadAsset(release, name, file) {
      const url = `${release.upload_url.replace(/\{.*\}$/, '')}?name=${encodeURIComponent(name)}`;
      const { size } = fs.statSync(file);
      const { Readable } = require('stream');
      await call(url, {
        method: 'POST', token: releasesToken, body: Readable.toWeb(fs.createReadStream(file)),
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
      });
    },
    async assetSha256(asset) {
      const hash = crypto.createHash('sha256');
      for await (const chunk of (await assetResponse(asset)).body) hash.update(chunk);
      return hash.digest('hex');
    },
    assetText: async (asset) => (await assetResponse(asset)).text(),
    branchSha: async (branch) => (await api(sourceRepo, `git/ref/heads/${branch}`)).object.sha,
    commitTree: async (sha) => (await api(sourceRepo, `git/commits/${sha}`)).tree.sha,
    onBranch: async (sha, branch) => ['ahead', 'identical'].includes((await api(sourceRepo, `compare/${sha}...${branch}`)).status),
  };
}

// ---- CLI ------------------------------------------------------------------------------------------

const git = (...args) => childProcess.execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', env: releaseEnv() }).trim();
const opt = (argv, name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const sha256File = (file) => fileIdentity(file).sha256;

function output(values) {
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join('');
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, lines);
  process.stdout.write(lines);
}

function baseContext(plan, client) {
  const version = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
  return {
    plan, client,
    floor: parseVersion(version) ? version.split('-')[0] : null,
    now: () => new Date(),
    log: (l) => process.stderr.write(`${l}\n`),
  };
}

function actionsContext() {
  const env = process.env;
  if (env.GITHUB_ACTIONS !== 'true') throw new Error('reserve and publish run only in GitHub Actions');
  if (env.GITHUB_REPOSITORY !== SOURCE_REPO) throw new Error(`releases are built only from ${SOURCE_REPO}`);
  const branch = { 'refs/heads/main': 'main', 'refs/heads/dev': 'dev' }[env.GITHUB_REF];
  if (!branch) throw new Error(`releases are built only from main or dev, not ${env.GITHUB_REF}`);
  const sourceCommit = git('rev-parse', 'HEAD');
  if (sourceCommit !== env.GITHUB_SHA) throw new Error('the checkout is not the triggering commit');
  if (!env.SOURCE_TOKEN || !env.RELEASES_REPO_TOKEN) throw new Error('SOURCE_TOKEN and RELEASES_REPO_TOKEN are required');
  const plan = { channel: branch === 'main' ? 'stable' : 'dev', branch, sourceRepo: SOURCE_REPO, sourceCommit, sourceTree: git('rev-parse', 'HEAD^{tree}') };
  return baseContext(plan, githubClient({ sourceRepo: SOURCE_REPO, sourceToken: env.SOURCE_TOKEN, releasesToken: env.RELEASES_REPO_TOKEN }));
}

// The operator's GitHub token for bootstrap: one supplied explicitly, or gh's saved login. gh runs
// with the minimal environment; the token stays in this process and is never printed.
function localToken(env) {
  if (env.GH_TOKEN || env.GITHUB_TOKEN) return env.GH_TOKEN || env.GITHUB_TOKEN;
  return childProcess.execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], { encoding: 'utf8', env: releaseEnv(env) }).trim();
}

// What built the release, for its receipt. Runs after the build, when the release venv exists.
function toolchain(env) {
  const python = childProcess.execFileSync(env.REPO_RADAR_RELEASE_PYTHON, ['-I', '-c', 'import sys;print(sys.version.split()[0])'],
    { encoding: 'utf8', env: releaseEnv(env) }).trim();
  const lock = `cp3${python.split('.')[1]}-${process.arch === 'arm64' ? 'arm64' : 'x86_64'}.lock`;
  return {
    node: process.version,
    xcode: childProcess.execFileSync('xcodebuild', ['-version'], { encoding: 'utf8', env: releaseEnv(env) }).trim().replace(/\n/g, ' / '),
    python,
    runnerImage: `${env.ImageOS || 'unknown'} ${env.ImageVersion || ''}`.trim(),
    npmLockSha256: sha256File(path.join(ROOT, 'menubar', 'package-lock.json')),
    pythonLock: lock,
    pythonLockSha256: sha256File(path.join(ROOT, 'resources', 'pydeps', lock)),
  };
}

async function main(argv) {
  const command = argv[0];
  if (command === 'reserve') {
    if (argv.length !== 1) throw new Error('usage: release-control.js reserve');
    const ctx = actionsContext();
    const r = await reserve(ctx);
    output({ channel: ctx.plan.channel, version: r.version, published: r.published });
    return;
  }
  if (command === 'publish') {
    const dir = opt(argv, '--dir');
    if (!dir || argv.length !== 3) throw new Error('usage: release-control.js publish --dir <dist>');
    const ctx = actionsContext();
    ctx.toolchain = toolchain(process.env);
    ctx.run = { workflow: process.env.GITHUB_WORKFLOW, id: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT };
    const r = await publish(ctx, path.resolve(dir));
    output({ version: r.version, published: r.published });
    return;
  }
  if (command === 'bootstrap') {
    const dir = opt(argv, '--dir');
    const version = opt(argv, '--version');
    const source = opt(argv, '--source');
    if (!dir || !version || !SHA.test(source || '') || argv.length !== 7) {
      throw new Error('usage: release-control.js bootstrap --dir <dist> --version <x.y.z> --source <40-character sha>');
    }
    if (process.env.GITHUB_ACTIONS === 'true') throw new Error('bootstrap is an operator command; CI uses reserve and publish');
    const token = localToken(process.env);
    const client = githubClient({ sourceRepo: SOURCE_REPO, sourceToken: token, releasesToken: token });
    const plan = { channel: 'stable', branch: 'main', sourceRepo: SOURCE_REPO, sourceCommit: source, sourceTree: await client.commitTree(source) };
    const r = await bootstrap(baseContext(plan, client), path.resolve(dir), version);
    output({ version: r.version, published: r.published });
    return;
  }
  throw new Error('usage: release-control.js reserve | publish --dir <dist> | bootstrap --dir <dist> --version <v> --source <sha>');
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`release stopped: ${e.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  SCHEMA, RECEIPT, SOURCE_REPO, RELEASES_REPO, BOOTSTRAP_FLOOR,
  parseVersion, compareVersion, planVersion, recordOf, notesFor, reserve, publish, bootstrap, verifyPublished,
  actionsContext, toolchain, localToken,
};
