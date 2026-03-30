"""Dependency checking for required packages."""

from repo_radar.constants import GREEN, RED, YELLOW, RESET


def check_dependencies():
    """Check for required dependencies."""
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
