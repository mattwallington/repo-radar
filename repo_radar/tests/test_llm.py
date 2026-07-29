from repo_radar import llm
from repo_radar.llm import (
    get_model_context_window,
    get_chunking_threshold,
    get_fallback_model,
    chunk_repo_files,
    RateLimitTracker,
)


def test_known_model_context_window():
    assert get_model_context_window("claude-sonnet-4-6") == 1_000_000
    assert get_model_context_window("claude-opus-4-6") == 1_000_000
    assert get_model_context_window("gpt-4o") == 128_000
    assert get_model_context_window("gpt-5.4") == 1_050_000
    assert get_model_context_window("o3") == 200_000
    assert get_model_context_window("gemini/gemini-3.1-pro-preview") == 1_048_576
    # 272K INPUT, not the 400K total context: OpenAI documents 400K total with 128K max output,
    # and 400_000 - 128_000 == 272_000, which is what litellm reports as max_input_tokens. This
    # table stores input windows, so 400_000 was the total misfiled as an input limit.
    assert get_model_context_window("gpt-5.3-codex") == 272_000
    assert get_model_context_window("claude-sonnet-5") == 1_000_000


def test_unknown_model_gets_default():
    assert get_model_context_window("unknown-model") == 128_000


def test_chunking_threshold_is_75_percent():
    window = get_model_context_window("gpt-4o")
    threshold = get_chunking_threshold("gpt-4o")
    assert threshold == int(window * 0.75)


def test_fallback_model_chain():
    first = "gemini/gemini-3.5-flash"
    second = get_fallback_model(first)
    assert second == "gemini/gemini-3.1-flash-lite"


def test_fallback_returns_none_at_end():
    last = "gemini/gemini-2.5-flash-lite"
    assert get_fallback_model(last) is None


def test_fallback_unknown_gemini_shaped_returns_chain_head():
    # Unknown but Gemini-shaped model names still get the chain head; only
    # non-Gemini models are guarded to None (see test_fallback_guard_non_gemini_returns_none).
    assert get_fallback_model("gemini/gemini-99") == "gemini/gemini-3.5-flash"


def test_chunk_repo_files_small_repo():
    files = [{"path": "a.py", "content": "x" * 100, "size": 100}]
    chunks = chunk_repo_files(files, "gpt-4o")
    assert len(chunks) == 1


def test_rate_limit_tracker_initial_state():
    tracker = RateLimitTracker()
    assert tracker.should_wait() is False
    assert tracker.get_wait_time() == 0
    assert "Unknown" in tracker.get_status_string()


def test_default_model():
    assert llm.DEFAULT_MODEL == 'claude-sonnet-5'
    assert llm.DEFAULT_MODEL in llm.KNOWN_LIMITS


def test_provider_for_model():
    assert llm.provider_for_model('gemini/gemini-3.5-flash') == 'gemini'
    assert llm.provider_for_model('claude-sonnet-5') == 'anthropic'
    assert llm.provider_for_model('anthropic/claude-opus-4-8') == 'anthropic'
    assert llm.provider_for_model('gpt-5.6-terra') == 'openai'
    assert llm.provider_for_model('o3') == 'openai'
    assert llm.provider_for_model('o4-mini') == 'openai'
    assert llm.provider_for_model('gpt-5.3-codex') == 'openai'
    assert llm.provider_for_model('chatgpt-4o-latest') == 'openai'
    assert llm.provider_for_model('chatgpt/foo') == 'openai'
    assert llm.provider_for_model('mystery-model') is None
    assert llm.provider_for_model('') is None


def test_migrate_model_every_row_and_passthrough():
    for old, new in llm.MODEL_MIGRATIONS.items():
        assert llm.migrate_model(old) == new, old
    assert llm.migrate_model('claude-sonnet-5') == 'claude-sonnet-5'
    assert llm.migrate_model(llm.DEFAULT_MODEL) == llm.DEFAULT_MODEL


def test_invariants():
    known = set(llm.KNOWN_LIMITS)
    keys = set(llm.MODEL_MIGRATIONS)
    targets = set(llm.MODEL_MIGRATIONS.values())
    assert targets <= known, targets - known                 # inv 2
    assert keys.isdisjoint(known), keys & known              # inv 3
    for old, new in llm.MODEL_MIGRATIONS.items():             # inv 4
        assert llm.provider_for_model(old) == llm.provider_for_model(new), old


def test_fallback_guard_non_gemini_returns_none():
    assert llm.get_fallback_model('claude-sonnet-5') is None
    assert llm.get_fallback_model('o3') is None
    assert llm.get_fallback_model('gpt-5.6-terra') is None


def test_fallback_chain_gemini():
    chain = llm.GEMINI_FALLBACK_CHAIN
    assert chain[0] == 'gemini/gemini-3.5-flash'
    for i in range(len(chain) - 1):
        assert llm.get_fallback_model(chain[i]) == chain[i + 1]
    assert llm.get_fallback_model(chain[-1]) is None


def test_get_ai_model_migrates(monkeypatch):
    monkeypatch.setenv('AI_MODEL', 'gpt-5.2-codex')
    assert llm.get_ai_model() == 'gpt-5.3-codex'
    monkeypatch.delenv('AI_MODEL', raising=False)
    assert llm.get_ai_model() == llm.DEFAULT_MODEL


def test_needs_responses_api_gated_on_openai_provider():
    # An unknown OpenAI codex/pro variant still routes through the Responses API.
    assert llm.provider_for_model('gpt-6-codex') == 'openai'
    assert llm._needs_responses_api('gpt-6-codex') is True
    # A non-OpenAI id whose NAME merely contains "-pro"/"-codex" must never be
    # misrouted to OpenAI's Responses API — the route must agree with the
    # centralized provider classifier (Codex Finding 2, provider/route invariant).
    for m in ('gemini-future-pro', 'claude-future-pro', 'gemini/gemini-9-pro'):
        assert llm.provider_for_model(m) != 'openai', m
        assert llm._needs_responses_api(m) is False, m
