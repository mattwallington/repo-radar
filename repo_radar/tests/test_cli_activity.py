import json, os, subprocess, sys
from repo_radar.activity import paths


def _terminal_outcomes(tmp_path):
    base = paths.quota_dir(tmp_path).parent
    outs = []
    for d in [p for p in base.iterdir() if p.is_dir() and p.name != "quota"]:
        for f in d.glob("*.jsonl"):
            for line in f.read_text().splitlines():
                r = json.loads(line)
                if r["type"] == "terminal":
                    outs.append(r["outcome"])
    return outs


def test_dependency_failure_records_a_blocked_terminal(tmp_path):
    # Force check_dependencies to fail in a child; assert an ACTUAL blocked terminal (finding 8)
    env = {**os.environ, "HOME": str(tmp_path), "REPO_RADAR_FORCE_DEPS_FAIL": "1"}
    r = subprocess.run([sys.executable, "-m", "repo_radar.cli", "sync", "--dry-run"],
                       env=env, capture_output=True, text=True)
    assert r.returncode == 2, r.stderr
    assert "blocked" in _terminal_outcomes(tmp_path)   # not merely "a directory exists"


def test_dependency_failure_on_configure_and_analyze_also_records_blocked(tmp_path):
    # The brief calls for establishment on configure/analyze too (not just sync) -- a dependency
    # failure on either of those must be equally durable, not silently lost.
    for command in ("configure", "analyze"):
        home = tmp_path / command
        home.mkdir()
        env = {**os.environ, "HOME": str(home), "REPO_RADAR_FORCE_DEPS_FAIL": "1"}
        r = subprocess.run([sys.executable, "-m", "repo_radar.cli", command],
                           env=env, capture_output=True, text=True)
        assert r.returncode == 2, f"{command}: {r.stderr}"
        assert "blocked" in _terminal_outcomes(home), f"{command}: no blocked terminal"


def test_version_help_get_description_and_clean_do_not_establish_activity(tmp_path):
    # CARRY-FORWARD (Ruling 13 / Task 2.4): the shell dispatcher no longer mints a phantom
    # activity for non-attempt commands. cli.py must not reintroduce that at the Python layer --
    # --version/help/get-description/clean must never create an activity directory.
    env = {**os.environ, "HOME": str(tmp_path)}
    for argv in (["--version"], ["help"], ["get-description"], ["clean", "--dry-run"]):
        r = subprocess.run([sys.executable, "-m", "repo_radar.cli", *argv],
                           env=env, capture_output=True, text=True)
        assert r.returncode == 0, f"{argv}: {r.stderr}"
    activity_base = paths.quota_dir(tmp_path).parent
    assert not activity_base.exists() or list(activity_base.iterdir()) == []


def test_sync_with_valid_handoff_env_adopts_not_mints(tmp_path):
    # A dispatcher/Electron parent already minted + admitted + wrote a durable start; a direct
    # `python -m repo_radar.cli sync` inheriting that handoff must ADOPT (write an
    # ownership{role:"handoff"} ack) rather than mint a second start (finding: adopt vs mint).
    from repo_radar.activity import ids, lease, quota

    aid = ids.mint_activity_id()
    paths.secure_mkdir(paths.activity_dir(tmp_path, aid))
    held = lease.acquire(paths.owner_lock_path(tmp_path, aid))
    quota.admit(tmp_path, aid, held)
    seg = paths.segment_path(tmp_path, aid, "electron", "cafebabe")
    fd = paths.secure_open_append(seg)
    os.write(fd, (json.dumps({"schema_version": 1, "activity_id": aid, "type": "start", "seq": 0,
        "ts": "2026-08-14T00:00:00-07:00", "kind": "sync", "channel": "stable", "trigger": "cli",
        "created_by": "electron"}) + "\n").encode())
    os.close(fd)

    env = {**os.environ, "HOME": str(tmp_path),
           "REPO_RADAR_ACTIVITY_ID": aid,
           "REPO_RADAR_ACTIVITY_OWNER_TOKEN": held.owner_token,
           "REPO_RADAR_ACTIVITY_LOCK_FD": str(held.fd),
           "REPO_RADAR_FORCE_DEPS_FAIL": "1"}   # forces a fast, deterministic post-start exit
    r = subprocess.run([sys.executable, "-m", "repo_radar.cli", "sync", "--dry-run"],
                       env=env, pass_fds=[held.fd], capture_output=True, text=True)
    assert r.returncode == 2, r.stderr

    recs = []
    for f in paths.activity_dir(tmp_path, aid).glob("*.jsonl"):
        recs += [json.loads(x) for x in f.read_text().splitlines()]
    assert [x["type"] for x in recs].count("start") == 1     # still exactly one -- no duplicate mint
    assert any(x["type"] == "ownership" and x["role"] == "handoff" for x in recs)
    assert any(x["type"] == "terminal" and x["outcome"] == "blocked" for x in recs)


