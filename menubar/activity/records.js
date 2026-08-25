'use strict';
// Node mirror of repo_radar/activity/records.py (Task 2.1) -- byte-identical JSONL record
// encoding, pinned by the committed golden-equivalence fixtures in __tests__/. Mirror the
// CURRENT Python (post external review), not any earlier draft:
//   - compact separators, UTF-8 (non-ASCII left literal, i.e. `ensure_ascii=False` equivalent),
//     trailing "\n"
//   - numeric canonicalization: an integral float (e.g. `2.0`) encodes as `2` (JS's own
//     Number->string already does this; the real hazard is `JSON.stringify(Infinity)` silently
//     yielding "null", so every encode path here explicitly rejects non-finite numbers, matching
//     Python's `allow_nan=False` + the `math.isfinite` guard in `_canon`/parse)
//   - every value type is byte-bounded (not just strings), with a truncation marker + the
//     `_truncated` flag, split on a UTF-8 boundary

const SCHEMA_VERSION = 1;
const MAX_KEYS = 32;
const MAX_KEY_BYTES = 64;
const MAX_VALUE_BYTES = 1024;
const MAX_FIELDS_BYTES = 8192;
const MAX_DETAIL_BYTES = 8192;
const MAX_RECORD_BYTES = 20480;

class RecordTooLarge extends Error {}
class InvalidRecord extends Error {}

const VALID_TYPES = new Set(['start', 'ownership', 'event', 'control', 'terminal', 'integrity']);
const VALID_LEVELS = new Set(['info', 'warn', 'error']);
const VALID_ROLES = new Set(['initial', 'handoff']);
const VALID_OUTCOMES = new Set([
  'succeeded', 'succeeded-with-warnings', 'blocked', 'failed',
  'cancelled', 'skipped', 'interrupted',
]);

const REQUIRED = {
  start: ['kind', 'channel', 'trigger', 'created_by'],
  ownership: ['owner_token', 'role', 'producer', 'pid', 'boot_id', 'proc_birth'],
  event: ['level', 'event'],
  control: ['name'],
  terminal: ['outcome', 'summary', 'by'],
  integrity: ['kind'],
};

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:\d{2}$/;
const TOKEN_RE = /^[0-9a-f]{8}$/;
const PRODUCERS = new Set(['electron', 'dispatcher', 'python']);
const KINDS = new Set(['sync', 'system']);
// Canonical-integer-string field/summary keys ("0", "1", "42" -- NOT "01"/"1.0"/"x") are
// rejected outright rather than accepted (fix round 1): a JS plain object promotes such keys
// ahead of all other keys at object-CREATION time (before any of our code runs -- `JSON.parse`
// itself already reorders them), while Python dicts preserve their original insertion order,
// so the two encoders would silently produce different bytes for the same logical record.
// Refusing the key class on both sides keeps them symmetric instead of letting this drift.
const INT_KEY_RE = /^(0|[1-9]\d*)$/;

// Strict JSON stringify: identical to `JSON.stringify` except it explicitly rejects a
// non-finite number ANYWHERE in the value tree (top-level or nested), instead of letting
// `JSON.stringify` silently coerce Infinity/-Infinity/NaN to the literal `null`. This mirrors
// Python's `json.dumps(..., allow_nan=False)` at every call site that needs cross-language
// byte parity (Round-3 #8).
function _strictStringify(value) {
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === 'number' && !Number.isFinite(v)) {
      throw new InvalidRecord('non-finite number');
    }
    return v;
  });
}

function _flatPrimitiveMap(m) {
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return false;
  for (const k of Object.keys(m)) {
    const v = m[k];
    if (typeof v === 'boolean' || v === null || typeof v === 'string') continue;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return false;
      continue;
    }
    return false;
  }
  return true;
}

// Manual calendar validation for the ISO-8601-with-offset `ts` field. `new Date(str)` is too
// LENIENT for our purposes -- e.g. it silently rolls "2026-02-30" over into March instead of
// rejecting it, whereas Python's `datetime.fromisoformat` rejects it ("day is out of range for
// month"). Verified empirically against CPython: month 1-12, day valid-for-month (leap years
// accounted for), hour 0-23, minute/second 0-59 (no leap second), year 1-9999, and the offset's
// AGGREGATE magnitude strictly under 24h (Python does not independently range-check the offset
// minute field -- e.g. "+00:75" parses fine as a 75-minute offset, only the total is bounded).
function _daysInMonth(year, month) {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function _validTimestamp(ts) {
  if (typeof ts !== 'string') return false;
  const m = ISO_RE.exec(ts);
  if (!m) return false;
  const year = Number(ts.slice(0, 4));
  const month = Number(ts.slice(5, 7));
  const day = Number(ts.slice(8, 10));
  const hour = Number(ts.slice(11, 13));
  const minute = Number(ts.slice(14, 16));
  const second = Number(ts.slice(17, 19));
  if (year < 1 || year > 9999) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > _daysInMonth(year, month)) return false;
  if (hour > 23) return false;
  if (minute > 59) return false;
  if (second > 59) return false;
  const offSign = ts[ts.length - 6] === '-' ? -1 : 1;
  const offHour = Number(ts.slice(ts.length - 5, ts.length - 3));
  const offMinute = Number(ts.slice(ts.length - 2));
  const offTotalMinutes = offSign * (offHour * 60 + offMinute);
  if (Math.abs(offTotalMinutes) >= 24 * 60) return false;
  return true;
}

