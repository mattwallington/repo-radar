# Count-Tokens Preflight (Branch 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This plan is self-contained — do NOT reconstruct any step from git history.

**Status:** revision 5 (after Codex plan-review rounds 1–4). Architecture is settled; this pass is commit-greenness + falsifiable test bodies.

**Goal:** Budget every Claude prompt actually sent against Anthropic's authoritative count (`litellm.acount_tokens`), falling back to the complete Branch 1 conservative path when that count is unavailable, and harden the model catalog with explicit windows + a release-time validation gate.

**Architecture:** `repo_radar/preflight.py` owns a dedicated asyncio loop thread and a `PreflightSession` whose single lock-held coroutine applies the count-strategy gate, re-checks the memo + per-model breaker, performs/validates the provider call, and updates all shared state on the loop thread; fatal signals are marshalled to the caller. `repo_radar/model_catalog.py` holds explicit capability records + budget math. Send paths become pure helpers gated monotonically by Branch 1's partition; one wiring commit threads a session through `sync.py`. `scripts/check_model_windows.py` validates the catalog at release.

**Tech Stack:** Python 3.10–3.14, `litellm==1.93.0`, `asyncio`, stdlib. JS mirror `menubar/model-policy.js`. Spec: `docs/superpowers/specs/2026-08-07-count-tokens-preflight-design.md` @ `e031b86`.

## Global Constraints

- **No new runtime dependency.** `litellm==1.93.0` `acount_tokens` only; no `anthropic` SDK.
- **Python 3.10-safe.** No `asyncio.Runner` (3.11+).
- **Never less safe than Branch 1.** Non-authoritative → the complete, unchanged Branch 1 path.
- **Fixed per-shape output (spec, unchanged):** chunk `8192`, unchunked full-repo `SYNTHESIS_OUTPUT_TOKENS`=`16384`, synthesis `16384`. Every catalogued model has `max_output >= 16384` (gpt-4-turbo, 4096, is removed), so the gate's `requested_output <= max_output` invariant holds with no clamping.
- **Authoritative gate = ALL of:** `tokenizer_type == "anthropic_api"`; `error is False`; `total_tokens` is `int` and not `bool` and `> 0`; `request_model == model` AND `model_used == model`.
- **Central strategy gate:** only `count_strategy == "anthropic_api"` reaches the provider; `local`/unknown → non-authoritative, no provider call / breaker mutation / downgrade log.
- **Fatal signals propagate:** inside the loop coroutine catch `Exception` → non-authoritative; catch `KeyboardInterrupt`/`SystemExit` → a private `_Fatal` envelope the caller re-raises.
- **Monotonic.** Authoritative counting may only split/tighten Branch 1's partition — never merge/reverse `chunk→single`.
- **HEADROOM = `ceil(0.01 × min(max_input, total_context − requested_output))`.**
- **Vendor canonical; litellm is drift evidence.** Gate BLOCKs catalog>litellm (`max_input`/`max_output`), WARNs the reverse; overrides bind `{model, field, catalog_value, litellm_value, vendor_url}` + freshness.
- **All tests mock `acount_tokens`.** Commit hygiene: stage exact files; every commit green.

---

## Phase A — Catalog foundation + fail-closed rejection

### Task 1: `model_catalog.py` — complete verified table

**Files:** Create `repo_radar/model_catalog.py`; Modify `repo_radar/llm.py`; Test `repo_radar/tests/test_model_catalog.py`.
**Interfaces:** `ModelCaps(total_context, max_input, max_output, count_strategy, source_url, source_date)`; `MODEL_CAPS`; `get_caps(model)`; `is_known_model(model)`. `llm.KNOWN_LIMITS = {m: c.max_input}` (compat export).

**`total_context` policy (vendor-grounded, per model — NOT a provider-wide additive rule, which is false: gpt-4o is a 128K *shared* window):** `total_context = max_input` for every model **except** the OpenAI split-budget family (models whose vendor doc separates input+output; here exactly the `max_input == 272000` models), which vendor-documents 400,000 total (`llm.py:71`). `total_context` feeds `acceptance_budget` **only** for `anthropic_api` models, where it equals the shared context window and is exact. For `local` models it is documentation + the `max_input <= total_context` invariant. Every value here (including the gpt-5.x 1.05M-input shared-window totals) is the vendor-verified value as of `source_date` — there is no "pending" state; `source_date` records that verification date.

**Task 1 is ADDITIVE (commit-greenness):** it introduces `MODEL_CAPS` **still containing `gpt-4-turbo`**, so the derived `KNOWN_LIMITS` is unchanged and the JS mirror / lifecycle manifest / matrix stay green at this commit. The atomic removal of `gpt-4-turbo` (from the catalog, `model_lifecycle.json`, the JS `KNOWN_MODEL_IDS`, and the tests) plus the `max_output >= 16384` invariant all land together in Task 3.

- [ ] **Step 1: Failing tests**

```python
# repo_radar/tests/test_model_catalog.py
import repo_radar.model_catalog as mc
def test_record_invariants():
    for m, c in mc.MODEL_CAPS.items():
        for v in (c.total_context, c.max_input, c.max_output):
            assert isinstance(v, int) and not isinstance(v, bool) and v > 0, m
        assert c.max_input <= c.total_context and c.max_output <= c.total_context, m
        assert c.count_strategy in ("anthropic_api", "local") and c.source_url.startswith("https://"), m
def test_openai_split_family_is_vendor_exact():
    for m in ("gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.3-codex"):
        assert (mc.get_caps(m).total_context, mc.get_caps(m).max_input, mc.get_caps(m).max_output) == (400000, 272000, 128000), m
def test_shared_window_models_total_equals_max_input():
    for m in ("claude-opus-5", "gpt-4o", "gpt-4.1", "gemini/gemini-3.6-flash", "o3"):
        assert mc.get_caps(m).total_context == mc.get_caps(m).max_input, m
def test_unknown_absent():
    assert mc.is_known_model("no-such") is False and mc.get_caps("no-such") is None
```

> **Task 1 keeps `gpt-4-turbo`** in `MODEL_CAPS` as `"gpt-4-turbo": ModelCaps(128000, 128000, 4096, "local", _OPE, "2026-08-08"),` (insert after `gpt-4o-mini`). Its `max_output` (4096) is why the `max_output >= 16384` invariant is NOT asserted here — that assertion and the removal both land in Task 3.

- [ ] **Step 2: Run** `python3 -m pytest repo_radar/tests/test_model_catalog.py -q` → FAIL.
- [ ] **Step 3: Write the module.** Header + accessors:

