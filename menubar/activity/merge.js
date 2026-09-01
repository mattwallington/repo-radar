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
// Comparison key: `ts` first, compared as an INSTANT (not a lexical string). Records are written
// as `datetime.now(timezone.utc).astimezone().isoformat()` -- a LOCAL-offset ISO-8601 string --
// so the UTC offset can differ across writers or shift mid-segment (DST). Lexical comparison of
// two such strings does not agree with chronological order (e.g. `...10:00:00+02:00` is 08:00Z,
// which is BEFORE `...09:00:00+00:00` = 09:00Z, even though the former sorts lexically after the
// latter). So each head's `ts` is parsed once via `Date.parse` (handles ISO-8601 with an offset
// or `Z`) and compared as milliseconds-since-epoch. The parsed value is cached per record object
// in a WeakMap (`_instantOf`) so a head that loses several rounds of comparison before it's
// finally popped is never re-parsed -- and the cache never touches/mutates the record object
// itself (no enumerable or hidden property added to it).
//
// This is still just a best-effort cross-segment interleave hint, not a correctness requirement:
// within-segment order never depends on it (append order always wins via the head-only advance
// below), so a backwards or oddly-offset `ts` can never corrupt a single writer's ordering -- it
// only ever affects how segments interleave with each other.
//
// Fallback/tie-break chain, in order:
//   1. If BOTH heads' `ts` parse to a valid instant and the instants differ, the earlier instant
//      wins.
//   2. Otherwise (equal instants, OR either side failed to parse -- NaN) fall back to comparing
//      `ts` lexically as plain strings, so the merge stays total and deterministic and never
//      throws even on a malformed timestamp.
//   3. Ties on both (equal instant, or equal lexical `ts`) break by `writerId` (lexical).
//   4. Defensive determinism: if two heads somehow tie on `ts` AND `writerId` (shouldn't happen
//      -- writerId is unique per segment), break by lowest segment index, so the merge never
//      leaves the choice ambiguous.
//
// Linear "scan all heads for the min each pop" -- segment counts are tiny (a handful of writers
// per activity), so no heap is needed here.

// Per-record cache of the parsed instant (ms since epoch), keyed by record object identity.
// A WeakMap is used instead of a property on the record so mergeHeads never mutates its inputs --
// not even with a hidden/non-enumerable field.
const _instantCache = new WeakMap();

// Returns the parsed instant (ms since epoch) for `record.ts`, computing and caching it on first
// use. Returns NaN if `record.ts` does not parse (Date.parse's own failure signal) -- callers
// must check for NaN before trusting the value.
function _instantOf(record) {
  let ms = _instantCache.get(record);
  if (ms === undefined) {
    ms = Date.parse(record.ts);
    _instantCache.set(record, ms);
  }
  return ms;
}

// Returns true if the head at `candidate` sorts before the current best `champion`.
function _beats(candidate, champion) {
  const candidateMs = _instantOf(candidate.record);
  const championMs = _instantOf(champion.record);
  if (!Number.isNaN(candidateMs) && !Number.isNaN(championMs)) {
    if (candidateMs !== championMs) return candidateMs < championMs;
  } else if (candidate.ts !== champion.ts) {
    return candidate.ts < champion.ts;
  }
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
