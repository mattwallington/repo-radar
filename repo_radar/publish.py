"""Publish the pristine corpus as an Agent Context Snapshot.

Cloud agents reviewing a PR have none of the cross-repo knowledge a desktop agent gets from
~/repos-pristine. This emits the schema-v1 tree their consumer validates:

    <out>/manifest.json
    <out>/pristine/INDEX.md
    <out>/pristine/<repo>.md          one per repo, canonical names, never symlinks

The consumer's contract is fixed and it validates the tree as an EXACT SET, so nothing may be
written into <out> that the manifest does not declare, and nothing declared may be missing:

  - repo keys must match owner/name
  - metadataPath must be a direct child of pristine/, and never pristine/INDEX.md
  - index.path must be exactly pristine/INDEX.md
  - sourceCommit 40 lowercase hex; metadataSha256 64 lowercase hex
  - metadataSnapshotId = sha256 of the canonical manifest with that key OMITTED
  - no symlinks anywhere
  - limits: 2 MiB per metadata file, 64 MiB total, 1024 filesystem entries

For the schema-v1 profile (ASCII keys, strings, one integer) json.dumps(sort_keys, no whitespace)
is JCS-equivalent, which is what makes metadataSnapshotId reproducible across implementations.
"""
import argparse
import fcntl
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from repo_radar import VERSION as REPO_RADAR_VERSION
from repo_radar.config import PRISTINE_DIR, load_config, load_exclusions, is_excluded
from repo_radar.constants import GREEN, CYAN, YELLOW, RED, BOLD, RESET

SHA40 = re.compile(r'^[0-9a-f]{40}$')
SHA256_HEX = re.compile(r'[0-9a-f]{64}')
REPO_KEY = re.compile(r'^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$')
# The snapshot's own index lives at pristine/INDEX.md, so a repository whose canonical name is
# INDEX would publish over it and the run would report success.
RESERVED_CANONICAL_NAMES = {'INDEX'}
# repo-radar names metadata "<repo>-<short-sha>.md" beside a "<repo>.md" symlink; the snapshot
# publishes the canonical name and never the symlink, which the contract rejects outright.
CACHE_SUFFIX = re.compile(r'-[0-9a-f]{7,}$')

MAX_FILE = 2 * 1024 * 1024
MAX_TOTAL = 64 * 1024 * 1024
MAX_ENTRIES = 1024


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def sha256_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _git(repo, *args):
    """Read-only git query in `repo`, or None. Never raises."""
    try:
        result = subprocess.run(['git', '-C', str(repo), *args],
                                capture_output=True, text=True, timeout=30)
        return result.stdout.strip() if result.returncode == 0 else None
    except Exception:
        return None


def owner_name(url):
    """git@github.com:Owner/Name.git or https://github.com/Owner/Name.git -> Owner/Name."""
    if not url:
        return None
    match = re.search(r'[:/]([^/:]+)/([^/]+?)(?:\.git)?/?$', url.strip())
    return f'{match.group(1)}/{match.group(2)}' if match else None


def frontmatter(md_path):
    """The flat scalar frontmatter keys we need. Never raises."""
    try:
        text = Path(md_path).read_text(encoding='utf-8', errors='replace')
    except Exception:
        return {}
    if not text.startswith('---\n'):
        return {}
    end = text.find('\n---', 4)
    out = {}
    for line in text[4:end if end > 0 else 0].splitlines():
        if ':' in line and not line.startswith((' ', '\t', '-')):
            key, _, value = line.partition(':')
            out[key.strip()] = value.strip()
    return out


def rewrite_index(text, rename):
    """Point INDEX links at the canonical names actually present in the snapshot.

    repo-radar links to cache-named files ("reperio-mcp-1a2b3c4.md") and cache directories, but
    the snapshot publishes "reperio-mcp.md". Left alone, every INDEX link dangles inside the
    snapshot and the agent's first step — read INDEX, pick a repo — dead-ends immediately.
    """
    count = 0
    for cache_name, canon in rename.items():
        for before, after in ((f'({cache_name}.md)', f'({canon}.md)'),
                              (f'`{cache_name}/`', f'`{canon}/`')):
            if before in text:
                count += text.count(before)
                text = text.replace(before, after)
    return text, count


