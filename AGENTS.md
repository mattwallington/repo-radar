# Agents Instructions

## Changelog

This repo maintains a `CHANGELOG.md` file. Whenever a new version is released (dev or production), update `CHANGELOG.md` with the changes included in that release before committing the release.

### Format

Follow [Keep a Changelog](https://keepachangelog.com/) conventions:

- Group changes under the version header with the date
- Use categories: `Added`, `Changed`, `Fixed`, `Removed` as applicable
- Write entries from the user's perspective (what changed, not implementation details)
- Most recent version at the top

### Example

```markdown
## [1.0.16] - 2026-04-05

### Fixed
- Sync no longer fails when laptop wakes from sleep (waits for network)
```

## Releases

- Releases publish from GitHub Actions (`.github/workflows/desktop-release.yml`) to `ReperioHealth/repo-radar-releases`: a push to `dev` publishes a Repo Radar Dev prerelease, a push to `main` publishes Repo Radar as Latest. See "Releasing" in DEVELOPMENT.md.
- The workflow picks the version. Release notes link the source changes since the previous release of that channel and `CHANGELOG.md` at the release commit, so update the changelog in the same PR as the change. Never commit a version bump.
- `release.sh` publishing is paused. `build-local.sh` builds and verifies a signed app without publishing.
- Always test on dev first, then merge to main for production
