# Count-Tokens Preflight — Design Spec (Branch 2)

- **Date:** 2026-08-07
- **Status:** Draft, revision 2 (after Codex spec-review round 1 — 6 findings incorporated)
- **Branch:** `feat/count-tokens-preflight`, cut from `dev` @ `cc3888c`
- **Supersedes the stop-gap in:** v1.0.29 (Branch 1 — conservative 1.7× budgeting)

## 1. Background

Branch 1 (shipped in v1.0.29) stopped Claude 4.7+ metadata syncs from overflowing by **guessing conservatively**: multiply litellm's local token count by `1.7×` for a fixed set of Claude models, reserve a char-length header allowance, and pack against a `0.75×` window threshold. It fails closed, but it is an estimate — Anthropic states the 4.7+ tokenizer increase is **content- and workload-dependent**, so a single factor is not a guaranteed bound.

Branch 2 replaces the guess with the **authoritative server count** for the exact prompt about to be sent, and hardens the model catalog so token-window errors are caught at release. Every path is designed so Branch 2 is **never less safe than Branch 1**.

## 2. Goals / Non-goals

**Goals**
- For every Claude prompt actually sent — each chunk-analysis prompt, the unchunked whole-repo prompt, and each synthesis prompt — budget against the **exact** token count of that exact payload from Anthropic's count-tokens endpoint via `litellm.acount_tokens`.
- **Never less safe than Branch 1:** when an authoritative count is unavailable, use the *complete, unchanged* Branch 1 path (not a hybrid).
- Make catalog token-window errors a **release gate**, vendor docs canonical.
- Fail closed on uncatalogued models.

**Non-goals**
- No global/per-model/per-repo ratio is derived or cached (rejected calibrate-once design). The only reuse is exact-request memoization (§5).
- No new runtime dependency: rides the locked `litellm==1.93.0` (`acount_tokens`), keyed off `ANTHROPIC_API_KEY`. The `anthropic` SDK is **not** added.
- OpenAI/Gemini counting unchanged (Branch 1 found their local counts accurate); catalog `count_strategy` leaves room to add `openai_api` later.

## 3. Two explicit budget regimes (the core safety invariant)

There are exactly two regimes; a prompt is budgeted under one or the other, never a mixture:

- **Authoritative regime** — a valid provider count (§5) exists for the exact payload. Budget against the §4 acceptance budget (≈99% of the usable window).
- **Fallback regime** — no valid provider count. Budget against the **complete Branch 1 path, unchanged**: `0.75×` window threshold, `1.7×`/header-reserve conservative counting, component packing, truncation, and the Branch 1 synthesis budget.

**Never compare a `1.7×` fallback estimate against the ≈99% authoritative ceiling** — that would be looser than Branch 1 and violate "never less safe." If authoritative counting fails **during** a fixpoint (§6), abandon the authoritative pass and **repack from the original inputs under the full Branch 1 path**, not the authoritative ceiling.

## 4. Acceptance budget (authoritative regime only)

### 4.1 Catalog capability record (replaces the bare `KNOWN_LIMITS` integer)

| field | meaning |
| --- | --- |
| `total_context` | vendor total context window (input **and** output share it, for Anthropic) |
| `max_input` | vendor maximum **input** tokens (for Claude 5 this equals `total_context` = 1,000,000 — output is **not** pre-subtracted) |
| `max_output` | vendor maximum output tokens |
| `count_strategy` | `"anthropic_api"` \| `"local"` (extensible: `"openai_api"`) |
| `source_url` | vendor documentation URL |
| `source_date` | date the values were last vendor-verified (YYYY-MM-DD); **stale after 90 days** → §8 flags for re-verification |

**Vendor documentation is canonical.** litellm is drift evidence only (§8), never the source of truth. Verified against litellm 1.93.0 `get_model_info`: `claude-opus-5` reports `max_input_tokens=1_000_000`, `max_output_tokens=128_000` — i.e. `max_input == total_context`, confirming output is not pre-subtracted.

### 4.2 The budget formula

For a send requesting `requested_output` completion tokens:

```
acceptance_budget = min(max_input, total_context - requested_output) - HEADROOM
```

- `requested_output` is threaded from the **actual** call site, not assumed: **chunk analysis = 8192; unchunked full-repo = 16384; synthesis = 16384** (`SYNTHESIS_OUTPUT_TOKENS`). Verified against `call_llm` sites in `sync.py`/`llm.py`.
- `max_input` is the vendor's actual maximum input; do **not** pre-subtract `max_output`. The formula subtracts only the *actual* requested output once. For Claude 5 with 8192 output: `min(1_000_000, 991_808) − HEADROOM`.

