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
//     Codex R7 B2 / Ruling 61: that delegation happens ONLY from a CERTAIN, NON-CORRUPT snapshot
//     that is merely over the ceiling (a measured shortfall). An uncertain or corrupt snapshot
//     refuses outright with NO prune delegation -- a floor/sentinel charge handed to the prune
//     loop deleted every prunable activity. Node's admission path therefore no longer triggers
//     corrupt-entry clearing at all; Python's own passes do.
//     Codex R7 B1 / Ruling 60: every locked decision is bound to the `quota/` directory's
//     dev+inode identity captured at lock time (Node has no dir fd) -- see `_quotaDirIdentity`.
//
// `admit`'s own pre-delegation charge/corrupt computation is therefore Node's ENTIRE "reconcile
// pass": strictly READ-ONLY (never synthesizes a terminal, never removes an entry). Only the
// separate `reconcile.js`'s `synthesizeTerminal` (Task 2.3's handoff-crash path) WRITES, and
// only appends a terminal record -- it too never removes the ledger entry.
//
// Codex Phase-2 gate, B3: two corrections layered on top of the above, still without violating
// Ruling B (Node still performs no destructive removal itself):
//   (a) the delegated `python -m repo_radar.activity.prune` spawn must resolve the SAME managed
//       venv interpreter + `repo_radar` package location the rest of the packaged app uses, not a
//       hardcoded dev-only `python3` + source-checkout root (see `configurePythonRunner` below).
//   (b) that spawn's exit status is now inspected -- a failed delegation is surfaced via a bounded
//       warn line (`_spawnPythonPrune`), not silently swallowed.
//   (c) `settle()` proactively (but still best-effort/never-raises) delegates a bounded reap so
//       the physical ledger entry doesn't linger indefinitely once its owner.lock is free -- that
//       reap (removing the ledger entry) is what actually zeroes a settled entry's outstanding
//       charge, once it lands.
//
// Codex Phase-2 gate, ROUND 2 (BLOCKER, fixed here): B3(c)'s original `_charge` also excluded a
// durable-terminal entry's reservation directly (a `_hasTerminal` check inside `_charge`). Codex
// R2 found that shortcut -- and the pre-existing two-scan `_committed`+`_onDisk` structure it sat
// on top of -- could each UNDERCOUNT a concurrent append landing mid-`_charge`, breaching the 64
// MiB ceiling. Both are fixed in `_charge` below: a single fstat scan per activity (reused for
// both the committed sum and the outstanding term) replaces the two-scan structure, and the
// `_hasTerminal` exclusion is removed entirely -- `_charge` is fstat-only again, and settlement is
// left entirely to `settle()`'s reap actually removing the ledger entry. See `_charge`'s own
// comment for the full accounting argument.
//
// Codex Phase-2 gate, ROUND 3 (BLOCKER, fixed here): a post-handoff cancel append
// (`control{cancel_requested}`) could race the owner's own terminal+settle reap and silently
// escape accounting (measured undercount 174). Fixed by `appendReserveIfLive`, which serializes
// its read-then-write against settlement under the SAME cross-process `quota.lock`. See that
// function's own comment for the full argument.
//
// Codex Phase-2 gate, ROUND 4 (BLOCKER, fixed here, "Fix-G"): the ROUND 3 fix used quota.lock's
// BLOCKING acquisition for that serialization, which put a potentially ~30s wait directly between
// Electron's cancel handler and `child.kill('SIGTERM')` -- a contended lock could freeze the main
// thread and delay/prevent cancellation (measured: a 1.5s held lock delayed SIGTERM by 1.511s).
// Activity observability must NEVER change sync/cancel behavior. Fixed by giving the cancel path
// (only) a NON-BLOCKING acquisition mode (`_quotaLockNonblocking`, `appendReserveIfLive`'s
// `{ nonblocking: true }` option) that skips the append outright on contention instead of waiting,
// plus (in trigger-glue.js) moving `child.kill('SIGTERM')` into an outer `finally` so it fires
// unconditionally regardless of any Activity-side failure. See `appendReserveIfLive`'s own
// comment for the full argument.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const paths = require('./paths');
const ids = require('./ids');
const parse = require('./parse');
const records = require('./records');

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
//
// This pair is the SOURCE-CHECKOUT DEFAULT/fallback only (Codex B3a): a bare `python3` off PATH
// plus this repo's own root only exists in a dev/test checkout. In a packaged Electron app there
// is no guaranteed system `python3`, and the `repo_radar` package does not live at
// `<electron-app>/../..` -- it ships under `process.resourcesPath/resources/repo_radar` (or, once
// the managed runtime has provisioned a generation, under that generation's own directory
// alongside its private `venv/`; see runtime/provision.js). `configurePythonRunner` below lets
// main.js (which alone has that Electron/packaging context) supply the REAL resolved
// interpreter+location once at startup; these two remain the fallback used whenever that hasn't
// happened (tests, direct `node menubar/main.js` from source, ...).
const REPO_ROOT = path.join(__dirname, '..', '..');
let PYTHON_BIN = 'python3';
const PRUNE_SPAWN_TIMEOUT_MS = 30000; // bounded -- generous for a reconcile+prune pass
const PRUNE_WARN_MAX_CHARS = 300; // bounded excerpt of a failed prune's stderr in the warn line

// Codex B3(a): the packaged-aware Python runner, configured once by main.js at startup via
// `configurePythonRunner({python, cwd, env})` -- quota.js is a pure Node module with no Electron
// context of its own, so it cannot reach `process.resourcesPath` or the managed-venv resolver
// (menubar/runtime/*) directly; the resolved values are threaded IN instead. `null` (the initial
// state, and what an invalid/falsy call resets to) means "not configured" -> `_resolvePythonRunner`
// falls back to the PYTHON_BIN/REPO_ROOT pair above, read at CALL time (not bind time) so a
// test's PYTHON_BIN monkeypatch still applies whenever no runner has been configured.
let _pythonRunner = null;

function configurePythonRunner(runner) {
  if (!runner || typeof runner !== 'object' || typeof runner.python !== 'string' || runner.python.length === 0) {
    _pythonRunner = null; // un-configure -> fall back to the source-checkout default
    return;
  }
  _pythonRunner = {
    python: runner.python,
    cwd: (typeof runner.cwd === 'string' && runner.cwd) ? runner.cwd : REPO_ROOT,
    env: (runner.env && typeof runner.env === 'object') ? { ...runner.env } : {},
  };
}

function _resolvePythonRunner() {
  if (_pythonRunner) return _pythonRunner;
  return { python: PYTHON_BIN, cwd: REPO_ROOT, env: { PYTHONPATH: REPO_ROOT } };
}

// Mirrors writer.js's own `_warn` (same prefix, same `console.error` sink) -- kept as an
// independent copy rather than a cross-require of writer.js, which would create a require cycle
// (writer.js already requires quota.js) -- the same duplicate-small-helper precedent used
// elsewhere in this subsystem.
function _warn(msg) {
  console.error(`repo-radar: activity: ${msg}`);
}

// Codex B3(b): a bounded, human-readable description of why a prune spawn failed, or null on
// success. Never reads unbounded output -- stdout is discarded entirely (`stdio[1] = 'ignore'`);
// only stderr is captured, and only a bounded excerpt of it is ever logged.
function _describeSpawnFailure(result) {
  if (!result) return 'no result';
  if (result.error) return `spawn error: ${result.error.message}`;
  if (result.signal) return `terminated by signal ${result.signal}`;
  if (typeof result.status !== 'number') return 'no exit status (timeout or spawn failure)';
  if (result.status !== 0) {
    let stderr = '';
    try { stderr = result.stderr ? result.stderr.toString('utf8').trim() : ''; } catch (e) { stderr = ''; }
    if (stderr.length > PRUNE_WARN_MAX_CHARS) stderr = `${stderr.slice(0, PRUNE_WARN_MAX_CHARS)}...(truncated)`;
    return `exited ${result.status}${stderr ? ` -- ${stderr}` : ''}`;
  }
  return null; // success
}

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

