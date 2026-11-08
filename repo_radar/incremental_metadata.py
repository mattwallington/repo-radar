"""Incremental metadata for opted-in repositories (config `incremental_metadata_repos`).

Each document records the commit it was built from. A later sync updates it from that commit: the
model summarizes each page of the diff, the notes are merged, and a final editor returns section edits
that the app validates and applies. A full rebuild still happens weekly, when the model or policy
changes, or when the baseline cannot be used; it reads the pinned source in chunks of at most 128,000
input tokens and is capped at $40 per attempt. Both run on the shared summary_pipeline. Every other
repository keeps the existing full-generation path unchanged.

A failure never replaces a good document: it stays as it was, and INDEX marks it stale.
"""

import hashlib
import json
import os
import re
import tempfile
from collections import namedtuple
from datetime import datetime, timedelta
from pathlib import Path

from repo_radar.config import DEFAULT_INCREMENTAL_FAILURE_STOP, DEFAULT_INCREMENTAL_FULL_REBUILD_DAYS
from repo_radar.metadata import (STATE_DIR_NAME, PARSE_STATUS_OK, parse_frontmatter, read_attempt_state,
                                 _parse_status_of)
from repo_radar import metadata_snapshot as snap

# Bump when what a document means changes (prompt contract, edit protocol, collector rules), so
# every opted-in document is rebuilt once under the new policy.
SEMANTIC_POLICY = 'repo-radar-metadata/1'
UNKNOWN = 'unknown'
PIPELINE_VERSION = 'summary-pipeline/1'  # the engine; a new one doesn't force a rebuild the way a policy does

Document = namedtuple('Document', 'path text sha256 info body')
Decision = namedtuple('Decision', 'strategy reason base target full_built_at full_model change adopt')
PreparedDiff = namedtuple('PreparedDiff', 'base_snap target_snap changes exclusions pages')
UNFINISHED = ('pending', 'committing', 'failed', 'skipped')   # attempt statuses that never published
# Why older versions chose a full rebuild, for triggers that no longer exist: a rebuild that didn't finish
# for one of these reasons isn't owed any more.
_REMOVED_TRIGGER = re.compile(r'\d+% of the source changed|\d+ diff pages exceeds \d+|'
                              r'diff exceeds the incremental size limit|no analyzable source')
WEEKLY_REASON = 'weekly full rebuild due'
UNFINISHED_REASON = 'previous full rebuild did not finish'
# Failed updates in a row before only a person can start another, unless Settings chose another number.
HOLD_AFTER_FAILURES = DEFAULT_INCREMENTAL_FAILURE_STOP
FAILURE_STREAK_DOC = 'failure_streak_doc_sha256'   # the document those failures were from


def document_path(pristine_dir, cache_name):
    return Path(pristine_dir) / f"{cache_name}.md"


def load_document(pristine_dir, cache_name):
    path = document_path(pristine_dir, cache_name)
    try:
        text = path.read_text(encoding='utf-8')
    except (OSError, UnicodeDecodeError):
        return None
    info = parse_frontmatter(text)
    if info is None:
        return None
    body = text.split('---', 2)[2]
    return Document(path, text, hashlib.sha256(text.encode('utf-8')).hexdigest(), info, body)


def read_document(pristine_dir, cache_name):
    """The current document for an update: None only when there is none (a first build). A document
    that exists but can't be read or parsed is kept as it is and stops the attempt, rather than
    looking like a first build with nothing to carry forward."""
    if not os.path.lexists(document_path(pristine_dir, cache_name)):
        return None
    doc = load_document(pristine_dir, cache_name)
    if doc is None:
        raise StaleUpdate('the existing metadata document cannot be read or parsed; it is kept as it is')
    return doc


# Header fields only this feature (or its pilot) writes; the full generator writes none of them.
EXCLUSIONS_KEY = 'credential_exclusions'
GENERATED_KEYS = ('semantic_policy', 'generation_id', 'generation_strategy', 'generation_model', 'pilot',
                  'full_build_commit', 'pipeline_version', EXCLUSIONS_KEY)


def document_exclusions(doc):
    """The credential exclusions `doc` carries forward. No document, or a legacy one from the full
    generator, starts from none (the snapshots then supply what they show). A generated document
    without a valid record raises StaleUpdate before any content is read, counted or sent: protection
    is never silently reset."""
    if doc is None:
        return snap.NO_EXCLUSIONS
    value = doc.info.get(EXCLUSIONS_KEY)
    if value is None:
        if any(key in doc.info for key in GENERATED_KEYS):
            raise StaleUpdate('the generated document records no credential exclusions; it is kept as it is')
        return snap.NO_EXCLUSIONS
    try:
        return snap.decode_exclusions(value)
    except snap.ExclusionsError as e:
        raise StaleUpdate(f"the document's credential exclusions are invalid ({e}); it is kept as it is") from None


def _parse_time(value):
    try:
        return datetime.fromisoformat(value) if value else None
    except (TypeError, ValueError):
        return None


def usable_baseline(doc, full_name):
    """(True, None) if `doc` can be updated incrementally; otherwise (False, reason)."""
    if doc is None:
        return False, 'no metadata document'
    if doc.info.get('full_name') != full_name:
        return False, 'document belongs to a different repository'
    if _parse_status_of(doc.info) != PARSE_STATUS_OK:
        return False, 'document is degraded'
    if not snap.SHA.fullmatch(doc.info.get('last_commit', '')):
        return False, 'document records no analyzed commit'
    if not _analysis_of(doc).strip():
        return False, 'document has no analysis'
    return True, None


# ---- attempt state ---------------------------------------------------------------------------------

def state_path(pristine_dir, cache_name):
    return Path(pristine_dir) / STATE_DIR_NAME / f"{cache_name}.json"


