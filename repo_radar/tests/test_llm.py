import pytest

from repo_radar import llm


def test_default_model():
    assert llm.DEFAULT_MODEL == 'claude-sonnet-5-5'
    assert llm.DEFAULT_MODEL in llm.KNOWN_LIMITS


def test_provider_for_model():
    assert llm.provider_for_model('gemini/gemini-3.5-flash') == 'gemini'
    assert llm.provider_for_model('claude-sonnet-5') == 'anthropic'
    assert llm.provider_for_model('anthropic/claude-opus-4-8') == 'anthropic'
    assert llm.provider_for_model('gpt-5.6-terra') == 'openai'
    assert llm.provider_for_model('o3') == 'openai'
    assert llm.provider_for_model('o4-mini') == 'openai'
    assert llm.provider_for_model('gpt-5.3-codex') == 'openai'
    assert llm.provider_for_model('chatgpt-4o-latest') == 'openai'
    assert llm.provider_for_model('chatgpt/foo') == 'openai'
    assert llm.provider_for_model('mystery-model') is None
    assert llm.provider_for_model('') is None


def test_migrate_model_every_row_and_passthrough():
    for old, new in llm.MODEL_MIGRATIONS.items():
        assert llm.migrate_model(old) == new, old
    assert llm.migrate_model('claude-sonnet-5') == 'claude-sonnet-5'
    assert llm.migrate_model(llm.DEFAULT_MODEL) == llm.DEFAULT_MODEL


def test_invariants():
    known = set(llm.KNOWN_LIMITS)
    keys = set(llm.MODEL_MIGRATIONS)
    targets = set(llm.MODEL_MIGRATIONS.values())
    assert targets <= known, targets - known                 # inv 2
    assert keys.isdisjoint(known), keys & known              # inv 3
    for old, new in llm.MODEL_MIGRATIONS.items():             # inv 4
        assert llm.provider_for_model(old) == llm.provider_for_model(new), old


def test_get_ai_model_migrates(monkeypatch):
    monkeypatch.setenv('AI_MODEL', 'gpt-5.2-codex')
    assert llm.get_ai_model() == 'gpt-5.3-codex'
    monkeypatch.delenv('AI_MODEL', raising=False)
    assert llm.get_ai_model() == llm.DEFAULT_MODEL


# OpenAI shut these down 2026-10-23. A stored selection must run on the newest model of its own
# tier without a config write; Gemini 2.5 is still served (no shutdown date) and must stay selected.
RETIRED_2026_10_23 = {
    'gpt-4.1-nano': 'gpt-6-luna',
    'o4-mini': 'gpt-6.1-terra',
    'o1': 'gpt-6.1-sol',
    'o3-mini': 'gpt-6.1-terra',
    'o1-pro': 'gpt-5.5-pro',
}


@pytest.mark.parametrize('old,new', sorted(RETIRED_2026_10_23.items()))
def test_get_ai_model_runs_october_retirements_on_replacement(monkeypatch, old, new):
    monkeypatch.setenv('AI_MODEL', old)
    assert llm.get_ai_model() == new
    assert not llm.is_known_model(old)
    assert llm.is_known_model(new)


@pytest.mark.parametrize('model', ['gemini/gemini-2.5-pro', 'gemini/gemini-2.5-flash',
                                   'gemini/gemini-2.5-flash-lite'])
def test_get_ai_model_keeps_gemini_2_5(monkeypatch, model):
    monkeypatch.setenv('AI_MODEL', model)
    assert llm.get_ai_model() == model
    assert llm.is_known_model(model)


def test_retired_model_lands_on_newest_member_of_its_tier():
    # Every retired tier member resolves in one step to its tier's newest known model.
    for tier, members in llm.MODEL_TIERS.items():
        for m in members:
            if m not in llm.KNOWN_LIMITS:
                assert llm.MODEL_MIGRATIONS[m] == llm.newest_in_tier(tier), m
    assert llm.MODEL_MIGRATIONS['gemini/gemini-2.0-flash'] == 'gemini/gemini-3.8-flash'

    # A newer Flash moves the target with no migration edit, and retiring 3.8 Flash migrates it too.
    tiers = {**llm.MODEL_TIERS,
             'gemini-flash': ['gemini/gemini-9-flash', *llm.MODEL_TIERS['gemini-flash']]}
    known = (set(llm.KNOWN_LIMITS) - {'gemini/gemini-3.8-flash'}) | {'gemini/gemini-9-flash'}
    moved = llm.derive_migrations(tiers, known)
    assert moved['gemini/gemini-2.0-flash'] == 'gemini/gemini-9-flash'
    assert moved['gemini/gemini-3.8-flash'] == 'gemini/gemini-9-flash'
    assert {k: v for k, v in moved.items() if not k.startswith('gemini/gemini-')} == \
        {k: v for k, v in llm.MODEL_MIGRATIONS.items() if not k.startswith('gemini/gemini-')}


