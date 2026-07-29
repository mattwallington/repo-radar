const { app, Tray, Menu, BrowserWindow, ipcMain, nativeImage, clipboard, dialog, Notification } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const os = require('os');
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const { spawn } = require('child_process');
const { providerForModel, migrateModel, DEFAULT_MODEL } = require('./model-policy');
// Spec 2A runtime module (menubar/runtime/): per-channel Python runtime
// provisioning + the lockf-serialized sync runner. See app.whenReady() and
// triggerSync() below for how these are wired in.
const runtime = require('./runtime');
const { resolveChannel, layout, cliPath } = require('./runtime/paths');
const { detectStableManaged } = require('./runtime/quiesce');
const { planReconcile, needsCatchUp } = require('./run-receipt');
const { createModelNoticeController } = require('./model-notice-controller');
const { parseModelLabels, persistConfig } = require('./model-notice');
let appIsQuitting = false;
let modelNoticeController = null;
let modelUpdateWindow = null; // the open notice window, if any (Codex code-review: never coexist with Settings)
const MODEL_LABELS = parseModelLabels(fs.readFileSync(path.join(__dirname, 'renderer', 'settings.html'), 'utf8'));

// Read version from VERSION file
function getVersion() {
  try {
    // In packaged app, VERSION is in resources/
    const paths = [
      path.join(__dirname, '..', 'VERSION'),
      path.join(process.resourcesPath || '', 'VERSION'),
      path.join(__dirname, 'VERSION')
    ];
    for (const p of paths) {
      if (fs.existsSync(p)) {
        return fs.readFileSync(p, 'utf8').trim();
      }
    }
  } catch (e) {}
  // No fictitious version fallback: `null` is falsy, so
  // runtime/identity.js's authoritativeIdentity({appVersion}) fails closed
  // (`!appVersion || appVersion === '2.0.0'`) instead of silently treating an
  // unreadable VERSION file as a real, safe-to-provision version string.
  return null;
}

const APP_VERSION = getVersion();

// Channel-first, fail-closed (spec 2A maintainer addition). Resolve the build
// channel via resolveChannel() ONCE, synchronously, here at the true top of
// the file — BEFORE any channel-dependent behavior (the LaunchAgent
// label/plist path, the status port, cleanupOrphans(), uninstallApp(), the
// single-instance lock's appId) derives anything from it. Every one of those
// consumers below reads `runtimeChannel`/`IS_DEV_BUILD` — there is no second,
// independent build-info.json read anymore.
//
// Fail closed: if resolveChannel() throws ChannelError (missing/malformed
// build-info.json — always true for a dev-from-source run, e.g. `electron .`
// with no packaged build-info.json), `runtimeChannel` stays null and
// `runtimeDisabled` is set. That must NEVER be silently treated as "stable" —
// see IS_DEV_BUILD/STATUS_PORT/AGENT_LABEL below, all of which go null/absent
// rather than guessing, and the null-channel guards in cleanupOrphans(),
// uninstallApp(), updateLaunchAgent(), and triggerSync(). The user-facing
// surfacing (tray icon/dialog/notification via surfaceRuntimeError()) happens
// later in app.whenReady() once the tray exists — this block only resolves
// state.
let runtimeChannel = null;
let runtimeDisabled = false;
let runtimeDisabledReason = '';
try {
  runtimeChannel = resolveChannel(path.join(__dirname, 'build-info.json'));
} catch (e) {
  runtimeDisabled = true;
  runtimeDisabledReason = `build channel: ${e.message}`;
}

const IS_DEV_BUILD = runtimeChannel === 'dev';

// Dev builds use a different port so they don't conflict with production.
// Null (not 3847) when the channel is unresolved: startStatusServer() skips
// listening in that case rather than guessing stable's fixed port.
const STATUS_PORT = runtimeChannel === 'dev' ? 3848 : runtimeChannel === 'stable' ? 3847 : null;

// Channel-namespaced LaunchAgent identity (spec 2A). Stable and dev must never
// share a schedule label/plist file: uninstallApp(), cleanupOrphans(),
// detectExistingSchedule(), and updateLaunchAgent() all previously hardcoded
// the single stable label, which meant e.g. uninstalling Repo Radar Dev would
// unload/delete *stable's* real persistent schedule. All four now go through
// this helper. AGENT_LABEL/getPlistFile() are null when the channel is
// unresolved — callers must guard rather than fall through to stable's label.
const AGENT_LABEL = runtimeChannel === 'dev' ? 'com.user.repo-radar-dev'
  : runtimeChannel === 'stable' ? 'com.user.repo-radar'
  : null;
function getPlistFile() {
  if (!AGENT_LABEL) return null;
  return path.join(process.env.HOME, 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);
}

// Request single instance lock per app variant (dev and prod can coexist)
const gotTheLock = app.requestSingleInstanceLock({ appId: IS_DEV_BUILD ? 'repo-radar-dev' : 'repo-radar' });

if (!gotTheLock) {
  const appName = getAppDisplayName();
  console.error(`Another instance of ${appName} is already running!`);
  dialog.showErrorBox(
    'Already Running',
    `${appName} is already running.\n\nOnly one instance can run at a time.\n\nCheck your menubar for the sync icon.`
  );
  app.quit();
}

// If someone tries to run a second instance, focus the existing one
app.on('second-instance', (event, commandLine, workingDirectory) => {
  console.log('Second instance detected, focusing existing instance');
  
  // Show the log window if available
  if (logWindow && !logWindow.isDestroyed()) {
    logWindow.show();
    logWindow.focus();
  } else if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
  }
});
const STATUS_FILE = path.join(process.env.HOME, '.config', 'repo-radar', 'status.json');
const CONFIG_DIR = path.join(process.env.HOME, '.config', 'repo-radar');

const OLD_CONFIG_DIR = path.join(process.env.HOME, '.config', 'sync-pristine-repos');

// Migrate config from old location if needed
if (!fs.existsSync(CONFIG_DIR) && fs.existsSync(OLD_CONFIG_DIR)) {
  try {
    fs.cpSync(OLD_CONFIG_DIR, CONFIG_DIR, { recursive: true });
    console.log('Migrated config from', OLD_CONFIG_DIR, 'to', CONFIG_DIR);
  } catch (e) {
    console.error('Error migrating config:', e);
  }
}

// NOTE (spec 2A): getSyncScriptPath() used to resolve the legacy manual
// launcher path for both triggerSync()'s spawn and updateLaunchAgent()'s
// wrapper-script generation. Both call sites now go through
// runtime.runSync()/the runtime module's generic run-sync.sh (which resolves
// + verifies the active generation itself), so this function has no
// remaining callers (confirmed via repo-wide grep) and has been removed
// rather than left as dead code.

let tray = null;
let logWindow = null;
let settingsWindow = null;
let errorWindow = null;
let statusServer = null;
let currentSyncProcess = null;
let syncCancelledByUser = false;
let syncShowWindow = true;
// One-shot flag: triggerSync sets this before creating the progress window so
// that the window's did-finish-load handler knows a fresh sync-started event
// is already on its way and should skip the mid-sync replay path.
let pendingFreshSync = false;
let lastStatus = null;
let animationInterval = null;
let animationFrame = 0;
let successTimeout = null;
let versionInfo = null;

// Runtime bootstrap state (spec 2A `menubar/runtime/`). `runtimeChannel` /
// `runtimeDisabled` / `runtimeDisabledReason` are declared and resolved
// synchronously at the true top of this file (channel-first, fail-closed —
// see the block above APP_VERSION) so every channel-dependent consumer,
// including ones that run before app.whenReady(), sees the same resolved
// state. `runtimeDisabled` is also set true — and sync/schedule operations
// refuse to run — after an ensureRuntime() failure inside app.whenReady().
// See surfaceRuntimeError() and app.whenReady().

// Load version info
function loadVersionInfo() {
  try {
    const buildInfoPath = path.join(__dirname, 'build-info.json');
    if (fs.existsSync(buildInfoPath)) {
      versionInfo = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));
      // Prefer APP_VERSION from VERSION file if available. (getVersion() no
      // longer returns a fictitious '2.0.0' when the VERSION file can't be
      // read — it returns null — so this guard now checks truthiness rather
      // than inequality with that old sentinel; a null APP_VERSION correctly
      // falls through to build-info.json's version instead of overwriting it
      // with null.)
      if (APP_VERSION) {
        versionInfo.version = APP_VERSION;
      }
    } else {
      versionInfo = {
        version: APP_VERSION,
        buildDate: new Date().toISOString(),
        buildTimestamp: Date.now()
      };
    }
  } catch (e) {
    versionInfo = {
      version: APP_VERSION,
      buildDate: new Date().toISOString(),
      buildTimestamp: Date.now()
    };
  }
  return versionInfo;
}

function getVersionString() {
  if (!versionInfo) loadVersionInfo();
  return `v${versionInfo.version}`;
}

function isDevBuild() {
  return IS_DEV_BUILD;
}

function getAppDisplayName() {
  return isDevBuild() ? 'Repo Radar Dev' : 'Repo Radar';
}

// Ensure config directory exists
if (!fs.existsSync(CONFIG_DIR)) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

// Single source of truth for sync state - process-based instead of file-based
function isSyncing() {
  if (!currentSyncProcess) return false;
  if (currentSyncProcess.killed) return false;
  if (currentSyncProcess.exitCode !== null) return false;  // Process exited (includes zombies)
  return isProcessAlive(currentSyncProcess);
}

function isProcessAlive(proc) {
  if (!proc || !proc.pid) return false;
  try {
    // Check if process exists without killing it
    // Signal 0 doesn't actually send a signal, just checks if we CAN
    process.kill(proc.pid, 0);
    return true;
  } catch (e) {
    return false;  // Process doesn't exist or we don't have permission
  }
}

function logSyncState(context) {
  console.log(`[${context}] Sync state:`, {
    processExists: !!currentSyncProcess,
    processPID: currentSyncProcess?.pid,
    processKilled: currentSyncProcess?.killed,
    processExitCode: currentSyncProcess?.exitCode,
    isSyncing: isSyncing()
  });
}

// Load last status
function loadStatus() {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      lastStatus = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading status:', e);
  }
  return lastStatus || {
    lastSync: null,
    stats: { total: 0, cloned: 0, updated: 0, errors: 0 },
    repos: [],
    logOutput: '',
    errorList: []  // Array of error objects
  };
}

// Save status
function saveStatus(status) {
  lastStatus = status;
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  } catch (e) {
    console.error('Error saving status:', e);
  }
}

// Format time ago
function timeAgo(timestamp) {
  if (!timestamp) return 'Never';
  const now = new Date();
  const then = new Date(timestamp);
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
  return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
}

// Create tray icon from PNG file
function createTrayIcon(color, rotation = 0) {
  try {
    let iconPath;
    
    if (color === 'white') {
      // Dev builds use orange idle icon to distinguish from production
      iconPath = path.join(__dirname, 'assets', isDevBuild() ? 'icon-dev.png' : 'icon.png');
    } else if (color === 'yellow') {
      // Use rotation frame
      const frameIndex = Math.floor((rotation / 360) * 32) % 32;
      iconPath = path.join(__dirname, 'assets', `icon-syncing-${frameIndex}.png`);
      
      // Fallback if frame doesn't exist
      if (!fs.existsSync(iconPath)) {
        iconPath = path.join(__dirname, 'assets', 'icon-syncing.png');
      }
    } else if (color === 'green') {
      iconPath = path.join(__dirname, 'assets', 'icon-success.png');
    } else if (color === 'red') {
      iconPath = path.join(__dirname, 'assets', 'icon-error.png');
    }
    
    if (fs.existsSync(iconPath)) {
      const img = nativeImage.createFromPath(iconPath);
      return img;
    } else {
      console.error('Icon file not found:', iconPath);
    }
  } catch (e) {
    console.error('Error creating icon:', e);
  }
  
  return null;
}

