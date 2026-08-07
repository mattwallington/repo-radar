"""LLM integration, model configuration, and rate limiting."""

import math
import os
import re
from collections import namedtuple
from datetime import datetime

from repo_radar.constants import YELLOW, RED, RESET, CYAN, GREEN

# TODO: refactor sync_mode to use analyze_repo_chunk and combine_chunk_analyses

DEFAULT_MODEL = 'claude-sonnet-5'

# Maximum input context window for each supported model.
#
# These are INPUT context windows, not output token limits.
# Based on litellm model cost map as of March 2026.
KNOWN_LIMITS = {
    # ── Anthropic Claude ──────────────────────────────────────────────
    # Claude 5.x / newest 4.x (latest)
    "claude-opus-5": 1000000,
    "claude-sonnet-5": 1000000,
    "claude-opus-4-8": 1000000,
    "claude-opus-4-7": 1000000,
    "claude-fable-5": 1000000,
    # Claude 4.6
    "claude-opus-4-6": 1000000,
    "claude-opus-4-6-20260205": 1000000,
    "claude-sonnet-4-6": 1000000,
    # Claude 4.5
    "claude-opus-4-5": 200000,
    "claude-opus-4-5-20251101": 200000,
    "claude-sonnet-4-5": 200000,
    "claude-sonnet-4-5-20250929": 200000,
    "claude-haiku-4-5": 200000,
    "claude-haiku-4-5-20251001": 200000,
    # Claude 4.x
    "claude-opus-4-1": 200000,
    "claude-opus-4-1-20250805": 200000,

    # ── Google Gemini ─────────────────────────────────────────────────
    # Gemini 3.x
    "gemini/gemini-3.6-flash": 1048576,
    "gemini/gemini-3.5-flash": 1048576,
    "gemini/gemini-3.1-pro-preview": 1048576,
    "gemini/gemini-3.1-flash-lite": 1048576,
    "gemini/gemini-3-flash-preview": 1048576,
    # Gemini 2.5
    "gemini/gemini-2.5-pro": 1048576,
    "gemini/gemini-2.5-flash": 1048576,
    "gemini/gemini-2.5-flash-lite": 1048576,
    # Convenience aliases
    "gemini/gemini-pro-latest": 1048576,
    "gemini/gemini-flash-latest": 1048576,
    "gemini/gemini-flash-lite-latest": 1048576,

    # ── OpenAI ────────────────────────────────────────────────────────
    # GPT-5.6 / 5.5 (latest)
    "gpt-5.6-sol": 1050000,
    "gpt-5.6-terra": 1050000,
    "gpt-5.6-luna": 1050000,
    "gpt-5.5": 1050000,
    "gpt-5.5-pro": 1050000,
    # GPT-5.x
    "gpt-5.4": 1050000,
    "gpt-5.4-pro": 1050000,
    # 272K INPUT, not 1.05M. OpenAI documents both mini and nano at 400K total context with 128K
    # max output; 400K - 128K = 272K, which is litellm's max_input_tokens for each. The 1.05M
    # entries were the wrong-direction table error (over-reporting the usable input window), so the
    # chunker packed ~787K-token prompts against a 272K ceiling. This table stores input windows.
    "gpt-5.4-mini": 272000,
    "gpt-5.4-nano": 272000,
    # 272K INPUT, not the 400K total context. OpenAI documents 400K total with a 128K maximum
    # output, and 400000 - 128000 = 272000 exactly, which is litellm's max_input_tokens. This
    # table stores input windows (see the header), so 400K was the total misfiled as an input
    # limit — and since the chunking threshold is 75% of this value, it produced 300K-token
    # chunks against a 272K input ceiling. https://developers.openai.com/api/docs/models/gpt-5.3-codex
    "gpt-5.3-codex": 272000,
    "gpt-5.2": 272000,
    "gpt-5.2-pro": 272000,
    "gpt-5.1": 272000,
    "gpt-5": 272000,
    "gpt-5-mini": 272000,
    "gpt-5-nano": 272000,
    # GPT-4.x
    "gpt-4.1": 1047576,
    "gpt-4.1-mini": 1047576,
    "gpt-4.1-nano": 1047576,
    "gpt-4o": 128000,
    "gpt-4o-mini": 128000,
    "gpt-4-turbo": 128000,
    # Reasoning models
    "o4-mini": 200000,
    "o3": 200000,
    "o3-mini": 200000,
    "o3-pro": 200000,
    "o1": 200000,
    "o1-pro": 200000,
}

