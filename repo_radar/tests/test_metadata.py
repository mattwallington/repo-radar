import types

import pytest

from repo_radar.metadata import (
    PARSE_STATUS_DEGRADED,
    PARSE_STATUS_OK,
    degradation_reasons,
    extract_between,
    looks_degraded,
    parse_llm_response,
)


@pytest.fixture(autouse=True)
def no_ambient_exclusions(monkeypatch):
    """regenerate_index consults the user's real config for exclusions.

    Autouse so no test in this module can depend on what happens to be excluded on the machine
    running it — the same ambient-state hazard as reading the real ~/repos-pristine. Tests that
    exercise exclusions override this explicitly.
    """
    import repo_radar.metadata as metadata
    monkeypatch.setattr(metadata, "load_exclusions", lambda: [])


DELIMITED_RESPONSE = """Some preamble

QUICK_REFERENCE_START
Type: API Service
Language: Python
QUICK_REFERENCE_END

ONE_LINE_SUMMARY_START
A Python API service.
ONE_LINE_SUMMARY_END

RELATED_REPOS_START
org/other-repo, org/another
RELATED_REPOS_END

## Overview
Full analysis here.
"""


def test_extract_between():
    text = "before QUICK_REFERENCE_START\ndata here\nQUICK_REFERENCE_END after"
    result = extract_between(text, "QUICK_REFERENCE_START", "QUICK_REFERENCE_END")
    assert result.strip() == "data here"


def test_extract_between_missing_markers():
    result = extract_between("no markers here", "START", "END")
    assert result == ""


def test_parse_llm_response_extracts_sections():
    result = parse_llm_response(DELIMITED_RESPONSE)
    assert result["quick_ref"]["type"] == "API Service"
    assert result["quick_ref"]["language"] == "Python"
    assert result["brief"] == "A Python API service."
    assert "org/other-repo" in result["related_repos"]
    assert "Full analysis here" in result["analysis"]


# ── regression: the delimiter format must not regress ────────────────────────────────


def test_delimiter_response_is_unchanged_by_json_recovery():
    """The documented format still wins outright — JSON recovery must not perturb it."""
    result = parse_llm_response(DELIMITED_RESPONSE)
    assert not looks_degraded(result)
    assert result["quick_ref"] == {"type": "API Service", "language": "Python"}
    assert result["brief"] == "A Python API service."


def test_json_braces_in_analysis_body_do_not_hijack_a_good_parse():
    """A healthy delimiter parse is never re-derived from a stray object in the prose."""
    response = DELIMITED_RESPONSE + """
### Example config
```json
{"type": "WRONG", "one_line_summary": "this must never be used"}
```
"""
    result = parse_llm_response(response)
    assert result["quick_ref"]["type"] == "API Service"
    assert result["brief"] == "A Python API service."


# ── regression: JSON responses are recovered ─────────────────────────────────────────


def test_json_response_is_recovered():
    """A model that answers in JSON yields populated fields, clean prose, list-typed repos."""
    response = """```json
{
  "quick_reference": {"Type": "CLI Tool", "Language": "Go 1.22", "Framework": "None"},
  "one_line_summary": "A Go CLI for managing pristine clones.",
  "related_repos": ["org/one", "org/two"],
  "analysis": "## Overview\\nDetails."
}
```"""
    result = parse_llm_response(response)
    assert result["quick_ref"]["type"] == "CLI Tool"
    assert result["quick_ref"]["language"] == "Go 1.22"
    assert result["brief"] == "A Go CLI for managing pristine clones."
    assert result["related_repos"] == ["org/one", "org/two"]
    assert not looks_degraded(result)


def test_flat_json_response_is_recovered():
    """Not every model nests under quick_reference; a flat object works too."""
    response = '{"type": "Library", "language": "TypeScript", "summary": "A parsing library."}'
    result = parse_llm_response(response)
    assert result["quick_ref"]["type"] == "Library"
    assert result["brief"] == "A parsing library."
    assert not looks_degraded(result)


