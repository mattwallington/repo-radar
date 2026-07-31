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


def _generations(root):
    directory = pathlib.Path(root) / 'generations'
    return sorted(directory.iterdir()) if directory.is_dir() else []


def _newest_generation(root):
    """The most recently installed generation, or a path that does not exist.

    There is deliberately no `current` pointer — it was the last operation that could overwrite
    something, and it went stale the moment the corpus changed.
    """
    found = _generations(root)
    if not found:
        return pathlib.Path(root) / '(no generation)'
    return max(found, key=lambda q: q.stat().st_mtime)


def _claim(root):
    """Mark `root` as a managed snapshot root, exactly as a real publish would."""
    from repo_radar.publish import MANAGED_ROOT_MARKER, MANAGED_ROOT_PAYLOAD

    root.mkdir(parents=True, exist_ok=True)
    (root / MANAGED_ROOT_MARKER).write_text(MANAGED_ROOT_PAYLOAD + '\n')


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
        root = pathlib.Path(args.out)
        snap = _newest_generation(root)
        try:
            manifest = json.loads((snap / 'manifest.json').read_text())
        except Exception:
            manifest = None          # tests may deliberately corrupt it or none may exist
        return rc, snap, manifest

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


# ── immutable generations ────────────────────────────────────────────────────────────────
# Six consecutive review rounds found a fresh way for in-place replacement to delete something
# it did not own. This design has no replacement and no deletion at all: a generation is named
# by its own content hash, so its path cannot collide with anything, and the only mutation of
# anything pre-existing is one atomic symlink flip.

def test_the_generation_path_is_named_by_its_content(publish, tmp_path):
    _rc, snap, manifest = publish({'alpha': 'Org/alpha'})

    from repo_radar.publish import content_id

    generation = snap
    assert generation.parent.name == 'generations'
    assert generation.name == content_id(manifest)
    assert not (tmp_path / 'snap' / 'current').exists(), 'no mutable pointer is created'


def test_the_generation_name_ignores_when_it_was_generated(publish, tmp_path, capsys):
    """metadataSnapshotId covers generatedAt, so naming generations by it minted a fresh
    directory of identical bytes on every run and they piled up forever."""
    rc, snap, first = publish({'alpha': 'Org/alpha'})
    assert rc == 0
    before = snap

    rc, snap, second = publish({'alpha': 'Org/alpha'}, generated_at='2099-01-01T00:00:00Z')

    assert rc == 0
    assert snap == before, 'the same corpus must map to the same generation'
    assert len(_generations(tmp_path / 'snap')) == 1
    assert second['generatedAt'] == first['generatedAt'], (
        'the existing generation is immutable — the later run did not rewrite it')


def test_republishing_an_unchanged_corpus_is_idempotent(publish, tmp_path, capsys):
    """Same content means the same path, so there is nothing to overwrite."""
    rc, snap, first = publish({'alpha': 'Org/alpha'})
    assert rc == 0
    before = snap

    rc, snap, second = publish.again()

    assert rc == 0
    assert snap == before
    assert second['metadataSnapshotId'] == first['metadataSnapshotId']
    assert 'already exists' in capsys.readouterr().out
    assert len(_generations(tmp_path / 'snap')) == 1


def test_a_changed_corpus_adds_a_generation_without_removing_the_old_one(publish, tmp_path):
    """Publishing never deletes. The previous generation stays exactly where it was."""
    rc, snap, first = publish({'alpha': 'Org/alpha'})
    assert rc == 0
    old = snap
    old_bytes = (old / 'manifest.json').read_bytes()

    md = tmp_path / 'pristine' / 'alpha-abc1234.md'
    md.write_text(md.read_text().replace('brief: A repository.', 'brief: Changed.'))
    rc, snap, second = publish.again()

    assert rc == 0
    assert snap != old, 'different content must produce a different generation'
    assert (old / 'manifest.json').read_bytes() == old_bytes, 'the old generation is untouched'
    assert len(_generations(tmp_path / 'snap')) == 2


def test_publishing_into_a_directory_full_of_unrelated_data_is_refused(publish, tmp_path,
                                                                        capsys):
    """The class of defect this design replaced: --out pointing somewhere with real files.

    Ownership is positive rather than assumed. "Every symlink at current is ours" let an arbitrary
    user symlink be replaced, so a root must carry our marker — or be empty enough to claim.
    """
    victim = tmp_path / 'snap'
    victim.mkdir()
    (victim / 'important.txt').write_text('MINE')
    (victim / 'notes').mkdir()
    (victim / 'notes' / 'more.txt').write_text('ALSO MINE')

    rc, _snap, _manifest = publish({'alpha': 'Org/alpha'})

    assert rc == 1
    assert 'cannot be used as a snapshot root' in capsys.readouterr().out
    assert (victim / 'important.txt').read_text() == 'MINE'
    assert (victim / 'notes' / 'more.txt').read_text() == 'ALSO MINE'
    assert sorted(p.name for p in victim.iterdir()) == ['important.txt', 'notes'], \
        'nothing was added either'


