"""Task 2.6: sync_mode threads the ActivityWriter, SyncLogger gets source-owned severity, and
every sync_mode exit path writes exactly one authoritative terminal (spec Sec 3).

Three tiers here:
  1. Pure-function tests for the two decision helpers (`_activity_level` / `_finalize_outcome`)
     -- the brief's own given tests, verbatim.
  2. Real end-to-end tests (subprocess, isolated $HOME) that prove the WIRING: a genuine
     `python -m repo_radar.cli sync` run leaves a real, durable terminal record on disk for the
     unknown-model guard and the config-abort leak fix specifically.
  3. In-process tests, using a lightweight spy in place of a real ActivityWriter (a legitimate
     forced-failure/test-seam per the task brief), that drive sync_mode's own outcome-computation
     tail through a controlled clone-success/clone-failure/degraded-metadata harness -- proving
     succeeded / succeeded-with-warnings / failed are wired to the RIGHT outcome, not just that
     the pure helper functions compute them correctly in isolation.
"""
import json
import os
import subprocess
import sys
import types

from repo_radar.modes import sync as S
from repo_radar.activity import paths


# ── 1. pure decision-helper tests (brief Step 1, verbatim) ────────────────────────────────


def test_severity_rule_mapping():
    assert S._activity_level("info-ish", is_degraded=False, is_exhausted=False) == "info"
    assert S._activity_level("x", is_degraded=True, is_exhausted=False) == "warn"
    assert S._activity_level("x", is_degraded=False, is_exhausted=True) == "error"


def test_outcome_mapping_is_the_seven():
    assert S._finalize_outcome(errors=0, warns=0, degraded=False) == "succeeded"
    assert S._finalize_outcome(errors=0, warns=1, degraded=True) == "succeeded-with-warnings"
    assert S._finalize_outcome(errors=2, warns=0, degraded=False) == "failed"


# ── 2. real end-to-end: a genuine CLI subprocess, isolated $HOME ──────────────────────────


def _read_terminal_outcomes(home):
    """Every `terminal` record's `outcome`, read back from disk for every activity under `home`
    (mirrors the brief's given test 3)."""
    base = paths.quota_dir(home).parent
    if not base.exists():
        return []
    outcomes = []
    for d in base.iterdir():
        if not d.is_dir() or d.name == "quota":
            continue
        for f in d.glob("*.jsonl"):
            for line in f.read_text().splitlines():
                if not line.strip():
                    continue
                rec = json.loads(line)
                if rec.get("type") == "terminal":
                    outcomes.append(rec["outcome"])
    return outcomes


SEVEN_OUTCOMES = {"succeeded", "succeeded-with-warnings", "blocked", "failed",
                  "cancelled", "skipped", "interrupted"}


def test_real_sync_path_writes_an_actual_terminal(tmp_path):
    """Finding 8 (brief): a real `sync` run (no config in an isolated HOME) must finalize with a
    durable terminal in the seven -- proving the config-abort leak is closed and the writer is
    threaded, not just that helpers return values."""
    env = {**os.environ, "HOME": str(tmp_path)}
    subprocess.run([sys.executable, "-m", "repo_radar.cli", "sync", "--dry-run"], env=env)
    outs = _read_terminal_outcomes(tmp_path)
    assert outs and set(outs) <= SEVEN_OUTCOMES


def test_config_abort_terminal_is_specifically_blocked(tmp_path):
    """Same real run as above, but pinned to the specific outcome this implementation chose for
    "no configuration found" (a pre-worker guard failure, the same bucket as unknown-model and
    cli.py's dependency-check failure -- see the task report for the reasoning/ambiguity note)."""
    env = {**os.environ, "HOME": str(tmp_path)}
    subprocess.run([sys.executable, "-m", "repo_radar.cli", "sync", "--dry-run"], env=env)
    outs = _read_terminal_outcomes(tmp_path)
    assert outs == ["blocked"]


def test_unknown_model_early_exit_writes_a_durable_blocked_terminal(tmp_path):
    """The unknown-model guard fires before the old per-run log is even opened -- the earliest
    possible exit. Prove it still lands a real, durable `blocked` incident through the writer
    cli.py established (Task 2.5), not just a printed error and a silent exit code."""
    env = {**os.environ, "HOME": str(tmp_path), "AI_MODEL": "not-a-real-model-xyz"}
    result = subprocess.run([sys.executable, "-m", "repo_radar.cli", "sync"],
                            env=env, capture_output=True, text=True)
    assert result.returncode not in (0, None)
    outs = _read_terminal_outcomes(tmp_path)
    assert outs == ["blocked"], f"stderr={result.stderr!r} stdout={result.stdout!r}"