# ── regression: garbage is flagged, not silently written ─────────────────────────────


def test_truncated_response_is_flagged_degraded():
    """A truncated answer must be reported, not cached as truth."""
    result = parse_llm_response("QUICK_REFERENCE_START\nType: API Serv")
    assert looks_degraded(result)
    reasons = degradation_reasons(result)
    assert any("summary" in r for r in reasons)


def test_json_leaking_through_delimiters_is_flagged():
    """The observed real-world failure: JSON emitted *inside* the delimiters.

    Mirrors matts-tools, whose brief was `": "This repository contains…` and whose
    related_repos were quote-only shards.
    """
    response = """QUICK_REFERENCE_START
  "type": "Go",
QUICK_REFERENCE_END
ONE_LINE_SUMMARY_START
": "This repository contains utility scripts",
ONE_LINE_SUMMARY_END
RELATED_REPOS_START
": "None", "
RELATED_REPOS_END
"""
    result = parse_llm_response(response)
    assert looks_degraded(result)
    reasons = degradation_reasons(result)
    assert any("fragment" in r or "quick reference" in r for r in reasons)


def test_empty_quick_reference_with_clean_prose_is_flagged():
    """The dominant real failure: a good summary but an empty QUICK_REFERENCE block.

    9 of the 10 affected repos looked exactly like this, which is why `type: Unknown`
    read as model ignorance instead of a parser that gave up.
    """
    response = """QUICK_REFERENCE_START
QUICK_REFERENCE_END

ONE_LINE_SUMMARY_START
A comprehensive healthcare claims platform.
ONE_LINE_SUMMARY_END

RELATED_REPOS_START
RELATED_REPOS_END
"""
    result = parse_llm_response(response)
    assert result["brief"] == "A comprehensive healthcare claims platform."
    assert looks_degraded(result), "clean prose must not mask an empty quick reference"
    assert any("quick reference empty" in r for r in degradation_reasons(result))


def test_healthy_parse_has_no_reasons():
    assert degradation_reasons(parse_llm_response(DELIMITED_RESPONSE)) == []
    assert PARSE_STATUS_OK == 'ok' and PARSE_STATUS_DEGRADED == 'degraded'


# ── regression: index counts each repo once, not once per symlink ────────────────────


def test_regenerate_index_counts_symlinked_repo_once(tmp_path, monkeypatch):
    """A real metadata file plus its stable symlink is ONE repo, not two."""
    import repo_radar.metadata as metadata

    canonical = tmp_path / "demo-abc1234.md"
    canonical.write_text(
        "---\n"
        "repo_name: demo\n"
        "full_name: org/demo\n"
        "cache_dir: demo-abc1234\n"
        "brief: A demo repository.\n"
        "type: Library\n"
        "language: Python\n"
        "related_repos: []\n"
        "parse_status: ok\n"
        "---\n\n# Repository: org/demo\n"
    )
    (tmp_path / "demo.md").symlink_to(canonical.name)

    index_file = tmp_path / "INDEX.md"
    monkeypatch.setattr(metadata, "PRISTINE_DIR", tmp_path)
    monkeypatch.setattr(metadata, "INDEX_FILE", index_file)
    monkeypatch.setattr(metadata, "load_cache_index", lambda: {})

    metadata.regenerate_index(types.SimpleNamespace(dry_run=False))

    content = index_file.read_text()
    assert content.count("\n### ") == 1, "symlink must not produce a second section"
    assert "**Total Repositories:** 1" in content


def test_regenerate_index_surfaces_degraded_entries(tmp_path, monkeypatch):
    """Degraded metadata is called out in the index rather than blending in."""
    import repo_radar.metadata as metadata

    (tmp_path / "broken-def5678.md").write_text(
        "---\n"
        "repo_name: broken\n"
        "full_name: org/broken\n"
        "cache_dir: broken-def5678\n"
        "brief: Something.\n"
        "type: Unknown\n"
        "language: Unknown\n"
        "related_repos: []\n"
        "parse_status: degraded\n"
        "---\n\n# Repository: org/broken\n"
    )

    index_file = tmp_path / "INDEX.md"
    monkeypatch.setattr(metadata, "PRISTINE_DIR", tmp_path)
    monkeypatch.setattr(metadata, "INDEX_FILE", index_file)
    monkeypatch.setattr(metadata, "load_cache_index", lambda: {})

    metadata.regenerate_index(types.SimpleNamespace(dry_run=False))

    content = index_file.read_text()
    assert "degraded metadata" in content
    assert "org/broken" in content


