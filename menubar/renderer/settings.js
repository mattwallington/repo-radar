// Note: In settings window, nodeIntegration is enabled for simplicity
// This allows direct access to ipcRenderer

let configData = null;

const { ipcRenderer } = require('electron');

// Handle config loaded
ipcRenderer.on('config-loaded', (event, config) => {
    console.log('Config loaded:', config);
    configData = config || {
        github_token: '',
        gemini_api_key: '',
        anthropic_api_key: '',
        openai_api_key: '',
        ai_model: 'claude-sonnet-4-6',
        repositories: [],
        last_configured: null
    };
    renderForm();
});

// Get version info
ipcRenderer.on('version-info', (event, versionData) => {
    const versionEl = document.getElementById('settings-version-text');
    if (versionEl && versionData) {
        const buildDate = new Date(versionData.buildDate);
        versionEl.textContent = `v${versionData.version} • ${buildDate.toLocaleDateString()}`;
    }
});

// Load config when window opens
window.addEventListener('DOMContentLoaded', () => {
    // Request config load
    ipcRenderer.send('load-config');
    
    // Request version info
    ipcRenderer.send('get-version');
});

// Handle save result
ipcRenderer.on('config-saved', (event, success, error) => {
    if (success) {
        showNotification('Settings saved successfully!', 'success');
        // Close window after a short delay
        setTimeout(() => {
            window.close();
        }, 1000);
    } else {
        showNotification(`Error saving settings: ${error}`, 'error');
    }
});

function renderForm() {
    console.log('Rendering form with config:', configData);
    console.log('Number of repositories:', configData?.repositories?.length || 0);
    
    // Render GitHub token
    const tokenInput = document.getElementById('github-token');
    if (tokenInput) {
        tokenInput.value = configData.github_token || '';
    }
    
    // Render API keys
    const geminiKeyInput = document.getElementById('gemini-api-key');
    if (geminiKeyInput) {
        geminiKeyInput.value = configData.gemini_api_key || '';
    }
    
    const anthropicKeyInput = document.getElementById('anthropic-api-key');
    if (anthropicKeyInput) {
        anthropicKeyInput.value = configData.anthropic_api_key || '';
    }
    
    const openaiKeyInput = document.getElementById('openai-api-key');
    if (openaiKeyInput) {
        openaiKeyInput.value = configData.openai_api_key || '';
    }
    
    // Render AI model
    const aiModelSelect = document.getElementById('ai-model');
    if (aiModelSelect) {
        aiModelSelect.value = configData.ai_model || 'claude-sonnet-4-6';
        // Highlight the required API key for the selected model
        highlightRequiredApiKey(aiModelSelect.value);
    }
    
    // Render schedule settings
    renderScheduleSettings();
    
    // Render repositories
    renderRepositories();
}

function renderScheduleSettings() {
    const schedule = configData.schedule || {
        enabled: false,
        type: 'daily',
        time: '09:00',
        interval: 6,
        days: [1, 2, 3, 4, 5]  // Mon-Fri default
    };
    
    // Enable checkbox
    const enabledCheckbox = document.getElementById('schedule-enabled');
    if (enabledCheckbox) {
        enabledCheckbox.checked = schedule.enabled;
        toggleScheduleOptions(schedule.enabled);
    }
    
    // Schedule type
    const typeSelect = document.getElementById('schedule-type');
    if (typeSelect) {
        typeSelect.value = schedule.type || 'daily';
        updateScheduleTypeVisibility(schedule.type);
    }
    
    // Daily time
    const timeInput = document.getElementById('schedule-time');
    if (timeInput) {
        timeInput.value = schedule.time || '09:00';
    }
    
    // Hourly interval
    const intervalInput = document.getElementById('schedule-interval');
    if (intervalInput) {
        intervalInput.value = schedule.interval || 6;
    }
    
    // Weekly days
    const dayCheckboxes = document.querySelectorAll('.schedule-day');
    const selectedDays = schedule.days || [1, 2, 3, 4, 5];
    dayCheckboxes.forEach(checkbox => {
        checkbox.checked = selectedDays.includes(parseInt(checkbox.value));
    });
    
    // Weekly time
    const weeklyTimeInput = document.getElementById('schedule-weekly-time');
    if (weeklyTimeInput) {
        weeklyTimeInput.value = schedule.time || '09:00';
    }
}

