import json, os, threading
from repo_radar.activity import writer, paths, ids, quota, lease

def _read_all(home, aid):
    d = paths.activity_dir(home, aid)
    recs = []
    for f in sorted(d.glob("*.jsonl")):
        recs += [json.loads(x) for x in f.read_text().splitlines()]
    return recs

def test_full_lifecycle_mint_start_event_terminal_settles_and_releases(tmp_path):
    w = writer.ActivityWriter(tmp_path, kind="sync", channel="stable",
                              trigger="cli", producer="python")
    owner_token = w._lease.owner_token   # capture before terminal() releases the lease
    w.start()
    w.event("repos_loaded", "info", count=30)
    w.terminal("succeeded", repos_changed=2, errors=0, warns=0)
    recs = _read_all(tmp_path, w.activity_id)
    types = [r["type"] for r in recs]
    assert types.count("start") == 1 and "event" in types and types[-1] == "terminal"
    assert recs[-1]["outcome"] == "succeeded" and recs[-1]["by"] == owner_token
    assert not paths.ledger_entry_path(tmp_path, w.activity_id).exists()   # settled
    assert lease.acquire(paths.owner_lock_path(tmp_path, w.activity_id)) is not None  # released

def test_cancel_requested_control_is_idempotent_and_uses_reserve(tmp_path):
    w = writer.ActivityWriter(tmp_path, kind="sync", channel="stable",
                              trigger="cli", producer="python")
    w.start(); w.control("cancel_requested"); w.control("cancel_requested")
    recs = [r for r in _read_all(tmp_path, w.activity_id)
            if r["type"] == "control" and r.get("name") == "cancel_requested"]
    assert len(recs) == 1                          # one-shot slot

def test_dropped_events_note_is_one_shot(tmp_path, monkeypatch):
    w = writer.ActivityWriter(tmp_path, kind="sync", channel="stable",
                              trigger="cli", producer="python")
    w.start()
    monkeypatch.setattr(quota, "grant", lambda *a, **k: False)   # ordinary capacity gone
    w.event("dropped1", "info", x=1); w.event("dropped2", "info", x=2)   # both refused
    notes = [r for r in _read_all(tmp_path, w.activity_id)
             if r["type"] == "integrity" and r.get("kind") == "dropped-events"]
    assert len(notes) == 1                         # emitted at most once
    w.terminal("failed", repos_changed=0, errors=1, warns=0)     # terminal still lands (reserve)
    assert any(r["type"] == "terminal" for r in _read_all(tmp_path, w.activity_id))

def test_terminal_append_failure_does_not_settle_or_swallow_reservation(tmp_path, monkeypatch):
    w = writer.ActivityWriter(tmp_path, kind="sync", channel="stable",
                              trigger="cli", producer="python")
    w.start()
    monkeypatch.setattr(writer.os, "fsync", lambda fd: (_ for _ in ()).throw(OSError("no fsync")))
    w.terminal("succeeded", repos_changed=0, errors=0, warns=0)   # durable write fails
    assert paths.ledger_entry_path(tmp_path, w.activity_id).exists()   # reservation PRESERVED
    # reader can later synthesize interrupted from the freed lease + preserved reserve

def test_best_effort_write_failure_never_raises(tmp_path, monkeypatch, capsys):
    w = writer.ActivityWriter(tmp_path, kind="sync", channel="stable",
                              trigger="cli", producer="python")
    monkeypatch.setattr(paths, "secure_open_append",
                        lambda *a, **k: (_ for _ in ()).throw(OSError("disk full")))
    w.start()                                       # must not raise
    assert "activity" in capsys.readouterr().err.lower()

def test_adopter_has_no_cancellation_authority(tmp_path):
    # finding 2: only the minter may write cancel_requested; an adopter must no-op so the
    # single 20 KiB cancellation slot cannot be double-spent across writers
    minter = writer.ActivityWriter(tmp_path, kind="sync", channel="stable",
                                   trigger="cli", producer="python")
    minter.start()
    dup = os.dup(minter._lease.fd)                  # simulate an inherited fd
    adopter = writer.ActivityWriter(tmp_path, kind="sync", channel="stable", trigger="cli",
                                    producer="dispatcher", inherited_id=minter.activity_id,
                                    inherited_fd=dup, owner_token=minter._lease.owner_token)
    adopter.control("cancel_requested")             # must be a no-op (not the authority)
    cancels = [r for r in _read_all(tmp_path, minter.activity_id)
               if r["type"] == "control" and r.get("name") == "cancel_requested"]
    assert cancels == []