# Retired model ids -> their current replacement. Keys must never overlap
# with KNOWN_LIMITS (a model is either live or migrated, not both).
MODEL_MIGRATIONS = {
    # Anthropic
    "claude-3-7-sonnet-20250219": "claude-sonnet-5",
    "claude-3-5-sonnet-20241022": "claude-sonnet-5",
    "claude-3-5-sonnet-20240620": "claude-sonnet-5",
    "claude-3-sonnet-20240229": "claude-sonnet-5",
    "claude-3-5-haiku-20241022": "claude-haiku-4-5",
    "claude-3-haiku-20240307": "claude-haiku-4-5",
    "claude-3-opus-20240229": "claude-opus-4-8",
    "claude-opus-4-20250514": "claude-opus-4-8",
    "claude-4-opus-20250514": "claude-opus-4-8",
    "claude-sonnet-4-20250514": "claude-sonnet-5",
    "claude-4-sonnet-20250514": "claude-sonnet-5",
    # OpenAI
    "o1-preview": "o3",
    "o1-mini": "o3",
    "codex-mini-latest": "gpt-5.4-mini",
    "gpt-5-codex": "gpt-5.3-codex",
    "gpt-5.1-codex": "gpt-5.3-codex",
    "gpt-5.1-codex-max": "gpt-5.3-codex",
    "gpt-5.2-codex": "gpt-5.3-codex",
    "gpt-5.1-codex-mini": "gpt-5.4-mini",
    # Google
    "gemini/gemini-2.0-flash": "gemini/gemini-2.5-flash",
    "gemini/gemini-2.0-flash-001": "gemini/gemini-2.5-flash",
    "gemini/gemini-2.0-flash-exp": "gemini/gemini-2.5-flash",
    "gemini/gemini-2.0-flash-lite": "gemini/gemini-2.5-flash-lite",
    "gemini/gemini-3-pro-preview": "gemini/gemini-3.1-pro-preview",
    "gemini/gemini-3.1-flash-lite-preview": "gemini/gemini-3.1-flash-lite",
    "gemini/gemini-1.5-pro": "gemini/gemini-2.5-pro",
    "gemini/gemini-1.5-flash": "gemini/gemini-2.5-flash",
}


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


# Fallback model chain - each model has separate rate limit quotas
GEMINI_FALLBACK_CHAIN = [
    'gemini/gemini-3.5-flash',
    'gemini/gemini-3.1-flash-lite',
    'gemini/gemini-2.5-flash',
    'gemini/gemini-2.5-flash-lite',
]


def get_fallback_model(current_model):
    """Next Gemini fallback model, or None. Non-Gemini models have no fallback
    (returning a Gemini model here would switch providers and fail auth)."""
    if provider_for_model(current_model) != 'gemini':
        return None
    try:
        i = GEMINI_FALLBACK_CHAIN.index(current_model)
        return GEMINI_FALLBACK_CHAIN[i + 1] if i < len(GEMINI_FALLBACK_CHAIN) - 1 else None
    except ValueError:
        return GEMINI_FALLBACK_CHAIN[0]


def get_model_context_window(model):
    """Get the maximum input context window for a model."""
    return KNOWN_LIMITS.get(model, 128000)  # Conservative default


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


def call_llm(model, prompt, max_tokens=8192):
    """Call an LLM and return (text, api_cost, raw_response).

    Transparently routes between ``litellm.completion`` (Chat Completions,
    works for Anthropic/Gemini/older OpenAI) and ``litellm.responses``
    (Responses API, required for newer OpenAI codex/pro/deep-research models).

    Callers get back a single string of generated text, the dollar cost if
    litellm reports it, and the raw response object so they can still feed
    it to ``rate_limit_tracker.update_from_response``.
    """
    import litellm

    if _needs_responses_api(model):
        response = litellm.responses(
            model=model,
            input=prompt,
            max_output_tokens=max_tokens,
        )
        # Prefer the convenience attribute; fall back to manual extraction.
        text = getattr(response, 'output_text', None)
        if not text:
            try:
                text = response.output[0].content[0].text
            except (AttributeError, IndexError, TypeError):
                text = ''
    else:
        response = litellm.completion(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=max_tokens,
        )
        try:
            text = response.choices[0].message.content or ''
        except (AttributeError, IndexError):
            text = ''

    api_cost = 0.0
    hidden = getattr(response, '_hidden_params', None)
    if isinstance(hidden, dict):
        api_cost = hidden.get('response_cost') or 0.0

    return text, api_cost, response


