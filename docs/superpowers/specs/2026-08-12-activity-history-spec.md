# Activity History — concrete spec

**Status:** Spec — decision review (paired, rev 2). Scope **B**, full vertical MVP through the Activity window.
**Date:** 2026-08-12
**Builds on (approved):** `2026-08-12-log-viewer-shape.md` @ `4972b4e`. Resolves the deferred decisions per paired Rounds 3–5.

## Goal

Every sync attempt and every pre-attempt system incident becomes a durable, inspectable record with an authoritative outcome — so a blocked/failed/crashed run is always visible in the app, not buried in a terminal.

## Architecture

Producers (Electron main, the shell dispatcher, Python) append structured records under a shared **activity identity** into per-writer-instance segment files, and the executing owner holds a real **advisory-lock lease** so liveness is provable, not guessed. A pure Node **reader/redactor** merges + normalizes + reconciles + redacts them into bounded DTOs for a context-isolated **Activity** window. Lifecycle authority and abnormal-termination reconciliation are foundation concerns.

## Global Constraints

- **Observability is best-effort and never changes sync semantics.** A failed history write emits ONE non-recursive warning to the producer's existing stderr/log and continues. Never route an Activity-write failure through the failing Activity writer.
- **Redaction is defense-in-depth.** Redact known secrets at WRITE time (where the producer knows them) AND again in Node before IPC/export. Shell producers emit fixed reason codes + bounded messages, never environment dumps. A shared Python/Node redaction fixture set proves they mask identically.
- **No new runtime dependency** (Node + Python stdlib for the record layer; existing Electron stack for UI).
- **Legacy is read-only, uncorrelated.** Old `sync-*.log` are opaque legacy Activity items; identity-less `status.json` and shared streams are **System-only** "latest diagnostics", never standalone Activity items, never time-correlated to an attempt.
- **All size limits count UTF-8 bytes and mark truncation explicitly.**

---

## 1. Activity identity + propagation

- **Transport:** env var `REPO_RADAR_ACTIVITY_ID` = a fresh UUIDv4 **per invocation**, never persisted in the LaunchAgent plist environment.
- **Validation:** before any producer uses an id in a filesystem path it MUST match the UUIDv4 regex `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`. Invalid/absent → the producer **mints** a fresh one (never trusts arbitrary text in a path).
- **Exactly one `start` per attempt,** written by the **first** producer on the path:
  - **Electron manual/catch-up:** mints the id + writes `start` **before** `currentSyncProcess` spawn and the dev/runtime guard (`menubar/main.js:1080-1106`); sets it in the child env. A guard block → Electron finalizes `blocked` directly (it is synchronously alive, no lease exists yet). A sync already running → `skipped`.
  - **Scheduled (LaunchAgent):** the dispatcher mints the id + writes `start` **before** its root lock (`menubar/runtime/dispatchers.js:85-87`).
  - **Direct CLI:** Python mints + writes `start` in `repo_radar/cli.py` **before dependency checking** (`cli.py:37-41` can exit first).
- **Adopt vs mint:** a producer that receives a valid inherited id **adopts** it and does **not** write a second `start`; it may write an `ownership` record (below). The dispatcher launched by Electron adopts Electron's id; the dispatcher launched by the LaunchAgent mints.
- **Kind:** `sync` (an attempt) or `system` (a failure with no sensible attempt).

## 2. Storage layout, record contract, schema versioning

- **Directory:** `~/Library/Logs/repo-radar/activity/<activity-id>/` created `0700` securely (no briefly-permissive window); reject if it exists as a non-directory or symlink.
- **Segments:** one append-only JSONL file **per writer instance** — `<producer>-<writer-id>.jsonl`, `producer` ∈ {`electron`,`dispatcher`,`python`}, `writer-id` an 8-hex-char random token validated `^[0-9a-f]{8}$`. A role can recur without contention. Files `0600`.
- **Lease file:** `activity/<activity-id>/owner.lock` — see §5.
- **Record types:** one JSON object/line, common fields `schema_version` (int; this spec is **1**), `activity_id`, `type`, `seq` (monotonic per segment from 0), `ts` (ISO-8601 with offset):
  - `start` — `kind`, `channel`, `trigger`, `parent_id?`, `created_by` (producer).
  - `ownership` — written when a process **acquires** the execution lease: `owner_token` (an 8-hex token identifying the lease holder), `producer`, and corroborating fingerprint `pid`, `boot_id`, `proc_birth`. Evidence only; the held lock (§5), not this record, proves liveness.
  - `event` — `level` (`info`|`warn`|`error`), `event` (name), `fields` (flat map), `detail?` (string).
  - `terminal` — `outcome` (§3), `summary` (repos changed, error/warn counts), `by` (`owner_token` or `reconciler`).
  - `integrity` — a machine-detected inconsistency surfaced as a Problem (conflicting terminals, interior corruption, unsupported schema).
- **Ordering:** merge all segments for an id by `(ts, writer_id, seq)` — timestamps alone cannot order across processes.
- **Schema versioning:** a v1 reader accepts v1 records and ignores unknown **additive** fields. A record whose `schema_version` is **unsupported** is **never** interpreted as v1 — it yields a bounded System `unsupported-schema` integrity Problem, while all other readable records in the activity remain available.

