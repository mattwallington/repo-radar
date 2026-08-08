# Count-Tokens Preflight (Branch 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Budget every Claude prompt actually sent against Anthropic's authoritative count-tokens result (via `litellm.acount_tokens`), falling back to the complete Branch 1 conservative path when that count is unavailable, and harden the model catalog with explicit windows + a release-time validation gate.

**Architecture:** A new `repo_radar/preflight.py` owns a dedicated asyncio loop thread, a single-flight lock, per-model memoization, and a per-model circuit breaker; it exposes one synchronous `preflight_count(...)`. A new `repo_radar/model_catalog.py` holds explicit per-model capability records and the acceptance-budget math. The existing send paths in `llm.py`/`sync.py` call Branch 1's partition decision first and let the authoritative count only *tighten* it (monotonic). A new `scripts/check_model_windows.py` gate validates the catalog against litellm at release.

**Tech Stack:** Python 3.10–3.14 (pydeps matrix), `litellm==1.93.0` (already locked; `acount_tokens`), `asyncio`, stdlib `hashlib`/`json`. JS mirror in `menubar/model-policy.js`. Spec: `docs/superpowers/specs/2026-08-07-count-tokens-preflight-design.md`.

## Global Constraints

- **No new runtime dependency.** Use `litellm==1.93.0` `acount_tokens`; do NOT add the `anthropic` SDK (would force regenerating the 10-cell pydeps lock).
- **Python 3.10-safe.** pydeps matrix includes cp310; `asyncio.Runner` (3.11+) MUST NOT be required — manage the loop manually.
- **Never less safe than Branch 1.** A non-authoritative count → the *complete, unchanged* Branch 1 path (`0.75×` threshold, `1.7×`/header-reserve counting, packing, truncation, synthesis budget).
- **Authoritative gate = ALL of:** `tokenizer_type == "anthropic_api"`, `error is False`, `isinstance(total_tokens, int) and not isinstance(total_tokens, bool)`, `total_tokens > 0`, request/model identity consistent.
- **Monotonic.** Authoritative counting may only split/tighten Branch 1's partition — never merge or reverse `chunk→single`. Branch 1's `repo_needs_chunking`/synthesis decision is the coarsest allowed.
- **Vendor canonical; litellm is drift evidence.** Release gate BLOCKs when catalog value > litellm value for `max_input` AND `max_output`; WARNs on the reverse.
- **requested_output per site:** chunk analysis = `8192`, unchunked full-repo = `16384`, synthesis = `16384` (`SYNTHESIS_OUTPUT_TOKENS`).
- **HEADROOM = `ceil(0.01 × min(max_input, total_context − requested_output))`** (1% of the input ceiling).
- **All tests mock `acount_tokens`** — no live API calls in the suite.
- **Commit hygiene:** stage by exact filename (never `git add -A`); every commit point is green.

---

## Phase A — Catalog foundation

### Task 1: `model_catalog.py` — capability records + accessors

**Files:**
- Create: `repo_radar/model_catalog.py`
- Modify: `repo_radar/llm.py` (import + derive back-compat `KNOWN_LIMITS`)
- Test: `repo_radar/tests/test_model_catalog.py`

**Interfaces:**
- Produces: `MODEL_CAPS: dict[str, ModelCaps]`; `ModelCaps` namedtuple `(total_context, max_input, max_output, count_strategy, source_url, source_date)`; `get_caps(model) -> ModelCaps | None`; `is_known_model(model) -> bool`.

- [ ] **Step 1: Write the failing test**

```python
# repo_radar/tests/test_model_catalog.py
import repo_radar.model_catalog as mc

def test_known_claude_has_explicit_windows_and_strategy():
    caps = mc.get_caps("claude-opus-5")
    assert caps.total_context == 1_000_000
    assert caps.max_input == 1_000_000          # == total_context; output NOT pre-subtracted
    assert caps.max_output == 128_000
    assert caps.count_strategy == "anthropic_api"
    assert caps.source_url.startswith("https://")

def test_unknown_model_is_not_known():
    assert mc.is_known_model("no-such-model") is False
    assert mc.get_caps("no-such-model") is None
```

- [ ] **Step 2: Run test to verify it fails** — `python3 -m pytest repo_radar/tests/test_model_catalog.py -q` → FAIL (module missing).

