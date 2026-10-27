import importlib.metadata as md
import litellm                       # mandatory: fail if absent
from repo_radar import llm
from repo_radar import model_catalog

def test_litellm_is_exactly_the_pinned_version():
    from pathlib import Path
    req = (Path(__file__).resolve().parents[2] / "requirements.txt").read_text()
    pin = next(l.split("==", 1)[1].strip() for l in req.splitlines() if l.startswith("litellm=="))
    assert md.version("litellm") == pin, (md.version("litellm"), pin)

def test_every_known_model_resolves_on_pinned_litellm():
    # Collect EVERY mismatch, don't fail on the first. A per-iteration assert stops at the first
    # bad row and hides the rest — that is exactly how gpt-5.4-nano stayed wrong while gpt-5.4-mini
    # (which sorts first) absorbed the only failure. This is a RESOLVABILITY check only — window
    # validation (max_input_tokens == ctx) is the Task 12 acceptance-budget gate's job, not this
    # drift check's; MODEL_CAPS windows are vendor-doc sourced and litellm's own numbers legitimately
    # diverge from them (that's the whole reason MODEL_CAPS exists instead of trusting litellm).
    problems = []
    for mid in model_catalog.MODEL_CAPS:
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
    assert not problems, "MODEL_CAPS diverged from the pinned litellm:\n  " + "\n  ".join(problems)