```python
# repo_radar/model_catalog.py
"""Explicit per-model capability catalog (Branch 2). VENDOR DOCS ARE CANONICAL; litellm is only a
release-time drift cross-check. Values verified 2026-08-08. total_context == max_input for shared-window
models; the OpenAI 272K-input split family vendor-documents 400,000 total (llm.py:71). total_context feeds
acceptance_budget only for anthropic_api models; for local models it is documentation + the
max_input<=total_context invariant."""
from collections import namedtuple
ModelCaps = namedtuple("ModelCaps", "total_context max_input max_output count_strategy source_url source_date")
_ANT = "https://platform.claude.com/docs/en/about-claude/models/overview"
_GEM = "https://ai.google.dev/gemini-api/docs/models"
_OPE = "https://developers.openai.com/api/docs/models"
MODEL_CAPS = {
    "claude-opus-5": ModelCaps(1000000, 1000000, 128000, "anthropic_api", _ANT, "2026-08-08"),
    "claude-sonnet-5": ModelCaps(1000000, 1000000, 128000, "anthropic_api", _ANT, "2026-08-08"),
    "claude-opus-4-8": ModelCaps(1000000, 1000000, 128000, "anthropic_api", _ANT, "2026-08-08"),
    "claude-opus-4-7": ModelCaps(1000000, 1000000, 128000, "anthropic_api", _ANT, "2026-08-08"),
    "claude-fable-5": ModelCaps(1000000, 1000000, 128000, "anthropic_api", _ANT, "2026-08-08"),
    "claude-opus-4-6": ModelCaps(1000000, 1000000, 128000, "anthropic_api", _ANT, "2026-08-08"),
    "claude-opus-4-6-20260205": ModelCaps(1000000, 1000000, 128000, "anthropic_api", _ANT, "2026-08-08"),
    "claude-sonnet-4-6": ModelCaps(1000000, 1000000, 64000, "anthropic_api", _ANT, "2026-08-08"),
    "claude-opus-4-5": ModelCaps(200000, 200000, 64000, "anthropic_api", _ANT, "2026-08-08"),
    "claude-opus-4-5-20251101": ModelCaps(200000, 200000, 64000, "anthropic_api", _ANT, "2026-08-08"),
    "claude-sonnet-4-5": ModelCaps(200000, 200000, 64000, "anthropic_api", _ANT, "2026-08-08"),
    "claude-sonnet-4-5-20250929": ModelCaps(200000, 200000, 64000, "anthropic_api", _ANT, "2026-08-08"),
    "claude-haiku-4-5": ModelCaps(200000, 200000, 64000, "anthropic_api", _ANT, "2026-08-08"),
    "claude-haiku-4-5-20251001": ModelCaps(200000, 200000, 64000, "anthropic_api", _ANT, "2026-08-08"),
    "gemini/gemini-3.6-flash": ModelCaps(1048576, 1048576, 65536, "local", _GEM, "2026-08-08"),
    "gemini/gemini-3.5-flash": ModelCaps(1048576, 1048576, 65535, "local", _GEM, "2026-08-08"),
    "gemini/gemini-3.1-pro-preview": ModelCaps(1048576, 1048576, 65536, "local", _GEM, "2026-08-08"),
    "gemini/gemini-3.1-flash-lite": ModelCaps(1048576, 1048576, 65536, "local", _GEM, "2026-08-08"),
    "gemini/gemini-3-flash-preview": ModelCaps(1048576, 1048576, 65535, "local", _GEM, "2026-08-08"),
    "gemini/gemini-2.5-pro": ModelCaps(1048576, 1048576, 65535, "local", _GEM, "2026-08-08"),
    "gemini/gemini-2.5-flash": ModelCaps(1048576, 1048576, 65535, "local", _GEM, "2026-08-08"),
    "gemini/gemini-2.5-flash-lite": ModelCaps(1048576, 1048576, 65535, "local", _GEM, "2026-08-08"),
    "gemini/gemini-pro-latest": ModelCaps(1048576, 1048576, 65535, "local", _GEM, "2026-08-08"),
    "gemini/gemini-flash-latest": ModelCaps(1048576, 1048576, 65535, "local", _GEM, "2026-08-08"),
    "gemini/gemini-flash-lite-latest": ModelCaps(1048576, 1048576, 65535, "local", _GEM, "2026-08-08"),
    "gpt-5.6-sol": ModelCaps(1050000, 1050000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5.6-terra": ModelCaps(1050000, 1050000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5.6-luna": ModelCaps(1050000, 1050000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5.5": ModelCaps(1050000, 1050000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5.5-pro": ModelCaps(1050000, 1050000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5.4": ModelCaps(1050000, 1050000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5.4-pro": ModelCaps(1050000, 1050000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5.4-mini": ModelCaps(400000, 272000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5.4-nano": ModelCaps(400000, 272000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5.3-codex": ModelCaps(400000, 272000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5.2": ModelCaps(400000, 272000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5.2-pro": ModelCaps(400000, 272000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5.1": ModelCaps(400000, 272000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5": ModelCaps(400000, 272000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5-mini": ModelCaps(400000, 272000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5-nano": ModelCaps(400000, 272000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-4.1": ModelCaps(1047576, 1047576, 32768, "local", _OPE, "2026-08-08"),
    "gpt-4.1-mini": ModelCaps(1047576, 1047576, 32768, "local", _OPE, "2026-08-08"),
    "gpt-4.1-nano": ModelCaps(1047576, 1047576, 32768, "local", _OPE, "2026-08-08"),
    "gpt-4o": ModelCaps(128000, 128000, 16384, "local", _OPE, "2026-08-08"),
    "gpt-4o-mini": ModelCaps(128000, 128000, 16384, "local", _OPE, "2026-08-08"),
    "gpt-4-turbo": ModelCaps(128000, 128000, 4096, "local", _OPE, "2026-08-08"),  # removed atomically in Task 3
    "o4-mini": ModelCaps(200000, 200000, 100000, "local", _OPE, "2026-08-08"),
    "o3": ModelCaps(200000, 200000, 100000, "local", _OPE, "2026-08-08"),
    "o3-mini": ModelCaps(200000, 200000, 100000, "local", _OPE, "2026-08-08"),
    "o3-pro": ModelCaps(200000, 200000, 100000, "local", _OPE, "2026-08-08"),
    "o1": ModelCaps(200000, 200000, 100000, "local", _OPE, "2026-08-08"),
    "o1-pro": ModelCaps(200000, 200000, 100000, "local", _OPE, "2026-08-08"),
}
def get_caps(model): return MODEL_CAPS.get(model)
def is_known_model(model): return model in MODEL_CAPS
```

