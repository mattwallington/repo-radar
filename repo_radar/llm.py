"""LLM integration, model configuration, and rate limiting."""

import math
import os
import re
from collections import namedtuple
from datetime import datetime

from repo_radar.constants import YELLOW, RED, RESET, CYAN, GREEN
from repo_radar import model_catalog
from repo_radar.model_catalog import acceptance_budget, get_caps, is_known_model

# TODO: refactor sync_mode to use analyze_repo_chunk and combine_chunk_analyses

DEFAULT_MODEL = 'claude-sonnet-5'

# Maximum input context window for each supported model.
#
# These are INPUT context windows, not output token limits.
# Derived from repo_radar.model_catalog.MODEL_CAPS (the verified per-model capability table);
# see that module for source_url/source_date provenance per model.
KNOWN_LIMITS = {m: c.max_input for m, c in model_catalog.MODEL_CAPS.items()}

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
    "claude-opus-4-1": "claude-opus-4-8",
    "claude-opus-4-1-20250805": "claude-opus-4-8",
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


def _completion_messages(prompt):
    """Exact messages structure call_llm sends on the completion path — one source of truth for
    the sender AND the preflight counter."""
    return [{"role": "user", "content": prompt}]


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
            messages=_completion_messages(prompt),
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


# The "(chunk i/N)" header is the only text that varies with the (evolving) chunk count, and BPE
# token counts are NOT monotonic in the numerals — a real "(chunk 531/531)" tokenizes to MORE
# tokens than a wider "(chunk 999999/999999)". So no synthetic numeral can upper-bound the header.
# Instead we pack the header-LESS content against `threshold - reserve` and reserve a length-based
# token allowance for whatever real header the final split yields: token_count never exceeds
# char_count for a BPE tokenizer, so an allowance >= the widest header substring's character length
# bounds the substring's own cost, plus a small empirical margin for seam retokenization. No
# fixpoint over N is needed.


def _content_prompt_budget(full_name, chunk, model):
    """Conservative budget count of `chunk`'s analysis prompt WITHOUT the "(chunk i/N)" header
    (total_chunks=1 renders no header). The header allowance is reserved separately, so this is the
    part of the budget the file content must fit inside — the SAME content string the model receives.
    """
    return _budget_tokens(_build_analysis_prompt(full_name, chunk, 1, 1), model)


def _header_token_reserve(model, max_chunks):
    """A conservative upper bound (budget tokens) on what a "(chunk i/N)" header adds, for any
    i <= N <= max_chunks. The header inserts only the substring " (chunk {i}/{N})"; an all-9s probe
    of the same digit width is at least as long as any real substring, and token_count(s) <= len(s)
    for a BPE tokenizer, so len(probe) * factor rigorously bounds the substring's OWN budget cost.
    The +8 is an empirically-calibrated margin for retokenization at the insertion seam (validated
    across thousands of real-header chunks with double-digit token slack to spare) — not a
    closed-form seam proof; Branch 2's server-side token count will remove the estimate entirely.
    We bound by LENGTH, never by a chosen numeral, precisely because BPE is non-monotonic in digits.
    """
    d = len(str(max(int(max_chunks), 1)))
    probe = f" (chunk {'9' * d}/{'9' * d})"
    factor = count_tokens_for_budget("reserve probe", model).factor
    return math.ceil(len(probe) * factor) + 8


def repo_needs_chunking(full_name, files, model, budget):
    """THE chunk decision, called by production. Returns (needs_chunk, value, exact).

    Decides on the FINISHED whole-repo prompt, not a sum of file-content tokens: the template and
    per-file framing add real tokens. Fast path: the per-file content-budget sum is a lower bound
    on the finished prompt, so if it already exceeds `budget` we chunk without assembling the huge
    whole-repo string, and `value` is that lower bound (exact=False). Otherwise count the actual
    finished prompt (exact=True). A loose lower bound can only over-chunk, never wrongly pick the
    single path.
    """
    lower_bound = sum(count_tokens_for_budget(f['content'], model).count for f in files)
    if lower_bound > budget:
        return True, lower_bound, False
    finished = _budget_tokens(_build_full_repo_prompt(full_name, files), model)
    return finished > budget, finished, True


