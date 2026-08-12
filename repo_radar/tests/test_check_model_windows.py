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


def test_count_strategy_unhashable_value_blocks_instead_of_raising():
    # A list is unhashable -- a naive `x not in known_set` membership test raises TypeError
    # instead of yielding a Finding. Must be caught by a type guard and reported, not raised.
    caps_map = {
        "bad": GOOD_CAPS._replace(count_strategy=["not", "a", "string"]),
        "good": GOOD_CAPS,
    }
    findings = gate.check(caps_map, _info_for({"bad": GOOD_LITELLM, "good": GOOD_LITELLM}), [], TARGET)
    bad_findings = [f for f in findings if f.model == "bad" and f.field == "count_strategy"]
    assert bad_findings and all(f.blocking for f in bad_findings), findings
    assert [f for f in findings if f.model == "good"] == []  # collect-all still holds


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


def test_litellm_present_but_malformed_value_blocks_never_raises():
    # A present-but-malformed litellm window value must fail CLOSED with a blocking Finding, never
    # raise (TypeError on a string/container defeats collect-all) and never silently pass. Covers
    # strings, non-numeric containers, booleans, zero/negative, and floats INCLUDING NaN -- for both
    # window fields.
    for bad in ("200000", [], {}, True, 0, -5, float("nan"), 64000.0):
        for field in ("max_input_tokens", "max_output_tokens"):
            info = dict(GOOD_LITELLM)
            info[field] = bad
            findings = gate.check({"m": GOOD_CAPS}, _info_for({"m": info}), [], TARGET)
            litellm_blocks = [f for f in findings
                              if f.model == "m" and f.field == "litellm" and f.blocking]
            assert litellm_blocks, f"{field}={bad!r} must yield a blocking litellm finding, got {findings}"


def test_litellm_nan_does_not_pass_open_and_later_model_still_checked():
    # The dangerous case: NaN makes BOTH `catalog > litellm` and `catalog < litellm` False, so a naive
    # gate returns [] and PASSES malformed drift evidence. It must block; and a later, independently
    # broken model must still be checked (collect-all survives the malformed row).
    caps_map = {"a": GOOD_CAPS, "b": GOOD_CAPS._replace(max_output=70000)}
    litellm = {"a": {"max_input_tokens": float("nan"), "max_output_tokens": float("nan")},
               "b": {"max_input_tokens": 200000, "max_output_tokens": 64000}}
    findings = gate.check(caps_map, _info_for(litellm), [], TARGET)
    assert any(f.model == "a" and f.field == "litellm" and f.blocking for f in findings), findings
    assert any(f.model == "b" and f.field == "max_output" and f.blocking for f in findings), findings


def test_malformed_litellm_finding_is_not_override_clearable():
    # A malformed litellm value is not the max_input/max_output over-report direction, so no override
    # may clear it (fail closed). Even a well-formed override for (m, max_output) must not suppress it.
    ov = [{"model": "m", "field": "max_output", "catalog_value": 64000, "litellm_value": 64000,
           "vendor_url": URL, "verified_at": "2026-08-08", "justification": "test"}]
    info = {"max_input_tokens": 200000, "max_output_tokens": float("nan")}
    findings = gate.check({"m": GOOD_CAPS}, _info_for({"m": info}), ov, TARGET)
    assert any(f.model == "m" and f.field == "litellm" and f.blocking for f in findings), findings


def test_reports_all_findings_two_bad_rows_two_findings():
    caps_map = {
        "a": GOOD_CAPS._replace(count_strategy="nonsense"),
        "b": GOOD_CAPS._replace(total_context=100000, max_input=200000),
    }
    litellm_table = {"a": GOOD_LITELLM, "b": {"max_input_tokens": 200000, "max_output_tokens": 64000}}
    findings = gate.check(caps_map, _info_for(litellm_table), [], TARGET)
    models_with_findings = {f.model for f in findings if f.blocking}
    assert models_with_findings == {"a", "b"}, findings  # proves no early return -- both rows surfaced


# ---------------------------------------------------------------------------
# Task 13: mismatch-bound overrides + source_date freshness (fail closed)
# ---------------------------------------------------------------------------

# A caps row that produces a single max_output directional-compare BLOCK against litellm
# (catalog 65536 > litellm 65535), mirroring the real Gemini drift the overrides clear.
MISMATCH_CAPS = GOOD_CAPS._replace(max_output=65536)
MISMATCH_LITELLM = {"max_input_tokens": 200000, "max_output_tokens": 65535}


