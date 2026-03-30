"""LLM integration, model configuration, and rate limiting."""

import os
from datetime import datetime

from repo_radar.constants import YELLOW, RED, RESET, CYAN, GREEN

# TODO: refactor sync_mode to use analyze_repo_chunk and combine_chunk_analyses


def get_ai_model():
    """Get the AI model from environment variable or use default."""
    return os.environ.get('AI_MODEL', 'claude-sonnet-4-6-1m')


# Fallback model chain - each model has separate rate limit quotas
GEMINI_FALLBACK_CHAIN = [
    'gemini/gemini-3-pro-preview',
    'gemini/gemini-3-flash-preview',
    'gemini/gemini-2.5-pro',
    'gemini/gemini-2.5-flash',
    'gemini/gemini-2.0-flash-exp',
    'gemini/gemini-2.0-flash-001',
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
    Based on official model documentation as of December 2025.
    """
    KNOWN_LIMITS = {
        # Google Gemini models (Latest) - Official docs show 1,048,576 tokens
        "gemini/gemini-3-pro-preview": 1048576,      # Dec 2025 - 1M tokens
        "gemini/gemini-3-flash-preview": 1048576,    # Dec 2025 - 1M tokens
        "gemini/gemini-3.0-pro": 1048576,            # Alternate naming
        "gemini/gemini-3.0-flash": 1048576,          # Alternate naming
        # Google Gemini 2.x models - All 1M tokens per official docs
        "gemini/gemini-2.5-pro": 1048576,
        "gemini/gemini-2.5-flash": 1048576,
        "gemini/gemini-2.0-flash": 1048576,
        "gemini/gemini-2.0-flash-exp": 1048576,
        "gemini/gemini-2.0-flash-001": 1048576,
        # Google Gemini 1.5 models - Also 1M (not 2M as previously thought)
        "gemini/gemini-1.5-pro": 1048576,
        "gemini/gemini-1.5-pro-002": 1048576,
        "gemini/gemini-1.5-flash": 1048576,
        "gemini/gemini-1.5-flash-002": 1048576,
        # Anthropic Claude 4.6 models (1M context)
        "claude-opus-4-6-1m": 1000000,               # Opus 4.6 - 1M context
        "claude-sonnet-4-6-1m": 1000000,              # Sonnet 4.6 - 1M context
        # Anthropic Claude 4.6 models (standard)
        "claude-opus-4-6": 200000,
        "claude-sonnet-4-6": 200000,
        "claude-haiku-4-5": 200000,
        # Anthropic Claude 4.5 models
        "claude-sonnet-4-5-20250929": 200000,
        "claude-4.5-sonnet": 200000,
        # Anthropic Claude 4.x models
        "claude-4.1-opus-20250115": 200000,
        "claude-4-opus-20250514": 200000,
        "claude-4-sonnet-20250514": 200000,
        "claude-3.7-sonnet-20250219": 200000,
        # Anthropic Claude 3.5 models
        "claude-3-5-sonnet-20241022": 200000,
        "claude-3-5-haiku-20241022": 200000,
        # OpenAI models
        "chatgpt/gpt-5.3-codex": 200000,             # Codex CLI model
        "gpt-4o": 128000,
        "gpt-4o-mini": 128000,
        "gpt-4.1": 128000,
        "gpt-4-turbo": 128000,
        "o1-preview": 128000,
        "o1-mini": 128000,
    }
    return KNOWN_LIMITS.get(model, 128000)  # Conservative default


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
    import litellm

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
            response = litellm.completion(
                model=get_ai_model(),
                messages=[{"role": "user", "content": prompt}],
                max_tokens=8192
            )

            analysis = response.choices[0].message.content

            # Get API cost
            api_cost = 0.0
            if hasattr(response, '_hidden_params') and 'response_cost' in response._hidden_params:
                api_cost = response._hidden_params['response_cost']

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
    import litellm

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
            response = litellm.completion(
                model=get_ai_model(),
                messages=[{"role": "user", "content": combined_prompt}],
                max_tokens=16384
            )

            final_analysis = response.choices[0].message.content

            # Get API cost
            api_cost = 0.0
            if hasattr(response, '_hidden_params') and 'response_cost' in response._hidden_params:
                api_cost = response._hidden_params['response_cost']

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