def _repack_to_fit(chunks, content_budget, model, full_name):
    """Split any chunk whose REAL header-less content prompt exceeds `content_budget`, emitting the
    LARGEST prefix that fits (binary search on the split point) and MERGING the remainder into the
    next chunk — never emitting the remainder as its own small chunk.

    Merging the tail forward is what stops a run of seam-overshooting chunks from doubling into
    big/tiny/big/tiny paid calls: with per-file component packing, EVERY packed chunk can overshoot
    the real prompt by a seam, so tail-emitting turned 20 packed chunks into 40 (alternating ~49 and
    1 file). Absorbing each tail into the next chunk keeps the count near optimal (20 -> 21). A lone
    file still over budget is the irreducible floor (budget < template), impossible for a real
    0.75x-window budget, and is emitted as-is.
    """
    verified, queue = [], list(chunks)
    while queue:
        chunk = queue.pop(0)
        if len(chunk) <= 1 or _content_prompt_budget(full_name, chunk, model) <= content_budget:
            verified.append(chunk)
            continue
        lo, hi = 1, len(chunk)          # largest prefix length whose content prompt fits
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if _content_prompt_budget(full_name, chunk[:mid], model) <= content_budget:
                lo = mid
            else:
                hi = mid - 1
        verified.append(chunk[:lo])
        remainder = chunk[lo:]
        if queue:
            queue[0] = remainder + queue[0]   # absorb the tail into the next chunk, not a tiny chunk
        else:
            queue.append(remainder)
    return verified


def _truncate_file_to_prompt_budget(file_info, budget_tokens, model, full_name):
    """Trim one file so its OWN one-file content prompt (template + framing + notice, no header) fits
    `budget_tokens`. Measures the real header-less content prompt. Returns the smallest content it
    can; if even one character still overflows (only when the budget is smaller than the fixed
    template itself, which never happens for a real 0.75x-window budget) the caller treats it as
    the irreducible floor.
    """
    original = file_info['content']
    raw = count_tokens_accurate(original, model)
    notice = (f"\n\n... (truncated: ~{raw:,} tokens exceeded the "
              f"{budget_tokens:,}-token chunk budget)")
    keep = len(original)
    for _ in range(14):
        candidate = {**file_info, 'content': original[:keep] + notice}
        if _content_prompt_budget(full_name, [candidate], model) <= budget_tokens:
            return candidate
        if keep <= 1:
            break
        keep = max(int(keep * 0.7), 1)
    return {**file_info, 'content': original[:1] + notice}


