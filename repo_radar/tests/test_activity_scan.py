"""Codex R3 (B1-B4): the shared trusted scan (`repo_radar.activity.scan`), its cross-language
scan-GENERATION parity fixture (`data/scan_vectors.json`, Ruling 44 -- the Node suite drives the
SAME file against `menubar/activity/parse.js`), the reconciler's cancel-from-trusted-view rule
(Ruling 41/42), and lstat-based quota accounting (Ruling 40).

Ruling 47 (Codex R4 B3): a fixture segment carries EXACTLY ONE of `"text"` (a UTF-8-safe JSON
string, the original shape) or `"bytes_b64"` (base64 of arbitrary RAW bytes, e.g. invalid UTF-8
that couldn't survive being embedded as a JSON string literal in the fixture file itself, which
must stay valid UTF-8 JSON). See `_segment_bytes` below."""
import base64, json, os, pathlib, time
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

def _segment_bytes(s):
    """Ruling 47 (Codex R4 B3): a segment carries exactly one of `"text"` (encode as UTF-8) or
    `"bytes_b64"` (base64 of raw bytes, possibly invalid UTF-8 -- the ONLY way to get an
    unrepresentable byte sequence into a fixture file that must itself stay valid UTF-8 JSON)."""
    if "bytes_b64" in s:
        return base64.b64decode(s["bytes_b64"])
    return s["text"].encode()

def test_scan_vectors_fixture_schema():
    # Contract the Node suite relies on: only conforming names, exact key set per case.
    assert VECTORS, "fixture must not be empty"
    for case in VECTORS:
        assert set(case) == {"name", "segments", "expected"}, case["name"]
        assert set(case["expected"]) == {"record_count", "types", "findings", "cancel_requested"}
        assert case["expected"]["types"] == sorted(set(case["expected"]["types"]))
        assert case["expected"]["findings"] == sorted(case["expected"]["findings"])
        for s in case["segments"]:
            assert set(s) == {"name", "text"} or set(s) == {"name", "bytes_b64"}, (case["name"], s)
            assert paths.parse_segment_name(s["name"]) is not None, (case["name"], s["name"])

@pytest.mark.parametrize("case", VECTORS, ids=[c["name"] for c in VECTORS])
def test_scan_vectors(tmp_path, case):
    _mk(tmp_path, AID)
    d = paths.activity_dir(tmp_path, AID)
    for s in case["segments"]:
        (d / s["name"]).write_bytes(_segment_bytes(s))
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

def test_scan_parse_segment_bytes_classifies_invalid_utf8_line_as_corrupt_record():
    # Ruling 47 (Codex R4 B3, BLOCKER fixture half): Node's `parseSegment` currently decodes with
    # lossy `toString('utf8')` (the Node agent is making it fatal, mirroring this). Python's
    # `json.loads(bytes)` already raises UnicodeDecodeError on an invalid byte -- `_classify_line`
    # catches that as any other unparseable line -> `corrupt-record`, never silently substituting
    # a replacement character. Directly exercises `parse_segment_bytes` (no filesystem needed),
    # per Codex's explicit ask, on top of the shared `scan_vectors.json` "invalid-utf8-terminal-
    # line" case (Ruling 47) that `test_scan_vectors` above already drives end to end.
    aid = ids.mint_activity_id()
    terminal_bytes = _line(aid, "terminal", 1, outcome="succeeded", summary={}, by="deadbeef").encode()
    bad_terminal_bytes = terminal_bytes[:1] + b"\xff" + terminal_bytes[1:]   # invalid UTF-8 start byte
    with pytest.raises(UnicodeDecodeError):
        bad_terminal_bytes.decode("utf-8")                                   # sanity: genuinely invalid
    data = _start_line(aid).encode() + b"\n" + bad_terminal_bytes + b"\n"
    records_out, findings = scan_mod.parse_segment_bytes(data, aid)
    assert [r["type"] for r in records_out] == ["start"]
    assert findings == [{"kind": scan_mod.CORRUPT_RECORD}]

