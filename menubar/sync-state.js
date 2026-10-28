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
//   - One current attempt per channel, and only one seen executing: Electron's own spawn (it
//     holds the root lock by then), or an unfamiliar worker's own progress while complete Activity
//     evidence shows its owner lease live and nothing else that could be running. A live lease, a
//     start time, a terminal or a finished history item alone never makes an attempt current, and
//     the order HTTP requests arrive in never does. Retired IDs are only a shortcut for rejecting
//     the same late updates again.
//   - When evidence can't show the current attempt is still the latest (the store is unreadable
//     or only partly read, another run may be going or may have run since), the window says
//     "unknown" and nothing about who is current changes. A run the app never saw stays in
//     Activity; it is not reconstructed here.
//   - An attempt's terminal outcome wins over its own late progress. Its final `complete` stats
//     are still kept if they arrive after the terminal, without reopening or changing it.
//   - Anonymous updates (an older worker build) are dropped while an identified attempt runs,
//     and otherwise go to a separate compatibility view that never borrows an identified
//     attempt's outcome or stats.
//   - Completion is never inferred from old stats or a missing child handle: only the attempt's
//     own `complete` stats are shown, and only alongside that attempt's outcome. A finished owner
//     with no recorded outcome is shown as unknown, not as interrupted.
//
// Each attempt's entry also carries its run snapshot (`run`): the repository roster, per-repo
// progress, stats, output, error details and error flag. main.js keeps working with these as the
// familiar top-level status fields; `project()` fills them from this channel's current attempt
// when status.json is read and `store()` files them back under it when it is written, keeping
// every other channel's entry as it is on disk. So a reopened window shows this attempt's rows,
// never the previous run's or another channel's. Receipts and the schedule's completion
// timestamps stay shared and authoritative.
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
//   evidence()          { available, truncated, incomplete,
//                         attempts: [{ id, startedAt, outcome, owner, incomplete }] } for this
//                       channel's sync attempts (owner is probed only for unfinished ones)
//   reconciledOutcome(id)  the attempt's recorded or reconciled outcome, or null

const PHASES = ['starting', 'waiting-for-network', 'syncing'];
const FINISHED = 'finished';
const UNKNOWN = 'unknown';
const RETIRED_LIMIT = 20;
const UNFINISHED_OUTCOMES = new Set(['running', 'unknown']);

// Update types that describe progress inside a run. Once the attempt is finished these are late
// and are dropped; its abort details (`error`) and repeated terminals are still accepted.
const PROGRESS_TYPES = new Set(['progress', 'output', 'rate-limit', 'waiting-for-network',
  'sync-lifecycle', 'sync-roster', 'complete']);
// Updates only a running worker sends. Only these can show an unfamiliar attempt is executing;
// a terminal or a final `complete` can arrive long after the run, from any attempt.
const ESTABLISHING_TYPES = new Set(['progress', 'output', 'rate-limit', 'waiting-for-network',
  'sync-lifecycle', 'sync-roster']);
// Activity outcomes for a startup that never ran a sync (turned away by contention or a guard).
const NOT_RUN_OUTCOMES = new Set(['skipped', 'blocked']);

// The run snapshot fields, as main.js names them at the top level of the status object.
// `syncRepos` is the roster: null until known, [] for a run with no repositories.
const RUN_DEFAULTS = {
  repos: () => [],
  syncRepos: () => null,
  errorList: () => [],
  errorLog: () => '',
  logOutput: () => '',
  hasErrors: () => false,
  stats: () => ({ total: 0, cloned: 0, updated: 0, errors: 0 }),
};
const RUN_FIELDS = Object.keys(RUN_DEFAULTS);

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

function _fresh(attemptId, now, previous, { phase = 'starting', executed = false, legacy = false,
  startedAt = null } = {}) {
  const retired = previous ? [...(previous.retired || [])] : [];
  if (previous && previous.attemptId && !retired.includes(previous.attemptId)) {
    retired.push(previous.attemptId);
  }
  // A new attempt starts with no rows, errors or output of its own. The channel's last completed
  // stats carry over for the tray's summary line only; the window shows `entry.stats`.
  const run = {};
  for (const k of RUN_FIELDS) run[k] = RUN_DEFAULTS[k]();
  if (previous && previous.run && previous.run.stats) run.stats = previous.run.stats;
  return {
    attemptId: attemptId || null,
    // Seen executing: Electron's own spawn after the root lock, or the attempt's own worker
    // updates. Only such an attempt is ever shown as the current run.
    executed: !!executed,
    legacy: !!legacy,
    phase,
    outcome: null,
    reason: null,
    stats: null,
    startedAt: startedAt || null,
    updatedAt: now,
    // When an identified worker update arrived that no evidence could tie to an attempt; from then
    // on this attempt's result is not shown as the latest.
    unexplainedAt: null,
    retired: retired.slice(-RETIRED_LIMIT),
    run,
  };
}

