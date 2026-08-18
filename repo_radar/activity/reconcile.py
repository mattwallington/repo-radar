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

def synthesize_terminal(home, aid):
    """§5: for a provably-dead (lease-free) unterminated activity, acquire the lease, write a
    durable synthetic terminal (by=reconciler), and release. Returns True iff a terminal is now
    durable. Returns False (preserve) when the lease is BUSY/UNCERTAIN or the write fails."""
    lock = paths.owner_lock_path(home, aid)
    try:
        lease = lease_mod.acquire(lock)            # None if busy; raises only on fs error
    except OSError:
        return False
    if lease is None:
        return False                               # owner alive (or uncertain) -> preserve
    try:
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
