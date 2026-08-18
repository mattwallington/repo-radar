"""Admission-prune entrypoint: `python -m repo_radar.activity.prune`.

The ONLY destructive deletion path Node's Phase-2 admission invokes when a fresh
`admit` would still exceed the ceiling after its own reconcile+prune-first attempt
(descriptor-relative, race-free — Round-6 #3/#5). Reconciles once under a single
held `quota.lock` (reclaiming any crashed run's stale reservation before charge is
computed), then repeatedly prunes settled items until `charge <= CEILING` or a
pass frees nothing more. Prints the total freed byte count.
"""
import sys
from pathlib import Path

from repo_radar.activity import quota


def prune_to_ceiling(home):
    """Under a SINGLE held `quota.lock`: reconcile, then repeatedly `_prune_locked`
    until `charge <= CEILING` or nothing is prunable. Returns total bytes freed."""
    fd = quota._quota_lock(home)
    try:
        quota._reconcile_all_locked(home)          # reclaim crashed reservations before charging
        freed = 0
        while quota._charge(home) > quota.CEILING:
            chunk = quota._prune_locked(home, quota._charge(home) - quota.CEILING)
            if chunk <= 0:
                break                                # nothing prunable left -> stop (best-effort)
            freed += chunk
        return freed
    finally:
        quota._unlock(fd)


def main(argv=None):
    home = Path.home()
    freed = prune_to_ceiling(home)
    print(freed)
    return 0


if __name__ == "__main__":
    sys.exit(main())
