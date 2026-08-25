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

def _settled_with_event(home, outcome="succeeded", age_days=0.0, event_level=None):
    # Same shape as _settled but with an optional `event` record (Ruling 33 predicate part (a))
    # inserted before the terminal, on the SAME segment file (paths.segment_path is deterministic
    # per producer/writer_id -- see _rec), so backdating the last-written segment's mtime backdates
    # every record it holds, exactly like _settled.
    aid = ids.mint_activity_id(); paths.secure_mkdir(paths.activity_dir(home, aid))
    l = lease.acquire(paths.owner_lock_path(home, aid)); quota.admit(home, aid, l)
    _rec(home, aid, type="start", seq=0, kind="sync", channel="stable", trigger="cli", created_by="python")
    if event_level is not None:
        _rec(home, aid, type="event", seq=1, level=event_level, event="x", fields={})
    seg = _rec(home, aid, type="terminal", seq=9, outcome=outcome, summary={}, by="deadbeef")
    l.release(); quota.settle(home, aid)
    old = time.time() - age_days*86400; os.utime(seg, (old, old))
    return aid

def _raw_line(home, aid, line: str):
    # a raw, non-JSON-record line appended to the SAME deterministic segment file `_rec` writes
    # to (paths.segment_path is deterministic per producer/writer_id="python"/"deadbeef"), so it
    # lands as an INTERIOR line once a later record is appended after it -- an integrity finding
    # (Ruling 36/R2-2), not the silently-dropped trailing-partial-write case.
    seg = paths.segment_path(home, aid, "python", "deadbeef")
    fd = paths.secure_open_append(seg); os.write(fd, (line + "\n").encode()); os.close(fd)
    return seg

def _settled_with_corrupt_interior_line(home, outcome="succeeded", age_days=0.0):
    # Codex R2 finding R2-2: a settled activity whose segment has ONE corrupt interior line
    # (between the start and terminal records) must be seen as problem-bearing by `_classify` --
    # governed by the 90-day rule, not the 14-day routine rule -- even though every top-level
    # RECORD is otherwise clean.
    aid = ids.mint_activity_id(); paths.secure_mkdir(paths.activity_dir(home, aid))
    l = lease.acquire(paths.owner_lock_path(home, aid)); quota.admit(home, aid, l)
    _rec(home, aid, type="start", seq=0, kind="sync", channel="stable", trigger="cli", created_by="python")
    _raw_line(home, aid, "{not valid json")                  # interior corruption
    seg = _rec(home, aid, type="terminal", seq=9, outcome=outcome, summary={}, by="deadbeef")
    l.release(); quota.settle(home, aid)
    old = time.time() - age_days*86400; os.utime(seg, (old, old))
    return aid

def _settled_with_duplicate_terminals(home, age_days=0.0):
    # Codex R2 finding R2-2 (f): two terminal records (even IDENTICAL ones) is itself a
    # structural problem -- duplicate/conflicting terminals must never be classified 'routine'.
    aid = ids.mint_activity_id(); paths.secure_mkdir(paths.activity_dir(home, aid))
    l = lease.acquire(paths.owner_lock_path(home, aid)); quota.admit(home, aid, l)
    _rec(home, aid, type="start", seq=0, kind="sync", channel="stable", trigger="cli", created_by="python")
    _rec(home, aid, type="terminal", seq=1, outcome="succeeded", summary={}, by="deadbeef")
    seg = _rec(home, aid, type="terminal", seq=2, outcome="succeeded", summary={}, by="deadbeef")
    l.release(); quota.settle(home, aid)
    old = time.time() - age_days*86400; os.utime(seg, (old, old))
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

def test_error_event_makes_succeeded_activity_problem_bearing_and_governs_90d_not_14d(tmp_path, monkeypatch):
    # Codex R1 finding B1: a `succeeded` terminal carrying a `level:error` event must classify as
    # 'problem' (Ruling 33 predicate part (a)), so it's governed by the 90-day problem rule, not
    # the 14-day routine rule. Both items are 20d old and forced genuinely outside the protected
    # window (NEWEST_KEEP=0) so age is the only thing deciding either outcome: the error-bearing
    # one must survive (20d < 90d) while the identical item minus the event is pruned (20d > 14d).
    monkeypatch.setattr(quota, "NEWEST_KEEP", 0)
    with_error = _settled_with_event(tmp_path, "succeeded", 20, event_level="error")
    without_error = _settled(tmp_path, "succeeded", 20)
    quota.retain(tmp_path)
    assert paths.activity_dir(tmp_path, with_error).exists()
    assert not paths.activity_dir(tmp_path, without_error).exists()

def test_warn_event_also_makes_activity_problem_bearing(tmp_path, monkeypatch):
    # Ruling 33 part (a) covers BOTH warn and error levels, not just error.
    monkeypatch.setattr(quota, "NEWEST_KEEP", 0)
    aid = _settled_with_event(tmp_path, "succeeded", 20, event_level="warn")
    quota.retain(tmp_path)
    assert paths.activity_dir(tmp_path, aid).exists()

def test_info_level_event_does_not_make_activity_problem_bearing(tmp_path, monkeypatch):
    # An info-level event is routine noise, not a problem signal -- still governed by the 14-day
    # routine rule and pruned at 20d.
    monkeypatch.setattr(quota, "NEWEST_KEEP", 0)
    aid = _settled_with_event(tmp_path, "succeeded", 20, event_level="info")
    quota.retain(tmp_path)
    assert not paths.activity_dir(tmp_path, aid).exists()

