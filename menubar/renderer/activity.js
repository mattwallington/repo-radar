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
  loading: 'Loading…',
  empty: 'No activity recorded yet.',
  unavailable: 'Activity history is unavailable right now.',
  truncated: 'Older activity is not shown.',
  incomplete: 'Some activity could not be read or verified — this view may be incomplete.',
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
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;    // C0/C1 except \n and \t

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

// The newest-first chip list, plus the three store states the reader reports. Task 4.5 replaces
// these `.state` rows with the first-class three-state UI and adds Refresh/Export/Reveal; the
// class names below (`state-unavailable` / `state-incomplete` / `state-truncated`) are the hooks
// it takes over.
function renderList(doc, result) {
  const res = result && typeof result === 'object' ? result : {};
  const items = Array.isArray(res.items) ? res.items : [];
  const list = el(doc, 'div', 'chip-list');

  if (res.available === false) {
    list.appendChild(el(doc, 'div', 'state state-unavailable', TEXT.unavailable));
    return list;
  }
  if (res.incomplete) list.appendChild(el(doc, 'div', 'state state-incomplete', TEXT.incomplete));
  if (items.length === 0) {
    list.appendChild(el(doc, 'div', 'state state-empty', TEXT.empty));
    return list;
  }
  for (const item of items) list.appendChild(renderChip(doc, item));
  if (res.truncated) list.appendChild(el(doc, 'div', 'state state-truncated', TEXT.truncated));
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
// SAME anomaly (activity/read.js builds both). The array is authoritative (it comes from
// reconcile's own counts and survives problem-row truncation), so it is rendered first and the
// matching rows are filtered out -- otherwise every duplicated outcome would appear twice.
function renderProblems(doc, item) {
  const it = item && typeof item === 'object' ? item : {};
  const dups = Array.isArray(it.duplicateTerminals) ? it.duplicateTerminals : [];
  const rows = (Array.isArray(it.problems) ? it.problems : [])
    .filter((p) => !(p && p.kind === 'duplicate-terminal'));
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

  const view = { lens: 'events', filter: {}, selectedId: null, detail: null };
  let pendingFocus = focusIdFromHash(win.location.hash);

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

  function markSelected() {
    const chips = listEl.querySelectorAll('.chip');
    for (const chip of chips) {
      chip.classList.toggle('selected', chip.getAttribute('data-activity-id') === view.selectedId);
    }
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
      // No filter: `activity:list` ignores level/search for item selection anyway, and an empty
      // object is the only value guaranteed to pass the main side's validator untouched. Task 4.5
      // owns the Refresh/Export controls that will pass `normalizeFilter(...)` here.
      const result = await api.list({});
      put(listEl, renderList(doc, result));
      if (pendingFocus) {
        const id = pendingFocus;
        pendingFocus = null;
        await select(id);
      } else {
        markSelected();
      }
    } catch (e) {
      putError(listEl, loadList);
    }
  }

  // Delegated: the chips themselves are produced by a pure renderer that attaches no listeners.
  listEl.addEventListener('click', (event) => {
    let node = event.target;
    while (node && node !== listEl && !(node.classList && node.classList.contains('chip'))) {
      node = node.parentNode;
    }
    if (!node || node === listEl) return;
    const id = focusIdFromHash(node.getAttribute('data-activity-id'));
    if (id && id !== view.selectedId) select(id);
  });

  function onFilterChange() {
    view.filter = normalizeFilter({ level: levelEl.value, search: searchEl.value });
    if (view.lens === 'events') paintDetail();
  }
  levelEl.addEventListener('change', onFilterChange);
  searchEl.addEventListener('input', onFilterChange);
  tabs.events.addEventListener('click', () => setLens('events'));
  tabs.problems.addEventListener('click', () => setLens('problems'));

  setLens('events'); // paints the empty detail pane ("select an activity") on its way through
  // Returned so a caller (the unit tests) can await the first load; the browser path ignores it.
  return loadList();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && window.activityApi) {
  boot(window, document, window.activityApi);
}

// Exported for the plain-Node unit tests; absent in the browser, where nothing defines this.
if (typeof module !== 'undefined') {
  module.exports = {
    sanitizeText, formatTime, formatDuration,
    renderChip, renderEventRow, renderProblemRow, renderList,
    renderEvents, renderProblems, renderDetail, describeProblem,
    normalizeFilter, matchesEventFilter, focusIdFromHash,
    boot,
  };
}