def test_needs_responses_api_gated_on_openai_provider():
    # An unknown OpenAI codex/pro variant still routes through the Responses API.
    assert llm.provider_for_model('gpt-6-codex') == 'openai'
    assert llm._needs_responses_api('gpt-6-codex') is True
    # A non-OpenAI id whose NAME merely contains "-pro"/"-codex" must never be
    # misrouted to OpenAI's Responses API — the route must agree with the
    # centralized provider classifier (Codex Finding 2, provider/route invariant).
    for m in ('gemini-future-pro', 'claude-future-pro', 'gemini/gemini-9-pro'):
        assert llm.provider_for_model(m) != 'openai', m
        assert llm._needs_responses_api(m) is False, m


# ── Real provider adapters, stubbed at the HTTP transport (no network, no keys) ──────────────────
import importlib.util
import json
import os
import sys
from pathlib import Path

import httpx


@pytest.fixture
def stub_http(monkeypatch):
    """Every outbound httpx request gets a canned provider reply; the bodies are recorded."""
    sent = []

    def handle(self, request):
        body = json.loads(request.content or b'{}')
        sent.append((request.url.host, request.url.path, body))
        if request.url.path.endswith('/responses'):
            return httpx.Response(200, json={
                "id": "r", "object": "response", "created_at": 0, "status": "completed", "model": "m",
                "output": [{"type": "reasoning", "id": "rs", "summary": []},
                           {"type": "message", "id": "o", "role": "assistant", "status": "completed",
                            "content": [{"type": "output_text", "text": "HELLO", "annotations": []}]}],
                "usage": {"input_tokens": 5, "output_tokens": 3, "total_tokens": 8,
                          "input_tokens_details": {"cached_tokens": 0},
                          "output_tokens_details": {"reasoning_tokens": 0}},
                "parallel_tool_calls": True, "tool_choice": "auto", "tools": []})
        if 'generativelanguage' in request.url.host:
            return httpx.Response(200, json={
                "candidates": [{"content": {"role": "model", "parts": [{"text": "plan", "thought": True},
                                                                       {"text": "HELLO"}]},
                                "finishReason": "STOP"}],
                "usageMetadata": {"promptTokenCount": 5, "candidatesTokenCount": 3, "totalTokenCount": 8}})
        return httpx.Response(200, json={
            "id": "m", "type": "message", "role": "assistant", "model": "m", "stop_reason": "end_turn",
            "content": [{"type": "thinking", "thinking": "", "signature": "s"}, {"type": "text", "text": "HELLO"}],
            "usage": {"input_tokens": 5, "output_tokens": 3}})

    monkeypatch.setattr(httpx.HTTPTransport, 'handle_request', handle)
    for var in ('OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY'):
        monkeypatch.setenv(var, 'test-not-a-key')
    return sent


def send(model, max_tokens):
    """One single-prompt request through the one sender, as the full adapter builds it."""
    conversation = llm.Conversation(model, None)
    conversation.add_user('hi')
    return llm.call_model_turn(conversation.request(max_tokens), 60)


def test_responses_send_works_without_the_mcp_package(stub_http):
    # litellm 1.106.0 added proxy/_experimental/mcp_server/catalog.py, which imports `mcp` at module
    # level, and responses() imports it on every call, so every GPT Pro / Codex send fails with
    # "No module named mcp". Our locks don't include `mcp` (a proxy extra); this send must still work.
    assert importlib.util.find_spec('mcp') is None, 'run in a venv built from resources/pydeps'
    assert send('gpt-5.5-pro', 8192).text == 'HELLO'
    [(host, path, body)] = [s for s in stub_http if s[1].endswith('/responses')]
    assert host == 'api.openai.com'
    assert body['max_output_tokens'] == 8192


def test_argon_send_requests_the_output_it_reserved(stub_http):
    model = 'gemini/gemini-4-argon'
    assert send(model, llm.CHUNK_OUTPUT).text == 'HELLO', 'thought parts must not leak into the answer'
    [(_host, _path, body)] = stub_http
    sent = body['generationConfig']['max_output_tokens']
    assert sent == llm.output_budget(model, llm.CHUNK_OUTPUT) == 32768


