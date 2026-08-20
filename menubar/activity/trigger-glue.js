'use strict';
// Task 2.3: the Electron `triggerSync()`/`stop-sync` lifecycle glue -- deliberately Electron-free
// (no `require('electron')`) so it is unit-testable in plain Node. Wires the Node write-side
// mirror (menubar/activity: ids/paths/records/lease/quota/reconcile/writer/redact, Tasks
// 2.1/2.2a/2.2b/2.2c) into main.js's manual-sync entry point: establish activity identity + lease
// + `start` BEFORE any gate (identity-before-first-gate), finalize contention/guard-block/cancel
// correctly, and hand off to the spawned worker without ever risking a healthy sync.
const fs = require('fs');
const path = require('path');

const {
  writer: writerMod,
  reconcile,
  activityDir,
  readOwnedSegments,
  parseValid,
  HANDOFF_REJECTED_EXIT,
} = require('./index');
const { ActivityWriter } = writerMod;

// Bounded wait for the spawned worker's ack (Task 2.3 spec: "waits (bounded, <=5s)"). Exported as
// mutable get/set seams (mirrors quota.js's PYTHON_BIN pattern) so a real-child test can shrink
// them instead of eating the full 5s on the timeout-while-alive scenario.
let ACK_TIMEOUT_MS = 5000;
let ACK_POLL_MS = 50;

// --- secrets -------------------------------------------------------------------------------

// The app's configured GitHub token + AI provider keys, as the flat list of raw secret STRING
// VALUES `ActivityWriter`'s `configuredSecrets` (-> redact.Redactor) expects. Falsy/non-string
// values are dropped; the Redactor itself de-duplicates and length-sorts.
function secretValues(config) {
  if (!config || typeof config !== 'object') return [];
  return [config.github_token, config.anthropic_api_key, config.gemini_api_key, config.openai_api_key]
    .filter((v) => typeof v === 'string' && v.length > 0);
}

// Best-effort config read for redaction purposes only: a missing/malformed config.json must
// never block sync start -- the writer just redacts with fewer configured secrets (the built-in
// credential-shape patterns in redact.js still apply regardless).
function _loadConfiguredSecrets(home) {
  try {
    const configFile = path.join(home, '.config', 'repo-radar', 'config.json');
    if (!fs.existsSync(configFile)) return [];
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    return secretValues(config);
  } catch (e) {
    return [];
  }
}

// --- identity + lease + start, before any gate ------------------------------------------------

// Called FIRST in triggerSync(), before the already-syncing guard or any other check
// (identity-before-first-gate): mints the activity, acquires the lease, admits against the quota,
// and writes a durable `start` + initial `ownership` record. Holds the lease fd open (returned as
// `lockFd`) so the caller can pass it through to the spawned child for fd-inheritance (Task 2.4
// maps it to child fd 4). `writer` is the never-raises ActivityWriter facade: a refused/failed
// mint (lease busy, admission refused, durability failure) simply yields an INACTIVE writer whose
// methods are all safe no-ops -- callers never need to branch on success here.
function beginManualActivity(home, { channel, trigger } = {}) {
  const configuredSecrets = _loadConfiguredSecrets(home);
  // Codex B6: a null/unresolved `channel` (main.js passes its own `runtimeChannel`, which is
  // `null` until build-info resolves) must not silently sink the whole attempt. records.js's
  // `start` schema requires `channel` to be a STRING -- there is no null-allowing sentinel or
  // fixed enum -- so passing the raw `null` through fails validation and no `start` is ever
  // written; the later guard `blocked` terminal then has no durable start to attach to and is
  // refused too (writer.js's terminal() gate), and the entire failed attempt vanishes -- exactly
  // the pre-attempt failure this feature exists to capture. Fall back to a bounded, schema-valid
  // placeholder so the start/terminal pair is always durable even when the real channel could
  // not be resolved.
  const resolvedChannel = (typeof channel === 'string' && channel) ? channel : 'unknown';
  const writer = new ActivityWriter(home, {
    kind: 'sync', channel: resolvedChannel, trigger, producer: 'electron', configuredSecrets,
  });
  writer.start(); // idempotent, never-raises
  const lockFd = (writer._lease && typeof writer._lease.fd === 'number') ? writer._lease.fd : null;
  return { writer, lockFd };
}

