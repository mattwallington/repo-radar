"""Conservative token budgeting for Claude 4.7+.

litellm bundles one Anthropic tokenizer for every Claude generation, so it counts 4.7+ text with
the older (4.5/4.6) tokenizer and UNDERCOUNTS by ~1.6x. Applying the normal 75% window margin to
an undercounted number let 1M-window Claude prompts overflow (observed: our 745,509 -> Anthropic's
1,189,532 -> rejected against the 1,000,000 ceiling). These tests pin the stop-gap: a conservative
budget count distinct from the accurate count, applied only to the affected models, so no emitted
prompt exceeds its budget.

The chunk/synthesis tests pass an explicit small budget rather than the real 1M window so they
force multi-chunk/multi-batch packing on tiny inputs — the packing logic and the 1.7x factor are
identical, and the suite stays fast.
"""
import math

import repo_radar.llm as llm

NEW = ["claude-opus-4-7", "claude-opus-4-8", "claude-fable-5", "claude-sonnet-5", "claude-opus-5"]
UNPENALIZED = ["claude-opus-4-5", "claude-opus-4-6", "claude-sonnet-4-6",
               "gemini/gemini-3.6-flash", "gpt-5.4", "gpt-5.4-mini"]

CODE = "def handler(request):\n    return {'ok': True, 'items': [i for i in range(10)]}\n"


def _files(count, repeats):
    body = CODE * repeats
    return [{"path": f"src/module_{i}.py", "size": len(body), "content": body}
            for i in range(count)]


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


# ── the chunker: no emitted analysis prompt exceeds the budget ─────────────────────────────

def test_no_chunk_prompt_exceeds_the_budget_for_claude_47():
    model, budget = "claude-opus-5", 8000
    chunks = llm.chunk_repo_files(_files(40, 25), model, max_tokens=budget, full_name="Org/repo")
    assert len(chunks) > 1, "small budget must force multiple chunks"
    for i, chunk in enumerate(chunks, 1):
        prompt = llm._build_analysis_prompt("Org/repo", chunk, i, len(chunks))
        got = llm.count_tokens_for_budget(prompt, model).count
        assert got <= budget, f"chunk {i} budget {got} > {budget}"


def test_no_chunk_prompt_exceeds_the_budget_for_an_accurate_model():
    model, budget = "gemini/gemini-3.6-flash", 8000
    chunks = llm.chunk_repo_files(_files(40, 25), model, max_tokens=budget, full_name="Org/repo")
    for i, chunk in enumerate(chunks, 1):
        prompt = llm._build_analysis_prompt("Org/repo", chunk, i, len(chunks))
        assert llm.count_tokens_for_budget(prompt, model).count <= budget


def test_claude_47_chunks_more_than_an_accurate_model_at_the_same_budget():
    """Only Claude 4.7+ pays the 1.7x, so on identical files + budget it must split into more
    chunks — proof the factor changes packing rather than being inert."""
    files, budget = _files(40, 25), 8000
    claude = llm.chunk_repo_files(files, "claude-opus-5", max_tokens=budget, full_name="Org/repo")
    gemini = llm.chunk_repo_files(files, "gemini/gemini-3.6-flash", max_tokens=budget, full_name="Org/repo")
    assert len(claude) > len(gemini), (len(claude), len(gemini))


def test_a_single_oversized_file_is_truncated_to_fit():
    model, budget = "claude-opus-5", 4000
    huge = CODE * 4000
    chunks = llm.chunk_repo_files([{"path": "big.py", "size": len(huge), "content": huge}],
                                  model, max_tokens=budget, full_name="Org/repo")
    for i, chunk in enumerate(chunks, 1):
        prompt = llm._build_analysis_prompt("Org/repo", chunk, i, len(chunks))
        assert llm.count_tokens_for_budget(prompt, model).count <= budget
    assert "truncated" in chunks[0][0]["content"]


# ── the synthesis path: no emitted synthesis prompt exceeds the budget ─────────────────────

def test_no_synthesis_prompt_exceeds_the_budget_for_claude_47(monkeypatch):
    model, budget = "claude-opus-5", 2500
    monkeypatch.setattr(llm, "_synthesis_budget", lambda full_name, m: budget)
    analyses = ["## Analysis part\n" + CODE * 6 for _ in range(20)]

    seen = []

    def synthesize(prompt, m):
        seen.append((prompt, m))
        return "QUICK_REFERENCE_START\nType: Library\nQUICK_REFERENCE_END\n", 0.0, m

    llm.combine_chunk_analyses("Org/repo", analyses, model=model, synthesize=synthesize)
    assert seen, "synthesis should have made at least one call"
    for prompt, m in seen:
        got = llm.count_tokens_for_budget(prompt, m).count
        assert got <= budget, f"synthesis prompt budget {got} > {budget}"


# ── the fixes for Codex round 1: real-prompt bounding, finished-prompt decision, no drift ──

import pathlib
import pytest


@pytest.mark.parametrize("budget", [1000, 1200, 1600, 2500])
def test_every_chunk_real_prompt_fits_even_at_tight_budgets(budget):
    """Component-sum packing under-counts the assembled prompt because tokenizer seams are not
    additive — a chunk that summed under budget can measure over. The repack pass must guarantee
    every REAL assembled prompt fits. Tight budgets pack several files per chunk, so the seams
    actually bite (this is the class Codex reproduced at 917 -> 934)."""
    model = "claude-opus-5"
    chunks = llm.chunk_repo_files(_files(50, 8), model, max_tokens=budget, full_name="Org/repo")
    assert any(len(c) > 1 for c in chunks), "budget should pack multiple files per chunk"
    for i, chunk in enumerate(chunks, 1):
        prompt = llm._build_analysis_prompt("Org/repo", chunk, i, len(chunks))
        got = llm.count_tokens_for_budget(prompt, model).count
        assert got <= budget, f"budget {budget}: chunk {i} real prompt {got}"


