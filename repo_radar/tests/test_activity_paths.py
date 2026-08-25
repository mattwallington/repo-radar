import errno, os, stat
import pytest
from repo_radar.activity import paths

VALID = "00000000-0000-4000-8000-000000000000"
AID_A = "00000000-0000-4000-8000-0000000000aa"
AID_B = "00000000-0000-4000-8000-0000000000bb"
AID_C = "00000000-0000-4000-8000-0000000000cc"

def test_activity_dir_rejects_bad_id(tmp_path):
    with pytest.raises(paths.UnsafePath):
        paths.activity_dir(tmp_path, "../escape")

def test_secure_mkdir_is_0700_and_rejects_symlink(tmp_path):
    d = paths.activity_dir(tmp_path, VALID)
    paths.secure_mkdir(d)
    assert stat.S_IMODE(os.lstat(d).st_mode) == 0o700
    # a symlink at the target must be rejected, not followed
    victim = tmp_path / "victim"; victim.mkdir()
    link = paths.quota_dir(tmp_path)   # reuse a fresh path
    os.symlink(victim, link)
    with pytest.raises(paths.UnsafePath):
        paths.secure_mkdir(link)

def test_secure_open_append_is_0600_and_appends(tmp_path):
    d = paths.activity_dir(tmp_path, VALID); paths.secure_mkdir(d)
    seg = paths.segment_path(tmp_path, VALID, "python", "deadbeef")
    fd = paths.secure_open_append(seg)
    os.write(fd, b"line1\n"); os.close(fd)
    fd = paths.secure_open_append(seg)
    os.write(fd, b"line2\n"); os.close(fd)
    assert seg.read_bytes() == b"line1\nline2\n"
    assert stat.S_IMODE(os.lstat(seg).st_mode) == 0o600

def test_segment_path_rejects_bad_producer_and_writer(tmp_path):
    with pytest.raises(paths.UnsafePath):
        paths.segment_path(tmp_path, VALID, "python", "BADWRITER")
    with pytest.raises(paths.UnsafePath):
        paths.segment_path(tmp_path, VALID, "hacker", "deadbeef")

def test_read_owned_segments_skips_symlinked_entries(tmp_path):
    d = paths.activity_dir(tmp_path, VALID); paths.secure_mkdir(d)
    (d / "python-deadbeef.jsonl").write_bytes(b"x\n")
    victim = tmp_path / "outside.jsonl"; victim.write_bytes(b"secret\n")
    os.symlink(victim, d / "python-cafebabe.jsonl")     # symlinked entry must be skipped
    names = [n for n, _data, _sz, _mt in paths.read_owned_segments(d)]
    assert "python-deadbeef.jsonl" in names and "python-cafebabe.jsonl" not in names

def test_secure_mkdir_rejects_symlinked_ancestor(tmp_path):
    victim = tmp_path / "victim"; victim.mkdir()
    base = tmp_path / "Library" / "Logs" / "repo-radar"
    base.parent.mkdir(parents=True)
    os.symlink(victim, base)                             # symlinked ANCESTOR of activity/
    with pytest.raises(paths.UnsafePath):
        paths.secure_mkdir(base / "activity" / VALID)

def test_secure_mkdir_rejects_intermediate_symlink(tmp_path):
    # a symlink at an INTERMEDIATE owned component (activity/), not only the final one (Round-3 #7)
    victim = tmp_path / "victim"; victim.mkdir()
    prefix = tmp_path / "Library" / "Logs" / "repo-radar"; prefix.mkdir(parents=True)
    os.symlink(victim, prefix / "activity")             # 'activity' is a symlink
    with pytest.raises(paths.UnsafePath):
        paths.secure_mkdir(prefix / "activity" / VALID)

def test_secure_mkdir_repairs_overpermissive_existing_dir(tmp_path):
    d = paths.activity_dir(tmp_path, VALID)
    d.parent.mkdir(parents=True); os.mkdir(d, 0o777)    # pre-existing world-writable
    paths.secure_mkdir(d)
    assert stat.S_IMODE(os.lstat(d).st_mode) == 0o700   # repaired via fchmod

