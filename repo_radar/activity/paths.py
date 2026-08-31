import errno, os, stat
from pathlib import Path
from repo_radar.activity import ids

PRODUCERS = {"electron", "dispatcher", "python"}

class UnsafePath(Exception):
    pass

def _base(home) -> Path:
    return Path(home) / "Library" / "Logs" / "repo-radar" / "activity"

def activity_dir(home, activity_id) -> Path:
    if not ids.valid_activity_id(activity_id):
        raise UnsafePath(f"invalid activity_id: {activity_id!r}")
    return _base(home) / activity_id

def segment_path(home, activity_id, producer, writer_id) -> Path:
    if producer not in PRODUCERS:
        raise UnsafePath(f"invalid producer: {producer!r}")
    if not ids.valid_token(writer_id):
        raise UnsafePath(f"invalid writer_id: {writer_id!r}")
    return activity_dir(home, activity_id) / f"{producer}-{writer_id}.jsonl"

_SEGMENT_SUFFIX = ".jsonl"

def parse_segment_name(name):
    """F-E parity fix (mirrors Node's `paths.parseSegmentName`): the single authority for "is
    this a conforming segment filename" (`${producer}-${writer_id}.jsonl`). Returns
    `(producer, writer_id)` iff `name` ends with `.jsonl`, the part before the LAST '-' is a
    known producer (PRODUCERS contains none with a '-' of their own, so the last dash is always
    the producer/writerId boundary for a genuinely valid name), the part after it is a valid
    8-hex token (`ids.valid_token`), AND the reconstructed name round-trips EXACTLY back to
    `name`. Returns None otherwise -- never raises. Used by quota.py's lifecycle helpers
    (`_segments_data`) to filter out non-conforming entries (e.g. `python-s3cr3t.jsonl`,
    `junk.jsonl`) before they're treated as real segments."""
    if not isinstance(name, str) or not name.endswith(_SEGMENT_SUFFIX):
        return None
    stem = name[: -len(_SEGMENT_SUFFIX)]
    idx = stem.rfind("-")
    if idx == -1:
        return None
    producer, writer_id = stem[:idx], stem[idx + 1:]
    if producer not in PRODUCERS:
        return None
    if not ids.valid_token(writer_id):
        return None
    if f"{producer}-{writer_id}{_SEGMENT_SUFFIX}" != name:
        return None
    return (producer, writer_id)

def owner_lock_path(home, activity_id) -> Path:
    return activity_dir(home, activity_id) / "owner.lock"

def quota_dir(home) -> Path:
    return _base(home) / "quota"

def ledger_entry_path(home, activity_id) -> Path:
    if not ids.valid_activity_id(activity_id):
        raise UnsafePath(f"invalid activity_id: {activity_id!r}")
    return quota_dir(home) / f"{activity_id}.json"

def _owned_prefix(path):
    """The shared `~/Library/Logs/repo-radar` prefix (created best-effort, NOT repaired — it is
    shared, not subsystem-owned). Everything at/below `activity/` is the owned subtree."""
    for anc in [path, *path.parents]:
        if anc.name == "repo-radar" and anc.parent.name == "Logs":
            return anc
    return path.parent                            # unusual layout -> treat parent as the prefix

def secure_mkdir(path, mode=0o700) -> None:
    """Descriptor-relative creation of the OWNED subtree (activity/ and below): each component
    is created + opened with `dir_fd` + `O_NOFOLLOW`, so an INTERMEDIATE symlink (not just the
    final one) cannot redirect us, and `fchmod`-repair touches ONLY owned components — never the
    shared prefix (Round-3 #7)."""
    path = Path(path)
    prefix = _owned_prefix(path)
    os.makedirs(prefix, mode=0o700, exist_ok=True)             # shared prefix: create, no repair
    try:
        dir_fd = os.open(prefix, os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY)
    except OSError as e:                                        # prefix itself is a symlink/non-dir
        raise UnsafePath(f"unsafe prefix {prefix}: {e}")
    try:
        for name in path.relative_to(prefix).parts:            # owned components, one at a time
            try:
                os.mkdir(name, mode, dir_fd=dir_fd)
            except FileExistsError:
                pass
            try:
                child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY, dir_fd=dir_fd)
            except OSError as e:                                # ELOOP (symlink) / ENOTDIR here
                raise UnsafePath(f"unsafe component {name!r} under {prefix}: {e}")
            os.close(dir_fd); dir_fd = child
            if stat.S_IMODE(os.fstat(dir_fd).st_mode) != mode:
                os.fchmod(dir_fd, mode)                        # repair owned component only
    finally:
        os.close(dir_fd)

def open_owned_dir(path):
    """A validated O_NOFOLLOW directory fd for an OWNED dir, walked descriptor-relative from the
    shared prefix so NO component (intermediate OR final) can be a symlink (Round-4 #3). Caller
    closes. Raises UnsafePath on a symlinked/non-dir component; FileNotFoundError if missing."""
    path = Path(path)
    prefix = _owned_prefix(path)
    try:
        dir_fd = os.open(prefix, os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY)
    except OSError as e:                                        # prefix itself is a symlink/non-dir
        raise UnsafePath(f"unsafe prefix {prefix}: {e}")
    try:
        for name in path.relative_to(prefix).parts:
            child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY, dir_fd=dir_fd)
            os.close(dir_fd); dir_fd = child
        return dir_fd
    except FileNotFoundError:
        os.close(dir_fd); raise
    except OSError as e:                                       # ELOOP (symlink) / ENOTDIR
        os.close(dir_fd); raise UnsafePath(f"unsafe path {path}: {e}")

def _read_fd(fd):
    chunks = []
    while True:
        b = os.read(fd, 65536)
        if not b:
            return b"".join(chunks)
        chunks.append(b)

def open_owned_regular(path, flags, mode=0o600):
    """Open a REGULAR file relative to its validated parent dir fd. `O_NONBLOCK` so a FIFO/device
    can't **block** the open before we can `fstat`+reject it (Round-6 #4); `O_NOFOLLOW` so it can't
    be a symlink; reject non-regular; repair mode on create. Caller closes. (Regular files ignore
    `O_NONBLOCK` for I/O.)"""
    path = Path(path)
    dfd = open_owned_dir(path.parent)                         # FULLY validated parent (every component)
    try:
        fd = os.open(path.name, flags | os.O_NOFOLLOW | os.O_NONBLOCK, mode, dir_fd=dfd)
    finally:
        os.close(dfd)
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode):                          # reject FIFO/device
        os.close(fd); raise UnsafePath(f"not a regular file: {path}")
    if (flags & os.O_CREAT) and stat.S_IMODE(st.st_mode) != mode:
        os.fchmod(fd, mode)                                   # repair a pre-existing permissive file
    return fd

