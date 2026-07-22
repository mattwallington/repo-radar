# Spec 2A — Packaged Python Runtime Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind each installed Repo Radar build (channel + version) to its own bundled Python
package + fully-resolved dependencies, so manual/scheduled/CLI syncs always run the shipped
runtime — the sole production blocker for v1.0.27.

**Architecture:** A new `menubar/runtime/` module manages per-channel, per-version *generations*
under `~/.repo-radar/<channel>/generations/<version>-<fingerprint>-<nonce>/` (each = a venv + a
copy of the bundled `repo_radar` + launcher + `VERSION` + a `.runtime.json` marker). Electron's
`ensureRuntime()` provisions a generation and commits it with a single atomic `current` symlink
flip, gated by a published `desired.json` intent record. All syncs run through a generic,
self-verifying dispatcher that acquires a kernel `lockf` lock (fd mode) **before** resolving
`current`. Design of record: `docs/superpowers/specs/2026-07-22-runtime-binding-spec-2a-design.md`
(rev 7, Codex-approved).

**Tech Stack:** Node/CommonJS (Electron 32 main process, `child_process`, `fs`), macOS
`/usr/bin/lockf` + `launchctl`, POSIX `/bin/sh` dispatchers, Python 3.10–3.14 venvs,
`pip --require-hashes`, `pip-compile --generate-hashes` for locks.

## Global Constraints

Copied verbatim from the spec; every task's requirements implicitly include these.

- **Channel** ∈ {`stable`,`dev`} from `build-info.json`'s `channel`; **missing/malformed channel
  identity fails closed** (never defaults to stable).
- **Ownership:** stable solely owns `~/.local/bin/repo-radar`, the persistent LaunchAgent
  `com.user.repo-radar`, schedule config, and ALL legacy (1.0.26) migration/quiescence. Dev owns
  `repo-radar-dev`, never writes `repo-radar`, installs no persistent schedule, and hard-blocks
  shared-data-plane sync on ANY unmanaged/ambiguous stable state.
- **Locks:** kernel `/usr/bin/lockf` in **fd mode** — `exec 9>"$lock"; lockf -t <policy> 9; …;
  exec <worker>` so the lock rides the worker's inherited fd (kernel releases on worker death).
  Root execution lock `~/.repo-radar/.exec.lock` (all sync children, both channels); per-channel
  activation lock `~/.repo-radar/<channel>/.activation.lock`. Sync entry points use `-t 0` →
  exit `75` = busy. Order root-before-channel if ever both held.
- **Activation:** `desired.json` publication is the first managed-update/activation-intent
  mutation; commit point = one atomic `current` symlink flip (temp symlink + `rename(2)`, same
  dir). Runners fail closed while `current`≠`desired`. Two transitions (legacy bootstrap; managed
  update/rollback), direction-agnostic on compatible schemas, else fail closed.
- **Generations are immutable + nonce-unique** (`<version>-<fingerprint>-<nonce>`); never mutate
  an active generation before its replacement is committed.
- **Identity/version:** `app.getVersion()` is authoritative, corroborated with bundled `VERSION`;
  the `'2.0.0'` fallback in `main.js:getVersion()` is removed (fail closed). Each generation
  carries a `VERSION` file at its root (`repo_radar/__init__.py` reads `../VERSION`), so
  `repo-radar --version` == `app.getVersion()`.
- **Verification** (healthy predicate): `realpath(current)` inside the channel generations tree;
  `current`+marker match `desired.json`; live hashes of `repo_radar/` + launcher + `VERSION` ==
  marker == bundle; venv installed set == the checked-in expected manifest for its
  (python-minor, arch); interpreter fingerprint matches. Any miss → fail closed.
- **Deps:** provision installs from a checked-in `--generate-hashes` lock with `--require-hashes`;
  the expected-distribution manifest is generated from a real clean install (not static marker
  eval); bootstrap tooling (`pip`/`setuptools`/`wheel`) pinned/allow-listed.
- **Perms:** directories + executables `0700`; data files (`desired.json`, `.runtime.json`, logs)
  `0600`. Redact credentials in stored/displayed pip output.
- **GC:** delete only incomplete/invalid *never-activated* generations (retain every activated
  generation); no refcount/grace needed.
- **Stage by exact filename; never `git add -A`.** Every commit point builds + tests green.

## Prerequisites

- [ ] **P1: Test tooling.** Node is present. Runtime unit tests are Node (`node --test`). Some
  provisioning/interpreter tests need real Python interpreters; the dev machine has
  `/opt/homebrew/opt/python@3.10/bin/python3.10` (3.10.20), pyenv 3.12.8, 3.13.4. Confirm:
  ```bash
  node --version
  /opt/homebrew/opt/python@3.10/bin/python3.10 --version
  command -v /usr/bin/lockf && /usr/bin/lockf -t 0 /tmp/rr-lockf-probe /bin/echo ok
  ```
  Expected: Node ≥18; `Python 3.10.20`; `lockf` runs `ok`. If `pip-compile` (piptools) is absent,
  Task 5 installs it into a throwaway venv.

## File Structure

New module `menubar/runtime/` (split from the spec's single `runtime-manager.js` for focus/testability):

- `menubar/runtime/paths.js` — layout + path helpers; channel resolution (fail closed).
- `menubar/runtime/hashing.js` — `hashFile`, `hashTree` (deterministic), `redact`.
- `menubar/runtime/identity.js` — `authoritativeIdentity()`, `interpreterFingerprint()`.
- `menubar/runtime/interpreter.js` — `resolveBaseInterpreter()`.
- `menubar/runtime/lock.js` — Node fd-mode `lockf` acquire + shell lock-snippet emitter.
- `menubar/runtime/deps.js` — lock/manifest selection by fingerprint; `verifyInstalledSet()`.
- `menubar/runtime/provision.js` — `provision()` (staging → venv → hashed install → copy → smoke → marker).
- `menubar/runtime/desired.js` — `publishDesired()`, `readDesired()`, schema compat.
- `menubar/runtime/activation.js` — `verifyRuntime()` predicate, `flipCurrent()`, `adopt()`, `gcOrphans()`.
- `menubar/runtime/quiesce.js` — `quiesceLegacyStable()`, `detectStableManaged()`.
- `menubar/runtime/migrate.js` — CLI dispatcher install + legacy retire.
- `menubar/runtime/dispatchers.js` — emit `run-sync.sh` + CLI dispatcher (generic, self-verifying).
- `menubar/runtime/index.js` — `ensureRuntime()` orchestration + `runSync()` Node runner.
- `menubar/runtime/__tests__/*.test.js` — 7a scripted logic harness.
- `menubar/scripts/upgrade-smoke.sh` — 7b built-artifact packaged upgrade smoke.
- `resources/pydeps/<pyMinor>-<arch>.lock` + `resources/pydeps/<pyMinor>-<arch>.manifest.json` — checked-in.
- `menubar/scripts/pydeps.js` — regenerate locks/manifests (explicit) + `--check` freshness (build-time).
- Modified: `menubar/main.js`, `menubar/package.json` (extraResources), `menubar/SETUP.md`, `README.md`.

---

## Task 1: Layout + channel resolution (`runtime/paths.js`)

**Files:**
- Create: `menubar/runtime/paths.js`
- Test: `menubar/runtime/__tests__/paths.test.js`

**Interfaces:**
- Produces: `resolveChannel(buildInfoPath) -> 'stable'|'dev'` (throws `ChannelError` on missing/malformed);
  `layout(home, channel)` -> `{ root, execLock, channelDir, activationLock, desired, generations,
  current, runSync, provisionLog }` (absolute paths); `generationDir(channel, home, genId)`;
  `cliPath(home, channel)` -> `~/.local/bin/repo-radar` (stable) or `repo-radar-dev` (dev).

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
const { resolveChannel, layout, cliPath, ChannelError } = require('../paths');

test('resolveChannel reads build-info channel', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-'));
  fs.writeFileSync(path.join(d, 'build-info.json'), JSON.stringify({ channel: 'dev' }));
  assert.strictEqual(resolveChannel(path.join(d, 'build-info.json')), 'dev');
});
test('resolveChannel fails closed when missing', () => {
  assert.throws(() => resolveChannel('/no/such/build-info.json'), ChannelError);
});
test('resolveChannel fails closed on malformed channel', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-'));
  fs.writeFileSync(path.join(d, 'build-info.json'), JSON.stringify({ channel: 'prod' }));
  assert.throws(() => resolveChannel(path.join(d, 'build-info.json')), ChannelError);
});
test('layout composes channel-namespaced paths; root lock is shared', () => {
  const L = layout('/H', 'dev');
  assert.strictEqual(L.execLock, '/H/.repo-radar/.exec.lock');
  assert.strictEqual(L.activationLock, '/H/.repo-radar/dev/.activation.lock');
  assert.strictEqual(L.current, '/H/.repo-radar/dev/current');
  assert.strictEqual(cliPath('/H', 'dev'), '/H/.local/bin/repo-radar-dev');
  assert.strictEqual(cliPath('/H', 'stable'), '/H/.local/bin/repo-radar');
});
```

- [ ] **Step 2: Run test to verify it fails** — `node --test menubar/runtime/__tests__/paths.test.js` → FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```js
'use strict';
const path = require('path');
const fs = require('fs');