def test_bad_named_segment_holding_a_failure_terminal_does_not_make_classify_return_problem(tmp_path):
    # F-E parity fix: a non-conforming filename (not `${producer}-${writer_id}.jsonl` for a
    # known producer + 8-hex token) must NEVER be treated as a real segment by `_classify` (via
    # `_segments_data`), even though `paths.read_owned_segments` itself will happily read its
    # bytes -- it has no naming opinion of its own. Write a failure-like terminal directly into a
    # bad-named file (bypassing `paths.segment_path`'s own validation, which would refuse to
    # construct such a path) and confirm `_classify` does not see it at all: no types are parsed,
    # so "terminal" not in types -> ('running', mtime), never 'problem'.
    aid = ids.mint_activity_id(); paths.secure_mkdir(paths.activity_dir(tmp_path, aid))
    bad = paths.activity_dir(tmp_path, aid) / "python-s3cr3t.jsonl"
    rec = dict(schema_version=1, activity_id=aid, ts="2026-08-14T00:00:00-07:00",
                type="terminal", seq=9, outcome="failed", summary={}, by="deadbeef")
    bad.write_text(json.dumps(rec) + "\n")
    kind, _mtime = quota._classify(tmp_path, aid)
    assert kind != "problem"
    assert kind == "running"                          # no conforming segment -> no types at all
    assert quota._segments_data(tmp_path, aid) == []   # the bad-named file never enters the lifecycle view

def test_sole_old_problem_is_pruned_by_age_pass_not_shielded(tmp_path, monkeypatch):
    # Codex R1 finding I1: the age pass must NOT unconditionally shield `newest_problem` -- spec
    # §7 ties "always preserve the newest problem" to the ceiling-override only (test below still
    # covers that). A sole 100d-old failed activity, forced genuinely outside the protected window
    # (NEWEST_KEEP=0), exceeds the 90-day problem rule and must actually be pruned by `retain`.
    monkeypatch.setattr(quota, "NEWEST_KEEP", 0)
    aid = _settled(tmp_path, "failed", 100)
    pruned = quota.retain(tmp_path)
    assert not paths.activity_dir(tmp_path, aid).exists()
    assert aid in pruned

# --- Codex R2 finding R2-2 (BLOCKER): retention must see STRUCTURAL problems, not just valid
# top-level records -- a `succeeded` activity with corrupt interior content, a rejected/bad-name
# sibling, or duplicate terminals is problem-bearing even though its parsed records look routine.

def test_corrupt_interior_line_makes_succeeded_activity_problem_bearing_kept_at_20d(tmp_path, monkeypatch):
    # 20d < the 90-day problem-age threshold -> kept, even though NEWEST_KEEP=0 removes the
    # newest-50 protection and 20d is already past the 14-day ROUTINE threshold (would be pruned
    # if the corrupt line weren't seen as a structural problem).
    monkeypatch.setattr(quota, "NEWEST_KEEP", 0)
    aid = _settled_with_corrupt_interior_line(tmp_path, "succeeded", 20)
    assert quota._classify(tmp_path, aid)[0] == "problem"
    quota.retain(tmp_path)
    assert paths.activity_dir(tmp_path, aid).exists()

def test_corrupt_interior_line_succeeded_activity_pruned_at_100d(tmp_path, monkeypatch):
    # Same shape, but 100d > the 90-day problem-age threshold -> the structural problem doesn't
    # shield it forever, just governs it by the RIGHT (90d, not 14d) rule.
    monkeypatch.setattr(quota, "NEWEST_KEEP", 0)
    aid = _settled_with_corrupt_interior_line(tmp_path, "succeeded", 100)
    quota.retain(tmp_path)
    assert not paths.activity_dir(tmp_path, aid).exists()

def test_bad_name_sibling_file_keeps_succeeded_activity_at_20d(tmp_path, monkeypatch):
    # A stray non-conforming file sitting next to a clean, settled `succeeded` activity is itself
    # a structural oddity (R2-2 (e)): the activity must be governed by the 90-day rule, not 14d.
    monkeypatch.setattr(quota, "NEWEST_KEEP", 0)
    aid = _settled(tmp_path, "succeeded", 20)
    (paths.activity_dir(tmp_path, aid) / "junk.jsonl").write_text("not a segment\n")
    assert quota._classify(tmp_path, aid)[0] == "problem"
    quota.retain(tmp_path)
    assert paths.activity_dir(tmp_path, aid).exists()

def test_duplicate_succeeded_terminals_keeps_activity_at_20d(tmp_path, monkeypatch):
    # Two terminal records (R2-2 (f)) -- even two IDENTICAL `succeeded` ones -- is a structural
    # problem (duplicate settlement), governed by the 90-day rule, not the 14-day routine rule.
    monkeypatch.setattr(quota, "NEWEST_KEEP", 0)
    aid = _settled_with_duplicate_terminals(tmp_path, 20)
    assert quota._classify(tmp_path, aid)[0] == "problem"
    quota.retain(tmp_path)
    assert paths.activity_dir(tmp_path, aid).exists()
