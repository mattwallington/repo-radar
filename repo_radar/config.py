"""Configuration loading/saving and path constants."""

import json
import math
import re
import os
import tempfile
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


# An exact GitHub "owner/repository" identity: no wildcards, globs or partial names.
_REPO_IDENTITY = re.compile(r'^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$')


DEFAULT_INCREMENTAL_FULL_REBUILD_DAYS = 7


def incremental_full_rebuild_days(config):
    """How many days after its last full build an opted-in repository is rebuilt in full
    (`incremental_full_rebuild_days`); 0 turns the age trigger off. Raises ValueError unless it is a
    nonnegative integer."""
    value = (config or {}).get('incremental_full_rebuild_days', DEFAULT_INCREMENTAL_FULL_REBUILD_DAYS)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError(f"incremental_full_rebuild_days must be a nonnegative whole number of days, not {value!r}")
    return value


# The Settings "Spending" section. menubar/spending-settings.js holds the same bounds for the window; Python
# enforces them on its own every sync, so a hand-edited or older config can never mean "unlimited".
INCREMENTAL_UPDATE_LIMIT_FIELD = 'incremental_update_limit_usd'
INCREMENTAL_UPDATE_LIMIT_RANGE = (1, 100)        # US dollars, at most two decimal places
INCREMENTAL_FAILURE_STOP_FIELD = 'incremental_failure_stop'
DEFAULT_INCREMENTAL_FAILURE_STOP = 2
INCREMENTAL_FAILURE_STOP_RANGE = (1, 10)         # whole numbers; 0 is invalid, not "off"


def valid_incremental_update_limit(value):
    """True for a finite JSON number of dollars within range and exactly in whole cents. Bounds come first,
    so an integer too large for a float is simply out of range."""
    low, high = INCREMENTAL_UPDATE_LIMIT_RANGE
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    if isinstance(value, float) and not math.isfinite(value):
        return False
    if not low <= value <= high:
        return False
    # Whole cents: 99.99 and 1.01 round to themselves, 12.000000001 doesn't. menubar/spending-settings.js
    # uses the same test (Number(value.toFixed(2)) === value).
    return isinstance(value, int) or round(value, 2) == value


def valid_incremental_failure_stop(value):
    """True for a whole number within range. A float like 2.0 counts, since JSON can't tell it from 2."""
    low, high = INCREMENTAL_FAILURE_STOP_RANGE
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    if isinstance(value, float) and not (math.isfinite(value) and value.is_integer()):
        return False
    return low <= value <= high


def incremental_spending_policy(config):
    """(update limit in USD, consecutive-failure stop, fields that were invalid) for this sync.

    Absent values take the defaults quietly. Invalid ones take the defaults too and are named in the last
    item so the caller can warn; their values are never echoed. Neither can become None, zero or unlimited."""
    from repo_radar.metadata_budget import INCREMENTAL_CAP_USD
    config = config if isinstance(config, dict) else {}
    invalid = []
    limit, stop = INCREMENTAL_CAP_USD, DEFAULT_INCREMENTAL_FAILURE_STOP
    if INCREMENTAL_UPDATE_LIMIT_FIELD in config:
        value = config[INCREMENTAL_UPDATE_LIMIT_FIELD]
        if valid_incremental_update_limit(value):
            limit = float(value)
        else:
            invalid.append(INCREMENTAL_UPDATE_LIMIT_FIELD)
    if INCREMENTAL_FAILURE_STOP_FIELD in config:
        value = config[INCREMENTAL_FAILURE_STOP_FIELD]
        if valid_incremental_failure_stop(value):
            stop = int(value)
        else:
            invalid.append(INCREMENTAL_FAILURE_STOP_FIELD)
    return limit, stop, tuple(invalid)


def incremental_metadata_repos(config):
    """The repositories opted in to incremental metadata (`incremental_metadata_repos`).

    Optional; absent or empty means none, and every repository keeps the full-generation path.
    Each entry must be an exact `owner/repository` identity as configured under `repositories`.
    Raises ValueError for anything else rather than guessing what a malformed value meant.
    """
    value = (config or {}).get('incremental_metadata_repos', [])
    if value is None:
        return frozenset()
    if not isinstance(value, list):
        raise ValueError("incremental_metadata_repos must be a list of owner/repository names")
    names = []
    for entry in value:
        if not isinstance(entry, str) or not _REPO_IDENTITY.match(entry) or entry.endswith(('/.', '/..')):
            raise ValueError(f"incremental_metadata_repos has an invalid entry: {entry!r} "
                             f"(use an exact owner/repository name)")
        names.append(entry)
    if len(set(names)) != len(names):
        raise ValueError("incremental_metadata_repos lists a repository more than once")
    return frozenset(names)


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
    """Save configuration to config file, owner-only.

    This file holds the GitHub token and every provider API key. A plain open('w') creates it
    with the umask applied (0644 under the default 022), and because overwriting preserves an
    existing mode, a file created permissively by any earlier version stays world-readable
    forever. So: create through a private temp file, replace atomically, and chmod explicitly —
    the chmod is what tightens configs that already exist. The Electron writer does the same.
    """
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)

    tmp = None
    try:
        fd, tmp = tempfile.mkstemp(dir=str(CONFIG_DIR), prefix='.config-', suffix='.tmp')
        with os.fdopen(fd, 'w') as f:
            json.dump(config, f, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, CONFIG_FILE)   # atomic; readers never see a partial config
        tmp = None
        os.chmod(CONFIG_FILE, 0o600)   # tightens a pre-existing 0644 file
        return True
    except Exception as e:
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass
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
