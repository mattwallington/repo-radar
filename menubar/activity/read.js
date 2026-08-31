'use strict';
// Task 3.6: read.js -- the Phase-3 reader capstone. Composes parse.js (Task 3.1) + merge.js
// (Task 3.2) + reconcile.js (Task 3.3) + redact.js (Task 2.2c) into bounded, already-redacted,
// reader-facing DTOs. `main` (Task 4.1) calls `listActivities` (summaries), `getActivity` (one
// full detail item) and `buildExport`; the renderer only ever sees the DTOs this module returns,
// never raw segment bytes.
//
// Ruling B (carried over from every sibling module): read.js never deletes/mutates/truncates
// committed data. The only writes it can cause are the synthetic-terminal appends already
// sanctioned INSIDE reconcile.js/synthesizeTerminal (called per-activity below, before that
// activity's segments are read) -- this file itself performs no fs write of any kind.
//
// Redaction is defense-in-depth (spec §4): EVERY user- or filesystem-derived string that reaches
// a DTO or the export text -- event names, `detail`, `fields` keys AND values, terminal
// `summary`, channel/trigger/kind, problem reasons, and every filename-derived string (writerId,
// producer, a rejected entry's name) -- is run through a SINGLE `redact.Redactor` built once per
// call from `opts.configuredSecrets`, then bounded to `limits.FIELD_MAX_BYTES`, before it is
// returned. Nothing here ever hands back an un-redacted or unbounded string (Codex R1 B3/B4).
//
// Summary vs detail (Codex R1 B4 / Ruling 35): `listActivities` returns SUMMARY DTOs only (no
// lens arrays, each <= limits.SUMMARY_MAX_BYTES); `getActivity` returns ONE full detail item
// (summary fields + Events lens + Problems lens + duplicateTerminals) never larger than
// limits.DETAIL_MAX_BYTES. `buildExport` iterates detail items under EXPORT_MAX_BYTES.
//
// Lifecycle honesty (Codex R1 B2 / Ruling 34): `running` is emitted ONLY for a valid `start`
// with no terminal (spec §3). A directory with no records, no rejected entries and no reconcile
// problems is a live reserve-before-start and is NOT an Activity item at all (skipped). Anything
// else without a valid start is `unknown` + an integrity problem + `incomplete`.
//
// Problem-bearing (Codex R1 B1 / Ruling 33): `isProblemBearing` mirrors quota.py's
// `is_problem_bearing` exactly (shared fixture: repo_radar/tests/data/problem_bearing_vectors.json,
// exercised by __tests__/problem-bearing.test.js). The Problems lens carries every warn/error
// event, every failure-like terminal (with its `summary` -- that's where a blocked/failed reason
// lives), every integrity record/finding, and the reconcile-level problems.
const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const parseMod = require('./parse');
const mergeMod = require('./merge');
const redactMod = require('./redact');
const reconcileMod = require('./reconcile'); // referenced as `reconcileMod.reconcile` at call
// time (never destructured) so a test can inject a failing reconcile by monkeypatching the
// module export -- the I3 failure-injection seam.
const idsMod = require('./ids');
const systemMod = require('./system'); // Task 4.3: the SHARED, uncorrelated diagnostic surfaces
// (log-stream tails + the legacy status.json error surface). Split into its own module -- they
// are not Activity data and share none of this file's assembly -- and re-exported here so the
// reader facade stays the single door Task 4.1's IPC handler calls.
const limits = require('./limits'); // referenced as `limits.FOO` at call sites throughout (never
// destructured) so a test monkeypatching a bound (`limits.LIST_MAX = 2`) is observed immediately --
// see limits.js's own header comment.

class InvalidFilter extends Error {}
// A malformed activity id passed to `getActivity`. Subclasses InvalidFilter so Task 4.1's IPC
// handler can reject BOTH caller-input failures with a single `instanceof InvalidFilter` check.
class InvalidActivityId extends InvalidFilter {}

// -------------------------------------------------------------------------------------------
// Shared PROBLEM-BEARING predicate (Ruling 33, redefined over a SCAN by Ruling 37 / Codex R2 B2).
// Byte-for-byte the same rule as quota.py's `is_problem_bearing`, pinned by the shared v2 fixture
// (`{ records, findings, rejected }` per case). Over ONE activity's scan, true iff ANY of:
//   (a) an `event` record with level in {warn, error};
//   (b) a `terminal` record with outcome in {failed, blocked, interrupted,
//       succeeded-with-warnings} (succeeded / cancelled / skipped are routine);
//   (c) an `integrity` record;
//   (d) any integrity FINDING (parse/reconcile-level: corrupt line, unsupported schema, seq
//       regression, terminal conflict, no-start, probe/view uncertainty ...);
//   (e) any REJECTED entry (symlink / non-regular / denied / gone / dir-unreadable, AND a
//       non-conforming `bad-name` entry -- the reader refused it, so the view is degraded);
//   (f) >= 2 terminal records (an exact duplicate OR a conflict -- either is a writer anomaly).
// Pure: scan in, bool out; no filesystem, no redaction. `_buildItem` feeds it the SAME inputs
// that populate the Problems lens, so `hasProblems` and the lens agree by construction (Codex's
// R2 repro: two identical `succeeded` terminals used to yield hasProblems:false + an empty lens
// while `duplicateTerminals` said otherwise). A bare records ARRAY is still accepted (treated as
// `{ records }`) for the older call shape.
// -------------------------------------------------------------------------------------------
const PROBLEM_EVENT_LEVELS = new Set(['warn', 'error']);
const PROBLEM_OUTCOMES = new Set(['failed', 'blocked', 'interrupted', 'succeeded-with-warnings']);

function isProblemBearing(scan) {
  if (Array.isArray(scan)) scan = { records: scan };
  if (!scan || typeof scan !== 'object') return false;
  const records = Array.isArray(scan.records) ? scan.records : [];
  const findings = Array.isArray(scan.findings) ? scan.findings : [];
  const rejected = Array.isArray(scan.rejected) ? scan.rejected : [];
  if (findings.length > 0) return true; // (d)
  if (rejected.length > 0) return true; // (e)
  let terminals = 0;
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    if (r.type === 'event' && PROBLEM_EVENT_LEVELS.has(r.level)) return true; // (a)
    if (r.type === 'terminal') {
      if (PROBLEM_OUTCOMES.has(r.outcome)) return true; // (b)
      terminals += 1;
    }
    if (r.type === 'integrity') return true; // (c)
  }
  return terminals >= 2; // (f)
}

