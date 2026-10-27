"""Network readiness stays inside its budget, even when DNS never answers.

The probes here are real child processes running the real probe code; only the resolver (for the
stalled case) and the budgets are swapped for small test values.
"""
import os
import signal
import socket
import subprocess
import sys
import textwrap
import threading
import time
from pathlib import Path

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
    # Announced before waiting on the first (hung) probe, not only after it finally failed.
    assert len(waits) == 1 and waits[0] < 0.5
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


def test_sigterm_during_the_wait_reaps_the_probe_and_reports_cancellation():
    # A real worker process waiting on a stalled probe gets the app's graceful Stop (SIGTERM).
    # The probe's own alarm is set far beyond this test, so if the probe is gone the moment the
    # worker exits, the worker killed and reaped it on the way out.
    repo = Path(__file__).resolve().parents[2]
    worker = textwrap.dedent(f"""
        import subprocess, sys
        sys.path.insert(0, {str(repo)!r})
        from repo_radar import network
        stall = "import socket, time\\nsocket.getaddrinfo = lambda *a, **k: time.sleep(3600)\\n"
        def popen(argv, **kwargs):
            argv = list(argv)
            argv[argv.index('-c') + 1] = stall + argv[argv.index('-c') + 1]
            child = subprocess.Popen(argv, **kwargs)
            print(child.pid, flush=True)
            return child
        try:
            network.wait_for_network(timeout=60, probe_timeout=30, popen=popen)
            print('ready', flush=True)
        except network.NetworkWaitCancelled:
            print('cancelled', flush=True)
    """)
    proc = subprocess.Popen([sys.executable, '-c', worker], stdout=subprocess.PIPE, text=True)
    probe_pid = int(proc.stdout.readline())
    time.sleep(0.3)  # let the worker settle into waiting on the probe
    proc.send_signal(signal.SIGTERM)
    out, _ = proc.communicate(timeout=10)

    assert out.strip() == 'cancelled'
    assert proc.returncode == 0
    try:
        os.kill(probe_pid, 0)
    except ProcessLookupError:
        return
    os.kill(probe_pid, signal.SIGKILL)
    raise AssertionError("the probe outlived its cancelled worker")


def test_a_probe_that_cannot_start_counts_as_a_failure_until_the_deadline():
    now = [0.0]
    waits = []

    def cannot_spawn(argv, **kwargs):
        raise OSError(35, "Resource temporarily unavailable")

    def sleep(seconds):
        now[0] += seconds

    ok = network.wait_for_network(timeout=10, interval=2, on_waiting=waits.append,
                                  clock=lambda: now[0], sleep=sleep, popen=cannot_spawn)

    assert ok is False
    assert now[0] == 10
    assert len(waits) == 1


def test_stop_during_probe_cleanup_still_reaps_the_probe_and_cancels():
    # The probe ran out its budget; while it is being killed and reaped, Stop arrives. Cleanup must
    # finish, and the wait must end as cancelled instead of carrying on to its deadline.
    class Probe:
        pid = 4242
        def __init__(self):
            self.killed = False
            self.reaped = False
            self.cleanup_waits = 0
        def poll(self):
            return 0 if self.reaped else None
        def kill(self):
            self.killed = True
        def wait(self, timeout=None):
            if timeout is not None:
                raise subprocess.TimeoutExpired('probe', timeout)
            self.cleanup_waits += 1
            if self.cleanup_waits == 1:
                raise network.NetworkWaitCancelled()
            self.reaped = True
            return -9

    probe = Probe()
    now = [0.0]

    def sleep(seconds):
        now[0] += seconds

    try:
        network.wait_for_network(timeout=10, clock=lambda: now[0], sleep=sleep,
                                 popen=lambda argv, **kw: probe)
    except network.NetworkWaitCancelled:
        pass
    else:
        raise AssertionError("the cancellation was swallowed during cleanup")
    assert probe.killed and probe.reaped
