'use strict';
// Task 4.3: the System section's data source -- bounded, redacted, explicitly UNCORRELATED tails
// of the app's SHARED log streams, plus the legacy `~/.config/repo-radar/status.json` error
// surface. Split out of read.js (already ~940 lines) and re-exported from it.
//
// What "uncorrelated" means, and why it is a field on the payload rather than a comment: nothing
// here belongs to an Activity. These streams are process-wide, interleave every run, and carry no
// activity id -- so the reader must never let them be read as one attempt's story. `uncorrelated:
// true` rides on the object, the export section says it in its header, and the renderer prints it
// above the first stream. This is also where the viewer's OWN observability-write failures land:
// the last-resort `sh` incident line from Task 2.4 (runtime/dispatchers.js) is appended to
// `sync.error.log` precisely because the Activity store could not be written at that moment.
//
// The four streams (fixed order, always all four reported):
//   sync.error.log   the LaunchAgent's stderr        (main.js writes it into the plist)
//   menubar.log      named by the spec, but NO in-tree writer exists today -- reported ABSENT
//                    rather than invented, so the section never implies a stream that isn't there
//   sync.log         the LaunchAgent's stdout        (on demand)
//   renderer.log     written by renderer/renderer.js (on demand)
// `onDemand` is a presentation flag: those two tails are returned in the same payload (there is no
// second channel -- Ruling P4-1) and the renderer keeps them collapsed behind a "show" toggle.
//
// Three postures carried over from the rest of the subsystem:
//   1. NEVER FOLLOW A SYMLINK -- ON ANY COMPONENT. Fix round 1: O_NOFOLLOW on the FILE alone was
//      not enough. It constrains only the final component, so with `~/Library/Logs/repo-radar`
//      itself symlinked to an attacker-chosen directory, every stream under it was read from
//      there and returned as if it were ours (same for `~/.config/repo-radar` -> status.json).
//      Every directory component below `home` is now walked and opened with
//      O_RDONLY|O_NOFOLLOW|O_DIRECTORY first (`_validateDir`), which is the shape paths.js's
//      `_validateOwnedDir` uses for the owned subtree, so an intermediate OR final symlinked or
//      non-directory component is refused rather than followed. Only then is the file itself
//      opened, O_RDONLY|O_NOFOLLOW|O_NONBLOCK + fstat + S_ISREG. A refused parent makes EVERY
//      stream under it `present:false, error:'symlink'` (or 'not-regular'/'denied'), and the same
//      for the status surface. Node has no dirfd-relative open, so -- exactly as paths.js
//      documents for the same reason -- the child is opened by path AFTER its parents validate;
//      the residual TOCTOU window is the same one paths.js accepts, and O_NOFOLLOW on the child
//      still refuses anything swapped in as a symlink inside it.
//   2. NEVER READ A WHOLE FILE. A stream is tailed: one bounded `readSync` from
//      `size - SYSTEM_TAIL_MAX_BYTES`. The window starts mid-line, so a truncated tail is
//      advanced past its first newline (fix round 1): a credential split by the cut would
//      otherwise survive as a partial that matches neither a configured secret nor a redact.js
//      pattern. `status.json` cannot be tailed (it must parse), so it is refused outright above
//      `limits.STATUS_MAX_BYTES`.
//   3. REDACTION IS DEFENSE-IN-DEPTH. Every string returned -- tails, errorLog, and every
//      errorList field INCLUDING `stackTrace` -- goes through one `redact.Redactor` built from
//      `opts.configuredSecrets`, then is byte-bounded. Masking can make text LONGER than what was
//      read, so the tail bound is re-applied after scrubbing.
//
// Containment: nothing throws out of `systemDiagnostics`. Each stream and the status surface
// contain their own failures as data (`error` on that stream / that surface), and an unexpected
// failure above them yields a diagnostics object with `error` set and no streams.
const fs = require('fs');
const path = require('path');
const redactMod = require('./redact');
const limits = require('./limits'); // read as `limits.FOO` at call time (never destructured), so
// a test monkeypatching a bound is observed immediately -- see limits.js's own header comment.