// Show success icon temporarily
function showSuccessIcon() {
  stopIconAnimation();
  
  // Clear any existing success timeout
  if (successTimeout) {
    clearTimeout(successTimeout);
  }
  
  // Show green icon
  const icon = createTrayIcon('green', 0);
  if (icon) {
    tray.setImage(icon);
  }
  
  tray.setToolTip('Sync completed successfully!');
  
  // Revert to white after 5 seconds
  successTimeout = setTimeout(() => {
    const icon = createTrayIcon('white', 0);
    if (icon) {
      tray.setImage(icon);
    }
    tray.setToolTip(`${getAppDisplayName()} ${getVersionString()}`);
    successTimeout = null;
  }, 5000);
}

// Show error icon (stays until next successful sync)
function showErrorIcon() {
  stopIconAnimation();
  
  // Clear any success timeout
  if (successTimeout) {
    clearTimeout(successTimeout);
    successTimeout = null;
  }
  
  const icon = createTrayIcon('red', 0);
  if (icon) {
    tray.setImage(icon);
  }
  
  const status = loadStatus();
  const errorCount = status.stats?.errors || 0;
  tray.setToolTip(`Sync failed with ${errorCount} error${errorCount !== 1 ? 's' : ''}`);
}

// Start icon animation
function startIconAnimation() {
  if (animationInterval) return; // Already animating
  
  animationFrame = 0;
  tray.setToolTip('Syncing repositories...');
  
  animationInterval = setInterval(() => {
    const rotation = (animationFrame * 360) / 32;
    const icon = createTrayIcon('yellow', rotation);
    if (icon) {
      tray.setImage(icon);
    }
    
    // Update tooltip with progress
    const status = loadStatus();
    if (status.repos && status.repos.length > 0) {
      const completed = status.repos.filter(r => r.percent === 100).length;
      const total = status.stats?.total || status.repos.length;
      tray.setToolTip(`Syncing: ${completed}/${total} repos completed`);
    }
    
    animationFrame = (animationFrame + 1) % 32;
  }, 50); // Update every 50ms for smooth rotation
}

// Stop icon animation
function stopIconAnimation() {
  if (animationInterval) {
    clearInterval(animationInterval);
    animationInterval = null;
  }
  
  // Return to idle icon (white)
  const icon = createTrayIcon('white', 0);
  if (icon) {
    tray.setImage(icon);
  }
  
  // Clear tooltip
  tray.setToolTip(`${getAppDisplayName()} ${getVersionString()}`);
}

// Generate LLM config snippet and copy to clipboard
function copyLLMConfig() {
  const configFile = path.join(CONFIG_DIR, 'config.json');
  let config = null;
  try {
    if (fs.existsSync(configFile)) {
      config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading config for LLM snippet:', e);
  }

  // Determine repos directory
  let reposDir = '~/repos-pristine';
  if (config && config.repos_dir) {
    reposDir = config.repos_dir;
    // Normalize home dir for display
    if (reposDir.startsWith(process.env.HOME)) {
      reposDir = reposDir.replace(process.env.HOME, '~');
    }
  }

  const snippet = `# Repository Context Discovery

Pristine repo cache at \`${reposDir}/\` contains clean, up-to-date copies of frequently-used repos (always on dev/main).

## When to Check INDEX.md

Read \`${reposDir}/INDEX.md\` if your task involves understanding, calling, or integrating with other services/systems.

Common scenarios: API calls, database schemas, auth flows, service integrations, shared code, environment config, webhooks, "how does X work?" questions.

## Required 3-Step Workflow

Once you've identified a relevant repo from INDEX.md:

1. **Read metadata first** - \`${reposDir}/<repo-name>.md\` (Quick Reference + full analysis)
2. **Read code second** - \`${reposDir}/<repo-name>/\` (only if metadata confirms relevance)

**Never skip step 1.** Metadata filters whether code is worth reading.

Note: Read-only reference. Current working directory may differ.
`;

  clipboard.writeText(snippet);

  // Show notification
  const { Notification } = require('electron');
  if (Notification.isSupported()) {
    new Notification({
      title: 'Repo Radar',
      body: 'LLM config snippet copied to clipboard. Paste it into your CLAUDE.md or AGENTS.md file.'
    }).show();
  }
}

// Update tray menu
function updateTrayMenu() {
  const status = loadStatus();
  
  // Handle icon animation/state based on actual process state
  if (isSyncing()) {
    startIconAnimation();
  } else if (status.hasErrors) {
    // Keep showing error icon
    showErrorIcon();
  } else {
    // Ensure icon is white when idle
    const idleIcon = createTrayIcon('white', 0);
    if (idleIcon) {
      tray.setImage(idleIcon);
      tray.setToolTip(`${getAppDisplayName()} ${getVersionString()}`);
    }
  }
  
  // Load schedule info
  let scheduleText = 'Manual only';
  try {
    const configFile = path.join(CONFIG_DIR, 'config.json');
    if (fs.existsSync(configFile)) {
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (config.schedule?.enabled) {
        const sched = config.schedule;
        if (sched.type === 'daily') {
          scheduleText = `Daily at ${sched.time || '09:00'}`;
        } else if (sched.type === 'hourly') {
          scheduleText = `Every ${sched.interval || 6} hours`;
        } else if (sched.type === 'weekly') {
          const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
          const days = (sched.days || []).map(d => dayNames[d]).join(', ');
          scheduleText = `${days} at ${sched.time || '09:00'}`;
        }
      }
    }
  } catch (e) {
    // Ignore errors
  }
  
  const menuItems = [
    {
      label: `Last Sync: ${timeAgo(status.lastSync)}`,
      enabled: false
    },
    {
      label: `${status.stats.total} repos configured`,
      enabled: false
    },
    {
      label: status.stats.errors > 0 ? 
        `${status.stats.errors} error${status.stats.errors !== 1 ? 's' : ''}` :
        `${status.stats.updated + status.stats.cloned} repos synced`,
      enabled: false
    },
    {
      label: `Schedule: ${scheduleText}`,
      enabled: false
    },
    { type: 'separator' },
  ];
  
  // Conditionally add sync/progress menu items based on actual process state
  if (isSyncing()) {
    // Sync is running - show View Progress only
    menuItems.push({
      label: '📊 View Progress',
      click: () => showLogWindow()
    });
  } else {
    // Sync not running - show Sync Now
    menuItems.push({
      label: '▶ Sync Now',
      click: () => triggerSync()
    });
    
    // Optionally show View Errors if there are errors
    if (status.hasErrors) {
      menuItems.push({
        label: '⚠️  View Errors',
        click: () => showErrorWindow()
      });
    }
  }
  
  menuItems.push(
    {
      label: '⚙️  Settings',
      click: () => showSettingsWindow()
    },
    {
      label: '📋 Copy LLM Config',
      click: () => copyLLMConfig()
    },
    {
      label: '🔄 Check for Updates',
      click: () => {
        autoUpdater.checkForUpdates().then((result) => {
          if (!result || !result.updateInfo || result.updateInfo.version === app.getVersion()) {
            dialog.showMessageBox({
              type: 'info',
              title: 'No Updates',
              message: 'You are running the latest version.',
              detail: `Repo Radar v${app.getVersion()}`
            });
          }
        }).catch((err) => {
          dialog.showMessageBox({
            type: 'error',
            title: 'Update Check Failed',
            message: 'Could not check for updates.',
            detail: err.message
          });
        });
      }
    },
    { type: 'separator' },
    {
      label: getVersionString(),
      enabled: false
    },
    {
      label: '🗑️  Uninstall...',
      click: () => uninstallApp()
    },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      }
    }
  );
  
  const menu = Menu.buildFromTemplate(menuItems);
  tray.setContextMenu(menu);
}

// Uninstall app - remove all persistent files and quit.
//
// Scoped by resolved build channel (Codex I3, spec 2A §3.3): ~/.repo-radar/
// is now a SHARED root holding one subdirectory per channel (stable/, dev/)
// plus a shared root exec lock; ~/.config/repo-radar/ and
// ~/Library/Logs/repo-radar/ are shared config/log locations too. A dev build
// must remove ONLY its own dispatcher (~/.local/bin/repo-radar-dev), its own
// plist (com.user.repo-radar-dev), and its own channel dir
// (~/.repo-radar/dev/) — never the shared root, stable's channel dir, the
// shared config, or shared logs. (Stable's uninstall keeps the previous,
// broader "full app removal" behavior — config/logs/legacy launcher — since
// nothing here asked to change that side.) If the channel couldn't be
// resolved at all we don't know which state is safe to touch, so refuse
// rather than guess — the same fail-closed contract as triggerSync()/
// updateLaunchAgent().
function uninstallApp() {
  const appName = getAppDisplayName();

  if (!runtimeChannel) {
    dialog.showErrorBox(
      'Uninstall Unavailable',
      `Cannot uninstall ${appName}: the build channel could not be determined (${runtimeDisabledReason || 'unknown error'}). Remove files manually, or reinstall from a proper build.`
    );
    return;
  }

  const isDevChannel = runtimeChannel === 'dev';

  dialog.showMessageBox({
    type: 'warning',
    title: `Uninstall ${appName}`,
    message: `Are you sure you want to uninstall ${appName}?`,
    detail: isDevChannel
      ? 'This will remove:\n• Dev scheduled sync (LaunchAgent), if any\n• Dev CLI dispatcher (~/.local/bin/repo-radar-dev)\n• Dev runtime (~/.repo-radar/dev/)\n\nShared configuration, logs, and any stable installation will NOT be touched.\nYour synced repositories will NOT be deleted.'
      : 'This will remove:\n• Scheduled sync (LaunchAgent)\n• Configuration and status files\n• Log files\n• Runtime files\n\nYour synced repositories will NOT be deleted.',
    buttons: ['Cancel', 'Uninstall'],
    defaultId: 0,
    cancelId: 0
  }).then((result) => {
    if (result.response !== 1) return;

    console.log(`Uninstalling (channel: ${runtimeChannel})...`);

    // 1. Unload and remove THIS channel's LaunchAgent only (AGENT_LABEL is
    // already channel-namespaced: com.user.repo-radar vs com.user.repo-radar-dev).
    const plistFile = getPlistFile();
    try {
      if (plistFile && fs.existsSync(plistFile)) {
        spawn('launchctl', ['unload', plistFile], { stdio: 'ignore' });
        fs.unlinkSync(plistFile);
        console.log('Removed LaunchAgent:', plistFile);
      }
    } catch (e) {
      console.error('Error removing LaunchAgent:', e);
    }

    // 2. Remove THIS channel's CLI dispatcher only (~/.local/bin/repo-radar[-dev]).
    try {
      const dispatcher = cliPath(os.homedir(), runtimeChannel);
      if (fs.existsSync(dispatcher)) {
        fs.unlinkSync(dispatcher);
        console.log('Removed CLI dispatcher:', dispatcher);
      }
    } catch (e) {
      console.error('Error removing CLI dispatcher:', e);
    }

    if (!isDevChannel) {
      // Stable only: remove shared config + logs + any pre-spec-2A legacy
      // launcher. Dev must never touch these (Codex I3) — they're shared
      // across channels and dev is meant to be a disposable, isolated overlay
      // on top of a managed stable install.
      try {
        if (fs.existsSync(CONFIG_DIR)) {
          fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
          console.log('Removed config directory');
        }
      } catch (e) {
        console.error('Error removing config:', e);
      }

      const logDir = path.join(process.env.HOME, 'Library', 'Logs', 'repo-radar');
      try {
        if (fs.existsSync(logDir)) {
          fs.rmSync(logDir, { recursive: true, force: true });
          console.log('Removed log directory');
        }
      } catch (e) {
        console.error('Error removing logs:', e);
      }

      // Legacy pre-spec-2A install: the ~/.repo-radar/repo-radar launcher sat
      // directly in the shared root. Only stable ever had a legacy install.
      const legacyLauncher = path.join(os.homedir(), '.repo-radar', 'repo-radar');
      try {
        if (fs.existsSync(legacyLauncher)) {
          fs.unlinkSync(legacyLauncher);
          console.log('Removed legacy launcher');
        }
      } catch (e) {
        console.error('Error removing legacy launcher:', e);
      }
    }

    // 3. Remove only THIS channel's runtime dir (~/.repo-radar/<channel>/) —
    // never the shared ~/.repo-radar/ root, which the other channel (and the
    // shared root exec lock) may still be using.
    try {
      const channelDir = layout(os.homedir(), runtimeChannel).channelDir;
      if (fs.existsSync(channelDir)) {
        fs.rmSync(channelDir, { recursive: true, force: true });
        console.log('Removed channel runtime directory:', channelDir);
      }
    } catch (e) {
      console.error('Error removing channel runtime directory:', e);
    }

    // Show confirmation
    dialog.showMessageBox({
      type: 'info',
      title: 'Uninstall Complete',
      message: `${appName} has been uninstalled.`,
      detail: 'You can now drag the app to the Trash to finish removal.\n\nYour synced repositories were not deleted.',
      buttons: ['OK']
    }).then(() => {
      app.quit();
    });
  });
}

