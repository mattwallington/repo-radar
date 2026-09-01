'use strict';
// Task 5.1: the OPAQUE legacy `sync-*.log` adapter.
//
// Before Activity History there was one history surface: a directory of per-run text logs written
// by repo_radar/modes/sync.py's `SyncLogger` --
//     ~/Library/Logs/repo-radar/sync-<YYYY-MM-DD>T<HH-MM-SS>.log
// (`_open_sync_logger`, `datetime.now().strftime("%Y-%m-%dT%H-%M-%S")`), rotated to the newest 10
// by `_rotate_sync_logs`. Each line is `[HH:MM:SS] event_name k=v k=v`, with an indented block of
// up to 8 stderr lines under an error.
//
// This module makes those files VISIBLE without pretending they are activities.
//
// Ruling P5-1 -- what a legacy item IS. One file becomes ONE self-contained summary DTO flagged
// `legacy: true`, with id `legacy:sync-<ISO>` derived from the filename. That id is NEVER sent to
// `activity:get`/`activity:reveal`, is never a deep-link target, and is not (and can never be) a
// valid activity id -- `ids.validActivityId` is untouched, as is every other path-safety
// validator. Nothing here is correlated to a durable activity, and no identity is reconstructed:
// the DTO carries everything the renderer needs INLINE (reconstructed timestamps, derived counts,
// and a bounded, redacted excerpt), so clicking one costs no bridge call at all.
//
// Ruling P5-2 -- what a legacy item is NOT. Legacy items are excluded from `viewErrorsTarget` and
// `_scanActivity` (they carry no reconciled outcome, so there is no incident to open), they never
// affect `available`/`incomplete`/quota/accounting (their files live OUTSIDE `activity/`, and the
// quota accounting is about the store), and read.js merges them into the item list by
// reconstructed timestamp before the LIST_MAX slice.
//
// Three postures, all inherited from system.js -- whose primitives are SHARED here, not copied:
//   1. NEVER FOLLOW A SYMLINK, ON ANY COMPONENT. `system.validateDir` walks every directory
//      component below `home` with O_RDONLY|O_NOFOLLOW|O_DIRECTORY, and `system.readTailFile`
//      opens the file itself O_NOFOLLOW + fstat + S_ISREG. A symlinked log DIRECTORY yields no
//      items at all; a symlinked (or non-regular) `sync-*.log` yields a VISIBLE, contentless item
//      carrying `error: 'symlink'` (or 'not-regular'/'denied'/...) -- a refusal the user can see,
//      rather than a file that silently disappears from a history view.
//   2. NEVER READ A WHOLE FILE. Only the last `limits.LEGACY_EXCERPT_MAX_BYTES` are read, the
//      partial first line of a cut window is dropped, and the excerpt BODY is re-bounded to the
//      same number AFTER scrubbing (masking can make text longer). A cut excerpt carries the same
//      one-line `--- tail truncated at ... ---` marker a System stream tail does, on top of the
//      bounded body, and marks the item `incomplete` -- because the counts below are then counts
//      over what was READ, not over the whole file.
//   3. REDACTION IS DEFENSE-IN-DEPTH. The excerpt goes through the same `redact.Redactor` built
//      from `opts.configuredSecrets` that every other reader path uses, on top of redact.js's
//      built-in credential patterns.
//
// NEVER USE UNVALIDATED TEXT IN A PATH. Filenames come from a readdir of the ALREADY-VALIDATED log
// directory and must match `LEGACY_FILENAME_RE` (below) -- a fully anchored, fixed-width,
// digits-only pattern with no `.`, `/` or `..` anywhere in it -- AND parse as a real calendar
// date/time, before the file is opened at all.
//
// Containment: `legacyItems` NEVER throws. Every failure (no home, no log directory, a refused
// component, an unreadable file, a garbage argument) is either an empty list or a bounded `error`
// on the one item it belongs to.
const fs = require('fs');
const path = require('path');
const redactMod = require('./redact');
const systemMod = require('./system'); // the shared safe-open + bounded-tail primitives
const limits = require('./limits'); // read as `limits.FOO` at call time (never destructured) so a
// test monkeypatching a bound is observed immediately -- see limits.js's own header comment.