def test_an_empty_directory_may_be_claimed_as_a_root(publish, tmp_path):
    (tmp_path / 'snap').mkdir()

    rc, snap, _m = publish({'alpha': 'Org/alpha'})

    assert rc == 0
    assert (tmp_path / 'snap' / '.repo-radar-managed-root').is_file()
    assert snap.is_dir()


def test_a_legacy_current_is_reported_and_never_touched(publish, tmp_path, capsys):
    """`current` was removed: it was the last operation that could overwrite something, and it
    went stale the moment the corpus changed. An existing one is left exactly where it is."""
    root = tmp_path / 'snap'
    _claim(root)
    (root / 'current').mkdir()
    (root / 'current' / 'important.txt').write_text('MINE')

    rc, _snap, _m = publish({'alpha': 'Org/alpha'})

    assert rc == 0
    assert (root / 'current' / 'important.txt').read_text() == 'MINE'
    report = capsys.readouterr().out
    assert 'left over from an older layout' in report and 'NOT' in report
    assert _generations(root), 'the generation was still published'


def test_no_mutable_pointer_is_created(publish, tmp_path):
    rc, _snap, _m = publish({'alpha': 'Org/alpha'})

    assert rc == 0
    names = sorted(q.name for q in (tmp_path / 'snap').iterdir())
    assert names == ['.repo-radar-managed-root', 'generations'], names


def test_an_occupied_generation_slot_is_validated_before_it_is_adopted(publish, tmp_path, capsys):
    """Existence was treated as proof: a corrupt directory at the digest path became `current`
    and the run reported success."""
    rc, snap, manifest = publish({'alpha': 'Org/alpha'})
    assert rc == 0
    generation = snap
    (generation / 'manifest.json').write_text('CORRUPT')

    rc, _snap, _m = publish.again()

    assert rc == 1
    report = capsys.readouterr().out
    assert 'occupied by something that is not this snapshot' in report
    assert (generation / 'manifest.json').read_text() == 'CORRUPT', 'left untouched'


def test_a_generations_symlink_is_refused(publish, tmp_path, capsys):
    """A pre-existing generations symlink caused a successful publish into its external target."""
    root = tmp_path / 'snap'
    root.mkdir()
    _claim(root)
    elsewhere = tmp_path / 'elsewhere'
    elsewhere.mkdir()
    (root / 'generations').symlink_to(elsewhere)

    rc, _snap, _m = publish({'alpha': 'Org/alpha'})

    assert rc == 1
    assert 'is a symlink' in capsys.readouterr().out
    assert not list(elsewhere.iterdir()), 'nothing was written outside the chosen root'


def test_a_dry_run_writes_nothing_at_all(publish, tmp_path, capsys):
    rc, _snap, _m = publish({'alpha': 'Org/alpha'}, dry_run=True)

    assert rc == 0
    report = capsys.readouterr().out
    assert 'Nothing was published' in report
    assert not (tmp_path / 'snap').exists(), 'not even the managed root'
    # The staged tree is retained, but in the system temp directory — nowhere near --out.
    retained = [line for line in report.splitlines() if 'Staged output retained' in line]
    assert retained and str(tmp_path / 'snap') not in retained[0]


def test_a_failed_validation_publishes_no_generation(publish, tmp_path, capsys):
    rc, _snap, _m = publish(
        {'alpha': 'Org/alpha'},
        config={'repositories': [{'full_name': 'Org/alpha'}, {'full_name': 'Org/missing'}],
                'exclusions': []})

    assert rc == 1
    generations = tmp_path / 'snap' / 'generations'
    assert not generations.exists() or not list(generations.iterdir())
    assert 'Nothing was published' in capsys.readouterr().out


def test_an_output_symlink_is_not_followed(publish, tmp_path, capsys):
    """resolve() followed the leaf symlink, so `--out snap` where snap -> external published
    into external and created the marker there."""
    external = tmp_path / 'external'
    external.mkdir()
    (external / 'important.txt').write_text('MINE')
    (tmp_path / 'snap').symlink_to(external)

    rc, _snap, _m = publish({'alpha': 'Org/alpha'})

    assert rc == 1
    assert 'is a symlink' in capsys.readouterr().out
    assert sorted(p.name for p in external.iterdir()) == ['important.txt']


