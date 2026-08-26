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

@dataclass
class LockCtx:
    """Ruling 60 (Codex R7-1, BLOCKER): the object `_quota_lock` returns -- a validated
    `quota.lock` fd PLUS the `quota/` directory fd `_quota_lock` validated/opened BEFORE taking
    `flock`, kept alive for the WHOLE lifetime of the lock. `admit`/`grant` read/write the ledger
    through `qfd` (via `_ledger_entries_detailed_fd`/`_read_entry_fd`/`_write_entry_fd`) instead of
    re-resolving `quota/` by path for their own decision snapshot -- so a rename/swap of `quota/`
    AFTER the lock was acquired can never be misread by that decision as "no ledgers yet" the way
    a fresh path-based `ENOENT` would be (Codex repro: 16 x 4 MiB ledger liabilities, rename
    `quota/` between lock and enumeration -> `admit` wrongly admitted a reservation -> 67,170,304
    bytes on disk, over the ceiling). `_unlock` closes both fds. Other locked call sites
    (`_reconcile_all_locked`, `_prune_locked`, `_retain_locked`, `settle`'s `_unlink_entry`) are
    NOT required to thread `qfd` through -- they're exercised directly (without a real lock) by
    existing tests, and their own path-based ENOENT=empty reading is an accepted, unchanged
    reading for those "unlocked reader" call shapes."""
    lock_fd: int
    qfd: int

def _quota_lock(home):
    qfd = _open_quota_dir(home)          # validated quota/ dir fd, opened+kept BEFORE flock (Ruling 60)
    try:
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
            os.close(fd); raise             # no fd leak on fchmod/flock failure (fix round 1, Minor 3)
        return LockCtx(lock_fd=fd, qfd=qfd)
    except BaseException:
        os.close(qfd); raise                # no qfd leak either, on ANY failure above (Ruling 60)

def _unlock(ctx):
    fcntl.flock(ctx.lock_fd, fcntl.LOCK_UN)
    os.close(ctx.lock_fd)
    os.close(ctx.qfd)

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

def _read_entry_fd(qfd, activity_id):
    """Descriptor-relative counterpart to `_read_entry` (Ruling 60 / Codex R7-1, BLOCKER): reads
    `<activity_id>.json` relative to an ALREADY-VALIDATED `quota/` dir fd (a `LockCtx.qfd`) instead
    of re-resolving `quota/` by path. `admit`/`grant` use this for their own locked decision.
    Same fail-closed contract as `_read_entry`: a missing/invalid/malformed entry -> "CORRUPT"
    (an invalid `activity_id` also can't be turned into a safe filename -> "CORRUPT", mirroring
    what a caller like `grant` already does with `_read_entry`'s result)."""
    if not ids.valid_activity_id(activity_id):
        return "CORRUPT"
    try:
        return _parse_entry(paths.read_owned_dir_fd_regular(qfd, f"{activity_id}.json"))
    except (paths.UnsafePath, FileNotFoundError, OSError):
        return "CORRUPT"

def _write_entry_fd(qfd, activity_id, reserved, granted):
    """Descriptor-relative CORE of the durable ledger write (Ruling 60 / Codex R7-1, BLOCKER):
    temp file + full-write loop + fsync, atomic rename + dir fsync, temp cleanup on any failure --
    all relative to an ALREADY-VALIDATED `quota/` dir fd (a `LockCtx.qfd`), never re-resolving
    `quota/` by path. `admit`/`grant` call this directly with `ctx.qfd` while holding the lock, so
    the write stays bound to the SAME directory identity the lock validated. Raises on durability
    failure (via `paths.write_owned_dir_fd_regular_atomic`); `_write_entry` below is the
    path-based wrapper other (unlocked) call sites use."""
    if not ids.valid_activity_id(activity_id):
        # fix round 1, Critical: activity_id becomes a filename below; dir_fd is IGNORED for an
        # absolute name and `../` escapes the quota dir, so this MUST be validated before any
        # filename is built (mirrors paths.ledger_entry_path/activity_dir's own guard).
        raise paths.UnsafePath(f"invalid activity_id for ledger path: {activity_id!r}")
    blob = json.dumps({"reserved": reserved, "granted": granted}).encode()
    name = f"{activity_id}.json"; tmp = f".{activity_id}.{os.getpid()}.tmp"
    paths.write_owned_dir_fd_regular_atomic(qfd, name, tmp, blob)

