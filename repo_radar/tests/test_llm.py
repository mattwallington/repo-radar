from repo_radar.llm import (
    get_model_context_window,
    get_chunking_threshold,
    get_fallback_model,
    chunk_repo_files,
    RateLimitTracker,
)


def test_known_model_context_window():
    assert get_model_context_window("claude-sonnet-4-6-1m") == 1_000_000
    assert get_model_context_window("gpt-4o") == 128_000


def test_unknown_model_gets_default():
    assert get_model_context_window("unknown-model") == 128_000


def test_chunking_threshold_is_75_percent():
    window = get_model_context_window("gpt-4o")
    threshold = get_chunking_threshold("gpt-4o")
    assert threshold == int(window * 0.75)


def test_fallback_model_chain():
    first = "gemini/gemini-3-pro-preview"
    second = get_fallback_model(first)
    assert second == "gemini/gemini-3-flash-preview"


def test_fallback_returns_none_at_end():
    last = "gemini/gemini-2.0-flash-001"
    assert get_fallback_model(last) is None


def test_fallback_unknown_returns_first():
    result = get_fallback_model("unknown-model")
    assert result == "gemini/gemini-3-pro-preview"


def test_chunk_repo_files_small_repo():
    files = [{"path": "a.py", "content": "x" * 100, "size": 100}]
    chunks = chunk_repo_files(files, "gpt-4o")
    assert len(chunks) == 1


def test_rate_limit_tracker_initial_state():
    tracker = RateLimitTracker()
    assert tracker.should_wait() is False
    assert tracker.get_wait_time() == 0
    assert "Unknown" in tracker.get_status_string()
