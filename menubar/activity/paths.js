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
    throw new UnsafePath(`unsafe prefix ${prefix}: ${e.message}`);
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
// Returns [{name, data (Buffer), size, mtime (seconds, matching Python's st_mtime)}]; [] if
// missing/unsafe. Mirrors `paths.read_owned_segments` (content read -- used where the actual
// bytes are needed, e.g. reconcile.js's lifecycle parsing).
function readOwnedSegments(directory, suffix = '.jsonl') {
  let dir;
  try {
    dir = _validateOwnedDir(directory);
  } catch (e) {
    return [];
  }
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(suffix)) continue;
    const p = path.join(dir, name);
    let fd;
    try {
      fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch (e) {
      continue; // symlink (ELOOP) / gone / denied
    }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) continue; // FIFO / directory / device
      out.push({ name, data: _readFdAll(fd), size: st.size, mtime: st.mtimeMs / 1000 });
    } catch (e) {
      continue; // TOCTOU: entry deleted/swapped mid-scan
    } finally {
      fs.closeSync(fd);
    }
  }
  return out;
}

// Like readOwnedSegments but METADATA ONLY -- never reads content, so quota's per-event size
// accounting never has to reread a whole segment (up to the ceiling) while holding quota.lock.
// Mirrors `paths.stat_owned_segments` (the I7 fix). Returns [{name, size}].
function statOwnedSegments(directory, suffix = '.jsonl') {
  let dir;
  try {
    dir = _validateOwnedDir(directory);
  } catch (e) {
    return [];
  }
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(suffix)) continue;
    const p = path.join(dir, name);
    let fd;
    try {
      fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch (e) {
      continue;
    }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) continue;
      out.push({ name, size: st.size });
    } catch (e) {
      continue;
    } finally {
      fs.closeSync(fd);
    }
  }
  return out;
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
function listOwnedEntries(directory, suffix) {
  let dir;
  try {
    dir = _validateOwnedDir(directory);
  } catch (e) {
    return [];
  }
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return [];
  }
  return suffix === undefined ? names : names.filter((n) => n.endsWith(suffix));
}

// Immediate real subdir NAMES of an owned base (no symlink follow). Mirrors
// `paths.list_owned_subdirs`.
function listOwnedSubdirs(base) {
  let dir;
  try {
    dir = _validateOwnedDir(base);
  } catch (e) {
    return [];
  }
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return [];
  }
  const out = [];
  for (const name of names) {
    try {
      if (fs.lstatSync(path.join(dir, name)).isDirectory()) out.push(name);
    } catch (e) {
      continue; // TOCTOU: entry deleted/swapped mid-scan
    }
  }
  return out;
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
  activityDir, segmentPath, ownerLockPath, quotaDir, ledgerEntryPath,
  secureMkdir, secureOpenAppend, openOwnedRegular,
  readOwnedSegments, statOwnedSegments, readOwnedFile,
  listOwnedEntries, listOwnedSubdirs, writeOwnedFileAtomic,
};
