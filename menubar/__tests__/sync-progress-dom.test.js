'use strict';
// The progress window against the real main process. Each case loads the actual main.js (status
// server handler, triggerSync, window replay, child-exit handling, startup settle) and the actual
// renderer.js IPC listeners, wired together through a fake BrowserWindow, with:
//   - Electron, express and the runtime's worker spawn replaced by small controllable stand-ins;
//   - fake timers, so the 100/300/500 ms callbacks fire exactly when a case says;
//   - the real Activity store, owner leases and reader in a throwaway HOME. A "scheduled worker"
//     is a real Activity writer the case holds open, so its owner lease is genuinely BUSY;
//   - a small DOM built from renderer/index.html, enough for the repository rows renderer.js
//     builds with innerHTML and finds with querySelector.
// Nothing here decides anything main.js decides: the cases post what the Python worker posts and
// read back what the window shows.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const MENUBAR = path.join(__dirname, '..');
const MAIN = path.join(MENUBAR, 'main.js');
const RENDERER = path.join(MENUBAR, 'renderer', 'renderer.js');
const { ActivityWriter } = require(path.join(MENUBAR, 'activity', 'writer.js'));

// ---- a small DOM -------------------------------------------------------------------------

const VOID = new Set(['br', 'img', 'input', 'meta', 'link', 'hr']);
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const encode = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

class Node_ {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.children = []; }
}

class Text_ extends Node_ {
  constructor(doc, text) { super(doc); this.nodeType = 3; this.text = text; }
  get textContent() { return this.text; }
}

class Element_ extends Node_ {
  constructor(doc, tag) {
    super(doc);
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attrs = {};
    this.style = {};
    this.dataset = {};
    this.disabled = false;
    this._classes = new Set();
    const el = this;
    this.classList = {
      add: (...c) => c.forEach((x) => el._classes.add(x)),
      remove: (...c) => c.forEach((x) => el._classes.delete(x)),
      contains: (c) => el._classes.has(c),
    };
  }
  get id() { return this.attrs.id || ''; }
  set id(v) { this.attrs.id = String(v); }
  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get firstChild() { return this.children[0] || null; }
  get textContent() { return this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children = []; if (v !== '') this.appendChild(new Text_(this.ownerDocument, String(v))); }
  get innerHTML() {
    return this.children.map((c) => (c.nodeType === 3 ? encode(c.text) : `<${c.tagName.toLowerCase()}>${c.innerHTML}</${c.tagName.toLowerCase()}>`)).join('');
  }
  set innerHTML(html) { this.children = []; parseInto(this, String(html)); }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i !== -1) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  addEventListener() {}
  *_walk() {
    for (const c of this.children) {
      if (c.nodeType !== 1) continue;
      yield c;
      yield* c._walk();
    }
  }
  _matches(sel) {
    if (sel.startsWith('#')) return this.id === sel.slice(1);
    if (sel.startsWith('.')) return this._classes.has(sel.slice(1));
    return this.tagName === sel.toUpperCase();
  }
  querySelector(sel) { for (const el of this._walk()) if (el._matches(sel)) return el; return null; }
  querySelectorAll(sel) { return [...this._walk()].filter((el) => el._matches(sel)); }
}

function parseInto(parent, html) {
  const doc = parent.ownerDocument;
  const stack = [parent];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[0].startsWith('<!--')) continue;
    const top = stack[stack.length - 1];
    if (m[5] !== undefined) {
      if (m[5].trim() || top !== parent) top.appendChild(new Text_(doc, decode(m[5])));
      continue;
    }
    const tag = m[2].toLowerCase();
    if (m[1]) {
      while (stack.length > 1 && stack.pop().tagName !== tag.toUpperCase()) { /* unwind */ }
      continue;
    }
    const el = new Element_(doc, tag);
    const attrRe = /([\w-]+)(?:="([^"]*)")?/g;
    let a;
    while ((a = attrRe.exec(m[3])) !== null) {
      const [, name, value = ''] = a;
      if (name === 'class') el.className = value;
      else if (name === 'style') el.style.cssText = value;
      else if (name === 'disabled') el.disabled = true;
      else el.attrs[name] = decode(value);
    }
    top.appendChild(el);
    if (!VOID.has(tag) && !m[4] && tag !== 'script') stack.push(el);
    if (tag === 'script') re.lastIndex = html.indexOf('</script>', re.lastIndex) + '</script>'.length;
  }
}

