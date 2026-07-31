"""Clean mode: remove cached repositories and metadata."""

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

from repo_radar.config import (PRISTINE_DIR, INDEX_FILE, CONFIG_FILE, CACHE_INDEX_FILE,
                               load_config, load_exclusions, is_excluded, get_cache_name)
from repo_radar.constants import GREEN, CYAN, YELLOW, RED, BOLD, RESET
from repo_radar.ui import format_size


def get_directory_size(path):
    """Calculate total size of a directory in bytes."""
    total = 0
    try:
        for entry in Path(path).rglob('*'):
            if entry.is_file():
                try:
                    total += entry.stat().st_size
                except:
                    pass
    except:
        pass
    return total


REPO_KEY = re.compile(r'^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$')


class UnusableConfig(Exception):
    """The configuration cannot be trusted to say what belongs in the corpus."""


def find_orphans(pristine_dir, config, cache_index=None):
    """Cached clones and metadata belonging to no configured, non-excluded repository.

    A clone whose repository has been de-configured or excluded is never updated again, but keeps
    consuming disk and — if it still has a metadata file — keeps appearing in INDEX.md as though
    it were live. `clean` was all-or-nothing (wipe the entire cache), so there was no way to
    remove just these without re-cloning everything.

    FAILS CLOSED. Everything here decides what to delete, so every uncertainty resolves toward
    keeping data:

      - A missing or malformed config raises rather than reading as "nothing is configured",
        which would have made the entire corpus an orphan.
      - .cache-index.json is consulted FIRST, because sync treats that url -> cache-name mapping
        as authoritative; recomputing the name instead would classify a legitimately migrated or
        legacy-mapped cache as an orphan and delete it.
      - Anything that cannot be positively identified as a repo-radar artifact is reported as
        UNKNOWN and never becomes a deletion candidate.

    Returns (orphans, kept, unknown); each orphan is (path, full_name_or_None, reason).
    """
    if not isinstance(config, dict) or 'repositories' not in config:
        raise UnusableConfig('no configuration found — refusing to classify anything as an orphan')
    repositories = config.get('repositories')
    if not isinstance(repositories, list):
        raise UnusableConfig('config "repositories" is not a list — refusing to guess')
    if cache_index is MALFORMED_CACHE_INDEX:
        # Distinct from "no cache index at all", which is a legitimate pre-migration state. A
        # cache index we cannot read may hold the only mapping proving a nonstandard directory
        # belongs to a live repository, so its loss must not be silently treated as "no mappings".
        raise UnusableConfig('.cache-index.json is unreadable — its mappings may be the only '
                             'evidence that a cache directory is live')
    if not isinstance(cache_index, dict):
        cache_index = {}
    else:
        # Top-level dict is not enough: a non-string mapping is a mapping we cannot use, and
        # treating it as absent silently discards the evidence that keeps a cache alive.
        for key, value in cache_index.items():
            if not isinstance(key, str) or not isinstance(value, str) or not value.strip():
                raise UnusableConfig('.cache-index.json contains a non-string mapping — its '
                                     'mappings may be the only evidence that a cache is live')

    exclusions = load_exclusions(config)
    configured = {}           # casefolded cache name -> full name
    configured_names = set()  # every non-excluded configured full name, casefolded
    for repo in repositories:
        if not isinstance(repo, dict):
            raise UnusableConfig('config contains a non-object repository entry')
        full_name = (repo.get('full_name') or '').strip()
        if not full_name:
            # An entry we cannot name is not evidence that nothing is configured. Skipping it
            # quietly shrank the "configured" set and turned live caches into orphans.
            raise UnusableConfig('a configured repository entry has no full_name — refusing to '
                                 'treat the rest as the complete corpus')
        if not REPO_KEY.match(full_name):
            raise UnusableConfig(f'configured repository {full_name!r} is not owner/name')
        if is_excluded(full_name, exclusions):
            continue                      # configured but excluded: its cache is an orphan
        raw_url = repo.get('clone_url')
        if not isinstance(raw_url, str) or not raw_url.strip():
            # get_cache_name('' , name) happily hashes the empty string, producing a cache name
            # that matches nothing — so the repository's real directory looked unclaimed.
            raise UnusableConfig(f'configured repository {full_name} has no clone_url — cannot '
                                 f'determine which cache directory belongs to it')
        # Normalise once and use the SAME value for hashing and lookup. Checking `.strip()` while
        # hashing the padded original produced a cache name matching nothing, so a live cache for
        # a configured repository was classified as an orphan.
        clone_url = raw_url.strip()
        configured_names.add(full_name.casefold())
        # The recorded mapping wins; the deterministic name is only the fallback. Both spellings
        # are tried because an existing index may have been keyed with the unnormalised URL.
        cache_name = (cache_index.get(clone_url) or cache_index.get(raw_url)
                      or get_cache_name(clone_url, full_name.split('/')[-1]))
        configured[cache_name.casefold()] = full_name

    # Any name the cache index maps to is a repo-radar artifact, even if its repo is gone.
    known_cache_names = set(configured) | {v.casefold() for v in cache_index.values()}

    orphans, kept, unknown = [], [], []
    for item in sorted(Path(pristine_dir).iterdir()):
        if item.is_symlink() or item.name.startswith('.'):
            continue                      # stable-name symlinks follow their target
        if item.name == 'INDEX.md':
            continue                      # ours, regenerated, never an orphan
        if item.is_dir():
            name = item.name
        elif item.suffix == '.md':
            name = item.stem
        else:
            unknown.append((item, 'not a repository directory or metadata file'))
            continue
        # GitHub identities are case-insensitive, so Org/Kept and org/kept are one repository.
        # Comparing them exactly classified a live clone AND its metadata as orphans.
        if name.casefold() in configured:
            kept.append((item, configured[name.casefold()]))
            continue

        full_name = _repo_radar_metadata_identity(Path(pristine_dir) / f'{name}.md', name)
        # A configured repository stored under a nonstandard cache name — migrated, or predating
        # the current naming — is still live. Its metadata says so, and believing only the
        # computed name deleted it.
        if full_name and full_name.casefold() in configured_names:
            kept.append((item, full_name))
            continue
        origin = owner_name_of_clone(item) if item.is_dir() else None
        if origin and origin.casefold() in configured_names:
            kept.append((item, origin))
            continue

        # Ownership evidence, in descending strength. A filename SHAPE is not evidence on its own:
        # `meeting-deadbee.md` matches `<name>-<7hex>` and is not ours, and neither is an ordinary
        # note that happens to contain a `full_name:` line.
        # POSITIVE evidence only, and a cache-shaped name plus a .git directory is not it: an
        # ordinary personal checkout called `personal-project-deadbee` satisfied exactly that and
        # became deletable. The three things that actually prove ownership are an authoritative
        # cache-index mapping, metadata we wrote that claims this entry, or a readable origin
        # remote. The 659 MB firmware clone is still covered — by its verified origin.
        if name.casefold() in known_cache_names:
            recognised = True
        elif full_name:
            recognised = True            # metadata naming owner/name AND its own cache_dir
        else:
            recognised = bool(origin)
        if not recognised:
            unknown.append((item, 'cannot identify as a repo-radar cache entry'))
            continue

        identity = full_name or origin or _repo_name_from_cache_dir(name)
        if identity and is_excluded(identity, exclusions):
            reason = f'excluded by configuration ({identity})'
        elif full_name:
            reason = f'not in configured repositories ({full_name})'
        else:
            reason = f'not in configured repositories ({identity}, inferred from directory name)'
        orphans.append((item, full_name, reason))
    return orphans, kept, unknown


