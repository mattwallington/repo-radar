'use strict';
// Task 3.6: read/export bound constants (spec §8, task-3.6-brief.md's "Concrete bounds"). Every
// bound the reader enforces lives here, exactly once, so read.js and Task 4.1's IPC handler share
// the same numbers rather than each hardcoding a copy that could drift.
//
// IMPORTANT for tests: these are exported as plain properties on this module's object, not as
// `const` bindings a consumer destructures. read.js therefore always reads `limits.LIST_MAX` (etc)
// through the shared module object at call time, never a value captured once at require-time --
// that is what lets a test monkeypatch a bound (e.g. `limits.LIST_MAX = 2`) and have read.js
// observe the new value on its very next call, mirroring how the quota/retention tests reach into
// a sibling module's constants (see read.test.js's `truncated` and `EXPORT_MAX_BYTES` tests).

// Item-list page size: listActivities never returns more than this many item summaries in one
// call; `truncated:true` signals more exist beyond it.
const LIST_MAX = 200;

// Per-item Events-lens bounds: a single activity's rendered event rows stop at whichever of these
// two caps is hit first (row count vs. cumulative rendered bytes); further rows are dropped and
// the item's `truncatedEvents` flag is set.
const DETAIL_MAX_ROWS = 2000;
const DETAIL_MAX_BYTES = 2 * 1024 * 1024;

// Every individual rendered string field (event name, detail, a fields value, a problem reason)
// is capped at this many UTF-8 bytes, independent of the aggregate DETAIL_MAX_BYTES above.
const FIELD_MAX_BYTES = 8 * 1024;

// `filter.search` is a literal substring match (never a regex), capped at this many characters.
const SEARCH_MAX = 256;

// buildExport's total output is capped at this many UTF-8 bytes; past it the text is truncated
// with a visible marker line rather than silently cut off.
const EXPORT_MAX_BYTES = 16 * 1024 * 1024;

// Valid `event.level` values, also the valid `filter.level` values.
const LEVELS = new Set(['info', 'warn', 'error']);

module.exports = {
  LIST_MAX,
  DETAIL_MAX_ROWS, DETAIL_MAX_BYTES,
  FIELD_MAX_BYTES,
  SEARCH_MAX,
  EXPORT_MAX_BYTES,
  LEVELS,
};
