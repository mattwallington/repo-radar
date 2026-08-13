# Activity History — concrete spec

**Status:** Spec — decision review (paired). Scope **B**, full vertical MVP through the Activity window.
**Date:** 2026-08-12
**Builds on (approved):** `2026-08-12-log-viewer-shape.md` @ `4972b4e` (durable Activity model, outcome≠severity, source-owned severity, subsume Sync Errors, context-isolated window). This spec resolves the 8 deferred decisions per paired Rounds 3–4.

## Goal

In-app **Activity History**: every sync attempt and every pre-attempt system incident becomes a durable, inspectable record with an authoritative outcome — so a blocked/failed/crashed run is always visible in the app, not buried in a terminal.

## Architecture

Producers (Electron main, the shell dispatcher, Python) write append-only structured records under a shared **activity identity** into per-writer-instance segment files. A pure Node **reader/redactor** merges + normalizes + redacts them into bounded DTOs for a context-isolated **Activity** window. Lifecycle authority (who may finalize an attempt) and abnormal-termination reconciliation are foundation concerns, not late hardening.

## Global Constraints

- **Observability is best-effort and never changes sync semantics.** A failed history write emits ONE non-recursive warning to the producer's existing stderr/log and continues. Never route an Activity-write failure through the failing Activity writer.
- **Redaction is defense-in-depth.** Redact known secrets at WRITE time (where the producer knows them) AND again in Node before IPC/export. Shell producers emit fixed reason codes + bounded messages, never environment dumps.
- **No new runtime dependency** beyond what ships today (Node stdlib + Python stdlib for the record layer; the existing Electron stack for UI).
- **Legacy is read-only.** Old `sync-*.log` / `status.json` are best-effort compatibility input only; identity-less `status.json` is System-only, never a standalone Activity item, and never time-proximity-correlated to an attempt.
- **All size limits count UTF-8 bytes and mark truncation explicitly.**

---

## 1. Activity identity + propagation

- **Transport:** env var `REPO_RADAR_ACTIVITY_ID` = a fresh UUIDv4 **per invocation**. Never persisted in the LaunchAgent plist environment.
- **Validation (security):** before any producer uses an inherited id in a filesystem path it MUST match `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`. An invalid/absent id → the producer mints a fresh one (never trusts arbitrary text in a path).
- **Generation points (earliest boundary on each path, before any failure gate):**
  - **Electron manual/catch-up:** create the id + write the attempt `start` record **before** `currentSyncProcess` spawn and the dev/runtime guard (`menubar/main.js:1080-1106`); set it in the child env. A guard block → outcome `blocked` on that record. Contention (a sync already running) → outcome `skipped`, never a silently-absent attempt.
  - **Scheduled (LaunchAgent) / dispatcher:** the dispatcher mints the id + writes `start` **before** its root lock (`menubar/runtime/dispatchers.js:85-87`), and passes it through `exec` (`:109`) to Python.
  - **Direct CLI:** Python creates/adopts the id in `repo_radar/cli.py` **before dependency checking** (`cli.py:37-41` can exit first), not only in `sync_mode`.
  - **Python (any path):** adopt `REPO_RADAR_ACTIVITY_ID` when present+valid; create only when absent.
- **Kind:** `sync` (an attempt) or `system` (a failure with no sensible attempt — bootstrap/schedule/runtime).

## 2. Storage layout + record encoding

- **Directory:** `~/Library/Logs/repo-radar/activity/<activity-id>/` created mode `0700` (securely — no briefly-permissive window). Reject the path if it exists as a non-directory or a symlink.
- **Segments:** one append-only JSONL file **per writer instance**, not per role: `<producer>-<writer-id>.jsonl` (`producer` ∈ {electron, dispatcher, python}; `writer-id` = a short random token unique to that process/attempt). A role can recur (retry/recovery/id-reuse) without write contention. Files created `0600`.
- **Records:** one JSON object per line with `schema_version` (int, start `1`), `activity_id`, `type` (`start` | `event` | `terminal` | `integrity`), `seq` (monotonic per segment, from 0), `ts` (full ISO-8601 with offset). Readers tolerate unknown fields (forward-compat).
  - `start`: `kind`, `channel`, `trigger`, `parent_id?`, `owner` (see §5), `producer`, `writer_id`, and process fingerprint (`pid`, `boot_id`, `proc_birth`).
  - `event`: `level` (`info`|`warn`|`error`), `event` (name), `fields` (flat map), `detail?` (string).
  - `terminal`: `outcome` (§6), `summary` (repos changed, error/warn counts), `by` (which owner finalized).
  - `integrity`: a machine-detected inconsistency (conflicting terminals, corruption) surfaced as a Problem.
