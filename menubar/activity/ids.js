'use strict';
// Node mirror of repo_radar/activity/ids.py (Task 2.1). Regexes are copied verbatim from the
// Python source (anchored `^...$`, used with `.test()`) -- Python validates with `re.fullmatch`,
// which for these patterns is exactly equivalent to a JS `^...$` test (both reject a dangling
// trailing char, including a trailing newline; verified empirically against CPython).
const crypto = require('crypto');

const ACTIVITY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_RE = /^[0-9a-f]{8}$/;

function mintActivityId() {
  return crypto.randomUUID();
}

function validActivityId(s) {
  return typeof s === 'string' && ACTIVITY_ID_RE.test(s);
}

function mintToken() {
  return crypto.randomBytes(4).toString('hex');
}

function validToken(s) {
  return typeof s === 'string' && TOKEN_RE.test(s);
}

module.exports = { validActivityId, mintActivityId, mintToken, validToken };
