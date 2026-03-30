"""CLI entry point and argument parsing."""

import sys
from repo_radar import VERSION
from repo_radar.constants import RED, RESET
from repo_radar.ui import print_help, get_description


def main():
    """Main entry point."""
    import argparse

    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('command', nargs='?',
                        choices=['configure', 'sync', 'analyze', 'clean', 'help', 'get-description'])
    parser.add_argument('--dry-run', '-n', action='store_true')
    parser.add_argument('--force', '-f', action='store_true')
    parser.add_argument('--metadata-only', action='store_true')
    parser.add_argument('--repos-only', action='store_true')
    parser.add_argument('--regenerate-metadata', action='store_true')
    parser.add_argument('--skip-metadata', action='store_true')
    parser.add_argument('--status-server', action='store_true')
    parser.add_argument('--version', '-V', action='store_true')

    args = parser.parse_args()

    if args.version:
        print(f"repo-radar v{VERSION}")
        return 0

    if args.command == 'help' or args.command is None:
        print_help()
        return 0

    if args.command == 'get-description':
        get_description()
        return 0

    # Clean command only needs inquirer (not full dependency check)
    if args.command == 'clean':
        if not args.force and not args.dry_run:
            try:
                __import__('inquirer')
            except ImportError:
                print(f"{RED}Error: 'inquirer' package required for interactive confirmation{RESET}")
                print("Install with: pip install inquirer")
                print("Or use --force to skip confirmation")
                return 2
        from repo_radar.modes.clean import clean_mode
        return clean_mode(args)

    # Check full dependencies for other commands
    from repo_radar.dependencies import check_dependencies
    if not check_dependencies():
        print(f"\n{RED}Cannot continue without required dependencies{RESET}")
        return 2

    if args.command == 'configure':
        from repo_radar.modes.configure import configure_mode
        return configure_mode(args)
    elif args.command == 'analyze':
        from repo_radar.modes.analyze import analyze_mode
        return analyze_mode(args)
    elif args.command == 'sync':
        from repo_radar.modes.sync import sync_mode
        return sync_mode(args)

    return 0