// -------------------------------------------------------------------------------------------
// Filter validation (brief: "throws a typed error ... Task 4.1's IPC handler will call it to
// REJECT (not silently clamp) a bad filter"). Every public entry point calls this; an
// empty/omitted filter is valid (no filtering, default paging).
// -------------------------------------------------------------------------------------------
function validateFilter(filter = {}) {
  if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) {
    throw new InvalidFilter('filter must be an object');
  }
  if (filter.level !== undefined && !limits.LEVELS.has(filter.level)) {
    throw new InvalidFilter(`invalid level: ${JSON.stringify(filter.level)}`);
  }
  if (filter.search !== undefined) {
    if (typeof filter.search !== 'string') {
      throw new InvalidFilter('search must be a string');
    }
    if (filter.search.length > limits.SEARCH_MAX) {
      throw new InvalidFilter(`search exceeds ${limits.SEARCH_MAX} characters`);
    }
  }
  if (filter.limit !== undefined) {
    if (typeof filter.limit !== 'number' || !Number.isInteger(filter.limit) || filter.limit < 0) {
      throw new InvalidFilter('limit must be a non-negative integer');
    }
    if (filter.limit > limits.LIST_MAX) {
      throw new InvalidFilter(`limit exceeds ${limits.LIST_MAX}`);
    }
  }
  if (filter.offset !== undefined) {
    if (typeof filter.offset !== 'number' || !Number.isInteger(filter.offset) || filter.offset < 0) {
      throw new InvalidFilter('offset must be a non-negative integer');
    }
  }
  return true;
}

// -------------------------------------------------------------------------------------------
// Small pure helpers (UTF-8-safe truncation, mirrors records.js's private `_utf8SafePrefix` --
// not exported there, so reimplemented here at the same small scope, matching this codebase's
// existing precedent of each module owning its own copy of these tiny primitives).
// -------------------------------------------------------------------------------------------
function _utf8SafeSlice(buf, n) {
  n = Math.max(0, Math.min(n, buf.length));
  let end = n;
  for (let back = 1; back <= 3 && end - back >= 0; back++) {
    const b = buf[end - back];
    if ((b & 0xc0) === 0x80) continue; // continuation byte -- keep scanning back
    let seqLen;
    if ((b & 0x80) === 0x00) seqLen = 1;
    else if ((b & 0xe0) === 0xc0) seqLen = 2;
    else if ((b & 0xf0) === 0xe0) seqLen = 3;
    else if ((b & 0xf8) === 0xf0) seqLen = 4;
    else seqLen = 1;
    if (seqLen > back) end -= back; // incomplete sequence at the tail -> drop it
    break;
  }
  return buf.slice(0, end);
}

// Bound a rendered string to `maxBytes` UTF-8 bytes, marking truncation visibly. Used for every
// string placed on a DTO (limits.FIELD_MAX_BYTES) and for the export text as a whole
// (limits.EXPORT_MAX_BYTES, with its own caller-supplied marker).
function _boundStr(s, maxBytes, marker = '…[truncated]') {
  if (typeof s !== 'string') return { value: s, truncated: false };
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return { value: s, truncated: false };
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const keepBytes = Math.max(0, maxBytes - markerBytes);
  const kept = _utf8SafeSlice(buf, keepBytes).toString('utf8');
  return { value: kept + marker, truncated: true };
}

// The one path every returned string takes: scrub, then bound. `null`/`undefined` pass through
// (a field that is absent stays absent); anything else is stringified first so a non-string
// never bypasses redaction.
function _safeStr(v, redactor, maxBytes = limits.FIELD_MAX_BYTES) {
  if (v === null || v === undefined) return null;
  return _boundStr(redactor.scrub(String(v)), maxBytes).value;
}

function _bytesOf(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

// -------------------------------------------------------------------------------------------
// The three store states (Round-3 #9). `paths.listOwnedSubdirs` swallows BOTH a missing dir and
// an unreadable one into `[]`, so this module does its own explicit probe of the activity ROOT
// (`path.dirname(paths.quotaDir(home))`, per the task brief) before ever calling it.
// -------------------------------------------------------------------------------------------
function _activityRoot(home) {
  return path.dirname(paths.quotaDir(home));
}

// Review R1 / I2: `lstatSync` (never `statSync`) so a symlinked root is seen AS a symlink rather
// than silently followed to whatever it points at -- matching the O_NOFOLLOW posture everywhere
// else in paths.js and spec §2's "reject any target that exists as a non-directory or symlink."
// A symlinked (or otherwise non-directory) root is reported UNREADABLE (`available:false`), never
// available-empty -- a symlink swapped in for the real root must never be misreported as ordinary
// first-run empty history. Only a genuinely ABSENT path (`ENOENT`) is "missing" (normal empty
// history); every other stat failure (EACCES on an ancestor, etc) is "unreadable" too.
function _probeRoot(base) {
  let st;
  try {
    st = fs.lstatSync(base);
  } catch (e) {
    return e.code === 'ENOENT' ? 'missing' : 'unreadable';
  }
  if (st.isSymbolicLink()) return 'unreadable'; // never follow -- see comment above
  if (!st.isDirectory()) return 'unreadable'; // e.g. a plain file squatting on the path
  try {
    fs.readdirSync(base);
  } catch (e) {
    return 'unreadable'; // EACCES/EIO/etc -- store exists but can't be enumerated
  }
  return 'ok';
}

// -------------------------------------------------------------------------------------------
// Segment filename contract (Codex R1 B3). A segment is `${producer}-${writerId}.jsonl` with
// producer in paths.js's PRODUCERS and writerId an 8-hex token (ids.validToken). Anything else
// is NOT parsed as a segment: it becomes a `rejected-segment` problem with reason `bad-name`
// (name scrubbed + bounded) and marks the item incomplete. Previously the last '-'-delimited
// component was copied into `writerId` unvalidated, so `python-s3cr3t.jsonl` leaked "s3cr3t"
// into the DTO and the export.
//
// paths.js keeps PRODUCERS private, so rather than copy the enum here (and let it drift) a
// candidate name is validated by ROUND-TRIPPING it through `paths.segmentPath` -- the single
// authority on segment naming, which throws for an unknown producer -- and requiring the
// resulting basename to equal the name exactly.
// -------------------------------------------------------------------------------------------
const _SEGMENT_NAME_RE = /^([a-z]+)-([0-9a-f]{8})\.jsonl$/;

function _parseSegmentName(home, aid, name) {
  const m = _SEGMENT_NAME_RE.exec(name);
  if (!m) return null;
  const producer = m[1];
  const writerId = m[2];
  if (!idsMod.validToken(writerId)) return null;
  try {
    if (path.basename(paths.segmentPath(home, aid, producer, writerId)) !== name) return null;
  } catch (e) {
    return null; // UnsafePath: unknown producer
  }
  return { producer, writerId };
}

// The exact `parse.js` integrity finding kinds (its own header comment enumerates them) -- used
// below to avoid double-counting: reconcile()'s own `problems` array already includes every
// parse-integrity finding from ITS internal (pre-synthesis) read, and this function does its own
// FRESH read afterward (to pick up a just-synthesized terminal) that collects the same findings
// again. Only reconcile()'s own RECONCILE-SPECIFIC problems (probe-uncertain, terminal-conflict,
// synthesize-raced, internal-error, settle-failed -- all prefixed `reconcile-`) are merged in from
// `rec.problems`; the parse-level kinds are taken exclusively from this function's own fresh scan.
const _PARSE_INTEGRITY_KINDS = new Set(parseMod.FINDING_KINDS); // corrupt-record | unsupported-schema | seq-regression

// Reconcile-level problem kinds that mean "this item's state could not be fully established" and
// therefore mark the item (and the response) `incomplete` (Codex R1 B2).
const _INCOMPLETE_RECONCILE_KINDS = new Set([
  'reconcile-probe-uncertain', 'reconcile-internal-error', 'reconcile-synthesize-raced',
  'reconcile-settle-failed',
  'reconcile-view-uncertain', // Ruling 38: a conforming segment was unreadable; no verdict inferred
]);

// Redact + bound one flat primitive map (`fields` on an event, `summary` on a terminal). Both
// KEYS and string values are scrubbed and bounded (Codex R1 B3: a configured secret used as a
// field key previously reached the DTO and export untouched). Numbers/bools/null pass through
// unchanged, matching records.js's own flat-primitive contract.
function _renderFields(fields, redactor) {
  const out = {};
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return out;
  for (const [k, v] of Object.entries(fields)) {
    const key = _safeStr(k, redactor);
    if (typeof v === 'string') {
      out[key] = _safeStr(v, redactor);
    } else if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
      out[key] = v;
    } else {
      out[key] = _safeStr(JSON.stringify(v), redactor); // never a nested object on a DTO
    }
  }
  return out;
}

