'use strict';
// Codex Round 12 (Node half).
//
// Ruling 73 (BLOCKER, raised against Python but the same gap existed here): `_measureForeign`
// opened the foreign directory by path and only compared `fstat(fd)` with the POST-scan lstat --
// it never checked that what it opened was what the root enumeration lstat'd. A persistent
// replacement (`junk/` -> `junk.old/`, fresh empty `junk/`) landing between the root lstat and the
// open measured the empty replacement as a CERTAIN 0 bytes and admission proceeded with 64 MiB
// hidden under `junk.old/`. Now the opened fd's `(dev, ino)` must match the enumeration's `st`
// (mismatch -> uncertain, no scan), and the post-scan lstat must still match (mismatch -> uncertain,
// partial bytes kept) -- identical to Python's `paths._measure_foreign_entry`.
//
// Ruling 74: ANY uncertain foreign entry floors the charge at CEILING (was `max(bytes,
// PER_ACTIVITY_CAP)` -- a foreign entry is unmanaged and never capped at 4 MiB, so that term could
// understate what it hides). Certain foreign entries are unchanged. Pinned by the `-ruling-74`
// vectors in `accounting_vectors.json`.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../index');
const paths = require('../paths');
const { quota } = A;

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-r12-node-'));
}
const rootOf = (home) => path.dirname(A.quotaDir(home));
const MIB = 1024 * 1024;

function seedJunk(root, name, nbytes) {
  const d = path.join(root, name);
  fs.mkdirSync(d, { mode: 0o700 });
  const f = path.join(d, 'python-deadbeef.jsonl');
  fs.writeFileSync(f, '', { mode: 0o600 });
  fs.truncateSync(f, nbytes);
  return d;
}

// Persistent replacement (in scope per spec §7): the original survives under `<name>.old`.
function swapDir(root, name) {
  fs.renameSync(path.join(root, name), path.join(root, `${name}.old`));
  fs.mkdirSync(path.join(root, name), { mode: 0o700 });
}

function newLiveActivity(home) {
  const aid = A.mintActivityId();
  A.secureMkdir(A.activityDir(home, aid));
  const l = A.acquire(A.ownerLockPath(home, aid));
  return [aid, l];
}

function withNoPython(fn) {
  const orig = quota.PYTHON_BIN;
  quota.PYTHON_BIN = '/nonexistent/python3-r12-test';
  try { return fn(); } finally { quota.PYTHON_BIN = orig; }
}

// Stub `fs.openSync` so the FIRST O_DIRECTORY open of `<root>/<name>` lands `swap` right before
// the real open -- i.e. between the root enumeration's lstat and `_measureForeign`'s open.
function withSwapBeforeOpen(root, name, fn) {
  const target = path.join(root, name);
  const real = fs.openSync;
  let fired = 0;
  fs.openSync = function (p, flags, ...rest) {
    if (p === target && typeof flags === 'number' && (flags & fs.constants.O_DIRECTORY) && fired === 0) {
      fired += 1;
      swapDir(root, name);
    }
    return real.call(fs, p, flags, ...rest);
  };
  try { return [fn(), fired]; } finally { fs.openSync = real; }
}

