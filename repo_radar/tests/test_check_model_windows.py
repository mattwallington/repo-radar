import datetime
from repo_radar.model_catalog import ModelCaps
from scripts import check_model_windows as gate

TARGET = datetime.date(2026, 8, 10)
URL = "https://example.com/docs"

# A caps row that satisfies every invariant on its own, paired with a litellm_info
# response that exactly matches it (so the litellm-compare step produces no findings).
GOOD_CAPS = ModelCaps(200000, 200000, 64000, "anthropic_api", URL, "2026-08-08")
GOOD_LITELLM = {"max_input_tokens": 200000, "max_output_tokens": 64000}


def _info_for(table):
    """Build a litellm_info(model) callable from a {model: dict-or-Exception} table."""
    def _fn(model):
        v = table[model]
        if isinstance(v, Exception):
            raise v
        return v
    return _fn


def test_happy_path_no_findings():
    caps_map = {"m": GOOD_CAPS}
    findings = gate.check(caps_map, _info_for({"m": GOOD_LITELLM}), [], TARGET)
    assert findings == []


def test_window_field_must_be_positive_int():
    bad_values = [0, -5, "200000"]
    for field_name, idx in (("total_context", 0), ("max_input", 1), ("max_output", 2)):
        for bad in bad_values:
            row = list(GOOD_CAPS)
            row[idx] = bad
            caps = ModelCaps(*row)
            findings = gate.check({"m": caps}, _info_for({"m": GOOD_LITELLM}), [], TARGET)
            assert any(f.model == "m" and f.field == field_name and f.blocking for f in findings), \
                (field_name, bad, findings)


def test_bool_excluded_from_positive_int():
    # isinstance(True, int) is True in Python -- must not sneak past the positive-int check.
    row = list(GOOD_CAPS)
    row[2] = True  # max_output
    caps = ModelCaps(*row)
    findings = gate.check({"m": caps}, _info_for({"m": GOOD_LITELLM}), [], TARGET)
    assert any(f.model == "m" and f.field == "max_output" and f.blocking for f in findings), findings


def test_max_input_must_not_exceed_total_context():
    caps = GOOD_CAPS._replace(total_context=100000, max_input=200000)
    findings = gate.check({"m": caps}, _info_for({"m": {"max_input_tokens": 200000, "max_output_tokens": 64000}}), [], TARGET)
    assert any(f.model == "m" and f.field == "max_input" and f.blocking and "total_context" in f.message
               for f in findings), findings


def test_count_strategy_must_be_known():
    caps = GOOD_CAPS._replace(count_strategy="made_up_strategy")
    findings = gate.check({"m": caps}, _info_for({"m": GOOD_LITELLM}), [], TARGET)
    assert any(f.model == "m" and f.field == "count_strategy" and f.blocking for f in findings), findings


def test_source_url_must_be_nonempty_https():
    for bad_url in ("http://example.com/docs", "", None):
        caps = GOOD_CAPS._replace(source_url=bad_url)
        findings = gate.check({"m": caps}, _info_for({"m": GOOD_LITELLM}), [], TARGET)
        assert any(f.model == "m" and f.field == "source_url" and f.blocking for f in findings), (bad_url, findings)


def test_source_date_must_be_valid_iso():
    caps = GOOD_CAPS._replace(source_date="not-a-date")
    findings = gate.check({"m": caps}, _info_for({"m": GOOD_LITELLM}), [], TARGET)
    assert any(f.model == "m" and f.field == "source_date" and f.blocking for f in findings), findings


def test_source_date_must_not_be_future():
    caps = GOOD_CAPS._replace(source_date="2026-09-01")  # after TARGET (2026-08-10)
    findings = gate.check({"m": caps}, _info_for({"m": GOOD_LITELLM}), [], TARGET)
    assert any(f.model == "m" and f.field == "source_date" and f.blocking for f in findings), findings


def test_nominal_send_output_exceeding_max_output_blocks_no_clamp():
    caps = GOOD_CAPS._replace(max_output=8000)  # below both default nominals (8192, 16384)
    findings = gate.check({"m": caps}, _info_for({"m": {"max_input_tokens": 200000, "max_output_tokens": 8000}}),
                           [], TARGET, send_outputs=(8192, 16384))
    send_output_findings = [f for f in findings if f.model == "m" and f.field == "send_output"]
    assert len(send_output_findings) == 2, findings  # both nominals violate -- no clamping, no dedup
    assert all(f.blocking for f in send_output_findings)
    # the returned caps' max_output must be untouched -- proves no clamping occurred
    assert caps.max_output == 8000


