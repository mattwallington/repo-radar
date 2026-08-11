import asyncio, threading, time, pytest, repo_radar.preflight as pf
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
def test_runs_and_closes():
    loop = pf.PreflightLoop(); loop.start()
    async def v(): await asyncio.sleep(0); return 42
    try: assert loop.submit(v()) == 42
    finally: loop.close()
    assert loop.is_closed()
def test_close_cancels_a_real_pending_coroutine(monkeypatch):
    # Load-bearing: submit a coroutine that never returns, so there IS a pending task; close() must
    # cancel/drain it (deleting the _drain block would hang here) and the future observes cancellation.
    # Note: asyncio.run_coroutine_threadsafe()'s returned concurrent.futures.Future never reaches the
    # RUNNING state (CPython's _chain_future only calls set_result/set_exception/cancel on it, never
    # set_running_or_notify_cancel()), so polling never.running() would never become True. Instead we
    # have the coroutine itself signal via a threading.Event once it is actually executing.
    started = threading.Event()
    loop = pf.PreflightLoop(); loop.start()
    async def never_returns():
        started.set()
        await asyncio.Event().wait()
    never = asyncio.run_coroutine_threadsafe(never_returns(), loop._loop)          # pending forever
    assert started.wait(timeout=5)                                                # bounded: ensure scheduled
    assert not never.done()
    loop.close()                                                                   # must cancel + drain, not hang
    assert loop.is_closed() is True
    import concurrent.futures
    with pytest.raises((concurrent.futures.CancelledError, asyncio.CancelledError)):
        never.result(timeout=1)
def test_close_is_retryable_then_completes_on_delayed_shutdown():
    # REAL delayed-shutdown case (replaces the old inconsistent monkeypatch of is_alive/join).
    # A task that honors cancellation but takes LONGER than close()'s drain timeout to unwind:
    # it catches CancelledError, does a brief cleanup sleep, then exits. The FIRST close() must
    # time out its drain and return retryable WITHOUT stopping/closing the loop or destroying the
    # task; once the cleanup finishes, a SECOND close() completes for real. close_timeout is small
    # so the test is fast; the cleanup delay is comfortably larger so the drain provably times out.
    started = threading.Event(); finished = threading.Event()
    loop = pf.PreflightLoop(close_timeout=0.2); loop.start()
    async def delayed():
        started.set()
        try:
            await asyncio.Event().wait()                # pending forever until cancelled
        except asyncio.CancelledError:
            await asyncio.sleep(0.6)                    # honors cancel, but slow to unwind (> close_timeout)
            finished.set()                             # exits normally after the delayed cleanup
    fut = asyncio.run_coroutine_threadsafe(delayed(), loop._loop)
    assert started.wait(timeout=5)                     # bounded: task is scheduled and running

    t0 = time.monotonic()
    loop.close()                                       # drain cancels the task but it won't unwind in time
    assert time.monotonic() - t0 < 3                   # bounded: close() did not hang
    assert loop.is_closed() is False                   # retryable, not a false success
    assert loop._loop.is_running()                     # loop NOT stopped/closed...
    assert not loop._loop.is_closed()
    assert not fut.done()                              # ...and the pending task was NOT destroyed

    assert finished.wait(timeout=3)                    # let the delayed cleanup complete
    loop.close()                                       # now the drain completes -> real close
    assert loop.is_closed() is True
    assert loop._loop.is_closed()


