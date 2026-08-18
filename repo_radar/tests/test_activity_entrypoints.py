import json, os, subprocess, sys
from repo_radar.activity import paths, ids, lease

def _seg_records(home, aid):
    d = paths.activity_dir(home, aid); recs = []
    for f in sorted(d.glob("*.jsonl")):
        recs += [json.loads(x) for x in f.read_text().splitlines()]
    return recs

def _run_bootstrap(tmp_path, aid, held):
    env = {**os.environ, "HOME": str(tmp_path),
           "REPO_RADAR_ACTIVITY_ID": aid,
           "REPO_RADAR_ACTIVITY_OWNER_TOKEN": held.owner_token,
           "REPO_RADAR_ACTIVITY_LOCK_FD": str(held.fd)}
    return subprocess.run([sys.executable, "-m", "repo_radar.activity.bootstrap",
                           "--kind", "sync", "--channel", "stable", "--trigger", "scheduled"],
                          env=env, pass_fds=[held.fd], capture_output=True, text=True)

def test_bootstrap_is_first_producer_writes_start_and_initial_ownership(tmp_path):
    # scheduled path: the shell mints+holds; NO start exists yet -> bootstrap admits + starts
    aid = ids.mint_activity_id()
    paths.secure_mkdir(paths.activity_dir(tmp_path, aid))
    held = lease.acquire(paths.owner_lock_path(tmp_path, aid))   # shell holds the fd
    r = _run_bootstrap(tmp_path, aid, held)
    assert r.returncode == 0, r.stderr
    recs = _seg_records(tmp_path, aid)
    assert [x["type"] for x in recs].count("start") == 1
    assert any(x["type"] == "ownership" and x["role"] == "initial" for x in recs)
    assert paths.ledger_entry_path(tmp_path, aid).exists()       # admitted
    assert lease.probe_busy(paths.owner_lock_path(tmp_path, aid)) # shell still holds it

def test_bootstrap_adopts_existing_start_writes_handoff_only(tmp_path):
    # Electron already admitted + wrote start; bootstrap must NOT write a second start
    from repo_radar.activity import quota
    aid = ids.mint_activity_id()
    paths.secure_mkdir(paths.activity_dir(tmp_path, aid))
    held = lease.acquire(paths.owner_lock_path(tmp_path, aid))
    quota.admit(tmp_path, aid, held)
    seg = paths.segment_path(tmp_path, aid, "electron", "cafebabe")
    fd = paths.secure_open_append(seg)
    os.write(fd, (json.dumps({"schema_version": 1, "activity_id": aid, "type": "start", "seq": 0,
        "ts": "2026-08-14T00:00:00-07:00", "kind": "sync", "channel": "stable", "trigger": "cli",
        "created_by": "electron"}) + "\n").encode()); os.close(fd)
    r = _run_bootstrap(tmp_path, aid, held)
    assert r.returncode == 0, r.stderr
    recs = _seg_records(tmp_path, aid)
    assert [x["type"] for x in recs].count("start") == 1         # still exactly one
    assert any(x["type"] == "ownership" and x["role"] == "handoff" for x in recs)

def test_finalize_standalone_records_blocked_incident(tmp_path):
    r = subprocess.run([sys.executable, "-m", "repo_radar.activity.finalize",
                        "--kind", "system", "--channel", "dev", "--trigger", "scheduled",
                        "--outcome", "blocked", "--reason", "interpreter_fingerprint_mismatch"],
                       env={**os.environ, "HOME": str(tmp_path)}, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    # exactly one activity dir, containing start + blocked terminal, lease released
    base = paths.quota_dir(tmp_path).parent
    dirs = [p for p in base.iterdir() if p.is_dir() and p.name != "quota"]
    assert len(dirs) == 1
    recs = _seg_records(tmp_path, dirs[0].name)
    assert recs[0]["type"] == "start" and recs[-1]["type"] == "terminal"
    assert recs[-1]["outcome"] == "blocked"
