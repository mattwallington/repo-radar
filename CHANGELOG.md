# Changelog

All notable changes to Repo Radar are documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/).

## [1.0.43] - 2026-11-10

### Added
- **INDEX shows what changed in each repository's latest summary.** A "Latest summary changes" link beside View Details opens the analyzed commit range, when the summary was generated, and the lines added to and removed from its text, or says the text is unchanged when only the analyzed commit moved. It is a local comparison, with no extra model call, and a failed update never replaces it.

## [1.0.42] - 2026-11-09

### Fixed
- **An editor edit that names a section with a list or object is refused like any other bad edit.** The update already failed and kept the current summary, but its reason was an internal type error and the refused edit's shape wasn't saved; now it says the model's edits were rejected and keeps that shape for diagnosis.

## [1.0.41] - 2026-11-09

### Fixed
- **A summary update is no longer refused because the editor labelled a new section.** The editor sometimes gave an inserted section an `id`, as edits of existing sections have, and the whole update failed after its spend. An unused label is now ignored; a label naming an existing section, or a later edit that refers to it, is still refused. The editor is also told not to add one, and a refused update's record keeps the shape of the edit at fault (never its text) so the next failure can be diagnosed.
- **Raising the full-rebuild interval no longer keeps a failed weekly rebuild due.** A weekly rebuild that failed was retried on every sync even after the interval went from 7 to 30 days, say; only turning rebuilds off cleared it. It is now due again only when the new interval is reached, counted from the last successful full build. Until then a changed repository gets an ordinary update, an unchanged one needs nothing, and the failure stays on record. A forced rebuild that failed is still retried.
- **The last note of a large update can go to the editor.** With one note left, the editor's fit check counted the request with its tool definitions and gave up, though that turn is sent without them. It now counts the request that is actually sent, so an update whose note fits it publishes. Merge and editor requests also list the files they cite more compactly, which leaves more room for notes.
- **The first published release comes after 1.0.40, so installed apps update to it.** Automatic releases start at 1.0.41 (Dev at `1.0.41-dev.*`), above the last version built by hand, instead of 1.0.35. No locally built version is published by hand any more, and the remaining links to the old personal repository now point to `ReperioHealth`.

## [1.0.40] - 2026-11-08

### Added
- **A weekly spending limit, on by default at $75.** Before any model call, each summary update or rebuild is admitted for the most it could spend, against what is left this week for stable and dev builds together. An update that doesn't fit is skipped and the current summary is kept; it doesn't count as a failure. Settings can change the amount ($1 to $1,000) or turn the limit off, which still records spending. Settings also shows this week's recorded spend, what is reserved or uncertain, and what is left. Weeks reset on Monday 00:00 UTC, and the first one starts with the first sync on this version. Stopping a sync releases what its updates didn't use, except requests already sent. Older builds aren't limited and their spending isn't counted, so both apps need this version.

### Changed
- **Every repository's summary is now built the same way.** Repositories not opted in to incremental summaries used to have a separate generator; they now go through the same worker and full-rebuild steps as the rest, and are still rebuilt in full only when their tracked source changes. A rebuild reads the commit it is labelled with, so uncommitted or untracked files can't end up in the summary. It uses the same credential exclusions and the same 128,000-token requests, chunks and reductions as other full rebuilds. Before its first call it is admitted for its own estimate, at most $40 and enough for its largest request on top of the others' estimated cost, and nothing is topped up once sending starts. A refused rebuild keeps the current summary. The old generator's automatic retries, model fallbacks and shortened "degraded" summaries are gone: a failed or cut-off reply keeps the current summary. Two failed rebuilds in a row now pause automatic updates for that repository until Sync Now or a forced rebuild, as for opted-in repositories, and a missing API key is reported as a failed update rather than skipped quietly. These repositories don't gain a weekly rebuild. Existing summaries are kept and used as they are until their source changes, with nothing bought to adopt them. Wording and emphasis of rebuilt summaries may change.
- **Opted-in full rebuilds send smaller requests and are capped at $40.** Every full-rebuild request, whether the whole repository, a chunk or the final reduction, now fits 128,000 input tokens. A file too large for one chunk is split into ordered parts rather than cut short, and if a rebuild can't fit or can't finish its reduction, it stops and keeps the old summary instead of summarizing excerpts. Each rebuild attempt stops before a request that could take its spending past $40. On Gemini, whose token counts are local estimates, each request is priced as if it used the model's whole input limit. It limits one attempt rather than promising a rebuild finishes within it.
- **Chunk analyses cover all eight summary subjects.** Each chunk is now asked about architecture, database schema and configuration as well as the overview, technology stack, components, interfaces and dependencies, and to say "not present here" when its files don't cover a subject.
- **Incremental updates keep 1.0.38's editor fix on the shared pipeline.** The editor's first request is still prepared to fit 65,536 tokens and later requests may use up to 128,000, the quote covers that, and a request refused after anything was paid for counts as a failure.