def test_legacy_file_without_parse_status_is_inferred_degraded(tmp_path, monkeypatch):
    """Pre-existing files predate parse_status; they must still surface as degraded."""
    import repo_radar.metadata as metadata

    (tmp_path / "legacy-aaa1111.md").write_text(
        "---\n"
        "repo_name: legacy\n"
        "full_name: org/legacy\n"
        "cache_dir: legacy-aaa1111\n"
        "brief: A perfectly good summary sentence.\n"
        "type: Unknown\n"
        "language: Unknown\n"
        "related_repos: []\n"
        "---\n\n# Repository: org/legacy\n"
    )
    index_file = tmp_path / "INDEX.md"
    monkeypatch.setattr(metadata, "PRISTINE_DIR", tmp_path)
    monkeypatch.setattr(metadata, "INDEX_FILE", index_file)
    monkeypatch.setattr(metadata, "load_cache_index", lambda: {})

    metadata.regenerate_index(types.SimpleNamespace(dry_run=False))
    assert "degraded metadata" in index_file.read_text()


# ── saved raw responses are owner-only, redacted, capped, and pruned ─────────────────


def test_degraded_response_is_owner_only(tmp_path):
    from repo_radar.metadata import DEGRADED_DIR_NAME, save_degraded_response
    target = save_degraded_response(tmp_path, "demo-abc1234", "some response")
    assert oct(target.stat().st_mode)[-3:] == "600"
    assert oct((tmp_path / DEGRADED_DIR_NAME).stat().st_mode)[-3:] == "700"


def test_degraded_response_tightens_a_preexisting_loose_directory(tmp_path):
    """mkdir(exist_ok=True) skips mode on an existing dir, so it must be re-chmod'd."""
    import os
    from repo_radar.metadata import DEGRADED_DIR_NAME, save_degraded_response
    loose = tmp_path / DEGRADED_DIR_NAME
    loose.mkdir(mode=0o755)
    save_degraded_response(tmp_path, "demo-abc1234", "x")
    assert oct(os.stat(loose).st_mode)[-3:] == "700"


def test_degraded_response_redacts_high_confidence_secrets(tmp_path):
    from repo_radar.metadata import save_degraded_response
    secrets = (
        "AKIAIOSFODNN7EXAMPLE\n"
        "ghp_abcdefghijklmnopqrstuvwxyz0123456789\n"
        "sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456\n"
        "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456\n"
        'API_KEY = "supersecretvalue123"\n'
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----\n"
    )
    body = save_degraded_response(tmp_path, "demo-abc1234", secrets).read_text()
    for leaked in ("AKIAIOSFODNN7EXAMPLE", "ghp_abcdefghij", "sk-ant-api03",
                   "supersecretvalue123", "MIIEow=="):
        assert leaked not in body, f"{leaked} survived redaction"
    assert "REDACTED" in body


def test_degraded_response_is_size_capped(tmp_path):
    from repo_radar.metadata import MAX_DEGRADED_BYTES, save_degraded_response
    body = save_degraded_response(tmp_path, "big-abc1234", "x" * (MAX_DEGRADED_BYTES * 2)).read_text()
    assert len(body) < MAX_DEGRADED_BYTES + 200
    assert "truncated" in body


def test_degraded_responses_are_pruned_to_a_bounded_count(tmp_path):
    import os, time
    from repo_radar.metadata import DEGRADED_DIR_NAME, MAX_DEGRADED_FILES, save_degraded_response
    for i in range(MAX_DEGRADED_FILES + 5):
        p = save_degraded_response(tmp_path, f"repo-{i:03d}", "body")
        os.utime(p, (time.time() + i, time.time() + i))  # deterministic recency
    kept = list((tmp_path / DEGRADED_DIR_NAME).glob("*.txt"))
    assert len(kept) == MAX_DEGRADED_FILES


