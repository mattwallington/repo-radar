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

// F-E parity fix: every lifecycle helper below reads segments via `readOwnedSegments`, which
// (correctly) has no naming opinion of its own -- it reads any `*.jsonl` entry that survives the
// symlink/non-regular safety checks. Left unfiltered here, a non-conforming file sitting in the
// activity dir (e.g. `python-s3cr3t.jsonl`, or plain `junk.jsonl`) that happens to contain a
// `start`/`terminal`-shaped record would still drive `_lifecycleView`'s has-start/has-terminal/
// cancel-requested facts -- and, via those, `synthesizeTerminal` could WRITE a synthetic terminal (and `reconcile()`
// derive a displayed outcome) off the back of a file nothing in this codebase ever wrote as a
// real segment. `_scanSegments` is the one choke point: every segment read in this file goes
// through it, filtering to entries `paths.parseSegmentName` accepts as conforming.
//
// Codex R2 B1 / Ruling 38: the scan is built on the DETAILED read, not the lossy
// `readOwnedSegments`, because a conforming segment the reader REFUSED (chmod 000, a symlink
// swapped onto the name, a FIFO, gone mid-scan) is not the same as a segment that is ABSENT.
// Filtering the lossy list treated it as absent: a readable `start` + an unreadable `succeeded`
// terminal + a free lock made `synthesizeTerminal` write an `interrupted` terminal, and once the
// perms were restored the store held two conflicting terminals -- a conflict the reconciler
// itself manufactured. "Uncertain => preserve, never guess" means the VIEW must be certain before
// any lifecycle verdict is derived from it. The view is UNCERTAIN iff any rejected entry has a
// CONFORMING name (it is, or is squatting on, a real segment whose contents we cannot see) or
// the directory itself could not be listed. A rejected entry whose name does NOT conform
// (`junk.jsonl`, `python-s3cr3t.jsonl`) is an untrusted non-segment that would never have been
// parsed anyway -- it is NOT uncertainty and must not block synthesis (read.js reports it as a
// `bad-name` Problem; the lifecycle is unaffected by it either way).
function _scanSegments(directory) {
  const { segments, rejected } = paths.readOwnedSegmentsDetailed(directory);
  const conforming = segments.filter((seg) => paths.parseSegmentName(seg.name) !== null);
  const uncertain = rejected.filter(
    (rj) => rj.reason === 'dir-unreadable' || paths.parseSegmentName(rj.name) !== null,
  );
  return { segments: conforming, rejected: uncertain, certain: uncertain.length === 0 };
}

function _ownedSegments(directory) {
  return _scanSegments(directory).segments;
}

// One lifecycle VIEW of an activity from a SINGLE scan: whether the view is certain (see
// `_scanSegments`), which rejected entries made it uncertain, and the three lifecycle facts
// (has-start / has-terminal / cancel-requested) derived from VALID v1 records for THIS activity
// via the canonical validator -- a nested `fields.type`, unsupported schema, foreign activity_id,
// or bad enum never counts. Lifecycle state is DERIVED from parsed segments, never a ledger flag.
// One scan (not three) so the certainty verdict and the facts it qualifies come from the SAME
// directory listing -- a segment can't be "certain" for has-start and then vanish for has-terminal.
//
// Codex R3 B2 / Ruling 41: segment bytes are parsed via `parse.parseSegment` -- the ONE
// implementation of the line-split + trailing-line rule (an unterminated final line is ignored
// unconditionally, even when it happens to be valid JSON; the durability contract is
// record+`\n`). A private byte-split here previously accepted a newline-less terminal that
// Python's `_scan` ignored, so the two runtimes disagreed on whether the activity had ended.
function _lifecycleView(home, aid) {
  const scan = _scanSegments(paths.activityDir(home, aid));
  let hasStart = false;
  let hasTerminal = false;
  let cancelRequested = false;
  for (const seg of scan.segments) {
    for (const obj of parse.parseSegment(seg.data, aid).records) {
      if (obj.type === 'start') hasStart = true;
      else if (obj.type === 'terminal') hasTerminal = true;
      else if (obj.type === 'control' && obj.name === 'cancel_requested') cancelRequested = true;
    }
  }
  return { certain: scan.certain, rejected: scan.rejected, hasStart, hasTerminal, cancelRequested };
}

function _hasStart(home, aid) {
  return _lifecycleView(home, aid).hasStart;
}