function _renderEvent(r, redactor) {
  return {
    ts: r.ts,
    seq: r.seq,
    level: r.level,
    writerId: r.writerId,
    producer: r.producer,
    event: _safeStr(r.event, redactor),
    detail: _safeStr(r.detail, redactor),
    fields: _renderFields(r.fields, redactor),
  };
}

// Redact + bound + filter (level/search) the `event` records into the Events-lens row list,
// capped at DETAIL_MAX_ROWS rows AND `byteBudget` cumulative rendered bytes (the per-item
// DETAIL_MAX_BYTES budget, less whatever the Problems lens already consumed) -- whichever limit
// is hit first stops further rows and sets `truncated`. Returns the per-row byte sizes too so the
// whole-item fitting pass can drop rows without re-measuring the entire item each time.
function _buildEventsLens(rawEvents, filter, redactor, byteBudget) {
  const rows = [];
  const sizes = [];
  let truncated = false;
  let totalBytes = 0;

  for (const r of rawEvents) {
    const row = _renderEvent(r, redactor);

    if (filter.level && r.level !== filter.level) continue;
    if (filter.search) {
      const haystack = `${row.event}\n${row.detail || ''}\n${JSON.stringify(row.fields)}`;
      if (!haystack.includes(filter.search)) continue;
    }

    const rowBytes = _bytesOf(row);
    if (rows.length >= limits.DETAIL_MAX_ROWS || totalBytes + rowBytes > byteBudget) {
      truncated = true;
      break;
    }
    totalBytes += rowBytes;
    rows.push(row);
    sizes.push(rowBytes);
  }

  return { rows, sizes, truncated, bytes: totalBytes };
}

// A parse/reconcile integrity FINDING (not a record) rendered as a Problems-lens row. Provenance
// (`writerId`/`producer`) is attached when the finding came from a named segment.
function _renderFinding(p, redactor, prov) {
  const out = {
    kind: p && p.kind ? _safeStr(p.kind, redactor) : 'unknown',
    reason: p && p.reason != null ? _safeStr(p.reason, redactor) : undefined,
  };
  if (p && typeof p.index === 'number') out.index = p.index;
  if (prov) {
    out.writerId = prov.writerId;
    out.producer = prov.producer;
  }
  return out;
}

// Problems lens (Codex R1 B1): structural/integrity problems first (few, and the most important
// to keep under truncation), then record-derived rows in merged order. Capped at
// PROBLEMS_MAX_ROWS rows and `byteBudget` bytes; anything dropped is represented by ONE visible
// `{ kind:'truncated', dropped:n }` marker row. `total` is the pre-truncation count (the item's
// `problemCount`).
//
// Terminals are GROUPED per outcome (Ruling 37 / spec §6 "exact-dup terminals grouped w/ count"):
// ONE `{ kind:'terminal', outcome, count, ts, by, summary, ... }` row per failure-like outcome,
// carrying the FIRST (merged-order) terminal's ts/seq/summary/provenance and a `count` of how
// many terminals recorded that outcome -- exact duplicates are folded into `count`, never
// rendered individually. `by` is the first terminal's `by`; when the duplicates disagree on `by`
// it is the list of distinct values instead (bounded), so a two-writer anomaly stays visible.
// Independently, ANY outcome recorded >= 2 times (routine outcomes included -- two `succeeded`
// terminals are still a writer anomaly) adds one structural `{ kind:'duplicate-terminal',
// outcome, count }` row; conflicting outcomes keep reconcile()'s `reconcile-terminal-conflict`
// row. Both count toward `problemCount`/`hasProblems`, matching predicate rule (f).
const _DUP_BY_MAX = 16;

function _groupTerminals(merged, redactor) {
  const groups = new Map(); // outcome -> { first, count, bys: [distinct scrubbed by, bounded] }
  for (const r of merged) {
    if (r.type !== 'terminal') continue;
    const outcome = String(r.outcome);
    let g = groups.get(outcome);
    if (!g) {
      g = { first: r, count: 0, bys: [] };
      groups.set(outcome, g);
    }
    g.count += 1;
    const by = _safeStr(r.by, redactor);
    if (!g.bys.includes(by) && g.bys.length < _DUP_BY_MAX) g.bys.push(by);
  }
  const duplicates = [];
  const rows = new Map(); // first terminal record -> rendered row (emitted at its merged position)
  for (const [outcome, g] of groups) {
    if (g.count >= 2) duplicates.push({ kind: 'duplicate-terminal', outcome: _safeStr(outcome, redactor), count: g.count });
    if (!PROBLEM_OUTCOMES.has(outcome)) continue;
    rows.set(g.first, {
      kind: 'terminal',
      outcome: _safeStr(outcome, redactor),
      count: g.count,
      ts: g.first.ts,
      seq: g.first.seq,
      by: g.bys.length === 1 ? g.bys[0] : g.bys,
      summary: _renderFields(g.first.summary, redactor),
      writerId: g.first.writerId,
      producer: g.first.producer,
    });
  }
  return { duplicates, rows };
}

function _buildProblemsLens(structural, merged, redactor, byteBudget) {
  const { duplicates, rows: terminalRows } = _groupTerminals(merged, redactor);
  const candidates = structural.concat(duplicates);
  for (const r of merged) {
    if (r.type === 'event' && PROBLEM_EVENT_LEVELS.has(r.level)) {
      candidates.push(Object.assign({ kind: 'event' }, _renderEvent(r, redactor)));
    } else if (r.type === 'terminal') {
      const row = terminalRows.get(r); // only the FIRST terminal of a failure-like outcome has one
      if (row) candidates.push(row);
    } else if (r.type === 'integrity') {
      candidates.push({
        kind: 'integrity',
        reason: _safeStr(r.kind, redactor),
        detail: _safeStr(r.detail, redactor),
        ts: r.ts,
        seq: r.seq,
        writerId: r.writerId,
        producer: r.producer,
      });
    }
  }

  const rows = [];
  const sizes = [];
  let totalBytes = 0;
  let dropped = 0;
  for (const c of candidates) {
    const bytes = _bytesOf(c);
    if (dropped > 0 || rows.length >= limits.PROBLEMS_MAX_ROWS || totalBytes + bytes > byteBudget) {
      dropped += 1;
      continue;
    }
    rows.push(c);
    sizes.push(bytes);
    totalBytes += bytes;
  }
  return { rows, sizes, dropped, total: candidates.length, bytes: totalBytes };
}

