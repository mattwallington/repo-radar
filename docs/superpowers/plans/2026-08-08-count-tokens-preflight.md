# Count-Tokens Preflight (Branch 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** revision 3 (after Codex plan-review rounds 1–2).

**Goal:** Budget every Claude prompt actually sent against Anthropic's authoritative count (via `litellm.acount_tokens`), falling back to the complete Branch 1 conservative path when that count is unavailable, and harden the model catalog with explicit windows + a release-time validation gate.

**Architecture:** `repo_radar/preflight.py` owns a dedicated asyncio loop thread and a `PreflightSession` whose single guarded coroutine (holding one `asyncio.Lock`) applies the count-strategy gate, re-checks the memo + per-model breaker, performs/validates the provider call, and updates all shared state on the loop thread; fatal signals are marshalled back to the caller thread. `repo_radar/model_catalog.py` holds explicit capability records + budget math. The send paths are pure helpers (tested in isolation) that Branch 1's partition gates monotonically; one wiring commit threads a session through `sync.py`. `scripts/check_model_windows.py` validates the catalog at release.

**Tech Stack:** Python 3.10–3.14, `litellm==1.93.0`, `asyncio`, stdlib. JS mirror `menubar/model-policy.js`. Spec: `docs/superpowers/specs/2026-08-07-count-tokens-preflight-design.md` @ `e031b86`.

## Global Constraints

- **No new runtime dependency.** `litellm==1.93.0` `acount_tokens` only; no `anthropic` SDK.
- **Python 3.10-safe.** No `asyncio.Runner` (3.11+).
- **Never less safe than Branch 1.** Non-authoritative → the complete, unchanged Branch 1 path.
- **Authoritative gate = ALL of:** `tokenizer_type == "anthropic_api"`; `error is False`; `total_tokens` is `int` and not `bool` and `> 0`; `request_model == model` AND `model_used == model` (both present; absent/mismatch → not authoritative).
- **Strategy gate is central:** only `count_strategy == "anthropic_api"` reaches the provider; a `local` (or unknown) model returns non-authoritative with **no provider call, no breaker mutation, no downgrade log**.
- **Fatal signals propagate:** inside the loop coroutine catch `Exception` → non-authoritative; catch `KeyboardInterrupt`/`SystemExit` → return a private `_Fatal` envelope that the caller thread re-raises (so the loop thread never dies silently).
- **Model-aware output:** the actual output requested is `effective_output(model, nominal) = min(nominal, caps.max_output)`, threaded through `call_llm` AND `acceptance_budget`. Nominal per shape: chunk `8192`, full-repo `16384`, synthesis `16384`.
- **Monotonic.** Authoritative counting may only split/tighten Branch 1's partition — never merge or reverse `chunk→single`.
- **HEADROOM = `ceil(0.01 × min(max_input, total_context − effective_output))`.**
- **Vendor canonical; litellm is drift evidence.** Gate BLOCKs catalog>litellm for `max_input`/`max_output`; WARNs the reverse; overrides bind `{model, field, catalog_value, litellm_value, vendor_url}` + freshness.
- **All tests mock `acount_tokens`.** Commit hygiene: stage exact files; every commit green.

---

## Phase A — Catalog foundation + fail-closed rejection

### Task 1: `model_catalog.py` — complete verified table (provider-aware `total_context`)

**Files:** Create `repo_radar/model_catalog.py`; Modify `repo_radar/llm.py`; Test `repo_radar/tests/test_model_catalog.py`.
**Interfaces:** `ModelCaps(total_context, max_input, max_output, count_strategy, source_url, source_date)`; `MODEL_CAPS`; `get_caps(model)`; `is_known_model(model)`. `llm.KNOWN_LIMITS = {m: c.max_input}` (compat export).

