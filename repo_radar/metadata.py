"""Metadata parsing, response extraction, and index generation."""

import hashlib
import json
import os
import re
import tempfile
from datetime import datetime
from pathlib import Path

from repo_radar.config import PRISTINE_DIR, INDEX_FILE, load_cache_index
from repo_radar.constants import CYAN, GREEN, YELLOW, RESET


def extract_between(text, start_marker, end_marker):
    """Extract text between two markers."""
    start_idx = text.find(start_marker)
    if start_idx == -1:
        return ""

    start_idx += len(start_marker)
    end_idx = text.find(end_marker, start_idx)

    if end_idx == -1:
        return ""

    return text[start_idx:end_idx].strip()


# Structural fragments that leaked through the delimiter parser. Deliberately narrow: matching a
# bare '"' would flag any summary that legitimately opens with a quotation mark. Every real case
# observed begins with an orphaned key/value separator, so require the separator to be present.
_FRAGMENT_PATTERN = re.compile(r'^\s*(?:["\']\s*:|:\s*["\']|[{\[]|,)')


def _looks_like_fragment(text):
    return bool(_FRAGMENT_PATTERN.match(text))

# Written into metadata frontmatter so consumers can filter without re-deriving this.
PARSE_STATUS_OK = 'ok'
PARSE_STATUS_DEGRADED = 'degraded'


def degradation_reasons(parsed):
    """Return human-readable reasons a parse looks degraded; empty list means healthy.

    Reasons rather than a bare bool on purpose: an empty QUICK_REFERENCE block and a JSON
    response that leaked through the delimiter parser both surface as `type: Unknown`, but
    they need different fixes. Collapsing them to one boolean is what made the two look like
    a single bug in the first place.
    """
    reasons = []
    brief = (parsed.get('brief') or '').strip()
    quick_ref = parsed.get('quick_ref') or {}

    if not brief:
        reasons.append('summary is empty')
    elif brief == 'Repository analysis':
        reasons.append('summary missing (fell back to the placeholder)')
    elif _looks_like_fragment(brief):
        reasons.append('summary looks like a structural fragment, not prose')

    # An empty block means the parser extracted nothing at all — a parse failure. A block that
    # parsed but reported "Unknown" for a field is a model that genuinely could not tell, which
    # is incomplete metadata rather than broken metadata; only the former is a defect to chase.
    if not quick_ref:
        reasons.append('quick reference empty (no "key: value" lines parsed)')
    elif any(k.strip('"\' ') != k or '{' in k or '}' in k for k in quick_ref):
        # Keys like '"type"' mean JSON was split on ':' as if it were the delimiter format,
        # so the values never reached the fields they were meant to populate.
        reasons.append('quick reference keys look structural, not plain field names')

    for entry in parsed.get('related_repos') or []:
        # Splitting a JSON array on commas yields quote-only shards like '"' or '\\": \\"None\\"'.
        if not str(entry).strip(' "\\\''):
            reasons.append('related_repos contains empty or quote-only entries')
            break

    return reasons


def looks_degraded(parsed):
    """True when a parse produced junk that must not be cached as if it were truth."""
    return bool(degradation_reasons(parsed))


def _parse_json_response(response_text):
    """Recover a metadata dict from a JSON response, or None if there isn't a usable one.

    Only ever used as a fallback after the documented delimiter format has already failed,
    so a stray ``{…}`` inside an otherwise-good analysis body can never hijack a healthy parse.
    """
    match = (re.search(r'```(?:json)?\s*(\{.*?\})\s*```', response_text, re.S)
             or re.search(r'(\{.*\})', response_text, re.S))
    if not match:
        return None
    try:
        data = json.loads(match.group(1))
    except (ValueError, TypeError):
        return None
    if not isinstance(data, dict):
        return None

    # Accept either the nested shape the prompt implies or a flat one-object answer.
    raw_ref = data.get('quick_reference')
    if not isinstance(raw_ref, dict):
        raw_ref = {k: v for k, v in data.items()
                   if k.lower() in ('type', 'language', 'framework', 'database', 'apis', 'port')}
    quick_ref = {str(k).strip().lower(): str(v).strip()
                 for k, v in raw_ref.items() if v is not None}

    brief = data.get('one_line_summary') or data.get('summary') or data.get('brief') or ''
    related = data.get('related_repos') or []
    if isinstance(related, str):
        related = [r.strip() for r in related.split(',') if r.strip()]

    if not quick_ref and not str(brief).strip():
        return None  # nothing recognizable — let the delimiter result stand

    return {
        'quick_ref': quick_ref,
        'brief': str(brief).strip() or 'Repository analysis',
        'related_repos': [str(r).strip() for r in related if str(r).strip()],
        'analysis': data.get('analysis') or response_text,
    }


