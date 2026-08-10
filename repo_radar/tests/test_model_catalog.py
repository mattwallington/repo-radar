import math
import repo_radar.model_catalog as mc
def test_record_invariants():
    for m, c in mc.MODEL_CAPS.items():
        for v in (c.total_context, c.max_input, c.max_output):
            assert isinstance(v, int) and not isinstance(v, bool) and v > 0, m
        assert c.max_input <= c.total_context and c.max_output <= c.total_context, m
        assert c.count_strategy in ("anthropic_api", "local") and c.source_url.startswith("https://"), m
def test_openai_split_family_is_vendor_exact():
    for m in ("gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.3-codex"):
        assert (mc.get_caps(m).total_context, mc.get_caps(m).max_input, mc.get_caps(m).max_output) == (400000, 272000, 128000), m
def test_shared_window_models_total_equals_max_input():
    for m in ("claude-opus-5", "gpt-4o", "gpt-4.1", "gemini/gemini-3.6-flash", "o3"):
        assert mc.get_caps(m).total_context == mc.get_caps(m).max_input, m
def test_unknown_absent():
    assert mc.is_known_model("no-such") is False and mc.get_caps("no-such") is None
def test_budget_subtracts_requested_output_and_1pct():
    ceiling = min(1_000_000, 1_000_000 - 8192)
    assert mc.acceptance_budget("claude-opus-5", 8192) == ceiling - math.ceil(0.01 * ceiling)
    assert mc.acceptance_budget("claude-opus-5", 8192) > 900_000
def test_gpt_4_turbo_removed_and_every_model_serves_16384():
    assert mc.get_caps("gpt-4-turbo") is None
    assert all(c.max_output >= 16384 for c in mc.MODEL_CAPS.values())
