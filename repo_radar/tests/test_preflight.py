import asyncio, threading, pytest, repo_radar.preflight as pf
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