def _override(**over):
    """A fully-matching override for the MISMATCH_CAPS max_output block; kwargs mutate one field."""
    base = {
        "model": "m",
        "field": "max_output",
        "catalog_value": 65536,
        "litellm_value": 65535,
        "vendor_url": URL,            # == MISMATCH_CAPS.source_url
        "verified_at": "2026-08-08",  # 2 days before TARGET (2026-08-10) -> within 90
        "justification": "vendor-verified: docs say 65536, litellm bundles a stale 65535",
    }
    base.update(over)
    return base


def _max_output_blocked(findings):
    return any(f.model == "m" and f.field == "max_output" and f.blocking for f in findings)


def test_max_output_directional_block_without_override():
    findings = gate.check({"m": MISMATCH_CAPS}, _info_for({"m": MISMATCH_LITELLM}), [], TARGET)
    assert _max_output_blocked(findings), findings


def test_matching_override_clears_max_output_block():
    findings = gate.check({"m": MISMATCH_CAPS}, _info_for({"m": MISMATCH_LITELLM}), [_override()], TARGET)
    assert findings == [], findings


def test_matching_override_clears_max_input_block():
    caps = GOOD_CAPS._replace(max_input=200000, total_context=200000)
    litellm = {"max_input_tokens": 199999, "max_output_tokens": 64000}  # catalog > litellm -> block
    ov = _override(field="max_input", catalog_value=200000, litellm_value=199999)
    findings = gate.check({"m": caps}, _info_for({"m": litellm}), [ov], TARGET)
    assert findings == [], findings


def test_override_with_changed_catalog_value_does_not_clear():
    ov = _override(catalog_value=99999)  # != actual catalog max_output (65536)
    findings = gate.check({"m": MISMATCH_CAPS}, _info_for({"m": MISMATCH_LITELLM}), [ov], TARGET)
    assert _max_output_blocked(findings), findings


def test_override_with_changed_litellm_value_does_not_clear():
    ov = _override(litellm_value=12345)  # != actual litellm max_output (65535)
    findings = gate.check({"m": MISMATCH_CAPS}, _info_for({"m": MISMATCH_LITELLM}), [ov], TARGET)
    assert _max_output_blocked(findings), findings


def test_override_with_changed_field_does_not_clear():
    ov = _override(field="max_input")  # targets a field with no live mismatch
    findings = gate.check({"m": MISMATCH_CAPS}, _info_for({"m": MISMATCH_LITELLM}), [ov], TARGET)
    assert _max_output_blocked(findings), findings


def test_override_with_wrong_vendor_url_does_not_clear():
    ov = _override(vendor_url="https://not-the-catalog-source.example.com/x")
    findings = gate.check({"m": MISMATCH_CAPS}, _info_for({"m": MISMATCH_LITELLM}), [ov], TARGET)
    assert _max_output_blocked(findings), findings


def test_override_with_expired_verified_at_does_not_clear():
    ov = _override(verified_at="2026-01-01")  # >90 days before TARGET (2026-08-10)
    findings = gate.check({"m": MISMATCH_CAPS}, _info_for({"m": MISMATCH_LITELLM}), [ov], TARGET)
    assert _max_output_blocked(findings), findings


def test_override_with_future_verified_at_does_not_clear():
    ov = _override(verified_at="2026-12-01")  # after TARGET -> negative delta, fail closed
    findings = gate.check({"m": MISMATCH_CAPS}, _info_for({"m": MISMATCH_LITELLM}), [ov], TARGET)
    assert _max_output_blocked(findings), findings


def test_override_with_empty_justification_does_not_clear():
    ov = _override(justification="")
    findings = gate.check({"m": MISMATCH_CAPS}, _info_for({"m": MISMATCH_LITELLM}), [ov], TARGET)
    assert _max_output_blocked(findings), findings


def test_override_with_missing_key_is_malformed_and_blocks():
    ov = _override()
    del ov["justification"]  # missing required key -> malformed
    findings = gate.check({"m": MISMATCH_CAPS}, _info_for({"m": MISMATCH_LITELLM}), [ov], TARGET)
    assert any("malformed override" in f.message and f.blocking for f in findings), findings
    assert _max_output_blocked(findings), findings  # malformed clears nothing


def test_override_with_wrong_type_is_malformed_and_blocks():
    ov = _override(catalog_value="65536")  # str, not int -> malformed
    findings = gate.check({"m": MISMATCH_CAPS}, _info_for({"m": MISMATCH_LITELLM}), [ov], TARGET)
    assert any("malformed override" in f.message and f.blocking for f in findings), findings
    assert _max_output_blocked(findings), findings


