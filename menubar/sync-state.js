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
//   - One current attempt per channel. Who is current is decided from evidence, never from the
//     order HTTP requests arrive in: Electron's own spawn (it holds the root lock by then), or the
//     attempts' Activity records (a live owner lease, durable start times, recorded outcomes).
//     An unfamiliar ID never displaces an attempt that is still running. Retired IDs are only a
//     shortcut for rejecting the same late updates again.
//   - An attempt's terminal outcome wins over its own late progress.
//   - Anonymous updates (an older worker build) are dropped while an identified attempt runs,
//     and otherwise go to a separate compatibility view that never borrows an identified
//     attempt's outcome or stats.
//   - Completion is never inferred from old stats or a missing child handle: only the attempt's
//     own `complete` stats are shown, and only alongside that attempt's outcome. A finished owner
//     with no recorded outcome is shown as unknown, not as interrupted.
//
// The main-process half (admit/begin/finish/resolve) is pure data over the status object plus
// the evidence callbacks main.js supplies; the renderer half (applySyncState) takes `doc` and
// touches nothing else, so both can be tested. Activity records and receipts stay authoritative;
// this is only a view onto them.
//
// `ctx`, as main.js builds it:
//   channel             this app's channel; an update naming another channel is not ours to show
//   liveChildAttemptId  the attempt of Electron's own live worker, if any
//   pendingAttemptIds   Electron's own attempts that have not got the root lock yet (a manual
//                       click holds an Activity lease while it waits, so it must not count as a
//                       running worker)
//   ownerState(id)      'busy' | 'free' | 'uncertain', from the attempt's Activity owner lease
//   evidence()          null when the Activity store can't be read, else
//                       { attempts: [{ id, startedAt, outcome, owner }] } for this channel's sync
//                       attempts, newest first (owner is probed only for unfinished ones)
//   reconciledOutcome(id)  the attempt's recorded or reconciled outcome, or null

const PHASES = ['starting', 'waiting-for-network', 'syncing'];
const FINISHED = 'finished';
const UNKNOWN = 'unknown';
const RETIRED_LIMIT = 20;
const UNFINISHED_OUTCOMES = new Set(['running', 'unknown']);

// Update types that describe progress inside a run. Once the attempt is finished these are late
// and are dropped; its abort details (`error`) and repeated terminals are still accepted.
const PROGRESS_TYPES = new Set(['progress', 'output', 'rate-limit', 'waiting-for-network',
  'sync-lifecycle', 'complete']);

const NOT_ACCEPTED = Object.freeze({ accept: false, changed: false, started: false });

function _entries(status) {
  if (!status.syncState || typeof status.syncState !== 'object') status.syncState = {};
  return status.syncState;
}

function current(status, channel) {
  const all = status && status.syncState;
  const entry = all && typeof all === 'object' ? all[channel] : null;
  return entry && typeof entry === 'object' ? entry : null;
}

