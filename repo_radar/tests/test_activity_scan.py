"""Codex R3 (B1-B4): the shared trusted scan (`repo_radar.activity.scan`), its cross-language
scan-GENERATION parity fixture (`data/scan_vectors.json`, Ruling 44 -- the Node suite drives the
SAME file against `menubar/activity/parse.js`), the reconciler's cancel-from-trusted-view rule
(Ruling 41/42), and lstat-based quota accounting (Ruling 40)."""
import json, os, pathlib, time
import pytest
from repo_radar.activity import quota, paths, lease, ids, reconcile
from repo_radar.activity import scan as scan_mod

AID = "00000000-0000-4000-8000-000000000000"
TS = "2026-08-14T00:00:00-07:00"
VECTORS = json.loads((pathlib.Path(__file__).parent / "data" / "scan_vectors.json").read_text())

# --- helpers --------------------------------------------------------------------------------

def _mk(home, aid):
    paths.secure_mkdir(paths.activity_dir(home, aid))
    paths.secure_mkdir(paths.quota_dir(home))
    return paths.owner_lock_path(home, aid)

def _new_activity(home):
    aid = ids.mint_activity_id(); lp = _mk(home, aid)
    return aid, lease.acquire(lp)

def _line(aid, type, seq, **kw):
    d = {"schema_version": 1, "activity_id": aid, "type": type, "seq": seq, "ts": TS}
    d.update(kw)
    return json.dumps(d)

def _start_line(aid):
    return _line(aid, "start", 0, kind="sync", channel="stable", trigger="cli", created_by="python")

def _append_raw(home, aid, writer_id, text):
    """Append raw TEXT (caller controls the trailing newline) to a CONFORMING python segment."""
    seg = paths.segment_path(home, aid, "python", writer_id)
    fd = paths.secure_open_append(seg)
    try:
        os.write(fd, text.encode())
    finally:
        os.close(fd)
    return seg

def _terminal_outcomes(home, aid):
    return sorted((r["outcome"], r["by"]) for r in scan_mod.scan_activity(home, aid).records
                  if r["type"] == "terminal")

# --- Ruling 44: scan-generation parity fixture ----------------------------------------------

def test_scan_vectors_fixture_schema():
    # Contract the Node suite relies on: only conforming names, exact key set per case.
    assert VECTORS, "fixture must not be empty"
    for case in VECTORS:
        assert set(case) == {"name", "segments", "expected"}, case["name"]
        assert set(case["expected"]) == {"record_count", "types", "findings", "cancel_requested"}
        assert case["expected"]["types"] == sorted(set(case["expected"]["types"]))
        assert case["expected"]["findings"] == sorted(case["expected"]["findings"])
        for s in case["segments"]:
            assert set(s) == {"name", "text"}
            assert paths.parse_segment_name(s["name"]) is not None, (case["name"], s["name"])

@pytest.mark.parametrize("case", VECTORS, ids=[c["name"] for c in VECTORS])
def test_scan_vectors(tmp_path, case):
    _mk(tmp_path, AID)
    d = paths.activity_dir(tmp_path, AID)
    for s in case["segments"]:
        (d / s["name"]).write_bytes(s["text"].encode())
    try:
        scan = scan_mod.scan_activity(tmp_path, AID)
        exp = case["expected"]
        assert scan.view_uncertain is False and scan.rejected == []
        assert len(scan.records) == exp["record_count"], case["name"]
        assert sorted({r["type"] for r in scan.records}) == exp["types"], case["name"]
        assert sorted(f["kind"] for f in scan.findings) == exp["findings"], case["name"]
        assert scan.cancel_requested is exp["cancel_requested"], case["name"]
    finally:
        paths.unlink_owned_tree(d)

# --- Ruling 41/42: the scan contract, directly ----------------------------------------------

def test_scan_ignores_trailing_valid_json_without_newline_even_a_terminal(tmp_path):
    aid = ids.mint_activity_id(); _mk(tmp_path, aid)
    _append_raw(tmp_path, aid, "deadbeef", _start_line(aid) + "\n" +
                _line(aid, "terminal", 1, outcome="succeeded", summary={}, by="deadbeef"))  # torn
    scan = scan_mod.scan_activity(tmp_path, aid)
    assert [r["type"] for r in scan.records] == ["start"]
    assert scan.findings == []                      # a torn write is not a finding

def test_scan_seq_regression_uses_last_accepted_seq_not_running_max(tmp_path):
    # 0, 5, 3, 4: parse.js flags 3 (3 <= 5) but NOT 4 (4 > 3, the last accepted seq) -- exactly
    # one finding, all four records accepted.
    aid = ids.mint_activity_id(); _mk(tmp_path, aid)
    text = "\n".join([_start_line(aid),
                      _line(aid, "event", 5, level="info", event="a", fields={}),
                      _line(aid, "event", 3, level="info", event="b", fields={}),
                      _line(aid, "event", 4, level="info", event="c", fields={})]) + "\n"
    _append_raw(tmp_path, aid, "deadbeef", text)
    scan = scan_mod.scan_activity(tmp_path, aid)
    assert len(scan.records) == 4
    assert [f["kind"] for f in scan.findings] == ["seq-regression"]