def parse_llm_response(response_text):
    """Parse a structured LLM response, recovering from JSON answers when possible.

    The delimiter format is the documented protocol and always wins when it produces a usable
    result. JSON is attempted only to rescue a parse that already looks degraded.
    """
    parsed = _parse_delimited_response(response_text)
    if looks_degraded(parsed):
        recovered = _parse_json_response(response_text)
        if recovered is not None and not looks_degraded(recovered):
            return recovered
    return parsed


def _parse_delimited_response(response_text):
    """Parse structured LLM response with delimiters."""
    # Extract quick reference
    quick_ref_raw = extract_between(response_text, 'QUICK_REFERENCE_START', 'QUICK_REFERENCE_END')

    # Parse quick reference into dict
    quick_ref = {}
    for line in quick_ref_raw.split('\n'):
        if ':' in line:
            key, value = line.split(':', 1)
            quick_ref[key.strip().lower()] = value.strip()

    # Extract one-line summary
    brief = extract_between(response_text, 'ONE_LINE_SUMMARY_START', 'ONE_LINE_SUMMARY_END').strip()
    if not brief:
        brief = "Repository analysis"

    # Extract related repos
    related_text = extract_between(response_text, 'RELATED_REPOS_START', 'RELATED_REPOS_END')
    related_repos = [r.strip() for r in related_text.split(',') if r.strip()]

    # Get the main markdown (after the last marker)
    analysis_start = response_text.find('RELATED_REPOS_END')
    if analysis_start != -1:
        analysis_start += len('RELATED_REPOS_END')
        main_analysis = response_text[analysis_start:].strip()
    else:
        # Fallback - use entire response
        main_analysis = response_text

    return {
        'quick_ref': quick_ref,
        'brief': brief,
        'related_repos': related_repos,
        'analysis': main_analysis
    }


# Saved raw responses are derived from repository source and can quote secrets verbatim, so
# they are owner-only, redacted best-effort, size-capped, and pruned to a fixed generation count.
DEGRADED_DIR_NAME = '.degraded-responses'
MAX_DEGRADED_BYTES = 256 * 1024
MAX_DEGRADED_FILES = 20

_REDACTIONS = (
    (re.compile(r'-----BEGIN[^-]{0,40}PRIVATE KEY-----.*?-----END[^-]{0,40}PRIVATE KEY-----',
                re.S), '[REDACTED private key]'),
    (re.compile(r'\bAKIA[0-9A-Z]{16}\b'), '[REDACTED aws key id]'),
    (re.compile(r'\bgh[pousr]_[A-Za-z0-9]{20,}\b'), '[REDACTED github token]'),
    (re.compile(r'\bsk-(?:ant-)?[A-Za-z0-9_\-]{20,}\b'), '[REDACTED api key]'),
    (re.compile(r'\bxox[abposr]-[A-Za-z0-9-]{10,}\b'), '[REDACTED slack token]'),
    (re.compile(r'\b(?:Bearer|Basic)\s+[A-Za-z0-9._\-+/=]{20,}'), '[REDACTED authorization]'),
    (re.compile(r'(?i)\b((?:api[_-]?key|secret|password|passwd|token|access[_-]?key)'
                r'\s*[:=]\s*)(["\']?)[^\s"\'<>,;]{8,}\2'), r'\1[REDACTED]'),
)


def redact_secrets(text):
    """Best-effort scrub of high-confidence secret shapes. Not a guarantee — a defence in
    depth alongside owner-only permissions, not a substitute for them."""
    for pattern, replacement in _REDACTIONS:
        text = pattern.sub(replacement, text)
    return text