## 3. Severity + outcome

- **`running` is a derived, non-terminal state** (an attempt with a `start` and no `terminal`), not an outcome value.
- **Terminal outcomes (exactly these seven):** `succeeded`, `succeeded-with-warnings`, `blocked`, `failed`, `cancelled`, `skipped`, `interrupted`.
- **Finalizer mapping (minimum, deterministic):** pre-worker guard/verification block → `blocked`; contention / no-work → `skipped`; clean completion → `succeeded`; defined adverse completion (degraded output or a repo skipped) → `succeeded-with-warnings`; worker failure → `failed`; persisted `cancel_requested` + dead owner → `cancelled`; provably abandoned without cancellation → `interrupted`.
- **Severity by rule (source-owned):** ordinary retry/wait/recovery (incl. transient rate-limit + network waiting) = `info`; degraded-but-completed = `warn`; exhausted retry / timeout / abort = `error`. Severity never decides outcome.

## 4. Redaction (defense-in-depth)

- **Write time:** where a producer knows secrets (Python/Electron config), redact configured/effective secret values + high-confidence credential forms (`sk-…`, `ghp_…`/`github_pat_…`, `AIza…`, `Bearer …`, `//user:pass@`) from `detail`/`fields` before writing. Shell producers emit only fixed reason codes + bounded messages, never env dumps.
- **Read time (backstop):** the Node reader redacts again — the same credential forms + the app's currently-configured secrets — before any IPC or export (a rotated key gone from `config.json`, or CLI secrets from a different env, are still caught by the credential forms).
- **Shared fixtures:** one fixture set of (secret, expected-mask) pairs exercised by BOTH redactors so they cannot drift. Mirrors `repo_radar/metadata.py:178-232`.

## 5. Lifecycle ownership + lease (crash correctness — foundation)

The lease is a **held advisory lock**, not a record. Liveness is proven by probing it.

- **Mechanism:** `flock`/`lockf` on `activity/<activity-id>/owner.lock`. The owning process holds it; because `exec` preserves open file descriptors, the lock **survives** the dispatcher→Python `exec` (`dispatchers.js:109`) — the same process keeps holding it. Released explicitly on clean finish, and by the OS on process death.
- **Who holds it:** the process that **executes the sync** — the dispatcher (which `exec`s Python, so dispatcher-then-Python is one process holding one lock), or Python directly (direct CLI). **Electron never holds the execution lease**: it owns only the synchronous pre-spawn window and finalizes guard blocks (`blocked`/`skipped`) itself. On acquiring the lock, the holder writes an `ownership` record (owner_token + fingerprint).
- **Handoff:** the only handoff is Electron (pre-spawn, no lock) → the spawned dispatcher acquiring the lock. There is exactly one lease-holding process per executed attempt; no dispatcher→Python re-transfer (same process via `exec`).
- **Reconciliation** (reader at open + opportunistically at sync start), for an attempt in `running` with no `terminal`:
  - **Probe the lock non-blocking.** If it **cannot** be acquired → owner alive → leave `running`.
  - If it **can** be acquired (or `owner.lock` was never created) → owner is provably gone → synthesize a `terminal` by the `reconciler`: `cancelled` if a `cancel_requested` marker was persisted for this attempt, else `interrupted`.
  - If liveness is genuinely **uncertain** (probe error), leave `running` and raise a System integrity warning — never guess a dead owner.
  - `pid`/`boot_id`/`proc_birth` are corroborating diagnostics only.
- **Cancellation ordering fix:** Electron MUST persist `cancel_requested` for the attempt **before** sending SIGTERM. Current order is racy (signals at `main.js:2135-2138`, records cancellation at `:2178-2184`). After the fix the reconciler maps dead-owner + `cancel_requested` → `cancelled`.

## 6. Finalization authority + integrity

- Only the **current lease holder** may ordinarily write a `terminal` (Electron for its pre-spawn blocks; the executing owner otherwise). The `reconciler` may synthesize a `terminal` **only** after the lock probe proves the owner gone (§5).
- **Duplicate** = a repeated `terminal` with the **same `outcome`** (metadata may differ) → grouped with a count, not an error.
- **Conflict** = `terminal` records with **different outcomes** → the reader records an `integrity` Problem and reports the attempt as **`interrupted`** (deterministic default; no severity ordering to argue about) with the conflict shown in Problems.
- **Corruption:** a truncated **trailing** JSONL line is ignored silently; **interior** corruption yields a System integrity Problem and must NOT hide later valid records in the same segment.

## 7. Retention + at-rest bounds

