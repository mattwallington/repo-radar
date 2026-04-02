const { app, Tray, Menu, BrowserWindow, ipcMain, nativeImage, clipboard, dialog, Notification } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const { spawn } = require('child_process');

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
  return '2.0.0';
}

const APP_VERSION = getVersion();

// Detect dev build early (before versionInfo is initialized)
const IS_DEV_BUILD = (() => {
  try {
    const buildInfoPath = path.join(__dirname, 'build-info.json');
    if (fs.existsSync(buildInfoPath)) {
      return JSON.parse(fs.readFileSync(buildInfoPath, 'utf8')).channel === 'dev';
    }
  } catch (e) {}
  return false;
})();

// Dev builds use a different port so they don't conflict with production
const STATUS_PORT = IS_DEV_BUILD ? 3848 : 3847;

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

// Get the sync script path (works in both dev and packaged app)
function getSyncScriptPath() {
  // Check if installed in user's home directory (after first run setup)
  const installedPath = path.join(process.env.HOME, '.repo-radar', 'repo-radar');
  if (fs.existsSync(installedPath)) {
    return installedPath;
  }
  
  // Check for bundled resources (packaged app)
  const resourcesPath = process.resourcesPath 
    ? path.join(process.resourcesPath, 'resources', 'repo-radar')
    : null;
  if (resourcesPath && fs.existsSync(resourcesPath)) {
    return resourcesPath;
  }
  
  // Development fallback - check for local version
  const devPath = path.join(__dirname, '..', 'repo-radar');
  if (fs.existsSync(devPath)) {
    return devPath;
  }
  
  // Last resort - user's bin directory (backwards compatibility)
  return path.join(process.env.HOME, 'bin', 'repo-radar');
}

let tray = null;
let logWindow = null;
let settingsWindow = null;
let errorWindow = null;
let statusServer = null;
let currentSyncProcess = null;
let lastStatus = null;
let animationInterval = null;
let animationFrame = 0;
let successTimeout = null;
let versionInfo = null;

