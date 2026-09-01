import json, os
from repo_radar.activity import quota, paths, lease, ids
from repo_radar.activity import scan as scan_mod

# Codex R2 finding R2-1 (BLOCKER): `_reconcile_one_locked` must never synthesize a terminal (or
# settle the ledger) when its view of an activity's segments is UNCERTAIN -- an unreadable
# (permission-denied, symlinked, or otherwise rejected) CONFORMING segment must never be
# interpreted as "absent". Codex repro: readable start + a conforming `succeeded` terminal
# segment chmod 000 + a free owner lock previously made the reconciler synthesize a SECOND,
# CONFLICTING `interrupted` terminal ([('interrupted', 'reconciler'), ('succeeded', 'deadbeef')]
# after restoring perms). "Uncertain => preserve, never guess" (Ruling 38).

def _mk(tmp_path, aid):
    d = paths.activity_dir(tmp_path, aid); paths.secure_mkdir(d)
    paths.secure_mkdir(paths.quota_dir(tmp_path))
    return paths.owner_lock_path(tmp_path, aid)

def _new_activity(tmp_path):
    aid = ids.mint_activity_id(); lp = _mk(tmp_path, aid)
    return aid, lease.acquire(lp)

def _write_rec(home, aid, writer_id, **rec):   # a durable VALID v1 record on its OWN segment file
    rec.setdefault("schema_version", 1); rec.setdefault("activity_id", aid)
    rec.setdefault("ts", "2026-08-14T00:00:00-07:00")
    seg = paths.segment_path(home, aid, "python", writer_id)
    fd = paths.secure_open_append(seg)
    os.write(fd, (json.dumps(rec) + "\n").encode()); os.close(fd)
    return seg

def _write_start(home, aid, writer_id="deadbeef"):
    return _write_rec(home, aid, writer_id, type="start", seq=0, kind="sync",
                       channel="stable", trigger="cli", created_by="python")

def _write_terminal(home, aid, writer_id="cafebabe", outcome="succeeded"):
    return _write_rec(home, aid, writer_id, type="terminal", seq=9,
                       outcome=outcome, summary={}, by="deadbeef")

def _reconcile_one_locked(home, aid):
    # Ruling 64 (Codex R8-1, BLOCKER): `_reconcile_one_locked` now requires the active `LockCtx`
    # (identity-bound ledger unlinks via `_unlink_entry_fd`) -- this test helper acquires+releases
    # a real lock around the call, exactly like the production `_reconcile_all_locked` does.
    ctx = quota._quota_lock(home)
    try:
        quota._reconcile_one_locked(home, aid, ctx)
    finally:
        quota._unlock(ctx)

def test_unreadable_conforming_terminal_segment_preserves_ledger_and_synthesizes_nothing(tmp_path):
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l)
    _write_start(tmp_path, aid)
    terminal_seg = _write_terminal(tmp_path, aid)
    os.chmod(terminal_seg, 0o000)
    try:
        l.release()                                            # owner gone; lock now free
        before = set(os.listdir(paths.activity_dir(tmp_path, aid)))

        quota.reconcile(tmp_path)

        assert paths.ledger_entry_path(tmp_path, aid).exists()  # NOT settled
        after = set(os.listdir(paths.activity_dir(tmp_path, aid)))
        assert after == before                                  # no synthetic segment written

        kind, _mtime, _ident = quota._classify(tmp_path, aid)
        assert kind == "running"                                # uncertain view -> never guessed
    finally:
        os.chmod(terminal_seg, 0o600)                           # restore perms before teardown

def test_unreadable_conforming_terminal_segment_reconciles_normally_once_perms_restored(tmp_path):
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l)
    _write_start(tmp_path, aid)
    terminal_seg = _write_terminal(tmp_path, aid)
    os.chmod(terminal_seg, 0o000)
    l.release()
    quota.reconcile(tmp_path)
    assert paths.ledger_entry_path(tmp_path, aid).exists()      # preserved while unreadable

    os.chmod(terminal_seg, 0o600)                                # restore
    kind, _mtime, _ident = quota._classify(tmp_path, aid)
    assert kind == "routine"                                     # succeeded, no problems -> routine

    quota.reconcile(tmp_path)
    assert not paths.ledger_entry_path(tmp_path, aid).exists()  # now settles normally