def chunk_repo_files(files, model, max_tokens=None, full_name=""):
    """Chunk files so each chunk's FINISHED analysis prompt (content + "(chunk i/N)" header) fits
    the model's budget.

    Correctness over speed on two axes:
      * Tokenizer seams are NOT additive — a chunk whose per-file component counts sum under budget
        can overflow once assembled — so every packed chunk's REAL content prompt is measured.
      * BPE is NOT monotonic in the header numerals, so we never embed a synthetic count to bound
        the header; we pack the header-LESS content against `threshold - reserve` and reserve a
        length-based token allowance (_header_token_reserve) for whatever real header the final
        split yields.
    Phases:
      1. Truncate any single file whose own content prompt would overflow `content_budget`.
      2. Greedy-pack by a fast per-file component lower bound.
      3. Measure each packed chunk's real content prompt; split any overflow at its largest fitting
         prefix and MERGE the remainder forward (_repack_to_fit) so seam overshoot never fragments
         a run of chunks into big/tiny paid calls.
    Everything is counted through count_tokens_for_budget, so Claude 4.7+ (whose litellm tokenizer
    undercounts ~1.6x) is bounded by an inflated, fail-closed estimate. A lone file that still
    overflows is the irreducible floor (budget < template), impossible for a real window.
    """
    threshold = get_chunking_threshold(model) if max_tokens is None else max_tokens
    # Reserve for the real "(chunk i/N)" header: N can be at most one chunk per file.
    reserve = _header_token_reserve(model, max(len(files), 1))
    content_budget = max(threshold - reserve, 1)
    template_overhead = _content_prompt_budget(full_name, [], model)

    # Pass 1: truncate any file whose OWN content prompt would overflow content_budget.
    entries = []  # (file_info, framed_component_tokens)
    for file_info in files:
        framed = _budget_tokens(_frame_file(file_info) + "\n", model)
        if framed + template_overhead > content_budget:
            if _content_prompt_budget(full_name, [file_info], model) > content_budget:
                file_info = _truncate_file_to_prompt_budget(file_info, content_budget, model, full_name)
                framed = _budget_tokens(_frame_file(file_info) + "\n", model)
        entries.append((file_info, framed))

    # Pass 2: greedy pack by the component lower bound (a fast under-estimate of the real prompt).
    packed, current, running = [], [], 0
    for file_info, framed in entries:
        if current and running + framed > content_budget:
            packed.append(current)
            current, running = [], 0
        current.append(file_info)
        running += framed
    if current:
        packed.append(current)

    # Pass 3: verify each packed chunk's REAL content prompt and split/merge to fit content_budget.
    return _repack_to_fit(packed, content_budget, model, full_name)


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
                           synthesize=None, session=None):
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

    session: optional PreflightSession (or test stub) exposing count(model, prompt, requested_output).
    When supplied, the AUTHORITATIVE synthesis path activates: the per-round batch plan is computed
    from authoritative provider counts (coverage-preserving, split-only), the send loop iterates that
    plan, and every send is preflighted through run(). With session is None the behaviour is Branch 1,
    unchanged.

    Returns (final_analysis, total_api_cost) — cost is aggregated across every round. On the
    authoritative path a synthesis that cannot be reduced to fit degrades to
    (DegradedSynthesis(reason), cost_so_far): the sentinel occupies the result slot while the cost
    already incurred at earlier levels is still returned. The caller checks
    isinstance(result, DegradedSynthesis).
    """
    analyses = [a for a in (analyses or []) if a and str(a).strip()]
    if not analyses:
        return "", 0.0
    if model is None:
        model = get_ai_model()

    def run(batch, terminal=False):
        """One synthesis call. Returns (text, cost) and re-budgets if the model changed.

        With a preflight `session`, the EXACT prompt about to be sent is authoritatively counted
        first — so every send is counted — and, if it authoritatively overflows the acceptance
        budget, the batch is truncated to fit before sending. That truncation is legitimate ONLY for
        a singleton batch or a terminal batch; an ordinary multi-item overflow is prevented upstream
        by the coverage-preserving split plan and is never truncated here.
        """
        nonlocal model, budget
        if session is not None:
            batch = _preflight_synthesis_batch(session, full_name, batch, model, terminal)
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

    def run_terminal(parts):
        """Terminal (coverage-losing) final pass: collapse `parts` into ONE authoritatively-fitting
        batch and send it; if even the template floor overflows, degrade. Returns
        (text_or_sentinel, cumulative_cost) — the already-incurred cost is preserved on degradation."""
        try:
            trimmed = _authoritative_terminal_batch(session, full_name, parts, model)
        except _NonAuthoritative:
            # Provider went non-authoritative: fall back to Branch 1's framing-aware truncation.
            trimmed = _truncate_all_to_fit(full_name, parts, budget, model) or None
        if not trimmed:
            reason = (f"{model}: the remaining {len(parts)} synthesis parts cannot be reduced to "
                      f"fit the model's context window, even collapsed to the template floor")
            return DegradedSynthesis(reason), total_cost
        text, cost = run(trimmed, terminal=True)
        return text, total_cost + cost

    if session is not None:
        # AUTHORITATIVE synthesis (Phase C). The per-round batch plan comes from authoritative
        # provider counts (coverage-preserving, split-only); the send loop ITERATES that plan
        # rather than re-batching by local estimate, and never truncates an ordinary multi-item
        # batch (that would silently drop repository coverage). Every send is preflighted through
        # run(). Branch 1 (session is None) is left byte-for-byte unchanged below.
        while True:
            plan = authoritative_synthesis_level(session, full_name, level, model)
            if isinstance(plan, DegradedSynthesis):
                # Degradation preserves the cost already incurred at earlier levels.
                return plan, total_cost
            if len(plan) == 1:
                text, cost = run(plan[0])
                return text, total_cost + cost

            # Guards charge the AUTHORITATIVE post-split batch count. The +1 reserves the final
            # reduction, so max_calls is a true ceiling rather than a ceiling on the map rounds.
            remaining_depth = max_depth - depth
            if remaining_depth <= 0 or calls + len(plan) + 1 > max_calls:
                reason = ('maximum depth' if remaining_depth <= 0 else 'maximum call budget')
                print(f"    {YELLOW}Synthesis: {reason} reached with {len(level)} parts; "
                      f"truncating to a single final pass{RESET}")
                return run_terminal(level)

            print(f"    {CYAN}Synthesising {len(level)} parts in {len(plan)} batches "
                  f"(round {depth + 1}){RESET}")

            before = _total_tokens(level, model)
            combined = []
            idx = 0
            while idx < len(plan):
                # Enforce the ceiling per CALL: a mid-round model change can grow the replan.
                if calls + 1 >= max_calls:
                    print(f"    {YELLOW}Synthesis: call budget reached mid-round; truncating the "
                          f"remaining parts to finish{RESET}")
                    remainder = combined + [a for b in plan[idx:] for a in b]
                    return run_terminal(remainder)

                prev_model = model
                text, cost = run(plan[idx])
                combined.append(text)
                total_cost += cost
                calls += 1
                idx += 1

                if model != prev_model:
                    # The serving model changed (a smaller-window fallback): REPLAN only the unsent
                    # remainder with the new model before the next send, so each prompt fits the
                    # CURRENT model's authoritative budget. Coverage is preserved — nothing dropped.
                    remainder = [a for b in plan[idx:] for a in b]
                    if remainder:
                        replanned = authoritative_synthesis_level(
                            session, full_name, remainder, model)
                        if isinstance(replanned, DegradedSynthesis):
                            return replanned, total_cost
                        plan, idx = replanned, 0

            # No-progress guard: a whole round that failed to shrink would loop at the same size.
            if len(combined) >= len(level) and _total_tokens(combined, model) >= before:
                print(f"    {YELLOW}Synthesis: a round made no progress; "
                      f"truncating to finish{RESET}")
                return run_terminal(combined)

            level = combined
            depth += 1

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


# The single-vs-chunk decision is MONOTONIC: Branch 1's local-estimate chunk decision
# (repo_needs_chunking) is checked first, and if it says "chunk" that is final — an
# authoritative count is never even requested, let alone allowed to reverse it. Only when
# Branch 1 says "single" do we ask for an authoritative count of the exact whole-repo prompt
# call_llm would send (_build_full_repo_prompt), and only an AUTHORITATIVE count can tighten
# "single" into "chunk". A non-authoritative result (model not on the anthropic_api count
# strategy, or the provider call degraded) leaves Branch 1's "single" verdict standing — the
# local estimate is still the best information available.
FULL_REPO_OUTPUT = SYNTHESIS_OUTPUT_TOKENS


def authoritative_partition(session, full_name, files, model):
    """Decide "single" vs "chunk" for the whole-repo prompt, monotonically tightening Branch 1's
    estimate-based decision with an authoritative provider count when one is available.

    session is a PreflightSession (or test stub) exposing count(model, prompt, requested_output).
    """
    threshold = get_chunking_threshold(model)
    needs_chunk, _v, _e = repo_needs_chunking(full_name, files, model, threshold)
    if needs_chunk:
        return "chunk"
    caps = get_caps(model)
    if caps is None or caps.count_strategy != "anthropic_api":
        return "single"
    r = session.count(model, _build_full_repo_prompt(full_name, files), FULL_REPO_OUTPUT)
    if r.authoritative:
        return "single" if r.tokens <= acceptance_budget(model, FULL_REPO_OUTPUT) else "chunk"
    return "single"


# The output-token budget every chunk analysis call reserves (call_llm(..., max_tokens=8192)).
# The acceptance budget for a chunk send is acceptance_budget(model, CHUNK_OUTPUT), so this is the
# SAME requested_output the send will use — the count we accept a chunk on is the count call_llm
# will actually pay for.
CHUNK_OUTPUT = 8192

# `chunks` are only the SENDABLE chunks (N = len(chunks)); production makes exactly one call_llm per
# chunk. `degraded_reason` is non-None ONLY on whole-repo degradation, in which case `chunks` is []
# and production writes a single degraded record and makes ZERO call_llm calls.
PartitionResult = namedtuple("PartitionResult", "chunks degraded_reason")


class _NonAuthoritative(Exception):
    """Raised at a count site the moment the provider returns a non-authoritative result, to abandon
    the authoritative pass and fall back to the complete Branch 1 partition (unchanged)."""


def _authoritative_truncate_file(session, full_name, file_info, model, chunk_num, total_chunks):
    """AUTHORITATIVE analogue of _truncate_file_to_prompt_budget: trim one file so its OWN single-file
    (i/N) analysis prompt — the exact string call_llm would send — counts within
    acceptance_budget(model, CHUNK_OUTPUT), recounting EVERY candidate through session.count rather
    than a local estimate.

    Binary-search the largest retained-content length whose finished prompt fits. Returns the
    truncated file dict, or None when even zero retained content overflows — i.e. the fixed template
    plus this file's framing already exceeds the budget (the "template floor"), so no truncation can
    ever make the chunk sendable and the WHOLE repo must degrade. Raises _NonAuthoritative if any
    count is non-authoritative (the caller turns that into the Branch 1 fallback).
    """
    budget = acceptance_budget(model, CHUNK_OUTPUT)
    original = file_info['content']
    raw = count_tokens_accurate(original, model)
    notice = (f"\n\n... (truncated: ~{raw:,} tokens exceeded the "
              f"{budget:,}-token chunk budget)")

    def candidate_for(keep):
        return {**file_info, 'content': original[:keep] + notice}

    def fits(keep):
        cand = candidate_for(keep)
        r = session.count(model, _build_analysis_prompt(full_name, [cand], chunk_num, total_chunks),
                          CHUNK_OUTPUT)
        if not r.authoritative:
            raise _NonAuthoritative
        return r.tokens <= budget, cand

    # Floor first: if not even the notice-only prompt (zero retained content) fits, the template
    # itself overflows and nothing this function can do will help — signal whole-repo degradation.
    ok, floor = fits(0)
    if not ok:
        return None
    lo, hi, best = 0, len(original), floor          # largest keep in [0, len] whose prompt fits
    while lo < hi:
        mid = (lo + hi + 1) // 2
        ok, cand = fits(mid)
        if ok:
            lo, best = mid, cand
        else:
            hi = mid - 1
    return best


def _largest_fitting_prefix(session, full_name, chunk, chunk_num, total_chunks, model, budget):
    """Largest prefix length L in [1, len(chunk)-1] whose (i/N) prompt counts within `budget`, by
    binary search with an authoritative recount per candidate. Always returns >= 1 so the split makes
    progress even if a single-file prefix still overflows (that lone file is handled as a singleton on
    the next pass). Raises _NonAuthoritative on a non-authoritative count."""
    def fits(length):
        r = session.count(model, _build_analysis_prompt(full_name, chunk[:length], chunk_num, total_chunks),
                          CHUNK_OUTPUT)
        if not r.authoritative:
            raise _NonAuthoritative
        return r.tokens <= budget

    lo, hi, best = 1, len(chunk) - 1, 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if fits(mid):
            best, lo = mid, mid + 1
        else:
            hi = mid - 1
    return best


def authoritative_chunks(session, full_name, files, model):
    """The chunked-analysis fixpoint with a whole-repo degradation contract (§6.2, §6.4).

    Starting from Branch 1's conservative candidate set (chunk_repo_files), drive it to a fixpoint
    where EVERY chunk's REAL analysis prompt — `_build_analysis_prompt(full_name, chunk, i, N)` with
    the ACTUAL 1-based index and current total — counts within acceptance_budget(model, CHUNK_OUTPUT)
    AND the count is authoritative. A chunk "fits" only if both hold.

    Why the whole set is rebuilt and recounted after every split (not just the offending chunk): the
    only text that varies with N is the "(chunk i/N)" header, and BPE token counts are NOT monotonic
    in those numerals, so splitting one chunk (which changes N and therefore EVERY header) can push a
    previously-fitting chunk over budget. A prior pass is never trusted; we iterate until one full
    pass fits with zero changes. N only ever grows and is bounded by the file count, so it terminates.

    Overflow handling:
      * A MULTI-file chunk is split at its largest fitting prefix; the prefix and remainder both go
        back into the candidate set and the whole set is recounted (N has changed).
      * A SINGLE-file chunk is authoritatively truncated (binary search, recount per candidate). If
        even the template floor overflows, the whole repo degrades: return PartitionResult([], reason)
        immediately — production writes one degraded record and sends nothing.
      * ANY non-authoritative count abandons the authoritative pass entirely and returns the complete,
        unchanged Branch 1 partition (degraded_reason is None): the local estimate remains the best
        information available and Branch 1 already fail-closes on it.
    """
    budget = acceptance_budget(model, CHUNK_OUTPUT)

    def fits(chunk, i, n):
        r = session.count(model, _build_analysis_prompt(full_name, chunk, i, n), CHUNK_OUTPUT)
        if not r.authoritative:
            raise _NonAuthoritative
        return r.tokens <= budget

    def build():
        chunks = chunk_repo_files(files, model, full_name=full_name)
        # Safety cap only — the fixpoint terminates by construction (N strictly grows on every split
        # and is bounded by len(files); truncations converge once N stops changing). If this is ever
        # hit it means an invariant broke, so fail loud rather than emit an unverified partition.
        for _ in range(4 * len(files) + 8):
            n = len(chunks)
            rebuilt, changed = [], False
            for idx, chunk in enumerate(chunks, start=1):
                if fits(chunk, idx, n):
                    rebuilt.append(chunk)
                    continue
                changed = True
                if len(chunk) == 1:
                    truncated = _authoritative_truncate_file(session, full_name, chunk[0], model, idx, n)
                    if truncated is None:
                        reason = (f"{model}: file {chunk[0]['path']!r} exceeds the {budget:,}-token "
                                  f"chunk acceptance budget even truncated to the template floor")
                        return PartitionResult([], reason)
                    rebuilt.append([truncated])
                else:
                    cut = _largest_fitting_prefix(session, full_name, chunk, idx, n, model, budget)
                    rebuilt.append(chunk[:cut])
                    rebuilt.append(chunk[cut:])
            chunks = rebuilt
            if not changed:
                return PartitionResult(chunks, None)
        raise AssertionError("authoritative_chunks fixpoint failed to converge")  # unreachable

    try:
        return build()
    except _NonAuthoritative:
        return PartitionResult(chunk_repo_files(files, model, full_name=full_name), None)


# ---------------------------------------------------------------------------
# Phase C — AUTHORITATIVE (Count Tokens API) synthesis (§6.3).
#
# The analysis analogue of authoritative_chunks, one level up: instead of
# splitting FILES into chunks it splits ANALYSES into synthesis batches, driven
# by authoritative provider counts of the exact synthesis prompt. Active ONLY
# when combine_chunk_analyses is passed a PreflightSession; with session is None
# the hierarchical synthesis above is Branch 1, byte-for-byte unchanged.
# ---------------------------------------------------------------------------

# Sentinel returned by the authoritative synthesis path when the analyses cannot be reduced to fit
# the model's context window even by truncation to the template floor. Carries a human reason; the
# caller writes a degraded record and makes no synthesis send. isinstance(x, DegradedSynthesis)
# distinguishes it from a batch plan (a plain list).
DegradedSynthesis = namedtuple("DegradedSynthesis", "reason")


def _join_for_terminal(parts):
    """Collapse several synthesis parts into ONE blob for a terminal single-pass synthesis.

    Numbered separators keep provenance; the blob is then authoritatively truncated to fit. This is a
    deliberate coverage-loss path — a head-truncation can drop trailing parts entirely — used only
    when the call/depth budget is exhausted and a bounded final answer is preferable to failing.
    """
    return "".join(f"\n[Part {i}]\n{p}\n" for i, p in enumerate(parts, 1))


def _authoritative_truncate_synthesis(session, full_name, analysis, model):
    """AUTHORITATIVE analogue of _authoritative_truncate_file, generalized to a synthesis TEXT item.

    Binary-search the largest retained-content length whose OWN single-part synthesis prompt — the
    exact string _build_synthesis_prompt would send — counts within acceptance_budget(model,
    SYNTHESIS_OUTPUT_TOKENS), recounting EVERY candidate through session.count rather than a local
    estimate. Returns the truncated text, or None when even zero retained content (the template floor)
    overflows — the fixed template plus one framed marker already exceeds the budget, so nothing this
    function can do makes the part sendable. Raises _NonAuthoritative on a non-authoritative count.
    """
    budget = acceptance_budget(model, SYNTHESIS_OUTPUT_TOKENS)
    raw = count_tokens_accurate(analysis, model)
    notice = (f"\n\n... (truncated: ~{raw:,} tokens exceeded the "
              f"{budget:,}-token synthesis budget)")

    def candidate_for(keep):
        return analysis[:keep] + notice

    def fits(keep):
        cand = candidate_for(keep)
        r = session.count(model, _build_synthesis_prompt(full_name, [cand]), SYNTHESIS_OUTPUT_TOKENS)
        if not r.authoritative:
            raise _NonAuthoritative
        return r.tokens <= budget, cand

    # Floor first: if not even the notice-only prompt fits, the template overflows and no truncation
    # helps — signal whole-synthesis degradation to the caller.
    ok, floor = fits(0)
    if not ok:
        return None
    lo, hi, best = 0, len(analysis), floor          # largest keep in [0, len] whose prompt fits
    while lo < hi:
        mid = (lo + hi + 1) // 2
        ok, cand = fits(mid)
        if ok:
            lo, best = mid, cand
        else:
            hi = mid - 1
    return best


def authoritative_synthesis_level(session, full_name, analyses, model):
    """One synthesis level's batch plan, computed from AUTHORITATIVE provider counts (§6.3).

    Split the ordered analyses into contiguous, coverage-preserving batches whose synthesis prompt —
    _build_synthesis_prompt(full_name, batch) — each counts within acceptance_budget(model,
    SYNTHESIS_OUTPUT_TOKENS), recounting every candidate through session.count. Split-only: it never
    merges beyond what fits and never drops a part.

      * A batch is the LARGEST contiguous prefix of the remaining analyses that fits (binary search).
      * A single analysis that overflows even alone is authoritatively truncated (binary recount). If
        even its template floor overflows, the whole synthesis degrades -> DegradedSynthesis(reason).
      * ANY non-authoritative count abandons the authoritative plan and returns Branch 1's current
        batches unchanged (_batch_by_budget) — the local estimate remains the best information and
        Branch 1 already fail-closes on it.

    Returns list[list[str]] (the batch plan) or DegradedSynthesis.
    """
    analyses = list(analyses)
    budget = acceptance_budget(model, SYNTHESIS_OUTPUT_TOKENS)

    def fits(batch):
        r = session.count(model, _build_synthesis_prompt(full_name, batch), SYNTHESIS_OUTPUT_TOKENS)
        if not r.authoritative:
            raise _NonAuthoritative
        return r.tokens <= budget

    try:
        batches, remaining = [], analyses
        while remaining:
            if not fits(remaining[:1]):
                # A lone analysis overflows by itself — nothing to regroup it with; truncate it.
                truncated = _authoritative_truncate_synthesis(session, full_name, remaining[0], model)
                if truncated is None:
                    return DegradedSynthesis(
                        f"{model}: a single analysis part exceeds the {budget:,}-token synthesis "
                        f"acceptance budget even truncated to the template floor")
                batches.append([truncated])
                remaining = remaining[1:]
                continue
            # remaining[:1] fits, so search the largest fitting prefix starting from 2.
            lo, hi, cut = 2, len(remaining), 1
            while lo <= hi:
                mid = (lo + hi) // 2
                if fits(remaining[:mid]):
                    cut, lo = mid, mid + 1
                else:
                    hi = mid - 1
            batches.append(remaining[:cut])
            remaining = remaining[cut:]
        return batches
    except _NonAuthoritative:
        return _batch_by_budget(full_name, analyses, _synthesis_budget(full_name, model), model)


def _authoritative_terminal_batch(session, full_name, parts, model):
    """A single fitting batch for a terminal final pass: collapse `parts` into ONE blob and, only if
    it authoritatively overflows, truncate it to acceptance_budget. Returns [blob] (fitting) or None
    (template floor overflow -> caller degrades). Raises _NonAuthoritative on a non-authoritative
    count. This is the coverage-loss path the call/depth guards fall back to."""
    budget = acceptance_budget(model, SYNTHESIS_OUTPUT_TOKENS)
    blob = parts[0] if len(parts) == 1 else _join_for_terminal(parts)
    r = session.count(model, _build_synthesis_prompt(full_name, [blob]), SYNTHESIS_OUTPUT_TOKENS)
    if not r.authoritative:
        raise _NonAuthoritative
    if r.tokens <= budget:
        return [blob]
    truncated = _authoritative_truncate_synthesis(session, full_name, blob, model)
    return None if truncated is None else [truncated]


def _preflight_synthesis_batch(session, full_name, batch, model, terminal):
    """run()'s preflight: authoritatively count the EXACT prompt about to be sent, and return the
    batch to send.

    Unchanged when it fits or the count is non-authoritative (Branch 1). If it authoritatively
    overflows the acceptance budget it is truncated to fit — but ONLY for a singleton or a terminal
    batch. An ordinary multi-item overflow is NOT truncated here (that would silently drop repository
    coverage); it is prevented upstream by the split plan, so the batch is returned unchanged. In
    every case the LAST prompt counted equals the prompt run() then sends, so every send is counted.
    """
    budget = acceptance_budget(model, SYNTHESIS_OUTPUT_TOKENS)
    r = session.count(model, _build_synthesis_prompt(full_name, batch), SYNTHESIS_OUTPUT_TOKENS)
    if not r.authoritative or r.tokens <= budget:
        return batch
    if terminal or len(batch) == 1:
        blob = batch[0] if len(batch) == 1 else _join_for_terminal(batch)
        truncated = _authoritative_truncate_synthesis(session, full_name, blob, model)
        if truncated is not None:
            return [truncated]
    return batch
