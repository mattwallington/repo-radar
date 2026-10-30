#!/usr/bin/env node
'use strict';
// The release artifact set and its update feed, shared by build-local.sh, the DMG finalizer and the
// release controller. Read-only: nothing here signs, uploads or changes a file.
//
//   release-artifacts.js check-feed --dir <dist> --version <v> --channel stable|dev [--finalized]
//   release-artifacts.js check-app-update <path to .app> stable|dev
//
// Builds cover arm64 and x64. Updating apps download the ZIP named in the channel's feed, so the feed
// must describe the exact ZIP bytes for both architectures. electron-builder also lists both DMGs; once
// the finalizer has signed and stapled them, those entries must describe the final DMG bytes.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const TEAM_ID = 'F8UY7565VM';
const SIGNING_IDENTITY = `Developer ID Application: Reperio Health, Inc. (${TEAM_ID})`;
const NOTARY_PROFILE = 'reperio-notary';
const FEED_OWNER = 'ReperioHealth';
const FEED_REPO = 'repo-radar-releases';
const ARCHES = Object.freeze(['arm64', 'x64']);
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DEV_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-dev\.([1-9]\d*)$/;
const SHA512_B64 = /^[A-Za-z0-9+/]{86}==$/;
const FEED_KEYS = new Set(['version', 'files', 'path', 'sha512', 'releaseDate']);
const FILE_KEYS = new Set(['url', 'sha512', 'size', 'blockMapSize']);
// The installed app finds its feed through app-update.yml. Dev keeps a separate download cache.
const BUNDLE_IDS = Object.freeze({ stable: 'com.mattwallington.repo-radar', dev: 'com.mattwallington.repo-radar-dev' });
const PRODUCT_NAMES = Object.freeze({ stable: 'Repo Radar', dev: 'Repo Radar Dev' });
const APP_UPDATE = Object.freeze({
  stable: { provider: 'github', owner: FEED_OWNER, repo: FEED_REPO, updaterCacheDirName: 'repo-radar-updater' },
  dev: { provider: 'github', owner: FEED_OWNER, repo: FEED_REPO, updaterCacheDirName: 'repo-radar-dev-updater' },
});

function yaml() {
  return require('js-yaml');
}

function channelOf(version) {
  if (STABLE_VERSION.test(version)) return 'stable';
  if (DEV_VERSION.test(version)) return 'dev';
  return null;
}

// electron-builder writes latest-mac.yml. Dev apps run with allowPrerelease and look for the feed
// named after their own prerelease tag, so Dev releases carry it as dev-mac.yml.
function feedName(channel) {
  if (channel === 'stable') return 'latest-mac.yml';
  if (channel === 'dev') return 'dev-mac.yml';
  throw new Error(`unknown channel: ${channel}`);
}

// Artifact prefix is always "repo-radar" (the npm package name, used by ${name} in artifactName).
function artifactNames(version, channel) {
  if (channelOf(version) !== channel) throw new Error(`version ${version} is not a ${channel} version`);
  const names = { zips: [], dmgs: [], zipBlockmaps: [], dmgBlockmaps: [], feed: feedName(channel) };
  for (const arch of ARCHES) {
    const base = `repo-radar-${version}-${arch}-mac`;
    names.zips.push(`${base}.zip`);
    names.dmgs.push(`${base}.dmg`);
    names.zipBlockmaps.push(`${base}.zip.blockmap`);
    names.dmgBlockmaps.push(`${base}.dmg.blockmap`);
  }
  return names;
}

function identity(bytes) {
  return {
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    sha512: crypto.createHash('sha512').update(bytes).digest('base64'),
  };
}

// Streams the file, so a 100 MB artifact is never held in memory.
function fileIdentity(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile()) throw new Error(`not a regular file: ${file}`);
  const sha256 = crypto.createHash('sha256');
  const sha512 = crypto.createHash('sha512');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      sha256.update(buf.subarray(0, n));
      sha512.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return { size: st.size, sha256: sha256.digest('hex'), sha512: sha512.digest('base64') };
}

