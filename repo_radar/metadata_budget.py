"""Spending bounds and accounting for incremental metadata model calls.

Before every send, the next request's input plus its maximum output (thinking included) is priced at
uncached rates and reserved. A reply settles its reservation with the reported cost, or the cost
computed from reported usage. When neither is available (a timeout, an error after sending, a reply
without usage), the whole reservation stays counted as spent: an unknown cost is never zero. A send the
provider positively refused without charging (llm.refused_without_charge) gives its reservation back.

An ordinary incremental attempt has one cap (INCREMENTAL_CAP_USD), and a protected full build another
(FULL_CAP_USD). The full cap is per attempt: it stops a build before a request that could pass it, and is
no promise that a repository can be fully built for that much. A legacy full attempt (repositories not
opted in to incremental metadata) is capped by its own estimate (legacy_allowance). The telehealth pilot
shares one durable Ledger across runs.

In a normal sync a Budget also carries the production spending context (repo_radar.spending): acquire()
admits the attempt's whole allowance against the weekly cap before its first send, every reservation is
recorded inside that allowance, and close_spending() releases what wasn't used.

Concurrent requests stay honest because one coordinator is the only writer: it reserves a whole wave
atomically with reserve_many before any of that wave is sent, workers only send, and the coordinator
settles each result once before the next wave. Nothing here is synchronized for other callers.
"""

import contextlib
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
FULL_CAP_USD = 40.0
LEGACY_MARGIN = 1.25          # a legacy attempt's estimate and local-count requests, on top of list rates

# Vendor-announced list price rises the pricing table doesn't know yet: model -> (first day of the new
# price, input, output per token). Google lists Gemini 3.8 Flash at $0.75/$3.75 per million through
# December 31, 2026, then $1.50/$7.50. The "latest" alias gets the same floor: it's a floor for the alias,
# not a promise of which model it will name.
_GEMINI_3_8_FLASH_JANUARY = (datetime(2027, 1, 1, tzinfo=timezone.utc), 1.50e-6, 7.50e-6)
ANNOUNCED_PRICE_CHANGES = {
    'gemini/gemini-3.8-flash': _GEMINI_3_8_FLASH_JANUARY,
    'gemini/gemini-flash-latest': _GEMINI_3_8_FLASH_JANUARY,
}
# An attempt that could still be running when a new price starts is priced at the new one.
_PRICE_CHANGE_MARGIN = timedelta(days=1)

# price: (input, output, announced) rates the request was bounded at, when its model isn't the Budget's own;
# send: its number in the production allowance, when there is one.
Reservation = namedtuple('Reservation', 'key upper price send', defaults=(None, None))
# per-token rates, the date the old rate stops (or None), and whether an announced rise applies now.
Rates = namedtuple('Rates', 'input output valid_until announced')


class BudgetError(Exception):
    """A request was refused before sending; the attempt stops with this reason."""


class LedgerWriteError(Exception):
    """A result was accounted for in memory but its durable ledger entry couldn't be updated, so that entry
    stays unresolved and a reopened ledger refuses further purchases. `cost` is the result's cost, if known.
    This is about storage, not about the bill."""

    def __init__(self, error, cost=None):
        super().__init__(f"the ledger entry couldn't be updated ({type(error).__name__}: {error}); it stays unresolved")
        self.cost = cost


class PricingUnavailable(BudgetError):
    pass


class BudgetExceeded(BudgetError):
    pass


def price_per_token(model):
    """(input, output) USD per token at uncached rates, taking the highest tier this app can be billed
    at, or None if unknown. Requests are never sent in batch. They name no service tier, which on Gemini
    means Standard, so its priority and flex rates don't apply; on OpenAI it means the project's configured
    tier, which can be any of them, so every other provider keeps those rates in the bound."""
    try:
        import litellm
        info = (litellm.model_cost.get(model) or litellm.model_cost.get(model.split('/', 1)[-1]) or {})
    except Exception:
        return None
    from repo_radar.llm import provider_for_model
    other_tier = ('batch', 'priority', 'flex') if provider_for_model(model) == 'gemini' else ('batch',)
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


