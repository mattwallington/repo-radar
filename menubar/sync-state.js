'use strict';
// What the progress window should say about the current sync attempt, kept per channel in
// status.json so it survives the window closing, the app restarting, and runs the app did not
// start itself (the LaunchAgent's scheduled worker is not an Electron child).
//
// Before this, the waiting-for-network and network-timeout phases went only to a window that was
// open at that moment, a reopened window was rebuilt as "Starting sync..." or, with no Electron
// child handle, as the previous run's "Complete!", and nothing tied an update to the run that
// sent it. Now every update from the Python worker names its attempt (the Activity ID) and
// channel; this file decides whether to accept it and what phase the attempt is in.
//
// Rules:
//   - One current attempt per channel. When a new one starts, the old ID is retired and any of
//     its late updates are rejected.
//   - An attempt's terminal outcome wins over its own late progress.
//   - An update without an attemptId (an older worker build) is accepted only while no identified
//     attempt is running, and never rewrites an identified attempt's entry.
//   - Completion is never inferred from old stats: only the attempt's own `complete` stats are
//     shown, and only alongside that attempt's outcome.
//
// The main-process half (admit/begin/finish/replayView) is pure data over the status object; the
// renderer half (applySyncState) takes `doc` and touches nothing else, so both can be tested.
// Activity reconciliation and receipts stay authoritative; this is only a view onto them.

const PHASES = ['starting', 'waiting-for-network', 'syncing'];
const FINISHED = 'finished';
const RETIRED_LIMIT = 20;

// Update types that describe progress inside a run. Once the attempt is finished these are late
// and are dropped; its abort details (`error`) and repeated terminals are still accepted.
const PROGRESS_TYPES = new Set(['progress', 'output', 'rate-limit', 'waiting-for-network',
  'sync-lifecycle', 'complete']);

function _entries(status) {
  if (!status.syncState || typeof status.syncState !== 'object') status.syncState = {};
  return status.syncState;
}

function current(status, channel) {
  const all = status && status.syncState;
  const entry = all && typeof all === 'object' ? all[channel] : null;
  return entry && typeof entry === 'object' ? entry : null;
}

function _fresh(attemptId, now, previous) {
  const retired = previous ? [...(previous.retired || [])] : [];
  if (previous && previous.attemptId && !retired.includes(previous.attemptId)) {
    retired.push(previous.attemptId);
  }
  return {
    attemptId: attemptId || null,
    phase: 'starting',
    outcome: null,
    reason: null,
    stats: null,
    updatedAt: now,
    retired: retired.slice(-RETIRED_LIMIT),
  };
}

function _isFinished(entry) {
  return !!entry && entry.phase === FINISHED;
}

function _setFinished(entry, outcome, reason, now) {
  if (_isFinished(entry)) return false; // the first terminal for an attempt is the one kept
  entry.phase = FINISHED;
  entry.outcome = typeof outcome === 'string' && outcome ? outcome : 'failed';
  entry.reason = typeof reason === 'string' && reason ? reason : null;
  entry.updatedAt = now;
  return true;
}

// Apply one payload's effect on its entry. Returns true if anything changed.
function _apply(entry, payload, now) {
  switch (payload.type) {
    case 'sync-lifecycle':
      if (PHASES.includes(payload.phase) && entry.phase !== payload.phase) {
        entry.phase = payload.phase;
        entry.updatedAt = now;
        return true;
      }
      return false;
    case 'waiting-for-network':
      if (entry.phase === 'waiting-for-network') return false;
      entry.phase = 'waiting-for-network';
      entry.updatedAt = now;
      return true;
    case 'progress':
      // A repo moving means the run is past its network wait, even for a worker build that never
      // sends the `syncing` lifecycle phase.
      if (entry.phase === 'syncing') return false;
      entry.phase = 'syncing';
      entry.updatedAt = now;
      return true;
    case 'complete':
      entry.stats = payload.stats && typeof payload.stats === 'object' ? payload.stats : null;
      entry.updatedAt = now;
      // An older worker never sends `sync-terminal`; its `complete` is its outcome.
      if (!payload.attemptId) {
        const errors = entry.stats && entry.stats.errors > 0;
        return _setFinished(entry, errors ? 'failed' : 'succeeded', null, now) || true;
      }
      return true;
    case 'network-timeout':
      return _setFinished(entry, 'failed', 'no_network_connectivity', now);
    case 'sync-terminal':
      return _setFinished(entry, payload.outcome, payload.reason, now);
    default:
      return false;
  }
}

