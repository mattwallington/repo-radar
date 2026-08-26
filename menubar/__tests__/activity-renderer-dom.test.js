'use strict';
// Task 4.2: the Activity renderer's DTO -> DOM mapping, proven INERT.
//
// The renderer runs sandboxed (contextIsolation on, nodeIntegration off), so its only inputs are
// `window.activityApi` and the DOM. Its DTO -> DOM mapping is therefore factored into pure
// functions that take a `document`-like adapter as their first argument, and this file exercises
// them through a small shim rather than jsdom -- the app has no test-only dependencies and this
// task may not add one.
//
// The shim is deliberately hostile to the failure this task exists to prevent (finding 9): its
// elements have NO markup-parsing property at all -- reading or assigning a markup sink THROWS --
// and its `textContent` getter aggregates only real child nodes. So a render path that built
// markup instead of text would either throw or produce an empty `textContent`, and the
// literal-characters assertions below would fail.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ACTIVITY_JS = path.join(__dirname, '..', 'renderer', 'activity.js');
const R = require(ACTIVITY_JS);
// Task 4.3: the System section lives in its own renderer file (activity.js is already ~550
// lines) and is loaded by a second <script src> in activity.html. It is exercised through the
// SAME shim below -- that is why its tests live here rather than in a second file.
const ACTIVITY_SYSTEM_JS = path.join(__dirname, '..', 'renderer', 'activity-system.js');
const S = require(ACTIVITY_SYSTEM_JS);

const ESC = '\u001b';

// -------------------------------------------------------------------------------------------
// The DOM adapter (test-local; the renderer only ever needs this much of `document`).
// -------------------------------------------------------------------------------------------
const MARKUP_SINKS = ['innerHTML', 'outerHTML'];

function makeElement(tagName) {
  const el = {
    tagName: String(tagName).toUpperCase(),
    className: '',
    children: [],
    attributes: {},
    listeners: [],
    _text: '',
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    setAttribute(name, value) {
      this.attributes[String(name)] = String(value);
    },
    getAttribute(name) {
      const key = String(name);
      return Object.prototype.hasOwnProperty.call(this.attributes, key) ? this.attributes[key] : null;
    },
    addEventListener(type, fn) {
      this.listeners.push([type, fn]);
    },
    insertAdjacentHTML() {
      throw new Error('markup insertion is prohibited in the Activity renderer');
    },
  };
  Object.defineProperty(el, 'textContent', {
    get() {
      return this._text + this.children.map((c) => c.textContent).join('');
    },
    set(value) {
      this._text = value === null || value === undefined ? '' : String(value);
      this.children.length = 0;
    },
    enumerable: true,
    configurable: true,
  });
  for (const sink of MARKUP_SINKS) {
    Object.defineProperty(el, sink, {
      get() { throw new Error(`${sink} is prohibited in the Activity renderer`); },
      set() { throw new Error(`${sink} is prohibited in the Activity renderer`); },
      configurable: true,
    });
  }
  return el;
}

function makeDoc() {
  return {
    createElement: (tag) => makeElement(tag),
    createTextNode: (text) => ({
      nodeType: 3,
      children: [],
      textContent: text === null || text === undefined ? '' : String(text),
    }),
  };
}

// Every element in the tree, self included (text nodes have no tagName and are skipped).
function walk(node, out = []) {
  if (!node || !node.tagName) return out;
  out.push(node);
  for (const child of node.children) walk(child, out);
  return out;
}

// The nodes that actually carry text -- an element with no element children.
function leaves(node) {
  return walk(node).filter((el) => el.children.length === 0);
}

// -------------------------------------------------------------------------------------------
// The hostile payload every render path is fed.
// -------------------------------------------------------------------------------------------
const XSS = '<script>alert(1)</script>';
const ANSI_XSS = `${ESC}[31m${XSS}${ESC}[0m`;                       // SGR-wrapped
const ANSI_NOISE = `${ESC}]0;window title\u0007ok\u0000\u0008 too`; // OSC + C0 noise

function assertInert(node, literal) {
  const text = node.textContent;
  assert.ok(text.includes(literal), `textContent must hold the literal characters, got: ${JSON.stringify(text)}`);
  assert.ok(!text.includes(ESC), 'no ESC may survive into the DOM');
  for (const el of walk(node)) {
    assert.notStrictEqual(el.tagName, 'SCRIPT', 'no script element may ever be produced');
    assert.notStrictEqual(el.tagName, 'IFRAME', 'no iframe element may ever be produced');
  }
  // The element that actually holds the payload must be a LEAF: proof the characters arrived as
  // text, not as parsed markup that grew children.
  const holder = leaves(node).find((el) => el.textContent.includes(literal));
  assert.ok(holder, 'the payload must live on a childless element');
  assert.strictEqual(holder.children.length, 0);
}

// -------------------------------------------------------------------------------------------
// sanitizeText
// -------------------------------------------------------------------------------------------
test('sanitizeText strips ANSI sequences and control characters, keeping newline and tab', () => {
  assert.strictEqual(R.sanitizeText(`${ESC}[31mred${ESC}[0m`), 'red');
  assert.strictEqual(R.sanitizeText(`${ESC}[1;32;40mx${ESC}[m`), 'x');
  assert.strictEqual(R.sanitizeText(`${ESC}]0;title\u0007after`), 'after');
  assert.strictEqual(R.sanitizeText(`${ESC}]8;;https://example.com${ESC}\\link`), 'link');
  assert.strictEqual(R.sanitizeText('a\u0000b\u0007c\u001fd'), 'abcd');
  assert.strictEqual(R.sanitizeText('a\u009bb'), 'ab', 'C1 controls go too');
  assert.strictEqual(R.sanitizeText('keep\nthese\ttwo'), 'keep\nthese\ttwo');
  assert.strictEqual(R.sanitizeText('drop\rthis'), 'dropthis');
  assert.strictEqual(R.sanitizeText(XSS), XSS, 'markup characters are ordinary text, never removed');
});

test('sanitizeText coerces non-strings and never returns null or undefined', () => {
  assert.strictEqual(R.sanitizeText(null), '');
  assert.strictEqual(R.sanitizeText(undefined), '');
  assert.strictEqual(R.sanitizeText(42), '42');
  assert.strictEqual(R.sanitizeText(false), 'false');
});

// -------------------------------------------------------------------------------------------
// renderChip / renderEventRow / renderProblemRow inertness
// -------------------------------------------------------------------------------------------
const CHIP_DTO = Object.freeze({
  id: '11111111-2222-4333-8444-555555555555',
  outcome: 'failed',
  startedAt: '2026-08-14T10:00:00.000Z',
  endedAt: '2026-08-14T10:00:12.500Z',
  duration: 12500,
  channel: ANSI_XSS,
  trigger: 'manual',
  kind: 'sync',
  errorCount: 2,
  warnCount: 1,
  problemCount: 3,
  hasProblems: true,
  incomplete: false,
  synthesized: false,
});

test('renderChip inserts hostile DTO text as inert characters', () => {
  const chip = R.renderChip(makeDoc(), CHIP_DTO);
  assertInert(chip, XSS);
  assert.strictEqual(chip.getAttribute('data-activity-id'), CHIP_DTO.id);
  assert.deepStrictEqual(chip.listeners, [], 'the pure renderer attaches no listeners (the list delegates)');
});

test('renderChip refuses to carry a non-UUID id into the DOM', () => {
  const chip = R.renderChip(makeDoc(), Object.assign({}, CHIP_DTO, { id: '../../etc/passwd' }));
  assert.strictEqual(chip.getAttribute('data-activity-id'), '');
});

test('renderChip marks the outcome with an allowlisted class, never the raw string', () => {
  const good = R.renderChip(makeDoc(), CHIP_DTO);
  assert.ok(walk(good).some((el) => el.className.includes('dot-failed')));
  const evil = R.renderChip(makeDoc(), Object.assign({}, CHIP_DTO, { outcome: 'failed" onload="x' }));
  const classes = walk(evil).map((el) => el.className).join(' ');
  assert.ok(!classes.includes('onload'), 'an unknown outcome never reaches a class name');
  assert.ok(classes.includes('dot-unknown'));
});

