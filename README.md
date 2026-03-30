# Repo Radar

Maintain pristine, read-only mirrors of GitHub repositories with AI-powered metadata for efficient context discovery.

Repo Radar clones your configured repos into `~/repos-pristine/` (configurable), keeps them up to date, and generates structured LLM-powered metadata files (`.md`) that serve as a semantic index for AI assistants and developers.

## Features

- **Signed and notarized** — download, install, and run with no Gatekeeper warnings
- **Automated sync** of GitHub repositories on a configurable schedule
- **AI-powered metadata** generation using 60+ models from Anthropic, Google, and OpenAI
- **macOS menubar app** with progress tracking, settings UI, and scheduling
- **Copy LLM Config** — one-click copy of the config snippet for CLAUDE.md / AGENTS.md
- **CLI mode** for standalone or scripted use
- **Smart chunking** for large repos with model-aware context window management
- **Rate limit handling** with automatic fallback and UI display

## Install

### Menubar App (recommended)

Download the latest release from [GitHub Releases](https://github.com/mattwallington/repo-radar/releases):

| Mac Type | Download |
|----------|----------|
| Apple Silicon (M1-M4) | `Repo-Radar-*-arm64-mac.zip` or `.dmg` |
| Intel | `Repo-Radar-*-x64-mac.zip` or `.dmg` |

1. Unzip and drag **Repo Radar.app** to `/Applications`
2. Open it — the app is signed and notarized, no workarounds needed
3. The app runs first-time setup automatically (installs Python dependencies)
4. Configure via the menubar icon -> Settings

See the [Setup Guide](menubar/SETUP.md) for detailed instructions.

### CLI Only

```bash
# Clone the repo
git clone https://github.com/mattwallington/repo-radar.git
cd repo-radar

# Install Python dependencies
pip3 install -r requirements.txt

# Run directly
./repo-radar help
```

## Configuration

### Required

- **GitHub Token** (`GITHUB_TOKEN`) - Personal access token with `repo` scope
- **AI Provider Key** - At least one of:
  - `ANTHROPIC_API_KEY` (default provider)
  - `GEMINI_API_KEY`
  - `OPENAI_API_KEY`

### AI Models

The default model is `claude-sonnet-4-6` (1M context window). Override with the `AI_MODEL` environment variable or in the menubar Settings.

Supported models include:

| Provider | Models | Context |
|----------|--------|---------|
| Anthropic | **Claude Sonnet 4.6**, Claude Opus 4.6, Haiku 4.5, and older | Up to 1M tokens |
| Google | Gemini 3.1 Pro, 3.0 Pro/Flash, 2.5 Pro/Flash | 1M tokens |
| OpenAI | GPT-5.4/Pro (1M), GPT-5.x, Codex, GPT-4.1/4o, o1/o3/o4 | 128K-1M tokens |

### LLM Integration

To make your AI assistant (Claude Code, etc.) aware of your pristine repos, click the menubar icon -> **Copy LLM Config**. This copies a markdown snippet to your clipboard — paste it into your `CLAUDE.md`, `AGENTS.md`, or `.claude/rules/` file.

## CLI Usage

```bash
# Interactive configuration (discover repos from GitHub)
./repo-radar configure

# Sync all configured repos
./repo-radar sync

# Sync without metadata generation
./repo-radar sync --skip-metadata

# Force regenerate all metadata
./repo-radar sync --regenerate-metadata

# Dry run (show what would happen)
./repo-radar sync --dry-run

# View status of all repos
./repo-radar analyze

# Clean up repos and/or metadata
./repo-radar clean

# Show version
./repo-radar --version
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
│   └── tests/                 # 33 unit tests
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
3. Progress updates flow back to the menubar via HTTP POST to a local Express server (port 3847)
4. Generated metadata and an `INDEX.md` are written to `~/repos-pristine/`

## Development

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

## Releasing

Releases are managed via `release.sh`, which handles versioning, building, signing, notarizing, and publishing to GitHub Releases.

```bash
# Patch release (1.0.1 -> 1.0.2)
./release.sh patch

# Minor release (1.0.1 -> 1.1.0)
./release.sh minor

# Major release (1.0.1 -> 2.0.0)
./release.sh major

# Dry run (show what would happen)
./release.sh --dry-run patch
```

The script will:
1. Bump the version in `VERSION` and `menubar/package.json`
2. Commit and tag
3. Build the Electron app for arm64 + x64
4. Sign with Developer ID and notarize with Apple
5. Push and create a GitHub Release with artifacts attached

**Requirements for signing/notarization:**
- Developer ID Application certificate in Keychain
- `APPLE_ID` and `APPLE_APP_SPECIFIC_PASSWORD` environment variables set
- `APPLE_TEAM_ID` passed to the build (or set in env)

## Config & Data Locations

| What | Path |
|------|------|
| App config | `~/.config/repo-radar/config.json` |
| Sync status | `~/.config/repo-radar/status.json` |
| Synced repos | `~/repos-pristine/` (default) |
| Logs | `~/Library/Logs/repo-radar/` |

### Custom repos directory

Set `repos_dir` in your `config.json` to change where repos are synced:

```json
{
  "repos_dir": "~/.repos-pristine",
  "strip_prefixes": ["myorg-"]
}
```

## License

MIT
