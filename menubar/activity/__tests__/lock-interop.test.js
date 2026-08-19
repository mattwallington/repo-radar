'use strict';
// Task 2.2a linchpin: proves Node's lease.js (which shells out to /usr/bin/lockf, since stock
// Node has no flock(2) binding) and Python's repo_radar/activity/lease.py (which calls
// fcntl.flock directly) take CONFLICTING advisory locks on the SAME owner.lock file, in BOTH
// directions. This is the load-bearing premise the whole Node lease design rests on -- if either
// direction fails, the Node lease does not actually interoperate with the Python lease and the
// whole approach needs to be reconsidered (see the Task 2.2a brief).
//
// Mechanism (verified empirically, see ../lease.js's header comment for the full mechanism):
// BSD flock(2) locks are attached to the OPEN FILE DESCRIPTION, not the calling process or
// language runtime, so a lock taken via `lockf(1)` on an fd is exactly as visible to a
// `fcntl.flock()` caller in another process as a lock taken by another `flock()` caller would be,
// and vice versa.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawnSync, spawn } = require('node:child_process');
const paths = require('../paths');
const { acquire, probeBusy } = require('../lease');

const VALID = '00000000-0000-4000-8000-000000000000';
const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const PYENV = { ...process.env, PYTHONPATH: REPO_ROOT };

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-lease-interop-'));
}

function lockFor(home) {
  const d = paths.activityDir(home, VALID);
  paths.secureMkdir(d);
  return paths.ownerLockPath(home, VALID);
}

// `sys.exit(0 if lease.probe_busy(path) else 1)` -- exit code IS the boolean, so the Node side
// just checks the child's exit status without parsing any output.
const PROBE_BUSY_SCRIPT = [
  'import sys',
  'from repo_radar.activity import lease',
  'sys.exit(0 if lease.probe_busy(sys.argv[1]) else 1)',
].join('\n');

function pythonProbeBusy(lp) {
  const r = spawnSync('python3', ['-c', PROBE_BUSY_SCRIPT, lp], { cwd: REPO_ROOT, env: PYENV, encoding: 'utf8' });
  assert.ifError(r.error, `failed to spawn python3 (is it on PATH?): ${r.error && r.error.message}`);
  assert.ok([0, 1].includes(r.status), `python probe script exited unexpectedly (status=${r.status}):\n${r.stderr}`);
  return r.status === 0;
}

test('Node-held lock is seen BUSY by Python lease.probe_busy; releasing frees it for Python too', () => {
  const lp = lockFor(tmpHome());
  const l = acquire(lp);
  assert.ok(l !== null, 'Node acquire must succeed on a fresh lock');

  assert.strictEqual(pythonProbeBusy(lp), true, 'Python must see the Node-held (lockf) lease as busy');

  l.release();

  assert.strictEqual(pythonProbeBusy(lp), false, 'Python must see the lease as free once Node releases it');
});

// `lease.acquire` (Python) then hold the lock by sleeping, printing a line once the lock is
// actually held so the Node side can synchronize on that instead of racing a fixed sleep.
const PYTHON_HOLD_SCRIPT = [
  'import sys, time',
  'from repo_radar.activity import lease',
  'l = lease.acquire(sys.argv[1])',
  'if l is None:',
  '    print("ACQUIRE_FAILED", flush=True)',
  '    sys.exit(1)',
  'print("ACQUIRED", flush=True)',
  'time.sleep(10)',
].join('\n');

function waitForLine(stream, expected, timeoutMs) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: stream });
    const timer = setTimeout(() => {
      rl.close();
      reject(new Error(`timed out after ${timeoutMs}ms waiting for "${expected}"`));
    }, timeoutMs);
    rl.on('line', (line) => {
      if (line.trim() === expected) {
        clearTimeout(timer);
        rl.close();
        resolve();
      }
    });
  });
}

test('Python-held lock is seen BUSY by Node probeBusy; killing the Python holder frees it for Node too', async () => {
  const lp = lockFor(tmpHome());
  const child = spawn('python3', ['-c', PYTHON_HOLD_SCRIPT, lp], { cwd: REPO_ROOT, env: PYENV });

  let stderrBuf = '';
  child.stderr.on('data', (d) => { stderrBuf += d.toString(); });

  try {
    await waitForLine(child.stdout, 'ACQUIRED', 5000);
  } catch (e) {
    child.kill('SIGKILL');
    assert.fail(`python holder never reported ACQUIRED: ${e.message}\nstderr:\n${stderrBuf}`);
  }

  try {
    assert.strictEqual(probeBusy(lp), true, 'Node must see the Python-held (flock) lease as busy');
  } finally {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }

  assert.strictEqual(probeBusy(lp), false, 'Node must see the lease as free once the Python holder is killed');
});
