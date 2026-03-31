# Migrating from Sync Pristine Repos to Repo Radar

If you had the old "Sync Pristine Repos" app installed, follow these steps to cleanly switch to Repo Radar.

## 1. Quit the old app

Click the old sync icon in your menu bar -> Quit. Or force quit:

```bash
pkill -f "Sync Pristine Repos"
```

## 2. Unload old LaunchAgents

The old app registered LaunchAgents that will keep trying to launch it. Remove them:

```bash
# Unload the agents
launchctl unload ~/Library/LaunchAgents/com.user.sync-pristine-repos.plist 2>/dev/null
launchctl unload ~/Library/LaunchAgents/com.user.sync-pristine-repos-menubar.plist 2>/dev/null

# Delete the plist files
rm -f ~/Library/LaunchAgents/com.user.sync-pristine-repos.plist
rm -f ~/Library/LaunchAgents/com.user.sync-pristine-repos-menubar.plist
```

## 3. Remove the old app

```bash
# Remove from Applications (if installed there)
rm -rf "/Applications/Sync Pristine Repos.app"

# Remove from ~/bin (if installed there)
rm -f ~/bin/sync-pristine-repos
rm -rf ~/bin/sync-pristine-repos-menubar
```

## 4. Install Repo Radar

Download the latest release from [GitHub Releases](https://github.com/mattwallington/repo-radar/releases):
- **Apple Silicon (M1-M4)**: `Repo-Radar-*-arm64-mac.zip` or `.dmg`
- **Intel Mac**: `Repo-Radar-*-x64-mac.zip` or `.dmg`

Drag **Repo Radar.app** to `/Applications` and open it.

## 5. Your config is preserved

Repo Radar automatically migrates your configuration from `~/.config/sync-pristine-repos/` to `~/.config/repo-radar/` on first launch. Your repository selections, API keys, and schedule settings will carry over.

Your synced repos in `~/repos-pristine/` are untouched.

## 6. Optional cleanup

After verifying Repo Radar works, you can remove the old config and data:

```bash
# Remove old config (only after confirming Repo Radar migrated it)
rm -rf ~/.config/sync-pristine-repos

# Remove old install directory
rm -rf ~/.sync-pristine-repos

# Remove old logs
rm -rf ~/Library/Logs/sync-pristine-repos
rm -f ~/Library/Logs/sync-pristine-repos-menubar.log
rm -f ~/Library/Logs/sync-pristine-repos-menubar.error.log
```