// Marker row appended to the Problems lens when rows were dropped. Kept tiny and fixed-shape so
// its own byte cost is always affordable.
function _truncationMarker(dropped) {
  return { kind: 'truncated', dropped };
}

// Whole-item cap (Codex R1 B4): the assembled detail item must never exceed DETAIL_MAX_BYTES.
// Drops trailing events first, then trailing problems (maintaining the visible markers), using
// the per-row sizes to estimate progress and re-measuring the real serialized item after each
// pass, until it fits. Mutates `item` in place.
function _fitItem(item, eventSizes, problemSizes, problemsDropped) {
  const max = limits.DETAIL_MAX_BYTES;
  let dropped = problemsDropped;
  let measured = _bytesOf(item);
  for (let guard = 0; measured > max && guard < 64; guard++) {
    let excess = measured - max;
    while (excess > 0 && item.events.length > 0) {
      item.events.pop();
      excess -= eventSizes.pop() + 1;
      item.truncatedEvents = true;
    }
    while (excess > 0 && problemSizes.length > 0) {
      // The marker (if any) is always the last row; strip it, drop a real row, re-add it below.
      if (dropped > 0) item.problems.pop();
      item.problems.pop();
      excess -= problemSizes.pop() + 1;
      dropped += 1;
      item.problems.push(_truncationMarker(dropped));
    }
    measured = _bytesOf(item);
    if (item.events.length === 0 && problemSizes.length === 0) break;
  }
  if (measured > max) {
    // Only the fixed summary fields + a marker row remain; every string among them is already
    // FIELD_MAX_BYTES-bounded, so this is unreachable at the shipped constants. Fail closed
    // rather than return an over-budget item.
    item.events = [];
    item.truncatedEvents = true;
    item.problems = [_truncationMarker(item.problemCount)];
  }
  return dropped;
}

// -------------------------------------------------------------------------------------------
// Per-activity assembly.
// -------------------------------------------------------------------------------------------

// Everything a caller can learn about one activity, split into the SUMMARY (what listActivities
// returns per item) and the lenses only getActivity/buildExport hand back.
function _summaryOf(full) {
  return {
    id: full.id,
    outcome: full.outcome,
    startedAt: full.startedAt,
    endedAt: full.endedAt,
    duration: full.duration,
    // Re-bounded tighter than the detail item's FIELD_MAX_BYTES so a summary meets
    // SUMMARY_MAX_BYTES by construction (see limits.js).
    channel: _boundStr(full.channel, limits.SUMMARY_FIELD_MAX_BYTES).value,
    trigger: _boundStr(full.trigger, limits.SUMMARY_FIELD_MAX_BYTES).value,
    kind: _boundStr(full.kind, limits.SUMMARY_FIELD_MAX_BYTES).value,
    errorCount: full.errorCount,
    warnCount: full.warnCount,
    problemCount: full.problemCount,
    hasProblems: full.hasProblems,
    incomplete: full.incomplete,
    synthesized: full.synthesized,
  };
}

// Guard the summary contract (SUMMARY_MAX_BYTES). channel/trigger/kind are the only free-form
// strings on a summary and are already bounded to SUMMARY_FIELD_MAX_BYTES; if a summary is
// STILL over budget something structural changed, so squeeze those three hard rather than ever
// hand back an over-budget summary.
function _boundSummary(summary) {
  if (_bytesOf(summary) <= limits.SUMMARY_MAX_BYTES) return summary;
  for (const k of ['channel', 'trigger', 'kind']) {
    summary[k] = _boundStr(summary[k], 64).value;
  }
  if (_bytesOf(summary) > limits.SUMMARY_MAX_BYTES) {
    throw new Error('activity summary exceeds SUMMARY_MAX_BYTES after bounding'); // caller bug
  }
  return summary;
}

