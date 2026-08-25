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
  paths.secureMkdir(paths.quotaDir(home)); // ensures activity/ + quota/ exist
  const lockPath = _quotaLockPath(home);
  const fd = paths.openOwnedRegular(lockPath, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o600);
  const status = _lockfNonblocking(fd);
  if (status !== 0) {
    fs.closeSync(fd);
    return null; // BUSY (75) or any other non-success -- skip immediately, never wait
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
function _accountingSnapshot(home) {
  const base = path.dirname(paths.quotaDir(home));
  const root = paths.listOwnedSubdirsDetailed(base);
  let uncertain = Boolean(root.uncertain);
  const sizes = new Map();
  for (const name of root.subdirs) {
    if (name === 'quota') continue;
    const scan = paths.statOwnedSegmentsDetailed(path.join(base, name)); // ONE scan per activity
    let size = 0;
    for (const seg of scan.entries) size += seg.size;
    if (scan.uncertain) { uncertain = true; size = Math.max(size, PER_ACTIVITY_CAP); }
    sizes.set(name, size);
  }
  let total = 0;
  for (const size of sizes.values()) total += size;
  let hidden = 0; // activity-shaped root entries refused (not proven gone): max liability each
  for (const rj of root.rejected) {
    if (rj.reason === 'gone') continue;
    hidden += 1;
    total += PER_ACTIVITY_CAP;
  }
  if (root.uncertain && hidden === 0) total = Math.max(total, CEILING); // base itself unlistable
  let corrupt = false;
  for (const [aid, e] of _ledgerEntries(home)) {
    if (e === CORRUPT) { corrupt = true; total += PER_ACTIVITY_CAP; continue; }
    total += Math.max(0, e.reserved + e.granted - (sizes.get(aid) || 0));
  }
  return { charge: total, uncertain, corrupt };
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
function admit(home, activityId, lease) {
  void lease;
  let fd = null;
  try {
    fd = _quotaLock(home);
    let snap = _accountingSnapshot(home); // Ruling 50: ONE snapshot per decision
    if (snap.corrupt || snap.uncertain || snap.charge + RESERVE > CEILING) {
      const headroom = Math.max(RESERVE, snap.charge + RESERVE - CEILING);
      _unlock(fd);
      fd = null;
      _spawnPythonPrune(home, headroom); // release -> spawn -> (below) re-acquire -> re-evaluate
      fd = _quotaLock(home);
      snap = _accountingSnapshot(home); // FRESH unified snapshot -- never mixed with the first
    }
    if (snap.uncertain) {
      _warn('quota: an activity directory is unmeasurable (unlistable); refusing admission (Ruling 45/49)');
      return false; // best-effort refuse, same outcome path as a corrupt ledger entry
    }
    if (snap.corrupt || snap.charge + RESERVE > CEILING) {
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
    const snap = _accountingSnapshot(home); // Ruling 50: ONE snapshot per decision
    if (snap.corrupt) return false;
    if (snap.uncertain) return false; // Ruling 45/49: unmeasurable bytes -> refuse, like corrupt
    const e = _readEntry(paths.ledgerEntryPath(home, activityId));
    if (e === CORRUPT) return false;
    if (e.granted + nbytes > ORDINARY_CAP) return false; // per-activity cap
    if (snap.charge + nbytes > CEILING) return false; // global ceiling
    _writeEntry(home, activityId, e.reserved, e.granted + nbytes); // durable BEFORE append
    return true;
  } catch (e) {
    return false; // durability/safety failure -> refuse the append
  } finally {
    if (fd !== null) _unlock(fd);
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
    const e = _readEntry(paths.ledgerEntryPath(home, aid));
    if (e === CORRUPT) return false; // settled (missing) or genuinely corrupt -> no-op
    appendFn(); // ledger still live -- its reservation covers this reserve-consuming append
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
function settle(home, activityId) {
  void activityId; // prune reaps by headroom, not by a specific activity id (mirrors admit's own delegation)
  try {
    _spawnPythonPrune(home, 0);
  } catch (e) {
    _warn(`settle reap failed: ${e.message}`);
  }
}

module.exports = {
  CEILING, RESERVE, PER_ACTIVITY_CAP, ORDINARY_CAP, CORRUPT,
  admit, grant, settle, appendReserveIfLive,
  configurePythonRunner,
  _quotaLock, _quotaLockNonblocking, _unlock,
  _parseEntry, _readEntry, _writeEntry,
  _committed, _onDisk, _ledgerEntries, _accountingSnapshot, _charge, _hasCorrupt, _accountingUncertain, _hasTerminal,
  _spawnPythonPrune, _spawnPythonRetain,
  get PYTHON_BIN() { return PYTHON_BIN; },
  set PYTHON_BIN(v) { PYTHON_BIN = v; },
};