def write_state(pristine_dir, cache_name, state):
    """Atomically replace the repository's attempt state (owner-only)."""
    directory = Path(pristine_dir) / STATE_DIR_NAME
    directory.mkdir(mode=0o700, exist_ok=True)
    os.chmod(directory, 0o700)
    fd, tmp = tempfile.mkstemp(dir=str(directory), prefix=f".{cache_name}.", suffix='.tmp')
    try:
        with os.fdopen(fd, 'w') as handle:
            json.dump(state, handle, indent=2, sort_keys=True)
        os.chmod(tmp, 0o600)
        os.replace(tmp, state_path(pristine_dir, cache_name))
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ---- what to do --------------------------------------------------------------------------------------

def _full_build(doc, state, model):
    """(full_built_at, full_model, configured_model, adopt) for a usable document.

    A document written by this feature records its last full build. A legacy document (written by
    the full-generation path, so already a full build) is adopted once: its last_updated becomes
    the full-build time, its model is unknown, and the configured model at adoption is remembered
    in the attempt state so a later model change still forces a rebuild.
    """
    info = doc.info
    if info.get('semantic_policy'):
        return (_parse_time(info.get('full_build_at')), info.get('full_build_model') or UNKNOWN,
                info.get('configured_model'), None)
    adoption = (state or {}).get('adoption') or {}
    if adoption.get('doc_sha256') == doc.sha256:
        return _parse_time(adoption.get('full_built_at')), UNKNOWN, adoption.get('configured_model'), None
    built = _parse_time(info.get('last_updated'))
    adopt = {'doc_sha256': doc.sha256, 'full_built_at': built.isoformat() if built else None,
             'configured_model': model, 'policy': SEMANTIC_POLICY}
    return built, UNKNOWN, model, adopt


def _full_rebuild_origin(state):
    """Why a full rebuild was first chosen, which a retry's own reason doesn't say. An older record has
    only its latest reason: a specific one is the origin, the generic retry reason recovers nothing."""
    st = state or {}
    origin = st.get('full_rebuild_origin') or st.get('decision_reason')
    return None if origin == UNFINISHED_REASON else origin


def full_rebuild_unfinished(state, doc, full_rebuild_days=DEFAULT_INCREMENTAL_FULL_REBUILD_DAYS):
    """True when `state` is a full rebuild started from exactly `doc` that never published and is still
    owed. A state whose generation ID is the document's own reached its commit point and is not
    unfinished. One chosen only by a trigger that no longer applies (a removed size rule, or the weekly
    rule once it's turned off) isn't owed; an explicitly forced one still is, however many times it fails.
    A record whose origin can't be recovered owes nothing: the current rules decide, and a person can
    force a rebuild again, which is cheaper than buying one nobody asked for."""
    st = state or {}
    if doc is None or st.get('strategy') != 'full' or st.get('status') not in UNFINISHED:
        return False
    if st.get('generation_id') and st.get('generation_id') == doc.info.get('generation_id'):
        return False
    origin = _full_rebuild_origin(st)
    if origin is None or _REMOVED_TRIGGER.fullmatch(origin) or (origin == WEEKLY_REASON and not full_rebuild_days):
        return False
    return st.get('baseline_doc_sha256') == doc.sha256


def consecutive_failures(state, doc):
    """How many updates in a row have failed from exactly this document. The count has its own document
    identity, because a setup failure rewrites the attempt's baseline hash, even to nothing when the document
    can't be read, and that says nothing about the count. Only a different document starts it again from none;
    no document at all doesn't, since a missing file is no reason to buy another rebuild."""
    st = state or {}
    if doc is not None and st.get(FAILURE_STREAK_DOC) != doc.sha256:
        return 0
    count = st.get('consecutive_failures')
    return count if isinstance(count, int) and not isinstance(count, bool) and count > 0 else 0


def held_reason(state, doc, force=False, trigger='manual', threshold=HOLD_AFTER_FAILURES):
    """Why this sync may not spend on this repository, or None. After `threshold` failures in a row only a
    person starts another try: the menu's Sync Now, or a forced rebuild. Every other trigger is held, so nothing
    automatic can keep buying the same failure, even when a weekly rebuild is due. The count is compared with
    the threshold this sync loaded, so raising it can release a hold and lowering it can hold sooner."""
    failures = consecutive_failures(state, doc)
    if force or trigger == 'manual' or failures < threshold:
        return None
    return f"held after {failures} failed updates in a row; a manual sync or a forced rebuild retries"


def _dropped_full_attempt(state, doc, full_rebuild_days):
    """The record of a full rebuild that didn't finish and is no longer owed, kept as evidence when a
    new attempt replaces it. None when there isn't one."""
    st = state or {}
    if (doc is None or st.get('strategy') != 'full' or st.get('status') not in UNFINISHED
            or st.get('baseline_doc_sha256') != doc.sha256 or full_rebuild_unfinished(st, doc, full_rebuild_days)
            or (st.get('generation_id') and st.get('generation_id') == doc.info.get('generation_id'))):
        return None
    return {k: st.get(k) for k in ('status', 'reason', 'decision_reason', 'full_rebuild_origin', 'target_commit',
                                   'finished_at')}


def prepare_diff(repo_path, doc, base, target, spool_dir, deadline=None):
    """The pinned snapshots, changes, credential exclusions and spooled pages of an update from `doc`.
    The whole exclusion closure is worked out before any content is read, and every page and tool uses
    that one record."""
    inherited = document_exclusions(doc)
    base_snap = snap.GitSnapshot(repo_path, base)
    target_snap = snap.GitSnapshot(repo_path, target)
    changes = snap.changes_between(repo_path, base, target, deadline)
    exclusions = snap.credential_exclusions(inherited, base_snap.manifest(), target_snap.manifest(), changes)
    pages = snap.prepare_pages(repo_path, base, target, base_snap.manifest(), target_snap.manifest(), changes,
                               exclusions, spool_dir, deadline=deadline)
    return PreparedDiff(base_snap, target_snap, changes, exclusions, pages)