def test_secure_open_append_repairs_overpermissive_file(tmp_path):
    d = paths.activity_dir(tmp_path, VALID); paths.secure_mkdir(d)
    seg = paths.segment_path(tmp_path, VALID, "python", "deadbeef")
    os.close(os.open(seg, os.O_CREAT | os.O_WRONLY, 0o666))   # pre-existing 0666
    fd = paths.secure_open_append(seg); os.close(fd)
    assert stat.S_IMODE(os.lstat(seg).st_mode) == 0o600

def test_append_scan_prune_refuse_a_replaced_intermediate_component(tmp_path):
    # Round-4 #3: build a legit tree, then replace an OWNED intermediate component (activity/)
    # with a symlink to an outside dir holding a sentinel. append + scan + delete must all refuse
    # and must NEVER touch the outside sentinel.
    import shutil
    d = paths.activity_dir(tmp_path, VALID); paths.secure_mkdir(d)
    seg = paths.segment_path(tmp_path, VALID, "python", "deadbeef")
    fd = paths.secure_open_append(seg); os.write(fd, b"x\n"); os.close(fd)
    outside = tmp_path / "outside"; outside.mkdir()
    sentinel = outside / "SENTINEL"; sentinel.write_bytes(b"keep")
    activity_root = paths.quota_dir(tmp_path).parent          # .../repo-radar/activity
    shutil.rmtree(activity_root)
    os.symlink(outside, activity_root)                        # activity/ is now a symlink to outside
    with pytest.raises(paths.UnsafePath):
        paths.secure_open_append(seg)                         # append refuses
    assert paths.read_owned_segments(d) == []                 # scan refuses (empty)
    assert paths.list_owned_subdirs(activity_root) == []      # enumeration refuses
    assert paths.unlink_owned_tree(d) == 0                    # delete refuses (frees nothing)
    assert sentinel.exists()                                  # outside file untouched

def test_all_ops_refuse_symlinked_shared_prefix(tmp_path):
    # Fix round 1: open_owned_dir must wrap prefix open in try/except so a symlinked prefix
    # raises UnsafePath (not raw OSError), and all dependent ops gracefully refuse.
    import shutil
    d = paths.activity_dir(tmp_path, VALID); paths.secure_mkdir(d)
    seg = paths.segment_path(tmp_path, VALID, "python", "deadbeef")
    fd = paths.secure_open_append(seg); os.write(fd, b"x\n"); os.close(fd)
    outside = tmp_path / "outside"; outside.mkdir()
    sentinel = outside / "SENTINEL"; sentinel.write_bytes(b"keep")
    prefix = paths._base(tmp_path).parent                         # ~/Library/Logs/repo-radar
    shutil.rmtree(prefix)
    os.symlink(outside, prefix)                                   # prefix is now a symlink
    with pytest.raises(paths.UnsafePath):
        paths.secure_open_append(seg)                             # append refuses
    assert paths.read_owned_segments(d) == []                     # scan refuses (empty)
    activity_root = prefix / "activity"                           # also verify activity level
    assert paths.list_owned_subdirs(activity_root) == []          # enumeration refuses
    assert paths.unlink_owned_tree(d) == 0                        # delete refuses (frees nothing)
    assert sentinel.exists()                                      # outside file untouched

def test_stat_owned_segments_returns_sizes_without_reading_content(tmp_path):
    # Codex gate round 1, finding 7: a size-only, metadata (fstat) enumerator -- no content read.
    d = paths.activity_dir(tmp_path, VALID); paths.secure_mkdir(d)
    (d / "python-deadbeef.jsonl").write_bytes(b"hello\n")           # 6 bytes
    victim = tmp_path / "outside.jsonl"; victim.write_bytes(b"secret-content-here\n")
    os.symlink(victim, d / "python-cafebabe.jsonl")                 # symlink must be skipped
    sizes = dict(paths.stat_owned_segments(d))
    assert sizes == {"python-deadbeef.jsonl": 6}

def test_read_owned_segments_rejects_a_fifo_without_blocking(tmp_path):
    # Codex gate round 1, finding 2 (paths half): the final per-entry open must be
    # O_NOFOLLOW|O_NONBLOCK with an fstat(S_ISREG) check on the OPENED fd -- not an lstat done
    # BEFORE the open, which leaves a TOCTOU window and (for a FIFO) would otherwise risk
    # blocking the open itself.
    import signal
    d = paths.activity_dir(tmp_path, VALID); paths.secure_mkdir(d)
    (d / "python-deadbeef.jsonl").write_bytes(b"x\n")
    fifo = d / "python-cafebabe.jsonl"
    os.mkfifo(fifo)
    def _timeout(*_): raise TimeoutError("read_owned_segments blocked on a FIFO")
    old = signal.signal(signal.SIGALRM, _timeout); signal.alarm(5)
    try:
        out = paths.read_owned_segments(d)
    finally:
        signal.alarm(0); signal.signal(signal.SIGALRM, old)
    names = [n for n, _data, _sz, _mt in out]
    assert "python-deadbeef.jsonl" in names and "python-cafebabe.jsonl" not in names

