'use strict';
// Node mirror of the key scenarios in repo_radar/tests/test_activity_paths.py, adapted to the
// Node path-safety approach described in the Task 2.1 brief (component-walk + O_NOFOLLOW on the
// final op, since stock Node has no dir_fd/openat). Not explicitly required by the brief's file
// list, but paths.js implements safety-critical symlink-rejection logic that deserves direct
// coverage beyond what the golden harness (which only exercises records.js) provides.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const paths = require('../paths');

const VALID = '00000000-0000-4000-8000-000000000000';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-activity-'));
}

test('activityDir rejects a bad activity_id', () => {
  const home = tmpHome();
  assert.throws(() => paths.activityDir(home, '../escape'), paths.UnsafePath);
});

test('segmentPath rejects a bad producer and a bad writer_id', () => {
  const home = tmpHome();
  assert.throws(() => paths.segmentPath(home, VALID, 'hacker', 'deadbeef'), paths.UnsafePath);
  assert.throws(() => paths.segmentPath(home, VALID, 'python', 'BADWRITER'), paths.UnsafePath);
});

test('secureMkdir creates 0700 dirs and secureOpenAppend creates/appends a 0600 file', () => {
  const home = tmpHome();
  const d = paths.activityDir(home, VALID);
  paths.secureMkdir(d);
  assert.strictEqual(fs.lstatSync(d).mode & 0o777, 0o700);

  const seg = paths.segmentPath(home, VALID, 'python', 'deadbeef');
  let fd = paths.secureOpenAppend(seg);
  fs.writeSync(fd, Buffer.from('line1\n'));
  fs.closeSync(fd);
  fd = paths.secureOpenAppend(seg);
  fs.writeSync(fd, Buffer.from('line2\n'));
  fs.closeSync(fd);

  assert.strictEqual(fs.readFileSync(seg, 'utf8'), 'line1\nline2\n');
  assert.strictEqual(fs.lstatSync(seg).mode & 0o777, 0o600);
});

test('secureMkdir rejects a symlink at the final target', () => {
  const home = tmpHome();
  const victim = path.join(home, 'victim');
  fs.mkdirSync(victim);
  const link = paths.quotaDir(home); // reuse a fresh path as the symlink target
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(victim, link);
  assert.throws(() => paths.secureMkdir(link), paths.UnsafePath);
});

test('secureMkdir rejects a symlinked ANCESTOR of the owned subtree', () => {
  const home = tmpHome();
  const victim = path.join(home, 'victim');
  fs.mkdirSync(victim);
  const base = path.join(home, 'Library', 'Logs', 'repo-radar');
  fs.mkdirSync(path.dirname(base), { recursive: true });
  fs.symlinkSync(victim, base); // symlinked ANCESTOR of activity/
  assert.throws(() => paths.secureMkdir(path.join(base, 'activity', VALID)), paths.UnsafePath);
});

test('secureMkdir rejects an INTERMEDIATE symlinked owned component, not only the final one', () => {
  const home = tmpHome();
  const victim = path.join(home, 'victim');
  fs.mkdirSync(victim);
  const prefix = path.join(home, 'Library', 'Logs', 'repo-radar');
  fs.mkdirSync(prefix, { recursive: true });
  fs.symlinkSync(victim, path.join(prefix, 'activity')); // 'activity' itself is a symlink
  assert.throws(() => paths.secureMkdir(path.join(prefix, 'activity', VALID)), paths.UnsafePath);
});

test('secureOpenAppend rejects a symlinked target file (final component)', () => {
  const home = tmpHome();
  const d = paths.activityDir(home, VALID);
  paths.secureMkdir(d);
  const victim = path.join(home, 'victim.jsonl');
  fs.writeFileSync(victim, 'secret\n');
  const seg = paths.segmentPath(home, VALID, 'python', 'deadbeef');
  fs.symlinkSync(victim, seg);
  assert.throws(() => paths.secureOpenAppend(seg), paths.UnsafePath);
});

test('secureOpenAppend rejects a missing parent directory', () => {
  const home = tmpHome();
  const seg = paths.segmentPath(home, VALID, 'python', 'deadbeef'); // activity dir never created
  assert.throws(() => paths.secureOpenAppend(seg));
});

test('path constructors compose the expected layout', () => {
  const home = '/H';
  assert.strictEqual(paths.activityDir(home, VALID), path.join('/H', 'Library', 'Logs', 'repo-radar', 'activity', VALID));
  assert.strictEqual(paths.ownerLockPath(home, VALID), path.join(paths.activityDir(home, VALID), 'owner.lock'));
  assert.strictEqual(paths.quotaDir(home), path.join('/H', 'Library', 'Logs', 'repo-radar', 'activity', 'quota'));
  assert.strictEqual(paths.ledgerEntryPath(home, VALID), path.join(paths.quotaDir(home), `${VALID}.json`));
});
