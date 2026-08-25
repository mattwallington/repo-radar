import os
from repo_radar.activity import paths, records, ids
from repo_radar.activity import lease as lease_mod
from repo_radar.activity import scan as scan_mod

RECONCILER = "reconciler"

def synthesize_terminal(home, aid, gate=None):
    """§5: for a provably-dead (lease-free) unterminated activity, acquire the lease, write a
    durable synthetic terminal (by=reconciler), and release. Returns True iff a terminal is now
    durable. Returns False (preserve) when the lease is BUSY/UNCERTAIN, the trusted under-lease
    view no longer supports synthesis, or the write fails.

    Codex R3 B3 (Ruling 41/42): the decision is taken from the SINGLE trusted scan
    (`scan.scan_activity`), re-run UNCONDITIONALLY under the just-acquired lease -- never from
    an unfiltered read of every `*.jsonl` in the directory. That closes two holes at once:
    (1) the scan-to-write race for a caller (quota's `_reconcile_one_locked`) whose own pre-lease
    scan can go stale before the lease is held (a conforming segment could become unreadable, or
    a terminal could land, in the gap); (2) an untrusted file -- a bad-named `junk.jsonl`, or a
    conforming segment's torn (no trailing newline) last line -- carrying a "valid"
    `control{cancel_requested}` or `terminal` that must NEVER influence the synthetic outcome.
    If the view is uncertain, has no `start`, or already holds a `terminal`, the lease is
    released and nothing is written. Outcome is `cancelled` iff the trusted view saw an accepted
    `control{cancel_requested}`, else `interrupted`.

    `gate`, when given, is an additional zero-arg callable evaluated under the lease before the
    trusted rescan (kept for API compatibility); falsy => release, write nothing, return False.
    Mirrors Node's `synthesizeTerminal`, which re-scans under its own lease the same way."""
    lock = paths.owner_lock_path(home, aid)
    try:
        lease = lease_mod.acquire(lock)            # None if busy; raises only on fs error
    except OSError:
        return False
    if lease is None:
        return False                               # owner alive (or uncertain) -> preserve
    try:
        if gate is not None and not gate():
            return False                           # caller's own re-evaluated view declined
        view = scan_mod.scan_activity(home, aid)   # THE trusted view, taken UNDER the lease
        if view.view_uncertain:
            return False                           # uncertain => preserve, never guess (R2-1)
        types = {r.get("type") for r in view.records}
        if "start" not in types or "terminal" in types:
            return False                           # nothing to synthesize for / already terminated
        outcome = "cancelled" if view.cancel_requested else "interrupted"
        seg = paths.segment_path(home, aid, "python", ids.mint_token())
        rec = records.build("terminal", seq=0, activity_id=aid,
                            outcome=outcome, summary={}, by=RECONCILER)
        blob = records.encode(rec)
        fd = paths.secure_open_append(seg)
        try:
            buf = memoryview(blob)
            while buf:
                n = os.write(fd, buf)
                if n <= 0:
                    raise OSError("zero-byte write")   # no infinite loop (Round-6 #1)
                buf = buf[n:]
            os.fsync(fd)                           # retain the lock until the terminal is durable
        finally:
            os.close(fd)
        return True
    except Exception:
        return False
    finally:
        lease.release()
