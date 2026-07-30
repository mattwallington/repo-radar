// Receipt reconciliation and catch-up policy. Importable so tests exercise THIS code, and so the
// policy has exactly one implementation — an earlier version put the equivalence rule in a helper
// (satisfiesSchedule) that no production path called, so the declared policy and the actual
// behaviour disagreed while the tests passed.
//
// State shape in status.json, which is SHARED between channels and also written by the status
// server, so scheduling state must be scoped INSIDE it rather than relying on the filename:
//   lastSync                   the STABLE schedule watermark. Only a stable, full run advances it,
//                              because it is what suppresses the next scheduled occurrence.
//   channels[ch].receiptAt     per-channel absorption watermark. Global before, so a dev receipt
//                              at 10:00 made a stable receipt at 09:00 look already-absorbed and
//                              silently discarded it.
//   channels[ch].{trigger,errors,mode,qualifies}   observability, per channel.

const SCHEMA = 2;
const VALID_TRIGGERS = ['scheduled', 'catchup', 'manual', 'cli'];
const VALID_CHANNELS = ['stable', 'dev'];
const VALID_MODES = ['full', 'skip-metadata', 'repos-only', 'metadata-only'];
// Only the stable channel owns a schedule; a dev build must never be able to satisfy it.
const SCHEDULING_CHANNEL = 'stable';
// Exit code meaning "declined, no work done" — distinct from 0 so the caller does not stamp a
// completion timestamp for a run that deliberately did nothing. Mirrors receipts.EXIT_SKIPPED_NO_WORK.
const EXIT_SKIPPED_NO_WORK = 66;

function isIsoString(value) {
  if (typeof value !== 'string' || !value) return false;
  return !Number.isNaN(new Date(value).getTime());
}

/** Type-validate a parsed receipt for `channel`. Returns the receipt or null; never throws. */
function validateReceipt(receipt, { channel = SCHEDULING_CHANNEL, now = new Date() } = {}) {
  if (!receipt || typeof receipt !== 'object') return null;
  if (receipt.schema !== SCHEMA) return null;
  if (receipt.completed !== true) return null;
  if (!VALID_CHANNELS.includes(receipt.channel) || receipt.channel !== channel) return null;
  if (!VALID_TRIGGERS.includes(receipt.trigger)) return null;
  if (!VALID_MODES.includes(receipt.mode)) return null;        // mode is validated, not trusted
  if (typeof receipt.qualifiesForSchedule !== 'boolean') return null;
  if (!isIsoString(receipt.finishedAt)) return null;
  if (new Date(receipt.finishedAt) > now) return null;         // clock skew / tampering
  const stats = receipt.stats;
  if (!stats || typeof stats !== 'object' || !Number.isInteger(stats.errors)) return null;
  // Additive within schema 2: receipts written before indexDropped existed simply omit it, and
  // absent must mean zero rather than invalid — rejecting those would discard every pre-existing
  // receipt and make the app believe no sync had ever run. Present-but-not-an-integer is still a
  // corrupt receipt.
  if (stats.indexDropped !== undefined && !Number.isInteger(stats.indexDropped)) return null;
  return receipt;
}

/** Repositories excluded from INDEX.md by this run. Absent (older schema-2 receipt) means zero. */
function indexDroppedOf(receipt) {
  const n = receipt && receipt.stats ? receipt.stats.indexDropped : 0;
  return Number.isInteger(n) ? n : 0;
}

/**
 * Did this run leave the cache in a good state? Distinct from `completed`: an incomplete INDEX.md
 * means repositories are invisible to agents even though every clone and analysis succeeded, so a
 * run with errors:0 and indexDropped:3 must not be reported to the user as a clean sync.
 */
function runSucceeded(receipt) {
  const errors = receipt && receipt.stats ? receipt.stats.errors : 0;
  // A warning ("no metadata generated: API key not configured") is actionable even though nothing
  // errored, and the live path already treats it as such. Mirrors Python's errorFree exactly.
  const warned = !!(receipt && receipt.warning);
  return (Number.isInteger(errors) ? errors : 0) === 0 && indexDroppedOf(receipt) === 0 && !warned;
}

/**
 * THE schedule-equivalence rule, DERIVED from the run's properties rather than taken on trust — a
 * receipt can carry mode:'metadata-only' with qualifiesForSchedule:true, and believing the flag
 * let a partial run suppress the schedule.
 *
 * checkMissedSync is freshness-based, and Electron already stamps lastSync for a completed manual
 * run, so a FULL manual or CLI run does satisfy freshness: re-running identical work minutes later
 * purely because the trigger was manual only spends money. What must NOT satisfy it is a partial
 * run (it did not do the scheduled work) or a dev run (wrong channel).
 */
