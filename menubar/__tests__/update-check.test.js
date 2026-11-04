const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { HttpError, newError } = require('builder-util-runtime');

const { updateCheckFailureDialog } = require('../update-check');

const RAW = 'Headers: { "set-cookie": ["session=SENTINEL"] }';

test('the Check for Updates dialog is friendly and never shows the raw response', () => {
  const http404 = new HttpError(404, `404 Not Found\n${RAW}`);
  const missing = [
    http404,
    newError(`Cannot find latest-mac.yml: ${RAW}`, 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'),
    newError(`Unable to find latest version: HttpError: 404 Not Found\n${RAW}`, 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND'),
  ];
  for (const err of missing) {
    assert.strictEqual(updateCheckFailureDialog(err).detail, "In-app updates aren't set up yet. Install updates manually.");
  }

  const others = [
    new HttpError(500, `500 Server Error\n${RAW}`),
    newError(`Unable to find latest version: getaddrinfo ENOTFOUND\n${RAW}`, 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND'),
    new Error(RAW),
    null,
  ];
  for (const err of others) {
    const { detail } = updateCheckFailureDialog(err);
    assert.strictEqual(detail, 'Check your connection and try again later.');
  }

  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /\.catch\(\(err\) => \{\s*dialog\.showMessageBox\(updateCheckFailureDialog\(err\)\);/);
  assert.doesNotMatch(main, /detail: err\.message/);
});