def get_chunking_threshold(model):
    """Get appropriate chunking threshold for a model.

    Uses 75% of context window to leave room for:
    - Prompt template (2-4k tokens)
    - Output tokens (8-16k tokens)
    - Safety margin

    Returns:
        int: Maximum tokens to use for input content
    """
    context_window = get_model_context_window(model)
    # Use 75% for input content, reserve 25% for prompt overhead and output
    return int(context_window * 0.75)


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


def _budget_tokens(text, model):
    """The conservative budget token count as a bare int, for the bounding math in this module."""
    return count_tokens_for_budget(text, model).count


class RateLimitTracker:
    """Track API rate limits across requests."""
    def __init__(self):
        self.limits = {
            'requests': None,
            'tokens': None
        }
        self.remaining = {
            'requests': None,
            'tokens': None
        }
        self.reset_times = {
            'requests': None,
            'tokens': None
        }
        self.last_update = None

    def update_from_response(self, response):
        """Extract rate limit info from litellm response headers."""
        try:
            if hasattr(response, '_hidden_params') and 'additional_headers' in response._hidden_params:
                headers = response._hidden_params['additional_headers']

                # Extract limits
                if 'x-ratelimit-limit-requests' in headers:
                    self.limits['requests'] = int(headers['x-ratelimit-limit-requests'])
                if 'x-ratelimit-limit-tokens' in headers:
                    self.limits['tokens'] = int(headers['x-ratelimit-limit-tokens'])

                # Extract remaining
                if 'x-ratelimit-remaining-requests' in headers:
                    self.remaining['requests'] = int(headers['x-ratelimit-remaining-requests'])
                if 'x-ratelimit-remaining-tokens' in headers:
                    self.remaining['tokens'] = int(headers['x-ratelimit-remaining-tokens'])

                # Extract reset times
                if 'x-ratelimit-reset-requests' in headers:
                    self.reset_times['requests'] = headers['x-ratelimit-reset-requests']
                if 'x-ratelimit-reset-tokens' in headers:
                    self.reset_times['tokens'] = headers['x-ratelimit-reset-tokens']

                self.last_update = datetime.now()
        except Exception as e:
            # Silently ignore if headers not available
            pass

    def get_status_string(self):
        """Get a formatted status string for display."""
        if self.remaining['requests'] is None:
            return "Rate limits: Unknown"

        parts = []
        if self.remaining['requests'] is not None and self.limits['requests'] is not None:
            parts.append(f"Requests: {self.remaining['requests']}/{self.limits['requests']}")
        if self.remaining['tokens'] is not None and self.limits['tokens'] is not None:
            tokens_remaining_k = self.remaining['tokens'] // 1000
            tokens_limit_k = self.limits['tokens'] // 1000
            parts.append(f"Tokens: {tokens_remaining_k}K/{tokens_limit_k}K")

        return " • ".join(parts) if parts else "Rate limits: Unknown"

    def should_wait(self):
        """Check if we should wait before making next request."""
        # Wait if we're at or near the limit
        if self.remaining['requests'] is not None and self.remaining['requests'] <= 2:
            return True
        if self.remaining['tokens'] is not None and self.remaining['tokens'] <= 10000:
            return True
        return False

    def get_wait_time(self):
        """Get recommended wait time in seconds."""
        # If we're at the limit, wait a bit
        if self.remaining['requests'] is not None and self.remaining['requests'] <= 2:
            return 10  # Wait 10 seconds
        if self.remaining['tokens'] is not None and self.remaining['tokens'] <= 10000:
            return 5
        return 0

# Global rate limit tracker
rate_limit_tracker = RateLimitTracker()


def _frame_file(file_info):
    """Exactly how the analysis prompt renders one file. Single source of truth so the chunker
    budgets the SAME string the model will actually receive."""
    return f"=== {file_info['path']} ({file_info['size']} bytes) ===\n{file_info['content']}\n"


