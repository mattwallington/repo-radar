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
        ai_model: 'gemini/gemini-3.0-flash',
        repositories: [],
        last_configured: null
    };
    renderForm();
});

// Load config when window opens
window.addEventListener('DOMContentLoaded', () => {
    // Request config load
    ipcRenderer.send('load-config');
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
    
    // Render Gemini API key
    const geminiKeyInput = document.getElementById('gemini-api-key');
    if (geminiKeyInput) {
        geminiKeyInput.value = configData.gemini_api_key || '';
    }
    
    // Render AI model
    const aiModelSelect = document.getElementById('ai-model');
    if (aiModelSelect) {
        aiModelSelect.value = configData.ai_model || 'gemini/gemini-3.0-flash';
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

// Save button
document.getElementById('save-btn').addEventListener('click', () => {
    // Update API keys and model
    configData.github_token = document.getElementById('github-token').value;
    configData.gemini_api_key = document.getElementById('gemini-api-key').value;
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
        // Claude uses ANTHROPIC_API_KEY - we'll add this field if needed
        showNotification('Note: Claude models require ANTHROPIC_API_KEY in environment', 'warning');
    } else if (selectedModel.startsWith('gpt')) {
        // GPT uses OPENAI_API_KEY - we'll add this field if needed
        showNotification('Note: GPT models require OPENAI_API_KEY in environment', 'warning');
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