def test_construction_failure_yields_inactive_writer_no_raise(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "secure_mkdir",
                        lambda *a, **k: (_ for _ in ()).throw(OSError("mkdir denied")))
    w = writer.ActivityWriter(tmp_path, kind="sync", channel="stable",
                              trigger="cli", producer="python")   # must NOT raise
    assert w._active is False
    assert w.hand_off_env() == {}                   # never exposes a dead fd (finding 3)
    w.start(); w.event("x", "info"); w.terminal("succeeded")      # all no-ops, no raise

def test_admission_refusal_hand_off_env_is_empty(tmp_path, monkeypatch):
    monkeypatch.setattr(quota, "admit", lambda *a, **k: False)
    w = writer.ActivityWriter(tmp_path, kind="sync", channel="stable",
                              trigger="cli", producer="python")
    assert w._active is False and w.hand_off_env() == {}

def test_settle_failure_during_terminal_still_frees_the_lock(tmp_path, monkeypatch, capsys):
    aid_lock = None
    w = writer.ActivityWriter(tmp_path, kind="sync", channel="stable",
                              trigger="cli", producer="python")
    aid = w.activity_id
    w.start()
    monkeypatch.setattr(quota, "settle", lambda *a, **k: (_ for _ in ()).throw(OSError("boom")))
    w.terminal("succeeded", repos_changed=0, errors=0, warns=0)   # must NOT raise into the sync
    assert "activity" in capsys.readouterr().err.lower()
    # finding 1: the lease MUST be released even though settle raised -> lock is FREE
    assert lease.probe(paths.owner_lock_path(tmp_path, aid)) == lease.FREE

def test_terminal_ensures_exactly_one_start_when_none_written(tmp_path):
    # a finalize-style path that calls terminal() without a prior start() must still produce a
    # start, and exactly one (finding 1)
    w = writer.ActivityWriter(tmp_path, kind="system", channel="dev",
                              trigger="scheduled", producer="python")
    w.terminal("blocked", reason="x")               # no explicit start() first
    types = [r["type"] for r in _read_all(tmp_path, w.activity_id)]
    assert types.count("start") == 1 and types[-1] == "terminal"

def test_failed_start_writes_no_terminal_and_reservation_recoverable(tmp_path, monkeypatch):
    # Round-4 #2: if the start never becomes DURABLE, the writer writes no terminal (no
    # terminal-only item); the lease is freed and the reservation is reclaimable by reconcile.
    w = writer.ActivityWriter(tmp_path, kind="sync", channel="stable", trigger="cli", producer="python")
    aid = w.activity_id
    monkeypatch.setattr(writer.os, "fsync", lambda fd: (_ for _ in ()).throw(OSError("no fsync")))
    w.start(); w.terminal("succeeded", repos_changed=0, errors=0, warns=0)
    assert all(r["type"] != "terminal" for r in _read_all(tmp_path, aid))       # writer wrote no terminal
    assert lease.probe(paths.owner_lock_path(tmp_path, aid)) == lease.FREE       # lease released
    monkeypatch.undo()                              # Round-5 #2: restore fsync BEFORE reconciliation
    quota.reconcile(tmp_path)                        # now able to durably synthesize + settle
    assert not paths.ledger_entry_path(tmp_path, aid).exists()                   # reservation recovered

def test_start_retry_after_fsync_failure_strictly_increasing_seq(tmp_path, monkeypatch):
    # construct FIRST (admission uses real fsync), THEN make the first start fsync fail
    w = writer.ActivityWriter(tmp_path, kind="sync", channel="stable", trigger="cli", producer="python")
    n = {"i": 0}; real = writer.os.fsync
    def flaky(fd):
        n["i"] += 1
        if n["i"] == 1:
            raise OSError("transient")              # start line written; only its fsync fails
        return real(fd)
    monkeypatch.setattr(writer.os, "fsync", flaky)
    w.start(); w.start()                            # retry re-fsyncs the SAME line, then ownership
    recs = _read_all(tmp_path, w.activity_id)
    assert [r["type"] for r in recs].count("start") == 1
    seqs = [r["seq"] for r in recs]                 # Round-6 #1: no seq regression (start<ownership)
    assert seqs == sorted(seqs) and len(seqs) == len(set(seqs))

