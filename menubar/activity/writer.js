'use strict';
// Node mirror of repo_radar/activity/writer.py (the post-Phase-1-review ActivityWriter -- has
// the C1 close-guard, I5 segment-rotation + never-raises hardening, and the Ruling-7 terminal
// release-vs-drop branch) -- the never-raises producer facade the Electron main process writes
// through directly (the "manual path", as opposed to a spawned Python CLI child, which uses
// writer.py). Consumes the already-mirrored ids/paths/records/lease/quota/reconcile modules plus
// this task's own redact.js.
//
// ONE deliberate simplification vs writer.py (per the task brief): Node runs on a single-
// threaded event loop and every fs op here is SYNCHRONOUS, so there is no way for a second
// start()/event()/control()/terminal() call to interleave in the middle of another call's body.
// writer.py's `threading.RLock` exists ONLY to make that decide-then-act sequence atomic across
// concurrent OS threads, and its Codex-gate-round-1 finding 4 fix (re-checking `_active` a SECOND
// time after acquiring the lock, because a racing call could pass the pre-lock fast-path check
// before terminal() ran) closes a window that literally cannot open in Node. Neither the RLock
// nor that re-check is ported; every other invariant they protected (idempotent start, no
// terminal-only item, grant-before-append, exclusive cancel authority, exactly-once reserved
// slots) still holds, because in Node those decisions and their side effects happen in one
// unbroken synchronous call, which is a STRONGER guarantee than a lock provides.
const fs = require('fs');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const ids = require('./ids');
const paths = require('./paths');
const records = require('./records');
const lease = require('./lease');
const quota = require('./quota');
const reconcile = require('./reconcile');
const redact = require('./redact');

function _warn(msg) {
  console.error(`repo-radar: activity: ${msg}`);
}

// close() can raise too (EIO on NFS/FUSE, ENOSPC/EDQUOT on close-deferred allocation, EBADF) --
// realistic on a network/cloud-synced home dir. A close-time error must never escape the
// never-raises boundary (mirrors writer.py's C1 fix, `_safe_close`); callers treat a failed close
// as "not confirmed".
function _safeClose(fd) {
  try {
    fs.closeSync(fd);
    return true;
  } catch (e) {
    _warn(`emit close failed: ${e.message}`);
    return false;
  }
}

let _BOOT_ID = null;
function _bootId() {
  if (_BOOT_ID === null) {
    try {
      const r = spawnSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8', timeout: 2000 });
      if (r.error) throw r.error;
      _BOOT_ID = crypto.createHash('sha256').update((r.stdout || '').trim()).digest('hex').slice(0, 16);
    } catch (e) {
      _BOOT_ID = '';
    }
  }
  return _BOOT_ID;
}

// Local-timezone ISO-8601-with-offset timestamp, mirrors writer.py's module-level `_PROC_BIRTH =
// datetime.now(timezone.utc).astimezone().isoformat()`, computed ONCE at module load.
function _isoNowWithOffset() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const offMin = -d.getTimezoneOffset(); // minutes EAST of UTC (Node's getTimezoneOffset is WEST-positive)
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
const _PROC_BIRTH = _isoNowWithOffset();

// corroborating evidence only (writer.py's `_fingerprint`, §2 finding 7) -- not load-bearing for
// correctness, just diagnostic breadcrumbs on the `ownership` record.
function _fingerprint() {
  return { pid: process.pid, boot_id: _bootId(), proc_birth: _PROC_BIRTH };
}

// _emit outcomes: distinguish "nothing written" from "written but not fsync'd" from "durable", so
// a retry never fsyncs an empty segment into a terminal-only item. Mirrors writer.py's
// _NOTHING/_WROTE/_DURABLE tri-state exactly.
const _NOTHING = 0;
const _WROTE = 1;
const _DURABLE = 2;

