from repo_radar.ui import format_size, get_short_id


def test_format_size_bytes():
    assert format_size(500) == "500.00 B"


def test_format_size_kb():
    assert format_size(1536) == "1.50 KB"


def test_format_size_mb():
    assert format_size(1_500_000) == "1.43 MB"


def test_get_short_id_strips_org():
    # With no config strip_prefixes, should just truncate
    short_id, color = get_short_id("org/my-cool-repo")
    assert short_id == "my-cool-repo"