def test_litellm_max_input_greater_than_litellm_blocks():
    caps = GOOD_CAPS._replace(max_input=200000, total_context=200000)
    findings = gate.check({"m": caps}, _info_for({"m": {"max_input_tokens": 100000, "max_output_tokens": 64000}}),
                           [], TARGET)
    assert any(f.model == "m" and f.field == "max_input" and f.blocking for f in findings), findings


def test_litellm_max_output_greater_than_litellm_blocks():
    caps = GOOD_CAPS
    findings = gate.check({"m": caps}, _info_for({"m": {"max_input_tokens": 200000, "max_output_tokens": 32000}}),
                           [], TARGET)
    assert any(f.model == "m" and f.field == "max_output" and f.blocking for f in findings), findings


def test_litellm_max_input_less_than_litellm_warns_not_blocks():
    caps = GOOD_CAPS._replace(max_input=100000, total_context=200000)
    findings = gate.check({"m": caps}, _info_for({"m": {"max_input_tokens": 200000, "max_output_tokens": 64000}}),
                           [], TARGET)
    matches = [f for f in findings if f.model == "m" and f.field == "max_input"]
    assert matches, findings
    assert all(not f.blocking for f in matches), findings


def test_litellm_max_output_less_than_litellm_warns_not_blocks():
    caps = GOOD_CAPS._replace(max_output=32000)
    findings = gate.check({"m": caps}, _info_for({"m": {"max_input_tokens": 200000, "max_output_tokens": 64000}}),
                           [], TARGET, send_outputs=(8192,))
    matches = [f for f in findings if f.model == "m" and f.field == "max_output"]
    assert matches, findings
    assert all(not f.blocking for f in matches), findings


def test_litellm_info_raises_blocks_and_keeps_collecting():
    caps_map = {"bad": GOOD_CAPS, "good": GOOD_CAPS}
    table = {"bad": RuntimeError("model not found"), "good": GOOD_LITELLM}
    findings = gate.check(caps_map, _info_for(table), [], TARGET)
    bad_findings = [f for f in findings if f.model == "bad"]
    good_findings = [f for f in findings if f.model == "good"]
    assert any(f.blocking for f in bad_findings), findings
    assert good_findings == []  # the raise on "bad" must not stop "good" from being checked cleanly


def test_litellm_info_missing_field_blocks():
    caps_map = {"m": GOOD_CAPS}
    findings = gate.check(caps_map, _info_for({"m": {"max_input_tokens": 200000}}), [], TARGET)
    assert any(f.model == "m" and f.blocking for f in findings), findings


def test_reports_all_findings_two_bad_rows_two_findings():
    caps_map = {
        "a": GOOD_CAPS._replace(count_strategy="nonsense"),
        "b": GOOD_CAPS._replace(total_context=100000, max_input=200000),
    }
    litellm_table = {"a": GOOD_LITELLM, "b": {"max_input_tokens": 200000, "max_output_tokens": 64000}}
    findings = gate.check(caps_map, _info_for(litellm_table), [], TARGET)
    models_with_findings = {f.model for f in findings if f.blocking}
    assert models_with_findings == {"a", "b"}, findings  # proves no early return -- both rows surfaced


def test_overrides_param_accepted_but_not_yet_consumed():
    caps_map = {"m": GOOD_CAPS}
    info = _info_for({"m": GOOD_LITELLM})
    with_empty = gate.check(caps_map, info, [], TARGET)
    with_nonempty = gate.check(caps_map, info, [{"model": "m", "field": "max_output", "reason": "ignored for now"}], TARGET)
    assert with_empty == with_nonempty == []


def test_cli_requires_iso_date():
    import subprocess, sys
    from pathlib import Path
    root = Path(__file__).resolve().parents[2]
    p = subprocess.run([sys.executable, str(root / "scripts" / "check_model_windows.py"),
                        "--target-date", "not-a-date"], capture_output=True, text=True)
    assert p.returncode != 0 and "invalid" in p.stderr.lower()
