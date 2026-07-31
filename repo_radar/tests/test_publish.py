"""Context-snapshot publishing.

The consumer validates the tree as an EXACT SET and recomputes metadataSnapshotId, so almost
every mistake here fails the review rather than degrading gracefully.
"""
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import types

import pytest

from repo_radar.publish import (canonical, owner_name, rewrite_index, expected_repo_keys,
                                publish_mode, CACHE_SUFFIX)


def _repo(pristine, name, full_name, body='brief: A repository.\ntype: Library\nlanguage: Go'):
    """A cache directory with a real git commit, plus its cache-named metadata file."""
    cache = f'{name}-abc1234'
    clone = pristine / cache
    if clone.exists():
        return cache                    # idempotent: tests may publish the same corpus twice
    clone.mkdir()
    (clone / 'README.md').write_text('# x\n')
    subprocess.run(['git', 'init', '-q', '-b', 'main'], cwd=clone, check=True)
    # A real cache entry has an origin remote and its metadata records the commit it describes;
    # the publisher now requires both when a clone is present, so the fixture must be faithful.
    subprocess.run(['git', 'remote', 'add', 'origin',
                    f'https://github.com/{full_name}.git'], cwd=clone, check=True)
    subprocess.run(['git', 'add', 'README.md'], cwd=clone, check=True)
    subprocess.run(['git', '-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-qm', 'i'],
                   cwd=clone, check=True)
    head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=clone,
                          capture_output=True, text=True, check=True).stdout.strip()
    (pristine / f'{cache}.md').write_text(
        f'---\nfull_name: {full_name}\ncache_dir: {cache}\nlast_commit: {head}\n'
        f'{body}\nrelated_repos: []\n---\n\n#\n')
    # repo-radar also writes a stable-name symlink beside the canonical file; the contract
    # rejects symlinks, so the publisher must never follow or copy these.
    (pristine / f'{name}.md').symlink_to(pristine / f'{cache}.md')
    return cache


def _corpus(tmp_path, repos, indexed=None):
    """`indexed` defaults to every repo — regenerate_index omits excluded ones, so tests that
    exclude something pass the reduced set to mirror what the real index would contain."""
    pristine = tmp_path / 'pristine'
    pristine.mkdir(exist_ok=True)
    caches = {full: _repo(pristine, name, full) for name, full in repos.items()}
    listed = sorted(caches if indexed is None else indexed)
    entries = '\n\n'.join(
        f'### {full} (`{caches[full]}/`)\n**[View Details]({caches[full]}.md)**'
        for full in listed)
    (pristine / 'INDEX.md').write_text(f'# Index\n\n**Total Repositories:** {len(listed)}\n\n'
                                       f'{entries}\n')
    return pristine


def _args(out, src, **over):
    fields = {'out': str(out), 'src': str(src), 'generator_version': 'test/1',
              'generated_at': '2026-07-30T00:00:00Z', 'dry_run': False}
    fields.update(over)
    return types.SimpleNamespace(**fields)


@pytest.fixture
def publish(tmp_path, monkeypatch):
    """Publish a corpus with a config that matches it, unless a test overrides the config."""
    import repo_radar.publish as pub

    state = {}

    def run(repos, config=None, exclusions=None, indexed=None, **over):
        pristine = _corpus(tmp_path, repos, indexed=indexed)
        cfg = config if config is not None else {
            'repositories': [{'full_name': f} for f in repos.values()],
            'exclusions': exclusions or [],
        }
        monkeypatch.setattr(pub, 'load_config', lambda: cfg)
        monkeypatch.setattr(pub, 'load_exclusions', lambda c=None: cfg.get('exclusions', []))
        state['args'] = _args(tmp_path / 'snap', pristine, **over)
        return _invoke(state['args'])

    def _invoke(args):
        rc = publish_mode(args)
        out = pathlib.Path(args.out)
        manifest = json.loads((out / 'manifest.json').read_text()) if (
            out / 'manifest.json').is_file() else None
        return rc, out, manifest

    run.again = lambda: _invoke(state['args'])
    run.again_dry = lambda: _invoke(types.SimpleNamespace(
        **{**vars(state['args']), 'dry_run': True}))
    return run


def test_a_matching_corpus_publishes_a_complete_snapshot(publish, capsys):
    rc, out, manifest = publish({'alpha': 'Org/alpha', 'beta': 'Org/beta'})

    assert rc == 0
    assert set(manifest['repos']) == {'Org/alpha', 'Org/beta'}
    assert manifest['index']['path'] == 'pristine/INDEX.md'
    assert 'all agree on 2 repositories' in capsys.readouterr().out


def test_the_tree_is_an_exact_set_with_no_symlinks(publish):
    """The consumer rejects any file it was not told about, and symlinks outright."""
    rc, out, manifest = publish({'alpha': 'Org/alpha', 'beta': 'Org/beta'})

    declared = {'manifest.json', 'pristine/INDEX.md'}
    declared |= {r['metadataPath'] for r in manifest['repos'].values()}
    actual = {str(p.relative_to(out)) for p in out.rglob('*') if p.is_file()}
    assert actual == declared, "every file must be declared and every declared file must exist"
    assert [p for p in out.rglob('*') if p.is_symlink()] == []
    assert all(r['metadataPath'].count('/') == 1 and r['metadataPath'].startswith('pristine/')
               for r in manifest['repos'].values()), "metadata must be a direct child of pristine/"


