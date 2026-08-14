# Activity History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every sync attempt and every pre-attempt system incident a durable, inspectable Activity record with an authoritative outcome, surfaced in a dedicated context-isolated Activity window — so a blocked/failed/crashed run is always visible in the app, never buried in a terminal.

**Architecture:** Three producers (Electron main, the shell dispatcher, Python) append append-only JSONL records under a shared per-invocation **activity identity** into per-writer-instance segment files; the executing owner holds a real **BSD-`flock` advisory-lock lease** so liveness is provable rather than guessed. A crash-recoverable, filesystem-authoritative **admission-lock quota ledger** bounds on-disk size. A pure, dependency-free Node **reader/redactor** merges + reconciles + redacts the segments into bounded DTOs for a context-isolated **Activity** `BrowserWindow`. Lifecycle authority and abnormal-termination reconciliation are foundation concerns, built and tested first.

**Tech Stack:** Python 3.10–3.14 stdlib (`fcntl.flock`, `os`, `json`, `uuid`, `tempfile`) for the Python writer; Node/CommonJS stdlib (`fs`, `child_process`/`/usr/bin/lockf`, `crypto`) for the dispatcher shim + reader module; existing Electron/BrowserWindow/IPC stack for the UI. macOS-only lock semantics. No new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-08-12-activity-history-spec.md` @ `a478d87` (Codex-APPROVED, locked). The plan argues from the spec; executors read both. Section citations below (e.g. "§5") refer to that spec.

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the spec.

- **Best-effort observability — never changes sync semantics.** A failed Activity write emits exactly ONE non-recursive warning to the producer's existing stderr/log, then continues. Never route an Activity-write failure through the failing Activity writer. Admission failure releases the lease and skips recording; the sync proceeds unchanged.
- **Redaction is defense-in-depth.** Redact at WRITE time (producer) AND again in Node before any IPC/export. High-confidence credential forms, masked identically by both: `sk-…`, `ghp_…` / `github_pat_…`, `AIza…`, `Bearer …`, `//user:pass@`, plus the app's configured/effective secret values. One shared (secret, expected-mask) fixture set exercised by BOTH redactors. Shell producers emit only fixed reason codes + bounded messages, never environment dumps.
- **No new runtime dependency.** Node + Python **stdlib** only for the record layer; existing Electron stack for UI.
- **Schema:** `schema_version` = **1**. A v1 reader accepts v1 records and ignores unknown *additive* fields; an *unsupported* version is never interpreted as v1 — it yields a bounded System `unsupported-schema` integrity Problem while other readable records remain available.
- **All size limits count UTF-8 bytes and mark truncation explicitly.**
- **Identity/token formats:** `activity_id` = UUIDv4 matching `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`; `writer-id` and `owner_token` = `^[0-9a-f]{8}$`. Never use unvalidated text in a filesystem path.
- **Filesystem perms (created securely, no briefly-permissive window):** `activity/<id>/` dir `0700`; segment `*.jsonl` `0600`; `activity/quota/` dir `0700`; `activity/quota/<id>.json` `0600`. Reject any target that exists as a non-directory or symlink.
- **Per-record bounds:** flat primitive `fields` only, ≤32 keys; key ≤64 B; each value ≤1 KiB; aggregate `fields` ≤8 KiB; `detail` ≤8 KiB; encoded record ≤20 KiB (including trailing newline for reserved records).
- **Per-activity cap 4 MiB** with a **60 KiB reservation partitioned into three fixed, non-fungible 20 KiB allocations** (terminal / cancellation-control / dropped-events-integrity). Ordinary `event`/`start` bytes stop at **4 MiB − 60 KiB**.
- **Global ceiling 64 MiB** over `activity/`, enforced by the admission lock over the crash-recoverable ledger. Accounted unit = logical segment bytes including newlines; `quota.lock` + ledger files are outside the ceiling.
- **Terminal outcomes (exactly seven):** `succeeded`, `succeeded-with-warnings`, `blocked`, `failed`, `cancelled`, `skipped`, `interrupted`. `running` is a *derived* non-terminal state, never a stored outcome.

---

## Key implementation decisions beyond the spec (FLAG for plan-review)

The spec is a contract; these are the concrete engineering choices this plan commits to. They are the highest-value things for the reviewer to scrutinize.

1. **The writer + lease + admission layer is implemented in BOTH Python and Node — by necessity, not choice.** Electron (Node) must acquire and *hold* the lease across its own dev/runtime guards and then hand the locked fd to the child it spawns (`main.js` → `runtime.runSync` → `/bin/sh` → `exec` python); it cannot delegate acquisition to a child, because the child cannot pass a held fd *back up* to the parent. So `repo_radar/activity/` (Python) and `menubar/activity/` (Node, write side) both implement mint/acquire/admit/`start`/guard-`terminal`/handoff. Two cross-language tests keep them in lockstep: a **golden-record byte-equality** test and a **lock-interop** test (a lock taken by one language is seen busy by the other). The reader/reconciler/retention is **Node-only**.
2. **The POSIX-sh dispatcher stays thin — it never reimplements records/lease/quota.** On the scheduled path it invokes the managed venv Python's bootstrap entrypoint (`python -m repo_radar.activity.bootstrap`) **before** the runtime-verify guard, to mint + acquire + admit + write `start`. That interpreter can still *execute* even when the fingerprint guard will later *reject* it (the exact motivating failure: a Homebrew python bump staled the fingerprint but python still ran). On a subsequent guard failure the shell calls the Python finalizer (`python -m repo_radar.activity.finalize`) to write the `blocked`/`interrupted` terminal and release. Only if the venv Python cannot execute **at all** (rare hard corruption) does the shell append a minimal last-resort `system` incident line in pure sh (best-effort, no quota reservation) so a record still exists.
3. **The ledger entry is a line-based `key=value` file, not JSON:** `activity/quota/<activity-id>.entry` containing `reserved=<int>\ngranted=<int>\nhas_start=<0|1>`, written atomically (temp + `rename`), `0600`, in `activity/quota/` `0700`. Rationale: it must be read/written from Python, Node, **and** POSIX sh (the last-resort path) without a JSON parser. The field semantics `{reserved, granted}` are exactly the spec's (§7); only the encoding is sh-friendly. `has_start` lets the lease-gated reconciler (§7) distinguish reserve-before-`start` without re-scanning segments.
4. **A `test` script is added to `menubar/package.json`** (`"test": "node --test"`) — none exists today, though 18 `node:test` files already do. Python keeps `python -m pytest repo_radar/tests/`.
5. **Shared redaction fixtures** live at `repo_radar/activity/redaction_fixtures.json` (bundled with the package), loaded by the Python test directly and by the Node test via `../../repo_radar/activity/redaction_fixtures.json`. This is the single source that proves both redactors mask identically (spec §4).

---

## File Structure

### New — Python (`repo_radar/activity/`, package alongside `repo_radar/modes/`)

- `__init__.py` — package marker; re-exports the public writer API.
- `ids.py` — mint/validate `activity_id` (UUIDv4), `writer_id` / `owner_token` (8-hex). Pure, no I/O.
- `paths.py` — construct + securely create/validate the activity dir, segment paths, `owner.lock`, and the `quota/` dir + `<id>.entry`. Owns the `0700`/`0600` + reject-symlink/non-dir discipline.
- `records.py` — build each record type, enforce per-record bounds (§7) with explicit truncation marking, and encode to a single UTF-8 JSON line; report encoded byte length (incl. newline). Pure.
- `redact.py` — write-time redaction: the fixed credential-form patterns (mirroring `metadata._REDACTIONS`) **plus** the app's configured/effective secret values. Loads the shared fixtures only in tests.
- `lease.py` — `flock` acquire/hold/release (`fcntl.flock(LOCK_EX|LOCK_NB)`), fd retention, `owner_token` minting, and the exact **inherited-descriptor validation** (§5: syntactic → `fstat` identity → independent-busy probe → inherited-fd reassert).
- `quota.py` — admission lock (`quota.lock`), the `key=value` ledger, filesystem scan for `committed`, charge computation, `admit`/`grant`/`settle`/`reconcile`/`prune`, corrupt-entry fail-closed at 4 MiB.
- `writer.py` — `ActivityWriter`: ties ids+paths+lease+quota+records into one segment writer with the reserve-partition state machine, best-effort semantics, adopt-vs-mint, and the seven-outcome finalizer.
- `bootstrap.py` — `python -m repo_radar.activity.bootstrap` entrypoint used by the dispatcher: mint+acquire+admit+`start`, emit `activity_id` + lock fd number to stdout for the shell to carry.
- `finalize.py` — `python -m repo_radar.activity.finalize` entrypoint: write a `blocked`/`interrupted`/`system` terminal for a given id and release (used by the shell on guard failure).
- `redaction_fixtures.json` — shared (secret, expected-mask) fixtures (bundled; read by both test suites).

### New — Node (`menubar/activity/`, CommonJS module alongside `menubar/runtime/`)

- `index.js` — public surface `require`d by `main.js` (write side + reader façade).
- `ids.js` — validate `activity_id` / `writer_id` / `owner_token` (regex; mirror `ids.py`).
- `paths.js` — path construction + secure create/validate (mirror `paths.py`).
- `records.js` — build + bound + encode records to the **byte-identical** line format (mirror `records.py`).
- `redact.js` — read-time backstop redaction (credential forms + currently-configured secrets); replaces reliance on `runtime/hashing.js:redact`.
- `lease.js` — Node lease acquire/hold/handoff via `/usr/bin/lockf -t 0 <fd>` on a retained descriptor (write side, Electron path).
- `quota.js` — Node admission/ledger (mirror `quota.py`, write side) **and** the reader-side retention/prune + ledger-reconcile.
- `writer.js` — Node `ActivityWriter` for the Electron manual path (`start`, guard-`terminal`, `ownership`-initial, hand-off).
- `parse.js` — per-segment JSONL parse: truncated-trailing tolerance, interior-corruption → `integrity`, strict-increasing `seq`, schema-version handling.
- `merge.js` — k-way merge of segment heads by `(ts, writer_id)` preserving per-segment append order.
- `reconcile.js` — lock-probe reconciliation (§5): held⇒`running`, freed⇒synthesize `interrupted`/`cancelled`, retains lock until synthetic terminal durable.
- `read.js` — top-level: enumerate → parse → merge → reconcile → derive outcome/severity → redact → build bounded DTOs; the export builder.
- `__tests__/*.test.js` — `node:test` suites.

### Modified — Python

- `repo_radar/cli.py` — acquire identity+lease+admit+`start` **before** `check_dependencies()` (map: insert before line 53), adopting an inherited id when present.
- `repo_radar/modes/sync.py` — thread the `ActivityWriter` through `sync_mode` (adopt the upstream identity), give `SyncLogger` a source-owned `level` and mirror structured `event`/`control`/`terminal` writes; fix the config-abort logger leak (map: 1051–1055).

### Modified — Node/Electron

- `menubar/main.js` — Node `ActivityWriter` in `triggerSync` (acquire+`start`+hold across the dev/runtime guards at 1092–1108; guard block → `blocked`; hand fd to `runtime.runSync`); **cancel-ordering fix** (append `control{cancel_requested}` before `SIGTERM` at 2137, currently recorded at 2178–2184); new context-isolated Activity `BrowserWindow`; tray "Activity" item (in `updateTrayMenu` at 547); route "View Errors" through the Activity reader.
- `menubar/runtime/dispatchers.js` — call the Python bootstrap before the verify guard; carry the lock fd + id; call the Python finalizer on guard failure; last-resort sh `system` line.
- `menubar/runtime/index.js` — `runSync` passes the inherited lock fd + `REPO_RADAR_ACTIVITY_ID` + `owner_token` into the spawned dispatcher env/stdio.
- `menubar/package.json` — add `"test": "node --test"`.
- `menubar/preload.js` + a new `menubar/renderer/activity.{html,js}` — the Activity window renderer (text-only insertion, narrow IPC).

### Module interface contract (names are binding across tasks)

**Python** (`repo_radar/activity/`):
```
ids.mint_activity_id() -> str                      # UUIDv4
ids.valid_activity_id(s) -> bool
ids.mint_token() -> str                            # 8-hex (writer_id / owner_token)
ids.valid_token(s) -> bool

paths.activity_dir(home, activity_id) -> Path
paths.segment_path(home, activity_id, producer, writer_id) -> Path
paths.owner_lock_path(home, activity_id) -> Path
paths.quota_dir(home) -> Path
paths.ledger_entry_path(home, activity_id) -> Path
paths.secure_mkdir(path, mode=0o700) -> None       # reject symlink/non-dir, no perm window
paths.secure_open_append(path, mode=0o600) -> int  # O_NOFOLLOW, returns fd

records.build(type, *, seq, activity_id, **payload) -> dict
records.encode(record: dict) -> bytes              # one UTF-8 line incl "\n"
records.encoded_len(record: dict) -> int
records.RecordTooLarge                              # raised past 20 KiB after truncation

redact.Redactor(configured_secrets: list[str]).scrub(text: str) -> str
redact.load_fixtures() -> list[tuple[str, str]]

lease.acquire(lock_path) -> Lease                   # flock LOCK_EX|LOCK_NB; None if busy
lease.Lease.owner_token: str
lease.Lease.fd: int
lease.Lease.release() -> None
lease.adopt(inherited_fd, owner_token, lock_path) -> Lease   # runs §5 validation; raises HandoffRejected
lease.probe_busy(lock_path) -> bool                 # fresh independent descriptor

quota.admit(home, activity_id, lease) -> bool       # writes entry {reserved:60Ki, granted:0, has_start:0}
quota.grant(home, activity_id, nbytes) -> bool      # batched; False = refuse ordinary write
quota.mark_started(home, activity_id) -> None       # has_start=1
quota.settle(home, activity_id) -> None             # measure on-disk, remove entry
quota.reconcile(home) -> None                       # startup/pre-admission sweep (lease-gated)

writer.ActivityWriter(home, *, kind, channel, trigger, producer,
                      inherited_id=None, inherited_fd=None, owner_token=None)
writer.ActivityWriter.start() -> None
writer.ActivityWriter.event(name, level, **fields) -> None
writer.ActivityWriter.control(name, **fields) -> None       # reserve-eligible, idempotent for cancel_requested
writer.ActivityWriter.terminal(outcome, **summary) -> None  # reserve-backed; settles quota; releases lease
writer.ActivityWriter.integrity(kind, **fields) -> None     # reserve-eligible (single dropped-events note)
writer.ActivityWriter.activity_id: str
writer.ActivityWriter.hand_off_env() -> dict                # {REPO_RADAR_ACTIVITY_ID, ..._OWNER_TOKEN, ..._LOCK_FD}
```

