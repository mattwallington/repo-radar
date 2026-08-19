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
// the final component can't be a symlink; reject non-regular; repair mode on create.
function _openOwnedRegular(targetPath, flags, mode = 0o600) {
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
  return _openOwnedRegular(
    targetPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND,
    mode,
  );
}

module.exports = {
  UnsafePath,
  activityDir, segmentPath, ownerLockPath, quotaDir, ledgerEntryPath,
  secureMkdir, secureOpenAppend,
};
