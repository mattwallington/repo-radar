# Activity History — concrete spec

**Status:** Spec — decision review (paired, rev 3). Scope **B**, full vertical MVP through the Activity window.
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
- **Lease before `start` (race-free):** on every path the first producer **acquires the activity lease (§5) before making `start` visible**, then writes `start` under the held lock. A visible `start` therefore always corresponds to a **held** lock (alive) or a **released** lock (finished or dead) — never a "start with no lock yet" window that reconciliation could misread as abandoned.
  - **Electron manual/catch-up:** mints the id, **acquires the lock**, writes `start`, and runs the dev/runtime guards synchronously **while holding it** (`menubar/main.js:1080-1106`). A guard block → Electron writes the `blocked` terminal and releases. A sync already running → `skipped`. Otherwise Electron passes the **locked descriptor** to the spawned dispatcher (fd inheritance) and closes its own copy after handoff.
  - **Scheduled (LaunchAgent):** the dispatcher mints the id, **acquires the lock**, then writes `start`, before its root lock (`menubar/runtime/dispatchers.js:85-87`).
  - **Direct CLI:** Python mints the id, **acquires the lock**, then writes `start`, in `repo_radar/cli.py` **before dependency checking** (`cli.py:37-41` can exit first).
- **Adopt vs mint:** a producer that receives a valid inherited id + inherited lock **adopts** them, does **not** write a second `start`, and writes an `ownership` record. The dispatcher launched by Electron adopts Electron's id + locked descriptor (carried by `exec`, §5); the dispatcher launched by the LaunchAgent mints and acquires.
- **Kind:** `sync` (an attempt) or `system` (a failure with no sensible attempt).

## 2. Storage layout, record contract, schema versioning

- **Directory:** `~/Library/Logs/repo-radar/activity/<activity-id>/` created `0700` securely (no briefly-permissive window); reject if it exists as a non-directory or symlink.
- **Segments:** one append-only JSONL file **per writer instance** — `<producer>-<writer-id>.jsonl`, `producer` ∈ {`electron`,`dispatcher`,`python`}, `writer-id` an 8-hex-char random token validated `^[0-9a-f]{8}$`. A role can recur without contention. Files `0600`.
- **Lease file:** `activity/<activity-id>/owner.lock` — see §5.
- **Record types:** one JSON object/line, common fields `schema_version` (int; this spec is **1**), `activity_id`, `type`, `seq` (monotonic per segment from 0), `ts` (ISO-8601 with offset):
  - `start` — `kind`, `channel`, `trigger`, `parent_id?`, `created_by` (producer).
  - `ownership` — written when a process **acquires** the execution lease: `owner_token` (an 8-hex token identifying the lease holder), `producer`, and corroborating fingerprint `pid`, `boot_id`, `proc_birth`. Evidence only; the held lock (§5), not this record, proves liveness.
  - `event` — `level` (`info`|`warn`|`error`), `event` (name), `fields` (flat map), `detail?` (string).
  - `control` — a machine-exact control signal: `name` (e.g. `cancel_requested`) + optional bounded `fields`. **Reserve-eligible** (§7): writable even when ordinary capacity is exhausted, so cancellation is never lost precisely when it decides `cancelled` vs `interrupted`.
  - `terminal` — `outcome` (§3), `summary` (repos changed, error/warn counts), `by` (`owner_token` or `reconciler`).
  - `integrity` — a machine-detected inconsistency surfaced as a Problem (conflicting terminals, interior corruption, unsupported schema, dropped-events truncation).
- **Ordering:** each segment's `seq` is validated strictly increasing and its records are kept **in that append order**; the reader does a deterministic **k-way merge of segment heads by `(ts, writer_id)`**. Cross-writer order is wall-clock-based, but append order **within** a writer can never reverse — even if the wall clock steps backward (which a global `(ts, writer_id, seq)` sort would allow).
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

The lease is a **held advisory lock** acquired **before `start` is visible** (§1), so "start exists" always implies a live-or-released lock — never a not-yet-locked window. Liveness is proven by probing the lock, not by PID.

- **Lock family — pinned to BSD `flock` semantics on macOS:** an exclusive advisory lock on `activity/<activity-id>/owner.lock`.
  - **Python:** `fcntl.flock(fd, LOCK_EX|LOCK_NB)`, the fd held for the process lifetime.
  - **Shell/Node:** `/usr/bin/lockf` in descriptor mode. Node opens the descriptor and runs `/usr/bin/lockf -t 0 <fd>`, then **retains the lock by keeping that descriptor open** until it deliberately closes it (verified: an external probe returns exit 75 until the descriptor is closed).