def test_terminal_segment_replaced_by_symlink_preserves_ledger_and_synthesizes_nothing(tmp_path):
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l)
    _write_start(tmp_path, aid)

    outside = tmp_path / "outside-terminal.jsonl"
    outside.write_text(json.dumps({
        "schema_version": 1, "activity_id": aid, "type": "terminal", "seq": 9,
        "ts": "2026-08-14T00:00:00-07:00", "outcome": "succeeded", "summary": {}, "by": "deadbeef",
    }) + "\n")
    terminal_seg = paths.segment_path(tmp_path, aid, "python", "cafebabe")
    os.symlink(outside, terminal_seg)          # a CONFORMING name, but a symlink on disk

    l.release()
    before = set(os.listdir(paths.activity_dir(tmp_path, aid)))

    quota.reconcile(tmp_path)

    assert paths.ledger_entry_path(tmp_path, aid).exists()      # preserved
    after = set(os.listdir(paths.activity_dir(tmp_path, aid)))
    assert after == before                                       # no synthetic segment written

    kind, _mtime, _ident = quota._classify(tmp_path, aid)
    assert kind == "running"

# --- direct `_scan` coverage: the Scan field contract itself -------------------------------

def test_scan_view_uncertain_true_for_unreadable_conforming_segment(tmp_path):
    aid = ids.mint_activity_id(); paths.secure_mkdir(paths.activity_dir(tmp_path, aid))
    seg = _write_start(tmp_path, aid)
    os.chmod(seg, 0o000)
    try:
        scan = quota._scan(tmp_path, aid)
        assert scan.view_uncertain is True
        assert scan.rejected == [{"name": "python-deadbeef.jsonl", "reason": "denied"}]
        assert scan.records == []
    finally:
        os.chmod(seg, 0o600)

def test_scan_view_uncertain_false_for_bad_name_only(tmp_path):
    aid = ids.mint_activity_id(); paths.secure_mkdir(paths.activity_dir(tmp_path, aid))
    (paths.activity_dir(tmp_path, aid) / "junk.jsonl").write_text("not a segment\n")
    scan = quota._scan(tmp_path, aid)
    assert scan.view_uncertain is False
    assert scan.rejected == [{"name": "junk.jsonl", "reason": "bad-name"}]

# --- trusted rescan under the lease (Codex R2 B2 recheck, R3 B3) ---------------------------
# `_reconcile_one_locked`'s own `_scan` call runs BEFORE any lease is acquired -- it only decides
# whether to CALL `synthesize_terminal` at all. That decision can go stale by the time
# `synthesize_terminal` actually acquires the owner lease and is about to write: a conforming
# segment could become unreadable, or a terminal could land, in the gap. `synthesize_terminal`
# therefore UNCONDITIONALLY re-runs the single trusted `scan.scan_activity` under that lease
# (no separate quota-side gate any more); a rescan that comes back uncertain / terminated must
# block the write entirely. Both `quota._scan` and `reconcile` go through
# `scan_mod.scan_activity`, so patching that one function drives every consumer.

def _patch_scan_sequence(monkeypatch, first, then):
    # Ruling 68 (G9-Py): `_reconcile_one_locked`'s own PRE-lease scan is now `ctx`-bound (it runs
    # under quota.lock with a live `ctx` -- see quota._scan) and goes through `scan_mod.
    # scan_activity_dir_fd`, not `scan_mod.scan_activity`. The UNDER-lease rescan `synthesize_
    # terminal` performs is unrelated to quota.lock (it runs under the per-activity owner lease
    # instead, and `reconcile.synthesize_terminal` has no `ctx` to bind to) and stays on the
    # path-based `scan_mod.scan_activity`, unchanged. Both are patched here, sharing ONE counter,
    # so "first"/"then" still line up with "pre-lease scan" / "under-lease rescan" regardless of
    # which underlying function each now goes through.
    calls = {"n": 0}
    def fake_scan(home, a):
        calls["n"] += 1
        return first if calls["n"] == 1 else then
    def fake_scan_dir_fd(dfd, a):
        calls["n"] += 1
        return first if calls["n"] == 1 else then
    monkeypatch.setattr(scan_mod, "scan_activity", fake_scan)
    monkeypatch.setattr(scan_mod, "scan_activity_dir_fd", fake_scan_dir_fd)
    return calls

