"""LLM integration: model configuration, request building, token counting and the one sender."""

import math
import os
import re
from collections import namedtuple

from repo_radar.constants import RED, GREEN
from repo_radar import model_catalog
from repo_radar.model_catalog import is_known_model

DEFAULT_MODEL = 'claude-sonnet-5-5'

# Maximum input context window for each supported model.
#
# These are INPUT context windows, not output token limits.
# Derived from repo_radar.model_catalog.MODEL_CAPS (the verified per-model capability table);
# see that module for source_url/source_date provenance per model.
KNOWN_LIMITS = {m: c.max_input for m, c in model_catalog.MODEL_CAPS.items()}

# Model families and tiers, each listed NEWEST FIRST. Every id ever offered belongs to exactly one
# tier: one provider, one family, one tier (a Flash stays a Flash, a Sonnet a Sonnet, a mini a
# mini). A retired id migrates directly to the newest member of its tier that is still known, so
# retiring a model means dropping its MODEL_CAPS row and marking its lifecycle row retired; there
# is no hand-written migration to add. OpenAI's own replacements set its tiers: mini-tier models
# move to Terra, nano-tier models to Luna, and the o-series reasoning models to the line their
# tier continues in.
MODEL_TIERS = {
    "claude-sonnet": [
        "claude-sonnet-5-5", "claude-sonnet-5", "claude-sonnet-4-6", "claude-sonnet-4-5",
        "claude-sonnet-4-5-20250929", "claude-sonnet-4-20250514", "claude-4-sonnet-20250514",
        "claude-3-7-sonnet-20250219", "claude-3-5-sonnet-20241022", "claude-3-5-sonnet-20240620",
        "claude-3-sonnet-20240229",
    ],
    "claude-opus": [
        "claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6",
        "claude-opus-4-6-20260205", "claude-opus-4-5", "claude-opus-4-5-20251101", "claude-opus-4-1",
        "claude-opus-4-1-20250805", "claude-opus-4-20250514", "claude-4-opus-20250514",
        "claude-3-opus-20240229",
    ],
    "claude-haiku": [
        "claude-haiku-5-5", "claude-haiku-4-5", "claude-haiku-4-5-20251001",
        "claude-3-5-haiku-20241022", "claude-3-haiku-20240307",
    ],
    "claude-fable": ["claude-fable-5-1", "claude-fable-5"],
    # Flagship line: bare gpt-5.6 is an alias of gpt-5.6-sol, and OpenAI names Sol as the
    # replacement for gpt-5 and o3.
    "openai-sol": [
        "gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.5", "gpt-5.4", "gpt-5.2", "gpt-5.1", "gpt-5",
        "gpt-4.1", "gpt-4o", "o3", "o1", "o1-preview",
    ],
    "openai-astra": ["gpt-6-astra"],
    # Mini tier: OpenAI names Terra as gpt-5-mini's replacement.
    "openai-terra": [
        "gpt-6.1-terra", "gpt-5.6-terra", "gpt-5.4-mini", "gpt-5-mini", "gpt-4.1-mini", "gpt-4o-mini",
        "o4-mini", "o3-mini", "o1-mini", "gpt-5.1-codex-mini", "codex-mini-latest",
    ],
    # Nano tier: OpenAI names Luna as gpt-5-nano's and gpt-5.4-nano's replacement.
    "openai-luna": ["gpt-6-luna", "gpt-5.6-luna", "gpt-5.4-nano", "gpt-5-nano", "gpt-4.1-nano"],
    "openai-pro": ["gpt-5.5-pro", "gpt-5.4-pro", "gpt-5.2-pro", "o3-pro", "o1-pro"],
    "openai-codex": ["gpt-5.3-codex", "gpt-5.2-codex", "gpt-5.1-codex-max", "gpt-5.1-codex", "gpt-5-codex"],
    "gemini-flash": [
        "gemini/gemini-3.8-flash", "gemini/gemini-3.6-flash", "gemini/gemini-3.5-flash",
        "gemini/gemini-3-flash-preview", "gemini/gemini-2.5-flash", "gemini/gemini-2.0-flash",
        "gemini/gemini-2.0-flash-001", "gemini/gemini-2.0-flash-exp", "gemini/gemini-1.5-flash",
    ],
    "gemini-flash-lite": [
        "gemini/gemini-3.5-flash-lite", "gemini/gemini-3.1-flash-lite",
        "gemini/gemini-3.1-flash-lite-preview", "gemini/gemini-2.5-flash-lite",
        "gemini/gemini-2.0-flash-lite",
    ],
    "gemini-pro": [
        "gemini/gemini-3.1-pro-preview", "gemini/gemini-3-pro-preview", "gemini/gemini-2.5-pro",
        "gemini/gemini-1.5-pro",
    ],
    "gemini-argon": ["gemini/gemini-4-argon"],
}

