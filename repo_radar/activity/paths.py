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
    per-activity uncertainty (Ruling 50)."""
    try:
        dfd = open_owned_dir(base)
    except FileNotFoundError:
        return [], [], False              # base provably never existed -- nothing here to hide
    except (UnsafePath, OSError):
        return [], [], True               # base exists but is unsafe/inaccessible -- uncertain
    subdirs = []
    rejected = []
    uncertain = False
    try:
        try:
            entries = list(os.scandir(dfd))
        except OSError:
            return [], [], True           # base opened fine but couldn't be listed -- uncertain
        for e in entries:
            try:
                st = os.lstat(e.name, dir_fd=dfd)
            except OSError as err:
                if not ids.valid_activity_id(e.name):
                    continue               # non-UUID name: never hid a real activity's bytes
                if err.errno == errno.ENOENT:
                    rejected.append((e.name, "gone"))          # raced away -- proven gone
                elif err.errno == errno.EACCES:
                    rejected.append((e.name, "denied")); uncertain = True
                else:
                    rejected.append((e.name, "stat-failed")); uncertain = True
                continue
            if stat.S_ISDIR(st.st_mode):
                subdirs.append(e.name)
            elif ids.valid_activity_id(e.name):
                if stat.S_ISLNK(st.st_mode):
                    rejected.append((e.name, "symlink"))
                else:
                    rejected.append((e.name, "not-directory"))
                uncertain = True
    finally:
        os.close(dfd)
    return subdirs, rejected, uncertain

def list_owned_subdirs(base):
    """Thin `subdirs`-only wrapper over `list_owned_subdirs_detailed` (Ruling 49): unchanged
    behavior for existing callers that don't need to distinguish "gone" from "uncertain"."""
    return list_owned_subdirs_detailed(base)[0]

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
