import base64, errno, json, os, pathlib, shutil, time
import pytest
from repo_radar.activity import quota, paths, lease, ids, writer, prune
from repo_radar.activity import reconcile as reconcile_mod

LEDGER_VECTORS = json.loads(
    (pathlib.Path(__file__).parent / "data" / "ledger_vectors.json").read_text())

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

# --- Codex fix-review round 2 (BLOCKER): _charge must not undercount a concurrent append
# landing mid-scan -----------------------------------------------------------------------------
#
# Writers get their grant under quota.lock, RELEASE the lock, THEN append -- so a real append can
# land concurrently with a later _charge() call. The pre-fix _charge scanned _committed() (every
# activity's bytes) and then separately re-scanned one activity's bytes via _on_disk() -- two
# scans of the SAME activity at two DIFFERENT times. An append landing between them was excluded
# from `committed` (scanned before) AND netted out of `outstanding` via the now-larger _on_disk
# read (scanned after) -- a double-miss undercount. These tests reproduce that interleaving
# deterministically by hooking `paths.stat_owned_segments_detailed` (the ONLY primitive _charge
# uses for sizing as of Ruling 45 -- R4-1's fail-closed-accounting fix moved _charge from the
# `[(name, size)]`-only `stat_owned_segments` onto the `(entries, uncertain)` detailed form so it
# can also detect an unmeasurable directory in that SAME single pass; `stat_owned_segments` is now
# a thin wrapper over it, so hooking the detailed primitive is the equivalent, still-single-scan
# interception point) so that the FIRST scan of the target activity's directory performs a REAL
# append immediately afterward -- simulating the concurrent writer -- before returning its
# (pre-append) result. Against the pre-fix two-scan _charge this reproduces the exact undercount;
# against the fixed single-scan _charge there is only one call per activity, so the append is
# either fully counted or fully deferred to the next _charge() call, never split.

def _hook_stat_owned_segments_append_once(monkeypatch, target_dir, do_append):
    real = paths.stat_owned_segments_detailed
    state = {"fired": False}
    def hooked(directory, suffix=".jsonl"):
        result = real(directory, suffix)             # snapshot BEFORE the simulated append
        if not state["fired"] and str(directory) == str(target_dir):
            state["fired"] = True
            do_append()                               # concurrent writer's append lands NOW
        return result
    monkeypatch.setattr(paths, "stat_owned_segments_detailed", hooked)
    return state

def test_charge_does_not_undercount_ordinary_append_landing_mid_scan(tmp_path, monkeypatch):
    # Codex R2 repro shape (Python, ordinary append): charged 61940 vs true 62120 (undercount
    # 180). Reproduces the exact _committed()/_on_disk() double-scan interleaving deterministically.
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l)
    assert quota.grant(tmp_path, aid, 2000) is True          # headroom for the "concurrent" append

    seg = paths.segment_path(tmp_path, aid, "python", "cafebabe")
    appended = {"n": 0}
    def do_append():
        rec = json.dumps({"schema_version": 1, "activity_id": aid, "type": "event", "seq": 1,
                           "ts": "2026-08-14T00:00:00-07:00", "level": "info",
                           "event": "concurrent-append"}) + "\n"
        fd = paths.secure_open_append(seg)
        os.write(fd, rec.encode()); os.close(fd)
        appended["n"] = len(rec.encode())

    state = _hook_stat_owned_segments_append_once(monkeypatch, paths.activity_dir(tmp_path, aid), do_append)
    charge = quota._charge(tmp_path)
    monkeypatch.undo()

    assert state["fired"] and appended["n"] > 0, "the interleaving hook must actually have fired"
    true_committed = quota._committed(tmp_path)               # fresh rescan, real function restored
    assert charge >= true_committed, \
        f"_charge undercounted a mid-scan append: charged {charge} < true committed {true_committed}"
    assert charge >= quota.RESERVE + 2000, \
        f"_charge undercounted vs the entry's own reservation ceiling: charged {charge} < {quota.RESERVE + 2000}"

def test_charge_does_not_undercount_terminal_append_landing_mid_scan(tmp_path, monkeypatch):
    # Cross-language pair with Node's terminal repro (charged 498 vs committed 687). Python's
    # _charge has no terminal-visibility shortcut (that second undercount path is Node-only), so
    # this exercises the same single-scan fix with a terminal-shaped append instead of an
    # ordinary one, proving the fix is agnostic to record type.
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l)
    assert quota.grant(tmp_path, aid, 2000) is True

    seg = paths.segment_path(tmp_path, aid, "python", "deadbeef")
    appended = {"n": 0}
    def do_append():
        rec = json.dumps({"schema_version": 1, "activity_id": aid, "type": "terminal", "seq": 9,
                           "ts": "2026-08-14T00:00:00-07:00", "outcome": "succeeded",
                           "summary": {}, "by": "deadbeef"}) + "\n"
        fd = paths.secure_open_append(seg)
        os.write(fd, rec.encode()); os.close(fd)
        appended["n"] = len(rec.encode())

    state = _hook_stat_owned_segments_append_once(monkeypatch, paths.activity_dir(tmp_path, aid), do_append)
    charge = quota._charge(tmp_path)
    monkeypatch.undo()

    assert state["fired"] and appended["n"] > 0
    assert quota._has_terminal(tmp_path, aid) is True          # the terminal really landed
    true_committed = quota._committed(tmp_path)
    assert charge >= true_committed, \
        f"_charge undercounted a mid-scan terminal append: charged {charge} < true committed {true_committed}"
    assert charge >= quota.RESERVE + 2000, \
        f"_charge undercounted vs the entry's own reservation ceiling: charged {charge} < {quota.RESERVE + 2000}"

# --- R5-1 / Ruling 49 (Codex, BLOCKER): a root-level lstat failure must never vanish an activity
# from the ceiling -------------------------------------------------------------------------------

def test_root_enumeration_stat_failure_does_not_vanish_from_the_ceiling(tmp_path, monkeypatch):
    """`paths.list_owned_subdirs` (pre-fix) silently dropped a UUID-shaped root entry whose own
    `lstat` failed with a non-ENOENT error -- so quota's `_committed_detailed`/`_charge` never
    even REACHED `stat_owned_segments_detailed` for it: its bytes vanished from the charge
    entirely, rather than merely being mis-measured. Codex's exact repro: 16 settled x 4 MiB =
    64 MiB; inject EIO on ONE activity's root-lstat -> charge drops to 60 MiB -> a 60 KiB
    reservation is wrongly admitted -> restore -> 67,170,304 bytes, over the hard ceiling. This is
    the root-enumeration counterpart of
    test_unreadable_activity_directory_does_not_vanish_from_the_ceiling (test_activity_scan.py),
    which drives the same repro shape at the per-directory-stat layer (Ruling 45) rather than
    here, at the root-lstat layer (Ruling 49) that feeds it."""
    monkeypatch.setattr(quota, "RESERVE", 60)
    monkeypatch.setattr(quota, "PER_ACTIVITY_CAP", 4096)
    monkeypatch.setattr(quota, "ORDINARY_CAP", 4096 - 60)
    monkeypatch.setattr(quota, "CEILING", 10 ** 9)          # generous ceiling for this one admit

    live_aid, live_lease = _new_activity(tmp_path)
    assert quota.admit(tmp_path, live_aid, live_lease) is True

    settled_aids = []
    for _ in range(16):
        aid = ids.mint_activity_id()
        paths.secure_mkdir(paths.activity_dir(tmp_path, aid))
        paths.segment_path(tmp_path, aid, "python", "deadbeef").write_bytes(b"x" * 4096)
        settled_aids.append(aid)
    broken_aid = settled_aids[0]

    real_charge = 16 * 4096 + quota.RESERVE
    monkeypatch.setattr(quota, "CEILING", real_charge)      # ceiling now EXACTLY full: zero headroom
    assert quota._charge(tmp_path) == real_charge
    assert quota._accounting_uncertain(tmp_path) is False

    real_lstat = paths.os.lstat
    def hooked(name, dir_fd=None):
        if name == broken_aid:
            raise OSError(errno.EIO, "Input/output error")
        return real_lstat(name, dir_fd=dir_fd)
    monkeypatch.setattr(paths.os, "lstat", hooked)
    try:
        assert quota._accounting_uncertain(tmp_path) is True
        charge_after = quota._charge(tmp_path)
        assert charge_after >= quota.CEILING, (
            f"_charge dropped below the ceiling once a root entry's lstat started failing: "
            f"{charge_after} < {quota.CEILING}"
        )
        fresh_aid, fresh_lease = _new_activity(tmp_path)
        assert quota.admit(tmp_path, fresh_aid, fresh_lease) is False   # would wrongly succeed pre-fix
        assert quota.grant(tmp_path, live_aid, 1) is False               # unrelated grant refused too
    finally:
        monkeypatch.setattr(paths.os, "lstat", real_lstat)   # restore before any more scans

    assert quota._accounting_uncertain(tmp_path) is False
    restored_charge = quota._charge(tmp_path)
    assert restored_charge == real_charge                # recomputed to the exact real total
    assert restored_charge <= quota.CEILING

    # accounting is trustworthy again -- with a LITTLE headroom, a fresh admission now succeeds
    monkeypatch.setattr(quota, "CEILING", real_charge + quota.RESERVE)
    fresh_aid2, fresh_lease2 = _new_activity(tmp_path)
    assert quota.admit(tmp_path, fresh_aid2, fresh_lease2) is True