def discover(src, exclusions):
    """Find publishable repositories. Returns (repos, skipped, rename, excluded)."""
    repos, skipped, rename, excluded = {}, [], {}, []
    for md in sorted(Path(src).iterdir()):
        if md.name == 'INDEX.md' or md.suffix != '.md' or md.is_symlink() or not md.is_file():
            continue
        stem = md.stem                              # reperio-mcp-1a2b3c4
        canon = CACHE_SUFFIX.sub('', stem)          # reperio-mcp
        clone = Path(src) / stem

        meta = frontmatter(md)
        origin = owner_name(_git(clone, 'remote', 'get-url', 'origin'))
        key = meta.get('full_name') or origin
        # The metadata's own last_commit is authoritative: sourceCommit must name the commit this
        # METADATA describes, and preferring the clone's HEAD meant publishing a commit the
        # metadata had never seen whenever analysis failed or was skipped after a pull. The
        # snapshot then told an agent "this description is of commit B" when it described A.
        head = _git(clone, 'rev-parse', 'HEAD')
        clone_exists = clone.is_dir()
        commit = meta.get('last_commit') or (None if clone_exists else head)

        if key and is_excluded(key, exclusions):
            excluded.append(key)
            continue
        if not key or not REPO_KEY.match(key):
            skipped.append((stem, f'no owner/name key (got {key!r})'))
            continue
        if canon in RESERVED_CANONICAL_NAMES:
            skipped.append((stem, f'{canon!r} is reserved — it would publish over the '
                                  f'snapshot index at pristine/INDEX.md'))
            continue
        # When the clone is present, its evidence is REQUIRED rather than merely preferred.
        # Falling back on missing evidence published unproven source under a plausible identity:
        # an unreadable origin was accepted, and absent last_commit silently became clone HEAD —
        # the exact substitution that made sourceCommit describe something the metadata never saw.
        if clone_exists:
            if not meta.get('last_commit'):
                skipped.append((stem, 'clone exists but metadata has no last_commit — cannot '
                                      'prove which commit this description is of'))
                continue
            if not head:
                skipped.append((stem, 'clone exists but its HEAD is unreadable'))
                continue
            if not origin:
                skipped.append((stem, 'clone exists but its origin remote is unreadable — '
                                      'cannot confirm identity'))
                continue
            if origin != key:
                skipped.append((stem, f'identity mismatch: metadata says {key} but origin '
                                      f'is {origin}'))
                continue
        if not commit or not SHA40.match(commit.lower()):
            skipped.append((stem, f'no 40-hex sourceCommit (got {commit!r})'))
            continue
        if head and head.lower() != commit.lower():
            skipped.append((stem, f'metadata is stale: describes {commit[:8]} but the clone is '
                                  f'at {head[:8]} — re-sync before publishing'))
            continue
        if key in repos:
            skipped.append((stem, f'duplicate key {key}'))
            continue

        repos[key] = {'src': md, 'canon': canon, 'commit': commit.lower()}
        rename[stem] = canon
    return repos, skipped, rename, excluded


def build_manifest(repos, out, generated_at, generator_version):
    """Write the tree and return (manifest_with_id, snapshot_id)."""
    manifest_repos = {}
    for key, repo in sorted(repos.items()):
        dest = Path(out) / 'pristine' / f"{repo['canon']}.md"
        shutil.copyfile(repo['src'], dest)
        manifest_repos[key] = {
            'metadataPath': f"pristine/{repo['canon']}.md",
            'metadataSha256': sha256_file(dest),
            'sourceCommit': repo['commit'],
        }

    manifest = {
        'schemaVersion': 1,
        'generatedAt': generated_at,
        'generatorVersion': generator_version,
        'index': {'path': 'pristine/INDEX.md',
                  'sha256': sha256_file(Path(out) / 'pristine/INDEX.md')},
        'repos': manifest_repos,
    }
    # The id is the hash of the manifest WITHOUT the id — including it would be self-referential.
    snapshot_id = 'sha256:' + hashlib.sha256(canonical(manifest).encode('utf-8')).hexdigest()
    return {**manifest, 'metadataSnapshotId': snapshot_id}, snapshot_id


def paths_overlap(src, out):
    """True if publishing into `out` would read from or destroy `src`.

    `--src snapshot/pristine --out snapshot` deletes its own source before copying it.
    """
    src, out = Path(src).resolve(), Path(out).resolve()
    return src == out or src in out.parents or out in src.parents