// Make `entry` the channel's current attempt, and its run snapshot the status's top-level fields.
function _becomeCurrent(status, ch, entry) {
  _entries(status)[ch] = entry;
  for (const k of RUN_FIELDS) status[k] = entry.run[k];
  return entry;
}

// Does this status file keep per-channel run snapshots (written by this build for any channel)?
function _hasSnapshots(status) {
  const all = status && status.syncState;
  return !!all && typeof all === 'object'
    && Object.values(all).some((e) => e && typeof e === 'object' && e.run && typeof e.run === 'object');
}

// Fill the top-level run fields from `channel`'s current attempt (main.js's loadStatus). In a
// file that keeps snapshots, a channel without one of its own starts from empty run fields --
// the shared top-level copy may well be another channel's run. Only a status file from an older
// build, with no snapshots at all, has its shared fields used as they are.
function project(status, channel) {
  const entry = current(status, channel);
  if (!entry || !entry.run || typeof entry.run !== 'object') {
    if (channel && _hasSnapshots(status)) {
      for (const k of RUN_FIELDS) status[k] = RUN_DEFAULTS[k]();
    }
    return status;
  }
  for (const k of RUN_FIELDS) {
    status[k] = entry.run[k] !== undefined && entry.run[k] !== null ? entry.run[k] : RUN_DEFAULTS[k]();
  }
  if (entry.run.syncRepos === null) status.syncRepos = null;
  return status;
}