def test_start_partial_write_then_error_retries_one_valid_start(tmp_path, monkeypatch):
    w = writer.ActivityWriter(tmp_path, kind="sync", channel="stable", trigger="cli", producer="python")
    real = writer.os.write; n = {"i": 0}
    def flaky(fd, data):
        n["i"] += 1
        if n["i"] == 1:
            real(fd, data[:5]); raise OSError("boom")   # write a prefix, then fail
        return real(fd, data)
    monkeypatch.setattr(writer.os, "write", flaky)
    w.start()                                       # partial line truncated away -> _NOTHING
    monkeypatch.undo()
    w.start()                                       # retry -> exactly one CLEAN start, no partial line
    recs = _read_all(tmp_path, w.activity_id)       # _read_all parses cleanly (no orphan prefix)
    assert [r["type"] for r in recs].count("start") == 1

def test_start_grant_refusal_writes_nothing_no_terminal_only(tmp_path, monkeypatch):
    w = writer.ActivityWriter(tmp_path, kind="sync", channel="stable", trigger="cli", producer="python")
    aid = w.activity_id
    monkeypatch.setattr(quota, "grant", lambda *a, **k: False)   # even the start is refused
    w.start(); w.terminal("succeeded", repos_changed=0, errors=0, warns=0)
    assert _read_all(tmp_path, aid) == []           # nothing written at all -> no terminal-only item
    assert lease.probe(paths.owner_lock_path(tmp_path, aid)) == lease.FREE

def test_event_not_appended_when_grant_refuses(tmp_path, monkeypatch):
    # Round-4 #1 ordering: the segment append is never attempted unless grant returns True
    w = writer.ActivityWriter(tmp_path, kind="sync", channel="stable", trigger="cli", producer="python")
    w.start()
    monkeypatch.setattr(quota, "grant", lambda *a, **k: False)
    w.event("x", "info")
    assert [r for r in _read_all(tmp_path, w.activity_id) if r["type"] == "event"] == []

def test_non_serializable_field_never_raises_and_drops_the_event(tmp_path):
    w = writer.ActivityWriter(tmp_path, kind="sync", channel="stable",
                              trigger="cli", producer="python")
    w.start()
    w.event("x", "info", bad=object())              # non-JSON value: must not raise (finding 1)
    w.terminal("succeeded", repos_changed=0, errors=0, warns=0)   # sync still finalizes cleanly
    assert any(r["type"] == "terminal" for r in _read_all(tmp_path, w.activity_id))

def test_nested_field_value_is_redacted(tmp_path):
    w = writer.ActivityWriter(tmp_path, kind="sync", channel="stable",
                              trigger="cli", producer="python")
    w.start()
    w.event("x", "error", meta={"nested": "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"})
    blob = json.dumps(_read_all(tmp_path, w.activity_id))
    assert "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" not in blob   # nested value scrubbed

# --- fix round 1: C1 (close() can raise), C2 (adopted lease must not be LOCK_UN'd), I3 (start/
# terminal idempotency race) -----------------------------------------------------------------

def test_emit_close_failure_does_not_escape(tmp_path, monkeypatch, capsys):
    # C1: os.close(fd) inside _emit was unguarded -- a close-time OSError (EIO on NFS/FUSE,
    # ENOSPC/EDQUOT on close-deferred allocation) must degrade the outcome, never raise.
    w = writer.ActivityWriter(tmp_path, kind="sync", channel="stable",
                              trigger="cli", producer="python")
    real_open = paths.secure_open_append
    seg_fds = []
    def spy_open(*a, **k):
        fd = real_open(*a, **k)
        seg_fds.append(fd)                              # remember exactly which fd is the segment
        return fd
    monkeypatch.setattr(paths, "secure_open_append", spy_open)
    real_close = writer.os.close
    def flaky_close(fd):
        if fd in seg_fds:                                # only the segment fd's close fails --
            raise OSError("EIO on close")                # unrelated closes (quota's lock fd, etc.)
        return real_close(fd)                             # go through untouched
    monkeypatch.setattr(writer.os, "close", flaky_close)
    w.start()                                             # write + fsync succeed; close() fails
    assert "activity" in capsys.readouterr().err.lower()  # must not raise -> warns instead
    assert w._started is False                            # close failure -> treated as not durable

