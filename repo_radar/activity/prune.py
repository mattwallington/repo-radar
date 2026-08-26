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
    monkeypatches `quota.RESERVE` still gets the current value). Returns total bytes freed.

    Ruling 61 (Codex R7-2, BLOCKER): pre-fix, the loop condition read `quota._charge(home)` fresh
    each iteration, but under ledger uncertainty `_charge` is a CONSTANT sentinel (an unlistable
    ledger flattens the charge to `CEILING`) -- so the loop never terminates via headroom and
    instead keeps calling `_prune_locked` until it runs out of candidates, destructively deleting
    EVERY prunable activity even though the "0 live entries" ledger view is entirely unproven
    (Codex repro: three settled routine activities + an unlistable ledger -> all three deleted,
    charge still pinned at the ceiling). Fixed: take ONE unified `_accounting_snapshot` right
    after reconcile; if it's uncertain/corrupt, refuse outright (return 0, delete nothing). Inside
    the loop, take a FRESH snapshot after each `_prune_locked` call and stop the instant it goes
    uncertain/corrupt too -- never loop on a sentinel. `_prune_locked` itself also independently
    refuses (returns 0) under ledger uncertainty (Ruling 61), so this is defense in depth, not the
    only guard."""
    if requested is None:
        requested = quota.RESERVE
    ctx = quota._quota_lock(home)
    try:
        quota._reconcile_all_locked(home)          # reclaim crashed reservations before charging
        snap = quota._accounting_snapshot(home)
        if snap.uncertain or snap.corrupt:
            return 0                                # never destructively prune under uncertainty
        freed = 0
        while snap.charge + requested > quota.CEILING:
            need = (snap.charge + requested) - quota.CEILING
            chunk = quota._prune_locked(home, need)
            if chunk <= 0:
                break                                # nothing prunable left -> stop (best-effort)
            freed += chunk
            snap = quota._accounting_snapshot(home)   # FRESH snapshot each iteration, never stale
            if snap.uncertain or snap.corrupt:
                break                                # accounting went uncertain mid-loop -> stop
        return freed
    finally:
        quota._unlock(ctx)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    requested = int(argv[0]) if argv else None
    home = Path.home()
    freed = prune_to_ceiling(home, requested)
    print(freed)
    return 0


if __name__ == "__main__":
    sys.exit(main())