def secure_open_append(path, mode=0o600) -> int:
    return open_owned_regular(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, mode)

def read_owned_segments_detailed(directory, suffix=".jsonl"):
    """Enumerate + read files under an owned dir via a validated dir fd, never following a
    symlinked component or entry (Round-4 #3). Returns `(segments, rejected)`:
      segments -- exactly what `read_owned_segments` returns: [(name, data_bytes, size, mtime)]
      rejected -- [(name, reason)] for every suffix-matching entry that was refused, `reason` one
        of: 'symlink' (ELOOP via O_NOFOLLOW), 'not-regular' (FIFO/dir/device), 'denied' (EACCES),
        'gone' (removed between scandir and open, or a TOCTOU failure mid-scan after open), or
        'read-failed' (any other open/fstat/read failure). If the DIRECTORY itself can't be
        validated/listed, `segments` is still `[]` (unchanged contract) but `rejected` is
        `[('', 'dir-unreadable')]` so a caller can tell "no entries" apart from "couldn't list"
        (Ruling 38 / Codex R2-1: mirrors menubar/activity/paths.js's readOwnedSegmentsDetailed).

    `read_owned_segments` below is a thin wrapper returning just the `segments` half, preserving
    its existing signature/behavior for its many callers unchanged."""
    try:
        dfd = open_owned_dir(directory)
    except (UnsafePath, FileNotFoundError):
        return [], [("", "dir-unreadable")]
    segments = []
    rejected = []
    try:
        try:
            entries = list(os.scandir(dfd))
        except OSError:
            return [], [("", "dir-unreadable")]
        for entry in entries:
            if not entry.name.endswith(suffix):
                continue
            try:
                # open FIRST (O_NOFOLLOW rejects a symlink; O_NONBLOCK means opening a FIFO
                # can't block), THEN fstat the OPENED fd -- an lstat done before the open would
                # leave a TOCTOU window where the entry could be swapped between the check and
                # the open (Codex gate round 1, finding 2; mirrors open_owned_regular).
                ffd = os.open(entry.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dfd)
            except OSError as e:
                if e.errno == errno.ELOOP:
                    rejected.append((entry.name, "symlink"))
                elif e.errno == errno.EACCES:
                    rejected.append((entry.name, "denied"))
                elif e.errno == errno.ENOENT:
                    rejected.append((entry.name, "gone"))
                else:
                    rejected.append((entry.name, "read-failed"))
                continue
            try:
                st = os.fstat(ffd)
                if not stat.S_ISREG(st.st_mode):                  # FIFO / directory / device
                    rejected.append((entry.name, "not-regular"))
                    continue
                segments.append((entry.name, _read_fd(ffd), st.st_size, st.st_mtime))
            except OSError:                                       # TOCTOU: entry deleted/swapped mid-scan
                rejected.append((entry.name, "read-failed"))
            finally:
                os.close(ffd)
    finally:
        os.close(dfd)
    return segments, rejected

def read_owned_segments(directory, suffix=".jsonl"):
    """Thin wrapper over `read_owned_segments_detailed` (Ruling 38): see there for the single
    implementation. Returns [(name, data_bytes, size, mtime)]; [] if missing."""
    return read_owned_segments_detailed(directory, suffix)[0]

def stat_owned_segments_detailed(directory, suffix=".jsonl"):
    """METADATA-ONLY enumeration (Codex gate round 1, finding 7 / Ruling 40): sizes are taken
    WITHOUT opening any entry -- a descriptor-relative lstat (`os.stat(name, dir_fd=dfd,
    follow_symlinks=False)`) on each suffix-matching entry of the validated dir. Returns
    `(entries, uncertain)`:
      entries -- exactly what `stat_owned_segments` returns: [(name, size)].
      uncertain -- Ruling 45 (Codex R4 B1, BLOCKER): the DIRECTORY-level counterpart of Ruling
        40's per-entry fix. `entries` alone can't tell "genuinely nothing here" apart from
        "couldn't measure what's actually there", and the prior single-return shape silently
        treated both as `[]` -- so an activity dir that exists but can't be traversed (chmod 000,
        ELOOP, a non-directory squatting on the name) counted as 0 bytes in `quota._charge` while
        its segments persisted on disk (Codex repro: 16 x 4 MiB settled, chmod 000 one dir ->
        charge drops to 60 MiB -> a reservation is wrongly admitted -> restore -> 67,170,304
        bytes, over the ceiling). `uncertain` is:
          False + entries=[] -- the directory does NOT exist (FileNotFoundError on a path
            component = proven gone; nothing on disk to count).
          False -- the directory WAS listed and every suffix-matching entry was either sized or
            itself proven gone (FileNotFoundError racing away mid-scan).
          True -- the directory exists but its bytes could not be fully measured: `open_owned_dir`
            refused it (UnsafePath: EACCES/ELOOP/ENOTDIR/symlink), `os.scandir` failed, or an
            entry's lstat failed with anything OTHER than FileNotFoundError (ENOENT = raced away,
            proven gone; any other errno leaves that entry's existence/size unproven). `entries`
            still carries whatever WAS provable in this case -- never discarded.

    Ruling 38 / Codex R2-1 naming convention (mirrors `read_owned_segments_detailed` above):
    `stat_owned_segments` below is the `entries`-only wrapper -- single implementation, existing
    signature/behavior for its many callers unchanged. Callers that must never undercount a
    settled activity's byte liability (quota's `_charge`/`_accounting_uncertain`) use this
    detailed form directly; symlinks and other non-regular entries (never ours) are still simply
    skipped, not uncertain -- their absence IS provable (a lstat that resolves to non-regular is
    not "unmeasured", it's "not a segment")."""
    try:
        dfd = open_owned_dir(directory)
    except FileNotFoundError:
        return [], False
    except (UnsafePath, OSError):
        return [], True
    out = []
    uncertain = False
    try:
        try:
            entries = list(os.scandir(dfd))
        except OSError:
            return [], True
        for entry in entries:
            if not entry.name.endswith(suffix):
                continue
            try:
                st = os.stat(entry.name, dir_fd=dfd, follow_symlinks=False)
            except FileNotFoundError:
                continue                                          # raced away -- proven gone
            except OSError:
                uncertain = True; continue                        # refused -- bytes unproven
            if not stat.S_ISREG(st.st_mode):
                continue                                           # symlink / FIFO / dir / device
            out.append((entry.name, st.st_size))
    finally:
        os.close(dfd)
    return out, uncertain