// Clean up orphaned files from a previous uninstalled version
function cleanupOrphans() {
  // Fail-closed (Codex I3/maintainer channel-first addition): if the build
  // channel is unresolved we don't reliably know which plist (if any) belongs
  // to this build, so don't touch any LaunchAgent — never guess stable's.
  if (!runtimeChannel) return;

  // Check if a LaunchAgent exists but points to an app that no longer exists
  const plistFile = getPlistFile();
  try {
    if (plistFile && fs.existsSync(plistFile)) {
      const content = fs.readFileSync(plistFile, 'utf8');
      // Extract the script path from the plist
      const scriptMatch = content.match(/<string>(\/[^<]*run-sync\.sh)<\/string>/);
      if (scriptMatch && !fs.existsSync(scriptMatch[1])) {
        console.log('Found orphaned LaunchAgent pointing to missing script:', scriptMatch[1]);
        spawn('launchctl', ['unload', plistFile], { stdio: 'ignore' });
        fs.unlinkSync(plistFile);
        console.log('Cleaned up orphaned LaunchAgent');
      }
    }
  } catch (e) {
    console.error('Error checking for orphaned LaunchAgent:', e);
  }
}

// Surface a runtime bootstrap failure (missing/malformed build channel,
// legacy-quiescence failure, provisioning failure, etc. — spec 2A) through the
// app's existing error surfaces: red tray icon + "View Errors" window + a
// native notification. Sets runtimeDisabled so triggerSync()/updateLaunchAgent()
// refuse to run instead of silently no-op'ing or crashing. Used both as
// ensureRuntime()'s `hooks.onFailure` (message is already redacted there) and
// directly from the synchronous resolveChannel() try/catch in app.whenReady().
function surfaceRuntimeError(msg) {
  runtimeDisabled = true;
  runtimeDisabledReason = msg;
  console.error('[runtime] disabling sync:', msg);

  const status = loadStatus();
  status.hasErrors = true;
  if (!status.errorList) status.errorList = [];
  status.errorList.unshift({
    timestamp: new Date().toISOString(),
    repo: 'Runtime',
    message: 'Runtime setup failed — sync disabled',
    fullError: msg
  });
  status.errorLog = (status.errorLog || '') + `\n⚠️ Runtime setup failed: ${msg}\n`;
  saveStatus(status);

  if (tray && !tray.isDestroyed()) {
    showErrorIcon();
    updateTrayMenu();
  }
  if (Notification.isSupported()) {
    new Notification({
      title: getAppDisplayName(),
      body: `Sync disabled: ${msg}`
    }).show();
  }
}

// Non-fatal: the runtime + manual "Sync Now" are healthy, but the SCHEDULED sync could
// not be (re)installed. Surface it to the user (status log + tray + a notification with
// relaunch guidance) instead of leaving it silent in the console (Codex round-7 I3).
function surfaceScheduleWarning(msg) {
  console.warn('[runtime] schedule warning:', msg);
  try {
    const status = loadStatus();
    if (!status.errorList) status.errorList = [];
    status.errorList.unshift({
      timestamp: new Date().toISOString(),
      repo: 'Schedule',
      message: 'Scheduled sync setup failed — manual sync still works; relaunch to retry',
      fullError: msg
    });
    status.errorLog = (status.errorLog || '') + `\n⚠️ Scheduled sync setup failed (manual sync still works): ${msg}\n`;
    saveStatus(status);
  } catch (e) { /* best effort */ }
  if (tray && !tray.isDestroyed()) updateTrayMenu();
  if (Notification.isSupported()) {
    new Notification({
      title: getAppDisplayName(),
      body: 'Scheduled sync couldn’t be set up — manual sync still works. Relaunch to retry.'
    }).show();
  }
}

function _readModelConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'config.json'), 'utf8')); }
  catch (e) { return {}; }
}

function _openModelUpdateWindow(notice, sig) {
  const win = new BrowserWindow({
    width: 460, height: 220, resizable: false, minimizable: false, maximizable: false,
    fullscreenable: false, title: 'Repo Radar — Models', show: false,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(__dirname, 'renderer', 'model-update-preload.js'),
    },
  });
  win.on('close', (e) => {
    if (!modelNoticeController || modelNoticeController.closeDecision() === 'allow') return;
    e.preventDefault();
    modelNoticeController.finalize('close');
  });
  win.on('closed', () => { if (modelUpdateWindow === win) modelUpdateWindow = null; });
  win.loadFile(path.join(__dirname, 'renderer', 'model-update.html'));
  win.once('ready-to-show', () => win.show());
  modelUpdateWindow = win; // track so showSettingsWindow can focus it instead of coexisting
  return win;
}

function buildModelNoticeController() {
  modelNoticeController = createModelNoticeController({
    channel: runtimeChannel,
    readConfig: _readModelConfig,
    save: saveConfigToFile,
    reconcile: updateLaunchAgent,
    labels: MODEL_LABELS,
    openWindow: _openModelUpdateWindow,
    showError: (err) => dialog.showErrorBox('Repo Radar', `Could not save model change: ${err || 'unknown error'}`),
    showScheduleWarning: (err) => surfaceScheduleWarning(err),
    isQuitting: () => appIsQuitting,
    openSettings: () => showSettingsWindow(),
    isSettingsOpen: () => !!(settingsWindow && !settingsWindow.isDestroyed()),
  });
  return modelNoticeController;
}

// Start status server
function startStatusServer() {
  const expressApp = express();
  expressApp.use(bodyParser.json());
  
  expressApp.post('/status', (req, res) => {
    const data = req.body;
    
    // Validate repo name format (should be full name with /)
    if (data.repo && !data.repo.includes('/')) {
      console.warn('WARNING: Received short name instead of full name:', data.repo);
    }
    
    console.log('Received status update:', data.type, data.repo || '', 'percent:', data.percent || '');
    
    if (data.type === 'output') {
      // Send terminal output to renderer
      if (logWindow && !logWindow.isDestroyed()) {
        logWindow.webContents.send('terminal-output', data.data);
      }
      
      // Append to status log
      const status = loadStatus();
      status.logOutput = (status.logOutput || '') + data.data;
      saveStatus(status);
    } else if (data.type === 'progress') {
      // Update repo progress
      const status = loadStatus();
      if (!status.repos) status.repos = [];
      
      const repoIndex = status.repos.findIndex(r => r.name === data.repo);
      if (repoIndex >= 0) {
        status.repos[repoIndex] = {
          name: data.repo,
          status: data.status,
          percent: data.percent,
          color: data.color
        };
      } else {
        status.repos.push({
          name: data.repo,
          status: data.status,
          percent: data.percent,
          color: data.color
        });
      }
      
      saveStatus(status);
      updateTrayMenu();
      
      // Send to renderer
      if (logWindow && !logWindow.isDestroyed()) {
        logWindow.webContents.send('progress-update', data);
      }
      
      // Check if this is an error status and capture it
      if (data.status && (data.status.includes('✗') || data.status.includes('failed') || data.status.includes('error'))) {
        const status = loadStatus();
        if (!status.errorList) status.errorList = [];
        
        // Add detailed error to list (newest first)
        status.errorList.unshift({
          timestamp: new Date().toISOString(),
          repo: data.repo,
          message: data.status,
          fullError: data.fullError || data.status
        });
        
        saveStatus(status);
      }
    } else if (data.type === 'error') {
      // Detailed error message from Python script
      const status = loadStatus();
      if (!status.errorList) status.errorList = [];
      
      // Add to error list (newest first)
      status.errorList.unshift({
        timestamp: new Date().toISOString(),
        repo: data.repo || 'Unknown',
        message: data.message || 'Unknown error',
        fullError: data.fullError || data.message || 'Unknown error',
        stackTrace: data.stackTrace || null
      });
      
      status.hasErrors = true;
      saveStatus(status);
      
      // Send to renderer
      if (logWindow && !logWindow.isDestroyed()) {
        logWindow.webContents.send('terminal-output', `\n❌ ERROR: ${data.message}\n`);
      }
    } else if (data.type === 'rate-limit') {
      // Update rate limit display
      if (logWindow && !logWindow.isDestroyed()) {
        logWindow.webContents.send('rate-limit-update', data);
      }
    } else if (data.type === 'waiting-for-network') {
      console.log('Sync waiting for network connectivity...');
      if (logWindow && !logWindow.isDestroyed()) {
        logWindow.webContents.send('waiting-for-network');
      }
    } else if (data.type === 'network-timeout') {
      console.log('Network timeout:', data.message);
      if (logWindow && !logWindow.isDestroyed()) {
        logWindow.webContents.send('network-timeout', data.message);
      }
    } else if (data.type === 'complete') {
      // Sync complete
      const status = loadStatus();
      status.lastSync = new Date().toISOString();
      status.stats = data.stats || status.stats;
      
      console.log('Sync complete with stats:', data.stats);
      
      // Check for warnings (only from explicit warning message from Python)
      const hasWarning = data.warning;
      
      // Store warning in status if present
      if (data.warning) {
        status.errorLog = (status.errorLog || '') + '\n' + data.warning;
        console.warn('Sync warning:', data.warning);
      }
      
      // Update icon based on success/error/warning
      if (data.stats && data.stats.errors > 0) {
        console.log('Sync had errors:', data.stats.errors);
        showErrorIcon();
        status.hasErrors = true;
      } else if (hasWarning) {
        console.log('Sync completed with warnings');
        showSuccessIcon(); // Still show success, but flag for checking
        status.hasErrors = true; // Set true so "View Errors" shows warning
      } else {
        console.log('Sync successful, showing green icon');
        showSuccessIcon();
        status.hasErrors = false;
      }
      
      saveStatus(status);
      updateTrayMenu();
      
      // Send to renderer
      if (logWindow && !logWindow.isDestroyed()) {
        logWindow.webContents.send('sync-complete', data.stats);
        
        // Send warning if present
        if (data.warning) {
          logWindow.webContents.send('terminal-output', `\n\n${data.warning}\n\n`);
        }
      }
      
      // Show notification
      if (data.stats.errors > 0) {
        if (tray.displayBalloon) {
          tray.displayBalloon({
            title: 'Sync Complete (with errors)',
            content: `${data.stats.errors} error${data.stats.errors !== 1 ? 's' : ''} occurred during sync`
          });
        }
      } else if (hasWarning) {
        if (tray.displayBalloon) {
          tray.displayBalloon({
            title: 'Sync Complete (with warnings)',
            content: 'Repos synced but no metadata generated - check settings'
          });
        }
      } else {
        if (tray.displayBalloon) {
          tray.displayBalloon({
            title: 'Sync Complete',
            content: `Successfully synced ${data.stats.total} repositories`
          });
        }
      }
    }
    
    res.json({ success: true });
  });
  
  statusServer = expressApp.listen(STATUS_PORT, () => {
    console.log(`Status server listening on port ${STATUS_PORT}`);
  });
}

