"""THE single trusted scan of an activity's segment directory (Ruling 38 / Codex R3 B2-B4).

`scan_activity(home, aid) -> Scan` is the ONE filesystem pass that every lifecycle, classify
and reconcile decision derives from -- `quota._scan` is a thin alias of it, and
`reconcile.synthesize_terminal` re-runs it UNDER the owner lease before deciding the synthetic
outcome. It is a LEAF module: it imports only `paths`, `records` and `ids`, never `quota` or
`reconcile` (both of which import it), so the two consumers can never disagree about what was
actually readable, parseable, or cancel-requested.

Its finding/acceptance rules are the shared cross-language contract with
`menubar/activity/parse.js` (`parseSegment`) and are pinned by the scan-GENERATION parity
fixture `repo_radar/tests/data/scan_vectors.json` (Ruling 44), which both test suites drive:

  * Only CONFORMING segment names (`paths.parse_segment_name` non-None) are ever parsed. Any
    other `*.jsonl` entry is surfaced as `rejected {name, reason: 'bad-name'}` and its bytes are
    never looked at -- so a `junk.jsonl` carrying a "valid" `control{cancel_requested}` can never
    drive a synthetic `cancelled` (Codex R3 B3).
  * Trailing-line contract (Ruling 41): each segment is split on b"\\n"; the final remainder
    (the element after the last newline) is IGNORED whenever the buffer does not end with a
    newline -- EVEN IF it happens to be valid JSON. The durability contract is record+newline;
    a missing newline is a torn write, not a record and not a finding. Empty lines are skipped.
  * Findings (canonical kinds, exact strings): an interior non-empty line that fails
    `records.parse_valid` is `{"kind": "corrupt-record"}`, except that a line which parses as a
    JSON object whose `schema_version` is not 1 (mirroring parse.js's `obj.schema_version !== 1`,
    which also covers a MISSING schema_version) is `{"kind": "unsupported-schema"}`.
  * seq-regression (Ruling 42): per segment, over ACCEPTED records, `last_seq` starts at -1 and
    tracks the most recently accepted record's own `seq` (NOT a running max); an accepted record
    with `seq <= last_seq` yields `{"kind": "seq-regression"}` and is STILL accepted. Reset per
    segment, so two segments that each restart at 0 are not a regression.
  * `cancel_requested` is True iff any ACCEPTED `control` record has `name == "cancel_requested"`.
"""
import json, os
from dataclasses import dataclass
from repo_radar.activity import paths, records, ids  # noqa: F401  (ids: leaf-contract import set)

CORRUPT_RECORD = "corrupt-record"
UNSUPPORTED_SCHEMA = "unsupported-schema"
SEQ_REGRESSION = "seq-regression"

@dataclass
class Scan:
    records: list                  # valid parsed top-level v1 records, in segment-then-line order
    findings: list                 # [{"kind": "corrupt-record" | "unsupported-schema" | "seq-regression"}, ...]
    rejected: list                 # [{"name": str, "reason": str}, ...] -- unreadable/unsafe/bad-name
    view_uncertain: bool           # True => the view may be missing a real record; PRESERVE, never guess
    mtime: float = 0.0             # newest mtime among the readable conforming segments (0.0 if none)
    cancel_requested: bool = False # any accepted `control` record named "cancel_requested"

_UNSUPPORTED = object()     # sentinel: line is a JSON object, but schema_version != 1

def _classify_line(line, aid):
    """Best-effort per-line classification for the structural `findings` pass -- NOT a security
    boundary; the actual v1 admission verdict is always `records.parse_valid`, called below
    regardless. Returns a valid record dict, `_UNSUPPORTED`, or `None` (any other rejection:
    malformed JSON, non-dict JSON, wrong activity_id, missing/invalid fields, bad enum, ...).

    Ruling 51 (Codex R5-2, BLOCKER): `line` is decoded STRICT UTF-8 (never `utf-8-sig`) BEFORE any
    JSON probe, including the unsupported-schema detection below -- `json.loads(bytes)` otherwise
    auto-detects UTF-16/32 and silently accepts/strips a BOM, so a UTF-16LE- or BOM-prefixed line
    could parse as a well-formed `{"schema_version": 1, ...}` object here and get misclassified as
    a valid record (or, for a non-1 schema_version, `unsupported-schema`) instead of the
    `corrupt-record` both this line and Node's reader must agree on. A decode failure is corrupt,
    full stop, never routed through the schema-version probe."""
    try:
        text = line.decode("utf-8", "strict")
    except UnicodeDecodeError:
        return None
    try:
        obj = json.loads(text, parse_constant=lambda _c: (_ for _ in ()).throw(ValueError("non-finite")))
    except Exception:
        obj = None
    if isinstance(obj, dict) and obj.get("schema_version") != records.SCHEMA_VERSION:
        return _UNSUPPORTED
    return records.parse_valid(text, aid)