# --- R5-3 / Ruling 50 (Codex, IMPORTANT): admit()/grant() must decide from ONE unified snapshot,
# never `_charge`+`_accounting_uncertain` as two separate scans ---------------------------------

def test_admit_refuses_from_a_single_snapshot_not_two_separate_scans(tmp_path, monkeypatch):
    """Pre-fix, `admit()` called `_accounting_uncertain(home)` and (if that returned False)
    `_charge(home)` as two INDEPENDENT filesystem passes over the same activity directories. A
    directory's measurability could change BETWEEN those two passes, so the `uncertain` verdict
    and the `charge` total could come from two DIFFERENT moments in time -- a max-liability
    fallback baked into `charge` by the second pass with nothing telling the caller the accounting
    had actually gone uncertain by then. This stages exactly that: the hook answers
    `uncertain=True` the FIRST time this activity's directory is measured, `False` any later time.
    The decisive assertion isn't just the refusal (a correct implementation refuses either way
    here) but that it happens from EXACTLY ONE stat call -- proving `admit` never goes on to take
    a SECOND, later reading of the same directory that could disagree with the first.

    Ruling 67 (Round-8 follow-up, "G8b"): `admit`'s locked decision now stats each activity
    directory through the fd-bound `paths.stat_owned_segments_dir_fd_detailed(ctx.afd, name)`
    (never the path-based form, which the unlocked/introspection callers alone still use) -- so
    this hook target legitimately moved from `stat_owned_segments_detailed` to that fd-bound
    counterpart, matched by NAME rather than by directory path."""
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l)
    _write_start(tmp_path, aid); _write_terminal(tmp_path, aid)
    l.release(); quota.settle(tmp_path, aid)          # one settled activity, real bytes on disk

    real = paths.stat_owned_segments_dir_fd_detailed
    calls = {"n": 0}
    def hooked(dfd, name, suffix=".jsonl"):
        entries, _uncertain = real(dfd, name, suffix)
        if name == aid:
            calls["n"] += 1
            return entries, calls["n"] == 1          # True on call #1, False on any later call
        return entries, _uncertain
    monkeypatch.setattr(paths, "stat_owned_segments_dir_fd_detailed", hooked)

    fresh, fl = _new_activity(tmp_path)
    assert quota.admit(tmp_path, fresh, fl) is False   # refused: the single snapshot saw uncertain
    assert calls["n"] == 1, (
        f"admit must decide from exactly ONE stat pass per activity (a single unified snapshot), "
        f"saw {calls['n']} -- a second, later call could observe a DIFFERENT answer than the one "
        f"the refusal was actually based on"
    )

def test_admit_charge_and_uncertain_are_a_matched_pair_from_one_reading(tmp_path, monkeypatch):
    """Complement to the test above, reversed order (False then True): pre-fix, `_accounting_
    uncertain`'s own (first) scan would see the still-False answer and let admission proceed past
    it, while `_charge`'s SEPARATE (second) scan -- landing after the simulated transition -- would
    already see True and silently substitute a PER_ACTIVITY_CAP max-liability guess into the
    charge, with nothing downstream ever learning the accounting had gone uncertain. Fixed code
    takes only ONE reading per activity per decision, so `charge` and `uncertain` are always a
    matched pair -- proven here by the same call-count assertion, independent of hook ordering.

    Ruling 67 (Round-8 follow-up, "G8b"): same hook-target move as the test above -- `admit`'s
    locked decision stats each activity directory through the fd-bound `paths.stat_owned_
    segments_dir_fd_detailed(ctx.afd, name)`, matched by NAME rather than by directory path."""
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l)
    _write_start(tmp_path, aid); _write_terminal(tmp_path, aid)
    l.release(); quota.settle(tmp_path, aid)

    real = paths.stat_owned_segments_dir_fd_detailed
    calls = {"n": 0}
    def hooked(dfd, name, suffix=".jsonl"):
        entries, _uncertain = real(dfd, name, suffix)
        if name == aid:
            calls["n"] += 1
            return entries, calls["n"] > 1           # False on call #1, True on any later call
        return entries, _uncertain
    monkeypatch.setattr(paths, "stat_owned_segments_dir_fd_detailed", hooked)

    fresh, fl = _new_activity(tmp_path)
    admitted = quota.admit(tmp_path, fresh, fl)        # outcome must reflect ONLY the single reading
    assert calls["n"] == 1, (
        f"admit must never take a SECOND, later reading of the same activity's directory within "
        f"one decision -- saw {calls['n']} calls"
    )
    assert admitted is True, \
        "the single reading said uncertain=False with tiny real bytes -- admission should proceed"

# --- R5-4 / Ruling 52 (Codex, IMPORTANT): ledger decoding parity with Node -----------------------
# `data/ledger_vectors.json` is a shared cross-language fixture (a concurrent Node agent drives the
# same file against its own ledger reader); this file only owns the PYTHON half of the contract.

def test_ledger_vectors_fixture_schema():
    assert LEDGER_VECTORS, "fixture must not be empty"
    for case in LEDGER_VECTORS:
        assert set(case) == {"name", "bytes_b64", "expected"}, case["name"]
        assert case["expected"] == "corrupt" or set(case["expected"]) == {"reserved", "granted"}, case["name"]

@pytest.mark.parametrize("case", LEDGER_VECTORS, ids=[c["name"] for c in LEDGER_VECTORS])
def test_ledger_vectors_parse_entry(case):
    data = base64.b64decode(case["bytes_b64"])
    result = quota._parse_entry(data)
    if case["expected"] == "corrupt":
        assert result == "CORRUPT", case["name"]
    else:
        assert result == case["expected"], case["name"]

@pytest.mark.parametrize("case", LEDGER_VECTORS, ids=[c["name"] for c in LEDGER_VECTORS])
def test_ledger_vectors_read_entry_via_tmp_file(tmp_path, case):
    # companion drive through `_read_entry` (a real file on disk, descriptor-relative read) rather
    # than `_parse_entry` directly, proving the decode fix holds through the full read path too.
    aid = ids.mint_activity_id()
    paths.secure_mkdir(paths.quota_dir(tmp_path))
    p = paths.ledger_entry_path(tmp_path, aid)
    p.write_bytes(base64.b64decode(case["bytes_b64"]))
    result = quota._read_entry(p)
    if case["expected"] == "corrupt":
        assert result == "CORRUPT", case["name"]
    else:
        assert result == case["expected"], case["name"]