- **Acquire → hold → hand off → release** — exactly one lease-holding process at a time:
  - **Electron** acquires the lock, writes `start`, holds it across the synchronous guards, then either finalizes+releases (guard block/contention) or **passes the locked descriptor to the spawned dispatcher via fd inheritance** — writing the fd number in the child env and closing its own copy **after** the dispatcher confirms hold (the lock persists while any inheriting fd is open).
  - **The dispatcher** inherits that descriptor (or, when scheduled, acquires its own), writes an `ownership` record, and `exec`s Python (`dispatchers.js:109`); the descriptor survives `exec`, so the same held lock passes into Python — no dispatcher→Python re-acquire.
  - **Python** (executing owner) holds the inherited lock (or acquires its own on direct CLI) and **releases it only after its `terminal` is durably appended**.
- **Reconciliation** (reader at open + opportunistically at sync start), for an attempt in `running` with no `terminal`: **acquire the lock non-blocking.**
  - Cannot acquire → owner alive → leave `running`.
  - Acquired (or `owner.lock` was never created) → owner provably gone → the `reconciler` **retains the lock**, synthesizes a `terminal` — `cancelled` if a `control{cancel_requested}` record exists for the attempt, else `interrupted` — and releases the lock **only after that terminal is durably appended**, so two concurrent readers cannot double-reconcile.
  - Probe error / genuinely uncertain → leave `running` + a System integrity warning; never guess a dead owner. `pid`/`boot_id`/`proc_birth` are corroborating only.
- **Cancellation ordering fix:** Electron MUST append the `control{cancel_requested}` record **before** sending SIGTERM (currently racy: signals `main.js:2135-2138`, records cancellation `:2178-2184`).

## 6. Finalization authority + integrity

- Only the **current lease holder** may ordinarily write a `terminal` (Electron for its pre-spawn blocks; the executing owner otherwise). The `reconciler` may synthesize a `terminal` **only** after the lock probe proves the owner gone (§5).
- **Duplicate** = a repeated `terminal` with the **same `outcome`** (metadata may differ) → grouped with a count, not an error.
- **Conflict** = `terminal` records with **different outcomes** → the reader records an `integrity` Problem and reports the attempt as **`interrupted`** (deterministic default; no severity ordering to argue about) with the conflict shown in Problems.
- **Corruption:** a truncated **trailing** JSONL line is ignored silently; **interior** corruption yields a System integrity Problem and must NOT hide later valid records in the same segment.

## 7. Retention + at-rest bounds

- **Age policy:** a routine (non-problem) terminal item is prunable only when older than **14 days AND** outside the newest **50**; a problem-bearing item only when older than **90 days AND** outside the newest **50**. Never prune `running` or unreconciled items.
- **Global ceiling 64 MiB** over `activity/`, with a **128 KiB global reserve**: *ordinary* writes (a new `start` or `event`) stop at **64 MiB − 128 KiB**, but bounded **`control` / `terminal` / `integrity`** writes from an active attempt are **always permitted** into the reserve, so finalization can never deadlock. Under pressure prune in order: oldest routine terminal → other terminal non-failures → old failures; always preserve the newest problem item. **The hard ceiling OVERRIDES the 14/90-day and newest-50 preferences when necessary** (pruning younger terminal items if required) — **except** that `running`/unreconciled items are never pruned and the newest problem is preserved. If nothing is prunable, refuse only new ordinary starts/events (single non-recursive warning); the active attempt still finalizes via the reserve. The global reserve absorbs concurrent-writer terminals/controls, so there is **no unbounded overshoot**.
- **Per-record bounds:** flat primitive `fields` only, ≤32 keys; key ≤64 B; each value ≤1 KiB; aggregate `fields` ≤8 KiB; `detail` ≤8 KiB; encoded record ≤20 KiB.
- **Per-activity cap 4 MiB with a reserved 60 KiB headroom** (≥ three 20 KiB records: one `control{cancel_requested}`, one dropped-events `integrity`, one `terminal`). Once *ordinary* capacity (4 MiB − 60 KiB) is reached, producers **stop writing `event` records** but MUST still write `control`, the authoritative `terminal`, and `integrity` into the reserve (a dropped-events integrity note marks the truncation).
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
- Reserve/cap: at ordinary-capacity exhaustion a `control{cancel_requested}` and the authoritative `terminal` still write into the 60 KiB reserve (cancellation is not lost); the k-way merge preserves per-writer append order under a backwards wall-clock step.
- Cross-process integration (macOS): a real attempt (Electron acquires the lock → **passes the locked fd to the spawned dispatcher (fd inheritance) → `exec` Python holds it** → clean terminal → lock released) and a simulated crash (lock acquired, `start`+`ownership` written, process killed before terminal → reader acquires the freed lock → `interrupted`; a `control{cancel_requested}` before kill → `cancelled`). **This proves the advisory lease survives spawn-inheritance and `exec`, and reconciliation is deterministic.**
- Redaction parity: the shared fixtures assert Python and Node mask identically.

## Non-goals

Live tail; Raw stderr lens; clear-logs; analytics; merged cross-run timeline; exhaustive instrumentation of every internal producer (future producers join the same versioned contract additively); any second transitional canonical format.