def test_an_unrelated_directory_with_a_token_marker_is_not_adopted(publish, tmp_path, capsys):
    """Any file named .repo-radar-managed-root was accepted, contents unchecked."""
    root = tmp_path / 'snap'
    root.mkdir()
    (root / '.repo-radar-managed-root').write_text('{}')
    (root / 'current').symlink_to(tmp_path)

    rc, _snap, _m = publish({'alpha': 'Org/alpha'})

    assert rc == 1
    assert 'does not carry our marker payload' in capsys.readouterr().out
    assert (root / 'current').resolve() == tmp_path.resolve(), 'their symlink is untouched'


def test_a_marker_symlink_is_refused_rather_than_written_through(publish, tmp_path, capsys):
    """A marker SYMLINK planted after the emptiness check redirected write_text() onto an
    external file and overwrote it."""
    root = tmp_path / 'snap'
    root.mkdir()
    victim = tmp_path / 'DO_NOT_TOUCH.txt'
    victim.write_text('DO NOT TOUCH')
    (root / '.repo-radar-managed-root').symlink_to(victim)

    rc, _snap, _m = publish({'alpha': 'Org/alpha'})

    assert rc == 1
    assert 'is a symlink' in capsys.readouterr().out
    assert victim.read_text() == 'DO NOT TOUCH'


def test_a_failed_run_never_deletes_and_reports_its_staging_path(publish, tmp_path,
                                                                 monkeypatch, capsys):
    """This publisher never recursively deletes. Even inode-checked cleanup left a window between
    the check and the rmtree, and a foreign directory was destroyed in it — so automatic deletion
    is gone entirely and the staged output is retained and reported instead."""
    import repo_radar.publish as pub

    monkeypatch.setattr(pub, 'verify_tree', lambda root, manifest: ['forced failure'])

    rc, _snap, _m = publish({'alpha': 'Org/alpha'})

    assert rc == 1
    report = capsys.readouterr().out
    assert 'Staged output retained at:' in report
    retained = [q for q in (tmp_path / 'snap').iterdir()
                if q.name.startswith('.repo-radar-staging-')]
    assert retained, 'the staged tree must still be on disk for inspection'
    assert (retained[0] / 'manifest.json').is_file()
    assert not _generations(tmp_path / 'snap'), 'and nothing was published'


def test_a_dry_run_rejects_a_corrupt_occupied_generation(publish, tmp_path, capsys):
    """The preflight covered namespace shape, not occupancy: a corrupt generation at the digest
    path passed the preview and failed the real run."""
    rc, snap, _m = publish({'alpha': 'Org/alpha'})
    assert rc == 0
    (snap / 'manifest.json').write_text('CORRUPT')
    capsys.readouterr()

    rc_dry, _s, _m = publish.again_dry()
    dry_out = capsys.readouterr().out
    rc_real, _s, _m = publish.again()

    assert rc_dry == rc_real == 1
    assert 'is occupied by something that is not this snapshot' in dry_out


def test_a_manifest_with_a_malformed_generated_at_is_rejected():
    from repo_radar.publish import validate_manifest

    base = {'schemaVersion': 1, 'generatedAt': '2026-07-30T00:00:00Z',
            'generatorVersion': 'test/1', 'metadataSnapshotId': 'x',
            'index': {'path': 'pristine/INDEX.md', 'sha256': 'a' * 64}, 'repos': {}}
    assert any('generatedAt' in p for p in validate_manifest({**base, 'generatedAt': 'banana'}))
    # Digit shape is not an instant: both of these previously published successfully.
    for impossible in ('2026-99-99T99:99:99Z', '2026-02-30T12:00:00Z'):
        assert any('generatedAt' in p
                   for p in validate_manifest({**base, 'generatedAt': impossible})), impossible
    assert any('generatorVersion' in p
               for p in validate_manifest({**base, 'generatorVersion': ''}))
    assert not any('generatedAt' in p for p in validate_manifest(base))


def test_dry_run_and_real_publish_agree_on_an_unmanaged_destination(publish, tmp_path, capsys):
    victim = tmp_path / 'snap'
    victim.mkdir()
    (victim / 'important.txt').write_text('MINE')

    rc_dry, _s, _m = publish({'alpha': 'Org/alpha'}, dry_run=True)
    dry_out = capsys.readouterr().out
    rc_real, _s, _m = publish({'alpha': 'Org/alpha'})

    assert rc_dry == rc_real == 1, 'a preview must not pass where the real run refuses'
    assert 'cannot be used as a snapshot root' in dry_out
    assert (victim / 'important.txt').read_text() == 'MINE'


