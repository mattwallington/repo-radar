import fcntl, json, os, stat
from repo_radar.activity import paths, records, ids
from repo_radar.activity import lease as lease_mod
from repo_radar.activity import reconcile as reconcile_mod

CEILING = 64 * 1024 * 1024
RESERVE = 60 * 1024
PER_ACTIVITY_CAP = 4 * 1024 * 1024
ORDINARY_CAP = PER_ACTIVITY_CAP - RESERVE

def _open_quota_dir(home):
    paths.secure_mkdir(paths.quota_dir(home))              # ensure activity/ + quota/ exist
    return paths.open_owned_dir(paths.quota_dir(home))     # validated quota/ dir fd (Round-5 #1)

def _quota_lock(home):
    paths.secure_mkdir(paths.quota_dir(home))
    afd = paths.open_owned_dir(paths.quota_dir(home).parent)   # validated activity/ dir fd
    try:                                                        # quota.lock opened RELATIVE to it
        fd = os.open("quota.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=afd)
    finally:
        os.close(afd)
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode):                           # reject FIFO/device (Round-5 #5)
        os.close(fd); raise paths.UnsafePath("quota.lock is not a regular file")
    try:
        if stat.S_IMODE(st.st_mode) != 0o600:
            os.fchmod(fd, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX)      # blocking; brief critical section
    except BaseException:
        os.close(fd); raise                 # no fd leak on fchmod/flock failure (fix round 1, Minor 3)
    return fd

def _unlock(fd):
    fcntl.flock(fd, fcntl.LOCK_UN); os.close(fd)

def _parse_entry(data):
    """Validate the ledger's FULL invariant (Round-3/6 #6/#5): counters must be EXACT non-boolean
    ints (strings/floats → CORRUPT), `reserved` exactly RESERVE, `granted >= 0`, total ≤ cap."""
    try:
        d = json.loads(data)
        r, g = d["reserved"], d["granted"]
        if isinstance(r, bool) or isinstance(g, bool) or not isinstance(r, int) or not isinstance(g, int):
            return "CORRUPT"
        if r != RESERVE or g < 0 or r + g > PER_ACTIVITY_CAP:
            return "CORRUPT"
        return {"reserved": r, "granted": g}
    except Exception:
        return "CORRUPT"

def _read_entry(path):
    try:
        return _parse_entry(paths.read_owned_file(path))     # descriptor-relative read + S_ISREG
    except (paths.UnsafePath, FileNotFoundError, OSError):
        return "CORRUPT"

def _write_entry(home, activity_id, reserved, granted):
    """Durable, DESCRIPTOR-RELATIVE ledger write (Round-5 #1): temp file + full-write loop +
    fsync, atomic rename and dir fsync all relative to the validated quota dir fd, with temp
    cleanup on any failure. Raises on durability failure."""
    if not ids.valid_activity_id(activity_id):
        # fix round 1, Critical: activity_id becomes a filename below; dir_fd is IGNORED for an
        # absolute name and `../` escapes the quota dir, so this MUST be validated before any
        # filename is built (mirrors paths.ledger_entry_path/activity_dir's own guard).
        raise paths.UnsafePath(f"invalid activity_id for ledger path: {activity_id!r}")
    blob = json.dumps({"reserved": reserved, "granted": granted}).encode()
    name = f"{activity_id}.json"; tmp = f".{activity_id}.{os.getpid()}.tmp"
    qfd = _open_quota_dir(home)
    try:
        tfd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=qfd)
        try:
            view = memoryview(blob)
            while view:
                n = os.write(tfd, view)
                if n <= 0:
                    raise OSError("zero-byte write")         # no infinite loop (Round-6 #5)
                view = view[n:]
            os.fsync(tfd)
        except BaseException:
            os.close(tfd)
            try:
                os.unlink(tmp, dir_fd=qfd)                    # temp cleanup on write/fsync failure
            except OSError:
                pass
            raise
        else:
            os.close(tfd)
        try:
            os.replace(tmp, name, src_dir_fd=qfd, dst_dir_fd=qfd)   # atomic rename, descriptor-relative
        except BaseException:
            try:
                os.unlink(tmp, dir_fd=qfd)                    # cleanup on rename failure too (Round-6 #5)
            except OSError:
                pass
            raise
        os.fsync(qfd)                                        # durable rename (dir entry)
    finally:
        os.close(qfd)

