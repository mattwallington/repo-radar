"""Configure mode: GitHub repo discovery and interactive selection."""

import json
import os
from datetime import datetime

from repo_radar.config import load_config, save_config
from repo_radar.constants import GREEN, BLUE, CYAN, YELLOW, RED, BOLD, RESET


def fetch_user_repos(token):
    """Fetch all repositories the user has access to from GitHub API."""
    import requests

    headers = {"Authorization": f"token {token}"}
    repos = []
    page = 1

    print(f"{CYAN}Fetching repositories from GitHub...{RESET}")

    while True:
        try:
            response = requests.get(
                f"https://api.github.com/user/repos?page={page}&per_page=100",
                headers=headers
            )
            response.raise_for_status()
            data = response.json()

            if not data:
                break

            repos.extend(data)
            page += 1

            # Show progress
            print(f"  Found {len(repos)} repositories...", end='\r')

        except requests.exceptions.RequestException as e:
            print(f"\n{RED}Error fetching repositories: {e}{RESET}")
            return None

    print(f"{GREEN}  Found {len(repos)} repositories total{RESET}")

    # Sort by most recent activity
    repos.sort(key=lambda r: r.get('pushed_at', ''), reverse=True)

    # Group by organization/owner
    orgs = {}
    for repo in repos:
        owner = repo['owner']['login']
        if owner not in orgs:
            orgs[owner] = []
        orgs[owner].append({
            'name': repo['name'],
            'full_name': repo['full_name'],
            'clone_url': repo['clone_url'],
            'default_branch': repo.get('default_branch', 'main'),
            'last_pushed_at': repo.get('pushed_at', ''),
            'description': repo.get('description', '')
        })

    return orgs


def select_repositories_interactive(orgs, existing_repos=None):
    """Interactive menu to select repositories to cache."""
    import inquirer

    # Get set of existing repo full names for quick lookup
    existing_full_names = set()
    if existing_repos:
        existing_full_names = {repo['full_name'] for repo in existing_repos}

    # First, select organization
    org_choices = []
    for org_name, repos in orgs.items():
        org_choices.append((f"{org_name} ({len(repos)} repos)", org_name))

    questions = [
        inquirer.List(
            'organization',
            message="Select an organization",
            choices=org_choices
        )
    ]

    answers = inquirer.prompt(questions)
    if not answers:
        return None

    selected_org = answers['organization']
    repos = orgs[selected_org]

    # Now select repositories from that org
    repo_choices = []
    default_selections = []

    for repo in repos:
        pushed_date = repo['last_pushed_at'][:10] if repo['last_pushed_at'] else 'unknown'
        desc = repo['description'][:50] + '...' if repo['description'] and len(repo['description']) > 50 else repo['description'] or ''

        # Check if already configured
        is_configured = repo['full_name'] in existing_full_names

        # Build choice text with indicator for already-configured repos
        if is_configured:
            choice_text = f"{GREEN}✓{RESET} {repo['name']:<30} (already configured)"
            default_selections.append(repo['full_name'])
        else:
            choice_text = f"  {repo['name']:<30} (last push: {pushed_date})"
            if desc:
                choice_text += f" - {desc}"

        repo_choices.append((choice_text, repo['full_name']))

    # Print note before the prompt to avoid inquirer re-rendering issues
    if existing_repos:
        print(f"{CYAN}Note: Already configured repos are pre-selected with ✓{RESET}")
        print()

    questions = [
        inquirer.Checkbox(
            'repos',
            message=f"Select repositories from {selected_org} (use SPACE to select, ENTER when done)",
            choices=repo_choices,
            default=default_selections
        )
    ]

    answers = inquirer.prompt(questions)
    if not answers or not answers['repos']:
        return None

    # Return full repo data for selected repos
    selected_repos = []
    for repo in repos:
        if repo['full_name'] in answers['repos']:
            selected_repos.append(repo)

    return selected_repos


