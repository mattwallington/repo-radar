# Refactor repo-radar into a Python Package

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Break the monolithic 2,900-line `repo-radar` script into a well-structured Python package with clear module boundaries.

**Architecture:** Extract the script into a `repo_radar/` package with modules split by responsibility: config, git ops, LLM integration, metadata parsing, CLI modes, and UI helpers. The top-level `repo-radar` script becomes a thin entry point. No new features — pure structural refactor with identical behavior.

**Tech Stack:** Python 3.8+, litellm, rich, inquirer, requests

---

## File Structure

```
repo-radar/
├── repo-radar                     # Thin entry point (stays executable)
├── repo_radar/
│   ├── __init__.py                # VERSION, SCRIPT_NAME, SCRIPT_DESCRIPTION
│   ├── __main__.py                # python -m repo_radar entry point
│   ├── cli.py                     # main(), argparse, mode dispatch
│   ├── config.py                  # Paths, load/save config, cache index
│   ├── constants.py               # Colors, REPO_COLORS, PROGRESS_COLORS
│   ├── dependencies.py            # check_dependencies()
│   ├── git.py                     # run_git_command, determine_preferred_branch, get_repo_status
│   ├── files.py                   # should_include_file, collect_repo_files
│   ├── llm.py                     # Model config, chunking, token counting, rate limiting, API calls
│   ├── metadata.py                # parse_llm_response, extract_between, regenerate_index
│   ├── ui.py                      # print_help, format_id, get_short_id, format_size, send_status_update
│   ├── modes/
│   │   ├── __init__.py
│   │   ├── configure.py           # configure_mode, fetch_user_repos, select_repositories_interactive
│   │   ├── sync.py                # sync_mode (with process_repo + generate_metadata_task)
│   │   ├── analyze.py             # analyze_mode
│   │   └── clean.py               # clean_mode, get_directory_size
│   └── tests/
│       ├── __init__.py
│       ├── test_config.py
│       ├── test_files.py
│       ├── test_llm.py
│       ├── test_metadata.py
│       └── test_ui.py
├── pyproject.toml                 # Package config, pytest, dependencies
├── VERSION
├── requirements.txt
├── release.sh
└── menubar/
```

**Key design decisions:**
- `sync_mode` stays as one file since `process_repo` and `generate_metadata_task` are tightly coupled to it
- `llm.py` owns all model config (KNOWN_LIMITS, fallback chain, RateLimitTracker) AND the LLM call functions. Note: `analyze_repo_chunk` and `combine_chunk_analyses` exist in `llm.py` but are currently unused — `sync_mode` has its own inline LLM call logic with enhanced retry/progress. Keep them in `llm.py` for now with a `# TODO: refactor sync_mode to use these` comment, as a future cleanup.
- `metadata.py` owns response parsing and index generation
- `constants.py` is just color codes and display arrays — no logic
- Tests focus on pure functions that don't need LLM calls or git repos

---

### Task 1: Create package skeleton and pyproject.toml

**Files:**
- Create: `repo_radar/__init__.py`
- Create: `repo_radar/__main__.py`
- Create: `pyproject.toml`
- Modify: `repo-radar` (replace contents with thin wrapper)

- [ ] **Step 1: Create `repo_radar/__init__.py`**

```python
"""Repo Radar - Pristine repository mirrors with AI-powered metadata."""

import json
from pathlib import Path


def _get_version():
    """Read version from VERSION file."""
    try:
        version_file = Path(__file__).parent.parent / 'VERSION'
        if version_file.exists():
            return version_file.read_text().strip()
        # Check in app bundle resources
        version_file = Path(__file__).parent.parent.parent / 'VERSION'
        if version_file.exists():
            return version_file.read_text().strip()
    except Exception:
        pass
    return '1.0.0'


VERSION = _get_version()
SCRIPT_NAME = 'repo-radar'
SCRIPT_DESCRIPTION = "Maintain pristine mirrors of GitHub repositories with LLM-powered metadata for efficient context discovery"
```

- [ ] **Step 2: Create `repo_radar/__main__.py`** (stub — updated in Task 9 when cli.py exists)

