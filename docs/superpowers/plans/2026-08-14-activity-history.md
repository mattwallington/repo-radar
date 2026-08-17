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
2. **The POSIX-sh dispatcher stays thin — it never reimplements records/lease/quota.** The shell mints `activity_id`+`owner_token` and **acquires+holds** the `owner.lock` fd (same pattern as the existing root `.exec.lock` on fd 9). It then invokes the managed venv Python's bootstrap entrypoint (`python -m repo_radar.activity.bootstrap`) **before** the runtime-verify guard; the bootstrap, seeing an inherited lease but **no existing `start` in the segments**, does `admit` + writes the single `start` + initial `ownership` (the scheduled path's "first producer" case). That interpreter can still *execute* even when the fingerprint guard will later *reject* it (the motivating failure: a Homebrew python bump staled the fingerprint but python still ran). On a subsequent guard failure the shell calls `python -m repo_radar.activity.finalize` to write the `blocked` terminal + `settle` + release. **If the venv Python cannot execute at all** (rare hard corruption), the shell writes a bounded, redacted line to the **System diagnostic stream** (`sync.error.log`) — it does **NOT** append an un-quota'd Activity segment line (Round-1 finding 1). Root-lock contention finalizes the attempt `skipped` (finding 5).
3. **~~sh-friendly `key=value` ledger~~ — REJECTED (Round-1 finding 1).** The ledger stays **JSON** `activity/quota/<activity-id>.json` exactly as the spec pins it (the thin shell never reads the ledger — only Python/Node do — so there is no shell-simplicity justification). **There is no `has_start` field**: making it authoritative reintroduced the reserve-before-`start` undercount race the spec closed (a crash between the durable `start` and a `mark_started` call would look abandoned). **Lifecycle state (`start` present? `terminal` present?) is derived from a bounded scan of the activity's segments under `quota.lock`**, and reclamation stays lease-gated per spec §5/§7.
4. **A `test` script is added to `menubar/package.json`** (`"test": "node --test"`) — none exists today, though 18 `node:test` files already do. Python keeps `python -m pytest repo_radar/tests/`. (Reviewer baseline `cd menubar && node --test` passed.)
5. **Shared redaction fixtures are test-only, not bundled.** They live at `repo_radar/tests/data/redaction_fixtures.json` (the packaging `extraResources` excludes `**/tests/**`, so nothing ships); `load_fixtures()` is a **test helper**, not part of production `redact.py`. The Python suite reads the file directly; the Node suite reads it via `../../repo_radar/tests/data/redaction_fixtures.json`. Fixtures include **configured-secret** cases (not only credential-form regexes) so both redactors' secret-value masking is proven identical (spec §4).

## Plan-review Round 1 dispositions (all accepted)

| # | Finding | Fix landed in |
|---|---------|---------------|
| 1 | `has_start` reintroduced the reserve→start race; `key=value` deviation; unreserved sh fallback | Decision 3 (revert to JSON, derive lifecycle from segment scan); Decision 2 (sh fallback → System stream); Tasks 1.6, 1.7, 1.9 |
| 2 | Capacity state machine unenforced (no per-activity cap in `grant`; `reserve=True` bypasses accounting; 20 KiB partitions absent) | Tasks 1.6 (`grant` per-activity cap), 1.7 (one-shot partitioned reserve accounting), 2.2 (mirrored) |
| 3 | Settle/release without durable terminal (short write, no flush, construction outside best-effort) | Task 1.7 (durable append: full-write loop + `fsync`; settle only after durability; construction inside the boundary; failure-injection tests) |
| 4 | Scheduled bootstrap can't create the canonical `start` (adopt path skips admit+start) | Tasks 1.7 (two inherited cases), 1.8 (first-locker admit+start vs adopt-existing; assert exactly one `start`) |
| 5 | Lifecycle ordering: Activity started after contention gates; no handoff-ack; `LOCK_UN` would unlock the child; controller may not terminalize | Tasks 2.3, 2.4 (`skipped` on contention; `dropLocalReference()` = close-without-unlock; ack protocol; fd→child-fd-4 remap; controller may append `cancel_requested` only; failed-spawn/root-busy/failed-validation outcomes) |
| 6 | Admission pruning can't be a permanent no-op | New Task 1.6b (real settled-item ceiling-override pruner in Phase 1, exercised via Python+Node admission); Task 3.5 adds age/newest-50/cadence only |
| 7 | Foundational safety: symlink-following in mkdir/chmod/scan; probe collapses errors to "busy"; UTF-8 byte-bounding, `detail`, summary bounds, redaction coverage; unsynchronized threaded writer | Tasks 1.2 (descriptor-relative + `lstat`), 1.5 (tri-state probe), 1.3/1.7 (byte-bounds, `detail`, summary, redact all free-text, construction in boundary), 1.7 (writer lock) |
| 8 | Integration tests don't prove the production chain; golden too thin; both lock directions; CLI asserts only directory existence | Tasks 2.1 (all record types + Unicode/truncation golden), 2.2 (both directions + shared behavioral vectors), 2.5/2.6 (assert actual terminal outcomes), 2.7 (real generated dispatcher chain) |
| 9 | Compressed destructive/security/UI tasks | Tasks 3.5 (full retention matrix), 3.6/4.1 (concrete byte limits), 4.1 (dedicated Activity preload + security-options/allowlist tests), 4.2 (innerHTML source-prohibition + DOM adapter test), 4.3 (bounded/redacted `status.json` errorLog/errorList in System), 5.1 (legacy diagnostics into System) |

Decision dispositions from the reviewer: #1 accepted (contingent on conformance tests + corrected handoff — done); #2 accepted (scheduled first-producer + System fallback corrected); **#3 rejected → reverted**; #4 accepted; #5 accepted (fixtures now test-only + configured-secret cases).

---

## File Structure

### New — Python (`repo_radar/activity/`, package alongside `repo_radar/modes/`)

- `__init__.py` — package marker; re-exports the public writer API.
- `ids.py` — mint/validate `activity_id` (UUIDv4), `writer_id` / `owner_token` (8-hex). Pure, no I/O.
- `paths.py` — construct + securely create/validate the activity dir, segment paths, `owner.lock`, and the `quota/` dir + `<id>.json`. Owns the `0700`/`0600` + reject-symlink/non-dir discipline (lstat-based, no symlink follow).
- `records.py` — build each record type, enforce per-record bounds (§7) with explicit truncation marking, and encode to a single UTF-8 JSON line; report encoded byte length (incl. newline). Pure.
- `redact.py` — write-time redaction: the fixed credential-form patterns (mirroring `metadata._REDACTIONS`) **plus** the app's configured/effective secret values. **No fixture loading in production** (fixtures are a test concern).
- `lease.py` — `flock` acquire/hold/`release()`/`drop_local_reference()`, fd retention, `owner_token` minting, tri-state `probe`, and the exact **inherited-descriptor validation** (§5: syntactic → `fstat` identity → independent-BUSY probe → inherited-fd reassert).
- `reconcile.py` — the shared crash-recovery state machine (§5): for a lease-free, unterminated activity, synthesize `interrupted`/`cancelled` (durable) and settle; used by `quota.admit` (self-heals on every admission) and mirrored in Node `reconcile.js` for display.
- `quota.py` — admission lock at **`activity/quota.lock`** (sibling of the ledger dir, per spec §7), the **JSON** `<id>.json` ledger, filesystem scan for `committed`, charge computation, `admit`(reconciles first)/`grant`/`settle`/`reconcile`/`prune` — all lock-safe; corrupt-entry fail-closed at 4 MiB; lifecycle derived from **parsed top-level** records.
- `writer.py` — `ActivityWriter`: ties ids+paths+lease+quota+records into one segment writer with the reserve-partition state machine, a **never-raises façade (inactive-on-failure)**, adopt-vs-mint, and the seven-outcome finalizer.
- `bootstrap.py` — `python -m repo_radar.activity.bootstrap`: adopts the shell-held lease and admits + writes `start`(first-producer) or handoff `ownership`; **exits non-zero on validation/handoff failure so the dispatcher aborts (never execs a non-owner)**.
- `finalize.py` — `python -m repo_radar.activity.finalize` entrypoint: write a `blocked`/`skipped`/`interrupted` terminal for a given id and settle/release (shell guard-failure + contention).
- (shared redaction fixtures live under `repo_radar/tests/data/`, **not** in the package — Decision 5.)

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
- `menubar/renderer/activity-preload.js` (**dedicated**, not the existing `preload.js`) + `menubar/renderer/activity.{html,js}` — the Activity window renderer (text-only insertion, allowlisted IPC).

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

redact.Redactor(configured_secrets: list[str]).scrub(text: str) -> str   # no fixture loading in prod

lease.acquire(lock_path) -> Lease                   # flock LOCK_EX|LOCK_NB; None if busy
lease.Lease.owner_token: str
lease.Lease.fd: int
lease.Lease.release() -> None
lease.adopt(inherited_fd, owner_token, lock_path) -> Lease   # runs §5 validation; raises HandoffRejected
lease.probe(lock_path) -> FREE|BUSY|UNCERTAIN       # tri-state, fresh independent descriptor
lease.probe_busy(lock_path) -> bool                 # == BUSY

quota.admit(home, activity_id, lease) -> bool       # writes JSON entry {reserved:60Ki, granted:0}
quota.grant(home, activity_id, nbytes) -> bool      # per-activity-cap + ceiling; False = refuse ordinary
quota.settle(home, activity_id) -> None             # remove entry (bytes counted by scan thereafter)
quota.reconcile(home) -> None                       # startup/pre-admission sweep; lifecycle derived from segments
quota.prune(home, need_bytes) -> int                # ceiling-override settled-item pruner

writer.ActivityWriter(home, *, kind, channel, trigger, producer,
                      inherited_id=None, inherited_fd=None, owner_token=None)
writer.ActivityWriter.start() -> None                       # mint: start+initial-ownership; adopt-existing: handoff-ownership
writer.ActivityWriter.event(name, level, detail=None, **fields) -> None   # ordinary (grant); auto dropped-events note if refused
writer.ActivityWriter.control(name, **fields) -> None       # cancel_requested = one-shot reserve; other names = ordinary
writer.ActivityWriter.terminal(outcome, **summary) -> None  # one-shot reserve; settles quota + releases lease ONLY after durable
writer.ActivityWriter.activity_id: str
writer.ActivityWriter.hand_off_env() -> dict                # {REPO_RADAR_ACTIVITY_ID, ..._OWNER_TOKEN, ..._LOCK_FD}
# (no public integrity(): the single dropped-events note is emitted internally; further
#  integrity findings are reader-derived / System Problems, per spec §7)
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
- Produces: `activity_dir(home, activity_id) -> Path`, `segment_path(home, activity_id, producer, writer_id) -> Path`, `owner_lock_path(home, activity_id) -> Path`, `quota_dir(home) -> Path`, `ledger_entry_path(home, activity_id) -> Path`, `secure_mkdir(path, mode=0o700) -> None`, `secure_open_append(path, mode=0o600) -> int`, plus scan helpers `secure_scan(directory, pattern="*.jsonl") -> list[Path]` (files only, via `lstat`, never following a symlinked entry) and `secure_iterdirs(base) -> list[Path]` (immediate subdirs only, `lstat`, skipping symlinks). Raises `UnsafePath` on symlink/non-dir/invalid-id. **Ledger entry is `<id>.json`** (Decision 3). `secure_mkdir` creates each missing ancestor component with `lstat` re-verification (finding 7: no attacker-symlink follow).

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

def test_secure_scan_skips_symlinked_entries(tmp_path):
    d = paths.activity_dir(tmp_path, VALID); paths.secure_mkdir(d)
    real = d / "python-deadbeef.jsonl"; real.write_bytes(b"x\n")
    victim = tmp_path / "outside.jsonl"; victim.write_bytes(b"secret\n")
    os.symlink(victim, d / "python-cafebabe.jsonl")     # symlinked entry must be skipped
    files = paths.secure_scan(d)
    assert real in files and (d / "python-cafebabe.jsonl") not in files

def test_secure_mkdir_rejects_symlinked_ancestor(tmp_path):
    victim = tmp_path / "victim"; victim.mkdir()
    base = tmp_path / "Library" / "Logs" / "repo-radar"
    base.parent.mkdir(parents=True)
    os.symlink(victim, base)                             # symlinked ANCESTOR of activity/
    with pytest.raises(paths.UnsafePath):
        paths.secure_mkdir(base / "activity" / VALID)