// NON-BLOCKING lockf on activity/quota.lock -- the exact `-t 0` mode lease.js's `_lockf` uses for
// owner.lock (Codex R4 fix, "Fix-G"): fails IMMEDIATELY (status 75/EX_TEMPFAIL) instead of
// waiting if quota.lock is currently held by another process, rather than blocking until it can
// acquire like `_lockfBlocking` above. This exists ONLY for the cancel path's best-effort ledger
// append (`appendReserveIfLive`'s `{ nonblocking: true }` mode) -- `admit`/`grant`/`settle`
// legitimately need to WAIT for exclusive access to the accounting ledger and keep using
// `_lockfBlocking`/`_quotaLock` unchanged. See `_quotaLockNonblocking` below for why the cancel
// path specifically must never wait on this lock.
function _lockfNonblocking(fd) {
  const r = spawnSync('/usr/bin/lockf', ['-t', '0', '3'], {
    stdio: ['ignore', 'ignore', 'ignore', fd],
    timeout: PRUNE_SPAWN_TIMEOUT_MS,
  });
  if (r.error || typeof r.status !== 'number') return null;
  return r.status;
}

// Codex R7 B1 / Ruling 60: the ledger directory's IDENTITY, bound to the lock hold. `_quotaLock`
// creates/validates `quota/` BEFORE acquiring quota.lock, and `paths.listOwnedEntriesDetailed`
// treats ENOENT as PROVEN "no ledgers yet" -- correct for an unlocked reader, but inside a locked
// decision an ENOENT means the directory was renamed/swapped AFTER the lock was taken (Codex
// repro: 16 x 4 MiB liabilities, rename `quota/` between lock and enumeration -> the snapshot saw
// no ledgers -> `admit` wrote a reservation -> 67,170,304 bytes > ceiling). Python closes this
// with a dir fd (descriptor-relative enumeration cannot be redirected); stock Node has no
// `openat`, so identity is preserved by INODE instead: at lock time the quota dir is `lstat`ed
// and `{ dev, ino }` recorded in the lock context; every locked accounting pass re-lstats the
// dir immediately before AND after enumeration, and `_writeEntry` re-verifies immediately
// before (and after) its temp+rename. ENOENT, a symlink, a non-directory, or a `{dev,ino}`
// mismatch -> the ledger is UNCERTAIN (never certain-empty) -> `admit`/`grant` refuse and no
// reservation is written. Unlocked readers (`_accountingSnapshot(home)` with no context) keep
// ENOENT = "no ledgers yet". A directory that is `lstat`-able as a real directory but NOT the
// one locked is exactly the swap this guards against.
// `label` is purely cosmetic (the error message) -- Codex R8 B1 / Ruling 64 reuses this same
// generic real-non-symlink-directory check for the activity ROOT too, not just `quota/` itself.
function _quotaDirIdentity(qdir, label = 'quota dir') {
  let st;
  try {
    st = fs.lstatSync(qdir);
  } catch (e) {
    const err = new paths.UnsafePath(`${label} identity: ${e.message}`);
    if (e.code === 'ENOENT') err.code = 'ENOENT';
    throw err;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new paths.UnsafePath(`${label} identity: ${qdir} is not a real directory`);
  }
  return { dev: st.dev, ino: st.ino };
}

// Codex R8 B1 / Ruling 64: the ONE canonical-identity re-verification helper -- checks BOTH
// bound identities a lock context now carries (`ident` for `quota/`, `rootIdent` for the
// activity root -- see `_bindLockContext`), never just the ledger dir the way the Round-7
// `_lockedQuotaDirIntact` this replaces did. A swap of the activity ROOT alone (leaving `quota/`
// itself untouched) is exactly as dangerous as a `quota/` swap: `_gatherAccounting`'s activity-dir
// enumeration walks the ROOT, not `quota/`, so a root swap could hide every measured activity's
// bytes from a locked decision while `quota/`'s own identity stayed intact. True iff BOTH
// directories are still real, non-symlink directories at their original dev+inode. Never throws --
// any lstat failure (ENOENT/EACCES/ELOOP) or an identity mismatch is UNCERTAIN, i.e. `false`.
function _verifyCanonical(ctx) {
  if (!ctx || typeof ctx !== 'object' || !ctx.ident || !ctx.rootIdent) return false;
  try {
    const id = _quotaDirIdentity(ctx.dir);
    if (id.dev !== ctx.ident.dev || id.ino !== ctx.ident.ino) return false;
    const rootId = _quotaDirIdentity(path.dirname(ctx.dir), 'activity root');
    if (rootId.dev !== ctx.rootIdent.dev || rootId.ino !== ctx.rootIdent.ino) return false;
    return true;
  } catch (e) {
    return false; // ENOENT (renamed away), symlink/non-dir (swapped), or lstat refused
  }
}

// Opens (creating if needed) + locks quota.lock; validates it's a regular file (fail closed on
// a swapped component, mirroring Python's S_ISREG check) via paths.openOwnedRegular, which
// already does this. Returns the LOCK CONTEXT `{ fd, dir, ident: {dev,ino}, rootIdent: {dev,ino} }`
// -- the held fd plus the identity of BOTH `quota/` and the activity root, captured AT LOCK TIME
// (Ruling 60/64, below); every locked accounting/write path threads this context through so it
// can re-verify identity via `_verifyCanonical`. Throws (UnsafePath / OSError-equivalent) on
// failure -- callers (admit/grant/settle) catch broadly and fail closed to false/no-op.
//
// Codex R8 B1 / Ruling 64 (BLOCKER): the Round-7 version captured identity ONLY AFTER
// `_lockfBlocking` returned -- i.e. only after the WAIT for a contended lock had already
// completed. Codex's real-process repro: hold `quota.lock` in another process; while THIS
// process blocks waiting for it, swap the entire `quota/` directory for a fresh empty one; once
// the wait ends and the lock is acquired, `_bindLockContext` lstats whatever is NOW at that path
// -- the swapped-in empty directory -- and binds ITS identity, fresh, so it reads as "intact" for
// the rest of the decision. Every one of 16 x 4 MiB real liabilities in the moved-aside directory
// vanished from the snapshot (measured: canonical charge 61,440 vs the authorized liability
// 67,170,304). The wait itself was therefore an UNBOUNDED unguarded window -- arbitrarily long,
// entirely under another holder's control.
//
// Fixed by capturing identity of BOTH `quota/` AND the activity root BEFORE opening/waiting on
// the lock at all (`preIdent`/`preRootIdent` below), then AGAIN once the lock is actually held
// (`_bindLockContext`), and comparing the two: any ENOENT/symlink/non-dir/mismatch on either
// directory, at either end, fails the ACQUISITION itself (release, close, throw) -- exactly like
// a lockf status failure -- so a swap landing anywhere in the wait window is caught before the
// lock context is ever handed to a caller, not discovered later against a compromised baseline.
function _quotaLock(home) {
  const qdir = paths.quotaDir(home);
  const rootDir = path.dirname(qdir);
  paths.secureMkdir(qdir); // ensures activity/ + quota/ exist

  // Pre-wait identity: nothing is held yet, so a failure here (e.g. `quota/` already a symlink)
  // just propagates -- there is nothing to release.
  const preIdent = _quotaDirIdentity(qdir);
  const preRootIdent = _quotaDirIdentity(rootDir, 'activity root');

  const lockPath = _quotaLockPath(home);
  const fd = paths.openOwnedRegular(lockPath, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o600);
  // Self-reference (`module.exports`, not a bare call): the ONE test seam this mirrors -- a
  // regression test can stub `quota._lockfBlocking` to swap `quota/` out from under the wait,
  // proving the pre/post comparison below actually catches it (Codex R8 regression tests).
  const status = module.exports._lockfBlocking(fd);
  if (status !== 0) {
    fs.closeSync(fd);
    throw new Error(`quota.lock: lockf did not report success (status=${status})`);
  }
  return _bindLockContext(fd, qdir, rootDir, preIdent, preRootIdent);
}

