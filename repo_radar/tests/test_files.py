from repo_radar.files import should_include_file


def test_includes_python_files():
    assert should_include_file("src/main.py") is True


def test_includes_javascript_files():
    assert should_include_file("src/app.js") is True


def test_excludes_binary_files():
    assert should_include_file("image.png") is False
    assert should_include_file("archive.zip") is False


def test_excludes_lock_files():
    assert should_include_file("package-lock.json") is False
    assert should_include_file("yarn.lock") is False


def test_excludes_node_modules():
    assert should_include_file("node_modules/foo/index.js") is False


def test_includes_config_files():
    assert should_include_file("Dockerfile") is True
    assert should_include_file("Makefile") is True
    assert should_include_file("docker-compose.yml") is True


def test_test_code_is_left_out_by_name_or_lowercase_test_folder():
    left_out = ['web-app/src/api.test.ts', 'web-app/src/Button.spec.tsx', 'mobile-api/internal/plan_test.go',
                'ai-service/tests/test_triage.py', 'ai-service/app/test_routes.py', 'ai-service/app/routes_test.py',
                'ai-service/conftest.py', 'supabase/tests/rls.sql', 'scripts/__tests__/deploy.ts',
                'dispatch-service/test/helpers.ts', 'transcription-service/testdata/sample.go', 'lib/user_spec.rb']
    kept = ['mobile-app/src/screens/Tests/LabResults.tsx',   # a product screen, not test code
            'mobile-app/src/screens/Tests/index.ts', 'web-app/src/LabTests.tsx', 'web-app/src/testing.ts',
            'mobile-api/internal/latest.go', 'ai-service/app/contest.py', 'docs/TESTING.md']
    assert [p for p in left_out if should_include_file(p)] == []
    assert [p for p in kept if not should_include_file(p)] == []
    assert all(should_include_file(p, include_tests=True) for p in left_out)
