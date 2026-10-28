"""Dedicated asyncio event loop running on a background thread.

Python 3.10-safe: this repo's pydeps matrix includes CPython 3.10, so
asyncio.Runner (3.11+) is not usable. The loop is managed manually via
asyncio.new_event_loop() plus a daemon thread running run_forever().
"""

import asyncio, threading, hashlib, json, logging, os, types
from collections import namedtuple

import litellm

from repo_radar.llm import _completion_messages
from repo_radar.model_catalog import get_caps

logger = logging.getLogger("repo_radar.preflight")

# `reason` is a safe diagnostic for an unavailable count, such as "TimeoutError" or
# "AnthropicError (HTTP 503)": never a key, header, prompt or raw provider body.
PreflightResult = namedtuple("PreflightResult", "tokens authoritative reason", defaults=(None,))
_Fatal = namedtuple("_Fatal", "exc")


class TokenCountRejected(Exception):
    """Anthropic refused the token count for a reason a retry won't fix: authentication, permission,
    billing or credit, or a bad request (any 4xx except 408 and 429), or no API key is set.

    Unlike a transient outage, this is an error for the repo, not a skip: it propagates to sync's
    metadata-error handler and doesn't open the per-model breaker.
    """

    def __init__(self, model, status, category):
        self.model, self.status, self.category = model, status, category
        super().__init__(f"token count rejected (HTTP {status}) for {model}: {category}")


# Safe, actionable categories by HTTP status. Anthropic reports low credit as a 400, so 400 names it.
_REJECTED_CATEGORIES = {
    400: "invalid request or insufficient credit; check the model and the account's credit balance",
    401: "authentication failed; check the Anthropic API key",
    402: "billing problem; check the Anthropic account's billing",
    403: "permission denied; check the API key's access to this model",
    404: "model not found; check the model id",
}


def _is_transient_status(status):
    return not isinstance(status, int) or status in (408, 429) or not 400 <= status < 500


class PreflightLoop:
    """Dedicated asyncio loop on a daemon thread, with a bounded best-effort close().

    close() bounds shutdown on the assumption that the work it drains is
    cancellation-COOPERATIVE — the only kind this loop ever runs (litellm's Count
    Tokens call rides HTTPX, which honors cancellation at its await points; see
    `_count_once`). The timeout is a hard bound for such coroutines. A pathological
    cancellation-RESISTANT coroutine (one that catches CancelledError and refuses to
    unwind) cannot be force-killed here, and we deliberately do NOT add hard-kill
    machinery for a case the real provider path never produces. Its only observable
    effect is that close() stays retryable — see close() for why that can never become
    a false success.
    """

    def __init__(self, close_timeout=5.0):
        self._loop = None
        self._thread = None
        self._closing = False
        self._closed = False
        # Injectable so tests can drive drain-timeout / join-timeout scenarios fast.
        self._close_timeout = close_timeout

    def start(self):
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._loop.run_forever, name="preflight-loop", daemon=True)
        self._thread.start()

    def submit(self, coro):
        return asyncio.run_coroutine_threadsafe(coro, self._loop).result()

    def close(self):
        """Bounded best-effort shutdown: idempotent, retryable, never a false success.

        Correctness contract:
          * We report success (is_closed() True) ONLY after the drain actually
            completed AND the loop thread stopped AND the loop was closed. Anything
            short of that returns with _closed still False so the caller can retry.
          * On a drain timeout/failure we do NOT stop or close the loop. Its pending
            tasks are still alive; stopping/closing here would destroy them ("Task was
            destroyed but it is pending!") while implying success. We log and return
            retryable, leaving the loop running so the abandoned _drain keeps trying to
            cancel/gather those tasks.
          * We only ever submit _drain while the loop is running. A retry after a
            partial close must never schedule a fresh _drain on an already-stopped loop
            — that coroutine would never be awaited and would leak. If the loop already
            stopped, we skip straight to join/close.

        Because draining relies on task cancellation, a cancellation-resistant coroutine
        can only keep close() retryable forever; it can never yield a false success.
        """
        if self._closed or self._closing:
            return
        self._closing = True
        try:
            # Drain only while the loop is actually running (property 2): never submit a
            # fresh _drain to a stopped/stopping loop on a retry — it would never run,
            # never be awaited, and leak. If already stopped, fall through to join/close.
            if self._loop.is_running():
                async def _drain():
                    pending = [t for t in asyncio.all_tasks(self._loop) if t is not asyncio.current_task()]
                    for t in pending:
                        t.cancel()
                    await asyncio.gather(*pending, return_exceptions=True)
                try:
                    asyncio.run_coroutine_threadsafe(_drain(), self._loop).result(timeout=self._close_timeout)
                except Exception as e:
                    # Drain did not complete in time (or errored). Do NOT stop/close the
                    # loop — its pending tasks are still alive and must not be destroyed.
                    # Stay retryable; the loop keeps running so _drain can keep trying.
                    logger.warning("preflight drain did not complete; close() is retryable: %s", e)
                    return  # _closed stays False
                # Drain completed: every pending task was cancelled and awaited. Safe to stop.
                self._loop.call_soon_threadsafe(self._loop.stop)
            self._thread.join(timeout=self._close_timeout)
            if self._thread.is_alive():
                logger.error("preflight loop thread did not stop; close() is retryable")
                return  # _closed stays False
            self._loop.close()
            self._closed = True
        finally:
            self._closing = False

    def is_closed(self):
        return self._closed