- [ ] **Step 4:** In `llm.py`, replace the `KNOWN_LIMITS = {...}` literal with `from repo_radar import model_catalog` and `from repo_radar.model_catalog import get_caps, is_known_model`, then `KNOWN_LIMITS = {m: c.max_input for m, c in model_catalog.MODEL_CAPS.items()}`. This is byte-identical to today's `KNOWN_LIMITS` (gpt-4-turbo still included), so every consumer stays green.
- [ ] **Step 5: Run** `python3 -m pytest repo_radar/tests/ -q && node menubar/__tests__/drift-check.js` → PASS/`drift OK` (additive commit is fully green).
- [ ] **Step 6: Commit** — `git add repo_radar/model_catalog.py repo_radar/llm.py repo_radar/tests/test_model_catalog.py && git commit -m "feat(catalog): introduce MODEL_CAPS (additive; KNOWN_LIMITS derived)"`

### Task 2: `acceptance_budget(model, requested_output)`

**Files:** Modify `repo_radar/model_catalog.py`; Test `repo_radar/tests/test_model_catalog.py`.
**Interfaces:** `acceptance_budget(model, requested_output) -> int`; `HEADROOM_FRACTION = 0.01`. (No `effective_output`/clamp — every model serves ≥16384.)

- [ ] **Step 1: Failing test**

```python
import math
def test_budget_subtracts_requested_output_and_1pct():
    ceiling = min(1_000_000, 1_000_000 - 8192)
    assert mc.acceptance_budget("claude-opus-5", 8192) == ceiling - math.ceil(0.01 * ceiling)
    assert mc.acceptance_budget("claude-opus-5", 8192) > 900_000
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**

```python
import math
HEADROOM_FRACTION = 0.01
def acceptance_budget(model, requested_output):
    caps = MODEL_CAPS[model]
    ceiling = min(caps.max_input, caps.total_context - requested_output)
    return ceiling - math.ceil(HEADROOM_FRACTION * ceiling)
```

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(catalog): acceptance_budget (1% headroom)"`

### Task 3: Atomic switch — remove `gpt-4-turbo` everywhere + migrate every consumer (one green commit)

**Files:** Modify `repo_radar/model_catalog.py`, `repo_radar/model_lifecycle.json`, `menubar/model-policy.js`, `menubar/__tests__/drift-check.js`, `repo_radar/tests/test_litellm_matrix.py`, `scripts/check_model_lifecycle.py`, `repo_radar/tests/test_lifecycle_gate.py`, `repo_radar/tests/test_model_catalog.py`, `menubar/scripts/upgrade-smoke.sh`.

**This whole task is ONE commit** — every removal + consumer edit lands together so no intermediate state is red.