**Node** (`menubar/activity/`): mirrors the above (`validActivityId`, `mintToken`, `segmentPath`, `buildRecord`, `encodeRecord`, `Redactor`, `acquire`, `adopt`, `probeBusy`, `admit`, `grant`, `settle`, `reconcile`, `ActivityWriter`) with camelCase names, plus the reader-only:
```
parse.parseSegment(bytes) -> { records: [...], integrity: [...] }
merge.mergeHeads(segments) -> [record...]                 # k-way by (ts, writerId)
reconcile.reconcile(home, activityId) -> { outcome|null, synthesized: bool }
read.listActivities(home, filter) -> { items: DTO[], truncated: bool }
read.buildExport(home, filter) -> string                  # redacted, in main
```

---

## Phase 1 — Foundation (Python + CLI-driven attempt)

**Deliverable:** the complete durable-record layer in Python — identity, secure storage, record contract + bounds, `flock` lease with `owner_token` handoff + inherited-fd validation, crash-recoverable admission-lock quota ledger, the seven-outcome writer with the reserve partition — all unit-tested, plus a CLI-driven end-to-end attempt that creates → starts → events → finalizes → settles. **Not releasable** (no producers wired, no UI).

Run Python tests with: `python -m pytest repo_radar/tests/ -v`. All new tests live in `repo_radar/tests/`.

### Task 1.1: Identity — mint & validate

**Files:**
- Create: `repo_radar/activity/__init__.py` (empty marker)
- Create: `repo_radar/activity/ids.py`
- Test: `repo_radar/tests/test_activity_ids.py`

**Interfaces:**
- Produces: `mint_activity_id() -> str`, `valid_activity_id(s) -> bool`, `mint_token() -> str`, `valid_token(s) -> bool`, and module constants `ACTIVITY_ID_RE`, `TOKEN_RE`.

- [ ] **Step 1: Write the failing test**

```python
# repo_radar/tests/test_activity_ids.py
from repo_radar.activity import ids

def test_mint_activity_id_is_valid_uuid4():
    for _ in range(50):
        aid = ids.mint_activity_id()
        assert ids.valid_activity_id(aid)

def test_valid_activity_id_rejects_non_v4_and_path_tricks():
    assert not ids.valid_activity_id("")
    assert not ids.valid_activity_id("../etc/passwd")
    assert not ids.valid_activity_id("XABCDEF0-0000-4000-8000-000000000000")  # non-hex
    assert not ids.valid_activity_id("00000000-0000-1000-8000-000000000000")  # version 1
    assert not ids.valid_activity_id("00000000-0000-4000-7000-000000000000")  # variant 7
    assert ids.valid_activity_id("00000000-0000-4000-8000-000000000000")

def test_mint_token_and_validation():
    for _ in range(50):
        t = ids.mint_token()
        assert ids.valid_token(t)
    assert not ids.valid_token("deadbeef0")   # 9 chars
    assert not ids.valid_token("DEADBEEF")    # uppercase
    assert not ids.valid_token("../foo")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest repo_radar/tests/test_activity_ids.py -v`
Expected: FAIL with `ModuleNotFoundError: repo_radar.activity`.

- [ ] **Step 3: Write minimal implementation**

```python
# repo_radar/activity/ids.py
import re, secrets, uuid

ACTIVITY_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
TOKEN_RE = re.compile(r"^[0-9a-f]{8}$")

def mint_activity_id() -> str:
    return str(uuid.uuid4())

def valid_activity_id(s) -> bool:
    return isinstance(s, str) and bool(ACTIVITY_ID_RE.match(s))

def mint_token() -> str:
    return secrets.token_hex(4)

def valid_token(s) -> bool:
    return isinstance(s, str) and bool(TOKEN_RE.match(s))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest repo_radar/tests/test_activity_ids.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add repo_radar/activity/__init__.py repo_radar/activity/ids.py repo_radar/tests/test_activity_ids.py
git commit -m "feat(activity): identity mint + validation (ids.py)"
```

### Task 1.2: Secure paths — create & validate storage

**Files:**
- Create: `repo_radar/activity/paths.py`
- Test: `repo_radar/tests/test_activity_paths.py`

**Interfaces:**
- Consumes: `ids.valid_activity_id`, `ids.valid_token`.
- Produces: `activity_dir(home, activity_id) -> Path`, `segment_path(home, activity_id, producer, writer_id) -> Path`, `owner_lock_path(home, activity_id) -> Path`, `quota_dir(home) -> Path`, `ledger_entry_path(home, activity_id) -> Path`, `secure_mkdir(path, mode=0o700) -> None`, `secure_open_append(path, mode=0o600) -> int`. Raises `UnsafePath` on symlink/non-dir/invalid-id.

- [ ] **Step 1: Write the failing test**

```python
# repo_radar/tests/test_activity_paths.py
import os, stat
import pytest
from repo_radar.activity import paths

VALID = "00000000-0000-4000-8000-000000000000"

def test_activity_dir_rejects_bad_id(tmp_path):
    with pytest.raises(paths.UnsafePath):
        paths.activity_dir(tmp_path, "../escape")

def test_secure_mkdir_is_0700_and_rejects_symlink(tmp_path):
    d = paths.activity_dir(tmp_path, VALID)
    paths.secure_mkdir(d)
    assert stat.S_IMODE(os.lstat(d).st_mode) == 0o700
    # a symlink at the target must be rejected, not followed
    victim = tmp_path / "victim"; victim.mkdir()
    link = paths.quota_dir(tmp_path)   # reuse a fresh path
    os.symlink(victim, link)
    with pytest.raises(paths.UnsafePath):
        paths.secure_mkdir(link)

def test_secure_open_append_is_0600_and_appends(tmp_path):
    d = paths.activity_dir(tmp_path, VALID); paths.secure_mkdir(d)
    seg = paths.segment_path(tmp_path, VALID, "python", "deadbeef")
    fd = paths.secure_open_append(seg)
    os.write(fd, b"line1\n"); os.close(fd)
    fd = paths.secure_open_append(seg)
    os.write(fd, b"line2\n"); os.close(fd)
    assert seg.read_bytes() == b"line1\nline2\n"
    assert stat.S_IMODE(os.lstat(seg).st_mode) == 0o600

def test_segment_path_rejects_bad_producer_and_writer(tmp_path):
    with pytest.raises(paths.UnsafePath):
        paths.segment_path(tmp_path, VALID, "python", "BADWRITER")
    with pytest.raises(paths.UnsafePath):
        paths.segment_path(tmp_path, VALID, "hacker", "deadbeef")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest repo_radar/tests/test_activity_paths.py -v`
Expected: FAIL (`ModuleNotFoundError`).

- [ ] **Step 3: Write minimal implementation**

```python
# repo_radar/activity/paths.py
import os
from pathlib import Path
from repo_radar.activity import ids

PRODUCERS = {"electron", "dispatcher", "python"}

class UnsafePath(Exception):
    pass

def _base(home) -> Path:
    return Path(home) / "Library" / "Logs" / "repo-radar" / "activity"

def activity_dir(home, activity_id) -> Path:
    if not ids.valid_activity_id(activity_id):
        raise UnsafePath(f"invalid activity_id: {activity_id!r}")
    return _base(home) / activity_id

def segment_path(home, activity_id, producer, writer_id) -> Path:
    if producer not in PRODUCERS:
        raise UnsafePath(f"invalid producer: {producer!r}")
    if not ids.valid_token(writer_id):
        raise UnsafePath(f"invalid writer_id: {writer_id!r}")
    return activity_dir(home, activity_id) / f"{producer}-{writer_id}.jsonl"

def owner_lock_path(home, activity_id) -> Path:
    return activity_dir(home, activity_id) / "owner.lock"

def quota_dir(home) -> Path:
    return _base(home) / "quota"

def ledger_entry_path(home, activity_id) -> Path:
    if not ids.valid_activity_id(activity_id):
        raise UnsafePath(f"invalid activity_id: {activity_id!r}")
    return quota_dir(home) / f"{activity_id}.entry"

def secure_mkdir(path, mode=0o700) -> None:
    path = Path(path)
    if path.is_symlink():
        raise UnsafePath(f"refuses symlink: {path}")
    if path.exists() and not path.is_dir():
        raise UnsafePath(f"exists as non-directory: {path}")
    path.parent.mkdir(parents=True, exist_ok=True, mode=mode)
    try:
        os.mkdir(path, mode)            # atomic create with final mode (no perm window)
    except FileExistsError:
        if Path(path).is_symlink() or not Path(path).is_dir():
            raise UnsafePath(f"raced to unsafe type: {path}")
    os.chmod(path, mode)

def secure_open_append(path, mode=0o600) -> int:
    flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW
    return os.open(path, flags, mode)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest repo_radar/tests/test_activity_paths.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add repo_radar/activity/paths.py repo_radar/tests/test_activity_paths.py
git commit -m "feat(activity): secure storage paths (0700/0600, symlink-safe)"
```

### Task 1.3: Record contract — build, bound, encode

**Files:**
- Create: `repo_radar/activity/records.py`
- Test: `repo_radar/tests/test_activity_records.py`

**Interfaces:**
- Produces: `build(type, *, seq, activity_id, **payload) -> dict`, `encode(record) -> bytes` (one UTF-8 line incl `\n`), `encoded_len(record) -> int`, exception `RecordTooLarge`, and bound constants `MAX_KEYS=32`, `MAX_KEY_BYTES=64`, `MAX_VALUE_BYTES=1024`, `MAX_FIELDS_BYTES=8192`, `MAX_DETAIL_BYTES=8192`, `MAX_RECORD_BYTES=20480`, `SCHEMA_VERSION=1`. Truncation of `detail`/over-long values appends a visible `"…[truncated N bytes]"` marker and sets `record["_truncated"]=True`.

- [ ] **Step 1: Write the failing test**

```python
# repo_radar/tests/test_activity_records.py
import json
from repo_radar.activity import records as R

AID = "00000000-0000-4000-8000-000000000000"

def test_build_and_encode_roundtrip():
    rec = R.build("event", seq=0, activity_id=AID, level="info",
                  event="repos_loaded", fields={"count": 30})
    line = R.encode(rec)
    assert line.endswith(b"\n") and line.count(b"\n") == 1
    back = json.loads(line)
    assert back["schema_version"] == R.SCHEMA_VERSION
    assert back["type"] == "event" and back["seq"] == 0 and back["activity_id"] == AID
    assert back["fields"]["count"] == 30
    assert R.encoded_len(rec) == len(line)

def test_detail_over_8kib_is_truncated_with_marker():
    rec = R.build("event", seq=1, activity_id=AID, level="error",
                  event="pull_failed", fields={}, detail="x" * 20000)
    assert rec["_truncated"] is True
    assert rec["detail"].encode("utf-8").__len__() <= R.MAX_DETAIL_BYTES
    assert "truncated" in rec["detail"]

def test_too_many_or_too_long_fields_are_bounded():
    rec = R.build("event", seq=2, activity_id=AID, level="info", event="x",
                  fields={f"k{i}": i for i in range(100)})
    assert len(rec["fields"]) <= R.MAX_KEYS
    big = R.build("event", seq=3, activity_id=AID, level="info", event="x",
                  fields={"v": "y" * 5000})
    assert len(json.dumps(big["fields"]).encode()) <= R.MAX_FIELDS_BYTES

def test_reserved_record_stays_under_20kib_including_newline():
    rec = R.build("terminal", seq=9, activity_id=AID, outcome="failed",
                  summary={"repos_changed": 0, "errors": 1, "warns": 0}, by="deadbeef")
    assert R.encoded_len(rec) <= R.MAX_RECORD_BYTES
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest repo_radar/tests/test_activity_records.py -v`
Expected: FAIL (`ModuleNotFoundError`).

- [ ] **Step 3: Write minimal implementation**

