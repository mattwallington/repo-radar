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


# ── orphan detection ─────────────────────────────────────────────────────────────────────
# `clean` was all-or-nothing, so removing one stale 659 MB clone meant wiping the cache and
# re-cloning thirty repositories. Orphans are cached data no configured repository claims.

def _corpus(tmp_path, entries):
    """entries: {cache_name: full_name_or_None}. None means a clone with no metadata."""
    from repo_radar.config import get_cache_name

    pristine = tmp_path / 'pristine'
    pristine.mkdir()
    for cache_name, full_name in entries.items():
        (pristine / cache_name).mkdir()
        (pristine / cache_name / '.git').mkdir()   # a real cache entry is a clone
        if full_name:
            (pristine / f'{cache_name}.md').write_text(
                f"---\nfull_name: {full_name}\ncache_dir: {cache_name}\n---\n")
    (pristine / 'INDEX.md').write_text('# Index\n')
    return pristine


def _repo(full_name):
    return {'full_name': full_name, 'clone_url': f'https://github.com/{full_name}.git'}


def _cache(full_name):
    from repo_radar.config import get_cache_name
    return get_cache_name(f'https://github.com/{full_name}.git', full_name.split('/')[-1])


def test_configured_repositories_are_never_orphans(tmp_path):
    from repo_radar.modes.clean import find_orphans

    pristine = _corpus(tmp_path, {_cache('org/kept'): 'org/kept'})
    orphans, kept, _unknown = find_orphans(pristine, {'repositories': [_repo('org/kept')]})

    assert orphans == [], "a configured repository's cache must never be reported"
    assert len(kept) == 2, "its directory and its metadata file"


def test_an_unconfigured_repository_is_an_orphan(tmp_path):
    from repo_radar.modes.clean import find_orphans

    pristine = _corpus(tmp_path, {_cache('org/kept'): 'org/kept',
                                  _cache('org/gone'): 'org/gone'})
    orphans, _kept, _unknown = find_orphans(pristine, {'repositories': [_repo('org/kept')]})

    names = {p.name for p, _f, _r in orphans}
    assert names == {_cache('org/gone'), f"{_cache('org/gone')}.md"}
    assert all('not in configured repositories' in r for _p, _f, r in orphans)


def test_an_excluded_repository_is_an_orphan_even_while_still_configured(tmp_path):
    """Exclusion is durable: it must not require also editing the repositories list."""
    from repo_radar.modes.clean import find_orphans

    pristine = _corpus(tmp_path, {_cache('org/firmware'): 'org/firmware'})
    orphans, kept, _unknown = find_orphans(pristine, {'repositories': [_repo('org/firmware')],
                                                      'exclusions': ['firmware']})

    assert kept == [], "an excluded repository is not 'kept'"
    assert len(orphans) == 2
    assert all('excluded by configuration' in r for _p, _f, r in orphans)


def test_a_clone_with_no_metadata_is_identified_from_its_directory_name(tmp_path):
    """The largest orphan in practice had never been analyzed, so it had no metadata to read."""
    from repo_radar.modes.clean import find_orphans

    pristine = _corpus(tmp_path, {'reperio-nordic-fw-0a10653': None})
    orphans, _kept, _unknown = find_orphans(pristine, {'repositories': [],
                                                       'exclusions': ['reperio-nordic-fw']})

    assert len(orphans) == 1
    assert 'excluded by configuration (reperio-nordic-fw)' in orphans[0][2], (
        'a clone with no metadata must still be recognisable by its cache directory name')


def test_index_and_symlinks_are_never_reported_as_orphans(tmp_path):
    from repo_radar.modes.clean import find_orphans

    pristine = _corpus(tmp_path, {_cache('org/kept'): 'org/kept'})
    (pristine / 'kept').symlink_to(pristine / _cache('org/kept'))
    (pristine / '.cache-index.json').write_text('{}')

    orphans, _kept, _unknown = find_orphans(pristine, {'repositories': [_repo('org/kept')]})

    assert orphans == [], "INDEX.md, dotfiles and stable-name symlinks are not orphans"


# ── adversarial: orphan cleanup must fail closed ─────────────────────────────────────────
# Everything here decides what to DELETE, so every uncertainty must resolve toward keeping data.

@pytest.mark.parametrize("config", [None, {}, {'repositories': 'not-a-list'},
                                    {'repositories': ['not-an-object']}])
def test_an_unusable_config_refuses_to_classify_anything(tmp_path, config):
    """`config or {}` made a missing or corrupt config read as "nothing is configured", which
    makes the ENTIRE corpus an orphan — reproduced as a full corpus deletion."""
    from repo_radar.modes.clean import find_orphans, UnusableConfig

    pristine = _corpus(tmp_path, {_cache('org/kept'): 'org/kept'})
    with pytest.raises(UnusableConfig):
        find_orphans(pristine, config)