def decide(repo_path, full_name, doc, state, model, target, now, force=False,
           full_rebuild_days=DEFAULT_INCREMENTAL_FULL_REBUILD_DAYS, deadline=None, allow_incremental=True):
    """Choose 'full', 'incremental' or 'none' for a repository at commit `target`.

    Pure apart from read-only Git: no model calls, token counts or state writes, so dry runs can
    report it. Rules, in order: a forced or unusable baseline, a changed model or policy, an
    unknown full-build time or an unfinished full rebuild still owed means full; `full_rebuild_days`
    since the last full build means full (0 turns this off); an unchanged tree means nothing to do;
    anything else is incremental. How much changed picks the amount of work, never a full rebuild;
    the fraction changed is only a diagnostic. Listing the changes shares `deadline` with the rest of the
    attempt; running out raises snap.ResourceLimit rather than selecting anything.

    Without `allow_incremental` (a repository not opted in to incremental updates) the same baseline checks
    apply, there is no age-triggered rebuild, and a changed tree means full, with no diff listed.
    """
    deadline = deadline or snap.Deadline(ATTEMPT_SECONDS)
    if not allow_incremental:
        full_rebuild_days = 0

    def full(reason, change=None, built=None, adopt=None):
        return Decision('full', reason, None, target, built, None, change, adopt)

    if force:
        return full('regeneration requested')
    ok, why = usable_baseline(doc, full_name)
    if not ok:
        return full(why)
    base = doc.info['last_commit']
    if snap.resolve_commit(repo_path, base) != base:
        return full('analyzed commit is not available')
    if not snap.is_ancestor(repo_path, base, target):
        return full('analyzed commit is not an ancestor of the new commit')
    if doc.info.get('semantic_policy') not in (None, SEMANTIC_POLICY):
        return full('metadata policy changed')
    built, full_model, configured, adopt = _full_build(doc, state, model)
    if configured not in (None, model):
        return full('configured model changed', adopt=adopt)
    if built is None:
        return full('last full build time unknown', adopt=adopt)
    if full_rebuild_unfinished(state, doc, full_rebuild_days):
        return full(UNFINISHED_REASON, built=built, adopt=adopt)
    if full_rebuild_days and now - built >= timedelta(days=full_rebuild_days):
        return full(WEEKLY_REASON, built=built, adopt=adopt)

    base_snap, target_snap = snap.GitSnapshot(repo_path, base), snap.GitSnapshot(repo_path, target)
    if base_snap.tree_id() == target_snap.tree_id():
        return Decision('none', 'no tracked change since the analyzed commit', base, target, built,
                        full_model, None, adopt)
    if not allow_incremental:
        return full('the tracked tree changed', built=built, adopt=adopt)
    changes = snap.changes_between(repo_path, base, target, deadline)
    change = snap.change_fraction(base_snap.manifest(), target_snap.manifest(), changes)
    reason = f"{change.fraction:.1%} of the source changed" if change else 'the tracked tree changed'
    return Decision('incremental', reason, base, target, built, full_model, change, adopt)


def _analysis_of(doc):
    """The analysis part of a document body: everything after the Quick Reference block."""
    body = doc.body
    marker = '\n---\n'
    quick = body.find('## Quick Reference')
    if quick != -1:
        end = body.find(marker, quick)
        if end != -1:
            return body[end + len(marker):].lstrip('\n')
    heading = re.search(r'^# Repository:.*\n', body, re.M)
    return body[heading.end():] if heading else body


# ---- sections and edits ------------------------------------------------------------------------------

Section = namedtuple('Section', 'id text sha256')
_HEADING = re.compile(r'^#{1,6}\s')
_FENCE_OPEN = re.compile(r'^[ \t]*(`{3,}|~{3,})(.*)$')
_FENCE_CLOSE = re.compile(r'^[ \t]*(`{3,}|~{3,})[ \t]*$')


def _code_lines(lines):
    """For each line, whether it is part of fenced code; and whether a fence is left open. A fence
    closes only on a line of the same character, at least as long as the opening run, and nothing else
    (CommonMark), so a four-backtick block can show a three-backtick example."""
    flags, fence = [], None
    for line in lines:
        bare = line.rstrip('\r\n')
        if fence is None:
            m = _FENCE_OPEN.match(bare)
            if m and not (m.group(1)[0] == '`' and '`' in m.group(2)):
                fence = (m.group(1)[0], len(m.group(1)))
            flags.append(fence is not None)
        else:
            m = _FENCE_CLOSE.match(bare)
            if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= fence[1]:
                fence = None
            flags.append(True)
    return flags, fence is not None
QUICK_REF_FIELDS = ('type', 'language', 'framework', 'database', 'apis', 'port', 'dependencies')


class PatchError(Exception):
    """The model's edits are malformed or ambiguous; nothing is published and nothing is retried."""


def split_sections(analysis):
    """Split the analysis at Markdown headings outside fenced code. Joining the texts gives back the
    analysis exactly. Text before the first heading is its own section."""
    starts = []
    lines = analysis.splitlines(keepends=True)
    code, _open = _code_lines(lines)
    for i, line in enumerate(lines):
        if not code[i] and _HEADING.match(line):
            starts.append(i)
    if not starts or starts[0] != 0:
        starts.insert(0, 0)
    sections = []
    for n, start in enumerate(starts):
        end = starts[n + 1] if n + 1 < len(starts) else len(lines)
        text = ''.join(lines[start:end])
        if text:
            sections.append(Section(f"s{len(sections) + 1}", text, hashlib.sha256(text.encode('utf-8')).hexdigest()[:16]))
    return sections