def validate_manifest(manifest):
    """Full contract check on a parsed manifest. Returns a list of problems."""
    problems = []
    if not isinstance(manifest, dict):
        return ['manifest.json is not an object']
    if manifest.get('schemaVersion') != 1:
        return ['manifest.json has no schemaVersion 1']
    index = manifest.get('index')
    if not isinstance(index, dict) or index.get('path') != 'pristine/INDEX.md':
        problems.append('manifest index.path must be exactly pristine/INDEX.md')
    elif not SHA256_HEX.fullmatch(str(index.get('sha256', ''))):
        problems.append('manifest index.sha256 is not 64 lowercase hex')
    repos = manifest.get('repos')
    if not isinstance(repos, dict):
        return problems + ['manifest.json "repos" is not an object']

    seen_paths = set()
    for key, entry in repos.items():
        if not REPO_KEY.match(str(key)):
            problems.append(f'manifest repo key is not owner/name: {key!r}')
        if not isinstance(entry, dict):
            problems.append(f'{key}: manifest entry is not an object')
            continue
        path = str(entry.get('metadataPath', ''))
        if not path.startswith('pristine/') or path.count('/') != 1 or path == 'pristine/INDEX.md':
            problems.append(f'{key}: metadataPath must be a direct child of pristine/ and not '
                            f'the index (got {path!r})')
        elif path in seen_paths:
            problems.append(f'{key}: metadataPath {path} is declared more than once')
        seen_paths.add(path)
        if not SHA256_HEX.fullmatch(str(entry.get('metadataSha256', ''))):
            problems.append(f'{key}: metadataSha256 is not 64 lowercase hex')
        if not SHA40.fullmatch(str(entry.get('sourceCommit', ''))):
            problems.append(f'{key}: sourceCommit is not 40 lowercase hex')

    # The id is what makes a snapshot self-certifying, so it is part of being a valid snapshot.
    without = {k: v for k, v in manifest.items() if k != 'metadataSnapshotId'}
    expected = 'sha256:' + hashlib.sha256(canonical(without).encode('utf-8')).hexdigest()
    if manifest.get('metadataSnapshotId') != expected:
        problems.append('metadataSnapshotId does not match the canonical manifest hash')
    return problems


def inspect_snapshot(path):
    """Validate `path` and return (ok, why, plan).

    The plan is the ONLY authorization cleanup ever gets: the manifest as validated, plus the
    (st_dev, st_ino) of every declared file at the moment it was verified. Re-reading manifest.json
    later meant cleanup was authorized by a second, unvalidated read — a swapped manifest could
    name a planted file and have it deleted.
    """
    path = Path(path)
    try:
        manifest_file = path / 'manifest.json'
        if not manifest_file.is_file():
            return False, 'no manifest.json', None
        try:
            manifest = json.loads(manifest_file.read_text())
        except (OSError, ValueError) as exc:
            return False, f'manifest.json is not readable JSON ({exc})', None
        # Structure first, and stop there if it fails: traversing a tree against a manifest we
        # already know is malformed produces confusing secondary errors about the wrong thing.
        problems = validate_manifest(manifest)
        if problems:
            return False, problems[0], None
        problems = verify_tree(path, manifest)
        if problems:
            return False, problems[0], None

        identities = {}
        for rel in _declared_files(manifest):
            info = os.lstat(path / rel)
            identities[rel] = (info.st_dev, info.st_ino)
        return True, 'a valid snapshot', {'manifest': manifest, 'identities': identities}
    except Exception as exc:
        # Total, like every other question whose answer decides whether to delete something.
        # "We could not tell" must resolve to "do not touch it", never an escaping traceback.
        return False, f'it could not be inspected ({type(exc).__name__}: {exc})', None


def _declared_files(manifest):
    """Every file path the manifest declares, index first."""
    files = ['manifest.json', 'pristine/INDEX.md']
    files += [e.get('metadataPath', '') for e in (manifest.get('repos') or {}).values()]
    return files


def looks_like_snapshot(path):
    """Is `path` a tree this tool produced? Returns (ok, reason).

    Replacing a destination destroys whatever is there, so the bar is PROOF OF OWNERSHIP of every
    file that will be removed, not a plausible-looking manifest. Two earlier versions were too
    weak: one accepted any file named manifest.json (`{}` parses as JSON), and one accepted a
    schema-1 manifest without checking the snapshot id, the index entry, field shapes, or whether
    the tree contained anything the manifest never mentioned.

    Undeclared files now disqualify. The tree is built in a staging directory and swapped in, so
    a failed run no longer leaves debris in the destination — which was the only argument for
    tolerating extras, and it no longer holds. A valid manifest sitting beside unrelated files is
    not evidence that those files are ours to delete.
    """
    ok, why, _plan = inspect_snapshot(path)
    return ok, why


def _inventory(root):
    """Every descendant of `root` as (relpath, lstat result), never following symlinks.

    lstat and a manual walk rather than rglob + is_file(): is_file() follows symlinks and reports
    nothing at all for a FIFO or a socket, so an inventory built from it silently omitted entries
    that would then be deleted as though the manifest had accounted for them.
    """
    root = Path(root)
    found = []
    try:
        root_dev = os.lstat(root).st_dev
    except OSError as exc:
        return [('', None, str(exc))]
    stack = [root]
    while stack:
        current = stack.pop()
        try:
            entries = list(os.scandir(current))
        except OSError as exc:
            found.append((str(current.relative_to(root)), None, str(exc)))
            continue
        for entry in entries:
            path = Path(entry.path)
            info = entry.stat(follow_symlinks=False)
            rel = str(path.relative_to(root))
            is_real_dir = stat.S_ISDIR(info.st_mode) and not entry.is_symlink()
            # A different device is a mount point. Descending would validate — and later delete —
            # files on a filesystem that merely happens to be mounted here. Recorded as ONE entry:
            # appending both a stat tuple and an error tuple for the same path made sorted() try
            # to order an os.stat_result against None and raise.
            if is_real_dir and info.st_dev != root_dev:
                found.append((rel, None, 'crosses a filesystem boundary (mount point)'))
                continue
            found.append((rel, info, None))
            if is_real_dir:
                stack.append(path)
    return found