// -------------------------------------------------------------------------------------------
// The filename contract.
//
// EXACTLY the shape `_open_sync_logger` writes: `sync-` + `%Y-%m-%dT%H-%M-%S` + `.log`, all
// digits, fixed width, fully anchored. (JS `$` without the `m` flag does not match before a
// trailing newline, so `"sync-...log\n"` is rejected too -- the same property ids.js relies on.)
// Deliberately stricter than the brief's sketch: no `:` (the filename uses `-` in the TIME too),
// no `.` beyond the extension, and therefore no way for `..`, a separator, or any other traversal
// token to appear in a name this module hands to `path.join`.
//
// It also excludes, by construction, the four SHARED streams that live in the same directory and
// belong to the System section instead (`sync.log`, `sync.error.log`, `menubar.log`,
// `renderer.log`): none of them starts with `sync-`.
const LEGACY_FILENAME_RE = /^sync-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})\.log$/;

// One log line, as SyncLogger writes it: `[HH:MM:SS] event_name k=v ...`. An INDENTED continuation
// line (the stderr block under an error) does not match, which is deliberate -- see `_deriveLevel`.
const RECORD_LINE_RE = /^\[(\d{2}):(\d{2}):(\d{2})\]\s+(\S+)/;

// -------------------------------------------------------------------------------------------
// Level derivation -- FOR LEGACY DATA ONLY (Ruling P5-1).
//
// These files predate the `level` field entirely: nothing in them states a severity, so any level
// here is INFERRED, and inferred only for this legacy surface. Nothing else in the subsystem
// derives a level -- durable activities carry a source-owned one on every record.
//
// The rule, in full:
//   * only a RECORD LINE is classified (one starting `[HH:MM:SS] `). The indented stderr block
//     under an error belongs to the record above it; classifying those lines too counted a single
//     failure up to nine times.
//   * classification looks at the EVENT NAME ONLY -- the token right after the timestamp -- never
//     at the whole line. `sync_complete total=3 errors=1` is a routine completion line whose
//     FIELDS mention errors; matching the line would have made every successful run an error.
//   * error names: the ones sync.py actually emits through `SyncLogger.error` (`clone_failed`,
//     `fetch_failed`, `pull_failed`, `metadata_failed`, `repo_exception`) plus `sync_aborted`,
//     matched loosely enough to catch names that no longer exist in the tree.
//   * warn names: `metadata_degraded` and the retry/timeout family.
//   * a line containing `⚠` counts as a warning if it is not already an error -- the marker the
//     app's own status writer uses for a degraded condition.
//   * error wins over warn; a line matching neither counts as neither.
// Counts are over the EXCERPT (the bounded tail), which is why a truncated excerpt also marks the
// item `incomplete`: they describe what was read, and the item says so.
const LEGACY_ERROR_NAME_RE = /error|fail|fatal|exception|abort|denied/i;
const LEGACY_WARN_NAME_RE = /warn|degrade|retry|timeout|stale/i;

function _deriveLevel(line, name) {
  if (LEGACY_ERROR_NAME_RE.test(name)) return 'error';
  if (LEGACY_WARN_NAME_RE.test(name) || line.includes('⚠')) return 'warn';
  return null;
}