// Decide whether a worker update belongs to the current attempt on its channel, and record its
// effect. `accept: false` means the caller must drop it entirely (no window send, no status
// changes): it is from a retired attempt, or it is late progress from a finished one.
// `started: true` means this update is the first the app has seen of a new attempt.
function admit(status, payload, { channel, now = new Date().toISOString() } = {}) {
  if (!payload || typeof payload !== 'object') {
    return { accept: false, changed: false, started: false };
  }
  const ch = typeof payload.channel === 'string' && payload.channel ? payload.channel : channel;
  const all = _entries(status);
  const entry = current(status, ch);
  const id = typeof payload.attemptId === 'string' && payload.attemptId ? payload.attemptId : null;

  if (!id) {
    if (entry && entry.attemptId) {
      // An identified attempt owns this channel. While it runs, an anonymous update cannot be
      // its own and is dropped; after it finishes, the update is passed through unrecorded.
      return { accept: _isFinished(entry), changed: false, started: false };
    }
    let target = entry || (all[ch] = _fresh(null, now, null));
    if (_isFinished(target) && PROGRESS_TYPES.has(payload.type)) {
      // An older worker sends no start of its own; its first progress after a finished run is a
      // new run.
      target = all[ch] = _fresh(null, now, target);
    }
    const started = target !== entry;
    return { accept: true, changed: _apply(target, payload, now) || started, started };
  }

  if (entry && (entry.retired || []).includes(id)) {
    return { accept: false, changed: false, started: false };
  }

  let target = entry;
  if (!target || target.attemptId !== id) {
    target = all[ch] = _fresh(id, now, entry);
  } else if (_isFinished(target) && PROGRESS_TYPES.has(payload.type)) {
    return { accept: false, changed: false, started: false };
  }
  const started = target !== entry;
  const changed = _apply(target, payload, now);
  return { accept: true, changed: changed || started, started };
}

// Electron spawned a worker for `attemptId` (the root exec lock is held by now, so this attempt
// really is the current one). A refused attempt never gets here, so it cannot disturb a running
// scheduled attempt's entry.
function begin(status, channel, attemptId, { now = new Date().toISOString() } = {}) {
  const all = _entries(status);
  const entry = current(status, channel);
  if (entry && attemptId && entry.attemptId === attemptId) return entry; // worker already said so
  all[channel] = _fresh(attemptId, now, entry);
  return all[channel];
}

// Record an outcome Electron learned itself (child exit, Activity reconciliation), but only for
// the attempt it was learned about and only if the worker did not already report one.
function finish(status, channel, attemptId, outcome, reason = null,
  { now = new Date().toISOString() } = {}) {
  const entry = current(status, channel);
  if (!entry || entry.attemptId !== (attemptId || null)) return false;
  return _setFinished(entry, outcome, reason, now);
}