// The shared (NOT subsystem-owned) locations. Written out literally rather than derived from
// paths.js: `paths.js` exports only owned-subtree builders, and these two prefixes are exactly
// the shared ones it declines to own. main.js:135 and renderer/renderer.js:14 are the writers.
const LOG_SUBPATH = ['Library', 'Logs', 'repo-radar'];
const STATUS_SUBPATH = ['.config', 'repo-radar', 'status.json'];

const STREAMS = Object.freeze([
  Object.freeze({ name: 'sync.error.log', onDemand: false }),
  Object.freeze({ name: 'menubar.log', onDemand: false }),
  Object.freeze({ name: 'sync.log', onDemand: true }),
  Object.freeze({ name: 'renderer.log', onDemand: true }),
]);

// Display-only paths. The real absolute path never crosses the bridge (ipc.js invariant 3: no
// absolute path reaches the renderer), so `~/` stands in for the home directory.
const STREAM_DISPLAY_DIR = `~/${LOG_SUBPATH.join('/')}`;
const STATUS_DISPLAY_PATH = `~/${STATUS_SUBPATH.join('/')}`;
const STATUS_BASENAME = STATUS_SUBPATH[STATUS_SUBPATH.length - 1];

// -------------------------------------------------------------------------------------------
// Byte-bounding helpers. Same UTF-8 rules read.js uses, but cutting from the FRONT: for a log
// tail the NEWEST bytes are the ones worth keeping.
// -------------------------------------------------------------------------------------------

// Drop a partial leading code point. Slicing at an arbitrary offset can land inside a multi-byte
// sequence, leaving continuation bytes (10xxxxxx) with no lead byte -- which decode to U+FFFD.
// A UTF-8 sequence is at most 4 bytes, so at most 3 continuation bytes can be stranded.
function _utf8SafeLeadingCut(buf) {
  let start = 0;
  while (start < buf.length && start < 3 && (buf[start] & 0xc0) === 0x80) start += 1;
  return buf.subarray(start);
}

// "64 KiB" at the shipped constants; a plain byte count when a test dials the bound down, so the
// marker always tells the truth about the bound actually in force.
function _sizeLabel(bytes) {
  return bytes >= 1024 && bytes % 1024 === 0 ? `${bytes / 1024} KiB` : `${bytes} bytes`;
}

function _truncationMarker(maxBytes) {
  return `--- tail truncated at ${_sizeLabel(maxBytes)} ---\n`;
}

// Drop the partial FIRST LINE of a truncated tail (fix round 1). A byte-offset cut lands
// mid-line, and a credential straddling it survives as a fragment -- which matches neither a
// configured secret (a literal substring the fragment is only part of) nor any redact.js pattern
// (they are anchored on a complete prefix like `ghp_`), so it would reach the payload in the
// clear. Advancing past the first newline is also just what `tail` does: a partial line is not a
// log line. Edge case, documented rather than worked around: a window with NO newline in it is a
// single >=64 KiB line, and is kept as-is -- dropping it would return nothing at all.
function _dropPartialLine(buf) {
  const nl = buf.indexOf(0x0a);
  return nl === -1 ? buf : buf.subarray(nl + 1);
}

// The last `maxBytes` of `buf`, WITHOUT a marker (the marker is applied once, at the end, by
// `_scrubTail`). `cut` says that bytes were already dropped before this buffer began -- which is
// the normal case for a stream, where the tail window is chosen by the read itself -- so the
// leading trims still have to run even when nothing more needs dropping here.
function _tailBody(buf, maxBytes, cut) {
  if (buf.length > maxBytes) {
    return { buf: _dropPartialLine(_utf8SafeLeadingCut(buf.subarray(buf.length - maxBytes))), truncated: true };
  }
  return { buf: cut ? _dropPartialLine(_utf8SafeLeadingCut(buf)) : buf, truncated: Boolean(cut) };
}

// Scrub, then re-bound: `Redactor.scrub` replaces each secret with a fixed marker that may be
// LONGER than what it masked, so a tail that fitted before scrubbing can overflow after it. The
// truncation marker is prepended exactly ONCE, after both passes -- applying it earlier would let
// the second pass slice through the marker itself.
function _scrubTail(buf, maxBytes, redactor, cut = false) {
  const first = _tailBody(buf, maxBytes, cut);
  const scrubbed = Buffer.from(redactor.scrub(first.buf.toString('utf8')), 'utf8');
  const second = _tailBody(scrubbed, maxBytes, false);
  const truncated = first.truncated || second.truncated;
  return {
    text: (truncated ? _truncationMarker(maxBytes) : '') + second.buf.toString('utf8'),
    truncated,
  };
}

