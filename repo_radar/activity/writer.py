import datetime, hashlib, json, os, subprocess, sys, threading
from repo_radar.activity import ids, paths, records, quota, redact
from repo_radar.activity import lease as lease_mod

_PROC_BIRTH = datetime.datetime.now(datetime.timezone.utc).astimezone().isoformat()
_BOOT_ID = None

def _warn(msg):
    print(f"repo-radar: activity: {msg}", file=sys.stderr)

def _safe_close(fd):
    """close() can raise too (EIO on NFS/FUSE, ENOSPC/EDQUOT on close-deferred allocation, EBADF)
    -- realistic on a network/cloud-synced home dir. A close-time error must never escape the
    never-raises boundary (finding 1); caller treats a failed close as "not confirmed"."""
    try:
        os.close(fd)
        return True
    except Exception as e:
        _warn(f"emit close failed: {e}")
        return False

def _boot_id():
    global _BOOT_ID
    if _BOOT_ID is None:
        try:
            out = subprocess.run(["/usr/sbin/sysctl", "-n", "kern.boottime"],
                                 capture_output=True, text=True, timeout=2).stdout.strip()
            _BOOT_ID = hashlib.sha256(out.encode()).hexdigest()[:16]   # stable per-boot
        except Exception:
            _BOOT_ID = ""
    return _BOOT_ID

def _fingerprint():                                   # corroborating evidence only (§2, finding 7)
    return {"pid": os.getpid(), "boot_id": _boot_id(), "proc_birth": _PROC_BIRTH}

# _emit outcomes (Round-5 #2): distinguish "nothing written" from "written but not fsync'd"
# from "durable", so a retry never fsyncs an empty segment into a terminal-only item.
_NOTHING, _WROTE, _DURABLE = 0, 1, 2

