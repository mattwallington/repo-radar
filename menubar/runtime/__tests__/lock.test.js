'use strict';
const test = require('node:test'); const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
const cp = require('child_process');
const { withLock, shellLockPreamble, LockBusy } = require('../lock');

function tmpLock() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rr-lock-')), '.lock');
}

test('withLock is mutually exclusive (-t 0 => LockBusy while held)', async () => {
  const lock = tmpLock();
  let release;
  const held = withLock(lock, 0, () => new Promise((r) => { release = r; }));
  await new Promise((r) => setTimeout(r, 100));
  await assert.rejects(withLock(lock, 0, () => 'x'), (e) => e instanceof LockBusy && e.code === 75);
  release();
  await held;
  assert.strictEqual(await withLock(lock, 0, () => 'ok'), 'ok'); // free again after release
});

test('kernel auto-releases the lock when the holder process is killed', async () => {
  const lock = tmpLock();
  // Child opens the lock fd, acquires via lockf fd-mode, then sleeps holding it.
  const holder = cp.spawn(process.execPath, ['-e', `
    const fs=require('fs'); const {spawnSync}=require('child_process');
    const fd=fs.openSync(${JSON.stringify(lock)},'a');
    const r=spawnSync('/usr/bin/lockf',['-t','0','3'],{stdio:['ignore','ignore','ignore',fd]});
    if(r.status!==0){process.exit(2);}
    process.stdout.write('held\\n');
    setInterval(()=>{},1000); // hold fd (and thus the lock) open
  `]);
  await new Promise((res, rej) => {
    holder.stdout.on('data', (d) => { if (String(d).includes('held')) res(); });
    holder.on('exit', (c) => rej(new Error('holder exited early code ' + c)));
  });
  await assert.rejects(withLock(lock, 0, () => 'x'), (e) => e instanceof LockBusy); // held
  holder.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(await withLock(lock, 0, () => 'freed'), 'freed'); // kernel released it
});

test('shell preamble emits fd-mode lockf', () => {
  const s = shellLockPreamble('/H/.exec.lock', 0);
  assert.match(s, /exec 9>"\/H\/\.exec\.lock"/);
  assert.match(s, /\/usr\/bin\/lockf -t 0 9 \|\| exit \$\?/);
});
