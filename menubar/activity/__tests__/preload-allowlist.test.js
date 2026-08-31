'use strict';
// Task 4.1 / Ruling P4-4: the Activity window's DEDICATED preload
// (menubar/renderer/activity-preload.js) is the renderer's ONLY bridge, and it must expose an
// allowlist of exactly four `invoke` channels -- never `ipcRenderer` itself, never `require`,
// never a wildcard "invoke any channel" escape hatch.
//
// The preload runs under `sandbox:true`, where the only module it may require is `electron`; and
// under plain `node --test` there is no Electron at all. So the behavioural half of this file
// stubs the `electron` module through `Module._load` and requires the REAL preload source, and
// the source half re-reads that same file as text to prove the negatives (a fake exposing the
// right shape while ALSO smuggling a fifth channel or the raw `ipcRenderer` would pass the
// behavioural checks alone).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const PRELOAD = path.join(__dirname, '..', '..', 'renderer', 'activity-preload.js');
const CHANNELS = ['activity:list', 'activity:get', 'activity:export', 'activity:reveal'];

// Loads the real preload with `require('electron')` answered by a recording fake. Restores the
// loader and drops the preload from the require cache in a `finally` so each call re-executes it.
function loadPreload() {
  const exposed = [];
  const invoked = [];
  const ipcRenderer = {
    invoke: (channel, arg) => { invoked.push([channel, arg]); return Promise.resolve({ channel, arg }); },
    send: (channel, arg) => { invoked.push(['send', channel, arg]); },
    on: () => {},
  };
  const fakeElectron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed.push([name, api]); } },
    ipcRenderer,
  };

  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return fakeElectron;
    return origLoad.call(this, request, ...rest);
  };
  try {
    delete require.cache[PRELOAD];
    require(PRELOAD);
  } finally {
    Module._load = origLoad;
    delete require.cache[PRELOAD];
  }
  return { exposed, invoked, ipcRenderer };
}

test('the preload exposes exactly one bridge named activityApi', () => {
  const { exposed } = loadPreload();
  assert.strictEqual(exposed.length, 1, 'exposeInMainWorld must be called exactly once');
  assert.strictEqual(exposed[0][0], 'activityApi');
});

test('the exposed API surface is exactly {list, get, export, reveal}', () => {
  const { exposed, ipcRenderer } = loadPreload();
  const api = exposed[0][1];
  assert.deepStrictEqual(Object.keys(api), ['list', 'get', 'export', 'reveal']);
  for (const [name, value] of Object.entries(api)) {
    assert.strictEqual(typeof value, 'function', `${name} must be a plain function`);
    assert.notStrictEqual(value, ipcRenderer, `${name} must not hand out ipcRenderer`);
    assert.notStrictEqual(value, require, `${name} must not hand out require`);
  }
  assert.strictEqual(api.ipcRenderer, undefined, 'ipcRenderer itself must never be exposed');
  assert.strictEqual(api.require, undefined, 'require must never be exposed');
  assert.strictEqual(api.invoke, undefined, 'no generic invoke escape hatch');
});

test('each exposed method invokes its single channel and passes its argument through', async () => {
  const { exposed, invoked } = loadPreload();
  const api = exposed[0][1];
  const args = { list: { level: 'warn' }, get: 'an-id', export: { search: 'x' }, reveal: 'an-id' };
  const methods = ['list', 'get', 'export', 'reveal'];

  for (const method of methods) {
    await api[method](args[method]);
  }
  assert.deepStrictEqual(invoked, methods.map((m, i) => [CHANNELS[i], args[m]]));
});

test('the preload source leaks no ipcRenderer, no require and no channel outside the allowlist', () => {
  const raw = fs.readFileSync(PRELOAD, 'utf8');
  // Strip line comments so prose can never satisfy (or trip) the source assertions below.
  const src = raw.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

  assert.strictEqual((src.match(/exposeInMainWorld/g) || []).length, 1, 'exactly one bridge');

  // `ipcRenderer` may appear only in the electron destructure and as `ipcRenderer.invoke(`.
  const body = src.split('\n').filter((l) => !/require\(['"]electron['"]\)/.test(l)).join('\n');
  assert.strictEqual(body.match(/ipcRenderer(?!\.invoke\()/g), null,
    'ipcRenderer may only ever be used as ipcRenderer.invoke(...)');

  // `require` may appear only on that same electron line -- a sandboxed preload has nothing else
  // it is allowed to load, and handing `require` to the page would defeat context isolation.
  assert.ok(!/\brequire\b/.test(body), 'the preload must require nothing but electron');

  // Every string literal containing a ':' must be one of the four allowlisted channels: this is
  // what catches a smuggled fifth channel or a `activity:*`-style wildcard.
  const literals = [...src.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`\n]*)`/g)]
    .map((m) => m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]))
    .filter((s) => s.includes(':'));
  assert.deepStrictEqual(literals, CHANNELS, 'the only channel strings are the four allowlisted ones');

  // No dynamic channel construction: the channel argument is always a literal.
  assert.strictEqual(src.match(/invoke\(\s*(?!['"](activity:(list|get|export|reveal))['"])/g), null,
    'every invoke() call must name one of the four channels literally');
});