- **Age policy:** a routine (non-problem) terminal item is prunable only when older than **14 days AND** outside the newest **50**; a problem-bearing item only when older than **90 days AND** outside the newest **50**. Never prune `running` or unreconciled items.
- **Global ceiling 64 MiB** over `activity/`. Under pressure prune: oldest routine terminal → other terminal non-failures → old failures; always preserve the newest problem item. **If every candidate is `running`/unreconciled** (nothing prunable), do NOT violate no-prune-live: **refuse further best-effort Activity writes** with the single non-recursive warning until reconciliation frees space. Small concurrent-writer overshoot is permitted but bounded and corrected at the next prune.
- **Per-record bounds:** flat primitive `fields` only, ≤32 keys; key ≤64 B; each value ≤1 KiB; aggregate `fields` ≤8 KiB; `detail` ≤8 KiB; encoded record ≤20 KiB.
- **Per-activity cap 4 MiB, with a reserved terminal headroom of 40 KiB** (≥ two 20 KiB records). Once *ordinary* capacity (4 MiB − 40 KiB) is reached, producers **stop writing `event` records** but MUST still be able to write the authoritative `terminal` and any `integrity` record into the reserved headroom (a dropped-events integrity note records the truncation).
- **Legacy `_rotate_sync_logs` (10 files) stays independent** of Activity retention.
- Validate activity/writer ids; reject unsafe file types/symlinks; create permissions securely.

## 8. Reader / Node module (pure, testable)

`menubar/activity/` — dependency-free: enumerate, id/path-validate, JSONL parse + truncation tolerance, cross-segment merge + ordering, **lock-probe reconciliation**, redaction, retention, schema-version handling, and building **bounded redacted DTOs** for a validated filter/export request. `main` calls it; the renderer only ever receives bounded, already-redacted DTOs over a narrow, context-isolated IPC surface. Export is produced in main from a validated filter request, never from renderer text.

## 9. UI (Activity window — MVP)

- **Dedicated, context-isolated `BrowserWindow`** (`contextIsolation:true`, `nodeIntegration:false`, narrow preload) — not the current `showLogWindow` settings (`main.js:1519-1529`). Bounded payload/file sizes; ANSI/control-char handling; renderer inserts text (never HTML).
- **Tray:** "Activity" available any time, alongside the sync-only "View Progress".
- **List:** items newest-first, each a chip — time · channel/trigger · duration · **outcome dot** · error/warn counts. Grouped by item.
- **Two lenses:** **Events** (structured rows; filter by level + search; expandable `detail`) and **Problems** (warn/error + failure diagnostics, provenance retained; exact-dup terminals grouped w/ count; integrity Problems shown). **Raw** lens deferred.
- **System section:** bounded, redacted, explicitly **uncorrelated** "latest diagnostics" — at minimum `sync.error.log` and `menubar.log`; `sync.log` (LaunchAgent stdout) and `renderer.log` are listed as available shared streams but shown only on demand. These are never Activity items and never time-correlated. This is what lets the viewer surface its **own** observability-write failure (which falls back to these streams).
- **Subsume "Sync Errors":** its "View Errors" affordance appears **only when a problem-bearing item exists** and deep-links to the newest item carrying Problems or a failure-like outcome (incl. a System incident) — never an empty view.
- Actions: Refresh · Export (redacted) · Reveal-in-Finder. Clear-logs deferred. **History unavailable/incomplete** is a first-class UI state.

## 10. Phasing (crash correctness in the foundation)

1. **Foundation:** record contract + storage layout + identity/validation + schema versioning + **advisory-lock lease + finalization state machine + lock-probe reconciliation** + at-rest bounds + best-effort write behavior (Python + a minimal writer). Unit-tested + a CLI-driven attempt.
2. **Producers + propagation:** identity through Electron guards (incl. cancel-ordering fix), the dispatcher (adopt/mint + lock acquire + `ownership`), CLI; `SyncLogger` severity + structured writes; System incidents for pre-attempt failures.
3. **Reader/redactor Node module** (parse/merge/reconcile/redact/retention/schema) + shared redaction fixtures.
4. **Activity window UI + IPC** + System section + subsume "Sync Errors".
5. **Legacy adapter** (opaque `sync-*.log` items; System-only `status.json`/shared streams) + retention wiring.

Phases 1–3 are green review checkpoints but **not releasable** — the feature's job is unmet until Phase 4.

## Testing strategy

- Python: identity adopt/mint + validation; record writing + bounds/truncation + reserved-headroom terminal; severity rule; write-time redaction (shared fixtures); best-effort failure.
- Node: parse/truncation; merge ordering; **reconciliation — held-lock⇒running, released-lock⇒interrupted, released-lock+cancel_requested⇒cancelled, conflicting terminals⇒integrity+interrupted**; read-time redaction (shared fixtures); retention (age + 64 MiB ceiling + prune order + all-live refusal); schema-version handling; DTO bounds.
- Cross-process integration (macOS): a real attempt (env id → dispatcher lock → `exec` Python holds it → clean terminal → lock released) and a simulated crash (start + `ownership`, killed before terminal → reader acquires the freed lock → `interrupted`). **This proves the advisory lease survives `exec` and reconciliation is deterministic.**
- Redaction parity: the shared fixtures assert Python and Node mask identically.

## Non-goals

Live tail; Raw stderr lens; clear-logs; analytics; merged cross-run timeline; exhaustive instrumentation of every internal producer (future producers join the same versioned contract additively); any second transitional canonical format.
