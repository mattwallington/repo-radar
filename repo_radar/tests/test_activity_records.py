import json, pytest
from repo_radar.activity import records as R

AID = "00000000-0000-4000-8000-000000000000"

def test_build_and_encode_roundtrip():
    rec = R.build("event", seq=0, activity_id=AID, level="info",
                  event="repos_loaded", fields={"count": 30})
    line = R.encode(rec)
    assert line.endswith(b"\n") and line.count(b"\n") == 1
    back = json.loads(line)
    assert back["schema_version"] == R.SCHEMA_VERSION
    assert back["type"] == "event" and back["seq"] == 0 and back["activity_id"] == AID
    assert back["fields"]["count"] == 30
    assert R.encoded_len(rec) == len(line)

def test_detail_over_8kib_is_truncated_with_marker():
    rec = R.build("event", seq=1, activity_id=AID, level="error",
                  event="pull_failed", fields={}, detail="x" * 20000)
    assert rec["_truncated"] is True
    assert rec["detail"].encode("utf-8").__len__() <= R.MAX_DETAIL_BYTES
    assert "truncated" in rec["detail"]

def test_too_many_or_too_long_fields_are_bounded():
    rec = R.build("event", seq=2, activity_id=AID, level="info", event="x",
                  fields={f"k{i}": i for i in range(100)})
    assert len(rec["fields"]) <= R.MAX_KEYS
    big = R.build("event", seq=3, activity_id=AID, level="info", event="x",
                  fields={"v": "y" * 5000})
    assert len(json.dumps(big["fields"]).encode()) <= R.MAX_FIELDS_BYTES

def test_reserved_record_stays_under_20kib_including_newline():
    rec = R.build("terminal", seq=9, activity_id=AID, outcome="failed",
                  summary={"repos_changed": 0, "errors": 1, "warns": 0}, by="deadbeef")
    assert R.encoded_len(rec) <= R.MAX_RECORD_BYTES

def test_key_is_byte_bounded_not_char_bounded():
    rec = R.build("event", seq=4, activity_id=AID, level="info", event="x",
                  fields={"é" * 100: 1})            # 2 bytes per char in UTF-8
    key = next(iter(rec["fields"]))
    assert len(key.encode("utf-8")) <= R.MAX_KEY_BYTES

def test_terminal_summary_is_bounded_like_fields():
    rec = R.build("terminal", seq=5, activity_id=AID, outcome="failed",
                  summary={f"k{i}": "z" * 4000 for i in range(50)}, by="deadbeef")
    import json
    assert len(json.dumps(rec["summary"]).encode()) <= R.MAX_FIELDS_BYTES
    assert R.encoded_len(rec) <= R.MAX_RECORD_BYTES

def test_ts_override_is_deterministic():
    rec = R.build("event", seq=0, activity_id=AID, ts="2026-08-14T00:00:00-07:00",
                  level="info", event="x", fields={})
    assert rec["ts"] == "2026-08-14T00:00:00-07:00"

def test_invalid_enums_are_rejected():
    with pytest.raises(R.InvalidRecord): R.build("bogus", seq=0, activity_id=AID)
    with pytest.raises(R.InvalidRecord):
        R.build("event", seq=0, activity_id=AID, level="loud", event="x", fields={})
    with pytest.raises(R.InvalidRecord):
        R.build("terminal", seq=0, activity_id=AID, outcome="ok", summary={}, by="x")
    with pytest.raises(R.InvalidRecord):
        R.build("ownership", seq=0, activity_id=AID, role="boss", owner_token="x", producer="p")

def test_missing_required_field_is_rejected():
    with pytest.raises(R.InvalidRecord):
        R.build("terminal", seq=0, activity_id=AID, outcome="succeeded")   # missing summary + by
    with pytest.raises(R.InvalidRecord):
        R.build("start", seq=0, activity_id=AID, kind="sync")              # missing channel/trigger/created_by

def test_non_finite_number_is_rejected():
    with pytest.raises(R.InvalidRecord):
        R.build("event", seq=0, activity_id=AID, level="info", event="x", fields={"v": float("inf")})

def test_integral_float_canonicalizes_to_int():
    rec = R.build("event", seq=0, activity_id=AID, level="info", event="x", fields={"v": 2.0})
    assert rec["fields"]["v"] == 2 and isinstance(rec["fields"]["v"], int)

def test_build_rejects_malformed_shape():
    with pytest.raises(R.InvalidRecord):   # negative seq
        R.build("event", seq=-1, activity_id=AID, level="info", event="x", fields={})
    with pytest.raises(R.InvalidRecord):   # non-ISO ts (no offset)
        R.build("event", seq=0, activity_id=AID, ts="2026-08-14 00:00:00", level="info", event="x", fields={})
    with pytest.raises(R.InvalidRecord):   # bad `by` token
        R.build("terminal", seq=0, activity_id=AID, outcome="succeeded", summary={}, by="NOTHEX!!")
    with pytest.raises(R.InvalidRecord):   # bad producer
        R.build("ownership", seq=0, activity_id=AID, role="initial", owner_token="deadbeef", producer="evil")

def test_shared_validation_vectors():      # Round-5 #3: same accept/reject cases both languages
    import json, pathlib
    V = pathlib.Path(__file__).parent / "data" / "record_validation_vectors.json"
    for case in json.loads(V.read_text()):
        # G5-Node2: a case whose whole point is a JSON literal's exact spelling (e.g. `seq: 1.0`
        # vs `1`) can't be represented via `raw` -- re-serializing a *parsed* object loses that
        # distinction on the Node side (JS has no int/float split, so JSON.stringify(1.0) === "1"
        # is indistinguishable from a real integer). `raw_text` carries the literal JSON line text
        # verbatim instead, so both languages' parsers see the exact same source bytes.
        if "raw_text" in case:
            raw_text = case["raw_text"]
            activity_id = json.loads(raw_text)["activity_id"]
            accepted = R.parse_valid(raw_text, activity_id) is not None
        else:
            accepted = R.parse_valid(json.dumps(case["raw"]), case["raw"]["activity_id"]) is not None
        assert accepted == case["accept"], case.get("why", case.get("raw", case.get("raw_text")))

