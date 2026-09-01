'use strict';
// Ruling P6-1: what the progress window shows when a sync it already opened for is REFUSED
// before it ever starts (the root exec lock in runtime/lock.js was held by another sync -- manual
// or scheduled, either channel -- so runSync() rejected with LockBusy and no child ever ran).
//
// Main sends 'sync-refused' with a FIXED payload; this file writes one FIXED sentence. The reason
// is never rendered: an unknown reason gets the same text rather than an echo.
//
// It lives in its own file, loaded by its own <script> tag before renderer.js, for one reason:
// renderer.js requires electron and writes a log file at module load, so it can't be exercised in
// a test. Everything here takes `doc` as an argument and touches nothing else, so it can.
// Text only -- no innerHTML/insertAdjacentHTML on this path, even though the surrounding legacy
// renderer uses them (this window is the old nodeIntegration one; don't add new markup sinks).

const SYNC_REFUSED_STATUS_TEXT = 'Not started — another sync is already running';

function applySyncRefused(doc) {
    if (!doc || typeof doc.getElementById !== 'function') return;

    // The status line is the thing that used to hang on "Starting sync..." forever.
    const statusText = doc.getElementById('status-text');
    if (statusText) {
        statusText.textContent = SYNC_REFUSED_STATUS_TEXT;
        if (statusText.style) statusText.style.color = '#f0ad4e';
    }

    const repoCount = doc.getElementById('repo-count');
    if (repoCount) repoCount.textContent = '';

    // Drop the grid of "Waiting..." rows: none of those repos is being synced by this attempt,
    // and no progress-update will ever arrive to move them.
    const reposList = doc.getElementById('repos-list');
    if (reposList) {
        while (reposList.firstChild) reposList.removeChild(reposList.firstChild);
        if (typeof doc.createElement === 'function') {
            const wrap = doc.createElement('div');
            wrap.className = 'empty-message';
            const line = doc.createElement('p');
            line.textContent = SYNC_REFUSED_STATUS_TEXT;
            wrap.appendChild(line);
            reposList.appendChild(wrap);
        }
    }

    // Nothing is running, so there is nothing to stop. `active` is also what drives the
    // pulse-red CSS animation, so removing it is what stops the button pulsing.
    const stopBtn = doc.getElementById('stop-sync-btn');
    if (stopBtn) {
        stopBtn.disabled = true;
        if (stopBtn.classList) stopBtn.classList.remove('active');
        stopBtn.textContent = '⏹';
    }
}

// Loaded as a plain <script> in the window; require()'d by __tests__/sync-refused-dom.test.js.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SYNC_REFUSED_STATUS_TEXT, applySyncRefused };
}