// What a window opening now should show. `childRunning`: Electron's own worker is alive.
// `ownerState()`: the Activity owner lease for the attempt ('busy' | 'free' | 'uncertain').
// `reconciledOutcome()`: the Activity outcome once the owner is gone (null if none). Returns null
// when there is no entry, so the caller keeps its pre-existing behavior for status files from
// older builds.
function replayView(entry, { childRunning = false, ownerState = () => 'uncertain',
  reconciledOutcome = () => null } = {}) {
  if (!entry) return null;
  const base = { attemptId: entry.attemptId, stats: entry.stats || null };
  if (_isFinished(entry)) {
    return { ...base, phase: FINISHED, outcome: entry.outcome, reason: entry.reason, live: false,
      canStop: false };
  }
  if (childRunning) {
    return { ...base, phase: entry.phase, outcome: null, reason: null, live: true, canStop: true };
  }
  // Not Electron's child: a scheduled worker, or a run that outlived an app restart. The stop
  // button only works on Electron's own child, so it is never offered here.
  const owner = entry.attemptId ? String(ownerState(entry.attemptId) || '').toLowerCase()
    : 'uncertain';
  if (owner === 'busy') {
    return { ...base, phase: entry.phase, outcome: null, reason: null, live: true, canStop: false };
  }
  if (owner === 'free') {
    const outcome = reconciledOutcome(entry.attemptId);
    return { ...base, phase: FINISHED, outcome: outcome || 'interrupted', reason: null,
      live: false, canStop: false, recovered: true };
  }
  return { ...base, phase: 'unknown', outcome: null, reason: null, live: false, canStop: false };
}

// ---- Renderer half ------------------------------------------------------------------------

const WAIT_COLOR = '#f0ad4e';
const FAIL_COLOR = '#d9534f';

// A closed set of sentences; nothing from the payload is rendered. The waiting and network-abort
// sentences are the ones the window already used.
const PHASE_TEXTS = {
  'starting': 'Starting sync...',
  'waiting-for-network': 'Waiting for network...',
  'syncing': 'Syncing...',
  'unknown': 'Sync status unknown — a sync may still be running',
};
const OUTCOME_TEXTS = {
  'succeeded': 'Complete!',
  'succeeded-with-warnings': 'Complete (with warnings)',
  'failed': 'Sync failed — see ⚠️ View Errors in the menu',
  'cancelled': 'Sync cancelled by user',
  'interrupted': 'Sync stopped before it finished',
  'blocked': 'Sync could not start — see ⚠️ View Errors in the menu',
  'skipped': 'Nothing to do — a sync already ran',
};
const NETWORK_ABORT_TEXT = 'No network connectivity — sync aborted';

function syncStateText(view) {
  if (!view) return PHASE_TEXTS.unknown;
  if (view.phase === FINISHED) {
    if (view.outcome === 'failed' && view.reason === 'no_network_connectivity') {
      return NETWORK_ABORT_TEXT;
    }
    return Object.prototype.hasOwnProperty.call(OUTCOME_TEXTS, view.outcome)
      ? OUTCOME_TEXTS[view.outcome] : OUTCOME_TEXTS.interrupted;
  }
  return Object.prototype.hasOwnProperty.call(PHASE_TEXTS, view.phase)
    ? PHASE_TEXTS[view.phase] : PHASE_TEXTS.unknown;
}

function _textColor(view) {
  if (!view) return '';
  if (view.phase === 'waiting-for-network' || view.phase === 'unknown') return WAIT_COLOR;
  if (view.phase === FINISHED && (view.outcome === 'failed' || view.outcome === 'blocked')) {
    return FAIL_COLOR;
  }
  return '';
}

// Show `view` in the progress window: the status line, and whether Stop is offered. Text only.
function applySyncState(doc, view) {
  if (!doc || typeof doc.getElementById !== 'function') return;
  const statusText = doc.getElementById('status-text');
  if (statusText) {
    statusText.textContent = syncStateText(view);
    if (statusText.style) statusText.style.color = _textColor(view);
  }
  const stopBtn = doc.getElementById('stop-sync-btn');
  if (stopBtn) {
    const canStop = !!(view && view.canStop && view.phase !== FINISHED);
    stopBtn.disabled = !canStop;
    if (stopBtn.classList) {
      if (canStop) stopBtn.classList.add('active');
      else stopBtn.classList.remove('active');
    }
    stopBtn.textContent = '⏹';
  }
}

module.exports = {
  FINISHED, PHASES, PHASE_TEXTS, OUTCOME_TEXTS, NETWORK_ABORT_TEXT,
  current, admit, begin, finish, replayView, syncStateText, applySyncState,
};