# Floating aliases point at whatever the vendor currently serves, so they are not tier members.
FLOATING_ALIASES = frozenset({
    "gemini/gemini-pro-latest", "gemini/gemini-flash-latest", "gemini/gemini-flash-lite-latest",
})


def newest_in_tier(tier):
    """The newest still-known member of a tier, or None when the whole tier is retired."""
    return next((m for m in MODEL_TIERS[tier] if m in KNOWN_LIMITS), None)


def derive_migrations(tiers, known):
    """Retired id -> the newest known member of its own tier. Keys never overlap `known` and every
    value is known, so a migration is always one direct step. A tier with no known member yields
    nothing; the lifecycle gate then fails on its retired ids until someone decides where they go."""
    out = {}
    for members in tiers.values():
        target = next((m for m in members if m in known), None)
        if target:
            out.update({m: target for m in members if m not in known})
    return out


MODEL_MIGRATIONS = derive_migrations(MODEL_TIERS, KNOWN_LIMITS)


def migrate_model(model):
    """Map a retired model id to its current replacement, or pass through."""
    return MODEL_MIGRATIONS.get(model, model)


def provider_for_model(model):
    """Classify a model id as 'gemini', 'anthropic', 'openai', or None."""
    if not model:
        return None
    if model.startswith('gemini/') or model.startswith('gemini-'):
        return 'gemini'
    if model.startswith('claude') or model.startswith('anthropic/'):
        return 'anthropic'
    if (model.startswith('gpt') or model.startswith('openai/') or model.startswith('chatgpt/')
            or model.startswith('chatgpt-') or model.startswith('codex') or re.match(r'^o\d', model)):
        return 'openai'
    return None


def get_ai_model():
    """Get the AI model from env or default, migrating retired ids."""
    return migrate_model(os.environ.get('AI_MODEL', DEFAULT_MODEL))


def _needs_responses_api(model):
    """True if this model only supports OpenAI's /v1/responses endpoint.

    Newer OpenAI models (all ``-codex`` and most ``-pro`` / ``-deep-research``
    variants) don't accept /v1/chat/completions requests — they have to go
    through the Responses API. We check litellm's model cost map to find out,
    with a name-based heuristic as a fallback for models litellm doesn't know
    about yet.
    """
    try:
        import litellm
        info = litellm.model_cost.get(model) or litellm.model_cost.get(f"openai/{model}") or {}
        endpoints = info.get('supported_endpoints', []) or []
        mode = info.get('mode', '')
        if endpoints:
            return '/v1/responses' in endpoints and '/v1/chat/completions' not in endpoints
        if mode == 'responses':
            return True
    except Exception:
        pass

    # Fallback heuristic — only OpenAI models ever use the Responses API.
    # Gate on the centralized provider classifier first, so a non-OpenAI id
    # whose name merely contains "-pro"/"-codex" (e.g. gemini-*-pro,
    # claude-*-pro) can never be misrouted to /v1/responses.
    if provider_for_model(model) != 'openai':
        return False
    bare = model.lower().split('/', 1)[-1]
    return any(marker in bare for marker in ('-codex', '-pro', '-deep-research', 'codex-mini'))


def _completion_messages(prompt):
    """The messages structure of a single-prompt completion request, as preflight counts it."""
    return [{"role": "user", "content": prompt}]


# Claude models that think adaptively by default (Opus 5.5 and Fable 5.1 can't turn it off). We keep
# thinking on but ask for medium effort, natively via output_config, so thinking doesn't crowd out
# the analysis. Our conservative starting policy, not a vendor-prescribed setting.
CLAUDE_MEDIUM_EFFORT_MODELS = frozenset({
    "claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-1",
})

