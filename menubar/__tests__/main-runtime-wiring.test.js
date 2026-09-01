// Require-resolution + static wiring checks for the spec 2A integration of
// menubar/runtime/ into main.js. main.js itself can't be require()'d outside
// a running Electron process (it destructures `{ app, Tray, ... }` off
// `require('electron')`, which is just a path string in plain Node, and calls
// `app.requestSingleInstanceLock(...)` at module load), so this test checks
// what it CAN check without Electron: that main.js parses, that the runtime
// module surface it depends on still has the expected shape, and that the
// key wiring landmarks are actually present in the source (so a future edit
// can't silently regress the integration back to the fictitious '2.0.0'
// fallback, the old manual spawn, or a non-channel-namespaced LaunchAgent).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const mainJsPath = path.join(__dirname, '..', 'main.js');
const src = fs.readFileSync(mainJsPath, 'utf8');

// 1. main.js still parses as valid JS.
execFileSync(process.execPath, ['--check', mainJsPath], { stdio: 'pipe' });

// 2. The runtime module's public surface main.js relies on has the expected
// shape. If Task 13's interfaces ever change shape, this fails loudly instead
// of main.js breaking silently at runtime inside a packaged app.
const runtime = require('../runtime');
assert.strictEqual(typeof runtime.ensureRuntime, 'function', 'runtime.ensureRuntime must be a function');
assert.strictEqual(typeof runtime.runSync, 'function', 'runtime.runSync must be a function');

const { resolveChannel, layout, ChannelError } = require('../runtime/paths');
assert.strictEqual(typeof resolveChannel, 'function', 'runtime/paths.resolveChannel must be a function');
assert.strictEqual(typeof layout, 'function', 'runtime/paths.layout must be a function');
assert.ok(ChannelError, 'runtime/paths.ChannelError must be exported');

const { detectStableManaged } = require('../runtime/quiesce');
assert.strictEqual(typeof detectStableManaged, 'function', 'runtime/quiesce.detectStableManaged must be a function');

// layout(home, channel) must expose a `runSync` path — updateLaunchAgent()
// points the LaunchAgent's ProgramArguments directly at this.
const L = layout('/tmp/wiring-test-home', 'stable');
assert.ok(typeof L.runSync === 'string' && L.runSync.endsWith('run-sync.sh'), 'layout().runSync must be a run-sync.sh path');

// 3. Static landmarks in main.js: confirm the actual wiring is present, not
// just that it's theoretically possible. These are deliberately simple
// substring/regex checks — main.js has no exports to call into directly.
assert.ok(!/return '2\.0\.0';/.test(src), 'getVersion() must not return the fictitious 2.0.0 fallback');
assert.ok(/require\(['"]\.\/runtime['"]\)/.test(src), 'main.js must require(\'./runtime\')');
assert.ok(/require\(['"]\.\/runtime\/paths['"]\)/.test(src), 'main.js must require(\'./runtime/paths\')');
assert.ok(/resolveChannel\(/.test(src), 'main.js must call resolveChannel(...)');
assert.ok(/runtime\.ensureRuntime\(/.test(src), 'main.js must call runtime.ensureRuntime(...)');
assert.ok(/runtime\.runSync\(/.test(src), 'main.js must call runtime.runSync(...) (manual spawn should be replaced)');
assert.ok(!/spawn\('\/usr\/bin\/env', \['python3'/.test(src), 'the old direct python3 spawn for sync must be gone');
assert.ok(!/function getSyncScriptPath/.test(src), 'getSyncScriptPath() should be removed once both call sites are gone');
assert.ok(/e\.code === 75/.test(src), 'main.js must map LockBusy (code 75) to a busy notification');
assert.ok(/AGENT_LABEL/.test(src), 'LaunchAgent label must be channel-namespaced via AGENT_LABEL');
assert.ok(/com\.user\.repo-radar-dev/.test(src), 'dev channel must use a distinct LaunchAgent label');
assert.ok(/detectStableManaged\(/.test(src), 'updateLaunchAgent must consult detectStableManaged for the dev hard-block');
assert.ok(/app\.whenReady\(\)\.then\(async/.test(src), 'the ready handler must be async to await ensureRuntime()');

// 4. Codex B3(a): main.js must supply quota.js's delegated Python prune spawn with the SAME
// managed venv interpreter + repo_radar location the runtime block resolves, not leave it on the
// dev-only python3/REPO_ROOT default (which doesn't exist in a packaged app).
assert.ok(/require\(['"]\.\/activity\/quota['"]\)/.test(src), 'main.js must require(\'./activity/quota\')');
assert.ok(/activityQuota\.configurePythonRunner\(/.test(src), 'main.js must call activityQuota.configurePythonRunner(...) to supply the packaged Python resolution (Codex B3a)');
assert.ok(/venv['"],\s*['"]bin['"],\s*['"]python['"]\)/.test(src), 'the configured runner must resolve <current>/venv/bin/python, the same shape runtime/provision.js builds and runtime/activation.js/runtime/index.js verify');
assert.ok(/layout\(os\.homedir\(\),\s*runtimeChannel\)/.test(src), 'the packaged python resolution must be anchored on layout(home, channel).current, the same symlink the runtime reconcile verifies/flips');

console.log('main-runtime-wiring OK');
