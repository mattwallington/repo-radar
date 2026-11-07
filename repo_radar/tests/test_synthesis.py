"""Hierarchical synthesis (the legacy full generator's): bounded prompts, full coverage, explicit
last-resort truncation. Every case drives the supported API: an explicit counting session and the
caller's own synthesis callback."""
import pytest

import repo_radar.llm as llm
from repo_radar.preflight import PreflightResult


class LocalSession:
    """The counting session as a local-only provider (Gemini) gives it: never authoritative, so the
    driver plans from its own local estimate."""

    def count(self, model, prompt, requested_output):
        return PreflightResult(None, False, "local estimate")


class TokenSession:
    """An authoritative session that counts with the local tokenizer."""

    def count(self, model, prompt, requested_output):
        return PreflightResult(llm.count_tokens_accurate(prompt, "claude-opus-5"), True)


def combine(full_name, analyses, synthesize, model="claude-opus-5", session=None, **kw):
    return llm.combine_chunk_analyses(full_name, analyses, model=model, synthesize=synthesize,
                                      session=session or LocalSession(), **kw)


def parts_of(prompt):
    """The analyses a synthesis prompt carries, in order."""
    return [p.split("\n", 1)[1].rstrip("\n") for p in prompt.split("\n--- Analysis Part ")[1:]]


@pytest.fixture
def recorder():
    """Capture every synthesis prompt instead of hitting an API.

    Each call returns a short stand-in, so batches genuinely shrink between rounds the way a
    real summarising model would.
    """
    def synthesize(prompt, model):
        synthesize.calls.append(prompt)
        return f"SUMMARY[{len(parts_of(prompt))} parts]", 0.01, model
    synthesize.calls = []
    return synthesize


def _tokens(text):
    return llm.count_tokens_accurate(text, "claude-opus-5")


def test_single_small_analysis_is_one_call(recorder):
    text, cost = combine("org/repo", ["a short analysis"], recorder)
    assert len(recorder.calls) == 1
    assert cost == pytest.approx(0.01)


def test_no_prompt_ever_exceeds_the_budget(recorder, monkeypatch):
    """The actual regression: a repo whose combined analyses blow the context window.

    Mirrors reperio-mobile-app, which produced 1,189,532 tokens against a 1,000,000 limit.
    """
    monkeypatch.setattr(llm, "get_chunking_threshold", lambda model: 50_000)
    analyses = ["word " * 4_000 for _ in range(40)]  # far beyond one request

    combine("org/big", analyses, recorder)

    assert recorder.calls, "no synthesis happened"
    budget = llm._synthesis_budget("org/big", "claude-opus-5")
    for prompt in recorder.calls:
        assert _tokens(prompt) <= budget, (
            f"prompt of {_tokens(prompt)} tokens exceeds the {budget} budget")


def test_every_analysis_reaches_the_synthesis(recorder, monkeypatch):
    """Coverage is the priority: no chunk is silently dropped to make things fit."""
    monkeypatch.setattr(llm, "get_chunking_threshold", lambda model: 50_000)
    analyses = [f"UNIQUE_MARKER_{i} " + "word " * 2_000 for i in range(25)]

    combine("org/big", analyses, recorder)

    seen = " ".join(recorder.calls)
    for i in range(25):
        assert f"UNIQUE_MARKER_{i}" in seen, f"analysis {i} never reached a synthesis call"


def test_chunk_order_is_preserved(recorder, monkeypatch):
    monkeypatch.setattr(llm, "get_chunking_threshold", lambda model: 50_000)
    analyses = [f"MARK{i:02d} " + "word " * 2_000 for i in range(20)]

    combine("org/big", analyses, recorder)

    positions = [int(p.split()[0].removeprefix("MARK")) for p in parts_of(recorder.calls[0])]
    assert len(positions) > 1 and positions == sorted(positions), "batching must keep contiguous, in-order runs"


def test_cost_is_aggregated_across_every_round(recorder, monkeypatch):
    monkeypatch.setattr(llm, "get_chunking_threshold", lambda model: 50_000)
    analyses = ["word " * 4_000 for _ in range(40)]

    _, cost = combine("org/big", analyses, recorder)

    assert cost == pytest.approx(0.01 * len(recorder.calls)), "every call must be billed"
    assert len(recorder.calls) > 1, "this fixture should require multiple rounds"


