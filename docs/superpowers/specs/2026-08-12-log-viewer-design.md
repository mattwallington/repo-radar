# Log Viewer — feature scoping / design

**Status:** Scoping (not yet planned or built)
**Date:** 2026-08-12
**Author:** Matt (with Claude)

## Summary

The pre-refactor Electron app (the old `RepoRadar` / "Sync Pristine Repos" codebase, now
living only as uncommitted work in `~/Development/personal/repo-radar`) shipped a **historical
log viewer** window that the current `menubar/` app does **not** have. This doc captures what
that viewer did, what the current app already provides, and the specific decisions needed to
build an equivalent into the current architecture. We are **not** porting the old code
verbatim — it was written against a different log format and app structure. This is the
scoping input for a future plan/spec.

## Why we want it

Repo Radar runs an unattended background sync (LaunchAgent, per-channel) that clones/updates
repos and generates AI metadata. When a scheduled sync misbehaves — a repo fails to update,
an API key is wrong, LiteLLM rate-limits, the runtime fails verification — there is currently
**no in-app way to see what happened after the fact**. You have to open
`~/Library/Logs/repo-radar/` in Finder/Terminal and read raw files. A log viewer closes that
gap: open a window, filter to errors, search, export, done.

## What the old log viewer did (feature inventory)

Source (for reference; will be archived): `~/Development/personal/repo-radar/renderer/log-viewer.{html,js}`,
wired in that repo's `main.js` (window at ~L1255, `get-log-directory` / `clear-logs` /
`open-log-directory` IPC handlers).

A standalone Electron window (~330 lines total) that:

1. **Read persisted logs from disk** — hardcoded to `main.log` and `sync.log` under the log
   directory, where **each line was a JSON object**: `{ timestamp, level, message, ...extra }`.
   Non-JSON lines were skipped.
2. **Merged + sorted** all entries newest-first by `timestamp`.
3. **Rendered rows**: timestamp · level (color-coded) · message, with an expandable pretty-printed
   JSON blob for entries carrying extra fields.
4. **Filter controls:**
   - **Search** — free text across the message and the full JSON payload.
   - **Time window** — All / Last Hour / Last 24h (default) / Last Week.
   - **Level** — All / Errors only / Warnings+Errors / Success only.
   - Live "X of Y entries" counter + the log directory path in the footer.
5. **Actions:**
   - **Refresh** — re-read from disk.
   - **Export** — write the current (filtered) view to a `.txt` via a save dialog.
   - **Clear Logs** — confirm prompt → `clear-logs` IPC → main process truncates/removes logs →
     `logs-cleared` event back to the renderer.

That's the UX target. It's a good, proven shape — worth reproducing.

## What the current app already provides (do NOT rebuild)

The current `menubar/` app is **richer** than the old one on the logging side. Three things
already exist:

### 1. Persisted, already-structured per-run logs

The Python sync process writes one file per run:
`~/Library/Logs/repo-radar/sync-<ISO-timestamp>.log` (rotated). These are **not** JSON-lines —
they're **logfmt-style structured events**:

```
[21:33:54] sync_start trigger=cli channel=stable mode=full dry_run=False skip_metadata=False
[21:33:58] repos_loaded count=30
[21:34:00] repo_unchanged repo=ReperioHealth/reperio-mobile-app
[21:34:01] repo_updated repo=ReperioHealth/reperio-telehealth old=314fdc4 new=d706c23
```

