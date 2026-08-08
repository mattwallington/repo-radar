# Count-Tokens Preflight (Branch 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** revision 2 (after Codex plan-review round 1 — 7 IMPORTANT + 1 MINOR incorporated)

**Goal:** Budget every Claude prompt actually sent against Anthropic's authoritative count (via `litellm.acount_tokens`), falling back to the complete Branch 1 conservative path when that count is unavailable, and harden the model catalog with explicit windows + a release-time validation gate.

**Architecture:** `repo_radar/preflight.py` owns a dedicated asyncio loop thread and a `PreflightSession` whose single guarded coroutine (holding one `asyncio.Lock`) re-checks the memo + per-model breaker, performs/validates the provider call, and updates all shared state on the loop thread. `repo_radar/model_catalog.py` holds explicit capability records + the acceptance-budget math. The send paths in `llm.py` are refactored into **pure helper functions** (fully tested in isolation) that Branch 1's partition decision gates monotonically; a single wiring commit threads one session through `sync.py`. `scripts/check_model_windows.py` validates the catalog against litellm at release.

**Tech Stack:** Python 3.10–3.14, `litellm==1.93.0` (`acount_tokens`), `asyncio`, stdlib `hashlib`/`json`. JS mirror in `menubar/model-policy.js`. Spec: `docs/superpowers/specs/2026-08-07-count-tokens-preflight-design.md` @ `e031b86`.

## Global Constraints

- **No new runtime dependency.** `litellm==1.93.0` `acount_tokens` only; do NOT add the `anthropic` SDK.
- **Python 3.10-safe.** `asyncio.Runner` (3.11+) MUST NOT be required — manage the loop manually.
- **Never less safe than Branch 1.** A non-authoritative count → the *complete, unchanged* Branch 1 path.
- **Authoritative gate = ALL of:** `tokenizer_type == "anthropic_api"`; `error is False`; `isinstance(total_tokens, int) and not isinstance(total_tokens, bool)`; `total_tokens > 0`; **both** `request_model` and `model_used` present and equal to the requested model (fail closed if either is absent or mismatched).
- **Fallback catches `Exception` only** (not `BaseException`): `asyncio.CancelledError`, `KeyboardInterrupt`, `SystemExit` propagate; `asyncio.TimeoutError`/provider errors → non-authoritative.
- **Monotonic.** Authoritative counting may only split/tighten Branch 1's partition — never merge or reverse `chunk→single`.
- **Vendor canonical; litellm is drift evidence.** Gate BLOCKs when catalog value > litellm value (`max_input` AND `max_output`); WARNs on the reverse; overrides bind the exact `{model, field, catalog_value, litellm_value}` tuple.
- **requested_output per site:** chunk analysis = `8192`, unchunked full-repo = `16384`, synthesis = `16384`.
- **HEADROOM = `ceil(0.01 × min(max_input, total_context − requested_output))`.**
- **All tests mock `acount_tokens`.** No live API in the suite.
- **Commit hygiene:** stage by exact filename; every commit is green.

---

## Phase A — Catalog foundation

### Task 1: `model_catalog.py` — the complete, verified capability table

**Files:** Create `repo_radar/model_catalog.py`; Modify `repo_radar/llm.py`; Test `repo_radar/tests/test_model_catalog.py`.

**Interfaces:** Produces `ModelCaps(total_context, max_input, max_output, count_strategy, source_url, source_date)`; `MODEL_CAPS: dict[str, ModelCaps]`; `get_caps(model) -> ModelCaps | None`; `is_known_model(model) -> bool`. `llm.KNOWN_LIMITS` becomes a derived compat export `{m: caps.max_input}`.

- [ ] **Step 1: Write the failing test**

```python
# repo_radar/tests/test_model_catalog.py
import repo_radar.model_catalog as mc

def test_every_record_is_well_formed():
    for model, c in mc.MODEL_CAPS.items():
        assert isinstance(c.max_input, int) and not isinstance(c.max_input, bool) and c.max_input > 0, model
        assert isinstance(c.max_output, int) and c.max_output > 0, model
        assert c.max_input <= c.total_context, model
        assert c.count_strategy in ("anthropic_api", "local"), model
        assert c.source_url.startswith("https://"), model

def test_claude_uses_anthropic_api_others_local():
    assert mc.get_caps("claude-opus-5").count_strategy == "anthropic_api"
    assert mc.get_caps("gpt-5.4-mini").count_strategy == "local"
    assert mc.get_caps("gemini/gemini-3.6-flash").count_strategy == "local"

def test_unknown_model_is_not_known():
    assert mc.is_known_model("no-such-model") is False and mc.get_caps("no-such-model") is None
```

- [ ] **Step 2: Run** → FAIL (module missing).

- [ ] **Step 3: Write the module with the COMPLETE table** (values generated from `litellm.get_model_info` on 2026-08-08; `total_context == max_input` because litellm exposes no separate total-context field and, for Anthropic, output shares the input window):

