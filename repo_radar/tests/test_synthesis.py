"""Hierarchical synthesis: bounded prompts, full coverage, explicit last-resort truncation."""
import pytest

import repo_radar.llm as llm


@pytest.fixture
def recorder(monkeypatch):
    """Capture every synthesis call instead of hitting an API.

    Each call returns a short stand-in, so batches genuinely shrink between rounds the way a
    real summarising model would.
    """
    calls = []

    def fake_synthesize(full_name, analyses, model=None):
        calls.append(list(analyses))
        return f"SUMMARY[{len(analyses)} parts]", 0.01, (model or "claude-opus-5")

    monkeypatch.setattr(llm, "_synthesize_once", fake_synthesize)
    monkeypatch.setattr(llm, "get_ai_model", lambda: "claude-opus-5")
    return calls


def _tokens(text):
    return llm.count_tokens_accurate(text, "claude-opus-5")


def test_single_small_analysis_is_one_call(recorder):
    text, cost = llm.combine_chunk_analyses("org/repo", ["a short analysis"])
    assert len(recorder) == 1
    assert cost == pytest.approx(0.01)


def test_no_prompt_ever_exceeds_the_budget(recorder, monkeypatch):
    """The actual regression: a repo whose combined analyses blow the context window.

    Mirrors reperio-mobile-app, which produced 1,189,532 tokens against a 1,000,000 limit.
    """
    monkeypatch.setattr(llm, "get_chunking_threshold", lambda model: 50_000)
    analyses = ["word " * 4_000 for _ in range(40)]  # far beyond one request

    llm.combine_chunk_analyses("org/big", analyses)

    assert recorder, "no synthesis happened"
    for batch in recorder:
        prompt = llm._build_synthesis_prompt("org/big", batch)
        budget = llm._synthesis_budget("org/big", "claude-opus-5")
        assert _tokens(prompt) <= budget, (
            f"prompt of {_tokens(prompt)} tokens exceeds the {budget} budget")


def test_every_analysis_reaches_the_synthesis(recorder, monkeypatch):
    """Coverage is the priority: no chunk is silently dropped to make things fit."""
    monkeypatch.setattr(llm, "get_chunking_threshold", lambda model: 50_000)
    analyses = [f"UNIQUE_MARKER_{i} " + "word " * 2_000 for i in range(25)]

    llm.combine_chunk_analyses("org/big", analyses)

    seen = " ".join(part for batch in recorder for part in batch)
    for i in range(25):
        assert f"UNIQUE_MARKER_{i}" in seen, f"analysis {i} never reached a synthesis call"


def test_chunk_order_is_preserved(recorder, monkeypatch):
    monkeypatch.setattr(llm, "get_chunking_threshold", lambda model: 50_000)
    analyses = [f"MARK{i:02d} " + "word " * 2_000 for i in range(20)]

    llm.combine_chunk_analyses("org/big", analyses)

    first_round = [p for p in recorder[0]]
    positions = [int(p.split()[0].removeprefix("MARK")) for p in first_round]
    assert positions == sorted(positions), "batching must keep contiguous, in-order runs"


def test_cost_is_aggregated_across_every_round(recorder, monkeypatch):
    monkeypatch.setattr(llm, "get_chunking_threshold", lambda model: 50_000)
    analyses = ["word " * 4_000 for _ in range(40)]

    _, cost = llm.combine_chunk_analyses("org/big", analyses)

    assert cost == pytest.approx(0.01 * len(recorder)), "every call must be billed"
    assert len(recorder) > 1, "this fixture should require multiple rounds"


def test_recursion_reduces_to_a_single_final_call(recorder, monkeypatch):
    monkeypatch.setattr(llm, "get_chunking_threshold", lambda model: 50_000)
    analyses = ["word " * 4_000 for _ in range(40)]

    llm.combine_chunk_analyses("org/big", analyses)

    assert len(recorder[-1]) >= 1
    assert len(recorder) >= 2, "expected at least one map round plus a final reduce"


def test_single_oversized_analysis_falls_back_to_truncation(monkeypatch, capsys):
    """One analysis bigger than a whole request has nothing to be combined with."""
    calls = []

    def fake_synthesize(full_name, analyses, model=None):
        calls.append(list(analyses))
        return "SUMMARY", 0.01, (model or "claude-opus-5")

    monkeypatch.setattr(llm, "_synthesize_once", fake_synthesize)
    monkeypatch.setattr(llm, "get_ai_model", lambda: "claude-opus-5")
    monkeypatch.setattr(llm, "get_chunking_threshold", lambda model: 40_000)

    llm.combine_chunk_analyses("org/one", ["word " * 60_000])

    assert len(calls) == 1
    assert "truncated by repo-radar" in calls[0][0]
    assert "truncating" in capsys.readouterr().out.lower(), "truncation must be announced"


