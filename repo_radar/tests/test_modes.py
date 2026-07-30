"""Tests for mode module imports, and sync's end-of-run index contract."""

import inspect
import json
import subprocess
import types

import pytest

import repo_radar.modes.sync as sync
from repo_radar.config import get_cache_name


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

    # No test may reach a paid API. This is not belt-and-braces: an earlier version of the
    # steady-state test below mis-derived the metadata filename, so `needs_metadata` came out true
    # and the suite made a real LLM call and spent real money — intermittently, which is the worst
    # way to find out. Raising here makes spending impossible.
    #
    # Recording the attempt matters as much as blocking it: sync swallows exceptions from its
    # metadata futures, so a blocked call leaves metadata_generated at 0 — indistinguishable from
    # "there was no work to do". A test asserting the steady state would keep passing while no
    # longer testing it.
    llm_attempts = []

    def _no_paid_calls(*a, **k):
        llm_attempts.append(a)
        raise AssertionError(
            'a test attempted a live LLM call — the sync harness must never spend money')
    monkeypatch.setattr(sync, 'call_llm', _no_paid_calls)

    calls = []

    posted = []
    monkeypatch.setattr(sync, 'send_status_update',
                        lambda kind, data, server: posted.append((kind, data)))

    def run(index_drops, skip_metadata=True, status_server='127.0.0.1:0'):
        monkeypatch.setattr(sync, 'regenerate_index', lambda args: (calls.append(args), index_drops)[1])
        args = types.SimpleNamespace(
            dry_run=False, skip_metadata=skip_metadata, metadata_only=False, repos_only=False,
            force=False, status_server=status_server, show_window=False, verbose=False,
            wait_for_network=False, repo=None, jobs=1, regenerate_metadata=False,
        )
        rc = sync.sync_mode(args)
        receipt_file = config_dir / 'last-run-stable.json'
        receipt = json.loads(receipt_file.read_text()) if receipt_file.exists() else None
        return rc, receipt, calls

    run.pristine = pristine
    run.src = src
    run.llm_attempts = llm_attempts
    run.posted = posted
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


def test_both_transports_report_one_shared_completion_instant(sync_harness):
    """The live update and the receipt describe the SAME completion and must say so.

    Each used to stamp its own datetime.now(), so the receipt was always a few milliseconds later
    than the live update. Electron read that as a newer, cleaner run and let a run silently
    overwrite its own richer live result — clearing a warning it had raised moments earlier.
    Equal timestamps are what let the reader tell "same event" from "two events".
    """
    _, receipt, _ = sync_harness(index_drops=0)

    complete = [data for kind, data in sync_harness.posted if kind == 'complete']
    assert len(complete) == 1, "precondition: exactly one completion was posted"
    assert complete[0]['finishedAt'] == receipt['finishedAt'], (
        "the live payload and the receipt must carry one instant, not two readings of the clock")


def test_sync_rebuilds_the_index_on_a_genuine_steady_state_run(sync_harness):
    """The literal case the bug was about: metadata enabled and every repository already current.

    The other tests reach an empty repos_needing_metadata via skip_metadata, which the old
    condition (`repos_needing_metadata and not args.skip_metadata`) also short-circuited — so they
    would pass against a partial fix that only handled one half of that `and`. Here nothing is
    skipped: the clone exists, HEAD is unchanged, and the metadata file records that same commit,
    so the repository genuinely needs no work.
    """
    rc, _, calls = sync_harness(index_drops=0)          # first run clones
    assert len(calls) == 1

    head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=sync_harness.src,
                          capture_output=True, text=True, check=True).stdout.strip()
    # Derive the cache name the way production does rather than scanning the directory. Sync
    # creates a stable `probe` symlink alongside the real `probe-<hash>` directory and is_dir() is
    # true for both, so picking "the first directory" depended on filesystem iteration order: when
    # it returned the symlink, the metadata file was written under the wrong name, needs_metadata
    # came out true, and the test made a live paid LLM call roughly one run in eight. That is the
    # same symlink-vs-real-file confusion this branch fixes in regenerate_index.
    cache_name = get_cache_name(str(sync_harness.src), 'probe')
    assert (sync_harness.pristine / cache_name).is_dir(), 'precondition: the clone landed here'
    (sync_harness.pristine / f'{cache_name}.md').write_text(
        f"---\nfull_name: org/probe\ncache_dir: {cache_name}\nlast_commit: {head}\n"
        f"brief: Already analysed.\ntype: Library\nlanguage: Go\nrelated_repos: []\n---\n")

    rc, receipt, calls = sync_harness(index_drops=1, skip_metadata=False)

    assert sync_harness.llm_attempts == [], (
        "precondition: this run must have needed NO metadata work. A blocked call would leave "
        "metadataGenerated at 0 too, so that alone cannot tell 'nothing to do' from 'it failed'")
    assert receipt['stats']['metadataGenerated'] == 0
    assert len(calls) == 2, "a steady-state run must still validate the derived index"
    assert rc == 1 and receipt['stats']['indexDropped'] == 1
