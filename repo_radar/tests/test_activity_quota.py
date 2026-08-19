import json, os
import pytest
from repo_radar.activity import quota, paths, lease, ids, writer
from repo_radar.activity import reconcile as reconcile_mod

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

# --- Codex gate round 1, Finding 1 (BLOCKER): terminal durability must precede settlement ----

def test_reconcile_does_not_settle_when_terminal_segment_fsync_fails(tmp_path, monkeypatch):
    # The writer's OWN terminal fsync can fail (line WRITTEN, not durable) -- terminal()
    # correctly does not settle then (ledger retained), but it DOES release the lease
    # unconditionally. The NEXT reconcile sees "terminal exists" (parsed off the on-disk line,
    # which is readable even though never fsync'd) and, pre-fix, settles immediately without
    # ever trying to durabilize it -- a power loss right after that settlement but before the OS
    # flushes the terminal would lose BOTH the terminal and the ledger, leaving nothing to
    # trigger recovery. reconcile must fsync the terminal-bearing segment itself BEFORE
    # settling, and must NOT settle when that fsync fails.
    w = writer.ActivityWriter(tmp_path, kind="sync", channel="stable",
                              trigger="cli", producer="python")
    aid = w.activity_id
    w.start()
    monkeypatch.setattr(writer.os, "fsync", lambda fd: (_ for _ in ()).throw(OSError("no fsync")))
    w.terminal("succeeded", repos_changed=0, errors=0, warns=0)   # line written, fsync fails
    monkeypatch.undo()
    assert paths.ledger_entry_path(tmp_path, aid).exists()        # writer correctly retained it

    # simulate reconcile running while the segment still cannot be made durable (e.g. the same
    # transient fsync failure persists into the reconcile pass)
    monkeypatch.setattr(paths.os, "fsync", lambda fd: (_ for _ in ()).throw(OSError("still failing")))
    quota.reconcile(tmp_path)
    monkeypatch.undo()
    assert paths.ledger_entry_path(tmp_path, aid).exists()        # MUST remain: fsync failed, no settle

def test_reconcile_settles_terminal_once_fsync_recovers(tmp_path, monkeypatch):
    # happy-path companion to the test above: once the segment CAN be made durable, a later
    # reconcile pass (using the real fsync) settles normally.
    w = writer.ActivityWriter(tmp_path, kind="sync", channel="stable",
                              trigger="cli", producer="python")
    aid = w.activity_id
    w.start()
    monkeypatch.setattr(writer.os, "fsync", lambda fd: (_ for _ in ()).throw(OSError("no fsync")))
    w.terminal("succeeded", repos_changed=0, errors=0, warns=0)
    monkeypatch.undo()
    assert paths.ledger_entry_path(tmp_path, aid).exists()
    quota.reconcile(tmp_path)                                     # real fsync now succeeds -> durable
    assert not paths.ledger_entry_path(tmp_path, aid).exists()    # settled

# --- Codex gate round 1, Finding 2 (BLOCKER): unsafe/unreadable ledgers charge fail-closed ---

def test_symlinked_ledger_entry_charges_corrupt_and_blocks_admission(tmp_path, monkeypatch):
    # a valid-UUID-named ledger that is actually a SYMLINK must be CLASSIFIED (never silently
    # skipped out of the enumeration) as CORRUPT -> full PER_ACTIVITY_CAP liability, not 0.
    # Codex fix-review B2: uses a REAL, HELD owner.lock (owner provably still around) so this
    # stays a pure detection/charging test -- an owner.lock that was never created at all now
    # correctly clears via the owner-gone reconcile path (spec line 78/§7), which is orthogonal
    # to what this test is proving.
    aid, l = _new_activity(tmp_path)
    outside = tmp_path / "outside.json"
    outside.write_text(json.dumps({"reserved": quota.RESERVE, "granted": 0}))
    os.symlink(outside, paths.ledger_entry_path(tmp_path, aid))
    entries = dict(quota._ledger_entries(tmp_path))
    assert entries[aid] == "CORRUPT"                    # classified, not silently dropped
    aid2, l2 = _new_activity(tmp_path)
    monkeypatch.setattr(quota, "CEILING", quota.PER_ACTIVITY_CAP + 1024)   # near ceiling
    assert quota.admit(tmp_path, aid2, l2) is False      # 4 MiB corrupt liability blocks it

