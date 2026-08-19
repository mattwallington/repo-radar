'use strict';
// Node mirror of repo_radar/activity/lease.py (Task 2.2a). Python takes the advisory owner.lock
// in-process via `fcntl.flock`; stock Node has NO flock(2) binding, so this shells out to the
// system `/usr/bin/lockf -t 0 <fd>` utility -- the identical mechanism already proven in this
// codebase at menubar/runtime/dispatchers.js (`exec 9>"$ROOT/.exec.lock"; /usr/bin/lockf -t 0 9`
// for the root execution lock).
//
// EMPIRICALLY CONFIRMED (see __tests__/lock-interop.test.js, the bidirectional proof this
// mechanism depends on): /usr/bin/lockf and Python's `fcntl.flock` take CONFLICTING advisory
// locks on the same file, because BSD flock(2) locks are attached to the OPEN FILE DESCRIPTION
// (OFD) -- a kernel object -- not to the language runtime or CLI tool that requested them. A lock
// taken by lockf(1) is exactly as visible to a Python flock() caller as one taken by another
// Python process would be, and vice versa.
//
// Mechanism: `lockf -t 0 <fd>` (invoked with NO command, just an fd argument -- see `man lockf`)
// attempts to flock that fd and exits immediately: 0 on success, 75 (EX_TEMPFAIL) on contention.
// Because the lock lives on the OFD rather than on the lockf(1) process, the lock PERSISTS after
// the lockf child exits, as long as some fd referencing that same OFD stays open elsewhere --
// here, the fd Node itself opened (via paths.js's validated open) and passed into the lockf
// child through the `stdio` array. An integer entry in `stdio` shares the parent's fd at that
// array index in the child (verified via /dev/fd/N introspection in the child), so
// `spawnSync('/usr/bin/lockf', ['-t','0','3'], { stdio: ['ignore','ignore','ignore', fd] })`
// flocks the SAME OFD Node holds; the child exits immediately afterward but the lock stays held
// by Node's own still-open fd.
//
// `release()` is therefore just closing Node's retained fd: once it is the last reference to
// that OFD, the kernel drops the flock automatically (empirically verified -- no separate
// "unlock" invocation of lockf(1) exists; the CLI has no unlock verb, and stock Node has no
// direct flock(2) binding to issue an explicit LOCK_UN out-of-band the way Python's
// `Lease.release` does). See the Lease class below for how that shapes release() vs
// dropLocalReference().
const fs = require('fs');
const { spawnSync } = require('child_process');
const paths = require('./paths');
const ids = require('./ids');

const LOCKF_BIN = '/usr/bin/lockf';
const LOCKF_TIMEOUT_MS = 5000; // defensive only -- `-t 0` returns near-instantly on a real lockf

const FREE = 'FREE';
const BUSY = 'BUSY';
const UNCERTAIN = 'UNCERTAIN';

class HandoffRejected extends Error {}

// Run `/usr/bin/lockf -t 0 3` against `fd`, inherited into the child at stdio index 3 so the
// child sees it AS fd 3, sharing Node's open-file-description. Returns the lockf exit status, or
// null if the spawn itself didn't produce a real exit status (binary missing, killed by a
// signal, our defensive timeout tripped, ...) -- callers must treat null as "can't tell", never
// as BUSY, mirroring the tri-state contract all the way down.
function _lockf(fd) {
  const r = spawnSync(LOCKF_BIN, ['-t', '0', '3'], {
    stdio: ['ignore', 'ignore', 'ignore', fd],
    timeout: LOCKF_TIMEOUT_MS,
  });
  if (r.error || typeof r.status !== 'number') return null;
  return r.status;
}

class Lease {
  constructor(fd, ownerToken) {
    this.fd = fd;
    this.ownerToken = ownerToken;
  }

  // Full release: for the sole/terminal owner. Mechanically just closes the retained fd -- stock
  // Node has no flock(2) binding, so there is no way to issue an explicit "unlock regardless of
  // who else references this OFD" the way Python's `fcntl.flock(fd, LOCK_UN)` can. That
  // divergence only matters if some OTHER fd still shares this OFD (e.g. a live child) when
  // release() is called, which is precisely the case release() is NOT for -- see
  // dropLocalReference() below. When Node genuinely holds the sole reference (the documented
  // contract for calling release()), closing IS a full release: the kernel drops the flock the
  // instant the last fd on the OFD closes, identical in effect to an explicit LOCK_UN there.
  release() {
    if (this.fd !== null) {
      const fd = this.fd;
      this.fd = null;
      fs.closeSync(fd);
    }
  }

