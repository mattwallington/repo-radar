# Changelog

All notable changes to Repo Radar are documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/).

## [1.0.30] - 2026-08-12

### Fixed
- **GPT-5.6 Sol / Terra / Luna input limits.** The catalog recorded the models' 1,050,000-token *total* context as their *input* window; corrected to the real 922,000 (total minus the 128,000 output reservation), caught by the release-time model-window gate.

### Changed
- **Authoritative token counting for Claude.** Metadata generation now preflights each prompt through Anthropic's Count-Tokens endpoint and accepts, splits, or (for a single oversized item) trims it against the model's *real* window — replacing the conservative multiplier added in 1.0.29. When an authoritative count isn't available (non-Anthropic models, provider errors, or transient failures) it falls back to the existing safe behaviour, so it is never less safe than before, and a batch that still can't fit is only ever split further — never silently merged past what fits. A repository that genuinely cannot be summarised is recorded as a visible `degraded` entry instead of failing quietly.

### Added
- **Activity History (Phases 1–5).** Durable per-attempt sync history, with a context-isolated Activity window (tray → 🗒 Activity), Events / Problems lenses, a System diagnostics section, redacted export, and a never-empty View Errors deep link. It replaces the Sync Errors window: Clear Errors is gone, and the error icon now clears on the next successful sync. Pre-existing `sync-*.log` files now show up as opaque "legacy" items, never correlated to durable activities, and exports note when legacy logs are omitted. Automatic retention now runs at app start and after every sync: routine activities older than 14 days and problem activities older than 90 days are deleted, with the newest 50 activities protected from that age-based deletion. The 64 MiB history ceiling overrides that protection — if history is over the ceiling it prunes within the newest 50 as well, always keeping the newest problem activity.
- **Model capability catalog.** Every model's context / input / output window and token-counting strategy now live in one explicit place, with a 1% acceptance-budget headroom, so budget decisions no longer depend on scattered constants.
- **Release-time model-window gate.** `release.sh` now fails the release closed if a catalog window value drifts above what litellm reports, unless a vendor-verified, freshness-bounded override justifies the difference — so a stale or wrong window cannot ship.

## [1.0.29] - 2026-08-07

### Fixed
- **Claude prompts overflowing the context window.** litellm bundles a single Claude tokenizer that undercounts Claude 4.7-and-later by roughly 1.6×, so a large repository's metadata prompt could pass the local budget check and then be rejected by the API (observed: a ~745K local count the server actually counted as ~1.19M against a 1M limit). Claude 4.7+ is now budgeted conservatively, chunk prompts are measured against the real assembled prompt rather than the bare text, and split remainders are merged forward instead of spawning tiny extra paid calls.
- **GPT-5.4 mini / nano input limits.** `gpt-5.4-mini` and `gpt-5.4-nano` were recorded with a 1,050,000-token input window; corrected to their real 272,000 so chunking sizes prompts against the true limit.

### Changed
- **Retired Claude Opus 4.1** (vendor shutdown 2026-08-05). A saved `claude-opus-4-1` selection now migrates to Claude Opus 4.8.

## [1.0.28] - 2026-07-30

### Fixed
- **Config file permissions.** `config.json` — which holds your GitHub token and provider API keys — was created world-readable (0644) by both the app and the CLI, and a file created permissively by an earlier version was never tightened. Both writers now create it owner-only and correct existing files, and the app tightens a legacy config at startup.
- **Scheduled syncs left no record.** A scheduled run that completed while the app was closed — the normal case for a 9am job — updated nothing, so the menu showed a stale "Last Sync" and the missed-sync check could launch a second, redundant sync. Runs now write a durable completion receipt that the app reconciles, and every run records how it was actually triggered instead of guessing.
- **Repositories too large to summarise.** Combining a large repository's analyses could exceed the model's context window and fail metadata generation outright. Analyses are now combined hierarchically in bounded batches, so every part still reaches the final summary.
- **Duplicate index entries.** Every repository appeared twice in `INDEX.md` (and the total was doubled) because the stable symlink was counted alongside the real file.
- **Silent metadata parse failures.** A failed parse was written and indexed as though it were fine, so `Unknown` fields looked like a model that didn't know rather than a parser that gave up. Failed parses are now flagged, explained, and surfaced in the index.
- **GPT-5.3 Codex context window.** The catalog recorded the 400K *total* context in a table of *input* windows, so chunks could exceed the real 272K input limit.

## [1.0.27] - 2026-07-24

### Added
- **Packaged Python runtime binding.** The app now self-provisions a per-channel, per-version Python runtime — an immutable generation (a venv plus hash-pinned dependencies installed with `--require-hashes`) under `~/.repo-radar/<channel>/generations/`, activated atomically and run through generic self-verifying dispatchers that hold an execution lock. This is what makes the refreshed model catalog and the litellm bump actually reach existing installs on upgrade, instead of being stranded on a stale system Python. Legacy 1.0.26 launchers/schedules are quiesced and neutralized fail-closed during the first upgrade.
- **Post-upgrade model notice.** On the first launch after an update, a one-time notice appears when your saved model was retired (it is migrated to the current same-tier model and the change is made durable) and/or a newer model in your tier is available (with a one-click switch). It never changes a deliberate choice on its own, appears only when there is something to act on, and does not repeat once addressed.

