"""File collection and filtering for repository analysis."""

import os
from repo_radar.git import run_git_command


def should_include_file(file_path):
    """Check if a file should be included in metadata generation."""
    # Source code extensions
    source_exts = [
        '.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.java', '.rb', '.php',
        '.c', '.cpp', '.h', '.hpp', '.rs', '.swift', '.kt', '.scala',
        '.sh', '.bash', '.zsh', '.sql', '.graphql', '.proto'
    ]

    # Config files
    config_files = [
        'package.json', 'requirements.txt', 'go.mod', 'Cargo.toml',
        'pom.xml', 'build.gradle', 'Gemfile', 'composer.json',
        '.env.example', 'Dockerfile', 'docker-compose.yml',
        'tsconfig.json', 'webpack.config.js', 'vite.config.js',
        'Makefile'
    ]

    # Documentation
    doc_patterns = ['README', '.md']

    # Check exclusions first
    exclude_patterns = [
        'node_modules/', 'vendor/', 'venv/', '.venv/', 'env/',
        'dist/', 'build/', 'target/', '.git/', '__pycache__/',
        '.pytest_cache/', '.mypy_cache/', 'coverage/',
        'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
        'Cargo.lock', 'go.sum', 'poetry.lock', 'Gemfile.lock'
    ]

    for pattern in exclude_patterns:
        if pattern in file_path:
            return False

    # Check file name
    file_name = file_path.split('/')[-1]

    # Check if it's a config file
    if file_name in config_files:
        return True

    # Check if it's documentation
    for pattern in doc_patterns:
        if pattern in file_name:
            return True

    # Check extension
    for ext in source_exts:
        if file_path.endswith(ext):
            return True

    return False


def collect_repo_files(repo_path):
    """Collect relevant files from a repository for metadata generation."""
    result = run_git_command(['git', 'ls-files'], cwd=repo_path, check=False)
    if result.returncode != 0:
        return []

    files = []
    max_file_size = 100 * 1024  # 100KB

    for file_path in result.stdout.strip().split('\n'):
        if not file_path or not should_include_file(file_path):
            continue

        full_path = repo_path / file_path

        # Check file size
        try:
            if full_path.stat().st_size > max_file_size:
                continue
        except:
            continue

        # Read file content
        try:
            with open(full_path, 'r', encoding='utf-8', errors='ignore') as f:
                content = f.read()
                files.append({
                    'path': file_path,
                    'size': len(content),
                    'content': content
                })
        except:
            continue

    return files
