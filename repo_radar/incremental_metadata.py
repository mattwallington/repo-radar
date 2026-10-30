"""Incremental metadata for opted-in repositories (config `incremental_metadata_repos`).

Each document records the commit it was built from. A later sync updates it from that commit:
the model gets the previous analysis, the diff and read-only tools over the two pinned commits,
and returns section edits that the app validates and applies. A full rebuild still happens
weekly, after a large change, when the model or policy changes, or when the baseline cannot be
used. Every other repository keeps the existing full-generation path unchanged.

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

from repo_radar.metadata import (STATE_DIR_NAME, PARSE_STATUS_OK, parse_frontmatter, read_attempt_state,
                                 _parse_status_of)
from repo_radar import metadata_snapshot as snap

# Bump when what a document means changes (prompt contract, edit protocol, collector rules), so
# every opted-in document is rebuilt once under the new policy.
SEMANTIC_POLICY = 'repo-radar-metadata/1'
FULL_REBUILD_AFTER = timedelta(days=7)
CHANGE_THRESHOLD = 0.20            # strictly more than this fraction changed -> full rebuild
UNKNOWN = 'unknown'

Document = namedtuple('Document', 'path text sha256 info body')
Decision = namedtuple('Decision', 'strategy reason base target full_built_at full_model change adopt')


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
    if not snap.SHA.match(doc.info.get('last_commit', '')):
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


def decide(repo_path, full_name, doc, state, model, target, now, force=False):
    """Choose 'full', 'incremental' or 'none' for an opted-in repository at commit `target`.

    Pure apart from read-only Git: no model calls, token counts or state writes, so dry runs can
    report it. Rules, in order: a forced or unusable baseline, a changed model or policy, an
    unknown full-build time or an unfinished full rebuild means full; seven days since the last
    full build means full; more than 20% of the eligible source changed means full; an unchanged
    tree means nothing to do; anything else is incremental.
    """
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
    st = state or {}
    if (st.get('strategy') == 'full' and st.get('status') in ('pending', 'failed')
            and st.get('baseline_doc_sha256') == doc.sha256):
        return full('previous full rebuild did not finish', built=built, adopt=adopt)
    if now - built >= FULL_REBUILD_AFTER:
        return full('weekly full rebuild due', built=built, adopt=adopt)

    base_snap, target_snap = snap.GitSnapshot(repo_path, base), snap.GitSnapshot(repo_path, target)
    if base_snap.tree_id() == target_snap.tree_id():
        return Decision('none', 'no tracked change since the analyzed commit', base, target, built,
                        full_model, None, adopt)
    changes = snap.changes_between(repo_path, base, target)
    change = snap.change_fraction(base_snap.manifest(), target_snap.manifest(), changes)
    if change is None:
        return full('no analyzable source', built=built, adopt=adopt)
    if change.fraction > CHANGE_THRESHOLD:
        return full(f"{change.fraction:.0%} of the source changed", change, built, adopt)
    return Decision('incremental', f"{change.fraction:.1%} of the source changed", base, target, built,
                    full_model, change, adopt)


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