def test_owned_opens_reject_a_fifo_without_blocking(tmp_path):
    # Round-6 #4: a FIFO where a segment/ledger file is expected must be rejected PROMPTLY
    # (O_NONBLOCK), never hang an unattended sync.
    import signal
    d = paths.activity_dir(tmp_path, VALID); paths.secure_mkdir(d)
    fifo = paths.segment_path(tmp_path, VALID, "python", "deadbeef")
    os.mkfifo(fifo)
    def _timeout(*_): raise TimeoutError("open blocked on a FIFO")
    old = signal.signal(signal.SIGALRM, _timeout); signal.alarm(5)
    try:
        with pytest.raises((paths.UnsafePath, OSError)):
            paths.read_owned_file(fifo)
        with pytest.raises((paths.UnsafePath, OSError)):
            paths.secure_open_append(fifo)
    finally:
        signal.alarm(0); signal.signal(signal.SIGALRM, old)

# F-E parity fix: parse_segment_name is the single authority quota.py's lifecycle helpers use to
# decide whether a `*.jsonl` entry is a REAL segment (`${producer}-${writer_id}.jsonl`) or
# something else that merely happens to live in the same directory. Mirrors Node's
# `paths.parseSegmentName` test coverage in menubar/activity/__tests__/paths.test.js.
def test_parse_segment_name_accepts_every_producer_with_a_valid_8_hex_writer_id():
    for producer in ("electron", "dispatcher", "python"):
        assert paths.parse_segment_name(f"{producer}-deadbeef.jsonl") == (producer, "deadbeef")

def test_parse_segment_name_rejects_a_bad_producer():
    assert paths.parse_segment_name("hacker-deadbeef.jsonl") is None
    assert paths.parse_segment_name("junk.jsonl") is None                # no dash at all

def test_parse_segment_name_rejects_a_bad_writer_id():
    assert paths.parse_segment_name("python-s3cr3t.jsonl") is None       # not hex
    assert paths.parse_segment_name("python-deadbee.jsonl") is None      # 7 hex chars
    assert paths.parse_segment_name("python-deadbeefff.jsonl") is None   # 10 hex chars

def test_parse_segment_name_rejects_an_extra_dash_between_producer_and_writer_id():
    assert paths.parse_segment_name("electron-extra-deadbeef.jsonl") is None

def test_parse_segment_name_rejects_a_missing_or_wrong_suffix():
    assert paths.parse_segment_name("python-deadbeef") is None           # no .jsonl at all
    assert paths.parse_segment_name("python-deadbeef.json") is None      # wrong suffix
    assert paths.parse_segment_name("python-deadbeef.jsonl.bak") is None # trailing garbage

def test_parse_segment_name_rejects_non_string_input_without_raising():
    assert paths.parse_segment_name(None) is None
    assert paths.parse_segment_name(123) is None

# Ruling 38 (Codex R2 finding R2-1, BLOCKER): read_owned_segments_detailed carries a `reason` for
# every rejected entry so a caller (quota.py's `_scan`) can tell "no terminal segment" apart from
# "a terminal segment exists but I couldn't read it" -- mirrors
# menubar/activity/paths.js's readOwnedSegmentsDetailed and its paths-rejected.test.js coverage.

def test_read_owned_segments_detailed_reports_symlink_reason(tmp_path):
    d = paths.activity_dir(tmp_path, VALID); paths.secure_mkdir(d)
    (d / "python-deadbeef.jsonl").write_bytes(b"x\n")
    victim = tmp_path / "outside.jsonl"; victim.write_bytes(b"secret\n")
    os.symlink(victim, d / "python-cafebabe.jsonl")
    segments, rejected = paths.read_owned_segments_detailed(d)
    assert [n for n, _d, _sz, _mt in segments] == ["python-deadbeef.jsonl"]
    assert rejected == [("python-cafebabe.jsonl", "symlink")]