### Removed
- **The unused manual installer (`setup.sh`) is gone** from the app bundle and the setup guide. The app provisions its own Python runtime, as before.
- **`release.sh` no longer carries its old publishing steps.** Releases publish from GitHub Actions; the script still runs its gates, and its `--dry-run` works as before.

### Fixed
- **Settings refuses a sync schedule that can't run, under the field at fault.** A weekly schedule with no days, a missing time, or an interval that isn't a whole number from 1 to 24 hours now shows an error under that field, and nothing is saved. Before, an empty time was saved as 9:00 and an out-of-range interval was saved as typed. The weekly spending record also keeps only its last five weeks now, so it no longer grows without limit.
- **Download links point to `ReperioHealth/repo-radar-releases`,** where releases are published.
- **A source folder named `coverage`, `vendor` or `dist` is analyzed.** Full rebuilds and incremental updates treated any folder with one of those names as build output and left it out, so a real module (an insurance `coverage` folder, say) was never summarized. Now those names count as build output only at the repository root or next to a build file such as `package.json` or `go.mod`.
- **One malformed note no longer fails a whole summary update.** A page's note that named summary sections it wasn't given used to stop the update after its pages had been paid for. Those references are now dropped and the change is kept without a section; the whole note is used, the drops are counted in the attempt's usage, and the coverage note says so. A resource limit hit after paid calls, such as an unreadable page spool, now counts as a failed update rather than a skip.
- **The editor's answer is no longer refused for how it's wrapped.** A paid update could stop with "the answer is not a JSON object" when the model put its edits in a code fence or added a few words around them. One JSON object in the reply is now taken as the answer and checked as before; a reply with none, or with several, is still refused. A one-note update's tool-free request also asks Gemini for JSON. When an answer is refused, the start of the reply, with secrets redacted, is kept in the attempt's record so the failure can be diagnosed.

## [1.0.38] - 2026-11-08

### Added
- **Settings has a Spending section.** It sets the incremental update limit (default $12; $1 to $100, in dollars and cents) and how many failures in a row pause automatic metadata for a repository (default 2; 1 to 10). The next sync uses the new values, with no restart. Changing the failure number doesn't clear a repository's count: raising it can release a hold and lowering it can hold sooner. A value Settings can't accept saves nothing and points at the field. A missing or invalid value in the config file is treated as the default, never as no limit.

### Changed
- **A missing API key no longer counts toward the failure pause.** The update is still reported as failed, but setting the key isn't followed by a hold that only Sync Now can lift.
- **Saving Settings in the dev build reports success when it succeeded.** It used to say the save failed because the dev build can't install a schedule, even though everything else had been saved. The dev build still leaves the stored schedule as it is, and says so when the window asked for a different one.
- **The command-line `configure` wizard keeps your other settings.** It used to rewrite the config with only the token and repositories, dropping API keys, the model, the schedule and the spending limits.

### Fixed
- **A long summary update no longer fails on the editor's second turn.** The editor's first reply can carry hidden data from the model that has to be sent back with the next request, so that request could be much larger than the reply looked, and updates stopped at the 65,536-token limit after paying for every page. The first editor request is still prepared to fit 65,536 tokens, but later requests may now use up to 128,000, and the update's quote before any model call covers that. The $12 limit is unchanged. A request still too large stops before it is sent, keeps the old summary and counts as a failure.

## [1.0.37] - 2026-11-07

