const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
const { resolveChannel, layout, cliPath, ChannelError } = require('../paths');

test('resolveChannel reads build-info channel', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-'));
  fs.writeFileSync(path.join(d, 'build-info.json'), JSON.stringify({ channel: 'dev' }));
  assert.strictEqual(resolveChannel(path.join(d, 'build-info.json')), 'dev');
});
test('resolveChannel fails closed when missing', () => {
  assert.throws(() => resolveChannel('/no/such/build-info.json'), ChannelError);
});
test('resolveChannel fails closed on malformed channel', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-'));
  fs.writeFileSync(path.join(d, 'build-info.json'), JSON.stringify({ channel: 'prod' }));
  assert.throws(() => resolveChannel(path.join(d, 'build-info.json')), ChannelError);
});
test('layout composes channel-namespaced paths; root lock is shared', () => {
  const L = layout('/H', 'dev');
  assert.strictEqual(L.execLock, '/H/.repo-radar/.exec.lock');
  assert.strictEqual(L.activationLock, '/H/.repo-radar/dev/.activation.lock');
  assert.strictEqual(L.current, '/H/.repo-radar/dev/current');
  assert.strictEqual(cliPath('/H', 'dev'), '/H/.local/bin/repo-radar-dev');
  assert.strictEqual(cliPath('/H', 'stable'), '/H/.local/bin/repo-radar');
});