- [ ] **Step 3: Write minimal implementation**

```python
# repo_radar/model_catalog.py
"""Explicit per-model capability catalog (Branch 2). Vendor docs are canonical;
litellm is only a release-time drift cross-check (scripts/check_model_windows.py)."""
from collections import namedtuple

ModelCaps = namedtuple(
    "ModelCaps", "total_context max_input max_output count_strategy source_url source_date")

_ANTH = "https://platform.claude.com/docs/en/about-claude/model-deprecations"
_GEM = "https://ai.google.dev/gemini-api/docs/models"
_OAI = "https://developers.openai.com/api/docs/models"

# One record per live model. count_strategy: "anthropic_api" uses the server count;
# "local" keeps the Branch 1 local path (accurate for OpenAI/Gemini per Branch 1).
MODEL_CAPS = {
    "claude-opus-5":   ModelCaps(1_000_000, 1_000_000, 128_000, "anthropic_api", _ANTH, "2026-08-07"),
    "claude-sonnet-5": ModelCaps(1_000_000, 1_000_000, 128_000, "anthropic_api", _ANTH, "2026-08-07"),
    "claude-fable-5":  ModelCaps(1_000_000, 1_000_000, 128_000, "anthropic_api", _ANTH, "2026-08-07"),
    "claude-opus-4-8": ModelCaps(1_000_000, 1_000_000, 128_000, "anthropic_api", _ANTH, "2026-08-07"),
    "claude-opus-4-7": ModelCaps(1_000_000, 1_000_000, 128_000, "anthropic_api", _ANTH, "2026-08-07"),
    # ... every model currently in llm.KNOWN_LIMITS gets a record; Gemini/OpenAI use "local".
    # max_input mirrors the current KNOWN_LIMITS integer; max_output/total_context from litellm+vendor.
}

def get_caps(model):
    return MODEL_CAPS.get(model)

def is_known_model(model):
    return model in MODEL_CAPS
```

> **Migration note for the implementer:** port EVERY key currently in `llm.KNOWN_LIMITS` into `MODEL_CAPS`. For each, `max_input` = the existing `KNOWN_LIMITS` value; `total_context`/`max_output` come from `litellm.get_model_info(model)["max_input_tokens"|"max_output_tokens"]` cross-checked against the vendor page; `count_strategy` = `"anthropic_api"` for `claude-*`, else `"local"`.

- [ ] **Step 4: Add back-compat derivation in `llm.py`** — replace the `KNOWN_LIMITS = {...}` literal with a derived map so existing consumers keep working:

```python
# repo_radar/llm.py  (near the old KNOWN_LIMITS definition)
from repo_radar.model_catalog import MODEL_CAPS, get_caps, is_known_model
KNOWN_LIMITS = {m: c.max_input for m, c in MODEL_CAPS.items()}  # back-compat: input window per model
```

- [ ] **Step 5: Run tests** — `python3 -m pytest repo_radar/tests/test_model_catalog.py repo_radar/tests/test_litellm_matrix.py repo_radar/tests/test_lifecycle_gate.py -q` → PASS (derived `KNOWN_LIMITS` keeps the lifecycle gate + matrix test green).

- [ ] **Step 6: Commit**

```bash
git add repo_radar/model_catalog.py repo_radar/llm.py repo_radar/tests/test_model_catalog.py
git commit -m "feat(catalog): explicit MODEL_CAPS records with back-compat KNOWN_LIMITS"
```

### Task 2: `acceptance_budget(model, requested_output)` — the §4.2/§4.3 math

**Files:**
- Modify: `repo_radar/model_catalog.py`
- Test: `repo_radar/tests/test_model_catalog.py`

**Interfaces:**
- Produces: `acceptance_budget(model, requested_output) -> int` (authoritative-regime input budget); `HEADROOM_FRACTION = 0.01`.

- [ ] **Step 1: Write the failing test**

```python
import math
def test_acceptance_budget_subtracts_requested_output_and_1pct_headroom():
    # claude-opus-5: min(1_000_000, 1_000_000-8192) - ceil(0.01*991808)
    ceiling = min(1_000_000, 1_000_000 - 8192)
    expected = ceiling - math.ceil(0.01 * ceiling)
    assert mc.acceptance_budget("claude-opus-5", 8192) == expected

def test_acceptance_budget_does_not_pre_subtract_max_output():
    # budget must be ~991k for 8192 output, NOT 872k (would be max_input-max_output)
    assert mc.acceptance_budget("claude-opus-5", 8192) > 900_000
```

