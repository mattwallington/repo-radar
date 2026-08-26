import json, os, subprocess, sys
from repo_radar.activity import quota, paths, lease, ids, prune

# --- Codex gate round 1, Finding 3 (BLOCKER before Phase 2): prune must free room for a
# REQUESTED headroom, not just bring charge back under CEILING ------------------------------
#
# Node's normal admission failure is `charge <= CEILING` BUT `charge + RESERVE > CEILING` (or
# `+ requested_bytes`) -- the old entrypoint looped only `while charge > CEILING`, so in that
# (the COMMON) regime the loop condition was false from the very first check, the entrypoint
# returned 0, and Node could never make room via prune.

def _mk(tmp_path, aid):
    d = paths.activity_dir(tmp_path, aid); paths.secure_mkdir(d)
    paths.secure_mkdir(paths.quota_dir(tmp_path))
    return paths.owner_lock_path(tmp_path, aid)

def _new_activity(tmp_path):
    aid = ids.mint_activity_id(); lp = _mk(tmp_path, aid)
    return aid, lease.acquire(lp)

def _write_rec(home, aid, **rec):   # a durable VALID v1 record, as the writer would leave it
    rec.setdefault("schema_version", 1); rec.setdefault("activity_id", aid)
    rec.setdefault("ts", "2026-08-14T00:00:00-07:00")
    seg = paths.segment_path(home, aid, "python", "deadbeef")
    fd = paths.secure_open_append(seg)
    os.write(fd, (json.dumps(rec) + "\n").encode()); os.close(fd)

def _write_start(home, aid):
    _write_rec(home, aid, type="start", seq=0, kind="sync", channel="stable",
               trigger="cli", created_by="python")

def _write_terminal(home, aid, outcome="succeeded"):
    _write_rec(home, aid, type="terminal", seq=9, outcome=outcome, summary={}, by="deadbeef")

def test_prune_frees_room_for_requested_headroom_not_just_above_ceiling(tmp_path, monkeypatch):
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l)
    _write_start(tmp_path, aid); _write_terminal(tmp_path, aid)
    quota.settle(tmp_path, aid)                     # settled, routine outcome -> prunable
    charge = quota._charge(tmp_path)
    # CEILING comfortably >= RESERVE (so freeing the tiny settled candidate is enough to make
    # room for a fresh reservation) but still < charge + RESERVE (so admission is genuinely
    # blocked beforehand) -- exactly the "charge <= CEILING, charge + RESERVE > CEILING" regime.
    monkeypatch.setattr(quota, "CEILING", quota.RESERVE + 200)
    assert charge <= quota.CEILING
    assert charge + quota.RESERVE > quota.CEILING

    freed = prune.prune_to_ceiling(tmp_path, requested=quota.RESERVE)

    assert freed > 0
    assert not paths.activity_dir(tmp_path, aid).exists()            # the candidate was pruned
    assert quota._charge(tmp_path) + quota.RESERVE <= quota.CEILING  # enough headroom now exists

def test_prune_default_requested_is_reserve(tmp_path, monkeypatch):
    # "if absent default to RESERVE" -- calling with no `requested` behaves the same as
    # `requested=quota.RESERVE`.
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l)
    _write_start(tmp_path, aid); _write_terminal(tmp_path, aid)
    quota.settle(tmp_path, aid)
    monkeypatch.setattr(quota, "CEILING", quota.RESERVE + 200)
    freed = prune.prune_to_ceiling(tmp_path)          # no `requested` -> defaults to RESERVE
    assert freed > 0
    assert quota._charge(tmp_path) + quota.RESERVE <= quota.CEILING

def test_prune_never_touches_a_running_activity(tmp_path, monkeypatch):
    # existing prune ordering must still hold: a running (lease-held) activity is never pruned,
    # even when the requested-headroom loop keeps retrying.
    running_aid, running_l = _new_activity(tmp_path)
    quota.admit(tmp_path, running_aid, running_l)
    _write_start(tmp_path, running_aid)               # started, lease still HELD -> running
    monkeypatch.setattr(quota, "CEILING", 1024)        # nothing will ever be enough
    freed = prune.prune_to_ceiling(tmp_path, requested=quota.RESERVE)
    assert paths.activity_dir(tmp_path, running_aid).exists()   # never touched
    running_l.release()