def test_sync_rejects_corrupt_handoff_exits_66_without_running(tmp_path):
    # Env claims activity A but passes activity B's lock fd (identity mismatch, per lease.adopt's
    # §5 checks) -- cli.py must exit HANDOFF_REJECTED_EXIT (66) WITHOUT running the sync, and must
    # write nothing for A.
    from repo_radar.activity import ids, lease, HANDOFF_REJECTED_EXIT

    aid_a = ids.mint_activity_id()
    aid_b = ids.mint_activity_id()
    paths.secure_mkdir(paths.activity_dir(tmp_path, aid_a))
    paths.secure_mkdir(paths.activity_dir(tmp_path, aid_b))
    held_b = lease.acquire(paths.owner_lock_path(tmp_path, aid_b))

    env = {**os.environ, "HOME": str(tmp_path),
           "REPO_RADAR_ACTIVITY_ID": aid_a,
           "REPO_RADAR_ACTIVITY_OWNER_TOKEN": held_b.owner_token,
           "REPO_RADAR_ACTIVITY_LOCK_FD": str(held_b.fd)}
    r = subprocess.run([sys.executable, "-m", "repo_radar.cli", "sync", "--dry-run"],
                       env=env, pass_fds=[held_b.fd], capture_output=True, text=True)
    assert r.returncode == HANDOFF_REJECTED_EXIT, f"expected 66, got {r.returncode}\n{r.stderr}"

    recs = []
    for f in paths.activity_dir(tmp_path, aid_a).glob("*.jsonl"):
        recs += [json.loads(x) for x in f.read_text().splitlines()]
    assert recs == [], f"expected no records for A, got {recs}"
    assert not paths.ledger_entry_path(tmp_path, aid_a).exists()


def test_establish_activity_wires_configured_secrets_for_redaction(tmp_path, monkeypatch):
    # A non-pattern configured secret (matches none of redact.py's built-in credential-shape
    # patterns) must be masked in a written event once cli.py's own establishment routine
    # (_establish_activity, backed by _secret_values(load_config())) has constructed the writer.
    from repo_radar import config as config_mod
    from repo_radar import cli as cli_mod

    secret = "zQ7mVpL1nRtKwEx9"
    cfg_file = tmp_path / "config.json"
    cfg_file.write_text(json.dumps({"github_token": "ghp_abc123", "anthropic_api_key": secret}))
    monkeypatch.setattr(config_mod, "CONFIG_FILE", cfg_file)
    monkeypatch.setenv("HOME", str(tmp_path))
    for var in ("REPO_RADAR_ACTIVITY_ID", "REPO_RADAR_ACTIVITY_OWNER_TOKEN", "REPO_RADAR_ACTIVITY_LOCK_FD"):
        monkeypatch.delenv(var, raising=False)

    writer, handoff_exit = cli_mod._establish_activity()
    assert handoff_exit is None
    assert writer is not None and writer._active
    writer.event("probe", "info", token=secret)
    writer.terminal("succeeded")

    blob = "".join(f.read_text() for f in
                    paths.activity_dir(tmp_path, writer.activity_id).glob("*.jsonl"))
    assert secret not in blob
    assert "[REDACTED]" in blob


def test_secret_values_extracts_configured_secret_shape(tmp_path):
    from repo_radar.cli import _secret_values

    cfg = {
        "github_token": "ghp_abc123",
        "anthropic_api_key": "anthropic-key",
        "gemini_api_key": "gemini-key",
        "openai_api_key": "openai-key",
        "repositories": [{"full_name": "org/repo"}],   # non-secret config keys must be ignored
    }
    values = _secret_values(cfg)
    for expected in ("ghp_abc123", "anthropic-key", "gemini-key", "openai-key"):
        assert expected in values
    assert len(values) == 4

    assert _secret_values(None) == []
    assert _secret_values({}) == []
    assert _secret_values({"github_token": "", "anthropic_api_key": None}) == []