def test_cancellation_resistant_task_keeps_close_retryable_and_bounded():
    # A GENUINELY cancellation-resistant task: it swallows CancelledError and keeps looping, so
    # close()'s single-shot drain can never cancel it. close() must return retryable (False),
    # stay bounded (no hang), and NOT destroy the task or falsely report closed. At teardown we
    # release the task (a stop flag it also checks) so it exits cleanly and a final close()
    # succeeds — leaking a resistant task/thread into other tests would poison them.
    started = threading.Event(); stop = threading.Event()
    loop = pf.PreflightLoop(close_timeout=0.15); loop.start()
    async def resistant():
        started.set()
        while not stop.is_set():
            try:
                await asyncio.sleep(0.02)
            except asyncio.CancelledError:
                pass                                   # resist: swallow the drain's cancel, keep going
    fut = asyncio.run_coroutine_threadsafe(resistant(), loop._loop)
    try:
        assert started.wait(timeout=5)
        t0 = time.monotonic()
        loop.close()                                   # drain can't cancel it -> times out
        assert time.monotonic() - t0 < 3               # bounded: no hang
        assert loop.is_closed() is False               # retryable, never a false success
        assert loop._loop.is_running()                 # loop NOT stopped/closed
        assert not loop._loop.is_closed()
        assert not fut.done()                          # task alive, not destroyed
    finally:
        stop.set()                                     # release the resistant task so it can exit
        loop.close()                                   # now drain completes -> real close
    assert loop.is_closed() is True
    fut.result(timeout=3)                              # task finished cleanly, no leak


# --- Task 7: PreflightSession (strategy gate + loop-owned single-flight + per-model breaker) ---

def test_local_strategy_never_calls_provider():
    calls = []
    async def fake(**kw): calls.append(1); return _resp(5)
    with patch("litellm.acount_tokens", fake), pf.PreflightSession(timeout_s=5) as s:
        assert s.count("gpt-5.4-mini", "x", 16384).authoritative is False
    assert calls == []


def _concurrent_two(total):
    """Deterministic single-flight probe. Submit BOTH guarded coroutines to the loop as futures;
    coro1 enters the provider (blocks on `release`) holding the lock; coro2 is submitted next, then a
    MARKER coroutine drains the loop's ready queue -- so coro2 has provably run up to its lock await
    (and, absent a lock, would already have called the provider). `calls_before`, asserted mid-flight,
    is 1 with the lock and would be 2 without -- proving coro2 parks on the lock instead of firing a
    concurrent duplicate. The RETURNED total is 1 only if the memo/breaker ALSO suppresses coro2's
    post-release retry, so the return value is falsified by removing the lock, the memo, OR the
    per-model breaker (measuring only `calls_before` would leave memo+breaker untested -- coro2 is
    lock-blocked at that instant no matter what)."""
    entered = threading.Event(); release = threading.Event(); calls = []
    async def fake(**kw):
        calls.append(1); entered.set()
        await asyncio.get_event_loop().run_in_executor(None, release.wait)
        return _resp(total, rm=kw["model"], mu=kw["model"])
    with patch("litellm.acount_tokens", fake), pf.PreflightSession(timeout_s=5) as s:
        lp = s._loop._loop; f1 = f2 = None
        try:
            f1 = asyncio.run_coroutine_threadsafe(s._guarded("claude-opus-5", "same"), lp)
            assert entered.wait(timeout=5)                    # bounded: coro1 holds the lock, parked in provider
            f2 = asyncio.run_coroutine_threadsafe(s._guarded("claude-opus-5", "same"), lp)
            asyncio.run_coroutine_threadsafe(asyncio.sleep(0), lp).result(timeout=5)   # drain: coro2 reached its await
            assert len(calls) == 1                            # single-FLIGHT: coro2 parked on lock, no concurrent 2nd call
        finally:
            release.set()                                     # always release the blocked provider coroutine
            if f1: f1.result(timeout=5)
            if f2: f2.result(timeout=5)
    return len(calls)                                         # total across both callers: memo/breaker dedups coro2's retry


def test_single_flight_two_callers_one_provider_call():
    assert _concurrent_two(100) == 1                          # coro2 blocked on the lock; memo dedups the retry


def test_concurrent_first_failure_opens_breaker_no_second_call():
    assert _concurrent_two(0) == 1                            # non-authoritative -> breaker; coro2 makes no call


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
