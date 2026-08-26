'use strict';
// Task 4.3: the System section of the Activity window -- the shared, UNCORRELATED diagnostics.
//
// Why this is a second file: activity.js is already ~550 lines, and this section shares none of
// its DTO shapes. It is loaded by its own <script src> in activity.html (BEFORE activity.js, so
// `window.activitySystem` exists by the time activity.js boots) and publishes its functions on
// `window.activitySystem`. It runs in the same sandboxed, context-isolated window, so it has no
// Node reach and no bridge of its own: activity.js fetches the payload, this file maps it to DOM.
//
// The same two rules activity.js follows apply here, and are proven by the same test file:
//   1. TEXT ONLY. Every string reaching the page is filesystem-derived, i.e. untrusted -- a log
//      tail most of all, since it is raw terminal output. It is placed with `textContent` only,
//      after `sanitizeText` strips ANSI escapes and C0/C1 control characters.
//   2. PURE MAPPING. `renderSystem(doc, system)` takes a `document`-like adapter and attaches no
//      listeners; activity.js owns the disclosure, the Refresh control and the bridge call.
//
// `sanitizeText` and `el` are deliberately re-declared here rather than shared with activity.js:
// a sandboxed page script has no imports, and the alternative (publishing activity.js's helpers
// on the window for this file to borrow) would make the load order load-bearing in both
// directions. They are ~20 lines and each file is independently proven inert by its own
// source-prohibition test.

const TEXT = {
  // The one claim this section exists to make. Stated in fixed text, above everything else: these
  // streams interleave every run of the app and carry no activity id, so nothing here may be read
  // as one attempt's story.
  uncorrelated: 'Shared diagnostics — not tied to any activity',
  absent: 'not present',
  empty: '(empty)',
  onDemand: 'show',
  diagnosticsFailed: 'These diagnostics could not be collected',
  statusHeading: 'Legacy status.json',
  statusAbsent: 'No legacy status.json diagnostics were found.',
  statusUnreadable: 'status.json could not be read',
  errorLogLabel: 'error log',
  noErrors: 'No legacy errors recorded.',
};

// Identical to activity.js's sweep, and in the same order: the multi-character escape sequences
// go FIRST (they are introduced by ESC, which the control sweep would otherwise strip, leaving
// their payload behind as visible junk like "[31m"). A log tail is the likeliest place in the
// whole app to meet these, since it is raw terminal output.
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

// The ONE way any text enters the page.
function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = sanitizeText(text);
  return node;
}

function formatBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// -------------------------------------------------------------------------------------------
// One shared stream
// -------------------------------------------------------------------------------------------

// An absent stream is still NAMED. Silence would read as "this stream is fine"; `menubar.log` in
// particular has no writer in the app today, and a symlink standing where a log should be is a
// refusal the reader deliberately surfaces rather than folding into ordinary absence.
function renderAbsentStream(doc, s) {
  const row = el(doc, 'div', 'system-stream system-absent');
  row.setAttribute('data-stream', s.name);
  row.appendChild(el(doc, 'span', 'system-name', s.name));
  row.appendChild(el(doc, 'span', 'system-note', s.error ? `${TEXT.absent}: ${s.error}` : TEXT.absent));
  return row;
}

function renderStream(doc, stream) {
  const s = stream && typeof stream === 'object' ? stream : {};
  const name = typeof s.name === 'string' ? s.name : '';
  if (!s.present) return renderAbsentStream(doc, { name, error: s.error });

  const block = el(doc, 'details', 'system-stream');
  block.setAttribute('data-stream', name);
  // The two default streams are expanded; the on-demand ones start closed behind a "show"
  // affordance. Their tails are already IN this payload (Ruling P4-1: no second channel) -- the
  // toggle is about screen space, not about fetching.
  if (!s.onDemand) block.setAttribute('open', '');

  const head = el(doc, 'summary', 'system-head');
  head.appendChild(el(doc, 'span', 'system-name', name));
  head.appendChild(el(doc, 'span', 'system-size', formatBytes(s.bytes)));
  if (s.path) head.appendChild(el(doc, 'span', 'system-path', s.path));
  if (s.truncated) head.appendChild(el(doc, 'span', 'system-flag', 'tail truncated'));
  if (s.onDemand) head.appendChild(el(doc, 'span', 'system-flag system-show', TEXT.onDemand));
  block.appendChild(head);

  block.appendChild(el(doc, 'pre', 'system-tail', s.redactedTail ? s.redactedTail : TEXT.empty));
  return block;
}