def test_secure_mkdir_repairs_overpermissive_existing_dir(tmp_path):
    d = paths.activity_dir(tmp_path, VALID)
    d.parent.mkdir(parents=True); os.mkdir(d, 0o777)    # pre-existing world-writable
    paths.secure_mkdir(d)
    assert stat.S_IMODE(os.lstat(d).st_mode) == 0o700   # repaired via fchmod

def test_secure_open_append_repairs_overpermissive_file(tmp_path):
    d = paths.activity_dir(tmp_path, VALID); paths.secure_mkdir(d)
    seg = paths.segment_path(tmp_path, VALID, "python", "deadbeef")
    os.close(os.open(seg, os.O_CREAT | os.O_WRONLY, 0o666))   # pre-existing 0666
    fd = paths.secure_open_append(seg); os.close(fd)
    assert stat.S_IMODE(os.lstat(seg).st_mode) == 0o600
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest repo_radar/tests/test_activity_paths.py -v`
Expected: FAIL (`ModuleNotFoundError`).

- [ ] **Step 3: Write minimal implementation**

```python
# repo_radar/activity/paths.py
import os, stat
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
    return quota_dir(home) / f"{activity_id}.json"

def secure_mkdir(path, mode=0o700) -> None:
    """Create path + missing ancestors, refusing any symlinked component and REPAIRING an
    over-permissive existing dir — operating on an O_NOFOLLOW dir FD, not a pathname, so a
    symlink cannot be swapped in between the check and the chmod (finding 6)."""
    path = Path(path); chain = []; cur = path
    while not cur.exists():
        chain.append(cur); cur = cur.parent       # cur = deepest existing ancestor
    for p in [cur] + list(reversed(chain)):
        if p in chain:
            try:
                os.mkdir(p, mode)                 # atomic create with final mode
            except FileExistsError:
                pass
        try:                                      # open the component itself, never following a link
            dfd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY)
        except OSError as e:                       # ELOOP (symlink) / ENOTDIR (non-dir)
            raise UnsafePath(f"unsafe component {p}: {e}")
        try:
            if stat.S_IMODE(os.fstat(dfd).st_mode) != mode:
                os.fchmod(dfd, mode)              # repair an over-permissive existing dir
        finally:
            os.close(dfd)

def secure_open_append(path, mode=0o600) -> int:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, mode)
    if stat.S_IMODE(os.fstat(fd).st_mode) != mode:
        os.fchmod(fd, mode)                       # repair a pre-existing over-permissive file
    return fd

def secure_scan(directory, pattern="*.jsonl"):
    """Regular files only, via lstat; never follows a symlinked entry (finding 7)."""
    d = Path(directory)
    if not d.exists():
        return []
    return [e for e in d.glob(pattern) if stat.S_ISREG(os.lstat(e).st_mode)]

def secure_iterdirs(base):
    """Immediate real subdirs of base (lstat), skipping symlinks and non-dirs."""
    b = Path(base)
    if not b.exists():
        return []
    return [e for e in b.iterdir() if stat.S_ISDIR(os.lstat(e).st_mode)]
```

(`import stat` is already needed by the tests; add `import os, stat` at the top of `paths.py`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest repo_radar/tests/test_activity_paths.py -v`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add repo_radar/activity/paths.py repo_radar/tests/test_activity_paths.py
git commit -m "feat(activity): secure storage paths (0700/0600, symlink-safe, lstat scans)"
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
import json, pytest
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

def test_key_is_byte_bounded_not_char_bounded():
    rec = R.build("event", seq=4, activity_id=AID, level="info", event="x",
                  fields={"é" * 100: 1})            # 2 bytes per char in UTF-8
    key = next(iter(rec["fields"]))
    assert len(key.encode("utf-8")) <= R.MAX_KEY_BYTES

def test_terminal_summary_is_bounded_like_fields():
    rec = R.build("terminal", seq=5, activity_id=AID, outcome="failed",
                  summary={f"k{i}": "z" * 4000 for i in range(50)}, by="deadbeef")
    import json
    assert len(json.dumps(rec["summary"]).encode()) <= R.MAX_FIELDS_BYTES
    assert R.encoded_len(rec) <= R.MAX_RECORD_BYTES

def test_ts_override_is_deterministic():
    rec = R.build("event", seq=0, activity_id=AID, ts="2026-08-14T00:00:00-07:00",
                  level="info", event="x", fields={})
    assert rec["ts"] == "2026-08-14T00:00:00-07:00"

def test_invalid_enums_are_rejected():
    with pytest.raises(R.InvalidRecord): R.build("bogus", seq=0, activity_id=AID)
    with pytest.raises(R.InvalidRecord):
        R.build("event", seq=0, activity_id=AID, level="loud", event="x", fields={})
    with pytest.raises(R.InvalidRecord):
        R.build("terminal", seq=0, activity_id=AID, outcome="ok", summary={}, by="x")
    with pytest.raises(R.InvalidRecord):
        R.build("ownership", seq=0, activity_id=AID, role="boss", owner_token="x")
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

class InvalidRecord(Exception):
    pass

_VALID_TYPES = {"start", "ownership", "event", "control", "terminal", "integrity"}
_VALID_LEVELS = {"info", "warn", "error"}
_VALID_ROLES = {"initial", "handoff"}
_VALID_OUTCOMES = {"succeeded", "succeeded-with-warnings", "blocked", "failed",
                   "cancelled", "skipped", "interrupted"}

def _validate(rec):
    t = rec["type"]
    if t not in _VALID_TYPES:
        raise InvalidRecord(f"type {t!r}")
    if t == "event" and rec.get("level") not in _VALID_LEVELS:
        raise InvalidRecord(f"level {rec.get('level')!r}")
    if t == "ownership" and rec.get("role") not in _VALID_ROLES:
        raise InvalidRecord(f"role {rec.get('role')!r}")
    if t == "terminal" and rec.get("outcome") not in _VALID_OUTCOMES:
        raise InvalidRecord(f"outcome {rec.get('outcome')!r}")

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

def _bound_key(k):
    b = str(k).encode("utf-8")               # byte-bound, not char-bound (finding 7)
    return str(k) if len(b) <= MAX_KEY_BYTES else b[:MAX_KEY_BYTES].decode("utf-8", "ignore")

def _bound_fields(fields):
    truncated = False
    out = {}
    for i, (k, v) in enumerate((fields or {}).items()):
        if i >= MAX_KEYS:
            truncated = True
            break
        k = _bound_key(k)
        if isinstance(v, str):
            v, t = _truncate(v, MAX_VALUE_BYTES)
            truncated = truncated or t
        elif not isinstance(v, (int, float, bool)) and v is not None:
            v, t = _truncate(str(v), MAX_VALUE_BYTES); truncated = True
        out[k] = v
    # aggregate cap
    while len(json.dumps(out, ensure_ascii=False).encode()) > MAX_FIELDS_BYTES and out:
        out.pop(next(reversed(out)))
        truncated = True
    return out, truncated

def build(type, *, seq, activity_id, ts=None, **payload):
    rec = {"schema_version": SCHEMA_VERSION, "activity_id": activity_id,
           "type": type, "seq": seq, "ts": ts or _now_iso()}
    truncated = False
    for dictkey in ("fields", "summary"):        # summary is bounded like fields (finding 7)
        if dictkey in payload:
            payload[dictkey], t = _bound_fields(payload[dictkey]); truncated |= t
    if payload.get("detail") is not None:
        payload["detail"], t = _truncate(str(payload["detail"]), MAX_DETAIL_BYTES); truncated |= t
    rec.update(payload)
    if truncated:
        rec["_truncated"] = True
    _validate(rec)                               # enum validation (finding 7)
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
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add repo_radar/activity/records.py repo_radar/tests/test_activity_records.py
git commit -m "feat(activity): record contract — byte-bounded keys/values/summary + truncation + ts override"
```

### Task 1.4: Write-time redaction + shared fixtures

**Files:**
- Create: `repo_radar/activity/redact.py`
- Create: `repo_radar/tests/data/redaction_fixtures.json` (**test-only**, not bundled — Decision 5)
- Test: `repo_radar/tests/test_activity_redact.py`

**Interfaces:**
- Produces: `Redactor(configured_secrets: list[str]).scrub(text) -> str`. Masks the credential forms from spec §4 (`sk-…`, `ghp_…`/`github_pat_…`, `AIza…`, `Bearer …`, `//user:pass@`) plus every non-empty configured secret value (longest-first, so overlapping secrets fully mask). **`load_fixtures()` is NOT in production** — the fixtures are loaded in the test module (Decision 5).

