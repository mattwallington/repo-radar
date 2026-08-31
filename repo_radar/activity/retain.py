"""Retention entrypoint: `python -m repo_radar.activity.retain`. Applies the §7 age/newest-50
retention matrix (Python-owned, descriptor-relative deletion — Node never unlinks)."""
import sys
from pathlib import Path
from repo_radar.activity import quota

def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    home = Path.home()
    pruned = quota.retain(home)
    print(len(pruned))
    return 0

if __name__ == "__main__":
    sys.exit(main())
