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
        accepted = R.parse_valid(json.dumps(case["raw"]), case["raw"]["activity_id"]) is not None
        assert accepted == case["accept"], case.get("why", case["raw"])

def test_parse_valid_rejects_non_finite_numbers():   # Round-6 #2 (Node JSON.parse parity)
    raw = ('{"schema_version":1,"activity_id":"%s","type":"event","seq":0,'
           '"ts":"2026-08-14T00:00:00-07:00","level":"info","event":"x","fields":{"v":Infinity}}') % AID
    assert R.parse_valid(raw, AID) is None