def _build_analysis_prompt(full_name, chunk, chunk_num, total_chunks):
    """The assembled chunk-analysis prompt. Shared by the chunker (to budget the finished prompt)
    and analyze_repo_chunk (to send it), so the budgeted text and the sent text can never drift."""
    combined_content = "\n".join(_frame_file(f) for f in chunk)
    chunk_info = f" (chunk {chunk_num}/{total_chunks})" if total_chunks > 1 else ""
    return f"""Analyze this portion of the repository and provide analysis.

Repository: {full_name}{chunk_info}

Analyze these files and provide:

1. **Overview**: What functionality is covered in these files?
2. **Technology Stack**: Languages, frameworks, and libraries used.
3. **Key Components**: Important files and what they do.
4. **API Endpoints/Interfaces**: Any APIs, exported functions, or public interfaces.
5. **Dependencies**: External services, databases, or systems referenced (list specific service names).

Be specific and technical. Focus on what's present in these files.

Repository files:

{combined_content}
"""


def _truncate_file_to_budget(file_info, budget_tokens, model):
    """Trim one file so its FRAMED budget count (including a truncation notice) fits budget_tokens.

    Fail-closed: shrinks until it actually fits rather than trusting a single chars-per-token
    estimate, because the estimate is exactly what undercounts Claude 4.7+.
    """
    original = file_info['content']
    raw = count_tokens_accurate(original, model)
    notice = (f"\n\n... (truncated: ~{raw:,} tokens exceeded the "
              f"{budget_tokens:,}-token per-file budget)")
    keep = len(original)
    for _ in range(10):
        candidate = {**file_info, 'content': original[:keep] + notice}
        if keep <= 1 or _budget_tokens(_frame_file(candidate) + "\n", model) <= budget_tokens:
            return candidate
        keep = max(int(keep * 0.7), 1)
    return {**file_info, 'content': original[:1] + notice}


def chunk_repo_files(files, model, max_tokens=None, full_name=""):
    """Chunk files so each chunk's FINISHED analysis prompt fits the model's budget.

    Two fixes over the previous version, which counted raw file bytes against the window:
    - It budgets the assembled prompt — the instruction template plus every file's "=== path (N
      bytes) ===" framing — so the number checked is the number the server will see.
    - It counts through count_tokens_for_budget, so Claude 4.7+ (whose litellm tokenizer
      undercounts by ~1.6x) is packed against an inflated, fail-closed estimate.
    Together these stop a chunk that "fit" locally from assembling into a prompt the server rejects.
    """
    threshold = get_chunking_threshold(model) if max_tokens is None else max_tokens

    # Fixed overhead on every prompt: the instruction template PLUS the "(chunk N/M)" header. Size
    # the header for a large chunk count so a many-chunk repo can't overflow by the header's width.
    template_overhead = _budget_tokens(_build_analysis_prompt(full_name, [], 999, 999), model)
    content_budget = max(threshold - template_overhead, 1)
    # Keep the original per-file cap intent (don't let one huge file dominate) but never above the
    # room a chunk actually has.
    single_file_budget = min(100000, content_budget)

    # Each file's framed form ends in "\n" and "\n".join adds another between files; count the
    # extra separator per file so a packed chunk's real prompt can't drift over the budget.
    def framed_budget(file_info):
        return _budget_tokens(_frame_file(file_info) + "\n", model)

    processed_files = []
    for file_info in files:
        if framed_budget(file_info) > single_file_budget:
            processed_files.append(_truncate_file_to_budget(file_info, single_file_budget, model))
        else:
            processed_files.append(file_info)

    chunks, current_chunk, current_tokens = [], [], 0
    for file_info in processed_files:
        framed_tokens = framed_budget(file_info)
        if current_chunk and current_tokens + framed_tokens > content_budget:
            chunks.append(current_chunk)
            current_chunk, current_tokens = [], 0
        current_chunk.append(file_info)
        current_tokens += framed_tokens
    if current_chunk:
        chunks.append(current_chunk)

    return chunks


def analyze_repo_chunk(full_name, chunk, chunk_num, total_chunks):
    """Analyze a chunk of repository files."""
    prompt = _build_analysis_prompt(full_name, chunk, chunk_num, total_chunks)

    # Retry logic
    max_retries = 3
    base_wait = 2

    for retry in range(max_retries):
        try:
            analysis, api_cost, _ = call_llm(get_ai_model(), prompt, max_tokens=8192)
            return analysis, api_cost

        except Exception as e:
            error_str = str(e)

            # Check if it's a rate limit error
            if 'RateLimitError' in error_str or '429' in error_str or 'RESOURCE_EXHAUSTED' in error_str:
                if retry < max_retries - 1:
                    import time
                    import random

                    wait_time = base_wait ** (retry + 1) + random.uniform(0, 1)

                    # Try to parse suggested delay
                    if 'retry in' in error_str.lower():
                        try:
                            import re
                            match = re.search(r'retry in (\d+(?:\.\d+)?)', error_str.lower())
                            if match:
                                suggested_wait = float(match.group(1))
                                wait_time = max(wait_time, suggested_wait)
                        except:
                            pass

                    print(f"    {YELLOW}Rate limit, retrying in {wait_time:.1f}s{RESET}")
                    time.sleep(wait_time)
                    continue
                else:
                    raise Exception(f"Rate limit exceeded after {max_retries} retries")
            else:
                raise