def current_fields(doc):
    info = doc.info
    quick = {k: info[k] for k in ('type', 'language', 'framework', 'database', 'apis', 'port') if k in info}
    from repo_radar.metadata import quick_reference_from_table
    table = quick_reference_from_table(doc.body)
    if 'dependencies' in table:
        quick['dependencies'] = table['dependencies']
    try:
        related = json.loads(info.get('related_repos') or '[]')
    except ValueError:
        related = []
    return {'brief': info.get('brief', ''), 'quick_reference': quick,
            'related_repos': [str(r) for r in related] if isinstance(related, list) else []}


def _one_line(value, name, max_len):
    if not isinstance(value, str) or not value.strip() or '\n' in value or '\r' in value or len(value) > max_len:
        raise PatchError(f"{name} must be a single non-empty line of at most {max_len} characters")
    return value.strip()


def apply_patch(sections, fields, patch, base_sha):
    """Apply the model's section edits. Returns (analysis, fields, coverage_note).

    Every edit names a section by id and the hash it was given; a section is the target of at most
    one replace or delete; inserts go after a named section or at the start. Untouched sections keep
    their exact bytes. The app, not the model, owns identity, commits, timestamps and provenance.
    """
    if not isinstance(patch, dict):
        raise PatchError("the answer is not a JSON object")
    unknown = set(patch) - {'base_document_sha256', 'sections', 'fields', 'coverage_note'}
    if unknown:
        raise PatchError(f"unexpected keys {sorted(unknown)}")
    if patch.get('base_document_sha256') != base_sha:
        raise PatchError("base_document_sha256 does not match the document that was given")
    ops = patch.get('sections', [])
    if not isinstance(ops, list):
        raise PatchError("sections must be a list")
    by_id = {s.id: s for s in sections}
    replaced, deleted, targets = {}, set(), set()
    inserts = {}
    for op in ops:
        if not isinstance(op, dict) or op.get('op') not in ('replace', 'delete', 'insert'):
            raise PatchError("each section edit needs op replace, delete or insert")
        kind = op['op']
        allowed = {'replace': {'op', 'id', 'expected_sha256', 'content'}, 'delete': {'op', 'id', 'expected_sha256'},
                   'insert': {'op', 'after', 'content'}}[kind]
        if set(op) - allowed:
            raise PatchError(f"{kind} has unexpected keys {sorted(set(op) - allowed)}")
        if kind in ('replace', 'delete'):
            section = by_id.get(op.get('id'))
            if section is None:
                raise PatchError(f"no section {op.get('id')!r}")
            if op.get('expected_sha256') != section.sha256:
                raise PatchError(f"{section.id}: expected_sha256 does not match the section")
            if section.id in targets:
                raise PatchError(f"{section.id} is edited more than once")
            targets.add(section.id)
            if kind == 'delete':
                deleted.add(section.id)
                continue
        anchor = op.get('after') if kind == 'insert' else None
        if kind == 'insert' and anchor != 'start' and anchor not in by_id:
            raise PatchError(f"insert after unknown section {anchor!r}")
        content = op.get('content')
        if not isinstance(content, str) or not content.strip():
            raise PatchError(f"{kind} needs non-empty content")
        if _code_lines(content.splitlines(keepends=True))[1]:
            raise PatchError(f"{kind} content leaves a code fence open")
        if kind == 'insert' and not _HEADING.match(content):
            raise PatchError("inserted content must start with a Markdown heading")
        if kind == 'replace' and _HEADING.match(by_id[op['id']].text) and not _HEADING.match(content):
            raise PatchError(f"{op['id']}: replacement must keep a heading")
        content = content if content.endswith('\n') else content + '\n'
        if kind == 'replace':
            replaced[op['id']] = content
        else:
            inserts.setdefault(anchor, []).append(content)

    # (text, written by the model). Only model-written text gets a blank line added before what follows.
    parts = [(t, True) for t in inserts.get('start', [])]
    for section in sections:
        if section.id in replaced:
            parts.append((replaced[section.id], True))
        elif section.id not in deleted:
            parts.append((section.text, False))
        parts.extend((t, True) for t in inserts.get(section.id, []))
    analysis = ''.join(t + '\n' if new and i < len(parts) - 1 and not t.endswith('\n\n') else t
                       for i, (t, new) in enumerate(parts))

    new_fields = json.loads(json.dumps(fields))
    changes = patch.get('fields', {}) or {}
    if not isinstance(changes, dict) or set(changes) - {'brief', 'quick_reference', 'related_repos'}:
        raise PatchError("fields may only change brief, quick_reference and related_repos")
    if 'brief' in changes:
        new_fields['brief'] = _one_line(changes['brief'], 'brief', 400)
    if 'quick_reference' in changes:
        quick = changes['quick_reference']
        if not isinstance(quick, dict) or set(quick) - set(QUICK_REF_FIELDS):
            raise PatchError(f"quick_reference may only contain {', '.join(QUICK_REF_FIELDS)}")
        for key, value in quick.items():
            new_fields['quick_reference'][key] = _one_line(value, f"quick_reference.{key}", 300)
    if 'related_repos' in changes:
        related = changes['related_repos']
        if not isinstance(related, list) or len(related) > 30:
            raise PatchError("related_repos must be a list of at most 30 names")
        new_fields['related_repos'] = [_one_line(r, 'related_repos entry', 100) for r in related]
    note = patch.get('coverage_note')
    if note is not None and not isinstance(note, str):
        raise PatchError("coverage_note must be a string")
    return analysis, new_fields, (' '.join(note.split())[:300] if note else None)


def parse_answer(text):
    """The JSON value in a final reply. A reply that isn't JSON as a whole may still hold exactly one
    complete JSON object, in a code fence or among a few words of prose; that object is the answer. None,
    or two or more, and the reply is refused. What comes back is validated exactly as before."""
    stripped = (text or '').strip()
    try:
        return json.loads(stripped)
    except ValueError:
        pass
    decoder, found, index = json.JSONDecoder(), [], stripped.find('{')
    while index != -1:
        try:
            value, end = decoder.raw_decode(stripped, index)
        except ValueError:
            index = stripped.find('{', index + 1)
            continue
        if isinstance(value, dict):
            found.append(value)
        index = stripped.find('{', end)
    if len(found) != 1:
        raise PatchError("the answer is not a JSON object" if not found else
                         f"the answer holds {len(found)} JSON objects, not one")
    return found[0]


