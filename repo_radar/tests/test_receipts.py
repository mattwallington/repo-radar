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


# ── executable orchestration: run sync_mode itself, not the helper it calls ───────────────


def _args(**over):
    import types
    base = dict(command='sync', dry_run=False, force=False, metadata_only=False,
                repos_only=False, regenerate_metadata=False, skip_metadata=False,
                status_server=False, version=False)
    base.update(over)
    return types.SimpleNamespace(**base)


def test_zero_repo_sync_mode_execution_writes_a_receipt(tmp_path, monkeypatch):
    """Actually EXECUTE sync_mode. The previous 'end-to-end' test called write_receipt directly,
    so the production call site stayed covered only by source-text landmarks — the same blind spot
    that let a synthesis fix ship as dead code."""
    from repo_radar.modes import sync as sync_mod
    import repo_radar.receipts as receipts_mod

    monkeypatch.setattr(sync_mod, 'CONFIG_DIR', tmp_path)
    monkeypatch.setattr(sync_mod, 'load_config',
                        lambda: {'repositories': [], 'ai_model': 'claude-opus-5'})
    monkeypatch.setattr(sync_mod, 'wait_for_network', lambda **kw: True)
    monkeypatch.setattr(sync_mod, '_open_sync_logger', lambda: None)
    monkeypatch.setenv(receipts_mod.TRIGGER_ENV, 'scheduled')
    monkeypatch.setenv(receipts_mod.CHANNEL_ENV, 'stable')

    rc = sync_mod.sync_mode(_args())
    assert rc == 0, "a zero-repository run is a success"

    r = read_receipt(tmp_path, 'stable')
    assert r is not None, "executing sync_mode must leave a receipt on disk"
    assert r['trigger'] == 'scheduled' and r['channel'] == 'stable'
    assert r['completed'] is True and r['qualifiesForSchedule'] is True
    assert r['stats']['total'] == 0


def test_dry_run_execution_writes_no_receipt(tmp_path, monkeypatch):
    from repo_radar.modes import sync as sync_mod
    monkeypatch.setattr(sync_mod, 'CONFIG_DIR', tmp_path)
    monkeypatch.setattr(sync_mod, 'load_config', lambda: {'repositories': []})
    monkeypatch.setattr(sync_mod, 'wait_for_network', lambda **kw: True)
    monkeypatch.setattr(sync_mod, '_open_sync_logger', lambda: None)
    sync_mod.sync_mode(_args(dry_run=True))
    assert read_receipt(tmp_path, 'stable') is None, "a dry run must not claim a completed sync"


def test_catchup_execution_skips_when_already_satisfied(tmp_path, monkeypatch):
    """The lock-held guard: by the time sync_mode runs, the dispatcher holds the root lock, so
    this is the first race-free moment to notice a scheduled worker already did the work."""
    from repo_radar.modes import sync as sync_mod
    import repo_radar.receipts as receipts_mod

    monkeypatch.setattr(sync_mod, 'CONFIG_DIR', tmp_path)
    monkeypatch.setattr(sync_mod, 'load_config', lambda: {'repositories': []})
    monkeypatch.setattr(sync_mod, 'wait_for_network', lambda **kw: True)
    monkeypatch.setattr(sync_mod, '_open_sync_logger', lambda: None)

    # a qualifying run landed AFTER the catch-up decision was taken
    write_receipt(tmp_path, trigger='scheduled', started_at='x', stats=STATS,
                  channel='stable', mode='full', finished_at='2026-07-29T23:00:00+00:00')
    monkeypatch.setenv(receipts_mod.TRIGGER_ENV, 'catchup')
    monkeypatch.setenv('REPO_RADAR_CATCHUP_NOT_BEFORE', '2026-07-29T22:00:00+00:00')

    called = {'network': False}
    monkeypatch.setattr(sync_mod, 'wait_for_network',
                        lambda **kw: called.__setitem__('network', True) or True)
    rc = sync_mod.sync_mode(_args())
    from repo_radar.receipts import EXIT_SKIPPED_NO_WORK
    assert rc == EXIT_SKIPPED_NO_WORK, (
        "a declined catch-up must be distinguishable from a completed sync, or the caller stamps "
        "a completion timestamp for work that never happened")
    assert called['network'] is False, "must bail BEFORE doing any work"
    # the pre-existing receipt is untouched, not overwritten by the skipped run
    assert read_receipt(tmp_path, 'stable')['finishedAt'] == '2026-07-29T23:00:00+00:00'


