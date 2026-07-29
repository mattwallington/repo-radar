from repo_radar.config import get_cache_name


def test_get_cache_name_is_deterministic():
    a = get_cache_name("https://github.com/org/repo.git", "repo")
    b = get_cache_name("https://github.com/org/repo.git", "repo")
    assert a == b


def test_get_cache_name_includes_repo_name():
    name = get_cache_name("https://github.com/org/my-repo.git", "my-repo")
    assert name.startswith("my-repo-")
    assert len(name) == len("my-repo-") + 7  # 7-char hash


def test_get_cache_name_differs_by_url():
    a = get_cache_name("https://github.com/org1/repo.git", "repo")
    b = get_cache_name("https://github.com/org2/repo.git", "repo")
    assert a != b


# ── config holds four API keys: it must never be world-readable ──────────────────────────


def _isolated(tmp_path, monkeypatch):
    import repo_radar.config as cfg
    monkeypatch.setattr(cfg, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(cfg, "CONFIG_FILE", tmp_path / "config.json")
    return cfg


def test_new_config_is_created_owner_only(tmp_path, monkeypatch):
    """A plain open('w') inherits umask 022 -> 0644, with the tokens inside."""
    import os
    import stat
    cfg = _isolated(tmp_path, monkeypatch)
    assert cfg.save_config({"ai_model": "claude-opus-5", "github_token": "x"}) is True
    assert stat.S_IMODE(os.stat(cfg.CONFIG_FILE).st_mode) == 0o600


def test_existing_permissive_config_is_tightened(tmp_path, monkeypatch):
    """Overwriting preserves mode, so a legacy 0644 file stays exposed without an explicit chmod."""
    import os
    import stat
    cfg = _isolated(tmp_path, monkeypatch)
    cfg.CONFIG_FILE.write_text("{}")
    os.chmod(cfg.CONFIG_FILE, 0o644)
    cfg.save_config({"ai_model": "claude-opus-5"})
    assert stat.S_IMODE(os.stat(cfg.CONFIG_FILE).st_mode) == 0o600


def test_save_is_atomic_and_leaves_no_temp_files(tmp_path, monkeypatch):
    cfg = _isolated(tmp_path, monkeypatch)
    for _ in range(3):
        cfg.save_config({"ai_model": "claude-opus-5"})
    leftovers = [p.name for p in tmp_path.iterdir() if p.name.startswith(".config-")]
    assert not leftovers, f"temp files left behind: {leftovers}"


def test_save_round_trips_content(tmp_path, monkeypatch):
    """Hardening must not change what is stored."""
    import json
    cfg = _isolated(tmp_path, monkeypatch)
    payload = {"ai_model": "claude-opus-5", "repositories": [{"name": "a"}], "github_token": "t"}
    cfg.save_config(payload)
    assert json.loads(cfg.CONFIG_FILE.read_text()) == payload
