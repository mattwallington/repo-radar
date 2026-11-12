"""Incremental metadata: the five behavioral cases in PLAN-incremental-metadata.md.

Disposable Git repositories and a fake provider at the HTTP transport (sends) and at the Count Tokens
client (counts). Sockets are blocked, keys are fake, nothing is paid for.
"""
import base64
import json
import os
import re
import shutil
import socket
import subprocess
import threading
import time
import types
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from repo_radar import summary_pipeline as mr
from repo_radar import incremental_metadata as im
from repo_radar import config as repo_config, metadata, metadata_snapshot as snap
from repo_radar.metadata_budget import Budget, BudgetExceeded, Ledger, LedgerWriteError, PricingUnavailable
from repo_radar.modes import sync as S
from repo_radar.preflight import PreflightSession

MODEL = 'claude-sonnet-5-5'
FULL = 'o/app'
NOW = datetime.now().replace(microsecond=0)


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    def blocked(*a, **k):
        raise OSError("network blocked in test")
    monkeypatch.setattr(socket.socket, 'connect', blocked)
    for var in ('ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'):
        monkeypatch.setenv(var, 'test-not-a-key')
    monkeypatch.setenv('AI_MODEL', MODEL)


class Provider:
    """Scripted replies for sends; counts answer `count_tokens` (a number, or a callable of the body,
    or an exception). Every serialized send and count body is recorded. Only a POST to `endpoint`
    (Anthropic's Messages API unless a test names another provider) is a send: anything else, such as
    LiteLLM's background model-map GET that another test may already have started, fails locally and
    never consumes a reply."""

    def __init__(self, monkeypatch):
        self.replies, self.sends, self.counts = [], [], []
        self.count_tokens = 1000
        self.endpoint = ('api.anthropic.com', '/v1/messages')
        provider = self

        def handle(transport, request):
            if (request.method, request.url.host, request.url.path) != ('POST', *provider.endpoint):
                raise httpx.ConnectError(f"not the scripted provider: {request.method} {request.url}", request=request)
            body = json.loads(request.content or b'{}')
            provider.sends.append((request.url.path, body))
            if not provider.replies:
                return httpx.Response(500, json={"error": {"message": "no scripted reply"}})
            reply = provider.replies.pop(0)
            reply = reply(body) if callable(reply) else reply
            return reply if isinstance(reply, httpx.Response) else httpx.Response(200, json=reply)

        class CountClient:
            async def post(self, url, headers=None, json=None, timeout=None):
                provider.counts.append(json)
                value = provider.count_tokens(json) if callable(provider.count_tokens) else provider.count_tokens
                if isinstance(value, httpx.Response):
                    return value
                return httpx.Response(200, json={"input_tokens": value}, request=httpx.Request('POST', url))

        import litellm.llms.anthropic.count_tokens.handler as count_handler
        monkeypatch.setattr(httpx.HTTPTransport, 'handle_request', handle)
        monkeypatch.setattr(count_handler, 'get_async_httpx_client', lambda **k: CountClient())

    def messages(self):
        return [b for p, b in self.sends if p == '/v1/messages']


def claude(content, stop='end_turn', usage=(100, 50)):
    return {"id": "m", "type": "message", "role": "assistant", "model": MODEL, "stop_reason": stop,
            "content": content, "usage": {"input_tokens": usage[0], "output_tokens": usage[1]}}


def tool_use(name, args, call_id='toolu_1'):
    return claude([{"type": "thinking", "thinking": "plan", "signature": "sig"},
                   {"type": "tool_use", "id": call_id, "name": name, "input": args}], stop='tool_use')


def answer(obj):
    return claude([{"type": "text", "text": json.dumps(obj)}])


def note(reason='no effect on the summary'):
    """A map call's reply for one diff page."""
    return answer({'changes': [], 'questions': [], 'no_summary_change_reason': reason})


def spooled_pages(repo, base, target, base_snap, target_snap, changes, exclusions, tmp_path):
    """The filtered pages of an update: (the text of every page, the paths recorded as omitted)."""
    import tempfile
    pages = snap.prepare_pages(repo.path, base, target, base_snap.manifest(), target_snap.manifest(), changes, exclusions,
                               tempfile.mkdtemp(dir=tmp_path))
    return ''.join(pages.read(p) for p in pages.diff_pages), {path for path, _why in pages.omitted}


class Repo:
    def __init__(self, path):
        self.path = path
        path.mkdir(parents=True, exist_ok=True)
        self.git('init', '-q', '-b', 'main')
        self.git('config', 'user.email', 't@example.com')
        self.git('config', 'user.name', 't')

    def git(self, *args):
        return subprocess.run(['git', *args], cwd=self.path, check=True, capture_output=True, text=True).stdout.strip()

    def write(self, rel, text):
        target = self.path / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def commit(self, message='change'):
        self.git('add', '-A')
        self.git('commit', '-q', '-m', message)
        return self.git('rev-parse', 'HEAD')


ANALYSIS = ("## Overview\nA payments API.\n\n## Key Components\n- src/m0.py: the entry point\n- src/m1.py: helpers\n\n"
            "## Database Schema\nUntouched schema text, kept byte for byte.\n\n## Configuration\nPORT and DB_URL.\n")


def legacy_document(cache_name, commit, updated, analysis=ANALYSIS):
    """A document exactly as the full generator writes one."""
    return f"""---
repo_name: app
full_name: {FULL}
cache_dir: {cache_name}
clone_url: https://github.com/o/app.git
last_commit: {commit}
last_updated: {updated.isoformat()}
brief: A payments API.
type: API Service
language: Python
framework: None
database: Postgres
apis: REST
port: 8080
related_repos: []
parse_status: ok
---

# Repository: {FULL}

## Quick Reference

| Property | Value |
|----------|-------|
| **Type** | API Service |
| **Language** | Python |
| **Database** | Postgres |
| **APIs Exposed** | REST |
| **Port** | 8080 |
| **Key Dependencies** | Stripe |

---

{analysis}
"""