- [ ] **Step 1: Write the fixtures file** `repo_radar/tests/data/redaction_fixtures.json` (object form so configured-secret cases are covered, per finding 5's disposition)

```json
[
  {"secrets": [], "raw": "Authorization: Bearer sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA", "expected": "Authorization: [REDACTED authorization]"},
  {"secrets": [], "raw": "key sk-proj-ABCDEFGHIJKLMNOPQRSTUV", "expected": "key [REDACTED api key]"},
  {"secrets": [], "raw": "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "expected": "token [REDACTED github token]"},
  {"secrets": [], "raw": "token github_pat_11ABCDE0000abcdefghij_KLMNOPQRSTUVWXYZ0123456789", "expected": "token [REDACTED github token]"},
  {"secrets": [], "raw": "gemini AIzaSyA0000000000000000000000000000000", "expected": "gemini [REDACTED google key]"},
  {"secrets": [], "raw": "clone https://user:s3cr3t@github.com/x/y.git", "expected": "clone https://<redacted>@github.com/x/y.git"},
  {"secrets": ["hunter2-configured-token-value"], "raw": "debug password=hunter2-configured-token-value end", "expected": "debug password=[REDACTED] end"},
  {"secrets": ["abc", "abcdef123456"], "raw": "val=abcdef123456", "expected": "val=[REDACTED]"}
]
```

- [ ] **Step 2: Write the failing test**

```python
# repo_radar/tests/test_activity_redact.py
import json, pathlib
from repo_radar.activity import redact

FIX = pathlib.Path(__file__).parent / "data" / "redaction_fixtures.json"

def test_shared_fixtures_mask_as_expected():
    for case in json.loads(FIX.read_text()):
        r = redact.Redactor(configured_secrets=case["secrets"])
        assert r.scrub(case["raw"]) == case["expected"], case["raw"]

def test_overlapping_secrets_mask_fully_longest_first():
    r = redact.Redactor(configured_secrets=["abc", "abcdef123456"])
    assert "abcdef123456" not in r.scrub("val=abcdef123456")
```

- [ ] **Step 3: Run test to verify it fails**

Run: `python -m pytest repo_radar/tests/test_activity_redact.py -v`
Expected: FAIL (`ModuleNotFoundError`).

- [ ] **Step 4: Write minimal implementation** (no fixture loading in production)

```python
# repo_radar/activity/redact.py
import re

_FORMS = [
    (re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._\-]{16,}"), "[REDACTED authorization]"),
    (re.compile(r"github_pat_[A-Za-z0-9_]{20,}"), "[REDACTED github token]"),
    (re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"), "[REDACTED github token]"),
    (re.compile(r"sk-(?:ant-)?[A-Za-z0-9._\-]{16,}"), "[REDACTED api key]"),
    (re.compile(r"AIza[A-Za-z0-9_\-]{20,}"), "[REDACTED google key]"),
    (re.compile(r"//[^/@\s]+@"), "//<redacted>@"),
]

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
Expected: PASS (2 tests). (`github_pat_` is ordered before `gh[pousr]_`; the Node mirror in Task 3.4 uses the identical ordering and reads the same fixtures.)

- [ ] **Step 6: Commit**

```bash
git add repo_radar/activity/redact.py repo_radar/tests/data/redaction_fixtures.json repo_radar/tests/test_activity_redact.py
git commit -m "feat(activity): write-time redaction + shared cross-language fixtures (test-only)"
```

### Task 1.5: The `flock` lease — acquire, adopt/validate, probe

**Files:**
- Create: `repo_radar/activity/lease.py`
- Test: `repo_radar/tests/test_activity_lease.py`

**Interfaces:**
- Consumes: `ids.mint_token`, `paths.owner_lock_path`, `paths.secure_mkdir`.
- Produces: `acquire(lock_path) -> Lease|None` (None if busy), `Lease` with `.owner_token`, `.fd`, `.release()`, and `.drop_local_reference()` (close **without** `LOCK_UN` — for the Electron handoff, finding 5); `adopt(inherited_fd, owner_token, lock_path) -> Lease` (raises `HandoffRejected` unless §5 validation passes); a **tri-state** `probe(lock_path) -> FREE|BUSY|UNCERTAIN` (finding 7) and `probe_busy(lock_path) -> bool` (`== BUSY`). Validation order is exactly §5: syntactic → `fstat` identity vs a fresh non-symlink `stat` → independent probe **must be `BUSY`** → inherited-fd reassert. `UNCERTAIN` never counts as busy (adopt rejects; the reader emits an integrity Problem).

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
import errno, fcntl, os
from repo_radar.activity import ids

FREE, BUSY, UNCERTAIN = "free", "busy", "uncertain"

class HandoffRejected(Exception):
    pass

class Lease:
    def __init__(self, fd, owner_token):
        self.fd = fd
        self.owner_token = owner_token
    def release(self):
        """Full release: unlock + close (the executing owner, at terminal)."""
        if self.fd is not None:
            try:
                fcntl.flock(self.fd, fcntl.LOCK_UN)
            finally:
                os.close(self.fd); self.fd = None
    def drop_local_reference(self):
        """Close WITHOUT LOCK_UN (finding 5). LOCK_UN would release the shared open-file
        description the child inherited; a bare close leaves the child holding the lease."""
        if self.fd is not None:
            os.close(self.fd); self.fd = None

def acquire(lock_path):
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd); return None
    return Lease(fd, ids.mint_token())

def probe(lock_path):
    """Tri-state via a fresh independent open-file description (finding 7)."""
    try:
        fd = os.open(lock_path, os.O_RDWR | os.O_NOFOLLOW)
    except OSError:
        return UNCERTAIN
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(fd, fcntl.LOCK_UN)     # we got it -> it was free
        return FREE
    except OSError as e:
        return BUSY if e.errno in (errno.EAGAIN, errno.EWOULDBLOCK) else UNCERTAIN
    finally:
        os.close(fd)

def probe_busy(lock_path) -> bool:
    return probe(lock_path) == BUSY

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
    # (3) independent probe MUST be strictly BUSY (UNCERTAIN never counts as held)
    if probe(lock_path) != BUSY:
        raise HandoffRejected("lease not confirmably held (unlocked look-alike or uncertain)")
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
- Create: `repo_radar/activity/quota.py`, `repo_radar/activity/reconcile.py`
- Test: `repo_radar/tests/test_activity_quota.py`, `repo_radar/tests/test_activity_reconcile.py`

**Interfaces:**
- Consumes: `paths.*` (incl. `secure_scan`/`secure_iterdirs`), `lease.acquire`/`lease.probe`, `records`, `reconcile.synthesize_terminal`. **Admission lock is `activity/quota.lock`** (sibling of `activity/quota/`, per spec §7 — finding 6). `admit` runs `reconcile` **before** charging (finding 1). `prune` is **lock-safe** (`_prune_locked` under the held lock; public `prune` takes it). Lifecycle is derived from **parsed top-level** record types, never substrings (finding 1). `reconcile` **self-heals**: a lease-free activity with a durable `start` but no `terminal` gets a **synthetic terminal** (`interrupted`/`cancelled`) written + settled — so a crashed run doesn't leak its reservation until the UI happens to open. Corrupt entries follow the same segment+lease evidence path (not preserved forever).
- Produces: `admit(home, activity_id, lease) -> bool`, `grant(home, activity_id, nbytes) -> bool`, `settle(home, activity_id) -> None`, `reconcile(home) -> None`, `prune(home, need_bytes) -> int`; constants `CEILING=64*1024*1024`, `RESERVE=60*1024`, `PER_ACTIVITY_CAP=4*1024*1024`, `ORDINARY_CAP=PER_ACTIVITY_CAP-RESERVE`. **Ledger entry is JSON `<id>.json` `{reserved,granted}` (Decision 3; no `has_start`).** All mutating ops hold `quota.lock` (BSD `flock`). Invariant: **charge = committed(scan) + Σ_live max(0, reserved+granted−on_disk) + Σ_corrupt 4 MiB**; `admit` requires `charge + RESERVE ≤ CEILING` (pruning first if needed, finding 6); `grant(nbytes)` requires **both** `granted+nbytes ≤ ORDINARY_CAP` (per-activity cap, finding 2) **and** `charge+nbytes ≤ CEILING`. **`start`/`terminal` presence is derived from a bounded segment scan under the lock — never a ledger flag (finding 1).**

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

def _write_start(home, aid):   # a durable start line, as the writer would leave it
    seg = paths.segment_path(home, aid, "python", "deadbeef")
    fd = paths.secure_open_append(seg)
    os.write(fd, b'{"schema_version":1,"type":"start","seq":0,"ts":"t"}\n'); os.close(fd)

def _write_terminal(home, aid):
    seg = paths.segment_path(home, aid, "python", "deadbeef")
    fd = paths.secure_open_append(seg)
    os.write(fd, b'{"schema_version":1,"type":"terminal","seq":9,"ts":"t","outcome":"succeeded"}\n'); os.close(fd)

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
    seg = paths.segment_path(tmp_path, aid, "python", "deadbeef")
    fd = paths.secure_open_append(seg)
    os.write(fd, b'{"schema_version":1,"type":"start","seq":0,"ts":"t","fields":{"type":"terminal"}}\n')
    os.close(fd)
    assert quota._has_start(tmp_path, aid) and not quota._has_terminal(tmp_path, aid)

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
    _write_start(tmp_path, prob)
    seg = paths.segment_path(tmp_path, prob, "python", "deadbeef")
    fd = paths.secure_open_append(seg); os.write(fd, b'{"type":"terminal","outcome":"failed","ts":"t"}\n'); os.close(fd)
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest repo_radar/tests/test_activity_quota.py -v`
Expected: FAIL (`ModuleNotFoundError`).

- [ ] **Step 3: Write minimal implementation**

```python
# repo_radar/activity/quota.py
import fcntl, json, os, tempfile
from pathlib import Path
from repo_radar.activity import paths, records
from repo_radar.activity import lease as lease_mod
from repo_radar.activity import reconcile as reconcile_mod

CEILING = 64 * 1024 * 1024
RESERVE = 60 * 1024
PER_ACTIVITY_CAP = 4 * 1024 * 1024
ORDINARY_CAP = PER_ACTIVITY_CAP - RESERVE

def _quota_lock(home):
    paths.secure_mkdir(paths.quota_dir(home))              # ensure activity/ + quota/ exist
    lp = paths.quota_dir(home).parent / "quota.lock"       # activity/quota.lock (spec §7 — finding 6)
    fd = os.open(lp, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)          # blocking; brief critical section
    return fd

def _unlock(fd):
    fcntl.flock(fd, fcntl.LOCK_UN); os.close(fd)

def _read_entry(path):
    """JSON ledger (Decision 3). Returns dict or 'CORRUPT' (counters validated semantically)."""
    try:
        d = json.loads(Path(path).read_text())
        r, g = int(d["reserved"]), int(d["granted"])
        if not (0 <= r <= PER_ACTIVITY_CAP and 0 <= g <= PER_ACTIVITY_CAP):
            return "CORRUPT"
        return {"reserved": r, "granted": g}
    except Exception:
        return "CORRUPT"

def _write_entry(path, reserved, granted):
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=d)
    os.write(fd, json.dumps({"reserved": reserved, "granted": granted}).encode())
    os.close(fd); os.chmod(tmp, 0o600); os.replace(tmp, path)     # atomic

def _segments(home, activity_id):
    return paths.secure_scan(paths.activity_dir(home, activity_id), "*.jsonl")   # lstat-safe

def _top_types(home, aid):
    """Parsed TOP-LEVEL record types — never substring (finding 1: nested fields.type
    must not be mistaken for a record type)."""
    types = []
    for f in _segments(home, aid):
        for line in f.read_bytes().split(b"\n"):
            if not line:
                continue
            try:
                types.append(json.loads(line).get("type"))
            except Exception:
                pass                                   # a corrupt line is not a type
    return types

# lifecycle state is DERIVED from parsed segments, never a ledger flag (finding 1)
def _has_start(home, aid):    return "start" in _top_types(home, aid)
def _has_terminal(home, aid): return "terminal" in _top_types(home, aid)
def _on_disk(home, aid):      return sum(os.lstat(f).st_size for f in _segments(home, aid))

def _committed(home):
    base = paths.quota_dir(home).parent
    total = 0
    for d in paths.secure_iterdirs(base):          # skips symlinked dirs (finding 7)
        if d.name == "quota":
            continue
        total += sum(os.lstat(f).st_size for f in paths.secure_scan(d, "*.jsonl"))
    return total

def _charge(home):
    total = _committed(home)
    for entry in paths.secure_scan(paths.quota_dir(home), "*.json"):
        aid = entry.stem; e = _read_entry(entry)
        total += PER_ACTIVITY_CAP if e == "CORRUPT" \
            else max(0, e["reserved"] + e["granted"] - _on_disk(home, aid))
    return total

def admit(home, activity_id, lease):
    fd = _quota_lock(home)
    try:
        _reconcile_all_locked(home)                            # finding 1: reconcile BEFORE charge
        if _charge(home) + RESERVE > CEILING:
            _prune_locked(home, (_charge(home) + RESERVE) - CEILING)   # finding 6: prune FIRST
            if _charge(home) + RESERVE > CEILING:
                return False                                   # best-effort refuse
        _write_entry(paths.ledger_entry_path(home, activity_id), RESERVE, 0)
        return True
    finally:
        _unlock(fd)

def grant(home, activity_id, nbytes):
    fd = _quota_lock(home)
    try:
        p = paths.ledger_entry_path(home, activity_id); e = _read_entry(p)
        if e == "CORRUPT":
            return False
        if e["granted"] + nbytes > ORDINARY_CAP:      # per-activity cap (finding 2)
            return False
        if _charge(home) + nbytes > CEILING:           # global ceiling
            return False
        _write_entry(p, e["reserved"], e["granted"] + nbytes)
        return True
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

def _reconcile_one_locked(home, aid, entry_path):
    lock = paths.owner_lock_path(home, aid)
    if _has_terminal(home, aid):                   # durable terminal -> settle if owner gone
        l = lease_mod.acquire(lock)
        if l is not None:
            l.release(); os.unlink(entry_path)
        return
    if not _has_start(home, aid):                  # reserve-before-start -> lease-gated release
        l = lease_mod.acquire(lock)                # (nothing recorded; nothing to synthesize)
        if l is not None:
            l.release(); os.unlink(entry_path)
        return
    # has start, no terminal: provably-dead owner -> synthesize interrupted/cancelled + settle.
    # synthesize_terminal acquires the owner.lock itself (its own free/busy gate); returns False
    # if BUSY/UNCERTAIN or the write fails, in which case we preserve the charge (safe bias).
    if reconcile_mod.synthesize_terminal(home, aid):
        os.unlink(entry_path)

def _reconcile_all_locked(home):
    for entry in list(paths.secure_scan(paths.quota_dir(home), "*.json")):
        _reconcile_one_locked(home, entry.stem, entry)

def reconcile(home):
    fd = _quota_lock(home)
    try:
        _reconcile_all_locked(home)
    finally:
        _unlock(fd)

def _classify(home, aid):
    """('running'|'problem'|'routine', newest_mtime) for a SETTLED activity — parsed top-level."""
    segs = _segments(home, aid)
    mtime = max((os.lstat(f).st_mtime for f in segs), default=0.0)
    types = _top_types(home, aid)
    if "terminal" not in types:
        return ("running", mtime)
    outcomes = []
    for f in segs:
        for line in f.read_bytes().split(b"\n"):
            if not line:
                continue
            try:
                r = json.loads(line)
                if r.get("type") == "terminal":
                    outcomes.append(r.get("outcome"))
            except Exception:
                pass
    problem = ("integrity" in types) or any(
        o in ("failed", "blocked", "interrupted", "succeeded-with-warnings") for o in outcomes)
    return ("problem" if problem else "routine", mtime)

def _prune_locked(home, need_bytes):
    """Ceiling-override pruner (CALLER HOLDS quota.lock — finding 1): SETTLED items only (no
    live ledger entry), never running/unreconciled, always keep the newest problem, delete
    segment files FIRST. Order: oldest routine -> other non-failures -> oldest problems."""
    base = paths.quota_dir(home).parent
    live = {p.stem for p in paths.secure_scan(paths.quota_dir(home), "*.json")}
    items = []
    for d in paths.secure_iterdirs(base):
        if d.name == "quota" or d.name in live:
            continue
        kind, mtime = _classify(home, d.name)
        if kind == "running":
            continue                               # never prune running/unreconciled
        items.append((d.name, kind, mtime))
    routine = sorted([i for i in items if i[1] == "routine"], key=lambda x: x[2])
    problems = sorted([i for i in items if i[1] == "problem"], key=lambda x: x[2])
    order = routine + (problems[:-1] if problems else [])   # keep newest problem
    freed = 0
    for aid, _, _ in order:
        if freed >= need_bytes:
            break
        sz = _on_disk(home, aid)
        for f in _segments(home, aid):
            os.unlink(f)                           # delete files FIRST (scan reflects it)
        try:
            os.rmdir(paths.activity_dir(home, aid))
        except OSError:
            pass
        freed += sz
    return freed

def prune(home, need_bytes):
    fd = _quota_lock(home)                          # public entry is lock-safe (finding 1)
    try:
        return _prune_locked(home, need_bytes)
    finally:
        _unlock(fd)
```

And the shared crash-recovery module (used by `admit`'s pre-charge reconcile so a crashed run **self-heals without waiting for the UI**, and mirrored in Node `reconcile.js` for display):

```python
# repo_radar/activity/reconcile.py
import json, os
from repo_radar.activity import paths, records, ids
from repo_radar.activity import lease as lease_mod

RECONCILER = "reconciler"

def _cancel_requested(home, aid):
    for f in paths.secure_scan(paths.activity_dir(home, aid), "*.jsonl"):
        for line in f.read_bytes().split(b"\n"):
            if not line:
                continue
            try:
                r = json.loads(line)
                if r.get("type") == "control" and r.get("name") == "cancel_requested":
                    return True
            except Exception:
                pass
    return False

def synthesize_terminal(home, aid):
    """§5: for a provably-dead (lease-free) unterminated activity, acquire the lease, write a
    durable synthetic terminal (by=reconciler), and release. Returns True iff a terminal is now
    durable. Returns False (preserve) when the lease is BUSY/UNCERTAIN or the write fails."""
    lock = paths.owner_lock_path(home, aid)
    try:
        lease = lease_mod.acquire(lock)            # None if busy; raises only on fs error
    except OSError:
        return False
    if lease is None:
        return False                               # owner alive (or uncertain) -> preserve
    try:
        outcome = "cancelled" if _cancel_requested(home, aid) else "interrupted"
        seg = paths.segment_path(home, aid, "python", ids.mint_token())
        rec = records.build("terminal", seq=0, activity_id=aid,
                            outcome=outcome, summary={}, by=RECONCILER)
        blob = records.encode(rec)
        fd = paths.secure_open_append(seg)
        try:
            view = memoryview(blob)
            while view:
                view = view[os.write(fd, view):]
            os.fsync(fd)                           # retain the lock until the terminal is durable
        finally:
            os.close(fd)
        return True
    except Exception:
        return False
    finally:
        lease.release()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest repo_radar/tests/test_activity_quota.py repo_radar/tests/test_activity_reconcile.py -v`
Expected: PASS (all cases). Lifecycle is derived from **parsed top-level** records (no substring false-positives, no `has_start` race); `admit` reconciles crashed runs before charging and prunes settled items before failing closed; `grant` enforces the per-activity cap; `prune` is lock-safe; a crashed started run **self-heals** into a synthetic `interrupted` terminal + settle (no reservation leak); concurrent admissions never exceed the ceiling.

- [ ] **Step 5: Also write `test_activity_reconcile.py`** covering `synthesize_terminal`: lease-free+started ⇒ durable `interrupted` (`by=reconciler`) + released; a prior `control{cancel_requested}` ⇒ `cancelled`; lease-**held** ⇒ returns False (preserve); fs-error path returns False (never raises).

- [ ] **Step 6: Commit**

```bash
git add repo_radar/activity/quota.py repo_radar/activity/reconcile.py repo_radar/tests/test_activity_quota.py repo_radar/tests/test_activity_reconcile.py
git commit -m "feat(activity): crash-recoverable quota ledger + self-healing reconcile (§7)"
```

### Task 1.7: `ActivityWriter` — segment writer + reserve partition + finalizer

**Files:**
- Create: `repo_radar/activity/writer.py`
- Modify: `repo_radar/activity/__init__.py` (re-export `ActivityWriter`)
- Test: `repo_radar/tests/test_activity_writer.py`

**Interfaces:**
- Consumes: everything above (`ids`, `paths`, `records`, `redact`, `lease`, `quota`).
- Produces: `ActivityWriter(home, *, kind, channel, trigger, producer, configured_secrets=(), inherited_id=None, inherited_fd=None, owner_token=None)`; methods `start()`, `event(name, level, detail=None, **fields)`, `control(name, **fields)`, `terminal(outcome, **summary)`, `hand_off_env() -> dict`, property `activity_id`. Enforces:
  - **Adopt-vs-mint with first-producer detection (finding 4):** on adopt, if the segments already contain a `start` → write **handoff `ownership`** only; if **not** → this adopter is the scheduled path's first producer → `quota.admit` + write the single `start` + **initial `ownership`**. Mint path always admits+starts. Assert exactly one `start` per activity.
  - **Partitioned one-shot reserve (finding 2):** three 20 KiB slots — `terminal` (once), `cancel_requested` control (once, idempotent), the dropped-events `integrity` note (once, auto-emitted when an `event` is refused). A reserve write is refused if its slot is already spent or the record exceeds 20 KiB. **Non-`cancel_requested` control names are ordinary (grant-based), not reserve.** No public `integrity()` — further integrity findings are reader-derived (spec §7).
  - **Ordinary vs reserve accounting:** `event`/`start`/non-cancel `control` call `quota.grant` (refused when the per-activity `ORDINARY_CAP`/global ceiling is hit); reserve writes draw from the pre-reserved 60 KiB and are never grant-checked.
  - **Durable append (finding 3):** a full-write loop (handles short writes) + `fsync` on every reserve/terminal record; record construction is **inside** the never-raises boundary. `terminal` **settles quota + releases the lease ONLY after the terminal is confirmed durable**; on any append failure it does **not** settle (the reservation is preserved so the reader can synthesize `interrupted`).
  - **Thread-safety (finding 7):** a `threading.Lock` serializes `seq`+append (the writer is reachable from threaded `SyncLogger` paths).
  - **Best-effort:** any failure emits one non-recursive stderr warning and never raises into the caller.

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

def test_settle_failure_during_terminal_never_raises(tmp_path, monkeypatch, capsys):
    w = writer.ActivityWriter(tmp_path, kind="sync", channel="stable",
                              trigger="cli", producer="python")
    w.start()
    monkeypatch.setattr(quota, "settle", lambda *a, **k: (_ for _ in ()).throw(OSError("boom")))
    w.terminal("succeeded", repos_changed=0, errors=0, warns=0)   # must NOT raise into the sync
    assert "activity" in capsys.readouterr().err.lower()

def test_nested_field_value_is_redacted(tmp_path):
    w = writer.ActivityWriter(tmp_path, kind="sync", channel="stable",
                              trigger="cli", producer="python")
    w.start()
    w.event("x", "error", meta={"nested": "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"})
    blob = json.dumps(_read_all(tmp_path, w.activity_id))
    assert "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" not in blob   # nested value scrubbed
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest repo_radar/tests/test_activity_writer.py -v`
Expected: FAIL (`ModuleNotFoundError`).

- [ ] **Step 3: Write minimal implementation**

```python
# repo_radar/activity/writer.py
import datetime, hashlib, json, os, subprocess, sys, threading
from repo_radar.activity import ids, paths, records, quota, redact
from repo_radar.activity import lease as lease_mod

_PROC_BIRTH = datetime.datetime.now(datetime.timezone.utc).astimezone().isoformat()
_BOOT_ID = None

def _warn(msg):
    print(f"repo-radar: activity: {msg}", file=sys.stderr)

def _boot_id():
    global _BOOT_ID
    if _BOOT_ID is None:
        try:
            out = subprocess.run(["/usr/sbin/sysctl", "-n", "kern.boottime"],
                                 capture_output=True, text=True, timeout=2).stdout.strip()
            _BOOT_ID = hashlib.sha256(out.encode()).hexdigest()[:16]   # stable per-boot
        except Exception:
            _BOOT_ID = ""
    return _BOOT_ID

def _fingerprint():                                   # corroborating evidence only (§2, finding 7)
    return {"pid": os.getpid(), "boot_id": _boot_id(), "proc_birth": _PROC_BIRTH}

class ActivityWriter:
    """Never-raises façade (finding 3): ANY construction failure yields an INACTIVE writer
    whose methods are no-ops and whose hand_off_env() is empty — a broken observability layer
    can never change sync semantics."""
    def __init__(self, home, *, kind, channel, trigger, producer,
                 configured_secrets=(), inherited_id=None, inherited_fd=None, owner_token=None):
        self._active = False
        self._lease = None
        self._lock = threading.Lock()
        self._reserve_used = {"terminal": False, "cancel": False, "dropped": False}
        try:
            self._home = home; self._producer = producer
            self._kind = kind; self._channel = channel; self._trigger = trigger
            self._redactor = redact.Redactor(list(configured_secrets))
            self._seq = 0
            self._writer_id = ids.mint_token()
            adopted = bool(inherited_id) and ids.valid_activity_id(inherited_id)
            self._adopted = adopted
            self._cancel_authority = not adopted        # finding 2: only the MINTER may cancel
            if adopted:
                self.activity_id = inherited_id
                self._lease = lease_mod.adopt(inherited_fd, owner_token,
                                              paths.owner_lock_path(home, inherited_id))
                self._first_producer = not quota._has_start(home, inherited_id)
                if self._first_producer and not quota.admit(home, inherited_id, self._lease):
                    _warn("admission refused; skipping activity recording"); return
            else:
                self.activity_id = ids.mint_activity_id()
                paths.secure_mkdir(paths.activity_dir(home, self.activity_id))
                self._lease = lease_mod.acquire(paths.owner_lock_path(home, self.activity_id))
                if self._lease is None:
                    _warn("could not acquire lease; skipping activity recording"); return
                self._first_producer = True
                if not quota.admit(home, self.activity_id, self._lease):
                    _warn("admission refused; skipping activity recording")
                    self._lease.release(); self._lease = None; return
            self._seg = paths.segment_path(home, self.activity_id, producer, self._writer_id)
            self._active = True
        except Exception as e:                          # never raise into the caller
            _warn(f"init failed; recording disabled: {e}")
            try:
                if self._lease is not None:
                    self._lease.release()
            except Exception:
                pass
            self._lease = None; self._active = False

    def _durable_append(self, kind, payload, *, reserve=False, fsync=False, slot=None):
        if not self._active:
            return False
        with self._lock:
            if slot is not None:                        # one-shot check UNDER the mutex (finding 2)
                if self._reserve_used[slot]:
                    return False
                self._reserve_used[slot] = True
            try:
                rec = records.build(kind, seq=self._seq, activity_id=self.activity_id, **payload)
                blob = records.encode(rec)
                if not reserve and not quota.grant(self._home, self.activity_id, len(blob)):
                    return False                        # ordinary capacity exhausted -> refuse
                fd = paths.secure_open_append(self._seg)
                try:
                    view = memoryview(blob)
                    while view:                         # handle short writes (finding 3)
                        view = view[os.write(fd, view):]
                    if fsync:
                        os.fsync(fd)                    # durability for reserve/terminal
                finally:
                    os.close(fd)
                self._seq += 1
                return True
            except Exception as e:                      # best-effort: never raise into caller
                _warn(f"write failed: {e}")
                return False

    def _redact_val(self, v):
        if isinstance(v, (int, float, bool)) or v is None:
            return v
        # redact AFTER stringifying non-primitives, so nested secret-bearing values can't
        # bypass the redactor (finding 7)
        return self._redactor.scrub(v if isinstance(v, str) else json.dumps(v))

    def _redact_fields(self, fields):
        return {k: self._redact_val(v) for k, v in fields.items()}

    def start(self):
        if not self._active:
            return
        if self._adopted and not self._first_producer:  # adopt-existing: handoff ownership only
            self._durable_append("ownership", dict(owner_token=self._lease.owner_token,
                role="handoff", producer=self._producer, **_fingerprint()), fsync=True)
            return
        self._durable_append("start", dict(kind=self._kind, channel=self._channel,
            trigger=self._trigger, created_by=self._producer), fsync=True)
        self._durable_append("ownership", dict(owner_token=self._lease.owner_token,
            role="initial", producer=self._producer, **_fingerprint()), fsync=True)

    def event(self, name, level, detail=None, **fields):
        ok = self._durable_append("event", dict(level=level, event=name,
            fields=self._redact_fields(fields),
            detail=self._redactor.scrub(detail) if detail is not None else None))
        if ok is False:                                 # slot guarantees at-most-once
            self._durable_append("integrity", dict(kind="dropped-events"),
                                 reserve=True, fsync=True, slot="dropped")

    def control(self, name, **fields):
        if name == "cancel_requested":
            if not self._cancel_authority:              # exclusive authority (finding 2)
                return
            self._durable_append("control", dict(name=name, fields=self._redact_fields(fields)),
                                 reserve=True, fsync=True, slot="cancel")
        else:                                           # non-cancel = ordinary (grant-based)
            self._durable_append("control", dict(name=name, fields=self._redact_fields(fields)))

    def terminal(self, outcome, **summary):
        if not self._active:
            return
        ok = self._durable_append("terminal", dict(outcome=outcome,
            summary=self._redact_fields(summary), by=self._lease.owner_token),
            reserve=True, fsync=True, slot="terminal")
        try:                                            # settle+release must NEVER raise (finding 3)
            if ok:
                quota.settle(self._home, self.activity_id)   # settle ONLY after durability
            else:
                _warn("terminal not durable; leaving reservation for reconciliation")
            self._lease.release()
        except Exception as e:
            _warn(f"finalization cleanup failed: {e}")
        finally:
            self._active = False

    def hand_off_env(self):
        if not self._active or self._lease is None or self._lease.fd is None:
            return {}                                   # inactive/refused -> no dead fd (finding 3)
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
Expected: PASS (10 tests). Never-raises façade (inactive-on-failure, empty `hand_off_env`); three one-shot reserve slots checked under the mutex; exclusive cancellation authority (only the minter); nested field values redacted; `terminal` settles+releases only after a durable (`fsync`'d) write and never raises during cleanup.

- [ ] **Step 5: Commit**

```bash
git add repo_radar/activity/writer.py repo_radar/activity/__init__.py repo_radar/tests/test_activity_writer.py
git commit -m "feat(activity): ActivityWriter — partitioned reserve, durable terminal, thread-safe, best-effort"
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

def _run_bootstrap(tmp_path, aid, held):
    env = {**os.environ, "HOME": str(tmp_path),
           "REPO_RADAR_ACTIVITY_ID": aid,
           "REPO_RADAR_ACTIVITY_OWNER_TOKEN": held.owner_token,
           "REPO_RADAR_ACTIVITY_LOCK_FD": str(held.fd)}
    return subprocess.run([sys.executable, "-m", "repo_radar.activity.bootstrap",
                           "--kind", "sync", "--channel", "stable", "--trigger", "scheduled"],
                          env=env, pass_fds=[held.fd], capture_output=True, text=True)

def test_bootstrap_is_first_producer_writes_start_and_initial_ownership(tmp_path):
    # scheduled path: the shell mints+holds; NO start exists yet -> bootstrap admits + starts
    aid = ids.mint_activity_id()
    paths.secure_mkdir(paths.activity_dir(tmp_path, aid))
    held = lease.acquire(paths.owner_lock_path(tmp_path, aid))   # shell holds the fd
    r = _run_bootstrap(tmp_path, aid, held)
    assert r.returncode == 0, r.stderr
    recs = _seg_records(tmp_path, aid)
    assert [x["type"] for x in recs].count("start") == 1
    assert any(x["type"] == "ownership" and x["role"] == "initial" for x in recs)
    assert paths.ledger_entry_path(tmp_path, aid).exists()       # admitted
    assert lease.probe_busy(paths.owner_lock_path(tmp_path, aid)) # shell still holds it

def test_bootstrap_adopts_existing_start_writes_handoff_only(tmp_path):
    # Electron already admitted + wrote start; bootstrap must NOT write a second start
    from repo_radar.activity import quota
    aid = ids.mint_activity_id()
    paths.secure_mkdir(paths.activity_dir(tmp_path, aid))
    held = lease.acquire(paths.owner_lock_path(tmp_path, aid))
    quota.admit(tmp_path, aid, held)
    seg = paths.segment_path(tmp_path, aid, "electron", "cafebabe")
    fd = paths.secure_open_append(seg)
    os.write(fd, b'{"schema_version":1,"type":"start","seq":0,"ts":"t","kind":"sync"}\n'); os.close(fd)
    r = _run_bootstrap(tmp_path, aid, held)
    assert r.returncode == 0, r.stderr
    recs = _seg_records(tmp_path, aid)
    assert [x["type"] for x in recs].count("start") == 1         # still exactly one
    assert any(x["type"] == "ownership" and x["role"] == "handoff" for x in recs)

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
    if not (ids.valid_activity_id(aid) and token and fd and fd.isdigit()):
        print("repo-radar: activity: bootstrap missing/invalid handoff env", file=sys.stderr)
        return 0                                   # best-effort: never block the sync
    # ActivityWriter never raises; a failed adopt/admit leaves it INACTIVE and writes NOTHING
    # (no false ack — finding 4). Signal that with a non-zero exit; the dispatcher does not abort.
    w = ActivityWriter(home, kind=a.kind, channel=a.channel, trigger=a.trigger,
                       producer="dispatcher", inherited_id=aid,
                       inherited_fd=int(fd), owner_token=token)
    if not w._active:
        print("repo-radar: activity: bootstrap could not adopt lease; recording disabled",
              file=sys.stderr)
        return 1                                   # informational only (a failed adopter is not owner)
    w.start()
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
Expected: PASS (3 tests).

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

def _durable_start(home, aid):
    seg = paths.segment_path(home, aid, "python", "deadbeef")
    fd = paths.secure_open_append(seg)
    os.write(fd, b'{"schema_version":1,"type":"start","seq":0,"ts":"t","kind":"sync"}\n'); os.close(fd)

def test_crash_after_durable_start_self_heals_to_interrupted(tmp_path):
    # finding 1: durable start, lease freed, NO terminal -> reconcile synthesizes + settles
    aid = ids.mint_activity_id(); paths.secure_mkdir(paths.activity_dir(tmp_path, aid))
    l = lease.acquire(paths.owner_lock_path(tmp_path, aid))
    quota.admit(tmp_path, aid, l); _durable_start(tmp_path, aid)
    l.release()                                          # crash: lease freed, no terminal
    quota.reconcile(tmp_path)
    assert not paths.ledger_entry_path(tmp_path, aid).exists()   # settled (no reservation leak)
    assert "terminal" in quota._top_types(tmp_path, aid)         # synthetic terminal present

def test_reconcile_reclaims_only_abandoned_pre_start(tmp_path):
    aid = ids.mint_activity_id(); paths.secure_mkdir(paths.activity_dir(tmp_path, aid))
    l = lease.acquire(paths.owner_lock_path(tmp_path, aid))
    quota.admit(tmp_path, aid, l)                        # reserved, NO start
    l.release()                                          # died pre-start, lease free
    quota.reconcile(tmp_path)
    assert not paths.ledger_entry_path(tmp_path, aid).exists()   # released (nothing to synthesize)
```

- [ ] **Step 2: Run to verify it passes**

Run: `python -m pytest repo_radar/tests/test_activity_phase1_acceptance.py -v`. Lifecycle is derived from parsed segments (finding 1 — no `has_start` flag): a crashed started run **self-heals** into a synthetic `interrupted` terminal and settles (no leak, the reservation is not stranded until the UI opens), while a genuine pre-`start` abandonment (lease free, no `start`) is simply released.

- [ ] **Step 3: Commit**

```bash
git add repo_radar/tests/test_activity_phase1_acceptance.py
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

**The equivalence is pinned by committed golden data covering ALL record types + Unicode + truncation (finding 8):** `golden-cases.json` lists `{type, args}` (each with a fixed `ts`); `golden-expected.jsonl` is the byte-exact encoder output, **generated once** by a committed helper `python -m repo_radar.activity._gen_golden` and checked in. Both suites encode each case and assert byte-equality against the committed expectation — so neither encoder can drift silently. (`records.py.build`/`records.js.buildRecord` already accept the `ts=` override from Task 1.3.)

- [ ] **Step 1: Author `golden-cases.json`** covering every record type + a non-ASCII (`"café 数据"`) case + a value that exceeds `MAX_VALUE_BYTES` (asserting identical truncation):

```json
[
  {"type":"start","args":{"seq":0,"activity_id":"00000000-0000-4000-8000-000000000000","ts":"2026-08-14T00:00:00-07:00","kind":"sync","channel":"stable","trigger":"cli","created_by":"python"}},
  {"type":"ownership","args":{"seq":1,"activity_id":"00000000-0000-4000-8000-000000000000","ts":"2026-08-14T00:00:00-07:00","owner_token":"deadbeef","role":"initial","producer":"python","pid":1234,"boot_id":"a1b2c3d4e5f60718","proc_birth":"2026-08-14T00:00:00-07:00"}},
  {"type":"event","args":{"seq":2,"activity_id":"00000000-0000-4000-8000-000000000000","ts":"2026-08-14T00:00:00-07:00","level":"info","event":"repo_updated","fields":{"repo":"café 数据","count":30},"detail":"line1\nline2"}},
  {"type":"control","args":{"seq":3,"activity_id":"00000000-0000-4000-8000-000000000000","ts":"2026-08-14T00:00:00-07:00","name":"cancel_requested","fields":{}}},
  {"type":"terminal","args":{"seq":4,"activity_id":"00000000-0000-4000-8000-000000000000","ts":"2026-08-14T00:00:00-07:00","outcome":"succeeded-with-warnings","summary":{"repos_changed":1,"errors":0,"warns":2},"by":"deadbeef"}},
  {"type":"integrity","args":{"seq":5,"activity_id":"00000000-0000-4000-8000-000000000000","ts":"2026-08-14T00:00:00-07:00","kind":"dropped-events"}},
  {"type":"event","args":{"seq":6,"activity_id":"00000000-0000-4000-8000-000000000000","ts":"2026-08-14T00:00:00-07:00","level":"info","event":"big","fields":{"v":"X̶TRUNCATE_ME_REPEATED..."}}}
]
```

- [ ] **Step 2: Write the failing tests** (both read the SAME two files)

```js
// menubar/activity/__tests__/records-golden.test.js
const test = require('node:test'); const assert = require('node:assert');
const fs = require('node:fs'); const path = require('node:path');
const { buildRecord, encodeRecord } = require('../records');
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden-cases.json')));
const expected = fs.readFileSync(path.join(__dirname, 'golden-expected.jsonl'), 'utf8').split('\n');

test('node encodes every record type byte-for-byte (Unicode + truncation)', () => {
  cases.forEach((c, i) => {
    const line = Buffer.from(encodeRecord(buildRecord(c.type, c.args))).toString('utf8');
    assert.strictEqual(line, expected[i] + '\n');
  });
});
```

```python
# repo_radar/tests/test_activity_golden.py
import json, pathlib
from repo_radar.activity import records as R
D = pathlib.Path("menubar/activity/__tests__")

def test_python_encodes_every_record_type_byte_for_byte():
    cases = json.loads((D / "golden-cases.json").read_text())
    expected = (D / "golden-expected.jsonl").read_text().split("\n")
    for i, c in enumerate(cases):
        assert R.encode(R.build(c["type"], **c["args"])).decode("utf-8") == expected[i] + "\n"
```

- [ ] **Step 3: Run both → FAIL** (no `golden-expected.jsonl`, no Node modules).

- [ ] **Step 4: Implement** `ids.js`/`paths.js`/`records.js` as exact CommonJS mirrors (same regexes, bounds, encoding); add the `_gen_golden` helper and **generate + commit** `golden-expected.jsonl`; add `"test": "node --test"` to `menubar/package.json`.

- [ ] **Step 5: Run both → PASS.** `cd menubar && node --test` and `python -m pytest repo_radar/tests/test_activity_golden.py -v`. The two encoders provably agree on every record type, Unicode, and truncation.

- [ ] **Step 6: Commit**

```bash
git add menubar/activity/ids.js menubar/activity/paths.js menubar/activity/records.js menubar/activity/index.js menubar/activity/__tests__/ menubar/package.json repo_radar/activity/_gen_golden.py repo_radar/tests/test_activity_golden.py
git commit -m "feat(activity): Node ids/paths/records mirror + all-record-type golden equivalence"
```

### Task 2.2: Node lease + quota + writer (write side) + cross-language lock interop

**Files:**
- Create: `menubar/activity/lease.js`, `menubar/activity/quota.js`, `menubar/activity/writer.js`, `menubar/activity/reconcile.js` (the **`synthesizeTerminal(home, aid)`** half — mirror of `reconcile.py`; Node `quota.admit` reconciles-before-charging just like Python, so this is needed **now**, in Phase 2. Task 3.3 later adds the reader-display `reconcile()` to the same file.)
- Test: `menubar/activity/__tests__/lease.test.js`, `menubar/activity/__tests__/quota.test.js`, `menubar/activity/__tests__/writer.test.js`, `menubar/activity/__tests__/lock-interop.test.js`, `menubar/activity/__tests__/reconcile-synth.test.js`

**Interfaces:**
- Produces (CommonJS mirror of Python write side): `acquire(lockPath)`, `adopt(inheritedFd, ownerToken, lockPath)`, `probe(lockPath)` (tri-state), `probeBusy(lockPath)`, `admit`, `grant`, `settle`, `reconcile`, `prune`, `ActivityWriter` (Electron manual path: `start`, `event`, `control`, `terminal`, `handOffEnv()`, `dropLocalReference()`, `activityId`, `_handedOff`). Node holds the lease via a retained fd + `/usr/bin/lockf -t 0 <fd>` (spec §5); `probe` runs `/usr/bin/lockf -t 0` on a fresh fd and maps exit 0→FREE, 75→BUSY, other→UNCERTAIN. **JSON ledger (Decision 3), lifecycle derived from segments, per-activity cap in `grant`, partitioned one-shot reserve — byte-for-byte the Python contract.**

- [ ] **Step 1: Write the failing cross-language interop test — BOTH directions (finding 8)**

```js
// menubar/activity/__tests__/lock-interop.test.js
const test = require('node:test'); const assert = require('node:assert');
const cp = require('node:child_process'); const fs = require('node:fs'); const os = require('node:os');
const path = require('node:path');
const { acquire, probeBusy } = require('../lease');
const { activityDir, ownerLockPath, secureMkdir } = require('../paths');

function fresh() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'act-'));
  const aid = '00000000-0000-4000-8000-000000000000';
  secureMkdir(activityDir(home, aid));
  return { home, lp: ownerLockPath(home, aid) };
}
const pyProbeBusy = (lp) => cp.spawnSync('python3', ['-c',
  `import sys;from repo_radar.activity import lease;sys.exit(0 if lease.probe_busy(${JSON.stringify(lp)}) else 3)`]).status;

