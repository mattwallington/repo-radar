'use strict';
// Node mirror of the key scenarios in repo_radar/tests/test_activity_reconcile.py (Task 2.2b),
// plus coverage for the Node-specific gating reconcile.js folds in (see ../reconcile.js's header
// comment: Node's synthesizeTerminal derives has-start/has-terminal itself, since there is no
// separate `_reconcileOneLocked` wrapper on the Node side).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../index');
const { reconcile } = A;

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-reconcile-'));
}

function newActivity(home) {
  const aid = A.mintActivityId();
  A.secureMkdir(A.activityDir(home, aid));
  const l = A.acquire(A.ownerLockPath(home, aid));
  return [aid, l];
}

function writeRecord(home, aid, rec) {
  const full = { schema_version: 1, activity_id: aid, ts: '2026-08-14T00:00:00-07:00', ...rec };
  const seg = A.segmentPath(home, aid, 'python', 'deadbeef');
  const fd = A.secureOpenAppend(seg);
  fs.writeSync(fd, Buffer.from(`${JSON.stringify(full)}\n`));
  fs.closeSync(fd);
}

function writeStart(home, aid) {
  writeRecord(home, aid, {
    type: 'start', seq: 0, kind: 'sync', channel: 'stable', trigger: 'cli', created_by: 'python',
  });
}

function topTerminalOutcomes(home, aid) {
  const out = [];
  for (const seg of A.readOwnedSegments(A.activityDir(home, aid))) {
    for (const line of seg.data.toString('utf8').split('\n')) {
      if (!line) continue;
      const obj = A.parseValid(line, aid);
      if (obj !== null && obj.type === 'terminal') out.push([obj.outcome, obj.by]);
    }
  }
  return out;
}

test('synthesizes an interrupted terminal when the lease is free and a start is durable', () => {
  const home = tmpHome();
  const [aid, l] = newActivity(home);
  writeStart(home, aid);
  l.release(); // crash after start, before terminal

  assert.strictEqual(reconcile.synthesizeTerminal(home, aid), true);
  assert.deepStrictEqual(topTerminalOutcomes(home, aid), [['interrupted', 'reconciler']]);

  // the lease was released again -> a fresh acquire must succeed
  const fresh = A.acquire(A.ownerLockPath(home, aid));
  assert.ok(fresh !== null);
  fresh.release();
});

test('synthesizes a cancelled terminal when a cancel_requested control record is present', () => {
  const home = tmpHome();
  const [aid, l] = newActivity(home);
  writeStart(home, aid);
  writeRecord(home, aid, { type: 'control', seq: 1, name: 'cancel_requested' });
  l.release();

  assert.strictEqual(reconcile.synthesizeTerminal(home, aid), true);
  assert.deepStrictEqual(topTerminalOutcomes(home, aid), [['cancelled', 'reconciler']]);
});

test('preserves (does not write) when the lease is still held', () => {
  const home = tmpHome();
  const [aid, l] = newActivity(home); // lease still HELD, no crash
  writeStart(home, aid);
  assert.strictEqual(reconcile.synthesizeTerminal(home, aid), false);
  assert.deepStrictEqual(topTerminalOutcomes(home, aid), []);
  l.release();
});

test('nothing to synthesize when there is no durable start at all (owner-gone-pre-start case)', () => {
  const home = tmpHome();
  const [aid, l] = newActivity(home); // no start record written
  l.release();
  assert.strictEqual(reconcile.synthesizeTerminal(home, aid), false);
  assert.deepStrictEqual(topTerminalOutcomes(home, aid), []);
});

test('nothing to synthesize when a terminal already exists (idempotent, no double terminal)', () => {
  const home = tmpHome();
  const [aid, l] = newActivity(home);
  writeStart(home, aid);
  writeRecord(home, aid, { type: 'terminal', seq: 9, outcome: 'succeeded', summary: {}, by: 'deadbeef' });
  l.release();
  assert.strictEqual(reconcile.synthesizeTerminal(home, aid), false);
  assert.deepStrictEqual(topTerminalOutcomes(home, aid), [['succeeded', 'deadbeef']]); // unchanged
});

test('fs error path returns false, never throws, and still releases the lease it acquired', () => {
  const home = tmpHome();
  const [aid, l] = newActivity(home);
  writeStart(home, aid);
  l.release();

  const realFsync = fs.fsyncSync;
  fs.fsyncSync = () => { throw new Error('no fsync'); };
  let result;
  try {
    result = reconcile.synthesizeTerminal(home, aid);
  } finally {
    fs.fsyncSync = realFsync;
  }
  assert.strictEqual(result, false); // never durable, never raises

  // failure still releases the lease it acquired, so the activity remains reclaimable
  const fresh = A.acquire(A.ownerLockPath(home, aid));
  assert.ok(fresh !== null);
  fresh.release();
});

test('a top-level start whose fields nest type:"terminal" is not mistaken for a real terminal', () => {
  const home = tmpHome();
  const [aid, l] = newActivity(home);
  writeRecord(home, aid, {
    type: 'start', seq: 0, kind: 'sync', channel: 'stable', trigger: 'cli', created_by: 'python',
    fields: { type: 'terminal' },
  });
  l.release();
  assert.strictEqual(reconcile.synthesizeTerminal(home, aid), true); // still synthesizes
  assert.deepStrictEqual(topTerminalOutcomes(home, aid), [['interrupted', 'reconciler']]);
});
