# Count-Tokens Preflight — Design Spec (Branch 2)

- **Date:** 2026-08-07
- **Status:** Draft for review (user-approved architecture; pending Codex spec review)
- **Branch:** `feat/count-tokens-preflight`, cut from `dev` @ `cc3888c`
- **Supersedes the stop-gap in:** v1.0.29 (Branch 1 — conservative 1.7× budgeting)

## 1. Background

Branch 1 (shipped in v1.0.29) stopped Claude 4.7+ metadata syncs from overflowing by **guessing conservatively**: it multiplies litellm's local token count by `1.7×` for a fixed set of Claude models and reserves a char-length header allowance. It fails closed, but it is an estimate — it can over-chunk, and Anthropic states the 4.7+ tokenizer increase is **content- and workload-dependent**, so a single factor is not a guaranteed bound and needs re-tuning as tokenizers change.

Branch 2 replaces the guess with the **authoritative server count** for the exact prompt about to be sent, and hardens the model catalog so token-window errors are caught at release time.

## 2. Goals / Non-goals

**Goals**
- For every Claude prompt actually sent (each chunk-analysis prompt and each synthesis prompt), budget against the **exact** token count of that exact payload, obtained from Anthropic's count-tokens endpoint via `litellm.acount_tokens`.
- Never ship a result **less safe than Branch 1**: when an authoritative count is unavailable, fall back to the complete Branch 1 conservative path.
- Make catalog token-window errors (the gpt-5.4-mini/nano input-vs-total class) a **release gate**, with vendor docs as the source of truth.
- Fail closed on uncatalogued models.

**Non-goals**
- No global/per-model/per-repo "ratio" is derived or cached (that was the rejected calibrate-once design — a ratio measured on one payload does not bound another). The only reuse is exact-payload memoization (§5).
- No new runtime dependency: the count call rides the already-locked `litellm==1.93.0` (`acount_tokens`), keyed off the existing `ANTHROPIC_API_KEY` env var. The `anthropic` SDK is **not** added (avoids regenerating the 10-cell pydeps lock).
- OpenAI/Gemini counting is unchanged (Branch 1 found their local counts accurate); the catalog's `count_strategy` field leaves the door open to add `openai_api` later without code changes to callers.

## 3. Architecture overview

```
sync (per repo)
  └─ reject_if_unknown(model)                      # §7 fail closed, before any expensive work
  └─ acceptance_budget(model, requested_output)    # §4 precise, from catalog fields
  └─ preflight_count(payload)  ──► authoritative?  # §5 acount_tokens + gate + timeout + memo
       ├─ yes → budget against exact count + headroom
       └─ no  → Branch 1 conservative estimate (this exact payload only)
  └─ chunk/synthesis loop: build final set → count every final payload →
       split & REBUILD & RECOUNT the whole set until a full pass fits   # §6 fixpoint
```

The authoritative count is **per exact (model, transport payload)**. It replaces the `1.7×` estimate **only** for that payload. It is never turned into a factor and never applied to a different prompt.

## 4. Acceptance budget (precise)

### 4.1 Catalog fields (replaces the bare `KNOWN_LIMITS` integer)

Each model gets an explicit capability record:

| field | meaning |
| --- | --- |
| `total_context` | vendor's total context window (input **and** output share it, for Anthropic) |
| `max_input` | vendor's maximum input tokens |
| `max_output` | vendor's maximum output tokens |
| `count_strategy` | `"anthropic_api"` \| `"local"` (extensible: `"openai_api"`) |
| `source_url` | vendor documentation URL |
| `source_date` | date the values were last vendor-verified (YYYY-MM-DD) |

**Vendor documentation is canonical.** litellm is a cross-check only (§8), never the source of truth.

### 4.2 The budget formula

For a send that requests `requested_output` completion tokens (the `max_tokens` passed to `call_llm`, default 8192):

```
acceptance_budget = min(max_input, total_context - requested_output) - HEADROOM
```

- The `min(...)` is the tighter (fail-closed) of two ceilings: the vendor's hard `max_input`, and "whatever the shared context leaves after we reserve room for the output we asked for." For Anthropic where `max_input = total_context - max_output` and `requested_output (8192) ≤ max_output`, this resolves to `max_input - HEADROOM`.
- `requested_output` is the **actual** `max_tokens` for that call site, not a constant — the spec threads it through rather than assuming 8192.

### 4.3 Headroom (exact)

`HEADROOM = ceil(0.01 × min(max_input, total_context - requested_output))` — **1% of the input ceiling**, retained **even for an authoritative count**. Anthropic documents that count-tokens is a close estimate, not guaranteed bit-identical to the creation-time count; 1% absorbs that drift and minor tokenizer-version skew while being negligible against real windows (≈1–2k tokens at a 200k window, ≈10k at 1M). This value is pinned here and centralized as a named constant so it is tunable in one place.

## 5. The preflight count (`repo_radar/llm.py`)

`preflight_count(model, prompt, *, timeout_s) -> PreflightResult`

