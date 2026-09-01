'use strict';
// Ruling P6-1: what the legacy progress window shows once the root lock refuses the sync.
//
// renderer/renderer.js itself cannot be require()'d in a test -- it destructures `ipcRenderer` off
// `require('electron')` and writes a log file at module load -- so the refusal's DOM work lives in
// renderer/sync-refused.js, a dependency-free file loaded by its own <script> tag next to
// renderer.js (nodeIntegration is on for this window; the wiring test pins the tag's order).
//
// The shim below is deliberately hostile, in the same spirit as activity-renderer-dom.test.js:
// its elements have no markup-parsing property at all, so reading OR assigning innerHTML /
// outerHTML / insertAdjacentHTML throws. A refusal path that built markup instead of text -- easy
// to do by accident in this file, which is full of innerHTML elsewhere -- fails here.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { applySyncRefused, syncRefusedText, SYNC_REFUSED_TEXTS, SYNC_REFUSED_STATUS_TEXT } =
  require(path.join(__dirname, '..', 'renderer', 'sync-refused.js'));

// The two reasons main.js can send, and the exact sentence each must produce.
const BUSY_TEXT = 'Not started — another sync is already running';
const FAILED_TEXT = 'Sync could not start — see ⚠️ View Errors in the menu';
const EXPECTED_TEXT = BUSY_TEXT;

function makeElement(tagName) {
  const el = {
    tagName: String(tagName).toUpperCase(),
    className: '',
    style: {},
    disabled: false,
    children: [],
    _classes: new Set(),
    _text: '',
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i !== -1) this.children.splice(i, 1);
      return child;
    },
    get firstChild() {
      return this.children.length ? this.children[0] : null;
    },
  };
  el.classList = {
    add: (c) => el._classes.add(c),
    remove: (c) => el._classes.delete(c),
    contains: (c) => el._classes.has(c),
  };
  Object.defineProperty(el, 'textContent', {
    get() {
      if (this._text) return this._text;
      return this.children.map((c) => c.textContent).join('');
    },
    set(v) {
      this._text = String(v);
      this.children = [];
    },
  });
  for (const sink of ['innerHTML', 'outerHTML']) {
    Object.defineProperty(el, sink, {
      get() { throw new Error(`${sink} read is prohibited on the refusal path`); },
      set() { throw new Error(`${sink} assignment is prohibited on the refusal path`); },
    });
  }
  el.insertAdjacentHTML = () => { throw new Error('markup insertion is prohibited on the refusal path'); };
  return el;
}

// A document shaped like renderer/index.html mid-"Starting sync...", i.e. exactly the state the
// production hang left on screen: the status line says the sync is starting, the grid is full of
// "Waiting..." rows, and the stop button is live and pulsing (`active` drives the CSS animation).
function makeStuckDocument({ repoRows = 3 } = {}) {
  const byId = new Map();

  const statusText = makeElement('span');
  statusText.textContent = 'Starting sync...';
  byId.set('status-text', statusText);

  const repoCount = makeElement('span');
  repoCount.textContent = '';
  byId.set('repo-count', repoCount);

  const stopBtn = makeElement('button');
  stopBtn.disabled = false;
  stopBtn.classList.add('active');
  stopBtn.textContent = '⏹';
  byId.set('stop-sync-btn', stopBtn);

  const reposList = makeElement('div');
  for (let i = 0; i < repoRows; i++) {
    const row = makeElement('div');
    row.className = 'repo-progress-item waiting';
    row.textContent = `owner/repo-${i} Waiting...`;
    reposList.appendChild(row);
  }
  byId.set('repos-list', reposList);

  return {
    _byId: byId,
    getElementById: (id) => (byId.has(id) ? byId.get(id) : null),
    createElement: (tag) => makeElement(tag),
  };
}

test('the reason -> text map is closed, and unknown reasons fall back to failed-to-start', () => {
  assert.strictEqual(SYNC_REFUSED_TEXTS['already-running'], BUSY_TEXT);
  assert.strictEqual(SYNC_REFUSED_TEXTS['failed-to-start'], FAILED_TEXT);
  assert.strictEqual(SYNC_REFUSED_STATUS_TEXT, BUSY_TEXT, 'the legacy export stays the busy sentence');

  assert.strictEqual(syncRefusedText('already-running'), BUSY_TEXT);
  assert.strictEqual(syncRefusedText('failed-to-start'), FAILED_TEXT);
  // Anything main.js might grow later, or a garbled payload, must still say something TRUE about
  // a sync that did not start -- and must never be the text itself.
  for (const junk of [undefined, null, '', 'root-busy', 'toString', 'constructor', '<b>boom</b>', 42, {}]) {
    assert.strictEqual(syncRefusedText(junk), FAILED_TEXT, `unknown reason ${String(junk)}`);
  }
});

test('the status line stops claiming the sync is starting', () => {
  for (const [reason, expected] of [['already-running', BUSY_TEXT], ['failed-to-start', FAILED_TEXT]]) {
    const doc = makeStuckDocument();
    assert.strictEqual(doc.getElementById('status-text').textContent, 'Starting sync...', 'guard');
    applySyncRefused(doc, reason);
    assert.strictEqual(doc.getElementById('status-text').textContent, expected, reason);
  }
});

test('the "Waiting..." repo grid is cleared, and what replaces it is text, not markup', () => {
  const doc = makeStuckDocument({ repoRows: 5 });
  const reposList = doc.getElementById('repos-list');
  assert.strictEqual(reposList.children.length, 5, 'guard: the grid starts full');

  applySyncRefused(doc, 'already-running');

  const text = reposList.textContent;
  assert.strictEqual(/Waiting\.\.\./.test(text), false, 'no repo row may still read "Waiting..."');
  assert.strictEqual(/repo-0/.test(text), false, 'the stale rows are gone');
  // `textContent` here aggregates only real child nodes -- markup would have thrown above, and
  // anything smuggled in as a string would leave this empty.
  assert.ok(text.includes(EXPECTED_TEXT), 'the grid explains itself with the same fixed text');
});

test('the stop button is left disabled and un-animated', () => {
  const doc = makeStuckDocument();
  applySyncRefused(doc, 'failed-to-start');
  const stopBtn = doc.getElementById('stop-sync-btn');
  assert.strictEqual(stopBtn.disabled, true, 'nothing is running -- there is nothing to stop');
  assert.strictEqual(stopBtn.classList.contains('active'), false,
    '`active` is what drives the pulse-red CSS animation; it must be off');
});

test('it survives a window whose DOM is missing pieces', () => {
  const empty = { getElementById: () => null, createElement: (t) => makeElement(t) };
  assert.doesNotThrow(() => applySyncRefused(empty, 'already-running'));
  assert.doesNotThrow(() => applySyncRefused(null, 'failed-to-start'));
});

test('the text is fixed: nothing from the payload can reach the DOM', () => {
  // An unrecognised reason must produce the fallback sentence, never an echo of itself.
  const doc = makeStuckDocument();
  applySyncRefused(doc, '<img src=x onerror=alert(1)>');
  assert.strictEqual(doc.getElementById('status-text').textContent, FAILED_TEXT);
  const grid = doc.getElementById('repos-list').textContent;
  assert.strictEqual(/img|onerror/.test(grid), false, 'the reason never reaches the grid');
  assert.ok(grid.includes(FAILED_TEXT));
});