# ---- talking to the model ----------------------------------------------------------------------------

ATTEMPT_SECONDS = 20 * 60   # one incremental update, from preparing its pages to draining its last call
REQUEST_SECONDS = 10 * 60   # one full-build request; a full build has no attempt deadline

# omitted: (path, reason) for files withheld by the safety policy (credential, binary, symlink...);
# outside_selection: for full builds, how many tracked files the collector's rules leave out;
# exclusions: the effective credential exclusions every content read used, published with the document.
Candidate = namedtuple('Candidate', 'analysis fields coverage_note omitted outside_selection exclusions',
                       defaults=(None, None))


class StaleUpdate(Exception):
    """The attempt stopped; the previous document stays. `warning` marks causes that are not errors
    (an unavailable count or price, a spending limit, newer work superseding this one)."""

    def __init__(self, reason, warning=False):
        super().__init__(reason)
        self.reason, self.warning = reason, warning


def run_incremental(repo_path, full_name, doc, decision, model, session, budget, clock=None, log=None,
                    spool_dir=None, evidence_dir=None, case=None, deadline=None):
    """Update `doc` from its analyzed commit to decision.target: map each diff page, merge the notes, edit
    once. Pages spool to an owner-only directory that is removed afterwards, unless the caller names
    `spool_dir` to keep it as evidence. A resource limit stops the update; it never becomes a full build. It
    is a skip only while nothing has been paid for; after a paid call it is a failure.
    `deadline` is the attempt's, set before selection; only a direct caller without one starts a new one."""
    import shutil
    import time
    from repo_radar import summary_pipeline as mr

    deadline = deadline or snap.Deadline(ATTEMPT_SECONDS, clock or time.monotonic)
    spool = spool_dir or tempfile.mkdtemp(prefix='repo-radar-pages-')
    try:
        os.makedirs(spool, mode=0o700, exist_ok=True)
        os.chmod(spool, 0o700)
        prepared = prepare_diff(repo_path, doc, decision.base, decision.target, spool, deadline)
        if decision.change is not None:
            budget.extra.update(changed_files=decision.change.changed_files, changed_bytes=decision.change.changed_bytes)
        return mr.Pipeline(full_name, doc, prepared, model, session, budget, deadline.at, deadline.clock, log, case,
                           evidence_dir).run()
    except snap.ResourceLimit as e:
        raise StaleUpdate(str(e), warning=mr.unpaid(budget)) from None
    except snap.GitError as e:
        raise StaleUpdate(str(e)) from None
    finally:
        if spool_dir is None:
            shutil.rmtree(spool, ignore_errors=True)


def document_commit(repo_path, doc):
    """The previous document's analyzed commit when it is present in the repository, else None (a
    first build, or a commit that's gone). Not decision.base, which full decisions leave unset."""
    commit = (doc.info.get('last_commit') or '') if doc else ''
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
        return None
    return commit if snap.resolve_commit(repo_path, commit) == commit else None


def pinned_files(snapshot, exclusions):
    """The full collector's input, read from a pinned commit instead of the working tree: tracked
    regular files the collector includes, at most 100 KiB each, decoded the way it decodes them.

    The same safety policy as the read tools applies first: credential files, anything `exclusions`
    protects, and binary blobs are withheld even when the collector's rules would include them.
    Returns (files, omitted, outside_selection): omitted lists (path, reason) for withheld files, and
    outside_selection counts tracked files the collector's extension and size rules leave out.
    """
    files, omitted, outside = [], [], 0
    for path, entry in sorted(snapshot.manifest().items()):
        if not snap.collector_eligible(entry):
            outside += 1
            continue
        reason = snap.omission_reason(entry, exclusions)
        if reason is None:
            data = snapshot.read_blob(entry, snap.COLLECTOR_MAX_BYTES + 1)
            if snap.is_binary(data):
                reason = 'binary file'
        if reason is not None:
            omitted.append((path, reason))
            continue
        content = data.decode('utf-8', errors='ignore')
        files.append({'path': path, 'size': len(content), 'content': content})
    return files, omitted, outside


def run_full(repo_path, full_name, target, model, session, budget, baseline=None, *, inherited,
             estimate_allowance=False):
    """A complete document built from the pinned commit by the shared summary pipeline's full adapter
    (summary_pipeline.FullBuild), with the existing full-generation prompts and output format. Never written
    directly: the caller publishes it. `inherited` is the previous document's credential exclusions
    (document_exclusions) and `baseline` its commit when that is still available; a rebuild adds to that
    protection and never resets it. A Git failure reading the protection raises rather than dropping it.

    On Gemini, thinking and the visible answer share the output limit, so every call asks for low thinking
    in the counted request, leaving more room to answer; that makes truncation less likely, not impossible.
    A truncated reply is still rejected, with nothing retried. budget.extra['full_stage'] says which call was
    last attempted and how it ended: set before each send, finished after its settlement.

    The build's first stage is prepared (counted and fitted, nothing sent) before the attempt is admitted
    against the weekly cap, and that same plan is what's sent. An opted-in repository's rebuild is admitted for
    the whole full cap; with `estimate_allowance` (a full-only repository) it is admitted for the plan's own
    estimate (FullBuild.allowance), which is also its hard limit."""
    from repo_radar import summary_pipeline
    from repo_radar.metadata import parse_llm_response, degradation_reasons

    target_snap = snap.GitSnapshot(repo_path, target)
    base_manifest, changes = None, ()
    if baseline:
        base_manifest = snap.GitSnapshot(repo_path, baseline).manifest()
        changes = snap.changes_between(repo_path, baseline, target)
    exclusions = snap.credential_exclusions(inherited, base_manifest, target_snap.manifest(), changes)
    files, omitted, outside = pinned_files(target_snap, exclusions)
    if not files:
        raise StaleUpdate("no analyzable source")
    budget.extra['pipeline_version'] = PIPELINE_VERSION
    from repo_radar.metadata_budget import FULL_CAP_USD
    build = summary_pipeline.FullBuild(full_name, files, model, session, budget)
    plan = build.prepare()
    allowance = build.allowance(plan) if estimate_allowance else FULL_CAP_USD
    budget.extra['admitted_usd'] = allowance
    budget.acquire(allowance)   # ready to send: admitted against the weekly cap before the first call
    text = build.run(plan)
    parsed = parse_llm_response(text)
    problems = degradation_reasons(parsed)
    if problems or not parsed['analysis'].strip():
        raise StaleUpdate(f"the generated metadata is degraded: {'; '.join(problems) or 'no analysis'}")
    quick = {k: v for k, v in parsed['quick_ref'].items() if k in QUICK_REF_FIELDS}
    fields = {'brief': parsed['brief'], 'quick_reference': quick, 'related_repos': parsed['related_repos']}
    return Candidate(parsed['analysis'], fields, None, omitted, outside, exclusions)


