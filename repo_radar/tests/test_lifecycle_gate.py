import json, subprocess, sys, datetime, tempfile, os
from pathlib import Path
from repo_radar import llm
from repo_radar import model_catalog
from scripts import check_model_lifecycle as gate

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "repo_radar" / "model_lifecycle.json"
JUL23 = datetime.date(2026, 7, 23)   # arbitrary reference date for the synthetic fixtures below
RELEASE = datetime.date(2026, 8, 7)  # the real release target — BUMP each release so the gate is
                                     # checked against the date the build actually ships
OK = "https://example.com/x"

def _tmp(rows):
    f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    json.dump(rows, f); f.close(); return f.name

def _run(rows, known, migs, target=JUL23):
    p = _tmp(rows)
    try:
        return gate.check(p, set(known), set(migs), target)
    finally:
        os.unlink(p)

def test_real_manifest_exact_set_and_passes_at_release():
    rows = json.loads(MANIFEST.read_text())
    ids = [r["id"] for r in rows]
    assert len(ids) == len(set(ids)), "duplicate ids in manifest"
    assert set(ids) == set(model_catalog.MODEL_CAPS) | set(llm.MODEL_MIGRATIONS)
    assert gate.check(str(MANIFEST), set(model_catalog.MODEL_CAPS), set(llm.MODEL_MIGRATIONS), RELEASE) == []

def test_happy_row_passes():
    assert _run(
        [{"id": "k", "status": "active", "shutdown_date": None, "source_url": OK},
         {"id": "m", "status": "retired", "shutdown_date": "2026-07-01", "source_url": OK}],
        {"k"}, {"m"}) == []

def test_failures_are_returned_not_raised():
    cases = [
        # (rows, known, migs, substring-in-some-failure)
        ([{"id":"k","status":"active","shutdown_date":None,"source_url":OK},
          {"id":"k","status":"retired","shutdown_date":"2026-01-01","source_url":OK}], {"k"}, set(), "duplicate"),
        ([], {"k"}, set(), "missing"),                                                    # missing row
        ([{"id":"x","status":"active","shutdown_date":None,"source_url":OK}], set(), set(), "extra"),
        ([{"id":"k","status":"retired","shutdown_date":None,"source_url":OK}], {"k"}, set(), "status=active"),
        ([{"id":"m","status":"active","shutdown_date":"2026-07-01","source_url":OK}], set(), {"m"}, "status=retired"),
        ([{"id":"k","status":"active","shutdown_date":"2026-07-01","source_url":OK}], {"k"}, set(), "<= target"),  # known dies before target
        ([{"id":"m","status":"retired","shutdown_date":None,"source_url":OK}], set(), {"m"}, "not on/before"),      # migration key null
        ([{"id":"m","status":"retired","shutdown_date":"2026-08-01","source_url":OK}], set(), {"m"}, "not on/before"),# future
        ([{"id":"k","status":"active","shutdown_date":"nope","source_url":OK}], {"k"}, set(), None),                # malformed date -> some failure, no raise
        ([{"id":"k","status":"active","shutdown_date":None,"source_url":"http://x"}], {"k"}, set(), "source_url"),  # non-https
        ([{"id":"k","status":"active","source_url":OK}], {"k"}, set(), None),                                       # missing shutdown_date key -> failure, no raise
        ([{"id":123,"status":"active","shutdown_date":None,"source_url":OK}], {"k"}, set(), "non-string id"),       # non-string/unhashable id -> failure, no raise (no set() crash)
    ]
    for rows, known, migs, sub in cases:
        fails = _run(rows, known, migs)   # must not raise
        assert fails, (rows, "expected failures")
        if sub:
            assert any(sub in f for f in fails), (sub, fails)

def test_cli_requires_iso_date():
    p = subprocess.run([sys.executable, str(ROOT / "scripts" / "check_model_lifecycle.py"),
                        "--target-date", "not-a-date"], capture_output=True, text=True)
    assert p.returncode != 0 and "invalid" in p.stderr.lower()
