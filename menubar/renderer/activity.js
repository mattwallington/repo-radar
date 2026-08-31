'use strict';
// ---------------------------------------------------------------------------------------------
// Why this whole file is one IIFE: activity.html loads it and activity-system.js as two plain
// <script src> tags, and classic scripts share ONE global scope -- there is no scope per file.
// Both files declare `TEXT`, `el`, `sanitizeText` and the four escape regexes, a duplication that
// is deliberate and documented below (a sandboxed page script cannot import). Unwrapped, the
// second script to load therefore died on parse with "Identifier 'TEXT' has already been
// declared", `start()` never ran, and the window painted an empty list pane. This wrapper is the
// isolation that makes the duplication safe; `__tests__/activity-browser-scope.test.js` runs both
// files in a single vm context so it stays that way. The body below is left un-indented: the
// wrapper is a pure addition, and the source-scanning tests keep finding their landmarks at the
// start of a line.
// ---------------------------------------------------------------------------------------------
(() => {
'use strict';
// Task 4.2: the Activity History renderer.
//
// This file runs in a SANDBOXED, context-isolated window (see activity/window-options.js). It has
// no Node reach whatsoever: its entire world is the DOM and the four functions the dedicated
// preload puts on `window.activityApi` ({ list, get, export, reveal }).
//
// Two rules shape everything below.
//
// 1. TEXT ONLY. Every string that reaches the page is producer- or filesystem-derived, i.e.
//    untrusted. It is placed with `textContent` -- never as markup -- and it first passes through
//    `sanitizeText`, which strips ANSI escape sequences and C0/C1 control characters (keeping only
//    newline and tab) so a terminal-coloured log line can neither smuggle escapes into the DOM nor
//    render as garbage. `__tests__/activity-renderer-dom.test.js` proves both halves: a hostile DTO
//    lands as literal characters on a childless element, and the source carries no markup sink.
//
// 2. PURE MAPPING. The DTO -> DOM functions (`renderChip`, `renderEventRow`, `renderProblemRow`,
//    `renderList`, ...) take a `document`-like adapter as their first argument and attach no event
//    listeners -- the list delegates clicks from its container instead. That is what lets them be
//    unit-tested in plain Node against a ~60-line shim, with no jsdom and no new dependency.
//
// The bottom of the file boots the browser path only when a real window with `activityApi` is
// present, so loading this file under `node --test` is inert.

// -------------------------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------------------------

// Ruling P4-8: the optional focus id arrives as the loaded URL's fragment. It is accepted ONLY if
// it is a UUIDv4 -- the same shape activity/ids.js validates main-side -- and the same gate is
// reused to validate a chip's `data-activity-id` before it is handed back over the bridge.
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// activity/limits.js's LEVELS and SEARCH_MAX. The main side REJECTS an out-of-bounds filter
// rather than clamping it, so this side must never send one: `normalizeFilter` is the only place
// a filter is built, and it drops anything it cannot vouch for.
const LEVELS = new Set(['info', 'warn', 'error']);
const SEARCH_MAX = 256;

// Outcome -> dot colour class. An outcome outside this set never reaches a class name.
const OUTCOMES = new Set([
  'succeeded', 'succeeded-with-warnings', 'blocked', 'failed',
  'cancelled', 'skipped', 'interrupted', 'running', 'unknown',
]);

// Ruling P4-7: a rejected bridge call reaches this side as an OPAQUE error -- Electron serializes
// it, and the `code` the main-side handler set may not survive. The renderer therefore never
// branches on an error's code or message; every failure shows this one fixed line plus Retry.
const TEXT = {
  loadError: 'Activity history couldn’t be loaded.',
  // The one failure that is NOT a bridge rejection: the bridge is not there at all. A renamed
  // or throwing preload leaves this page with no `activityApi`, and without a line to show for
  // it the window paints nothing -- indistinguishable, on screen, from an empty history.
  bridgeMissing: 'Activity bridge unavailable — the window’s preload did not load.',
  loading: 'Loading…',
  empty: 'No activity recorded yet.',
  emptyHint: 'The next sync will record its first activity here.',
  unavailable: 'Activity history is unavailable.',
  unavailableHint: 'The history store exists but could not be read.',
  truncatedHead: 'Showing the newest',
  truncatedTail: 'older activity is not shown.',
  incomplete: 'History is incomplete — some records could not be read.',
  // The action bar. Every one of these is FIXED: the export path is the only variable that ever
  // reaches the status line, and it comes from main's save dialog (still scrubbed on the way in).
  exported: 'Exported to',
  exportCancelled: 'Export cancelled — nothing was written.',
  exportError: 'The export couldn’t be completed.',
  revealError: 'That activity couldn’t be shown in Finder.',
  noEvents: 'This activity recorded no events.',
  noMatches: 'No events match the current filter.',
  eventsTruncated: 'Further events were not included for this activity.',
  noProblems: 'No problems recorded for this activity.',
  gone: 'That activity is no longer on disk.',
  unreadable: 'That activity could not be read.',
  notStarted: 'That activity hasn’t started yet.',
  pick: 'Select an activity on the left.',
};

// -------------------------------------------------------------------------------------------
// sanitizeText -- the single scrubber every render path shares.
// -------------------------------------------------------------------------------------------
// Order matters: the multi-character escape sequences are removed FIRST (they are introduced by
// ESC, which the control-character sweep would otherwise strip, leaving their payload behind as
// visible junk like "[31m").
const ANSI_OSC_RE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g; // OSC ... BEL | ST
const ANSI_CSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;                   // CSI ... final byte
const ANSI_ESC_RE = /\u001b[@-Z\\-_]/g;                             // remaining two-byte escapes
// The control sweep below also strips the BIDI overrides and isolates (U+202A-U+202E and
// U+2066-U+2069): they are not C0/C1 controls, but a single U+202E in a repo name or a log line
// reverses everything after it on the row, so a row can be made to read as a different repo or
// outcome than the one it describes. Nothing this app displays needs them.
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g; // C0/C1 (bar \n, \t) + bidi

function sanitizeText(value) {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : String(value);
  return s
    .replace(ANSI_OSC_RE, '')
    .replace(ANSI_CSI_RE, '')
    .replace(ANSI_ESC_RE, '')
    .replace(CONTROL_RE, '');
}

// -------------------------------------------------------------------------------------------
// Formatting
// -------------------------------------------------------------------------------------------
function pad2(n) {
  return String(n).padStart(2, '0');
}

// Local wall-clock, fixed layout (no locale surprises across screenshots/tests). An unparseable
// timestamp falls back to the raw value -- sanitized, because it is still producer-supplied.
function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return sanitizeText(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
    + `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  return `${minutes}m ${Math.round((ms % 60000) / 1000)}s`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function outcomeKey(outcome) {
  return OUTCOMES.has(outcome) ? outcome : 'unknown';
}

function levelKey(level) {
  return LEVELS.has(level) ? level : 'info';
}

// A flat primitive from a `fields`/`summary` map (activity/read.js guarantees flat primitives;
// anything else is shown as its own text rather than as "[object Object]").
function scalar(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function fieldsSuffix(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return '';
  const parts = Object.keys(map).map((k) => `${k}: ${scalar(map[k])}`);
  return parts.length === 0 ? '' : `  ${parts.join(', ')}`;
}

// -------------------------------------------------------------------------------------------
// The ONE way any text enters the page.
// -------------------------------------------------------------------------------------------
function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = sanitizeText(text);
  return node;
}

// -------------------------------------------------------------------------------------------
// DTO -> DOM (pure)
// -------------------------------------------------------------------------------------------
function sourceLabel(item) {
  const parts = [item.channel, item.trigger, item.kind].filter((p) => typeof p === 'string' && p !== '');
  return parts.length === 0 ? '—' : parts.join(' · ');
}

// One list chip: time · channel/trigger/kind · duration · outcome dot · error/warn counts.
// The id is carried as a data attribute (never as text) and only when it is a real UUIDv4, so a
// tampered directory name can never become the argument of a later bridge call.
function renderChip(doc, dto) {
  const item = dto && typeof dto === 'object' ? dto : {};
  const chip = el(doc, 'div', 'chip');
  chip.setAttribute('data-activity-id', UUID_V4_RE.test(item.id) ? item.id : '');
  // Reachable without a mouse: a focus stop that announces what it is. The keys that activate it
  // are handled by the same delegated listener as the click, so this stays a pure renderer.
  chip.setAttribute('tabindex', '0');
  chip.setAttribute('role', 'button');

  const head = el(doc, 'div', 'chip-head');
  head.appendChild(el(doc, 'span', 'chip-time', formatTime(item.startedAt)));
  head.appendChild(el(doc, 'span', `dot dot-${outcomeKey(item.outcome)}`));
  head.appendChild(el(doc, 'span', 'chip-outcome', outcomeKey(item.outcome)));
  chip.appendChild(head);

  const meta = el(doc, 'div', 'chip-meta');
  meta.appendChild(el(doc, 'span', 'chip-source', sourceLabel(item)));
  meta.appendChild(el(doc, 'span', 'chip-duration', formatDuration(item.duration)));
  if (item.errorCount > 0) meta.appendChild(el(doc, 'span', 'chip-count count-error', plural(item.errorCount, 'error')));
  if (item.warnCount > 0) meta.appendChild(el(doc, 'span', 'chip-count count-warn', plural(item.warnCount, 'warning')));
  if (item.incomplete) meta.appendChild(el(doc, 'span', 'chip-flag', 'incomplete'));
  chip.appendChild(meta);
  return chip;
}

// `detail` plus every `fields` entry, as the expandable body of an event row.
function eventDetailText(rec) {
  const lines = [];
  const detail = sanitizeText(rec.detail);
  if (detail) lines.push(detail);
  const fields = rec.fields;
  if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
    for (const key of Object.keys(fields)) {
      lines.push(`${sanitizeText(key)}: ${sanitizeText(scalar(fields[key]))}`);
    }
  }
  return lines.join('\n');
}

// An Events-lens row. A row with a detail or fields becomes a native disclosure element, so the
// expand/collapse costs no script and no listener.
function renderEventRow(doc, rec) {
  const r = rec && typeof rec === 'object' ? rec : {};
  const body = eventDetailText(r);
  const expandable = body.length > 0;

  const row = el(doc, expandable ? 'details' : 'div', `row row-${levelKey(r.level)}`);
  const head = el(doc, expandable ? 'summary' : 'div', 'row-head');
  head.appendChild(el(doc, 'span', `row-level level-${levelKey(r.level)}`, levelKey(r.level)));
  head.appendChild(el(doc, 'span', 'row-time', formatTime(r.ts)));
  head.appendChild(el(doc, 'span', 'row-name', r.event));
  row.appendChild(head);
  if (expandable) row.appendChild(el(doc, 'pre', 'row-detail', body));
  return row;
}

// One line of prose for a Problems-lens row. Returns RAW text; `renderProblemRow` sanitizes it
// once on the way into the DOM, so no branch here can forget to.
function describeProblem(problem) {
  const p = problem && typeof problem === 'object' ? problem : {};
  switch (p.kind) {
    case 'event':
      return `${String(p.level || '').toUpperCase()} ${p.event || ''}`
        + `${p.detail ? ` — ${p.detail}` : ''}${fieldsSuffix(p.fields)}`;
    case 'terminal': {
      const by = Array.isArray(p.by) ? p.by.join(', ') : (p.by || 'unknown');
      const count = p.count > 1 ? ` ×${p.count}` : '';
      return `${p.outcome || 'unknown'}${count} by ${by}${fieldsSuffix(p.summary)}`;
    }
    case 'duplicate-terminal':
      return `${p.outcome || 'unknown'} recorded ${p.count} times`;
    case 'rejected-segment':
      return `${p.reason || ''}: ${p.name || '(directory)'}`;
    case 'rejected-activity':
      return `${p.reason || ''}: ${p.id || ''}`;
    case 'truncated':
      return `${p.dropped} further problem(s) not shown`;
    default: {
      const where = typeof p.index === 'number' ? ` (line ${p.index})` : '';
      return `${p.reason || ''}${p.detail ? ` — ${p.detail}` : ''}${where}`;
    }
  }
}

// Everything that is not routine reads as an error; the rest (a dropped-rows marker, a refused
// segment) reads as a warning. The class is derived, never taken from the DTO.
const SEVERE_KINDS = new Set(['terminal', 'integrity', 'internal-error', 'duplicate-terminal']);

function problemSeverity(p) {
  if (p.kind === 'event') return p.level === 'error' ? 'error' : 'warn';
  return SEVERE_KINDS.has(p.kind) ? 'error' : 'warn';
}

function renderProblemRow(doc, problem) {
  const p = problem && typeof problem === 'object' ? problem : {};
  const row = el(doc, 'div', `row problem problem-${problemSeverity(p)}`);
  row.appendChild(el(doc, 'span', 'problem-kind', p.kind ? p.kind : 'problem'));
  if (p.ts) row.appendChild(el(doc, 'span', 'problem-time', formatTime(p.ts)));
  row.appendChild(el(doc, 'span', 'problem-text', describeProblem(p)));
  return row;
}

function truncatedText(shown) {
  return `${TEXT.truncatedHead} ${shown} — ${TEXT.truncatedTail}`;
}

// Task 4.5 (Round-3 #9 / Round-4 #7): the reader reports THREE different things about the store,
// and this is where they stop being one grey "nothing here" line.
//
//   { available:true,  items:[] }                 the store is MISSING. Ordinary empty history:
//                                                 nothing has synced yet, and the hint says so.
//   { available:false }                           the store EXISTS and could not be read. This
//                                                 must never read as "no activity" -- the user's
//                                                 history may be sitting right there, and telling
//                                                 them it is empty is telling them it is gone.
//   { available:true, incomplete:true, items:[…] } what could be read, PLUS an admission that the
//                                                 view is partial, PLUS the store-level problems
//                                                 that say why.
//
// `result.problems` (Ruling 39) are root diagnostics that belong to no item -- an activity-shaped
// root entry the reader refused to follow (a valid-UUID symlink, a plain file, an lstat-denied
// entry), bounded, plus a `truncated` marker for the remainder. Nothing else in the UI can show
// them: they have no activity to hang off, so without these rows the banner says "incomplete" and
// never why. Pure, and exported so the three states can be asserted directly.
function renderStoreState(doc, result) {
  const res = result && typeof result === 'object' ? result : {};
  const items = Array.isArray(res.items) ? res.items : [];
  const wrap = el(doc, 'div', 'store-state');

  if (res.available === false) {
    const panel = el(doc, 'div', 'state state-unavailable', TEXT.unavailable);
    panel.appendChild(el(doc, 'div', 'state-hint', TEXT.unavailableHint));
    wrap.appendChild(panel);
    return wrap; // nothing further is claimed about a store we could not read
  }

  if (res.incomplete) wrap.appendChild(el(doc, 'div', 'state state-incomplete', TEXT.incomplete));
  const problems = Array.isArray(res.problems) ? res.problems : [];
  for (const p of problems) wrap.appendChild(renderProblemRow(doc, p));

  if (items.length === 0) {
    const panel = el(doc, 'div', 'state state-empty', TEXT.empty);
    panel.appendChild(el(doc, 'div', 'state-hint', TEXT.emptyHint));
    wrap.appendChild(panel);
  }
  return wrap;
}

// The newest-first chip list, under whichever store state applies.
function renderList(doc, result) {
  const res = result && typeof result === 'object' ? result : {};
  const items = Array.isArray(res.items) ? res.items : [];
  const list = el(doc, 'div', 'chip-list');
  list.appendChild(renderStoreState(doc, res));

  // An unreadable store renders NO chips, whatever `items` happens to hold: drawing history over
  // a store the reader could not read would be a completeness claim it explicitly refused to make.
  if (res.available === false) return list;
  for (const item of items) list.appendChild(renderChip(doc, item));
  // Says how many are on screen rather than implying that is all there is.
  if (res.truncated) list.appendChild(el(doc, 'div', 'state state-truncated', truncatedText(items.length)));
  return list;
}

// -------------------------------------------------------------------------------------------
// Filtering. `activity:get` takes an ID ONLY -- the bridge has no filter argument -- so the level
// and search controls are applied HERE, over the already-bounded detail rows the main side
// returned (activity/limits.js caps them at DETAIL_MAX_ROWS / DETAIL_MAX_BYTES). No re-fetch, no
// paging. `normalizeFilter` still enforces the main side's bounds because Task 4.5's Export
// button sends the same object over `activity:export`, where an out-of-bounds value is rejected.
// -------------------------------------------------------------------------------------------
function normalizeFilter(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  if (LEVELS.has(src.level)) out.level = src.level;
  if (typeof src.search === 'string') {
    const search = src.search.trim().slice(0, SEARCH_MAX);
    if (search) out.search = search;
  }
  return out;
}

// Literal substring, never a regular expression, and case-insensitive over exactly the text the
// row displays -- so what the user searched is what they can see.
function matchesEventFilter(rec, filter) {
  const f = normalizeFilter(filter);
  const r = rec && typeof rec === 'object' ? rec : {};
  if (f.level && r.level !== f.level) return false;
  if (f.search) {
    const haystack = `${sanitizeText(r.event)}\n${eventDetailText(r)}`.toLowerCase();
    if (!haystack.includes(f.search.toLowerCase())) return false;
  }
  return true;
}

function focusIdFromHash(hash) {
  if (typeof hash !== 'string') return null;
  const raw = hash.charAt(0) === '#' ? hash.slice(1) : hash;
  return UUID_V4_RE.test(raw) ? raw : null;
}

// -------------------------------------------------------------------------------------------
// The two lenses
// -------------------------------------------------------------------------------------------
function renderEvents(doc, item, filter) {
  const it = item && typeof item === 'object' ? item : {};
  const events = Array.isArray(it.events) ? it.events : [];
  const shown = events.filter((rec) => matchesEventFilter(rec, filter));
  const wrap = el(doc, 'div', 'lens lens-events');

  if (shown.length === 0) {
    wrap.appendChild(el(doc, 'div', 'state state-empty', events.length === 0 ? TEXT.noEvents : TEXT.noMatches));
  } else {
    for (const rec of shown) wrap.appendChild(renderEventRow(doc, rec));
  }
  // Announced even when the filter matched nothing: "no matches" over a partially-read lens would
  // otherwise read as "there is nothing more", which is exactly the claim we cannot make.
  if (it.truncatedEvents) wrap.appendChild(el(doc, 'div', 'state state-truncated', TEXT.eventsTruncated));
  return wrap;
}

// warn/error events, failure diagnostics, integrity findings -- all of which the reader already
// collected into `item.problems` -- plus the grouped duplicate terminals.
//
// `item.duplicateTerminals` and the `duplicate-terminal` rows inside `item.problems` describe the
// SAME anomaly, but activity/read.js builds them from DIFFERENT inputs and they can disagree in
// both directions:
//   - the problem rows come from `_groupTerminals(merged)` -- read.js's own fresh segment scan;
//   - the array comes from `rec.duplicateTerminalCounts`, which reconcile.js returns as `{}` on
//     six of its eight exits (the synthesize path included).
// So a terminal appended between reconcile and the fresh scan yields a problem row with an EMPTY
// array, while problem-row truncation yields the opposite. De-duplicating on either source alone
// therefore loses the anomaly. Instead: render the array (authoritative where it exists, and it
// survives truncation) and drop only the problem rows whose outcome the array already covers.
// Every other row is kept, so an anomaly reported by exactly one source is still shown -- exactly
// once. read.js's buildExport makes the mirror-image choice for the same reason.
function renderProblems(doc, item) {
  const it = item && typeof item === 'object' ? item : {};
  const dups = (Array.isArray(it.duplicateTerminals) ? it.duplicateTerminals : [])
    .filter((d) => d && typeof d === 'object');
  const covered = new Set(dups.map((d) => d.outcome));
  const rows = (Array.isArray(it.problems) ? it.problems : [])
    .filter((p) => !(p && p.kind === 'duplicate-terminal' && covered.has(p.outcome)));
  const wrap = el(doc, 'div', 'lens lens-problems');

  if (dups.length === 0 && rows.length === 0) {
    wrap.appendChild(el(doc, 'div', 'state state-empty', TEXT.noProblems));
    return wrap;
  }
  for (const d of dups) {
    wrap.appendChild(renderProblemRow(doc, {
      kind: 'duplicate-terminal', outcome: d && d.outcome, count: d && d.count,
    }));
  }
  for (const p of rows) wrap.appendChild(renderProblemRow(doc, p));
  return wrap;
}

// `activity:get` answers `{ item, available, reason? }` -- a null item is a normal, expected
// answer (the activity was retained away, or the store is unreadable), NOT an error.
const DETAIL_REASONS = {
  unavailable: TEXT.unavailable,
  missing: TEXT.gone,
  unreadable: TEXT.unreadable,
  'not-started': TEXT.notStarted,
};

function renderDetailHead(doc, item) {
  const head = el(doc, 'div', 'detail-head');
  const title = el(doc, 'div', 'detail-title');
  title.appendChild(el(doc, 'span', `dot dot-${outcomeKey(item.outcome)}`));
  title.appendChild(el(doc, 'span', 'detail-outcome', outcomeKey(item.outcome)));
  title.appendChild(el(doc, 'span', 'detail-time', formatTime(item.startedAt)));
  title.appendChild(el(doc, 'span', 'detail-duration', formatDuration(item.duration)));
  head.appendChild(title);

  const meta = el(doc, 'div', 'detail-meta');
  meta.appendChild(el(doc, 'span', 'detail-source', sourceLabel(item)));
  if (item.incomplete) meta.appendChild(el(doc, 'span', 'chip-flag', 'incomplete'));
  if (item.synthesized) meta.appendChild(el(doc, 'span', 'chip-flag', 'outcome inferred'));
  head.appendChild(meta);
  return head;
}

function renderDetail(doc, result, view) {
  const res = result && typeof result === 'object' ? result : {};
  const wrap = el(doc, 'div', 'detail-inner');
  if (!res.item) {
    wrap.appendChild(el(doc, 'div', 'state state-empty', DETAIL_REASONS[res.reason] || TEXT.pick));
    return wrap;
  }
  const lens = view && view.lens === 'problems' ? 'problems' : 'events';
  wrap.appendChild(renderDetailHead(doc, res.item));
  wrap.appendChild(lens === 'problems'
    ? renderProblems(doc, res.item)
    : renderEvents(doc, res.item, view && view.filter));
  return wrap;
}

// -------------------------------------------------------------------------------------------
// Browser boot. Everything above is pure; everything below touches the live page and the bridge.
// -------------------------------------------------------------------------------------------
function boot(win, doc, api) {
  const listEl = doc.getElementById('list');
  const detailEl = doc.getElementById('detail');
  const levelEl = doc.getElementById('event-level');
  const searchEl = doc.getElementById('event-search');
  const filtersEl = doc.getElementById('event-filters');
  const tabs = { events: doc.getElementById('tab-events'), problems: doc.getElementById('tab-problems') };
  // Task 4.3: the System disclosure at the bottom of the list pane. `systemEl` is the <details>;
  // `systemBodyEl` is the only container the diagnostics ever paint into.
  const systemEl = doc.getElementById('system');
  const systemBodyEl = doc.getElementById('system-body');
  // Task 4.5: the action bar and its single status line.
  const refreshEl = doc.getElementById('btn-refresh');
  const exportEl = doc.getElementById('btn-export');
  const revealEl = doc.getElementById('btn-reveal');
  const statusEl = doc.getElementById('action-status');

  const view = { lens: 'events', filter: {}, selectedId: null, detail: null };
  let pendingFocus = focusIdFromHash(win.location.hash);
  let listReady = false;
  let systemLoaded = false;
  let exporting = false;

  function put(container, node) {
    container.textContent = '';
    container.appendChild(node);
  }

  // Ruling P4-7: one fixed line for every failure, plus a way to try again. The rejected error is
  // deliberately never inspected -- its code and message are not trustworthy across the bridge.
  function putError(container, retry) {
    const box = el(doc, 'div', 'state state-error', TEXT.loadError);
    const button = el(doc, 'button', 'retry', 'Retry');
    button.setAttribute('type', 'button');
    button.addEventListener('click', retry);
    box.appendChild(button);
    put(container, box);
  }

  // The action bar's one output. Fixed strings only, save for the export path main hands back --
  // which still goes through `el`, i.e. through sanitizeText, like every other string on the page.
  function setStatus(text) {
    statusEl.textContent = '';
    if (text) statusEl.appendChild(el(doc, 'span', 'action-status-text', text));
  }

  function markSelected() {
    const chips = listEl.querySelectorAll('.chip');
    for (const chip of chips) {
      chip.classList.toggle('selected', chip.getAttribute('data-activity-id') === view.selectedId);
    }
    // Reveal acts on the SELECTED activity, so it is only offered when there is one.
    revealEl.disabled = !view.selectedId;
  }

  // Is the list currently on screen still showing the selected activity?
  function selectedChipPresent() {
    for (const chip of listEl.querySelectorAll('.chip')) {
      if (chip.getAttribute('data-activity-id') === view.selectedId) return true;
    }
    return false;
  }

  // Retention prunes activities between renders, so a selection can outlive the thing it points
  // at: without this, Reveal stayed enabled aimed at an id that is no longer on disk. Called from
  // the list render only.
  //
  // A TRUNCATED list is deliberately not treated as evidence: absence from a capped page means
  // "not on this page", not "not in the store", and the deep-linked View Errors target is exactly
  // the kind of older item that falls off it -- dropping the selection there would blank a pane
  // the data does not say is stale. `activity:reveal` lstats the directory itself before asking
  // the shell, so a selection kept over a truncated page can still only ever produce a truthful
  // answer.
  //
  // Dropping it returns the detail pane to "select an activity" rather than announcing the item
  // was pruned: not being on this page is not proof of deletion, and the reader is the only thing
  // entitled to make that claim.
  function dropPrunedSelection(result) {
    if (!view.selectedId) return;
    if (result && result.truncated) return;
    if (selectedChipPresent()) return;
    view.selectedId = null;
    view.detail = null;
    paintDetail();
  }

  function paintDetail() {
    put(detailEl, renderDetail(doc, view.detail, view));
  }

  function setLens(lens) {
    view.lens = lens === 'problems' ? 'problems' : 'events';
    tabs.events.classList.toggle('active', view.lens === 'events');
    tabs.problems.classList.toggle('active', view.lens === 'problems');
    filtersEl.classList.toggle('hidden', view.lens !== 'events');
    paintDetail();
  }

  async function select(id) {
    view.selectedId = id;
    markSelected();
    put(detailEl, el(doc, 'div', 'state state-loading', TEXT.loading));
    try {
      const result = await api.get(id);
      if (view.selectedId !== id) return; // a newer selection won the race
      view.detail = result;
      paintDetail();
    } catch (e) {
      if (view.selectedId !== id) return;
      view.detail = null;
      putError(detailEl, () => select(id));
    }
  }

  async function loadList() {
    put(listEl, el(doc, 'div', 'state state-loading', TEXT.loading));
    try {
      // `normalizeFilter` is the ONLY place a filter is built, so the object crossing the bridge
      // here is the same shape -- and, for a given view, the same value -- the Export button
      // sends. The main side rejects an out-of-bounds filter rather than clamping it, and this is
      // what guarantees it never sees one. (`activity:list` ignores level/search when selecting
      // items; they matter to `activity:export`, whose Events section is filtered by them.)
      const result = await api.list(normalizeFilter(view.filter));
      put(listEl, renderList(doc, result));
      listReady = true;
      if (pendingFocus) {
        // A deep link names an activity by id, which `activity:get` resolves whether or not the
        // list page happens to show it -- so this path is never second-guessed below.
        const id = pendingFocus;
        pendingFocus = null;
        await select(id);
      } else {
        dropPrunedSelection(result);
        markSelected();
      }
    } catch (e) {
      putError(listEl, loadList);
    }
  }

  // Task 4.3: the System section -- the app's SHARED log streams and the legacy status.json error
  // surface. Ruling P4-1: these ride on `activity:list` behind a `system:true` flag rather than on
  // a fifth channel, and are requested ONLY when the section is expanded or refreshed, so an
  // ordinary list refresh never touches the shared log files. The response's item list is
  // deliberately IGNORED here: this call updates the section and nothing else, so the diagnostics
  // can never reorder or blank the Activity list behind the user. They are equally never mixed
  // into an item or the Problems lens -- they belong to no activity, which the section says on its
  // face.
  async function loadSystem() {
    put(systemBodyEl, el(doc, 'div', 'state state-loading', TEXT.loading));
    try {
      const result = await api.list(Object.assign({}, view.filter, { system: true }));
      const wrap = el(doc, 'div', 'system-wrap');
      const refresh = el(doc, 'button', 'retry system-refresh', 'Refresh');
      refresh.setAttribute('type', 'button');
      refresh.addEventListener('click', loadSystem);
      wrap.appendChild(refresh);
      // The section itself is built by the sibling page script (renderer/activity-system.js),
      // reached through the window because a sandboxed page script has no imports.
      wrap.appendChild(win.activitySystem.renderSystem(doc, result && result.system));
      put(systemBodyEl, wrap);
      systemLoaded = true;
    } catch (e) {
      putError(systemBodyEl, loadSystem);
    }
  }

  // A native <details>: expanding fires `toggle`, which is the only thing that triggers the first
  // (and, unless Refresh is pressed, the only) diagnostics read.
  systemEl.addEventListener('toggle', () => {
    if (systemEl.open && !systemLoaded) loadSystem();
  });

  // Delegated: the chips themselves are produced by a pure renderer that attaches no listeners.
  // The id is re-validated on the way out even though `renderChip` only ever writes a UUIDv4 --
  // it is about to become the argument of a bridge call.
  function chipIdFrom(target) {
    let node = target;
    while (node && node !== listEl && !(node.classList && node.classList.contains('chip'))) {
      node = node.parentNode;
    }
    if (!node || node === listEl) return null;
    return focusIdFromHash(node.getAttribute('data-activity-id'));
  }

  listEl.addEventListener('click', (event) => {
    const id = chipIdFrom(event.target);
    if (id && id !== view.selectedId) select(id);
  });

  // Keyboard activation for the focusable chips, delegated exactly like the click. Enter and
  // Space are what "activate" means for a role=button; Space is prevented so it selects the chip
  // instead of scrolling the list pane out from under it.
  listEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const id = chipIdFrom(event.target);
    if (!id) return;
    event.preventDefault();
    if (id !== view.selectedId) select(id);
  });

  // Ruling P4-8, second half: main deep-links into an ALREADY OPEN window by re-issuing
  // `loadFile(page, { hash })`. A fragment-only navigation is same-document in Chromium -- the
  // page is NOT reloaded and this function does not run again -- so the new id arrives here as a
  // `hashchange` and nowhere else. (Were some build to reload instead, the initial read above
  // catches it; both paths end in the same `select`.) A fragment that is not a UUIDv4 selects
  // nothing, and one that lands before the first list has painted becomes the pending focus.
  win.addEventListener('hashchange', () => {
    const id = focusIdFromHash(win.location.hash);
    if (!id) return;
    if (listReady) select(id);
    else pendingFocus = id;
  });

  function onFilterChange() {
    view.filter = normalizeFilter({ level: levelEl.value, search: searchEl.value });
    if (view.lens === 'events') paintDetail();
  }
  levelEl.addEventListener('change', onFilterChange);
  searchEl.addEventListener('input', onFilterChange);
  tabs.events.addEventListener('click', () => setLens('events'));
  tabs.problems.addEventListener('click', () => setLens('problems'));

  // -----------------------------------------------------------------------------------------
  // Task 4.5: the action bar.
  // -----------------------------------------------------------------------------------------

  // Re-issues the load. The System section is refreshed alongside it ONLY when it is already
  // expanded -- Ruling P4-1: an ordinary refresh must never touch the shared log files.
  function refreshAll() {
    setStatus('');
    const listed = loadList();
    if (systemEl.open) loadSystem();
    return listed;
  }

  // The whole export happens in main: it validates this filter, builds the redacted text, runs
  // the save dialog and writes the file 0600, then answers the chosen path (or null if the user
  // cancelled). This side supplies exactly one thing -- a filter object built by `normalizeFilter`
  // from the level/search controls, never their raw text -- and displays one fixed line.
  // Re-entrancy is refused so a double-click cannot stack two save dialogs.
  async function doExport() {
    if (exporting) return;
    exporting = true;
    exportEl.disabled = true;
    setStatus('');
    try {
      const saved = await api.export(normalizeFilter(view.filter));
      setStatus(saved ? `${TEXT.exported} ${saved}` : TEXT.exportCancelled);
    } catch (e) {
      // Ruling P4-7: the rejection is opaque -- its code and message are not trustworthy across
      // the bridge and are never inspected, let alone shown. The button itself is the retry.
      setStatus(TEXT.exportError);
    } finally {
      exporting = false;
      exportEl.disabled = false;
    }
  }

  // Per selected item: main turns the id into the activity's own directory under the owned
  // activity root. No path is ever built here.
  async function doReveal() {
    const id = view.selectedId;
    if (!id) return;
    setStatus('');
    try {
      await api.reveal(id);
    } catch (e) {
      setStatus(TEXT.revealError);
    }
  }

  refreshEl.addEventListener('click', refreshAll);
  exportEl.addEventListener('click', doExport);
  revealEl.addEventListener('click', doReveal);
  revealEl.disabled = true; // nothing is selected yet, and a failed first load leaves it that way

  setLens('events'); // paints the empty detail pane ("select an activity") on its way through
  // Returned so a caller (the unit tests) can await the first load; the browser path ignores it.
  return loadList();
}

// The browser entry point. `boot` requires the bridge; this decides whether there is one, and
// says so in the list pane when there is not -- the alternative is a silent blank page, which is
// exactly what a packaging or preload regression looks like during manual acceptance. Exported so
// the tests can drive both halves; the call below runs only in a real window.
function start(win, doc) {
  if (!win || !doc) return null;
  if (win.activityApi) return boot(win, doc, win.activityApi);
  const listEl = doc.getElementById('list');
  if (listEl) {
    listEl.textContent = '';
    listEl.appendChild(el(doc, 'div', 'state state-error', TEXT.bridgeMissing));
  }
  return null;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  start(window, document);
}

// Exported for the plain-Node unit tests; absent in the browser, where nothing defines this.
if (typeof module !== 'undefined') {
  module.exports = {
    sanitizeText, formatTime, formatDuration,
    renderChip, renderEventRow, renderProblemRow, renderStoreState, renderList,
    renderEvents, renderProblems, renderDetail, describeProblem,
    normalizeFilter, matchesEventFilter, focusIdFromHash,
    boot, start,
  };
}
})();