function qualifiesForSchedule(receipt) {
  if (!receipt || typeof receipt !== 'object') return false;
  if (receipt.channel !== SCHEDULING_CHANNEL) return false;
  if (receipt.mode !== 'full') return false;
  return VALID_TRIGGERS.includes(receipt.trigger);
}

/**
 * May a live completion notification advance the schedule watermark?
 *
 * The status-server 'complete' handler used to advance lastSync unconditionally for any stable
 * run, so `--skip-metadata --status-server` suppressed the schedule even though Python wrote a
 * correctly non-qualifying receipt — and planReconcile is forward-only, so it could not undo it.
 * Same rule, same inputs, one implementation. Anything unvalidated returns false: refusing to
 * advance is recoverable (the receipt reconciles moments later), wrongly advancing is not.
 */
function completionQualifies(payload, channel = SCHEDULING_CHANNEL) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.channel !== channel) return false;
  return qualifiesForSchedule({
    channel: payload.channel,
    mode: payload.mode,
    trigger: payload.trigger,
  });
}

function channelState(status, channel) {
  const channels = (status && status.channels) || {};
  return channels[channel] || {};
}

/**
 * Parse a timestamp WE previously persisted. Missing, unparseable, or future values all read as
 * absent.
 *
 * Incoming receipts were validated this way from the start, but the markers we write ourselves
 * were trusted blindly — and they are the ones that gate progress. A corrupt statsAt made every
 * receipt look older and froze presentation forever; a future one blocked it until that date; a
 * future receiptAt made every receipt "already absorbed", freezing schedule history too. Treating
 * a marker we cannot trust as absent is the recoverable direction: the worst case is re-absorbing
 * a run we had already seen, versus never absorbing another one again.
 */
function parsePersistedInstant(value, now) {
  if (typeof value !== 'string' || !value) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  if (at > now) return null;
  return at;
}

/**
 * A receipt's outcome in the shape the LIVE path already writes to status.stats.
 *
 * Python's in-process stats dict is snake_case and its receipt is camelCase, so the same run
 * reaches the tray under two spellings depending on whether the app was open. Translating here
 * means presentation has exactly one source of truth instead of readers choosing between two
 * independently-stale representations — a choice that cannot be made correctly, because zero is a
 * meaningful clearing value and "prefer whichever is non-zero" therefore models nothing.
 */
function statsFromReceipt(receipt) {
  const s = (receipt && receipt.stats) || {};
  const int = (v) => (Number.isInteger(v) ? v : 0);
  return {
    total: int(s.total),
    updated: int(s.updated),
    cloned: int(s.cloned),
    skipped: int(s.skipped),
    errors: int(s.errors),
    metadata_generated: int(s.metadataGenerated),
    index_dropped: int(s.indexDropped),
    api_cost: typeof s.apiCost === 'number' ? s.apiCost : 0,
  };
}

/**
 * Decide what a receipt changes. Returns { adopt, advanceLastSync, status, reason }.
 * Pure: never mutates its inputs.
 */