def test_fifo_ledger_entry_charges_corrupt_and_blocks_admission(tmp_path, monkeypatch):
    # Codex fix-review B2: real, HELD owner.lock -- see comment above.
    aid, l = _new_activity(tmp_path)
    os.mkfifo(paths.ledger_entry_path(tmp_path, aid))
    entries = dict(quota._ledger_entries(tmp_path))
    assert entries[aid] == "CORRUPT"
    aid2, l2 = _new_activity(tmp_path)
    monkeypatch.setattr(quota, "CEILING", quota.PER_ACTIVITY_CAP + 1024)
    assert quota.admit(tmp_path, aid2, l2) is False

def test_directory_ledger_entry_charges_corrupt_and_blocks_admission(tmp_path, monkeypatch):
    # Codex fix-review B2: real, HELD owner.lock -- see comment above.
    aid, l = _new_activity(tmp_path)
    os.mkdir(paths.ledger_entry_path(tmp_path, aid))
    entries = dict(quota._ledger_entries(tmp_path))
    assert entries[aid] == "CORRUPT"
    aid2, l2 = _new_activity(tmp_path)
    monkeypatch.setattr(quota, "CEILING", quota.PER_ACTIVITY_CAP + 1024)
    assert quota.admit(tmp_path, aid2, l2) is False

def test_well_formed_ledger_entry_still_counts_real_reserved_granted(tmp_path):
    # positive control: a SAFE ledger must still be classified normally (not swept into CORRUPT)
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l)
    quota.grant(tmp_path, aid, 100)
    entries = dict(quota._ledger_entries(tmp_path))
    assert entries[aid] == {"reserved": quota.RESERVE, "granted": 100}

# --- Codex gate round 1, Finding 7 (IMPORTANT): quota size-accounting must use fstat
# metadata, not content reads ------------------------------------------------------------------

def test_grant_does_not_read_segment_contents_only_fstat_sizes(tmp_path, monkeypatch):
    # _committed/_on_disk previously read FULL segment CONTENTS just to sum sizes; at the
    # 64 MiB ceiling every ordinary grant() could reread ~64 MiB while holding quota.lock and
    # excluding all other producers. They must use fstat-only sizing instead.
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l)
    _write_start(tmp_path, aid)
    big = paths.segment_path(tmp_path, aid, "python", "cafebabe")   # a large extra segment
    with open(big, "wb") as f:
        f.write(b"x" * (1024 * 1024))
    def boom(*a, **k):
        raise AssertionError("grant must not read segment CONTENTS for size accounting")
    monkeypatch.setattr(paths, "read_owned_segments", boom)
    assert quota.grant(tmp_path, aid, 100) is True       # must succeed using fstat-only sizing

def test_on_disk_and_committed_sizes_match_real_bytes_across_matrix(tmp_path):
    # accounting correctness: fstat-summed sizes must equal the real byte totals.
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l)
    _write_start(tmp_path, aid)
    extra = paths.segment_path(tmp_path, aid, "python", "cafebabe")
    with open(extra, "wb") as f:
        f.write(b"y" * 12345)
    real_total = sum(f.stat().st_size for f in paths.activity_dir(tmp_path, aid).glob("*.jsonl"))
    assert quota._on_disk(tmp_path, aid) == real_total
    assert quota._committed(tmp_path) == real_total     # only activity dir present besides quota/

def test_reconcile_retains_ledger_when_synthesize_terminal_fsync_fails(tmp_path, monkeypatch):
    # finding 1, point 2: reconcile.synthesize_terminal (used for a provably-dead started
    # activity with no terminal at all) must fsync its OWN synthetic terminal durably BEFORE
    # the caller settles; on fsync failure the ledger must be retained for a future pass.
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l); _write_start(tmp_path, aid)
    l.release()                                     # crash after start, before any terminal
    monkeypatch.setattr(reconcile_mod.os, "fsync", lambda fd: (_ for _ in ()).throw(OSError("no fsync")))
    quota.reconcile(tmp_path)
    assert paths.ledger_entry_path(tmp_path, aid).exists()   # retained: synthetic terminal not durable

# --- Codex fix-review B2 (BLOCKER): corrupt-ledger fail-closed state machine ------------------
# All four tests use the REAL 64 MiB CEILING (no monkeypatch) -- a lowered ceiling was the prior
# round's weakness (Codex called it a "ceiling artifact" that couldn't prove unconditional
# refusal, only capacity exhaustion).

