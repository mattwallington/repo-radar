import os, stat
import pytest
from repo_radar.activity import paths

VALID = "00000000-0000-4000-8000-000000000000"

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