function _validate(rec) {
  const t = rec.type;
  if (!VALID_TYPES.has(t)) throw new InvalidRecord(`type ${JSON.stringify(t)}`);
  for (const k of REQUIRED[t] || []) {
    if (!(k in rec)) throw new InvalidRecord(`missing ${JSON.stringify(k)} for ${t}`);
  }
  // Codex R4 I4 / Ruling 48: `seq` must be an integer in the SHARED safe range
  // 0..Number.MAX_SAFE_INTEGER (2^53-1). `JSON.parse` has already rounded anything above that
  // (9007199254740992 and ...993 both parse to the same double), so accepting it produced a
  // spurious `seq-regression` Python never emits; Python enforces the identical range.
  const seq = rec.seq;
  if (typeof seq === 'boolean' || typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0 ||
      seq > Number.MAX_SAFE_INTEGER) {
    throw new InvalidRecord('seq');
  }
  if (!_validTimestamp(rec.ts)) {
    throw new InvalidRecord('ts');
  }
  if (t === 'event') {
    if (!VALID_LEVELS.has(rec.level)) throw new InvalidRecord('level');
    if (typeof rec.event !== 'string') throw new InvalidRecord('event');
    if (!_flatPrimitiveMap(rec.fields !== undefined ? rec.fields : {})) throw new InvalidRecord('fields');
    if (rec.detail !== undefined && rec.detail !== null && typeof rec.detail !== 'string') {
      throw new InvalidRecord('detail');
    }
  } else if (t === 'start') {
    if (!KINDS.has(rec.kind)) throw new InvalidRecord('kind');
    for (const k of ['channel', 'trigger', 'created_by']) {
      if (typeof rec[k] !== 'string') throw new InvalidRecord(k);
    }
  } else if (t === 'ownership') {
    if (!VALID_ROLES.has(rec.role)) throw new InvalidRecord('role');
    if (!(typeof rec.owner_token === 'string' && TOKEN_RE.test(rec.owner_token))) {
      throw new InvalidRecord('owner_token');
    }
    if (!PRODUCERS.has(rec.producer)) throw new InvalidRecord('producer');
    if (typeof rec.pid === 'boolean' || typeof rec.pid !== 'number' || !Number.isInteger(rec.pid)) {
      throw new InvalidRecord('pid');
    }
    if (typeof rec.boot_id !== 'string') throw new InvalidRecord('boot_id');
    if (typeof rec.proc_birth !== 'string') throw new InvalidRecord('proc_birth');
  } else if (t === 'control') {
    if (typeof rec.name !== 'string') throw new InvalidRecord('name');
    if (!_flatPrimitiveMap(rec.fields !== undefined ? rec.fields : {})) throw new InvalidRecord('fields');
  } else if (t === 'terminal') {
    if (!VALID_OUTCOMES.has(rec.outcome)) throw new InvalidRecord('outcome');
    if (!_flatPrimitiveMap(rec.summary)) throw new InvalidRecord('summary');
    const by = rec.by;
    if (!(by === 'reconciler' || (typeof by === 'string' && TOKEN_RE.test(by)))) {
      throw new InvalidRecord('by');
    }
  } else if (t === 'integrity') {
    if (typeof rec.kind !== 'string') throw new InvalidRecord('kind');
  }
}

function _nowIso() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const offMin = -d.getTimezoneOffset(); // minutes EAST of UTC (Node's getTimezoneOffset is WEST-positive)
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  const ms = d.getMilliseconds();
  const msPart = ms ? `.${pad(ms, 3)}` : '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${msPart}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// UTF-8-safe prefix of `buf` at up to `n` bytes: drops an incomplete trailing multi-byte