MALFORMED_CACHE_INDEX = object()


def load_cache_index_strict():
    """The cache index, or MALFORMED_CACHE_INDEX. Absent is {} — absent and corrupt differ."""
    if not CACHE_INDEX_FILE.exists():
        return {}
    try:
        data = json.loads(CACHE_INDEX_FILE.read_text())
    except (OSError, ValueError):
        return MALFORMED_CACHE_INDEX
    return data if isinstance(data, dict) else MALFORMED_CACHE_INDEX


def owner_name_of_clone(path):
    """Owner/Name from a clone's origin remote, or None. Never raises."""
    try:
        result = subprocess.run(['git', '-C', str(path), 'remote', 'get-url', 'origin'],
                                capture_output=True, text=True, timeout=15)
        if result.returncode != 0:
            return None
        match = re.search(r'[:/]([^/:]+)/([^/]+?)(?:\.git)?/?$', result.stdout.strip())
        return f'{match.group(1)}/{match.group(2)}' if match else None
    except Exception:
        return None


def _looks_like_repo_radar_artifact(path):
    """A cache-shaped directory is only ours if it is actually a git clone.

    Without this, any directory whose name happened to end in seven hex characters — or that the
    caller simply could not identify — became a deletion candidate.
    """
    if path.is_dir():
        return (path / '.git').exists()
    return path.suffix == '.md'


