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
    (Ruling 56 / Codex R6-4, IMPORTANT). `on_disk` is the REAL measured byte total, or `None` if
    that directory's OWN `stat_owned_segments_detailed` pass came back uncertain (exists, but
    couldn't be fully measured -- EACCES/ELOOP/ENOTDIR/a failed lstat on some entry within it)."""
    aid: str
    on_disk: int | None

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

def _gather_accounting(home):
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
    scans) monkeypatch directly. Ledger entries come from `_ledger_entries_detailed` (Ruling 54)."""
    base = paths.quota_dir(home).parent
    subdirs, rejected, root_uncertain = paths.list_owned_subdirs_detailed(base)
    root_listable = not (root_uncertain and not rejected)

    activities = []
    for name in subdirs:
        if name == "quota":
            continue
        entries, dir_uncertain = paths.stat_owned_segments_detailed(base / name)
        on_disk = None if dir_uncertain else sum(sz for _n, sz in entries)
        activities.append(ActivityInput(aid=name, on_disk=on_disk))
    rejected_root_ids = [name for name, reason in rejected if reason != "gone"]

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

    The shared cross-language rule (mirrored 1:1 by the Node agent; pinned by
    `repo_radar/tests/data/accounting_vectors.json`):
      charge = sum(term(aid) for aid over every non-corrupt aid) + PER_ACTIVITY_CAP * (# corrupt
        ledger entries).
      term(aid) is exactly PER_ACTIVITY_CAP (no separate on_disk/liability term added on top) if
        aid is UNCERTAIN: a rejected valid-activity-id root entry (a non-'gone' rejection), OR a
        root-listed activity directory whose own byte measurement came back uncertain
        (`on_disk is None`). Its live-ledger liability, if any, is NOT added on top -- by
        construction a valid (non-corrupt) ledger entry always has `reserved + granted <=
        PER_ACTIVITY_CAP` (see `_parse_entry`), so max(0, reserved+granted-PER_ACTIVITY_CAP) is
        always 0 anyway.
      Otherwise term(aid) = on_disk(aid) + (max(0, reserved+granted-on_disk(aid)) if aid has a
        live non-corrupt ledger entry, else 0). An aid with no directory at all (e.g.
        reserve-before-start, before `secure_mkdir` ever ran) has on_disk(aid) == 0 by
        construction -- it's simply absent from `inputs.activities`.
      A corrupt ledger entry's aid contributes exactly PER_ACTIVITY_CAP total, no separate
        on_disk term even if that same aid also has a real, measured activity directory --
        excluded from the `term(aid)` domain entirely, counted only via the flat sum above.
      uncertain = (not root_listable) or (not ledger_listable) or any term(aid) above took the
        uncertain branch.
      corrupt = any corrupt entry in `inputs.ledger` -- computed UNCONDITIONALLY, even when root/
        ledger enumeration itself failed (a corrupt entry that WAS actually read this pass is
        still corrupt, independent of whether some OTHER part of the pass was unmeasurable).
      An unlistable root OR an unlistable ledger flattens the WHOLE charge to CEILING (not just
        its own portion) -- "how much is reserved right now" becomes entirely unknowable, so
        nothing less than the hard ceiling is a safe number to admit/grant new liability against."""
    corrupt = any(entry.corrupt for entry in inputs.ledger)
    if not inputs.root_listable or not inputs.ledger_listable:
        return Snapshot(charge=CEILING, uncertain=True, corrupt=corrupt)

    on_disk_by_aid = {a.aid: a.on_disk for a in inputs.activities}
    rejected_root = set(inputs.rejected_root_ids)
    corrupt_aids = {e.aid for e in inputs.ledger if e.corrupt}
    live_ledger = {e.aid: e for e in inputs.ledger if not e.corrupt}

    aids = (set(on_disk_by_aid) | rejected_root | set(live_ledger)) - corrupt_aids
    uncertain = False
    total = 0
    for aid in aids:
        if aid in rejected_root or (aid in on_disk_by_aid and on_disk_by_aid[aid] is None):
            uncertain = True
            total += PER_ACTIVITY_CAP
            continue
        disk = on_disk_by_aid.get(aid, 0)
        liability = 0
        if aid in live_ledger:
            e = live_ledger[aid]
            liability = max(0, e.reserved + e.granted - disk)
        total += disk + liability
    total += PER_ACTIVITY_CAP * len(corrupt_aids)
    return Snapshot(charge=total, uncertain=uncertain, corrupt=corrupt)

def _accounting_snapshot(home):
    """The single source `_charge`/`_accounting_uncertain`/`admit`/`grant` all read from, so
    `charge`, `uncertain` and `corrupt` are always a matched triple from one instant -- never
    `_charge`+`_accounting_uncertain` as two separate scans (Ruling 50 / Codex R5-3), and never a
    separate `_has_corrupt()` pre-check ahead of this snapshot's own pass (Ruling 55 / Codex R6-2,
    BLOCKER: that let a staged clean->corrupt ledger read admit with a corrupt entry inside the
    actual decision snapshot). Now a thin composition of `_gather_accounting` (all I/O, one pass)
    and `_compute_snapshot` (pure) -- Ruling 56 / Codex R6-4, IMPORTANT."""
    return _compute_snapshot(_gather_accounting(home))

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
    fd = None
    try:
        fd = _quota_lock(home)                                 # may raise UnsafePath (swapped component)
        _reconcile_all_locked(home)                            # reconcile BEFORE charge
        # Ruling 50/55: ONE unified snapshot -- charge, uncertain AND corrupt are a matched triple
        # from the SAME pass, never `_charge(home)`+`_accounting_uncertain(home)` as two separate
        # scans, and never a separate `_has_corrupt(home)` pre-check ahead of this snapshot's own
        # pass (that let a staged clean->corrupt ledger read admit with a corrupt entry inside the
        # actual decision snapshot -- Codex R6-2, BLOCKER).
        snap = _accounting_snapshot(home)
        if snap.corrupt:
            return False        # spec §7: refuse new admissions while any corrupt entry stands (fail-closed)
        if snap.uncertain:
            return False        # Ruling 45: refuse new admissions while any activity dir is unmeasurable
        if snap.charge + RESERVE > CEILING:
            _prune_locked(home, (snap.charge + RESERVE) - CEILING)   # prune FIRST
            snap = _accounting_snapshot(home)           # FRESH unified snapshot before re-deciding
            if snap.corrupt or snap.uncertain or snap.charge + RESERVE > CEILING:
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
        # Ruling 50/55: ONE unified snapshot -- see admit() above for why this must not be a
        # separate `_has_corrupt()` call plus its own `_accounting_snapshot()` pass.
        snap = _accounting_snapshot(home)
        if snap.corrupt:
            return False        # spec §7: refuse grants while any corrupt entry stands
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