// One rendered string field: scrub, then bound to FIELD_MAX_BYTES from the END (read.js's rule
// for every DTO string). `null`/`undefined` stay absent; anything else is stringified first so a
// non-string can never bypass redaction.
function _safeStr(v, redactor, maxBytes) {
  if (v === null || v === undefined) return null;
  const max = maxBytes === undefined ? limits.FIELD_MAX_BYTES : maxBytes;
  const s = redactor.scrub(typeof v === 'string' ? v : JSON.stringify(v));
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= max) return s;
  const marker = '…[truncated]';
  const keep = Math.max(0, max - Buffer.byteLength(marker, 'utf8'));
  // Trailing-partial-code-point trim, mirroring read.js's `_utf8SafeSlice`.
  let end = keep;
  for (let back = 1; back <= 3 && end - back >= 0; back += 1) {
    const b = buf[end - back];
    if ((b & 0xc0) === 0x80) continue;
    let seqLen = 1;
    if ((b & 0xe0) === 0xc0) seqLen = 2;
    else if ((b & 0xf0) === 0xe0) seqLen = 3;
    else if ((b & 0xf8) === 0xf0) seqLen = 4;
    if (seqLen > back) end -= back;
    break;
  }
  return buf.subarray(0, end).toString('utf8') + marker;
}

// -------------------------------------------------------------------------------------------
// Safe open. The same O_NOFOLLOW + fstat + S_ISREG shape as paths.js's owned reads, with the same
// short stable refusal reasons: 'symlink' (ELOOP), 'not-regular' (FIFO/dir/device), 'denied'
// (EACCES), 'gone' (removed mid-read), 'read-failed' (anything else). ENOENT is not a refusal --
// it is ordinary absence, reported with NO `error`.
// -------------------------------------------------------------------------------------------
function _openReason(e) {
  if (e.code === 'ELOOP') return 'symlink';
  if (e.code === 'EACCES' || e.code === 'EPERM') return 'denied';
  if (e.code === 'ENOENT') return 'absent';
  return 'read-failed';
}

// A refused DIRECTORY component, in the same vocabulary as a refused file. Either way the
// component was NOT followed -- this only decides which word to report.
function _dirReason(p, e) {
  if (e.code === 'ELOOP') return 'symlink'; // O_NOFOLLOW hit a symlinked component
  if (e.code === 'ENOTDIR') {
    // Darwin reports ENOTDIR (not ELOOP) for O_NOFOLLOW|O_DIRECTORY over a symlink-to-directory:
    // the symlink itself is not a directory, and O_NOFOLLOW stopped the walk there. Told apart
    // from a plain file squatting on the path by an `lstat`, which reports the LINK itself and so
    // never follows anything either.
    try {
      if (fs.lstatSync(p).isSymbolicLink()) return 'symlink';
    } catch (e2) {
      // raced away between the open and the lstat -- fall through to the generic answer
    }
    return 'not-regular';
  }
  if (e.code === 'EACCES' || e.code === 'EPERM') return 'denied';
  if (e.code === 'ENOENT') return 'absent';
  return 'read-failed';
}

// Walk `home/<...parts>` one component at a time, opening each with O_NOFOLLOW|O_DIRECTORY, so a
// symlinked or non-directory component -- INTERMEDIATE or final -- is refused instead of followed.
// The same shape (and the same close-immediately, no-dirfd caveat) as paths.js's
// `_validateOwnedDir`. Returns `{ dir }` when every component is a real directory, `{ reason }`
// otherwise. `home` itself is the app's own `process.env.HOME` and is not second-guessed here.
function _validateDir(home, parts) {
  let cur = home;
  for (const name of parts) {
    cur = path.join(cur, name);
    let fd;
    try {
      fd = fs.openSync(cur, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY);
    } catch (e) {
      return { reason: _dirReason(cur, e) };
    }
    try { fs.closeSync(fd); } catch (_) { /* best effort */ }
  }
  return { dir: cur };
}

