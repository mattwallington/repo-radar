"""Network readiness: wait, within a hard budget, for stable connectivity before a sync.

The old wait checked its deadline only between calls to `socket.create_connection(...,
timeout=5)`. That timeout applies to each socket's connect, not to the `getaddrinfo()` DNS lookup
that runs first, so a resolver that never answers (common right after wake, while Wi-Fi or a VPN
is still coming up) held the loop past its 5-minute budget -- 12 minutes on one recorded morning.

Each probe now runs in a disposable child process that the parent can always kill: the parent
waits only for the time left in the budget, then terminates and reaps the child. The child also
arms its own alarm, so it cannot outlive its budget even if the parent is killed first. Nothing
from the sync's configuration or environment (tokens, API keys, repository settings) reaches it.

The app's Stop button sends SIGTERM. During the wait that is turned into NetworkWaitCancelled, so
the probe is killed and reaped on the way out instead of being left to its alarm.
"""

import contextlib
import signal
import subprocess
import sys
import threading
import time


# The probe the child runs: one DNS lookup + TCP connect, exit 0 on success and 1 on failure.
# SIGALRM's default action terminates the process even while it is blocked inside the resolver.
_PROBE_SOURCE = """\
import signal, socket, sys
host, port, budget = sys.argv[1], int(sys.argv[2]), float(sys.argv[3])
signal.alarm(max(1, int(budget + 0.999)))
try:
    socket.create_connection((host, port), timeout=budget).close()
except OSError:
    sys.exit(1)
sys.exit(0)
"""

# Longest a single probe may take, inside whatever remains of the overall budget.
PROBE_TIMEOUT = 5.0


class NetworkWaitCancelled(Exception):
    """SIGTERM (the app's Stop button) arrived while waiting for the network."""


@contextlib.contextmanager
def _cancel_on_sigterm():
    """For the duration of the wait, turn SIGTERM into NetworkWaitCancelled so cleanup runs.

    Only the main thread can install signal handlers; anywhere else the wait keeps the process's
    existing SIGTERM behavior. The previous handler is restored afterwards, so SIGTERM later in the
    sync behaves exactly as before.
    """
    if threading.current_thread() is not threading.main_thread():
        yield
        return

    def _raise(signum, frame):
        raise NetworkWaitCancelled()

    previous = signal.signal(signal.SIGTERM, _raise)
    try:
        yield
    finally:
        signal.signal(signal.SIGTERM, previous if previous is not None else signal.SIG_DFL)


def _probe_command(host, port, budget):
    # -I: ignore PYTHON* env vars and user site-packages; -S: skip site (the probe needs only the
    # standard library, and this keeps child start-up fast).
    return [sys.executable, '-I', '-S', '-c', _PROBE_SOURCE, host, str(port), f'{budget:.3f}']


def _reap(child):
    """Kill a still-running probe and collect its exit status so no zombie is left behind."""
    if child.poll() is None:
        try:
            child.kill()
        except OSError:
            pass
    try:
        child.wait()
    except Exception:
        pass


def _run_probe(host, port, budget, before_block, popen):
    """Run one bounded probe. Returns True on success, False on failure or when out of budget.

    `before_block()` runs once the probe has started and before waiting on it, since that wait
    can last the whole probe budget. A probe that cannot even be started counts as a failure.
    """
    try:
        child = popen(_probe_command(host, port, budget),
                      stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                      stderr=subprocess.DEVNULL, env={}, close_fds=True)
    except OSError:
        return False
    try:
        before_block()
        try:
            return child.wait(timeout=budget) == 0
        except subprocess.TimeoutExpired:
            return False
    finally:
        _reap(child)


def wait_for_network(host="github.com", port=443, timeout=300, interval=2, required_successes=3,
                     on_waiting=None, probe_timeout=PROBE_TIMEOUT,
                     clock=time.monotonic, sleep=time.sleep, popen=subprocess.Popen):
    """Wait for stable network connectivity before starting sync.

    Requires `required_successes` consecutive successful probes to declare the network stable. A
    single successful handshake isn't enough -- right after the laptop wakes from sleep, one
    packet may squeak through while DNS, routing, or the VPN are still warming up, causing the
    sync to start and then fail.

    The whole wait, every probe and every pause included, finishes within `timeout` seconds of
    awake time. The budget uses the monotonic clock, so wall-clock corrections cannot stretch or
    shrink it and time the Mac spends asleep is not counted against it; it is re-checked each time
    execution resumes.

    Returns True if the network is stable, False if the budget ran out. Calls on_waiting(elapsed)
    once, before the first wait on a probe. Raises NetworkWaitCancelled if SIGTERM arrives, after
    the probe in flight has been killed and reaped.
    """
    with _cancel_on_sigterm():
        return _wait(host, port, timeout, interval, required_successes, on_waiting,
                     probe_timeout, clock, sleep, popen)


def _wait(host, port, timeout, interval, required_successes, on_waiting, probe_timeout,
          clock, sleep, popen):
    start = clock()
    deadline = start + timeout
    notified = False
    successes = 0

    def _announce():
        nonlocal notified
        if on_waiting and not notified:
            notified = True
            on_waiting(clock() - start)

    while True:
        remaining = deadline - clock()
        if remaining <= 0:
            return False
        if _run_probe(host, port, min(probe_timeout, remaining), _announce, popen):
            successes += 1
            if successes >= required_successes:
                return True
        else:
            successes = 0
            _announce()
        remaining = deadline - clock()
        if remaining <= 0:
            return False
        sleep(min(interval, remaining))