test('renderEventRow inserts hostile event text as inert characters and keeps detail expandable', () => {
  const row = R.renderEventRow(makeDoc(), {
    ts: '2026-08-14T10:00:03.000Z',
    seq: 3,
    level: 'error',
    event: XSS,
    detail: ANSI_NOISE,
    fields: { [ANSI_XSS]: ANSI_XSS },
  });
  assertInert(row, XSS);
  assert.strictEqual(row.tagName, 'DETAILS', 'a row with detail or fields is natively expandable');
  assert.ok(walk(row).some((el) => el.tagName === 'SUMMARY'), 'the head line is the disclosure summary');
  assert.deepStrictEqual(row.listeners, []);
});

test('renderEventRow without detail or fields is a plain row', () => {
  const row = R.renderEventRow(makeDoc(), {
    ts: '2026-08-14T10:00:03.000Z', seq: 1, level: 'info', event: 'started', detail: null, fields: {},
  });
  assert.strictEqual(row.tagName, 'DIV');
  assert.ok(row.textContent.includes('started'));
});

test('renderProblemRow inserts hostile problem text as inert characters', () => {
  const row = R.renderProblemRow(makeDoc(), {
    kind: 'event', level: 'error', ts: '2026-08-14T10:00:04.000Z', event: XSS, detail: ANSI_NOISE, fields: {},
  });
  assertInert(row, XSS);
});

test('renderProblemRow describes every problem kind the reader can emit', () => {
  const doc = makeDoc();
  const cases = [
    [{ kind: 'terminal', outcome: 'failed', count: 2, ts: 't', by: 'w', summary: { reason: 'boom' } }, 'boom'],
    [{ kind: 'duplicate-terminal', outcome: 'succeeded', count: 3 }, '3'],
    [{ kind: 'rejected-segment', name: 'weird.jsonl', reason: 'bad-name' }, 'bad-name'],
    [{ kind: 'rejected-activity', id: 'abc', reason: 'symlink' }, 'symlink'],
    [{ kind: 'integrity', reason: 'no-start', detail: 'no valid start record found' }, 'no-start'],
    [{ kind: 'truncated', dropped: 7 }, '7'],
    [{ kind: 'corrupt-record', reason: 'bad json', index: 4 }, 'bad json'],
    [{ kind: 'internal-error', reason: 'kaboom' }, 'kaboom'],
  ];
  for (const [problem, needle] of cases) {
    const row = R.renderProblemRow(doc, problem);
    assert.ok(row.textContent.includes(needle), `${problem.kind} row must mention ${needle}`);
    assert.ok(row.textContent.includes(problem.kind), `${problem.kind} row must name its kind`);
  }
});

// -------------------------------------------------------------------------------------------
// renderList
// -------------------------------------------------------------------------------------------
function listResult(over) {
  return Object.assign({ items: [], truncated: false, available: true, incomplete: false, problems: [] }, over);
}

test('renderList renders one chip per item, in the order the reader returned them', () => {
  const items = ['a', 'b', 'c'].map((tag, i) => Object.assign({}, CHIP_DTO, {
    id: `1111111${i}-2222-4333-8444-555555555555`, trigger: tag,
  }));
  const list = R.renderList(makeDoc(), listResult({ items }));
  const chips = walk(list).filter((el) => el.className.split(' ').includes('chip'));
  assert.strictEqual(chips.length, 3);
  assert.deepStrictEqual(chips.map((c) => c.getAttribute('data-activity-id')), items.map((i) => i.id));
});

test('renderList shows the empty, unavailable, truncated and incomplete states', () => {
  const stateText = (result) => walk(R.renderList(makeDoc(), result))
    .filter((el) => el.className.split(' ').includes('state'))
    .map((el) => el.textContent).join(' | ');

  assert.match(stateText(listResult({})), /no activity/i);
  assert.match(stateText(listResult({ available: false })), /unavailable/i);
  assert.match(stateText(listResult({ items: [CHIP_DTO], truncated: true })), /older/i);
  assert.match(stateText(listResult({ items: [CHIP_DTO], incomplete: true })), /incomplete|could not be read/i);
});

test('renderList tolerates a malformed response without throwing', () => {
  for (const bad of [null, undefined, {}, { items: null }, { items: [null] }]) {
    const list = R.renderList(makeDoc(), bad);
    assert.ok(list && list.tagName === 'DIV');
  }
});

// -------------------------------------------------------------------------------------------
// The client-side Events filter (activity:get takes an id only -- see the report).
// -------------------------------------------------------------------------------------------
test('normalizeFilter only ever produces values the main-side validator accepts', () => {
  assert.deepStrictEqual(R.normalizeFilter({ level: 'warn', search: '  boom  ' }), { level: 'warn', search: 'boom' });
  assert.deepStrictEqual(R.normalizeFilter({ level: 'all', search: '' }), {});
  assert.deepStrictEqual(R.normalizeFilter({ level: 'trace' }), {}, 'an unknown level is dropped, never sent');
  assert.deepStrictEqual(R.normalizeFilter({}), {});
  assert.deepStrictEqual(R.normalizeFilter(null), {});
  const long = R.normalizeFilter({ search: 'x'.repeat(1000) });
  assert.strictEqual(long.search.length, 256, 'search is trimmed to the reader SEARCH_MAX');
});

test('matchesEventFilter filters by level and by literal (never regex) substring', () => {
  const rec = { level: 'warn', event: 'rate-limited', detail: 'retry in 30s', fields: { repo: 'acme/widgets' } };
  assert.ok(R.matchesEventFilter(rec, {}));
  assert.ok(R.matchesEventFilter(rec, { level: 'warn' }));
  assert.ok(!R.matchesEventFilter(rec, { level: 'error' }));
  assert.ok(R.matchesEventFilter(rec, { search: 'RATE' }), 'search is case-insensitive');
  assert.ok(R.matchesEventFilter(rec, { search: 'acme/widgets' }), 'fields are searched too');
  assert.ok(!R.matchesEventFilter(rec, { search: 'r.te-limited' }), 'a regex metacharacter is a literal');
  assert.ok(R.matchesEventFilter({ level: 'info', event: `${ESC}[31mboom` }, { search: 'boom' }),
    'search runs over the sanitized text the user actually sees');
});

// -------------------------------------------------------------------------------------------
// Deep link (Ruling P4-8)
// -------------------------------------------------------------------------------------------
test('focusIdFromHash accepts only a UUIDv4 fragment', () => {
  assert.strictEqual(R.focusIdFromHash('#11111111-2222-4333-8444-555555555555'), '11111111-2222-4333-8444-555555555555');
  assert.strictEqual(R.focusIdFromHash('11111111-2222-4333-8444-555555555555'), '11111111-2222-4333-8444-555555555555');
  assert.strictEqual(R.focusIdFromHash('#11111111-2222-4333-8444-555555555555/../x'), null);
  assert.strictEqual(R.focusIdFromHash('#11111111-2222-1333-8444-555555555555'), null, 'version nibble must be 4');
  assert.strictEqual(R.focusIdFromHash('#11111111-2222-4333-C444-555555555555'), null, 'uppercase is not accepted');
  assert.strictEqual(R.focusIdFromHash('#'), null);
  assert.strictEqual(R.focusIdFromHash(''), null);
  assert.strictEqual(R.focusIdFromHash(null), null);
});

