"""Configuration loading/saving and path constants."""

import json
import hashlib
from pathlib import Path
from repo_radar.constants import RED, YELLOW, RESET

_DEFAULT_PRISTINE_DIR = Path.home() / "repos-pristine"
CONFIG_DIR = Path.home() / ".config" / "repo-radar"
OLD_CONFIG_DIR = Path.home() / ".config" / "sync-pristine-repos"
CONFIG_FILE = CONFIG_DIR / "config.json"

def _get_pristine_dir():
    """Get the pristine repos directory, checking config for override."""
    try:
        if CONFIG_FILE.exists():
            with open(CONFIG_FILE, 'r') as f:
                config = json.load(f)
                if 'repos_dir' in config:
                    return Path(config['repos_dir']).expanduser()
        # Check old config location
        old_config = OLD_CONFIG_DIR / "config.json"
        if old_config.exists():
            with open(old_config, 'r') as f:
                config = json.load(f)
                if 'repos_dir' in config:
                    return Path(config['repos_dir']).expanduser()
    except Exception:
        pass
    return _DEFAULT_PRISTINE_DIR

PRISTINE_DIR = _get_pristine_dir()
CACHE_INDEX_FILE = PRISTINE_DIR / ".cache-index.json"
INDEX_FILE = PRISTINE_DIR / "INDEX.md"


def get_cache_name(clone_url, repo_name):
    """Generate cache directory name from clone URL and repo name."""
    hash_obj = hashlib.sha256(clone_url.encode())
    hash_suffix = hash_obj.hexdigest()[:7]
    return f"{repo_name}-{hash_suffix}"


def load_config():
    """Load configuration from config file."""
    if not CONFIG_FILE.exists():
        return None

    try:
        with open(CONFIG_FILE, 'r') as f:
            return json.load(f)
    except Exception as e:
        print(f"{RED}Error loading config: {e}{RESET}")
        return None


def save_config(config):
    """Save configuration to config file."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)

    try:
        with open(CONFIG_FILE, 'w') as f:
            json.dump(config, f, indent=2)
        return True
    except Exception as e:
        print(f"{RED}Error saving config: {e}{RESET}")
        return False


def load_cache_index():
    """Load cache index from file."""
    if not CACHE_INDEX_FILE.exists():
        return {}

    try:
        with open(CACHE_INDEX_FILE, 'r') as f:
            return json.load(f)
    except Exception as e:
        print(f"{YELLOW}Warning: Error loading cache index: {e}{RESET}")
        return {}


def save_cache_index(index):
    """Save cache index to file."""
    PRISTINE_DIR.mkdir(parents=True, exist_ok=True)

    try:
        with open(CACHE_INDEX_FILE, 'w') as f:
            json.dump(index, f, indent=2)
        return True
    except Exception as e:
        print(f"{RED}Error saving cache index: {e}{RESET}")
        return False
