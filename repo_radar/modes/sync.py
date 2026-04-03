"""Sync mode: clone/update repos and generate AI-powered metadata."""

import os
import sys
import json
import time
import random
import socket
import traceback
import hashlib
from pathlib import Path
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading

from repo_radar.config import load_config, save_config, load_cache_index, save_cache_index, get_cache_name, PRISTINE_DIR, CONFIG_DIR, CACHE_INDEX_FILE
from repo_radar.constants import GREEN, BLUE, CYAN, YELLOW, RED, BOLD, RESET, REPO_COLORS, PROGRESS_COLORS
from repo_radar.git import run_git_command, determine_preferred_branch, get_repo_status
from repo_radar.files import collect_repo_files, should_include_file
from repo_radar.llm import get_ai_model, get_model_context_window, get_chunking_threshold, count_tokens_accurate, chunk_repo_files, get_fallback_model, rate_limit_tracker, RateLimitTracker
from repo_radar.metadata import parse_llm_response, regenerate_index
from repo_radar.ui import get_short_id, format_id, send_status_update


def wait_for_network(host="github.com", port=443, timeout=60, interval=3):
    """Wait for network connectivity before starting sync.

    Returns True if network is available, False if timed out.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            sock = socket.create_connection((host, port), timeout=5)
            sock.close()
            return True
        except OSError:
            time.sleep(interval)
    return False


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

    console.print(f"[bold]Repository Sync[/bold]")
    console.print()

    # Wait for network connectivity (handles laptop wake from sleep)
    if not wait_for_network():
        console.print(f"[red]No network connectivity after 60s. Aborting sync.[/red]")
        if args.status_server:
            send_status_update('complete', {
                'total': 0, 'errors': 0, 'cloned': 0, 'updated': 0,
                'skipped': 0, 'metadata_generated': 0,
                'message': 'No network connectivity'
            }, args.status_server)
        return 1

    # Load configuration
    config = load_config()
    if not config:
        console.print(f"[red]No configuration found. Run 'configure' first.[/red]")
        return 1

    repos = config.get('repositories', [])
    if not repos:
        console.print(f"[yellow]No repositories configured[/yellow]")
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
        'api_cost': 0.0
    }
    stats_lock = threading.Lock()

    repos_needing_metadata = []
    metadata_lock = threading.Lock()

    console.print(f"Processing {len(repos)} repositories in parallel...")
    console.print()

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
                    progress.update(task_id, completed=100, status=f"[{color}]✓ cloned (dry run)[/{color}]")
                    return (True, 'cloned', cache_name, None, False, short_id, color)

                result = run_git_command(['git', 'clone', clone_url, str(repo_path)], check=False)

                if result.returncode != 0:
                    progress.update(task_id, completed=100, status=f"[red]✗ clone failed[/red]")
                    if args.status_server:
                        send_status_update('progress', {
                            'repo': full_name, 'short_name': short_id,
                            'status': '✗ clone failed',
                            'percent': 100,
                            'color': color
                        }, args.status_server)
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

                needs_metadata = commit_hash and not args.skip_metadata

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
                    progress.update(task_id, completed=100, status=f"[{color}]✓ updated (dry run)[/{color}]")
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
                for attempt in range(3):
                    result = run_git_command(['git', 'fetch', 'origin'], cwd=repo_path, check=False)
                    if result.returncode == 0:
                        fetch_ok = True
                        break
                    if attempt < 2:
                        time.sleep(2 * (attempt + 1))  # 2s, 4s backoff

                if not fetch_ok:
                    progress.update(task_id, completed=100, status=f"[red]✗ fetch failed[/red]")
                    if args.status_server:
                        send_status_update('progress', {
                            'repo': full_name, 'short_name': short_id,
                            'status': '✗ fetch failed',
                            'percent': 100,
                            'color': color
                        }, args.status_server)
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
                        if args.status_server:
                            send_status_update('progress', {
                                'repo': full_name, 'short_name': short_id,
                                'status': '✗ pull failed',
                                'percent': 100,
                                'color': color
                            }, args.status_server)
                        with stats_lock:
                            stats['errors'] += 1
                        return (False, 'error', cache_name, old_commit, False, short_id, color)

                # Get new commit
                result = run_git_command(['git', 'rev-parse', 'HEAD'], cwd=repo_path, check=False)
                new_commit = result.stdout.strip() if result.returncode == 0 else None

                # Check if metadata needs regeneration
                needs_metadata = False
                if new_commit and not args.skip_metadata:
                    metadata_file = PRISTINE_DIR / f"{cache_name}.md"

                    # Force regeneration if requested
                    if args.regenerate_metadata:
                        needs_metadata = True
                    # Check if metadata file doesn't exist
                    elif not metadata_file.exists():
                        needs_metadata = True
                    # Check if metadata exists but commit changed
                    elif metadata_file.exists():
                        try:
                            with open(metadata_file, 'r') as f:
                                content = f.read()
                                if content.startswith('---'):
                                    parts = content.split('---', 2)
                                    if len(parts) >= 3:
                                        frontmatter = parts[1]
                                        for line in frontmatter.split('\n'):
                                            if line.startswith('last_commit:'):
                                                old_commit_meta = line.split(':', 1)[1].strip()
                                                if old_commit_meta != new_commit:
                                                    needs_metadata = True
                                                break
                        except Exception:
                            needs_metadata = True

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

        def generate_metadata_task(task_data):
            """Generate metadata for a single repo with progress updates."""
            repo_config, cache_name, commit_hash, short_id, color, _ = task_data
            full_name = repo_config['full_name']
            repo_path = PRISTINE_DIR / cache_name

            task_id, task_color = meta_tasks[full_name]

            # Longer random delay to stagger requests and avoid rate limits
            import random
            # Increased delay range: 3-7 seconds between repos
            time.sleep(random.uniform(3.0, 7.0))

            meta_progress.update(task_id, completed=5, status=f"[{task_color}]collecting files...[/{task_color}]")

            # Send status update to UI
            if hasattr(args, 'status_server') and args.status_server:
                send_status_update('progress', {
                    'repo': full_name, 'short_name': short_id,
                    'status': '📝 generating metadata...',
                    'percent': 5,
                    'color': color
                }, args.status_server)

            try:
                # Custom metadata generation with progress updates
                if args.dry_run:
                    meta_progress.update(task_id, completed=50, status=f"[dim][DRY RUN] would analyze[/dim]")
                    time.sleep(0.1)
                    meta_progress.update(task_id, completed=100, status=f"[{task_color}]✓ analyzed (dry run)[/{task_color}]")
                    return 0.0

                # Check for appropriate API key based on model
                model = get_ai_model()
                api_key_missing = False

                if model.startswith('gemini/'):
                    api_key_missing = not os.getenv('GEMINI_API_KEY')
                elif model.startswith('claude'):
                    api_key_missing = not os.getenv('ANTHROPIC_API_KEY')
                elif model.startswith('gpt') or model.startswith('o1') or model.startswith('o3') or model.startswith('o4') or model.startswith('chatgpt/') or model.startswith('codex'):
                    api_key_missing = not os.getenv('OPENAI_API_KEY')

                if api_key_missing:
                    meta_progress.update(task_id, completed=100, status=f"[yellow]⊘ no API key[/yellow]")

                    # Send status update to UI
                    if hasattr(args, 'status_server') and args.status_server:
                        send_status_update('progress', {
                            'repo': full_name, 'short_name': short_id,
                            'status': '⊘ skipped - no API key',
                            'percent': 100,
                            'color': 'yellow'
                        }, args.status_server)

                    # Note: Not counting as error since this is expected when user hasn't configured keys yet
                    # But it will be reported in the final stats
                    return 0.0

                meta_progress.update(task_id, completed=10, status=f"[{task_color}]analyzing...[/{task_color}]")

                # Send status update
                if hasattr(args, 'status_server') and args.status_server:
                    send_status_update('progress', {
                        'repo': full_name, 'short_name': short_id,
                        'status': '🤖 analyzing with AI...',
                        'percent': 10,
                        'color': color
                    }, args.status_server)

                # Collect files
                files = collect_repo_files(repo_path)
                if not files:
                    meta_progress.update(task_id, completed=100, status=f"[yellow]⊘ no files found[/yellow]")
                    return 0.0

                # Get model and calculate accurate token count
                model = get_ai_model()
                total_tokens = sum(count_tokens_accurate(f['content'], model) for f in files)
                threshold = get_chunking_threshold(model)
                context_window = get_model_context_window(model)

                meta_progress.update(task_id, completed=20, status=f"[{task_color}]{total_tokens:,} tokens ({context_window//1000}K context, {threshold//1000}K usable)[/{task_color}]")

                total_api_cost = 0.0

                # Check if we need to chunk
                if total_tokens > threshold:
                    # Calculate expected chunks
                    expected_chunks = max(1, (total_tokens // threshold) + 1)

                    # Create chunks using model-aware chunking
                    chunks = chunk_repo_files(files, model, threshold)
                    meta_progress.update(task_id, completed=25, status=f"[{task_color}]{len(chunks)} chunks (expected ~{expected_chunks})[/{task_color}]")

                    # Send status update
                    if hasattr(args, 'status_server') and args.status_server:
                        send_status_update('progress', {
                            'repo': full_name, 'short_name': short_id,
                            'status': f'🤖 processing {len(chunks)} chunks...',
                            'percent': 25,
                            'color': color
                        }, args.status_server)

                    chunk_analyses = []
                    for i, chunk in enumerate(chunks, 1):
                        # Calculate and log chunk size for debugging
                        chunk_tokens = sum(count_tokens_accurate(f['content'], model) for f in chunk)
                        console.print(f"[cyan]Chunk {i}/{len(chunks)}: {chunk_tokens:,} content tokens ({len(chunk)} files)[/cyan]")

                        # Add delay BEFORE processing each chunk (including first to give breathing room)
                        if i == 1:
                            # Initial delay before first chunk
                            meta_progress.update(task_id, status=f"[dim]waiting 3s before starting chunks...[/dim]")
                            time.sleep(3)
                        else:
                            # Longer delay between subsequent chunks
                            meta_progress.update(task_id, status=f"[dim]waiting 6s before next chunk...[/dim]")
                            time.sleep(6)

                        chunk_progress = 25 + (50 * i / len(chunks))
                        meta_progress.update(task_id, completed=chunk_progress, status=f"[{task_color}]chunk {i}/{len(chunks)} ({chunk_tokens:,} tokens)...[/{task_color}]")

                        # Send periodic status updates to UI
                        if hasattr(args, 'status_server') and args.status_server and i % 2 == 0:  # Every 2 chunks
                            send_status_update('progress', {
                                'repo': full_name, 'short_name': short_id,
                                'status': f'🤖 chunk {i}/{len(chunks)}...',
                                'percent': int(chunk_progress),
                                'color': color
                            }, args.status_server)

                        # Retry logic with model fallback for rate limits
                        max_retries = 5
                        base_wait = 3
                        chunk_result = None
                        current_model = get_ai_model()

                        for retry in range(max_retries):
                            try:
                                import litellm
                                files_content = [f"=== {f['path']} ({f['size']} bytes) ===\n{f['content']}\n" for f in chunk]
                                combined_content = "\n".join(files_content)

                                prompt = f"""Analyze this portion of the repository and provide analysis.

