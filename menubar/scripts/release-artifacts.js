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
const path = require('path');
const crypto = require('crypto');

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
};
