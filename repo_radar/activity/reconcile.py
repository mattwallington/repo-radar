import json, os
from repo_radar.activity import paths, records, ids
from repo_radar.activity import lease as lease_mod

RECONCILER = "reconciler"

def _cancel_requested(home, aid):
    for _name, data, _sz, _mt in paths.read_owned_segments(paths.activity_dir(home, aid)):
        for line in data.split(b"\n"):
            if not line:
                continue
            obj = records.parse_valid(line, aid)     # canonical validator (Round-4 #5)
            if obj is not None and obj["type"] == "control" and obj.get("name") == "cancel_requested":
                return True
    return False

def synthesize_terminal(home, aid, gate=None):
    """§5: for a provably-dead (lease-free) unterminated activity, acquire the lease, write a
    durable synthetic terminal (by=reconciler), and release. Returns True iff a terminal is now
    durable. Returns False (preserve) when the lease is BUSY/UNCERTAIN or the write fails.

    `gate`, when given, is a zero-arg callable RE-EVALUATED UNDER the just-acquired lease,
    immediately before any write: if it returns falsy, the lease is released and nothing is
    written (returns False). This closes the scan-to-write race for a caller (quota.py's
    `_reconcile_one_locked`) that already scanned the activity's segments BEFORE acquiring the
    lease in order to decide whether to call this function at all -- that earlier, lease-free
    scan can go stale by the time the lease is actually held here (a conforming segment could
    become unreadable, or a terminal could land, in the gap). Passing `gate` lets the caller
    re-run ITS OWN scan/certainty logic under the lease this function already holds, without
    reconcile.py importing quota.py (quota imports reconcile, never the reverse). When `gate` is
    None (all other callers), behavior is unchanged. Mirrors Node's `synthesizeTerminal`, which
    re-scans under its own lease directly since it has no separate pre-lease gating wrapper."""
    lock = paths.owner_lock_path(home, aid)
    try:
        lease = lease_mod.acquire(lock)            # None if busy; raises only on fs error
    except OSError:
        return False
    if lease is None:
        return False                               # owner alive (or uncertain) -> preserve
    try:
        if gate is not None and not gate():
            return False                           # re-evaluated view no longer supports synthesis
        outcome = "cancelled" if _cancel_requested(home, aid) else "interrupted"
        seg = paths.segment_path(home, aid, "python", ids.mint_token())
        rec = records.build("terminal", seq=0, activity_id=aid,
                            outcome=outcome, summary={}, by=RECONCILER)
        blob = records.encode(rec)
        fd = paths.secure_open_append(seg)
        try:
            view = memoryview(blob)
            while view:
                n = os.write(fd, view)
                if n <= 0:
                    raise OSError("zero-byte write")   # no infinite loop (Round-6 #1)
                view = view[n:]
            os.fsync(fd)                           # retain the lock until the terminal is durable
        finally:
            os.close(fd)
        return True
    except Exception:
        return False
    finally:
        lease.release()
