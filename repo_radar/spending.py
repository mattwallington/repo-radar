"""The weekly spending ledger: one durable money record shared by every sync, whichever channel (stable or
dev), repository root or generation path started it.

Each generation attempt owns one allowance. Before its first send it is admitted under the ledger lock:
the period's committed money (closed attempts' known charges and retained unknown bounds, plus every open
attempt's whole allowance) and the new allowance must fit the weekly cap when the cap is on. Each send is
then recorded inside that allowance before it goes out, its known cost is recorded as soon as the reply
arrives, and closing the attempt keeps its known charges and unresolved bounds and releases the rest. A
send whose cost is unknown keeps its whole bound; nothing ever expires by elapsed time.

Periods: the first runs from activation (the first normal sync using this ledger) to the next Monday
00:00 UTC, later ones Monday to Monday UTC. Every charge belongs to the period its attempt was admitted in.

Amounts are integer microdollars, rounded up. The ledger stores attempt and send identifiers, the channel,
repository name, model, times and amounts only: never prompts, replies, credentials or configuration.
An app-side estimate, not a provider's billing guarantee.

`python -m repo_radar.spending summary` prints the read-only aggregate the Settings window shows.
"""

import contextlib
import fcntl
import json
import math
import os
import stat
import sys
import tempfile
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCHEMA = 'repo-radar-weekly-spend/1'
DIR_ENV = 'REPO_RADAR_SPENDING_DIR'
LEDGER_NAME = 'ledger.json'
MARKER_NAME = 'activated'     # written after the ledger: a ledger that later goes missing isn't a fresh start
LOCK_NAME = 'ledger.lock'     # never replaced or deleted, so every process locks the same inode
LOCK_SECONDS = 10.0
MICRO = 1_000_000


class SpendingError(Exception):
    """An accounting problem (the record is unreadable, unsafe or couldn't be written). Never a refusal."""


class SpendingUnavailable(SpendingError):
    pass


class WeeklyCapRefused(Exception):
    """An attempt wasn't admitted because its allowance doesn't fit what is left this period. Nothing was
    reserved or sent."""

    def __init__(self, needs_usd, remaining_usd, resets_at):
        self.needs_usd, self.remaining_usd, self.resets_at = needs_usd, remaining_usd, resets_at
        super().__init__(f"Weekly spending limit: this update needs up to ${needs_usd:.2f}; ${remaining_usd:.2f} "
                         f"remains until {resets_at.strftime('%Y-%m-%d %H:%M')} UTC")


def to_micro(usd):
    """US dollars to whole microdollars, rounded up."""
    return int(math.ceil(round(float(usd) * MICRO, 3)))


def to_usd(micro):
    return micro / MICRO


def spending_dir():
    override = os.environ.get(DIR_ENV)
    if override:
        return Path(override)
    from repo_radar import config
    return config.CONFIG_DIR / 'spending'


def _utc(value):
    when = datetime.fromisoformat(value)
    if when.tzinfo is None:
        raise ValueError('a time without a zone')
    return when.astimezone(timezone.utc)


