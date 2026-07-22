"""Tests for mode module imports."""

import inspect

import repo_radar.modes.sync as sync


def test_sync_all_three_clusters_use_provider_for_model():
    src = inspect.getsource(sync)
    # all three detection clusters replaced (>=3 calls), and the old model-shaped
    # startswith branches gone entirely (so no cluster silently remains).
    assert src.count("provider_for_model(") >= 3
    for old in ("startswith('o1')", "startswith('gpt')", "startswith('claude')", "startswith('gemini/')"):
        assert old not in src, f"stale provider branch remains: {old}"


def test_import_configure():
    from repo_radar.modes.configure import configure_mode
    assert callable(configure_mode)


def test_import_sync():
    from repo_radar.modes.sync import sync_mode
    assert callable(sync_mode)


def test_import_analyze():
    from repo_radar.modes.analyze import analyze_mode
    assert callable(analyze_mode)


def test_import_clean():
    from repo_radar.modes.clean import clean_mode
    assert callable(clean_mode)
