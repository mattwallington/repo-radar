import json, os
from repo_radar.activity import reconcile, paths, lease, ids, records

def _mk(tmp_path, aid):
    d = paths.activity_dir(tmp_path, aid); paths.secure_mkdir(d)
    return paths.owner_lock_path(tmp_path, aid)

def _new_activity(tmp_path):
    aid = ids.mint_activity_id(); lp = _mk(tmp_path, aid)
    return aid, lease.acquire(lp)

def _write_rec(home, aid, **rec):   # a durable VALID v1 record, as the writer would leave it
    rec.setdefault("schema_version", 1); rec.setdefault("activity_id", aid)
    rec.setdefault("ts", "2026-08-14T00:00:00-07:00")   # valid ISO-8601 with offset
    seg = paths.segment_path(home, aid, "python", "deadbeef")
    fd = paths.secure_open_append(seg)
    os.write(fd, (json.dumps(rec) + "\n").encode()); os.close(fd)

def _write_start(home, aid):
    _write_rec(home, aid, type="start", seq=0, kind="sync", channel="stable",
               trigger="cli", created_by="python")

def _write_cancel_requested(home, aid):
    _write_rec(home, aid, type="control", seq=1, name="cancel_requested")

def _top_terminal_outcomes(home, aid):
    out = []
    for _name, data, _sz, _mt in paths.read_owned_segments(paths.activity_dir(home, aid)):
        for line in data.split(b"\n"):
            if not line:
                continue
            obj = records.parse_valid(line, aid)
            if obj is not None and obj["type"] == "terminal":
                out.append((obj["outcome"], obj["by"]))
    return out

def _top_types(home, aid):
    types = []
    for _name, data, _sz, _mt in paths.read_owned_segments(paths.activity_dir(home, aid)):
        for line in data.split(b"\n"):
            if not line:
                continue
            obj = records.parse_valid(line, aid)
            if obj is not None:
                types.append(obj["type"])
    return types

def test_synthesizes_interrupted_when_lease_free_and_started(tmp_path):
    aid, l = _new_activity(tmp_path)
    _write_start(tmp_path, aid)
    l.release()                                   # crash after start, before terminal
    assert reconcile.synthesize_terminal(tmp_path, aid) is True
    assert _top_terminal_outcomes(tmp_path, aid) == [("interrupted", "reconciler")]
    # the lease was released again -> a fresh acquire must succeed
    fresh = lease.acquire(paths.owner_lock_path(tmp_path, aid))
    assert fresh is not None
    fresh.release()

def test_synthesizes_cancelled_when_cancel_requested_present(tmp_path):
    aid, l = _new_activity(tmp_path)
    _write_start(tmp_path, aid)
    _write_cancel_requested(tmp_path, aid)
    l.release()
    assert reconcile.synthesize_terminal(tmp_path, aid) is True
    assert _top_terminal_outcomes(tmp_path, aid) == [("cancelled", "reconciler")]

def test_preserves_when_lease_held(tmp_path):
    aid, l = _new_activity(tmp_path)              # lease still HELD, no crash
    _write_start(tmp_path, aid)
    assert reconcile.synthesize_terminal(tmp_path, aid) is False
    assert "terminal" not in _top_types(tmp_path, aid)
    l.release()

def test_fs_error_path_returns_false_never_raises(tmp_path, monkeypatch):
    aid, l = _new_activity(tmp_path)
    _write_start(tmp_path, aid)
    l.release()
    monkeypatch.setattr(reconcile.os, "fsync", lambda fd: (_ for _ in ()).throw(OSError("no fsync")))
    assert reconcile.synthesize_terminal(tmp_path, aid) is False   # never raises: caught, not durable
    # failure still releases the lease it acquired, so the activity remains reclaimable
    fresh = lease.acquire(paths.owner_lock_path(tmp_path, aid))
    assert fresh is not None
    fresh.release()
