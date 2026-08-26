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
function fire(node, type, target) {
  for (const [t, fn] of node.listeners) if (t === type) fn({ target: target || node });
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
  for (const id of ['list', 'detail', 'event-level', 'event-search', 'event-filters', 'tab-events', 'tab-problems']) {
    byId[id] = doc.createElement('div');
    byId[id].value = '';
  }
  doc.getElementById = (id) => byId[id];
  return { doc, byId };
}

function fakeApi(over) {
  const calls = [];
  const api = {
    list: async (filter) => { calls.push(['list', filter]); return { items: [], truncated: false, available: true, incomplete: false, problems: [] }; },
    get: async (id) => { calls.push(['get', id]); return { item: null, available: true, reason: 'missing' }; },
    export: async () => { throw new Error('not used by Task 4.2'); },
    reveal: async () => { throw new Error('not used by Task 4.2'); },
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
  await R.boot({ location: { hash: '' } }, doc, api);

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
    await R.boot({ location: { hash } }, doc, api);
    assert.deepStrictEqual(calls, expected, `hash ${JSON.stringify(hash)}`);
  }
});

test('boot switches lenses and applies the level/search filter client-side', async () => {
  const { doc, byId } = livePage();
  const { api, calls } = fakeApi({
    list: async (filter) => { calls.push(['list', filter]); return { items: [LIVE_ITEM], truncated: false, available: true, incomplete: false, problems: [] }; },
    get: async (id) => { calls.push(['get', id]); return LIVE_DETAIL; },
  });
  await R.boot({ location: { hash: '#' + LIVE_ITEM.id }, }, doc, api);
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
  await R.boot({ location: { hash: '' } }, doc, api);

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
  await R.boot({ location: { hash: '#' + LIVE_ITEM.id } }, doc, api);

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
    await R.boot({ location: { hash: '#' + LIVE_ITEM.id } }, doc, api);
    assert.match(byId.detail.textContent, needle, reason);
    assert.ok(!walk(byId.detail).some((el) => el.tagName === 'BUTTON'), `${reason} is not an error`);
  }
});