def test_override_with_unparseable_verified_at_is_malformed_and_blocks():
    ov = _override(verified_at="not-a-date")
    findings = gate.check({"m": MISMATCH_CAPS}, _info_for({"m": MISMATCH_LITELLM}), [ov], TARGET)
    assert any("malformed override" in f.message and f.blocking for f in findings), findings
    assert _max_output_blocked(findings), findings


def test_override_non_dict_row_is_malformed_and_blocks():
    findings = gate.check({"m": MISMATCH_CAPS}, _info_for({"m": MISMATCH_LITELLM}), ["not-a-dict"], TARGET)
    assert any("malformed override" in f.message and f.blocking for f in findings), findings
    assert _max_output_blocked(findings), findings


def test_duplicate_override_model_field_blocks_and_does_not_clear():
    findings = gate.check({"m": MISMATCH_CAPS}, _info_for({"m": MISMATCH_LITELLM}),
                          [_override(), _override()], TARGET)
    assert any("duplicate" in f.message.lower() and f.blocking for f in findings), findings
    assert _max_output_blocked(findings), findings  # ambiguous -> fail closed, block persists


def test_stale_source_date_blocks():
    stale = GOOD_CAPS._replace(source_date="2026-01-01")  # >90 days before TARGET (2026-08-10)
    findings = gate.check({"m": stale}, _info_for({"m": GOOD_LITELLM}), [], TARGET)
    assert any(f.model == "m" and f.field == "source_date" and f.blocking
               and "stale" in f.message.lower() for f in findings), findings


def test_stale_source_date_not_cleared_by_override_only_by_fresh_date():
    # Row has BOTH a stale source_date AND a max_output directional mismatch; a matching
    # override clears the directional block but must NOT touch the stale source_date block.
    stale = MISMATCH_CAPS._replace(source_date="2026-01-01")
    findings = gate.check({"m": stale}, _info_for({"m": MISMATCH_LITELLM}), [_override()], TARGET)
    assert not _max_output_blocked(findings), findings          # directional cleared
    assert any(f.field == "source_date" and f.blocking for f in findings), findings  # stale remains

    # Refreshing the record's own source_date is the only thing that clears it.
    fresh = MISMATCH_CAPS._replace(source_date="2026-08-08")
    findings2 = gate.check({"m": fresh}, _info_for({"m": MISMATCH_LITELLM}), [_override()], TARGET)
    assert findings2 == [], findings2


def test_override_cannot_clear_send_output_block():
    caps = GOOD_CAPS._replace(max_output=8000)  # below nominals -> send_output block (non-directional)
    litellm = {"max_input_tokens": 200000, "max_output_tokens": 8000}  # matches -> no directional block
    ov = _override(field="max_output", catalog_value=8000, litellm_value=8000)
    findings = gate.check({"m": caps}, _info_for({"m": litellm}), [ov], TARGET, send_outputs=(8192, 16384))
    assert any(f.field == "send_output" and f.blocking for f in findings), findings


def test_override_cannot_clear_count_strategy_block():
    caps = MISMATCH_CAPS._replace(count_strategy="bogus_strategy")
    findings = gate.check({"m": caps}, _info_for({"m": MISMATCH_LITELLM}), [_override()], TARGET)
    assert not _max_output_blocked(findings), findings                     # directional cleared
    assert any(f.field == "count_strategy" and f.blocking for f in findings), findings  # NOT cleared


def test_real_overrides_file_is_eight_wellformed_dicts():
    import json
    from pathlib import Path
    root = Path(__file__).resolve().parents[2]
    data = json.loads((root / "repo_radar" / "model_window_overrides.json").read_text())
    assert isinstance(data, list) and len(data) == 8, data
    required = {"model", "field", "catalog_value", "litellm_value", "vendor_url", "verified_at", "justification"}
    for ov in data:
        assert isinstance(ov, dict) and required <= set(ov), ov
        assert ov["field"] == "max_output", ov
        assert ov["catalog_value"] == 65536 and ov["litellm_value"] == 65535, ov
        assert ov["vendor_url"] == "https://ai.google.dev/gemini-api/docs/models", ov
        assert ov["verified_at"] == "2026-08-08", ov
        assert isinstance(ov["justification"], str) and ov["justification"].strip(), ov
    models = {ov["model"] for ov in data}
    assert len(models) == 8, "override (model, field) pairs must be unique"


def test_cli_requires_iso_date():
    import subprocess, sys
    from pathlib import Path
    root = Path(__file__).resolve().parents[2]
    p = subprocess.run([sys.executable, str(root / "scripts" / "check_model_windows.py"),
                        "--target-date", "not-a-date"], capture_output=True, text=True)
    assert p.returncode != 0 and "invalid" in p.stderr.lower()
