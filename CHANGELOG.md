# Changelog

All notable changes to Repo Radar are documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/).

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