def stat_owned_segments(directory, suffix=".jsonl"):
    """Thin `entries`-only wrapper over `stat_owned_segments_detailed` (Ruling 45): see there for
    the single implementation. Returns [(name, size)]; [] if missing or unmeasurable -- UNCHANGED
    behavior for existing callers that don't need to distinguish "gone" from "uncertain"."""
    return stat_owned_segments_detailed(directory, suffix)[0]

def stat_owned_segments_dir_fd_detailed(dfd, name, suffix=".jsonl"):
    """Ruling 67 (Round-8 follow-up, "G8b"): fd-bound counterpart to `stat_owned_segments_detailed`
    for a LOCKED per-activity byte measurement. Opens the activity subdirectory `name` relative to
    an ALREADY-VALIDATED root directory fd `dfd` (a locked `quota.LockCtx.afd`) with
    `O_NOFOLLOW|O_DIRECTORY` -- so a symlink squatting on `name` is rejected, not resolved through
    -- then runs the SAME metadata-only per-entry `lstat` logic as `stat_owned_segments_detailed`
    on that opened subdir fd. A locked accounting pass therefore never re-resolves EITHER the
    activity ROOT or the activity subdirectory by path (closing the gap `_gather_accounting` left:
    binding `quota/`'s identity to the lock, per Ruling 64, did nothing to stop the ROOT
    enumeration and per-activity stats from still re-resolving `activity/` and each `<aid>/` by
    PATH -- a root-level rename/swap landing after the lock was validated read as a plausible, but
    wrong or wrongly-empty, listing).

    Returns `(entries, uncertain)` -- same shape/semantics as `stat_owned_segments_detailed`:
      entries -- [(name, size)].
      uncertain -- `name` couldn't be opened as a real, non-symlink directory relative to `dfd`
        (ENOENT here is PROVEN gone -- `False` + `[]`, exactly like the path-based version's
        `FileNotFoundError` branch; any OTHER open failure -- ELOOP/EACCES/a non-directory
        squatting on the name -- is uncertain), OR the opened subdirectory itself couldn't be
        scanned, OR any suffix-matching entry's `lstat` failed with anything other than
        `FileNotFoundError`.

    Ruling 69 (G10-Py, Codex Round 10 BLOCKER): `name` MUST be a valid activity id (`ids.valid_
    activity_id`) -- raises `UnsafePath` otherwise, mirroring `activity_dir()`'s own guard for the
    path-based form. Pre-fix, this opened WHATEVER real directory sat at `name` relative to `dfd`
    with no validation at all, so a non-UUID directory (e.g. `activity/junk/`) fed straight into a
    LOCKED byte measurement as if it were a real activity."""
    if not ids.valid_activity_id(name):
        raise UnsafePath(f"invalid activity_id: {name!r}")
    try:
        sub = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY, dir_fd=dfd)
    except FileNotFoundError:
        return [], False
    except OSError:
        return [], True
    out = []
    uncertain = False
    try:
        try:
            entries = list(os.scandir(sub))
        except OSError:
            return [], True
        for entry in entries:
            if not entry.name.endswith(suffix):
                continue
            try:
                st = os.stat(entry.name, dir_fd=sub, follow_symlinks=False)
            except FileNotFoundError:
                continue                                          # raced away -- proven gone
            except OSError:
                uncertain = True; continue                        # refused -- bytes unproven
            if not stat.S_ISREG(st.st_mode):
                continue                                           # symlink / FIFO / dir / device
            out.append((entry.name, st.st_size))
    finally:
        os.close(sub)
    return out, uncertain

