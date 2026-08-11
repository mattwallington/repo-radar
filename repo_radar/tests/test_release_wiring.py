"""Verify release.sh wires in the model-window drift gate after the lifecycle gate."""

from pathlib import Path

RELEASE_SH = Path(__file__).resolve().parents[2] / "release.sh"


def _read_release_sh() -> str:
    return RELEASE_SH.read_text()


def test_release_sh_runs_check_model_windows():
    contents = _read_release_sh()
    assert "scripts/check_model_windows.py" in contents


def test_model_windows_gate_runs_after_lifecycle_gate():
    contents = _read_release_sh()
    lifecycle_index = contents.index("scripts/check_model_lifecycle.py")
    windows_index = contents.index("scripts/check_model_windows.py")
    assert windows_index > lifecycle_index