- **Ordering:** merge all segments for an id deterministically by `(ts, writer_id, seq)` — timestamps alone cannot order across processes.

## 3. Severity + outcome

- **Severity by rule (source-owned)** in `SyncLogger` (`repo_radar/modes/sync.py:48`) and the other producers: ordinary retry/wait/recovery (incl. transient rate-limit + network waiting) = `info`; degraded-but-completed = `warn`; exhausted retry / timeout / abort = `error`.
- **Outcome** (authoritative lifecycle, decided at finalization, independent of event severity): `running`, `succeeded`, `succeeded-with-warnings`, `blocked`, `failed`, `cancelled`, `skipped`, `incomplete/interrupted`. `succeeded-with-warnings` is an explicit finalizer decision on defined adverse conditions (degraded output, a repo skipped) — not "a warn happened."

## 4. Redaction (defense-in-depth)

- **Write time:** where a producer knows secrets (Python/Electron config), redact configured/effective secret values + high-confidence credential forms (`sk-…`, `ghp_…`/`github_pat_…`, `AIza…`, `Bearer …`, `//user:pass@`) from any free-text `detail`/`fields` before writing. Shell producers never emit env dumps — only fixed reason codes + bounded messages.
- **Read time (backstop):** the Node reader redacts again — against the same credential forms + the app's currently-configured secrets — before any IPC or export. (Read-time config-only is insufficient: CLI secrets may come from a different env; a rotated key is gone from `config.json`.)
- **Shared fixtures:** a common redaction test-fixture set (the same secret strings + expected masks) is exercised by BOTH the Python and Node redactors so they cannot drift. Pattern: mirrors the existing write-time-redact + owner-only storage for degraded responses (`repo_radar/metadata.py:178-232`).

## 5. Lifecycle ownership (crash correctness — foundation, not hardening)

PID+boot alone is insufficient (PIDs recycle; Electron can outlive an attempt). Ownership is explicit and transfers in order:

- **Electron** owns the attempt through the pre-spawn guards.
- **The dispatcher** *claims* ownership when launched; because it `exec`s Python (`dispatchers.js:109`), that ownership **survives into the Python process** (same PID lineage).
- **Direct Python** owns attempts it creates.
- **Lease:** the owning process holds a per-attempt **lifetime lease** (a record noting `owner`, `pid`, `boot_id`, `proc_birth`) inherited through `exec`. PID/boot/birth are *evidence*, not the sole signal.
- **Reconciliation** (run by the reader at open, and opportunistically at sync start): finalize an attempt **only after proving the current owner is gone** (dead PID whose birth fingerprint no longer matches, or a pre-current-boot start). If liveness is uncertain, leave it `running` and surface a System **integrity warning** — never guess a dead owner.
- **Cancellation ordering fix:** Electron MUST persist `cancel_requested` to the attempt **before** sending SIGTERM. Current order is racy — it signals at `menubar/main.js:2135-2138` then records cancellation at `:2178-2184`. After the fix: a dead owner **with** recorded `cancel_requested` reconciles to `cancelled`; otherwise `incomplete/interrupted`.

## 6. Finalization state machine + integrity

- Only the **current lifecycle owner** may ordinarily write a `terminal`. Ownership transfers (Electron→dispatcher→Python) are explicit and ordered.
- **Reconciliation** may synthesize a `terminal` only after proven owner death (§5).
- **Exact-duplicate** terminals (same outcome) are grouped (count).
- **Conflicting** terminals (different outcomes) → an `integrity` Problem + a **conservative** outcome (worst of the conflicting set) — never silently deduped.
- **Corruption:** ignore a truncated **trailing** JSONL line silently; surface **interior** corruption as a System integrity Problem, and recoverable interior corruption must NOT hide later valid records in the same segment.

## 7. Retention + at-rest bounds