def save_degraded_response(pristine_dir, cache_name, response_text):
    """Persist a degraded raw response for diagnosis. Returns the path, or None on failure.

    Without the raw response, diagnosing a bad parse after the fact is guesswork — but the
    text is untrusted repository-derived content, so it is redacted, truncated, written
    0600 into a 0700 directory, and old generations are pruned.
    """
    directory = Path(pristine_dir) / DEGRADED_DIR_NAME
    directory.mkdir(mode=0o700, exist_ok=True)
    os.chmod(directory, 0o700)  # exist_ok=True skips mode on an existing directory

    # Cap actual BYTES on disk, not characters: len()/slicing counts code points, so a response
    # of multibyte UTF-8 can be several times the advertised cap once encoded. The marker is
    # counted inside the cap so the finished file never exceeds it.
    text = redact_secrets(response_text or '')
    marker = f"\n\n[truncated at {MAX_DEGRADED_BYTES} bytes by repo-radar]\n"
    encoded = text.encode('utf-8')
    if len(encoded) > MAX_DEGRADED_BYTES:
        room = max(MAX_DEGRADED_BYTES - len(marker.encode('utf-8')), 0)
        # errors='ignore' drops a partial character at the cut rather than raising.
        text = encoded[:room].decode('utf-8', errors='ignore') + marker

    target = directory / f"{cache_name}.txt"
    # Create owner-only from the outset rather than chmod-ing after a 0644 write.
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as handle:
        handle.write(text)
    os.chmod(target, 0o600)

    # Never prune the file just written: several repos degrading inside the same second get
    # indistinguishable mtimes, and a tie could otherwise evict the one being saved right now.
    others = [p for p in directory.glob('*.txt') if p != target]
    others.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    for stale in others[max(MAX_DEGRADED_FILES - 1, 0):]:
        try:
            stale.unlink()
        except OSError:
            pass

    return target


# Incremental metadata keeps its latest attempt per repository here, owner-only, so INDEX can say
# when a document is stale (an update failed or was skipped after it was written).
STATE_DIR_NAME = '.metadata-state'


def parse_frontmatter(content):
    """The `key: value` frontmatter of a metadata document as a dict, or None without one."""
    if not content.startswith('---'):
        return None
    parts = content.split('---', 2)
    if len(parts) < 3:
        return None
    info = {}
    for line in parts[1].split('\n'):
        if ':' in line:
            key, value = line.split(':', 1)
            info[key.strip()] = value.strip()
    return info


def read_attempt_state(pristine_dir, cache_name):
    """The latest incremental-metadata attempt recorded for `cache_name`, or None."""
    path = Path(pristine_dir) / STATE_DIR_NAME / f"{cache_name}.json"
    try:
        with open(path, 'r') as f:
            state = json.load(f)
        return state if isinstance(state, dict) else None
    except (OSError, ValueError):
        return None


def stale_label(state, document_text, info):
    """A one-line stale note when the latest attempt failed or was skipped after this document was
    written, or None when the document is current. The document's committed generation wins over a
    leftover attempt: the note applies only to an attempt made from exactly this document."""
    if not state or state.get('status') not in ('pending', 'committing', 'failed', 'skipped'):
        return None
    if state.get('baseline_doc_sha256') != hashlib.sha256(document_text.encode('utf-8')).hexdigest():
        return None
    if state.get('generation_id') and state.get('generation_id') == info.get('generation_id'):
        return None
    analyzed = (info.get('last_commit') or 'unknown')[:7]
    attempted = (state.get('target_commit') or 'unknown')[:7]
    reason = state.get('reason') or ('interrupted' if state.get('status') == 'pending' else 'update failed')
    return f"stale: analyzed {analyzed}, update to {attempted} {state.get('status')}: {reason}"


def write_text_atomic(path, text):
    """Replace `path` with `text` via a sibling temporary file, so readers see old or new, never part."""
    path = Path(path)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix='.tmp')
    try:
        with os.fdopen(fd, 'w') as handle:
            handle.write(text)
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# Quick Reference table rows: (field, label, value that hides the row). Same layout as the full
# generator writes, so a document from either path reads the same.
_QUICK_REF_ROWS = (
    ('type', 'Type', None), ('language', 'Language', None), ('framework', 'Framework', 'none'),
    ('database', 'Database', 'none'), ('apis', 'APIs Exposed', 'none'), ('port', 'Port', 'n/a'),
    ('dependencies', 'Key Dependencies', None),
)


def quick_reference_from_table(body):
    """Recover quick-reference fields from a document's Quick Reference table."""
    labels = {label: field for field, label, _hide in _QUICK_REF_ROWS}
    out = {}
    for match in re.finditer(r'^\| \*\*(.+?)\*\* \| (.*) \|$', body, re.M):
        field = labels.get(match.group(1))
        if field:
            out[field] = match.group(2)
    return out


class UnsafeHeader(ValueError):
    """A rendered document's frontmatter would not read back as written."""