def verify_tree(root, manifest):
    """Check a tree against its own manifest as an EXACT SET. Returns a list of problems.

    Run against the tree we just wrote — the manifest describes what we *intended*, and copying
    two repositories to the same path would otherwise leave one recorded hash describing bytes
    that are no longer there — and against an existing destination, where EVERY entry it contains
    must be one this tool put there before any of it may be deleted.
    """
    root = Path(root)
    problems = []
    declared = {'manifest.json', 'pristine/INDEX.md'}
    for key, entry in (manifest.get('repos') or {}).items():
        path = entry.get('metadataPath', '')
        declared.add(path)
        target = root / path
        if not target.is_file():
            problems.append(f'{key}: declared {path} is missing')
            continue
        if sha256_file(target) != entry.get('metadataSha256'):
            problems.append(f'{key}: {path} does not match its recorded metadataSha256')

    # The index is declared with a hash like any other file, and its CONTENT was never checked —
    # so a snapshot whose INDEX.md had been edited still validated as ours.
    index_path = root / 'pristine/INDEX.md'
    index_entry = manifest.get('index') if isinstance(manifest.get('index'), dict) else {}
    if index_path.is_file():
        if sha256_file(index_path) != index_entry.get('sha256'):
            problems.append('pristine/INDEX.md does not match its recorded index.sha256')

    allowed_dirs = {'pristine'}
    seen_files = set()
    for rel, info, error in sorted(_inventory(root)):
        if error is not None:
            problems.append(f'cannot read {rel}: {error}')
            continue
        if stat.S_ISLNK(info.st_mode):
            problems.append(f'symlink in snapshot (rejected by the contract): {rel}')
        elif stat.S_ISDIR(info.st_mode):
            if rel not in allowed_dirs:
                problems.append(f'undeclared directory in snapshot: {rel}')
        elif stat.S_ISREG(info.st_mode):
            if rel in declared:
                seen_files.add(rel)
            else:
                problems.append(f'undeclared file in snapshot: {rel}')
        else:
            # FIFOs, sockets, devices. None of these can be ours, and deleting a path we cannot
            # even classify is exactly the thing this check exists to prevent.
            problems.append(f'special filesystem entry in snapshot: {rel}')
    for missing in sorted(declared - seen_files):
        problems.append(f'declared file missing from snapshot: {missing}')
    return problems


def expected_repo_keys(config, exclusions):
    """The repositories the corpus is SUPPOSED to contain: configured, minus excluded."""
    keys = set()
    for repo in (config or {}).get('repositories', []):
        full_name = (repo.get('full_name') or '').strip()
        if full_name and not is_excluded(full_name, exclusions):
            keys.add(full_name)
    return keys


