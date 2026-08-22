'use strict';
// Task 3.6: read.js -- the Phase-3 reader capstone. Composes parse.js (Task 3.1) + merge.js
// (Task 3.2) + reconcile.js (Task 3.3) + redact.js (Task 2.2c) into bounded, already-redacted,
// reader-facing DTOs. `main` (Task 4.1) calls `listActivities`/`buildExport`; the renderer only
// ever sees the DTOs this module returns, never raw segment bytes.
//
// Ruling B (carried over from every sibling module): read.js never deletes/mutates/truncates
// committed data. The only writes it can cause are the synthetic-terminal appends already
// sanctioned INSIDE reconcile.js/synthesizeTerminal (called per-activity below, before that
// activity's segments are read) -- this file itself performs no fs write of any kind.
//
// Redaction is defense-in-depth (spec §4): every user-derived string that reaches a DTO or the
// export text -- event names, `detail`, `fields` values, problem reasons -- is run through a
// SINGLE `redact.Redactor` built once per call from `opts.configuredSecrets`, before it is
// returned. Nothing here ever hands back an un-redacted field.
const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const parseMod = require('./parse');
const mergeMod = require('./merge');
const redactMod = require('./redact');
const reconcileMod = require('./reconcile');
const idsMod = require('./ids');
const limits = require('./limits'); // referenced as `limits.FOO` at call sites throughout (never
// destructured) so a test monkeypatching a bound (`limits.LIST_MAX = 2`) is observed immediately --
// see limits.js's own header comment.

class InvalidFilter extends Error {}

