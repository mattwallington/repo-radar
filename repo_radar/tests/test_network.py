"""Network readiness stays inside its budget, even when DNS never answers.

The probes here are real child processes running the real probe code; only the resolver (for the
stalled case) and the budgets are swapped for small test values.
"""
import os
import socket
import subprocess
import threading
import time

from repo_radar import network


def _recording_popen(prelude=""):
    """Popen that runs `prelude` before the real probe source and records every child it starts."""
    children = []

    def popen(argv, **kwargs):
        argv = list(argv)
        i = argv.index('-c') + 1
        argv[i] = prelude + argv[i]
        child = subprocess.Popen(argv, **kwargs)
        children.append(child)
        return child

    return popen, children


def _assert_reaped(children):
    assert children, "expected at least one probe child"
    for child in children:
        assert child.returncode is not None, f"probe {child.pid} was never reaped"
        try:
            os.kill(child.pid, 0)
        except ProcessLookupError:
            continue
        raise AssertionError(f"probe {child.pid} is still running")


def test_stalled_resolver_times_out_within_budget_and_reaps_probe():
    # getaddrinfo() that never returns: what a resolver does while Wi-Fi/VPN is still coming up.
    # The old loop never regained control here, because socket timeouts don't cover DNS.
    stall = "import socket, time\nsocket.getaddrinfo = lambda *a, **k: time.sleep(3600)\n"
    popen, children = _recording_popen(stall)
    waits = []

    started = time.monotonic()
    ok = network.wait_for_network(timeout=1.5, interval=0.05, probe_timeout=5,
                                  on_waiting=waits.append, popen=popen)
    elapsed = time.monotonic() - started

    assert ok is False
    assert elapsed < 3.0, f"wait overran its 1.5s budget: {elapsed:.2f}s"
    # Announced while the first probe was still hung, not only after it finally failed.
    assert len(waits) == 1 and waits[0] < 1.4
    _assert_reaped(children)


def test_requires_consecutive_successes_and_resets_after_a_failure():
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    listener.listen(16)
    port = listener.getsockname()[1]
    accepted = []

    def accept():
        while True:
            try:
                conn, _ = listener.accept()
            except OSError:
                return
            accepted.append(1)
            conn.close()

    threading.Thread(target=accept, daemon=True).start()

    # Probe 2 fails (as if the network dropped right after wake), so the count must start over:
    # success, failure, then three in a row.
    calls = []
    real_popen, children = _recording_popen()

    def popen(argv, **kwargs):
        calls.append(1)
        if len(calls) == 2:
            argv = list(argv)
            argv[argv.index('-c') + 1] = "import sys\nsys.exit(1)\n"
        return real_popen(argv, **kwargs)

    waits = []
    try:
        ok = network.wait_for_network(host='127.0.0.1', port=port, timeout=20, interval=0.01,
                                      on_waiting=waits.append, popen=popen)
    finally:
        listener.close()

    assert ok is True
    assert len(calls) == 5
    assert len(accepted) == 4
    assert len(waits) == 1
    _assert_reaped(children)