def test_depth_guard_stops_runaway_recursion(monkeypatch, capsys):
    """A model that never shrinks its input must not recurse forever."""
    calls = []

    def stubborn(full_name, analyses):
        calls.append(list(analyses))
        return " ".join(analyses)  # returns everything it was given — zero reduction

    monkeypatch.setattr(llm, "_synthesize_once",
                        lambda fn, a, m=None: (stubborn(fn, a), 0.01, m or "claude-opus-5"))
    monkeypatch.setattr(llm, "get_ai_model", lambda: "claude-opus-5")
    monkeypatch.setattr(llm, "get_chunking_threshold", lambda model: 50_000)

    text, cost = llm.combine_chunk_analyses("org/big", ["word " * 4_000 for _ in range(30)])

    assert text, "must still return a result"
    assert len(calls) <= llm.SYNTHESIS_MAX_CALLS + 1
    out = capsys.readouterr().out.lower()
    assert "no progress" in out or "maximum" in out, "the bail-out must be explained"


def test_call_budget_is_respected(monkeypatch):
    calls = []
    monkeypatch.setattr(llm, "_synthesize_once",
                        lambda fn, a, m=None: (calls.append(list(a)),
                                               ("S", 0.01, m or "claude-opus-5"))[1])
    monkeypatch.setattr(llm, "get_ai_model", lambda: "claude-opus-5")
    monkeypatch.setattr(llm, "get_chunking_threshold", lambda model: 30_000)

    llm.combine_chunk_analyses("org/big", ["word " * 3_000 for _ in range(60)], max_calls=6)

    # A true ceiling: the final reduction is reserved, not spent on top of the map rounds.
    assert len(calls) <= 6, f"exceeded the call ceiling: {len(calls)} calls"


def test_empty_input_is_handled():
    assert llm.combine_chunk_analyses("org/repo", []) == ("", 0.0)
    assert llm.combine_chunk_analyses("org/repo", ["", "   ", None]) == ("", 0.0)


def test_batching_preserves_contiguity_and_budget():
    analyses = [f"part{i} " + "word " * 500 for i in range(12)]
    batches = llm._batch_by_budget("org/repo", analyses, 4_000, "claude-opus-5")

    assert [a for b in batches for a in b] == analyses, "order/content must be preserved"
    for batch in batches:
        if len(batch) > 1:
            prompt = llm._build_synthesis_prompt("org/repo", batch)
            assert llm.count_tokens_accurate(prompt, "claude-opus-5") <= 4_000


# ── review follow-ups ────────────────────────────────────────────────────────────────


def test_production_sync_uses_the_bounded_combine():
    """Regression for the defect the helper tests could not see.

    Every synthesis test passed while sync.py still built its own unbounded prompt inline and
    called call_llm directly, so combine_chunk_analyses was dead code and the 1,189,532-token
    failure was completely unaffected. Pin the actual production wiring.
    """
    import inspect
    from repo_radar.modes import sync

    src = inspect.getsource(sync)
    assert "combine_chunk_analyses(" in src, "sync must call the bounded combine"
    # The inline concatenation that caused the overflow must not come back.
    assert "combined_prompt +=" not in src, (
        "sync is building a synthesis prompt inline again — that path is unbounded")


def test_injected_synthesize_is_used_and_receives_the_model():
    """sync supplies its own caller for retry/fallback; the helper must use it, not its own."""
    used = []

    def injected(prompt, model):
        used.append((prompt, model))
        return "SUMMARY", 0.02, model

    text, cost = llm.combine_chunk_analyses(
        "org/repo", ["a short analysis"], model="claude-sonnet-5", synthesize=injected)

    assert text == "SUMMARY" and cost == pytest.approx(0.02)
    assert used and used[0][1] == "claude-sonnet-5", "the chosen model must be threaded through"


def test_budget_follows_a_model_fallback(monkeypatch):
    """Budgeting one model while calling another is how a 'bounded' prompt still overflows.

    When the injected caller reports a fallback with a smaller window, later batches must be
    budgeted against the smaller one.
    """
    windows = {"big-model": 100_000, "small-model": 60_000}
    monkeypatch.setattr(llm, "get_chunking_threshold", lambda m: windows.get(m, 20_000))

    seen = []

    def falls_back(prompt, model):
        seen.append((model, llm.count_tokens_accurate(prompt, "small-model")))
        return "SUMMARY " + "word " * 200, 0.01, "small-model"  # served by the fallback

    llm.combine_chunk_analyses(
        "org/repo", ["word " * 3_000 for _ in range(40)],
        model="big-model", synthesize=falls_back)

    assert len(seen) > 1, "expected more than one call for this fixture"
    later_budget = llm._synthesis_budget("org/repo", "small-model")
    for model_used, prompt_tokens in seen[1:]:
        assert prompt_tokens <= later_budget, (
            f"prompt of {prompt_tokens} exceeds the fallback model's {later_budget} budget")


def test_truncation_marker_is_inside_the_requested_budget():
    """Appending the marker after sizing overshoots by the marker's own length."""
    text = "word " * 20_000
    out = llm._truncate_to_tokens(text, 1_000, "claude-opus-5")
    assert llm.count_tokens_accurate(out, "claude-opus-5") <= 1_000
    assert "truncated by repo-radar" in out


def test_batching_accounts_for_the_analysis_part_framing():
    """Counting only analysis text understates the prompt by every wrapper it omits."""
    analyses = ["word " * 300 for _ in range(30)]
    budget = 6_000
    batches = llm._batch_by_budget("org/repo", analyses, budget, "claude-opus-5")
    for batch in batches:
        prompt = llm._build_synthesis_prompt("org/repo", batch)
        assert llm.count_tokens_accurate(prompt, "claude-opus-5") <= budget