def publish_mode(args):
    """Build a snapshot at --out. Returns 0 only if it is complete and within limits."""
    print(f'{BOLD}Publish Context Snapshot{RESET}')
    print()

    src = Path(getattr(args, 'src', None) or PRISTINE_DIR).expanduser().resolve()
    if not getattr(args, 'out', None):
        print(f'{RED}--out is required{RESET}')
        return 1
    out = Path(args.out).expanduser().resolve()

    if not src.is_dir():
        print(f'{RED}error: {src} is not a directory{RESET}')
        return 1
    index_src = src / 'INDEX.md'
    if not index_src.is_file():
        print(f'{RED}error: {index_src} missing — the contract requires pristine/INDEX.md{RESET}')
        return 1
    if paths_overlap(src, out):
        print(f'{RED}error: --out {out} overlaps --src {src}{RESET}')
        print(f'{YELLOW}  Publishing replaces the destination, so this would destroy the corpus '
              f'it is reading.{RESET}')
        return 1
    # Only a directory we can positively identify as a previous snapshot may be replaced. Checked
    # on dry runs too: "would publish" is worthless if the real run refuses the destination.
    if out.exists():
        try:
            ok, why = looks_like_snapshot(out)
        except Exception as exc:         # a monkeypatched or future implementation may still raise
            ok, why = False, f'{type(exc).__name__}: {exc}'
        if not ok:
            print(f'{RED}error: {out} exists and is not a valid previous snapshot ({why}){RESET}')
            print(f'{YELLOW}  Refusing to delete it. Choose an empty path or remove it '
                  f'yourself.{RESET}')
            return 1

    config = load_config() or {}
    exclusions = load_exclusions(config)
    repos, skipped, rename, excluded = discover(src, exclusions)
    if not repos:
        # Say WHY. Reporting only "nothing to publish" hid the reason whenever every candidate was
        # skipped — which is the case that most needs explaining.
        print(f'{RED}error: no publishable repositories found{RESET}')
        for stem, why in skipped:
            print(f'  {RED}- skipped {stem}: {why}{RESET}')
        if excluded:
            print(f'  {CYAN}({len(excluded)} excluded by configuration){RESET}')
        return 1

    # Every check below is non-mutating, so a dry run performs exactly the same validation and
    # returns the same status. Exiting early with "would publish" meant a corpus the real run
    # rejects previewed as fine.
    failures = []

    # Two repositories with the same basename (OrgA/foo, OrgB/foo) both canonicalise to
    # pristine/foo.md. Left alone, the second copy overwrites the first, both manifest entries
    # point at one file, and one recorded hash describes bytes that no longer exist.
    by_path = {}
    for key, repo in sorted(repos.items()):
        by_path.setdefault(repo['canon'], []).append(key)
    for canon, keys in sorted(by_path.items()):
        if len(keys) > 1:
            failures.append(f'name collision: {", ".join(keys)} all publish to '
                            f'pristine/{canon}.md')

    # Duplicates must be caught BEFORE set comparison, which silently collapses them: a config
    # listing a repository twice, or an INDEX with two sections for it, would compare equal.
    configured_keys = [(r.get('full_name') or '').strip()
                       for r in (config.get('repositories') or [])
                       if (r.get('full_name') or '').strip()]
    for key, count in sorted(Counter(configured_keys).items()):
        if count > 1:
            failures.append(f'{key} appears {count} times in the configured repositories')

    index_text, links = rewrite_index(index_src.read_text(encoding='utf-8'), rename)
    index_headings = re.findall(r'^###\s+(\S+/\S+)', index_text, re.M)
    for key, count in sorted(Counter(index_headings).items()):
        if count > 1:
            failures.append(f'{key} has {count} sections in INDEX.md')

    published = set(repos)
    indexed = set(index_headings)
    expected = expected_repo_keys(config, exclusions)

    # Set equality, not a count. Three views of the corpus must name the SAME repositories:
    # what the config says should exist, what the index advertises, and what the manifest ships.
    # A count check passes when one repo is silently swapped for another; agents then either
    # cannot find a repo the index promised, or read metadata nothing points at.
    for label, actual in (('INDEX', indexed), ('manifest', published)):
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        if missing:
            failures.append(f'{len(missing)} configured repositor'
                            f'{"ies" if len(missing) != 1 else "y"} missing from {label}: '
                            f'{", ".join(missing)}')
        if extra:
            failures.append(f'{len(extra)} repositor{"ies" if len(extra) != 1 else "y"} in '
                            f'{label} but not configured: {", ".join(extra)}')
    for stem, why in skipped:
        failures.append(f'skipped {stem}: {why}')

    if args.dry_run:
        print(f'{CYAN}[DRY RUN]{RESET} would publish {len(repos)} repositories to {out}')

    # A dry run performs the SAME build and the SAME validation, into a disposable directory, and
    # skips only the final swap. Keeping a separate list of "checks the preview also runs"
    # guaranteed divergence: an unrelated destination and an oversized metadata file each passed
    # the preview and then failed the real run.
    #
    # Build into a sibling staging directory and swap only once the result validates. Writing
    # directly into --out meant deleting a known-good previous snapshot BEFORE knowing whether the
    # replacement was any good; a failure then left a partial tree that still carried
    # manifest.json, so the next run would happily delete that too.
    # mkdtemp, not a predictable name. `.{out.name}.staging` and `.{out.name}.previous` were
    # deterministic paths this code rmtree'd unconditionally, so a sibling directory that happened
    # to carry either name was destroyed by a SUCCESSFUL publish. Never delete a path we did not
    # just create; a unique directory needs no clearing.
    if args.dry_run:
        # Stage in the system temp directory and touch nothing near `out`: a dry run must leave
        # the filesystem exactly as it found it, and creating out's parent hierarchy (or a lock
        # file beside it) to have somewhere to build is still a change the user did not ask for.
        staging = Path(tempfile.mkdtemp(prefix='repo-radar-publish-dryrun-'))
        try:
            return _build_and_swap(args, out, staging, index_text, links, repos, skipped, excluded,
                                   published, indexed, expected, failures)
        finally:
            shutil.rmtree(staging, ignore_errors=True)

    out.parent.mkdir(parents=True, exist_ok=True)
    lock = None
    try:
        # One publisher per destination. Without it, two concurrent runs can each move the other's
        # freshly installed snapshot aside and delete it.
        lock, why = _acquire_lock(out)
        if lock is None:
            print(f'{RED}✗ cannot lock {out}: {why}{RESET}')
            return 1
        staging = Path(tempfile.mkdtemp(prefix=f'.{out.name}.staging-', dir=out.parent))
        try:
            return _build_and_swap(args, out, staging, index_text, links, repos, skipped, excluded,
                                   published, indexed, expected, failures)
        finally:
            shutil.rmtree(staging, ignore_errors=True)
    finally:
        if lock is not None:
            _release_lock(lock)