# ── review follow-ups ────────────────────────────────────────────────────────────────


def test_degraded_response_cap_counts_bytes_not_characters(tmp_path):
    """A multibyte response must not blow past the advertised on-disk cap.

    len()/slicing counts code points; a 4-byte-per-char response was ~4x the stated cap.
    """
    from repo_radar.metadata import MAX_DEGRADED_BYTES, save_degraded_response
    target = save_degraded_response(tmp_path, "wide-abc1234", "😀" * MAX_DEGRADED_BYTES)
    assert target.stat().st_size <= MAX_DEGRADED_BYTES, (
        f"file is {target.stat().st_size} bytes against a {MAX_DEGRADED_BYTES} cap")
    assert "truncated" in target.read_text()


def test_degraded_response_cap_includes_the_marker(tmp_path):
    from repo_radar.metadata import MAX_DEGRADED_BYTES, save_degraded_response
    target = save_degraded_response(tmp_path, "big-abc1234", "a" * (MAX_DEGRADED_BYTES * 3))
    assert target.stat().st_size <= MAX_DEGRADED_BYTES


def test_quote_opening_summary_is_not_flagged(tmp_path):
    """A legitimate summary that opens with a quotation mark is prose, not a fragment."""
    response = """QUICK_REFERENCE_START
Type: Library
Language: Python
QUICK_REFERENCE_END

ONE_LINE_SUMMARY_START
"Batteries included" utilities for parsing repository metadata.
ONE_LINE_SUMMARY_END

RELATED_REPOS_START
RELATED_REPOS_END
"""
    result = parse_llm_response(response)
    assert not looks_degraded(result), degradation_reasons(result)


def test_genuinely_unknown_language_is_not_a_parse_failure():
    """The parser succeeded; the model just could not identify the language.

    Incomplete metadata is not the same defect as a parse that produced nothing, and
    conflating them makes the degraded signal noisy enough to ignore.
    """
    response = """QUICK_REFERENCE_START
Type: Infrastructure
Language: Unknown
QUICK_REFERENCE_END

ONE_LINE_SUMMARY_START
Terraform definitions with no dominant implementation language.
ONE_LINE_SUMMARY_END

RELATED_REPOS_START
RELATED_REPOS_END
"""
    result = parse_llm_response(response)
    assert not looks_degraded(result), degradation_reasons(result)


def test_structural_quick_reference_keys_are_still_flagged():
    """JSON split on ':' yields keys like '"type"', so values never reach their fields."""
    result = parse_llm_response(
        'QUICK_REFERENCE_START\n  "type": "Go",\n  "language": "Go",\nQUICK_REFERENCE_END\n'
        'ONE_LINE_SUMMARY_START\nA Go toolkit.\nONE_LINE_SUMMARY_END\n'
    )
    assert looks_degraded(result)
    assert any("structural" in r for r in degradation_reasons(result))


# ── regression: the index must not drop healthy repositories ─────────────────────────────


def test_parse_status_of_healthy_frontmatter_returns_ok():
    """Direct regression for the NameError that silently dropped 21 of 31 repos.

    _parse_status_of returns early for files with a recorded status and for Unknown
    type/language, so ONLY a healthy file reached the fragment check — meaning the classifier
    raised on exactly the files that were fine, and regenerate_index's broad handler dropped
    them. The index kept the bad entries and discarded the good ones.
    """
    from repo_radar.metadata import PARSE_STATUS_OK, _parse_status_of

    info = {
        "brief": "A Go service that brokers eligibility checks.",
        "type": "Backend Service",
        "language": "Python 3.9",
    }
    assert _parse_status_of(info) == PARSE_STATUS_OK


