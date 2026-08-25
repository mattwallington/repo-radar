import fcntl, json, os, stat, time
from repo_radar.activity import paths, records, ids
from repo_radar.activity import lease as lease_mod
from repo_radar.activity import reconcile as reconcile_mod

CEILING = 64 * 1024 * 1024
RESERVE = 60 * 1024
PER_ACTIVITY_CAP = 4 * 1024 * 1024
ORDINARY_CAP = PER_ACTIVITY_CAP - RESERVE

# spec §7 retention matrix (Task 3.5): the newest NEWEST_KEEP settled items are PROTECTED from
# age-based pruning regardless of kind; a routine/problem item outside that protected window is
# only prunable once it exceeds its own age threshold. All three are read at CALL time inside
# `retain` (not bind time) so a test can monkeypatch them, exactly like CEILING/RESERVE elsewhere
# in this module (see test_ceiling_override_keeps_newest_problem's own CEILING monkeypatch).
NEWEST_KEEP = 50
ROUTINE_MAX_AGE_S = 14 * 86400
PROBLEM_MAX_AGE_S = 90 * 86400

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
        name = f"{activity_id}.json"
        try:
            os.unlink(name, dir_fd=qfd)
        except FileNotFoundError:
            pass
        except (IsADirectoryError, PermissionError):
            # a corrupt <uuid>.json DIRECTORY (EISDIR on Linux, EPERM on macOS): try rmdir for an
            # EMPTY dir. If it can't be removed (non-empty / other), LEAVE it -- the entry stays
            # CORRUPT and refuse-while-corrupt keeps admissions fail-closed. This is NOT mistaken for
            # success because _has_corrupt re-reads the actual ledger. NEVER propagate (would break
            # an unrelated admission's reconcile pass -- Codex fix-review B2).
            try:
                os.rmdir(name, dir_fd=qfd)
            except OSError:
                pass
    finally:
        os.close(qfd)

def _segments_data(home, activity_id):
    # descriptor-relative enumerate+read: (name, data, size, mtime) tuples (Round-4 #3).
    # F-E parity fix: filtered to CONFORMING segment names only (`paths.parse_segment_name`) --
    # this is the single source `_top_types`/`_classify` (and, through them,
    # `_reconcile_one_locked`/`retain`) read from, so a non-conforming file sitting in the
    # activity dir (e.g. `python-s3cr3t.jsonl`, or plain `junk.jsonl`) can no longer masquerade
    # as a real segment and drive lifecycle/classification decisions. Byte-accounting helpers
    # (`_on_disk`/`_committed`/`_charge`) intentionally do NOT go through this function -- they
    # use `paths.stat_owned_segments` directly and stay unfiltered on purpose (a bad-named file
    # still counts toward the quota ceiling).
    return [
        seg for seg in paths.read_owned_segments(paths.activity_dir(home, activity_id))
        if paths.parse_segment_name(seg[0]) is not None
    ]

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
# finding 7: SIZE accounting uses fstat metadata only, never a content read (content reads are
# reserved for the lifecycle path above -- _top_types/_has_start/_has_terminal -- where the
# actual bytes are needed to parse records; a per-event grant() must never reread a whole
# segment, up to the 64 MiB ceiling, while holding quota.lock and excluding other producers).
def _on_disk(home, aid):      return sum(sz for _n, sz in paths.stat_owned_segments(paths.activity_dir(home, aid)))