def test_metadata_snapshot_id_is_the_hash_of_the_manifest_without_itself(publish):
    """Self-referential if it included itself, so the consumer recomputes it exactly this way."""
    _rc, _out, manifest = publish({'alpha': 'Org/alpha'})

    without = {k: v for k, v in manifest.items() if k != 'metadataSnapshotId'}
    expected = 'sha256:' + hashlib.sha256(canonical(without).encode('utf-8')).hexdigest()
    assert manifest['metadataSnapshotId'] == expected


def test_content_hashes_match_the_published_bytes(publish):
    _rc, out, manifest = publish({'alpha': 'Org/alpha'})

    for entry in manifest['repos'].values():
        published = (out / entry['metadataPath']).read_bytes()
        assert hashlib.sha256(published).hexdigest() == entry['metadataSha256']
    assert hashlib.sha256((out / 'pristine/INDEX.md').read_bytes()).hexdigest() \
        == manifest['index']['sha256']


def test_index_links_are_rewritten_so_nothing_dangles_inside_the_snapshot(publish):
    """The agent's first step is "read INDEX, pick a repo". Unrewritten, every link dead-ends.

    repo-radar links to the cache-named file (alpha-abc1234.md) but the snapshot publishes the
    canonical name (alpha.md), so the link has to be rewritten or the file it names is absent.
    """
    import re

    _rc, out, _manifest = publish({'alpha': 'Org/alpha', 'beta': 'Org/beta'})

    index = (out / 'pristine/INDEX.md').read_text()
    links = re.findall(r'\[View Details\]\(([^)]+)\)', index)
    assert len(links) == 2
    assert all((out / 'pristine' / link).is_file() for link in links), f'dangling: {links}'
    assert 'abc1234' not in index, 'no cache-named reference may survive into the snapshot'


def test_a_configured_repo_missing_from_the_corpus_fails_the_snapshot(publish, capsys):
    """Set equality, not a count: a snapshot that silently omits a repository is worse than one
    that fails, because the agent cannot tell the difference between "absent" and "not relevant"."""
    rc, _out, _manifest = publish(
        {'alpha': 'Org/alpha'},
        config={'repositories': [{'full_name': 'Org/alpha'}, {'full_name': 'Org/never-synced'}],
                'exclusions': []})

    assert rc == 1
    out = capsys.readouterr().out
    assert 'INCOMPLETE' in out and 'Org/never-synced' in out
    assert 'missing from INDEX' in out and 'missing from manifest' in out


def test_an_unconfigured_repo_present_in_the_corpus_fails_the_snapshot(publish, capsys):
    """The other direction: publishing metadata for a repository nobody configured means shipping
    stale orphan data to agents as though it were current."""
    rc, _out, _manifest = publish(
        {'alpha': 'Org/alpha', 'ghost': 'Org/ghost'},
        config={'repositories': [{'full_name': 'Org/alpha'}], 'exclusions': []})

    assert rc == 1
    out = capsys.readouterr().out
    assert 'Org/ghost' in out and 'not configured' in out


def test_excluded_repositories_are_neither_published_nor_counted_as_missing(publish, capsys):
    """Metadata may linger on disk after an exclusion; the snapshot must simply omit it."""
    rc, _out, manifest = publish({'alpha': 'Org/alpha', 'firmware': 'Org/firmware'},
                                 exclusions=['firmware'], indexed=['Org/alpha'])

    assert rc == 0, 'an exclusion is a decision, not an incomplete snapshot'
    assert set(manifest['repos']) == {'Org/alpha'}
    assert 'all agree on 1 repositor' in capsys.readouterr().out


def test_an_index_still_advertising_an_excluded_repo_fails(publish, capsys):
    """If the index has not been regenerated since the exclusion, it promises a file the snapshot
    does not contain — so the agent's first step dead-ends. Fail rather than ship that."""
    rc, _out, _manifest = publish({'alpha': 'Org/alpha', 'firmware': 'Org/firmware'},
                                  exclusions=['firmware'])

    assert rc == 1
    out = capsys.readouterr().out
    assert 'Org/firmware' in out and 'INDEX but not configured' in out


def test_publishing_refuses_to_delete_a_directory_it_did_not_create(publish, tmp_path, capsys):
    """--out is a path a human typed. Overwriting requires evidence it is a previous snapshot."""
    victim = tmp_path / 'snap'
    victim.mkdir()
    (victim / 'important.txt').write_text('do not delete me')

    rc, _out, _manifest = publish({'alpha': 'Org/alpha'})

    assert rc == 1
    assert 'not a valid previous snapshot' in capsys.readouterr().out
    assert (victim / 'important.txt').read_text() == 'do not delete me'


def test_a_clean_previous_snapshot_is_replaced_atomically(publish, tmp_path):
    """Republishing over a valid snapshot swaps in a fresh tree with nothing carried over."""
    rc, out, first = publish({'alpha': 'Org/alpha', 'beta': 'Org/beta'})
    assert rc == 0

    rc, out, manifest = publish.again()

    assert rc == 0
    declared = {'manifest.json', 'pristine/INDEX.md'}
    declared |= {r['metadataPath'] for r in manifest['repos'].values()}
    assert {str(p.relative_to(out)) for p in out.rglob('*') if p.is_file()} == declared
    assert not list(tmp_path.glob('.snap.staging-*')), 'staging must be cleaned up'
    assert not list(tmp_path.glob('.snap.previous-*')), 'the retired tree must be removed'