// Trigger sync
function triggerSync({ showWindow = true, trigger = null, notBefore = null } = {}) {
  const options = { showWindow, trigger, notBefore };
  if (currentSyncProcess) {
    return; // Already syncing
  }

  // Dev ownership isolation (Codex I3, spec 2A §3.3): dev must not run sync
  // against the shared data plane unless stable is provably managed AND
  // healthy (detectStableManaged) — an unmigrated/legacy/ambiguous stable
  // install means dev has no safe, isolated place to write. This is the
  // single central gate for BOTH dev sync entry points: manual "Sync Now"
  // (the tray menu click handler) and the missed-sync auto-trigger
  // (checkMissedSync()) — the only two callers of triggerSync() — since both
  // funnel through here before any state is touched.
  if (runtimeChannel === 'dev') {
    const managed = detectStableManaged({ home: os.homedir() });
    if (!managed.managed) {
      const reason = `Dev sync blocked: stable is not provably managed (${managed.reason}). Upgrade/run stable at least once to migrate it first, or run this dev build against an isolated HOME.`;
      console.error(reason);
      const blockedStatus = loadStatus();
      blockedStatus.hasErrors = true;
      blockedStatus.errorLog = (blockedStatus.errorLog || '') + `\n⚠️ ${reason}\n`;
      saveStatus(blockedStatus);
      showErrorIcon();
      updateTrayMenu();
      if (logWindow && !logWindow.isDestroyed()) {
        logWindow.webContents.send('terminal-output', `\n⚠️ ${reason}\n`);
      }
      return;
    }
  }

  syncCancelledByUser = false;
  syncShowWindow = showWindow;

  // Reset status for new sync
  const status = loadStatus();
  status.logOutput = '';
  status.errorLog = '';  // Clear previous error log text
  status.errorList = [];  // Clear previous error array
  status.repos = [];
  status.hasErrors = false;  // Reset error flag
  saveStatus(status);
  updateTrayMenu();
  
  // Load config to prepare repos array
  const configFile = path.join(CONFIG_DIR, 'config.json');
  let repoCount = 0;
  let reposForUI = [];
  let configValid = true;
  let validationMessage = '';
  
  try {
    if (fs.existsSync(configFile)) {
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      repoCount = config.repositories?.length || 0;
      
      // Prepare repos array with metadata for UI
      // Use full_name as the identifier to match Python's send_status_update calls
      reposForUI = (config.repositories || []).map((repo, index) => ({
        name: repo.full_name || repo.name,  // Use FULL name as identifier
        fullName: repo.full_name || repo.name,
        shortName: repo.name,  // Keep short name for compact display
        color: ['cyan', 'magenta', 'green', 'red', 'yellow', 'blue', 'bright_cyan', 'bright_red', 'bright_green', 'bright_magenta'][index % 10]
      }));
      
      // Validate API key for selected model
      const model = migrateModel(config.ai_model || DEFAULT_MODEL);
      const provider = providerForModel(model);
      if (provider === 'gemini') {
        if (!config.gemini_api_key) {
          configValid = false;
          validationMessage = '⚠️ Gemini API Key not configured. Metadata generation will be skipped.\n\nPlease configure in Settings → API Configuration.';
        }
      } else if (provider === 'anthropic') {
        if (!config.anthropic_api_key) {
          configValid = false;
          validationMessage = '⚠️ Anthropic API Key not configured. Metadata generation will be skipped.\n\nPlease configure in Settings → API Configuration.';
        }
      } else if (provider === 'openai') {
        if (!config.openai_api_key) {
          configValid = false;
          validationMessage = '⚠️ OpenAI API Key not configured. Metadata generation will be skipped.\n\nPlease configure in Settings → API Configuration.';
        }
      }
    }
  } catch (e) {
    console.error('Error loading config for repo count:', e);
  }
  
  // Store repos in status so window can retrieve them
  status.syncRepos = reposForUI;
  saveStatus(status);
  
  // Show log window (only for manual syncs; scheduled syncs run in background).
  // Set pendingFreshSync BEFORE creating the window so showLogWindow's
  // did-finish-load handler skips its mid-sync replay — sendSyncStartedWhenReady
  // below will deliver the fresh sync-started event instead.
  if (showWindow) {
    pendingFreshSync = true;
    showLogWindow();
  }

  // Wait for window to be fully ready before sending sync-started event
  const sendSyncStartedWhenReady = () => {
    if (logWindow && !logWindow.isDestroyed() && logWindow.webContents) {
      // Check if page has finished loading
      if (logWindow.webContents.isLoading()) {
        console.log('Window still loading, waiting...');
        setTimeout(sendSyncStartedWhenReady, 100);
        return;
      }

      console.log('Window ready, sending sync-started event with', reposForUI.length, 'repos');

      // Show warning if key is missing
      if (!configValid) {
        console.warn(validationMessage);
        logWindow.webContents.send('terminal-output', `\n${validationMessage}\n\n`);
      }

      // Send event
      logWindow.webContents.send('sync-started', { total: repoCount, repos: reposForUI });
      pendingFreshSync = false;
    } else {
      console.warn('Log window not available for sync-started event');
      pendingFreshSync = false;
    }
  };
  
  // Start checking after 300ms
  setTimeout(sendSyncStartedWhenReady, 300);
  
  // Build the environment for the sync child exactly as before. runtime.runSync()
  // (spec 2A) merges this over process.env; the runner resolves + verifies `current`
  // itself and execs the generation's launcher, whose own dir is sys.path[0] — so no
  // PYTHONPATH/getSyncScriptPath() is needed here (runSync sets no PYTHONPATH).
  const shellEnv = { ...process.env };

  // Ensure pyenv shims are in PATH (still useful for anything the sync shells
  // out to; the venv interpreter itself is resolved by runtime.runSync()).
  const pyenvShims = path.join(process.env.HOME, '.pyenv', 'shims');
  const pyenvBin = path.join(process.env.HOME, '.pyenv', 'bin');
  if (shellEnv.PATH) {
    shellEnv.PATH = `${pyenvShims}:${pyenvBin}:${shellEnv.PATH}`;
  } else {
    shellEnv.PATH = `${pyenvShims}:${pyenvBin}:/usr/local/bin:/usr/bin:/bin`;
  }

  // Try to load from .zshrc if available (as fallback)
  try {
    const zshrcPath = path.join(process.env.HOME, '.zshrc');
    if (fs.existsSync(zshrcPath)) {
      const zshrcContent = fs.readFileSync(zshrcPath, 'utf8');
      // Extract GITHUB_TOKEN and GEMINI_API_KEY from .zshrc
      const tokenMatch = zshrcContent.match(/export GITHUB_TOKEN=["']?([^"'\n]+)["']?/);
      const apiKeyMatch = zshrcContent.match(/export GEMINI_API_KEY=["']?([^"'\n]+)["']?/);
      if (tokenMatch) shellEnv.GITHUB_TOKEN = tokenMatch[1];
      if (apiKeyMatch) shellEnv.GEMINI_API_KEY = apiKeyMatch[1];
    }
  } catch (e) {
    // Ignore errors reading .zshrc
  }

  // Load API keys and model from config file (this overrides .zshrc if present)
  try {
    const configFile = path.join(CONFIG_DIR, 'config.json');
    if (fs.existsSync(configFile)) {
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (config.github_token) {
        shellEnv.GITHUB_TOKEN = config.github_token;
        console.log('✓ Loaded GITHUB_TOKEN from config');
      }
      if (config.gemini_api_key) {
        shellEnv.GEMINI_API_KEY = config.gemini_api_key;
        console.log('✓ Loaded GEMINI_API_KEY from config');
      }
      if (config.anthropic_api_key) {
        shellEnv.ANTHROPIC_API_KEY = config.anthropic_api_key;
        console.log('✓ Loaded ANTHROPIC_API_KEY from config');
      }
      if (config.openai_api_key) {
        shellEnv.OPENAI_API_KEY = config.openai_api_key;
        console.log('✓ Loaded OPENAI_API_KEY from config');
      }
      shellEnv.AI_MODEL = migrateModel(config.ai_model || DEFAULT_MODEL);
      console.log('✓ AI_MODEL set to:', shellEnv.AI_MODEL, config.ai_model ? '(from config)' : '(default)');
    } else {
      console.warn('⚠️  Config file not found:', configFile);
      console.warn('⚠️  Please configure API keys in Settings before running sync');
    }
  } catch (e) {
    console.error('Error loading config:', e);
  }

  shellEnv.REPO_RADAR_STATUS_PORT = String(STATUS_PORT);
  // Declare provenance rather than relying on this variable being ABSENT. If the app's own
  // environment ever carried REPO_RADAR_TRIGGER (inherited, exported, launchd), every in-app
  // sync would report itself as scheduled — the same mislabelling, inverted.
  shellEnv.REPO_RADAR_TRIGGER = (options && options.trigger) || 'manual';
  if (options && options.notBefore) shellEnv.REPO_RADAR_CATCHUP_NOT_BEFORE = options.notBefore;
  shellEnv.REPO_RADAR_CHANNEL = runtimeChannel;

  // Sync disabled: either the build channel couldn't be resolved, or
  // ensureRuntime() failed during startup (see app.whenReady()). Surface the
  // same way a failed spawn would have, rather than silently doing nothing.
  if (runtimeDisabled || !runtimeChannel) {
    const reason = runtimeDisabledReason || 'runtime channel unresolved';
    console.error('Sync disabled:', reason);
    const status = loadStatus();
    status.hasErrors = true;
    status.errorLog = (status.errorLog || '') + `\n⚠️ Sync unavailable: ${reason}\n`;
    saveStatus(status);
    showErrorIcon();
    updateTrayMenu();
    if (logWindow && !logWindow.isDestroyed()) {
      logWindow.webContents.send('terminal-output', `\n⚠️ Sync unavailable: ${reason}\n`);
    }
    return;
  }

  console.log('Starting sync via runtime.runSync (channel:', runtimeChannel, ')', ['sync', '--status-server']);
  console.log('Environment - GEMINI_API_KEY:', !!shellEnv.GEMINI_API_KEY);
  console.log('Environment - ANTHROPIC_API_KEY:', !!shellEnv.ANTHROPIC_API_KEY);
  console.log('Environment - OPENAI_API_KEY:', !!shellEnv.OPENAI_API_KEY);
  console.log('Environment - AI_MODEL:', shellEnv.AI_MODEL || 'not set (will use default)');

  // Per-run sync logs are written directly by the Python sync process to
  // ~/Library/Logs/repo-radar/sync-<timestamp>.log (with rotation). We no
  // longer write a duplicate latest-sync.log here — it only captured the
  // noisy rich-formatted UI stream with ANSI codes and progress bars.

  // runtime.runSync() (spec 2A) acquires the root exec lock, verifies `current`,
  // and spawns `<gen>/venv/bin/python <gen>/repo-radar sync --status-server`
  // itself, handing the child back via onChild() so we can wire the same
  // cancellation / output-capture / status-window integration as before.
  // NOTE: runSync() always pipes stdout/stderr internally (it does not read a `stdio`
  // option — the key passed below is inert), so child.stdout/stderr are available for
  // the capture wiring below exactly as with the old direct spawn().
  runtime.runSync({
    home: os.homedir(),
    channel: runtimeChannel,
    env: shellEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    onChild: (child) => {
      currentSyncProcess = child;
      logSyncState('process-spawned');

      // Capture output for the UI + in-memory status
      currentSyncProcess.stdout.on('data', (data) => {
        const output = data.toString();

        if (logWindow && !logWindow.isDestroyed()) {
          logWindow.webContents.send('terminal-output', output);
        }
        const status = loadStatus();
        status.logOutput = (status.logOutput || '') + output;
        saveStatus(status);
      });

      currentSyncProcess.stderr.on('data', (data) => {
        const output = data.toString();

        if (logWindow && !logWindow.isDestroyed()) {
          logWindow.webContents.send('terminal-output', output);
        }
        const status = loadStatus();
        status.logOutput = (status.logOutput || '') + output;
        status.errorLog = (status.errorLog || '') + output;  // Track errors separately
        saveStatus(status);
      });

      currentSyncProcess.on('close', (code) => {
        // The child wrote its receipt just before exiting; absorb it now so lastRunTrigger and
        // lastRunErrors are recorded for ordinary app-launched runs too, not only for runs that
        // happened while we were closed.
        try { reconcileRunReceipt(); } catch (e) { /* never break sync completion */ }
        try {
          console.log('Sync process exited with code:', code);
          logSyncState('process-exited');

          // IMMEDIATE cleanup and UI update - don't wait
          const wasCancelled = syncCancelledByUser;
          currentSyncProcess = null;
          syncCancelledByUser = false;
          stopIconAnimation();
          updateTrayMenu();

          // If user cancelled, stay on idle icon — don't show error
          if (wasCancelled) {
            console.log('Sync was cancelled by user, keeping idle icon');
            const status = loadStatus();
            saveStatus(status);
            updateTrayMenu();
            return;
          }

          // Then handle status update asynchronously
          setTimeout(() => {
            const status = loadStatus();

            console.log('Final status check - hasErrors:', status.hasErrors, 'errors:', status.stats?.errors);

            if (code === 0) {
              status.lastSync = new Date().toISOString();
              // Check if errors were reported via status updates
              if (status.stats && status.stats.errors > 0) {
                console.log('Sync completed but had errors');
                showErrorIcon();
                status.hasErrors = true;
                // Show progress window on errors if it was a background sync
                if (!syncShowWindow) {
                  showLogWindow();
                }
              } else {
                console.log('Sync completed successfully');
                showSuccessIcon();
                status.hasErrors = false;
              }
            } else {
              // Non-zero exit code means error
              console.error('Sync failed with exit code:', code);
              showErrorIcon();
              status.hasErrors = true;
              // Show progress window on errors if it was a background sync
              if (!syncShowWindow) {
                showLogWindow();
              }
            }

            saveStatus(status);
            updateTrayMenu();
          }, 500); // Wait 500ms for final status updates to arrive
        } catch (e) {
          console.error('Error in exit handler:', e);
          // Force cleanup anyway to prevent stuck state
          currentSyncProcess = null;
          stopIconAnimation();
          updateTrayMenu();
        }
      });

      currentSyncProcess.on('error', (err) => {
        try {
          console.error('Failed to start sync process:', err);
          logSyncState('process-error');

          // IMMEDIATE cleanup
          currentSyncProcess = null;
          stopIconAnimation();

          const status = loadStatus();
          status.hasErrors = true;
          status.errorLog = `Failed to start sync: ${err.message}`;
          saveStatus(status);

          showErrorIcon();
          updateTrayMenu();
        } catch (e) {
          console.error('Error in error handler:', e);
          // Force cleanup
          currentSyncProcess = null;
          stopIconAnimation();
          updateTrayMenu();
        }
      });
    },
  }).catch((e) => {
    if (e && e.code === 75) {
      // LockBusy (runtime/lock.js): the root exec lock is already held by
      // another sync (manual or scheduled, either channel) — onChild() never
      // ran, so there's no child/process-error path for this.
      console.warn('Sync already running (root lock busy), ignoring Sync Now click');
      if (Notification.isSupported()) {
        new Notification({
          title: getAppDisplayName(),
          body: 'A sync is already running.'
        }).show();
      }
      return;
    }

    // runSync rejected before ever spawning a child (e.g. verifyRuntime failed
    // on the resolved `current`, or the lock/venv/python resolution itself
    // failed) — there is no child here, so this mirrors the child 'error'
    // handler's cleanup + surfacing above.
    console.error('runSync failed to start sync:', e);
    logSyncState('runsync-error');
    currentSyncProcess = null;
    stopIconAnimation();

    const status = loadStatus();
    status.hasErrors = true;
    status.errorLog = (status.errorLog || '') + `\nFailed to start sync: ${e.message}\n`;
    saveStatus(status);

    showErrorIcon();
    updateTrayMenu();
  });
}

