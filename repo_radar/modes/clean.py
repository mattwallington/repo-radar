"""Clean mode: remove cached repositories and metadata."""

import os
import shutil
from pathlib import Path

from repo_radar.config import PRISTINE_DIR, INDEX_FILE, CONFIG_FILE
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


def clean_mode(args):
    """Clean/remove cached repositories and metadata."""
    print(f"{BOLD}Clean Pristine Cache{RESET}")
    print()

    if not PRISTINE_DIR.exists():
        print(f"{YELLOW}Pristine directory doesn't exist: {PRISTINE_DIR}{RESET}")
        return 0

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