def _committed(home):
    base = paths.quota_dir(home).parent
    total = 0
    for name in paths.list_owned_subdirs(base):    # dir-fd-safe subdir names (Round-4 #3)
        if name == "quota":
            continue
        total += sum(sz for _n, sz in paths.stat_owned_segments(base / name))
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
    """Codex R2 fix (fix-review round 2 BLOCKER): SINGLE fstat scan per activity, reused for
    BOTH the committed sum and the per-entry outstanding term. The prior version called
    _committed(home) (one scan of every activity's segments) and then, separately, this
    function's own _on_disk(home, aid) (a SECOND scan of just aid's segments) — two scans of the
    SAME activity at two DIFFERENT times. A concurrent writer's append (writers release
    quota.lock before appending, per the module's lifecycle) landing between those two scans was
    excluded from `committed` (scanned before the append) AND subtracted out of `outstanding` via
    the stale-vs-fresh mismatch in _on_disk (scanned after) — a double-miss undercount (measured
    repro: charged 61940 vs true 62120). Scanning each activity exactly once and reusing that one
    value for both terms makes an append either fully counted (both terms see the post-append
    size) or fully deferred to the NEXT _charge() call (both terms see the pre-append size) — it
    can never be split across the two. Per-activity result is always max(size, reserved+granted),
    the same conservative liability as before non-interleaved — never an undercount. Still
    fstat-only (finding 7/I7): never reads segment CONTENT here."""
    base = paths.quota_dir(home).parent
    sizes = {}
    for name in paths.list_owned_subdirs(base):
        if name == "quota":
            continue
        sizes[name] = sum(sz for _n, sz in paths.stat_owned_segments(base / name))
    total = sum(sizes.values())
    for aid, e in _ledger_entries(home):
        total += PER_ACTIVITY_CAP if e == "CORRUPT" \
            else max(0, e["reserved"] + e["granted"] - sizes.get(aid, 0))
    return total

def _has_corrupt(home):
    # spec §7: whether ANY ledger entry is currently untrustworthy. Used to fail-closed refuse
    # new admissions/grants while it stands (Codex fix-review B2, Gap 1).
    return any(e == "CORRUPT" for _aid, e in _ledger_entries(home))

def admit(home, activity_id, lease):
    fd = None
    try:
        fd = _quota_lock(home)                                 # may raise UnsafePath (swapped component)
        _reconcile_all_locked(home)                            # reconcile BEFORE charge
        if _has_corrupt(home):
            return False        # spec §7: refuse new admissions while any corrupt entry stands (fail-closed)
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
        if _has_corrupt(home):
            return False        # spec §7: refuse grants while any corrupt entry stands
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

def _owner_lock_absent(home, aid):
    """spec §5/line 78: an owner.lock that was NEVER CREATED => owner provably gone. Returns True
    ONLY when provably absent (activity dir missing, or dir present but owner.lock missing); any
    uncertainty (unsafe component, unexpected OSError, or a present-but-unsafe lock) => False so
    we PRESERVE rather than risk reclaiming a live reservation (Codex fix-review B2, Gap 2b)."""
    try:
        d = paths.open_owned_dir(paths.activity_dir(home, aid))
    except FileNotFoundError:
        return True                              # activity dir never created => lock never created
    except (paths.UnsafePath, OSError):
        return False                             # uncertain => preserve (conservative)
    try:
        try:
            os.stat("owner.lock", dir_fd=d, follow_symlinks=False)
            return False                         # lock present
        except FileNotFoundError:
            return True                          # dir exists but lock never created => owner gone
        except OSError:
            return False                         # uncertain => preserve
    finally:
        os.close(d)

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
        if _owner_lock_absent(home, aid):           # §5/line 78: never-created lock => owner gone
            _unlink_entry(home, aid); return
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

# Ruling 33 (Codex R1 finding B1): the shared PROBLEM-BEARING contract, mirrored 1:1 by the Node
# reader over the same wire records. An activity is problem-bearing iff ANY of: (a) an `event`
# record with level in {warn, error}; (b) a `terminal` record with outcome in {failed, blocked,
# interrupted, succeeded-with-warnings} (`succeeded`/`cancelled`/`skipped` are routine -- cancel
# is user-initiated); (c) an `integrity` record (top-level type). §7/§9's Problems lens is
# "warn/error + failure diagnostics", broader than terminal outcome alone -- see
# test_activity_problem_bearing.py / data/problem_bearing_vectors.json for the shared parity
# fixture the Node side drives against this identical predicate.
_PROBLEM_EVENT_LEVELS = {"warn", "error"}
_PROBLEM_OUTCOMES = {"failed", "blocked", "interrupted", "succeeded-with-warnings"}