def test_unidentifiable_items_are_reported_but_never_deletable(tmp_path):
    """A directory we cannot recognise is not ours to remove, however tempting its name."""
    from repo_radar.modes.clean import find_orphans

    pristine = _corpus(tmp_path, {_cache('org/kept'): 'org/kept'})
    (pristine / 'handwritten-notes').mkdir()
    (pristine / 'handwritten-notes' / 'notes.txt').write_text('mine')
    (pristine / 'budget.xlsx').write_text('mine too')

    orphans, _kept, unknown = find_orphans(pristine, {'repositories': [_repo('org/kept')]})

    assert orphans == [], 'nothing unidentifiable may become a deletion candidate'
    assert {p.name for p, _why in unknown} == {'handwritten-notes', 'budget.xlsx'}


def test_a_cache_shaped_directory_that_is_not_a_git_clone_is_not_ours(tmp_path):
    """'-[0-9a-f]{7,}' is a weak signal; requiring a .git directory makes it evidence."""
    from repo_radar.modes.clean import find_orphans

    pristine = _corpus(tmp_path, {_cache('org/kept'): 'org/kept'})
    (pristine / 'photos-abc1234').mkdir()

    orphans, _kept, unknown = find_orphans(pristine, {'repositories': [_repo('org/kept')]})

    assert orphans == []
    assert [p.name for p, _why in unknown] == ['photos-abc1234']


def test_the_cache_index_mapping_is_authoritative_over_a_recomputed_name(tmp_path):
    """sync treats .cache-index.json as the url -> cache-name mapping, so a legacy or migrated
    directory whose name does not match get_cache_name is still a live cache, not an orphan."""
    from repo_radar.modes.clean import find_orphans

    pristine = tmp_path / 'pristine'
    pristine.mkdir()
    legacy = pristine / 'kept-legacyname'
    legacy.mkdir()
    (legacy / '.git').mkdir()
    (pristine / 'INDEX.md').write_text('# Index\n')
    config = {'repositories': [_repo('org/kept')]}

    orphans, kept, _unknown = find_orphans(
        pristine, config, cache_index={'https://github.com/org/kept.git': 'kept-legacyname'})

    assert orphans == [], 'the recorded mapping must win over the deterministic name'
    assert [p.name for p, _f in kept] == ['kept-legacyname']


def test_index_md_is_never_an_orphan_or_an_unknown(tmp_path):
    from repo_radar.modes.clean import find_orphans

    pristine = _corpus(tmp_path, {_cache('org/kept'): 'org/kept'})
    orphans, _kept, unknown = find_orphans(pristine, {'repositories': [_repo('org/kept')]})

    assert 'INDEX.md' not in {p.name for p, _f, _r in orphans}
    assert 'INDEX.md' not in {p.name for p, _why in unknown}


@pytest.mark.parametrize("config", [
    {'repositories': [{}]},
    {'repositories': [{'full_name': ''}]},
    {'repositories': [{'full_name': 'Org/a'}, {'clone_url': 'x'}]},
])
def test_a_repository_entry_without_a_name_refuses_rather_than_shrinking_the_corpus(
        tmp_path, config):
    """Skipping a nameless entry quietly shrank the configured set, turning live caches into
    orphans — Codex reproduced a live clone and its metadata being deleted this way."""
    from repo_radar.modes.clean import find_orphans, UnusableConfig

    pristine = _corpus(tmp_path, {_cache('org/kept'): 'org/kept'})
    with pytest.raises(UnusableConfig):
        find_orphans(pristine, config)


def test_a_malformed_cache_index_refuses_but_an_absent_one_does_not(tmp_path):
    """Absent is a legitimate pre-migration state; unreadable may be the only evidence that a
    nonstandard directory is live, so losing it must not read as "no mappings"."""
    from repo_radar.modes.clean import find_orphans, UnusableConfig, MALFORMED_CACHE_INDEX

    pristine = _corpus(tmp_path, {_cache('org/kept'): 'org/kept'})
    config = {'repositories': [_repo('org/kept')]}

    with pytest.raises(UnusableConfig):
        find_orphans(pristine, config, MALFORMED_CACHE_INDEX)

    orphans, kept, _unknown = find_orphans(pristine, config, None)
    assert orphans == [] and len(kept) == 2, 'an absent cache index is fine'


def test_a_metadata_file_with_no_usable_frontmatter_is_not_ours_to_delete(tmp_path):
    """`meeting-deadbee.md` matches <name>-<7hex>. Filename shape is not ownership evidence."""
    from repo_radar.modes.clean import find_orphans

    pristine = _corpus(tmp_path, {_cache('org/kept'): 'org/kept'})
    (pristine / 'meeting-deadbee.md').write_text('# Notes from the meeting\n\nNo frontmatter.\n')

    orphans, _kept, unknown = find_orphans(pristine, {'repositories': [_repo('org/kept')]})

    assert orphans == []
    assert [p.name for p, _why in unknown] == ['meeting-deadbee.md']


