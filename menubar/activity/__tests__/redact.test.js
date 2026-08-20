'use strict';
// Node mirror of repo_radar/tests/test_activity_redact.py. Reuses the SAME shared fixture file
// (repo_radar/tests/data/redaction_fixtures.json) for cross-language parity: every case there
// covers one credential FORM (Bearer/Basic, github_pat_, gh[pousr]_, sk-(ant-)?, AIza, a
// //user:pass@ URL) or the configured-secret substitution, and must mask identically whether
// scrubbed by Python's redact.py or this file's redact.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Redactor } = require('../redact');

const FIXTURES_PATH = path.join(__dirname, '..', '..', '..', 'repo_radar', 'tests', 'data', 'redaction_fixtures.json');

test('shared fixtures mask as expected (cross-language parity with redact.py)', () => {
  const cases = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8'));
  assert.ok(cases.length >= 8, 'sanity: the shared fixture file should have its full case list');
  for (const c of cases) {
    const r = new Redactor(c.secrets);
    assert.strictEqual(r.scrub(c.raw), c.expected, c.raw);
  }
});

test('each credential form individually, addressed by name (mirrors the fixture list explicitly)', () => {
  const r = new Redactor([]);
  assert.strictEqual(r.scrub('Authorization: Bearer sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA'),
    'Authorization: [REDACTED authorization]');
  assert.strictEqual(r.scrub('Authorization: BASIC dXNlcjpwYXNzd29yZDEyMzQ1Njc4'),
    'Authorization: [REDACTED authorization]', 'case-insensitive scheme name');
  assert.strictEqual(r.scrub('token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'),
    'token [REDACTED github token]');
  assert.strictEqual(r.scrub('token github_pat_11ABCDE0000abcdefghij_KLMNOPQRSTUVWXYZ0123456789'),
    'token [REDACTED github token]');
  assert.strictEqual(r.scrub('key sk-proj-ABCDEFGHIJKLMNOPQRSTUV'), 'key [REDACTED api key]');
  assert.strictEqual(r.scrub('gemini AIzaSyA0000000000000000000000000000000'),
    'gemini [REDACTED google key]');
  assert.strictEqual(r.scrub('clone https://user:s3cr3t@github.com/x/y.git'),
    'clone https://<redacted>@github.com/x/y.git');
});

test('a configured non-pattern secret is masked verbatim, even though it matches no credential form', () => {
  const r = new Redactor(['hunter2-configured-token-value']);
  assert.strictEqual(r.scrub('debug password=hunter2-configured-token-value end'),
    'debug password=[REDACTED] end');
});

test('overlapping configured secrets mask fully, longest-first (a shorter secret cannot strand a longer one\'s tail)', () => {
  const r = new Redactor(['abc', 'abcdef123456']);
  const out = r.scrub('val=abcdef123456');
  assert.ok(!out.includes('abcdef123456'), out);
  assert.strictEqual(out, 'val=[REDACTED]');
});

test('scrub(null) returns null unchanged', () => {
  const r = new Redactor([]);
  assert.strictEqual(r.scrub(null), null);
});

test('scrub(undefined) returns undefined unchanged (defensive; no direct Python analog)', () => {
  const r = new Redactor([]);
  assert.strictEqual(r.scrub(undefined), undefined);
});

test('non-string input is coerced to text before scrubbing', () => {
  const r = new Redactor(['42']);
  assert.strictEqual(r.scrub(42), '[REDACTED]');
});

test('falsy configured-secret entries (empty string, null, undefined) are filtered out, not masked as literal text', () => {
  const r = new Redactor(['', null, undefined, 'realsecret']);
  const out = r.scrub('keep this text but drop realsecret');
  assert.strictEqual(out, 'keep this text but drop [REDACTED]');
});