// -------------------------------------------------------------------------------------------
// The legacy status.json surface
// -------------------------------------------------------------------------------------------

// `fullError` and `stackTrace` are the body of an error row; the row is a native disclosure only
// when there is something to disclose.
function errorBodyText(e) {
  const lines = [];
  const full = sanitizeText(e.fullError);
  if (full) lines.push(full);
  const stack = sanitizeText(e.stackTrace);
  if (stack) lines.push(stack);
  return lines.join('\n');
}

function renderStatusError(doc, entry) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const body = errorBodyText(e);
  const expandable = body.length > 0;

  const row = el(doc, expandable ? 'details' : 'div', 'row system-error');
  const head = el(doc, expandable ? 'summary' : 'div', 'row-head');
  // The timestamp is shown exactly as the legacy file recorded it: this pane is a raw diagnostic
  // surface, and re-formatting a value we did not write would hide a malformed one.
  head.appendChild(el(doc, 'span', 'system-time', e.timestamp ? e.timestamp : '—'));
  head.appendChild(el(doc, 'span', 'system-repo', e.repo ? e.repo : '—'));
  head.appendChild(el(doc, 'span', 'system-message', e.message ? e.message : ''));
  row.appendChild(head);
  if (expandable) row.appendChild(el(doc, 'pre', 'system-detail', body));
  return row;
}

function renderStatus(doc, statusDiagnostics) {
  const st = statusDiagnostics && typeof statusDiagnostics === 'object' ? statusDiagnostics : {};
  const wrap = el(doc, 'div', 'system-status');
  wrap.appendChild(el(doc, 'div', 'system-subhead', TEXT.statusHeading));

  if (!st.present) {
    wrap.appendChild(el(doc, 'div', 'system-note',
      st.error ? `${TEXT.statusUnreadable}: ${st.error}` : TEXT.statusAbsent));
    return wrap;
  }

  const log = st.errorLog && typeof st.errorLog === 'object' ? st.errorLog : {};
  if (log.text) {
    const block = el(doc, 'details', 'system-stream');
    block.setAttribute('open', '');
    const head = el(doc, 'summary', 'system-head');
    head.appendChild(el(doc, 'span', 'system-name', TEXT.errorLogLabel));
    if (log.truncated) head.appendChild(el(doc, 'span', 'system-flag', 'truncated'));
    block.appendChild(head);
    block.appendChild(el(doc, 'pre', 'system-tail', log.text));
    wrap.appendChild(block);
  }

  const list = st.errorList && typeof st.errorList === 'object' ? st.errorList : {};
  const entries = Array.isArray(list.entries) ? list.entries : [];
  if (entries.length === 0) {
    wrap.appendChild(el(doc, 'div', 'system-note', TEXT.noErrors));
    return wrap;
  }
  // The cap is STATED, never silently applied: "50 of 120" is the difference between a bounded
  // view and a wrong one.
  if (list.truncated) {
    wrap.appendChild(el(doc, 'div', 'system-note',
      `${entries.length} of ${list.total} shown (newest first)`));
  }
  for (const entry of entries) wrap.appendChild(renderStatusError(doc, entry));
  return wrap;
}

// -------------------------------------------------------------------------------------------
// The section
// -------------------------------------------------------------------------------------------
function renderSystem(doc, system) {
  const sys = system && typeof system === 'object' ? system : {};
  const wrap = el(doc, 'div', 'system');
  wrap.appendChild(el(doc, 'div', 'system-uncorrelated', TEXT.uncorrelated));
  if (sys.error) {
    // A diagnostics-level failure means nothing below was established. Saying so and STOPPING is
    // the honest rendering: "no legacy errors found" under a failed collection would be a claim
    // this payload cannot support.
    wrap.appendChild(el(doc, 'div', 'system-note state-error', `${TEXT.diagnosticsFailed}: ${sys.error}`));
    return wrap;
  }
  const streams = Array.isArray(sys.streams) ? sys.streams : [];
  for (const s of streams) wrap.appendChild(renderStream(doc, s));
  wrap.appendChild(renderStatus(doc, sys.statusDiagnostics));
  return wrap;
}

// The browser path: activity.js reaches this file through the window (it may not import).
if (typeof window !== 'undefined') {
  window.activitySystem = { renderSystem };
}

// Exported for the plain-Node unit tests; absent in the browser, where nothing defines this.
if (typeof module !== 'undefined') {
  module.exports = { renderSystem };
}
