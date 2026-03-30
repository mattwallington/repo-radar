"""Git operations: running commands, fetching repo status, branch detection."""

import subprocess
from pathlib import Path
from repo_radar.config import load_config, get_cache_name, PRISTINE_DIR
from repo_radar.constants import GREEN, YELLOW, RED, CYAN, BOLD, RESET


def run_git_command(cmd, cwd=None, check=True):
    """Run a git command and return the result."""
    try:
        result = subprocess.run(
            cmd,
            cwd=cwd,
            capture_output=True,
            text=True,
            check=check
        )
        return result
    except subprocess.CalledProcessError as e:
        return e


def get_repo_status(repo_path, repo_config):
    """Get status information for a repository."""
    status = {
        'exists': False,
        'current_branch': None,
        'commits_behind': 0,
        'has_uncommitted': False,
        'metadata_exists': False,
        'metadata_outdated': False,
        'last_commit': None,
        'metadata_commit': None
    }

    if not repo_path.exists():
        return status

    status['exists'] = True

    # Get current branch
    result = run_git_command(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], cwd=repo_path, check=False)
    if result.returncode == 0:
        status['current_branch'] = result.stdout.strip()

    # Get current commit
    result = run_git_command(['git', 'rev-parse', 'HEAD'], cwd=repo_path, check=False)
    if result.returncode == 0:
        status['last_commit'] = result.stdout.strip()

    # Check for uncommitted changes
    result = run_git_command(['git', 'status', '--porcelain'], cwd=repo_path, check=False)
    if result.returncode == 0:
        status['has_uncommitted'] = bool(result.stdout.strip())

    # Fetch to get latest remote info
    run_git_command(['git', 'fetch', 'origin'], cwd=repo_path, check=False)

    # Get commits behind origin
    if status['current_branch']:
        result = run_git_command(
            ['git', 'rev-list', '--count', f"HEAD..origin/{status['current_branch']}"],
            cwd=repo_path,
            check=False
        )
        if result.returncode == 0:
            try:
                status['commits_behind'] = int(result.stdout.strip())
            except ValueError:
                pass

    # Check metadata
    cache_name = get_cache_name(repo_config['clone_url'], repo_config['name'])
    metadata_file = PRISTINE_DIR / f"{cache_name}.md"

    if metadata_file.exists():
        status['metadata_exists'] = True

        # Read metadata to get last analyzed commit
        try:
            with open(metadata_file, 'r') as f:
                content = f.read()
                # Parse frontmatter
                if content.startswith('---'):
                    parts = content.split('---', 2)
                    if len(parts) >= 3:
                        frontmatter = parts[1]
                        for line in frontmatter.split('\n'):
                            if line.startswith('last_commit:'):
                                status['metadata_commit'] = line.split(':', 1)[1].strip()
                                break

                # Check if metadata is outdated
                if status['last_commit'] and status['metadata_commit']:
                    status['metadata_outdated'] = status['last_commit'] != status['metadata_commit']
        except Exception:
            pass

    return status


def determine_preferred_branch(repo_path, default_branch):
    """Determine the preferred branch to checkout."""
    # Get list of remote branches
    result = run_git_command(['git', 'branch', '-r'], cwd=repo_path, check=False)
    if result.returncode != 0:
        return default_branch

    branches = [b.strip().replace('origin/', '') for b in result.stdout.split('\n') if 'origin/' in b and 'HEAD' not in b]

    # Check in order: dev, develop, main
    for preferred in ['dev', 'develop', 'main']:
        if preferred in branches:
            return preferred

    # Fall back to default_branch if it exists
    if default_branch in branches:
        return default_branch

    # Return first branch
    return branches[0] if branches else None
