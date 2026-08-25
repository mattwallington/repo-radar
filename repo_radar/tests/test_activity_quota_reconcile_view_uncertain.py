import json, os
from repo_radar.activity import quota, paths, lease, ids

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

        kind, _mtime = quota._classify(tmp_path, aid)
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
    kind, _mtime = quota._classify(tmp_path, aid)
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

    kind, _mtime = quota._classify(tmp_path, aid)
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
