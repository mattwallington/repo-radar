import importlib.metadata as md
import litellm                       # mandatory: fail if absent

def test_litellm_is_exactly_the_pinned_version():
    from pathlib import Path
    req = (Path(__file__).resolve().parents[2] / "requirements.txt").read_text()
    pin = next(l.split("==", 1)[1].strip() for l in req.splitlines() if l.startswith("litellm=="))
    assert md.version("litellm") == pin, (md.version("litellm"), pin)

# Removed test_every_known_model_resolves_on_pinned_litellm: it read litellm's downloaded model map, not the pinned one, so it failed offline (gpt-6.1-terra); offline sends are covered in test_llm.