Repository: {full_name} (chunk {i}/{len(chunks)})

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

                                response = litellm.completion(
                                    model=current_model,
                                    messages=[{"role": "user", "content": prompt}],
                                    max_tokens=8192
                                )

                                # Update rate limit tracker
                                rate_limit_tracker.update_from_response(response)

                                # Log rate limit status after each chunk
                                rate_status = rate_limit_tracker.get_status_string()
                                if rate_status != "Rate limits: Unknown":
                                    console.print(f"    [dim]{rate_status}[/dim]")

                                analysis = response.choices[0].message.content
                                api_cost = 0.0
                                if hasattr(response, '_hidden_params') and 'response_cost' in response._hidden_params:
                                    api_cost = response._hidden_params['response_cost']

                                chunk_analyses.append(analysis)
                                total_api_cost += api_cost

                                # Success! Break out of retry loop
                                break

                            except Exception as e:
                                import traceback
                                error_str = str(e)
                                error_type = type(e).__name__

                                # Log VERY detailed error for debugging
                                console.print(f"\n[bold red]╔══ ERROR ON CHUNK {i}/{len(chunks)} (Retry {retry+1}/{max_retries}) ══╗[/bold red]")
                                console.print(f"[red]Repository: {full_name}[/red]")
                                console.print(f"[red]Model: {current_model}[/red]")
                                console.print(f"[red]Error Type: {error_type}[/red]")
                                console.print(f"[red]Error Module: {type(e).__module__}[/red]")
                                console.print(f"[red]Error: {error_str[:300]}[/red]")
                                console.print(f"[bold red]╚══════════════════════════════════════╝[/bold red]\n")

                                # Check if it's a rate limit error
                                is_rate_limit = (
                                    error_type == 'RateLimitError' or
                                    '429' in error_str or
                                    'RESOURCE_EXHAUSTED' in error_str or
                                    'rate_limit' in error_str.lower()
                                )

                                if is_rate_limit:
                                    # Try fallback model if available
                                    fallback_model = get_fallback_model(current_model)

                                    if fallback_model and retry < max_retries - 1:
                                        console.print(f"[bold yellow]🔄 Rate limited on {current_model}[/bold yellow]")
                                        console.print(f"[bold yellow]   Falling back to {fallback_model} (separate quota)[/bold yellow]")
                                        current_model = fallback_model
                                        meta_progress.update(task_id, status=f"[yellow]fallback to {fallback_model.split('/')[-1]}...[/yellow]")

                                        # Short delay before trying fallback
                                        time.sleep(2)
                                        continue
                                    elif retry < max_retries - 1:
                                        # No fallback available, wait and retry same model
                                        wait_time = (base_wait ** (retry + 1)) + random.uniform(0, 3)
                                        console.print(f"[yellow]No fallback available. Waiting {int(wait_time)}s...[/yellow]")
                                        meta_progress.update(task_id, status=f"[yellow]waiting {int(wait_time)}s...[/yellow]")

                                        # Send status update to UI
                                        if hasattr(args, 'status_server') and args.status_server:
                                            send_status_update('progress', {
                                                'repo': full_name, 'short_name': short_id,
                                                'status': f'⏳ rate limited, waiting {int(wait_time)}s...',
                                                'percent': int(chunk_progress),
                                                'color': 'yellow'
                                            }, args.status_server)

                                        time.sleep(wait_time)
                                        continue
                                    else:
                                        # Max retries exceeded
                                        raise Exception(f"Rate limit exceeded after {max_retries} retries")
                                else:
                                    # Non-rate-limit error, raise immediately
                                    raise

                        # Note: Delay before next chunk is now at the start of the loop

                    if chunk_analyses:
                        meta_progress.update(task_id, completed=80, status=f"[{task_color}]combining analyses...[/{task_color}]")

                        # Retry logic for combine step with model fallback
                        current_model_combine = current_model  # Use whatever model succeeded for chunks
                        for retry in range(max_retries):
                            try:
                                # Combine analyses (simplified prompt - use existing combine_chunk_analyses function)
                                import litellm
                                combined_prompt = f"""You are reviewing multiple analyses of different parts of the repository "{full_name}".

Please synthesize these into ONE comprehensive repository analysis in the required format with QUICK_REFERENCE, ONE_LINE_SUMMARY, and RELATED_REPOS sections followed by detailed analysis.

Here are the analyses to combine:

"""
                                for part_idx, analysis_part in enumerate(chunk_analyses, 1):
                                    combined_prompt += f"\n--- Analysis Part {part_idx} ---\n{analysis_part}\n"

                                response = litellm.completion(
                                    model=current_model_combine,
                                    messages=[{"role": "user", "content": combined_prompt}],
                                    max_tokens=16384
                                )

                                # Update rate limit tracker
                                rate_limit_tracker.update_from_response(response)

                                analysis = response.choices[0].message.content

                                # Success! Break out of retry loop
                                break

                            except Exception as e:
                                error_str = str(e)
                                error_type = type(e).__name__

                                is_rate_limit = (
                                    error_type == 'RateLimitError' or
                                    '429' in error_str or
                                    'RESOURCE_EXHAUSTED' in error_str
                                )

                                if is_rate_limit:
                                    # Try fallback model
                                    fallback_model = get_fallback_model(current_model_combine)

                                    if fallback_model and retry < max_retries - 1:
                                        console.print(f"[bold yellow]🔄 Combine step rate limited, falling back to {fallback_model}[/bold yellow]")
                                        current_model_combine = fallback_model
                                        meta_progress.update(task_id, status=f"[yellow]combine fallback to {fallback_model.split('/')[-1]}...[/yellow]")
                                        time.sleep(2)
                                        continue
                                    elif retry < max_retries - 1:
                                        # No fallback, wait
                                        wait_time = (base_wait ** (retry + 1)) + random.uniform(0, 3)
                                        meta_progress.update(task_id, status=f"[yellow]waiting {int(wait_time)}s...[/yellow]")
                                        time.sleep(wait_time)
                                        continue
                                    else:
                                        raise Exception(f"Rate limit exceeded on combine after {max_retries} retries")
                                else:
                                    raise
                        if hasattr(response, '_hidden_params') and 'response_cost' in response._hidden_params:
                            total_api_cost += response._hidden_params['response_cost']
                else:
                    # Repo fits in context - single analysis
                    meta_progress.update(task_id, completed=40, status=f"[{task_color}]fits in context, analyzing...[/{task_color}]")

                    # Retry logic with model fallback for rate limits
                    max_retries = 5
                    base_wait = 3
                    analysis = None
                    current_model = get_ai_model()

                    for retry in range(max_retries):
                        try:
                            import litellm
                            files_content = [f"=== {f['path']} ({f['size']} bytes) ===\n{f['content']}\n" for f in files]
                            combined_content = "\n".join(files_content)

                            prompt = f"""Analyze this repository: {full_name}

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

                            meta_progress.update(task_id, completed=60, status=f"[{task_color}]waiting for LLM...[/{task_color}]")

                            response = litellm.completion(
                                model=current_model,
                                messages=[{"role": "user", "content": prompt}],
                                max_tokens=16384
                            )

                            # Update rate limit tracker
                            rate_limit_tracker.update_from_response(response)

                            # Log rate limit status
                            rate_status = rate_limit_tracker.get_status_string()
                            if rate_status != "Rate limits: Unknown":
                                console.print(f"    [dim]{rate_status}[/dim]")

                            # Send rate limit info to UI (only if we have data)
                            if hasattr(args, 'status_server') and args.status_server and rate_status != "Rate limits: Unknown":
                                send_status_update('rate-limit', {
                                    'status': rate_status,
                                    'remaining_requests': rate_limit_tracker.remaining.get('requests'),
                                    'limit_requests': rate_limit_tracker.limits.get('requests'),
                                    'remaining_tokens': rate_limit_tracker.remaining.get('tokens'),
                                    'limit_tokens': rate_limit_tracker.limits.get('tokens')
                                }, args.status_server)

                            analysis = response.choices[0].message.content
                            total_api_cost = 0.0
                            if hasattr(response, '_hidden_params') and 'response_cost' in response._hidden_params:
                                total_api_cost = response._hidden_params['response_cost']

                            # Success! Break out of retry loop
                            break

                        except Exception as e:
                            error_str = str(e)
                            error_type = type(e).__name__

                            # Log detailed error for debugging
                            console.print(f"\n[red]Error analyzing repo:[/red]")
                            console.print(f"[red]Repo: {full_name}[/red]")
                            console.print(f"[red]Model: {current_model}[/red]")
                            console.print(f"[red]Type: {error_type}[/red]")
                            console.print(f"[red]Message: {error_str[:300]}[/red]")

                            is_rate_limit = (
                                error_type == 'RateLimitError' or
                                '429' in error_str or
                                'RESOURCE_EXHAUSTED' in error_str or
                                'rate_limit' in error_str.lower()
                            )

                            if is_rate_limit:
                                # Try fallback model if available
                                fallback_model = get_fallback_model(current_model)

                                if fallback_model and retry < max_retries - 1:
                                    console.print(f"[bold yellow]🔄 Falling back to {fallback_model}[/bold yellow]")
                                    current_model = fallback_model
                                    meta_progress.update(task_id, status=f"[yellow]fallback to {fallback_model.split('/')[-1]}...[/yellow]")
                                    time.sleep(2)
                                    continue
                                elif retry < max_retries - 1:
                                    # No fallback, wait
                                    wait_time = (base_wait ** (retry + 1)) + random.uniform(0, 3)
                                    console.print(f"[yellow]Retry {retry+1}/{max_retries}: Waiting {int(wait_time)}s...[/yellow]")
                                    meta_progress.update(task_id, status=f"[yellow]waiting {int(wait_time)}s...[/yellow]")

                                    # Send status update to UI
                                    if hasattr(args, 'status_server') and args.status_server:
                                        send_status_update('progress', {
                                            'repo': full_name, 'short_name': short_id,
                                            'status': f'⏳ rate limited (attempt {retry+1}/{max_retries}), waiting {int(wait_time)}s...',
                                            'percent': 60,
                                            'color': 'yellow'
                                        }, args.status_server)

                                    time.sleep(wait_time)
                                    continue
                                else:
                                    # Max retries exceeded
                                    raise Exception(f"Rate limit exceeded after {max_retries} retries")
                            else:
                                # Non-rate-limit error, raise immediately
                                raise

                meta_progress.update(task_id, completed=90, status=f"[{task_color}]saving metadata...[/{task_color}]")

                # Parse and save (simplified - use existing parse logic)
                parsed = parse_llm_response(analysis)

                # Build metadata file
                quick_ref = parsed['quick_ref']
                brief = parsed['brief']
                related_repos = parsed['related_repos']
                main_analysis = parsed['analysis']

                # Build Quick Reference table
                quick_ref_table = "## Quick Reference\n\n| Property | Value |\n|----------|-------|\n"
                if 'type' in quick_ref:
                    quick_ref_table += f"| **Type** | {quick_ref['type']} |\n"
                if 'language' in quick_ref:
                    quick_ref_table += f"| **Language** | {quick_ref['language']} |\n"
                if 'framework' in quick_ref and quick_ref['framework'].lower() != 'none':
                    quick_ref_table += f"| **Framework** | {quick_ref['framework']} |\n"
                if 'database' in quick_ref and quick_ref['database'].lower() != 'none':
                    quick_ref_table += f"| **Database** | {quick_ref['database']} |\n"
                if 'apis' in quick_ref and quick_ref['apis'].lower() != 'none':
                    quick_ref_table += f"| **APIs Exposed** | {quick_ref['apis']} |\n"
                if 'port' in quick_ref and quick_ref['port'].lower() != 'n/a':
                    quick_ref_table += f"| **Port** | {quick_ref['port']} |\n"
                if 'dependencies' in quick_ref:
                    quick_ref_table += f"| **Key Dependencies** | {quick_ref['dependencies']} |\n"
                quick_ref_table += "\n---\n\n"

                metadata_content = f"""---