def test_parse_status_of_never_raises_and_always_returns_a_valid_status():
    """It classifies; it must never be able to remove a repository from the index.

    Asserting only "does not raise" would pass if the function returned None or any other
    junk — and a None parse_status flows straight into the degraded-entry filter, where it
    silently reads as healthy. The returned value has to be one of the two real statuses.
    """
    from repo_radar.metadata import _parse_status_of

    for info in ({}, {"brief": None}, {"brief": 123}, {"type": None, "language": None},
                 {"brief": "ok", "type": "API Service", "language": "Go"},
                 {"parse_status": "nonsense", "brief": "x", "type": "T", "language": "L"}):
        assert _parse_status_of(info) in (PARSE_STATUS_OK, PARSE_STATUS_DEGRADED), info


def test_regenerate_index_includes_healthy_repos(tmp_path, monkeypatch):
    """The test whose absence let a 21-repo drop ship: one healthy + one degraded, both listed."""
    import types
    import repo_radar.metadata as metadata

    (tmp_path / "healthy-aaa1111.md").write_text(
        "---\nrepo_name: healthy\nfull_name: org/healthy\ncache_dir: healthy-aaa1111\n"
        "brief: A healthy repository with real analysis.\n"
        "type: Backend Service\nlanguage: Python 3.9\nrelated_repos: []\n---\n\n# Repository\n")
    (tmp_path / "degraded-bbb2222.md").write_text(
        "---\nrepo_name: degraded\nfull_name: org/degraded\ncache_dir: degraded-bbb2222\n"
        "brief: Something.\ntype: Unknown\nlanguage: Unknown\nrelated_repos: []\n---\n\n# Repository\n")

    index_file = tmp_path / "INDEX.md"
    monkeypatch.setattr(metadata, "PRISTINE_DIR", tmp_path)
    monkeypatch.setattr(metadata, "INDEX_FILE", index_file)
    monkeypatch.setattr(metadata, "load_cache_index", lambda: {})

    metadata.regenerate_index(types.SimpleNamespace(dry_run=False))

    content = index_file.read_text()
    assert "**Total Repositories:** 2" in content, "a healthy repo must not be dropped"
    assert "org/healthy" in content and "org/degraded" in content


HEALTHY_FRONTMATTER = (
    "---\nrepo_name: healthy\nfull_name: org/healthy\ncache_dir: healthy-aaa1111\n"
    "brief: A healthy repository with real analysis.\n"
    "type: Backend Service\nlanguage: Python 3.9\nrelated_repos: []\n---\n\n# Repository\n")


def _index_env(tmp_path, monkeypatch):
    """Point regenerate_index at an isolated corpus and return its INDEX path."""
    import repo_radar.metadata as metadata

    index_file = tmp_path / "INDEX.md"
    monkeypatch.setattr(metadata, "PRISTINE_DIR", tmp_path)
    monkeypatch.setattr(metadata, "INDEX_FILE", index_file)
    monkeypatch.setattr(metadata, "load_cache_index", lambda: {})
    return metadata, index_file


def test_regenerate_index_reports_zero_drops_and_succeeds_when_every_file_parses(
        tmp_path, monkeypatch, capsys):
    metadata, _ = _index_env(tmp_path, monkeypatch)
    (tmp_path / "healthy-aaa1111.md").write_text(HEALTHY_FRONTMATTER)

    dropped = metadata.regenerate_index(types.SimpleNamespace(dry_run=False))

    assert dropped == 0
    out = capsys.readouterr().out
    assert "INDEX.md updated" in out
    assert "EXCLUDED" not in out and "INCOMPLETE" not in out


