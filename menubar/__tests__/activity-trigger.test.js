'use strict';
// Task 2.3: Electron `triggerSync` lifecycle glue (menubar/activity/trigger-glue.js), the
// Electron-free layer wired into main.js's triggerSync()/stop-sync. Covers: cancel-ordering
// (control{cancel_requested} durably BEFORE SIGTERM), contention/guard-block finalize via
// terminal() alone (no separate release call -- terminal() itself settles+releases), and the
// handOff() post-spawn state machine keyed on the exit SIGNAL, not merely on exit (findings 3 & 4
// from the brief): ack -> drop only; exit 66 (HANDOFF_REJECTED_EXIT) -> Electron finalizes
// `failed`; any OTHER exit -> drop + let durable evidence on disk decide (never `failed`);
// timeout-while-alive -> drop only, child never killed.
//
// Two tiers: (1) seam-based (`_awaitAck`/`_reconcile` injected) -- fast, deterministic, the
// REQUIRED core per the brief's own escape hatch; (2) real-child companions using actual spawned
// processes and a real ActivityWriter/tmp HOME, proving the production defaults (disk-polling
// ack detection, real child.exitCode inspection, real reconcile.synthesizeTerminal) end-to-end.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const triggerGlue = require('../activity/trigger-glue');
const {
  secretValues, beginManualActivity, onContention, onGuardBlock, onCancel, handOff,
  HANDOFF_REJECTED_EXIT,
} = triggerGlue;
const A = require('../activity');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-trigger-'));
}

// Mirrors writer.test.js's `_read_all` helper: raw JSON.parse over every *.jsonl segment for an
// activity, sorted by filename.
function readAll(home, aid) {
  const dir = A.activityDir(home, aid);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
  } catch (e) {
    return [];
  }
  const out = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      out.push(JSON.parse(line));
    }
  }
  return out;
}

// --- fakes matching the brief's test sketch ---------------------------------------------------

function mkWriter(calls) {
  return {
    activityId: 'fake-not-used-when-_awaitAck-is-overridden',
    dropLocalReference() { calls.push('drop'); },
    terminal(outcome) { calls.push('terminal:' + outcome); },
  };
}

// "a fake child whose exit-wait resolves with exitCode (null = stays alive)" -- exitCode is set
// SYNCHRONOUSLY up front (a static double, not a simulated live transition), matching how
// handOff's production _childExitInfo() reads a real ChildProcess's `.exitCode` after Node has
// already set it (Node sets `.exitCode` before emitting 'exit').
function mkChild(exitCode) {
  return {
    exitCode,
    killed: false,
    signalCode: null,
    kill(sig) { this.killed = true; this.signalCode = sig; },
  };
}

// === secretValues ===============================================================================

test('secretValues extracts configured GitHub/Anthropic/Gemini/OpenAI secrets, skipping absent ones', () => {
  assert.deepStrictEqual(
    secretValues({ github_token: 'ghp_abc', anthropic_api_key: 'sk-ant-xyz' }).sort(),
    ['ghp_abc', 'sk-ant-xyz'].sort(),
  );
  assert.deepStrictEqual(secretValues({}), []);
  assert.deepStrictEqual(secretValues(null), []);
  assert.deepStrictEqual(secretValues(undefined), []);
  // non-string / falsy values never leak into the Redactor's secret list
  assert.deepStrictEqual(secretValues({ github_token: '', gemini_api_key: null, openai_api_key: 42 }), []);
});

// === beginManualActivity ========================================================================

