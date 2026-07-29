"""Completion receipts + declared trigger provenance."""
import json
import os
import stat

import pytest

from repo_radar.receipts import (
    RECEIPT_SCHEMA,
    TRIGGER_ENV,
    read_receipt,
    receipt_path,
    resolve_trigger,
    write_receipt,
)

STATS = {"total": 30, "updated": 30, "cloned": 0, "skipped": 0,
         "errors": 3, "metadata_generated": 2, "api_cost": 4.9665}


def test_trigger_is_declared_not_inferred(monkeypatch):
    """The old code guessed from 'is a window shown', so launchd runs logged 'manual'."""
    monkeypatch.setenv(TRIGGER_ENV, "scheduled")
    assert resolve_trigger(default="manual") == "scheduled"


def test_trigger_falls_back_when_nothing_declared(monkeypatch):
    monkeypatch.delenv(TRIGGER_ENV, raising=False)
    assert resolve_trigger(default="manual") == "manual"
    assert resolve_trigger(default="scheduled") == "scheduled"


def test_unrecognised_trigger_is_rejected(monkeypatch):
    """A junk value must not end up in the log or receipt as if it were meaningful."""
    monkeypatch.setenv(TRIGGER_ENV, "../../etc/passwd")
    assert resolve_trigger(default="manual") == "manual"


def test_receipt_is_written_owner_only(tmp_path):
    target = write_receipt(tmp_path, trigger="scheduled", started_at="2026-07-29T22:00:00+00:00",
                           stats=STATS)
    assert target is not None
    assert stat.S_IMODE(os.stat(target).st_mode) == 0o600


def test_receipt_records_the_run(tmp_path):
    write_receipt(tmp_path, trigger="scheduled", started_at="2026-07-29T22:00:00+00:00",
                  stats=STATS, version="1.0.28")
    r = read_receipt(tmp_path)
    assert r["schema"] == RECEIPT_SCHEMA
    assert r["trigger"] == "scheduled"
    assert r["completed"] is True
    assert r["errorFree"] is False, "3 errors means not error-free"
    assert r["stats"]["errors"] == 3 and r["stats"]["metadataGenerated"] == 2
    assert r["stats"]["apiCost"] == pytest.approx(4.9665)
    assert r["finishedAt"] and r["startedAt"] == "2026-07-29T22:00:00+00:00"


def test_a_run_with_errors_still_counts_as_completed(tmp_path):
    """Distinct from error-free: the catch-up logic must not re-run a sync that FINISHED.

    The three context-window failures are a known bug; re-running the whole sync because of
    them would just spend money reproducing them.
    """
    write_receipt(tmp_path, trigger="scheduled", started_at="x", stats=STATS)
    r = read_receipt(tmp_path)
    assert r["completed"] is True and r["errorFree"] is False


def test_write_is_atomic_and_leaves_no_temp_files(tmp_path):
    for _ in range(3):
        write_receipt(tmp_path, trigger="manual", started_at="x", stats=STATS)
    leftovers = [p.name for p in tmp_path.iterdir() if p.name.startswith(".last-run-")]
    assert not leftovers, f"temp files left behind: {leftovers}"
    assert receipt_path(tmp_path).exists()


def test_write_tightens_a_preexisting_permissive_receipt(tmp_path):
    target = receipt_path(tmp_path)
    target.write_text("{}")
    os.chmod(target, 0o644)
    write_receipt(tmp_path, trigger="manual", started_at="x", stats=STATS)
    assert stat.S_IMODE(os.stat(target).st_mode) == 0o600


def test_write_never_raises_on_an_unwritable_location(tmp_path):
    """A sync that genuinely completed must not report failure over its receipt."""
    blocked = tmp_path / "ro"
    blocked.mkdir()
    os.chmod(blocked, 0o500)
    try:
        assert write_receipt(blocked, trigger="manual", started_at="x", stats=STATS) is None
    finally:
        os.chmod(blocked, 0o700)


def test_read_rejects_a_foreign_schema(tmp_path):
    receipt_path(tmp_path).write_text(json.dumps({"schema": 999, "completed": True}))
    assert read_receipt(tmp_path) is None


def test_read_rejects_corrupt_json(tmp_path):
    receipt_path(tmp_path).write_text("{not json")
    assert read_receipt(tmp_path) is None


def test_read_missing_receipt_is_none(tmp_path):
    assert read_receipt(tmp_path) is None
