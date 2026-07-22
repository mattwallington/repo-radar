'use strict';
const fs = require('fs');
const { spawnSync } = require('child_process');

class LockBusy extends Error {
  constructor(m) { super(m); this.code = 75; }
}

// Acquire a kernel-backed fd-mode `lockf` lock on `lockPath`, hold it for the
// duration of `fn`, then release. The lock is flock-style on the open file
// description of `fd`: we open the persistent lock file, hand that fd to a
// `lockf` child (routed to the child's fd 3 via stdio), which acquires and
// exits while the OFD stays alive because *this* process keeps `fd` open.
// Closing `fd` (or this process dying) releases the kernel lock.
async function withLock(lockPath, timeoutSec, fn) {
  const fd = fs.openSync(lockPath, 'a'); // create/open persistent lock file
  const r = spawnSync('/usr/bin/lockf', ['-t', String(timeoutSec), '3'], {
    stdio: ['ignore', 'ignore', 'ignore', fd], // parent fd -> child fd 3
  });
  if (r.status !== 0) {
    fs.closeSync(fd);
    if (r.status === 75) throw new LockBusy(`lock busy: ${lockPath}`);
    throw new Error(`lockf failed (status ${r.status}) on ${lockPath}`);
  }
  try {
    return await fn();
  } finally {
    fs.closeSync(fd); // release the kernel lock
  }
}

// POSIX-sh snippet embedded in generated dispatchers: open fd 9 on the lock
// file, acquire via lockf fd-mode, then the caller `exec`s the worker which
// inherits the locked fd 9 (lock lifetime == worker lifetime).
function shellLockPreamble(lockPath, timeoutSec) {
  return `exec 9>"${lockPath}"\n/usr/bin/lockf -t ${timeoutSec} 9 || exit $?\n`;
}

module.exports = { LockBusy, withLock, shellLockPreamble };