function toggleScheduleOptions(enabled) {
    const scheduleOptions = document.getElementById('schedule-options');
    if (scheduleOptions) {
        if (enabled) {
            scheduleOptions.classList.remove('disabled');
        } else {
            scheduleOptions.classList.add('disabled');
        }
    }
}

function updateScheduleTypeVisibility(type) {
    document.getElementById('daily-options').style.display = type === 'daily' ? 'block' : 'none';
    document.getElementById('hourly-options').style.display = type === 'hourly' ? 'block' : 'none';
    document.getElementById('weekly-options').style.display = type === 'weekly' ? 'block' : 'none';
}

function renderRepositories() {
    const reposList = document.getElementById('repos-list');
    const repoCount = document.querySelector('.repo-count');
    
    const numRepos = configData?.repositories?.length || 0;
    console.log('Rendering', numRepos, 'repositories');
    
    if (repoCount) {
        repoCount.textContent = `${numRepos} repositories`;
    }
    
    if (!reposList) {
        console.error('repos-list element not found!');
        return;
    }
    
    reposList.innerHTML = '';
    
    if (numRepos === 0) {
        reposList.innerHTML = `
            <div class="empty-state">
                <p>No repositories configured</p>
                <button id="add-first-repo" class="btn btn-primary">Add Repository</button>
            </div>
        `;
        document.getElementById('add-first-repo')?.addEventListener('click', addRepository);
        return;
    }
    
    configData.repositories.forEach((repo, index) => {
        const repoItem = createRepoItem(repo, index);
        reposList.appendChild(repoItem);
    });
}

function createRepoItem(repo, index) {
    const div = document.createElement('div');
    div.className = 'repo-item';
    div.dataset.index = index;
    
    const lastPushed = repo.last_pushed_at ? new Date(repo.last_pushed_at).toLocaleDateString() : 'N/A';
    
    div.innerHTML = `
        <div class="repo-item-header">
            <span class="repo-item-title">${escapeHtml(repo.full_name || repo.name || 'New Repository')}</span>
            <div class="repo-item-info">
                <span><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M3 2.5a2.5 2.5 0 015 0 2.5 2.5 0 015 0v10a1 1 0 01-1 1H4a1 1 0 01-1-1v-10z"/><path d="M4.5 3h7a.5.5 0 01.5.5v1a.5.5 0 01-.5.5h-7a.5.5 0 01-.5-.5v-1a.5.5 0 01.5-.5z"/></svg> ${escapeHtml(repo.default_branch || 'main')}</span>
                <span><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3.5a.5.5 0 00-1 0V9a.5.5 0 00.252.434l3.5 2a.5.5 0 00.496-.868L8 8.71V3.5z"/><path d="M8 16A8 8 0 108 0a8 8 0 000 16zm7-8A7 7 0 111 8a7 7 0 0114 0z"/></svg> ${lastPushed}</span>
            </div>
            <div class="repo-item-actions">
                <button class="btn btn-small btn-icon edit-repo" data-index="${index}" title="Edit">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M12.854.146a.5.5 0 00-.707 0L10.5 1.793 14.207 5.5l1.647-1.646a.5.5 0 000-.708l-3-3zm.646 4.646L9.793 8.5 8.5 9.793l3.707 3.707L14.854 10.854l-1.354-1.354zM1 13.5A1.5 1.5 0 002.5 15h11a1.5 1.5 0 001.5-1.5v-6a.5.5 0 00-1 0v6a.5.5 0 01-.5.5h-11a.5.5 0 01-.5-.5v-11a.5.5 0 01.5-.5h6a.5.5 0 000-1h-6A1.5 1.5 0 001 2.5v11z"/>
                        <path d="M.646 13.854l3.5-3.5a.5.5 0 01.708 0l3.5 3.5a.5.5 0 01-.708.708L4.5 11.414l-3.146 3.147a.5.5 0 01-.708-.707z"/>
                    </svg>
                </button>
                <button class="btn btn-small btn-danger delete-repo" data-index="${index}" title="Delete">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M5.5 5.5A.5.5 0 016 6v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm2.5 0a.5.5 0 01.5.5v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm3 .5a.5.5 0 00-1 0v6a.5.5 0 001 0V6z"/>
                        <path fill-rule="evenodd" d="M14.5 3a1 1 0 01-1 1H13v9a2 2 0 01-2 2H5a2 2 0 01-2-2V4h-.5a1 1 0 01-1-1V2a1 1 0 011-1H6a1 1 0 011-1h2a1 1 0 011 1h3.5a1 1 0 011 1v1zM4.118 4L4 4.059V13a1 1 0 001 1h6a1 1 0 001-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/>
                    </svg>
                </button>
            </div>
        </div>
        <div class="repo-fields" data-index="${index}">
            <div class="repo-field">
                <label>Name</label>
                <input type="text" class="repo-name" data-index="${index}" value="${escapeHtml(repo.name || '')}" />
            </div>
            <div class="repo-field full-width">
                <label>Full Name (org/repo)</label>
                <input type="text" class="repo-full-name" data-index="${index}" value="${escapeHtml(repo.full_name || '')}" />
            </div>
            <div class="repo-field full-width">
                <label>Clone URL</label>
                <input type="text" class="repo-clone-url" data-index="${index}" value="${escapeHtml(repo.clone_url || '')}" />
            </div>
            <div class="repo-field">
                <label>Default Branch</label>
                <input type="text" class="repo-branch" data-index="${index}" value="${escapeHtml(repo.default_branch || 'main')}" />
            </div>
            <div class="repo-field">
                <label>Last Pushed</label>
                <input type="text" class="repo-pushed" data-index="${index}" value="${escapeHtml(repo.last_pushed_at || '')}" disabled />
            </div>
            <div class="repo-field full-width">
                <label>Description</label>
                <input type="text" class="repo-description" data-index="${index}" value="${escapeHtml(repo.description || '')}" />
            </div>
        </div>
        <div class="repo-edit-actions" data-index="${index}">
            <button class="btn btn-small btn-primary save-repo" data-index="${index}">Save</button>
            <button class="btn btn-small btn-secondary cancel-repo" data-index="${index}">Cancel</button>
        </div>
    `;
    
    // Add event listeners
    const editBtn = div.querySelector('.edit-repo');
    editBtn.addEventListener('click', () => toggleEditMode(index, true));
    
    const deleteBtn = div.querySelector('.delete-repo');
    deleteBtn.addEventListener('click', () => deleteRepository(index));
    
    const saveBtn = div.querySelector('.save-repo');
    saveBtn.addEventListener('click', () => toggleEditMode(index, false));
    
    const cancelBtn = div.querySelector('.cancel-repo');
    cancelBtn.addEventListener('click', () => {
        // Restore original values
        renderRepositories();
    });
    
    // Add input listeners to update data
    div.querySelectorAll('input').forEach(input => {
        input.addEventListener('input', (e) => {
            updateRepoField(index, e.target.className.split(' ')[0].replace('repo-', '').replace('-', '_'), e.target.value);
        });
    });
    
    return div;
}

