"""Run receipts — durable proof that a sync completed, independent of the Electron app.

Why this exists: progress is reported to a status server inside the running app, and only the
app persists the last-sync time. So a scheduled run that completes while the app is closed —
the normal case for a 9am LaunchAgent job — finished successfully and left nothing behind. The
tray showed a stale time, and worse, the missed-sync catch-up logic reads that same field, so
the app believed the last sync was older than it was and could launch a redundant paid sync.

The receipt is written by Python only, and read (then reconciled) by Electron only. Neither
process writes the other's file, so there is no concurrent-writer problem to reason about.

A receipt records not just "a run finished" but whether that run is EQUIVALENT to the scheduled
job it might suppress. A dev-channel run, or a partial run (--skip-metadata / --repos-only /
--metadata-only), completes legitimately but has not done the work the stable full schedule
exists to do, so it must not satisfy that schedule. `channel` and `qualifiesForSchedule` carry
that distinction explicitly rather than leaving the reader to infer it.
"""
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

RECEIPT_SCHEMA = 2
RECEIPT_BASENAME = 'last-run'

# Channel-scoped from the start. status.json is un-namespaced for historical reasons, and this
# is a new artifact that need not inherit that ambiguity: a dev run sharing a HOME must not be
# able to advance the stable channel's watermark.
CHANNEL_ENV = 'REPO_RADAR_CHANNEL'
DEFAULT_CHANNEL = 'stable'
VALID_CHANNELS = ('stable', 'dev')
# Only the stable channel owns a schedule; a dev run must never satisfy it.
SCHEDULING_CHANNEL = 'stable'

# Set explicitly by every invoker so provenance is stated, not inferred. The previous code
# guessed the trigger from whether a window was being shown — and that attribute never existed
# on the CLI's namespace, so the guess silently resolved to "manual" for every run, including
# genuine LaunchAgent jobs.
TRIGGER_ENV = 'REPO_RADAR_TRIGGER'
VALID_TRIGGERS = ('scheduled', 'catchup', 'manual', 'cli')
# Triggers that represent the scheduled job being satisfied, as opposed to a user asking for a
# sync right now. Both catch-up flavours count: catch-up exists precisely to stand in for a
# missed occurrence.
SCHEDULE_TRIGGERS = ('scheduled', 'catchup')


def parse_instant(value):
    """Parse an ISO-8601 timestamp into a timezone-aware datetime, or None.

    Exists because the lock-held guard once compared timestamps as STRINGS: a receipt with
    finishedAt="zzzz" passed a non-empty-string check, and "zzzz" sorts above any ISO date, so a
    corrupt receipt declined every catch-up indefinitely. Invalid evidence must never decline work.
    """
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace('Z', '+00:00'))
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _valid_enum(value, allowed, default):
    candidate = (value or '').strip().lower()
    return candidate if candidate in allowed else default


def resolve_trigger(default='manual'):
    """The trigger the invoker declared, or a validated `default`.

    The default is validated too: a caller passing something unknown gets 'manual' rather than
    having an unrecognised string reach the log and the receipt.
    """
    return _valid_enum(os.environ.get(TRIGGER_ENV), VALID_TRIGGERS,
                       _valid_enum(default, VALID_TRIGGERS, 'manual'))


def resolve_channel(default=DEFAULT_CHANNEL):
    return _valid_enum(os.environ.get(CHANNEL_ENV), VALID_CHANNELS,
                       _valid_enum(default, VALID_CHANNELS, DEFAULT_CHANNEL))


def receipt_path(config_dir, channel=None):
    """Channel-scoped path, e.g. last-run-stable.json."""
    ch = _valid_enum(channel, VALID_CHANNELS, resolve_channel())
    return Path(config_dir) / f'{RECEIPT_BASENAME}-{ch}.json'


def _num(value, default=0):
    """Coerce to a real number, or `default`. Never raises."""
    try:
        if isinstance(value, bool) or value is None:
            return default
        return type(default)(value)
    except (TypeError, ValueError):
        return default


def _count(value):
    """A non-negative integer counter. The writer must never emit a receipt its own reader
    rejects, so clamp here rather than trusting the caller's stats dict."""
    return max(0, _num(value, 0))


# Exit code for a catch-up that correctly declined to run. Distinct from 0 so the caller does not
# stamp a completion timestamp for work that never happened.
EXIT_SKIPPED_NO_WORK = 66

VALID_MODES = ('full', 'skip-metadata', 'repos-only', 'metadata-only')


def qualifies_for_schedule(channel, mode):
    """THE schedule-equivalence rule. Mirrors menubar/run-receipt.js qualifiesForSchedule.

    Kept as one function used BOTH when writing a receipt and by the lock-held catch-up guard: an
    earlier version computed `is_full` at write time while ignoring the channel, so a full DEV run
    persisted qualifiesForSchedule=true and the guard then trusted that stale value in production —
    a rule in two places, disagreeing.
    """
    return channel == SCHEDULING_CHANNEL and mode == 'full'


def run_mode(*, skip_metadata=False, metadata_only=False, repos_only=False):
    """'full' only when the run did the whole job; otherwise which part it skipped."""
    if metadata_only:
        return 'metadata-only'
    if repos_only:
        return 'repos-only'
    if skip_metadata:
        return 'skip-metadata'
    return 'full'


