"""The weekly spending ledger: one atomic admission across processes, durable holds and periods."""

import json
import os
import subprocess
import sys
import textwrap
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from repo_radar import spending as sp

ROOT = Path(__file__).resolve().parents[2]
WEDNESDAY = datetime(2026, 11, 4, 15, 30, tzinfo=timezone.utc)
MONDAY = datetime(2026, 11, 9, tzinfo=timezone.utc)


def context(root, channel='stable', cap=75.0, enabled=True, now=None):
    clock = (lambda: now) if now else None
    return sp.Spending(channel, store=sp.Store(root), policy=lambda: (enabled, cap), clock=clock)


def test_one_weekly_allowance_is_admitted_atomically_across_processes(tmp_path):
    """Stable and dev syncs from different repository roots contend for the same record: of two $40 holds
    with $40 left, exactly one is admitted. Its sends are recorded inside the hold, not charged again, and
    closing releases what it didn't use for the next attempt."""
    root = tmp_path / 'spending'
    earlier = context(root).admit('o/earlier', 'm', 'full', 35)
    [send] = earlier.reserve([35])
    earlier.settle(send, 35)
    earlier.close()

    go = tmp_path / 'go'
    script = textwrap.dedent('''
        import json, os, sys, time
        from repo_radar import spending as sp
        root, channel, repo, go = sys.argv[1:]
        while not os.path.exists(go):
            time.sleep(0.005)
        try:
            hold = sp.Spending(channel, store=sp.Store(root), policy=lambda: (True, 75.0)).admit(repo, 'm', 'full', 40)
            print(json.dumps({'admitted': hold.attempt_id}))
        except sp.WeeklyCapRefused as e:
            print(json.dumps({'refused': str(e), 'remaining': e.remaining_usd}))
    ''')
    env = {**os.environ, 'PYTHONPATH': str(ROOT)}
    procs = [subprocess.Popen([sys.executable, '-c', script, str(root), channel, repo, str(go)], cwd=tmp_path,
                              stdout=subprocess.PIPE, text=True, env=env)
             for channel, repo in (('stable', 'o/one'), ('dev', 'o/two'))]
    go.write_text('')
    results = [json.loads(p.communicate(timeout=60)[0]) for p in procs]
    admitted = [r for r in results if 'admitted' in r]
    refused = [r for r in results if 'refused' in r]
    assert len(admitted) == 1 and len(refused) == 1
    assert refused[0]['remaining'] == 0
    assert refused[0]['refused'].startswith('Weekly spending limit: this update needs up to $40.00; $0.00 remains until ')

    # The admitted attempt's sends consume its own hold: $75 committed, not $75 plus the sends.
    data = json.loads((root / sp.LEDGER_NAME).read_text())
    winner = data['attempts'][admitted[0]['admitted']]
    hold = sp.Hold(sp.Store(root), admitted[0]['admitted'], winner['allowance'], lambda: datetime.now(timezone.utc))
    first, second = hold.reserve([15, 15])
    hold.settle(first, 6)
    hold.settle(first, 6)          # a repeated settlement charges nothing more
    hold.settle(second, 4)
    assert sp.summary(sp.Store(root), lambda: (True, 75.0))['available_usd'] == 0
    with pytest.raises(sp.WeeklyCapRefused):
        context(root).admit('o/three', 'm', 'incremental', 0.01)
    hold.close()
    after = sp.summary(sp.Store(root), lambda: (True, 75.0))
    assert (after['recorded_usd'], after['reserved_usd'], after['available_usd']) == (45, 0, 30)
    context(root, channel='dev').admit('o/three', 'm', 'full', 30)   # the released $30 fits exactly
    with pytest.raises(sp.WeeklyCapRefused):
        context(root).admit('o/four', 'm', 'full', 0.01)
    # Off stops refusing, but still records.
    context(root, enabled=False).admit('o/four', 'm', 'full', 40)
    assert sp.summary(sp.Store(root), lambda: (False, 75.0))['reserved_usd'] == 70


def test_holds_survive_reopening_belong_to_their_period_and_damage_is_unavailable(tmp_path):
    root = tmp_path / 'spending'
    store = sp.Store(root)
    assert sp.summary(store, lambda: (True, 75.0))['status'] == 'not_started'
    assert not root.exists()   # reading creates nothing

    # Activated midweek: the first period runs to Monday 00:00 UTC and nothing earlier is guessed at.
    start = context(root, now=WEDNESDAY)
    start.initialize()
    first = sp.summary(store, lambda: (True, 75.0), now=WEDNESDAY + timedelta(hours=1))
    assert first['first_period'] and first['period_start'] == WEDNESDAY.isoformat()
    assert first['period_end'] == MONDAY.isoformat() and first['recorded_usd'] == 0
    assert oct(root.stat().st_mode & 0o777) == '0o700' and oct((root / sp.LEDGER_NAME).stat().st_mode & 0o777) == '0o600'

    # One completed call and one send that never resolved, then a crash: reopened, both stay committed.
    sunday = MONDAY - timedelta(hours=1)
    hold = context(root, now=sunday).admit('o/r', 'm', 'full', 40)
    done, lost = hold.reserve([3, 5])
    hold.settle(done, 2.5)
    reopened = sp.summary(sp.Store(root), lambda: (True, 75.0), now=sunday)
    assert (reopened['recorded_usd'], reopened['reserved_usd']) == (2.5, 37.5)   # the whole allowance still held

    # A new week has its own balance; the attempt admitted on Sunday keeps settling into its own period.
    tuesday = MONDAY + timedelta(days=1)
    week = sp.summary(sp.Store(root), lambda: (True, 75.0), now=tuesday)
    assert not week['first_period'] and week['period_start'] == MONDAY.isoformat()
    assert (week['recorded_usd'], week['reserved_usd'], week['available_usd']) == (0, 0, 75)
    hold.close()                                   # the unresolved send keeps its $5 bound
    old = sp.summary(sp.Store(root), lambda: (True, 75.0), now=sunday)
    assert (old['recorded_usd'], old['reserved_usd']) == (2.5, 5)
    assert sp.summary(sp.Store(root), lambda: (True, 75.0), now=tuesday)['recorded_usd'] == 0

    # A record that existed and is now damaged, unsafe or missing is unavailable, never a fresh $0.
    ledger = root / sp.LEDGER_NAME
    good = ledger.read_text()
    for damage in ('{"schema": "something else"}', good[:len(good) // 2]):
        ledger.write_text(damage)
        assert sp.summary(sp.Store(root), lambda: (True, 75.0))['status'] == 'unavailable'
        with pytest.raises(sp.SpendingUnavailable):
            context(root).admit('o/r', 'm', 'full', 1)
    ledger.write_text(good)
    os.chmod(ledger, 0o644)
    assert sp.summary(sp.Store(root), lambda: (True, 75.0))['status'] == 'unavailable'
    os.chmod(ledger, 0o600)
    ledger.unlink()
    with pytest.raises(sp.SpendingUnavailable, match='missing'):
        context(root).initialize()
    assert not ledger.exists()
