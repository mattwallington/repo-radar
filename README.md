<p align="center">
  <img src="menubar/assets/icon-app-256.png" width="128" height="128">
</p>

<h1 align="center">Repo Radar</h1>

Maintain pristine, read-only mirrors of GitHub repositories with AI-powered metadata for efficient context discovery.

Repo Radar clones your configured repos into `~/repos-pristine/` (configurable), keeps them up to date, and generates structured LLM-powered metadata files (`.md`) that serve as a semantic index for AI assistants and developers.

## Features

- **Automated sync** of GitHub repositories on a configurable schedule (with network-aware retries after sleep)
- **AI-powered metadata** generation using 60+ models from Anthropic, Google, and OpenAI
- **macOS menubar app** with progress tracking, settings UI, and scheduling
- **Auto-updates** — the app checks for new versions and offers one-click updates
- **Copy LLM Config** — one-click copy of the config snippet for CLAUDE.md / AGENTS.md
- **Smart chunking** for large repos with model-aware context window management
- **Rate limit handling** with automatic fallback and UI display
- **Clean uninstall** — tray menu option to remove all config, logs, and scheduled tasks

## Install

Download the latest release from [GitHub Releases](https://github.com/mattwallington/repo-radar/releases):

| Mac Type | Download |
|----------|----------|
| Apple Silicon (M1-M4) | `repo-radar-*-arm64-mac.zip` or `.dmg` |
| Intel | `repo-radar-*-x64-mac.zip` or `.dmg` |

1. Unzip and drag **Repo Radar.app** to `/Applications`
2. Open it from Applications
3. The app runs first-time setup automatically (installs Python dependencies)
4. Configure via the menubar icon -> Settings

See the [Setup Guide](menubar/SETUP.md) for detailed instructions.

## Configuration

### Required

- **GitHub Token** (`GITHUB_TOKEN`) - Personal access token with `repo` scope
- **AI Provider Key** - At least one of:
  - `ANTHROPIC_API_KEY` (default provider)
  - `GEMINI_API_KEY`
  - `OPENAI_API_KEY`

### AI Models

The default model is `claude-sonnet-4-6` (1M context window). Override in the menubar Settings.

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

## Uninstall

To fully remove Repo Radar:

1. Click the menubar icon -> **Uninstall...** (removes config, logs, and scheduled tasks)
2. Drag the app from `/Applications` to the Trash

Your synced repositories are **not** deleted.

## Config & Data Locations

| What | Path |
|------|------|
| App config | `~/.config/repo-radar/config.json` |
| Sync status | `~/.config/repo-radar/status.json` |
| Scheduled sync wrapper | `~/.config/repo-radar/run-sync.sh` |
| LaunchAgent | `~/Library/LaunchAgents/com.user.repo-radar.plist` |
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

## Contributing

See [DEVELOPMENT.md](DEVELOPMENT.md) for development setup, architecture, release process, and the dev branch workflow.

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

MIT