def test_terminal_on_adopted_writer_does_not_unlock_shared_lease(tmp_path):
    # C2: terminal() must release an ADOPTED lease with drop_local_reference() (close-only), never
    # release() (LOCK_UN) -- LOCK_UN on a shared open-file-description frees the lock for every fd
    # that shares it, including a parent (e.g. Electron) that still believes it holds the lease.
    minter = writer.ActivityWriter(tmp_path, kind="sync", channel="stable",
                                   trigger="cli", producer="python")
    minter.start()
    lock_path = paths.owner_lock_path(tmp_path, minter.activity_id)
    sibling_fd = os.dup(minter._lease.fd)      # simulates a still-open parent copy of the same OFD
    dup_for_adopter = os.dup(minter._lease.fd)  # the fd the adopter inherits (also same OFD)
    adopter = writer.ActivityWriter(tmp_path, kind="sync", channel="stable", trigger="cli",
                                    producer="dispatcher", inherited_id=minter.activity_id,
                                    inherited_fd=dup_for_adopter, owner_token=minter._lease.owner_token)
    adopter.terminal("cancelled")
    # sibling_fd (and minter's own fd) are still open on the shared OFD -> the flock must still be
    # BUSY. If terminal() had wrongly called release() (LOCK_UN), this would now read FREE.
    assert lease.probe(lock_path) == lease.BUSY
    os.close(sibling_fd)

# --- Codex gate round 1, Finding 4 (IMPORTANT — NOT carryable): recheck `_active` under the
# lock (post-terminal control race) ------------------------------------------------------------

def test_post_terminal_control_is_dropped_not_written_behind_settlement(tmp_path, monkeypatch):
    # `_active` was read in _emit's fast path BEFORE acquiring the RLock and never re-checked
    # once held. Deterministic barrier: thread A finalizes (terminal) and, via a monkeypatched
    # `quota.settle` that signals an Event then sleeps briefly WHILE STILL HOLDING self._lock and
    # BEFORE `_active` is set False, gives thread B (a concurrent RESERVE-path
    # `control("cancel_requested")`) a wide, reliable window to pass its pre-lock fast-path check
    # (active still True) and then block on the RLock -- only to proceed, pre-fix, AFTER A has
    # already deactivated, settled, and released. That produces a `control` record AFTER the
    # `terminal` record (invalid lifecycle ordering) and a reserve-path write with NO outstanding
    # reservation (since `reserve=True` skips quota.grant entirely) -- bytes that can exceed the
    # hard ceiling and are never accounted anywhere, because the ledger was already removed.
    real_settle = quota.settle
    for trial in range(20):
        home = tmp_path / f"trial{trial}"
        w = writer.ActivityWriter(home, kind="sync", channel="stable",
                                  trigger="cli", producer="python")
        w.start()
        a_in_critical_section = threading.Event()
        def slow_settle(*a, **k):
            a_in_critical_section.set()      # A still holds self._lock; _active is still True
            import time; time.sleep(0.05)
            return real_settle(*a, **k)
        monkeypatch.setattr(quota, "settle", slow_settle)
        def run_terminal():
            w.terminal("succeeded", repos_changed=0, errors=0, warns=0)
        def run_control():
            a_in_critical_section.wait(timeout=2)   # start racing only once A is mid-critical-section
            w.control("cancel_requested")
        t1 = threading.Thread(target=run_terminal)
        t1.start()
        t2 = threading.Thread(target=run_control)
        t2.start()
        t1.join(); t2.join()
        monkeypatch.setattr(quota, "settle", real_settle)
        recs = _read_all(home, w.activity_id)
        types = [r["type"] for r in recs]
        assert "terminal" in types, f"trial {trial}: no terminal record: {types}"
        term_idx = types.index("terminal")
        assert types[term_idx + 1:] == [], \
            f"trial {trial}: record(s) after terminal: {types}"
        # settlement must be consistent with what actually landed: once terminal is durable and
        # settles, no reserve-path write may land afterward with no outstanding reservation.
        assert not paths.ledger_entry_path(home, w.activity_id).exists()

def test_concurrent_start_and_terminal_writes_single_start(tmp_path):
    # I3: start() and terminal() (which can itself call start() via _ensure_started()) raced on
    # the same writer from two threads -- both could pass the "not yet started" check before
    # either set _start_written, producing two `start` records. The RLock-guarded decide-then-act
    # sequence must serialize this: exactly one `start` record, every trial.
    for trial in range(20):
        home = tmp_path / f"trial{trial}"
        w = writer.ActivityWriter(home, kind="sync", channel="stable",
                                  trigger="cli", producer="python")
        barrier = threading.Barrier(2)
        def run_start():
            barrier.wait()
            w.start()
        def run_terminal():
            barrier.wait()
            w.terminal("cancelled")
        t1 = threading.Thread(target=run_start)
        t2 = threading.Thread(target=run_terminal)
        t1.start(); t2.start()
        t1.join(); t2.join()
        recs = _read_all(home, w.activity_id)
        starts = [r for r in recs if r["type"] == "start"]
        assert len(starts) == 1, f"trial {trial}: {len(starts)} start record(s)"