```python
"""Entry point for python -m repo_radar. Wired up in Task 9."""
```

- [ ] **Step 3: Create `pyproject.toml`**

```toml
[build-system]
requires = ["setuptools>=68.0"]
build-backend = "setuptools.backends._legacy:_Backend"

[project]
name = "repo-radar"
dynamic = ["version"]
description = "Pristine repository mirrors with AI-powered metadata"
readme = "README.md"
license = {text = "MIT"}
requires-python = ">=3.8"
dependencies = [
    "litellm==1.82.6",
    "requests>=2.32.0",
    "inquirer>=3.4.0",
    "rich>=14.2.0",
]

[project.scripts]
repo-radar = "repo_radar.cli:main"

[tool.setuptools.dynamic]
version = {file = "VERSION"}

[tool.pytest.ini_options]
testpaths = ["repo_radar/tests"]
```

- [ ] **Step 4: Commit**

```bash
git add repo_radar/__init__.py repo_radar/__main__.py pyproject.toml
git commit -m "refactor: create repo_radar package skeleton"
```

---

### Task 2: Extract constants.py

**Files:**
- Create: `repo_radar/constants.py`
- Source lines: 62-107 of `repo-radar`

- [ ] **Step 1: Create `repo_radar/constants.py`**

Extract all color codes (GREEN, BLUE, CYAN, YELLOW, RED, BOLD, RESET), REPO_COLORS array, and PROGRESS_COLORS array. These are pure constants with zero dependencies.

```python
"""Terminal color codes and display constants."""

# ANSI color codes
GREEN = "\033[92m"
BLUE = "\033[94m"
CYAN = "\033[96m"
YELLOW = "\033[93m"
RED = "\033[91m"
BOLD = "\033[1m"
RESET = "\033[0m"

# Colors for repo display IDs (10 colors)
REPO_COLORS = [
    # ... copy all 10 entries from lines 71-82
]

# Colors for progress bars (20 colors)
PROGRESS_COLORS = [
    # ... copy all 20 entries from lines 86-107
]
```

- [ ] **Step 2: Write test**

Create `repo_radar/tests/__init__.py` (empty) and `repo_radar/tests/test_constants.py`:

```python
from repo_radar.constants import GREEN, RESET, REPO_COLORS, PROGRESS_COLORS


def test_color_codes_are_ansi():
    assert GREEN.startswith("\033[")
    assert RESET == "\033[0m"


def test_repo_colors_count():
    assert len(REPO_COLORS) == 10


def test_progress_colors_count():
    assert len(PROGRESS_COLORS) == 20
```

- [ ] **Step 3: Run test**

```bash
python -m pytest repo_radar/tests/test_constants.py -v
```

- [ ] **Step 4: Commit**

```bash
git add repo_radar/constants.py repo_radar/tests/
git commit -m "refactor: extract constants module"
```

---

### Task 3: Extract config.py

**Files:**
- Create: `repo_radar/config.py`
- Create: `repo_radar/tests/test_config.py`
- Source lines: 33-59, 944-993 of `repo-radar`

- [ ] **Step 1: Create `repo_radar/config.py`**

Extract: path constants (_DEFAULT_PRISTINE_DIR, CONFIG_DIR, OLD_CONFIG_DIR, CONFIG_FILE), `_get_pristine_dir()`, PRISTINE_DIR, CACHE_INDEX_FILE, INDEX_FILE, `load_config()`, `save_config()`, `load_cache_index()`, `save_cache_index()`, `get_cache_name()`.

```python
"""Configuration and path management."""

import json
import hashlib
from pathlib import Path
from repo_radar.constants import RED, RESET

_DEFAULT_PRISTINE_DIR = Path.home() / "repos-pristine"
CONFIG_DIR = Path.home() / ".config" / "repo-radar"
OLD_CONFIG_DIR = Path.home() / ".config" / "sync-pristine-repos"
CONFIG_FILE = CONFIG_DIR / "config.json"


def _get_pristine_dir():
    # ... exact copy from lines 38-55


PRISTINE_DIR = _get_pristine_dir()
CACHE_INDEX_FILE = PRISTINE_DIR / ".cache-index.json"
INDEX_FILE = PRISTINE_DIR / "INDEX.md"


def load_config():
    # ... exact copy from lines 944-954


def save_config(config):
    # ... exact copy from lines 957-967


def load_cache_index():
    # ... exact copy from lines 970-980


def save_cache_index(index):
    # ... exact copy from lines 983-993


def get_cache_name(clone_url, repo_name):
    # ... exact copy from lines 391-395
```