def _is_authoritative(resp, model):
    """True only if every one of litellm's own signals says this count is trustworthy: the
    Anthropic Count Tokens API actually answered (not a local/estimated tokenizer), it reported
    no error, total_tokens is a genuine positive int (not a bool — bool is a subclass of int, so
    True/False must be excluded explicitly), and both the requested and served model match the
    model we're budgeting for. Any missing attribute or mismatch means "don't trust this," not
    an exception — getattr defaults make a malformed/partial response fail closed."""
    tt = getattr(resp, "total_tokens", None)
    return (getattr(resp, "tokenizer_type", None) == "anthropic_api"
            and getattr(resp, "error", True) is False
            and isinstance(tt, int) and not isinstance(tt, bool) and tt > 0
            and getattr(resp, "request_model", None) == model
            and getattr(resp, "model_used", None) == model)


async def _anthropic_count(model, prompt):
    """Ask Anthropic's Count Tokens API directly, through litellm's own handler.

    litellm.acount_tokens catches a failed count and returns a local estimate instead, so an invalid
    key looked the same as an outage. Calling its handler keeps the HTTP status (AnthropicError)
    while reusing its request transformation, async HTTP client and headers. The model and API key
    are resolved exactly as litellm's Anthropic counter does. Returns a response shaped for
    _is_authoritative, which still decides whether the count can be trusted.
    """
    from litellm.litellm_core_utils.get_llm_provider_logic import get_llm_provider
    from litellm.llms.anthropic.count_tokens.token_counter import anthropic_count_tokens_handler

    resolved, _provider, dynamic_key, _base = get_llm_provider(model=model)
    api_key = dynamic_key or litellm.anthropic_key or litellm.api_key or os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise TokenCountRejected(model, 401, "no Anthropic API key is set")
    result = await anthropic_count_tokens_handler.handle_count_tokens_request(
        model=resolved, messages=_completion_messages(prompt), api_key=api_key)
    return types.SimpleNamespace(total_tokens=result.get("input_tokens"), tokenizer_type="anthropic_api",
                                 error=False, request_model=model, model_used=resolved)


async def _count_once(model, prompt, timeout_s):
    """One bounded attempt at an authoritative token count via Anthropic's Count Tokens API.

    Uses _completion_messages so the counted message structure is EXACTLY what call_llm will
    send on the completion path — counting a different shape than what's sent would make the
    count meaningless. Timeouts, network errors, 408, 429 and 5xx are transient: they return
    PreflightResult(None, False, reason) with a safe reason naming the failure. A 4xx the provider
    won't change its mind about raises TokenCountRejected (see _anthropic_count). Only
    KeyboardInterrupt/SystemExit are enveloped rather than swallowed, so an operator-initiated
    interrupt during the background loop's call still propagates as a distinguishable outcome
    instead of silently degrading to "not authoritative."

    Timeout scope (narrow, not a hard kill): asyncio.wait_for's `timeout_s` is a HARD bound
    only for a cancellation-COOPERATIVE awaitable. litellm's count handler runs over HTTPX, which
    honors cancellation at its await points, so on timeout wait_for cancels the request and it
    actually unwinds — that is the only path this code runs in production. wait_for cannot
    force-kill a cancellation-RESISTANT coroutine (one that catches CancelledError and refuses
    to unwind); it would await that cancellation forever. We do NOT add speculative hard-kill
    machinery for a case the real provider path never produces. The blast radius of such a
    pathological coroutine is contained: PreflightLoop.close() stays retryable (never a false
    success), it is never destroyed mid-flight, and close() never hangs — see PreflightLoop.close.
    """
    from litellm.llms.anthropic.common_utils import AnthropicError
    try:
        resp = await asyncio.wait_for(_anthropic_count(model, prompt), timeout_s)
    except (KeyboardInterrupt, SystemExit) as e:
        return _Fatal(e)
    except TokenCountRejected:
        raise
    except AnthropicError as e:
        status = getattr(e, "status_code", None)
        if not _is_transient_status(status):
            raise TokenCountRejected(model, status, _REJECTED_CATEGORIES.get(
                status, "request rejected; check the model and the Anthropic account")) from None
        return PreflightResult(None, False, f"AnthropicError (HTTP {status})")
    except Exception as e:
        return PreflightResult(None, False, type(e).__name__)
    if _is_authoritative(resp, model):
        return PreflightResult(resp.total_tokens, True)
    return PreflightResult(None, False, "invalid token count")