def legacy_allowance(model, requests, synthesis=None, now=None):
    """The whole allowance a legacy full attempt is admitted for, before its first send.

    `requests` are the prepared sends as (input_tokens, max_output): the one full prompt, or every chunk.
    `synthesis` is (calls, input_tokens, max_output) for the reduction a chunked build may still need, priced
    at the bounded synthesis's call ceiling and its complete input and output ceilings, since how much of it
    runs isn't known yet. Uncached list rates times LEGACY_MARGIN, rounded up to a microdollar, at most
    FULL_CAP_USD; an estimate that can't be computed is FULL_CAP_USD. An app-side estimate, not a bill bound."""
    import math
    rates = rate_snapshot(model, now)
    if rates is None or not requests or any(tokens is None for tokens, _output in requests):
        return FULL_CAP_USD
    total = sum(tokens * rates.input + output * rates.output for tokens, output in requests)
    if synthesis:
        calls, tokens, output = synthesis
        total += calls * (tokens * rates.input + output * rates.output)
    return min(FULL_CAP_USD, math.ceil(round(total * LEGACY_MARGIN * 1e6, 3)) / 1e6)


def request_key(label, request):
    """Identity of one paid request, for the ledger's no-repeat rule."""
    canonical = json.dumps(request, sort_keys=True, separators=(',', ':'), default=str)
    return hashlib.sha256(f"{label}\n{canonical}".encode()).hexdigest()