def parse_segment_bytes(data, aid):
    """Pure per-segment parser (the Python mirror of parse.js `parseSegment`): raw segment bytes
    in, `(accepted_records, findings)` out, applying the trailing-line, finding and seq rules
    documented in the module header. No filesystem access."""
    out, findings = [], []
    lines = data.split(b"\n")
    # The LAST split element is the remainder after the final b"\n": empty when the buffer ends
    # with a newline, otherwise a torn/partial write. Either way it is never classified.
    last_seq = -1
    for line in lines[:-1]:
        if not line:
            continue
        classified = _classify_line(line, aid)
        if classified is _UNSUPPORTED:
            findings.append({"kind": UNSUPPORTED_SCHEMA})
            continue
        if classified is None:
            findings.append({"kind": CORRUPT_RECORD})
            continue
        seq = classified.get("seq")
        if isinstance(seq, int) and not isinstance(seq, bool):
            if seq <= last_seq:
                findings.append({"kind": SEQ_REGRESSION})
            last_seq = seq
        out.append(classified)         # accepted regardless of the seq check (mirrors parse.js)
    return out, findings

def _dir_provably_gone(directory):
    """True iff `directory` (an activity dir) PROVABLY never existed -- FileNotFoundError, as
    opposed to existing but being unsafe to open (UnsafePath) or any other OSError, both of which
    must stay uncertain (preserve). Mirrors quota._owner_lock_absent's identical distinction."""
    try:
        fd = paths.open_owned_dir(directory)
    except FileNotFoundError:
        return True
    except (paths.UnsafePath, OSError):
        return False
    os.close(fd)
    return False

def scan_activity(home, aid):
    """THE single scan: one filesystem pass over an activity's segment directory -> `Scan`."""
    directory = paths.activity_dir(home, aid)
    segments, rejected_raw = paths.read_owned_segments_detailed(directory)
    rejected = [{"name": name, "reason": reason} for name, reason in rejected_raw]

    if any(r["reason"] == "dir-unreadable" for r in rejected) and _dir_provably_gone(directory):
        # The activity directory PROVABLY never existed (e.g. a ledger-only reserve-before-start
        # entry whose owner crashed before secure_mkdir ever ran) -- a DEFINITE "nothing here"
        # state, not "couldn't tell". A directory that EXISTS but is unsafe to open/list stays
        # genuinely uncertain below.
        rejected = []

    conforming = []
    for seg in segments:
        if paths.parse_segment_name(seg[0]) is not None:
            conforming.append(seg)
        else:
            # untrusted non-segment (`junk.jsonl`, `python-s3cr3t.jsonl`): never parsed, but
            # surfaced as `rejected` (problem-bearing R2-2); it can't have hidden a real
            # start/terminal, so it does NOT drive `view_uncertain`.
            rejected.append({"name": seg[0], "reason": "bad-name"})

    # view_uncertain: the directory itself couldn't be validated/listed, or some rejected entry's
    # NAME would parse as a conforming segment (i.e. really could carry a start/terminal).
    view_uncertain = any(
        r["reason"] == "dir-unreadable" or paths.parse_segment_name(r["name"]) is not None
        for r in rejected
    )

    records_out, findings, mtime = [], [], 0.0
    for name, data, _size, seg_mtime in conforming:
        mtime = max(mtime, seg_mtime)
        recs, finds = parse_segment_bytes(data, aid)
        records_out.extend(recs)
        findings.extend(finds)

    cancel = any(r.get("type") == "control" and r.get("name") == "cancel_requested"
                 for r in records_out)
    return Scan(records=records_out, findings=findings, rejected=rejected,
                view_uncertain=view_uncertain, mtime=mtime, cancel_requested=cancel)
