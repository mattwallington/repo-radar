"""UI helpers: help text, formatting, and status updates."""

import os
import json

from repo_radar import VERSION, SCRIPT_NAME, SCRIPT_DESCRIPTION
from repo_radar.config import load_config
from repo_radar.constants import *


def print_help():
    """Print help information."""
    print(f"{BOLD}{SCRIPT_NAME}{RESET} v{VERSION} - {SCRIPT_DESCRIPTION}")
    print()
    print(f"Usage: {SCRIPT_NAME} <command> [options]")
    print()
    print("Commands:")
    print("  configure          Run configuration wizard (GitHub API discovery and selection)")
    print("  sync               Sync all configured repos (clone new, update existing, generate metadata)")
    print("  analyze            Analysis mode only (report status, no changes)")
    print("  clean              Remove cached repositories and/or metadata")
    print("  help               Show this help message")
    print("  get-description    Output JSON format description")
    print()
    print("Flags (optional modifiers):")
    print("  --dry-run, -n          Show what would be done without executing")
    print("  --force, -f            Skip confirmation prompts [clean only]")
    print("  --metadata-only        Only affect metadata files [clean only]")
    print("  --repos-only           Only affect repository directories [clean only]")
    print("  --regenerate-metadata  Force regeneration of all metadata [sync only]")
    print("  --skip-metadata        Skip metadata generation [sync only]")
    print()
    print("Environment Variables:")
    print("  GITHUB_TOKEN       GitHub Personal Access Token (required for configuration)")
    print("  ANTHROPIC_API_KEY  For metadata generation with Claude models (default)")
    print("  GEMINI_API_KEY     For metadata generation with Gemini models")
    print("  OPENAI_API_KEY     For metadata generation with OpenAI/Codex models")
    print(f"  AI_MODEL           Override AI model (default: claude-sonnet-4-6-1m)")
    print()
    print("Examples:")
    print(f"  {SCRIPT_NAME} configure")
    print(f"  {SCRIPT_NAME} sync")
    print(f"  {SCRIPT_NAME} analyze")
    print(f"  {SCRIPT_NAME} sync --dry-run")
    print(f"  {SCRIPT_NAME} sync --skip-metadata")
    print(f"  {SCRIPT_NAME} clean")
    print(f"  {SCRIPT_NAME} clean --force --metadata-only")


def get_description():
    """Print script description in JSON format."""
    description = {
        "title": SCRIPT_NAME,
        "description": SCRIPT_DESCRIPTION
    }
    print(json.dumps(description))


def get_short_id(full_name):
    """Generate a short ID and color for logging from repo full name."""
    # Get just the repo name (after the /)
    repo_name = full_name.split('/')[-1]

    # Remove common org prefixes to make display IDs shorter
    # Configurable via "strip_prefixes" in config.json
    prefixes_to_remove = []
    try:
        config = load_config()
        if config and 'strip_prefixes' in config:
            prefixes_to_remove = config['strip_prefixes']
    except Exception:
        pass
    for prefix in prefixes_to_remove:
        if repo_name.startswith(prefix):
            repo_name = repo_name[len(prefix):]
            break

    # Truncate if still too long
    if len(repo_name) > 15:
        repo_name = repo_name[:15]

    # Assign color based on hash of full name (consistent color per repo)
    color_index = hash(full_name) % len(REPO_COLORS)
    color = REPO_COLORS[color_index]

    return repo_name, color


def format_id(short_id, color):
    """Format a colored ID tag."""
    return f"{color}[{short_id}]{RESET}"


def format_size(bytes_size):
    """Format bytes into human-readable string."""
    for unit in ['B', 'KB', 'MB', 'GB']:
        if bytes_size < 1024.0:
            return f"{bytes_size:.2f} {unit}"
        bytes_size /= 1024.0
    return f"{bytes_size:.2f} TB"


def send_status_update(status_type, data=None, status_server_enabled=False):
    """Send status update to HTTP server if enabled."""
    if not status_server_enabled:
        return

    try:
        import requests
        payload = {'type': status_type}
        if data:
            payload.update(data)

        import os
        port = os.environ.get('REPO_RADAR_STATUS_PORT', '3847')
        requests.post(f'http://localhost:{port}/status', json=payload, timeout=1.0)
    except ImportError:
        # requests not available, skip
        pass
    except Exception:
        # Silently fail if server not available
        pass