// Codex gate round 1, finding 5 (carried into Node): a SEGMENT-specific write/ftruncate seam,
// distinct from paths.js's OWN fs.writeSync/fs.ftruncateSync usage (writeOwnedFileAtomic, which
// quota.js's ledger persistence goes through). writer.js and paths.js both call through the SAME
// shared `fs` module object (Node's require cache), so a test that globally monkeypatched
// `fs.writeSync` to inject a segment-write failure would ALSO silently intercept quota's ledger
// write -- corrupting the accounting path instead of (or in addition to) exercising the intended
// segment-only failure, exactly the collision writer.py's own `_seg_write`/`_seg_ftruncate`
// module-level rebinding was introduced to avoid. `_emit` below uses ONLY these two names for the
// segment write/rollback; a test retargets them via the getter/setter pair in module.exports
// (mirrors quota.js's `PYTHON_BIN` seam) without touching paths.js's or quota.js's own fs calls.
let _segWrite = fs.writeSync;
let _segFtruncate = fs.ftruncateSync;

// Local mirror of records.js's private `_strictStringify`: rejects a non-finite number ANYWHERE
// in the value tree instead of letting `JSON.stringify` silently coerce Infinity/-Infinity/NaN to
// the literal `null`, matching Python's `json.dumps(v, allow_nan=False)` call inside
// `_redact_val`. Needed here (not just at records.js's own final encode guard) because redaction
// serializes a non-string field value to text BEFORE it ever reaches `records.buildRecord`.
function _strictStringify(value) {
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === 'number' && !Number.isFinite(v)) {
      throw new Error('non-finite number');
    }
    return v;
  });
}

class ActivityWriter {
  // Never-raises facade: ANY construction failure yields an INACTIVE writer whose methods are
  // no-ops and whose handOffEnv() is empty -- a broken observability layer can never change sync
  // semantics. Node keyword-args-via-options-object stand-in for writer.py's `*, kind, channel,
  // trigger, producer, configured_secrets=(), inherited_id=None, inherited_fd=None,
  // owner_token=None`.
  constructor(home, {
    kind, channel, trigger, producer,
    configuredSecrets = [], inheritedId = null, inheritedFd = null, ownerToken = null,
  } = {}) {
    this._active = false;
    this._lease = null;
    this._adopted = false; // set early so except-cleanup can branch
    this._startWritten = false; // a start LINE was appended (visible, maybe not durable)
    this._started = false; // start is DURABLE (fsync ok) -- terminal gate
    this._handoffRejected = false; // a corrupt lease handoff (lease.HandoffRejected) -- not benign
    // Node-only: set true by dropLocalReference() (below) after a PARENT-side handoff to a
    // spawned child. writer.py has no analog for this flag -- Python's writer is always the
    // CHILD/adopt side of a handoff in this codebase; Node's Electron process is architecturally
    // the one that MINTS/holds first and forks further children (Task 2.3), so it needs this
    // parent-side "I've handed off, stop treating myself as the owner" bookkeeping that Python
    // never needed.
    this._handedOff = false;
    this._reserveUsed = { terminal: false, cancel: false, dropped: false };
    try {
      this._home = home; this._producer = producer;
      this._kind = kind; this._channel = channel; this._trigger = trigger;
      this._redactor = new redact.Redactor(Array.from(configuredSecrets));
      this._seq = 0;
      this._writerId = ids.mintToken();
      const adopted = Boolean(inheritedId) && ids.validActivityId(inheritedId);
      this._adopted = adopted;
      this._cancelAuthority = !adopted; // finding 2: only the MINTER may cancel
      if (adopted) {
        this.activityId = inheritedId;
        this._lease = lease.adopt(inheritedFd, ownerToken, paths.ownerLockPath(home, inheritedId));
        this._firstProducer = !reconcile._hasStart(home, inheritedId);
        if (this._firstProducer && !quota.admit(home, inheritedId, this._lease)) {
          _warn('admission refused; skipping activity recording');
          this._lease.dropLocalReference(); this._lease = null; return;
        }
      } else {
        this.activityId = ids.mintActivityId();
        paths.secureMkdir(paths.activityDir(home, this.activityId));
        this._lease = lease.acquire(paths.ownerLockPath(home, this.activityId));
        if (this._lease === null) {
          _warn('could not acquire lease; skipping activity recording'); return;
        }
        this._firstProducer = true;
        if (!quota.admit(home, this.activityId, this._lease)) {
          _warn('admission refused; skipping activity recording');
          this._lease.release(); this._lease = null; return;
        }
      }
      this._seg = paths.segmentPath(home, this.activityId, producer, this._writerId);
      this._active = true;
    } catch (e) {
      if (e instanceof lease.HandoffRejected) { // a corrupt/spoofed lease handoff
        _warn(`lease handoff rejected; not proceeding as owner: ${e.message}`);
        this._handoffRejected = true; // caller (Electron) aborts -> finalizes `failed` itself
        this._active = false;
        return;
      }
      _warn(`init failed; recording disabled: ${e.message}`); // never raise into the caller
      try {
        if (this._lease !== null) {
          // an ADOPTED lease shares a parent's open-file description -- close only, NEVER a
          // force-unlock (there isn't one in Node either way -- see _releaseLease below).
          if (this._adopted) {
            this._lease.dropLocalReference();
          } else {
            this._lease.release(); // only the original locker unlocks
          }
        }
      } catch (e2) { /* never escape construction */ }
      this._lease = null; this._active = false;
    }
  }

