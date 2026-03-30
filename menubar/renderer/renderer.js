const { ipcRenderer } = require('electron');

let repoStates = new Map(); // Map of repo name -> { status, percent, color }
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

function createRepoProgressItem(repoName, color) {
    const div = document.createElement('div');
    div.className = 'repo-progress-item waiting';
    div.id = `repo-${repoName}`;
    
    const colorHex = COLOR_MAP[color] || '#4ec9b0';
    
    // Shorten repo name if too long
    const displayName = repoName.length > 20 ? repoName.substring(0, 18) + '...' : repoName;
    
    div.innerHTML = `
        <div class="repo-progress-header">
            <span class="repo-progress-name" style="color: ${colorHex}" title="${repoName}">${displayName}</span>
            <span class="repo-progress-status">Waiting...</span>
        </div>
        <div class="repo-progress-bar-container">
            <div class="repo-progress-bar" style="width: 0%; background-color: ${colorHex}"></div>
        </div>
    `;
    
    return div;
}

function updateRepoProgress(repoName, status, percent, color) {
    // Store the repo state
    repoStates.set(repoName, { status, percent, color });
    
    let item = document.getElementById(`repo-${repoName}`);
    
    if (!item) {
        // Create new progress item
        const reposList = document.getElementById('repos-list');
        if (reposList) {
            // Remove empty message if it exists
            const emptyMsg = reposList.querySelector('.empty-message');
            if (emptyMsg) {
                emptyMsg.remove();
            }
            
            item = createRepoProgressItem(repoName, color);
            reposList.appendChild(item);
        } else {
            return;
        }
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
        } else {
            item.classList.add('complete');
            progressBar?.classList.add('complete');
        }
    } else {
        item.classList.add('syncing');
    }
    
    // Update name color
    const nameEl = item.querySelector('.repo-progress-name');
    if (nameEl) {
        const colorHex = COLOR_MAP[color] || '#4ec9b0';
        nameEl.style.color = colorHex;
    }
    
    // Recalculate stats based on all repo states
    recalculateStats();
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
    console.log('Progress update:', data);
    
    if (data.repo && data.status && typeof data.percent !== 'undefined') {
        updateRepoProgress(data.repo, data.status, data.percent, data.color);
        
        // Update header status
        const statusText = document.getElementById('status-text');
        if (statusText) {
            statusText.textContent = `Syncing: ${data.repo} - ${data.status}`;
        }
    }
});

ipcRenderer.on('sync-complete', (event, syncStats) => {
    console.log('Sync complete:', syncStats);
    
    const statusText = document.getElementById('status-text');
    if (statusText) {
        statusText.textContent = `Complete!`;
    }
    
    const repoCount = document.getElementById('repo-count');
    if (repoCount) {
        repoCount.textContent = `${syncStats.total} repos synced`;
    }
    
    // Update total and recalculate everything
    stats.total = syncStats.total;
    recalculateStats();
});

ipcRenderer.on('sync-started', (event, data) => {
    console.log('Sync started with repos:', data.total);
    
    // Clear previous progress
    repoStates.clear();
    
    const reposList = document.getElementById('repos-list');
    if (reposList) {
        reposList.innerHTML = '';
    }
    
    updateStats(0, 0, data.total || 0, 0);
    
    const statusText = document.getElementById('status-text');
    if (statusText) {
        statusText.textContent = 'Starting sync...';
    }
});

// Initialize progress view when page loads
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM loaded, initializing progress view...');
    initProgressView();
});

