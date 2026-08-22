'use strict';
// Node mirror of repo_radar/activity/reconcile.py (Task 2.2b) -- the WRITE half of Node's
// reconcile story. Ruling B: Node never unlinks, so this function never removes the ledger
// entry; it only ever APPENDS a synthetic terminal record. Used by Task 2.3's handoff-crash path
// (Electron explicitly synthesizes a terminal for a provably-dead handoff child).
//
// Structural divergence from Python, and why: Python's `reconcile.synthesize_terminal` does NOT
// itself check "has a start / lacks a terminal" -- that gating lives in quota.py's
// `_reconcile_one_locked`, which only ever CALLS synthesize_terminal once it already knows
// has_start-and-not-has_terminal. Node has no equivalent `_reconcileOneLocked` wrapper (Ruling B
// keeps Node's admit-side reconcile strictly read-only charge computation -- see quota.js's
// header comment), and Task 2.3 calls this function directly with no such wrapper in front of
// it. So Node's `synthesizeTerminal` folds that gate in: it derives has-start/has-terminal
// itself from parsed segments (never a ledger flag) before deciding whether to write anything.
const fs = require('fs');
const paths = require('./paths');
const records = require('./records');
const ids = require('./ids');
const lease = require('./lease');
const parse = require('./parse');
const merge = require('./merge');
const quota = require('./quota');

const RECONCILER = 'reconciler';

function _splitLines(buf) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      lines.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  lines.push(buf.subarray(start)); // trailing (possibly empty) segment, mirrors Python's split
  return lines;
}

// Types of VALID v1 records for THIS activity, via the canonical validator -- a nested
// `fields.type`, unsupported schema, foreign activity_id, or bad enum never counts. Lifecycle
// state is DERIVED from parsed segments, never a ledger flag.
function _topTypes(home, aid) {
  const types = [];
  for (const seg of paths.readOwnedSegments(paths.activityDir(home, aid))) {
    for (const line of _splitLines(seg.data)) {
      if (line.length === 0) continue;
      const obj = records.parseValid(line, aid);
      if (obj !== null) types.push(obj.type);
    }
  }
  return types;
}

function _hasStart(home, aid) {
  return _topTypes(home, aid).includes('start');
}

function _hasTerminal(home, aid) {
  return _topTypes(home, aid).includes('terminal');
}

function _cancelRequested(home, aid) {
  for (const seg of paths.readOwnedSegments(paths.activityDir(home, aid))) {
    for (const line of _splitLines(seg.data)) {
      if (line.length === 0) continue;
      const obj = records.parseValid(line, aid);
      if (obj !== null && obj.type === 'control' && obj.name === 'cancel_requested') return true;
    }
  }
  return false;
}