// What to write (main.js's saveStatus): this process's status, with its run fields filed under
// its channel's current attempt and every other channel's entry taken from `disk` as it is now.
// The top-level run fields are still written, for an older build reading the same file.
function store(disk, status, channel) {
  const out = { ...status };
  const onDisk = disk && disk.syncState && typeof disk.syncState === 'object' ? disk.syncState : {};
  out.syncState = { ...onDisk };
  const mine = channel ? current(status, channel) : null;
  if (mine) {
    const run = {};
    for (const k of RUN_FIELDS) run[k] = status[k] !== undefined ? status[k] : RUN_DEFAULTS[k]();
    out.syncState[channel] = { ...mine, run };
  }
  return out;
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
    case 'sync-roster':
      return true; // the roster itself is recorded by main.js as the run's `syncRepos`
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

// The Activity evidence main.js read, and whether it can say who else might be running:
// `sufficient` only when the store was readable, the whole list fit in one read and nothing in it
// was incomplete. Evidence short of that is never treated as an empty or exhaustive list.
function _evidence(ctx) {
  const none = { sufficient: false, attempts: [] };
  if (!ctx || typeof ctx.evidence !== 'function') return none;
  let ev;
  try {
    ev = ctx.evidence();
  } catch (e) {
    return none;
  }
  if (!ev || !Array.isArray(ev.attempts)) return none;
  const sufficient = ev.available !== false && !ev.truncated && !ev.incomplete
    && ev.attempts.every((a) => a && !a.incomplete);
  return { sufficient, attempts: ev.attempts };
}

function _time(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
}

function _isChild(entry, ctx) {
  return !!(entry && entry.attemptId && ctx && ctx.liveChildAttemptId === entry.attemptId);
}

// The attempts other than `exceptId` that may have run a sync: not Electron's own attempts still
// waiting for the root lock, and not startups turned away (skipped, blocked) -- those stay true
// Activity history but never stand for a run.
function _candidates(ev, ctx, exceptId) {
  const pending = new Set((ctx && ctx.pendingAttemptIds) || []);
  return ev.attempts.filter((a) => a.id !== exceptId && !pending.has(a.id)
    && !NOT_RUN_OUTCOMES.has(a.outcome));
}

// Could `a` have started after `entry`? Dates can only raise this doubt, never decide who is
// current or what happened.
function _maybeNewer(a, entry, ev) {
  const own = ev.attempts.find((x) => x.id === entry.attemptId);
  const since = _time(own && own.startedAt) ?? _time(entry.startedAt);
  const at = _time(a.startedAt);
  return since === null || at === null || at > since;
}

// May an update from unfamiliar attempt `id` make it current? Only with complete evidence that it
// is running (a live owner lease) and that nothing else could be: Electron's own child, a known
// attempt whose owner is live, or a second running candidate all make it ambiguous.
function _mayEstablish(entry, id, ctx) {
  if (ctx.liveChildAttemptId) return false; // Electron's own child holds the root lock
  if (entry && entry.attemptId && !_isFinished(entry) && _owner(ctx, entry.attemptId) === 'busy') {
    return false;
  }
  const ev = _evidence(ctx);
  if (!ev.sufficient) return false;
  const cand = _candidates(ev, ctx, null).find((a) => a.id === id);
  if (!cand || cand.owner !== 'busy') return false;
  return !_candidates(ev, ctx, id).some((a) => a.owner === 'busy');
}

// A rejected worker update the evidence doesn't explain as an older or finished attempt's: a run
// the window can't identify may be going. Nothing about the current attempt changes, but its
// result may no longer be shown as the latest.
function _isUnexplained(id, ctx) {
  const ev = _evidence(ctx);
  const rec = ev.sufficient ? ev.attempts.find((a) => a.id === id) : null;
  return !rec || UNFINISHED_OUTCOMES.has(rec.outcome) || rec.owner === 'busy';
}

// Decide whether a worker update belongs to the current attempt on this channel, and record its
// effect. `accept: false` means the caller must drop it (no window send); it is for another
// channel, from an attempt that is not current, or late progress from a finished one. If
// `changed` is still true the status was marked (see `unexplainedAt`) and should be saved.
// `started: true` means this update made a new attempt current. `lateComplete: true` means it is
// the current attempt's `complete` arriving after its terminal: its stats were recorded, and
// nothing else about the attempt may change.
function admit(status, payload, ctx = {}) {
  if (!payload || typeof payload !== 'object') return NOT_ACCEPTED;
  const now = ctx.now || new Date().toISOString();
  const named = typeof payload.channel === 'string' && payload.channel ? payload.channel : null;
  if (named && ctx.channel && named !== ctx.channel) return NOT_ACCEPTED;
  const ch = ctx.channel || named;
  const entry = current(status, ch);
  const id = typeof payload.attemptId === 'string' && payload.attemptId ? payload.attemptId : null;

  if (!id) {
    // An older worker build. It cannot be the identified run that is still going, and it never
    // writes into an identified attempt's entry: it gets its own compatibility view.
    if (entry && entry.attemptId && !_isFinished(entry)) return NOT_ACCEPTED;
    let target = entry && entry.legacy ? entry : null;
    if (!target || (_isFinished(target) && PROGRESS_TYPES.has(payload.type))) {
      target = _becomeCurrent(status, ch, _fresh(null, now, entry, { legacy: true, executed: true,
        startedAt: now }));
    }
    const started = target !== entry;
    return { accept: true, changed: _apply(target, payload, now) || started, started };
  }

  if (entry && (entry.retired || []).includes(id)) return NOT_ACCEPTED;

  let target = entry;
  let marked = false;
  if (entry && entry.attemptId === id) {
    if (_isFinished(entry) && payload.type === 'complete') {
      entry.stats = payload.stats && typeof payload.stats === 'object' ? payload.stats : entry.stats;
      return { accept: true, changed: true, started: false, lateComplete: true };
    }
    if (_isFinished(entry) && PROGRESS_TYPES.has(payload.type)) return NOT_ACCEPTED;
    if (ESTABLISHING_TYPES.has(payload.type) && !entry.executed) {
      entry.executed = true; // its own worker is running: this attempt really did start
      marked = true;
    }
  } else {
    // A terminal, a late `complete` or a start time alone never makes an attempt current.
    if (!ESTABLISHING_TYPES.has(payload.type) || !_mayEstablish(entry, id, ctx)) {
      if (entry && ESTABLISHING_TYPES.has(payload.type) && !entry.unexplainedAt
        && _isUnexplained(id, ctx)) {
        entry.unexplainedAt = now;
        return { ...NOT_ACCEPTED, changed: true };
      }
      return NOT_ACCEPTED;
    }
    const cand = _evidence(ctx).attempts.find((a) => a.id === id);
    target = _becomeCurrent(status, ch, _fresh(id, now, entry, { executed: true,
      startedAt: cand.startedAt }));
  }
  const started = target !== entry;
  const changed = _apply(target, payload, now);
  return { accept: true, changed: changed || started || marked, started };
}

// Electron spawned a worker for `attemptId`: the root exec lock is held by now, so this attempt
// really is running and is the current one. A refused attempt never gets here, so it cannot
// disturb a running scheduled attempt's entry.
function begin(status, channel, attemptId, { now = new Date().toISOString() } = {}) {
  const entry = current(status, channel);
  if (entry && attemptId && entry.attemptId === attemptId) {
    entry.executed = true;
    return entry; // the worker already said so
  }
  return _becomeCurrent(status, channel, _fresh(attemptId, now, entry, { executed: true,
    startedAt: now }));
}

// Record an outcome Electron learned itself (child exit, Activity reconciliation), but only for
// the attempt it was learned about and only if the worker did not already report one.
function finish(status, channel, attemptId, outcome, reason = null,
  { now = new Date().toISOString() } = {}) {
  const entry = current(status, channel);
  if (!entry || entry.attemptId !== (attemptId || null)) return false;
  return _setFinished(entry, outcome, reason, now);
}

// `snapshot` says whether the entry's run fields (rows, stats) belong with this view. An unknown
// view with no established current attempt shows none, rather than an older run's relabeled.
function _viewOf(entry, extra) {
  return {
    attemptId: entry ? entry.attemptId : null,
    stats: entry && entry.stats ? entry.stats : null,
    phase: entry ? entry.phase : UNKNOWN,
    outcome: entry && _isFinished(entry) ? entry.outcome : null,
    reason: entry && _isFinished(entry) ? entry.reason : null,
    live: false,
    canStop: false,
    snapshot: !!entry,
    ...extra,
  };
}

const _unknownView = (entry) => _viewOf(entry, { phase: UNKNOWN, outcome: null, reason: null,
  stats: null });

// The current attempt as its own latest news has it -- its own update just admitted, or
// Electron's own child just exited -- with no discovery: what an open window shows right then.
function ownView(status, ctx = {}) {
  const entry = current(status, ctx.channel);
  if (!entry) return null;
  const child = _isChild(entry, ctx);
  return _viewOf(entry, { live: child || !_isFinished(entry), canStop: child });
}

// What a window opening now (or the app starting) should show for this channel. Returns
// { view, changed }: `changed` means the status object was updated (a known attempt's outcome was
// recovered) and should be saved. Who is current is never changed here: this only settles the
// known attempt from its own evidence, and says "unknown" whenever the evidence can't show that
// it is still the latest. `view` is null only for a status file from an older build with no sign
// of a running sync, so the caller keeps that file's old replay.
function resolve(status, ctx = {}) {
  const ch = ctx.channel;
  const now = ctx.now || new Date().toISOString();
  const entry = current(status, ch);

  // Electron's own worker: it holds the root lock, nothing can outrank it.
  if (_isChild(entry, ctx)) {
    return { view: _viewOf(entry, { live: true, canStop: true }), changed: false };
  }

  if (!entry) {
    // Another channel keeps its runs here, but this one has none of its own: nothing to show
    // yet, rather than the shared fields' (possibly another channel's) completed run.
    if (_hasSnapshots(status)) return { view: _unknownView(null), changed: false };
    const ev = _evidence(ctx);
    const quiet = ev.sufficient && !_candidates(ev, ctx, null).some((a) => a.owner === 'busy');
    return { view: quiet ? null : _unknownView(null), changed: false };
  }

  // Only an attempt seen running (Electron's own spawn, or its own worker updates) is shown as
  // the current run; an entry from an older build without that mark keeps its data, unshown.
  const established = entry.executed === true;
  let changed = false;
  if (!_isFinished(entry)) {
    const owner = entry.attemptId ? _owner(ctx, entry.attemptId) : 'uncertain';
    // A worker the app didn't start, still running. Stop only works on Electron's own child.
    if (owner === 'busy') {
      return { view: established ? _viewOf(entry, { live: true }) : _unknownView(null), changed };
    }
    if (owner === 'free' && typeof ctx.reconciledOutcome === 'function') {
      const outcome = ctx.reconciledOutcome(entry.attemptId);
      if (outcome && !UNFINISHED_OUTCOMES.has(outcome)) {
        changed = _setFinished(entry, outcome, null, now);
      }
    }
    // No owner to ask, an owner we can't read, or a gone owner with nothing recorded: say so.
    if (!_isFinished(entry)) {
      return { view: _unknownView(established ? entry : null), changed };
    }
  }

  // Finished. It is still the latest only if complete evidence shows no other run that may be
  // going or may have run since (one the app never heard from is inspected in Activity).
  if (!established || entry.unexplainedAt) return { view: _unknownView(null), changed };
  const ev = _evidence(ctx);
  const doubt = !ev.sufficient || _candidates(ev, ctx, entry.attemptId)
    .some((a) => a.owner === 'busy' || _maybeNewer(a, entry, ev));
  return { view: doubt ? _unknownView(null) : _viewOf(entry), changed };
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
  current, admit, begin, finish, resolve, ownView, project, store, syncStateText, applySyncState,
};
