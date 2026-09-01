'use strict';
// Regression for the blocker found on the Activity window's FIRST real Chromium render: the page
// painted nothing at all.
//
// renderer/activity.html loads two page scripts -- activity-system.js then activity.js. Classic
// <script src> tags do not get a scope each: every top-level declaration in both files lands in
// the SAME global lexical scope. Both files declare `TEXT`, `el`, `sanitizeText`, `ANSI_OSC_RE`,
// `ANSI_CSI_RE`, `ANSI_ESC_RE` and `CONTROL_RE` (a deliberate duplication -- a sandboxed page
// script has no imports), so the second file died on load with
//     Uncaught SyntaxError: Identifier 'TEXT' has already been declared
// activity.js never parsed, `start()` never ran, and the list pane stayed blank.
//
// Every other renderer test loads these files with `require`, which hands each one its own module
// scope -- which is exactly why 108 renderer tests passed against a window that could not paint.
// This test refuses that convenience: it builds ONE vm context and runs both file SOURCES in it,
// in the order the HTML lists them, which is the browser's shared-global scope in miniature.
// It fails on unwrapped files with the redeclaration SyntaxError, and it is the reason the two
// files are each wrapped in an IIFE.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const RENDERER = path.join(__dirname, '..', 'renderer');
const ACTIVITY_JS = path.join(RENDERER, 'activity.js');
const ACTIVITY_SYSTEM_JS = path.join(RENDERER, 'activity-system.js');
const ACTIVITY_HTML = path.join(RENDERER, 'activity.html');

// -------------------------------------------------------------------------------------------
// The smallest DOM these two files need to reach the end of their top level and run `start()`.
// It is deliberately NOT the rich shim in activity-renderer-dom.test.js: this test is about the
// files LOADING together, not about what they render.
// -------------------------------------------------------------------------------------------
function makeElement(tagName) {
  const el = {
    tagName: String(tagName).toUpperCase(),
    className: '',
    children: [],
    attributes: {},
    listeners: [],
    disabled: false,
    value: '',
    open: false,
    _text: '',
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(name, value) { this.attributes[String(name)] = String(value); },
    getAttribute(name) {
      const key = String(name);
      return Object.prototype.hasOwnProperty.call(this.attributes, key) ? this.attributes[key] : null;
    },
    addEventListener(type, fn) { this.listeners.push([type, fn]); },
    querySelectorAll() { return []; },
    classList: {
      contains() { return false; },
      add() {},
      remove() {},
      toggle() {},
    },
  };
  Object.defineProperty(el, 'textContent', {
    get() { return this._text + this.children.map((c) => c.textContent).join(''); },
    set(value) {
      this._text = value === null || value === undefined ? '' : String(value);
      this.children.length = 0;
    },
    enumerable: true,
    configurable: true,
  });
  return el;
}

// Every id activity.html actually provides, read out of the page itself so the stub cannot drift
// away from the real document.
function pageIds() {
  const html = fs.readFileSync(ACTIVITY_HTML, 'utf8');
  const ids = [];
  for (const m of html.matchAll(/\bid="([^"]+)"/g)) ids.push(m[1]);
  assert.ok(ids.includes('list'), 'activity.html must provide #list');
  return ids;
}

function makeContext() {
  const byId = {};
  for (const id of pageIds()) byId[id] = makeElement('div');
  const document = {
    getElementById: (id) => (Object.prototype.hasOwnProperty.call(byId, id) ? byId[id] : null),
    createElement: (tag) => makeElement(tag),
    createTextNode: (text) => ({
      nodeType: 3,
      children: [],
      textContent: text === null || text === undefined ? '' : String(text),
    }),
  };
  // No `activityApi`: `start()` then takes the bridge-missing branch, which is a real execution
  // of `el` and `TEXT` -- the two names the collision was about -- and leaves a visible mark.
  const window = {
    document,
    location: { hash: '' },
    addEventListener() {},
  };
  const sandbox = { window, document, console };
  sandbox.globalThis = sandbox;
  return { context: vm.createContext(sandbox), sandbox, byId };
}

// The browser's load: two sources, one context, HTML order. Never `require` -- a module scope per
// file is precisely the thing that hid this bug.
function loadBothIntoOneContext() {
  const { context, sandbox, byId } = makeContext();
  vm.runInContext(fs.readFileSync(ACTIVITY_SYSTEM_JS, 'utf8'), context, { filename: 'activity-system.js' });
  vm.runInContext(fs.readFileSync(ACTIVITY_JS, 'utf8'), context, { filename: 'activity.js' });
  return { sandbox, byId };
}

test('both page scripts load into ONE shared global scope without colliding', () => {
  // On the unwrapped files this throws:
  //   SyntaxError: Identifier 'TEXT' has already been declared
  assert.doesNotThrow(loadBothIntoOneContext,
    'activity-system.js and activity.js must not redeclare each other’s top-level names');
});

test('the System renderer is published on the window, and activity.js runs its self-start', () => {
  const { sandbox, byId } = loadBothIntoOneContext();

  // activity-system.js got all the way to its last statement.
  assert.strictEqual(typeof sandbox.window.activitySystem, 'object');
  assert.strictEqual(typeof sandbox.window.activitySystem.renderSystem, 'function',
    'activity.js reaches the System section through window.activitySystem');

  // ...and so did activity.js: with no bridge on the window, `start()` writes the one line that
  // says so into #list. A blank #list here is the blocker this test exists for -- it is what the
  // window showed when the second script failed to parse.
  const listText = byId.list.textContent;
  assert.ok(listText.length > 0, 'the list pane must not be blank -- activity.js never ran');
  assert.match(listText, /bridge unavailable/i,
    'the bridge-missing line proves activity.js executed through to its self-start');
});

test('the two files still declare the same names, so the IIFEs are load-bearing', () => {
  // If a later edit de-duplicated the helpers, the wrappers above would look like dead ceremony.
  // They are not: this is the collision they contain.
  const a = fs.readFileSync(ACTIVITY_JS, 'utf8');
  const b = fs.readFileSync(ACTIVITY_SYSTEM_JS, 'utf8');
  const shared = ['TEXT', 'el', 'sanitizeText', 'ANSI_OSC_RE', 'ANSI_CSI_RE', 'ANSI_ESC_RE', 'CONTROL_RE'];
  const declares = (src, name) => new RegExp(`^\\s*(?:const|let|var|function)\\s+${name}\\b`, 'm').test(src);
  for (const name of shared) {
    assert.ok(declares(a, name), `activity.js declares ${name}`);
    assert.ok(declares(b, name), `activity-system.js declares ${name}`);
  }
});
