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
3. The app self-provisions its own Python runtime automatically on first launch — no manual `pip install` needed (see [Python Runtime](#python-runtime) below)
4. Configure via the menubar icon -> Settings

See the [Setup Guide](menubar/SETUP.md) for detailed instructions.

## Configuration

### Required

- **GitHub Token** (`GITHUB_TOKEN`) - Classic personal access token with `repo` scope (not a fine-grained token). If your org uses SAML SSO, authorize the token for the org via "Configure SSO" on the [tokens page](https://github.com/settings/tokens).
- **AI Provider Key** - At least one of:
  - `ANTHROPIC_API_KEY` (default provider)
  - `GEMINI_API_KEY`
  - `OPENAI_API_KEY`

### AI Models

The default model is `claude-sonnet-5` (1M context window). Override in the menubar Settings — the dropdown has 18 models across 5 groups: a pinned "⭐ Recommended" section at the top, an "(other)" section per provider, and an "Advanced — Responses API" section for the higher-cost/latency models.

Pinned recommended models:

| Provider | Models | Context |
|----------|--------|---------|
| Anthropic | **Claude Sonnet 5** (default), Claude Opus 4.8, Claude Haiku 4.5 | 1M / 1M / 200K |
| Google | Gemini 3.5 Flash, Gemini 3.1 Flash Lite | 1M |
| OpenAI | GPT-5.6 Terra, GPT-5.6 Luna | 1M |

Also available: Claude Fable 5, Claude Opus 4.7, Claude Sonnet 4.6 (Anthropic); Gemini 3.1 Pro (Preview), Gemini 2.5 Pro, Gemini 2.5 Flash (Google); GPT-5.6 Sol, GPT-5.5, o3 (OpenAI); GPT-5.3 Codex (400K), GPT-5.5 Pro (Advanced — Responses API, higher cost/latency).

### LLM Integration

To make your AI assistant (Claude Code, etc.) aware of your pristine repos, click the menubar icon -> **Copy LLM Config**. This copies a markdown snippet to your clipboard — paste it into your `CLAUDE.md`, `AGENTS.md`, or `.claude/rules/` file.

## Python Runtime

Repo Radar self-provisions its own Python runtime — no manual `pip install` required. On first launch, the app builds a private, versioned virtual environment under `~/.repo-radar/<channel>/` (`~/.repo-radar/stable/` for release builds, `~/.repo-radar/dev/` for dev builds) from a checked-in, hash-pinned dependency lock, and runs every sync — manual, scheduled, or CLI — through it.

- **Supported interpreters:** CPython **3.10 through 3.14**. The app auto-selects a compatible interpreter already on your machine; it fails closed (no sync) if none is found.
- **Known pre-release limitation:** hash-pinned locks are currently checked in for only a subset of the (Python version, architecture) matrix — see [`resources/pydeps/README.md`](resources/pydeps/README.md). A host whose only available Python lands on an uncovered cell (e.g. Python 3.11 or 3.14, or any x86_64/Intel Mac) will fail provisioning closed until that cell is generated or the supported matrix is narrowed.
- **On-PATH CLI:** once provisioned, the app installs a `repo-radar` (stable) or `repo-radar-dev` (dev builds) command onto your `PATH` (via `~/.local/bin`) so you can run syncs directly from a terminal — see [CLI Usage](#cli-usage).
- **If runtime setup fails** (e.g. offline on first launch, or no supported Python found), sync is disabled and the app surfaces the reason via the tray icon, a notification, and Settings' error log. Relaunching the app retries setup.

See [Setup Guide: First Launch](menubar/SETUP.md#first-launch-automatic-python-runtime-setup) for more detail.

## CLI Usage

Once the app has provisioned the runtime at least once, `repo-radar` (stable) / `repo-radar-dev` (dev builds) is available on your `PATH`:

```bash
# Interactive configuration (discover repos from GitHub)
repo-radar configure

# Sync all configured repos
repo-radar sync

# Sync without metadata generation
repo-radar sync --skip-metadata

# Force regenerate all metadata
repo-radar sync --regenerate-metadata

# Dry run (show what would happen)
repo-radar sync --dry-run

# View status of all repos
repo-radar analyze

# Clean up repos and/or metadata
repo-radar clean

# Show version
repo-radar --version
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
| Python runtime (self-provisioned) | `~/.repo-radar/<channel>/` (e.g. `~/.repo-radar/stable/`) |
| Scheduled sync wrapper | `~/.repo-radar/<channel>/run-sync.sh` |
| CLI on PATH | `~/.local/bin/repo-radar` (stable) / `~/.local/bin/repo-radar-dev` (dev) |
| LaunchAgent | `~/Library/LaunchAgents/com.user.repo-radar.plist` (stable) / `com.user.repo-radar-dev.plist` (dev; only installable once stable is already managed — otherwise use "Sync Now" for dev) |
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