def test_ledger_vectors_valid_entry_uses_the_real_reserve_constant():
    # sanity: the fixture's one "valid" case must actually match the module's live RESERVE value,
    # not a hardcoded number that could silently drift out of sync with a future RESERVE change.
    valid_cases = [c for c in LEDGER_VECTORS if c["expected"] != "corrupt"]
    assert valid_cases, "fixture must contain at least one accepted case"
    for c in valid_cases:
        assert c["expected"]["reserved"] == quota.RESERVE, c["name"]

# --- Codex R6-1 (BLOCKER) / Ruling 54: a LEDGER-directory listing failure must never collapse to
# "no ledgers" -- charge flattens to the ceiling and admissions/grants refuse outright -----------

def test_ledger_dir_listing_failure_is_uncertain_and_charge_is_the_ceiling(tmp_path, monkeypatch):
    """`paths.list_owned_entries` (pre-fix) collapsed ANY listing failure on the LEDGER dir
    (`quota/`) to `[]` -- indistinguishable from a genuinely empty/never-created one -- so
    `_ledger_entries` silently dropped every live reservation's liability from the charge during a
    transient EIO instead of refusing. `_gather_accounting` must read this as `ledger_listable=
    False` and `_compute_snapshot` must flatten the WHOLE charge to CEILING (not just the ledger's
    own portion), since "how much is reserved right now" becomes entirely unknowable."""
    live, ll = _new_activity(tmp_path)
    assert quota.admit(tmp_path, live, ll) is True     # a real, live reservation in the ledger

    real = paths.list_owned_entries_detailed
    def hooked(directory, suffix=None):
        if str(directory) == str(paths.quota_dir(tmp_path)):
            return [], True                            # simulate paths.py's own EIO verdict
        return real(directory, suffix)
    monkeypatch.setattr(paths, "list_owned_entries_detailed", hooked)

    snap = quota._accounting_snapshot(tmp_path)
    assert snap.uncertain is True
    assert snap.charge == quota.CEILING

def test_ledger_dir_listing_failure_refuses_admit_and_grant(tmp_path, monkeypatch):
    live, ll = _new_activity(tmp_path)
    assert quota.admit(tmp_path, live, ll) is True

    # Ruling 60 (Codex R7-1, BLOCKER): admit()/grant()'s own DECISION snapshot reads the ledger
    # descriptor-relative to `ctx.qfd` (`_ledger_entries_detailed_fd` -> `paths.list_owned_dir_
    # fd_detailed`), never the path-based `list_owned_entries_detailed`. Ruling 64 (Codex R8-1,
    # BLOCKER) then moved `_reconcile_all_locked`'s own pass onto that SAME fd-bound seam too, so
    # there is no longer any path-based ledger listing anywhere in this locked flow -- a single
    # unconditional hook on the fd-bound primitive covers both `_reconcile_all_locked`'s pass and
    # the decision snapshot's own pass.
    monkeypatch.setattr(paths, "list_owned_dir_fd_detailed", lambda dfd, suffix=None: ([], True))

    fresh, fl = _new_activity(tmp_path)
    assert quota.admit(tmp_path, fresh, fl) is False    # refused: ledger dir unmeasurable
    assert quota.grant(tmp_path, live, 1) is False       # unrelated grant refused too

def test_ledger_dir_enoent_charges_from_segments_only_not_uncertain(tmp_path):
    # ENOENT quota dir (no admission has ever happened yet) is a proven "no ledgers" state, not a
    # failure -- charge comes purely from whatever real bytes are already on disk.
    aid = ids.mint_activity_id()
    paths.secure_mkdir(paths.activity_dir(tmp_path, aid))
    paths.segment_path(tmp_path, aid, "python", "deadbeef").write_bytes(b"x" * 4096)
    assert not paths.quota_dir(tmp_path).exists()

    snap = quota._accounting_snapshot(tmp_path)
    assert snap.uncertain is False
    assert snap.corrupt is False
    assert snap.charge == 4096

# --- Codex R6-2 (BLOCKER) / Ruling 55: Snapshot.corrupt comes from the SAME ledger-entries pass
# as charge/uncertain -- never a separate `_has_corrupt()` pre-check ahead of it ------------------

def test_admit_uses_one_ledger_entries_pass_per_decision_snapshot(tmp_path, monkeypatch):
    """Pre-fix, `admit()` called `_has_corrupt()` SEPARATELY, before `_accounting_snapshot()` --
    two INDEPENDENT ledger passes for one decision. A ledger read that flips between those two
    passes let a corrupt entry slip into the actual decision snapshot while the earlier
    `_has_corrupt()` pre-check still saw clean data and passed, silently admitting alongside a
    corrupt entry. `held`'s owner.lock stays HELD (no start ever written) so `_reconcile_all_
    locked`'s own pass over the ledger (an unrelated, expected EARLIER pass -- it settles dead
    owners, not the decision itself) can't clear the entry out from under this test: reconcile
    tries to acquire the lock, finds it busy, and leaves the entry in place.

    Ruling 60 (Codex R7-1, BLOCKER) split what used to be ONE shared function into two
    structurally distinct ones, and Ruling 64 (Codex R8-1, BLOCKER) then moved `_reconcile_all_
    locked` onto the SAME fd-bound seam as the decision snapshot (closing exactly the residual
    Codex R8 flagged: a path-based reconcile pass could re-resolve a swapped `quota/` as "certain
    empty"). So this test's assumption CHANGED: there is no longer a separate path-based ledger
    pass in this flow at all -- `_reconcile_all_locked`'s own pass AND `admit`'s own decision
    snapshot both go through `_ledger_entries_detailed_fd`, proving TWO fd-bound passes (not one
    path-based + one fd-bound) and ZERO path-based passes."""
    held, hl = _new_activity(tmp_path)                      # owner.lock HELD (never released below)
    paths.ledger_entry_path(tmp_path, held).write_text(
        json.dumps({"reserved": quota.RESERVE, "granted": 0}))   # a real, CLEAN ledger entry

    real_path = quota._ledger_entries_detailed
    path_calls = {"n": 0}
    def staged_path(home):
        path_calls["n"] += 1
        return real_path(home)
    monkeypatch.setattr(quota, "_ledger_entries_detailed", staged_path)

    real_fd = quota._ledger_entries_detailed_fd
    fd_calls = {"n": 0}
    def staged_fd(ctx):
        fd_calls["n"] += 1
        entries, uncertain = real_fd(ctx)
        return [(a, "CORRUPT" if a == held else e) for a, e in entries], uncertain   # force CORRUPT
    monkeypatch.setattr(quota, "_ledger_entries_detailed_fd", staged_fd)

    try:
        fresh, fl = _new_activity(tmp_path)
        assert quota.admit(tmp_path, fresh, fl) is False    # refused: the decision snapshot saw corrupt
        assert path_calls["n"] == 0, (
            f"expected NO path-based ledger pass at all any more (Ruling 64 moved reconcile's own "
            f"pass onto the fd-bound seam too), saw {path_calls['n']}"
        )
        assert fd_calls["n"] == 2, (
            f"expected exactly 2 fd-bound ledger passes -- _reconcile_all_locked's own pass, and "
            f"the decision snapshot itself -- saw {fd_calls['n']}"
        )
    finally:
        hl.release()