def test_catchup_execution_proceeds_when_not_satisfied(tmp_path, monkeypatch):
    from repo_radar.modes import sync as sync_mod
    import repo_radar.receipts as receipts_mod

    monkeypatch.setattr(sync_mod, 'CONFIG_DIR', tmp_path)
    monkeypatch.setattr(sync_mod, 'load_config', lambda: {'repositories': []})
    monkeypatch.setattr(sync_mod, '_open_sync_logger', lambda: None)
    monkeypatch.setattr(sync_mod, 'wait_for_network', lambda **kw: True)
    # the only receipt predates the decision watermark, so it cannot satisfy this catch-up
    write_receipt(tmp_path, trigger='scheduled', started_at='x', stats=STATS,
                  channel='stable', mode='full', finished_at='2026-07-29T21:00:00+00:00')
    monkeypatch.setenv(receipts_mod.TRIGGER_ENV, 'catchup')
    monkeypatch.setenv('REPO_RADAR_CATCHUP_NOT_BEFORE', '2026-07-29T22:00:00+00:00')
    assert sync_mod.sync_mode(_args()) == 0
    assert read_receipt(tmp_path, 'stable')['trigger'] == 'catchup', "the catch-up ran"


# ── one qualification rule, shared by the writer and the lock-held guard ──────────────────


def test_qualification_rule_is_channel_aware():
    """A full DEV run previously persisted qualifiesForSchedule=true because the write-time rule
    ignored the channel, and the lock-held guard then trusted that value in production."""
    from repo_radar.receipts import qualifies_for_schedule
    assert qualifies_for_schedule("stable", "full") is True
    assert qualifies_for_schedule("dev", "full") is False, "dev owns no schedule"
    assert qualifies_for_schedule("stable", "skip-metadata") is False
    assert qualifies_for_schedule("stable", "metadata-only") is False
    assert qualifies_for_schedule("stable", "repos-only") is False
    assert qualifies_for_schedule(None, "full") is False


def test_written_receipt_matches_the_rule_for_every_combination(tmp_path):
    from repo_radar.receipts import qualifies_for_schedule
    for channel in ("stable", "dev"):
        for mode in ("full", "skip-metadata", "metadata-only", "repos-only"):
            write_receipt(tmp_path, trigger="manual", started_at="x", stats={"errors": 0},
                          channel=channel, mode=mode)
            r = read_receipt(tmp_path, channel)
            assert r["qualifiesForSchedule"] is qualifies_for_schedule(channel, mode), (
                f"{channel}/{mode} persisted a qualification that contradicts the rule")


def test_read_rejects_an_invalid_mode(tmp_path):
    import json as _json
    from repo_radar.receipts import receipt_path
    receipt_path(tmp_path, "stable").write_text(_json.dumps({
        "schema": 2, "channel": "stable", "trigger": "scheduled", "mode": "sideways",
        "completed": True, "qualifiesForSchedule": True,
        "finishedAt": "2026-07-29T22:00:00+00:00", "stats": {"errors": 0}}))
    assert read_receipt(tmp_path, "stable") is None