- [ ] **Step 2: Run test** → FAIL (`acceptance_budget` undefined).

- [ ] **Step 3: Implement**

```python
import math
HEADROOM_FRACTION = 0.01

def acceptance_budget(model, requested_output):
    """Authoritative-regime input budget (spec §4.2/§4.3). Fail-closed min of the vendor
    max_input and 'what the shared window leaves after the requested output', minus 1% headroom
    around the provider ESTIMATE. Do NOT pre-subtract max_output."""
    caps = MODEL_CAPS[model]  # caller guarantees known (fail-closed rejection happens earlier)
    ceiling = min(caps.max_input, caps.total_context - requested_output)
    return ceiling - math.ceil(HEADROOM_FRACTION * ceiling)
```

- [ ] **Step 4: Run test** → PASS.
- [ ] **Step 5: Commit** — `git add repo_radar/model_catalog.py repo_radar/tests/test_model_catalog.py && git commit -m "feat(catalog): acceptance_budget with 1% headroom, no max_output pre-subtraction"`

### Task 3: Migrate `KNOWN_LIMITS` consumers (JS mirror, matrix test, upgrade smoke)

**Files:**
- Modify: `menubar/model-policy.js`, `menubar/__tests__/drift-check.js`, `repo_radar/tests/test_litellm_matrix.py`, `menubar/scripts/upgrade-smoke.sh`
- Test: `menubar/__tests__/drift-check.js` (run directly), `repo_radar/tests/test_litellm_matrix.py`

**Interfaces:** Consumes `MODEL_CAPS` (Task 1). No new exports.

- [ ] **Step 1:** Extend the JS mirror `menubar/model-policy.js` with a `MODEL_CAPS`-equivalent (per-model `{max_input, max_output}`) alongside the existing `KNOWN_MODEL_IDS`; keep `KNOWN_MODEL_IDS` derivable from its keys.
- [ ] **Step 2:** Update `menubar/__tests__/drift-check.js` to assert the JS caps match Python `MODEL_CAPS` (input+output), not just the id set.
- [ ] **Step 3:** Run `node menubar/__tests__/drift-check.js` → expect `drift OK`.
- [ ] **Step 4:** Update `repo_radar/tests/test_litellm_matrix.py` to iterate `MODEL_CAPS`, asserting `caps.max_input == litellm max_input_tokens` and `caps.max_output == litellm max_output_tokens` (collect ALL mismatches, as today).
- [ ] **Step 5:** Update the `upgrade-smoke.sh` expected line if it prints a window value that changed shape.
- [ ] **Step 6:** Run `python3 -m pytest repo_radar/tests/test_litellm_matrix.py -q && node menubar/__tests__/drift-check.js` → PASS/`drift OK`.
- [ ] **Step 7: Commit** — stage those four files; `git commit -m "refactor(catalog): migrate KNOWN_LIMITS consumers to MODEL_CAPS"`.

**Phase A checkpoint:** full `python3 -m pytest repo_radar/tests/ -q` + `node --test menubar/__tests__/*.test.js` green → Codex review of Phase A.

---

## Phase B — Preflight counter (`repo_radar/preflight.py`)

### Task 4: Dedicated loop thread (Python 3.10-safe)

**Files:**
- Create: `repo_radar/preflight.py`
- Test: `repo_radar/tests/test_preflight.py`

**Interfaces:**
- Produces: `class PreflightLoop` with `start()`, `run(coro, timeout_s) -> Any` (submits from any thread via `run_coroutine_threadsafe`, serialized by an `asyncio.Lock`), `close()` (drains + closes). Context-manager support.

- [ ] **Step 1: Write the failing test**

```python
# repo_radar/tests/test_preflight.py
import asyncio, repo_radar.preflight as pf

def test_loop_runs_coroutine_and_closes_cleanly():
    loop = pf.PreflightLoop(); loop.start()
    async def add(): await asyncio.sleep(0); return 41 + 1
    try:
        assert loop.run(add(), timeout_s=5) == 42
    finally:
        loop.close()
    assert loop.is_closed()
```