### 4.3 Headroom (exact)

`HEADROOM = ceil(0.01 × min(max_input, total_context − requested_output))` — **1% of the input ceiling**, retained even in the authoritative regime. This is **headroom around a provider *estimate***: Anthropic documents count-tokens as a close estimate, not a bit-exact guarantee of the creation-time count. 1% absorbs that drift and tokenizer-version skew; negligible against real windows (≈2k at 200k, ≈10k at 1M). Centralized as one named constant.

## 5. The preflight count (`repo_radar/llm.py`)

`preflight_count(model, prompt, requested_output, *, loop, timeout_s) -> PreflightResult`

1. **Payload parity:** build the exact structure `call_llm` sends — for the completion path (all `anthropic_api` models), `messages=[{"role":"user","content":prompt}]` via a shared `_completion_messages(prompt)` helper used by *both* the counter and the sender, so they can never drift.
2. **Strategy gate:** only `count_strategy == "anthropic_api"` models take the server path; others go straight to the Branch 1 fallback regime.
3. **Call + timeout:** `await asyncio.wait_for(litellm.acount_tokens(model=model, messages=…, api_key=…), timeout_s)` — `acount_tokens` has no timeout arg, so the coroutine is wrapped. Runs on the single shared sync loop (§5a), not a per-call `asyncio.run`.
4. **Authoritative gate — ALL of:** `resp.tokenizer_type == "anthropic_api"`; `resp.error is False`; `isinstance(resp.total_tokens, int) and not isinstance(resp.total_tokens, bool)`; `resp.total_tokens > 0`; request/model identity consistent (`resp.request_model`/`model_used` match what we sent). litellm 1.93.0 silently returns a **local** count (`tokenizer_type="local_tokenizer"`) with no raise on provider-count exceptions, and constructs the anthropic path with `result.get("input_tokens", 0)` — so a malformed response could yield an **authoritative zero** that disables the guardrail. The `> 0` and type checks close that. Anything failing any clause → **not authoritative**.
5. **Result:** `PreflightResult(tokens, authoritative: bool)`. Non-authoritative → caller switches this payload to the **fallback regime** (§3), never a value derived from another prompt.

### 5a. Async integration + circuit breaker (production-critical)

- **One long-lived event loop per sync.** litellm globally caches its Anthropic `AsyncHTTPHandler`; repeated `asyncio.run()` would create/destroy loops while reusing that cached client, risking closed/foreign-loop failures. Create one loop at sync start, reuse for every preflight, close at sync end. Must run on **Python 3.10** (pydeps matrix includes cp310), so `asyncio.Runner` (3.11+) cannot be required — manage the loop manually.
- **Operation-scoped circuit breaker.** With authoritative-only memoization, an Anthropic outage would make every prompt *and every recount pass* independently wait out the timeout. After the **first** timeout/provider-fallback for a model in a sync, switch that model to the Branch 1 fallback regime for the **remainder of the sync** and log the downgrade **once**.

### 5b. Memoization (the only reuse)

In-process cache keyed by `sha256` of the **canonical serialization of the complete count request** — `messages`, `system`, `tools`, and relevant transport options — **not** prompt text alone. Stores authoritative results only. Caching by model or repository is forbidden.

## 6. Send-path algorithms (three distinct topologies)

Local packing (Branch 1 conservative estimate) still runs first to produce cheap candidates; the authoritative count then governs. **No path ever sends an over-budget request.**

**6.1 Unchunked full-repo send** (`max_tokens=16384`). Preflight-count the single whole-repo prompt. If it exceeds the acceptance budget, fall through to the chunked analysis path (6.2).

**6.2 Chunked analysis** (`max_tokens=8192`; prompts contain real `(chunk i/N)` headers). Build the **complete** final set; preflight-count every payload; split any overflow. Splitting changes `N`, so every `(i/N)` header changes and BPE is non-monotone — a previously-fitting chunk can overflow. Therefore **rebuild the whole set and recount from scratch** each pass, until one full pass fits with zero overflows. `N` only grows and is bounded by file count → converges. Memoization (§5b) skips genuinely-identical payloads.

**6.3 Synthesis** (`max_tokens=16384`; hierarchical map-reduce). `_build_synthesis_prompt` numbers only "Analysis Part i" **within** a batch — there is **no** global batch header, and later levels do not exist until earlier API calls return. So: for the **current** level, build and preflight that level's candidate batches before sending; if splitting changes grouping/part numbering, rebuild and recount the **unsent current level only** (never future levels, which don't exist yet). Send, collect results into the next level, repeat.