def test_recursion_reduces_to_a_single_final_call(recorder, monkeypatch):
    monkeypatch.setattr(llm, "get_chunking_threshold", lambda model: 50_000)
    analyses = ["word " * 4_000 for _ in range(40)]

    text, _ = combine("org/big", analyses, recorder)

    assert text == f"SUMMARY[{len(parts_of(recorder.calls[-1]))} parts]"
    assert len(recorder.calls) >= 2, "expected at least one map round plus a final reduce"


def test_single_oversized_analysis_falls_back_to_truncation(monkeypatch):
    """One analysis bigger than a whole request has nothing to be combined with."""
    monkeypatch.setattr(llm, "acceptance_budget", lambda model, output: 40_000)
    calls = []

    def synthesize(prompt, model):
        calls.append(prompt)
        return "SUMMARY", 0.01, model

    combine("org/one", ["word " * 60_000], synthesize, session=TokenSession())

    assert len(calls) == 1
    assert "truncated: ~" in calls[0], "the truncation is marked in what the model reads"
    assert _tokens(calls[0]) <= 40_000


def test_depth_guard_stops_runaway_recursion(monkeypatch, capsys):
    """A model that never shrinks its input must not recurse forever."""
    calls = []

    def stubborn(prompt, model):
        calls.append(prompt)
        return " ".join(parts_of(prompt)), 0.01, model  # returns everything it was given — zero reduction

    monkeypatch.setattr(llm, "get_chunking_threshold", lambda model: 50_000)

    text, cost = combine("org/big", ["word " * 4_000 for _ in range(30)], stubborn)

    assert text, "must still return a result"
    assert len(calls) <= llm.SYNTHESIS_MAX_CALLS + 1
    out = capsys.readouterr().out.lower()
    assert "no progress" in out or "maximum" in out, "the bail-out must be explained"


def test_call_budget_is_respected(monkeypatch):
    calls = []
    monkeypatch.setattr(llm, "get_chunking_threshold", lambda model: 30_000)

    combine("org/big", ["word " * 3_000 for _ in range(60)],
            lambda prompt, model: (calls.append(prompt), ("S", 0.01, model))[1], max_calls=6)

    # A true ceiling: the final reduction is reserved, not spent on top of the map rounds.
    assert len(calls) <= 6, f"exceeded the call ceiling: {len(calls)} calls"


def test_empty_input_is_handled(recorder):
    assert combine("org/repo", [], recorder) == ("", 0.0)
    assert combine("org/repo", ["", "   ", None], recorder) == ("", 0.0)
    assert not recorder.calls


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

    text, cost = combine("org/repo", ["a short analysis"], injected, model="claude-sonnet-5")

    assert text == "SUMMARY" and cost == pytest.approx(0.02)
    assert used and used[0][1] == "claude-sonnet-5", "the chosen model must be threaded through"


def test_budget_follows_a_model_fallback(monkeypatch):
    """Budgeting one model while calling another is how a 'bounded' prompt still overflows.

    When the injected caller reports a fallback with a smaller window, later batches must be
    budgeted against the smaller one.
    """
    windows = {"big-model": 100_000, "small-model": 60_000}
    monkeypatch.setattr(llm, "get_chunking_threshold", lambda m: windows.get(m, 20_000))
    monkeypatch.setattr(llm, "acceptance_budget", lambda m, out: 10**9)   # fictional models; counts are local

    seen = []

    def falls_back(prompt, model):
        seen.append((model, llm.count_tokens_accurate(prompt, "small-model")))
        return "SUMMARY " + "word " * 200, 0.01, "small-model"  # served by the fallback

    combine("org/repo", ["word " * 3_000 for _ in range(40)], falls_back, model="big-model")

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


# ── second review round ──────────────────────────────────────────────────────────────


