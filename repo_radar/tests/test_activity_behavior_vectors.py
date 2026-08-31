"""Task 2.2b: the Python half of the shared cross-language behavior-vector harness. Reads the
SAME committed menubar/activity/__tests__/behavior-vectors.json that behavior-vectors.test.js
reads and asserts the exact `expect` block for each vector -- identical OBSERVABLE outcomes
across languages, not identical mechanism (Node delegates destructive cleanup to a spawned
Python subprocess per Ruling B; Python does it in-process; none of these 4 vectors happen to
require delegation, so both sides run entirely in-process here too)."""
import json
from pathlib import Path

import pytest

from repo_radar.activity import quota, paths, lease, ids, reconcile

VECTORS_PATH = (
    Path(__file__).resolve().parents[2] / "menubar" / "activity" / "__tests__" / "behavior-vectors.json"
)
VECTORS = json.loads(VECTORS_PATH.read_text())


def _new_activity(tmp_path):
    aid = ids.mint_activity_id()
    d = paths.activity_dir(tmp_path, aid)
    paths.secure_mkdir(d)
    lp = paths.owner_lock_path(tmp_path, aid)
    return aid, lease.acquire(lp)


def _write_rec(home, aid, **rec):
    rec.setdefault("schema_version", 1)
    rec.setdefault("activity_id", aid)
    rec.setdefault("ts", "2026-08-14T00:00:00-07:00")
    import os
    seg = paths.segment_path(home, aid, "python", "deadbeef")
    fd = paths.secure_open_append(seg)
    os.write(fd, (json.dumps(rec) + "\n").encode())
    os.close(fd)


def _read_entry(home, aid):
    return json.loads(paths.ledger_entry_path(home, aid).read_text())


def _run_grant_cap_and_reserve_partition(tmp_path, v, monkeypatch):
    aid, l = _new_activity(tmp_path)
    actual = {}
    actual["admit_result"] = quota.admit(tmp_path, aid, l)
    entry = _read_entry(tmp_path, aid)
    actual["reserved_after_admit"] = entry["reserved"]
    actual["granted_after_admit"] = entry["granted"]
    actual["grant_ordinary_cap_result"] = quota.grant(tmp_path, aid, v["params"]["ordinary_cap"])
    entry = _read_entry(tmp_path, aid)
    actual["granted_after_ordinary_grant"] = entry["granted"]
    actual["grant_one_more_result"] = quota.grant(tmp_path, aid, 1)
    entry = _read_entry(tmp_path, aid)
    actual["granted_after_refused_grant"] = entry["granted"]
    actual["reserved_after_refused_grant"] = entry["reserved"]
    return actual


def _run_corrupt_ledger_charged_full_cap(tmp_path, v, monkeypatch):
    paths.secure_mkdir(paths.quota_dir(tmp_path))
    aid = ids.mint_activity_id()
    paths.ledger_entry_path(tmp_path, aid).write_text("{not valid json")
    return {"charge_equals": quota._charge(tmp_path)}


def _run_refuse_while_corrupt_at_real_ceiling(tmp_path, v, monkeypatch):
    actual = {}
    live, ll = _new_activity(tmp_path)
    actual["live_admit_result"] = quota.admit(tmp_path, live, ll)  # BEFORE any corruption exists

    held, hl = _new_activity(tmp_path)  # owner.lock HELD -- deliberately never released
    paths.ledger_entry_path(tmp_path, held).write_text("{not valid json")

    fresh, fl = _new_activity(tmp_path)
    actual["fresh_admit_result"] = quota.admit(tmp_path, fresh, fl)
    actual["live_grant_result"] = quota.grant(tmp_path, live, v["params"]["grant_nbytes"])
    return actual


def _run_terminal_durability_failure_preserves_reservation(tmp_path, v, monkeypatch):
    aid, l = _new_activity(tmp_path)
    actual = {}
    actual["admit_result"] = quota.admit(tmp_path, aid, l)
    _write_rec(tmp_path, aid, type="start", seq=0, kind="sync", channel="stable",
               trigger="cli", created_by="python")
    l.release()  # simulate crash after start, before terminal
    monkeypatch.setattr(reconcile.os, "fsync", lambda fd: (_ for _ in ()).throw(OSError("no fsync")))
    actual["synthesize_result"] = reconcile.synthesize_terminal(tmp_path, aid)
    monkeypatch.undo()
    actual["ledger_entry_survives"] = paths.ledger_entry_path(tmp_path, aid).exists()
    return actual


SCENARIOS = {
    "grant_cap_and_reserve_partition": _run_grant_cap_and_reserve_partition,
    "corrupt_ledger_charged_full_cap": _run_corrupt_ledger_charged_full_cap,
    "refuse_while_corrupt_at_real_ceiling": _run_refuse_while_corrupt_at_real_ceiling,
    "terminal_durability_failure_preserves_reservation": _run_terminal_durability_failure_preserves_reservation,
}


@pytest.mark.parametrize("vector", VECTORS, ids=[v["name"] for v in VECTORS])
def test_behavior_vector(tmp_path, monkeypatch, vector):
    run = SCENARIOS.get(vector["scenario"])
    assert run is not None, f'no Python runner registered for scenario "{vector["scenario"]}"'
    actual = run(tmp_path, vector, monkeypatch)
    for key, expected in vector["expect"].items():
        assert actual.get(key) == expected, f'{vector["name"]}: {key}'
