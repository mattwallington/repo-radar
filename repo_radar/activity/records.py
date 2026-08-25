import json, math, re
from datetime import datetime, timezone

SCHEMA_VERSION = 1
# Ruling 48 (Codex R4 I4): the SHARED safe integer range for `seq`, 0..2^53-1
# (Number.MAX_SAFE_INTEGER). Node's `JSON.parse` silently ROUNDS any integer literal above this
# to the nearest representable double -- 9007199254740992 and 9007199254740993 both parse to the
# same JS number -- so two Python-distinct seqs on the wire would collide on the Node side,
# producing a spurious `seq-regression` finding Python never emits. Rejecting anything outside
# this range on BOTH sides (menubar/activity/records.js mirrors this exactly) keeps `seq`
# meaningful cross-language instead of silently losing precision past the boundary.
MAX_SAFE_SEQ = 9007199254740991
MAX_KEYS = 32
MAX_KEY_BYTES = 64
MAX_VALUE_BYTES = 1024
MAX_FIELDS_BYTES = 8192
MAX_DETAIL_BYTES = 8192
MAX_RECORD_BYTES = 20480

class RecordTooLarge(Exception):
    pass

class InvalidRecord(Exception):
    pass

_VALID_TYPES = {"start", "ownership", "event", "control", "terminal", "integrity"}
_VALID_LEVELS = {"info", "warn", "error"}
_VALID_ROLES = {"initial", "handoff"}
_VALID_OUTCOMES = {"succeeded", "succeeded-with-warnings", "blocked", "failed",
                   "cancelled", "skipped", "interrupted"}

_REQUIRED = {
    "start": ("kind", "channel", "trigger", "created_by"),
    "ownership": ("owner_token", "role", "producer", "pid", "boot_id", "proc_birth"),
    "event": ("level", "event"),
    "control": ("name",),
    "terminal": ("outcome", "summary", "by"),
    "integrity": ("kind",),
}

_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:\d{2}$")
_TOKEN_RE = re.compile(r"^[0-9a-f]{8}$")
_PRODUCERS = {"electron", "dispatcher", "python"}
_KINDS = {"sync", "system"}
# Canonical-integer-string field/summary keys ("0", "1", "42" -- NOT "01"/"1.0"/"x") are
# rejected outright rather than accepted (fix round 1): Python dicts preserve insertion order
# for such keys, but a JS plain object promotes them ahead of all other keys at
# object-CREATION time (before any of our code runs -- JSON.parse itself already reorders),
# so the two encoders would silently produce different bytes for the same logical record.
# Refusing the key class on both sides keeps them symmetric instead of letting this drift.
_INT_KEY_RE = re.compile(r"^(0|[1-9]\d*)$")

def _flat_primitive_map(m):
    """Codex gate round 1, finding 6: `1e400` is a REGULAR numeric literal that overflows
    float() to +-inf -- json.loads' `parse_constant` only intercepts the special
    Infinity/-Infinity/NaN TOKENS (Round-6 #2), not an ordinary literal that overflows during
    conversion, so a bare `isinstance(v, float)` check here previously accepted it. Reject any
    non-finite float leaf explicitly."""
    if not isinstance(m, dict):
        return False
    for k, v in m.items():
        if not isinstance(k, str):
            return False
        if isinstance(v, bool) or v is None or isinstance(v, (int, str)):
            continue
        if isinstance(v, float):
            if not math.isfinite(v):
                return False
            continue
        return False
    return True