def _unlink_entry(home, activity_id):
    if not ids.valid_activity_id(activity_id):
        # fix round 1, Critical: same path-traversal/arbitrary-delete guard as _write_entry.
        raise paths.UnsafePath(f"invalid activity_id for ledger path: {activity_id!r}")
    qfd = _open_quota_dir(home)                              # descriptor-relative unlink (Round-5 #1)
    try:
        os.unlink(f"{activity_id}.json", dir_fd=qfd)
    except FileNotFoundError:
        pass
    finally:
        os.close(qfd)

def _segments_data(home, activity_id):
    # descriptor-relative enumerate+read: (name, data, size, mtime) tuples (Round-4 #3)
    return paths.read_owned_segments(paths.activity_dir(home, activity_id))

def _top_types(home, aid):
    """Types of VALID v1 records for THIS activity (Round-4 #5) — via the canonical validator,
    so a nested `fields.type`, unsupported schema, foreign activity_id, or bad enum never count."""
    types = []
    for _name, data, _size, _mt in _segments_data(home, aid):
        for line in data.split(b"\n"):
            if not line:
                continue
            obj = records.parse_valid(line, aid)
            if obj is not None:
                types.append(obj["type"])
    return types

# lifecycle state is DERIVED from parsed segments, never a ledger flag (finding 1)
def _has_start(home, aid):    return "start" in _top_types(home, aid)
def _has_terminal(home, aid): return "terminal" in _top_types(home, aid)
def _on_disk(home, aid):      return sum(sz for _n, _d, sz, _mt in _segments_data(home, aid))

def _committed(home):
    base = paths.quota_dir(home).parent
    total = 0
    for name in paths.list_owned_subdirs(base):    # dir-fd-safe subdir names (Round-4 #3)
        if name == "quota":
            continue
        total += sum(sz for _n, _d, sz, _mt in paths.read_owned_segments(base / name))
    return total

def _ledger_entries(home):
    # (aid, entry-or-CORRUPT) pairs for every valid-UUID-named ledger entry in the quota dir. A
    # name that isn't a valid UUIDv4 is skipped fail-closed (never fed back into a path —
    # Round-6 #5); every OTHER valid-UUID name is CLASSIFIED, never silently skipped (Codex gate
    # round 1, finding 2): `paths.list_owned_entries` is an UNFILTERED name listing (unlike
    # `read_owned_segments`, which would silently drop a symlink/FIFO/dir entry out of the
    # enumeration entirely, undercounting the charge — fail-open). `_read_entry` already opens
    # each entry descriptor-relative with the O_NOFOLLOW|O_NONBLOCK + fstat(S_ISREG) safe-open
    # and returns "CORRUPT" for anything that isn't a safe, well-formed regular JSON ledger.
    out = []
    for name in paths.list_owned_entries(paths.quota_dir(home), suffix=".json"):
        aid = name[:-5]
        if ids.valid_activity_id(aid):
            out.append((aid, _read_entry(paths.ledger_entry_path(home, aid))))
    return out

def _charge(home):
    total = _committed(home)
    for aid, e in _ledger_entries(home):
        total += PER_ACTIVITY_CAP if e == "CORRUPT" \
            else max(0, e["reserved"] + e["granted"] - _on_disk(home, aid))
    return total

def admit(home, activity_id, lease):
    fd = None
    try:
        fd = _quota_lock(home)                                 # may raise UnsafePath (swapped component)
        _reconcile_all_locked(home)                            # reconcile BEFORE charge
        if _charge(home) + RESERVE > CEILING:
            _prune_locked(home, (_charge(home) + RESERVE) - CEILING)   # prune FIRST
            if _charge(home) + RESERVE > CEILING:
                return False                                   # best-effort refuse
        _write_entry(home, activity_id, RESERVE, 0)            # durable, descriptor-relative
        return True
    except (OSError, paths.UnsafePath):
        return False                                           # durability/safety failure -> refuse
    finally:
        if fd is not None:
            _unlock(fd)

def grant(home, activity_id, nbytes):
    fd = None
    try:
        fd = _quota_lock(home)
        p = paths.ledger_entry_path(home, activity_id); e = _read_entry(p)
        if e == "CORRUPT":
            return False
        if e["granted"] + nbytes > ORDINARY_CAP:      # per-activity cap
            return False
        if _charge(home) + nbytes > CEILING:           # global ceiling
            return False
        _write_entry(home, activity_id, e["reserved"], e["granted"] + nbytes)   # durable BEFORE append
        return True
    except (OSError, paths.UnsafePath):
        return False                                   # durability/safety failure -> refuse the append
    finally:
        if fd is not None:
            _unlock(fd)

