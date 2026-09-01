'use strict';
// Task 3.1: parseSegment -- the read-side, per-segment JSONL parser for Phase 3's log-viewer
// reader. Ruling B: this module is pure/read-only -- it never touches the filesystem itself, only
// takes raw segment bytes in and returns parsed structures out. No caller of this module may use
// it to delete/mutate/truncate committed data.
//
// `records.parseValid` (Task 2.1/2.2b, `./records.js`) is THE canonical v1 shape validator -- the
// reviewed mirror of Python's `records.parse_valid` -- and is reused here verbatim rather than
// reimplemented. But `parseValid` only ever answers "valid record, or null" -- it doesn't say
// WHY a candidate line was rejected. Log-viewer surfacing needs that reason (interior corruption
// vs. unsupported schema vs. seq regression vs. a plain schema-validation failure), so
// `parseSegment` does its own `JSON.parse` per line first to classify the failure, then defers
// the full v1 verdict to `records.parseValid` once the shape is known to be JSON-parseable v1.
//
// Rules (brief §2, §6; Codex R3 B2 / Ruling 41):
//   - Split on raw `\n` BYTES (mirrors Python's `bytes.split(b"\n")`), not on decoded text, so a
//     multi-byte UTF-8 sequence straddling the split point is never mis-split.
//   - The durability contract is record+`\n`. The final split element is the remainder after the
//     last `\n`: empty when the buffer ended with `\n` (nothing to do), non-empty when it did not.
//     A non-empty remainder is IGNORED UNCONDITIONALLY -- even when it happens to be valid JSON --
//     and is NOT an integrity finding (truncation tolerance: a missing terminating newline is a
//     torn write, the normal shape of an in-progress writer's last write landing mid-record).
//     This is exactly Python quota.py `_scan`'s `interior = lines[:-1]` rule; Node accepting a
//     newline-less-but-parseable tail while Python ignored it made the two runtimes disagree on
//     whether a terminal existed (Python synthesized `interrupted`, Node then saw a conflict).
//   - Any INTERIOR line (every split element except the last) that fails to `JSON.parse`, is not
//     a JSON object, or fails v1 validation is corruption: emit a `corrupt-record` integrity
//     finding (the `reason` distinguishes the sub-cause) and keep going -- one bad interior line
//     must never hide later valid lines.
//   - A JSON-parseable object whose top-level `schema_version` is not EXACTLY the integer
//     literal `1` (`true`, `1.0`, `"1"`, missing, `2` -- Ruling 57) is an `unsupported-schema`
//     integrity finding and is NOT parsed as v1 (never handed to `records.parseValid`).
//   - A JSON-parseable, schema_version===1 candidate is handed to `records.parseValid` for the
//     full v1 verdict (activity_id match, required fields, enum shapes, etc.) -- `null` back is a
//     `corrupt-record` finding, a record back is accepted.
//   - Seq rule (Ruling 42): per segment, over accepted records with a numeric `seq`, a record whose
//     `seq <= lastSeq` is a `seq-regression` finding -- the record is STILL accepted (never
//     double-counted, never dropped), and `lastSeq` is always the last accepted record's own seq
//     (not a running max), so a regression is flagged where it happens without cascading.
//
// Canonical finding kinds (shared with Python's `_scan` findings and read.js's problem lens):
//   `corrupt-record` | `unsupported-schema` | `seq-regression`
const records = require('./records');

const CORRUPT_RECORD = 'corrupt-record';
const UNSUPPORTED_SCHEMA = 'unsupported-schema';
const SEQ_REGRESSION = 'seq-regression';

// Split raw segment bytes on `\n` (0x0a), byte-wise -- mirrors Python's `bytes.split(b"\n")`.
// The final element is the trailing (possibly empty) remainder after the last newline; a
// non-empty trailing element means the buffer did NOT end with `\n`.
function _splitLines(buf) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      lines.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  lines.push(buf.subarray(start));
  return lines;
}

