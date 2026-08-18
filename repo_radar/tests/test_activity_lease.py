import os
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
