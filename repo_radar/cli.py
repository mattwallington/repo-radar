"""CLI entry point and argument parsing."""

import os
import sys
from repo_radar import VERSION
from repo_radar.constants import RED, RESET
from repo_radar.ui import print_help, get_description


def _secret_values(cfg):
    """The app's configured secret VALUES (GitHub token + AI provider keys), for write-time
    redaction. `config.json` is shared between this CLI and the Electron app -- Electron writes
    all four of these keys (github_token, gemini_api_key, anthropic_api_key, openai_api_key)
    even though this CLI's own `configure` flow only ever populates github_token itself. Mirrors
    trigger-glue.js's `secretValues()` and the flat-list-of-strings shape
    `repo_radar.activity.redact.Redactor` expects. A missing/malformed config (None, or a config
    with no keys set) yields no configured secrets -- the Redactor's built-in credential-shape
    patterns still apply regardless.
    """
    if not isinstance(cfg, dict):
        return []
    keys = ('github_token', 'anthropic_api_key', 'gemini_api_key', 'openai_api_key')
    return [v for v in (cfg.get(k) for k in keys) if isinstance(v, str) and v]


def _establish_activity():
    """Establish/adopt the activity identity + lease + `start` for the `sync` command, BEFORE
    check_dependencies() runs -- so a dependency failure becomes a durable `blocked` incident
    instead of a silently lost error.

    `sync`-only: `configure`/`analyze` are deliberately NOT wired to this (see the call site in
    `main()`) -- neither mode has a `.terminal()` call on success, so establishing here without a
    matching completion call would leave a phantom started-but-never-terminaled activity that
    reconciliation later synthesizes into a false `interrupted` incident.

    Adopt-vs-mint: a valid inherited handoff env (REPO_RADAR_ACTIVITY_ID/_OWNER_TOKEN/_LOCK_FD --
    set when a dispatcher/Electron parent already minted + leased) is ADOPTED as the executing
    owner (writes a handoff `ownership` ack, not a duplicate `start`). Otherwise a fresh identity
    + lease is MINTED here. This is the path Ruling 13 (Task 2.4) carries forward: the shell
    dispatcher no longer mints an activity for the generic `repo-radar` command, so a direct
    terminal invocation (`repo-radar sync` with no handoff env) now relies on THIS function to
    establish identity at all.

    Never raises: `ActivityWriter` is itself a never-raises facade, and the glue here (env/config
    reads, channel/trigger resolution) is wrapped too, so a wholly unexpected failure degrades to
    "no writer" rather than aborting a real command -- observability must never block a sync.

    Returns (writer_or_None, handoff_rejected_exit_or_None). `handoff_rejected_exit_or_None` is
    non-None ONLY for a corrupt/spoofed inherited lease (§5) -- the caller must exit with it
    WITHOUT running the command; that exit code is the ONLY signal that authorizes a watching
    Electron to finalize `failed`. A benign admission-refusal or write failure leaves the writer
    merely inactive (every method on it a safe no-op) and is not reported as a rejection.
    """
    try:
        from repo_radar.activity import ActivityWriter, HANDOFF_REJECTED_EXIT, ids
        from repo_radar.config import load_config
        from repo_radar.receipts import resolve_channel, resolve_trigger

        home = os.environ.get('HOME')
        aid = os.environ.get('REPO_RADAR_ACTIVITY_ID')
        token = os.environ.get('REPO_RADAR_ACTIVITY_OWNER_TOKEN')
        fd = os.environ.get('REPO_RADAR_ACTIVITY_LOCK_FD')

        kwargs = dict(kind='sync', channel=resolve_channel(), trigger=resolve_trigger(default='cli'),
                      producer='python', configured_secrets=_secret_values(load_config()))
        # Presence/format check mirrors bootstrap.py's own handoff validation exactly (finding:
        # mirror bootstrap/finalize construction) -- an absent or malformed env is treated as "no
        # handoff" (mint fresh) rather than risking passing a garbage fd through to adopt().
        if aid and token and fd and fd.isdigit() and ids.valid_activity_id(aid):
            kwargs.update(inherited_id=aid, inherited_fd=int(fd), owner_token=token)

        writer = ActivityWriter(home, **kwargs)
    except Exception as e:
        print(f"repo-radar: activity: establish failed: {e}", file=sys.stderr)
        return None, None

    if writer._handoff_rejected:
        print("repo-radar: activity: handoff rejected", file=sys.stderr)
        return writer, HANDOFF_REJECTED_EXIT
    writer.start()
    return writer, None


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

    # Establish/adopt the activity identity + lease + `start` BEFORE dependency checking, so a
    # dependency failure below becomes a durable `blocked` incident rather than a lost error.
    # Additive + best-effort: this can only ever STOP a real command via the exit-66
    # handoff-rejected signal immediately below.
    #
    # `sync` ONLY -- not `configure`/`analyze`. Those two modes have no `.terminal()` call on
    # their success path (no follow-up task wires one, unlike `sync` -> Task 2.6), so an
    # established-but-never-terminaled activity would self-heal via reconciliation into a
    # phantom `interrupted` incident for a run that actually succeeded -- the exact failure class
    # already fixed one task earlier at the shell-dispatcher layer (Ruling 13 / Task 2.4).
    # configure/analyze can re-join as activity producers once real terminal-on-success/failure
    # wiring exists for them; an un-terminable `start` is worse than no record.
    activity_writer = None
    if args.command == 'sync':
        activity_writer, handoff_rejected_exit = _establish_activity()
        if handoff_rejected_exit is not None:
            # A corrupt/spoofed inherited lease (§5) -- do NOT run the command. This exit code is
            # the ONLY signal that authorizes a watching Electron to finalize `failed`.
            return handoff_rejected_exit
        args._activity_writer = activity_writer   # threaded through by sync_mode (Task 2.6)

    # Check full dependencies for other commands
    from repo_radar.dependencies import check_dependencies
    if not check_dependencies():
        if activity_writer is not None:
            activity_writer.terminal('blocked', reason='dependencies')
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


if __name__ == '__main__':
    # Makes `python -m repo_radar.cli ...` directly runnable (used by the activity tests to spawn
    # a fresh child interpreter with a controlled HOME/env). The packaged `repo-radar` console
    # script (repo_radar.cli:main, see pyproject.toml) and `python -m repo_radar` (__main__.py)
    # both already call main() themselves; this guard only fires when cli.py itself is the
    # invoked module and is otherwise inert.
    sys.exit(main())