# ---- one opted-in repository -------------------------------------------------------------------------

# state_error: None, or why the attempt record couldn't be saved (INDEX can't show what wasn't recorded).
Outcome = namedtuple('Outcome', 'status strategy reason base target usage elapsed state_error', defaults=(None,))


def coverage_line(strategy, omitted, coverage_note=None, outside_selection=None):
    """What a generation examined, scoped honestly: an incremental update examined the required diff,
    a full build analyzed the collector-selected source. Neither claims exhaustive coverage."""
    parts = ['required diff examined' if strategy == 'incremental' else 'collector-selected source analyzed']
    if omitted:
        parts.append(f"{len(omitted)} {'changed paths' if strategy == 'incremental' else 'files'} withheld "
                     f"({', '.join(sorted({why for _p, why in omitted}))})")
    if outside_selection:
        parts.append(f"{outside_selection} tracked files outside the collector's selection")
    if coverage_note:
        parts.append('limits noted')
    return '; '.join(parts)


def _provenance(strategy, model, decision, doc, target, now, coverage_note, omitted, outside_selection=None,
                exclusions=None):
    if exclusions is None:   # every publication carries its protection forward
        raise StaleUpdate('the candidate carries no credential exclusions')
    if strategy == 'full':
        full = {'full_build_commit': target, 'full_build_at': now.isoformat(), 'full_build_model': model}
    elif doc.info.get('semantic_policy'):
        full = {k: doc.info.get(k, UNKNOWN) for k in ('full_build_commit', 'full_build_at', 'full_build_model')}
    else:  # adopted legacy document: its own commit and time, model unknown
        full = {'full_build_commit': doc.info['last_commit'],
                'full_build_at': decision.full_built_at.isoformat(), 'full_build_model': UNKNOWN}
    coverage = coverage_line(strategy, omitted, coverage_note, outside_selection)
    record = {'generation_strategy': strategy, 'generation_model': model, 'configured_model': model,
              'semantic_policy': SEMANTIC_POLICY, 'base_commit': decision.base or 'none', **full,
              'coverage': coverage, EXCLUSIONS_KEY: snap.encode_exclusions(exclusions)}
    record['pipeline_version'] = PIPELINE_VERSION
    if coverage_note:
        record['coverage_note'] = coverage_note
    return record


def _link(pristine_dir, full_name, cache_name):
    """The stable <repo>.md symlink, as the full generator maintains it."""
    link = Path(pristine_dir) / f"{full_name.split('/')[-1]}.md"
    try:
        if link.exists() or link.is_symlink():
            link.unlink()
        link.symlink_to(f"{cache_name}.md")
    except OSError:
        pass


MAX_REASON = 240


def safe_reason(reason):
    """A failure reason as one printable line of at most 240 characters, safe for attempt state,
    Activity and the progress row (model-chosen ids and provider messages can be anything)."""
    if reason is None:
        return None
    text = ' '.join(''.join(ch if ch.isprintable() else ' ' for ch in str(reason)).split())
    return text if len(text) <= MAX_REASON else text[:MAX_REASON - 1] + '…'


def _try_write_state(pristine_dir, cache_name, state):
    """Write attempt state, returning None or a short description of why it couldn't be saved."""
    try:
        write_state(pristine_dir, cache_name, state)
        return None
    except Exception as e:
        return safe_reason(f"attempt state not saved ({type(e).__name__}: {e})")


def record_failure(pristine_dir, cache_name, full_name, reason, target=None, phase='setup', status='failed'):
    """Best-effort record of an opted-in attempt that failed before or outside the guarded update (a
    Git step, setup, an escaped worker error), so INDEX can show the document stale or unavailable.
    Never raises; returns None or why the record couldn't be saved. An unfinished full rebuild stays
    recorded as one, so it stays due."""
    import uuid
    try:
        doc = load_document(pristine_dir, cache_name)
    except Exception:
        doc = None
    try:
        state = read_attempt_state(pristine_dir, cache_name) or {}
    except Exception:
        state = {}
    full_due = full_rebuild_unfinished(state, doc)
    record = {**state, 'schema': 'repo-radar-metadata-attempt/1', 'full_name': full_name,
              'attempt_id': uuid.uuid4().hex, 'status': status, 'strategy': 'full' if full_due else None,
              'phase': phase, 'base_commit': doc.info.get('last_commit') if doc else None,
              'target_commit': target, 'baseline_doc_sha256': doc.sha256 if doc else None,
              'reason': safe_reason(reason), 'finished_at': datetime.now().isoformat(),
              'generation_id': None}   # a generation ID belongs only to a candidate that reached the commit point
    record.pop('usage', None)
    return _try_write_state(pristine_dir, cache_name, record)


