'use strict';
// Task 3.1: parseSegment -- the read-side, per-segment JSONL parser for Phase 3's log-viewer
// reader. Ruling B: this module is pure/read-only -- it never touches the filesystem itself, only
// takes raw segment bytes in and returns parsed structures out. No caller of this module may use
// it to delete/mutate/truncate committed data.
//
// `records.parseValid` (Task 2.1/2.2b, `./records.js`) is THE canonical v1 shape validator -- the
// reviewed mirror of Python's `records.parse_valid` -- and is reused here verbatim rather than
// reimplemented. But `parseValid` only ever answers "valid record, or null" -- it doesn't say
// WHY a candidate line was rejected. Log-viewer surfacing needs that reason (truncation vs.
// interior corruption vs. unsupported schema vs. seq regression vs. a plain schema-validation
// failure), so `parseSegment` does its own `JSON.parse` per line first to classify the failure,
// then defers the full v1 verdict to `records.parseValid` once the shape is known to be
// JSON-parseable v1.
//
// Rules (brief §2, §6):
//   - Split on raw `\n` BYTES (mirrors Python's `bytes.split(b"\n")`), not on decoded text, so a
//     multi-byte UTF-8 sequence straddling the split point is never mis-split.
//   - A truncated TRAILING line (the buffer did not end with `\n`, i.e. the last split element is
//     a non-empty partial write) is dropped SILENTLY -- no integrity finding. This is the normal
//     shape of an in-progress writer's last write landing mid-record.
//   - Any INTERIOR line (every split element except the last) that fails to `JSON.parse` is
//     corruption: emit an `integrity` finding and keep going -- one bad interior line must never
//     hide later valid lines.
//   - A JSON-parseable object whose `schema_version !== 1` is an `unsupported-schema` integrity
//     finding and is NOT parsed as v1 (never handed to `records.parseValid`).
//   - A JSON-parseable, schema_version===1 candidate is handed to `records.parseValid` for the
//     full v1 verdict (activity_id match, required fields, enum shapes, etc.) -- `null` back is an
//     integrity finding, a record back is accepted.
//   - Accepted records must have a strictly increasing `seq` (tracked across the whole segment);
//     a non-increasing `seq` is an integrity finding whose `kind` contains "seq". The record
//     itself is still not double-counted -- the seq-regression finding does not additionally
//     duplicate the "already accepted" record push.
const records = require('./records');

// Split raw segment bytes on `\n` (0x0a), byte-wise -- mirrors reconcile.js's `_splitLines` /
// Python's `bytes.split(b"\n")`. The final element is the trailing (possibly empty) remainder
// after the last newline; a non-empty trailing element means the buffer did NOT end with `\n`.
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

function _finding(kind, index, reason) {
  return { kind, index, reason };
}

// Parse one segment's raw bytes into `{ records, integrity }`. `records` holds accepted v1
// record objects in file order; `integrity` holds finding objects (each with at least a `.kind`
// string other code matches on). Pure: no filesystem access, no mutation of `bytes`.
function parseSegment(bytes, expectedActivityId) {
  const lines = _splitLines(bytes);
  const out = [];
  const integrity = [];
  let lastSeq = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isTrailing = i === lines.length - 1;
    if (line.length === 0) {
      // Either the final empty element from a buffer that DID end with `\n` (normal, silent), or
      // a genuinely empty interior line (also silent -- nothing to classify).
      continue;
    }

    let obj;
    try {
      obj = JSON.parse(line.toString('utf8'));
    } catch (e) {
      if (isTrailing) {
        // Truncated last write (buffer did not end with `\n`) -- drop silently, no finding.
        continue;
      }
      integrity.push(_finding('corrupt-json', i, `JSON.parse failed: ${e.message}`));
      continue;
    }

    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      integrity.push(_finding('corrupt-shape', i, 'parsed JSON is not an object'));
      continue;
    }

    if (obj.schema_version !== records.SCHEMA_VERSION) {
      integrity.push(_finding('unsupported-schema', i, `schema_version=${JSON.stringify(obj.schema_version)}`));
      continue;
    }

    const rec = records.parseValid(line, expectedActivityId);
    if (rec === null) {
      integrity.push(_finding('invalid-record', i, 'failed v1 schema/enum validation'));
      continue;
    }

    if (typeof rec.seq === 'number' && rec.seq <= lastSeq) {
      integrity.push(_finding('seq-regression', i, `seq ${rec.seq} did not increase past ${lastSeq}`));
    }
    // `lastSeq` tracks the most recently accepted record's own seq (not a running max) -- a
    // regression is flagged at the exact point it happens, without cascading into false
    // positives against every later record whose own seq happens to trail an earlier outlier.
    if (typeof rec.seq === 'number') lastSeq = rec.seq;

    out.push(rec); // pushed regardless of the seq check -- seq ordering is a separate integrity
    // signal from schema validity; a record that is otherwise a valid v1 record for this
    // activity is still surfaced to the viewer, just alongside the finding above.
  }

  return { records: out, integrity };
}

module.exports = { parseSegment };
