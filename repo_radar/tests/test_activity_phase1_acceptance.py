import json, os, subprocess, sys
from repo_radar.activity import writer, paths, quota, lease, ids

def _records(home, aid):
    d = paths.activity_dir(home, aid); recs = []
    for f in sorted(d.glob("*.jsonl")):
        recs += [json.loads(x) for x in f.read_text().splitlines()]
    return recs

def test_full_cli_style_attempt_end_to_end(tmp_path):
    w = writer.ActivityWriter(tmp_path, kind="sync", channel="stable",
                              trigger="cli", producer="python",
                              configured_secrets=["ghp_shouldnotappear000000000000000000"])
    w.start()
    w.event("repos_loaded", "info", count=30)
    w.event("repo_updated", "info", repo="ReperioHealth/x", old="aaa", new="bbb")
    w.event("pull_failed", "error", repo="y",
            detail="fatal: could not read Username ghp_shouldnotappear000000000000000000")
    w.terminal("succeeded-with-warnings", repos_changed=1, errors=1, warns=0)
    recs = _records(tmp_path, w.activity_id)
    assert [r["type"] for r in recs][0] == "start"
    assert recs[-1]["type"] == "terminal" and recs[-1]["outcome"] == "succeeded-with-warnings"
    blob = json.dumps(recs)
    assert "ghp_shouldnotappear" not in blob            # write-time redaction held
    assert not paths.ledger_entry_path(tmp_path, w.activity_id).exists()   # settled

def _durable_start(home, aid):   # a genuinely durable, valid v1 start (Round-6 #2)
    blob = (json.dumps({"schema_version": 1, "activity_id": aid, "type": "start", "seq": 0,
        "ts": "2026-08-14T00:00:00-07:00", "kind": "sync", "channel": "stable", "trigger": "cli",
        "created_by": "python"}) + "\n").encode()
    fd = paths.secure_open_append(seg := paths.segment_path(home, aid, "python", "deadbeef"))
    try:
        view = memoryview(blob)
        while view:
            view = view[os.write(fd, view):]        # full-write loop
        os.fsync(fd)                                # durable
    finally:
        os.close(fd)

def test_crash_after_durable_start_self_heals_to_interrupted(tmp_path):
    # finding 1: durable start, lease freed, NO terminal -> reconcile synthesizes + settles
    aid = ids.mint_activity_id(); paths.secure_mkdir(paths.activity_dir(tmp_path, aid))
    l = lease.acquire(paths.owner_lock_path(tmp_path, aid))
    quota.admit(tmp_path, aid, l); _durable_start(tmp_path, aid)
    l.release()                                          # crash: lease freed, no terminal
    quota.reconcile(tmp_path)
    assert not paths.ledger_entry_path(tmp_path, aid).exists()   # settled (no reservation leak)
    assert "terminal" in quota._top_types(tmp_path, aid)         # synthetic terminal present

def test_reconcile_reclaims_only_abandoned_pre_start(tmp_path):
    aid = ids.mint_activity_id(); paths.secure_mkdir(paths.activity_dir(tmp_path, aid))
    l = lease.acquire(paths.owner_lock_path(tmp_path, aid))
    quota.admit(tmp_path, aid, l)                        # reserved, NO start
    l.release()                                          # died pre-start, lease free
    quota.reconcile(tmp_path)
    assert not paths.ledger_entry_path(tmp_path, aid).exists()   # released (nothing to synthesize)