# Per-model output floors, for models whose thinking shares the output budget. Google recommends at
# least 32,768 for Argon; the medium-effort Claude models get 16,384, so a chunk call rises from
# 8,192 while synthesis already asks for 16,384. Every other model keeps the stage's own budget.
MIN_OUTPUT_TOKENS = {
    "gemini/gemini-4-argon": 32768,
    **{m: 16384 for m in CLAUDE_MEDIUM_EFFORT_MODELS},
}


def output_budget(model, requested):
    """Output tokens a send to `model` reserves and requests when its stage asks for `requested`.

    Every request is built with this value and every reservation uses the same one, so a prompt is
    always accepted against the output it will actually request.
    """
    return max(requested, MIN_OUTPUT_TOKENS.get(model, 0))


# finish_reason values that mean the reply was cut off. litellm maps Anthropic's max_tokens stop to
# "length", but it maps any stop reason it doesn't know to "stop", so the context-window stop would
# read as a clean finish; _map_context_window_stop_as_truncation() maps that one to "length" too.
_TRUNCATED_FINISH_REASONS = frozenset({"length", "model_context_window_exceeded"})


def _map_context_window_stop_as_truncation():
    """Make litellm report Anthropic's model_context_window_exceeded stop as "length".

    Depends on litellm's private _FINISH_REASON_MAP (pinned 1.105.6), which lacks this reason.
    Adding the entry once is idempotent and safe for concurrent workers, unlike swapping the mapper
    per request. If litellm moves the map this import fails loudly rather than accepting truncated
    replies. Remove it once the pinned litellm maps this reason itself.
    """
    from litellm.litellm_core_utils.core_helpers import _FINISH_REASON_MAP
    _FINISH_REASON_MAP.setdefault("model_context_window_exceeded", "length")


# Statuses that mean the provider turned the request away before doing billable work: a rate limit, and
# service unavailable or overloaded. 500, 502 and 504 aren't among them: a gateway can fail after the model ran.
_UNPAID_STATUSES = frozenset({429, 503, 529})
_UNPAID_PROVIDER_STATUSES = frozenset({'RESOURCE_EXHAUSTED', 'UNAVAILABLE', 'OVERLOADED'})
_UNPAID_TYPES = frozenset({'RateLimitError', 'ServiceUnavailableError'})
_MAYBE_PROCESSED_TYPES = frozenset({'Timeout', 'TimeoutError', 'APITimeoutError', 'ReadTimeout', 'APIConnectionError',
                                    'ConnectionError', 'RemoteProtocolError'})


def error_charge(error):
    """A trustworthy positive charge carried by a failed send's error, or None: a structured response_cost on
    the exception, its body or error detail, or its (or its response's) _hidden_params. The largest is kept."""
    from repo_radar.metadata_budget import reliable_cost
    response = getattr(error, 'response', None)
    body = getattr(error, 'body', None)
    detail = body.get('error', body) if isinstance(body, dict) else None
    places = [error, body, detail, getattr(error, '_hidden_params', None), getattr(response, '_hidden_params', None)]
    found = []
    for place in places:
        value = place.get('response_cost') if isinstance(place, dict) else getattr(place, 'response_cost', None)
        if place is not None and reliable_cost(value):
            found.append(float(value))
    return max(found) if found else None


def account_failed_send(budget, reservation, error):
    """The money for a send that raised, the one rule for every sender: a charge it carries is recorded in
    full and keeps at least its bound; a positively unpaid refusal gives its bound back; anything else keeps
    the whole bound as unknown. Never a retry decision."""
    charge = error_charge(error) if isinstance(error, Exception) else None
    if charge is not None:
        budget.settle(reservation, None, charge)
    elif isinstance(error, Exception) and refused_without_charge(error):
        budget.refuse(reservation)
    else:
        budget.fail(reservation)


