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

Repo Radar needs a **classic personal access token** — *not* a fine-grained token. Fine-grained tokens have to be approved by an org admin before they'll work and don't return org repos from the `/user/repos` API that Repo Radar uses for discovery.

1. Visit: https://github.com/settings/tokens/new (this is the "Tokens (classic)" page — make sure the URL ends in `/tokens/new`, not `/tokens?type=beta`)
2. Name it: "Repo Radar"
3. Check the box for: `repo` (Full control of private repositories)
4. Click "Generate token" at the bottom
5. **Copy the token** (starts with `ghp_...`)
6. **If your organization uses SAML SSO**, you'll see a "Configure SSO" button next to the new token on the token list page. Click it, pick your org, and click "Authorize" — without this step the token will silently return 404s for org repos. This is self-service and doesn't need admin approval.

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

### 5. Tell your AI assistant where the repos live

So Claude Code (or any other AI assistant you use) can actually take advantage of the pristine mirrors, point it at them.

1. Click the menu bar icon -> **Copy LLM Config**
2. Paste the snippet into one of:
   - `~/.claude/CLAUDE.md` (global, applies to every Claude Code session)
   - `~/.claude/rules/` (global rules directory — one file per topic)
   - A project's `CLAUDE.md` / `AGENTS.md` (per-repo)

The snippet tells the assistant where `~/repos-pristine/` is, how to read the `INDEX.md` file to discover related repos, and the metadata workflow for pulling in cross-repo context without reading full source trees.

## Daily Use

- **Auto-sync**: Happens automatically at your scheduled time
- **Manual sync**: Click menu bar icon -> "Sync Now"
- **View progress**: Click menu bar icon -> "View Progress"
- **View repos**: `open ~/repos-pristine/`

## AI Model Options

Set via Settings or the `AI_MODEL` environment variable. The Settings dropdown groups models into "⭐ Recommended" (the current picks) and a longer list of older-but-still-usable options.

**⭐ Recommended — Anthropic Claude:**
- **Claude Sonnet 4.6** — default, 1M context window
- **Claude Opus 4.6** — highest quality, 1M context
- **Claude Haiku 4.5** — fast and cheap, 200K context
- Requires: `ANTHROPIC_API_KEY`

**⭐ Recommended — Google Gemini:**
- **Gemini 3.1 Pro Preview** — 1M context
- **Gemini 3.0 Flash Preview** — 1M context, fastest
- Requires: `GEMINI_API_KEY`

**⭐ Recommended — OpenAI:**
- **GPT-5.4** — 1M context
- **GPT-5.4 Mini** — 272K context, cheaper
- **GPT-5.3 Codex Spark** — code-optimized, 272K context
- Requires: `OPENAI_API_KEY`
- Note: OpenAI `codex` and `-pro` variants use the newer Responses API. The app routes them automatically, so you can pick them freely.

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
- If your org uses SAML SSO, make sure the token is SSO-authorized for the org (click "Configure SSO" next to the token on the tokens page)
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