def source_repo(tmp_path, files=10, size=1000):
    repo = Repo(tmp_path / 'pristine' / 'app-abc1234')
    for i in range(files):
        repo.write(f'src/m{i}.py', f'# module {i}\n' + 'x = 1\n' * ((size - 12) // 6))
    return repo, repo.commit('base')


@pytest.mark.parametrize('origin, owed', [(im.WEEKLY_REASON, False), ('regeneration requested', True)])
def test_weekly_rebuild_debt_follows_the_current_interval(monkeypatch, tmp_path, origin, owed):
    """A weekly rebuild that failed stays on record, but after the interval is raised from 7 to 30 days it is
    due only when the 30-day rule is, counted from the last successful full build; a forced one stays owed."""
    repo, _base, pristine = setup_pristine(monkeypatch, tmp_path, updated=NOW - timedelta(days=8))
    doc = im.load_document(pristine, 'app-abc1234')
    adopt = decide(repo, pristine).adopt
    failed = {'strategy': 'full', 'status': 'failed', 'decision_reason': origin, 'full_rebuild_origin': origin,
              'baseline_doc_sha256': doc.sha256, 'reason': 'turn limit', 'adoption': adopt,
              'finished_at': (NOW - timedelta(hours=1)).isoformat(), 'usage': {'known_cost_usd': 1.5},
              'consecutive_failures': 1, im.FAILURE_STREAK_DOC: doc.sha256}
    im.write_state(pristine, 'app-abc1234', failed)
    thirty = {'full_rebuild_days': 30}
    expect = lambda strategy: 'full' if owed else strategy

    # Unchanged source: nothing is due and nothing is bought; the failure, its usage and the streak stay.
    assert decide(repo, pristine, **thirty).strategy == expect('none')
    if not owed:
        with PreflightSession() as session:
            assert update(pristine, repo, session, full_rebuild_days=30,
                          run_full_fn=lambda *a, **k: pytest.fail('bought a rebuild')).status == 'none'
        assert metadata.read_attempt_state(pristine, 'app-abc1234') == failed

    # Changed source: an ordinary incremental update, which keeps the old attempt as evidence and the streak.
    repo.write('src/m0.py', 'changed = True\n')
    repo.commit('one change')
    assert decide(repo, pristine, **thirty).strategy == expect('incremental')
    started = {}

    def incremental(*a, **k):
        started.update(metadata.read_attempt_state(pristine, 'app-abc1234'))
        raise im.StaleUpdate('stopped by the test')
    if not owed:
        with PreflightSession() as session:
            update(pristine, repo, session, full_rebuild_days=30, run_incremental_fn=incremental,
                   run_full_fn=lambda *a, **k: pytest.fail('bought a rebuild'))
        assert started['strategy'] == 'incremental' and started['consecutive_failures'] == 1
        assert started['dropped_full_attempt']['reason'] == 'turn limit'
        im.write_state(pristine, 'app-abc1234', failed)

    # On the 30-day date, counted from the last full build, the rebuild is owed again.
    assert decide(repo, pristine, now=NOW + timedelta(days=21, hours=23), **thirty).strategy == expect('incremental')
    assert decide(repo, pristine, now=NOW + timedelta(days=22), **thirty).reason == im.UNFINISHED_REASON


def setup_pristine(monkeypatch, tmp_path, updated=NOW - timedelta(days=1), files=10):
    repo, base = source_repo(tmp_path, files)
    pristine = tmp_path / 'pristine'
    (pristine / 'app-abc1234.md').write_text(legacy_document('app-abc1234', base, updated))
    for module in (metadata, S):
        monkeypatch.setattr(module, 'PRISTINE_DIR', pristine)
    monkeypatch.setattr(metadata, 'INDEX_FILE', pristine / 'INDEX.md')
    return repo, base, pristine


def decide(repo, pristine, now=NOW, model=MODEL, force=False, **kw):
    doc = im.load_document(pristine, 'app-abc1234')
    state = metadata.read_attempt_state(pristine, 'app-abc1234')
    return im.decide(repo.path, FULL, doc, state, model, snap.resolve_commit(repo.path, 'HEAD'), now, force=force, **kw)


REPO_CONFIG = {'full_name': FULL, 'clone_url': 'https://github.com/o/app.git'}


def update(pristine, repo, session, **kw):
    return im.update_repository(pristine, repo.path, 'app-abc1234', REPO_CONFIG, MODEL, session, now=NOW, **kw)


# ── 1. Opt-in and scheduling ─────────────────────────────────────────────────────────────────────

def _sync_args(**over):
    base = dict(command='sync', dry_run=False, force=False, metadata_only=False, repos_only=False,
                regenerate_metadata=False, skip_metadata=False, status_server=False, version=False)
    base.update(over)
    return types.SimpleNamespace(**base)


def _ctx():
    events = []
    progress = types.SimpleNamespace(update=lambda *a, **k: events.append(('progress', k.get('status'))))
    logger = types.SimpleNamespace(event=lambda name, **f: events.append((name, f)), error=lambda *a, **k: None)
    stats = {'metadata_generated': 0, 'api_cost': 0.0, 'errors': 0, 'skipped': 0, 'degraded': 0}
    ctx = S.SyncContext(progress, {FULL: (1, 'cyan')}, stats, threading.Lock(), logger,
                        types.SimpleNamespace(print=lambda *a, **k: None))
    return ctx, events


def sync_fixture(monkeypatch, tmp_path, repo):
    """Point sync_mode at `repo` through a bare origin that is one commit ahead, with the opt-in set.
    Returns (origin, config, events): events records Activity events and status-server posts."""
    origin = tmp_path / 'origin.git'
    subprocess.run(['git', 'clone', '-q', '--bare', str(repo.path), str(origin)], check=True)
    repo.git('remote', 'add', 'origin', str(origin))
    repo.git('fetch', '-q', 'origin')
    repo.git('branch', '-q', '--set-upstream-to=origin/main', 'main')
    repo.write('src/m5.py', (repo.path / 'src/m5.py').read_text() + '# upstream\n')
    repo.commit('upstream')
    repo.git('push', '-q', 'origin', 'main')
    repo.git('reset', '-q', '--hard', 'HEAD~1')
    config = {'repositories': [{'full_name': FULL, 'clone_url': str(origin), 'default_branch': 'main'}],
              'incremental_metadata_repos': [FULL]}
    events = []

    class Logger:
        def event(self, name, **fields):
            events.append((name, fields))

        def __getattr__(self, name):
            return lambda *a, **k: events.append((name, k))

    monkeypatch.setattr(S, 'CONFIG_DIR', tmp_path / 'config')
    monkeypatch.setattr(S, 'load_config', lambda: config)
    monkeypatch.setattr(S, 'load_cache_index', lambda: {str(origin): 'app-abc1234'})
    monkeypatch.setattr(S, 'save_cache_index', lambda index: True)
    monkeypatch.setattr(S, '_open_sync_logger', lambda: Logger())
    monkeypatch.setattr(S, '_mint_activity_writer', lambda: None)
    monkeypatch.setattr(S, 'wait_for_network', lambda **kw: True)
    monkeypatch.setattr(S, 'write_receipt', lambda *a, **k: True)
    monkeypatch.setattr(S, 'send_status_update', lambda kind, data, server: events.append((kind, data)))
    return origin, config, events


def test_opt_in_dispatch_and_rebuild_selection(monkeypatch, tmp_path):
    repo, base, pristine = setup_pristine(monkeypatch, tmp_path)
    ctx, _events = _ctx()
    task = (REPO_CONFIG, 'app-abc1234', base, 'app', 'cyan', 1)
    calls = []
    real_update = im.update_repository
    monkeypatch.setattr(im, 'update_repository', lambda *a, **k: calls.append(k['allow_incremental']) or
                        im.Outcome('none', 'none', 'unchanged', base, base, {}, 0.0))

    # Every repository takes the one shared worker; only an opted-in one may update from a diff.
    S.generate_repo_metadata(task, None, _sync_args(), ctx)
    S.generate_repo_metadata(task, None, _sync_args(_incremental_repos=frozenset({FULL})), ctx)
    assert calls == [False, True]
    monkeypatch.setattr(im, 'update_repository', real_update)

    # Full-only: a healthy legacy document at the same tree is adopted with nothing bought, even when it is
    # old enough for a weekly rebuild; a changed tree is rebuilt in full, without listing a diff.
    repo, base, pristine = setup_pristine(monkeypatch, tmp_path / 'full-only', updated=NOW - timedelta(days=30))
    with monkeypatch.context() as m:
        m.setattr(snap, 'changes_between', lambda *a, **k: pytest.fail('a full-only decision listed a diff'))
        d = decide(repo, pristine, allow_incremental=False)
        assert (d.strategy, d.adopt['configured_model']) == ('none', MODEL)
        repo.write('src/m0.py', 'changed = True\n')
        repo.commit('one change')
        d = decide(repo, pristine, allow_incremental=False)
        assert (d.strategy, d.reason) == ('full', 'the tracked tree changed')

    # Its rebuild publishes through the common path, which keeps the <repo>.md alias.
    seen = {}

    def built(*a, estimate_allowance, **k):
        seen['estimate'] = estimate_allowance
        doc = im.load_document(pristine, 'app-abc1234')
        return im.Candidate('## Overview\nRebuilt.\n', im.current_fields(doc), None, [], 0, snap.NO_EXCLUSIONS)
    with PreflightSession() as session:
        rebuilt = update(pristine, repo, session, allow_incremental=False, run_full_fn=built)
    assert (rebuilt.status, rebuilt.strategy, seen['estimate']) == ('published', 'full', True), rebuilt
    alias = pristine / 'app.md'
    assert alias.is_symlink() and os.readlink(alias) == 'app-abc1234.md' and 'Rebuilt.' in alias.read_text()
    repo, base, pristine = setup_pristine(monkeypatch, tmp_path / 'b')

    # The legacy document is adopted (no paid bootstrap); an unchanged tree needs nothing.
    d = decide(repo, pristine)
    assert (d.strategy, d.adopt['configured_model'], d.full_built_at) == ('none', MODEL, NOW - timedelta(days=1))

    def grow(paths, text='# changed\n'):
        for p in paths:
            repo.write(p, (repo.path / p).read_text() + text)

    def edit_in_place(paths):  # same size, so the byte weight doesn't move
        for p in paths:
            repo.write(p, (repo.path / p).read_text().replace('x = 1', 'x = 2', 1))

    # How much changed never selects a full rebuild; the fraction is only a diagnostic.
    edit_in_place(['src/m0.py'])
    repo.commit()
    assert decide(repo, pristine).strategy == 'incremental'
    edit_in_place([f'src/m{i}.py' for i in range(1, 9)])
    repo.commit()
    d = decide(repo, pristine)
    assert (d.change.file_fraction, d.strategy) == (0.9, 'incremental')

    # An unfinished full rebuild chosen only by a removed size rule isn't owed, and its failure stays on
    # record while the new path runs; a requested one still is.
    doc = im.load_document(pristine, 'app-abc1234')
    for reason, due in (('35 diff pages exceeds 8', False), ('31% of the source changed', False),
                        ('diff exceeds the incremental size limit', False), ('regeneration requested', True)):
        im.write_state(pristine, 'app-abc1234', {'strategy': 'full', 'status': 'failed', 'decision_reason': reason,
                                                 'baseline_doc_sha256': doc.sha256, 'reason': 'turn limit',
                                                 'adoption': d.adopt})
        assert decide(repo, pristine).strategy == ('full' if due else 'incremental'), reason
    Provider(monkeypatch).replies = []
    im.write_state(pristine, 'app-abc1234', {'strategy': 'full', 'status': 'failed', 'reason': 'turn limit',
                                             'decision_reason': '35 diff pages exceeds 8',
                                             'baseline_doc_sha256': doc.sha256, 'adoption': d.adopt})
    with PreflightSession() as session:
        kept = update(pristine, repo, session)
    state = metadata.read_attempt_state(pristine, 'app-abc1234')
    assert (kept.strategy, state['dropped_full_attempt']['reason']) == ('incremental', 'turn limit')
    assert state['pipeline_version'] == im.PIPELINE_VERSION and 'full_rebuild_origin' not in state

    # Its origin survives retries, whose own reason is generic. A size-triggered retry from 1.0.36 has no
    # recoverable origin, so it owes nothing and the current rules decide; a forced one stays owed.
    generic = {'strategy': 'full', 'status': 'failed', 'decision_reason': im.UNFINISHED_REASON,
               'baseline_doc_sha256': doc.sha256, 'adoption': d.adopt}
    for extra, due in (({}, False), ({'full_rebuild_origin': '35 diff pages exceeds 8'}, False),
                       ({'full_rebuild_origin': 'regeneration requested'}, True)):
        im.write_state(pristine, 'app-abc1234', {**generic, **extra})
        assert decide(repo, pristine).strategy == ('full' if due else 'incremental'), extra
    im.write_state(pristine, 'app-abc1234', {**generic, 'full_rebuild_origin': im.WEEKLY_REASON})
    assert decide(repo, pristine).strategy == 'incremental'   # weekly debt waits for the weekly date
    assert decide(repo, pristine, now=NOW + timedelta(days=6)).reason == im.UNFINISHED_REASON
    assert decide(repo, pristine, now=NOW + timedelta(days=6), full_rebuild_days=0).strategy == 'incremental'

    # Consecutive real failures: the weekly origin survives a retry, and a setup failure keeps it on record.
    (pristine / '.metadata-state' / 'app-abc1234.json').unlink()
    later = NOW + timedelta(days=8)
    for reason in (im.WEEKLY_REASON, im.UNFINISHED_REASON):
        with PreflightSession() as session:
            failed = im.update_repository(pristine, repo.path, 'app-abc1234', REPO_CONFIG, MODEL, session, now=later)
        state = metadata.read_attempt_state(pristine, 'app-abc1234')
        assert failed.status == 'failed' and state['decision_reason'] == reason
        assert state['full_rebuild_origin'] == im.WEEKLY_REASON
    im.record_failure(pristine, 'app-abc1234', FULL, 'setup broke')
    assert metadata.read_attempt_state(pristine, 'app-abc1234')['full_rebuild_origin'] == im.WEEKLY_REASON
    assert decide(repo, pristine, full_rebuild_days=0).strategy == 'incremental'
    (pristine / '.metadata-state' / 'app-abc1234.json').unlink()

    # A deletion and a file crossing the 100 KiB ceiling both count as changed eligible source.
    repo.git('reset', '-q', '--hard', base)
    (repo.path / 'src/m3.py').unlink()
    repo.write('src/m4.py', 'y = 2\n' * 20000)
    repo.commit()
    d = decide(repo, pristine)
    assert (d.change.changed_files, d.change.eligible_files, d.strategy) == (2, 10, 'incremental')

    # Weekly rebuild on an unchanged HEAD; explicit force; a changed configured model.
    repo.git('reset', '-q', '--hard', base)
    assert decide(repo, pristine, now=NOW + timedelta(days=5, hours=23)).strategy == 'none'
    assert decide(repo, pristine, now=NOW + timedelta(days=6)).reason == 'weekly full rebuild due'
    # The setting: another age, or 0 for none, which also drops a weekly rebuild that didn't finish.
    assert decide(repo, pristine, now=NOW + timedelta(days=2), full_rebuild_days=3).reason == 'weekly full rebuild due'
    assert decide(repo, pristine, now=NOW + timedelta(days=400), full_rebuild_days=0).strategy == 'none'
    assert repo_config.incremental_full_rebuild_days({}) == 7
    assert repo_config.incremental_full_rebuild_days({'incremental_full_rebuild_days': 0}) == 0
    for bad in (-1, True, '7', 1.5):
        with pytest.raises(ValueError):
            repo_config.incremental_full_rebuild_days({'incremental_full_rebuild_days': bad})
    assert decide(repo, pristine, force=True).strategy == 'full'
    metadata_state = {'adoption': decide(repo, pristine).adopt}
    im.write_state(pristine, 'app-abc1234', metadata_state)
    assert decide(repo, pristine, model='claude-opus-5-5').reason == 'configured model changed'

    # --skip-metadata, --repos-only and --dry-run: no provider calls and no attempt state.
    provider = Provider(monkeypatch)
    origin, config, _sync_events = sync_fixture(monkeypatch, tmp_path, repo)
    (pristine / '.metadata-state' / 'app-abc1234.json').unlink()
    before = (pristine / 'app-abc1234.md').read_text()
    for flags in ({'skip_metadata': True}, {'repos_only': True}, {'dry_run': True}):
        S.sync_mode(_sync_args(**flags))
        assert not provider.sends and not provider.counts, flags
        assert not (pristine / '.metadata-state' / 'app-abc1234.json').exists(), flags
        assert (pristine / 'app-abc1234.md').read_text() == before

    # A normal sync takes the real dispatch: fetch, decide, update incrementally, publish, index.
    doc = im.load_document(pristine, 'app-abc1234')
    provider.replies = [note(), answer({'base_document_sha256': doc.sha256, 'sections': []})]
    assert S.sync_mode(_sync_args()) == 0
    new = im.load_document(pristine, 'app-abc1234')
    assert new.info['last_commit'] == repo.git('rev-parse', 'origin/main') and new.info['generation_strategy'] == 'incremental'
    assert len(provider.messages()) == 2
    assert 'stale' not in (pristine / 'INDEX.md').read_text()

    # A malformed opt-in list is refused before any work.
    config['incremental_metadata_repos'] = ['o/*']
    assert S.sync_mode(_sync_args()) == 1

    # Two failed updates in a row hold a scheduled sync, through the real dispatch and its trigger, with no
    # model call even when a weekly rebuild is due. A person retries, and only a publication clears it.
    repo, base, pristine = setup_pristine(monkeypatch, tmp_path / 'held')
    repo.write('src/m0.py', '# changed\n')
    target = repo.commit()
    provider = Provider(monkeypatch)
    kept = (pristine / 'app-abc1234.md').read_text()
    boom = httpx.Response(500, json={"error": {"message": "boom"}})

    def dispatched(trigger, **flags):
        monkeypatch.setenv('REPO_RADAR_TRIGGER', trigger)
        provider.sends.clear(); provider.counts.clear()
        ctx, events = _ctx()
        with PreflightSession() as session:
            S.generate_repo_metadata((REPO_CONFIG, 'app-abc1234', None, 'app', 'cyan', 1), session,
                                     _sync_args(_incremental_repos=frozenset({FULL}), **flags), ctx)
        return ctx, [f for name, f in events if name == 'metadata_incremental'][0]

    def failures():
        return metadata.read_attempt_state(pristine, 'app-abc1234')['consecutive_failures']

    for count in (1, 2):
        provider.replies = [boom]
        ctx, event = dispatched('scheduled')
        assert (event['status'], ctx.stats['errors'], failures()) == ('failed', 1, count) and provider.sends
    last_usage = metadata.read_attempt_state(pristine, 'app-abc1234')['usage']
    for trigger in ('scheduled', 'catchup', 'cli'):
        ctx, event = dispatched(trigger)
        assert (event['status'], event['level'], ctx.stats['skipped'], ctx.stats['errors']) == ('skipped', 'warn', 1, 0)
        assert 'held after 2 failed updates' in event['reason'] and not provider.sends and not provider.counts
    state = metadata.read_attempt_state(pristine, 'app-abc1234')
    assert (state['status'], state['usage'], failures()) == ('skipped', last_usage, 2) and state['last_failure_reason']
    assert (pristine / 'app-abc1234.md').read_text() == kept
    metadata.regenerate_index(types.SimpleNamespace(dry_run=False))
    assert 'held after 2 failed updates' in (pristine / 'INDEX.md').read_text()
    assert 'held after 2' in S._dry_run_decision(repo.path, 'app-abc1234', FULL, _sync_args())
    # A setup failure rewrites the attempt's baseline hash, here to nothing, without detaching the count: once
    # the document is readable again the sync is still held. Neither makes a model call.
    (pristine / 'app-abc1234.md').write_bytes(b'\xff' + kept.encode())
    ctx, event = dispatched('scheduled')
    assert event['status'] == 'failed' and not provider.sends and not provider.counts and failures() == 2
    assert metadata.read_attempt_state(pristine, 'app-abc1234')['baseline_doc_sha256'] is None
    (pristine / 'app-abc1234.md').write_text(kept)
    ctx, event = dispatched('scheduled')
    assert event['status'] == 'skipped' and 'held after 2' in event['reason'] and not provider.sends and not provider.counts
    monkeypatch.setenv('REPO_RADAR_TRIGGER', 'scheduled')
    with PreflightSession() as session:   # a weekly rebuild being due changes nothing
        weekly = im.update_repository(pristine, repo.path, 'app-abc1234', REPO_CONFIG, MODEL, session,
                                      now=NOW + timedelta(days=30), trigger='scheduled')
    assert weekly.status == 'skipped' and weekly.strategy == 'full' and not provider.sends and not provider.counts

    # A manual sync that fails again leaves it held. A forced rebuild also gets through, and a skip doesn't count.
    provider.replies = [boom]
    _ctx_manual, event = dispatched('manual')
    assert event['status'] == 'failed' and provider.sends and failures() == 3
    assert dispatched('scheduled')[1]['status'] == 'skipped' and not provider.sends
    provider.count_tokens = lambda body: httpx.Response(503, json={}, request=httpx.Request('POST', 'https://x'))
    assert dispatched('manual')[1]['status'] == 'skipped' and failures() == 3
    provider.count_tokens = 1000
    provider.replies = [boom]
    assert dispatched('scheduled', regenerate_metadata=True)[1]['status'] == 'failed' and provider.sends and failures() == 4

    # The next manual success publishes, resets the count, and scheduled syncs spend again.
    provider.replies = [claude([{"type": "text", "text": FULL_REPLY}])]   # the forced rebuild it still owes
    assert dispatched('manual')[1]['status'] == 'published' and provider.sends and failures() == 0
    assert 'last_failure_reason' not in metadata.read_attempt_state(pristine, 'app-abc1234')
    repo.write('src/m1.py', '# more\n')
    repo.commit()
    doc = im.load_document(pristine, 'app-abc1234')
    provider.replies = [note(), answer({'base_document_sha256': doc.sha256, 'sections': []})]
    assert dispatched('scheduled')[1]['status'] == 'published' and provider.sends and failures() == 0
    assert doc.info['last_commit'] == target

    # A document replaced some other way starts the count again, even when a setup failure has already bound
    # the attempt's baseline hash to it: the old count must not hold the new document.
    repo.write('src/m2.py', '# and more\n')
    repo.commit()
    for count in (1, 2):
        provider.replies = [boom]
        assert dispatched('scheduled')[1]['status'] == 'failed' and failures() == count
    held_doc = im.load_document(pristine, 'app-abc1234')
    state = metadata.read_attempt_state(pristine, 'app-abc1234')
    assert im.consecutive_failures(state, None) == 2, 'a missing document is no reason to buy another rebuild'
    # While the held document is away, a manual retry that fails or is skipped keeps the streak on it, so
    # when the same document comes back a scheduled sync is still held.
    (pristine / 'app-abc1234.md').rename(tmp_path / 'held-away.md')
    provider.replies = [boom]
    assert dispatched('manual')[1]['status'] == 'failed' and provider.sends and failures() == 3
    provider.count_tokens = lambda body: httpx.Response(503, json={}, request=httpx.Request('POST', 'https://x'))
    assert dispatched('manual')[1]['status'] == 'skipped' and failures() == 3
    provider.count_tokens = 1000
    assert metadata.read_attempt_state(pristine, 'app-abc1234')[im.FAILURE_STREAK_DOC] == held_doc.sha256
    (tmp_path / 'held-away.md').rename(pristine / 'app-abc1234.md')
    ctx, event = dispatched('scheduled')
    assert event['status'] == 'skipped' and 'held after 3' in event['reason'] and not provider.sends and not provider.counts
    (pristine / 'app-abc1234.md').write_text(held_doc.text + '\nReplaced some other way.\n')
    im.record_failure(pristine, 'app-abc1234', FULL, 'setup broke')
    replaced = im.load_document(pristine, 'app-abc1234')
    state = metadata.read_attempt_state(pristine, 'app-abc1234')
    assert (state['baseline_doc_sha256'], state['consecutive_failures']) == (replaced.sha256, 3)
    assert im.consecutive_failures(state, replaced) == 0
    provider.replies = [boom]
    assert dispatched('scheduled')[1]['status'] == 'failed' and provider.sends and failures() == 1
    monkeypatch.delenv('REPO_RADAR_TRIGGER')

    # A requested full rebuild that never published stays due on an unchanged, recent commit: after a
    # transient count skip, or an interruption after 'committing' but before the replacement. Once
    # the replacement is in place under that generation, it isn't bought again.
    repo, base, pristine = setup_pristine(monkeypatch, tmp_path / 'unfinished')
    provider = Provider(monkeypatch)
    assert decide(repo, pristine).strategy == 'none'
    provider.count_tokens = lambda body: httpx.Response(503, json={}, request=httpx.Request('POST', 'https://x'))
    with PreflightSession() as session:
        assert update(pristine, repo, session, force=True).status == 'skipped'
    assert decide(repo, pristine).reason == 'previous full rebuild did not finish'
    provider.count_tokens = 1000
    provider.replies = [claude([{"type": "text", "text": FULL_REPLY}])]
    real_atomic = metadata.write_text_atomic
    monkeypatch.setattr(metadata, 'write_text_atomic', lambda *a: (_ for _ in ()).throw(KeyboardInterrupt()))
    with PreflightSession() as session, pytest.raises(KeyboardInterrupt):
        update(pristine, repo, session)
    assert metadata.read_attempt_state(pristine, 'app-abc1234')['status'] == 'committing'
    assert decide(repo, pristine).reason == 'previous full rebuild did not finish'
    monkeypatch.setattr(metadata, 'write_text_atomic', real_atomic)
    real_write_state = im.write_state
    monkeypatch.setattr(im, 'write_state', lambda p, c, st: (_ for _ in ()).throw(KeyboardInterrupt())
                        if st.get('status') == 'published' else real_write_state(p, c, st))
    provider.replies = [claude([{"type": "text", "text": FULL_REPLY}])]
    with PreflightSession() as session, pytest.raises(KeyboardInterrupt):
        update(pristine, repo, session)
    state = metadata.read_attempt_state(pristine, 'app-abc1234')
    assert state['full_rebuild_origin'] == 'regeneration requested', 'still owed after more than one failure'
    assert state['status'] == 'committing' and state['generation_id'] == im.load_document(pristine, 'app-abc1234').info['generation_id']
    assert im.document_exclusions(im.load_document(pristine, 'app-abc1234')) == snap.NO_EXCLUSIONS   # committed with it
    assert decide(repo, pristine).strategy == 'none'

    # A later fetch failure is a new attempt from the committed document: no inherited generation ID
    # or full-rebuild obligation, and INDEX shows it stale.
    monkeypatch.setattr(im, 'write_state', real_write_state)
    committed = im.load_document(pristine, 'app-abc1234')
    S._record_incremental_git_failure(_sync_args(_incremental_repos=frozenset({FULL})), FULL, 'app-abc1234', 'fetch', None)
    failed = metadata.read_attempt_state(pristine, 'app-abc1234')
    assert failed['attempt_id'] != state['attempt_id'] and failed['baseline_doc_sha256'] == committed.sha256
    assert failed['generation_id'] is None and failed['strategy'] is None and failed['status'] == 'failed'
    assert not im._unfinished_full(failed, committed) and decide(repo, pristine).strategy == 'none'
    metadata.regenerate_index(types.SimpleNamespace(dry_run=False))
    assert 'stale: analyzed' in (pristine / 'INDEX.md').read_text() and 'fetch failed' in (pristine / 'INDEX.md').read_text()


def test_settings_spending_limits_bound_the_next_sync(monkeypatch, tmp_path, capsys):
    """The Settings update limit and failure stop are read by the next sync. Bad values fall back to $12 and
    2, never to no limit, and a missing API key fails visibly without moving the streak toward a hold."""
    policy = repo_config.incremental_spending_policy
    assert policy({}) == (12.0, 2, ()) and policy(None) == (12.0, 2, ())
    assert policy({'incremental_update_limit_usd': 12.5, 'incremental_failure_stop': 10}) == (12.5, 10, ())
    assert policy({'incremental_update_limit_usd': 1, 'incremental_failure_stop': 1.0})[:2] == (1.0, 1)
    assert policy({'incremental_update_limit_usd': 99.99})[0] == 99.99
    for bad in (0, 0.5, 100.01, 12.345, 12.000000001, -3, True, '12', None, float('nan'), float('inf'),
                int('9' * 400)):   # too big for a float: out of range, not an OverflowError that stops the sync
        assert policy({'incremental_update_limit_usd': bad}) == (12.0, 2, ('incremental_update_limit_usd',)), bad
    for bad in (0, 11, 1.5, True, '2', None, float('nan')):
        assert policy({'incremental_failure_stop': bad}) == (12.0, 2, ('incremental_failure_stop',)), bad

    repo, _base, pristine = setup_pristine(monkeypatch, tmp_path)
    provider = Provider(monkeypatch)
    _origin, config, events = sync_fixture(monkeypatch, tmp_path, repo)
    kept = (pristine / 'app-abc1234.md').read_text()

    def synced():
        provider.sends.clear(); provider.counts.clear(); events.clear()
        S.sync_mode(_sync_args())
        return [f for name, f in events if name == 'metadata_incremental'][-1]

    def failures():
        return metadata.read_attempt_state(pristine, 'app-abc1234')['consecutive_failures']

    # A saved $1 limit refuses this update's quote before any generation call and keeps the document.
    provider.count_tokens = lambda body: 150_000 if 'tools' not in body else 1000
    config['incremental_update_limit_usd'] = 1
    event = synced()
    assert event['status'] == 'skipped' and '$1.00 limit' in event['reason']
    assert provider.counts and not provider.messages() and (pristine / 'app-abc1234.md').read_text() == kept
    # Invalid or zero falls back to $12 with a warning naming only the field: this quote now fits, so it sends.
    config['incremental_update_limit_usd'] = 0
    doc = im.load_document(pristine, 'app-abc1234')
    provider.replies = [httpx.Response(500, json={"error": {"message": "boom"}})]
    event = synced()
    assert event['status'] == 'failed' and provider.messages() and failures() == 1
    out = capsys.readouterr().out
    assert 'Warning: incremental_update_limit_usd in the config is invalid; using its default' in ' '.join(out.split())

    # A failure stop of 1 holds the next automatic sync with zero calls; raising it to 3 releases it.
    config['incremental_failure_stop'] = 1
    event = synced()
    assert event['status'] == 'skipped' and 'held after 1 failed update' in event['reason']
    assert not provider.sends and not provider.counts
    assert 'held after 1' in S._dry_run_decision(repo.path, 'app-abc1234', FULL,
                                                  _sync_args(_incremental_policy=(12.0, 1)))
    # A missing API key fails visibly before any count or send and doesn't advance the streak.
    config['incremental_failure_stop'] = 3
    last = metadata.read_attempt_state(pristine, 'app-abc1234')['last_failure_reason']
    monkeypatch.delenv('ANTHROPIC_API_KEY')
    event = synced()
    state = metadata.read_attempt_state(pristine, 'app-abc1234')
    assert event['status'] == 'failed' and 'no API key' in event['reason'] and not provider.sends and not provider.counts
    assert (state['consecutive_failures'], state['last_failure_reason']) == (1, last)
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'test-not-a-key')
    # The higher limit, read by the next sync, lets the update through and it publishes.
    config['incremental_update_limit_usd'] = 50
    provider.replies = [note(), answer({'base_document_sha256': doc.sha256, 'sections': []})]
    event = synced()
    assert event['status'] == 'published' and len(provider.messages()) == 2 and failures() == 0


# ── 2. Pinned reads and section edits ────────────────────────────────────────────────────────────

def test_pinned_reads_confined_tools_and_section_edits(monkeypatch, tmp_path):
    repo, _first, pristine = setup_pristine(monkeypatch, tmp_path, files=20)
    repo.write('.env', 'SECRET=hunter2\n')
    repo.write('.env.example', 'SECRET=\n')
    repo.write('deploy/id_rsa', 'PRIVATE\n')
    repo.write('wide.txt', 'w' * 50000 + '\n')
    repo.write('many.py', 'needle = 1\n' * 20000)
    repo.write('hay.py', 'haystack\n' * 120000)   # more git grep output than one search reads
    repo.write('src/m0.py', '# haystack\n' + (repo.path / 'src/m0.py').read_text())
    (repo.path / 'link.py').symlink_to('src/m0.py')
    base = repo.commit('fixtures')
    (pristine / 'app-abc1234.md').write_text(legacy_document('app-abc1234', base, NOW - timedelta(days=1)))
    repo.git('mv', 'src/m1.py', 'src/helpers.py')
    (repo.path / 'src/m2.py').unlink()
    target = repo.commit('rename and delete')
    repo.write('src/m0.py', 'DIRTY WORKTREE\n')  # never seen: reads come from the pinned blobs

    base_snap, target_snap = snap.GitSnapshot(repo.path, base), snap.GitSnapshot(repo.path, target)
    tools = snap.SnapshotTools(base_snap, target_snap, snap.NO_EXCLUSIONS)
    assert 'DIRTY' not in tools.run('read_file', json.dumps({'path': 'src/m0.py', 'limit': 2}))
    for path in ('../etc/passwd', '/etc/passwd', 'src/../.env'):
        assert 'is not a tracked file' in tools.run('read_file', json.dumps({'path': path}))
    assert 'unavailable: symlink' in tools.run('read_file', '{"path": "link.py"}')
    assert 'unavailable: credential file' in tools.run('read_file', '{"path": ".env"}')
    assert 'unavailable: credential file' in tools.run('read_file', '{"path": "deploy/id_rsa"}')
    assert 'SECRET=' in tools.run('read_file', '{"path": ".env.example"}')
    assert 'hunter2' not in tools.run('search', '{"literal": "SECRET"}')
    assert 'line shortened from 50000' in tools.run('read_file', '{"path": "wide.txt"}')
    found = tools.run('search', '{"literal": "needle"}')
    assert len(found.encode()) <= snap.MAX_RESULT_BYTES and 'page 1 of' in found
    assert tools.run('search', '{"literal": "haystack"}').startswith('[too many matches')
    narrowed = tools.run('search', '{"literal": "haystack", "path_prefix": "src/m"}')
    assert 'src/m0.py:1: # haystack' in narrowed, narrowed
    # Below the path-count limit but over the argument-size limit (a multibyte name): asked to narrow,
    # and Git is never started.
    long_dir = repo.path / 'données'
    long_dir.mkdir()
    for i in range(3):
        (long_dir / (f'fichier-{i}-' + 'é' * 60 + '.py')).write_text('haystack\n')
    wide = snap.SnapshotTools(base_snap, snap.GitSnapshot(repo.path, repo.commit('wide names')), snap.NO_EXCLUSIONS)
    monkeypatch.setattr(snap, 'MAX_SEARCH_ARG_BYTES', 300)
    spawned = []
    real_run_git = snap.run_git
    monkeypatch.setattr(snap, 'run_git', lambda *a, **k: spawned.append(a) or real_run_git(*a, **k))
    wide.target.manifest()
    spawned.clear()
    assert 'use a narrower path_prefix' in wide.run('search', '{"literal": "haystack", "path_prefix": "donn"}')
    assert not spawned
    monkeypatch.setattr(snap, 'run_git', real_run_git)
    monkeypatch.setattr(snap, 'MAX_SEARCH_ARG_BYTES', 64 * 1024)
    repo.git('reset', '-q', '--hard', 'HEAD~1')
    with pytest.raises(snap.ToolRequestError):
        tools.run('run_shell', '{"cmd": "ls"}')

    # The update replaces one section and deletes another; the untouched section keeps its bytes.
    provider = Provider(monkeypatch)
    doc = im.load_document(pristine, 'app-abc1234')
    sections = {s.text.split('\n', 1)[0]: s for s in im.split_sections(im._analysis_of(doc))}
    overview, components, schema = sections['## Overview'], sections['## Key Components'], sections['## Database Schema']
    provider.replies = [note(), lambda body: answer({
        'base_document_sha256': doc.sha256,
        'sections': [{'op': 'replace', 'id': components.id, 'expected_sha256': components.sha256,
                      'content': '## Key Components\n- src/m0.py: the entry point\n- src/helpers.py: helpers (renamed from src/m1.py)\n'},
                     {'op': 'delete', 'id': overview.id, 'expected_sha256': overview.sha256}],
        'fields': {'quick_reference': {'apis': 'REST, webhooks'}}})]
    with PreflightSession() as session:
        outcome = update(pristine, repo, session)
        assert outcome.status == 'published', outcome
        new = im.load_document(pristine, 'app-abc1234')
        assert schema.text in new.text and 'renamed from src/m1.py' in new.text and '## Overview' not in new.text
        assert (new.info['last_commit'], new.info['generation_strategy'], new.info['base_commit']) == (target, 'incremental', base)
        assert new.info['full_build_at'] == (NOW - timedelta(days=1)).isoformat() and new.info['apis'] == 'REST, webhooks'
        assert new.info['full_build_model'] == 'unknown'

    # Fences: a four-backtick block showing a three-backtick example, and a tilde block, stay code.
    fenced = ("## Usage\n````md\n```\n## not a heading\n```\n````\n~~~\n```\n## also code\n~~~\n## Next\nafter\n")
    parts = im.split_sections(fenced)
    assert [p.text.split('\n', 1)[0] for p in parts] == ['## Usage', '## Next'] and ''.join(p.text for p in parts) == fenced
    with pytest.raises(im.PatchError, match='fence open'):
        im.apply_patch(parts, {}, {'base_document_sha256': 'h', 'sections': [
            {'op': 'replace', 'id': parts[0].id, 'expected_sha256': parts[0].sha256,
             'content': '## Usage\n```\nunclosed\n## Next\n'}]}, 'h')

    # Edits against a hash the section doesn't have can't publish, and an oversized model-chosen id
    # never reaches saved state or the reason unbounded. Both updates really run.
    repo.write('src/m3.py', 'z = 3\n')
    repo.commit()
    stale = im.split_sections(im._analysis_of(new))[1]
    sent = len(provider.messages())
    with PreflightSession() as session:
        provider.replies = [note(), answer({'base_document_sha256': new.sha256, 'sections': [
            {'op': 'replace', 'id': stale.id, 'expected_sha256': '0' * 16, 'content': '## Key Components\nwrong\n'}]})]
        failed = update(pristine, repo, session)
        assert failed.status == 'failed' and 'expected_sha256' in failed.reason and not provider.replies
        assert im.load_document(pristine, 'app-abc1234').text == new.text
        provider.replies = [note(), answer({'base_document_sha256': new.sha256, 'sections': [
            {'op': 'delete', 'id': 'x\n' * 3000, 'expected_sha256': stale.sha256}]})]
        huge = update(pristine, repo, session)
        assert not provider.replies and len(provider.messages()) == sent + 4
    saved = metadata.read_attempt_state(pristine, 'app-abc1234')['reason']
    assert huge.status == 'failed' and len(huge.reason) <= 240 and saved == huge.reason and '\n' not in saved
    assert im.load_document(pristine, 'app-abc1234').text == new.text


FULL_REPLY = ("QUICK_REFERENCE_START\nType: API Service\nLanguage: Python\nFramework: None\nDatabase: None\n"
              "APIs: REST\nPort: N/A\nDependencies: Stripe\nQUICK_REFERENCE_END\nONE_LINE_SUMMARY_START\n"
              "A rebuilt API.\nONE_LINE_SUMMARY_END\nRELATED_REPOS_START\nRELATED_REPOS_END\n## Overview\nFresh.\n")


def test_one_exclusion_policy_for_full_builds_tools_and_diffs(monkeypatch, tmp_path):
    repo, base, pristine = setup_pristine(monkeypatch, tmp_path, files=20)
    secrets = {'.env.production.sh': 'export TOKEN=SENTINEL-ENV\n',
               '.envrc': 'export A=SENTINEL-RC\n' + ''.join(f'export V{i}={i}\n' for i in range(20)),
               '.pgpass': 'db:5432:*:u:SENTINEL-PG\n', '.htpasswd': 'u:SENTINEL-HT\n', '.boto': 'k=SENTINEL-BOTO\n',
               '.s3cfg': 'secret_key=SENTINEL-S3\n', 'keys/apns.p8': 'SENTINEL-P8\n', 'keys/putty.ppk': 'SENTINEL-PPK\n',
               'vault.kdbx': 'SENTINEL-KDBX\n'}
    for path, text in secrets.items():
        repo.write(path, text)
    (repo.path / 'src/blob.py').write_bytes(b'\0\x01SENTINEL-BIN binary payload')   # eligible extension, binary
    repo.write('.env.example', 'EXAMPLE_VAR=\n')
    repo.write('src/app.py', 'def handler():\n    return "safe source"\n')
    repo.write('.env', '')               # an empty credential shares its blob ID with every empty file,
    repo.write('src/__init__.py', '')    # which must not make this ordinary empty file a credential
    repo.commit('secrets and source')
    provider = Provider(monkeypatch)
    provider.replies = [claude([{"type": "text", "text": FULL_REPLY}])]
    with PreflightSession() as session:
        outcome = update(pristine, repo, session, force=True)
    assert outcome.status == 'published', outcome
    assert provider.messages()[0]['output_config'] == {'effort': 'medium'}   # other providers keep their options
    assert 'reasoning_effort' not in provider.messages()[0]
    traffic = json.dumps([b for _p, b in provider.sends]) + json.dumps(provider.counts)
    assert 'SENTINEL' not in traffic, 'no credential or binary content reaches the provider'
    assert 'safe source' in traffic and 'EXAMPLE_VAR=' in traffic
    doc = im.load_document(pristine, 'app-abc1234')
    assert doc.info['coverage'].startswith('collector-selected source analyzed; 2 files withheld (binary file, credential file)')
    assert "outside the collector's selection" in doc.info['coverage'] and 'complete' not in doc.info['coverage']
    assert 'src/__init__.py' in traffic
    assert {'.envrc', '.env'} <= im.document_exclusions(doc).paths   # identities only, published with A

    # The read tools, search and the diff apply the same policy, including a credential renamed
    # unchanged to an ordinary, collector-eligible path.
    repo.write('.env.production.sh', 'export TOKEN=SENTINEL-ENV2\n')
    repo.git('mv', '.envrc', 'src/runtime.py')
    target = repo.commit('change secrets')
    base_snap, target_snap = snap.GitSnapshot(repo.path, doc.info['last_commit']), snap.GitSnapshot(repo.path, target)
    changes = snap.changes_between(repo.path, doc.info['last_commit'], target)
    effective = snap.credential_exclusions(im.document_exclusions(doc), base_snap.manifest(), target_snap.manifest(), changes)
    tools = snap.SnapshotTools(base_snap, target_snap, effective)
    for path in [p for p in secrets if p != '.envrc'] + ['src/runtime.py']:
        assert 'unavailable: credential file' in tools.run('read_file', json.dumps({'path': path}))
    assert 'unavailable: binary file' in tools.run('read_file', '{"path": "src/blob.py"}')
    assert 'unavailable' not in tools.run('read_file', '{"path": "src/__init__.py"}')
    assert tools.run('search', '{"literal": "SENTINEL"}') == '[no matches]'
    pages, omitted = spooled_pages(repo, doc.info['last_commit'], target, base_snap, target_snap, changes, effective, tmp_path)
    assert 'SENTINEL' not in pages
    assert omitted == {'.env.production.sh', 'src/runtime.py'}

    def full_rebuild_traffic():
        provider.sends.clear(); provider.counts.clear()
        provider.replies = [claude([{"type": "text", "text": FULL_REPLY}])]
        with PreflightSession() as session:
            assert update(pristine, repo, session, force=True).status == 'published'
        sent = json.dumps([b for _p, b in provider.sends]) + json.dumps(provider.counts)
        assert 'SENTINEL' not in sent and provider.counts and provider.messages() and not provider.replies
        assert 'safe source' in sent and '=== src/__init__.py (0 bytes) ===' in sent   # empty source stays readable
        return im.load_document(pristine, 'app-abc1234')

    # A full rebuild from that baseline document keeps the credential's origin, and publishes it.
    rebuilt = full_rebuild_traffic()
    assert '3 files withheld (binary file, credential file)' in rebuilt.info['coverage']
    protected = im.document_exclusions(rebuilt)
    assert {'.envrc', 'src/runtime.py'} <= protected.paths and protected == effective

    # A -> B -> B: a second rebuild at unchanged B (in a fresh session), where neither commit shows the
    # rename any more, still withholds it because the published B document carries the protection.
    again = full_rebuild_traffic()
    assert again.info['last_commit'] == target and again.sha256 != rebuilt.sha256
    assert '3 files withheld (binary file, credential file)' in again.info['coverage']
    assert im.document_exclusions(again) == protected

    # C, from the newly published B document: the protected file is edited and moved, and A's old
    # .env.production.sh bytes, known now only from the inherited record, reappear under another name.
    # The incremental pages, reads and search, the pilot's full caller and a published
    # incremental update all keep them withheld, and the record grows.
    repo.git('mv', 'src/runtime.py', 'src/settings.py')
    repo.write('src/settings.py', (repo.path / 'src/settings.py').read_text() + 'export Z=SENTINEL-RC-C\n')
    repo.write('src/copy.py', secrets['.env.production.sh'])
    target_c = repo.commit('move, edit and copy the protected file')
    b_snap, c_snap = snap.GitSnapshot(repo.path, target), snap.GitSnapshot(repo.path, target_c)
    changes = snap.changes_between(repo.path, target, target_c)
    assert ('R', 'src/runtime.py', 'src/settings.py') in [tuple(c) for c in changes]   # an edited rename
    effective = snap.credential_exclusions(im.document_exclusions(again), b_snap.manifest(), c_snap.manifest(), changes)
    assert {'src/settings.py', 'src/copy.py'} <= effective.paths and protected.paths <= effective.paths
    assert c_snap.manifest()['src/settings.py'].oid in effective.oids
    pages, omitted = spooled_pages(repo, target, target_c, b_snap, c_snap, changes, effective, tmp_path)
    assert 'SENTINEL' not in pages and omitted == {'src/settings.py', 'src/copy.py'}
    tools = snap.SnapshotTools(b_snap, c_snap, effective)
    for args in ({'path': 'src/settings.py'}, {'path': 'src/copy.py'}, {'path': 'src/runtime.py', 'version': 'base'}):
        assert 'unavailable: credential file' in tools.run('read_file', json.dumps(args))
    assert tools.run('search', '{"literal": "SENTINEL"}') == '[no matches]'

    provider.sends.clear(); provider.counts.clear()
    provider.replies = [claude([{"type": "text", "text": FULL_REPLY}])]
    pilot_dir, result = run_pilot(tmp_path / 'pilot', repo, again.text, 'full', target_c)
    traffic = json.dumps([b for _p, b in provider.sends]) + json.dumps(provider.counts)
    assert result['status'] == 'complete' and 'SENTINEL' not in traffic and provider.messages()
    for path in ('src/settings.py', 'src/copy.py'):
        assert {'path': path, 'reason': 'credential file'} in result['omitted']
    pilot_doc = im.Document(None, '', '', metadata.parse_frontmatter((pilot_dir / 'full.md').read_text()), '')
    assert im.document_exclusions(pilot_doc) == effective

    provider.sends.clear(); provider.counts.clear()
    # Every changed path here is withheld, so there is no page to map: only the editor is called.
    provider.replies = [tool_use('read_file', {'path': 'src/settings.py'}),
                        answer({'base_document_sha256': again.sha256, 'sections': []})]
    with PreflightSession() as session:
        assert update(pristine, repo, session).status == 'published'
    traffic = json.dumps([b for _p, b in provider.sends]) + json.dumps(provider.counts)
    assert 'SENTINEL' not in traffic and 'unavailable: credential file' in traffic
    updated = im.load_document(pristine, 'app-abc1234')
    assert updated.info['generation_strategy'] == 'incremental' and updated.info['last_commit'] == target_c
    assert im.document_exclusions(updated) == effective   # a no-op section patch still carries it forward

    # A generated document without a valid record, or one that can't be read, is kept byte for byte and
    # fails before any count or send; a forced rebuild doesn't get round it, nor does the pilot.
    record = f"{im.EXCLUSIONS_KEY}: {updated.info[im.EXCLUSIONS_KEY]}\n"
    missing = updated.text.replace(record, '')
    # 40 hex digits plus a newline can never match the real blob, so it must not decode.
    tampered = json.loads(base64.b64decode(updated.info[im.EXCLUSIONS_KEY]))
    tampered['oids'] = [oid + '\n' for oid in tampered['oids']]
    newline_oid = base64.b64encode(json.dumps(tampered, separators=(',', ':'), sort_keys=True).encode()).decode()
    for broken in (missing.encode(), updated.text.replace(record, f"{im.EXCLUSIONS_KEY}: e30=\n").encode(),
                   updated.text.replace(record, f"{im.EXCLUSIONS_KEY}: {newline_oid}\n").encode(),
                   b'\xff' + updated.text.encode()):
        (pristine / 'app-abc1234.md').write_bytes(broken)
        provider.sends.clear(); provider.counts.clear()
        provider.replies = [claude([{"type": "text", "text": FULL_REPLY}])]
        with PreflightSession() as session:
            outcome = update(pristine, repo, session, force=True)
        assert outcome.status == 'failed' and 'kept as it is' in outcome.reason, outcome
        assert not provider.sends and not provider.counts and provider.replies
        assert (pristine / 'app-abc1234.md').read_bytes() == broken
        assert metadata.read_attempt_state(pristine, 'app-abc1234')['status'] == 'failed'
    with pytest.raises(SystemExit):
        run_pilot(tmp_path / 'pilot-unprotected', repo, missing, 'full', target_c)
    assert not provider.sends and not provider.counts


# ── The map, merge and edit engine ───────────────────────────────────────────────────────────────

GEMINI = 'gemini/gemini-3.8-flash'


class GeminiFake:
    """A concurrent fake Gemini at the HTTP transport. `reply(stage, text)` answers each send with JSON
    to return as the model's text, or an httpx.Response. Records every send and the most requests seen
    in flight at once."""

    def __init__(self, monkeypatch, reply):
        self.sends, self.max_in_flight, self.in_flight = [], 0, 0
        lock = threading.Lock()
        fake = self

        def handle(transport, request):
            if request.url.host != 'generativelanguage.googleapis.com':
                raise httpx.ConnectError(f"not the fake: {request.url}", request=request)
            body = json.loads(request.content)
            system = (body.get('system_instruction') or {'parts': [{'text': ''}]})['parts'][0]['text']
            stage = ('map' if system.startswith('You read one page') else 'merge' if system.startswith('You merge')
                     else 'edit' if system else 'full')
            text = ''.join(p.get('text', '') for c in body['contents'] for p in c['parts'])
            with lock:
                fake.in_flight += 1
                fake.max_in_flight = max(fake.max_in_flight, fake.in_flight)
                fake.sends.append((stage, text, body))
            time.sleep(0.005)
            try:
                out = reply(stage, text)
                if isinstance(out, httpx.Response):
                    return out
                part = {"text": out} if isinstance(out, str) else out if 'functionCall' in out else {"text": json.dumps(out)}
                return httpx.Response(200, json={
                    "candidates": [{"content": {"parts": [part], "role": "model"}, "finishReason": "STOP"}],
                    "usageMetadata": {"promptTokenCount": 100, "candidatesTokenCount": 20, "totalTokenCount": 120}})
            finally:
                with lock:
                    fake.in_flight -= 1

        monkeypatch.setattr(httpx.HTTPTransport, 'handle_request', handle)

    def stage(self, stage):
        return [(text, body) for s, text, body in self.sends if s == stage]


def small_pages(monkeypatch, size=2048):
    """Real pages, just smaller, so a diff of many pages stays cheap to build."""
    real = snap.prepare_pages
    monkeypatch.setattr(snap, 'prepare_pages', lambda *a, **k: real(*a, page_bytes=size, **k))


def rewrite_files(repo, lines):
    for i in range(10):
        repo.write(f'src/m{i}.py', ''.join(f'value_{i}_{n} = {n}\n' for n in range(lines)))
    return repo.commit('rewrite everything')


def files_on_page(text):
    return re.findall(r'^(f\d+) ', text, re.M)


def dense(size):
    """Text of about `size` bytes that counts about one token per two bytes."""
    return ' '.join(f'{i:x}.' for i in range(size))[:size]


def file_table(text):
    """The file-id table's rows in a merge or editor request, as sent."""
    rows = text.split(mr.FILE_TABLE_LABEL + '\n', 1)[1].split('\n\n', 1)[0]
    return [] if rows == 'none' else rows.split('\n')


def cited_identities(text):
    """The file-id table in a merge or editor request, by id."""
    return {row[0]: {'status': row[1], 'old_path': row[2], 'new_path': row[3]}
            for row in map(json.loads, file_table(text))}


def paths_on_page(text):
    """Each listed file's displayed path on a diff page, by id (a rename's new path)."""
    return {m[0]: m[1].split(' -> ')[-1] for m in re.findall(r'^(f\d+) \S+ (.+)$', text.split('[end of list]')[0], re.M)}


def test_a_huge_diff_is_mapped_merged_edited_and_published(monkeypatch, tmp_path):
    repo, base, pristine = setup_pristine(monkeypatch, tmp_path)
    (repo.path / 'lib').mkdir()
    repo.git('mv', 'src/m9.py', 'lib/renamed.py')
    repo.write('src/crlf.py', 'a = 1\r\nb = 2\r\n')
    repo.write('src/say "hi".py', 'quoted = True\n')
    for i in range(9):
        repo.write(f'src/m{i}.py', ''.join(f'value_{i}_{n} = {n}\n' for n in range(4700)))
    target = repo.commit('rewrite everything and rename one')
    small_pages(monkeypatch)
    from repo_radar import metadata_budget   # today's table price, so the quote's date doesn't decide the test
    monkeypatch.delitem(metadata_budget.ANNOUNCED_PRICE_CHANGES, GEMINI)
    old = im.load_document(pristine, 'app-abc1234')
    sections = {s.text.split('\n', 1)[0]: s for s in im.split_sections(im._analysis_of(old))}
    components = sections['## Key Components']
    answer_patch = {'base_document_sha256': old.sha256,
                    'sections': [{'op': 'replace', 'id': components.id, 'expected_sha256': components.sha256,
                                  'content': '## Key Components\n- values are rewritten\n'}]}
    big_read = {'functionCall': {'name': 'read_file', 'args': {'path': 'src/m0.py', 'limit': 2000}}}
    every_path = {f"f{n}": c.new_path or c.old_path
                  for n, c in enumerate(snap.changes_between(repo.path, base, target), 1)}

    def outside(ids):   # a real changed file's path that this request wasn't given
        return next(path for file_id, path in every_path.items() if file_id not in ids)

    # Some replies cite files by path, by something unsupported, or by nothing that can be placed. Exact
    # paths of the request's own files become their ids; the rest is dropped and the change is kept.
    def reply(stage, text):
        if stage == 'map':   # JSON mode doesn't enforce a schema, so optional lists may come back null
            ids, paths = files_on_page(text), paths_on_page(text)
            files = {'[page p1 ': [paths[ids[0]], *ids[1:]],
                     '[page p2 ': [*ids, 'src/nowhere.py', outside(ids)]}.get(text[text.index('[page p'):][:9], ids)
            changes = [{'files': files, 'what': 'n' * 2600, 'sections': [components.id]}]
            if '[page p3 ' in text:
                changes.append({'files': ['src/nowhere.py'], 'what': 'UNATTRIBUTED map change', 'sections': []})
            return {'changes': changes, 'questions': None, 'new_sections': None, 'no_summary_change_reason': None}
        if stage == 'merge':
            notes = text.split('Notes to merge', 1)[1]
            files = [f.strip('"') for f in sorted(set(re.findall(r'"f\d+"', notes)), key=lambda f: int(f[2:-1]))]
            changes = [{'files': files, 'what': dense(9000), 'sections': [components.id]}]
            if '"files":[]' in notes:   # an unattributed change is carried forward as it is
                changes.append({'files': [], 'what': 'UNATTRIBUTED, carried forward', 'sections': []})
            if 'UNATTRIBUTED map change' in notes and '"disagreements"' not in notes:   # the first level-1 merge
                table = cited_identities(text)
                changes[0]['files'] = [table[files[0]]['new_path'], *files[1:], 'lib/nowhere.py', outside(table)]
                changes.append({'files': ['f9999'], 'what': 'UNATTRIBUTED merge change', 'sections': []})
            return {'changes': changes, 'questions': ['kept'], 'disagreements': None, 'no_summary_change_reason': None}
        return answer_patch if 'last turn' in text else big_read   # read until tools are no longer offered
    fake = GeminiFake(monkeypatch, reply)
    evidence, real_init = tmp_path / 'evidence', mr.Pipeline.__init__

    def keeping_evidence(self, *args, **kwargs):
        real_init(self, *args, **kwargs)
        self.evidence_dir = evidence
    monkeypatch.setattr(mr.Pipeline, '__init__', keeping_evidence)
    from repo_radar import spending as sp
    record = sp.Spending('stable', store=sp.Store(tmp_path / 'spending'), policy=lambda: (True, 75.0))
    with PreflightSession() as session:
        outcome = im.update_repository(pristine, repo.path, 'app-abc1234', REPO_CONFIG, GEMINI, session, now=NOW,
                                       spending=record)
    assert outcome.status == 'published', outcome

    # Every page was mapped exactly once, at most four at a time, and each request stayed bounded.
    maps, merges, edits = fake.stage('map'), fake.stage('merge'), fake.stage('edit')
    assert len(maps) >= 400 and outcome.usage['diff_pages'] == len(maps)
    assert sorted(int(re.search(r'\[page p(\d+) ', text).group(1)) for text, _b in maps) == list(range(1, len(maps) + 1))
    assert fake.max_in_flight == 4
    assert any('+b = 2\r\n' in text for text, _b in maps), 'CRLF line endings reach the model as they are'
    assert max(len(text.encode()) for text, _b in maps) <= 2048 + 1024
    assert max(len(text.encode()) for text, _b in merges) <= 66 * 1024 and 2 <= len(edits) <= 4

    # Dense notes force a level their byte total alone wouldn't, and the quote already priced all of it.
    state = metadata.read_attempt_state(pristine, 'app-abc1234')
    usage = state['usage']
    first, second = len(maps) // 16 + 1, (len(maps) // 16 + 1 + 4) // 5
    assert len(merges) > first + second and len(merges) <= mr.worst_case_merges(len(maps))
    assert sum(int(n) for n in re.findall(r'"covers_pages":(\d+)', edits[0][0])) == len(maps)
    assert usage['estimated_total_usd'] > usage['known_cost_usd'] > 0
    assert usage['rate_input_per_mtok'] == 0.75
    # In a normal sync the update held exactly its quote, not the $12 limit, and closed at its known cost.
    [attempt] = json.loads((tmp_path / 'spending' / sp.LEDGER_NAME).read_text())['attempts'].values()
    assert abs(attempt['allowance'] - sp.to_micro(usage['estimated_total_usd'])) <= 1
    assert attempt['allowance'] < 12_000_000 and attempt['status'] == 'closed'
    week = sp.summary(record.store, record.policy)
    assert week['recorded_usd'] == pytest.approx(usage['known_cost_usd'], abs=1e-4) and week['reserved_usd'] == 0

    # Every merge and editor request names each cited file's real status and paths.
    changes = snap.changes_between(repo.path, base, target)
    expected = {f"f{n}": {'status': c.status, 'old_path': c.old_path, 'new_path': c.new_path}
                for n, c in enumerate(changes, 1)}
    renamed = next(file_id for file_id, ref in expected.items() if ref['status'] == 'R')
    assert expected[renamed]['new_path'] == 'lib/renamed.py'
    for text, _body in (*merges, edits[0]):
        table = cited_identities(text)
        assert table and all(table[file_id] == expected[file_id] for file_id in table)
        assert len(file_table(text)) == len(table)   # one row per id, none merged
    editor = cited_identities(edits[0][0])
    assert renamed in editor and editor[renamed]['old_path'] == 'src/m9.py'
    quoted = next(file_id for file_id, ref in expected.items() if ref['new_path'] == 'src/say "hi".py')
    assert quoted in editor and json.dumps([quoted, 'A', None, 'src/say "hi".py'], separators=(',', ':')) in edits[0][0]
    # Compact rows: the same mapping in fewer bytes than the old object per id.
    old_encoding = json.dumps(editor, ensure_ascii=False, separators=(',', ':'))
    assert len('\n'.join(file_table(edits[0][0])).encode()) < 0.8 * len(old_encoding.encode())

    # A large read is cut to fit the counted request, within the delivered-bytes cap, and the edit still
    # publishes; the last turn offers no tools.
    assert mr.TOOL_TRUNCATED_NOTICE.strip() in json.dumps(edits[-1][1])
    assert usage['tool_calls'] == len(edits) - 1 and usage['read_bytes'] <= mr.EDIT_TOOL_BYTES
    assert edits[-1][1]['toolConfig']['functionCallingConfig']['mode'] == 'NONE' and 'last turn' in edits[-1][0]
    assert 'NONE' not in json.dumps(edits[0][1].get('toolConfig', {}))
    with PreflightSession() as session:   # each request stayed within the limit it was counted against
        assert all(session.count_request({'endpoint': 'chat', 'model': GEMINI, 'messages': [
            {'role': 'user', 'content': text}]}).tokens <= mr.EDIT_REQUEST_TOKENS for text, _b in edits)

    # The stage options went out on the wire: low effort and JSON for short stages, not for the editor.
    def options(body):
        config = body['generationConfig']
        return config['max_output_tokens'], config.get('thinkingConfig', {}).get('thinkingLevel'), config.get('response_mime_type')
    assert {options(b) for _t, b in maps} == {(2048, 'low', 'application/json')}
    assert {options(b) for _t, b in merges} == {(4096, 'low', 'application/json')}
    limit, level, mime = options(edits[0][1])
    assert (limit, mime) == (16384, None) and level != 'low'

    # The real patch and publication ran: the right commit, and untouched sections keep their bytes.
    new = im.load_document(pristine, 'app-abc1234')
    assert (new.info['last_commit'], new.info['generation_strategy']) == (target, 'incremental')
    assert new.info['pipeline_version'] == im.PIPELINE_VERSION and 'values are rewritten' in new.text
    untouched = [s for s in sections.values() if s.id != components.id]
    assert all(s.text in new.text for s in untouched[:-1])
    assert untouched[-1].text.rstrip('\n') in new.text   # rendering normalizes the document's final newlines
    assert (usage['map_calls'], usage['merge_calls'], usage['edit_turns']) == (len(maps), len(merges), len(edits))

    # Repaired citations: an exact path became its own id, nothing unsupported or borrowed got in, and the
    # unattributed changes reached the editor with the app's warning, which the published note keeps.
    saved = json.loads((evidence / 'notes.json').read_text())
    notes = {n['id']: n for n in saved['notes']}
    page_files = {p['id']: p['files'] for p in saved['pages']}
    assert notes['p1']['note']['changes'][0]['files'] == page_files['p1']
    assert notes['p2']['note']['changes'][0]['files'] == page_files['p2']   # the outside path wasn't borrowed
    assert notes['p3']['note']['changes'][1] == {'files': [], 'what': 'UNATTRIBUTED map change', 'sections': []}
    first = next(n for n in saved['notes'] if any(c['what'] == 'UNATTRIBUTED merge change' for c in n['note']['changes']))
    children = {f for i in range(1, 17) for c in notes[f'p{i}']['note']['changes'] for f in c['files']}
    assert first['id'] == 'l1-g0' and first['note']['changes'][0]['files'] == sorted(children, key=lambda f: int(f[1:]))
    assert all(set(c['files']) <= set(n['files']) for n in saved['notes'] for c in n['note']['changes'])
    for text, _body in (*merges, *edits[:1]):
        assert 'nowhere' not in text and set(cited_identities(text)) <= set(expected)
    assert 'UNATTRIBUTED' in edits[0][0] and mr.ATTRIBUTION_WARNING in edits[0][0]
    assert new.info['coverage_note'].startswith(mr.ATTRIBUTION_WARNING)
    calls = {(c['stage'], c['id']): c for c in saved['calls']}
    assert (calls[('map', 'p1')]['normalized_file_citations'], calls[('map', 'p2')]['dropped_file_citations'],
            calls[('map', 'p3')]['dropped_file_citations']) == (1, 2, 1)
    assert (calls[('merge', 'l1-g0')]['normalized_file_citations'], calls[('merge', 'l1-g0')]['dropped_file_citations']) == (1, 3)
    for key, total in (('normalized_file_citations', 2), ('dropped_file_citations', 6)):
        assert usage[key] == sum(c.get(key, 0) for c in saved['calls']) == total

    # Notes stay strict about their shape and size: a wrong or missing field, an empty string, or a note over
    # its limit as written, even one that dropping citations or sections would shrink. An unknown file or
    # section is dropped rather than refused.
    long_path = 'src/' + 'p' * 400 + '.py'
    paths = {long_path: 'f1'}
    for bad in ({'changes': [], 'questions': 'x', 'no_summary_change_reason': 'r'},
                {'changes': None, 'no_summary_change_reason': 'r'},
                {'changes': [{'what': 'w', 'sections': []}], 'no_summary_change_reason': None},
                {'changes': [{'files': 'f1', 'what': 'w', 'sections': []}], 'no_summary_change_reason': None},
                {'changes': [{'files': [''], 'what': 'w', 'sections': []}], 'no_summary_change_reason': None},
                {'changes': [{'files': ['f1'], 'what': 'w' * 3000, 'sections': ['s9']},
                             {'files': ['f1'], 'what': 'w', 'sections': ['s1']}], 'no_summary_change_reason': None},
                {'changes': [{'files': [long_path], 'what': 'w' * 2800, 'sections': []}], 'no_summary_change_reason': None}):
        with pytest.raises(mr.NoteError):
            mr.validate_note(bad, ['f1'], ['s1'], mr.MAX_NOTE_BYTES, paths=paths)
    note, _text, repairs = mr.validate_note({'changes': [{'files': ['f99'], 'what': 'w', 'sections': []}]},
                                            ['f1'], ['s1'], mr.MAX_NOTE_BYTES)
    assert note['changes'][0]['files'] == [] and repairs == {**dict.fromkeys(mr.REPAIR_COUNTS, 0), 'dropped_file_citations': 1}
    note, _text, repairs = mr.validate_note({'changes': [{'files': ['f1'], 'what': 'w', 'sections': ['s9']}]},
                                            ['f1'], ['s1'], mr.MAX_NOTE_BYTES)
    assert note['changes'] == [{'files': ['f1'], 'what': 'w', 'sections': []}]
    assert repairs == {**dict.fromkeys(mr.REPAIR_COUNTS, 0), 'dropped_sections': 1}


def test_an_editor_continuation_has_room_for_replayed_provider_fields(monkeypatch, tmp_path):
    """The live 1.0.37 failure: turn 1's tool call came back with provider fields (a thought signature)
    that the next request has to replay, pushing it past the 65,536 preparation budget though the reply
    reported a few output tokens. Continuations get the 128,000 request ceiling; past that, the update
    stops before sending, keeps the old summary and counts as a failure. `recount(request, counted, fake)`
    may replace a count."""
    def attempt(where, signature_bytes, recount=None):
        repo, _base, pristine = setup_pristine(monkeypatch, where)
        repo.write('src/m0.py', 'changed = True\n')
        target = repo.commit('one change')
        old = im.load_document(pristine, 'app-abc1234')
        sections = {s.text.split('\n', 1)[0]: s for s in im.split_sections(im._analysis_of(old))}
        components = sections['## Key Components']
        signature = 'S' * signature_bytes
        read = {'functionCall': {'name': 'read_file', 'args': {'path': 'src/m0.py'}}, 'thoughtSignature': signature}
        patch = {'base_document_sha256': old.sha256,
                 'sections': [{'op': 'replace', 'id': components.id, 'expected_sha256': components.sha256,
                               'content': '## Key Components\n- m0 now records a change\n'}]}

        def reply(stage, text):
            if stage == 'map':
                return {'changes': [{'files': files_on_page(text), 'what': 'm0 changed', 'sections': [components.id]}],
                        'questions': None, 'new_sections': None, 'no_summary_change_reason': None}
            return read if len(fake.stage('edit')) == 1 and 'last turn' not in text else patch
        fake = GeminiFake(monkeypatch, reply)
        real_count = PreflightSession.count_request
        if recount:
            monkeypatch.setattr(PreflightSession, 'count_request', lambda self, request, timeout=None: recount(
                request, real_count(self, request, timeout=timeout), fake))
        pipelines, real_init = [], mr.Pipeline.__init__

        def keep(self, *args, **kwargs):
            real_init(self, *args, **kwargs)
            pipelines.append(self)
        monkeypatch.setattr(mr.Pipeline, '__init__', keep)
        with PreflightSession() as session:
            outcome = im.update_repository(pristine, repo.path, 'app-abc1234', REPO_CONFIG, GEMINI, session, now=NOW)
        monkeypatch.setattr(mr.Pipeline, '__init__', real_init)
        monkeypatch.setattr(PreflightSession, 'count_request', real_count)
        return outcome, fake, pipelines[0], pristine, old, sections, components, signature, target

    # Below the ceiling: the second request goes out with the reply's fields intact, and the edit publishes.
    outcome, fake, pipeline, pristine, old, sections, components, signature, target = attempt(tmp_path / 'fits', 40_000)
    assert outcome.status == 'published', outcome
    edits = fake.stage('edit')
    counted = {c['id']: c['counted_tokens'] for c in pipeline.calls if c['stage'] == 'edit'}
    assert len(edits) == 2 and list(counted) == ['t1', 't2']
    assert counted['t1'] + 16384 + mr.CONTINUATION_TOKENS <= mr.EDIT_PREPARE_TOKENS < counted['t2'] < mr.EDIT_REQUEST_TOKENS
    assert signature in json.dumps(edits[1][1]) and 'changed = True' in json.dumps(edits[1][1])
    new = im.load_document(pristine, 'app-abc1234')
    assert new.info['last_commit'] == target and 'm0 now records a change' in new.text
    untouched = [s for s in sections.values() if s.id != components.id]
    assert all(s.text in new.text for s in untouched[:-1]) and untouched[-1].text.rstrip('\n') in new.text
    usage = outcome.usage
    assert usage['calls'] == len(fake.sends) == len(pipeline.calls) == usage['map_calls'] + 2 and usage['edit_turns'] == 2

    # Above it: nothing more is sent, the spend stays recorded, and the failure counts once.
    outcome, fake, pipeline, pristine, old, *_ = attempt(tmp_path / 'over', 70_000)
    assert outcome.status == 'failed' and 'would not fit its 128,000 token limit' in outcome.reason, outcome
    assert len(fake.stage('edit')) == 1 and outcome.usage['calls'] == len(fake.sends) and outcome.usage['known_cost_usd'] > 0
    assert im.load_document(pristine, 'app-abc1234').text == old.text
    assert metadata.read_attempt_state(pristine, 'app-abc1234')['consecutive_failures'] == 1

    # A count lost after a paid call is a failure too, not a skip that would leave the hold disengaged.
    def lost(request, counted, fake):
        return counted._replace(tokens=None) if fake.sends and 'tools' in request else counted
    outcome, fake, _p, pristine, old, *_ = attempt(tmp_path / 'lost', 0, lost)
    assert outcome.status == 'failed' and 'token count unavailable' in outcome.reason, outcome
    assert not fake.stage('edit') and outcome.usage['known_cost_usd'] > 0
    assert im.load_document(pristine, 'app-abc1234').text == old.text
    assert metadata.read_attempt_state(pristine, 'app-abc1234')['consecutive_failures'] == 1

    # One note that fits 65,536 tokens but leaves no room for a tool-calling reply: turn 1 answers without tools.
    def crowded(request, counted, fake):
        return counted._replace(tokens=60_000) if 'covers_pages' in json.dumps(request) else counted
    outcome, fake, *_ = attempt(tmp_path / 'crowded', 0, crowded)
    edits = fake.stage('edit')
    assert outcome.status == 'published' and len(edits) == 1, outcome
    assert 'tools' not in edits[0][1] and 'last turn' in edits[0][0]


@pytest.mark.parametrize('final_tokens, publishes', [(60_000, True), (66_000, False)])
def test_one_note_is_fitted_by_the_final_only_request_turn_1_sends(monkeypatch, tmp_path, final_tokens, publishes):
    """With one note left, the request with tool definitions can pass the 65,536 preparation budget while
    the final-only request turn 1 actually sends (no tools, the last-turn instruction, JSON) fits. Readiness
    counts that request, so the edit goes out; when even it doesn't fit, nothing is sent to the editor."""
    repo, _base, pristine = setup_pristine(monkeypatch, tmp_path)
    repo.write('src/m0.py', 'changed = True\n')
    target = repo.commit('one change')
    old = im.load_document(pristine, 'app-abc1234')
    components = next(s for s in im.split_sections(im._analysis_of(old)) if s.text.startswith('## Key Components'))
    patch = {'base_document_sha256': old.sha256,
             'sections': [{'op': 'replace', 'id': components.id, 'expected_sha256': components.sha256,
                           'content': '## Key Components\n- m0 now records a change\n'}]}

    def reply(stage, text):
        if stage == 'map':
            return {'changes': [{'files': files_on_page(text), 'what': 'm0 changed', 'sections': [components.id]}],
                    'questions': None, 'new_sections': None, 'no_summary_change_reason': None}
        return patch
    fake = GeminiFake(monkeypatch, reply)
    counted, real_count = [], PreflightSession.count_request

    def count(self, request, timeout=None):   # the tool definitions are what crowd the note out
        result = real_count(self, request, timeout=timeout)
        if 'covers_pages' not in json.dumps(request):
            return result
        counted.append(request)
        return result._replace(tokens=70_000 if 'tools' in request else final_tokens)
    monkeypatch.setattr(PreflightSession, 'count_request', count)
    with PreflightSession() as session:
        outcome = im.update_repository(pristine, repo.path, 'app-abc1234', REPO_CONFIG, GEMINI, session, now=NOW)

    assert not fake.stage('merge') and len(fake.stage('map')) == 1
    if not publishes:
        assert outcome.status == 'failed' and 'without tools' in outcome.reason, outcome
        assert not fake.stage('edit') and im.load_document(pristine, 'app-abc1234').text == old.text
        return
    assert outcome.status == 'published', outcome
    assert im.load_document(pristine, 'app-abc1234').info['last_commit'] == target
    (text, body), = fake.stage('edit')
    # Readiness counts the tool request once, then the final-only one; edit_stage the same pair again.
    assert len(counted) == 4 and ['tools' in r for r in counted] == [True, False, True, False]
    final = counted[-1]
    assert counted[1] == final, "readiness counted a different final-only request from the one sent"
    assert 'tools' not in body and 'tools' not in final and final['response_format'] == {'type': 'json_object'}
    assert body['generationConfig']['response_mime_type'] == 'application/json' and 'last turn' in text
    sent_user = [m['content'] for m in final['messages'] if m['role'] == 'user']
    assert len(sent_user) == 2 and all(part in text for part in sent_user)
    assert outcome.usage['edit_turns'] == 1


def test_a_change_naming_unknown_sections_is_repaired_not_the_whole_update(monkeypatch, tmp_path):
    """The 1.0.38 failure: one map note in 202 had a change whose sections weren't ids it was given, and the
    whole update failed. Now those ids are dropped and counted, and the change reaches the editor without a
    section, next to the note's other change."""
    repo, _base, pristine = setup_pristine(monkeypatch, tmp_path)
    repo.write('src/m0.py', 'changed = True\n')
    repo.commit('one change')
    old = im.load_document(pristine, 'app-abc1234')
    components = next(s for s in im.split_sections(im._analysis_of(old)) if s.text.startswith('## Key Components'))
    patch = {'base_document_sha256': old.sha256,
             'sections': [{'op': 'replace', 'id': components.id, 'expected_sha256': components.sha256,
                           'content': '## Key Components\n- m0 now records a change\n'}]}

    def reply(stage, text):
        if stage == 'map':
            files = files_on_page(text)
            return {'changes': [{'files': files, 'what': 'm0 records a change', 'sections': components.id},
                                {'files': files, 'what': 'UNPLACED change', 'sections': ['', 'unknown-id']}],
                    'questions': None, 'new_sections': None, 'no_summary_change_reason': None}
        return patch
    fake = GeminiFake(monkeypatch, reply)
    with PreflightSession() as session:
        outcome = im.update_repository(pristine, repo.path, 'app-abc1234', REPO_CONFIG, GEMINI, session, now=NOW)
    assert outcome.status == 'published', outcome
    editor = fake.stage('edit')[0][0]
    assert 'm0 records a change' in editor and 'UNPLACED change' in editor and mr.SECTION_WARNING in editor
    usage = outcome.usage
    assert (usage['normalized_sections'], usage['dropped_sections']) == (1, 2) and 'dropped_changes' not in usage
    new = im.load_document(pristine, 'app-abc1234')
    assert 'm0 now records a change' in new.text and mr.SECTION_WARNING in new.info['coverage_note']


def test_an_editor_answer_in_a_code_fence_lands_and_prose_alone_still_fails(monkeypatch, tmp_path):
    """Pilot run 3: a paid update stopped on 'the answer is not a JSON object'. One object in a fence, or
    among a few words, is the answer; with none (or two) the reply is refused after the spend, and the start
    of it is kept, redacted, in the attempt's record. A final turn with no tools also asks Gemini for JSON,
    and the request counted is the one sent."""
    def attempt(where, answer, crowd):
        repo, _base, pristine = setup_pristine(monkeypatch, where)
        repo.write('src/m0.py', 'changed = True\n')
        repo.commit('one change')
        old = im.load_document(pristine, 'app-abc1234')
        components = next(s for s in im.split_sections(im._analysis_of(old)) if s.text.startswith('## Key Components'))
        patch = {'base_document_sha256': old.sha256,
                 'sections': [{'op': 'replace', 'id': components.id, 'expected_sha256': components.sha256,
                               'content': '## Key Components\n- m0 now records a change\n'}]}

        def reply(stage, text):
            if stage == 'map':
                return {'changes': [{'files': files_on_page(text), 'what': 'm0 changed', 'sections': [components.id]}],
                        'questions': None, 'new_sections': None, 'no_summary_change_reason': None}
            return answer(patch)
        fake = GeminiFake(monkeypatch, reply)
        counted, real_count = [], PreflightSession.count_request

        def count(self, request, timeout=None):   # one note that leaves no room for tools, when crowded
            result = real_count(self, request, timeout=timeout)
            counted.append(request)
            return result._replace(tokens=60_000) if crowd and 'covers_pages' in json.dumps(request) else result
        monkeypatch.setattr(PreflightSession, 'count_request', count)
        with PreflightSession() as session:
            outcome = im.update_repository(pristine, repo.path, 'app-abc1234', REPO_CONFIG, GEMINI, session, now=NOW)
        return outcome, fake, counted, pristine, old

    fenced = lambda patch: f"Here are the edits:\n```JSON\n{json.dumps(patch, indent=2)}\n```\nThat's all."
    outcome, fake, counted, pristine, _old = attempt(tmp_path / 'fenced', fenced, crowd=True)
    assert outcome.status == 'published', outcome
    assert 'm0 now records a change' in im.load_document(pristine, 'app-abc1234').text
    (_text, body), = fake.stage('edit')
    assert 'tools' not in body and body['generationConfig']['response_mime_type'] == 'application/json'
    assert counted[-1]['response_format'] == {'type': 'json_object'} and 'tools' not in counted[-1]

    prose = lambda patch: "I reviewed every note and the summary needs no edits. (key test-not-a-key, AIza" + 'x' * 30 + ")"
    outcome, fake, _counted, pristine, old = attempt(tmp_path / 'prose', prose, crowd=False)
    assert outcome.status == 'failed' and 'not a JSON object' in outcome.reason and outcome.usage['known_cost_usd'] > 0
    assert im.load_document(pristine, 'app-abc1234').text == old.text
    state = metadata.read_attempt_state(pristine, 'app-abc1234')
    saved = state['usage']['rejected_reply']
    assert state['consecutive_failures'] == 1 and saved['call'] == 'edit t1'
    assert saved['text'].startswith('I reviewed every note') and 'test-not-a-key' not in saved['text'] and 'AIzax' not in saved['text']

    two = json.dumps({'a': 1}) + ' or ' + json.dumps({'b': 2})
    with pytest.raises(im.PatchError, match='2 JSON objects'):
        im.parse_answer(two)


@pytest.mark.parametrize('case', ['unused', 'collision', 'reference', 'extra key', 'surrogate key', 'surrogate content',
                                  'surrogate replace id', 'largest shape', 'list replace id', 'dict after'])
def test_insert_label_is_ignored_without_becoming_a_section_reference(monkeypatch, tmp_path, case):
    """Installed 1.0.40 on telehealth: editor turn 3 refused 'insert has unexpected keys ['id']', and the
    kept 4 KiB of the reply ended before that insert. An unused label on an insert is now ignored. A label
    that names an existing section, a later edit naming the new label, or another extra key still refuses
    the whole patch after the spend, with no repair request, and the record keeps the edit's shape. A lone
    surrogate, which JSON allows, never replaces that refusal or loses the kept text, and the shape stays
    within 1 KiB as the attempt file stores it."""
    def attempt(where, insert, later=()):
        repo, _base, pristine = setup_pristine(monkeypatch, where)
        repo.write('src/m0.py', 'changed = True\n')
        repo.commit('one change')
        old = im.load_document(pristine, 'app-abc1234')
        components = next(s for s in im.split_sections(im._analysis_of(old)) if s.text.startswith('## Key Components'))
        long = '## Key Components\n- m0 now records a change\n' + ''.join(f"- detail {i} of what m0 records\n" for i in range(200))
        patch = {'base_document_sha256': old.sha256,
                 'sections': [{'op': 'replace', 'id': components.id, 'expected_sha256': components.sha256, 'content': long},
                              {'op': 'insert', 'after': components.id, 'content': '## Change Records\n- m0 keeps them\n',
                               **insert(components)}, *later]}
        assert len(json.dumps(patch)) > mr.REJECTED_REPLY_BYTES   # the edit at fault lies past the kept text

        def reply(stage, text):
            if stage == 'map':
                return {'changes': [{'files': files_on_page(text), 'what': 'm0 changed', 'sections': [components.id]}],
                        'questions': None, 'new_sections': None, 'no_summary_change_reason': None}
            return patch
        fake = GeminiFake(monkeypatch, reply)
        with PreflightSession() as session:
            outcome = im.update_repository(pristine, repo.path, 'app-abc1234', REPO_CONFIG, GEMINI, session, now=NOW)
        return outcome, fake, pristine, old, components

    if case == 'unused':
        labelled, _fake, pristine, old, components = attempt(tmp_path / 'labelled', lambda c: {'id': 'new-change-records'})
        plain, _fake, plain_pristine, _old, _c = attempt(tmp_path / 'plain', lambda c: {})
        assert labelled.status == plain.status == 'published', (labelled, plain)
        published = im._analysis_of(im.load_document(pristine, 'app-abc1234'))
        assert published == im._analysis_of(im.load_document(plain_pristine, 'app-abc1234'))
        assert '## Change Records' in published and 'new-change-records' not in published
        untouched = [s.text for s in im.split_sections(im._analysis_of(old)) if s.id != components.id]
        assert all(text.rstrip('\n') in published for text in untouched)   # the document's end is trimmed
        return

    insert, later, expected = {
        'collision': (lambda c: {'id': c.id}, (), {'index': 1, 'id_in_base': True}),
        'reference': (lambda c: {'id': 'new-change-records'},
                      ({'op': 'insert', 'after': 'new-change-records', 'content': '## More\n- more\n'},),
                      {'index': 2, 'after': 'new-change-records', 'after_in_base': False}),
        'extra key': (lambda c: {'title': 'Change Records'}, (), {'index': 1, 'keys': ['after', 'content', 'op', 'title']}),
        'surrogate key': (lambda c: {'\ud800': 'x'}, (), {'index': 1}),
        'surrogate content': (lambda c: {'title': 'x', 'content': '## Change Records\n- m0 \ud800 keeps them\n'}, (),
                              {'index': 1}),
        'surrogate replace id': (lambda c: {}, ({'op': 'replace', 'id': 'no-such-\ud800', 'expected_sha256': 'f' * 16,
                                                  'content': '## More\n- more\n'},), {'op': 'replace', 'index': 2, 'id_in_base': False}),
        'largest shape': (lambda c: {'id': '\x01' * 14, **{str(i) + '\x01' * 14: 'x' for i in range(15)}}, (), {'index': 1}),
        # A JSON list or object can't name a section: a clean refusal, not an unhashable TypeError.
        'list replace id': (lambda c: {}, ({'op': 'replace', 'id': ['s1'], 'expected_sha256': 'f' * 16,
                                             'content': '## More\n- more\n'},), {'op': 'replace', 'index': 2, 'id': '<list>'}),
        'dict after': (lambda c: {'after': {'id': c.id}}, (), {'index': 1, 'after': '<dict>', 'after_in_base': False}),
    }[case]
    outcome, fake, pristine, old, _components = attempt(tmp_path, insert, later)
    assert outcome.status == 'failed' and 'edits were rejected' in outcome.reason and outcome.usage['known_cost_usd'] > 0
    assert im.load_document(pristine, 'app-abc1234').text == old.text
    assert len(fake.stage('edit')) == 1, 'no repair request'
    state = metadata.read_attempt_state(pristine, 'app-abc1234')
    assert state['consecutive_failures'] == 1 and state['usage']['known_cost_usd'] == outcome.usage['known_cost_usd']
    saved = state['usage']['rejected_reply']
    assert saved['text'].startswith('{') and len(saved['text'].encode('utf-8')) <= mr.REJECTED_REPLY_BYTES
    assert '## Change Records' not in saved['text']
    operation = saved['operation']
    stored = im.state_path(pristine, 'app-abc1234').read_text(encoding='utf-8')
    start = stored.index('"operation": ') + len('"operation": ')
    assert len(stored[start:stored.index('\n      }', start) + 8].encode('utf-8')) <= mr.REJECTED_OPERATION_BYTES
    expected = {'op': 'insert', **expected}
    assert {k: operation.get(k) for k in expected} == expected
    assert set(operation['content']) == {'bytes', 'sha256'} and 'keeps them' not in json.dumps(operation)


def test_a_resource_limit_after_paid_map_calls_is_a_failure(monkeypatch, tmp_path):
    """A spool read that fails mid-run, after map waves were bought, fails the update and moves the streak;
    the same limit before anything is sent is still a skip."""
    small_pages(monkeypatch, 4096)
    real_read = snap.PageSet.read

    def attempt(where, after_sends):
        repo, _base, pristine = setup_pristine(monkeypatch, where)
        rewrite_files(repo, 80)
        old = im.load_document(pristine, 'app-abc1234')
        fake = GeminiFake(monkeypatch, lambda stage, text: {'changes': [], 'questions': None, 'new_sections': None,
                                                             'no_summary_change_reason': 'no effect on the summary'})

        def read(self, page):
            if fake.sends or not after_sends:
                raise snap.ResourceLimit("the page spool could not be read")
            return real_read(self, page)
        monkeypatch.setattr(snap.PageSet, 'read', read)
        with PreflightSession() as session:
            outcome = im.update_repository(pristine, repo.path, 'app-abc1234', REPO_CONFIG, GEMINI, session, now=NOW)
        assert im.load_document(pristine, 'app-abc1234').text == old.text
        return outcome, fake, metadata.read_attempt_state(pristine, 'app-abc1234')['consecutive_failures']

    outcome, fake, streak = attempt(tmp_path / 'paid', True)
    assert outcome.status == 'failed' and 'spool' in outcome.reason and fake.sends and streak == 1, outcome
    outcome, fake, streak = attempt(tmp_path / 'unpaid', False)
    assert outcome.status == 'skipped' and not fake.sends and streak == 0, outcome


def test_a_failed_map_call_stops_the_update_and_settles_what_was_launched(monkeypatch, tmp_path):
    repo, base, pristine = setup_pristine(monkeypatch, tmp_path)
    target = rewrite_files(repo, 80)
    small_pages(monkeypatch, 4096)
    old = im.load_document(pristine, 'app-abc1234')

    def reply(stage, text):
        assert stage == 'map'
        if '[page p2 ' in text:
            return httpx.Response(500, json={"error": {"message": "internal", "status": "INTERNAL"}})
        return {'changes': [], 'no_summary_change_reason': 'routine'}
    fake = GeminiFake(monkeypatch, reply)
    with PreflightSession() as session:
        outcome = im.update_repository(pristine, repo.path, 'app-abc1234', REPO_CONFIG, GEMINI, session, now=NOW)

    # The wave drained, the next never started, and nothing went on to a merge, an edit or publication.
    assert outcome.status == 'failed' and len(fake.sends) == 4 and {s for s, _t, _b in fake.sends} == {'map'}
    assert outcome.usage['diff_pages'] > 4 and outcome.usage['calls'] == 4 and outcome.usage['unknown_cost_calls'] == 1
    assert outcome.usage['known_cost_usd'] > 0 and outcome.usage['retained_reservation_usd'] > 0
    assert im.load_document(pristine, 'app-abc1234').text == old.text
    metadata.regenerate_index(types.SimpleNamespace(dry_run=False))
    assert f"stale: analyzed {base[:7]}, update to {target[:7]}" in (pristine / 'INDEX.md').read_text()

    # With a durable ledger the failed request's reservation stays, and a reopened ledger refuses more.
    allowances = {'replay': 16.0}
    path = tmp_path / 'ledger.json'
    budget = Budget(GEMINI, cap=12.0, ledger=Ledger(path, 40.0, allowances), label='replay')
    fake.sends.clear()
    decision = decide(repo, pristine, model=GEMINI)
    evidence = tmp_path / 'evidence'
    with PreflightSession() as session, pytest.raises(Exception, match='internal|INTERNAL|500'):
        im.run_incremental(repo.path, FULL, old, decision, GEMINI, session, budget, case='c1', evidence_dir=evidence)
    assert len(fake.sends) == 4
    reopened = Ledger(path, 40.0, allowances)
    assert reopened.spent() == pytest.approx(budget.cost + budget.retained)
    assert [e['status'] for e in json.loads(path.read_text())['entries']].count('unknown') == 1
    with pytest.raises(BudgetExceeded, match='reconcile'):
        Budget(GEMINI, ledger=reopened, label='replay').reserve({'next': 1}, 1, 1)
    saved = json.loads((evidence / 'notes.json').read_text())
    assert {n['id'] for n in saved['notes']} == {'p1', 'p3', 'p4'} and len(saved['calls']) == 4   # paid-for notes survive

    # The ledger can't record the first settlement, and one sibling's note is malformed. Every launched
    # call is still accounted for once, the bill stays honest, valid notes survive, nothing further runs,
    # and the entry left unresolved on disk still blocks a reopened ledger.
    def mostly_fine(stage, text):
        assert stage == 'map'
        if '[page p3 ' in text:
            return {'changes': [{'files': [], 'what': 'a change with no sections key'}]}   # malformed: refused
        return {'changes': [], 'no_summary_change_reason': 'routine'}
    fake = GeminiFake(monkeypatch, mostly_fine)
    real_settle, failures = Ledger.settle, []

    def flaky_settle(self, key, actual):
        if not failures:
            failures.append(key)
            raise OSError(28, 'No space left on device')
        return real_settle(self, key, actual)
    monkeypatch.setattr(Ledger, 'settle', flaky_settle)
    path = tmp_path / 'ledger-disk-full.json'
    budget = Budget(GEMINI, cap=12.0, ledger=Ledger(path, 40.0, allowances), label='replay')
    evidence = tmp_path / 'evidence-disk-full'
    with PreflightSession() as session, pytest.raises(LedgerWriteError, match='No space left'):
        im.run_incremental(repo.path, FULL, old, decision, GEMINI, session, budget, case='c2', evidence_dir=evidence)
    monkeypatch.setattr(Ledger, 'settle', real_settle)
    usage = budget.summary()
    assert len(fake.sends) == 4 and {s for s, _t, _b in fake.sends} == {'map'}
    assert (usage['calls'], usage['unknown_cost_calls'], usage['ledger_write_failures']) == (4, 0, 1)
    assert usage['open_reservation_usd'] == 0 and usage['known_cost_usd'] > 0 and usage['cost_usd'] == usage['known_cost_usd']
    saved = json.loads((evidence / 'notes.json').read_text())
    assert {n['id'] for n in saved['notes']} == {'p1', 'p2', 'p4'} and len(saved['calls']) == 4
    statuses = [e['status'] for e in json.loads(path.read_text())['entries']]
    assert sorted(statuses) == ['reserved', 'settled', 'settled', 'settled']
    with pytest.raises(BudgetExceeded, match='reconcile'):
        Budget(GEMINI, ledger=Ledger(path, 40.0, allowances), label='replay').reserve({'next': 1}, 1, 1)
    assert im.load_document(pristine, 'app-abc1234').text == old.text


def test_a_credential_renamed_and_edited_never_reaches_a_map_call_or_tool(monkeypatch, tmp_path):
    repo, _base, pristine = setup_pristine(monkeypatch, tmp_path, files=20)
    repo.write('.envrc', 'export A=SENTINEL-RC\n' + ''.join(f'export V{i}={i}\n' for i in range(20)))
    repo.commit('a credential')
    provider = Provider(monkeypatch)
    provider.replies = [claude([{"type": "text", "text": FULL_REPLY}])]
    with PreflightSession() as session:
        assert update(pristine, repo, session, force=True).status == 'published'

    # Renamed and edited in one commit: this update sees it arrive under an ordinary name.
    repo.git('mv', '.envrc', 'src/runtime.py')
    repo.write('src/runtime.py', (repo.path / 'src/runtime.py').read_text() + 'export Z=SENTINEL-EDIT\n')
    repo.write('src/m0.py', 'visible = "ordinary source"\n')
    repo.commit('move the credential and edit it')
    published = im.load_document(pristine, 'app-abc1234')
    provider.sends.clear(); provider.counts.clear()
    provider.replies = [note(), tool_use('read_file', {'path': 'src/runtime.py'}),
                        answer({'base_document_sha256': published.sha256, 'sections': []})]
    with PreflightSession() as session:
        assert update(pristine, repo, session).status == 'published'
    traffic = json.dumps([b for _p, b in provider.sends]) + json.dumps(provider.counts)
    assert 'SENTINEL' not in traffic and 'unavailable: credential file' in traffic and 'ordinary source' in traffic

    # In a later update, across that publication, only the document's record still knows what it is.
    repo.write('src/runtime.py', (repo.path / 'src/runtime.py').read_text() + 'export Y=SENTINEL-LATER\n')
    repo.write('src/m1.py', 'more = "ordinary source"\n')
    repo.commit('edit it again')
    published = im.load_document(pristine, 'app-abc1234')
    assert 'src/runtime.py' in im.document_exclusions(published).paths
    provider.sends.clear(); provider.counts.clear()
    provider.replies = [note(), tool_use('search', {'literal': 'SENTINEL'}),
                        answer({'base_document_sha256': published.sha256, 'sections': []})]
    with PreflightSession() as session:
        assert update(pristine, repo, session).status == 'published'
    traffic = json.dumps([b for _p, b in provider.sends]) + json.dumps(provider.counts)
    assert 'SENTINEL-' not in traffic and '[no matches]' in traffic and 'src/runtime.py' in traffic


class FileCounts:
    """A local counting session (authoritative=False, as for Gemini) whose count is `per_file` tokens for every
    source file framed in the request plus `base`, so a ten-file repository can stand for a large one."""

    def __init__(self, per_file, base=1000):
        self.per_file, self.base = per_file, base

    def count_request(self, request, timeout=None):
        from repo_radar.preflight import PreflightResult
        return PreflightResult(self.per_file * json.dumps(request).count(' bytes) ===') + self.base, False, 'local estimate')


def gemini_text(text, prompt_tokens=100, finish='STOP'):
    return httpx.Response(200, json={
        "candidates": [{"content": {"parts": [{"text": text}], "role": "model"}, "finishReason": finish}],
        "usageMetadata": {"promptTokenCount": prompt_tokens, "candidatesTokenCount": 20,
                          "totalTokenCount": prompt_tokens + 20}})


def full_build(pristine, repo, session, model=GEMINI, **kw):
    return im.update_repository(pristine, repo.path, 'app-abc1234', REPO_CONFIG, model, session, force=True, now=NOW,
                                **kw)


def test_a_truncated_full_synthesis_is_rejected_with_low_thinking_and_says_where(monkeypatch, tmp_path):
    repo, _base, pristine = setup_pristine(monkeypatch, tmp_path)
    old = im.load_document(pristine, 'app-abc1234')
    cut_off = httpx.Response(200, json={
        "candidates": [{"content": {"parts": [{"text": "## Overview\nCut o"}], "role": "model"}, "finishReason": "MAX_TOKENS"}],
        "usageMetadata": {"promptTokenCount": 100, "candidatesTokenCount": 40, "thoughtsTokenCount": 16344,
                          "totalTokenCount": 16484}})

    def reply(stage, text):
        assert stage == 'full'
        return cut_off if len(fake.sends) == 3 else '## Analysis\nOne chunk.\n'
    fake = GeminiFake(monkeypatch, reply)
    outcome = full_build(pristine, repo, FileCounts(20_000))   # six files fill a chunk, so ten make two

    # Low thinking and the unchanged limits on all three requests, with no JSON mode and no retry.
    configs = [body['generationConfig'] for _s, _t, body in fake.sends]
    assert [c['max_output_tokens'] for c in configs] == [8192, 8192, 16384]
    assert all(c['thinkingConfig']['thinkingLevel'] == 'low' and 'response_mime_type' not in c for c in configs)

    # All three are paid for, the failure says where, and the document stays.
    assert outcome.status == 'failed' and outcome.reason.startswith('full synthesis (call 3): ') and 'incomplete' in outcome.reason
    usage = metadata.read_attempt_state(pristine, 'app-abc1234')['usage']
    assert usage['calls'] == 3 and usage['unknown_cost_calls'] == 0 and usage['cost_usd'] > 0 and usage['output_tokens'] > 0
    assert usage['full_stage'] == {'stage': 'synthesis', 'call': 3, 'chunk': None, 'chunks': None, 'max_output': 16384,
                                   'finish_reason': 'length', 'output_tokens': usage['full_stage']['output_tokens'],
                                   'reasoning_tokens': 16344}
    assert usage['full_stage']['output_tokens'] >= 40 and 'Cut o' not in json.dumps(usage)
    assert im.load_document(pristine, 'app-abc1234').text == old.text


def test_a_full_build_stops_before_a_request_that_could_pass_its_cap(monkeypatch, tmp_path):
    """Each request reserves the catalog's whole input limit when its count is only a local estimate, so the
    cap holds against the bill, not against the estimate."""
    from repo_radar.metadata_budget import FULL_CAP_USD
    repo, _base, pristine = setup_pristine(monkeypatch, tmp_path)
    old = im.load_document(pristine, 'app-abc1234')
    counts = FileCounts(50_000)   # two files to a chunk: five chunks, each counted far below the catalog bound
    rate_in, rate_out = Budget(GEMINI).price   # the prices this attempt uses, whatever the date
    expensive = round((13.2 - 20 * rate_out) / rate_in)   # reported prompt tokens: three chunks settle at about $39.60

    fake = GeminiFake(monkeypatch, lambda stage, text: gemini_text('## Analysis\nTwo files.\n', expensive))
    outcome = full_build(pristine, repo, counts)
    per_chunk = expensive * rate_in + 20 * rate_out
    reserve = Budget(GEMINI).upper_bound(1_048_576, 8192)                   # the whole input limit, priced
    assert 3 * per_chunk + reserve > FULL_CAP_USD >= 3 * per_chunk + Budget(GEMINI).upper_bound(101_000, 8192)

    # Three chunks were sent and settled once each; the fourth was refused before sending, and says why.
    assert len(fake.sends) == 3 and {s for s, _t, _b in fake.sends} == {'full'}
    assert outcome.status == 'failed' and outcome.reason.startswith('full chunk 4/5 (call 4): ')
    assert '$40.00 limit' in outcome.reason
    usage = metadata.read_attempt_state(pristine, 'app-abc1234')['usage']
    assert (usage['calls'], usage['unknown_cost_calls'], usage['retained_reservation_usd'], usage['open_reservation_usd']) == (3, 0, 0, 0)
    assert usage['known_cost_usd'] == usage['cost_usd'] == pytest.approx(3 * per_chunk, rel=1e-6)
    assert usage['known_cost_usd'] > 25   # past the old $25 cap: the second and third chunks are now bought
    assert usage['full_stage'] == {'stage': 'chunk', 'call': 4, 'chunk': 4, 'chunks': 5, 'max_output': 8192}
    assert im.load_document(pristine, 'app-abc1234').text == old.text

    # Stopped by its own limit after paying, it is remembered: the same rebuild is now estimated from what it
    # cost and refused before anything is sent.
    state = metadata.read_attempt_state(pristine, 'app-abc1234')
    assert state[im.REBUILD_COST_RATIO] == pytest.approx(3 * per_chunk / (3 * rate_in * mr.FullBuild._raw_tokens(
        types.SimpleNamespace(tokens=101_000, reserve_tokens=0, request={'messages': [{}]}))), rel=0.01)
    fake = GeminiFake(monkeypatch, lambda stage, text: pytest.fail('a remembered limit stop was bought again'))
    again = full_build(pristine, repo, counts)
    assert again.status == 'skipped' and again.reason.startswith('this rebuild is estimated at $'), again
    assert 'uses what the last rebuild cost' in again.reason and again.reason.endswith('wait until the rebuild fits')

    # Cheap replies, in a normal sync's weekly record, once that memory is gone: the same build finishes under the
    # cap, with every chunk and one reduction. It was admitted for the whole $40, recorded each reply once inside
    # that hold, and closing released the rest.
    im.write_state(pristine, 'app-abc1234', {k: v for k, v in metadata.read_attempt_state(pristine, 'app-abc1234').items()
                                             if k != im.REBUILD_COST_RATIO})
    from repo_radar import spending as sp
    record = sp.Spending('stable', store=sp.Store(tmp_path / 'spending'), policy=lambda: (True, 75.0))
    fake = GeminiFake(monkeypatch, lambda stage, text: FULL_REPLY if 'Please synthesize' in text else '## Analysis\nTwo files.\n')
    outcome = full_build(pristine, repo, counts, spending=record)
    assert outcome.status == 'published', outcome
    assert len(fake.sends) == 6 and outcome.usage['calls'] == 6 and outcome.usage['cost_usd'] < 1
    assert im.load_document(pristine, 'app-abc1234').info['pipeline_version'] == im.PIPELINE_VERSION
    [attempt] = json.loads((tmp_path / 'spending' / sp.LEDGER_NAME).read_text())['attempts'].values()
    assert (attempt['allowance'], attempt['status'], len(attempt['sends'])) == (40_000_000, 'closed', 6)
    week = sp.summary(record.store, record.policy)
    assert week['recorded_usd'] == pytest.approx(outcome.usage['cost_usd'], abs=1e-5) and week['reserved_usd'] == 0

    # With less than $40 left this week the next full build isn't admitted: nothing is sent, the document,
    # its failure count and last counted failure stay, and it says what it needed and what remains.
    published = im.load_document(pristine, 'app-abc1234').text
    before = metadata.read_attempt_state(pristine, 'app-abc1234')
    fake = GeminiFake(monkeypatch, lambda stage, text: FULL_REPLY)
    tight = sp.Spending('dev', store=record.store, policy=lambda: (True, 39.99 + week['recorded_usd']))
    outcome = full_build(pristine, repo, counts, spending=tight)
    assert outcome.status == 'skipped' and fake.sends == [] and outcome.usage['calls'] == 0
    assert outcome.reason.startswith('Weekly spending limit: this update needs up to $40.00; $39.99 remains until ')
    after = metadata.read_attempt_state(pristine, 'app-abc1234')
    assert after['consecutive_failures'] == before['consecutive_failures']
    assert after.get('last_failure_reason') == before.get('last_failure_reason')
    assert im.load_document(pristine, 'app-abc1234').text == published


def test_a_protected_rate_limit_gives_its_share_back_and_still_fails(monkeypatch, tmp_path):
    """The protected executor uses the same money rule as legacy sends: a typed 429 was refused without
    charge, so its reservation goes back and closing releases the whole $40. The attempt still fails, with
    the one transport call and no retry, fallback or weekly-cap skip."""
    from repo_radar import spending as sp
    repo, _base, pristine = setup_pristine(monkeypatch, tmp_path)
    old = im.load_document(pristine, 'app-abc1234')
    limited = httpx.Response(429, json={'error': {'code': 429, 'status': 'RESOURCE_EXHAUSTED', 'message': 'quota'}},
                             request=httpx.Request('POST', 'https://x'))
    fake = GeminiFake(monkeypatch, lambda stage, text: limited)
    record = sp.Spending('stable', store=sp.Store(tmp_path / 'spending'), policy=lambda: (True, 75.0))
    outcome = full_build(pristine, repo, FileCounts(10), spending=record)
    assert outcome.status == 'failed' and len(fake.sends) == 1, outcome
    assert (outcome.usage['calls'], outcome.usage['refused_calls'], outcome.usage['unknown_cost_calls']) == (1, 1, 0)
    [attempt] = json.loads((tmp_path / 'spending' / sp.LEDGER_NAME).read_text())['attempts'].values()
    assert attempt['status'] == 'closed' and [s['status'] for s in attempt['sends'].values()] == ['released']
    week = sp.summary(record.store, record.policy)
    assert (week['recorded_usd'], week['reserved_usd'], week['available_usd']) == (0, 0, 75)
    assert im.load_document(pristine, 'app-abc1234').text == old.text

    # A 429 that carries charge evidence is no refund (moved here from the retired full generator's test): the
    # charge is recorded once and the send keeps its bound.
    import litellm
    from repo_radar import llm
    charged = litellm.RateLimitError(message='rate limited', llm_provider='gemini', model=GEMINI)
    charged._hidden_params = {'response_cost': 0.0001}
    billed = sp.Spending('stable', store=sp.Store(tmp_path / 'charged'), policy=lambda: (True, 75.0))
    with monkeypatch.context() as m:
        m.setattr(llm, 'call_model_turn', lambda request, timeout: (_ for _ in ()).throw(charged))
        outcome = full_build(pristine, repo, FileCounts(10), spending=billed)
    assert outcome.status == 'failed' and outcome.usage['refused_calls'] == 0, outcome
    assert outcome.usage['known_cost_usd'] == pytest.approx(0.0001) and outcome.usage['retained_reservation_usd'] > 0
    week = sp.summary(billed.store, billed.policy)
    assert week['recorded_usd'] == pytest.approx(0.0001) and week['reserved_usd'] > 0

    # A Stop landing between two sends is an interruption, not a failure: the update ends skipped, the failure
    # count doesn't move, and the reply that did come back is recorded.
    before = metadata.read_attempt_state(pristine, 'app-abc1234')
    stopping = sp.Spending('stable', store=sp.Store(tmp_path / 'stopped'), policy=lambda: (True, 75.0))

    def first_then_stop(stage, text):
        stopping.request_stop()   # what the Stop handler does first
        return '## Analysis\nTwo files.\n'
    fake = GeminiFake(monkeypatch, first_then_stop)
    outcome = full_build(pristine, repo, FileCounts(50_000), spending=stopping)
    assert outcome.status == 'skipped' and outcome.reason == 'the sync was stopped' and len(fake.sends) == 1, outcome
    after = metadata.read_attempt_state(pristine, 'app-abc1234')
    assert after['consecutive_failures'] == before['consecutive_failures']
    assert after.get('last_failure_reason') == before.get('last_failure_reason')
    assert sp.summary(stopping.store, stopping.policy)['recorded_usd'] == pytest.approx(outcome.usage['known_cost_usd'], abs=1e-5)


def test_test_files_are_counted_but_never_read(monkeypatch, tmp_path):
    """Full builds count test code in the coverage line and never send it; diff updates list a changed test file
    the way they list a lockfile, without its body. A product folder named "Tests" is read as usual."""
    import tempfile
    repo, base, pristine = setup_pristine(monkeypatch, tmp_path)
    tests = {'web-app/src/api.test.ts': 'SENTINEL-JEST', 'supabase/tests/rls.sql': 'SENTINEL-SQL',
             'scripts/__tests__/deploy.ts': 'SENTINEL-DUNDER', 'mobile-api/plan_test.go': 'SENTINEL-GO',
             'ai-service/tests/test_triage.py': 'SENTINEL-PY'}
    for path, text in tests.items():
        repo.write(path, f'// {text}\n')
    repo.write('mobile-app/src/screens/Tests/LabResults.tsx', 'export const LabResults = "PRODUCT-SCREEN"\n')
    target = repo.commit('tests and a lab tests screen')

    files, _omitted, _outside, counted = im.pinned_files(snap.GitSnapshot(repo.path, target), snap.NO_EXCLUSIONS)
    assert counted == len(tests) and 'mobile-app/src/screens/Tests/LabResults.tsx' in {f['path'] for f in files}
    provider = Provider(monkeypatch)
    provider.replies = [claude([{"type": "text", "text": FULL_REPLY}])]
    with PreflightSession() as session:
        outcome = update(pristine, repo, session, force=True)
    assert outcome.status == 'published', outcome
    traffic = json.dumps([b for _p, b in provider.sends]) + json.dumps(provider.counts)
    assert 'SENTINEL' not in traffic and 'PRODUCT-SCREEN' in traffic
    assert f"{len(tests)} test files left out" in im.load_document(pristine, 'app-abc1234').info['coverage']

    # A diff update: the changed test files are listed, their bodies aren't, and the screen's diff is there.
    for path, text in tests.items():
        repo.write(path, f'// {text} changed\n')
    repo.write('mobile-app/src/screens/Tests/LabResults.tsx', 'export const LabResults = "PRODUCT-CHANGE"\n')
    changed = repo.commit('change them all')
    base_snap, target_snap = snap.GitSnapshot(repo.path, target), snap.GitSnapshot(repo.path, changed)
    changes = snap.changes_between(repo.path, target, changed)
    pages = snap.prepare_pages(repo.path, target, changed, base_snap.manifest(), target_snap.manifest(), changes,
                               snap.NO_EXCLUSIONS, tempfile.mkdtemp(dir=tmp_path))
    text = ''.join(pages.read(p) for p in pages.pages)
    assert set(pages.omitted) == {(path, 'test file') for path in tests}
    assert 'SENTINEL' not in text and 'PRODUCT-CHANGE' in text
    assert text.count('test file changed; body not analyzed') == len(tests)


def test_vendor_dist_and_coverage_are_generated_only_at_a_build_root():
    """A source folder named like a build output (an insurance `coverage` module) is analyzed, by incremental
    updates and full builds alike; the same name at the repository root or beside a build manifest is still
    treated as generated."""
    roots = snap.build_roots({'web-app/package.json': None, 'mobile-api/go.mod': None}, {'README.md': None})
    generated = ['coverage/lcov.info', 'dist/app.js', 'web-app/dist/main.js', 'mobile-api/vendor/x/y.go',
                 'src/node_modules/a.js', 'Web-App/Coverage/index.html']
    analyzed = ['mobile-api/internal/coverage/plan.go', 'web-app/src/coverage/rules.ts', 'docs/dist/notes.md']
    assert all(snap.generated_reason(p, roots) == 'generated or vendored' for p in generated)
    assert all(snap.generated_reason(p, roots) is None for p in analyzed)
    assert snap.generated_reason('yarn.lock', roots) == 'lockfile'
    # Full builds' collector uses the same rule: the coverage module is summarized, build output isn't.
    from repo_radar.files import should_include_file
    assert ([should_include_file(p, roots) for p in ('mobile-api/internal/coverage/plan.go', 'web-app/dist/main.js')]
            == [True, False])


def test_full_only_pinned_plan(monkeypatch, tmp_path):
    """The free plan check for full-only repositories: the real decision, pinned collection, FullBuild.prepare
    and allowance, with a deterministic local count and no transport. Selection is full and lists no diff; only
    the pinned commit's bytes are selected, without the credential or the inherited exclusion; the prepared
    request fits; the allowance is the conservative floor; and nothing is sent or admitted while preparing."""
    from repo_radar import llm
    from repo_radar.metadata_budget import FULL_CAP_USD, ESTIMATE_MARGIN
    from repo_radar.model_catalog import get_caps
    repo, base, pristine = setup_pristine(monkeypatch, tmp_path, updated=NOW - timedelta(days=30))
    repo.write('.env', 'API_TOKEN=SENTINEL-CREDENTIAL\n')
    repo.write('src/m0.py', 'pinned = True\n')
    target = repo.commit('second commit')
    repo.write('src/m1.py', 'DIRTY = "SENTINEL-DIRTY"\n')              # an uncommitted edit
    repo.write('src/untracked.py', 'UNTRACKED = "SENTINEL-UNTRACKED"\n')

    def no_send(*a, **k):
        pytest.fail('preparation sent a request')
    monkeypatch.setattr(httpx.HTTPTransport, 'handle_request', no_send)
    monkeypatch.setattr(llm, 'call_model_turn', no_send)
    doc = im.load_document(pristine, 'app-abc1234')
    with monkeypatch.context() as m:
        m.setattr(snap, 'changes_between', lambda *a, **k: pytest.fail('a full-only decision listed a diff'))
        decision = im.decide(repo.path, FULL, doc, None, GEMINI, target, NOW, allow_incremental=False)
    assert (decision.strategy, decision.reason) == ('full', 'the tracked tree changed')

    events = []

    class Record:   # the weekly record: admission is the event to watch
        def admit(self, owner, model, label, amount):
            events.append(('admit', amount))
            return types.SimpleNamespace(close=lambda: None, check_dispatch=lambda: None, reserve=lambda u: [None] * len(u))

    class Stop(Exception):
        pass
    real_prepare = mr.FullBuild.prepare

    def prepare(self):
        plan = real_prepare(self)
        events.append(('prepared', plan, self.budget.hold))
        return plan

    def run(self, plan=None):
        events.append(('run', plan))
        raise Stop
    monkeypatch.setattr(mr.FullBuild, 'prepare', prepare)
    monkeypatch.setattr(mr.FullBuild, 'run', run)
    budget = Budget(GEMINI, cap=FULL_CAP_USD, label='full', spending=Record(), owner=FULL)
    inherited = snap.Exclusions(frozenset({'src/m2.py'}), frozenset())
    with pytest.raises(Stop):
        im.run_full(repo.path, FULL, target, GEMINI, FileCounts(40), budget, baseline=base, inherited=inherited,
                    estimate_allowance=True)

    (kind, plan, hold), (admitted, amount), (ran, sent) = events
    assert (kind, hold, admitted, ran) == ('prepared', None, 'admit', 'run') and sent is plan
    single = plan.single
    assert plan.chunks is None and single.tokens <= single.limit
    request = json.dumps(single.request)
    assert 'pinned = True' in request and 'SENTINEL' not in request and '.env' not in request
    assert 'module 2' not in request and 'module 3' in request   # the inherited exclusion still applies
    floor = Budget(GEMINI).upper_bound(get_caps(GEMINI).max_input, single.output)
    estimate = Budget(GEMINI).upper_bound(single.tokens, single.output)
    assert single.reserve_tokens == get_caps(GEMINI).max_input and ESTIMATE_MARGIN * estimate < floor
    assert amount == budget.extra['admitted_usd'] == pytest.approx(floor, abs=2e-6) and amount < FULL_CAP_USD


def test_full_only_rebuilds_admit_their_estimate_and_hold_after_failures(monkeypatch, tmp_path):
    """A full-only repository through the shared worker: a small local-count plan is admitted for its
    conservative floor and sends; a failure after paid chunks keeps the old document and reports the chunks'
    spend once; two automatic failures hold before any count or send; a manual retry passes the hold but not
    the weekly limit, which skips without moving the streak."""
    from repo_radar import spending as sp
    monkeypatch.setenv('AI_MODEL', GEMINI)
    repo, _base, pristine = setup_pristine(monkeypatch, tmp_path)
    record = sp.Spending('stable', store=sp.Store(tmp_path / 'spending'), policy=lambda: (True, 75.0))

    def change(n):
        repo.write('src/m0.py', f'changed = {n}\n')
        repo.commit(f'change {n}')

    class Counting(FileCounts):
        def count_request(self, request, timeout=None):
            counted.append(request)
            return super().count_request(request, timeout)
    counted = []

    def attempt(session, trigger='schedule', spending=record):
        return im.update_repository(pristine, repo.path, 'app-abc1234', REPO_CONFIG, GEMINI, session, now=NOW,
                                    allow_incremental=False, spending=spending, trigger=trigger)

    change(1)
    fake = GeminiFake(monkeypatch, lambda stage, text: FULL_REPLY)
    outcome = attempt(FileCounts(10))
    assert outcome.status == 'published' and len(fake.sends) == 1, outcome
    [entry] = json.loads((tmp_path / 'spending' / sp.LEDGER_NAME).read_text())['attempts'].values()
    assert entry['allowance'] == round(outcome.usage['admitted_usd'] * 1e6) and outcome.usage['admitted_usd'] < 2

    # Five chunks are paid for, then the reduction comes back cut off: the old document stays, and the five
    # chunks' spend (and the reduction's) is reported once, in the sync's stats and in the weekly record.
    change(2)
    old = (pristine / 'app-abc1234.md').read_text()
    cut_off = gemini_text('## Overview\nCut o', finish='MAX_TOKENS')
    fake = GeminiFake(monkeypatch, lambda stage, text: cut_off if 'Please synthesize' in text else '## Analysis\nTwo files.\n')
    ctx, events = _ctx()
    args = _sync_args(_spending=record, _incremental_repos=frozenset())
    task = (REPO_CONFIG, 'app-abc1234', None, 'app', 'cyan', 1)
    monkeypatch.setenv('REPO_RADAR_TRIGGER', 'schedule')
    S.generate_repo_metadata(task, FileCounts(50_000), args, ctx)
    reported = [f for name, f in events if name == 'metadata_incremental']
    assert len(fake.sends) == 6 and len(reported) == 1 and reported[0]['status'] == 'failed', reported
    assert reported[0]['strategy'] == 'full' and (pristine / 'app-abc1234.md').read_text() == old
    usage = metadata.read_attempt_state(pristine, 'app-abc1234')['usage']
    assert usage['calls'] == 6 and usage['known_cost_usd'] > 0 and ctx.stats['api_cost'] == pytest.approx(usage['known_cost_usd'])
    assert S.generate_repo_metadata(task, FileCounts(50_000), args, ctx) is not None   # a second failure
    state = metadata.read_attempt_state(pristine, 'app-abc1234')
    assert state['consecutive_failures'] == 2

    # Held: nothing is counted, admitted or sent.
    week = sp.summary(record.store, record.policy)
    fake = GeminiFake(monkeypatch, lambda stage, text: FULL_REPLY)
    held = attempt(Counting(10))
    assert held.status == 'skipped' and 'held after 2' in held.reason and not counted and not fake.sends, held
    assert sp.summary(record.store, record.policy)['recorded_usd'] == week['recorded_usd']

    # A manual retry passes the hold, never the money: with too little left this week it isn't admitted.
    tight = sp.Spending('stable', store=record.store, policy=lambda: (True, week['recorded_usd'] + 0.01))
    refused = attempt(FileCounts(10), trigger='manual', spending=tight)
    assert refused.status == 'skipped' and refused.reason.startswith('Weekly spending limit') and not fake.sends
    assert 'admitted_usd' not in refused.usage   # nothing was admitted
    assert metadata.read_attempt_state(pristine, 'app-abc1234')['consecutive_failures'] == 2


@pytest.mark.parametrize('per_file,output_tokens,chunks', [(15_000, 3_000, 2), (26_000, 8_192, 3)])
def test_a_chunked_full_only_plan_fits_its_whole_send_sequence(monkeypatch, tmp_path, per_file, output_tokens, chunks):
    """On a local-count model every chunk and the synthesis reserve the model's whole input limit, and each
    reservation sits on top of what earlier sends cost. The allowance covers that sequence, so a small chunked
    plan with realistic replies publishes instead of paying for its chunks and failing (review round 1)."""
    from repo_radar import spending as sp
    repo, _base, pristine = setup_pristine(monkeypatch, tmp_path)
    repo.write('src/m0.py', 'changed = True\n' + 'x = 1\n' * 100)
    repo.commit('one change')
    record = sp.Spending('stable', store=sp.Store(tmp_path / 'spending'), policy=lambda: (True, 75.0))

    def reply(stage, text):   # each reply reports 120,000 prompt tokens and `output_tokens` out
        data = gemini_text(FULL_REPLY if 'Please synthesize' in text else '## Analysis\nSome files.\n', 120_000).json()
        data['usageMetadata'].update(candidatesTokenCount=output_tokens, totalTokenCount=120_000 + output_tokens)
        return httpx.Response(200, json=data)
    fake = GeminiFake(monkeypatch, reply)
    outcome = im.update_repository(pristine, repo.path, 'app-abc1234', REPO_CONFIG, GEMINI, FileCounts(per_file),
                                   now=NOW, allow_incremental=False, spending=record, trigger='schedule')
    assert outcome.status == 'published', outcome
    assert len(fake.sends) == chunks + 1 and outcome.usage['calls'] == chunks + 1
    assert outcome.usage['known_cost_usd'] < outcome.usage['admitted_usd'] < 40


# ── A weekly rebuild that can't fit waits; the daily update runs ─────────────────────────────────

def _on_date(monkeypatch, day):
    """Pin the clock the attempt's prices are read from (metadata_budget.rate_snapshot)."""
    from repo_radar import metadata_budget

    class Pinned(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(*day, 12, tzinfo=timezone.utc).astimezone(tz) if tz else datetime(*day, 12)
    monkeypatch.setattr(metadata_budget, 'datetime', Pinned)


def _weekly_rebuild_due(monkeypatch, tmp_path, change=True, chunk=(91_000, 2_000), synthesis=(20_000, 2_000)):
    """A Gemini repository whose weekly rebuild is due: ten source files counted at 100,000 tokens each, so ten
    chunks of about 90,900 unpadded tokens and an estimate of about $1.70 today ($3.40 from January). With
    `change`, one changed file for the daily update. Full replies report realistic usage, `chunk` and
    `synthesis` as (input, output) tokens: never the fake's 100 in and 20 out, which would hide what output costs."""
    repo, _base, pristine = setup_pristine(monkeypatch, tmp_path, updated=NOW - timedelta(days=8))
    if change:
        repo.write('src/m0.py', 'changed = True\n')
        repo.commit('one change')

    def reply(stage, text):
        if stage == 'map':
            return {'changes': [], 'questions': None, 'new_sections': None, 'no_summary_change_reason': 'no effect'}
        if stage == 'edit':
            return {'base_document_sha256': im.load_document(pristine, 'app-abc1234').sha256, 'sections': []}
        assert stage == 'full', stage
        final = 'Please synthesize' in text
        tokens, output = synthesis if final else chunk
        data = gemini_text(FULL_REPLY if final else '## Analysis\nOne file.\n', tokens).json()
        data['usageMetadata'].update(candidatesTokenCount=output, totalTokenCount=tokens + output)
        return httpx.Response(200, json=data)
    return repo, pristine, GeminiFake(monkeypatch, reply)


def _sync(pristine, repo, **kw):
    return im.update_repository(pristine, repo.path, 'app-abc1234', REPO_CONFIG, GEMINI, FileCounts(100_000),
                                now=NOW, trigger='schedule', **kw)


@pytest.mark.parametrize('day, limit, rebuilt', [
    ((2026, 11, 12), 1.00, False),   # estimated over the limit
    ((2026, 11, 12), 2.25, True),    # it fits: the rebuild runs as before
    ((2027, 1, 2), 2.25, False),     # the same size at January's price is estimated over it
])
def test_a_weekly_rebuild_estimated_over_its_limit_waits_while_the_daily_update_runs(monkeypatch, tmp_path, day,
                                                                                    limit, rebuilt):
    """Before any paid call, a rebuild estimated over its limit (at the price on the run's date) is refused:
    nothing is admitted or sent, and the same sync publishes the daily incremental update instead. INDEX says the
    rebuild is waiting and why; the weekly rebuild stays due for the next sync. One that fits runs, and what it
    cost per unit of counted input is kept for the next estimate."""
    from repo_radar import metadata_budget, spending as sp
    _on_date(monkeypatch, day)
    monkeypatch.setattr(metadata_budget, 'FULL_CAP_USD', limit)
    repo, pristine, fake = _weekly_rebuild_due(monkeypatch, tmp_path)
    record = sp.Spending('stable', store=sp.Store(tmp_path / 'spending'), policy=lambda: (True, 75.0))
    outcome = _sync(pristine, repo, spending=record)
    assert outcome.status == 'published', outcome
    state = metadata.read_attempt_state(pristine, 'app-abc1234')
    published = im.load_document(pristine, 'app-abc1234')
    attempts = json.loads((tmp_path / 'spending' / sp.LEDGER_NAME).read_text())['attempts'].values()
    if rebuilt:
        assert outcome.strategy == 'full' and len(fake.stage('full')) == 11 and im.REBUILD_WAITING not in state
        assert published.info['generation_strategy'] == 'full' and 'rebuild waiting' not in _index(pristine)
        assert outcome.usage['estimate_usd'] < limit
        # Cost per unit of the chunks' unpadded counted input: their output and the reduction on top of it.
        assert state[im.REBUILD_COST_RATIO] == outcome.usage['cost_ratio'] and 1.05 < state[im.REBUILD_COST_RATIO] < 1.25
        return

    rate = '1.50' if day[0] == 2027 else '0.75'
    waiting = state[im.REBUILD_WAITING]
    assert re.fullmatch(rf"this rebuild is estimated at \$\d+\.\d\d, over its \${limit:.2f} limit \(at \${rate} per "
                        rf"million input tokens\); nothing was spent", waiting), waiting
    assert fake.stage('full') == [] and len(fake.stage('map')) == 1 and len(fake.stage('edit')) == 1
    assert (outcome.strategy, state['strategy'], state['consecutive_failures']) == ('incremental', 'incremental', 0)
    assert published.info['generation_strategy'] == 'incremental' and published.info['last_commit'] == outcome.target
    assert [a['kind'] for a in attempts] == ['incremental']   # the rebuild was never admitted
    assert f"**Status:** ⚠ rebuild waiting: {waiting}" in _index(pristine)
    assert decide(repo, pristine, model=GEMINI).reason == im.WEEKLY_REASON   # still due next time


def test_a_wrong_admission_is_paid_for_once(monkeypatch, tmp_path):
    """Replies near the counted input with near-maximum output: the estimate fits a $1.76 limit but the bill
    doesn't, so the existing stop ends the rebuild before its reduction, after paying for every chunk. What that
    cost is remembered, so the next syncs refuse the same rebuild before spending and the daily update runs,
    even after a daily update publishes a new document. A higher limit admits it again."""
    from repo_radar import metadata_budget
    _on_date(monkeypatch, (2026, 11, 12))
    monkeypatch.setattr(metadata_budget, 'FULL_CAP_USD', 1.76)
    repo, pristine, fake = _weekly_rebuild_due(monkeypatch, tmp_path, change=False, chunk=(91_000, 8_000))

    first = _sync(pristine, repo)   # admitted at about $1.70; the reduction's reservation needs about $1.83
    assert first.status == 'failed' and 'limit' in first.reason and len(fake.stage('full')) == 10, first
    assert first.usage['estimate_usd'] <= 1.76 and first.usage['limit_stop'] is True
    state = metadata.read_attempt_state(pristine, 'app-abc1234')
    paid, ratio = first.usage['known_cost_usd'], state[im.REBUILD_COST_RATIO]
    assert state['consecutive_failures'] == 1 and ratio == first.usage['cost_ratio'] > 1.25

    repo.write('src/m1.py', 'changed = True\n')
    repo.commit('one change')
    fake.sends.clear()
    second = _sync(pristine, repo)
    assert (second.status, second.strategy) == ('published', 'incremental') and fake.stage('full') == [], second
    state = metadata.read_attempt_state(pristine, 'app-abc1234')
    assert state['consecutive_failures'] == 0 and state[im.REBUILD_COST_RATIO] == ratio
    assert 'uses what the last rebuild cost' in state[im.REBUILD_WAITING]
    estimate = float(re.search(r'estimated at \$(\d+\.\d\d)', state[im.REBUILD_WAITING]).group(1))
    from repo_radar.model_catalog import get_caps
    from repo_radar import llm
    reduction = Budget(GEMINI).upper_bound(get_caps(GEMINI).max_input, llm.output_budget(GEMINI, llm.SYNTHESIS_OUTPUT_TOKENS))
    assert estimate >= round(1.05 * paid + reduction, 2) > 1.76   # at least what it paid, plus the refused reservation
    assert 'rebuild waiting' in _index(pristine)

    fake.sends.clear()   # the memory survived that publish: still refused, and with nothing changed, only a skip
    third = _sync(pristine, repo)
    assert (third.status, third.strategy) == ('skipped', 'full') and not fake.sends, third
    assert 'uses what the last rebuild cost' in third.reason

    monkeypatch.setattr(metadata_budget, 'FULL_CAP_USD', 2.00)
    fourth = _sync(pristine, repo)
    assert (fourth.status, fourth.strategy) == ('published', 'full') and len(fake.stage('full')) == 11, fourth


def test_a_wrong_refusal_costs_nothing(monkeypatch, tmp_path):
    """Replies at 80% of the counted input with 20 output tokens would have fit a $1.65 limit, but the estimate
    (about $1.70) doesn't, so the rebuild is refused before spending and the daily update runs. An accepted
    mistake: it costs $0 and INDEX says why, where a wrong admission costs a whole attempt."""
    from repo_radar import metadata_budget, llm
    from repo_radar.model_catalog import get_caps
    _on_date(monkeypatch, (2026, 11, 12))
    monkeypatch.setattr(metadata_budget, 'FULL_CAP_USD', 1.65)
    repo, pristine, fake = _weekly_rebuild_due(monkeypatch, tmp_path, chunk=(80_800, 20), synthesis=(1_000, 20))
    refused = _sync(pristine, repo)
    assert (refused.status, refused.strategy) == ('published', 'incremental') and fake.stage('full') == [], refused
    assert 'estimated at $1.70' in metadata.read_attempt_state(pristine, 'app-abc1234')[im.REBUILD_WAITING]

    # The same rebuild, admitted under a higher limit, never needed more than $1.65: its whole bill plus the
    # reduction's reservation (the most it ever had committed) is well under it.
    monkeypatch.setattr(metadata_budget, 'FULL_CAP_USD', 1.75)
    repo, pristine, fake = _weekly_rebuild_due(monkeypatch, tmp_path / 'again', chunk=(80_800, 20), synthesis=(1_000, 20))
    admitted = _sync(pristine, repo)
    assert (admitted.status, admitted.strategy) == ('published', 'full'), admitted
    reduction = Budget(GEMINI).upper_bound(get_caps(GEMINI).max_input, llm.output_budget(GEMINI, llm.SYNTHESIS_OUTPUT_TOKENS))
    assert admitted.usage['known_cost_usd'] + reduction < 1.65


def test_a_weekly_cap_refusal_also_falls_through_to_the_daily_update(monkeypatch, tmp_path):
    """The weekly cap refusing the rebuild's $40 is also a refusal before any spend: the daily update runs and is
    admitted for its own small quote. A forced rebuild refused the same way only skips, as before."""
    from repo_radar import spending as sp
    _on_date(monkeypatch, (2026, 11, 12))
    repo, pristine, fake = _weekly_rebuild_due(monkeypatch, tmp_path)
    tight = sp.Spending('stable', store=sp.Store(tmp_path / 'spending'), policy=lambda: (True, 5.0))
    outcome = im.update_repository(pristine, repo.path, 'app-abc1234', REPO_CONFIG, GEMINI, FileCounts(1_000),
                                   now=NOW, spending=tight, trigger='schedule')
    assert (outcome.status, outcome.strategy) == ('published', 'incremental'), outcome
    assert fake.stage('full') == [] and len(fake.stage('edit')) == 1
    waiting = metadata.read_attempt_state(pristine, 'app-abc1234')[im.REBUILD_WAITING]
    assert waiting.startswith('Weekly spending limit: this update needs up to $40.00; $5.00 remains until ')
    [attempt] = json.loads((tmp_path / 'spending' / sp.LEDGER_NAME).read_text())['attempts'].values()
    assert attempt['kind'] == 'incremental' and attempt['allowance'] < 5_000_000

    forced = im.update_repository(pristine, repo.path, 'app-abc1234', REPO_CONFIG, GEMINI, FileCounts(1_000),
                                  now=NOW, spending=tight, force=True)
    assert (forced.status, forced.strategy) == ('skipped', 'full') and forced.reason.startswith('Weekly spending limit')
    assert fake.stage('full') == [] and len(fake.stage('edit')) == 1


def test_a_refused_rebuild_with_nothing_to_update_keeps_the_failure_streak(monkeypatch, tmp_path):
    """With no source change since the document there is no daily update to run: the refused rebuild is a skip,
    not a failure, so the streak and its last counted failure stay as they were, and INDEX says why once."""
    from repo_radar import metadata_budget
    _on_date(monkeypatch, (2026, 11, 12))
    monkeypatch.setattr(metadata_budget, 'FULL_CAP_USD', 1.00)
    repo, pristine, fake = _weekly_rebuild_due(monkeypatch, tmp_path, change=False)
    doc = im.load_document(pristine, 'app-abc1234')
    im.write_state(pristine, 'app-abc1234', {
        'strategy': 'full', 'status': 'failed', 'decision_reason': im.WEEKLY_REASON, 'reason': 'turn limit',
        'full_rebuild_origin': im.WEEKLY_REASON, 'baseline_doc_sha256': doc.sha256, 'consecutive_failures': 1,
        'last_failure_reason': 'turn limit', im.FAILURE_STREAK_DOC: doc.sha256})
    outcome = _sync(pristine, repo)
    assert (outcome.status, outcome.strategy) == ('skipped', 'full') and not fake.sends, outcome
    assert outcome.reason.startswith("this rebuild is estimated at $") and 'over its $1.00 limit' in outcome.reason
    state = metadata.read_attempt_state(pristine, 'app-abc1234')
    assert (state['consecutive_failures'], state['last_failure_reason']) == (1, 'turn limit')
    assert im.load_document(pristine, 'app-abc1234').text == doc.text
    index = _index(pristine)
    assert index.count(outcome.reason) == 1 and 'rebuild waiting' not in index


def test_a_count_lost_after_paid_work_is_a_failure_that_holds(monkeypatch, tmp_path):
    """Once anything has been paid for, a count that stops being available ends the attempt as failed, not
    skipped, so the failure streak advances and automatic syncs can't keep buying the same work."""
    repo, _base, pristine = setup_pristine(monkeypatch, tmp_path)
    old = im.load_document(pristine, 'app-abc1234')
    provider = Provider(monkeypatch)
    down = httpx.Response(503, json={}, request=httpx.Request('POST', 'https://x'))

    def text_of(body):
        content = body['messages'][0]['content']
        return content if isinstance(content, str) else ''.join(b['text'] for b in content)
    # A full build in chunks, whose reduction can't be counted once the chunks are bought.
    provider.count_tokens = lambda body: down if provider.messages() else 21 * len(json.dumps(body['messages']))
    provider.replies = [lambda body: claude([{"type": "text", "text": f"analysis {len(provider.sends)}"}])] * 20
    with PreflightSession() as session:
        outcome = update(pristine, repo, session, force=True)
    sends = provider.messages()
    assert sends and all('(chunk ' in text_of(b) for b in sends)
    assert outcome.status == 'failed' and outcome.reason.startswith('full synthesis: token count unavailable'), outcome
    state = metadata.read_attempt_state(pristine, 'app-abc1234')
    assert state['consecutive_failures'] == 1 and state['usage']['calls'] == len(sends)
    assert im.load_document(pristine, 'app-abc1234').text == old.text

    # The same for an incremental update whose editor can't be counted after the paid map call.
    repo, _base, pristine = setup_pristine(monkeypatch, tmp_path / 'diff')
    repo.write('src/m0.py', 'changed = 1\n')
    repo.commit()
    provider.sends.clear(); provider.counts.clear()
    provider.count_tokens = lambda body: down if provider.messages() else 1000
    provider.replies = [note()]
    with PreflightSession() as session:
        outcome = update(pristine, repo, session)
    assert outcome.status == 'failed' and 'token count unavailable' in outcome.reason and len(provider.messages()) == 1
    assert metadata.read_attempt_state(pristine, 'app-abc1234')['consecutive_failures'] == 1

    # Before anything is paid for, an unavailable count is still only a skip.
    provider.sends.clear(); provider.counts.clear()
    provider.count_tokens = lambda body: down
    with PreflightSession() as session:
        outcome = update(pristine, repo, session)
    assert outcome.status == 'skipped' and not provider.messages()
    assert metadata.read_attempt_state(pristine, 'app-abc1234')['consecutive_failures'] == 1


def frames(text):
    """(path, content) for every file framed in a chunk prompt, read by its stated size."""
    return [(m.group(1), text[m.end():m.end() + int(m.group(2))])
            for m in re.finditer(r'^=== (.+?) \((\d+) bytes\) ===\n', text, re.M)]


def test_full_requests_fit_the_128k_target_whole_and_in_order(monkeypatch, tmp_path):
    from repo_radar import llm
    repo, _base, pristine = setup_pristine(monkeypatch, tmp_path)
    repo.write('src/big.py', ''.join(f'big_line_{n:04d} = {n}\n' for n in range(500)))   # too big for any one chunk
    target = repo.commit('a big file')
    expected = [(f['path'], f['content'])
                for f in im.pinned_files(snap.GitSnapshot(repo.path, target), snap.NO_EXCLUSIONS)[0]]
    old = im.load_document(pristine, 'app-abc1234')
    provider = Provider(monkeypatch)

    def text_of(body):
        content = body['messages'][0]['content']
        return content if isinstance(content, str) else ''.join(b['text'] for b in content)

    def run(scale, per_analysis=0):
        def tokens(body):
            return scale * len(json.dumps(body['messages'])) + per_analysis * text_of(body).count('--- Analysis Part')
        provider.count_tokens, provider.sends[:], provider.counts[:] = tokens, [], []
        provider.replies = [lambda body: claude([{"type": "text", "text": f"analysis of chunk {len(provider.sends)}"
                                                  if '(chunk ' in text_of(body) else FULL_REPLY}])] * 60
        with PreflightSession() as session:
            outcome = update(pristine, repo, session, force=True)
        return outcome, provider.messages(), [tokens(b) for b in provider.messages()]

    # Below the target the whole repository goes out as one request.
    outcome, sends, sizes = run(2)
    assert outcome.status == 'published' and len(sends) == 1 and sizes[0] <= 128_000, outcome
    assert text_of(sends[0]).startswith('Analyze this repository') and frames(text_of(sends[0])) == expected

    # The same repository counted above the target, though far inside the old 75%-of-window rule, is chunked.
    single = 21 * len(json.dumps([{'role': 'user', 'content': llm._build_full_repo_prompt(FULL, [
        {'path': p, 'size': len(c), 'content': c} for p, c in expected])}]))
    from repo_radar.model_catalog import get_caps
    assert 128_000 < single < 0.75 * get_caps(MODEL).max_input   # the retired path's window would have taken it whole
    outcome, sends, sizes = run(21)
    assert outcome.status == 'published', outcome
    counted = [c['messages'] for c in provider.counts]
    assert all(size <= 128_000 for size in sizes) and all(b['messages'] in counted for b in sends)
    chunks, final = [text_of(b) for b in sends[:-1]], text_of(sends[-1])
    assert len(chunks) > 3 and all(f"(chunk {i}/{len(chunks)})" in text for i, text in enumerate(chunks, 1))
    assert all(b['max_tokens'] == 16384 for b in sends)   # this model's floor for chunks, and synthesis's own
    # Every file, in order and whole; the big one as ordered parts.
    pieces = [frame for text in chunks for frame in frames(text)]
    assert [p for p, _c in pieces if 'big.py' in p] == [f'src/big.py (part {n})' for n in range(1, len(
        [p for p, _c in pieces if 'big.py' in p]) + 1)] and len([p for p, _c in pieces if 'big.py' in p]) > 1
    rebuilt = []
    for path, content in pieces:
        source = path.split(' (part ')[0]
        if rebuilt and rebuilt[-1][0] == source and ' (part ' in path and not path.endswith('(part 1)'):
            rebuilt[-1] = (source, rebuilt[-1][1] + content)
        else:
            rebuilt.append((source, content))
    assert rebuilt == expected

    # A part that stops fitting once the chunk total grows is split again, and the later parts move up, so
    # labels stay unique and in order.
    class PerCharacter:
        def count_request(self, request, timeout=None):
            from repo_radar.preflight import PreflightResult
            return PreflightResult(74 * len(request['messages'][0]['content']), False, 'local estimate')
    text = ''.join(f'line_{n:04d} = {n}\n' for n in range(160))[:3000]
    build = mr.FullBuild(FULL, [{'path': 'src/one.py', 'size': len(text), 'content': text}], GEMINI, PerCharacter(),
                         Budget(GEMINI))
    resplit = [f for chunk in build.chunks() for f in chunk.files]
    assert [f['path'] for f in resplit] == [f'src/one.py (part {n})' for n in range(1, len(resplit) + 1)]
    assert len(resplit) > 3 and ''.join(f['content'] for f in resplit) == text
    # The one reduction holds every chunk's analysis, in order.
    assert [final.index(f"analysis of chunk {i}") for i in range(1, len(chunks) + 1)] == sorted(
        final.index(f"analysis of chunk {i}") for i in range(1, len(chunks) + 1))
    assert final.count('--- Analysis Part') == len(chunks)

    # When the reductions can't converge within the depth guard, the build stops; nothing is excerpted.
    monkeypatch.setattr(llm, 'SYNTHESIS_MAX_DEPTH', 1)
    current = im.load_document(pristine, 'app-abc1234')
    outcome, sends, sizes = run(21, per_analysis=30_000)   # two analyses to a reduction
    assert outcome.status == 'failed' and "still don't fit one request after 1 levels" in outcome.reason
    assert all(size <= 128_000 for size in sizes) and not any('truncated' in text_of(b) for b in sends)
    assert im.load_document(pristine, 'app-abc1234').text == current.text != old.text
    # The call guard stops it the same way (kept from the retired generator's synthesis tests).
    monkeypatch.setattr(llm, 'SYNTHESIS_MAX_DEPTH', 4)
    monkeypatch.setattr(llm, 'SYNTHESIS_MAX_CALLS', 1)
    outcome, sends, _sizes = run(21, per_analysis=30_000)
    assert outcome.status == 'failed' and 'would need more than 1 synthesis calls' in outcome.reason, outcome
    assert im.load_document(pristine, 'app-abc1234').text == current.text


def test_full_chunk_requests_ask_for_all_eight_subjects(monkeypatch, tmp_path):
    repo, _base, pristine = setup_pristine(monkeypatch, tmp_path)
    fake = GeminiFake(monkeypatch, lambda stage, text: FULL_REPLY if 'Please synthesize' in text else '## Analysis\n')
    assert full_build(pristine, repo, FileCounts(50_000)).status == 'published'
    chunk_text, chunk = fake.sends[0][1], fake.sends[0][2]
    for n, subject in enumerate(('Overview', 'Technology Stack', 'Architecture', 'Key Components', 'API Endpoints/Interfaces',
                                 'Dependencies', 'Database Schema', 'Configuration'), 1):
        assert f"{n}. **{subject}**" in chunk_text
    assert 'not present here' in chunk_text and '(chunk 1/5)' in chunk_text
    configs = [body['generationConfig'] for _s, _t, body in fake.sends]
    assert [c['max_output_tokens'] for c in configs] == [8192] * 5 + [16384]
    assert all(c['thinkingConfig']['thinkingLevel'] == 'low' for c in configs) and chunk['generationConfig'] == configs[0]


def credential_traffic(provider, pristine, repo):
    """One published update, with every map call answered and the editor changing nothing. Returns what
    went to the provider, counts included, and the published document."""
    doc = im.load_document(pristine, 'app-abc1234')
    provider.sends.clear(); provider.counts.clear()
    provider.replies = [lambda body: answer({'base_document_sha256': doc.sha256, 'sections': []}) if 'tools' in body
                        else note()] * 50
    with PreflightSession() as session:
        outcome = update(pristine, repo, session)
    assert outcome.status == 'published', outcome
    return json.dumps([b for _p, b in provider.sends]) + json.dumps(provider.counts), im.load_document(pristine, 'app-abc1234')


def later_edit_stays_withheld(provider, pristine, repo, path):
    """Across the publication, only the document's record still knows what `path` is."""
    repo.write(path, (repo.path / path).read_text() + 'export LATER=SENTINEL-LATER\n')
    repo.write('src/m1.py', 'later = "ordinary source"\n')
    repo.commit('edit it again')
    traffic, doc = credential_traffic(provider, pristine, repo)
    manifest = snap.GitSnapshot(repo.path, doc.info['last_commit']).manifest()
    protected = im.document_exclusions(doc)
    assert 'SENTINEL' not in traffic and 'ordinary source' in traffic
    assert path in protected.paths and manifest[path].oid in protected.oids


def test_a_credential_moved_within_a_restructure_past_gits_rename_limit_stays_withheld(monkeypatch, tmp_path):
    repo, _base, pristine = setup_pristine(monkeypatch, tmp_path)
    repo.write('.envrc', 'export TOKEN=SENTINEL-OLD\n' + ''.join(f'export V{i}={i}\n' for i in range(40)))
    for i in range(1100):   # under vendor/, so the bulk costs no per-file diffs, yet still counts for rename detection
        repo.write(f'vendor/old/d{i}.py', f'# old {i}\n' + ''.join(f'val_{i}_{n} = {n}\n' for n in range(6)))
    base = repo.commit('a credential and a lot of code')
    (pristine / 'app-abc1234.md').write_text(legacy_document('app-abc1234', base, NOW - timedelta(days=1)))
    repo.git('rm', '-rq', 'vendor/old')
    for i in range(1100):
        repo.write(f'vendor/new/a{i}.py', f'# unrelated {i}\n' + ''.join(f'other_{i}_{n} = "{n * 7}"\n' for n in range(9)))
    repo.git('mv', '.envrc', 'src/runtime.py')
    repo.write('src/runtime.py', (repo.path / 'src/runtime.py').read_text() + 'export Z=SENTINEL-EDIT\n')
    repo.write('src/m0.py', 'visible = "ordinary source"\n')
    repo.commit('restructure, moving the credential too')
    provider = Provider(monkeypatch)
    traffic, doc = credential_traffic(provider, pristine, repo)
    assert 'SENTINEL' not in traffic and 'ordinary source' in traffic
    assert 'src/runtime.py' in im.document_exclusions(doc).paths
    later_edit_stays_withheld(provider, pristine, repo, 'src/runtime.py')


def test_an_edited_copy_of_an_unchanged_credential_stays_withheld(monkeypatch, tmp_path):
    repo, _base, pristine = setup_pristine(monkeypatch, tmp_path)
    secret = 'export TOKEN=SENTINEL-OLD\n' + ''.join(f'export V{i}={i}\n' for i in range(40))
    repo.write('.envrc', secret)
    ordinary = ''.join(f'def handler_{i}():\n    return {i}\n' for i in range(30))
    repo.write('src/common.py', ordinary)
    base = repo.commit('a credential')
    (pristine / 'app-abc1234.md').write_text(legacy_document('app-abc1234', base, NOW - timedelta(days=1)))
    repo.write('src/settings.txt', secret + 'export Z=SENTINEL-EDIT\n')   # .envrc itself doesn't change
    repo.write('src/m0.py', 'visible = "ordinary source"\n')
    # An ordinary copy whose source also changed: its diff shows the copy alone, and the source's change once.
    repo.write('src/common.py', ordinary + 'SOURCE_ONLY_CHANGE = 1\n')
    repo.write('src/common_copy.py', ordinary + 'COPY_ONLY_CHANGE = 2\n')
    target = repo.commit('copy the credential and edit the copy')
    changes = snap.changes_between(repo.path, base, target)
    assert ('C', 'src/common.py', 'src/common_copy.py') in [tuple(c) for c in changes]
    provider = Provider(monkeypatch)
    traffic, doc = credential_traffic(provider, pristine, repo)
    assert 'SENTINEL' not in traffic and 'ordinary source' in traffic
    maps = json.dumps([b for b in provider.messages() if 'tools' not in b])
    assert maps.count('SOURCE_ONLY_CHANGE') == 1 and maps.count('COPY_ONLY_CHANGE') == 1
    assert 'src/settings.txt' in im.document_exclusions(doc).paths
    later_edit_stays_withheld(provider, pristine, repo, 'src/settings.txt')


def test_a_quote_over_the_cap_sends_nothing_and_waves_reserve_together(monkeypatch, tmp_path):
    repo, _base, pristine = setup_pristine(monkeypatch, tmp_path)
    rewrite_files(repo, 80)
    small_pages(monkeypatch, 4096)
    provider = Provider(monkeypatch)
    old = im.load_document(pristine, 'app-abc1234')
    # Each map request alone is well inside the cap; the whole update isn't.
    provider.count_tokens = lambda body: 900_000 if 'tools' not in body else 1000
    quoted, real_admission = [], mr.Pipeline.admission

    def admission(self):
        quoted.append((self, real_admission(self)))
        return quoted[-1][1]
    monkeypatch.setattr(mr.Pipeline, 'admission', admission)
    with PreflightSession() as session:
        outcome = update(pristine, repo, session)
    assert outcome.status == 'skipped' and 'limit' in outcome.reason and 'up to $' in outcome.reason
    assert provider.counts and not provider.messages() and outcome.usage['calls'] == 0
    assert im.load_document(pristine, 'app-abc1234').text == old.text
    assert outcome.usage['estimated_total_usd'] > 12

    # The quote prices all four editor turns at the full request ceiling execution allows, not at the
    # smaller budget the first request is prepared to.
    from repo_radar import llm
    from repo_radar.model_catalog import acceptance_budget
    pipeline, quote = quoted[0]
    out = {stage: llm.output_budget(MODEL, size) for stage, size in
           (('map', mr.MAP_OUTPUT), ('merge', mr.MERGE_OUTPUT), ('edit', mr.EDIT_OUTPUT))}
    ceiling = min(mr.EDIT_REQUEST_TOKENS, acceptance_budget(MODEL, out['edit']))
    assert ceiling == mr.EDIT_REQUEST_TOKENS > mr.EDIT_PREPARE_TOKENS
    bound = pipeline.budget.upper_bound
    assert quote.total_usd == pytest.approx(
        bound(quote.map_input_tokens, out['map'] * quote.map_calls)
        + bound(mr.MERGE_INPUT_TOKENS * quote.merge_calls, out['merge'] * quote.merge_calls)
        + bound(ceiling * mr.EDIT_TURNS, out['edit'] * mr.EDIT_TURNS))

    # Slow counts spend the attempt's time: the last count is clamped to what's left, and an expired
    # admission buys nothing.
    class SlowCounts:
        def __init__(self, inner):
            self.inner, self.timeouts, self.now = inner, [], 0.0

        def count_request(self, request, timeout=None):
            self.timeouts.append(timeout)
            self.now += 500.0
            return self.inner.count_request(request)
    provider.count_tokens = 1000
    with PreflightSession() as session:
        slow = SlowCounts(session)
        expired = Budget(MODEL, cap=12.0, label='incremental')
        with pytest.raises(im.StaleUpdate, match='ran out of time'):
            im.run_incremental(repo.path, FULL, old, decide(repo, pristine), MODEL, slow, expired, clock=lambda: slow.now)
    assert len(slow.timeouts) == 3 and slow.timeouts[-1] == pytest.approx(200.0)
    assert not provider.messages() and expired.committed() == 0 and expired.summary()['calls'] == 0
    assert im.load_document(pristine, 'app-abc1234').text == old.text

    # A count cut short by that deadline returns at once, and doesn't mark the provider as unavailable.
    import asyncio
    from repo_radar import preflight
    real_count = preflight._anthropic_count_request

    async def stuck(request):
        await asyncio.sleep(30)
    monkeypatch.setattr(preflight, '_anthropic_count_request', stuck)
    plain = {'endpoint': 'chat', 'model': MODEL, 'messages': [{'role': 'user', 'content': 'hi'}], 'max_tokens': 10}
    with PreflightSession() as session:
        cut_short = session.count_request(plain, timeout=0.01)
        assert cut_short.tokens is None and cut_short.reason == 'TimeoutError'
        monkeypatch.setattr(preflight, '_anthropic_count_request', real_count)
        assert session.count_request(plain, timeout=5).authoritative

    # Git that says nothing until it's killed: selection and preparation stop at the attempt's one shared
    # deadline, the process is reaped, partial output is dropped, and nothing is bought or changed.
    real_which = shutil.which
    real_git, spawned = real_which('git'), []
    real_popen = subprocess.Popen

    def slow_git(word):
        script = tmp_path / f'git-slow-{word.strip("-")}'
        script.write_text(f'#!/bin/sh\ncase "$*" in *{word}*) printf partial; exec sleep 30;; esac\nexec {real_git} "$@"\n')
        script.chmod(0o755)
        monkeypatch.setattr(snap.shutil, 'which', lambda name: str(script))

    def spy(*args, **kw):
        spawned.append(real_popen(*args, **kw))
        return spawned[-1]
    monkeypatch.setattr(snap.subprocess, 'Popen', spy)
    provider.sends.clear(); provider.counts.clear()
    slow_git('diff-tree')
    started = time.monotonic()
    with pytest.raises(snap.ResourceLimit, match='ran out of time'):
        decide(repo, pristine, deadline=snap.Deadline(0.2))
    assert time.monotonic() - started < 10 and spawned[-1].returncode is not None   # killed and reaped, no 30 s wait
    monkeypatch.setattr(im, 'ATTEMPT_SECONDS', 0.2)
    before = len(spawned)
    with PreflightSession() as session:
        stopped = update(pristine, repo, session)
    assert stopped.status == 'skipped' and 'ran out of time' in stopped.reason and all(p.returncode is not None for p in spawned[before:])
    assert im.load_document(pristine, 'app-abc1234').text == old.text
    assert metadata.read_attempt_state(pristine, 'app-abc1234')['reason'] == stopped.reason
    monkeypatch.setattr(im, 'ATTEMPT_SECONDS', 20 * 60)
    monkeypatch.setattr(snap.shutil, 'which', real_which)
    decision = decide(repo, pristine)
    slow_git('--no-textconv')
    held = Budget(MODEL, cap=12.0, label='incremental')
    with PreflightSession() as session, pytest.raises(im.StaleUpdate, match='ran out of time') as caught:
        im.run_incremental(repo.path, FULL, old, decision, MODEL, session, held, deadline=snap.Deadline(0.2))
    assert caught.value.warning and held.committed() == 0 and spawned[-1].returncode is not None
    assert not provider.messages() and not provider.counts
    before = len(spawned)
    with pytest.raises(snap.ResourceLimit):   # an expired deadline doesn't even start Git
        snap.run_git(repo.path, ['status'], 1024, snap.Deadline(0))
    assert len(spawned) == before
    monkeypatch.setattr(snap.shutil, 'which', real_which)
    monkeypatch.setattr(snap.subprocess, 'Popen', real_popen)

    # Preparation gets what selection left of the allowance, never a fresh one.
    now, lefts = [0.0], []
    real_changes = snap.changes_between

    def timed_changes(repo_path, base, target, deadline=None):
        lefts.append(deadline.left())
        now[0] += 700.0
        return real_changes(repo_path, base, target, deadline)
    monkeypatch.setattr(snap, 'changes_between', timed_changes)
    (pristine / '.metadata-state' / 'app-abc1234.json').unlink()
    provider.count_tokens = 1000
    with PreflightSession() as session:
        update(pristine, repo, session, clock=lambda: now[0])
    monkeypatch.setattr(snap, 'changes_between', real_changes)
    assert lefts == [pytest.approx(1200.0), pytest.approx(500.0)]
    provider.count_tokens = lambda body: 900_000 if 'tools' not in body else 1000
    provider.sends.clear(); provider.counts.clear()

    # A wave's requests are checked together, so they can't each pass against the same remaining budget,
    # and a refused wave leaves nothing reserved, in memory or on disk.
    path = tmp_path / 'ledger.json'
    budget = Budget(MODEL, cap=1.0, ledger=Ledger(path, 40.0, {'replay': 16.0}), label='replay')
    each = (0, 40_000)   # $0.40
    with pytest.raises(BudgetExceeded, match='next 3 requests'):
        budget.reserve_many([({'r': i}, *each) for i in range(3)])
    assert budget.committed() == 0 and not json.loads(path.read_text())['entries']
    with pytest.raises(BudgetExceeded, match='appears twice'):
        budget.reserve_many([({'r': 1}, *each), ({'r': 1}, *each)])
    held = budget.reserve_many([({'r': i}, *each) for i in range(2)])
    assert budget.committed() == pytest.approx(0.8) and len(json.loads(path.read_text())['entries']) == 2
    for reservation in held:
        budget.settle(reservation, types.SimpleNamespace(input_tokens=1, output_tokens=1), 0.1)
    budget.admit(0.7)
    with pytest.raises(BudgetExceeded, match='limit'):
        budget.admit(0.9)
    assert len(json.loads(path.read_text())['entries']) == 2   # admission isn't a charge

    # The rate snapshot follows the announced January price, and a reply is charged at least that.
    january = Budget(GEMINI, now=datetime(2027, 1, 1, tzinfo=timezone.utc))
    assert january.price == (1.5e-6, 7.5e-6)
    usage = types.SimpleNamespace(input_tokens=1_000_000, output_tokens=0 + 1)
    assert january.settle(january.reserve({'r': 1}, 1_000_000, 1), usage, 0.75) == pytest.approx(1.5 + 7.5e-6)
    assert Budget(GEMINI, now=datetime(2026, 11, 4, tzinfo=timezone.utc)).price == (0.75e-6, 3.75e-6)
    # The "latest" alias has the same floor, and a table price above the floor is never lowered.
    assert Budget('gemini/gemini-flash-latest', now=datetime(2027, 1, 1, tzinfo=timezone.utc)).price == (1.5e-6, 7.5e-6)
    assert Budget('gemini/gemini-flash-latest', now=datetime(2026, 12, 31, 1, tzinfo=timezone.utc)).rates.announced
    # Only Gemini's priority and flex rates are left out: no service tier means Standard there, but
    # OpenAI's means the project's configured tier, which may be priority.
    import litellm
    rates = {'input_cost_per_token': 1e-6, 'output_cost_per_token': 2e-6, 'input_cost_per_token_priority': 3e-6,
             'output_cost_per_token_priority': 6e-6, 'input_cost_per_token_batches': 9e-6}
    monkeypatch.setitem(litellm.model_cost, 'gpt-synthetic', rates)
    monkeypatch.setitem(litellm.model_cost, 'gemini/gemini-synthetic', rates)
    assert Budget('gpt-synthetic').price == (3e-6, 6e-6) and Budget('gemini/gemini-synthetic').price == (1e-6, 2e-6)


PILOT_REPO = 'ReperioHealth/reperio-telehealth'


def load_pilot():
    import importlib.util
    from pathlib import Path
    path = Path(__file__).resolve().parents[2] / 'scripts' / 'pilot-incremental-metadata.py'
    spec = importlib.util.spec_from_file_location('pilot_incremental_metadata', path)
    pilot = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(pilot)
    return pilot


def run_pilot(pilot_dir, repo, baseline_text, mode, target):
    """Run the pilot script in-process (sockets stay blocked) from `baseline_text`, which is renamed
    to the pilot repository. Returns (pilot_dir, the results JSON)."""
    pilot_dir.mkdir(parents=True, exist_ok=True)
    (pilot_dir / 'baseline.md').write_text(baseline_text.replace(FULL, PILOT_REPO))
    pilot = load_pilot()
    pilot.main([mode, '--pilot-dir', str(pilot_dir), '--repo-path', str(repo.path), '--target', target,
                '--model', MODEL])
    return pilot_dir, json.loads((pilot_dir / f'results-{mode}.json').read_text())


# ── 3. The real request boundary ─────────────────────────────────────────────────────────────────

def test_complete_requests_are_counted_and_charged(monkeypatch, tmp_path):
    repo, base, pristine = setup_pristine(monkeypatch, tmp_path)
    repo.write('src/m0.py', (repo.path / 'src/m0.py').read_text() + 'def new():\n    pass\n')
    repo.commit()
    provider = Provider(monkeypatch)
    doc = im.load_document(pristine, 'app-abc1234')
    provider.replies = [note(), tool_use('read_file', {'path': 'src/m0.py', 'limit': 3}),
                        answer({'base_document_sha256': doc.sha256, 'sections': []})]
    # A stray request through the same transport (here a model-map GET) fails locally: no reply
    # consumed, nothing recorded, and the next real request still gets the intended reply.
    with pytest.raises(httpx.ConnectError), httpx.Client() as client:
        client.get('https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json')
    assert len(provider.replies) == 3 and not provider.sends
    with PreflightSession() as session:
        assert update(pristine, repo, session).status == 'published'
    sends = provider.messages()
    assert len(sends) == 3 and len(provider.sends) == 3
    # The map call is counted once. The editor is counted without notes for the quote, with them to check
    # it fits, then with the tool result's placeholder and with the result itself.
    assert len(provider.counts) == 5 and 'tools' not in provider.counts[0]
    # The last request is counted exactly as it is sent: tools, the thinking block, the tool result.
    count, send = provider.counts[-1], sends[-1]
    for key in ('messages', 'system', 'tools'):
        assert count[key] == send[key], key
    assert {t['name'] for t in count['tools']} == {s['name'] for s in snap.TOOL_SPECS}
    assert any(b.get('type') == 'thinking' for m in count['messages'] for b in m['content'] if isinstance(b, dict))
    assert any(b.get('type') == 'tool_result' for m in count['messages'] for b in m['content'] if isinstance(b, dict))
    state = metadata.read_attempt_state(pristine, 'app-abc1234')
    assert state['usage']['calls'] == 3 and state['usage']['cost_usd'] > 0
    assert (state['usage']['map_calls'], state['usage']['merge_calls'], state['usage']['edit_turns']) == (1, 0, 2)

    # Turn four offers no tools: counted and sent as the same final-answer-only request.
    repo.write('src/m3.py', 'p = 1\n')
    repo.commit()
    provider.sends.clear(); provider.counts.clear()
    doc = im.load_document(pristine, 'app-abc1234')
    read = tool_use('read_file', {'path': 'src/m0.py', 'limit': 3})
    provider.replies = [note(), read, read, read, answer({'base_document_sha256': doc.sha256, 'sections': []})]
    with PreflightSession() as session:
        assert update(pristine, repo, session).status == 'published'
    last = provider.messages()[-1]
    assert last['tool_choice']['type'] == 'none' and provider.counts[-1]['tool_choice'] == last['tool_choice']
    assert 'tool_choice' not in provider.messages()[1]

    # A batch of more reads than the budget allows: results are cut, then replaced by notices, and none
    # is ever blank. A batch that couldn't hold even the minimum notices stops rather than send blanks.
    repo.write('src/big.py', 'filler_line = "x" * 20\n' * 3000)
    repo.commit()
    provider.sends.clear(); provider.counts.clear()
    doc = im.load_document(pristine, 'app-abc1234')

    def read_batch(count):
        calls = [{"type": "tool_use", "id": f"toolu_{i}", "name": "read_file", "input": {"path": "src/big.py", "limit": 2000}}
                 for i in range(count)]
        return claude([{"type": "thinking", "thinking": "plan", "signature": "sig"}, *calls], stop='tool_use')
    # The new file's diff takes two pages.
    provider.replies = [note(), note(), read_batch(9), answer({'base_document_sha256': doc.sha256, 'sections': []})]
    with PreflightSession() as session:
        batch = update(pristine, repo, session)
    assert batch.status == 'published', batch
    delivered = [b['content'] for m in provider.messages()[-1]['messages'] if isinstance(m['content'], list)
                 for b in m['content'] if b.get('type') == 'tool_result']
    texts = [c if isinstance(c, str) else c[0]['text'] for c in delivered]
    assert len(texts) == 9 and all(texts) and batch.usage['read_bytes'] == sum(len(t.encode()) for t in texts)
    assert batch.usage['read_bytes'] <= mr.EDIT_TOOL_BYTES and 'budget is used up' in texts[5] and 'limit of 6' in texts[8]
    repo.write('src/m2.py', 'r = 1\n')
    repo.commit()
    provider.sends.clear(); provider.counts.clear()
    doc = im.load_document(pristine, 'app-abc1234')
    provider.replies = [note(), read_batch(mr.EDIT_TOOL_BYTES // len(mr.TOOL_MINIMUM_NOTICE) + 1)]
    with PreflightSession() as session:
        overflow = update(pristine, repo, session)
    assert overflow.status == 'failed' and 'resource limit' in overflow.reason and len(provider.messages()) == 2
    assert im.load_document(pristine, 'app-abc1234').sha256 == doc.sha256

    # A tool result that pushes the next request past the input budget stops before that send.
    repo.write('src/m1.py', 'q = 1\n')
    repo.commit()
    provider.sends.clear(); provider.counts.clear()
    doc = im.load_document(pristine, 'app-abc1234')
    provider.replies = [note(), tool_use('read_file', {'path': 'src/m0.py'}),
                        answer({'base_document_sha256': doc.sha256, 'sections': []})]
    provider.count_tokens = lambda body: 2_000_000 if any(
        isinstance(b, dict) and b.get('type') == 'tool_result' for m in body['messages'] for b in m['content']) else 1000
    with PreflightSession() as session:
        outcome = update(pristine, repo, session)
    assert outcome.status == 'failed' and 'would not fit' in outcome.reason
    assert len(provider.messages()) == 2

    # No authoritative count (the endpoint is down): no local fallback, no send.
    provider.sends.clear(); provider.counts.clear()
    provider.count_tokens = lambda body: httpx.Response(503, json={}, request=httpx.Request('POST', 'https://x'))
    with PreflightSession() as session:
        outcome = update(pristine, repo, session)
    assert outcome.status == 'skipped' and 'count unavailable' in outcome.reason and not provider.messages()

    # An incomplete final reply is charged once and never retried or published.
    provider.sends.clear(); provider.counts.clear()
    provider.count_tokens = 1000
    provider.replies = [note(), claude([{"type": "text", "text": '{"base_document_sha256": "'}], stop='max_tokens')]
    with PreflightSession() as session:
        outcome = update(pristine, repo, session)
    assert outcome.status == 'failed' and 'incomplete' in outcome.reason
    assert len(provider.messages()) == 2 and outcome.usage['calls'] == 2 and outcome.usage['cost_usd'] > 0
    assert im.load_document(pristine, 'app-abc1234').sha256 == doc.sha256

    # An unreliable-usage reply keeps its reservation, the total is shown as unknown, and nothing more is sent.
    repo.write('src/m2.py', 'w = 4\n')
    repo.commit()
    provider.sends.clear(); provider.counts.clear()
    doc = im.load_document(pristine, 'app-abc1234')
    zero = note()
    zero['usage'] = {}
    provider.replies = [zero, answer({'base_document_sha256': doc.sha256, 'sections': []})]
    ctx, events = _ctx()
    monkeypatch.setenv('REPO_RADAR_TRIGGER', 'manual')   # the failures above would otherwise hold this sync
    with PreflightSession() as session:
        S.generate_repo_metadata((REPO_CONFIG, 'app-abc1234', None, 'app', 'cyan', 1), session,
                                 _sync_args(_incremental_repos=frozenset({FULL})), ctx)
    assert ctx.stats['metadata_generated'] == 0 and ctx.stats['unknown_cost_calls'] == 1
    assert len(provider.messages()) == 1 and im.load_document(pristine, 'app-abc1234').sha256 == doc.sha256
    logged = [f for name, f in events if name == 'metadata_incremental']
    assert logged[0]['cost'].startswith('cost unknown') and logged[0]['unknown_cost_calls'] == 1
    state = metadata.read_attempt_state(pristine, 'app-abc1234')
    assert state['usage']['cost_usd'] is None and state['usage']['retained_reservation_usd'] > 0

    # The Responses API shape: a function call, then the final answer.
    from repo_radar import llm
    provider.sends.clear()
    provider.endpoint = ('api.openai.com', '/v1/responses')
    conversation = llm.Conversation('gpt-5.5-pro', 'SYS', snap.TOOL_SPECS)
    conversation.add_user('hi')
    provider.replies = [{"id": "r", "object": "response", "created_at": 0, "status": "completed", "model": "m",
                         "output": [{"type": "reasoning", "id": "rs", "summary": []},
                                    {"type": "function_call", "id": "fc", "call_id": "c1", "name": "read_diff",
                                     "arguments": '{"page": 1}', "status": "completed"}],
                         "usage": {"input_tokens": 9, "output_tokens": 4, "total_tokens": 13,
                                   "input_tokens_details": {"cached_tokens": 0},
                                   "output_tokens_details": {"reasoning_tokens": 0}},
                         "parallel_tool_calls": True, "tool_choice": "auto", "tools": []},
                        {"id": "r2", "object": "response", "created_at": 0, "status": "incomplete", "model": "m",
                         "incomplete_details": {"reason": "max_output_tokens"},
                         "output": [{"type": "message", "id": "o", "role": "assistant", "status": "incomplete",
                                     "content": [{"type": "output_text", "text": "{", "annotations": []}]}],
                         "usage": {"input_tokens": 9, "output_tokens": 4, "total_tokens": 13,
                                   "input_tokens_details": {"cached_tokens": 0},
                                   "output_tokens_details": {"reasoning_tokens": 0}},
                         "parallel_tool_calls": True, "tool_choice": "auto", "tools": []}]
    first = llm.call_model_turn(conversation.request(1024), 30)
    assert first.status == 'tool_calls' and first.tool_calls[0].name == 'read_diff'
    conversation.add_reply(first)
    conversation.add_tool_result('c1', 'page')
    second_request = conversation.request(1024)
    assert [i.get('type') for i in second_request['input']] == [None, 'reasoning', 'function_call', 'function_call_output']
    assert llm.call_model_turn(second_request, 30).status == 'incomplete'
    assert len([p for p, _ in provider.sends if p.endswith('/responses')]) == 2


# ── 4. The good document survives ────────────────────────────────────────────────────────────────

@pytest.mark.parametrize('failure', ['generation_error', 'parse_failure', 'interrupt_before_replace',
                                     'interrupt_after_replace', 'state_lost_after_replace', 'repository_moved',
                                     'full_degraded', 'delimiter_in_brief', 'delimiter_in_coverage_note'])
def test_a_good_document_survives_a_failed_update(monkeypatch, tmp_path, failure):
    repo, base, pristine = setup_pristine(monkeypatch, tmp_path)
    repo.write('src/m0.py', (repo.path / 'src/m0.py').read_text() + '# more\n')
    target = repo.commit()
    provider = Provider(monkeypatch)
    old = im.load_document(pristine, 'app-abc1234')
    good = answer({'base_document_sha256': old.sha256, 'sections': []})

    def moved(body):   # reset past the analyzed commit; a clone that only moved forward would still publish
        repo.git('reset', '-q', '--hard', 'HEAD~1')
        return good

    unsafe = {'delimiter_in_brief': {'fields': {'brief': 'Payments --- API'}},
              'delimiter_in_coverage_note': {'coverage_note': 'checked src --- skipped tests'}}
    if failure in unsafe:
        good = answer({'base_document_sha256': old.sha256, 'sections': [], **unsafe[failure]})
    provider.replies = {'generation_error': [httpx.Response(500, json={"error": {"message": "boom"}})],
                        'parse_failure': [note(), claude([{"type": "text", "text": "Here is my update!"}])],
                        'full_degraded': [claude([{"type": "text", "text": "A repository. No markers here."}])],
                        'repository_moved': [note(), moved]}.get(failure, [note(), good])
    interrupt = KeyboardInterrupt('stopped')
    real_atomic = metadata.write_text_atomic
    if failure == 'interrupt_before_replace':
        monkeypatch.setattr(metadata, 'write_text_atomic', lambda *a: (_ for _ in ()).throw(interrupt))
    real_write_state = im.write_state

    def write_state(p, c, state):
        if failure == 'interrupt_after_replace' and state.get('status') == 'published':
            raise interrupt
        if failure == 'state_lost_after_replace' and state.get('status') == 'published':
            raise OSError(28, 'No space left on device')
        real_write_state(p, c, state)
    monkeypatch.setattr(im, 'write_state', write_state)

    with PreflightSession() as session:
        if failure.startswith('interrupt'):
            with pytest.raises(KeyboardInterrupt):
                update(pristine, repo, session)
        elif failure == 'state_lost_after_replace':
            outcome = update(pristine, repo, session)
            assert outcome.status == 'published' and 'attempt state not saved' in outcome.state_error
        else:
            outcome = update(pristine, repo, session, force=failure == 'full_degraded')
            assert outcome.status == 'failed', outcome   # repository_moved: refused after paid calls
            if failure in unsafe:
                assert "header is unsafe" in outcome.reason
    monkeypatch.setattr(metadata, 'write_text_atomic', real_atomic)
    monkeypatch.setattr(im, 'write_state', real_write_state)
    doc = im.load_document(pristine, 'app-abc1234')
    metadata.regenerate_index(types.SimpleNamespace(dry_run=False))
    index = (pristine / 'INDEX.md').read_text()
    if failure in ('interrupt_after_replace', 'state_lost_after_replace'):
        # The replacement committed: the new document is complete and current despite the stale marker.
        assert doc.info['last_commit'] == target and doc.info['generation_id']
        assert 'stale' not in index
        # The published header reads back whole: identity, revisions, provenance and a healthy status.
        assert (doc.info['full_name'], doc.info['parse_status'], doc.info['base_commit']) == (FULL, 'ok', base)
        assert doc.info['semantic_policy'] == im.SEMANTIC_POLICY and doc.info['full_build_model'] == 'unknown'
        assert doc.info['coverage'] == 'required diff examined' and doc.info['brief'] == 'A payments API.'
        assert im.usable_baseline(doc, FULL)[0]
        return
    assert doc.text == old.text, 'old document kept byte for byte'
    assert 'degraded_reason' not in doc.text
    assert f"stale: analyzed {base[:7]}, update to {target[:7]}" in index
    # A failed incremental attempt is retried incrementally later, never by an automatic full rebuild;
    # a failed full rebuild stays due on the next ordinary sync.
    if failure == 'full_degraded':
        assert decide(repo, pristine).reason == 'previous full rebuild did not finish'
        assert doc.info.get('full_build_at') is None  # the full-build time moves only on a published full build
    elif failure != 'repository_moved':
        assert decide(repo, pristine).strategy == 'incremental'

    if failure == 'generation_error':
        # A first build that fails with no Markdown at all still gets an INDEX naming the repository
        # and why its metadata is unavailable; no document is made up for it.
        empty = tmp_path / 'first-build'
        first = Repo(empty / 'app-abc1234')
        first.write('src/a.py', 'a = 1\n')
        first.commit()
        monkeypatch.setattr(metadata, 'PRISTINE_DIR', empty)
        monkeypatch.setattr(metadata, 'INDEX_FILE', empty / 'INDEX.md')
        Provider(monkeypatch).replies = [httpx.Response(500, json={"error": {"message": "boom"}})]
        with PreflightSession() as session:
            assert im.update_repository(empty, first.path, 'app-abc1234', REPO_CONFIG, MODEL, session).status == 'failed'
        metadata.regenerate_index(types.SimpleNamespace(dry_run=False))
        first_index = (empty / 'INDEX.md').read_text()
        assert '**Total Repositories:** 0' in first_index and f'**Metadata unavailable:** {FULL} (' in first_index
        assert [p.name for p in empty.glob('*.md')] == ['INDEX.md']

        # What Activity and the progress view show: a failure, never success.
        repo2, _b, pristine2 = setup_pristine(monkeypatch, tmp_path / 'activity')
        repo2.write('src/m0.py', '# changed\n')
        repo2.commit()
        Provider(monkeypatch).replies = [httpx.Response(500, json={"error": {"message": "boom"}})]
        ctx, events = _ctx()
        task = (REPO_CONFIG, 'app-abc1234', None, 'app', 'cyan', 1)
        with PreflightSession() as session:
            S.generate_repo_metadata(task, session, _sync_args(_incremental_repos=frozenset({FULL})), ctx)
        assert ctx.stats['errors'] == 1 and ctx.stats['metadata_generated'] == 0
        assert any(name == 'metadata_incremental' and f['status'] == 'failed' and f['level'] == 'error'
                   for name, f in events if isinstance(f, dict))
        assert any(e[0] == 'progress' and e[1] and '✗ metadata failed' in e[1] for e in events)


@pytest.mark.parametrize('failure', ['no_key', 'git_before_model', 'state_write', 'worker_exception', 'fetch_failed'])
def test_every_opted_in_failure_is_reported_and_keeps_the_document(monkeypatch, tmp_path, failure):
    repo, base, pristine = setup_pristine(monkeypatch, tmp_path)
    provider = Provider(monkeypatch)
    origin, _config, events = sync_fixture(monkeypatch, tmp_path, repo)
    before = (pristine / 'app-abc1234.md').read_text()
    if failure == 'no_key':
        monkeypatch.delenv('ANTHROPIC_API_KEY')
    elif failure == 'git_before_model':
        monkeypatch.setattr(snap.GitSnapshot, 'tree_id', lambda self: (_ for _ in ()).throw(snap.GitError('object store damaged')))
    elif failure == 'state_write':
        monkeypatch.setattr(im, 'write_state', lambda *a: (_ for _ in ()).throw(OSError(28, 'No space left on device')))
    elif failure == 'worker_exception':
        monkeypatch.setattr(S, 'generate_repo_metadata', lambda *a: (_ for _ in ()).throw(RuntimeError('worker broke')))
    else:
        shutil.rmtree(origin)

    assert S.sync_mode(_sync_args(status_server='http://127.0.0.1:9')) == 1, 'the run cannot finish as succeeded'
    assert (pristine / 'app-abc1234.md').read_text() == before
    assert not provider.sends and not provider.counts
    progress = [d['status'] for kind, d in events if kind == 'progress' and d.get('repo') == FULL]
    index = (pristine / 'INDEX.md').read_text()
    state = metadata.read_attempt_state(pristine, 'app-abc1234')
    if failure == 'fetch_failed':
        assert progress[-1] == '✗ fetch failed' and state['reason'] == 'fetch failed, so metadata was not updated'
        assert 'stale: analyzed' in index and 'fetch failed' in index
        return
    reported = [f for name, f in events if name == 'metadata_incremental']
    assert len(reported) == 1 and reported[0]['status'] == 'failed' and reported[0]['level'] == 'error'
    assert progress[-1].startswith('✗ metadata update failed')
    if failure == 'state_write':
        assert state is None and 'staleness could not be recorded' in progress[-1]
        assert 'attempt state not saved' in reported[0]['state_error']
        assert 'stale' not in index, 'INDEX is not claimed to show what could not be recorded'
        return
    assert reported[0]['state_error'] is None and 'marked stale in INDEX' in progress[-1]
    expected = {'no_key': 'no API key: ANTHROPIC_API_KEY is not set', 'git_before_model': 'git: object store damaged',
                'worker_exception': 'RuntimeError: worker broke'}[failure]
    assert state['status'] == 'failed' and state['reason'] == expected
    assert f"stale: analyzed {base[:7]}" in index and expected in index


# ── 5. The pilot cap survives failure and restart ───────────────────────────────────────────────

def test_pilot_cap_survives_failure_and_restart(monkeypatch, tmp_path, capsys):
    path = tmp_path / 'pilot' / 'ledger.json'
    allowances = {'incremental': 8.0, 'full': 24.0}
    ledger = Ledger(path, 40.0, allowances)
    full = Budget(MODEL, ledger=ledger, label='full')
    # $2/M input, $10/M output: 5M input tokens + 1M output reserves $20.
    first = full.reserve({'r': 1}, 5_000_000, 1_000_000)
    full.settle(first, types.SimpleNamespace(input_tokens=4_000_000, output_tokens=700_000), None)
    assert ledger.spent('full') == pytest.approx(15.0)
    with pytest.raises(BudgetExceeded):          # $10 more would pass the $24 full allowance
        full.reserve({'r': 2}, 0, 1_000_000)
    second = full.reserve({'r': 3}, 0, 500_000)  # $5
    full.fail(second)                            # timed out: billed or not, the reservation stays
    assert ledger.spent('full') == pytest.approx(20.0)

    # Reopening reads the same ledger: same spend, same cap, and the same request can't be bought again.
    # The timed-out request's cost is unresolved, so no further paid request goes out in any mode.
    reopened = Ledger(path, 40.0, allowances)
    assert reopened.spent() == pytest.approx(20.0)
    with pytest.raises(ValueError):
        Ledger(path, 80.0, allowances)
    with pytest.raises(BudgetExceeded, match='already'):
        Budget(MODEL, ledger=reopened, label='full').reserve({'r': 3}, 0, 500_000)
    with pytest.raises(PricingUnavailable):
        Budget('model-without-a-price', ledger=reopened, label='full').reserve({'r': 4}, 1, 1)
    with pytest.raises(BudgetExceeded, match='unknown cost holding \\$5.00'):
        Budget(MODEL, ledger=reopened, label='incremental').reserve({'r': 5}, 1, 1)

    # The incremental comparison hits the same boundary before anything is sent.
    repo, base, pristine = setup_pristine(monkeypatch, tmp_path / 'repo')
    repo.write('src/m0.py', '# changed\n')
    repo.commit()
    provider = Provider(monkeypatch)
    second_path = tmp_path / 'pilot2' / 'ledger.json'
    incremental = Budget(MODEL, ledger=Ledger(second_path, 40.0, allowances), label='incremental')
    earlier = incremental.reserve({'earlier': 1}, 0, 790_000)   # $7.90 of the $8 allowance already spent
    incremental.settle(earlier, types.SimpleNamespace(input_tokens=1, output_tokens=790_000), 7.9)
    doc = im.load_document(pristine, 'app-abc1234')
    decision = decide(repo, pristine)
    with PreflightSession() as session:
        with pytest.raises(im.StaleUpdate, match='allowance'):
            im.run_incremental(repo.path, FULL, doc, decision, MODEL, session, incremental)
    assert not provider.messages()
    assert Ledger(second_path, 40.0, allowances).spent('incremental') == pytest.approx(7.9)

    # A reply whose usage is empty or partial is not evidence of a free request: the full reservation
    # stays, the run stops after that one send, no candidate is produced, and the ledger refuses more.
    for raw_usage in ({}, {'input_tokens': 900}):
        ledger_path = tmp_path / f'pilot-usage-{len(raw_usage)}' / 'ledger.json'
        budget = Budget(MODEL, ledger=Ledger(ledger_path, 40.0, allowances), label='incremental')
        provider.sends.clear()
        reply = note()
        reply['usage'] = raw_usage
        provider.replies = [reply, answer({'base_document_sha256': doc.sha256, 'sections': []})]
        with PreflightSession() as session:
            with pytest.raises(im.StaleUpdate, match="cost is unknown"):
                im.run_incremental(repo.path, FULL, doc, decision, MODEL, session, budget)
        assert len(provider.messages()) == 1, raw_usage
        usage = budget.summary()
        assert usage['cost_usd'] is None and usage['unknown_cost_calls'] == 1 and usage['retained_reservation_usd'] > 0
        reopened = Ledger(ledger_path, 40.0, allowances)
        assert reopened.spent() == pytest.approx(usage['known_cost_usd'] + usage['retained_reservation_usd'])
        with pytest.raises(BudgetExceeded, match='reconcile'):
            Budget(MODEL, ledger=reopened, label='full').reserve({'other': 1}, 1, 1)

    # A candidate rejected for an unsafe header still reports what it cost and is kept as evidence,
    # with no successful Markdown and no second request.
    provider.sends.clear(); provider.counts.clear()
    provider.replies = [claude([{"type": "text", "text": FULL_REPLY.replace('A rebuilt API.', 'Payments --- API')}])]
    unsafe_dir, result = run_pilot(tmp_path / 'unsafe-pilot', repo, doc.text, 'full', repo.git('rev-parse', 'HEAD'))
    assert result['status'] == 'failed' and 'header is unsafe' in result['reason']
    assert result['usage']['calls'] == 1 and result['usage']['known_cost_usd'] > 0 and result['ledger_spent_usd'] > 0
    rejected = unsafe_dir / result['rejected_candidate']
    assert json.loads(rejected.read_text())['fields']['brief'] == 'Payments --- API'
    assert oct(rejected.stat().st_mode & 0o777) == '0o600' and not (unsafe_dir / 'full.md').exists()
    assert len(provider.messages()) == 1 and not provider.replies

    # Two pilot invocations can't overlap: while A holds the pilot lock, B stops before any setup,
    # ledger or provider work; once A releases it, B runs and sees the same ledger and cap.
    import sys
    from pathlib import Path
    root = Path(__file__).resolve().parents[2]
    pilot_dir = tmp_path / 'locked-pilot'
    pilot_dir.mkdir()
    shared = Ledger(pilot_dir / 'ledger.json', 40.0, allowances)
    spent = Budget(MODEL, ledger=shared, label='full')
    spent.settle(spent.reserve({'done': 1}, 0, 100_000), types.SimpleNamespace(input_tokens=5, output_tokens=100_000), 1.0)
    (pilot_dir / 'baseline.md').write_text(
        legacy_document('app-abc1234', base, NOW - timedelta(days=1)).replace(FULL, 'ReperioHealth/reperio-telehealth'))
    holder = subprocess.Popen(
        [sys.executable, '-I', '-c', f"import sys; sys.path.insert(0, {str(root)!r}); "
         "from repo_radar.metadata_budget import acquire_exclusive_lock; "
         f"fd = acquire_exclusive_lock({str(pilot_dir / 'pilot.lock')!r}); print('locked', flush=True); sys.stdin.read()"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    env = {'PATH': os.environ['PATH'], 'HOME': str(tmp_path), 'LITELLM_LOCAL_MODEL_COST_MAP': 'True'}
    pilot = [sys.executable, '-I', str(root / 'scripts' / 'pilot-incremental-metadata.py'), 'plan',
             '--pilot-dir', str(pilot_dir), '--repo-path', str(repo.path), '--target', repo.git('rev-parse', 'HEAD'),
             '--model', MODEL]
    try:
        assert holder.stdout.readline().strip() == 'locked'
        blocked = subprocess.run(pilot, capture_output=True, text=True, env=env)
        assert blocked.returncode == 2 and 'another pilot invocation' in blocked.stderr
        assert not (pilot_dir / 'pilot.json').exists()
    finally:
        holder.stdin.close()
        holder.wait(timeout=30)
    after = subprocess.run(pilot, capture_output=True, text=True, env=env)
    assert after.returncode == 0, after.stderr
    assert 'ledger: $1.00 of $40.00 spent' in after.stdout and (pilot_dir / 'pilot.json').exists()
    assert (pilot_dir / 'pilot.lock').exists()

    # A manifest replay: plan buys nothing, replay runs its cases, and an unchanged rerun buys nothing.
    history = Repo(tmp_path / 'telehealth')
    for i in range(10):
        history.write(f'src/m{i}.py', f'# module {i}\nx = 1\n')
    first = history.commit('a')
    history.write('src/m1.py', 'y = 2\n')
    second = history.commit('b')
    history.write('src/m2.py', 'z = 3\n')
    third = history.commit('c')

    def replay_reply(stage, text):
        if stage == 'full':
            return FULL_REPLY
        if stage == 'edit':
            return {'base_document_sha256': re.search(r'base_document_sha256: (\w+)', text).group(1), 'sections': []}
        return {'changes': [], 'no_summary_change_reason': 'routine'}
    fake = GeminiFake(monkeypatch, replay_reply)
    script = load_pilot()
    replay_dir = tmp_path / 'replay'
    replay_dir.mkdir()
    manifest_path = tmp_path / 'manifest.json'
    base_case = {'id': 'base', 'kind': 'full_baseline', 'target': first}
    case = {'id': 'one', 'kind': 'replay', 'baseline_from': 'base', 'base': first, 'target': second, 'weekly_trigger': False}

    def manifest(*cases):
        manifest_path.write_text(json.dumps({'schema': script.MANIFEST_SCHEMA, 'model': GEMINI, 'clone_url': 'https://x/y.git',
                                             'cache_dir': 'y', 'cases': list(cases)}))
        return ['--manifest', str(manifest_path), '--pilot-dir', str(replay_dir), '--repo-path', str(history.path)]

    def refused(mode, args, why):
        capsys.readouterr()
        before = len(fake.sends)
        with pytest.raises(SystemExit):
            script.main([mode, *args])
        assert why in capsys.readouterr().err and len(fake.sends) == before

    document = tmp_path / 'document.md'
    document.write_text(legacy_document('cache', second, NOW - timedelta(days=1)).replace(FULL, script.PILOT_REPO))
    from_file = {'id': 'from-file', 'kind': 'replay', 'baseline_file': str(document), 'base': second, 'target': third}
    assert script.main(['plan', *manifest(base_case, case, from_file)]) == 0
    assert not fake.sends and not (replay_dir / 'ledger.json').exists()
    args = manifest(base_case, case)
    assert script.main(['replay', *args]) == 0 and fake.sends
    # The successful single-pass full baseline asks for low thinking at its usual limit, in Markdown.
    baseline_config = fake.stage('full')[0][1]['generationConfig']
    assert len(fake.stage('full')) == 1 and baseline_config['max_output_tokens'] == 16384
    assert baseline_config['thinkingConfig']['thinkingLevel'] == 'low' and 'response_mime_type' not in baseline_config
    assert json.loads((replay_dir / 'base' / 'result.json').read_text())['usage']['full_stage']['stage'] == 'single'
    bought = len(fake.sends)
    assert script.main(['replay', *args]) == 0 and len(fake.sends) == bought

    # Only plan and replay take a manifest; the single-case modes never run a replay by accident.
    refused('full', args, 'works only with plan or replay')

    # Two cases can't share a directory: by name, by a case-insensitive name, or through a symlink.
    later = {'id': 'two', 'kind': 'replay', 'baseline_from': 'one', 'base': second, 'target': third, 'weekly_trigger': False}
    refused('replay', manifest(base_case, case, {**later, 'output': 'one'}), 'would share the output directory')
    refused('replay', manifest(base_case, case, {**later, 'output': 'ONE'}), 'would share the output directory')
    (replay_dir / 'alias').symlink_to(replay_dir / 'one')
    refused('replay', manifest(base_case, case, {**later, 'output': 'alias'}), 'would share the output directory')
    (replay_dir / 'away').symlink_to(tmp_path)
    refused('replay', manifest(base_case, case, {**later, 'output': 'away'}), 'must be a directory directly under')

    # A completed result counts only for exactly what it was built from.
    refused('replay', manifest(base_case, {**case, 'target': third}), 'different inputs')
    refused('replay', manifest(base_case, {**case, 'weekly_trigger': True}), 'different inputs')
    candidate = replay_dir / 'one' / 'candidate.md'
    good = candidate.read_text()
    candidate.write_text(good + 'edited afterwards\n')
    refused('replay', manifest(base_case, case), "isn't the one its result recorded")
    candidate.write_text(good)
    result = replay_dir / 'one' / 'result.json'
    recorded = json.loads(result.read_text())
    result.write_text(json.dumps({k: v for k, v in recorded.items() if k != 'prompt_version'}))
    refused('replay', manifest(base_case, case), 'different inputs')


def test_a_cut_tool_result_keeps_its_notice_inside_its_byte_allotment():
    # Counted tokens that barely notice the notice (a dense result, a cheap ASCII notice): the cut used to
    # land the notice a few dozen bytes past the result's allotment.
    class Conversation:
        def request(self, _out):
            return item['content']

    def counted(request):
        return len(request.replace(mr.TOOL_TRUNCATED_NOTICE, '').encode()), 0, 385 + mr.CONTINUATION_TOKENS + 13
    pipeline = types.SimpleNamespace(_edit_output_and_limit=counted, _notice=mr.Pipeline._notice)
    item = {'content': mr.TOOL_MINIMUM_NOTICE}
    text = mr.Pipeline._fit_tool_result(pipeline, Conversation(), item, 'x' * 400, 400)
    assert text.endswith(mr.TOOL_TRUNCATED_NOTICE) and len(text.encode()) <= 400


# ── Latest summary changes ───────────────────────────────────────────────────────────────────────

def _candidate(analysis, fields):
    return im.Candidate(analysis, fields, None, [], 0, snap.NO_EXCLUSIONS)


def _index(pristine):
    metadata.regenerate_index(types.SimpleNamespace(dry_run=False))
    return (pristine / 'INDEX.md').read_text()


CHANGES_LINK = '**[Latest summary changes](.summary-changes/app-abc1234.md)**'


def test_each_publication_records_its_summary_change_and_failures_keep_it(monkeypatch, tmp_path):
    """Changed text gives a bounded diff, a header-only publication says unchanged, and a failed update, a
    no-op sync or a broken comparison never present a change that didn't publish. INDEX links the page only
    while it belongs to the current document."""
    repo, base, pristine = setup_pristine(monkeypatch, tmp_path)
    page_path = pristine / '.summary-changes' / 'app-abc1234.md'
    old = im.load_document(pristine, 'app-abc1234')
    fields = im.current_fields(old)
    edited = im._analysis_of(old).replace('A payments API.', 'A payments and refunds API.')

    # Changed text: the analyzed range, the added and removed summary lines, owner-only.
    repo.write('src/m0.py', '# changed\n')
    first = repo.commit()
    with PreflightSession() as session:
        assert update(pristine, repo, session, run_incremental_fn=lambda *a, **k: _candidate(edited, fields)).status == 'published'
    page, info = page_path.read_text(), metadata.parse_frontmatter(page_path.read_text())
    doc = im.load_document(pristine, 'app-abc1234')
    assert (page_path.stat().st_mode & 0o777, page_path.parent.stat().st_mode & 0o777) == (0o600, 0o700)
    assert (info['status'], info['old_commit'], info['new_commit']) == ('changed', base, first)
    assert (info['old_document_sha256'], info['new_document_sha256']) == (old.sha256, doc.sha256)
    assert info['generation_id'] == doc.info['generation_id'] and info['generated_at'] == doc.info['last_updated']
    assert '-A payments API.' in page and '+A payments and refunds API.' in page
    assert f"`{base[:7]}` → `{first[:7]}`" in page and '1 lines added, 1 removed' in page
    assert 'last_updated' not in page.split('---', 2)[2], 'timestamp and provenance churn is not compared'
    assert CHANGES_LINK in _index(pristine)

    # A no-op sync and a failed update both leave it byte for byte, and INDEX still links it.
    with PreflightSession() as session:
        assert update(pristine, repo, session).status == 'none'
        repo.write('src/m1.py', '# changed\n')
        repo.commit()
        failed = update(pristine, repo, session,
                        run_incremental_fn=lambda *a, **k: (_ for _ in ()).throw(im.StaleUpdate('refused')))
    assert failed.status == 'failed' and page_path.read_text() == page
    assert CHANGES_LINK in _index(pristine)

    # Header only: the analyzed commit moves, the text doesn't.
    with PreflightSession() as session:
        assert update(pristine, repo, session, run_incremental_fn=lambda *a, **k: _candidate(edited, fields)).status == 'published'
    info = metadata.parse_frontmatter(page_path.read_text())
    assert info['status'] == 'unchanged' and '**Result:** Summary text unchanged.  ' in page_path.read_text()
    assert '```diff' not in page_path.read_text()

    # A comparison that fails is recorded as unavailable; the update still publishes.
    monkeypatch.setattr(im, '_summary_lines', lambda text: (_ for _ in ()).throw(ValueError('broken')))
    repo.write('src/m2.py', '# changed\n')
    repo.commit()
    with PreflightSession() as session:
        assert update(pristine, repo, session, run_incremental_fn=lambda *a, **k: _candidate(ANALYSIS, fields)).status == 'published'
    info = metadata.parse_frontmatter(page_path.read_text())
    assert info['status'] == 'unavailable' and info['new_document_sha256'] == im.load_document(pristine, 'app-abc1234').sha256
    assert CHANGES_LINK in _index(pristine)

    # A document replaced some other way no longer matches the page, so INDEX doesn't link it.
    doc_path = pristine / 'app-abc1234.md'
    doc_path.write_text(doc_path.read_text().replace('Untouched schema text', 'Hand-edited schema text'))
    assert CHANGES_LINK not in _index(pristine) and '[View Details](app-abc1234.md)' in _index(pristine)


def test_a_first_summary_is_labelled_and_a_long_diff_is_truncated(monkeypatch, tmp_path):
    repo, _base, pristine = setup_pristine(monkeypatch, tmp_path)
    page_path = pristine / '.summary-changes' / 'app-abc1234.md'
    fields = im.current_fields(im.load_document(pristine, 'app-abc1234'))
    (pristine / 'app-abc1234.md').unlink()
    with PreflightSession() as session:
        assert update(pristine, repo, session, run_full_fn=lambda *a, **k: _candidate(ANALYSIS, fields)).status == 'published'
    info = metadata.parse_frontmatter(page_path.read_text())
    assert (info['status'], info['old_commit'], info['old_document_sha256']) == ('first', 'none', 'none')
    assert 'First summary' in page_path.read_text() and '```diff' not in page_path.read_text()
    assert CHANGES_LINK in _index(pristine)

    # A rewrite far over the cap shows what fits, says so, and keeps a code fence in the text intact.
    long = '## Overview\n' + ''.join(f"Line {i} ```quoted``` {'y' * 200}\n" for i in range(2000))
    repo.write('src/m0.py', '# changed\n')
    repo.commit()
    with PreflightSession() as session:
        assert update(pristine, repo, session, force=True, run_full_fn=lambda *a, **k: _candidate(long, fields)).status == 'published'
    page = page_path.read_text()
    info = metadata.parse_frontmatter(page)
    assert info['status'] == 'changed' and info['truncated'] == 'true' and '_Truncated: ' in page
    assert len(page.encode('utf-8')) <= im.CHANGE_MAX_BYTES and '````diff' in page


def test_change_pages_show_long_lines_whole_stay_in_the_cap_and_link_crlf_text(monkeypatch, tmp_path):
    repo, _base, pristine = setup_pristine(monkeypatch, tmp_path)
    page_path = pristine / '.summary-changes' / 'app-abc1234.md'
    doc_path = pristine / 'app-abc1234.md'
    fields = im.current_fields(im.load_document(pristine, 'app-abc1234'))

    # A change at the end of a long paragraph is shown whole: both endings, and nothing claimed cut.
    paragraph = 'A long Markdown paragraph. ' * 20
    doc_path.write_text(doc_path.read_text().replace('A payments API.\n\n', f"{paragraph}old ending\n\n", 1))
    repo.write('src/m0.py', '# changed\n')
    repo.commit()
    with PreflightSession() as session:
        edited = im._analysis_of(im.load_document(pristine, 'app-abc1234')).replace('old ending', 'new ending')
        assert update(pristine, repo, session, run_incremental_fn=lambda *a, **k: _candidate(edited, fields)).status == 'published'
    page = page_path.read_text()
    assert f"-{paragraph}old ending" in page and f"+{paragraph}new ending" in page
    assert metadata.parse_frontmatter(page)['truncated'] == 'false' and '_Truncated' not in page

    # An oversized analyzed commit in the old document still gives a page within the cap.
    doc_path.write_text(re.sub(r'^last_commit: .*$', 'last_commit: ' + '界' * 12000, doc_path.read_text(), count=1, flags=re.M))
    with PreflightSession() as session:
        assert update(pristine, repo, session, run_full_fn=lambda *a, **k: _candidate(ANALYSIS, fields)).status == 'published'
    assert len(page_path.read_bytes()) <= im.CHANGE_MAX_BYTES
    assert metadata.parse_frontmatter(page_path.read_text())['status'] == 'changed'

    # Carriage returns in the published text: the page is made for the document readers see, so INDEX links it.
    repo.write('src/m1.py', '# changed\n')
    repo.commit()
    crlf = ANALYSIS.replace('\n', '\r\n')
    with PreflightSession() as session:
        assert update(pristine, repo, session, run_incremental_fn=lambda *a, **k: _candidate(crlf, fields)).status == 'published'
    assert b'\r\n' in doc_path.read_bytes()
    assert metadata.parse_frontmatter(page_path.read_text())['status'] == 'unchanged'
    assert CHANGES_LINK in _index(pristine)


# ── The clone moving during a build ──────────────────────────────────────────────────────────────

def _full_build_that(pristine, action):
    """A fake full build that runs `action(budget)` before returning a candidate, as a pull landing mid-build."""
    def built(repo_path, full_name, target, model, session, budget, **k):
        action(budget)
        return _candidate('## Overview\nRebuilt.\n', im.current_fields(im.load_document(pristine, 'app-abc1234')))
    return built


def test_a_full_build_publishes_at_its_pinned_commit_when_the_clone_moved_forward(monkeypatch, tmp_path):
    """A pull during a full rebuild no longer throws the paid build away: it publishes at the commit it read,
    and the next sync updates from there to the new HEAD."""
    repo, _base, pristine = setup_pristine(monkeypatch, tmp_path)
    repo.write('src/m0.py', 'changed = True\n')
    pinned = repo.commit('one change')

    def pull(budget):
        budget.calls += 1
        repo.write('src/new.py', 'pulled = True\n')
        repo.commit('pulled mid-build')
    with PreflightSession() as session:
        out = update(pristine, repo, session, allow_incremental=False, run_full_fn=_full_build_that(pristine, pull))
    assert (out.status, out.strategy, out.target) == ('published', 'full', pinned), out
    assert f'last_commit: {pinned}\n' in (pristine / 'app-abc1234.md').read_text()
    head = repo.git('rev-parse', 'HEAD')
    assert head != pinned
    d = decide(repo, pristine)
    assert (d.strategy, d.base, d.target) == ('incremental', pinned, head), d


@pytest.mark.parametrize('rewrite', [('reset', '--hard', 'HEAD~1'), ('commit', '--amend', '-q', '-m', 'rewritten')])
@pytest.mark.parametrize('paid', [False, True])
def test_a_build_is_refused_when_the_clone_no_longer_contains_its_commit(monkeypatch, tmp_path, rewrite, paid):
    """A reset or rewrite past the analyzed commit can't be the next update's base: the document stays, and the
    refusal is a skip while nothing was paid for, a failure that counts toward the hold once a call was."""
    repo, _base, pristine = setup_pristine(monkeypatch, tmp_path)
    repo.write('src/m0.py', 'changed = True\n')
    repo.commit('one change')
    before = (pristine / 'app-abc1234.md').read_text()

    def rewrite_history(budget):
        budget.calls += paid
        repo.git(*rewrite)
    with PreflightSession() as session:
        out = update(pristine, repo, session, allow_incremental=False,
                     run_full_fn=_full_build_that(pristine, rewrite_history))
    assert out.status == ('failed' if paid else 'skipped') and out.reason.startswith('superseded'), out
    assert (pristine / 'app-abc1234.md').read_text() == before
    state = metadata.read_attempt_state(pristine, 'app-abc1234')
    assert state['consecutive_failures'] == (1 if paid else 0)


def test_an_incremental_update_reads_attributes_at_its_pinned_commit(monkeypatch, tmp_path):
    """A fast-forward mid-build that adds `.gitattributes` marking the source `-diff` can't turn the pinned
    change into a binary omission or hide it from search: attributes come from the analyzed commit."""
    repo, _base, pristine = setup_pristine(monkeypatch, tmp_path)
    repo.write('src/m0.py', 'PINNED_MARKER = "at the analyzed commit"\n')
    pinned = repo.commit('the analyzed change')
    provider = Provider(monkeypatch)
    old = im.load_document(pristine, 'app-abc1234')
    provider.replies = [note(), tool_use('search', {'literal': 'PINNED_MARKER'}),
                        answer({'base_document_sha256': old.sha256, 'sections': []})]

    def pulled_then_built(*a, **k):
        repo.write('.gitattributes', '*.py -diff\n')
        repo.commit('pulled after the update chose its commit')
        return im.run_incremental(*a, **k)
    with PreflightSession() as session:
        out = update(pristine, repo, session, run_incremental_fn=pulled_then_built)
    assert (out.status, out.strategy, out.target) == ('published', 'incremental', pinned), out
    traffic = json.dumps([b for _p, b in provider.sends])
    assert '+PINNED_MARKER' in traffic and 'binary file' not in traffic
    assert 'src/m0.py' in traffic and '[no matches]' not in traffic