- [ ] **Step 2: Write test**

```python
import json
import tempfile
from pathlib import Path
from repo_radar.config import get_cache_name, load_config, save_config


def test_get_cache_name_is_deterministic():
    a = get_cache_name("https://github.com/org/repo.git", "repo")
    b = get_cache_name("https://github.com/org/repo.git", "repo")
    assert a == b


def test_get_cache_name_includes_repo_name():
    name = get_cache_name("https://github.com/org/my-repo.git", "my-repo")
    assert name.startswith("my-repo-")
    assert len(name) == len("my-repo-") + 7  # 7-char hash


def test_get_cache_name_differs_by_url():
    a = get_cache_name("https://github.com/org1/repo.git", "repo")
    b = get_cache_name("https://github.com/org2/repo.git", "repo")
    assert a != b
```

- [ ] **Step 3: Run test**

```bash
python -m pytest repo_radar/tests/test_config.py -v
```

- [ ] **Step 4: Commit**

```bash
git add repo_radar/config.py repo_radar/tests/test_config.py
git commit -m "refactor: extract config module"
```

---

### Task 4: Extract git.py

**Files:**
- Create: `repo_radar/git.py`
- Create: `repo_radar/tests/test_git.py`
- Source lines: 929-941, 1282-1358, 1664-1683 of `repo-radar`

- [ ] **Step 1: Create `repo_radar/git.py`**

Extract: `run_git_command()`, `get_repo_status()`, `determine_preferred_branch()`.

Imports needed: `subprocess`, `from repo_radar.config import load_config, get_cache_name, PRISTINE_DIR`, `from repo_radar.constants import *`.

Note: `get_repo_status` calls `get_cache_name` (line 1332), so it must be imported from config.

- [ ] **Step 2: Write test**

```python
from repo_radar.git import run_git_command, determine_preferred_branch


def test_run_git_command_returns_result():
    result = run_git_command(["git", "--version"])
    assert result.returncode == 0
    assert "git version" in result.stdout


def test_run_git_command_bad_command():
    result = run_git_command(["git", "not-a-real-command"], check=False)
    assert result.returncode != 0
```

- [ ] **Step 3: Run test**

```bash
python -m pytest repo_radar/tests/test_git.py -v
```

- [ ] **Step 4: Commit**

```bash
git add repo_radar/git.py repo_radar/tests/test_git.py
git commit -m "refactor: extract git operations module"
```

---

### Task 5: Extract files.py

**Files:**
- Create: `repo_radar/files.py`
- Create: `repo_radar/tests/test_files.py`
- Source lines: 433-520 of `repo-radar`

- [ ] **Step 1: Create `repo_radar/files.py`**

Extract: `should_include_file()`, `collect_repo_files()`.

```python
"""File collection and filtering for repository analysis."""

import os
from repo_radar.git import run_git_command


def should_include_file(file_path):
    # ... exact copy from lines 433-483


def collect_repo_files(repo_path):
    # ... exact copy from lines 486-520
```

- [ ] **Step 2: Write test**

```python
from repo_radar.files import should_include_file


def test_includes_python_files():
    assert should_include_file("src/main.py") is True


def test_includes_javascript_files():
    assert should_include_file("src/app.js") is True


def test_excludes_binary_files():
    assert should_include_file("image.png") is False
    assert should_include_file("archive.zip") is False


def test_excludes_lock_files():
    assert should_include_file("package-lock.json") is False
    assert should_include_file("yarn.lock") is False


def test_excludes_node_modules():
    assert should_include_file("node_modules/foo/index.js") is False


def test_includes_config_files():
    assert should_include_file("Dockerfile") is True
    assert should_include_file("Makefile") is True
    assert should_include_file("docker-compose.yml") is True
```

