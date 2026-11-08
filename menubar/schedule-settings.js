'use strict';
// The Settings "Automatic Sync" values, checked before Save so a schedule the LaunchAgent can't run is
// refused inline, on its own field, instead of being quietly replaced (an empty time used to become 09:00)
// or written as is (an interval outside 1 to 24 hours).

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const INTERVAL_RANGE = [1, 24];
const DEFAULT_INTERVAL = 6;

// Whole hours typed in the interval field, or NaN.
function parseIntervalInput(text) {
  const t = String(text == null ? '' : text).trim();
  return /^\d+$/.test(t) ? Number(t) : NaN;
}

// The first problem with an enabled schedule as { input, message }, where `input` is the Settings element
// to mark, or null. A disabled schedule is never checked: nothing runs it.
function validateSchedule(schedule) {
  const s = schedule && typeof schedule === 'object' ? schedule : {};
  if (!s.enabled) return null;
  if (s.type === 'hourly') {
    const n = s.interval;
    if (!Number.isInteger(n) || n < INTERVAL_RANGE[0] || n > INTERVAL_RANGE[1]) {
      return { input: 'schedule-interval', message: `Enter a whole number of hours from ${INTERVAL_RANGE[0]} to ${INTERVAL_RANGE[1]}` };
    }
    return null;
  }
  const weekly = s.type === 'weekly';
  if (weekly && !(Array.isArray(s.days) && s.days.length)) {
    return { input: 'schedule-days', message: 'Select at least one day for weekly sync' };
  }
  if (!TIME_RE.test(String(s.time || ''))) {
    return { input: weekly ? 'schedule-weekly-time' : 'schedule-time', message: 'Enter a time for the sync' };
  }
  return null;
}

// The schedule as written once validateSchedule passed. An interval that isn't a whole number then belongs
// to a frequency nothing runs (hidden, or the schedule is off), and is stored as the default 6, never null.
function savedSchedule(schedule) {
  return { ...schedule, interval: Number.isInteger(schedule.interval) ? schedule.interval : DEFAULT_INTERVAL };
}

module.exports = { parseIntervalInput, validateSchedule, savedSchedule, INTERVAL_RANGE };
