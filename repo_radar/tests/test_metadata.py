import types

from repo_radar.metadata import (
    PARSE_STATUS_DEGRADED,
    PARSE_STATUS_OK,
    degradation_reasons,
    extract_between,
    looks_degraded,
    parse_llm_response,
)


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


def test_parse_status_of_never_raises_on_any_input():
    """It classifies; it must never be able to remove a repository from the index."""
    from repo_radar.metadata import _parse_status_of

    for info in ({}, {"brief": None}, {"brief": 123}, {"type": None, "language": None},
                 {"brief": "ok", "type": "API Service", "language": "Go"},
                 {"parse_status": "nonsense", "brief": "x", "type": "T", "language": "L"}):
        _parse_status_of(info)  # must not raise


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