function planReconcile(receipt, status, opts = {}) {
  const { channel = SCHEDULING_CHANNEL, now = new Date() } = opts;
  const valid = validateReceipt(receipt, { channel, now });
  if (!valid) {
    return { adopt: false, advanceLastSync: false, isLatestOutcome: false,
             recordHistory: false, status, reason: 'invalid' };
  }

  const finished = new Date(valid.finishedAt);
  const seenAt = parsePersistedInstant(channelState(status, channel).receiptAt, now);
  const statsAt = parsePersistedInstant(status && status.statsAt, now);

  // Two INDEPENDENT questions about the same receipt, previously collapsed into one early return:
  //   - has schedule/history already absorbed it?
  //   - is it newer than what the tray is presenting?
  // A build that predates statsAt answers yes to the first and yes to the second, because its
  // presentation was never migrated. Collapsing them meant an upgraded install kept stale
  // presentation indefinitely — until some future sync produced a newer receipt.
  const absorbed = !!(seenAt && !(finished > seenAt));
  const isLatestOutcome = !statsAt || finished > statsAt;

  if (absorbed && !isLatestOutcome) {
    return { adopt: false, advanceLastSync: false, isLatestOutcome: false,
             recordHistory: false, status, reason: 'already-absorbed' };
  }

  const qualifies = qualifiesForSchedule(valid);
  const next = { ...(status || {}) };
  if (!absorbed) {
    next.channels = { ...((status && status.channels) || {}) };
    next.channels[channel] = {
      receiptAt: valid.finishedAt,
      trigger: valid.trigger,
      errors: valid.stats.errors,
      // Retained separately from errors. Without it, an app-closed scheduled run that produced an
      // incomplete index reconciled into the status file as an unqualified success and the drop
      // vanished — the one case where the receipt is the ONLY record the run ever happened.
      indexDropped: indexDroppedOf(valid),
      mode: valid.mode,
      version: valid.version || null,   // observability: which build produced this run
      qualifies,
    };
  }

  // Presentation state. The tray reads ONE outcome — status.stats plus hasErrors — and this is
  // where a receipt becomes that outcome. Gated on statsAt, the timestamp the live path stamps
  // when it writes stats: without an ordering, adoption either clobbered a newer live result with
  // an older receipt, or (before this) left a stale live result in place while the channel state
  // said otherwise, so the icon and the menu could disagree — white tray, "4 missing from
  // INDEX.md" one click away. `channels[...]` above stays as the per-channel scheduling/history
  // record; it is deliberately NOT a second presentation source.
  if (isLatestOutcome) {
    next.stats = statsFromReceipt(valid);
    next.statsAt = valid.finishedAt;
    next.hasErrors = !runSucceeded(valid);
  }

  const known = parsePersistedInstant(status && status.lastSync, now);
  const advance = !absorbed && qualifies && channel === SCHEDULING_CHANNEL
    && (!known || finished > known);
  if (advance) next.lastSync = valid.finishedAt;

  // Whether the caller should append this run to the visible error history. False when the run was
  // already absorbed (a presentation backfill must not re-log an old failure) and false when the
  // live path already reported this same run — which is now detectable, because both transports
  // carry ONE completion instant, so a run's own receipt is equal to rather than later than its
  // live update.
  const recordHistory = !absorbed && isLatestOutcome && !runSucceeded(valid);

  return {
    adopt: true,
    isLatestOutcome,
    recordHistory,
    advanceLastSync: advance,
    status: next,
    reason: absorbed ? 'presentation-backfill' : (advance ? 'adopted' : 'observability-only'),
  };
}

/**
 * Is a catch-up sync warranted right now? ONE predicate for both the initial decision and the
 * re-check before a delayed launch, so the two cannot disagree. Covers daily, weekly, hourly and
 * never-synced; returns false whenever scheduling is off or the inputs are unusable, because the
 * cost of a wrong `true` is a redundant paid sync.
 */
function needsCatchUp(config, status, now = new Date()) {
  try {
    if (!config || typeof config !== 'object') return false;
    const schedule = config.schedule;
    if (!schedule || !schedule.enabled) return false;          // disabled during the delay
    if (status && status.syncing) return false;
    if (!status || !status.lastSync) return true;              // scheduling on, never synced
    const lastSync = new Date(status.lastSync);
    if (Number.isNaN(lastSync.getTime())) return false;

    const parts = String(schedule.time || '09:00').split(':').map(Number);
    const hour = Number.isFinite(parts[0]) ? parts[0] : 9;
    const minute = Number.isFinite(parts[1]) ? parts[1] : 0;
    const due = new Date(now);
    due.setHours(hour, minute, 0, 0);

    if (schedule.type === 'daily') {
      return now > due && lastSync < due;
    }
    if (schedule.type === 'weekly') {
      // Previously fell through to the hourly interval branch, so a weekly 09:00 schedule with
      // lastSync at 08:00 was flagged as missed and then cancelled an hour later.
      const days = Array.isArray(schedule.days) && schedule.days.length
        ? schedule.days.map(Number) : [1];
      if (!days.includes(now.getDay())) return false;
      return now > due && lastSync < due;
    }
    const interval = Number(schedule.interval) > 0 ? Number(schedule.interval) : 6;
    return ((now - lastSync) / 3600000) >= interval;
  } catch (e) {
    return false;
  }
}

module.exports = {
  SCHEMA, VALID_TRIGGERS, VALID_CHANNELS, VALID_MODES, SCHEDULING_CHANNEL,
  EXIT_SKIPPED_NO_WORK,
  validateReceipt, qualifiesForSchedule, completionQualifies, planReconcile, needsCatchUp,
  channelState, indexDroppedOf, runSucceeded, statsFromReceipt,
};