// Build one activity's full detail item. Step order matters (task brief's Phase-3 gate):
// `reconcile()` runs FIRST -- performing the read-triggered reconciliation, possibly appending a
// durable synthetic terminal for a crashed `running` attempt -- and only THEN are this activity's
// segments read for DTO assembly, so a just-synthesized terminal is already visible in `merged`.
//
// Returns `null` when the directory is a live reserve-before-start (no segments, no rejected
// entries, no reconcile problems): a producer has been admitted but hasn't written `start` yet,
// so there is nothing to show as history (Codex R1 B2). Every other state yields an item.
function _buildItem(home, aid, filter, redactor) {
  const rec = reconcileMod.reconcile(home, aid);

  const structural = []; // integrity-class problems, rendered
  let incomplete = false;
  let mtime = 0;
  const perSegment = [];

  const { segments, rejected } = paths.readOwnedSegmentsDetailed(paths.activityDir(home, aid));
  let dirUnreadable = false;
  for (const rj of rejected) {
    if (rj.reason === 'dir-unreadable') dirUnreadable = true;
    structural.push({
      kind: 'rejected-segment',
      name: _safeStr(rj.name, redactor),
      reason: _safeStr(rj.reason, redactor),
    });
    incomplete = true;
  }

  // Everything the reader REFUSED, for the predicate -- the detailed read's rejections plus every
  // bad-name entry below (Ruling 37 rule (e)): the same list the lens renders as rejected-segment.
  const rejectedAll = rejected.map((rj) => ({ name: rj.name, reason: rj.reason }));
  let badNames = 0;
  for (const seg of segments) {
    const prov = _parseSegmentName(home, aid, seg.name);
    if (prov === null) {
      structural.push({ kind: 'rejected-segment', name: _safeStr(seg.name, redactor), reason: 'bad-name' });
      rejectedAll.push({ name: seg.name, reason: 'bad-name' });
      incomplete = true;
      badNames += 1;
      continue; // never parsed: an unvalidated name is not a segment
    }
    if (seg.mtime > mtime) mtime = seg.mtime;
    const { records: recs, integrity } = parseMod.parseSegment(seg.data, aid);
    if (integrity.length > 0) incomplete = true;
    for (const finding of integrity) structural.push(_renderFinding(finding, redactor, prov));
    perSegment.push(recs.map((r) => Object.assign({}, r, prov)));
  }
  const merged = mergeMod.mergeHeads(perSegment);

  for (const p of rec.problems || []) {
    const kind = String((p && p.kind) || '');
    if (_PARSE_INTEGRITY_KINDS.has(kind)) continue; // already represented by the fresh scan above
    structural.push(_renderFinding(p, redactor, null));
    if (_INCOMPLETE_RECONCILE_KINDS.has(kind)) incomplete = true;
  }

  const startRecord = merged.find((r) => r.type === 'start') || null;
  const terminalRecord = merged.find((r) => r.type === 'terminal') || null;

  // Reserve-before-start: nothing on disk yet beyond the directory itself -- not history.
  if (segments.length === 0 && rejected.length === 0 && structural.length === 0 && rec.outcome === null) {
    return null;
  }

  // Lifecycle (spec §3, Ruling 34): a reconciled terminal outcome wins; otherwise `running`
  // ONLY with a valid start; otherwise the state is genuinely unknown and says so.
  let outcome;
  if (!startRecord) {
    outcome = 'unknown';
    structural.push({
      kind: 'integrity',
      reason: 'no-start',
      detail: dirUnreadable
        ? 'activity directory could not be read'
        : (badNames > 0 && merged.length === 0
          ? 'no valid start record (only unparseable segment names present)'
          : 'no valid start record found'),
    });
    incomplete = true;
  } else if (rec.outcome !== null && rec.outcome !== undefined) {
    outcome = String(rec.outcome);
  } else if ((rec.problems || []).some((p) => p && p.kind === 'reconcile-view-uncertain')) {
    // View-uncertain (Ruling 38) vs. probe-uncertain (spec §5): a VIEW uncertainty means a
    // conforming segment or the directory itself could not be read, so whether a terminal exists
    // is UNPROVEN -- 'running' would assert "no terminal", which we cannot establish here. A
    // PROBE uncertainty (the `else` branch below, start present, no terminal readable, only
    // owner liveness unconfirmed) stays 'running' per spec §5.
    outcome = 'unknown';
  } else {
    outcome = 'running';
  }

  const startedAt = startRecord ? startRecord.ts : null;
  const endedAt = terminalRecord ? terminalRecord.ts : null;
  let duration = null;
  if (startedAt && endedAt) {
    const s = Date.parse(startedAt);
    const e = Date.parse(endedAt);
    if (Number.isFinite(s) && Number.isFinite(e)) duration = e - s;
  }

  let errorCount = 0;
  let warnCount = 0;
  const rawEvents = [];
  for (const r of merged) {
    if (r.type !== 'event') continue;
    if (r.level === 'error') errorCount += 1;
    else if (r.level === 'warn') warnCount += 1;
    rawEvents.push(r);
  }

  // Problems get first claim on the per-item byte budget (they are the diagnostics the lens
  // exists for, and are row-capped at PROBLEMS_MAX_ROWS); events take the remainder.
  const problemsLens = _buildProblemsLens(structural, merged, redactor, limits.DETAIL_MAX_BYTES);
  const eventsLens = _buildEventsLens(
    rawEvents, filter, redactor, Math.max(0, limits.DETAIL_MAX_BYTES - problemsLens.bytes),
  );

  // Ruling 37: the SAME scan the lens was built from -- merged records, every structural finding
  // (parse integrity, reconcile-level, no-start) and every rejected entry (incl. bad-name) -- is
  // what the shared predicate sees, so `hasProblems` can never disagree with the lens: each rule
  // (a)-(f) corresponds to at least one candidate row above, and vice versa.
  const hasProblems = isProblemBearing({ records: merged, findings: structural, rejected: rejectedAll });

  const duplicateTerminals = Object.entries(rec.duplicateTerminalCounts || {})
    .filter(([, count]) => count > 1)
    .map(([dupOutcome, count]) => ({ outcome: _safeStr(dupOutcome, redactor), count }));

  const problems = problemsLens.rows.slice();
  if (problemsLens.dropped > 0) problems.push(_truncationMarker(problemsLens.dropped));

  const item = {
    id: aid,
    outcome,
    startedAt,
    endedAt,
    duration,
    // records.js only enum-constrains `kind` -- `channel`/`trigger` are producer-supplied
    // strings, so they are scrubbed AND bounded exactly like every other rendered string.
    channel: startRecord ? _safeStr(startRecord.channel, redactor) : null,
    trigger: startRecord ? _safeStr(startRecord.trigger, redactor) : null,
    kind: startRecord ? _safeStr(startRecord.kind, redactor) : null,
    errorCount,
    warnCount,
    problemCount: problemsLens.total,
    hasProblems,
    incomplete,
    synthesized: Boolean(rec.synthesized),
    events: eventsLens.rows,
    truncatedEvents: eventsLens.truncated,
    duplicateTerminals,
    problems,
  };

  _fitItem(item, eventsLens.sizes, problemsLens.sizes, problemsLens.dropped);

  return { item, mtime };
}

// I3 (Codex R1): per-activity assembly is contained. An unexpected exception from reconcile(),
// a segment read, or DTO assembly becomes an `unknown` item carrying an `internal-error`
// problem (message scrubbed + bounded) and marked incomplete -- it never escapes to the caller.
// Only caller bugs (invalid filter/id) throw, and those are rejected before this is reached.
function _safeBuildItem(home, aid, filter, redactor) {
  try {
    return _buildItem(home, aid, filter, redactor);
  } catch (e) {
    const message = _safeStr((e && e.message) || String(e), redactor);
    return {
      mtime: 0,
      item: {
        id: aid,
        outcome: 'unknown',
        startedAt: null,
        endedAt: null,
        duration: null,
        channel: null,
        trigger: null,
        kind: null,
        errorCount: 0,
        warnCount: 0,
        problemCount: 1,
        hasProblems: true,
        incomplete: true,
        synthesized: false,
        events: [],
        truncatedEvents: false,
        duplicateTerminals: [],
        problems: [{ kind: 'internal-error', reason: message }],
      },
    };
  }
}

function _sortKey(entry) {
  const t = entry.item.startedAt ? Date.parse(entry.item.startedAt) : NaN;
  if (Number.isFinite(t)) return t;
  return (entry.mtime || 0) * 1000; // mtime is in seconds (paths.js); scale to the same ms axis
}

// Enumerate + assemble every valid activity under `home` as full detail items, unbounded by
// LIST_MAX/offset/limit -- the shared core listActivities (which then summarizes + pages) and
// buildExport (which does not) build on. Never throws for a data/IO condition.
//
// Codex R2 I / Ruling 39: an activity-shaped ROOT entry that is not a real directory (a
// valid-UUID symlink, a plain file, an lstat-denied entry) is never followed -- but it must not
// vanish either. Each becomes a response-level `{ kind:'rejected-activity', id, reason }`
// diagnostic in `problems` (bounded to ROOT_PROBLEMS_MAX plus one `truncated` marker) and marks
// the response incomplete, so "clean empty history" is never reported over a root someone has
// tampered with. `getActivity(id)` on such an entry keeps returning `item:null`/`unreadable`.
function _collectItems(home, filter, redactor) {
  const base = _activityRoot(home);
  const state = _probeRoot(base);
  if (state === 'missing') return { items: [], available: true, incomplete: false, problems: [] };
  if (state === 'unreadable') return { items: [], available: false, incomplete: false, problems: [] };

  const { subdirs, rejected } = paths.listOwnedSubdirsDetailed(base);
  const aids = subdirs.filter((name) => name !== 'quota' && idsMod.validActivityId(name));

  const problems = [];
  for (const rj of rejected) {
    if (problems.length >= limits.ROOT_PROBLEMS_MAX) {
      problems.push(_truncationMarker(rejected.length - limits.ROOT_PROBLEMS_MAX));
      break;
    }
    problems.push({
      kind: 'rejected-activity',
      id: _safeStr(rj.name, redactor),
      reason: _safeStr(rj.reason, redactor),
    });
  }

  let incomplete = problems.length > 0;
  const entries = [];
  for (const aid of aids) {
    const built = _safeBuildItem(home, aid, filter, redactor);
    if (built === null) continue; // reserve-before-start: not history yet
    entries.push(built);
    if (built.item.incomplete) incomplete = true;
  }
  entries.sort((a, b) => _sortKey(b) - _sortKey(a));
  return { items: entries.map((e) => e.item), available: true, incomplete, problems };
}