test('beginManualActivity mints+acquires+admits+starts and holds the lease fd -- identity established before any gate', () => {
  const home = tmpHome();
  const configDir = path.join(home, '.config', 'repo-radar');
  fs.mkdirSync(configDir, { recursive: true });
  const secret = 'ghp_verysecretvalue1234567890zz'; // non-built-in-pattern-shaped, but configured
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ github_token: secret }));

  const { writer, lockFd } = beginManualActivity(home, { channel: 'stable', trigger: 'manual' });
  assert.strictEqual(writer._active, true, 'writer must be active after a successful mint+admit+start');
  assert.strictEqual(typeof lockFd, 'number');
  assert.strictEqual(lockFd, writer._lease.fd, 'the returned lockFd must be the SAME fd the writer holds');

  const recs = readAll(home, writer.activityId);
  assert.ok(recs.some((r) => r.type === 'start' && r.kind === 'sync' && r.channel === 'stable' && r.trigger === 'manual'));
  assert.ok(recs.some((r) => r.type === 'ownership' && r.role === 'initial'));

  // masking proof: a configured secret (not shaped like any built-in credential pattern) is
  // redacted on the Electron write path via configuredSecrets -> Redactor.
  writer.event('probe', 'info', { detail: `token=${secret} leaked` });
  const ev = readAll(home, writer.activityId).find((r) => r.type === 'event' && r.event === 'probe');
  assert.ok(ev, 'event record must be present');
  assert.ok(!ev.detail.includes(secret), 'configured secret must be redacted from event detail');
  assert.ok(ev.detail.includes('[REDACTED]'));

  writer.terminal('succeeded');
});

test('beginManualActivity never throws when config.json is absent or malformed', () => {
  const home = tmpHome(); // no .config/repo-radar/config.json at all
  let result;
  assert.doesNotThrow(() => { result = beginManualActivity(home, { channel: 'stable', trigger: 'manual' }); });
  assert.strictEqual(result.writer._active, true);
  result.writer.terminal('succeeded');

  const home2 = tmpHome();
  const configDir = path.join(home2, '.config', 'repo-radar');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), '{not valid json');
  let result2;
  assert.doesNotThrow(() => { result2 = beginManualActivity(home2, { channel: 'stable', trigger: 'manual' }); });
  assert.strictEqual(result2.writer._active, true, 'a malformed config must never block sync start');
  result2.writer.terminal('succeeded');
});

// === onCancel / onContention / onGuardBlock (brief's sketch, verbatim shape) ===================

test('cancel appends control{cancel_requested} BEFORE SIGTERM', () => {
  const calls = [];
  const writer = { control: (n) => calls.push('control:' + n), _handedOff: true };
  const child = { kill: (sig) => calls.push('kill:' + sig) };
  onCancel({ writer, child });
  assert.deepStrictEqual(calls, ['control:cancel_requested', 'kill:SIGTERM']);
});

test('contention finalizes the attempt as skipped (terminal owns release)', () => {
  const calls = [];
  const writer = { terminal: (o) => calls.push('terminal:' + o) }; // terminal() itself releases
  onContention(writer, 'already-syncing');
  assert.deepStrictEqual(calls, ['terminal:skipped']); // one terminal, no extra release
});

test('guard-block finalizes the attempt as blocked (terminal owns release)', () => {
  const calls = [];
  const writer = { terminal: (o) => calls.push('terminal:' + o) };
  onGuardBlock(writer, 'dev sync blocked: stable is not provably managed');
  assert.deepStrictEqual(calls, ['terminal:blocked']);
});

test('onContention/onGuardBlock/onCancel are safe no-ops without a writer (never-raises boundary)', () => {
  assert.doesNotThrow(() => onContention(null, 'already-syncing'));
  assert.doesNotThrow(() => onGuardBlock(null, 'reason'));
  assert.doesNotThrow(() => onCancel({ writer: null, child: null }));
  assert.doesNotThrow(() => onCancel({}));
});

// === handOff: seam-based state machine (brief's sketch) =========================================

