'use strict';
// Ruling P6-1: what the progress window shows when a sync it already opened for is REFUSED before
// it ever starts. Two ways that happens, both from runSync()'s rejection: the root exec lock in
// runtime/lock.js was already held by another sync (LockBusy -> 'already-running'), or runSync
// never got as far as a child at all (verifyRuntime / venv / python resolution failed ->
// 'failed-to-start'). No child runs in either case, so no progress event ever arrives.
//
// Main sends one of a CLOSED set of reasons; this file maps it to a FIXED sentence. The reason is
// never rendered, and neither is the error -- an unknown reason gets the failed-to-start text
// rather than an echo. The real error is in the log, reachable via the tray's "View Errors".
//
// It lives in its own file, loaded by its own <script> tag before renderer.js, for one reason:
// renderer.js requires electron and writes a log file at module load, so it can't be exercised in
// a test. Everything here takes `doc` as an argument and touches nothing else, so it can.
// Text only -- no innerHTML/insertAdjacentHTML on this path, even though the surrounding legacy
// renderer uses them (this window is the old nodeIntegration one; don't add new markup sinks).

// A CLOSED set: reason -> the exact sentence shown. Anything else (a future main.js reason, a
// garbled payload) falls back to the failed-to-start text, which is the safe thing to say about a
// sync that demonstrably did not start. The reason itself is never rendered.
const SYNC_REFUSED_TEXTS = {
    'already-running': 'Not started — another sync is already running',
    'failed-to-start': 'Sync could not start — see ⚠️ View Errors in the menu',
};
const SYNC_REFUSED_DEFAULT_REASON = 'failed-to-start';
const SYNC_REFUSED_STATUS_TEXT = SYNC_REFUSED_TEXTS['already-running'];

function syncRefusedText(reason) {
    return Object.prototype.hasOwnProperty.call(SYNC_REFUSED_TEXTS, reason)
        ? SYNC_REFUSED_TEXTS[reason]
        : SYNC_REFUSED_TEXTS[SYNC_REFUSED_DEFAULT_REASON];
}

function applySyncRefused(doc, reason) {
    if (!doc || typeof doc.getElementById !== 'function') return;
    const text = syncRefusedText(reason);

    // The status line is the thing that used to hang on "Starting sync..." forever.
    const statusText = doc.getElementById('status-text');
    if (statusText) {
        statusText.textContent = text;
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
            line.textContent = text;
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
    module.exports = { SYNC_REFUSED_TEXTS, SYNC_REFUSED_STATUS_TEXT, syncRefusedText, applySyncRefused };
}
