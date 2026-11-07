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


def test_configure_keeps_unrelated_config_fields(monkeypatch):
    """The CLI wizard only chooses repositories; keys, schedule and the Settings spending limits survive it."""
    import inquirer
    import types
    from repo_radar.modes import configure
    existing = {'github_token': 'test-old', 'repositories': [{'full_name': 'o/a'}], 'ai_model': 'm',
                'schedule': {'enabled': True}, 'incremental_update_limit_usd': 5.5, 'incremental_failure_stop': 4}
    saved = []
    answers = iter([{'action': 'add'}, {'continue': 'save'}, {'sync': False}])
    monkeypatch.setattr(configure, 'load_config', lambda: dict(existing))
    monkeypatch.setattr(configure, 'save_config', lambda config: saved.append(config) or True)
    monkeypatch.setattr(configure, 'fetch_user_repos', lambda token: {'o': []})
    monkeypatch.setattr(configure, 'select_repositories_interactive', lambda orgs, current: [{'full_name': 'o/b'}])
    monkeypatch.setattr(inquirer, 'prompt', lambda questions: next(answers))
    monkeypatch.setenv('GITHUB_TOKEN', 'test-new')
    assert configure.configure_mode(types.SimpleNamespace()) == 0
    config = saved[0]
    assert [r['full_name'] for r in config['repositories']] == ['o/a', 'o/b'] and config['github_token'] == 'test-new'
    for field in ('ai_model', 'schedule', 'incremental_update_limit_usd', 'incremental_failure_stop'):
        assert config[field] == existing[field], field
