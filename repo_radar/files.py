"""File filtering for repository analysis."""


# Folder names a real source module can have too (an insurance `coverage` module, say): build output only at a
# build root, which is the repository root or a folder holding a build manifest (metadata_snapshot.build_roots).
BUILD_OUTPUT_DIRS = frozenset({'vendor', 'dist', 'coverage'})


def under_build_output(path, roots=frozenset({''})):
    """True when `path` sits inside a `vendor`, `dist` or `coverage` folder at one of the lowercased build
    `roots` ('' is the repository root)."""
    parts = path.lower().split('/')
    return any(part in BUILD_OUTPUT_DIRS and '/'.join(parts[:i]) in roots for i, part in enumerate(parts[:-1]))


# Test code: summaries are written from product code, so tests are counted but never read. Folder names are
# matched exactly and in lowercase only: a folder named "Tests" can be a product screen (a lab tests page).
TEST_DIRS = frozenset({'test', 'tests', '__tests__', 'testdata'})
TEST_NAME_PARTS = ('.test.', '.spec.')                       # foo.test.ts, foo.spec.tsx
TEST_NAME_SUFFIXES = ('_test.go', '_test.py', '_spec.rb', '_test.rb')
TEST_NAME_PREFIXES = ('test_',)                              # test_*.py
TEST_NAMES = frozenset({'conftest.py'})


def is_test_file(file_path):
    """True when `file_path` is test code by its name (foo.test.ts, foo.spec.js, foo_test.go, test_foo.py,
    foo_test.py, conftest.py, foo_spec.rb) or by a folder named exactly test, tests, __tests__ or testdata.
    Case-sensitive: `Tests/` or `LabTests.tsx` is not test code."""
    parts = file_path.split('/')
    name = parts[-1]
    if any(part in TEST_DIRS for part in parts[:-1]) or name in TEST_NAMES:
        return True
    if any(part in name for part in TEST_NAME_PARTS) or name.endswith(TEST_NAME_SUFFIXES):
        return True
    return name.startswith(TEST_NAME_PREFIXES) and name.endswith('.py')


def should_include_file(file_path, roots=frozenset({''}), include_tests=False):
    """Check if a file should be included in metadata generation. `roots` are the build roots where a
    `vendor`, `dist` or `coverage` folder is build output (under_build_output). Test code (is_test_file) is
    left out unless `include_tests`, which only says whether a test file would otherwise be selected."""
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
    if not include_tests and is_test_file(file_path):
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
