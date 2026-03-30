"""Entry point for python -m repo_radar."""

import sys
from repo_radar.cli import main

if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nInterrupted by user")
        sys.exit(130)