### Changed
- **Incremental summaries now scale to any diff.** The model used to read a whole diff within 16 turns, which made long diffs fail expensively. Now each page of the diff gets one short model call, the notes are merged when there are too many to hand over, and one short conversation edits the summary. A large change is no longer a reason for a full rebuild: the 20%, eight-page and 16 MiB rules are gone. Lockfiles, generated files and diffs over 2 MiB are listed as not analyzed rather than summarized. Any failure keeps the previous summary, with no retries and no automatic full rebuild. A note that cites a file by its path, or cites one it wasn't shown, no longer stops the update: the path becomes the file's id, anything else is dropped, and the summary says when file attribution is incomplete. A full rebuild left unfinished only because of a removed rule is no longer owed.
- **Repeated failures stop spending until a person retries.** After 2 failed updates in a row, incremental or full, scheduled and other automatic syncs make no model call for that repository, even when a weekly rebuild is due, so a failing full rebuild can't repeat about $20 a day. The update is reported as skipped, and the old summary stays marked stale in `INDEX.md`. The menu's Sync Now or `--regenerate-metadata` tries once more, and a publication clears the hold. Skipped updates don't count.
- **Opted-in full rebuilds on Gemini ask for low thinking, and a failure says where it stopped.** Thinking shares the output limit, and a rebuild had been rejected for an incomplete reply without saying which call. Chunk, synthesis and single-pass calls now request low thinking, with their limits unchanged at 8,192 and 16,384 tokens. That makes truncation less likely but doesn't rule it out: a truncated reply is still rejected with no retry. The failure reason and attempt usage now name the stage, call and chunk, the output limit, the finish reason and the output token counts.
- **The incremental spending limit is now $12 per update, up from $8,** and the whole update is quoted against it before the first model call. A quote over the limit stops the update with nothing sent. Gemini is now priced at its Standard tier, which is what these requests get, and at Google's announced January 2027 price for Gemini 3.8 Flash and the flash-latest alias. Other providers keep their higher tiers in the bound.
- **Credentials moved within very large changes stay withheld.** Git's rename detection stopped looking once a change had too many files, so an edited credential moved within a huge restructure could reach a model. An edited copy of a credential that itself didn't change wasn't detected either. Both are detected now, as is anything else Git sees as a rename or copy of a protected file. This is detection by similarity, not a scan for secret content. That search can be long, so it now stops at the update's 20-minute limit, and the document is kept rather than building protection from a partial list.

### Added
- **`incremental_full_rebuild_days` sets how often an opted-in repository gets a full rebuild.** The default is still 7, and 0 turns the age trigger off. A malformed value stops a metadata sync before any work.
- **The progress view shows how far a long summary update has got.**
- **The telehealth pilot can replay historical changes from a manifest,** with a free `plan` mode that reports each case's pages and quote.

## [1.0.36] - 2026-11-04

### Fixed
- **Long diffs go straight to a full summary rebuild.** An incremental summary update had to read its whole diff within 16 model turns, so a long diff ran out of turns, spent money and failed, and every later sync repeated it until the weekly rebuild. When the filtered diff is over 8 pages (or over the 16 MiB diff limit), Repo Radar now chooses a full rebuild before making any model call. The other limits are unchanged, and a failed incremental update still isn't followed by an automatic full rebuild.
- **A finished sync with errors no longer says "Sync failed".** When every repository was processed and some had errors, the progress window and tray tooltip now say so, for example "Sync finished — 1 repo had an error (see ⚠️ View Errors)", in amber. "Sync failed" is kept for a sync that didn't complete.
- **Check for Updates shows a short message when it fails.** The dialog used to show the raw HTTP response, including headers and cookies. When the update feed isn't there it now says "In-app updates aren't set up yet. Install updates manually.", and any other failure gets one short line.

## [1.0.35] - 2026-11-03

### Added
- **Incremental summaries for selected repositories.** Repositories listed in `incremental_metadata_repos` have their summary updated from the Git diff, with read-only access to the surrounding source, instead of being regenerated on every change. A full rebuild still runs weekly, after a large change, or when the model or policy changes. Each update is capped at $8, a failed one keeps the previous summary, and credential files are never sent. It's off unless you list a repository. See `docs/incremental-metadata.md`.
- **A release workflow for `ReperioHealth/repo-radar-releases`.** GitHub Actions can build, sign and notarize a new version, DMGs included, when `main` (Repo Radar) or `dev` (Repo Radar Dev) changes, and publish it with its update feed. Repo Radar Dev keeps its own update download cache.

### Fixed
- **Temporary model server errors are retried on the same model,** with no change of model. Connection failures aren't treated as server errors.
- **Costs of completed model calls are kept** when metadata generation fails afterwards.
- **Activity History counts are accurate.** Each sync failure counts once, completion summaries no longer count as warnings, and the legacy list shows only logs from before Activity History.