```python
# repo_radar/activity/records.py
import json
from datetime import datetime, timezone

SCHEMA_VERSION = 1
MAX_KEYS = 32
MAX_KEY_BYTES = 64
MAX_VALUE_BYTES = 1024
MAX_FIELDS_BYTES = 8192
MAX_DETAIL_BYTES = 8192
MAX_RECORD_BYTES = 20480

class RecordTooLarge(Exception):
    pass

def _now_iso():
    return datetime.now(timezone.utc).astimezone().isoformat()

def _truncate(s: str, limit: int):
    b = s.encode("utf-8")
    if len(b) <= limit:
        return s, False
    marker = "…[truncated {} bytes]"
    # reserve room for the marker
    keep = b[: max(0, limit - len(marker.format(len(b)).encode()))]
    # avoid splitting a UTF-8 sequence
    kept = keep.decode("utf-8", "ignore")
    return kept + marker.format(len(b) - len(kept.encode())), True

def _bound_fields(fields):
    truncated = False
    out = {}
    for i, (k, v) in enumerate(fields.items()):
        if i >= MAX_KEYS:
            truncated = True
            break
        k = str(k)[:MAX_KEY_BYTES]
        if isinstance(v, str):
            v, t = _truncate(v, MAX_VALUE_BYTES)
            truncated = truncated or t
        elif not isinstance(v, (int, float, bool)) and v is not None:
            v = str(v)[:MAX_VALUE_BYTES]; truncated = True
        out[k] = v
    # aggregate cap
    while len(json.dumps(out, ensure_ascii=False).encode()) > MAX_FIELDS_BYTES and out:
        out.pop(next(reversed(out)))
        truncated = True
    return out, truncated

def build(type, *, seq, activity_id, **payload):
    rec = {"schema_version": SCHEMA_VERSION, "activity_id": activity_id,
           "type": type, "seq": seq, "ts": _now_iso()}
    truncated = False
    if "fields" in payload:
        payload["fields"], t = _bound_fields(payload["fields"]); truncated |= t
    if "detail" in payload and payload["detail"] is not None:
        payload["detail"], t = _truncate(str(payload["detail"]), MAX_DETAIL_BYTES); truncated |= t
    rec.update(payload)
    if truncated:
        rec["_truncated"] = True
    if encoded_len(rec) > MAX_RECORD_BYTES:
        raise RecordTooLarge(f"{type} record exceeds {MAX_RECORD_BYTES} bytes")
    return rec

def encode(record) -> bytes:
    return (json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")

def encoded_len(record) -> int:
    return len(encode(record))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest repo_radar/tests/test_activity_records.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add repo_radar/activity/records.py repo_radar/tests/test_activity_records.py
git commit -m "feat(activity): record contract with per-record byte bounds + truncation"
```

### Task 1.4: Write-time redaction + shared fixtures

**Files:**
- Create: `repo_radar/activity/redact.py`
- Create: `repo_radar/activity/redaction_fixtures.json`
- Test: `repo_radar/tests/test_activity_redact.py`

**Interfaces:**
- Produces: `Redactor(configured_secrets: list[str]).scrub(text) -> str`, `load_fixtures() -> list[tuple[str,str]]`. Masks the credential forms from spec §4 (`sk-…`, `ghp_…`/`github_pat_…`, `AIza…`, `Bearer …`, `//user:pass@`) plus every non-empty configured secret value (longest-first, so overlapping secrets fully mask).

- [ ] **Step 1: Write the fixtures file**

```json
[
  ["Authorization: Bearer sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA", "Authorization: [REDACTED authorization]"],
  ["key sk-proj-ABCDEFGHIJKLMNOPQRSTUV", "key [REDACTED api key]"],
  ["token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "token [REDACTED github token]"],
  ["token github_pat_11ABCDE0000abcdefghij_KLMNOPQRSTUVWXYZ0123456789abcdefghij", "token [REDACTED github token]"],
  ["gemini AIzaSyA0000000000000000000000000000000", "gemini [REDACTED google key]"],
  ["clone https://user:s3cr3t@github.com/x/y.git", "clone https://<redacted>@github.com/x/y.git"]
]
```

- [ ] **Step 2: Write the failing test**

```python
# repo_radar/tests/test_activity_redact.py
from repo_radar.activity import redact

def test_credential_forms_from_shared_fixtures():
    r = redact.Redactor(configured_secrets=[])
    for raw, expected in redact.load_fixtures():
        assert r.scrub(raw) == expected

def test_configured_secret_value_is_masked_even_if_unpatterned():
    r = redact.Redactor(configured_secrets=["hunter2superlong-configured-value"])
    assert "hunter2superlong-configured-value" not in r.scrub(
        "debug: password=hunter2superlong-configured-value trailing")

def test_overlapping_secrets_mask_fully_longest_first():
    r = redact.Redactor(configured_secrets=["abc", "abcdef123456"])
    assert "abcdef123456" not in r.scrub("val=abcdef123456")
```

- [ ] **Step 3: Run test to verify it fails**

Run: `python -m pytest repo_radar/tests/test_activity_redact.py -v`
Expected: FAIL (`ModuleNotFoundError`).

- [ ] **Step 4: Write minimal implementation**

```python
# repo_radar/activity/redact.py
import json, re
from pathlib import Path

_FIXTURES = Path(__file__).with_name("redaction_fixtures.json")

_FORMS = [
    (re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._\-]{16,}"), "[REDACTED authorization]"),
    (re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"), "[REDACTED github token]"),
    (re.compile(r"github_pat_[A-Za-z0-9_]{20,}"), "[REDACTED github token]"),
    (re.compile(r"sk-(?:ant-)?[A-Za-z0-9._\-]{16,}"), "[REDACTED api key]"),
    (re.compile(r"AIza[A-Za-z0-9_\-]{20,}"), "[REDACTED google key]"),
    (re.compile(r"//[^/@\s]+@"), "//<redacted>@"),
]

def load_fixtures():
    return [tuple(pair) for pair in json.loads(_FIXTURES.read_text())]

class Redactor:
    def __init__(self, configured_secrets):
        self._secrets = sorted({s for s in configured_secrets if s}, key=len, reverse=True)

    def scrub(self, text):
        if text is None:
            return text
        s = str(text)
        for secret in self._secrets:            # configured values first (longest-first)
            s = s.replace(secret, "[REDACTED]")
        for pat, repl in _FORMS:
            s = pat.sub(repl, s)
        return s
```

- [ ] **Step 5: Run test to verify it passes**

Run: `python -m pytest repo_radar/tests/test_activity_redact.py -v`
Expected: PASS (3 tests). (The `github_pat_` fixture matches before `gh[pousr]_`; order preserved.)

- [ ] **Step 6: Commit**

```bash
git add repo_radar/activity/redact.py repo_radar/activity/redaction_fixtures.json repo_radar/tests/test_activity_redact.py
git commit -m "feat(activity): write-time redaction + shared cross-language fixtures"
```

### Task 1.5: The `flock` lease — acquire, adopt/validate, probe

**Files:**
- Create: `repo_radar/activity/lease.py`
- Test: `repo_radar/tests/test_activity_lease.py`

**Interfaces:**
- Consumes: `ids.mint_token`, `paths.owner_lock_path`, `paths.secure_mkdir`.
- Produces: `acquire(lock_path) -> Lease|None` (None if busy), `Lease` with `.owner_token`, `.fd`, `.release()`; `adopt(inherited_fd, owner_token, lock_path) -> Lease` (raises `HandoffRejected` unless §5 validation passes); `probe_busy(lock_path) -> bool` (fresh independent descriptor). Validation order is exactly §5: syntactic → `fstat` identity vs a fresh non-symlink `stat` → independent-busy → inherited-fd reassert.

- [ ] **Step 1: Write the failing test**

```python
# repo_radar/tests/test_activity_lease.py
import os
import pytest
from repo_radar.activity import lease, paths, ids

VALID = "00000000-0000-4000-8000-000000000000"

def _lock(tmp_path):
    d = paths.activity_dir(tmp_path, VALID); paths.secure_mkdir(d)
    return paths.owner_lock_path(tmp_path, VALID)

def test_acquire_is_exclusive_and_probe_busy(tmp_path):
    lp = _lock(tmp_path)
    l1 = lease.acquire(lp)
    assert l1 is not None and ids.valid_token(l1.owner_token)
    assert lease.probe_busy(lp) is True          # independent probe sees it held
    assert lease.acquire(lp) is None             # second acquire fails (busy)
    l1.release()
    assert lease.probe_busy(lp) is False
    assert lease.acquire(lp) is not None         # now free

def test_adopt_accepts_genuine_inherited_descriptor(tmp_path):
    lp = _lock(tmp_path)
    holder = lease.acquire(lp)                    # simulates Electron holding
    dup = os.dup(holder.fd)                       # simulates fd inheritance
    adopted = lease.adopt(dup, holder.owner_token, lp)
    assert adopted.owner_token == holder.owner_token   # SAME token, one logical lease

def test_adopt_rejects_unlocked_matching_descriptor(tmp_path):
    lp = _lock(tmp_path)
    # right inode, but nobody holds the lock -> independent probe would succeed -> reject
    fd = os.open(lp, os.O_RDWR)
    with pytest.raises(lease.HandoffRejected):
        lease.adopt(fd, "deadbeef", lp)

def test_adopt_rejects_when_a_different_lease_holds_the_inode(tmp_path):
    lp = _lock(tmp_path)
    other = lease.acquire(lp)                     # a DIFFERENT lease holds it
    fd = os.open(lp, os.O_RDWR)                   # our inherited fd does NOT share it
    with pytest.raises(lease.HandoffRejected):    # independent busy, reassert fails
        lease.adopt(fd, "deadbeef", lp)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest repo_radar/tests/test_activity_lease.py -v`
Expected: FAIL (`ModuleNotFoundError`).

- [ ] **Step 3: Write minimal implementation**

```python
# repo_radar/activity/lease.py
import fcntl, os
from repo_radar.activity import ids

class HandoffRejected(Exception):
    pass

class Lease:
    def __init__(self, fd, owner_token):
        self.fd = fd
        self.owner_token = owner_token
    def release(self):
        if self.fd is not None:
            try:
                fcntl.flock(self.fd, fcntl.LOCK_UN)
            finally:
                os.close(self.fd); self.fd = None

def acquire(lock_path):
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd); return None
    return Lease(fd, ids.mint_token())

def probe_busy(lock_path) -> bool:
    """Fresh independent open-file description: True if someone else holds it."""
    fd = os.open(lock_path, os.O_RDWR | os.O_NOFOLLOW)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(fd, fcntl.LOCK_UN)     # we got it -> it was free
        return False
    except OSError:
        return True                        # busy
    finally:
        os.close(fd)

def adopt(inherited_fd, owner_token, lock_path) -> Lease:
    # (1) syntactic
    if not (isinstance(inherited_fd, int) and inherited_fd >= 0 and ids.valid_token(owner_token)):
        raise HandoffRejected("bad fd/token syntax")
    # (2) fstat identity vs a fresh non-symlink stat of the expected path
    try:
        fst = os.fstat(inherited_fd)
        pst = os.stat(lock_path, follow_symlinks=False)
    except OSError as e:
        raise HandoffRejected(f"stat failed: {e}")
    if (fst.st_dev, fst.st_ino) != (pst.st_dev, pst.st_ino):
        raise HandoffRejected("fd is not this activity's owner.lock")
    # (3) independent probe MUST report busy (someone holds the lease)
    if not probe_busy(lock_path):
        raise HandoffRejected("no lease held on this inode (unlocked look-alike)")
    # (4) reassert on the INHERITED fd itself MUST succeed (shares the holding OFD)
    try:
        fcntl.flock(inherited_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        raise HandoffRejected("inherited fd does not carry the lease")
    return Lease(inherited_fd, owner_token)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest repo_radar/tests/test_activity_lease.py -v`
Expected: PASS (4 tests). This is the §5 truth table in code: accept only on independent-busy AND inherited-reassert-succeeds.

- [ ] **Step 5: Commit**

```bash
git add repo_radar/activity/lease.py repo_radar/tests/test_activity_lease.py
git commit -m "feat(activity): flock lease with exact inherited-descriptor validation (§5)"
```

### Task 1.6: Crash-recoverable admission-lock quota ledger

**Files:**
- Create: `repo_radar/activity/quota.py`
- Test: `repo_radar/tests/test_activity_quota.py`

**Interfaces:**
- Consumes: `paths.quota_dir`, `paths.ledger_entry_path`, `paths.owner_lock_path`, `paths.secure_mkdir`, `lease.acquire`.
- Produces: `admit(home, activity_id, lease) -> bool`, `grant(home, activity_id, nbytes) -> bool`, `mark_started(home, activity_id) -> None`, `settle(home, activity_id) -> None`, `reconcile(home) -> None`; constants `CEILING=64*1024*1024`, `RESERVE=60*1024`, `PER_ACTIVITY_CAP=4*1024*1024`. Ledger entry is the `key=value` file from Decision 3. All mutating ops hold `quota.lock` (BSD `flock`). Invariant: **charge = committed(scan) + Σ_live max(0, reserved+granted−on_disk) + Σ_corrupt 4 MiB**, and `admit`/`grant` require `charge + request ≤ CEILING`.

- [ ] **Step 1: Write the failing test** (the crash-safety invariants Codex required)

