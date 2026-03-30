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
