"""Clean mode: remove cached repositories and metadata."""

import os
import re
import shutil
from pathlib import Path

from repo_radar.config import (PRISTINE_DIR, INDEX_FILE, CONFIG_FILE, load_config,
                               load_cache_index, load_exclusions, is_excluded, get_cache_name)
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

    exclusions = load_exclusions(config)
    cache_index = cache_index if isinstance(cache_index, dict) else {}
    configured = {}
    for repo in repositories:
        if not isinstance(repo, dict):
            raise UnusableConfig('config contains a non-object repository entry')
        full_name = (repo.get('full_name') or '').strip()
        if not full_name:
            continue
        if is_excluded(full_name, exclusions):
            continue                      # configured but excluded: its cache is an orphan
        clone_url = repo.get('clone_url', '')
        # The recorded mapping wins; the deterministic name is only the fallback.
        cache_name = cache_index.get(clone_url) or get_cache_name(clone_url,
                                                                  full_name.split('/')[-1])
        configured[cache_name] = full_name

    # Any name the cache index maps to is a repo-radar artifact, even if its repo is gone.
    known_cache_names = set(configured) | {v for v in cache_index.values() if isinstance(v, str)}

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
        if name in configured:
            kept.append((item, configured[name]))
            continue

        full_name = _full_name_of(Path(pristine_dir) / f'{name}.md')
        # Fall back to the cache-directory shape when there is no metadata. The largest orphan in
        # practice was a 659 MB clone that had never been analyzed, so it had no metadata file and
        # no other way to be recognised as the repository it plainly is.
        inferred = _repo_name_from_cache_dir(name)
        recognised = (name in known_cache_names) or bool(full_name) or (
            inferred is not None and _looks_like_repo_radar_artifact(item))
        if not recognised:
            unknown.append((item, 'cannot identify as a repo-radar cache entry'))
            continue

        identity = full_name or inferred
        if identity and is_excluded(identity, exclusions):
            reason = f'excluded by configuration ({identity})'
        elif full_name:
            reason = f'not in configured repositories ({full_name})'
        else:
            reason = f'not in configured repositories ({identity}, inferred from directory name)'
        orphans.append((item, full_name, reason))
    return orphans, kept, unknown


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


def _full_name_of(metadata_file):
    """full_name from a metadata file's frontmatter, or None. Never raises."""
    try:
        content = metadata_file.read_text()
    except (OSError, UnicodeDecodeError):
        return None
    if not content.startswith('---'):
        return None
    parts = content.split('---', 2)
    if len(parts) < 3:
        return None
    for line in parts[1].split('\n'):
        if line.startswith('full_name:'):
            return line.split(':', 1)[1].strip() or None
    return None


def _clean_orphans(args):
    """Report — and with --force, remove — cached data for unconfigured/excluded repositories."""
    config = load_config()
    try:
        orphans, kept, unknown = find_orphans(PRISTINE_DIR, config, load_cache_index())
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

    if args.dry_run or not args.force:
        print()
        print(f"{CYAN}Nothing removed.{RESET} Re-run with {BOLD}--force{RESET} to delete these "
              f"{len(orphans) + len(doomed_links)} items.")
        return 0

    deleted = failed = 0
    for path, _full_name, _reason in list(orphans) + [(l, None, None) for l in doomed_links]:
        try:
            if path.is_symlink() or path.is_file():
                path.unlink()
            else:
                shutil.rmtree(path)
            deleted += 1
            print(f"  {GREEN}✓{RESET} Removed {path.name}")
        except Exception as e:
            failed += 1
            print(f"  {RED}✗{RESET} Failed to remove {path.name}: {e}")

    print()
    print(f"  Removed: {GREEN}{deleted}{RESET}   Failed: {RED}{failed}{RESET}   "
          f"Freed: {GREEN}{format_size(total)}{RESET}")
    print(f"{CYAN}Run a sync to regenerate INDEX.md without these entries.{RESET}")
    return 0 if failed == 0 else 1


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