test('Ruling 73 (Codex sequence, Node): junk/ swapped for an empty junk/ between the root lstat and the foreign open -> entry uncertain, snapshot floors at CEILING, admit refused, 64 MiB still under junk.old/', () => {
  const home = tmpHome();
  try {
    A.secureMkdir(A.quotaDir(home));
    const root = rootOf(home);
    seedJunk(root, 'junk', 64 * MIB);

    const [listed, fired] = withSwapBeforeOpen(root, 'junk', () => paths.listOwnedSubdirsDetailed(root));
    assert.strictEqual(fired, 1, 'the swap must have landed inside the foreign open');
    assert.deepStrictEqual(listed.foreign.find((f) => f.name === 'junk'), { name: 'junk', bytes: 0, uncertain: true }, 'BUG (pre-fix): { bytes: 0, uncertain: false } -- the empty replacement measured as certain');
    assert.strictEqual(fs.statSync(path.join(root, 'junk.old', 'python-deadbeef.jsonl')).size, 64 * MIB);

    // reset and run the same sequence through the real admission path
    fs.rmSync(path.join(root, 'junk'), { recursive: true, force: true });
    fs.renameSync(path.join(root, 'junk.old'), path.join(root, 'junk'));
    const [live, lease] = newLiveActivity(home);
    try {
      const [admitted, fired2] = withSwapBeforeOpen(root, 'junk', () => withNoPython(() => quota.admit(home, live, lease)));
      assert.strictEqual(fired2, 1);
      assert.strictEqual(admitted, false, 'BUG (pre-fix): admitted on a certain 0-byte view of the replacement');
      assert.ok(!fs.existsSync(path.join(A.quotaDir(home), `${live}.json`)), 'no reservation written');
    } finally { lease.release(); }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Check (b) predates Round 12 (this pins it). Node lstat's the children BY PATH under the held
// fd (no fd-relative lstat), so once the name is re-pointed the originals read ENOENT and the
// kept partial is 0 -- Python, stat'ing relative to the fd, keeps 4321. Both are uncertain, and
// under Ruling 74 both floor at CEILING, so the accounting agrees.
test('Ruling 73 (Node): junk/ swapped AFTER the scan (stubbed readdirSync) -> uncertain (post-scan identity check)', () => {
  const home = tmpHome();
  try {
    A.secureMkdir(A.quotaDir(home));
    const root = rootOf(home);
    seedJunk(root, 'junk', 4321);
    const real = fs.readdirSync;
    let fired = 0;
    fs.readdirSync = function (p, ...rest) {
      const out = real.call(fs, p, ...rest);
      if (p === path.join(root, 'junk') && fired === 0) { fired += 1; swapDir(root, 'junk'); }
      return out;
    };
    let listed;
    try { listed = paths.listOwnedSubdirsDetailed(root); } finally { fs.readdirSync = real; }
    assert.strictEqual(fired, 1);
    assert.deepStrictEqual(listed.foreign.find((f) => f.name === 'junk'), { name: 'junk', bytes: 0, uncertain: true });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 73 (Node): an unswapped foreign directory is still measured certain', () => {
  const home = tmpHome();
  try {
    A.secureMkdir(A.quotaDir(home));
    const root = rootOf(home);
    seedJunk(root, 'junk', 4321);
    assert.deepStrictEqual(paths.listOwnedSubdirsDetailed(root).foreign.find((f) => f.name === 'junk'), { name: 'junk', bytes: 4321, uncertain: false });
    assert.deepStrictEqual(quota._accountingSnapshot(home), { charge: 4321, uncertain: false, corrupt: false });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 74: _computeSnapshot -- any uncertain foreign entry floors the charge at CEILING; bytes above it kept; certain foreign unchanged', () => {
  const C = { CEILING: quota.CEILING, PER_ACTIVITY_CAP: quota.PER_ACTIVITY_CAP, RESERVE: quota.RESERVE };
  const base = { rootListable: true, ledgerListable: true, activities: [], rejectedRootIds: [], ledger: [] };
  const aid = '00000000-0000-4000-8000-000000000001';
  assert.deepStrictEqual(quota._computeSnapshot({ ...base, foreign: [{ name: 'junk', onDisk: 10, uncertain: true }] }, C), { charge: quota.CEILING, uncertain: true, corrupt: false });
  assert.deepStrictEqual(quota._computeSnapshot({ ...base, foreign: [{ name: 'junk', onDisk: quota.CEILING + 7, uncertain: true }] }, C), { charge: quota.CEILING + 7, uncertain: true, corrupt: false });
  assert.deepStrictEqual(
    quota._computeSnapshot({ ...base, activities: [{ aid, onDisk: 2000, uncertain: false }], ledger: [{ aid, reserved: quota.RESERVE, granted: 0 }], foreign: [{ name: 'junk', onDisk: 1000, uncertain: true }] }, C),
    { charge: Math.max(quota.RESERVE + 1000, quota.CEILING), uncertain: true, corrupt: false },
  );
  assert.deepStrictEqual(quota._computeSnapshot({ ...base, foreign: [{ name: 'junk', onDisk: 1000, uncertain: false }, { name: 's.bin', onDisk: 5, uncertain: false }] }, C), { charge: 1005, uncertain: false, corrupt: false });
  // uncertain because onDisk is null (unmeasurable): same floor
  assert.deepStrictEqual(quota._computeSnapshot({ ...base, foreign: [{ name: 'junk', onDisk: null, uncertain: false }] }, C), { charge: quota.CEILING, uncertain: true, corrupt: false });
});

test('Ruling 74 (real tree): a stray symlink at the root charges exactly CEILING', () => {
  const home = tmpHome();
  try {
    A.secureMkdir(A.quotaDir(home));
    fs.symlinkSync(home, path.join(rootOf(home), 'also-junk'));
    assert.deepStrictEqual(quota._accountingSnapshot(home), { charge: quota.CEILING, uncertain: true, corrupt: false });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