def test_the_manifest_is_canonical_json_so_the_id_is_reproducible(publish):
    _rc, out, manifest = publish({'alpha': 'Org/alpha', 'beta': 'Org/beta'})

    raw = (out / 'manifest.json').read_text()
    assert raw == canonical(manifest), 'sorted keys, no whitespace — JCS-equivalent for schema v1'
    assert '\n' not in raw.strip(), 'canonical JSON is a single line'


def test_owner_name_parses_both_remote_forms():
    assert owner_name('git@github.com:Org/Name.git') == 'Org/Name'
    assert owner_name('https://github.com/Org/Name.git') == 'Org/Name'
    assert owner_name('https://github.com/Org/Name') == 'Org/Name'
    assert owner_name(None) is None
    assert owner_name('') is None


def test_cache_suffix_only_strips_a_real_hash():
    assert CACHE_SUFFIX.sub('', 'reperio-mcp-1a2b3c4') == 'reperio-mcp'
    assert CACHE_SUFFIX.sub('', 'reperio-mcp') == 'reperio-mcp', 'no suffix, nothing to strip'
    assert CACHE_SUFFIX.sub('', 'my-repo-v2') == 'my-repo-v2', 'not hex, not a cache suffix'


def test_rewrite_index_leaves_unrelated_text_alone():
    text, count = rewrite_index('see (alpha-abc1234.md) and `alpha-abc1234/` and alpha-abc1234',
                                {'alpha-abc1234': 'alpha'})
    assert count == 2, 'only the link and the cache-dir forms are rewritten'
    assert '(alpha.md)' in text and '`alpha/`' in text
    assert text.endswith('alpha-abc1234'), 'a bare mention is not a link and is left as-is'


def test_expected_keys_ignore_blank_and_excluded_entries():
    config = {'repositories': [{'full_name': 'Org/a'}, {'full_name': '  '}, {},
                               {'full_name': 'Org/skip'}]}
    assert expected_repo_keys(config, ['skip']) == {'Org/a'}
    assert expected_repo_keys({}, []) == set()


# ── adversarial: destructive and success-reporting paths ─────────────────────────────────

def test_publishing_into_the_corpus_is_refused(tmp_path, monkeypatch, capsys):
    """--src snapshot/pristine --out snapshot would delete its own source before copying it."""
    import repo_radar.publish as pub

    pristine = _corpus(tmp_path, {'alpha': 'Org/alpha'})
    monkeypatch.setattr(pub, 'load_config', lambda: {'repositories': [{'full_name': 'Org/alpha'}]})
    monkeypatch.setattr(pub, 'load_exclusions', lambda c=None: [])

    for out in (pristine, pristine.parent, pristine / 'nested'):
        rc = publish_mode(_args(out, pristine))
        assert rc == 1, f'{out} overlaps the source and must be refused'
        assert 'overlaps' in capsys.readouterr().out
    assert (pristine / 'INDEX.md').is_file(), 'the corpus must be untouched'


def test_a_directory_with_a_token_manifest_is_not_treated_as_a_snapshot(tmp_path, capsys):
    """`{}` parses as JSON, so requiring only "a file named manifest.json" deleted real data."""
    from repo_radar.publish import looks_like_snapshot

    victim = tmp_path / 'notes'
    victim.mkdir()
    (victim / 'manifest.json').write_text('{}')
    (victim / 'important.txt').write_text('keep me')

    ok, why = looks_like_snapshot(victim)
    assert not ok and 'schemaVersion' in why


def test_a_genuine_snapshot_is_replaceable(publish):
    """The positive control: whatever else is rejected, a real snapshot must be replaceable."""
    from repo_radar.publish import looks_like_snapshot

    _rc, out, _m = publish({'alpha': 'Org/alpha'})
    ok, why = looks_like_snapshot(out)
    assert ok, why


def test_a_snapshot_missing_a_declared_file_is_not_replaceable(publish):
    from repo_radar.publish import looks_like_snapshot

    _rc, out, manifest = publish({'alpha': 'Org/alpha'})
    (out / manifest['repos']['Org/alpha']['metadataPath']).unlink()

    ok, why = looks_like_snapshot(out)
    assert not ok and 'missing' in why


def test_a_snapshot_holding_an_undeclared_file_is_not_replaceable(publish):
    """Ownership of EVERY file must be proven before any of them is deleted.

    Tolerating extras was my earlier relaxation and it was wrong: the tree is now built in a
    staging directory and swapped in, so a failed run leaves no debris in the destination — which
    was the only argument for it. A valid manifest beside unrelated files proves nothing about
    those files.
    """
    from repo_radar.publish import looks_like_snapshot

    _rc, out, _m = publish({'alpha': 'Org/alpha'})
    (out / 'someone-elses-notes.txt').write_text('not ours')

    ok, why = looks_like_snapshot(out)
    assert not ok and 'undeclared' in why


def test_a_tampered_snapshot_id_makes_a_directory_unreplaceable(publish):
    """The id is what makes a snapshot self-certifying, so it is part of proving ownership."""
    from repo_radar.publish import looks_like_snapshot

    _rc, out, manifest = publish({'alpha': 'Org/alpha'})
    manifest['metadataSnapshotId'] = 'not-a-hash'
    (out / 'manifest.json').write_text(canonical(manifest))

    ok, why = looks_like_snapshot(out)
    assert not ok and 'metadataSnapshotId' in why