// The COMMITTED lines of a segment: every `\n`-terminated line, in order. The unterminated tail
// (if any) is dropped here, unconditionally -- this is the single implementation of the
// trailing-line rule every segment reader in this subsystem goes through (via `parseSegment`).
function committedLines(buf) {
  const lines = _splitLines(buf);
  lines.pop(); // the remainder after the last `\n`: empty (buffer ended with `\n`) or a torn tail
  return lines;
}

function _finding(kind, index, reason) {
  return { kind, index, reason };
}

// Parse one segment's raw bytes into `{ records, integrity }`. `records` holds accepted v1
// record objects in file order; `integrity` holds finding objects (each with a `.kind` that is
// one of the canonical kinds above). Pure: no filesystem access, no mutation of `bytes`.
function parseSegment(bytes, expectedActivityId) {
  const lines = committedLines(bytes);
  const out = [];
  const integrity = [];
  let lastSeq = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) {
      continue; // a genuinely empty interior line -- silent, nothing to classify
    }

    // Ruling 47: decode FATALLY, once -- invalid UTF-8 is `corrupt-record`, never U+FFFD-repaired
    // into something `JSON.parse` would then accept (Python's `json.loads(bytes)` rejects it).
    let text;
    try {
      text = records.decodeUtf8Fatal(line);
    } catch (e) {
      integrity.push(_finding(CORRUPT_RECORD, i, 'invalid UTF-8'));
      continue;
    }

    // Codex R6 I5 / Ruling 57: the schema_version verdict is taken on the STRICT-LITERAL view.
    // Shared rule: a JSON object whose top-level `schema_version` is not EXACTLY the integer
    // literal 1 (`true`, `1.0`, `"1"`, missing, `2`) is `unsupported-schema`. A bare `JSON.parse`
    // collapses `1.0` to `1` (`1.0 === 1`), so that line used to fall through to
    // `records.parseValid`'s strict-literal rejection and surface as `corrupt-record` -- diverging
    // from Python, where `1.0` is a float, not `int` 1, and is `unsupported-schema`. So parse via
    // `parseJsonStrictIntegers` with only `schema_version` strict: an `InvalidRecord` from it
    // means exactly "top-level schema_version is a non-integer literal" -> unsupported-schema.
    // (Only an OBJECT can carry a top-level key, so the not-an-object classification below is
    // unaffected: the strict check never fires for arrays/scalars.)
    let obj;
    let schemaLiteralNonInteger = false;
    try {
      obj = records.parseJsonStrictIntegers(text, ['schema_version']);
    } catch (e) {
      if (!(e instanceof records.InvalidRecord)) {
        integrity.push(_finding(CORRUPT_RECORD, i, `JSON.parse failed: ${e.message}`));
        continue;
      }
      schemaLiteralNonInteger = true;
      obj = JSON.parse(text); // parses (the strict parse only failed on the literal shape)
    }

    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      integrity.push(_finding(CORRUPT_RECORD, i, 'parsed JSON is not an object'));
      continue;
    }

    if (schemaLiteralNonInteger || obj.schema_version !== records.SCHEMA_VERSION) {
      integrity.push(_finding(UNSUPPORTED_SCHEMA, i, `schema_version=${JSON.stringify(obj.schema_version)}`));
      continue;
    }

    const rec = records.parseValid(text, expectedActivityId); // already fatally decoded above
    if (rec === null) {
      integrity.push(_finding(CORRUPT_RECORD, i, 'failed v1 schema/enum validation'));
      continue;
    }

    if (typeof rec.seq === 'number') {
      if (rec.seq <= lastSeq) {
        integrity.push(_finding(SEQ_REGRESSION, i, `seq ${rec.seq} did not increase past ${lastSeq}`));
      }
      lastSeq = rec.seq;
    }

    out.push(rec); // pushed regardless of the seq check -- seq ordering is a separate integrity
    // signal from schema validity; a record that is otherwise a valid v1 record for this
    // activity is still surfaced to the viewer, just alongside the finding above.
  }

  return { records: out, integrity };
}

module.exports = {
  parseSegment,
  committedLines,
  FINDING_KINDS: Object.freeze([CORRUPT_RECORD, UNSUPPORTED_SCHEMA, SEQ_REGRESSION]),
};