def is_problem_bearing(parsed_records) -> bool:
    """Single reusable predicate over parsed top-level records for ONE activity. See the Ruling
    33 contract above; `_classify` is the sole in-repo caller but this stays a public, dependency-
    free function (dicts in, bool out) so it's trivially unit-testable against the shared fixture
    and easy for the Node reader to mirror."""
    for obj in parsed_records:
        t = obj.get("type")
        if t == "event" and obj.get("level") in _PROBLEM_EVENT_LEVELS:
            return True
        if t == "terminal" and obj.get("outcome") in _PROBLEM_OUTCOMES:
            return True
        if t == "integrity":
            return True
    return False

def _classify(home, aid):
    """('running'|'problem'|'routine', newest_mtime) for a SETTLED activity — parsed top-level."""
    segs = _segments_data(home, aid)
    mtime = max((mt for _n, _d, _sz, mt in segs), default=0.0)
    types = _top_types(home, aid)
    if "terminal" not in types:
        return ("running", mtime)
    parsed = []
    for _n, data, _sz, _mt in segs:
        for line in data.split(b"\n"):
            if not line:
                continue
            obj = records.parse_valid(line, aid)
            if obj is not None:
                parsed.append(obj)
    problem = is_problem_bearing(parsed)
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

def _retain_locked(home):
    """CALLER HOLDS quota.lock. Applies the spec §7 age/newest-50 retention matrix, then the
    ceiling-override (which MAY prune within the protected newest-50 window, per spec -- the
    ceiling always wins). Returns the list of pruned activity ids."""
    base = paths.quota_dir(home).parent
    live = {aid for aid, _e in _ledger_entries(home)}
    before = set(paths.list_owned_subdirs(base))            # pre-deletion snapshot (Round-6 #6)

    candidates = []
    for aid in before:
        if aid == "quota" or aid in live:
            continue
        kind, mtime = _classify(home, aid)
        if kind == "running":
            continue                                         # never prune running/unreconciled
        candidates.append((aid, kind, mtime))

    newest_keep = NEWEST_KEEP                                # read at call time (monkeypatch-friendly)
    protected = {
        # secondary tiebreaker (aid) makes the boundary deterministic on a true mtime tie --
        # `candidates` is built from a `set` (hash-randomized iteration order), so sorting on
        # mtime alone could break a tie differently between runs (Fix R1).
        aid for aid, _k, _mt in
        sorted(candidates, key=lambda c: (c[2], c[0]), reverse=True)[:newest_keep]
    }
    now = time.time()
    routine_max_age = ROUTINE_MAX_AGE_S
    problem_max_age = PROBLEM_MAX_AGE_S
    for aid, kind, mtime in candidates:
        # Codex R1 finding I1: the newest problem is NOT shielded here. Spec §7 ties "always
        # preserve the newest problem" to the ceiling-override specifically (see _prune_locked,
        # unchanged); the age pass applies age AND outside-newest-50 uniformly to routine and
        # problem items alike -- a sole/newest problem older than PROBLEM_MAX_AGE_S and outside
        # the protected window is prunable here, just like any other candidate.
        if aid in protected:
            continue
        age = now - mtime
        prunable = (kind == "routine" and age > routine_max_age) or \
                   (kind == "problem" and age > problem_max_age)
        if prunable:
            paths.unlink_owned_tree(paths.activity_dir(home, aid))

    over = _charge(home) - CEILING
    if over > 0:
        _prune_locked(home, over)                            # ceiling overrides newest-50 (spec §7)

    return sorted(before - set(paths.list_owned_subdirs(base)))

def retain(home):
    fd = None
    try:
        fd = _quota_lock(home)
        _reconcile_all_locked(home)                          # settle newly-dead owners first
        return _retain_locked(home)
    except (OSError, paths.UnsafePath):
        return []                                             # fail closed on lock failure
    finally:
        if fd is not None:
            _unlock(fd)
