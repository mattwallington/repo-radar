// Pure reconciliation decision for run receipts. Importable, so tests exercise THIS code
// rather than a copy — a mirrored implementation in the test file stays green even if the real
// function returns early or changes semantics, which is the same blind spot that let a
// synthesis fix ship as dead code.
//
// Two watermarks, deliberately:
//   lastSync          — monotonic. Only ever moves forward, because it drives the missed-sync
//                       decision and rewinding it would cause redundant paid syncs.
//   lastRunReceiptAt  — the newest receipt already absorbed. Needed separately because Python
//                       writes its receipt just before exit and Electron then stamps a NEWER
//                       lastSync for an app-launched run; comparing observability against
//                       lastSync alone would therefore discard the receipt and never record the
//                       trigger or error count for ordinary runs.

const SCHEMA = 2;
const VALID_TRIGGERS = ['scheduled', 'catchup', 'manual', 'cli'];
const VALID_CHANNELS = ['stable', 'dev'];
const SCHEDULE_TRIGGERS = ['scheduled', 'catchup'];

function isIsoString(value) {
  if (typeof value !== 'string' || !value) return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
}

/** Type-validate a parsed receipt. Returns the receipt or null — never throws. */
function validateReceipt(receipt, { channel = 'stable', now = new Date() } = {}) {
  if (!receipt || typeof receipt !== 'object') return null;
  if (receipt.schema !== SCHEMA) return null;
  if (receipt.completed !== true) return null;
  if (receipt.channel !== channel) return null;                       // never cross channels
  if (!VALID_CHANNELS.includes(receipt.channel)) return null;
  if (!VALID_TRIGGERS.includes(receipt.trigger)) return null;
  if (typeof receipt.qualifiesForSchedule !== 'boolean') return null;
  if (!isIsoString(receipt.finishedAt)) return null;
  if (new Date(receipt.finishedAt) > now) return null;                // clock skew / tampering
  const stats = receipt.stats;
  if (!stats || typeof stats !== 'object') return null;
  if (!Number.isInteger(stats.errors)) return null;
  return receipt;
}

/**
 * Decide what a receipt should change in status.
 * Returns { adopt, advanceLastSync, status, reason } and never mutates its input.
 */
function planReconcile(receipt, status, opts = {}) {
  const { channel = 'stable', now = new Date() } = opts;
  const valid = validateReceipt(receipt, { channel, now });
  if (!valid) return { adopt: false, advanceLastSync: false, status, reason: 'invalid' };

  const finished = new Date(valid.finishedAt);
  const seenAt = status && status.lastRunReceiptAt ? new Date(status.lastRunReceiptAt) : null;
  if (seenAt && !(finished > seenAt)) {
    return { adopt: false, advanceLastSync: false, status, reason: 'already-absorbed' };
  }

  const next = { ...(status || {}) };
  // Observability updates on any newer receipt, even one older than lastSync — that is the
  // ordinary app-launched case and it should still record how the run was triggered.
  next.lastRunReceiptAt = valid.finishedAt;
  next.lastRunTrigger = valid.trigger;
  next.lastRunErrors = valid.stats.errors;
  next.lastRunChannel = valid.channel;
  next.lastRunMode = valid.mode || 'full';
  next.lastRunQualifies = valid.qualifiesForSchedule;

  // lastSync is what suppresses the schedule, so only a run that actually did the scheduled
  // work may advance it. A partial run (--skip-metadata etc.) completed, but not the job the
  // schedule exists to perform.
  const known = status && status.lastSync ? new Date(status.lastSync) : null;
  const advance = valid.qualifiesForSchedule && (!known || finished > known);
  if (advance) next.lastSync = valid.finishedAt;

  return {
    adopt: true,
    advanceLastSync: advance,
    status: next,
    reason: advance ? 'adopted' : 'observability-only',
  };
}

/** True when a completed run stands in for a scheduled occurrence. */
function satisfiesSchedule(receipt) {
  return Boolean(receipt && receipt.qualifiesForSchedule
    && SCHEDULE_TRIGGERS.includes(receipt.trigger));
}

module.exports = {
  SCHEMA, VALID_TRIGGERS, VALID_CHANNELS, SCHEDULE_TRIGGERS,
  validateReceipt, planReconcile, satisfiesSchedule,
};