def write_receipt(config_dir, *, trigger, started_at, stats, channel=None, mode='full',
                  version=None, finished_at=None, warning=None):
    """Atomically write an owner-only completion receipt. Returns the path, or None on failure.

    NEVER raises. Everything — including payload construction — is inside the boundary, because
    a sync that genuinely completed must not be reported as failed over its own bookkeeping.
    An earlier version built the payload outside the try, so a single non-numeric stat raised
    straight through into the caller after the work was already done.
    """
    try:
        ch = _valid_enum(channel, VALID_CHANNELS, resolve_channel())
        trig = _valid_enum(trigger, VALID_TRIGGERS, 'manual')
        stats = stats if isinstance(stats, dict) else {}
        errors = _count(stats.get('errors'))
        # Repositories excluded from INDEX.md. Kept out of 'errors' so per-repo error counts stay
        # meaningful, but it must still be able to make a run not error-free: a sync whose index
        # is missing repositories did not leave the cache in a usable state.
        index_dropped = _count(stats.get('index_dropped'))
        mode = mode if mode in VALID_MODES else 'full'
        payload = {
            'schema': RECEIPT_SCHEMA,
            'channel': ch,
            'trigger': trig,
            'mode': mode,
            'startedAt': str(started_at) if started_at else None,
            'finishedAt': finished_at or datetime.now(timezone.utc).isoformat(),
            'version': str(version) if version else None,
            'stats': {
                'total': _count(stats.get('total')),
                'updated': _count(stats.get('updated')),
                'cloned': _count(stats.get('cloned')),
                'skipped': _count(stats.get('skipped')),
                'errors': errors,
                'metadataGenerated': _count(stats.get('metadata_generated')),
                'apiCost': max(0.0, round(_num(stats.get('api_cost'), 0.0), 4)),
                'indexDropped': index_dropped,
            },
            # Actionable outcome the live status update also carries. Without it here, a run that
            # finished with the app closed and generated no metadata (missing API key, say)
            # recorded itself as a clean success, and the reader had no way to know otherwise.
            'warning': str(warning) if warning else None,
            # A run with per-repo errors still COMPLETED; the catch-up logic must not re-run a
            # sync that finished, only one that never happened.
            'completed': True,
            # "Nothing the user needs to act on" — errors, an incomplete index, or a warning all
            # disqualify. JS runSucceeded() mirrors this exactly; the parity gate compares them.
            'errorFree': errors == 0 and index_dropped == 0 and not warning,
            # Whether this run can stand in for the scheduled job. A partial run did not do the
            # scheduled work, so it must not suppress the next occurrence even though it
            # completed successfully.
            'qualifiesForSchedule': qualifies_for_schedule(ch, mode),
        }

        target = receipt_path(config_dir, ch)
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(target.parent), prefix='.last-run-', suffix='.tmp')
        try:
            with os.fdopen(fd, 'w') as handle:
                json.dump(payload, handle, indent=2)
                handle.write('\n')
            os.chmod(tmp, 0o600)
            os.replace(tmp, target)      # atomic: readers never see a partial receipt
            os.chmod(target, 0o600)      # tighten a pre-existing permissive file too
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        return target
    except Exception:
        return None


def read_receipt(config_dir, channel=None):
    """Return a receipt that passes TYPE validation, or None.

    Validating shape rather than mere presence: a receipt with a numeric timestamp or a string
    error count would otherwise reach the reconciler and be compared or displayed as if sound.
    """
    try:
        data = json.loads(receipt_path(config_dir, channel).read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get('schema') != RECEIPT_SCHEMA:
        return None
    if data.get('completed') is not True:
        return None
    finished = parse_instant(data.get('finishedAt'))
    if finished is None:
        return None                     # unparseable — matches the JS validator
    if finished > datetime.now(timezone.utc):
        return None                     # clock skew / tampering — also matches JS
    if data.get('channel') not in VALID_CHANNELS:
        return None
    if data.get('trigger') not in VALID_TRIGGERS:
        return None
    if data.get('mode') not in VALID_MODES:
        return None
    if not isinstance(data.get('qualifiesForSchedule'), bool):
        return None
    def _is_count(value):
        # bool is a subclass of int in Python but Number.isInteger(true) is false in JS. Without
        # this the two validators disagree on {"errors": true}, which is exactly the kind of
        # divergence the parity gate exists to prevent. Counters are also non-negative: a negative
        # one satisfies neither "== 0" nor "> 0" and used to slip between the success rule and the
        # needs-attention rule.
        return isinstance(value, int) and not isinstance(value, bool) and value >= 0

    stats = data.get('stats')
    if not isinstance(stats, dict) or not _is_count(stats.get('errors')):
        return None
    # Additive fields, absent on older schema-2 receipts: absent means "none", but anything
    # present must have the right type. Truthiness alone decides whether a warning fails the run,
    # so a dict or a number would silently read as "this run needs attention". Mirrors the JS
    # validator; the parity gate compares them.
    # A sentinel, because dict.get() conflates "absent" with "explicitly null" — and JS can tell
    # them apart (undefined vs null). Absent is a pre-upgrade receipt and fine; an explicit null is
    # a malformed one, and accepting it here while JS rejected it meant the two processes disagreed
    # about whether the same file was usable.
    _MISSING = object()
    dropped = stats.get('indexDropped', _MISSING)
    if dropped is not _MISSING and not _is_count(dropped):
        return None
    warning = data.get('warning')
    if warning is not None and not isinstance(warning, str):
        return None
    return data
