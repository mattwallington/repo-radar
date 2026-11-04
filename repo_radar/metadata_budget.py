"""Spending bounds and accounting for incremental metadata model calls.

Before every send, the next request's input plus its maximum output (thinking included) is priced at
uncached rates and reserved. A reply settles its reservation with the reported cost, or the cost
computed from reported usage. When neither is available (a timeout, an error after sending, a reply
without usage), the whole reservation stays counted as spent: an unknown cost is never zero.

An ordinary incremental attempt has one cap (INCREMENTAL_CAP_USD). Full rebuilds in sync keep the
existing uncapped cost policy but are still accounted. The telehealth pilot shares one durable Ledger
across runs.

Concurrent requests stay honest because one coordinator is the only writer: it reserves a whole wave
atomically with reserve_many before any of that wave is sent, workers only send, and the coordinator
settles each result once before the next wave. Nothing here is synchronized for other callers.
"""

import fcntl
import hashlib
import json
import math
import os
import tempfile
from collections import namedtuple
from datetime import datetime, timedelta, timezone
from pathlib import Path

INCREMENTAL_CAP_USD = 12.0

# Vendor-announced list price rises the pricing table doesn't know yet: model -> (first day of the new
# price, input, output per token). Google lists Gemini 3.8 Flash at $0.75/$3.75 per million through
# December 31, 2026, then $1.50/$7.50.
ANNOUNCED_PRICE_CHANGES = {
    'gemini/gemini-3.8-flash': (datetime(2027, 1, 1, tzinfo=timezone.utc), 1.50e-6, 7.50e-6),
}
# An attempt that could still be running when a new price starts is priced at the new one.
_PRICE_CHANGE_MARGIN = timedelta(days=1)

Reservation = namedtuple('Reservation', 'key upper')
# per-token rates, the date the old rate stops (or None), and whether an announced rise applies now.
Rates = namedtuple('Rates', 'input output valid_until announced')


class BudgetError(Exception):
    """A request was refused before sending; the attempt stops with this reason."""


class PricingUnavailable(BudgetError):
    pass


class BudgetExceeded(BudgetError):
    pass


def price_per_token(model):
    """(input, output) USD per token at uncached rates, taking the highest tier this app can be billed
    at, or None if unknown. Requests are never sent at priority, flex or batch service tiers."""
    try:
        import litellm
        info = (litellm.model_cost.get(model) or litellm.model_cost.get(model.split('/', 1)[-1]) or {})
    except Exception:
        return None
    other_tier = ('batch', 'priority', 'flex')
    inputs = [v for k, v in info.items() if k.startswith('input_cost_per_token') and 'cache' not in k
              and not any(t in k for t in other_tier) and isinstance(v, (int, float))]
    outputs = [v for k, v in info.items() if (k.startswith('output_cost_per_token')
               or k.startswith('output_cost_per_reasoning_token')) and not any(t in k for t in other_tier)
               and isinstance(v, (int, float))]
    if not inputs or not outputs:
        return None
    return max(inputs), max(outputs)


def rate_snapshot(model, now=None):
    """The rates one attempt uses for its whole life, for admission and every reservation: today's, or an
    announced higher price once it is about to start. None when the model has no known price."""
    price = price_per_token(model)
    if price is None:
        return None
    change = ANNOUNCED_PRICE_CHANGES.get(model)
    if change is None:
        return Rates(price[0], price[1], None, False)
    starts, new_input, new_output = change
    now = now or datetime.now(timezone.utc)
    if now + _PRICE_CHANGE_MARGIN >= starts:
        return Rates(max(price[0], new_input), max(price[1], new_output), None, True)
    return Rates(price[0], price[1], starts.date().isoformat(), False)


def reliable_usage(usage):
    """True only for genuine positive integer input and output counts. Providers (and litellm's
    adapters) fill absent counts with zero, which is not evidence that a request was free."""
    def positive(value):
        return isinstance(value, int) and not isinstance(value, bool) and value > 0
    return usage is not None and positive(usage.input_tokens) and positive(usage.output_tokens)


def reliable_cost(cost):
    return isinstance(cost, (int, float)) and not isinstance(cost, bool) and math.isfinite(cost) and cost > 0


def request_key(label, request):
    """Identity of one paid request, for the ledger's no-repeat rule."""
    canonical = json.dumps(request, sort_keys=True, separators=(',', ':'), default=str)
    return hashlib.sha256(f"{label}\n{canonical}".encode()).hexdigest()