test('handOff outcome keyed on the exit SIGNAL, not merely exit (findings 3 & 4)', async () => {
  // (a) ack -> dropLocalReference only, no terminal, no signal
  const a = [];
  await handOff({ writer: mkWriter(a), child: mkChild(null), home: '/x', _awaitAck: async () => true });
  assert.deepStrictEqual(a, ['drop']);

  // (b1) exit code 66 (explicit rejection) -> Electron finalizes failed
  const b1 = []; const rec1 = [];
  await handOff({
    writer: mkWriter(b1), child: mkChild(66), home: '/x',
    _awaitAck: async () => false, _reconcile: () => rec1.push('r'),
  });
  assert.ok(b1.includes('terminal:failed') && rec1.length === 0);

  // (b2) OTHER exit (crash / fast-success-no-ack) -> drop + reconcile, NEVER terminal:failed
  const b2 = []; const rec2 = [];
  await handOff({
    writer: mkWriter(b2), child: mkChild(0), home: '/x',
    _awaitAck: async () => false, _reconcile: () => rec2.push('r'),
  });
  assert.ok(b2.includes('drop') && rec2.includes('r') && !b2.some((e) => e.startsWith('terminal')));

  // (c) timeout, child still ALIVE -> dropLocalReference only, never terminal, never signal
  const c = []; const busy = mkChild(null);
  await handOff({ writer: mkWriter(c), child: busy, home: '/x', _awaitAck: async () => false });
  assert.deepStrictEqual(c, ['drop']);
  assert.strictEqual(busy.killed, false);
});

test('handOff exit-signal check uses HANDOFF_REJECTED_EXIT, not a hardcoded literal in the test', () => {
  assert.strictEqual(HANDOFF_REJECTED_EXIT, 66);
});

test('handOff is a safe no-op without a writer', async () => {
  await assert.doesNotReject(() => handOff({ writer: null, child: mkChild(0), home: '/x' }));
});

test('handOff never throws even when _awaitAck itself throws (never-raises boundary)', async () => {
  const calls = [];
  await handOff({
    writer: mkWriter(calls), child: mkChild(0), home: '/x',
    _awaitAck: async () => { throw new Error('disk exploded'); },
    _reconcile: () => calls.push('r'),
  });
  assert.ok(calls.includes('drop') && calls.includes('r'));
});

// === handOff: real-child companions =============================================================
// Real spawned processes + a real ActivityWriter/tmp HOME, exercising the PRODUCTION defaults
// (no _awaitAck/_reconcile overrides): real disk-polling ack detection, real child.exitCode
// inspection, real reconcile.synthesizeTerminal. Uses the _ackTimeoutMs/_ackPollMs seams (mirrors
// quota.js's PYTHON_BIN getter/setter pattern) to keep the timeout-while-alive case fast.

function mkRealWriter(home) {
  return new A.writer.ActivityWriter(home, { kind: 'sync', channel: 'stable', trigger: 'manual', producer: 'electron' });
}

test('[real child] exit code 66 -> Electron finalizes failed, never reconciles (finding 4)', async () => {
  const home = tmpHome();
  const w = mkRealWriter(home);
  w.start();
  assert.strictEqual(w._active, true);

  const child = spawn('/bin/sh', ['-c', 'exit 66']);
  await handOff({ writer: w, child, home });

  const recs = readAll(home, w.activityId);
  const term = recs.find((r) => r.type === 'terminal');
  assert.ok(term, 'a terminal record must be present');
  assert.strictEqual(term.outcome, 'failed');
  assert.strictEqual(w._active, false);
});

test('[real child] exit 0 with no ack -> drop + reconcile settles from durable evidence as interrupted, never failed', async () => {
  const home = tmpHome();
  const w = mkRealWriter(home);
  w.start();

  const child = spawn('/bin/sh', ['-c', 'exit 0']);
  await handOff({ writer: w, child, home });

  const recs = readAll(home, w.activityId);
  const term = recs.find((r) => r.type === 'terminal');
  assert.ok(term, `a terminal record must be present, got: ${JSON.stringify(recs)}`);
  assert.strictEqual(term.outcome, 'interrupted');
  assert.strictEqual(term.by, 'reconciler');
});