def test_direct_call_without_an_established_writer_mints_its_own(tmp_path, monkeypatch):
    """`args._activity_writer` absent (the shape of a direct sync_mode() call that skipped
    cli.py's main(), e.g. most of this module's own test suite) must still fall back to minting
    a writer and recording a real terminal -- not silently record nothing."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(S, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(S, "load_config", lambda: {"repositories": []})
    monkeypatch.setattr(S, "_open_sync_logger", lambda: None)

    rc = S.sync_mode(_args())

    assert rc == 0
    assert _read_terminal_outcomes(tmp_path) == ["succeeded"]


# ── 3. in-process wiring tests via a spy writer (forced-failure hook) ─────────────────────


def _args(**over):
    """Mirrors the sync_mode argument fixture already used by test_receipts.py/test_sync_guard.py."""
    base = dict(command='sync', dry_run=False, force=False, metadata_only=False,
                repos_only=False, regenerate_metadata=False, skip_metadata=False,
                status_server=False, version=False)
    base.update(over)
    return types.SimpleNamespace(**base)


class _SpyWriter:
    """A minimal stand-in for ActivityWriter's public surface (start/event/control/terminal),
    used as a forced-failure/wiring-verification test seam -- not a copy of the real writer's
    durability/redaction machinery (that's Phase 1's own test suite), just a recorder proving
    sync_mode CALLS the right method with the right outcome at the right point."""

    def __init__(self):
        self.started = False
        self.events = []
        self.terminals = []

    def start(self):
        self.started = True

    def event(self, name, level, detail=None, **fields):
        self.events.append((name, level, detail, fields))

    def control(self, name, **fields):
        pass

    def terminal(self, outcome, **summary):
        self.terminals.append((outcome, summary))


def test_unknown_model_early_exit_calls_terminal_blocked_on_the_supplied_writer(monkeypatch):
    monkeypatch.setenv("AI_MODEL", "not-a-real-model-xyz")
    writer = _SpyWriter()
    args = _args()
    args._activity_writer = writer

    rc = S.sync_mode(args)

    assert rc == 1
    assert writer.started, "terminal() must still land a durable start (auto-started if needed)"
    assert writer.terminals == [("blocked", {"reason": "unknown_model", "model": "not-a-real-model-xyz"})]


def test_catchup_already_satisfied_calls_terminal_skipped(monkeypatch, tmp_path):
    from repo_radar.receipts import write_receipt, TRIGGER_ENV

    monkeypatch.setattr(S, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(S, "load_config", lambda: {"repositories": []})
    monkeypatch.setattr(S, "_open_sync_logger", lambda: None)
    monkeypatch.setattr(S, "wait_for_network", lambda **kw: True)

    write_receipt(tmp_path, trigger="scheduled", started_at="x",
                  stats={"errors": 0}, channel="stable", mode="full",
                  finished_at="2026-07-29T23:00:00+00:00")
    monkeypatch.setenv(TRIGGER_ENV, "catchup")
    monkeypatch.setenv("REPO_RADAR_CATCHUP_NOT_BEFORE", "2026-07-29T22:00:00+00:00")

    writer = _SpyWriter()
    args = _args()
    args._activity_writer = writer

    from repo_radar.receipts import EXIT_SKIPPED_NO_WORK
    rc = S.sync_mode(args)

    assert rc == EXIT_SKIPPED_NO_WORK
    assert writer.terminals == [("skipped", {"reason": "catchup_already_satisfied"})]


def test_network_abort_calls_terminal_failed(monkeypatch, tmp_path):
    monkeypatch.setattr(S, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(S, "load_config", lambda: {"repositories": []})
    monkeypatch.setattr(S, "_open_sync_logger", lambda: None)
    monkeypatch.setattr(S, "wait_for_network", lambda **kw: False)

    writer = _SpyWriter()
    args = _args()
    args._activity_writer = writer

    rc = S.sync_mode(args)

    assert rc == 1
    assert writer.terminals == [("failed", {"reason": "no_network_connectivity"})]


def test_no_configuration_calls_terminal_blocked(monkeypatch, tmp_path):
    monkeypatch.setattr(S, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(S, "load_config", lambda: None)
    monkeypatch.setattr(S, "_open_sync_logger", lambda: None)
    monkeypatch.setattr(S, "wait_for_network", lambda **kw: True)

    writer = _SpyWriter()
    args = _args()
    args._activity_writer = writer

    rc = S.sync_mode(args)

    assert rc == 1
    assert writer.terminals == [("blocked", {"reason": "no_configuration"})]


def test_zero_repositories_calls_terminal_succeeded(monkeypatch, tmp_path):
    monkeypatch.setattr(S, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(S, "load_config", lambda: {"repositories": []})
    monkeypatch.setattr(S, "_open_sync_logger", lambda: None)
    monkeypatch.setattr(S, "wait_for_network", lambda **kw: True)

    writer = _SpyWriter()
    args = _args()
    args._activity_writer = writer

    rc = S.sync_mode(args)

    assert rc == 0
    assert writer.terminals == [("succeeded", {"reason": "no_repositories_configured"})]


# ── a controlled one-repo harness for the tail-of-run outcome computation ─────────────────
#
# Everything below drives sync_mode all the way to its FINAL return statement (past the git
# ThreadPoolExecutor phase) with exactly one repo, to prove the _finalize_outcome/_activity_terminal
# wiring at the tail -- distinct from the zero-repo shortcut above, which is its own separate exit
# path. git and the LLM/metadata pipeline are both faked (forced-failure-hook style, per the task
# brief) rather than driven for real: the git layer via `run_git_command`/`determine_preferred_branch`
# (bare-name imports sync.py itself calls, so monkeypatching the sync module's copy intercepts them
# regardless of what the real git.py functions do internally), and the metadata layer by replacing
# `generate_repo_metadata` wholesale (also a bare-name call site within sync_mode).

class _FakeGitResult:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def _one_repo_config():
    return {"repositories": [{"full_name": "acme/widgets",
                              "clone_url": "https://example.invalid/acme/widgets.git"}]}


def _setup_one_repo_harness(monkeypatch, tmp_path, *, clone_ok=True, skip_metadata=True,
                            generate_repo_metadata=None):
    monkeypatch.setattr(S, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(S, "PRISTINE_DIR", tmp_path / "pristine")
    monkeypatch.setattr(S, "load_config", lambda: _one_repo_config())
    monkeypatch.setattr(S, "load_cache_index", lambda: {})
    monkeypatch.setattr(S, "save_cache_index", lambda idx: None)
    monkeypatch.setattr(S, "wait_for_network", lambda **kw: True)
    monkeypatch.setattr(S, "_open_sync_logger", lambda: None)
    monkeypatch.setattr(S, "is_known_model", lambda m: True)
    monkeypatch.setattr(S, "regenerate_index", lambda args: None)
    monkeypatch.setattr(S, "determine_preferred_branch", lambda repo_path, default: None)

    def _fake_run_git(cmd, cwd=None, check=False):
        if not clone_ok and cmd[:2] == ["git", "clone"]:
            return _FakeGitResult(returncode=1, stderr="fatal: could not resolve host")
        if "rev-parse" in cmd:
            return _FakeGitResult(returncode=0, stdout="deadbeef1234567890abcdef")
        return _FakeGitResult(returncode=0)

    monkeypatch.setattr(S, "run_git_command", _fake_run_git)

    if generate_repo_metadata is not None:
        monkeypatch.setattr(S, "generate_repo_metadata", generate_repo_metadata)


def test_a_clean_one_repo_run_maps_to_succeeded(monkeypatch, tmp_path):
    _setup_one_repo_harness(monkeypatch, tmp_path, clone_ok=True, skip_metadata=True)
    writer = _SpyWriter()
    args = _args(skip_metadata=True)
    args._activity_writer = writer

    rc = S.sync_mode(args)

    assert rc == 0
    assert writer.terminals, "the tail must write exactly one authoritative terminal"
    outcome, summary = writer.terminals[-1]
    assert outcome == "succeeded"
    assert summary["errors"] == 0


def test_a_forced_worker_failure_maps_to_failed(monkeypatch, tmp_path):
    _setup_one_repo_harness(monkeypatch, tmp_path, clone_ok=False, skip_metadata=True)
    writer = _SpyWriter()
    args = _args(skip_metadata=True)
    args._activity_writer = writer

    rc = S.sync_mode(args)

    assert rc == 1
    assert writer.terminals, "the tail must write exactly one authoritative terminal"
    outcome, summary = writer.terminals[-1]
    assert outcome == "failed"
    assert summary["errors"] == 1


def test_a_degraded_repo_maps_to_succeeded_with_warnings(monkeypatch, tmp_path):
    """generate_repo_metadata is replaced wholesale (not driven for real -- see the harness
    docstring above) with a fake that does exactly what `_finish_degraded` does to `stats`:
    bump `degraded` (and `metadata_generated`, matching the real code's existing behavior of
    counting a degraded output as "generated"). This isolates the TAIL wiring under test
    (does a degraded run really finalize succeeded-with-warnings?) from the real chunking/LLM
    machinery, which is out of scope for Task 2.6 and already has its own test coverage."""
    def _fake_degraded(task_data, session, args, ctx):
        with ctx.stats_lock:
            ctx.stats['metadata_generated'] += 1
            ctx.stats['degraded'] = ctx.stats.get('degraded', 0) + 1
        return 0.0

    _setup_one_repo_harness(monkeypatch, tmp_path, clone_ok=True, skip_metadata=False,
                            generate_repo_metadata=_fake_degraded)
    writer = _SpyWriter()
    args = _args(skip_metadata=False)
    args._activity_writer = writer

    rc = S.sync_mode(args)

    assert rc == 0, "a degraded-but-completed run is still a zero-error, exit-0 run"
    assert writer.terminals, "the tail must write exactly one authoritative terminal"
    outcome, summary = writer.terminals[-1]
    assert outcome == "succeeded-with-warnings"
    assert summary["errors"] == 0
    assert summary["warnings"] >= 1
