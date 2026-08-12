"""Fail-closed guard: reject an uncatalogued model before sync_mode's network wait (§7, Task 4).

A metadata-capable run (not skip_metadata, not repos_only) will eventually call the LLM, so an
unknown model must be caught at the top of sync_mode -- before the 5-minute network wait and
before any git work touches a repo -- instead of surfacing as an opaque API error mid-run.

dry_run is intentionally NOT exempted: a dry run with a misconfigured model should still fail
loudly, surfacing the misconfiguration early, rather than silently succeeding just because a dry
run never actually talks to the LLM.
"""
import types

from repo_radar.modes import sync as sync_mod

UNKNOWN_MODEL = "not-a-real-model-xyz"


def _args(**over):
    """Mirrors the sync_mode argument fixture in test_receipts.py."""
    base = dict(command='sync', dry_run=False, force=False, metadata_only=False,
                repos_only=False, regenerate_metadata=False, skip_metadata=False,
                status_server=False, version=False)
    base.update(over)
    return types.SimpleNamespace(**base)


def _quiet(monkeypatch, tmp_path):
    """Keep sync_mode from touching the real filesystem/log dir on paths that reach past the
    guard (used by the skip_metadata case, which must proceed)."""
    monkeypatch.setattr(sync_mod, 'CONFIG_DIR', tmp_path)
    monkeypatch.setattr(sync_mod, 'load_config', lambda: {'repositories': []})
    monkeypatch.setattr(sync_mod, '_open_sync_logger', lambda: None)


def test_unknown_model_is_rejected_before_the_network_wait(monkeypatch, tmp_path):
    _quiet(monkeypatch, tmp_path)
    monkeypatch.setenv('AI_MODEL', UNKNOWN_MODEL)
    calls = {'network': 0}
    monkeypatch.setattr(
        sync_mod, 'wait_for_network',
        lambda **kw: calls.__setitem__('network', calls['network'] + 1) or True)

    rc = sync_mod.sync_mode(_args())

    assert calls['network'] == 0, (
        "an uncatalogued model must be rejected before wait_for_network is ever called -- "
        "proving both the network wait and the later git phase were skipped")
    assert rc not in (0, None), "an uncatalogued model must fail the run (non-zero exit)"


def test_skip_metadata_lets_an_unknown_model_proceed_past_the_guard(monkeypatch, tmp_path):
    _quiet(monkeypatch, tmp_path)
    monkeypatch.setenv('AI_MODEL', UNKNOWN_MODEL)
    calls = {'network': 0}

    def _fake_wait(**kw):
        calls['network'] += 1
        return False  # short-circuit: "no network" aborts the run quickly past this point

    monkeypatch.setattr(sync_mod, 'wait_for_network', _fake_wait)

    sync_mod.sync_mode(_args(skip_metadata=True))

    assert calls['network'] == 1, (
        "skip_metadata is not metadata-capable, so the guard must not fire and the run must "
        "reach wait_for_network")


def test_dry_run_with_an_unknown_model_is_still_rejected(monkeypatch, tmp_path):
    _quiet(monkeypatch, tmp_path)
    monkeypatch.setenv('AI_MODEL', UNKNOWN_MODEL)
    calls = {'network': 0}
    monkeypatch.setattr(
        sync_mod, 'wait_for_network',
        lambda **kw: calls.__setitem__('network', calls['network'] + 1) or True)

    rc = sync_mod.sync_mode(_args(dry_run=True))

    assert calls['network'] == 0, "dry_run must still be validated -- not exempted from the guard"
    assert rc not in (0, None), "dry_run with an uncatalogued model must still fail the run"
