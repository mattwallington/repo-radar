import os, stat
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

def read_owned_segments(directory, suffix=".jsonl"):
    """Enumerate + read files under an owned dir via a validated dir fd, never following a
    symlinked component or entry (Round-4 #3). Returns [(name, data_bytes, size, mtime)]; []
    if missing."""
    try:
        dfd = open_owned_dir(directory)
    except (UnsafePath, FileNotFoundError):
        return []
    out = []
    try:
        for entry in os.scandir(dfd):
            if not entry.name.endswith(suffix):
                continue
            try:
                st = os.lstat(entry.name, dir_fd=dfd)
                if not stat.S_ISREG(st.st_mode):                 # skip symlinks / non-regular
                    continue
                ffd = os.open(entry.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dfd)
                try:
                    out.append((entry.name, _read_fd(ffd), st.st_size, st.st_mtime))
                finally:
                    os.close(ffd)
            except OSError:                                       # TOCTOU: entry deleted/swapped mid-scan
                continue
    finally:
        os.close(dfd)
    return out

def read_owned_file(path):
    """Read one owned file's bytes via the nonblocking regular-file helper (e.g. a ledger entry)."""
    fd = open_owned_regular(path, os.O_RDONLY)                # O_NONBLOCK + S_ISREG (Round-6 #4)
    try:
        return _read_fd(fd)
    finally:
        os.close(fd)

def list_owned_subdirs(base):
    """Immediate real subdir NAMES of an owned base via a validated dir fd (no symlink follow)."""
    try:
        dfd = open_owned_dir(base)
    except (UnsafePath, FileNotFoundError):
        return []
    out = []
    try:
        for e in os.scandir(dfd):
            try:
                if stat.S_ISDIR(os.lstat(e.name, dir_fd=dfd).st_mode):
                    out.append(e.name)
            except OSError:                                       # TOCTOU: entry deleted/swapped mid-scan
                continue
    finally:
        os.close(dfd)
    return out

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
