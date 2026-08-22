'use strict';
// Task 3.2: mergeHeads -- the read-side k-way segment merge for Phase 3's log-viewer reader.
// Ruling B: this module is pure/read-only -- no filesystem I/O, no side effects, and it never
// mutates its input (neither the `segments` arrays nor the record objects they hold).
//
// `segments` is an array of per-segment record arrays, each already in append order (the output
// of Task 3.1's `parseSegment` -- already-parsed objects, so there is no line-splitting or JSON
// parsing here). The merge only ever compares the CURRENT HEAD of each segment by `(ts,
// writerId)`, pops the winning head, and appends it to the output, then re-compares the new
// heads. A segment is NEVER sorted or reordered internally -- it always advances head-to-tail in
// its given order. That is the whole point: per-segment append order survives even when `ts`
// steps backward within that segment (a naive global `(ts, writerId, seq)` sort would break
// this -- do NOT do a global sort here).
//
// Comparison key: `ts` first, as a LEXICAL STRING comparison -- the brief's contract is
// literally `(ts, writerId)` and its test uses lexically-orderable timestamps, so timestamps are
// never parsed into instants or normalized across UTC offsets. This is a best-effort cross-
// segment interleave hint, not a correctness requirement: within-segment order never depends on
// it (append order always wins), so a backwards or oddly-offset `ts` can never corrupt a single
// writer's ordering -- it only ever affects how segments interleave with each other. Ties on
// `ts` break by `writerId` (also lexical). Defensive determinism: if two heads somehow tie on
// BOTH `ts` and `writerId` (shouldn't happen -- writerId is unique per segment), break by lowest
// segment index, so the merge never leaves the choice ambiguous.
//
// Linear "scan all heads for the min each pop" -- segment counts are tiny (a handful of writers
// per activity), so no heap is needed here.

// Returns true if the head at `candidate` sorts before the current best `champion`.
function _beats(candidate, champion) {
  if (candidate.ts !== champion.ts) return candidate.ts < champion.ts;
  if (candidate.writerId !== champion.writerId) return candidate.writerId < champion.writerId;
  return candidate.segIndex < champion.segIndex;
}

function mergeHeads(segments) {
  const cursors = segments.map(() => 0); // per-segment read position; never mutates `segments`
  const out = [];
  const segCount = segments.length;

  for (;;) {
    let best = null; // { ts, writerId, segIndex, record }
    for (let i = 0; i < segCount; i++) {
      const seg = segments[i];
      const pos = cursors[i];
      if (pos >= seg.length) continue; // this segment is exhausted
      const record = seg[pos];
      const candidate = { ts: record.ts, writerId: record.writerId, segIndex: i, record };
      if (best === null || _beats(candidate, best)) {
        best = candidate;
      }
    }
    if (best === null) break; // every segment exhausted
    out.push(best.record);
    cursors[best.segIndex] += 1;
  }

  return out;
}

module.exports = { mergeHeads };