**`total_context` rule (vendor-grounded, NOT litellm max_input):** Anthropic uses a *shared* window, so `total_context == max_input` (input may occupy the whole context). OpenAI/Gemini publish *separate* input and output budgets, so `total_context == max_input + max_output` — this yields the vendor-documented 400K for the gpt-5.x-272K family (`llm.py:71` records "400K total, 128K output, 272K input"). `total_context` is used in `acceptance_budget` only for `anthropic_api` models; for `local` models it exists only to make the `max_input <= total_context` invariant meaningful.

- [ ] **Step 1: Failing tests** (well-formedness + pinned vendor semantics)

```python
import repo_radar.model_catalog as mc
def test_record_invariants():
    for m, c in mc.MODEL_CAPS.items():
        for v in (c.total_context, c.max_input, c.max_output):
            assert isinstance(v, int) and not isinstance(v, bool) and v > 0, m
        assert c.max_input <= c.total_context, m
        assert c.count_strategy in ("anthropic_api", "local") and c.source_url.startswith("https://"), m

def test_openai_400k_family_is_vendor_exact():
    for m in ("gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.3-codex"):
        c = mc.get_caps(m)
        assert (c.total_context, c.max_input, c.max_output) == (400000, 272000, 128000), m

def test_anthropic_total_equals_shared_window():
    c = mc.get_caps("claude-opus-5")
    assert c.total_context == c.max_input == 1_000_000 and c.count_strategy == "anthropic_api"

def test_unknown_model_absent():
    assert mc.is_known_model("no-such") is False and mc.get_caps("no-such") is None
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Write the module** with the header/accessors from rev 2 and this COMPLETE table (values verified 2026-08-08 vs `litellm.get_model_info`; `total_context` per the rule above):

```python
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
    "gemini/gemini-3.6-flash": ModelCaps(1114112, 1048576, 65536, "local", _GEM, "2026-08-08"),
    "gemini/gemini-3.5-flash": ModelCaps(1114111, 1048576, 65535, "local", _GEM, "2026-08-08"),
    "gemini/gemini-3.1-pro-preview": ModelCaps(1114112, 1048576, 65536, "local", _GEM, "2026-08-08"),
    "gemini/gemini-3.1-flash-lite": ModelCaps(1114112, 1048576, 65536, "local", _GEM, "2026-08-08"),
    "gemini/gemini-3-flash-preview": ModelCaps(1114111, 1048576, 65535, "local", _GEM, "2026-08-08"),
    "gemini/gemini-2.5-pro": ModelCaps(1114111, 1048576, 65535, "local", _GEM, "2026-08-08"),
    "gemini/gemini-2.5-flash": ModelCaps(1114111, 1048576, 65535, "local", _GEM, "2026-08-08"),
    "gemini/gemini-2.5-flash-lite": ModelCaps(1114111, 1048576, 65535, "local", _GEM, "2026-08-08"),
    "gemini/gemini-pro-latest": ModelCaps(1114111, 1048576, 65535, "local", _GEM, "2026-08-08"),
    "gemini/gemini-flash-latest": ModelCaps(1114111, 1048576, 65535, "local", _GEM, "2026-08-08"),
    "gemini/gemini-flash-lite-latest": ModelCaps(1114111, 1048576, 65535, "local", _GEM, "2026-08-08"),
    "gpt-5.6-sol": ModelCaps(1178000, 1050000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5.6-terra": ModelCaps(1178000, 1050000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5.6-luna": ModelCaps(1178000, 1050000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5.5": ModelCaps(1178000, 1050000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5.5-pro": ModelCaps(1178000, 1050000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5.4": ModelCaps(1178000, 1050000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5.4-pro": ModelCaps(1178000, 1050000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5.4-mini": ModelCaps(400000, 272000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5.4-nano": ModelCaps(400000, 272000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5.3-codex": ModelCaps(400000, 272000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5.2": ModelCaps(400000, 272000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5.2-pro": ModelCaps(400000, 272000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5.1": ModelCaps(400000, 272000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5": ModelCaps(400000, 272000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5-mini": ModelCaps(400000, 272000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-5-nano": ModelCaps(400000, 272000, 128000, "local", _OPE, "2026-08-08"),
    "gpt-4.1": ModelCaps(1080344, 1047576, 32768, "local", _OPE, "2026-08-08"),
    "gpt-4.1-mini": ModelCaps(1080344, 1047576, 32768, "local", _OPE, "2026-08-08"),
    "gpt-4.1-nano": ModelCaps(1080344, 1047576, 32768, "local", _OPE, "2026-08-08"),
    "gpt-4o": ModelCaps(144384, 128000, 16384, "local", _OPE, "2026-08-08"),
    "gpt-4o-mini": ModelCaps(144384, 128000, 16384, "local", _OPE, "2026-08-08"),
    "gpt-4-turbo": ModelCaps(132096, 128000, 4096, "local", _OPE, "2026-08-08"),
    "o4-mini": ModelCaps(300000, 200000, 100000, "local", _OPE, "2026-08-08"),
    "o3": ModelCaps(300000, 200000, 100000, "local", _OPE, "2026-08-08"),
    "o3-mini": ModelCaps(300000, 200000, 100000, "local", _OPE, "2026-08-08"),
    "o3-pro": ModelCaps(300000, 200000, 100000, "local", _OPE, "2026-08-08"),
    "o1": ModelCaps(300000, 200000, 100000, "local", _OPE, "2026-08-08"),
    "o1-pro": ModelCaps(300000, 200000, 100000, "local", _OPE, "2026-08-08"),
```

- [ ] **Step 4:** In `llm.py`, `from repo_radar.model_catalog import MODEL_CAPS, get_caps, is_known_model` and `KNOWN_LIMITS = {m: c.max_input for m, c in MODEL_CAPS.items()}`.
- [ ] **Step 5: Run** → PASS.
- [ ] **Step 6: Commit** — `git add repo_radar/model_catalog.py repo_radar/llm.py repo_radar/tests/test_model_catalog.py && git commit -m "feat(catalog): verified MODEL_CAPS (provider-aware total_context)"`

### Task 2: `acceptance_budget` + `effective_output`

**Files:** Modify `repo_radar/model_catalog.py`; Test `repo_radar/tests/test_model_catalog.py`.
**Interfaces:** `effective_output(model, nominal) -> int` (= `min(nominal, caps.max_output)`); `acceptance_budget(model, requested_output) -> int`; `HEADROOM_FRACTION = 0.01`.

- [ ] **Step 1: Failing tests**

```python
import math
def test_effective_output_clamps_to_max_output():
    assert mc.effective_output("claude-opus-5", 16384) == 16384
    assert mc.effective_output("gpt-4-turbo", 16384) == 4096      # clamp: max_output=4096

def test_budget_uses_effective_output_and_1pct_headroom():
    ceiling = min(1_000_000, 1_000_000 - 8192)
    assert mc.acceptance_budget("claude-opus-5", 8192) == ceiling - math.ceil(0.01 * ceiling)
    assert mc.acceptance_budget("gpt-5.4-mini", 16384) == min(272000, 400000-16384) - math.ceil(0.01*min(272000,400000-16384))
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**

```python
import math
HEADROOM_FRACTION = 0.01
def effective_output(model, nominal):
    return min(nominal, MODEL_CAPS[model].max_output)
def acceptance_budget(model, requested_output):
    caps = MODEL_CAPS[model]
    ceiling = min(caps.max_input, caps.total_context - requested_output)
    return ceiling - math.ceil(HEADROOM_FRACTION * ceiling)
```

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(catalog): effective_output clamp + acceptance_budget"`

### Task 3: Migrate `KNOWN_LIMITS` consumers to `MODEL_CAPS`

(Unchanged from rev 2 — matrix drops exact window-equality (moves to the Task 12 gate), keeps resolvability/provider/mode; `check_model_lifecycle.py` + its test migrate to `set(MODEL_CAPS)`; JS mirror gains `{max_input,max_output}` and `drift-check.js` asserts it; `upgrade-smoke.sh` asserts a `MODEL_CAPS` value directly.)

- [ ] Steps as rev 2 Task 3. Commit: `refactor(catalog): migrate matrix/lifecycle/drift/smoke to MODEL_CAPS`.

### Task 4: Fail-closed reject unknown models before the network wait (§7)

**Files:** Modify `repo_radar/modes/sync.py`; Test `repo_radar/tests/test_sync_guard.py` (create).
**Rationale (finding #3 intermediate hazard):** rejection lands in Phase A — before any preflight helper can dereference `get_caps(model)` in production.
**Interfaces:** Guard at the top of `sync_mode`, **before** `wait_for_network` (`sync.py:290`). Metadata-capable predicate: `not getattr(args,"skip_metadata",False) and not getattr(args,"repos_only",False)`. Metadata-capable + `not is_known_model(get_ai_model())` → exit with actionable message.

- [ ] **Step 1: Failing test** — unknown model + metadata mode ⇒ neither `wait_for_network` nor git ops called; `skip_metadata=True` ⇒ proceeds.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the guard before line 290.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(sync): reject uncatalogued models before network wait"`

**Phase A checkpoint:** full `python3 -m pytest repo_radar/tests/ -q` + `node --test menubar/__tests__/*.test.js` green → Codex review of Phase A.

---

## Phase B — Preflight counter (`repo_radar/preflight.py`)

### Task 5: `PreflightLoop` — dedicated Py3.10-safe loop, verified stop before close

**Files:** Create `repo_radar/preflight.py`; Test `repo_radar/tests/test_preflight.py`.
**Interfaces:** `PreflightLoop`: `start()`, `submit(coro) -> Any`, `close()`, `is_closed()`. `close()` cancels/drains pending tasks, stops, joins, and **only closes the loop once the thread has actually stopped** (finding #2).

- [ ] **Step 1: Failing tests** — runs a coroutine; **close while a task is pending** cancels it (patch a never-returning coroutine, submit on a background thread, then close and assert it returns and `is_closed()`); after close, `not thread.is_alive()`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**

```python
import asyncio, threading, hashlib, json, logging
logger = logging.getLogger("repo_radar.preflight")

class PreflightLoop:
    def __init__(self): self._loop=None; self._thread=None; self._closed=False
    def start(self):
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._loop.run_forever, name="preflight-loop", daemon=True)
        self._thread.start()
    def submit(self, coro): return asyncio.run_coroutine_threadsafe(coro, self._loop).result()
    def close(self):
        if self._closed: return
        self._closed = True
        async def _drain():
            pending = [t for t in asyncio.all_tasks(self._loop) if t is not asyncio.current_task()]
            for t in pending: t.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
        try: asyncio.run_coroutine_threadsafe(_drain(), self._loop).result(timeout=5)
        except Exception: pass
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join(timeout=5)
        if self._thread.is_alive():
            logger.error("preflight loop thread did not stop; leaving loop open"); return   # do NOT close a running loop
        self._loop.close()
    def is_closed(self): return self._closed
```

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(preflight): loop thread, drain + verified-stop-before-close"`

### Task 6: `_count_once` + authoritative gate + fatal envelope

**Files:** Modify `repo_radar/preflight.py`, `repo_radar/llm.py` (`_completion_messages`); Test `repo_radar/tests/test_preflight.py`.
**Interfaces:** `PreflightResult(tokens, authoritative)`; `_Fatal(exc)`; `_is_authoritative(resp, model)`; `async _count_once(model, prompt, timeout_s) -> PreflightResult | _Fatal`.

- [ ] **Step 1: Failing tests** — the authoritative all-of matrix (as rev 2, incl. fail-closed identity); timeout/provider error → non-authoritative; **`KeyboardInterrupt`/`SystemExit` raised inside the mocked `acount_tokens` returns `_Fatal`, not a hung/timed-out call.**

```python
def test_fatal_signal_is_enveloped_not_swallowed():
    async def ki(**kw): raise KeyboardInterrupt()
    loop = pf.PreflightLoop(); loop.start()
    with patch("litellm.acount_tokens", ki):
        out = loop.submit(pf._count_once("claude-opus-5", "x", 5))
    loop.close()
    assert isinstance(out, pf._Fatal) and isinstance(out.exc, KeyboardInterrupt)
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Add `_completion_messages` in `llm.py`** (as rev 2) and implement:

```python
from collections import namedtuple
import litellm
from repo_radar.llm import _completion_messages
PreflightResult = namedtuple("PreflightResult", "tokens authoritative")
_Fatal = namedtuple("_Fatal", "exc")

def _is_authoritative(resp, model):
    tt = getattr(resp, "total_tokens", None)
    return (getattr(resp, "tokenizer_type", None) == "anthropic_api"
            and getattr(resp, "error", True) is False
            and isinstance(tt, int) and not isinstance(tt, bool) and tt > 0
            and getattr(resp, "request_model", None) == model
            and getattr(resp, "model_used", None) == model)

async def _count_once(model, prompt, timeout_s):
    try:
        resp = await asyncio.wait_for(
            litellm.acount_tokens(model=model, messages=_completion_messages(prompt)), timeout_s)
    except (KeyboardInterrupt, SystemExit) as e:
        return _Fatal(e)                                  # marshalled to the caller thread by PreflightSession
    except Exception:
        return PreflightResult(None, False)               # timeout/provider error → fallback
    return PreflightResult(resp.total_tokens, True) if _is_authoritative(resp, model) else PreflightResult(None, False)
```

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(preflight): authoritative gate + fatal-signal envelope"`

### Task 7: `PreflightSession` — central strategy gate + loop-owned single-flight + load-bearing tests

**Files:** Modify `repo_radar/preflight.py`; Test `repo_radar/tests/test_preflight.py`.
**Interfaces:** `PreflightSession` (context manager) `count(model, prompt, requested_output) -> PreflightResult`. Inside one lock-held coroutine: (1) **strategy gate** — non-`anthropic_api` or unknown caps → return non-authoritative with no call/breaker/log; (2) breaker check; (3) memo check; (4) `_count_once`; (5) if `_Fatal`, propagate for re-raise; else update memo (authoritative) or open breaker + log-once. `count` re-raises `_Fatal.exc` on the caller thread.

- [ ] **Step 1: Failing tests (load-bearing — must fail if the guard is removed)**

```python
import threading, concurrent.futures as cf
def test_local_strategy_never_calls_provider_or_opens_breaker():
    calls = []
    async def fake(**kw): calls.append(1); return _resp(5)
    with patch("litellm.acount_tokens", fake), pf.PreflightSession(timeout_s=5) as s:
        assert s.count("gpt-5.4-mini", "x", 16384).authoritative is False   # local strategy
        assert s.count("gpt-5.4-mini", "y", 16384).authoritative is False
    assert calls == []                                                       # no provider call at all

def test_two_callers_barrier_before_release_make_one_call():
    barrier = threading.Barrier(3); calls = []
    async def fake(**kw):
        calls.append(1)
        await asyncio.get_event_loop().run_in_executor(None, barrier.wait)   # 3rd party releases
        return _resp(100, rm=kw["model"], mu=kw["model"])
    with patch("litellm.acount_tokens", fake), pf.PreflightSession(timeout_s=5) as s:
        with cf.ThreadPoolExecutor(max_workers=2) as ex:
            f1 = ex.submit(s.count, "claude-opus-5", "same", 8192)
            f2 = ex.submit(s.count, "claude-opus-5", "same", 8192)           # both queued behind the lock
            barrier.wait()                                                    # release the one in-flight call
            f1.result(); f2.result()
    assert len(calls) == 1                                                    # single-flight proven

def test_breaker_is_per_model_second_model_still_tries():
    seen = []
    async def fake(**kw):
        seen.append(kw["model"])
        return _resp(0 if kw["model"]=="claude-opus-5" else 50, rm=kw["model"], mu=kw["model"])
    with patch("litellm.acount_tokens", fake), pf.PreflightSession(timeout_s=5) as s:
        assert s.count("claude-opus-5", "a", 8192).authoritative is False     # opens breaker
        assert s.count("claude-opus-5", "b", 8192).authoritative is False     # no call
        assert s.count("claude-sonnet-5", "c", 8192).authoritative is True    # different model still tries
    assert seen == ["claude-opus-5", "claude-sonnet-5"]

def test_fatal_reraised_on_caller_thread():
    async def ki(**kw): raise KeyboardInterrupt()
    with patch("litellm.acount_tokens", ki), pf.PreflightSession(timeout_s=5) as s:
        try: s.count("claude-opus-5", "x", 8192); assert False
        except KeyboardInterrupt: pass
```

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
        req = json.dumps({"model": model, "messages": _completion_messages(prompt)},
                         sort_keys=True, separators=(",", ":"))
        return (model, hashlib.sha256(req.encode()).hexdigest())
    async def _guarded(self, model, prompt):
        async with self._lock:
            caps = get_caps(model)
            if caps is None or caps.count_strategy != "anthropic_api":
                return PreflightResult(None, False)                      # strategy gate: no call/breaker/log
            if model in self._downgraded:
                return PreflightResult(None, False)
            key = self._key(model, prompt)
            if key in self._memo:
                return self._memo[key]
            out = await _count_once(model, prompt, self._timeout)
            if isinstance(out, _Fatal):
                return out                                               # do not touch memo/breaker
            if out.authoritative:
                self._memo[key] = out
            else:
                self._downgraded.add(model)
                if model not in self._logged:
                    self._logged.add(model); logger.warning("preflight: %s downgraded to Branch 1 for this sync", model)
            return out
    def count(self, model, prompt, requested_output):
        out = self._loop.submit(self._guarded(model, prompt))
        if isinstance(out, _Fatal): raise out.exc                        # re-raise on the caller thread
        return out
```

- [ ] **Step 4: Run** → PASS. Falsifiability: deleting the strategy-gate line makes `test_local_strategy_never_calls_provider_or_opens_breaker` fail.
- [ ] **Step 5: Commit** — `git commit -m "feat(preflight): central strategy gate + loop-owned single-flight + fatal re-raise"`

**Phase B checkpoint:** `python3 -m pytest repo_radar/tests/test_preflight.py -q` green → Codex review of Phase B.

---

## Phase C — Monotonic send helpers, then one wiring commit

### Task 8: `authoritative_partition` (§6.1)

As rev 2 Task 8 (monotonic single-vs-chunk). Uses `session.count(model, _build_full_repo_prompt(...), effective_output(model, 16384))`. Helper tolerates `get_caps(model) is None` by returning `"chunk"` (defensive; production already rejected unknowns in Task 4). Commit: `feat(llm): authoritative_partition (monotonic)`.

### Task 9: `authoritative_chunks` → `PartitionResult` with a safe degradation contract (§6.2, §6.4, finding #5)

**Files:** Modify `repo_radar/llm.py`; Test `repo_radar/tests/test_send_paths.py`.
**Interfaces:** `PartitionResult(chunks, degraded_reason)` — `chunks: list[list[file]]` (only sendable chunks; `N = len(chunks)`), `degraded_reason: str | None`. `authoritative_chunks(session, full_name, files, model) -> PartitionResult`. **Repo-level contract:** if any single file cannot fit even truncated to the template floor, the WHOLE repo is degraded — return `PartitionResult([], reason)` so production writes ONE degraded record with **no** `call_llm` at all (never partial-repo metadata that looks complete). Non-authoritative anywhere → return `PartitionResult(chunk_repo_files(files, model, full_name=full_name), None)` (Branch 1, unchanged).

- [ ] **Step 1: Failing tests** — (a) provider overflow forces split, final `chunks` all fit; (b) provider-overflow-while-local-1.7×-fits singleton terminates via binary search, fits; (c) template-floor singleton ⇒ `PartitionResult([], reason)`; (d) non-authoritative mid-pass ⇒ `chunks == chunk_repo_files(...)`, `degraded_reason is None`. Concrete bodies (extend rev 2's Task 9 test with the `PartitionResult` shape).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the fixpoint + `_authoritative_truncate_file` (rev 2 binary search, but a `None` return ⇒ set `degraded_reason` and return `PartitionResult([], reason)` immediately). Fit budget = `acceptance_budget(model, effective_output(model, 8192))`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(llm): authoritative_chunks with PartitionResult degradation contract"`

### Task 10: `authoritative_synthesis_level` + synthesis singleton terminal (§6.3, finding #4)

**Files:** Modify `repo_radar/llm.py`; Test `repo_radar/tests/test_send_paths.py`.
**Interfaces:** `authoritative_synthesis_level(session, full_name, analyses, model) -> list[list[str]] | DegradedSynthesis`. Split-only per level; a single over-budget analysis that cannot split is **binary-truncated with authoritative recount** (mirroring Task 9); if even the template floor overflows, return `DegradedSynthesis(reason)` (caller emits Branch 1's local degraded synthesis, no send). Non-authoritative → restore Branch 1 current-level batching.

- [ ] **Step 1: Failing tests** — over-budget batch splits; **provider-overflow-while-local-fits single analysis** terminates (binary truncation), no over-budget send; template-floor ⇒ `DegradedSynthesis`; non-authoritative ⇒ Branch 1 batches. Concrete bodies.
- [ ] **Step 2–4:** implement + run → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(llm): synthesis level split-only + provider-driven singleton terminal"`

### Task 11: One wiring commit — thread `PreflightSession` + honor degradation (§9)

**Files:** Modify `repo_radar/modes/sync.py`, `repo_radar/llm.py` (`combine_chunk_analyses(..., session=None)`); Test `repo_radar/tests/test_send_paths.py`.
**Interfaces:** `sync_mode` wraps the metadata loop in `with PreflightSession() as session:`; passes `session` into `authoritative_partition`, `authoritative_chunks`, `combine_chunk_analyses`. If `PartitionResult.degraded_reason` (or `DegradedSynthesis`) is set for a repo, write the degraded metadata record and **skip all `call_llm`** for that repo.

- [ ] **Step 1: Failing tests (concrete)** — (a) landmark: `sync.py` references `PreflightSession` and threads `session` into all three helpers; (b) behavioral: with a stubbed authoritative count, the exact payload digest is counted **before** `call_llm` for chunk, full-repo, and synthesis sends (assert order per path); (c) **degradation integrity:** a repo whose singleton hits the template floor writes a visibly-degraded record and `call_llm` is **never** invoked for that repo.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the wiring + degradation handling (single commit).
- [ ] **Step 4: Run** full `python3 -m pytest repo_radar/tests/ -q` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(sync): thread PreflightSession through all three send paths; honor degradation"`

**Phase C checkpoint:** full suite green → Codex review of Phase C.

---

## Phase D — Release gate

### Task 12: `check_model_windows.py` — directional compare + full invariants (§8, finding #6)

**Files:** Create `scripts/check_model_windows.py`, `repo_radar/tests/test_check_model_windows.py`.
**Interfaces:** `check(caps_map, litellm_info, overrides, target_date, send_outputs) -> list[Finding]`; `Finding(model, field, message, blocking)`. `send_outputs = (8192, 16384)` (chunk, and the shared full-repo/synthesis nominal). `litellm_info` injectable.

**Invariants (each a `blocking=True` Finding unless noted); collect ALL, never stop at first:**
- window fields `total_context`/`max_input`/`max_output` each a positive `int` excluding `bool`; `max_input <= total_context`; `count_strategy` known; `source_url` non-empty https; `source_date` a valid, non-future ISO date.
- for every `nominal` in `send_outputs`: **WARN** (non-blocking) if `nominal > max_output` (runtime clamps via `effective_output`; surfaced, not silently dropped).
- catalog `max_input` > litellm `max_input_tokens` → BLOCK; `max_output` > litellm `max_output_tokens` → BLOCK; catalog < litellm → WARN.
- litellm unresolved / raises / missing a comparison field for a model → BLOCK for that model, keep collecting others.

- [ ] **Step 1: Failing tests** — one per invariant + both directions + the clamp WARN + the unresolved-model BLOCK + reports-all (two bad rows → two findings).
- [ ] **Step 2–4:** implement (stdlib; compare `max_input`/`max_output` only — no `total_context` vs litellm) + run → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(release): check_model_windows (directional + full invariants + clamp warn)"`

### Task 13: Mismatch-bound overrides, fully validated (§8, finding #6)

**Files:** Create `repo_radar/model_window_overrides.json` (`[]`); Modify `scripts/check_model_windows.py`, `repo_radar/tests/test_check_model_windows.py`.
**Interfaces:** Override record `{model, field, catalog_value, litellm_value, vendor_url, verified_at, justification}`. Clears a BLOCK only when ALL match a live mismatch — `model, field, catalog_value, litellm_value`, **and `vendor_url == caps.source_url`**, and `justification` is a non-empty str — AND `verified_at` within 90 days of `target_date`. A malformed or duplicate `(model, field)` override → **BLOCK** (fail closed). Stale catalog `source_date` (>90d) blocks until that record's own date is refreshed (never via override).

- [ ] **Step 1: Failing tests** — matching fresh override clears; changed `catalog_value`/`litellm_value`/`field`/`vendor_url`/expired `verified_at` each re-block; empty/missing `justification` → block; malformed row or duplicate `(model,field)` → block; stale `source_date` blocked, cleared only by fresh date.
- [ ] **Step 2–4:** implement + run → PASS.
- [ ] **Step 5: Commit** — `git add scripts/check_model_windows.py repo_radar/model_window_overrides.json repo_radar/tests/test_check_model_windows.py && git commit -m "feat(release): fully-bound overrides + source_date freshness (fail closed)"`

### Task 14: Wire the gate into `release.sh`

As rev 2 Task 16 — add the gate call after `check_model_lifecycle.py`; verify via `bash -n release.sh` + `test_release_wiring.py` + a direct `python3 scripts/check_model_windows.py --target-date 2026-08-08` run. Commit: `feat(release): run check_model_windows in the preflight`.

**Phase D checkpoint:** full `python3 -m pytest repo_radar/tests/ -q` + `node --test menubar/__tests__/*.test.js` + `bash -n release.sh` + both gates green → final Codex review of `cc3888c..HEAD`.

---

## Self-review

- **Spec coverage:** §4 → T1–T3; §7 → T4; §5/§5a/§5b → T5–T7; §6.1 → T8; §6.2/§6.4 → T9; §6.3 → T10; §9 → T3(smoke)/T11; §8 → T12–T14. §10 tests incl. load-bearing concurrency + strategy-gate + fatal-propagation (T7), degradation integrity (T9/T11), provider-vs-local-fit termination for BOTH analysis (T9) and synthesis (T10), clamp (T2), and all gate directions/invariants/overrides (T12–T13).
- **Commit greenness:** T4 rejection is independent (before preflight exists); T8–T10 helpers use `_StubSession`, no production wiring; T11 is the single wiring commit; T1's derived `KNOWN_LIMITS` keeps lifecycle/matrix green until T3 migrates them.
- **Type consistency:** `PreflightResult`, `_Fatal`, `PreflightSession.count`, `effective_output`, `acceptance_budget`, `authoritative_partition`, `PartitionResult(chunks, degraded_reason)`, `authoritative_synthesis_level`/`DegradedSynthesis`, `Finding(model, field, message, blocking)`.