1. **Payload parity:** build the exact structure `call_llm` sends for this model — for the completion path that is `messages=[{"role": "user", "content": prompt}]`. The count MUST count the same message structure the send uses (a shared `_completion_messages(prompt)` helper is the single source of truth for both).
2. **Strategy gate:** only models whose catalog `count_strategy == "anthropic_api"` take the server path; others go straight to the Branch 1 local path.
3. **Call + timeout:** `await asyncio.wait_for(litellm.acount_tokens(model=model, messages=…, api_key=…), timeout_s)`. `acount_tokens` has **no** timeout argument, so the coroutine is wrapped. The sync flow is synchronous, so the call site uses `asyncio.run` (or a cached loop) around this coroutine.
4. **Authoritative gate:** accept the result as authoritative **only** when `not resp.error and resp.tokenizer_type == "anthropic_api"`. litellm 1.93.0's `acount_tokens` catches provider-count exceptions (auth, rate-limit, network) and silently returns a **local** count with `tokenizer_type == "local_tokenizer"` and no raise — that must be treated as **non-authoritative** (otherwise a failed call reads as `ratio ≈ 1`, dropping all safety). `asyncio.TimeoutError` and any raise are likewise non-authoritative.
5. **Result:** `PreflightResult(tokens, authoritative: bool)`. Authoritative → `tokens` is the exact server count. Non-authoritative → caller uses the **complete Branch 1 conservative estimate for this exact payload** (`count_tokens_for_budget`, unchanged), never a value derived from any other prompt.

**Memoization (the only reuse):** an in-process cache keyed by `(model, sha256(payload))` stores authoritative results only. Identical payloads (e.g., a chunk whose `(i/N)` header did not change across a recount pass) are not re-sent. Caching by model or by repository is explicitly forbidden — it would reuse one prompt's count for a different prompt.

## 6. Chunking & synthesis with per-prompt counting (fixpoint)

Local packing still runs first (using the Branch 1 conservative estimate) to produce a candidate set cheaply. Then:

1. Build the **complete final set** with real `(chunk i/N)` headers.
2. `preflight_count` **every** final payload against `acceptance_budget`.
3. If any payload exceeds budget, split the offending chunk(s). Splitting changes `N`, so **every** `(i/N)` header changes, and BPE token counts are **non-monotonic** in the header numerals — a previously-fitting chunk can now overflow. Therefore **rebuild the whole set and recount from scratch**; do not trust the prior pass.
4. Repeat until a **full pass fits with zero overflows** (or a chunk reaches the single-file irreducible floor). `N` only grows and is bounded by the file count, so this converges. Memoization (§5) keeps unchanged payloads from re-hitting the network.

**Synthesis batches** get the identical discipline: splitting a batch changes the batch count/headers, so rebuild and recount the full batch set until a pass fits.

## 7. Fail-closed unknown-model rejection

Today `get_model_context_window` returns `128000` for an uncatalogued model — not a guaranteed floor (an unknown model could be smaller). Instead, **reject** an uncatalogued model **before any expensive sync work** (before file collection / any API call) with an actionable message naming the model and pointing at the catalog. Rejection — not a guessed ceiling — is the durable rule.

## 8. Release-time catalog validation

A new stdlib gate `scripts/check_model_windows.py`, wired into `release.sh` alongside `check_model_lifecycle.py`:

- For every catalog model, compare declared `max_input`/`max_output`/`total_context` against litellm's `get_model_info`.
- **Vendor values are canonical.** The gate **reports every mismatch** (collects all, never stops at the first) and **flags dangerous over-reporting** (litellm value **>** vendor value — the direction that would let us over-budget and overflow). It never overwrites or defers to litellm.
- Each catalog record's `source_url` + `source_date` make the vendor provenance auditable.

## 9. Production wiring (no dead code)

Every production analysis send and every synthesis send MUST pass through the preflight path. Branch 1 already caught the "validated helper bypassed by an inline call site" failure mode; Branch 2 adds **call-site/behavioral tests** (landmark tests asserting `sync.py`/synthesis route through the preflight, plus behavioral tests that a stubbed non-authoritative count forces the fallback) so the preflight cannot silently become dead code.

## 10. Testing

Mandatory (all with `acount_tokens` **mocked** — no live API in tests, keeps CI/pydeps runs deterministic):

1. Provider failure returns `tokenizer_type="local_tokenizer"` **without raising** → detected non-authoritative → Branch 1 fallback used.
2. A successful authoritative count below `1.7×` cannot weaken safety: authoritative → exact count used; non-authoritative → full `1.7×` floor, never a reduced factor.
3. Two repositories using one model cannot share content calibration — no model/repo-keyed cache; only exact `(model, payload digest)` memoization.
4. Source-code vs synthesis prompts (materially different true ratios) are each counted on their own payload.
5. `asyncio.wait_for` timeout → non-authoritative → fallback.
6. Unknown-model rejection fires before expensive work with an actionable message.
7. Release gate reports **every** catalog mismatch (not only the first) and flags over-reporting.
8. Fixpoint: after a split changes `N`, the whole set is recounted and the final emitted set fits under real `(i/N)` headers.
9. Landmark/behavioral: production analysis + synthesis sends both go through the preflight (no dead code).

Falsifiability: every guard must fail when neutered (same discipline as Branch 1).

## 11. Rollout & review

- Implement on `feat/count-tokens-preflight` (off `dev` @ `cc3888c`), per-commit Codex review, phase-checkpoint review — same discipline as Branch 1.
- This spec is committed and sent to Codex for review **before** the implementation plan is written.

## 12. Open questions (to close in review)

- **`requested_output` source of truth:** confirm every analysis/synthesis call site's `max_tokens` so §4.2 uses the real value, not the 8192 default, everywhere.
- **Headroom value:** 1% is pinned; confirm it's comfortable at the 1M window (≈10k tokens) and the 200k window (≈2k).
- **Async integration:** `asyncio.run` per call vs a single reused loop for the sync — pick the simpler that doesn't fight the existing sync structure.
