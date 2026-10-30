"""release.sh runs its Python gates only in the supplied, verified release venv.

Behavioral: runs the real release.sh and the real interpreter check in a disposable checkout whose
gates are stubs that record which interpreter ran them. The ambient python3 is a shim that fails,
and npm/npx/gh are shims that record any build or publish call.
"""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]

GATE_STUB = """import json, os, sys
name = os.path.basename(sys.argv[0])
with open(os.environ["RR_LOG"], "a") as f:
    f.write(json.dumps({"gate": name, "exe": sys.executable, "argv": sys.argv[1:],
                        "no_bytecode": sys.flags.dont_write_bytecode, "isolated": sys.flags.isolated}) + "\\n")
sys.exit(1 if os.environ.get("RR_FAIL_GATE") == name else 0)
"""

RECORD_SHIM = """#!/bin/sh
echo "{\\"call\\": \\"$(basename "$0") $*\\"}" >> "$RR_LOG"
"""


def _in_venv():
    return sys.prefix != sys.base_prefix


def _write(path, text, mode=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    if mode:
        path.chmod(mode)


def _manifest_for(python):
    """An exact manifest of `python`'s installed set, so the real check accepts it."""
    listed = json.loads(subprocess.check_output([python, "-m", "pip", "list", "--format=json"]))
    versions = {d["name"].lower(): d["version"] for d in listed}
    boot = {n: v for n, v in versions.items() if n in ("pip", "setuptools", "wheel")}
    dists = {n: v for n, v in versions.items() if n not in boot}
    return {"bootstrap": boot, "dists": dists}


@pytest.fixture
def checkout(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    shutil.copy2(ROOT / "release.sh", repo / "release.sh")
    for rel in ("scripts/check_release_python.js", "menubar/runtime/interpreter.js", "menubar/runtime/deps.js"):
        (repo / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / rel, repo / rel)
    _write(repo / "scripts/check_model_lifecycle.py", GATE_STUB)
    _write(repo / "scripts/check_model_windows.py", GATE_STUB)
    _write(repo / "menubar/scripts/pydeps.js",
           "require('fs').appendFileSync(process.env.RR_LOG, JSON.stringify({gate: 'matrix'}) + '\\n');\n")
    _write(repo / "menubar/package.json", json.dumps({"name": "repo-radar", "version": "1.0.0"}) + "\n")
    _write(repo / "VERSION", "1.0.0\n")
    tag = f"cp3{sys.version_info[1]}-{os.uname().machine}"
    _write(repo / f"resources/pydeps/{tag}.lock", "")
    _write(repo / f"resources/pydeps/{tag}.manifest.json", json.dumps(_manifest_for(sys.executable)))
    git = ["git", "-c", "user.name=t", "-c", "user.email=t@example.com"]
    subprocess.run(["git", "init", "-q", "-b", "dev"], cwd=repo, check=True)
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(git + ["commit", "-q", "-m", "fixture"], cwd=repo, check=True)

    shims = tmp_path / "bin"
    for name in ("python3", "python"):
        _write(shims / name, '#!/bin/sh\necho \'{"ambient": true}\' >> "$RR_LOG"\nexit 1\n', 0o755)
    for name in ("npm", "npx"):
        _write(shims / name, RECORD_SHIM, 0o755)
    _write(shims / "gh", '#!/bin/sh\n[ "$1 $2" = "auth status" ] && exit 0\n' + RECORD_SHIM.split("\n", 1)[1], 0o755)
    log = tmp_path / "log.jsonl"
    log.touch()
    node_dir = str(Path(shutil.which("node")).parent)
    env = {"PATH": f"{shims}:{node_dir}:/usr/bin:/bin", "HOME": str(tmp_path), "RR_LOG": str(log),
           "TMPDIR": os.environ.get("TMPDIR", "/tmp")}
    return repo, log, env


def _run(checkout, release_python, *args, fail_gate=None):
    repo, log, env = checkout
    env = dict(env)
    if release_python is not None:
        env["REPO_RADAR_RELEASE_PYTHON"] = release_python
    if fail_gate:
        env["RR_FAIL_GATE"] = fail_gate
    log.write_text("")
    proc = subprocess.run(["bash", str(repo / "release.sh"), *args], cwd=repo, env=env,
                          capture_output=True, text=True, timeout=120)
    entries = [json.loads(line) for line in log.read_text().splitlines() if line.strip()]
    return proc, entries


def _assert_nothing_released(repo, entries):
    assert (repo / "VERSION").read_text() == "1.0.0\n"
    assert subprocess.check_output(["git", "tag"], cwd=repo, text=True) == ""
    assert subprocess.check_output(["git", "rev-list", "--count", "HEAD"], cwd=repo, text=True).strip() == "1"
    assert subprocess.check_output(["git", "status", "--porcelain"], cwd=repo, text=True) == ""
    assert not [e for e in entries if "call" in e], entries


@pytest.mark.skipif(not _in_venv(), reason="needs the test interpreter to be a venv (set up per DEVELOPMENT.md)")
def test_gates_run_in_supplied_venv_and_failures_block_release(checkout):
    repo, _, _ = checkout
    venv_python = sys.executable

    proc, entries = _run(checkout, venv_python, "--dry-run")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    gates = [e for e in entries if "gate" in e]
    assert [g["gate"] for g in gates] == ["check_model_lifecycle.py", "check_model_windows.py", "matrix"]
    for g in gates[:2]:
        assert g["exe"] == venv_python, "venv path must be used as supplied, not resolved"
        assert g["argv"][0] == "--target-date" and len(g["argv"][1]) == 10
        assert g["no_bytecode"] == 1
        assert g["isolated"] == 1, "gates must run in isolated mode (-I)"
    assert not [e for e in entries if e.get("ambient")], "ambient python3 must never run"
    _assert_nothing_released(repo, entries)

    # Publishing is paused: a real run whose gates all pass still stops before any change.
    proc, entries = _run(checkout, venv_python)
    assert proc.returncode != 0
    assert "publishing is paused" in proc.stderr
    assert [e["gate"] for e in entries if "gate" in e] == ["check_model_lifecycle.py", "check_model_windows.py", "matrix"]
    _assert_nothing_released(repo, entries)

    # The base interpreter behind the venv symlink is not a venv: rejected before any gate.
    for bad in (None, os.path.realpath(venv_python)):
        proc, entries = _run(checkout, bad)
        assert proc.returncode != 0
        assert "REPO_RADAR_RELEASE_PYTHON" in proc.stdout + proc.stderr
        assert not [e for e in entries if "gate" in e or e.get("ambient")], entries
        _assert_nothing_released(repo, entries)

    # A failing gate stops the release before version, build or publish steps.
    for failing, ran in (("check_model_lifecycle.py", 1), ("check_model_windows.py", 2)):
        proc, entries = _run(checkout, venv_python, fail_gate=failing)
        assert proc.returncode != 0
        assert "Release blocked" in proc.stderr
        assert len([e for e in entries if "gate" in e]) == ran
        _assert_nothing_released(repo, entries)
