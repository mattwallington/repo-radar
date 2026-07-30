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


# ── repository exclusions ────────────────────────────────────────────────────────────────
# De-configuring a repository is silent, reversible by the next `configure` run, and leaves its
# clone and metadata on disk to be indexed forever. An exclusion is a durable statement instead.

def test_exclusions_match_full_name_and_bare_name():
    from repo_radar.config import is_excluded

    assert is_excluded("ReperioHealth/reperio-nordic-fw", ["reperio-nordic-fw"])
    assert is_excluded("ReperioHealth/reperio-nordic-fw", ["ReperioHealth/reperio-nordic-fw"])
    assert is_excluded("ReperioHealth/reperio-nordic-fw", ["reperio-NORDIC-fw"]), "case-insensitive"
    assert not is_excluded("ReperioHealth/reperio-web-app", ["reperio-nordic-fw"])


def test_exclusions_are_exact_not_substring():
    """'reperio-web-app' must not take 'reperio-web-app-legacy' with it."""
    from repo_radar.config import is_excluded

    assert not is_excluded("ReperioHealth/reperio-web-app-legacy", ["reperio-web-app"])
    assert not is_excluded("ReperioHealth/reperio-web-app", ["web-app"])


def test_a_qualified_exclusion_does_not_match_another_org():
    from repo_radar.config import is_excluded

    assert not is_excluded("OtherOrg/reperio-nordic-fw",
                           ["ReperioHealth/reperio-nordic-fw"])
    assert is_excluded("OtherOrg/reperio-nordic-fw", ["reperio-nordic-fw"]), (
        "a BARE name is deliberately org-agnostic")


def test_missing_or_malformed_exclusions_exclude_nothing():
    from repo_radar.config import is_excluded, load_exclusions

    assert load_exclusions({}) == []
    assert load_exclusions({"exclusions": None}) == []
    assert load_exclusions({"exclusions": "not-a-list"}) == [], "a string must not be iterated"
    assert load_exclusions({"exclusions": ["  a  ", "", "  "]}) == ["a"]
    assert not is_excluded("Org/repo", [])
    assert not is_excluded(None, ["repo"])


def test_reconfiguring_preserves_everything_the_wizard_does_not_ask_about(tmp_path, monkeypatch):
    """`configure` rebuilt the config dict from scratch, silently discarding the model choice,
    all four provider API keys, the schedule, and — worst, because it is invisible — the
    exclusions list, so the next sync re-cloned repositories that had been deliberately removed."""
    import repo_radar.config as cfg

    monkeypatch.setattr(cfg, "CONFIG_FILE", tmp_path / "config.json")
    monkeypatch.setattr(cfg, "CONFIG_DIR", tmp_path)
    cfg.save_config({
        "github_token": "old", "repositories": [{"full_name": "Org/a"}],
        "exclusions": ["firmware"], "ai_model": "gemini/gemini-3.6-flash",
        "anthropic_api_key": "sk-ant", "schedule": {"enabled": True, "time": "09:00"},
    })

    # What configure_mode now does: merge, not replace.
    updated = cfg.load_config()
    updated.update({"github_token": "new", "repositories": [{"full_name": "Org/b"}],
                    "last_configured": "2026-07-30T00:00:00"})
    cfg.save_config(updated)

    after = cfg.load_config()
    assert after["repositories"] == [{"full_name": "Org/b"}], "the wizard's own fields update"
    assert after["github_token"] == "new"
    assert after["exclusions"] == ["firmware"], "exclusions must survive reconfiguration"
    assert after["ai_model"] == "gemini/gemini-3.6-flash"
    assert after["anthropic_api_key"] == "sk-ant"
    assert after["schedule"] == {"enabled": True, "time": "09:00"}
