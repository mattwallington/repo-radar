"""Dedicated asyncio event loop running on a background thread.

Python 3.10-safe: this repo's pydeps matrix includes CPython 3.10, so
asyncio.Runner (3.11+) is not usable. The loop is managed manually via
asyncio.new_event_loop() plus a daemon thread running run_forever().
"""

import asyncio, threading, hashlib, json, logging

logger = logging.getLogger("repo_radar.preflight")


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