class ChannelError extends Error {}

function resolveChannel(buildInfoPath) {
  let ch;
  try { ch = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8')).channel; }
  catch (e) { throw new ChannelError(`build-info unreadable: ${e.message}`); }
  if (ch !== 'stable' && ch !== 'dev') throw new ChannelError(`invalid channel: ${ch}`);
  return ch;
}

function layout(home, channel) {
  const root = path.join(home, '.repo-radar');
  const channelDir = path.join(root, channel);
  return {
    root,
    execLock: path.join(root, '.exec.lock'),
    channelDir,
    activationLock: path.join(channelDir, '.activation.lock'),
    desired: path.join(channelDir, 'desired.json'),
    generations: path.join(channelDir, 'generations'),
    current: path.join(channelDir, 'current'),
    runSync: path.join(channelDir, 'run-sync.sh'),
    provisionLog: path.join(channelDir, 'provision.log'),
  };
}

function generationDir(home, channel, genId) {
  return path.join(layout(home, channel).generations, genId);
}

function cliPath(home, channel) {
  return path.join(home, '.local', 'bin', channel === 'dev' ? 'repo-radar-dev' : 'repo-radar');
}

module.exports = { ChannelError, resolveChannel, layout, generationDir, cliPath };
```

- [ ] **Step 4: Run test to verify it passes** — `node --test menubar/runtime/__tests__/paths.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add menubar/runtime/paths.js menubar/runtime/__tests__/paths.test.js
git commit -m "feat(runtime): channel resolution + namespaced path layout"
```

---

## Task 2: Deterministic hashing + redaction (`runtime/hashing.js`)

**Files:**
- Create: `menubar/runtime/hashing.js`
- Test: `menubar/runtime/__tests__/hashing.test.js`

**Interfaces:**
- Produces: `hashFile(p) -> sha256 hex`; `hashTree(dir) -> sha256 hex` (stable across runs: sorted
  relative paths + per-file content, excludes `__pycache__`/`*.pyc`); `redact(text) -> text` with
  credentials in `https://user:pass@host` and `//token@` index URLs replaced by `//<redacted>@`.

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test'); const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
const { hashFile, hashTree, redact } = require('../hashing');

test('hashTree is order-independent and content-sensitive', () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-'));
  fs.mkdirSync(path.join(a, 'sub'));
  fs.writeFileSync(path.join(a, 'sub', 'b.py'), 'x'); fs.writeFileSync(path.join(a, 'a.py'), 'y');
  const h1 = hashTree(a);
  fs.mkdirSync(path.join(a, '__pycache__')); fs.writeFileSync(path.join(a, '__pycache__', 'c.pyc'), 'junk');
  assert.strictEqual(hashTree(a), h1, 'pycache excluded');
  fs.writeFileSync(path.join(a, 'a.py'), 'changed');
  assert.notStrictEqual(hashTree(a), h1, 'content change detected');
});
test('redact strips index-url credentials', () => {
  assert.strictEqual(redact('installing from https://tok3n:secret@pypi.example/simple'),
    'installing from https://<redacted>@pypi.example/simple');
});
```

- [ ] **Step 2: Run test** → FAIL.

- [ ] **Step 3: Write minimal implementation**

```js
'use strict';
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');

