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

def test_problem_younger_than_90d_is_kept_even_if_outside_newest_50(tmp_path, monkeypatch):
    # NEWEST_KEEP=0 forces the item genuinely OUTSIDE the protected window so the ONLY thing
    # keeping it is the problem age gate (30d < 90d), matching the test's name (review R1).
    monkeypatch.setattr(quota, "NEWEST_KEEP", 0)
    prob = _settled(tmp_path, "failed", 30)                  # 30d < 90d
    quota.retain(tmp_path)
    assert paths.activity_dir(tmp_path, prob).exists()

def test_routine_old_but_inside_protected_window_is_kept(tmp_path):
    # AND-isolation half 1 (review R1): age-eligible (20d > 14d) but still the newest (and only)
    # item, so the default NEWEST_KEEP=50 window protects it -> must be KEPT. An OR-implementation
    # (prune on age alone) would incorrectly prune this.
    old = _settled(tmp_path, "succeeded", 20)
    quota.retain(tmp_path)
    assert paths.activity_dir(tmp_path, old).exists()

def test_routine_young_but_outside_protected_window_is_kept(tmp_path, monkeypatch):
    # AND-isolation half 2 (review R1): forced genuinely OUTSIDE the window (NEWEST_KEEP=0) but
    # too young (2d < 14d) -> must be KEPT. An OR-implementation (prune on window-exclusion alone)
    # would incorrectly prune this. Together with the test above and the newest-50 test, this
    # proves the matrix is real AND-logic (age AND outside-window), not either condition alone.
    monkeypatch.setattr(quota, "NEWEST_KEEP", 0)
    young = _settled(tmp_path, "succeeded", 2)
    quota.retain(tmp_path)
    assert paths.activity_dir(tmp_path, young).exists()

def test_running_is_never_pruned_regardless_of_age(tmp_path):
    aid = ids.mint_activity_id(); paths.secure_mkdir(paths.activity_dir(tmp_path, aid))
    held = lease.acquire(paths.owner_lock_path(tmp_path, aid)); quota.admit(tmp_path, aid, held)
    seg = _rec(tmp_path, aid, type="start", seq=0, kind="sync", channel="stable", trigger="cli", created_by="python")
    old = time.time() - 999*86400; os.utime(seg, (old, old))
    quota.retain(tmp_path)                                   # lease held -> running -> never pruned
    assert paths.activity_dir(tmp_path, aid).exists(); held.release()

def test_ceiling_override_keeps_newest_problem(tmp_path, monkeypatch):
    # Distinct mtimes (2d, then 1d) so "newest problem" is unambiguous: problems[0] is older,
    # problems[-1] is newer. CEILING is set to exactly `charge - 1` so `over = charge - CEILING == 1
    # > 0` genuinely fires the ceiling-override branch (review R1 BLOCKER fix -- the prior
    # `CEILING = RESERVE` never triggered `over > 0` at all, since the real charge for 2 tiny
    # settled items is far below RESERVE, making the test vacuous: it passed even with the entire
    # ceiling-override branch deleted).
    problems = [_settled(tmp_path, "failed", age) for age in (2, 1)]
    charge = quota._charge(tmp_path)
    monkeypatch.setattr(quota, "CEILING", charge - 1)
    pruned = quota.retain(tmp_path)
    assert paths.activity_dir(tmp_path, problems[-1]).exists()       # newest problem preserved
    assert not paths.activity_dir(tmp_path, problems[0]).exists()    # older problem actually pruned
    assert problems[0] in pruned

def test_prune_skips_items_in_the_live_ledger(tmp_path):
    aid = ids.mint_activity_id(); paths.secure_mkdir(paths.activity_dir(tmp_path, aid))
    l = lease.acquire(paths.owner_lock_path(tmp_path, aid)); quota.admit(tmp_path, aid, l)
    quota._prune_locked(tmp_path, need_bytes=10**9)          # a live-ledger item is never a candidate
    assert paths.activity_dir(tmp_path, aid).exists(); l.release()