## [1.0.34] - 2026-10-29

### Fixed
- **Sync blocked after Homebrew's default Python moved to 3.15.** When Homebrew updated its default `python3` past the supported range, the app could no longer find a usable Python to rebuild its runtime, so every sync — manual and scheduled — was blocked. It now also looks for the versioned Homebrew Pythons (3.14 down to 3.10), so relaunching the app rebuilds the runtime from one that is still installed.
- **Blocked syncs now show why.** Selecting an attempt in Activity History that was blocked before it recorded any events opens it on Problems, where its reason is shown, instead of an empty Events list. You can still switch to Events.
- **Claude metadata is skipped, not sent, when its size can't be verified.** Repo Radar checks each Claude prompt with Anthropic's token count before sending it. If that count became unavailable partway through, after it had already found a file or chunk too large, Repo Radar sent the unverified prompt anyway, which could exceed the model's window. It now skips that repository's metadata for this sync with a warning: the previous metadata stays, and the repository is retried on the next sync. Other providers are unchanged.
- **INDEX.md lists every repository again.** Metadata files written before `parse_status` existed made index regeneration fail with "name '_FRAGMENT_PREFIXES' is not defined", so each was left out (one sync listed 13 of 30 repos). They're indexed again, with a leaked-fragment summary marked as degraded.

### Changed
- **OpenAI's October retirements handled.** OpenAI shut down `gpt-4.1-nano`, `o4-mini`, `o1`, `o3-mini` and `o1-pro` on October 23, 2026. A saved selection of one of these now runs on the newest model of its own tier: GPT-6 Luna for `gpt-4.1-nano`, GPT-6.1 Terra for `o4-mini` and `o3-mini`, GPT-6.1 Sol for `o1`, and GPT-5.5 Pro for `o1-pro`. On the stable channel the app shows a notice naming the replacement, with Review Models to pick something else.
- **Gemini 2.5 Pro, Flash and Flash-Lite stay selectable.** Google has not deprecated them or set a shutdown date, so the October 16 dates recorded earlier were wrong and have been removed. Existing selections keep working unchanged.
- **Upcoming shutdowns recorded.** Claude Sonnet 4.5 retires November 30, 2026. GPT-5, GPT-5 mini and nano, o3 and o3-pro shut down December 11, 2026. GPT-4.1, GPT-4.1 mini, GPT-4o and GPT-4o mini shut down January 14, 2027. GPT-5.1, GPT-5.3-codex and GPT-5.4 nano retire April 1, 2027, and Gemini 3.1 Flash-Lite no earlier than May 7, 2027. They stay selectable until then.
- **Signed by Reperio Health.** Builds are now signed with Reperio Health's Apple Developer ID (team F8UY7565VM) and notarized through its `reperio-notary` keychain profile, and they check for updates at `ReperioHealth/repo-radar-releases`. Copies signed by the earlier personal team can't update to these builds automatically, so replace each installed app once by hand; settings, mirrors and runtime are kept. The new `build-local.sh` builds and verifies a signed app without publishing it, and stops if notarization was skipped. Publishing with `release.sh` is paused until the update feed moves to `ReperioHealth/repo-radar-releases`, because it would still publish to the old feed; `--dry-run` still runs its gates. See README, "Building a signed app locally".
- **Releases run their model gates in a dedicated release environment.** `release.sh` now requires `REPO_RADAR_RELEASE_PYTHON` and checks that venv against the checked-in dependency lock before anything else. See README, "Preparing a release".
- **New default model: Claude Sonnet 5.5.** New installs, and installs that never picked a model, use it. A model you picked yourself stays selected; if a newer model of the same kind exists, you're offered it once.
- **Retired models move to the newest model of the same kind.** A retired model now always lands on the newest model of its own provider, family and tier, for example any older Gemini Flash to Gemini 3.8 Flash, or any older Claude Sonnet to Sonnet 5.5. It is never moved to a different tier or provider. This corrects a few earlier routes: `o3-mini` and `o1-mini` now go to GPT-6.1 Terra (not a flagship model), and `o1-pro` goes to GPT-5.5 Pro.
- **Gemini fallback** under rate limits is now Gemini 3.8 Flash, then Gemini 3.5 Flash-Lite.
- **Gemini 4 Argon** always reserves at least 32,768 output tokens, as Google recommends, because its thinking shares the output budget.
- **The new Claude models think at medium effort, with more room to answer.** Claude Sonnet 5.5, Opus 5.5, Haiku 5.5 and Fable 5.1 keep their built-in thinking, but Repo Radar asks for medium effort, and each request reserves at least 16,384 output tokens, since thinking shares that budget. Chunk analyses rise from 8,192; summaries already used 16,384. This raises the maximum output per call, not necessarily what's spent, and it's a conservative starting policy, not a vendor requirement. Other models are unchanged.
- **A blank or cut-off Claude reply now stops that repository with an error** instead of being saved as its analysis. Nothing is retried automatically.