def read_owned_segments_dir_fd_detailed(dfd, name, suffix=".jsonl"):
    """Ruling 68 (G9-Py, Codex Round 9 BLOCKER): fd-bound counterpart to `read_owned_segments_
    detailed` for a LOCKED per-activity CLASSIFICATION read. Opens the activity subdirectory
    `name` relative to an ALREADY-VALIDATED root directory fd `dfd` (a locked `quota.LockCtx.afd`)
    with `O_NOFOLLOW|O_DIRECTORY` -- so a symlink squatting on `name` is rejected, not resolved
    through -- then runs the SAME enumerate+read segment logic as `read_owned_segments_detailed`
    on that opened subdirectory fd. `scan.scan_activity_dir_fd` (in turn `quota._classify`, when
    called with a live `ctx`) uses this so a LOCKED classification decision never re-resolves the
    activity subdirectory by PATH -- closing the ABA gap a path-based re-scan left open: enumerate
    (`_prune_locked`/`_retain_locked`) and delete (`unlink_owned_tree_dir_fd`) were already bound
    to `ctx.afd` (Ruling 67), but `_classify` still called `paths.activity_dir(home, aid)` and
    walked it FRESH from the shared `Library/Logs/repo-radar` prefix every time -- a resolution
    completely independent of `ctx.afd`'s already-open, lock-acquisition-time binding. A same-ID
    activity swapped in for the duration of that independent walk (then swapped back before the
    deletion decision) could make classification see content that was never the SAME directory
    the lock's own enumeration/deletion ever actually touched (Codex repro: a temporary succeeded-
    terminal activity fooled classify into 'routine' while the real, restored, start-only activity
    -- still running -- was the one actually deleted). Node cannot mirror this (no fd-relative
    directory reads in Node's `fs`); on the Python side this is defense-in-depth per the spec's
    §7 threat-model scope ruling (2026-08-26, Phase-3 gate Round 9) -- keeps Python's own
    never-prune-running guarantee fully descriptor-bound even though the underlying same-UID ABA
    class is outside the documented threat model.

    Returns `(segments, rejected, ident)` -- the first two exactly as `read_owned_segments_
    detailed` returns them, plus (Ruling 72, G11-Py, Codex Round 11 B2, BLOCKER) `ident`: the
    `(st_dev, st_ino)` of the subdirectory fd this call ACTUALLY opened and read through (`os.
    fstat` on that fd -- never a by-name stat), or `None` when the subdirectory couldn't be opened
    at all. `scan.scan_activity_dir_fd` carries it into `Scan.ident` so `quota._classify` can hand
    it to `unlink_owned_tree_dir_fd(dfd, name, expect_ident)`, binding the classified identity
    THROUGH deletion (see there for the persistent same-UUID-replacement repro this closes).
      segments -- [(name, data_bytes, size, mtime)].
      rejected -- [(name, reason)] per suffix-matching entry ('symlink'/'not-regular'/'denied'/
        'gone'/'read-failed'), OR `[('', 'dir-unreadable')]` if the SUBDIRECTORY itself couldn't be
        opened/listed relative to `dfd` (mirrors the path-based form folding both 'never existed'
        and 'unsafe to open' into the same dir-unreadable signal; `scan.scan_activity_dir_fd`'s own
        provably-gone companion check distinguishes the two independently, exactly like `scan.
        scan_activity`'s `_dir_provably_gone` does for the path-based form).

    Ruling 69 (G10-Py, Codex Round 10 BLOCKER): `name` MUST be a valid activity id (`ids.valid_
    activity_id`) -- raises `UnsafePath` otherwise, mirroring `activity_dir()`'s own guard. Pre-fix,
    this read WHATEVER real directory sat at `name` relative to `dfd` -- and, driven by `scan.
    scan_activity_dir_fd`, fed the result straight into a LOCKED classification decision -- with no
    validation that `name` was ever a real activity id at all, letting a non-UUID directory (e.g.
    `activity/junk/`) planted with a fabricated `succeeded` terminal get classified 'routine' and
    then deleted by `_prune_locked`/`_retain_locked` (Codex repro)."""
    if not ids.valid_activity_id(name):
        raise UnsafePath(f"invalid activity_id: {name!r}")
    try:
        sfd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY, dir_fd=dfd)
    except OSError:
        return [], [("", "dir-unreadable")], None
    segments = []
    rejected = []
    try:
        try:
            dst = os.fstat(sfd)                                   # Ruling 72: identity of THIS dir
            ident = (dst.st_dev, dst.st_ino)
            entries = list(os.scandir(sfd))
        except OSError:
            return [], [("", "dir-unreadable")], None
        for entry in entries:
            if not entry.name.endswith(suffix):
                continue
            try:
                ffd = os.open(entry.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=sfd)
            except OSError as e:
                if e.errno == errno.ELOOP:
                    rejected.append((entry.name, "symlink"))
                elif e.errno == errno.EACCES:
                    rejected.append((entry.name, "denied"))
                elif e.errno == errno.ENOENT:
                    rejected.append((entry.name, "gone"))
                else:
                    rejected.append((entry.name, "read-failed"))
                continue
            try:
                st = os.fstat(ffd)
                if not stat.S_ISREG(st.st_mode):
                    rejected.append((entry.name, "not-regular"))
                    continue
                segments.append((entry.name, _read_fd(ffd), st.st_size, st.st_mtime))
            except OSError:
                rejected.append((entry.name, "read-failed"))
            finally:
                os.close(ffd)
    finally:
        os.close(sfd)
    return segments, rejected, ident

def fsync_owned_segments(directory, suffix=".jsonl"):
    """Durabilize every safe regular segment under an owned dir, descriptor-relative, WITHOUT
    reading content (Codex gate round 1, finding 1): before reconcile settles an activity whose
    segment scan shows a terminal present, the terminal-bearing segment(s) must actually be made
    durable first -- the write() that produced the terminal LINE can succeed while its fsync
    fails, in which case the line is readable (so `_has_terminal` sees it) but not yet durable.
    Returns True iff EVERY segment fsync'd cleanly; False (fail-closed) on a missing dir or ANY
    fsync failure, so the caller must not treat durability as achieved and must NOT settle."""
    try:
        dfd = open_owned_dir(directory)
    except (UnsafePath, FileNotFoundError):
        return False
    ok = True
    try:
        for entry in os.scandir(dfd):
            if not entry.name.endswith(suffix):
                continue
            try:
                ffd = os.open(entry.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dfd)
            except OSError:
                ok = False; continue                      # symlink / gone / denied -> not durable
            try:
                st = os.fstat(ffd)
                if not stat.S_ISREG(st.st_mode):
                    ok = False; continue                   # FIFO / directory -- not a real segment
                os.fsync(ffd)
            except OSError:
                ok = False
            finally:
                os.close(ffd)
    finally:
        os.close(dfd)
    return ok

def read_owned_file(path):
    """Read one owned file's bytes via the nonblocking regular-file helper (e.g. a ledger entry)."""
    fd = open_owned_regular(path, os.O_RDONLY)                # O_NONBLOCK + S_ISREG (Round-6 #4)
    try:
        return _read_fd(fd)
    finally:
        os.close(fd)

# --- Ruling 60 (Codex R7-1, BLOCKER): fd-bound counterparts for a LOCKED ledger decision -------
#
# `quota._quota_lock` validates/opens `quota/` BEFORE taking `flock`, then (as of Ruling 60) keeps
# that fd alive for the lock's whole lifetime (see `quota.LockCtx`). Everything below operates
# descriptor-relative to an ALREADY-VALIDATED directory fd and never re-resolves the directory by
# path -- so a rename/swap of `quota/` AFTER the lock was acquired can never be misread as "the
# ledger is empty" the way a fresh path-based `ENOENT` would be. There is no "gone" case here: the
# directory's existence was already proven when the fd was opened, so ANY failure from here on
# means "could not be listed/read/written right now", never "never existed" -- these primitives
# report that fail-closed (`uncertain=True` / a raised exception), they never silently fold into
# empty.

def list_owned_dir_fd_detailed(dfd, suffix=None):
    """(entries, uncertain) via `os.scandir` on an ALREADY-VALIDATED directory fd -- the fd-bound
    counterpart to `list_owned_entries_detailed` (Ruling 60). `entries` -- unfiltered names
    (suffix-filtered if given), exactly like `list_owned_entries`. `uncertain` -- True on ANY
    `OSError` from `scandir` on this fd; there is no "gone" case (see module note above)."""
    try:
        entries = list(os.scandir(dfd))
    except OSError:
        return [], True
    return [e.name for e in entries if suffix is None or e.name.endswith(suffix)], False

