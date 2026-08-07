import importlib.metadata as md
import litellm                       # mandatory: fail if absent
from repo_radar import llm

def test_litellm_is_exactly_1_93_0():
    assert md.version("litellm") == "1.93.0", md.version("litellm")

def test_every_known_model_resolves_on_litellm_1_93():
    # Collect EVERY mismatch, don't fail on the first. A per-iteration assert stops at the first
    # bad row and hides the rest — that is exactly how gpt-5.4-nano stayed wrong while gpt-5.4-mini
    # (which sorts first) absorbed the only failure. This table stores INPUT windows: the former
    # gpt-5.3-codex carve-out compared the vendor's TOTAL context against litellm's input window
    # (400K total - 128K output = litellm's 272K), so there are no exemptions.
    problems = []
    for mid, ctx in llm.KNOWN_LIMITS.items():
        try:
            info = litellm.get_model_info(mid)      # raises if the model is unknown to litellm
        except Exception as exc:
            problems.append(f"{mid}: not resolvable on litellm ({exc})")
            continue
        provider = info.get("litellm_provider")
        if provider != llm.provider_for_model(mid):
            problems.append(f"{mid}: provider {provider!r} != {llm.provider_for_model(mid)!r}")
        if info.get("mode") not in ("chat", "responses"):
            problems.append(f"{mid}: mode {info.get('mode')!r} not chat/responses")
        if info.get("max_input_tokens") != ctx:
            problems.append(f"{mid}: table {ctx} != litellm max_input_tokens "
                            f"{info.get('max_input_tokens')}")
    assert not problems, "KNOWN_LIMITS diverged from litellm 1.93.0:\n  " + "\n  ".join(problems)