function makeDocument() {
  const doc = { listeners: {} };
  const body = new Element_(doc, 'body');
  const html = fs.readFileSync(path.join(MENUBAR, 'renderer', 'index.html'), 'utf8');
  parseInto(body, html.slice(html.indexOf('<body'), html.lastIndexOf('</body>')).replace(/^<body[^>]*>/, ''));
  Object.assign(doc, {
    body,
    createElement: (tag) => new Element_(doc, tag),
    getElementById: (id) => body.querySelector(`#${id}`),
    querySelector: (sel) => body.querySelector(sel),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    addEventListener: (ev, fn) => { (doc.listeners[ev] = doc.listeners[ev] || []).push(fn); },
  });
  return doc;
}

// ---- fake timers ---------------------------------------------------------------------------

function makeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  const add = (fn, ms, every) => { const id = ++seq; timers.set(id, { at: now + Math.max(0, ms || 0), fn, every }); return id; };
  return {
    setTimeout: (fn, ms) => add(fn, ms, null),
    setInterval: (fn, ms) => add(fn, ms, Math.max(1, ms || 1)),
    clearTimeout: (id) => timers.delete(id),
    clearInterval: (id) => timers.delete(id),
    // Run everything due within `ms`, in time order, including timers scheduled along the way.
    tick(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at || (t.at === next[1].at && id < next[0]))) next = [id, t];
        if (!next) break;
        const [id, t] = next;
        now = t.at;
        if (t.every) t.at += t.every; else timers.delete(id);
        t.fn();
      }
      now = end;
    },
  };
}

// ---- the renderer --------------------------------------------------------------------------

function loadRenderer() {
  const doc = makeDocument();
  const listeners = {};
  const ipcRenderer = {
    on: (ch, fn) => { (listeners[ch] = listeners[ch] || []).push(fn); },
    send: () => {},
  };
  const req = Module.createRequire(RENDERER);
  const localRequire = (id) => (id === 'electron' ? { ipcRenderer } : req(id));
  const { applySyncRefused } = req('./sync-refused.js');
  const src = fs.readFileSync(RENDERER, 'utf8');
  const fn = vm.runInThisContext(`(function (exports, require, module, __filename, __dirname, document, applySyncRefused, confirm) {${src}\n})`, { filename: RENDERER });
  const mod = { exports: {} };
  fn(mod.exports, localRequire, mod, RENDERER, path.dirname(RENDERER), doc, applySyncRefused, () => true);
  (doc.listeners.DOMContentLoaded || []).forEach((f) => f());
  const deliver = (ch, ...args) => (listeners[ch] || []).forEach((f) => f({}, ...args));
  const rows = () => Object.fromEntries(doc.getElementById('repos-list').querySelectorAll('.repo-progress-item')
    .map((el) => [el.dataset.fullName || el.id.replace(/^repo-/, ''), el.querySelector('.repo-progress-status').textContent]));
  return {
    doc,
    deliver,
    rows,
    status: () => doc.getElementById('status-text').textContent,
    stopEnabled: () => !doc.getElementById('stop-sync-btn').disabled,
  };
}

// ---- the main process ----------------------------------------------------------------------

function anyStub() {
  return new Proxy(function stub() { return anyStub(); }, {
    get: (t, k) => (k === 'then' ? undefined : (k in t ? t[k] : anyStub())),
    apply: () => anyStub(),
    construct: () => anyStub(),
  });
}