def test_only_the_stored_snapshot_id_is_reported(publish, capsys):
    """Republishing printed the staged candidate first, then the stored one — parsers took the
    discarded value."""
    rc, _snap, first = publish({'alpha': 'Org/alpha'})
    assert rc == 0
    capsys.readouterr()

    rc, _snap, _m = publish({'alpha': 'Org/alpha'}, generated_at='2099-01-01T00:00:00Z')

    report = capsys.readouterr().out
    ids = [line for line in report.splitlines() if 'metadataSnapshotId' in line]
    assert len(ids) == 1, f'exactly one authoritative id must be printed: {ids}'
    assert first['metadataSnapshotId'] in ids[0]


def test_preflight_and_real_run_agree_when_the_destination_is_below_a_file(publish, tmp_path,
                                                                           capsys):
    """`not out.exists()` approved outright, but mkdir(parents=True) fails ENOTDIR when the
    nearest existing ancestor is a regular file."""
    import repo_radar.publish as pub

    blocker = tmp_path / 'blocker'
    blocker.write_text('I am a file')
    target = blocker / 'deeper' / 'snap'

    ok, why = pub._destination_preflight(target)
    assert not ok and 'not a directory' in why

    monkey = _args(target, _corpus(tmp_path, {'alpha': 'Org/alpha'}))
    import types as _t
    dry = _t.SimpleNamespace(**{**vars(monkey), 'dry_run': True})
    pub.load_config = lambda: {'repositories': [{'full_name': 'Org/alpha'}], 'exclusions': []}
    pub.load_exclusions = lambda c=None: []
    assert pub.publish_mode(dry) == pub.publish_mode(monkey) == 1
    assert blocker.read_text() == 'I am a file'


def test_preflight_does_not_block_on_a_fifo_marker(tmp_path, monkeypatch):
    """read_text() on a FIFO blocks forever; the real run rejects it instantly as non-regular.

    Guard read_text so a reintroduced read produces a bounded FAILURE, not a hung suite.
    """
    import repo_radar.publish as pub

    root = tmp_path / 'snap'
    root.mkdir()
    os.mkfifo(root / '.repo-radar-managed-root')

    real_read_text = pathlib.Path.read_text
    def guarded(self, *a, **k):
        if self.is_fifo():
            raise AssertionError('the preflight must lstat a FIFO marker before read_text()')
        return real_read_text(self, *a, **k)
    monkeypatch.setattr(pathlib.Path, 'read_text', guarded)

    ok, why = pub._destination_preflight(root)          # must return, not hang or raise

    assert not ok and 'not a regular file' in why
    claimed, claim_why = pub._claim_managed_root(root)
    assert not claimed and 'not a regular file' in claim_why, 'both paths must agree'


def test_preflight_and_real_run_agree_below_a_dangling_symlink_ancestor(publish, tmp_path,
                                                                        capsys):
    """Path.exists() follows symlinks, so a dangling ancestor read as absent and the walk stepped
    over it and approved a creation the real mkdir rejects with EEXIST."""
    import repo_radar.publish as pub

    dangling = tmp_path / 'dangling'
    dangling.symlink_to(tmp_path / 'nowhere')           # target does not exist
    target = dangling / 'snap'

    ok, why = pub._destination_preflight(target)
    assert not ok and 'dangling symlink' in why

    import types as _t
    args = _args(target, _corpus(tmp_path, {'alpha': 'Org/alpha'}))
    dry = _t.SimpleNamespace(**{**vars(args), 'dry_run': True})
    pub.load_config = lambda: {'repositories': [{'full_name': 'Org/alpha'}], 'exclusions': []}
    pub.load_exclusions = lambda c=None: []
    assert pub.publish_mode(dry) == pub.publish_mode(args) == 1
    assert dangling.is_symlink() and not dangling.exists(), 'the symlink is untouched'


def test_preflight_allows_a_symlink_ancestor_that_resolves_to_a_directory(tmp_path):
    """mkdir descends through a symlink to a real directory, so the preflight must approve it —
    matching the real run rather than rejecting every symlink in the chain."""
    import repo_radar.publish as pub

    real = tmp_path / 'real'
    real.mkdir()
    link = tmp_path / 'link'
    link.symlink_to(real)

    ok, why = pub._destination_preflight(link / 'snap')
    assert ok, why
