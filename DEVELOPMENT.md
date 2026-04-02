# Development

## Setup

```bash
# Clone
git clone https://github.com/mattwallington/repo-radar.git
cd repo-radar

# Install Python deps
pip3 install -r requirements.txt

# Run the CLI directly
./repo-radar help

# Run tests
python -m pytest repo_radar/tests/ -v

# Run the menubar app in dev mode
cd menubar
npm install
npm run dev
```

## Architecture

```
repo-radar/
├── repo-radar                 # Python CLI entry point
├── repo_radar/                # Python package
│   ├── cli.py                 # Argument parsing, mode dispatch
│   ├── config.py              # Paths, load/save config
│   ├── git.py                 # Git operations
│   ├── files.py               # File collection and filtering
│   ├── llm.py                 # Model config, chunking, rate limiting
│   ├── metadata.py            # Response parsing, index generation
│   ├── ui.py                  # Help text, formatting, status updates
│   ├── modes/                 # CLI modes (configure, sync, analyze, clean)
│   └── tests/                 # Unit tests
├── VERSION                    # Single source of truth for version
├── requirements.txt           # Python dependencies (litellm pinned)
├── release.sh                 # Build + sign + notarize + release workflow
└── menubar/                   # Electron menubar app
    ├── main.js                # Main process (tray, scheduling, IPC)
    ├── entitlements.plist     # macOS hardened runtime entitlements
    ├── renderer/              # UI (progress, settings, errors)
    ├── resources/             # Bundled script + setup
    └── package.json           # Electron build config
```

**How it works:**
1. The Electron menubar app spawns `python3 repo-radar sync --status-server`
2. The Python script handles git operations, GitHub API discovery, and LLM metadata generation
3. Progress updates flow back to the menubar via HTTP POST to a local Express server (port 3847, or 3848 for dev builds)
4. Generated metadata and an `INDEX.md` are written to `~/repos-pristine/`

## Releasing

Releases are managed via `release.sh`, which handles versioning, building, signing, notarizing, and publishing to GitHub Releases. The app includes auto-update — existing users are prompted when a new version is available.

```bash
# Patch release (default, no args needed)
./release.sh

# Minor release (1.0.5 -> 1.1.0)
./release.sh --minor

# Major release (1.0.5 -> 2.0.0)
./release.sh --major

# Dry run (show what would happen)
./release.sh --dry-run

# Help
./release.sh --help
```

The script will:
1. Bump the version in `VERSION`, `package.json`, and `package-lock.json`
2. Commit and tag
3. Build the Electron app for arm64 + x64
4. Sign with Developer ID and notarize with Apple
5. Push and create a GitHub Release with artifacts attached

### Requirements for signing/notarization

- Developer ID Application certificate in Keychain
- Environment variables:
  - `APPLE_ID` — your Apple ID email
  - `APPLE_APP_SPECIFIC_PASSWORD` — generated at [appleid.apple.com](https://appleid.apple.com)
  - `APPLE_TEAM_ID` — your Apple Developer team ID

## Dev Branch

The `dev` branch builds a separate **Repo Radar Dev** app that can run alongside production:

- Separate app ID (`com.mattwallington.repo-radar-dev`) and orange icon
- Releases are created as GitHub pre-releases
- Auto-updater only checks pre-releases (doesn't affect production users)
- Uses port 3848 for status updates (production uses 3847)

```bash
git checkout dev
# make changes, commit
./release.sh          # builds "Repo Radar Dev", creates pre-release

# when ready for production:
git checkout main
git merge dev
./release.sh          # builds "Repo Radar", creates stable release
```
