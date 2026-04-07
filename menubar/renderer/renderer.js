const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

// Set up logging for renderer
const logDir = path.join(process.env.HOME, 'Library', 'Logs', 'repo-radar');
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}
const rendererLogFile = path.join(logDir, 'renderer.log');

// Create log function that writes to file and console
function log(...args) {
    const timestamp = new Date().toISOString();
    const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
    const logLine = `[${timestamp}] ${message}\n`;
    
    // Write to file
    try {
        fs.appendFileSync(rendererLogFile, logLine);
    } catch (e) {
        console.error('Failed to write to log:', e);
    }
    
    // Also log to console
    console.log(...args);
}

// Clear log on startup
try {
    fs.writeFileSync(rendererLogFile, `=== Renderer Log Started ${new Date().toISOString()} ===\n`);
    log('Renderer initialized');
} catch (e) {
    console.error('Failed to initialize log file:', e);
}

let repoStates = new Map(); // Map of repo name -> { status, percent, color, fullName, details }
let allRepos = []; // List of all repos to sync
let stats = {
    completed: 0,
    running: 0,
    total: 0,
    errors: 0
};

const COLOR_MAP = {
    'cyan': '#11a8cd',
    'red': '#f14c4c',
    'green': '#0dbc79',
    'magenta': '#bc3fbc',
    'yellow': '#e5e510',
    'blue': '#2472c8',
    'bright_cyan': '#29b8db',
    'bright_red': '#ff6b6b',
    'bright_green': '#23d18b',
    'bright_magenta': '#d670d6',
    'bright_yellow': '#f5f543',
    'bright_blue': '#3b8eea'
};

function initProgressView() {
    console.log('Initializing progress view...');
    
    const reposList = document.getElementById('repos-list');
    if (!reposList) {
        console.error('repos-list element not found!');
        return;
    }
    
    reposList.innerHTML = `
        <div class="empty-message">
            <p>Waiting for sync to start...</p>
            <p style="font-size: 12px; color: #606060;">Click "Sync Now" from the menu bar to begin</p>
        </div>
    `;
}