- [ ] **Step 3: Run test**

```bash
python -m pytest repo_radar/tests/test_files.py -v
```

- [ ] **Step 4: Commit**

```bash
git add repo_radar/files.py repo_radar/tests/test_files.py
git commit -m "refactor: extract file collection module"
```

---

### Task 6: Extract llm.py

**Files:**
- Create: `repo_radar/llm.py`
- Source lines: 136-338, 576-817 of `repo-radar`

- [ ] **Step 1: Create `repo_radar/llm.py`**

Extract: `get_ai_model()`, `GEMINI_FALLBACK_CHAIN`, `get_fallback_model()`, `get_model_context_window()` (with KNOWN_LIMITS), `get_chunking_threshold()`, `count_tokens_accurate()`, `RateLimitTracker` class, `rate_limit_tracker` global, `chunk_repo_files()`, `analyze_repo_chunk()`, `combine_chunk_analyses()`.

This is the largest extraction. All model configuration and LLM API interaction lives here.

- [ ] **Step 2: Write test**

```python
from repo_radar.llm import (
    get_model_context_window,
    get_chunking_threshold,
    get_fallback_model,
    chunk_repo_files,
    RateLimitTracker,
)


def test_known_model_context_window():
    assert get_model_context_window("claude-sonnet-4-6-1m") == 1_000_000
    assert get_model_context_window("gpt-4o") == 128_000


def test_unknown_model_gets_default():
    assert get_model_context_window("unknown-model") == 128_000


def test_chunking_threshold_is_75_percent():
    window = get_model_context_window("gpt-4o")
    threshold = get_chunking_threshold("gpt-4o")
    assert threshold == int(window * 0.75)


def test_fallback_model_chain():
    first = "gemini/gemini-3-pro-preview"
    second = get_fallback_model(first)
    assert second == "gemini/gemini-3-flash-preview"


def test_fallback_returns_none_at_end():
    last = "gemini/gemini-2.0-flash-001"
    assert get_fallback_model(last) is None


def test_fallback_unknown_returns_first():
    result = get_fallback_model("unknown-model")
    assert result == "gemini/gemini-3-pro-preview"


def test_chunk_repo_files_small_repo():
    files = [{"path": "a.py", "content": "x" * 100, "size": 100}]
    chunks = chunk_repo_files(files, "gpt-4o")
    assert len(chunks) == 1


def test_rate_limit_tracker_initial_state():
    tracker = RateLimitTracker()
    assert tracker.should_wait() is False
    assert tracker.get_wait_time() == 0
    assert "Unknown" in tracker.get_status_string()
```

- [ ] **Step 3: Run test**

```bash
python -m pytest repo_radar/tests/test_llm.py -v
```

- [ ] **Step 4: Commit**

```bash
git add repo_radar/llm.py repo_radar/tests/test_llm.py
git commit -m "refactor: extract LLM integration module"
```

---

### Task 7: Extract metadata.py and ui.py

**Files:**
- Create: `repo_radar/metadata.py`
- Create: `repo_radar/ui.py`
- Create: `repo_radar/tests/test_metadata.py`
- Create: `repo_radar/tests/test_ui.py`

- [ ] **Step 1: Create `repo_radar/metadata.py`**

Extract: `extract_between()`, `parse_llm_response()`, `regenerate_index()`.

The prompt templates (the large f-strings in `analyze_repo_chunk` and `combine_chunk_analyses`) stay in `llm.py` since they're arguments to the LLM calls there.

- [ ] **Step 2: Create `repo_radar/ui.py`**

Extract: `print_help()`, `get_description()`, `get_short_id()`, `format_id()`, `format_size()`, `send_status_update()`.

- [ ] **Step 3: Write tests**