```python
# repo_radar/tests/test_activity_quota.py
import os
from repo_radar.activity import quota, paths, lease, ids

def _mk(tmp_path, aid):
    d = paths.activity_dir(tmp_path, aid); paths.secure_mkdir(d)
    paths.secure_mkdir(paths.quota_dir(tmp_path))
    return paths.owner_lock_path(tmp_path, aid)

def _new_activity(tmp_path):
    aid = ids.mint_activity_id(); lp = _mk(tmp_path, aid)
    return aid, lease.acquire(lp)

def test_admit_grant_settle_happy_path(tmp_path):
    aid, l = _new_activity(tmp_path)
    assert quota.admit(tmp_path, aid, l) is True
    assert paths.ledger_entry_path(tmp_path, aid).exists()
    assert quota.grant(tmp_path, aid, 1000) is True
    quota.settle(tmp_path, aid)
    assert not paths.ledger_entry_path(tmp_path, aid).exists()   # entry removed

def test_grant_before_append_overcounts_never_undercounts(tmp_path):
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l)
    quota.grant(tmp_path, aid, 500_000)          # granted, nothing appended yet -> overcount
    entry = paths.ledger_entry_path(tmp_path, aid).read_text()
    assert "granted=500000" in entry             # charged before any on-disk bytes

def test_reconcile_preserves_live_reserve_before_start_when_lease_held(tmp_path):
    aid, l = _new_activity(tmp_path)             # lease HELD, has_start=0 (reserve-before-start)
    quota.admit(tmp_path, aid, l)
    quota.reconcile(tmp_path)                     # must NOT reclaim: lease is held
    assert paths.ledger_entry_path(tmp_path, aid).exists()

def test_reconcile_releases_abandoned_no_start_when_lease_free(tmp_path):
    aid, l = _new_activity(tmp_path)
    quota.admit(tmp_path, aid, l)
    l.release()                                  # producer "died" before start
    quota.reconcile(tmp_path)
    assert not paths.ledger_entry_path(tmp_path, aid).exists()   # abandoned reservation freed

def test_corrupt_entry_charges_full_4mib_and_blocks_admission(tmp_path):
    aid, l = _new_activity(tmp_path)
    paths.secure_mkdir(paths.quota_dir(tmp_path))
    paths.ledger_entry_path(tmp_path, aid).write_text("garbage-not-kv")   # torn entry
    # a fresh activity now cannot admit near the ceiling because 4 MiB is charged
    aid2, l2 = _new_activity(tmp_path)
    # force near-ceiling: emulate by shrinking the ceiling for the test via monkeypatch
    quota.CEILING, saved = 4 * 1024 * 1024 + 1024, quota.CEILING
    try:
        assert quota.admit(tmp_path, aid2, l2) is False   # 4 MiB corrupt liability blocks it
    finally:
        quota.CEILING = saved
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest repo_radar/tests/test_activity_quota.py -v`
Expected: FAIL (`ModuleNotFoundError`).

- [ ] **Step 3: Write minimal implementation**

```python
# repo_radar/activity/quota.py
import fcntl, os, tempfile
from pathlib import Path
from repo_radar.activity import paths, lease as lease_mod

CEILING = 64 * 1024 * 1024
RESERVE = 60 * 1024
PER_ACTIVITY_CAP = 4 * 1024 * 1024

def _quota_lock(home):
    paths.secure_mkdir(paths.quota_dir(home))
    lp = paths.quota_dir(home) / "quota.lock"
    fd = os.open(lp, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)          # blocking; brief critical section
    return fd

def _unlock(fd):
    fcntl.flock(fd, fcntl.LOCK_UN); os.close(fd)

def _read_entry(path):
    """Returns dict or the sentinel 'CORRUPT'."""
    try:
        kv = {}
        for line in Path(path).read_text().splitlines():
            k, _, v = line.partition("=")
            kv[k] = int(v)
        return {"reserved": kv["reserved"], "granted": kv["granted"], "has_start": kv["has_start"]}
    except Exception:
        return "CORRUPT"

def _write_entry(path, reserved, granted, has_start):
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=d)
    os.write(fd, f"reserved={reserved}\ngranted={granted}\nhas_start={has_start}\n".encode())
    os.close(fd); os.chmod(tmp, 0o600); os.replace(tmp, path)     # atomic

def _on_disk(home, activity_id):
    d = paths.activity_dir(home, activity_id)
    return sum(f.stat().st_size for f in d.glob("*.jsonl")) if d.exists() else 0

def _committed(home):
    base = paths.quota_dir(home).parent
    return sum(f.stat().st_size for f in base.glob("*/*.jsonl"))

def _charge(home):
    total = _committed(home)
    qd = paths.quota_dir(home)
    if qd.exists():
        for entry in qd.glob("*.entry"):
            aid = entry.stem
            e = _read_entry(entry)
            if e == "CORRUPT":
                total += PER_ACTIVITY_CAP
            else:
                total += max(0, e["reserved"] + e["granted"] - _on_disk(home, aid))
    return total

def admit(home, activity_id, lease):
    fd = _quota_lock(home)
    try:
        if _charge(home) + RESERVE > CEILING:
            _prune(home)
            if _charge(home) + RESERVE > CEILING:
                return False                       # best-effort refuse
        _write_entry(paths.ledger_entry_path(home, activity_id), RESERVE, 0, 0)
        return True
    finally:
        _unlock(fd)

def grant(home, activity_id, nbytes):
    fd = _quota_lock(home)
    try:
        p = paths.ledger_entry_path(home, activity_id)
        e = _read_entry(p)
        if e == "CORRUPT":
            return False
        if _charge(home) + nbytes > CEILING:
            return False
        _write_entry(p, e["reserved"], e["granted"] + nbytes, e["has_start"])
        return True
    finally:
        _unlock(fd)

def mark_started(home, activity_id):
    fd = _quota_lock(home)
    try:
        p = paths.ledger_entry_path(home, activity_id); e = _read_entry(p)
        if e != "CORRUPT":
            _write_entry(p, e["reserved"], e["granted"], 1)
    finally:
        _unlock(fd)

def settle(home, activity_id):
    fd = _quota_lock(home)
    try:
        p = paths.ledger_entry_path(home, activity_id)
        if p.exists():
            os.unlink(p)                           # bytes now counted purely by the scan
    finally:
        _unlock(fd)

def _has_terminal(home, activity_id):
    d = paths.activity_dir(home, activity_id)
    return d.exists() and any(b'"type":"terminal"' in f.read_bytes() for f in d.glob("*.jsonl"))

def reconcile(home):
    fd = _quota_lock(home)
    try:
        qd = paths.quota_dir(home)
        if not qd.exists():
            return
        for entry in list(qd.glob("*.entry")):
            aid = entry.stem
            e = _read_entry(entry)
            if e == "CORRUPT":
                if _has_terminal(home, aid) and not lease_mod.probe_busy(paths.owner_lock_path(home, aid)):
                    os.unlink(entry)               # settle from segments+lease evidence
                continue                           # else keep the 4 MiB charge (via _charge)
            if _has_terminal(home, aid):
                os.unlink(entry); continue         # durable terminal -> settle
            if e["has_start"] == 0:                # reserve-before-start: LEASE-GATED
                l = lease_mod.acquire(paths.owner_lock_path(home, aid))
                if l is not None:                  # lease free -> producer gone -> abandoned
                    l.release(); os.unlink(entry)
                # else: lease held -> preserve the charge (do nothing)
    finally:
        _unlock(fd)

def _prune(home):
    """Placeholder-free stub for Phase 1: no prunable settled items exist yet in unit
    scope; full age/prune-order lands in Task 3.x (Node retention). Kept a no-op here so
    admission fails closed rather than deleting live data."""
    return
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest repo_radar/tests/test_activity_quota.py -v`
Expected: PASS (6 tests). Note the `_prune` no-op is intentional in Phase 1 — Python producers never prune; retention/prune is the Node reader's job (Task 3.5). Admission simply fails closed if there is no room, which is the safe direction.

- [ ] **Step 5: Commit**

```bash
git add repo_radar/activity/quota.py repo_radar/tests/test_activity_quota.py
git commit -m "feat(activity): crash-recoverable admission-lock quota ledger (§7)"
```

### Task 1.7: `ActivityWriter` — segment writer + reserve partition + finalizer

**Files:**
- Create: `repo_radar/activity/writer.py`
- Modify: `repo_radar/activity/__init__.py` (re-export `ActivityWriter`)
- Test: `repo_radar/tests/test_activity_writer.py`

**Interfaces:**
- Consumes: everything above (`ids`, `paths`, `records`, `redact`, `lease`, `quota`).
- Produces: `ActivityWriter(home, *, kind, channel, trigger, producer, configured_secrets=(), inherited_id=None, inherited_fd=None, owner_token=None)`; methods `start()`, `event(name, level, **fields)`, `control(name, **fields)`, `terminal(outcome, **summary)`, `integrity(kind, **fields)`, `hand_off_env() -> dict`, property `activity_id`. Enforces: adopt-vs-mint; the 20 KiB×3 reserve partition; `event`/`start` refused once ordinary capacity (`grant`) is exhausted while `control`/`terminal`/`integrity` still write; `cancel_requested` idempotent; best-effort (a write failure emits one warning to stderr and never raises into the caller); `terminal` settles quota + releases the lease.

- [ ] **Step 1: Write the failing test**

```python
# repo_radar/tests/test_activity_writer.py
import json, os
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
    w.start()
    w.event("repos_loaded", "info", count=30)
    w.terminal("succeeded", repos_changed=2, errors=0, warns=0)
    recs = _read_all(tmp_path, w.activity_id)
    types = [r["type"] for r in recs]
    owner_token = w._lease.owner_token   # release() clears the fd but preserves owner_token
    assert types[0] == "start" and "event" in types and types[-1] == "terminal"
    assert recs[-1]["outcome"] == "succeeded" and recs[-1]["by"] == owner_token
    assert not paths.ledger_entry_path(tmp_path, w.activity_id).exists()   # settled
    assert lease.acquire(paths.owner_lock_path(tmp_path, w.activity_id)) is not None  # released

def test_cancel_requested_control_is_idempotent(tmp_path):
    w = writer.ActivityWriter(tmp_path, kind="sync", channel="stable",
                              trigger="cli", producer="python")
    w.start(); w.control("cancel_requested"); w.control("cancel_requested")
    recs = [r for r in _read_all(tmp_path, w.activity_id)
            if r["type"] == "control" and r.get("name") == "cancel_requested"]
    assert len(recs) == 1                          # written at most once

def test_terminal_writes_into_reserve_even_when_ordinary_capacity_exhausted(tmp_path, monkeypatch):
    w = writer.ActivityWriter(tmp_path, kind="sync", channel="stable",
                              trigger="cli", producer="python")
    w.start()
    monkeypatch.setattr(quota, "grant", lambda *a, **k: False)   # ordinary capacity gone
    w.event("dropped", "info", x=1)                # refused (no crash)
    w.terminal("failed", repos_changed=0, errors=1, warns=0)     # still lands (reserve)
    assert any(r["type"] == "terminal" for r in _read_all(tmp_path, w.activity_id))

def test_best_effort_write_failure_never_raises(tmp_path, monkeypatch, capsys):
    w = writer.ActivityWriter(tmp_path, kind="sync", channel="stable",
                              trigger="cli", producer="python")
    monkeypatch.setattr(paths, "secure_open_append",
                        lambda *a, **k: (_ for _ in ()).throw(OSError("disk full")))
    w.start()                                       # must not raise
    assert "activity" in capsys.readouterr().err.lower()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest repo_radar/tests/test_activity_writer.py -v`
Expected: FAIL (`ModuleNotFoundError`).

- [ ] **Step 3: Write minimal implementation**

```python
# repo_radar/activity/writer.py
import os, sys
from repo_radar.activity import ids, paths, records, quota, redact
from repo_radar.activity import lease as lease_mod

_RESERVE_TYPES = {"control", "terminal", "integrity"}

class ActivityWriter:
    def __init__(self, home, *, kind, channel, trigger, producer,
                 configured_secrets=(), inherited_id=None, inherited_fd=None, owner_token=None):
        self._home = home
        self._kind = kind; self._channel = channel; self._trigger = trigger
        self._producer = producer
        self._redactor = redact.Redactor(list(configured_secrets))
        self._seq = 0
        self._writer_id = ids.mint_token()
        self._cancel_written = False
        self._dropped_noted = False
        self._closed = False
        self._adopted = bool(inherited_id) and ids.valid_activity_id(inherited_id)
        lock = paths.owner_lock_path
        if self._adopted:
            self.activity_id = inherited_id
            self._lease = lease_mod.adopt(inherited_fd, owner_token, lock(home, inherited_id))
        else:
            self.activity_id = ids.mint_activity_id()
            paths.secure_mkdir(paths.activity_dir(home, self.activity_id))
            self._lease = lease_mod.acquire(lock(home, self.activity_id))
            self._admitted = quota.admit(home, self.activity_id, self._lease)
            if not self._admitted:                 # best-effort: skip recording, free lease
                self._warn("admission refused; skipping activity recording")
                self._lease.release(); self._closed = True
        self._seg = paths.segment_path(home, self.activity_id, producer, self._writer_id)

    # ---- record emission ------------------------------------------------
    def _warn(self, msg):
        print(f"repo-radar: activity: {msg}", file=sys.stderr)

    def _append(self, rec, reserve=False):
        if self._closed:
            return
        try:
            blob = records.encode(rec)
            if not reserve:
                if not quota.grant(self._home, self.activity_id, len(blob)):
                    return False                   # ordinary capacity exhausted -> refuse
            fd = paths.secure_open_append(self._seg)
            try:
                os.write(fd, blob)
            finally:
                os.close(fd)
            self._seq += 1
            return True
        except Exception as e:                     # best-effort: never raise into caller
            self._warn(f"write failed: {e}")
            return False

    def start(self):
        if self._adopted:                          # adopters write ownership, not a 2nd start
            self._append(records.build("ownership", seq=self._seq, activity_id=self.activity_id,
                                       owner_token=self._lease.owner_token, role="handoff",
                                       producer=self._producer, pid=os.getpid()))
            return
        self._append(records.build("start", seq=self._seq, activity_id=self.activity_id,
                                   kind=self._kind, channel=self._channel,
                                   trigger=self._trigger, created_by=self._producer))
        self._append(records.build("ownership", seq=self._seq, activity_id=self.activity_id,
                                   owner_token=self._lease.owner_token, role="initial",
                                   producer=self._producer, pid=os.getpid()))
        quota.mark_started(self._home, self.activity_id)

    def event(self, name, level, **fields):
        fields = {k: self._redactor.scrub(v) if isinstance(v, str) else v
                  for k, v in fields.items()}
        ok = self._append(records.build("event", seq=self._seq, activity_id=self.activity_id,
                                        level=level, event=name, fields=fields))
        if ok is False and not self._dropped_noted:
            self._dropped_noted = True
            self._append(records.build("integrity", seq=self._seq, activity_id=self.activity_id,
                                       kind="dropped-events"), reserve=True)

    def control(self, name, **fields):
        if name == "cancel_requested":
            if self._cancel_written:
                return
            self._cancel_written = True
        self._append(records.build("control", seq=self._seq, activity_id=self.activity_id,
                                   name=name, fields=fields), reserve=True)

    def integrity(self, kind, **fields):
        self._append(records.build("integrity", seq=self._seq, activity_id=self.activity_id,
                                   kind=kind, fields=fields), reserve=True)

    def terminal(self, outcome, **summary):
        if self._closed:
            return
        self._append(records.build("terminal", seq=self._seq, activity_id=self.activity_id,
                                   outcome=outcome, summary=summary,
                                   by=self._lease.owner_token), reserve=True)
        quota.settle(self._home, self.activity_id)
        self._lease.release()
        self._closed = True

    def hand_off_env(self):
        return {"REPO_RADAR_ACTIVITY_ID": self.activity_id,
                "REPO_RADAR_ACTIVITY_OWNER_TOKEN": self._lease.owner_token,
                "REPO_RADAR_ACTIVITY_LOCK_FD": str(self._lease.fd)}
```

