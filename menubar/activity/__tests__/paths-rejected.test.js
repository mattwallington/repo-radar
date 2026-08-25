'use strict';
// Codex R1 finding B2 (paths half): paths.readOwnedSegments silently `continue`s past entries it
// refuses to read -- a symlink squatting on a segment name, a non-regular file (FIFO/dir/device),
// a permission-denied entry, or an entry gone/swapped mid-scan -- making a reader unable to tell
// "no data" apart from "data I refused to read" (Codex demonstrated this by replacing a valid
// `start` segment with a symlink, which made the activity look like a clean empty/running item).
//
// paths.readOwnedSegmentsDetailed(directory, suffix) surfaces exactly what was refused and why:
// { segments: [...], rejected: [{name, reason}] }. `segments` is EXACTLY what readOwnedSegments
// already returns (readOwnedSegments is now a thin `.segments`-only wrapper around this, single
// implementation, no duplication -- see paths.js). These tests cover the new rejection surface;
// paths.test.js's existing readOwnedSegments coverage is untouched and keeps passing unchanged.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const paths = require('../paths');

const VALID = '00000000-0000-4000-8000-000000000000';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-rejected-'));
}

test('readOwnedSegmentsDetailed: a valid segment is reported in segments, not rejected', () => {
  const home = tmpHome();
  try {
    const d = paths.activityDir(home, VALID);
    paths.secureMkdir(d);
    const seg = paths.segmentPath(home, VALID, 'python', 'deadbeef');
    fs.writeFileSync(seg, 'line1\n');

    const { segments, rejected } = paths.readOwnedSegmentsDetailed(d);
    assert.strictEqual(segments.length, 1);
    assert.strictEqual(segments[0].name, path.basename(seg));
    assert.strictEqual(segments[0].data.toString('utf8'), 'line1\n');
    assert.deepStrictEqual(rejected, []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('readOwnedSegmentsDetailed: a symlink squatting on a segment name is rejected, not silently absent', () => {
  const home = tmpHome();
  try {
    const d = paths.activityDir(home, VALID);
    paths.secureMkdir(d);
    const victim = path.join(home, 'victim.jsonl');
    fs.writeFileSync(victim, 'secret start-record\n');
    const seg = paths.segmentPath(home, VALID, 'python', 'deadbeef');
    fs.symlinkSync(victim, seg);

    const { segments, rejected } = paths.readOwnedSegmentsDetailed(d);
    assert.deepStrictEqual(segments, []); // NOT silently treated as "no data"
    assert.strictEqual(rejected.length, 1);
    assert.strictEqual(rejected[0].name, path.basename(seg));
    assert.strictEqual(rejected[0].reason, 'symlink');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('readOwnedSegmentsDetailed: a FIFO with the suffix is rejected as not-regular', () => {
  const home = tmpHome();
  try {
    const d = paths.activityDir(home, VALID);
    paths.secureMkdir(d);
    const fifoPath = path.join(d, 'python-deadbeef.jsonl');
    execFileSync('mkfifo', [fifoPath]);

    const { segments, rejected } = paths.readOwnedSegmentsDetailed(d);
    assert.deepStrictEqual(segments, []);
    assert.strictEqual(rejected.length, 1);
    assert.strictEqual(rejected[0].name, 'python-deadbeef.jsonl');
    assert.strictEqual(rejected[0].reason, 'not-regular');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('readOwnedSegmentsDetailed: a directory with the suffix is rejected as not-regular', () => {
  const home = tmpHome();
  try {
    const d = paths.activityDir(home, VALID);
    paths.secureMkdir(d);
    const dirPath = path.join(d, 'python-deadbeef.jsonl');
    fs.mkdirSync(dirPath);

    const { segments, rejected } = paths.readOwnedSegmentsDetailed(d);
    assert.deepStrictEqual(segments, []);
    assert.strictEqual(rejected.length, 1);
    assert.strictEqual(rejected[0].name, 'python-deadbeef.jsonl');
    assert.strictEqual(rejected[0].reason, 'not-regular');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('readOwnedSegmentsDetailed: a 0o000 file is rejected as denied', () => {
  const home = tmpHome();
  try {
    const d = paths.activityDir(home, VALID);
    paths.secureMkdir(d);
    const seg = paths.segmentPath(home, VALID, 'python', 'deadbeef');
    fs.writeFileSync(seg, 'line1\n');
    fs.chmodSync(seg, 0o000);
    try {
      const { segments, rejected } = paths.readOwnedSegmentsDetailed(d);
      assert.deepStrictEqual(segments, []);
      assert.strictEqual(rejected.length, 1);
      assert.strictEqual(rejected[0].name, path.basename(seg));
      assert.strictEqual(rejected[0].reason, 'denied');
    } finally {
      fs.chmodSync(seg, 0o600); // restore perms BEFORE cleanup (rmSync needs to be able to unlink it)
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('readOwnedSegmentsDetailed: an unreadable/never-created directory reports dir-unreadable, segments stays []', () => {
  const home = tmpHome();
  try {
    const d = paths.activityDir(home, VALID); // never created
    const { segments, rejected } = paths.readOwnedSegmentsDetailed(d);
    assert.deepStrictEqual(segments, []);
    assert.deepStrictEqual(rejected, [{ name: '', reason: 'dir-unreadable' }]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('readOwnedSegments (legacy wrapper) keeps returning only the valid segments, symlink rejection stays invisible to it', () => {
  const home = tmpHome();
  try {
    const d = paths.activityDir(home, VALID);
    paths.secureMkdir(d);
    const good = paths.segmentPath(home, VALID, 'python', 'deadbeef');
    fs.writeFileSync(good, 'ok\n');
    const victim = path.join(home, 'victim.jsonl');
    fs.writeFileSync(victim, 'secret\n');
    const bad = paths.segmentPath(home, VALID, 'dispatcher', 'cafebabe');
    fs.symlinkSync(victim, bad);

    const segs = paths.readOwnedSegments(d); // pre-existing signature/behavior, unchanged
    assert.strictEqual(segs.length, 1);
    assert.strictEqual(segs[0].name, path.basename(good));
    assert.strictEqual(segs[0].data.toString('utf8'), 'ok\n');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Codex R2 I / Ruling 39: the root-level counterpart. `listOwnedSubdirs` silently dropped a
// symlink/non-directory entry, so a valid-UUID symlink at the Activity root listed as clean empty
// history. `listOwnedSubdirsDetailed` reports activity-shaped refusals; junk names stay ignored.
const OTHER = '00000000-0000-4000-8000-000000000001';

test('listOwnedSubdirsDetailed: real activity dirs list; a valid-UUID symlink is rejected as symlink', () => {
  const home = tmpHome();
  try {
    paths.secureMkdir(paths.activityDir(home, VALID));
    const root = path.dirname(paths.quotaDir(home));
    const target = path.join(home, 'elsewhere');
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(root, OTHER));

    const { subdirs, rejected } = paths.listOwnedSubdirsDetailed(root);
    assert.deepStrictEqual(subdirs, [VALID]);
    assert.deepStrictEqual(rejected, [{ name: OTHER, reason: 'symlink' }]);
    assert.deepStrictEqual(paths.listOwnedSubdirs(root), [VALID]); // legacy wrapper: unchanged behavior
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('listOwnedSubdirsDetailed: a plain file on an activity id is not-directory; junk names are ignored', () => {
  const home = tmpHome();
  try {
    paths.secureMkdir(paths.activityDir(home, VALID));
    const root = path.dirname(paths.quotaDir(home));
    fs.writeFileSync(path.join(root, OTHER), '');
    fs.writeFileSync(path.join(root, 'quota.lock'), '');
    fs.symlinkSync(home, path.join(root, 'junk-link'));
    fs.mkdirSync(paths.quotaDir(home));

    const { subdirs, rejected } = paths.listOwnedSubdirsDetailed(root);
    assert.deepStrictEqual(subdirs.sort(), [VALID, 'quota']);
    assert.deepStrictEqual(rejected, [{ name: OTHER, reason: 'not-directory' }]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('listOwnedSubdirsDetailed: a missing base yields empty subdirs and no rejections', () => {
  const home = tmpHome();
  try {
    const root = path.dirname(paths.quotaDir(home)); // never created
    assert.deepStrictEqual(paths.listOwnedSubdirsDetailed(root), { subdirs: [], rejected: [] });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