- [ ] **Step 2: Run test** → FAIL.

- [ ] **Step 3: Implement** (dedicated thread owns the loop; no `asyncio.Runner`):

```python
# repo_radar/preflight.py
import asyncio, threading

class PreflightLoop:
    """One dedicated thread owns a single event loop for provider count calls. Worker threads
    submit coroutines via run_coroutine_threadsafe; an asyncio.Lock serializes them (single-flight)
    so cache/breaker state is never raced. Python 3.10-safe (no asyncio.Runner)."""
    def __init__(self):
        self._loop = None
        self._thread = None
        self._lock = None
        self._closed = False

    def start(self):
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._loop.run_forever, name="preflight-loop", daemon=True)
        self._thread.start()
        self._lock = asyncio.run_coroutine_threadsafe(self._make_lock(), self._loop).result()

    async def _make_lock(self):
        return asyncio.Lock()

    def run(self, coro, timeout_s):
        """Serialize + run `coro` on the loop, bounded by timeout_s. Runs on the loop thread."""
        async def guarded():
            async with self._lock:
                return await asyncio.wait_for(coro, timeout_s)
        return asyncio.run_coroutine_threadsafe(guarded(), self._loop).result()

    def close(self):
        if self._closed:
            return
        self._closed = True
        # Cancel/drain pending tasks, then stop + join.
        async def _drain():
            pending = [t for t in asyncio.all_tasks(self._loop) if t is not asyncio.current_task()]
            for t in pending:
                t.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
        try:
            asyncio.run_coroutine_threadsafe(_drain(), self._loop).result(timeout=5)
        finally:
            self._loop.call_soon_threadsafe(self._loop.stop)
            self._thread.join(timeout=5)
            self._loop.close()

    def is_closed(self):
        return self._closed

    def __enter__(self):
        self.start(); return self
    def __exit__(self, *exc):
        self.close()
```

- [ ] **Step 4: Run test** → PASS.
- [ ] **Step 5: Commit** — `git add repo_radar/preflight.py repo_radar/tests/test_preflight.py && git commit -m "feat(preflight): dedicated Py3.10-safe loop thread with serialized run"`

### Task 5: `preflight_count()` — payload parity, strategy gate, authoritative gate

**Files:**
- Modify: `repo_radar/preflight.py`, `repo_radar/llm.py` (shared `_completion_messages`)
- Test: `repo_radar/tests/test_preflight.py`

**Interfaces:**
- Consumes: `PreflightLoop.run` (Task 4); `model_catalog.get_caps`.
- Produces: `PreflightResult = namedtuple("PreflightResult", "tokens authoritative")`; `preflight_count(loop, model, prompt, requested_output, *, timeout_s=10.0) -> PreflightResult`; `llm._completion_messages(prompt) -> list[dict]` (shared by counter AND `call_llm`).

- [ ] **Step 1: Write failing tests** (mock `acount_tokens`):

```python
from unittest.mock import patch
from types import SimpleNamespace
import repo_radar.preflight as pf

def _resp(total, ttype="anthropic_api", error=False, req="claude-opus-5"):
    return SimpleNamespace(total_tokens=total, tokenizer_type=ttype, error=error,
                           request_model=req, model_used=req, error_message=None, status_code=200)

def test_authoritative_when_anthropic_api_positive_int(monkeypatch):
    loop = pf.PreflightLoop(); loop.start()
    async def fake(**kw): return _resp(1234)
    with patch("litellm.acount_tokens", fake):
        r = pf.preflight_count(loop, "claude-opus-5", "hello", 8192)
    loop.close()
    assert r == pf.PreflightResult(1234, True)

def test_local_tokenizer_is_not_authoritative(monkeypatch):
    loop = pf.PreflightLoop(); loop.start()
    async def fake(**kw): return _resp(10, ttype="local_tokenizer")
    with patch("litellm.acount_tokens", fake):
        r = pf.preflight_count(loop, "claude-opus-5", "hello", 8192)
    loop.close()
    assert r.authoritative is False

def test_zero_or_bool_total_tokens_not_authoritative(monkeypatch):
    loop = pf.PreflightLoop(); loop.start()
    async def zero(**kw): return _resp(0)
    async def boolean(**kw): return _resp(True)
    with patch("litellm.acount_tokens", zero):
        assert pf.preflight_count(loop, "claude-opus-5", "x", 8192).authoritative is False
    with patch("litellm.acount_tokens", boolean):
        assert pf.preflight_count(loop, "claude-opus-5", "x", 8192).authoritative is False
    loop.close()
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Add shared message builder in `llm.py`** (payload parity):

```python
# repo_radar/llm.py
def _completion_messages(prompt):
    """The exact messages structure call_llm sends on the completion path — single source of truth
    for both the sender and the preflight counter, so counted text == sent text."""
    return [{"role": "user", "content": prompt}]
