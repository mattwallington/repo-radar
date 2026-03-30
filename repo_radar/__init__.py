"""Repo Radar - Pristine repository mirrors with AI-powered metadata."""

import json
from pathlib import Path


def _get_version():
    """Read version from VERSION file."""
    try:
        version_file = Path(__file__).parent.parent / 'VERSION'
        if version_file.exists():
            return version_file.read_text().strip()
        # Check in app bundle resources
        version_file = Path(__file__).parent.parent.parent / 'VERSION'
        if version_file.exists():
            return version_file.read_text().strip()
    except Exception:
        pass
    return '1.0.0'


VERSION = _get_version()
SCRIPT_NAME = 'repo-radar'
SCRIPT_DESCRIPTION = "Maintain pristine mirrors of GitHub repositories with LLM-powered metadata for efficient context discovery"