function validEntry(f) {
  return f && typeof f === 'object' && !Array.isArray(f)
    && Object.keys(f).every((k) => FILE_KEYS.has(k))
    && typeof f.url === 'string' && f.url.length > 0
    && typeof f.sha512 === 'string' && SHA512_B64.test(f.sha512)
    && Number.isSafeInteger(f.size) && f.size > 0
    && (f.blockMapSize === undefined || (Number.isSafeInteger(f.blockMapSize) && f.blockMapSize > 0));
}

// Throws unless the feed describes exactly this version's two ZIPs and two DMGs with the given bytes.
// `ids` maps each artifact name to its { size, sha512 }. A finalized feed must not advertise a DMG
// blockmap: stapling changed the DMG, so the blockmap built before it is stale.
function inspectFeed(text, { version, channel, ids, finalized = false }) {
  const names = artifactNames(version, channel);
  let doc;
  try { doc = yaml().load(text); } catch (e) { throw new Error(`feed is not valid YAML: ${e.message}`); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('feed is not a mapping');
  for (const key of Object.keys(doc)) if (!FEED_KEYS.has(key)) throw new Error(`feed has an unexpected key: ${key}`);
  if (String(doc.version) !== version) throw new Error(`feed version ${doc.version} is not ${version}`);
  if (!Array.isArray(doc.files)) throw new Error('feed files is not a list');
  const expected = [...names.zips, ...names.dmgs];
  const seen = new Set();
  for (const f of doc.files) {
    if (!validEntry(f)) throw new Error('feed has a malformed files entry');
    if (seen.has(f.url)) throw new Error(`feed lists ${f.url} twice`);
    if (!expected.includes(f.url)) throw new Error(`feed lists a foreign file: ${f.url}`);
    seen.add(f.url);
    const id = ids[f.url];
    if (!id) throw new Error(`no bytes to check for ${f.url}`);
    if (f.sha512 !== id.sha512 || f.size !== id.size) throw new Error(`feed entry for ${f.url} does not match its bytes`);
    if (finalized && names.dmgs.includes(f.url) && f.blockMapSize !== undefined) {
      throw new Error(`feed still advertises the pre-staple blockmap of ${f.url}`);
    }
  }
  for (const name of expected) if (!seen.has(name)) throw new Error(`feed does not list ${name}`);
  if (!names.zips.includes(doc.path)) throw new Error(`feed path ${doc.path} is not one of the ZIPs`);
  if (doc.sha512 !== ids[doc.path].sha512) throw new Error('feed top-level sha512 does not match its path');
  return doc;
}

// The same serialization electron-builder uses for its feed.
function dumpFeed(doc) {
  return yaml().dump(doc, { lineWidth: 8000, skipInvalid: false, noRefs: true });
}

// Reads the feed and every artifact it must describe from `dir`, and checks them together.
function checkFeedDir(dir, { version, channel, finalized = false }) {
  const names = artifactNames(version, channel);
  const ids = {};
  for (const name of [...names.zips, ...names.dmgs]) ids[name] = fileIdentity(path.join(dir, name));
  const text = fs.readFileSync(path.join(dir, names.feed), 'utf8');
  inspectFeed(text, { version, channel, ids, finalized });
  return { names, ids };
}

function checkAppUpdate(text, channel) {
  const want = APP_UPDATE[channel];
  if (!want) throw new Error(`unknown channel: ${channel}`);
  const doc = yaml().load(text);
  if (!doc || typeof doc !== 'object') throw new Error('app-update.yml is not a mapping');
  const keys = Object.keys(doc).sort();
  if (keys.join(',') !== Object.keys(want).sort().join(',')) throw new Error(`app-update.yml keys are ${keys.join(', ')}`);
  for (const [k, v] of Object.entries(want)) {
    if (doc[k] !== v) throw new Error(`app-update.yml ${k} is ${doc[k]}, expected ${v}`);
  }
}

// ---- the apps inside the ZIPs -------------------------------------------------------------------------
// The ZIPs are what updating apps download, so their contents are checked directly, never a loose .app.

const MACHO_CPU = Object.freeze({ 0x0100000c: 'arm64', 0x01000007: 'x64' });
const ARCH_NAMES = Object.freeze({ arm64: 'arm64', aarch64: 'arm64', x64: 'x64', x86_64: 'x64' });

// Reads one file from an asar archive: a size pickle, a header pickle with the JSON index, then data.
function asarFile(archive, name) {
  const buf = fs.readFileSync(archive);
  const headerSize = buf.readUInt32LE(4);
  const jsonSize = buf.readUInt32LE(12);
  const index = JSON.parse(buf.toString('utf8', 16, 16 + jsonSize));
  const entry = index.files && index.files[name];
  if (!entry || entry.offset === undefined) throw new Error(`${path.basename(archive)} has no ${name}`);
  const start = 8 + headerSize + Number(entry.offset);
  return buf.subarray(start, start + entry.size).toString('utf8');
}

function machoArch(file) {
  const head = Buffer.alloc(8);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, head, 0, 8, 0); } finally { fs.closeSync(fd); }
  if (head.readUInt32LE(0) !== 0xfeedfacf) throw new Error(`${path.basename(file)} is not a single-architecture 64-bit Mach-O executable`);
  const arch = MACHO_CPU[head.readUInt32LE(4)];
  if (!arch) throw new Error(`${path.basename(file)} has an unexpected CPU type`);
  return arch;
}