@pytest.mark.parametrize("mutate,expected", [
    (lambda m: m['index'].__setitem__('path', 'elsewhere/INDEX.md'), 'index.path'),
    (lambda m: m['index'].__setitem__('sha256', 'zz'), 'index.sha256'),
    (lambda m: m['repos']['Org/alpha'].__setitem__('sourceCommit', 'nope'), 'sourceCommit'),
    (lambda m: m['repos']['Org/alpha'].__setitem__('metadataSha256', 'nope'), 'metadataSha256'),
    (lambda m: m['repos']['Org/alpha'].__setitem__('metadataPath', 'pristine/INDEX.md'),
     'metadataPath'),
])
def test_every_manifest_field_is_validated_before_a_directory_may_be_replaced(
        publish, mutate, expected):
    """A schema-1 manifest alone was enough; each of these was previously accepted."""
    from repo_radar.publish import looks_like_snapshot

    _rc, out, manifest = publish({'alpha': 'Org/alpha'})
    mutate(manifest)
    (out / 'manifest.json').write_text(canonical(manifest))

    ok, why = looks_like_snapshot(out)
    assert not ok and expected in why


def test_a_failed_publish_leaves_the_previous_snapshot_intact(publish, tmp_path):
    """Building straight into --out deleted a known-good snapshot before knowing the new one
    was valid, and a failure then left a partial tree that still carried manifest.json."""
    rc, out, good = publish({'alpha': 'Org/alpha'})
    assert rc == 0
    before = (out / 'manifest.json').read_text()

    rc, out, _ = publish({'alpha': 'Org/alpha'},
                         config={'repositories': [{'full_name': 'Org/alpha'},
                                                  {'full_name': 'Org/missing'}],
                                 'exclusions': []})

    assert rc == 1
    assert (out / 'manifest.json').read_text() == before, 'the good snapshot must survive'
    assert not (out.parent / f'.{out.name}.staging').exists(), 'staging must be cleaned up'


def test_two_repositories_with_the_same_basename_fail_rather_than_overwrite(
        tmp_path, monkeypatch, capsys):
    """OrgA/foo and OrgB/foo both canonicalise to pristine/foo.md.

    Unchecked, the second copy overwrites the first, both manifest entries point at one file, and
    one recorded hash describes bytes that are no longer there — and the run reports success.
    """
    import repo_radar.publish as pub

    pristine = tmp_path / 'pristine'
    pristine.mkdir()
    for cache, full in (('foo-abc1234', 'OrgA/foo'), ('foo-def5678', 'OrgB/foo')):
        clone = pristine / cache
        clone.mkdir()
        (clone / 'R.md').write_text(f'# {full}\n')
        subprocess.run(['git', 'init', '-q', '-b', 'main'], cwd=clone, check=True)
        subprocess.run(['git', 'remote', 'add', 'origin',
                        f'https://github.com/{full}.git'], cwd=clone, check=True)
        subprocess.run(['git', 'add', 'R.md'], cwd=clone, check=True)
        subprocess.run(['git', '-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-qm', 'i'],
                       cwd=clone, check=True)
        head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=clone,
                              capture_output=True, text=True).stdout.strip()
        (pristine / f'{cache}.md').write_text(
            f'---\nfull_name: {full}\ncache_dir: {cache}\nlast_commit: {head}\n'
            f'brief: b\ntype: Library\nlanguage: Go\n---\n')
    (pristine / 'INDEX.md').write_text(
        '# Index\n\n### OrgA/foo (`foo-abc1234/`)\n**[View Details](foo-abc1234.md)**\n\n'
        '### OrgB/foo (`foo-def5678/`)\n**[View Details](foo-def5678.md)**\n')

    cfg = {'repositories': [{'full_name': 'OrgA/foo'}, {'full_name': 'OrgB/foo'}],
           'exclusions': []}
    monkeypatch.setattr(pub, 'load_config', lambda: cfg)
    monkeypatch.setattr(pub, 'load_exclusions', lambda c=None: [])

    rc = publish_mode(_args(tmp_path / 'snap', pristine))

    assert rc == 1
    out = capsys.readouterr().out
    assert 'name collision' in out and 'pristine/foo.md' in out
    assert not (tmp_path / 'snap').exists(), 'nothing may be published on a collision'


def test_stale_metadata_is_refused_rather_than_mislabelled(tmp_path, monkeypatch, capsys):
    """sourceCommit must name the commit the METADATA describes.

    Preferring the clone's HEAD published a commit the metadata had never seen whenever analysis
    failed or was skipped after a pull, telling the agent "this describes B" when it described A.
    """
    import repo_radar.publish as pub

    pristine = _corpus(tmp_path, {'alpha': 'Org/alpha'})
    clone = pristine / 'alpha-abc1234'
    md = pristine / 'alpha-abc1234.md'
    head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=clone,
                          capture_output=True, text=True).stdout.strip()
    stale = 'a' * 40
    assert head.lower() != stale
    md.write_text(re.sub(r'last_commit: .*', f'last_commit: {stale}', md.read_text()))

    cfg = {'repositories': [{'full_name': 'Org/alpha'}], 'exclusions': []}
    monkeypatch.setattr(pub, 'load_config', lambda: cfg)
    monkeypatch.setattr(pub, 'load_exclusions', lambda c=None: [])

    rc = publish_mode(_args(tmp_path / 'snap', pristine))

    assert rc == 1
    out = capsys.readouterr().out
    assert 'metadata is stale' in out and 're-sync before publishing' in out