function hashFile(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function _walk(dir, base, out) {
  for (const name of fs.readdirSync(dir).sort()) {
    if (name === '__pycache__') continue;
    const abs = path.join(dir, name);
    const st = fs.lstatSync(abs);
    const rel = path.relative(base, abs);
    if (st.isDirectory()) { _walk(abs, base, out); }
    else if (st.isFile() && !name.endsWith('.pyc')) { out.push([rel, hashFile(abs)]); }
  }
  return out;
}

function hashTree(dir) {
  const entries = _walk(dir, dir, []).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const h = crypto.createHash('sha256');
  for (const [rel, fh] of entries) h.update(rel).update('\0').update(fh).update('\0');
  return h.digest('hex');
}

function redact(text) {
  return String(text).replace(/\/\/[^/@\s]+@/g, '//<redacted>@');
}

module.exports = { hashFile, hashTree, redact };
```

- [ ] **Step 4: Run test** → PASS.

- [ ] **Step 5: Commit**

```bash
git add menubar/runtime/hashing.js menubar/runtime/__tests__/hashing.test.js
git commit -m "feat(runtime): deterministic tree hashing + credential redaction"
```

---

## Task 3: Base interpreter resolution (`runtime/interpreter.js`)

**Files:**
- Create: `menubar/runtime/interpreter.js`
- Test: `menubar/runtime/__tests__/interpreter.test.js`

**Interfaces:**
- Consumes: nothing from prior tasks.
- Produces: `resolveBaseInterpreter(opts?) -> { exe, version:[maj,min,patch], impl, arch }` (throws
  `NoInterpreterError` if none in `[3.10,3.15)`); `probe(exe) -> {version,impl,arch}|null`.
  Probe order: `/opt/homebrew/bin/python3`, `/usr/local/bin/python3`, `pyenv which python3`
  (resolved real exe), then `python3` on PATH. `opts.candidates` overrides the list for tests.

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test'); const assert = require('node:assert');
const { resolveBaseInterpreter, probe, NoInterpreterError } = require('../interpreter');

const PY310 = '/opt/homebrew/opt/python@3.10/bin/python3.10';
test('probe returns version/impl/arch for a real interpreter', () => {
  const info = probe(PY310);
  assert.ok(info); assert.deepStrictEqual(info.version.slice(0, 2), [3, 10]);
  assert.strictEqual(info.impl, 'cpython');
});
test('resolveBaseInterpreter picks a valid 3.10-3.14 real exe from candidates', () => {
  const r = resolveBaseInterpreter({ candidates: ['/no/such/py', PY310] });
  assert.strictEqual(r.exe, PY310);
  assert.ok(r.version[1] >= 10 && r.version[1] < 15);
});
test('resolveBaseInterpreter fails closed when nothing valid', () => {
  assert.throws(() => resolveBaseInterpreter({ candidates: ['/no/such/py'] }), NoInterpreterError);
});
```

- [ ] **Step 2: Run test** → FAIL.

- [ ] **Step 3: Write minimal implementation**

```js
'use strict';
const { execFileSync } = require('child_process');

class NoInterpreterError extends Error {}
const PROBE = 'import sys,platform;print(sys.version_info[0],sys.version_info[1],sys.version_info[2],sys.implementation.name,platform.machine())';

function probe(exe) {
  try {
    const out = execFileSync(exe, ['-c', PROBE], { encoding: 'utf8', timeout: 8000 }).trim().split(/\s+/);
    return { version: [+out[0], +out[1], +out[2]], impl: out[3], arch: out[4] };
  } catch (e) { return null; }
}

function _pyenvWhich() {
  try { return execFileSync('pyenv', ['which', 'python3'], { encoding: 'utf8', timeout: 8000 }).trim() || null; }
  catch (e) { return null; }
}

function resolveBaseInterpreter(opts = {}) {
  const candidates = opts.candidates || [
    '/opt/homebrew/bin/python3', '/usr/local/bin/python3', _pyenvWhich(), 'python3',
  ].filter(Boolean);
  for (const exe of candidates) {
    const info = probe(exe);
    if (info && info.version[0] === 3 && info.version[1] >= 10 && info.version[1] < 15) {
      return { exe, ...info };
    }
  }
  throw new NoInterpreterError('no CPython 3.10-3.14 interpreter found');
}

module.exports = { NoInterpreterError, probe, resolveBaseInterpreter };
```

- [ ] **Step 4: Run test** → PASS.

- [ ] **Step 5: Commit**

```bash
git add menubar/runtime/interpreter.js menubar/runtime/__tests__/interpreter.test.js
git commit -m "feat(runtime): base interpreter resolution to a real 3.10-3.14 executable"
```

---

## Task 4: Kernel fd-mode lock (`runtime/lock.js`)

**Files:**
- Create: `menubar/runtime/lock.js`
- Test: `menubar/runtime/__tests__/lock.test.js`

**Interfaces:**
- Produces: `withLock(lockPath, timeoutSec, fn)` — Node side: opens `lockPath` on a fd, acquires
  via `lockf` in fd mode holding it for `fn`'s duration, returns `fn`'s result; throws `LockBusy`
  (with `.code===75`) on `-t 0` contention. `shellLockPreamble(lockPath, timeoutSec)` -> a POSIX
  `sh` snippet (string) using `exec 9>…; /usr/bin/lockf -t N 9 || exit $?` for embedding in
  dispatchers.

**Design note (verbatim from spec §3.3):** the lock must ride the *worker's* fd. Node's helper
opens the fd, runs `lockf -t N <fd>` against it, keeps the fd open for the callback, and closes it
after (kernel releases). Shell dispatchers open fd 9 and `exec` the worker so the worker inherits
the locked fd.

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test'); const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
const cp = require('child_process');
const { withLock, shellLockPreamble, LockBusy } = require('../lock');

test('withLock is mutually exclusive (-t 0 => LockBusy while held)', async () => {
  const lock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rr-')), '.lock');
  let released;
  const held = withLock(lock, 0, () => new Promise(r => { released = r; }));
  await new Promise(r => setTimeout(r, 100));
  await assert.rejects(withLock(lock, 0, () => 'x'), e => e instanceof LockBusy && e.code === 75);
  released(); await held;
  assert.strictEqual(await withLock(lock, 0, () => 'ok'), 'ok'); // free again
});

test('shell preamble emits fd-mode lockf', () => {
  const s = shellLockPreamble('/H/.exec.lock', 0);
  assert.match(s, /exec 9>"\/H\/\.exec\.lock"/);
  assert.match(s, /\/usr\/bin\/lockf -t 0 9 \|\| exit \$\?/);
});
```

- [ ] **Step 2: Run test** → FAIL.

- [ ] **Step 3: Write minimal implementation**

```js
'use strict';
const fs = require('fs');
const { spawnSync } = require('child_process');

class LockBusy extends Error { constructor(m){ super(m); this.code = 75; } }

// Acquire an fd-mode lockf lock on `lockPath`, hold it for `fn`, release after.
async function withLock(lockPath, timeoutSec, fn) {
  const fd = fs.openSync(lockPath, 'a'); // create/open persistent lock file
  // lockf in fd mode against the inherited descriptor.
  const r = spawnSync('/usr/bin/lockf', ['-t', String(timeoutSec), String(fd)],
    { stdio: 'ignore', /* fd inherited */ });
  if (r.status !== 0) {
    fs.closeSync(fd);
    if (r.status === 75) throw new LockBusy(`lock busy: ${lockPath}`);
    throw new Error(`lockf failed (${r.status}) on ${lockPath}`);
  }
  try { return await fn(); }
  finally { fs.closeSync(fd); } // closing the fd releases the kernel lock
}

function shellLockPreamble(lockPath, timeoutSec) {
  return `exec 9>"${lockPath}"\n/usr/bin/lockf -t ${timeoutSec} 9 || exit $?\n`;
}

module.exports = { LockBusy, withLock, shellLockPreamble };
```

**Note for implementer:** `spawnSync('/usr/bin/lockf', ['-t', N, String(fd)])` must inherit fd
`fd` into the child. Node inherits fds 0–2 by default; pass an explicit `stdio` array that maps the
numeric `fd` through (e.g. build a stdio array of length `fd+1` with `'ignore'` for 0–2 and `fd`
for the slot, or use `{ stdio: ['ignore','ignore','ignore', fd] }` when `fd===3`). Because the fd
number is dynamic, open the lock file, then `dup2` it to a known slot via a tiny wrapper: the
robust form is to pass `stdio: ['ignore','ignore','ignore', {type:'fd', fd}]` — verify the child
sees it as fd 3 and call `lockf -t N 3`. Adjust the test's expectation to the fd number you route.

- [ ] **Step 4: Run test** → PASS (adjust routed fd number consistently in impl + `lockf` arg).

- [ ] **Step 5: Commit**

```bash
git add menubar/runtime/lock.js menubar/runtime/__tests__/lock.test.js
git commit -m "feat(runtime): kernel fd-mode lockf helper (Node + shell preamble)"
```

---

## Task 5: Authoritative identity + fingerprint (`runtime/identity.js`)

**Files:** Create `menubar/runtime/identity.js`; Test `menubar/runtime/__tests__/identity.test.js`

**Interfaces:**
- Consumes: `probe` (Task 3), `hashFile` (Task 2).
- Produces: `authoritativeIdentity({appVersion, bundledVersionPath}) -> {version}` — throws
  `IdentityError` if `appVersion` is falsy/`2.0.0` or bundled `VERSION` mismatches (fail closed);
  `interpreterFingerprint(exe) -> "cpython-3.10.20-arm64"` (from `probe`); `generationId(version,
  fingerprint, nonce) -> "<version>-<fingerprint>-<nonce>"`; `newNonce() -> hex(12)`.

- [ ] **Step 1: failing test**

```js
const test=require('node:test'); const assert=require('node:assert');
const os=require('os'),fs=require('fs'),path=require('path');
const { authoritativeIdentity, interpreterFingerprint, generationId, IdentityError } = require('../identity');
const PY310='/opt/homebrew/opt/python@3.10/bin/python3.10';

test('identity requires app version to match bundled VERSION and reject 2.0.0', () => {
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'rr-')); const vp=path.join(d,'VERSION');
  fs.writeFileSync(vp,'1.0.27\n');
  assert.deepStrictEqual(authoritativeIdentity({appVersion:'1.0.27',bundledVersionPath:vp}),{version:'1.0.27'});
  assert.throws(()=>authoritativeIdentity({appVersion:'2.0.0',bundledVersionPath:vp}),IdentityError);
  assert.throws(()=>authoritativeIdentity({appVersion:'1.0.26',bundledVersionPath:vp}),IdentityError);
});
test('fingerprint + generationId', () => {
  assert.match(interpreterFingerprint(PY310), /^cpython-3\.10\.\d+-(arm64|x86_64)$/);
  assert.strictEqual(generationId('1.0.27','cpython-3.10.20-arm64','abcd'),'1.0.27-cpython-3.10.20-arm64-abcd');
});
```

- [ ] **Step 2: run** → FAIL. **Step 3: implement**

```js
'use strict';
const fs=require('fs'); const crypto=require('crypto'); const { probe }=require('./interpreter');
class IdentityError extends Error {}
function authoritativeIdentity({appVersion, bundledVersionPath}) {
  if (!appVersion || appVersion === '2.0.0') throw new IdentityError(`unsafe app version: ${appVersion}`);
  let bundled; try { bundled = fs.readFileSync(bundledVersionPath,'utf8').trim(); }
  catch (e) { throw new IdentityError(`bundled VERSION unreadable: ${e.message}`); }
  if (bundled !== appVersion) throw new IdentityError(`VERSION mismatch app=${appVersion} bundled=${bundled}`);
  return { version: appVersion };
}
function interpreterFingerprint(exe) {
  const i = probe(exe); if (!i) throw new IdentityError(`cannot probe ${exe}`);
  return `${i.impl}-${i.version.join('.')}-${i.arch}`;
}
const generationId = (v,fp,n) => `${v}-${fp}-${n}`;
const newNonce = () => crypto.randomBytes(6).toString('hex');
module.exports = { IdentityError, authoritativeIdentity, interpreterFingerprint, generationId, newNonce };
```

- [ ] **Step 4: run** → PASS. **Step 5: commit**

```bash
git add menubar/runtime/identity.js menubar/runtime/__tests__/identity.test.js
git commit -m "feat(runtime): authoritative identity (no 2.0.0) + interpreter fingerprint"
```

---

## Task 6: Checked-in dependency lock(s) + expected manifests + freshness tool

**Files:**
- Create: `resources/pydeps/<pyMinor>-<arch>.lock`, `resources/pydeps/<pyMinor>-<arch>.manifest.json`
  for each supported env actually buildable on this machine (start: `cp310-arm64`, `cp312-arm64`,
  `cp313-arm64`; **document** the remaining matrix cells as a release blocker — see Step 4).
- Create: `menubar/scripts/pydeps.js` (regenerate + `--check`).
- Create: `menubar/runtime/deps.js` (`selectFor(fingerprint)`, `verifyInstalledSet(venvPython, manifest)`).
- Modify: `menubar/package.json` `build.extraResources` to bundle `resources/pydeps` → `resources/pydeps`.
- Test: `menubar/runtime/__tests__/deps.test.js`

**Interfaces:**
- Produces: `selectFor(fingerprint) -> { lockPath, manifestPath }`; `verifyInstalledSet(venvPython,
  manifest) -> {ok:boolean, extra:[], missing:[], mismatched:[]}` where installed set is
  `pip list --format=json` minus the manifest's `bootstrap` allow-list, compared name==version to
  `manifest.dists`.

- [ ] **Step 1: Generate the lock + manifest for cp310-arm64 (real install).**

```bash
# in a throwaway venv, pin the resolver, compile a hashed lock from requirements.txt
/opt/homebrew/opt/python@3.10/bin/python3.10 -m venv /tmp/rr-lockgen && \
  /tmp/rr-lockgen/bin/pip install -q pip-tools && \
  /tmp/rr-lockgen/bin/pip-compile --generate-hashes --allow-unsafe \
    -o resources/pydeps/cp310-arm64.lock requirements.txt
