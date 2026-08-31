"""Ruling 56 (Codex R6-4, IMPORTANT) / Ruling 62 (Codex R7-3, IMPORTANT -- schema v2, REPLACES the
Round-6 arithmetic): the shared, normalized byte-accounting rule -- pinned by
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
    activities = [
        quota.ActivityInput(aid=a["aid"], on_disk_measured=a["on_disk"], uncertain=a["uncertain"])
        for a in d["activities"]
    ]
    ledger = []
    for entry in d["ledger"]:
        if entry.get("corrupt"):
            ledger.append(quota.LedgerInput(aid=entry["aid"], corrupt=True))
        else:
            ledger.append(quota.LedgerInput(
                aid=entry["aid"], reserved=entry["reserved"], granted=entry["granted"]))
    # Ruling 71 (Codex R11 B1): OPTIONAL `foreign` key -- non-UUID root entries (other than
    # `quota`) measured conservatively, never managed. Absent => empty (every pre-R11 vector).
    foreign = [
        quota.ForeignInput(name=f["name"], on_disk_measured=f["on_disk"], uncertain=f["uncertain"])
        for f in d.get("foreign", [])
    ]
    return quota.AccountingInputs(
        root_listable=d["root_listable"],
        ledger_listable=d["ledger_listable"],
        activities=activities,
        rejected_root_ids=list(d["rejected_root_ids"]),
        ledger=ledger,
        foreign=foreign,
    )


def test_fixture_carries_the_ruling_71_and_74_foreign_vectors():
    names = [c["name"] for c in VECTORS]
    assert sum(1 for n in names if n.endswith("-ruling-71")) == 2   # the two CERTAIN foreign cases
    # Ruling 74: the uncertain-foreign vector moved from the per-activity cap to the CEILING floor
    # (renamed), plus one where an uncertain foreign entry coexists with a certain live activity
    assert sum(1 for n in names if n.endswith("-ruling-74")) == 2
    assert "foreign-uncertain-10-bytes-alone-takes-the-cap-ruling-71" not in names
    assert sum(1 for c in VECTORS if c["inputs"].get("foreign")) == 4   # and ONLY those four
    for c in VECTORS:
        if any(f["uncertain"] for f in c["inputs"].get("foreign", [])):
            assert c["expected"]["charge"] >= c["constants"]["CEILING"], c["name"]
            assert c["expected"]["uncertain"] is True, c["name"]


def test_accounting_vectors_fixture_schema():
    # Contract the Node suite relies on: exact key set at every level (schema in G6-Py's brief).
    assert VECTORS, "fixture must not be empty"
    for case in VECTORS:
        assert set(case) == {"name", "inputs", "constants", "expected"}, case.get("name")
        required = {"root_listable", "ledger_listable", "activities", "rejected_root_ids", "ledger"}
        assert required <= set(case["inputs"]) <= required | {"foreign"}, case["name"]
        assert set(case["constants"]) == {"CEILING", "PER_ACTIVITY_CAP", "RESERVE"}, case["name"]
        assert set(case["expected"]) == {"charge", "uncertain", "corrupt"}, case["name"]
        for a in case["inputs"]["activities"]:
            assert set(a) == {"aid", "on_disk", "uncertain"}, case["name"]
        for e in case["inputs"]["ledger"]:
            assert set(e) == {"aid", "corrupt"} or set(e) == {"aid", "reserved", "granted"}, case["name"]
        for f in case["inputs"].get("foreign", []):          # Ruling 71: optional, default empty
            assert set(f) == {"name", "on_disk", "uncertain"}, case["name"]
            assert not quota.ids.valid_activity_id(f["name"]) and f["name"] != "quota", case["name"]
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
        activities=[quota.ActivityInput(aid="a", on_disk_measured=42, uncertain=False)],
        rejected_root_ids=[], ledger=[],
    )
    snap = quota._compute_snapshot(inputs)
    assert snap == quota.Snapshot(charge=42, uncertain=False, corrupt=False)


def test_corrupt_ledger_entry_adds_its_measured_on_disk_bytes_plus_the_cap():
    # Ruling 62 (Codex R7-3, IMPORTANT -- REPLACES the Round-6 rule this test used to pin): an
    # aid with BOTH a real, measured activity directory AND a corrupt ledger entry must now
    # contribute measured_on_disk + PER_ACTIVITY_CAP -- committed bytes are authoritative and must
    # never be discarded, even when that aid's ledger entry is corrupt (this assumption CHANGED
    # under R7-3; the Round-6 rule excluded a corrupt aid's on_disk term entirely).
    inputs = quota.AccountingInputs(
        root_listable=True, ledger_listable=True,
        activities=[quota.ActivityInput(aid="x", on_disk_measured=999999, uncertain=False)],
        rejected_root_ids=[],
        ledger=[quota.LedgerInput(aid="x", corrupt=True)],
    )
    snap = quota._compute_snapshot(inputs)
    assert snap.charge == 999999 + quota.PER_ACTIVITY_CAP
    assert snap.corrupt is True
    assert snap.uncertain is False