function toggleEditMode(index, editing) {
    const repoItem = document.querySelector(`.repo-item[data-index="${index}"]`);
    if (!repoItem) return;
    
    const fields = repoItem.querySelector('.repo-fields');
    const actions = repoItem.querySelector('.repo-edit-actions');
    const editBtn = repoItem.querySelector('.edit-repo');
    const deleteBtn = repoItem.querySelector('.delete-repo');
    
    if (editing) {
        fields?.classList.add('editing');
        actions?.classList.add('editing');
        if (editBtn) editBtn.style.display = 'none';
        if (deleteBtn) deleteBtn.style.display = 'none';
    } else {
        fields?.classList.remove('editing');
        actions?.classList.remove('editing');
        if (editBtn) editBtn.style.display = '';
        if (deleteBtn) deleteBtn.style.display = '';
    }
}

function updateRepoField(index, field, value) {
    if (!configData.repositories[index]) return;
    
    // Map field names
    const fieldMap = {
        'name': 'name',
        'full_name': 'full_name',
        'clone_url': 'clone_url',
        'branch': 'default_branch',
        'pushed': 'last_pushed_at',
        'description': 'description'
    };
    
    const actualField = fieldMap[field] || field;
    configData.repositories[index][actualField] = value;
    
    // Update title if full_name changed
    if (actualField === 'full_name') {
        const title = document.querySelector(`.repo-item:nth-child(${index + 1}) .repo-item-title`);
        if (title) {
            title.textContent = value || configData.repositories[index].name || 'New Repository';
        }
    }
}

