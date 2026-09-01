# Activity History (formerly "Log Viewer") — design shape, Round 3 (APPROVED)

**Status:** Shaping — Round 3 (paired with Codex). Scope **B** agreed; architecture signed off, semantic tightenings applied.
**Date:** 2026-08-12
**Supersedes:** the framing in `2026-08-12-log-viewer-design.md` (that inventoried the *old* RepoRadar viewer; we are not porting it).
**Scope decision (paired Round 2):** **B — a phased MVP that is a complete vertical slice of the durable model.** Not a temporary read-time file-fusion. Scope A (deep instrumentation of every producer) is reached later by *adding producers to the same stable contract*, never by re-designing storage or UI.

## Problem — re-grounded

Unattended background syncs fail with no in-app way to see *what* happened or *why*. Opening `~/Library/Logs/repo-radar/` in a terminal is the only recourse today.

**The load-bearing failure that shapes the design:** yesterday a dev sync was **blocked before Python ever ran** (`Dev sync blocked: … interpreter fingerprint mismatch`). No `sync-<ISO>.log` was created; the message went to the mutable `status.json.errorLog`; the "Sync Errors" window (which reads `status.json.errorList`) showed an empty checkmark. **A viewer built on `sync-*.log` files would still miss this.** Correlating the three existing stores at read time is unsound: the guard fails before any log exists (`menubar/main.js:1092-1106`), `status.json` is a snapshot the next accepted sync clears (`:1113-1120`), Python has early exits before `_open_sync_logger()` (`repo_radar/modes/sync.py:924-940` vs `:948`), and the LaunchAgent reuses one shared `sync.error.log` (`:1990-1994`).

## Core model — durable activity, not files

The canonical unit is an **Activity item**, not a log file.

- **Activity item** = one *sync attempt* **or** one *system incident* (a failure that occurs before a sync attempt can reasonably exist). Each has a **durable identity** (stable id) and record.
- **Outcome** = an **authoritative lifecycle result, independent of event severity.** MVP outcomes: `running`, `succeeded`, `succeeded-with-warnings`, `blocked/failed`, `cancelled`, `skipped`, `incomplete/interrupted`. Determined by the finalization/exit state — **never** derived from "stderr exists" or "errorLog non-empty." `succeeded-with-warnings` is an **explicit finalizer decision on defined adverse conditions** (e.g. degraded output, a repo skipped), not "any warn event happened."
- **Events** = ordered, structured facts recorded **under an attempt's identity**, each with an explicit `level` (`info`/`warn`/`error`), event name, fields, and optional detail block. Severity is *source-owned* (the code emitting the event knows it); the viewer never guesses except for legacy data.
- **Problems lens** = the warn/error events + genuine failure diagnostics for an item, with provenance retained (exact duplicates grouped with a count — never string-deduped in a way that hides repeated failures).

### Identity is established BEFORE the first failure gate (invariant 1)

Every supported entry path creates or inherits the attempt/incident identity *before* anything that can fail:

- **Electron (manual / catch-up):** create the attempt **before** the dev/runtime guards (`main.js:1092-1106`). A guard block updates *that* attempt's outcome to `blocked` — it is a durable record, not a lost snapshot.
- **Scheduled / CLI:** establish or inherit identity **before** Python's current early exits (unknown-model rejection, config/network aborts). Identity is passed down to Python (e.g. via env/arg).
- **Python:** *adopts* an upstream identity when present; *creates* one only when none exists (direct CLI). Its structured events attach to that identity.
- **Pre-attempt failures** (bootstrap/schedule/runtime problems with no sensible attempt) become durable **System incidents** — first-class Activity items, not attached to the nearest run.

## The record contract — versioned and stable (invariants 3, 6)

A small **versioned** structured representation is the canonical store — written once, designed to be stable, so future producers join it *additively* (no second migration later):

- Append-only structured records (JSON-lines is the working assumption; final encoding TBD in spec) with: `schema_version`, `activity_id`, `kind` (sync|system), `channel`, `trigger`, `parent_id?`, full **ISO-8601 timestamps** (the current `[HH:MM:SS]`-only format is midnight-ambiguous), plus per-event `level`, `event`, `fields`, `detail`.
- Attempt header/footer records carry `start`, `end`, `outcome`, `summary` (repos changed, error/warn counts).
- **`SyncLogger` gains source-owned `level`** at its two chokepoints, assigned **by rule, not by category**: ordinary retry / wait / recovery — including transient rate-limiting and network waiting — is `info`; degraded-but-completed behavior is `warn`; exhausted retry, timeout, or abort is `error`. (`event`→info by default, `error`→error.) It writes the structured record under the attempt id. Its existing human-readable `sync-<ISO>.log` may remain for humans, but is **not** the machine contract.

