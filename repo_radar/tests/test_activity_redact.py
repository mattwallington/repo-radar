import json, pathlib
from repo_radar.activity import redact

FIX = pathlib.Path(__file__).parent / "data" / "redaction_fixtures.json"

def test_shared_fixtures_mask_as_expected():
    for case in json.loads(FIX.read_text()):
        r = redact.Redactor(configured_secrets=case["secrets"])
        assert r.scrub(case["raw"]) == case["expected"], case["raw"]

def test_overlapping_secrets_mask_fully_longest_first():
    r = redact.Redactor(configured_secrets=["abc", "abcdef123456"])
    assert "abcdef123456" not in r.scrub("val=abcdef123456")
