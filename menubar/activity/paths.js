'use strict';
// Node mirror of repo_radar/activity/paths.py (Task 2.1) -- path CONSTRUCTORS plus the safe
// mkdir/open-append primitives. Stock Node has no `openat`/`dir_fd` equivalent, so unlike the
// Python original (which walks descriptor-relative from an O_NOFOLLOW dir fd, so NO component,
// intermediate or final, can ever be a symlink at the instant it's touched), this mirror walks
// each component from the owned prefix with `fs.lstatSync`-equivalent O_NOFOLLOW opens on the
// cumulative ABSOLUTE path, rejecting any symlink/non-dir component, then acts on the validated
// path with O_NOFOLLOW on the final component, re-validating immediately before each op. The
// residual TOCTOU (the interval between validating a component and the next syscall touching
// it) that `dir_fd` closes on the Python side but stock Node cannot fully eliminate is
// acceptable ONLY because every op here is NON-DESTRUCTIVE (mkdir / open-append) -- a redirected
// op returns wrong data or writes to the wrong file, never data loss. Node performs NO
// destructive deletion; all pruning/retention is delegated to the Python `retain`/`prune`
// entrypoint (descriptor-relative, race-free) in a later task.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ids = require('./ids');

const PRODUCERS = new Set(['electron', 'dispatcher', 'python']);