repo_name: {full_name.split('/')[-1]}
full_name: {full_name}
cache_dir: {cache_name}
clone_url: {repo_config['clone_url']}
last_commit: {commit_hash}
last_updated: {datetime.now().isoformat()}
brief: {brief}
type: {quick_ref.get('type', 'Unknown')}
language: {quick_ref.get('language', 'Unknown')}
framework: {quick_ref.get('framework', 'None')}
database: {quick_ref.get('database', 'None')}
apis: {quick_ref.get('apis', 'None')}
port: {quick_ref.get('port', 'N/A')}
related_repos: {json.dumps(related_repos)}
---

# Repository: {full_name}

{quick_ref_table}{main_analysis}
"""

                metadata_file = PRISTINE_DIR / f"{cache_name}.md"
                with open(metadata_file, 'w') as f:
                    f.write(metadata_content)

                # Create symlink
                repo_name = full_name.split('/')[-1]
                metadata_symlink = PRISTINE_DIR / f"{repo_name}.md"
                if metadata_symlink.exists() or metadata_symlink.is_symlink():
                    try:
                        metadata_symlink.unlink()
                    except:
                        pass
                try:
                    metadata_symlink.symlink_to(f"{cache_name}.md")
                except Exception:
                    pass

                meta_progress.update(task_id, completed=100, status=f"[{task_color}]✓ generated (${total_api_cost:.4f})[/{task_color}]")

                # Send status update to UI
                if hasattr(args, 'status_server') and args.status_server:
                    send_status_update('progress', {
                        'repo': full_name, 'short_name': short_id,
                        'status': f'✓ metadata complete (${total_api_cost:.4f})',
                        'percent': 100,
                        'color': color
                    }, args.status_server)

                with stats_lock:
                    stats['metadata_generated'] += 1
                    stats['api_cost'] += total_api_cost

                return total_api_cost

            except Exception as e:
                import traceback

                full_error = str(e)
                error_type = type(e).__name__
                stack_trace = traceback.format_exc()

                # Show more descriptive error for common issues
                if 'NotFoundError' in full_error:
                    short_msg = f"Model not found: {get_ai_model()}"
                    detailed_msg = f"""ERROR: Model Not Found