// -------------------------------------------------------------------------------------------
// Task 4.4 / Ruling P4-14: the SUMMARY-ONLY scan.
//
// `_buildItem` above is the expensive path: it renders every event and every problem row through
// the Redactor, bounds each string, assembles a detail DTO and then measures it. `listActivities`
// pays that for EVERY activity in the store before it sorts and slices -- `filter.limit` bounds
// the page it returns, never the work it does -- which is fine for the window (someone asked to
// look at history) and far too expensive for a tray menu.
//
// This derives the same three facts `viewErrorsTarget` needs -- ordering key, lifecycle outcome,
// problem-bearing yes/no -- from the same inputs, and stops there. It still runs `reconcile`
// FIRST (that is what derives `outcome`, and it is the read-triggered reconciliation the spec
// requires) and still does the same fresh parse, but it renders NOTHING: no Redactor, no lens, no
// DTO, no byte measurement. `isProblemBearing` only cares whether the findings/rejected lists are
// non-EMPTY, so this counts them instead of building rows -- the predicate sees the same scan and
// therefore returns the same answer as the item the window would show.
//
// Returns `null` for a live reserve-before-start directory (same rule, same place in the order as
// `_buildItem`'s): a producer has been admitted but has not written `start` yet, so it is not
// history and must not be offered as an incident.
function _scanActivity(home, aid) {
  const rec = reconcileMod.reconcile(home, aid);

  let structuralCount = 0; // what `_buildItem` would have RENDERED into `structural`
  let mtime = 0;
  const perSegment = [];

  const { segments, rejected } = paths.readOwnedSegmentsDetailed(paths.activityDir(home, aid));
  structuralCount += rejected.length;

  for (const seg of segments) {
    const prov = _parseSegmentName(home, aid, seg.name);
    if (prov === null) {
      structuralCount += 1; // rendered as a `rejected-segment` row over there
      continue; // never parsed: an unvalidated name is not a segment
    }
    if (seg.mtime > mtime) mtime = seg.mtime;
    const { records: recs, integrity } = parseMod.parseSegment(seg.data, aid);
    structuralCount += integrity.length;
    // The provenance copy stays even though nothing here renders it: `mergeHeads` tie-breaks
    // equal timestamps on `record.writerId`, so dropping it would give this scan a different
    // interleave from `_buildItem`'s -- and parity with the item the window shows is the whole
    // contract of this path.
    perSegment.push(recs.map((r) => Object.assign({}, r, prov)));
  }
  const merged = mergeMod.mergeHeads(perSegment);

  for (const p of rec.problems || []) {
    if (_PARSE_INTEGRITY_KINDS.has(String((p && p.kind) || ''))) continue; // already counted above
    structuralCount += 1;
  }

  const startRecord = merged.find((r) => r.type === 'start') || null;

  // Reserve-before-start, checked at exactly the point `_buildItem` checks it (before the
  // no-start finding below would inflate `structuralCount`).
  if (segments.length === 0 && rejected.length === 0 && structuralCount === 0 && rec.outcome === null) {
    return null;
  }

  let outcome;
  if (!startRecord) {
    outcome = 'unknown';
    structuralCount += 1; // the `no-start` integrity finding
  } else if (rec.outcome !== null && rec.outcome !== undefined) {
    outcome = String(rec.outcome);
  } else if ((rec.problems || []).some((p) => p && p.kind === 'reconcile-view-uncertain')) {
    outcome = 'unknown';
  } else {
    outcome = 'running';
  }

  // Rules (d) findings and (e) rejected are "is the list non-empty", so `structuralCount` is the
  // whole of what the predicate would have learned from the rendered rows -- every entry
  // `_buildItem` pushes into `structural` has a counterpart increment above, and every rejected
  // entry (including a bad segment name) is counted with it. Rules (a)/(b)/(c)/(f) are read off
  // the merged records directly, by the same shared predicate.
  const problemBearing = structuralCount > 0
    || isProblemBearing({ records: merged, findings: [], rejected: [] });

  // The same ordering key `_sortKey` gives `listActivities`, so "newest" means the same thing in
  // both places: the start timestamp, falling back to segment mtime (seconds -> ms).
  const started = startRecord && startRecord.ts ? Date.parse(startRecord.ts) : NaN;
  const sortKey = Number.isFinite(started) ? started : (mtime || 0) * 1000;

  return { id: aid, outcome, problemBearing, sortKey };
}

// Same containment posture as `_safeBuildItem`: an unexpected throw from reconcile, a segment
// read or the parse becomes an `unknown`, PROBLEM-BEARING entry rather than escaping -- an
// activity the reader cannot scan is exactly the kind of thing the user should be able to open.
function _safeScanActivity(home, aid) {
  try {
    return _scanActivity(home, aid);
  } catch (e) {
    return { id: aid, outcome: 'unknown', problemBearing: true, sortKey: 0 };
  }
}

// -------------------------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------------------------

// Summary DTOs only (no `events`/`problems`/`duplicateTerminals`), each <= SUMMARY_MAX_BYTES,
// at most LIST_MAX per call. NOTE (Ruling P4-14) that `offset`/`limit` page the RESULT, not the
// work: `_collectItems` below assembles a full detail item for every activity in the store before
// this slices, so the cost of any call here is the whole store. That is the right trade for the
// window (someone asked to look at history) and the wrong one for a background poll --
// `viewErrorsTarget` has its own summary-only path for that. `filter.level`/`filter.search` are
// validated here but only affect the Events lens (getActivity/buildExport); they never remove
// items from the list. The
// response-level `problems` array (Ruling 39) holds root diagnostics that belong to no item --
// `[]` when there are none.
function listActivities(home, filter = {}, { configuredSecrets = [] } = {}) {
  validateFilter(filter);
  const redactor = new redactMod.Redactor(configuredSecrets);
  const { items, available, incomplete, problems } = _collectItems(home, filter, redactor);

  if (!available) {
    return { items: [], truncated: false, available: false, incomplete: false, problems: [] };
  }

  const offset = filter.offset || 0;
  const limit = Math.min(filter.limit !== undefined ? filter.limit : limits.LIST_MAX, limits.LIST_MAX);
  const sliced = items.slice(offset, offset + limit).map((full) => _boundSummary(_summaryOf(full)));
  const truncated = offset + sliced.length < items.length;

  return { items: sliced, truncated, available, incomplete, problems };
}