// --- contention / guard-block --------------------------------------------------------------

// Already-syncing (manual re-click while a sync is in flight) and the runSync root-busy reject
// (exit 75) both finalize the SAME way: a single `terminal('skipped')` call. terminal() itself
// owns settle+release (Ruling-7) -- there is no separate release() here, and none is needed.
function onContention(writer, kind) {
  if (!writer) return;
  writer.terminal('skipped', kind ? { reason: String(kind) } : {});
}

// Dev-ownership isolation and the runtime-disabled/unresolved-channel guard both finalize the
// same way: a single `terminal('blocked', ...)` call, wired ALONGSIDE the existing error-surface
// code in main.js (additive -- never replaces it).
function onGuardBlock(writer, reason) {
  if (!writer) return;
  writer.terminal('blocked', reason ? { reason: String(reason) } : {});
}

// --- cancel --------------------------------------------------------------------------------

// Records cancel intent BEFORE signaling the child. `writer.control('cancel_requested')` never
// throws (never-raises facade) and is a safe no-op for a writer without cancel authority (only
// the MINTER -- always Electron here -- has it); it durably records even AFTER handOff() has
// dropped Electron's local reference (writer.js's `allowHandedOff` exception, Task 2.3), because
// cancel is a controller-only permission that outlives full ownership, unlike terminal().
function onCancel({ writer, child } = {}) {
  if (writer && typeof writer.control === 'function') writer.control('cancel_requested');
  if (child && typeof child.kill === 'function') child.kill('SIGTERM');
}

// --- hand-off state machine -----------------------------------------------------------------

function _splitLines(buf) {
  // Local byte-split mirror of reconcile.js's own private _splitLines: kept as its own small
  // copy (Buffer-safe, never mangles a multi-byte UTF-8 record straddling the split point)
  // rather than reaching into another module's underscore-prefixed internal, matching this
  // codebase's existing precedent (e.g. writer.js's own _strictStringify mirror of records.js's).
  const lines = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) { lines.push(buf.subarray(start, i)); start = i + 1; }
  }
  lines.push(buf.subarray(start));
  return lines;
}

// Ack signal: the child durably wrote an `ownership{role:'handoff'}` record, OR any `terminal`
// (a fast successful/failed run that finished before Electron even noticed). Scans ALL segments
// for the activity (any producer), mirroring reconcile.js's own _topTypes scan.
function _hasAckSignal(home, activityId) {
  for (const seg of readOwnedSegments(activityDir(home, activityId))) {
    for (const line of _splitLines(seg.data)) {
      if (line.length === 0) continue;
      const rec = parseValid(line, activityId);
      if (rec === null) continue;
      if (rec.type === 'terminal') return true;
      if (rec.type === 'ownership' && rec.role === 'handoff') return true;
    }
  }
  return false;
}

// Production ack-wait: races disk-polling ack detection against the child's own 'exit' event and
// a bounded timeout. Resolves `true` iff an ack was actually observed; `false` in every other
// case (child exited without acking, or the timeout elapsed while still alive) -- handOff()
// itself inspects the child's exit state AFTER this resolves to tell those two `false` cases
// apart (findings 3 & 4: the outcome is keyed on the exit SIGNAL, not on the mere fact of exit).
function _defaultAwaitAck({ writer, child, home }) {
  const activityId = writer && writer.activityId;
  if (!activityId) return Promise.resolve(false); // nothing to watch for
  return new Promise((resolve) => {
    let settled = false;
    let pollTimer = null;
    let timeoutTimer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (pollTimer !== null) clearInterval(pollTimer);
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
      if (child && typeof child.removeListener === 'function') child.removeListener('exit', onExit);
      resolve(result);
    };

    const check = () => {
      let acked = false;
      try { acked = _hasAckSignal(home, activityId); } catch (e) { acked = false; }
      if (acked) finish(true);
      return acked;
    };

    function onExit() {
      // one last look -- the child may have durably written its ack just before exiting, and
      // the 'exit' event can race the poll interval.
      if (!check()) finish(false);
    }

    if (child && typeof child.once === 'function') child.once('exit', onExit);
    if (check()) return; // already acked -- cheap short-circuit, no timers even started
    pollTimer = setInterval(check, ACK_POLL_MS);
    timeoutTimer = setTimeout(() => finish(false), ACK_TIMEOUT_MS);
  });
}

