'use strict';
// Fixture run in a CHILD process (spawned with a wall-clock timeout by lease.test.js) rather than
// in-process, so a real regression that made acquire/probe BLOCK on a FIFO owner.lock would kill
// only this child (reaped by the parent's spawnSync timeout) instead of hanging the whole
// `node --test` run forever. This is the Node analog of the Python suite's SIGALRM guard in
// test_activity_lease.py::test_acquire_refuses_a_fifo_owner_lock_without_blocking -- Node has no
// stdlib equivalent of `signal.alarm` that can interrupt a blocked synchronous syscall from
// inside the same process, so the guard has to live at the process boundary instead.
const paths = require('../../paths');
const { acquire, probe, UNCERTAIN } = require('../../lease');

const VALID = '00000000-0000-4000-8000-000000000000';

function fail(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

const home = process.argv[2];
if (!home) fail('usage: fifo-acquire-check.js <home>');

const d = paths.activityDir(home, VALID);
paths.secureMkdir(d);
const lp = paths.ownerLockPath(home, VALID);

// Node stdlib has no mkfifo binding; shell out to the system binary (test-fixture-only, not
// something lease.js itself does).
const { execFileSync } = require('child_process');
execFileSync('/usr/bin/mkfifo', [lp]);

const acquired = acquire(lp);
if (acquired !== null) fail('acquire() did not refuse a FIFO owner.lock (expected null)');

const probed = probe(lp);
if (probed !== UNCERTAIN) fail(`probe() did not return UNCERTAIN for a FIFO owner.lock (got ${probed})`);

process.stdout.write('OK\n');
process.exit(0);
