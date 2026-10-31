"""Pinned Git inputs for incremental metadata: tree manifests, the change threshold, and the read-only
tools the model uses to look at source.

Everything here reads Git objects named by commit, tree and blob IDs, never the working tree, so
changes to the checkout during an analysis cannot change its inputs. Git runs with a minimal
environment (no credentials, no global or system config), without external diff or textconv
helpers or optional locks, and its output is bounded while it is read. Arguments come from
validated commit IDs and manifest membership; model-supplied text is only ever data (a literal
search string, or a path looked up in the manifest).
"""

import json
import os
import re
import shutil
import subprocess
import threading
from collections import namedtuple

from repo_radar.files import should_include_file

COLLECTOR_MAX_BYTES = 100 * 1024     # files.collect_repo_files skips files larger than this
MAX_RESULT_BYTES = 64 * 1024          # one tool result, or one diff page
MAX_DIFF_BYTES = 16 * 1024 * 1024     # the whole textual diff of one update
MAX_FILE_DIFF_BYTES = 2 * 1024 * 1024 # one file's diff; larger ones are listed as omitted, not cut
MAX_READ_BYTES = 8 * 1024 * 1024      # one blob read by read_file
MAX_LINE_CHARS = 2000                 # longer lines are shortened, with a marker
MAX_SEARCH_OUTPUT = 4 * 1024 * 1024   # git grep output read for one search
MAX_SEARCH_PATHS = 2000               # files named to git grep for one path_prefix
MAX_SEARCH_ARG_BYTES = 64 * 1024      # encoded grep arguments for one search, leaving room for the rest
REGULAR_MODES = frozenset({'100644', '100755'})
SHA = re.compile(r'^[0-9a-f]{40}$')
_GIT_PATH = '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin'

Entry = namedtuple('Entry', 'path mode type oid size')
Change = namedtuple('Change', 'status old_path new_path')


class GitError(Exception):
    """A read-only Git command failed or produced more output than allowed."""


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


def run_git(repo, args, limit):
    """Run a read-only git command in `repo` and return at most `limit` bytes of its stdout.

    Raises GitError on a non-zero exit, or as soon as the output exceeds `limit` (the process is
    killed rather than buffered).
    """
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
    out = bytearray()
    too_large = False
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
    reader.join(timeout=5)
    if too_large:
        raise GitError(f"git {args[0]} produced more than {limit} bytes")
    if proc.returncode != 0:
        detail = err.decode('utf-8', 'replace').strip().splitlines()
        raise GitError(f"git {args[0]} failed ({proc.returncode})" + (f": {detail[-1][:200]}" if detail else ''))
    return bytes(out)


def resolve_commit(repo, rev):
    """The full commit ID for `rev` ('HEAD' or a 40-character commit ID), or None."""
    if rev != 'HEAD' and not SHA.match(rev or ''):
        return None
    try:
        out = run_git(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', f'{rev}^{{commit}}'], 1024)
    except GitError:
        return None
    sha = out.decode().strip()
    return sha if SHA.match(sha) else None


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


def credential_oids(*manifests):
    """Non-empty regular blobs stored under a credential path anywhere in these manifests. The same
    bytes stay withheld under any other name, a template name included. Empty files are left out, so
    an empty ordinary file never shares an empty credential's identity."""
    return frozenset(e.oid for m in manifests for e in m.values()
                     if e.type == 'blob' and e.mode in REGULAR_MODES and e.size > 0 and is_credential_path(e.path))


def renamed_credentials(changes):
    """New paths of files renamed or copied from a credential path, whose contents stay withheld."""
    return frozenset(c.new_path for c in changes if c.status in 'RC' and c.old_path and is_credential_path(c.old_path))


def omission_reason(entry, withheld=frozenset(), secret_oids=frozenset()):
    """Why `entry`'s contents are unavailable to the model, or None when it can be read. `withheld` and
    `secret_oids` carry credential origin: a renamed credential, or a credential's bytes elsewhere."""
    if entry.mode == '120000':
        return 'symlink'
    if entry.type == 'commit':
        return 'submodule'
    if entry.mode not in REGULAR_MODES:
        return 'not a regular file'
    if is_credential_path(entry.path) or entry.path in withheld or entry.oid in secret_oids:
        return 'credential file'
    return None


class GitSnapshot:
    """One pinned commit of a repository."""

    def __init__(self, repo_path, commit):
        if not SHA.match(commit or ''):
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


def collector_eligible(entry):
    """Whether today's full-generation collector would include this file (path rules and its
    100 KiB ceiling). Only regular files count: the pinned reader never follows symlinks."""
    return (entry is not None and entry.mode in REGULAR_MODES
            and should_include_file(entry.path) and entry.size <= COLLECTOR_MAX_BYTES)


def changes_between(repo, base, target):
    """Changed paths between two commits, with renames detected (both paths are reported)."""
    raw = run_git(repo, ['diff-tree', '-r', '-z', '-M', '--raw', '--no-abbrev', '--no-commit-id',
                         '--no-ext-diff', base, target], 64 * 1024 * 1024)
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
    def eligible_size(entry):
        return entry.size if collector_eligible(entry) else None

    union = {p for p, e in base_manifest.items() if collector_eligible(e)}
    union |= {p for p, e in target_manifest.items() if collector_eligible(e)}
    if not union:
        return None

    def weight(path):
        sizes = [s for s in (eligible_size(base_manifest.get(path)), eligible_size(target_manifest.get(path))) if s is not None]
        return max(sizes) if sizes else 0

    changed = set()
    for c in changes:
        changed.update(p for p in (c.old_path, c.new_path) if p)
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


def build_diff(repo, base, target, base_manifest, target_manifest, changes):
    """The textual diff of an update, split into pages, plus the paths whose contents were omitted.

    Files whose contents are unavailable (credentials, symlinks, submodules) appear only as a status
    line; binary files as Git reports them. A single file's diff larger than MAX_FILE_DIFF_BYTES is
    listed as omitted, so the model knows to read the file rather than assume nothing changed.
    Raises GitError if the whole diff exceeds MAX_DIFF_BYTES.
    """
    lines, omitted, total = [], [], 0
    withheld, secret = renamed_credentials(changes), credential_oids(base_manifest, target_manifest)
    for c in changes:
        entries = [e for e in (base_manifest.get(c.old_path) if c.old_path else None,
                               target_manifest.get(c.new_path) if c.new_path else None) if e]
        reasons = {omission_reason(e, withheld, secret) for e in entries} - {None}
        label = c.new_path or c.old_path
        if reasons:
            reason = sorted(reasons)[0]
            lines.append(f"### {c.status} {label} (contents omitted: {reason})\n")
            omitted.append((label, reason))
            continue
        paths = [p for p in (c.old_path, c.new_path) if p]
        try:
            text = run_git(repo, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '-M', base, target,
                                  '--', *dict.fromkeys(paths)], MAX_FILE_DIFF_BYTES).decode('utf-8', 'replace')
        except GitError:
            lines.append(f"### {c.status} {label} (diff omitted: larger than {MAX_FILE_DIFF_BYTES} bytes; "
                         f"use read_file)\n")
            omitted.append((label, 'diff too large'))
            continue
        total += len(text.encode('utf-8'))
        if total > MAX_DIFF_BYTES:
            raise GitError(f"the diff is larger than {MAX_DIFF_BYTES} bytes")
        lines.extend(text.splitlines(keepends=True))
    return _paginate(lines), omitted