Also add to `repo_radar/activity/__init__.py`:
```python
from repo_radar.activity.writer import ActivityWriter   # noqa: F401
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest repo_radar/tests/test_activity_writer.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add repo_radar/activity/writer.py repo_radar/activity/__init__.py repo_radar/tests/test_activity_writer.py
git commit -m "feat(activity): ActivityWriter — reserve partition, idempotent cancel, best-effort, finalizer"
```

### Task 1.8: Dispatcher entrypoints — `bootstrap` (adopt+start) and `finalize` (terminal/incident)

These let the POSIX-sh dispatcher (Phase 2) delegate all record/lease/quota work to Python (Decision 2). `bootstrap` **adopts** the shell-held lease fd, admits, and writes `start`+`ownership`, then exits leaving the fd held by the shell. `finalize` writes a terminal — adopting an inherited fd when present, else self-contained mint→start→terminal→settle→release for a pure pre-attempt incident.

**Files:**
- Create: `repo_radar/activity/bootstrap.py`
- Create: `repo_radar/activity/finalize.py`
- Test: `repo_radar/tests/test_activity_entrypoints.py`

**Interfaces:**
- Consumes: `ActivityWriter`, `lease`, env `REPO_RADAR_ACTIVITY_ID` / `_OWNER_TOKEN` / `_LOCK_FD`.
- Produces: `python -m repo_radar.activity.bootstrap --kind K --channel C --trigger T` (adopt-only; requires the three env vars) and `python -m repo_radar.activity.finalize --outcome O [--kind K --channel C --trigger T --reason R]`.

- [ ] **Step 1: Write the failing test** (subprocess boundary — the real handoff)

```python
# repo_radar/tests/test_activity_entrypoints.py
import json, os, subprocess, sys
from repo_radar.activity import paths, ids, lease

def _seg_records(home, aid):
    d = paths.activity_dir(home, aid); recs = []
    for f in sorted(d.glob("*.jsonl")):
        recs += [json.loads(x) for x in f.read_text().splitlines()]
    return recs

def test_bootstrap_adopts_shell_held_fd_and_writes_start(tmp_path):
    aid = ids.mint_activity_id()
    paths.secure_mkdir(paths.activity_dir(tmp_path, aid))
    held = lease.acquire(paths.owner_lock_path(tmp_path, aid))   # simulates the shell holding fd
    env = {**os.environ, "HOME": str(tmp_path),
           "REPO_RADAR_ACTIVITY_ID": aid,
           "REPO_RADAR_ACTIVITY_OWNER_TOKEN": held.owner_token,
           "REPO_RADAR_ACTIVITY_LOCK_FD": str(held.fd)}
    r = subprocess.run([sys.executable, "-m", "repo_radar.activity.bootstrap",
                        "--kind", "sync", "--channel", "stable", "--trigger", "scheduled"],
                       env=env, pass_fds=[held.fd], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    recs = _seg_records(tmp_path, aid)
    assert any(x["type"] == "start" for x in recs)
    assert any(x["type"] == "ownership" and x["role"] == "handoff" for x in recs)
    assert lease.probe_busy(paths.owner_lock_path(tmp_path, aid))   # shell still holds it

def test_finalize_standalone_records_blocked_incident(tmp_path):
    r = subprocess.run([sys.executable, "-m", "repo_radar.activity.finalize",
                        "--kind", "system", "--channel", "dev", "--trigger", "scheduled",
                        "--outcome", "blocked", "--reason", "interpreter_fingerprint_mismatch"],
                       env={**os.environ, "HOME": str(tmp_path)}, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    # exactly one activity dir, containing start + blocked terminal, lease released
    base = paths.quota_dir(tmp_path).parent
    dirs = [p for p in base.iterdir() if p.is_dir() and p.name != "quota"]
    assert len(dirs) == 1
    recs = _seg_records(tmp_path, dirs[0].name)
    assert recs[0]["type"] == "start" and recs[-1]["type"] == "terminal"
    assert recs[-1]["outcome"] == "blocked"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest repo_radar/tests/test_activity_entrypoints.py -v`
Expected: FAIL (`No module named repo_radar.activity.bootstrap`).

- [ ] **Step 3: Write minimal implementation**

```python
# repo_radar/activity/bootstrap.py
import argparse, os, sys
from repo_radar.activity import ids
from repo_radar.activity.writer import ActivityWriter

def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--kind", required=True); ap.add_argument("--channel", required=True)
    ap.add_argument("--trigger", required=True)
    a = ap.parse_args(argv)
    home = os.environ.get("HOME")
    aid = os.environ.get("REPO_RADAR_ACTIVITY_ID")
    token = os.environ.get("REPO_RADAR_ACTIVITY_OWNER_TOKEN")
    fd = os.environ.get("REPO_RADAR_ACTIVITY_LOCK_FD")
    if not (ids.valid_activity_id(aid) and token and fd):
        print("repo-radar: activity: bootstrap missing/invalid handoff env", file=sys.stderr)
        return 0                                   # best-effort: never block the sync
    try:
        w = ActivityWriter(home, kind=a.kind, channel=a.channel, trigger=a.trigger,
                           producer="dispatcher", inherited_id=aid,
                           inherited_fd=int(fd), owner_token=token)
        w.start()
    except Exception as e:
        print(f"repo-radar: activity: bootstrap failed: {e}", file=sys.stderr)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
```

```python
# repo_radar/activity/finalize.py
import argparse, os, sys
from repo_radar.activity import ids
from repo_radar.activity.writer import ActivityWriter

def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--kind", default="sync"); ap.add_argument("--channel", required=True)
    ap.add_argument("--trigger", required=True); ap.add_argument("--outcome", required=True)
    ap.add_argument("--reason", default=None)
    a = ap.parse_args(argv)
    home = os.environ.get("HOME")
    aid = os.environ.get("REPO_RADAR_ACTIVITY_ID")
    token = os.environ.get("REPO_RADAR_ACTIVITY_OWNER_TOKEN")
    fd = os.environ.get("REPO_RADAR_ACTIVITY_LOCK_FD")
    try:
        if ids.valid_activity_id(aid) and token and fd:      # adopt shell-held lease
            w = ActivityWriter(home, kind=a.kind, channel=a.channel, trigger=a.trigger,
                               producer="dispatcher", inherited_id=aid,
                               inherited_fd=int(fd), owner_token=token)
        else:                                                # self-contained incident
            w = ActivityWriter(home, kind=a.kind, channel=a.channel, trigger=a.trigger,
                               producer="dispatcher")
            w.start()
        summary = {"reason": a.reason} if a.reason else {}
        w.terminal(a.outcome, **summary)
    except Exception as e:
        print(f"repo-radar: activity: finalize failed: {e}", file=sys.stderr)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest repo_radar/tests/test_activity_entrypoints.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add repo_radar/activity/bootstrap.py repo_radar/activity/finalize.py repo_radar/tests/test_activity_entrypoints.py
git commit -m "feat(activity): dispatcher bootstrap/finalize entrypoints"
```

### Task 1.9: Phase-1 acceptance — CLI-driven attempt + crash reconcile

The spec's Phase 1 exit criterion: a CLI-driven attempt, plus proof the quota ledger self-heals after an abnormal termination. No new production code — this is the foundation's end-to-end gate.

**Files:**
- Test: `repo_radar/tests/test_activity_phase1_acceptance.py`

- [ ] **Step 1: Write the failing test**

```python
# repo_radar/tests/test_activity_phase1_acceptance.py
import json, os, subprocess, sys
from repo_radar.activity import writer, paths, quota, lease, ids

def _records(home, aid):
    d = paths.activity_dir(home, aid); recs = []
    for f in sorted(d.glob("*.jsonl")):
        recs += [json.loads(x) for x in f.read_text().splitlines()]
    return recs

def test_full_cli_style_attempt_end_to_end(tmp_path):
    w = writer.ActivityWriter(tmp_path, kind="sync", channel="stable",
                              trigger="cli", producer="python",
                              configured_secrets=["ghp_shouldnotappear000000000000000000"])
    w.start()
    w.event("repos_loaded", "info", count=30)
    w.event("repo_updated", "info", repo="ReperioHealth/x", old="aaa", new="bbb")
    w.event("pull_failed", "error", repo="y",
            detail="fatal: could not read Username ghp_shouldnotappear000000000000000000")
    w.terminal("succeeded-with-warnings", repos_changed=1, errors=1, warns=0)
    recs = _records(tmp_path, w.activity_id)
    assert [r["type"] for r in recs][0] == "start"
    assert recs[-1]["type"] == "terminal" and recs[-1]["outcome"] == "succeeded-with-warnings"
    blob = json.dumps(recs)
    assert "ghp_shouldnotappear" not in blob            # write-time redaction held
    assert not paths.ledger_entry_path(tmp_path, w.activity_id).exists()   # settled

def test_crash_before_terminal_leaves_recoverable_ledger(tmp_path):
    # simulate: admit + start, then process "dies" (lease released, no terminal, no settle)
    aid = ids.mint_activity_id(); paths.secure_mkdir(paths.activity_dir(tmp_path, aid))
    l = lease.acquire(paths.owner_lock_path(tmp_path, aid))
    quota.admit(tmp_path, aid, l); quota.mark_started(tmp_path, aid)
    l.release()                                          # crash: lease freed, entry stranded
    assert paths.ledger_entry_path(tmp_path, aid).exists()
    # a durable terminal is absent + lease free -> reconcile must NOT reclaim a started run's
    # reservation as "abandoned" (has_start=1); it stays until the reader synthesizes a terminal
    quota.reconcile(tmp_path)
    assert paths.ledger_entry_path(tmp_path, aid).exists()   # preserved (started, no terminal)

def test_reconcile_reclaims_only_abandoned_pre_start(tmp_path):
    aid = ids.mint_activity_id(); paths.secure_mkdir(paths.activity_dir(tmp_path, aid))
    l = lease.acquire(paths.owner_lock_path(tmp_path, aid))
    quota.admit(tmp_path, aid, l)                        # reserved, NO start
    l.release()                                          # died pre-start, lease free
    quota.reconcile(tmp_path)
    assert not paths.ledger_entry_path(tmp_path, aid).exists()
```

- [ ] **Step 2: Run to verify it fails, then make it pass**

Run: `python -m pytest repo_radar/tests/test_activity_phase1_acceptance.py -v`. `test_crash_before_terminal...` will likely FAIL against the Task-1.6 `reconcile`, which only checks `has_start==0`. **Fix `quota.reconcile`** so a started-but-unterminated entry with a *free* lease is preserved (it is the reader that later synthesizes the terminal, §5): the `has_start==1 and not _has_terminal` case must fall through to "preserve", which the current code already does (it only reclaims `has_start==0`). Confirm the started-run entry is preserved and the pre-start one is reclaimed. If the test exposes a gap, correct `reconcile` minimally and re-run.

- [ ] **Step 3: Commit**

```bash
git add repo_radar/tests/test_activity_phase1_acceptance.py repo_radar/activity/quota.py
git commit -m "test(activity): phase-1 acceptance — CLI attempt + crash-recoverable reconcile"
```

**Phase 1 gate:** `python -m pytest repo_radar/tests/ -v` is green (all existing + new). Request an `implementation-review` checkpoint over the whole Phase-1 range before starting Phase 2.

---

## Phase 2 — Producers + propagation