test('Node-held lock is seen BUSY by Python', () => {
  const { lp } = fresh(); const lease = acquire(lp);
  assert.strictEqual(pyProbeBusy(lp), 0, 'python saw the Node lock busy');
  lease.release(); assert.strictEqual(probeBusy(lp), false);
});

test('Python-held lock is seen BUSY by Node (reverse direction)', () => {
  const { lp } = fresh();
  // Python holds the lock for 2s in a child; Node must observe BUSY during that window
  const child = cp.spawn('python3', ['-c',
    `import time;from repo_radar.activity import lease;l=lease.acquire(${JSON.stringify(lp)});time.sleep(2)`]);
  const wait = Date.now() + 800; while (Date.now() < wait) {}   // let it acquire
  assert.strictEqual(probeBusy(lp), true, 'node saw the Python lock busy');
  child.kill('SIGKILL');
});
```

- [ ] **Step 2..5:** Run → FAIL; implement `lease.js`/`quota.js`/`writer.js` mirroring the Python semantics (JSON ledger, same constants, §5 validation truth table incl. tri-state probe, partitioned one-shot reserve, durable append). **Add shared behavioral-vector tests (finding 8):** a committed `menubar/activity/__tests__/behavior-vectors.json` drives the SAME scenarios in both languages — grant per-activity-cap refusal, one-shot reserve slots, corrupt-ledger 4 MiB charge, terminal-durability-failure preserving the reservation — each asserted in `node:test` and in a `repo_radar/tests/test_activity_behavior_vectors.py`. Run → PASS.

- [ ] **Step 6: Commit**

```bash
git add menubar/activity/lease.js menubar/activity/quota.js menubar/activity/writer.js menubar/activity/__tests__/ repo_radar/tests/test_activity_behavior_vectors.py
git commit -m "feat(activity): Node lease/quota/writer + bidirectional lock interop + shared behavioral vectors"
```

### Task 2.3: Electron `triggerSync` — acquire, start, hold across guards, hand off; cancel-ordering fix

**Files:**
- Modify: `menubar/main.js` — `triggerSync` (1078–1121), the `runtime.runSync` call site (1317), the `stop-sync` handler (2115–2192)
- Test: `menubar/__tests__/activity-trigger.test.js`

**Interfaces (finding 5 — full lifecycle ordering + handoff state machine):**
- Consumes: `menubar/activity` (`ActivityWriter`, `quota.reconcile`).
- Produces `menubar/activity/trigger-glue.js` (Electron-free, unit-testable):
  - `beginManualActivity(home, {channel, trigger}) -> { writer, lockFd }` — mints, acquires, admits, writes `start`+initial `ownership`, **holds** the fd. Called **first in `triggerSync`, before any gate** (identity-before-first-gate).
  - `onContention(writer, kind)` — writes `terminal('skipped')` + `release()`. Used for **already-syncing** (`currentSyncProcess`, main.js:1080-1082) **and** root-lock-busy (exit 75) — both are contention → `skipped` (finding 5).
  - `onGuardBlock(writer, reason)` — writes `terminal('blocked', reason)` + `release()` (dev-ownership 1092-1108; second dispatch guard 1284-1297).
  - `handOff({writer, child, home})` — waits (bounded, e.g. ≤5 s) for the child to durably write **`ownership{role:'handoff'}` OR any `terminal`** (either proves the child took ownership / already finalized). On that ack → `writer.dropLocalReference()` (close-only, **no `LOCK_UN`** — the child's shared OFD keeps the lease) + controller-only (`_handedOff=true`). **On timeout (no ack) the shared open-file description means Electron must NOT `LOCK_UN` while the child may be alive (finding 4):** Electron **`child.kill('SIGKILL')` and awaits the child's exit** (which closes the child's copy of the fd); **only once the child is confirmed dead** — Electron now the sole fd holder — does it `writer.terminal('failed')` (a now-safe `LOCK_UN`). If the child **cannot be confirmed dead**, Electron calls `writer.dropLocalReference()` (never unlock under a live child) and leaves the activity `running` for the reconciler to finalize.
  - `onCancel({writer, child})` — appends `control('cancel_requested')` to Electron's own segment **before** `child.kill('SIGTERM')`. Allowed in the controller-only state; `terminal()` is a **no-op after handoff** (only the executing owner/reconciler finalizes).
- `ActivityWriter` (Node, Task 2.2) gains `dropLocalReference()` and the `_handedOff` controller state (mirrors the Python `Lease.drop_local_reference` + terminal-suppression).

- [ ] **Step 1: Write the failing tests** (cancel-ordering + contention + controller state)

```js
// menubar/__tests__/activity-trigger.test.js
const test = require('node:test'); const assert = require('node:assert');
const { onCancel, onContention, handOff } = require('../activity/trigger-glue');