// sequence rather than splitting it, mirroring Python's `bytes[:n].decode("utf-8", "ignore")`.
// `buf` is assumed well-formed UTF-8 throughout (it always originates from encoding a JS
// string), so the only place an incomplete sequence can occur is exactly at the cut point --
// at most 3 trailing continuation bytes can dangle (max sequence length is 4).
function _utf8SafePrefix(buf, n) {
  n = Math.max(0, Math.min(n, buf.length));
  let end = n;
  for (let back = 1; back <= 3 && end - back >= 0; back++) {
    const b = buf[end - back];
    if ((b & 0xc0) === 0x80) continue; // continuation byte -- keep scanning back
    let seqLen;
    if ((b & 0x80) === 0x00) seqLen = 1;
    else if ((b & 0xe0) === 0xc0) seqLen = 2;
    else if ((b & 0xf0) === 0xe0) seqLen = 3;
    else if ((b & 0xf8) === 0xf0) seqLen = 4;
    else seqLen = 1;
    if (seqLen > back) end -= back; // incomplete sequence at the tail -> drop it
    break;
  }
  return buf.slice(0, end);
}

function _markerText(n) {
  return `…[truncated ${n} bytes]`;
}

function _truncate(s, limit) {
  const b = Buffer.from(s, 'utf8');
  if (b.length <= limit) return [s, false];
  const reserve = Buffer.byteLength(_markerText(b.length), 'utf8');
  const keepLen = Math.max(0, limit - reserve);
  const kept = _utf8SafePrefix(b, keepLen).toString('utf8');
  const droppedBytes = b.length - Buffer.byteLength(kept, 'utf8');
  return [kept + _markerText(droppedBytes), true];
}

// Byte-bounded key (not char-bounded). No marker appended (matches Python `_bound_key`).
// Rejects a canonical-integer-string key outright (fix round 1, cross-language byte-parity --
// see `INT_KEY_RE`); no real producer uses one, this only forecloses a future silent drift.
function _boundKey(k) {
  const original = String(k);
  if (INT_KEY_RE.test(original)) {
    throw new InvalidRecord(`numeric-like field key not allowed: ${JSON.stringify(original)}`);
  }
  const b = Buffer.from(original, 'utf8');
  if (b.length <= MAX_KEY_BYTES) return [original, false];
  return [_utf8SafePrefix(b, MAX_KEY_BYTES).toString('utf8'), true];
}

// Numeric canonicalization for cross-language byte equality (Round-3 #8): reject non-finite
// (JS JSON.parse can't read NaN/Infinity either); JS's own Number->string already renders an
// integral value like 2 without a trailing ".0", so there is no separate int-folding step here
// the way Python needs `float.is_integer()` -> `int(v)`.
function _canon(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new InvalidRecord('non-finite number');
    return v;
  }
  return v;
}

// Bound fields/summary: max 32 keys, each key <=64 bytes, each value <=1 KiB, aggregate <=8 KiB.
// Non-object input or non-primitive values raise InvalidRecord. Truncation sets `_truncated`.
function _boundFields(fields) {
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new InvalidRecord('fields must be a flat map');
  }
  let truncated = false;
  const out = {};
  const entries = Object.entries(fields);
  for (let i = 0; i < entries.length; i++) {
    if (i >= MAX_KEYS) { truncated = true; break; }
    let [k, v] = entries[i];
    const [bk, keyTrunc] = _boundKey(k);
    k = bk;
    truncated = truncated || keyTrunc;

    if (typeof v === 'string') {
      const [tv, t] = _truncate(v, MAX_VALUE_BYTES);
      v = tv; truncated = truncated || t;
    } else if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
      v = _canon(v); // non-finite -> reject
      // Structurally unreachable for a finite JS `number` (max ~309 chars for the largest
      // finite double, always << MAX_VALUE_BYTES): kept only for structural parity with
      // records.py, where an arbitrary-precision Python `int` genuinely CAN exceed this bound.
      // Not dead-by-mistake -- do not delete as "unreachable".
      if (Buffer.byteLength(_strictStringify(v), 'utf8') > MAX_VALUE_BYTES) {
        const [tv, t] = _truncate(String(v), MAX_VALUE_BYTES);
        v = tv; truncated = truncated || t;
      }
    } else {
      throw new InvalidRecord('fields values must be flat primitives');
    }
    out[k] = v;
  }

  while (Buffer.byteLength(_strictStringify(out), 'utf8') > MAX_FIELDS_BYTES && Object.keys(out).length > 0) {
    const keys = Object.keys(out);
    delete out[keys[keys.length - 1]];
    truncated = true;
  }
  return [out, truncated];
}