def test_classify_line_rejects_non_integer_schema_version_literals():
    # Ruling 57 (Codex R6-5, IMPORTANT): `obj.get("schema_version") != SCHEMA_VERSION` alone lets
    # Python's `True == 1` slip a bool `schema_version` through as though it were the int 1 --
    # falling through to `records.parse_valid` (-> corrupt-record) instead of the shared
    # `unsupported-schema` verdict Node emits for it. The rule is type-strict: not EXACTLY the
    # integer 1 (bool, float, string, any other int, or missing) -> _UNSUPPORTED, always.
    aid = ids.mint_activity_id()
    terminal_fields = ('"activity_id": "%s", "type": "terminal", "seq": 1, '
                       '"ts": "%s", "outcome": "succeeded", "summary": {}, "by": "deadbeef"') % (aid, TS)
    for literal in ("true", "1.0", '"1"', "2"):
        line = ('{"schema_version": %s, %s}' % (literal, terminal_fields)).encode()
        assert scan_mod._classify_line(line, aid) is scan_mod._UNSUPPORTED, literal
    # sanity: the real integer 1 is still accepted (a valid record, not _UNSUPPORTED/None)
    ok_line = ('{"schema_version": 1, %s}' % terminal_fields).encode()
    assert scan_mod._classify_line(ok_line, aid) not in (scan_mod._UNSUPPORTED, None)

def test_classify_line_missing_schema_version_is_still_unsupported():
    aid = ids.mint_activity_id()
    line = ('{"activity_id": "%s", "type": "event", "seq": 0, "ts": "%s", '
           '"level": "info", "event": "x", "fields": {}}' % (aid, TS)).encode()
    assert scan_mod._classify_line(line, aid) is scan_mod._UNSUPPORTED

def test_scan_parse_segment_bytes_classifies_bom_and_utf16_lines_as_corrupt_never_unsupported():
    # Ruling 51 (Codex R5-2, BLOCKER): `json.loads(bytes)` auto-detects UTF-16/32 and silently
    # accepts/strips a leading UTF-8 BOM -- so a BOM-prefixed or UTF-16LE-encoded line used to
    # parse as a well-formed `{"schema_version": 1, ...}` object here (Python accepted it while
    # Node's reader rejected the SAME bytes). `_classify_line` must decode STRICT UTF-8 BEFORE any
    # JSON probe, including the unsupported-schema check, so these are always `corrupt-record` --
    # never misrouted through `unsupported-schema` by a probe that happened to still parse.
    aid = ids.mint_activity_id()
    terminal = _line(aid, "terminal", 1, outcome="succeeded", summary={}, by="deadbeef")
    bom_terminal = b"\xef\xbb\xbf" + terminal.encode("utf-8")
    utf16_terminal = terminal.encode("utf-16-le")
    for bad_bytes in (bom_terminal, utf16_terminal):
        data = _start_line(aid).encode() + b"\n" + bad_bytes + b"\n"
        records_out, findings = scan_mod.parse_segment_bytes(data, aid)
        assert [r["type"] for r in records_out] == ["start"]
        assert findings == [{"kind": scan_mod.CORRUPT_RECORD}]

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

# --- R4-1 / Ruling 45: an unreadable activity DIRECTORY must never vanish from the ceiling ----

def test_missing_activity_directory_is_not_uncertain(tmp_path):
    # A directory that PROVABLY never existed is "nothing here", not "couldn't tell" -- only
    # "exists but can't be measured" (chmod 000, ELOOP, ...) is `uncertain`. The surrounding
    # `activity/` parent (and `quota/`) is created FIRST so the missing piece is genuinely just
    # the aid-specific subdirectory (a real FileNotFoundError on that one path component) rather
    # than the shared prefix itself being absent, which `open_owned_dir` reports as UnsafePath --
    # a separate, pre-existing distinction this fix does not change.
    paths.secure_mkdir(paths.quota_dir(tmp_path))          # activity/ + quota/ exist; no aid dir
    aid = ids.mint_activity_id()
    entries, uncertain = paths.stat_owned_segments_detailed(paths.activity_dir(tmp_path, aid))
    assert entries == [] and uncertain is False
    assert quota._on_disk_detailed(tmp_path, aid) == (0, False)
    assert quota._accounting_uncertain(tmp_path) is False
    assert quota._charge(tmp_path) == 0

