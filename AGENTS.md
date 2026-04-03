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

- Dev releases go out on the `dev` branch via `./release.sh` (creates pre-release)
- Production releases go out on `main` via `./release.sh` (creates stable release)
- Always test on dev first, then merge to main for production
