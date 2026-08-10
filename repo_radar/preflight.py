"""Dedicated asyncio event loop running on a background thread.

Python 3.10-safe: this repo's pydeps matrix includes CPython 3.10, so
asyncio.Runner (3.11+) is not usable. The loop is managed manually via
asyncio.new_event_loop() plus a daemon thread running run_forever().
"""

import asyncio, threading, hashlib, json, logging
from collections import namedtuple

import litellm

from repo_radar.llm import _completion_messages

logger = logging.getLogger("repo_radar.preflight")

PreflightResult = namedtuple("PreflightResult", "tokens authoritative")
_Fatal = namedtuple("_Fatal", "exc")


class PreflightLoop:
    def __init__(self):
        self._loop = None
        self._thread = None
        self._closing = False
        self._closed = False

    def start(self):
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._loop.run_forever, name="preflight-loop", daemon=True)
        self._thread.start()

    def submit(self, coro):
        return asyncio.run_coroutine_threadsafe(coro, self._loop).result()

    def close(self):
        if self._closed or self._closing:
            return
        self._closing = True
        try:
            async def _drain():
                pending = [t for t in asyncio.all_tasks(self._loop) if t is not asyncio.current_task()]
                for t in pending:
                    t.cancel()
                await asyncio.gather(*pending, return_exceptions=True)
            try:
                asyncio.run_coroutine_threadsafe(_drain(), self._loop).result(timeout=5)
            except Exception as e:
                logger.warning("preflight drain failed: %s", e)  # surfaced, still try to stop
            self._loop.call_soon_threadsafe(self._loop.stop)
            self._thread.join(timeout=5)
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


async def _count_once(model, prompt, timeout_s):
    """One bounded attempt at an authoritative token count via litellm's Count Tokens API.

    Uses _completion_messages so the counted message structure is EXACTLY what call_llm will
    send on the completion path — counting a different shape than what's sent would make the
    count meaningless. Timeouts and provider/network errors are expected, routine fallback
    triggers (PreflightResult(None, False) lets the caller fall back to the estimate); only
    KeyboardInterrupt/SystemExit are enveloped rather than swallowed, so an operator-initiated
    interrupt during the background loop's call still propagates as a distinguishable outcome
    instead of silently degrading to "not authoritative."
    """
    try:
        resp = await asyncio.wait_for(
            litellm.acount_tokens(model=model, messages=_completion_messages(prompt)), timeout_s
        )
    except (KeyboardInterrupt, SystemExit) as e:
        return _Fatal(e)
    except Exception:
        return PreflightResult(None, False)
    return PreflightResult(resp.total_tokens, True) if _is_authoritative(resp, model) else PreflightResult(None, False)