**Legacy is read-only compatibility input (invariant 6), with a strict correlation rule so misattribution can't sneak back in:**
- A legacy `sync-<ISO>.log` may appear as an **opaque legacy attempt** — each file gives a genuine run boundary.
- Legacy `status.json` and shared streams appear **only as explicitly uncorrelated "latest diagnostics" in System** — never as standalone Activity items.
- They may **supplement** an Activity item **only** when an explicit durable `activity_id` proves the match. **Never** infer identity for identity-less `status.json` data by time proximity.
- We do **not** invent a second transitional canonical format.

## System section — an honest boundary, not a dumping ground (invariant 4)

A dedicated **System** area holds: (a) legacy/shared diagnostics that predate the contract, and (b) genuine pre-attempt failures. Uncorrelated messages live here honestly rather than being glued to an arbitrary run. New producers should emit under an attempt identity, not into System.

## Redaction — a real, tested boundary (invariant 5)

The existing `redact()` (`menubar/runtime/hashing.js:32`) only masks `//user:pass@` in URLs — it does **not** cover API keys, bearer tokens, or env-var secrets. MVP needs a **purpose-built, unit-tested redaction module** covering the app's configured secret values (the real GitHub/Anthropic/Gemini/OpenAI keys) plus known credential forms. **Redact in main before IPC, and again on export.** Export is produced **in main** from a validated filter request — never from renderer-supplied text.

## Retention — bounded, outcome-aware (invariant 5)

Replace the flat 10-file cap (`sync.py:44`, `_rotate_sync_logs` `:107-120`; ~2.5 days on a 6h schedule) with a **bounded age/size policy** over the durable store, with **failed/blocked attempts retained longer** than routine successes, so a Friday failure survives to Monday. Exact bounds set in spec.

## UI + architecture

- **Dedicated, context-isolated Activity window** — **not** the current `nodeIntegration:true` / `contextIsolation:false` window (`main.js:1519-1529`). Narrow preload + IPC, bounded payload/file sizes, ANSI/control-character handling, and **renderer inserts text (not HTML)**. Reuse only the visual language.
- **Available any time, including during a sync** (invariant, corrects a Round-1 inconsistency) — the tray shows **both** "View Progress" (live) and "Activity" (history). It does not live-tail merely because it can be open.
- **Attempt/incident list**, newest first, each row a chip: time · channel/trigger · duration · repos changed · **outcome** dot + error/warn counts. Grouped by attempt/incident (no merged cross-run timeline in MVP).
- **Two lenses per item:** **Events** (structured rows; filter by level + free-text search; expandable detail) and **Problems** (warn/error roll-up with provenance). **Raw** stderr lens is deferred.
- **Subsume the "Sync Errors" window.** Its "View Errors" affordance appears **only when a problem-bearing Activity item exists**, and deep-links to the **newest item carrying Problems or a failure-like outcome** — `blocked/failed`, `incomplete/interrupted`, `succeeded-with-warnings`, **or a first-class System incident**. One error truth, and never an empty view under a new name.
- **Pure, testable Node module** owns filesystem access, parsing, normalization, redaction, filtering-for-export, and path validation; `main` calls it and hands the renderer **bounded, already-redacted DTOs** over narrow IPC.

## MVP boundary (Scope B)

**In (the correctness floor — none of these deferred):** attempt/incident identity established before each entry path's first failure gate; authoritative outcome model; structured events under identity at every newly-touched boundary; System section for pre-attempt/legacy; real redaction module; bounded outcome-aware retention; context-isolated window; source-owned `level`; Events + Problems lenses; legacy `sync-*.log` adapter; the Node parse/redact module with unit tests.

**Deferred (join the same stable contract later):** Raw stderr lens; clear-old-logs (with mid-sync guard); analytics/summary charts; merged cross-run timeline; exhaustive instrumentation of *every* internal producer.

## Non-goals

Not a live tail (the Progress window is the live half). Not a general log platform. Not a port of the old viewer's JSON-lines / two-fixed-file assumptions. Not a second canonical format that needs future migration.

## Residual risks / to pin in the spec

- Exact identity-propagation mechanism from Electron/dispatcher → Python (env vs arg), and how the LaunchAgent path carries it.
- Final record encoding + `schema_version` semantics.
- The precise secret-set the redaction module must cover and where it reads it from.
- Concrete retention bounds (age/size, failed-vs-success).
- Whether the legacy adapter reconstructs identity for old `sync-*.log` or lists them as opaque legacy items.
- **Abnormal-termination recovery:** an attempt with a start record but no terminal record must not stay `running` forever. Specify a crash-safe reconciliation that converts *provably abandoned* attempts to `incomplete/interrupted` **without** misclassifying a still-live process.
- **Multi-process storage integrity:** Electron, the dispatcher, and Python may all touch the same activity. Pin writer ownership, locking/atomicity, truncated-tail recovery, event ordering, and duplicate-finalization behavior.
- **At-rest security + bounds:** owner-only directory/files, bounded field/detail sizes, and a rule for whether source writes are redacted or raw-but-owner-only *before* the mandatory read/export redaction boundary.
- **Observability failure behavior:** decide whether a failure to create/update Activity history is best-effort or blocks execution — it must **not** accidentally change sync semantics.