function _openRegular(p) {
  let fd;
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (e) {
    return { fd: -1, reason: _openReason(e) };
  }
  let st;
  try {
    st = fs.fstatSync(fd);
  } catch (e) {
    try { fs.closeSync(fd); } catch (_) { /* best effort */ }
    return { fd: -1, reason: 'read-failed' };
  }
  if (!st.isFile()) {
    try { fs.closeSync(fd); } catch (_) { /* best effort */ }
    return { fd: -1, reason: 'not-regular' };
  }
  return { fd, size: st.size };
}

// -------------------------------------------------------------------------------------------
// One shared stream
// -------------------------------------------------------------------------------------------
function _absentStream(spec, reason) {
  const out = {
    name: spec.name,
    present: false,
    onDemand: spec.onDemand,
    bytes: 0,
    truncated: false,
    redactedTail: '',
  };
  if (reason && reason !== 'absent') out.error = reason;
  return out;
}

function _readStream(dir, spec, redactor) {
  const opened = _openRegular(path.join(dir, spec.name));
  if (opened.fd === -1) return _absentStream(spec, opened.reason);

  try {
    const max = limits.SYSTEM_TAIL_MAX_BYTES;
    const size = opened.size;
    const start = Math.max(0, size - max);
    const want = Math.max(0, Math.min(size, max));
    const buf = Buffer.alloc(want);
    let filled = 0;
    // Loop: one readSync is not guaranteed to return the full request. `position` is explicit on
    // every call, so this only ever reads the tail window -- never the whole file.
    while (filled < want) {
      const n = fs.readSync(opened.fd, buf, filled, want - filled, start + filled);
      if (n <= 0) break;
      filled += n;
    }
    const tail = _scrubTail(buf.subarray(0, filled), max, redactor, start > 0);
    return {
      name: spec.name,
      path: `${STREAM_DISPLAY_DIR}/${spec.name}`,
      present: true,
      onDemand: spec.onDemand,
      bytes: size, // the file's size on disk, which the tail may be a small slice of
      truncated: tail.truncated,
      redactedTail: tail.text,
    };
  } catch (e) {
    return _absentStream(spec, e && e.code === 'ENOENT' ? 'gone' : 'read-failed');
  } finally {
    try { fs.closeSync(opened.fd); } catch (_) { /* a failing close changes nothing we reported */ }
  }
}

// -------------------------------------------------------------------------------------------
// The legacy status.json surface (spec finding 9): the PRE-CONTRACT diagnostics that must stay
// visible. `errorLog` is one appended string (main.js appends "\n⚠️ ..." lines to it);
// `errorList` is an array of `{timestamp, repo, message, fullError, stackTrace?}`, newest first.
// -------------------------------------------------------------------------------------------
const ENTRY_FIELDS = Object.freeze(['timestamp', 'repo', 'message', 'fullError', 'stackTrace']);

function _emptyStatus(error) {
  const out = {
    present: false,
    errorLog: { text: '', truncated: false },
    errorList: { entries: [], total: 0, truncated: false },
  };
  if (error) out.error = error;
  return out;
}

