"""Publish the pristine corpus as an Agent Context Snapshot.

Cloud agents reviewing a PR have none of the cross-repo knowledge a desktop agent gets from
~/repos-pristine. This emits the schema-v1 tree their consumer validates:

    <out>/manifest.json
    <out>/pristine/INDEX.md
    <out>/pristine/<repo>.md          one per repo, canonical names, never symlinks

`--out` is a MANAGED ROOT that accumulates immutable generations; the exact-set artifact the
consumer validates is a single generation directory, whose path this command prints:

    <out>/generations/<content digest>/     <- copy or ship THIS

There is deliberately no mutable `current` pointer: it was the last operation here that could
overwrite something, and after the corpus changed it would name the previous generation while
claiming to be current. Copying the managed root itself would include every past generation and
fail the consumer. Within a generation, nothing may be present that the manifest does not declare, and
nothing declared may be missing:

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
RFC3339_Z = re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z')
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
    generated_at = manifest.get('generatedAt')
    if not isinstance(generated_at, str) or not RFC3339_Z.fullmatch(generated_at):
        problems.append(f'generatedAt must be RFC3339 Z (got {generated_at!r})')
    else:
        try:
            # Shape is not an instant: 2026-99-99T99:99:99Z and 2026-02-30T12:00:00Z both matched.
            datetime.strptime(generated_at, '%Y-%m-%dT%H:%M:%SZ')
        except ValueError:
            problems.append(f'generatedAt is not a real instant (got {generated_at!r})')
    generator_version = manifest.get('generatorVersion')
    if not isinstance(generator_version, str) or not generator_version.strip():
        problems.append('generatorVersion must be a non-empty string')
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


def _declared_files(manifest):
    """Every file path the manifest declares, index first."""
    files = ['manifest.json', 'pristine/INDEX.md']
    files += [e.get('metadataPath', '') for e in (manifest.get('repos') or {}).values()]
    return files


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
    # NOT resolved: resolve() follows a leaf symlink, so `--out snap` where snap -> /elsewhere
    # silently published into /elsewhere while the symlink check downstream saw a real directory.
    # The lexical path is what the user named, and it is what gets lstat-ed.
    out = Path(args.out).expanduser()
    out = (Path.cwd() / out) if not out.is_absolute() else out

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
    # No destination validation, because nothing at the destination is ever replaced or deleted.
    # `out` is a managed root that accumulates immutable generations; an unrelated directory used
    # as --out gains a `generations/` subdirectory and is otherwise untouched.

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

    # IMMUTABLE GENERATIONS. Everything destructive in the previous publisher came from replacing
    # a directory that already existed. Nothing here is replaced or deleted:
    #
    #     <out>/.repo-radar-managed-root      ownership marker
    #     <out>/generations/<content digest>/manifest.json, pristine/...
    #
    # A generation is named by a digest of what it says about the corpus, so its path is a
    # function of its content: republishing an unchanged corpus is a no-op, and different content
    # can never collide. NOTHING pre-existing is ever mutated, replaced or deleted.
    if args.dry_run:
        # Read-only preflight of the predicates the real run enforces. Without it a dry run passed
        # on a destination the real run refuses, which is the one thing a preview must not do.
        ready, why = _destination_preflight(out)
        if not ready:
            print(f'{RED}error: {out} cannot be used as a snapshot root ({why}){RESET}')
            return 1
        staging_parent = None
    else:
        owned, why = _claim_managed_root(out)
        if not owned:
            print(f'{RED}error: {out} cannot be used as a snapshot root ({why}){RESET}')
            print(f'{YELLOW}  Nothing was written. Choose an empty or previously-published '
                  f'path.{RESET}')
            return 1
        staging_parent = out

    staging = Path(tempfile.mkdtemp(prefix='.repo-radar-staging-', dir=staging_parent))
    staging_id = _identity(staging)
    installed = None
    try:
        (staging / 'pristine').mkdir(parents=True)
        (staging / 'pristine/INDEX.md').write_text(index_text, encoding='utf-8', newline='\n')

        generated_at = (getattr(args, 'generated_at', None)
                        or datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))
        generator_version = (getattr(args, 'generator_version', None)
                             or f'repo-radar/{REPO_RADAR_VERSION}')
        manifest, snapshot_id = build_manifest(repos, staging, generated_at, generator_version)
        (staging / 'manifest.json').write_text(canonical(manifest), encoding='utf-8', newline='\n')

        files = [q for q in staging.rglob('*') if q.is_file()]
        entries = len(files) + len([q for q in staging.rglob('*') if q.is_dir()])
        total = sum(q.stat().st_size for q in files)
        problems = [f'{q.relative_to(staging)} is {q.stat().st_size}B > {MAX_FILE}'
                    for q in files if q.stat().st_size > MAX_FILE]
        if total > MAX_TOTAL:
            problems.append(f'total {total}B > {MAX_TOTAL}')
        if entries > MAX_ENTRIES:
            problems.append(f'{entries} entries > {MAX_ENTRIES}')
        # validate_manifest had no production caller: the staged path checked the tree but never
        # the manifest's own shape.
        problems.extend(validate_manifest(manifest))
        problems.extend(verify_tree(staging, manifest))
        for problem in problems:
            failures.append(f'LIMIT VIOLATION: {problem}')

        projection = _projection(manifest)
        digest = content_id(manifest)
        generation = out / 'generations' / digest
        print(f'snapshot     : {generation}')
        print(f'repos        : {len(published)} published, {len(skipped)} skipped, '
              f'{len(excluded)} excluded')
        print(f'size         : {total / 1024:.0f} KB across {entries} entries')
        print(f'INDEX links  : {links} rewritten to canonical names')
        print(f'INDEX covers : {len(indexed)} repos')

        if failures:
            print()
            print(f'{RED}✗ Snapshot is INCOMPLETE — {len(failures)} problem'
                  f'{"s" if len(failures) != 1 else ""}:{RESET}')
            for failure in failures:
                print(f'  {RED}- {failure}{RESET}')
            print(f'{YELLOW}  Nothing was published.{RESET}')
            return 1

        if args.dry_run:
            # The preflight covered namespace SHAPE, not occupancy: a corrupt generation at the
            # digest path passed the preview and then failed the real run.
            if generation.exists() or generation.is_symlink():
                adopted, occupied_why = inspect_generation(generation, digest, projection)
                if adopted is None:
                    print()
                    print(f'{RED}✗ {generation} is occupied by something that is not this '
                          f'snapshot ({occupied_why}){RESET}')
                    return 1
                print()
                print(f'{CYAN}This generation already exists — publishing would be a '
                      f'no-op.{RESET}')
            print()
            print(f'candidate metadataSnapshotId = {snapshot_id}')
            print(f'{GREEN}✓ Validation passed{RESET} — {len(expected)} repositories agree. '
                  f'Nothing was written.')
            return 0

        ok, why = _namespace_is_sound(out)
        if not ok:
            print(f'{RED}✗ {why}{RESET}')
            return 1

        # Existing occupancy is never trusted just because something is there: a corrupt
        # directory, a symlink or a foreign tree at the digest path was activated as `current` and
        # reported complete. Inspect it, and only adopt it if it IS this snapshot.
        if generation.exists() or generation.is_symlink():
            adopted, why = inspect_generation(generation, digest, projection)
            if adopted is None:
                print(f'{RED}✗ {generation} is occupied by something that is not this snapshot '
                      f'({why}){RESET}')
                print(f'{YELLOW}  It was left untouched and nothing was published.{RESET}')
                return 1
            installed = adopted
            print()
            print(f'{CYAN}This generation already exists — corpus unchanged since it was '
                  f'published.{RESET}')
        else:
            gen_fd = src_fd = None
            try:
                gen_fd = _open_generations(out)
                src_fd = os.open(staging.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            except OSError as exc:
                for fd in (gen_fd, src_fd):
                    if fd is not None:
                        os.close(fd)
                print(f'{RED}✗ could not open the generations directory ({exc}){RESET}')
                return 1
            try:
                # Relative to an OPENED descriptor, so the install lands in the directory we
                # verified even if that pathname is replaced with a symlink a moment later —
                # which put a generation inside an external target and still returned 0.
                os.rename(staging.name, digest, src_dir_fd=src_fd, dst_dir_fd=gen_fd)
                staging = None           # installed; the finally block must not touch it
            except OSError as exc:
                # Another publisher of the SAME content won the race. That is not a failure —
                # inspect its result and adopt it.
                adopted, adopt_why = inspect_generation(generation, digest, projection)
                if adopted is None:
                    print(f'{RED}✗ could not install the generation at {generation}: '
                          f'{exc}{RESET}')
                    if adopt_why:
                        print(f'{YELLOW}  What is there now: {adopt_why}{RESET}')
                    return 1
                installed = adopted
                print()
                print(f'{CYAN}An identical generation was published concurrently; adopting '
                      f'it.{RESET}')
            finally:
                # One descriptor per install was leaked here; /dev/fd grew with every publish.
                for fd in (gen_fd, src_fd):
                    try:
                        os.close(fd)
                    except OSError:
                        pass

            if installed is None:
                # Validation described the STAGED tree; bind it to what actually landed. Swapping
                # staging as the rename began installed a directory containing only MINE and
                # printed success.
                installed, why = inspect_generation(generation, digest, projection)
                if installed is None:
                    print(f'{RED}✗ the installed generation is not the tree that was validated '
                          f'({why}){RESET}')
                    print(f'{YELLOW}  It was left in place, unreferenced, at {generation}{RESET}')
                    return 1

        # No mutable pointer. `current` used to be maintained here, and it was both the last
        # destructive operation left (rename replaces a regular file planted after the type check)
        # and actively misleading: after the corpus changed it would keep naming the previous
        # generation, claiming freshness while being stale. The printed generation path is
        # authoritative and is what gets shipped.
        legacy = out / 'current'
        if legacy.is_symlink() or legacy.exists():
            print(f'{YELLOW}  Note: {legacy} is left over from an older layout and is NOT '
                  f'updated. It may point at an earlier generation.{RESET}')
            print(f'{YELLOW}  Remove it yourself when convenient; use the path above.{RESET}')

        # Report the manifest that is actually stored. A no-op printed the freshly staged id while
        # `current` kept the original generation, whose manifest has a different one.
        # ONE authoritative id, and only after we know what is actually stored. Printing the
        # staged candidate first gave parsers a value that was then discarded on a no-op.
        print(f'metadataSnapshotId = {installed.get("metadataSnapshotId")}')
        if installed.get('metadataSnapshotId') != snapshot_id:
            print(f'{CYAN}  (this generation already existed and is immutable, so it keeps its '
                  f'original generatedAt and generatorVersion){RESET}')

        print()
        print(f'{GREEN}✓ Snapshot complete{RESET} — configured, INDEX and manifest all agree on '
              f'{len(expected)} repositories')
        return 0
    finally:
        # Only ever remove the staging directory this process created, and never after it has been
        # renamed away — recreating that vacated path let an unrelated directory be deleted.
        # THIS PUBLISHER NEVER RECURSIVELY DELETES. Even inode-checked cleanup left a window
        # between the check and the rmtree, and a foreign directory was destroyed in it. A
        # successful install renames staging away; anything else is retained and reported, and
        # the normal temporary-directory lifecycle retires it.
        if staging is not None:
            print(f'{YELLOW}  Staged output retained at: {staging}{RESET}')


MANAGED_ROOT_MARKER = '.repo-radar-managed-root'
MANAGED_ROOT_PAYLOAD = canonical({'tool': 'repo-radar', 'layout': 'generations/v1'})


def _claim_managed_root(out):
    """Positively own `out` before any pointer is mutated. Returns (ok, reason).

    Ownership is proven, not assumed. Every weakening of that was exploitable: resolving the path
    first defeated the symlink check, accepting any file named .repo-radar-managed-root let an
    unrelated directory be adopted, and check-then-write let a marker SYMLINK planted after the
    emptiness check redirect write_text() onto an external file and overwrite it.
    """
    try:
        if out.is_symlink():
            return False, 'it is a symlink'
        marker = out / MANAGED_ROOT_MARKER
        if out.exists():
            if not out.is_dir():
                return False, 'it is not a directory'
            if marker.is_symlink():
                return False, f'{MANAGED_ROOT_MARKER} is a symlink'
            if marker.exists():
                info = os.lstat(marker)
                if not stat.S_ISREG(info.st_mode):
                    return False, f'{MANAGED_ROOT_MARKER} is not a regular file'
                if marker.read_text().strip() != MANAGED_ROOT_PAYLOAD:
                    return False, f'{MANAGED_ROOT_MARKER} does not carry our marker payload'
                return True, 'already managed'
            if any(out.iterdir()):
                return False, f'it is not empty and has no {MANAGED_ROOT_MARKER} marker'
        out.mkdir(parents=True, exist_ok=True)
        # O_EXCL | O_NOFOLLOW: creation fails rather than following a symlink planted between the
        # emptiness check and this write, which is how an external file got overwritten.
        try:
            fd = os.open(marker, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o644)
        except FileExistsError:
            return False, f'{MANAGED_ROOT_MARKER} appeared while the root was being claimed'
        with os.fdopen(fd, 'w') as handle:
            handle.write(MANAGED_ROOT_PAYLOAD + '\n')
        return True, 'claimed'
    except OSError as exc:
        return False, str(exc)


def _open_generations(out):
    """Create if needed and open generations/ with O_NOFOLLOW, returning a descriptor.

    The descriptor is the binding: a static "is it a symlink?" check says nothing about what the
    name refers to a microsecond later, but a descriptor keeps referring to the directory that
    was verified.
    """
    generations = out / 'generations'
    try:
        os.mkdir(generations, 0o755)
    except FileExistsError:
        pass
    return os.open(generations, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)


def _destination_preflight(out):
    """Would the real run accept this destination? Read-only. Returns (ok, reason)."""
    try:
        if out.is_symlink():
            return False, 'it is a symlink'
        if not out.exists():
            return True, 'would be created'
        if not out.is_dir():
            return False, 'it is not a directory'
        marker = out / MANAGED_ROOT_MARKER
        if marker.is_symlink():
            return False, f'{MANAGED_ROOT_MARKER} is a symlink'
        if marker.exists():
            if marker.read_text().strip() != MANAGED_ROOT_PAYLOAD:
                return False, f'{MANAGED_ROOT_MARKER} does not carry our marker payload'
        elif any(out.iterdir()):
            return False, f'it is not empty and has no {MANAGED_ROOT_MARKER} marker'
        return _namespace_is_sound(out)
    except OSError as exc:
        return False, str(exc)


def _namespace_is_sound(out):
    """generations/ must be a real directory of ours, not a symlink pointing elsewhere."""
    generations = out / 'generations'
    try:
        if generations.is_symlink():
            return False, f'{generations} is a symlink; refusing to publish through it'
        if generations.exists() and not generations.is_dir():
            return False, f'{generations} exists and is not a directory'
    except OSError as exc:
        return False, f'{generations} could not be checked ({exc})'
    return True, 'sound'


def _identity(path):
    """(st_dev, st_ino) of a path without following symlinks, or None."""
    try:
        info = os.lstat(path)
        return (info.st_dev, info.st_ino)
    except OSError:
        return None


def _projection(manifest):
    """What a snapshot says about the corpus, ignoring when it was generated."""
    return {'schemaVersion': manifest.get('schemaVersion'),
            'index': manifest.get('index'),
            'repos': manifest.get('repos')}


def content_id(manifest):
    """A digest of the corpus projection. Deliberately NOT metadataSnapshotId, which covers
    generatedAt — naming generations by that minted a fresh directory of identical bytes on
    every run."""
    return hashlib.sha256(canonical(_projection(manifest)).encode('utf-8')).hexdigest()


def inspect_generation(path, expected_digest, expected_projection):
    """Is `path` exactly this snapshot? Returns (manifest, reason) or (None, reason).

    Fail-closed, and used for all three questions that were previously answered by mere existence:
    an already-occupied slot, a concurrently-installed winner, and the tree that actually landed
    after our own rename.
    """
    path = Path(path)
    try:
        if path.is_symlink():
            return None, 'it is a symlink'
        info = os.lstat(path)
        if not stat.S_ISDIR(info.st_mode):
            return None, 'it is not a directory'
        manifest_file = path / 'manifest.json'
        if not manifest_file.is_file():
            return None, 'it has no manifest.json'
        try:
            manifest = json.loads(manifest_file.read_text())
        except (OSError, ValueError) as exc:
            return None, f'its manifest.json is not readable JSON ({exc})'
        problems = validate_manifest(manifest) or verify_tree(path, manifest)
        if problems:
            return None, problems[0]
        if content_id(manifest) != expected_digest:
            return None, 'its content does not match the directory it is stored in'
        if _projection(manifest) != expected_projection:
            return None, 'it describes a different corpus'
        return manifest, 'valid'
    except Exception as exc:
        return None, f'it could not be inspected ({type(exc).__name__}: {exc})'


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