def test_a_configured_repo_under_a_migrated_cache_name_is_kept(tmp_path):
    """Its metadata identifies it as configured; believing only the computed name deleted it."""
    from repo_radar.modes.clean import find_orphans

    pristine = tmp_path / 'pristine'
    pristine.mkdir()
    migrated = pristine / 'kept-oldstyle01'
    migrated.mkdir()
    (migrated / '.git').mkdir()
    (pristine / 'kept-oldstyle01.md').write_text(
        '---\nfull_name: org/kept\ncache_dir: kept-oldstyle01\n---\n')
    (pristine / 'INDEX.md').write_text('# Index\n')

    orphans, kept, _unknown = find_orphans(pristine, {'repositories': [_repo('org/kept')]})

    assert orphans == [], 'frontmatter identity must preserve a configured migrated cache'
    assert {p.name for p, _f in kept} == {'kept-oldstyle01', 'kept-oldstyle01.md'}


def test_repository_identity_is_compared_case_insensitively(tmp_path):
    """GitHub identities are case-insensitive, so Org/Kept and org/kept are one repository.
    Comparing exactly classified a live clone AND its metadata as orphans."""
    from repo_radar.modes.clean import find_orphans

    pristine = tmp_path / 'pristine'
    pristine.mkdir()
    migrated = pristine / 'kept-oldstyle01'
    migrated.mkdir()
    (migrated / '.git').mkdir()
    (pristine / 'kept-oldstyle01.md').write_text(
        '---\nfull_name: org/kept\ncache_dir: kept-oldstyle01\n---\n')
    (pristine / 'INDEX.md').write_text('# Index\n')

    orphans, kept, _unknown = find_orphans(
        pristine, {'repositories': [{'full_name': 'Org/Kept',
                                     'clone_url': 'https://github.com/Org/Kept.git'}]})

    assert orphans == [], 'a case-only difference is the same repository'
    assert len(kept) == 2


@pytest.mark.parametrize("repo", [
    {'full_name': 'org/kept'},                                  # no clone_url at all
    {'full_name': 'org/kept', 'clone_url': ''},                 # empty
    {'full_name': 'org/kept', 'clone_url': '   '},              # whitespace
    {'full_name': 'org/kept', 'clone_url': None},               # null
    {'full_name': 'not-owner-slash-name', 'clone_url': 'x'},    # unusable identity
])
def test_an_unusable_configured_entry_refuses_rather_than_mislocating_its_cache(tmp_path, repo):
    """get_cache_name('', name) happily hashes the empty string, producing a name that matches
    nothing — so the repository's real directory looked unclaimed and became deletable."""
    from repo_radar.modes.clean import find_orphans, UnusableConfig

    pristine = _corpus(tmp_path, {_cache('org/kept'): 'org/kept'})
    with pytest.raises(UnusableConfig):
        find_orphans(pristine, {'repositories': [repo]})


@pytest.mark.parametrize("index", [
    {'https://github.com/org/kept.git': 123},
    {'https://github.com/org/kept.git': ''},
    {5: 'kept-abc1234'},
    {'https://github.com/org/kept.git': ['kept-abc1234']},
])
def test_a_cache_index_with_unusable_mappings_refuses(tmp_path, index):
    """A dict at the top level is not enough: a mapping we cannot use is evidence we have lost."""
    from repo_radar.modes.clean import find_orphans, UnusableConfig

    pristine = _corpus(tmp_path, {_cache('org/kept'): 'org/kept'})
    with pytest.raises(UnusableConfig):
        find_orphans(pristine, {'repositories': [_repo('org/kept')]}, index)


def test_an_ordinary_note_containing_a_full_name_line_is_not_ours(tmp_path):
    """Any Markdown with a `full_name:` line used to qualify as ownership evidence.

    Real metadata always carries owner/name AND a cache_dir naming its own entry, so requiring
    the pair costs nothing and stops an arbitrary note from becoming deletable.
    """
    from repo_radar.modes.clean import find_orphans

    pristine = _corpus(tmp_path, {_cache('org/kept'): 'org/kept'})
    (pristine / 'design-notes-abc1234.md').write_text(
        '---\nfull_name: some/project\ntitle: my notes\n---\n\nThoughts.\n')

    orphans, _kept, unknown = find_orphans(pristine, {'repositories': [_repo('org/kept')]})

    assert orphans == [], 'metadata that does not claim THIS entry proves nothing'
    assert [p.name for p, _why in unknown] == ['design-notes-abc1234.md']