test('cancel appends control{cancel_requested} BEFORE SIGTERM', () => {
  const calls = [];
  const writer = { control: (n) => calls.push('control:' + n), _handedOff: true };
  const child = { kill: (sig) => calls.push('kill:' + sig) };
  onCancel({ writer, child });
  assert.deepStrictEqual(calls, ['control:cancel_requested', 'kill:SIGTERM']);
});

test('contention finalizes the attempt as skipped', () => {
  const calls = [];
  const writer = { terminal: (o) => calls.push('terminal:' + o), release: () => calls.push('release') };
  onContention(writer, 'already-syncing');
  assert.deepStrictEqual(calls, ['terminal:skipped', 'release']);
});

test('handOff drops the local fd WITHOUT unlocking after a real child ack', async () => {
  const events = [];
  const writer = { dropLocalReference: () => events.push('drop'),
                   terminal: (o) => events.push('terminal:' + o) };
  const child = { killed: false, kill() { this.killed = true; }, on() {} };
  // the child writes ownership{role:handoff}; ackSeen resolves true
  await handOff({ writer, child, home: '/x', _awaitAck: async () => true });
  assert.deepStrictEqual(events, ['drop']);            // dropLocalReference, NO terminal, NO kill
  assert.strictEqual(child.killed, false);
});