Repository: {full_name}
Model: {get_ai_model()}
Error Type: {error_type}

Details:
{full_error}

This usually means:
- The model name is incorrect or not supported by litellm
- The model requires a specific API endpoint configuration
- Check the model name in Settings → AI Model

Stack Trace:
{stack_trace}"""
                elif 'AuthenticationError' in full_error or 'API key' in full_error:
                    short_msg = "Invalid API key"
                    detailed_msg = f"""ERROR: Authentication Failed
Repository: {full_name}
Model: {get_ai_model()}
Error Type: {error_type}

Details:
{full_error}

This usually means:
- Your API key is invalid or expired
- The API key doesn't have access to this model
- Check your API key in Settings → API Configuration

Stack Trace:
{stack_trace}"""
                elif 'RateLimitError' in full_error or '429' in full_error:
                    short_msg = "Rate limit exceeded"
                    detailed_msg = f"""ERROR: Rate Limit Exceeded
Repository: {full_name}
Model: {get_ai_model()}
Error Type: {error_type}

Details:
{full_error}

This usually means:
- Too many requests to the API
- Exceeded quota for your API key
- Try again in a few minutes

Stack Trace:
{stack_trace}"""
                else:
                    short_msg = full_error[:50]
                    detailed_msg = f"""ERROR: Metadata Generation Failed