# derive the expected manifest from a REAL clean install of that lock
/opt/homebrew/opt/python@3.10/bin/python3.10 -m venv /tmp/rr-verify && \
  /tmp/rr-verify/bin/pip install -q --require-hashes -r resources/pydeps/cp310-arm64.lock && \
  node menubar/scripts/pydeps.js --emit-manifest /tmp/rr-verify/bin/python \
    resources/pydeps/cp310-arm64.manifest.json
```
`pydeps.js --emit-manifest <python> <out>` runs `pip list --format=json`, splits out bootstrap
(`pip`,`setuptools`,`wheel`) into `manifest.bootstrap` (name==version) and the rest into
`manifest.dists`, plus `{pyMinor, arch, lockSha256}`. Repeat for cp312/cp313-arm64.

- [ ] **Step 2: Write `menubar/scripts/pydeps.js`** with subcommands `--emit-manifest`,
  `--check` (recompile to a temp file and diff against the checked-in lock; nonzero on drift).

- [ ] **Step 3: Write `menubar/runtime/deps.js`** and its test.

```js
// deps.test.js (excerpt)
const { selectFor, verifyInstalledSet } = require('../deps');
test('selectFor maps fingerprint -> lock+manifest', () => {
  const s = selectFor('cpython-3.10.20-arm64');
  assert.match(s.lockPath, /cp310-arm64\.lock$/); assert.match(s.manifestPath, /cp310-arm64\.manifest\.json$/);
});
test('verifyInstalledSet flags extras/mismatches vs manifest', () => { /* against a real /tmp/rr-verify venv */ });
```
```js
// deps.js (core)
'use strict';
const path=require('path'); const { execFileSync }=require('child_process');
const PYDEPS = () => path.join(process.resourcesPath || path.join(__dirname,'..','..'), 'resources','pydeps');
function selectFor(fingerprint){ // "cpython-3.10.20-arm64" -> cp310-arm64
  const m=/^cpython-3\.(\d+)\.\d+-(arm64|x86_64)$/.exec(fingerprint);
  if(!m) throw new Error(`unsupported env: ${fingerprint}`);
  const tag=`cp3${m[1]}-${m[2]}`;
  return { lockPath: path.join(PYDEPS(),`${tag}.lock`), manifestPath: path.join(PYDEPS(),`${tag}.manifest.json`) };
}
function verifyInstalledSet(venvPython, manifest){
  const listed=JSON.parse(execFileSync(venvPython,['-m','pip','list','--format=json'],{encoding:'utf8'}));
  const boot=new Set(Object.keys(manifest.bootstrap).map(s=>s.toLowerCase()));
  const got={}; for(const d of listed){ const n=d.name.toLowerCase(); if(!boot.has(n)) got[n]=d.version; }
  const want=manifest.dists; const extra=[],missing=[],mismatched=[];
  for(const n of Object.keys(got)) if(!(n in want)) extra.push(n);
  for(const n of Object.keys(want)){ if(!(n in got)) missing.push(n); else if(got[n]!==want[n]) mismatched.push(n); }
  return { ok: !extra.length && !missing.length && !mismatched.length, extra, missing, mismatched };
}
module.exports={ selectFor, verifyInstalledSet };
```

- [ ] **Step 4: Matrix coverage note (release blocker — `log()` it, don't hide).** Only the
  interpreters installed on the build host can have locks/manifests generated. cp311/cp314 and all
  x86_64 cells are **not** covered until generated on native/equivalent hosts. Add a top-of-file
  comment in `resources/pydeps/README.md` listing covered vs. uncovered cells; the packaged smoke
  (Task 17) and release gate must treat an uncovered `(pyMinor,arch)` as **fail closed** at
  provision (Task 7 handles the "no lock for env" path). Decision per spec §3.6: cover the shipped
  matrix or narrow the supported interpreter range and state it in `SETUP.md`.

- [ ] **Step 5: Bundle + commit**

```bash
# package.json: add {"from":"../resources/pydeps","to":"resources/pydeps"} to build.extraResources
git add resources/pydeps menubar/scripts/pydeps.js menubar/runtime/deps.js \
        menubar/runtime/__tests__/deps.test.js menubar/package.json resources/pydeps/README.md