// -------------------------------------------------------------------------------------------
// Source prohibition (finding 9): a hard guard, independent of any behavioural test.
// -------------------------------------------------------------------------------------------
test('renderer/activity.js never names a markup sink', () => {
  const src = fs.readFileSync(ACTIVITY_JS, 'utf8');
  for (const sink of ['inner' + 'HTML', 'outer' + 'HTML', 'insertAdjacent' + 'HTML',
    'document.' + 'write', 'createContextualFragment']) {
    assert.strictEqual(src.includes(sink), false, `renderer/activity.js must never name ${sink}`);
  }
  assert.strictEqual(/\beval\s*\(/.test(src), false, 'no eval');
  assert.strictEqual(/\bnew\s+Function\s*\(/.test(src), false, 'no Function constructor');
});

test('renderer/activity.js is sandbox-safe: no require, no Node globals', () => {
  const src = fs.readFileSync(ACTIVITY_JS, 'utf8');
  assert.strictEqual(/\brequire\s*\(/.test(src), false, 'a sandboxed renderer has no require');
  assert.strictEqual(/\bprocess\./.test(src), false, 'no process access');
  assert.strictEqual(/\b__dirname\b|\b__filename\b/.test(src), false, 'no Node path globals');
  // The ONE Node reference allowed is the typeof-guarded CommonJS export that lets these tests
  // load the file at all.
  const moduleRefs = src.match(/\bmodule\b/g) || [];
  assert.strictEqual(moduleRefs.length, 2, 'module is named exactly twice: the typeof guard and the export');
  assert.ok(/typeof module !== 'undefined'/.test(src), 'the export is typeof-guarded for the browser');
});

// -------------------------------------------------------------------------------------------
// boot(): the live-page half. Rulings P4-7 (opaque rejections -> ONE generic line + Retry) and
// P4-8 (a UUIDv4 fragment selects an item after the first list load) only really exist here, so
// the shim above is extended with the handful of live-DOM affordances boot uses -- getElementById,
// classList, querySelectorAll('.chip'), parentNode -- and driven with a fake `activityApi`.
// -------------------------------------------------------------------------------------------
// `extra` carries the event properties a specific handler reads -- Task 4.5's delegated keyboard
// activation needs `key` and a real `preventDefault` (Space would otherwise scroll the pane).
function fire(node, type, target, extra) {
  for (const [t, fn] of node.listeners) if (t === type) fn(Object.assign({ target: target || node }, extra));
}

function livePage() {
  const byId = {};
  const doc = makeDoc();
  const base = doc.createElement;
  doc.createElement = (tag) => {
    const node = base(tag);
    const push = node.appendChild;
    node.appendChild = function (child) { child.parentNode = this; return push.call(this, child); };
    node.classList = {
      contains: (c) => node.className.split(' ').includes(c),
      add: (c) => { if (!node.className.split(' ').includes(c)) node.className = `${node.className} ${c}`.trim(); },
      remove: (c) => { node.className = node.className.split(' ').filter((x) => x && x !== c).join(' '); },
      toggle: (c, on) => (on ? node.classList.add(c) : node.classList.remove(c)),
    };
    node.querySelectorAll = (selector) => {
      const cls = selector.replace('.', '');
      return walk(node).filter((e) => e !== node && e.className.split(' ').includes(cls));
    };
    return node;
  };
  for (const id of ['list', 'detail', 'event-level', 'event-search', 'event-filters', 'tab-events',
    'tab-problems', 'system', 'system-body',
    // Task 4.5: the action bar (Refresh / Export / Reveal) and its status line.
    'btn-refresh', 'btn-export', 'btn-reveal', 'action-status']) {
    byId[id] = doc.createElement('div');
    byId[id].value = '';
  }
  byId.system.open = false; // the <details> the System disclosure really is
  doc.getElementById = (id) => byId[id];
  return { doc, byId };
}

// The Activity window is deep-linked into WHILE OPEN by re-issuing loadFile(page, { hash }),
// which Chromium delivers as a same-document `hashchange` -- so a fake window has to be able to
// navigate, not just report an initial fragment.
function fakeWindow(hash) {
  // `activitySystem` is what the second <script src> publishes; activity.js reaches the System
  // renderer through the window exactly as it does in the browser (it may not `require`).
  const win = { location: { hash: hash || '' }, listeners: [], activitySystem: S };
  win.addEventListener = (type, fn) => { win.listeners.push([type, fn]); };
  win.navigate = (next) => {
    win.location.hash = next;
    for (const [type, fn] of win.listeners) if (type === 'hashchange') fn({ type: 'hashchange' });
  };
  return win;
}

// What the main-side save dialog hands back. It is a real filesystem path, so the renderer shows
// it as text through the same scrubber everything else goes through -- it is not renderer input,
// but it is not renderer-authored either.
const EXPORT_PATH = '/Users/someone/Desktop/repo-radar-activity-2026-08-26.txt';

function fakeApi(over) {
  const calls = [];
  const api = {
    list: async (filter) => { calls.push(['list', filter]); return { items: [], truncated: false, available: true, incomplete: false, problems: [] }; },
    get: async (id) => { calls.push(['get', id]); return { item: null, available: true, reason: 'missing' }; },
    // Task 4.5: both are recorded like the other two. `export` answers a path (the main side
    // resolves it from the OS save dialog); `reveal` answers `true` once dispatched.
    export: async (filter) => { calls.push(['export', filter]); return EXPORT_PATH; },
    reveal: async (activityId) => { calls.push(['reveal', activityId]); return true; },
  };
  return { api: Object.assign(api, over), calls };
}

const LIVE_ITEM = Object.assign({}, CHIP_DTO, { channel: 'sync', outcome: 'succeeded-with-warnings' });
const LIVE_DETAIL = {
  item: Object.assign({}, LIVE_ITEM, {
    events: [
      { ts: '2026-08-14T10:00:01.000Z', seq: 1, level: 'info', event: 'started', detail: null, fields: {} },
      { ts: '2026-08-14T10:00:02.000Z', seq: 2, level: 'warn', event: 'rate-limited', detail: 'retry in 30s', fields: {} },
    ],
    truncatedEvents: false,
    duplicateTerminals: [{ outcome: 'succeeded', count: 2 }],
    problems: [
      { kind: 'duplicate-terminal', outcome: 'succeeded', count: 2 },
      { kind: 'event', level: 'warn', ts: '2026-08-14T10:00:02.000Z', event: 'rate-limited', detail: 'retry in 30s', fields: {} },
    ],
  }),
  available: true,
};

test('boot loads the list and selects a chip through delegated clicks', async () => {
  const { doc, byId } = livePage();
  const { api, calls } = fakeApi({
    list: async (filter) => { calls.push(['list', filter]); return { items: [LIVE_ITEM], truncated: false, available: true, incomplete: false, problems: [] }; },
    get: async (id) => { calls.push(['get', id]); return LIVE_DETAIL; },
  });
  await R.boot(fakeWindow(''), doc, api);

  assert.deepStrictEqual(calls, [['list', {}]], 'the first load sends an empty (always-valid) filter');
  const chip = byId.list.querySelectorAll('.chip')[0];
  assert.ok(chip, 'the list painted a chip');

  // Click a span INSIDE the chip: the handler must walk up to the chip itself.
  fire(byId.list, 'click', walk(chip).find((el) => el.className === 'chip-source'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepStrictEqual(calls[1], ['get', LIVE_ITEM.id]);
  assert.ok(chip.classList.contains('selected'), 'the clicked chip is marked selected');
  assert.ok(byId.detail.textContent.includes('rate-limited'), 'the Events lens painted');
});

test('boot honours a UUIDv4 fragment and ignores anything else (P4-8)', async () => {
  for (const [hash, expected] of [['#' + LIVE_ITEM.id, [['list', {}], ['get', LIVE_ITEM.id]]],
    ['#not-an-id', [['list', {}]]], ['', [['list', {}]]]]) {
    const { doc } = livePage();
    const { api, calls } = fakeApi({
      list: async (filter) => { calls.push(['list', filter]); return { items: [LIVE_ITEM], truncated: false, available: true, incomplete: false, problems: [] }; },
      get: async (id) => { calls.push(['get', id]); return LIVE_DETAIL; },
    });
    await R.boot(fakeWindow(hash), doc, api);
    assert.deepStrictEqual(calls, expected, `hash ${JSON.stringify(hash)}`);
  }
});

test('boot switches lenses and applies the level/search filter client-side', async () => {
  const { doc, byId } = livePage();
  const { api, calls } = fakeApi({
    list: async (filter) => { calls.push(['list', filter]); return { items: [LIVE_ITEM], truncated: false, available: true, incomplete: false, problems: [] }; },
    get: async (id) => { calls.push(['get', id]); return LIVE_DETAIL; },
  });
  await R.boot(fakeWindow('#' + LIVE_ITEM.id), doc, api);
  assert.strictEqual(calls.length, 2);

  // Filtering never re-crosses the bridge: `activity:get` takes an id only.
  byId['event-level'].value = 'error';
  fire(byId['event-level'], 'change');
  assert.strictEqual(calls.length, 2, 'no extra IPC call for a filter change');
  assert.ok(byId.detail.textContent.includes('No events match'));

  byId['event-level'].value = 'warn';
  byId['event-search'].value = 'RATE';
  fire(byId['event-search'], 'input');
  assert.ok(byId.detail.textContent.includes('rate-limited'));
  assert.ok(!byId.detail.textContent.includes('started'), 'the info row is filtered out');

  fire(byId['tab-problems'], 'click');
  assert.ok(byId['tab-problems'].classList.contains('active'));
  assert.ok(byId['event-filters'].classList.contains('hidden'), 'the Events filters hide on the Problems lens');
  const text = byId.detail.textContent;
  assert.ok(text.includes('duplicate-terminal') && text.includes('recorded 2 times'));
  assert.strictEqual(text.split('duplicate-terminal').length - 1, 1,
    'a duplicated terminal is shown once, not once per representation');
  assert.strictEqual(calls.length, 2, 'switching lenses never re-crosses the bridge either');
});

test('a rejected bridge call shows one generic line plus Retry, never the error itself (P4-7)', async () => {
  const { doc, byId } = livePage();
  let attempts = 0;
  const { api } = fakeApi({
    list: async () => {
      attempts += 1;
      if (attempts === 1) {
        const e = new Error('EACCES: permission denied, open /Users/someone/.repo-radar/activity');
        e.code = 'internal';
        throw e;
      }
      return { items: [LIVE_ITEM], truncated: false, available: true, incomplete: false, problems: [] };
    },
  });
  await R.boot(fakeWindow(''), doc, api);

  const shown = byId.list.textContent;
  assert.match(shown, /couldn’t be loaded/);
  assert.ok(!shown.includes('EACCES'), 'the underlying error text never reaches the page');
  assert.ok(!shown.includes('/Users/'), 'no path from a main-side error is echoed');
  assert.ok(!shown.includes('internal'), 'the error code is never surfaced or branched on');

  const retry = walk(byId.list).find((el) => el.tagName === 'BUTTON');
  assert.ok(retry, 'a Retry control is offered');
  fire(retry, 'click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(attempts, 2);
  assert.strictEqual(byId.list.querySelectorAll('.chip').length, 1, 'the retry repainted the list');
});

test('a rejected activity:get leaves the list intact and offers Retry for that item only', async () => {
  const { doc, byId } = livePage();
  const { api } = fakeApi({
    list: async () => ({ items: [LIVE_ITEM], truncated: false, available: true, incomplete: false, problems: [] }),
    get: async () => { throw new Error('invalid activity request'); },
  });
  await R.boot(fakeWindow('#' + LIVE_ITEM.id), doc, api);

  assert.strictEqual(byId.list.querySelectorAll('.chip').length, 1, 'the list survived');
  assert.match(byId.detail.textContent, /couldn’t be loaded/);
  assert.ok(walk(byId.detail).some((el) => el.tagName === 'BUTTON'));
});

test('boot renders the reader null-item reasons rather than treating them as failures', async () => {
  for (const [reason, needle] of [['missing', /no longer on disk/], ['unreadable', /could not be read/],
    ['not-started', /hasn’t started/], ['unavailable', /unavailable/]]) {
    const { doc, byId } = livePage();
    const { api } = fakeApi({
      list: async () => ({ items: [LIVE_ITEM], truncated: false, available: true, incomplete: false, problems: [] }),
      get: async () => ({ item: null, available: reason !== 'unavailable', reason }),
    });
    await R.boot(fakeWindow('#' + LIVE_ITEM.id), doc, api);
    assert.match(byId.detail.textContent, needle, reason);
    assert.ok(!walk(byId.detail).some((el) => el.tagName === 'BUTTON'), `${reason} is not an error`);
  }
});

// -------------------------------------------------------------------------------------------
// Fix round 1, finding 1: the two duplicate-terminal sources disagree in BOTH directions, so
// de-duplicating on either one alone loses the anomaly. `item.problems`' rows come from read.js's
// own fresh segment scan (`_groupTerminals(merged)`); `item.duplicateTerminals` comes from
// `rec.duplicateTerminalCounts`, which reconcile.js returns as `{}` on six of its eight exits.
// -------------------------------------------------------------------------------------------
function problemsOf(item) {
  return walk(R.renderProblems(makeDoc(), item))
    .filter((el) => el.className.split(' ').includes('problem'));
}

const DUP_ROW = { kind: 'duplicate-terminal', outcome: 'succeeded', count: 2 };

test('a duplicate-terminal problem row survives an EMPTY duplicateTerminals array', () => {
  // The reconcile-derived array is empty (synthesize path); only the fresh scan saw the anomaly.
  const rows = problemsOf({ events: [], problems: [DUP_ROW], duplicateTerminals: [] });
  assert.strictEqual(rows.length, 1, 'the anomaly must still be rendered');
  assert.ok(rows[0].textContent.includes('duplicate-terminal'));
  assert.ok(rows[0].textContent.includes('recorded 2 times'));
});

test('a duplicateTerminals entry survives problem-row truncation dropping its row', () => {
  const rows = problemsOf({
    events: [], duplicateTerminals: [{ outcome: 'succeeded', count: 2 }],
    problems: [{ kind: 'truncated', dropped: 12 }],
  });
  const kinds = rows.map((r) => r.textContent);
  assert.strictEqual(rows.length, 2);
  assert.ok(kinds.some((t) => t.includes('duplicate-terminal') && t.includes('recorded 2 times')));
  assert.ok(kinds.some((t) => t.includes('truncated')));
});

test('an anomaly reported by BOTH sources is rendered exactly once', () => {
  const rows = problemsOf({
    events: [], problems: [DUP_ROW], duplicateTerminals: [{ outcome: 'succeeded', count: 2 }],
  });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].textContent.split('duplicate-terminal').length - 1, 1);
});

test('duplicate-terminal rows for outcomes the array does not cover are kept', () => {
  const rows = problemsOf({
    events: [],
    problems: [DUP_ROW, { kind: 'duplicate-terminal', outcome: 'failed', count: 3 }],
    duplicateTerminals: [{ outcome: 'succeeded', count: 2 }],
  });
  const text = rows.map((r) => r.textContent).join(' | ');
  assert.strictEqual(rows.length, 2, 'succeeded from the array, failed from the problem row');
  assert.ok(text.includes('succeeded recorded 2 times'));
  assert.ok(text.includes('failed recorded 3 times'));
});

// -------------------------------------------------------------------------------------------
// Fix round 1, finding 2: deep-linking into an ALREADY OPEN window. main re-issues
// loadFile(page, { hash }); Chromium delivers that as a same-document `hashchange`, so the
// renderer must listen for it -- reading location.hash once at boot drops the new id.
// -------------------------------------------------------------------------------------------
const OTHER_ID = '22222222-3333-4333-9444-666666666666';

function bootedList(hash) {
  const { doc, byId } = livePage();
  const { api, calls } = fakeApi({
    list: async (filter) => { calls.push(['list', filter]); return { items: [LIVE_ITEM, Object.assign({}, LIVE_ITEM, { id: OTHER_ID })], truncated: false, available: true, incomplete: false, problems: [] }; },
    get: async (id) => { calls.push(['get', id]); return LIVE_DETAIL; },
  });
  const win = fakeWindow(hash);
  return { doc, byId, api, calls, win, booted: R.boot(win, doc, api) };
}

test('a hashchange with a new UUIDv4 selects that activity in the open window (P4-8)', async () => {
  const t = bootedList('');
  await t.booted;
  assert.deepStrictEqual(t.calls, [['list', {}]], 'no selection yet');

  t.win.navigate(`#${OTHER_ID}`);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepStrictEqual(t.calls[1], ['get', OTHER_ID]);
  const selected = t.byId.list.querySelectorAll('.chip').filter((c) => c.classList.contains('selected'));
  assert.strictEqual(selected.length, 1);
  assert.strictEqual(selected[0].getAttribute('data-activity-id'), OTHER_ID);
});

test('a hashchange re-selects even when another activity was already open', async () => {
  const t = bootedList(`#${LIVE_ITEM.id}`);
  await t.booted;
  assert.deepStrictEqual(t.calls, [['list', {}], ['get', LIVE_ITEM.id]]);

  t.win.navigate(`#${OTHER_ID}`);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepStrictEqual(t.calls[2], ['get', OTHER_ID]);
  const selected = t.byId.list.querySelectorAll('.chip').filter((c) => c.classList.contains('selected'));
  assert.deepStrictEqual(selected.map((c) => c.getAttribute('data-activity-id')), [OTHER_ID]);
});

test('a hashchange the renderer cannot vouch for selects nothing', async () => {
  for (const bad of ['#not-an-id', '#../../etc/passwd', `#${OTHER_ID}/../x`, '#', '']) {
    const t = bootedList('');
    await t.booted;
    t.win.navigate(bad);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(t.calls, [['list', {}]], `hash ${JSON.stringify(bad)} must select nothing`);
  }
});

test('a hashchange that lands before the first list paints is applied after it', async () => {
  const { doc, byId } = livePage();
  let releaseList;
  const gate = new Promise((resolve) => { releaseList = resolve; });
  const { api, calls } = fakeApi({
    list: async (filter) => {
      calls.push(['list', filter]);
      await gate;
      return { items: [LIVE_ITEM, Object.assign({}, LIVE_ITEM, { id: OTHER_ID })], truncated: false, available: true, incomplete: false, problems: [] };
    },
    get: async (id) => { calls.push(['get', id]); return LIVE_DETAIL; },
  });
  const win = fakeWindow('');
  const booted = R.boot(win, doc, api);

  win.navigate(`#${OTHER_ID}`); // arrives while the list request is still in flight
  assert.deepStrictEqual(calls, [['list', {}]], 'nothing is fetched before the list has painted');

  releaseList();
  await booted;

  assert.deepStrictEqual(calls, [['list', {}], ['get', OTHER_ID]], 'the pending focus is honoured');
  assert.ok(byId.detail.textContent.includes('rate-limited'));
});

// -------------------------------------------------------------------------------------------
// Task 4.3: the System section (renderer/activity-system.js).
//
// These are the app's SHARED log streams and the legacy status.json error surface -- deliberately
// uncorrelated with any activity. The section therefore says so on its face, never mixes into the
// item list or the Problems lens, and (like every other render path here) puts untrusted text on
// the page as literal characters only.
// -------------------------------------------------------------------------------------------
function systemPayload(over) {
  return Object.assign({
    uncorrelated: true,
    streams: [
      { name: 'sync.error.log', path: '~/Library/Logs/repo-radar/sync.error.log', present: true, onDemand: false, bytes: 2048, truncated: false, redactedTail: 'boom\n' },
      { name: 'menubar.log', present: false, onDemand: false, bytes: 0, truncated: false, redactedTail: '' },
      { name: 'sync.log', path: '~/Library/Logs/repo-radar/sync.log', present: true, onDemand: true, bytes: 10, truncated: true, redactedTail: '--- tail truncated at 64 KiB ---\nrest\n' },
      { name: 'renderer.log', present: false, onDemand: true, bytes: 0, truncated: false, redactedTail: '', error: 'symlink' },
    ],
    statusDiagnostics: {
      present: true,
      errorLog: { text: 'legacy log text', truncated: false },
      errorList: {
        entries: [{ timestamp: '2026-08-14T10:00:00.000Z', repo: 'acme/widgets', message: 'clone failed', fullError: 'fatal: no remote', stackTrace: null }],
        total: 1,
        truncated: false,
      },
    },
  }, over);
}

test('renderSystem states, in fixed text, that these streams are uncorrelated', () => {
  const node = S.renderSystem(makeDoc(), systemPayload());
  assert.ok(node.textContent.includes('Shared diagnostics — not tied to any activity'));
});

test('renderSystem inserts a hostile stream tail as inert characters', () => {
  const node = S.renderSystem(makeDoc(), systemPayload({
    streams: [{ name: 'sync.error.log', present: true, onDemand: false, bytes: 9, truncated: false, redactedTail: ANSI_XSS }],
  }));
  assertInert(node, XSS);
});

test('renderSystem inserts hostile legacy status text as inert characters', () => {
  const node = S.renderSystem(makeDoc(), systemPayload({
    statusDiagnostics: {
      present: true,
      errorLog: { text: ANSI_NOISE, truncated: false },
      errorList: {
        entries: [{ timestamp: 'x', repo: ANSI_XSS, message: 'm', fullError: 'f', stackTrace: 's' }],
        total: 1, truncated: false,
      },
    },
  }));
  assertInert(node, XSS);
});

test('the two default streams are open and the on-demand ones are collapsed behind "show"', () => {
  const node = S.renderSystem(makeDoc(), systemPayload());
  const blocks = walk(node).filter((e) => e.className.split(' ').includes('system-stream'));
  const byName = {};
  for (const b of blocks) byName[b.getAttribute('data-stream')] = b;

  assert.strictEqual(byName['sync.error.log'].tagName, 'DETAILS');
  assert.strictEqual(byName['sync.error.log'].getAttribute('open'), '');
  assert.strictEqual(byName['sync.log'].getAttribute('open'), null, 'an on-demand stream starts closed');
  assert.ok(byName['sync.log'].textContent.includes('show'), 'and offers a "show" affordance');
  assert.ok(!byName['sync.error.log'].textContent.includes('show'));
});

test('a stream tail lands in a <pre>, as text, on a childless element', () => {
  const node = S.renderSystem(makeDoc(), systemPayload());
  const pres = walk(node).filter((e) => e.tagName === 'PRE');
  assert.ok(pres.length >= 1);
  const holder = pres.find((e) => e.textContent.includes('boom'));
  assert.ok(holder, 'the tail is rendered');
  assert.strictEqual(holder.children.length, 0, 'text only -- never parsed markup');
});

test('an absent stream is shown as "not present", with its refusal reason when there is one', () => {
  const node = S.renderSystem(makeDoc(), systemPayload());
  const text = node.textContent;
  assert.ok(text.includes('menubar.log'), 'an absent stream is still named');
  assert.ok(text.includes('not present'));
  assert.ok(text.includes('symlink'), 'a refusal reason is shown, not hidden as plain absence');
});

test('renderSystem shows the truncation marker the reader produced', () => {
  const node = S.renderSystem(makeDoc(), systemPayload());
  assert.ok(node.textContent.includes('--- tail truncated at 64 KiB ---'));
});

test('renderSystem renders the legacy errorList as rows, with an honest count when capped', () => {
  const node = S.renderSystem(makeDoc(), systemPayload({
    statusDiagnostics: {
      present: true,
      errorLog: { text: '', truncated: false },
      errorList: {
        entries: [
          { timestamp: '2026-08-14T10:00:00.000Z', repo: 'a/b', message: 'first', fullError: 'details one', stackTrace: 'at x' },
          { timestamp: '2026-08-14T09:00:00.000Z', repo: 'c/d', message: 'second', fullError: '', stackTrace: null },
        ],
        total: 120, truncated: true,
      },
    },
  }));
  const rows = walk(node).filter((e) => e.className.split(' ').includes('system-error'));
  assert.strictEqual(rows.length, 2);
  assert.ok(rows[0].textContent.includes('first'));
  assert.ok(rows[0].textContent.includes('a/b'));
  assert.ok(rows[0].textContent.includes('details one'));
  assert.ok(rows[0].textContent.includes('at x'));
  assert.ok(node.textContent.includes('2 of 120'), 'the cap is stated, never silently applied');
});

test('an absent or unreadable legacy status file says so', () => {
  const absent = S.renderSystem(makeDoc(), systemPayload({
    statusDiagnostics: { present: false, errorLog: { text: '', truncated: false }, errorList: { entries: [], total: 0, truncated: false } },
  }));
  assert.ok(absent.textContent.includes('status.json'));

  const broken = S.renderSystem(makeDoc(), systemPayload({
    statusDiagnostics: { present: false, errorLog: { text: '', truncated: false }, errorList: { entries: [], total: 0, truncated: false }, error: 'parse-failed' },
  }));
  assert.ok(broken.textContent.includes('parse-failed'));
});

test('a present-but-malformed status file is reported instead of "no legacy errors"', () => {
  const node = S.renderSystem(makeDoc(), systemPayload({
    statusDiagnostics: {
      present: true,
      errorLog: { text: 'real log text', truncated: false },
      errorList: { entries: [], total: 0, truncated: false },
      error: 'errorList-not-array',
    },
  }));
  const text = node.textContent;
  assert.ok(text.includes('errorList-not-array'), 'the malformation is named');
  assert.ok(!text.includes('No legacy errors recorded'),
    'a field we could not read cannot be reported as empty');
  assert.ok(text.includes('real log text'), 'the readable half is still shown');
});

test('a diagnostics-level failure is shown rather than swallowed', () => {
  const node = S.renderSystem(makeDoc(), { uncorrelated: true, streams: [], error: 'diagnostics failed' });
  assert.ok(node.textContent.includes('diagnostics failed'));
  // ...and nothing below it is claimed: "no legacy errors" over a failed collection would be a
  // statement the payload cannot support.
  assert.ok(!node.textContent.includes('No legacy'), 'a failed collection asserts nothing further');
});

test('renderSystem tolerates a malformed payload and attaches no listeners', () => {
  for (const bad of [undefined, null, 42, 'nope', {}, { streams: 'not an array' }]) {
    const node = S.renderSystem(makeDoc(), bad);
    assert.ok(node, `renderSystem must return a node for ${JSON.stringify(bad)}`);
    for (const e of walk(node)) assert.deepStrictEqual(e.listeners, [], 'the pure renderer attaches no listeners');
  }
});

// -------------------------------------------------------------------------------------------
// Source prohibition for the second renderer file -- the same hard guard activity.js carries.
// -------------------------------------------------------------------------------------------
test('renderer/activity-system.js never names a markup sink and is sandbox-safe', () => {
  const src = fs.readFileSync(ACTIVITY_SYSTEM_JS, 'utf8');
  for (const sink of ['inner' + 'HTML', 'outer' + 'HTML', 'insertAdjacent' + 'HTML',
    'document.' + 'write', 'createContextualFragment']) {
    assert.strictEqual(src.includes(sink), false, `activity-system.js must never name ${sink}`);
  }
  assert.strictEqual(/\beval\s*\(/.test(src), false, 'no eval');
  assert.strictEqual(/\bnew\s+Function\s*\(/.test(src), false, 'no Function constructor');
  assert.strictEqual(/\brequire\s*\(/.test(src), false, 'a sandboxed renderer has no require');
  assert.strictEqual(/\bprocess\./.test(src), false, 'no process access');
  assert.strictEqual(/\b__dirname\b|\b__filename\b/.test(src), false, 'no Node path globals');
  const moduleRefs = src.match(/\bmodule\b/g) || [];
  assert.strictEqual(moduleRefs.length, 2, 'module is named exactly twice: the typeof guard and the export');
  assert.ok(/typeof module !== 'undefined'/.test(src), 'the export is typeof-guarded for the browser');
});

// -------------------------------------------------------------------------------------------
// boot(): the System disclosure. Ruling P4-1 -- no fifth channel; the diagnostics ride on
// `activity:list` and are requested ONLY when the section is expanded or refreshed.
// -------------------------------------------------------------------------------------------
function bootedSystem(over) {
  const { doc, byId } = livePage();
  const { api, calls } = fakeApi(Object.assign({
    list: async (filter) => {
      calls.push(['list', filter]);
      return {
        items: [LIVE_ITEM], truncated: false, available: true, incomplete: false, problems: [],
        system: filter && filter.system ? systemPayload() : undefined,
      };
    },
    get: async (id) => { calls.push(['get', id]); return LIVE_DETAIL; },
  }, over));
  const win = fakeWindow('');
  return { doc, byId, api, calls, win, booted: R.boot(win, doc, api) };
}

test('the System section is collapsed and unrequested until it is expanded', async () => {
  const t = bootedSystem();
  await t.booted;
  assert.deepStrictEqual(t.calls, [['list', {}]], 'the first load never asks for diagnostics');
  assert.strictEqual(t.byId['system-body'].textContent, '', 'and paints nothing');
});

test('expanding the System section requests system:true and paints ONLY that section', async () => {
  const t = bootedSystem();
  await t.booted;
  const chipsBefore = t.byId.list.querySelectorAll('.chip').length;

  t.byId.system.open = true;
  fire(t.byId.system, 'toggle');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepStrictEqual(t.calls[1], ['list', { system: true }]);
  assert.ok(t.byId['system-body'].textContent.includes('sync.error.log'), 'the section painted');
  assert.strictEqual(t.byId.list.querySelectorAll('.chip').length, chipsBefore,
    'the item list is not re-rendered from the diagnostics response');
  assert.ok(!t.byId.list.textContent.includes('Shared diagnostics'),
    'diagnostics never mix into the Activity item list');
  assert.ok(!t.byId.detail.textContent.includes('Shared diagnostics'),
    'nor into the Problems lens');
});

test('collapsing and re-expanding does not re-request; Refresh does', async () => {
  const t = bootedSystem();
  await t.booted;

  t.byId.system.open = true;
  fire(t.byId.system, 'toggle');
  await new Promise((resolve) => setImmediate(resolve));
  t.byId.system.open = false;
  fire(t.byId.system, 'toggle');
  t.byId.system.open = true;
  fire(t.byId.system, 'toggle');
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(t.calls.length, 2, 'an already-loaded section is not re-fetched on every toggle');

  const refresh = walk(t.byId['system-body']).find((e) => e.className.split(' ').includes('system-refresh'));
  assert.ok(refresh, 'the section offers a Refresh control');
  fire(refresh, 'click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(t.calls[2], ['list', { system: true }]);
});

test('the System request carries the current filter alongside the flag', async () => {
  const t = bootedSystem();
  await t.booted;
  t.byId['event-level'].value = 'error';
  t.byId['event-search'].value = 'timeout';
  fire(t.byId['event-level'], 'change');

  t.byId.system.open = true;
  fire(t.byId.system, 'toggle');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(t.calls[1], ['list', { level: 'error', search: 'timeout', system: true }]);
});

test('a rejected System request shows one generic line plus Retry, never the error itself', async () => {
  let fail = true;
  const t = bootedSystem({
    list: async (filter) => {
      if (filter && filter.system) {
        if (fail) { fail = false; throw new Error('EACCES /Users/someone/Library/Logs/repo-radar'); }
        return { items: [], truncated: false, available: true, incomplete: false, problems: [], system: systemPayload() };
      }
      return { items: [LIVE_ITEM], truncated: false, available: true, incomplete: false, problems: [] };
    },
  });
  await t.booted;
  t.byId.system.open = true;
  fire(t.byId.system, 'toggle');
  await new Promise((resolve) => setImmediate(resolve));

  const text = t.byId['system-body'].textContent;
  assert.ok(text.includes('Activity history couldn’t be loaded.'));
  assert.ok(!text.includes('EACCES'), 'the underlying error never reaches the page');
  assert.ok(!text.includes('/Users/'), 'nor any path from it');

  const retry = walk(t.byId['system-body']).find((e) => e.className.split(' ').includes('retry'));
  assert.ok(retry, 'and a Retry control is offered');
  fire(retry, 'click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(t.byId['system-body'].textContent.includes('sync.error.log'), 'Retry re-issues the request');
});

test('a response with no `system` payload paints the section without throwing', async () => {
  const t = bootedSystem({
    list: async (filter) => { return { items: [], truncated: false, available: true, incomplete: false, problems: [] }; },
  });
  await t.booted;
  t.byId.system.open = true;
  fire(t.byId.system, 'toggle');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(t.byId['system-body'].textContent.length > 0);
});

// -------------------------------------------------------------------------------------------
// Task 4.5: the three store states (Round-3 #9 / Round-4 #7).
//
// `read.listActivities` reports three DIFFERENT things and the UI must not blur them into one
// "nothing here" line:
//   * `{available:true, items:[]}`  -- a MISSING store. Normal empty history: nothing has synced
//     yet. Reassuring, and it says how history starts.
//   * `{available:false}`           -- the store EXISTS but could not be read. An alarming state
//     that must never read as "no activity": the user's history may be sitting right there.
//   * `{available:true, incomplete:true, items:[...]}` -- what could be read, plus an explicit
//     admission that the view is partial, plus the store-level `problems[]` rows that say why.
// -------------------------------------------------------------------------------------------
function storeStateText(result) {
  return R.renderStoreState(makeDoc(), result).textContent;
}

function statesIn(node) {
  return walk(node).filter((el) => el.className.split(' ').includes('state'));
}

test('renderStoreState gives the three reader states three DIFFERENT fixed texts', () => {
  const emptyText = storeStateText(listResult({}));
  const unavailableText = storeStateText(listResult({ available: false }));
  const incompleteText = storeStateText(listResult({ items: [CHIP_DTO], incomplete: true }));

  assert.match(emptyText, /no activity recorded yet/i);
  assert.match(emptyText, /sync/i, 'the empty state says how history starts');

  assert.match(unavailableText, /activity history is unavailable/i);
  assert.match(unavailableText, /could not be read/i, 'and says the store exists but is unreadable');

  assert.match(incompleteText, /history is incomplete/i);

  const texts = [emptyText, unavailableText, incompleteText];
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      assert.notStrictEqual(texts[i], texts[j], 'each state must be distinguishable by its text alone');
    }
  }
});

test('an unreadable store never reads as empty history, and vice versa', () => {
  const unavailableText = storeStateText(listResult({ available: false }));
  assert.ok(!/no activity recorded yet/i.test(unavailableText),
    'an unreadable store must never claim there is no activity');
  const emptyText = storeStateText(listResult({}));
  assert.ok(!/unavailable/i.test(emptyText), 'and empty history must never claim to be unavailable');
});

test('renderStoreState marks each state with its own class, and only that one', () => {
  const classesOf = (result) => statesIn(R.renderStoreState(makeDoc(), result))
    .map((el) => el.className).join(' ');
  assert.match(classesOf(listResult({})), /state-empty/);
  assert.ok(!/state-unavailable|state-incomplete/.test(classesOf(listResult({}))));
  assert.match(classesOf(listResult({ available: false })), /state-unavailable/);
  assert.ok(!/state-empty/.test(classesOf(listResult({ available: false }))),
    'the unavailable state does not also claim emptiness');
  assert.match(classesOf(listResult({ items: [CHIP_DTO], incomplete: true })), /state-incomplete/);
});

test('an incomplete store shows the banner ALONGSIDE the items it could read', () => {
  const list = R.renderList(makeDoc(), listResult({ items: [CHIP_DTO], incomplete: true }));
  assert.strictEqual(walk(list).filter((el) => el.className.split(' ').includes('chip')).length, 1,
    'the readable items are still shown');
  assert.match(list.textContent, /history is incomplete/i);
});

test('an UNAVAILABLE store renders zero chips even if items were (wrongly) non-empty', () => {
  const list = R.renderList(makeDoc(), listResult({ available: false, items: [CHIP_DTO, CHIP_DTO] }));
  assert.strictEqual(walk(list).filter((el) => el.className.split(' ').includes('chip')).length, 0,
    'nothing may be presented as history over a store we could not read');
  assert.match(list.textContent, /unavailable/i);
});

test('the truncated footer states how many are shown rather than implying that is all', () => {
  const items = [CHIP_DTO, CHIP_DTO, CHIP_DTO];
  const list = R.renderList(makeDoc(), listResult({ items, truncated: true }));
  const footer = statesIn(list).find((el) => el.className.includes('state-truncated'));
  assert.ok(footer, 'a truncated response gets a footer line');
  assert.match(footer.textContent, /3/, 'it names how many are on screen');
  assert.match(footer.textContent, /older/i, 'and says the rest are older, not absent');
  assert.strictEqual(statesIn(R.renderList(makeDoc(), listResult({ items }))).length, 0,
    'an untruncated, complete, non-empty list gets no state line at all');
});

// -------------------------------------------------------------------------------------------
// Store-level problems (Task 4.2 deferred minor, now required). `_collectItems` reports an
// activity-shaped root entry it refused to follow -- a valid-UUID symlink, a plain file, an
// lstat-denied entry -- as `{kind:'rejected-activity', id, reason}` on the RESPONSE, belonging to
// no item. Before this task nothing rendered them: the store said "incomplete" and never why, and
// `describeProblem`'s `rejected-activity` branch was unreachable from the app.
// -------------------------------------------------------------------------------------------
const REJECTED = Object.freeze({ kind: 'rejected-activity', id: '11111111-2222-4333-8444-555555555555', reason: 'symlink' });

function problemRowsIn(node) {
  return walk(node).filter((el) => el.className.split(' ').includes('problem'));
}

test('store-level problems are rendered as rows, under the incomplete banner', () => {
  const list = R.renderList(makeDoc(), listResult({
    items: [CHIP_DTO], incomplete: true, problems: [REJECTED, { kind: 'truncated', dropped: 4 }],
  }));
  const rows = problemRowsIn(list);
  assert.strictEqual(rows.length, 2, 'one row per store-level problem');
  assert.ok(rows[0].textContent.includes('rejected-activity'), 'the kind is named');
  assert.ok(rows[0].textContent.includes('symlink'), 'and its reason -- reachable at last');
  assert.ok(rows[0].textContent.includes(REJECTED.id), 'and which root entry it was');
  assert.ok(rows[1].textContent.includes('4'), 'the bounded-out remainder is stated too');

  const banner = statesIn(list).find((el) => el.className.includes('state-incomplete'));
  assert.ok(banner, 'the banner is still there');
  assert.ok(walk(list).indexOf(banner) < walk(list).indexOf(rows[0]), 'the rows sit under it');
});

test('a store-level problem is inert text, like every other producer-derived string', () => {
  const list = R.renderList(makeDoc(), listResult({
    incomplete: true, problems: [{ kind: 'rejected-activity', id: ANSI_XSS, reason: ANSI_NOISE }],
  }));
  assertInert(list, XSS);
});

test('a clean store renders no problem rows', () => {
  assert.strictEqual(problemRowsIn(R.renderList(makeDoc(), listResult({ items: [CHIP_DTO] }))).length, 0);
  for (const bad of [null, undefined, 'nope', {}]) {
    const list = R.renderList(makeDoc(), listResult({ items: [CHIP_DTO], incomplete: true, problems: bad }));
    assert.strictEqual(problemRowsIn(list).length, 0, `problems:${JSON.stringify(bad)} must not throw`);
  }
});

// -------------------------------------------------------------------------------------------
// Chips reachable from the keyboard (Task 4.2 note). Not a full a11y pass: a focus stop, a role,
// and the two keys that mean "activate" -- delegated exactly like the click, so the pure renderer
// still attaches no listeners.
// -------------------------------------------------------------------------------------------
test('a chip is a focus stop that announces itself as a button', () => {
  const chip = R.renderChip(makeDoc(), CHIP_DTO);
  assert.strictEqual(chip.getAttribute('tabindex'), '0');
  assert.strictEqual(chip.getAttribute('role'), 'button');
  assert.deepStrictEqual(chip.listeners, [], 'still no listeners on the pure renderer');
});

test('Enter and Space select the focused chip; other keys do not', async () => {
  for (const [key, expected] of [['Enter', 2], [' ', 2], ['a', 1], ['Tab', 1]]) {
    const t = bootedList('');
    await t.booted;
    const chip = t.byId.list.querySelectorAll('.chip')[0];
    let prevented = 0;
    fire(t.byId.list, 'keydown', chip, { key, preventDefault: () => { prevented += 1; } });
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(t.calls.length, expected, `key ${JSON.stringify(key)}`);
    if (expected === 2) {
      assert.deepStrictEqual(t.calls[1], ['get', LIVE_ITEM.id]);
      assert.strictEqual(prevented, 1, 'Space must not also scroll the pane');
    }
  }
});

// -------------------------------------------------------------------------------------------
// Task 4.5: the action bar. Refresh re-issues the load; Export goes to main with the SAME
// validated filter object the list used (never the raw input text -- main REJECTS an
// out-of-bounds filter, and renderer text must never reach a filesystem write); Reveal is
// per-selected-item and disabled until there is one.
// -------------------------------------------------------------------------------------------
function statusOf(t) {
  return t.byId['action-status'].textContent;
}

test('Refresh re-issues the list load', async () => {
  const t = bootedList('');
  await t.booted;
  assert.strictEqual(t.calls.length, 1);

  fire(t.byId['btn-refresh'], 'click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(t.calls[1], ['list', {}]);
  assert.strictEqual(t.byId.list.querySelectorAll('.chip').length, 2, 'and repaints the list');
});

test('Refresh also refreshes the System section, but only while it is expanded', async () => {
  const t = bootedSystem();
  await t.booted;

  fire(t.byId['btn-refresh'], 'click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(t.calls, [['list', {}], ['list', {}]],
    'a collapsed System section is never read -- that is the whole point of P4-1');

  t.byId.system.open = true;
  fire(t.byId.system, 'toggle');
  await new Promise((resolve) => setImmediate(resolve));
  fire(t.byId['btn-refresh'], 'click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(t.calls.slice(3), [['list', {}], ['list', { system: true }]],
    'an expanded section is refreshed alongside the list');
});

test('Export sends exactly the normalized filter -- never the raw search input', async () => {
  const t = bootedList('');
  await t.booted;
  t.byId['event-level'].value = 'error';
  t.byId['event-search'].value = '  Boom  ';
  fire(t.byId['event-search'], 'input');

  fire(t.byId['btn-export'], 'click');
  await new Promise((resolve) => setImmediate(resolve));

  const sent = t.calls[1];
  assert.deepStrictEqual(sent, ['export', { level: 'error', search: 'Boom' }]);
  assert.notStrictEqual(sent[1].search, '  Boom  ', 'the raw input never crosses the bridge');
});

test('Export drops what the main-side validator would reject, rather than sending it', async () => {
  const t = bootedList('');
  await t.booted;
  t.byId['event-level'].value = 'trace';           // not a level main accepts
  t.byId['event-search'].value = 'x'.repeat(1000); // over SEARCH_MAX
  fire(t.byId['event-level'], 'change');

  fire(t.byId['btn-export'], 'click');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepStrictEqual(t.calls[1], ['export', { search: 'x'.repeat(256) }]);
});

test('a completed Export states the path main chose', async () => {
  const t = bootedList('');
  await t.booted;
  fire(t.byId['btn-export'], 'click');
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(statusOf(t), /exported to/i);
  assert.ok(statusOf(t).includes(EXPORT_PATH), 'the saved path is shown');
});

test('a cancelled Export says so and claims nothing was written', async () => {
  const { doc, byId } = livePage();
  const { api } = fakeApi({
    list: async () => ({ items: [LIVE_ITEM], truncated: false, available: true, incomplete: false, problems: [] }),
    export: async () => null,
  });
  await R.boot(fakeWindow(''), doc, api);
  fire(byId['btn-export'], 'click');
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(byId['action-status'].textContent, /cancelled/i);
  assert.ok(!/exported to/i.test(byId['action-status'].textContent));
});

test('a rejected Export shows one fixed line, never the error (P4-7)', async () => {
  const { doc, byId } = livePage();
  const { api } = fakeApi({
    list: async () => ({ items: [LIVE_ITEM], truncated: false, available: true, incomplete: false, problems: [] }),
    export: async () => {
      const e = new Error('EACCES: permission denied, open /Users/someone/Desktop/x.txt');
      e.code = 'internal';
      throw e;
    },
  });
  await R.boot(fakeWindow(''), doc, api);
  fire(byId['btn-export'], 'click');
  await new Promise((resolve) => setImmediate(resolve));

  const text = byId['action-status'].textContent;
  assert.ok(text.length > 0, 'a failure is never silent');
  assert.ok(!text.includes('EACCES'), 'the underlying error text never reaches the page');
  assert.ok(!text.includes('/Users/'), 'nor any path from it');
  assert.ok(!text.includes('internal'), 'nor the code -- which is never branched on');
  assert.strictEqual(byId.list.querySelectorAll('.chip').length, 1, 'and the list is untouched');
});

test('a second Export click while one is in flight opens no second save dialog', async () => {
  const { doc, byId } = livePage();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { api, calls } = fakeApi({
    list: async () => ({ items: [LIVE_ITEM], truncated: false, available: true, incomplete: false, problems: [] }),
    export: async (filter) => { calls.push(['export', filter]); await gate; return EXPORT_PATH; },
  });
  await R.boot(fakeWindow(''), doc, api);

  fire(byId['btn-export'], 'click');
  fire(byId['btn-export'], 'click');
  release();
  await new Promise((resolve) => setImmediate(resolve));

  assert.strictEqual(calls.filter((c) => c[0] === 'export').length, 1);
});

test('Reveal is disabled until an activity is selected, and reveals only that one', async () => {
  const t = bootedList('');
  await t.booted;
  assert.strictEqual(t.byId['btn-reveal'].disabled, true, 'nothing is selected yet');

  fire(t.byId['btn-reveal'], 'click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(t.calls.length, 1, 'and a click on it does nothing');

  const chip = t.byId.list.querySelectorAll('.chip')[0];
  fire(t.byId.list, 'click', chip);
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(t.byId['btn-reveal'].disabled, false, 'a selection enables it');

  fire(t.byId['btn-reveal'], 'click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(t.calls[2], ['reveal', LIVE_ITEM.id], 'the id comes from the selection');
});

test('a rejected Reveal shows one fixed line, never the error (P4-7)', async () => {
  const { doc, byId } = livePage();
  const { api } = fakeApi({
    list: async () => ({ items: [LIVE_ITEM], truncated: false, available: true, incomplete: false, problems: [] }),
    get: async () => LIVE_DETAIL,
    reveal: async () => { throw new Error('EACCES /Users/someone/.repo-radar/activity'); },
  });
  await R.boot(fakeWindow('#' + LIVE_ITEM.id), doc, api);
  fire(byId['btn-reveal'], 'click');
  await new Promise((resolve) => setImmediate(resolve));

  const text = byId['action-status'].textContent;
  assert.ok(text.length > 0);
  assert.ok(!text.includes('EACCES') && !text.includes('/Users/'));
});

test('the status line is cleared when the next action starts', async () => {
  const t = bootedList('');
  await t.booted;
  fire(t.byId['btn-export'], 'click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(statusOf(t).length > 0);

  fire(t.byId['btn-refresh'], 'click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(statusOf(t), '', 'a stale "Exported to ..." must not outlive the view it described');
});

test('the action bar is wired to the page controls the HTML actually provides', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'activity.html'), 'utf8');
  for (const id of ['btn-refresh', 'btn-export', 'btn-reveal', 'action-status']) {
    assert.ok(html.includes(`id="${id}"`), `activity.html must provide #${id}`);
  }
});
