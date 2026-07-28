"""LLM integration, model configuration, and rate limiting."""

import os
import re
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
    "gpt-5.4-mini": 1050000,
    "gpt-5.4-nano": 1050000,
    "gpt-5.3-codex": 400000,
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


def chunk_repo_files(files, model, max_tokens=None):
    """Chunk repository files intelligently based on model context window.

    Args:
        files: List of file dictionaries with 'path' and 'content'
        model: Model name for accurate token counting
        max_tokens: Maximum tokens per chunk (defaults to model's threshold)

    Returns:
        List of file chunks, with oversized files truncated
    """
    if max_tokens is None:
        max_tokens = get_chunking_threshold(model)

    # First pass: Truncate individual files that are too large
    # This prevents one massive file from creating excessive chunks
    SINGLE_FILE_TOKEN_LIMIT = 100000  # 100K tokens max per file
    processed_files = []

    for file_info in files:
        file_tokens = count_tokens_accurate(file_info['content'], model)

        if file_tokens > SINGLE_FILE_TOKEN_LIMIT:
            # Truncate to limit
            char_limit = int(SINGLE_FILE_TOKEN_LIMIT * 3.5)  # Approximate chars for 100K tokens
            truncated_content = file_info['content'][:char_limit]

            # Add truncation notice
            truncation_notice = f"\n\n... (File truncated: original {file_tokens:,} tokens exceeds {SINGLE_FILE_TOKEN_LIMIT:,} token limit)"

            processed_files.append({
                **file_info,
                'content': truncated_content + truncation_notice
            })
        else:
            processed_files.append(file_info)

    # Second pass: Create chunks based on accurate token counts
    chunks = []
    current_chunk = []
    current_tokens = 0

    for file_info in processed_files:
        file_tokens = count_tokens_accurate(file_info['content'], model)

        # If adding this file would exceed limit, start new chunk
        if current_chunk and (current_tokens + file_tokens > max_tokens):
            chunks.append(current_chunk)
            current_chunk = []
            current_tokens = 0

        current_chunk.append(file_info)
        current_tokens += file_tokens

    # Add remaining files
    if current_chunk:
        chunks.append(current_chunk)

    return chunks