function _fresh(attemptId, now, previous, { phase = 'starting', verified = false, legacy = false,
  startedAt = null } = {}) {
  const retired = previous ? [...(previous.retired || [])] : [];
  if (previous && previous.attemptId && !retired.includes(previous.attemptId)) {
    retired.push(previous.attemptId);
  }
  return {
    attemptId: attemptId || null,
    verified: !!verified,
    legacy: !!legacy,
    phase,
    outcome: null,
    reason: null,
    stats: null,
    startedAt: startedAt || null,
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
      if (entry.legacy) {
        const errors = entry.stats && entry.stats.errors > 0;
        _setFinished(entry, errors ? 'failed' : 'succeeded', null, now);
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

function _owner(ctx, id) {
  if (!id || !ctx || typeof ctx.ownerState !== 'function') return 'uncertain';
  try {
    return String(ctx.ownerState(id) || 'uncertain').toLowerCase();
  } catch (e) {
    return 'uncertain';
  }
}

function _evidence(ctx) {
  if (!ctx || typeof ctx.evidence !== 'function') return null;
  try {
    const ev = ctx.evidence();
    return ev && Array.isArray(ev.attempts) ? ev : null;
  } catch (e) {
    return null;
  }
}

function _time(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
}

// Is `entry`'s attempt still running? Electron's own child, or a busy Activity owner lease.
function _isLive(entry, ctx) {
  if (!entry || !entry.attemptId) return false;
  if (ctx && ctx.liveChildAttemptId && ctx.liveChildAttemptId === entry.attemptId) return true;
  return _owner(ctx, entry.attemptId) === 'busy';
}

// May an update from unfamiliar attempt `id` replace identified `entry` as current? Returns the
// new entry's options, or null to reject the update.
function _supersedes(entry, id, ctx) {
  if (_isLive(entry, ctx)) return null; // never displace a running attempt
  const ev = _evidence(ctx);
  const cand = ev && ev.attempts.find((a) => a.id === id);
  const cur = ev && ev.attempts.find((a) => a.id === entry.attemptId);
  if (cand) {
    if (cand.owner === 'busy') return { verified: true, startedAt: cand.startedAt };
    const candAt = _time(cand.startedAt);
    const curAt = cur ? _time(cur.startedAt) : null;
    if (candAt !== null && curAt !== null && candAt > curAt) {
      return { verified: true, startedAt: cand.startedAt };
    }
    // The current entry was never backed by a durable record; a durable candidate outranks it.
    if (!cur && !entry.verified) return { verified: true, startedAt: cand.startedAt };
    return null;
  }
  // No durable record for the candidate (Activity recording unavailable for it). It may only
  // supply an unverified display, and only once the current attempt is over.
  if (_isFinished(entry) || _owner(ctx, entry.attemptId) === 'free') return { verified: false };
  return null;
}

// Decide whether a worker update belongs to the current attempt on this channel, and record its
// effect. `accept: false` means the caller must drop it entirely (no window send, no status
// changes): it is for another channel, from an attempt that is not current, or late progress
// from a finished one. `started: true` means this update made a new attempt current.
function admit(status, payload, ctx = {}) {
  if (!payload || typeof payload !== 'object') return NOT_ACCEPTED;
  const now = ctx.now || new Date().toISOString();
  const named = typeof payload.channel === 'string' && payload.channel ? payload.channel : null;
  if (named && ctx.channel && named !== ctx.channel) return NOT_ACCEPTED;
  const ch = ctx.channel || named;
  const all = _entries(status);
  const entry = current(status, ch);
  const id = typeof payload.attemptId === 'string' && payload.attemptId ? payload.attemptId : null;

  if (!id) {
    // An older worker build. It cannot be the identified run that is still going, and it never
    // writes into an identified attempt's entry: it gets its own compatibility view.
    if (entry && entry.attemptId && !_isFinished(entry)) return NOT_ACCEPTED;
    let target = entry && entry.legacy ? entry : null;
    if (!target || (_isFinished(target) && PROGRESS_TYPES.has(payload.type))) {
      target = all[ch] = _fresh(null, now, entry, { legacy: true });
    }
    const started = target !== entry;
    return { accept: true, changed: _apply(target, payload, now) || started, started };
  }

  if (entry && (entry.retired || []).includes(id)) return NOT_ACCEPTED;

  let target = entry;
  if (entry && entry.attemptId === id) {
    if (_isFinished(entry) && PROGRESS_TYPES.has(payload.type)) return NOT_ACCEPTED;
  } else {
    let opts = { verified: false };
    if (entry && entry.attemptId && !entry.legacy) {
      opts = _supersedes(entry, id, ctx);
      if (!opts) return NOT_ACCEPTED;
    } else {
      const ev = _evidence(ctx);
      const cand = ev && ev.attempts.find((a) => a.id === id);
      if (cand) opts = { verified: true, startedAt: cand.startedAt };
    }
    target = all[ch] = _fresh(id, now, entry, opts);
  }
  const started = target !== entry;
  const changed = _apply(target, payload, now);
  return { accept: true, changed: changed || started, started };
}

// Electron spawned a worker for `attemptId`: the root exec lock is held by now, so this attempt
// really is the current one. A refused attempt never gets here, so it cannot disturb a running
// scheduled attempt's entry.
function begin(status, channel, attemptId, { now = new Date().toISOString() } = {}) {
  const all = _entries(status);
  const entry = current(status, channel);
  if (entry && attemptId && entry.attemptId === attemptId) {
    entry.verified = true;
    return entry; // the worker already said so
  }
  all[channel] = _fresh(attemptId, now, entry, { verified: true });
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

function _viewOf(entry, extra) {
  return {
    attemptId: entry ? entry.attemptId : null,
    stats: entry && entry.stats ? entry.stats : null,
    phase: entry ? entry.phase : UNKNOWN,
    outcome: entry && _isFinished(entry) ? entry.outcome : null,
    reason: entry && _isFinished(entry) ? entry.reason : null,
    live: false,
    canStop: false,
    ...extra,
  };
}

const _unknownView = (entry) => _viewOf(entry, { phase: UNKNOWN, outcome: null, reason: null,
  stats: null });

// What a window opening now (or the app starting) should show for this channel, settling the
// current attempt from evidence first. Returns { view, changed }: `changed` means the status
// object was updated (an attempt adopted or finished) and should be saved. `view` is null only
// when there is no attempt view at all and no evidence of one, so the caller keeps its
// pre-existing behavior for status files from older builds.
function resolve(status, ctx = {}) {
  const ch = ctx.channel;
  const now = ctx.now || new Date().toISOString();
  const all = _entries(status);
  const entry = current(status, ch);

  // Electron's own worker: it holds the root lock, nothing can outrank it.
  if (entry && entry.attemptId && ctx.liveChildAttemptId === entry.attemptId) {
    return { view: _viewOf(entry, { live: true, canStop: true }), changed: false };
  }
  // A worker the app didn't start, still running. Stop only works on Electron's own child.
  const entryOwner = entry && entry.attemptId ? _owner(ctx, entry.attemptId) : 'uncertain';
  if (entry && !_isFinished(entry) && entryOwner === 'busy') {
    return { view: _viewOf(entry, { live: true }), changed: false };
  }

  const ev = _evidence(ctx);
  const pending = new Set(ctx.pendingAttemptIds || []);
  const others = ev
    ? ev.attempts.filter((a) => a.id !== (entry && entry.attemptId) && !pending.has(a.id))
    : [];
  const liveOthers = others.filter((a) => a.owner === 'busy');
  if (liveOthers.length > 1) return { view: _unknownView(entry), changed: false };
  if (liveOthers.length === 1) {
    // A running worker whose updates the app never saw (it started while the app was closed,
    // or its posts were lost). Its phase is unknown until it reports one.
    const live = liveOthers[0];
    all[ch] = _fresh(live.id, now, entry, { phase: UNKNOWN, verified: true,
      startedAt: live.startedAt });
    return { view: _viewOf(all[ch], { live: true }), changed: true };
  }

  if (!entry) return { view: null, changed: false };

  if (!_isFinished(entry)) {
    if (entry.attemptId && entryOwner === 'free') {
      const outcome = typeof ctx.reconciledOutcome === 'function'
        ? ctx.reconciledOutcome(entry.attemptId) : null;
      if (outcome && !UNFINISHED_OUTCOMES.has(outcome)) {
        _setFinished(entry, outcome, null, now);
        return { view: _viewOf(entry, { recovered: true }), changed: true };
      }
    }
    // No owner to ask, an owner we can't read, or a gone owner with nothing recorded: say so.
    return { view: _unknownView(entry), changed: false };
  }

  // Finished. Has a later attempt finished without the app hearing about it?
  const cur = ev && entry.attemptId ? ev.attempts.find((a) => a.id === entry.attemptId) : null;
  const curAt = cur ? _time(cur.startedAt) : null;
  if (curAt !== null) {
    const later = others.filter((a) => (_time(a.startedAt) || 0) > curAt);
    if (later.some((a) => UNFINISHED_OUTCOMES.has(a.outcome))) {
      return { view: _unknownView(entry), changed: false }; // can't tell how that one stands
    }
    if (later.length > 0) {
      const newest = later[0];
      all[ch] = _fresh(newest.id, now, entry, { verified: true, startedAt: newest.startedAt });
      _setFinished(all[ch], newest.outcome, null, now);
      return { view: _viewOf(all[ch], { recovered: true }), changed: true };
    }
  }
  return { view: _viewOf(entry), changed: false };
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
  FINISHED, UNKNOWN, PHASES, PHASE_TEXTS, OUTCOME_TEXTS, NETWORK_ABORT_TEXT,
  current, admit, begin, finish, resolve, syncStateText, applySyncState,
};
