"""Pinned Git inputs for incremental metadata: tree manifests, the change threshold, and the read-only
tools the model uses to look at source.

Everything here reads Git objects named by commit, tree and blob IDs, never the working tree, so
changes to the checkout during an analysis cannot change its inputs. Git runs with a minimal
environment (no credentials, no global or system config), without external diff or textconv
helpers or optional locks, and its output is bounded while it is read. Arguments come from
validated commit IDs and manifest membership; model-supplied text is only ever data (a literal
search string, or a path looked up in the manifest).
"""

import base64
import json
import os
import re
import shutil
import subprocess
import threading
import time
from collections import namedtuple

from repo_radar.files import should_include_file, under_build_output

COLLECTOR_MAX_BYTES = 100 * 1024     # files.collect_repo_files skips files larger than this
MAX_RESULT_BYTES = 64 * 1024          # one tool result, or one diff page
MAX_FILE_DIFF_BYTES = 2 * 1024 * 1024 # one file's diff; larger ones are listed as omitted, not cut
MAX_PAGE_BYTES = MAX_RESULT_BYTES - 1024   # one spooled page, its framing included
MAX_SPOOL_BYTES = 256 * 1024 * 1024   # all spooled pages of one update
MAX_READ_BYTES = 8 * 1024 * 1024      # one blob read by read_file
MAX_LINE_CHARS = 2000                 # longer lines are shortened, with a marker
MAX_SEARCH_OUTPUT = 4 * 1024 * 1024   # git grep output read for one search
MAX_SEARCH_PATHS = 2000               # files named to git grep for one path_prefix
MAX_SEARCH_ARG_BYTES = 64 * 1024      # encoded grep arguments for one search, leaving room for the rest
DISCOVERY_SECONDS = 20 * 60           # the most a change listing may take when its caller set no deadline
REGULAR_MODES = frozenset({'100644', '100755'})
SHA = re.compile(r'[0-9a-f]{40}')   # use fullmatch: re.match with $ would also accept a trailing newline
_GIT_PATH = '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin'

Entry = namedtuple('Entry', 'path mode type oid size')
Change = namedtuple('Change', 'status old_path new_path')


class GitError(Exception):
    """A read-only Git command failed or produced more output than allowed."""


class GitOutputTooLarge(GitError):
    """A read-only Git command produced more output than its limit. Any other GitError is a failed read."""


class ResourceLimit(Exception):
    """Preparing an update's pages hit the spool ceiling, a full disk or the deadline. The update stops
    with this reason; it never turns into a full rebuild."""


class Deadline:
    """One moment on one clock, shared by everything an attempt does, so no step restarts the allowance."""

    def __init__(self, seconds, clock=time.monotonic):
        self.clock = clock
        self.at = clock() + seconds

    def left(self):
        return self.at - self.clock()


def _git_env():
    return {
        'PATH': _GIT_PATH,
        'GIT_CONFIG_NOSYSTEM': '1',
        'GIT_CONFIG_GLOBAL': os.devnull,
        'GIT_OPTIONAL_LOCKS': '0',
        'GIT_TERMINAL_PROMPT': '0',
        'GIT_LITERAL_PATHSPECS': '1',
        'LC_ALL': 'C',
    }


def run_git(repo, args, limit, deadline=None):
    """Run a read-only git command in `repo` and return at most `limit` bytes of its stdout.

    Raises GitError on a non-zero exit, or as soon as the output exceeds `limit` (the process is
    killed rather than buffered). With a `deadline`, a watchdog kills the process when it passes, which
    interrupts a blocked read or wait, and ResourceLimit is raised with any partial output discarded.
    """
    if deadline is not None and deadline.left() <= 0:
        raise ResourceLimit(f"git {args[0]} ran out of time")
    git = shutil.which('git') or '/usr/bin/git'
    cmd = [git, '-C', str(repo), '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false',
           '-c', 'diff.external=', *args]
    proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=_git_env())
    err = bytearray()

    def drain():
        while True:
            chunk = proc.stderr.read(4096)
            if not chunk:
                return
            if len(err) < 4096:
                err.extend(chunk[:4096 - len(err)])

    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    expired = threading.Event()

    def expire():
        expired.set()
        proc.kill()

    watchdog = None
    if deadline is not None:
        watchdog = threading.Timer(max(deadline.left(), 0), expire)
        watchdog.daemon = True
        watchdog.start()
    out = bytearray()
    too_large = False
    try:
        while True:
            chunk = proc.stdout.read(65536)
            if not chunk:
                break
            out.extend(chunk)
            if len(out) > limit:
                too_large = True
                proc.kill()
                break
        proc.wait()
    finally:
        if watchdog is not None:
            watchdog.cancel()
            watchdog.join()
        if proc.poll() is None:   # an interrupt reached us while it was still running
            proc.kill()
            proc.wait()
        reader.join(timeout=5)
        proc.stdout.close()
        if not reader.is_alive():
            proc.stderr.close()
    if expired.is_set():
        raise ResourceLimit(f"git {args[0]} ran out of time")
    if too_large:
        raise GitOutputTooLarge(f"git {args[0]} produced more than {limit} bytes")
    if proc.returncode != 0:
        detail = err.decode('utf-8', 'replace').strip().splitlines()
        raise GitError(f"git {args[0]} failed ({proc.returncode})" + (f": {detail[-1][:200]}" if detail else ''))
    return bytes(out)


