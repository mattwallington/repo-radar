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


# ── production wiring: the sync orchestration must actually finalize ─────────────────────


def test_sync_module_calls_the_finalizer_and_declares_the_trigger():
    """Static landmark: unit tests on receipts.py say nothing about sync.py invoking it.

    Twelve isolated tests stayed green while nothing called write_receipt would be the same
    blind spot that let a synthesis fix ship as dead code.
    """
    import inspect
    from repo_radar.modes import sync

    src = inspect.getsource(sync)
    assert "_finalize_run(" in src, "sync must route completion through the finalizer"
    assert "write_receipt(" in src, "the finalizer must actually write a receipt"
    assert "resolve_trigger(" in src, "the trigger must be resolved, not inferred"
    assert "getattr(args, 'show_window'" not in src, (
        "the dead show_window heuristic must be gone — the CLI never defines that attribute")


def test_zero_repository_success_still_finalizes():
    """A successful no-op run must leave a receipt, or the schedule looks perpetually missed."""
    import inspect
    from repo_radar.modes import sync

    src = inspect.getsource(sync.sync_mode)
    idx = src.index("No repositories configured")
    tail = src[idx:idx + 600]
    assert "_finalize_run(" in tail, "the zero-repo return-0 path must finalize before returning"


def test_completion_path_writes_a_readable_receipt_end_to_end(tmp_path, monkeypatch):
    """Behavioural: drive the finalizer's inputs and observe a real receipt on disk."""
    monkeypatch.setenv(TRIGGER_ENV, "scheduled")
    monkeypatch.setenv("REPO_RADAR_CHANNEL", "stable")
    from repo_radar.receipts import resolve_channel, run_mode

    write_receipt(
        tmp_path,
        trigger=resolve_trigger(default="cli"),
        started_at="2026-07-29T22:00:00+00:00",
        stats=STATS,
        channel=resolve_channel(),
        mode=run_mode(skip_metadata=False),
        version="1.0.28",
    )
    r = read_receipt(tmp_path, "stable")
    assert r is not None, "the receipt must survive type validation"
    assert r["trigger"] == "scheduled" and r["channel"] == "stable"
    assert r["mode"] == "full" and r["qualifiesForSchedule"] is True
    assert r["version"] == "1.0.28", "version must come from the package, not an unset env var"


def test_partial_run_does_not_qualify_for_the_schedule():
    """A --skip-metadata run completed, but not the work the schedule exists to do."""
    from repo_radar.receipts import run_mode
    assert run_mode(skip_metadata=True) == "skip-metadata"
    assert run_mode(metadata_only=True) == "metadata-only"
    assert run_mode(repos_only=True) == "repos-only"
    assert run_mode() == "full"


def test_payload_construction_is_inside_the_never_raises_boundary(tmp_path):
    """A non-numeric stat previously raised straight through, failing a COMPLETED sync."""
    for bad in (None, "not-a-number", object()):
        stats = dict(STATS, api_cost=bad)
        result = write_receipt(tmp_path, trigger="scheduled", started_at="x", stats=stats)
        assert result is not None, f"api_cost={bad!r} must not defeat the receipt"
        assert read_receipt(tmp_path)["stats"]["apiCost"] == 0.0


def test_non_dict_stats_are_survivable(tmp_path):
    assert write_receipt(tmp_path, trigger="cli", started_at="x", stats=None) is not None
    assert read_receipt(tmp_path)["stats"]["errors"] == 0


def test_channel_scoped_receipts_do_not_collide(tmp_path):
    """A dev run must not be able to advance the stable watermark."""
    write_receipt(tmp_path, trigger="cli", started_at="x", stats=STATS, channel="dev")
    write_receipt(tmp_path, trigger="scheduled", started_at="x", stats=STATS, channel="stable")
    assert read_receipt(tmp_path, "dev")["trigger"] == "cli"
    assert read_receipt(tmp_path, "stable")["trigger"] == "scheduled"


def test_read_rejects_wrongly_typed_fields(tmp_path):
    import json as _json
    from repo_radar.receipts import receipt_path
    good = {"schema": 2, "channel": "stable", "trigger": "scheduled", "mode": "full",
            "completed": True, "qualifiesForSchedule": True,
            "finishedAt": "2026-07-29T22:00:00+00:00", "stats": {"errors": 0}}
    for label, over in (("numeric finishedAt", {"finishedAt": 123}),
                        ("string errors", {"stats": {"errors": "0"}}),
                        ("bad channel", {"channel": "beta"}),
                        ("bad trigger", {"trigger": "sideways"}),
                        ("non-bool qualification", {"qualifiesForSchedule": "yes"})):
        receipt_path(tmp_path, "stable").write_text(_json.dumps({**good, **over}))
        assert read_receipt(tmp_path, "stable") is None, f"must reject: {label}"