function addRepository() {
    const newRepo = {
        name: '',
        full_name: '',
        clone_url: '',
        default_branch: 'main',
        last_pushed_at: '',
        description: ''
    };
    
    configData.repositories.push(newRepo);
    renderRepositories();
    
    // Scroll to bottom
    const reposList = document.getElementById('repos-list');
    reposList.scrollTop = reposList.scrollHeight;
}

function deleteRepository(index) {
    if (confirm('Are you sure you want to delete this repository?')) {
        configData.repositories.splice(index, 1);
        renderRepositories();
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showNotification(message, type) {
    // Simple notification - could be enhanced
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        padding: 12px 20px;
        background: ${type === 'success' ? '#0dbc79' : '#c72525'};
        color: white;
        border-radius: 4px;
        z-index: 10000;
        font-size: 13px;
    `;
    notification.textContent = message;
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.remove();
    }, 3000);
}

// Schedule enable toggle
document.getElementById('schedule-enabled').addEventListener('change', (e) => {
    toggleScheduleOptions(e.target.checked);
});

// Schedule type change
document.getElementById('schedule-type').addEventListener('change', (e) => {
    updateScheduleTypeVisibility(e.target.value);
});

// Model selection change - highlight required API key
document.getElementById('ai-model').addEventListener('change', (e) => {
    highlightRequiredApiKey(e.target.value);
});

function highlightRequiredApiKey(model) {
    // Remove all highlights
    document.querySelectorAll('.api-key-group').forEach(group => {
        group.classList.remove('required');
        const badge = group.querySelector('.key-required-badge');
        if (badge) badge.style.display = 'none';
    });
    
    // Highlight the required key for selected model
    let requiredProvider = null;
    if (model.startsWith('gemini/')) {
        requiredProvider = 'gemini';
    } else if (model.startsWith('claude')) {
        requiredProvider = 'anthropic';
    } else if (model.startsWith('gpt') || model.startsWith('o1')) {
        requiredProvider = 'openai';
    }
    
    if (requiredProvider) {
        const group = document.querySelector(`.api-key-group[data-provider="${requiredProvider}"]`);
        if (group) {
            group.classList.add('required');
            const badge = group.querySelector('.key-required-badge');
            if (badge) badge.style.display = 'inline-block';
        }
    }
}

// Save button
document.getElementById('save-btn').addEventListener('click', () => {
    // Update API keys and model
    configData.github_token = document.getElementById('github-token').value;
    configData.gemini_api_key = document.getElementById('gemini-api-key').value;
    configData.anthropic_api_key = document.getElementById('anthropic-api-key').value;
    configData.openai_api_key = document.getElementById('openai-api-key').value;
    configData.ai_model = document.getElementById('ai-model').value;
    
    // Update schedule settings
    configData.schedule = {
        enabled: document.getElementById('schedule-enabled').checked,
        type: document.getElementById('schedule-type').value,
        time: document.getElementById('schedule-time').value,
        interval: parseInt(document.getElementById('schedule-interval').value) || 6,
        days: Array.from(document.querySelectorAll('.schedule-day:checked')).map(cb => parseInt(cb.value))
    };
    
    // For weekly, use weekly-specific time
    if (configData.schedule.type === 'weekly') {
        configData.schedule.time = document.getElementById('schedule-weekly-time').value;
    }
    
    // Update last_configured
    configData.last_configured = new Date().toISOString();
    
    // Validate
    if (!configData.github_token) {
        showNotification('GitHub token is required', 'error');
        return;
    }
    
    // AI key validation depends on model selected
    const selectedModel = configData.ai_model || '';
    if (selectedModel.startsWith('gemini/')) {
        if (!configData.gemini_api_key) {
            showNotification('Gemini API key is required for Gemini models', 'error');
            return;
        }
    } else if (selectedModel.startsWith('claude')) {
        if (!configData.anthropic_api_key) {
            showNotification('Anthropic API key is required for Claude models', 'error');
            return;
        }
    } else if (selectedModel.startsWith('gpt') || selectedModel.startsWith('o1')) {
        if (!configData.openai_api_key) {
            showNotification('OpenAI API key is required for GPT models', 'error');
            return;
        }
    }
    
    if (configData.schedule.enabled && configData.schedule.type === 'weekly' && configData.schedule.days.length === 0) {
        showNotification('Select at least one day for weekly sync', 'error');
        return;
    }
    
    // Send save request (this will also update the LaunchAgent)
    ipcRenderer.send('save-config', configData);
});

// Cancel button
document.getElementById('cancel-btn').addEventListener('click', () => {
    window.close();
});

// Add repo button
document.getElementById('add-repo-btn').addEventListener('click', addRepository);

// Fetch repos button
document.getElementById('fetch-repos-btn').addEventListener('click', fetchGitHubRepos);

// Apply selection button
document.getElementById('apply-selection-btn').addEventListener('click', applyRepoSelection);

// Select/Deselect all buttons
document.getElementById('select-all-btn').addEventListener('click', () => toggleAllRepos(true));
document.getElementById('deselect-all-btn').addEventListener('click', () => toggleAllRepos(false));

// Search repos
document.getElementById('repo-search').addEventListener('input', (e) => {
    filterAvailableRepos(e.target.value);
});

// Store available repos from GitHub
let availableRepos = [];
let selectedRepoNames = new Set();

async function fetchGitHubRepos() {
    const githubToken = document.getElementById('github-token').value;
    
    if (!githubToken) {
        showNotification('Please enter your GitHub token first', 'error');
        return;
    }
    
    // Show progress
    document.getElementById('fetch-progress').style.display = 'flex';
    document.getElementById('repo-browser').style.display = 'none';
    document.getElementById('fetch-status').textContent = 'Fetching repositories from GitHub...';
    
    try {
        // Get current user info
        const user = await fetchGitHubAPI('/user', githubToken);
        
        // Fetch user repos
        document.getElementById('fetch-status').textContent = 'Fetching your personal repositories...';
        const userRepos = await fetchGitHubAPI('/user/repos', githubToken, { 
            per_page: 100, 
            sort: 'pushed',
            direction: 'desc',
            affiliation: 'owner'
        });
        
        // Fetch org repos
        const orgs = await fetchGitHubAPI('/user/orgs', githubToken, { per_page: 100 });
        const reposByOrg = {};
        
        // Add personal repos
        reposByOrg[user.login] = userRepos.sort((a, b) => {
            return new Date(b.pushed_at) - new Date(a.pushed_at);
        });
        
        // Fetch repos for each org
        for (const org of orgs) {
            document.getElementById('fetch-status').textContent = `Fetching ${org.login} repositories...`;
            const repos = await fetchGitHubAPI(`/orgs/${org.login}/repos`, githubToken, {
                per_page: 100,
                sort: 'pushed',
                direction: 'desc'
            });
            
            // Sort by last pushed within org
            reposByOrg[org.login] = repos.sort((a, b) => {
                return new Date(b.pushed_at) - new Date(a.pushed_at);
            });
        }
        
        // Store the organized repos
        availableRepos = reposByOrg;
        
        // Mark currently selected repos
        selectedRepoNames.clear();
        configData.repositories.forEach(repo => {
            selectedRepoNames.add(repo.full_name);
        });
        
        // Hide progress, show browser
        document.getElementById('fetch-progress').style.display = 'none';
        document.getElementById('repo-browser').style.display = 'block';
        
        // Render repos grouped by org
        renderAvailableReposByOrg(reposByOrg);
        updateRepoStats();
        
        const totalRepos = Object.values(reposByOrg).reduce((sum, repos) => sum + repos.length, 0);
        showNotification(`Found ${totalRepos} repositories across ${Object.keys(reposByOrg).length} organizations`, 'success');
        
    } catch (error) {
        console.error('Error fetching repos:', error);
        document.getElementById('fetch-progress').style.display = 'none';
        showNotification(`Error: ${error.message}`, 'error');
    }
}

async function fetchGitHubAPI(endpoint, token, params = {}) {
    const url = new URL(`https://api.github.com${endpoint}`);
    Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));
    
    const response = await fetch(url, {
        headers: {
            'Authorization': `token ${token}`,
            'Accept': 'application/vnd.github.v3+json'
        }
    });
    
    if (!response.ok) {
        throw new Error(`GitHub API error: ${response.statusText}`);
    }
    
    return await response.json();
}

