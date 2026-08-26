'use strict';
// Codex review Round 8 (Node half): Rulings 64, 65, 66.
//   R8-1 (Ruling 64, BLOCKER): the lock-WAIT window was unbound. `_quotaLock` used to bind
//        `{dev, ino}` only AFTER `_lockfBlocking` returned -- so a `quota/` swap landing DURING
//        the wait was captured fresh, as if it had always been the real directory. Codex's
//        real-process repro: hold `quota.lock` in another process; swap the full `quota/` for an
//        empty directory while Node waits; `admit` returned true (canonical charge 61,440 vs
//        authorized liability 67,170,304). Fixed: `_quotaLock`/`_quotaLockNonblocking` capture
//        the identity of BOTH `quota/` and the activity root BEFORE opening/waiting on the lock,
//        re-capture both after acquisition, and fail the acquisition outright on any
//        ENOENT/symlink/mismatch. `_verifyCanonical(ctx)` is the one re-verification helper,
//        routed through before/after every ledger readdir, every `_writeEntry`, before any prune
//        delegation (admit's/settle's), and before/after `appendReserveIfLive`'s read+write.
//   R8-2 (Ruling 65): overlap parity with the Python-authored `accounting_vectors.json` --
//        `corrupt-plus-uncertain-activity` and `corrupt-plus-rejected-root` vectors, run via
//        accounting-parity.test.js (this file adds no vectors of its own; see that file).
//   R8-3 (Ruling 66, IMPORTANT): `_unlock` itself must never throw, and every remaining call site
//        (admit, grant, settle -- appendReserveIfLive already wrapped it) is wrapped too, so a
//        release/close failure can never replace an already-decided, already-persisted result.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../index');
const paths = require('../paths');
const { quota } = A;

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-r8-'));
}

function newLiveActivity(home) {
  const aid = A.mintActivityId();
  A.secureMkdir(A.activityDir(home, aid));
  const l = A.acquire(A.ownerLockPath(home, aid));
  return [aid, l];
}

function withNoPython(fn) {
  const orig = quota.PYTHON_BIN;
  quota.PYTHON_BIN = '/nonexistent/python3-r8-test';
  try { return fn(); } finally { quota.PYTHON_BIN = orig; }
}