// Show log window
function showLogWindow() {
  if (logWindow && !logWindow.isDestroyed()) {
    logWindow.show();
    logWindow.focus();
    return;
  }
  
  // Get screen dimensions and use 2/3 of the screen
  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
  
  const windowWidth = Math.floor(screenWidth * 0.67);  // 2/3 of screen width
  const windowHeight = Math.floor(screenHeight * 0.67); // 2/3 of screen height
  
  logWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    minWidth: 900,
    minHeight: 600,
    title: `${getAppDisplayName()} - Progress`,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false  // Need this for require() to work
    },
    show: false,
    center: true  // Center the window on screen
  });
  
  logWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  
  logWindow.once('ready-to-show', () => {
    logWindow.show();
  });
  
  // After the window finishes loading, decide what to show:
  //   1. Fresh sync (pendingFreshSync): skip — sendSyncStartedWhenReady will
  //      deliver the authoritative sync-started event with the live repos list.
  //   2. Mid-sync reopen (currentSyncProcess active, flag not set): replay the
  //      current live state from disk so the new renderer rebuilds its DOM
  //      rows and can receive subsequent progress-update events.
  //   3. Idle reopen: replay the most recent completed sync's status.
  logWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      if (pendingFreshSync) {
        console.log('Fresh sync pending, skipping replay (sendSyncStartedWhenReady will send sync-started)');
        return;
      }

      const status = loadStatus();

      if (currentSyncProcess) {
        // Mid-sync reopen: the sync is running but no sync-started event is
        // queued for this new window. Rebuild the view from persisted live
        // state so incoming progress-update events land on existing DOM rows.
        const liveRepos = (status.syncRepos && status.syncRepos.length > 0)
          ? status.syncRepos
          : (status.repos || []).map(r => ({ name: r.name, fullName: r.name, color: r.color || 'cyan' }));

        if (liveRepos.length === 0) {
          console.log('Mid-sync reopen but no repos on disk to replay');
          return;
        }

        console.log('Mid-sync reopen: replaying live state for', liveRepos.length, 'repos');
        logWindow.webContents.send('sync-started', { total: liveRepos.length, repos: liveRepos });

        (status.repos || []).forEach(repo => {
          logWindow.webContents.send('progress-update', {
            repo: repo.name,
            status: repo.status,
            percent: repo.percent || 0,
            color: repo.color || 'cyan'
          });
        });
        return;
      }

      // Idle reopen: replay the most recent completed sync.
      if (status.repos && status.repos.length > 0) {
        logWindow.webContents.send('sync-started', { total: status.stats?.total || status.repos.length, repos: status.repos.map(r => ({ name: r.name, fullName: r.name, color: r.color || 'cyan' })) });

        // Send each repo's final state
        status.repos.forEach(repo => {
          logWindow.webContents.send('progress-update', {
            repo: repo.name,
            status: repo.status,
            percent: repo.percent || 100,
            color: repo.color || 'cyan'
          });
        });

        // Update stats
        if (status.stats) {
          logWindow.webContents.send('sync-complete', status.stats);
        }
      }
    }, 100);
  });
  
  logWindow.on('closed', () => {
    logWindow = null;
  });
}

// Show settings window
function showSettingsWindow() {
  // Never open Settings while an unresolved model notice is up (Codex code-review): a stale
  // Settings snapshot could clobber the notice's write. Focus the notice instead. The notice's
  // own "Review Models" path first finalizes + destroys the notice, so this guard is already
  // false by the time it calls showSettingsWindow, and Settings opens normally.
  if (modelUpdateWindow && !modelUpdateWindow.isDestroyed()) {
    modelUpdateWindow.focus();
    return;
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  
  // Get screen dimensions and use 2/3 of the screen
  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
  
  const windowWidth = Math.floor(screenWidth * 0.67);  // 2/3 of screen width
  const windowHeight = Math.floor(screenHeight * 0.67); // 2/3 of screen height
  
  settingsWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    minWidth: 1000,  // Minimum width to ensure UI looks good
    minHeight: 700,  // Minimum height
    title: 'Settings - Repo Radar',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    show: false,
    center: true  // Center the window on screen
  });
  
  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  
  settingsWindow.once('ready-to-show', () => {
    settingsWindow.show();
  });
  
  // Load config when window is ready
  settingsWindow.webContents.once('did-finish-load', () => {
    loadConfigAndSend();
  });
  
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

// Show error window
function sendErrorData(win) {
  const status = loadStatus();
  win.webContents.send('error-log-loaded', {
    errors: status.errorList || [],
    errorLog: status.errorLog || ''
  });
}

function showErrorWindow() {
  if (errorWindow && !errorWindow.isDestroyed()) {
    errorWindow.show();
    errorWindow.focus();
    // Re-send error data to refresh the display
    sendErrorData(errorWindow);
    return;
  }

  errorWindow = new BrowserWindow({
    width: 800,
    height: 600,
    title: 'Sync Errors',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    show: false
  });

  errorWindow.loadFile(path.join(__dirname, 'renderer', 'error.html'));

  errorWindow.once('ready-to-show', () => {
    errorWindow.show();
    // Push error data after window is ready (don't rely solely on renderer requesting it)
    setTimeout(() => sendErrorData(errorWindow), 100);
  });

  errorWindow.on('closed', () => {
    errorWindow = null;
  });
}