# Guards for hierarchical synthesis. Coverage is the priority — every chunk reaches the final
# report — so these bound the work rather than dropping input; hitting them degrades to an
# explicit, warned truncation instead of silently analysing part of the repository.
SYNTHESIS_MAX_DEPTH = 4
SYNTHESIS_MAX_CALLS = 32
SYNTHESIS_OUTPUT_TOKENS = 16384


_TRUNCATION_MARKER = "\n\n[truncated by repo-radar: exceeded the synthesis budget]\n"


def _framed(analysis, index):
    """Exactly how _build_synthesis_prompt wraps one analysis."""
    return f"\n--- Analysis Part {index} ---\n{analysis}\n"


def _batch_by_budget(full_name, analyses, budget, model):
    """Group analyses into ordered, contiguous batches whose PROMPT fits the token budget.

    Budget is measured against the finished prompt — template overhead plus each
    "Analysis Part N" wrapper — not against the bare analysis text. Counting only the text
    understates the prompt and makes "no prompt exceeds the budget" false by the size of the
    framing.

    Order is preserved: a batch is always a contiguous run, so part ordering still reflects
    the repository's chunk order after any number of rounds. An analysis too large even alone
    lands in a batch by itself, for the caller to handle.
    """
    overhead = _budget_tokens(_build_synthesis_prompt(full_name, []), model)
    batches, current, current_tokens = [], [], 0
    for analysis in analyses:
        tokens = _budget_tokens(_framed(analysis, len(current) + 1), model)
        if current and overhead + current_tokens + tokens > budget:
            batches.append(current)
            current, current_tokens = [], 0
            tokens = _budget_tokens(_framed(analysis, 1), model)
        current.append(analysis)
        current_tokens += tokens
    if current:
        batches.append(current)
    return batches


def _truncate_to_tokens(text, max_tokens, model):
    """Cut text to a token budget INCLUDING the marker, so the result really fits.

    Appending the marker after sizing overshoots by the marker's own length, which is how a
    1,000-token request came back as 1,009 tokens. Last resort only.
    """
    if max_tokens <= 0 or _budget_tokens(text, model) <= max_tokens:
        return text
    room = max(max_tokens - _budget_tokens(_TRUNCATION_MARKER, model), 1)
    # Start from a proportional guess, then walk down until it genuinely fits.
    cut = max(int(len(text) * (room / max(_budget_tokens(text, model), 1)) * 0.95), 1)
    candidate = text[:cut]
    while cut > 1 and _budget_tokens(candidate, model) > room:
        cut = int(cut * 0.9)
        candidate = text[:cut]
    return candidate + _TRUNCATION_MARKER


def _total_tokens(analyses, model):
    return sum(_budget_tokens(a, model) for a in analyses)


def _fits(full_name, parts, budget, model):
    return _budget_tokens(_build_synthesis_prompt(full_name, parts), model) <= budget


