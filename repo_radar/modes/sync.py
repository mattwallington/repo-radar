"""Sync mode: clone/update repos and generate AI-powered metadata."""

import os
import sys
import time
import signal
import uuid
import traceback
import hashlib
from pathlib import Path
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading
from collections import namedtuple

from repo_radar.config import load_config, save_config, load_cache_index, save_cache_index, get_cache_name, PRISTINE_DIR, CONFIG_DIR, CACHE_INDEX_FILE
from repo_radar.config import (DEFAULT_INCREMENTAL_FULL_REBUILD_DAYS, incremental_full_rebuild_days,
                               incremental_metadata_repos, incremental_spending_policy,
                               weekly_spending_policy)
from repo_radar import incremental_metadata
from repo_radar import VERSION as REPO_RADAR_VERSION
from repo_radar.receipts import (EXIT_SKIPPED_NO_WORK, parse_instant, qualifies_for_schedule,
                                 read_receipt, resolve_channel, resolve_trigger,
                                 run_mode, write_receipt)
from repo_radar.constants import GREEN, BLUE, CYAN, YELLOW, RED, BOLD, RESET, REPO_COLORS, PROGRESS_COLORS
from repo_radar.git import run_git_command, determine_preferred_branch, get_repo_status
from repo_radar.llm import get_ai_model, provider_for_model
from repo_radar.preflight import PreflightSession
from repo_radar.spending import Spending, SpendingError, policy_from_config, stop_on_sigterm
from repo_radar.model_catalog import is_known_model
from repo_radar.metadata import read_attempt_state, regenerate_index
from repo_radar.ui import get_short_id, format_id, send_status_update, set_status_attempt
# Imported by name so callers and tests keep using sync.wait_for_network.
from repo_radar.network import NetworkWaitCancelled, wait_for_network


# Keep the most recent N per-run log files; older ones are pruned on each sync.
SYNC_LOG_RETENTION = 10


def _activity_level(name, *, is_degraded=False, is_exhausted=False):
    """Source-owned event severity (spec Sec 3): the level is assigned BY RULE, based on what
    the CALLER observed actually happened -- never inferred from the event's name/category.
    Ordinary retry/wait/recovery (including transient rate-limit + network waiting) is `info`
    (the default -- no flags set); a completed-but-degraded outcome (a repo's metadata fell back
    to a degraded record, a receipt failed to persist, etc.) is `warn`; an exhausted retry, a
    timeout, or an abort is `error`. `name` is accepted (and asserted on by tests) purely so a
    call site reads naturally -- it never affects the decision. Severity never decides outcome
    (`_finalize_outcome` below is the only place an outcome is decided).
    """
    if is_exhausted:
        return "error"
    if is_degraded:
        return "warn"
    return "info"


def _finalize_outcome(errors, warns, degraded):
    """Map a completed run's finalization STATE to one of the seven activity terminal outcomes
    (spec Sec 3) -- never derived from "did stderr get written" or similar. `errors` is the
    authoritative failure count (any error present makes the whole attempt `failed`, matching
    sync_mode's own long-standing `0 if stats['errors'] == 0 else 1` exit-code rule). Absent
    errors, `warns` (a count) or `degraded` (a flag) -- either one -- means a defined adverse
    completion (degraded output, or a repo skipped) happened during an otherwise-successful run,
    which maps to `succeeded-with-warnings`. Otherwise the run was clean: `succeeded`.
    """
    if errors:
        return "failed"
    if warns or degraded:
        return "succeeded-with-warnings"
    return "succeeded"


class SyncLogger:
    """Terse, line-oriented log for an individual sync run.

    One line per meaningful event so the file is cheap for an LLM to review.
    No progress-bar output, no ANSI codes, no duplicated per-repo chatter.
    Thread-safe — callable from the git and metadata worker pools.

    Also (Task 2.6) a best-effort structured sink: once bound to an ActivityWriter via
    `set_activity_writer`, every `event()`/`error()` ALSO emits the structured `event` record
    (with a source-owned `level` -- see `_activity_level`) through it, under the attempt's
    identity. The writer is itself a never-raises facade; `_emit_activity` wraps it again anyway
    so a structured-emit failure can never break this log's own line or the sync.
    """

    def __init__(self, log_file):
        self.log_file = log_file
        self._lock = threading.Lock()
        self._fh = open(log_file, 'w', buffering=1)  # line-buffered
        # Bound in AFTER construction by sync_mode (see set_activity_writer) -- None (the
        # default) means "no activity writer available", identical to pre-Task-2.6 behavior:
        # only the human-readable line below gets written.
        self._writer = None

    def _ts(self):
        return datetime.now().strftime("%H:%M:%S")

    def set_activity_writer(self, writer):
        """Bind the ActivityWriter this run established/minted. Kept as a call separate from
        the constructor so `_open_sync_logger()`'s own signature -- and every existing test that
        replaces it wholesale with a zero-arg stub -- stays untouched."""
        self._writer = writer

    def _emit_activity(self, level, name, detail=None, fields=None):
        """Best-effort structured emit. Never lets a writer-side failure break the human-readable
        line (already written by the time this runs) or the sync itself."""
        if self._writer is None:
            return
        try:
            self._writer.event(name, level, detail=detail, **(fields or {}))
        except Exception:
            pass

    def event(self, name, level="info", detail=None, **fields):
        """Log a single-line event: [HH:MM:SS] event_name k=v k=v

        `level` is source-owned (assigned BY THE CALLER per the severity rule -- see
        `_activity_level`), defaults to "info", and is forwarded to the activity writer's
        structured `event` record alongside this human-readable line. No existing caller passed
        `level`/`detail` before this, so every existing line is byte-identical to before.
        """
        parts = [f"[{self._ts()}]", name]
        for k, v in fields.items():
            if v is None or v == "":
                continue
            parts.append(f"{k}={v}")
        line = " ".join(parts) + "\n"
        with self._lock:
            if self._fh:
                self._fh.write(line)
        self._emit_activity(level, name, detail=detail, fields=fields)

    def error(self, name, repo=None, detail=None, level="error", **fields):
        """Log an error event with an indented detail block (e.g. git stderr).

        `level` defaults to "error" (exhausted retry/timeout/abort). The git-stderr `detail` is
        routed to the activity writer's own `detail=` (bounded/redacted separately, a larger
        budget) rather than stuffed into `fields` (small, strictly-bounded, primitives-only).
        """
        parts = [f"[{self._ts()}]", name]
        if repo:
            parts.append(f"repo={repo}")
        for k, v in fields.items():
            if v is None or v == "":
                continue
            parts.append(f"{k}={v}")
        lines = [" ".join(parts)]
        if detail:
            # Trim to the first few non-empty lines to avoid dumping huge tracebacks
            trimmed = [ln.rstrip() for ln in str(detail).splitlines() if ln.strip()]
            for ln in trimmed[:8]:
                lines.append(f"    {ln}")
            if len(trimmed) > 8:
                lines.append(f"    ... ({len(trimmed) - 8} more lines)")
        text = "\n".join(lines) + "\n"
        with self._lock:
            if self._fh:
                self._fh.write(text)
        error_fields = dict(fields)
        if repo:
            error_fields.setdefault('repo', repo)
        self._emit_activity(level, name, detail=detail, fields=error_fields)

    def close(self):
        with self._lock:
            if self._fh:
                try:
                    self._fh.close()
                finally:
                    self._fh = None