def _validate(rec):
    """Complete v1 shape validation (Round-5 #3) — fixed-domain enums, token/producer syntax,
    seq >= 0, ISO-8601-with-offset ts, flat primitive maps, per-record field types. Unknown
    ADDITIVE fields are still ignored."""
    t = rec.get("type")
    if t not in _VALID_TYPES:
        raise InvalidRecord(f"type {t!r}")
    for k in _REQUIRED.get(t, ()):
        if k not in rec:
            raise InvalidRecord(f"missing {k!r} for {t}")
    seq = rec.get("seq")
    if isinstance(seq, bool) or not isinstance(seq, int) or seq < 0 or seq > MAX_SAFE_SEQ:
        raise InvalidRecord("seq")           # Ruling 48: shared 0..2^53-1 safe range
    if not isinstance(rec.get("ts"), str) or not _ISO_RE.fullmatch(rec["ts"]):
        raise InvalidRecord("ts")
    try:
        datetime.fromisoformat(rec["ts"])           # validate an ACTUAL timestamp, not just the shape
    except ValueError:
        raise InvalidRecord("ts")
    if t == "event":
        if rec.get("level") not in _VALID_LEVELS: raise InvalidRecord("level")
        if not isinstance(rec.get("event"), str): raise InvalidRecord("event")
        if not _flat_primitive_map(rec.get("fields", {})): raise InvalidRecord("fields")
        if rec.get("detail") is not None and not isinstance(rec["detail"], str): raise InvalidRecord("detail")
    elif t == "start":
        if rec.get("kind") not in _KINDS: raise InvalidRecord("kind")
        for k in ("channel", "trigger", "created_by"):
            if not isinstance(rec.get(k), str): raise InvalidRecord(k)
    elif t == "ownership":
        if rec.get("role") not in _VALID_ROLES: raise InvalidRecord("role")
        if not (isinstance(rec.get("owner_token"), str) and _TOKEN_RE.fullmatch(rec["owner_token"])):
            raise InvalidRecord("owner_token")
        if rec.get("producer") not in _PRODUCERS: raise InvalidRecord("producer")
        if isinstance(rec.get("pid"), bool) or not isinstance(rec.get("pid"), int): raise InvalidRecord("pid")
        if not isinstance(rec.get("boot_id"), str): raise InvalidRecord("boot_id")
        if not isinstance(rec.get("proc_birth"), str): raise InvalidRecord("proc_birth")
    elif t == "control":
        if not isinstance(rec.get("name"), str): raise InvalidRecord("name")
        if not _flat_primitive_map(rec.get("fields", {})): raise InvalidRecord("fields")
    elif t == "terminal":
        if rec.get("outcome") not in _VALID_OUTCOMES: raise InvalidRecord("outcome")
        if not _flat_primitive_map(rec.get("summary")): raise InvalidRecord("summary")
        by = rec.get("by")
        if not (by == "reconciler" or (isinstance(by, str) and _TOKEN_RE.fullmatch(by))):
            raise InvalidRecord("by")
    elif t == "integrity":
        if not isinstance(rec.get("kind"), str): raise InvalidRecord("kind")

def parse_valid(raw, expected_activity_id):
    """THE canonical validator (Round-4 #5): parse one JSONL line and return the dict ONLY if it
    is a SUPPORTED v1 record FOR the expected activity with valid base metadata, required fields,
    AND type-specific enums. Anything else → None. A stray/nested/foreign/malformed `terminal`
    (wrong outcome, wrong activity_id, unsupported schema, missing field) therefore never counts,
    so it cannot settle, finalize, or make an activity prunable.

    Ruling 51 (Codex R5-2, BLOCKER): `json.loads(bytes)` auto-detects UTF-16/32 and silently
    accepts (and strips) a leading UTF-8 BOM, per the JSON RFC's encoding-detection recommendation
    -- so a UTF-16LE- or BOM-prefixed terminal line was accepted by Python while Node's reader
    (fatal on non-UTF-8, and never BOM-aware) rejected the SAME bytes as `corrupt-record`. `raw`
    is decoded STRICT UTF-8 first when it's bytes (NOT `utf-8-sig`, which would strip a BOM and
    keep accepting it) -- a `UnicodeDecodeError` (any non-UTF-8 byte sequence, including UTF-16/32)
    is rejected outright. A `str` input already decoded elsewhere is used as-is: `json.loads` on a
    string with a literal leading U+FEFF (what strict UTF-8 decoding of a BOM-prefixed line leaves
    behind) already raises on its own, matching Node's BOM rejection without any extra check here."""
    if isinstance(raw, (bytes, bytearray)):
        try:
            raw = raw.decode("utf-8", "strict")
        except UnicodeDecodeError:
            return None
    try:
        # parse_constant rejects NaN/Infinity/-Infinity, which Python's json would otherwise
        # accept but Node's JSON.parse rejects — keeping the two parsers in agreement (Round-6 #2)
        obj = json.loads(raw, parse_constant=lambda _c: (_ for _ in ()).throw(ValueError("non-finite")))
    except Exception:
        return None
    if not isinstance(obj, dict):
        return None
    if type(obj.get("schema_version")) is not int or obj.get("schema_version") != SCHEMA_VERSION or obj.get("activity_id") != expected_activity_id:
        return None
    try:
        _validate(obj)                 # FULL v1 shape validation (Round-5 #3)
    except InvalidRecord:
        return None
    return obj

def _now_iso():
    return datetime.now(timezone.utc).astimezone().isoformat()

