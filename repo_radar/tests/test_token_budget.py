"""Conservative token budgeting for Claude 4.7+.

litellm bundles one Anthropic tokenizer for every Claude generation, so it counts 4.7+ text with
the older (4.5/4.6) tokenizer and UNDERCOUNTS by ~1.6x. Applying the normal 75% window margin to
an undercounted number let 1M-window Claude prompts overflow (observed: our 745,509 -> Anthropic's
1,189,532 -> rejected against the 1,000,000 ceiling). These tests pin the stop-gap: a conservative
budget count distinct from the accurate count, applied only to the affected models, so no emitted
prompt exceeds its budget.
"""
import math

import repo_radar.llm as llm

NEW = ["claude-opus-4-7", "claude-opus-4-8", "claude-fable-5", "claude-sonnet-5", "claude-opus-5"]
UNPENALIZED = ["claude-opus-4-5", "claude-opus-4-6", "claude-sonnet-4-6",
               "gemini/gemini-3.6-flash", "gpt-5.4", "gpt-5.4-mini"]

CODE = "def handler(request):\n    return {'ok': True, 'items': [i for i in range(10)]}\n"


# ── the counter itself ───────────────────────────────────────────────────────────────────

def test_budget_count_inflates_only_new_tokenizer_claude():
    text = CODE * 200
    for model in NEW:
        bc = llm.count_tokens_for_budget(text, model)
        assert bc.count == math.ceil(bc.raw * llm.CLAUDE_UNDERCOUNT_FACTOR)
        assert bc.count > bc.raw, model
        assert bc.strategy == "claude-4.7+-conservative" and bc.factor == llm.CLAUDE_UNDERCOUNT_FACTOR


def test_budget_count_leaves_accurate_tokenizers_untouched():
    text = CODE * 200
    for model in UNPENALIZED:
        bc = llm.count_tokens_for_budget(text, model)
        assert bc.count == bc.raw == llm.count_tokens_accurate(text, model), model
        assert bc.strategy == "litellm" and bc.factor == 1.0


def test_accurate_count_is_never_inflated():
    """Displays, progress, and cost reasoning read count_tokens_accurate — it must stay RAW."""
    text = CODE * 300
    for model in NEW:
        assert llm.count_tokens_for_budget(text, model).raw == llm.count_tokens_accurate(text, model)


def test_factor_covers_the_observed_worst_case():
    # Three production failures ran 1.596x, 1.600x, 1.617x below the server count.
    assert llm.CLAUDE_UNDERCOUNT_FACTOR >= 1.617