- **Age policy (Boolean, precise):** a `routine` (non-problem) terminal item is age-prunable only when older than **14 days AND** outside the newest **50**; a `problem-bearing` item only when older than **90 days AND** outside the newest **50**. Never prune `running` or unreconciled items.
- **Hard global ceiling:** **64 MiB** for the `activity/` tree. Under pressure prune in order: oldest terminal routine → other terminal non-failures → old failures; always preserve the newest problem item where possible.
- **Legacy human-log rotation** (`_rotate_sync_logs`, 10 files) stays independent of canonical Activity retention.
- **Per-record bounds:** flat primitive `fields` only, ≤32 keys; key ≤64 B; each serialized value ≤1 KiB; aggregate `fields` ≤8 KiB; `detail` ≤8 KiB; encoded record ≤20 KiB. **Per-activity** cap ≤4 MiB, reserving headroom for terminal/integrity records. Over-limit values are truncated with an explicit marker.
- Validate activity/writer ids; reject unsafe file types/symlinks.

## 8. Reader / Node module (pure, testable)

`menubar/activity/` — a dependency-free Node module: filesystem enumeration, id/path validation, JSONL parse + truncation tolerance, cross-segment merge + ordering, reconciliation, redaction, retention, and building **bounded redacted DTOs** for a filtered/export request. `main` calls it; the renderer only ever receives bounded, already-redacted DTOs over a narrow, context-isolated IPC surface. Export is produced in main from a validated filter request, never from renderer text.

## 9. UI (Activity window — MVP)

- **Dedicated, context-isolated `BrowserWindow`** (`contextIsolation:true`, `nodeIntegration:false`, narrow preload) — not the current `showLogWindow` settings (`main.js:1519-1529`). Bounded payload/file sizes; ANSI/control-char handling; renderer inserts text (never HTML). Reuse only the visual language.
- **Tray:** "Activity" available **any time**, alongside the sync-only "View Progress".
- **List:** attempt/incident items newest-first, each a chip — time · channel/trigger · duration · **outcome dot** · error/warn counts. Grouped by item (no merged timeline in MVP).
- **Two lenses per item:** **Events** (structured rows; filter by level + search; expandable `detail`) and **Problems** (warn/error + failure diagnostics, provenance retained; exact dups grouped w/ count; integrity Problems shown). **Raw** lens deferred.
- **Subsume "Sync Errors":** its "View Errors" affordance appears **only when a problem-bearing item exists** and deep-links to the newest item carrying Problems or a failure-like outcome (incl. a System incident) — never an empty view.
- Actions: Refresh · Export (redacted) · Reveal-in-Finder. Clear-logs deferred.
- **History unavailable/incomplete** (per Global Constraints) is a first-class UI state.

## 10. Phasing (revised — crash correctness in the foundation)

1. **Foundation:** the record contract + storage layout + identity + validation + **lifecycle ownership/lease + finalization state machine + reconciliation** + at-rest bounds + best-effort write behavior. (Python + a minimal Electron/dispatcher writer.) Testable via unit tests + a CLI-driven attempt.
2. **Producers + propagation:** wire identity through Electron guards (incl. cancel-ordering fix), the dispatcher, and CLI; `SyncLogger` severity + structured writes; System incidents for pre-attempt failures.
3. **Reader/redactor Node module** (parse/merge/reconcile/redact/retention) + shared redaction fixtures.
4. **Activity window UI + IPC** + subsume "Sync Errors".
5. **Legacy adapter** (opaque legacy `sync-*.log` items; System-only `status.json`) + retention wiring.

Phases 1–3 are green review checkpoints but **not releasable** — the feature's job (users inspect failures in-app) is unmet until Phase 4.

## Testing strategy

- Python: unit tests for identity adopt/mint + validation, record writing + bounds/truncation, severity rule, write-time redaction (shared fixtures), best-effort failure.
- Node: unit tests for parse/truncation, merge ordering, reconciliation (live vs dead owner; cancel vs interrupted; conflicting terminals → integrity), read-time redaction (shared fixtures), retention (age + byte ceiling + prune order), DTO bounds.
- Cross-process: an integration test driving a real attempt (identity env → Python writes → reader reconstructs) and a simulated crash (start, no terminal, dead PID → `incomplete/interrupted`).
- Redaction parity: the shared fixture set asserts Python and Node mask identically.

## Non-goals

Live tail (Progress window owns live); Raw stderr lens; clear-logs; analytics; merged cross-run timeline; exhaustive instrumentation of every internal producer (future producers join the same versioned contract additively); any second transitional canonical format.
