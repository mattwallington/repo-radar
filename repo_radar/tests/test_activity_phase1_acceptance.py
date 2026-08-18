import json, os
from repo_radar.activity import writer, paths, quota, lease, ids, records

def _records(home, aid):
    d = paths.activity_dir(home, aid); recs = []
    for f in sorted(d.glob("*.jsonl")):
        recs += [json.loads(x) for x in f.read_text().splitlines()]
    return recs

def _terminal_outcomes(home, aid):
    # VALIDATED terminal outcomes only (canonical parser) -- same style as the sibling
    # quota/reconcile test files' `_top_terminal_outcomes` helper.
    out = []
    for _name, data, _sz, _mt in paths.read_owned_segments(paths.activity_dir(home, aid)):
        for line in data.split(b"\n"):
            if not line:
                continue
            obj = records.parse_valid(line, aid)
            if obj is not None and obj["type"] == "terminal":
                out.append(obj["outcome"])
    return out

def test_full_cli_style_attempt_end_to_end(tmp_path):
    w = writer.ActivityWriter(tmp_path, kind="sync", channel="stable",
                              trigger="cli", producer="python",
                              configured_secrets=["ghp_shouldnotappear000000000000000000",
                                                   "zQ7mVpL1nRtKwEx9"])
    w.start()
    w.event("repos_loaded", "info", count=30)
    w.event("repo_updated", "info", repo="ReperioHealth/x", old="aaa", new="bbb")
    w.event("pull_failed", "error", repo="y",
            detail="fatal: could not read Username ghp_shouldnotappear000000000000000000")
    # a configured secret with NO built-in credential shape -- isolates the configured_secrets
    # pathway from redact.py's built-in patterns. The literal above independently matches the
    # built-in gh[pousr]_ token pattern, so masking it alone can't prove configured_secrets
    # handling works at all (it would pass even if that mechanism were fully broken).
    w.event("config_dump", "info", token="zQ7mVpL1nRtKwEx9")
    w.terminal("succeeded-with-warnings", repos_changed=1, errors=1, warns=0)
    recs = _records(tmp_path, w.activity_id)
    assert [r["type"] for r in recs][0] == "start"
    assert recs[-1]["type"] == "terminal" and recs[-1]["outcome"] == "succeeded-with-warnings"
    blob = json.dumps(recs)
    assert "ghp_shouldnotappear" not in blob            # built-in GitHub-token pattern masked
    assert "zQ7mVpL1nRtKwEx9" not in blob               # configured-secrets pathway masked (no built-in match)
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
    # exact exit criterion: the synthesized terminal's OUTCOME must be "interrupted" -- a bare
    # "terminal" in top_types check only proves SOME terminal record exists, and would not catch
    # a regression that synthesized outcome="succeeded" (or anything else) instead.
    assert _terminal_outcomes(tmp_path, aid) == ["interrupted"]

def test_reconcile_reclaims_only_abandoned_pre_start(tmp_path):
    aid = ids.mint_activity_id(); paths.secure_mkdir(paths.activity_dir(tmp_path, aid))
    l = lease.acquire(paths.owner_lock_path(tmp_path, aid))
    quota.admit(tmp_path, aid, l)                        # reserved, NO start
    l.release()                                          # died pre-start, lease free
    quota.reconcile(tmp_path)
    assert not paths.ledger_entry_path(tmp_path, aid).exists()   # released (nothing to synthesize)
    # negative control: BOTH reconcile branches ("no start -> release" and "has start ->
    # synthesize+settle") delete the ledger entry, so the assertion above alone can't tell them
    # apart. Prove the no-synthesis branch specifically ran: nothing was ever fabricated for an
    # activity that never actually started.
    assert quota._top_types(tmp_path, aid) == []

# NOTE: a real dead-child crash test (os.fork(), child acquires the lease + writes a durable
# start + os._exit(0) without releasing, parent waitpid's + reconciles) was attempted here and
# DEFERRED -- see task-1.9-report.md "Real dead-child crash test" section for why. Summary: it
# passed every run in isolation and across 5+ full-suite repetitions (no hang ever observed), but
# running the FULL suite (`pytest repo_radar/tests/`, i.e. the actual gate command) deterministically
# triggers CPython 3.12's "this process is multi-threaded, use of fork() may lead to deadlocks in
# the child" DeprecationWarning. Bisection proved no single test file causes it and the trigger
# depends on which OTHER activity test files (with their own threading.Thread usage) are collected
# alongside it -- an interaction outside this file's control, not fixable by changes scoped here.
# Fork-after-multithreaded deadlocks manifest as indefinite hangs, not clean failures, which is a
# worse failure mode for CI than a missing test, so per the brief's explicit escape hatch this was
# left out rather than forced.
