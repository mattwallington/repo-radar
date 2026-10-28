'use strict';
// The progress view's attempt bookkeeping (menubar/sync-state.js), as pure data: once a newer
// attempt is current, the previous one's late updates change nothing. The flows that need the
// main process, the Activity store and the renderer are in sync-progress-dom.test.js.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const syncState = require(path.join(__dirname, '..', 'sync-state.js'));

const OLD = '11111111-1111-4111-8111-111111111111';
const NEW = '22222222-2222-4222-8222-222222222222';

test('a previous attempt\'s late updates are dropped once a newer attempt is current', () => {
  const status = {};
  const ctx = { channel: 'stable' };
  syncState.begin(status, 'stable', OLD);
  syncState.admit(status, { type: 'progress', repo: 'o/r', percent: 40, attemptId: OLD, channel: 'stable' }, ctx);

  // OLD's worker was force-killed; a new manual run starts before OLD's last posts arrive.
  syncState.begin(status, 'stable', NEW);
  for (const late of [
    { type: 'progress', repo: 'o/r', percent: 90 },
    { type: 'complete', stats: { total: 1, errors: 0 } },
    { type: 'sync-terminal', outcome: 'succeeded' },
  ]) {
    const verdict = syncState.admit(status, { ...late, attemptId: OLD, channel: 'stable' }, ctx);
    assert.strictEqual(verdict.accept, false, `${late.type} from the old attempt must be dropped`);
  }
  // An older worker build's anonymous update cannot overwrite the identified run either.
  assert.strictEqual(syncState.admit(status, { type: 'complete', stats: {} }, ctx).accept, false);
  // Nor can the old child's delayed exit handling.
  assert.strictEqual(syncState.finish(status, 'stable', OLD, 'failed'), false);

  const entry = syncState.current(status, 'stable');
  assert.deepStrictEqual([entry.attemptId, entry.phase, entry.stats], [NEW, 'starting', null]);

  // The new attempt's own terminal still wins over its own late progress.
  syncState.admit(status, { type: 'sync-terminal', outcome: 'cancelled', attemptId: NEW, channel: 'stable' }, ctx);
  assert.strictEqual(syncState.admit(status, { type: 'progress', attemptId: NEW, channel: 'stable' }, ctx).accept, false);
  assert.strictEqual(syncState.current(status, 'stable').outcome, 'cancelled');
});
