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

test('beginManualActivity falls back to a valid channel when channel is null (Codex B6) -- durable start survives, and a subsequent guard blocked terminal is accepted', () => {
  // Before the fix: main.js calls beginManualActivity({ channel: runtimeChannel, ... }) BEFORE
  // its own runtime-resolution guard runs, so a build-info failure means runtimeChannel is still
  // `null` at this call. records.js's `start` schema requires `channel` to be a STRING (no
  // null-allowing sentinel), so the raw null failed validation -> no durable `start` -> the later
  // guard's `terminal('blocked', ...)` found no durable start to attach to and was refused too
  // (writer.js's terminal() gate) -- the whole failed attempt vanished. Prove both halves now
  // land: a durable start (with a valid, non-null channel) AND the guard's blocked terminal.
  const home = tmpHome();
  try {
    const { writer } = beginManualActivity(home, { channel: null, trigger: 'manual' });
    assert.strictEqual(writer._active, true, 'a null channel must not sink the mint/admit/start');

    const afterStart = readAll(home, writer.activityId);
    const startRecs = afterStart.filter((r) => r.type === 'start');
    assert.strictEqual(startRecs.length, 1, 'exactly one durable start must exist');
    assert.strictEqual(typeof startRecs[0].channel, 'string', 'channel must be a valid bounded string, never null');
    assert.notStrictEqual(startRecs[0].channel, null);

    onGuardBlock(writer, 'runtime channel unresolved');
    const afterGuard = readAll(home, writer.activityId);
    assert.ok(
      afterGuard.some((r) => r.type === 'terminal' && r.outcome === 'blocked'),
      'a durable blocked terminal must exist alongside the start -- not refused for lack of one',
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('beginManualActivity falls back to a valid channel for every non-string/empty channel shape', () => {
  for (const bad of [undefined, '']) {
    const home = tmpHome();
    try {
      const { writer } = beginManualActivity(home, { channel: bad, trigger: 'manual' });
      assert.strictEqual(writer._active, true, `channel=${JSON.stringify(bad)} must not sink start`);
      const startRecs = readAll(home, writer.activityId).filter((r) => r.type === 'start');
      assert.strictEqual(startRecs.length, 1);
      assert.strictEqual(typeof startRecs[0].channel, 'string');
      writer.terminal('succeeded');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

// === onCancel / onContention / onGuardBlock (brief's sketch, verbatim shape) ===================

// Codex R3: onCancel now routes the append through quota.appendReserveIfLive(home,
// writer.activityId, ...), so proving the ordering requires a REAL ledger entry backing
// `writer.activityId` (a bare fake with no `home`/ledger would be treated as "can't confirm live"
// and skipped -- see the companion settled-activity test below). This is the LIVE-activity case:
// admit() leaves a live ledger entry in place, so the serialized check finds it live and the
// append proceeds, preserving the exact same cancel-before-SIGTERM ordering as before.
test('cancel appends control{cancel_requested} BEFORE SIGTERM (still-live activity: ledger present)', () => {
  const home = tmpHome();
  try {
    const aid = A.mintActivityId();
    A.secureMkdir(A.activityDir(home, aid));
    const l = A.acquire(A.ownerLockPath(home, aid));
    assert.strictEqual(A.quota.admit(home, aid, l), true, 'ledger entry must be live for this case');

    const calls = [];
    const writer = { activityId: aid, control: (n) => calls.push('control:' + n), _handedOff: true };
    const child = { kill: (sig) => calls.push('kill:' + sig) };
    onCancel({ writer, child, home });
    assert.deepStrictEqual(calls, ['control:cancel_requested', 'kill:SIGTERM']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Codex R3 (BLOCKER) regression at the trigger-glue wiring level: an activity whose ledger has
// already been reaped (settled) -- simulating the Python child having durably terminalized and
// settle()'d BEFORE Electron's post-handoff stop handler runs -- must have its cancel append
// skipped entirely (no reservation left to cover it), while the SIGTERM still proceeds
// unconditionally (killing an already-exited child is a harmless no-op).
test('cancel is a NO-OP on a settled (reaped) activity -- SIGTERM still proceeds (Codex R3)', () => {
  const home = tmpHome();
  try {
    const aid = A.mintActivityId();
    A.secureMkdir(A.activityDir(home, aid));
    const l = A.acquire(A.ownerLockPath(home, aid));
    assert.strictEqual(A.quota.admit(home, aid, l), true);
    // Simulate the Python child's own terminal+settle reap having already completed: the ledger
    // entry is gone. (Node itself never unlinks -- Ruling B -- this stands in for the delegated
    // Python-side reap actually landing.)
    fs.unlinkSync(A.ledgerEntryPath(home, aid));
    assert.strictEqual(fs.existsSync(A.ledgerEntryPath(home, aid)), false);

    const calls = [];
    const writer = { activityId: aid, control: (n) => calls.push('control:' + n), _handedOff: true };
    const child = { kill: (sig) => calls.push('kill:' + sig) };
    onCancel({ writer, child, home });
    assert.deepStrictEqual(
      calls,
      ['kill:SIGTERM'],
      'a settled activity must get no cancel append, but SIGTERM must still proceed',
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// === Codex R4 (BLOCKER, "Fix-G"): onCancel must never block on quota.lock contention ===========
//
// Codex reproduced the R3 fix's regression concretely: holding quota.lock 1.5s in ANOTHER process
// delayed onCancel's SIGTERM by 1.511s. The prior "cannot acquire quota.lock" coverage
// (quota-cancel-settle-race.test.js's broken-home/ENOTDIR case) only proves the never-throws
// contract on a setup FAILURE, not genuine cross-process LOCK CONTENTION -- Codex called that
// insufficient. These tests reproduce the real contention scenario and the two failure-injection
// scenarios Fix-G also closes (a hard append failure, and a lock-release/close failure), all
// asserting the one hard invariant: Activity observability must NEVER change sync/cancel behavior.

// Genuinely holds quota.lock (home-wide, shared by every activity under `home` -- see
// `_quotaLockPath`) in a SEPARATE OS process via quota.js's own `_quotaLock`/`_unlock` (the exact
// blocking lockf mechanism `admit`/`grant`/`settle` use), for `holdMs` milliseconds, mirroring
// Codex's own repro mechanism exactly. Signals genuine acquisition by writing `markerPath` -- a
// synchronous write that can only happen AFTER `_quotaLock` has actually returned the held fd --
// so the caller can poll for it instead of guessing a fixed delay. Returns the spawned
// ChildProcess so the caller can guarantee it is killed/reaped (no lingering process).
function spawnQuotaLockHolder(home, markerPath, holdMs) {
  const quotaModulePath = path.join(__dirname, '..', 'activity', 'quota');
  const script = [
    `const quota = require(${JSON.stringify(quotaModulePath)});`,
    `const fs = require('fs');`,
    `const fd = quota._quotaLock(${JSON.stringify(home)});`, // blocks until acquired -- uncontended here, returns promptly
    `fs.writeFileSync(${JSON.stringify(markerPath)}, 'locked');`, // signal: the lock is genuinely held now
    `setTimeout(() => { try { quota._unlock(fd); } catch (e) { /* best-effort */ } process.exit(0); }, ${holdMs});`,
  ].join('\n');
  return spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
}

// Bounded poll for `markerPath` to appear -- proof the lock-holder child genuinely holds
// quota.lock before the test proceeds to measure onCancel's promptness against it.
async function waitForMarker(markerPath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(markerPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`lock-holder marker never appeared: ${markerPath}`);
}

test('[real child] onCancel sends SIGTERM PROMPTLY even while quota.lock is genuinely held by another process (Codex R4 repro)', async () => {
  const home = tmpHome();
  const markerPath = path.join(home, '.lock-holder-ready');
  let lockHolder = null;
  try {
    const aid = A.mintActivityId();
    A.secureMkdir(A.activityDir(home, aid));
    const l = A.acquire(A.ownerLockPath(home, aid));
    assert.strictEqual(A.quota.admit(home, aid, l), true, 'ledger entry must be live for a realistic repro');

    lockHolder = spawnQuotaLockHolder(home, markerPath, 1500); // mirrors Codex's exact 1.5s repro
    await waitForMarker(markerPath);

    const calls = [];
    const writer = { activityId: aid, control: (n) => calls.push('control:' + n) };
    const child = { kill: (sig) => calls.push('kill:' + sig) };

    const t0 = Date.now();
    onCancel({ writer, child, home });
    const elapsedMs = Date.now() - t0;

    assert.ok(calls.includes('kill:SIGTERM'), 'SIGTERM must fire even under quota.lock contention');
    assert.ok(
      elapsedMs < 200,
      `onCancel must not block on a contended quota.lock: took ${elapsedMs}ms (Codex's pre-fix repro measured ~1511ms)`,
    );
  } finally {
    if (lockHolder) {
      lockHolder.kill('SIGKILL'); // test cleanup only -- not part of the behavior under test
      await new Promise((resolve) => { if (lockHolder.exitCode !== null) resolve(); else lockHolder.once('exit', resolve); });
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Fix 3 (Codex R4): `appendReserveIfLive`'s own "never throws" contract must hold even when
// RELEASING the lock (the `finally`'s `_unlock(fd)` -> `fs.closeSync`) fails -- not just when
// ACQUIRING it fails. `secureMkdir`/`openOwnedRegular`'s own owned-dir validation walk makes
// several `fs.closeSync` calls of its own on unrelated (directory) fds before the ledger-lock
// fd's own release ever happens, so a fixed call-index guess would be fragile/wrong. Instead the
// stub is ARMED from inside the synthetic `appendFn` itself (the very first thing the REAL
// `appendFn` does once the lock is confirmed live) -- it throws on the NEXT `fs.closeSync` call
// after that, which is guaranteed to be quota.lock's own release (the synthetic `appendFn` does
// no I/O of its own, so nothing else can call `closeSync` in between). The append itself (and its
// return value) must be unaffected by a release failure that happens strictly AFTER the append
// already succeeded.
test('appendReserveIfLive: a release/close failure after a successful append never throws, and the append still counts (Codex R4)', () => {
  const home = tmpHome();
  try {
    const aid = A.mintActivityId();
    A.secureMkdir(A.activityDir(home, aid));
    const l = A.acquire(A.ownerLockPath(home, aid));
    assert.strictEqual(A.quota.admit(home, aid, l), true);

    const realCloseSync = fs.closeSync;
    let armed = false;
    fs.closeSync = (...args) => {
      if (armed) {
        armed = false; // throw exactly once -- the very next close after the append ran
        throw new Error('simulated quota.lock release/close failure');
      }
      return realCloseSync(...args);
    };

    let appended = false;
    let result;
    try {
      assert.doesNotThrow(() => {
        result = A.quota.appendReserveIfLive(home, aid, () => { appended = true; armed = true; }, { nonblocking: true });
      });
    } finally {
      fs.closeSync = realCloseSync;
    }

    assert.strictEqual(appended, true, 'the append itself must have run before the release failure');
    assert.strictEqual(result, true, 'a post-append release failure must not flip the reported result to false');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Fix 2 (Codex R4): `onCancel`'s SIGTERM must be GUARANTEED regardless of ANY Activity-side
// failure, not merely the specific close-failure shape above -- this is the outer-`finally`
// backstop, proven independently of `appendReserveIfLive`'s own internals by making the whole
// call throw outright (a stand-in for "best-effort cancel append misbehaves in some way its own
// contract didn't anticipate"). `A.quota` and trigger-glue.js's internal `quota` reference the
// SAME module-cache singleton object, so reassigning this property here is visible to onCancel's
// `quota.appendReserveIfLive(...)` call.
test('onCancel ALWAYS sends SIGTERM even if the best-effort cancel append throws outright (Codex R4 outer finally)', () => {
  const home = tmpHome();
  const originalAppendReserveIfLive = A.quota.appendReserveIfLive;
  try {
    A.quota.appendReserveIfLive = () => { throw new Error('simulated total append failure'); };

    const calls = [];
    const writer = { activityId: 'irrelevant-for-this-test', control: () => { throw new Error('must never be reached'); } };
    const child = { kill: (sig) => calls.push(sig) };

    assert.doesNotThrow(() => onCancel({ writer, child, home }));
    assert.deepStrictEqual(calls, ['SIGTERM'], 'SIGTERM must fire even when the append call itself throws');
  } finally {
    A.quota.appendReserveIfLive = originalAppendReserveIfLive;
    fs.rmSync(home, { recursive: true, force: true });
  }
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

// === _hasAckSignal: Ruling 41 trailing-line contract ============================================
// Codex G3-Node2: `_hasAckSignal` previously carried its own private byte-splitter, which would
// accept a newline-less-but-valid-JSON tail as an ack -- a torn `ownership`/`terminal` write could
// therefore wrongly tell Electron a dead handoff child HAD acknowledged. It now routes through
// `parse.parseSegment` (menubar/activity/parse.js), the one shared implementation of the
// trailing-line rule: a segment's final remainder that lacks a terminating `\n` is ignored
// unconditionally, even when it is otherwise valid JSON (the durability contract is record+`\n`;
// a missing newline is a torn write, not a finding).

test('Ruling 41: _hasAckSignal ignores an ownership{role:handoff} record with no trailing newline (torn write), then sees it once the newline lands', () => {
  const home = tmpHome();
  try {
    const aid = A.mintActivityId();
    A.secureMkdir(A.activityDir(home, aid));
    const rec = {
      schema_version: 1, activity_id: aid, type: 'ownership', seq: 1,
      ts: '2026-08-14T00:00:00-07:00', role: 'handoff', owner_token: A.mintToken(),
      producer: 'dispatcher', pid: 4242, boot_id: 'boot-abc', proc_birth: '2026-08-14T00:00:00-07:00',
    };
    const seg = A.segmentPath(home, aid, 'dispatcher', 'deadbeef');
    const fd = A.secureOpenAppend(seg);
    fs.writeSync(fd, Buffer.from(JSON.stringify(rec))); // NO trailing \n -- a torn write
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    assert.strictEqual(
      triggerGlue._hasAckSignal(home, aid), false,
      'a newline-less-but-valid-JSON ownership{handoff} tail must not count as an ack',
    );

    // The exact same record bytes, now durably terminated with the missing `\n`.
    const fd2 = A.secureOpenAppend(seg);
    fs.writeSync(fd2, Buffer.from('\n'));
    fs.fsyncSync(fd2);
    fs.closeSync(fd2);
    assert.strictEqual(
      triggerGlue._hasAckSignal(home, aid), true,
      'once `\\n`-terminated, the same ownership{handoff} record counts as an ack',
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Ruling 41: _hasAckSignal ignores a terminal record with no trailing newline (torn write), then sees it once the newline lands', () => {
  const home = tmpHome();
  try {
    const aid = A.mintActivityId();
    A.secureMkdir(A.activityDir(home, aid));
    const rec = {
      schema_version: 1, activity_id: aid, type: 'terminal', seq: 1,
      ts: '2026-08-14T00:00:00-07:00', outcome: 'succeeded', summary: {}, by: A.mintToken(),
    };
    const seg = A.segmentPath(home, aid, 'python', 'cafebabe');
    const fd = A.secureOpenAppend(seg);
    fs.writeSync(fd, Buffer.from(JSON.stringify(rec))); // NO trailing \n -- a torn write
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    assert.strictEqual(
      triggerGlue._hasAckSignal(home, aid), false,
      'a newline-less-but-valid-JSON terminal tail must not count as an ack',
    );

    const fd2 = A.secureOpenAppend(seg);
    fs.writeSync(fd2, Buffer.from('\n'));
    fs.fsyncSync(fd2);
    fs.closeSync(fd2);
    assert.strictEqual(
      triggerGlue._hasAckSignal(home, aid), true,
      'once `\\n`-terminated, the same terminal record counts as an ack',
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
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