def _read_manifest(root):
    """The manifest of an already-validated tree, or None. Never raises."""
    try:
        return json.loads((Path(root) / 'manifest.json').read_text())
    except Exception:
        return None


def _remove_exact(root, plan, expect_root):
    """Delete exactly the objects that were validated. Returns None, or a reason string.

    Enumerating NAMES is not identity: a foreign tree carrying the same filenames was deleted,
    and a file swapped between its stat and its unlink was deleted too. Names are also not
    authorization: cleanup used to re-read manifest.json, so a manifest swapped after validation
    could nominate a planted file for deletion.

    So the plan — manifest and per-file (st_dev, st_ino) — is captured at validation time and
    carried here immutably, and removal happens in two phases:

      ISOLATION (reversible): rename each declared entry into a private directory inside the
      quarantine, then confirm the moved object is the exact inode that was verified. Anything
      that fails is rolled back and nothing is deleted. Because the object is moved before it is
      checked, a later swap of the original name cannot reach it.

      DELETION (irreversible): only once every entry is isolated and nothing unexpected remains.
    """
    declared = _declared_files(plan['manifest'])
    identities = plan['identities']
    by_dir = {}
    for rel in declared:
        parent, _, name = rel.rpartition('/')
        by_dir.setdefault(parent, []).append((name, rel))

    root_fd = pristine_fd = iso_fd = None
    moved = []
    try:
        try:
            root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        except OSError as exc:
            return f'could not open the quarantined tree ({exc})'
        info = os.fstat(root_fd)
        if (info.st_dev, info.st_ino) != expect_root:
            return 'the quarantined tree is not the one that was verified'

        fds = {'': root_fd}
        if 'pristine' in by_dir:
            pristine_fd = os.open('pristine', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                  dir_fd=root_fd)
            fds['pristine'] = pristine_fd

        os.mkdir('.rr-cleanup', 0o700, dir_fd=root_fd)
        iso_fd = os.open('.rr-cleanup', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                         dir_fd=root_fd)

        failure = None
        for parent, names in by_dir.items():
            for name, rel in names:
                held = rel.replace('/', '__')
                try:
                    os.rename(name, held, src_dir_fd=fds[parent], dst_dir_fd=iso_fd)
                except OSError as exc:
                    failure = f'{rel} could not be isolated ({exc})'
                    break
                moved.append((parent, name, held))
                seen = os.stat(held, dir_fd=iso_fd, follow_symlinks=False)
                if not stat.S_ISREG(seen.st_mode) or (seen.st_dev, seen.st_ino) != identities[rel]:
                    failure = f'{rel} is not the file that was verified'
                    break
            if failure:
                break

        if failure is None:
            for parent in by_dir:
                remaining = {e.name for e in os.scandir(fds[parent])}
                remaining -= {'.rr-cleanup'} if parent == '' else set()
                remaining -= {'pristine'} if parent == '' else set()
                if remaining:
                    failure = (f'new content appeared in {parent or "."}/ after validation: '
                               f'{", ".join(sorted(remaining))}')
                    break

        if failure is not None:
            for parent, name, held in reversed(moved):
                try:
                    os.rename(held, name, src_dir_fd=iso_fd, dst_dir_fd=fds[parent])
                except OSError:
                    pass                 # best effort; the tree is reported as retained below
            try:
                os.rmdir('.rr-cleanup', dir_fd=root_fd)
            except OSError:
                pass
            return failure

        # Point of no return: everything is isolated and identity-checked.
        for _parent, _name, held in moved:
            os.unlink(held, dir_fd=iso_fd)
        os.rmdir('.rr-cleanup', dir_fd=root_fd)
    except OSError as exc:
        return f'cleanup failed ({exc})'
    finally:
        for fd in (iso_fd, pristine_fd, root_fd):
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass

    try:
        if 'pristine' in by_dir:
            os.rmdir(Path(root) / 'pristine')
        os.rmdir(root)
    except OSError as exc:
        return f'could not remove the emptied directories ({exc})'
    return None


