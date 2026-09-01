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

// Every individual rendered string field (event name, detail, a fields KEY or value, a terminal
// summary entry, channel/trigger/kind, a problem reason/name, a writerId/producer) is capped at
// this many UTF-8 bytes, independent of the aggregate DETAIL_MAX_BYTES above.
const FIELD_MAX_BYTES = 8 * 1024;

// Per-item Problems-lens row cap (Codex R1 B4). Problems SHARE the per-item DETAIL_MAX_BYTES
// budget with the Events lens; rows past either cap are dropped and represented by one visible
// `{ kind:'truncated', dropped:n }` marker row, while `problemCount` keeps the pre-truncation
// total.
const PROBLEMS_MAX_ROWS = 500;

// listActivities returns SUMMARY DTOs only (no lens arrays). Each summary must serialize to at
// most this many bytes, so a full page is bounded at LIST_MAX * SUMMARY_MAX_BYTES (~800 KiB).
// The only free-form strings on a summary (channel/trigger/kind) are bounded to
// SUMMARY_FIELD_MAX_BYTES each so the summary cap is met by construction; SUMMARY_MAX_BYTES is
// then a guard read.js asserts, not a bound it relies on hitting.
const SUMMARY_MAX_BYTES = 4096;
const SUMMARY_FIELD_MAX_BYTES = 1024;

// Response-level (root) diagnostics cap (Codex R2 I / Ruling 39): listActivities/buildExport report
// each activity-shaped root entry that was refused (symlink/non-directory/denied) as a
// `rejected-activity` problem; past this many, the rest collapse into one visible
// `{ kind:'truncated', dropped:n }` marker so a hostile root can't inflate the response.
const ROOT_PROBLEMS_MAX = 50;

// `filter.search` is a literal substring match (never a regex), capped at this many characters.
const SEARCH_MAX = 256;

// buildExport's total output is capped at this many UTF-8 bytes; past it the text is truncated
// with a visible marker line rather than silently cut off.
const EXPORT_MAX_BYTES = 16 * 1024 * 1024;

// Task 4.3 (System section) bounds. These govern the SHARED, uncorrelated diagnostic surfaces --
// the app's log streams and the legacy `~/.config/repo-radar/status.json` -- which are not
// Activity data and are never mixed into it.

// Per-stream tail: only the LAST this-many bytes of a shared log stream are ever read (a bounded
// `readSync` from `size - SYSTEM_TAIL_MAX_BYTES`, never a whole-file read), and the returned
// `redactedTail` is re-bounded to the same number AFTER scrubbing -- masking can make text longer
// than the bytes read. A cut tail carries a visible leading marker line.
const SYSTEM_TAIL_MAX_BYTES = 64 * 1024;

// Legacy `status.json` `errorList`: the array is written newest-first, so this is the count of
// NEWEST entries returned. `total` always reports the pre-truncation length.
const STATUS_ERROR_LIST_MAX = 50;

// Legacy `status.json` `errorLog` (one appended string): the LAST this-many bytes, same leading
// marker as a stream tail.
const STATUS_ERROR_LOG_MAX_BYTES = 64 * 1024;

// `status.json` must be parsed whole to be read at all, so unlike a log stream it cannot be
// tailed -- this is the ceiling on how much will be read before the file is refused outright
// (reported as `present:false` with an `error`, never as "no legacy errors"). Generous next to a
// real status file (a repo list plus <=64 KiB of errorLog) and far below anything that could
// exhaust memory.
const STATUS_MAX_BYTES = 8 * 1024 * 1024;

// Task 5.1 (legacy `sync-*.log` adapter) bounds. These govern the PRE-CONTRACT per-run text logs
// in the same shared `~/Library/Logs/repo-radar` directory -- not Activity data either, and read
// only as opaque, clearly-marked legacy items.

// Per-log excerpt: only the LAST this-many bytes of a `sync-*.log` are ever read (a bounded
// `readSync` from `size - LEGACY_EXCERPT_MAX_BYTES`, never a whole-file read), and the returned
// excerpt is re-bounded to the same number AFTER scrubbing. A cut excerpt carries a visible
// leading marker line, exactly like a System stream tail.
const LEGACY_EXCERPT_MAX_BYTES = 16 * 1024;

// How many `sync-*.log` files are adapted per call, newest first by filename (which is a sortable
// timestamp). repo_radar/modes/sync.py rotates to the newest 10, so this is generous for a real
// installation while keeping a directory full of old logs -- from a larger historical retention,
// or planted -- from inflating a list response (at most LEGACY_MAX_FILES * LEGACY_EXCERPT_MAX_BYTES).
const LEGACY_MAX_FILES = 25;

// Valid `event.level` values, also the valid `filter.level` values.
const LEVELS = new Set(['info', 'warn', 'error']);

module.exports = {
  LIST_MAX,
  DETAIL_MAX_ROWS, DETAIL_MAX_BYTES,
  FIELD_MAX_BYTES,
  PROBLEMS_MAX_ROWS,
  ROOT_PROBLEMS_MAX,
  SUMMARY_MAX_BYTES, SUMMARY_FIELD_MAX_BYTES,
  SEARCH_MAX,
  EXPORT_MAX_BYTES,
  SYSTEM_TAIL_MAX_BYTES, STATUS_ERROR_LIST_MAX, STATUS_ERROR_LOG_MAX_BYTES, STATUS_MAX_BYTES,
  LEGACY_EXCERPT_MAX_BYTES, LEGACY_MAX_FILES,
  LEVELS,
};