def test_duplicates_are_caught_before_set_comparison_collapses_them(tmp_path, monkeypatch, capsys):
    """Converting to sets makes a repository listed twice — in config or in INDEX — disappear,
    so the publisher could report exact agreement over an ambiguous index."""
    import repo_radar.publish as pub

    pristine = _corpus(tmp_path, {'alpha': 'Org/alpha'})
    index = pristine / 'INDEX.md'
    index.write_text(index.read_text() + '\n### Org/alpha (`alpha-abc1234/`)\n')

    cfg = {'repositories': [{'full_name': 'Org/alpha'}, {'full_name': 'Org/alpha'}],
           'exclusions': []}
    monkeypatch.setattr(pub, 'load_config', lambda: cfg)
    monkeypatch.setattr(pub, 'load_exclusions', lambda c=None: [])

    rc = publish_mode(_args(tmp_path / 'snap', pristine))

    assert rc == 1
    out = capsys.readouterr().out
    assert 'appears 2 times in the configured repositories' in out
    assert 'has 2 sections in INDEX.md' in out


def test_dry_run_returns_the_same_verdict_as_a_real_publish(publish, tmp_path, capsys):
    """A dry run that skips validation previews success for a corpus the real run rejects."""
    bad = {'repositories': [{'full_name': 'Org/alpha'}, {'full_name': 'Org/missing'}],
           'exclusions': []}

    rc_dry, _out, _ = publish({'alpha': 'Org/alpha'}, config=bad, dry_run=True)
    assert rc_dry == 1, 'the dry run must reach the same conclusion'
    out = capsys.readouterr().out
    assert 'DRY RUN' in out and 'INCOMPLETE' in out
    assert not (tmp_path / 'snap').exists(), 'a dry run must not write anything'
    assert not list(tmp_path.glob('.snap.staging-*')), 'nor leave its scratch directory behind'

    rc_real, _out, _ = publish({'alpha': 'Org/alpha'}, config=bad)
    assert rc_real == rc_dry


def test_dry_run_passes_when_the_real_publish_would(publish, capsys):
    rc, _out, _ = publish({'alpha': 'Org/alpha'}, dry_run=True)
    assert rc == 0
    assert 'Validation passed' in capsys.readouterr().out


def test_publishing_never_touches_deterministically_named_siblings(publish, tmp_path):
    """`.snap.staging` and `.snap.previous` were fixed names this code rmtree'd unconditionally,
    so a SUCCESSFUL publish destroyed sibling directories that happened to carry them."""
    for name in ('.snap.staging', '.snap.previous'):
        victim = tmp_path / name
        victim.mkdir()
        (victim / 'important.txt').write_text('mine')

    rc, _out, _m = publish({'alpha': 'Org/alpha'})

    assert rc == 0
    for name in ('.snap.staging', '.snap.previous'):
        assert (tmp_path / name / 'important.txt').read_text() == 'mine', \
            f'{name} belongs to someone else'


def test_a_repository_named_index_cannot_overwrite_the_snapshot_index(tmp_path, monkeypatch,
                                                                      capsys):
    """A repo whose canonical name is INDEX publishes to pristine/INDEX.md — the generated index."""
    import repo_radar.publish as pub

    pristine = _corpus(tmp_path, {'INDEX': 'Org/INDEX', 'alpha': 'Org/alpha'})
    cfg = {'repositories': [{'full_name': 'Org/INDEX'}, {'full_name': 'Org/alpha'}],
           'exclusions': []}
    monkeypatch.setattr(pub, 'load_config', lambda: cfg)
    monkeypatch.setattr(pub, 'load_exclusions', lambda c=None: [])

    rc = publish_mode(_args(tmp_path / 'snap', pristine))

    assert rc == 1
    assert 'reserved' in capsys.readouterr().out


def test_dry_run_and_real_publish_agree_on_an_unrelated_destination(publish, tmp_path, capsys):
    """Reproduced by Codex: dry run returned 0 where the real publish returned 1."""
    victim = tmp_path / 'snap'
    victim.mkdir()
    (victim / 'important.txt').write_text('mine')

    rc_dry, _o, _m = publish({'alpha': 'Org/alpha'}, dry_run=True)
    capsys.readouterr()
    rc_real, _o, _m = publish({'alpha': 'Org/alpha'})

    assert rc_dry == rc_real == 1, 'both must refuse an unrelated destination'
    assert (victim / 'important.txt').read_text() == 'mine'


def test_dry_run_and_real_publish_agree_on_an_oversized_metadata_file(publish, tmp_path, capsys):
    """The other reproduction: a file over MAX_FILE passed dry run and failed the real publish."""
    from repo_radar.publish import MAX_FILE

    pristine = tmp_path / 'pristine'
    rc_first, _o, _m = publish({'alpha': 'Org/alpha'})
    assert rc_first == 0
    md = pristine / 'alpha-abc1234.md'
    md.write_text(md.read_text() + 'x' * (MAX_FILE + 1))

    capsys.readouterr()
    rc_dry, _o, _m = publish.again_dry()
    dry_out = capsys.readouterr().out
    rc_real, _o, _m = publish.again()

    assert rc_dry == rc_real == 1
    assert 'LIMIT' in dry_out or 'too large' in dry_out


