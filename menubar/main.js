const { app, Tray, Menu, BrowserWindow, ipcMain, nativeImage } = require('electron');
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

const STATUS_PORT = 3847;
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

// Ensure config directory exists
if (!fs.existsSync(CONFIG_DIR)) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
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
    logOutput: ''
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
      iconPath = path.join(__dirname, 'assets', 'icon.png');
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
    tray.setToolTip('Repo Radar');
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
  tray.setToolTip(`Repo Radar v${APP_VERSION}`);
}

// Update tray menu
function updateTrayMenu() {
  const status = loadStatus();
  
  // Handle icon animation/state
  if (status.syncing) {
    startIconAnimation();
  } else if (status.hasErrors) {
    // Keep showing error icon
    showErrorIcon();
  }
  // Otherwise leave icon as-is (could be green, white, etc.)
  
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
    {
      label: '▶ Sync Now',
      click: () => triggerSync()
    },
    {
      label: status.hasErrors ? '⚠️  View Errors' : '📊 View Progress',
      click: () => status.hasErrors ? showErrorWindow() : showLogWindow()
    },
    {
      label: '⚙️  Settings',
      click: () => showSettingsWindow()
    },
    { type: 'separator' },
    {
      label: `v${APP_VERSION}`,
      enabled: false
    },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      }
    }
  ];
  
  const menu = Menu.buildFromTemplate(menuItems);
  tray.setContextMenu(menu);
}

// Start status server
function startStatusServer() {
  const expressApp = express();
  expressApp.use(bodyParser.json());
  
  expressApp.post('/status', (req, res) => {
    const data = req.body;
    
    console.log('Received status update:', data.type, data.repo || '');
    
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
      
      status.syncing = true;
      saveStatus(status);
      updateTrayMenu();
      
      // Send to renderer
      if (logWindow && !logWindow.isDestroyed()) {
        logWindow.webContents.send('progress-update', data);
      }
    } else if (data.type === 'complete') {
      // Sync complete
      const status = loadStatus();
      status.syncing = false;
      status.lastSync = new Date().toISOString();
      status.stats = data.stats || status.stats;
      
      console.log('Sync complete with stats:', data.stats);
      
      // Update icon based on success/error
      if (data.stats && data.stats.errors > 0) {
        console.log('Sync had errors:', data.stats.errors);
        showErrorIcon();
        status.hasErrors = true;
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
      }
      
      // Show notification
      if (data.stats.errors > 0) {
        if (tray.displayBalloon) {
          tray.displayBalloon({
            title: 'Sync Complete (with errors)',
            content: `${data.stats.errors} error${data.stats.errors !== 1 ? 's' : ''} occurred during sync`
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
  
  // Reset status
  const status = loadStatus();
  status.syncing = true;
  status.logOutput = '';
  status.errorLog = '';  // Clear previous errors
  status.repos = [];
  saveStatus(status);
  updateTrayMenu();
  
  // Show log window
  showLogWindow();
  
  // Notify window that sync is starting
  if (logWindow && !logWindow.isDestroyed()) {
    // Load config to get repo count
    const configFile = path.join(CONFIG_DIR, 'config.json');
    let repoCount = 0;
    try {
      if (fs.existsSync(configFile)) {
        const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        repoCount = config.repositories?.length || 0;
      }
    } catch (e) {
      console.error('Error loading config for repo count:', e);
    }
    
    logWindow.webContents.send('sync-started', { total: repoCount });
  }
  
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
      }
      if (config.gemini_api_key) {
        shellEnv.GEMINI_API_KEY = config.gemini_api_key;
      }
      if (config.ai_model) {
        shellEnv.AI_MODEL = config.ai_model;
      }
    }
  } catch (e) {
    console.error('Error loading config:', e);
  }
  
  console.log('Starting sync:', syncScript, ['sync', '--status-server']);
  
  currentSyncProcess = spawn('/usr/bin/env', ['python3', syncScript, 'sync', '--status-server'], {
    env: shellEnv,
    cwd: path.dirname(syncScript)
  });
  
  // Capture output
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
    console.log('Sync process exited with code:', code);
    
    // Small delay to ensure final status update is received
    setTimeout(() => {
      currentSyncProcess = null;
      const status = loadStatus();
      
      console.log('Final status check - hasErrors:', status.hasErrors, 'errors:', status.stats?.errors);
      
      status.syncing = false;
      
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
  });
  
  currentSyncProcess.on('error', (err) => {
    console.error('Failed to start sync process:', err);
    currentSyncProcess = null;
    const status = loadStatus();
    status.syncing = false;
    status.hasErrors = true;
    status.errorLog = `Failed to start sync: ${err.message}`;
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
  
  logWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    title: 'Repo Radar - Progress',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false  // Need this for require() to work
    },
    show: false
  });
  
  logWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  
  logWindow.once('ready-to-show', () => {
    logWindow.show();
  });
  
  // Load previous sync status after window is fully loaded
  logWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      const status = loadStatus();
      
      // If there was a previous sync, show those repos
      if (status.repos && status.repos.length > 0) {
        logWindow.webContents.send('sync-started', { total: status.stats?.total || status.repos.length });
        
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
  
  settingsWindow = new BrowserWindow({
    width: 900,
    height: 700,
    title: 'Settings - Repo Radar',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    show: false
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
function showErrorWindow() {
  if (errorWindow && !errorWindow.isDestroyed()) {
    errorWindow.show();
    errorWindow.focus();
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
    
    // Generate plist
    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.user.repo-radar</string>
    
    <key>ProgramArguments</key>
    <array>
        <string>/bin/zsh</string>
        <string>-l</string>
        <string>-c</string>
        <string>source ~/.zshrc 2>/dev/null; ${syncScript} sync --status-server</string>
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
  event.reply('error-log-loaded', status.errorLog || '');
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

// App ready
app.whenReady().then(() => {
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
  loadStatus();
  
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