Repository: {full_name}
Model: {get_ai_model()}
Error Type: {error_type}

Full Error:
{full_error}

Stack Trace:
{stack_trace}"""

                meta_progress.update(task_id, completed=100, status=f"[red]✗ {short_msg}[/red]")

                # Send detailed error to status server
                if hasattr(args, 'status_server') and args.status_server:
                    send_status_update('progress', {
                        'repo': full_name, 'short_name': short_id,
                        'status': f'✗ metadata failed: {short_msg}',
                        'percent': 100,
                        'color': 'red'
                    }, args.status_server)

                    # Send detailed error info
                    send_status_update('error', {
                        'repo': full_name,
                        'message': short_msg,
                        'fullError': detailed_msg
                    }, args.status_server)

                # Count as error
                with stats_lock:
                    stats['errors'] += 1

                return 0.0

        # Run metadata generation with live progress
        with Live(meta_progress, console=console, refresh_per_second=10):
            with ThreadPoolExecutor(max_workers=max_metadata_workers) as executor:
                futures = [executor.submit(generate_metadata_task, task_data) for task_data in repos_needing_metadata]

                for future in as_completed(futures):
                    try:
                        future.result()
                    except Exception:
                        pass

        console.print()

        # Regenerate INDEX.md
        if not args.dry_run:
            console.print(f"[cyan]Regenerating INDEX.md...[/cyan]")
            regenerate_index(args)
            console.print(f"[green]✓ INDEX.md updated[/green]")

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
        if stats['api_cost'] > 0:
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

                if model.startswith('gemini/') and not os.getenv('GEMINI_API_KEY'):
                    console.print(f"[yellow]   Reason: GEMINI_API_KEY not configured[/yellow]")
                    console.print(f"[yellow]   Fix: Configure Gemini API Key in Settings → API Configuration[/yellow]")
                elif model.startswith('claude') and not os.getenv('ANTHROPIC_API_KEY'):
                    console.print(f"[yellow]   Reason: ANTHROPIC_API_KEY not configured[/yellow]")
                    console.print(f"[yellow]   Fix: Configure Anthropic API Key in Settings → API Configuration[/yellow]")
                elif (model.startswith('gpt') or model.startswith('o1') or model.startswith('o3') or model.startswith('o4') or model.startswith('chatgpt/') or model.startswith('codex')) and not os.getenv('OPENAI_API_KEY'):
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

            if model.startswith('gemini/') and not os.getenv('GEMINI_API_KEY'):
                warning_msg = "⚠️ No metadata generated: GEMINI_API_KEY not configured. Configure in Settings → API Configuration."
            elif model.startswith('claude') and not os.getenv('ANTHROPIC_API_KEY'):
                warning_msg = "⚠️ No metadata generated: ANTHROPIC_API_KEY not configured. Configure in Settings → API Configuration."
            elif (model.startswith('gpt') or model.startswith('o1') or model.startswith('o3') or model.startswith('o4') or model.startswith('chatgpt/') or model.startswith('codex')) and not os.getenv('OPENAI_API_KEY'):
                warning_msg = "⚠️ No metadata generated: OPENAI_API_KEY not configured. Configure in Settings → API Configuration."
            elif stats['errors'] > 0:
                warning_msg = f"⚠️ No metadata generated: {stats['errors']} errors occurred (possible model not found or API issues)."
            else:
                warning_msg = f"⚠️ No metadata generated: Unknown reason. Current model: {model}"

            completion_data['warning'] = warning_msg

        send_status_update('complete', completion_data, args.status_server)

    return 0 if stats['errors'] == 0 else 1