def test_a_clone_without_a_readable_origin_is_refused(tmp_path, monkeypatch, capsys):
    """Missing evidence is not evidence: an unresolvable origin was accepted, publishing
    unproven source under whatever identity the frontmatter claimed."""
    import repo_radar.publish as pub

    pristine = _corpus(tmp_path, {'alpha': 'Org/alpha'})
    subprocess.run(['git', 'remote', 'remove', 'origin'],
                   cwd=pristine / 'alpha-abc1234', check=True)
    cfg = {'repositories': [{'full_name': 'Org/alpha'}], 'exclusions': []}
    monkeypatch.setattr(pub, 'load_config', lambda: cfg)
    monkeypatch.setattr(pub, 'load_exclusions', lambda c=None: [])

    rc = publish_mode(_args(tmp_path / 'snap', pristine))

    assert rc == 1
    assert 'origin remote is unreadable' in capsys.readouterr().out


def test_a_clone_whose_origin_contradicts_the_metadata_is_refused(tmp_path, monkeypatch, capsys):
    import repo_radar.publish as pub

    pristine = _corpus(tmp_path, {'alpha': 'Org/alpha'})
    subprocess.run(['git', 'remote', 'set-url', 'origin',
                    'https://github.com/Someone/else.git'],
                   cwd=pristine / 'alpha-abc1234', check=True)
    cfg = {'repositories': [{'full_name': 'Org/alpha'}], 'exclusions': []}
    monkeypatch.setattr(pub, 'load_config', lambda: cfg)
    monkeypatch.setattr(pub, 'load_exclusions', lambda c=None: [])

    rc = publish_mode(_args(tmp_path / 'snap', pristine))

    assert rc == 1
    assert 'identity mismatch' in capsys.readouterr().out


def test_a_modified_index_makes_a_snapshot_unreplaceable(publish):
    """index.sha256 was validated for SHAPE but never compared with the file's bytes, so an
    edited INDEX.md still certified the directory as ours to delete."""
    from repo_radar.publish import looks_like_snapshot

    _rc, out, _m = publish({'alpha': 'Org/alpha'})
    index = out / 'pristine/INDEX.md'
    index.write_text(index.read_text() + '\nedited by someone else\n')

    ok, why = looks_like_snapshot(out)
    assert not ok and 'index.sha256' in why


def test_an_undeclared_empty_directory_makes_a_snapshot_unreplaceable(publish):
    """The inventory listed only regular files, so a directory the manifest never mentioned
    passed validation and was then deleted with the rest of the tree."""
    from repo_radar.publish import looks_like_snapshot

    _rc, out, _m = publish({'alpha': 'Org/alpha'})
    (out / 'someone-elses-folder').mkdir()

    ok, why = looks_like_snapshot(out)
    assert not ok and 'undeclared directory' in why


def test_a_special_filesystem_entry_makes_a_snapshot_unreplaceable(publish):
    """is_file() reports nothing at all for a FIFO, so it never appeared in the inventory."""
    from repo_radar.publish import looks_like_snapshot

    _rc, out, _m = publish({'alpha': 'Org/alpha'})
    os.mkfifo(out / 'pipe')

    ok, why = looks_like_snapshot(out)
    assert not ok and 'special filesystem entry' in why


def test_a_destination_replaced_after_validation_is_not_deleted(publish, tmp_path, monkeypatch,
                                                                capsys):
    """Validating `out` and then renaming it validates one object and deletes whatever occupies
    that PATHNAME afterwards. Codex swapped the directory in between and watched a successful
    publish destroy an unrelated file."""
    import repo_radar.publish as pub

    rc, out, _m = publish({'alpha': 'Org/alpha'})
    assert rc == 0

    # Replace the validated snapshot with someone else's directory at the last possible moment:
    # after the pre-build check, immediately before the swap.
    real_looks = pub.looks_like_snapshot
    swapped = {'done': False}

    def sneaky(path):
        verdict = real_looks(path)
        if not swapped['done'] and pathlib.Path(path) == out:
            swapped['done'] = True
            shutil.rmtree(out)
            out.mkdir()
            (out / 'important.txt').write_text('MINE')
        return verdict
    monkeypatch.setattr(pub, 'looks_like_snapshot', sneaky)

    rc = pub.publish_mode(_args(out, tmp_path / 'pristine'))

    assert rc == 1, 'the substituted directory must not be published over'
    assert (out / 'important.txt').read_text() == 'MINE', 'and must survive untouched'


def test_a_dry_run_leaves_no_trace_next_to_the_destination(publish, tmp_path, capsys):
    """It created out's parent hierarchy and a lock file just to have somewhere to stage."""
    rc, _o, _m = publish({'alpha': 'Org/alpha'}, dry_run=True)

    assert rc == 0
    leftovers = sorted(p.name for p in tmp_path.iterdir() if p.name != 'pristine')
    assert leftovers == [], f'a dry run must change nothing: {leftovers}'


def test_a_second_publisher_is_refused_while_one_holds_the_destination(publish, tmp_path):
    """Two concurrent publishes could each move the other's freshly installed snapshot aside."""
    import repo_radar.publish as pub

    rc, out, _m = publish({'alpha': 'Org/alpha'})
    assert rc == 0
    held, _why = pub._acquire_lock(out)
    assert held is not None
    try:
        blocked, why = pub._acquire_lock(out)
        assert blocked is None and 'already writing' in why
    finally:
        pub._release_lock(held)
    regained, _why = pub._acquire_lock(out)
    assert regained is not None, 'the lock must be released afterwards'
    pub._release_lock(regained)


