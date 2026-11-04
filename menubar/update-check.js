'use strict';
// What the Check for Updates dialog says when the check fails. electron-updater's messages include
// the whole HTTP response (headers and cookies), so they never reach the dialog.

const NOT_SET_UP = "In-app updates aren't set up yet. Install updates manually.";
const FAILED = 'Check your connection and try again later.';

function isFeedMissing(err) {
  if (!err) return false;
  return err.statusCode === 404
    || err.code === 'HTTP_ERROR_404'
    || err.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
    // The latest-version lookup wraps every failure in one code, with the original in its message.
    || (err.code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' && /\bHttpError: 404\b/.test(String(err.message)));
}

function updateCheckFailureDialog(err) {
  const missing = isFeedMissing(err);
  return {
    type: missing ? 'info' : 'error',
    title: 'Update Check Failed',
    message: 'Could not check for updates.',
    detail: missing ? NOT_SET_UP : FAILED,
  };
}

module.exports = { updateCheckFailureDialog };
