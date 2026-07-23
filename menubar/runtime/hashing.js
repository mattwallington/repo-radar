'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function hashFile(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function _walk(dir, base, out) {
  for (const name of fs.readdirSync(dir).sort()) {
    if (name === '__pycache__') continue;
    const abs = path.join(dir, name);
    const st = fs.lstatSync(abs);
    const rel = path.relative(base, abs);
    if (st.isDirectory()) {
      _walk(abs, base, out);
    } else if (st.isFile() && !name.endsWith('.pyc')) {
      out.push([rel, hashFile(abs)]);
    }
  }
  return out;
}

function hashTree(dir) {
  const entries = _walk(dir, dir, []).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const h = crypto.createHash('sha256');
  for (const [rel, fh] of entries) h.update(rel).update('\0').update(fh).update('\0');
  return h.digest('hex');
}

function redact(text) {
  return String(text).replace(/\/\/[^/@\s]+@/g, '//<redacted>@');
}

module.exports = { hashFile, hashTree, redact };