function makeHarness(t, { channel = 'stable', home: sharedHome = null } = {}) {
  const home = sharedHome || fs.mkdtempSync(path.join(os.tmpdir(), 'rr-progress-'));
  if (!sharedHome) t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = prevHome; });
  fs.mkdirSync(path.join(home, '.config', 'repo-radar'), { recursive: true });

  const clock = makeClock();
  const h = { home, channel, clock, windows: [], icons: [], notifications: [], runs: [] };

  class FakeWindow extends EventEmitter {
    constructor() {
      super();
      const win = this;
      this.destroyed = false;
      this.renderer = null;
      this.loading = true;
      const wc = new EventEmitter();
      wc.send = (ch, ...args) => { if (!win.destroyed && win.renderer) win.renderer.deliver(ch, ...args); };
      wc.isLoading = () => win.loading;
      this.webContents = wc;
      h.windows.push(this);
    }
    loadFile() {
      // The page loads a little later, as it does in Electron.
      clock.setTimeout(() => {
        if (this.destroyed) return;
        this.renderer = loadRenderer();
        this.loading = false;
        this.emit('ready-to-show');
        this.webContents.emit('did-finish-load');
      }, 50);
    }
    isDestroyed() { return this.destroyed; }
    show() {}
    focus() {}
    close() { this.destroyed = true; this.emit('closed'); }
  }

  class FakeNotification { constructor(o) { this.o = o; } show() { h.notifications.push(this.o); } static isSupported() { return true; } }

  const electron = new Proxy({
    app: anyStub(),
    BrowserWindow: FakeWindow,
    Notification: FakeNotification,
    nativeImage: { createFromPath: (p) => ({ path: p, resize() { return this; }, setTemplateImage() {}, isEmpty: () => false }) },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1600, height: 1000 } }) },
    Menu: { buildFromTemplate: (tpl) => ({ tpl }), setApplicationMenu() {} },
    ipcMain: { on() {}, handle() {} },
  }, { get: (o, k) => (k in o ? o[k] : anyStub()) });
  // `app.whenReady()` must never resolve: the startup sequence is driven by the cases instead.
  electron.app.whenReady = () => new Promise(() => {});
  electron.app.requestSingleInstanceLock = () => true;

  const express = () => ({
    use() {},
    get() {},
    post: (route, fn) => { h.statusHandler = fn; },
    listen: () => ({ close() {} }),
  });

  const req = Module.createRequire(MAIN);
  const realPaths = req('./runtime/paths');
  const realGlue = req('./activity/trigger-glue');
  const realQuota = req('./activity/quota');
  const stubs = {
    electron,
    'electron-updater': { autoUpdater: anyStub() },
    express,
    'body-parser': { json: () => () => {} },
    // The worker spawn: each Sync Now becomes a run the case resolves (spawn) or refuses.
    './runtime': new Proxy({
      runSync: (opts) => new Promise((resolve, reject) => { h.runs.push({ opts, resolve, reject }); }),
    }, { get: (o, k) => (k in o ? o[k] : anyStub()) }),
    './runtime/paths': { ...realPaths, resolveChannel: () => channel },
    // The worker's side of the lease hand-off: once the worker has it, Electron drops its own
    // reference, as the real handOff does after the worker's ack.
    './activity/trigger-glue': { ...realGlue, handOff: async ({ writer }) => writer.dropLocalReference() },
    // Retention spawns Python; nothing here depends on it.
    './activity/quota': { ...realQuota, _spawnPythonRetain: () => {} },
  };
  const localRequire = (id) => (Object.prototype.hasOwnProperty.call(stubs, id) ? stubs[id] : req(id));
  const src = fs.readFileSync(MAIN, 'utf8') + `
;module.exports = {
  startStatusServer, triggerSync, showLogWindow, currentSyncView, loadStatus,
  setTray: (t) => { tray = t; },
  logWindow: () => logWindow,
};`;
  const fn = vm.runInThisContext(`(function (exports, require, module, __filename, __dirname, setTimeout, clearTimeout, setInterval, clearInterval) {${src}\n})`, { filename: MAIN });
  const mod = { exports: {} };
  fn(mod.exports, localRequire, mod, MAIN, MENUBAR, clock.setTimeout, clock.clearTimeout, clock.setInterval, clock.clearInterval);
  const main = mod.exports;
  main.setTray(new Proxy({
    setImage: (img) => h.icons.push(path.basename(img.path)),
    isDestroyed: () => false,
  }, { get: (o, k) => (k in o ? o[k] : () => {}) }));
  main.startStatusServer();
  h.main = main;

  // What the Python worker posts to the status server.
  h.post = (payload) => h.statusHandler({ body: payload }, { json() {} });
  // The last run main.js asked the runtime for. `spawn` = it got the root lock and started.
  h.spawn = () => {
    const run = h.runs[h.runs.length - 1];
    const child = new EventEmitter();
    Object.assign(child, { pid: process.pid, exitCode: null, killed: false, stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
    child.exit = (code) => { child.exitCode = code; child.emit('exit', code, null); child.emit('close', code); run.resolve(code); };
    run.opts.onChild(child);
    return { child, env: run.opts.env };
  };
  h.refuse = () => h.runs[h.runs.length - 1].reject(Object.assign(new Error('busy'), { code: 75 }));
  h.window = () => { const w = main.logWindow(); return w && !w.isDestroyed() ? w.renderer : null; };
  h.openWindow = () => { main.showLogWindow(); clock.tick(200); return h.window(); };
  h.closeWindow = () => main.logWindow().close();
  h.status = () => main.loadStatus();
  h.writeConfig = (repos) => fs.writeFileSync(path.join(home, '.config', 'repo-radar', 'config.json'),
    JSON.stringify({ repositories: repos.map((n) => ({ full_name: n, name: n.split('/')[1] })), ai_model: 'gemini-2.5-flash', gemini_api_key: 'k' }));
  // A worker the app did not start: a real Activity attempt whose owner lease the case holds.
  h.scheduledWorker = (trigger = 'scheduled') => {
    const w = new ActivityWriter(home, { kind: 'sync', channel, trigger, producer: 'electron' });
    w.start();
    const id = w.activityId;
    return { id, w, post: (p) => h.post({ ...p, attemptId: id, channel }), end: (o = 'succeeded') => w.terminal(o) };
  };
  return h;
}

// ---- cases ---------------------------------------------------------------------------------

test('a network wait that starts while the window is closed is still shown, and so is its timeout', (t) => {
  const h = makeHarness(t);
  h.writeConfig(['o/one']);
  h.main.triggerSync({ showWindow: false });
  const { child, env } = h.spawn();
  const id = env.REPO_RADAR_ACTIVITY_ID;
  const post = (p) => h.post({ ...p, attemptId: id, channel: 'stable' });
  post({ type: 'sync-lifecycle', phase: 'starting' });
  post({ type: 'waiting-for-network' }); // no window open

  const during = h.openWindow();
  assert.strictEqual(during.status(), 'Waiting for network...');
  assert.strictEqual(during.stopEnabled(), true, 'Electron\'s own child can still be stopped');
  h.closeWindow();

  post({ type: 'network-timeout', message: 'No network connectivity' });
  post({ type: 'error', repo: 'Network', message: 'No network connectivity' });
  post({ type: 'sync-terminal', outcome: 'failed', reason: 'no_network_connectivity' });
  child.exit(1);
  h.clock.tick(1000);

  const after = h.openWindow();
  assert.strictEqual(after.status(), 'No network connectivity — sync aborted');
  assert.strictEqual(after.stopEnabled(), false);
});

test('a scheduled worker whose updates were all missed replaces the old "Complete!" on startup', (t) => {
  const h = makeHarness(t);
  // Yesterday's run, seen in full.
  const old = h.scheduledWorker();
  old.post({ type: 'sync-lifecycle', phase: 'starting' });
  old.post({ type: 'complete', stats: { total: 1, errors: 0 } });
  old.post({ type: 'sync-terminal', outcome: 'succeeded' });
  old.end('succeeded');
  assert.strictEqual(h.openWindow().status(), 'Complete!');
  h.closeWindow();

  // This morning's worker starts while the app is closed; its posts never arrive.
  const now = h.scheduledWorker();
  h.main.currentSyncView(); // what app startup runs

  const entry = h.status().syncState.stable;
  assert.deepStrictEqual([entry.attemptId, entry.phase], [now.id, 'unknown']);
  const win = h.openWindow();
  assert.strictEqual(win.status(), 'Sync status unknown — a sync may still be running');
  assert.strictEqual(win.stopEnabled(), false, 'Stop only works on Electron\'s own child');

  // Its next real update is accepted and shown.
  now.post({ type: 'sync-lifecycle', phase: 'syncing' });
  assert.strictEqual(win.status(), 'Syncing...');
  assert.strictEqual(h.status().syncState.stable.stats, null, 'yesterday\'s stats are not this run\'s');
});

test('an older attempt\'s delayed terminal cannot replace the running worker', (t) => {
  const h = makeHarness(t);
  // A ran and finished, but the app never heard from it.
  const a = h.scheduledWorker();
  a.end('failed');
  // B is running and known.
  const b = h.scheduledWorker();
  b.post({ type: 'sync-lifecycle', phase: 'starting' });
  b.post({ type: 'sync-lifecycle', phase: 'syncing' });

  a.post({ type: 'sync-terminal', outcome: 'failed' }); // A's last request, delayed

  const entry = h.status().syncState.stable;
  assert.deepStrictEqual([entry.attemptId, entry.phase], [b.id, 'syncing']);
  b.post({ type: 'progress', repo: 'o/one', status: 'Fetching', percent: 30 });
  assert.strictEqual(h.status().syncState.stable.phase, 'syncing');
  assert.strictEqual(h.openWindow().status(), 'Syncing...');
});

test('an older worker build gets its own view once the identified run is over', (t) => {
  const h = makeHarness(t);
  const done = h.scheduledWorker();
  done.post({ type: 'sync-lifecycle', phase: 'starting' });
  done.post({ type: 'sync-terminal', outcome: 'succeeded' });
  done.end();

  h.post({ type: 'waiting-for-network' }); // anonymous: an older worker build
  const during = h.openWindow();
  assert.strictEqual(during.status(), 'Sync status unknown — a sync may still be running');
  assert.strictEqual(during.stopEnabled(), false);
  h.closeWindow();

  h.post({ type: 'network-timeout', message: 'No network connectivity' });
  assert.strictEqual(h.openWindow().status(), 'No network connectivity — sync aborted');

  // A verified identified run takes over, and anonymous updates can't replace it.
  const next = h.scheduledWorker();
  next.post({ type: 'sync-lifecycle', phase: 'syncing' });
  h.post({ type: 'complete', stats: { total: 9, errors: 0 } });
  const entry = h.status().syncState.stable;
  assert.deepStrictEqual([entry.attemptId, entry.phase, entry.stats], [next.id, 'syncing', null]);
});

test('a worker whose Activity recording failed is shown as unknown, never as interrupted', (t) => {
  const h = makeHarness(t);
  // The worker reports an ID whose Activity has an owner lock file but no start record: what an
  // admission refusal leaves behind. Its lease is FREE and nothing is recorded.
  const w = new ActivityWriter(h.home, { kind: 'sync', channel: 'stable', trigger: 'scheduled', producer: 'electron' });
  const id = w.activityId;
  w._release_lease ? w._release_lease() : (w._lease && w._lease.release());
  const post = (p) => h.post({ ...p, attemptId: id, channel: 'stable' });
  post({ type: 'sync-lifecycle', phase: 'starting' });

  h.main.currentSyncView();
  assert.notStrictEqual(h.status().syncState.stable.phase, 'finished', 'no outcome was invented');
  assert.strictEqual(h.openWindow().status(), 'Sync status unknown — a sync may still be running');

  post({ type: 'complete', stats: { total: 1, errors: 0 } });
  post({ type: 'sync-terminal', outcome: 'succeeded' });
  const entry = h.status().syncState.stable;
  assert.deepStrictEqual([entry.outcome, entry.stats.total], ['succeeded', 1]);
  assert.strictEqual(h.window().status(), 'Complete!');
});

test('a finished attempt\'s start timer cannot repaint the window for the run after it', (t) => {
  const h = makeHarness(t);
  h.writeConfig(['o/one']);
  h.main.triggerSync({ showWindow: true });
  h.clock.tick(60); // the window has loaded; its 300 ms start sender is still pending
  const { child, env } = h.spawn();
  h.post({ type: 'sync-terminal', outcome: 'blocked', attemptId: env.REPO_RADAR_ACTIVITY_ID, channel: 'stable' });
  child.exit(1);

  // The scheduled worker starts before that timer fires, and is waiting for network.
  const b = h.scheduledWorker();
  b.post({ type: 'sync-lifecycle', phase: 'starting' });
  b.post({ type: 'waiting-for-network' });
  // The window is closed and reopened while the timer is still pending.
  h.closeWindow();
  const win = h.openWindow();
  assert.strictEqual(win.status(), 'Waiting for network...');

  h.clock.tick(1000); // the old attempt's start sender fires now
  assert.strictEqual(h.window().status(), 'Waiting for network...');
  assert.strictEqual(h.window().stopEnabled(), false, 'Stop is never offered for the scheduled worker');
  assert.strictEqual(h.status().syncState.stable.attemptId, b.id);
});

test('a finished attempt\'s delayed exit handling cannot overwrite the run after it', (t) => {
  const h = makeHarness(t);
  h.writeConfig(['o/one']);
  h.main.triggerSync({ showWindow: false });
  const { child, env } = h.spawn();
  h.post({ type: 'sync-terminal', outcome: 'succeeded', attemptId: env.REPO_RADAR_ACTIVITY_ID, channel: 'stable' });
  child.exit(0); // its 500 ms delayed handling is now pending
  const lastSync = h.status().lastSync;

  // The next run starts and fails inside that window.
  const b = h.scheduledWorker();
  b.post({ type: 'sync-lifecycle', phase: 'starting' });
  b.post({ type: 'error', repo: 'o/one', message: 'fetch failed' });
  b.post({ type: 'sync-terminal', outcome: 'failed' });
  b.end('failed');
  const iconsBefore = h.icons.length;

  h.clock.tick(1000);
  const status = h.status();
  assert.deepStrictEqual([status.syncState.stable.attemptId, status.syncState.stable.outcome], [b.id, 'failed']);
  assert.strictEqual(status.hasErrors, true, 'the failed run still reports its errors');
  assert.strictEqual(status.lastSync, lastSync, 'the old run did not stamp a completion over the failure');
  assert.ok(!h.icons.slice(iconsBefore).includes('icon-success.png'), 'no success icon over the failure');
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('a scheduled run\'s rows are laid out and kept, whenever the window opens', (t) => {
  const h = makeHarness(t);
  const win = h.openWindow(); // already open when the scheduled worker starts
  const b = h.scheduledWorker();
  b.post({ type: 'sync-lifecycle', phase: 'starting' });
  b.post({ type: 'waiting-for-network' });
  assert.strictEqual(win.status(), 'Waiting for network...');
  assert.strictEqual(win.stopEnabled(), false);

  b.post({ type: 'sync-lifecycle', phase: 'syncing' });
  b.post({ type: 'sync-roster', repos: [{ name: 'o/one', color: 'cyan' }, { name: 'o/two', color: 'red' }] });
  b.post({ type: 'progress', repo: 'o/one', status: 'Fetching', percent: 40, color: 'cyan' });
  assert.deepStrictEqual(win.rows(), { 'o/one': 'Fetching', 'o/two': 'Waiting...' });

  h.closeWindow();
  const reopened = h.openWindow();
  assert.deepStrictEqual(reopened.rows(), { 'o/one': 'Fetching', 'o/two': 'Waiting...' });
  assert.strictEqual(reopened.status(), 'Syncing...');
  assert.strictEqual(reopened.stopEnabled(), false);

  b.post({ type: 'progress', repo: 'o/two', status: 'Cloning', percent: 20, color: 'red' });
  // A repository the roster didn't list (or a roster that never arrived) still gets a row.
  b.post({ type: 'progress', repo: 'o/three', status: 'Cloning', percent: 10, color: 'green' });
  assert.deepStrictEqual(reopened.rows(), { 'o/one': 'Fetching', 'o/two': 'Cloning', 'o/three': 'Cloning' });
  assert.strictEqual(reopened.stopEnabled(), false);
  assert.strictEqual(h.status().syncState.stable.phase, 'syncing');
});

test('a Sync Now refused because the scheduled run holds the lock leaves that run\'s progress alone', async (t) => {
  const h = makeHarness(t);
  h.writeConfig(['o/manual']);
  const b = h.scheduledWorker();
  b.post({ type: 'sync-lifecycle', phase: 'starting' });
  b.post({ type: 'sync-roster', repos: [{ name: 'o/one', color: 'cyan' }] });
  b.post({ type: 'progress', repo: 'o/one', status: 'Fetching', percent: 40, color: 'cyan' });
  b.post({ type: 'error', repo: 'o/one', message: 'retrying fetch' });
  b.post({ type: 'output', data: 'scheduled log line' });
  const before = h.status();

  h.main.triggerSync({ showWindow: true });
  h.clock.tick(60);
  h.refuse(); // the root lock is the scheduled worker's
  await flush();
  h.clock.tick(500);

  const after = h.status();
  assert.deepStrictEqual(after.repos, before.repos);
  assert.deepStrictEqual(after.errorList, before.errorList);
  assert.strictEqual(after.logOutput, before.logOutput);
  assert.strictEqual(after.syncState.stable.attemptId, b.id);
  assert.deepStrictEqual(h.window().rows(), { 'o/one': 'Fetching' });
  assert.strictEqual(h.window().stopEnabled(), false);
  assert.strictEqual(h.notifications.length, 1, 'the "already running" notification stays');

  // Nothing of the refused attempt is left pending: a reopened window shows the scheduled run,
  // and the worker's next update still lands.
  h.closeWindow();
  const reopened = h.openWindow();
  b.post({ type: 'progress', repo: 'o/one', status: 'Merging', percent: 80, color: 'cyan' });
  assert.deepStrictEqual(reopened.rows(), { 'o/one': 'Merging' });
});

test('stable and dev each replay only their own run\'s rows, errors and log', (t) => {
  const stable = makeHarness(t);
  const dev = makeHarness(t, { channel: 'dev', home: stable.home });

  const s = stable.scheduledWorker();
  s.post({ type: 'sync-lifecycle', phase: 'starting' });
  s.post({ type: 'sync-roster', repos: [{ name: 's/one', color: 'cyan' }] });
  s.post({ type: 'progress', repo: 's/one', status: 'Done', percent: 100, color: 'cyan' });
  s.post({ type: 'output', data: 'stable log line' });
  s.post({ type: 'complete', stats: { total: 1, errors: 0 }, channel: 'stable', mode: 'full', trigger: 'scheduled' });
  s.post({ type: 'sync-terminal', outcome: 'succeeded' });
  s.end();
  const stableLastSync = stable.status().lastSync;
  assert.ok(stableLastSync, 'the qualifying stable run recorded its completion');

  const d = dev.scheduledWorker();
  d.post({ type: 'sync-lifecycle', phase: 'starting' });
  d.post({ type: 'sync-roster', repos: [{ name: 'd/two', color: 'red' }] });
  d.post({ type: 'progress', repo: 'd/two', status: 'Fetching', percent: 50, color: 'red' });
  d.post({ type: 'error', repo: 'd/two', message: 'dev fetch failed' });
  d.post({ type: 'output', data: 'dev log line' });
  d.post({ type: 'complete', stats: { total: 1, errors: 1 }, channel: 'dev', mode: 'full', trigger: 'scheduled' });
  d.post({ type: 'sync-terminal', outcome: 'failed' });
  d.end('failed');

  const win = stable.openWindow();
  assert.deepStrictEqual(Object.keys(win.rows()), ['s/one']);
  assert.strictEqual(win.status(), 'Complete!');
  const st = stable.status();
  assert.match(st.logOutput, /stable log line/);
  assert.doesNotMatch(st.logOutput, /dev log line/);
  assert.deepStrictEqual(st.errorList, []);
  assert.deepStrictEqual(st.syncRepos.map((r) => r.name), ['s/one']);
  assert.strictEqual(st.lastSync, stableLastSync, 'dev did not advance stable\'s completion time');

  const dwin = dev.openWindow();
  assert.deepStrictEqual(Object.keys(dwin.rows()), ['d/two']);
  assert.strictEqual(dev.status().errorList.length, 1);
});

test('final stats that arrive after the outcome are kept without turning it into a success', (t) => {
  const h = makeHarness(t);
  const a = h.scheduledWorker();
  a.post({ type: 'sync-lifecycle', phase: 'starting' });
  a.end('failed');
  const b = h.scheduledWorker();
  b.post({ type: 'sync-lifecycle', phase: 'starting' });
  b.post({ type: 'sync-roster', repos: [{ name: 'o/one', color: 'cyan' }] });
  b.post({ type: 'sync-terminal', outcome: 'failed' });
  const iconsBefore = h.icons.length;
  const lastSync = h.status().lastSync;

  b.post({ type: 'complete', stats: { total: 3, errors: 1, updated: 2, cloned: 0 }, channel: 'stable', mode: 'full', trigger: 'scheduled' });
  // An earlier attempt's numbers can't attach themselves to this run.
  a.post({ type: 'complete', stats: { total: 99, errors: 0 }, channel: 'stable', mode: 'full', trigger: 'scheduled' });

  const entry = h.status().syncState.stable;
  assert.deepStrictEqual([entry.attemptId, entry.outcome, entry.stats.total], [b.id, 'failed', 3]);
  assert.strictEqual(h.status().lastSync, lastSync, 'a failed run gets no completion time');
  assert.ok(!h.icons.slice(iconsBefore).includes('icon-success.png'), 'and no success icon');

  const win = h.openWindow();
  assert.strictEqual(win.status(), 'Sync failed — see ⚠️ View Errors in the menu');
  assert.strictEqual(win.doc.getElementById('repo-count').textContent, '3 repos synced');
  assert.strictEqual(win.stopEnabled(), false);
});

test('a run with no repositories says so, rather than reporting missing data', (t) => {
  const h = makeHarness(t);
  const b = h.scheduledWorker();
  b.post({ type: 'sync-lifecycle', phase: 'starting' });
  b.post({ type: 'sync-roster', repos: [] });
  const emptyNote = (win) => win.doc.getElementById('repos-list').textContent.trim();
  const win = h.openWindow();
  assert.strictEqual(emptyNote(win), 'No repositories configured');
  assert.strictEqual(win.doc.getElementById('repos-total').textContent, '0');
  assert.strictEqual(win.stopEnabled(), false, 'Stop follows the run\'s owner, not the roster');

  b.post({ type: 'sync-terminal', outcome: 'succeeded' });
  h.closeWindow();
  const reopened = h.openWindow();
  assert.strictEqual(emptyNote(reopened), 'No repositories configured');
  assert.strictEqual(reopened.status(), 'Complete!');
});