def test_regenerate_index_returns_drop_count_and_refuses_to_claim_success(
        tmp_path, monkeypatch, capsys):
    """A partial index printed the red warning AND the green checkmark, so it read as a success.

    The count is the signal sync uses to fail the run, so it has to be both correct and
    accompanied by the absence of a success line — either alone is still misreportable.
    """
    metadata, index_file = _index_env(tmp_path, monkeypatch)
    (tmp_path / "healthy-aaa1111.md").write_text(HEALTHY_FRONTMATTER)
    # Frontmatter opened but never closed: appends nothing and raises nothing.
    (tmp_path / "malformed-ccc3333.md").write_text(
        "---\nfull_name: org/malformed\ncache_dir: malformed-ccc3333\n# never closed\n")

    dropped = metadata.regenerate_index(types.SimpleNamespace(dry_run=False))

    assert dropped == 1, "the malformed file is one excluded repository"
    out = capsys.readouterr().out
    assert "1 of 2 repositories were EXCLUDED" in out
    assert "INDEX.md is INCOMPLETE" in out
    assert "✓ INDEX.md updated" not in out, "a partial index must not print a success line"
    assert "org/healthy" in index_file.read_text(), "the parseable repo is still written"


def test_closed_frontmatter_without_identity_fields_is_excluded_not_silently_listed(
        tmp_path, monkeypatch, capsys):
    """Well-formed delimiters are not proof of a usable entry.

    Without full_name/cache_dir the row renders as "### (`/`)" — no repository name, no clone
    path — so the repository is just as invisible as if it had been dropped, except the index
    reports itself complete.
    """
    metadata, index_file = _index_env(tmp_path, monkeypatch)
    (tmp_path / "healthy-aaa1111.md").write_text(HEALTHY_FRONTMATTER)
    (tmp_path / "nameless-ddd4444.md").write_text(
        "---\nbrief: Something was analysed here.\n"
        "type: Backend Service\nlanguage: Go\nrelated_repos: []\n---\n\n# Repository\n")

    dropped = metadata.regenerate_index(types.SimpleNamespace(dry_run=False))

    assert dropped == 1
    out = capsys.readouterr().out
    assert "full_name" in out and "cache_dir" in out, "the message must name what is missing"
    content = index_file.read_text()
    assert "### (`/`)" not in content, "an anonymous row must never be written"
    assert "**Total Repositories:** 1" in content, "it must not be counted as covered"


def test_classifier_failure_is_announced_and_the_repository_is_still_indexed(
        tmp_path, monkeypatch, capsys):
    """Totality is correct; SILENT totality rebuilds the original defect one level down.

    If the classifier starts raising again, every healthy repository gets relabelled degraded.
    That is far better than losing them, but with nothing printed it is exactly as undiagnosable
    as the NameError was — the symptom shows up in the data, months later.
    """
    metadata, index_file = _index_env(tmp_path, monkeypatch)
    (tmp_path / "healthy-aaa1111.md").write_text(HEALTHY_FRONTMATTER)

    def _boom(_brief):
        raise NameError("_FRAGMENT_PREFIXES")
    monkeypatch.setattr(metadata, "_looks_like_fragment", _boom)

    dropped = metadata.regenerate_index(types.SimpleNamespace(dry_run=False))

    assert dropped == 0, "a classifier bug must never remove a repository"
    out = capsys.readouterr().out
    assert "classification failed" in out and "NameError" in out, (
        "an internal classifier defect must be visible, not absorbed into 'degraded'")
    assert "healthy-aaa1111.md" in out, "the message must identify which file failed"
    assert "org/healthy" in index_file.read_text()


def test_an_excluded_repo_leaves_the_index_without_counting_as_a_drop(
        tmp_path, monkeypatch, capsys):
    """A decision and a defect must not look the same.

    An excluded repository is deliberately absent; a dropped one is missing when it should be
    there and fails the run. Counting an exclusion as a drop would make every sync exit 1 forever
    for as long as any excluded repository still had a metadata file on disk.
    """
    metadata, index_file = _index_env(tmp_path, monkeypatch)
    (tmp_path / "healthy-aaa1111.md").write_text(HEALTHY_FRONTMATTER)
    (tmp_path / "firmware-eee5555.md").write_text(
        "---\nfull_name: org/firmware\ncache_dir: firmware-eee5555\nbrief: 600MB of firmware.\n"
        "type: Firmware\nlanguage: C\nrelated_repos: []\n---\n")
    monkeypatch.setattr(metadata, "load_exclusions", lambda: ["firmware"])

    dropped = metadata.regenerate_index(types.SimpleNamespace(dry_run=False))

    assert dropped == 0, "an exclusion is a decision, not a failure"
    content = index_file.read_text()
    assert "org/firmware" not in content, "an excluded repo must not be indexed"
    assert "org/healthy" in content
    assert "**Total Repositories:** 1" in content
    out = capsys.readouterr().out
    assert "Excluded 1 repository" in out and "org/firmware" in out, "the omission must be visible"
    assert "EXCLUDED from INDEX.md" not in out, "not the red incomplete-index banner"
    assert "✓ INDEX.md updated" in out, "the run succeeded"