def test_prune_then_fresh_admit_succeeds_where_it_previously_failed(tmp_path, monkeypatch):
    # Integration-style: the Phase-2 API contract -- after prune.py returns, a fresh admit(...)
    # for a NEW activity succeeds where it failed before.
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l)
    _write_start(tmp_path, aid); _write_terminal(tmp_path, aid)
    quota.settle(tmp_path, aid)
    charge = quota._charge(tmp_path)
    monkeypatch.setattr(quota, "CEILING", quota.RESERVE + 200)
    assert charge + quota.RESERVE > quota.CEILING

    # admit() ALSO has its own internal prune-first fallback (already using correct headroom
    # math -- that isn't finding 3's bug) which would otherwise mask this demonstration by
    # quietly pruning the same candidate itself. Disable ONLY that internal fallback to show the
    # state admission would be in before Node's SEPARATE `prune.py` maintenance call runs.
    with monkeypatch.context() as m:
        m.setattr(quota, "_prune_locked", lambda *a, **k: 0)
        blocked_aid, blocked_l = _new_activity(tmp_path)
        assert quota.admit(tmp_path, blocked_aid, blocked_l) is False    # failed before

    prune.prune_to_ceiling(tmp_path, requested=quota.RESERVE)            # Node's separate prune call

    new_aid, new_l = _new_activity(tmp_path)
    assert quota.admit(tmp_path, new_aid, new_l) is True                 # succeeds after

def test_cli_accepts_requested_bytes_via_argv(tmp_path):
    # a fresh subprocess uses the REAL (64 MiB) CEILING, so a tiny store has nothing to prune --
    # this just proves the argv[1] plumbing works end to end (accepts an arg, exits 0, prints
    # a non-negative freed-byte count) rather than forcing an actual prune across the process
    # boundary (covered directly, in-process, by the tests above).
    r = subprocess.run([sys.executable, "-m", "repo_radar.activity.prune", str(quota.RESERVE)],
                       env={**os.environ, "HOME": str(tmp_path)}, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert int(r.stdout.strip()) >= 0                  # freed bytes printed

def test_cli_defaults_requested_when_argv_absent(tmp_path):
    r = subprocess.run([sys.executable, "-m", "repo_radar.activity.prune"],
                       env={**os.environ, "HOME": str(tmp_path)}, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert int(r.stdout.strip()) >= 0

# --- Codex R7-2 (BLOCKER) / Ruling 61: pruning under ledger uncertainty must delete NOTHING -----
#
# Pre-fix, `prune_to_ceiling` looped `while quota._charge(home) + requested > quota.CEILING` --
# but under ledger uncertainty `_charge` is a CONSTANT sentinel (an unlistable ledger flattens the
# charge to CEILING), so the loop never terminates via headroom and instead keeps calling
# `_prune_locked` until it runs out of candidates, destructively deleting EVERY prunable activity
# even though the "0 live entries" ledger view is entirely unproven.

def test_prune_to_ceiling_deletes_nothing_when_ledger_listing_is_uncertain(tmp_path, monkeypatch):
    # Codex's exact repro shape: three settled, routine (prunable-looking) activities, plus a
    # forced ledger-listing failure. Pre-fix this deleted all three (charge pinned at the
    # ceiling sentinel kept the loop going); fixed, prune_to_ceiling must refuse outright.
    aids = []
    for _ in range(3):
        aid, l = _new_activity(tmp_path)
        quota.admit(tmp_path, aid, l)
        _write_start(tmp_path, aid); _write_terminal(tmp_path, aid)
        quota.settle(tmp_path, aid)
        aids.append(aid)

    monkeypatch.setattr(quota, "CEILING", 1)   # any nonzero charge would look "over ceiling"

    real = paths.list_owned_entries_detailed
    def hooked(directory, suffix=None):
        if str(directory) == str(paths.quota_dir(tmp_path)):
            return [], True                     # simulated unlistable ledger dir
        return real(directory, suffix)
    monkeypatch.setattr(paths, "list_owned_entries_detailed", hooked)

    freed = prune.prune_to_ceiling(tmp_path, requested=quota.RESERVE)

    assert freed == 0
    for aid in aids:
        assert paths.activity_dir(tmp_path, aid).exists()   # nothing deleted under uncertainty

def test_prune_to_ceiling_still_prunes_normally_once_ledger_is_certain_again(tmp_path, monkeypatch):
    # Companion: with the SAME setup but no ledger-listing failure, the certain over-ceiling case
    # still prunes exactly as before -- the fix doesn't change the normal path.
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l)
    _write_start(tmp_path, aid); _write_terminal(tmp_path, aid)
    quota.settle(tmp_path, aid)
    monkeypatch.setattr(quota, "CEILING", quota.RESERVE + 200)

    freed = prune.prune_to_ceiling(tmp_path, requested=quota.RESERVE)
    assert freed > 0
    assert not paths.activity_dir(tmp_path, aid).exists()
