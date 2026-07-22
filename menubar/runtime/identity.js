'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { probe } = require('./interpreter');

class IdentityError extends Error {}

function authoritativeIdentity({ appVersion, bundledVersionPath }) {
  if (!appVersion || appVersion === '2.0.0') {
    throw new IdentityError(`unsafe app version: ${appVersion}`);
  }
  let bundled;
  try {
    bundled = fs.readFileSync(bundledVersionPath, 'utf8').trim();
  } catch (e) {
    throw new IdentityError(`bundled VERSION unreadable: ${e.message}`);
  }
  if (bundled !== appVersion) {
    throw new IdentityError(`VERSION mismatch app=${appVersion} bundled=${bundled}`);
  }
  return { version: appVersion };
}

function interpreterFingerprint(exe) {
  const i = probe(exe);
  if (!i) throw new IdentityError(`cannot probe ${exe}`);
  return `${i.impl}-${i.version.join('.')}-${i.arch}`;
}

const generationId = (v, fp, n) => `${v}-${fp}-${n}`;
const newNonce = () => crypto.randomBytes(6).toString('hex');

module.exports = { IdentityError, authoritativeIdentity, interpreterFingerprint, generationId, newNonce };