def test_sync_consumes_the_index_drop_count():
    """Landmark: the drop signal must reach sync's result, not merely be returned.

    regenerate_index already returned a count before this test existed, and sync called it as a
    bare statement — so an incomplete index printed a red warning and the run still exited 0 with
    a green success line. A returned value that nothing reads is the same defect as no value at
    all, and it is invisible to every behavioural test of regenerate_index itself.
    """
    import ast
    from pathlib import Path

    import repo_radar.modes.sync as sync_module

    tree = ast.parse(Path(sync_module.__file__).read_text())

    def _is_call(node):
        return (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                and node.func.id == "regenerate_index")

    calls = [n for n in ast.walk(tree) if _is_call(n)]
    assert calls, "sync no longer calls regenerate_index at all"

    discarded = [n for n in ast.walk(tree)
                 if isinstance(n, ast.Expr) and _is_call(n.value)]
    assert not discarded, (
        f"regenerate_index() is called as a bare statement at line(s) "
        f"{[n.lineno for n in discarded]} — its drop count is discarded")

    sync_fn = next(n for n in ast.walk(tree)
                   if isinstance(n, ast.FunctionDef) and n.name == "sync_mode")
    returns = [ast.unparse(n) for n in ast.walk(sync_fn)
               if isinstance(n, ast.Return) and n.value is not None]
    assert any("index_dropped" in r for r in returns), (
        "sync_mode's exit code ignores index drops, so an incomplete index still exits 0")


def test_an_empty_corpus_writes_an_empty_index_rather_than_leaving_a_stale_one(
        tmp_path, monkeypatch):
    """After the last metadata file is removed, the index must stop advertising repositories.

    Returning early left whatever INDEX.md already existed, and every subsequent run took the
    same early return — so a stale index could advertise removed repositories indefinitely.
    """
    metadata, index_file = _index_env(tmp_path, monkeypatch)
    index_file.write_text('# Pristine Repository Index\n\n**Total Repositories:** 3\n\n'
                          '### org/removed (`removed-aaa1111/`)\n')

    dropped = metadata.regenerate_index(types.SimpleNamespace(dry_run=False))

    assert dropped == 0
    content = index_file.read_text()
    assert '**Total Repositories:** 0' in content
    assert 'org/removed' not in content, 'a removed repository must not survive in the index'


def test_an_excluded_entry_missing_cache_dir_is_excluded_not_dropped(tmp_path, monkeypatch):
    """Exclusion is decided as soon as full_name is known.

    Checked after the identity fields, an excluded file that also lacked cache_dir became a
    permanent drop — failing every sync forever over a repository we had decided not to care
    about and could not fix without editing the file by hand.
    """
    metadata, index_file = _index_env(tmp_path, monkeypatch)
    (tmp_path / "healthy-aaa1111.md").write_text(HEALTHY_FRONTMATTER)
    (tmp_path / "firmware-eee5555.md").write_text(
        "---\nfull_name: org/firmware\nbrief: No cache_dir here.\n"
        "type: Firmware\nlanguage: C\n---\n")
    monkeypatch.setattr(metadata, "load_exclusions", lambda: ["firmware"])

    dropped = metadata.regenerate_index(types.SimpleNamespace(dry_run=False))

    assert dropped == 0, "an excluded repo must never become a permanent drop"
    assert "org/firmware" not in index_file.read_text()
