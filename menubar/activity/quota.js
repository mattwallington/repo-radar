'use strict';
// Node mirror of repo_radar/activity/quota.py (Task 2.2b), applying Ruling A (mirror the FINAL
// post-Codex-gate Python behavior, not the plan's original Node snippets) and Ruling B (Node
// NEVER unlinks/rmdirs -- no destructive removal at all). Concretely:
//
//   - Node READS (charge computation) and CREATES/REPLACES ledger entries (admit's reserve,
//     grant's rewrite) via paths.writeOwnedFileAtomic -- temp+rename in the validated `quota/`
//     dir. That is the ONLY write path. There is no unlink/rmdir/segment-delete anywhere below.
//   - Node DETECTS a corrupt ledger entry and REFUSES admit/grant while one stands (spec §7),
//     exactly like Python's fail-closed state machine, WITHOUT removing it.
//   - Node DELEGATES all destructive cleanup -- corrupt-entry clearing (incl. the dir-ledger
//     rmdir + never-created-lock unlink, Python's B2 fix), settling crashed runs, and segment
//     pruning -- to the Python `prune` entrypoint (`python -m repo_radar.activity.prune
//     <headroom_bytes>`), which already runs `_reconcile_all_locked` (the B2 state machine) then
//     prunes, all under ITS OWN `quota.lock`. `admit` releases the Node quota.lock BEFORE
//     spawning that child (never holds the lock while the Python child needs it -- deadlock
//     otherwise) and re-acquires after the child exits, then re-evaluates from disk.
//
// `admit`'s own pre-delegation charge/corrupt computation is therefore Node's ENTIRE "reconcile
// pass": strictly READ-ONLY (never synthesizes a terminal, never removes an entry). Only the
// separate `reconcile.js`'s `synthesizeTerminal` (Task 2.3's handoff-crash path) WRITES, and
// only appends a terminal record -- it too never removes the ledger entry.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const paths = require('./paths');
const ids = require('./ids');

const CEILING = 64 * 1024 * 1024;
const RESERVE = 60 * 1024;
const PER_ACTIVITY_CAP = 4 * 1024 * 1024;
const ORDINARY_CAP = PER_ACTIVITY_CAP - RESERVE;

const CORRUPT = 'CORRUPT';

// Test-only seam: the Python binary + repo root used to spawn `python -m
// repo_radar.activity.prune`. Exported (not a closed-over const) so a test can point PYTHON_BIN
// at a nonexistent binary to prove the "delegation attempted but unavailable -> fail closed,
// never throws" path, then restore it to prove the real delegation path separately. Mirrors the
// spirit of Python's own monkeypatch-friendly module globals (e.g. prune.py's comment on reading
// `quota.RESERVE` at call time, not bind time).
const REPO_ROOT = path.join(__dirname, '..', '..');
let PYTHON_BIN = 'python3';
const PRUNE_SPAWN_TIMEOUT_MS = 30000; // bounded -- generous for a reconcile+prune pass

function _quotaLockPath(home) {
  // quota.lock sits alongside quota/ (both directly under activity/), mirroring Python's
  // `paths.quota_dir(home).parent`.
  return path.join(path.dirname(paths.quotaDir(home)), 'quota.lock');
}

// BLOCKING lockf on activity/quota.lock (mirrors Python's `fcntl.flock(fd, LOCK_EX)`, blocking
// -- NOT the `-t 0` non-blocking variant lease.js uses for owner.lock, per the brief: "accounting
// must serialize, not fail-fast"). Same mechanism as lease.js's `_lockf` (spawnSync
// /usr/bin/lockf against the fd via stdio-inheritance, sharing Node's open-file-description) but
// with no `-t` argument so lockf blocks until it can acquire, instead of failing immediately.
function _lockfBlocking(fd) {
  const r = spawnSync('/usr/bin/lockf', ['3'], {
    stdio: ['ignore', 'ignore', 'ignore', fd],
    timeout: PRUNE_SPAWN_TIMEOUT_MS,
  });
  if (r.error || typeof r.status !== 'number') return null;
  return r.status;
}

// Opens (creating if needed) + locks quota.lock; validates it's a regular file (fail closed on
// a swapped component, mirroring Python's S_ISREG check) via paths.openOwnedRegular, which
// already does this. Returns the held fd. Throws (UnsafePath / OSError-equivalent) on failure --
// callers (admit/grant/settle) catch broadly and fail closed to false/no-op.
function _quotaLock(home) {
  paths.secureMkdir(paths.quotaDir(home)); // ensures activity/ + quota/ exist
  const lockPath = _quotaLockPath(home);
  const fd = paths.openOwnedRegular(lockPath, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o600);
  const status = _lockfBlocking(fd);
  if (status !== 0) {
    fs.closeSync(fd);
    throw new Error(`quota.lock: lockf did not report success (status=${status})`);
  }
  return fd;
}

