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
  return receipt;
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

function channelState(status, channel) {
  const channels = (status && status.channels) || {};
  return channels[channel] || {};
}

/**
 * Decide what a receipt changes. Returns { adopt, advanceLastSync, status, reason }.
 * Pure: never mutates its inputs.
 */
function planReconcile(receipt, status, opts = {}) {
  const { channel = SCHEDULING_CHANNEL, now = new Date() } = opts;
  const valid = validateReceipt(receipt, { channel, now });
  if (!valid) return { adopt: false, advanceLastSync: false, status, reason: 'invalid' };

  const finished = new Date(valid.finishedAt);
  const prior = channelState(status, channel).receiptAt;
  const seenAt = prior ? new Date(prior) : null;
  if (seenAt && !(finished > seenAt)) {
    return { adopt: false, advanceLastSync: false, status, reason: 'already-absorbed' };
  }

  const qualifies = qualifiesForSchedule(valid);
  const next = { ...(status || {}) };
  next.channels = { ...((status && status.channels) || {}) };
  next.channels[channel] = {
    receiptAt: valid.finishedAt,
    trigger: valid.trigger,
    errors: valid.stats.errors,
    mode: valid.mode,
    version: valid.version || null,   // observability: which build produced this run
    qualifies,
  };

  const known = status && status.lastSync ? new Date(status.lastSync) : null;
  const advance = qualifies && channel === SCHEDULING_CHANNEL && (!known || finished > known);
  if (advance) next.lastSync = valid.finishedAt;

  return {
    adopt: true,
    advanceLastSync: advance,
    status: next,
    reason: advance ? 'adopted' : 'observability-only',
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
  validateReceipt, qualifiesForSchedule, planReconcile, needsCatchUp, channelState,
};