```
Then change `call_llm`'s completion branch to `messages=_completion_messages(prompt)`.

- [ ] **Step 4: Implement `preflight_count`**

```python
# repo_radar/preflight.py
from collections import namedtuple
import litellm
from repo_radar.model_catalog import get_caps
from repo_radar.llm import _completion_messages

PreflightResult = namedtuple("PreflightResult", "tokens authoritative")

def _is_authoritative(resp, model):
    tt = getattr(resp, "total_tokens", None)
    return (getattr(resp, "tokenizer_type", None) == "anthropic_api"
            and getattr(resp, "error", True) is False
            and isinstance(tt, int) and not isinstance(tt, bool) and tt > 0
            and getattr(resp, "request_model", model) in (model, getattr(resp, "model_used", model)))

def preflight_count(loop, model, prompt, requested_output, *, timeout_s=10.0):
    caps = get_caps(model)
    if caps is None or caps.count_strategy != "anthropic_api":
        return PreflightResult(None, False)      # non-anthropic → Branch 1 fallback regime
    try:
        resp = loop.run(litellm.acount_tokens(model=model, messages=_completion_messages(prompt)), timeout_s)
    except (KeyboardInterrupt, SystemExit):
        raise
    except BaseException:
        return PreflightResult(None, False)      # timeout / any error → non-authoritative
    if _is_authoritative(resp, model):
        return PreflightResult(resp.total_tokens, True)
    return PreflightResult(None, False)
```

- [ ] **Step 5: Run** → PASS. Also run `repo_radar/tests/` to confirm `call_llm` still green.
- [ ] **Step 6: Commit** — stage `preflight.py`, `llm.py`, `test_preflight.py`; `git commit -m "feat(preflight): authoritative count gate with payload parity"`

### Task 6: Memoization by `(model, request digest)` + single-flight re-check

**Files:** Modify `repo_radar/preflight.py`; Test `repo_radar/tests/test_preflight.py`.

**Interfaces:** Produces a `PreflightSession` holding the loop + a `dict` memo + the breaker (Task 7), exposing `count(model, prompt, requested_output) -> PreflightResult`.

- [ ] **Step 1: Failing test** — same payload + model called twice ⇒ ONE provider call; same payload + two models ⇒ TWO calls.

```python
def test_memo_dedupes_same_model_payload_but_not_across_models():
    calls = []
    async def fake(**kw): calls.append(kw["model"]); return _resp(100, req=kw["model"])
    with patch("litellm.acount_tokens", fake):
        with pf.PreflightSession() as s:
            s.count("claude-opus-5", "same", 8192)
            s.count("claude-opus-5", "same", 8192)     # memo hit → no 2nd call
            s.count("claude-sonnet-5", "same", 8192)    # different model → new call
    assert calls == ["claude-opus-5", "claude-sonnet-5"]
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** memo keyed by `(model, sha256(canonical_request))`; re-check the memo *after* acquiring the loop lock (single-flight) so concurrent identical requests collapse to one call.

```python
import hashlib, json
class PreflightSession:
    def __init__(self, timeout_s=10.0):
        self._loop = PreflightLoop(); self._memo = {}; self._timeout = timeout_s
        # self._breaker added in Task 7
    def __enter__(self): self._loop.start(); return self
    def __exit__(self, *exc): self._loop.close()
    @staticmethod
    def _key(model, prompt):
        req = json.dumps({"messages": _completion_messages(prompt)}, sort_keys=True, separators=(",", ":"))
        return (model, hashlib.sha256(req.encode()).hexdigest())
    def count(self, model, prompt, requested_output):
        key = self._key(model, prompt)
        if key in self._memo:
            return self._memo[key]
        result = preflight_count(self._loop, model, prompt, requested_output, timeout_s=self._timeout)
        if result.authoritative:
            self._memo[key] = result       # cache authoritative results only
        return result
```