```python
# repo_radar/model_catalog.py
"""Explicit per-model capability catalog (Branch 2). VENDOR DOCS ARE CANONICAL; litellm is only a
release-time drift cross-check (scripts/check_model_windows.py). Values verified 2026-08-08 against
litellm 1.93.0 get_model_info; total_context == max_input (litellm has no separate total field, and
for Anthropic the generated output shares the input window)."""
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
    "gpt-5.4-mini": ModelCaps(272000, 272000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5.4-nano": ModelCaps(272000, 272000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5.3-codex": ModelCaps(272000, 272000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5.2": ModelCaps(272000, 272000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5.2-pro": ModelCaps(272000, 272000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5.1": ModelCaps(272000, 272000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5": ModelCaps(272000, 272000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5-mini": ModelCaps(272000, 272000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5-nano": ModelCaps(272000, 272000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-4.1": ModelCaps(1047576, 1047576, 32768, "local", _OPE, "2026-08-08"),
    "gpt-4.1-mini": ModelCaps(1047576, 1047576, 32768, "local", _OPE, "2026-08-08"),
    "gpt-4.1-nano": ModelCaps(1047576, 1047576, 32768, "local", _OPE, "2026-08-08"),
    "gpt-4o": ModelCaps(128000, 128000, 16384, "local", _OPE, "2026-08-08"),
    "gpt-4o-mini": ModelCaps(128000, 128000, 16384, "local", _OPE, "2026-08-08"),
    "gpt-4-turbo": ModelCaps(128000, 128000, 4096, "local", _OPE, "2026-08-08"),
    "o4-mini": ModelCaps(200000, 200000, 100000, "local", _OPE, "2026-08-08"),
    "o3": ModelCaps(200000, 200000, 100000, "local", _OPE, "2026-08-08"),
    "o3-mini": ModelCaps(200000, 200000, 100000, "local", _OPE, "2026-08-08"),
    "o3-pro": ModelCaps(200000, 200000, 100000, "local", _OPE, "2026-08-08"),
    "o1": ModelCaps(200000, 200000, 100000, "local", _OPE, "2026-08-08"),
    "o1-pro": ModelCaps(200000, 200000, 100000, "local", _OPE, "2026-08-08"),
}

def get_caps(model):
    return MODEL_CAPS.get(model)

def is_known_model(model):
    return model in MODEL_CAPS
```

- [ ] **Step 4: Derive back-compat in `llm.py`.** Replace the `KNOWN_LIMITS = {...}` literal with:

```python
from repo_radar.model_catalog import MODEL_CAPS, get_caps, is_known_model
KNOWN_LIMITS = {m: c.max_input for m, c in MODEL_CAPS.items()}  # intentional compatibility export
```

- [ ] **Step 5: Run** `python3 -m pytest repo_radar/tests/test_model_catalog.py -q` → PASS.
- [ ] **Step 6: Commit** — `git add repo_radar/model_catalog.py repo_radar/llm.py repo_radar/tests/test_model_catalog.py && git commit -m "feat(catalog): complete verified MODEL_CAPS table + derived KNOWN_LIMITS"`

### Task 2: `acceptance_budget(model, requested_output)`

**Files:** Modify `repo_radar/model_catalog.py`; Test `repo_radar/tests/test_model_catalog.py`.
**Interfaces:** Produces `acceptance_budget(model, requested_output) -> int`; `HEADROOM_FRACTION = 0.01`.

- [ ] **Step 1: Failing test**