def resolve_commit(repo, rev):
    """The full commit ID for `rev` ('HEAD' or a 40-character commit ID), or None."""
    if rev != 'HEAD' and not SHA.fullmatch(rev or ''):
        return None
    try:
        out = run_git(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', f'{rev}^{{commit}}'], 1024)
    except GitError:
        return None
    sha = out.decode().strip()
    return sha if SHA.fullmatch(sha) else None


def is_ancestor(repo, base, target):
    try:
        run_git(repo, ['merge-base', '--is-ancestor', base, target], 1024)
        return True
    except GitError:
        return False


def is_credential_path(path):
    """Paths that typically hold secrets. Their contents never reach the model, by any route: full
    collection, read_file, search or either side of a diff. `.env.example` and similar templates stay
    readable."""
    name = path.rsplit('/', 1)[-1].lower()
    if name in ('.env.example', '.env.sample', '.env.template', '.env.dist'):
        return False
    if name == '.env' or name.startswith('.env.'):
        return True
    if name.endswith(('.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.p8', '.ppk', '.kdbx')):
        return True
    if re.fullmatch(r'id_(rsa|dsa|ecdsa|ed25519)', name):
        return True
    return name in ('.netrc', '.npmrc', '.pypirc', '.git-credentials', 'credentials', '.envrc', '.pgpass',
                    '.htpasswd', '.boto', '.s3cfg')


def is_binary(data):
    """Git's own rule: a NUL byte in the first 8000 bytes."""
    return b'\0' in data[:8000]


# ---- credential exclusions ------------------------------------------------------------------------

EXCLUSIONS_VERSION = 1
EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'


class Exclusions(namedtuple('Exclusions', 'paths oids')):
    """Credential identities whose contents never reach the model: protected paths, and the non-empty
    regular blobs that held credential bytes. Each generation carries the record forward and only
    adds to it, so a credential's origin survives renames, edits and later rebuilds."""


NO_EXCLUSIONS = Exclusions(frozenset(), frozenset())


class ExclusionsError(ValueError):
    """A stored exclusion record is missing a field, malformed, or not in its canonical form."""


def _secret_blob(entry):
    # Empty files are never recorded, so an ordinary empty file never shares an empty credential's ID.
    return entry.type == 'blob' and entry.mode in REGULAR_MODES and entry.size > 0


def credential_exclusions(inherited, base_manifest, target_manifest, changes=()):
    """The exclusions for one generation: `inherited` (the previous document's record), plus every
    credential name in either manifest, plus whatever inherits protection from those. A rename or
    copy from a protected path or blob, or from a credential name, protects its destination path and
    blob, edited or not; any entry at a protected path or holding a protected blob adds its path and
    blob. Repeated until nothing new is found. `base_manifest` is None when the previous commit isn't
    available; the inherited record still applies. Never drops an inherited entry."""
    paths, oids = set(inherited.paths), set(inherited.oids)
    base_manifest = base_manifest or {}
    entries = [*base_manifest.values(), *target_manifest.values()]

    def protect(entry):
        added = entry.path not in paths or (_secret_blob(entry) and entry.oid not in oids)
        paths.add(entry.path)
        if _secret_blob(entry):
            oids.add(entry.oid)
        return added

    for entry in entries:
        if is_credential_path(entry.path):
            protect(entry)
    grew = True
    while grew:
        grew = False
        for entry in entries:
            if entry.path in paths or (_secret_blob(entry) and entry.oid in oids):
                grew |= protect(entry)
        for c in changes:
            if c.status not in 'RC' or not c.old_path or not c.new_path:
                continue
            source = base_manifest.get(c.old_path)
            if (c.old_path in paths or is_credential_path(c.old_path)
                    or (source is not None and _secret_blob(source) and source.oid in oids)):
                destination = target_manifest.get(c.new_path)
                if destination is not None:
                    grew |= protect(destination)
                elif c.new_path not in paths:
                    paths.add(c.new_path)
                    grew = True
    return Exclusions(frozenset(paths), frozenset(oids))


def encode_exclusions(exclusions):
    """One header-safe value: standard base64 of canonical JSON (sorted arrays). Holds identities only,
    never credential bytes."""
    payload = {'version': EXCLUSIONS_VERSION, 'paths': sorted(exclusions.paths), 'oids': sorted(exclusions.oids)}
    return base64.b64encode(json.dumps(payload, separators=(',', ':'), sort_keys=True).encode('ascii')).decode('ascii')


def _valid_path(path):
    return (isinstance(path, str) and path and not path.startswith('/') and '\0' not in path
            and all(part not in ('', '.', '..') for part in path.split('/')))


def decode_exclusions(value):
    """The Exclusions in a stored header value. Raises ExclusionsError unless it is exactly what
    encode_exclusions writes: this version, both fields, relative paths and full non-empty blob IDs,
    sorted and without duplicates."""
    try:
        payload = json.loads(base64.b64decode(str(value).encode('ascii'), validate=True).decode('ascii'))
    except (ValueError, UnicodeError):
        raise ExclusionsError('not base64-encoded JSON') from None
    if not isinstance(payload, dict) or set(payload) != {'version', 'paths', 'oids'}:
        raise ExclusionsError('expected exactly version, paths and oids')
    if type(payload['version']) is not int or payload['version'] != EXCLUSIONS_VERSION:
        raise ExclusionsError(f"unsupported version {payload['version']!r}")
    paths, oids = payload['paths'], payload['oids']
    if not isinstance(paths, list) or not all(_valid_path(p) for p in paths):
        raise ExclusionsError('paths must be relative path strings')
    if not isinstance(oids, list) or not all(isinstance(o, str) and SHA.fullmatch(o) and o != EMPTY_BLOB for o in oids):
        raise ExclusionsError('oids must be full, non-empty blob IDs')
    if paths != sorted(set(paths)) or oids != sorted(set(oids)):
        raise ExclusionsError('paths and oids must be sorted and unique')
    return Exclusions(frozenset(paths), frozenset(oids))


def omission_reason(entry, exclusions=NO_EXCLUSIONS):
    """Why `entry`'s contents are unavailable to the model, or None when it can be read. `exclusions`
    carries credential origin: a protected path, or a blob that held credential bytes."""
    if entry.mode == '120000':
        return 'symlink'
    if entry.type == 'commit':
        return 'submodule'
    if entry.mode not in REGULAR_MODES:
        return 'not a regular file'
    if is_credential_path(entry.path) or entry.path in exclusions.paths or entry.oid in exclusions.oids:
        return 'credential file'
    return None


class GitSnapshot:
    """One pinned commit of a repository."""

    def __init__(self, repo_path, commit):
        if not SHA.fullmatch(commit or ''):
            raise ValueError(f"not a full commit ID: {commit!r}")
        self.repo = repo_path
        self.commit = commit
        self._manifest = None

    def tree_id(self):
        return run_git(self.repo, ['rev-parse', '--verify', f'{self.commit}^{{tree}}'], 1024).decode().strip()

    def manifest(self):
        """Every tracked path at this commit: path -> Entry. NUL-delimited, so any file name works."""
        if self._manifest is None:
            raw = run_git(self.repo, ['ls-tree', '-r', '-z', '-l', '--full-tree', self.commit], 256 * 1024 * 1024)
            entries = {}
            for record in raw.split(b'\0'):
                if not record:
                    continue
                meta, path = record.split(b'\t', 1)
                mode, kind, oid, size = meta.decode().split()
                path = path.decode('utf-8', 'surrogateescape')
                entries[path] = Entry(path, mode, kind, oid, int(size) if size.isdigit() else 0)
            self._manifest = entries
        return self._manifest

    def read_blob(self, entry, limit):
        return run_git(self.repo, ['cat-file', 'blob', entry.oid], limit)


def collector_eligible(entry, roots=frozenset({''})):
    """Whether the full collector includes this file (path rules, with `roots` the build roots, and its
    100 KiB ceiling). Only regular files count: the pinned reader never follows symlinks."""
    return (entry is not None and entry.mode in REGULAR_MODES
            and should_include_file(entry.path, roots) and entry.size <= COLLECTOR_MAX_BYTES)


def changes_between(repo, base, target, deadline=None):
    """Changed paths between two commits, with renames and copies detected (both paths are reported). Copy
    sources include unchanged files, and there's no candidate cutoff: credential exclusions depend on this
    seeing an edited credential moved within a huge change, or copied from a file that didn't change. That
    search can be long, so it always has a deadline, and running out is a stop (ResourceLimit), never a
    partial list to build exclusions from."""
    raw = run_git(repo, ['diff-tree', '-r', '-z', '-M', '-C', '--find-copies-harder', '-l0', '--raw', '--no-abbrev',
                         '--no-commit-id', '--no-ext-diff', base, target], 64 * 1024 * 1024,
                  deadline or Deadline(DISCOVERY_SECONDS))
    fields = raw.split(b'\0')
    out = []
    i = 0
    while i < len(fields) and fields[i]:
        status = fields[i].decode().split()[-1]
        letter = status[0]
        if letter in 'RC':
            out.append(Change(letter, fields[i + 1].decode('utf-8', 'surrogateescape'),
                              fields[i + 2].decode('utf-8', 'surrogateescape')))
            i += 3
        else:
            path = fields[i + 1].decode('utf-8', 'surrogateescape')
            out.append(Change(letter, None if letter == 'A' else path, None if letter == 'D' else path))
            i += 2
    return out


ChangeSize = namedtuple('ChangeSize', 'fraction file_fraction byte_fraction changed_files eligible_files changed_bytes eligible_bytes')


def change_fraction(base_manifest, target_manifest, changes):
    """How much of the collector-eligible source changed, as the larger of the file and byte fractions.

    The denominator is the union of paths eligible at either commit. Each path weighs the larger of
    its eligible sizes at the two commits, so deletions and files crossing the size ceiling count and
    a modified file counts once. A change counts both paths of a rename. Returns None when no file is
    eligible at either commit (nothing to analyze incrementally).
    """
    roots = build_roots(base_manifest, target_manifest)

    def eligible_size(entry):
        return entry.size if collector_eligible(entry, roots) else None

    union = {p for p, e in base_manifest.items() if collector_eligible(e, roots)}
    union |= {p for p, e in target_manifest.items() if collector_eligible(e, roots)}
    if not union:
        return None

    def weight(path):
        sizes = [s for s in (eligible_size(base_manifest.get(path)), eligible_size(target_manifest.get(path))) if s is not None]
        return max(sizes) if sizes else 0

    changed = set()
    for c in changes:
        # A copy's source didn't change.
        changed.update(p for p in (None if c.status == 'C' else c.old_path, c.new_path) if p)
    changed &= union
    total = sum(weight(p) for p in union)
    moved = sum(weight(p) for p in changed)
    file_fraction = len(changed) / len(union)
    byte_fraction = moved / total if total else file_fraction
    return ChangeSize(max(file_fraction, byte_fraction), file_fraction, byte_fraction,
                      len(changed), len(union), moved, total)


def _paginate(lines, page_bytes=MAX_RESULT_BYTES - 1024):
    """Split text lines into pages of at most `page_bytes` UTF-8 bytes; a line longer than a page is split."""
    pages, current, size = [], [], 0
    for line in lines:
        data = line.encode('utf-8', 'replace')
        while len(data) > page_bytes:
            if current:
                pages.append(''.join(current))
                current, size = [], 0
            piece = data[:page_bytes].decode('utf-8', 'ignore')
            pages.append(piece)
            data = data[len(piece.encode('utf-8')):]
        line = data.decode('utf-8', 'ignore')
        if size + len(data) > page_bytes and current:
            pages.append(''.join(current))
            current, size = [], 0
        current.append(line)
        size += len(data)
    if current:
        pages.append(''.join(current))
    return pages or ['']


# ---- the page stream: complete, independently readable pages ---------------------------------------

# Explicit lists, not "all JSON or configuration": ordinary manifests and source stay visible.
LOCKFILE_NAMES = frozenset({
    'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'deno.lock',
    'composer.lock', 'gemfile.lock', 'cargo.lock', 'poetry.lock', 'pipfile.lock', 'uv.lock', 'pdm.lock', 'go.sum',
    'mix.lock', 'pubspec.lock', 'podfile.lock', 'flake.lock', 'packages.lock.json', 'gradle.lockfile',
})
GENERATED_DIRS = frozenset({'node_modules', '.next', '.nuxt', '__pycache__', 'pods', '.gradle', '.terraform'})
# `vendor`, `dist` and `coverage` are generated only at a build root (files.under_build_output), which is
# the repository root or a folder holding one of BUILD_MANIFESTS.
BUILD_MANIFESTS = frozenset({'package.json', 'go.mod', 'composer.json', 'gemfile', 'pyproject.toml', 'setup.py',
                             'cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'mix.exs', 'pubspec.yaml'})
GENERATED_SUFFIXES = ('.min.js', '.min.css', '.js.map', '.css.map', '.pb.go', '_pb2.py')
OVERSIZED_DIFF = 'diff larger than 2 MiB'

FileRef = namedtuple('FileRef', 'id status old_path new_path')
Omission = namedtuple('Omission', 'file_id status path reason')
Page = namedtuple('Page', 'id kind file_ids path size')   # kind: 'diff', or 'omissions' (no model call)


def build_roots(*manifests):
    """The lowercased folders that hold a build manifest in any of `manifests`, plus the repository root ('')."""
    roots = {''}
    for manifest in manifests:
        for path in manifest or ():
            folder, _, name = path.lower().rpartition('/')
            if name in BUILD_MANIFESTS:
                roots.add(folder)
    return roots


def generated_reason(path, roots=frozenset({''})):
    """Why a changed path's body isn't worth a model's attention, or None for ordinary files. `roots` are the
    build roots (build_roots) where a `vendor`, `dist` or `coverage` folder counts as generated."""
    parts = path.lower().split('/')
    if parts[-1] in LOCKFILE_NAMES:
        return 'lockfile'
    if (any(part in GENERATED_DIRS for part in parts[:-1]) or parts[-1].endswith(GENERATED_SUFFIXES)
            or under_build_output(path, roots)):
        return 'generated or vendored'
    return None


def _shown(path):
    """A path as page text: names that aren't valid UTF-8 can't go into a request as they are."""
    return path.encode('utf-8', 'replace').decode('utf-8')


def _file_label(ref):
    if ref.old_path and ref.new_path and ref.old_path != ref.new_path:
        return f"{_shown(ref.old_path)} -> {_shown(ref.new_path)}"
    return _shown(ref.new_path or ref.old_path)


def _diff_lines(text):
    return re.findall(r'[^\n]*\n|[^\n]+', text)


class _PageWriter:
    """Writes pages of at most `limit` bytes to an owner-only spool, holding only the current page.

    Every page names its commits and the files on it. A page breaks at a file or hunk boundary when it
    can. A split hunk or line repeats its file and hunk heading and says it is a continuation, so a page
    is never an anonymous middle fragment.
    """

    def __init__(self, spool_dir, base, target, limit, spool_limit):
        self.dir, self.base, self.target = spool_dir, base, target
        self.limit, self.spool_limit = limit, spool_limit
        self.pages, self.total = [], 0
        self.kind = 'diff'
        self.started = set()   # files that already have a heading on some page
        self._header = len(self._heading(9_999_999))
        self._clear()

    def _heading(self, number):
        return (f"[page p{number} base={self.base} target={self.target}]\n"
                f"[files on this page: id, status, path]\n[end of list]\n\n")

    def _clear(self):
        self.refs, self.refs_size = {}, 0
        self.body, self.size = [], 0
        self.current, self.current_hunk = None, None

    def room(self):
        return self.limit - self._header - self.refs_size - self.size

    @staticmethod
    def _ref_line(ref):
        return f"{ref.id} {ref.status} {_file_label(ref)}\n"

    def _write(self, text):
        self.body.append(text)
        self.size += len(text.encode('utf-8'))

    def flush(self):
        if not self.body:
            return
        number = len(self.pages) + 1
        listing = ''.join(self._ref_line(ref) for ref in self.refs.values())
        text = (f"[page p{number} base={self.base} target={self.target}]\n"
                f"[files on this page: id, status, path]\n{listing}[end of list]\n\n{''.join(self.body)}")
        data = text.encode('utf-8')
        if self.total + len(data) > self.spool_limit:
            raise ResourceLimit(f"the update's filtered diff is larger than the {self.spool_limit // (1024 * 1024)} "
                                f"MiB spool limit")
        path = os.path.join(self.dir, f"page-{number:07d}.txt")
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as handle:
                handle.write(data)
        except OSError as e:
            raise ResourceLimit(f"the page spool could not be written ({e.strerror or type(e).__name__})") from None
        self.total += len(data)
        self.pages.append(Page(f"p{number}", self.kind, tuple(self.refs), path, len(data)))
        self._clear()

    def _enter(self, ref, hunk, at_hunk_start):
        """Identify the file, and when a hunk continues here the hunk, at this point of the page."""
        title = f"### {ref.id} {ref.status} {_file_label(ref)}"
        lines = ''
        if self.current != ref.id:
            lines = f"{title}{' (continued)' if ref.id in self.started else ''}\n"
        if hunk and not at_hunk_start and self.current_hunk != hunk:
            lines += f"{hunk.rstrip()} (continued)\n"
        listing = 0 if ref.id in self.refs else len(self._ref_line(ref).encode('utf-8'))
        if len(lines.encode('utf-8')) + listing + 256 > self.room() and self.body:
            self.flush()
            return self._enter(ref, hunk, at_hunk_start)
        if ref.id not in self.refs:
            self.refs[ref.id] = ref
            self.refs_size += listing
        if lines:
            self._write(lines)
        self.current = ref.id
        self.started.add(ref.id)

    def _stream(self, ref, lines, hunk=None):
        for index, line in enumerate(lines):
            data = line.encode('utf-8', 'replace')
            while True:
                self._enter(ref, hunk, hunk is not None and index == 0)
                if len(data) <= self.room():
                    self._write(data.decode('utf-8'))
                    self.current_hunk = hunk
                    break
                # Only a line longer than a whole page is cut, with the rest marked as its continuation.
                fresh = self.limit - self._header - len(self._ref_line(ref).encode('utf-8')) - 1024
                if len(data) <= fresh and self.body:
                    self.flush()
                    continue
                marker = ' [line continues]\n'
                take = data[:max(self.room() - len(marker), 1)].decode('utf-8', 'ignore')
                self._write(take + marker)
                self.current_hunk = hunk
                data = b'[line continued] ' + data[len(take.encode('utf-8')):]
                self.flush()

    def add_file(self, ref, text):
        lines = _diff_lines(text)
        first = next((i for i, line in enumerate(lines) if line.startswith('@@ ')), len(lines))
        self._stream(ref, lines[:first] or ['(no textual change)\n'])
        starts = [i for i in range(first, len(lines)) if lines[i].startswith('@@ ')]
        for at, start in enumerate(starts):
            end = starts[at + 1] if at + 1 < len(starts) else len(lines)
            hunk = lines[start:end]
            size = sum(len(line.encode('utf-8', 'replace')) for line in hunk)
            # Keep a hunk whole when a fresh page can hold it.
            if size + 512 > self.room() and self.body and size + 2048 < self.limit - self._header - self.refs_size:
                self.flush()
            self._stream(ref, hunk, hunk=lines[start])


class PageSet:
    """Every page of one update, indexed before anything is sent, with the omission records kept apart
    from anything a model writes. Page text lives in the spool; read() brings back one page."""

    def __init__(self, base, target, files, omissions, pages, total):
        self.base, self.target, self.files, self.omissions = base, target, files, omissions
        self.pages, self.total_bytes = pages, total

    def read(self, page):
        try:
            with open(page.path, encoding='utf-8', newline='') as handle:   # CRLF stays as it is in the diff
                return handle.read()
        except OSError as e:
            raise ResourceLimit(f"the page spool could not be read ({e.strerror or type(e).__name__})") from None

    @property
    def diff_pages(self):
        return [p for p in self.pages if p.kind == 'diff']

    @property
    def omission_pages(self):
        return [p for p in self.pages if p.kind == 'omissions']

    @property
    def omitted(self):
        return [(o.path, o.reason) for o in self.omissions]


def prepare_pages(repo, base, target, base_manifest, target_manifest, changes, exclusions, spool_dir,
                  page_bytes=MAX_PAGE_BYTES, spool_bytes=MAX_SPOOL_BYTES, deadline=None):
    """Spool the filtered diff of an update as complete pages in owner-only `spool_dir`.

    Files whose contents are unavailable (credentials and anything `exclusions` protects, symlinks,
    submodules, binary files), known lockfiles and generated artifacts, and any single diff larger than
    MAX_FILE_DIFF_BYTES become omission records with path, status and reason instead of bodies, on their
    own pages at the end. Only a Git output-size limit can become an oversized-diff omission; a failed
    Git read raises. `deadline` bounds the whole loop and each file's diff. Raises ResourceLimit past the
    deadline or the spool ceiling, or when the disk is full.
    """
    writer = _PageWriter(spool_dir, base, target, page_bytes, spool_bytes)
    files, omissions = {}, []
    roots = build_roots(base_manifest, target_manifest)
    for number, c in enumerate(changes, 1):
        if deadline is not None and deadline.left() <= 0:
            raise ResourceLimit('preparing the diff ran out of time')
        ref = FileRef(f"f{number}", c.status, c.old_path, c.new_path)
        files[ref.id] = ref
        label = c.new_path or c.old_path
        entries = [e for e in (base_manifest.get(c.old_path) if c.old_path else None,
                               target_manifest.get(c.new_path) if c.new_path else None) if e]
        reasons = {omission_reason(e, exclusions) for e in entries} - {None}
        reason = sorted(reasons)[0] if reasons else generated_reason(label, roots)
        text = None
        if reason is None:
            # A copy's source has its own record if it changed, so its diff isn't repeated here.
            paths = [c.new_path] if c.status == 'C' else [p for p in (c.old_path, c.new_path) if p]
            try:
                text = run_git(repo, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '-M', base, target,
                                      '--', *dict.fromkeys(paths)], MAX_FILE_DIFF_BYTES,
                               deadline).decode('utf-8', 'replace')
            except GitOutputTooLarge:
                reason = OVERSIZED_DIFF
            else:
                if re.search(r'^Binary files .* differ$', text, re.M) and '\n@@ ' not in text:
                    reason = 'binary file'
        if reason is not None:
            omissions.append(Omission(ref.id, c.status, label, reason))
            continue
        writer.add_file(ref, text)
    writer.flush()
    writer.kind = 'omissions'
    for record in omissions:
        changed = ' changed' if record.reason == 'lockfile' else ''
        writer._stream(files[record.file_id], [f"{record.reason}{changed}; body not analyzed\n"])
    writer.flush()
    return PageSet(base, target, files, omissions, writer.pages, writer.total)


# ---- read-only tools ------------------------------------------------------------------------------

TOOL_SPECS = [
    {"name": "read_file",
     "description": "Read lines of a tracked text file at the new commit (version 'target') or the analyzed commit (version 'base').",
     "parameters": {"type": "object", "properties": {
         "path": {"type": "string"}, "start_line": {"type": "integer", "minimum": 1},
         "limit": {"type": "integer", "minimum": 1, "maximum": 2000},
         "version": {"type": "string", "enum": ["target", "base"]}},
         "required": ["path"], "additionalProperties": False}},
    {"name": "search",
     "description": "Find lines containing a literal string in tracked text files at the new commit, optionally under a path prefix.",
     "parameters": {"type": "object", "properties": {
         "literal": {"type": "string", "minLength": 1, "maxLength": 200},
         "path_prefix": {"type": "string"}, "page": {"type": "integer", "minimum": 1}},
         "required": ["literal"], "additionalProperties": False}},
]


class ToolRequestError(Exception):
    """The model asked for something outside the tool contract; the attempt stops."""


def _int(args, key, default, low, high):
    value = args.get(key, default)
    if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
        raise ToolRequestError(f"{key} must be an integer from {low} to {high}")
    return value


def _str(args, key, default=None, max_len=1024):
    value = args.get(key, default)
    if not isinstance(value, str) or len(value) > max_len:
        raise ToolRequestError(f"{key} must be a string of at most {max_len} characters")
    return value


class SnapshotTools:
    """The model's targeted, read-only view of the two pinned commits. `exclusions` is the generation's
    effective record (credential_exclusions), the same one the pages used."""

    def __init__(self, base, target, exclusions):
        self.base, self.target = base, target
        self._exclusions = exclusions
        self.bytes_read = 0

    def _omitted(self, entry):
        return omission_reason(entry, self._exclusions)

    def run(self, name, raw_args):
        try:
            args = json.loads(raw_args or '{}')
        except (TypeError, ValueError):
            raise ToolRequestError(f"{name}: arguments are not valid JSON") from None
        if not isinstance(args, dict):
            raise ToolRequestError(f"{name}: arguments must be an object")
        handler = {'read_file': self._read_file, 'search': self._search}.get(name)
        if handler is None:
            raise ToolRequestError(f"unknown tool: {name}")
        allowed = {s['name']: set(s['parameters']['properties']) for s in TOOL_SPECS}[name]
        extra = set(args) - allowed
        if extra:
            raise ToolRequestError(f"{name}: unexpected arguments {sorted(extra)}")
        text = handler(args)
        data = text.encode('utf-8')
        if len(data) > MAX_RESULT_BYTES:
            text = data[:MAX_RESULT_BYTES - 200].decode('utf-8', 'ignore') + "\n[result truncated at 64 KiB]\n"
        self.bytes_read += len(text.encode('utf-8'))
        return text

    def _read_file(self, args):
        path = _str(args, 'path')
        start = _int(args, 'start_line', 1, 1, 10_000_000)
        limit = _int(args, 'limit', 400, 1, 2000)
        version = _str(args, 'version', 'target')
        if version not in ('target', 'base'):
            raise ToolRequestError("version must be 'target' or 'base'")
        snap = self.target if version == 'target' else self.base
        entry = snap.manifest().get(path)
        if entry is None:
            return f"[{path} is not a tracked file at the {version} commit]"
        reason = self._omitted(entry)
        if reason:
            return f"[{path} is unavailable: {reason}]"
        try:
            data = snap.read_blob(entry, MAX_READ_BYTES)
        except GitOutputTooLarge:
            return f"[{path} is unavailable: larger than {MAX_READ_BYTES} bytes]"
        if is_binary(data):
            return f"[{path} is unavailable: binary file]"
        lines = data.decode('utf-8', 'replace').splitlines()
        out, size = [f"[{path} at {version}, {len(lines)} lines]\n"], 0
        for number in range(start, min(len(lines), start + limit - 1) + 1):
            line = lines[number - 1]
            if len(line) > MAX_LINE_CHARS:
                line = line[:MAX_LINE_CHARS] + f" [line shortened from {len(line)} characters]"
            row = f"{number}: {line}\n"
            size += len(row.encode('utf-8'))
            if size > MAX_RESULT_BYTES - 1024:
                out.append(f"[stopped at 64 KiB; continue with start_line={number}]\n")
                break
            out.append(row)
        return ''.join(out)

    def _search(self, args):
        literal = _str(args, 'literal', max_len=200)
        if not literal or '\n' in literal or '\0' in literal:
            raise ToolRequestError("literal must be a non-empty single line")
        prefix = _str(args, 'path_prefix', '')
        page = _int(args, 'page', 1, 1, 100000)
        manifest = self.target.manifest()
        cmd = ['grep', '-I', '-n', '-z', '--no-color', '-F', '-e', literal, self.target.commit]
        if prefix:
            # Narrow inside Git, before its output cap, by naming the readable files under the prefix
            # (literal pathspecs, so a partial file name keeps its prefix meaning).
            under = [p for p, e in manifest.items() if p.startswith(prefix) and not self._omitted(e)]
            if not under:
                return f"[no readable tracked path starts with {prefix!r}]"
            cmd += ['--', *under]
            arg_bytes = sum(len(os.fsencode(arg)) + 1 for arg in cmd)   # each argument plus its NUL
            if len(under) > MAX_SEARCH_PATHS or arg_bytes > MAX_SEARCH_ARG_BYTES:
                return f"[{len(under)} files start with {prefix!r}; use a narrower path_prefix]"
        try:
            raw = run_git(self.target.repo, cmd, MAX_SEARCH_OUTPUT)
        except GitError as e:
            if 'failed (1)' in str(e):
                return "[no matches]"
            if 'more than' in str(e):
                return "[too many matches; narrow the search with path_prefix or a longer literal]"
            raise
        lines = []
        for row in raw.decode('utf-8', 'replace').split('\n'):
            if not row:
                continue
            parts = row.split('\0')
            if len(parts) < 3:
                continue
            path = parts[0].split(':', 1)[1] if ':' in parts[0] else parts[0]
            entry = manifest.get(path)
            if not path.startswith(prefix) or entry is None or self._omitted(entry):
                continue
            text = parts[2]
            if len(text) > 300:
                text = text[:300] + ' [shortened]'
            lines.append(f"{path}:{parts[1]}: {text}\n")
        if not lines:
            return "[no matches]"
        pages = _paginate(lines)
        if page > len(pages):
            return f"[no page {page}; {len(pages)} page(s)]"
        return f"[page {page} of {len(pages)}; {len(lines)} match(es)]\n{pages[page - 1]}"