def refused_without_charge(error):
    """True only on positive evidence that the provider refused a send without charging for it, so its
    reservation can go back to the attempt: a typed or structured 429, a 503 or 529, or Gemini's structured
    RESOURCE_EXHAUSTED, UNAVAILABLE or OVERLOADED. Structured evidence the other way wins over a permissive
    class name: any other status (500, 502 and 504 included), a timeout or dropped connection, or reported
    usage or cost. Digits in the message never count. This only decides money; nothing is retried."""
    from repo_radar.spending import SpendingStopped
    if isinstance(error, SpendingStopped):
        return True   # stopped before it went out: nothing was sent
    if error_charge(error) is not None:
        return False   # charge evidence vetoes a refund
    names = {cls.__name__ for cls in type(error).__mro__}
    if names & _MAYBE_PROCESSED_TYPES:
        return False
    response = getattr(error, 'response', None)
    if getattr(error, 'usage', None) is not None or getattr(response, 'usage', None) is not None:
        return False
    body = getattr(error, 'body', None)
    detail = body.get('error', body) if isinstance(body, dict) else {}
    detail = detail if isinstance(detail, dict) else {}
    if detail.get('usage') is not None or (isinstance(body, dict) and body.get('usage') is not None):
        return False
    signals = [getattr(error, 'status_code', None), getattr(response, 'status_code', None),
               getattr(error, 'status', None), getattr(error, 'code', None), detail.get('code'), detail.get('status')]
    numbers = {int(s) for s in signals if isinstance(s, (int, str)) and not isinstance(s, bool)
               and str(s).isdigit() and 100 <= int(s) <= 599}
    named = {s for s in signals if isinstance(s, str) and not s.isdigit()}
    if numbers:
        return numbers <= _UNPAID_STATUSES and not (named - _UNPAID_PROVIDER_STATUSES)
    if named:
        return named <= _UNPAID_PROVIDER_STATUSES
    return bool(names & _UNPAID_TYPES)


# ── One structured turn (incremental metadata) ──────────────────────────────────────────────────
# The one sender for metadata requests, single-turn or tool-using.
# The canonical request built by Conversation.request() is exactly what call_model_turn sends and
# what preflight.PreflightSession.count_request counts, so the counted request and the sent request
# cannot drift. No retries, model fallback or SDK retries happen here: one request, one reply.

ToolCall = namedtuple("ToolCall", "id name arguments")
# diagnostics: safe facts about how a reply ended (turn_diagnostics), never its text or reasoning.
TurnResult = namedtuple("TurnResult", "status text tool_calls usage cost reply_items diagnostics", defaults=(None,))
TurnUsage = namedtuple("TurnUsage", "input_tokens output_tokens")


def _plain(item):
    """A provider object as plain JSON data, dropping unset fields."""
    if hasattr(item, 'model_dump'):
        return item.model_dump(exclude_none=True)
    if isinstance(item, dict):
        return {k: v for k, v in item.items() if v is not None}
    return dict(item)


def turn_diagnostics(finish, raw_usage):
    """How a reply ended, in a small fixed shape: the normalized finish reason and the provider's total and
    reasoning output counts when it reported them. Holds no prompt, answer or reasoning text."""
    def count(value):
        return value if isinstance(value, int) and not isinstance(value, bool) else None
    details = (getattr(raw_usage, 'completion_tokens_details', None) or getattr(raw_usage, 'output_tokens_details', None))
    total = getattr(raw_usage, 'completion_tokens', None)
    if total is None:
        total = getattr(raw_usage, 'output_tokens', None)
    reason = ''.join(ch for ch in str(finish) if ch.isalnum() or ch in '_-')[:40] if finish else None
    return {'finish_reason': reason, 'output_tokens': count(total),
            'reasoning_tokens': count(getattr(details, 'reasoning_tokens', None))}


class Conversation:
    """One attempt's request history, kept in the native shape of the model's endpoint.

    Chat Completions keeps OpenAI-style messages (litellm translates them per provider, including
    Anthropic thinking blocks and tool results); the Responses API keeps input items, including the
    reasoning items a tool-call reply must send back. Fresh for every attempt; never persisted.
    With system=None the request is just the messages: a single prompt, as the full adapter sends.
    """

    def __init__(self, model, system, tools=()):
        self.model = model
        self.endpoint = 'responses' if _needs_responses_api(model) else 'chat'
        self.system = system
        self.tools = list(tools)
        self.items = []

    def add_user(self, text):
        self.items.append({"role": "user", "content": text})

    def add_reply(self, turn):
        self.items.extend(turn.reply_items)

    def add_tool_result(self, call_id, text):
        if self.endpoint == 'chat':
            self.items.append({"role": "tool", "tool_call_id": call_id, "content": text})
        else:
            self.items.append({"type": "function_call_output", "call_id": call_id, "output": text})

    def _tool_defs(self):
        if self.endpoint == 'chat':
            return [{"type": "function", "function": dict(t)} for t in self.tools]
        return [{"type": "function", **t} for t in self.tools]

    def request(self, max_tokens, low_effort=False, json_reply=False):
        """The complete request for the next turn, as plain JSON data. On Gemini, where thinking shares the
        output limit, a short stage can ask for low reasoning effort and a JSON-only reply; other providers
        keep their usual options."""
        out = output_budget(self.model, max_tokens)
        if self.endpoint == 'chat':
            system = [{"role": "system", "content": self.system}] if self.system is not None else []
            req = {"endpoint": "chat", "model": self.model, "messages": [*system, *self.items], "max_tokens": out}
            if self.model in CLAUDE_MEDIUM_EFFORT_MODELS:
                req["output_config"] = {"effort": "medium"}
            if provider_for_model(self.model) == 'gemini':
                if low_effort:
                    req["reasoning_effort"] = "low"
                if json_reply:
                    req["response_format"] = {"type": "json_object"}
        else:
            req = {"endpoint": "responses", "model": self.model, "input": list(self.items), "max_output_tokens": out}
            if self.system is not None:
                req["instructions"] = self.system
        if self.tools:
            req["tools"] = self._tool_defs()
        return req


