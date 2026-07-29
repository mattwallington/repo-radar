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
                  version=None, finished_at=None):
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
        errors = _num(stats.get('errors'), 0)
        is_full = mode == 'full'
        payload = {
            'schema': RECEIPT_SCHEMA,
            'channel': ch,
            'trigger': trig,
            'mode': mode if mode in ('full', 'metadata-only', 'repos-only', 'skip-metadata')
                    else 'full',
            'startedAt': str(started_at) if started_at else None,
            'finishedAt': finished_at or datetime.now(timezone.utc).isoformat(),
            'version': str(version) if version else None,
            'stats': {
                'total': _num(stats.get('total'), 0),
                'updated': _num(stats.get('updated'), 0),
                'cloned': _num(stats.get('cloned'), 0),
                'skipped': _num(stats.get('skipped'), 0),
                'errors': errors,
                'metadataGenerated': _num(stats.get('metadata_generated'), 0),
                'apiCost': round(_num(stats.get('api_cost'), 0.0), 4),
            },
            # A run with per-repo errors still COMPLETED; the catch-up logic must not re-run a
            # sync that finished, only one that never happened.
            'completed': True,
            'errorFree': errors == 0,
            # Whether this run can stand in for the scheduled job. A partial run did not do the
            # scheduled work, so it must not suppress the next occurrence even though it
            # completed successfully.
            'qualifiesForSchedule': bool(is_full),
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
    if not isinstance(data.get('finishedAt'), str) or not data['finishedAt']:
        return None
    if data.get('channel') not in VALID_CHANNELS:
        return None
    if data.get('trigger') not in VALID_TRIGGERS:
        return None
    if not isinstance(data.get('qualifiesForSchedule'), bool):
        return None
    stats = data.get('stats')
    if not isinstance(stats, dict) or not isinstance(stats.get('errors'), int):
        return None
    return data
