import errno, fcntl, os, stat
from repo_radar.activity import ids, paths

FREE, BUSY, UNCERTAIN = "free", "busy", "uncertain"

class HandoffRejected(Exception):
    pass

class Lease:
    def __init__(self, fd, owner_token):
        self.fd = fd
        self.owner_token = owner_token
    def release(self):
        """Full release: unlock + close (the executing owner, at terminal)."""
        if self.fd is not None:
            try:
                fcntl.flock(self.fd, fcntl.LOCK_UN)
            finally:
                os.close(self.fd); self.fd = None
    def drop_local_reference(self):
        """Close WITHOUT LOCK_UN (finding 5). LOCK_UN would release the shared open-file
        description the child inherited; a bare close leaves the child holding the lease."""
        if self.fd is not None:
            os.close(self.fd); self.fd = None

def acquire(lock_path):
    # descriptor-relative, O_NONBLOCK, regular-file-only (Round-6 #4) — a FIFO owner.lock can
    # neither block the open nor be adopted as a lease.
    try:
        fd = paths.open_owned_regular(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    except (OSError, paths.UnsafePath):
        return None
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd); return None
    return Lease(fd, ids.mint_token())

def probe(lock_path):
    """Tri-state via a fresh independent open-file description (finding 7)."""
    try:
        fd = paths.open_owned_regular(lock_path, os.O_RDWR)
    except (OSError, paths.UnsafePath):
        return UNCERTAIN
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(fd, fcntl.LOCK_UN)     # we got it -> it was free
        return FREE
    except OSError as e:
        return BUSY if e.errno in (errno.EAGAIN, errno.EWOULDBLOCK) else UNCERTAIN
    finally:
        os.close(fd)

def probe_busy(lock_path) -> bool:
    return probe(lock_path) == BUSY

def adopt(inherited_fd, owner_token, lock_path) -> Lease:
    # (1) syntactic
    if not (isinstance(inherited_fd, int) and inherited_fd >= 0 and ids.valid_token(owner_token)):
        raise HandoffRejected("bad fd/token syntax")
    # (2) fstat identity vs a fresh non-symlink stat; inherited fd must be a REGULAR file (Round-6 #4)
    try:
        fst = os.fstat(inherited_fd)
        pst = os.stat(lock_path, follow_symlinks=False)
    except OSError as e:
        raise HandoffRejected(f"stat failed: {e}")
    if not stat.S_ISREG(fst.st_mode):
        raise HandoffRejected("inherited fd is not a regular file")
    if (fst.st_dev, fst.st_ino) != (pst.st_dev, pst.st_ino):
        raise HandoffRejected("fd is not this activity's owner.lock")
    # (3) independent probe MUST be strictly BUSY (UNCERTAIN never counts as held)
    if probe(lock_path) != BUSY:
        raise HandoffRejected("lease not confirmably held (unlocked look-alike or uncertain)")
    # (4) reassert on the INHERITED fd itself MUST succeed (shares the holding OFD)
    try:
        fcntl.flock(inherited_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        raise HandoffRejected("inherited fd does not carry the lease")
    return Lease(inherited_fd, owner_token)