def test_scan_seq_tracking_resets_per_segment(tmp_path):
    aid = ids.mint_activity_id(); _mk(tmp_path, aid)
    _append_raw(tmp_path, aid, "deadbeef", _start_line(aid) + "\n")
    _append_raw(tmp_path, aid, "cafebabe",
                _line(aid, "event", 0, level="info", event="a", fields={}) + "\n")
    assert scan_mod.scan_activity(tmp_path, aid).findings == []

def test_scan_unsupported_schema_finding_and_missing_schema_version(tmp_path):
    # mirrors parse.js: a JSON OBJECT with schema_version !== 1 (including MISSING) is
    # `unsupported-schema`; non-object JSON / unparseable JSON is `corrupt-record`.
    aid = ids.mint_activity_id(); _mk(tmp_path, aid)
    v2 = json.dumps({"schema_version": 2, "activity_id": aid, "type": "event", "seq": 1,
                     "ts": TS, "level": "info", "event": "x", "fields": {}})
    missing = json.dumps({"activity_id": aid, "type": "event", "seq": 2, "ts": TS})
    _append_raw(tmp_path, aid, "deadbeef",
                "\n".join([_start_line(aid), v2, missing, "[1,2]", "garbage"]) + "\n")
    scan = scan_mod.scan_activity(tmp_path, aid)
    assert [r["type"] for r in scan.records] == ["start"]
    assert sorted(f["kind"] for f in scan.findings) == \
        ["corrupt-record", "corrupt-record", "unsupported-schema", "unsupported-schema"]

def test_scan_cancel_requested_only_from_accepted_records(tmp_path):
    aid = ids.mint_activity_id(); _mk(tmp_path, aid)
    _append_raw(tmp_path, aid, "deadbeef", _start_line(aid) + "\n")
    (paths.activity_dir(tmp_path, aid) / "junk.jsonl").write_text(
        _line(aid, "control", 1, name="cancel_requested") + "\n")
    scan = scan_mod.scan_activity(tmp_path, aid)
    assert scan.cancel_requested is False
    assert scan.rejected == [{"name": "junk.jsonl", "reason": "bad-name"}]
    assert scan.view_uncertain is False

def test_quota_scan_is_the_shared_scan():
    assert quota.Scan is scan_mod.Scan
    assert quota._scan.__module__ == "repo_radar.activity.quota"   # thin wrapper, patchable
    assert reconcile.scan_mod is scan_mod

# --- R3-3: reconcile decides cancel/interrupted from the TRUSTED view only ------------------

def test_reconcile_ignores_cancel_in_bad_named_file_synthesizes_interrupted(tmp_path):
    # (a) Codex repro: `junk.jsonl` holding a VALID control{cancel_requested} previously made
    # the reconciler synthesize a durable `cancelled`. Node never trusted that file; now neither
    # does Python -- outcome is `interrupted`.
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l)
    _append_raw(tmp_path, aid, "deadbeef", _start_line(aid) + "\n")
    (paths.activity_dir(tmp_path, aid) / "junk.jsonl").write_text(
        _line(aid, "control", 1, name="cancel_requested") + "\n")
    l.release()
    quota.reconcile(tmp_path)
    assert _terminal_outcomes(tmp_path, aid) == [("interrupted", "reconciler")]
    assert not paths.ledger_entry_path(tmp_path, aid).exists()      # settled

def test_reconcile_treats_torn_trailing_terminal_as_absent_synthesizes_interrupted(tmp_path):
    # (b) A conforming segment whose `succeeded` terminal lacks its trailing newline is a torn
    # write (Ruling 41): NOT a terminal. Python synthesizes `interrupted`; Node's parseSegment now
    # applies the same trailing-line contract (a trailing valid-JSON line is ignored, not parsed),
    # see data/scan_vectors.json "trailing VALID-JSON terminal without final newline".
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l)
    _append_raw(tmp_path, aid, "deadbeef", _start_line(aid) + "\n" +
                _line(aid, "terminal", 1, outcome="succeeded", summary={}, by="deadbeef"))
    l.release()
    quota.reconcile(tmp_path)
    assert _terminal_outcomes(tmp_path, aid) == [("interrupted", "reconciler")]
    assert not paths.ledger_entry_path(tmp_path, aid).exists()

def test_reconcile_synthesizes_cancelled_from_accepted_control_in_conforming_segment(tmp_path):
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l)
    _append_raw(tmp_path, aid, "deadbeef", _start_line(aid) + "\n" +
                _line(aid, "control", 1, name="cancel_requested") + "\n")
    l.release()
    quota.reconcile(tmp_path)
    assert _terminal_outcomes(tmp_path, aid) == [("cancelled", "reconciler")]