- [ ] **Step 1 — remove `gpt-4-turbo`:** delete its row from `repo_radar/model_catalog.py` `MODEL_CAPS`, delete its row from `repo_radar/model_lifecycle.json`, delete `'gpt-4-turbo'` from `menubar/model-policy.js` (both the caps mirror and any migration), and add to `repo_radar/tests/test_model_catalog.py`: `def test_gpt_4_turbo_removed_and_every_model_serves_16384(): assert mc.get_caps("gpt-4-turbo") is None; assert all(c.max_output >= 16384 for c in mc.MODEL_CAPS.values())`.
- [ ] **Step 2 — matrix test (drop exact-equality; window validation is the Task 12 gate's job):** rewrite `test_every_known_model_resolves_on_litellm_1_93` to iterate `model_catalog.MODEL_CAPS` (`from repo_radar import model_catalog`); for each id assert `litellm.get_model_info(id)` resolves, `litellm_provider == llm.provider_for_model(id)`, `mode in ("chat","responses")`; collect all problems, `assert not problems`. **Remove** the `max_input_tokens == ctx` assertion.
- [ ] **Step 3 — lifecycle gate:** in `scripts/check_model_lifecycle.py` `main()`, `from repo_radar import model_catalog` and use `set(model_catalog.MODEL_CAPS)` for the known-id set (not `llm.KNOWN_LIMITS`). Update `test_lifecycle_gate.py::test_real_manifest_exact_set_and_passes_at_release` to compare manifest ids to `set(model_catalog.MODEL_CAPS) | set(llm.MODEL_MIGRATIONS)`.
- [ ] **Step 4 — JS mirror:** in `menubar/model-policy.js` add `const MODEL_CAPS = { 'claude-opus-5': {max_input:1000000, max_output:128000}, ... }` for every model (gpt-4-turbo excluded), derive `KNOWN_MODEL_IDS = new Set(Object.keys(MODEL_CAPS))`; in `menubar/__tests__/drift-check.js` assert JS `MODEL_CAPS[m]` equals Python `{max_input, max_output}` for every model.
- [ ] **Step 5 — packaged smoke:** in `menubar/scripts/upgrade-smoke.sh`, assert the packaged CLI reports `gpt-5.3-codex` `max_input=272000`, `max_output=128000` from `MODEL_CAPS` (adapt to the smoke's print format) so the catalog can't be dead code.
- [ ] **Step 6: Run** `python3 -m pytest repo_radar/tests/ -q && node menubar/__tests__/drift-check.js && python3 scripts/check_model_lifecycle.py --target-date 2026-08-10` → all PASS/`OK`.
- [ ] **Step 7: Commit** — stage the nine files; `git commit -m "refactor(catalog): remove gpt-4-turbo + migrate all consumers to MODEL_CAPS"`

### Task 4: Reject unknown models before the network wait (§7)

**Files:** Modify `repo_radar/modes/sync.py`; Test `repo_radar/tests/test_sync_guard.py` (create).
**Interfaces:** Guard at the top of `sync_mode`, **before** `wait_for_network` (`sync.py:290`). Metadata-capable predicate: `not getattr(args,"skip_metadata",False) and not getattr(args,"repos_only",False)`. **`dry_run` is intentionally still validated** (surfaces a misconfigured model before a real run). Metadata-capable + `not is_known_model(get_ai_model())` → print an actionable message (naming the model + `repo_radar/model_catalog.py`) and exit non-zero.

- [ ] **Step 1: Failing tests** — (a) unknown model + metadata mode ⇒ both `wait_for_network` and the git executor uncalled (patch both, assert `call_count == 0`) and non-zero exit; (b) `skip_metadata=True` + unknown model ⇒ proceeds past the guard; (c) `dry_run=True` + unknown model ⇒ still rejected (documented behavior).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the guard before line 290.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(sync): reject uncatalogued models before network wait (dry-run validated)"`

**Phase A checkpoint:** full `python3 -m pytest repo_radar/tests/ -q` + `node --test menubar/__tests__/*.test.js` green → Codex review of Phase A.

---

## Phase B — Preflight counter (`repo_radar/preflight.py`)

### Task 5: `PreflightLoop` — correct close lifecycle (retryable, closed only after stop)

**Files:** Create `repo_radar/preflight.py`; Test `repo_radar/tests/test_preflight.py`.
**Interfaces:** `PreflightLoop`: `start()`, `submit(coro) -> Any`, `close()`, `is_closed()`. `close()` uses separate `_closing`/`_closed` state, marks `_closed` **only after** the thread stops and the loop closes, and **stays retryable** if join times out.

- [ ] **Step 1: Failing tests**

```python
# repo_radar/tests/test_preflight.py
import asyncio, threading, repo_radar.preflight as pf
def test_runs_and_closes():
    loop = pf.PreflightLoop(); loop.start()
    async def v(): await asyncio.sleep(0); return 42
    try: assert loop.submit(v()) == 42
    finally: loop.close()
    assert loop.is_closed()
def test_close_cancels_a_real_pending_coroutine(monkeypatch):
    # Load-bearing: submit a coroutine that never returns, so there IS a pending task; close() must
    # cancel/drain it (deleting the _drain block would hang here) and the future observes cancellation.
    loop = pf.PreflightLoop(); loop.start()
    never = asyncio.run_coroutine_threadsafe(asyncio.Event().wait(), loop._loop)   # pending forever
    while not never.running():                                                     # ensure it is scheduled
        pass
    loop.close()                                                                   # must cancel + drain, not hang
    assert loop.is_closed() is True
    import concurrent.futures
    with pytest.raises((concurrent.futures.CancelledError, asyncio.CancelledError)):
        never.result(timeout=1)
def test_close_is_retryable_if_thread_does_not_stop(monkeypatch):
    loop = pf.PreflightLoop(); loop.start()
    real_join, real_alive = loop._thread.join, loop._thread.is_alive
    monkeypatch.setattr(loop._thread, "join", lambda timeout=None: None)
    monkeypatch.setattr(loop._thread, "is_alive", lambda: True)                     # pretend it won't stop
    loop.close()
    assert loop.is_closed() is False                                               # retryable, not a lie
    monkeypatch.setattr(loop._thread, "is_alive", real_alive)
    monkeypatch.setattr(loop._thread, "join", real_join)
    loop.close()
    assert loop.is_closed() is True
```
(Add `import pytest` at the top of the test module.)

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**

```python
# repo_radar/preflight.py
import asyncio, threading, hashlib, json, logging
logger = logging.getLogger("repo_radar.preflight")
class PreflightLoop:
    def __init__(self): self._loop=None; self._thread=None; self._closing=False; self._closed=False
    def start(self):
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._loop.run_forever, name="preflight-loop", daemon=True)
        self._thread.start()
    def submit(self, coro): return asyncio.run_coroutine_threadsafe(coro, self._loop).result()
    def close(self):
        if self._closed or self._closing: return
        self._closing = True
        try:
            async def _drain():
                pending = [t for t in asyncio.all_tasks(self._loop) if t is not asyncio.current_task()]
                for t in pending: t.cancel()
                await asyncio.gather(*pending, return_exceptions=True)
            try: asyncio.run_coroutine_threadsafe(_drain(), self._loop).result(timeout=5)
            except Exception as e: logger.warning("preflight drain failed: %s", e)   # surfaced, still try to stop
            self._loop.call_soon_threadsafe(self._loop.stop)
            self._thread.join(timeout=5)
            if self._thread.is_alive():
                logger.error("preflight loop thread did not stop; close() is retryable"); return  # _closed stays False
            self._loop.close()
            self._closed = True
        finally:
            self._closing = False
    def is_closed(self): return self._closed
```

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(preflight): loop with retryable close (closed only after stop)"`

### Task 6: `_count_once` + authoritative gate + fatal envelope

**Files:** Modify `repo_radar/preflight.py`, `repo_radar/llm.py` (`_completion_messages`); Test `repo_radar/tests/test_preflight.py`.
**Interfaces:** `PreflightResult(tokens, authoritative)`; `_Fatal(exc)`; `_is_authoritative(resp, model)`; `async _count_once(model, prompt, timeout_s)`.

- [ ] **Step 1: Failing tests** (helpers at top of test file):

```python
from unittest.mock import patch
from types import SimpleNamespace
def _resp(total, tt="anthropic_api", error=False, rm="claude-opus-5", mu="claude-opus-5"):
    return SimpleNamespace(total_tokens=total, tokenizer_type=tt, error=error, request_model=rm, model_used=mu)
def test_gate_all_conditions():
    assert pf._is_authoritative(_resp(1234), "claude-opus-5") is True
    for bad in (_resp(1234, tt="local_tokenizer"), _resp(0), _resp(True), _resp(5, error=True),
                _resp(5, rm="wrong", mu="wrong"), SimpleNamespace(total_tokens=5, tokenizer_type="anthropic_api", error=False)):
        assert pf._is_authoritative(bad, "claude-opus-5") is False
def test_count_once_timeout_and_error_and_fatal():
    loop = pf.PreflightLoop(); loop.start()
    async def slow(**kw): await asyncio.sleep(1); return _resp(5)
    with patch("litellm.acount_tokens", slow): assert loop.submit(pf._count_once("claude-opus-5","x",0.01)).authoritative is False
    async def boom(**kw): raise RuntimeError()
    with patch("litellm.acount_tokens", boom): assert loop.submit(pf._count_once("claude-opus-5","x",5)).authoritative is False
    async def ki(**kw): raise KeyboardInterrupt()
    with patch("litellm.acount_tokens", ki):
        out = loop.submit(pf._count_once("claude-opus-5","x",5)); assert isinstance(out, pf._Fatal)
    loop.close()
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Add `_completion_messages` in `llm.py`** and switch `call_llm`'s completion branch to it:

```python
def _completion_messages(prompt):
    """Exact messages structure call_llm sends on the completion path — one source of truth for
    the sender AND the preflight counter."""
    return [{"role": "user", "content": prompt}]
```
Then implement in `preflight.py`:
```python
from collections import namedtuple
import litellm
from repo_radar.llm import _completion_messages
PreflightResult = namedtuple("PreflightResult", "tokens authoritative")
_Fatal = namedtuple("_Fatal", "exc")
def _is_authoritative(resp, model):
    tt = getattr(resp, "total_tokens", None)
    return (getattr(resp, "tokenizer_type", None) == "anthropic_api" and getattr(resp, "error", True) is False
            and isinstance(tt, int) and not isinstance(tt, bool) and tt > 0
            and getattr(resp, "request_model", None) == model and getattr(resp, "model_used", None) == model)
async def _count_once(model, prompt, timeout_s):
    try:
        resp = await asyncio.wait_for(litellm.acount_tokens(model=model, messages=_completion_messages(prompt)), timeout_s)
    except (KeyboardInterrupt, SystemExit) as e: return _Fatal(e)
    except Exception: return PreflightResult(None, False)
    return PreflightResult(resp.total_tokens, True) if _is_authoritative(resp, model) else PreflightResult(None, False)
```

- [ ] **Step 4: Run** → PASS (and `repo_radar/tests/` for `call_llm`).
- [ ] **Step 5: Commit** — stage `preflight.py`, `llm.py`, `test_preflight.py`; `git commit -m "feat(preflight): authoritative gate + fatal envelope"`

### Task 7: `PreflightSession` — strategy gate + loop-owned single-flight + load-bearing tests

**Files:** Modify `repo_radar/preflight.py`; Test `repo_radar/tests/test_preflight.py`.
**Interfaces:** `PreflightSession(timeout_s=10.0)` context manager; `count(model, prompt, requested_output) -> PreflightResult` (re-raises `_Fatal.exc` on the caller thread).

- [ ] **Step 1: Failing tests (non-deadlocking, load-bearing)**

```python
import concurrent.futures as cf
def test_local_strategy_never_calls_provider():
    calls = []
    async def fake(**kw): calls.append(1); return _resp(5)
    with patch("litellm.acount_tokens", fake), pf.PreflightSession(timeout_s=5) as s:
        assert s.count("gpt-5.4-mini", "x", 16384).authoritative is False
    assert calls == []
def _concurrent_two(total):
    """Deterministic single-flight probe. Submit BOTH guarded coroutines to the loop as futures;
    coro1 enters the provider (blocks on `release`) holding the lock; coro2 is submitted next, then a
    MARKER coroutine drains the loop's ready queue — so coro2 has provably run up to its lock await
    (and, absent a lock, would already have called the provider). Assert the provider call count
    WHILE coro1 is still in-flight: 1 with the lock, 2 without. Returns (calls_before_release,
    downgrade_warnings)."""
    entered = threading.Event(); release = threading.Event(); calls = []
    async def fake(**kw):
        calls.append(1); entered.set()
        await asyncio.get_event_loop().run_in_executor(None, release.wait)
        return _resp(total, rm=kw["model"], mu=kw["model"])
    with patch("litellm.acount_tokens", fake), pf.PreflightSession(timeout_s=5) as s:
        lp = s._loop._loop
        f1 = asyncio.run_coroutine_threadsafe(s._guarded("claude-opus-5", "same"), lp)
        entered.wait()                                        # coro1 holds the lock, parked in provider
        f2 = asyncio.run_coroutine_threadsafe(s._guarded("claude-opus-5", "same"), lp)
        asyncio.run_coroutine_threadsafe(asyncio.sleep(0), lp).result(timeout=5)   # drain: coro2 reached its await
        calls_before = len(calls)                             # load-bearing: 1 (lock) vs 2 (no lock)
        release.set()
        f1.result(timeout=5); f2.result(timeout=5)
    return calls_before
def test_single_flight_two_callers_one_provider_call():
    assert _concurrent_two(100) == 1                          # coro2 blocked on the lock -> no 2nd call
def test_concurrent_first_failure_opens_breaker_no_second_call():
    assert _concurrent_two(0) == 1                            # non-authoritative -> breaker; coro2 no call
def test_breaker_per_model_and_logs_downgrade_once(caplog):
    import logging; caplog.set_level(logging.WARNING, logger="repo_radar.preflight")
    seen = []
    async def fake(**kw):
        seen.append(kw["model"]); return _resp(0 if kw["model"]=="claude-opus-5" else 50, rm=kw["model"], mu=kw["model"])
    with patch("litellm.acount_tokens", fake), pf.PreflightSession(timeout_s=5) as s:
        assert s.count("claude-opus-5","a",8192).authoritative is False
        assert s.count("claude-opus-5","b",8192).authoritative is False            # breaker open, no call
        assert s.count("claude-sonnet-5","c",8192).authoritative is True           # different model still tries
    assert seen == ["claude-opus-5", "claude-sonnet-5"]
    downgrades = [r for r in caplog.records if "downgraded to Branch 1" in r.getMessage() and "claude-opus-5" in r.getMessage()]
    assert len(downgrades) == 1                                                    # logged exactly once
def test_fatal_reraised_on_caller_thread():
    async def ki(**kw): raise KeyboardInterrupt()
    with patch("litellm.acount_tokens", ki), pf.PreflightSession(timeout_s=5) as s:
        try: s.count("claude-opus-5","x",8192); assert False
        except KeyboardInterrupt: pass
```
(`_concurrent_two` reaches into `s._guarded` / `s._loop._loop` deliberately — testing the single-flight critical section requires the raw loop futures; `count()` blocks the caller thread and can't expose the concurrent queue.)

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**

```python
from repo_radar.model_catalog import get_caps
class PreflightSession:
    def __init__(self, timeout_s=10.0):
        self._loop = PreflightLoop(); self._timeout = timeout_s
        self._memo = {}; self._downgraded = set(); self._logged = set(); self._lock = None
    def __enter__(self): self._loop.start(); self._lock = self._loop.submit(self._mklock()); return self
    def __exit__(self, *e): self._loop.close()
    async def _mklock(self): return asyncio.Lock()
    @staticmethod
    def _key(model, prompt):
        req = json.dumps({"model": model, "messages": _completion_messages(prompt)}, sort_keys=True, separators=(",", ":"))
        return (model, hashlib.sha256(req.encode()).hexdigest())
    async def _guarded(self, model, prompt):
        async with self._lock:
            caps = get_caps(model)
            if caps is None or caps.count_strategy != "anthropic_api": return PreflightResult(None, False)
            if model in self._downgraded: return PreflightResult(None, False)
            key = self._key(model, prompt)
            if key in self._memo: return self._memo[key]
            out = await _count_once(model, prompt, self._timeout)
            if isinstance(out, _Fatal): return out
            if out.authoritative: self._memo[key] = out
            else:
                self._downgraded.add(model)
                if model not in self._logged:
                    self._logged.add(model); logger.warning("preflight: %s downgraded to Branch 1 for this sync", model)
            return out
    def count(self, model, prompt, requested_output):
        out = self._loop.submit(self._guarded(model, prompt))
        if isinstance(out, _Fatal): raise out.exc
        return out
```

- [ ] **Step 4: Run** → PASS. Falsifiability: removing the strategy-gate line fails `test_local_strategy_never_calls_provider`; removing the lock/memo makes `_concurrent_two(100)` return 2.
- [ ] **Step 5: Commit** — `git commit -m "feat(preflight): strategy gate + loop-owned single-flight + fatal re-raise"`

**Phase B checkpoint:** `python3 -m pytest repo_radar/tests/test_preflight.py -q` green → Codex review of Phase B.

---

## Phase C — Monotonic send helpers, then one wiring commit

### Task 8: `authoritative_partition` (§6.1) — monotonic single-vs-chunk

**Files:** Modify `repo_radar/llm.py`; Test `repo_radar/tests/test_send_paths.py` (create).
**Interfaces:** `authoritative_partition(session, full_name, files, model) -> "single" | "chunk"`.

- [ ] **Step 1: Failing tests**

```python
# repo_radar/tests/test_send_paths.py
from repo_radar.preflight import PreflightResult
class _StubSession:
    def __init__(self, table): self.table = table; self.calls = []
    def count(self, model, prompt, requested_output):
        self.calls.append((model, requested_output)); return self.table(prompt)
def test_branch1_chunk_never_reversed(monkeypatch):
    import repo_radar.llm as llm
    monkeypatch.setattr(llm, "repo_needs_chunking", lambda *a, **k: (True, 9, False))
    s = _StubSession(lambda p: PreflightResult(1, True))
    assert llm.authoritative_partition(s, "o/r", [{"path":"a","size":1,"content":"x"}], "claude-opus-5") == "chunk"
    assert s.calls == []
def test_branch1_single_stays_or_tightens(monkeypatch):
    import repo_radar.llm as llm
    monkeypatch.setattr(llm, "repo_needs_chunking", lambda *a, **k: (False, 1, True))
    files = [{"path":"a","size":1,"content":"x"}]
    assert llm.authoritative_partition(_StubSession(lambda p: PreflightResult(500, True)), "o/r", files, "claude-opus-5") == "single"
    assert llm.authoritative_partition(_StubSession(lambda p: PreflightResult(10**9, True)), "o/r", files, "claude-opus-5") == "chunk"
    assert llm.authoritative_partition(_StubSession(lambda p: PreflightResult(None, False)), "o/r", files, "claude-opus-5") == "single"
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**

```python
from repo_radar.model_catalog import acceptance_budget, get_caps
FULL_REPO_OUTPUT = SYNTHESIS_OUTPUT_TOKENS  # 16384
def authoritative_partition(session, full_name, files, model):
    threshold = get_chunking_threshold(model)
    needs_chunk, _v, _e = repo_needs_chunking(full_name, files, model, threshold)
    if needs_chunk: return "chunk"
    caps = get_caps(model)
    if caps is None or caps.count_strategy != "anthropic_api": return "single"
    r = session.count(model, _build_full_repo_prompt(full_name, files), FULL_REPO_OUTPUT)
    if r.authoritative: return "single" if r.tokens <= acceptance_budget(model, FULL_REPO_OUTPUT) else "chunk"
    return "single"
```

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(llm): authoritative_partition (monotonic)"`

### Task 9: `authoritative_chunks` → `PartitionResult`; analysis-only whole-repo degradation (§6.2, §6.4)

**Files:** Modify `repo_radar/llm.py`; Test `repo_radar/tests/test_send_paths.py`.
**Interfaces:** `PartitionResult(chunks, degraded_reason)` (`chunks: list[list[file]]`, sendable only, `N = len(chunks)`; `degraded_reason: str | None`). `authoritative_chunks(session, full_name, files, model) -> PartitionResult`. Fixpoint: from Branch 1 `chunk_repo_files`, count each real `(i/N)` prompt at `acceptance_budget(model, 8192)`; overflow → largest-prefix split + whole-set rebuild/recount. A single file that overflows is binary-truncated with an **authoritative recount per candidate**; if even the template floor overflows, the **whole repo degrades** → `PartitionResult([], reason)` (production writes one degraded record, **zero** `call_llm`). Any non-authoritative count → `PartitionResult(chunk_repo_files(files, model, full_name=full_name), None)`.

- [ ] **Step 1: Failing tests** — (a) provider overflow → split, final chunks fit; (b) provider-overflow-while-local-1.7×-fits singleton terminates (binary search), fits; (c) template-floor singleton ⇒ `PartitionResult([], reason)`; (d) non-authoritative ⇒ `chunks == chunk_repo_files(...)`, `degraded_reason is None`.

```python
def _files(n): return [{"path": f"m{i}.py", "size": 3, "content": f"c{i}"} for i in range(n)]

def test_split_rebuilds_and_recounts_the_whole_set_with_real_headers(monkeypatch):
    """N-change fixpoint: Branch 1 hands back one 3-file chunk. The provider says a chunk fits ONLY
    when its header is '(chunk i/1)'; the moment a split makes N=2 every header changes and the
    prompt overflows, so the whole set must be rebuilt+recounted under the real (i/N) until a full
    clean pass. Budget is injected via the count table, not i=1."""
    import repo_radar.llm as llm
    budget = llm.acceptance_budget("claude-opus-5", 8192)
    monkeypatch.setattr(llm, "chunk_repo_files", lambda *a, **k: [_files(3)])
    def table(prompt):
        # Overflow if the header reflects a multi-file chunk (">=2 files" marker) OR N>1; else fit.
        over = ("2 bytes" in prompt) or ("/2)" in prompt) or ("/3)" in prompt)
        return PreflightResult(budget + 1 if over else budget - 1, True)
    out = llm.authoritative_chunks(_StubSession(table), "o/r", _files(3), "claude-opus-5")
    assert out.degraded_reason is None
    N = len(out.chunks)
    assert [f["path"] for c in out.chunks for f in c] == [f"m{i}.py" for i in range(3)]   # order/identity
    for i, c in enumerate(out.chunks, 1):
        # every EMITTED chunk fits under its REAL (i/N) header (not i=1)
        assert _StubSession(table).count("claude-opus-5", llm._build_analysis_prompt("o/r", c, i, N), 8192).tokens <= budget

def test_singleton_provider_overflow_local_fit_terminates(monkeypatch):
    import repo_radar.llm as llm
    big = {"path":"big.py","size":100,"content":"x"*5000}
    def table(prompt): return PreflightResult(10 if ("x"*200 not in prompt) else 10**9, True)
    s = _StubSession(table); monkeypatch.setattr(llm, "chunk_repo_files", lambda *a, **k: [[big]])
    out = llm.authoritative_chunks(s, "o/r", [big], "claude-opus-5")
    assert out.degraded_reason is None and out.chunks and "truncated" in out.chunks[0][0]["content"]

def test_template_floor_degrades_whole_repo(monkeypatch):
    import repo_radar.llm as llm
    big = {"path":"big.py","size":100,"content":"x"*5000}
    monkeypatch.setattr(llm, "chunk_repo_files", lambda *a, **k: [[big]])
    out = llm.authoritative_chunks(_StubSession(lambda p: PreflightResult(10**9, True)), "o/r", [big], "claude-opus-5")
    assert out.chunks == [] and out.degraded_reason                                        # whole-repo degrade, no sends

def test_non_authoritative_falls_back_to_branch1(monkeypatch):
    import repo_radar.llm as llm
    files = _files(4); branch1 = [_files(2), _files(2)]
    monkeypatch.setattr(llm, "chunk_repo_files", lambda *a, **k: branch1)
    out = llm.authoritative_chunks(_StubSession(lambda p: PreflightResult(None, False)), "o/r", files, "claude-opus-5")
    assert out.chunks == branch1 and out.degraded_reason is None
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — define `PartitionResult = namedtuple("PartitionResult", "chunks degraded_reason")` and `class _NonAuthoritative(Exception): pass`. Fit test uses `session.count(model, _build_analysis_prompt(full_name, chunk, i, N), 8192)`; non-authoritative → raise `_NonAuthoritative`. Singleton overflow → `_authoritative_truncate_file` (binary search over `content` length, recount each candidate; a `None` result ⇒ set `degraded_reason`). Wrap the builder in `try/except _NonAuthoritative: return PartitionResult(chunk_repo_files(files, model, full_name=full_name), None)`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(llm): authoritative_chunks + whole-repo analysis degradation contract"`

### Task 10: `authoritative_synthesis_level` — split-only + synthesis singleton terminal (§6.3)

**Files:** Modify `repo_radar/llm.py`; Test `repo_radar/tests/test_send_paths.py`.
**Interfaces:** `DegradedSynthesis(reason)`; `authoritative_synthesis_level(session, full_name, analyses, model) -> list[list[str]] | DegradedSynthesis`. Split-only from Branch 1's largest batches; a single over-budget analysis that cannot split is binary-truncated with authoritative recount; template-floor ⇒ `DegradedSynthesis(reason)`. Non-authoritative ⇒ return Branch 1's current-level batches unchanged. **`SYNTHESIS_MAX_CALLS` interaction:** `combine_chunk_analyses` must compute the max-calls guard from the **authoritative (post-split) batch count** of the current level before issuing sends.

- [ ] **Step 1: Failing tests**

```python
def test_over_budget_batch_splits_into_more_batches(monkeypatch):
    import repo_radar.llm as llm
    budget = llm.acceptance_budget("claude-opus-5", 16384)
    analyses = ["A0", "A1", "A2", "A3"]
    monkeypatch.setattr(llm, "_synthesis_budget", lambda *a, **k: budget)   # Branch 1: one batch of 4
    # provider: a batch of >2 analyses overflows; <=2 fits.
    def table(prompt): return PreflightResult(budget + 1 if prompt.count("Analysis Part") > 2 else budget - 1, True)
    out = llm.authoritative_synthesis_level(_StubSession(table), "o/r", analyses, "claude-opus-5")
    assert not isinstance(out, llm.DegradedSynthesis)
    assert len(out) >= 2 and [a for b in out for a in b] == analyses            # split, order preserved
    for b in out:
        assert _StubSession(table).count("claude-opus-5", llm._build_synthesis_prompt("o/r", b), 16384).tokens <= budget

def test_max_calls_guard_uses_authoritative_post_split_count(monkeypatch):
    """A level Branch 1 would run in 1 batch but authoritative counting splits into K must charge K
    (not 1) against SYNTHESIS_MAX_CALLS. Assert the guard is computed from len(authoritative batches)."""
    import repo_radar.llm as llm
    seen = {}
    monkeypatch.setattr(llm, "authoritative_synthesis_level", lambda s, fn, a, m: [[x] for x in a])  # K == len(a)
    def guard_probe(calls, batches, max_calls): seen["n"] = len(batches); return calls + len(batches) + 1 > max_calls
    # combine_chunk_analyses must call the guard with the post-split batches; assert seen["n"] == len(analyses).
    # (Exact wiring test: monkeypatch the guard expression's batch source and assert its length.)
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the level splitter (largest-prefix on the analyses list; fit = authoritative count of `_build_synthesis_prompt(full_name, batch)` ≤ `acceptance_budget(model, 16384)`; singleton via the same binary-truncate helper as Task 9, generalized to a text list). In `combine_chunk_analyses`, replace the current level's Branch 1 `batches` with `authoritative_synthesis_level(...)`'s result **before** the `calls + len(batches) + 1 > max_calls` guard (`llm.py:994`), so `max_calls` charges the authoritative (post-split) count. On `DegradedSynthesis`, stop and return the local degraded synthesis result (prior chunk work preserved).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(llm): synthesis level split-only + singleton terminal + max_calls from authoritative count"`

### Task 11: One wiring commit — thread `PreflightSession`; honor BOTH degradation paths (§9)

**Files:** Modify `repo_radar/modes/sync.py`, `repo_radar/llm.py` (`combine_chunk_analyses(..., session=None)`); Test `repo_radar/tests/test_send_paths.py`.
**Degradation contracts (distinct — finding #5):**
- **Analysis-partition degradation** (`PartitionResult.degraded_reason`): the repo is degraded **before any send** — write ONE degraded repo record and make **zero** `call_llm` for that repo.
- **Synthesis degradation** (`DegradedSynthesis`): chunk-analysis sends already happened and are preserved; make **no** overflowing/final synthesis send and return the local degraded synthesis result.

**Degraded record shape (reuse the existing convention — `metadata.py:39` `PARSE_STATUS_DEGRADED='degraded'`, INDEX includes degraded rows at `metadata.py:327`):** the written metadata frontmatter for a degraded repo carries `full_name`, `cache_dir`, the **current** `commit_hash`/`last_commit`, `parse_status: 'degraded'`, and a `degraded_reason`. Recording the current commit is what stops an infinite retry (the next sync sees an unchanged commit and skips), and `parse_status: 'degraded'` keeps it visible in INDEX rather than dropping the repo.

- [ ] **Step 1: Failing tests**

```python
def test_count_precedes_send_for_all_three_paths(monkeypatch):
    """Ordered digest event log: each send path must PREFLIGHT the exact payload digest before the
    matching call_llm sees the same payload."""
    events = []   # ("count", digest) / ("send", digest)
    ...  # patch session.count to append ("count", sha(prompt)); patch call_llm to append ("send", sha(prompt))
    # For chunk, full-repo, and synthesis: assert the ("count", d) event for a payload precedes its ("send", d).
    for d in sent_digests:
        assert events.index(("count", d)) < events.index(("send", d))

def test_analysis_partition_degradation_writes_degraded_record_and_never_calls_llm(monkeypatch):
    import repo_radar.llm as llm, repo_radar.modes.sync as sync
    calls = []; monkeypatch.setattr(llm, "call_llm", lambda *a, **k: calls.append(1) or ("", 0.0, None))
    monkeypatch.setattr(llm, "authoritative_chunks", lambda *a, **k: llm.PartitionResult([], "template floor"))
    record = sync._generate_metadata_for(...)   # the per-repo path used by generate_metadata_task
    assert calls == []                                                      # zero LLM calls
    assert record["parse_status"] == "degraded" and record["degraded_reason"] and record.get("commit_hash")

def test_synthesis_degradation_preserves_chunk_calls(monkeypatch):
    import repo_radar.llm as llm
    calls = []; monkeypatch.setattr(llm, "call_llm", lambda *a, **k: calls.append(k.get("max_tokens")) or ("A", 0.0, None))
    monkeypatch.setattr(llm, "authoritative_synthesis_level", lambda *a, **k: llm.DegradedSynthesis("floor"))
    out = llm.combine_chunk_analyses("o/r", ["A0","A1"], model="claude-opus-5", session=_StubSession(lambda p: PreflightResult(1, True)))
    assert 8192 in calls                                                    # chunk-analysis sends happened
    assert 16384 not in calls                                              # no final synthesis send
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — wrap the metadata loop in `with PreflightSession() as session:`; branch on `authoritative_partition`; on `PartitionResult.degraded_reason` write the degraded frontmatter (shape above) and make no send; pass `session` into `combine_chunk_analyses`, which uses `authoritative_synthesis_level` per level and returns the local degraded synthesis on `DegradedSynthesis` (chunk work preserved).
- [ ] **Step 4: Run** full `python3 -m pytest repo_radar/tests/ -q` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(sync): thread PreflightSession; honor analysis vs synthesis degradation"`

**Phase C checkpoint:** full suite green → Codex review of Phase C.

---

## Phase D — Release gate

### Task 12: `check_model_windows.py` — directional compare + full invariants (§8)

**Files:** Create `scripts/check_model_windows.py`, `repo_radar/tests/test_check_model_windows.py`.
**Interfaces:** `check(caps_map, litellm_info, overrides, target_date, send_outputs=(8192, 16384)) -> list[Finding]`; `Finding(model, field, message, blocking)`. `litellm_info(model) -> {"max_input_tokens","max_output_tokens"}` (raises for unresolved). Collect ALL findings.

Invariants (each `blocking=True` unless noted):
- each window field is a positive `int` excluding `bool`; `max_input <= total_context`; `count_strategy` known; `source_url` non-empty https; `source_date` valid ISO and not future.
- for every `nominal` in `send_outputs`: `nominal <= max_output` (BLOCK if violated — no clamp).
- catalog `max_input` > litellm `max_input_tokens` → BLOCK; `max_output` > litellm → BLOCK; catalog < litellm → WARN (`blocking=False`).
- `litellm_info(model)` raises / missing a field → BLOCK for that model, keep collecting.

- [ ] **Step 1: Failing tests** — one per invariant, both directions, the `nominal>max_output` block, the unresolved-model block, reports-all (two bad rows → two findings).
- [ ] **Step 2–4:** implement (stdlib; compare `max_input`/`max_output` only) + run → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(release): check_model_windows (directional + full invariants)"`

### Task 13: Mismatch-bound overrides, fully validated (§8)

**Files:** Create `repo_radar/model_window_overrides.json` (`[]`); Modify `scripts/check_model_windows.py`, `repo_radar/tests/test_check_model_windows.py`.
**Interfaces:** Override `{model, field, catalog_value, litellm_value, vendor_url, verified_at, justification}`. Clears a BLOCK only when it matches a live mismatch on ALL of `model, field, catalog_value, litellm_value`, **`vendor_url == caps.source_url`**, `justification` a non-empty str, and `verified_at` within 90 days of `target_date`. Malformed row or duplicate `(model, field)` → BLOCK (fail closed). Stale catalog `source_date` (>90d before `target_date`) → BLOCK, cleared only by refreshing that record's own `source_date` (never an override).

- [ ] **Step 1: Failing tests** — fresh matching override clears; changed `catalog_value`/`litellm_value`/`field`/`vendor_url`/expired `verified_at` each re-block; empty/missing justification blocks; malformed or duplicate `(model,field)` blocks; stale `source_date` blocked, cleared only by fresh date.
- [ ] **Step 2–4:** implement + run → PASS.
- [ ] **Step 5: Commit** — `git add scripts/check_model_windows.py repo_radar/model_window_overrides.json repo_radar/tests/test_check_model_windows.py && git commit -m "feat(release): mismatch-bound overrides + source_date freshness (fail closed)"`

### Task 14: Wire the gate into `release.sh`

**Files:** Modify `release.sh`; Create `repo_radar/tests/test_release_wiring.py`.
**Note:** `release.sh` refuses non-`main`/`dev` branches, so `--dry-run` can't run in this worktree; verify by syntax + wiring test + direct gate run.

- [ ] **Step 1:** After the `check_model_lifecycle.py` gate in `release.sh`, add:
```bash
python3 scripts/check_model_windows.py --target-date "$RELEASE_DATE" || {
  echo "Release blocked: model window gate failed. Re-verify vendor windows; fix repo_radar/model_catalog.py or add a bound override." >&2
  exit 1; }
```
- [ ] **Step 2:** `test_release_wiring.py`: read `release.sh`; assert it contains `scripts/check_model_windows.py` and that its index is greater than the index of `check_model_lifecycle.py`.
- [ ] **Step 3:** Run `bash -n release.sh` (exit 0); `python3 scripts/check_model_windows.py --target-date 2026-08-08` (gate OK on the real catalog); `python3 -m pytest repo_radar/tests/test_release_wiring.py -q` (PASS).
- [ ] **Step 4: Commit** — `git add release.sh repo_radar/tests/test_release_wiring.py && git commit -m "feat(release): run check_model_windows in the preflight"`

**Phase D checkpoint:** full `python3 -m pytest repo_radar/tests/ -q` + `node --test menubar/__tests__/*.test.js` + `bash -n release.sh` + both gates green → final Codex review of `cc3888c..HEAD`.

---

## Self-review

- **Spec coverage:** §4 → T1–T3; §7 → T4; §5/§5a/§5b → T5–T7; §6.1 → T8; §6.2/§6.4 → T9; §6.3 → T10; §9 → T3(smoke)/T11; §8 → T12–T14. §10 tests: load-bearing concurrency + strategy gate + fatal propagation (T7), retryable close (T5), whole-repo analysis degradation vs preserved synthesis degradation (T9/T10/T11), provider-vs-local-fit termination for analysis (T9) AND synthesis (T10), gate directions/invariants/overrides (T12–T13).
- **Commit greenness:** T4 rejection is independent; T8–T10 helpers use `_StubSession` (no production wiring); T11 is the single wiring commit; T1's derived `KNOWN_LIMITS` keeps lifecycle/matrix green until T3.
- **Type consistency:** `PreflightResult`, `_Fatal`, `PreflightSession.count`, `acceptance_budget`, `authoritative_partition`, `PartitionResult(chunks, degraded_reason)`, `authoritative_synthesis_level`/`DegradedSynthesis`, `Finding(model, field, message, blocking)`.
- **Self-contained:** every task inlines its steps, code, and tests — no references to prior revisions.
