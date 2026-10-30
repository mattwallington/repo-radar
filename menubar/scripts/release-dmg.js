#!/usr/bin/env node
'use strict';
// Final disk-image processing before publication. electron-builder 24 notarizes and staples the apps,
// but it neither signs nor notarizes the DMGs. For each of the version's two DMGs this runs, in order:
//
//   codesign --sign (Reperio Developer ID, secure timestamp) → codesign --verify --strict →
//   codesign --display (leaf authority, team, timestamp) → notarytool submit --keychain-profile
//   reperio-notary --wait (status Accepted) → stapler staple → stapler validate →
//   spctl --assess --type open --context context:primary-signature
//
// Stapling changes the DMG bytes, so afterwards it rewrites only the feed's DMG entries (size and
// sha512, dropping any blockMapSize) and deletes the DMG blockmaps, which describe the pre-staple bytes.
// The ZIPs, their blockmaps and the feed's ZIP entries must not change. Any failed, unexpected or
// timed-out step stops everything: no retry, and a timed-out notary submission is never re-sent.
//
//   node menubar/scripts/release-dmg.js --dir <dist> --version <x.y.z or x.y.z-dev.N>
//
// The directory needs both ZIPs, both DMGs and the channel's feed, exactly as build-local.sh left them.
// Signing uses whichever keychain holds the Reperio identity and the reperio-notary profile: the login
// keychain locally, the disposable release keychain in CI.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const {
  SIGNING_IDENTITY, TEAM_ID, NOTARY_PROFILE, channelOf, artifactNames, fileIdentity, inspectFeed, dumpFeed,
} = require('./release-artifacts');

const BOUNDS = Object.freeze({ toolMs: 120_000, notaryMs: 1_800_000, outputBytes: 256 * 1024 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Apple tools see only these; no credential variable reaches them (notarytool gets the profile by name).
const CHILD_ENV_KEYS = Object.freeze(['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG']);
const CHILD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

class Hold extends Error {}

function commandPlan(dmg) {
  return [
    { step: 'sign', timeoutMs: BOUNDS.toolMs, argv: ['/usr/bin/codesign', '--sign', SIGNING_IDENTITY, '--timestamp', dmg] },
    { step: 'verify', timeoutMs: BOUNDS.toolMs, argv: ['/usr/bin/codesign', '--verify', '--strict', '--verbose=2', dmg] },
    { step: 'display', timeoutMs: BOUNDS.toolMs, argv: ['/usr/bin/codesign', '--display', '--verbose=2', dmg] },
    {
      step: 'notarize',
      timeoutMs: BOUNDS.notaryMs,
      argv: ['/usr/bin/xcrun', 'notarytool', 'submit', dmg, '--keychain-profile', NOTARY_PROFILE, '--wait', '--output-format', 'json'],
    },
    { step: 'staple', timeoutMs: BOUNDS.toolMs, argv: ['/usr/bin/xcrun', 'stapler', 'staple', dmg] },
    { step: 'validate', timeoutMs: BOUNDS.toolMs, argv: ['/usr/bin/xcrun', 'stapler', 'validate', dmg] },
    {
      step: 'assess',
      timeoutMs: BOUNDS.toolMs,
      argv: ['/usr/sbin/spctl', '--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', dmg],
    },
  ];
}

// Resolves once the child has exited; a timed-out or over-talkative child is killed.
function runBounded(argv, { timeoutMs, env }) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let bytes = 0;
    let timedOut = false;
    let truncated = false;
    let error = null;
    const take = (sink) => (chunk) => {
      if (truncated) return;
      if (bytes + chunk.length > BOUNDS.outputBytes) { truncated = true; child.kill('SIGKILL'); return; }
      bytes += chunk.length;
      sink.push(chunk);
    };
    child.stdout.on('data', take(out));
    child.stderr.on('data', take(err));
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', (e) => { error = e.message; });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({
        status: error === null ? status : null,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
        truncated,
        error,
      });
    });
  });
}

function childEnv(source) {
  const env = { PATH: CHILD_PATH };
  for (const key of CHILD_ENV_KEYS) if (source[key]) env[key] = source[key];
  return env;
}

function requireClean(step, r) {
  if (r.timedOut) throw new Hold(`${step} timed out`);
  if (r.truncated) throw new Hold(`${step} printed more than ${BOUNDS.outputBytes} bytes`);
  if (r.error) throw new Hold(`${step} could not run: ${r.error}`);
  if (r.status !== 0) throw new Hold(`${step} exited ${r.status}`);
}

function requireDisplay(r) {
  const lines = `${r.stdout}\n${r.stderr}`.split('\n').map((l) => l.trim());
  const authorities = lines.filter((l) => l.startsWith('Authority=')).map((l) => l.slice('Authority='.length));
  const teams = lines.filter((l) => l.startsWith('TeamIdentifier=')).map((l) => l.slice('TeamIdentifier='.length));
  if (authorities[0] !== SIGNING_IDENTITY) throw new Hold('DMG is not signed by the Reperio Developer ID');
  if (teams.length !== 1 || teams[0] !== TEAM_ID) throw new Hold(`DMG team is not ${TEAM_ID}`);
  if (!lines.some((l) => /^Timestamp=\S/.test(l))) throw new Hold('DMG signature has no secure timestamp');
}

