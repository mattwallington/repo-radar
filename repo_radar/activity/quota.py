import fcntl, json, os, stat, time
from dataclasses import dataclass
from repo_radar.activity import paths, records, ids
from repo_radar.activity import scan as scan_mod
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
    ints (strings/floats → CORRUPT), `reserved` exactly RESERVE, `granted >= 0`, total ≤ cap.

    Ruling 52 (Codex R5-4, IMPORTANT): `data` is decoded STRICT UTF-8 first, exactly like
    `records.parse_valid` (Ruling 51) -- `json.loads(bytes)` auto-detects UTF-16/32 and silently
    accepts (and strips) a UTF-8 BOM, so a UTF-16LE- or BOM-prefixed ledger file was accepted by
    Python here while Node's reader (lossy the other way) disagreed. A `UnicodeDecodeError` falls
    through to the same broad `except Exception: CORRUPT` as any other malformed entry -- the
    existing fail-closed sentinel, unchanged."""
    try:
        text = data.decode("utf-8", "strict") if isinstance(data, (bytes, bytearray)) else data
        d = json.loads(text)
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
    # kept as a thin, independent helper (some tests assert its exact [] output for a
    # bad-named-only directory); lifecycle/classify decisions now go through `_scan` below
    # instead. Byte-accounting helpers (`_on_disk`/`_committed`/`_charge`) intentionally do NOT
    # go through this function -- they use `paths.stat_owned_segments` directly and stay
    # unfiltered on purpose (a bad-named file still counts toward the quota ceiling).
    return [
        seg for seg in paths.read_owned_segments(paths.activity_dir(home, activity_id))
        if paths.parse_segment_name(seg[0]) is not None
    ]

# Ruling 38 (Codex R2 R2-1) + Codex R3 B2-B4: the single trusted scan now lives in
# `repo_radar.activity.scan` (a leaf module shared with `reconcile.synthesize_terminal`, which
# re-runs it UNDER the owner lease before choosing the synthetic outcome). `Scan` and `_scan`
# are kept as names here for existing callers/tests; `_scan` is a thin wrapper (not a bare
# alias) so a monkeypatch of `scan_mod.scan_activity` reaches every consumer uniformly.
Scan = scan_mod.Scan

def _scan(home, aid):
    """THE single scan (Ruling 38): see `scan.scan_activity`. `_top_types`/`_has_start`/
    `_has_terminal`/`_classify` (and, through them, `_reconcile_one_locked`/`_prune_locked`/
    `_retain_locked`) all derive from this SAME pass."""
    return scan_mod.scan_activity(home, aid)

def _top_types(home, aid):
    """Types of VALID v1 records for THIS activity (Round-4 #5) — via the single `_scan` pass, so
    a nested `fields.type`, unsupported schema, foreign activity_id, or bad enum never count."""
    return [r.get("type") for r in _scan(home, aid).records]

# lifecycle state is DERIVED from parsed segments, never a ledger flag (finding 1)
def _has_start(home, aid):    return "start" in _top_types(home, aid)
def _has_terminal(home, aid): return "terminal" in _top_types(home, aid)
# finding 7: SIZE accounting uses fstat metadata only, never a content read (content reads are
# reserved for the lifecycle path above -- _top_types/_has_start/_has_terminal -- where the
# actual bytes are needed to parse records; a per-event grant() must never reread a whole
# segment, up to the 64 MiB ceiling, while holding quota.lock and excluding other producers).
def _on_disk_detailed(home, aid):
    """(bytes, uncertain) companion to `_on_disk` (Ruling 45): `bytes` is the REAL measured total
    (no max-liability substitution -- that belongs to `_charge`'s ceiling math below, not to this
    "what's actually on disk" accessor); `uncertain` is True iff `aid`'s directory couldn't be
    fully validated/listed/stat'd this pass (see `paths.stat_owned_segments_detailed`)."""
    entries, uncertain = paths.stat_owned_segments_detailed(paths.activity_dir(home, aid))
    return sum(sz for _n, sz in entries), uncertain

def _on_disk(home, aid):
    """Thin wrapper over `_on_disk_detailed` (Ruling 45): unchanged shape/behavior."""
    return _on_disk_detailed(home, aid)[0]

def _sized_subdirs(home):
    """ONE root-enumeration + per-activity stat pass (Ruling 49/50), shared by
    `_accounting_snapshot` and `_committed_detailed` so neither maintains its own independent copy
    of "list subdirs, skip quota/, stat each one, fold in whatever's uncertain". Root enumeration
    goes through `paths.list_owned_subdirs_detailed` (Ruling 49) so a hidden/unmeasurable
    activity-id entry at the ROOT level (EIO, EACCES, a symlink or file squatting on the name)
    folds into `uncertain_names` here too, not just a per-activity directory's own stat failure --
    a root-rejected entry never even reaches `sizes` (it was never a listable, stat-able directory
    this pass), so `_accounting_snapshot` below must treat it exactly like a directory whose OWN
    `stat_owned_segments_detailed` came back uncertain: `name in uncertain_names` with NO entry in
    `sizes` (measured baseline 0) still gets the max-liability charge, never silently 0.

    Returns `(sizes, uncertain, uncertain_names)`:
      sizes -- {name: REAL measured bytes}, for names whose directory WAS actually listed/stat'd
        this pass -- no max-liability substitution (that's `_accounting_snapshot`'s job).
      uncertain -- True iff the root enumeration itself was uncertain (couldn't validate/list the
        base), OR any name in `uncertain_names` below is non-empty.
      uncertain_names -- every activity-id whose bytes couldn't be fully measured this pass: a
        per-activity directory whose `stat_owned_segments_detailed` came back uncertain, UNION a
        root-level entry rejected for any reason other than 'gone' (ENOENT -- proven absent, never
        uncertain). Kept for `_committed_detailed`'s established (bytes, uncertain_aids) shape."""
    base = paths.quota_dir(home).parent
    subdirs, rejected, root_uncertain = paths.list_owned_subdirs_detailed(base)
    sizes = {}
    uncertain_names = set()
    for name in subdirs:
        if name == "quota":
            continue
        entries, dir_uncertain = paths.stat_owned_segments_detailed(base / name)
        sizes[name] = sum(sz for _n, sz in entries)
        if dir_uncertain:
            uncertain_names.add(name)
    for name, reason in rejected:
        if reason != "gone":                # ENOENT alone is proven absent -- 0 bytes, not uncertain
            uncertain_names.add(name)
    return sizes, root_uncertain or bool(uncertain_names), uncertain_names

def _committed_detailed(home):
    """(bytes, uncertain_aids) companion to `_committed` (Ruling 45/49): `bytes` is the REAL
    measured total across every activity directory (settled or live) -- no max-liability
    substitution. `uncertain_aids` is the set of activity-id directory names that couldn't be
    fully validated/listed/stat'd this pass. Thin wrapper over the shared `_sized_subdirs` single-
    pass primitive (Ruling 50) that `_accounting_snapshot` also uses."""
    sizes, _uncertain, uncertain_names = _sized_subdirs(home)
    return sum(sizes.values()), uncertain_names

def _committed(home):
    """Thin wrapper over `_committed_detailed` (Ruling 45): unchanged shape/behavior."""
    return _committed_detailed(home)[0]

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

@dataclass
class Snapshot:
    """The unified accounting read (Ruling 50 / Codex R5-3, IMPORTANT): `charge` and `uncertain`
    as computed from the SAME single filesystem+ledger pass. See `_accounting_snapshot` below."""
    charge: int
    uncertain: bool

def _accounting_snapshot(home):
    """Codex R2 fix (fix-review round 2 BLOCKER) + Ruling 45 (Codex R4 B1) + Ruling 50 (Codex R5-3,
    IMPORTANT), now unified into ONE pass. Pre-R5-3, `_charge` and `_accounting_uncertain` were
    each their OWN independent full scan (root enumeration + one `stat_owned_segments_detailed`
    per activity); `admit`/`grant` called them back-to-back. A directory's measurability could
    change BETWEEN those two independent scans, combining a max-liability fallback charge from
    ONE scan with an `uncertain=False` verdict from the OTHER, later scan of the same moment --
    admitting on a charge/uncertainty pair that never coexisted in reality. This function is now
    the SINGLE source both `_charge` and `_accounting_uncertain` (thin wrappers below) read from,
    and `admit`/`grant` call it exactly once per decision (never `_charge`+`_accounting_uncertain`
    separately), so the two numbers are always a matched pair from one instant.

    Root enumeration is `paths.list_owned_subdirs_detailed` (Ruling 49): its own `uncertain` folds
    into this snapshot's `uncertain` up front (a hidden/unmeasurable activity-id entry at the ROOT
    level must refuse exactly like an unmeasurable per-activity directory does). Each activity
    directory is `stat_owned_segments_detailed`'d EXACTLY ONCE via the shared `_sized_subdirs`
    primitive -- kept as its own patchable seam for existing hook-based tests (mid-scan-append
    undercount, etc.) that monkeypatch `paths.stat_owned_segments_detailed` directly. An uncertain
    activity contributes its MAXIMUM liability, max(measured, PER_ACTIVITY_CAP) -- the same
    max-liability rule a torn/corrupt ledger entry gets below, and max(...) (not a flat replace) so
    any bytes that WERE provable before the failure are never discarded even if they somehow
    exceed the cap. A ROOT-rejected entry (Ruling 49: never even reached `sizes`, e.g. an EIO'd
    lstat) gets the SAME treatment with a measured baseline of 0 -- i.e. flatly PER_ACTIVITY_CAP --
    so it can never silently vanish from the charge the way it did pre-fix (Codex repro: charge
    drops to 60 MiB with `uncertain=False`, a reservation wrongly admitted). Ledger entries are
    read once via `_ledger_entries`; a CORRUPT entry still contributes its own PER_ACTIVITY_CAP max
    liability exactly once, unchanged from before. `admit`/`grant` additionally refuse outright
    while `snap.uncertain` (a max-liability guess is a floor for the charge, not a trustworthy
    measurement to admit new liability against)."""
    sizes, uncertain, uncertain_names = _sized_subdirs(home)
    charged_sizes = {
        name: (max(sizes.get(name, 0), PER_ACTIVITY_CAP) if name in uncertain_names else sizes[name])
        for name in set(sizes) | uncertain_names
    }
    total = sum(charged_sizes.values())
    for aid, e in _ledger_entries(home):
        total += PER_ACTIVITY_CAP if e == "CORRUPT" \
            else max(0, e["reserved"] + e["granted"] - charged_sizes.get(aid, 0))
    return Snapshot(charge=total, uncertain=uncertain)

def _charge(home):
    """Thin wrapper over `_accounting_snapshot` (Ruling 50): unchanged shape/behavior, kept for
    tests/introspection that only need the charge total."""
    return _accounting_snapshot(home).charge

def _has_corrupt(home):
    # spec §7: whether ANY ledger entry is currently untrustworthy. Used to fail-closed refuse
    # new admissions/grants while it stands (Codex fix-review B2, Gap 1).
    return any(e == "CORRUPT" for _aid, e in _ledger_entries(home))

def _accounting_uncertain(home):
    """Thin wrapper over `_accounting_snapshot` (Ruling 45/50): unchanged shape/behavior, kept for
    tests/introspection that only need the uncertainty flag. See `_accounting_snapshot` for what
    folds into it -- root-enumeration uncertainty (Ruling 49) and every per-activity directory's."""
    return _accounting_snapshot(home).uncertain

def admit(home, activity_id, lease):
    fd = None
    try:
        fd = _quota_lock(home)                                 # may raise UnsafePath (swapped component)
        _reconcile_all_locked(home)                            # reconcile BEFORE charge
        if _has_corrupt(home):
            return False        # spec §7: refuse new admissions while any corrupt entry stands (fail-closed)
        # Ruling 50: ONE unified snapshot -- charge and uncertain are a matched pair from the
        # SAME pass, never `_charge(home)` and `_accounting_uncertain(home)` as two separate scans.
        snap = _accounting_snapshot(home)
        if snap.uncertain:
            return False        # Ruling 45: refuse new admissions while any activity dir is unmeasurable
        if snap.charge + RESERVE > CEILING:
            _prune_locked(home, (snap.charge + RESERVE) - CEILING)   # prune FIRST
            snap = _accounting_snapshot(home)           # FRESH unified snapshot before re-deciding
            if snap.uncertain or snap.charge + RESERVE > CEILING:
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
        # Ruling 50: ONE unified snapshot -- see admit() above for why this must not be two calls.
        snap = _accounting_snapshot(home)
        if snap.uncertain:
            return False        # Ruling 45: refuse grants while any activity dir is unmeasurable
        p = paths.ledger_entry_path(home, activity_id); e = _read_entry(p)
        if e == "CORRUPT":
            return False
        if e["granted"] + nbytes > ORDINARY_CAP:      # per-activity cap
            return False
        if snap.charge + nbytes > CEILING:              # global ceiling, from the SAME snapshot
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
    scan = _scan(home, aid)                         # Ruling 38: ONE scan gates every branch below,
    if scan.view_uncertain:                          # including the eventual synthesize_terminal call --
        return                                       # uncertain view => PRESERVE, never guess (R2-1)
    types = {r.get("type") for r in scan.records}
    if "terminal" in types:                         # terminal LINE present -> settle if owner gone
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
    if "start" not in types:                        # reserve-before-start -> lease-gated release
        if _owner_lock_absent(home, aid):           # §5/line 78: never-created lock => owner gone
            _unlink_entry(home, aid); return
        l = lease_mod.acquire(lock)                # (nothing recorded; nothing to synthesize)
        if l is not None:
            l.release(); _unlink_entry(home, aid)
        return
    # has start, no terminal, view NOT uncertain (checked above, before this point is ever
    # reached): provably-dead owner -> synthesize interrupted/cancelled + settle. synthesize_
    # terminal acquires the owner.lock itself (its own free/busy gate) and then UNCONDITIONALLY
    # re-runs the same trusted `scan.scan_activity` under that lease (Codex R2 B2 recheck / R3
    # B3): the scan above ran before any lease was held, so it alone can't be trusted to still
    # hold true at write time. It returns False if BUSY/UNCERTAIN, a terminal landed, or the
    # write fails, in which case we preserve the charge (safe bias).
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

# Ruling 33/36 (Codex R1 finding B1, R2 finding R2-2): the shared PROBLEM-BEARING contract v2,
# mirrored 1:1 by the Node reader over the same wire records + scan. An activity is
# problem-bearing iff ANY of: (a) an `event` record with level in {warn, error}; (b) a `terminal`
# record with outcome in {failed, blocked, interrupted, succeeded-with-warnings}
# (`succeeded`/`cancelled`/`skipped` are routine -- cancel is user-initiated); (c) an `integrity`
# record (top-level type); (d) any structural integrity FINDING (interior corruption / unsupported
# schema); (e) any REJECTED segment entry (unreadable/unsafe/bad-name); (f) two or more terminal
# records (duplicate or conflicting). (a)-(c) were the v1 contract, over VALID records alone; v2
# widens the lens to the whole `Scan` (§7/§9's Problems lens is "warn/error + failure diagnostics
# + anything structurally wrong", not just terminal outcome or valid records) -- see
# test_activity_problem_bearing.py / data/problem_bearing_vectors.json for the shared parity
# fixture the Node side drives against this identical predicate.
_PROBLEM_EVENT_LEVELS = {"warn", "error"}
_PROBLEM_OUTCOMES = {"failed", "blocked", "interrupted", "succeeded-with-warnings"}

def is_problem_bearing(scan) -> bool:
    """Single reusable predicate over a `Scan` (or a plain dict with the same `records`/
    `findings`/`rejected` keys -- e.g. a JSON-loaded vectors-fixture case, so this stays trivially
    unit-testable and easy for the Node reader to mirror). See the Ruling 33/36 contract above;
    `_classify` is the sole in-repo caller but this stays a public, dependency-free function."""
    if isinstance(scan, dict):
        recs, findings, rejected = scan.get("records", []), scan.get("findings", []), scan.get("rejected", [])
    else:
        recs, findings, rejected = scan.records, scan.findings, scan.rejected
    terminal_count = 0
    for obj in recs:
        t = obj.get("type")
        if t == "event" and obj.get("level") in _PROBLEM_EVENT_LEVELS:
            return True
        if t == "terminal":
            terminal_count += 1
            if obj.get("outcome") in _PROBLEM_OUTCOMES:
                return True
        if t == "integrity":
            return True
    return bool(findings) or bool(rejected) or terminal_count >= 2

def _classify(home, aid):
    """('running'|'problem'|'routine', newest_mtime) for a SETTLED activity — via the single
    `_scan` pass. An uncertain view (couldn't confirm what's actually on disk) is treated as
    'running': unreconciled/uncertain items must never be guessed into 'problem' or 'routine',
    and `_prune_locked`/`_retain_locked` already skip 'running' unconditionally (Ruling 38)."""
    scan = _scan(home, aid)
    if scan.view_uncertain:
        return ("running", scan.mtime)
    types = {r.get("type") for r in scan.records}
    if "terminal" not in types:
        return ("running", scan.mtime)
    problem = is_problem_bearing(scan)
    return ("problem" if problem else "routine", scan.mtime)

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