### Changed
- Model catalog refreshed to the current Anthropic, Google, and OpenAI lineups. Default model is now **Claude Sonnet 5** (was Claude Sonnet 4.6). The Settings dropdown now has 20 models across 5 groups: ⭐ Recommended (Claude Sonnet 5, **Claude Opus 5**, Claude Haiku 4.5, **Gemini 3.6 Flash**, Gemini 3.1 Flash Lite, GPT-5.6 Terra, GPT-5.6 Luna), Anthropic (other), Google (other), OpenAI (other), and Advanced — Responses API (GPT-5.3 Codex, GPT-5.5 Pro). Claude Opus 4.8 and Gemini 3.5 Flash remain selectable, moved to their "(other)" groups now that a newer model leads each tier.
- Upgrade suggestions always point at the **current best in tier** rather than the next generation, so a user two generations back moves in one step instead of being walked forward one notice per launch. Claude Opus 4.7 and 4.8 both suggest Claude Opus 5; Gemini 2.5 Flash now suggests Gemini 3.6 Flash, which is the replacement Google names on its deprecations page.
- litellm bumped from 1.83.4 → 1.93.0. Python requirement raised to `>=3.10,<3.15`.

### Fixed
- Selecting or loading a saved retired model ID (e.g. `gpt-5-codex`, `gpt-5.2-codex`, `codex-mini-latest`) now auto-migrates it to the current same-provider equivalent instead of failing, while still-supported older models (e.g. Claude Opus 4.6, Gemini 3 Flash Preview) are left as-is. Provider is always preserved across the migration.
- The automatic model-fallback chain now applies only to Gemini models. Non-Gemini providers no longer fall back across providers on rate limits or errors.

## [1.0.26] - 2026-04-13

### Fixed
- Reopening the progress window during an active sync no longer shows a blank "Waiting for sync to start…" screen. The window now replays the current live state (repos list + per-repo progress from the persisted status file) on mid-sync reopen and continues updating as new progress events arrive. Previously the `did-finish-load` handler early-returned whenever a sync was running, leaving the freshly-loaded renderer with no repo rows and silently dropping every incoming `progress-update`.

## [1.0.24] - 2026-04-09

### Fixed
- Scheduled syncs failing after wake-from-sleep. `wait_for_network` now retries for 5 minutes and requires 3 consecutive successful TCP probes before declaring the network stable, preventing a single lucky handshake from kicking off a sync while DNS/VPN are still warming up.
- "Fetch failed" / "pull failed" errors now capture git's actual stderr (first 8 lines) in the per-run log so you can see *why* the operation failed, not just that it did.

### Added
- OpenAI Responses API routing. GPT-5.x `-codex`, `-pro`, and `-deep-research` variants are now selectable in the model dropdown — the app auto-detects and routes them through `litellm.responses()` while everything else stays on `litellm.completion()`. Previously these models would have failed silently.
- Per-run sync logs at `~/Library/Logs/repo-radar/sync-<timestamp>.log`. One line per meaningful event (no progress bars, no ANSI, no chatter), rotated to the most recent 10 runs. Designed to be easy for an LLM to review.
- SETUP walkthrough step for the "Copy LLM Config" menu action so new installs know how to point Claude Code / AGENTS.md at their pristine repo mirror.

### Changed
- Model dropdown refreshed with a pinned ⭐ Recommended group at the top: Claude Sonnet/Opus 4.6, Claude Haiku 4.5, Gemini 3.1 Pro Preview, Gemini 3.0 Flash Preview, Gemini 3.1 Flash Lite Preview, GPT-5.4, GPT-5.4 Mini, GPT-5.4 Nano. Older models remain available under per-provider "(other)" sections.
- litellm bumped from 1.82.6 → 1.83.4 for upstream bugfixes.
- Stopped writing the duplicate noisy `latest-sync.log` from the menubar process; Python now owns the sync log file.
- `renderer.log` is now sparse — only errors and warnings get persisted (was 130KB of DOM-creation chatter on every run).

### Documentation
- README, SETUP, in-app settings help, and the CLI error message now explicitly call out that Repo Radar needs a **classic** personal access token (not a fine-grained one), and document the self-service SAML SSO authorization step required for org repos.

## [1.0.16] - 2026-04-07

### Fixed
- Scheduled syncs now run in the background instead of popping up the progress window (window still appears on manual sync or if errors occur)
- Sync waits up to 120s for network connectivity after laptop wake, with visible "Waiting for network..." status in the UI
- Network timeout now shows "No network — sync aborted" instead of a confusing "Complete!" with all repos at "Waiting..."

## [1.0.15] - 2026-04-03

### Fixed
- Sync no longer fails when laptop wakes from sleep (waits up to 60s for network connectivity, retries fetches up to 3 times)
- App quits if tray icon fails or disappears, preventing invisible zombie processes that block relaunch
- Cancelling a sync no longer shows a red error icon in the menu bar

## [1.0.11] - 2026-04-02

### Added
- Uninstall menu item and automatic cleanup of orphaned files on launch
- Distinct orange app icon for dev builds
- Dev and production builds can run simultaneously on separate ports

### Fixed
- Sync progress UI errors and LaunchAgent path quoting for paths with spaces
- Auto-updater naming for dev builds
- Status server port passed correctly to Python process for dev builds
- App crash from `isDevBuild` initialization order

## [1.0.4] - 2026-04-01

### Fixed
- UI race condition on scheduled sync startup
- Status icons resize correctly
- Release script handles filenames with spaces in GitHub release uploads

### Added
- Migration guide from Sync Pristine Repos

## [1.0.3] - 2026-03-31

### Added
- Initial public release
- Menubar app with scheduled sync (daily/hourly/weekly)
- AI-powered repository metadata generation (Gemini, Claude, OpenAI)
- Progress UI with per-repo status
- Auto-updater with dev/stable channels
- GitHub organization repository discovery
- Settings UI for API keys, schedule, and model selection