def test_budget_is_sized_for_the_smallest_model_in_the_fallback_chain(monkeypatch):
    """Rebudgeting AFTER a call is too late.

    The caller's retry re-sends the SAME prompt to the fallback model, so a prompt sized for
    the larger window overflows the instant the fallback serves it. Size for the smallest
    candidate up front.
    """
    windows = {"big": 400_000, "small": 60_000}
    monkeypatch.setattr(llm, "get_chunking_threshold", lambda m: windows.get(m, 60_000))
    monkeypatch.setattr(llm, "acceptance_budget", lambda m, out: 10**9)   # fictional models; counts are local
    monkeypatch.setattr(llm, "get_fallback_model",
                        lambda m: "small" if m == "big" else None)

    seen = []

    def falls_back_on_the_first_call(prompt, model):
        # Mirrors sync.py: the retry swaps the model but re-sends the same prompt.
        seen.append(llm.count_tokens_accurate(prompt, "small"))
        return "SUMMARY " + "word " * 100, 0.01, "small"

    combine("org/repo", ["word " * 4_000 for _ in range(30)], falls_back_on_the_first_call, model="big")

    small_budget = llm._synthesis_budget("org/repo", "small")
    assert seen, "no calls made"
    assert seen[0] <= small_budget, (
        f"the FIRST prompt was {seen[0]} tokens, over the fallback model's {small_budget} "
        f"budget — it was sized for the larger window")


def test_max_calls_is_enforced_after_rebatching(monkeypatch):
    """Re-batching per call can produce more calls than the round's estimate.

    A budget that shrinks mid-round makes smaller batches, so a once-per-round check can be
    overrun. The ceiling must hold per call.
    """
    calls = []
    shrink = {"n": 0}

    def shrinking(prompt, model):
        calls.append(1)
        shrink["n"] += 1
        # Every call reports a smaller-window model, so batches keep getting smaller.
        return "SUMMARY " + "word " * 500, 0.01, f"model-{shrink['n']}"

    def threshold(m):
        if m.startswith("model-"):
            return max(40_000 - int(m.split("-")[1]) * 3_000, 20_000)
        return 60_000
    monkeypatch.setattr(llm, "get_chunking_threshold", threshold)
    monkeypatch.setattr(llm, "acceptance_budget", lambda m, out: 10**9)   # fictional models; counts are local
    monkeypatch.setattr(llm, "get_fallback_model", lambda m: None)

    combine("org/repo", ["word " * 1_500 for _ in range(80)], shrinking, model="start", max_calls=5)

    assert len(calls) <= 5, f"ceiling of 5 overrun with {len(calls)} calls"


def test_truncation_paths_produce_a_prompt_that_actually_fits(monkeypatch):
    """Guard/truncation shares must account for template and per-part framing.

    budget // count ignores both, so the assembled prompt could exceed the budget its own
    shares were derived from.
    """
    monkeypatch.setattr(llm, "get_chunking_threshold", lambda m: 40_000)
    monkeypatch.setattr(llm, "get_fallback_model", lambda m: None)

    sent = []

    def record(prompt, model):
        sent.append(llm.count_tokens_accurate(prompt, "claude-opus-5"))
        return " ".join(["word"] * 5_000), 0.01, model  # never shrinks -> forces the guards

    combine("org/repo", ["word " * 2_000 for _ in range(40)], record, max_depth=1)

    budget = llm._synthesis_budget("org/repo", "claude-opus-5")
    assert sent, "no calls made"
    for tokens in sent:
        assert tokens <= budget, f"a truncation path produced {tokens} tokens over {budget}"


def test_truncate_all_to_fit_is_framing_aware():
    analyses = ["word " * 3_000 for _ in range(10)]
    budget = 8_000
    trimmed = llm._truncate_all_to_fit("org/repo", analyses, budget, "claude-opus-5")
    prompt = llm._build_synthesis_prompt("org/repo", trimmed)
    assert llm.count_tokens_accurate(prompt, "claude-opus-5") <= budget
    assert len(trimmed) == len(analyses), "every part must survive, truncated not dropped"


# ── third review round: terminal boundedness ─────────────────────────────────────────


@pytest.mark.parametrize("parts", [100, 150, 200, 400, 2000])
def test_truncate_all_to_fit_never_returns_over_budget(parts):
    """High-cardinality input: per-part tightening has a floor it cannot get under.

    Each part costs its framing plus a truncation marker (~23 tokens) no matter how hard its
    content is cut, so past roughly budget/floor parts no number of tightening passes can
    succeed. The previous version gave up after five attempts and returned the over-budget
    result anyway (reported: 100 parts at a 3,616 budget assembling to 10,345 tokens).
    """
    budget = 3_616
    trimmed = llm._truncate_all_to_fit("org/repo", ["word " * 500 for _ in range(parts)],
                                       budget, "claude-opus-5")
    if trimmed:
        prompt = llm._build_synthesis_prompt("org/repo", trimmed)
        got = llm.count_tokens_accurate(prompt, "claude-opus-5")
        assert got <= budget, f"{parts} parts assembled to {got} tokens over a {budget} budget"
    # An empty result is the explicit "cannot fit" signal; callers must not send a request.