function createRepoProgressItem(repoInfo) {
    const div = document.createElement('div');
    div.className = 'repo-progress-item waiting';
    div.id = `repo-${repoInfo.name}`;
    div.dataset.fullName = repoInfo.fullName || repoInfo.name;
    
    const colorHex = COLOR_MAP[repoInfo.color] || '#4ec9b0';
    
    div.innerHTML = `
        <div class="repo-progress-header">
            <span class="repo-progress-name" style="color: ${colorHex}">${escapeHtml(repoInfo.fullName || repoInfo.name)}</span>
            <span class="repo-progress-status">Waiting...</span>
        </div>
        <div class="repo-progress-bar-container">
            <div class="repo-progress-bar" style="width: 0%; background-color: ${colorHex}"></div>
        </div>
        <div class="repo-details" style="display: none;">
            <span class="repo-detail-item">📦 Loading...</span>
        </div>
    `;
    
    return div;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function updateRepoProgress(repoName, status, percent, color, details) {
    log('=== UPDATE REPO PROGRESS ===');
    log('Repo name:', repoName);
    log('Looking for element ID:', `repo-${repoName}`);
    log('Status:', status, 'Percent:', percent);
    
    // Store the repo state
    repoStates.set(repoName, { status, percent, color, details });
    
    let item = document.getElementById(`repo-${repoName}`);
    
    if (!item) {
        log('ERROR: Element not found for:', repoName);
        log('Available elements:', 
            Array.from(document.querySelectorAll('.repo-progress-item')).map(el => el.id));
        log('repoStates keys:', Array.from(repoStates.keys()));
        return;
    }
    
    log('✓ Found element, updating...');
    
    // Update details if provided
    if (details) {
        updateRepoDetails(repoName, details);
    }
    
    // Update status text
    const statusEl = item.querySelector('.repo-progress-status');
    if (statusEl) {
        statusEl.textContent = status;
    }
    
    // Update progress bar
    const progressBar = item.querySelector('.repo-progress-bar');
    if (progressBar) {
        progressBar.style.width = `${percent}%`;
        
        const colorHex = COLOR_MAP[color] || '#4ec9b0';
        progressBar.style.backgroundColor = colorHex;
    }
    
    // Update item state class
    item.className = 'repo-progress-item';
    const isError = status.includes('✗') || status.includes('error') || status.includes('failed');
    if (percent >= 100) {
        if (isError) {
            item.classList.add('error');
            progressBar?.classList.add('error');
            // Turn progress bar red for errors
            if (progressBar) {
                progressBar.style.backgroundColor = '#f14c4c';
            }
        } else {
            item.classList.add('complete');
            progressBar?.classList.add('complete');
            // Turn progress bar green for completed
            if (progressBar) {
                progressBar.style.backgroundColor = '#0dbc79';
            }
            // Add checkmark to status
            if (statusEl && !statusEl.textContent.includes('✓')) {
                statusEl.innerHTML = statusEl.textContent + ' <span style="color: #0dbc79;">✓</span>';
            }
        }
    } else if (percent > 0) {
        item.classList.add('syncing');
    } else {
        item.classList.add('waiting');
    }
    
    // Update name color (green for complete, red for error, original color otherwise)
    const nameEl = item.querySelector('.repo-progress-name');
    if (nameEl) {
        if (percent >= 100 && !isError) {
            nameEl.style.color = '#0dbc79';  // Green for completed
        } else if (isError) {
            nameEl.style.color = '#f14c4c';  // Red for errors
        } else {
            const colorHex = COLOR_MAP[color] || '#4ec9b0';
            nameEl.style.color = colorHex;
        }
    }
    
    // Recalculate stats based on all repo states
    recalculateStats();
}

function updateRepoDetails(repoName, details) {
    const item = document.getElementById(`repo-${repoName}`);
    if (!item) return;
    
    const detailsEl = item.querySelector('.repo-details');
    if (!detailsEl) return;
    
    let detailsHTML = [];
    
    if (details.size) {
        detailsHTML.push(`<span class="repo-detail-item">📦 ${details.size}</span>`);
    }
    if (details.branch) {
        detailsHTML.push(`<span class="repo-detail-item">🌿 ${details.branch}</span>`);
    }
    if (details.lastCommit) {
        detailsHTML.push(`<span class="repo-detail-item">📅 ${details.lastCommit}</span>`);
    }
    if (details.commitHash) {
        detailsHTML.push(`<span class="repo-detail-item">🔖 ${details.commitHash.substring(0, 7)}</span>`);
    }
    
    if (detailsHTML.length > 0) {
        detailsEl.innerHTML = detailsHTML.join('');
        detailsEl.style.display = 'flex';
    }
}

function initializeAllRepos(repos) {
    log('=== INITIALIZE ALL REPOS ===');
    log('Repos received:', repos);
    
    const reposList = document.getElementById('repos-list');
    if (!reposList) {
        log('ERROR: repos-list element not found!');
        return;
    }
    
    // Clear any existing content
    reposList.innerHTML = '';
    log('Cleared existing repos list');
    
    if (!repos || repos.length === 0) {
        log('ERROR: No repos provided to initialize');
        reposList.innerHTML = '<div class="empty-message"><p>No repositories configured</p></div>';
        return;
    }
    
    // Sort repos alphabetically by full name
    const sortedRepos = repos.sort((a, b) => {
        const aName = a.fullName || a.name;
        const bName = b.fullName || b.name;
        return aName.localeCompare(bName);
    });
    
    log('Sorted repos, creating UI for', sortedRepos.length, 'repos');
    
    // Create all repo items upfront
    sortedRepos.forEach((repo, index) => {
        log(`Creating item ${index + 1}/${sortedRepos.length}:`, repo.fullName || repo.name, 'ID:', repo.name);
        const item = createRepoProgressItem(repo);
        reposList.appendChild(item);
        log('  Appended to DOM, ID:', item.id);
        
        // Initialize state
        repoStates.set(repo.name, {
            status: 'Waiting...',
            percent: 0,
            color: repo.color,
            fullName: repo.fullName || repo.name,
            details: null
        });
    });
    
    log('=== FINISHED INITIALIZING', sortedRepos.length, 'REPO ITEMS ===');
    log('DOM children count:', reposList.children.length);
}

function recalculateStats() {
    // Count repos by state
    let completed = 0;
    let running = 0;
    let errors = 0;
    
    repoStates.forEach((state, repoName) => {
        const isError = state.status.includes('✗') || state.status.includes('error') || state.status.includes('failed');
        
        if (state.percent >= 100) {
            completed++;
            if (isError) {
                errors++;
            }
        } else if (state.percent > 0) {
            running++;
        }
    });
    
    updateStats(completed, running, stats.total, errors);
}

function updateStats(completed, running, total, errors) {
    stats.completed = completed;
    stats.running = running;
    stats.total = total;
    stats.errors = errors;
    
    const completedEl = document.getElementById('repos-completed');
    const runningEl = document.getElementById('repos-running');
    const totalEl = document.getElementById('repos-total');
    const errorsEl = document.getElementById('repos-errors');
    
    if (completedEl) completedEl.textContent = completed;
    if (runningEl) runningEl.textContent = running;
    if (totalEl) totalEl.textContent = total;
    if (errorsEl) {
        errorsEl.textContent = errors;
        if (errors > 0) {
            errorsEl.classList.add('has-errors');
        } else {
            errorsEl.classList.remove('has-errors');
        }
    }
}

// Listen for progress updates
console.log('Renderer: Setting up IPC listeners');

ipcRenderer.on('progress-update', (event, data) => {
    log('=== PROGRESS UPDATE ===');
    log('Data:', data);
    
    if (data.repo && data.status && typeof data.percent !== 'undefined') {
        log('Calling updateRepoProgress for:', data.repo, 'percent:', data.percent);
        updateRepoProgress(data.repo, data.status, data.percent, data.color);
        
        // Update header status
        const statusText = document.getElementById('status-text');
        if (statusText) {
            statusText.textContent = `Syncing: ${data.repo} - ${data.status}`;
        }
    } else {
        log('ERROR: Invalid progress update data:', data);
    }
});

ipcRenderer.on('terminal-output', (event, output) => {
    // Check if output contains rate limit info
    const rateLimitMatch = output.match(/\[Rate Limits: ([^\]]+)\]/);
    if (rateLimitMatch) {
        updateRateLimitDisplay(rateLimitMatch[1]);
    }
});