// helpers: mkChild(exits) fakes a child whose post-kill exit-wait resolves to `exits`;
// mkWriter(arr) records dropLocalReference()/terminal() calls into arr.
test('handOff timeout: kill + confirm-dead THEN terminal (safe unlock); never unlock a live child', async () => {
  // (a) child confirmed dead -> terminal('failed'); (b) child stays alive -> dropLocalReference only
  const dead = []; const deadChild = mkChild(/*exits=*/true);
  await handOff({ writer: mkWriter(dead), child: deadChild, home: '/x', _awaitAck: async () => false });
  assert.ok(deadChild.killed && dead.includes('terminal:failed'));         // killed, then safe unlock

  const alive = []; const aliveChild = mkChild(/*exits=*/false);
  await handOff({ writer: mkWriter(alive), child: aliveChild, home: '/x', _awaitAck: async () => false });
  assert.ok(aliveChild.killed && alive.includes('drop') && !alive.some(e => e.startsWith('terminal')));
});
```

A companion **real-process** test (`menubar/activity/__tests__/handoff-realchild.test.js`) spawns an actual child that inherits the locked fd and either writes a handoff `ownership` (ack) or sleeps without acking, asserting the lock is **never released while that child is alive** (an independent `probeBusy` stays true) — this is the load-bearing proof for finding 4, not just the injected-boolean unit test.

- [ ] **Step 2: Run → FAIL** (`trigger-glue` missing).

- [ ] **Step 3: Implement** `trigger-glue.js` and wire `main.js` in this exact order:
  1. **First line of `triggerSync`** (before the already-syncing guard at 1080): `const activity = beginManualActivity(os.homedir(), { channel: runtimeChannel, trigger });`.
  2. already-syncing (1080-1082) → `onContention(activity.writer, 'already-syncing'); return;`.
  3. dev-ownership block (1096-1106) + second dispatch guard (1289) → `onGuardBlock(activity.writer, reason)` alongside the existing error-surface code, then `return`.
  4. `runtime.runSync` (1317): spread `...activity.writer.handOffEnv()` into `shellEnv`, pass `activity.lockFd` (→ child **fd 4**, Task 2.4); in `onChild`, `await handOff({ writer: activity.writer, child, home: os.homedir() })`.
  5. runSync **reject** — exit-75 "another sync is already running" → `onContention(activity.writer, 'root-busy')` (skipped); any other spawn error → `activity.writer.terminal('failed')`.
  6. `stop-sync` handler (2115): `onCancel({ writer: activity.writer, child: currentSyncProcess })` — `cancel_requested` **before** `kill('SIGTERM')` (2137), closing the §5 race.
  7. App start: `require('./activity/quota').reconcile(os.homedir())` once.

- [ ] **Step 4: Run → PASS.** Documented manual check: a dev-guard block yields a `blocked` Activity item (not just an `errorLog` string); a request while syncing yields a `skipped` item.

- [ ] **Step 5: Commit**

```bash
git add menubar/main.js menubar/activity/trigger-glue.js menubar/activity/writer.js menubar/__tests__/activity-trigger.test.js
git commit -m "feat(activity): Electron lifecycle — start-before-gates, skipped-on-contention, handoff ack + dropLocalReference, cancel-ordering"
```

### Task 2.4: Dispatcher + `runSync` — carry the lease, delegate to Python, last-resort sh incident

**Files:**
- Modify: `menubar/runtime/index.js` (`runSync` 132–149), `menubar/runtime/dispatchers.js` (`_script` 11–111)
- Test: `menubar/runtime/__tests__/dispatcher-activity.test.js`

**Interfaces (finding 5):**
- Consumes: `REPO_RADAR_ACTIVITY_ID` / `_OWNER_TOKEN` / `_LOCK_FD` env when present (manual path), else mints.
- `runSync` adds the inherited lock fd to the child `stdio` at index **4** (fd remap: parent fd → child fd 4) and forwards the three env vars.
- The generated `_script`:
  - **Lease setup:** if `REPO_RADAR_ACTIVITY_ID` is set (manual/Electron path) → use the inherited fd 4 + env (do **not** mint). Else (scheduled path) → mint `activity_id` (`uuidgen | tr A-F a-f`), `owner_token` (`openssl rand -hex 4`), `mkdir -m 700` the activity dir, open `owner.lock` on a dedicated fd, `/usr/bin/lockf -t 0` it, and export the three env vars.
  - **Scheduled path:** `python -m repo_radar.activity.bootstrap` runs BEFORE the verify/dev guards and (first-producer) writes `start`+initial `ownership`. A **failed** bootstrap exits non-zero and writes **nothing** (no false ack); the dispatcher still proceeds (observability is best-effort; the lease is held by the shell's fd and survives `exec`, so the reconciler finalizes it) — a failed adopter never proceeds *as owner* but the sync itself is not aborted.
  - **Manual path (id inherited):** the dispatcher does **not** run bootstrap — the exec'd python (the executing owner, via `cli.py`/`sync_mode`) adopts the fd and writes the **handoff `ownership`** that is Electron's `handOff` acknowledgement.
  - **On a dev/verify guard failure:** `python -m repo_radar.activity.finalize --outcome blocked --reason <code>` (writes terminal + settle + release), then exit. On the manual path this terminal also satisfies Electron's `handOff` ack (it waits for ownership-handoff OR any terminal).
  - **On root exec-lock contention** (the existing fd-9 `.exec.lock` returns exit 75): `python -m repo_radar.activity.finalize --outcome skipped`, then exit 75 (finding 5 — contention is `skipped`, not lost).
  - **On success:** `exec` python (the executing owner adopts fd 4 and runs `sync`), which writes its own handoff `ownership`.
  - **Last-resort (finding 1):** only if the bootstrap python **cannot execute at all**, append ONE bounded, redacted line to the **System diagnostic stream** `~/Library/Logs/repo-radar/sync.error.log` — **never** an un-quota'd Activity segment.
  - Preserve the existing root `.exec.lock` fd-9 handshake untouched.

- [ ] **Step 1: Write the failing tests** (the generated script's ordering + contention + last-resort)

```js
// menubar/runtime/__tests__/dispatcher-activity.test.js
const test = require('node:test'); const assert = require('node:assert');
const { _script } = require('../dispatchers');   // export _script for testing