def test_grant_refuses_when_its_own_decision_snapshot_finds_corrupt(tmp_path, monkeypatch):
    aid, l = _new_activity(tmp_path)
    assert quota.admit(tmp_path, aid, l) is True

    # Ruling 60 (Codex R7-1, BLOCKER): grant()'s decision snapshot reads the ledger fd-bound
    # (`_ledger_entries_detailed_fd`), not the path-based `_ledger_entries_detailed`.
    real = quota._ledger_entries_detailed_fd
    def staged(qfd):
        entries, uncertain = real(qfd)
        return [(a, "CORRUPT" if a == aid else e) for a, e in entries], uncertain
    monkeypatch.setattr(quota, "_ledger_entries_detailed_fd", staged)

    assert quota.grant(tmp_path, aid, 1) is False

# --- Codex R7-1 (BLOCKER) / Ruling 60: a post-lock swap of `quota/` must never be misread by
# admit's/grant's own decision as "no ledgers yet" -- the decision stays bound to the SAME
# `quota/` directory identity `_quota_lock` validated (via `LockCtx.qfd`), never re-resolved by
# path -----------------------------------------------------------------------------------------

def test_admit_decision_refuses_and_writes_nothing_when_quota_dir_fd_listing_fails(tmp_path, monkeypatch):
    """`_quota_lock` validates/opens `quota/` (and creates it via `secure_mkdir`) BEFORE taking
    `flock` -- so pre-fix, if the directory were renamed/swapped AFTER the lock was acquired, a
    fresh PATH-based re-read (`list_owned_entries_detailed(quota_dir)`) could hit ENOENT and
    misread that as "no ledgers yet" (entries=[], uncertain=False), even though real, live ledger
    liabilities exist -- admit would then wrongly admit a reservation over the ceiling (Codex
    repro: 16 x 4 MiB ledger liabilities, rename `quota/` between lock and enumeration -> admit
    wrote a reservation -> 67,170,304 bytes on disk, over the 64 MiB ceiling).

    `_reconcile_all_locked` is stubbed out here (an unrelated, separately-tested pass -- these 16
    stale-looking entries have no owner.lock/lease to protect them from it) to isolate admit's own
    DECISION snapshot. The fd-bound listing that decision now reads through (`ctx.qfd` ->
    `_ledger_entries_detailed_fd` -> `paths.list_owned_dir_fd_detailed`) is forced to come back
    unable to enumerate, simulating the swap. admit must refuse, write NO reservation anywhere
    (neither the fresh activity's own entry nor any of the 16 pre-existing ones), and a snapshot
    taken through that SAME fd while the failure stands must be uncertain."""
    monkeypatch.setattr(quota, "_reconcile_all_locked", lambda home, ctx: None)

    aids = []
    for _ in range(16):
        aid = ids.mint_activity_id(); _mk(tmp_path, aid)
        paths.ledger_entry_path(tmp_path, aid).write_text(
            json.dumps({"reserved": quota.RESERVE, "granted": quota.PER_ACTIVITY_CAP - quota.RESERVE}))
        aids.append(aid)
    before = {aid: paths.ledger_entry_path(tmp_path, aid).read_bytes() for aid in aids}

    calls = {"n": 0}
    def hooked(dfd, suffix=None):
        calls["n"] += 1
        return [], True                 # simulate: the fd-bound listing can no longer enumerate
    monkeypatch.setattr(paths, "list_owned_dir_fd_detailed", hooked)

    # lower-level companion check, taken WHILE the failure stands: a decision snapshot bound to
    # the SAME validated `quota/` fd must be uncertain, never quietly "empty"
    ctx = quota._quota_lock(tmp_path)
    try:
        snap = quota._accounting_snapshot(tmp_path, ctx=ctx)
    finally:
        quota._unlock(ctx)
    assert snap.uncertain is True

    fresh, fl = _new_activity(tmp_path)
    assert quota.admit(tmp_path, fresh, fl) is False
    assert calls["n"] >= 1, "the decision must actually have gone through the fd-bound listing"

    assert not paths.ledger_entry_path(tmp_path, fresh).exists()   # no NEW reservation anywhere
    for aid in aids:
        assert paths.ledger_entry_path(tmp_path, aid).read_bytes() == before[aid]   # nothing else touched

    monkeypatch.undo()   # restore both the reconcile stub and the fd-listing hook
    # a fresh, unhooked snapshot afterwards confirms the real ledger is intact and certain again --
    # the normal path is unchanged by this fix
    real_snap = quota._compute_snapshot(quota._gather_accounting(tmp_path))
    assert real_snap.uncertain is False
    assert real_snap.corrupt is False
    assert real_snap.charge == 16 * quota.PER_ACTIVITY_CAP

def test_admit_normal_path_unchanged_when_quota_dir_is_not_swapped(tmp_path):
    # Sanity companion to the test above: with no swap/failure at all, admit still succeeds
    # normally through the new fd-bound decision path -- the fix must not change ordinary behavior.
    aid, l = _new_activity(tmp_path)
    assert quota.admit(tmp_path, aid, l) is True
    assert json.loads(paths.ledger_entry_path(tmp_path, aid).read_text()) == {
        "reserved": quota.RESERVE, "granted": 0,
    }

# --- Codex R7-2 (BLOCKER) / Ruling 61: pruning under ledger uncertainty must delete NOTHING,
# not sweep every settled candidate against a wrongly-empty live set -----------------------------

def test_prune_locked_refuses_and_deletes_nothing_when_ledger_listing_is_uncertain(tmp_path, monkeypatch):
    """Pre-fix, `_prune_locked`'s live set came from the lossy `_ledger_entries`, which collapses
    an unlistable ledger dir to `[]` -- so every settled activity looked prunable even though the
    true live set (whether anything is actually still reserved) was entirely unproven. A settled,
    routine (prunable-looking) activity must survive when the ledger dir can't be listed.

    Ruling 64 (Codex R8-1, BLOCKER): `_prune_locked` now requires the active `LockCtx` and reads
    its live set through the fd-bound `_ledger_entries_detailed_fd(ctx)` -- so the hook target
    moved from the path-based `paths.list_owned_entries_detailed` to the fd-bound `paths.
    list_owned_dir_fd_detailed` (this test's assumption legitimately changed with the fix)."""
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l)
    _write_start(tmp_path, aid); _write_terminal(tmp_path, aid)
    quota.settle(tmp_path, aid)          # settled, routine -> would normally be prunable

    monkeypatch.setattr(paths, "list_owned_dir_fd_detailed", lambda dfd, suffix=None: ([], True))

    ctx = quota._quota_lock(tmp_path)
    try:
        freed = quota._prune_locked(tmp_path, 10**9, ctx)
    finally:
        quota._unlock(ctx)
    assert freed == 0
    assert paths.activity_dir(tmp_path, aid).exists()   # nothing deleted under uncertainty

def test_retain_locked_refuses_and_deletes_nothing_when_ledger_listing_is_uncertain(tmp_path, monkeypatch):
    # Same guard, via `retain()`'s own live-set read: a routine item that's normally well outside
    # the newest-50/age protections (and so would be pruned) must survive when the ledger listing
    # itself is uncertain.
    #
    # Ruling 64 (Codex R8-1, BLOCKER): `_retain_locked` (and `_reconcile_all_locked`, which
    # `retain()` calls first) now read the ledger through the fd-bound `_ledger_entries_detailed_
    # fd(ctx)` -- so the hook target moved from the path-based `paths.list_owned_entries_detailed`
    # to the fd-bound `paths.list_owned_dir_fd_detailed` (this test's assumption legitimately
    # changed with the fix).
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l)
    _write_start(tmp_path, aid)
    seg = paths.segment_path(tmp_path, aid, "python", "deadbeef")
    _write_terminal(tmp_path, aid)
    l.release(); quota.settle(tmp_path, aid)
    old = time.time() - 999 * 86400
    os.utime(seg, (old, old))                      # backdate well past the 14d routine threshold
    monkeypatch.setattr(quota, "NEWEST_KEEP", 0)   # outside the protected window; would normally prune

    monkeypatch.setattr(paths, "list_owned_dir_fd_detailed", lambda dfd, suffix=None: ([], True))

    pruned = quota.retain(tmp_path)
    assert pruned == []
    assert paths.activity_dir(tmp_path, aid).exists()   # nothing deleted under uncertainty