// For a provably-dead (lease-free), started-but-unterminated activity: acquire the lease, write
// a durable synthetic terminal (by=reconciler), and release. Returns true iff a terminal is now
// durable as a RESULT of this call. Returns false (preserve) when the lease is BUSY/UNCERTAIN,
// the segment VIEW is uncertain (a conforming segment could not be read -- Ruling 38, see
// `_scanSegments`), there's nothing to synthesize (no durable start, or a terminal already
// exists), or the write fails -- never throws (mirrors Python's `except Exception: return False`
// boundary). The gate is `viewCertain && hasStart && !hasTerminal`, evaluated UNDER the acquired
// lease from one scan, so nothing observed before the lease was held can drive the write.
function synthesizeTerminal(home, aid) {
  const lockPath = paths.ownerLockPath(home, aid); // may throw UnsafePath for an invalid aid --
  // deliberately unguarded, mirroring Python (callers are expected to pass a valid aid, exactly
  // as Python's own quota._reconcile_one_locked does).
  const acquired = lease.acquire(lockPath); // never throws (lease.js's own contract) -- null if
  // busy/uncertain/unsafe
  if (acquired === null) return false; // owner alive (or uncertain) -> preserve
  try {
    const view = _lifecycleView(home, aid); // ONE scan, under the lease
    if (!view.certain) {
      return false; // Ruling 38: a conforming segment is unreadable -> the terminal we can't see
      // may already exist. Write NOTHING; the lease is released in `finally` below.
    }
    if (!view.hasStart || view.hasTerminal) {
      return false; // nothing to synthesize: never started, or already terminated
    }
    const outcome = view.cancelRequested ? 'cancelled' : 'interrupted';
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
    // I3 fix (Codex R1): acquired.release() ultimately calls fs.closeSync, which CAN throw
    // (EIO/EBADF on a genuinely broken fd). A `finally` block that itself throws REPLACES
    // whatever return value the try/catch above already computed with that exception instead --
    // which would break synthesizeTerminal's documented never-throws boundary (and therefore
    // reconcile()'s, since reconcile() calls this directly). Contained here rather than by
    // changing Lease.release() itself: the lease fd is being discarded either way (this function
    // is exiting), so a release failure is swallowed, never rethrown. The conservative return
    // value already selected above -- true iff the terminal write+fsync already completed
    // durably (the terminal IS durable, release failing after that changes nothing about that
    // fact), false otherwise -- is left untouched.
    try {
      acquired.release();
    } catch (e) {
      // swallow -- see comment above; nothing more can be done with a lease fd we're discarding
    }
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
//
// Ruling 38: alongside the merged records, the caller needs to know whether that view is CERTAIN
// -- `view.rejected` lists the conforming-but-unreadable entries (or the dir-unreadable marker)
// that make it uncertain. `view` is mutated in place (like `problems`) rather than changing the
// return shape. An enumeration failure is itself an uncertain view (nothing was seen).
function _assemble(home, activityId, problems, view = {}) {
  let scan;
  try {
    scan = _scanSegments(paths.activityDir(home, activityId));
  } catch (e) {
    problems.push({ kind: 'reconcile-internal-error', reason: `segment enumeration failed: ${e.message}` });
    view.certain = false;
    view.rejected = [{ name: '', reason: 'dir-unreadable' }];
    return [];
  }
  view.certain = scan.certain;
  view.rejected = scan.rejected;
  const perSegment = [];
  for (const seg of scan.segments) {
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
    for (const seg of _ownedSegments(paths.activityDir(home, activityId))) {
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
  const view = {};
  const merged = _assemble(home, activityId, problems, view);

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

  // No terminal among the segments we could READ. Before treating that as "no terminal": is the
  // view certain (Ruling 38)? A conforming segment that was refused (chmod 000, symlink, FIFO,
  // gone mid-scan) may hold the very terminal we're about to conclude is missing -- so the
  // verdict is "unknown", nothing is synthesized, no ledger settle, and the refused entries are
  // surfaced as a System integrity Problem (read.js scrubs + bounds the reason and marks the item
  // incomplete). Deliberately AFTER the readable-terminal branch above: a terminal we CAN read is
  // a durable fact, not a guess -- reporting it stays honest (read.js still flags the refused
  // entries as `rejected-segment` Problems and marks the item incomplete); uncertainty only ever
  // withholds a verdict that would have been INFERRED from absence.
  if (!view.certain) {
    const rejected = (view.rejected || []).map((rj) => ({ name: rj.name, reason: rj.reason }));
    const listed = rejected.map((rj) => `${rj.name || '(directory)'} (${rj.reason})`).join(', ');
    problems.push({
      kind: 'reconcile-view-uncertain',
      reason: `${rejected.length} segment entr${rejected.length === 1 ? 'y' : 'ies'} could not be read; lifecycle not inferred: ${listed}`,
      rejected,
    });
    return { outcome: null, synthesized: false, problems, duplicateTerminalCounts: {} };
  }

  // Nothing to reconcile unless a durable `start` exists.
  if (!merged.some((r) => r.type === 'start')) {
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
  // view-certain/has-start/no-terminal itself under its own lease acquisition (the Ruling 38
  // gate is re-evaluated there, from a fresh scan taken while the lease is held), picks
  // cancelled-vs-interrupted, and performs the durable (fsync-before-release) append. Never
  // reimplemented here.
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
// `_lifecycleView` for its own `synthesizeTerminal` gate. Exporting the existing private helper here
// (no behavior change) avoids writer.js duplicating the segment-scan logic.
module.exports = { RECONCILER, synthesizeTerminal, reconcile, _hasStart };