def _header_value(key, value):
    text = str(value)
    if '---' in text or any(not ch.isprintable() for ch in text):
        raise UnsafeHeader(f"{key} contains a frontmatter delimiter, a line break or a control character")
    return text


def render_metadata_document(full_name, cache_name, clone_url, commit, updated, quick_ref, brief,
                             related_repos, analysis, provenance):
    """A complete metadata document in the full generator's format, plus provenance fields.

    `provenance` is an ordered mapping of extra one-line frontmatter fields (generation and full-build
    records); readers that don't know them ignore them. Every header value is checked, and the
    rendered header is read back and must give exactly these fields with a healthy parse status;
    otherwise UnsafeHeader is raised and nothing is written. Values are never rewritten.
    """
    header = {'repo_name': full_name.split('/')[-1], 'full_name': full_name, 'cache_dir': cache_name,
              'clone_url': clone_url, 'last_commit': commit, 'last_updated': updated, 'brief': brief,
              'type': quick_ref.get('type', 'Unknown'), 'language': quick_ref.get('language', 'Unknown'),
              'framework': quick_ref.get('framework', 'None'), 'database': quick_ref.get('database', 'None'),
              'apis': quick_ref.get('apis', 'None'), 'port': quick_ref.get('port', 'N/A'),
              'related_repos': json.dumps(related_repos), 'parse_status': PARSE_STATUS_OK, **provenance}
    header = {key: _header_value(key, value) for key, value in header.items()}
    table = "## Quick Reference\n\n| Property | Value |\n|----------|-------|\n"
    for field, label, hide in _QUICK_REF_ROWS:
        value = quick_ref.get(field)
        if value is not None and (hide is None or value.lower() != hide):
            table += f"| **{label}** | {value} |\n"
    table += "\n---\n\n"
    analysis = analysis.rstrip('\n')  # the template ends the file with exactly one newline
    lines = ''.join(f"{key}: {value}\n" for key, value in header.items())
    text = f"""---
{lines}---

# Repository: {full_name}

{table}{analysis}
"""
    expected = {key: value.strip() for key, value in header.items()}
    if parse_frontmatter(text) != expected:
        raise UnsafeHeader("the rendered header does not read back as written")
    return text


def _parse_status_of(info):
    """Trust a recorded parse_status; otherwise infer one from the frontmatter.

    Files written before parse_status existed carry no marker, so inferring it means the
    already-degraded entries surface on the next index regeneration instead of staying
    invisible until each repo happens to be re-synced.
    """
    recorded = info.get('parse_status')
    if recorded in (PARSE_STATUS_OK, PARSE_STATUS_DEGRADED):
        return recorded
    brief = (info.get('brief') or '').strip()
    if info.get('type', 'Unknown') == 'Unknown' or info.get('language', 'Unknown') == 'Unknown':
        return PARSE_STATUS_DEGRADED
    if not brief or _looks_like_fragment(brief):
        return PARSE_STATUS_DEGRADED
    return PARSE_STATUS_OK