ipcRenderer.on('rate-limit-update', (event, data) => {
    console.log('Rate limit update:', data);
    if (data.status) {
        updateRateLimitDisplay(data.status);
    }
});

function updateRateLimitDisplay(rateLimitText) {
    const rateLimitBar = document.getElementById('rate-limit-bar');
    const rateLimitTextEl = document.getElementById('rate-limit-text');
    
    if (rateLimitBar && rateLimitTextEl) {
        rateLimitBar.style.display = 'block';
        rateLimitTextEl.textContent = `API Rate Limits: ${rateLimitText}`;
        
        // Parse to check if we're low on requests
        const requestsMatch = rateLimitText.match(/Requests: (\d+)\/(\d+)/);
        if (requestsMatch) {
            const remaining = parseInt(requestsMatch[1]);
            const limit = parseInt(requestsMatch[2]);
            const percentage = (remaining / limit) * 100;
            
            rateLimitTextEl.className = '';
            if (percentage < 10) {
                rateLimitTextEl.classList.add('rate-limit-critical');
            } else if (percentage < 30) {
                rateLimitTextEl.classList.add('rate-limit-warning');
            }
        }
    }
}

ipcRenderer.on('sync-complete', (event, syncStats) => {
    console.log('Sync complete:', syncStats);
    
    const statusText = document.getElementById('status-text');
    if (statusText) {
        statusText.textContent = `Complete!`;
    }
    
    const repoCount = document.getElementById('repo-count');
    if (repoCount) {
        repoCount.textContent = `${syncStats.total} repos synced`;
        
        // Show info about metadata if any was generated
        if (syncStats.metadata_generated > 0) {
            repoCount.innerHTML += `<br><span style="color: #4ec9b0; font-size: 11px;">✓ ${syncStats.metadata_generated} metadata files generated</span>`;
        }
    }
    
    // Disable stop button
    const stopBtn = document.getElementById('stop-sync-btn');
    if (stopBtn) {
        console.log('Disabling stop button (sync complete)');
        stopBtn.disabled = true;
        stopBtn.classList.remove('active');
        stopBtn.textContent = '⏹';
    }
    
    // Update total and recalculate everything
    stats.total = syncStats.total;
    recalculateStats();
});