def call_model_turn(request, timeout):
    """Send one canonical request (Conversation.request()) and classify the reply.

    Returns TurnResult(status, text, tool_calls, usage, cost, reply_items). status is 'tool_calls'
    (valid intermediate work), 'complete', or 'incomplete' / 'refused' / 'empty', which are never
    publishable. usage is TurnUsage or None; cost is the provider-reported cost or None when it
    wasn't reported, never a guessed zero. Exceptions propagate; nothing is retried.
    """
    import litellm

    model = request["model"]
    provider = provider_for_model(model)
    params = {k: v for k, v in request.items() if k != "endpoint"}
    if request["endpoint"] == "responses":
        response = litellm.responses(custom_llm_provider=provider, timeout=timeout, max_retries=0, **params)
        items = [_plain(i) for i in (getattr(response, 'output', None) or [])]
        calls = [ToolCall(i.get("call_id"), i.get("name"), i.get("arguments") or "{}")
                 for i in items if i.get("type") == "function_call"]
        parts = [c for i in items if i.get("type") == "message" for c in (i.get("content") or [])]
        text = "".join(c.get("text", "") for c in parts if c.get("type") == "output_text")
        if getattr(response, 'status', None) != "completed":
            status = "incomplete"
        elif any(c.get("type") == "refusal" for c in parts):
            status = "refused"
        elif calls:
            status = "tool_calls"
        else:
            status = "complete" if text.strip() else "empty"
        raw = getattr(response, 'usage', None)
        usage = (TurnUsage(getattr(raw, 'input_tokens', None), getattr(raw, 'output_tokens', None))
                 if raw is not None else None)
        reply = items
        incomplete = getattr(response, 'incomplete_details', None)
        diagnostics = turn_diagnostics(getattr(incomplete, 'reason', None) or getattr(response, 'status', None), raw)
    else:
        if provider == 'anthropic':
            _map_context_window_stop_as_truncation()
        response = litellm.completion(custom_llm_provider=provider, timeout=timeout, num_retries=0,
                                      max_retries=0, **params)
        choice = response.choices[0] if response.choices else None
        message = getattr(choice, 'message', None)
        finish = getattr(choice, 'finish_reason', None)
        text = (getattr(message, 'content', None) or '') if message is not None else ''
        calls = [ToolCall(tc.id, tc.function.name, tc.function.arguments or "{}")
                 for tc in (getattr(message, 'tool_calls', None) or [])]
        if finish in _TRUNCATED_FINISH_REASONS:
            status = "incomplete"
        elif finish == "content_filter":
            status = "refused"
        elif calls:
            status = "tool_calls"
        else:
            status = "complete" if text.strip() else "empty"
        raw = getattr(response, 'usage', None)
        usage = (TurnUsage(getattr(raw, 'prompt_tokens', None), getattr(raw, 'completion_tokens', None))
                 if raw is not None else None)
        reply = [{"role": "assistant", **_plain(message)}] if message is not None else []
        diagnostics = turn_diagnostics(finish, raw)
    hidden = getattr(response, '_hidden_params', None)
    cost = hidden.get('response_cost') if isinstance(hidden, dict) else None
    cost = float(cost) if isinstance(cost, (int, float)) and not isinstance(cost, bool) else None
    return TurnResult(status, text, calls, usage, cost, reply, diagnostics)


