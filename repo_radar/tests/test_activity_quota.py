import json, os
import pytest
from repo_radar.activity import quota, paths, lease, ids

def _mk(tmp_path, aid):
    d = paths.activity_dir(tmp_path, aid); paths.secure_mkdir(d)
    paths.secure_mkdir(paths.quota_dir(tmp_path))
    return paths.owner_lock_path(tmp_path, aid)

def _new_activity(tmp_path):
    aid = ids.mint_activity_id(); lp = _mk(tmp_path, aid)
    return aid, lease.acquire(lp)

def _write_rec(home, aid, **rec):   # a durable VALID v1 record, as the writer would leave it
    rec.setdefault("schema_version", 1); rec.setdefault("activity_id", aid)
    rec.setdefault("ts", "2026-08-14T00:00:00-07:00")   # valid ISO-8601 with offset (Round-6 #2)
    seg = paths.segment_path(home, aid, "python", "deadbeef")
    fd = paths.secure_open_append(seg)
    os.write(fd, (json.dumps(rec) + "\n").encode()); os.close(fd)

def _write_start(home, aid):
    _write_rec(home, aid, type="start", seq=0, kind="sync", channel="stable",
               trigger="cli", created_by="python")

def _write_terminal(home, aid, outcome="succeeded"):
    _write_rec(home, aid, type="terminal", seq=9, outcome=outcome, summary={}, by="deadbeef")

def test_admit_writes_json_entry_and_settle_removes_it(tmp_path):
    aid, l = _new_activity(tmp_path)
    assert quota.admit(tmp_path, aid, l) is True
    import json
    assert json.loads(paths.ledger_entry_path(tmp_path, aid).read_text()) == {"reserved": quota.RESERVE, "granted": 0}
    quota.settle(tmp_path, aid)
    assert not paths.ledger_entry_path(tmp_path, aid).exists()

def test_grant_enforces_both_per_activity_cap_and_global_ceiling(tmp_path):
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l)
    assert quota.grant(tmp_path, aid, quota.ORDINARY_CAP) is True          # fills ordinary cap
    assert quota.grant(tmp_path, aid, 1) is False                         # per-activity cap hit
    import json
    assert json.loads(paths.ledger_entry_path(tmp_path, aid).read_text())["granted"] == quota.ORDINARY_CAP

def test_reconcile_synthesizes_and_settles_crashed_started_run(tmp_path):
    # finding 1: durable start, lease freed, NO terminal -> synthesize interrupted + settle
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l); _write_start(tmp_path, aid)
    l.release()                                  # crash after start, before terminal
    quota.reconcile(tmp_path)
    assert not paths.ledger_entry_path(tmp_path, aid).exists()          # settled (no leak)
    types = quota._top_types(tmp_path, aid)
    assert "terminal" in types                                          # synthetic terminal written

def test_reconcile_releases_abandoned_pre_start_when_lease_free(tmp_path):
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l)                # reserved, NO start (nothing to synthesize)
    l.release()
    quota.reconcile(tmp_path)
    assert not paths.ledger_entry_path(tmp_path, aid).exists()

def test_reconcile_preserves_pre_start_when_lease_held(tmp_path):
    aid, l = _new_activity(tmp_path)             # reserve-before-start, lease HELD
    quota.admit(tmp_path, aid, l)
    quota.reconcile(tmp_path)
    assert paths.ledger_entry_path(tmp_path, aid).exists()

def test_reconcile_settles_durable_terminal_when_lease_free(tmp_path):
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l); _write_start(tmp_path, aid); _write_terminal(tmp_path, aid)
    l.release()
    quota.reconcile(tmp_path)
    assert not paths.ledger_entry_path(tmp_path, aid).exists()   # settled

def test_admit_reconciles_before_charging(tmp_path, monkeypatch):
    # a crashed run's stale reservation must be reclaimed by admit's pre-charge reconcile
    dead, dl = _new_activity(tmp_path)
    quota.admit(tmp_path, dead, dl); _write_start(tmp_path, dead); dl.release()   # crashed
    monkeypatch.setattr(quota, "CEILING", 2 * quota.RESERVE + 4096)   # only room for ~1 live
    fresh, fl = _new_activity(tmp_path)
    assert quota.admit(tmp_path, fresh, fl) is True   # succeeds because dead entry was reconciled