def test_repack_splits_a_component_overshoot_chunk():
    """The exact seam class Codex reproduced. With this config, per-file-component packing yields a
    chunk whose REAL assembled prompt is 1094 tokens against a 1090 budget — the seams add tokens
    the component sum misses. The repack pass must split it so every real prompt fits. Pinned to
    litellm 1.93.0's tokenizer (a version the suite already asserts). This test FAILS if pass 3 is
    removed, unlike the invariant sweep above."""
    model, budget = "claude-opus-5", 1090
    body = "def f_0(x):\n    return x + compute(x)  # note\n" * 6
    files = [{"path": f"m{i}.py", "size": len(body), "content": body} for i in range(60)]
    chunks = llm.chunk_repo_files(files, model, max_tokens=budget, full_name="Org/repo")
    assert len(chunks) > 1
    for i, chunk in enumerate(chunks, 1):
        prompt = llm._build_analysis_prompt("Org/repo", chunk, i, len(chunks))
        got = llm.count_tokens_for_budget(prompt, model).count
        assert got <= budget, f"chunk {i} real prompt {got} > {budget} — repack did not split it"


def test_repo_needs_chunking_decides_on_the_finished_prompt():
    """repo_needs_chunking is the production decision (sync calls it). It must decide on the
    FINISHED whole-repo prompt, not a sum of file-content tokens — a repo can look small by
    content yet overflow once template + framing are added."""
    model = "claude-opus-5"
    files = _files(6, 5)
    finished = llm.count_tokens_for_budget(llm._build_full_repo_prompt("o/r", files), model).count
    content_only = sum(llm.count_tokens_for_budget(f["content"], model).count for f in files)
    assert finished > content_only, "template + framing must add real tokens"

    # Budget above the finished prompt -> single path, exact count reported.
    needs, value, exact = llm.repo_needs_chunking("o/r", files, model, finished)
    assert (needs, value, exact) == (False, finished, True)
    # Budget between content-only and finished -> must chunk (deciding on content-only, the old
    # bug, would have wrongly kept it single).
    needs, _value, exact = llm.repo_needs_chunking("o/r", files, model, content_only)
    assert needs and exact
    # Fast path: content lower bound alone over budget -> chunk without the exact count.
    needs, value, exact = llm.repo_needs_chunking("o/r", files, model, content_only - 1)
    assert (needs, value, exact) == (True, content_only, False)


def test_wide_header_verification_upper_bounds_any_real_header():
    """The chunker verifies with a fixed wide "(chunk 999999/999999)" header, so the number it
    checks is >= the real "(chunk i/N)" header for any N. A narrow synthetic header (the old
    999/999) under-bounded once a repo split into >999 chunks and sent prompts over budget."""
    model = "claude-opus-5"
    chunk = _files(3, 5)
    wide = llm._analysis_prompt_budget("o/r", chunk, model)
    for i, n in [(1, 1), (5, 10), (500, 1500), (999999, 999999)]:
        real = llm.count_tokens_for_budget(llm._build_analysis_prompt("o/r", chunk, i, n), model).count
        assert real <= wide, (i, n, real, wide)


def test_repack_splits_a_large_overshoot_into_few_chunks_not_per_file():
    """The paid-call explosion Codex flagged, tested directly on the repack pass. Feed _repack_to_fit
    ONE chunk of 100 files whose REAL assembled prompt is ~2x budget. The greedy packer can't deliver
    such a chunk (pass 2 bounds every chunk to ~threshold, so through chunk_repo_files pass 3 only
    ever sees a seam-sized overshoot — which is why routing this through chunk_repo_files can't tell
    peel-one from binary-search). Calling the repack directly makes the guarantee observable: the
    largest-prefix binary search splits it into a couple of maximally-full chunks; peeling one file
    at a time emits ~51 singleton (paid) calls. This test FAILS if _repack_to_fit reverts to peeling.
    """
    model = "claude-opus-5"
    body = "def f_0(x):\n    return x + compute(x)  # note\n" * 4
    files = [{"path": f"m{i}.py", "size": len(body), "content": body} for i in range(100)]
    budget = llm._analysis_prompt_budget("o/r", files[:50], model)  # fits ~half the files
    assert llm._analysis_prompt_budget("o/r", files, model) > 1.8 * budget, \
        "the single chunk must run well over budget for this to exercise the split"

    chunks = llm._repack_to_fit([files], budget, model, "o/r")
    assert len(chunks) <= 5, f"largest-prefix split must stay tiny, got {len(chunks)} (peel-one gives ~51)"
    assert sum(len(c) for c in chunks) == 100, "no files lost or duplicated across the split"
    for c in chunks:
        assert llm._analysis_prompt_budget("o/r", c, model) <= budget


def test_sync_routes_through_the_shared_prompt_builders_and_decision():
    """Production must SEND the prompt the chunker/decision MEASURED, and DECIDE with the one
    authoritative helper. It used to build both prompts inline and reimplement the decision, so the
    validated code and the real code were separate and could drift."""
    src = pathlib.Path(__file__).resolve().parents[1] / "modes" / "sync.py"
    text = src.read_text()
    assert "_build_analysis_prompt(full_name, chunk" in text
    assert "_build_full_repo_prompt(full_name, files)" in text
    assert "repo_needs_chunking(" in text, "decision must go through the authoritative helper"
    # The inline prompt literals and the inline decision reimplementation must be gone.
    assert "Analyze this portion of the repository" not in text
    assert "Analyze this repository:" not in text
    assert "content_budget_sum" not in text