// For a provably-dead (lease-free), started-but-unterminated activity: acquire the lease, write
// a durable synthetic terminal (by=reconciler), and release. Returns true iff a terminal is now
// durable as a RESULT of this call. Returns false (preserve) when the lease is BUSY/UNCERTAIN,
// there's nothing to synthesize (no durable start, or a terminal already exists), or the write
// fails -- never throws (mirrors Python's `except Exception: return False` boundary).
function synthesizeTerminal(home, aid) {
  const lockPath = paths.ownerLockPath(home, aid); // may throw UnsafePath for an invalid aid --
  // deliberately unguarded, mirroring Python (callers are expected to pass a valid aid, exactly
  // as Python's own quota._reconcile_one_locked does).
  const acquired = lease.acquire(lockPath); // never throws (lease.js's own contract) -- null if
  // busy/uncertain/unsafe
  if (acquired === null) return false; // owner alive (or uncertain) -> preserve
  try {
    if (!_hasStart(home, aid) || _hasTerminal(home, aid)) {
      return false; // nothing to synthesize: never started, or already terminated
    }
    const outcome = _cancelRequested(home, aid) ? 'cancelled' : 'interrupted';
    const rec = records.buildRecord('terminal', {
      seq: 0, activity_id: aid, outcome, summary: {}, by: RECONCILER,
    });
    const blob = records.encodeRecord(rec);
    // Producer is "electron" (Node's own runtime identity), not a copy of Python's literal
    // "python" -- the segment filename records WHICH RUNTIME wrote the physical file; Python's
    // reconciler is Python code so it stamps "python", Node's reconciler is this code so it
    // stamps "electron". The record's `by` field (RECONCILER, above) is the one that must read
    // "reconciler" regardless of language -- that's unrelated to the segment producer tag.
    const segPath = paths.segmentPath(home, aid, 'electron', ids.mintToken());
    const fd = paths.secureOpenAppend(segPath);
    try {
      let offset = 0;
      while (offset < blob.length) {
        const n = fs.writeSync(fd, blob, offset, blob.length - offset);
        if (n <= 0) throw new Error('zero-byte write');
        offset += n;
      }
      fs.fsyncSync(fd); // B1: retain the lease until the terminal is DURABLE, not just written
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (e) {
    return false;
  } finally {
    acquired.release();
  }
}

// Task 3.3 addition: reconcile(home, activityId, { _probe } = {}) -- the READ-side counterpart
// to synthesizeTerminal above. Where synthesizeTerminal is the narrow WRITE-side primitive (used
// by Task 2.3's handoff-crash path, gated purely on has-start/no-terminal + a successful lease
// acquire), `reconcile` is the general-purpose reader the log-viewer calls to answer "what is
// this activity's current state, right now, safely" -- across EVERY segment, tolerant of
// half-written/crashed activities, and never destructive (Ruling B: the only writes it can ever
// cause are the same synthesized-terminal APPEND synthesizeTerminal already performs, plus a
// best-effort quota.settle() reap once that append is durable).
//
// Tri-state lease.probe drives the "is the owner actually gone" decision (finding 7/8): BUSY
// means someone else demonstrably holds owner.lock right now (never guess past that); UNCERTAIN
// means the probe itself couldn't confirm either way (e.g. a lockf/spawn anomaly) -- also never
// guessed past, surfaced instead as a System integrity Problem so a viewer knows to show
// "unknown", not a confident verdict. FREE is the only state where declaring the owner gone is
// safe -- and a MISSING lock file (never-yet-locked, or since removed) is FOLDED into FREE by the
// DEFAULT probe wrapper inside `reconcile` itself (not by lease.probe, which -- deliberately --
// reports UNCERTAIN for a missing file, since it can't rule out "someone is about to lock it").
// The fold lives in the wrapper specifically so an INJECTED `_probe` (the test seam) can still
// exercise the raw UNCERTAIN semantics without the wrapper's missing-file special case getting in
// the way -- see the two tests this distinguishes: "freed lock + no cancel" (no lock file, DEFAULT
// probe, must synthesize) vs. "UNCERTAIN probe" (also no lock file, but an INJECTED probe forcing
// 'uncertain', must NOT synthesize).
function _writerIdFromSegmentName(name) {
  // Filenames are `${producer}-${writerId}.jsonl` (paths.segmentPath). PRODUCERS ('electron',
  // 'dispatcher', 'python') never themselves contain a '-', so the LAST '-'-delimited component
  // is always the 8-hex writerId, whatever the producer.
  const stem = name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : name;
  const idx = stem.lastIndexOf('-');
  return idx === -1 ? stem : stem.slice(idx + 1);
}

// Assemble every segment's records (each annotated with the writerId its filename encodes) plus
// their integrity findings, then k-way merge them into one ordered record list via merge.js's
// mergeHeads (keyed on (ts, writerId), per-segment append order preserved -- see merge.js's own
// header comment). `problems` is mutated in place (parse.js's integrity findings are pushed
// straight in). Never throws: an unexpected failure degrades to "nothing readable" for the
// affected segment(s) plus a Problem, rather than crashing the viewer on a half-written/crashed
// activity.
function _assemble(home, activityId, problems) {
  let segs;
  try {
    segs = paths.readOwnedSegments(paths.activityDir(home, activityId));
  } catch (e) {
    problems.push({ kind: 'reconcile-internal-error', reason: `segment enumeration failed: ${e.message}` });
    return [];
  }
  const perSegment = [];
  for (const seg of segs) {
    try {
      const writerId = _writerIdFromSegmentName(seg.name);
      const { records: recs, integrity } = parse.parseSegment(seg.data, activityId);
      for (const finding of integrity) problems.push(finding);
      perSegment.push(recs.map((r) => Object.assign({}, r, { writerId })));
    } catch (e) {
      problems.push({ kind: 'reconcile-internal-error', reason: `segment ${seg.name} parse failed: ${e.message}` });
    }
  }
  try {
    return merge.mergeHeads(perSegment);
  } catch (e) {
    problems.push({ kind: 'reconcile-internal-error', reason: `merge failed: ${e.message}` });
    return [];
  }
}

// Re-read segments after a successful synthesize to find the FRESH terminal reconcile itself
// just caused, and report ITS outcome. Best-effort: any failure here just leaves the outcome
// null (`synthesized` stays true regardless -- the write itself is already durable, independent
// of whether this re-read can see it).
function _findReconcilerOutcome(home, activityId) {
  try {
    for (const seg of paths.readOwnedSegments(paths.activityDir(home, activityId))) {
      const { records: recs } = parse.parseSegment(seg.data, activityId);
      for (const r of recs) {
        if (r.type === 'terminal' && r.by === RECONCILER) return r.outcome;
      }
    }
  } catch (e) {
    // best-effort -- fall through to null
  }
  return null;
}

// The READ-side reconciler: assembles the merged record view for `activityId`, then decides a
// display `outcome`. Never destructive (Ruling B: the only writes it can cause are the
// synthesizeTerminal append below and the settle() reap that follows a successful synthesize) and
// never throws (best-effort: unexpected internal failures become a Problem, not an exception).
function reconcile(home, activityId, { _probe } = {}) {
  const lockPath = paths.ownerLockPath(home, activityId); // throws UnsafePath for an invalid aid
  // -- deliberately unguarded, mirroring synthesizeTerminal's own contract above (callers are
  // expected to pass a valid aid).
  // Default probe: a MISSING lock file folds to FREE here (not inside lease.probe itself, which
  // reports UNCERTAIN for a missing file) -- see this section's header comment. An injected
  // `_probe` bypasses this fold entirely, which is exactly what lets the UNCERTAIN test exercise
  // the raw tri-state semantics against the same no-lock-file starting condition.
  const probeFn = _probe || ((lp) => (fs.existsSync(lp) ? lease.probe(lp) : lease.FREE));

  const problems = [];
  const merged = _assemble(home, activityId, problems);

  const terminals = merged.filter((r) => r.type === 'terminal');
  if (terminals.length > 0) {
    const counts = {};
    for (const t of terminals) counts[t.outcome] = (counts[t.outcome] || 0) + 1;
    const distinct = Object.keys(counts);
    if (distinct.length === 1) {
      return { outcome: distinct[0], synthesized: false, problems, duplicateTerminalCounts: counts };
    }
    // Conflict: >=2 distinct outcomes recorded for the same activity. This should never happen in
    // a correctly-functioning system (only one producer should ever durably terminate an
    // activity), but a reader must degrade gracefully rather than pick one arbitrarily -- report a
    // DISPLAY-ONLY `interrupted` verdict (nothing is written to disk here) plus an integrity
    // Problem so the viewer can surface the conflict instead of silently hiding it.
    problems.push({
      kind: 'reconcile-terminal-conflict',
      reason: `${distinct.length} conflicting terminal outcomes: ${distinct.join(', ')}`,
    });
    return { outcome: 'interrupted', synthesized: false, problems, duplicateTerminalCounts: counts };
  }

  // No terminal recorded anywhere. Nothing to reconcile unless a durable `start` exists.
  let hasStart;
  try {
    hasStart = _hasStart(home, activityId);
  } catch (e) {
    problems.push({ kind: 'reconcile-internal-error', reason: `has-start check failed: ${e.message}` });
    return { outcome: null, synthesized: false, problems, duplicateTerminalCounts: {} };
  }
  if (!hasStart) {
    return { outcome: null, synthesized: false, problems, duplicateTerminalCounts: {} };
  }

  // Running candidate: has a start, no terminal. Only NOW is the lease probed -- never for an
  // already-terminated activity, where owner liveness is moot.
  let state;
  try {
    state = String(probeFn(lockPath)).toUpperCase();
  } catch (e) {
    state = lease.UNCERTAIN; // a probe (injected or real) that itself throws is exactly the
    // "can't confirm" case -- never treated as FREE.
  }

  if (state === lease.BUSY) {
    return { outcome: null, synthesized: false, problems, duplicateTerminalCounts: {} };
  }
  if (state !== lease.FREE) {
    // UNCERTAIN (or any value that isn't a recognized tri-state constant) -- never guess a dead
    // owner. Surfaced as a System integrity Problem so the viewer can tell "we don't know" apart
    // from "confirmed still running".
    problems.push({
      kind: 'reconcile-probe-uncertain',
      reason: `lease probe returned ${state}; owner liveness could not be confirmed`,
    });
    return { outcome: null, synthesized: false, problems, duplicateTerminalCounts: {} };
  }

  // FREE (including lock-absent, folded in by the default probeFn above): the owner is
  // confirmably gone. Reuse the existing write-side primitive verbatim -- it re-derives
  // has-start/no-terminal itself under its own lease acquisition, picks cancelled-vs-interrupted,
  // and performs the durable (fsync-before-release) append. Never reimplemented here.
  const wrote = synthesizeTerminal(home, activityId);
  if (!wrote) {
    // A race: something changed the state between this function's own read and
    // synthesizeTerminal's lease acquisition (e.g. the lease was re-acquired by a legitimate
    // owner, or a terminal landed concurrently). Preserve, rather than guess.
    problems.push({
      kind: 'reconcile-synthesize-raced',
      reason: 'synthesizeTerminal declined to write (lease contested or state changed concurrently)',
    });
    return { outcome: null, synthesized: false, problems, duplicateTerminalCounts: {} };
  }

  const outcome = _findReconcilerOutcome(home, activityId);

  // Best-effort ledger reap now that this activity is durably terminated. settle() itself already
  // never raises (see quota.js), but this stays defensive per Ruling A/B: nothing about this
  // read-side call may ever surface as an exception to the viewer.
  try {
    quota.settle(home, activityId);
  } catch (e) {
    problems.push({ kind: 'reconcile-settle-failed', reason: e.message });
  }

  return { outcome, synthesized: true, problems, duplicateTerminalCounts: {} };
}

// Task 2.2c addition: writer.js needs the SAME read-only "does a durable start record already
// exist for this activity" check quota.py's `_has_start` provides on the Python side --
// writer.py's adopt-vs-first-producer detection (`self._first_producer = not
// quota._has_start(home, inherited_id)`) and its `_durably_started()` upstream-adopt check both
// depend on it. Node's quota.js deliberately has NO such function (Ruling B keeps Node's quota
// surface to admit/grant/settle plus a strictly-read-only `_charge`/`_hasCorrupt` accounting
// pass -- see quota.js's header comment), but reconcile.js already computes exactly this via
// `_topTypes` for its own `synthesizeTerminal` gate. Exporting the existing private helper here
// (no behavior change) avoids writer.js duplicating the segment-scan logic.
module.exports = { RECONCILER, synthesizeTerminal, reconcile, _hasStart };