function notaryResult(r) {
  if (r.timedOut || r.truncated) {
    throw new Hold('notarytool did not finish: the submission is held, never re-sent; check it with notarytool history');
  }
  if (r.error) throw new Hold(`notarytool could not run: ${r.error}`);
  let parsed;
  try { parsed = JSON.parse(r.stdout.trim()); } catch { throw new Hold('notarytool result is not JSON'); }
  const id = parsed && typeof parsed.id === 'string' && UUID.test(parsed.id) ? parsed.id : null;
  if (!id) throw new Hold('notarytool result has no submission id');
  if (parsed.status !== 'Accepted') throw new Hold(`notary submission ${id} is ${JSON.stringify(parsed.status ?? null)}, not Accepted`);
  if (r.status !== 0) throw new Hold(`notarytool exited ${r.status} for submission ${id}`);
  return id;
}

function requireAssessed(r) {
  const text = `${r.stdout}\n${r.stderr}`;
  if (!/: accepted$/m.test(text)) throw new Hold('Gatekeeper did not accept the DMG');
  if (!/^source=Notarized Developer ID$/m.test(text)) throw new Hold('Gatekeeper source is not Notarized Developer ID');
  // Gatekeeper may omit origin for a notarized DMG; if it reports one, it must be exactly ours.
  const origins = text.split('\n').filter((l) => l.startsWith('origin='));
  if (origins.length > 0 && (origins.length !== 1 || origins[0] !== `origin=${SIGNING_IDENTITY}`)) {
    throw new Hold('Gatekeeper origin is not the Reperio Developer ID');
  }
}

function writeAtomically(file, text) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, text, { flag: 'wx' });
  fs.renameSync(tmp, file);
}

async function finalize({ dir, version, env = process.env, run = runBounded, log = () => {} }) {
  const channel = channelOf(version);
  if (!channel) throw new Hold(`not a release version: ${version}`);
  const names = artifactNames(version, channel);
  const feedPath = path.join(dir, names.feed);
  const ids = {};
  for (const name of [...names.zips, ...names.dmgs]) {
    if (!fs.existsSync(path.join(dir, name))) throw new Hold(`missing ${name} in ${dir}`);
    ids[name] = fileIdentity(path.join(dir, name));
  }
  if (!fs.existsSync(feedPath)) throw new Hold(`missing ${names.feed} in ${dir}`);
  const feedText = fs.readFileSync(feedPath, 'utf8');
  // The feed must describe the builder's bytes; a DMG that was already signed or changed is refused.
  let doc;
  try { doc = inspectFeed(feedText, { version, channel, ids }); } catch (e) { throw new Hold(`before finalizing: ${e.message}`); }
  const zipBlockmaps = names.zipBlockmaps.filter((n) => fs.existsSync(path.join(dir, n)));
  const zipBlockmapIds = Object.fromEntries(zipBlockmaps.map((n) => [n, fileIdentity(path.join(dir, n)).sha256]));

  const childEnvironment = childEnv(env);
  const submissions = {};
  for (const dmg of names.dmgs) {
    for (const cmd of commandPlan(path.join(dir, dmg))) {
      log(`${dmg}: ${cmd.step}`);
      const r = await run(cmd.argv, { timeoutMs: cmd.timeoutMs, env: childEnvironment });
      try {
        if (cmd.step === 'notarize') {
          submissions[dmg] = notaryResult(r);
          continue;
        }
        requireClean(cmd.step, r);
        if (cmd.step === 'display') requireDisplay(r);
        if (cmd.step === 'assess') requireAssessed(r);
      } catch (e) {
        log(`${dmg}: ${cmd.step} output:\n${r.stdout}${r.stderr}`.trimEnd());
        throw new Hold(`${dmg}: ${e.message}`);
      }
    }
  }

  // Everything else must be byte-for-byte what the builder made.
  for (const zip of names.zips) {
    if (fileIdentity(path.join(dir, zip)).sha256 !== ids[zip].sha256) throw new Hold(`${zip} changed during finalization`);
  }
  for (const n of zipBlockmaps) {
    if (fileIdentity(path.join(dir, n)).sha256 !== zipBlockmapIds[n]) throw new Hold(`${n} changed during finalization`);
  }
  if (fs.readFileSync(feedPath, 'utf8') !== feedText) throw new Hold(`${names.feed} changed during finalization`);

  const finalIds = { ...ids };
  for (const dmg of names.dmgs) finalIds[dmg] = fileIdentity(path.join(dir, dmg));
  for (const entry of doc.files) {
    if (!names.dmgs.includes(entry.url)) continue;
    entry.sha512 = finalIds[entry.url].sha512;
    entry.size = finalIds[entry.url].size;
    delete entry.blockMapSize;
  }
  const text = dumpFeed(doc);
  inspectFeed(text, { version, channel, ids: finalIds, finalized: true });
  writeAtomically(feedPath, text);
  for (const n of names.dmgBlockmaps) fs.rmSync(path.join(dir, n), { force: true });

  return {
    version,
    channel,
    feed: names.feed,
    dmgs: names.dmgs.map((n) => ({ name: n, size: finalIds[n].size, sha256: finalIds[n].sha256, submission: submissions[n] })),
  };
}

function parseArgv(argv) {
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const dir = opt('--dir');
  const version = opt('--version');
  if (argv.length !== 4 || !dir || !version) throw new Hold('usage: release-dmg.js --dir <dist> --version <version>');
  return { dir: path.resolve(dir), version };
}

async function main(argv) {
  try {
    const result = await finalize({ ...parseArgv(argv), log: (l) => process.stderr.write(`${l}\n`) });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`DMG finalization stopped: ${e.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { Hold, commandPlan, finalize, notaryResult, requireAssessed, requireDisplay };