git commit -m "feat(runtime): checked-in hashed dep locks + expected manifests + freshness tool"
```

---

## Task 7: Provision a generation (`runtime/provision.js`)

**Files:** Create `menubar/runtime/provision.js`; Test `menubar/runtime/__tests__/provision.test.js`

**Interfaces:**
- Consumes: `resolveBaseInterpreter`/`interpreterFingerprint` (3/5), `selectFor`/`verifyInstalledSet`
  (6), `hashTree`/`hashFile`/`redact` (2), `newNonce`/`generationId` (5), `layout`/`generationDir` (1).
- Produces: `provision({home, channel, identity, bundle, logPath}) -> { genId, genDir, marker }`.
  `bundle = { repoRadarDir, launcher, versionFile }` (absolute paths to the bundled
  `resources/repo_radar`, `resources/repo-radar`, `VERSION`). Builds into a **staging** dir
  `generations/<genId>.staging-<pid>`, then atomically `rename`s to `generations/<genId>`.
  On any failure: remove the staging dir, append a **redacted** reason to `logPath`, throw
  `ProvisionError`. Never touches an existing complete generation.

- [ ] **Step 1: failing test** (real venv build in a temp HOME)

```js
const { provision, ProvisionError } = require('../provision');
test('provision builds a self-contained generation with venv+source+launcher+VERSION+marker', () => {
  // bundle = the worktree's own repo_radar + repo-radar + VERSION
  const res = provision({ home: TMP, channel:'stable',
    identity:{version:'1.0.27'}, bundle: BUNDLE, logPath: LOG });
  const g = res.genDir;
  assert.ok(fs.existsSync(path.join(g,'venv','bin','python')));
  assert.ok(fs.existsSync(path.join(g,'repo_radar','__init__.py')));
  assert.ok(fs.existsSync(path.join(g,'repo-radar')));
  assert.strictEqual(fs.readFileSync(path.join(g,'VERSION'),'utf8').trim(),'1.0.27');
  // runtime reports the right version
  const v = cp.execFileSync(path.join(g,'venv','bin','python'),[path.join(g,'repo-radar'),'--version'],
    {encoding:'utf8', env:{...process.env, PYTHONPATH:g}});
  assert.match(v, /1\.0\.27/);
  // marker records hashes + installed-set ok
  assert.strictEqual(res.marker.version,'1.0.27');
  assert.ok(res.marker.installedSetOk);
});
```

- [ ] **Step 2: run** → FAIL. **Step 3: implement** `provision.js`:

```js
'use strict';
const fs=require('fs'); const path=require('path'); const { execFileSync }=require('child_process');
const { resolveBaseInterpreter, interpreterFingerprint }=require('./interpreter');
const { newNonce, generationId }=require('./identity');
const { hashTree, hashFile, redact }=require('./hashing');
const { selectFor, verifyInstalledSet }=require('./deps');
const { layout }=require('./paths');
class ProvisionError extends Error {}

function _cpDir(src,dst){ fs.cpSync(src,dst,{recursive:true, filter:(p)=>!p.includes('__pycache__')&&!p.endsWith('.pyc')}); }