// -------------------------------------------------------------------------------------------
// Timestamp reconstruction.
//
// The filename carries a COMPLETE local wall-clock stamp (Python's `datetime.now()`), so it -- not
// the first `[HH:MM:SS]` line -- is the run's start: it is always present, has full date
// precision, and is what the file's own existence records. (The first line time can only be equal
// or later, and reading it would mean reading the HEAD of a file this module only ever tails.)
//
// The end comes from the LAST record line in the excerpt, dated by the filename's date.
//
// MIDNIGHT ROLLOVER, and the assumption chosen: line times are time-of-day only, so a run that
// crossed midnight ends at a smaller clock time than it started. When the last line's time-of-day
// is EARLIER than the filename's, exactly ONE day is added. That is right for every run under 24
// hours and wrong for anything longer -- a sync is minutes, and no other reading of a bare
// `[HH:MM:SS]` is available. A DST transition inside the run shifts the reconstructed duration by
// an hour for the same reason; both timestamps are naive local wall-clock, exactly as written.
//
// The emitted strings are NAIVE local ISO (`2026-08-14T09:31:05`, no offset): that is what the
// producer meant, and `new Date(...)`/`Date.parse` read an offset-less date-time as LOCAL, so the
// renderer's `formatTime` prints back the same wall clock the Python process saw, and read.js's
// `_sortKey` places it on the same absolute axis as a durable activity's `ts`.
function _pad2(n) {
  return String(n).padStart(2, '0');
}

function _naiveIso(d) {
  return `${d.getFullYear()}-${_pad2(d.getMonth() + 1)}-${_pad2(d.getDate())}`
    + `T${_pad2(d.getHours())}:${_pad2(d.getMinutes())}:${_pad2(d.getSeconds())}`;
}

// The filename's stamp as a real local Date, or null when the digits are not a real calendar
// date/time (`sync-2026-13-45T99-99-99.log` matches the shape and is still not a date). The
// round-trip check is what rejects an overflowing component -- JS `Date` silently normalizes
// month 13 into the next January.
function _dateFromName(m) {
  const [Y, M, D, h, mi, s] = m.slice(1, 7).map((v) => Number(v));
  const d = new Date(Y, M - 1, D, h, mi, s, 0);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getFullYear() !== Y || d.getMonth() !== M - 1 || d.getDate() !== D
    || d.getHours() !== h || d.getMinutes() !== mi || d.getSeconds() !== s) return null;
  return d;
}

// -------------------------------------------------------------------------------------------
// One file -> one DTO.
// -------------------------------------------------------------------------------------------

// Walk the excerpt once: derived counts + the last record line's time-of-day.
function _scanExcerpt(text) {
  let errorCount = 0;
  let warnCount = 0;
  let last = null;
  for (const line of String(text).split('\n')) {
    const m = RECORD_LINE_RE.exec(line);
    if (!m) continue;
    last = { h: Number(m[1]), m: Number(m[2]), s: Number(m[3]) };
    const level = _deriveLevel(line, m[4]);
    if (level === 'error') errorCount += 1;
    else if (level === 'warn') warnCount += 1;
  }
  return { errorCount, warnCount, last };
}

function _buildItem(name, match, excerpt) {
  const started = _dateFromName(match);
  const startedAt = _naiveIso(started);
  const scan = _scanExcerpt(excerpt.text);

  let endedAt = null;
  let duration = null;
  if (scan.last) {
    const startOfDaySeconds = started.getHours() * 3600 + started.getMinutes() * 60 + started.getSeconds();
    const endSeconds = scan.last.h * 3600 + scan.last.m * 60 + scan.last.s;
    const rollover = endSeconds < startOfDaySeconds ? 1 : 0; // crossed midnight -- see the note above
    const end = new Date(started.getFullYear(), started.getMonth(), started.getDate() + rollover,
      scan.last.h, scan.last.m, scan.last.s, 0);
    if (!Number.isNaN(end.getTime())) {
      endedAt = _naiveIso(end);
      duration = end.getTime() - started.getTime();
    }
  }

  const item = {
    // `legacy:sync-<ISO>`, derived from the filename. NOT an activity id, and never used as one:
    // it is a stable identity for the renderer's own selection bookkeeping and nothing else.
    id: `legacy:sync-${startedAt}`,
    legacy: true,
    // Nothing in these files records a verdict, so none is claimed. 'unknown' is the same word the
    // reader uses for a durable activity whose outcome could not be established, and the renderer
    // already maps it to the grey dot.
    outcome: 'unknown',
    startedAt,
    endedAt,
    duration,
    // `channel` says where the item came from; `trigger` is genuinely unrecorded; `kind` is 'sync'
    // because only `sync_mode` ever wrote a `sync-*.log`.
    channel: 'legacy',
    trigger: 'unknown',
    kind: 'sync',
    errorCount: scan.errorCount,
    warnCount: scan.warnCount,
    problemCount: scan.errorCount + scan.warnCount,
    hasProblems: scan.errorCount + scan.warnCount > 0,
    // A cut excerpt or a refused file means the view of this run is partial -- the same flag the
    // chip already renders. It is an ITEM-level flag only: read.js never lets a legacy item set
    // the RESPONSE-level `incomplete`, which is a statement about the durable store.
    incomplete: excerpt.truncated || Boolean(excerpt.reason),
    synthesized: false,
    // Display-only, and provably safe: the name matched LEGACY_FILENAME_RE, so it is ASCII digits
    // and the fixed literals. No absolute path ever crosses the bridge (ipc.js invariant 3).
    source: name,
    excerpt: excerpt.text,
    excerptTruncated: excerpt.truncated,
  };
  if (excerpt.reason) item.error = excerpt.reason;
  return item;
}