// Checks the app inside `zip`: one top-level app with the channel's name, bundle ID and version, an
// executable for `arch`, the channel's update settings, and build-info.json naming this version,
// channel and source commit.
function inspectZipApp(zip, { version, channel, source, arch }) {
  const product = PRODUCT_NAMES[channel];
  const listed = execFileSync('/usr/bin/unzip', ['-Z1', zip], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').filter(Boolean).filter((n) => !n.startsWith('__MACOSX/'));
  const tops = [...new Set(listed.map((n) => n.split('/')[0]))];
  if (tops.length !== 1 || tops[0] !== `${product}.app`) throw new Error(`${path.basename(zip)} holds ${tops.join(', ')}, not ${product}.app`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zip-'));
  try {
    const contents = `${product}.app/Contents`;
    const extract = (...members) => execFileSync('/usr/bin/unzip', ['-qq', '-o', zip, ...members, '-d', tmp]);
    extract(`${contents}/Info.plist`, `${contents}/Resources/app.asar`, `${contents}/Resources/app-update.yml`);
    const local = (rel) => path.join(tmp, contents, rel);
    const info = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', local('Info.plist')], { encoding: 'utf8' }));
    const name = path.basename(zip);
    if (info.CFBundleIdentifier !== BUNDLE_IDS[channel]) throw new Error(`${name}: bundle ID ${info.CFBundleIdentifier}, expected ${BUNDLE_IDS[channel]}`);
    if (info.CFBundleShortVersionString !== version) throw new Error(`${name}: version ${info.CFBundleShortVersionString}, expected ${version}`);
    extract(`${contents}/MacOS/${info.CFBundleExecutable}`);
    const machine = machoArch(local(`MacOS/${info.CFBundleExecutable}`));
    if (machine !== arch) throw new Error(`${name}: executable is ${machine}, expected ${arch}`);
    checkAppUpdate(fs.readFileSync(local('Resources/app-update.yml'), 'utf8'), channel);
    const build = JSON.parse(asarFile(local('Resources/app.asar'), 'build-info.json'));
    if (build.version !== version || build.channel !== channel) throw new Error(`${name}: build-info is ${build.channel} ${build.version}`);
    if (build.commit !== source) throw new Error(`${name}: built from ${build.commit}, not ${source}`);
    if (build.arch !== undefined && ARCH_NAMES[build.arch] !== arch) throw new Error(`${name}: build-info declares ${build.arch}`);
    return { name, product, bundleId: info.CFBundleIdentifier, version, arch: machine, commit: build.commit };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function inspectZips(dir, { version, channel, source }) {
  const names = artifactNames(version, channel);
  return names.zips.map((zip, i) => inspectZipApp(path.join(dir, zip), { version, channel, source, arch: ARCHES[i] }));
}

// ---- the one build published by hand -----------------------------------------------------------------
// 1.0.34 was built locally before the release workflow existed. Its original artifacts are pinned here;
// finalization may change only the DMGs (and the feed's DMG entries).
const BOOTSTRAP_BUILD = Object.freeze({
  version: '1.0.34',
  source: '4283e7411263aca1fb32342bff48df1dc1c22392',
  original: Object.freeze({
    'repo-radar-1.0.34-arm64-mac.zip': 'f622dd42b8e7f51615f0dcd82d1f2406b95b41d9983bee8568d5ba3bdcb36266',
    'repo-radar-1.0.34-x64-mac.zip': '5b5edbbaa3a02de585d3cc41230477adb9e9a1b4722c4c902434cad95be89a29',
    'repo-radar-1.0.34-arm64-mac.dmg': '6161e41f314c9937453dcf21ddf6b7ba54d7468d902573763366a697543aad3a',
    'repo-radar-1.0.34-x64-mac.dmg': '8ba1561da577db939b8cc01ba9a74f7ea25edd875047628d82022274c741f697',
    'latest-mac.yml': '953180e64dec2d6bcbdc2244174d5e09911daa4f288fdcfe9e5158d8c5a71e6b',
    'repo-radar-1.0.34-arm64-mac.zip.blockmap': '36f44ebdeb3998f8eb0ea4707d96b071b9cb8b21c8a257eee7bc8fdc137a6f90',
    'repo-radar-1.0.34-x64-mac.zip.blockmap': 'ec33125eeb070ccdfc89cf005d38a09cf786392d4a905837b9dcc2492eca9621',
  }),
});

// For a pinned build: the source must be the pinned one and each named file its original bytes.
function checkPinned(dir, pin, source, names) {
  if (source !== pin.source) throw new Error(`${pin.version} was built from ${pin.source}, not ${source}`);
  for (const n of names) {
    if (!pin.original[n]) throw new Error(`${n} is not part of the pinned ${pin.version} build`);
    if (fileIdentity(path.join(dir, n)).sha256 !== pin.original[n]) throw new Error(`${n} is not the original ${pin.version} file`);
  }
}

function main(argv) {
  const [command, ...rest] = argv;
  const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  if (command === 'check-feed') {
    const version = opt('--version');
    const channel = opt('--channel');
    const { names } = checkFeedDir(opt('--dir'), { version, channel, finalized: rest.includes('--finalized') });
    console.log(`feed OK: ${names.feed} describes ${names.zips.length} ZIPs and ${names.dmgs.length} DMGs for ${version}`);
    return 0;
  }
  if (command === 'check-app-update') {
    const [app, channel] = rest;
    checkAppUpdate(fs.readFileSync(path.join(app, 'Contents', 'Resources', 'app-update.yml'), 'utf8'), channel);
    console.log(`app-update.yml OK: ${path.basename(app)} checks ${FEED_OWNER}/${FEED_REPO} (${channel})`);
    return 0;
  }
  console.error('usage: release-artifacts.js check-feed --dir <dist> --version <v> --channel stable|dev [--finalized]');
  console.error('       release-artifacts.js check-app-update <app> stable|dev');
  return 2;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`release artifact check failed: ${e.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  TEAM_ID, SIGNING_IDENTITY, NOTARY_PROFILE, FEED_OWNER, FEED_REPO, ARCHES, STABLE_VERSION, DEV_VERSION, BUNDLE_IDS, PRODUCT_NAMES, APP_UPDATE,
  channelOf, feedName, artifactNames, identity, fileIdentity, inspectFeed, dumpFeed, checkFeedDir, checkAppUpdate,
  inspectZipApp, inspectZips, checkPinned, BOOTSTRAP_BUILD,
};