def _restore(retired, out, why, expect=None):
    """Put the quarantined tree back, or say exactly where it is. Always returns 1.

    Restoration is only safe while `out` is still absent: if something else has appeared there we
    must not overwrite it, because we have proven nothing about it. In that case the old snapshot
    stays quarantined and its path is printed — stranding it silently is what turned a failed
    publish into a lost snapshot.
    """
    print()
    print(f'{RED}✗ Nothing was published: {why}{RESET}')
    # Restoring blindly renames whatever currently answers to `retired`. Substituting it during
    # validation made an unrelated directory become the destination while the real snapshot stayed
    # hidden — and the message claimed the destination had been left untouched.
    if expect is not None:
        try:
            now = os.lstat(retired)
        except OSError as exc:
            print(f'{RED}  The quarantined snapshot could not be located ({exc}).{RESET}')
            print(f'{YELLOW}  Look for it near: {retired}{RESET}')
            return 1
        if (now.st_dev, now.st_ino) != expect:
            print(f'{RED}  {retired} is no longer the tree that was moved there, so nothing was '
                  f'moved back.{RESET}')
            print(f'{YELLOW}  Both objects were left in place. Recovery paths:{RESET}')
            print(f'{YELLOW}    destination : {out}{RESET}')
            print(f'{YELLOW}    quarantined : {retired}{RESET}')
            return 1
    if out.exists() or out.is_symlink():
        print(f'{YELLOW}  {out} is occupied by something this run did not create, so the previous '
              f'snapshot was NOT restored over it.{RESET}')
        print(f'{YELLOW}  It is intact at: {retired}{RESET}')
        return 1
    try:
        retired.rename(out)
        print(f'{YELLOW}  The existing {out} was left untouched.{RESET}')
    except OSError as exc:
        print(f'{RED}  The previous snapshot could not be restored ({exc}).{RESET}')
        print(f'{YELLOW}  It is intact at: {retired}{RESET}')
    return 1


def _acquire_lock(out):
    """An exclusive advisory lock for this destination, or None if it cannot be taken safely.

    open(path, 'w') follows symlinks and TRUNCATES before any lock is held, so pointing the
    predictable lock name at a real file emptied it — a successful publish that destroyed data it
    never even looked at. O_NOFOLLOW refuses to open through a symlink and no truncation flag is
    passed, so the worst case is failing to lock rather than destroying the target.
    """
    path = out.parent / f'.{out.name}.publish.lock'
    fd = None
    try:
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            os.close(fd)
            return None, f'{path} is not a regular file'
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)         # the old code leaked the handle here
            return None, 'another repo-radar publish is already writing to this destination'
        return fd, 'acquired'
    except OSError as exc:
        if fd is not None:
            os.close(fd)
        return None, f'could not open {path} safely ({exc})'


def _release_lock(fd):
    try:
        fcntl.flock(fd, fcntl.LOCK_UN)
    except OSError:
        pass
    try:
        os.close(fd)
    except OSError:
        pass