def test_the_lock_never_truncates_what_it_opens(publish, tmp_path):
    """open(path, 'w') follows symlinks and TRUNCATES before any lock is held, so pointing the
    predictable lock name at a real file emptied it — during a SUCCESSFUL publish."""
    victim = tmp_path / 'important.txt'
    victim.write_text('DO NOT TRUNCATE')
    (tmp_path / '.snap.publish.lock').symlink_to(victim)

    rc, _out, _m = publish({'alpha': 'Org/alpha'})

    assert victim.read_text() == 'DO NOT TRUNCATE', 'the lock must never write through a symlink'
    assert rc == 1, 'and a lock it cannot take safely must stop the publish'


def test_the_lock_is_released_even_when_it_cannot_be_taken(publish, tmp_path):
    """The failure path used to leak the open handle."""
    import repo_radar.publish as pub

    rc, out, _m = publish({'alpha': 'Org/alpha'})
    assert rc == 0
    for _ in range(50):
        held, why = pub._acquire_lock(out)
        assert held is not None, f'descriptors must not leak across attempts ({why})'
        pub._release_lock(held)


def test_a_quarantined_snapshot_substituted_after_validation_is_not_deleted(
        publish, tmp_path, monkeypatch, capsys):
    """The move bound validation to one object; deletion then trusted the pathname again."""
    import repo_radar.publish as pub

    rc, out, _m = publish({'alpha': 'Org/alpha'})
    assert rc == 0

    real_looks = pub.looks_like_snapshot
    swapped = {}

    def sneaky(path):
        verdict = real_looks(path)
        p = pathlib.Path(path)
        if p != out and p.name.startswith('.snap.previous-') and not swapped:
            shutil.rmtree(p)
            p.mkdir()
            (p / 'important.txt').write_text('MINE')
            swapped['at'] = p
        return verdict
    monkeypatch.setattr(pub, 'looks_like_snapshot', sneaky)

    rc = pub.publish_mode(_args(out, tmp_path / 'pristine'))

    assert swapped, 'precondition: the quarantined tree was substituted'
    assert (swapped['at'] / 'important.txt').read_text() == 'MINE', \
        'deletion must be bound to the object that was validated'


def test_a_failure_after_quarantine_restores_the_previous_snapshot(publish, tmp_path,
                                                                   monkeypatch, capsys):
    """An exception after the move used to leave `out` absent and the real snapshot stranded
    under a .previous-* name nobody was told about."""
    import repo_radar.publish as pub

    rc, out, manifest = publish({'alpha': 'Org/alpha'})
    assert rc == 0
    before = (out / 'manifest.json').read_text()

    def boom(path):
        raise OSError('verification exploded')
    monkeypatch.setattr(pub, 'looks_like_snapshot', boom)

    rc = pub.publish_mode(_args(out, tmp_path / 'pristine'))

    assert rc == 1
    assert out.is_dir(), 'the destination must not be left absent'
    assert (out / 'manifest.json').read_text() == before, 'the snapshot must be restored intact'
    assert not list(tmp_path.glob('.snap.previous-*')), 'and nothing stranded'


def test_a_destination_reappearing_before_installation_is_not_overwritten(publish, tmp_path,
                                                                          monkeypatch, capsys):
    """os.rename silently replaces an empty directory, and we have proven nothing about one that
    appeared after the move."""
    import repo_radar.publish as pub

    rc, out, _m = publish({'alpha': 'Org/alpha'})
    assert rc == 0

    real_looks = pub.looks_like_snapshot

    def recreate(path):
        verdict = real_looks(path)
        if not out.exists():
            out.mkdir()
            (out / 'important.txt').write_text('MINE')
        return verdict
    monkeypatch.setattr(pub, 'looks_like_snapshot', recreate)

    rc = pub.publish_mode(_args(out, tmp_path / 'pristine'))

    assert rc == 1
    assert (out / 'important.txt').read_text() == 'MINE', 'the intruder must survive'
    report = capsys.readouterr().out
    assert 'intact at' in report, 'and the quarantined snapshot must be located for the user'


def test_content_added_to_the_quarantine_after_validation_is_not_deleted(publish, tmp_path,
                                                                         monkeypatch, capsys):
    """The root inode says nothing about the CONTENTS. A file added after validation was swept up
    by rmtree, and the run still reported success."""
    import repo_radar.publish as pub

    rc, out, _m = publish({'alpha': 'Org/alpha'})
    assert rc == 0

    real_looks = pub.looks_like_snapshot
    planted = {}

    def plant(path):
        verdict = real_looks(path)
        p = pathlib.Path(path)
        if p.name.startswith('.snap.previous-') and 'at' not in planted:
            (p / 'important.txt').write_text('MINE')
            planted['at'] = p / 'important.txt'
        return verdict
    monkeypatch.setattr(pub, 'looks_like_snapshot', plant)

    rc = pub.publish_mode(_args(out, tmp_path / 'pristine'))

    assert planted, 'precondition: content was added to the quarantined tree'
    assert planted['at'].read_text() == 'MINE', 'unvalidated content must never be deleted'
    report = capsys.readouterr().out
    assert 'new content appeared' in report and 'retained at' in report