def test_unreadable_activity_directory_does_not_vanish_from_the_ceiling(tmp_path, monkeypatch):
    """R4-1 (Codex R4 B1, BLOCKER): `stat_owned_segments` used to return `[]` both when an
    activity dir was genuinely gone AND when it existed but couldn't be traversed (EACCES/ELOOP),
    so `_charge` silently counted an unlistable SETTLED activity as 0 bytes. Codex's exact repro:
    16 settled x 4 MiB = 64 MiB; chmod 000 one activity dir -> charge drops to 60 MiB -> a 60 KiB
    reservation is wrongly admitted -> restore -> 67,170,304 bytes, over the hard ceiling.

    Scaled down 1024x here for test speed, with RESERVE/PER_ACTIVITY_CAP/ORDINARY_CAP/CEILING
    monkeypatched CONSISTENTLY: all four are read at CALL time (exactly like the module's
    existing CEILING-only monkeypatch convention -- see test_activity_prune.py/test_activity_
    quota.py), extended here to the other three since PER_ACTIVITY_CAP must stay >= RESERVE for
    a ledger entry to validate (`_parse_entry`). CEILING is deliberately re-monkeypatched TWICE
    below: once EXACTLY at the real (settled + live) total -- zero headroom, mirroring Codex's
    own numbers -- to make "_charge does not drop below the ceiling" a meaningful assertion, and
    once with a little headroom afterward to prove admissions actually resume once the
    accounting is trustworthy again (not "refused forever")."""
    monkeypatch.setattr(quota, "RESERVE", 60)
    monkeypatch.setattr(quota, "PER_ACTIVITY_CAP", 4096)
    monkeypatch.setattr(quota, "ORDINARY_CAP", 4096 - 60)
    monkeypatch.setattr(quota, "CEILING", 10 ** 9)          # generous ceiling for this one admit

    # A live activity, admitted while the accounting is still fully trustworthy (nothing else
    # exists yet) -- used below to prove an UNRELATED grant is refused too.
    live_aid, live_lease = _new_activity(tmp_path)
    assert quota.admit(tmp_path, live_aid, live_lease) is True

    # 16 settled activities (no ledger entry -- bytes counted purely by the directory scan), each
    # exactly PER_ACTIVITY_CAP (4096) bytes: mirrors a maximally-full real activity's lifetime
    # cap, and matches Codex's own numbers exactly (16 x cap == the tight ceiling below).
    settled_aids = []
    for _ in range(16):
        aid = ids.mint_activity_id()
        paths.secure_mkdir(paths.activity_dir(tmp_path, aid))
        paths.segment_path(tmp_path, aid, "python", "deadbeef").write_bytes(b"x" * 4096)
        settled_aids.append(aid)
    broken_dir = paths.activity_dir(tmp_path, settled_aids[0])

    real_charge = 16 * 4096 + quota.RESERVE          # settled bytes + live's outstanding reserve
    monkeypatch.setattr(quota, "CEILING", real_charge)   # ceiling now EXACTLY full: zero headroom
    assert quota._charge(tmp_path) == real_charge
    assert quota._accounting_uncertain(tmp_path) is False

    os.chmod(broken_dir, 0o000)
    try:
        assert quota._accounting_uncertain(tmp_path) is True
        charge_after = quota._charge(tmp_path)
        assert charge_after >= quota.CEILING, (
            f"_charge dropped below the ceiling once a settled activity dir became unreadable: "
            f"{charge_after} < {quota.CEILING}"
        )
        fresh_aid, fresh_lease = _new_activity(tmp_path)
        assert quota.admit(tmp_path, fresh_aid, fresh_lease) is False   # would wrongly succeed pre-fix
        assert quota.grant(tmp_path, live_aid, 1) is False              # unrelated grant refused too
    finally:
        os.chmod(broken_dir, 0o700)                                     # restore before any more scans

    assert quota._accounting_uncertain(tmp_path) is False
    restored_charge = quota._charge(tmp_path)
    assert restored_charge == real_charge                # recomputed to the exact real total
    assert restored_charge <= quota.CEILING

    # accounting is trustworthy again -- with a LITTLE headroom, a fresh admission now succeeds
    # (proving "cleared -> resumes", not "stays refused forever" once bytes are measurable again)
    monkeypatch.setattr(quota, "CEILING", real_charge + quota.RESERVE)
    fresh_aid2, fresh_lease2 = _new_activity(tmp_path)
    assert quota.admit(tmp_path, fresh_aid2, fresh_lease2) is True