```python
import math
def test_budget_subtracts_requested_output_and_1pct_no_pre_subtract_of_output():
    ceiling = min(1_000_000, 1_000_000 - 8192)
    assert mc.acceptance_budget("claude-opus-5", 8192) == ceiling - math.ceil(0.01 * ceiling)
    assert mc.acceptance_budget("claude-opus-5", 8192) > 900_000  # ~982k, NOT 872k
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
- [ ] **Step 5: Commit** — `git commit -m "feat(catalog): acceptance_budget (1% headroom, no max_output pre-subtraction)"`

### Task 3: Migrate every `KNOWN_LIMITS` consumer to `MODEL_CAPS`

**Files:** Modify `menubar/model-policy.js`, `menubar/__tests__/drift-check.js`, `repo_radar/tests/test_litellm_matrix.py`, `scripts/check_model_lifecycle.py`, `repo_radar/tests/test_lifecycle_gate.py`, `menubar/scripts/upgrade-smoke.sh`.

**Rationale for the matrix change (finding #6):** the matrix test must NOT assert exact window equality — that would fail on a safe `catalog < litellm` WARN and on an approved stale-litellm override before the release gate can honor them. Window *validation* moves entirely to the Task 14 gate; the matrix test keeps only resolvability/provider/mode.

- [ ] **Step 1:** `test_litellm_matrix.py`: iterate `MODEL_CAPS`; assert each id resolves on litellm, `litellm_provider == provider_for_model(id)`, and `mode in ("chat","responses")`. **Remove** the `max_input_tokens == table` assertion (now the gate's job). Collect all problems (keep the existing pattern).
- [ ] **Step 2:** `scripts/check_model_lifecycle.py`: import `from repo_radar.model_catalog import MODEL_CAPS` and use `set(MODEL_CAPS)` for the known-id set (instead of `llm.KNOWN_LIMITS`); update `test_lifecycle_gate.py` to match. Run `python3 scripts/check_model_lifecycle.py --target-date 2026-08-08` → gate OK.
- [ ] **Step 3:** `menubar/model-policy.js`: add a `MODEL_CAPS` mirror (`{model: {max_input, max_output}}`); derive `KNOWN_MODEL_IDS` from its keys. `menubar/__tests__/drift-check.js`: assert JS caps `{max_input, max_output}` equal Python `MODEL_CAPS` for every model. Run `node menubar/__tests__/drift-check.js` → `drift OK`.
- [ ] **Step 4:** `menubar/scripts/upgrade-smoke.sh`: change the smoke assertion to read a value **from `MODEL_CAPS`** (e.g. assert `get_caps("gpt-5.3-codex").max_input == 272000`) so the packaged catalog can't be dead code. Confirm the smoke line matches.
- [ ] **Step 5: Run** `python3 -m pytest repo_radar/tests/test_litellm_matrix.py repo_radar/tests/test_lifecycle_gate.py -q && node menubar/__tests__/drift-check.js` → PASS/`drift OK`.
- [ ] **Step 6: Commit** — stage the six files; `git commit -m "refactor(catalog): migrate matrix/lifecycle/drift/smoke consumers to MODEL_CAPS"`

**Phase A checkpoint:** full `python3 -m pytest repo_radar/tests/ -q` + `node --test menubar/__tests__/*.test.js` green → Codex review of Phase A.

---

## Phase B — Preflight counter (`repo_radar/preflight.py`)

### Task 4: `PreflightLoop` — dedicated Py3.10-safe loop thread

**Files:** Create `repo_radar/preflight.py`; Test `repo_radar/tests/test_preflight.py`.
**Interfaces:** Produces `class PreflightLoop`: `start()`, `submit(coro) -> Any` (runs `coro` on the loop from any thread, returns its result), `close()` (cancel/drain pending, stop, join, close), `is_closed()`. No lock here — serialization lives in Task 6's guarded coroutine.

- [ ] **Step 1: Failing test**

```python
# repo_radar/tests/test_preflight.py
import asyncio, repo_radar.preflight as pf
def test_loop_runs_and_closes_with_drain():
    loop = pf.PreflightLoop(); loop.start()
    async def val(): await asyncio.sleep(0); return 42
    try: assert loop.submit(val()) == 42
    finally: loop.close()
    assert loop.is_closed()
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**

```python
# repo_radar/preflight.py
import asyncio, threading, hashlib, json, logging
logger = logging.getLogger("repo_radar.preflight")

class PreflightLoop:
    def __init__(self):
        self._loop = None; self._thread = None; self._closed = False
    def start(self):
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._loop.run_forever, name="preflight-loop", daemon=True)
        self._thread.start()
    def submit(self, coro):
        return asyncio.run_coroutine_threadsafe(coro, self._loop).result()
    def close(self):
        if self._closed: return
        self._closed = True
        async def _drain():
            pending = [t for t in asyncio.all_tasks(self._loop) if t is not asyncio.current_task()]
            for t in pending: t.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
        try: asyncio.run_coroutine_threadsafe(_drain(), self._loop).result(timeout=5)
        finally:
            self._loop.call_soon_threadsafe(self._loop.stop); self._thread.join(timeout=5); self._loop.close()
    def is_closed(self): return self._closed
```

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(preflight): Py3.10-safe dedicated loop thread with drain-on-close"`

### Task 5: `_count_once` coroutine + authoritative gate (fail-closed identity)

**Files:** Modify `repo_radar/preflight.py`, `repo_radar/llm.py` (`_completion_messages`); Test `repo_radar/tests/test_preflight.py`.
**Interfaces:** Produces `PreflightResult = namedtuple("PreflightResult", "tokens authoritative")`; `_is_authoritative(resp, model) -> bool`; `async _count_once(model, prompt, timeout_s) -> PreflightResult`; `llm._completion_messages(prompt) -> list[dict]` (shared by `call_llm` AND the counter).

- [ ] **Step 1: Failing tests** (fail-closed identity + exception handling)

```python
from unittest.mock import patch
from types import SimpleNamespace
import asyncio, repo_radar.preflight as pf
def _resp(total, tt="anthropic_api", error=False, rm="claude-opus-5", mu="claude-opus-5"):
    return SimpleNamespace(total_tokens=total, tokenizer_type=tt, error=error, request_model=rm, model_used=mu)

def test_authoritative_only_when_all_conditions_hold():
    assert pf._is_authoritative(_resp(1234), "claude-opus-5") is True
    assert pf._is_authoritative(_resp(1234, tt="local_tokenizer"), "claude-opus-5") is False
    assert pf._is_authoritative(_resp(0), "claude-opus-5") is False
    assert pf._is_authoritative(_resp(True), "claude-opus-5") is False           # bool
    assert pf._is_authoritative(_resp(5, error=True), "claude-opus-5") is False
    assert pf._is_authoritative(_resp(5, rm="wrong", mu="wrong"), "claude-opus-5") is False  # fail-closed
    assert pf._is_authoritative(SimpleNamespace(total_tokens=5, tokenizer_type="anthropic_api", error=False),
                                "claude-opus-5") is False                         # missing identity → closed

def test_count_once_maps_timeout_and_errors_to_non_authoritative():
    async def slow(**kw):
        await asyncio.sleep(1); return _resp(5)
    loop = pf.PreflightLoop(); loop.start()
    with patch("litellm.acount_tokens", slow):
        assert loop.submit(pf._count_once("claude-opus-5", "x", 0.01)).authoritative is False  # timeout
    async def boom(**kw): raise RuntimeError("net")
    with patch("litellm.acount_tokens", boom):
        assert loop.submit(pf._count_once("claude-opus-5", "x", 5)).authoritative is False
    loop.close()
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Add `_completion_messages` in `llm.py`** and switch `call_llm`'s completion branch to use it:

```python
def _completion_messages(prompt):
    """Exact messages structure call_llm sends on the completion path — single source of truth for
    both the sender and the preflight counter."""
    return [{"role": "user", "content": prompt}]
```

- [ ] **Step 4: Implement gate + coroutine** (identity fails closed; catch `Exception`, not `BaseException`):

```python
# repo_radar/preflight.py
from collections import namedtuple
import litellm
from repo_radar.llm import _completion_messages
PreflightResult = namedtuple("PreflightResult", "tokens authoritative")

def _is_authoritative(resp, model):
    tt = getattr(resp, "total_tokens", None)
    rm = getattr(resp, "request_model", None); mu = getattr(resp, "model_used", None)
    return (getattr(resp, "tokenizer_type", None) == "anthropic_api"
            and getattr(resp, "error", True) is False
            and isinstance(tt, int) and not isinstance(tt, bool) and tt > 0
            and rm == model and mu == model)              # both present AND equal → else fail closed

async def _count_once(model, prompt, timeout_s):
    try:
        resp = await asyncio.wait_for(
            litellm.acount_tokens(model=model, messages=_completion_messages(prompt)), timeout_s)
    except Exception:                                     # TimeoutError/provider errors → fallback
        return PreflightResult(None, False)               # CancelledError/KeyboardInterrupt/SystemExit propagate
    if _is_authoritative(resp, model):
        return PreflightResult(resp.total_tokens, True)
    return PreflightResult(None, False)
```

- [ ] **Step 5: Run** → PASS; also run `repo_radar/tests/` to confirm `call_llm` unaffected.
- [ ] **Step 6: Commit** — stage `preflight.py`, `llm.py`, `test_preflight.py`; `git commit -m "feat(preflight): authoritative gate (fail-closed identity) + count coroutine"`

### Task 6: `PreflightSession` — loop-owned single-flight (memo + breaker in ONE critical section)

**Files:** Modify `repo_radar/preflight.py`; Test `repo_radar/tests/test_preflight.py`.

**Interfaces:** Produces `class PreflightSession` (context manager) with `count(model, prompt, requested_output) -> PreflightResult`. The memo `{(model,digest): result}`, the per-model breaker `set`, and the log-once `dict` are **only** read/written inside one guarded coroutine that holds `self._lock`, on the loop thread — so concurrent workers can't both miss the memo/breaker or double-call.

- [ ] **Step 1: Failing tests** (the spec's concurrency regressions)

```python
def test_memo_dedupes_by_model_and_payload():
    calls = []
    async def fake(**kw): calls.append(kw["model"]); return _resp(100, rm=kw["model"], mu=kw["model"])
    with patch("litellm.acount_tokens", fake), pf.PreflightSession(timeout_s=5) as s:
        s.count("claude-opus-5", "same", 8192)
        s.count("claude-opus-5", "same", 8192)            # memo hit
        s.count("claude-sonnet-5", "same", 8192)          # different model → new call
    assert calls == ["claude-opus-5", "claude-sonnet-5"]

def test_two_simultaneous_identical_requests_make_one_provider_call():
    import concurrent.futures as cf, threading
    started = threading.Event(); release = threading.Event(); calls = []
    async def fake(**kw):
        calls.append(1); started.set()
        await asyncio.get_event_loop().run_in_executor(None, release.wait)
        return _resp(100, rm=kw["model"], mu=kw["model"])
    with patch("litellm.acount_tokens", fake), pf.PreflightSession(timeout_s=5) as s:
        with cf.ThreadPoolExecutor(max_workers=2) as ex:
            f1 = ex.submit(s.count, "claude-opus-5", "same", 8192)
            started.wait(); release.set()
            f2 = ex.submit(s.count, "claude-opus-5", "same", 8192)
            f1.result(); f2.result()
    assert len(calls) == 1                                # single-flight

def test_breaker_opens_on_first_failure_and_is_per_model():
    calls = []
    async def bad(**kw): calls.append(kw["model"]); return _resp(0, rm=kw["model"], mu=kw["model"])
    with patch("litellm.acount_tokens", bad), pf.PreflightSession(timeout_s=5) as s:
        assert s.count("claude-opus-5", "a", 8192).authoritative is False
        assert s.count("claude-opus-5", "b", 8192).authoritative is False   # breaker open, no call
    assert calls == ["claude-opus-5"]
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the loop-owned state machine:

```python
class PreflightSession:
    def __init__(self, timeout_s=10.0):
        self._loop = PreflightLoop(); self._timeout = timeout_s
        self._memo = {}; self._downgraded = set(); self._logged = set(); self._lock = None
    def __enter__(self):
        self._loop.start()
        self._lock = self._loop.submit(self._make_lock()); return self
    def __exit__(self, *exc): self._loop.close()
    async def _make_lock(self): return asyncio.Lock()

    @staticmethod
    def _key(model, prompt):
        req = json.dumps({"model": model, "messages": _completion_messages(prompt)},
                         sort_keys=True, separators=(",", ":"))
        return (model, hashlib.sha256(req.encode()).hexdigest())

    async def _guarded(self, model, prompt, requested_output):
        async with self._lock:                            # ONE critical section on the loop thread
            if model in self._downgraded:
                return PreflightResult(None, False)
            key = self._key(model, prompt)
            if key in self._memo:
                return self._memo[key]
            result = await _count_once(model, prompt, self._timeout)
            if result.authoritative:
                self._memo[key] = result
            else:
                self._downgraded.add(model)
                if model not in self._logged:
                    self._logged.add(model)
                    logger.warning("preflight: %s downgraded to Branch 1 fallback for this sync", model)
            return result

    def count(self, model, prompt, requested_output):
        return self._loop.submit(self._guarded(model, prompt, requested_output))
```

> Serialization note: `submit` schedules `_guarded` on the loop; `async with self._lock` serializes the memo/breaker re-check + call + state update so two workers cannot both miss and both call. This makes the single-flight critical section genuinely loop-owned (fixes plan-review finding #1).

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(preflight): loop-owned single-flight session (memo+breaker in one critical section)"`

**Phase B checkpoint:** `python3 -m pytest repo_radar/tests/test_preflight.py -q` green → Codex review of Phase B.

---

## Phase C — Monotonic send helpers, then one wiring commit

**Structure (fixes finding #3):** Tasks 8–11 add **pure helpers** in `llm.py` and test them in isolation — they take a `session`-like object and touch NO production `sync.py` wiring. Task 12 is the single green wiring commit. Tasks 9 and 10 land together.

### Task 8: `authoritative_partition` — monotonic single-vs-chunk (§6.1)

**Files:** Modify `repo_radar/llm.py`; Test `repo_radar/tests/test_send_paths.py` (create).
**Interfaces:** `authoritative_partition(session, full_name, files, model) -> str` returning `"single"` or `"chunk"`. Runs Branch 1's `repo_needs_chunking` first; only if it says single does it authoritative-count the full-repo prompt (`requested_output=16384`) and downgrade to `"chunk"` on overflow or non-authoritative-below-Branch-1... (see body). Never returns `"single"` when Branch 1 says chunk.

- [ ] **Step 1: Failing tests**

```python
# repo_radar/tests/test_send_paths.py
class _StubSession:
    def __init__(self, table): self.table = table; self.calls = []
    def count(self, model, prompt, requested_output):
        self.calls.append((model, requested_output))
        from repo_radar.preflight import PreflightResult
        return self.table(prompt)

def test_branch1_chunk_is_never_reversed(monkeypatch):
    import repo_radar.llm as llm
    monkeypatch.setattr(llm, "repo_needs_chunking", lambda *a, **k: (True, 999, False))  # Branch 1: chunk
    s = _StubSession(lambda p: __import__("repo_radar.preflight", fromlist=["PreflightResult"]).PreflightResult(1, True))
    assert llm.authoritative_partition(s, "o/r", [{"path":"a","size":1,"content":"x"}], "claude-opus-5") == "chunk"
    assert s.calls == []                                  # never even counted

def test_branch1_single_stays_single_when_authoritative_fits(monkeypatch):
    import repo_radar.llm as llm
    from repo_radar.preflight import PreflightResult
    monkeypatch.setattr(llm, "repo_needs_chunking", lambda *a, **k: (False, 10, True))   # Branch 1: single
    s = _StubSession(lambda p: PreflightResult(500, True))                                # fits budget
    assert llm.authoritative_partition(s, "o/r", [{"path":"a","size":1,"content":"x"}], "claude-opus-5") == "single"

def test_branch1_single_tightens_to_chunk_when_authoritative_overflows(monkeypatch):
    import repo_radar.llm as llm
    from repo_radar.preflight import PreflightResult
    monkeypatch.setattr(llm, "repo_needs_chunking", lambda *a, **k: (False, 10, True))
    s = _StubSession(lambda p: PreflightResult(10**9, True))                              # overflows
    assert llm.authoritative_partition(s, "o/r", [{"path":"a","size":1,"content":"x"}], "claude-opus-5") == "chunk"
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**

```python
# repo_radar/llm.py
from repo_radar.model_catalog import acceptance_budget, get_caps
FULL_REPO_OUTPUT = 16384

def authoritative_partition(session, full_name, files, model):
    threshold = get_chunking_threshold(model)
    needs_chunk, _v, _exact = repo_needs_chunking(full_name, files, model, threshold)
    if needs_chunk:
        return "chunk"                                    # Branch 1 partition is the ceiling; never reversed
    if get_caps(model).count_strategy != "anthropic_api":
        return "single"                                   # non-Claude: Branch 1 single stands
    prompt = _build_full_repo_prompt(full_name, files)
    r = session.count(model, prompt, FULL_REPO_OUTPUT)
    if r.authoritative and r.tokens <= acceptance_budget(model, FULL_REPO_OUTPUT):
        return "single"
    if r.authoritative:
        return "chunk"                                    # exact count overflows → tighten
    return "single"                                       # non-authoritative → Branch 1 single (already passed 0.75x)
```

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(llm): authoritative_partition (monotonic single-vs-chunk)"`

### Task 9 + 10 (combined): `authoritative_chunks` — fixpoint + progress-guaranteed singleton terminal (§6.2, §6.4)

**Files:** Modify `repo_radar/llm.py`; Test `repo_radar/tests/test_send_paths.py`.
**Interfaces:** `DegradedAnalysis = namedtuple("DegradedAnalysis", "path reason")`; `authoritative_chunks(session, full_name, files, model) -> list` where each element is a `list[file]` chunk OR a `DegradedAnalysis`. Start from Branch 1 `chunk_repo_files`; count each real `(i/N)` prompt; on overflow split and **rebuild+recount the whole set**; a single-file overflow is **binary-searched over content length with an authoritative recount per candidate** (never the local estimate — fixes finding #4); if even the template overflows, yield `DegradedAnalysis`. Non-authoritative at any point → return Branch 1's `chunk_repo_files` result unchanged (fixes "never less safe").

- [ ] **Step 1: Failing tests** — (a) provider overflow forces a split and the final set fits; (b) **provider says overflow while local 1.7× says fit** for a singleton → truncation terminates (binary search) and never sends over budget; (c) template-exceeds-budget singleton → `DegradedAnalysis`; (d) non-authoritative mid-pass → result equals Branch 1 `chunk_repo_files`.

```python
def test_singleton_truncation_terminates_when_provider_overflows_but_local_fits(monkeypatch):
    import repo_radar.llm as llm
    from repo_radar.preflight import PreflightResult
    big = {"path": "big.py", "size": 100, "content": "x" * 5000}
    # provider: fits only when content length <= 100 chars; else overflow. Authoritative always.
    def table(prompt):
        return PreflightResult(10 if ("x"*200 not in prompt) else 10**9, True)
    s = _StubSession(table)
    monkeypatch.setattr(llm, "chunk_repo_files", lambda *a, **k: [[big]])
    out = llm.authoritative_chunks(s, "o/r", [big], "claude-opus-5")
    # terminates; the emitted chunk's real prompt fits the budget
    for c in out:
        if isinstance(c, list):
            assert s.count("claude-opus-5", llm._build_analysis_prompt("o/r", c, 1, len(out)), 8192).tokens \
                   <= llm.acceptance_budget("claude-opus-5", 8192)
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — fit test = `session.count(model, _build_analysis_prompt(full_name, chunk, i, N), 8192).tokens <= acceptance_budget(model, 8192)` **only when authoritative**; if any count is non-authoritative, `return chunk_repo_files(files, model, full_name=full_name)`. Multi-file overflow → largest-prefix split + whole-set rebuild/recount (mirror Branch 1's loop but with authoritative fit). Singleton overflow → `_authoritative_truncate_file(session, full_name, file, model)`:

```python
CHUNK_OUTPUT = 8192
def _authoritative_truncate_file(session, full_name, file_info, model):
    """Binary search on content length with an authoritative recount per candidate (progress
    guaranteed). Returns a truncated file dict, or None if even 1 char + template overflows."""
    budget = acceptance_budget(model, CHUNK_OUTPUT)
    original = file_info["content"]
    def fits(keep):
        cand = {**file_info, "content": original[:keep] + f"\n\n... (truncated to fit budget)"}
        r = session.count(model, _build_analysis_prompt(full_name, [cand], 1, 1), CHUNK_OUTPUT)
        return (r.authoritative and r.tokens <= budget), cand, r.authoritative
    ok1, cand1, auth1 = fits(1)
    if not auth1: raise _NonAuthoritative()
    if not ok1: return None                               # template floor: degrade, no send
    lo, hi, best = 1, len(original), cand1
    while lo <= hi:
        mid = (lo + hi) // 2
        ok, cand, auth = fits(mid)
        if not auth: raise _NonAuthoritative()
        if ok: best, lo = cand, mid + 1
        else: hi = mid - 1
    return best
```
Wrap the whole builder in `try/except _NonAuthoritative: return chunk_repo_files(files, model, full_name=full_name)`.

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(llm): authoritative_chunks fixpoint + progress-guaranteed singleton terminal"`

### Task 11: `authoritative_synthesis_level` — per-level split-only (§6.3)

**Files:** Modify `repo_radar/llm.py`; Test `repo_radar/tests/test_send_paths.py`.
**Interfaces:** `authoritative_synthesis_level(session, full_name, analyses, model) -> list[list[str]]` — start from Branch 1's largest batches (`_synthesis_budget`), authoritative-count each with `requested_output=16384`, split (never coalesce) the current level until each fits; non-authoritative → Branch 1 batching for this level. Called once per hierarchical level by `combine_chunk_analyses`.

- [ ] **Step 1: Failing tests** — one over-budget batch splits (more batches); a batch above Branch 1's synthesis budget but below the authoritative ceiling still uses Branch 1's (larger) grouping as the ceiling (only split); non-authoritative → Branch 1 batches.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the level splitter (largest-prefix on the analyses list; fit = authoritative count of `_build_synthesis_prompt(full_name, batch)` ≤ `acceptance_budget(model, 16384)`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(llm): authoritative_synthesis_level (per-level split-only)"`

### Task 12: One wiring commit — thread a `PreflightSession` through `sync.py` (§9)

**Files:** Modify `repo_radar/modes/sync.py`, `repo_radar/llm.py` (`combine_chunk_analyses` accepts `session=None`); Test `repo_radar/tests/test_send_paths.py`.
**Interfaces:** `combine_chunk_analyses(full_name, analyses, model=None, synthesize=None, session=None)` — when `session` is provided, each level goes through `authoritative_synthesis_level`. `sync_mode` wraps the metadata loop in `with PreflightSession() as session:` and passes it into the partition/chunk/synthesis calls.

- [ ] **Step 1: Failing tests** — landmark: `sync.py` references `PreflightSession` and passes `session` into `authoritative_partition`, `authoritative_chunks`, `combine_chunk_analyses`; behavioral: with a stubbed authoritative count, the exact payload digest is counted **before** the corresponding `call_llm` for chunk, full-repo, and synthesis sends.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the wiring (single commit; all three paths now consume `session`).
- [ ] **Step 4: Run** full `python3 -m pytest repo_radar/tests/ -q` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(sync): thread one PreflightSession through all three send paths"`

**Phase C checkpoint:** full suite green → Codex review of Phase C.

---

## Phase D — Fail-closed rejection + release gate

### Task 13: Reject unknown models before the network wait (§7)

**Files:** Modify `repo_radar/modes/sync.py`; Test `repo_radar/tests/test_send_paths.py`.
**Interfaces:** Guard at the top of `sync_mode`, **before** `wait_for_network` (`sync.py:290`). Metadata-capable predicate: `not getattr(args,"skip_metadata",False) and not getattr(args,"repos_only",False)`. If metadata-capable and `not is_known_model(get_ai_model())` → exit with an actionable message naming the model + `repo_radar/model_catalog.py`.

- [ ] **Step 1: Failing test** — unknown model + metadata mode ⇒ rejection with `wait_for_network` **and** git ops NOT called (patch both, assert `call_count == 0`); `skip_metadata=True` + unknown model ⇒ proceeds past the guard.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the guard before line 290.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(sync): fail-closed reject uncatalogued models before network wait"`

### Task 14: `check_model_windows.py` gate — directional + invariants (§8)

**Files:** Create `scripts/check_model_windows.py`, `repo_radar/tests/test_check_model_windows.py`.
**Interfaces:** `check(caps_map, litellm_info, overrides, target_date) -> list[Finding]`; `Finding = namedtuple("Finding", "model field message blocking")`. CLI `--target-date`. `litellm_info` is injectable `model -> {"max_input_tokens","max_output_tokens"}` (tests pass a stub).

- [ ] **Step 1: Failing tests** — catalog `max_input` > litellm ⇒ blocking; `max_output` > litellm ⇒ blocking; catalog < litellm ⇒ non-blocking WARN; schema invariants each ⇒ blocking (non-positive/`bool`/unknown-strategy/`max_input>total_context`/future-or-invalid `source_date`/non-https `source_url`); every mismatch reported (two bad rows ⇒ two findings).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the stdlib gate (compare `max_input`/`max_output` only — never `total_context`, litellm has none).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(release): check_model_windows gate (directional, invariants, reports all)"`

### Task 15: Mismatch-bound overrides + `source_date` freshness (§8)

**Files:** Create `repo_radar/model_window_overrides.json` (empty `[]` to start); Modify `scripts/check_model_windows.py`, `repo_radar/tests/test_check_model_windows.py`.
**Interfaces:** Override record `{model, field, catalog_value, litellm_value, vendor_url, verified_at, justification}`. Clears a BLOCK only when all of `{model, field, catalog_value, litellm_value}` match a live-computed mismatch AND `verified_at` within 90 days of `target_date`. `source_date` older than 90 days ⇒ blocking, cleared only by refreshing that record's own `source_date` (NOT an override).

- [ ] **Step 1: Failing tests** — matching fresh override clears the block; changed `catalog_value` / changed `litellm_value` / changed `field` / expired `verified_at` each re-block; stale catalog `source_date` blocks and is cleared only by a fresh `source_date`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** override loading + exact-tuple binding + expiry + the `source_date` rule.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git add scripts/check_model_windows.py repo_radar/model_window_overrides.json repo_radar/tests/test_check_model_windows.py && git commit -m "feat(release): mismatch-bound overrides + source_date freshness"`

### Task 16: Wire the gate into `release.sh` (verifiable in the worktree)

**Files:** Modify `release.sh`; Create `repo_radar/tests/test_release_wiring.py`.
**Note (fixes MINOR #8):** `release.sh` refuses non-`main`/`dev` branches, so `--dry-run` can't run in this worktree. Verify via `bash -n`, a wiring test, and a direct gate run instead.

- [ ] **Step 1:** Add after the `check_model_lifecycle.py` gate in `release.sh`:
```bash
python3 scripts/check_model_windows.py --target-date "$RELEASE_DATE" || {
  echo "Release blocked: model window gate failed. Re-verify vendor windows and fix repo_radar/model_catalog.py or add a bound override." >&2
  exit 1; }
```
- [ ] **Step 2:** `test_release_wiring.py`: assert `release.sh` text contains `scripts/check_model_windows.py` and it appears after `check_model_lifecycle.py`.
- [ ] **Step 3:** Run `bash -n release.sh` (syntax) → exit 0; `python3 scripts/check_model_windows.py --target-date 2026-08-08` → gate OK on the real catalog; `python3 -m pytest repo_radar/tests/test_release_wiring.py -q` → PASS.
- [ ] **Step 4: Commit** — `git add release.sh repo_radar/tests/test_release_wiring.py && git commit -m "feat(release): run check_model_windows in the release preflight"`

**Phase D checkpoint:** full `python3 -m pytest repo_radar/tests/ -q` + `node --test menubar/__tests__/*.test.js` + `bash -n release.sh` + both gates green → final Codex review of the whole branch (`cc3888c..HEAD`).

---

## Self-review (run before handoff)

- **Spec coverage:** §4 → Tasks 1–3; §5 gate/identity → Task 5; §5a loop+lock+breaker → Tasks 4/6; §5b memo → Task 6; §6.1 → Task 8; §6.2 → Task 9+10; §6.4 → Task 9+10; §6.3 → Task 11; §9 wiring/no-dead-code → Tasks 3(smoke)/12; §7 → Task 13; §8 gate+overrides → Tasks 14–16; §10 tests distributed to owning tasks incl. the three concurrency regressions (Task 6) and the local-fit-vs-provider-overflow termination test (Task 9+10).
- **Commit greenness:** Phase C helpers (Tasks 8–11) touch only `llm.py` + a new test file and are green in isolation; production wiring is the single Task 12 commit. Task 1's derived `KNOWN_LIMITS` keeps the lifecycle gate + matrix green at that commit; Task 3 then migrates consumers off exact-equality.
- **Type consistency:** `PreflightResult(tokens, authoritative)`, `PreflightSession.count(model, prompt, requested_output)`, `acceptance_budget(model, requested_output)`, `get_caps`/`is_known_model`, `_completion_messages(prompt)`, `authoritative_partition`/`authoritative_chunks`/`authoritative_synthesis_level`, `DegradedAnalysis(path, reason)`, `Finding(model, field, message, blocking)` used consistently.
- **No `git add -A`:** every commit stages exact files.