**Deliverable:** every real entry path (Electron manual, scheduled dispatcher, direct CLI) establishes identity + lease + `start` before its first failure gate and threads a live `ActivityWriter` through the sync; `SyncLogger` gains source-owned severity and mirrors structured records; pre-attempt failures become System incidents. Requires a Node write-side mirror of the Phase-1 layer (Decision 1). **Not releasable** (no reader/UI yet).

Node tests: add `"test": "node --test"` to `menubar/package.json` (Decision 4); run `cd menubar && node --test`.

### Task 2.1: Node mirror of ids/paths/records + golden-record equivalence

**Files:**
- Create: `menubar/activity/ids.js`, `menubar/activity/paths.js`, `menubar/activity/records.js`, `menubar/activity/index.js`
- Modify: `menubar/package.json` (add `test` script)
- Test: `menubar/activity/__tests__/records-golden.test.js`, `menubar/activity/__tests__/ids.test.js`
- Test (Python side of the golden pair): `repo_radar/tests/test_activity_golden.py`

**Interfaces:**
- Produces (CommonJS): `validActivityId`, `mintActivityId`, `mintToken`, `validToken` (ids.js); `activityDir`, `segmentPath`, `ownerLockPath`, `quotaDir`, `ledgerEntryPath`, `secureMkdir`, `secureOpenAppend` (paths.js); `buildRecord`, `encodeRecord`, `encodedLen` (records.js). **Byte-identical** JSON line encoding to `records.py`: same key order via insertion order, `ensure_ascii=false` equivalent (UTF-8, no `\uXXXX` escaping of non-ASCII), compact separators (`,`/`:`), trailing `\n`.

**The equivalence is pinned by a shared golden file**, not by re-deriving the code: both suites read `menubar/activity/__tests__/golden-records.json` (a list of `{args, bytes}` where `bytes` is the exact expected line). If a future edit diverges, both languages' golden tests fail.

- [ ] **Step 1: Author the golden file** `menubar/activity/__tests__/golden-records.json`

```json
[
  {"type":"event","seq":0,"activity_id":"00000000-0000-4000-8000-000000000000",
   "level":"info","event":"repos_loaded","fields":{"count":30},
   "line":"{\"schema_version\":1,\"activity_id\":\"00000000-0000-4000-8000-000000000000\",\"type\":\"event\",\"seq\":0,\"ts\":\"<TS>\",\"level\":\"info\",\"event\":\"repos_loaded\",\"fields\":{\"count\":30}}\n"}
]
```
(The `<TS>` placeholder is substituted by each test with a fixed injected timestamp — both `buildRecord`/`build` accept an optional `ts=` override for determinism; add that parameter to both `records.py` and `records.js`.)

- [ ] **Step 2: Write the failing tests**

```js
// menubar/activity/__tests__/records-golden.test.js
const test = require('node:test'); const assert = require('node:assert');
const fs = require('node:fs'); const path = require('node:path');
const { buildRecord, encodeRecord } = require('../records');
const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden-records.json')));

test('node encodes each golden record byte-for-byte', () => {
  for (const g of golden) {
    const { line, ...args } = g;
    const rec = buildRecord(args.type, { ...args, ts: '2026-08-14T00:00:00-07:00' });
    const expected = line.replace('<TS>', '2026-08-14T00:00:00-07:00');
    assert.strictEqual(Buffer.from(encodeRecord(rec)).toString('utf8'), expected);
  }
});
```

```python
# repo_radar/tests/test_activity_golden.py
import json, pathlib
from repo_radar.activity import records as R
GOLD = pathlib.Path("menubar/activity/__tests__/golden-records.json")

def test_python_encodes_each_golden_record_byte_for_byte():
    for g in json.loads(GOLD.read_text()):
        line = g.pop("line"); typ = g.pop("type")
        rec = R.build(typ, ts="2026-08-14T00:00:00-07:00", **g)
        expected = line.replace("<TS>", "2026-08-14T00:00:00-07:00")
        assert R.encode(rec).decode("utf-8") == expected
```

- [ ] **Step 3: Run both to verify they fail**

Run: `cd menubar && node --test activity/__tests__/records-golden.test.js` → FAIL (no module).
Run: `python -m pytest repo_radar/tests/test_activity_golden.py -v` → FAIL (`build()` has no `ts=` param yet).

- [ ] **Step 4: Implement `ids.js`/`paths.js`/`records.js` as exact CommonJS mirrors of the Python modules** (same regexes, same bounds constants, same encoding). Add the `ts=`/`ts:` override parameter to both `records.py.build` and `records.js.buildRecord`. Add `"test": "node --test"` to `menubar/package.json` `scripts`.

- [ ] **Step 5: Run both to verify they pass**

Run: `cd menubar && node --test` and `python -m pytest repo_radar/tests/test_activity_golden.py -v` → both PASS. This is the cross-language contract: the two encoders now provably agree.

- [ ] **Step 6: Commit**

```bash
git add menubar/activity/ids.js menubar/activity/paths.js menubar/activity/records.js menubar/activity/index.js menubar/activity/__tests__/ menubar/package.json repo_radar/activity/records.py repo_radar/tests/test_activity_golden.py
git commit -m "feat(activity): Node ids/paths/records mirror + golden-record equivalence"
```

### Task 2.2: Node lease + quota + writer (write side) + cross-language lock interop

**Files:**
- Create: `menubar/activity/lease.js`, `menubar/activity/quota.js`, `menubar/activity/writer.js`
- Test: `menubar/activity/__tests__/lease.test.js`, `menubar/activity/__tests__/quota.test.js`, `menubar/activity/__tests__/writer.test.js`, `menubar/activity/__tests__/lock-interop.test.js`

**Interfaces:**
- Produces (CommonJS mirror of Python write side): `acquire(lockPath)`, `adopt(inheritedFd, ownerToken, lockPath)`, `probeBusy(lockPath)`, `admit`, `grant`, `markStarted`, `settle`, `reconcile`, `ActivityWriter` (Electron manual path: `start`, `event`, `control`, `terminal`, `integrity`, `handOffEnv()`, `activityId`). Node holds the lease via a retained fd + `/usr/bin/lockf -t 0 <fd>` (spec §5); `probeBusy` spawns `/usr/bin/lockf -t 0` on a fresh fd and reads exit 75.

- [ ] **Step 1: Write the failing cross-language interop test** (the load-bearing one)

```js
// menubar/activity/__tests__/lock-interop.test.js
const test = require('node:test'); const assert = require('node:assert');
const cp = require('node:child_process'); const fs = require('node:fs'); const os = require('node:os');
const path = require('node:path');
const { acquire, probeBusy } = require('../lease');
const { activityDir, ownerLockPath, secureMkdir } = require('../paths');

test('a lock taken in Node is seen BUSY by Python, and vice-versa', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'act-'));
  const aid = '00000000-0000-4000-8000-000000000000';
  secureMkdir(activityDir(home, aid));
  const lp = ownerLockPath(home, aid);
  const lease = acquire(lp);
  assert.ok(lease, 'node acquired');
  // Python probe must report busy
  const py = cp.spawnSync('python3', ['-c',
    `import sys;from repo_radar.activity import lease;` +
    `sys.exit(0 if lease.probe_busy(${JSON.stringify(lp)}) else 3)`],
    { env: { ...process.env } });
  assert.strictEqual(py.status, 0, 'python saw the Node lock as busy');
  lease.release();
  assert.strictEqual(probeBusy(lp), false);
});
```

- [ ] **Step 2..5:** Run → FAIL; implement `lease.js`/`quota.js`/`writer.js` mirroring the Python semantics (ledger `key=value`, same constants, same §5 validation truth table, same reserve partition); add unit tests mirroring `test_activity_lease.py`/`test_activity_quota.py`/`test_activity_writer.py`; run → PASS.

- [ ] **Step 6: Commit**

```bash
git add menubar/activity/lease.js menubar/activity/quota.js menubar/activity/writer.js menubar/activity/__tests__/
git commit -m "feat(activity): Node lease/quota/writer (write side) + cross-language lock interop"
```

### Task 2.3: Electron `triggerSync` — acquire, start, hold across guards, hand off; cancel-ordering fix

**Files:**
- Modify: `menubar/main.js` — `triggerSync` (1078–1121), the `runtime.runSync` call site (1317), the `stop-sync` handler (2115–2192)
- Test: `menubar/__tests__/activity-trigger.test.js`

**Interfaces:**
- Consumes: `menubar/activity` (`ActivityWriter`), `menubar/activity/quota.reconcile`.
- Produces: on manual sync, an `ActivityWriter` minted+held in `triggerSync`; guard block (dev-ownership gate 1092–1108) → `writer.terminal('blocked', reason)`; on dispatch, `writer.handOffEnv()` + the lock fd passed to `runtime.runSync`; on cancel, `writer.control('cancel_requested')` appended **before** `SIGTERM`.

