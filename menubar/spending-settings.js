'use strict';
// The Settings "Spending" values, shared by the Settings window and main's save-config handler so both
// refuse the same input before anything is written. Python enforces the same bounds on its own every sync
// (repo_radar/config.py, incremental_spending_policy and weekly_spending_policy); keep the two in step.
// Also the shape check and wording for the read-only weekly spend summary (repo_radar/spending.py).

const LIMIT_FIELD = 'incremental_update_limit_usd';
const STOP_FIELD = 'incremental_failure_stop';
const REBUILD_DAYS_FIELD = 'incremental_full_rebuild_days';
const DEFAULT_LIMIT_USD = 12;
const LIMIT_RANGE = [1, 100];          // US dollars, at most two decimal places
const DEFAULT_FAILURE_STOP = 2;
const STOP_RANGE = [1, 10];            // whole numbers; 0 is invalid, not "off"
const DEFAULT_REBUILD_DAYS = 7;
const WEEKLY_ENABLED_FIELD = 'weekly_spend_cap_enabled';
const WEEKLY_CAP_FIELD = 'weekly_spend_cap_usd';
const DEFAULT_WEEKLY_CAP_USD = 75;
const WEEKLY_CAP_RANGE = [1, 1000];    // US dollars, at most two decimal places

const MESSAGES = {
  [LIMIT_FIELD]: `Enter an amount from $${LIMIT_RANGE[0]} to $${LIMIT_RANGE[1]}, with at most two decimal places`,
  [STOP_FIELD]: `Enter a whole number from ${STOP_RANGE[0]} to ${STOP_RANGE[1]}`,
  [WEEKLY_ENABLED_FIELD]: 'Choose whether to limit weekly spending',
  [WEEKLY_CAP_FIELD]: 'Enter an amount from $1 to $1,000, with at most two decimal places',
};

// Exactly whole cents: 99.99 and 1.01 pass, 12.000000001 doesn't. Python's check is round(value, 2) == value.
function wholeCentsWithin(value, [low, high]) {
  return typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high &&
    Number(value.toFixed(2)) === value;
}

function isValidLimit(value) {
  return wholeCentsWithin(value, LIMIT_RANGE);
}

function isValidWeeklyCap(value) {
  return wholeCentsWithin(value, WEEKLY_CAP_RANGE);
}

function isValidStop(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= STOP_RANGE[0] && value <= STOP_RANGE[1];
}

// Text typed into the Settings inputs, to a number or null. Strict on purpose: no blanks, signs, exponents,
// thousands separators or parseInt/parseFloat leniency ("12abc" is not 12). Dollar amounts, the weekly cap
// included, use parseLimitInput.
function parseLimitInput(text) {
  const s = String(text == null ? '' : text).trim();
  return /^\d+(\.\d{1,2})?$/.test(s) ? Number(s) : null;
}

function parseStopInput(text) {
  const s = String(text == null ? '' : text).trim();
  return /^\d+$/.test(s) ? Number(s) : null;
}

// The first invalid spending field in a config about to be saved, as { field, message }, or null when both
// are valid. Both must be present: the Settings window always sends them.
function validateSpending(config) {
  const c = config && typeof config === 'object' ? config : {};
  if (!isValidLimit(c[LIMIT_FIELD])) return { field: LIMIT_FIELD, message: MESSAGES[LIMIT_FIELD] };
  if (!isValidStop(c[STOP_FIELD])) return { field: STOP_FIELD, message: MESSAGES[STOP_FIELD] };
  if (typeof c[WEEKLY_ENABLED_FIELD] !== 'boolean') {
    return { field: WEEKLY_ENABLED_FIELD, message: MESSAGES[WEEKLY_ENABLED_FIELD] };
  }
  if (!isValidWeeklyCap(c[WEEKLY_CAP_FIELD])) return { field: WEEKLY_CAP_FIELD, message: MESSAGES[WEEKLY_CAP_FIELD] };
  return null;
}