def analyze_repo_chunk(full_name, chunk, chunk_num, total_chunks):
    """Analyze a chunk of repository files."""
    # Format files for prompt
    files_content = []
    for file_info in chunk:
        files_content.append(f"=== {file_info['path']} ({file_info['size']} bytes) ===\n{file_info['content']}\n")

    combined_content = "\n".join(files_content)

    chunk_info = f" (chunk {chunk_num}/{total_chunks})" if total_chunks > 1 else ""

    # Create prompt for chunk analysis
    prompt = f"""Analyze this portion of the repository and provide analysis.

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


def _batch_by_budget(analyses, budget, model):
    """Group analyses into ordered, contiguous batches that each fit the token budget.

    Order is preserved: a batch is always a contiguous run, so "Analysis Part N" ordering
    still reflects the repository's chunk order after any number of rounds. An analysis that
    exceeds the budget on its own lands in a batch by itself, for the caller to handle.
    """
    batches, current, current_tokens = [], [], 0
    for analysis in analyses:
        tokens = count_tokens_accurate(analysis, model)
        if current and current_tokens + tokens > budget:
            batches.append(current)
            current, current_tokens = [], 0
        current.append(analysis)
        current_tokens += tokens
    if current:
        batches.append(current)
    return batches


def _truncate_to_tokens(text, max_tokens, model):
    """Cut text down to a token budget, marking the cut. Last resort only."""
    if max_tokens <= 0 or count_tokens_accurate(text, model) <= max_tokens:
        return text
    # Start from a proportional guess, then walk down until it genuinely fits.
    cut = max(int(len(text) * (max_tokens / max(count_tokens_accurate(text, model), 1)) * 0.95), 1)
    candidate = text[:cut]
    while cut > 1 and count_tokens_accurate(candidate, model) > max_tokens:
        cut = int(cut * 0.9)
        candidate = text[:cut]
    return candidate + "\n\n[truncated by repo-radar: exceeded the synthesis budget]\n"


def _total_tokens(analyses, model):
    return sum(count_tokens_accurate(a, model) for a in analyses)


def combine_chunk_analyses(full_name, analyses, model=None,
                           max_depth=SYNTHESIS_MAX_DEPTH, max_calls=SYNTHESIS_MAX_CALLS):
    """Combine chunk analyses into one cohesive report, bounded by the model's context.

    Previously every chunk analysis was concatenated into a single prompt with no bound, so a
    large repository produced a request larger than the context window and the whole metadata
    step failed (observed: 1,189,532 tokens against a 1,000,000 limit). Chunking bounded the
    INPUT files but nothing bounded their combination.

    This performs a hierarchical map-reduce instead: analyses are grouped into ordered batches
    that each fit the budget, every batch is synthesised, and the results are combined again
    until a single bounded synthesis remains. Every chunk therefore reaches the final report.

    Returns (final_analysis, total_api_cost) — cost is aggregated across every round.
    """
    analyses = [a for a in (analyses or []) if a and str(a).strip()]
    if not analyses:
        return "", 0.0
    if model is None:
        model = get_ai_model()

    # Reserve room for the template itself and for the response.
    overhead = count_tokens_accurate(_build_synthesis_prompt(full_name, []), model)
    budget = get_chunking_threshold(model) - overhead - SYNTHESIS_OUTPUT_TOKENS
    if budget < 1000:  # pathologically small window — leave something workable
        budget = 1000

    if len(analyses) == 1 and count_tokens_accurate(analyses[0], model) <= budget:
        return _synthesize_once(full_name, analyses)

    level = list(analyses)
    depth = 0
    calls = 0
    total_cost = 0.0

    while True:
        # A single analysis larger than one whole request cannot be reduced by regrouping —
        # nothing to combine it with. Truncation is the only remaining move, and it is loud.
        if len(level) == 1 and count_tokens_accurate(level[0], model) > budget:
            print(f"    {YELLOW}Synthesis: one analysis alone exceeds the context budget; "
                  f"truncating it to fit (some detail from this section is lost){RESET}")
            level = [_truncate_to_tokens(level[0], budget, model)]

        batches = _batch_by_budget(level, budget, model)

        if len(batches) == 1:
            text, cost = _synthesize_once(full_name, batches[0])
            return text, total_cost + cost

        # Guards: stop expanding work, but never by dropping input.
        remaining_depth = max_depth - depth
        if remaining_depth <= 0 or calls + len(batches) > max_calls:
            reason = ('maximum depth' if remaining_depth <= 0 else 'maximum call budget')
            print(f"    {YELLOW}Synthesis: {reason} reached with {len(level)} parts; "
                  f"truncating each to fit a single final pass{RESET}")
            share = max(budget // len(level), 1)
            trimmed = [_truncate_to_tokens(a, share, model) for a in level]
            text, cost = _synthesize_once(full_name, trimmed)
            return text, total_cost + cost

        print(f"    {CYAN}Synthesising {len(level)} parts in {len(batches)} batches "
              f"(round {depth + 1}){RESET}")

        before = _total_tokens(level, model)
        combined = []
        for batch in batches:
            text, cost = _synthesize_once(full_name, batch)
            combined.append(text)
            total_cost += cost
            calls += 1

        # No-progress detection: if a whole round failed to shrink the material, recursing
        # again would loop at the same size and burn the call budget for nothing.
        if len(combined) >= len(level) and _total_tokens(combined, model) >= before:
            print(f"    {YELLOW}Synthesis: a round made no progress ({before:,} tokens in, "
                  f"{_total_tokens(combined, model):,} out); truncating to finish{RESET}")
            share = max(budget // len(combined), 1)
            trimmed = [_truncate_to_tokens(a, share, model) for a in combined]
            text, cost = _synthesize_once(full_name, trimmed)
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


def _synthesize_once(full_name, analyses):
    """Run ONE synthesis call over the given analyses. Returns (text, api_cost).

    The caller is responsible for ensuring the batch fits the model's budget; this function
    does not bound its input.
    """
    combined_prompt = _build_synthesis_prompt(full_name, analyses)

    # Use retry logic
    max_retries = 3
    base_wait = 2

    for retry in range(max_retries):
        try:
            final_analysis, api_cost, _ = call_llm(
                get_ai_model(), combined_prompt, max_tokens=16384
            )
            return final_analysis, api_cost

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
