from repo_radar.constants import GREEN, RESET, REPO_COLORS, PROGRESS_COLORS


def test_color_codes_are_ansi():
    assert GREEN.startswith("\033[")
    assert RESET == "\033[0m"


def test_repo_colors_count():
    assert len(REPO_COLORS) == 10


def test_progress_colors_count():
    assert len(PROGRESS_COLORS) == 20
