"""Run receipts — durable proof that a sync completed, independent of the Electron app.

Why this exists: progress is reported to a status server inside the running app, and only the
app persists the last-sync time. So a scheduled run that completes while the app is closed —
the normal case for a 9am LaunchAgent job — finished successfully and left nothing behind. The
tray showed a stale time, and worse, the missed-sync catch-up logic reads that same field, so
the app believed the last sync was older than it was and could launch a redundant paid sync.

The receipt is written by Python only, and read (then reconciled into the status file) by
Electron only. Neither process writes the other's file, so there is no concurrent-writer
problem to reason about. Owner-only because it records repository names and counts.
"""
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

RECEIPT_NAME = 'last-run.json'
RECEIPT_SCHEMA = 1

# Set explicitly by the LaunchAgent so provenance is stated, not inferred. The previous code
# guessed the trigger from whether a window was being shown, so genuine scheduled runs
# recorded themselves as "manual" and the logs could not tell the two apart.
TRIGGER_ENV = 'REPO_RADAR_TRIGGER'
VALID_TRIGGERS = ('scheduled', 'manual', 'cli')


def resolve_trigger(default='manual'):
    """The trigger the invoker declared, or `default` when nothing was declared."""
    declared = (os.environ.get(TRIGGER_ENV) or '').strip().lower()
    return declared if declared in VALID_TRIGGERS else default


def receipt_path(config_dir):
    return Path(config_dir) / RECEIPT_NAME


def write_receipt(config_dir, *, trigger, started_at, stats, version=None, finished_at=None):
    """Atomically write an owner-only completion receipt. Returns the path, or None on failure.

    Never raises: a sync that genuinely completed must not be reported as failed because its
    receipt could not be written.
    """
    target = receipt_path(config_dir)
    payload = {
        'schema': RECEIPT_SCHEMA,
        'trigger': trigger,
        'startedAt': started_at,
        'finishedAt': finished_at or datetime.now(timezone.utc).isoformat(),
        'version': version,
        'stats': {
            'total': stats.get('total', 0),
            'updated': stats.get('updated', 0),
            'cloned': stats.get('cloned', 0),
            'skipped': stats.get('skipped', 0),
            'errors': stats.get('errors', 0),
            'metadataGenerated': stats.get('metadata_generated', 0),
            'apiCost': round(float(stats.get('api_cost', 0.0)), 4),
        },
        # A run with per-repo errors still COMPLETED; the distinction matters because the
        # catch-up logic should not re-run a sync that finished, only one that never happened.
        'completed': True,
        'errorFree': stats.get('errors', 0) == 0,
    }
    try:
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


def read_receipt(config_dir):
    """Return the receipt dict, or None if absent/unreadable/foreign-schema."""
    try:
        data = json.loads(receipt_path(config_dir).read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get('schema') != RECEIPT_SCHEMA:
        return None
    return data