// -------------------------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------------------------

// `home` is the user's home directory (main.js/ipc.js pass process.env.HOME); `opts` takes the
// same `configuredSecrets` as every other reader entry point. Returns newest-first, at most
// `limits.LEGACY_MAX_FILES` items. NEVER throws.
function legacyItems(home, { configuredSecrets = [] } = {}) {
  if (typeof home !== 'string' || home.length === 0) return [];

  let redactor;
  try {
    redactor = new redactMod.Redactor(configuredSecrets);
  } catch (e) {
    return []; // without a redactor NOTHING may be read -- the same rule system.js states
  }

  try {
    // Every directory component, O_NOFOLLOW: a symlinked `~/Library/Logs/repo-radar` must not hand
    // us attacker-chosen "history". A refused directory yields NO items -- and is not silently
    // lost either: the System section reports that same refusal on all four of its streams.
    const logs = systemMod.validateDir(home, systemMod.LOG_SUBPATH);
    if (!logs.dir) return [];

    let names;
    try {
      names = fs.readdirSync(logs.dir);
    } catch (e) {
      return [];
    }

    // Newest first: the filename stamp is fixed-width, so lexical order IS chronological order.
    // Sorting BEFORE the cap means the cap drops the oldest logs, never the newest.
    const candidates = [];
    for (const name of names) {
      const m = LEGACY_FILENAME_RE.exec(name);
      if (!m) continue; // not a per-run log (a shared stream, a near-miss, anything at all)
      if (_dateFromName(m) === null) continue; // shape matched, not a real date/time
      candidates.push({ name, m });
    }
    candidates.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    const kept = candidates.slice(0, Math.max(0, limits.LEGACY_MAX_FILES));

    const items = [];
    for (const { name, m } of kept) {
      // The name is validated ABOVE; this is the only place a path is built from it.
      const tail = systemMod.readTailFile(path.join(logs.dir, name),
        limits.LEGACY_EXCERPT_MAX_BYTES, redactor);
      const excerpt = tail.present
        ? { text: tail.text, truncated: tail.truncated, reason: null }
        // A refusal is an item with NO content and a bounded reason ('symlink' / 'not-regular' /
        // 'denied' / 'gone' / 'read-failed'), so a file we would not follow is visible as a
        // refusal rather than as an absence. 'absent' (the file vanished between the readdir and
        // the open) is ordinary and skipped entirely.
        : { text: '', truncated: false, reason: tail.reason === 'absent' ? null : tail.reason };
      if (!tail.present && excerpt.reason === null) continue;
      items.push(_buildItem(name, m, excerpt));
    }
    return items;
  } catch (e) {
    // Containment, and a FIXED answer: an unexpected failure above cannot be described without
    // quoting an error message that routinely carries the user's absolute home path.
    return [];
  }
}

module.exports = { legacyItems, LEGACY_FILENAME_RE };
