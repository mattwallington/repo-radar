import importlib.metadata as md
import litellm                       # mandatory: fail if absent
from repo_radar import llm

def test_litellm_is_exactly_1_93_0():
    assert md.version("litellm") == "1.93.0", md.version("litellm")

def test_every_known_model_resolves_on_litellm_1_93():
    for mid, ctx in llm.KNOWN_LIMITS.items():
        info = litellm.get_model_info(mid)          # raises if unknown -> test fails loudly
        assert info.get("litellm_provider") == llm.provider_for_model(mid), (mid, info.get("litellm_provider"))
        assert info.get("mode") in ("chat", "responses"), (mid, info.get("mode"))
        # No exemptions. The former gpt-5.3-codex carve-out ("vendor 400K != litellm 272K")
        # was comparing the vendor's TOTAL context against litellm's INPUT window; 400K total
        # minus 128K max output is exactly litellm's 272K, and this table stores input windows.
        assert info.get("max_input_tokens") == ctx, (mid, info.get("max_input_tokens"), ctx)
