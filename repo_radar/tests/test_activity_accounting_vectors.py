"""Ruling 56 (Codex R6-4, IMPORTANT): the shared, normalized byte-accounting rule -- pinned by
`repo_radar/tests/data/accounting_vectors.json`, which a concurrent Node suite drives against its
own identical implementation of the same function. This file drives it against Python's
`quota._compute_snapshot`, a PURE function (no filesystem/ledger I/O -- see `quota._gather_
accounting` for the one impure pass that produces its `AccountingInputs` input in real use).

Each vector's `constants` are monkeypatched onto the `quota` module for the duration of that one
case, since `_compute_snapshot` reads `CEILING`/`PER_ACTIVITY_CAP` as module globals AT CALL TIME
(never bound as default arguments) so a test's monkeypatch is honored exactly like every other
constant in this module."""
import json, pathlib
import pytest
from repo_radar.activity import quota

VECTORS = json.loads(
    (pathlib.Path(__file__).parent / "data" / "accounting_vectors.json").read_text())


def _inputs_from_json(d):
    activities = [quota.ActivityInput(aid=a["aid"], on_disk=a["on_disk"]) for a in d["activities"]]
    ledger = []
    for entry in d["ledger"]:
        if entry.get("corrupt"):
            ledger.append(quota.LedgerInput(aid=entry["aid"], corrupt=True))
        else:
            ledger.append(quota.LedgerInput(
                aid=entry["aid"], reserved=entry["reserved"], granted=entry["granted"]))
    return quota.AccountingInputs(
        root_listable=d["root_listable"],
        ledger_listable=d["ledger_listable"],
        activities=activities,
        rejected_root_ids=list(d["rejected_root_ids"]),
        ledger=ledger,
    )


def test_accounting_vectors_fixture_schema():
    # Contract the Node suite relies on: exact key set at every level (schema in G6-Py's brief).
    assert VECTORS, "fixture must not be empty"
    for case in VECTORS:
        assert set(case) == {"name", "inputs", "constants", "expected"}, case.get("name")
        assert set(case["inputs"]) == {
            "root_listable", "ledger_listable", "activities", "rejected_root_ids", "ledger",
        }, case["name"]
        assert set(case["constants"]) == {"CEILING", "PER_ACTIVITY_CAP", "RESERVE"}, case["name"]
        assert set(case["expected"]) == {"charge", "uncertain", "corrupt"}, case["name"]
        for a in case["inputs"]["activities"]:
            assert set(a) == {"aid", "on_disk"}, case["name"]
        for e in case["inputs"]["ledger"]:
            assert set(e) == {"aid", "corrupt"} or set(e) == {"aid", "reserved", "granted"}, case["name"]
        # the real constants (Ruling 56: "use the REAL constants so the vectors read naturally")
        assert case["constants"] == {
            "CEILING": 64 * 1024 * 1024, "PER_ACTIVITY_CAP": 4 * 1024 * 1024, "RESERVE": 60 * 1024,
        }, case["name"]


@pytest.mark.parametrize("case", VECTORS, ids=[c["name"] for c in VECTORS])
def test_accounting_vectors(case, monkeypatch):
    monkeypatch.setattr(quota, "CEILING", case["constants"]["CEILING"])
    monkeypatch.setattr(quota, "PER_ACTIVITY_CAP", case["constants"]["PER_ACTIVITY_CAP"])
    monkeypatch.setattr(quota, "RESERVE", case["constants"]["RESERVE"])

    inputs = _inputs_from_json(case["inputs"])
    snap = quota._compute_snapshot(inputs)

    exp = case["expected"]
    assert snap.charge == exp["charge"], case["name"]
    assert snap.uncertain is exp["uncertain"], case["name"]
    assert snap.corrupt is exp["corrupt"], case["name"]


def test_compute_snapshot_is_pure_no_filesystem_access(monkeypatch, tmp_path):
    # Ruling 56: `_compute_snapshot` must do NO I/O -- poison every filesystem/os entry point it
    # could plausibly reach and confirm a normal case still computes correctly from `inputs` alone.
    import os
    def boom(*a, **k):
        raise AssertionError("_compute_snapshot must not touch the filesystem")
    monkeypatch.setattr(os, "scandir", boom)
    monkeypatch.setattr(os, "stat", boom)
    monkeypatch.setattr(os, "open", boom)
    monkeypatch.setattr(os, "lstat", boom)

    inputs = quota.AccountingInputs(
        root_listable=True, ledger_listable=True,
        activities=[quota.ActivityInput(aid="a", on_disk=42)],
        rejected_root_ids=[], ledger=[],
    )
    snap = quota._compute_snapshot(inputs)
    assert snap == quota.Snapshot(charge=42, uncertain=False, corrupt=False)


def test_corrupt_ledger_entry_suppresses_its_own_on_disk_term():
    # Not one of the required fixture cases, but the exact overlap `_compute_snapshot`'s rule
    # calls out explicitly: an aid with BOTH a real, measured activity directory AND a corrupt
    # ledger entry must contribute ONLY the flat PER_ACTIVITY_CAP -- never on_disk + cap.
    inputs = quota.AccountingInputs(
        root_listable=True, ledger_listable=True,
        activities=[quota.ActivityInput(aid="x", on_disk=999999)],
        rejected_root_ids=[],
        ledger=[quota.LedgerInput(aid="x", corrupt=True)],
    )
    snap = quota._compute_snapshot(inputs)
    assert snap.charge == quota.PER_ACTIVITY_CAP
    assert snap.corrupt is True