def test_held_corrupt_refuses_admit_and_grant_at_real_ceiling(tmp_path):
    # Gap 1 (spec §7): a corrupt entry whose owner.lock is HELD can never clear via evidence, so
    # spec requires unconditional refusal of new admissions AND grants while it stands -- not
    # merely "until capacity runs out". Total charge here is far below 64 MiB.
    live, ll = _new_activity(tmp_path)
    assert quota.admit(tmp_path, live, ll) is True         # a legitimate live activity, pre-corrupt

    held, hl = _new_activity(tmp_path)                     # owner.lock HELD (never released below)
    paths.ledger_entry_path(tmp_path, held).write_text("{not valid json")   # torn/corrupt entry

    fresh, fl = _new_activity(tmp_path)
    try:
        assert quota.admit(tmp_path, fresh, fl) is False    # refused: corrupt entry stands
        assert quota.grant(tmp_path, live, 100) is False    # grants refused too, unrelated activity
    finally:
        hl.release()

def test_corrupt_entry_with_no_owner_lock_clears_via_owner_gone_path(tmp_path):
    # Gap 2b (spec line 78): owner.lock NEVER CREATED (no activity dir at all) => owner provably
    # gone => the corrupt entry must clear on reconcile, not be preserved forever.
    aid = ids.mint_activity_id()
    paths.secure_mkdir(paths.quota_dir(tmp_path))          # quota/ exists; NO activity dir for aid
    paths.ledger_entry_path(tmp_path, aid).write_text("{not valid json")

    quota.reconcile(tmp_path)
    assert not paths.ledger_entry_path(tmp_path, aid).exists()   # cleared: owner never existed

    fresh, fl = _new_activity(tmp_path)
    assert quota.admit(tmp_path, fresh, fl) is True         # admissions resume once corrupt is gone

def test_directory_ledger_cleanup_is_contained_and_fail_closed(tmp_path):
    # Gap 2a: a corrupt <uuid>.json LEDGER that is a DIRECTORY must never let os.unlink's
    # IsADirectoryError/PermissionError escape and break an UNRELATED admission's reconcile pass.
    # Both entries have a REAL owner.lock that is present but FREE (reserve-before-start
    # abandoned before any start was written) so the no-start reconcile branch actually reaches
    # _unlink_entry -- the exact call that raises pre-fix (an absent owner.lock would short-
    # circuit via lease_mod.acquire returning None and never call _unlink_entry at all). An EMPTY
    # dir-ledger can be safely rmdir'd and clears; a NON-empty one is left in place (fail-closed)
    # rather than mistaken for cleared.
    empty_aid, el = _new_activity(tmp_path)
    el.release()                                             # owner.lock exists, now FREE
    os.mkdir(paths.ledger_entry_path(tmp_path, empty_aid))   # empty dir-ledger

    nonempty_aid, nl = _new_activity(tmp_path)
    nl.release()
    os.mkdir(paths.ledger_entry_path(tmp_path, nonempty_aid))
    (paths.ledger_entry_path(tmp_path, nonempty_aid) / "stray").write_text("x")   # non-empty

    other, ol = _new_activity(tmp_path)
    assert quota.admit(tmp_path, other, ol) is False        # must not raise; non-empty still corrupt

    entries = dict(quota._ledger_entries(tmp_path))
    assert empty_aid not in entries                          # empty dir-ledger rmdir'd -- cleared
    assert entries.get(nonempty_aid) == "CORRUPT"             # non-empty left in place -- fail-closed
    assert quota._has_corrupt(tmp_path) is True
    assert quota.admit(tmp_path, other, ol) is False          # still refused, not mistaken for success

def test_cleared_directory_ledger_resumes_admission_at_real_ceiling(tmp_path):
    # Gap 2a + Gap 1 together: once the ONLY corrupt entry (an empty dir-ledger whose owner.lock
    # is present but FREE) is reconciled away via the fixed _unlink_entry, charge is trustworthy
    # again and an unrelated admit at the REAL 64 MiB ceiling succeeds -- proving "cleared =>
    # resume", not "stays refused forever" and not "crashes the reconcile pass".
    stale_aid, sl = _new_activity(tmp_path)
    sl.release()                                              # owner.lock present, FREE
    os.mkdir(paths.ledger_entry_path(tmp_path, stale_aid))   # empty dir-ledger

    quota.reconcile(tmp_path)
    assert not paths.ledger_entry_path(tmp_path, stale_aid).exists()   # cleared

    fresh, fl = _new_activity(tmp_path)
    assert quota.admit(tmp_path, fresh, fl) is True          # charge trustworthy again -> resumes
