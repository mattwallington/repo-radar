"""Admission-prune entrypoint: `python -m repo_radar.activity.prune [requested_bytes]`.

The ONLY destructive deletion path Node's Phase-2 admission invokes when a fresh
`admit` would still exceed the ceiling after its own reconcile+prune-first attempt
(descriptor-relative, race-free — Round-6 #3/#5). Reconciles once under a single
held `quota.lock` (reclaiming any crashed run's stale reservation before charge is
computed), then repeatedly prunes settled items until enough headroom exists for
the REQUESTED byte count (Codex gate round 1, finding 3 — Node's normal admission
failure is `charge <= CEILING` but `charge + RESERVE > CEILING`; a loop gated only
on `charge > CEILING` never even starts in that regime) or a pass frees nothing
more. Prints the total freed byte count.
"""
import sys
from pathlib import Path

from repo_radar.activity import quota


def prune_to_ceiling(home, requested=None):
    """Under a SINGLE held `quota.lock`: reconcile, then repeatedly `_prune_locked` until
    `charge + requested <= CEILING` (finding 3) or nothing further is prunable. `requested`
    defaults to `quota.RESERVE` (read at CALL time, not bind time, so a test/caller that
    monkeypatches `quota.RESERVE` still gets the current value). Returns total bytes freed."""
    if requested is None:
        requested = quota.RESERVE
    fd = quota._quota_lock(home)
    try:
        quota._reconcile_all_locked(home)          # reclaim crashed reservations before charging
        freed = 0
        while quota._charge(home) + requested > quota.CEILING:
            need = (quota._charge(home) + requested) - quota.CEILING
            chunk = quota._prune_locked(home, need)
            if chunk <= 0:
                break                                # nothing prunable left -> stop (best-effort)
            freed += chunk
        return freed
    finally:
        quota._unlock(fd)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    requested = int(argv[0]) if argv else None
    home = Path.home()
    freed = prune_to_ceiling(home, requested)
    print(freed)
    return 0


if __name__ == "__main__":
    sys.exit(main())