def _truncate_all_to_fit(full_name, analyses, budget, model):
    """Truncate analyses so the FINISHED prompt fits the budget. NEVER returns over-budget.

    Dividing the budget by the item count ignores the per-item "Analysis Part N" wrapper and
    the template, so shares derived that way can assemble into an over-budget prompt.

    Per-part tightening also has a floor: every part costs its framing plus a truncation
    marker (~23 tokens here) no matter how hard its content is cut. Past roughly
    budget/floor parts, no number of tightening passes can succeed — the previous version
    simply gave up after five tries and returned the over-budget result anyway. So beyond
    that point the parts are collapsed into ONE compact analysis with lightweight separators
    and a single global marker, which pays the framing and marker cost once instead of n times.

    Returns [] when even one framed, marked part cannot fit; the caller must then produce a
    local result rather than send a request that is certain to be rejected.
    """
    if not analyses:
        return []
    overhead = _budget_tokens(_build_synthesis_prompt(full_name, []), model)
    framing = _budget_tokens(_framed('', 1), model)
    marker = _budget_tokens(_TRUNCATION_MARKER, model)

    share = max((budget - overhead) // len(analyses) - framing, 1)
    trimmed = [_truncate_to_tokens(a, share, model) for a in analyses]

    # Verify rather than assume: token counting is approximate, so tighten until it fits.
    for _ in range(5):
        if _fits(full_name, trimmed, budget, model):
            return trimmed
        share = max(int(share * 0.85), 1)
        trimmed = [_truncate_to_tokens(a, share, model) for a in trimmed]

    # Terminal path: the per-part floor exceeds the budget, so tightening cannot converge.
    return _compact_every_part(full_name, analyses, budget, model)


# Below this, an excerpt conveys nothing useful about its part, so representing every part is
# no longer meaningful and honest local degradation is the better answer.
MIN_EXCERPT_TOKENS = 8


def _hard_truncate(text, max_tokens, model):
    """Cut to a token budget with NO marker — the caller adds one global warning instead.

    Marking every excerpt is what creates the per-part floor this path exists to escape.
    """
    if max_tokens <= 0:
        return ''
    if _budget_tokens(text, model) <= max_tokens:
        return text
    cut = max(int(len(text) * (max_tokens / max(_budget_tokens(text, model), 1)) * 0.95), 1)
    candidate = text[:cut]
    while cut > 1 and _budget_tokens(candidate, model) > max_tokens:
        cut = int(cut * 0.9)
        candidate = text[:cut]
    return candidate


def _compact_every_part(full_name, analyses, budget, model):
    """One analysis holding an excerpt of EVERY part, or [] if that cannot fit.

    Joining the parts and cutting the head keeps the prompt bounded but silently drops whole
    later analyses — and the model, seeing no evidence anything is missing, returns normal
    QUICK_REFERENCE and summary sections that parse as healthy. That is the original defect
    this feature exists to prevent (authoritative metadata for a repository mostly unread),
    reintroduced through the emergency path.

    So every part gets an equal excerpt under one global warning. If the parts cannot each
    carry at least MIN_EXCERPT_TOKENS, this returns [] and the caller degrades locally, which
    is honest, rather than emitting a confident synthesis of a fraction of the repository.
    """
    overhead = _budget_tokens(_build_synthesis_prompt(full_name, []), model)
    framing = _budget_tokens(_framed('', 1), model)
    warning = (f"[repo-radar: all {len(analyses)} analysis parts below are excerpted to fit "
               f"the model's context window; detail within each part is lost]\n")
    separators = [f"\n[{i}] " for i in range(1, len(analyses) + 1)]

    room = budget - overhead - framing
    fixed = _budget_tokens(warning, model) + sum(
        _budget_tokens(s, model) for s in separators)
    share = (room - fixed) // max(len(analyses), 1)
    if share < MIN_EXCERPT_TOKENS:
        return []

    for _ in range(6):
        excerpts = [_hard_truncate(a, share, model) for a in analyses]
        compact = warning + ''.join(s + e for s, e in zip(separators, excerpts))
        if _fits(full_name, [compact], budget, model):
            return [compact]
        share = int(share * 0.8)
        if share < MIN_EXCERPT_TOKENS:
            return []
    return []


def _local_degraded_analysis(full_name, part_count):
    """A synthesis-failed placeholder produced WITHOUT an LLM call.

    Used only when the budget cannot accommodate even a single framed part. Sending the
    request anyway would guarantee a context-window rejection; returning this keeps the sync
    alive and leaves a record the metadata parser will flag as degraded.
    """
    return (f"Synthesis for {full_name} could not be completed: {part_count} analysis parts "
            f"could not be reduced to fit the model's context window. Re-run with a "
            f"larger-context model, or narrow the repository's file selection.")


def _fallback_chain(model, limit=6):
    """The model plus every model a rate limit could fall back to, in order."""
    chain, seen, current = [model], {model}, model
    while len(chain) < limit:
        nxt = get_fallback_model(current)
        if not nxt or nxt in seen:
            break
        chain.append(nxt)
        seen.add(nxt)
        current = nxt
    return chain


def _synthesis_budget(full_name, model):
    """Total prompt-token budget for one synthesis call against `model`.

    Budgets for the SMALLEST window in the fallback chain, not just `model`. A rate-limit
    fallback happens inside the caller's retry, which re-sends the SAME prompt to a different
    model — so re-budgeting after the call is too late. If the prompt was sized for a larger
    window it overflows the moment the fallback serves it. Sizing for the smallest candidate
    up front means whichever model answers, the prompt fits.

    Includes measured template overhead and reserves room for the response, so callers compare
    a FINISHED prompt against this number.

    Known limitation, deliberately not addressed here: this takes the smallest numeric WINDOW
    across the chain, but batching still counts tokens with the current model's tokenizer. A
    fallback whose tokenizer counted the same text differently could therefore be handed a
    prompt sized by another model's count. Measured against the live chain this is a non-issue
    — litellm counts an identical sample identically for all four Gemini fallback models — and
    Gemini is the only provider with a fallback chain at all. A fully generic guarantee would
    re-count each candidate with its own tokenizer and take the worst case.
    """
    budget = min(get_chunking_threshold(m) for m in _fallback_chain(model)) \
        - SYNTHESIS_OUTPUT_TOKENS
    overhead = _budget_tokens(_build_synthesis_prompt(full_name, []), model)
    # Always leave workable room for content beyond the template itself.
    return max(budget, overhead + 1000)


def combine_chunk_analyses(full_name, analyses, model=None,
                           max_depth=SYNTHESIS_MAX_DEPTH, max_calls=SYNTHESIS_MAX_CALLS,
                           synthesize=None):
    """Combine chunk analyses into one cohesive report, bounded by the model's context.

    Previously every chunk analysis was concatenated into a single prompt with no bound, so a
    large repository produced a request larger than the context window and the whole metadata
    step failed (observed: 1,189,532 tokens against a 1,000,000 limit). Chunking bounded the
    INPUT files but nothing bounded their combination.

    This performs a hierarchical map-reduce instead: analyses are grouped into ordered batches
    that each fit the budget, every batch is synthesised, and the results are combined again
    until a single bounded synthesis remains. Every chunk therefore reaches the final report.

    synthesize: optional callable(prompt, model) -> (text, cost, model_used), letting a caller
    supply its own retry, model-fallback and rate-limit accounting while this function keeps
    ownership of bounding. model_used is fed back into the budget, because a fallback model may
    have a smaller window than the one the budget was computed from — budgeting one model while
    calling another is how a "bounded" prompt can still overflow.

    Returns (final_analysis, total_api_cost) — cost is aggregated across every round.
    """
    analyses = [a for a in (analyses or []) if a and str(a).strip()]
    if not analyses:
        return "", 0.0
    if model is None:
        model = get_ai_model()

    def run(batch):
        """One synthesis call. Returns (text, cost) and re-budgets if the model changed."""
        nonlocal model, budget
        prompt = _build_synthesis_prompt(full_name, batch)
        if synthesize is None:
            text, cost, used = _synthesize_once(full_name, batch, model)
        else:
            text, cost, used = synthesize(prompt, model)
        if used and used != model:
            # Re-derive the budget from whichever model actually served the request, keeping
            # the smaller of the two so a fallback can only tighten, never loosen.
            model = used
            budget = min(budget, _synthesis_budget(full_name, used))
        return text, cost

    budget = _synthesis_budget(full_name, model)

    level = list(analyses)
    depth = 0
    calls = 0
    total_cost = 0.0

    while True:
        # A single analysis larger than one whole request cannot be reduced by regrouping —
        # nothing to combine it with. Truncation is the only remaining move, and it is loud.
        if len(level) == 1 and _budget_tokens(
                _build_synthesis_prompt(full_name, level), model) > budget:
            print(f"    {YELLOW}Synthesis: one analysis alone exceeds the context budget; "
                  f"truncating it to fit (some detail from this section is lost){RESET}")
            level = _truncate_all_to_fit(full_name, level, budget, model)
            if not level:
                print(f"    {YELLOW}Synthesis: budget cannot fit even one part; "
                      f"reporting locally without a request{RESET}")
                return _local_degraded_analysis(full_name, 1), total_cost

        batches = _batch_by_budget(full_name, level, budget, model)

        if len(batches) == 1:
            text, cost = run(batches[0])
            return text, total_cost + cost

        # Guards: stop expanding work, but never by dropping input. The +1 reserves the final
        # reduction, so max_calls is a true ceiling rather than a ceiling on the map rounds.
        remaining_depth = max_depth - depth
        if remaining_depth <= 0 or calls + len(batches) + 1 > max_calls:
            reason = ('maximum depth' if remaining_depth <= 0 else 'maximum call budget')
            print(f"    {YELLOW}Synthesis: {reason} reached with {len(level)} parts; "
                  f"truncating each to fit a single final pass{RESET}")
            trimmed = _truncate_all_to_fit(full_name, level, budget, model)
            if not trimmed:
                print(f"    {YELLOW}Synthesis: {len(level)} parts cannot be reduced to fit; "
                      f"reporting locally without a request{RESET}")
                return _local_degraded_analysis(full_name, len(level)), total_cost
            text, cost = run(trimmed)
            return text, total_cost + cost

        print(f"    {CYAN}Synthesising {len(level)} parts in {len(batches)} batches "
              f"(round {depth + 1}){RESET}")

        before = _total_tokens(level, model)
        combined = []
        pending = list(level)
        while pending:
            # Enforce the ceiling per CALL, not per round: re-batching can yield more calls
            # than the round's estimate (a shrunk budget makes smaller batches), so a
            # once-per-round check can be overrun mid-round.
            if calls + 1 >= max_calls:
                print(f"    {YELLOW}Synthesis: call budget reached mid-round; truncating the "
                      f"remaining {len(combined) + len(pending)} parts to finish{RESET}")
                remainder = combined + pending
                trimmed = _truncate_all_to_fit(full_name, remainder, budget, model)
                if not trimmed:
                    print(f"    {YELLOW}Synthesis: {len(remainder)} parts cannot be reduced "
                          f"to fit; reporting locally without a request{RESET}")
                    return _local_degraded_analysis(full_name, len(remainder)), total_cost
                text, cost = run(trimmed)
                return text, total_cost + cost

            # Re-batch before every call rather than once per round: a mid-round fallback to a
            # smaller-window model shrinks the budget, and batches sized for the previous model
            # would overflow it. Re-deriving keeps each prompt within the CURRENT budget.
            batch = _batch_by_budget(full_name, pending, budget, model)[0]
            text, cost = run(batch)
            combined.append(text)
            total_cost += cost
            calls += 1
            pending = pending[len(batch):]

        # No-progress detection: if a whole round failed to shrink the material, recursing
        # again would loop at the same size and burn the call budget for nothing.
        if len(combined) >= len(level) and _total_tokens(combined, model) >= before:
            print(f"    {YELLOW}Synthesis: a round made no progress ({before:,} tokens in, "
                  f"{_total_tokens(combined, model):,} out); truncating to finish{RESET}")
            trimmed = _truncate_all_to_fit(full_name, combined, budget, model)
            if not trimmed:
                print(f"    {YELLOW}Synthesis: {len(combined)} parts cannot be reduced to "
                      f"fit; reporting locally without a request{RESET}")
                return _local_degraded_analysis(full_name, len(combined)), total_cost
            text, cost = run(trimmed)
            return text, total_cost + cost

        level = combined
        depth += 1


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


def _synthesize_once(full_name, analyses, model=None):
    """Run ONE synthesis call over the given analyses. Returns (text, api_cost, model_used).

    The caller is responsible for ensuring the batch fits the model's budget; this function
    does not bound its input. `model` is threaded in explicitly — resolving it independently
    via get_ai_model() would let the caller budget one model and this call use another.
    """
    if model is None:
        model = get_ai_model()
    combined_prompt = _build_synthesis_prompt(full_name, analyses)

    # Use retry logic
    max_retries = 3
    base_wait = 2

    for retry in range(max_retries):
        try:
            final_analysis, api_cost, _ = call_llm(
                model, combined_prompt, max_tokens=SYNTHESIS_OUTPUT_TOKENS
            )
            return final_analysis, api_cost, model

        except Exception as e:
            error_str = str(e)

            if 'RateLimitError' in error_str or '429' in error_str or 'RESOURCE_EXHAUSTED' in error_str:
                if retry < max_retries - 1:
                    import time
                    import random

                    wait_time = base_wait ** (retry + 1) + random.uniform(0, 1)

                    if 'retry in' in error_str.lower():
                        try:
                            import re
                            match = re.search(r'retry in (\d+(?:\.\d+)?)', error_str.lower())
                            if match:
                                suggested_wait = float(match.group(1))
                                wait_time = max(wait_time, suggested_wait)
                        except:
                            pass

                    print(f"    {YELLOW}Rate limit, retrying in {wait_time:.1f}s{RESET}")
                    time.sleep(wait_time)
                    continue
                else:
                    raise Exception(f"Rate limit exceeded after {max_retries} retries")
            else:
                raise
