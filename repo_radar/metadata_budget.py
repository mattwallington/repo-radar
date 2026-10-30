"""Spending bounds and accounting for incremental metadata model calls.

Before every send, the next request's input plus its maximum output (thinking included) is priced at
uncached rates and reserved. A reply settles its reservation with the reported cost, or the cost
computed from reported usage. When neither is available (a timeout, an error after sending, a reply
without usage), the whole reservation stays counted as spent: an unknown cost is never zero.

An ordinary incremental attempt has an $8 cap. Full rebuilds in sync keep the existing uncapped
cost policy but are still accounted. The telehealth pilot shares one durable Ledger across runs.
"""

import hashlib
import json
import os
import tempfile
from collections import namedtuple
from datetime import datetime, timezone
from pathlib import Path

INCREMENTAL_CAP_USD = 8.0

Reservation = namedtuple('Reservation', 'key upper')


class BudgetError(Exception):
    """A request was refused before sending; the attempt stops with this reason."""


class PricingUnavailable(BudgetError):
    pass


class BudgetExceeded(BudgetError):
    pass


def price_per_token(model):
    """(input, output) USD per token at uncached rates, taking the highest tier, or None if unknown."""
    try:
        import litellm
        info = (litellm.model_cost.get(model) or litellm.model_cost.get(model.split('/', 1)[-1]) or {})
    except Exception:
        return None
    inputs = [v for k, v in info.items() if k.startswith('input_cost_per_token') and 'cache' not in k
              and 'batch' not in k and isinstance(v, (int, float))]
    outputs = [v for k, v in info.items() if (k.startswith('output_cost_per_token')
               or k.startswith('output_cost_per_reasoning_token')) and 'batch' not in k and isinstance(v, (int, float))]
    if not inputs or not outputs:
        return None
    return max(inputs), max(outputs)


def request_key(label, request):
    """Identity of one paid request, for the ledger's no-repeat rule."""
    canonical = json.dumps(request, sort_keys=True, separators=(',', ':'), default=str)
    return hashlib.sha256(f"{label}\n{canonical}".encode()).hexdigest()


class Budget:
    """One attempt's spending: reservations, settled cost and usage, optionally capped and/or
    backed by a durable Ledger (whose cap applies across runs)."""

    def __init__(self, model, cap=None, ledger=None, label='metadata'):
        self.model, self.cap, self.ledger, self.label = model, cap, ledger, label
        self.price = price_per_token(model)
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

    def reserve(self, request, input_tokens, max_output):
        """Reserve the worst-case cost of `request` before it is sent, or raise BudgetError."""
        upper = self.upper_bound(input_tokens, max_output)
        capped = self.cap is not None or self.ledger is not None
        if upper is None and capped:
            raise PricingUnavailable(f"no price is known for {self.model}, so the request can't be bounded")
        if self.cap is not None and self.committed() + upper > self.cap + 1e-9:
            raise BudgetExceeded(f"the next request could cost up to ${upper:.2f}, which would pass this "
                                 f"attempt's ${self.cap:.2f} limit (${self.committed():.2f} committed)")
        key = request_key(self.label, request)
        if self.ledger is not None:
            self.ledger.reserve(key, self.label, upper)
        self._open[key] = upper or 0.0
        return Reservation(key, upper)

    def settle(self, reservation, usage, reported_cost):
        """Record a reply. Reported cost wins; else cost from usage; else the reservation is kept."""
        upper = self._open.pop(reservation.key, 0.0)
        self.calls += 1
        if usage is not None:
            self.input_tokens += usage.input_tokens or 0
            self.output_tokens += usage.output_tokens or 0
        cost = reported_cost
        tokens = (usage.input_tokens or 0) + (usage.output_tokens or 0) if usage else None
        if cost is not None and cost == 0 and tokens:
            cost = None                      # a zero cost for real usage means "not priced"
        if cost is None and usage is not None and usage.input_tokens is not None \
                and usage.output_tokens is not None and self.price is not None:
            cost = usage.input_tokens * self.price[0] + usage.output_tokens * self.price[1]
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
        return {'model': self.model, 'calls': self.calls, 'input_tokens': self.input_tokens,
                'output_tokens': self.output_tokens, 'cost_usd': round(self.cost, 6),
                'unknown_cost_calls': self.unknown_calls, 'retained_reservation_usd': round(self.retained, 6),
                **self.extra}


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

    def reserve(self, key, label, upper):
        data = self._load()
        if upper is None:
            raise PricingUnavailable("the request's cost can't be bounded, so the capped run won't send it")
        if any(e['key'] == key for e in data['entries']):
            raise BudgetExceeded("this exact request was already bought or reserved; it won't be sent again")
        if label not in self.allowances:
            raise BudgetExceeded(f"no allowance for {label!r}")
        total, mine = self._spent(data['entries']), self._spent(data['entries'], label)
        if total + upper > self.cap + 1e-9:
            raise BudgetExceeded(f"up to ${upper:.2f} more would pass the ${self.cap:.2f} cap (${total:.2f} spent)")
        if mine + upper > self.allowances[label] + 1e-9:
            raise BudgetExceeded(f"up to ${upper:.2f} more would pass the ${self.allowances[label]:.2f} "
                                 f"{label} allowance (${mine:.2f} spent)")
        data['entries'].append({'key': key, 'label': label, 'reserved_usd': upper, 'status': 'reserved',
                                'actual_usd': None, 'at': datetime.now(timezone.utc).isoformat()})
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