def read_owned_dir_fd_regular(dfd, name):
    """Read a REGULAR file by `name` relative to an ALREADY-VALIDATED directory fd (Ruling 60) --
    the fd-bound counterpart to `read_owned_file`, used for a locked ledger-entry read. `O_NOFOLLOW`
    rejects a symlinked entry; `O_NONBLOCK` means opening a FIFO can't block. Raises `OSError`/
    `UnsafePath` on any failure (missing, symlink, non-regular, read failure) -- the caller
    (`quota._read_entry_fd`) treats any exception as CORRUPT, matching `_read_entry`'s existing
    fail-closed contract."""
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dfd)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise UnsafePath(f"not a regular file: {name}")
        return _read_fd(fd)
    finally:
        os.close(fd)

def write_owned_dir_fd_regular_atomic(dfd, name, tmp_name, blob, mode=0o600):
    """Durable atomic write relative to an ALREADY-VALIDATED directory fd (Ruling 60) -- the
    fd-bound counterpart to `quota._write_entry`'s temp-file + fsync + atomic-rename durability
    contract (full-write loop, fsync, atomic rename with both sides on `dfd`, directory fsync,
    temp cleanup on any failure), so a locked ledger write never re-resolves `quota/` by path
    either. Raises on durability failure; caller (`quota._write_entry_fd`) lets that propagate to
    the caller's own `except (OSError, paths.UnsafePath)` fail-closed handling."""
    fd = os.open(tmp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=dfd)
    try:
        view = memoryview(blob)
        while view:
            n = os.write(fd, view)
            if n <= 0:
                raise OSError("zero-byte write")           # no infinite loop (mirrors Round-6 #5)
            view = view[n:]
        os.fsync(fd)
    except BaseException:
        os.close(fd)
        try:
            os.unlink(tmp_name, dir_fd=dfd)
        except OSError:
            pass
        raise
    else:
        os.close(fd)
    try:
        os.replace(tmp_name, name, src_dir_fd=dfd, dst_dir_fd=dfd)
    except BaseException:
        try:
            os.unlink(tmp_name, dir_fd=dfd)
        except OSError:
            pass
        raise
    os.fsync(dfd)                                          # durable rename (dir entry)

def list_owned_entries_detailed(directory, suffix=None):
    """(entries, uncertain) companion to `list_owned_entries` (Ruling 54 / Codex R6-1, BLOCKER):
    the plain `list_owned_entries` collapsed EVERY listing failure -- a directory that provably
    never existed yet AND a directory that exists but couldn't be validated/opened/listed (a
    transient EIO, EACCES, ELOOP, a non-directory squatting on the name) -- to the SAME `[]`.
    Quota's ledger scan (`_ledger_entries`) fed straight off that `[]`, so a transient failure
    enumerating `quota/` read as "no ledgers at all": every live reservation's liability vanished
    from the charge for that pass, exactly the class of bug Ruling 40/45/49 already fixed for
    segment reads and activity-directory/root enumeration, just one layer further out (the
    LEDGER directory itself, not an activity directory).

    Returns `(entries, uncertain)`:
      entries -- exactly what `list_owned_entries` returns: unfiltered entry NAMES (a
        symlink/FIFO/dir name is still returned as-is; `suffix`, if given, filters by name suffix
        only -- no fs access, so it can't itself hide an unsafe entry).
      uncertain -- False + entries=[] -- `directory` does NOT exist (`FileNotFoundError`): a
          proven state (e.g. no admission has ever happened yet), not a failure.
        False -- `directory` was validated, opened, AND listed successfully.
        True -- `directory` exists but couldn't be fully validated/opened/listed this pass
          (`open_owned_dir` refused it -- `UnsafePath`/other `OSError` -- or `os.scandir` itself
          failed): the true entry set is UNPROVEN, never treated as "empty"."""
    try:
        dfd = open_owned_dir(directory)
    except FileNotFoundError:
        return [], False                # directory provably never existed -- nothing here yet
    except (UnsafePath, OSError):
        return [], True                 # exists but unsafe/inaccessible -- entry set unproven
    try:
        try:
            entries = list(os.scandir(dfd))
        except OSError:
            return [], True             # opened fine but couldn't be listed -- unproven
        return [e.name for e in entries if suffix is None or e.name.endswith(suffix)], False
    finally:
        os.close(dfd)

def list_owned_entries(directory, suffix=None):
    """Thin `[0]` wrapper over `list_owned_entries_detailed` (Ruling 54): unchanged signature/
    behavior for existing callers that don't need to distinguish "gone" from "uncertain"."""
    return list_owned_entries_detailed(directory, suffix)[0]

