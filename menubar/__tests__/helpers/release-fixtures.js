'use strict';
// Test builds shaped like electron-builder's output: per architecture a real ZIP holding the app
// (Info.plist, a Mach-O executable header, app.asar with build-info.json, app-update.yml), a DMG and
// both blockmaps, plus the channel's feed in the builder's shape (no DMG blockMapSize).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { artifactNames, identity, dumpFeed, BUNDLE_IDS, PRODUCT_NAMES, APP_UPDATE, SIGNING_IDENTITY } = require('../../scripts/release-artifacts');

const CPU = { arm64: 0x0100000c, x64: 0x01000007 };

// The asar layout: a size pickle, a header pickle holding the JSON index, then file data.
function asar(files) {
  const index = { files: {} };
  const chunks = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    index.files[name] = { size: data.length, offset: String(offset) };
    chunks.push(data);
    offset += data.length;
  }
  const json = Buffer.from(JSON.stringify(index));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4);
  json.copy(padded);
  const header = Buffer.alloc(8 + padded.length);
  header.writeUInt32LE(4 + padded.length, 0);
  header.writeUInt32LE(json.length, 4);
  padded.copy(header, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(header.length, 4);
  return Buffer.concat([size, header, ...chunks]);
}

function plist(dict) {
  const body = Object.entries(dict).map(([k, v]) => `  <key>${k}</key>\n  <string>${v}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
}

function appZip(dir, zipName, { version, channel, source, arch, buildInfo = {} }) {
  const product = PRODUCT_NAMES[channel];
  const stage = fs.mkdtempSync(path.join(dir, '.app-'));
  const contents = path.join(stage, `${product}.app`, 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
  fs.writeFileSync(path.join(contents, 'Info.plist'), plist({
    CFBundleIdentifier: BUNDLE_IDS[channel], CFBundleShortVersionString: version, CFBundleExecutable: product, CFBundleName: product,
  }));
  const macho = Buffer.alloc(32);
  macho.writeUInt32LE(0xfeedfacf, 0);
  macho.writeUInt32LE(CPU[arch], 4);
  fs.writeFileSync(path.join(contents, 'MacOS', product), Buffer.concat([macho, crypto.randomBytes(64)]));
  fs.writeFileSync(path.join(contents, 'Resources', 'app.asar'), asar({
    'package.json': JSON.stringify({ name: 'repo-radar', version }),
    'build-info.json': JSON.stringify({ version, channel, commit: source, buildDate: '2026-10-30T00:00:00.000Z', ...buildInfo }),
  }));
  const update = APP_UPDATE[channel];
  fs.writeFileSync(path.join(contents, 'Resources', 'app-update.yml'),
    Object.entries(update).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n');
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', path.join(stage, `${product}.app`), path.join(dir, zipName)]);
  fs.rmSync(stage, { recursive: true, force: true });
}

// Writes a pre-finalization build into `dir`. `zipOverrides[arch]` changes what goes into one ZIP.
function makeBuild(dir, { version, channel, source, zipOverrides = {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const names = artifactNames(version, channel);
  names.zips.forEach((zip, i) => {
    const arch = i === 0 ? 'arm64' : 'x64';
    appZip(dir, zip, { version, channel, source, arch, ...(zipOverrides[arch] || {}) });
  });
  for (const name of [...names.dmgs, ...names.zipBlockmaps, ...names.dmgBlockmaps]) fs.writeFileSync(path.join(dir, name), crypto.randomBytes(512));
  writeFeed(dir, version, channel);
  return names;
}

function writeFeed(dir, version, channel) {
  const names = artifactNames(version, channel);
  const id = (n) => identity(fs.readFileSync(path.join(dir, n)));
  const files = [...names.zips, ...names.dmgs].map((url) => ({ url, sha512: id(url).sha512, size: id(url).size }));
  fs.writeFileSync(path.join(dir, names.feed),
    dumpFeed({ version, files, path: names.zips[0], sha512: id(names.zips[0]).sha512, releaseDate: '2026-10-30T00:00:00.000Z' }));
}

// Stands in for codesign, notarytool, stapler and spctl. Stapling appends to the DMG, as the real one
// does. `fail` names a step that fails; `notaryStatus` sets the notary verdict.
function appleTools({ notaryStatus = 'Accepted', fail = null } = {}) {
  const calls = [];
  const ok = (stdout = '', stderr = '') => ({ status: 0, stdout, stderr, timedOut: false, truncated: false, error: null });
  const run = async (argv, opts = {}) => {
    const dmg = argv[argv.length - 1];
    const step = argv[0] === '/usr/sbin/spctl' ? 'assess' : `${path.basename(argv[0])} ${argv[1]}${argv[1] === 'stapler' ? ` ${argv[2]}` : ''}`;
    calls.push({ step, argv, env: opts.env });
    if (fail && step === fail) return { ...ok('', 'failed'), status: 1 };
    if (argv[1] === '--display') {
      return ok('', `Authority=${SIGNING_IDENTITY}\nAuthority=Developer ID Certification Authority\nTimestamp=Oct 30, 2026\nTeamIdentifier=F8UY7565VM\n`);
    }
    if (argv[1] === 'notarytool') {
      return { ...ok(JSON.stringify({ id: crypto.randomUUID(), status: notaryStatus })), status: notaryStatus === 'Accepted' ? 0 : 1 };
    }
    if (argv[1] === 'stapler' && argv[2] === 'staple') fs.appendFileSync(dmg, 'ticket');
    if (step === 'assess') return ok('', `${dmg}: accepted\nsource=Notarized Developer ID\n`);
    return ok();
  };
  return { run, calls };
}

module.exports = { makeBuild, writeFeed, appZip, appleTools };
