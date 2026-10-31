"""Incremental metadata: the five behavioral cases in PLAN-incremental-metadata.md.

Disposable Git repositories and a fake provider at the HTTP transport (sends) and at the Count Tokens
client (counts). Sockets are blocked, keys are fake, nothing is paid for.
"""
import json
import os
import shutil
import socket
import subprocess
import threading
import types
from datetime import datetime, timedelta

import httpx
import pytest

from repo_radar import incremental_metadata as im
from repo_radar import metadata, metadata_snapshot as snap
from repo_radar.metadata_budget import Budget, BudgetExceeded, Ledger, PricingUnavailable
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
    or an exception). Every serialized send and count body is recorded."""

    def __init__(self, monkeypatch):
        self.replies, self.sends, self.counts = [], [], []
        self.count_tokens = 1000
        provider = self

        def handle(transport, request):
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


def setup_pristine(monkeypatch, tmp_path, updated=NOW - timedelta(days=1), files=10):
    repo, base = source_repo(tmp_path, files)
    pristine = tmp_path / 'pristine'
    (pristine / 'app-abc1234.md').write_text(legacy_document('app-abc1234', base, updated))
    for module in (metadata, S):
        monkeypatch.setattr(module, 'PRISTINE_DIR', pristine)
    monkeypatch.setattr(metadata, 'INDEX_FILE', pristine / 'INDEX.md')
    return repo, base, pristine


def decide(repo, pristine, now=NOW, model=MODEL, force=False):
    doc = im.load_document(pristine, 'app-abc1234')
    state = metadata.read_attempt_state(pristine, 'app-abc1234')
    return im.decide(repo.path, FULL, doc, state, model, snap.resolve_commit(repo.path, 'HEAD'), now, force=force)


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
    monkeypatch.setattr(S.time, 'sleep', lambda s: None)
    legacy_calls = []
    monkeypatch.setattr(S, 'collect_repo_files', lambda path: legacy_calls.append(path) or [])
    incremental_calls = []
    real_update = im.update_repository
    monkeypatch.setattr(im, 'update_repository', lambda *a, **k: incremental_calls.append(a) or
                        im.Outcome('none', 'none', 'unchanged', base, base, {}, 0.0))

    # A repository that isn't opted in still takes the full generator; an opted-in one never does.
    S.generate_repo_metadata(task, None, _sync_args(), ctx)
    assert legacy_calls and not incremental_calls
    legacy_calls.clear()
    S.generate_repo_metadata(task, None, _sync_args(_incremental_repos=frozenset({FULL})), ctx)
    assert incremental_calls and not legacy_calls
    monkeypatch.setattr(im, 'update_repository', real_update)
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

    # One small change is incremental; exactly 20% stays incremental; more than 20% is full.
    edit_in_place(['src/m0.py'])
    repo.commit()
    assert decide(repo, pristine).strategy == 'incremental'
    edit_in_place(['src/m1.py'])
    repo.commit()
    d = decide(repo, pristine)
    assert (d.change.file_fraction, d.change.byte_fraction, d.strategy) == (0.2, 0.2, 'incremental')
    edit_in_place(['src/m2.py'])
    repo.commit()
    assert decide(repo, pristine).strategy == 'full'

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
    provider.replies = [answer({'base_document_sha256': doc.sha256, 'sections': []})]
    assert S.sync_mode(_sync_args()) == 0
    new = im.load_document(pristine, 'app-abc1234')
    assert new.info['last_commit'] == repo.git('rev-parse', 'origin/main') and new.info['generation_strategy'] == 'incremental'
    assert len(provider.messages()) == 1
    assert 'stale' not in (pristine / 'INDEX.md').read_text()

    # A malformed opt-in list is refused before any work.
    config['incremental_metadata_repos'] = ['o/*']
    assert S.sync_mode(_sync_args()) == 1

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
    assert state['status'] == 'committing' and state['generation_id'] == im.load_document(pristine, 'app-abc1234').info['generation_id']
    assert decide(repo, pristine).strategy == 'none'


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
    tools = snap.SnapshotTools(base_snap, target_snap, ['page'])
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
    with pytest.raises(snap.ToolRequestError):
        tools.run('run_shell', '{"cmd": "ls"}')

    # The update replaces one section and deletes another; the untouched section keeps its bytes.
    provider = Provider(monkeypatch)
    doc = im.load_document(pristine, 'app-abc1234')
    sections = {s.text.split('\n', 1)[0]: s for s in im.split_sections(im._analysis_of(doc))}
    overview, components, schema = sections['## Overview'], sections['## Key Components'], sections['## Database Schema']
    provider.replies = [lambda body: answer({
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

        # Edits against a hash the section doesn't have can't publish.
        repo.write('src/m3.py', 'z = 3\n')
        repo.commit()
        stale = im.split_sections(im._analysis_of(new))[1]
        provider.replies = [answer({'base_document_sha256': new.sha256, 'sections': [
            {'op': 'replace', 'id': stale.id, 'expected_sha256': '0' * 16, 'content': '## Key Components\nwrong\n'}]})]
        failed = update(pristine, repo, session)
        assert failed.status == 'failed' and 'expected_sha256' in failed.reason
        provider.replies = [answer({'base_document_sha256': new.sha256, 'sections': [
            {'op': 'delete', 'id': 'x\n' * 3000, 'expected_sha256': stale.sha256}]})]
        huge = update(pristine, repo, session)
        saved = metadata.read_attempt_state(pristine, 'app-abc1234')['reason']
        assert huge.status == 'failed' and len(huge.reason) <= 240 and saved == huge.reason and '\n' not in saved
        assert im.load_document(pristine, 'app-abc1234').text == new.text


FULL_REPLY = ("QUICK_REFERENCE_START\nType: API Service\nLanguage: Python\nFramework: None\nDatabase: None\n"
              "APIs: REST\nPort: N/A\nDependencies: Stripe\nQUICK_REFERENCE_END\nONE_LINE_SUMMARY_START\n"
              "A rebuilt API.\nONE_LINE_SUMMARY_END\nRELATED_REPOS_START\nRELATED_REPOS_END\n## Overview\nFresh.\n")


def test_one_exclusion_policy_for_full_builds_tools_and_diffs(monkeypatch, tmp_path):
    repo, base, pristine = setup_pristine(monkeypatch, tmp_path)
    secrets = {'.env.production.sh': 'export TOKEN=SENTINEL-ENV\n', '.envrc': 'export A=SENTINEL-RC\n',
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
    traffic = json.dumps([b for _p, b in provider.sends]) + json.dumps(provider.counts)
    assert 'SENTINEL' not in traffic, 'no credential or binary content reaches the provider'
    assert 'safe source' in traffic and 'EXAMPLE_VAR=' in traffic
    doc = im.load_document(pristine, 'app-abc1234')
    assert doc.info['coverage'].startswith('collector-selected source analyzed; 2 files withheld (binary file, credential file)')
    assert "outside the collector's selection" in doc.info['coverage'] and 'complete' not in doc.info['coverage']
    assert 'src/__init__.py' in traffic

    # The read tools, search and the diff apply the same policy, including a credential renamed
    # unchanged to an ordinary, collector-eligible path.
    repo.write('.env.production.sh', 'export TOKEN=SENTINEL-ENV2\n')
    repo.git('mv', '.envrc', 'src/runtime.py')
    target = repo.commit('change secrets')
    tools = snap.SnapshotTools(snap.GitSnapshot(repo.path, doc.info['last_commit']), snap.GitSnapshot(repo.path, target), ['p'])
    for path in [p for p in secrets if p != '.envrc']:
        assert 'unavailable: credential file' in tools.run('read_file', json.dumps({'path': path}))
    assert 'unavailable: binary file' in tools.run('read_file', '{"path": "src/blob.py"}')
    assert 'unavailable' not in tools.run('read_file', '{"path": "src/__init__.py"}')
    assert tools.run('search', '{"literal": "SENTINEL"}') == '[no matches]'
    base_snap, target_snap = snap.GitSnapshot(repo.path, doc.info['last_commit']), snap.GitSnapshot(repo.path, target)
    changes = snap.changes_between(repo.path, doc.info['last_commit'], target)
    pages, omitted = snap.build_diff(repo.path, doc.info['last_commit'], target, base_snap.manifest(),
                                     target_snap.manifest(), changes)
    assert 'SENTINEL' not in ''.join(pages)
    assert {p for p, _why in omitted} == {'.env.production.sh', 'src/runtime.py'}

    # A full rebuild from that baseline document keeps the credential's origin too: the renamed file
    # is withheld from count and send bodies and recorded as omitted, in sync and in the pilot.
    provider.sends.clear(); provider.counts.clear()
    provider.replies = [claude([{"type": "text", "text": FULL_REPLY}])]
    with PreflightSession() as session:
        assert update(pristine, repo, session, force=True).status == 'published'
    traffic = json.dumps([b for _p, b in provider.sends]) + json.dumps(provider.counts)
    assert 'SENTINEL' not in traffic and provider.counts and provider.messages()
    assert 'src/__init__.py' in traffic
    rebuilt = im.load_document(pristine, 'app-abc1234')
    assert '3 files withheld (binary file, credential file)' in rebuilt.info['coverage']

    provider.sends.clear(); provider.counts.clear()
    provider.replies = [claude([{"type": "text", "text": FULL_REPLY}])]
    pilot_dir, result = run_pilot(tmp_path / 'pilot', repo, doc.text, 'full', target)
    traffic = json.dumps([b for _p, b in provider.sends]) + json.dumps(provider.counts)
    assert result['status'] == 'complete' and 'SENTINEL' not in traffic and provider.messages()
    assert {'path': 'src/runtime.py', 'reason': 'credential file'} in result['omitted']


PILOT_REPO = 'ReperioHealth/reperio-telehealth'


def run_pilot(pilot_dir, repo, baseline_text, mode, target):
    """Run the pilot script in-process (sockets stay blocked) from `baseline_text`, which is renamed
    to the pilot repository. Returns (pilot_dir, the results JSON)."""
    import importlib.util
    from pathlib import Path
    pilot_dir.mkdir(parents=True, exist_ok=True)
    (pilot_dir / 'baseline.md').write_text(baseline_text.replace(FULL, PILOT_REPO))
    path = Path(__file__).resolve().parents[2] / 'scripts' / 'pilot-incremental-metadata.py'
    spec = importlib.util.spec_from_file_location('pilot_incremental_metadata', path)
    pilot = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(pilot)
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
    provider.replies = [tool_use('read_file', {'path': 'src/m0.py', 'limit': 3}),
                        answer({'base_document_sha256': doc.sha256, 'sections': []})]
    with PreflightSession() as session:
        assert update(pristine, repo, session).status == 'published'
    sends = provider.messages()
    assert len(sends) == 2 and len(provider.counts) == 2
    # The second request is counted exactly as it is sent: tools, the thinking block, the tool result.
    count, send = provider.counts[1], sends[1]
    for key in ('messages', 'system', 'tools'):
        assert count[key] == send[key], key
    assert {t['name'] for t in count['tools']} == {s['name'] for s in snap.TOOL_SPECS}
    assert any(b.get('type') == 'thinking' for m in count['messages'] for b in m['content'] if isinstance(b, dict))
    assert any(b.get('type') == 'tool_result' for m in count['messages'] for b in m['content'] if isinstance(b, dict))
    state = metadata.read_attempt_state(pristine, 'app-abc1234')
    assert state['usage']['calls'] == 2 and state['usage']['cost_usd'] > 0

    # A tool result that pushes the next request past the input budget stops before that send.
    repo.write('src/m1.py', 'q = 1\n')
    repo.commit()
    provider.sends.clear(); provider.counts.clear()
    doc = im.load_document(pristine, 'app-abc1234')
    provider.replies = [tool_use('read_file', {'path': 'src/m0.py'}),
                        answer({'base_document_sha256': doc.sha256, 'sections': []})]
    provider.count_tokens = lambda body: 2_000_000 if any(
        isinstance(b, dict) and b.get('type') == 'tool_result' for m in body['messages'] for b in m['content']) else 1000
    with PreflightSession() as session:
        outcome = update(pristine, repo, session)
    assert outcome.status == 'failed' and 'would not fit' in outcome.reason
    assert len(provider.messages()) == 1

    # No authoritative count (the endpoint is down): no local fallback, no send.
    provider.sends.clear(); provider.counts.clear()
    provider.count_tokens = lambda body: httpx.Response(503, json={}, request=httpx.Request('POST', 'https://x'))
    with PreflightSession() as session:
        outcome = update(pristine, repo, session)
    assert outcome.status == 'skipped' and 'count unavailable' in outcome.reason and not provider.messages()

    # An incomplete final reply is charged once and never retried or published.
    provider.sends.clear(); provider.counts.clear()
    provider.count_tokens = 1000
    provider.replies = [claude([{"type": "text", "text": '{"base_document_sha256": "'}], stop='max_tokens')]
    with PreflightSession() as session:
        outcome = update(pristine, repo, session)
    assert outcome.status == 'failed' and 'incomplete' in outcome.reason
    assert len(provider.messages()) == 1 and outcome.usage['calls'] == 1 and outcome.usage['cost_usd'] > 0
    assert im.load_document(pristine, 'app-abc1234').sha256 == doc.sha256

    # Without a ledger an unreliable-usage reply keeps its reservation and the total is shown as unknown.
    repo.write('src/m2.py', 'w = 4\n')
    repo.commit()
    provider.sends.clear(); provider.counts.clear()
    doc = im.load_document(pristine, 'app-abc1234')
    zero = tool_use('read_diff', {'page': 1})
    zero['usage'] = {}
    provider.replies = [zero, answer({'base_document_sha256': doc.sha256, 'sections': []})]
    ctx, events = _ctx()
    with PreflightSession() as session:
        S.generate_repo_metadata((REPO_CONFIG, 'app-abc1234', None, 'app', 'cyan', 1), session,
                                 _sync_args(_incremental_repos=frozenset({FULL})), ctx)
    assert ctx.stats['metadata_generated'] == 1 and ctx.stats['unknown_cost_calls'] == 1
    assert any(e[0] == 'progress' and e[1] and 'cost unknown (known subtotal $' in e[1] for e in events)
    logged = [f for name, f in events if name == 'metadata_incremental']
    assert logged[0]['cost'].startswith('cost unknown') and logged[0]['unknown_cost_calls'] == 1
    state = metadata.read_attempt_state(pristine, 'app-abc1234')
    assert state['usage']['cost_usd'] is None and state['usage']['retained_reservation_usd'] > 0

    # The Responses API shape: a function call, then the final answer.
    from repo_radar import llm
    provider.sends.clear()
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

    def moved(body):
        repo.write('src/m9.py', 'later = 1\n')
        repo.commit('pushed meanwhile')
        return good

    unsafe = {'delimiter_in_brief': {'fields': {'brief': 'Payments --- API'}},
              'delimiter_in_coverage_note': {'coverage_note': 'checked src --- skipped tests'}}
    if failure in unsafe:
        good = answer({'base_document_sha256': old.sha256, 'sections': [], **unsafe[failure]})
    provider.replies = {'generation_error': [httpx.Response(500, json={"error": {"message": "boom"}})],
                        'parse_failure': [claude([{"type": "text", "text": "Here is my update!"}])],
                        'full_degraded': [claude([{"type": "text", "text": "A repository. No markers here."}])],
                        'repository_moved': [moved]}.get(failure, [good])
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
            assert outcome.status == ('skipped' if failure == 'repository_moved' else 'failed'), outcome
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
        monkeypatch.setattr(S, '_generate_incremental', lambda *a: (_ for _ in ()).throw(RuntimeError('worker broke')))
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

def test_pilot_cap_survives_failure_and_restart(monkeypatch, tmp_path):
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
        reply = tool_use('read_diff', {'page': 1})
        reply['usage'] = raw_usage
        provider.replies = [reply, answer({'base_document_sha256': doc.sha256, 'sections': []})]
        with PreflightSession() as session:
            with pytest.raises(im.StaleUpdate, match="cost is unknown"):
                im.run_incremental(repo.path, FULL, doc, decision, MODEL, session, budget)
        assert len(provider.messages()) == 1, raw_usage
        usage = budget.summary()
        assert usage['cost_usd'] is None and usage['unknown_cost_calls'] == 1 and usage['retained_reservation_usd'] > 0
        reopened = Ledger(ledger_path, 40.0, allowances)
        assert reopened.spent() == pytest.approx(usage['retained_reservation_usd'])
        with pytest.raises(BudgetExceeded, match='reconcile'):
            Budget(MODEL, ledger=reopened, label='full').reserve({'other': 1}, 1, 1)

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