function buildRecord(type, args = {}) {
  const { seq, activity_id, ts, ...payload } = args;
  const rec = {
    schema_version: SCHEMA_VERSION,
    activity_id,
    type,
    seq,
    ts: ts || _nowIso(),
  };
  let truncated = false;
  for (const dictKey of ['fields', 'summary']) { // summary is bounded like fields (finding 7)
    if (Object.prototype.hasOwnProperty.call(payload, dictKey)) {
      const [bounded, t] = _boundFields(payload[dictKey]);
      payload[dictKey] = bounded;
      truncated = truncated || t;
    }
  }
  if (payload.detail !== undefined && payload.detail !== null) {
    const [tv, t] = _truncate(String(payload.detail), MAX_DETAIL_BYTES);
    payload.detail = tv;
    truncated = truncated || t;
  }
  Object.assign(rec, payload);
  if (truncated) rec._truncated = true;
  _validate(rec); // enum validation (finding 7)
  if (encodedLen(rec) > MAX_RECORD_BYTES) {
    throw new RecordTooLarge(`${type} record exceeds ${MAX_RECORD_BYTES} bytes`);
  }
  return rec;
}

function encodeRecord(record) {
  // `_strictStringify` raises on any non-finite number rather than silently emitting `null`,
  // matching Python's `allow_nan=False` (Round-3 #8) -- this is the FINAL encode-time guard,
  // independent of `_canon` having already run during `build()`.
  return Buffer.from(`${_strictStringify(record)}\n`, 'utf8');
}

function encodedLen(record) {
  return encodeRecord(record).length;
}

// Strict UTF-8 decode: throws TypeError on any invalid sequence (no U+FFFD substitution), keeps a
// leading BOM in the output. Shared by parseValid (below) and parse.js's per-line classifier so
// there is exactly one decode rule on the read path (Ruling 47).
const _FATAL_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function _decodeUtf8Fatal(buf) {
  return _FATAL_UTF8.decode(buf);
}

// Task 2.2b addition: the READ-side counterpart to buildRecord/encodeRecord, needed by
// reconcile.js's lifecycle checks (_hasStart/_hasTerminal/_cancelRequested parse EXISTING
// segments rather than building new records). Mirrors `records.parse_valid` -- THE canonical
// validator: parse one JSONL line and return the record ONLY if it is a SUPPORTED v1 record FOR
// the expected activity with valid base metadata, required fields, AND type-specific enums.
// Anything else -> null. A stray/nested/foreign/malformed record (wrong outcome, wrong
// activity_id, unsupported schema, missing field) therefore never counts.
//
// `raw` may be a Buffer (the normal case -- callers read segments as raw bytes, matching
// Python's `bytes.split(b"\n")`) or a string. Node's `JSON.parse` already rejects the bare
// NaN/Infinity/-Infinity tokens Python's custom `parse_constant` exists to reject (Round-6 #2),
// so no extra handling is needed there; the `1e400`-overflow case (I6) is caught downstream by
// `_flatPrimitiveMap`'s `Number.isFinite` check on fields/summary values, exactly like Python's
// `math.isfinite` guard in `_flat_primitive_map`.
//
// Codex R4 B3 / Ruling 47: a Buffer is decoded FATALLY (`TextDecoder('utf-8', { fatal: true })`),
// never with the lossy `Buffer#toString('utf8')`, which silently replaces invalid bytes with
// U+FFFD -- so a line carrying a raw 0xff byte parsed as a perfectly valid record here while
// Python's `json.loads(bytes)` rejected it (a terminal `succeeded` on Node, `corrupt-record` ->
// `interrupted` on Python: a cross-language conflict). Invalid UTF-8 is an invalid record. The
// decoder keeps a leading BOM (`ignoreBOM: true`) so `JSON.parse` rejects it, as Python does.
function parseValid(raw, expectedActivityId) {
  let obj;
  try {
    const text = Buffer.isBuffer(raw) ? _decodeUtf8Fatal(raw) : raw;
    obj = JSON.parse(text);
  } catch (e) {
    return null; // invalid UTF-8 (TypeError) or invalid JSON (SyntaxError)
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  if (obj.schema_version !== SCHEMA_VERSION || obj.activity_id !== expectedActivityId) return null;
  try {
    _validate(obj); // FULL v1 shape validation, same function buildRecord uses
  } catch (e) {
    if (e instanceof InvalidRecord) return null;
    throw e;
  }
  return obj;
}

module.exports = {
  SCHEMA_VERSION, MAX_KEYS, MAX_KEY_BYTES, MAX_VALUE_BYTES, MAX_FIELDS_BYTES,
  MAX_DETAIL_BYTES, MAX_RECORD_BYTES,
  RecordTooLarge, InvalidRecord,
  buildRecord, encodeRecord, encodedLen, parseValid, decodeUtf8Fatal: _decodeUtf8Fatal,
};