# --- Codex R8-1 (BLOCKER) / Ruling 64: `qfd` alone survives a rename -- canonical identity must
# be re-verified across the ENTIRE lock lifetime, not just validated once before `flock`. Every
# test below exercises a REAL rename/swap window (never a stubbed "return uncertain") so the
# actual `_verify_canonical` comparison logic is what catches each case, exactly as instructed.

def test_quota_lock_raises_when_quota_dir_renamed_during_flock_wait(tmp_path, monkeypatch):
    """(i): a REAL rename of `quota/` landing during the `flock` WAIT window (injected by
    wrapping `fcntl.flock` to perform the rename, then delegate to the real call) -- the pre-wait
    identity capture can no longer match the post-acquisition re-check -- must make `_quota_lock`
    itself refuse. `admit()` must write NO reservation under either the original or the renamed
    path."""
    aid, l = _new_activity(tmp_path)
    quota_dir = paths.quota_dir(tmp_path)
    moved_dir = tmp_path / "quota.moved"

    real_flock = quota.fcntl.flock
    state = {"done": False}
    def hooked_flock(fd, op):
        if op == quota.fcntl.LOCK_EX and not state["done"]:
            state["done"] = True
            os.rename(quota_dir, moved_dir)          # REAL rename during the wait window
        return real_flock(fd, op)
    monkeypatch.setattr(quota.fcntl, "flock", hooked_flock)

    try:
        assert quota.admit(tmp_path, aid, l) is False
    finally:
        monkeypatch.undo()
        if moved_dir.exists() and not quota_dir.exists():
            os.rename(moved_dir, quota_dir)           # restore for a clean tmp_path teardown

    assert not (quota_dir / f"{aid}.json").exists()
    assert not (moved_dir / f"{aid}.json").exists()

def test_admit_refuses_and_writes_nothing_when_quota_dir_renamed_mid_enumeration(tmp_path, monkeypatch):
    """(ii): a REAL rename landing between the pre- and post-enumeration canonical checks inside
    `_ledger_entries_detailed_fd` (injected by wrapping the fd-bound listing primitive to rename
    the real dir, then delegate to the real call) -- the post-check must independently detect it.
    `admit()` refuses and writes nothing into the moved directory."""
    live, ll = _new_activity(tmp_path)
    assert quota.admit(tmp_path, live, ll) is True   # a real, live reservation already on disk

    quota_dir = paths.quota_dir(tmp_path)
    moved_dir = tmp_path / "quota.moved"

    real_listing = paths.list_owned_dir_fd_detailed
    state = {"done": False}
    def hooked(dfd, suffix=None):
        if not state["done"]:
            state["done"] = True
            os.rename(quota_dir, moved_dir)          # REAL rename mid-enumeration
        return real_listing(dfd, suffix)              # fd-based: still lists the real, detached content

    fresh, fl = _new_activity(tmp_path)
    monkeypatch.setattr(paths, "list_owned_dir_fd_detailed", hooked)
    try:
        assert quota.admit(tmp_path, fresh, fl) is False
    finally:
        monkeypatch.undo()
        if moved_dir.exists() and not quota_dir.exists():
            os.rename(moved_dir, quota_dir)

    assert not (quota_dir / f"{fresh}.json").exists()
    assert not (moved_dir / f"{fresh}.json").exists()

def test_prune_to_ceiling_deletes_nothing_when_quota_dir_swapped_mid_lock(tmp_path, monkeypatch):
    """(iii): Codex's destructive case -- a durable terminal + a still-LIVE ledger entry (the
    owner is done and the terminal is fsync'd durable, but `settle()` was never called). A REAL
    swap of `quota/` for a fresh, empty directory lands while `prune_to_ceiling` holds its lock
    (injected via the shared fd-bound listing primitive its reconcile/snapshot/prune passes all
    go through -- rename the real dir away, then create a fresh empty one at the same path, then
    delegate to the real call). This must make every subsequent read in this locked session
    uncertain -- `prune_to_ceiling` must delete NOTHING and return 0, never mistake the
    swapped-in empty directory for proof the entry is gone."""
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l)
    _write_start(tmp_path, aid); _write_terminal(tmp_path, aid)
    l.release()                                   # owner done, terminal durable -- but NEVER settled

    quota_dir = paths.quota_dir(tmp_path)
    moved_dir = tmp_path / "quota.moved"
    monkeypatch.setattr(quota, "CEILING", 1)       # real pressure to prune, were it not refused

    real_listing = paths.list_owned_dir_fd_detailed
    state = {"done": False}
    def hooked(dfd, suffix=None):
        if not state["done"]:
            state["done"] = True
            os.rename(quota_dir, moved_dir)        # REAL swap: detach the live-entry-bearing dir
            paths.secure_mkdir(quota_dir)           # ...and put a fresh, EMPTY dir at the canonical path
        return real_listing(dfd, suffix)
    monkeypatch.setattr(paths, "list_owned_dir_fd_detailed", hooked)

    try:
        freed = prune.prune_to_ceiling(tmp_path, requested=quota.RESERVE)
    finally:
        monkeypatch.undo()
        if moved_dir.exists():
            if quota_dir.exists():
                for p in quota_dir.iterdir():
                    p.unlink()
                quota_dir.rmdir()
            os.rename(moved_dir, quota_dir)

    assert freed == 0
    assert paths.activity_dir(tmp_path, aid).exists()          # NOTHING deleted
    assert paths.ledger_entry_path(tmp_path, aid).exists()     # the live entry survives, untouched

def test_settle_no_unlink_no_crash_when_quota_dir_swapped_under_the_lock(tmp_path, monkeypatch):
    """(iv): the same real swap technique as (iii), but landing during `settle()`'s own locked
    unlink. `settle()` has no enumeration step to hook, so the swap is injected as a side effect
    of the FIRST real `_verify_canonical` check `_unlink_entry_fd` performs (immediately before
    the unlink) -- the identity-mismatch detection that follows is the SAME real comparison
    logic, not a stub. `settle()` must not unlink anything and must not raise."""
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l)
    _write_start(tmp_path, aid); _write_terminal(tmp_path, aid)
    l.release()                                    # durable terminal, ledger entry still live

    quota_dir = paths.quota_dir(tmp_path)
    moved_dir = tmp_path / "quota.moved"

    real_verify = quota._verify_canonical
    state = {"done": False}
    def hooked(ctx):
        if not state["done"]:
            state["done"] = True
            os.rename(quota_dir, moved_dir)
            paths.secure_mkdir(quota_dir)
        return real_verify(ctx)
    monkeypatch.setattr(quota, "_verify_canonical", hooked)

    try:
        result = quota.settle(tmp_path, aid)        # must not raise
    finally:
        monkeypatch.undo()
        if moved_dir.exists():
            if quota_dir.exists():
                for p in quota_dir.iterdir():
                    p.unlink()
                quota_dir.rmdir()
            os.rename(moved_dir, quota_dir)

    assert result is None                           # settle() is always best-effort, never raises
    assert paths.ledger_entry_path(tmp_path, aid).exists()   # NOT unlinked -- swap caught before unlink