// Captures `quota/`'s and the activity root's identity again, now that the lock is actually
// held, and compares each against the PRE-wait identity `_quotaLock`/`_quotaLockNonblocking`
// captured before opening/waiting on the lock (Ruling 64). Either directory gone, replaced by a
// symlink, or swapped for a DIFFERENT real directory at any point during the wait -> the lock
// protects nothing meaningful -> FAIL the acquisition (release the just-acquired lock, close the
// fd, throw) exactly like a lockf status failure. On success, returns the lock context with BOTH
// bound identities threaded through so every locked accounting/write/delegation path can
// re-verify via `_verifyCanonical`.
function _bindLockContext(fd, qdir, rootDir, preIdent, preRootIdent) {
  let postIdent;
  let postRootIdent;
  try {
    postIdent = _quotaDirIdentity(qdir);
    postRootIdent = _quotaDirIdentity(rootDir, 'activity root');
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
  if (postIdent.dev !== preIdent.dev || postIdent.ino !== preIdent.ino
      || postRootIdent.dev !== preRootIdent.dev || postRootIdent.ino !== preRootIdent.ino) {
    fs.closeSync(fd);
    throw new paths.UnsafePath('quota dir or activity root changed identity across the lock wait; refusing acquisition (Ruling 64)');
  }
  return { fd, dir: qdir, ident: postIdent, rootIdent: postRootIdent };
}

// Codex R4 (BLOCKER, "Fix-G"): the NON-BLOCKING sibling of `_quotaLock`, used ONLY by
// `appendReserveIfLive`'s `{ nonblocking: true }` mode (the cancel path). The R3 fix above made
// `appendReserveIfLive` correct for the undercount invariant by serializing its decision+write
// against settlement under the BLOCKING `quota.lock` -- but Codex found that blocking acquisition
// sits directly in `onCancel`'s path to `child.kill('SIGTERM')`: a contended lock (settlement or
// a prune pass can hold it for up to the ~30s spawn timeout) freezes Electron's main thread and
// delays/prevents cancellation. Repro: holding quota.lock 1.5s in another process delayed
// onCancel's SIGTERM by 1.511s. Activity observability must NEVER change sync/cancel behavior.
//
// Returns the held fd on a FREE lock (acquired), or `null` on BUSY (contended) -- deliberately
// NEVER waits, unlike `_quotaLock`. `null` is also returned for a spawn/status anomaly (`_lockf`
// treats "can't tell" the same as busy here: skipping a best-effort append is always safe, so
// there is no reason to risk any wait). A genuine setup failure (bad `home`, unsafe path, mkdir
// failure) still THROWS here exactly like `_quotaLock` -- that is a real error, not contention,
// and the caller (`appendReserveIfLive`) already wraps the whole acquisition in a try/catch that
// treats any thrown error the same as "could not confirm live" (skip, never raise).
function _quotaLockNonblocking(home) {
  const qdir = paths.quotaDir(home);
  const rootDir = path.dirname(qdir);
  paths.secureMkdir(qdir); // ensures activity/ + quota/ exist

  // Ruling 64: same pre-wait capture as the blocking variant, even though this variant never
  // actually waits -- a genuine setup failure here (bad `home`, unsafe path) still throws exactly
  // like `_quotaLock`, per this function's existing contract (see the header comment above).
  const preIdent = _quotaDirIdentity(qdir);
  const preRootIdent = _quotaDirIdentity(rootDir, 'activity root');

  const lockPath = _quotaLockPath(home);
  const fd = paths.openOwnedRegular(lockPath, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o600);
  const status = _lockfNonblocking(fd);
  if (status !== 0) {
    fs.closeSync(fd);
    return null; // BUSY (75) or any other non-success -- skip immediately, never wait
  }
  return _bindLockContext(fd, qdir, rootDir, preIdent, preRootIdent); // Ruling 64: same post-acquisition re-verify as the blocking variant
}

// Bare close -- stock Node has no flock(2) binding, so (like lease.js) there is no separate
// "unlock" verb; closing Node's sole retained fd on the OFD drops the flock. `_quotaLock` always
// opens a FRESH fd per call and nothing else in this module retains a second reference, so this
// is a true full release, not the shared-OFD caveat lease.js documents for a live child.
// Accepts the lock context `_quotaLock` returns (or a bare fd, for symmetry with older callers).
//
// Codex R8 I3 / Ruling 66: this function itself must NEVER throw -- `admit`/`grant` used to call
// it unguarded (only `appendReserveIfLive` already wrapped it), so a release/close failure at
// exactly the wrong moment (e.g. after a reservation was already durably written) could replace
// an already-decided, already-persisted `true` result with an escaping exception instead. There
// is only ONE underlying release primitive on this platform -- closing the fd IS the lock release
// (see the paragraph above, and lease.js's `release()` comment: no separate flock(2) LOCK_UN
// exists to call first) -- so "attempt the release, then the close, each contained" collapses to
// one attempt here; every caller nonetheless ALSO wraps its own call to this function (see
// admit/grant/settle below) as a second, independent backstop, matching Fix-G's existing
// belt-and-suspenders pattern for this exact call.
function _unlock(ctx) {
  const fd = typeof ctx === 'number' ? ctx : (ctx && typeof ctx.fd === 'number' ? ctx.fd : null);
  if (fd === null) return; // nothing to release
  try {
    fs.closeSync(fd);
  } catch (e) {
    // best-effort: a stuck/failed release/close must never escape past this function (Ruling 66).
  }
}

// Validates the ledger's FULL invariant (mirrors Python's `_parse_entry` exactly): counters must
// be EXACT non-boolean integers (strings/floats -> CORRUPT), `reserved` exactly RESERVE,
// `granted >= 0`, total <= cap.
//
// Codex R5 I4 / Ruling 52: the bytes are decoded with the STRICT decoder every other read path
// uses (`records.decodeUtf8Fatal`, Ruling 47) -- `Buffer.toString('utf8')` is lossy (an invalid
// byte becomes U+FFFD), so a ledger file carrying a raw 0xff in an ignored field parsed as VALID
// here while Python's `json.loads` classified it CORRUPT. Any decode error, JSON error or shape
// failure is CORRUPT. The decoder retains a leading BOM (U+FEFF), which `JSON.parse` rejects --
// matching Python's "Unexpected UTF-8 BOM" JSONDecodeError. Parity is pinned by
// `__tests__/ledger-parity.test.js` against the Python-authored `ledger_vectors.json`.
//
// G5-Node2: parsed via `records.parseJsonStrictIntegers` (keys `reserved`/`granted`), not a bare
// `JSON.parse` -- a non-integer literal (`1.0`, `1e3`) throws `InvalidRecord`, caught below and
// classified CORRUPT, matching Python's `isinstance(v, int)` rejection of the equivalent `float`
// (fixture case `float-granted` in `ledger_vectors.json`).
function _parseEntry(dataBuf) {
  let d;
  try {
    const text = Buffer.isBuffer(dataBuf) ? records.decodeUtf8Fatal(dataBuf) : String(dataBuf);
    d = records.parseJsonStrictIntegers(text, ['reserved', 'granted']);
  } catch (e) {
    return CORRUPT; // invalid UTF-8 (TypeError), invalid JSON (SyntaxError), or non-integer literal
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
//
// Codex R7 B1 / Ruling 60: when called under a lock context (`admit`/`grant` always are), the
// quota dir's identity is re-verified IMMEDIATELY before the temp+rename (a renamed/swapped
// `quota/` -> throw, no write) and again after it (a swap that landed mid-write leaves a stray
// entry in the wrong directory -- an overcount at worst, never an undercount -- and the decision
// is still refused so no append is authorized against it). The temp+rename itself targets the
// verified validated path; Node has no `renameat`, so this pre/post identity pair is the
// closest stock Node gets to Python's dir-fd-relative write. Without a context (no caller today)
// the write is unguarded, as before.
function _writeEntry(home, activityId, reserved, granted, lockCtx) {
  if (!ids.validActivityId(activityId)) {
    throw new paths.UnsafePath(`invalid activity_id for ledger path: ${JSON.stringify(activityId)}`);
  }
  const blob = Buffer.from(JSON.stringify({ reserved, granted }), 'utf8');
  const qdir = paths.quotaDir(home);
  if (lockCtx !== undefined && lockCtx !== null) {
    if (lockCtx.dir !== qdir || !_verifyCanonical(lockCtx)) {
      throw new paths.UnsafePath('quota dir or activity root changed identity under the lock; refusing ledger write (Ruling 60/64)');
    }
  } else {
    paths.secureMkdir(qdir);
  }
  paths.writeOwnedFileAtomic(qdir, `${activityId}.json`, blob, 0o600);
  if (lockCtx !== undefined && lockCtx !== null && !_verifyCanonical(lockCtx)) {
    throw new paths.UnsafePath('quota dir or activity root changed identity during ledger write; refusing (Ruling 60/64)');
  }
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
//
// Codex R6 B1 / Ruling 54: enumerated through `paths.listOwnedEntriesDetailed`, whose
// `uncertain` says the ledger dir EXISTS but could not be listed (EIO / EACCES / ELOOP / a non-dir
// squatting on `quota/`). The lossy `listOwnedEntries` collapsed that to `[]` -- "no ledgers" --
// so every outstanding reservation vanished from the charge during a transient failure and a new
// reservation was admitted (Codex repro: 67,170,304 bytes after restore). A MISSING quota dir
// (ENOENT) is still proven "no ledgers yet" -- for an UNLOCKED reader. `_ledgerEntries` is the
// `.entries`-only wrapper.
//
// Codex R7 B1 / Ruling 60: under a lock context (`lockCtx` from `_quotaLock`) the ledger dir's
// identity is re-verified immediately BEFORE enumeration and again AFTER it: the dir the lock
// was bound to must still be the real directory at that path (same dev+ino). ENOENT / symlink /
// non-dir / mismatch at either check -> `{ entries: [], uncertain: true }` -- a post-lock ENOENT
// is a rename/swap, never "no ledgers yet". The post-check covers the residual window between
// the pre-check and `readdir` (Node has no dir fd to enumerate through).
function _ledgerEntriesDetailed(home, lockCtx) {
  const qdir = paths.quotaDir(home);
  const locked = lockCtx !== undefined && lockCtx !== null;
  if (locked && (lockCtx.dir !== qdir || !_verifyCanonical(lockCtx))) {
    return { entries: [], uncertain: true };
  }
  const listing = paths.listOwnedEntriesDetailed(qdir, '.json');
  if (locked && !_verifyCanonical(lockCtx)) {
    return { entries: [], uncertain: true };
  }
  const entries = [];
  for (const name of listing.entries) {
    const aid = name.slice(0, -5); // strip ".json"
    if (ids.validActivityId(aid)) {
      entries.push([aid, _readEntry(paths.ledgerEntryPath(home, aid))]);
    }
  }
  return { entries, uncertain: Boolean(listing.uncertain) };
}

function _ledgerEntries(home) {
  return _ledgerEntriesDetailed(home).entries;
}

// Whether activity `aid` has a durable `terminal` record in its segments. A bounded CONTENT read
// (unlike `_onDisk`'s fstat-only sizing, which the I7 fix protects) -- but bounded to at most one
// activity's segments per ledger entry, of which there are at most a ceiling-bounded number
// (spec's own admission cap), so this is acceptable lifecycle-data reading, distinct from the
// per-record sizing path.
//
// Codex R2: this is intentionally NOT called from `_charge` anymore -- a terminal becoming
// VISIBLE here mid-`_charge` (readable, but not proven fsync-durable) was a second undercount
// path when `_charge` used it to zero out a live entry's reservation (see `_charge`'s comment).
// Kept for callers that need pure lifecycle introspection (and exercised directly by tests).
//
// Ruling 41 / Codex G3-Node2: segment bytes are parsed via `parse.parseSegment` -- the ONE
// implementation of the line-split + trailing-line rule (an unterminated final line is ignored
// unconditionally, even when it happens to be valid JSON; the durability contract is
// record+`\n`). A private byte-split here previously accepted a newline-less-but-parseable
// terminal that `parse.js`'s callers (reconcile.js, read.js) would ignore, so this introspection
// helper could disagree with the rest of the subsystem about whether a terminal existed.
//
// Codex R4 B2 / Ruling 46: only CONFORMING segment names are parsed (`paths.parseSegmentName`,
// the same filter reconcile.js/read.js apply) -- a `junk.jsonl` holding a terminal is not a
// segment and must not satisfy this helper.
function _hasTerminal(home, aid) {
  for (const seg of paths.readOwnedSegments(paths.activityDir(home, aid))) {
    if (paths.parseSegmentName(seg.name) === null) continue; // bad-name: never parsed
    for (const rec of parse.parseSegment(seg.data, aid).records) {
      if (rec.type === 'terminal') return true;
    }
  }
  return false;
}

// Codex R2 fix (fix-review round 2 BLOCKER): SINGLE fstat scan per activity, reused for BOTH the
// committed sum and the per-entry outstanding term. The prior version called _committed(home)
// (one scan of every activity's segments) and then, separately, _onDisk(home, aid) per ledger
// entry (a SECOND scan of just that activity's segments) -- two scans of the SAME activity at two
// DIFFERENT times. A concurrent writer's append (writers release quota.lock before appending)
// landing between those two scans was excluded from `committed` (scanned before the append) AND
// subtracted out of `outstanding` via the stale-vs-fresh mismatch (scanned after) -- a
// double-miss undercount (measured repro: charged 498 vs committed 687). Scanning each activity
// exactly once and reusing that one value for both terms makes an append either fully counted or
// fully deferred to the NEXT _charge() call -- it can never be split across the two. Per-activity
// result is always Math.max(size, reserved+granted), the same conservative liability as before
// for the non-interleaved case -- never an undercount.
//
// This ALSO removes the `_hasTerminal` reservation-exclusion Fix-B/B3(c) previously added here:
// that exclusion was a SECOND, independent undercount path -- a terminal record can become
// VISIBLE (readable) between this function's committed scan and the `_hasTerminal` content scan,
// so the terminal's bytes were missed by `committed` AND its whole reservation was dropped by the
// exclusion (measured repro: charged 498 vs committed 687). Codex: terminal *visibility* alone is
// not proof of durability and must never be treated as settlement. `_charge` is fstat-only again
// as a result (never calls `_hasTerminal`'s content read). Settlement is instead handled entirely
// by `settle()`'s existing delegated, durability-gated reap: once the reap actually REMOVES the
// ledger entry, it simply no longer appears in `_ledgerEntries(home)` and contributes 0 here --
// naturally, not via an exclusion. A durable-but-not-yet-reaped entry now charges conservatively
// (Math.max(size, reserved+granted)) -- an overcount, never an undercount. `_hasTerminal` itself
// is kept (not removed) for lifecycle introspection/tests; it is simply no longer called here.
//
// Codex R4 B1 / Ruling 45: an activity dir that EXISTS but cannot be measured (chmod 000, ELOOP,
// an entry whose lstat is refused -- `paths.statOwnedSegmentsDetailed`'s `uncertain`) used to
// contribute 0 here, exactly the Ruling-40 undercount one level up (Codex's repro: 16 x 4 MiB
// settled, chmod 000 one dir -> charge 60 MiB -> a reservation admitted -> restore -> 67,170,304
// bytes on disk > ceiling). Such an activity is now charged its MAXIMUM liability,
// PER_ACTIVITY_CAP -- the same max-liability rule a torn/corrupt ledger entry gets below -- so the
// charge can never drop below the bytes that may actually be there. (An activity dir that is
// proven absent -- ENOENT -- still contributes 0, as before.) `admit`/`grant` additionally refuse
// outright while any activity is unmeasurable (see `_accountingUncertain`), since a max-liability
// guess is a floor for the charge, not a measurement.
//
// Codex R5 B1+I3 / Rulings 49+50: ONE accounting snapshot. `_charge` and `_accountingUncertain`
// used to rescan the filesystem separately, so a staged transition (an activity unmeasurable
// during one scan, measurable during the other) let a decision combine the 4 MiB fallback from
// one scan with `uncertain:false` from the other. And both iterated the LOSSY
// `paths.listOwnedSubdirs`, which silently dropped a UUID-shaped root entry whose lstat failed
// with a non-ENOENT error (Codex injected EIO on one of 16 x 4 MiB settled -> charge 60 MiB,
// `uncertain:false`, admitted, restore -> 67,170,304 bytes > ceiling). `_accountingSnapshot`
// below is the single implementation: one detailed root enumeration (root uncertainty folds in;
// every activity-shaped entry refused for a reason other than 'gone' is charged its maximum
// liability, and a root that exists but cannot be listed at all floors the charge at the
// ceiling), one ledger pass (corrupt -> max liability), and EXACTLY ONE
// `statOwnedSegmentsDetailed` per listed activity. `admit`/`grant` consume `charge`, `corrupt`
// and `uncertain` from the SAME snapshot; `_charge`/`_accountingUncertain` are thin wrappers
// kept for their callers/tests.
//
// Codex R6 B1+I4 / Rulings 54+56: split into `_gatherAccounting` (ALL the I/O, one pass -- the
// `statOwnedSegmentsDetailed` hook seam the interleaving/cancel-settle/staged tests wrap is still
// the one call per listed activity) and the PURE `_computeSnapshot` (no I/O, shared
// vector-driven charge arithmetic; see `accounting-parity.test.js` and the Python mirror
// `quota._compute_snapshot`). Two divergences from Python were normalized away:
//   - a REJECTED valid-activity-id root entry (EIO on its lstat) was charged PER_ACTIVITY_CAP AND
//     its live ledger liability (`reserved+granted - 0`): 4,255,844 on Node vs Python's
//     4,194,304 for the same disk state. Now an UNCERTAIN activity is charged EXACTLY
//     PER_ACTIVITY_CAP -- its maximum liability already covers any reservation.
//   - an unlistable root floored the charge at CEILING only when no root entry was rejected,
//     while Python reported 0. Now an unlistable root OR ledger dir is EXACTLY CEILING (and
//     uncertain) on both sides.
//
// Codex R7 I3 / Ruling 62 (REPLACES the Round-6 arithmetic above; Python implements the identical
// rule): measured bytes are NEVER discarded. `_gatherAccounting` used to null an activity's
// measurement the moment its scan came back uncertain, so a directory whose entries HAD been
// sized (a later entry's lstat refused, say) lost every byte it had proven and was replaced by
// the flat PER_ACTIVITY_CAP guess -- an undercount whenever the proven bytes exceeded the cap.
// Every activity now carries `{ onDisk: number, uncertain: boolean }` -- `onDisk` is the partial
// sum of the entries that DID stat (0 if none), `uncertain` says the sum may be incomplete
// (`paths.statOwnedSegmentsDetailed` returns the entries it did stat even when `uncertain`).
//
// Gathered inputs (the v2 shape `accounting_vectors.json` describes, camelCased):
//   { rootListable, ledgerListable,
//     activities: [{ aid, onDisk: int, uncertain: bool }],  // listed activity dirs; partial bytes
//     rejectedRootIds: [aid],                                // valid-activity-id root entries refused (not 'gone')
//     ledger: [{ aid, reserved, granted } | { aid, corrupt: true }] }
//
// `lockCtx` (Ruling 60): the lock context from `_quotaLock`, threaded through to
// `_ledgerEntriesDetailed` so a locked decision re-verifies the ledger dir's identity around its
// enumeration. Omitted for unlocked readers.
function _gatherAccounting(home, lockCtx) {
  const base = path.dirname(paths.quotaDir(home));
  const root = paths.listOwnedSubdirsDetailed(base);
  const activities = [];
  for (const name of root.subdirs) {
    if (name === 'quota') continue;
    const scan = paths.statOwnedSegmentsDetailed(path.join(base, name)); // ONE scan per activity
    let size = 0;
    for (const seg of scan.entries) size += seg.size; // partial measurement is KEPT when uncertain
    activities.push({ aid: name, onDisk: size, uncertain: Boolean(scan.uncertain) });
  }
  const rejectedRootIds = [];
  for (const rj of root.rejected) {
    if (rj.reason !== 'gone') rejectedRootIds.push(rj.name); // proven gone hides nothing
  }
  // `listOwnedSubdirsDetailed.uncertain` covers BOTH "the base could not be validated/listed"
  // (early return: `subdirs` and `rejected` both empty) AND "an activity-shaped entry was refused"
  // (the base WAS listed; the entry is in `rejected`). Only the former is "root unlistable" here --
  // the latter is per-activity uncertainty (`rejectedRootIds`), charged max(0, CAP) each.
  const rootListable = !(root.uncertain && rejectedRootIds.length === 0);
  const led = _ledgerEntriesDetailed(home, lockCtx);
  const ledger = [];
  for (const [aid, e] of led.entries) {
    ledger.push(e === CORRUPT ? { aid, corrupt: true } : { aid, reserved: e.reserved, granted: e.granted });
  }
  return {
    rootListable, ledgerListable: !led.uncertain,
    activities, rejectedRootIds, ledger,
  };
}

// PURE (Ruling 62 -- the ONE charge rule, identical in Python's `quota._compute_snapshot`; fixture
// parity in `accounting-parity.test.js`). With `measured(aid)` = the activity's (possibly
// partial) on-disk bytes (0 if it was never listed):
//   CORRUPT-ledger aid:   measured + PER_ACTIVITY_CAP           (checked first: a corrupt entry's
//                                                                aid is charged this way even if
//                                                                its scan was also uncertain)
//   UNCERTAIN aid:        max(measured, PER_ACTIVITY_CAP)       (rejected at the root for a
//                                                                non-gone reason, or its scan was
//                                                                uncertain) -- NO ledger liability
//   certain aid:          measured + (max(0, reserved+granted - measured) if live non-corrupt
//                                                                entry else 0)
//   unlistable ledger dir: max(SUM measured over every activity (as certain, no liabilities),
//                              CEILING), uncertain
//   unlistable root:       max(SUM (reserved+granted) over live entries + SUM corrupt caps,
//                              CEILING), uncertain
//   uncertain = !rootListable || !ledgerListable || any activity uncertain || any rejected root id;
//   corrupt   = any corrupt ledger entry.
// `constants` (CEILING / PER_ACTIVITY_CAP) defaults to module state; the vector driver overrides.
function _computeSnapshot(inputs, constants) {
  const ceiling = constants && constants.CEILING !== undefined ? constants.CEILING : CEILING;
  const cap = constants && constants.PER_ACTIVITY_CAP !== undefined ? constants.PER_ACTIVITY_CAP : PER_ACTIVITY_CAP;

  const corrupt = inputs.ledger.some((e) => e.corrupt === true);
  const measured = new Map(); // aid -> partial or full on-disk bytes
  const uncertainIds = new Set(inputs.rejectedRootIds);
  for (const a of inputs.activities) {
    const bytes = Number.isFinite(a.onDisk) ? a.onDisk : 0;
    measured.set(a.aid, (measured.get(a.aid) || 0) + bytes);
    if (a.uncertain === true || a.onDisk === null || a.onDisk === undefined) uncertainIds.add(a.aid);
  }
  const uncertain = !inputs.rootListable || !inputs.ledgerListable || uncertainIds.size > 0;

  const live = new Map(); // aid -> reserved+granted (non-corrupt entries only)
  const corruptIds = new Set();
  for (const e of inputs.ledger) {
    if (e.corrupt === true) corruptIds.add(e.aid);
    else live.set(e.aid, e.reserved + e.granted);
  }

  if (!inputs.rootListable) {
    let liabilities = 0;
    for (const v of live.values()) liabilities += v;
    liabilities += corruptIds.size * cap;
    return { charge: Math.max(liabilities, ceiling), uncertain, corrupt };
  }
  if (!inputs.ledgerListable) {
    let bytes = 0;
    for (const v of measured.values()) bytes += v;
    return { charge: Math.max(bytes, ceiling), uncertain, corrupt };
  }

  const aids = new Set([...uncertainIds, ...measured.keys(), ...live.keys(), ...corruptIds]);
  let charge = 0;
  for (const aid of aids) {
    const disk = measured.get(aid) || 0;
    if (corruptIds.has(aid)) { charge += disk + cap; continue; }
    if (uncertainIds.has(aid)) { charge += Math.max(disk, cap); continue; }
    charge += disk;
    if (live.has(aid)) charge += Math.max(0, live.get(aid) - disk);
  }
  return { charge, uncertain, corrupt };
}

function _accountingSnapshot(home, lockCtx) {
  return _computeSnapshot(_gatherAccounting(home, lockCtx));
}

function _charge(home) {
  return _accountingSnapshot(home).charge;
}

// spec §7: whether ANY ledger entry is currently untrustworthy. Used to fail-closed refuse new
// admissions/grants while it stands.
function _hasCorrupt(home) {
  return _ledgerEntries(home).some(([, e]) => e === CORRUPT);
}

// Ruling 45 / Ruling 49: whether ANY committed activity's bytes are currently unmeasurable (its
// dir exists but cannot be validated/listed, an entry's lstat was refused, or the Activity root
// itself hid an activity-shaped entry). While this stands `admit` and `grant` refuse best-effort,
// exactly like `_hasCorrupt` (no throw; bounded warn; sync itself is unaffected) -- an admission
// decided against a guessed floor could still overrun the ceiling once the bytes become
// measurable again. A dir proven absent (ENOENT) is NOT uncertain. Thin wrapper over
// `_accountingSnapshot` (Ruling 50) -- `admit`/`grant` never call this and `_charge` separately.
function _accountingUncertain(home) {
  return _accountingSnapshot(home).uncertain;
}

// Best-effort delegation to the Python prune entrypoint, via whichever runner is currently
// resolved (Codex B3a: the configured packaged/managed-venv runner, or the source-checkout
// PYTHON_BIN/REPO_ROOT fallback). NEVER throws (spawnSync doesn't throw for a nonzero exit /
// spawn failure / timeout -- it reports via the result object): admit re-evaluates charge/corrupt
// from disk regardless of whether the spawn succeeded, failed to find the binary, or timed out.
// `home` becomes the child's HOME env var so Python's `Path.home()` (which prune.py's CLI
// entrypoint uses) resolves to the exact same directory Node is operating on -- required for
// tests (a tmp dir), harmless in production (already the real home).
//
// Codex B3(b): unlike the old fire-and-forget call, the result is now inspected -- a nonzero
// exit, missing interpreter, signal death, or timeout is surfaced via a bounded `_warn(...)` line
// (stdout is still discarded; only a truncated stderr excerpt is ever logged) so an operator can
// tell WHY a corrupt ledger stays wedged, instead of the failure being silently swallowed. The
// fail-closed behavior itself is unchanged: callers (admit/settle) still just re-evaluate from
// disk and never see this failure as a thrown exception.
function _spawnPythonPrune(home, headroomBytes) {
  const runner = _resolvePythonRunner();
  const result = spawnSync(
    runner.python,
    ['-m', 'repo_radar.activity.prune', String(Math.max(0, Math.trunc(headroomBytes)))],
    {
      cwd: runner.cwd,
      env: { ...process.env, ...runner.env, HOME: String(home) },
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: PRUNE_SPAWN_TIMEOUT_MS,
    },
  );
  const problem = _describeSpawnFailure(result);
  if (problem) _warn(`python prune delegation failed: ${problem}`);
  return result;
}

// Task 3.5: sibling of `_spawnPythonPrune` that invokes the §7 age/newest-50 retention entrypoint
// (`python -m repo_radar.activity.retain`) instead of the ceiling-only `prune`. Same configured
// runner seam (Codex B3a), same cwd/env/HOME/timeout/stdio shape, same bounded-warn-on-failure
// contract (B3b) -- Node's role here is STRICTLY to spawn; it performs no filesystem deletion of
// its own (Ruling B). No byte-count argument (retain's matrix is age/count-driven, not a headroom
// request). Deliberately NOT wired to any cadence/timer here -- Task 5.2 owns when this is called.
function _spawnPythonRetain(home) {
  const runner = _resolvePythonRunner();
  const result = spawnSync(
    runner.python,
    ['-m', 'repo_radar.activity.retain'],
    {
      cwd: runner.cwd,
      env: { ...process.env, ...runner.env, HOME: String(home) },
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: PRUNE_SPAWN_TIMEOUT_MS,
    },
  );
  const problem = _describeSpawnFailure(result);
  if (problem) _warn(`python retain delegation failed: ${problem}`);
  return result;
}

// `lease` mirrors Python's admit(home, activity_id, lease) signature for call-site symmetry
// (writer.js will call this with the lease it just acquired, exactly as writer.py does) but,
// like the current Python, does not itself inspect it -- kept for API compatibility.
//
// Codex R7 B2 / Ruling 61: NO destructive pruning under uncertainty. `admit` used to delegate
// `_spawnPythonPrune` whenever the snapshot was `uncertain` OR `corrupt` OR over the ceiling --
// but an uncertain snapshot's charge is a FLOOR (a ceiling sentinel / max-liability guess), not
// a measurement, and Python's prune loop, handed that constant, kept deleting prunable
// activities until nothing was left (the headroom it was chasing could never be reached). Prune
// is now delegated ONLY when the snapshot is certain AND non-corrupt AND merely over the ceiling
// (a real, measured shortfall). `uncertain || corrupt` -> refuse admission outright: fail closed
// with a bounded warn, NO delegation. A corrupt entry is therefore no longer cleared by Node's
// admission path at all -- Python's own admission/retention passes (which run their B2
// reconcile under their own lock and their own certainty check) remain the only clearers.
//
// Ruling 60: the whole decision runs against the lock context `_quotaLock` returned -- the
// snapshot re-verifies the ledger dir's identity around enumeration, and `_writeEntry`
// re-verifies immediately before/after the reservation write. A swap at any of those points ->
// uncertain / throw -> refused, no reservation written.
function _refuseNonDecidable(snap, what) {
  if (snap.uncertain) {
    _warn(`quota: accounting is uncertain (an activity or the ledger dir is unmeasurable); refusing ${what} without pruning (Ruling 61)`);
    return true;
  }
  if (snap.corrupt) {
    _warn(`quota: a corrupt ledger entry stands; refusing ${what} without pruning (Ruling 61)`);
    return true;
  }
  return false;
}

function admit(home, activityId, lease) {
  void lease;
  let ctx = null;
  try {
    ctx = _quotaLock(home);
    // Self-reference (`module.exports`, not a bare call): a test seam so a regression test can
    // observe the EXACT return value of a genuine snapshot, then mutate `quota/`/root identity
    // before this call's caller (below) gets to act on it -- proving the Ruling-64 check right
    // below actually protects the delegation window, not just the enumeration window Ruling 60
    // already covered.
    let snap = module.exports._accountingSnapshot(home, ctx); // Ruling 50: ONE snapshot per decision
    if (_refuseNonDecidable(snap, 'admission')) return false; // Ruling 61: no prune delegation
    if (snap.charge + RESERVE > CEILING) {
      // Codex R8 B1 / Ruling 64: re-verify identity ONE MORE TIME, immediately before releasing
      // the lock to delegate -- `snap` above proved the decision was certain/non-corrupt/over-
      // ceiling AT THE MOMENT it was gathered, but nothing yet has re-checked identity since. A
      // swap landing in the (tiny but real) gap between that snapshot returning and this branch
      // running would otherwise hand Python's prune loop a headroom figure computed against a
      // directory this process no longer actually has locked -- refuse instead, exactly like an
      // uncertain/corrupt snapshot.
      if (!_verifyCanonical(ctx)) {
        _warn('quota: accounting identity changed under the lock; refusing admission without pruning (Ruling 64)');
        return false;
      }
      // certain, non-corrupt, merely over the ceiling: a MEASURED shortfall -> delegate prune
      const headroom = snap.charge + RESERVE - CEILING;
      try { _unlock(ctx); } catch (e) { /* Ruling 66: best-effort cleanup must never replace this decision */ }
      ctx = null;
      _spawnPythonPrune(home, headroom); // release -> spawn -> (below) re-acquire -> re-evaluate
      ctx = _quotaLock(home);
      snap = module.exports._accountingSnapshot(home, ctx); // FRESH unified snapshot -- never mixed with the first
      if (_refuseNonDecidable(snap, 'admission')) return false;
      if (snap.charge + RESERVE > CEILING) return false; // best-effort refuse
    }
    _writeEntry(home, activityId, RESERVE, 0, ctx); // durable; identity-verified (Ruling 60/64)
    return true;
  } catch (e) {
    return false; // durability/safety failure -> refuse
  } finally {
    if (ctx !== null) { try { _unlock(ctx); } catch (e) { /* Ruling 66 */ } }
  }
}

// No reconcile/spawn here by design (brief: "keep it cheap; refusal is the required behavior,
// cleanup is admit's job"). Refuse-while-corrupt (spec §7) still applies unconditionally.
function grant(home, activityId, nbytes) {
  let ctx = null;
  try {
    ctx = _quotaLock(home);
    const snap = _accountingSnapshot(home, ctx); // Ruling 50: ONE snapshot per decision
    if (snap.corrupt) return false;
    if (snap.uncertain) return false; // Ruling 45/49/60: unmeasurable bytes or swapped ledger dir -> refuse
    const e = _readEntry(paths.ledgerEntryPath(home, activityId));
    if (e === CORRUPT) return false;
    if (e.granted + nbytes > ORDINARY_CAP) return false; // per-activity cap
    if (snap.charge + nbytes > CEILING) return false; // global ceiling
    _writeEntry(home, activityId, e.reserved, e.granted + nbytes, ctx); // durable BEFORE append; identity-verified (Ruling 60/64)
    return true;
  } catch (e) {
    return false; // durability/safety failure -> refuse the append
  } finally {
    if (ctx !== null) { try { _unlock(ctx); } catch (e) { /* Ruling 66 */ } }
  }
}

// Codex R3 (BLOCKER, fixed here): post-handoff, Electron retains authority to write
// `control{cancel_requested}` (writer.js's `allowHandedOff` exception) even AFTER
// `dropLocalReference()`. Meanwhile the Python child (the executing owner) can durably write its
// `terminal` and `settle()` -- which reaps (removes) the ledger entry -- BEFORE Electron observes
// the child's exit. A "does the ledger entry still exist?" PRECHECK is insufficient: the reap can
// land in the gap between that check and the append itself (settle()'s delegated prune runs under
// its OWN fresh `quota.lock` acquisition, entirely independent of any check Electron performed a
// moment earlier). A settled activity's only remaining charge term is its on-disk `committed` size
// (fstat-only, `_charge` above) -- an append landing AFTER that ledger entry is gone has NO
// liability term to catch it, so it silently escapes accounting (Codex's measured repro: charge
// 687 vs actual committed 861, undercount 174).
//
// The fix: serialize the DECISION and the WRITE against settlement, using the exact same
// cross-process `quota.lock` settlement itself is removed under (Python's `settle()` acquires it
// directly; the reap's `_reconcile_one_locked` runs under the prune's held `quota.lock` too -- see
// this module's own header comment on Node's `_quotaLock` interoperating with that same BSD flock,
// proven in Task 2.2a). Acquire `quota.lock`, read the ledger entry AT THAT MOMENT (under the
// lock), and only if it is still a valid, live (unsettled) entry run `appendFn` -- all inside the
// SAME lock hold, so the whole read-then-write is atomic and mutually exclusive with settlement
// across processes. A settled (reaped/missing) or otherwise corrupt entry -> `_readEntry` already
// returns CORRUPT for a missing file (the FileNotFoundError path) -- no-op, correctly.
//
// No deadlock: `appendFn` (writer.control('cancel_requested')) does NOT itself acquire
// `quota.lock` -- reserve-consuming control writes skip `quota.grant` entirely (writer.js's
// `control()`, `{ reserve: true }`) -- and its `_emit` appends to a SEGMENT file via
// `secureOpenAppend`, never the ledger, so running it inside this lock hold is safe (no
// nested/re-entrant `quota.lock` acquisition). Electron's writer has already `dropLocalReference()`d
// its lease by the time this runs post-handoff; appending a segment record needs no lease, only
// filesystem access to the activity dir.
//
// Deliberately narrow: only the Electron post-handoff cancel write races settlement this way (the
// owner itself always writes `terminal`/`integrity` BEFORE it settles, so those never race their
// own settlement). This is NOT broadened to every reserve write -- the owner's own terminal path
// stays lock-free, exactly as before. Never throws (any failure -- lock acquisition, entry read,
// `appendFn` itself -- is treated as "could not confirm live", so the append is skipped and the
// caller still proceeds to SIGTERM regardless; see trigger-glue.js's `onCancel`).
//
// Codex R4 (BLOCKER, "Fix-G", fixed here): the paragraphs above describe *what* serializes the
// append against settlement, but the R3 fix used the BLOCKING `_quotaLock` to do it -- which put
// a synchronous, potentially ~30s wait directly between `onCancel` and `child.kill('SIGTERM')`.
// Codex reproduced holding quota.lock 1.5s in another process delaying SIGTERM by 1.511s. Activity
// observability must NEVER change sync/cancel behavior; a contended lock freezing Electron's main
// thread and postponing cancellation is exactly that.
//
// The fix: an OPT-IN `{ nonblocking: true }` mode (used only by trigger-glue.js's `onCancel`) that
// acquires quota.lock via `_quotaLockNonblocking` (the `-t 0` non-blocking lockf, same mode
// lease.js's `probe`/`acquire` use) instead of `_quotaLock`. `admit`/`grant`/`settle` are
// UNCHANGED -- they legitimately need to wait for exclusive ledger access and keep calling
// `_quotaLock` directly.
//   - lock FREE -> acquired exactly as before: re-read the ledger under the lock, append only if
//     still live, release. Serialization/correctness is IDENTICAL to the R3 fix in this case.
//   - lock BUSY (contended) -> do NOT wait: return `false` immediately, same as a settled/corrupt
//     entry. The cancel record is best-effort observability; SIGTERM must never wait on it.
// This is still correct for the undercount invariant: a skipped append writes zero bytes, so it
// can never undercount. The append only ever happens while THIS process holds quota.lock (a free,
// self-acquired hold), which is mutually exclusive with settlement's own blocking acquisition of
// the SAME lock -- so the R3 serialization guarantee is fully preserved when the lock is free. The
// only observable behavior change is that a RARE contended cancel skips its `cancel_requested`
// record, so the reconciler may later finalize the run as `interrupted` instead of `cancelled` --
// an accepted best-effort observability degradation, never an accounting or cancellation defect.
//
// Wording note (Codex R4, residual): the terminal append itself happens OUTSIDE quota.lock, so a
// cancel append CAN still land after a terminal is durable but before settlement's reap runs --
// that is harmless (the still-live ledger entry's reservation covers it, and reconcile settles the
// run normally); this function makes no attempt to detect or forbid that ordering, and nothing
// here should be read as claiming a post-terminal cancel record can never occur. The only
// invariant this function (and its callers) actually guarantee is: no undercount, ever.
//
// Fix-G also closes two more BLOCKER findings, both inside this function regardless of mode:
//   - the OUTER `try` around `appendFn()` already makes the WHOLE function never-raise; Fix-G adds
//     a matching inner guard around the `finally`'s own `_unlock(fd)` so a close/flock-release
//     failure can't escape either -- see the `finally` block below.
//   - `onCancel` (trigger-glue.js) now sends SIGTERM from an OUTER `finally` of its own, so even if
//     this function's "never throws" contract somehow failed to hold, cancellation still proceeds.
function appendReserveIfLive(home, aid, appendFn, opts) {
  const nonblocking = Boolean(opts && opts.nonblocking);
  let fd = null;
  try {
    fd = nonblocking ? _quotaLockNonblocking(home) : _quotaLock(home);
    if (fd === null) return false; // nonblocking only: lock BUSY (or spawn anomaly) -> skip, never wait
    if (!_verifyCanonical(fd)) return false; // Ruling 60/64: quota dir or root swapped under the lock -> not provably live, BEFORE the read
    const e = _readEntry(paths.ledgerEntryPath(home, aid));
    if (e === CORRUPT) return false; // settled (missing) or genuinely corrupt -> no-op
    appendFn(); // ledger still live -- its reservation covers this reserve-consuming append
    // Ruling 64: re-verify AFTER the write too -- a swap landing during the append can only ever
    // make the appended record land somewhere unaccounted-for (an overcount at worst, since the
    // record itself carries no reservation of its own); reporting refusal here matches
    // `_writeEntry`'s own post-write check and costs nothing extra (the append already happened
    // and cannot be undone, but the CALLER only ever treats this return value as best-effort
    // observability -- see this function's own header comment).
    if (!_verifyCanonical(fd)) return false;
    return true;
  } catch (e) {
    return false; // never-raises (best-effort cancel)
  } finally {
    // Fix-G (Codex R4): a release/close failure here must never escape -- it would otherwise
    // defeat this function's "never throws" contract at the exact moment its caller (onCancel)
    // is relying on that contract to guarantee SIGTERM still fires. `onCancel`'s own outer
    // `finally` is a second, independent backstop for the same guarantee.
    if (fd !== null) {
      try { _unlock(fd); } catch (e) { /* best-effort: a stuck/failed release must not propagate */ }
    }
  }
}

// Ruling B: Node cannot unlink, so settle() never removes the ledger entry ITSELF -- it delegates
// that to the (packaged-aware, Codex B3a) Python prune entrypoint below. Codex R2: `_charge` no
// longer has a terminal-VISIBILITY shortcut of its own (that was a second undercount path -- see
// `_charge`'s comment), so a durable terminal alone does NOT stop an entry from being charged.
// Settlement now happens ENTIRELY through the reap below: once the delegated Python prune pass
// actually REMOVES the ledger entry (Python's `_reconcile_all_locked`, unchanged), the entry
// simply no longer appears in `_ledgerEntries(home)` and `_charge` naturally counts 0 outstanding
// for it -- exactly like Python's own post-`settle` state (there, `settle()` unlinks it outright
// too). Until that reap lands (e.g. lease still held, or the packaged prune failed -- surfaced by
// B3b's warn), a durable-but-not-yet-reaped entry charges conservatively
// (Math.max(size, reserved+granted)) -- an overcount, never an undercount.
//
// Codex B3(c) "bounded reap": settle() proactively delegates to the Python prune entrypoint with
// `need=0` -- prune_to_ceiling's own `_reconcile_all_locked` pass runs unconditionally regardless
// of the requested headroom (see
// repo_radar/activity/prune.py), so this reconciles/clears settled entries without requesting any
// extra room. This is what actually removes the physical ledger JSON promptly instead of leaving
// it to linger until the next admission-pressure prune or a restart -- callers (writer.js's
// `terminal()`) release the owner.lock BEFORE calling settle() specifically so this delegated
// reconcile pass can observe the lock as free and reclaim the entry for real (Python's own
// reconcile only clears a terminal-bearing entry once its owner is confirmably gone). Status-
// checked (B3b) and never-raises: `_spawnPythonPrune` itself doesn't throw, but this is wrapped
// defensively anyway, matching writer.js's own belt-and-suspenders wrapping of this call.
//
// Codex R7 B2 / Ruling 61: the same "no destructive pruning under uncertainty" guard `admit`
// applies. The reap is a prune entrypoint (its loop prunes whenever the charge it computes
// exceeds the ceiling), so it is delegated ONLY from a certain, non-corrupt snapshot -- taken
// under quota.lock (Ruling 60 identity-bound), released BEFORE the spawn exactly like `admit`.
// An uncertain or corrupt snapshot -> bounded warn, no delegation; the settled entry then simply
// charges conservatively until a later certain pass (Node's or Python's) reaps it.
function settle(home, activityId) {
  void activityId; // prune reaps by headroom, not by a specific activity id (mirrors admit's own delegation)
  try {
    let snap;
    let canonical;
    const ctx = _quotaLock(home);
    try {
      snap = _accountingSnapshot(home, ctx);
      // Codex R8 B1 / Ruling 64: re-verify identity while STILL under the lock, before it is
      // released below -- mirrors `admit`'s own pre-delegation check (this is settle's own
      // "before any prune delegation" moment; see `_verifyCanonical`'s header comment).
      canonical = _verifyCanonical(ctx);
    } finally {
      try { _unlock(ctx); } catch (e) { /* Ruling 66 */ }
    }
    if (!canonical) {
      _warn('quota: accounting identity changed under the lock; refusing settle reap without pruning (Ruling 64)');
      return;
    }
    if (_refuseNonDecidable(snap, 'settle reap')) return;
    _spawnPythonPrune(home, 0);
  } catch (e) {
    _warn(`settle reap failed: ${e.message}`);
  }
}

module.exports = {
  CEILING, RESERVE, PER_ACTIVITY_CAP, ORDINARY_CAP, CORRUPT,
  admit, grant, settle, appendReserveIfLive,
  configurePythonRunner,
  _quotaLock, _quotaLockNonblocking, _unlock, _quotaDirIdentity, _verifyCanonical,
  _parseEntry, _readEntry, _writeEntry,
  _committed, _onDisk, _ledgerEntries, _ledgerEntriesDetailed,
  _gatherAccounting, _computeSnapshot, _accountingSnapshot, _charge, _hasCorrupt, _accountingUncertain, _hasTerminal,
  _spawnPythonPrune, _spawnPythonRetain,
  // Codex R8 B1 / Ruling 64 test seam: `_quotaLock` calls this through `module.exports` (not a
  // bare reference) specifically so a regression test can stub it to swap `quota/` during the
  // lock WAIT, proving the pre/post identity comparison actually catches a mid-wait swap.
  _lockfBlocking,
  get PYTHON_BIN() { return PYTHON_BIN; },
  set PYTHON_BIN(v) { PYTHON_BIN = v; },
};