def test_cleanup_refuses_a_quarantine_substituted_after_the_final_check(publish, tmp_path,
                                                                        monkeypatch, capsys):
    """The window between the last lstat and the deletion. Enumerated, no-follow deletion closes
    it: we unlink the specific verified names, so a replacement's contents do not match."""
    import repo_radar.publish as pub

    rc, out, _m = publish({'alpha': 'Org/alpha'})
    assert rc == 0

    real_remove = pub._remove_exact
    swapped = {}

    def swap_then_remove(root, manifest):
        root = pathlib.Path(root)
        if 'at' not in swapped:
            shutil.rmtree(root)
            root.mkdir()
            (root / 'important.txt').write_text('MINE')
            swapped['at'] = root / 'important.txt'
        return real_remove(root, manifest)
    monkeypatch.setattr(pub, '_remove_exact', swap_then_remove)

    rc = pub.publish_mode(_args(out, tmp_path / 'pristine'))

    assert swapped, 'precondition: the quarantine was substituted'
    assert swapped['at'].read_text() == 'MINE', 'a substituted tree must not be deleted'


def test_restoration_refuses_a_substituted_quarantine(publish, tmp_path, monkeypatch, capsys):
    """_restore renamed whatever answered to that path, so a substitution during validation made
    an unrelated directory become the destination while the real snapshot stayed hidden."""
    import repo_radar.publish as pub

    rc, out, _m = publish({'alpha': 'Org/alpha'})
    assert rc == 0
    hidden = tmp_path / 'hidden'

    def swap_and_fail(path):
        p = pathlib.Path(path)
        if p.name.startswith('.snap.previous-'):
            shutil.move(str(p), str(hidden))       # move the real snapshot away
            p.mkdir()
            (p / 'important.txt').write_text('MINE')
            return False, 'pretend it is invalid'
        return True, 'ok'
    monkeypatch.setattr(pub, 'looks_like_snapshot', swap_and_fail)

    rc = pub.publish_mode(_args(out, tmp_path / 'pristine'))

    assert rc == 1
    report = capsys.readouterr().out
    assert 'no longer the tree that was moved there' in report
    assert 'quarantined :' in report and 'destination :' in report
    assert not out.exists(), 'the substitute must not be installed as the destination'
    assert (hidden / 'manifest.json').is_file(), 'the real snapshot is still recoverable'


def test_an_interrupt_after_quarantine_restores_and_re_raises(publish, tmp_path, monkeypatch):
    """`except Exception` let Ctrl-C escape with the destination absent and the old snapshot
    stranded under a name nobody was told about."""
    import repo_radar.publish as pub

    rc, out, _m = publish({'alpha': 'Org/alpha'})
    assert rc == 0
    before = (out / 'manifest.json').read_text()

    def interrupt(path):
        raise KeyboardInterrupt()
    monkeypatch.setattr(pub, 'looks_like_snapshot', interrupt)

    with pytest.raises(KeyboardInterrupt):
        pub.publish_mode(_args(out, tmp_path / 'pristine'))

    assert out.is_dir(), 'the destination must not be left absent'
    assert (out / 'manifest.json').read_text() == before
    assert not list(tmp_path.glob('.snap.previous-*')), 'nothing stranded'


def test_the_lock_failure_path_closes_its_descriptor(publish, tmp_path):
    """The previous test only ever acquired successfully, so removing the failure-path close
    left it green. This one exercises the contended branch repeatedly."""
    import repo_radar.publish as pub

    rc, out, _m = publish({'alpha': 'Org/alpha'})
    assert rc == 0
    held, _why = pub._acquire_lock(out)
    assert held is not None
    try:
        for _ in range(80):
            blocked, why = pub._acquire_lock(out)
            assert blocked is None and 'already writing' in why
    finally:
        pub._release_lock(held)


def test_the_inventory_reports_a_mount_point_without_crashing(tmp_path, monkeypatch):
    """The mount branch appended two tuples for one path, so sorted() compared an os.stat_result
    against None and raised — the check could not fire without crashing first."""
    from repo_radar.publish import _inventory

    root = tmp_path / 'tree'
    (root / 'pristine').mkdir(parents=True)
    (root / 'manifest.json').write_text('{}')

    real_lstat = os.lstat

    def fake_lstat(path, *a, **k):
        return real_lstat(path, *a, **k)
    # Present `pristine` as living on another device.
    real_scandir = os.scandir

    class FakeStat:
        def __init__(self, info, dev):
            self._info, self.st_dev = info, dev
            self.st_mode = info.st_mode

    def fake_scandir(target):
        for entry in real_scandir(target):
            yield _FakeEntry(entry, root)
    monkeypatch.setattr(os, 'scandir', fake_scandir)

    found = sorted(_inventory(root))        # must not raise

    reasons = [why for _rel, _info, why in found if why]
    assert any('mount point' in r for r in reasons), reasons


class _FakeEntry:
    """A scandir entry that reports `pristine` on a different device."""

    def __init__(self, entry, root):
        self._entry = entry
        self._root = root
        self.name = entry.name
        self.path = entry.path

    def is_symlink(self):
        return self._entry.is_symlink()

    def stat(self, follow_symlinks=True):
        info = self._entry.stat(follow_symlinks=follow_symlinks)
        if self._entry.name == 'pristine':
            class Shifted:
                st_mode = info.st_mode
                st_dev = info.st_dev + 1
                st_ino = info.st_ino
                st_size = info.st_size
            return Shifted()
        return info
