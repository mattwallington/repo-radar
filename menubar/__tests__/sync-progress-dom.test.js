'use strict';
// Closing the progress window during a morning network wait used to lose the wait: the phase was
// sent only to an open window and never saved, and a reopened window was rebuilt as "Starting
// sync...". This drives the whole flow -- wait while closed, open, timeout, reopen -- through the
// same status-object bookkeeping main.js uses and the renderer's applySyncState.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const syncState = require(path.join(__dirname, '..', 'sync-state.js'));

const ID = '33333333-3333-4333-8333-333333333333';

// Just the two elements applySyncState touches. Text only: there is no innerHTML to fall back on.
function makeDoc() {
  const statusText = { textContent: 'Starting sync...', style: {} };
  const classes = new Set(['active']);
  const stopBtn = {
    disabled: false,
    textContent: '⏹',
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
    get active() { return classes.has('active'); },
  };
  const els = { 'status-text': statusText, 'stop-sync-btn': stopBtn };
  return { statusText, stopBtn, getElementById: (id) => els[id] || null };
}

// What main.js's window-open replay hands the renderer, for an attempt Electron started.
function openWindow(status, { childRunning }) {
  const doc = makeDoc();
  const view = syncState.replayView(syncState.current(status, 'stable'), {
    childRunning, ownerState: () => 'free', reconciledOutcome: () => null,
  });
  syncState.applySyncState(doc, view);
  return doc;
}

test('a network wait that starts while the window is closed is still shown, and so is its timeout', () => {
  const status = {};
  const post = (payload) => syncState.admit(status, { ...payload, attemptId: ID, channel: 'stable' });

  syncState.begin(status, 'stable', ID);
  post({ type: 'sync-lifecycle', phase: 'starting' });
  post({ type: 'waiting-for-network' }); // no window open

  const during = openWindow(status, { childRunning: true });
  assert.strictEqual(during.statusText.textContent, 'Waiting for network...');
  assert.strictEqual(during.stopBtn.disabled, false, 'Electron\'s own child can still be stopped');

  post({ type: 'network-timeout', message: 'No network connectivity' });
  post({ type: 'error', repo: 'Network', message: 'No network connectivity' });
  post({ type: 'sync-terminal', outcome: 'failed', reason: 'no_network_connectivity' });

  // The child has exited; reopening shows the abort, not a fresh "Starting sync..." or "Complete!".
  const after = openWindow(status, { childRunning: false });
  assert.strictEqual(after.statusText.textContent, 'No network connectivity — sync aborted');
  assert.strictEqual(after.stopBtn.disabled, true);
  assert.strictEqual(after.stopBtn.active, false);
});