def _repo_name_from_cache_dir(name):
    """'reperio-nordic-fw-0a10653' -> 'reperio-nordic-fw'. None if it has no cache suffix.

    get_cache_name appends '-<7 hex>', so requiring exactly that shape avoids mangling a real
    repository whose name merely ends in something short.
    """
    # 7 or more, matching the publisher's CACHE_SUFFIX. Pinned at exactly 7, the two disagreed
    # about the same directory whenever a longer short-sha was used.
    match = re.fullmatch(r'(.+)-([0-9a-f]{7,})', name)
    return match.group(1) if match else None


def _repo_radar_metadata_identity(metadata_file, expected_cache_dir):
    """The repository a repo-radar metadata file describes, or None. Never raises.

    Deliberately narrow, because this answers "may we delete this?". Any Markdown note containing
    a `full_name:` line used to qualify as ownership evidence. Real metadata is written by us and
    always carries BOTH an owner/name full_name and a cache_dir naming its own cache entry, so
    requiring the pair costs nothing and makes an arbitrary note fail to qualify.
    """
    try:
        content = metadata_file.read_text()
    except (OSError, UnicodeDecodeError):
        return None
    if not content.startswith('---'):
        return None
    parts = content.split('---', 2)
    if len(parts) < 3:
        return None
    fields = {}
    for line in parts[1].split('\n'):
        if ':' in line and not line.startswith((' ', '\t', '-')):
            key, _, value = line.partition(':')
            fields[key.strip()] = value.strip()
    full_name = fields.get('full_name', '')
    cache_dir = fields.get('cache_dir', '')
    if not REPO_KEY.match(full_name):
        return None
    if cache_dir.casefold() != str(expected_cache_dir).casefold():
        return None                      # metadata that does not claim THIS entry proves nothing
    return full_name