test('scheduled script: bootstrap precedes verify; finalize handles block AND skipped', () => {
  const s = _script('stable', ' sync --status-server');
  const iBootstrap = s.indexOf('activity.bootstrap');
  const iVerify = s.indexOf('verify.py');
  assert.ok(iBootstrap > 0 && iVerify > 0 && iBootstrap < iVerify, 'bootstrap precedes verify');
  assert.ok(/activity\.finalize[^\n]*--outcome[= ]blocked/.test(s), 'blocked on guard failure');
  assert.ok(/activity\.finalize[^\n]*--outcome[= ]skipped/.test(s), 'skipped on root contention');
  assert.ok(s.includes('REPO_RADAR_ACTIVITY_ID'), 'exports identity');
});

test('last-resort writes to the System stream, not an activity segment', () => {
  const s = _script('stable', ' sync --status-server');
  assert.ok(s.includes('sync.error.log'), 'last-resort goes to System diagnostics');
  assert.ok(!/activity\/[^\n]*\.jsonl/.test(s.split('last-resort')[1] || ''),
            'last-resort never appends an activity segment');
});
```

- [ ] **Step 2..5:** Run → FAIL; implement the `_script` additions (mint-or-inherit lease, bootstrap before guards, finalize blocked/skipped, System-stream last resort) and the `runSync` fd-4 remap + env passing; add a Node-side integration that spawns the real generated script against a stub python to assert the ordering executes (not just the string). Run → PASS. The full production-chain integration is Task 2.7.

- [ ] **Step 6: Commit**

```bash
git add menubar/runtime/index.js menubar/runtime/dispatchers.js menubar/runtime/__tests__/dispatcher-activity.test.js
git commit -m "feat(activity): dispatcher carries the lease, delegates to Python, skipped-on-contention, System-stream last resort"
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
import json, os, subprocess, sys
from repo_radar.activity import paths

def _terminal_outcomes(tmp_path):
    base = paths.quota_dir(tmp_path).parent
    outs = []
    for d in [p for p in base.iterdir() if p.is_dir() and p.name != "quota"]:
        for f in d.glob("*.jsonl"):
            for line in f.read_text().splitlines():
                r = json.loads(line)
                if r["type"] == "terminal":
                    outs.append(r["outcome"])
    return outs

def test_dependency_failure_records_a_blocked_terminal(tmp_path):
    # Force check_dependencies to fail in a child; assert an ACTUAL blocked terminal (finding 8)
    env = {**os.environ, "HOME": str(tmp_path), "REPO_RADAR_FORCE_DEPS_FAIL": "1"}
    subprocess.run([sys.executable, "-m", "repo_radar.cli", "sync", "--dry-run"], env=env)
    assert "blocked" in _terminal_outcomes(tmp_path)   # not merely "a directory exists"
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
import json, os, subprocess, sys
from repo_radar.modes import sync as S
from repo_radar.activity import paths

def test_severity_rule_mapping():
    assert S._activity_level("info-ish", is_degraded=False, is_exhausted=False) == "info"
    assert S._activity_level("x", is_degraded=True, is_exhausted=False) == "warn"
    assert S._activity_level("x", is_degraded=False, is_exhausted=True) == "error"

def test_outcome_mapping_is_the_seven():
    assert S._finalize_outcome(errors=0, warns=0, degraded=False) == "succeeded"
    assert S._finalize_outcome(errors=0, warns=1, degraded=True) == "succeeded-with-warnings"
    assert S._finalize_outcome(errors=2, warns=0, degraded=False) == "failed"

def test_real_sync_path_writes_an_actual_terminal(tmp_path):
    # finding 8: a real `sync` run (no config in an isolated HOME) must finalize with a
    # durable terminal in the seven — proving the config-abort leak is closed and the writer
    # is threaded, not just that helpers return values.
    env = {**os.environ, "HOME": str(tmp_path)}
    subprocess.run([sys.executable, "-m", "repo_radar.cli", "sync", "--dry-run"], env=env)
    base = paths.quota_dir(tmp_path).parent
    outs = [json.loads(l)["outcome"]
            for d in base.iterdir() if d.is_dir() and d.name != "quota"
            for f in d.glob("*.jsonl") for l in f.read_text().splitlines()
            if json.loads(l)["type"] == "terminal"]
    assert outs and set(outs) <= {"succeeded","succeeded-with-warnings","blocked","failed",
                                  "cancelled","skipped","interrupted"}
```

- [ ] **Step 2..4:** Run → FAIL; extract the pure helpers `_activity_level(...)` and `_finalize_outcome(...)` and thread the writer through `sync_mode`, calling `writer.event(...)` alongside each `sync_logger.event/error` (routing the git-stderr **error detail through `detail=`**, redacted, not a field — finding 7), `writer.terminal(outcome, ...)` at **every** return (unknown-model 931-940 → `blocked`; catch-up satisfied → `skipped`; network abort → `failed`; **config-abort 1051-1055 → terminal + close the logger leak**; empty-repos → `succeeded`; normal end → the mapped outcome), and `writer.control` on cancellation. Run → PASS.

- [ ] **Step 5: Commit**

```bash
git add repo_radar/modes/sync.py repo_radar/tests/test_sync_activity.py
git commit -m "feat(activity): sync_mode threads ActivityWriter; SyncLogger source-owned severity; System incidents"
```

### Task 2.7: Cross-process macOS integration — the REAL production chain (finding 8)

**Files:**
- Test: `menubar/runtime/__tests__/dispatcher-chain.integration.test.js` (macOS-gated `node:test`)

This drives the **actual** production path, not a synthetic stand-in: `runtime.runSync` → the **generated** `/bin/sh` dispatcher (`emitRunSync`) → `bootstrap` → verify guard → `exec` python. A minimal fake **generation** is provisioned in an isolated `HOME`: a `venv/bin/python` symlink to the real interpreter, a `repo-radar` entry that `exec`s `python -m repo_radar.cli`, and a `verify.py` that passes — so the real generated script runs unmodified.

- [ ] **Step 1: Write the test**
  - **Happy path:** build the fake GEN + generated dispatcher, `runSync({home, channel, env, onChild})` with a one-repo dry-run config; wait for completion; assert the activity segment shows `start` → `ownership{role:'handoff'}` (same `owner_token` as the initial) → `terminal{by:<owner_token>}`, and `probeBusy(owner.lock) === false` (released). **Proves** the lease survives `runSync` spawn-inheritance (fd 4) + the shell + `exec` into python, and the handoff carries one continuous `owner_token`.
  - **Root contention:** hold the root `.exec.lock` (fd 9) in a sidecar, run the dispatcher; assert a `skipped` terminal (finding 5), exit 75.
  - **Crash:** kill the python child before its terminal; assert `probeBusy` is false (freed); then run the **Phase-1 Python reconciler** (`python -c "import os;from repo_radar.activity import quota;quota.reconcile(os.environ['HOME'])"`) and assert it synthesized a durable `interrupted` terminal (`by:'reconciler'`) + settled the reservation; a pre-kill `control{cancel_requested}` yields `cancelled` instead. (No Phase-3 dependency — the foundation reconciler exists in Task 1.6; the Node `reconcile.js` produces the same outcomes for display in Phase 3 — finding 5.)
  - **Failed validation:** hand a *wrong* (unlocked look-alike) fd; assert the child rejects the handoff and Electron's `handOff` times out → the initial owner finalizes `failed`.

- [ ] **Step 2: Run → PASS** on macOS: `cd menubar && node --test runtime/__tests__/dispatcher-chain.integration.test.js`.

- [ ] **Step 3: Commit**

```bash
git add menubar/runtime/__tests__/dispatcher-chain.integration.test.js
git commit -m "test(activity): real dispatcher-chain integration — lease survival, owner_token continuity, skipped/crash/cancel/failed-validation"
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

**Files:** **Extend** `menubar/activity/reconcile.js` (add the reader-display `reconcile(home, activityId)`; `synthesizeTerminal` already exists from Task 2.2); Test `menubar/activity/__tests__/reconcile.test.js`.