ipcRenderer.on('waiting-for-network', (event) => {
    console.log('Waiting for network connectivity...');
    const statusText = document.getElementById('status-text');
    if (statusText) {
        statusText.textContent = 'Waiting for network...';
        statusText.style.color = '#f0ad4e';
    }
});

ipcRenderer.on('network-timeout', (event, message) => {
    console.log('Network timeout:', message);
    const statusText = document.getElementById('status-text');
    if (statusText) {
        statusText.textContent = 'No network — sync aborted';
        statusText.style.color = '#d9534f';
    }

    // Disable stop button
    const stopBtn = document.getElementById('stop-sync-btn');
    if (stopBtn) {
        stopBtn.disabled = true;
        stopBtn.classList.remove('active');
        stopBtn.textContent = '⏹';
    }
});

ipcRenderer.on('sync-stopped', (event) => {
    console.log('Sync was stopped by user');
    
    const statusText = document.getElementById('status-text');
    if (statusText) {
        statusText.textContent = 'Sync cancelled by user';
    }
    
    // Disable stop button
    const stopBtn = document.getElementById('stop-sync-btn');
    if (stopBtn) {
        console.log('Disabling stop button (sync stopped)');
        stopBtn.disabled = true;
        stopBtn.classList.remove('active');
        stopBtn.textContent = '⏹';
    }
});

ipcRenderer.on('sync-started', (event, data) => {
    log('=== SYNC STARTED EVENT ===');
    log('Total repos:', data.total);
    log('Repos array:', data.repos);
    log('Repos array length:', data.repos?.length);
    
    // Clear previous progress
    repoStates.clear();
    
    // Initialize all repos if provided
    if (data.repos && data.repos.length > 0) {
        log('Initializing repos...');
        initializeAllRepos(data.repos);
    } else {
        log('ERROR: No repos array provided in sync-started event!');
        const reposList = document.getElementById('repos-list');
        if (reposList) {
            reposList.innerHTML = '<div class="empty-message"><p style="color: red;">Error: No repositories data received</p></div>';
        }
    }
    
    updateStats(0, 0, data.total || 0, 0);
    
    const statusText = document.getElementById('status-text');
    if (statusText) {
        statusText.textContent = 'Starting sync...';
    }
    
    // Enable stop button
    const stopBtn = document.getElementById('stop-sync-btn');
    if (stopBtn) {
        log('Enabling stop button');
        stopBtn.disabled = false;
        stopBtn.classList.add('active');
        stopBtn.textContent = '⏹';
    } else {
        log('ERROR: Stop button element not found!');
    }
});

// Get version info
ipcRenderer.on('version-info', (event, versionData) => {
    const versionEl = document.getElementById('version-text');
    if (versionEl && versionData) {
        const buildDate = new Date(versionData.buildDate);
        versionEl.textContent = `v${versionData.version} • ${buildDate.toLocaleDateString()}`;
    }
});

// Initialize progress view when page loads
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM loaded, initializing progress view...');
    initProgressView();
    
    // Request version info
    ipcRenderer.send('get-version');
    
    // Add stop button handler
    const stopBtn = document.getElementById('stop-sync-btn');
    if (stopBtn) {
        stopBtn.addEventListener('click', () => {
            console.log('Stop button clicked');
            
            // Confirm with user
            if (confirm('Are you sure you want to stop the sync?')) {
                ipcRenderer.send('stop-sync');
                stopBtn.disabled = true;
                stopBtn.classList.remove('active');
                stopBtn.textContent = '⏹';
            }
        });
    }
    
    // Add click handler for error stat
    const errorStat = document.getElementById('errors-stat');
    if (errorStat) {
        errorStat.addEventListener('click', () => {
            const errorCount = parseInt(document.getElementById('repos-errors').textContent);
            if (errorCount > 0) {
                ipcRenderer.send('open-error-window');
            }
        });
    }
});