def test_top_type_uses_parsed_top_level_not_substring(tmp_path):
    # a start record whose fields nest type:"terminal" must NOT count as a terminal (finding 1)
    aid, l = _new_activity(tmp_path)
    _write_rec(tmp_path, aid, type="start", seq=0, kind="sync", channel="stable",
               trigger="cli", created_by="python", fields={"type": "terminal"})
    assert quota._has_start(tmp_path, aid) and not quota._has_terminal(tmp_path, aid)

def test_unsupported_schema_terminal_does_not_count(tmp_path):
    aid, l = _new_activity(tmp_path)
    _write_rec(tmp_path, aid, schema_version=999, type="terminal", seq=9,
               outcome="succeeded", summary={}, by="x")             # unsupported schema
    assert not quota._has_terminal(tmp_path, aid)                    # never interpreted as v1

def test_foreign_activity_terminal_does_not_count(tmp_path):
    aid, l = _new_activity(tmp_path)
    _write_rec(tmp_path, aid, activity_id=ids.mint_activity_id(), type="terminal", seq=9,
               outcome="succeeded", summary={}, by="x")             # wrong activity_id
    assert not quota._has_terminal(tmp_path, aid)                    # not THIS activity's terminal

def test_impossible_ledger_counters_are_corrupt(tmp_path):
    aid, l = _new_activity(tmp_path)
    paths.secure_mkdir(paths.quota_dir(tmp_path))
    p = paths.ledger_entry_path(tmp_path, aid)
    p.write_text(json.dumps({"reserved": 0, "granted": 0}))          # reserved must equal RESERVE
    assert quota._read_entry(p) == "CORRUPT"
    p.write_text(json.dumps({"reserved": quota.RESERVE, "granted": quota.PER_ACTIVITY_CAP}))  # over cap
    assert quota._read_entry(p) == "CORRUPT"

def test_prune_removes_owner_lock_and_whole_directory(tmp_path):
    aid, l = _new_activity(tmp_path); quota.admit(tmp_path, aid, l)
    _write_start(tmp_path, aid); _write_terminal(tmp_path, aid); quota.settle(tmp_path, aid)
    assert paths.owner_lock_path(tmp_path, aid).exists()
    quota.prune(tmp_path, need_bytes=10_000_000)
    assert not paths.activity_dir(tmp_path, aid).exists()            # dir fully gone (no accumulation)

def test_grant_durability_failure_refuses(tmp_path, monkeypatch):
    # Round-4 #1: if the ledger can't be fsync'd durable, grant returns False so no append happens
    aid, l = _new_activity(tmp_path); quota.admit(tmp_path, aid, l)
    monkeypatch.setattr(quota.os, "fsync", lambda fd: (_ for _ in ()).throw(OSError("no fsync")))
    assert quota.grant(tmp_path, aid, 100) is False

def test_write_entry_handles_short_write(tmp_path, monkeypatch):
    # Round-5 #1: the full-write loop tolerates a partial os.write without a corrupt ledger
    aid, l = _new_activity(tmp_path)
    real = quota.os.write; n = {"i": 0}
    def short(fd, data):
        n["i"] += 1
        return real(fd, data[:1]) if n["i"] == 1 else real(fd, data)   # first write is partial
    monkeypatch.setattr(quota.os, "write", short)
    assert quota.admit(tmp_path, aid, l) is True
    e = quota._read_entry(paths.ledger_entry_path(tmp_path, aid))
    assert e != "CORRUPT" and e["reserved"] == quota.RESERVE            # full-write loop completed

def test_admit_refuses_when_quota_component_swapped(tmp_path):
    # Round-5 #1: a swapped quota/ component must make admit refuse (never operate through it)
    import shutil
    aid, l = _new_activity(tmp_path)
    qd = paths.quota_dir(tmp_path); shutil.rmtree(qd)
    outside = tmp_path / "evil"; outside.mkdir()
    os.symlink(outside, qd)                        # quota/ replaced with a symlink
    assert quota.admit(tmp_path, aid, l) is False  # refuses (UnsafePath -> best-effort False)

def test_concurrent_admissions_never_exceed_ceiling(tmp_path, monkeypatch):
    import threading
    monkeypatch.setattr(quota, "CEILING", 5 * quota.RESERVE + 4096)   # room for ~5 reservations
    results = []
    def worker():
        aid, l = _new_activity(tmp_path)
        results.append(quota.admit(tmp_path, aid, l))
    ts = [threading.Thread(target=worker) for _ in range(20)]
    [t.start() for t in ts]; [t.join() for t in ts]
    assert quota._charge(tmp_path) <= quota.CEILING          # invariant holds under contention
    assert sum(1 for r in results if r) <= 5                 # only what fits was admitted