function provision({home, channel, identity, bundle, logPath}) {
  const L=layout(home,channel); fs.mkdirSync(L.generations,{recursive:true, mode:0o700});
  const base=resolveBaseInterpreter();
  const fp=`${base.impl}-${base.version.join('.')}-${base.arch}`; // == interpreterFingerprint(base.exe)
  const nonce=newNonce(); const genId=generationId(identity.version, fp, nonce);
  const staging=path.join(L.generations, `${genId}.staging-${process.pid}`);
  const genDir=path.join(L.generations, genId);
  try {
    fs.mkdirSync(staging,{recursive:true, mode:0o700});
    execFileSync(base.exe,['-m','venv',path.join(staging,'venv')],{stdio:'pipe'});
    const venvPy=path.join(staging,'venv','bin','python');
    const { lockPath, manifestPath }=selectFor(fp);
    if(!fs.existsSync(lockPath)) throw new ProvisionError(`no dependency lock for env ${fp}`);
    execFileSync(venvPy,['-m','pip','install','--require-hashes','-r',lockPath],{stdio:'pipe'});
    _cpDir(bundle.repoRadarDir, path.join(staging,'repo_radar'));
    fs.copyFileSync(bundle.launcher, path.join(staging,'repo-radar')); fs.chmodSync(path.join(staging,'repo-radar'),0o755);
    fs.copyFileSync(bundle.versionFile, path.join(staging,'VERSION'));
    // smoke: import + exact-version + installed-set
    execFileSync(venvPy,['-c','import repo_radar, litellm; assert litellm.__version__.startswith("1.93")'],
      {stdio:'pipe', env:{...process.env, PYTHONPATH:staging}});
    const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
    const setCheck=verifyInstalledSet(venvPy, manifest);
    if(!setCheck.ok) throw new ProvisionError(`installed set != manifest: ${JSON.stringify(setCheck)}`);
    const marker={ schema:1, version:identity.version, channel, genId, fingerprint:fp,
      sourceSha:hashTree(path.join(staging,'repo_radar')),
      launcherSha:hashFile(path.join(staging,'repo-radar')),
      versionSha:hashFile(path.join(staging,'VERSION')),
      versionValue:identity.version, lockSha:hashFile(lockPath), installedSetOk:true };
    fs.writeFileSync(path.join(staging,'.runtime.json'), JSON.stringify(marker,null,2),{mode:0o600});
    fs.renameSync(staging, genDir); // atomic: staging complete -> immutable generation
    return { genId, genDir, marker };
  } catch (e) {
    try { fs.rmSync(staging,{recursive:true, force:true}); } catch(_){}
    try { fs.appendFileSync(logPath, redact(`[provision ${genId}] ${e.stack||e.message}\n`),{mode:0o600}); } catch(_){}
    throw e instanceof ProvisionError ? e : new ProvisionError(e.message);
  }
}
module.exports={ ProvisionError, provision };
```

- [ ] **Step 4: run** → PASS (needs cp3xx lock+manifest from Task 6 for the base interpreter's env).
- [ ] **Step 5: commit**

```bash
git add menubar/runtime/provision.js menubar/runtime/__tests__/provision.test.js
git commit -m "feat(runtime): provision a self-contained, hash-verified generation"
```

---

## Task 8: Desired-state intent record (`runtime/desired.js`)

**Files:** Create `menubar/runtime/desired.js`; Test `menubar/runtime/__tests__/desired.test.js`

**Interfaces:** `publishDesired(desiredPath, obj)` (atomic temp+rename, mode 0600, `schema:1`);
`readDesired(desiredPath) -> obj|null`; `schemaCompatible(obj) -> boolean` (only `schema:1` now).
Desired shape: `{schema, channel, version, genId, sourceSha, launcherSha, versionSha, lockSha}`.

- [ ] **Step 1: failing test** — publish then read round-trips; partial write never observed
  (write to `desired.json.tmp` then `rename`); `schemaCompatible({schema:2})===false`.
- [ ] **Step 2/3: implement** using `fs.writeFileSync(tmp,…,{mode:0o600}); fs.renameSync(tmp, desiredPath)`.
- [ ] **Step 4/5: run/commit**

```bash
git add menubar/runtime/desired.js menubar/runtime/__tests__/desired.test.js
git commit -m "feat(runtime): atomic schema-versioned desired.json intent record"
```

---

## Task 9: Verification predicate + activation + GC (`runtime/activation.js`)

**Files:** Create `menubar/runtime/activation.js`; Test `menubar/runtime/__tests__/activation.test.js`

**Interfaces:**
- Consumes: `hashTree`/`hashFile` (2), `readDesired` (8), `layout` (1), `selectFor`/`verifyInstalledSet` (6).
- Produces: `verifyRuntime({home, channel, genDir, desired}) -> {ok, reasons:[]}` (the full healthy
  predicate incl. `realpath` containment, marker==desired, live source/launcher/VERSION hashes ==
  marker == desired, `repo-radar --version`==version, installed set == manifest, fingerprint);
  `flipCurrent(home, channel, genDir)` (atomic symlink: write `current.tmp` symlink → `rename`);
  `adopt({home, channel, desired}) -> genDir|null` (scan generations for a complete dir whose
  marker matches the *entire* desired identity **and** `verifyRuntime` passes);
  `gcOrphans(home, channel, {keepActivated})` (remove only `*.staging-*` and complete-but-invalid
  **never-activated** generations; never remove the `realpath(current)` target or any activated one).

- [ ] **Step 1: failing tests**
  - `flipCurrent` then `realpath(current)` == genDir; a second flip to a different gen re-points atomically.
  - `verifyRuntime` fails when `current/VERSION` is tampered (hash≠marker) and when installed set drifts.
  - `adopt` returns a matching complete generation; returns null after tampering it.
  - `gcOrphans` removes a `*.staging-*` dir and a never-activated invalid gen, but **retains** the
    activated `current` target.
- [ ] **Step 2/3: implement.** `flipCurrent`:

```js
function flipCurrent(home, channel, genDir){
  const L=require('./paths').layout(home,channel);
  const tmp=L.current+'.tmp-'+process.pid;
  try{ fs.unlinkSync(tmp);}catch(_){}
  fs.symlinkSync(genDir, tmp); fs.renameSync(tmp, L.current); // atomic replace within channelDir
}
```
`verifyRuntime` returns `{ok:false, reasons}` accumulating each failed clause; callers fail closed
on `!ok`. `gcOrphans` computes `realpath(current)` (if present), then for each entry in
`generations/`: delete if name matches `*.staging-*`, OR (complete but `verifyRuntime`-invalid AND
not equal to `realpath(current)` AND not recorded as activated) — a generation is "activated" iff it
has ever been the `current` target; 2A tracks this by refusing to delete anything that is currently
`realpath(current)` and by only ever GC-ing staging/never-flipped dirs (record activated genIds in
`<channelDir>/activated.json`, appended at each `flipCurrent`).
- [ ] **Step 4/5: run/commit**

```bash
git add menubar/runtime/activation.js menubar/runtime/__tests__/activation.test.js
git commit -m "feat(runtime): healthy predicate, atomic current flip, adoption, safe GC"
```

---

## Task 10: Generic self-verifying dispatchers (`runtime/dispatchers.js`)

**Files:** Create `menubar/runtime/dispatchers.js`; Test `menubar/runtime/__tests__/dispatchers.test.js`

**Interfaces:**
- Consumes: `shellLockPreamble` (4), `layout`/`cliPath` (1).
- Produces: `emitRunSync(home, channel)` — writes `<channelDir>/run-sync.sh` (mode 0700) and
  `emitCliDispatcher(home, channel)` — writes `cliPath(home,channel)` (mode 0700), both atomically
  (tmp+rename). Both are **generic** (no version baked): acquire root exec lock (fd mode, `-t 0`),
  then resolve `current`, validate marker==`desired.json` + `current/VERSION` hash, else exit 75/1,
  then `exec` `<current>/venv/bin/python <current>/repo-radar "$@"`. Uses a tiny embedded POSIX
  validator (compares `.runtime.json` `genId`/`versionSha`/`sourceSha` to `desired.json`, and
  `sha256` of `current/VERSION`+launcher via `/usr/bin/shasum -a 256`).

**Script shape (run-sync.sh):**
```sh
#!/bin/sh
set -eu
ROOT="$HOME/.repo-radar"; CH="<channel>"; CUR="$ROOT/$CH/current"; DES="$ROOT/$CH/desired.json"
exec 9>"$ROOT/.exec.lock"
/usr/bin/lockf -t 0 9 || { echo "repo-radar: another sync is running" >&2; exit 75; }
# --- lock held on fd 9; resolve + verify AFTER acquisition ---
[ -L "$CUR" ] || { echo "repo-radar: no active runtime" >&2; exit 1; }
GEN="$(cd "$CUR" && pwd -P)"
[ -f "$DES" ] && [ -f "$GEN/.runtime.json" ] || { echo "repo-radar: runtime not managed" >&2; exit 1; }
# compare desired.genId to marker.genId; verify VERSION hash; (jq-free: use python from the venv)
"$GEN/venv/bin/python" - "$GEN" "$DES" <<'PY' || { echo "repo-radar: runtime failed verification" >&2; exit 1; }
import json,sys,hashlib,os
gen,des=sys.argv[1],sys.argv[2]
m=json.load(open(os.path.join(gen,'.runtime.json'))); d=json.load(open(des))
def sh(p): return hashlib.sha256(open(p,'rb').read()).hexdigest()
ok = (m['genId']==d['genId'] and m['versionSha']==d['versionSha']
      and sh(os.path.join(gen,'VERSION'))==m['versionSha']
      and sh(os.path.join(gen,'repo-radar'))==m['launcherSha'])