def test_parse_valid_rejects_non_finite_numbers():   # Round-6 #2 (Node JSON.parse parity)
    raw = ('{"schema_version":1,"activity_id":"%s","type":"event","seq":0,'
           '"ts":"2026-08-14T00:00:00-07:00","level":"info","event":"x","fields":{"v":Infinity}}') % AID
    assert R.parse_valid(raw, AID) is None

def test_numeric_field_over_1kib_is_truncated():
    """A 2000-digit integer exceeds MAX_VALUE_BYTES=1024 and should be truncated to a string."""
    big_num = 10 ** 2000  # 2001-digit number
    rec = R.build("event", seq=0, activity_id=AID, level="info", event="x",
                  fields={"huge": big_num})
    assert rec["_truncated"] is True
    # The value is truncated to a string and its raw UTF-8 encoding should fit
    raw_val = rec["fields"]["huge"].encode("utf-8")
    assert len(raw_val) <= R.MAX_VALUE_BYTES
    assert "truncated" in rec["fields"]["huge"]

def test_byte_truncated_key_sets_truncated_flag():
    """A key that exceeds MAX_KEY_BYTES should truncate and set _truncated=True."""
    long_key = "k" * 100  # 100 chars = 100 bytes, exceeds MAX_KEY_BYTES=64
    rec = R.build("event", seq=0, activity_id=AID, level="info", event="x",
                  fields={long_key: "value"})
    assert rec["_truncated"] is True
    actual_key = next(iter(rec["fields"]))
    assert len(actual_key.encode("utf-8")) <= R.MAX_KEY_BYTES

# --- Codex gate round 1, Finding 6 (IMPORTANT before Node mirror): reject non-finite floats
# from JSON overflow (not just the literal Infinity/-Infinity/NaN tokens) -------------------

def test_parse_valid_rejects_json_overflow_to_infinite():
    # `1e400` is a REGULAR numeric literal (unlike the special Infinity/-Infinity/NaN tokens
    # json.loads' parse_constant already rejects) that overflows float() to +-inf; json.loads
    # accepts it silently, and pre-fix _flat_primitive_map only checked `isinstance(v, float)`
    # with no math.isfinite check, so a terminal with summary.x == inf was accepted.
    #
    # A raw JSON string is used deliberately: build()+encode() would re-serialize inf as the
    # literal "Infinity" token (json.dumps' allow_nan behavior), which is a DIFFERENT code path
    # (Round-6 #2, already covered by test_parse_valid_rejects_non_finite_numbers above) and
    # would mask this overflow-specific defect entirely.
    for lit in ("1e400", "-1e400"):
        raw = ('{"schema_version":1,"activity_id":"%s","type":"event","seq":0,'
               '"ts":"2026-08-14T00:00:00-07:00","level":"info","event":"x",'
               '"fields":{"v":%s}}') % (AID, lit)
        assert R.parse_valid(raw, AID) is None, f"{lit} was accepted"

def test_parse_valid_rejects_json_overflow_nested_in_terminal_summary():
    raw = ('{"schema_version":1,"activity_id":"%s","type":"terminal","seq":9,'
           '"ts":"2026-08-14T00:00:00-07:00","outcome":"succeeded",'
           '"summary":{"x":1e400},"by":"deadbeef"}') % AID
    assert R.parse_valid(raw, AID) is None

def test_build_rejects_non_dict_fields():
    """Passing fields=5 (non-dict) should raise InvalidRecord, not crash."""
    with pytest.raises(R.InvalidRecord):
        R.build("event", seq=0, activity_id=AID, level="info", event="x", fields=5)

def test_parse_valid_rejects_utf8_bom_prefixed_bytes():   # Ruling 51 (Codex R5-2, BLOCKER)
    raw = ('{"schema_version":1,"activity_id":"%s","type":"terminal","seq":9,'
           '"ts":"2026-08-14T00:00:00-07:00","outcome":"succeeded","summary":{},'
           '"by":"deadbeef"}') % AID
    assert R.parse_valid(raw.encode("utf-8"), AID) is not None          # plain UTF-8: unchanged
    bom_prefixed = b"\xef\xbb\xbf" + raw.encode("utf-8")
    assert R.parse_valid(bom_prefixed, AID) is None                     # BOM-prefixed: rejected

def test_parse_valid_rejects_utf16le_encoded_bytes():      # Ruling 51 (Codex R5-2, BLOCKER)
    raw = ('{"schema_version":1,"activity_id":"%s","type":"terminal","seq":9,'
           '"ts":"2026-08-14T00:00:00-07:00","outcome":"succeeded","summary":{},'
           '"by":"deadbeef"}') % AID
    assert R.parse_valid(raw.encode("utf-16-le"), AID) is None

def test_build_rejects_nested_field_values():
    """Nested dicts/lists in fields should raise InvalidRecord (not stringify)."""
    with pytest.raises(R.InvalidRecord):
        R.build("event", seq=0, activity_id=AID, level="info", event="x",
                fields={"a": {"b": 1}})
    with pytest.raises(R.InvalidRecord):
        R.build("event", seq=0, activity_id=AID, level="info", event="x",
                fields={"a": [1, 2, 3]})
