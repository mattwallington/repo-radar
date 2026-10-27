"""Explicit per-model capability catalog (Branch 2). VENDOR DOCS ARE CANONICAL; litellm is only a
release-time drift cross-check. Values re-verified against vendor pages 2026-10-27 (claude-opus-4-6-20260205
is not documented by Anthropic and keeps its older date). total_context == max_input for shared-window
models; the OpenAI 272K-input split family vendor-documents 400,000 total (llm.py:71). total_context feeds
acceptance_budget only for anthropic_api models; for local models it is documentation + the
max_input<=total_context invariant."""
import math
from collections import namedtuple
ModelCaps = namedtuple("ModelCaps", "total_context max_input max_output count_strategy source_url source_date")
_ANT = "https://platform.claude.com/docs/en/about-claude/models/overview"
_GEM = "https://ai.google.dev/gemini-api/docs/models"
_OPE = "https://developers.openai.com/api/docs/models"
MODEL_CAPS = {
    "claude-sonnet-5-5": ModelCaps(1000000, 1000000, 128000, "anthropic_api", _ANT, "2026-10-27"),
    "claude-opus-5-5": ModelCaps(1000000, 1000000, 128000, "anthropic_api", _ANT, "2026-10-27"),
    "claude-haiku-5-5": ModelCaps(1000000, 1000000, 128000, "anthropic_api", _ANT, "2026-10-27"),
    "claude-fable-5-1": ModelCaps(1000000, 1000000, 128000, "anthropic_api", _ANT, "2026-10-27"),
    "claude-opus-5": ModelCaps(1000000, 1000000, 128000, "anthropic_api", _ANT, "2026-10-27"),
    "claude-sonnet-5": ModelCaps(1000000, 1000000, 128000, "anthropic_api", _ANT, "2026-10-27"),
    "claude-opus-4-8": ModelCaps(1000000, 1000000, 128000, "anthropic_api", _ANT, "2026-10-27"),
    "claude-opus-4-7": ModelCaps(1000000, 1000000, 128000, "anthropic_api", _ANT, "2026-10-27"),
    "claude-fable-5": ModelCaps(1000000, 1000000, 128000, "anthropic_api", _ANT, "2026-10-27"),
    "claude-opus-4-6": ModelCaps(1000000, 1000000, 128000, "anthropic_api", _ANT, "2026-10-27"),
    "claude-opus-4-6-20260205": ModelCaps(1000000, 1000000, 128000, "anthropic_api", _ANT, "2026-08-08"),
    "claude-sonnet-4-6": ModelCaps(1000000, 1000000, 64000, "anthropic_api", _ANT, "2026-10-27"),
    "claude-opus-4-5": ModelCaps(200000, 200000, 64000, "anthropic_api", _ANT, "2026-10-27"),
    "claude-opus-4-5-20251101": ModelCaps(200000, 200000, 64000, "anthropic_api", _ANT, "2026-10-27"),
    "claude-sonnet-4-5": ModelCaps(200000, 200000, 64000, "anthropic_api", _ANT, "2026-10-27"),
    "claude-sonnet-4-5-20250929": ModelCaps(200000, 200000, 64000, "anthropic_api", _ANT, "2026-10-27"),
    "claude-haiku-4-5": ModelCaps(200000, 200000, 64000, "anthropic_api", _ANT, "2026-10-27"),
    "claude-haiku-4-5-20251001": ModelCaps(200000, 200000, 64000, "anthropic_api", _ANT, "2026-10-27"),
    "gemini/gemini-3.8-flash": ModelCaps(1048576, 1048576, 65536, "local", _GEM, "2026-10-27"),
    "gemini/gemini-3.5-flash-lite": ModelCaps(1048576, 1048576, 65536, "local", _GEM, "2026-10-27"),
    # One shared window for input, thinking and output; acceptance_budget subtracts the requested
    # output. 65,536 is the synchronous output cap.
    "gemini/gemini-4-argon": ModelCaps(1048576, 1048576, 65536, "local", _GEM, "2026-10-27"),
    "gemini/gemini-3.6-flash": ModelCaps(1048576, 1048576, 65536, "local", _GEM, "2026-10-27"),
    "gemini/gemini-3.5-flash": ModelCaps(1048576, 1048576, 65536, "local", _GEM, "2026-10-27"),
    "gemini/gemini-3.1-pro-preview": ModelCaps(1048576, 1048576, 65536, "local", _GEM, "2026-10-27"),
    "gemini/gemini-3.1-flash-lite": ModelCaps(1048576, 1048576, 65536, "local", _GEM, "2026-10-27"),
    "gemini/gemini-3-flash-preview": ModelCaps(1048576, 1048576, 65536, "local", _GEM, "2026-10-27"),
    "gemini/gemini-2.5-pro": ModelCaps(1048576, 1048576, 65536, "local", _GEM, "2026-10-27"),
    "gemini/gemini-2.5-flash": ModelCaps(1048576, 1048576, 65536, "local", _GEM, "2026-10-27"),
    "gemini/gemini-2.5-flash-lite": ModelCaps(1048576, 1048576, 65536, "local", _GEM, "2026-10-27"),
    "gemini/gemini-pro-latest": ModelCaps(1048576, 1048576, 65536, "local", _GEM, "2026-10-27"),
    "gemini/gemini-flash-latest": ModelCaps(1048576, 1048576, 65536, "local", _GEM, "2026-10-27"),
    "gemini/gemini-flash-lite-latest": ModelCaps(1048576, 1048576, 65536, "local", _GEM, "2026-10-27"),
    "gpt-6.1-sol": ModelCaps(1050000, 922000, 128000, "local", _OPE, "2026-10-27"),
    "gpt-6.1-terra": ModelCaps(1050000, 922000, 128000, "local", _OPE, "2026-10-27"),
    "gpt-6-luna": ModelCaps(1050000, 922000, 128000, "local", _OPE, "2026-10-27"),
    "gpt-6-astra": ModelCaps(1050000, 922000, 128000, "local", _OPE, "2026-10-27"),
    "gpt-6-sol": ModelCaps(1050000, 922000, 128000, "local", _OPE, "2026-10-27"),
    "gpt-5.6-sol": ModelCaps(1050000, 922000, 128000, "local", _OPE, "2026-10-27"),
    "gpt-5.6-terra": ModelCaps(1050000, 922000, 128000, "local", _OPE, "2026-10-27"),
    "gpt-5.6-luna": ModelCaps(1050000, 922000, 128000, "local", _OPE, "2026-10-27"),
    "gpt-5.5": ModelCaps(1050000, 1050000, 128000, "local", _OPE, "2026-10-27"),
    "gpt-5.5-pro": ModelCaps(1050000, 1050000, 128000, "local", _OPE, "2026-10-27"),
    "gpt-5.4": ModelCaps(1050000, 1050000, 128000, "local", _OPE, "2026-10-27"),
    "gpt-5.4-pro": ModelCaps(1050000, 1050000, 128000, "local", _OPE, "2026-10-27"),
    "gpt-5.4-mini": ModelCaps(400000, 272000, 128000, "local", _OPE, "2026-10-27"),
    "gpt-5.4-nano": ModelCaps(400000, 272000, 128000, "local", _OPE, "2026-10-27"),
    "gpt-5.3-codex": ModelCaps(400000, 272000, 128000, "local", _OPE, "2026-10-27"),
    "gpt-5.2": ModelCaps(400000, 272000, 128000, "local", _OPE, "2026-10-27"),
    "gpt-5.2-pro": ModelCaps(400000, 272000, 128000, "local", _OPE, "2026-10-27"),
    "gpt-5.1": ModelCaps(400000, 272000, 128000, "local", _OPE, "2026-10-27"),
    "gpt-5": ModelCaps(400000, 272000, 128000, "local", _OPE, "2026-10-27"),
    "gpt-5-mini": ModelCaps(400000, 272000, 128000, "local", _OPE, "2026-10-27"),
    "gpt-5-nano": ModelCaps(400000, 272000, 128000, "local", _OPE, "2026-10-27"),
    "gpt-4.1": ModelCaps(1047576, 1047576, 32768, "local", _OPE, "2026-10-27"),
    "gpt-4.1-mini": ModelCaps(1047576, 1047576, 32768, "local", _OPE, "2026-10-27"),
    "gpt-4o": ModelCaps(128000, 128000, 16384, "local", _OPE, "2026-10-27"),
    "gpt-4o-mini": ModelCaps(128000, 128000, 16384, "local", _OPE, "2026-10-27"),
    "o3": ModelCaps(200000, 200000, 100000, "local", _OPE, "2026-10-27"),
    "o3-pro": ModelCaps(200000, 200000, 100000, "local", _OPE, "2026-10-27"),
}
HEADROOM_FRACTION = 0.01
def get_caps(model): return MODEL_CAPS.get(model)
def is_known_model(model): return model in MODEL_CAPS
def acceptance_budget(model, requested_output):
    caps = MODEL_CAPS[model]
    ceiling = min(caps.max_input, caps.total_context - requested_output)
    return ceiling - math.ceil(HEADROOM_FRACTION * ceiling)
