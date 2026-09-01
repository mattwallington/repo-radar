'use strict';
// Task 4.5: static wiring landmarks for the tray's "🗒 Activity" entry in main.js.
//
// main.js cannot be require()'d outside a running Electron process (it destructures
// `{ app, Tray, ... }` off `require('electron')` and calls `app.requestSingleInstanceLock()` at
// module load), so this follows the established activity-ipc-wiring.test.js /
// view-errors-wiring.test.js precedent: assert main.js still parses, and assert the wiring is
// actually present in the source.
//
// What must hold:
//   * the entry exists in BOTH branches of `updateTrayMenu` -- Activity History is browsable at
//     any time, which is the whole point of the feature: "⚠️ View Errors" only ever appears when
//     the cache holds a problem item (Task 4.4 / P4-6), and "📊 View Progress" is the live log
//     window, so without this item a user with a clean history has no way in at all;
//   * in the SYNCING branch it sits directly after "📊 View Progress";
//   * in the IDLE branch it sits directly after "▶ Sync Now" and BEFORE "⚠️ View Errors" --
//     and, unlike View Errors, it is not gated on anything;
//   * both clicks call `showActivityWindow()` with NO focus id (the deep-linked call belongs to
//     View Errors alone).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MAIN_JS = path.join(__dirname, '..', 'main.js');

// Every assertion below is about CODE, and several of them require a label to appear exactly
// once. main.js's comments next to this hunk necessarily name the neighbouring labels ("directly
// after 📊 View Progress", "before ⚠️ View Errors"), so comment lines are dropped first --
// line-based, so a `//` inside a string literal is never touched. Same treatment as
// view-errors-wiring.test.js.
function codeOf(text) {
  return text.split('\n')
    .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
    .join('\n');
}

const src = codeOf(fs.readFileSync(MAIN_JS, 'utf8'));

const ACTIVITY = '🗒 Activity';
const PROGRESS = '📊 View Progress';
const SYNC_NOW = '▶ Sync Now';
const VIEW_ERRORS = 'View Errors';

// Source text of `function <name>(...) { ... }`, brace-matched from its opening `{`.
function functionBody(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `main.js must define ${name}`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// The `{ ... }` block whose opening brace is at `open`, plus the index just past its close.
function blockAt(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return { text: text.slice(open, i + 1), end: i + 1 };
    }
  }
  throw new Error('unbalanced braces');
}

// updateTrayMenu decides the icon from `isSyncing()` first and the MENU ITEMS from a second
// `isSyncing()` further down; the item branches are the ones after `const menuItems = [`.
function branches() {
  const body = functionBody('updateTrayMenu');
  const afterItems = body.indexOf('const menuItems = [');
  assert.notStrictEqual(afterItems, -1, 'updateTrayMenu must still build a menuItems array');
  const cond = body.indexOf('if (isSyncing())', afterItems);
  assert.notStrictEqual(cond, -1, 'the item branches are still chosen by isSyncing()');

  const syncing = blockAt(body, body.indexOf('{', cond));
  const elseAt = body.indexOf('else', syncing.end);
  assert.notStrictEqual(elseAt, -1, 'the syncing branch must still have an else');
  const idle = blockAt(body, body.indexOf('{', elseAt));
  return { body, syncing: syncing.text, idle: idle.text };
}

// Asserts `markers` appear exactly once each, in order, inside `slice`.
function inOrder(slice, markers, label) {
  let last = -1;
  markers.forEach((marker, i) => {
    const at = slice.indexOf(marker);
    assert.notStrictEqual(at, -1, `${label}: missing ${marker}`);
    assert.strictEqual(slice.indexOf(marker, at + 1), -1, `${label}: ${marker} appears more than once`);
    assert.ok(at > last, `${label}: ${marker} must come after ${markers[i - 1]}`);
    last = at;
  });
}

test('main.js still parses', () => {
  execFileSync(process.execPath, ['--check', MAIN_JS], { stdio: 'pipe' });
});

test('guard: the comment stripper leaves the tray labels themselves alone', () => {
  // If codeOf ever ate a line of real code, every ordering assertion below would pass vacuously.
  for (const label of [ACTIVITY, PROGRESS, SYNC_NOW, VIEW_ERRORS]) {
    assert.ok(src.includes(label), `${label} must survive comment stripping`);
  }
});

test('the Activity entry exists in BOTH tray branches, exactly once each', () => {
  const { body, syncing, idle } = branches();
  assert.strictEqual((body.match(new RegExp(ACTIVITY, 'g')) || []).length, 2,
    'updateTrayMenu offers Activity twice: once per branch');
  assert.ok(syncing.includes(ACTIVITY), 'the syncing branch offers Activity');
  assert.ok(idle.includes(ACTIVITY), 'the idle branch offers Activity');
});

test('in the syncing branch Activity follows View Progress', () => {
  const { syncing } = branches();
  inOrder(syncing, [PROGRESS, ACTIVITY], 'syncing branch');
  assert.strictEqual(syncing.includes(SYNC_NOW), false,
    'guard: Sync Now belongs to the idle branch, so this really is the syncing one');
});

test('in the idle branch Activity follows Sync Now and precedes View Errors', () => {
  const { idle } = branches();
  inOrder(idle, [SYNC_NOW, ACTIVITY, VIEW_ERRORS], 'idle branch');
});

test('the Activity entry is ungated -- unlike View Errors it needs no cached target', () => {
  const { idle } = branches();
  const gate = idle.indexOf('if (viewErrorsId)');
  assert.notStrictEqual(gate, -1, 'guard: View Errors is still gated on the cached target');
  assert.ok(idle.indexOf(ACTIVITY) < gate,
    'Activity is pushed before the View Errors gate, so no condition can withhold it');
});

test('both Activity clicks open the window with no focus id', () => {
  const { body, syncing, idle } = branches();
  for (const [label, slice] of [['syncing', syncing], ['idle', idle]]) {
    assert.strictEqual((slice.match(/showActivityWindow\(\)/g) || []).length, 1,
      `${label} branch: exactly one un-focused showActivityWindow() call`);
  }
  assert.strictEqual((body.match(/showActivityWindow\(viewErrorsId\)/g) || []).length, 1,
    'the deep-linked call still belongs to View Errors alone');
});

test('a menu build still never calls the reader (P4-14 (a))', () => {
  // The Activity item must not be tempted to ask "is there anything to show?" first --
  // updateTrayMenu runs on the sync path and several times per progress event.
  const body = functionBody('updateTrayMenu');
  assert.strictEqual(/_refreshViewErrorsTarget/.test(body), false);
  assert.strictEqual(/activityRead\./.test(body), false);
});