def test_retain_returns_empty_when_quota_dir_swapped_mid_lock(tmp_path, monkeypatch):
    """(v): the same real swap technique as (iii), via `retain()`'s own live-set listing. Must
    refuse the whole pass and return `[]`; nothing prunable is actually deleted."""
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l)
    _write_start(tmp_path, aid); _write_terminal(tmp_path, aid)
    l.release()                                     # durable terminal, ledger entry still live
    monkeypatch.setattr(quota, "NEWEST_KEEP", 0)     # would normally be outside the protected window

    quota_dir = paths.quota_dir(tmp_path)
    moved_dir = tmp_path / "quota.moved"

    real_listing = paths.list_owned_dir_fd_detailed
    state = {"done": False}
    def hooked(dfd, suffix=None):
        if not state["done"]:
            state["done"] = True
            os.rename(quota_dir, moved_dir)
            paths.secure_mkdir(quota_dir)
        return real_listing(dfd, suffix)
    monkeypatch.setattr(paths, "list_owned_dir_fd_detailed", hooked)

    try:
        pruned = quota.retain(tmp_path)
    finally:
        monkeypatch.undo()
        if moved_dir.exists():
            if quota_dir.exists():
                for p in quota_dir.iterdir():
                    p.unlink()
                quota_dir.rmdir()
            os.rename(moved_dir, quota_dir)

    assert pruned == []
    assert paths.activity_dir(tmp_path, aid).exists()
    assert paths.ledger_entry_path(tmp_path, aid).exists()

# --- Ruling 67 (Round-8 follow-up, "G8b"): binding `quota/`'s identity to the lock (Ruling 64)
# left the ACTIVITY ROOT enumeration and every per-activity segment stat performed under the lock
# still re-resolving `activity/` (and each `<aid>/` under it) by PATH -- `_gather_accounting`,
# `_prune_locked`, `_retain_locked`. A root-level swap (rename `activity/` -> `activity.moved/`,
# then a FRESH EMPTY `activity/` created in its place -- which moves `quota/` ALONG WITH the
# renamed-away original, since a rename doesn't touch a directory's contents) left `_verify_
# canonical`'s pre-Ruling-67 checks self-consistent against the now-detached `afd` (a rename
# doesn't invalidate an already-open fd), while the path-based root/per-activity listing silently
# read the swapped-in EMPTY tree -- a certain-empty accounting view under a lock that still looked
# validly held. Every test below exercises a REAL rename/swap window (never a stubbed "return
# uncertain"), matching the style of the Ruling-64 tests above.

def test_admit_refuses_and_writes_nothing_when_activity_root_swapped_mid_enumeration(tmp_path, monkeypatch):
    """A REAL swap of the ACTIVITY ROOT landing between lock acquisition and the root enumeration
    inside `_gather_accounting` (injected by wrapping the fd-bound root-listing primitive `_gather_
    accounting` calls directly -- `paths.list_owned_subdirs_dir_fd_detailed` -- to perform the
    swap, then delegate to the real, still-afd-relative call, which correctly keeps reading the
    REAL, detached tree).

    Pre-Ruling-67 this was UNDETECTABLE: a settled activity sitting just under the real 64 MiB
    ceiling would have measured as 0 committed bytes once the root enumeration silently followed
    the swapped-in empty path, and `admit` would have WRONGLY admitted a fresh reservation --
    written into the STALE (moved-aside) `quota/` -- past the real ceiling, with nothing
    downstream ever learning the accounting had gone uncertain (exactly the undercount-then-
    over-admit pattern every prior Ruling in this lineage closes one layer at a time). The new,
    independent PATH-based root-identity check (`_verify_canonical` comparing a fresh `os.stat
    (root_path)` against what `afd` was originally opened from) is what actually detects this,
    since it re-resolves `root_path` by PATH -- exactly the thing that changed.

    `admit()` must refuse, write NO reservation under either root, and a standalone snapshot taken
    through the SAME swap must be uncertain (never "certain, charge 0")."""
    aid1, l1 = _new_activity(tmp_path)
    quota.admit(tmp_path, aid1, l1)
    _write_start(tmp_path, aid1); _write_terminal(tmp_path, aid1)
    l1.release(); quota.settle(tmp_path, aid1)          # settled: real committed bytes, no ledger entry
    seg = paths.activity_dir(tmp_path, aid1) / "python-deadbeef.jsonl"
    with open(seg, "r+b") as f:
        f.truncate(quota.CEILING - 1000)                # committed bytes just under the real ceiling

    real_snap = quota._compute_snapshot(quota._gather_accounting(tmp_path))
    assert real_snap.uncertain is False and real_snap.corrupt is False
    assert real_snap.charge == quota.CEILING - 1000     # sanity: the REAL charge is near-ceiling

    root_dir = paths.quota_dir(tmp_path).parent
    moved_dir = tmp_path / "activity.moved"
    real_listing = paths.list_owned_subdirs_dir_fd_detailed

    def make_hook():
        state = {"done": False}
        def hooked(dfd):
            if not state["done"]:
                state["done"] = True
                os.rename(root_dir, moved_dir)                    # REAL swap: detach the near-ceiling tree
                paths.secure_mkdir(paths.quota_dir(tmp_path))       # fresh, EMPTY tree at the canonical path
            return real_listing(dfd)
        return hooked

    def restore():
        if moved_dir.exists():
            if root_dir.exists():
                shutil.rmtree(root_dir)
            os.rename(moved_dir, root_dir)

    # (a) lower-level companion, taken WHILE the swap stands: a snapshot bound to the SAME
    # validated activity root must be uncertain, never quietly "certain, charge 0".
    ctx = quota._quota_lock(tmp_path)
    monkeypatch.setattr(paths, "list_owned_subdirs_dir_fd_detailed", make_hook())
    try:
        snap = quota._accounting_snapshot(tmp_path, ctx=ctx)
    finally:
        quota._unlock(ctx)
        monkeypatch.undo()
        restore()
    assert snap.uncertain is True
    assert snap.charge >= quota.CEILING, "an unlistable root floors the charge at the ceiling, never 0"

    # (b) the same repro through the public admit() entrypoint.
    fresh, fl = _new_activity(tmp_path)
    monkeypatch.setattr(paths, "list_owned_subdirs_dir_fd_detailed", make_hook())
    try:
        assert quota.admit(tmp_path, fresh, fl) is False
    finally:
        monkeypatch.undo()
        restore()

    assert not (moved_dir / "quota" / f"{fresh}.json").exists()   # not written to the stale tree either
    assert not paths.ledger_entry_path(tmp_path, fresh).exists()
    assert paths.activity_dir(tmp_path, aid1).exists()
    assert (paths.activity_dir(tmp_path, aid1) / "python-deadbeef.jsonl").stat().st_size == quota.CEILING - 1000