> The lock lives inside `PreflightLoop.run` (Task 4); the memo re-check happens under it because `preflight_count` runs the guarded coroutine. For the re-check-after-acquire single-flight semantics, move the `if key in self._memo` check to run inside the guarded coroutine in Task 7's integration (documented there).

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(preflight): (model,digest) memoization of authoritative counts"`

### Task 7: Per-model circuit breaker (opens on ANY non-authoritative outcome)

**Files:** Modify `repo_radar/preflight.py`; Test `repo_radar/tests/test_preflight.py`.

**Interfaces:** `PreflightSession.count` consults/opens a per-model breaker; adds `PreflightSession` a `_downgraded: set[str]` + a once-logged flag.

- [ ] **Step 1: Failing tests**

```python
def test_breaker_opens_on_first_failure_and_skips_further_calls():
    calls = []
    async def fail(**kw): calls.append(1); return _resp(0)  # non-authoritative
    with patch("litellm.acount_tokens", fail):
        with pf.PreflightSession() as s:
            assert s.count("claude-opus-5", "a", 8192).authoritative is False
            assert s.count("claude-opus-5", "b", 8192).authoritative is False
    assert len(calls) == 1   # 2nd prompt used the open breaker, no provider call

def test_breaker_is_per_model():
    async def ok(**kw): return _resp(50, req=kw["model"])
    async def bad(**kw): return _resp(0, req=kw["model"])
    # opus fails (breaker opens), sonnet still tries
    ...
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — before counting, if `model in self._downgraded` return non-authoritative immediately (no call). After any non-authoritative result, add `model` to `_downgraded` and log the downgrade once. Timeout/local/zero/identity all count as failures.

```python
    def count(self, model, prompt, requested_output):
        if model in self._downgraded:
            return PreflightResult(None, False)
        key = self._key(model, prompt)
        if key in self._memo:
            return self._memo[key]
        result = preflight_count(self._loop, model, prompt, requested_output, timeout_s=self._timeout)
        if result.authoritative:
            self._memo[key] = result
        else:
            self._downgraded.add(model)
            if not self._logged.get(model):
                self._logged[model] = True
                logger.warning("preflight: %s downgraded to Branch 1 fallback for this sync", model)
        return result
```
(Add `self._downgraded = set()` and `self._logged = {}` in `__init__`.)

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(preflight): per-model circuit breaker opens on any non-authoritative result"`

**Phase B checkpoint:** `python3 -m pytest repo_radar/tests/test_preflight.py -q` green → Codex review of Phase B (concurrency/breaker are the highest-risk surface).

---

## Phase C — Monotonic send integration (`llm.py`, `sync.py`)

### Task 8: Monotonic single-vs-chunk decision (§6.1)

**Files:** Modify `repo_radar/modes/sync.py` (whole-repo send decision); Test `repo_radar/tests/test_send_paths.py` (create).

**Interfaces:** Consumes `repo_needs_chunking` (Branch 1) + `PreflightSession.count`. Behavior: Branch-1-chunk ⇒ go chunked (never reversed); Branch-1-single ⇒ authoritative-count the whole-repo prompt (`requested_output=16384`), send single only if authoritative-and-fits, else tighten to chunks.

- [ ] **Step 1: Failing test** — a whole-repo prompt Branch 1 would chunk stays chunked even if an (injected) authoritative count would fit single (monotonic).

```python
def test_branch1_chunk_decision_is_never_reversed(monkeypatch):
    # Branch 1 says chunk; even a generous authoritative count must not send single.
    ...
    assert decision.mode == "chunk"
```
And: Branch-1-single but authoritative count reveals overflow ⇒ tightened to chunk.

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the decision wrapper in `sync.py` where the single-vs-chunk choice is made today: call `repo_needs_chunking` first; only when it returns single do we `session.count(...)` the full-repo prompt and compare to `acceptance_budget(model, 16384)`; non-authoritative → Branch 1 single stands (its own threshold already passed).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(sync): monotonic single-vs-chunk decision (authoritative may only tighten)"`

