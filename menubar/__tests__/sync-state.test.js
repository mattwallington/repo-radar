'use strict';
// The progress view's attempt bookkeeping (menubar/sync-state.js): two of the real state bugs
// behind "the UI gets out of sync with whatever's happening behind the scenes".
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const syncState = require(path.join(__dirname, '..', 'sync-state.js'));

const OLD = '11111111-1111-4111-8111-111111111111';
const NEW = '22222222-2222-4222-8222-222222222222';

test('a scheduled run with no Electron child is shown as running, never as the previous run\'s "Complete!"', () => {
  // The previous run finished with stats on disk -- what the old idle replay turned into
  // "Complete!" for any window opened while a LaunchAgent worker was mid-run.
  const status = { stats: { total: 30, errors: 0 } };
  syncState.admit(status, { type: 'sync-lifecycle', phase: 'starting', attemptId: OLD, channel: 'stable' });
  syncState.admit(status, { type: 'complete', stats: { total: 30, errors: 0 }, attemptId: OLD, channel: 'stable' });
  syncState.admit(status, { type: 'sync-terminal', outcome: 'succeeded', attemptId: OLD, channel: 'stable' });

  // Next morning the LaunchAgent starts a worker. Electron never spawned it.
  const first = syncState.admit(status, { type: 'sync-lifecycle', phase: 'starting', attemptId: NEW, channel: 'stable' });
  assert.strictEqual(first.started, true);
  syncState.admit(status, { type: 'sync-lifecycle', phase: 'syncing', attemptId: NEW, channel: 'stable' });

  const view = syncState.replayView(syncState.current(status, 'stable'), {
    childRunning: false,
    ownerState: (id) => (id === NEW ? 'BUSY' : 'FREE'),
  });
  assert.strictEqual(view.phase, 'syncing');
  assert.strictEqual(view.live, true);
  assert.strictEqual(view.stats, null, 'the previous run\'s stats must not describe this run');
  assert.strictEqual(view.canStop, false, 'Stop only works on Electron\'s own child');

  // The worker exits without its terminal reaching the app (the app was restarting): the
  // Activity record, not the absent child handle, says how it ended.
  const recovered = syncState.replayView(syncState.current(status, 'stable'), {
    ownerState: () => 'FREE',
    reconciledOutcome: (id) => (id === NEW ? 'failed' : null),
  });
  assert.deepStrictEqual([recovered.phase, recovered.outcome], ['finished', 'failed']);
});

test('a previous attempt\'s late updates are dropped once a newer attempt is current', () => {
  const status = {};
  syncState.begin(status, 'stable', OLD);
  syncState.admit(status, { type: 'progress', repo: 'o/r', percent: 40, attemptId: OLD, channel: 'stable' });

  // OLD's worker was force-killed; a new manual run starts before OLD's last posts arrive.
  syncState.begin(status, 'stable', NEW);
  for (const late of [
    { type: 'progress', repo: 'o/r', percent: 90 },
    { type: 'complete', stats: { total: 1, errors: 0 } },
    { type: 'sync-terminal', outcome: 'succeeded' },
  ]) {
    const verdict = syncState.admit(status, { ...late, attemptId: OLD, channel: 'stable' });
    assert.strictEqual(verdict.accept, false, `${late.type} from the old attempt must be dropped`);
  }
  // An older worker build's anonymous update cannot overwrite the identified run either.
  assert.strictEqual(syncState.admit(status, { type: 'complete', stats: {} }, { channel: 'stable' }).accept, false);
  // Nor can the old child's delayed exit handling.
  assert.strictEqual(syncState.finish(status, 'stable', OLD, 'failed'), false);

  const entry = syncState.current(status, 'stable');
  assert.deepStrictEqual([entry.attemptId, entry.phase, entry.stats], [NEW, 'starting', null]);

  // The new attempt's own terminal still wins over its own late progress.
  syncState.admit(status, { type: 'sync-terminal', outcome: 'cancelled', attemptId: NEW, channel: 'stable' });
  assert.strictEqual(syncState.admit(status, { type: 'progress', attemptId: NEW, channel: 'stable' }).accept, false);
  assert.strictEqual(syncState.current(status, 'stable').outcome, 'cancelled');
});