// -------------------------------------------------------------------------------------------
// Filter validation (brief: "throws a typed error ... Task 4.1's IPC handler will call it to
// REJECT (not silently clamp) a bad filter"). listActivities/buildExport both call this on
// entry; an empty/omitted filter is valid (no filtering, default paging).
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
// existing precedent of each module owning its own copy of these tiny primitives, e.g.
// `_splitLines` in both parse.js and reconcile.js).
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
// field/detail/reason string placed on a DTO (limits.FIELD_MAX_BYTES) and for the export text as
// a whole (limits.EXPORT_MAX_BYTES, with its own caller-supplied marker).
function _boundStr(s, maxBytes, marker = '…[truncated]') {
  if (typeof s !== 'string') return { value: s, truncated: false };
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return { value: s, truncated: false };
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const keepBytes = Math.max(0, maxBytes - markerBytes);
  const kept = _utf8SafeSlice(buf, keepBytes).toString('utf8');
  return { value: kept + marker, truncated: true };
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
// Per-activity assembly. `_writerIdFromName` mirrors reconcile.js's own private helper of the
// same name (not exported there) -- filenames are `${producer}-${writerId}.jsonl` and PRODUCERS
// never themselves contain '-', so the last '-'-delimited component is always the writerId.
// -------------------------------------------------------------------------------------------
function _writerIdFromName(name) {
  const stem = name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : name;
  const idx = stem.lastIndexOf('-');
  return idx === -1 ? stem : stem.slice(idx + 1);
}

// The exact `parse.js` integrity finding kinds (its own header comment enumerates them) -- used
// below to avoid double-counting: reconcile()'s own `problems` array already includes every
// parse-integrity finding from ITS internal (pre-synthesis) read, and this function does its own
// FRESH read afterward (to pick up a just-synthesized terminal) that collects the same findings
// again. Only reconcile()'s own RECONCILE-SPECIFIC problems (probe-uncertain, terminal-conflict,
// synthesize-raced, internal-error, settle-failed -- all prefixed `reconcile-`) are merged in from
// `rec.problems`; the parse-level kinds are taken exclusively from this function's own fresh scan.
const _PARSE_INTEGRITY_KINDS = new Set([
  'corrupt-json', 'corrupt-shape', 'unsupported-schema', 'invalid-record', 'seq-regression',
]);

// Redact + bound one rendered `fields` map (string values only -- numbers/bools/null pass
// through unchanged, matching records.js's own flat-primitive contract for `fields`).
function _renderFields(fields, redactor) {
  const out = {};
  if (!fields || typeof fields !== 'object') return out;
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string') {
      out[k] = _boundStr(redactor.scrub(v), limits.FIELD_MAX_BYTES).value;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Redact + bound + filter (level/search) the `event` records into the Events-lens row list,
// capped at DETAIL_MAX_ROWS rows AND DETAIL_MAX_BYTES cumulative rendered bytes -- whichever
// limit is hit first stops further rows and sets `truncated`.
function _buildEventsLens(rawEvents, filter, redactor) {
  const rows = [];
  let truncated = false;
  let totalBytes = 0;

  for (const r of rawEvents) {
    const eventName = _boundStr(redactor.scrub(String(r.event)), limits.FIELD_MAX_BYTES).value;
    const detail = r.detail != null
      ? _boundStr(redactor.scrub(String(r.detail)), limits.FIELD_MAX_BYTES).value
      : null;
    const renderedFields = _renderFields(r.fields, redactor);

    if (filter.level && r.level !== filter.level) continue;
    if (filter.search) {
      const haystack = `${eventName}\n${detail || ''}\n${JSON.stringify(renderedFields)}`;
      if (!haystack.includes(filter.search)) continue;
    }

    const row = {
      ts: r.ts,
      level: r.level,
      writerId: r.writerId,
      event: eventName,
      detail,
      fields: renderedFields,
    };
    const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8');
    if (rows.length >= limits.DETAIL_MAX_ROWS || totalBytes + rowBytes > limits.DETAIL_MAX_BYTES) {
      truncated = true;
      break;
    }
    totalBytes += rowBytes;
    rows.push(row);
  }

  return { rows, truncated };
}

function _renderProblem(p, redactor) {
  const kind = p && p.kind ? String(p.kind) : 'unknown';
  const reason = p && p.reason != null
    ? _boundStr(redactor.scrub(String(p.reason)), limits.FIELD_MAX_BYTES).value
    : undefined;
  const out = { kind, reason };
  if (p && typeof p.index === 'number') out.index = p.index;
  return out;
}

// Build one activity's DTO. Step order matters (task brief's Phase-3 gate): `reconcile()` runs
// FIRST -- performing the read-triggered reconciliation, possibly appending a durable synthetic
// terminal for a crashed `running` attempt -- and only THEN are this activity's segments read for
// DTO assembly, so a just-synthesized terminal is already visible in `merged` below.
function _buildItem(home, aid, filter, redactor) {
  const rec = reconcileMod.reconcile(home, aid);

  const problems = [];
  let hasParseIntegrity = false;
  let mtime = 0;
  const perSegment = [];

  const segs = paths.readOwnedSegments(paths.activityDir(home, aid));
  for (const seg of segs) {
    if (seg.mtime > mtime) mtime = seg.mtime;
    const writerId = _writerIdFromName(seg.name);
    const { records: recs, integrity } = parseMod.parseSegment(seg.data, aid);
    if (integrity.length > 0) hasParseIntegrity = true;
    for (const finding of integrity) problems.push(finding);
    perSegment.push(recs.map((r) => Object.assign({}, r, { writerId })));
  }
  const merged = mergeMod.mergeHeads(perSegment);

  let hasUncertain = false;
  for (const p of rec.problems || []) {
    const kind = String((p && p.kind) || '');
    if (_PARSE_INTEGRITY_KINDS.has(kind)) continue; // already represented by the fresh scan above
    problems.push(p);
    if (kind === 'reconcile-probe-uncertain') hasUncertain = true;
  }

  const startRecord = merged.find((r) => r.type === 'start') || null;
  const terminalRecord = merged.find((r) => r.type === 'terminal') || null;

  const outcome = rec.outcome === null ? 'running' : rec.outcome;
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

  const { rows: events, truncated: truncatedEvents } = _buildEventsLens(rawEvents, filter, redactor);

  const duplicateTerminals = Object.entries(rec.duplicateTerminalCounts || {})
    .filter(([, count]) => count > 1)
    .map(([dupOutcome, count]) => ({ outcome: dupOutcome, count }));

  const dto = {
    id: aid,
    outcome,
    startedAt,
    endedAt,
    duration,
    // Review R1 / I1: records.js only enum-constrains `kind` -- `channel`/`trigger` are
    // contract-wise just producer-supplied strings, so the read-time redaction backstop (spec
    // §4) must cover them exactly like every other rendered string, not just event/detail/fields.
    // `buildExport` renders these DTO fields verbatim (never re-reads the raw record), so fixing
    // it here covers both output surfaces.
    channel: startRecord ? redactor.scrub(startRecord.channel) : null,
    trigger: startRecord ? redactor.scrub(startRecord.trigger) : null,
    kind: startRecord ? redactor.scrub(startRecord.kind) : null,
    errorCount,
    warnCount,
    mtime,
    events,
    truncatedEvents,
    duplicateTerminals,
    problems: problems.map((p) => _renderProblem(p, redactor)),
  };

  return { dto, hasIncompleteSignal: hasParseIntegrity || hasUncertain };
}

function _sortKey(item) {
  const t = item.startedAt ? Date.parse(item.startedAt) : NaN;
  if (Number.isFinite(t)) return t;
  return (item.mtime || 0) * 1000; // mtime is in seconds (paths.js); scale to the same ms axis
}

// Enumerate + assemble every valid activity under `home`, unbounded by LIST_MAX/offset/limit --
// the shared core both listActivities (which then pages) and buildExport (which does not) build
// on. Never throws (mirrors the read-only, best-effort contract every sibling module keeps).
function _collectItems(home, filter, redactor) {
  const base = _activityRoot(home);
  const state = _probeRoot(base);
  if (state === 'missing') return { items: [], available: true, incomplete: false };
  if (state === 'unreadable') return { items: [], available: false, incomplete: false };

  const subdirs = paths.listOwnedSubdirs(base);
  const aids = subdirs.filter((name) => name !== 'quota' && idsMod.validActivityId(name));

  let incomplete = false;
  const items = [];
  for (const aid of aids) {
    const { dto, hasIncompleteSignal } = _buildItem(home, aid, filter, redactor);
    items.push(dto);
    if (hasIncompleteSignal) incomplete = true;
  }
  items.sort((a, b) => _sortKey(b) - _sortKey(a));
  return { items, available: true, incomplete };
}

// -------------------------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------------------------
function listActivities(home, filter = {}, { configuredSecrets = [] } = {}) {
  validateFilter(filter);
  const redactor = new redactMod.Redactor(configuredSecrets);
  const { items, available, incomplete } = _collectItems(home, filter, redactor);

  if (!available) {
    return { items: [], truncated: false, available: false, incomplete: false };
  }

  const offset = filter.offset || 0;
  const limit = Math.min(filter.limit !== undefined ? filter.limit : limits.LIST_MAX, limits.LIST_MAX);
  const sliced = items.slice(offset, offset + limit);
  const truncated = offset + sliced.length < items.length;

  return { items: sliced, truncated, available, incomplete };
}

// Renders the same reconciled+redacted data as a stable, human-readable text document. Never
// reads renderer input -- `filter`/`opts` are the only inputs, exactly like listActivities.
// Ignores LIST_MAX item paging (that bound is about a single IPC response's item-summary count;
// an export is a deliberate full-history dump), enforcing only the total-byte cap instead.
function buildExport(home, filter = {}, { configuredSecrets = [] } = {}) {
  validateFilter(filter);
  const redactor = new redactMod.Redactor(configuredSecrets);
  const { items, available, incomplete } = _collectItems(home, filter, redactor);

  const lines = [];
  lines.push('Repo Radar Activity Export');
  lines.push(`generated: ${new Date().toISOString()}`);
  lines.push(`available: ${available}`);
  lines.push(`incomplete: ${incomplete}`);
  lines.push(`items: ${items.length}`);
  lines.push('');

  if (!available) {
    lines.push('(activity history is currently unavailable)');
  } else if (items.length === 0) {
    lines.push('(no activity recorded)');
  }

  for (const item of items) {
    lines.push('='.repeat(72));
    lines.push(`Activity ${item.id}`);
    lines.push(`outcome: ${item.outcome}    started: ${item.startedAt || '(unknown)'}    ended: ${item.endedAt || '(running)'}`);
    lines.push(`channel: ${item.channel || '-'}  trigger: ${item.trigger || '-'}  kind: ${item.kind || '-'}`);
    lines.push(`duration_ms: ${item.duration === null ? '-' : item.duration}    errors: ${item.errorCount}    warnings: ${item.warnCount}`);
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

    lines.push('-- Problems --');
    if (item.problems.length === 0 && item.duplicateTerminals.length === 0) {
      lines.push('  (none)');
    } else {
      for (const p of item.problems) {
        lines.push(`  [${p.kind}] ${p.reason || ''}`);
      }
      for (const d of item.duplicateTerminals) {
        lines.push(`  duplicate terminal: ${d.outcome} x${d.count}`);
      }
    }
    lines.push('');
  }

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

module.exports = {
  InvalidFilter,
  validateFilter,
  listActivities,
  buildExport,
};