// Read-only view of PRODUCERS for external consumers (F-E parity fix): callers (e.g. the
// lifecycle filters below/in reconcile.js and quota.py's Node mirror) need to know the producer
// enum without being able to mutate the internal Set this module validates against. A plain
// `module.exports.PRODUCERS = PRODUCERS` would hand out the SAME mutable Set object -- freezing a
// Set does not actually block `.add()`/`.delete()` (V8 lets those through on a frozen Set/Map
// instance), so this wraps it in a Proxy that throws on the three mutating methods and forwards
// everything else (bound to the real target, since Set's methods rely on an internal slot that
// only the real Set object carries -- calling them with the Proxy as `this` throws
// "not a Set"). Internal code in this file keeps using the real, mutable `PRODUCERS` directly.
function _readonlySet(set) {
  return new Proxy(set, {
    get(target, prop, _receiver) {
      if (prop === 'add' || prop === 'delete' || prop === 'clear') {
        return () => { throw new TypeError('PRODUCERS is read-only'); };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

class UnsafePath extends Error {}

function _base(home) {
  return path.join(home, 'Library', 'Logs', 'repo-radar', 'activity');
}

function activityDir(home, activityId) {
  if (!ids.validActivityId(activityId)) {
    throw new UnsafePath(`invalid activity_id: ${JSON.stringify(activityId)}`);
  }
  return path.join(_base(home), activityId);
}

function segmentPath(home, activityId, producer, writerId) {
  if (!PRODUCERS.has(producer)) {
    throw new UnsafePath(`invalid producer: ${JSON.stringify(producer)}`);
  }
  if (!ids.validToken(writerId)) {
    throw new UnsafePath(`invalid writer_id: ${JSON.stringify(writerId)}`);
  }
  return path.join(activityDir(home, activityId), `${producer}-${writerId}.jsonl`);
}

// F-E parity fix: the single authority for "is this a conforming segment filename" -- returns
// `{ producer, writerId }` iff `name` ends with `.jsonl`, the part before the LAST '-' is a known
// producer, the part after it is a valid 8-hex token, AND the reconstructed name round-trips
// EXACTLY back to `name` (guards against e.g. a producer-like prefix that isn't actually in
// PRODUCERS, or a token with extra/odd characters that a looser split would still accept).
// Returns null otherwise -- never throws. Used by reconcile.js's lifecycle helpers (and the
// Python mirror `parse_segment_name` in repo_radar/activity/paths.py) to filter out non-conforming
// entries (e.g. `python-s3cr3t.jsonl`, `junk.jsonl`) before they're treated as real segments.
const SUFFIX = '.jsonl';

function parseSegmentName(name) {
  if (typeof name !== 'string' || !name.endsWith(SUFFIX)) return null;
  const stem = name.slice(0, -SUFFIX.length);
  const idx = stem.lastIndexOf('-');
  if (idx === -1) return null;
  const producer = stem.slice(0, idx);
  const writerId = stem.slice(idx + 1);
  if (!PRODUCERS.has(producer)) return null;
  if (!ids.validToken(writerId)) return null;
  if (`${producer}-${writerId}${SUFFIX}` !== name) return null; // exact round-trip
  return { producer, writerId };
}

function ownerLockPath(home, activityId) {
  return path.join(activityDir(home, activityId), 'owner.lock');
}

function quotaDir(home) {
  return path.join(_base(home), 'quota');
}

function ledgerEntryPath(home, activityId) {
  if (!ids.validActivityId(activityId)) {
    throw new UnsafePath(`invalid activity_id: ${JSON.stringify(activityId)}`);
  }
  return path.join(quotaDir(home), `${activityId}.json`);
}

// The shared `~/Library/Logs/repo-radar` prefix (created best-effort, NOT repaired -- it is
// shared, not subsystem-owned). Everything at/below `activity/` is the owned subtree. Purely
// lexical (mirrors Python's `pathlib` walk over `.parents`) -- never resolves symlinks or the
// cwd, so a relative input is walked exactly as given.
function _ancestors(p) {
  const out = [];
  let cur = p;
  for (;;) {
    const parent = path.dirname(cur);
    if (parent === cur) break; // reached the filesystem root
    out.push(parent);
    cur = parent;
  }
  return out;
}

function _ownedPrefix(p) {
  for (const anc of [p, ..._ancestors(p)]) {
    if (path.basename(anc) === 'repo-radar' && path.basename(path.dirname(anc)) === 'Logs') {
      return anc;
    }
  }
  return path.dirname(p); // unusual layout -> treat parent as the prefix
}

function _openDirNofollow(p) {
  return fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY);
}

// Validate every component of `targetDir` from the owned prefix down to `targetDir` itself,
// opening each with O_NOFOLLOW so a symlinked/non-directory component (intermediate OR final)
// is rejected. Read-only -- does NOT create anything. Throws UnsafePath for a symlink/non-dir
// component, or an Error with `code === 'ENOENT'` if a component is simply missing (mirrors
// Python's `open_owned_dir`, which raises FileNotFoundError distinctly from UnsafePath).
function _validateOwnedDir(targetDir) {
  const prefix = _ownedPrefix(targetDir);
  let fd;
  try {
    fd = _openDirNofollow(prefix);
  } catch (e) {
    const err = new UnsafePath(`unsafe prefix ${prefix}: ${e.message}`);
    // Ruling 45: a MISSING prefix is "proven gone", not "refused" -- carry the code so
    // `statOwnedSegmentsDetailed` can tell the two apart (still an UnsafePath, mirroring Python).
    if (e.code === 'ENOENT') err.code = 'ENOENT';
    throw err;
  }
  fs.closeSync(fd);

  const rel = path.relative(prefix, targetDir);
  const parts = rel === '' ? [] : rel.split(path.sep);
  let cur = prefix;
  for (const name of parts) {
    cur = path.join(cur, name);
    let cfd;
    try {
      cfd = _openDirNofollow(cur);
    } catch (e) {
      if (e.code === 'ENOENT') throw e; // missing component -> propagate, mirrors FileNotFoundError
      throw new UnsafePath(`unsafe path ${targetDir}: ${e.message}`); // ELOOP / ENOTDIR / etc.
    }
    fs.closeSync(cfd);
  }
  return cur;
}

// Descriptor-relative-STYLE creation of the OWNED subtree (activity/ and below): each component
// is created then re-opened with O_NOFOLLOW (absolute path, since Node has no dir_fd) so a
// symlinked component (intermediate or final) is rejected rather than followed, and
// `fchmod`-repair touches ONLY owned components -- never the shared prefix (Round-3 #7).
function secureMkdir(targetPath, mode = 0o700) {
  const prefix = _ownedPrefix(targetPath);
  fs.mkdirSync(prefix, { recursive: true, mode: 0o700 }); // shared prefix: create, no repair
  let fd;
  try {
    fd = _openDirNofollow(prefix);
  } catch (e) {
    throw new UnsafePath(`unsafe prefix ${prefix}: ${e.message}`);
  }
  fs.closeSync(fd);

  const rel = path.relative(prefix, targetPath);
  const parts = rel === '' ? [] : rel.split(path.sep);
  let cur = prefix;
  for (const name of parts) {
    cur = path.join(cur, name);
    try {
      fs.mkdirSync(cur, mode);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let cfd;
    try {
      cfd = _openDirNofollow(cur);
    } catch (e) {
      throw new UnsafePath(`unsafe component ${JSON.stringify(name)} under ${prefix}: ${e.message}`);
    }
    try {
      const st = fs.fstatSync(cfd);
      if ((st.mode & 0o777) !== mode) {
        fs.fchmodSync(cfd, mode); // repair owned component only
      }
    } finally {
      fs.closeSync(cfd);
    }
  }
}

// Open a REGULAR file relative to its validated parent dir (every component checked).
// O_NONBLOCK so a FIFO/device can't block the open before we can fstat+reject it; O_NOFOLLOW so
// the final component can't be a symlink; reject non-regular; repair mode on create. Public --
// mirrors Python's `paths.open_owned_regular` (used directly by lease.js for owner.lock, in
// addition to secureOpenAppend below).
function openOwnedRegular(targetPath, flags, mode = 0o600) {
  _validateOwnedDir(path.dirname(targetPath)); // every parent component checked

  let fd;
  try {
    fd = fs.openSync(targetPath, flags | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, mode);
  } catch (e) {
    if (e.code === 'ELOOP') throw new UnsafePath(`unsafe path ${targetPath}: ${e.message}`);
    throw e;
  }
  let st;
  try {
    st = fs.fstatSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
  if (!st.isFile()) { // reject FIFO/device/dir
    fs.closeSync(fd);
    throw new UnsafePath(`not a regular file: ${targetPath}`);
  }
  if ((flags & fs.constants.O_CREAT) !== 0 && (st.mode & 0o777) !== mode) {
    fs.fchmodSync(fd, mode); // repair a pre-existing permissive file
  }
  return fd;
}

function secureOpenAppend(targetPath, mode = 0o600) {
  return openOwnedRegular(
    targetPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND,
    mode,
  );
}

// Task 2.2b additions: generic read/list/atomic-write primitives that repo_radar/activity/
// paths.py already has (read_owned_segments, stat_owned_segments, read_owned_file,
// list_owned_entries, list_owned_subdirs) plus one Node-only addition (writeOwnedFileAtomic,
// standing in for Python's dir_fd-relative temp+rename since Node has no dir_fd). quota.js and
// reconcile.js are the first Node consumers. Same validated-absolute-path style as the rest of
// this file: no dir_fd, so every op re-validates from the owned prefix, then acts on the
// validated path with O_NOFOLLOW on the final component. All non-destructive (Ruling B: Node
// never unlinks a LEDGER ENTRY or SEGMENT -- see quota.js/reconcile.js); the one unlink used
// below is exclusively for a temp file THIS function itself just created and failed to commit,
// never for committed data.

function _readFdAll(fd) {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  for (;;) {
    const n = fs.readSync(fd, buf, 0, buf.length, null);
    if (n <= 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks);
}

// Enumerate + read files under an owned dir, never following a symlinked component or entry.
// Returns { segments: [{name, data (Buffer), size, mtime (seconds, matching Python's
// st_mtime)}], rejected: [{name, reason}] }. `rejected` lists every suffix-matching entry that
// was refused, with a short stable `reason`: 'symlink' (ELOOP via O_NOFOLLOW), 'not-regular'
// (FIFO/dir/device), 'denied' (EACCES), 'gone' (removed between readdir and open, or a
// TOCTOU-mid-scan failure after open), or 'read-failed' (any other open/fstat/read failure).
// If the DIRECTORY itself is invalid/unreadable, `segments` is still `[]` (unchanged contract)
// but `rejected` is `[{ name: '', reason: 'dir-unreadable' }]` so a caller can tell "no entries"
// apart from "couldn't list" (Codex R1 B2: a reader must be able to surface "I refused to read
// this" as an integrity condition, not silently fold it into "no data").
//
// Mirrors `paths.read_owned_segments` (content read -- used where the actual bytes are needed,
// e.g. reconcile.js's lifecycle parsing). `readOwnedSegments` below is a thin wrapper returning
// just `.segments`, preserving its existing signature/behavior for its many callers unchanged.
function readOwnedSegmentsDetailed(directory, suffix = '.jsonl') {
  let dir;
  try {
    dir = _validateOwnedDir(directory);
  } catch (e) {
    return { segments: [], rejected: [{ name: '', reason: 'dir-unreadable' }] };
  }
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return { segments: [], rejected: [{ name: '', reason: 'dir-unreadable' }] };
  }
  const segments = [];
  const rejected = [];
  for (const name of names) {
    if (!name.endsWith(suffix)) continue;
    const p = path.join(dir, name);
    let fd;
    try {
      fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch (e) {
      if (e.code === 'ELOOP') rejected.push({ name, reason: 'symlink' });
      else if (e.code === 'EACCES') rejected.push({ name, reason: 'denied' });
      else if (e.code === 'ENOENT') rejected.push({ name, reason: 'gone' });
      else rejected.push({ name, reason: 'read-failed' });
      continue;
    }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) { rejected.push({ name, reason: 'not-regular' }); continue; } // FIFO / directory / device
      segments.push({ name, data: _readFdAll(fd), size: st.size, mtime: st.mtimeMs / 1000 });
    } catch (e) {
      rejected.push({ name, reason: 'read-failed' }); // TOCTOU: entry deleted/swapped mid-scan
      continue;
    } finally {
      // I3 fix (Codex R1): a throwing close on a read-only fd must not abort the whole
      // enumeration -- we already have (or already gave up on) this entry's data by the time we
      // reach here, so a close failure changes nothing about what to report for it. Contained,
      // never rethrown.
      try {
        fs.closeSync(fd);
      } catch (e) {
        // swallow -- see comment above
      }
    }
  }
  return { segments, rejected };
}

function readOwnedSegments(directory, suffix = '.jsonl') {
  return readOwnedSegmentsDetailed(directory, suffix).segments;
}

// Like readOwnedSegments but METADATA ONLY -- never reads content, so quota's per-event size
// accounting never has to reread a whole segment (up to the ceiling) while holding quota.lock.
// Mirrors `paths.stat_owned_segments` (the I7 fix). Returns `{ entries: [{name, size}],
// uncertain }`.
//
// Codex R3 B1 / Ruling 40: sized WITHOUT opening. The previous open(O_RDONLY)+fstat shape
// silently `continue`d on EACCES, so a settled segment chmod 000 dropped straight out of
// quota's 64 MiB accounting (1 MiB -> 0) while its bytes persisted on disk -- an undercount that
// let new admissions proceed past the ceiling. `lstat` needs no read permission on the entry
// itself (only search permission on the validated dir), so a denied regular file keeps its
// provable size. `lstat` reports the link ITSELF for a symlink (never follows it), so a
// `.jsonl`-named symlink is skipped along with every other non-regular entry (FIFO / dir /
// device) -- exactly what the O_NOFOLLOW+S_ISREG check excluded before, minus the open.
//
// Codex R4 B1 / Ruling 45: the DIRECTORY-level counterpart of that fix. `statOwnedSegments`
// returned `[]` for a missing dir AND for one that exists but cannot be validated/listed (chmod
// 000, ELOOP, a non-directory squatting on the name) -- so an unlistable settled activity
// counted as 0 bytes in `quota._charge` while its segments persisted on disk (Codex's repro:
// 16 x 4 MiB settled, chmod 000 one dir -> charge 60 MiB -> a reservation admitted -> restore ->
// 67,170,304 bytes > ceiling). `uncertain` tells those two apart:
//   - `false` + `[]`: the dir does NOT exist (ENOENT on a component = proven gone, nothing on
//     disk to count), or it was listed and every entry was sized (or was itself proven gone).
//   - `true`: the dir exists but its bytes could not be measured -- validation refused it
//     (UnsafePath: symlink/ELOOP/ENOTDIR/EACCES on the open), readdir failed, or an entry's
//     `lstat` failed with anything other than ENOENT (an entry that vanished mid-scan is proven
//     gone, not unmeasurable). `entries` still carries whatever WAS provable.
// quota.js charges an uncertain activity its maximum liability (PER_ACTIVITY_CAP) and refuses
// admissions/grants while any committed activity is unmeasurable (the same fail-closed outcome
// as a corrupt ledger entry). `statOwnedSegments` below is the `.entries`-only wrapper --
// single implementation, existing signature/behavior for its callers unchanged.
function statOwnedSegmentsDetailed(directory, suffix = '.jsonl') {
  let dir;
  try {
    dir = _validateOwnedDir(directory);
  } catch (e) {
    // ENOENT on a component: the dir is proven absent. Anything else (UnsafePath wrapping
    // EACCES/ELOOP/ENOTDIR, or an unexpected error) means it may exist with unmeasured bytes.
    return { entries: [], uncertain: e.code !== 'ENOENT' };
  }
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return { entries: [], uncertain: e.code !== 'ENOENT' };
  }
  const entries = [];
  let uncertain = false;
  for (const name of names) {
    if (!name.endsWith(suffix)) continue;
    let st;
    try {
      st = fs.lstatSync(path.join(dir, name));
    } catch (e) {
      if (e.code !== 'ENOENT') uncertain = true; // refused, not gone: bytes may persist unmeasured
      continue; // gone mid-scan: nothing provable to count
    }
    if (st.isSymbolicLink() || !st.isFile()) continue;
    entries.push({ name, size: st.size });
  }
  return { entries, uncertain };
}

function statOwnedSegments(directory, suffix = '.jsonl') {
  return statOwnedSegmentsDetailed(directory, suffix).entries;
}

// Read one owned file's bytes via the nonblocking regular-file helper (e.g. a ledger entry).
// Mirrors `paths.read_owned_file`.
function readOwnedFile(filePath) {
  const fd = openOwnedRegular(filePath, fs.constants.O_RDONLY);
  try {
    return _readFdAll(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Immediate entry NAMES of an owned dir -- UNFILTERED by type (a symlink/FIFO/dir name is still
// returned as-is; no lstat classification here). Mirrors `paths.list_owned_entries`: a caller
// doing its own per-name safety classification (quota's ledger scan) must never have a name
// silently dropped before it gets the chance to classify it CORRUPT.
//
// Codex R6 B1 / Ruling 54: the LEDGER-DIRECTORY counterpart of `statOwnedSegmentsDetailed` /
// `listOwnedSubdirsDetailed`'s `uncertain`. `listOwnedEntries` mapped EVERY validate/readdir
// failure to `[]`, so a transient EIO (or chmod 000 / ELOOP / a non-dir squatting on `quota/`)
// on the ledger dir read as "no ledgers" -> no outstanding liability -> quota's snapshot
// `{ charge: 0, uncertain: false, corrupt: false }` -> a reservation admitted -> restore ->
// 67,170,304 bytes > ceiling (Codex repro). Returns `{ entries, uncertain }`:
//   - `uncertain: false` + `[]`: the dir does NOT exist (ENOENT on a component = "no ledgers
//     yet" is PROVEN, nothing is hidden), or it was listed.
//   - `uncertain: true`: the dir may exist with entries that could not be enumerated --
//     validation refused it (UnsafePath wrapping EACCES/ELOOP/ENOTDIR) or readdir failed with
//     anything other than ENOENT.
// quota.js floors the charge at CEILING and refuses admit/grant while the ledger dir is
// unlistable. `listOwnedEntries` below is the `.entries`-only wrapper (single implementation).
function listOwnedEntriesDetailed(directory, suffix) {
  let dir;
  try {
    dir = _validateOwnedDir(directory);
  } catch (e) {
    return { entries: [], uncertain: e.code !== 'ENOENT' };
  }
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return { entries: [], uncertain: e.code !== 'ENOENT' };
  }
  return { entries: suffix === undefined ? names : names.filter((n) => n.endsWith(suffix)), uncertain: false };
}

function listOwnedEntries(directory, suffix) {
  return listOwnedEntriesDetailed(directory, suffix).entries;
}

// Immediate real subdir NAMES of an owned base (no symlink follow), PLUS the activity-shaped
// entries that were refused (Codex R2 I / Ruling 39). `listOwnedSubdirs` used to drop a
// symlink/non-directory entry silently, so a valid-UUID symlink squatting at the Activity root
// listed as clean empty history -- the reader could not tell "no activities" apart from "an
// activity-shaped entry I refused to follow". Returns
// `{ subdirs: [name], rejected: [{ name, reason }], uncertain }` where `rejected` holds ONLY
// entries whose name is a valid activity id (`ids.validActivityId`) but that are not a real
// directory: 'symlink' (lstat says symlink -- never followed, whatever it points at),
// 'not-directory' (a plain file / FIFO / device squatting on an activity name), 'stat-failed'
// (lstat refused for any reason other than ENOENT -- EACCES, EIO, ...), or 'gone' (removed
// between readdir and lstat). Entries whose names are NOT activity ids (the `quota` ledger dir,
// `quota.lock`, stray junk) are not activities and are ignored either way -- the reader never
// surfaces them, and a symlink named `foo` is not an activity being hidden.
//
// Codex R5 B1 / Ruling 49: `uncertain` is the ROOT-level counterpart of
// `statOwnedSegmentsDetailed`'s flag. quota.js used to enumerate through the LOSSY `.subdirs`
// wrapper, so a UUID-shaped entry whose lstat failed with a non-ENOENT error (Codex injected EIO
// on one of 16 x 4 MiB settled activities) simply vanished from the accounting: charge 60 MiB,
// `uncertain:false`, a reservation admitted, restore -> 67,170,304 bytes > ceiling. `uncertain`
// is true iff the base EXISTS but cannot be validated/listed (UnsafePath / readdir failure other
// than ENOENT), OR any valid-activity-id entry was rejected for a reason other than 'gone' -- an
// entry proven absent (ENOENT) hides nothing, every other refusal may. `subdirs`/`rejected`
// still carry whatever WAS enumerable. A missing base (ENOENT) yields
// `{ subdirs: [], rejected: [], uncertain: false }` -- read.js probes the root itself, before
// calling this, and consumes only `rejected` (the flag is additive).
//
// Ruling 70 (G10-Node, parity with Python's Round-10 fix / Ruling 69): `subdirs` now contains
// ONLY valid-activity-id (UUID-shaped) names. Pre-fix, ANY real directory -- valid id or not --
// was unconditionally pushed onto `subdirs` (the id check only ran in the non-directory branch),
// so a non-UUID directory (`quota`, or stray junk like `activity/junk/`) was classified and
// counted right alongside real activities: `_gatherAccounting`'s root loop has no id guard of its
// own, so `activity/junk/python-deadbeef.jsonl` (330 bytes) was charged 330 bytes instead of the
// 0 Python reports. This function is the single implementation both `_committed`'s general
// enumeration AND `_gatherAccounting`'s locked/accounting enumeration go through (Node has no
// `dir_fd`, so unlike Python -- which splits a path-based `list_owned_subdirs_detailed` that
// still lets non-UUID directories through from a `dir_fd`-bound `list_owned_subdirs_dir_fd_
// detailed` that Ruling 69 tightened -- there is only ever this one function), so it now mirrors
// Python's TIGHTER `list_owned_subdirs_dir_fd_detailed` behavior for both callers: a non-UUID
// real directory is silently ignored -- not a subdir, not rejected, not uncertainty -- exactly
// like a non-UUID junk NAME already was for the non-directory branch. `_gatherAccounting` still
// carries its own `ids.validActivityId` guard in the per-activity loop as defense in depth.
//
// Ruling 71 (Codex Round-11 BLOCKER; Python implements the identical rule): Ruling 70's silent
// `continue` threw away the BYTES too -- a 64 MiB `activity/junk/python-deadbeef.jsonl`
// contributed 0 to the committed charge with `uncertain:false` and admission proceeded, breaking
// spec §7's sum-of-actual-bytes contract (rename a real activity dir to `junk` and its bytes
// vanish from the ceiling). Foreign entries are now MEASURED, never MANAGED: the result gains
// `foreign: [{ name, bytes, uncertain }]`, one per non-UUID root entry other than `quota`:
//   - real directory: opened O_RDONLY|O_NOFOLLOW|O_DIRECTORY (never through a symlink), each
//     entry lstat'd -- regular file -> `bytes += size`; anything else (nested dir, symlink, FIFO,
//     unstat-able) -> `uncertain:true` (never descended, never followed). Open/readdir failure ->
//     `uncertain:true` with whatever partial bytes were sized (Ruling 62's keep-the-measurement
//     rule applies here too).
//   - regular file at the root (`quota.lock`, stray files): `bytes` = its lstat size.
//   - anything else at the root (symlink, FIFO, device, lstat refused): `uncertain:true`.
// `foreign` is a THIRD category: never a `subdirs` candidate (Ruling 69/70 id guards stand, so
// nothing classifies/reconciles/reads/renders it as an activity) and never `rejected` (that list
// is activity-shaped refusals only). The top-level `uncertain` flag is likewise UNCHANGED --
// it still means "an activity-shaped entry was refused / the base was unlistable"; foreign
// uncertainty travels only inside each `foreign[i].uncertain` so quota.js can fold it into the
// snapshot (`measured += SUM bytes; uncertain |= any`) without mistaking it for an unlistable
// root (which would floor the charge at CEILING instead). read.js destructures only
// `subdirs`/`rejected` and is untouched. Node still deletes nothing here (Ruling B).
function listOwnedSubdirsDetailed(base) {
  let dir;
  try {
    dir = _validateOwnedDir(base);
  } catch (e) {
    return { subdirs: [], rejected: [], foreign: [], uncertain: e.code !== 'ENOENT' };
  }
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return { subdirs: [], rejected: [], foreign: [], uncertain: e.code !== 'ENOENT' };
  }
  const subdirs = [];
  const rejected = [];
  const foreign = [];
  let uncertain = false;
  for (const name of names) {
    let st;
    try {
      st = fs.lstatSync(path.join(dir, name));
    } catch (e) {
      // TOCTOU: entry deleted/swapped mid-scan, or lstat itself refused. An ACTIVITY-shaped name
      // is reported as rejected; a foreign name that is proven gone hides nothing, any other
      // refusal may hide bytes (Ruling 71).
      if (ids.validActivityId(name)) {
        if (e.code === 'ENOENT') {
          rejected.push({ name, reason: 'gone' }); // proven absent: nothing hidden
        } else {
          rejected.push({ name, reason: 'stat-failed' }); // refused, not gone: an activity may be hidden
          uncertain = true;
        }
      } else if (name !== 'quota' && e.code !== 'ENOENT') {
        foreign.push({ name, bytes: 0, uncertain: true });
      }
      continue;
    }
    // Ruling 70: the id check runs BEFORE the directory check -- a non-UUID real directory
    // (`quota`, stray junk) is a candidate for neither `subdirs` nor `rejected`, whether or not
    // it's a directory. Ruling 71: it IS measured, as a foreign entry (except `quota`, whose
    // contents are the ledger and are accounted separately).
    if (!ids.validActivityId(name)) {
      if (name !== 'quota') foreign.push(_measureForeign(path.join(dir, name), name, st));
      continue;
    }
    if (st.isDirectory()) { subdirs.push(name); continue; } // lstat: a symlink-to-dir is NOT a dir
    rejected.push({ name, reason: st.isSymbolicLink() ? 'symlink' : 'not-directory' });
    uncertain = true; // an activity-shaped entry we refused to measure
  }
  return { subdirs, rejected, foreign, uncertain };
}

// Ruling 71: conservative byte measurement of ONE foreign (non-UUID, non-`quota`) root entry
// whose lstat `st` already succeeded. Never follows a symlink, never descends, never deletes.
// A directory is held open on an O_NOFOLLOW|O_DIRECTORY fd for the duration of its scan (the
// same idiom `writeOwnedFileAtomic`'s dir fsync and `_validateOwnedDir` use -- Node has no
// fd-relative readdir/lstat, so the entries themselves are read by path under that open fd) and
// its identity is re-checked (`fstat(fd)` vs a fresh `lstat(path)`) after the last entry stat:
// a directory swapped out mid-scan reports `uncertain` rather than a measurement of something
// else. Over-counting can never breach the 64 MiB cap; under-counting is exactly the Round-11
// bug, so every doubt resolves to `uncertain:true` with the partial bytes kept.
function _measureForeign(p, name, st) {
  if (st.isFile()) return { name, bytes: st.size, uncertain: false };
  if (!st.isDirectory()) return { name, bytes: 0, uncertain: true }; // symlink / FIFO / device / ...
  let fd = -1;
  let bytes = 0;
  let uncertain = false;
  try {
    fd = _openDirNofollow(p);
    const ident = fs.fstatSync(fd);
    for (const child of fs.readdirSync(p)) {
      let cst;
      try {
        cst = fs.lstatSync(path.join(p, child));
      } catch (e) {
        if (e.code !== 'ENOENT') uncertain = true; // refused (not gone): bytes may be hidden
        continue;
      }
      if (cst.isFile()) bytes += cst.size;
      else uncertain = true; // nested dir / symlink / FIFO / ...: never descended or followed
    }
    const after = fs.lstatSync(p);
    if (!after.isDirectory() || after.dev !== ident.dev || after.ino !== ident.ino) uncertain = true;
  } catch (e) {
    uncertain = true; // unopenable / unlistable: whatever was sized is kept, the rest is unknown
  } finally {
    if (fd !== -1) { try { fs.closeSync(fd); } catch (e) { /* best-effort */ } }
  }
  return { name, bytes, uncertain };
}

// Immediate real subdir NAMES of an owned base (no symlink follow). Mirrors
// `paths.list_owned_subdirs`. Thin `.subdirs`-only wrapper over the detailed variant above --
// single implementation. Ruling 70: as a direct consequence of the detailed variant's fix, this
// wrapper's output NOW EXCLUDES non-UUID real directories (`quota`, stray junk) where it used to
// include them -- `quota.js`'s `_committed` (its only caller) already had its own explicit
// `if (name === 'quota') continue`, which is now redundant-but-harmless for `quota` and newly
// correct for any OTHER junk directory it never guarded against.
function listOwnedSubdirs(base) {
  return listOwnedSubdirsDetailed(base).subdirs;
}

// Durable atomic create-or-replace of `name` under an owned `directory`: validated dir, temp
// file (O_EXCL|O_NOFOLLOW so it can't land on a symlink), full-write loop, fsync, atomic
// rename-over (Node has no dir_fd, so this is a validated-absolute-path rename rather than a
// descriptor-relative one -- same residual TOCTOU tradeoff as the rest of this file, accepted
// because the op is non-destructive to any EXISTING committed file: a redirected write creates
// or replaces data, it does not delete anything), then fsync the containing directory so the
// rename itself is durable. Temp-file cleanup on any failure -- that unlink targets ONLY the
// temp file this call just created (never committed data; see the Ruling-B note above). Throws
// on failure (UnsafePath / OSError-equivalent); callers fail closed. This is Node's answer to
// Python's `quota._write_entry`'s dir_fd-relative temp+rename (the ONLY write path quota.js
// uses -- Node never unlinks a ledger entry, only creates/replaces one).
function writeOwnedFileAtomic(directory, name, data, mode = 0o600) {
  const dir = _validateOwnedDir(directory); // throws UnsafePath / ENOENT -- propagate
  const tmpName = `.${name}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const tmpPath = path.join(dir, tmpName);
  const finalPath = path.join(dir, name);

  const fd = fs.openSync(
    tmpPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    mode,
  );
  try {
    let offset = 0;
    while (offset < data.length) {
      const n = fs.writeSync(fd, data, offset, data.length - offset);
      if (n <= 0) throw new Error('zero-byte write'); // no infinite loop
      offset += n;
    }
    fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    try { fs.unlinkSync(tmpPath); } catch (_e2) { /* best-effort temp cleanup */ }
    throw e;
  }
  fs.closeSync(fd);

  try {
    fs.renameSync(tmpPath, finalPath); // atomic create-or-replace
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch (_e2) { /* best-effort temp cleanup */ }
    throw e;
  }

  let dfd;
  try {
    dfd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY);
    fs.fsyncSync(dfd); // durable rename (dir entry)
  } finally {
    if (dfd !== undefined) fs.closeSync(dfd);
  }
}

module.exports = {
  UnsafePath,
  PRODUCERS: _readonlySet(PRODUCERS),
  activityDir, segmentPath, parseSegmentName, ownerLockPath, quotaDir, ledgerEntryPath,
  secureMkdir, secureOpenAppend, openOwnedRegular,
  readOwnedSegments, readOwnedSegmentsDetailed, statOwnedSegments, statOwnedSegmentsDetailed, readOwnedFile,
  listOwnedEntries, listOwnedEntriesDetailed, listOwnedSubdirs, listOwnedSubdirsDetailed, writeOwnedFileAtomic,
};