// Bare close -- stock Node has no flock(2) binding, so (like lease.js) there is no separate
// "unlock" verb; closing Node's sole retained fd on the OFD drops the flock. `_quotaLock` always
// opens a FRESH fd per call and nothing else in this module retains a second reference, so this
// is a true full release, not the shared-OFD caveat lease.js documents for a live child.
function _unlock(fd) {
  fs.closeSync(fd);
}

// Validates the ledger's FULL invariant (mirrors Python's `_parse_entry` exactly): counters must
// be EXACT non-boolean integers (strings/floats -> CORRUPT), `reserved` exactly RESERVE,
// `granted >= 0`, total <= cap.
function _parseEntry(dataBuf) {
  let d;
  try {
    d = JSON.parse(dataBuf.toString('utf8'));
  } catch (e) {
    return CORRUPT;
  }
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return CORRUPT;
  const r = d.reserved;
  const g = d.granted;
  if (typeof r === 'boolean' || typeof g === 'boolean' || !Number.isInteger(r) || !Number.isInteger(g)) {
    return CORRUPT;
  }
  if (r !== RESERVE || g < 0 || r + g > PER_ACTIVITY_CAP) return CORRUPT;
  return { reserved: r, granted: g };
}

function _readEntry(entryPath) {
  try {
    return _parseEntry(paths.readOwnedFile(entryPath));
  } catch (e) {
    return CORRUPT; // symlink/FIFO/dir/unreadable -- never silently skipped by the CALLER
  }
}

// Durable create-or-replace of the ledger entry via paths.writeOwnedFileAtomic (temp+rename,
// validated `quota/` dir). This is the ONLY write path quota.js has -- no unlink, ever (Ruling
// B). Validates `activityId` FIRST (path-traversal guard, mirrors Python's fix-round-1 Critical
// fix) before any filename is built.
function _writeEntry(home, activityId, reserved, granted) {
  if (!ids.validActivityId(activityId)) {
    throw new paths.UnsafePath(`invalid activity_id for ledger path: ${JSON.stringify(activityId)}`);
  }
  const blob = Buffer.from(JSON.stringify({ reserved, granted }), 'utf8');
  const qdir = paths.quotaDir(home);
  paths.secureMkdir(qdir);
  paths.writeOwnedFileAtomic(qdir, `${activityId}.json`, blob, 0o600);
}

// fstat-only sizing (mirrors the I7 fix): sum of every activity's segment sizes EXCEPT quota/.
function _committed(home) {
  const base = path.dirname(paths.quotaDir(home));
  let total = 0;
  for (const name of paths.listOwnedSubdirs(base)) {
    if (name === 'quota') continue;
    for (const seg of paths.statOwnedSegments(path.join(base, name))) total += seg.size;
  }
  return total;
}

// fstat-only sizing for one activity's segments.
function _onDisk(home, aid) {
  let total = 0;
  for (const seg of paths.statOwnedSegments(paths.activityDir(home, aid))) total += seg.size;
  return total;
}

// (aid, entry-or-CORRUPT) pairs for every valid-UUID-named ledger entry in the quota dir.
// `listOwnedEntries` is UNFILTERED (unlike readOwnedSegments, which would silently drop a
// symlink/FIFO/dir entry out of the enumeration -- undercounting the charge, fail-open); every
// valid-UUID name is CLASSIFIED via `_readEntry`, never silently skipped (mirrors Python's B2
// enumeration fix).
function _ledgerEntries(home) {
  const out = [];
  for (const name of paths.listOwnedEntries(paths.quotaDir(home), '.json')) {
    const aid = name.slice(0, -5); // strip ".json"
    if (ids.validActivityId(aid)) {
      out.push([aid, _readEntry(paths.ledgerEntryPath(home, aid))]);
    }
  }
  return out;
}

function _charge(home) {
  let total = _committed(home);
  for (const [aid, e] of _ledgerEntries(home)) {
    total += e === CORRUPT ? PER_ACTIVITY_CAP : Math.max(0, e.reserved + e.granted - _onDisk(home, aid));
  }
  return total;
}

// spec §7: whether ANY ledger entry is currently untrustworthy. Used to fail-closed refuse new
// admissions/grants while it stands.
function _hasCorrupt(home) {
  return _ledgerEntries(home).some(([, e]) => e === CORRUPT);
}