sys.exit(0 if ok else 1)
PY
exec "$GEN/venv/bin/python" "$GEN/repo-radar" sync --status-server "$@"   # inherits locked fd 9
```
(The CLI dispatcher is identical minus `sync --status-server`, forwarding `"$@"`.)

- [ ] **Step 1: failing test** — `emitRunSync` writes 0700; `sh -n` clean; script contains the
  fd-9 preamble + lock-before-resolve ordering; a golden test that, given a temp HOME with a valid
  generation+desired, running the script (with a stub `repo-radar` launcher that prints argv) execs
  the venv python against `current`; after flipping `current` to B, a fresh run resolves B.
- [ ] **Step 2/3: implement** (string templating + atomic write). **Step 4/5: run/commit**

```bash
git add menubar/runtime/dispatchers.js menubar/runtime/__tests__/dispatchers.test.js
git commit -m "feat(runtime): generic self-verifying run-sync + CLI dispatchers (lock-first)"
```

---

## Task 11: Legacy quiescence + managed detection (`runtime/quiesce.js`)

**Files:** Create `menubar/runtime/quiesce.js`; Test `menubar/runtime/__tests__/quiesce.test.js`

**Interfaces:**
- Produces: `quiesceLegacyStable({home, exec, sleep}) -> {quiesced:boolean, reason}` (stable only):
  `launchctl bootout gui/$UID/com.user.repo-radar`, poll `launchctl print` until the label is
  absent, scan `ps` for a process running the legacy launcher/interpreter or holding the legacy
  statusfile, wait up to a timeout, else `{quiesced:false}`. `detectStableManaged({home, exec}) ->
  {managed:boolean, reason}` (read-only, for dev): true **only** if stable `desired.json` +
  `current` marker exist, are schema-compatible, and the installed stable `VERSION`/dispatcher are
  managed; ANY legacy stable install/state or ambiguity → `{managed:false}`. `exec`/`sleep`
  injected for tests (mock `launchctl`/`ps`).

- [ ] **Step 1: failing test** (inject a fake `exec`): bootout that never clears the label →
  `quiesced:false`; label clears + no legacy process → `quiesced:true`; `detectStableManaged`
  returns false when a legacy `~/.repo-radar/repo-radar` exists even if no agent is loaded.
- [ ] **Step 2/3: implement.** **Step 4/5: run/commit**

```bash
git add menubar/runtime/quiesce.js menubar/runtime/__tests__/quiesce.test.js
git commit -m "feat(runtime): checked legacy quiescence + read-only managed-stable detection"
```

---

## Task 12: CLI migration + legacy retire (`runtime/migrate.js`)

**Files:** Create `menubar/runtime/migrate.js`; Test `menubar/runtime/__tests__/migrate.test.js`

**Interfaces:** `installDispatcher(home, channel)` (delegates to Task 10 `emitCliDispatcher`, atomic,
0700; stable→`repo-radar`, dev→`repo-radar-dev`); `retireLegacyLauncher(home) -> movedTo|null`
(move `~/.repo-radar/repo-radar` → `~/.repo-radar/legacy-<ts>/repo-radar` **only after** the stable
dispatcher exists and a first activation is present; never for dev). Timestamp injected for tests.

- [ ] **Step 1: failing test** — dispatcher installed before retire; retire is a no-op when no legacy
  launcher; dev never writes `repo-radar`; legacy moved (not deleted) to `legacy-<ts>/`.
- [ ] **Step 2/3/4/5: implement/run/commit**

```bash
git add menubar/runtime/migrate.js menubar/runtime/__tests__/migrate.test.js
git commit -m "feat(runtime): CLI dispatcher install + non-destructive legacy retire"
```

---

## Task 13: Orchestration `ensureRuntime()` + `runSync()` (`runtime/index.js`)

**Files:** Create `menubar/runtime/index.js`; Test `menubar/runtime/__tests__/index.test.js`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `ensureRuntime({home, channel, appVersion, bundle, hooks}) -> {status:'ok'|'failed', genDir?, reason?}`
    implementing the two transitions (§3.3): compute `authoritativeIdentity`; if already healthy
    (`current` + `verifyRuntime` pass against current `desired`) → no-op `ok`; else acquire the
    **channel activation lock**, and:
    - **legacy bootstrap** (no `desired.json`): if stable, `quiesceLegacyStable` (fail closed if
      not quiesced); `emitRunSync` + `emitCliDispatcher` + repoint the LaunchAgent (hook); publish
      `desired.json`; `adopt` or `provision`; `flipCurrent`; `retireLegacyLauncher`.
    - **managed update/rollback** (dispatchers already present): publish new `desired.json` **first**
      (fail closed between here and the flip); `adopt` or `provision`; `flipCurrent`.
    On failure: `hooks.onFailure(redactedReason)`, return `{status:'failed'}`; never flip.
  - `runSync({home, channel}) -> childExitCode` — the Node runner: acquire **root exec lock** `-t 0`
    (LockBusy→busy), then resolve+`verifyRuntime`, then spawn `<current>/venv/bin/python
    <current>/repo-radar sync --status-server` holding the lock for the child's lifetime; used by
    "Sync Now".
- [ ] **Step 1: failing tests** — no-op when healthy; managed update publishes desired **before**
  provisioning (assert desired.json shows B before `current` still points at A during a simulated
  mid-provision crash → runner fails closed); legacy bootstrap fails closed when quiescence fails;
  `runSync` returns 75-mapped busy when the root lock is held.
- [ ] **Step 2/3/4/5: implement/run/commit**

```bash
git add menubar/runtime/index.js menubar/runtime/__tests__/index.test.js
git commit -m "feat(runtime): ensureRuntime two-transition orchestration + runSync runner"
```

---

## Task 14: Wire Electron main process (`menubar/main.js`)

**Files:** Modify `menubar/main.js`. Test: `menubar/__tests__/main-runtime-wiring.test.js` (require-resolution + targeted unit checks) + `node --check`.

- [ ] **Step 1: Remove the fictitious version fallback.** `main.js:25` `return '2.0.0';` → throw/return
  a sentinel that makes `authoritativeIdentity` fail closed (keep `getVersion()` returning the file
  value; the fail-closed check lives in `authoritativeIdentity`). Ensure no code path silently uses
  `2.0.0`.
- [ ] **Step 2: Startup + post-update reconcile.** In the ready handler (near `cleanupOrphans()` /
  `setupAutoUpdater()`, ~`main.js:1990`), and on `autoUpdater` `update-downloaded`→next-launch,
  call:
  ```js
  const runtime = require('./runtime');
  const channel = require('./runtime/paths').resolveChannel(path.join(__dirname,'build-info.json'));
  const bundle = { repoRadarDir: path.join(process.resourcesPath,'resources','repo_radar'),
                   launcher: path.join(process.resourcesPath,'resources','repo-radar'),
                   versionFile: path.join(process.resourcesPath,'VERSION') };
  const res = await runtime.ensureRuntime({ home: os.homedir(), channel, appVersion: APP_VERSION,
                   bundle, hooks: { onFailure: surfaceRuntimeError, repointSchedule: updateLaunchAgent } });
  ```
  Guard `process.resourcesPath` for dev-from-source (fall back to worktree paths); on
  `res.status==='failed'` disable sync + show the error surface (§6).
- [ ] **Step 3: Replace manual spawn.** The sync spawn (`getSyncScriptPath()` + `spawn('/usr/bin/env',
  ['python3', syncScript, …])`, ~`main.js:1023-1031`) → `await runtime.runSync({home,channel})`; map
  `LockBusy` to a "sync already running" notification.
- [ ] **Step 4: Channel-namespaced, stable-only schedule.** `updateLaunchAgent()` (~`main.js:1455-1594`):
  label `com.user.repo-radar` (stable) / `com.user.repo-radar-dev` (dev, transient only); the plist
  runs the generic `<channelDir>/run-sync.sh` (no baked interpreter/env); **dev must not install a
  persistent schedule** — if `channel==='dev'` and stable is not provably managed
  (`detectStableManaged`), hard-block with guidance instead of scheduling.
- [ ] **Step 5: Verify + commit.**
  ```bash
  node --check menubar/main.js
  node -e "require('./menubar/runtime'); require('./menubar/runtime/paths'); console.log('wire ok')"
  git add menubar/main.js menubar/__tests__/main-runtime-wiring.test.js
  git commit -m "feat(menubar): wire ensureRuntime + runSync; channel-namespaced stable-only schedule; drop 2.0.0 fallback"
  ```

---

## Task 15: Retire `setup.sh` as an app dependency + docs

**Files:** Modify `menubar/SETUP.md`, `README.md`; `menubar/resources/setup.sh` (header note only).

- [ ] **Step 1:** Add a header comment to `menubar/resources/setup.sh` marking it **not used by the
  app** (kept only as an optional manual aid); the app self-provisions a versioned venv on launch.
- [ ] **Step 2:** Update `menubar/SETUP.md` + `README.md`: remove the manual `pip install`
  Troubleshooting step as a prerequisite (the app provisions deps itself); document the
  `~/.repo-radar/<channel>/` runtime, the `repo-radar`(stable)/`repo-radar-dev`(dev) CLIs, and the
  "runtime setup failed → Retry" behavior. If the supported interpreter matrix was narrowed
  (Task 6 §3.6), state the required Python range here.
- [ ] **Step 3: commit**
  ```bash
  git add menubar/SETUP.md README.md menubar/resources/setup.sh
  git commit -m "docs: app self-provisions the Python runtime; retire setup.sh as a dependency"
  ```

---

## Task 16: 7a scripted logic harness (consolidation + adversarial cases)

**Files:** Create `menubar/runtime/__tests__/harness.test.js` (drives the module end-to-end in a temp HOME).

Covers the spec §7a cases not already unit-tested:
- [ ] **Lock kill-safety:** start a `runSync` holding the root lock via a child; **kill the outer
  runner**; assert no Python descendant remains active AND another acquisition then succeeds.
- [ ] **Lock-first resolves B:** pause a runner just before acquisition (injected barrier), complete a
  managed `ensureRuntime` update (publish B → provision → flip), release the barrier; assert the
  runner execs generation **B**, not A.
- [ ] **Transition crash cases:** simulate crash before publish, between publish and flip, and
  before dispatcher refresh; assert fail-closed and clean retry (adopt or rebuild).
- [ ] **Downgrade/rollback:** `ensureRuntime` to an older managed version reports+runs that version.
- [ ] **Tamper:** mutate `current/repo_radar`, the venv set, or `current/VERSION` → next reconcile
  builds a replacement generation + flip + retains the old (no pre-flip mutation).
- [ ] **Redaction:** a provisioning failure with a credentialed index URL writes a redacted log.
- [ ] **Run + commit**
  ```bash
  node --test menubar/runtime/__tests__/
  git add menubar/runtime/__tests__/harness.test.js
  git commit -m "test(runtime): 7a scripted logic harness (lock/crash/rollback/tamper/redaction)"
  ```

---

## Task 17: 7b built-artifact packaged upgrade smoke

**Files:** Create `menubar/scripts/upgrade-smoke.sh` (+ `menubar/scripts/upgrade-smoke.md` runbook).

The one **partly-manual** gate (needs a real signed build + launchd + isolated HOME). Script:
- [ ] **Step 1:** Build the **stable** `.app` locally (`npm run build:version`), into `dist/`.
- [ ] **Step 2:** Create an isolated `HOME` (temp user dir); seed 1.0.26 state — the verbatim
  1.0.26 `~/.repo-radar/repo-radar` launcher + a global `litellm==1.83.4` + the old
  `com.user.repo-radar` plist/wrapper; start a **running legacy scheduled child** and a **running
  legacy manual child**.
- [ ] **Step 3:** Launch the built 1.0.27 app against that HOME; assert quiescence proven before
  activation, then §7b items 2–11: bundled import; `sys.executable`+`litellm==1.93.0` in **manual
  and `launchctl` scheduled** sync; new-model behavior; `repo-radar --version`==app version on
  upgrade **and** rollback; crash recovery per boundary; tamper→replacement; cross-channel lock
  serialization + kill-releases; offline hard-block+Retry; matrix hashed install; dev fails closed
  vs unmanaged/unloaded-but-installed stable; dev transient agent removed w/o mutating stable.
- [ ] **Step 4:** Emit PASS/FAIL per item. This script gates the **production release** (spec §9);
  it is not run in CI unattended (signing + launchd). `log()` any item that can't run on the host
  (e.g. uncovered matrix cells from Task 6) as an explicit blocker — never silently skip.
- [ ] **Step 5: commit**
  ```bash
  git add menubar/scripts/upgrade-smoke.sh menubar/scripts/upgrade-smoke.md
  git commit -m "test(release): built-artifact packaged upgrade smoke (Spec 2A DoD gate)"
  ```

---

## Self-Review Notes

- **Spec coverage:** §3.1 ownership/layout → T1,T14; intent record → T8; §3.2 interpreter/gen id →
  T3,T5; §3.3 locks → T4, activation transitions → T13, verification → T9, quiescence → T11; §3.4
  runner parity → T10,T13; §3.5 CLI continuity → T12; §3.6 locks/manifests → T6; §6 failure/perms →
  T7,T13,T9 (0700/0600) + T14 surface; §7a → T16; §7b → T17.
- **Global-constraint checks:** 0700/0600 perms applied at every `mkdir`/`writeFile` in T7/T8/T9/T10;
  `git add` by exact path in every commit; each commit green (module tasks are independent; T14
  depends on T13; run `node --test menubar/runtime/__tests__/` before T14).
- **Known residual (surface, don't hide):** the dependency matrix (T6) can only be generated for
  interpreters/arches present on the build host; uncovered `(pyMinor,arch)` cells fail closed at
  provision and are release blockers listed in `resources/pydeps/README.md`. Decide (cover vs.
  narrow) before the production release.
- **Fd routing (T4):** the exact numeric fd passed to `lockf` in Node's `withLock` must be inherited
  into the `spawnSync` child; keep the impl and the `lockf <fd>` arg in sync, and mirror the shell
  dispatcher's `exec 9>` / `lockf … 9`.