def list_owned_subdirs_detailed(base):
    """Immediate real subdir NAMES of an owned base via a validated dir fd (no symlink follow),
    now with a `rejected`/`uncertain` companion (Ruling 49 / Codex R5-1, BLOCKER): a UUID-shaped
    entry whose `lstat` fails with a non-ENOENT error (EIO, EACCES, ...) -- or that lstat's fine
    but ISN'T a plain directory (a symlink, or a file/FIFO squatting on the name) -- used to be
    silently dropped out of the enumeration entirely. Quota's byte accounting only ever reaches
    `stat_owned_segments_detailed` for names THIS function returns, so a hidden activity directory
    vanished from the charge completely rather than merely being mis-measured (Codex repro:
    injected EIO on one of 16 x 4 MiB settled dirs -> charge drops to 60 MiB, `uncertain=False`,
    a reservation is wrongly admitted, restore -> 67,170,304 bytes on disk, over the ceiling).

    Returns `(subdirs, rejected, uncertain)`:
      subdirs -- exactly what `list_owned_subdirs` returns: real directory names (no symlinks).
      rejected -- [(name, reason)] for every VALID-ACTIVITY-ID-shaped entry that ISN'T a plain,
        lstat-able directory: 'symlink' (lstat resolves to a symlink), 'not-directory' (a regular
        file/FIFO/etc. squatting on the name), 'denied' (EACCES), 'gone' (ENOENT -- raced away
        mid-scan, proven gone), or 'stat-failed' (any other lstat OSError, e.g. EIO). A
        non-UUID-shaped name (e.g. `quota`, stray junk) is never classified here -- callers
        already filter those out by name, and they can't hide a real activity's bytes.
      uncertain -- True iff the base itself couldn't be validated/opened/listed (an unsafe or
        missing-but-not-provably-absent base), OR any valid-activity-id entry was rejected for a
        reason OTHER than 'gone' (a proven-ENOENT race is not uncertain; anything else leaves
        that activity's existence/type unproven and must not be treated as "nothing there").

    `list_owned_subdirs` below is the unchanged `[0]` wrapper, preserving its existing signature/
    behavior for callers that don't need to distinguish "gone" from "uncertain". Every quota
    enumeration that feeds byte accounting (`_committed_detailed`, `_accounting_snapshot`) uses
    this detailed form directly so root-level uncertainty folds into the same snapshot as
    per-activity uncertainty (Ruling 50).

    Ruling 71 (G11-Py, Codex Round 11 B1, BLOCKER): returns a FOURTH element, `foreign` --
    `[(name, on_disk, uncertain)]`, one per non-UUID root entry other than `quota` -- measured
    conservatively via `_measure_foreign_entry` (a real directory of regular files is summed; a
    regular file at the root is its lstat size; ANYTHING else -- a symlink, a FIFO, a directory
    holding a subdirectory/symlink, an unopenable/unlistable/unstat-able entry -- is `uncertain`).
    Foreign entries are NEVER returned in `rejected`; a foreign DIRECTORY still appears in
    `subdirs` here exactly as it always has for this path form (every real directory, `quota`
    included -- callers filter by `ids.valid_activity_id`, and every fd-bound mutation/read
    primitive raises `UnsafePath` on a non-UUID name, so a foreign entry can never be
    classified/pruned/reconciled/read as an activity -- every Ruling 69 guard stands). The
    fd-bound `list_owned_subdirs_dir_fd_detailed` sibling filters `subdirs` to valid ids (Ruling
    69) and reports the same `foreign` list. Foreign entries do NOT touch the activity-level
    `uncertain` flag either: their uncertainty rides in their own
    tuple, which `quota._gather_accounting` folds into the snapshot (`measured += Σ on_disk`;
    `uncertain |= any foreign uncertain`). Pre-fix, a non-UUID name was `continue`d before ANY
    measurement, so 64 MiB in `activity/junk/` charged 0 bytes with `uncertain=False` and a fresh
    activity was admitted on top of it -- violating spec §7's Σ-of-actual-bytes contract and its
    persistent-path-replacement coverage (`<aid>/` renamed to `junk/` hid its committed bytes).
    Returns `(subdirs, rejected, uncertain, foreign)`."""
    try:
        dfd = open_owned_dir(base)
    except FileNotFoundError:
        return [], [], False, []          # base provably never existed -- nothing here to hide
    except (UnsafePath, OSError):
        return [], [], True, []           # base exists but is unsafe/inaccessible -- uncertain
    try:
        return _classify_root_entries(dfd)
    finally:
        os.close(dfd)

def _measure_foreign_entry(dfd, name, st):
    """Ruling 71 (G11-Py, Codex Round 11 B1, BLOCKER): conservative byte measurement of ONE
    foreign root entry `name` (a non-UUID name other than `quota`) whose root-level `lstat` is
    `st`, relative to the already-open root dir fd `dfd`. Returns `(on_disk, uncertain)`:
      regular file -> `(st_size, False)`.
      directory -> opened `O_RDONLY|O_NOFOLLOW|O_DIRECTORY` relative to `dfd` and every entry
        `lstat`'d relative to THAT fd: regular files are summed; any other entry (a subdirectory,
        symlink, FIFO, device -- bytes this pass cannot see) makes it uncertain; a failed open,
        scandir or per-entry lstat makes it uncertain (whatever DID stat is still counted --
        partial measurement is real liability, never discarded, mirroring Ruling 62).
      anything else (symlink, FIFO, ...) -> `(0, True)`.
    Never recurses, never follows a symlink, never reads content, never deletes: measured, not
    managed.

    Ruling 73 (Codex Round 12, BLOCKER; parity with Node's `_measureForeign`): the directory
    measurement is IDENTITY-BOUND to the enumeration that produced `st`:
      (a) after the open, `os.fstat(sub)`'s `(st_dev, st_ino)` must equal `st`'s -- a mismatch
          means the name was re-pointed between the root lstat and this open (Codex's sequence:
          `junk/` -> `junk.old/`, fresh empty `junk/`), so the entry is `(0, True)` and the
          replacement is NOT scanned (what was enumerated is unknown; Ruling 74 floors the charge);
      (b) after the scan, `os.lstat(name, dir_fd=dfd)` must still carry that identity -- a
          mismatch or an OSError makes the entry uncertain (bytes already counted are kept --
          partial measurement is real liability, never discarded, mirroring Ruling 62).
    Pre-fix the open was unchecked, so the swap measured the empty replacement as a CERTAIN
    0 bytes and `admit()` proceeded with 64 MiB hidden under `junk.old/`."""
    if stat.S_ISREG(st.st_mode):
        return st.st_size, False
    if not stat.S_ISDIR(st.st_mode):
        return 0, True
    try:
        sub = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY, dir_fd=dfd)
    except OSError:
        return 0, True
    ident = (st.st_dev, st.st_ino)
    total = 0
    uncertain = False
    try:
        try:
            opened = os.fstat(sub)
        except OSError:
            return 0, True
        if (opened.st_dev, opened.st_ino) != ident:
            return 0, True                       # Ruling 73 (a): not what was enumerated -- no scan
        try:
            entries = list(os.scandir(sub))
        except OSError:
            return 0, True
        for entry in entries:
            try:
                est = os.lstat(entry.name, dir_fd=sub)
            except OSError:
                uncertain = True; continue
            if stat.S_ISREG(est.st_mode):
                total += est.st_size
            else:
                uncertain = True
        try:
            after = os.lstat(name, dir_fd=dfd)
        except OSError:
            return total, True                   # Ruling 73 (b): identity unprovable after the scan
        if not stat.S_ISDIR(after.st_mode) or (after.st_dev, after.st_ino) != ident:
            uncertain = True                     # Ruling 73 (b): swapped out mid-scan
    finally:
        os.close(sub)
    return total, uncertain