function renderAvailableReposByOrg(reposByOrg) {
    const container = document.getElementById('available-repos-list');
    
    if (Object.keys(reposByOrg).length === 0) {
        container.innerHTML = `
            <div class="repo-browser-empty">
                <p>No repositories found</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = '';
    
    // Render each organization section
    Object.entries(reposByOrg).forEach(([orgName, repos]) => {
        if (repos.length === 0) return;
        
        const orgSection = createOrgSection(orgName, repos);
        container.appendChild(orgSection);
    });
}

function createOrgSection(orgName, repos) {
    const section = document.createElement('div');
    section.className = 'org-section';
    
    const selectedInOrg = repos.filter(r => selectedRepoNames.has(r.full_name)).length;
    
    const header = document.createElement('div');
    header.className = 'org-header';
    header.innerHTML = `
        <div class="org-header-left">
            <svg class="org-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M1.75 16A1.75 1.75 0 0 1 0 14.25V1.75C0 .784.784 0 1.75 0h8.5C11.216 0 12 .784 12 1.75v12.5c0 .966-.784 1.75-1.75 1.75h-8.5zM1.5 1.75v12.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25V1.75a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25zM3.75 3a.75.75 0 0 1 .75.75v7.5a.75.75 0 0 1-1.5 0v-7.5A.75.75 0 0 1 3.75 3zm3 0a.75.75 0 0 1 .75.75v7.5a.75.75 0 0 1-1.5 0v-7.5A.75.75 0 0 1 6.75 3z"/>
            </svg>
            <span class="org-name">${escapeHtml(orgName)}</span>
            <span class="org-count">${repos.length} repos</span>
            <span class="org-selected">${selectedInOrg > 0 ? `• ${selectedInOrg} selected` : ''}</span>
        </div>
        <div class="org-header-right">
            <button class="org-select-all btn btn-small" data-org="${escapeHtml(orgName)}">Select All</button>
            <span class="org-chevron">▼</span>
        </div>
    `;
    
    const reposContainer = document.createElement('div');
    reposContainer.className = 'org-repos';
    
    repos.forEach(repo => {
        const isSelected = selectedRepoNames.has(repo.full_name);
        const item = createAvailableRepoItem(repo, isSelected);
        reposContainer.appendChild(item);
    });
    
    section.appendChild(header);
    section.appendChild(reposContainer);
    
    // Toggle expand/collapse
    header.addEventListener('click', (e) => {
        // Don't toggle if clicking the select all button
        if (e.target.classList.contains('org-select-all')) {
            return;
        }
        
        const isExpanded = section.classList.toggle('collapsed');
        const chevron = header.querySelector('.org-chevron');
        chevron.textContent = isExpanded ? '▶' : '▼';
    });
    
    // Select all for this org
    const selectAllBtn = header.querySelector('.org-select-all');
    selectAllBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        
        const allSelected = repos.every(r => selectedRepoNames.has(r.full_name));
        
        repos.forEach(repo => {
            const checkbox = reposContainer.querySelector(`[data-full-name="${repo.full_name}"] .available-repo-checkbox`);
            const item = reposContainer.querySelector(`[data-full-name="${repo.full_name}"]`);
            
            if (!allSelected) {
                selectedRepoNames.add(repo.full_name);
                if (checkbox) checkbox.checked = true;
                if (item) item.classList.add('selected');
            } else {
                selectedRepoNames.delete(repo.full_name);
                if (checkbox) checkbox.checked = false;
                if (item) item.classList.remove('selected');
            }
        });
        
        // Update button text and stats
        selectAllBtn.textContent = allSelected ? 'Select All' : 'Deselect All';
        const selectedInOrg = repos.filter(r => selectedRepoNames.has(r.full_name)).length;
        header.querySelector('.org-selected').textContent = selectedInOrg > 0 ? `• ${selectedInOrg} selected` : '';
        updateRepoStats();
    });
    
    return section;
}

function createAvailableRepoItem(repo, isSelected) {
    const div = document.createElement('div');
    div.className = 'available-repo-item' + (isSelected ? ' selected' : '');
    div.dataset.fullName = repo.full_name;
    
    const lastPushed = new Date(repo.pushed_at).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
    
    div.innerHTML = `
        <input type="checkbox" class="available-repo-checkbox" ${isSelected ? 'checked' : ''}>
        <div class="available-repo-info">
            <div class="available-repo-name">${escapeHtml(repo.full_name)}</div>
            <div class="available-repo-description">${escapeHtml(repo.description || 'No description')}</div>
            <div class="available-repo-meta">
                <span>
                    <svg class="meta-icon" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5v-9zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 0 1 1-1h8zM5 12.25v3.25a.25.25 0 0 0 .4.2l1.45-1.087a.25.25 0 0 1 .3 0L8.6 15.7a.25.25 0 0 0 .4-.2v-3.25a.25.25 0 0 0-.25-.25h-3.5a.25.25 0 0 0-.25.25z"/>
                    </svg>
                    ${escapeHtml(repo.default_branch || 'main')}
                </span>
                <span>
                    <svg class="meta-icon" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0zM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0zm7-3.25v2.992l2.028.812a.75.75 0 0 1-.557 1.392l-2.5-1A.75.75 0 0 1 7 8.25v-3.5a.75.75 0 0 1 1.5 0z"/>
                    </svg>
                    ${lastPushed}
                </span>
            </div>
        </div>
    `;
    
    // Toggle selection on click
    const checkbox = div.querySelector('.available-repo-checkbox');
    div.addEventListener('click', (e) => {
        if (e.target !== checkbox) {
            checkbox.checked = !checkbox.checked;
        }
        
        if (checkbox.checked) {
            selectedRepoNames.add(repo.full_name);
            div.classList.add('selected');
        } else {
            selectedRepoNames.delete(repo.full_name);
            div.classList.remove('selected');
        }
        
        updateRepoStats();
    });
    
    return div;
}

function toggleAllRepos(select) {
    // Flatten all repos from all orgs
    const allRepos = [];
    Object.values(availableRepos).forEach(orgRepos => {
        allRepos.push(...orgRepos);
    });
    
    const checkboxes = document.querySelectorAll('.available-repo-checkbox');
    const items = document.querySelectorAll('.available-repo-item');
    
    checkboxes.forEach((checkbox, index) => {
        // Only toggle visible items
        const item = items[index];
        if (item.style.display === 'none') return;
        
        checkbox.checked = select;
        const fullName = item.dataset.fullName;
        
        if (select) {
            selectedRepoNames.add(fullName);
            item.classList.add('selected');
        } else {
            selectedRepoNames.delete(fullName);
            item.classList.remove('selected');
        }
    });
    
    updateRepoStats();
}

function filterAvailableRepos(searchTerm) {
    const term = searchTerm.toLowerCase();
    const orgSections = document.querySelectorAll('.org-section');
    
    orgSections.forEach(section => {
        const items = section.querySelectorAll('.available-repo-item');
        let visibleCount = 0;
        
        items.forEach(item => {
            const fullName = item.dataset.fullName.toLowerCase();
            const description = item.querySelector('.available-repo-description').textContent.toLowerCase();
            
            if (fullName.includes(term) || description.includes(term)) {
                item.style.display = 'flex';
                visibleCount++;
            } else {
                item.style.display = 'none';
            }
        });
        
        // Hide org section if no repos match
        if (visibleCount === 0) {
            section.style.display = 'none';
        } else {
            section.style.display = 'block';
        }
    });
}

function updateRepoStats() {
    const totalRepos = Object.values(availableRepos).reduce((sum, repos) => sum + repos.length, 0);
    document.getElementById('available-count').textContent = `${totalRepos} available`;
    document.getElementById('selected-count').textContent = `${selectedRepoNames.size} selected`;
    
    // Update org-level selected counts
    document.querySelectorAll('.org-section').forEach(section => {
        const orgName = section.querySelector('.org-name').textContent;
        const orgRepos = availableRepos[orgName] || [];
        const selectedInOrg = orgRepos.filter(r => selectedRepoNames.has(r.full_name)).length;
        const selectedSpan = section.querySelector('.org-selected');
        if (selectedSpan) {
            selectedSpan.textContent = selectedInOrg > 0 ? `• ${selectedInOrg} selected` : '';
        }
    });
}

function applyRepoSelection() {
    // Flatten all repos and filter selected
    const allRepos = [];
    Object.values(availableRepos).forEach(orgRepos => {
        allRepos.push(...orgRepos);
    });
    
    // Convert selected repos to config format
    configData.repositories = allRepos
        .filter(repo => selectedRepoNames.has(repo.full_name))
        .map(repo => ({
            name: repo.name,
            full_name: repo.full_name,
            clone_url: repo.clone_url,
            default_branch: repo.default_branch || 'main',
            last_pushed_at: repo.pushed_at,
            description: repo.description || ''
        }))
        // Sort by last pushed (most recent first)
        .sort((a, b) => new Date(b.last_pushed_at) - new Date(a.last_pushed_at));
    
    // Hide browser, show selected repos
    document.getElementById('repo-browser').style.display = 'none';
    renderRepositories();
    
    showNotification(`Selected ${configData.repositories.length} repositories`, 'success');
}