// One full detail item (summary fields + Events lens + Problems lens + duplicateTerminals),
// never larger than DETAIL_MAX_BYTES. `filter.level`/`filter.search` filter the Events lens.
//
// Contract: a malformed `activityId` THROWS `InvalidActivityId` (an InvalidFilter subclass) --
// it is caller input, exactly like a bad filter, and Task 4.1's handler rejects it the same way.
// Every data/IO condition instead returns `{ item: null, available, reason }`:
//   reason 'unavailable'  -- the activity root is unreadable (available:false)
//   reason 'missing'      -- no such activity directory (ENOENT)
//   reason 'unreadable'   -- the path exists but is not a real directory (symlink/file/EACCES)
//   reason 'not-started'  -- a live reserve-before-start directory (not history yet)
function getActivity(home, activityId, { configuredSecrets = [], filter = {} } = {}) {
  if (!idsMod.validActivityId(activityId)) {
    throw new InvalidActivityId('invalid activity id');
  }
  validateFilter(filter);
  const redactor = new redactMod.Redactor(configuredSecrets);

  const state = _probeRoot(_activityRoot(home));
  if (state === 'unreadable') return { item: null, available: false, reason: 'unavailable' };
  if (state === 'missing') return { item: null, available: true, reason: 'missing' };

  let st;
  try {
    st = fs.lstatSync(paths.activityDir(home, activityId));
  } catch (e) {
    return { item: null, available: true, reason: e.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    return { item: null, available: true, reason: 'unreadable' };
  }

  const built = _safeBuildItem(home, activityId, filter, redactor);
  if (built === null) return { item: null, available: true, reason: 'not-started' };
  return { item: built.item, available: true };
}

function _describeProblem(p) {
  switch (p.kind) {
    case 'event': {
      const suffix = p.detail ? ` -- ${p.detail}` : '';
      const fields = p.fields && Object.keys(p.fields).length > 0 ? `  fields: ${JSON.stringify(p.fields)}` : '';
      return `[event] [${p.ts}] ${String(p.level || '').toUpperCase()} ${p.event}${suffix}${fields}`;
    }
    case 'terminal': {
      const summary = p.summary && Object.keys(p.summary).length > 0 ? `  summary: ${JSON.stringify(p.summary)}` : '';
      const by = Array.isArray(p.by) ? p.by.join(', ') : p.by;
      const count = p.count > 1 ? ` x${p.count}` : '';
      return `[terminal] [${p.ts}] ${p.outcome}${count} by ${by}${summary}`;
    }
    case 'duplicate-terminal':
      return `[duplicate-terminal] ${p.outcome} recorded ${p.count} times`;
    case 'rejected-segment':
      return `[rejected-segment] ${p.reason}: ${p.name || '(directory)'}`;
    case 'rejected-activity':
      return `[rejected-activity] ${p.reason}: ${p.id}`;
    case 'truncated':
      return `[truncated] ${p.dropped} further problem(s) not shown`;
    default: {
      const detail = p.detail ? ` -- ${p.detail}` : '';
      const where = typeof p.index === 'number' ? ` (line ${p.index})` : '';
      return `[${p.kind}] ${p.reason || ''}${detail}${where}`;
    }
  }
}

// Indent a multi-line block (a stream tail, a stack trace) so it reads as the body of the line
// above it rather than as new top-level content. Every line here is already scrubbed and bounded.
function _indent(text, pad) {
  return String(text).split('\n').map((line) => `${pad}${line}`);
}

// The trailing System section of an export. Takes the diagnostics object systemDiagnostics
// returned (never re-reads anything itself) and appends its lines to `lines`.
function _appendSystemSection(lines, diag) {
  // One blank line before the header, however the items section ended (each item already ends
  // with one; the "no activity recorded" case does not).
  if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
  lines.push('--- System (uncorrelated diagnostics) ---');
  lines.push('Shared app log streams and the legacy status file. These are NOT tied to any');
  lines.push('activity above and are not time-correlated with them.');
  if (diag.error) {
    // A diagnostics-level failure means nothing below was established -- so nothing below is
    // printed. "(not present)" under a failed collection would be a claim this payload cannot
    // support, and an export is exactly where such a claim would outlive its context.
    lines.push(`(diagnostics unavailable: ${diag.error})`);
    lines.push('');
    return;
  }
  lines.push('');

  for (const s of diag.streams) {
    const demand = s.onDemand ? '  (on demand)' : '';
    if (!s.present) {
      lines.push(`[stream] ${s.name}  (not present${s.error ? `: ${s.error}` : ''})${demand}`);
      lines.push('');
      continue;
    }
    lines.push(`[stream] ${s.name}  ${s.path}  ${s.bytes} bytes${s.truncated ? '  (tail truncated)' : ''}${demand}`);
    if (s.redactedTail) lines.push(..._indent(s.redactedTail.replace(/\n$/, ''), '  '));
    else lines.push('  (empty)');
    lines.push('');
  }

  const st = diag.statusDiagnostics;
  lines.push(`[status] ${systemMod.STATUS_DISPLAY_PATH}`);
  if (!st.present) {
    lines.push(`  (not present${st.error ? `: ${st.error}` : ''})`);
    return;
  }
  // Present, but a field in it was malformed: say so, and let it suppress the "(empty)" / "errors:
  // 0" lines below -- over a field that could not be read those are claims, not observations.
  if (st.error) lines.push(`  (partial: ${st.error})`);
  if (st.errorLog.text) {
    lines.push(`  errorLog${st.errorLog.truncated ? ' (truncated)' : ''}:`);
    lines.push(..._indent(st.errorLog.text.replace(/\n$/, ''), '    '));
  } else if (!st.error) {
    lines.push('  errorLog: (empty)');
  }
  if (st.errorList.entries.length > 0 || !st.error) {
    lines.push(st.errorList.truncated
      ? `  errors: ${st.errorList.entries.length} of ${st.errorList.total} shown (newest first)`
      : `  errors: ${st.errorList.total}`);
  }
  for (const e of st.errorList.entries) {
    lines.push(`  [${e.timestamp || '(no timestamp)'}] ${e.repo || '(no repo)'} -- ${e.message || ''}`);
    if (e.fullError) lines.push(..._indent(e.fullError, '      '));
    if (e.stackTrace) lines.push(..._indent(e.stackTrace, '      '));
  }
}

// Renders the same reconciled+redacted detail items as a stable, human-readable text document.
// Never reads renderer input -- `filter`/`opts` are the only inputs, exactly like listActivities.
// Ignores LIST_MAX item paging (that bound is about a single IPC response's item-summary count;
// an export is a deliberate full-history dump), enforcing only the total-byte cap instead.
function buildExport(home, filter = {}, { configuredSecrets = [] } = {}) {
  validateFilter(filter);
  const redactor = new redactMod.Redactor(configuredSecrets);
  const { items, available, incomplete, problems } = _collectItems(home, filter, redactor);

  const lines = [];
  lines.push('Repo Radar Activity Export');
  lines.push(`generated: ${new Date().toISOString()}`);
  lines.push(`available: ${available}`);
  lines.push(`incomplete: ${incomplete}`);
  lines.push(`items: ${items.length}`);
  if (problems.length > 0) {
    // STORE problems -- an unreadable segment, a directory that is not an activity -- not the
    // shared-log "System (uncorrelated diagnostics)" section at the bottom of the export. Two
    // sections both called "System" read as one thing split in half, which is what this label
    // existed to say and did not.
    lines.push('-- Store problems --');
    for (const p of problems) lines.push(`  ${_describeProblem(p)}`);
  }
  lines.push('');

  if (!available) {
    lines.push('(activity history is currently unavailable)');
  } else if (items.length === 0) {
    lines.push('(no activity recorded)');
  }

  for (const item of items) {
    lines.push('='.repeat(72));
    lines.push(`Activity ${item.id}`);
    const ended = item.endedAt || (item.outcome === 'running' ? '(running)' : '(unknown)');
    lines.push(`outcome: ${item.outcome}    started: ${item.startedAt || '(unknown)'}    ended: ${ended}`);
    lines.push(`channel: ${item.channel || '-'}  trigger: ${item.trigger || '-'}  kind: ${item.kind || '-'}`);
    lines.push(`duration_ms: ${item.duration === null ? '-' : item.duration}    errors: ${item.errorCount}    warnings: ${item.warnCount}    problems: ${item.problemCount}`);
    if (item.incomplete) lines.push('(this item is incomplete: some data could not be read or verified)');
    if (item.truncatedEvents) lines.push('(events truncated for this item)');

    lines.push('-- Events --');
    if (item.events.length === 0) {
      lines.push('  (none)');
    } else {
      for (const ev of item.events) {
        const suffix = ev.detail ? ` -- ${ev.detail}` : '';
        lines.push(`  [${ev.ts}] ${ev.level.toUpperCase()} ${ev.event}${suffix}`);
        if (ev.fields && Object.keys(ev.fields).length > 0) {
          lines.push(`    fields: ${JSON.stringify(ev.fields)}`);
        }
      }
    }

    // Codex R3 I / duplicate terminals: the Problems lens ALREADY carries one grouped
    // `duplicate-terminal` row per duplicated outcome (with its count), so that is the export's
    // single representation. `item.duplicateTerminals[]` stays on the detail DTO for the UI but
    // is deliberately NOT rendered again here -- doing both printed the same anomaly twice.
    lines.push('-- Problems --');
    if (item.problems.length === 0) {
      lines.push('  (none)');
    } else {
      for (const p of item.problems) {
        lines.push(`  ${_describeProblem(p)}`);
      }
    }
    lines.push('');
  }

  // Trailing System section (Task 4.3): the same bounded, redacted diagnostics the `activity:list`
  // `system` payload carries, so an export is self-contained -- someone reading it later has the
  // shared streams and the legacy status surface in front of them, and does not have to trust
  // that the two views agree. Rendered LAST and counted toward EXPORT_MAX_BYTES like everything
  // else. The header says "uncorrelated" because that is the one thing a reader must not get
  // wrong: none of this belongs to the activities above.
  _appendSystemSection(lines, systemMod.systemDiagnostics(home, { configuredSecrets }));

  let text = lines.join('\n');
  const buf = Buffer.from(text, 'utf8');
  if (buf.length > limits.EXPORT_MAX_BYTES) {
    const mibLabel = `${(limits.EXPORT_MAX_BYTES / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MiB`;
    const marker = `\n--- export truncated at ${mibLabel} ---\n`;
    const markerBytes = Buffer.byteLength(marker, 'utf8');
    const keepBytes = Math.max(0, limits.EXPORT_MAX_BYTES - markerBytes);
    text = _utf8SafeSlice(buf, keepBytes).toString('utf8') + marker;
  }
  return text;
}

// -------------------------------------------------------------------------------------------
// Task 4.4 / Rulings P4-12, P4-14: the tray's "⚠️ View Errors" target.
//
// Answers the only question the tray menu is allowed to ask -- "is there anything worth showing,
// and which activity is it?" -- as the id of the NEWEST item that carries Problems or a
// failure-like outcome, or `null` when there is nothing. That makes the motivating bug structural
// rather than remembered: the affordance cannot exist without an item behind it, so it can never
// open an empty view. A pre-attempt failure (a dev-guard block, an unresolved runtime channel, a
// spawn that never happened) is durably recorded as a `blocked`/`failed` activity with no error
// EVENTS at all, and is caught here by its outcome -- that is exactly the incident the old
// `status.json`-only error window rendered as a blank page.
//
// Ruling P4-14: this deliberately does NOT go through `listActivities`. That path assembles a full
// detail item per activity (every event parsed, redacted, rendered and measured) before it sorts
// and pages, so its cost is the whole store no matter what `filter.limit` says. This walks the
// same activities through `_scanActivity` instead -- reconcile + parse, then the shared
// `isProblemBearing` predicate and the terminal outcome -- and renders nothing at all.
//
// NEVER THROWS. Every failure mode -- no store, an unreadable store, an fs error mid-scan -- is
// `null`, which the caller reads as "no affordance".
//
// `configuredSecrets` is accepted for signature parity with the other reader entry points (and so
// a caller cannot be wrong to pass it), but is unused BY CONSTRUCTION: the only value that leaves
// this function is an activity id that `idsMod.validActivityId` has already accepted. No
// producer-supplied text is read, returned or logged here, so there is nothing to redact. If that
// ever stops being true, a Redactor must come back with it.
function viewErrorsTarget(home, { configuredSecrets = [] } = {}) { // eslint-disable-line no-unused-vars
  try {
    const base = _activityRoot(home);
    if (_probeRoot(base) !== 'ok') return null; // missing or unreadable: no affordance either way

    const { subdirs } = paths.listOwnedSubdirsDetailed(base);
    const scans = [];
    for (const name of subdirs) {
      if (name === 'quota' || !idsMod.validActivityId(name)) continue;
      const scan = _safeScanActivity(home, name);
      if (scan !== null) scans.push(scan); // null: reserve-before-start, not history yet
    }

    // Newest-first, same key and same direction as `_collectItems`, then take the first match --
    // a clean run after a failure must not hide the failure.
    scans.sort((a, b) => b.sortKey - a.sortKey);
    for (const scan of scans) {
      if (scan.problemBearing || PROBLEM_OUTCOMES.has(scan.outcome)) return scan.id;
    }
    return null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  InvalidFilter,
  InvalidActivityId,
  validateFilter,
  isProblemBearing,
  viewErrorsTarget,
  PROBLEM_EVENT_LEVELS,
  PROBLEM_OUTCOMES,
  listActivities,
  getActivity,
  buildExport,
  // Task 4.3: re-exported (not reimplemented) so `read` stays the reader facade ipc.js talks to.
  systemDiagnostics: systemMod.systemDiagnostics,
};