`test_metadata.py`:
```python
from repo_radar.metadata import extract_between, parse_llm_response


def test_extract_between():
    text = "before QUICK_REFERENCE_START\ndata here\nQUICK_REFERENCE_END after"
    result = extract_between(text, "QUICK_REFERENCE_START", "QUICK_REFERENCE_END")
    assert result.strip() == "data here"


def test_extract_between_missing_markers():
    result = extract_between("no markers here", "START", "END")
    assert result == ""


def test_parse_llm_response_extracts_sections():
    response = """Some preamble

QUICK_REFERENCE_START
Type: API Service
Language: Python
QUICK_REFERENCE_END

ONE_LINE_SUMMARY_START
A Python API service.
ONE_LINE_SUMMARY_END

RELATED_REPOS_START
org/other-repo, org/another
RELATED_REPOS_END

## Overview
Full analysis here.
"""
    result = parse_llm_response(response)
    assert result["quick_ref"]["type"] == "API Service"
    assert result["quick_ref"]["language"] == "Python"
    assert result["brief"] == "A Python API service."
    assert "org/other-repo" in result["related_repos"]
    assert "Full analysis here" in result["analysis"]
```

`test_ui.py`:
```python
from repo_radar.ui import format_size, get_short_id


def test_format_size_bytes():
    assert format_size(500) == "500.00 B"


def test_format_size_kb():
    assert format_size(1536) == "1.50 KB"


def test_format_size_mb():
    assert format_size(1_500_000) == "1.43 MB"


def test_get_short_id_strips_org():
    # With no config strip_prefixes, should just truncate
    short_id, color = get_short_id("org/my-cool-repo")
    assert short_id == "my-cool-repo"
```

- [ ] **Step 4: Run tests**

```bash
python -m pytest repo_radar/tests/test_metadata.py repo_radar/tests/test_ui.py -v
```

- [ ] **Step 5: Commit**

```bash
git add repo_radar/metadata.py repo_radar/ui.py repo_radar/tests/test_metadata.py repo_radar/tests/test_ui.py
git commit -m "refactor: extract metadata and UI modules"
```

---

### Task 8: Extract mode modules

**Files:**
- Create: `repo_radar/modes/__init__.py`
- Create: `repo_radar/modes/configure.py`
- Create: `repo_radar/modes/sync.py`
- Create: `repo_radar/modes/analyze.py`
- Create: `repo_radar/modes/clean.py`

- [ ] **Step 1: Create `repo_radar/modes/__init__.py`** (empty)

- [ ] **Step 2: Create `repo_radar/modes/configure.py`**

Extract: `fetch_user_repos()`, `select_repositories_interactive()`, `configure_mode()`.

Imports: `from repo_radar.config import ...`, `from repo_radar.constants import ...`, `from repo_radar.ui import ...`.

**Important:** `configure_mode` optionally calls `sync_mode` (line 1274). Use a lazy import inside the function body to avoid circular imports:
```python
# Inside configure_mode, where it calls sync:
from repo_radar.modes.sync import sync_mode
sync_mode(args)
```

- [ ] **Step 3: Create `repo_radar/modes/sync.py`**

Extract: `sync_mode()` including its nested `process_repo()` and `generate_metadata_task()`.

This is the largest mode (~1,170 lines). It stays as one file because `process_repo` and `generate_metadata_task` are tightly coupled to the sync orchestration (they share `args`, progress bars, threading locks, etc).

Imports: `from repo_radar.config import ...`, `from repo_radar.constants import ...`, `from repo_radar.git import ...`, `from repo_radar.files import ...`, `from repo_radar.llm import ...`, `from repo_radar.metadata import ...`, `from repo_radar.ui import ...`.

- [ ] **Step 4: Create `repo_radar/modes/analyze.py`**

Extract: `analyze_mode()`.

- [ ] **Step 5: Create `repo_radar/modes/clean.py`**

Extract: `clean_mode()`, `get_directory_size()`.

- [ ] **Step 6: Write import smoke tests**

Create `repo_radar/tests/test_modes.py`:

```python
def test_import_configure():
    from repo_radar.modes.configure import configure_mode
    assert callable(configure_mode)


def test_import_sync():
    from repo_radar.modes.sync import sync_mode
    assert callable(sync_mode)


def test_import_analyze():
    from repo_radar.modes.analyze import analyze_mode
    assert callable(analyze_mode)


def test_import_clean():
    from repo_radar.modes.clean import clean_mode
    assert callable(clean_mode)
```