def configure_mode(args):
    """Run configuration wizard."""
    print(f"{BOLD}Configuration Wizard{RESET}")
    print()

    # Check for existing configuration
    existing_config = load_config()
    if existing_config and 'repositories' in existing_config:
        repos = existing_config['repositories']
        print(f"{CYAN}Current configuration:{RESET}")
        print(f"  {len(repos)} repositories configured")
        print(f"  Last configured: {existing_config.get('last_configured', 'unknown')}")
        print()
        print("Configured repositories:")
        for repo in repos:
            print(f"  - {repo['full_name']}")
        print()

        # Ask if they want to reconfigure
        import inquirer
        questions = [
            inquirer.List(
                'action',
                message="What would you like to do?",
                choices=[
                    ('Keep current configuration', 'keep'),
                    ('Add more repositories to current config', 'add'),
                    ('Start fresh (replace all)', 'replace'),
                    ('Cancel', 'cancel')
                ]
            )
        ]

        answers = inquirer.prompt(questions)
        if not answers or answers['action'] == 'cancel':
            print(f"{YELLOW}Configuration cancelled{RESET}")
            return 0
        elif answers['action'] == 'keep':
            print(f"{GREEN}Keeping current configuration{RESET}")
            return 0
        elif answers['action'] == 'add':
            # Will add to existing config
            all_selected_repos = repos.copy()
        else:
            # Replace - start fresh
            all_selected_repos = []
    else:
        all_selected_repos = []

    # Check for GitHub token
    github_token = os.getenv('GITHUB_TOKEN')
    if not github_token:
        print(f"{RED}Error: GITHUB_TOKEN environment variable not set{RESET}")
        print()
        print("To use this script, you need a GitHub classic Personal Access Token")
        print("(not a fine-grained token — those don't work with this app).")
        print("Create one at: https://github.com/settings/tokens/new")
        print("Required scope: 'repo' (Full control of private repositories)")
        print()
        print("If your org uses SAML SSO, click 'Configure SSO' next to the")
        print("token on the tokens page after creating it.")
        print()
        print("Then set it:")
        print("  export GITHUB_TOKEN=ghp_your_token_here")
        return 1

    # Fetch repositories
    orgs = fetch_user_repos(github_token)
    if not orgs:
        return 1

    print()
    print(f"Found repositories in {len(orgs)} organization(s)")
    print()

    # Select repositories (all_selected_repos already initialized above)
    # Pass existing repos so they can be pre-selected in the UI
    existing_for_ui = all_selected_repos if all_selected_repos else None

    while True:
        selected_repos = select_repositories_interactive(orgs, existing_for_ui)

        if selected_repos:
            # Get set of existing repo full names to avoid duplicates
            existing_names = {repo['full_name'] for repo in all_selected_repos}

            # Only add repos that aren't already in the list
            new_repos = [repo for repo in selected_repos if repo['full_name'] not in existing_names]

            if new_repos:
                all_selected_repos.extend(new_repos)
                print(f"{GREEN}Added {len(new_repos)} new repositories{RESET}")
                # Update existing_for_ui for next iteration
                existing_for_ui = all_selected_repos
            else:
                print(f"{YELLOW}No new repositories selected (all were already configured){RESET}")

        import inquirer
        questions = [
            inquirer.List(
                'continue',
                message="What would you like to do?",
                choices=[
                    ('Add more repositories from another organization', 'more'),
                    ('Save configuration and continue', 'save'),
                    ('Cancel', 'cancel')
                ]
            )
        ]

        answers = inquirer.prompt(questions)
        if not answers or answers['continue'] == 'cancel':
            print(f"{YELLOW}Configuration cancelled{RESET}")
            return 0
        elif answers['continue'] == 'save':
            break

    if not all_selected_repos:
        print(f"{YELLOW}No repositories selected{RESET}")
        return 0

    # Save configuration
    config = {
        'github_token': github_token,
        'repositories': all_selected_repos,
        'last_configured': datetime.now().isoformat()
    }

    if save_config(config):
        print()
        print(f"{GREEN}Configuration saved successfully!{RESET}")
        print(f"Selected {len(all_selected_repos)} repositories:")
        for repo in all_selected_repos:
            print(f"  - {repo['full_name']}")
        print()

        # Ask if they want to run initial sync
        import inquirer
        questions = [
            inquirer.List(
                'sync',
                message="Run initial sync now?",
                choices=[('Yes', True), ('No', False)]
            )
        ]

        answers = inquirer.prompt(questions)
        if answers and answers['sync']:
            print()
            # Lazy import to avoid circular dependency
            from repo_radar.modes.sync import sync_mode
            return sync_mode(args)

        return 0
    else:
        print(f"{RED}Failed to save configuration{RESET}")
        return 1