def settle(home, activity_id):
    fd = None
    try:
        fd = _quota_lock(home)
        _unlink_entry(home, activity_id)           # bytes now counted purely by the scan
    except (OSError, paths.UnsafePath):
        return None                                 # best-effort release; never raises (fix round 1, Minor 2)
    finally:
        if fd is not None:
            _unlock(fd)

def _reconcile_one_locked(home, aid):
    lock = paths.owner_lock_path(home, aid)
    if _has_terminal(home, aid):                   # terminal LINE present -> settle if owner gone
        l = lease_mod.acquire(lock)
        if l is not None:
            # finding 1: a terminal LINE on disk is not necessarily DURABLE -- its write() can
            # succeed while its own fsync failed (writer correctly retained the ledger then).
            # Settlement must never happen unless the terminal is durable, else a power loss
            # right after this unlink but before the OS flushes the line would lose BOTH the
            # terminal and the ledger, leaving nothing to trigger recovery. Release the lease
            # regardless so a future reconcile pass can retry; only unlink on a clean fsync.
            try:
                if paths.fsync_owned_segments(paths.activity_dir(home, aid)):
                    _unlink_entry(home, aid)
            finally:
                l.release()
        return
    if not _has_start(home, aid):                  # reserve-before-start -> lease-gated release
        l = lease_mod.acquire(lock)                # (nothing recorded; nothing to synthesize)
        if l is not None:
            l.release(); _unlink_entry(home, aid)
        return
    # has start, no terminal: provably-dead owner -> synthesize interrupted/cancelled + settle.
    # synthesize_terminal acquires the owner.lock itself (its own free/busy gate); returns False
    # if BUSY/UNCERTAIN or the write fails, in which case we preserve the charge (safe bias).
    if reconcile_mod.synthesize_terminal(home, aid):
        _unlink_entry(home, aid)

def _reconcile_all_locked(home):
    for aid, _e in _ledger_entries(home):
        _reconcile_one_locked(home, aid)

def reconcile(home):
    fd = None
    try:
        fd = _quota_lock(home)
        _reconcile_all_locked(home)
    except (OSError, paths.UnsafePath):
        return None                                 # fail closed on lock failure (fix round 1, Minor 2)
    finally:
        if fd is not None:
            _unlock(fd)

def _classify(home, aid):
    """('running'|'problem'|'routine', newest_mtime) for a SETTLED activity — parsed top-level."""
    segs = _segments_data(home, aid)
    mtime = max((mt for _n, _d, _sz, mt in segs), default=0.0)
    types = _top_types(home, aid)
    if "terminal" not in types:
        return ("running", mtime)
    outcomes = []
    for _n, data, _sz, _mt in segs:
        for line in data.split(b"\n"):
            if not line:
                continue
            obj = records.parse_valid(line, aid)
            if obj is not None and obj["type"] == "terminal":
                outcomes.append(obj.get("outcome"))
    problem = ("integrity" in types) or any(
        o in ("failed", "blocked", "interrupted", "succeeded-with-warnings") for o in outcomes)
    return ("problem" if problem else "routine", mtime)

def _prune_locked(home, need_bytes):
    """Ceiling-override pruner (CALLER HOLDS quota.lock): SETTLED items only (no live ledger
    entry), never running/unreconciled, always keep the newest problem. Enumeration + deletion
    are descriptor-relative (Round-4 #3) so pruning can never escape the Activity tree."""
    base = paths.quota_dir(home).parent
    live = {aid for aid, _e in _ledger_entries(home)}
    items = []
    for aid in paths.list_owned_subdirs(base):
        if aid == "quota" or aid in live:
            continue
        kind, mtime = _classify(home, aid)
        if kind == "running":
            continue                               # never prune running/unreconciled
        items.append((aid, kind, mtime))
    routine = sorted([i for i in items if i[1] == "routine"], key=lambda x: x[2])
    problems = sorted([i for i in items if i[1] == "problem"], key=lambda x: x[2])
    order = routine + (problems[:-1] if problems else [])   # keep newest problem
    freed = 0
    for aid, _, _ in order:
        if freed >= need_bytes:
            break
        freed += paths.unlink_owned_tree(paths.activity_dir(home, aid))   # dir-fd-safe delete
    return freed

def prune(home, need_bytes):
    fd = None
    try:
        fd = _quota_lock(home)                      # public entry is lock-safe (finding 1)
        return _prune_locked(home, need_bytes)
    except (OSError, paths.UnsafePath):
        return 0                                     # fail closed on lock failure (fix round 1, Minor 2)
    finally:
        if fd is not None:
            _unlock(fd)