def test_read_owned_segments_detailed_reports_not_regular_reason_for_a_fifo(tmp_path):
    import signal
    d = paths.activity_dir(tmp_path, VALID); paths.secure_mkdir(d)
    (d / "python-deadbeef.jsonl").write_bytes(b"x\n")
    fifo = d / "python-cafebabe.jsonl"
    os.mkfifo(fifo)
    def _timeout(*_): raise TimeoutError("read_owned_segments_detailed blocked on a FIFO")
    old = signal.signal(signal.SIGALRM, _timeout); signal.alarm(5)
    try:
        segments, rejected = paths.read_owned_segments_detailed(d)
    finally:
        signal.alarm(0); signal.signal(signal.SIGALRM, old)
    assert [n for n, _d, _sz, _mt in segments] == ["python-deadbeef.jsonl"]
    assert rejected == [("python-cafebabe.jsonl", "not-regular")]

def test_read_owned_segments_detailed_reports_denied_reason_for_a_0o000_file(tmp_path):
    d = paths.activity_dir(tmp_path, VALID); paths.secure_mkdir(d)
    seg = paths.segment_path(tmp_path, VALID, "python", "deadbeef")
    seg.write_bytes(b"line1\n")
    os.chmod(seg, 0o000)
    try:
        segments, rejected = paths.read_owned_segments_detailed(d)
        assert segments == []
        assert rejected == [("python-deadbeef.jsonl", "denied")]
    finally:
        os.chmod(seg, 0o600)          # restore perms BEFORE tmp_path teardown needs to unlink it

def test_read_owned_segments_detailed_reports_dir_unreadable_for_a_never_created_dir(tmp_path):
    d = paths.activity_dir(tmp_path, VALID)          # never secure_mkdir'd -- doesn't exist
    segments, rejected = paths.read_owned_segments_detailed(d)
    assert segments == []
    assert rejected == [("", "dir-unreadable")]

def test_read_owned_segments_detailed_reports_dir_unreadable_for_a_symlinked_activity_dir(tmp_path):
    outside = tmp_path / "outside"; outside.mkdir()
    d = paths.activity_dir(tmp_path, VALID)
    d.parent.mkdir(parents=True)
    os.symlink(outside, d)                           # activity dir itself is a symlink
    segments, rejected = paths.read_owned_segments_detailed(d)
    assert segments == []
    assert rejected == [("", "dir-unreadable")]

def test_read_owned_segments_is_a_thin_wrapper_over_detailed(tmp_path):
    d = paths.activity_dir(tmp_path, VALID); paths.secure_mkdir(d)
    (d / "python-deadbeef.jsonl").write_bytes(b"x\n")
    assert paths.read_owned_segments(d) == paths.read_owned_segments_detailed(d)[0]

# --- Ruling 49 (Codex R5-1, BLOCKER): list_owned_subdirs_detailed classifies, never silently
# drops, a valid-activity-id entry that isn't a plain lstat-able directory --------------------

def test_list_owned_subdirs_detailed_classifies_symlink_and_not_directory(tmp_path):
    base = paths.quota_dir(tmp_path).parent
    paths.secure_mkdir(paths.quota_dir(tmp_path))                   # base + quota/ exist
    real = paths.activity_dir(tmp_path, AID_A); paths.secure_mkdir(real)
    outside = tmp_path / "outside"; outside.mkdir()
    os.symlink(outside, base / AID_B)                                # AID_B: symlink
    (base / AID_C).write_bytes(b"not a directory")                   # AID_C: regular file
    subdirs, rejected, uncertain = paths.list_owned_subdirs_detailed(base)
    assert set(subdirs) == {"quota", AID_A}
    assert dict(rejected) == {AID_B: "symlink", AID_C: "not-directory"}
    assert uncertain is True

def test_list_owned_subdirs_detailed_gone_entry_is_rejected_but_not_uncertain(tmp_path, monkeypatch):
    base = paths.quota_dir(tmp_path).parent
    paths.secure_mkdir(paths.quota_dir(tmp_path))
    paths.secure_mkdir(paths.activity_dir(tmp_path, AID_A))
    real_lstat = paths.os.lstat
    def hooked(name, dir_fd=None):
        if name == AID_A:
            raise OSError(errno.ENOENT, "raced away")
        return real_lstat(name, dir_fd=dir_fd)
    monkeypatch.setattr(paths.os, "lstat", hooked)
    subdirs, rejected, uncertain = paths.list_owned_subdirs_detailed(base)
    assert AID_A not in subdirs
    assert (AID_A, "gone") in rejected
    assert uncertain is False                     # ENOENT is proven-gone, never uncertain