def count_tokens_accurate(text, model):
    """Count tokens using litellm's model-specific tokenizer.

    Falls back to improved estimation if tokenizer fails.

    Args:
        text: Text to count tokens for
        model: Model name for accurate tokenization

    Returns:
        int: Estimated token count
    """
    try:
        import litellm
        return litellm.token_counter(model=model, text=text)
    except Exception as e:
        # Fallback to improved estimation (3.5 chars per token for code)
        return int(len(text) / 3.5)


# Claude 4.7 and later ship a NEWER tokenizer than the one litellm bundles. litellm maps every
# Claude generation to the same bundled anthropic_tokenizer.json, so it counts 4.7+ text with the
# 4.5/4.6 tokenizer and UNDERCOUNTS: three observed production failures ran 1.596x, 1.600x and
# 1.617x below the server's own count (e.g. our 745,509 -> Anthropic's 1,189,532), which is what
# pushed 1M-window Claude prompts past the ceiling while Gemini (a genuinely different, accurate
# tokenizer) never overflowed. Until the Count Tokens endpoint preflight lands (the durable fix),
# budget these models as if every prompt were this factor larger than litellm reports.
NEW_TOKENIZER_MODELS = frozenset({
    "claude-opus-4-7", "claude-opus-4-8", "claude-fable-5",
    "claude-sonnet-5", "claude-opus-5",
    "claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-1",
})
CLAUDE_UNDERCOUNT_FACTOR = 1.7  # covers the 1.617x worst case observed; the 25% window reserve adds
                                # headroom. Deliberately NOT applied to 4.5/4.6 (accurate tokenizer).

BudgetCount = namedtuple("BudgetCount", "count raw strategy factor")


def count_tokens_for_budget(text, model):
    """Conservative token count for BUDGETING — deliberately distinct from count_tokens_accurate.

    Never surface this as a token 'count' in progress, cost, or diagnostic displays: for Claude
    4.7+ it intentionally inflates the raw estimate to compensate for litellm's stale bundled
    tokenizer. A rejected multi-hundred-thousand-token generation costs real money and wall-clock;
    over-reserving does not. Returns the adjusted count alongside the raw count, the strategy, and
    the factor, so callers/diagnostics can keep both figures and future server discrepancies stay
    measurable.
    """
    raw = count_tokens_accurate(text, model)
    if model in NEW_TOKENIZER_MODELS:
        return BudgetCount(math.ceil(raw * CLAUDE_UNDERCOUNT_FACTOR), raw,
                           "claude-4.7+-conservative", CLAUDE_UNDERCOUNT_FACTOR)
    return BudgetCount(raw, raw, "litellm", 1.0)


def _frame_file(file_info):
    """Exactly how the analysis prompt renders one file. Single source of truth so the chunker
    budgets the SAME string the model will actually receive."""
    return f"=== {file_info['path']} ({file_info['size']} bytes) ===\n{file_info['content']}\n"


def _build_analysis_prompt(full_name, chunk, chunk_num, total_chunks):
    """The assembled chunk-analysis prompt. Shared by the chunkers (to count the finished prompt)
    and the senders, so the counted text and the sent text can never drift. It asks about the same
    eight subjects the final document covers."""
    combined_content = "\n".join(_frame_file(f) for f in chunk)
    chunk_info = f" (chunk {chunk_num}/{total_chunks})" if total_chunks > 1 else ""
    return f"""Analyze this portion of the repository and provide analysis.

Repository: {full_name}{chunk_info}

Report what these files show about each of these subjects:

1. **Overview**: What functionality is covered in these files?
2. **Technology Stack**: Languages, frameworks, and libraries used.
3. **Architecture**: Structure, layers and patterns visible in these files.
4. **Key Components**: Important files and what they do.
5. **API Endpoints/Interfaces**: Any APIs, exported functions, or public interfaces.
6. **Dependencies**: External services, databases, or systems referenced (list specific service names).
7. **Database Schema**: Tables, models, migrations or queries that show how data is stored.
8. **Configuration**: Environment variables, configuration files and settings.

These files are only part of the repository, so they may say nothing about some subjects. Report only
facts these files support, and write "not present here" for a subject they don't cover. Be specific
and technical.

Repository files:

{combined_content}
"""


