# Activity History — concrete spec

**Status:** Spec — decision review (paired, rev 6). Scope **B**, full vertical MVP through the Activity window.
**Date:** 2026-08-12
**Builds on (approved):** `2026-08-12-log-viewer-shape.md` @ `4972b4e`. Resolves the deferred decisions per paired Rounds 3–9.

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
  - **Electron manual/catch-up:** mints the id, **acquires the lock**, writes `start`, and runs the dev/runtime guards synchronously **while holding it** (`menubar/main.js:1080-1106`). A guard block → Electron writes the `blocked` terminal and releases. A sync already running → `skipped`. Otherwise Electron passes the **locked descriptor + `owner_token`** to the spawned dispatcher (fd inheritance + env) and closes its own copy **only after** the dispatcher validates the descriptor and writes its handoff `ownership` (§5); a failed handoff leaves Electron authoritative to finalize `failed`.
  - **Scheduled (LaunchAgent):** the dispatcher mints the id, **acquires the lock**, then writes `start`, before its root lock (`menubar/runtime/dispatchers.js:85-87`).
  - **Direct CLI:** Python mints the id, **acquires the lock**, then writes `start`, in `repo_radar/cli.py` **before dependency checking** (`cli.py:37-41` can exit first).
- **Adopt vs mint:** a producer that receives a valid inherited id + inherited lock **first validates the descriptor** (§5) — that it refers to *this* activity's `owner.lock` and the lock is held — then **adopts** them, does **not** write a second `start`, and writes a **handoff `ownership`** carrying the **inherited `owner_token`** (never a fresh one). An arbitrary/invalid inherited fd is not trusted as the lease. The dispatcher launched by Electron adopts Electron's id + locked descriptor + `owner_token` (carried by `exec`, §5); the dispatcher launched by the LaunchAgent mints and acquires (minting a new `owner_token`).
- **Kind:** `sync` (an attempt) or `system` (a failure with no sensible attempt).

## 2. Storage layout, record contract, schema versioning