// What the next sync will use, for showing in Settings: a stored valid value, otherwise the default.
function effectiveSpending(config) {
  const c = config && typeof config === 'object' ? config : {};
  return {
    limitUsd: isValidLimit(c[LIMIT_FIELD]) ? c[LIMIT_FIELD] : DEFAULT_LIMIT_USD,
    failureStop: isValidStop(c[STOP_FIELD]) ? c[STOP_FIELD] : DEFAULT_FAILURE_STOP,
    weeklyEnabled: c[WEEKLY_ENABLED_FIELD] !== false,   // only a literal false turns the cap off
    weeklyCapUsd: isValidWeeklyCap(c[WEEKLY_CAP_FIELD]) ? c[WEEKLY_CAP_FIELD] : DEFAULT_WEEKLY_CAP_USD,
  };
}

// One read-only sentence about the full-rebuild age, describing the value Python will actually use;
// null when the stored value is invalid (the sync reports that itself).
function rebuildIntervalText(config) {
  const c = config && typeof config === 'object' ? config : {};
  const days = REBUILD_DAYS_FIELD in c ? c[REBUILD_DAYS_FIELD] : DEFAULT_REBUILD_DAYS;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 0) return null;
  if (days === 0) return 'Full summaries are not rebuilt on a schedule.';
  return `Full summaries are rebuilt every ${days === 1 ? 'day' : `${days} days`}.`;
}

function formatLimit(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

// ---- the weekly spend readout ------------------------------------------------------------------

const SUMMARY_STATUSES = new Set(['not_started', 'ready', 'unavailable']);

function isAmount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isInstant(value) {
  return typeof value === 'string' && value.length <= 64 && !Number.isNaN(Date.parse(value));
}

// The summary helper's JSON, reduced to exactly the aggregate fields Settings shows; anything malformed is
// unavailable. Never a ledger entry, path or error text.
function validateSummary(raw) {
  const unavailable = { status: 'unavailable' };
  if (!raw || typeof raw !== 'object' || !SUMMARY_STATUSES.has(raw.status)) return unavailable;
  if (raw.status === 'unavailable') return unavailable;
  if (typeof raw.enabled !== 'boolean' || !isAmount(raw.cap_usd) || !isInstant(raw.read_at)) return unavailable;
  const base = { status: raw.status, enabled: raw.enabled, capUsd: raw.cap_usd, readAt: raw.read_at };
  if (raw.status === 'not_started') return base;
  if (!['activated_at', 'period_start', 'period_end'].every((k) => isInstant(raw[k]))) return unavailable;
  if (typeof raw.first_period !== 'boolean' || !isAmount(raw.recorded_usd) || !isAmount(raw.reserved_usd)) {
    return unavailable;
  }
  if (raw.enabled ? !isAmount(raw.available_usd) : raw.available_usd !== null) return unavailable;
  return {
    ...base, activatedAt: raw.activated_at, firstPeriod: raw.first_period, periodStart: raw.period_start,
    periodEnd: raw.period_end, recordedUsd: raw.recorded_usd, reservedUsd: raw.reserved_usd,
    availableUsd: raw.available_usd,
  };
}

function money(value) {
  return '$' + value.toFixed(2);
}

function utcDay(iso) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

// One line for "Spend this week", from a validated summary. Remaining shows as zero when overdrawn, next to
// the actual recorded and reserved amounts.
function spendLine(summary) {
  if (!summary || summary.status === 'unavailable') return 'Spend unavailable';
  if (summary.status === 'not_started') return 'Tracking starts with the next sync';
  const when = summary.firstPeriod ? 'since ' + utcDay(summary.activatedAt) : 'for the week of ' + utcDay(summary.periodStart);
  const parts = [money(summary.recordedUsd) + ' recorded ' + when, money(summary.reservedUsd) + ' reserved/uncertain'];
  parts.push(summary.enabled ? money(summary.availableUsd) + ' available of $' + formatLimit(summary.capUsd)
    : 'Weekly limit off');
  return parts.join(' · ') + ' · resets Monday 00:00 UTC.';
}

module.exports = {
  LIMIT_FIELD, STOP_FIELD, DEFAULT_LIMIT_USD, DEFAULT_FAILURE_STOP, LIMIT_RANGE, STOP_RANGE,
  WEEKLY_ENABLED_FIELD, WEEKLY_CAP_FIELD, DEFAULT_WEEKLY_CAP_USD, WEEKLY_CAP_RANGE,
  isValidLimit, isValidStop, isValidWeeklyCap, parseLimitInput, parseStopInput, validateSpending,
  effectiveSpending, rebuildIntervalText, formatLimit, validateSummary, spendLine,
};