- [ ] **Step 1: Write the failing test** (cancel-ordering — the spec's named race)

```js
// menubar/__tests__/activity-trigger.test.js
const test = require('node:test'); const assert = require('node:assert');
// Load the extracted, testable helpers (see Step 3): triggerSync's activity glue is
// factored into menubar/activity/trigger-glue.js so it is unit-testable without Electron.
const { onCancel } = require('../activity/trigger-glue');

test('cancel appends control{cancel_requested} BEFORE SIGTERM', () => {
  const calls = [];
  const writer = { control: (n) => calls.push('control:' + n) };
  const child = { kill: (sig) => calls.push('kill:' + sig) };
  onCancel({ writer, child });
  assert.deepStrictEqual(calls, ['control:cancel_requested', 'kill:SIGTERM']);
});
```

- [ ] **Step 2: Run → FAIL** (`trigger-glue` missing).

- [ ] **Step 3: Implement.** Create `menubar/activity/trigger-glue.js` exporting the small pure helpers (`beginManualActivity(home, opts)`, `onGuardBlock(writer, reason)`, `onCancel({writer, child})`, `handOff(writer)`), each doing exactly what the spec requires. Then wire them into `main.js`:
  - In `triggerSync` **after** the already-syncing guard (1082) and **before** the dev-ownership gate (1092): `const activity = beginManualActivity(os.homedir(), { channel: runtimeChannel, trigger });` (mints, acquires, `start`, holds the fd).
  - In the dev-ownership block (1096–1106) and the second dispatch guard (1289): call `onGuardBlock(activity.writer, reason)` (writes `blocked` terminal + releases) alongside the existing error-surface code.
  - At the `runtime.runSync` call (1317): spread `...activity.writer.handOffEnv()` into `shellEnv` and pass `activity.lockFd` for inheritance (Task 2.4 consumes it).
  - In the `stop-sync` handler: replace the ordering so `onCancel({ writer: activity.writer, child: currentSyncProcess })` runs — appending `control{cancel_requested}` (2178-side work) **before** `currentSyncProcess.kill('SIGTERM')` (2137). This closes the spec §5 cancel-ordering race.
  - On app start, call `require('./activity/quota').reconcile(os.homedir())` once (pre-admission sweep).

- [ ] **Step 4: Run → PASS.** Also manually verify (documented, not automated): a dev-guard block now produces an Activity item with outcome `blocked` instead of only an `errorLog` string.

- [ ] **Step 5: Commit**

```bash
git add menubar/main.js menubar/activity/trigger-glue.js menubar/__tests__/activity-trigger.test.js
git commit -m "feat(activity): Electron manual path — lease across guards, blocked terminal, cancel-ordering fix"
```

### Task 2.4: Dispatcher + `runSync` — carry the lease, delegate to Python, last-resort sh incident

**Files:**
- Modify: `menubar/runtime/index.js` (`runSync` 132–149), `menubar/runtime/dispatchers.js` (`_script` 11–111)
- Test: `menubar/runtime/__tests__/dispatcher-activity.test.js`

**Interfaces:**
- Consumes: `REPO_RADAR_ACTIVITY_ID` / `_OWNER_TOKEN` / `_LOCK_FD` from the env, the inherited lock fd.
- Produces: `runSync` adds the lock fd to the child `stdio` (fd 4) and forwards the three env vars; the generated `_script` (scheduled path) mints id+token via `uuidgen`/`openssl rand -hex 4`, opens+`lockf`s `owner.lock` on a dedicated fd, calls `python -m repo_radar.activity.bootstrap` **before** the verify guard, calls `python -m repo_radar.activity.finalize --outcome blocked` on a guard failure, and `exec`s python (which adopts as executing owner) on success. A last-resort pure-sh `system` incident line is written only if the bootstrap python cannot execute at all.

- [ ] **Step 1: Write the failing test** (the generated script contains the required ordering)

```js
// menubar/runtime/__tests__/dispatcher-activity.test.js
const test = require('node:test'); const assert = require('node:assert');
const { _script } = require('../dispatchers');   // export _script for testing

test('scheduled script bootstraps activity BEFORE the verify guard and finalizes on block', () => {
  const s = _script('stable', ' sync --status-server');
  const iBootstrap = s.indexOf('activity.bootstrap');
  const iVerify = s.indexOf('verify.py');
  const iFinalize = s.indexOf('activity.finalize');
  assert.ok(iBootstrap > 0 && iVerify > 0 && iBootstrap < iVerify, 'bootstrap precedes verify');
  assert.ok(iFinalize > 0, 'finalize path present for guard failure');
  assert.ok(s.includes('REPO_RADAR_ACTIVITY_ID'), 'exports identity');
});
```

- [ ] **Step 2..5:** Run → FAIL; implement the `_script` additions (mint id/token, open+lockf `owner.lock` on a fd kept open across the guards, bootstrap call, finalize-on-guard-failure, last-resort sh line) and the `runSync` fd/env passing; run → PASS. Preserve the existing root `.exec.lock` fd-9 handshake untouched.

- [ ] **Step 6: Commit**

```bash
git add menubar/runtime/index.js menubar/runtime/dispatchers.js menubar/runtime/__tests__/dispatcher-activity.test.js
git commit -m "feat(activity): dispatcher carries the lease + delegates records to Python"
```

### Task 2.5: Python CLI — identity before dependency checking

**Files:**
- Modify: `repo_radar/cli.py` (insert before line 53, the `check_dependencies()` gate)
- Test: `repo_radar/tests/test_cli_activity.py`

**Interfaces:**
- Consumes: `ActivityWriter`, env handoff vars.
- Produces: for `sync` (and `configure`/`analyze` where an attempt makes sense), `cli.main` establishes/adopts the activity + lease + `start` **before** `check_dependencies()`, so a dependency failure is a durable `blocked` incident. A `sync` invocation that already carries a valid handoff env **adopts** (executing owner) rather than minting.

- [ ] **Step 1: Write the failing test**

```python
# repo_radar/tests/test_cli_activity.py
import os, subprocess, sys
from repo_radar.activity import paths

def test_dependency_failure_records_blocked_incident(tmp_path, monkeypatch):
    # Force check_dependencies to fail in a child, assert a blocked terminal was written.
    env = {**os.environ, "HOME": str(tmp_path), "REPO_RADAR_FORCE_DEPS_FAIL": "1"}
    subprocess.run([sys.executable, "-m", "repo_radar.cli", "sync", "--dry-run"], env=env)
    base = paths.quota_dir(tmp_path).parent
    dirs = [p for p in base.iterdir() if p.is_dir() and p.name != "quota"]
    assert dirs, "an activity was recorded before the dependency gate"
```

- [ ] **Step 2..4:** Run → FAIL; implement: near the top of `main()` (after the `clean` branch, before `check_dependencies()`), for `command in {"sync","configure","analyze"}`, build/adopt an `ActivityWriter`, `start()`, and stash it for `sync_mode` to adopt; a `check_dependencies()` failure calls `writer.terminal("blocked", reason="dependencies")` before `return 2`. Add a test-only `REPO_RADAR_FORCE_DEPS_FAIL` hook in `dependencies.check_dependencies`. Run → PASS.

- [ ] **Step 5: Commit**

```bash
git add repo_radar/cli.py repo_radar/dependencies.py repo_radar/tests/test_cli_activity.py
git commit -m "feat(activity): CLI establishes identity+lease+start before dependency checking"
```

### Task 2.6: `sync_mode` + `SyncLogger` — thread the writer, source-owned severity, System incidents

**Files:**
- Modify: `repo_radar/modes/sync.py` — `SyncLogger` (48–104), `sync_mode` (894–1675), early exits (931–940 unknown-model; 1033–1049 network; 1051–1055 config-leak fix)
- Test: `repo_radar/tests/test_sync_activity.py`

**Interfaces:**
- Consumes: the adopted `ActivityWriter` (from `cli.py`) or mints one; `records`/`redact` severity rule.
- Produces: `SyncLogger.event`/`error` also emit the structured `event` record with a source-owned `level` assigned **by rule** (§3): ordinary retry/wait/recovery = `info`; degraded-but-completed = `warn`; exhausted retry/timeout/abort = `error`. `sync_mode` writes the authoritative `terminal` mapping to one of the seven outcomes (unknown-model → `blocked`; catch-up satisfied → `skipped`; network abort → `failed`; clean → `succeeded`; degraded/repo-skipped → `succeeded-with-warnings`; worker failure → `failed`). The unknown-model early exit (before the old logger) now records a durable incident. Fix the config-abort logger leak (1051–1055 now closes/records).

- [ ] **Step 1: Write the failing test**

```python
# repo_radar/tests/test_sync_activity.py
from repo_radar.modes import sync as S

def test_severity_rule_mapping():
    assert S._activity_level("info-ish", is_degraded=False, is_exhausted=False) == "info"
    assert S._activity_level("x", is_degraded=True, is_exhausted=False) == "warn"
    assert S._activity_level("x", is_degraded=False, is_exhausted=True) == "error"

def test_outcome_mapping_is_the_seven():
    assert S._finalize_outcome(errors=0, warns=0, degraded=False) == "succeeded"
    assert S._finalize_outcome(errors=0, warns=1, degraded=True) == "succeeded-with-warnings"
    assert S._finalize_outcome(errors=2, warns=0, degraded=False) == "failed"
```

- [ ] **Step 2..4:** Run → FAIL; extract the pure helpers `_activity_level(...)` and `_finalize_outcome(...)` and thread the writer through `sync_mode`, calling `writer.event(...)` alongside each `sync_logger.event/error`, `writer.terminal(outcome, ...)` at each return, and `writer.control`/`integrity` where appropriate; give the unknown-model early exit (931–940) a `blocked` terminal; close the config-abort leak. Run → PASS.

- [ ] **Step 5: Commit**

```bash
git add repo_radar/modes/sync.py repo_radar/tests/test_sync_activity.py
git commit -m "feat(activity): sync_mode threads ActivityWriter; SyncLogger source-owned severity; System incidents"
```

### Task 2.7: Cross-process macOS integration (the spec's headline test)

**Files:**
- Test: `repo_radar/tests/test_activity_integration.py` (marked `@pytest.mark.integration`, macOS-gated)

- [ ] **Step 1: Write the test**

Drive a real attempt end to end at the process boundary: acquire a lease in a parent, `pass_fds` it through a `/bin/sh -c` that `exec`s `python -m repo_radar.activity.bootstrap` then a second python that adopts + writes a `terminal`; assert the segment shows `start` → `ownership(handoff)` → `terminal(by=<owner_token>)` with the **same** `owner_token`, and the lease is released after the terminal. Then a **simulated crash**: acquire + `start` + `ownership`, `os.kill(child, SIGKILL)` before terminal, then assert `probe_busy` is False (freed) and `quota.reconcile` preserves the started entry (the reader will synthesize `interrupted` in Phase 3).

- [ ] **Step 2: Run → PASS** on macOS: `python -m pytest repo_radar/tests/test_activity_integration.py -v -m integration`. **Proves** the advisory lease survives spawn-inheritance + `exec` and the handoff carries one continuous `owner_token`.

- [ ] **Step 3: Commit**

```bash
git add repo_radar/tests/test_activity_integration.py
git commit -m "test(activity): cross-process lease survival + owner_token continuity (macOS)"
```

**Phase 2 gate:** both suites green (`python -m pytest repo_radar/tests/ -v`; `cd menubar && node --test`). Request an `implementation-review` checkpoint over the full Phase-2 range (it couples Node write-side, Electron, dispatcher, and Python — review the coupling surface, not just the last task).

---

## Phase 3 — Reader / redactor Node module (pure, testable)

**Deliverable:** `menubar/activity/` gains the pure read path — parse, merge, lock-probe reconciliation, read-time redaction, retention/prune, and bounded-DTO assembly — with no Electron dependency. **Not releasable** (no UI yet), but this is where crash reconciliation becomes observable.

### Task 3.1: `parse.js` — per-segment JSONL with truncation + corruption tolerance

**Files:** Create `menubar/activity/parse.js`; Test `menubar/activity/__tests__/parse.test.js`.

**Interfaces:** `parseSegment(bytes) -> { records, integrity }`. Rules (§2, §6): a truncated **trailing** line (no final `\n`, or unparseable last line at EOF) is dropped **silently**; an **interior** unparseable line yields an `integrity` finding and does **not** hide later valid lines; `seq` must be strictly increasing within the segment (a regression yields an `integrity` finding); an **unsupported** `schema_version` yields a `unsupported-schema` integrity finding and is not parsed as v1, while other lines remain.

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test'); const assert = require('node:assert');
const { parseSegment } = require('../parse');
const line = (o) => JSON.stringify(o) + '\n';

test('drops a truncated trailing line silently, keeps the rest', () => {
  const buf = Buffer.from(line({schema_version:1,type:'start',seq:0,ts:'t'}) + '{"type":"eve');
  const { records, integrity } = parseSegment(buf);
  assert.strictEqual(records.length, 1);
  assert.strictEqual(integrity.length, 0);
});

test('interior corruption is an integrity finding but later lines survive', () => {
  const buf = Buffer.from(
    line({schema_version:1,type:'start',seq:0,ts:'t'}) +
    'GARBAGE\n' +
    line({schema_version:1,type:'terminal',seq:1,ts:'t',outcome:'succeeded'}));
  const { records, integrity } = parseSegment(buf);
  assert.strictEqual(records.length, 2);          // start + terminal preserved
  assert.strictEqual(integrity.length, 1);        // the interior garbage flagged
});

test('unsupported schema_version does not parse as v1', () => {
  const buf = Buffer.from(line({schema_version:999,type:'start',seq:0,ts:'t'}));
  const { records, integrity } = parseSegment(buf);
  assert.strictEqual(records.length, 0);
  assert.match(integrity[0].kind, /unsupported-schema/);
});

test('seq regression within a segment is flagged', () => {
  const buf = Buffer.from(
    line({schema_version:1,type:'event',seq:5,ts:'t'}) +
    line({schema_version:1,type:'event',seq:2,ts:'t'}));
  const { integrity } = parseSegment(buf);
  assert.ok(integrity.some(i => /seq/.test(i.kind)));
});
```

- [ ] **Step 2-4:** Run → FAIL; implement `parseSegment` (split on `\n`; last element without trailing newline = trailing-truncation candidate, dropped; each interior line: `JSON.parse` in try/catch → integrity on failure; check `schema_version===1` else unsupported-schema integrity; track `lastSeq` for strict-increase). Run → PASS.

- [ ] **Step 5: Commit** `feat(activity): segment JSONL parser (truncation + corruption tolerant)`.

### Task 3.2: `merge.js` — k-way merge preserving per-writer order

**Files:** Create `menubar/activity/merge.js`; Test `menubar/activity/__tests__/merge.test.js`.

**Interfaces:** `mergeHeads(segments) -> [record]` where `segments` is an array of per-segment record arrays (already in append order). Merge by `(ts, writerId)` across segment **heads**, always advancing the chosen segment — so **per-segment append order is preserved even if `ts` steps backward** (the property a global `(ts,writerId,seq)` sort would break, §2).

- [ ] **Step 1: Write the failing test** (the backwards-clock property)

```js
const test = require('node:test'); const assert = require('node:assert');
const { mergeHeads } = require('../merge');

test('per-writer append order survives a backwards wall-clock step', () => {
  const segA = [                                   // writerId 'aaaaaaaa'
    { ts: '2026-08-14T10:00:02', writerId: 'aaaaaaaa', seq: 0, event: 'A0' },
    { ts: '2026-08-14T10:00:01', writerId: 'aaaaaaaa', seq: 1, event: 'A1' }, // clock went back
  ];
  const segB = [{ ts: '2026-08-14T10:00:01', writerId: 'bbbbbbbb', seq: 0, event: 'B0' }];
  const merged = mergeHeads([segA, segB]).map(r => r.event);
  // A0 must precede A1 regardless of ts; B0 interleaves by (ts, writerId)
  assert.ok(merged.indexOf('A0') < merged.indexOf('A1'));
});
```

- [ ] **Step 2-4:** Run → FAIL; implement a heap/linear k-way merge that only ever compares **current heads** by `(ts, writerId)` and pops from the winning segment (never reorders within a segment). Run → PASS.

- [ ] **Step 5: Commit** `feat(activity): k-way segment merge preserving per-writer order`.

### Task 3.3: `reconcile.js` — lock-probe reconciliation + conflict/duplicate

**Files:** Create `menubar/activity/reconcile.js`; Test `menubar/activity/__tests__/reconcile.test.js`.

**Interfaces:** `reconcile(home, activityId) -> { outcome|null, synthesized }`. Semantics (§5, §6): for a `running` attempt (has `start`, no `terminal`) — `acquire` the lock non-blocking; **cannot acquire ⇒ leave `running`** (`outcome:null`); **acquired (or lock absent) ⇒ owner gone** → synthesize `interrupted`, or `cancelled` if a `control{cancel_requested}` exists, **retain the lock until the synthetic terminal is durably appended**, then release + `quota.settle`; probe error ⇒ leave `running` + a System integrity warning. Duplicate terminals (same outcome) group with a count; **conflicting** terminals (different outcomes) ⇒ `interrupted` + an integrity Problem (§6).

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test'); const assert = require('node:assert');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { reconcile } = require('../reconcile');
const { activityDir, ownerLockPath, segmentPath, secureMkdir } = require('../paths');
const { acquire } = require('../lease');

function seed(home, aid, lines) {
  secureMkdir(activityDir(home, aid));
  fs.writeFileSync(segmentPath(home, aid, 'python', 'deadbeef'),
    lines.map(o => JSON.stringify(o)).join('\n') + '\n');
}

test('freed lock + no cancel => interrupted (synthesized, durable)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'act-'));
  const aid = '00000000-0000-4000-8000-000000000000';
  seed(home, aid, [{schema_version:1,type:'start',seq:0,ts:'t',kind:'sync'}]);
  const r = reconcile(home, aid);
  assert.strictEqual(r.outcome, 'interrupted');
  assert.ok(r.synthesized);
  // durable: a terminal line is now present with by:'reconciler'
  const buf = fs.readFileSync(segmentPath(home, aid, 'python', 'deadbeef'), 'utf8');
  assert.match(buf, /"type":"terminal".*"by":"reconciler"/);
});

test('held lock => stays running', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'act-'));
  const aid = '00000000-0000-4000-8000-000000000000';
  seed(home, aid, [{schema_version:1,type:'start',seq:0,ts:'t',kind:'sync'}]);
  const held = acquire(ownerLockPath(home, aid));
  assert.strictEqual(reconcile(home, aid).outcome, null);   // running
  held.release();
});

test('cancel_requested + freed lock => cancelled', () => { /* seed start+control, assert 'cancelled' */ });
test('conflicting terminals => interrupted + integrity', () => { /* seed two terminals, assert */ });
```

- [ ] **Step 2-4:** Run → FAIL; implement using `parse`+`merge` to assemble records, `lease.acquire`/`probeBusy` for the probe, the reconciler synthesizes+appends via the write-side `records`/segment append (producer `python`, a reconciler writer-id), retains the lock until durable, then `quota.settle`. Run → PASS.

- [ ] **Step 5: Commit** `feat(activity): lock-probe reconciliation + conflict/duplicate handling`.

### Task 3.4: `redact.js` (read-time backstop) + parity with Python

**Files:** Create `menubar/activity/redact.js`; Test `menubar/activity/__tests__/redact.test.js` (loads the shared fixtures).

**Interfaces:** `Redactor(configuredSecrets).scrub(text)` — same credential forms + configured secrets as `redact.py`, proven by loading `../../repo_radar/activity/redaction_fixtures.json`. This is the read/export boundary (spec §4); it supersedes reliance on `runtime/hashing.js:redact` for Activity content.

- [ ] **Step 1: Write the failing parity test**

```js
const test = require('node:test'); const assert = require('node:assert');
const fs = require('node:fs'); const path = require('node:path');
const { Redactor } = require('../redact');
const fixtures = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'repo_radar', 'activity', 'redaction_fixtures.json')));

test('node read-time redactor masks every shared fixture identically to Python', () => {
  const r = new Redactor([]);
  for (const [raw, expected] of fixtures) assert.strictEqual(r.scrub(raw), expected);
});
```

- [ ] **Step 2-4:** Run → FAIL; implement `redact.js` mirroring `redact.py` (same ordered forms, configured-secrets longest-first). Run → PASS. (The Python side already asserts the same fixtures in Task 1.4 — parity is now two-sided.)

- [ ] **Step 5: Commit** `feat(activity): read-time redaction backstop with cross-language parity`.

### Task 3.5: Reader-side retention + prune (age, 64 MiB ceiling, prune order)

**Files:** Modify `menubar/activity/quota.js` (implement the real `prune` + `retain`); Test `menubar/activity/__tests__/retention.test.js`.

**Interfaces:** `retain(home) -> { pruned: [ids] }` applying §7: routine terminal prunable only if older than 14 days AND outside newest 50; problem item only if older than 90 days AND outside newest 50; never prune `running`/unreconciled; the 64 MiB ceiling **overrides** age/newest-50 (prune younger terminals if needed) except never `running` and always keep the newest problem; prune deletes segment files **first**, then the scan reflects it (Task 1.6 `_prune` no-op is now replaced/reused by this Node implementation, which is the authoritative one).

- [ ] **Step 1: Write the failing test** (representative: ceiling overrides age)

```js
const test = require('node:test'); const assert = require('node:assert');
// seed >64 MiB across many settled routine items + one recent problem item;
// assert retain() prunes oldest routine first, keeps the newest problem, and drops
// under the ceiling; assert a running item is never pruned.
```

- [ ] **Step 2-5:** implement `retain`/`prune`; run → PASS; commit `feat(activity): outcome-aware retention + 64 MiB ceiling enforcement`.

### Task 3.6: `read.js` — enumerate → DTO assembly + export

**Files:** Create `menubar/activity/read.js`; Modify `menubar/activity/index.js` (export the reader façade); Test `menubar/activity/__tests__/read.test.js`.

**Interfaces:** `listActivities(home, filter) -> { items: DTO[], truncated }` and `buildExport(home, filter) -> string`. Each DTO is bounded + already redacted, newest-first, with derived `outcome` (via reconcile), duration, channel/trigger, error/warn counts, and the two lenses (Events, Problems). `buildExport` produces the redacted text in-process (never from renderer input). Enforces payload/size bounds before returning.

- [ ] **Step 1: Write the failing test** (end-to-end read over a seeded store, incl. a `running` item that reconciles to `interrupted`, a redaction check on a DTO, and the `truncated` flag when over the DTO budget).

- [ ] **Step 2-5:** implement; run → PASS; commit `feat(activity): reader DTO assembly + redacted export`.

**Phase 3 gate:** `cd menubar && node --test` green; the reader turns a crashed `running` attempt into a visible `interrupted` item. Request an `implementation-review` over the Phase-3 range.

---

## Phase 4 — Activity window UI + IPC (the feature earns its keep)

**Deliverable:** a dedicated, context-isolated Activity window backed by the Phase-3 reader; a tray entry available any time; the two lenses; the System section; and the "Sync Errors" affordance subsumed so it never opens empty. **This is the first releasable state** — Phases 1–3 were checkpoints.

### Task 4.1: Narrow, context-isolated IPC surface

**Files:** Create `menubar/activity/ipc.js` (main-side handlers); Modify `menubar/main.js` (register handlers), `menubar/preload.js` (expose a minimal `activityApi`); Test `menubar/activity/__tests__/ipc.test.js` (unit-test the handler functions directly, Electron-free).

**Interfaces:** channels `activity:list` (filter → `{items, truncated}`), `activity:get` (id → item + lenses), `activity:export` (filter → path; export built in main via `read.buildExport`), `activity:reveal` (id → `shell.showItemInFinder`). Handlers validate the filter and **only ever return bounded, already-redacted DTOs**; the renderer sends filter parameters, never text to be echoed. `preload.js` exposes `contextBridge.exposeInMainWorld('activityApi', { list, get, export, reveal })`.

- [ ] TDD: test the handler functions with a seeded store return bounded/redacted DTOs and reject an over-broad filter; implement; commit `feat(activity): context-isolated IPC for the Activity window`.

### Task 4.2: Activity `BrowserWindow` + renderer (list + Events/Problems lenses)

**Files:** Modify `menubar/main.js` (`showActivityWindow()` — a NEW window distinct from `showLogWindow`, with `contextIsolation:true, nodeIntegration:false, preload`); Create `menubar/renderer/activity.html`, `menubar/renderer/activity.js`; Test `menubar/__tests__/activity-renderer-dom.test.js` (jsdom-free: test the pure render helpers that build DOM text from a DTO).

**Interfaces:** `showActivityWindow()` opens the window (reusing an existing instance), loads `renderer/activity.html`. The renderer: a newest-first list of chips (time · channel/trigger · duration · outcome dot · error/warn counts); clicking opens the two lenses — **Events** (rows filterable by level + free-text, expandable `detail`) and **Problems** (warn/error + failure diagnostics, exact-dup terminals grouped w/ count, integrity Problems). **All content inserted via `textContent`, never `innerHTML`**; ANSI/control chars stripped. `renderer/activity.js` factors its DTO→DOM mapping into pure functions so they are unit-testable.

- [ ] TDD: unit-test the pure `renderChip(dto)` / `renderEventRow(rec)` produce escaped text (a DTO carrying `<script>` and ANSI yields inert text); implement window + renderer; commit `feat(activity): context-isolated Activity window with Events/Problems lenses`.

### Task 4.3: System section

**Files:** Modify `menubar/activity/read.js` (add `systemDiagnostics(home)`), `menubar/renderer/activity.js` (render the section); Test `menubar/activity/__tests__/system-section.test.js`.

**Interfaces:** `systemDiagnostics(home) -> { streams: [{name, redactedTail}] }` — bounded, redacted, explicitly **uncorrelated** tails of at minimum `sync.error.log` and `menubar.log`; `sync.log` and `renderer.log` listed as available-on-demand. Never Activity items, never time-correlated. This is also where the viewer's **own** observability-write failure surfaces.

- [ ] TDD: seeded log files → bounded redacted tails; implement; commit `feat(activity): System section (uncorrelated shared-stream diagnostics)`.

### Task 4.4: Subsume "Sync Errors" — deep-link, never empty

**Files:** Modify `menubar/main.js` (`showErrorWindow`/`sendErrorData` 1665–1704 → route through the Activity reader), `menubar/renderer/activity.js` (accept a `focusId`); Test `menubar/activity/__tests__/view-errors-target.test.js`.

**Interfaces:** a `viewErrorsTarget(home) -> activityId | null` in `read.js` returning the newest item carrying Problems or a failure-like outcome (`blocked`/`failed`/`interrupted`/`succeeded-with-warnings`, or a System incident). The tray "⚠️ View Errors" affordance (main.js 561–566) is shown **only when `viewErrorsTarget` is non-null** and opens the Activity window focused on that item — **never an empty view** (the exact bug from the motivating incident).

- [ ] TDD: a store whose only problem is a dev-guard `blocked` incident (no `errorList`) yields a non-null target; a clean store yields null; implement; commit `feat(activity): subsume Sync Errors with a never-empty deep-link`.

### Task 4.5: Tray "Activity" + Export/Reveal + unavailable state

**Files:** Modify `menubar/main.js` (`updateTrayMenu` 483/547 — add "🗒 Activity" available any time; wire Export/Reveal); Modify `menubar/renderer/activity.js` (Refresh/Export/Reveal actions; a first-class **History unavailable/incomplete** state); Test `menubar/__tests__/tray-activity.test.js`.

**Interfaces:** "🗒 Activity" appears in **both** the syncing branch (alongside "📊 View Progress") and the idle branch. Export writes a redacted file via a save dialog, produced in main from the validated filter (never renderer text). "History unavailable" renders when the reader reports the store missing/incomplete.

- [ ] TDD: `updateTrayMenu` includes an Activity item in both branches; implement; commit `feat(activity): tray Activity entry + redacted export + unavailable state`.

**Phase 4 gate:** both suites green; **manual acceptance** — open Activity with no sync running and browse past attempts; trigger a dev-guard block and confirm it appears as a `blocked` item and "View Errors" deep-links to it. Request an `implementation-review` over the Phase-4 range.

---

## Phase 5 — Legacy adapter + retention wiring

**Deliverable:** old `sync-*.log` files appear as opaque legacy Activity items; identity-less `status.json`/shared streams appear only in System; retention is wired to run. Completes the vertical MVP.

### Task 5.1: Opaque legacy `sync-*.log` adapter

**Files:** Create `menubar/activity/legacy.js`; Modify `menubar/activity/read.js` (merge legacy items into the list); Test `menubar/activity/__tests__/legacy.test.js`.

**Interfaces:** `legacyItems(home) -> DTO[]` — each `sync-<ISO>.log` becomes one **opaque legacy attempt** DTO (run boundary from the filename; `[HH:MM:SS]` line-times + filename-date → full timestamps; level derived only for legacy data), redacted, clearly marked legacy. **Never** correlated to a durable activity, never reconstructs identity. `status.json` and shared streams are **System-only** (Task 4.3), never standalone items.

- [ ] TDD: a seeded `sync-*.log` yields one opaque legacy DTO with a reconstructed timestamp; a `status.json` never becomes a standalone item; implement; commit `feat(activity): opaque legacy sync-log adapter`.

### Task 5.2: Retention wiring + independence from `_rotate_sync_logs`

**Files:** Modify `menubar/main.js` (invoke `activity/quota.retain(home)` on a bounded cadence — app start + post-sync `close`); Test `menubar/__tests__/retention-wiring.test.js`.

**Interfaces:** `retain` (Task 3.5) runs at app start and after each sync completes; the legacy `_rotate_sync_logs` (10 files, `sync.py:107–122`) is **left untouched** and independent (spec §7). Retention must never run mid-write for a `running` item (it already refuses to prune those).

- [ ] TDD: retention invoked at the documented points and never prunes a `running` item; implement; commit `feat(activity): wire outcome-aware retention (independent of legacy rotation)`.

### Task 5.3: Final acceptance — the motivating failure is now visible

**Files:** Test `menubar/activity/__tests__/acceptance-motivating-failure.test.js` + a documented manual script.

- [ ] **Step 1:** Automated: seed the exact motivating scenario — a dev sync **blocked before Python ran** (interpreter fingerprint mismatch), producing an Activity `blocked` incident and **no** `sync-*.log`. Assert: (a) the reader lists a `blocked` item; (b) `viewErrorsTarget` points at it; (c) the item's Problems lens shows the reason; (d) the System section still surfaces `sync.error.log`. This is the failure the whole feature exists to close (spec Problem statement).
- [ ] **Step 2:** Manual script (documented in the test file's docstring): on a dev build, force the guard block, open Activity, confirm the `blocked` item + non-empty "View Errors".
- [ ] **Step 3: Commit** `test(activity): acceptance — blocked-before-Python is now a visible Activity item`.

**Phase 5 gate (feature complete):** both suites green; the vertical MVP satisfies the spec's Goal end to end. Request a final `implementation-review` over the Phase-5 range, then a `final-verdict`.

---

## Execution handoff

Recommended: **subagent-driven-development** — one fresh subagent per task, two-stage review (spec + quality) between tasks, with the phase-gate `implementation-review` checkpoints above routed to Codex via paired-development. Phases 1–3 are green checkpoints but **not releasable**; the feature's user-facing job is unmet until Phase 4. Ship to the **dev channel** first (release policy: dev testing gates production).