def test_list_owned_subdirs_detailed_stat_failure_is_uncertain_not_gone(tmp_path, monkeypatch):
    # Codex R5-1's exact defect: an lstat failure OTHER than ENOENT (e.g. EIO) previously vanished
    # the entry from the enumeration entirely -- quota's accounting never even reached
    # `stat_owned_segments_detailed` for it, undercounting the charge instead of refusing.
    base = paths.quota_dir(tmp_path).parent
    paths.secure_mkdir(paths.quota_dir(tmp_path))
    paths.secure_mkdir(paths.activity_dir(tmp_path, AID_A))
    real_lstat = paths.os.lstat
    def hooked(name, dir_fd=None):
        if name == AID_A:
            raise OSError(errno.EIO, "Input/output error")
        return real_lstat(name, dir_fd=dir_fd)
    monkeypatch.setattr(paths.os, "lstat", hooked)
    subdirs, rejected, uncertain = paths.list_owned_subdirs_detailed(base)
    assert AID_A not in subdirs
    assert (AID_A, "stat-failed") in rejected
    assert uncertain is True

def test_list_owned_subdirs_detailed_denied_entry_is_uncertain(tmp_path, monkeypatch):
    base = paths.quota_dir(tmp_path).parent
    paths.secure_mkdir(paths.quota_dir(tmp_path))
    paths.secure_mkdir(paths.activity_dir(tmp_path, AID_A))
    real_lstat = paths.os.lstat
    def hooked(name, dir_fd=None):
        if name == AID_A:
            raise OSError(errno.EACCES, "Permission denied")
        return real_lstat(name, dir_fd=dir_fd)
    monkeypatch.setattr(paths.os, "lstat", hooked)
    subdirs, rejected, uncertain = paths.list_owned_subdirs_detailed(base)
    assert AID_A not in subdirs
    assert (AID_A, "denied") in rejected
    assert uncertain is True

def test_list_owned_subdirs_detailed_base_missing_is_not_uncertain(tmp_path):
    base = paths.quota_dir(tmp_path).parent            # the "activity" dir path, never created
    base.parent.mkdir(parents=True)                     # the shared "repo-radar" prefix DOES exist
    assert paths.list_owned_subdirs_detailed(base) == ([], [], False)

def test_list_owned_subdirs_detailed_symlinked_base_is_uncertain(tmp_path):
    import shutil
    d = paths.activity_dir(tmp_path, VALID); paths.secure_mkdir(d)
    outside = tmp_path / "outside"; outside.mkdir()
    activity_root = paths.quota_dir(tmp_path).parent
    shutil.rmtree(activity_root)
    os.symlink(outside, activity_root)                  # base itself is a symlink
    subdirs, rejected, uncertain = paths.list_owned_subdirs_detailed(activity_root)
    assert subdirs == [] and rejected == [] and uncertain is True

def test_list_owned_subdirs_is_a_thin_wrapper_over_detailed(tmp_path):
    base = paths.quota_dir(tmp_path).parent
    paths.secure_mkdir(paths.quota_dir(tmp_path))
    paths.secure_mkdir(paths.activity_dir(tmp_path, VALID))
    assert paths.list_owned_subdirs(base) == paths.list_owned_subdirs_detailed(base)[0]

def test_list_owned_subdirs_detailed_ignores_non_uuid_names_in_rejected(tmp_path):
    # a stray non-UUID file/symlink at the root (e.g. `.DS_Store`, junk) is simply invisible to
    # `subdirs`/`rejected` -- it never hid a real activity's bytes, so it must not manufacture
    # `uncertain=True` or show up in `rejected`.
    base = paths.quota_dir(tmp_path).parent
    paths.secure_mkdir(paths.quota_dir(tmp_path))
    (base / "junk").write_bytes(b"not an activity")
    outside = tmp_path / "outside"; outside.mkdir()
    os.symlink(outside, base / "also-junk")
    subdirs, rejected, uncertain = paths.list_owned_subdirs_detailed(base)
    assert set(subdirs) == {"quota"}
    assert rejected == []
    assert uncertain is False