def test_impossible_budget_reports_locally_without_a_request():
    """When not even one framed, marked part fits, no LLM call may be made."""
    trimmed = llm._truncate_all_to_fit("org/repo", ["word " * 100 for _ in range(50)],
                                       10, "claude-opus-5")
    assert trimmed == [], "a budget of 10 tokens cannot fit a framed, marked part"


def test_driver_never_emits_an_over_budget_prompt_under_any_guard(monkeypatch):
    """Drive every guard at once: tiny budget, high cardinality, a model that never shrinks."""
    monkeypatch.setattr(llm, "get_chunking_threshold", lambda m: 20_000)
    monkeypatch.setattr(llm, "get_fallback_model", lambda m: None)
    sent = []

    def never_shrinks(prompt, model):
        sent.append(llm.count_tokens_accurate(prompt, "claude-opus-5"))
        return "word " * 5_000, 0.01, model

    text, _ = combine("org/repo", ["word " * 400 for _ in range(300)], never_shrinks)

    budget = llm._synthesis_budget("org/repo", "claude-opus-5")
    assert text, "must still return something"
    for tokens in sent:
        assert tokens <= budget, f"emitted a {tokens}-token prompt over the {budget} budget"


# ── fourth review round: the collapse must not drop parts ────────────────────────────


@pytest.mark.parametrize("parts", [100, 150, 200, 400, 2000])
def test_terminal_collapse_represents_every_part_or_none(parts):
    """All markers or []; never a prefix.

    The first collapse implementation joined the parts and cut the head, keeping only the
    first ~15 while the prompt still "fit". The model, given no evidence anything was missing,
    would return normal QUICK_REFERENCE and summary sections that parse as perfectly healthy —
    authoritative metadata for a repository it had mostly never seen. That is the exact defect
    this feature exists to prevent, so a partial representation is not an acceptable outcome.
    """
    budget = 3_616
    analyses = [f"UNIQUE_{i} " + "word " * 300 for i in range(parts)]
    trimmed = llm._truncate_all_to_fit("org/repo", analyses, budget, "claude-opus-5")

    if not trimmed:
        return  # honest local degradation; the caller makes no request

    prompt = llm._build_synthesis_prompt("org/repo", trimmed)
    assert llm.count_tokens_accurate(prompt, "claude-opus-5") <= budget
    missing = [i for i in range(parts) if f"UNIQUE_{i}" not in prompt]
    assert not missing, (
        f"{len(missing)} of {parts} parts absent from the emitted prompt "
        f"(first missing: {missing[:5]}) — a prefix is not a representation")


def test_terminal_collapse_warns_that_everything_is_excerpted():
    """The single global warning must be present so the content is not read as complete."""
    analyses = [f"UNIQUE_{i} " + "word " * 300 for i in range(150)]
    trimmed = llm._truncate_all_to_fit("org/repo", analyses, 3_616, "claude-opus-5")
    assert trimmed and "excerpted" in trimmed[0]
    assert "150 analysis parts" in trimmed[0]


def test_driver_never_drops_parts_silently(monkeypatch):
    """End to end: whatever reaches the model represents every part, or nothing is sent."""
    monkeypatch.setattr(llm, "get_chunking_threshold", lambda m: 20_000)
    monkeypatch.setattr(llm, "get_fallback_model", lambda m: None)
    sent = []

    def never_shrinks(prompt, model):
        sent.append(prompt)
        return "word " * 5_000, 0.01, model

    parts = 120
    analyses = [f"UNIQUE_{i} " + "word " * 400 for i in range(parts)]
    combine("org/repo", analyses, never_shrinks)

    if sent:
        final = sent[-1]
        represented = sum(1 for i in range(parts) if f"UNIQUE_{i}" in final)
        # The final prompt is either a full-coverage compact form or a synthesis of summaries
        # (which legitimately no longer carries the markers). A partial prefix of the
        # originals is the failure mode being excluded.
        assert represented in (0, parts), (
            f"final prompt carried {represented} of {parts} original parts — a prefix")