  // Close WITHOUT attempting to unlock (mirrors Python's `drop_local_reference`, finding 5): if a
  // live child still holds an fd on this SAME open-file-description (it inherited this fd across
  // a spawn, or adopted a dup of it), a bare close only removes NODE's reference -- the kernel
  // keeps the flock held until every fd on the OFD is closed, so the child keeps the lease.
  // Mechanically this is identical to release() (both just close `this.fd`); the two are
  // distinguished by CONTRACT -- which one the caller is allowed to invoke when -- not by
  // different syscalls, because Node has no way to distinguish "unlock" from "close" at the OS
  // level the way Python's explicit LOCK_UN does. Never call release() while a spawned/adopted
  // child still shares this fd's OFD; call dropLocalReference() there instead.
  dropLocalReference() {
    if (this.fd !== null) {
      const fd = this.fd;
      this.fd = null;
      fs.closeSync(fd);
    }
  }
}

function acquire(lockPath) {
  // descriptor-relative-STYLE, O_NONBLOCK, regular-file-only open (mirrors Python's Round-6 #4
  // fix) -- a FIFO owner.lock can neither block the open nor be adopted as a lease. Never throws
  // into the caller: any UnsafePath/OSError on open fails closed to null.
  let fd;
  try {
    fd = paths.openOwnedRegular(lockPath, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o600);
  } catch (e) {
    return null;
  }
  const status = _lockf(fd);
  if (status !== 0) {
    fs.closeSync(fd);
    return null;
  }
  return new Lease(fd, ids.mintToken());
}

function probe(lockPath) {
  // Tri-state via a fresh INDEPENDENT open-file-description (mirrors Python's finding 7): a
  // second fd opened on the same path never shares the holder's OFD, so lockf-ing it is a true
  // test of whether anyone else holds the lock, not a no-op reassert against ourselves.
  let fd;
  try {
    fd = paths.openOwnedRegular(lockPath, fs.constants.O_RDWR);
  } catch (e) {
    return UNCERTAIN; // missing file, unsafe path, non-regular target, ... -- can't confirm state
  }
  try {
    const status = _lockf(fd);
    if (status === 0) return FREE;   // we got it -> it was free (fd closed in finally, releasing it)
    if (status === 75) return BUSY;  // EX_TEMPFAIL: the genuine lockf-busy signal, and ONLY this
    return UNCERTAIN;                // any other exit/spawn failure -- never counted as BUSY
  } finally {
    fs.closeSync(fd); // FREE path: releases the lock we just took. BUSY/UNCERTAIN: nothing to release.
  }
}

function probeBusy(lockPath) {
  return probe(lockPath) === BUSY;
}

// §5 adopt truth table (mirrors lease.py.adopt exactly) -- ALL FOUR steps must pass, in order.
// Throws HandoffRejected (never returns null) on any rejection, matching Python's signalling.
function adopt(inheritedFd, ownerToken, lockPath) {
  // (1) syntactic
  if (!(Number.isInteger(inheritedFd) && inheritedFd >= 0 && ids.validToken(ownerToken))) {
    throw new HandoffRejected('bad fd/token syntax');
  }
  // (2) fstat identity vs a fresh non-symlink stat of lockPath; inherited fd must be a REGULAR
  // file (mirrors Python's Round-6 #4). This mirrors lease.py exactly: a raw lstat of lockPath,
  // NOT a re-walk through the owned-dir validator -- this step is a read-only comparison; the
  // actual safety enforcement for the LOCK ITSELF happens in steps 3/4 via probe()'s validated
  // open.
  let fst, pst;
  try {
    fst = fs.fstatSync(inheritedFd);
    pst = fs.lstatSync(lockPath);
  } catch (e) {
    throw new HandoffRejected(`stat failed: ${e.message}`);
  }
  if (!fst.isFile()) {
    throw new HandoffRejected('inherited fd is not a regular file');
  }
  if (fst.dev !== pst.dev || fst.ino !== pst.ino) {
    throw new HandoffRejected("fd is not this activity's owner.lock");
  }
  // (3) independent probe MUST be strictly BUSY (UNCERTAIN never counts as held)
  if (probe(lockPath) !== BUSY) {
    throw new HandoffRejected('lease not confirmably held (unlocked look-alike or uncertain)');
  }
  // (4) reassert on the INHERITED fd itself MUST succeed (shares the holding OFD)
  if (_lockf(inheritedFd) !== 0) {
    throw new HandoffRejected('inherited fd does not carry the lease');
  }
  return new Lease(inheritedFd, ownerToken);
}

module.exports = {
  FREE, BUSY, UNCERTAIN,
  HandoffRejected, Lease,
  acquire, probe, probeBusy, adopt,
};