def _clean_orphans(args):
    """Report — and with --force, remove — cached data for unconfigured/excluded repositories."""
    config = load_config()
    try:
        orphans, kept, unknown = find_orphans(PRISTINE_DIR, config, load_cache_index_strict())
    except UnusableConfig as e:
        # Deleting on the basis of a config we could not read would delete everything, since a
        # config that lists nothing makes every cached repository an orphan.
        print(f"{RED}Refusing to identify orphans: {e}{RESET}")
        print(f"{YELLOW}  Nothing was removed. Fix or restore {CONFIG_FILE} first.{RESET}")
        return 1

    if unknown:
        print(f"{CYAN}Ignoring {len(unknown)} unrecognised item"
              f"{'s' if len(unknown) != 1 else ''} (never removed by --orphans):{RESET}")
        for path, why in unknown:
            print(f"    {path.name} — {why}")
        print()

    if not orphans:
        print(f"{GREEN}No orphans:{RESET} all {len(kept)} cached items belong to configured "
              f"repositories")
        return 0

    # Plan the symlinks up front so the preview matches exactly what --force removes. Sweeping
    # "every dangling symlink" afterwards could remove ones this invocation never accounted for.
    targets = {path.resolve() for path, _f, _r in orphans}
    doomed_links = [item for item in sorted(PRISTINE_DIR.iterdir())
                    if item.is_symlink() and _link_target(item) in targets]

    total = 0
    print(f"Orphaned cache entries ({len(orphans)}):")
    for path, _full_name, reason in orphans:
        size = get_directory_size(path) if path.is_dir() else path.stat().st_size
        total += size
        print(f"  {YELLOW}{path.name}{RESET} — {reason} [{format_size(size)}]")
    for link in doomed_links:
        print(f"  {YELLOW}{link.name}{RESET} — symlink to a removed entry")
    print(f"\nTotal reclaimable: {YELLOW}{format_size(total)}{RESET}")

    # REPORT ONLY. Deleting by a previously-classified PATHNAME is the same defect class that
    # this review cycle found six times over in the publisher: classification and removal are two
    # operations, and anything can occupy that name in between — reproduced by moving a classified
    # orphan away, planting a foreign directory, and watching it be deleted and reported as the
    # orphan. Rather than build another identity-binding deletion state machine, --orphans now
    # tells you what to remove and lets you do it, which is safe by construction.
    print()
    print(f'{CYAN}Nothing was removed.{RESET} --orphans reports only; remove what you want with:')
    for path, _full_name, _reason in orphans:
        print(f'  rm -rf {path}')
    for link in doomed_links:
        print(f'  rm {link}')
    print()
    print(f'{YELLOW}  (Deletion is not automated here: identifying a path and deleting it are two '
          f'steps, and what sits at that name can change in between.){RESET}')
    return 0


def _link_target(link):
    """Absolute target of a symlink without requiring it to exist. None if unreadable."""
    try:
        return (link.parent / os.readlink(link)).resolve()
    except OSError:
        return None