def _truncate(s: str, limit: int):
    b = s.encode("utf-8")
    if len(b) <= limit:
        return s, False
    marker = "…[truncated {} bytes]"
    # reserve room for the marker
    keep = b[: max(0, limit - len(marker.format(len(b)).encode()))]
    # avoid splitting a UTF-8 sequence
    kept = keep.decode("utf-8", "ignore")
    return kept + marker.format(len(b) - len(kept.encode())), True

def _bound_key(k):
    """Return (key, was_truncated) where key is byte-bounded at MAX_KEY_BYTES (not char-bounded).
    Rejects a canonical-integer-string key outright (fix round 1, cross-language byte-parity --
    see `_INT_KEY_RE`); no real producer uses one, this only forecloses a future silent drift."""
    original = str(k)
    if _INT_KEY_RE.fullmatch(original):
        raise InvalidRecord(f"numeric-like field key not allowed: {original!r}")
    b = original.encode("utf-8")
    if len(b) <= MAX_KEY_BYTES:
        return original, False
    truncated_key = b[:MAX_KEY_BYTES].decode("utf-8", "ignore")
    return truncated_key, True

def _canon(v):
    """Numeric canonicalization for cross-language byte equality (Round-3 #8): reject non-finite
    (JS JSON.parse can't read NaN/Infinity) and fold integral floats to int (Python `2.0`→`2`,
    matching JS `JSON.stringify(2.0)`==`"2"`)."""
    if isinstance(v, bool):
        return v
    if isinstance(v, float):
        if not math.isfinite(v):
            raise InvalidRecord("non-finite number")
        if v.is_integer():
            return int(v)
    return v

def _bound_fields(fields):
    """Bound fields/summary: max 32 keys, each key ≤64 bytes, each value ≤1 KiB, aggregate ≤8 KiB.
    Non-dict input or non-primitive values raise InvalidRecord. Truncation sets _truncated flag."""
    if not isinstance(fields, dict):
        raise InvalidRecord("fields must be a flat map")

    truncated = False
    out = {}
    for i, (k, v) in enumerate(fields.items()):
        if i >= MAX_KEYS:
            truncated = True
            break
        k, key_truncated = _bound_key(k)
        truncated = truncated or key_truncated

        if isinstance(v, str):
            v, t = _truncate(v, MAX_VALUE_BYTES)
            truncated = truncated or t
        elif isinstance(v, (int, float, bool)) or v is None:
            v = _canon(v)                            # integral floats -> int; non-finite -> reject
            # Per-value size check: even canonicalized numbers must fit in MAX_VALUE_BYTES
            if len(json.dumps(v, ensure_ascii=False).encode("utf-8")) > MAX_VALUE_BYTES:
                v, t = _truncate(str(v), MAX_VALUE_BYTES)
                truncated = truncated or t
        else:
            # Reject non-primitive values (nested dicts/lists, etc.)
            raise InvalidRecord("fields values must be flat primitives")
        out[k] = v

    # aggregate cap (use compact separators to match wire encoding)
    while len(json.dumps(out, ensure_ascii=False, separators=(",", ":")).encode()) > MAX_FIELDS_BYTES and out:
        out.pop(next(reversed(out)))
        truncated = True
    return out, truncated

def build(type, *, seq, activity_id, ts=None, **payload):
    rec = {"schema_version": SCHEMA_VERSION, "activity_id": activity_id,
           "type": type, "seq": seq, "ts": ts or _now_iso()}
    truncated = False
    for dictkey in ("fields", "summary"):        # summary is bounded like fields (finding 7)
        if dictkey in payload:
            payload[dictkey], t = _bound_fields(payload[dictkey]); truncated |= t
    if payload.get("detail") is not None:
        payload["detail"], t = _truncate(str(payload["detail"]), MAX_DETAIL_BYTES); truncated |= t
    rec.update(payload)
    if truncated:
        rec["_truncated"] = True
    _validate(rec)                               # enum validation (finding 7)
    if encoded_len(rec) > MAX_RECORD_BYTES:
        raise RecordTooLarge(f"{type} record exceeds {MAX_RECORD_BYTES} bytes")
    return rec

def encode(record) -> bytes:
    # allow_nan=False so any non-finite number raises here rather than emitting NaN/Infinity,
    # which JS JSON.parse rejects — preserving cross-language byte equality (Round-3 #8)
    return (json.dumps(record, ensure_ascii=False, separators=(",", ":"),
                       allow_nan=False) + "\n").encode("utf-8")

def encoded_len(record) -> int:
    return len(encode(record))