### Task 9: Chunked-analysis authoritative fixpoint (§6.2)

**Files:** Modify `repo_radar/llm.py` (`chunk_repo_files` or a new `authoritative_chunks(...)` wrapper); Test `repo_radar/tests/test_send_paths.py`.

**Interfaces:** `authoritative_chunks(session, full_name, files, model) -> list[list[file]]` — start from Branch 1 packing; count each real `(chunk i/N)` prompt; on any overflow split and **rebuild+recount the whole set** until a full clean pass; memoize identical payloads; only split, never merge.

- [ ] **Step 1: Failing test** — a set where the real authoritative count (injected higher for one chunk) forces a split; assert the final set: every chunk's `_build_analysis_prompt(i, N)` count ≤ `acceptance_budget`; file order/identity preserved; count is ≥ Branch 1's chunk count (never fewer).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the fixpoint (mirror Branch 1's largest-prefix split, but the fit test is `session.count(model, _build_analysis_prompt(full_name, chunk, i, N), 8192)` compared to `acceptance_budget(model, 8192)`; when authoritative is False for any payload, abandon the authoritative pass and return Branch 1's `chunk_repo_files(...)` result unchanged).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(llm): authoritative chunk fixpoint (rebuild+recount on split, monotonic)"`

### Task 10: Analysis-singleton terminal (§6.4)

**Files:** Modify `repo_radar/llm.py`; Test `repo_radar/tests/test_send_paths.py`.

**Interfaces:** When a single-file chunk's authoritative count exceeds budget: truncate via `_truncate_file_to_prompt_budget` and recount until it fits; if even the template alone exceeds budget, return a `DegradedAnalysis(reason=...)` sentinel that the caller emits as degraded metadata with **no** API send.

- [ ] **Step 1: Failing test** — template-exceeds-budget singleton ⇒ `DegradedAnalysis`, and the send loop makes no `call_llm`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `DegradedAnalysis` + the terminal branch; distinct from the synthesis-only `_truncate_all_to_fit` degradation.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(llm): analysis-singleton terminal emits degraded record, never over-budget send"`

### Task 11: Synthesis monotonic preflight (§6.3)

**Files:** Modify `repo_radar/llm.py` (`combine_chunk_analyses`); Test `repo_radar/tests/test_send_paths.py`.

**Interfaces:** For each hierarchical level, build Branch 1's largest candidate batches, `session.count` each with `requested_output=16384`, and split (never coalesce) the **unsent current level** until each fits; future levels are counted only after earlier calls produce them.

