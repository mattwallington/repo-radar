import os
import signal
import pytest
from repo_radar.activity import lease, paths, ids

VALID = "00000000-0000-4000-8000-000000000000"

def _lock(tmp_path):
    d = paths.activity_dir(tmp_path, VALID); paths.secure_mkdir(d)
    return paths.owner_lock_path(tmp_path, VALID)

def test_acquire_is_exclusive_and_probe_busy(tmp_path):
    lp = _lock(tmp_path)
    l1 = lease.acquire(lp)
    assert l1 is not None and ids.valid_token(l1.owner_token)
    assert lease.probe_busy(lp) is True          # independent probe sees it held
    assert lease.acquire(lp) is None             # second acquire fails (busy)
    l1.release()
    assert lease.probe_busy(lp) is False
    assert lease.acquire(lp) is not None         # now free

def test_adopt_accepts_genuine_inherited_descriptor(tmp_path):
    lp = _lock(tmp_path)
    holder = lease.acquire(lp)                    # simulates Electron holding
    dup = os.dup(holder.fd)                       # simulates fd inheritance
    adopted = lease.adopt(dup, holder.owner_token, lp)
    assert adopted.owner_token == holder.owner_token   # SAME token, one logical lease

def test_adopt_rejects_unlocked_matching_descriptor(tmp_path):
    lp = _lock(tmp_path)
    # right inode, but nobody holds the lock -> independent probe would succeed -> reject
    fd = os.open(lp, os.O_RDWR | os.O_CREAT, 0o600)
    with pytest.raises(lease.HandoffRejected):
        lease.adopt(fd, "deadbeef", lp)

def test_adopt_rejects_when_a_different_lease_holds_the_inode(tmp_path):
    lp = _lock(tmp_path)
    other = lease.acquire(lp)                     # a DIFFERENT lease holds it
    fd = os.open(lp, os.O_RDWR)                   # our inherited fd does NOT share it
    with pytest.raises(lease.HandoffRejected):    # independent busy, reassert fails
        lease.adopt(fd, "deadbeef", lp)

def test_acquire_refuses_a_fifo_owner_lock_without_blocking(tmp_path):
    # Round-6 #4: a FIFO where owner.lock is expected must be rejected PROMPTLY (O_NONBLOCK),
    # never hang unattended sync. Prove it via alarm timeout.
    lp = _lock(tmp_path)
    os.mkfifo(lp)
    def _timeout(*_): raise TimeoutError("acquire/probe blocked on a FIFO")
    old = signal.signal(signal.SIGALRM, _timeout); signal.alarm(5)
    try:
        assert lease.acquire(lp) is None           # acquire refuses, returns None
        assert lease.probe(lp) == lease.UNCERTAIN  # probe returns UNCERTAIN (can't confirm state)
    finally:
        signal.alarm(0); signal.signal(signal.SIGALRM, old)

def test_acquire_refuses_owner_lock_under_intermediate_symlink(tmp_path):
    # Round-6 #4: owner.lock path under a symlinked INTERMEDIATE component (activity/) must be
    # rejected via UnsafePath, not attempted. acquire catches and returns None.
    import shutil
    lp = _lock(tmp_path)
    # Replace the activity directory with a symlink to outside
    outside = tmp_path / "outside"; outside.mkdir()
    activity_root = paths.quota_dir(tmp_path).parent  # .../repo-radar/activity
    shutil.rmtree(activity_root)
    os.symlink(outside, activity_root)
    assert lease.acquire(lp) is None                   # acquire catches UnsafePath -> None