def test_prune_deletes_nothing_when_activity_root_swapped_mid_lock(tmp_path, monkeypatch):
    """The CANDIDATE enumeration `_prune_locked` performs directly (`paths.list_owned_subdirs_
    dir_fd(ctx.afd)`) is root-fd-bound too now, not just the ledger-liability read Ruling 64
    already protected. A REAL root swap landing right as that enumeration call fires (injected by
    wrapping the primitive itself to perform the swap, then delegate to the real, still-afd-
    relative call) must make `_prune_locked` delete NOTHING and return 0 -- via `quota.prune()`,
    the entrypoint that (unlike `prune_to_ceiling`) calls `_prune_locked` DIRECTLY with no
    reconcile/pre-snapshot gate in front of it, so this exercises `_prune_locked`'s OWN
    protections, not an earlier outer refusal.

    A settled, routine activity (`settled_aid`) is deliberately included as a genuine prune
    candidate: `calls["n"] == 1` proves the enumeration primitive really was reached and really
    did find it (via the correctly afd-relative, unaffected-by-the-outer-rename listing) -- so the
    resulting `freed == 0` reflects the locked session refusing to act further once its root
    identity can no longer be vouched for, not merely an empty candidate list. (The classification
    step for that candidate independently re-resolves its directory by PATH -- out of this fix's
    scope, see scan.py -- and would ALSO see nothing at the swapped-in path; `calls["n"] == 1`
    is what isolates this test to the enumeration primitive's own root-fd binding specifically.)

    `live_l` is released only right before `quota.prune()` runs, AFTER `settled_aid` is fully set
    up: `admit()`'s OWN reconcile-before-charge pass (unrelated to this fix) would otherwise
    reconcile away `live_aid`'s durable-terminal-and-lease-free entry the moment `settled_aid` is
    admitted, before the swap is ever reached."""
    live_aid, live_l = _new_activity(tmp_path)
    quota.admit(tmp_path, live_aid, live_l)
    _write_start(tmp_path, live_aid); _write_terminal(tmp_path, live_aid)   # lease kept HELD for now

    settled_aid, settled_l = _new_activity(tmp_path)
    quota.admit(tmp_path, settled_aid, settled_l)
    _write_start(tmp_path, settled_aid); _write_terminal(tmp_path, settled_aid)
    settled_l.release(); quota.settle(tmp_path, settled_aid)   # settled, routine -> a real candidate

    live_l.release()                              # NOW owner done, terminal durable -- but NEVER settled

    root_dir = paths.quota_dir(tmp_path).parent
    moved_dir = tmp_path / "activity.moved"

    real_listing = paths.list_owned_subdirs_dir_fd
    calls = {"n": 0}
    def hooked(dfd):
        calls["n"] += 1
        if calls["n"] == 1:
            os.rename(root_dir, moved_dir)                      # REAL swap: detach the real tree
            paths.secure_mkdir(paths.quota_dir(tmp_path))         # fresh, EMPTY tree at the canonical path
        return real_listing(dfd)
    monkeypatch.setattr(paths, "list_owned_subdirs_dir_fd", hooked)

    try:
        freed = quota.prune(tmp_path, need_bytes=10**9)          # heavy pressure, were it not refused
    finally:
        monkeypatch.undo()
        if moved_dir.exists():
            if root_dir.exists():
                shutil.rmtree(root_dir)
            os.rename(moved_dir, root_dir)

    assert calls["n"] == 1, "the fd-bound enumeration primitive must actually have been reached"
    assert freed == 0
    assert paths.activity_dir(tmp_path, live_aid).exists()
    assert paths.activity_dir(tmp_path, settled_aid).exists()    # NOTHING deleted, even the real candidate
    assert paths.ledger_entry_path(tmp_path, live_aid).exists()

def test_retain_returns_empty_when_activity_root_swapped_mid_lock(tmp_path, monkeypatch):
    """Same technique as the prune test above, via `retain()`'s own candidate enumeration
    (`_retain_locked`'s `paths.list_owned_subdirs_dir_fd(ctx.afd)` calls -- both the pre-deletion
    snapshot and the final diff). `live_aid`'s owner lease is kept HELD (not released) so `retain
    ()`'s own `_reconcile_all_locked` pre-pass -- unrelated to this fix, and unaffected by hooking
    the ROOT-listing primitive rather than the ledger one -- cannot reconcile it away before the
    swap is even reached; the durable-terminal-but-still-live shape is preserved by that, not by
    anything under test here."""
    live_aid, live_l = _new_activity(tmp_path)
    quota.admit(tmp_path, live_aid, live_l)
    _write_start(tmp_path, live_aid); _write_terminal(tmp_path, live_aid)   # lease kept HELD -- never released

    settled_aid, settled_l = _new_activity(tmp_path)
    quota.admit(tmp_path, settled_aid, settled_l)
    _write_start(tmp_path, settled_aid); _write_terminal(tmp_path, settled_aid)
    settled_l.release(); quota.settle(tmp_path, settled_aid)
    old = time.time() - 999 * 86400
    seg = paths.segment_path(tmp_path, settled_aid, "python", "deadbeef")
    os.utime(seg, (old, old))                       # backdate well past the 14d routine threshold
    monkeypatch.setattr(quota, "NEWEST_KEEP", 0)     # outside the protected window; would normally prune

    root_dir = paths.quota_dir(tmp_path).parent
    moved_dir = tmp_path / "activity.moved"

    real_listing = paths.list_owned_subdirs_dir_fd
    calls = {"n": 0}
    def hooked(dfd):
        calls["n"] += 1
        if calls["n"] == 1:
            os.rename(root_dir, moved_dir)
            paths.secure_mkdir(paths.quota_dir(tmp_path))
        return real_listing(dfd)
    monkeypatch.setattr(paths, "list_owned_subdirs_dir_fd", hooked)

    try:
        pruned = quota.retain(tmp_path)
    finally:
        monkeypatch.undo()
        if moved_dir.exists():
            if root_dir.exists():
                shutil.rmtree(root_dir)
            os.rename(moved_dir, root_dir)

    assert calls["n"] >= 1, "the fd-bound enumeration primitive must actually have been reached"
    assert pruned == []
    assert paths.activity_dir(tmp_path, live_aid).exists()
    assert paths.activity_dir(tmp_path, settled_aid).exists()
    assert paths.ledger_entry_path(tmp_path, live_aid).exists()
    live_l.release()

def test_admit_prune_retain_normal_path_unchanged_via_root_fd_binding(tmp_path):
    """(iv): sanity companion to the three swap tests above -- with NO swap at all, `_gather_
    accounting`/`_prune_locked`/`_retain_locked`'s new root-fd-bound enumeration (`ctx.afd` ->
    `paths.list_owned_subdirs_dir_fd[_detailed]`/`stat_owned_segments_dir_fd_detailed`/`unlink_
    owned_tree_dir_fd`) must not change ordinary, unswapped behavior at all -- prune must still
    actually free a genuinely stale/prunable activity (contrasting with the swap tests' `freed ==
    0`, proving that result is specifically the swap being caught, not prune having simply stopped
    deleting anything, ever, after this fix)."""
    aid, l = _new_activity(tmp_path)
    assert quota.admit(tmp_path, aid, l) is True
    _write_start(tmp_path, aid); _write_terminal(tmp_path, aid)
    l.release(); quota.settle(tmp_path, aid)
    assert not paths.ledger_entry_path(tmp_path, aid).exists()
    assert paths.activity_dir(tmp_path, aid).exists()

    old = time.time() - 999 * 86400
    seg = paths.segment_path(tmp_path, aid, "python", "deadbeef")
    os.utime(seg, (old, old))

    freed = quota.prune(tmp_path, need_bytes=10**9)
    assert freed > 0
    assert not paths.activity_dir(tmp_path, aid).exists()          # normally prunable -> actually pruned

    aid2, l2 = _new_activity(tmp_path)
    assert quota.admit(tmp_path, aid2, l2) is True
    _write_start(tmp_path, aid2); _write_terminal(tmp_path, aid2)
    l2.release()
    quota.retain(tmp_path)                                          # reconcile settles it (terminal + free lease)
    assert not paths.ledger_entry_path(tmp_path, aid2).exists()

# --- Codex R8-3 (IMPORTANT) / Ruling 66: `_unlock` must be fully contained -- an early failure
# in one cleanup step must never skip the rest, and must never replace a public op's own
# already-durable result with a raised exception.

