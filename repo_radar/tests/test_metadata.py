from repo_radar.metadata import extract_between, parse_llm_response


def test_extract_between():
    text = "before QUICK_REFERENCE_START\ndata here\nQUICK_REFERENCE_END after"
    result = extract_between(text, "QUICK_REFERENCE_START", "QUICK_REFERENCE_END")
    assert result.strip() == "data here"


def test_extract_between_missing_markers():
    result = extract_between("no markers here", "START", "END")
    assert result == ""


def test_parse_llm_response_extracts_sections():
    response = """Some preamble

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
    result = parse_llm_response(response)
    assert result["quick_ref"]["type"] == "API Service"
    assert result["quick_ref"]["language"] == "Python"
    assert result["brief"] == "A Python API service."
    assert "org/other-repo" in result["related_repos"]
    assert "Full analysis here" in result["analysis"]