@pytest.mark.parametrize('model', ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'])
def test_new_claude_models_budget_conservatively_and_send_plain_text(stub_http, model, monkeypatch):
    # Policy: adaptive thinking stays on, effort is medium (native output_config), and chunk and
    # synthesis both request and reserve 16,384 output tokens.
    assert llm.count_tokens_for_budget('x' * 4000, model).strategy == 'claude-4.7+-conservative'
    assert send(model, llm.CHUNK_OUTPUT).text == 'HELLO', 'thinking blocks must not leak into the answer'
    [(host, _path, body)] = stub_http
    assert host == 'api.anthropic.com' and body['model'] == model
    assert body['max_tokens'] == 16384
    assert body['output_config'] == {'effort': 'medium'}
    assert not {'temperature', 'top_p', 'top_k'} & set(body), 'Claude 5.x rejects sampling params'
    assert body.get('thinking', {}).get('type') != 'enabled', 'no legacy budget_tokens thinking'


_OFFLINE_CHILD = r'''
import json, os, socket, sys
import httpx
def blocked(*a, **k): raise OSError("network blocked in test")
socket.socket.connect = blocked
sent = []
def handle(self, request):
    if request.url.host == "raw.githubusercontent.com":   # litellm's remote model map: offline
        raise httpx.ConnectError("offline", request=request)
    sent.append([request.url.host, request.url.path, json.loads(request.content or b"{}").get("model")])
    return httpx.Response(200, json={"id": "c", "object": "chat.completion", "created": 0, "model": "m",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": "HELLO"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8}})
httpx.HTTPTransport.handle_request = handle
sys.path.insert(0, sys.argv[1])
from repo_radar import llm
conversation = llm.Conversation(llm.get_ai_model(), None)
conversation.add_user("hi")
text = llm.call_model_turn(conversation.request(64), 60).text
print(json.dumps({"text": text, "sent": sent, "saved": os.environ["AI_MODEL"]}))
'''


def test_retired_openai_selection_sends_offline_without_litellm_model_map():
    # litellm infers the provider from its downloaded model map; when that fetch fails, its bundled
    # map doesn't know gpt-6.1-terra and refuses the call. The sender names the provider itself.
    import subprocess
    root = str(Path(__file__).resolve().parents[2])
    env = {**os.environ, "OPENAI_API_KEY": "test-not-a-key", "AI_MODEL": "o4-mini"}
    env.pop("LITELLM_LOCAL_MODEL_COST_MAP", None)
    out = subprocess.run([sys.executable, "-I", "-c", _OFFLINE_CHILD, root], env=env,
                         capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr[-2000:]
    result = json.loads(out.stdout.strip().splitlines()[-1])
    assert result == {"text": "HELLO", "saved": "o4-mini",
                      "sent": [["api.openai.com", "/v1/chat/completions", "gpt-6.1-terra"]]}


@pytest.mark.parametrize('content,stop_reason', [
    ([{"type": "thinking", "thinking": "", "signature": "s"}], "end_turn"),  # thinking, no text
    ([{"type": "text", "text": "Partial analys"}], "max_tokens"),           # cut off mid-answer
    # Valid-looking metadata cut off by the context window: litellm maps this raw stop to "stop"
    # unless the sender teaches it otherwise, so the raw reason must come from the transport.
    ([{"type": "text", "text": "QUICK_REFERENCE_START\nType: Service\nQUICK_REFERENCE_END\n"
                               "ONE_LINE_SUMMARY_START\nAn API.\nONE_LINE_SUMMARY_END\n"
                               "RELATED_REPOS_START\nRELATED_REPOS_END\n# Overview\nThe service hand"}],
     "model_context_window_exceeded"),
])
def test_incomplete_claude_reply_is_never_complete(monkeypatch, content, stop_reason):
    import socket

    def blocked(*a, **k):
        raise OSError("network blocked in test")

    monkeypatch.setattr(socket.socket, 'connect', blocked)
    sent = []

    def handle(self, request):
        sent.append(request.url.path)
        return httpx.Response(200, json={
            "id": "m", "type": "message", "role": "assistant", "model": "m", "stop_reason": stop_reason,
            "content": content, "usage": {"input_tokens": 5, "output_tokens": 8192}})

    monkeypatch.setattr(httpx.HTTPTransport, 'handle_request', handle)
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'test-not-a-key')
    assert send('claude-sonnet-5-5', llm.CHUNK_OUTPUT).status in ('incomplete', 'empty'), 'never a usable reply'
    assert [p for p in sent if p == '/v1/messages'] == ['/v1/messages'], 'no retry'