def test_unlock_survives_injected_lock_un_failure_admit_still_returns_true(tmp_path, monkeypatch):
    aid, l = _new_activity(tmp_path)

    fds = {}
    real_flock = quota.fcntl.flock
    def hooked_flock(fd, op):
        if op == quota.fcntl.LOCK_UN:
            raise OSError("injected LOCK_UN failure")
        return real_flock(fd, op)

    real_quota_lock = quota._quota_lock
    def tracking_quota_lock(home):
        ctx = real_quota_lock(home)
        fds["lock_fd"] = ctx.lock_fd; fds["qfd"] = ctx.qfd; fds["afd"] = ctx.afd
        return ctx
    monkeypatch.setattr(quota, "_quota_lock", tracking_quota_lock)
    monkeypatch.setattr(quota.fcntl, "flock", hooked_flock)

    result = quota.admit(tmp_path, aid, l)
    monkeypatch.undo()   # restore the real flock/_quota_lock BEFORE any further real file I/O below

    assert result is True, "an admit() whose reservation was already durably written must still return True"
    for name in ("lock_fd", "qfd", "afd"):
        with pytest.raises(OSError) as exc_info:
            os.fstat(fds[name])                     # every fd from the (failed-unlock) LockCtx was closed
        assert exc_info.value.errno == errno.EBADF, name

    assert json.loads(paths.ledger_entry_path(tmp_path, aid).read_text()) == {
        "reserved": quota.RESERVE, "granted": 0,
    }

# --- Ruling 68 (G9-Py, Codex Round 9 BLOCKER): `_prune_locked`/`_retain_locked` enumerate
# candidates and delete via `ctx.afd` (Ruling 67), but `_classify` used to re-resolve each
# candidate's directory by PATH (`scan.scan_activity(home, aid)` -- a fresh walk from the shared
# `Library/Logs/repo-radar` prefix, entirely independent of `ctx.afd`'s already-open,
# lock-acquisition-time binding). The tests below inject a REAL swap of the ACTIVITY ROOT --
# rename `activity/` -> `activity.moved/`, a fresh `activity/` created with a SAME-ID `aid`
# subdirectory holding a `succeeded` terminal -- exactly around the classification read, then
# restore the original before the test's own assertions (mirroring "restore the original before
# `_verify_canonical`" from the finding: `_prune_locked`'s own root-identity check, unrelated to
# this fix, sees a validly-restored root by the time it runs and lets deletion proceed normally,
# so these tests isolate CLASSIFICATION's own correctness rather than an unrelated refusal).
# Landed as Python-side defense-in-depth per the spec's 2026-08-26 §7 threat-model scope ruling
# (Node cannot mirror this fix -- no fd-relative directory reads in Node's `fs`).

def test_prune_locked_classify_survives_activity_root_swap_during_fd_bound_scan(tmp_path, monkeypatch):
    """With the Ruling 68 fix, `_classify`'s scan is `ctx.afd`-bound: `ctx.afd` was opened+
    validated at lock acquisition, long BEFORE this test's swap, so it stays bound to the TRUE
    original `activity/` tree regardless of what gets renamed at the canonical PATH afterward --
    the same already-proven immunity every other `ctx.afd`-relative read in this module has
    (Ruling 67). Classification therefore reads the REAL, start-only (still-running) activity, not
    the fake succeeded-terminal one sitting at the swapped-in path -- `quota.prune` must delete
    NOTHING."""
    aid, l = _new_activity(tmp_path)
    _write_start(tmp_path, aid)              # start only, no terminal -> genuinely RUNNING
    # never admitted -> no ledger entry -> a bare directory prune candidate

    root_dir = paths.quota_dir(tmp_path).parent            # activity/
    moved_dir = tmp_path / "activity.moved"
    real_read = paths.read_owned_segments_dir_fd_detailed
    state = {"done": False}

    def hooked(dfd, name, suffix=".jsonl"):
        if not state["done"] and name == aid:
            state["done"] = True
            os.rename(root_dir, moved_dir)                          # (1) rename the real activity dir aside
            paths.secure_mkdir(paths.activity_dir(tmp_path, aid))     # (2) fresh same-ID dir...
            _write_terminal(tmp_path, aid, outcome="succeeded")       #     ...with a succeeded terminal
            try:
                return real_read(dfd, name, suffix)                  # (3) let the read proceed
            finally:
                shutil.rmtree(root_dir)                               # (4) drop the fake...
                os.rename(moved_dir, root_dir)                        #     ...restore the original
        return real_read(dfd, name, suffix)
    monkeypatch.setattr(paths, "read_owned_segments_dir_fd_detailed", hooked)

    try:
        freed = quota.prune(tmp_path, need_bytes=1)
    finally:
        monkeypatch.undo()

    assert state["done"], "the fd-bound classification read must actually have been reached"
    assert freed == 0
    assert paths.activity_dir(tmp_path, aid).exists()
    assert quota._top_types(tmp_path, aid) == ["start"]     # the TRUE original -- never a terminal
    l.release()

def test_prune_locked_classify_via_path_form_deletes_running_item_on_activity_root_swap(tmp_path, monkeypatch):
    """Counterfactual (Codex Round 9 repro, confirms the pre-fix vulnerability): with `_classify`
    rerouted back through the PATH form (`quota._scan` forced to ignore `ctx`, exactly matching
    the pre-Ruling-68 implementation), the SAME swap technique -- but landing around the
    path-based read (`paths.read_owned_segments_detailed`, an independent fresh walk NOT bound to
    `ctx.afd`) -- fools classification into reading the fake succeeded-terminal directory. By the
    time the swap is undone and `_prune_locked` reaches its deletion decision, the REAL, restored,
    start-only (still-running) activity is what's actually at that path, and `quota.prune` deletes
    it -- reproducing "never prune running/unreconciled" being violated. This test is expected to
    keep passing as a canary: if `_classify`/`_scan` is ever silently reverted to the path form,
    this documents exactly why that regresses."""
    monkeypatch.setattr(quota, "_scan", lambda home, aid, ctx=None: quota.scan_mod.scan_activity(home, aid))

    aid, l = _new_activity(tmp_path)
    _write_start(tmp_path, aid)
    root_dir = paths.quota_dir(tmp_path).parent
    moved_dir = tmp_path / "activity.moved"
    real_read = paths.read_owned_segments_detailed
    state = {"done": False}

    def hooked(directory, suffix=".jsonl"):
        if not state["done"] and pathlib.Path(directory) == paths.activity_dir(tmp_path, aid):
            state["done"] = True
            os.rename(root_dir, moved_dir)
            paths.secure_mkdir(paths.activity_dir(tmp_path, aid))
            _write_terminal(tmp_path, aid, outcome="succeeded")
            try:
                return real_read(directory, suffix)      # resolves the FAKE -- a fresh, independent walk
            finally:
                shutil.rmtree(root_dir)
                os.rename(moved_dir, root_dir)            # restored BEFORE _prune_locked's deletion decision
        return real_read(directory, suffix)
    monkeypatch.setattr(paths, "read_owned_segments_detailed", hooked)

    try:
        freed = quota.prune(tmp_path, need_bytes=1)
    finally:
        monkeypatch.undo()

    assert state["done"], "the path-based classification read must actually have been reached"
    assert freed > 0
    assert not paths.activity_dir(tmp_path, aid).exists()    # BUG (pre-fix): the running item was deleted
    l.release()

def test_verify_canonical_returns_false_when_quota_replaced_by_regular_file(tmp_path):
    """Non-blocking residual (Codex Round 9 reviewer note, G9-Py): `_verify_canonical` is
    documented as NEVER raising, but pre-fix only caught `OSError`. Replacing `quota/` with a
    regular file (a plain, persistent, non-racing path replacement -- squarely still within the
    spec's §7 threat model) makes `_canonical_quota_ident` raise `paths.UnsafePath` ("quota is not
    a directory") -- NOT an `OSError` subclass -- so it propagated straight out of `_verify_
    canonical` instead of returning the documented `False`."""
    ctx = quota._quota_lock(tmp_path)
    try:
        assert quota._verify_canonical(ctx) is True     # sanity: canonical before any tampering
        qdir = paths.quota_dir(tmp_path)
        shutil.rmtree(qdir)
        qdir.write_bytes(b"not a directory")              # quota/ is now a REGULAR FILE
        assert quota._verify_canonical(ctx) is False       # must not raise
    finally:
        quota._unlock(ctx)