def _build_full_repo_prompt(full_name, files):
    """The single-shot whole-repository analysis prompt (used when the repo fits without chunking).

    The one authoritative builder, so the string the decision COUNTS is the string sync SENDS —
    the previous code built this inline and decided on file-content tokens alone, ignoring the
    template, paths, sizes and framing, then sent a prompt far larger than it had measured.
    """
    combined_content = "\n".join(_frame_file(f) for f in files)
    return f"""Analyze this repository: {full_name}

Provide a comprehensive analysis in the following format:

IMPORTANT: Start with these structured sections using the EXACT markers:

QUICK_REFERENCE_START
Type: [API Service|Frontend App|Backend Service|Library|Infrastructure|Database|Mobile App|CLI Tool]
Language: [Primary language and version]
Framework: [Main framework or "None"]
Database: [Database type and name or "None"]
APIs: [Brief description of exposed APIs or "None"]
Port: [Port number or "N/A"]
Dependencies: [Comma-separated list of key external services/systems]
QUICK_REFERENCE_END

ONE_LINE_SUMMARY_START
[Single sentence: what it does + key technologies]
ONE_LINE_SUMMARY_END

RELATED_REPOS_START
[Comma-separated list of OTHER repository names this integrates with, or leave empty]
RELATED_REPOS_END

After the structured sections above, provide comprehensive markdown analysis with these sections:

1. **Overview**: Overall purpose and features of the repository
2. **Technology Stack**: All languages, frameworks, and major libraries
3. **Architecture**: Overall architecture patterns and structure
4. **Key Components**: Most important directories/files across the entire repo
5. **API Endpoints/Interfaces**: All exposed APIs or public interfaces
6. **Dependencies**: All external services and systems (be specific with service names)
7. **Database Schema**: Database structure if present
8. **Configuration**: Required environment variables and configuration

Format in clean markdown. Be thorough but avoid redundancy.

Repository files:

{combined_content}
"""


# Guards for the full adapter's hierarchical synthesis (summary_pipeline.FullBuild). Coverage is the
# priority, so these bound the work rather than dropping input: every chunk reaches the final reduction,
# and when a guard runs out the build stops and the document stays, with nothing excerpted or truncated.
SYNTHESIS_MAX_DEPTH = 4
SYNTHESIS_MAX_CALLS = 32
SYNTHESIS_OUTPUT_TOKENS = 16384


def _build_synthesis_prompt(full_name, analyses):
    """Build the synthesis prompt for a single round of combining."""

    combined_prompt = f"""You are reviewing multiple analyses of different parts of the repository "{full_name}".

Please synthesize these into ONE comprehensive repository analysis in the following format:

IMPORTANT: Start with these structured sections using the EXACT markers:

QUICK_REFERENCE_START
Type: [API Service|Frontend App|Backend Service|Library|Infrastructure|Database|Mobile App|CLI Tool]
Language: [Primary language and version]
Framework: [Main framework or "None"]
Database: [Database type and name or "None"]
APIs: [Brief description of exposed APIs or "None"]
Port: [Port number or "N/A"]
Dependencies: [Comma-separated list of key external services/systems]
QUICK_REFERENCE_END

ONE_LINE_SUMMARY_START
[Single sentence: what it does + key technologies]
ONE_LINE_SUMMARY_END

RELATED_REPOS_START
[Comma-separated list of OTHER repository names this integrates with, or leave empty]
RELATED_REPOS_END

After the structured sections above, provide comprehensive markdown analysis with these sections:

1. **Overview**: Overall purpose and features of the repository
2. **Technology Stack**: All languages, frameworks, and major libraries
3. **Architecture**: Overall architecture patterns and structure
4. **Key Components**: Most important directories/files across the entire repo
5. **API Endpoints/Interfaces**: All exposed APIs or public interfaces
6. **Dependencies**: All external services and systems (be specific with service names)
7. **Database Schema**: Database structure if present
8. **Configuration**: Required environment variables and configuration

Format in clean markdown. Be thorough but avoid redundancy.

Here are the analyses to combine:

"""

    for i, analysis in enumerate(analyses, 1):
        combined_prompt += f"\n--- Analysis Part {i} ---\n{analysis}\n"

    return combined_prompt


# The output a whole-repository request asks for (summary_pipeline.FullBuild).
FULL_REPO_OUTPUT = SYNTHESIS_OUTPUT_TOKENS


# The output every chunk analysis request asks for, before output_budget's per-model floor; its
# acceptance budget uses the same value, so a chunk is accepted against what it will pay for.
CHUNK_OUTPUT = 8192