class ActivityWriter:
    """Never-raises façade (finding 3): ANY construction failure yields an INACTIVE writer
    whose methods are no-ops and whose hand_off_env() is empty — a broken observability layer
    can never change sync semantics."""
    def __init__(self, home, *, kind, channel, trigger, producer,
                 configured_secrets=(), inherited_id=None, inherited_fd=None, owner_token=None):
        self._active = False
        self._lease = None
        self._adopted = False                           # set early so except-cleanup can branch
        self._start_written = False                     # a start LINE was appended (visible, maybe not durable)
        self._started = False                            # start is DURABLE (fsync ok) — terminal gate
        self._handoff_rejected = False                   # a corrupt lease handoff (§5) — not benign
        # RLock (not Lock): start()/terminal() hold this across their whole decide-then-act
        # sequence (I3) and internally call _emit, which re-acquires the same lock on the same
        # thread -- a plain Lock would self-deadlock there.
        self._lock = threading.RLock()
        self._reserve_used = {"terminal": False, "cancel": False, "dropped": False}
        try:
            self._home = home; self._producer = producer
            self._kind = kind; self._channel = channel; self._trigger = trigger
            self._redactor = redact.Redactor(list(configured_secrets))
            self._seq = 0
            self._writer_id = ids.mint_token()
            adopted = bool(inherited_id) and ids.valid_activity_id(inherited_id)
            self._adopted = adopted
            self._cancel_authority = not adopted        # finding 2: only the MINTER may cancel
            if adopted:
                self.activity_id = inherited_id
                self._lease = lease_mod.adopt(inherited_fd, owner_token,
                                              paths.owner_lock_path(home, inherited_id))
                self._first_producer = not quota._has_start(home, inherited_id)
                if self._first_producer and not quota.admit(home, inherited_id, self._lease):
                    _warn("admission refused; skipping activity recording")
                    self._lease.drop_local_reference(); self._lease = None; return
            else:
                self.activity_id = ids.mint_activity_id()
                paths.secure_mkdir(paths.activity_dir(home, self.activity_id))
                self._lease = lease_mod.acquire(paths.owner_lock_path(home, self.activity_id))
                if self._lease is None:
                    _warn("could not acquire lease; skipping activity recording"); return
                self._first_producer = True
                if not quota.admit(home, self.activity_id, self._lease):
                    _warn("admission refused; skipping activity recording")
                    self._lease.release(); self._lease = None; return
            self._seg = paths.segment_path(home, self.activity_id, producer, self._writer_id)
            self._active = True
        except lease_mod.HandoffRejected as e:          # a corrupt/spoofed lease handoff (§5)
            _warn(f"lease handoff rejected; not proceeding as owner: {e}")
            self._handoff_rejected = True               # caller (cli/bootstrap) aborts -> Electron
            self._active = False                        #   sees the exit and finalizes `failed`
        except Exception as e:                          # never raise into the caller
            _warn(f"init failed; recording disabled: {e}")
            try:
                if self._lease is not None:
                    # finding 1: an ADOPTED lease shares Electron's open-file description —
                    # close only, NEVER LOCK_UN (that would unlock the parent's live copy).
                    if self._adopted:
                        self._lease.drop_local_reference()
                    else:
                        self._lease.release()           # only the original locker unlocks
            except Exception:
                pass
            self._lease = None; self._active = False

    def _release_lease(self):
        """Branch on adoption exactly like __init__'s cleanup path (finding 1 / C2): an ADOPTED
        lease shares the parent's open-file-description, so only a close (drop_local_reference)
        is safe here -- release()'s LOCK_UN would unlock the parent's still-live copy of the same
        OFD. A minted (non-adopted) lease keeps using release(), the original locker's normal
        unlock-and-close."""
        if self._lease is None:
            return
        if self._adopted:
            self._lease.drop_local_reference()
        else:
            self._lease.release()

    def _emit(self, kind, build, *, reserve=False, fsync=False, slot=None):
        """All payload construction/redaction/accounting/write happen INSIDE this boundary
        (finding 1). Returns _NOTHING / _WROTE / _DURABLE (Round-5 #2, Round-6 #1)."""
        if not self._active:
            return _NOTHING
        with self._lock:
            if not self._active:                        # RE-CHECK under the lock (Codex gate round
                return _NOTHING                          # 1, finding 4): _active only transitions
                # True->False (on terminal/failure), and only ever UNDER this same lock, so a
                # racing emit that passed the pre-lock fast-path check before terminal() ran can
                # still block here until terminal() releases -- this authoritative recheck closes
                # that window instead of proceeding to build/grant/write after settlement.
            if slot is not None:                        # one-shot check UNDER the mutex (finding 2)
                if self._reserve_used[slot]:
                    return _NOTHING
                self._reserve_used[slot] = True
            try:                                        # build/grant: any failure = nothing written
                payload = build()
                rec = records.build(kind, seq=self._seq, activity_id=self.activity_id, **payload)
                blob = records.encode(rec)
                if not reserve and not quota.grant(self._home, self.activity_id, len(blob)):
                    return _NOTHING
            except Exception as e:
                _warn(f"emit build failed: {e}"); return _NOTHING
            try:
                fd = paths.secure_open_append(self._seg)
            except Exception as e:
                _warn(f"emit open failed: {e}"); return _NOTHING   # nothing written (finding 2)
            try:
                start_off = os.lseek(fd, 0, os.SEEK_END)           # append offset for rollback
                view = memoryview(blob)
                while view:
                    n = os.write(fd, view)
                    if n <= 0:                          # zero-byte write -> error (no infinite loop)
                        raise OSError("zero-byte write")
                    view = view[n:]
            except Exception as e:                      # PARTIAL line -> truncate it away (finding 1)
                _warn(f"emit write failed: {e}")
                try:
                    os.ftruncate(fd, start_off)         # remove the contaminating prefix
                except OSError:
                    pass
                _safe_close(fd)                         # C1: close() can raise too -- never escape
                return _NOTHING                         # nothing durable, no contamination left
            self._seq += 1                              # a COMPLETE line is on disk -> consume the seq
            if fsync:                                   #   NOW, independent of fsync (finding 1)
                try:
                    os.fsync(fd)
                except Exception as e:
                    _warn(f"emit fsync failed: {e}")
                    _safe_close(fd)                     # C1: guarded, matches _resync_segment's pattern
                    return _WROTE                       # complete line written, not yet durable
            if not _safe_close(fd):                     # C1: close failed -> not confirmed complete
                return _WROTE                           # line is on disk, but treat conservatively
            return _DURABLE

    def _redact_val(self, v):
        if isinstance(v, bool) or v is None:
            return v
        if isinstance(v, (int, float)):
            return v
        return self._redactor.scrub(v if isinstance(v, str) else json.dumps(v, allow_nan=False))

    def _redact_fields(self, fields):
        return {k: self._redact_val(v) for k, v in fields.items()}

    def _resync_segment(self):
        try:
            fd = paths.secure_open_append(self._seg)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
            return True
        except Exception as e:
            _warn(f"resync failed: {e}"); return False

    def start(self):
        # I3: the whole decide-then-act sequence is atomic per writer -- an RLock so the internal
        # _emit() calls below (same thread) can re-acquire it without self-deadlocking.
        with self._lock:
            if not self._active or self._started:           # idempotent once DURABLE
                return
            if self._adopted and not self._first_producer:  # adopt-existing: a valid start exists upstream
                if self._emit("ownership", lambda: dict(owner_token=self._lease.owner_token,
                        role="handoff", producer=self._producer, **_fingerprint()), fsync=True) == _DURABLE:
                    self._started = True
                return
            if not self._start_written:
                res = self._emit("start", lambda: dict(kind=self._kind, channel=self._channel,
                    trigger=self._trigger, created_by=self._producer), fsync=True)
                if res == _NOTHING:
                    return                                   # nothing written -> retry emits fresh (finding 2)
                self._start_written = True                   # a FULL start line is on disk (visible)
                if res != _DURABLE:
                    return                                   # written but not fsync'd -> retry re-fsyncs
            elif not self._resync_segment():                 # retry: re-fsync the already-written line
                return
            self._started = True                             # only after a DURABLE start (finding 2)
            self._emit("ownership", lambda: dict(owner_token=self._lease.owner_token,   # ownership AFTER start
                role="initial", producer=self._producer, **_fingerprint()), fsync=True)

    def _durably_started(self):
        # this process fsync'd its own start, OR (adopt path) an upstream producer durably did
        return self._started or (self._adopted and quota._has_start(self._home, self.activity_id))

    def _ensure_started(self):
        if not self._durably_started():
            self.start()                                # try to establish a durable start

    def event(self, name, level, detail=None, **fields):
        res = self._emit("event", lambda: dict(level=level, event=name,
            fields=self._redact_fields(fields),
            detail=self._redactor.scrub(detail) if detail is not None else None))
        if res != _DURABLE:                             # refused/failed -> note once (slot-guarded)
            self._emit("integrity", lambda: dict(kind="dropped-events"),
                       reserve=True, fsync=True, slot="dropped")

    def control(self, name, **fields):
        if name == "cancel_requested":
            if not self._cancel_authority:              # exclusive authority (finding 2)
                return
            self._emit("control", lambda: dict(name=name, fields=self._redact_fields(fields)),
                       reserve=True, fsync=True, slot="cancel")
        else:                                           # non-cancel = ordinary (grant-based)
            self._emit("control", lambda: dict(name=name, fields=self._redact_fields(fields)))

    def terminal(self, outcome, **summary):
        # I3: same atomicity as start() -- the _active gate, the _ensure_started()/start() call it
        # may trigger, and the finalize decision must all happen as one indivisible step per writer.
        with self._lock:
            if not self._active:
                return
            self._ensure_started()
            if not self._durably_started():
                # no durable start -> a terminal-only item is INVALID (finding 2). Release the
                # lease; reconciliation reclaims the reservation as a no-start abandonment.
                _warn("cannot finalize: no durable start; leaving for reconciliation")
                try:
                    self._release_lease()               # C2: adopted -> close-only, never LOCK_UN
                except Exception as e:
                    _warn(f"release failed: {e}")
                self._active = False
                return
            res = self._emit("terminal", lambda: dict(outcome=outcome,
                summary=self._redact_fields(summary), by=self._lease.owner_token),
                reserve=True, fsync=True, slot="terminal")
            # settle and release are attempted INDEPENDENTLY so a settle failure can't strand the
            # lock (finding 1): release is in `finally` and always runs -> the lock becomes FREE.
            try:
                if res == _DURABLE:                          # settle ONLY after a durable terminal
                    try:
                        quota.settle(self._home, self.activity_id)
                    except Exception as e:
                        _warn(f"settle failed: {e}")
                else:
                    _warn("terminal not durable; leaving reservation for reconciliation")
            finally:
                try:
                    self._release_lease()               # C2: adopted -> close-only, never LOCK_UN
                except Exception as e:
                    _warn(f"release failed: {e}")
                self._active = False

    def hand_off_env(self):
        if not self._active or self._lease is None or self._lease.fd is None:
            return {}                                   # inactive/refused -> no dead fd (finding 3)
        return {"REPO_RADAR_ACTIVITY_ID": self.activity_id,
                "REPO_RADAR_ACTIVITY_OWNER_TOKEN": self._lease.owner_token,
                "REPO_RADAR_ACTIVITY_LOCK_FD": str(self._lease.fd)}
