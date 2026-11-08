import pytest


@pytest.fixture(autouse=True)
def _private_spending_record(tmp_path_factory, monkeypatch):
    """Every test gets its own weekly spending record, never the real one under ~/.config/repo-radar."""
    monkeypatch.setenv('REPO_RADAR_SPENDING_DIR', str(tmp_path_factory.mktemp('spending')))