def clean_mode(args):
    """Clean/remove cached repositories and metadata."""
    print(f"{BOLD}Clean Pristine Cache{RESET}")
    print()

    if not PRISTINE_DIR.exists():
        print(f"{YELLOW}Pristine directory doesn't exist: {PRISTINE_DIR}{RESET}")
        return 0

    # Orphans only: everything belonging to no configured, non-excluded repository. Scoped this
    # way because the alternative for removing one stale 684 MB clone was wiping the whole cache
    # and re-cloning thirty repositories.
    if getattr(args, 'orphans', False):
        return _clean_orphans(args)

    # Determine what to clean
    clean_repos = not args.metadata_only
    clean_metadata = not args.repos_only

    # Collect items to delete
    items_to_delete = []
    total_size = 0

    if clean_repos:
        # Find all repo directories and symlinks (exclude .cache-index.json and *.md files)
        for item in PRISTINE_DIR.iterdir():
            if item.is_symlink():
                # Symlink to a repo directory
                items_to_delete.append(('symlink', item, 0))
            elif item.is_dir():
                # Actual repo directory
                size = get_directory_size(item)
                items_to_delete.append(('repo', item, size))
                total_size += size

    if clean_metadata:
        # Find all metadata files and symlinks (*.md excluding INDEX.md)
        for item in PRISTINE_DIR.glob('*.md'):
            if item.name != 'INDEX.md':
                if item.is_symlink():
                    # Metadata symlink
                    items_to_delete.append(('metadata_symlink', item, 0))
                else:
                    # Actual metadata file
                    try:
                        size = item.stat().st_size
                        items_to_delete.append(('metadata', item, size))
                        total_size += size
                    except:
                        pass

        # Also check old .metadata directory (for backwards compatibility)
        old_metadata_dir = PRISTINE_DIR / ".metadata"
        if old_metadata_dir.exists() and old_metadata_dir.is_dir():
            for item in old_metadata_dir.glob('*.md'):
                try:
                    size = item.stat().st_size
                    items_to_delete.append(('metadata', item, size))
                    total_size += size
                except:
                    pass
            # Add the .metadata directory itself
            items_to_delete.append(('metadata_dir', old_metadata_dir, 0))

        # Also check old _metadata directory (if it exists)
        underscore_metadata_dir = PRISTINE_DIR / "_metadata"
        if underscore_metadata_dir.exists() and underscore_metadata_dir.is_dir():
            for item in underscore_metadata_dir.glob('*.md'):
                try:
                    size = item.stat().st_size
                    items_to_delete.append(('metadata', item, size))
                    total_size += size
                except:
                    pass
            # Add the _metadata directory itself
            items_to_delete.append(('metadata_dir', underscore_metadata_dir, 0))

        # Also include INDEX.md if cleaning metadata
        if INDEX_FILE.exists():
            try:
                size = INDEX_FILE.stat().st_size
                items_to_delete.append(('index', INDEX_FILE, size))
                total_size += size
            except:
                pass

    if not items_to_delete:
        print(f"{YELLOW}Nothing to clean{RESET}")
        return 0

    # Show what will be deleted
    repo_count = sum(1 for t, _, _ in items_to_delete if t == 'repo')
    symlink_count = sum(1 for t, _, _ in items_to_delete if t == 'symlink')
    metadata_count = sum(1 for t, _, _ in items_to_delete if t == 'metadata')
    metadata_dir_count = sum(1 for t, _, _ in items_to_delete if t == 'metadata_dir')
    index_count = sum(1 for t, _, _ in items_to_delete if t == 'index')

    print(f"Will delete:")
    if repo_count > 0:
        print(f"  {RED}{repo_count} repository directories{RESET}")
    if symlink_count > 0:
        print(f"  {RED}{symlink_count} symlinks{RESET}")
    if metadata_count > 0:
        print(f"  {RED}{metadata_count} metadata files{RESET}")
    if metadata_dir_count > 0:
        print(f"  {RED}{metadata_dir_count} metadata directories{RESET}")
    if index_count > 0:
        print(f"  {RED}INDEX.md{RESET}")
    print(f"\nTotal size: {YELLOW}{format_size(total_size)}{RESET}")
    print()

    # Dry run exits early
    if args.dry_run:
        print(f"{CYAN}[DRY RUN]{RESET} Would delete {len(items_to_delete)} items")
        return 0

    # Confirmation (unless --force)
    if not args.force:
        import inquirer
        questions = [
            inquirer.List(
                'confirm',
                message=f"Are you sure you want to delete these {len(items_to_delete)} items?",
                choices=[
                    ('Yes, delete everything', True),
                    ('No, cancel', False)
                ]
            )
        ]

        answers = inquirer.prompt(questions)
        if not answers or not answers['confirm']:
            print(f"{YELLOW}Cancelled{RESET}")
            return 0

    # Delete items
    deleted = 0
    failed = 0

    for item_type, item_path, _ in items_to_delete:
        try:
            if item_path.is_symlink():
                # Delete symlink
                item_path.unlink()
            elif item_path.is_dir():
                # Delete directory
                shutil.rmtree(item_path)
            else:
                # Delete file
                item_path.unlink()
            deleted += 1

            if item_type == 'repo':
                print(f"  {GREEN}✓{RESET} Deleted repo: {item_path.name}")
            elif item_type == 'symlink':
                print(f"  {GREEN}✓{RESET} Deleted symlink: {item_path.name}")
            elif item_type == 'metadata':
                print(f"  {GREEN}✓{RESET} Deleted metadata: {item_path.name}")
            elif item_type == 'metadata_symlink':
                print(f"  {GREEN}✓{RESET} Deleted metadata symlink: {item_path.name}")
            elif item_type == 'metadata_dir':
                print(f"  {GREEN}✓{RESET} Deleted directory: {item_path.name}")
            elif item_type == 'index':
                print(f"  {GREEN}✓{RESET} Deleted INDEX.md")
        except Exception as e:
            failed += 1
            print(f"  {RED}✗{RESET} Failed to delete {item_path.name}: {e}")

    print()
    print(f"{BOLD}Clean Summary:{RESET}")
    print(f"  Deleted: {GREEN}{deleted}{RESET}")
    print(f"  Failed: {RED}{failed}{RESET}")
    print(f"  Freed: {GREEN}{format_size(total_size)}{RESET}")
    print()
    print(f"{GREEN}Configuration preserved at:{RESET} {CONFIG_FILE}")

    return 0 if failed == 0 else 1