  // Branch on adoption exactly like the constructor's own cleanup path: an ADOPTED lease shares
  // the parent's open-file-description, so only a close (dropLocalReference) is safe here --
  // release()'s intended "unlock regardless of other holders" semantics are not something Node
  // CAN provide (no flock(2) binding, no lockf(1) unlock verb -- see lease.js's header comment),
  // so release() and dropLocalReference() are BOTH just fs.closeSync(fd) under the hood in Node.
  // A mistaken release() call on a shared fd therefore silently no-ops (the OFD stays locked for
  // whoever else references it) rather than force-unlocking a live holder's copy the way
  // Python's LOCK_UN would -- safe, but behaviorally different. The CALLING DISCIPLINE (which
  // method is invoked when) still must be exact for contract-compat with writer.py and to keep
  // this divergence inert rather than accidentally load-bearing.
  _releaseLease() {
    if (this._lease === null) return;
    if (this._adopted) {
      this._lease.dropLocalReference();
    } else {
      this._lease.release();
    }
  }

  // All payload construction/redaction/accounting/write happen INSIDE this boundary. Returns
  // _NOTHING / _WROTE / _DURABLE. No lock: see the module header comment for why writer.py's
  // RLock + under-lock `_active` re-check are not ported (single-threaded, fully synchronous --
  // no call can interleave mid-body).
  _emit(kind, build, { reserve = false, fsync = false, slot = null } = {}) {
    if (!this._active) return _NOTHING;
    if (slot !== null) { // one-shot check (finding 2)
      if (this._reserveUsed[slot]) return _NOTHING;
      this._reserveUsed[slot] = true;
    }
    let blob;
    try { // build/grant: any failure = nothing written
      const payload = build();
      const rec = records.buildRecord(kind, { seq: this._seq, activity_id: this.activityId, ...payload });
      blob = records.encodeRecord(rec);
      if (!reserve && !quota.grant(this._home, this.activityId, blob.length)) {
        return _NOTHING;
      }
    } catch (e) {
      _warn(`emit build failed: ${e.message}`);
      return _NOTHING;
    }
    let fd;
    try {
      fd = paths.secureOpenAppend(this._seg);
    } catch (e) {
      _warn(`emit open failed: ${e.message}`);
      return _NOTHING; // nothing written
    }
    let startOff;
    try {
      // append offset for rollback. Node has no lseek(2) binding; fstat's `size` IS the current
      // end-of-file, and nothing else appends to this process-exclusive segment fd concurrently
      // (each writer instance owns a unique writer_id-named segment), so this is equivalent to
      // writer.py's `os.lseek(fd, 0, os.SEEK_END)`.
      startOff = fs.fstatSync(fd).size;
      let offset = 0;
      while (offset < blob.length) {
        const n = _segWrite(fd, blob, offset, blob.length - offset, null);
        if (n <= 0) throw new Error('zero-byte write'); // no infinite loop
        offset += n;
      }
    } catch (e) { // PARTIAL line -> truncate it away
      _warn(`emit write failed: ${e.message}`);
      try {
        _segFtruncate(fd, startOff); // remove the contaminating prefix
      } catch (te) {
        // the rollback itself failed -- the partial bytes are STUCK on disk. Reusing this
        // segment would let the NEXT emit append BEHIND that unremovable prefix. Poison it:
        // abandon it and rotate all subsequent writes to a fresh segment instead.
        _warn(`emit rollback ftruncate failed: ${te.message}`);
        try {
          this._rotateSegment();
        } catch (re) {
          // never-raises boundary: _rotateSegment calls ids.mintToken() (-> crypto.randomBytes)
          // and paths.segmentPath -- near-impossible to fail, but a rotation failure must not
          // escape _emit into start()/terminal()/control(). With no working segment to fall back
          // to, degrade the writer to inactive (every subsequent _emit is then a no-op _NOTHING).
          _warn(`emit segment rotation failed: ${re.message}`);
          this._active = false;
        }
      }
      _safeClose(fd); // close() can raise too -- never escape
      return _NOTHING; // nothing durable, no contamination left
    }
    this._seq += 1; // a COMPLETE line is on disk -> consume the seq
    if (fsync) { // NOW, independent of fsync
      try {
        fs.fsyncSync(fd);
      } catch (e) {
        _warn(`emit fsync failed: ${e.message}`);
        _safeClose(fd); // guarded, matches _resyncSegment's pattern
        return _WROTE; // complete line written, not yet durable
      }
    }
    if (!_safeClose(fd)) { // close failed -> not confirmed complete
      return _WROTE; // line is on disk, but treat conservatively
    }
    return _DURABLE;
  }