// Load config and send to settings window
function loadConfigAndSend() {
  const configFile = path.join(CONFIG_DIR, 'config.json');
  let config = null;
  
  try {
    if (fs.existsSync(configFile)) {
      config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading config:', e);
  }
  
  // If no schedule in config, try to detect from existing LaunchAgent
  if (config && !config.schedule) {
    const detectedSchedule = detectExistingSchedule();
    if (detectedSchedule) {
      config.schedule = detectedSchedule;
    }
  }
  
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('config-loaded', config);
  }
}

// Detect existing LaunchAgent schedule
function detectExistingSchedule() {
  try {
    const plistFile = getPlistFile();

    // getPlistFile() is null when the build channel is unresolved (fail
    // closed) — fs.existsSync(null) is safely false, but bail explicitly so
    // it reads the same way as the other channel-dependent guards.
    if (!plistFile || !fs.existsSync(plistFile)) {
      return null;
    }
    
    const plistContent = fs.readFileSync(plistFile, 'utf8');
    
    // Parse the plist (simple parsing for our known structure)
    const schedule = {
      enabled: true,
      type: 'daily',
      time: '09:00',
      interval: 6,
      days: [1, 2, 3, 4, 5]
    };
    
    // Check for StartInterval (hourly)
    const intervalMatch = plistContent.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/);
    if (intervalMatch) {
      schedule.type = 'hourly';
      schedule.interval = Math.floor(parseInt(intervalMatch[1]) / 3600);
      return schedule;
    }
    
    // Check for StartCalendarInterval (daily or weekly)
    const hourMatch = plistContent.match(/<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/);
    const minuteMatch = plistContent.match(/<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/);
    
    if (hourMatch && minuteMatch) {
      const hour = hourMatch[1].padStart(2, '0');
      const minute = minuteMatch[1].padStart(2, '0');
      schedule.time = `${hour}:${minute}`;
      
      // Check for Weekday (weekly)
      const weekdayMatches = plistContent.match(/<key>Weekday<\/key>\s*<integer>(\d+)<\/integer>/g);
      if (weekdayMatches && weekdayMatches.length > 0) {
        schedule.type = 'weekly';
        schedule.days = weekdayMatches.map(m => {
          const match = m.match(/(\d+)/);
          return match ? parseInt(match[1]) : 1;
        });
      } else {
        schedule.type = 'daily';
      }
    }
    
    console.log('Detected existing schedule:', schedule);
    return schedule;
    
  } catch (e) {
    console.error('Error detecting schedule:', e);
    return null;
  }
}

// Save config
function saveConfigToFile(config) {
  const configFile = path.join(CONFIG_DIR, 'config.json');

  try {
    // Ensure directory exists
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }

    // Dev ownership isolation (Codex I3, spec 2A §3.3): config.json is shared
    // across channels (repos/API keys/model are meant to be shared), but its
    // `schedule` field drives a persistent LaunchAgent, which dev must never
    // install or mutate (see updateLaunchAgent()'s unconditional dev block
    // below). Preserve whatever schedule is already on disk instead of
    // persisting whatever a dev build's settings window sent — the renderer
    // has no way to know it shouldn't be touching the shared schedule, so
    // main.js protects it here regardless of what's in the incoming payload.
    let toWrite = config;
    if (runtimeChannel === 'dev') {
      let onDiskSchedule;
      try {
        if (fs.existsSync(configFile)) {
          onDiskSchedule = JSON.parse(fs.readFileSync(configFile, 'utf8')).schedule;
        }
      } catch (_) {
        // No readable on-disk schedule to preserve — fall through with none.
      }
      toWrite = { ...config, schedule: onDiskSchedule };
    }

    // This file holds the GitHub token and every provider API key, so it must be owner-only.
    // writeFileSync's mode applies only when CREATING, so a new config would otherwise inherit
    // the umask and land 0644; and because overwriting preserves the existing mode, a file
    // already created 0644 by an older build would stay world-readable forever. Hence both:
    // the mode for creation, and an explicit chmod that also tightens pre-existing files.
    // (Same belt-and-braces treatment as the LaunchAgent writer below.)
    fs.writeFileSync(configFile, JSON.stringify(toWrite, null, 2), { mode: 0o600 });
    fs.chmodSync(configFile, 0o600);
    return { success: true };
  } catch (e) {
    console.error('Error saving config:', e);
    return { success: false, error: e.message };
  }
}