test('[real child] crash (non-zero, non-66 exit) -> drop + reconcile synthesizes interrupted, never failed', async () => {
  const home = tmpHome();
  const w = mkRealWriter(home);
  w.start();

  const child = spawn('/bin/sh', ['-c', 'exit 7']);
  await handOff({ writer: w, child, home });

  const recs = readAll(home, w.activityId);
  const term = recs.find((r) => r.type === 'terminal');
  assert.ok(term);
  assert.strictEqual(term.outcome, 'interrupted');
});

test('[real child] timeout while child stays alive -> drop only, child never killed, sync stays running for the reconciler', async () => {
  const home = tmpHome();
  const w = mkRealWriter(home);
  w.start();

  const child = spawn('/bin/sh', ['-c', 'sleep 5']);
  const prevTimeout = triggerGlue._ackTimeoutMs;
  const prevPoll = triggerGlue._ackPollMs;
  triggerGlue._ackTimeoutMs = 150;
  triggerGlue._ackPollMs = 20;
  try {
    await handOff({ writer: w, child, home });
  } finally {
    triggerGlue._ackTimeoutMs = prevTimeout;
    triggerGlue._ackPollMs = prevPoll;
  }

  assert.strictEqual(w._active, false); // dropped
  const recs = readAll(home, w.activityId);
  assert.ok(!recs.some((r) => r.type === 'terminal'), 'must never finalize while the child is still alive');
  assert.strictEqual(child.killed, false, 'the live worker must never be killed');

  child.kill('SIGKILL'); // test cleanup only -- NOT part of the behavior under test
  await new Promise((resolve) => { child.once('exit', resolve); });
});

test('[real child] ack via a real adopting process -> drop only, no terminal, no signal, lease stays with the child', async () => {
  const home = tmpHome();
  const w = mkRealWriter(home);
  w.start();
  const lockPath = A.ownerLockPath(home, w.activityId);
  assert.strictEqual(A.probeBusy(lockPath), true);

  const activityDir = path.join(__dirname, '..', 'activity');
  const ackScript = [
    `const { writer } = require(${JSON.stringify(activityDir)});`,
    'const w2 = new writer.ActivityWriter(process.env.HOME, {',
    "  kind: 'sync', channel: 'stable', trigger: 'manual', producer: 'dispatcher',",
    '  inheritedId: process.env.REPO_RADAR_ACTIVITY_ID,',
    '  inheritedFd: 3,',
    '  ownerToken: process.env.REPO_RADAR_ACTIVITY_OWNER_TOKEN,',
    '});',
    'w2.start();',
    'process.exit(0);',
  ].join('\n');

  const child = spawn(process.execPath, ['-e', ackScript], {
    env: {
      ...process.env,
      HOME: home,
      REPO_RADAR_ACTIVITY_ID: w.activityId,
      REPO_RADAR_ACTIVITY_OWNER_TOKEN: w._lease.ownerToken,
    },
    stdio: ['ignore', 'ignore', 'ignore', w._lease.fd],
  });

  await handOff({ writer: w, child, home });

  const recs = readAll(home, w.activityId);
  assert.ok(recs.some((r) => r.type === 'ownership' && r.role === 'handoff'), 'the adopting child must have written the handoff ownership record');
  assert.ok(!recs.some((r) => r.type === 'terminal'), 'Electron must never finalize on a successful ack');
  assert.strictEqual(w._active, false, 'Electron drops its own reference on ack');
  assert.strictEqual(w._handedOff, true);

  // the child already exited (it wrote its ack then process.exit(0)'d), so its fd 3 is closed
  // too -- the lease should now be fully free (both references closed).
  await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
  assert.strictEqual(A.probeBusy(lockPath), false, 'lease must be free once both Electron and the child have released their references');
});