- [ ] **Step 7: Run tests**

```bash
python -m pytest repo_radar/tests/test_modes.py -v
```

- [ ] **Step 8: Commit**

```bash
git add repo_radar/modes/ repo_radar/tests/test_modes.py
git commit -m "refactor: extract CLI mode modules"
```

---

### Task 9: Create cli.py, dependencies.py, and wire up entry point

**Files:**
- Create: `repo_radar/cli.py`
- Create: `repo_radar/dependencies.py`
- Modify: `repo-radar` (thin wrapper)
- Modify: `repo_radar/__main__.py`

- [ ] **Step 1: Create `repo_radar/dependencies.py`**

Extract `check_dependencies()` from lines 110-133 of the monolith:

```python
"""Dependency checking for required packages."""

from repo_radar.constants import GREEN, RED, YELLOW, RESET


def check_dependencies():
    # ... exact copy from lines 110-133
```

- [ ] **Step 2: Create `repo_radar/cli.py`**

Extract `main()` from the monolith — argparse setup, dependency check routing, mode dispatch.

**Important:** The `clean` command has special dependency handling — it only needs `inquirer` (not the full `check_dependencies` which also checks litellm, requests, rich). Preserve this behavior.

```python
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
```

- [ ] **Step 3: Update `repo_radar/__main__.py`**

```python
"""Entry point for python -m repo_radar."""

import sys
from repo_radar.cli import main

if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nInterrupted by user")
        sys.exit(130)
```

- [ ] **Step 4: Replace `repo-radar` script contents**

```python
#!/usr/bin/env python3
"""Repo Radar - Pristine repository mirrors with AI-powered metadata."""

import sys
from repo_radar.cli import main

if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nInterrupted by user")
        sys.exit(130)
    except Exception as e:
        print(f"\033[91mUnexpected error: {e}\033[0m")
        sys.exit(1)
```

- [ ] **Step 5: Run all tests**

```bash
python -m pytest repo_radar/tests/ -v
```

- [ ] **Step 6: Smoke test**

```bash
python repo-radar --version
python repo-radar help
python -m repo_radar --version
```

- [ ] **Step 7: Commit**

```bash
git add repo_radar/cli.py repo_radar/dependencies.py repo_radar/__main__.py repo-radar
git commit -m "refactor: wire up CLI entry point, replace monolith"
```

---

### Task 10: Delete monolith and final verification

**Files:**
- Modify: `repo-radar` (should already be thin wrapper from Task 9)
- Modify: `.gitignore` (add `__pycache__/`, `*.egg-info/`)

- [ ] **Step 1: Verify the old monolith code is fully extracted**

```bash
wc -l repo-radar  # Should be ~15 lines
wc -l repo_radar/*.py repo_radar/modes/*.py  # Should total ~2,900 lines
```

- [ ] **Step 2: Full test suite**

```bash
python -m pytest repo_radar/tests/ -v
```

- [ ] **Step 3: End-to-end smoke tests**

```bash
python repo-radar --version
python repo-radar help
python repo-radar analyze 2>&1 | head -5
```

- [ ] **Step 4: Verify menubar integration**

```bash
# The menubar spawns: python3 repo-radar sync --status-server
# Verify this still works
python repo-radar sync --dry-run 2>&1 | head -10
```

- [ ] **Step 5: Update release.sh if needed**

Check if release.sh references the old monolith in any way that needs updating.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "refactor: complete package restructure

Refactored monolithic 2,900-line script into repo_radar/ package:
- repo_radar/config.py: Path and configuration management
- repo_radar/constants.py: Terminal colors and display arrays
- repo_radar/git.py: Git operations and repo status
- repo_radar/files.py: File collection and filtering
- repo_radar/llm.py: LLM integration, model config, rate limiting
- repo_radar/metadata.py: Response parsing and index generation
- repo_radar/ui.py: Help text, formatting, status updates
- repo_radar/modes/: CLI mode implementations (configure, sync, analyze, clean)
- repo_radar/cli.py: Argument parsing and mode dispatch
- repo_radar/tests/: Unit tests for pure functions

No behavior changes. The repo-radar script is now a thin entry point."
```