**6.4 Terminal behavior (all paths).** A "single-file irreducible floor" must never mean sending an over-budget request. An overflowing singleton is **truncated and authoritatively recounted until it fits**. If even the fixed template alone cannot fit the budget, emit the existing Branch 1 local **degraded result** rather than an over-budget send.

## 7. Fail-closed unknown-model rejection

Today `get_model_context_window` returns `128000` for an uncatalogued model — not a guaranteed floor. Instead, **reject** an uncatalogued model **before the network-wait / git clone-pull phase**, whenever the selected mode can generate metadata (production performs the network wait and all git work *before* file collection, so "before file collection" is too late). Modes that make no LLM request (`--skip-metadata`, repos-only) remain usable. The error names the model and points at the catalog.

## 8. Release-time catalog validation

New stdlib gate `scripts/check_model_windows.py`, wired into `release.sh` alongside `check_model_lifecycle.py`:

- Compare only **normalized, same-semantics** fields: catalog `max_input` vs litellm `max_input_tokens`, catalog `max_output` vs litellm `max_output_tokens`. **Do not** compare `total_context` — litellm exposes no equivalent field, and summing input+output is wrong for Anthropic's shared window.
- **Vendor is canonical; litellm is drift evidence.** Direction-specific behavior, defined by runtime danger (runtime reads the *catalog*, so the hazard is the catalog claiming more room than truly exists):
  - **catalog `max_input` > litellm `max_input_tokens`` → BLOCK** (the over-budget direction; this is exactly how the gpt-5.4-mini/nano defect appeared: catalog 1.05M vs litellm 272k).
  - **catalog `max_input` < litellm → WARN** (safe; possibly under-utilizing).
  - Report **every** mismatch, never stop at the first.
- **`source_date` freshness rule:** a record older than 90 days at release **warns and requires re-verification** — otherwise provenance is decorative.
- **Migrate every direct `KNOWN_LIMITS` consumer** to the new record shape: the lifecycle gate (`llm.KNOWN_LIMITS`), the JS drift mirror (`menubar/model-policy.js` + `__tests__/drift-check.js`), `test_litellm_matrix`, and the packaged `menubar/scripts/upgrade-smoke.sh`.

## 9. Production wiring (no dead code)

Every production analysis send (chunked **and** unchunked) and every synthesis send MUST pass through the preflight. Add landmark tests (assert `sync.py`/synthesis route through the preflight) **and** behavioral tests asserting the **exact payload digest was preflighted before `call_llm`** for all three send paths — so the preflight cannot become dead code (the Branch 1 failure mode).

## 10. Testing

All with `acount_tokens` **mocked** (no live API; deterministic CI/pydeps):

1. Provider failure returns `tokenizer_type="local_tokenizer"` without raising → non-authoritative → **full Branch 1 regime** (0.75× threshold), not the authoritative ceiling.
2. An authoritative count below `1.7×` cannot weaken safety; a non-authoritative one uses the complete Branch 1 path.
3. Malformed/zero/`bool` `total_tokens`, missing `input_tokens`, or identity mismatch → non-authoritative (no authoritative zero).
4. Two repos/one model cannot share content calibration — only exact-request digest memoization.
5. Source-code vs synthesis prompts (different true ratios) each counted on their own payload.
6. `asyncio.wait_for` timeout → non-authoritative → fallback; and the circuit breaker downgrades the rest of the sync after the first timeout, logging once.
7. Unknown-model rejection fires **before** the network/git phase; `--skip-metadata` still runs.
8. Release gate: reports every mismatch; **blocks** on catalog > litellm `max_input`; warns on the reverse and on stale `source_date`.
9. Fixpoint: after a split changes `N`, the whole analysis set is recounted and the emitted set fits under real `(i/N)` headers; synthesis rebuilds only the unsent current level; overflowing singleton is truncated-and-recounted, never sent over budget.
10. All three send paths (chunk, unchunked full-repo, synthesis) assert the exact payload digest was preflighted before `call_llm`.

Falsifiability: every guard must fail when neutered (Branch 1 discipline).

## 11. Rollout & review

- Implement on `feat/count-tokens-preflight` (off `dev` @ `cc3888c`), per-commit + phase-checkpoint Codex review.
- Spec committed and Codex-reviewed **before** the implementation plan (writing-plans).

## 12. Settled decisions (from Codex round 1)

- `requested_output`: chunk=8192, full-repo=16384, synthesis=16384 — threaded per prepared prompt.
- Headroom: 1% pinned, framed as headroom around a provider estimate.
- Async: one reused event loop per sync (Python 3.10-safe), plus per-model circuit breaker.
- Catalog gate compares same-semantics fields only; litellm is drift evidence; block direction = catalog over-reports vs litellm.