def test_synthesize_terminal_writes_nothing_without_start_or_with_terminal(tmp_path):
    # the trusted under-lease view gates the write on its own, gate=None.
    aid, l = _new_activity(tmp_path)
    l.release()
    assert reconcile.synthesize_terminal(tmp_path, aid) is False    # no start
    assert scan_mod.scan_activity(tmp_path, aid).records == []
    _append_raw(tmp_path, aid, "deadbeef", _start_line(aid) + "\n" +
                _line(aid, "terminal", 1, outcome="succeeded", summary={}, by="deadbeef") + "\n")
    assert reconcile.synthesize_terminal(tmp_path, aid) is False    # already terminated
    assert _terminal_outcomes(tmp_path, aid) == [("succeeded", "deadbeef")]
    fresh = lease.acquire(paths.owner_lock_path(tmp_path, aid))      # lease released either way
    assert fresh is not None; fresh.release()

# --- (c)/(d): findings feed retention through _classify -------------------------------------

def test_seq_regression_makes_succeeded_activity_problem_bearing_kept_at_20d(tmp_path, monkeypatch):
    # (c) start seq=0, info event seq=0, terminal seq=1 -> `seq-regression` finding -> problem.
    # 20d is past the 14d ROUTINE rule (would be pruned) but under the 90d PROBLEM rule -> kept.
    monkeypatch.setattr(quota, "NEWEST_KEEP", 0)
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l)
    seg = _append_raw(tmp_path, aid, "deadbeef", "\n".join([
        _start_line(aid),
        _line(aid, "event", 0, level="info", event="x", fields={}),        # seq 0 again
        _line(aid, "terminal", 1, outcome="succeeded", summary={}, by="deadbeef")]) + "\n")
    l.release(); quota.settle(tmp_path, aid)
    old = time.time() - 20 * 86400; os.utime(seg, (old, old))
    assert [f["kind"] for f in scan_mod.scan_activity(tmp_path, aid).findings] == ["seq-regression"]
    assert quota._classify(tmp_path, aid)[0] == "problem"
    quota.retain(tmp_path)
    assert paths.activity_dir(tmp_path, aid).exists()                 # 20d < 90d problem rule

def test_unsupported_schema_makes_succeeded_activity_problem_bearing_kept_at_20d(tmp_path, monkeypatch):
    monkeypatch.setattr(quota, "NEWEST_KEEP", 0)
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l)
    v2 = json.dumps({"schema_version": 2, "activity_id": aid, "type": "event", "seq": 1,
                     "ts": TS, "level": "info", "event": "x", "fields": {}})
    seg = _append_raw(tmp_path, aid, "deadbeef", "\n".join([
        _start_line(aid), v2,
        _line(aid, "terminal", 2, outcome="succeeded", summary={}, by="deadbeef")]) + "\n")
    l.release(); quota.settle(tmp_path, aid)
    old = time.time() - 20 * 86400; os.utime(seg, (old, old))
    assert [f["kind"] for f in scan_mod.scan_activity(tmp_path, aid).findings] == ["unsupported-schema"]
    assert quota._classify(tmp_path, aid)[0] == "problem"
    quota.retain(tmp_path)
    assert paths.activity_dir(tmp_path, aid).exists()

# --- R3-1 / Ruling 40: lstat-based accounting never drops an unreadable regular segment ------

def test_charge_counts_permission_denied_segment_and_skips_symlink(tmp_path):
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l)
    seg = _append_raw(tmp_path, aid, "deadbeef", _start_line(aid) + "\n" +
                      _line(aid, "terminal", 1, outcome="succeeded", summary={}, by="deadbeef") + "\n")
    with open(seg, "ab") as f:
        f.write(b"#" * (1024 * 1024))                     # pad to > 1 MiB (trailing, torn -- fine)
    size = os.stat(seg).st_size
    assert size > 1024 * 1024
    l.release(); quota.settle(tmp_path, aid)              # settled: bytes counted purely by scan
    assert quota._charge(tmp_path) == size
    os.chmod(seg, 0o000)
    try:
        assert quota._charge(tmp_path) == size            # still counted (Codex: was 0)
        assert quota._on_disk(tmp_path, aid) == size
        outside = tmp_path / "outside.jsonl"; outside.write_bytes(b"x" * 4096)
        os.symlink(outside, paths.activity_dir(tmp_path, aid) / "python-cafebabe.jsonl")
        assert quota._charge(tmp_path) == size            # symlink never counted
        assert dict(paths.stat_owned_segments(paths.activity_dir(tmp_path, aid))) == \
            {"python-deadbeef.jsonl": size}
    finally:
        os.chmod(seg, 0o600)                              # restore perms before teardown
