# Quick Setup Guide

## Installation (5 minutes)

### 1. Download & Install

Download the latest release for your Mac from [GitHub Releases](https://github.com/mattwallington/repo-radar/releases):
- **Apple Silicon (M1/M2/M3/M4)**: `Repo-Radar-*-arm64.zip`
- **Intel Mac**: `Repo-Radar-*-x64.zip`

Then:
1. Unzip the downloaded file
2. Drag "Repo Radar.app" to your Applications folder
3. Open it from Applications (or use Spotlight: Cmd+Space, type "Repo Radar")

**First time opening**: The app is not yet notarized with Apple, so macOS will block it. Run this once in Terminal to allow it:
```bash
xattr -cr "/Applications/Repo Radar.app"
```
Then open it normally.

### 2. Get Your API Keys

You'll need a GitHub token and at least one AI provider key:

#### GitHub Token (required)
1. Visit: https://github.com/settings/tokens/new
2. Name it: "Repo Radar"
3. Check the box for: `repo` (Full control of private repositories)
4. Click "Generate token" at the bottom
5. **Copy the token** (starts with `ghp_...`)

#### Anthropic API Key (default AI provider)
1. Visit: https://console.anthropic.com/settings/keys
2. Create an API key
3. **Copy the key**

### 3. Configure the App

Look for the circular icon in your menu bar (top right).

Click it -> **Settings**

**API Configuration:**
1. Paste your GitHub Token (from step 2)
2. Paste your Anthropic API Key (from step 2)
3. Select your preferred AI Model (Claude Sonnet 4.6 is the default)

**Repository Configuration:**
1. Click "Add Repository"
2. Enter repository details (or let it auto-discover from GitHub)
3. Add all repos you want to sync

**Schedule Configuration:**
- Daily at 9:00 AM (recommended)
- Or choose Hourly/Weekly

Click **"Save"** to save all settings.

### 4. First Sync

Click the menu bar icon -> **Sync Now**

Your repositories will be cloned to `~/repos-pristine/` by default (configurable via `repos_dir` in config.json).

## Daily Use

- **Auto-sync**: Happens automatically at your scheduled time
- **Manual sync**: Click menu bar icon -> "Sync Now"
- **View progress**: Click menu bar icon -> "View Progress"
- **View repos**: `open ~/repos-pristine/`

## AI Model Options

The app supports multiple AI models for metadata generation. Set via Settings or the `AI_MODEL` environment variable.

**Anthropic Claude (Default):**
- **Claude Sonnet 4.6 (1M context)** - Default. Excellent quality with massive context window
- **Claude Opus 4.6 (1M context)** - Highest quality, 1M context
- Claude Haiku 4.5 - Fast and efficient
- Requires: `ANTHROPIC_API_KEY`

**Google Gemini:**
- Gemini 3.0 Pro/Flash - 1M token context
- Gemini 2.5 Pro/Flash - Previous generation
- Requires: `GEMINI_API_KEY`

**OpenAI:**
- **Codex (gpt-5.3-codex)** - Code-optimized model
- GPT-4o / GPT-4o Mini
- o1-preview / o1-mini
- Requires: `OPENAI_API_KEY`

## Troubleshooting

**"Command not found" or Python errors:**
```bash
pip3 install litellm==1.82.6 requests inquirer rich
```

**App doesn't appear in menu bar:**
- Check Applications -> Repo Radar is running
- Try quitting and reopening

**Sync fails:**
- Verify your GitHub token: https://github.com/settings/tokens
- Verify your API key for the selected model
- Check Settings -> View the error logs

## Uninstalling

1. Quit the app: Click menubar icon -> "Quit"
2. Delete from Applications: Drag "Repo Radar" to Trash
3. Remove data (optional):
   ```bash
   rm -rf ~/.config/repo-radar
   rm -rf ~/.repo-radar
   rm -rf ~/repos-pristine
   ```

## Need Help?

File an issue at https://github.com/mattwallington/repo-radar/issues.