**Interfaces:** `reconcile(home, activityId) -> { outcome|null, synthesized }`. Semantics (§5, §6) driven by the **tri-state `lease.probe`** (finding 7): for a `running` attempt (has `start`, no `terminal`) — **`BUSY` ⇒ leave `running`** (`outcome:null`); **`FREE` (or lock absent) ⇒ owner gone** → `acquire` + synthesize `interrupted`, or `cancelled` if a `control{cancel_requested}` exists, **retain the lock until the synthetic terminal is durably (`fsync`) appended**, then release + `quota.settle`; **`UNCERTAIN` ⇒ leave `running` + a System `integrity` Problem** (never guess a dead owner). Duplicate terminals (same outcome) group with a count; **conflicting** terminals (different outcomes) ⇒ `interrupted` + an integrity Problem (§6).

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
test('UNCERTAIN probe => stays running + a System integrity Problem (never guesses dead)', () => { /* ... */ });
test('duplicate terminals (same outcome) group with a count', () => { /* seed two identical terminals */ });
test('conflicting terminals (different outcomes) => interrupted + integrity Problem', () => { /* ... */ });
```

- [ ] **Step 2-4:** Run → FAIL; implement using `parse`+`merge` to assemble records and the **tri-state `lease.probe`** (finding 8): `FREE` ⇒ `acquire`+synthesize (retain the lock until the synthetic terminal is durably `fsync`'d, then `quota.settle`); `BUSY` ⇒ `running`; **`UNCERTAIN` ⇒ `running` + a System `integrity` Problem** (never collapse to busy). Duplicate terminals group with a count; conflicting terminals ⇒ `interrupted` + integrity. The synthesize path mirrors Python `reconcile.synthesize_terminal` (producer `python`, a reconciler writer-id, `by:'reconciler'`). Run → PASS.

- [ ] **Step 5: Commit** `feat(activity): lock-probe reconciliation + conflict/duplicate handling`.

### Task 3.4: `redact.js` (read-time backstop) + parity with Python

**Files:** Create `menubar/activity/redact.js`; Test `menubar/activity/__tests__/redact.test.js` (loads the shared fixtures).

**Interfaces:** `Redactor(configuredSecrets).scrub(text)` — same credential forms + configured secrets as `redact.py`, proven by loading `../../repo_radar/tests/data/redaction_fixtures.json`. This is the read/export boundary (spec §4); it supersedes reliance on `runtime/hashing.js:redact` for Activity content.

- [ ] **Step 1: Write the failing parity test**

```js
const test = require('node:test'); const assert = require('node:assert');
const fs = require('node:fs'); const path = require('node:path');
const { Redactor } = require('../redact');
const fixtures = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'repo_radar', 'tests', 'data', 'redaction_fixtures.json')));

test('node read-time redactor masks every shared fixture identically to Python', () => {
  for (const c of fixtures) {                       // object form incl. configured-secret cases
    const r = new Redactor(c.secrets);
    assert.strictEqual(r.scrub(c.raw), c.expected, c.raw);
  }
});
```

- [ ] **Step 2-4:** Run → FAIL; implement `redact.js` mirroring `redact.py` (same ordered forms, configured-secrets longest-first). Run → PASS. (The Python side already asserts the same fixtures in Task 1.4 — parity is now two-sided.)

- [ ] **Step 5: Commit** `feat(activity): read-time redaction backstop with cross-language parity`.

### Task 3.5: Reader-side retention — age/newest-50 policy atop the Phase-1 base pruner

**Files:** Add `retain(home)` to `menubar/activity/quota.js` (the ceiling-override base `prune` already exists from Phase-1 Task 1.6 — this **layers** age/newest-50 on top, it does not replace a no-op); Test `menubar/activity/__tests__/retention.test.js`.

**Interfaces:** `retain(home) -> { pruned: [ids] }` — the **complete §7 matrix (finding 9)**, all asserted:
  - **Routine** terminal prunable only if **older than 14 days AND outside the newest 50**.
  - **Problem** item prunable only if **older than 90 days AND outside the newest 50**.
  - **Never** prune `running`/unreconciled items (no durable terminal), regardless of age/count.
  - The **64 MiB ceiling overrides** the 14/90-day + newest-50 preferences (prune younger settled terminals if required), **except** never `running` and **always preserve the newest problem**.
  - **Settled-only deletion** (an activity with a live ledger entry is never pruned), segment files deleted **first** (scan reflects the reduction), **prune order** oldest-routine → other non-failures → oldest-problems, and **symlinked entries refused** (via `secure_scan`/`secure_iterdirs`).
  - `retain` reuses the Phase-1 `prune(home, need_bytes)` for the ceiling-override slice and adds the age/newest-50 selection for the periodic slice.

- [ ] **Step 1: Write the failing tests** — one per matrix row, e.g.:

```js
const test = require('node:test'); const assert = require('node:assert');
// (helpers seed activities with controllable mtime + outcome + settled/running state)
test('routine older than 14d AND outside newest 50 is pruned; a 13d one is kept', () => { /* ... */ });
test('problem younger than 90d is kept even if outside newest 50', () => { /* ... */ });
test('running/unreconciled is never pruned regardless of age', () => { /* ... */ });
test('ceiling override prunes younger routine but preserves the newest problem + running', () => { /* ... */ });
test('a settled item with a live ledger entry is never pruned', () => { /* ... */ });
test('symlinked activity dir/segment is refused by the scan', () => { /* ... */ });
```

- [ ] **Step 2-5:** implement `retain` (deletion order, mtime/age, newest-50, ceiling override via `prune`); run → PASS; commit `feat(activity): outcome-aware retention matrix (age + newest-50 + ceiling override)`.

### Task 3.6: `read.js` — enumerate → DTO assembly + export

**Files:** Create `menubar/activity/read.js`; Modify `menubar/activity/index.js` (export the reader façade); Test `menubar/activity/__tests__/read.test.js`.

**Interfaces:** `listActivities(home, filter) -> { items: DTO[], truncated, available, incomplete }` and `buildExport(home, filter) -> string`. **`available:false`** when the store is missing/unreadable and **`incomplete:true`** when some segments couldn't be parsed or a reconcile was `UNCERTAIN` — an **explicit** result the UI's "History unavailable/incomplete" state (Task 4.5) tests against (finding 8), never an ambiguous empty list. Each DTO is bounded + already redacted, newest-first, with derived `outcome` (via reconcile), duration, channel/trigger, error/warn counts, and the two lenses (Events, Problems). `buildExport` produces the redacted text in-process (never from renderer input). **Concrete bounds enforced (finding 9), defined as `menubar/activity/limits.js` constants:** list returns **≤ 200** item summaries per call (`truncated:true` past that); a single item's detail DTO carries **≤ 2000 event rows** and **≤ 2 MiB** total (further rows summarized); each rendered field/`detail` string **≤ 8 KiB**; the `filter` is validated — `level ∈ {info,warn,error}`, free-text `search ≤ 256` chars (literal match, not regex), `limit ≤ 200`, `offset ≥ 0`; **export ≤ 16 MiB** (truncated with a visible marker past that). Any filter violating these is rejected by the handler (Task 4.1), not clamped silently.

- [ ] **Step 1: Write the failing test** (end-to-end read over a seeded store, incl. a `running` item that reconciles to `interrupted`, a redaction check on a DTO, and the `truncated` flag when over the DTO budget).

- [ ] **Step 2-5:** implement; run → PASS; commit `feat(activity): reader DTO assembly + redacted export`.

**Phase 3 gate:** `cd menubar && node --test` green; the reader turns a crashed `running` attempt into a visible `interrupted` item. Request an `implementation-review` over the Phase-3 range.

---

## Phase 4 — Activity window UI + IPC (the feature earns its keep)

**Deliverable:** a dedicated, context-isolated Activity window backed by the Phase-3 reader; a tray entry available any time; the two lenses; the System section; and the "Sync Errors" affordance subsumed so it never opens empty. **This is the first releasable state** — Phases 1–3 were checkpoints.

### Task 4.1: Narrow, context-isolated IPC surface + dedicated preload

**Files:** Create `menubar/activity/ipc.js` (main-side handlers), **`menubar/renderer/activity-preload.js`** (a **dedicated** preload — NOT the existing `preload.js`, finding 9); Modify `menubar/main.js` (register handlers); Test `menubar/activity/__tests__/ipc.test.js` (handler functions, Electron-free) + `menubar/activity/__tests__/preload-allowlist.test.js`.

**Interfaces:** channels `activity:list` (filter → `{items, truncated}`), `activity:get` (id → item + lenses), `activity:export` (filter → path; export built in main via `read.buildExport`), `activity:reveal` (id → `shell.showItemInFinder`). Handlers **validate the filter against `limits.js`** and reject (not clamp) violations; they **only ever return bounded, already-redacted DTOs**; the renderer sends filter parameters, never text to be echoed. The dedicated preload exposes exactly `contextBridge.exposeInMainWorld('activityApi', { list, get, export, reveal })` — an **allowlist of exactly those four `invoke` channels**, nothing else.

- [ ] TDD:
  - Handler tests: a seeded store returns bounded/redacted DTOs; an over-broad or malformed filter (bad `level`, `limit>200`, `search>256`, regex metachars) is **rejected**.
  - Preload allowlist test: the preload's exposed API surface is exactly `{list,get,export,reveal}` and each maps to its single `activity:*` channel — assert no `ipcRenderer` object, no `require`, no wildcard is leaked to the window.
  - implement; commit `feat(activity): context-isolated IPC + dedicated Activity preload (allowlisted)`.

### Task 4.2: Activity `BrowserWindow` + renderer (list + Events/Problems lenses)

**Files:** Modify `menubar/main.js` (`showActivityWindow()` — a NEW window distinct from `showLogWindow`, `webPreferences: { contextIsolation:true, nodeIntegration:false, sandbox:true, preload: activity-preload.js }`); Create `menubar/renderer/activity.html`, `menubar/renderer/activity.js`; Test `menubar/__tests__/activity-renderer-dom.test.js` + `menubar/__tests__/activity-window-security.test.js`.

**Interfaces:** `showActivityWindow(focusId?)` opens/reuses the window, loads `renderer/activity.html`. The renderer: a newest-first list of chips (time · channel/trigger · duration · outcome dot · error/warn counts); clicking opens the two lenses — **Events** (rows filterable by level + free-text, expandable `detail`) and **Problems** (warn/error + failure diagnostics, exact-dup terminals grouped w/ count, integrity Problems). **All content inserted via `textContent`, never `innerHTML`** (finding 9); ANSI/control chars stripped via a shared `sanitizeText()`. `renderer/activity.js` factors its DTO→DOM mapping into pure functions so they are unit-testable through a lightweight DOM adapter.

- [ ] TDD:
  - **DOM adapter test:** feed `renderChip(dto)` / `renderEventRow(rec)` a DTO carrying `<script>alert(1)</script>` + ANSI escapes; assert the produced node's `textContent` holds the literal characters and the node has **no child elements** (inert — proves `textContent`, not markup).
  - **Source-prohibition test:** assert `renderer/activity.js` contains **no `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write`** (regex over the file source) — a hard guard finding 9 asks for.
  - **Window-security test:** assert `showActivityWindow`'s `webPreferences` are exactly `{contextIsolation:true, nodeIntegration:false, sandbox:true}` with the dedicated preload (extract the options into a testable constant).
  - implement window + renderer; commit `feat(activity): context-isolated Activity window, textContent-only, Events/Problems lenses`.

### Task 4.3: System section

**Files:** Modify `menubar/activity/read.js` (add `systemDiagnostics(home)`), `menubar/renderer/activity.js` (render the section); Test `menubar/activity/__tests__/system-section.test.js`.

**Interfaces:** `systemDiagnostics(home) -> { streams: [{name, redactedTail}], statusDiagnostics }` — bounded, redacted, explicitly **uncorrelated** tails of at minimum `sync.error.log` and `menubar.log`; `sync.log` and `renderer.log` available-on-demand; **plus the legacy `status.json` `errorLog` (string) + `errorList` (array), bounded + redacted (finding 9)** — the pre-contract diagnostic surface that must stay visible. All marked uncorrelated: never Activity items, never time-correlated. **Concrete limits (finding 8):** each stream `redactedTail` = the last **64 KiB** (UTF-8, truncation-marked); `status.json` `errorList` ≤ the **50** newest entries; `errorLog` ≤ **64 KiB**. This is also where the viewer's **own** observability-write failure surfaces (the last-resort sh line from Task 2.4 lands in `sync.error.log`).

- [ ] TDD: seeded log files + a seeded `status.json` with `errorLog`/`errorList` → bounded redacted diagnostics including the `status.json` surface; implement; commit `feat(activity): System section (shared streams + legacy status.json diagnostics)`.

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

- [ ] TDD:
  - a seeded `sync-*.log` yields one opaque legacy DTO with a reconstructed timestamp;
  - a `status.json` **never** becomes a standalone Activity item;
  - **but its `errorLog`/`errorList` DO appear in the System section** (positive assertion — finding 9: the legacy diagnostic surface must be present, not merely absent from the item list);
  - implement; commit `feat(activity): opaque legacy sync-log adapter + legacy diagnostics in System`.

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