### Added
- **Current models from all three providers.** Claude Sonnet 5.5, Opus 5.5, Haiku 5.5 and Fable 5.1; GPT-6.1 Sol and Terra, GPT-6 Sol, Luna and Astra; Gemini 3.8 Flash, 3.5 Flash-Lite and 4 Argon. Their limits were checked against each vendor's own pages. Settings has a new "Higher capability" group for Fable, Astra and Argon.

### Security
- **LiteLLM upgraded from 1.93.0 to 1.105.6.** 1.93.0 is inside the affected range of CVE-2026-84377, an authenticated SSRF in LiteLLM's proxy server (1.89.0 through 1.96.1, fixed in 1.96.2). Repo Radar uses only the LiteLLM SDK, never the proxy, but the pin is now outside that range. Releases from 1.106.0 on aren't used: they break GPT Pro and Codex sends unless the proxy's `mcp` package is installed. What has been verified for 1.105.6: its eight PyPI files were uploaded October 27, 2026 at 19:42 UTC and aren't yanked, and their SHA-256 hashes are exactly the ones in all ten dependency locks. All 2,693 Python files in the installed wheel are byte-identical to LiteLLM's `v1.105.6` source tag (commit `3a05120f`); the tag has one extra benchmark test file. What can't be verified: the wheel's compiled Rust extension can't be checked against source, and the tag is controlled by the same project owners, so the comparison isn't independent evidence. LiteLLM reports that an attacker had owner-level access from October 10, 2026. 1.105.6 was published after LiteLLM's reported recovery, but no version-specific all-clear has been published for it or any other release.

## [1.0.32] - 2026-09-01

### Fixed
- **Progress window stuck on "Starting sync…".** When Sync Now was refused because another sync already held the lock (for example right after an auto-update), or the sync failed before its process could start, the progress window opened and then sat on "Starting sync…" forever. It now says "Not started — another sync is already running" or "Sync could not start — see ⚠️ View Errors in the menu", and the attempt is recorded in Activity History either way.

## [1.0.31] - 2026-09-01

### Added
- **Activity History (Phases 1–5).** Durable per-attempt sync history, with a context-isolated Activity window (tray → 🗒 Activity), Events / Problems lenses, a System diagnostics section, redacted export, and a never-empty View Errors deep link. It replaces the Sync Errors window: Clear Errors is gone, and the error icon now clears on the next successful sync. Pre-existing `sync-*.log` files now show up as opaque "legacy" items, never correlated to durable activities, and exports note when legacy logs are omitted. Automatic retention now runs at app start and after every sync: routine activities older than 14 days and problem activities older than 90 days are deleted, with the newest 50 activities protected from that age-based deletion. The 64 MiB history ceiling overrides that protection — if history is over the ceiling it prunes within the newest 50 as well, always keeping the newest problem activity.

### Fixed
- **GPT-5.6 Sol / Terra / Luna input limits.** The catalog recorded the models' 1,050,000-token *total* context as their *input* window; corrected to the real 922,000 (total minus the 128,000 output reservation), caught by the release-time model-window gate.

## [1.0.30] - 2026-08-12

### Changed
- **Authoritative token counting for Claude.** Metadata generation now preflights each prompt through Anthropic's Count-Tokens endpoint and accepts, splits, or (for a single oversized item) trims it against the model's *real* window — replacing the conservative multiplier added in 1.0.29. When an authoritative count isn't available (non-Anthropic models, provider errors, or transient failures) it falls back to the existing safe behaviour, so it is never less safe than before, and a batch that still can't fit is only ever split further — never silently merged past what fits. A repository that genuinely cannot be summarised is recorded as a visible `degraded` entry instead of failing quietly.

### Added
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
