"""Tests for mode module imports, and sync's end-of-run index contract."""

import inspect
import json
import subprocess
import types

import pytest

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


@pytest.fixture
def sync_harness(tmp_path, monkeypatch):
    """Drive the real sync_mode offline against a local git repo.

    Everything below the network and config seams is genuine: a real clone runs, the real
    end-of-run bookkeeping executes, and a real receipt is written. Only regenerate_index is a
    spy, because these tests are about whether sync CALLS it and what it does with the answer.
    """
    import repo_radar.config as cfg
    import repo_radar.metadata as metadata

    src = tmp_path / 'src'
    src.mkdir()
    subprocess.run(['git', 'init', '-q', '-b', 'main'], cwd=src, check=True)
    (src / 'README.md').write_text('# probe\n')
    subprocess.run(['git', 'add', 'README.md'], cwd=src, check=True)
    subprocess.run(['git', '-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-qm', 'init'],
                   cwd=src, check=True)

    pristine = tmp_path / 'pristine'
    pristine.mkdir()
    config_dir = tmp_path / 'conf'
    config_dir.mkdir()

    for module, attr, value in ((cfg, 'PRISTINE_DIR', pristine), (sync, 'PRISTINE_DIR', pristine),
                                (metadata, 'PRISTINE_DIR', pristine),
                                (metadata, 'INDEX_FILE', pristine / 'INDEX.md'),
                                (sync, 'CONFIG_DIR', config_dir)):
        monkeypatch.setattr(module, attr, value)

    monkeypatch.setattr(sync, 'load_config', lambda: {
        'repositories': [{'name': 'probe', 'full_name': 'org/probe',
                          'clone_url': str(src), 'default_branch': 'main'}],
        'pristine_dir': str(pristine),
    })
    monkeypatch.setattr(sync, 'load_cache_index', lambda: {})
    monkeypatch.setattr(sync, 'save_cache_index', lambda index: None)
    monkeypatch.setattr(sync, 'wait_for_network', lambda *a, **k: True)

    calls = []

    def run(index_drops):
        monkeypatch.setattr(sync, 'regenerate_index', lambda args: (calls.append(args), index_drops)[1])
        args = types.SimpleNamespace(
            dry_run=False, skip_metadata=True, metadata_only=False, repos_only=False,
            force=False, status_server=None, show_window=False, verbose=False,
            wait_for_network=False, repo=None, jobs=1,
        )
        rc = sync.sync_mode(args)
        receipt_file = config_dir / 'last-run-stable.json'
        receipt = json.loads(receipt_file.read_text()) if receipt_file.exists() else None
        return rc, receipt, calls

    return run


def test_sync_rebuilds_the_index_even_when_no_metadata_work_is_needed(sync_harness):
    """The index rebuild was nested under `if repos_needing_metadata and not skip_metadata`.

    That is the COMMON path inverted: on a steady-state sync — every repository current, nothing
    to analyse — the index was never rebuilt or even validated, so a corrupt INDEX.md persisted
    indefinitely and the fix for it could not self-heal the file it was written to repair.
    """
    rc, receipt, calls = sync_harness(index_drops=0)

    assert len(calls) == 1, "a sync with no metadata work must still validate the derived index"
    assert rc == 0
    assert receipt['stats']['indexDropped'] == 0 and receipt['errorFree'] is True


def test_sync_fails_and_records_the_drop_when_the_index_is_incomplete(sync_harness):
    """Every repository synced cleanly; the index did not. That is a failed run, and the receipt
    is the only record of it when the app was closed."""
    rc, receipt, calls = sync_harness(index_drops=2)

    assert len(calls) == 1
    assert rc == 1, "an incomplete index must fail the run even with zero per-repo errors"
    assert receipt['stats']['errors'] == 0, "no repository failed — only the index did"
    assert receipt['stats']['indexDropped'] == 2
    assert receipt['errorFree'] is False
    assert receipt['completed'] is True, (
        "the run did finish; marking it incomplete would trigger a redundant paid catch-up")
