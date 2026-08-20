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

module.exports = { RECONCILER, synthesizeTerminal };
