"""File filtering for repository analysis."""


# Folder names a real source module can have too (an insurance `coverage` module, say): build output only at a
# build root, which is the repository root or a folder holding a build manifest (metadata_snapshot.build_roots).
BUILD_OUTPUT_DIRS = frozenset({'vendor', 'dist', 'coverage'})


def under_build_output(path, roots=frozenset({''})):
    """True when `path` sits inside a `vendor`, `dist` or `coverage` folder at one of the lowercased build
    `roots` ('' is the repository root)."""
    parts = path.lower().split('/')
    return any(part in BUILD_OUTPUT_DIRS and '/'.join(parts[:i]) in roots for i, part in enumerate(parts[:-1]))


def should_include_file(file_path, roots=frozenset({''})):
    """Check if a file should be included in metadata generation. `roots` are the build roots where a
    `vendor`, `dist` or `coverage` folder is build output (under_build_output)."""
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
        'node_modules/', 'venv/', '.venv/', 'env/',
        'build/', 'target/', '.git/', '__pycache__/',
        '.pytest_cache/', '.mypy_cache/',
        'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
        'Cargo.lock', 'go.sum', 'poetry.lock', 'Gemfile.lock'
    ]

    for pattern in exclude_patterns:
        if pattern in file_path:
            return False
    if under_build_output(file_path, roots):
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
