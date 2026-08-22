import json, os, time
from repo_radar.activity import quota, paths, lease, ids

def _rec(home, aid, **r):
    r.update(schema_version=1, activity_id=aid, ts="2026-08-14T00:00:00-07:00")
    seg = paths.segment_path(home, aid, "python", "deadbeef")
    fd = paths.secure_open_append(seg); os.write(fd, (json.dumps(r)+"\n").encode()); os.close(fd)
    return seg

def _settled(home, outcome="succeeded", age_days=0.0):
    aid = ids.mint_activity_id(); paths.secure_mkdir(paths.activity_dir(home, aid))
    l = lease.acquire(paths.owner_lock_path(home, aid)); quota.admit(home, aid, l)
    _rec(home, aid, type="start", seq=0, kind="sync", channel="stable", trigger="cli", created_by="python")
    seg = _rec(home, aid, type="terminal", seq=9, outcome=outcome, summary={}, by="deadbeef")
    l.release(); quota.settle(home, aid)
    old = time.time() - age_days*86400; os.utime(seg, (old, old))     # backdate for the age policy
    return aid

def test_routine_older_than_14d_outside_newest_50_pruned_but_13d_kept(tmp_path, monkeypatch):
    # Spec §7's newest-50 is PROTECTIVE (shields the 50 most-recent items from age-pruning); with
    # only 2 items seeded, both are within a newest-50 window, so the 20d item would never be
    # prunable under the real NEWEST_KEEP=50. Narrowing the protected window to the newest 1 makes
    # the 20d item genuinely outside newest-50 (and >14d -> pruned) while the 13d item remains the
    # newest (protected, and also <14d) -> kept. See task-3.5 brief's design ruling.
    monkeypatch.setattr(quota, "NEWEST_KEEP", 1)
    old = _settled(tmp_path, "succeeded", 20); young = _settled(tmp_path, "succeeded", 13)
    quota.retain(tmp_path)
    assert not paths.activity_dir(tmp_path, old).exists()
    assert paths.activity_dir(tmp_path, young).exists()

def test_problem_younger_than_90d_is_kept_even_if_outside_newest_50(tmp_path):
    prob = _settled(tmp_path, "failed", 30)                  # 30d < 90d
    quota.retain(tmp_path)
    assert paths.activity_dir(tmp_path, prob).exists()

def test_running_is_never_pruned_regardless_of_age(tmp_path):
    aid = ids.mint_activity_id(); paths.secure_mkdir(paths.activity_dir(tmp_path, aid))
    held = lease.acquire(paths.owner_lock_path(tmp_path, aid)); quota.admit(tmp_path, aid, held)
    seg = _rec(tmp_path, aid, type="start", seq=0, kind="sync", channel="stable", trigger="cli", created_by="python")
    old = time.time() - 999*86400; os.utime(seg, (old, old))
    quota.retain(tmp_path)                                   # lease held -> running -> never pruned
    assert paths.activity_dir(tmp_path, aid).exists(); held.release()

def test_ceiling_override_keeps_newest_problem(tmp_path, monkeypatch):
    problems = [_settled(tmp_path, "failed", 1) for _ in range(2)]
    monkeypatch.setattr(quota, "CEILING", quota.RESERVE)     # force ceiling-override pruning
    quota.retain(tmp_path)
    assert paths.activity_dir(tmp_path, problems[-1]).exists()   # newest problem preserved

def test_prune_skips_items_in_the_live_ledger(tmp_path):
    aid = ids.mint_activity_id(); paths.secure_mkdir(paths.activity_dir(tmp_path, aid))
    l = lease.acquire(paths.owner_lock_path(tmp_path, aid)); quota.admit(tmp_path, aid, l)
    quota._prune_locked(tmp_path, need_bytes=10**9)          # a live-ledger item is never a candidate
    assert paths.activity_dir(tmp_path, aid).exists(); l.release()