class Budget:
    """One attempt's spending: reservations, settled cost and usage, optionally capped and/or
    backed by a durable Ledger (whose cap applies across runs)."""

    def __init__(self, model, cap=None, ledger=None, label='metadata', now=None):
        self.model, self.cap, self.ledger, self.label = model, cap, ledger, label
        self.rates = rate_snapshot(model, now)
        self.price = (self.rates.input, self.rates.output) if self.rates else None
        self.calls = 0
        self.input_tokens = 0
        self.output_tokens = 0
        self.cost = 0.0            # settled, known
        self.retained = 0.0        # reservations kept because the cost is unknown
        self.unknown_calls = 0
        self._open = {}            # key -> upper
        self.extra = {}            # attempt facts for the record: changed and read bytes

    def upper_bound(self, input_tokens, max_output):
        if self.price is None:
            return None
        return input_tokens * self.price[0] + max_output * self.price[1]

    def committed(self):
        return self.cost + self.retained + sum(self._open.values())

    def admit(self, quote_usd):
        """Check a whole update's quote against what is left, before its first generation call. A logical
        check only: nothing is written or charged, and each request still reserves its own cost."""
        capped = self.cap is not None or self.ledger is not None
        if quote_usd is None and capped:
            raise PricingUnavailable(f"no price is known for {self.model}, so the update can't be bounded")
        if self.cap is not None and self.committed() + quote_usd > self.cap + 1e-9:
            raise BudgetExceeded(f"this update could cost up to ${quote_usd:.2f}, which would pass its "
                                 f"${self.cap:.2f} limit (${self.committed():.2f} committed)")
        if self.ledger is not None:
            self.ledger.check(self.label, quote_usd)

    def reserve(self, request, input_tokens, max_output):
        """Reserve the worst-case cost of `request` before it is sent, or raise BudgetError."""
        return self.reserve_many([(request, input_tokens, max_output)])[0]

    def reserve_many(self, items):
        """Reserve one wave at once: `items` are (request, input_tokens, max_output). Either every request
        is reserved and persisted, or none is and BudgetError says why. The cap applies to the wave's
        total, so requests sent together can't each pass against the same remaining budget."""
        uppers = [self.upper_bound(tokens, output) for _request, tokens, output in items]
        capped = self.cap is not None or self.ledger is not None
        if capped and any(upper is None for upper in uppers):
            raise PricingUnavailable(f"no price is known for {self.model}, so the request can't be bounded")
        wave = sum(upper or 0.0 for upper in uppers)
        if self.cap is not None and self.committed() + wave > self.cap + 1e-9:
            what = 'the next request' if len(items) == 1 else f"the next {len(items)} requests"
            raise BudgetExceeded(f"{what} could cost up to ${wave:.2f}, which would pass this "
                                 f"attempt's ${self.cap:.2f} limit (${self.committed():.2f} committed)")
        keys = [request_key(self.label, request) for request, _tokens, _output in items]
        if len(set(keys)) != len(keys) or any(key in self._open for key in keys):
            raise BudgetExceeded("the same request appears twice; it won't be sent again")
        if self.ledger is not None:
            self.ledger.reserve_many([(key, self.label, upper) for key, upper in zip(keys, uppers)])
        self._open.update((key, upper or 0.0) for key, upper in zip(keys, uppers))
        return [Reservation(key, upper) for key, upper in zip(keys, uppers)]

    def settle(self, reservation, usage, reported_cost):
        """Record a reply and return its cost, or None when it is unknown.

        Only reliable usage (positive input and output counts) can release a reservation: with it, a
        finite positive reported cost wins, else the cost is priced from the usage. Anything else (no
        usage, zero-filled or partial usage, a missing or invalid cost with no price) keeps the whole
        reservation counted as spent.
        """
        upper = self._open.pop(reservation.key, 0.0)
        self.calls += 1
        cost = None
        if reliable_usage(usage):
            self.input_tokens += usage.input_tokens
            self.output_tokens += usage.output_tokens
            priced = (usage.input_tokens * self.price[0] + usage.output_tokens * self.price[1]
                      if self.price is not None else None)
            if reliable_cost(reported_cost):
                cost = float(reported_cost)
                if self.rates is not None and self.rates.announced:   # the reported cost uses the old table
                    cost = max(cost, priced)
            else:
                cost = priced
        if cost is None:
            self.unknown_calls += 1
            self.retained += upper
            if self.ledger is not None:
                self.ledger.mark_unknown(reservation.key)
        else:
            self.cost += cost
            if self.ledger is not None:
                self.ledger.settle(reservation.key, cost)
        return cost

    def fail(self, reservation):
        """The send raised after the reservation: whether it was billed is unknown, so keep it."""
        upper = self._open.pop(reservation.key, 0.0)
        self.calls += 1
        self.unknown_calls += 1
        self.retained += upper
        if self.ledger is not None:
            self.ledger.mark_unknown(reservation.key)

    def summary(self):
        """cost_usd is the total, or None when any call's cost is unknown; known_cost_usd is always the
        settled subtotal, and retained_reservation_usd what unknown calls keep reserved."""
        known = round(self.cost, 6)
        return {'model': self.model, 'calls': self.calls, 'input_tokens': self.input_tokens,
                'output_tokens': self.output_tokens, 'cost_usd': None if self.unknown_calls else known,
                'known_cost_usd': known, 'unknown_cost_calls': self.unknown_calls,
                'retained_reservation_usd': round(self.retained, 6), **self.extra}


