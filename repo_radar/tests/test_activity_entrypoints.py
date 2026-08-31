import json, os, subprocess, sys
from repo_radar.activity import paths, ids, lease, HANDOFF_REJECTED_EXIT

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

def test_bootstrap_no_handoff_env_is_a_benign_noop(tmp_path):
    # Codex B4 -- three-way classification, leg (a): bootstrap is adopt-only (no mint path), so
    # ALL THREE handoff env vars absent means no handoff was ever signaled -- unchanged benign
    # no-op, exit 0, nothing written.
    env = {**os.environ, "HOME": str(tmp_path)}
    for var in ("REPO_RADAR_ACTIVITY_ID", "REPO_RADAR_ACTIVITY_OWNER_TOKEN", "REPO_RADAR_ACTIVITY_LOCK_FD"):
        env.pop(var, None)
    r = subprocess.run([sys.executable, "-m", "repo_radar.activity.bootstrap",
                        "--kind", "sync", "--channel", "stable", "--trigger", "scheduled"],
                       env=env, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    base = paths.quota_dir(tmp_path).parent
    assert not base.exists() or [p for p in base.iterdir() if p.name != "quota"] == []


def test_bootstrap_partial_handoff_env_rejects_exits_66(tmp_path):
    # Codex B4 -- three-way classification, the two malformed-tuple legs: a PARTIAL handoff (some
    # but not all of the three vars set, or one that fails its own format check) must be REJECTED
    # (exit 66, nothing written) -- never silently `return 0` as if nothing had been attempted,
    # which would let the dispatcher believe recording is merely "off" while the upstream handoff
    # item stays unresolved. (The all-valid-adopts leg is already covered by
    # test_bootstrap_is_first_producer_writes_start_and_initial_ownership /
    # test_bootstrap_adopts_existing_start_writes_handoff_only above.)
    aid = ids.mint_activity_id()
    base = paths.quota_dir(tmp_path).parent

    # valid aid + MISSING token (and no fd)
    env = {**os.environ, "HOME": str(tmp_path), "REPO_RADAR_ACTIVITY_ID": aid}
    env.pop("REPO_RADAR_ACTIVITY_OWNER_TOKEN", None)
    env.pop("REPO_RADAR_ACTIVITY_LOCK_FD", None)
    r = subprocess.run([sys.executable, "-m", "repo_radar.activity.bootstrap",
                        "--kind", "sync", "--channel", "stable", "--trigger", "scheduled"],
                       env=env, capture_output=True, text=True)
    assert r.returncode == HANDOFF_REJECTED_EXIT, f"expected 66, got {r.returncode}\n{r.stderr}"
    assert not base.exists() or [p for p in base.iterdir() if p.name != "quota"] == []

    # valid aid + valid-shaped token + NON-NUMERIC fd
    env2 = {**os.environ, "HOME": str(tmp_path), "REPO_RADAR_ACTIVITY_ID": aid,
            "REPO_RADAR_ACTIVITY_OWNER_TOKEN": "deadbeef", "REPO_RADAR_ACTIVITY_LOCK_FD": "notanumber"}
    r2 = subprocess.run([sys.executable, "-m", "repo_radar.activity.bootstrap",
                        "--kind", "sync", "--channel", "stable", "--trigger", "scheduled"],
                       env=env2, capture_output=True, text=True)
    assert r2.returncode == HANDOFF_REJECTED_EXIT, f"expected 66, got {r2.returncode}\n{r2.stderr}"
    assert not base.exists() or [p for p in base.iterdir() if p.name != "quota"] == []


def test_bootstrap_rejects_corrupt_handoff_exits_66(tmp_path):
    # Corrupt handoff: env claims activity A but passes fd from activity B (fstat mismatch)
    # -> lease.adopt() rejects it -> bootstrap exits 66 and writes nothing
    aid_A = ids.mint_activity_id()
    aid_B = ids.mint_activity_id()
    paths.secure_mkdir(paths.activity_dir(tmp_path, aid_A))
    paths.secure_mkdir(paths.activity_dir(tmp_path, aid_B))
    held_B = lease.acquire(paths.owner_lock_path(tmp_path, aid_B))  # fd is for B's lock
    # Invoke bootstrap claiming A but passing B's fd (identity mismatch)
    env = {**os.environ, "HOME": str(tmp_path),
           "REPO_RADAR_ACTIVITY_ID": aid_A,
           "REPO_RADAR_ACTIVITY_OWNER_TOKEN": held_B.owner_token,
           "REPO_RADAR_ACTIVITY_LOCK_FD": str(held_B.fd)}
    r = subprocess.run([sys.executable, "-m", "repo_radar.activity.bootstrap",
                        "--kind", "sync", "--channel", "stable", "--trigger", "scheduled"],
                       env=env, pass_fds=[held_B.fd], capture_output=True, text=True)
    assert r.returncode == HANDOFF_REJECTED_EXIT, f"expected 66, got {r.returncode}\nstderr: {r.stderr}"
    # Activity A must not have any records written and no ledger entry
    recs = _seg_records(tmp_path, aid_A)
    assert recs == [], f"expected no records for A, got {recs}"
    assert not paths.ledger_entry_path(tmp_path, aid_A).exists()
