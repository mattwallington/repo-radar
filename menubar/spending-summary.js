'use strict';
// Main's side of the weekly spend readout, and the owner-only atomic write Settings saves go through.
//
// The readout comes from Python's own aggregation (repo_radar/spending.py summary), the same function
// admission uses, run with the channel's verified runtime interpreter and source: no sync runner, no
// provisioning, no provider credentials, a bounded timeout. Only the validated aggregate reaches the
// renderer; a failure of any kind is "unavailable", never $0.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { validateSummary } = require('./spending-settings');

const SUMMARY_TIMEOUT_MS = 5000;
const SUMMARY_MAX_BYTES = 16 * 1024;
const UNAVAILABLE = Object.freeze({ status: 'unavailable' });

// runner: { python, cwd, env } for the verified generation, or null when the runtime isn't usable.
function readSpendingSummary(runner, { run = execFile, timeoutMs = SUMMARY_TIMEOUT_MS } = {}) {
  if (!runner || typeof runner.python !== 'string' || !runner.python) return Promise.resolve(UNAVAILABLE);
  return new Promise((resolve) => {
    try {
      run(runner.python, ['-m', 'repo_radar.spending', 'summary'],
        { cwd: runner.cwd, env: runner.env, timeout: timeoutMs, maxBuffer: SUMMARY_MAX_BYTES, windowsHide: true },
        (error, stdout) => {
          if (error) return resolve(UNAVAILABLE);
          try {
            resolve(validateSummary(JSON.parse(String(stdout))));
          } catch (_) {
            resolve(UNAVAILABLE);
          }
        });
    } catch (_) {
      resolve(UNAVAILABLE);
    }
  });
}

// The helper's environment: only what Python needs to find the source and the Settings file. Nothing from
// the app's own environment, so no provider key can reach it.
function summaryRunner(current, home, channel) {
  return {
    python: path.join(current, 'venv', 'bin', 'python'),
    cwd: current,
    env: { PYTHONPATH: current, HOME: home, PATH: '/usr/bin:/bin', REPO_RADAR_CHANNEL: channel },
  };
}

// Replace `file` with `text` so a reader (a sync admitting spend) never sees a partly written file: an
// owner-only temp file beside it, synced, then renamed over it. The chmod also tightens an older 0644 file.
function writePrivateFileAtomic(file, text) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  } catch (e) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) { /* already failing */ }
    }
    try { fs.unlinkSync(tmp); } catch (_) { /* never created, or already renamed */ }
    throw e;
  }
}

module.exports = { readSpendingSummary, summaryRunner, writePrivateFileAtomic, UNAVAILABLE };