// child.exitCode is set by Node BEFORE the 'exit' event is emitted, so by the time
// _defaultAwaitAck's own 'exit' listener (or the caller, after awaiting) inspects it, an already-
// exited child's code (or signal-death) is reliably observable as a plain property read -- no
// event-ordering race with our own polling/listener above.
function _childExitInfo(child) {
  if (!child) return { exited: true, code: null };
  const code = typeof child.exitCode === 'number' ? child.exitCode : null;
  const exited = code !== null || Boolean(child.killed) ||
    (child.signalCode !== undefined && child.signalCode !== null);
  return { exited, code };
}

// Post-spawn: Electron NEVER kills the child and NEVER writes a terminal except on the one exact
// signal below (best-effort -- a healthy worker must never die because history recording
// failed). `_awaitAck`/`_reconcile` are test-only injection seams; production callers omit both.
async function handOff({ writer, child, home, _awaitAck = _defaultAwaitAck, _reconcile = null } = {}) {
  if (!writer) return;
  let acked = false;
  try {
    acked = await _awaitAck({ writer, child, home });
  } catch (e) {
    acked = false; // never let an ack-detection failure escape -- fall through to exit-signal logic
  }
  if (acked) {
    // (a) the child durably acked (ownership{role:'handoff'} or any terminal) -> close-only,
    // NEVER a force-unlock -- the child's shared OFD keeps the lease. Controller-only from here.
    writer.dropLocalReference();
    return;
  }

  const { exited, code } = _childExitInfo(child);
  if (!exited) {
    // (c) timeout with the child still ALIVE -> drop our reference only; the live worker is
    // NEVER killed and the sync completes. The activity stays running/incomplete; the
    // reconciler finalizes it once the worker actually exits.
    writer.dropLocalReference();
    return;
  }

  if (code === HANDOFF_REJECTED_EXIT) {
    // (b1) the adopter explicitly rejected the handoff (corrupt/spoofed lease) -- Electron is
    // the sole remaining authority, so it finalizes `failed` itself.
    writer.terminal('failed');
    return;
  }

  // (b2) ANY other exit (a crash, or a fast successful sync whose own ownership-history write
  // merely failed) -- the outcome is chosen by durable evidence, never by the mere fact of exit:
  // observability failure must never relabel a real outcome as `failed`. Drop our reference, then
  // let the single-activity reconciler decide (a durable terminal already on disk settles as-is
  // / no-op; a start with no terminal synthesizes interrupted/cancelled).
  const activityId = writer.activityId;
  writer.dropLocalReference();
  if (_reconcile) {
    _reconcile(home, activityId);
  } else {
    try { reconcile.synthesizeTerminal(home, activityId); } catch (e) { /* best-effort */ }
  }
}

module.exports = {
  secretValues,
  beginManualActivity,
  onContention,
  onGuardBlock,
  onCancel,
  handOff,
  HANDOFF_REJECTED_EXIT,
  // test-only seams
  _hasAckSignal,
  _childExitInfo,
  _defaultAwaitAck,
  get _ackTimeoutMs() { return ACK_TIMEOUT_MS; },
  set _ackTimeoutMs(v) { ACK_TIMEOUT_MS = v; },
  get _ackPollMs() { return ACK_POLL_MS; },
  set _ackPollMs(v) { ACK_POLL_MS = v; },
};
