from repo_radar.git import run_git_command


def test_run_git_command_returns_result():
    result = run_git_command(["git", "--version"])
    assert result.returncode == 0
    assert "git version" in result.stdout


def test_run_git_command_bad_command():
    result = run_git_command(["git", "not-a-real-command"], check=False)
    assert result.returncode != 0
