# Log Viewer / Activity History — design shape (v2, current codebase)

**Status:** Shaping (paired with Codex before spec/plan)
**Date:** 2026-08-12
**Supersedes the framing in:** `2026-08-12-log-viewer-design.md` (that doc inventoried the *old* `RepoRadar` viewer; we are re-designing for the current app, not porting it).

## Problem — re-grounded on what actually bites

Repo Radar runs unattended background syncs. When one misbehaves there is **no in-app
way to see what happened after the fact** — you open `~/Library/Logs/repo-radar/` in a
terminal. We want an in-app view: open a window, find the failing run, see why.

**The sharpest lesson (from a real failure today):** a dev sync failed with
`Dev sync blocked: … interpreter fingerprint mismatch`. That message lived in
`status.json.errorLog` **and** the raw stderr — **not** in the clean `sync-*.log`
event stream. Meanwhile the existing **"Sync Errors" window reads `status.json.errorList`
and showed *nothing*** (empty checkmark). So the user saw a red icon and an empty error
list, with the real cause invisible in the app.

**Design consequence:** a viewer that reads only the structured event log would have
**missed today's error entirely.** The feature's real job is *"surface what went wrong,
wherever it hides,"* not just "pretty-print the event log." This is the biggest departure
from the old viewer (which read two fixed files).

## Current surfaces to build on (reuse, do not rebuild)

- **`SyncLogger`** (`repo_radar/modes/sync.py:48`) — writes one per-run file
  `sync-<ISO>.log`, format `[HH:MM:SS] event_name k=v …`. It has **two** methods:
  `event()` (routine) and `error(name, repo, detail=…)` (stamps an event **plus an
  indented detail block**, first 8 lines of e.g. git stderr). Central, thread-safe,
  **already error-aware** — so it already knows the severity of what it logs.
- **Raw runtime streams:** `sync.log` / `sync.error.log` (LaunchAgent stdout/stderr,
  ANSI, where low-level failures like the fingerprint mismatch land), `menubar.log` /
  `menubar.error.log`, `renderer.log`.
- **`status.json`** (`~/.config/repo-radar/status.json`) — the menubar's results
  snapshot: `stats`, `repos`, `errorList` (per-repo), **`errorLog`** (free-text/stderr),
  `channels`. This is where today's real error was.
- **Live Progress window** — `showLogWindow()` (`menubar/main.js`), fed by the
  status-server stream with `data.type` categories: `output | progress | error |
  rate-limit | waiting-for-network | network-timeout | complete`. Live only; tray shows
  "View Progress" **only while syncing**.
- **`redact()`** (`menubar/runtime/hashing.js:32`) — strips API keys / tokens. **Every
  rendered or exported line must pass through it** (esp. Export, which writes a shareable
  file, and the raw stderr view, which can contain env dumps).

## Proposed shape (my recommendation — for Codex to challenge)

**One persistent "Activity" view, available any time (not sync-gated), organized
by run, that unifies the three error sources.**

1. **Source-side severity.** Add `level=` to `SyncLogger` at the two chokepoints
   (`event` → `info`/derived, `error` → `error`; add a `warn` path for
   rate-limit/network/degraded). One-place change; the viewer just reads `level=`.
   Keep a tiny viewer-side fallback so **legacy logs without `level=` still render**.

2. **Run-oriented navigation.** Left: a list of past runs (newest first), one row per
   `sync-<ISO>.log`, each with a **summary chip** — time, trigger/channel, duration,
   repos changed, **error/warn counts**, and an overall status dot (green/yellow/red).
   Red is computed from *any* of: a `level=error` event, a non-empty `errorList`, **or**
   a non-empty `errorLog` for that run — so a run can't look clean while hiding an error.

3. **Run detail = three coherent lenses on the selected run:**
   - **Events** (default) — parsed `sync-*.log` rows: time · level · event · k/v, with
     the `error()` detail block expandable. Filter by level + free-text search.
   - **Errors** — a focused roll-up: `level=error` events + `errorList` entries +
     the `errorLog` text, deduped. *This is the lens that would have shown today's bug.*
   - **Raw** — the run's raw stderr (`sync.error.log`), ANSI-stripped + **redacted**,
     for low-level failures. (Advanced; may be v2.)

4. **Reuse the plumbing.** Same dark styling, preload, and IPC shape as the existing
   `logWindow`. A tray item ("View Logs / Activity") available **when not syncing**
   complements the sync-only "View Progress". Parsing + redaction live in **main**
   (Node), renderer gets clean structured JSON — keeps secrets out of the renderer and
   the parser unit-testable.

5. **Actions:** Refresh · Export (redacted `.txt` of the current filtered view) ·
   Reveal-in-Finder · (later) Clear-old-logs with a mid-sync guard.

## Open decisions I most want Codex's take on

1. **Scope of surfaced data (the load-bearing one).** Is "Events + Errors roll-up +
   Raw" the right set of lenses? Specifically: is folding `status.json.errorLog` and raw
   `sync.error.log` into a per-run view the right move, or does that couple the viewer
   too tightly to two volatile formats? Alternative: fix the *source* so every real
   error also lands in `sync-*.log` (via `SyncLogger.error`) — then the viewer only needs
   the event log. That's cleaner long-term but a bigger behavior change. **Which
   direction?**

2. **Level at source vs viewer.** Given `SyncLogger` already splits event/error, is
   source-side `level=` clearly right, or is there value in keeping severity a pure
   viewer concern (no log-format change, no migration)?

3. **Relationship to the existing "Sync Errors" window.** Subsume/replace it (it showed
   empty while the real error was elsewhere — arguably a bug), or leave it and add this
   alongside? Leaning subsume.

4. **Window vs. tab, and run grouping.** Dedicated persistent "Activity" window, or a
   "History" tab bolted onto the (sync-only) Progress window? And grouped-by-run
   (proposed) vs. a merged cross-run timeline?

5. **Where parsing/redaction live** — main-process (proposed, testable, secret-safe) vs
   renderer.

## Proposed MVP boundary (YAGNI)

**In:** source-side `level=` + viewer fallback; run list with status chips (severity
computed across event log + `errorList` + `errorLog`); Events lens + Errors roll-up
lens; search + level + time-window filters; redacted Export; tray entry when idle;
parsing/redaction in main with unit tests.
**Deferred:** Raw stderr lens; Clear-logs; group/merge toggle; per-run summary analytics;
unifying live + historical into one timeline.

## Non-goals

Not a live tail (the Progress window is the live half). Not a general log platform. Not
a port of the old viewer's JSON-lines assumptions or its two-fixed-file model.