def regenerate_index(args):
    """Regenerate the master INDEX.md file from all metadata files."""
    if args.dry_run:
        print(f"  {CYAN}[DRY RUN]{RESET} Would regenerate INDEX.md")
        return

    print(f"  {CYAN}Regenerating{RESET} INDEX.md...")

    # Collect all metadata files (*.md files in pristine dir, excluding INDEX.md).
    # Each repo has BOTH a canonical <repo>-<sha>.md and a stable <repo>.md symlink pointing
    # at it; globbing yields both, so without the symlink filter every repo is parsed twice
    # and the "Total Repositories" count doubles.
    metadata_files = [
        f for f in PRISTINE_DIR.glob('*.md')
        if f.name != 'INDEX.md' and not f.is_symlink()
    ]

    if not metadata_files:
        print(f"  {YELLOW}No metadata files found{RESET}")
        return

    # Parse metadata from each file
    repos_info = []
    for metadata_file in metadata_files:
        try:
            with open(metadata_file, 'r') as f:
                content = f.read()

                # Parse frontmatter
                if content.startswith('---'):
                    parts = content.split('---', 2)
                    if len(parts) >= 3:
                        frontmatter = parts[1]
                        info = {}
                        for line in frontmatter.split('\n'):
                            if ':' in line:
                                key, value = line.split(':', 1)
                                info[key.strip()] = value.strip()

                        repos_info.append({
                            'full_name': info.get('full_name', ''),
                            'cache_dir': info.get('cache_dir', ''),
                            'brief': info.get('brief', 'Repository analysis'),
                            'type': info.get('type', 'Unknown'),
                            'language': info.get('language', 'Unknown'),
                            'framework': info.get('framework', 'None'),
                            'database': info.get('database', 'None'),
                            'port': info.get('port', 'N/A'),
                            'apis': info.get('apis', 'None'),
                            'related_repos': info.get('related_repos', '[]'),
                            'parse_status': _parse_status_of(info),
                            'metadata_file': metadata_file.name,
                            'stale': stale_label(read_attempt_state(
                                PRISTINE_DIR, info.get('cache_dir') or metadata_file.stem), content, info),
                        })
        except Exception as e:
            print(f"  {YELLOW}Warning: Could not parse {metadata_file.name}:{RESET} {e}")
            continue

    # Sort by full name
    repos_info.sort(key=lambda x: x['full_name'])

    # Consumers are told this index is the filter that decides whether code is worth reading,
    # so entries whose metadata is known-degraded have to be visible rather than blend in.
    degraded = [i for i in repos_info if i.get('parse_status') == PARSE_STATUS_DEGRADED]
    degraded_note = ''
    if degraded:
        names = ', '.join(i['full_name'] or i['metadata_file'] for i in degraded)
        degraded_note = (f"\n> **{len(degraded)} of {len(repos_info)} entries have degraded "
                         f"metadata** (re-sync to regenerate): {names}\n")
        print(f"  {YELLOW}{len(degraded)} of {len(repos_info)} entries have degraded "
              f"metadata{RESET}")

    # Incremental metadata: a document whose latest update failed or was skipped is stale, not current;
    # an opted-in repository whose first build failed has no metadata at all. Say both.
    stale = [i for i in repos_info if i.get('stale')]
    if stale:
        names = ', '.join(i['full_name'] or i['metadata_file'] for i in stale)
        degraded_note += (f"\n> **{len(stale)} of {len(repos_info)} entries are stale** (their latest metadata "
                          f"update failed or was skipped; the previous metadata is shown): {names}\n")
    documented = {i['cache_dir'] for i in repos_info}
    unavailable = []
    state_dir = PRISTINE_DIR / STATE_DIR_NAME
    for state_file in sorted(state_dir.glob('*.json')) if state_dir.is_dir() else []:
        state = read_attempt_state(PRISTINE_DIR, state_file.stem)
        if state and state_file.stem not in documented and state.get('status') in ('pending', 'committing', 'failed', 'skipped'):
            unavailable.append(f"{state.get('full_name') or state_file.stem} ({state.get('reason') or 'interrupted'})")
    if unavailable:
        degraded_note += f"\n> **Metadata unavailable:** {'; '.join(unavailable)}\n"

    # Generate INDEX.md
    index_content = f"""# Pristine Repository Index

**Last Updated:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
**Total Repositories:** {len(repos_info)}

> This index provides a quick overview of all cached repositories.
> Each entry links to detailed metadata for deeper analysis.
{degraded_note}

## Repositories

"""

    for info in repos_info:
        # Parse related repos
        try:
            related = json.loads(info['related_repos']) if info['related_repos'] != '[]' else []
        except:
            related = []
        related_str = ", ".join(related[:5]) if related else "None"

        # Build tech stack string
        tech_parts = []
        if info['language'] and info['language'] != 'Unknown':
            tech_parts.append(info['language'])
        if info['database'] and info['database'] != 'None':
            tech_parts.append(info['database'])
        if info['framework'] and info['framework'] != 'None':
            tech_parts.append(info['framework'])
        tech_str = ", ".join(tech_parts) if tech_parts else "Unknown"

        # Build APIs/exposes string
        apis_str = info.get('apis', 'None')
        if not apis_str or apis_str == 'None':
            apis_str = "N/A"
        status_line = f"**Status:** ⚠ {info['stale']}\n" if info.get('stale') else ''

        index_content += f"""### {info['full_name']} (`{info['cache_dir']}/`)
**Type:** {info['type']}
**Tech:** {tech_str}
**Purpose:** {info['brief']}
**Exposes:** {apis_str}
**Database:** {info['database']}
**Interfaces:** {related_str}
{status_line}**[View Details]({info['metadata_file']})**

---

"""

    # Write INDEX.md atomically: readers see the old index or the new one, never part of it.
    write_text_atomic(INDEX_FILE, index_content)

    print(f"  {GREEN}✓ INDEX.md updated{RESET} ({len(repos_info)} repositories)")