Format per line: `[HH:MM:SS] <event_name> key=value key=value ...`. This is **already
parseable** and arguably cleaner than the old JSON-lines format. (Ref: `menubar/main.js`
comment block ~L1305 — "Per-run sync logs are written directly by the Python sync process… we
no longer write a duplicate latest-sync.log… it only captured the noisy rich-formatted UI
stream with ANSI codes.")

Other files in the same directory:
- `sync.log` / `sync.error.log` — LaunchAgent StandardOut/StandardError. **Raw stdout/stderr
  with ANSI codes** — LiteLLM warnings, shell errors, `interpreter fingerprint mismatch`, etc.
  Noisier, but where low-level runtime failures surface.
- `menubar.log` / `menubar.error.log` — the Electron process's own stdout/stderr.
- `renderer.log` — renderer console output.

### 2. A live `logWindow` (the "Progress" window)

`showLogWindow()` (`menubar/main.js:1504`) opens a window titled "<App> - Progress" that loads
`renderer/index.html`. During a sync it receives a **live stream** over IPC: `terminal-output`,
`progress-update`, `rate-limit-update`, `waiting-for-network`, `network-timeout`,
`sync-complete` (see the status-server handler, `menubar/main.js` ~L880–1040). The tray shows
"📊 View Progress" **only while a sync is running** (`menubar/main.js:551`).

**This is the live half.** What's missing is the **historical / persistent** half — browsing
past runs when nothing is syncing.

### 3. A semi-structured status stream with categories

The status server already tags messages with `data.type`:
`output | progress | error | rate-limit | waiting-for-network | network-timeout | complete`.
These are effectively **levels/categories** we can reuse for filtering, both live and historical.

## The gap — decisions to make before building

The old viewer can't be dropped in because the log format and app structure differ. The real
scoping work is these decisions:

1. **Parser + level derivation (the main one).** Current logs have **no explicit `level`
   field** — they're `[time] event k=v`. We must derive level/category from the event name.
   Proposed mapping (to be finalized):
   - `*_error`, `sync_failed`, `repo_error` → **ERROR**
   - `rate_limit`, `network_timeout`, `waiting_for_network`, `*_warning`, `degraded*` → **WARN**
   - `sync_complete`, `repo_updated`, `repos_loaded` → **SUCCESS/INFO**
   - everything else → **INFO**
   This mapping is the heart of the feature and should be defined once, shared, and tested.

2. **Timestamp reconstruction.** Lines carry `[HH:MM:SS]` (time only). The **date** lives in
   the filename (`sync-2026-08-11T21-33-54.log`). The viewer must combine filename-date +
   line-time to get a full timestamp for the time-window filter and cross-run sorting.

3. **Which files, and how to present them.** Old viewer read 2 fixed files. We now have N
   rotated per-run files plus the raw stdout/stderr logs. Decide:
   - Primary view = the clean `sync-*.log` event stream (recommended default).
   - Secondary/"advanced" view = raw `sync.error.log` for low-level runtime failures.
   - Present as a **merged timeline** across runs, or **grouped by run** (per-file sections)?
     Grouped-by-run maps naturally to "show me the 9am sync."

4. **Separate window vs. a tab on the existing Progress window.** Cleanest path: add a
   **"History" mode/tab to the existing `logWindow`**, reusing its preload, dark styling, and
   IPC plumbing, rather than a second BrowserWindow. Live stream = "Current" tab; disk browse =
   "History" tab. Also add a tray item ("🗒 View Logs") that's available **when NOT syncing**
   (complements the sync-only "View Progress").

5. **Clear Logs semantics.** With per-run rotated files, "clear" = delete the `sync-*.log`
   files (and optionally truncate `sync.log`/`sync.error.log`). Needs a main-process handler
   with a guard so it can't run mid-sync and can't escape the log dir.

6. **Redaction.** Sync env dumps and error output can contain API keys
   (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, GitHub token). The runtime already
   has a `redact()` helper (`menubar/runtime/provision.js`). **Any log rendered or exported by
   the viewer must pass through the same redaction** — this is a hard requirement, especially
   for Export (which writes a file the user might share).

7. **Rendering safety.** Current windows run with `nodeIntegration: true` /
   `contextIsolation: false` (`showLogWindow` webPreferences). Keep the old viewer's
   `escapeHtml` discipline (or render via textContent) so log content can't inject markup.

## Proposed scope

**MVP (recommended first cut):**
- New "History" tab on the existing `logWindow`, or a lightweight standalone window.
- Read `sync-*.log` files from `~/Library/Logs/repo-radar/`, parse the logfmt lines,
  reconstruct full timestamps from filenames.
- Rows: timestamp · derived-level · event · key/values, newest-first.
- Filters: search, time window (All/Hour/Day/Week), level (All/Errors/Warn+Err/Success).
- Refresh + Export (redacted). Tray entry available when not syncing.

**Follow-ups (defer):**
- "Advanced / raw" view over `sync.error.log` (ANSI-stripped).
- Group-by-run presentation and per-run summary chips (duration, repos changed, error count).
- Clear Logs with mid-sync guard.
- Unify live + historical into one continuous timeline.

## Open questions (for the scoping conversation)

- Merged cross-run timeline, or grouped-by-run? (Leaning grouped-by-run.)
- New tab on `logWindow` vs. dedicated window? (Leaning tab — reuse plumbing.)
- Do we want the raw stderr view in v1, or is the clean event log enough?
- Should the per-run event log format grow an explicit `level=` key at the **source** (Python
  side) instead of deriving it in the viewer? That would make the viewer trivial and also
  benefit any other consumer. Worth weighing: small change in `repo_radar`, removes decision #1.

## Reference pointers

- **Current logging code:** `menubar/main.js` — status-server handler ~L880–1040 (live stream,
  `data.type` categories), `showLogWindow()` L1504, log-dir constant / cleanup ~L702, per-run
  log comment ~L1305.
- **Current log format sample:** `~/Library/Logs/repo-radar/sync-<ISO>.log` (logfmt events).
- **Redaction helper:** `menubar/runtime/provision.js` (`redact`).
- **Original viewer (archived):** the old `RepoRadar` repo was deleted on 2026-08-12 (its GitHub
  remote no longer existed — no other copy). Its full source, including `.git` history and the
  uncommitted work, is preserved at `~/Development/_archive/reporadar-old-2026-08-12.tgz`.
  To crib the original UI code:
  `tar xzf ~/Development/_archive/reporadar-old-2026-08-12.tgz -C /tmp` then see
  `/tmp/repo-radar/renderer/log-viewer.{html,js}`, `about.{html,js}`, `theme.{css,js}`, and the
  `main.js` IPC wiring (`get-log-directory`, `clear-logs`, `open-log-directory`). Behaviors are
  also captured above so this doc stands alone without the archive.