def test_prune_frees_settled_items_ceiling_override(tmp_path):
    # two settled routine items + one settled problem item; prune must free routine first,
    # keep the problem, and never touch a running item
    for _ in range(2):
        aid, l = _new_activity(tmp_path); quota.admit(tmp_path, aid, l)
        _write_start(tmp_path, aid); _write_terminal(tmp_path, aid); quota.settle(tmp_path, aid)
    prob, lp = _new_activity(tmp_path); quota.admit(tmp_path, prob, lp)
    _write_start(tmp_path, prob); _write_terminal(tmp_path, prob, outcome="failed")
    quota.settle(tmp_path, prob)
    freed = quota.prune(tmp_path, need_bytes=10)
    assert freed > 0
    assert paths.activity_dir(tmp_path, prob).exists()   # newest problem preserved

def test_corrupt_entry_charges_full_4mib_and_blocks_admission(tmp_path, monkeypatch):
    aid, l = _new_activity(tmp_path)
    paths.ledger_entry_path(tmp_path, aid).write_text("{not valid json")   # torn entry
    aid2, l2 = _new_activity(tmp_path)
    monkeypatch.setattr(quota, "CEILING", quota.PER_ACTIVITY_CAP + 1024)   # near ceiling
    assert quota.admit(tmp_path, aid2, l2) is False   # 4 MiB corrupt liability blocks it

def test_write_and_unlink_entry_reject_malicious_activity_id(tmp_path):
    # fix round 1, Critical, unit-level: prove the guard itself fires BEFORE any filename is
    # built, independent of any other quirk in how _write_entry's tmp-file name happens to be
    # constructed (a `../`-prefixed id already fails there for an UNRELATED reason — its `.`
    # prefix mangles the traversal into a nonexistent literal path component — so a higher-level
    # admit()-only test could pass even if this guard were removed; this test cannot).
    paths.secure_mkdir(paths.quota_dir(tmp_path))
    for bad in ("../../evil", "/abs/evil", "..", "a/b", "id\nwith\nnewline", ""):
        with pytest.raises(paths.UnsafePath):
            quota._write_entry(tmp_path, bad, quota.RESERVE, 0)
        with pytest.raises(paths.UnsafePath):
            quota._unlink_entry(tmp_path, bad)

def test_settle_rejects_traversal_activity_id(tmp_path):
    # fix round 1, Critical: activity_id becomes a raw filename in _unlink_entry; dir_fd is
    # IGNORED for an absolute name and `../` escapes the quota dir, so a malicious id must be
    # rejected before any filename is built. Prove settle() can no longer delete a file outside
    # the owned tree, for both a `../`-traversal id and an absolute-path id.
    import tempfile
    with tempfile.TemporaryDirectory() as canary_dir:
        canary = os.path.join(canary_dir, "evil.json")
        with open(canary, "w") as f:
            f.write("do not delete me")

        quota_dir = paths.quota_dir(tmp_path)
        rel = os.path.relpath(canary, quota_dir)          # e.g. "../../../../../tmp/xyz/evil.json"
        traversal_id = rel[: -len(".json")]                # _unlink_entry appends ".json" itself
        quota.settle(tmp_path, traversal_id)               # must no-op: never raise, never delete
        with open(canary) as f:
            assert f.read() == "do not delete me"          # canary survives the traversal id

        abs_id = canary[: -len(".json")]                   # dir_fd is IGNORED for an absolute name
        quota.settle(tmp_path, abs_id)
        with open(canary) as f:
            assert f.read() == "do not delete me"          # canary survives the absolute-path id

def test_admit_rejects_traversal_activity_id(tmp_path):
    # fix round 1, Critical: same guard, exercised via the public admit() entrypoint — a
    # malicious activity_id must fail admission closed rather than writing outside the quota dir.
    aid, l = _new_activity(tmp_path)
    assert quota.admit(tmp_path, "../../evil", l) is False
    assert not list(tmp_path.rglob("evil.json"))            # nothing escaped the owned tree
    assert not (tmp_path.parent / "evil.json").exists()