// Update LaunchAgent with new schedule.
//
// `config` is optional: ensureRuntime() (runtime/index.js) invokes this as
// `hooks.repointSchedule()` — called with ZERO arguments — after a legacy
// bootstrap activation on the stable channel, so it can re-point an existing
// schedule at the new generic run-sync.sh. When called without a config we
// load the current saved one from disk; if there's no saved schedule (or
// scheduling isn't enabled) this is a no-op, exactly like a fresh install.
function updateLaunchAgent(config) {
  try {
    // Fail-closed (channel-first, spec 2A maintainer addition): with no
    // resolved channel we don't know which plist/label is safe to touch, so
    // refuse before computing plistFile/AGENT_LABEL at all — never fall
    // through to a guessed (stable) label. Checked first, before even loading
    // config, so it applies to every call path including the schedule-disable
    // branch below.
    if (!runtimeChannel) {
      return { success: false, error: 'Cannot configure the sync schedule: build channel could not be determined (see runtime setup error).' };
    }

    if (!config) {
      const configFile = path.join(CONFIG_DIR, 'config.json');
      config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
    }

    const schedule = config.schedule || { enabled: false };
    const plistFile = getPlistFile();
    const logDir = path.join(process.env.HOME, 'Library', 'Logs', 'repo-radar');

    // Ensure log directory exists
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    if (!schedule.enabled) {
      // Disable by unloading (harmless/good hygiene for either channel — e.g.
      // unloading a dev plist a previous app version may have installed).
      if (fs.existsSync(plistFile)) {
        try {
          spawn('launchctl', ['unload', plistFile], { stdio: 'ignore' });
        } catch (e) {
          // Ignore errors
        }
      }
      return { success: true };
    }

    // Dev ownership isolation (Codex I3, spec 2A §3.3): dev must NEVER
    // install a persistent LaunchAgent or write schedule fields into the
    // shared config.json (see saveConfigToFile()'s schedule-preserving
    // guard) — a dev transient smoke agent is a separate, deliberate
    // operator action outside this app, not something Sync Now/Settings
    // auto-installs. This is unconditional: unlike the old behavior, even a
    // healthy/managed stable install does not make it safe for THIS app to
    // persist a *dev* schedule into the shared plist/config namespace.
    if (runtimeChannel === 'dev') {
      return {
        success: false,
        error: 'Dev builds cannot install a persistent sync schedule. Use "Sync Now" for on-demand dev syncs — a scheduled dev smoke agent must be set up manually, outside this app.'
      };
    }

    // Point at the generic, self-verifying runner ensureRuntime() emits
    // (runtime/dispatchers.js) — it takes no baked interpreter/PATH/env; it
    // resolves + verifies `current` itself at run time. This replaces the old
    // ~/.config/repo-radar/run-sync.sh wrapper generation entirely.
    const runSyncScript = layout(os.homedir(), runtimeChannel).runSync;
    if (!fs.existsSync(runSyncScript)) {
      return { success: false, error: 'Runtime not ready yet — try again after startup finishes (or after the next successful sync).' };
    }

    // Generate plist based on schedule type
    let calendarInterval = '';

    if (schedule.type === 'daily') {
      const [hour, minute] = (schedule.time || '09:00').split(':');
      calendarInterval = `    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>${parseInt(hour)}</integer>
        <key>Minute</key>
        <integer>${parseInt(minute)}</integer>
    </dict>`;
    } else if (schedule.type === 'hourly') {
      const intervalSeconds = (schedule.interval || 6) * 3600;
      calendarInterval = `    <key>StartInterval</key>
    <integer>${intervalSeconds}</integer>`;
    } else if (schedule.type === 'weekly') {
      const [hour, minute] = (schedule.time || '09:00').split(':');
      const days = schedule.days || [1, 2, 3, 4, 5];

      // For weekly, we need multiple calendar intervals
      const intervals = days.map(day => `    <dict>
        <key>Weekday</key>
        <integer>${day}</integer>
        <key>Hour</key>
        <integer>${parseInt(hour)}</integer>
        <key>Minute</key>
        <integer>${parseInt(minute)}</integer>
    </dict>`).join('\n    ');

      calendarInterval = `    <key>StartCalendarInterval</key>
    <array>
${intervals}
    </array>`;
    }

    // API keys + model now live in the plist's own EnvironmentVariables
    // (launchd-native) instead of a generated wrapper script, since the
    // generic run-sync.sh takes no baked env. The Python side only ever reads
    // these via os.getenv(...) (see repo_radar/llm.py, modes/sync.py) — it
    // does not read them out of config.json itself.
    const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let envVarsXml = '';
    const addEnvVar = (key, value) => {
      envVarsXml += `        <key>${key}</key>
        <string>${xmlEscape(value)}</string>
`;
    };
    if (config.github_token) addEnvVar('GITHUB_TOKEN', config.github_token);
    if (config.gemini_api_key) addEnvVar('GEMINI_API_KEY', config.gemini_api_key);
    if (config.anthropic_api_key) addEnvVar('ANTHROPIC_API_KEY', config.anthropic_api_key);
    if (config.openai_api_key) addEnvVar('OPENAI_API_KEY', config.openai_api_key);
    addEnvVar('AI_MODEL', migrateModel(config.ai_model || DEFAULT_MODEL));
    addEnvVar('REPO_RADAR_STATUS_PORT', String(STATUS_PORT));
    // State the provenance instead of letting the sync infer it. Runs launched by THIS plist
    // are scheduled by definition; the old code guessed from "is a window being shown", so
    // launchd runs logged themselves as manual and the two were indistinguishable. The same
    // declared trigger is recorded in the completion receipt.
    addEnvVar('REPO_RADAR_TRIGGER', 'scheduled');

    // Generate plist
    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${AGENT_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${runSyncScript}</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
${envVarsXml}    </dict>

${calendarInterval}

    <key>StandardOutPath</key>
    <string>${logDir}/sync.log</string>

    <key>StandardErrorPath</key>
    <string>${logDir}/sync.error.log</string>

    <key>RunAtLoad</key>
    <false/>

    <key>SuccessfulExit</key>
    <true/>
</dict>
</plist>
`;

    // Write plist atomically with 0600 enforced even when REWRITING an
    // existing file (Codex I8): fs.writeFileSync's `mode` option only applies
    // when the file is being CREATED (open() O_CREAT) — rewriting an existing
    // plist (e.g. a 0644 one left over from before schedules carried API
    // keys, or one restored by some other tool) would silently keep it
    // world-readable, same class of data as the runtime module's own
    // desired.json. Write a fresh temp file (created fresh, so `mode` does
    // apply), rename it over the target (atomic on the same volume, so
    // launchd/other readers never observe a partial write), then chmod
    // explicitly as a belt-and-braces guarantee independent of whatever mode
    // the temp file actually landed with.
    const plistTmp = `${plistFile}.${process.pid}.tmp`;
    fs.writeFileSync(plistTmp, plistContent, { mode: 0o600 });
    fs.renameSync(plistTmp, plistFile);
    fs.chmodSync(plistFile, 0o600);

    // Reload LaunchAgent
    spawn('launchctl', ['unload', plistFile], { stdio: 'ignore' });
    setTimeout(() => {
      spawn('launchctl', ['load', plistFile], { stdio: 'ignore' });
    }, 500);

    return { success: true };
  } catch (e) {
    console.error('Error updating LaunchAgent:', e);
    return { success: false, error: e.message };
  }
}

// IPC handlers
ipcMain.on('load-config', (event) => {
  const configFile = path.join(CONFIG_DIR, 'config.json');
  let config = null;
  
  try {
    if (fs.existsSync(configFile)) {
      config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      console.log('Loaded config with', config.repositories?.length || 0, 'repositories');
    } else {
      console.log('Config file not found at:', configFile);
    }
  } catch (e) {
    console.error('Error loading config:', e);
  }
  
  // Send config back to the sender (the renderer that requested it)
  event.reply('config-loaded', config);
});

ipcMain.on('load-error-log', (event) => {
  const status = loadStatus();
  event.reply('error-log-loaded', {
    errors: status.errorList || [],
    errorLog: status.errorLog || ''
  });
});

ipcMain.on('open-error-window', (event) => {
  showErrorWindow();
});

ipcMain.on('clear-errors', (event) => {
  const status = loadStatus();
  status.errorList = [];
  status.errorLog = '';
  status.hasErrors = false;
  saveStatus(status);
  updateTrayMenu();
  
  // Notify error window if open
  if (errorWindow && !errorWindow.isDestroyed()) {
    errorWindow.webContents.send('error-log-loaded', {
      errors: [],
      errorLog: ''
    });
  }
});

ipcMain.on('save-config', (event, config) => {
  // Unified save+reconcile primitive (shared with the model-notice finalize path), but the
  // Settings reply semantics are preserved EXACTLY as before this refactor: a schedule-only
  // failure still surfaces INLINE in the Settings window as config-saved(false, ...) rather than
  // flipping to success + a separate tray warning.
  const res = persistConfig(config, { reconcileSchedule: true, save: saveConfigToFile, reconcile: updateLaunchAgent });
  const scheduleFailed = res.ok && res.schedule && res.schedule.ok === false;

  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (scheduleFailed) {
      console.error('Failed to update LaunchAgent:', res.schedule.error);
      settingsWindow.webContents.send('config-saved', false, 'Config saved but failed to update schedule: ' + (res.schedule.error || ''));
    } else {
      settingsWindow.webContents.send('config-saved', res.ok, res.error);
    }
  }

  // Update tray menu to reflect new repo count (only on a fully-successful save, as before)
  if (res.ok && !scheduleFailed) {
    setTimeout(() => {
      updateTrayMenu();
    }, 500);
  }
});

// Get version info handler
ipcMain.on('get-version', (event) => {
  if (!versionInfo) loadVersionInfo();
  event.reply('version-info', versionInfo);
});

// Stop sync handler with aggressive termination
ipcMain.on('stop-sync', (event) => {
  console.log('⏹ Stop sync requested by user');
  logSyncState('before-stop');
  
  if (!currentSyncProcess) {
    console.log('No sync process running');
    return;
  }
  
  console.log('Attempting to terminate sync process (PID:', currentSyncProcess.pid, ')');
  
  // Track if process actually terminates
  let processTerminated = false;
  
  // Listen for process exit
  currentSyncProcess.once('exit', (code, signal) => {
    console.log('✓ Sync process terminated (code:', code, 'signal:', signal, ')');
    processTerminated = true;
  });
  
  try {
    // Try graceful SIGTERM first
    currentSyncProcess.kill('SIGTERM');
    console.log('Sent SIGTERM to sync process');
    
    // Check if process responded after 1 second
    setTimeout(() => {
      if (!processTerminated && currentSyncProcess) {
        console.log('⚠️  Process did not respond to SIGTERM, sending SIGKILL...');
        try {
          currentSyncProcess.kill('SIGKILL');
          console.log('Sent SIGKILL to sync process');
        } catch (e) {
          console.error('Failed to send SIGKILL:', e);
        }
      }
    }, 1000);
    
    // Final check after 3 seconds - kill via system if needed
    setTimeout(() => {
      if (!processTerminated && currentSyncProcess && currentSyncProcess.pid) {
        console.log('⚠️  Process still running, attempting system kill...');
        try {
          const { spawn } = require('child_process');
          spawn('kill', ['-9', currentSyncProcess.pid.toString()], { stdio: 'ignore' });
          console.log('Executed system kill -9');
        } catch (e) {
          console.error('Failed system kill:', e);
        }
      }
      
      // Force cleanup regardless
      if (currentSyncProcess) {
        console.log('Force cleaning up process reference');
        currentSyncProcess.removeAllListeners();
        currentSyncProcess = null;
      }
    }, 3000);
    
  } catch (e) {
    console.error('Error killing sync process:', e);
  }
  
  // Mark as user-cancelled so the close handler doesn't show error icon
  syncCancelledByUser = true;

  // Update status immediately (don't wait for process to exit)
  const status = loadStatus();
  status.logOutput = (status.logOutput || '') + '\n\n⏹ Sync cancelled by user\n';
  saveStatus(status);

  // Stop icon animation
  stopIconAnimation();
  updateTrayMenu();
  
  // Notify renderer
  if (logWindow && !logWindow.isDestroyed()) {
    logWindow.webContents.send('sync-stopped');
    logWindow.webContents.send('terminal-output', '\n\n⏹ Sync cancelled by user\n\n');
  }
});

ipcMain.handle('model-notice:get', (event) => modelNoticeController ? modelNoticeController.getView(event.sender) : null);
ipcMain.on('model-notice:action', (event, action) => { if (modelNoticeController) modelNoticeController.onAction(event.sender, action); });

// Check if we need to catch up on a missed sync
// Adopt a completion receipt written by a sync that ran while this app was closed.
//
// Progress is reported to an in-process status server, and only this process persists
// lastSync — so a scheduled run at 9am with the app closed completed successfully and left
// lastSync untouched. That made the tray show a stale time AND made checkMissedSync() believe
// the sync never happened, so it could launch a redundant paid sync. Python writes the receipt
// and never touches status.json; this reads the receipt and never has Python write status.json,
// so there is exactly one writer per file.
// Tighten an existing config at startup. The writers now create 0600, but an upgraded user who
// never opens Settings and never gets an actionable notice would otherwise keep a legacy 0644
// config — holding four API keys — indefinitely. Idempotent and silent when already correct.
function hardenExistingConfig() {
  try {
    const configFile = path.join(process.env.HOME, '.config', 'repo-radar', 'config.json');
    if (!fs.existsSync(configFile)) return false;
    const mode = fs.statSync(configFile).mode & 0o777;
    if (mode === 0o600) return false;
    fs.chmodSync(configFile, 0o600);
    console.log(`Tightened config permissions from ${mode.toString(8)} to 600`);
    return true;
  } catch (e) {
    console.error('Could not tighten config permissions:', e.message);
    return false;
  }
}

function reconcileRunReceipt() {
  try {
    const receiptFile = path.join(path.dirname(STATUS_FILE), `last-run-${runtimeChannel}.json`);
    if (!fs.existsSync(receiptFile)) return null;
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    const before = loadStatus();
    const plan = planReconcile(receipt, before, { channel: runtimeChannel });
    if (!plan.adopt) return null;
    saveStatus(plan.status);
    try { updateTrayMenu(); } catch (e) { /* tray may not exist yet at startup */ }
    console.log(`Adopted ${receipt.trigger} run finished ${receipt.finishedAt}`
      + ` (${plan.reason}; lastSync ${plan.advanceLastSync ? 'advanced' : 'unchanged'})`);
    return receipt;
  } catch (e) {
    console.error('Could not reconcile run receipt:', e.message);
    return null;
  }
}

// A catch-up decision made now can be stale by the time a delayed launch fires: the real
// scheduled run may finish and write its receipt during the wait, and the exec lock will be free
// again — so the callback would start a second, redundant paid sync. Re-reconcile and re-ask the
// question immediately before launching.
function scheduleCatchUpSync(delayMs, decide) {
  setTimeout(() => {
    if (currentSyncProcess) return;
    reconcileRunReceipt();
    if (typeof decide === 'function' && !decide(loadStatus())) {
      console.log('Catch-up no longer needed — a run completed while we waited');
      return;
    }
    // Hand the worker the watermark this decision was based on. The lock is acquired inside the
    // worker, so only the worker can make the final, race-free call.
    triggerSync({ showWindow: false, trigger: 'catchup',
                  notBefore: (loadStatus() || {}).lastSync || '' });
  }, delayMs);
}

// Would a catch-up still be warranted right now? Re-asked immediately before a delayed launch,
// because the scheduled run may have finished during the wait — in which case launching would be
// a second, redundant paid sync.
function stillNeedsCatchUp() {
  try {
    if (currentSyncProcess) return false;
    const configFile = path.join(process.env.HOME, '.config', 'repo-radar', 'config.json');
    if (!fs.existsSync(configFile)) return false;      // config removed during the delay
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    return needsCatchUp(config, loadStatus(), new Date());
  } catch (e) {
    return false;                                       // never launch a paid sync off a bad read
  }
}

function checkMissedSync() {
  // Don't check if a sync is already running
  if (currentSyncProcess) {
    console.log('Sync already running, skipping missed sync check');
    return;
  }

  // Adopt any run that completed while we were closed BEFORE deciding whether one was missed,
  // otherwise a completed scheduled sync looks like a missed one and gets needlessly repeated.
  reconcileRunReceipt();

  const status = loadStatus();
  
  // Don't check if status shows syncing in progress
  if (status.syncing) {
    console.log('Sync in progress (per status), skipping missed sync check');
    return;
  }
  
  const configFile = path.join(CONFIG_DIR, 'config.json');
  
  try {
    if (!fs.existsSync(configFile)) {
      return; // No config, nothing to check
    }
    
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const schedule = config.schedule;
    
    if (!schedule || !schedule.enabled) {
      return; // Scheduling not enabled
    }
    
    const lastSync = status.lastSync ? new Date(status.lastSync) : null;
    const now = new Date();
    
    // If never synced before, definitely need to sync
    if (!lastSync) {
      console.log('No previous sync found, triggering initial sync...');
      scheduleCatchUpSync(5000, () => stillNeedsCatchUp());
      return;
    }
    
    const hoursSinceLastSync = (now - lastSync) / (1000 * 60 * 60);
    
    if (schedule.type === 'daily') {
      // Check if we missed today's sync
      const [schedHour, schedMin] = (schedule.time || '09:00').split(':').map(Number);
      const todayScheduled = new Date(now.getFullYear(), now.getMonth(), now.getDate(), schedHour, schedMin);
      
      // If it's past the scheduled time today and last sync was before today's scheduled time
      if (now > todayScheduled && lastSync < todayScheduled) {
        console.log(`Missed scheduled sync at ${schedule.time}, catching up now...`);
        scheduleCatchUpSync(5000, () => stillNeedsCatchUp());
        return;
      }
    } else if (schedule.type === 'hourly') {
      // Check if we're past the interval
      const interval = schedule.interval || 6;
      if (hoursSinceLastSync >= interval) {
        console.log(`Last sync was ${hoursSinceLastSync.toFixed(1)} hours ago, interval is ${interval} hours. Catching up...`);
        scheduleCatchUpSync(5000, () => stillNeedsCatchUp());
        return;
      }
    } else if (schedule.type === 'weekly') {
      // Check if today is a scheduled day and we haven't synced today
      const today = now.getDay(); // 0 = Sunday
      const scheduledDays = schedule.days || [];
      
      if (scheduledDays.includes(today)) {
        const [schedHour, schedMin] = (schedule.time || '09:00').split(':').map(Number);
        const todayScheduled = new Date(now.getFullYear(), now.getMonth(), now.getDate(), schedHour, schedMin);
        
        if (now > todayScheduled && lastSync < todayScheduled) {
          console.log(`Missed scheduled sync on ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][today]} at ${schedule.time}, catching up...`);
          scheduleCatchUpSync(5000, () => stillNeedsCatchUp());
          return;
        }
      }
    }
    
    console.log('No missed sync detected. Last sync:', lastSync.toISOString());
  } catch (e) {
    console.error('Error checking for missed sync:', e);
  }
}

// Auto-updater setup
function setupAutoUpdater() {
  const appName = getAppDisplayName();
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  // Dev builds check pre-releases, prod only checks stable releases
  if (isDevBuild()) {
    autoUpdater.allowPrerelease = true;
    console.log('Auto-updater: dev channel (pre-releases enabled)');
  } else {
    autoUpdater.allowPrerelease = false;
    console.log('Auto-updater: stable channel');
  }

  autoUpdater.on('update-available', (info) => {
    console.log('Update available:', info.version);
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Available',
      message: `${appName} v${info.version} is available`,
      detail: `You are currently running v${app.getVersion()}. Would you like to download the update?`,
      buttons: ['Download', 'Later'],
      defaultId: 0
    }).then((result) => {
      if (result.response === 0) {
        autoUpdater.downloadUpdate();
        if (Notification.isSupported()) {
          new Notification({
            title: appName,
            body: 'Downloading update in the background...'
          }).show();
        }
      }
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('Update downloaded:', info.version);
    // NOTE (spec 2A): quitAndInstall() below fully relaunches the app on the
    // new build, which re-runs app.whenReady() from scratch — so the
    // ensureRuntime() reconcile there already covers the post-update runtime
    // check (new version -> identity mismatch against the old `desired.json`
    // -> managed-update transition -> new generation provisioned + activated).
    // No separate post-update hook is needed here.
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: `${appName} v${info.version} has been downloaded`,
      detail: 'The update will be installed when you restart the app. Restart now?',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0
    }).then((result) => {
      if (result.response === 0) {
        autoUpdater.quitAndInstall();
      }
    });
  });

  autoUpdater.on('error', (err) => {
    console.error('Auto-updater error:', err.message);
  });

  // Check for updates after a short delay
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.log('Update check failed (may be offline):', err.message);
    });
  }, 5000);

  // Check again every 4 hours
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 4 * 60 * 60 * 1000);
}

// App ready
app.whenReady().then(async () => {
  // FIRST, before any await: the config may hold four API keys at a legacy 0644. Runtime
  // provisioning below can take minutes on a new generation, and the tray render and model notice
  // both read config before that resolves — so deferring this left the keys exposed for the whole
  // window. Synchronous, idempotent, cheap.
  hardenExistingConfig();
  // Adopt any run that completed while we were closed BEFORE the first tray render, so the
  // Last Sync label is correct immediately rather than after the 30s refresh. Idempotent: a
  // second call reports already-absorbed.
  try { reconcileRunReceipt(); } catch (e) { /* never block startup */ }

  // NOTE (Codex I6): this used to `pgrep -f "repo-radar sync --status-server"`
  // and `kill -9` every match on every launch, to clean up a sync left behind
  // by a prior app crash. Under the root-lock contract (runtime/lock.js,
  // runtime.runSync()) a surviving sync worker OWNS the inherited lock fd and
  // is a legitimate, still-serializing process — not an orphan — so killing
  // it out from under the lock was actively unsafe. Removed entirely; the
  // lock (acquired by the worker itself, released by the kernel on its death)
  // handles serialization without any app-side process hunting.

  // Create tray
  const icon = createTrayIcon('white', 0);
  if (!icon) {
    console.error('Failed to create tray icon, quitting to avoid invisible process');
    app.quit();
    return;
  }
  tray = new Tray(icon);

  // Safety: if tray creation succeeded but becomes invalid, quit rather than run invisibly
  if (!tray || tray.isDestroyed()) {
    console.error('Tray creation failed silently, quitting to avoid invisible process');
    app.quit();
    return;
  }

  // Update menu initially
  updateTrayMenu();
  
  // Update menu every 30 seconds to keep "Last Sync" time accurate
  setInterval(() => {
    updateTrayMenu();
  }, 30000);
  
  // Also update menu when user clicks the tray icon
  tray.on('click', () => {
    updateTrayMenu();
  });
  
  // Start status server. Skipped when the build channel is unresolved: sync
  // is disabled in that state (see triggerSync()'s runtimeDisabled/!runtimeChannel
  // gate below), so there's nothing to serve, and binding stable's fixed port
  // (STATUS_PORT is null here, not 3847) under a guessed identity is exactly
  // what channel-first fail-closed forbids.
  if (STATUS_PORT) {
    startStatusServer();
  } else {
    console.warn('[runtime] status server not started: build channel unresolved');
  }

  // Load initial status
  const status = loadStatus();
  
  // currentSyncProcess is already null on startup - no stale state possible
  
  // Clear error state from previous runs - start fresh
  // User can view old errors from "View Errors" but icon should be neutral
  console.log('Starting fresh - clearing error state from previous session');
  status.hasErrors = false;
  saveStatus(status);
  
  // Always start with white (idle) icon - no stale error indicators
  stopIconAnimation();  // Ensure not spinning
  const freshIcon = createTrayIcon('white', 0);
  if (freshIcon) {
    tray.setImage(freshIcon);
    tray.setToolTip(`${getAppDisplayName()} ${getVersionString()}`);
  }
  
  // Clean up orphaned files from previous installs
  cleanupOrphans();

  // Reconcile the per-channel Python runtime to this build (spec 2A).
  // `runtimeChannel` was already resolved synchronously at the true top of
  // this file (channel-first, fail-closed — see the block above APP_VERSION),
  // before cleanupOrphans() above and before the status port/LaunchAgent
  // label were even computed. If that resolution failed, surface it now that
  // the tray exists (surfaceRuntimeError() needs `tray`/`Notification`, which
  // aren't available until app.whenReady()). Awaiting ensureRuntime() below
  // does NOT block the event loop: this is an `async` callback, so other
  // Electron events (tray clicks, IPC, timers) still run while it's in flight.
  if (runtimeDisabled && !runtimeChannel) {
    surfaceRuntimeError(runtimeDisabledReason);
  }

  if (runtimeChannel) {
    const hasPackagedResources = !!process.resourcesPath &&
      fs.existsSync(path.join(process.resourcesPath, 'resources', 'repo_radar'));
    const bundle = hasPackagedResources
      ? {
          repoRadarDir: path.join(process.resourcesPath, 'resources', 'repo_radar'),
          launcher: path.join(process.resourcesPath, 'resources', 'repo-radar'),
          versionFile: path.join(process.resourcesPath, 'VERSION'),
          // verify.py is an extraResource (a real on-disk file) because provisioning must COPY
          // it verbatim into each generation dir and hash it — the inputs must be real files.
          // (Not an asar-access limitation: ELECTRON_RUN_AS_NODE can require() from app.asar,
          // which is exactly how the provisioning helper + its runtime/ siblings load.)
          verifyPy: path.join(process.resourcesPath, 'resources', 'verify.py')
        }
      : {
          // Dev-from-source fallback: no resourcesPath payload (electron .
          // points resourcesPath at Electron's own resources, not ours).
          repoRadarDir: path.join(__dirname, '..', 'repo_radar'),
          launcher: path.join(__dirname, '..', 'repo-radar'),
          versionFile: path.join(__dirname, '..', 'VERSION'),
          verifyPy: path.join(__dirname, 'runtime', 'verify.py')
        };

    try {
      // Codex I7a: pass Electron's own app.getVersion() (from package.json),
      // NOT APP_VERSION (the custom VERSION-file reader) — authoritativeIdentity()
      // corroborates appVersion against the bundled VERSION file, and passing
      // APP_VERSION here made that comparison tautological (VERSION file
      // compared against itself). app.getVersion() is a genuinely independent
      // second source. getVersion()/APP_VERSION's cosmetic dialog use (version
      // display strings) is unaffected.
      const res = await runtime.ensureRuntime({
        home: os.homedir(),
        channel: runtimeChannel,
        appVersion: app.getVersion(),
        bundle,
        hooks: {
          onFailure: surfaceRuntimeError,
          repointSchedule: updateLaunchAgent,
          // non-fatal: the runtime + manual sync are healthy, only the scheduled sync
          // may be off. Surface it (Codex round-7 I3) so it isn't silent to the user.
          // This hook fires on EVERY warning path (fast + activated), so it is the single
          // surfacing point — do NOT also read res.scheduleWarning or it double-notifies.
          onScheduleWarning: (msg) => surfaceScheduleWarning(msg)
        }
      });
      if (res.status === 'failed') {
        // ensureRuntime() already invoked hooks.onFailure(redacted reason)
        // internally (surfaceRuntimeError sets runtimeDisabled) — this branch
        // just makes the disabled state explicit here too in case onFailure
        // was ever skipped.
        runtimeDisabled = true;
        runtimeDisabledReason = res.reason || 'runtime setup failed';
      } else {
        console.log('[runtime] ensureRuntime ok:', res.genDir);
      }
    } catch (e) {
      // Defensive only: ensureRuntime() is written to catch internally and
      // resolve {status:'failed'} rather than throw, but don't let an
      // unexpected throw here take down app.whenReady().
      surfaceRuntimeError(`unexpected ensureRuntime error: ${e.message}`);
    }
  }

  buildModelNoticeController();
  modelNoticeController.maybe();

  // Set up auto-updater
  setupAutoUpdater();

  // Check for missed syncs after a short delay (let everything initialize)
  setTimeout(() => {
    reconcileRunReceipt();
    checkMissedSync();
  }, 2000);
  
  // Periodically check for missed syncs every 30 minutes
  // This catches cases where the laptop was asleep at the scheduled time
  setInterval(() => {
    console.log('Periodic check for missed syncs...');
    checkMissedSync();
  }, 30 * 60 * 1000); // 30 minutes in milliseconds
  
  // Fallback safety check (1 minute interval as ultimate backup)
  // This catches extremely rare cases where exit events don't fire
  // Primarily event-driven now, this is just a safety net
  setInterval(() => {
    if (currentSyncProcess && !isSyncing()) {
      console.warn('FALLBACK: Process detected as dead by safety check');
      logSyncState('fallback-check');
      currentSyncProcess = null;
      stopIconAnimation();
      updateTrayMenu();
      
      // Notify renderer if window open
      if (logWindow && !logWindow.isDestroyed()) {
        logWindow.webContents.send('terminal-output', '\n\n⚠️ Process terminated unexpectedly\n\n');
        logWindow.webContents.send('sync-stopped');
      }
    }
  }, 60000); // Check every minute (not 10 seconds)
  
  // Quit if tray disappears (prevents invisible zombie process)
  setInterval(() => {
    if (!tray || tray.isDestroyed()) {
      console.error('Tray icon lost, quitting to avoid invisible process');
      app.quit();
    }
  }, 30000);

  // Prevent dock icon
  if (app.dock) {
    app.dock.hide();
  }
});

app.on('window-all-closed', (e) => {
  e.preventDefault(); // Prevent quit when windows close
});

app.on('before-quit', () => { appIsQuitting = true; });

app.on('before-quit', () => {
  stopIconAnimation();
  if (statusServer) {
    statusServer.close();
  }
  if (currentSyncProcess) {
    currentSyncProcess.kill();
  }
});