# ---- read-only tools ------------------------------------------------------------------------------

TOOL_SPECS = [
    {"name": "read_diff",
     "description": "Read one page of the textual diff between the analyzed and new commit. Every page must be read before answering.",
     "parameters": {"type": "object", "properties": {"page": {"type": "integer", "minimum": 1}},
                    "required": ["page"], "additionalProperties": False}},
    {"name": "list_paths",
     "description": "List tracked paths at the new commit that start with a prefix, with sizes and any reason a file is unavailable.",
     "parameters": {"type": "object", "properties": {"prefix": {"type": "string"}, "page": {"type": "integer", "minimum": 1}},
                    "required": ["prefix"], "additionalProperties": False}},
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
    """The model's read-only view of the two pinned commits and the diff between them."""

    def __init__(self, base, target, diff_pages, changes=()):
        self.base, self.target = base, target
        self.diff_pages = diff_pages
        self._withheld = renamed_credentials(changes)
        self._secret = credential_oids(base.manifest(), target.manifest())
        self.seen_pages = {1}  # the first page is part of the opening message
        self.bytes_read = 0

    def _omitted(self, entry):
        return omission_reason(entry, self._withheld, self._secret)

    def unseen_pages(self):
        return [p for p in range(1, len(self.diff_pages) + 1) if p not in self.seen_pages]

    def run(self, name, raw_args):
        try:
            args = json.loads(raw_args or '{}')
        except (TypeError, ValueError):
            raise ToolRequestError(f"{name}: arguments are not valid JSON") from None
        if not isinstance(args, dict):
            raise ToolRequestError(f"{name}: arguments must be an object")
        handler = {'read_diff': self._read_diff, 'list_paths': self._list_paths,
                   'read_file': self._read_file, 'search': self._search}.get(name)
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

    def _read_diff(self, args):
        page = _int(args, 'page', 1, 1, len(self.diff_pages))
        self.seen_pages.add(page)
        return f"[diff page {page} of {len(self.diff_pages)}]\n{self.diff_pages[page - 1]}"

    def _list_paths(self, args):
        prefix = _str(args, 'prefix', '')
        page = _int(args, 'page', 1, 1, 100000)
        lines = []
        for path, entry in sorted(self.target.manifest().items()):
            if path.startswith(prefix):
                reason = self._omitted(entry)
                lines.append(f"{path}\t{entry.size}" + (f"\t(unavailable: {reason})" if reason else '') + "\n")
        pages = _paginate(lines)
        if page > len(pages):
            return f"[no page {page}; {len(pages)} page(s)]"
        return f"[page {page} of {len(pages)}; {len(lines)} path(s)]\n{pages[page - 1]}"

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
        except GitError:
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