  _redactVal(v) {
    if (typeof v === 'boolean' || v === null || v === undefined) return v;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') return this._redactor.scrub(v);
    return this._redactor.scrub(_strictStringify(v));
  }

  _redactFields(fields) {
    const out = {};
    for (const [k, v] of Object.entries(fields || {})) {
      out[k] = this._redactVal(v);
    }
    return out;
  }

  // Abandon the current (poisoned) segment and switch to a FRESH one -- a new writer_id under
  // the same producer, the writer's normal segment-naming scheme -- for all subsequent writes.
  // reconcile/scan read ALL segments and parseValid isolates a poisoned tail line (returns null
  // for it), so the clean segment's records are never orphaned behind the unremoved partial
  // prefix left by a rollback failure.
  _rotateSegment() {
    this._writerId = ids.mintToken();
    this._seg = paths.segmentPath(this._home, this.activityId, this._producer, this._writerId);
  }

  _resyncSegment() {
    try {
      const fd = paths.secureOpenAppend(this._seg);
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (e) {
      _warn(`resync failed: ${e.message}`);
      return false;
    }
  }

  start() {
    if (!this._active || this._started) return; // idempotent once DURABLE
    if (this._adopted && !this._firstProducer) { // adopt-existing: a valid start exists upstream
      if (this._emit('ownership', () => ({
        owner_token: this._lease.ownerToken, role: 'handoff', producer: this._producer, ..._fingerprint(),
      }), { fsync: true }) === _DURABLE) {
        this._started = true;
      }
      return;
    }
    if (!this._startWritten) {
      const res = this._emit('start', () => ({
        kind: this._kind, channel: this._channel, trigger: this._trigger, created_by: this._producer,
      }), { fsync: true });
      if (res === _NOTHING) return; // nothing written -> retry emits fresh
      this._startWritten = true; // a FULL start line is on disk (visible)
      if (res !== _DURABLE) return; // written but not fsync'd -> retry re-fsyncs
    } else if (!this._resyncSegment()) { // retry: re-fsync the already-written line
      return;
    }
    this._started = true; // only after a DURABLE start
    this._emit('ownership', () => ({ // ownership AFTER start
      owner_token: this._lease.ownerToken, role: 'initial', producer: this._producer, ..._fingerprint(),
    }), { fsync: true });
  }

  // this process fsync'd its own start, OR (adopt path) an upstream producer durably did
  _durablyStarted() {
    return this._started || (this._adopted && reconcile._hasStart(this._home, this.activityId));
  }

  _ensureStarted() {
    if (!this._durablyStarted()) {
      this.start(); // try to establish a durable start
    }
  }

  // Node has no `**kwargs`; `{ detail = null, ...fields }` is the destructuring stand-in for
  // writer.py's `event(self, name, level, detail=None, **fields)`.
  event(name, level, { detail = null, ...fields } = {}) {
    const res = this._emit('event', () => ({
      level, event: name,
      fields: this._redactFields(fields),
      detail: detail !== null ? this._redactor.scrub(detail) : null,
    }));
    if (res !== _DURABLE) { // refused/failed -> note once (slot-guarded)
      this._emit('integrity', () => ({ kind: 'dropped-events' }), { reserve: true, fsync: true, slot: 'dropped' });
    }
  }

  control(name, fields = {}) {
    if (name === 'cancel_requested') {
      if (!this._cancelAuthority) return; // exclusive authority
      this._emit('control', () => ({ name, fields: this._redactFields(fields) }),
        { reserve: true, fsync: true, slot: 'cancel' });
    } else { // non-cancel = ordinary (grant-based)
      this._emit('control', () => ({ name, fields: this._redactFields(fields) }));
    }
  }

  terminal(outcome, summary = {}) {
    if (!this._active) return;
    this._ensureStarted();
    if (!this._durablyStarted()) {
      // no durable start -> a terminal-only item is INVALID. Release the lease; reconciliation
      // reclaims the reservation as a no-start abandonment.
      _warn('cannot finalize: no durable start; leaving for reconciliation');
      try {
        this._releaseLease(); // adopted -> close-only, never a force-unlock
      } catch (e) {
        _warn(`release failed: ${e.message}`);
      }
      this._active = false;
      return;
    }
    const res = this._emit('terminal', () => ({
      outcome, summary: this._redactFields(summary), by: this._lease.ownerToken,
    }), { reserve: true, fsync: true, slot: 'terminal' });
    // settle and release are attempted INDEPENDENTLY so a settle failure can't strand anything:
    // release always runs in `finally`.
    try {
      if (res === _DURABLE) { // settle ONLY after a durable terminal
        try {
          quota.settle(this._home, this.activityId);
        } catch (e) {
          _warn(`settle failed: ${e.message}`);
        }
      } else {
        _warn('terminal not durable; leaving reservation for reconciliation');
      }
    } finally {
      try {
        this._releaseLease(); // adopted -> close-only, never a force-unlock
      } catch (e) {
        _warn(`release failed: ${e.message}`);
      }
      this._active = false;
    }
  }

  handOffEnv() {
    if (!this._active || this._lease === null || this._lease.fd === null) {
      return {}; // inactive/refused -> no dead fd
    }
    return {
      REPO_RADAR_ACTIVITY_ID: this.activityId,
      REPO_RADAR_ACTIVITY_OWNER_TOKEN: this._lease.ownerToken,
      REPO_RADAR_ACTIVITY_LOCK_FD: String(this._lease.fd),
    };
  }

  // Node-only public method -- writer.py has no analog (see the `_handedOff` field comment in
  // the constructor). Called by the Electron-side caller AFTER spawning a child process that has
  // inherited this writer's fd/owner-token/activity-id via handOffEnv(): the child now holds a
  // live copy of the same open-file-description, so this writer must stop acting as the owner.
  // ALWAYS closes via the lease's dropLocalReference() (close-only), regardless of whether THIS
  // writer's own lease was originally minted or adopted -- the determining factor here is "a
  // live child now shares my fd" (true unconditionally, because that is the entire reason this
  // method is being called), which is a DIFFERENT question from `_releaseLease()`'s "was MY
  // lease shared with some upstream ancestor when I received it" (relevant to terminal()).
  // Idempotent and never-raises: safe to call multiple times, or on an already-inactive writer.
  dropLocalReference() {
    if (!this._active || this._handedOff || this._lease === null) return;
    try {
      this._lease.dropLocalReference();
    } catch (e) {
      _warn(`hand-off drop failed: ${e.message}`);
    } finally {
      this._handedOff = true;
      this._active = false;
    }
  }
}

module.exports = {
  ActivityWriter,
  _NOTHING, _WROTE, _DURABLE,
  get _segWrite() { return _segWrite; },
  set _segWrite(v) { _segWrite = v; },
  get _segFtruncate() { return _segFtruncate; },
  set _segFtruncate(v) { _segFtruncate = v; },
};
