from repo_radar.config import get_cache_name


def test_get_cache_name_is_deterministic():
    a = get_cache_name("https://github.com/org/repo.git", "repo")
    b = get_cache_name("https://github.com/org/repo.git", "repo")
    assert a == b


def test_get_cache_name_includes_repo_name():
    name = get_cache_name("https://github.com/org/my-repo.git", "my-repo")
    assert name.startswith("my-repo-")
    assert len(name) == len("my-repo-") + 7  # 7-char hash


def test_get_cache_name_differs_by_url():
    a = get_cache_name("https://github.com/org1/repo.git", "repo")
    b = get_cache_name("https://github.com/org2/repo.git", "repo")
    assert a != b