def _build_and_swap(args, out, staging, index_text, links, repos, skipped, excluded,
                    published, indexed, expected, failures):
    (staging / 'pristine').mkdir(parents=True)

    (staging / 'pristine/INDEX.md').write_text(index_text, encoding='utf-8', newline='\n')

    generated_at = (getattr(args, 'generated_at', None)
                    or datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))
    generator_version = (getattr(args, 'generator_version', None)
                         or f'repo-radar/{REPO_RADAR_VERSION}')
    manifest, snapshot_id = build_manifest(repos, staging, generated_at, generator_version)
    (staging / 'manifest.json').write_text(canonical(manifest), encoding='utf-8', newline='\n')

    # Local limit checks, so a bad snapshot fails here rather than mid-review.
    files = [p for p in staging.rglob('*') if p.is_file()]
    entries = len(files) + len([p for p in staging.rglob('*') if p.is_dir()])
    total = sum(p.stat().st_size for p in files)
    problems = [f'{p.relative_to(staging)} is {p.stat().st_size}B > {MAX_FILE}'
                for p in files if p.stat().st_size > MAX_FILE]
    if total > MAX_TOTAL:
        problems.append(f'total {total}B > {MAX_TOTAL}')
    if entries > MAX_ENTRIES:
        problems.append(f'{entries} entries > {MAX_ENTRIES}')
    # Re-verify the tree we actually wrote, rather than trusting that copying went as planned.
    problems.extend(verify_tree(staging, manifest))

    print(f'snapshot     : {out}')
    print(f'metadataSnapshotId = {snapshot_id}')
    print(f'repos        : {len(published)} published, {len(skipped)} skipped, '
          f'{len(excluded)} excluded')
    print(f'size         : {total / 1024:.0f} KB across {entries} entries')
    print(f'INDEX links  : {links} rewritten to canonical names')
    print(f'INDEX covers : {len(indexed)} repos')

    for problem in problems:
        failures.append(f'LIMIT VIOLATION: {problem}')

    if failures:
        # The previous snapshot, if any, is untouched — the staging tree never became `out`.
        print()
        print(f'{RED}✗ Snapshot is INCOMPLETE — {len(failures)} problem'
              f'{"s" if len(failures) != 1 else ""}:{RESET}')
        for failure in failures:
            print(f'  {RED}- {failure}{RESET}')
        print(f'{YELLOW}  Nothing was published; any existing snapshot at {out} is '
              f'unchanged.{RESET}')
        return 1

    if args.dry_run:
        print()
        print(f'{GREEN}✓ Validation passed{RESET} — {len(expected)} repositories agree. '
              f'Nothing was written.')
        return 0

    # MOVE FIRST, THEN VALIDATE. Validating `out` and then renaming it validates one object and
    # deletes whatever happens to occupy that PATHNAME afterwards — Codex replaced the destination
    # between the two and watched a successful publish delete an unrelated file. Moving it aside
    # first means everything from here on concerns the exact object we are holding, and if it
    # turns out not to be our snapshot we put it back untouched.
    retired = None
    quarantined = None          # (st_dev, st_ino) of the object we validated
    if out.exists() or out.is_symlink():
        before = os.lstat(out)
        retired = Path(tempfile.mkdtemp(prefix=f'.{out.name}.previous-', dir=out.parent))
        retired.rmdir()                  # mkdtemp reserved the name; rename needs it free
        try:
            out.rename(retired)
        except BaseException as exc:
            # An interrupt delivered as the rename returns leaves an ambiguous state, so the
            # postcondition is checked rather than assumed: if the move happened, recover.
            moved_anyway = retired.exists() and not out.exists()
            if moved_anyway:
                _restore(retired, out, f'the move was interrupted ({type(exc).__name__})')
            if isinstance(exc, Exception):
                if not moved_anyway:
                    print(f'{RED}✗ could not move the existing {out} aside: {exc}{RESET}')
                return 1
            raise

        # Everything from here is a state machine with a recovery obligation: once the old tree is
        # quarantined, every exit must either put it back or say exactly where it is.
        # BaseException, not Exception — a Ctrl-C during validation left `out` absent, the old
        # snapshot under a .previous-* name nobody was told about, and the interrupt escaping.
        try:
            after = os.lstat(retired)
            quarantined = (after.st_dev, after.st_ino)
            if (before.st_dev, before.st_ino) != quarantined:
                return _restore(retired, out, 'it was replaced while being moved aside',
                                expect=quarantined)
            ok, why, retired_plan = inspect_snapshot(retired)
            if not ok:
                return _restore(retired, out, f'it is not a valid snapshot ({why})',
                                expect=quarantined)
        except BaseException as exc:
            _restore(retired, out, f'it could not be verified ({type(exc).__name__}: {exc})',
                     expect=quarantined)
            if isinstance(exc, Exception):
                return 1
            raise                        # KeyboardInterrupt / SystemExit, after recovering

    try:
        # `out` must still be absent. os.rename would silently replace an empty directory that
        # appeared here since the move, and we have proven nothing about it.
        if retired is not None and (out.exists() or out.is_symlink()):
            return _restore(retired, out, 'something new appeared at the destination',
                            expect=quarantined)
        staging.rename(out)
    except BaseException as exc:
        # If the install actually landed, the new snapshot is live and restoring the old one over
        # it would be wrong; say where the old one is instead.
        if out.exists() and not staging.exists():
            if retired is not None:
                print(f'{YELLOW}  The new snapshot was installed before the interruption; the '
                      f'previous one is retained at {retired}{RESET}')
            if isinstance(exc, Exception):
                return 1
            raise
        if retired is not None:
            _restore(retired, out, f'the new snapshot could not be installed '
                                   f'({type(exc).__name__}: {exc})', expect=quarantined)
            if isinstance(exc, Exception):
                return 1
            raise
        if isinstance(exc, Exception):
            print(f'{RED}✗ could not install the new snapshot at {out}: {exc}{RESET}')
            return 1
        raise

    if retired is not None:
        # Delete the exact entries we verified, not "whatever is under that root inode". The root
        # inode says nothing about the contents: a file added after validation was swept up by a
        # run reporting success.
        failure = _remove_exact(retired, retired_plan, quarantined)
        if failure:
            print(f'{YELLOW}  Warning: the previous snapshot was not removed ({failure}).{RESET}')
            print(f'{YELLOW}  It is retained at {retired}{RESET}')

    print()
    print(f'{GREEN}✓ Snapshot complete{RESET} — configured, INDEX and manifest all agree on '
          f'{len(expected)} repositories')
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog='repo-radar publish',
                                     description='Publish the pristine corpus as a snapshot')
    parser.add_argument('--out', required=True, help='output directory')
    parser.add_argument('--src', default=None, help='corpus directory (default: pristine dir)')
    parser.add_argument('--generator-version', default=None)
    parser.add_argument('--generated-at', default=None, help='RFC3339 Z (default: now)')
    parser.add_argument('--dry-run', '-n', action='store_true')
    return publish_mode(parser.parse_args(argv))


if __name__ == '__main__':
    sys.exit(main())
