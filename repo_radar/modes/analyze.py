"""Analyze mode: report repository status without making changes."""

from repo_radar.config import load_config, load_cache_index, get_cache_name, PRISTINE_DIR
from repo_radar.constants import GREEN, BLUE, CYAN, YELLOW, RED, BOLD, RESET
from repo_radar.git import get_repo_status
from repo_radar.ui import get_short_id, format_id


def analyze_mode(args):
    """Run analysis mode."""
    print(f"{BOLD}Repository Analysis{RESET}")
    print()

    # Load configuration
    config = load_config()
    if not config:
        print(f"{RED}No configuration found. Run 'configure' first.{RESET}")
        return 1

    repos = config.get('repositories', [])
    if not repos:
        print(f"{YELLOW}No repositories configured{RESET}")
        return 0

    print(f"Analyzing {len(repos)} configured repositories...")
    print()

    # Load cache index
    cache_index = load_cache_index()

    # Analyze each repository
    results = {
        'total': len(repos),
        'cached': 0,
        'missing': 0,
        'up_to_date': 0,
        'behind': 0,
        'uncommitted': 0,
        'metadata_missing': 0,
        'metadata_outdated': 0
    }

    for repo_config in repos:
        full_name = repo_config['full_name']
        clone_url = repo_config['clone_url']

        # Get cache directory
        cache_name = cache_index.get(clone_url)
        if not cache_name:
            # Generate it
            repo_name = full_name.split('/')[-1]
            cache_name = get_cache_name(clone_url, repo_name)

        repo_path = PRISTINE_DIR / cache_name

        # Get status
        status = get_repo_status(repo_path, {**repo_config, 'name': full_name.split('/')[-1]})

        # Print status
        if status['exists']:
            results['cached'] += 1

            # Branch and commits info
            branch_info = f"{CYAN}{status['current_branch']}{RESET}" if status['current_branch'] else f"{YELLOW}unknown{RESET}"

            if status['commits_behind'] > 0:
                results['behind'] += 1
                behind_info = f"{YELLOW}{status['commits_behind']} commits behind{RESET}"
            else:
                results['up_to_date'] += 1
                behind_info = f"{GREEN}up to date{RESET}"

            # Uncommitted changes
            if status['has_uncommitted']:
                results['uncommitted'] += 1
                uncommitted_info = f"{YELLOW}has uncommitted changes{RESET}"
            else:
                uncommitted_info = ""

            # Metadata status
            if not status['metadata_exists']:
                results['metadata_missing'] += 1
                metadata_info = f"{YELLOW}metadata missing{RESET}"
            elif status['metadata_outdated']:
                results['metadata_outdated'] += 1
                metadata_info = f"{YELLOW}metadata outdated{RESET}"
            else:
                metadata_info = f"{GREEN}metadata current{RESET}"

            print(f"{GREEN}✓{RESET} {full_name:<40} ({cache_name})")
            print(f"  Branch: {branch_info} | Status: {behind_info} | Metadata: {metadata_info}")
            if uncommitted_info:
                print(f"  {uncommitted_info}")
        else:
            results['missing'] += 1
            print(f"{RED}✗{RESET} {full_name:<40} {RED}not cached{RESET}")

        print()

    # Summary
    print(f"{BOLD}Summary:{RESET}")
    print(f"  Total configured: {results['total']}")
    print(f"  Cached: {GREEN}{results['cached']}{RESET}")
    print(f"  Missing: {RED}{results['missing']}{RESET}")
    print(f"  Up to date: {GREEN}{results['up_to_date']}{RESET}")
    print(f"  Behind origin: {YELLOW}{results['behind']}{RESET}")
    print(f"  With uncommitted changes: {YELLOW}{results['uncommitted']}{RESET}")
    print(f"  Metadata missing: {YELLOW}{results['metadata_missing']}{RESET}")
    print(f"  Metadata outdated: {YELLOW}{results['metadata_outdated']}{RESET}")

    return 0
