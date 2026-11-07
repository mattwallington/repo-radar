'use strict';
// The Settings "Spending" values, shared by the Settings window and main's save-config handler so both
// refuse the same input before anything is written. Python enforces the same bounds on its own every sync
// (repo_radar/config.py, incremental_spending_policy); keep the two in step.

const LIMIT_FIELD = 'incremental_update_limit_usd';
const STOP_FIELD = 'incremental_failure_stop';
const REBUILD_DAYS_FIELD = 'incremental_full_rebuild_days';
const DEFAULT_LIMIT_USD = 12;
const LIMIT_RANGE = [1, 100];          // US dollars, at most two decimal places
const DEFAULT_FAILURE_STOP = 2;
const STOP_RANGE = [1, 10];            // whole numbers; 0 is invalid, not "off"
const DEFAULT_REBUILD_DAYS = 7;

const MESSAGES = {
  [LIMIT_FIELD]: `Enter an amount from $${LIMIT_RANGE[0]} to $${LIMIT_RANGE[1]}, with at most two decimal places`,
  [STOP_FIELD]: `Enter a whole number from ${STOP_RANGE[0]} to ${STOP_RANGE[1]}`,
};

function isValidLimit(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= LIMIT_RANGE[0] && value <= LIMIT_RANGE[1] &&
    Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
}

function isValidStop(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= STOP_RANGE[0] && value <= STOP_RANGE[1];
}

// Text typed into the Settings inputs, to a number or null. Strict on purpose: no blanks, signs, exponents,
// thousands separators or parseInt/parseFloat leniency ("12abc" is not 12).
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
  return null;
}

// What the next sync will use, for showing in Settings: a stored valid value, otherwise the default.
function effectiveSpending(config) {
  const c = config && typeof config === 'object' ? config : {};
  return {
    limitUsd: isValidLimit(c[LIMIT_FIELD]) ? c[LIMIT_FIELD] : DEFAULT_LIMIT_USD,
    failureStop: isValidStop(c[STOP_FIELD]) ? c[STOP_FIELD] : DEFAULT_FAILURE_STOP,
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

module.exports = {
  LIMIT_FIELD, STOP_FIELD, DEFAULT_LIMIT_USD, DEFAULT_FAILURE_STOP, LIMIT_RANGE, STOP_RANGE,
  isValidLimit, isValidStop, parseLimitInput, parseStopInput, validateSpending, effectiveSpending,
  rebuildIntervalText, formatLimit,
};