def _rotate_sync_logs(log_dir, retention=SYNC_LOG_RETENTION):
    """Keep only the most recent `retention` sync-*.log files in log_dir."""
    try:
        existing = sorted(
            log_dir.glob("sync-*.log"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        # Keep (retention - 1) existing files; the new run will become the Nth.
        for old in existing[max(retention - 1, 0):]:
            try:
                old.unlink()
            except OSError:
                pass
    except OSError:
        pass


def _open_sync_logger():
    """Create a new per-run log file and return a SyncLogger for it."""
    log_dir = Path.home() / "Library" / "Logs" / "repo-radar"
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        return None
    _rotate_sync_logs(log_dir)
    timestamp = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
    log_file = log_dir / f"sync-{timestamp}.log"
    try:
        return SyncLogger(log_file)
    except OSError:
        return None


def _mint_activity_writer():
    """Best-effort fallback: mint a fresh ActivityWriter when the caller didn't already
    establish one via `args._activity_writer` (cli.py's adopt-or-mint dance, Task 2.5). This is
    ONLY a mint, never an adopt -- if a dispatcher/Electron parent had already claimed the
    lease, cli.py would have adopted it and stashed the result on `args` before ever calling
    `sync_mode`; a caller reaching here (a direct `sync_mode(args)` invocation that skipped
    cli.py's main() -- most of this module's own test suite, and any future direct caller) owns
    nothing to adopt.

    Never raises: `ActivityWriter` is itself a never-raises facade (any construction failure
    yields an inactive, all-no-op writer), and the surrounding glue here is wrapped too, so a
    completely unexpected failure degrades to "no writer" -- observability must never touch the
    real sync. Returns None on any failure, exactly like an unavailable writer.
    """
    try:
        from repo_radar.activity import ActivityWriter
        from repo_radar.cli import _secret_values
        home = os.environ.get('HOME')
        return ActivityWriter(home, kind='sync', channel=resolve_channel(),
                              trigger=resolve_trigger(default='cli'), producer='python',
                              configured_secrets=_secret_values(load_config()))
    except Exception:
        return None


def _progress_attempt_id():
    """The ID the app chose for this run's status updates, if the app launched it.

    Display correlation only: it never stands in for the Activity hand-off (REPO_RADAR_ACTIVITY_*),
    whose ID, token and lease descriptor are validated as a set.
    """
    from repo_radar.activity import ids
    value = (os.environ.get('REPO_RADAR_PROGRESS_ATTEMPT_ID') or '').strip()
    return value if ids.valid_activity_id(value) else None


def _activity_start(writer):
    """Best-effort `.start()`. Idempotent and safe to call unconditionally (a no-op on an
    already-started or inactive writer) -- guarded anyway so a writer-side surprise can never
    reach the real sync (ActivityWriter itself never raises; this is cheap extra insurance)."""
    if writer is None:
        return
    try:
        writer.start()
    except Exception:
        pass


def _activity_terminal(writer, outcome, **summary):
    """Best-effort authoritative terminal write -- ONE of the seven outcomes (spec Sec 3) per
    sync_mode exit path. Never raises: a history-write failure must never change sync's exit
    code, alter its behavior, or drop a repo (ActivityWriter.terminal() is itself never-raises;
    this wraps it anyway, matching `_activity_start`)."""
    if writer is None:
        return
    try:
        writer.terminal(outcome, **summary)
    except Exception:
        pass


SyncContext = namedtuple("SyncContext", "meta_progress meta_tasks stats stats_lock sync_logger console")


def _incremental_status(args, full_name, short_id, status, percent, color):
    if hasattr(args, 'status_server') and args.status_server:
        send_status_update('progress', {'repo': full_name, 'short_name': short_id, 'status': status,
                                        'percent': percent, 'color': color}, args.status_server)


def _dry_run_decision(repo_path, cache_name, full_name, args):
    """What a repository's metadata would get, from its current checkout: read-only Git, no token counts,
    model calls or state writes. A repository not opted in to incremental updates is full-only."""
    try:
        target = incremental_metadata.snap.resolve_commit(repo_path, 'HEAD')
        if target is None:
            return 'full rebuild (no commit yet)'
        doc = incremental_metadata.load_document(PRISTINE_DIR, cache_name)
        state = read_attempt_state(PRISTINE_DIR, cache_name)
        force = bool(getattr(args, 'regenerate_metadata', False))
        decision = incremental_metadata.decide(
            repo_path, full_name, doc, state, get_ai_model(), target, datetime.now(), force=force,
            full_rebuild_days=getattr(args, '_incremental_full_rebuild_days', DEFAULT_INCREMENTAL_FULL_REBUILD_DAYS),
            allow_incremental=full_name in getattr(args, '_incremental_repos', ()))
        held = incremental_metadata.held_reason(state, doc, force, resolve_trigger(default='cli'),
                                                _incremental_policy(args)[1])
        if held and decision.strategy != 'none':
            return f"no update ({held})"
        return {'none': 'no update needed', 'incremental': 'incremental update',
                'full': 'full rebuild'}[decision.strategy] + f" ({decision.reason})"
    except Exception as e:
        return f"undetermined ({type(e).__name__})"


def _incremental_policy(args):
    """(update limit USD, failure stop) this sync loaded from Settings; the defaults when it loaded none."""
    policy = getattr(args, '_incremental_policy', None)
    return policy if isinstance(policy, tuple) and len(policy) == 2 else incremental_spending_policy(None)[:2]


def generate_repo_metadata(task_data, session, args, ctx):
    """Metadata for one repository, through the one shared worker (incremental_metadata.update_repository).

    The worker decides between nothing, a full rebuild and, only for a repository opted in to incremental
    updates (config incremental_metadata_repos), an update from the document's analyzed commit; any other
    repository is full-only. It never replaces a good document with a failed attempt. This reports the outcome
    truthfully: an update that failed or was skipped is never shown as success.
    """
    repo_config, cache_name, _commit_hash, short_id, color, _ = task_data
    full_name = repo_config['full_name']
    task_id, task_color = ctx.meta_tasks[full_name]
    model = get_ai_model()
    env_key = {'gemini': 'GEMINI_API_KEY', 'anthropic': 'ANTHROPIC_API_KEY',
               'openai': 'OPENAI_API_KEY'}.get(provider_for_model(model))
    ctx.meta_progress.update(task_id, completed=10, status=f"[{task_color}]checking for changes...[/{task_color}]")
    _incremental_status(args, full_name, short_id, '🔎 checking metadata...', 10, color)

    def stage(message, percent=20):
        ctx.meta_progress.update(task_id, completed=percent, status=f"[{task_color}]{message}[/{task_color}]")
        _incremental_status(args, full_name, short_id, f'🔎 {message}', percent, color)

    try:
        outcome = incremental_metadata.update_repository(
            PRISTINE_DIR, PRISTINE_DIR / cache_name, cache_name, repo_config, model, session,
            force=bool(getattr(args, 'regenerate_metadata', False)),
            log=stage,
            missing_credential=env_key if env_key and not os.getenv(env_key) else None,
            full_rebuild_days=getattr(args, '_incremental_full_rebuild_days', DEFAULT_INCREMENTAL_FULL_REBUILD_DAYS),
            trigger=resolve_trigger(default='cli'),
            update_limit_usd=_incremental_policy(args)[0], failure_stop=_incremental_policy(args)[1],
            spending=getattr(args, '_spending', None),
            allow_incremental=full_name in getattr(args, '_incremental_repos', ()))
    except Exception as e:
        outcome = _escaped_incremental_outcome(cache_name, full_name, e)
    return _report_incremental(task_data, outcome, model, args, ctx)


def _escaped_incremental_outcome(cache_name, full_name, error):
    reason = incremental_metadata.safe_reason(f"{type(error).__name__}: {error}")
    state_error = incremental_metadata.record_failure(PRISTINE_DIR, cache_name, full_name, reason, phase='worker')
    return incremental_metadata.Outcome('failed', None, reason, None, None, {}, 0.0, state_error)


def _report_incremental(task_data, outcome, model, args, ctx):
    """Progress, Activity and stats for one repository's metadata outcome and its known spend, at most once
    per run. The Activity event keeps its metadata_incremental name; its strategy says full or incremental."""
    repo_config, _cache_name, _commit_hash, short_id, color, _ = task_data
    full_name = repo_config['full_name']
    reported = getattr(args, '_incremental_reported', None)
    if reported is not None:
        if full_name in reported:
            return 0.0
        reported.add(full_name)
    task_id, task_color = ctx.meta_tasks[full_name]
    usage = outcome.usage or {}
    cost = usage.get('known_cost_usd') or 0.0
    unknown_calls = usage.get('unknown_cost_calls') or 0
    cost_text = f"${cost:.4f}" if not unknown_calls else f"cost unknown (known subtotal ${cost:.4f})"
    label = 'updated' if outcome.strategy == 'incremental' else 'rebuilt'
    note = f"; {outcome.state_error}" if outcome.state_error else ''
    if outcome.status == 'none':
        ctx.meta_progress.update(task_id, completed=100, status=f"[{task_color}]✓ metadata current[/{task_color}]")
        _incremental_status(args, full_name, short_id, '✓ metadata current', 100, color)
    elif outcome.status == 'published':
        tone = task_color if not outcome.state_error else 'yellow'
        ctx.meta_progress.update(task_id, completed=100, status=f"[{tone}]✓ metadata {label} ({cost_text}){note}[/{tone}]")
        _incremental_status(args, full_name, short_id, f'✓ metadata {label} ({cost_text}){note}', 100,
                            color if not outcome.state_error else 'yellow')
        with ctx.stats_lock:
            ctx.stats['metadata_generated'] += 1
    else:
        warning = outcome.status == 'skipped'
        tone = 'yellow' if warning else 'red'
        mark = '⚠' if warning else '✗'
        # Only claim INDEX shows the staleness when the attempt was actually recorded.
        kept = ('previous metadata kept, marked stale in INDEX' if not outcome.state_error
                else 'previous metadata kept, but the staleness could not be recorded')
        ctx.meta_progress.update(task_id, completed=100,
                                 status=f"[{tone}]{mark} metadata {outcome.status}: {outcome.reason}{note}[/{tone}]")
        _incremental_status(args, full_name, short_id, f'{mark} metadata update {outcome.status}; {kept}', 100, tone)
        if not warning and hasattr(args, 'status_server') and args.status_server:
            send_status_update('error', {'repo': full_name, 'message': f'Metadata update failed: {outcome.reason}'[:120],
                                         'fullError': f"Metadata update failed for {full_name}\n"
                                                      f"Strategy: {outcome.strategy or 'not decided'}\n"
                                                      f"Reason: {outcome.reason}\n"
                                                      f"{kept[0].upper() + kept[1:]}"
                                                      f"{(': ' + outcome.state_error) if outcome.state_error else ''}."},
                               args.status_server)
        with ctx.stats_lock:
            ctx.stats['skipped' if warning else 'errors'] = ctx.stats.get('skipped' if warning else 'errors', 0) + 1
    with ctx.stats_lock:
        ctx.stats['api_cost'] += cost
        ctx.stats['unknown_cost_calls'] = ctx.stats.get('unknown_cost_calls', 0) + unknown_calls
    if ctx.sync_logger:
        level = 'info' if outcome.status in ('none', 'published') else ('warn' if outcome.status == 'skipped' else 'error')
        if outcome.state_error and level == 'info':
            level = 'warn'
        ctx.sync_logger.event(
            "metadata_incremental", level=level, repo=full_name, status=outcome.status, strategy=outcome.strategy,
            reason=outcome.reason, state_error=outcome.state_error, base=(outcome.base or '')[:12],
            target=(outcome.target or '')[:12], model=model,
            calls=usage.get('calls', 0), input_tokens=usage.get('input_tokens', 0),
            output_tokens=usage.get('output_tokens', 0), cost=cost_text,
            unknown_cost_calls=usage.get('unknown_cost_calls', 0), changed_files=usage.get('changed_files'),
            changed_bytes=usage.get('changed_bytes'), read_bytes=usage.get('read_bytes'),
            diff_pages=usage.get('diff_pages'), omitted_paths=usage.get('omitted_paths'),
            map_calls=usage.get('map_calls'), merge_calls=usage.get('merge_calls'), edit_turns=usage.get('edit_turns'),
            estimated_total_usd=usage.get('estimated_total_usd'),
            elapsed=f"{outcome.elapsed:.1f}s")
    return cost


def _record_incremental_git_failure(args, full_name, cache_name, step, sync_logger):
    """A repository's Git step failed before metadata: record the attempt so INDEX shows its metadata stale
    or unavailable. Errors were already counted by the Git step, so nothing here counts them again."""
    if args.dry_run or args.skip_metadata or getattr(args, 'repos_only', False):
        return
    state_error = incremental_metadata.record_failure(
        PRISTINE_DIR, cache_name, full_name, f"{step} failed, so metadata was not updated", phase='git')
    args._incremental_index_due = True
    if state_error and sync_logger:
        sync_logger.event("metadata_incremental", level='error', repo=full_name, status='failed',
                          reason=f"{step} failed", state_error=state_error)


def sync_mode(args):
    """Run sync mode."""
    from rich.progress import Progress, SpinnerColumn, BarColumn, TextColumn, TimeElapsedColumn
    from rich.live import Live
    from rich.table import Table
    from rich.console import Console
    from concurrent.futures import ThreadPoolExecutor, as_completed
    import threading
    import time
    import sys
    from io import StringIO

    console = Console()

    # If status server enabled, wrap console.print to capture output
    if args.status_server:
        original_print = console.print

        def wrapped_print(*print_args, **print_kwargs):
            result = original_print(*print_args, **print_kwargs)
            # Capture output by rendering to string
            with StringIO() as buf:
                temp_console = Console(file=buf, force_terminal=True, width=120)
                temp_console.print(*print_args, **print_kwargs)
                output = buf.getvalue()
                send_status_update('output', {'data': output}, args.status_server)
            return result

        console.print = wrapped_print

    # Establish (or adopt) the activity writer BEFORE the unknown-model guard below, so even the
    # very first possible exit records a durable incident (Task 2.6). `args._activity_writer` is
    # set by cli.py's adopt-or-mint dance (Task 2.5) for every real `sync` invocation; a direct
    # call that skipped cli.py (most of this module's own test suite, and any future direct
    # caller) falls back to minting its own. Best-effort throughout -- see `_activity_start` /
    # `_activity_terminal`; a history-write failure can never alter the sync below.
    activity_writer = getattr(args, '_activity_writer', None) or _mint_activity_writer()
    _activity_start(activity_writer)

    # Tag every status update with this attempt so the app can keep its progress view on the
    # right run: a window opened late, a scheduled run the app did not start, or a previous run's
    # last updates arriving after this one began. The Activity ID is the attempt's identity when
    # recording works; otherwise a one-off ID still keeps attempts apart. When the app launched
    # this run it says which ID to use, so its window follows this worker even if recording
    # isn't working for this run.
    attempt_id = _progress_attempt_id() or getattr(activity_writer, 'activity_id', None)
    if not isinstance(attempt_id, str) or not attempt_id:
        attempt_id = uuid.uuid4().hex
    set_status_attempt(attempt_id, resolve_channel())
    send_status_update('sync-lifecycle', {'phase': 'starting'}, args.status_server)

    def _terminal(outcome, **summary):
        """Record the run's one authoritative outcome, and tell the app so it can stop loading."""
        _activity_terminal(activity_writer, outcome, **summary)
        send_status_update('sync-terminal', {'outcome': outcome, 'reason': summary.get('reason')},
                           args.status_server)

    # Fail-closed: reject an uncatalogued model before any network wait or git work. A
    # metadata-capable run (not skip_metadata, not repos_only) will eventually call the LLM, so an
    # unknown model must be caught here -- at the very top, before the 5-minute network wait and
    # before any repo is touched -- rather than surfacing as an opaque API error deep into the run.
    # dry_run is intentionally NOT exempted: a dry run with a misconfigured model should still fail
    # loudly, surfacing the misconfiguration early, instead of silently succeeding just because a
    # dry run never actually talks to the LLM.
    metadata_capable = not getattr(args, 'skip_metadata', False) and not getattr(args, 'repos_only', False)
    if metadata_capable:
        model = get_ai_model()
        if not is_known_model(model):
            console.print(
                f"[red]Unknown model '{model}' is not in the model catalog. "
                f"Add it to repo_radar/model_catalog.py (MODEL_CAPS) before running sync, "
                f"or pass --skip-metadata / --repos-only to skip metadata generation.[/red]"
            )
            # Pre-attempt early exit, before the old per-run log even exists -- still a durable
            # System incident: `blocked` is the same bucket as a dependency-check failure or a
            # missing/invalid config (spec Sec 3: pre-worker guard/verification block).
            _terminal('blocked', reason='unknown_model', model=model)
            return 1

    console.print(f"[bold]Repository Sync[/bold]")
    console.print()

    # Open a per-run log file for LLM-friendly review. Kept separate from the
    # UI's rich console output: one line per meaningful event, no progress bars,
    # no ANSI, rotated to the most recent runs.
    sync_logger = _open_sync_logger()
    if sync_logger is not None:
        sync_logger.set_activity_writer(activity_writer)
    # Provenance is DECLARED by the invoker, not guessed. The old heuristic read "is a window
    # being shown", so a genuine LaunchAgent run recorded itself as "manual" and the logs could
    # not distinguish scheduled from manual. The window heuristic remains only as the default
    # for callers that declare nothing.
    # Every invoker DECLARES its trigger via REPO_RADAR_TRIGGER (LaunchAgent=scheduled,
    # Electron button=manual, Electron catch-up=catchup, dispatcher/CLI=cli). The previous
    # heuristic read args.show_window, which the CLI never defines — so it silently resolved to
    # "manual" for every run, launchd jobs included. 'cli' is the honest default for an
    # undeclared invocation: it means "something ran this directly".
    run_trigger = resolve_trigger(default='cli')
    run_channel = resolve_channel()
    run_mode_name = run_mode(
        skip_metadata=bool(getattr(args, 'skip_metadata', False)),
        metadata_only=bool(getattr(args, 'metadata_only', False)),
        repos_only=bool(getattr(args, 'repos_only', False)),
    )
    run_started_at = datetime.now(timezone.utc).isoformat()
    def _finalize_run(stats_snapshot):
        """Record completion once, from whichever path finished the run.

        A zero-repository run returns success early; without going through here it completed
        every day and left no receipt, so the catch-up logic kept believing a sync was overdue —
        the very symptom this work exists to remove, surviving on one path.
        """
        if getattr(args, 'dry_run', False):
            return
        written = write_receipt(
            CONFIG_DIR,
            trigger=run_trigger,
            started_at=run_started_at,
            stats=stats_snapshot,
            channel=run_channel,
            mode=run_mode_name,
            version=REPO_RADAR_VERSION,
        )
        if sync_logger:
            _receipt_event = "receipt_written" if written else "receipt_failed"
            sync_logger.event(_receipt_event,
                              level=_activity_level(_receipt_event, is_degraded=not written),
                              trigger=run_trigger, channel=run_channel, mode=run_mode_name)

    if sync_logger:
        sync_logger.event(
            "sync_start",
            trigger=run_trigger,
            channel=run_channel,
            mode=run_mode_name,
            dry_run=bool(getattr(args, 'dry_run', False)),
            skip_metadata=bool(getattr(args, 'skip_metadata', False)),
        )

    # Lock-held guard for catch-up runs. The catch-up decision was made in Electron BEFORE the
    # root execution lock was acquired, so a real scheduled worker could have finished and
    # released the lock in between — and this run would then redo the same paid work. We are past
    # the dispatcher's lock acquisition here, so this is the first race-free moment to re-check.
    if run_trigger == 'catchup':
        not_before = (os.environ.get('REPO_RADAR_CATCHUP_NOT_BEFORE') or '').strip()
        existing = read_receipt(CONFIG_DIR, run_channel)
        # Re-derive via the shared rule rather than trusting the stored flag: a receipt written by
        # an older build could carry a qualification computed by a different (and wrong) rule.
        # Compare INSTANTS, not strings. read_receipt already rejects unparseable and future
        # timestamps, so a corrupt receipt can no longer decline work by sorting above the
        # watermark lexically.
        finished_at = parse_instant(existing.get('finishedAt')) if existing else None
        watermark = parse_instant(not_before)
        satisfied = bool(existing and finished_at and qualifies_for_schedule(
            existing.get('channel'), existing.get('mode')))
        if satisfied:
            if watermark is None or finished_at > watermark:
                console.print("[yellow]A qualifying sync already completed — skipping catch-up[/yellow]")
                if sync_logger:
                    sync_logger.event("catchup_skipped", reason="already_satisfied",
                                      satisfied_at=existing['finishedAt'])
                    sync_logger.close()
                _terminal('skipped', reason='catchup_already_satisfied')
                # Distinct from 0: nothing was synced, so the caller must not stamp a completion
                # timestamp for this run.
                return EXIT_SKIPPED_NO_WORK

    # Wait for network connectivity (handles laptop wake from sleep)
    def _notify_waiting(elapsed):
        console.print(f"[yellow]Waiting for network connectivity...[/yellow]")
        if sync_logger:
            sync_logger.event("network_wait")
        if args.status_server:
            send_status_update('waiting-for-network', {}, args.status_server)

    try:
        network_ready = wait_for_network(on_waiting=_notify_waiting)
    except NetworkWaitCancelled:
        # Stop was pressed during the wait. The probe has already been killed and reaped; record
        # a cancellation, not a connectivity failure.
        console.print(f"[yellow]Sync cancelled while waiting for network.[/yellow]")
        if sync_logger:
            sync_logger.event("sync_aborted", reason="cancelled")
            sync_logger.close()
        _terminal('cancelled', reason='cancelled_during_network_wait')
        return 128 + signal.SIGTERM

    if not network_ready:
        console.print(f"[red]No network connectivity. Aborting sync.[/red]")
        if sync_logger:
            sync_logger.event("sync_aborted",
                              level=_activity_level("sync_aborted", is_exhausted=True),
                              reason="no_network_connectivity")
            sync_logger.close()
        if args.status_server:
            send_status_update('network-timeout', {
                'message': 'No network connectivity'
            }, args.status_server)
            # Also surface as an error so the "View Errors" list picks it up
            # for background/scheduled syncs that have no open log window.
            send_status_update('error', {
                'repo': 'Network',
                'message': 'No network connectivity',
                'fullError': 'Sync aborted: network was unavailable after retrying for 5 minutes.'
            }, args.status_server)
        # Last, so the app sees the abort details above before this attempt's terminal outcome.
        _terminal('failed', reason='no_network_connectivity')
        return 1

    send_status_update('sync-lifecycle', {'phase': 'syncing'}, args.status_server)

    # Load configuration
    config = load_config()
    if not config:
        console.print(f"[red]No configuration found. Run 'configure' first.[/red]")
        # Config-abort leak fix (Task 2.6): this early return used to leave `sync_logger` open
        # (every other pre-work abort above closes it) and record nothing durable. Same bucket
        # as unknown-model / a dependency-check failure (spec Sec 3: pre-worker guard/
        # verification block) -- the run never got far enough to touch a repo.
        if sync_logger:
            sync_logger.event("sync_aborted",
                              level=_activity_level("sync_aborted", is_exhausted=True),
                              reason="no_configuration")
            sync_logger.close()
        _terminal('blocked', reason='no_configuration')
        return 1

    # Opt-in to incremental metadata: which repositories may update from a diff. Every other repository
    # is full-only on the same worker. A malformed list is a configuration error whenever metadata is
    # enabled; with metadata off nothing uses it.
    try:
        args._incremental_repos = incremental_metadata_repos(config)
        args._incremental_full_rebuild_days = incremental_full_rebuild_days(config)
    except ValueError as e:
        if metadata_capable:
            console.print(f"[red]{e}[/red]")
            if sync_logger:
                sync_logger.event("sync_aborted", level=_activity_level("sync_aborted", is_exhausted=True),
                                  reason="invalid_incremental_metadata_repos")
                sync_logger.close()
            _terminal('blocked', reason='invalid_incremental_metadata_repos')
            return 1
        args._incremental_repos = frozenset()
        args._incremental_full_rebuild_days = 0
    # The Settings spending limits, captured once for this whole sync. An invalid value falls back to its
    # default with a warning naming only the field, never to no limit.
    limit_usd, failure_stop, invalid_fields = incremental_spending_policy(config)
    args._incremental_policy = (limit_usd, failure_stop)
    for field in invalid_fields:
        console.print(f"[yellow]Warning: {field} in the config is invalid; using its default[/yellow]")
    # The weekly spending record every generation attempt in this sync is admitted against. Its settings
    # are read again at each admission; here they're only checked so an invalid value is reported once.
    for field in weekly_spending_policy(config)[2]:
        console.print(f"[yellow]Warning: {field} in the config is invalid; using its default[/yellow]")
    args._spending = None
    if metadata_capable and not args.dry_run:
        args._spending = Spending(resolve_channel(), policy=lambda: policy_from_config(load_config()))
        try:
            args._spending.initialize()   # the first normal sync starts the first period
        except SpendingError as e:
            console.print(f"[yellow]Warning: spending record unavailable ({e}); metadata updates won't be sent[/yellow]")
    args._incremental_reported = set()
    args._incremental_index_due = False

    repos = config.get('repositories', [])
    # This run's repositories, so the app can lay out its rows even if it opened the window late
    # or missed the start. Display names and row colors only; nothing else from the config (clone
    # URLs can carry credentials) goes with it. An empty list means "no repositories", which the
    # app tells apart from never having heard.
    send_status_update('sync-roster', {'repos': [
        {'name': r['full_name'], 'color': PROGRESS_COLORS[i % len(PROGRESS_COLORS)]}
        for i, r in enumerate(repos) if isinstance(r, dict) and r.get('full_name')
    ]}, args.status_server)
    if not repos:
        console.print(f"[yellow]No repositories configured[/yellow]")
        # A successful no-op is still a completed run; record it or the schedule looks missed.
        _finalize_run({'total': 0, 'updated': 0, 'cloned': 0, 'skipped': 0,
                       'errors': 0, 'metadata_generated': 0, 'api_cost': 0.0})
        if sync_logger:
            sync_logger.event("sync_complete", total=0, updated=0, cloned=0, skipped=0,
                              errors=0, metadata=0, cost="$0.0000")
            sync_logger.close()
        _terminal('succeeded', reason='no_repositories_configured')
        return 0

    # Create directories
    if not args.dry_run:
        PRISTINE_DIR.mkdir(parents=True, exist_ok=True)

    # Load cache index
    cache_index = load_cache_index()

    # Track statistics
    stats = {
        'total': len(repos),
        'cloned': 0,
        'updated': 0,
        'skipped': 0,
        'errors': 0,
        'metadata_generated': 0,
        'degraded': 0,
        'api_cost': 0.0
    }
    stats_lock = threading.Lock()

    repos_needing_metadata = []
    metadata_lock = threading.Lock()

    console.print(f"Processing {len(repos)} repositories in parallel...")
    console.print()

    if sync_logger:
        sync_logger.event("repos_loaded", count=len(repos))

    # Create progress bars for each repo
    progress = Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TextColumn("[progress.percentage]{task.percentage:>3.0f}%"),
        TextColumn("•"),
        TextColumn("{task.fields[status]}"),
        TimeElapsedColumn(),
        console=console,
        expand=True
    )

    # Assign colors to each repo sequentially
    repo_tasks = {}
    repo_colors = {}

    for i, repo_config in enumerate(repos):
        full_name = repo_config['full_name']
        repo_name = full_name.split('/')[-1]
        short_id, _ = get_short_id(full_name)

        # Assign color sequentially from palette
        color = PROGRESS_COLORS[i % len(PROGRESS_COLORS)]
        repo_colors[full_name] = color

        # Create progress task
        task_id = progress.add_task(
            f"[{color}]{short_id:15s}[/{color}]",
            total=100,
            status="[dim]waiting...[/dim]"
        )
        repo_tasks[full_name] = task_id

    # Process repos in parallel (git operations)
    max_git_workers = min(4, len(repos))  # Max 4 parallel git operations

    def process_repo(repo_config):
        """Process a single repo with progress updates."""
        full_name = repo_config['full_name']
        clone_url = repo_config['clone_url']
        repo_name = full_name.split('/')[-1]

        task_id = repo_tasks[full_name]
        color = repo_colors[full_name]

        # Generate short ID
        short_id, _ = get_short_id(full_name)

        # Get or create cache name
        cache_name = cache_index.get(clone_url)
        if not cache_name:
            cache_name = get_cache_name(clone_url, repo_name)
            cache_index[clone_url] = cache_name

        repo_path = PRISTINE_DIR / cache_name

        try:
            # Check if repo exists
            if not repo_path.exists():
                # Clone new repository
                progress.update(task_id, completed=10, status=f"[{color}]cloning...[/{color}]")

                # Send status update to server
                if args.status_server:
                    send_status_update('progress', {
                        'repo': full_name, 'short_name': short_id,
                        'status': 'cloning...',
                        'percent': 10,
                        'color': color
                    }, args.status_server)

                if args.dry_run:
                    progress.update(task_id, completed=50, status=f"[dim][DRY RUN] would clone[/dim]")
                    time.sleep(0.1)  # Simulate work
                    note = ''
                    if not args.skip_metadata and not getattr(args, 'repos_only', False):
                        note = '; metadata: full rebuild (new repository)'
                    progress.update(task_id, completed=100, status=f"[{color}]✓ cloned (dry run){note}[/{color}]")
                    return (True, 'cloned', cache_name, None, False, short_id, color)

                result = run_git_command(['git', 'clone', clone_url, str(repo_path)], check=False)

                if result.returncode != 0:
                    progress.update(task_id, completed=100, status=f"[red]✗ clone failed[/red]")
                    if sync_logger:
                        sync_logger.error(
                            "clone_failed",
                            repo=full_name,
                            detail=getattr(result, 'stderr', None),
                        )
                    if args.status_server:
                        send_status_update('progress', {
                            'repo': full_name, 'short_name': short_id,
                            'status': '✗ clone failed',
                            'percent': 100,
                            'color': color
                        }, args.status_server)
                    _record_incremental_git_failure(args, full_name, cache_name, 'clone', sync_logger)
                    with stats_lock:
                        stats['errors'] += 1
                    return (False, 'error', cache_name, None, False, short_id, color)

                progress.update(task_id, completed=50, status=f"[{color}]checking out branch...[/{color}]")

                # Send status update
                if args.status_server:
                    send_status_update('progress', {
                        'repo': full_name, 'short_name': short_id,
                        'status': 'checking out branch...',
                        'percent': 50,
                        'color': color
                    }, args.status_server)

                # Determine and checkout preferred branch
                branch = determine_preferred_branch(repo_path, repo_config.get('default_branch', 'dev'))
                if branch:
                    run_git_command(['git', 'checkout', branch], cwd=repo_path, check=False)

                # Create symlink
                symlink_path = PRISTINE_DIR / repo_name
                if not symlink_path.exists():
                    try:
                        symlink_path.symlink_to(cache_name)
                    except Exception:
                        pass

                # Get current commit
                result = run_git_command(['git', 'rev-parse', 'HEAD'], cwd=repo_path, check=False)
                commit_hash = result.stdout.strip() if result.returncode == 0 else None

                needs_metadata = bool(commit_hash) and not args.skip_metadata and not getattr(args, 'repos_only', False)

                # If metadata is needed, show as 90% with waiting status
                if needs_metadata:
                    completion_percent = 90
                    status_text = f"[{color}]⏳ waiting for AI analysis...[/{color}]"
                else:
                    completion_percent = 100
                    status_text = f"[{color}]✓ cloned[/{color}]"

                progress.update(task_id, completed=completion_percent, status=status_text)

                # Send status update
                if args.status_server:
                    send_status_update('progress', {
                        'repo': full_name, 'short_name': short_id,
                        'status': f"✓ cloned{' (analyzing next...)' if needs_metadata else ''}",
                        'percent': completion_percent,
                        'color': color
                    }, args.status_server)

                with stats_lock:
                    stats['cloned'] += 1

                if sync_logger:
                    sync_logger.event(
                        "repo_cloned",
                        repo=full_name,
                        commit=(commit_hash[:7] if commit_hash else None),
                    )

                if needs_metadata:
                    with metadata_lock:
                        repos_needing_metadata.append((repo_config, cache_name, commit_hash, short_id, color, task_id))

                return (True, 'cloned', cache_name, commit_hash, needs_metadata, short_id, color)

            else:
                # Update existing repository
                progress.update(task_id, completed=10, status=f"[{color}]fetching...[/{color}]")

                # Send status update
                if args.status_server:
                    send_status_update('progress', {
                        'repo': full_name, 'short_name': short_id,
                        'status': 'fetching...',
                        'percent': 10,
                        'color': color
                    }, args.status_server)

                if args.dry_run:
                    progress.update(task_id, completed=50, status=f"[dim][DRY RUN] would update[/dim]")
                    time.sleep(0.1)  # Simulate work
                    note = ''
                    if not args.skip_metadata and not getattr(args, 'repos_only', False):
                        note = f"; metadata: {_dry_run_decision(repo_path, cache_name, full_name, args)}"
                    progress.update(task_id, completed=100, status=f"[{color}]✓ updated (dry run){note}[/{color}]")
                    return (True, 'updated', cache_name, None, False, short_id, color)

                # Get current commit before update
                result = run_git_command(['git', 'rev-parse', 'HEAD'], cwd=repo_path, check=False)
                old_commit = result.stdout.strip() if result.returncode == 0 else None

                # Hard reset any local changes
                run_git_command(['git', 'reset', '--hard', 'HEAD'], cwd=repo_path, check=False)

                progress.update(task_id, completed=30, status=f"[{color}]updating...[/{color}]")

                # Send status update
                if args.status_server:
                    send_status_update('progress', {
                        'repo': full_name, 'short_name': short_id,
                        'status': 'updating...',
                        'percent': 30,
                        'color': color
                    }, args.status_server)

                # Determine preferred branch
                branch = determine_preferred_branch(repo_path, repo_config.get('default_branch', 'dev'))
                if branch:
                    run_git_command(['git', 'checkout', branch], cwd=repo_path, check=False)

                # Fetch from origin (retry up to 3 times for transient network issues)
                fetch_ok = False
                last_fetch_result = None
                for attempt in range(3):
                    result = run_git_command(['git', 'fetch', 'origin'], cwd=repo_path, check=False)
                    last_fetch_result = result
                    if result.returncode == 0:
                        fetch_ok = True
                        break
                    if attempt < 2:
                        time.sleep(2 * (attempt + 1))  # 2s, 4s backoff

                if not fetch_ok:
                    progress.update(task_id, completed=100, status=f"[red]✗ fetch failed[/red]")
                    if sync_logger:
                        sync_logger.error(
                            "fetch_failed",
                            repo=full_name,
                            detail=getattr(last_fetch_result, 'stderr', None),
                        )
                    if args.status_server:
                        send_status_update('progress', {
                            'repo': full_name, 'short_name': short_id,
                            'status': '✗ fetch failed',
                            'percent': 100,
                            'color': color
                        }, args.status_server)
                    _record_incremental_git_failure(args, full_name, cache_name, 'fetch', sync_logger)
                    with stats_lock:
                        stats['errors'] += 1
                    return (False, 'error', cache_name, old_commit, False, short_id, color)

                progress.update(task_id, completed=60, status=f"[{color}]pulling...[/{color}]")

                # Send status update
                if args.status_server:
                    send_status_update('progress', {
                        'repo': full_name, 'short_name': short_id,
                        'status': 'pulling...',
                        'percent': 60,
                        'color': color
                    }, args.status_server)

                # Pull latest changes
                result = run_git_command(['git', 'pull', '--ff-only'], cwd=repo_path, check=False)
                if result.returncode != 0:
                    result = run_git_command(['git', 'pull'], cwd=repo_path, check=False)
                    if result.returncode != 0:
                        progress.update(task_id, completed=100, status=f"[red]✗ pull failed[/red]")
                        if sync_logger:
                            sync_logger.error(
                                "pull_failed",
                                repo=full_name,
                                detail=getattr(result, 'stderr', None),
                            )
                        if args.status_server:
                            send_status_update('progress', {
                                'repo': full_name, 'short_name': short_id,
                                'status': '✗ pull failed',
                                'percent': 100,
                                'color': color
                            }, args.status_server)
                        _record_incremental_git_failure(args, full_name, cache_name, 'pull', sync_logger)
                        with stats_lock:
                            stats['errors'] += 1
                        return (False, 'error', cache_name, old_commit, False, short_id, color)

                # Get new commit
                result = run_git_command(['git', 'rev-parse', 'HEAD'], cwd=repo_path, check=False)
                new_commit = result.stdout.strip() if result.returncode == 0 else None

                # Due work (an unfinished rebuild owed, a changed tree, a missing document) can exist on an
                # unchanged HEAD too, so every repository is evaluated; the decision may be "nothing".
                needs_metadata = bool(new_commit) and not args.skip_metadata and not getattr(args, 'repos_only', False)

                if old_commit and new_commit and old_commit != new_commit:
                    status_msg = f"[{color}]✓ updated ({old_commit[:7]} → {new_commit[:7]})[/{color}]"
                else:
                    status_msg = f"[{color}]✓ up to date[/{color}]"

                # If metadata is needed, show as 90% and different status
                if needs_metadata:
                    completion_percent = 90
                    status_msg = f"[{color}]⏳ waiting for AI analysis...[/{color}]"
                else:
                    completion_percent = 100

                progress.update(task_id, completed=completion_percent, status=status_msg)

                # Send status update
                if args.status_server:
                    clean_status = status_msg.replace(f'[{color}]', '').replace(f'[/{color}]', '')
                    send_status_update('progress', {
                        'repo': full_name, 'short_name': short_id,
                        'status': clean_status,
                        'percent': completion_percent,
                        'color': color
                    }, args.status_server)

                with stats_lock:
                    stats['updated'] += 1

                if sync_logger:
                    if old_commit and new_commit and old_commit != new_commit:
                        sync_logger.event(
                            "repo_updated",
                            repo=full_name,
                            old=old_commit[:7],
                            new=new_commit[:7],
                        )
                    else:
                        sync_logger.event("repo_unchanged", repo=full_name)

                if needs_metadata:
                    with metadata_lock:
                        repos_needing_metadata.append((repo_config, cache_name, new_commit, short_id, color, task_id))

                return (True, 'updated', cache_name, new_commit, needs_metadata, short_id, color)

        except Exception as e:
            import traceback

            error_msg_short = str(e)[:30]
            full_error = str(e)
            error_type = type(e).__name__
            stack_trace = traceback.format_exc()

            detailed_error = f"""ERROR: Git Sync Failed
Repository: {repo_config['full_name']}
Error Type: {error_type}

Full Error:
{full_error}

Stack Trace:
{stack_trace}"""

            progress.update(task_id, completed=100, status=f"[red]✗ error: {error_msg_short}[/red]")

            if sync_logger:
                sync_logger.error(
                    "repo_exception",
                    repo=repo_config['full_name'],
                    error_type=error_type,
                    detail=full_error,
                )

            # Send detailed error to status server
            if args.status_server:
                send_status_update('progress', {
                    'repo': repo_config['full_name'], 'short_name': short_id,
                    'status': f'✗ error: {error_msg_short}',
                    'percent': 100,
                    'color': color
                }, args.status_server)
                send_status_update('error', {
                    'repo': repo_config['full_name'],
                    'message': f'Git sync failed: {error_msg_short}',
                    'fullError': detailed_error
                }, args.status_server)

            _record_incremental_git_failure(args, full_name, cache_name, 'git sync', sync_logger)
            with stats_lock:
                stats['errors'] += 1
            return (False, 'error', None, None, False, short_id, color)

    # Run git operations with live progress display
    with Live(progress, console=console, refresh_per_second=10):
        with ThreadPoolExecutor(max_workers=max_git_workers) as executor:
            futures = [executor.submit(process_repo, repo) for repo in repos]

            # Wait for all to complete
            for future in as_completed(futures):
                try:
                    future.result()
                except Exception as e:
                    with stats_lock:
                        stats['errors'] += 1

    # Save cache index
    if not args.dry_run:
        save_cache_index(cache_index)

    console.print()

    # Generate metadata for repos that need it (sequentially to avoid rate limits)
    if repos_needing_metadata and not args.skip_metadata:
        console.print()
        console.print(f"[bold cyan]📝 Generating metadata for {len(repos_needing_metadata)} repositories...[/bold cyan]")
        console.print(f"[dim]Processing sequentially to avoid rate limits. This may take a few minutes.[/dim]")
        console.print()

        # Send status update to UI that metadata phase is starting
        if args.status_server:
            send_status_update('output', {
                'data': f"\n\n📝 Generating metadata for {len(repos_needing_metadata)} repositories...\nProcessing sequentially to avoid rate limits.\n\n"
            }, args.status_server)

        # Create new progress for metadata generation
        meta_progress = Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TextColumn("[progress.percentage]{task.percentage:>3.0f}%"),
            TextColumn("•"),
            TextColumn("{task.fields[status]}"),
            TimeElapsedColumn(),
            console=console,
            expand=True
        )

        # Create tasks for metadata generation
        meta_tasks = {}
        for repo_config, cache_name, commit_hash, short_id, color, _ in repos_needing_metadata:
            task_id = meta_progress.add_task(
                f"[{color}]{short_id:15s}[/{color}]",
                total=100,
                status="[dim]waiting...[/dim]"
            )
            meta_tasks[repo_config['full_name']] = (task_id, color)

        # Use only 1 worker for LLM calls to avoid rate limits
        # Processing sequentially is slower but prevents rate limit errors
        max_metadata_workers = 1

        # Run metadata generation with live progress. ONE PreflightSession is shared across every
        # repo in this phase, so its authoritative-count memo and per-model breaker are process-wide
        # (intended: identical prompts are counted once; a model that degrades stays degraded).
        # Stop (SIGTERM) in this phase closes this process's open spending holds and exits 143 at once; the
        # network wait's own handler has already been restored by now.
        with PreflightSession() as session, stop_on_sigterm(getattr(args, '_spending', None)):
            ctx = SyncContext(meta_progress, meta_tasks, stats, stats_lock, sync_logger, console)
            with Live(meta_progress, console=console, refresh_per_second=10):
                with ThreadPoolExecutor(max_workers=max_metadata_workers) as executor:
                    futures = {executor.submit(lambda td: generate_repo_metadata(td, session, args, ctx), task_data): task_data
                               for task_data in repos_needing_metadata}

                    for future in as_completed(futures):
                        try:
                            future.result()
                        except Exception as e:
                            task_data = futures[future]
                            full_name = task_data[0]['full_name']
                            # Same reporting as any other failure, counted once.
                            _report_incremental(task_data, _escaped_incremental_outcome(task_data[1], full_name, e),
                                                get_ai_model(), args, ctx)

        console.print()

        # Regenerate INDEX.md
        if not args.dry_run:
            console.print(f"[cyan]Regenerating INDEX.md...[/cyan]")
            regenerate_index(args)
            console.print(f"[green]✓ INDEX.md updated[/green]")
    elif args._incremental_index_due and not args.dry_run:
        # A repository failed before its metadata phase: INDEX must say so.
        regenerate_index(args)

    # Summary
    console.print()
    console.print(f"[bold]Sync Summary:[/bold]")
    console.print(f"  Total repositories: {stats['total']}")
    console.print(f"  Cloned: [green]{stats['cloned']}[/green]")
    console.print(f"  Updated: [green]{stats['updated']}[/green]")
    console.print(f"  Skipped: [yellow]{stats['skipped']}[/yellow]")
    console.print(f"  Errors: [red]{stats['errors']}[/red]")
    if not args.skip_metadata:
        console.print(f"  Metadata generated: [green]{stats['metadata_generated']}[/green]")
        if stats.get('unknown_cost_calls'):
            console.print(f"  API cost: unknown (known subtotal ${stats['api_cost']:.4f}; "
                          f"{stats['unknown_cost_calls']} metadata call(s) of unknown cost)")
        elif stats['api_cost'] > 0:
            console.print(f"  API cost: ${stats['api_cost']:.4f}")

        # Warn if no metadata was generated AND repos don't have existing metadata
        if stats['metadata_generated'] == 0 and (stats['cloned'] > 0 or stats['updated'] > 0):
            # Check if metadata files already exist (would explain why nothing was generated)
            existing_metadata_count = len(list(PRISTINE_DIR.glob('*.md'))) - 1  # Subtract INDEX.md

            # Only warn if we don't have metadata files
            if existing_metadata_count == 0 or stats['errors'] > 0:
                console.print()
                model = get_ai_model()
                console.print(f"[bold yellow]⚠️  WARNING: No metadata was generated![/bold yellow]")

                provider = provider_for_model(model)
                if provider == 'gemini' and not os.getenv('GEMINI_API_KEY'):
                    console.print(f"[yellow]   Reason: GEMINI_API_KEY not configured[/yellow]")
                    console.print(f"[yellow]   Fix: Configure Gemini API Key in Settings → API Configuration[/yellow]")
                elif provider == 'anthropic' and not os.getenv('ANTHROPIC_API_KEY'):
                    console.print(f"[yellow]   Reason: ANTHROPIC_API_KEY not configured[/yellow]")
                    console.print(f"[yellow]   Fix: Configure Anthropic API Key in Settings → API Configuration[/yellow]")
                elif provider == 'openai' and not os.getenv('OPENAI_API_KEY'):
                    console.print(f"[yellow]   Reason: OPENAI_API_KEY not configured[/yellow]")
                    console.print(f"[yellow]   Fix: Configure OpenAI API Key in Settings → API Configuration[/yellow]")
                elif stats['errors'] > 0:
                    console.print(f"[yellow]   Reason: Errors occurred during generation (check above)[/yellow]")
                    console.print(f"[yellow]   Possible causes: Invalid model name, API quota exceeded, etc.[/yellow]")
                else:
                    console.print(f"[yellow]   Reason: Unknown - check your API key and model selection[/yellow]")
                    console.print(f"[yellow]   Current model: {model}[/yellow]")
            else:
                # Metadata already exists, no warning needed
                console.print(f"[dim]  Note: No metadata regenerated (existing {existing_metadata_count} files are up-to-date)[/dim]")

    # Send final completion status to server
    if args.status_server:
        completion_data = {
            'stats': stats
        }

        # Add warnings if metadata wasn't generated
        if not args.skip_metadata and stats['metadata_generated'] == 0 and (stats['cloned'] > 0 or stats['updated'] > 0):
            model = get_ai_model()
            warning_msg = ""

            provider = provider_for_model(model)
            if provider == 'gemini' and not os.getenv('GEMINI_API_KEY'):
                warning_msg = "⚠️ No metadata generated: GEMINI_API_KEY not configured. Configure in Settings → API Configuration."
            elif provider == 'anthropic' and not os.getenv('ANTHROPIC_API_KEY'):
                warning_msg = "⚠️ No metadata generated: ANTHROPIC_API_KEY not configured. Configure in Settings → API Configuration."
            elif provider == 'openai' and not os.getenv('OPENAI_API_KEY'):
                warning_msg = "⚠️ No metadata generated: OPENAI_API_KEY not configured. Configure in Settings → API Configuration."
            elif stats['errors'] > 0:
                warning_msg = f"⚠️ No metadata generated: {stats['errors']} errors occurred (possible model not found or API issues)."
            else:
                warning_msg = f"⚠️ No metadata generated: Unknown reason. Current model: {model}"

            completion_data['warning'] = warning_msg

        # Carry the provenance the qualification rule needs. Without these the status server had
        # no way to tell a full stable run from `--skip-metadata --status-server`, so it advanced
        # lastSync for both — bypassing "partial never qualifies" exactly as dev once did.
        completion_data['channel'] = run_channel
        completion_data['mode'] = run_mode_name
        completion_data['trigger'] = run_trigger
        completion_data['qualifiesForSchedule'] = qualifies_for_schedule(run_channel, run_mode_name)
        send_status_update('complete', completion_data, args.status_server)

    # Authoritative outcome for this run: mapped from the finalization STATE (error / warn /
    # degraded counts), never from "did stderr get written" (Task 2.6, spec Sec 3). `warns` folds
    # in a degraded metadata record and a skipped repo -- either is a defined adverse-but-completed
    # run, distinct from a hard failure. Computed once and reused for both the summary event's
    # severity and the authoritative terminal below, so the two can never disagree.
    sync_warn_count = stats.get('degraded', 0) + stats.get('skipped', 0)
    sync_outcome = _finalize_outcome(errors=stats['errors'], warns=sync_warn_count,
                                     degraded=sync_warn_count > 0)

    if sync_logger:
        sync_logger.event(
            "sync_complete",
            level=_activity_level("sync_complete",
                                  is_degraded=(sync_outcome == 'succeeded-with-warnings'),
                                  is_exhausted=(sync_outcome == 'failed')),
            total=stats['total'],
            updated=stats['updated'],
            cloned=stats['cloned'],
            skipped=stats['skipped'],
            errors=stats['errors'],
            metadata=stats['metadata_generated'],
            cost=(f"${stats['api_cost']:.4f}" if not stats.get('unknown_cost_calls')
                  else f"unknown (known subtotal ${stats['api_cost']:.4f})"),
        )

    # Durable completion receipt. Progress went to a status server inside the app, so a run that
    # finished with the app closed previously left no trace at all — the tray showed a stale
    # time and the catch-up logic, reading that same stale value, could launch a redundant paid
    # sync. Written here regardless of trigger; Electron reconciles it into the status file on
    # next start. Never fails the run: a completed sync must not report failure because its
    # receipt could not be written.
    _finalize_run(stats)

    if sync_logger:
        sync_logger.close()

    _terminal(sync_outcome, errors=stats['errors'],
                       warnings=sync_warn_count, cloned=stats['cloned'], updated=stats['updated'],
                       metadata_generated=stats['metadata_generated'])

    return 0 if stats['errors'] == 0 else 1