def test_guard_ignores_a_stale_qualification_flag(tmp_path, monkeypatch):
    """A receipt written by an older build could claim qualification under a different rule; the
    guard must re-derive rather than trust it."""
    import json as _json
    from repo_radar.modes import sync as sync_mod
    import repo_radar.receipts as receipts_mod
    from repo_radar.receipts import receipt_path

    # hand-craft a DEV receipt that lies about qualifying
    receipt_path(tmp_path, "dev").write_text(_json.dumps({
        "schema": 2, "channel": "dev", "trigger": "scheduled", "mode": "full",
        "completed": True, "qualifiesForSchedule": True,
        "finishedAt": "2026-07-29T23:00:00+00:00", "stats": {"errors": 0}}))
    monkeypatch.setattr(sync_mod, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(sync_mod, "load_config", lambda: {"repositories": []})
    monkeypatch.setattr(sync_mod, "_open_sync_logger", lambda: None)
    monkeypatch.setattr(sync_mod, "wait_for_network", lambda **kw: True)
    monkeypatch.setenv(receipts_mod.TRIGGER_ENV, "catchup")
    monkeypatch.setenv(receipts_mod.CHANNEL_ENV, "dev")
    monkeypatch.setenv("REPO_RADAR_CATCHUP_NOT_BEFORE", "2026-07-29T22:00:00+00:00")

    rc = sync_mod.sync_mode(_args())
    assert rc == 0, "a dev receipt cannot satisfy a catch-up, so the run must proceed"


def test_guard_rejects_a_corrupt_timestamp_instead_of_declining_work(tmp_path, monkeypatch):
    """A receipt with finishedAt="zzzz" once suppressed every catch-up: the string check passed and
    "zzzz" sorts above any ISO date, so the lexical comparison declined the run indefinitely."""
    import json as _json
    from repo_radar.modes import sync as sync_mod
    import repo_radar.receipts as receipts_mod
    from repo_radar.receipts import receipt_path

    receipt_path(tmp_path, 'stable').write_text(_json.dumps({
        'schema': 2, 'channel': 'stable', 'trigger': 'scheduled', 'mode': 'full',
        'completed': True, 'qualifiesForSchedule': True, 'finishedAt': 'zzzz',
        'stats': {'errors': 0}}))
    monkeypatch.setattr(sync_mod, 'CONFIG_DIR', tmp_path)
    monkeypatch.setattr(sync_mod, 'load_config', lambda: {'repositories': []})
    monkeypatch.setattr(sync_mod, '_open_sync_logger', lambda: None)
    monkeypatch.setattr(sync_mod, 'wait_for_network', lambda **kw: True)
    monkeypatch.setenv(receipts_mod.TRIGGER_ENV, 'catchup')
    monkeypatch.setenv('REPO_RADAR_CATCHUP_NOT_BEFORE', '2026-07-29T22:00:00+00:00')

    assert sync_mod.sync_mode(_args()) == 0, "corrupt evidence must not decline the work"


def test_parse_instant_rejects_junk_and_normalises_zulu():
    from repo_radar.receipts import parse_instant
    assert parse_instant('zzzz') is None
    assert parse_instant('') is None
    assert parse_instant(None) is None
    assert parse_instant(12345) is None
    naive = parse_instant('2026-07-29T22:00:00')
    assert naive is not None and naive.tzinfo is not None, "naive input must be made aware"
    assert parse_instant('2026-07-29T22:00:00Z') == parse_instant('2026-07-29T22:00:00+00:00')


def test_read_rejects_future_and_unparseable_timestamps(tmp_path):
    import json as _json
    from repo_radar.receipts import receipt_path
    base = {'schema': 2, 'channel': 'stable', 'trigger': 'scheduled', 'mode': 'full',
            'completed': True, 'qualifiesForSchedule': True, 'stats': {'errors': 0}}
    for label, ts in (('junk', 'zzzz'), ('future', '2099-01-01T00:00:00+00:00'), ('empty', '')):
        receipt_path(tmp_path, 'stable').write_text(_json.dumps({**base, 'finishedAt': ts}))
        assert read_receipt(tmp_path, 'stable') is None, f"must reject {label}"
    receipt_path(tmp_path, 'stable').write_text(
        _json.dumps({**base, 'finishedAt': '2026-07-29T22:00:00+00:00'}))
    assert read_receipt(tmp_path, 'stable') is not None, "a valid past timestamp is accepted"


def test_completion_payload_carries_qualification_provenance():
    """The status server had no channel/mode to judge with, so it advanced lastSync for everything."""
    import inspect
    from repo_radar.modes import sync as sync_mod
    src = inspect.getsource(sync_mod.sync_mode)
    idx = src.index("send_status_update('complete'")
    head = src[max(0, idx - 700):idx]
    for field in ("completion_data['channel']", "completion_data['mode']",
                  "completion_data['trigger']", "completion_data['qualifiesForSchedule']"):
        assert field in head, f"the complete payload must carry {field}"
