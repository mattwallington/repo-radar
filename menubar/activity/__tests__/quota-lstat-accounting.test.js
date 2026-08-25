'use strict';
// Codex R3 B1 / Ruling 40: rejected segments must NOT vanish from the 64 MiB accounting.
// `paths.statOwnedSegments` used to open each entry O_RDONLY and silently `continue` on error,
// so a settled segment chmod 000 dropped straight out of `quota._charge` (1 MiB -> 0) while its
// bytes persisted on disk -- an undercount that let admissions proceed past the ceiling. Sizing is
// now lstat-based (no open): a denied regular file keeps its provable size; a `.jsonl`-named
// symlink (lstat reports the LINK itself) and any other non-regular entry are skipped.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../index');
const paths = require('../paths');
const { quota } = A;

const ONE_MIB = 1024 * 1024;

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-lstat-'));
}

// A SETTLED activity: segment bytes on disk, no ledger entry, no lock -- its only contribution to
// `_charge` is its on-disk size.
function seedSettled(home, aid, nbytes) {
  A.secureMkdir(A.activityDir(home, aid));
  const seg = A.segmentPath(home, aid, 'python', 'deadbeef');
  fs.writeFileSync(seg, Buffer.alloc(nbytes, 0x0a), { mode: 0o600 });
  return seg;
}

test('Ruling 40: a settled 1 MiB segment is charged in full, and STAYS charged after chmod 000', (t) => {
  if (process.getuid && process.getuid() === 0) {
    t.skip('running as root -- permission bits are not enforced');
    return;
  }
  const home = tmpHome();
  const aid = A.mintActivityId();
  let seg;
  try {
    seg = seedSettled(home, aid, ONE_MIB);
    assert.strictEqual(quota._charge(home), ONE_MIB);
    assert.deepStrictEqual(paths.statOwnedSegments(A.activityDir(home, aid)), [{ name: path.basename(seg), size: ONE_MIB }]);

    fs.chmodSync(seg, 0o000);
    // the READ path refuses it (Ruling 38 -- lifecycle stays uncertain) ...
    assert.deepStrictEqual(
      paths.readOwnedSegmentsDetailed(A.activityDir(home, aid)).rejected,
      [{ name: path.basename(seg), reason: 'denied' }],
    );
    // ... but the SIZE path still proves its bytes: nothing about the charge changed.
    assert.strictEqual(quota._charge(home), ONE_MIB);
    assert.strictEqual(quota._onDisk(home, aid), ONE_MIB);
    assert.strictEqual(quota._committed(home), ONE_MIB);
  } finally {
    if (seg) { try { fs.chmodSync(seg, 0o600); } catch (e) { /* best-effort */ } } // restore BEFORE rmSync
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 40: a `.jsonl`-named symlink is NOT counted (lstat reports the link, never its target)', () => {
  const home = tmpHome();
  const aid = A.mintActivityId();
  try {
    const seg = seedSettled(home, aid, ONE_MIB);
    const dir = A.activityDir(home, aid);
    // a symlink to a large file OUTSIDE the store, squatting on a conforming segment name
    const outside = path.join(home, 'outside.bin');
    fs.writeFileSync(outside, Buffer.alloc(3 * ONE_MIB, 0x0a));
    fs.symlinkSync(outside, path.join(dir, 'python-cafef00d.jsonl'));
    // and a symlink to the REAL segment (must not double-count it either)
    fs.symlinkSync(seg, path.join(dir, 'python-0badf00d.jsonl'));

    const sized = paths.statOwnedSegments(dir);
    assert.deepStrictEqual(sized, [{ name: path.basename(seg), size: ONE_MIB }]);
    assert.strictEqual(quota._charge(home), ONE_MIB);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 40: non-regular `.jsonl` entries (directory, FIFO) are skipped; return shape preserved', () => {
  const home = tmpHome();
  const aid = A.mintActivityId();
  try {
    const seg = seedSettled(home, aid, 4096);
    const dir = A.activityDir(home, aid);
    fs.mkdirSync(path.join(dir, 'python-d1d1d1d1.jsonl'));
    const { execFileSync } = require('node:child_process');
    execFileSync('mkfifo', [path.join(dir, 'python-f1f0f1f0.jsonl')]);
    assert.deepStrictEqual(paths.statOwnedSegments(dir), [{ name: path.basename(seg), size: 4096 }]);
    assert.strictEqual(quota._charge(home), 4096);
    // shape preserved for the callers that hook/consume it: [{ name, size }]
    for (const e of paths.statOwnedSegments(dir)) assert.deepStrictEqual(Object.keys(e).sort(), ['name', 'size']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