class Budget:
    """One attempt's spending: reservations, settled cost and usage, optionally capped and/or
    backed by a durable Ledger (whose cap applies across runs)."""

    def __init__(self, model, cap=None, ledger=None, label='metadata', now=None, spending=None, owner=None):
        self.model, self.cap, self.ledger, self.label = model, cap, ledger, label
        self.spending, self.owner = spending, owner   # the production context, and the repository it bills
        self.hold = None                              # the admitted weekly allowance, once acquired
        self.now = now
        self.rates = rate_snapshot(model, now)
        self.price = (self.rates.input, self.rates.output) if self.rates else None
        self.calls = 0
        self.input_tokens = 0
        self.output_tokens = 0
        self.cost = 0.0            # settled, known
        self.retained = 0.0        # reservations kept because the cost is unknown
        self.unknown_calls = 0
        self.refused_calls = 0     # sends the provider refused without charging; their bounds were released
        self.ledger_write_failures = 0
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

    def acquire(self, allowance_usd):
        """Admit this attempt's whole allowance against the weekly cap, before its first send, and make it
        the attempt's hard limit. Raises spending.WeeklyCapRefused (nothing reserved or sent) or
        spending.SpendingError. Without a production context only the limit applies."""
        if self.hold is not None:
            raise RuntimeError("this attempt's allowance was already admitted")
        if self.spending is not None:
            self.hold = self.spending.admit(self.owner, self.model, self.label, allowance_usd)
        self.cap = allowance_usd if self.cap is None else min(self.cap, allowance_usd)

    def close_spending(self):
        """Close the admitted allowance, applying any receipt a failed write left pending, keeping known charges
        and unresolved bounds. Returns why it couldn't be recorded, or None; the open durable hold then stays as
        it was and the receipts stay pending for another close."""
        if self.hold is None:
            return None
        try:
            self.hold.close()
        except Exception as e:
            return f"the spending record couldn't be closed ({type(e).__name__})"
        return None

    def check_dispatch(self):
        """Raise spending.SpendingStopped if the sync is stopping, so a reserved send doesn't start."""
        if self.hold is not None:
            self.hold.check_dispatch()

    def reserve(self, request, input_tokens, max_output):
        """Reserve the worst-case cost of `request` before it is sent, or raise BudgetError."""
        return self.reserve_many([(request, input_tokens, max_output)])[0]

    def reserve_send(self, model, request, input_tokens, max_output, margin=1.0):
        """Reserve one legacy send to `model`, which may be a fallback with its own rates, at `margin` times
        its uncached worst case."""
        rates = rate_snapshot(model, self.now)
        if rates is None:
            raise PricingUnavailable(f"no price is known for {model}, so the request can't be bounded")
        price = (rates.input, rates.output, rates.announced)
        upper = (input_tokens * price[0] + max_output * price[1]) * margin
        return self._reserve([request], [upper], price)[0]

    def reserve_many(self, items):
        """Reserve one wave at once: `items` are (request, input_tokens, max_output). Either every request
        is reserved and persisted, or none is and BudgetError says why. The cap applies to the wave's
        total, so requests sent together can't each pass against the same remaining budget."""
        uppers = [self.upper_bound(tokens, output) for _request, tokens, output in items]
        capped = self.cap is not None or self.ledger is not None
        if capped and any(upper is None for upper in uppers):
            raise PricingUnavailable(f"no price is known for {self.model}, so the request can't be bounded")
        return self._reserve([request for request, _tokens, _output in items], uppers)

    def _reserve(self, requests, uppers, price=None):
        wave = sum(upper or 0.0 for upper in uppers)
        if self.cap is not None and self.committed() + wave > self.cap + 1e-9:
            what = 'the next request' if len(requests) == 1 else f"the next {len(requests)} requests"
            raise BudgetExceeded(f"{what} could cost up to ${wave:.2f}, which would pass this "
                                 f"attempt's ${self.cap:.2f} limit (${self.committed():.2f} committed)")
        keys = [request_key(self.label, request) for request in requests]
        if len(set(keys)) != len(keys) or any(key in self._open for key in keys):
            raise BudgetExceeded("the same request appears twice; it won't be sent again")
        if self.ledger is not None:
            self.ledger.reserve_many([(key, self.label, upper) for key, upper in zip(keys, uppers)])
        # Recorded durably inside the admitted allowance before anything is sent; not another weekly charge.
        sends = self.hold.reserve([upper or 0.0 for upper in uppers]) if self.hold else [None] * len(keys)
        self._open.update((key, upper or 0.0) for key, upper in zip(keys, uppers))
        return [Reservation(key, upper, price, send) for key, upper, send in zip(keys, uppers, sends)]

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
        price = reservation.price or self.price
        if reliable_usage(usage):
            self.input_tokens += usage.input_tokens
            self.output_tokens += usage.output_tokens
            priced = (usage.input_tokens * price[0] + usage.output_tokens * price[1]
                      if price is not None else None)
            if reliable_cost(reported_cost):
                cost = float(reported_cost)
                announced = reservation.price[2] if reservation.price else bool(self.rates and self.rates.announced)
                if announced:   # the reported cost uses the old table
                    cost = max(cost, priced)
            else:
                cost = priced
        if cost is None:
            self.unknown_calls += 1
            self.retained += upper
            self._persist(cost, lambda: self.ledger.mark_unknown(reservation.key),
                          lambda: self.hold.unknown(reservation.send))
        else:
            self.cost += cost   # in full, even above its bound: the bill is never clipped to fit the cap
            self._persist(cost, lambda: self.ledger.settle(reservation.key, cost),
                          lambda: self.hold.settle(reservation.send, cost))
        return cost

    def _persist(self, cost, write, record=None):
        """The result is already accounted for in memory, so a failed write must not be accounted for again."""
        writes = ([write] if self.ledger is not None else []) + ([record] if self.hold is not None else [])
        for one in writes:
            try:
                one()
            except Exception as e:
                self.ledger_write_failures += 1
                raise LedgerWriteError(e, cost) from None

    def refuse(self, reservation):
        """The provider refused the send without charging for it (a rate limit, or a server error that reported
        no usage): its reservation goes back to the attempt, so an authorized retry or fallback still fits. A
        durable pilot ledger, which has no such state, keeps it as unknown."""
        upper = self._open.pop(reservation.key, 0.0)
        self.calls += 1
        if self.ledger is not None:
            self.unknown_calls += 1
            self.retained += upper
        else:
            self.refused_calls += 1
        self._persist(None, lambda: self.ledger.mark_unknown(reservation.key),
                      lambda: self.hold.release(reservation.send))

    def fail(self, reservation):
        """The send raised after the reservation: whether it was billed is unknown, so keep it."""
        upper = self._open.pop(reservation.key, 0.0)
        self.calls += 1
        self.unknown_calls += 1
        self.retained += upper
        self._persist(None, lambda: self.ledger.mark_unknown(reservation.key),
                      lambda: self.hold.unknown(reservation.send))

    def summary(self):
        """cost_usd is the total, or None when any call's cost is unknown or any reservation is still open;
        known_cost_usd is always the settled subtotal, and retained_reservation_usd what unknown calls keep
        reserved."""
        known = round(self.cost, 6)
        return {'model': self.model, 'calls': self.calls, 'input_tokens': self.input_tokens,
                'output_tokens': self.output_tokens, 'cost_usd': None if self.unknown_calls or self._open else known,
                'known_cost_usd': known, 'unknown_cost_calls': self.unknown_calls,
                'retained_reservation_usd': round(self.retained, 6),
                'open_reservation_usd': round(sum(self._open.values()), 6),
                'refused_calls': self.refused_calls,
                'ledger_write_failures': self.ledger_write_failures, **self.extra}


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
        try:
            with os.fdopen(fd, 'w') as handle:
                json.dump(data, handle, indent=2)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.path)
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(tmp)
            raise

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