class PreflightSession:
    """One sync's worth of authoritative token-count preflight, owned by a single background loop.

    All mutable state (memo, per-model breaker, log-once set) lives behind ONE asyncio.Lock held on
    the loop thread, so `_guarded` is the sole critical section and callers on any number of worker
    threads observe a single, serialized, single-flight decision per (model, prompt):

      * Strategy gate first — a model that isn't in the catalog, or whose count_strategy isn't
        "anthropic_api", degrades to Branch 1 (the local estimate) with NO provider call, NO breaker
        mutation and NO log: for those models the Count Tokens API doesn't apply, so touching it or
        the breaker would be meaningless.
      * Per-model circuit breaker — the first non-authoritative answer for a model opens the breaker,
        so the rest of the sync skips the (already-known-unavailable) provider call for that model and
        logs it exactly once. With no authoritative count, that model's metadata is skipped for the
        rest of the sync (llm.InputBudgetUnavailable), not sent on the local estimate. Later calls get
        the same result, so its reason survives. Other models are unaffected. A rejected count
        (TokenCountRejected) is an error, not unavailability: it propagates and opens no breaker.
      * Memo — an authoritative count is cached under (model, sha256(canonical_request)) so an
        identical later request (and a concurrent caller that blocked on the lock) reuses it rather
        than making a second, redundant provider call. The model is part of the key because the same
        prompt counts differently per model.
      * Fatal envelope — an operator interrupt surfaced by `_count_once` as `_Fatal` is returned up
        without mutating memo/breaker and re-raised on the CALLER's thread by `count`, so Ctrl-C is
        never silently downgraded to "not authoritative".
    """

    def __init__(self, timeout_s=10.0):
        self._loop = PreflightLoop()
        self._timeout = timeout_s
        self._memo = {}
        self._downgraded = {}   # model -> its unavailable PreflightResult, reason included
        self._logged = set()
        self._lock = None

    def __enter__(self):
        self._loop.start()
        # Create the Lock ON the loop thread: an asyncio.Lock binds to the running loop, so it must
        # be constructed inside the loop it will be awaited on.
        self._lock = self._loop.submit(self._mklock())
        return self

    def __exit__(self, *exc):
        self._loop.close()
        return False

    async def _mklock(self):
        return asyncio.Lock()

    @staticmethod
    def _key(model, prompt):
        """Memo key: the model plus a sha256 of the CANONICAL request litellm would count. Including
        the model matters because the same prompt tokenizes and counts differently per model; the
        message shape comes from _completion_messages so the key tracks exactly what _count_once
        sends. Canonical json (sorted keys, tight separators) makes the digest stable."""
        req = json.dumps(
            {"model": model, "messages": _completion_messages(prompt)},
            sort_keys=True, separators=(",", ":"),
        )
        return (model, hashlib.sha256(req.encode()).hexdigest())

    async def _guarded(self, model, prompt):
        async with self._lock:
            caps = get_caps(model)
            if caps is None or caps.count_strategy != "anthropic_api":
                return PreflightResult(None, False)
            if model in self._downgraded:
                return self._downgraded[model]
            key = self._key(model, prompt)
            if key in self._memo:
                return self._memo[key]
            out = await _count_once(model, prompt, self._timeout)
            if isinstance(out, _Fatal):
                return out
            if out.authoritative:
                self._memo[key] = out
            else:
                self._downgraded[model] = out
                if model not in self._logged:
                    self._logged.add(model)
                    logger.warning("preflight: authoritative token count unavailable for %s (%s); "
                                   "its metadata is skipped for the rest of this sync", model, out.reason)
            return out

    def count(self, model, prompt, requested_output):
        out = self._loop.submit(self._guarded(model, prompt))
        if isinstance(out, _Fatal):
            raise out.exc
        return out