def _write_entry(home, activity_id, reserved, granted):
    """Path-based wrapper over `_write_entry_fd` (Ruling 60): opens+validates the `quota/` dir
    fresh for this ONE write (used by unlocked/introspection call sites, e.g. tests that call this
    directly without holding `quota.lock`). Locked callers (`admit`/`grant`) call
    `_write_entry_fd(ctx.qfd, ...)` directly instead, so their write stays bound to the SAME
    validated directory identity `_quota_lock` captured, never re-resolved by path."""
    if not ids.valid_activity_id(activity_id):
        raise paths.UnsafePath(f"invalid activity_id for ledger path: {activity_id!r}")
    qfd = _open_quota_dir(home)
    try:
        _write_entry_fd(qfd, activity_id, reserved, granted)
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
    """ONE root-enumeration + per-activity stat pass (Ruling 49/50), used by `_committed_detailed`
    below for "list subdirs, skip quota/, stat each one, fold in whatever's uncertain". (As of
    Ruling 56 / Codex R6-4, `_accounting_snapshot`'s OWN root-gathering lives in `_gather_
    accounting` instead -- it needs `root_listable` as a signal distinct from a single rejected
    entry, which this function's single conflated `uncertain` flag can't expose; see there.) Root
    enumeration goes through `paths.list_owned_subdirs_detailed` (Ruling 49) so a hidden/
    unmeasurable activity-id entry at the ROOT level (EIO, EACCES, a symlink or file squatting on
    the name) folds into `uncertain_names` here too, not just a per-activity directory's own stat
    failure.

    Returns `(sizes, uncertain, uncertain_names)`:
      sizes -- {name: REAL measured bytes}, for names whose directory WAS actually listed/stat'd
        this pass -- no max-liability substitution.
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

def _ledger_entries_detailed(home):
    """(entries, uncertain) companion to `_ledger_entries` (Ruling 54 / Codex R6-1, BLOCKER):
    `paths.list_owned_entries` collapsed EVERY ledger-directory listing failure to `[]` -- "no
    ledgers" -- indistinguishable from a genuinely empty/never-created quota dir. A transient EIO
    while enumerating `quota/` therefore silently dropped every live reservation's liability from
    the charge for that pass (no live ledger => no liability counted), exactly the bug class
    Ruling 40/45/49 already fixed one layer in (segment reads, activity-directory/root
    enumeration) -- now closed for the LEDGER directory itself too.

    `uncertain` is False + entries=[] iff the quota dir provably never existed (no admission has
    ever happened -- a proven state); True iff it exists but couldn't be validated/listed this
    pass (see `paths.list_owned_entries_detailed`). Feeds `_gather_accounting` below; `admit`/
    `grant` must refuse outright while `uncertain` (an unlistable ledger means "how much is
    reserved right now" is entirely unknowable, not merely undercounted)."""
    names, uncertain = paths.list_owned_entries_detailed(paths.quota_dir(home), suffix=".json")
    out = []
    for name in names:
        aid = name[:-5]
        if ids.valid_activity_id(aid):
            out.append((aid, _read_entry(paths.ledger_entry_path(home, aid))))
    return out, uncertain

def _ledger_entries_detailed_fd(qfd):
    """Descriptor-relative counterpart to `_ledger_entries_detailed` (Ruling 60 / Codex R7-1,
    BLOCKER): enumerates + reads the ledger relative to an ALREADY-VALIDATED `quota/` dir fd (a
    `LockCtx.qfd`), never re-resolving `quota/` by path -- so a rename/swap of the directory AFTER
    the lock was acquired can never be misread as "no ledgers yet" (see
    `paths.list_owned_dir_fd_detailed`'s module note). Same `(entries, uncertain)` shape as
    `_ledger_entries_detailed`, but `uncertain` here has no 'gone' case at all: ANY scandir failure
    on this fd is uncertain, never empty. `_gather_accounting` uses this when called with a `qfd`
    (i.e. from `admit`/`grant`'s own locked decision snapshot)."""
    names, uncertain = paths.list_owned_dir_fd_detailed(qfd, suffix=".json")
    out = []
    for name in names:
        aid = name[:-5]
        if ids.valid_activity_id(aid):
            out.append((aid, _read_entry_fd(qfd, aid)))
    return out, uncertain

def _ledger_entries(home):
    # (aid, entry-or-CORRUPT) pairs for every valid-UUID-named ledger entry in the quota dir. A
    # name that isn't a valid UUIDv4 is skipped fail-closed (never fed back into a path —
    # Round-6 #5); every OTHER valid-UUID name is CLASSIFIED, never silently skipped (Codex gate
    # round 1, finding 2): `paths.list_owned_entries` is an UNFILTERED name listing (unlike
    # `read_owned_segments`, which would silently drop a symlink/FIFO/dir entry out of the
    # enumeration entirely, undercounting the charge — fail-open). `_read_entry` already opens
    # each entry descriptor-relative with the O_NOFOLLOW|O_NONBLOCK + fstat(S_ISREG) safe-open
    # and returns "CORRUPT" for anything that isn't a safe, well-formed regular JSON ledger.
    #
    # Thin `[0]` wrapper over `_ledger_entries_detailed` (Ruling 54): unchanged shape/behavior
    # for existing callers (`_reconcile_all_locked`, `_prune_locked`, `_retain_locked`,
    # `_has_corrupt`, tests) that don't need the listing-uncertainty flag.
    return _ledger_entries_detailed(home)[0]

@dataclass
class Snapshot:
    """The unified accounting read (Ruling 50 / Codex R5-3, IMPORTANT; extended with `corrupt` by
    Ruling 55 / Codex R6-2, BLOCKER): `charge`, `uncertain` AND `corrupt` all computed from the
    SAME single filesystem+ledger pass (`_gather_accounting` + `_compute_snapshot` below), so a
    decision can never combine a corrupt/uncertain verdict read at one moment with a charge total
    read at another. See `_accounting_snapshot` below."""
    charge: int
    uncertain: bool
    corrupt: bool

@dataclass
class ActivityInput:
    """One root-listed activity directory's byte measurement, as gathered by `_gather_accounting`
    (Ruling 62 / Codex R7-3, IMPORTANT -- REPLACES the Round-6 `on_disk: int | None` shape).
    `on_disk_measured` is ALWAYS the real, summed byte total of whatever entries `stat_owned_
    segments_detailed` actually managed to stat this pass -- 0 if none, but NEVER `None` and NEVER
    discarded, even when that directory's own stat pass came back uncertain (partial measurement
    is still real, measured, on-disk liability and must count). `uncertain` is True iff that
    directory's OWN `stat_owned_segments_detailed` pass came back uncertain (exists, but couldn't
    be FULLY measured -- EACCES/ELOOP/ENOTDIR/a failed lstat on some entry within it); `_compute_
    snapshot` decides what to do with a partial measurement, this dataclass just carries it."""
    aid: str
    on_disk_measured: int
    uncertain: bool

@dataclass
class LedgerInput:
    """One ledger entry for the accounting pass: either a live, well-formed reservation
    (`reserved`/`granted`) or a `corrupt` entry (unsafe/unreadable/malformed — see
    `_parse_entry`/`_read_entry`). A `corrupt` entry's `reserved`/`granted` are unused (left at
    their 0 default)."""
    aid: str
    reserved: int = 0
    granted: int = 0
    corrupt: bool = False

@dataclass
class AccountingInputs:
    """Pure snapshot of everything `_compute_snapshot` needs (Ruling 56 / Codex R6-4, IMPORTANT):
    every filesystem/ledger read for one accounting decision happens in `_gather_accounting`
    below, exactly once, producing this plain-data record. `_compute_snapshot` then derives
    `charge`/`uncertain`/`corrupt` from it with NO further I/O -- the exact rule
    `repo_radar/tests/data/accounting_vectors.json` pins byte-for-byte (the Node agent implements
    the identical function against the same fixture).

      root_listable -- False iff the activity ROOT itself (the `activity/` dir, `quota/` aside)
        could not be validated/opened/listed this pass -- mirrors `paths.list_owned_subdirs_
        detailed`'s own base-level failure, NOT a single rejected entry (see `rejected_root_ids`
        for that).
      ledger_listable -- False iff the LEDGER dir (`quota/`) could not be validated/listed this
        pass (Ruling 54 / Codex R6-1, BLOCKER) -- as opposed to one that provably never existed
        yet (no admission has ever happened): that is `ledger_listable=True` with an empty
        `ledger` list, a proven state, not a failure.
      activities -- one `ActivityInput` per root-listed, real activity directory (`quota/`
        excluded), in no particular order.
      rejected_root_ids -- valid-activity-id-shaped root entries REJECTED for a reason other than
        'gone' (a symlink, a non-directory squatting on the name, denied, or an unexplained stat
        failure) -- these never became a listed activity directory this pass, so they carry no
        `on_disk` measurement at all.
      ledger -- one `LedgerInput` per valid-activity-id-shaped ledger entry actually read this
        pass (empty if `ledger_listable` is False)."""
    root_listable: bool
    ledger_listable: bool
    activities: list
    rejected_root_ids: list
    ledger: list

def _gather_accounting(home, qfd=None):
    """ALL filesystem + ledger reads for one accounting decision, in a single pass (Ruling 56 /
    Codex R6-4, IMPORTANT) -- `_compute_snapshot` below is pure and does none of its own I/O.

    Root enumeration goes through `paths.list_owned_subdirs_detailed` DIRECTLY (not the
    `_sized_subdirs`/`_committed_detailed` primitive, which folds root-level and per-entry
    uncertainty into one flag) so `root_listable` stays a distinct signal from a single rejected
    entry. `list_owned_subdirs_detailed`'s own `uncertain` conflates "the base itself couldn't be
    validated/opened/listed" with "some individual entry was rejected" -- but every branch that
    rejects an INDIVIDUAL entry also appends it to `rejected` (see paths.py), so a base-level
    failure is the one case that reaches here with `uncertain=True` and `rejected` still empty
    (subdirs is always `[]` there too, since that return happens before any entry is examined) --
    that is the exact, and only, signal `root_listable` below relies on.

    Each real activity directory is `stat_owned_segments_detailed`'d exactly once -- the same
    hook seam existing tests (e.g. test_admit_refuses_from_a_single_snapshot_not_two_separate_
    scans) monkeypatch directly; its (possibly partial) measured bytes are ALWAYS kept in
    `ActivityInput.on_disk_measured` (Ruling 62 / Codex R7-3 -- never discarded to `None`).

    `qfd` (Ruling 60 / Codex R7-1, BLOCKER): when given -- a `LockCtx.qfd` from an ACTIVE
    `_quota_lock` -- ledger entries come from the descriptor-relative `_ledger_entries_detailed_fd`
    instead of the path-based `_ledger_entries_detailed(home)`, so `admit`/`grant`'s own locked
    decision never re-resolves `quota/` by path (where a rename/swap AFTER the lock was acquired
    could otherwise surface as a misleading `ENOENT` = "no ledgers yet"). `None` (the default) --
    unlocked/introspection callers -- keeps the existing path-based reading."""
    base = paths.quota_dir(home).parent
    subdirs, rejected, root_uncertain = paths.list_owned_subdirs_detailed(base)
    root_listable = not (root_uncertain and not rejected)

    activities = []
    for name in subdirs:
        if name == "quota":
            continue
        entries, dir_uncertain = paths.stat_owned_segments_detailed(base / name)
        on_disk_measured = sum(sz for _n, sz in entries)      # partial-or-full, NEVER discarded
        activities.append(ActivityInput(aid=name, on_disk_measured=on_disk_measured, uncertain=dir_uncertain))
    rejected_root_ids = [name for name, reason in rejected if reason != "gone"]

    if qfd is not None:
        ledger_entries, ledger_uncertain = _ledger_entries_detailed_fd(qfd)
    else:
        ledger_entries, ledger_uncertain = _ledger_entries_detailed(home)
    ledger = [
        LedgerInput(aid=aid, corrupt=True) if e == "CORRUPT"
        else LedgerInput(aid=aid, reserved=e["reserved"], granted=e["granted"])
        for aid, e in ledger_entries
    ]
    return AccountingInputs(
        root_listable=root_listable,
        ledger_listable=not ledger_uncertain,
        activities=activities,
        rejected_root_ids=rejected_root_ids,
        ledger=ledger,
    )

def _compute_snapshot(inputs):
    """PURE function (Ruling 56 / Codex R6-4, IMPORTANT): no I/O of any kind -- everything it
    needs is already gathered in `inputs` by `_gather_accounting`. Constants (`CEILING`/
    `PER_ACTIVITY_CAP`) are read as MODULE GLOBALS at call time (never bound as default arguments),
    exactly like every other constant this module already treats this way (see `NEWEST_KEEP`
    etc.), so a test's `monkeypatch.setattr(quota, "CEILING", ...)` is honored here too.

    Ruling 62 (Codex R7-3, IMPORTANT -- REPLACES the Round-6 rule): committed bytes are
    AUTHORITATIVE from the scan and must never be discarded, even under uncertainty or ledger
    corruption. The shared cross-language rule (mirrored 1:1 by the Node agent; pinned by
    `repo_radar/tests/data/accounting_vectors.json` schema v2):

      Unlistable activity ROOT (`root_listable=False` -- `inputs.activities`/`rejected_root_ids`
        are always empty in this case, see `_gather_accounting`): no bytes are measurable at all,
        so the charge is purely the ledger's own outstanding liability -- `max(sum(reserved+
        granted for every LIVE ledger entry) + PER_ACTIVITY_CAP * (# corrupt ledger entries),
        CEILING)`, uncertain=True.
      Unlistable LEDGER dir (`ledger_listable=False`, root listable -- `inputs.ledger` is always
        empty in this case): no ledger liability is knowable, so the charge is purely what WAS
        measured -- `max(sum(on_disk_measured for every root-listed activity), CEILING)`,
        uncertain=True. (`on_disk_measured` is already the real, partial-or-full measured total --
        never discarded, per `ActivityInput`.)
      Otherwise (both listable), per aid over the union of root-listed activities, rejected root
        ids, and ledger entries:
        - CORRUPT-ledger aid: `measured_on_disk + PER_ACTIVITY_CAP` (`measured_on_disk` is that
          aid's `on_disk_measured` if it's also a root-listed activity, else 0) -- committed bytes
          are KEPT even for a corrupt ledger entry, on top of the outstanding-liability cap. Takes
          priority over the uncertain-activity branch below (corrupt-ledger status is decisive).
        - UNCERTAIN aid (a rejected valid-activity-id root entry, OR a root-listed activity whose
          own `stat_owned_segments_detailed` pass came back uncertain): `max(measured_partial,
          PER_ACTIVITY_CAP)` -- `measured_partial` is whatever WAS actually stat'd this pass (0 if
          the aid was rejected outright / nothing stat'd), never a flat cap that discards a larger
          partial measurement. No extra ledger liability is added on top.
        - CERTAIN aid (measured, not corrupt-ledger, not uncertain): `on_disk_measured + (max(0,
          reserved+granted-on_disk_measured) if a live non-corrupt ledger entry exists, else 0)`
          -- unchanged from Round-6.
      uncertain = (not root_listable) or (not ledger_listable) or any term(aid) took the
        UNCERTAIN-aid branch (a corrupt-ledger aid, on its own, does NOT set uncertain).
      corrupt = any corrupt entry in `inputs.ledger` -- computed UNCONDITIONALLY, even when root/
        ledger enumeration itself failed."""
    corrupt = any(entry.corrupt for entry in inputs.ledger)

    live_ledger = {e.aid: e for e in inputs.ledger if not e.corrupt}
    corrupt_ledger = {e.aid: e for e in inputs.ledger if e.corrupt}

    if not inputs.root_listable:
        total = sum(e.reserved + e.granted for e in live_ledger.values())
        total += PER_ACTIVITY_CAP * len(corrupt_ledger)
        return Snapshot(charge=max(total, CEILING), uncertain=True, corrupt=corrupt)

    if not inputs.ledger_listable:
        total = sum(a.on_disk_measured for a in inputs.activities)
        return Snapshot(charge=max(total, CEILING), uncertain=True, corrupt=corrupt)

    by_aid = {a.aid: a for a in inputs.activities}
    rejected_root = set(inputs.rejected_root_ids)

    aids = set(by_aid) | rejected_root | set(live_ledger) | set(corrupt_ledger)
    uncertain = False
    total = 0
    for aid in aids:
        measured = by_aid[aid].on_disk_measured if aid in by_aid else 0
        if aid in corrupt_ledger:
            total += measured + PER_ACTIVITY_CAP
            continue
        activity_uncertain = aid in rejected_root or (aid in by_aid and by_aid[aid].uncertain)
        if activity_uncertain:
            uncertain = True
            total += max(measured, PER_ACTIVITY_CAP)
            continue
        liability = 0
        if aid in live_ledger:
            e = live_ledger[aid]
            liability = max(0, e.reserved + e.granted - measured)
        total += measured + liability
    return Snapshot(charge=total, uncertain=uncertain, corrupt=corrupt)

def _accounting_snapshot(home, qfd=None):
    """The single source `_charge`/`_accounting_uncertain`/`admit`/`grant` all read from, so
    `charge`, `uncertain` and `corrupt` are always a matched triple from one instant -- never
    `_charge`+`_accounting_uncertain` as two separate scans (Ruling 50 / Codex R5-3), and never a
    separate `_has_corrupt()` pre-check ahead of this snapshot's own pass (Ruling 55 / Codex R6-2,
    BLOCKER: that let a staged clean->corrupt ledger read admit with a corrupt entry inside the
    actual decision snapshot). Now a thin composition of `_gather_accounting` (all I/O, one pass)
    and `_compute_snapshot` (pure) -- Ruling 56 / Codex R6-4, IMPORTANT.

    `qfd` (Ruling 60 / Codex R7-1, BLOCKER): forwarded to `_gather_accounting` -- pass a
    `LockCtx.qfd` when this snapshot IS the decision inside an active `_quota_lock` (as `admit`/
    `grant` do), so the ledger read stays descriptor-relative to the SAME validated `quota/`
    identity the lock captured, never re-resolved by path."""
    return _compute_snapshot(_gather_accounting(home, qfd=qfd))

def _charge(home):
    """Thin wrapper over `_accounting_snapshot` (Ruling 50): unchanged shape/behavior, kept for
    tests/introspection that only need the charge total."""
    return _accounting_snapshot(home).charge

def _has_corrupt(home):
    # spec §7: whether ANY ledger entry is currently untrustworthy. Kept as a thin, independent
    # pass for tests/introspection (Ruling 55 / Codex R6-2) -- `admit`/`grant` no longer call this
    # separately; they consume `Snapshot.corrupt` from their own single `_accounting_snapshot`
    # pass instead (see there).
    return any(e == "CORRUPT" for _aid, e in _ledger_entries(home))

def _accounting_uncertain(home):
    """Thin wrapper over `_accounting_snapshot` (Ruling 45/50): unchanged shape/behavior, kept for
    tests/introspection that only need the uncertainty flag. See `_accounting_snapshot` for what
    folds into it -- root-enumeration uncertainty (Ruling 49), every per-activity directory's, and
    the LEDGER directory's own listing (Ruling 54)."""
    return _accounting_snapshot(home).uncertain

def admit(home, activity_id, lease):
    ctx = None
    try:
        ctx = _quota_lock(home)                                # may raise UnsafePath (swapped component)
        _reconcile_all_locked(home)                            # reconcile BEFORE charge
        # Ruling 50/55: ONE unified snapshot -- charge, uncertain AND corrupt are a matched triple
        # from the SAME pass, never `_charge(home)`+`_accounting_uncertain(home)` as two separate
        # scans, and never a separate `_has_corrupt(home)` pre-check ahead of this snapshot's own
        # pass (that let a staged clean->corrupt ledger read admit with a corrupt entry inside the
        # actual decision snapshot -- Codex R6-2, BLOCKER). Ruling 60 / Codex R7-1, BLOCKER: bound
        # to `ctx.qfd` -- the SAME `quota/` dir fd `_quota_lock` validated -- so this decision never
        # re-resolves `quota/` by path (a rename/swap after the lock was taken would otherwise
        # surface as a misleading path-based ENOENT = "no ledgers yet").
        snap = _accounting_snapshot(home, qfd=ctx.qfd)
        if snap.corrupt:
            return False        # spec §7: refuse new admissions while any corrupt entry stands (fail-closed)
        if snap.uncertain:
            return False        # Ruling 45: refuse new admissions while any activity dir is unmeasurable
        if snap.charge + RESERVE > CEILING:
            _prune_locked(home, (snap.charge + RESERVE) - CEILING)   # prune FIRST
            snap = _accounting_snapshot(home, qfd=ctx.qfd)   # FRESH unified snapshot before re-deciding
            if snap.corrupt or snap.uncertain or snap.charge + RESERVE > CEILING:
                return False                                   # best-effort refuse
        _write_entry_fd(ctx.qfd, activity_id, RESERVE, 0)      # durable, bound to the SAME fd (Ruling 60)
        return True
    except (OSError, paths.UnsafePath):
        return False                                           # durability/safety failure -> refuse
    finally:
        if ctx is not None:
            _unlock(ctx)

def grant(home, activity_id, nbytes):
    ctx = None
    try:
        ctx = _quota_lock(home)
        # Ruling 50/55: ONE unified snapshot -- see admit() above for why this must not be a
        # separate `_has_corrupt()` call plus its own `_accounting_snapshot()` pass. Ruling 60 /
        # Codex R7-1: bound to `ctx.qfd`, same rationale as admit() above.
        snap = _accounting_snapshot(home, qfd=ctx.qfd)
        if snap.corrupt:
            return False        # spec §7: refuse grants while any corrupt entry stands
        if snap.uncertain:
            return False        # Ruling 45: refuse grants while any activity dir is unmeasurable
        e = _read_entry_fd(ctx.qfd, activity_id)
        if e == "CORRUPT":
            return False
        if e["granted"] + nbytes > ORDINARY_CAP:      # per-activity cap
            return False
        if snap.charge + nbytes > CEILING:              # global ceiling, from the SAME snapshot
            return False
        _write_entry_fd(ctx.qfd, activity_id, e["reserved"], e["granted"] + nbytes)   # durable BEFORE append
        return True
    except (OSError, paths.UnsafePath):
        return False                                   # durability/safety failure -> refuse the append
    finally:
        if ctx is not None:
            _unlock(ctx)

def settle(home, activity_id):
    ctx = None
    try:
        ctx = _quota_lock(home)
        _unlink_entry(home, activity_id)           # bytes now counted purely by the scan
    except (OSError, paths.UnsafePath):
        return None                                 # best-effort release; never raises (fix round 1, Minor 2)
    finally:
        if ctx is not None:
            _unlock(ctx)

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
    ctx = None
    try:
        ctx = _quota_lock(home)
        _reconcile_all_locked(home)
    except (OSError, paths.UnsafePath):
        return None                                 # fail closed on lock failure (fix round 1, Minor 2)
    finally:
        if ctx is not None:
            _unlock(ctx)

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
    are descriptor-relative (Round-4 #3) so pruning can never escape the Activity tree.

    Ruling 61 (Codex R7-2, BLOCKER): the live set comes from `_ledger_entries_detailed`, not the
    lossy `_ledger_entries`; if the ledger dir itself is unlistable this pass, the live set is
    UNPROVEN -- prune NOTHING (return 0) rather than treat every settled activity as a candidate
    against a wrongly-empty live set. Pre-fix, `prune_to_ceiling`'s outer loop kept calling this
    against a constant charge sentinel (an unlistable ledger flattens the charge to CEILING) and
    this function's own live set silently went empty, so it deleted every settled candidate on
    each iteration (Codex repro: three settled routine activities + unlistable ledger -> all three
    deleted, charge still pinned at the ceiling)."""
    base = paths.quota_dir(home).parent
    entries, ledger_uncertain = _ledger_entries_detailed(home)
    if ledger_uncertain:
        return 0                                   # live set unproven -- never delete under uncertainty
    live = {aid for aid, _e in entries}
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
    ctx = None
    try:
        ctx = _quota_lock(home)                      # public entry is lock-safe (finding 1)
        return _prune_locked(home, need_bytes)
    except (OSError, paths.UnsafePath):
        return 0                                     # fail closed on lock failure (fix round 1, Minor 2)
    finally:
        if ctx is not None:
            _unlock(ctx)

def _retain_locked(home):
    """CALLER HOLDS quota.lock. Applies the spec §7 age/newest-50 retention matrix, then the
    ceiling-override (which MAY prune within the protected newest-50 window, per spec -- the
    ceiling always wins). Returns the list of pruned activity ids.

    Ruling 61 (Codex R7-2, BLOCKER): same live-set guard as `_prune_locked` -- the live set comes
    from `_ledger_entries_detailed`; if the ledger dir is unlistable this pass, refuse ENTIRELY
    (return `[]`, delete nothing) rather than run the age/newest-50 matrix against a wrongly-empty
    live set that would treat every live reservation as prunable."""
    base = paths.quota_dir(home).parent
    entries, ledger_uncertain = _ledger_entries_detailed(home)
    if ledger_uncertain:
        return []                                    # live set unproven -- never delete under uncertainty
    live = {aid for aid, _e in entries}
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
    ctx = None
    try:
        ctx = _quota_lock(home)
        _reconcile_all_locked(home)                          # settle newly-dead owners first
        return _retain_locked(home)
    except (OSError, paths.UnsafePath):
        return []                                             # fail closed on lock failure
    finally:
        if ctx is not None:
            _unlock(ctx)
