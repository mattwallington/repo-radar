"""Context-snapshot publishing.

The consumer validates the tree as an EXACT SET and recomputes metadataSnapshotId, so almost
every mistake here fails the review rather than degrading gracefully.
"""
import hashlib
import json
import pathlib
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
    subprocess.run(['git', 'add', 'README.md'], cwd=clone, check=True)
    subprocess.run(['git', '-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-qm', 'i'],
                   cwd=clone, check=True)
    (pristine / f'{cache}.md').write_text(
        f'---\nfull_name: {full_name}\ncache_dir: {cache}\n{body}\nrelated_repos: []\n---\n\n#\n')
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


def test_a_previous_snapshot_is_replaced_leaving_no_stale_files(publish, tmp_path):
    """Stale files from an earlier run break the exact-set validation."""
    rc, out, _ = publish({'alpha': 'Org/alpha', 'beta': 'Org/beta'})
    assert rc == 0
    (out / 'pristine' / 'stale.md').write_text('left over')

    rc, out, manifest = publish.again()

    assert rc == 0
    assert not (out / 'pristine' / 'stale.md').exists()
    declared = {'manifest.json', 'pristine/INDEX.md'}
    declared |= {r['metadataPath'] for r in manifest['repos'].values()}
    assert {str(p.relative_to(out)) for p in out.rglob('*') if p.is_file()} == declared


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


def test_a_snapshot_missing_a_declared_file_is_not_replaceable(tmp_path):
    from repo_radar.publish import looks_like_snapshot

    fake = tmp_path / 'snap'
    (fake / 'pristine').mkdir(parents=True)
    (fake / 'pristine/INDEX.md').write_text('# i\n')
    (fake / 'manifest.json').write_text(json.dumps({
        'schemaVersion': 1, 'metadataSnapshotId': 'sha256:x',
        'index': {'path': 'pristine/INDEX.md', 'sha256': 'x'},
        'repos': {'Org/a': {'metadataPath': 'pristine/a.md', 'metadataSha256': 'x',
                            'sourceCommit': 'a' * 40}}}))

    ok, why = looks_like_snapshot(fake)
    assert not ok and 'missing' in why


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
    stale = 'a' * 40
    md.write_text(md.read_text().replace('cache_dir: alpha-abc1234',
                                         f'cache_dir: alpha-abc1234\nlast_commit: {stale}'))
    head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=clone,
                          capture_output=True, text=True).stdout.strip()
    assert head.lower() != stale

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
    assert 'Would FAIL' in capsys.readouterr().out
    assert not (tmp_path / 'snap').exists(), 'a dry run must not write anything'

    rc_real, _out, _ = publish({'alpha': 'Org/alpha'}, config=bad)
    assert rc_real == rc_dry


def test_dry_run_passes_when_the_real_publish_would(publish, capsys):
    rc, _out, _ = publish({'alpha': 'Org/alpha'}, dry_run=True)
    assert rc == 0
    assert 'Validation passed' in capsys.readouterr().out