def _classify_root_entries(dfd):
    """The shared per-entry classification behind `list_owned_subdirs_detailed` (path form; its
    `subdirs` still includes EVERY real directory, `quota` too) -- see that docstring for the
    `(subdirs, rejected, uncertain, foreign)` contract. `list_owned_subdirs_dir_fd_detailed` is the
    fd-bound sibling with its own Ruling 69 valid-id filter on `subdirs`; the two are kept as
    separate loops on purpose so each stays a faithful mirror of its documented history."""
    subdirs = []
    rejected = []
    foreign = []
    uncertain = False
    try:
        entries = list(os.scandir(dfd))
    except OSError:
        return [], [], True, []           # base opened fine but couldn't be listed -- uncertain
    for e in entries:
        is_activity_name = ids.valid_activity_id(e.name)
        try:
            st = os.lstat(e.name, dir_fd=dfd)
        except OSError as err:
            if not is_activity_name:
                if e.name != "quota":
                    foreign.append((e.name, 0, True))   # Ruling 71: unstat-able foreign -> uncertain
                continue
            if err.errno == errno.ENOENT:
                rejected.append((e.name, "gone"))          # raced away -- proven gone
            elif err.errno == errno.EACCES:
                rejected.append((e.name, "denied")); uncertain = True
            else:
                rejected.append((e.name, "stat-failed")); uncertain = True
            continue
        if stat.S_ISDIR(st.st_mode):
            subdirs.append(e.name)
            if not is_activity_name and e.name != "quota":
                on_disk, f_uncertain = _measure_foreign_entry(dfd, e.name, st)   # Ruling 71
                foreign.append((e.name, on_disk, f_uncertain))
        elif is_activity_name:
            if stat.S_ISLNK(st.st_mode):
                rejected.append((e.name, "symlink"))
            else:
                rejected.append((e.name, "not-directory"))
            uncertain = True
        elif e.name != "quota":
            on_disk, f_uncertain = _measure_foreign_entry(dfd, e.name, st)       # Ruling 71
            foreign.append((e.name, on_disk, f_uncertain))
    return subdirs, rejected, uncertain, foreign

def list_owned_subdirs(base):
    """Thin `subdirs`-only wrapper over `list_owned_subdirs_detailed` (Ruling 49): unchanged
    behavior for existing callers that don't need to distinguish "gone" from "uncertain"."""
    return list_owned_subdirs_detailed(base)[0]

def list_owned_subdirs_dir_fd_detailed(dfd):
    """Ruling 67 (Round-8 follow-up, "G8b"): fd-bound counterpart to `list_owned_subdirs_detailed`
    for a LOCKED root enumeration. Same per-entry `lstat`/UUID/symlink classification, but
    scanning an ALREADY-VALIDATED root directory fd (a locked `quota.LockCtx.afd`) instead of
    re-resolving the activity ROOT by path. Used by every locked caller (`quota._gather_
    accounting`, `quota._prune_locked`, `quota._retain_locked`) so the candidate/accounting
    enumeration itself stays bound to the SAME canonical directory the lock validated -- a
    root-level rename/swap landing after acquisition can no longer surface as a plausible-looking
    (or wrongly-empty) path-based listing; see `quota._verify_canonical`'s companion root-identity
    check, which every caller checks BEFORE trusting this.

    Returns `(subdirs, rejected, uncertain, foreign)` -- same shape/semantics as `list_owned_
    subdirs_detailed`, except there is no "gone" case for the BASE itself (mirrors every other fd-bound
    primitive in the Ruling-60 section above): `dfd` is assumed already open/validated on entry --
    callers validate it once, at lock acquisition, and re-verify its continued canonical identity
    via `quota._verify_canonical` around each use, not here.

    Ruling 69 (G10-Py, Codex Round 10 BLOCKER): `subdirs` now contains ONLY valid-activity-id
    (UUID-shaped) names -- a real directory whose name is NOT a valid activity id (e.g. `quota`,
    or stray junk like `activity/junk/`) is silently ignored: neither a subdir nor a rejected entry,
    exactly like a non-directory junk NAME already was for `list_owned_subdirs_detailed`. Pre-fix,
    ANY real directory (valid id or not) was unconditionally appended to `subdirs` -- every locked
    caller (`_gather_accounting`, `_prune_locked`, `_retain_locked`) then fed that name straight
    into an fd-relative stat/read/unlink with no id validation of its own (see `stat_owned_segments_
    dir_fd_detailed`/`read_owned_segments_dir_fd_detailed`/`unlink_owned_tree_dir_fd`'s own Ruling
    69 guards), so a non-UUID directory holding a fabricated `succeeded` terminal was classified and
    then DELETED by `_prune_locked` (Codex Round 10 repro: `activity/junk/` survived only because
    `quota` happened to be skipped by an explicit name check at each call site -- ANY other non-UUID
    name sailed straight through). Filtering here closes the gap at its single shared source instead
    of relying on every call site to separately guard against it.

    Ruling 71 (G11-Py, Codex Round 11 B1, BLOCKER): "silently ignored" above now means "never a
    subdir, never rejected, never a candidate" -- but NOT "never measured". Every non-UUID entry
    other than `quota` is returned in the FOURTH element, `foreign` (`[(name, on_disk,
    uncertain)]`), measured conservatively via `_measure_foreign_entry` exactly like the path form
    (see `list_owned_subdirs_detailed`'s Ruling 71 note for the full contract and the Codex repro:
    64 MiB in `activity/junk/` charged 0 and a fresh activity was admitted). Foreign entries never
    touch the activity-level `uncertain` flag; their own uncertainty rides in their tuple.
    Returns `(subdirs, rejected, uncertain, foreign)`."""
    subdirs = []
    rejected = []
    foreign = []
    uncertain = False
    try:
        entries = list(os.scandir(dfd))
    except OSError:
        return [], [], True, []
    for e in entries:
        is_activity_name = ids.valid_activity_id(e.name)
        try:
            st = os.lstat(e.name, dir_fd=dfd)
        except OSError as err:
            if not is_activity_name:
                if e.name != "quota":
                    foreign.append((e.name, 0, True))   # Ruling 71: unstat-able foreign -> uncertain
                continue
            if err.errno == errno.ENOENT:
                rejected.append((e.name, "gone"))          # raced away -- proven gone
            elif err.errno == errno.EACCES:
                rejected.append((e.name, "denied")); uncertain = True
            else:
                rejected.append((e.name, "stat-failed")); uncertain = True
            continue
        if not is_activity_name:
            if e.name != "quota":                          # Ruling 71: measured, never managed
                on_disk, f_uncertain = _measure_foreign_entry(dfd, e.name, st)
                foreign.append((e.name, on_disk, f_uncertain))
            continue                   # non-UUID name (e.g. "quota", stray junk): not a candidate
        if stat.S_ISDIR(st.st_mode):
            subdirs.append(e.name)
        else:
            if stat.S_ISLNK(st.st_mode):
                rejected.append((e.name, "symlink"))
            else:
                rejected.append((e.name, "not-directory"))
            uncertain = True
    return subdirs, rejected, uncertain, foreign