class LockHeld(Exception):
    pass


def acquire_exclusive_lock(path):
    """Take a nonblocking exclusive flock on `path` (created owner-only), returning its descriptor.
    Close the descriptor to release it; never delete or replace the file, since a new inode would let
    a second holder in. Raises LockHeld when another process holds it."""
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        raise LockHeld(str(path)) from None
    return fd


class Ledger:
    """A durable, owner-only spending ledger for a capped experiment (the telehealth pilot).

    The cap and per-label allowances are fixed when the ledger is created; reopening it with
    different limits is refused rather than resetting them. Every reservation is written and synced
    before its request is sent, a request already reserved can never be bought again, and a
    reservation whose cost is unknown stays counted as spent.
    """

    SCHEMA = 'repo-radar-spend-ledger/1'

    def __init__(self, path, cap_usd, allowances):
        self.path = Path(path)
        self.cap = float(cap_usd)
        self.allowances = {k: float(v) for k, v in allowances.items()}
        if self.path.exists():
            data = self._load()
            if data.get('cap_usd') != self.cap or data.get('allowances') != self.allowances:
                raise ValueError(f"{self.path} was created with a ${data.get('cap_usd')} cap and allowances "
                                 f"{data.get('allowances')}; its limits can't be changed")
        else:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as handle:
                json.dump({'schema': self.SCHEMA, 'cap_usd': self.cap, 'allowances': self.allowances,
                           'entries': []}, handle, indent=2)
                handle.flush()
                os.fsync(handle.fileno())

    def _load(self):
        with open(self.path) as handle:
            data = json.load(handle)
        if data.get('schema') != self.SCHEMA:
            raise ValueError(f"{self.path} is not a spending ledger")
        return data

    def _save(self, data):
        fd, tmp = tempfile.mkstemp(dir=str(self.path.parent), prefix=f".{self.path.name}.", suffix='.tmp')
        with os.fdopen(fd, 'w') as handle:
            json.dump(data, handle, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.path)

    @staticmethod
    def _spent(entries, label=None):
        return sum(e['actual_usd'] if e['status'] == 'settled' else e['reserved_usd']
                   for e in entries if label is None or e['label'] == label)

    def spent(self, label=None):
        return self._spent(self._load()['entries'], label)

    def _refuse_unless_fits(self, entries, label, upper):
        unresolved = [e for e in entries if e['status'] in ('reserved', 'unknown')]
        if unresolved:
            held = sum(e['reserved_usd'] for e in unresolved)
            raise BudgetExceeded(f"the ledger has {len(unresolved)} request(s) of unknown cost holding ${held:.2f}; "
                                 f"ask the manager to reconcile {self.path} before any further paid request")
        if label not in self.allowances:
            raise BudgetExceeded(f"no allowance for {label!r}")
        total, mine = self._spent(entries), self._spent(entries, label)
        if total + upper > self.cap + 1e-9:
            raise BudgetExceeded(f"up to ${upper:.2f} more would pass the ${self.cap:.2f} cap (${total:.2f} spent)")
        if mine + upper > self.allowances[label] + 1e-9:
            raise BudgetExceeded(f"up to ${upper:.2f} more would pass the ${self.allowances[label]:.2f} "
                                 f"{label} allowance (${mine:.2f} spent)")

    def check(self, label, upper):
        """Whether `upper` more could still be spent under `label`; raises BudgetExceeded if not. Writes
        nothing: a whole update's admission quote isn't a charge."""
        self._refuse_unless_fits(self._load()['entries'], label, upper)

    def reserve(self, key, label, upper):
        self.reserve_many([(key, label, upper)])

    def reserve_many(self, items):
        """Persist one wave's reservations in a single write, after checking them all together. A request
        left unresolved by an earlier wave or run blocks it: the coordinator settles every request of a
        wave before reserving the next, so an entry found open here isn't this wave's in-flight work."""
        data = self._load()
        if any(upper is None for _key, _label, upper in items):
            raise PricingUnavailable("the request's cost can't be bounded, so the capped run won't send it")
        keys = {e['key'] for e in data['entries']}
        if any(key in keys for key, _label, _upper in items):
            raise BudgetExceeded("this exact request was already bought or reserved; it won't be sent again")
        for label in {label for _key, label, _upper in items}:
            self._refuse_unless_fits(data['entries'], label,
                                     sum(upper for _key, other, upper in items if other == label))
        now = datetime.now(timezone.utc).isoformat()
        data['entries'].extend({'key': key, 'label': label, 'reserved_usd': upper, 'status': 'reserved',
                                'actual_usd': None, 'at': now} for key, label, upper in items)
        self._save(data)

    def _update(self, key, **fields):
        data = self._load()
        for entry in data['entries']:
            if entry['key'] == key:
                entry.update(fields)
        self._save(data)

    def settle(self, key, actual):
        self._update(key, status='settled', actual_usd=actual)

    def mark_unknown(self, key):
        self._update(key, status='unknown')