- **Directory:** `~/Library/Logs/repo-radar/activity/<activity-id>/` created `0700` securely (no briefly-permissive window); reject if it exists as a non-directory or symlink.
- **Segments:** one append-only JSONL file **per writer instance** — `<producer>-<writer-id>.jsonl`, `producer` ∈ {`electron`,`dispatcher`,`python`}, `writer-id` an 8-hex-char random token validated `^[0-9a-f]{8}$`. A role can recur without contention. Files `0600`.
- **Lease file:** `activity/<activity-id>/owner.lock` — see §5.
- **Record types:** one JSON object/line, common fields `schema_version` (int; this spec is **1**), `activity_id`, `type`, `seq` (monotonic per segment from 0), `ts` (ISO-8601 with offset):
  - `start` — `kind`, `channel`, `trigger`, `parent_id?`, `created_by` (producer).
  - `ownership` — records who holds the **single logical lease**. `owner_token` (an 8-hex token) is minted **once**, when the lease descriptor is first locked (§5), and carried **unchanged** through every handoff. A `role` ∈ {`initial`,`handoff`} distinguishes the first locker's record from one written by a process that **inherited** the descriptor; **both share the same `owner_token`**, each with its own corroborating `producer`, `pid`, `boot_id`, `proc_birth`. Evidence only; the held lock (§5), not this record, proves liveness.
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
- **One logical lease — exactly one *open-file description* at a time.** Its fd may be **transiently duplicated** across the parent/child boundary during a handoff; that is still one lease, not two. `owner_token` is minted when the descriptor is first locked and names that one lease for the `terminal`'s `by`.
  - **Electron** acquires the lock (minting `owner_token`), writes `start` + the **initial `ownership`**, holds it across the synchronous guards, then either finalizes+releases (guard block/contention) or **passes the locked descriptor + `owner_token` to the spawned dispatcher** (fd number + token in the child env). It closes its own copy **only after** the dispatcher passes **inherited-descriptor validation** (below) and writes its **handoff `ownership`** (same `owner_token`). **Failed validation/handoff** leaves **Electron authoritative** to finalize `failed` and release; the child does not proceed as owner.
  - **The dispatcher** inherits + validates that descriptor (below) (or, when scheduled, acquires its own + mints its own token), writes the handoff `ownership`, and `exec`s Python (`dispatchers.js:109`); the descriptor + token survive `exec`, so the same held lease passes into Python — no dispatcher→Python re-acquire.
  - **Python** (executing owner) holds the inherited lease (or acquires its own + mints on direct CLI) and **releases it only after its `terminal` (stamped `by=<owner_token>`) is durably appended**.
  - **Inherited-descriptor validation (exact, required before adopting; Electron still holds its copy):** the adopter (1) checks the inherited **fd number** + `owner_token` are syntactically valid; (2) verifies `fstat(fd)` matches a fresh **non-symlink** `stat` of *this* activity's `owner.lock` (same dev+inode); (3) opens a **fresh independent descriptor** on that path and confirms an independent probe reports the lock **busy** (`/usr/bin/lockf -t 0` / `flock(LOCK_EX|LOCK_NB)` → exit 75 / `EWOULDBLOCK`) — proving *someone* holds the lease while Electron retains its copy; (4) **re-asserts** the exclusive lock **on the inherited fd itself** and confirms it **succeeds** — proving *this* descriptor shares the holding open-file description. **Both (3) and (4) are required, in that order:** reassert-success alone is ambiguous (it would also succeed on an *unlocked* matching descriptor of a free file — it would just take a fresh lock), and independent-busy alone is ambiguous (a *different* lease could hold the inode). Truth table — independent-busy **and** inherited-reassert-succeeds ⇒ **accept**; independent-*succeeds* (file free) ⇒ **reject** (unlocked descriptor); independent-busy **and** inherited-reassert-*fails* ⇒ **reject** (a different lease holds the inode). Only on **accept** does the adopter append the handoff `ownership` + ack Electron; **any other outcome rejects the handoff** (Electron stays authoritative, finalizes `failed`).
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
- **Global ceiling 64 MiB — enforced by an owner-only admission lock over a crash-recoverable, activity-addressable ledger.** A single **admission lock** `activity/quota.lock` (BSD `flock`, brief critical sections) serializes all budget accounting. **Committed usage is authoritative from the filesystem, not a running total a crash could desync:** under the lock, `committed = Σ actual byte-sizes of every `activity/*/*.jsonl` segment` (a bounded scan — item count is ceiling-bounded). The **ledger** — dir `activity/quota/` (`0700`), per-activity file `activity/quota/<activity-id>.json` (`0600`, written atomically via temp+rename) — holds, for each **live, un-settled** activity only, its **outstanding** `{reserved, granted}`: the headroom not yet materialized on disk. **Accounted unit:** logical segment bytes **including newlines**; the bounded bookkeeping files (`quota.lock`, ledger entries) are **outside** the 64 MiB payload ceiling.
  - **Charge** = `committed + Σ_live max(0, reserved + granted − on_disk(activity))` — i.e. settled bytes (counted by the scan) plus each live activity's not-yet-materialized reservation + grants. Admission and grant checks require `charge + request ≤ 64 MiB`.
  - **Admission (before `start`):** atomically write the entry `{reserved: 60 KiB, granted: 0}`. If the charge would exceed 64 MiB, prune first (order below); still no room → **admission fails best-effort** (ONE non-recursive warning, release the activity lease, skip recording, **sync proceeds unchanged** — observability never blocks execution).
  - **Grant before append (overcount-safe direction):** an ordinary write increments `granted` (a bounded **batched** grant, spent locally to avoid per-line locking) **before** appending its bytes. A crash then leaves `granted > on_disk` — a conservative **overcount**, never an undercount.
  - **Reserved writes** (`control`/`terminal`/`integrity`) consume the pre-reserved 60 KiB partition (per-activity, below) — no grant, **never refused**, no deadlock.
  - **Settlement (terminal durable):** measure the activity's actual on-disk bytes, then **remove its ledger entry** — its bytes are thereafter counted purely by the scan. The unused tail of `reserved`/`granted` is reclaimed by that removal.
  - **Prune (settled items only; `running`/unreconciled never pruned):** **delete the segment files first**, then the scan reflects the reduction. Settled items have **no ledger entry** to desync, so pruning can only overcount transiently, never undercount.
  - **Reconcile under the lock — at startup, before admission, and on any torn/stale entry** — from the bounded scan. A **live reserve-before-start is a normal state** (§1 reserves + leases before `start`), so reclaiming a **no-`start`** entry is **lease-gated** (mirrors §5): the reconciler first acquires *that activity's* `owner.lock` **non-blocking** — **cannot acquire (lease held) or uncertain ⇒ preserve the charge** (a producer is mid reserve→start); **acquired (lease free) + still no `start` ⇒ release** the abandoned reservation and remove the entry. (Reconcile takes `quota.lock` then *non-blocking* `owner.lock`; the back-edge never waits, so there is **no lock-order cycle** with the normal `owner.lock`→`quota.lock` admission path.) An entry whose activity has a **durable `terminal`** is **settled** (measure on-disk, remove entry). A **torn/unreadable** entry cannot report its own counters, so it is charged its **maximum possible liability = the full 4 MiB per-activity cap** (never a guessed `reserved+granted`) and **new admissions/grants are refused best-effort** while it stands; it clears only on authoritative evidence from the **segments + lease** (not the corrupt file) — lease-free + durable terminal ⇒ settle from measured bytes; lease-free + no terminal ⇒ §5-reconcile to a synthetic terminal, then settle; lease held/uncertain ⇒ keep the 4 MiB charge. **Counters are never rebuilt from guesses.**
  - **Prune order** (when admission needs room): oldest routine terminal → other terminal non-failures → old failures. The ceiling OVERRIDES the 14/90-day + newest-50 preferences (pruning younger terminal items if required), **except** that `running`/unreconciled items are never pruned and the newest problem is always preserved.
- **Per-record bounds:** flat primitive `fields` only, ≤32 keys; key ≤64 B; each value ≤1 KiB; aggregate `fields` ≤8 KiB; `detail` ≤8 KiB; encoded record ≤20 KiB.
- **Per-activity cap 4 MiB; the 60 KiB reservation is partitioned into three fixed, non-fungible 20 KiB allocations** so repeated reserve-eligible records can never starve finalization:
  - **20 KiB terminal** — usable only by the authoritative/synthetic `terminal`; never by any other type.
  - **20 KiB cancellation-control** — usable only by `control{cancel_requested}`, which is **idempotent** (written at most once; a repeat is a no-op, so it cannot consume terminal space).
  - **20 KiB dropped-events/integrity** — usable only by the **single** dropped-events `integrity` note, emitted at most once. Any *further* integrity findings become **reader-derived Problems / System Problems**, not stored records, once this allocation is spent.
  - Each allocation bounds exactly one record **including its trailing newline** (record + `\n` ≤ 20 KiB). Ordinary `event`/`start` bytes stop at **4 MiB − 60 KiB**; the partitioned reservation always remains for `control`/`terminal`/`integrity`.
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

1. **Foundation:** record contract + storage layout + identity/validation + schema versioning + **advisory-lock lease (with `owner_token` mint/handoff + inherited-descriptor validation) + global admission lock + crash-recoverable activity-addressable quota ledger (scan-authoritative + reconcile) + finalization state machine + lock-probe reconciliation** + at-rest bounds (partitioned 60 KiB reservation) + best-effort write behavior (Python + a minimal writer). Unit-tested + a CLI-driven attempt.
2. **Producers + propagation:** identity through Electron guards (incl. cancel-ordering fix), the dispatcher (adopt/mint + lock acquire + `ownership`), CLI; `SyncLogger` severity + structured writes; System incidents for pre-attempt failures.
3. **Reader/redactor Node module** (parse/merge/reconcile/redact/retention/schema) + shared redaction fixtures.
4. **Activity window UI + IPC** + System section + subsume "Sync Errors".
5. **Legacy adapter** (opaque `sync-*.log` items; System-only `status.json`/shared streams) + retention wiring.

Phases 1–3 are green review checkpoints but **not releasable** — the feature's job is unmet until Phase 4.

## Testing strategy

- Python: identity adopt/mint + validation; record writing + bounds/truncation + reserved-headroom terminal; severity rule; write-time redaction (shared fixtures); best-effort failure.
- Node: parse/truncation; merge ordering; **reconciliation — held-lock⇒running, released-lock⇒interrupted, released-lock+cancel_requested⇒cancelled, conflicting terminals⇒integrity+interrupted**; read-time redaction (shared fixtures); retention (age + 64 MiB ceiling + prune order); schema-version handling; DTO bounds.
- Admission/ledger (healthy): concurrent admissions under `quota.lock` never let the charge exceed 64 MiB (N independent producers admitting at once stay bounded); a failed admission is best-effort (warns once, releases the lease, sync proceeds); the entry is settled/removed after the terminal is durable.
- Admission/ledger (crash recovery): committed usage is scan-authoritative, so grant-before-append means a mid-write crash **overcounts, never undercounts**; prune-before-decrement (delete files first) can only overcount transiently; the ledger/lock bookkeeping bytes are outside the 64 MiB payload ceiling.
- Reconcile correctness: a **live reserve-before-start** entry whose lease is still **held** is **preserved** (not reclaimed — the undercount race is closed); a no-`start` entry whose lease is **free** is released; a durable-`terminal` entry is settled from measured bytes; a **torn/unreadable** entry is charged the **full 4 MiB** max liability and refuses new admissions until segment+lease evidence settles it (counters never guessed).
- Reserve/cap: at ordinary-capacity exhaustion a `control{cancel_requested}` and the authoritative `terminal` still write into the partitioned 60 KiB reservation (cancellation is not lost); a **repeated** `control{cancel_requested}` is idempotent and cannot consume the terminal's 20 KiB allocation; the k-way merge preserves per-writer append order under a backwards wall-clock step.
- Inherited-descriptor validation (both conditions, ordered): **independent probe busy + inherited reassert succeeds ⇒ accept**; **unlocked matching descriptor** (file free, independent probe *succeeds*) ⇒ **reject**; **right inode held by a different lease** (independent busy, inherited reassert *fails*) ⇒ **reject**; identity match (`fstat`==`stat`) alone never causes adoption.
- Cross-process integration (macOS): a real attempt (Electron acquires the lock → **passes the locked fd + `owner_token` to the spawned dispatcher (fd inheritance) → dispatcher validates (fstat + flock-reassert) + writes handoff `ownership` → `exec` Python holds it** → clean terminal `by=<owner_token>` → lock released) and a simulated crash (lock acquired, `start`+`ownership` written, process killed before terminal → reader acquires the freed lock → `interrupted`; a `control{cancel_requested}` before kill → `cancelled`). **This proves the advisory lease survives spawn-inheritance and `exec`, the handoff carries one continuous `owner_token`, a failed descriptor validation leaves Electron authoritative (finalizes `failed`), and reconciliation is deterministic.**
- Redaction parity: the shared fixtures assert Python and Node mask identically.

## Non-goals

Live tail; Raw stderr lens; clear-logs; analytics; merged cross-run timeline; exhaustive instrumentation of every internal producer (future producers join the same versioned contract additively); any second transitional canonical format.
