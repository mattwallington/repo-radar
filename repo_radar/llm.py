"""LLM integration, model configuration, and rate limiting."""

import os
from datetime import datetime

from repo_radar.constants import YELLOW, RED, RESET, CYAN, GREEN

# TODO: refactor sync_mode to use analyze_repo_chunk and combine_chunk_analyses


def get_ai_model():
    """Get the AI model from environment variable or use default."""
    return os.environ.get('AI_MODEL', 'claude-sonnet-4-6')


# Fallback model chain - each model has separate rate limit quotas
GEMINI_FALLBACK_CHAIN = [
    'gemini/gemini-3.1-pro-preview',
    'gemini/gemini-3-pro-preview',
    'gemini/gemini-3-flash-preview',
    'gemini/gemini-2.5-pro',
    'gemini/gemini-2.5-flash',
    'gemini/gemini-2.0-flash',
]

def get_fallback_model(current_model):
    """Get the next fallback model in the chain.

    Args:
        current_model: The model that just failed

    Returns:
        Next model in fallback chain, or None if at end
    """
    try:
        current_index = GEMINI_FALLBACK_CHAIN.index(current_model)
        if current_index < len(GEMINI_FALLBACK_CHAIN) - 1:
            return GEMINI_FALLBACK_CHAIN[current_index + 1]
    except ValueError:
        # Not in fallback chain, return first one
        return GEMINI_FALLBACK_CHAIN[0]

    return None  # No more fallbacks


def get_model_context_window(model):
    """Get the maximum input context window for a model.

    These are INPUT context windows, not output token limits.
    Based on litellm model cost map as of March 2026.
    """
    KNOWN_LIMITS = {
        # ── Anthropic Claude ──────────────────────────────────────────────
        # Claude 4.6 (latest)
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
        "claude-opus-4-20250514": 200000,
        "claude-4-opus-20250514": 200000,
        "claude-sonnet-4-20250514": 200000,
        "claude-4-sonnet-20250514": 200000,
        # Claude 3.x
        "claude-3-7-sonnet-20250219": 200000,
        "claude-3-5-sonnet-20241022": 200000,
        "claude-3-haiku-20240307": 200000,
        "claude-3-opus-20240229": 200000,

        # ── Google Gemini ─────────────────────────────────────────────────
        # Gemini 3.x
        "gemini/gemini-3.1-pro-preview": 1048576,
        "gemini/gemini-3.1-flash-lite-preview": 1048576,
        "gemini/gemini-3-pro-preview": 1048576,
        "gemini/gemini-3-flash-preview": 1048576,
        # Gemini 2.5
        "gemini/gemini-2.5-pro": 1048576,
        "gemini/gemini-2.5-flash": 1048576,
        "gemini/gemini-2.5-flash-lite": 1048576,
        # Gemini 2.0
        "gemini/gemini-2.0-flash": 1048576,
        "gemini/gemini-2.0-flash-001": 1048576,
        "gemini/gemini-2.0-flash-lite": 1048576,
        # Convenience aliases
        "gemini/gemini-pro-latest": 1048576,
        "gemini/gemini-flash-latest": 1048576,
        "gemini/gemini-flash-lite-latest": 1048576,

        # ── OpenAI ────────────────────────────────────────────────────────
        # GPT-5.x (latest)
        "gpt-5.4": 1050000,
        "gpt-5.4-pro": 1050000,
        "gpt-5.4-mini": 272000,
        "gpt-5.4-nano": 272000,
        "gpt-5.3-codex": 272000,
        "gpt-5.3-codex-spark": 272000,  # Responses API only
        "gpt-5.2": 272000,
        "gpt-5.2-codex": 272000,
        "gpt-5.2-pro": 272000,
        "gpt-5.1": 272000,
        "gpt-5.1-codex": 272000,
        "gpt-5.1-codex-max": 272000,
        "gpt-5.1-codex-mini": 272000,
        "gpt-5": 272000,
        "gpt-5-codex": 272000,
        "gpt-5-mini": 272000,
        "gpt-5-nano": 272000,
        # GPT-4.x
        "gpt-4.1": 1047576,
        "gpt-4.1-mini": 1047576,
        "gpt-4.1-nano": 1047576,
        "gpt-4o": 128000,
        "gpt-4o-mini": 128000,
        "gpt-4-turbo": 128000,
        # Codex CLI
        "codex-mini-latest": 200000,
        # Reasoning models
        "o4-mini": 200000,
        "o3": 200000,
        "o3-mini": 200000,
        "o3-pro": 200000,
        "o1": 200000,
        "o1-pro": 200000,
    }
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

    # Fallback heuristic — only for models that look like OpenAI ones
    lower = model.lower()
    bare = lower.split('/', 1)[-1] if lower.startswith('openai/') else lower
    if '/' in bare and not bare.startswith('openai'):
        return False  # Anthropic / Gemini / etc. never use Responses API
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


def combine_chunk_analyses(full_name, analyses):
    """Combine multiple chunk analyses into a cohesive report."""

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