def test_reconcile_one_locked_under_lease_rescan_blocks_stale_synthesis(tmp_path, monkeypatch):
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l)
    _write_start(tmp_path, aid)
    l.release()                                            # owner gone; lock now free

    # First scan is `_reconcile_one_locked`'s own PRE-lease scan: certain, has a start, no
    # terminal -- it must decide to call synthesize_terminal. The NEXT scan (made UNDER the lease
    # synthesize_terminal acquires) reports an uncertain view, simulating a conforming segment
    # going unreadable in the interim.
    certain_has_start = quota.Scan(records=[{"type": "start"}], findings=[], rejected=[],
                                    view_uncertain=False)
    now_uncertain = quota.Scan(records=[], findings=[],
                                rejected=[{"name": "x", "reason": "denied"}], view_uncertain=True)
    calls = _patch_scan_sequence(monkeypatch, certain_has_start, now_uncertain)

    _reconcile_one_locked(tmp_path, aid)

    assert calls["n"] == 2                                  # pre-lease scan + the under-lease rescan
    assert paths.ledger_entry_path(tmp_path, aid).exists()  # NOT settled -- rescan blocked the write
    # nothing was written, and the lease synthesize_terminal acquired was released
    fresh = lease.acquire(paths.owner_lock_path(tmp_path, aid))
    assert fresh is not None
    fresh.release()

def test_reconcile_one_locked_under_lease_rescan_blocks_when_terminal_landed(tmp_path, monkeypatch):
    # Same shape, but the under-lease rescan now SEES a terminal (one landed in the gap): nothing
    # must be synthesized (no second, conflicting terminal) and the ledger stays for the normal
    # terminal-present settle path of a later pass.
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l)
    _write_start(tmp_path, aid)
    l.release()
    certain_has_start = quota.Scan(records=[{"type": "start"}], findings=[], rejected=[],
                                    view_uncertain=False)
    now_terminated = quota.Scan(records=[{"type": "start"}, {"type": "terminal"}], findings=[],
                                rejected=[], view_uncertain=False)
    calls = _patch_scan_sequence(monkeypatch, certain_has_start, now_terminated)
    before = set(os.listdir(paths.activity_dir(tmp_path, aid)))

    _reconcile_one_locked(tmp_path, aid)

    assert calls["n"] == 2
    assert paths.ledger_entry_path(tmp_path, aid).exists()
    assert set(os.listdir(paths.activity_dir(tmp_path, aid))) == before   # no synthetic segment

def test_reconcile_one_locked_under_lease_rescan_allows_synthesis_when_view_still_holds(tmp_path):
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l)
    _write_start(tmp_path, aid)
    l.release()                                            # owner gone; lock now free

    _reconcile_one_locked(tmp_path, aid)

    assert not paths.ledger_entry_path(tmp_path, aid).exists()  # settled: rescan reaffirmed, synth wrote

def test_scan_view_uncertain_false_when_activity_dir_never_created(tmp_path):
    # mirrors _owner_lock_absent's FileNotFoundError-vs-other split: a directory that PROVABLY
    # never existed is a definite "nothing here", not uncertainty. The shared
    # ~/Library/Logs/repo-radar prefix must already exist (as it would in practice -- e.g. via
    # quota/'s own creation during admit()) for this to be provable; an entirely never-touched
    # prefix can't itself be validated and stays conservatively uncertain, same as
    # `_owner_lock_absent`.
    aid = ids.mint_activity_id()
    paths.secure_mkdir(paths.quota_dir(tmp_path))     # prefix + activity/ + quota/ exist; NOT <aid>
    scan = quota._scan(tmp_path, aid)
    assert scan.view_uncertain is False
    assert scan.rejected == []
    assert scan.records == []