def _cleared_setup_failure(state, now):
    """A verified no-op clears a failure recorded before any decision; it never clears an unfinished
    full rebuild or incremental attempt."""
    if state.get('status') in UNFINISHED and state.get('strategy') is None:
        return {**state, 'status': 'verified', 'reason': None, 'finished_at': now.isoformat()}
    return state


def update_repository(pristine_dir, repo_path, cache_name, repo_config, model, session, force=False,
                      now=None, run_incremental_fn=None, run_full_fn=None, log=lambda *a, **k: None,
                      missing_credential=None, full_rebuild_days=DEFAULT_INCREMENTAL_FULL_REBUILD_DAYS, clock=None,
                      trigger='manual', update_limit_usd=None, failure_stop=None, spending=None,
                      allow_incremental=True):
    """Decide and, when needed, update one repository's metadata. Never raises an Exception:
    every failure, from reading the baseline to the last state write, keeps the previous document,
    is recorded when storage allows, and comes back as a failed or skipped Outcome. Outcome.state_error
    says when the attempt record couldn't be saved. `missing_credential` names the provider key
    variable when it isn't set; that fails a due update before any count or send. `trigger` is who started
    this sync, which decides whether a repository held after repeated failures may try again (held_reason).
    `update_limit_usd` caps one incremental update and `failure_stop` is the hold threshold, both from Settings;
    a missing or invalid value means the default ($12 and 2), never no limit. `spending` is a normal sync's
    production spending context (repo_radar.spending.Spending): the attempt's whole allowance is admitted
    against the weekly cap before its first send and closed when it ends. Without it, nothing is recorded.

    `allow_incremental` is whether the repository is opted in to incremental updates. Without it the update is
    full-only: no weekly rebuild, a changed tree is rebuilt in full, and the rebuild is admitted for its own
    estimate (FullBuild.allowance) rather than the whole full cap."""
    import time
    import uuid
    from repo_radar.metadata import write_text_atomic, render_metadata_document
    from repo_radar.config import valid_incremental_failure_stop, valid_incremental_update_limit
    from repo_radar.metadata_budget import Budget, FULL_CAP_USD, INCREMENTAL_CAP_USD
    from repo_radar.llm import InputBudgetUnavailable, IncompleteResponseError
    from repo_radar.preflight import TokenCountRejected
    from repo_radar.spending import SpendingError, SpendingStopped, WeeklyCapRefused

    started = time.monotonic()
    deadline = snap.Deadline(ATTEMPT_SECONDS, clock or time.monotonic)   # selection, preparation and sends share it
    now = now or datetime.now()
    full_name = repo_config['full_name']
    decision = budget = attempt = target = None
    committed = False
    update_limit = float(update_limit_usd) if valid_incremental_update_limit(update_limit_usd) else INCREMENTAL_CAP_USD
    failure_stop = int(failure_stop) if valid_incremental_failure_stop(failure_stop) else HOLD_AFTER_FAILURES
    if not allow_incremental:
        full_rebuild_days = 0   # an implementation move gives these repositories no new rebuild schedule

    def finish(status, reason, counts=True):
        """`counts=False` is for a known setup failure before anything is sent: it is reported as failed, but
        the streak keeps its count, its last counted failure and any full-rebuild debt."""
        reason = safe_reason(reason)
        after = None
        closing = budget.close_spending() if budget else None   # known charges stay; the unused rest is released
        if committed and status != 'published':
            # The new document is in place: report what failed afterwards, never the old one as kept.
            after, status, reason = reason, 'published', None
        usage = budget.summary() if budget else {}
        if attempt is not None and status == 'published':   # discharged
            attempt.pop('dropped_full_attempt', None)
            attempt.pop('full_rebuild_origin', None)
            attempt.pop('last_failure_reason', None)
            attempt.pop(FAILURE_STREAK_DOC, None)
            attempt['consecutive_failures'] = 0
        elif attempt is not None and status == 'failed' and counts:
            attempt['consecutive_failures'] += 1
            attempt['last_failure_reason'] = reason
        if attempt is None:
            state_error = record_failure(pristine_dir, cache_name, full_name, reason, target, 'setup', status)
        else:
            attempt.update(status=status, reason=reason, finished_at=datetime.now().isoformat(), usage=usage)
            state_error = _try_write_state(pristine_dir, cache_name, attempt)
        if after:
            state_error = safe_reason(f"after publishing: {after}" + (f"; {state_error}" if state_error else ''))
        if closing:
            state_error = safe_reason(closing + (f"; {state_error}" if state_error else ''))
        return Outcome(status, decision.strategy if decision else None, reason, decision.base if decision else None,
                       target, usage, time.monotonic() - started, state_error)

    try:
        doc = read_document(pristine_dir, cache_name)
        inherited = document_exclusions(doc)   # before any decision, so a forced rebuild can't skip it
        state = read_attempt_state(pristine_dir, cache_name) or {}
        target = snap.resolve_commit(repo_path, 'HEAD')
        if target is None:
            return finish('failed', 'the repository has no commit')
        decision = decide(repo_path, full_name, doc, state, model, target, now, force=force,
                          full_rebuild_days=full_rebuild_days, deadline=deadline, allow_incremental=allow_incremental)
        if decision.adopt:
            state = {**state, 'adoption': decision.adopt}
        if decision.strategy == 'none':
            cleared = _cleared_setup_failure(state, now)
            if decision.adopt or cleared is not state:
                write_state(pristine_dir, cache_name, cleared)
            return Outcome('none', 'none', decision.reason, decision.base, target, {}, time.monotonic() - started)

        held = held_reason(state, doc, force, trigger, failure_stop)
        if held:
            # Nothing is attempted. The last failure's reason, usage and any full-rebuild debt stay on record.
            state_error = _try_write_state(pristine_dir, cache_name,
                                           {**state, 'status': 'skipped', 'reason': held, 'target_commit': target,
                                            'finished_at': datetime.now().isoformat()})
            return Outcome('skipped', decision.strategy, held, decision.base, target, {}, time.monotonic() - started,
                           state_error)

        attempt = {**state, 'schema': 'repo-radar-metadata-attempt/1', 'full_name': full_name,
                   'attempt_id': uuid.uuid4().hex, 'status': 'pending', 'strategy': decision.strategy,
                   'phase': 'update', 'decision_reason': decision.reason, 'base_commit': decision.base,
                   'target_commit': target, 'baseline_doc_sha256': doc.sha256 if doc else None,
                   'policy': SEMANTIC_POLICY, 'model': model, 'started_at': now.isoformat(), 'reason': None,
                   'generation_id': None, 'consecutive_failures': consecutive_failures(state, doc),
                   # A missing document keeps the streak's identity as it keeps the count, so a retry while
                   # the file is away can't release the hold on it when it comes back.
                   FAILURE_STREAK_DOC: doc.sha256 if doc else state.get(FAILURE_STREAK_DOC)}
        dropped = _dropped_full_attempt(state, doc, full_rebuild_days)
        if dropped:   # its failure stays on record while the new path runs
            attempt['dropped_full_attempt'] = dropped
        attempt['pipeline_version'] = PIPELINE_VERSION
        if decision.strategy == 'incremental':
            attempt.pop('full_rebuild_origin', None)
        else:   # a retry carries the first reason forward; decision_reason stays the latest, for display
            attempt['full_rebuild_origin'] = (_full_rebuild_origin(state) if decision.reason == UNFINISHED_REASON
                                              else decision.reason)
        for stale in ('finished_at', 'usage'):
            attempt.pop(stale, None)
        write_state(pristine_dir, cache_name, attempt)  # before any model work, so a crash stays visible
        log(f"{decision.strategy}: {decision.reason}")

        cap = update_limit if decision.strategy == 'incremental' else FULL_CAP_USD
        budget = Budget(model, cap=cap, label=decision.strategy, spending=spending, owner=full_name)
        if missing_credential:   # setup, not a bought failure: it doesn't move the streak toward a hold
            return finish('failed', f"no API key: {missing_credential} is not set", counts=False)

        if decision.strategy == 'incremental':
            candidate = (run_incremental_fn or run_incremental)(repo_path, full_name, doc, decision, model, session,
                                                                budget, log=log, deadline=deadline)
        else:
            candidate = (run_full_fn or run_full)(repo_path, full_name, target, model, session, budget,
                                                  baseline=document_commit(repo_path, doc), inherited=inherited,
                                                  estimate_allowance=not allow_incremental)
        # Publish only what was built from exactly this document and this commit.
        current = load_document(pristine_dir, cache_name)
        if (current.sha256 if current else None) != attempt['baseline_doc_sha256']:
            raise StaleUpdate('superseded: the document changed during the update', warning=True)
        if snap.resolve_commit(repo_path, 'HEAD') != target:
            raise StaleUpdate('superseded: the repository moved during the update', warning=True)
        fields = candidate.fields
        provenance = _provenance(decision.strategy, model, decision, doc, target, now,
                                 candidate.coverage_note, candidate.omitted, candidate.outside_selection,
                                 candidate.exclusions)
        generation_id = uuid.uuid4().hex
        from repo_radar.metadata import UnsafeHeader, degradation_reasons
        try:
            # Renders and reads the header back: identity, revisions, provenance and parse status.
            text = render_metadata_document(
                full_name, cache_name, repo_config['clone_url'], target, datetime.now().isoformat(),
                fields['quick_reference'], fields['brief'], fields['related_repos'], candidate.analysis,
                {'generation_id': generation_id, **provenance})
        except UnsafeHeader as e:
            raise StaleUpdate(f"the updated document's header is unsafe: {e}") from None
        check = {'quick_ref': fields['quick_reference'], 'brief': fields['brief'],
                 'related_repos': fields['related_repos'], 'analysis': candidate.analysis}
        if degradation_reasons(check) or not candidate.analysis.strip():
            raise StaleUpdate('the updated document failed its health checks')
        attempt.update(status='committing', generation_id=generation_id)
        write_state(pristine_dir, cache_name, attempt)
        write_text_atomic(document_path(pristine_dir, cache_name), text)   # the commit point
        committed = True
        _link(pristine_dir, full_name, cache_name)
        return finish('published', None)
    except StaleUpdate as e:
        return finish('skipped' if e.warning else 'failed', e.reason)
    except SpendingStopped:
        # Stop arrived between sends: an interruption like any other Stop, not a failure that moves the streak.
        return finish('skipped', 'the sync was stopped')
    except WeeklyCapRefused as e:
        # Only admission refuses, before any send: the previous document, failure count, last counted failure
        # and any full-rebuild obligation all stay. No retry, fallback or other strategy follows.
        return finish('skipped', str(e))
    except SpendingError as e:   # an accounting problem, never a refusal; before any send it isn't a bought failure
        return finish('failed', f"spending record: {e}", counts=bool(budget and budget.calls))
    except snap.ResourceLimit as e:   # from selection or a full build's discovery: no fallback, no partial list
        return finish('skipped', str(e))
    except InputBudgetUnavailable as e:
        return finish('skipped', f"token count unavailable: {e}")
    except TokenCountRejected as e:
        return finish('failed', str(e))
    except IncompleteResponseError as e:
        return finish('failed', str(e))
    except snap.GitError as e:
        return finish('failed', f"git: {e}")
    except Exception as e:  # a provider, transport or storage error; its type and a bounded message
        return finish('failed', f"{type(e).__name__}: {e}")
    finally:   # an interrupt that skipped finish still closes the allowance (closing twice changes nothing)
        if budget is not None:
            budget.close_spending()