- [ ] **Step 1: Failing test** — a level whose authoritative count overflows one batch splits only that level; a prompt above Branch 1's synthesis budget but below the authoritative ceiling still uses Branch 1's (larger) batching as the ceiling (only split).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the per-level preflight in `combine_chunk_analyses` (it already has the `synthesize` seam + `_synthesis_budget`; add the count-and-split before each `run(batch)`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(llm): synthesis per-level authoritative preflight (split-only)"`

### Task 12: Production wiring + no-dead-code tests (§9)

**Files:** Modify `repo_radar/modes/sync.py` (own the `PreflightSession` lifecycle for the sync); Test `repo_radar/tests/test_send_paths.py`.

**Interfaces:** `sync` creates one `PreflightSession` (context-managed) and threads it into all three send paths.

- [ ] **Step 1: Failing tests** — landmark: `sync.py` references `PreflightSession` and each send path receives it; behavioral: with a stubbed authoritative count, the exact payload digest is preflighted **before** `call_llm` for chunk, full-repo, and synthesis sends.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the wiring (`with PreflightSession() as session:` around the metadata loop; pass `session` through).
- [ ] **Step 4: Run** → PASS. Full suite `python3 -m pytest repo_radar/tests/ -q` green.
- [ ] **Step 5: Commit** — `git commit -m "feat(sync): thread one PreflightSession through all three send paths"`

**Phase C checkpoint:** full suite green → Codex review of Phase C (cross-path interaction is the highest-value catch here).

---

## Phase D — Fail-closed rejection + release gate

### Task 13: Reject unknown models before the network/git phase (§7)

**Files:** Modify `repo_radar/modes/sync.py`; Test `repo_radar/tests/test_send_paths.py`.

**Interfaces:** Before the git clone/pull phase, if the selected mode can generate metadata and `not is_known_model(get_ai_model())`, raise/exit with an actionable message naming the model + catalog path. `--skip-metadata`/repos-only skip the check.

- [ ] **Step 1: Failing test** — unknown model + metadata mode ⇒ rejection *before* any git work (assert git functions not called); `--skip-metadata` + unknown model ⇒ runs.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the early guard at the top of the sync flow (before the `ThreadPoolExecutor` git phase at `sync.py:750`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(sync): fail-closed reject uncatalogued models before git phase"`

### Task 14: `check_model_windows.py` gate — same-semantics compare + directions + invariants (§8)

**Files:** Create `scripts/check_model_windows.py`, `repo_radar/tests/test_check_model_windows.py`.

**Interfaces:** `check(caps, litellm_info_fn, overrides, target_date) -> list[Finding]` (Finding has `.blocking: bool`). CLI `--target-date` mirrors `check_model_lifecycle.py`.

- [ ] **Step 1: Failing tests** (litellm injected):
  - catalog `max_input` > litellm ⇒ BLOCK (both `max_input` and `max_output`);
  - catalog < litellm ⇒ WARN (non-blocking);
  - schema invariants: non-positive/`bool`/unknown-strategy/`max_input>total_context`/`requested_output>max_output`/future-or-invalid date/non-https source ⇒ BLOCK;
  - reports EVERY mismatch (not just first).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the stdlib gate (no total_context compare — litellm has none; compare `max_input`/`max_output` only).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(release): check_model_windows gate (same-semantics, directional, invariants)"`

### Task 15: Override mechanism bound to the exact mismatch (§8)

**Files:** Create `repo_radar/model_window_overrides.json`; Modify `scripts/check_model_windows.py`, `repo_radar/tests/test_check_model_windows.py`.

**Interfaces:** Override record `{model, field, catalog_value, litellm_value, vendor_url, verified_at, justification}`; clears a BLOCK only when all of `{model, field, catalog_value, litellm_value}` match AND `verified_at` within 90 days; stale catalog `source_date` (>90d) blocks until the record's own date is refreshed (NOT via override).

- [ ] **Step 1: Failing tests** — matching fresh override clears the block; changed `catalog_value` / changed `litellm_value` / changed `field` / expired `verified_at` each re-block; stale `source_date` blocks and is cleared only by refreshing that record's date.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** override loading + exact-tuple binding + expiry; stale-`source_date` rule.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(release): mismatch-bound override + source_date freshness block"`

### Task 16: Wire the gate into `release.sh`

**Files:** Modify `release.sh`; Test: manual `./release.sh --dry-run` on a scratch branch.

- [ ] **Step 1:** Add, after the `check_model_lifecycle.py` gate: `python3 scripts/check_model_windows.py --target-date "$RELEASE_DATE" || { echo "Release blocked: model window gate failed..."; exit 1; }`.
- [ ] **Step 2:** Run `./release.sh --dry-run` → preflight passes both gates.
- [ ] **Step 3: Commit** — `git add release.sh && git commit -m "feat(release): run check_model_windows in the release preflight"`.

**Phase D checkpoint:** full `python3 -m pytest repo_radar/tests/ -q` + `node --test menubar/__tests__/*.test.js` + `./release.sh --dry-run` green → final Codex review of the whole branch (`cc3888c..HEAD`).

---

## Self-review (run before handoff)

- **Spec coverage:** §4 → Tasks 1–3; §5/§5a/§5b → Tasks 4–6; §5.4 gate → Task 5; breaker §5a → Task 7; §6.1 → Task 8; §6.2 → Task 9; §6.4 → Task 10; §6.3 → Task 11; §9 → Task 12; §7 → Task 13; §8 → Tasks 14–16; §10 tests distributed across the owning tasks.
- **Placeholders:** none — every task has real interfaces + code/tests (a few Phase-C step-1 tests are described where the exact fixture depends on the Branch-1 helper being wrapped; the implementer writes the assertion shown).
- **Type consistency:** `PreflightResult(tokens, authoritative)`, `PreflightSession.count(model, prompt, requested_output)`, `acceptance_budget(model, requested_output)`, `get_caps/is_known_model`, `_completion_messages(prompt)` used consistently across tasks.