// A fake "python" runner that RECORDS every invocation into a marker file and exits 0 without
// touching anything -- lets a test count prune delegations through the real `_spawnPythonPrune`
// -> configured-runner seam (mirrors codex-r7.test.js's identical helper).
function withCountingRunner(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-r8-runner-'));
  const marker = path.join(dir, 'invocations');
  const script = path.join(dir, 'fake-python');
  fs.writeFileSync(script, '#!/bin/sh\necho "$@" >> "$RR_R8_MARKER"\nexit 0\n', { mode: 0o755 });
  quota.configurePythonRunner({ python: script, cwd: dir, env: { RR_R8_MARKER: marker } });
  const count = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean).length : 0);
  try { return fn(count); } finally {
    quota.configurePythonRunner(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 16 ledger-only liabilities (no activity dirs): certain charge == CEILING, entirely carried by
// the ledger -- hiding `quota/` collapses the charge to (near) 0 (Codex's repro shape).
function seedFullLedger(home) {
  A.secureMkdir(A.quotaDir(home));
  for (let i = 0; i < 16; i++) {
    const aid = A.mintActivityId();
    fs.writeFileSync(A.ledgerEntryPath(home, aid), JSON.stringify({ reserved: quota.RESERVE, granted: quota.ORDINARY_CAP }), { mode: 0o600 });
  }
}

// A SETTLED activity: segment bytes on disk, no ledger entry, no lock.
function seedSettled(home, nbytes, name = 'python-deadbeef.jsonl') {
  const aid = A.mintActivityId();
  A.secureMkdir(A.activityDir(home, aid));
  const seg = path.join(A.activityDir(home, aid), name);
  fs.writeFileSync(seg, Buffer.alloc(Math.min(nbytes, 4096), 0x0a), { mode: 0o600 });
  if (nbytes > 4096) fs.truncateSync(seg, nbytes);
  return aid;
}

function jsonCount(dir) {
  return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).length;
}

// ---------------------------------------------------------------------------------------------
// R8-1 / Ruling 64
// ---------------------------------------------------------------------------------------------

test('Ruling 64 (i): quota/ swapped for an empty dir DURING the lock WAIT (stubbed _lockfBlocking) -> _quotaLock throws; admit refused with no reservation under either dir, the 16 real liabilities untouched', () => {
  const home = tmpHome();
  try {
    seedFullLedger(home); // certain charge == CEILING, carried entirely by the ledger
    const qdir = A.quotaDir(home);
    const moved = `${qdir}.moved`;
    const realLockf = quota._lockfBlocking;

    // (a) _quotaLock itself must throw -- the acquisition fails outright, nothing is returned.
    quota._lockfBlocking = (fd) => {
      fs.renameSync(qdir, moved); // the real, liability-bearing directory moves aside
      fs.mkdirSync(qdir, 0o700); // a FRESH, empty directory appears at the same path
      return realLockf(fd); // the actual lockf acquisition still proceeds/succeeds normally
    };
    try {
      assert.throws(
        () => quota._quotaLock(home),
        A.UnsafePath,
        'a swap landing during the wait must fail the acquisition itself, not just look uncertain later',
      );
    } finally {
      quota._lockfBlocking = realLockf;
    }
    assert.strictEqual(jsonCount(moved), 16, 'the swap left the 16 real liabilities untouched');

    // restore for the admit()-level assertion below
    fs.rmSync(qdir, { recursive: true, force: true });
    fs.renameSync(moved, qdir);

    // (b) the same repro through the public admit() entrypoint.
    const [aid, lease] = newLiveActivity(home);
    quota._lockfBlocking = (fd) => {
      fs.renameSync(qdir, moved);
      fs.mkdirSync(qdir, 0o700);
      return realLockf(fd);
    };
    let result;
    try {
      withNoPython(() => { result = quota.admit(home, aid, lease); });
    } finally {
      quota._lockfBlocking = realLockf;
    }
    assert.strictEqual(result, false, 'pre-fix: canonical charge 61,440 vs authorized liability 67,170,304 -- admit must refuse instead');
    assert.ok(!fs.existsSync(path.join(moved, `${aid}.json`)), 'no reservation in the real (moved-aside) dir');
    assert.ok(!fs.existsSync(path.join(qdir, `${aid}.json`)), 'no reservation in the swapped-in empty dir');
    assert.strictEqual(jsonCount(moved), 16, 'all 16 real liabilities are still untouched');

    fs.rmSync(qdir, { recursive: true, force: true });
    fs.renameSync(moved, qdir);
    lease.release();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 64 (ii): quota/ swapped for an empty dir between validation and readdir (stubbed fs.readdirSync) -> the post-readdir canonical check catches it -- admit refused, nothing written, the 16 real liabilities untouched', () => {
  const home = tmpHome();
  try {
    seedFullLedger(home);
    const qdir = A.quotaDir(home);
    const moved = `${qdir}.moved`;
    const [aid, lease] = newLiveActivity(home);

    const realReaddir = fs.readdirSync;
    let fired = false;
    fs.readdirSync = (p, ...rest) => {
      if (!fired && p === qdir) {
        fired = true;
        fs.renameSync(qdir, moved);
        fs.mkdirSync(qdir, 0o700);
      }
      return realReaddir(p, ...rest);
    };
    let result;
    try {
      withNoPython(() => { result = quota.admit(home, aid, lease); });
    } finally {
      fs.readdirSync = realReaddir;
    }
    assert.strictEqual(fired, true, 'the swap must have landed inside the locked readdir window');
    assert.strictEqual(result, false, 'the post-readdir canonical check must catch the swap and refuse admission');
    assert.ok(!fs.existsSync(path.join(moved, `${aid}.json`)));
    assert.ok(!fs.existsSync(path.join(qdir, `${aid}.json`)));
    assert.strictEqual(jsonCount(moved), 16, 'the 16 real liabilities are untouched');

    fs.rmSync(qdir, { recursive: true, force: true });
    fs.renameSync(moved, qdir);
    lease.release();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 64 (iii): quota/ swapped immediately after a CERTAIN over-ceiling snapshot is computed (right before the prune delegation would fire) -> zero delegations, admit refused', () => {
  const home = tmpHome();
  try {
    for (let i = 0; i < 16; i++) seedSettled(home, quota.PER_ACTIVITY_CAP); // certain, over-ceiling: a measured shortfall
    assert.deepStrictEqual(quota._accountingSnapshot(home), { charge: quota.CEILING, uncertain: false, corrupt: false });
    const [aid, lease] = newLiveActivity(home);
    const qdir = A.quotaDir(home);
    const moved = `${qdir}.moved`;

    const realSnapshot = quota._accountingSnapshot;
    let fired = false;
    quota._accountingSnapshot = (h, ctx) => {
      const result = realSnapshot(h, ctx); // compute the REAL (pre-swap) snapshot first
      if (!fired && ctx !== undefined) { // only the locked (admit-driven) call, only once
        fired = true;
        fs.renameSync(qdir, moved);
        fs.mkdirSync(qdir, 0o700);
      }
      return result; // hand admit() the genuine certain/over-ceiling result it already computed
    };
    let result;
    withCountingRunner((count) => {
      try {
        result = quota.admit(home, aid, lease);
      } finally {
        quota._accountingSnapshot = realSnapshot;
      }
      assert.strictEqual(count(), 0, 'a swap landing right before delegation must prevent any prune spawn');
    });
    assert.strictEqual(fired, true, 'the swap must have fired between the snapshot and the delegation guard');
    assert.strictEqual(result, false, 'admit must refuse rather than delegate a prune against post-swap state');
    assert.ok(!fs.existsSync(path.join(qdir, `${aid}.json`)));
    assert.ok(!fs.existsSync(path.join(moved, `${aid}.json`)));

    fs.rmSync(qdir, { recursive: true, force: true });
    fs.renameSync(moved, qdir);
    lease.release();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 64: _verifyCanonical also catches a swap of the ACTIVITY ROOT alone, with quota/ itself left untouched', () => {
  const home = tmpHome();
  try {
    const rootDir = path.dirname(A.quotaDir(home));
    const ctx = quota._quotaLock(home);
    try {
      assert.strictEqual(quota._verifyCanonical(ctx), true);
      const movedRoot = `${rootDir}.moved`;
      fs.renameSync(rootDir, movedRoot);
      fs.mkdirSync(rootDir, 0o700);
      fs.mkdirSync(A.quotaDir(home), 0o700); // recreate an empty quota/ under the new root
      assert.strictEqual(quota._verifyCanonical(ctx), false, 'a root swap must be caught even though quota/ itself is untouched by identity');
      // restore
      fs.rmSync(rootDir, { recursive: true, force: true });
      fs.renameSync(movedRoot, rootDir);
      assert.strictEqual(quota._verifyCanonical(ctx), true);
    } finally {
      quota._unlock(ctx);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// R8-2 / Ruling 65 -- overlap parity is exercised by accounting-parity.test.js against the
// Python-authored fixture; nothing to add here (see that file's own vector-driven tests).
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// R8-3 / Ruling 66
// ---------------------------------------------------------------------------------------------

// Captures the fd `_quotaLock` opens for `quota.lock` (via `paths.openOwnedRegular`, the sole use
// of that primitive in `_quotaLock`), then makes `fs.closeSync` throw on THAT fd specifically --
// while still actually closing it underneath, so the injected failure is purely a JS-level throw
// with no real leak. Any OTHER fd (e.g. the ledger-entry temp file `_writeEntry` closes) closes
// normally, so the write path itself is unaffected.
function withLockFdCloseThrow(fn) {
  const realOpen = paths.openOwnedRegular;
  const realClose = fs.closeSync;
  let lockFd = null;
  let closeThrew = false;
  paths.openOwnedRegular = (...args) => {
    const fd = realOpen(...args);
    lockFd = fd; // _quotaLock opens exactly one fd via this primitive per call
    return fd;
  };
  fs.closeSync = (fd) => {
    if (fd === lockFd) {
      closeThrew = true;
      realClose(fd); // actually release the OS resource -- prove no real leak
      throw new Error('injected lock release/close failure (Ruling 66 test)');
    }
    return realClose(fd);
  };
  try {
    return fn(() => closeThrew, () => lockFd);
  } finally {
    paths.openOwnedRegular = realOpen;
    fs.closeSync = realClose;
  }
}

test('Ruling 66: _unlock itself never throws -- a release/close failure is contained, the fd is still actually closed (no leak)', () => {
  const home = tmpHome();
  const ctx = quota._quotaLock(home);
  const realClose = fs.closeSync;
  let threw = false;
  fs.closeSync = (fd) => {
    threw = true;
    realClose(fd);
    throw new Error('injected close failure');
  };
  try {
    assert.doesNotThrow(() => quota._unlock(ctx));
  } finally {
    fs.closeSync = realClose;
    fs.rmSync(home, { recursive: true, force: true });
  }
  assert.strictEqual(threw, true, 'the injected failure must actually have fired');
  assert.throws(() => fs.fstatSync(ctx.fd), (e) => e.code === 'EBADF', 'the fd must genuinely be closed despite the injected throw');
});

test('Ruling 66: a lock release/close failure never escapes admit -- a successful admission still returns true, and the lock fd is not leaked', () => {
  const home = tmpHome();
  try {
    const [aid, lease] = newLiveActivity(home);
    let closeThrew;
    let lockFd;
    withNoPython(() => {
      withLockFdCloseThrow((wasThrown, fd) => {
        const result = quota.admit(home, aid, lease);
        assert.strictEqual(result, true, 'a cleanup failure must never flip an already-persisted successful admission to false');
        closeThrew = wasThrown();
        lockFd = fd();
      });
    });
    assert.strictEqual(closeThrew, true, 'the injected close failure must actually have fired');
    assert.strictEqual(typeof lockFd, 'number');
    assert.throws(() => fs.fstatSync(lockFd), (e) => e.code === 'EBADF', 'the lock fd must genuinely be closed (no leak), despite the injected throw');
    assert.strictEqual(fs.existsSync(A.ledgerEntryPath(home, aid)), true, 'the reservation was durably written regardless of the cleanup failure');
    lease.release();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 66: a lock release/close failure never escapes grant -- a successful grant still returns true, fd not leaked', () => {
  const home = tmpHome();
  try {
    const [aid, lease] = newLiveActivity(home);
    withNoPython(() => assert.strictEqual(quota.admit(home, aid, lease), true));
    let closeThrew;
    let lockFd;
    withLockFdCloseThrow((wasThrown, fd) => {
      const result = quota.grant(home, aid, 100);
      assert.strictEqual(result, true, 'a cleanup failure must never flip an already-persisted successful grant to false');
      closeThrew = wasThrown();
      lockFd = fd();
    });
    assert.strictEqual(closeThrew, true);
    assert.throws(() => fs.fstatSync(lockFd), (e) => e.code === 'EBADF');
    lease.release();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 66: a lock release/close failure never escapes settle -- never throws, warns are unaffected', () => {
  const home = tmpHome();
  try {
    const [aid, lease] = newLiveActivity(home);
    withNoPython(() => assert.strictEqual(quota.admit(home, aid, lease), true));
    let closeThrew;
    let lockFd;
    withCountingRunner((count) => {
      withLockFdCloseThrow((wasThrown, fd) => {
        assert.doesNotThrow(() => quota.settle(home, aid));
        closeThrew = wasThrown();
        lockFd = fd();
      });
      assert.strictEqual(count(), 1, 'a certain, non-corrupt snapshot still delegates the reap despite the cleanup failure');
    });
    assert.strictEqual(closeThrew, true);
    assert.throws(() => fs.fstatSync(lockFd), (e) => e.code === 'EBADF');
    lease.release();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