function _readStatus(home, redactor) {
  // Every directory component first (see posture 1): a symlinked `~/.config/repo-radar` must not
  // hand us an attacker-chosen status.json.
  const parentParts = STATUS_SUBPATH.slice(0, -1);
  const parent = _validateDir(home, parentParts);
  if (!parent.dir) return _emptyStatus(parent.reason === 'absent' ? null : parent.reason);

  let opened;
  try {
    opened = _openRegular(path.join(parent.dir, STATUS_BASENAME));
  } catch (e) {
    return _emptyStatus('read-failed');
  }
  if (opened.fd === -1) return _emptyStatus(opened.reason === 'absent' ? null : opened.reason);

  let text;
  try {
    if (opened.size > limits.STATUS_MAX_BYTES) return _emptyStatus('too-large');
    const buf = Buffer.alloc(opened.size);
    let filled = 0;
    while (filled < opened.size) {
      const n = fs.readSync(opened.fd, buf, filled, opened.size - filled, filled);
      if (n <= 0) break;
      filled += n;
    }
    text = buf.subarray(0, filled).toString('utf8');
  } catch (e) {
    return _emptyStatus('read-failed');
  } finally {
    try { fs.closeSync(opened.fd); } catch (_) { /* best effort */ }
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    // A parse failure's message quotes the offending JSON (and Node's includes an offset), so it
    // is NOT echoed: a fixed reason plus the basename is all the renderer needs to act on, and
    // the file's contents stay out of a payload the user may hand to someone else.
    return _emptyStatus(`${STATUS_BASENAME} could not be parsed`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return _emptyStatus(`${STATUS_BASENAME} is not an object`);
  }

  // Fix round 1: a MALFORMED-but-present field is not the same as an absent one. Folding
  // `errorList: "not-an-array"` into `total: 0` made the renderer print "No legacy errors
  // recorded." -- a claim the payload cannot support, and the exact failure mode this module's
  // stop-after-error standard exists to prevent. Absent/null stays absent (main.js's own
  // `if (!status.errorList) status.errorList = []` treats a falsy value as "not written yet");
  // anything else present but of the wrong type sets a bounded `error` while `present` stays
  // true, since the rest of the file was read fine.
  const malformed = [];

  let errorLog = { text: '', truncated: false };
  if (typeof parsed.errorLog === 'string') {
    errorLog = _scrubTail(Buffer.from(parsed.errorLog, 'utf8'), limits.STATUS_ERROR_LOG_MAX_BYTES, redactor);
  } else if (parsed.errorLog !== undefined && parsed.errorLog !== null) {
    malformed.push('errorLog-not-string');
  }

  let rawList = [];
  if (Array.isArray(parsed.errorList)) {
    rawList = parsed.errorList;
  } else if (parsed.errorList !== undefined && parsed.errorList !== null) {
    malformed.push('errorList-not-array');
  }
  // Newest-first on disk (main.js `unshift`es), so the newest N are simply the first N.
  const kept = rawList.slice(0, limits.STATUS_ERROR_LIST_MAX);
  const entries = kept.map((raw) => {
    const e = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const out = {};
    for (const field of ENTRY_FIELDS) out[field] = _safeStr(e[field], redactor);
    return out;
  });

  const out = {
    present: true,
    errorLog: { text: errorLog.text, truncated: errorLog.truncated },
    errorList: {
      entries,
      total: rawList.length,
      truncated: rawList.length > kept.length,
    },
  };
  if (malformed.length > 0) out.error = malformed.join(', ');
  return out;
}

// -------------------------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------------------------

// `home` is the user's home directory (main.js/ipc.js pass process.env.HOME); `opts` takes the
// same `configuredSecrets` as listActivities/getActivity/buildExport. Never throws.
function systemDiagnostics(home, { configuredSecrets = [] } = {}) {
  let redactor;
  try {
    redactor = new redactMod.Redactor(configuredSecrets);
  } catch (e) {
    // Without a redactor NOTHING may be read: an unredacted tail is exactly the failure this
    // module exists to prevent.
    return { uncorrelated: true, streams: [], statusDiagnostics: _emptyStatus(null), error: 'diagnostics unavailable' };
  }
  try {
    // The shared log directory is validated ONCE (every component, O_NOFOLLOW|O_DIRECTORY) and
    // the four streams are read under the directory that check accepted. A refused parent is
    // reported on every stream -- silently returning "absent" would read as "no logs yet" over a
    // path someone has swapped.
    const logs = _validateDir(home, LOG_SUBPATH);
    return {
      uncorrelated: true,
      streams: STREAMS.map((spec) => (logs.dir
        ? _readStream(logs.dir, spec, redactor)
        : _absentStream(spec, logs.reason))),
      statusDiagnostics: _readStatus(home, redactor),
    };
  } catch (e) {
    return {
      uncorrelated: true,
      streams: [],
      statusDiagnostics: _emptyStatus(null),
      error: _safeStr((e && e.message) || String(e), redactor, 512) || 'diagnostics unavailable',
    };
  }
}

// `STATUS_DISPLAY_PATH` is exported because read.js's export section names the file; the stream
// list and its display prefix are internal.
module.exports = { systemDiagnostics, STATUS_DISPLAY_PATH };
