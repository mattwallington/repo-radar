"""Dependency checking for required packages."""

import os

from repo_radar.constants import GREEN, RED, YELLOW, RESET


def check_dependencies():
    """Check for required dependencies."""
    # Test-only hook: lets a test force this gate to fail in a CHILD process (subprocess), so it
    # can prove what happens on a real dependency failure (e.g. that it becomes a durable
    # `blocked` activity) without needing to actually uninstall a package.
    if os.environ.get("REPO_RADAR_FORCE_DEPS_FAIL"):
        print(f"{YELLOW}Missing required packages (forced via REPO_RADAR_FORCE_DEPS_FAIL):{RESET}")
        return False

    required = {
        "litellm": "litellm",
        "requests": "requests",
        "inquirer": "inquirer",
        "rich": "rich"
    }

    missing = []
    for module, package in required.items():
        try:
            __import__(module)
        except ImportError:
            missing.append(package)

    if missing:
        print(f"{YELLOW}Missing required packages:{RESET}")
        for package in missing:
            print(f"  - {package}")
        print(f"\nInstall with: pip install {' '.join(missing)}")
        return False

    return True