// Best-effort delegation to the Python prune entrypoint. NEVER throws (spawnSync doesn't throw
// for a nonzero exit / spawn failure / timeout -- it reports via the result object, which is
// intentionally ignored here): admit re-evaluates charge/corrupt from disk regardless of whether
// the spawn succeeded, failed to find the binary, or timed out. `home` becomes the child's HOME
// env var so Python's `Path.home()` (which prune.py's CLI entrypoint uses) resolves to the exact
// same directory Node is operating on -- required for tests (a tmp dir), harmless in production
// (already the real home).
function _spawnPythonPrune(home, headroomBytes) {
  spawnSync(PYTHON_BIN, ['-m', 'repo_radar.activity.prune', String(Math.max(0, Math.trunc(headroomBytes)))], {
    cwd: REPO_ROOT,
    env: { ...process.env, PYTHONPATH: REPO_ROOT, HOME: String(home) },
    stdio: 'ignore',
    timeout: PRUNE_SPAWN_TIMEOUT_MS,
  });
}

// `lease` mirrors Python's admit(home, activity_id, lease) signature for call-site symmetry
// (writer.js will call this with the lease it just acquired, exactly as writer.py does) but,
// like the current Python, does not itself inspect it -- kept for API compatibility.
function admit(home, activityId, lease) {
  void lease;
  let fd = null;
  try {
    fd = _quotaLock(home);
    let charge = _charge(home);
    let corrupt = _hasCorrupt(home);
    if (corrupt || charge + RESERVE > CEILING) {
      const headroom = Math.max(RESERVE, charge + RESERVE - CEILING);
      _unlock(fd);
      fd = null;
      _spawnPythonPrune(home, headroom); // release -> spawn -> (below) re-acquire -> re-evaluate
      fd = _quotaLock(home);
      charge = _charge(home);
      corrupt = _hasCorrupt(home);
    }
    if (corrupt || charge + RESERVE > CEILING) {
      return false; // best-effort refuse
    }
    _writeEntry(home, activityId, RESERVE, 0); // durable
    return true;
  } catch (e) {
    return false; // durability/safety failure -> refuse
  } finally {
    if (fd !== null) _unlock(fd);
  }
}

// No reconcile/spawn here by design (brief: "keep it cheap; refusal is the required behavior,
// cleanup is admit's job"). Refuse-while-corrupt (spec §7) still applies unconditionally.
function grant(home, activityId, nbytes) {
  let fd = null;
  try {
    fd = _quotaLock(home);
    if (_hasCorrupt(home)) return false;
    const e = _readEntry(paths.ledgerEntryPath(home, activityId));
    if (e === CORRUPT) return false;
    if (e.granted + nbytes > ORDINARY_CAP) return false; // per-activity cap
    if (_charge(home) + nbytes > CEILING) return false; // global ceiling
    _writeEntry(home, activityId, e.reserved, e.granted + nbytes); // durable BEFORE append
    return true;
  } catch (e) {
    return false; // durability/safety failure -> refuse the append
  } finally {
    if (fd !== null) _unlock(fd);
  }
}

// Ruling B: Node cannot unlink, so settle is a NO-OP on the ledger. By the time a caller invokes
// settle(), the durable `terminal` record has already been appended to the segment (writer.js's
// job, mirroring writer.py's call ordering), so the entry is now "settled-pending": _onDisk
// already covers reserved+granted for that activity, so _charge's
// `max(0, reserved+granted-onDisk)` term for it drops to ~0 immediately -- the entry stops
// costing anything even though it is still physically present. The next Python
// reconcile/prune pass (admit's delegation, or a scheduled maintenance call) removes it for
// real. Provided for API-compat with the Python surface + writer.js's call sites; intentionally
// does not spawn Python (that would make every terminal write pay a subprocess round-trip;
// cleanup is admit's/the scheduled path's job, not settle's).
function settle(home, activityId) {
  void home;
  void activityId;
}

module.exports = {
  CEILING, RESERVE, PER_ACTIVITY_CAP, ORDINARY_CAP, CORRUPT,
  admit, grant, settle,
  _quotaLock, _unlock,
  _parseEntry, _readEntry, _writeEntry,
  _committed, _onDisk, _ledgerEntries, _charge, _hasCorrupt,
  _spawnPythonPrune,
  get PYTHON_BIN() { return PYTHON_BIN; },
  set PYTHON_BIN(v) { PYTHON_BIN = v; },
};