// Load version info
function loadVersionInfo() {
  try {
    const buildInfoPath = path.join(__dirname, 'build-info.json');
    if (fs.existsSync(buildInfoPath)) {
      versionInfo = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));
      // Prefer APP_VERSION from VERSION file if available
      if (APP_VERSION !== '2.0.0') {
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

// Uninstall app - remove all persistent files and quit
function uninstallApp() {
  const appName = getAppDisplayName();

  dialog.showMessageBox({
    type: 'warning',
    title: `Uninstall ${appName}`,
    message: `Are you sure you want to uninstall ${appName}?`,
    detail: 'This will remove:\n• Scheduled sync (LaunchAgent)\n• Configuration and status files\n• Log files\n• Wrapper scripts\n\nYour synced repositories will NOT be deleted.',
    buttons: ['Cancel', 'Uninstall'],
    defaultId: 0,
    cancelId: 0
  }).then((result) => {
    if (result.response !== 1) return;

    console.log('Uninstalling...');

    // 1. Unload and remove LaunchAgent
    const plistFile = path.join(process.env.HOME, 'Library', 'LaunchAgents', 'com.user.repo-radar.plist');
    try {
      if (fs.existsSync(plistFile)) {
        spawn('launchctl', ['unload', plistFile], { stdio: 'ignore' });
        fs.unlinkSync(plistFile);
        console.log('Removed LaunchAgent');
      }
    } catch (e) {
      console.error('Error removing LaunchAgent:', e);
    }

    // 2. Remove config directory (~/.config/repo-radar/)
    try {
      if (fs.existsSync(CONFIG_DIR)) {
        fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
        console.log('Removed config directory');
      }
    } catch (e) {
      console.error('Error removing config:', e);
    }

    // 3. Remove log directory (~/Library/Logs/repo-radar/)
    const logDir = path.join(process.env.HOME, 'Library', 'Logs', 'repo-radar');
    try {
      if (fs.existsSync(logDir)) {
        fs.rmSync(logDir, { recursive: true, force: true });
        console.log('Removed log directory');
      }
    } catch (e) {
      console.error('Error removing logs:', e);
    }

    // 4. Remove installed script (~/.repo-radar/)
    const installedDir = path.join(process.env.HOME, '.repo-radar');
    try {
      if (fs.existsSync(installedDir)) {
        fs.rmSync(installedDir, { recursive: true, force: true });
        console.log('Removed installed scripts');
      }
    } catch (e) {
      console.error('Error removing installed scripts:', e);
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
  // Check if a LaunchAgent exists but points to an app that no longer exists
  const plistFile = path.join(process.env.HOME, 'Library', 'LaunchAgents', 'com.user.repo-radar.plist');
  try {
    if (fs.existsSync(plistFile)) {
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
function triggerSync() {
  if (currentSyncProcess) {
    return; // Already syncing
  }
  
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
      const model = config.ai_model || 'gemini/gemini-3-pro-preview';
      if (model.startsWith('gemini/')) {
        if (!config.gemini_api_key) {
          configValid = false;
          validationMessage = '⚠️ Gemini API Key not configured. Metadata generation will be skipped.\n\nPlease configure in Settings → API Configuration.';
        }
      } else if (model.startsWith('claude')) {
        if (!config.anthropic_api_key) {
          configValid = false;
          validationMessage = '⚠️ Anthropic API Key not configured. Metadata generation will be skipped.\n\nPlease configure in Settings → API Configuration.';
        }
      } else if (model.startsWith('gpt') || model.startsWith('o1')) {
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
  
  // Show log window
  showLogWindow();
  
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
    } else {
      console.warn('Log window not available for sync-started event');
    }
  };
  
  // Start checking after 300ms
  setTimeout(sendSyncStartedWhenReady, 300);
  
  // Spawn sync process
  const syncScript = getSyncScriptPath();
  
  // Get environment variables from shell
  const shellEnv = { ...process.env };
  
  // Ensure pyenv shims are in PATH
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
      if (config.ai_model) {
        shellEnv.AI_MODEL = config.ai_model;
        console.log('✓ Loaded AI_MODEL from config:', config.ai_model);
      }
    } else {
      console.warn('⚠️  Config file not found:', configFile);
      console.warn('⚠️  Please configure API keys in Settings before running sync');
    }
  } catch (e) {
    console.error('Error loading config:', e);
  }
  
  console.log('Starting sync:', syncScript, ['sync', '--status-server']);
  console.log('Environment - GEMINI_API_KEY:', !!shellEnv.GEMINI_API_KEY);
  console.log('Environment - ANTHROPIC_API_KEY:', !!shellEnv.ANTHROPIC_API_KEY);
  console.log('Environment - OPENAI_API_KEY:', !!shellEnv.OPENAI_API_KEY);
  console.log('Environment - AI_MODEL:', shellEnv.AI_MODEL || 'not set (will use default)');
  
  // Set PYTHONPATH so the thin wrapper can find the repo_radar package
  const scriptDir = path.dirname(syncScript);
  shellEnv.PYTHONPATH = scriptDir + (shellEnv.PYTHONPATH ? ':' + shellEnv.PYTHONPATH : '');
  shellEnv.REPO_RADAR_STATUS_PORT = String(STATUS_PORT);

  currentSyncProcess = spawn('/usr/bin/env', ['python3', syncScript, 'sync', '--status-server'], {
    env: shellEnv,
    cwd: scriptDir
  });
  
  logSyncState('process-spawned');
  
  // Create log file for this sync run
  const logDir = path.join(process.env.HOME, 'Library', 'Logs', 'repo-radar');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  const syncLogFile = path.join(logDir, 'latest-sync.log');
  const syncLogStream = fs.createWriteStream(syncLogFile, { flags: 'w' });
  
  console.log('Sync log file:', syncLogFile);
  
  // Capture output
  currentSyncProcess.stdout.on('data', (data) => {
    const output = data.toString();
    
    // Write to log file
    syncLogStream.write(output);
    
    if (logWindow && !logWindow.isDestroyed()) {
      logWindow.webContents.send('terminal-output', output);
    }
    const status = loadStatus();
    status.logOutput = (status.logOutput || '') + output;
    saveStatus(status);
  });
  
  currentSyncProcess.stderr.on('data', (data) => {
    const output = data.toString();
    
    // Write to log file
    syncLogStream.write('STDERR: ' + output);
    
    if (logWindow && !logWindow.isDestroyed()) {
      logWindow.webContents.send('terminal-output', output);
    }
    const status = loadStatus();
    status.logOutput = (status.logOutput || '') + output;
    status.errorLog = (status.errorLog || '') + output;  // Track errors separately
    saveStatus(status);
  });
  
  currentSyncProcess.on('close', (code) => {
    try {
      console.log('Sync process exited with code:', code);
      logSyncState('process-exited');
      
      // IMMEDIATE cleanup and UI update - don't wait
      currentSyncProcess = null;
      stopIconAnimation();
      updateTrayMenu();
      
      // Close log file
      if (syncLogStream) {
        syncLogStream.end();
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
  
  // Load previous sync status after window is fully loaded
  // BUT only if a sync is not currently running (otherwise sendSyncStartedWhenReady handles it)
  logWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      // If a sync is actively running, don't replay old data - the sync flow will send fresh data
      if (currentSyncProcess) {
        console.log('Sync in progress, skipping old status replay');
        return;
      }

      const status = loadStatus();

      // If there was a previous sync, show those repos
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
    const plistFile = path.join(process.env.HOME, 'Library', 'LaunchAgents', 'com.user.repo-radar.plist');
    
    if (!fs.existsSync(plistFile)) {
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
    
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    return { success: true };
  } catch (e) {
    console.error('Error saving config:', e);
    return { success: false, error: e.message };
  }
}

// Update LaunchAgent with new schedule
function updateLaunchAgent(config) {
  try {
    const schedule = config.schedule || { enabled: false };
    const plistFile = path.join(process.env.HOME, 'Library', 'LaunchAgents', 'com.user.repo-radar.plist');
    const syncScript = getSyncScriptPath();
    const logDir = path.join(process.env.HOME, 'Library', 'Logs', 'repo-radar');
    
    // Ensure log directory exists
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    if (!schedule.enabled) {
      // Disable by unloading
      if (fs.existsSync(plistFile)) {
        try {
          spawn('launchctl', ['unload', plistFile], { stdio: 'ignore' });
        } catch (e) {
          // Ignore errors
        }
      }
      return { success: true };
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
    
    // Generate a wrapper script that handles pyenv/PATH setup without quoting issues
    const scriptDir = path.dirname(syncScript);
    const wrapperScript = path.join(CONFIG_DIR, 'run-sync.sh');

    // Escape single quotes in paths for safe shell embedding
    const escScriptDir = scriptDir.replace(/'/g, "'\\''");
    const escSyncScript = syncScript.replace(/'/g, "'\\''");

    // Load API keys from config so LaunchAgent has them
    let envExports = '';
    if (config.github_token) {
      envExports += `export GITHUB_TOKEN='${config.github_token.replace(/'/g, "'\\''")}'\n`;
    }
    if (config.gemini_api_key) {
      envExports += `export GEMINI_API_KEY='${config.gemini_api_key.replace(/'/g, "'\\''")}'\n`;
    }
    if (config.anthropic_api_key) {
      envExports += `export ANTHROPIC_API_KEY='${config.anthropic_api_key.replace(/'/g, "'\\''")}'\n`;
    }
    if (config.openai_api_key) {
      envExports += `export OPENAI_API_KEY='${config.openai_api_key.replace(/'/g, "'\\''")}'\n`;
    }
    if (config.ai_model) {
      envExports += `export AI_MODEL='${config.ai_model.replace(/'/g, "'\\''")}'\n`;
    }

    const wrapperContent = `#!/bin/zsh
# Auto-generated by Repo Radar - do not edit
# Set up pyenv if available
if [ -d "$HOME/.pyenv" ]; then
    export PYENV_ROOT="$HOME/.pyenv"
    export PATH="$PYENV_ROOT/shims:$PYENV_ROOT/bin:$PATH"
fi
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
export PYTHONPATH='${escScriptDir}':"$PYTHONPATH"
export REPO_RADAR_STATUS_PORT='${STATUS_PORT}'
${envExports}exec python3 '${escSyncScript}' sync --status-server
`;
    fs.writeFileSync(wrapperScript, wrapperContent, { mode: 0o755 });

    // Generate plist
    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.user.repo-radar</string>

    <key>ProgramArguments</key>
    <array>
        <string>${wrapperScript}</string>
    </array>

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
    
    // Write plist
    fs.writeFileSync(plistFile, plistContent);
    
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
  const result = saveConfigToFile(config);
  
  // If save successful, update LaunchAgent with new schedule
  if (result.success) {
    const updateResult = updateLaunchAgent(config);
    if (!updateResult.success) {
      console.error('Failed to update LaunchAgent:', updateResult.error);
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.send('config-saved', false, 
          'Config saved but failed to update schedule: ' + updateResult.error);
      }
      return;
    }
  }
  
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('config-saved', result.success, result.error);
  }
  
  // Update tray menu to reflect new repo count
  if (result.success) {
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

// Check if we need to catch up on a missed sync
function checkMissedSync() {
  // Don't check if a sync is already running
  if (currentSyncProcess) {
    console.log('Sync already running, skipping missed sync check');
    return;
  }
  
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
      setTimeout(() => triggerSync(), 5000); // Wait 5 seconds after startup
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
        setTimeout(() => triggerSync(), 5000);
        return;
      }
    } else if (schedule.type === 'hourly') {
      // Check if we're past the interval
      const interval = schedule.interval || 6;
      if (hoursSinceLastSync >= interval) {
        console.log(`Last sync was ${hoursSinceLastSync.toFixed(1)} hours ago, interval is ${interval} hours. Catching up...`);
        setTimeout(() => triggerSync(), 5000);
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
          setTimeout(() => triggerSync(), 5000);
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
app.whenReady().then(() => {
  // Kill any orphaned sync processes from previous app crash
  // This handles the case where app crashed while Python was running
  try {
    const { execSync } = require('child_process');
    const result = execSync('pgrep -f "repo-radar sync --status-server"', 
      { encoding: 'utf8', stdio: 'pipe' }).trim();
    
    if (result) {
      console.log('Found orphaned sync process(es), killing:', result);
      execSync(`kill -9 ${result}`, { stdio: 'ignore' });
      console.log('Killed orphaned processes');
    }
  } catch (e) {
    // No orphans found (pgrep returns error if no matches) - this is normal
  }
  
  // Create tray
  const icon = createTrayIcon('white', 0);
  if (!icon) {
    console.error('Failed to create tray icon!');
    return;
  }
  tray = new Tray(icon);
  
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
  
  // Start status server
  startStatusServer();
  
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

  // Set up auto-updater
  setupAutoUpdater();

  // Check for missed syncs after a short delay (let everything initialize)
  setTimeout(() => {
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
  
  // Prevent dock icon
  if (app.dock) {
    app.dock.hide();
  }
});

app.on('window-all-closed', (e) => {
  e.preventDefault(); // Prevent quit when windows close
});

app.on('before-quit', () => {
  stopIconAnimation();
  if (statusServer) {
    statusServer.close();
  }
  if (currentSyncProcess) {
    currentSyncProcess.kill();
  }
});