def list_owned_subdirs_dir_fd(dfd):
    """Thin `subdirs`-only wrapper over `list_owned_subdirs_dir_fd_detailed` (Ruling 67): mirrors
    `list_owned_subdirs`'s existing wrapper pattern for the fd-bound counterpart."""
    return list_owned_subdirs_dir_fd_detailed(dfd)[0]

def unlink_owned_tree(activity_dir):
    """Delete every entry in an owned activity dir, then rmdir it — all relative to validated dir
    fds, so deletion can NEVER escape the Activity tree (Round-4 #3). Returns bytes freed."""
    try:
        dfd = open_owned_dir(activity_dir)
    except (UnsafePath, FileNotFoundError):
        return 0
    freed = 0
    try:
        for entry in os.scandir(dfd):
            try:
                freed += os.lstat(entry.name, dir_fd=dfd).st_size
            except OSError:
                pass
            try:
                os.unlink(entry.name, dir_fd=dfd)            # relative unlink -> cannot escape
            except OSError:
                pass
    finally:
        os.close(dfd)
    parent, name = Path(activity_dir).parent, Path(activity_dir).name
    try:
        pfd = open_owned_dir(parent)
        try:
            os.rmdir(name, dir_fd=pfd)
        except OSError:
            pass
        finally:
            os.close(pfd)
    except (UnsafePath, FileNotFoundError):
        pass
    return freed

def unlink_owned_tree_dir_fd(dfd, name, expect_ident):
    """Ruling 67 (Round-8 follow-up, "G8b"): fd-bound counterpart to `unlink_owned_tree` for a
    LOCKED prune/retain deletion. Deletes activity subdirectory `name` -- every entry inside it,
    then the directory itself -- relative to an ALREADY-VALIDATED root directory fd `dfd` (a
    locked `quota.LockCtx.afd`), so a locked deletion never re-resolves the activity ROOT by path
    either (only `unlink`/`rmdir`, both relative to `dfd` or the freshly-opened subdir fd, ever
    touch the filesystem here -- deletion can never escape the Activity tree, the same guarantee
    `unlink_owned_tree` gives an unlocked caller). Best-effort like `unlink_owned_tree`: a failure
    opening `name`, or unlinking/rmdir-ing any individual entry, is swallowed, never raised --
    callers (`quota._prune_locked`/`_retain_locked`) already re-verify canonical identity via
    `quota._verify_canonical` immediately BEFORE calling this for each deletion decision, so this
    function itself does no identity checking of its own beyond `name` validity (below).

    Ruling 69 (G10-Py, Codex Round 10 BLOCKER): `name` MUST be a valid activity id -- raises
    `UnsafePath` (NOT swallowed like the best-effort failures above) BEFORE opening anything, so a
    caller can never delete an arbitrary, non-UUID directory sitting under the activity root. This
    is the last line of defense: `list_owned_subdirs_dir_fd_detailed` (Ruling 69) already filters
    candidates to valid ids, and `_prune_locked`/`_retain_locked` (Ruling 69) each add their own
    explicit guard before ever reaching this call -- this raise should be unreachable in practice,
    but a deletion primitive must never trust its caller alone for something this destructive.

    Ruling 72 (G11-Py, Codex Round 11 B2, BLOCKER): `expect_ident` -- a REQUIRED positional
    `(st_dev, st_ino)` pair, the identity of the directory the caller actually CLASSIFIED (from
    `quota._classify` -> `scan.Scan.ident` -> `read_owned_segments_dir_fd_detailed`'s `fstat` of
    the fd it read through). After opening `name`, this function `fstat`s the fd it got and, on
    ANY mismatch (including `expect_ident is None` -- "the classifier never had a directory to
    bind", which can never match anything), closes it and returns 0 having deleted NOTHING: no
    per-entry unlink, no rmdir. Callers (`_prune_locked`/`_retain_locked`) treat 0 as "skip this
    candidate". Pre-fix, this re-opened `<name>` BY NAME and deleted whatever sat there, so a
    persistent same-UUID replacement landing between classification and deletion (Codex repro:
    classify a settled `<aid>/`, rename it to `<aid>.old`, create `<aid>/sentinel`, `quota.prune
    (home, 1)`) deleted the REPLACEMENT and its sentinel while the classified original survived
    untouched -- in scope per §7 (persistent replacement, not the excluded transient ABA). The
    final by-name `rmdir` is likewise guarded by an `lstat` identity re-check immediately before
    it (an `rmdir` has no fd-bound form); the residual window between that check and the `rmdir`
    can only ever remove an EMPTY replacement directory, never any bytes."""
    if not ids.valid_activity_id(name):
        raise UnsafePath(f"invalid activity_id: {name!r}")
    try:
        sub = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY, dir_fd=dfd)
    except OSError:
        return 0
    freed = 0
    try:
        try:
            st = os.fstat(sub)
        except OSError:
            return 0
        if expect_ident is None or (st.st_dev, st.st_ino) != tuple(expect_ident):
            return 0                                          # Ruling 72: not the dir we classified
        for entry in os.scandir(sub):
            try:
                freed += os.lstat(entry.name, dir_fd=sub).st_size
            except OSError:
                pass
            try:
                os.unlink(entry.name, dir_fd=sub)             # relative unlink -> cannot escape
            except OSError:
                pass
    finally:
        os.close(sub)
    try:
        st = os.lstat(name, dir_fd=dfd)                       # Ruling 72: re-check before by-name rmdir
        if stat.S_ISDIR(st.st_mode) and (st.st_dev, st.st_ino) == tuple(expect_ident):
            os.rmdir(name, dir_fd=dfd)
    except OSError:
        pass
    return freed