def _monday_after(when):
    start = (when - timedelta(days=when.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    return start + timedelta(days=7)


def period_of(activated, now):
    """(start, end) of the period `now` falls in: activation to the next Monday 00:00 UTC, then weeks."""
    first_end = _monday_after(activated)
    if now < first_end:
        return activated, first_end
    start = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    return start, start + timedelta(days=7)


# ---- what an attempt has committed ------------------------------------------------------------

def _known(attempt):
    return sum(s['cost'] for s in attempt['sends'].values() if s['status'] == 'settled')


def _uncertain(attempt):
    return sum(s['bound'] for s in attempt['sends'].values() if s['status'] in ('reserved', 'unknown'))


def committed(attempt):
    """An open attempt holds its whole allowance, or more after an actual overrun; a closed one keeps its
    known charges and every unresolved bound."""
    used = _known(attempt) + _uncertain(attempt)
    return max(attempt['allowance'], used) if attempt['status'] == 'open' else used


def _valid(data):
    if not isinstance(data, dict) or data.get('schema') != SCHEMA or not isinstance(data.get('attempts'), dict):
        return False
    _utc(data['activated_at'])
    for attempt in data['attempts'].values():
        if attempt.get('status') not in ('open', 'closed') or not isinstance(attempt.get('sends'), dict):
            return False
        _utc(attempt['period_start'])
        if not all(isinstance(attempt[k], int) and attempt[k] >= 0 for k in ('allowance',)):
            return False
        for send in attempt['sends'].values():
            if send.get('status') not in ('reserved', 'settled', 'unknown') or not isinstance(send.get('bound'), int):
                return False
            if send['status'] == 'settled' and not isinstance(send.get('cost'), int):
                return False
    return True


# ---- storage ------------------------------------------------------------------------------------

class Store:
    """The ledger files in one directory: read lock-free (every write is an atomic replace), changed only
    inside a locked read/check/change transaction."""

    def __init__(self, root=None):
        self.root = Path(root) if root is not None else spending_dir()
        self.ledger, self.marker, self.lock = (self.root / LEDGER_NAME, self.root / MARKER_NAME,
                                               self.root / LOCK_NAME)

    def _check_owner_only(self, path, kind):
        info = os.lstat(path)
        mode_ok = stat.S_ISDIR(info.st_mode) if kind == 'dir' else stat.S_ISREG(info.st_mode)
        loose = info.st_mode & (0o022 if kind == 'dir' else 0o077)
        if not mode_ok or info.st_uid != os.getuid() or loose:
            raise SpendingUnavailable(f"the spending record's {kind} isn't private to this user")

    def load(self):
        """The ledger, or None before it was ever initialized. A ledger that existed and is now missing,
        damaged or unsafe is unavailable: never treated as a fresh, empty record."""
        try:
            if not os.path.lexists(self.root):
                return None
            self._check_owner_only(self.root, 'dir')
            if not os.path.lexists(self.ledger):
                if os.path.lexists(self.marker):
                    raise SpendingUnavailable("the spending record is missing")
                return None
            self._check_owner_only(self.ledger, 'file')
            with open(self.ledger, encoding='utf-8') as handle:
                data = json.load(handle)
            if not _valid(data):
                raise SpendingUnavailable("the spending record is damaged")
            return data
        except SpendingError:
            raise
        except (OSError, ValueError, KeyError, TypeError) as e:
            raise SpendingUnavailable(f"the spending record can't be read ({type(e).__name__})") from None

    @contextlib.contextmanager
    def transaction(self):
        """Hold the ledger lock for one short read/check/change; never across a provider call."""
        try:
            self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
            self._check_owner_only(self.root, 'dir')
            fd = os.open(self.lock, os.O_RDWR | os.O_CREAT, 0o600)
        except SpendingError:
            raise
        except OSError as e:
            raise SpendingUnavailable(f"the spending record can't be locked ({type(e).__name__})") from None
        try:
            waited = time.monotonic() + LOCK_SECONDS
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() > waited:
                        raise SpendingUnavailable("the spending record is busy") from None
                    time.sleep(0.02)
            yield
        finally:
            os.close(fd)

    def save(self, data):
        """Durably replace the ledger: a private temp file, synced, renamed, and the directory synced."""
        tmp = None
        try:
            fd, tmp = tempfile.mkstemp(dir=str(self.root), prefix=f".{LEDGER_NAME}.", suffix='.tmp')
            with os.fdopen(fd, 'w', encoding='utf-8') as handle:
                json.dump(data, handle, indent=1, sort_keys=True)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.ledger)
            tmp = None
            self._sync_dir()
        except OSError as e:
            raise SpendingError(f"the spending record couldn't be written ({type(e).__name__})") from None
        finally:
            if tmp:
                with contextlib.suppress(OSError):
                    os.unlink(tmp)

    def _sync_dir(self):
        fd = os.open(self.root, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def _mark_activated(self, data):
        if os.path.lexists(self.marker):
            return
        try:
            fd = os.open(self.marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as handle:
                handle.write(data['activated_at'] + '\n')
                handle.flush()
                os.fsync(handle.fileno())
            self._sync_dir()
        except OSError as e:
            raise SpendingError(f"the spending record couldn't be marked active ({type(e).__name__})") from None

    def ready(self, now):
        """Inside a transaction: the ledger, initialized now if this storage never held one."""
        data = self.load()
        if data is None:
            data = {'schema': SCHEMA, 'activated_at': now.isoformat(), 'attempts': {}}
            self.save(data)
        self._mark_activated(data)   # after the ledger, so an interrupted start leaves nothing ambiguous
        return data


# ---- the weekly policy ------------------------------------------------------------------------

def policy_from_config(saved):
    """(enabled, cap_usd) from a whole saved config. A config that couldn't be read stops admission rather
    than falling back to defaults that may not be what was saved."""
    from repo_radar.config import weekly_spending_policy
    if not isinstance(saved, dict):
        raise SpendingUnavailable("the settings can't be read")
    enabled, cap, _invalid = weekly_spending_policy(saved)
    return enabled, cap


def read_weekly_policy():
    """policy_from_config of the Settings file as saved now."""
    from repo_radar import config
    try:
        with open(config.CONFIG_FILE, encoding='utf-8') as handle:
            saved = json.load(handle)
    except (OSError, ValueError) as e:
        raise SpendingUnavailable(f"the settings can't be read ({type(e).__name__})") from None
    return policy_from_config(saved)


# ---- admission and one attempt's allowance ------------------------------------------------------

class Spending:
    """The production spending context a normal sync hands its workers."""

    def __init__(self, channel, store=None, policy=read_weekly_policy, clock=None):
        self.channel, self.store, self.policy = channel, store or Store(), policy
        self.clock = clock or (lambda: datetime.now(timezone.utc))

    def initialize(self):
        """Start the first period now unless this storage already holds a ledger."""
        with self.store.transaction():
            self.store.ready(self.clock())

    def admit(self, repo, model, kind, amount_usd):
        """Admit one attempt's whole allowance before its first send, or raise WeeklyCapRefused."""
        amount = to_micro(amount_usd)
        with self.store.transaction():
            now = self.clock()
            data = self.store.ready(now)
            enabled, cap_usd = self.policy()
            start, end = period_of(_utc(data['activated_at']), now)
            used = sum(committed(a) for a in data['attempts'].values() if _utc(a['period_start']) == start)
            if enabled and used + amount > to_micro(cap_usd):
                raise WeeklyCapRefused(to_usd(amount), to_usd(max(0, to_micro(cap_usd) - used)), end)
            attempt_id = uuid.uuid4().hex
            data['attempts'][attempt_id] = {
                'channel': self.channel, 'repo': repo, 'model': model, 'kind': kind,
                'period_start': start.isoformat(), 'admitted_at': now.isoformat(), 'allowance': amount,
                'status': 'open', 'sends': {}, 'next_send': 1}
            self.store.save(data)
        return Hold(self.store, attempt_id, amount, self.clock)


class Hold:
    """One admitted attempt's allowance: each send is recorded inside it before transport and settled once.
    After any failed write the hold is broken and refuses further sends; the durable record keeps the
    previous, larger hold."""

    def __init__(self, store, attempt_id, allowance, clock):
        self.store, self.attempt_id, self.allowance, self.clock = store, attempt_id, allowance, clock
        self.allowance_usd = to_usd(allowance)
        self.broken = False
        self.closed = False

    def _change(self, change):
        if self.broken:
            raise SpendingError("an earlier spending record write failed; no further request is sent")
        try:
            with self.store.transaction():
                data = self.store.load()
                attempt = (data or {}).get('attempts', {}).get(self.attempt_id)
                if attempt is None:
                    raise SpendingUnavailable("this attempt is missing from the spending record")
                result = change(attempt)
                self.store.save(data)
                return result
        except SpendingError:
            self.broken = True
            raise

    def reserve(self, bounds_usd):
        """Record a wave of sends before any of it goes out; their send numbers, in order."""
        from repo_radar.metadata_budget import BudgetExceeded
        bounds = [to_micro(b) for b in bounds_usd]

        def change(attempt):
            if attempt['status'] != 'open':
                raise SpendingError("this attempt's spending is already closed")
            if _known(attempt) + _uncertain(attempt) + sum(bounds) > attempt['allowance']:
                raise BudgetExceeded(f"the next request would pass this attempt's ${self.allowance_usd:.2f} allowance")
            numbers = []
            for bound in bounds:
                number = attempt['next_send']
                attempt['next_send'] += 1
                attempt['sends'][str(number)] = {'bound': bound, 'status': 'reserved', 'cost': None}
                numbers.append(number)
            return numbers
        return self._change(change)

    def settle(self, number, cost_usd):
        """A reply's known cost, recorded in full even above its bound. Settling twice changes nothing."""
        def change(attempt):
            send = attempt['sends'][str(number)]
            if send['status'] == 'reserved':
                send.update(status='settled', cost=to_micro(cost_usd))
        self._change(change)

    def unknown(self, number):
        """A send whose cost is unknown: its whole bound stays committed."""
        def change(attempt):
            send = attempt['sends'][str(number)]
            if send['status'] == 'reserved':
                send['status'] = 'unknown'
        self._change(change)

    def close(self):
        """End the attempt: known charges and unresolved bounds stay, the unused allowance is released.
        A send still reserved here is unresolved and keeps its bound. Closing twice changes nothing."""
        if self.closed:
            return

        def change(attempt):
            if attempt['status'] == 'open':
                for send in attempt['sends'].values():
                    if send['status'] == 'reserved':
                        send['status'] = 'unknown'
                attempt.update(status='closed', closed_at=self.clock().isoformat())
        self.broken = False   # closing only ever keeps or lowers what was already counted
        self._change(change)
        self.closed = True


# ---- the read-only summary ------------------------------------------------------------------------

def summary(store=None, policy=None, now=None):
    """The aggregate Settings shows, from the same functions admission uses. Creates nothing."""
    store = store or Store()
    now = now or datetime.now(timezone.utc)
    read_at = now.isoformat()
    try:
        data = store.load()
        enabled, cap_usd = (policy or read_weekly_policy)()
    except SpendingError:
        return {'status': 'unavailable', 'read_at': read_at}
    if data is None:
        return {'status': 'not_started', 'enabled': enabled, 'cap_usd': cap_usd, 'read_at': read_at}
    activated = _utc(data['activated_at'])
    start, end = period_of(activated, now)
    period = [a for a in data['attempts'].values() if _utc(a['period_start']) == start]
    total = sum(committed(a) for a in period)
    known = sum(_known(a) for a in period)
    cap = to_micro(cap_usd)
    return {'status': 'ready', 'enabled': enabled, 'cap_usd': cap_usd, 'read_at': read_at,
            'activated_at': activated.isoformat(), 'first_period': start == activated,
            'period_start': start.isoformat(), 'period_end': end.isoformat(),
            'recorded_usd': to_usd(known), 'reserved_usd': to_usd(total - known),
            'available_usd': to_usd(max(0, cap - total)) if enabled else None}


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv != ['summary']:
        print('usage: python -m repo_radar.spending summary', file=sys.stderr)
        return 2
    print(json.dumps(summary()))
    return 0


if __name__ == '__main__':
    sys.exit(main())
