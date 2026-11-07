'use strict';
// The Settings spending values: one policy for the window and main's save, matching Python's, and a save
// that writes nothing when a value is invalid and reports a dev save truthfully.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const spending = require('../spending-settings');
const { saveSettings } = require('../model-notice');

const LIMIT = spending.LIMIT_FIELD;
const STOP = spending.STOP_FIELD;

test('typed input is parsed strictly and checked against the bounds', () => {
  const limit = (text) => spending.validateSpending({ [LIMIT]: spending.parseLimitInput(text), [STOP]: 2 });
  const stop = (text) => spending.validateSpending({ [LIMIT]: 12, [STOP]: spending.parseStopInput(text) });
  for (const ok of ['12', '1', '100', '12.5', ' 99.99 ']) assert.strictEqual(limit(ok), null, ok);
  for (const bad of ['', ' ', '0', '0.99', '100.01', '12.345', '-5', '1e1', '12abc', '$12', 'NaN', 'Infinity']) {
    assert.strictEqual(limit(bad).field, LIMIT, bad);
  }
  for (const ok of ['1', '2', '10']) assert.strictEqual(stop(ok), null, ok);
  for (const bad of ['', '0', '11', '1.5', '2.0', '-1', 'two']) assert.strictEqual(stop(bad).field, STOP, bad);
  // Config values must be real JSON numbers, not booleans or numeric strings.
  for (const bad of [true, '12', null, undefined, NaN, Infinity]) {
    assert.strictEqual(spending.validateSpending({ [LIMIT]: bad, [STOP]: 2 }).field, LIMIT, String(bad));
    assert.strictEqual(spending.validateSpending({ [LIMIT]: 12, [STOP]: bad }).field, STOP, String(bad));
  }
  // What Settings shows: stored valid values, otherwise the defaults; and the actual rebuild age.
  assert.deepStrictEqual(spending.effectiveSpending({}), { limitUsd: 12, failureStop: 2 });
  assert.deepStrictEqual(spending.effectiveSpending({ [LIMIT]: 0, [STOP]: 0 }), { limitUsd: 12, failureStop: 2 });
  assert.deepStrictEqual(spending.effectiveSpending({ [LIMIT]: 7.5, [STOP]: 4 }), { limitUsd: 7.5, failureStop: 4 });
  assert.strictEqual(spending.rebuildIntervalText({}), 'Full summaries are rebuilt every 7 days.');
  assert.strictEqual(spending.rebuildIntervalText({ incremental_full_rebuild_days: 3 }), 'Full summaries are rebuilt every 3 days.');
  assert.strictEqual(spending.rebuildIntervalText({ incremental_full_rebuild_days: 0 }), 'Full summaries are not rebuilt on a schedule.');
  assert.strictEqual(spending.rebuildIntervalText({ incremental_full_rebuild_days: '7' }), null);
});

test('Python enforces the same bounds', () => {
  const values = [1, 12, 12.5, 100, 0, 0.5, 100.01, 12.345, 2, 10, 11, 1.5];
  const out = execFileSync('python3', ['-c',
    'import sys,json;sys.path.insert(0,".");from repo_radar import config as c;v=json.loads(sys.argv[1]);' +
    'print(json.dumps([[c.valid_incremental_update_limit(x),c.valid_incremental_failure_stop(x)] for x in v]))',
    JSON.stringify(values)], { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' });
  assert.deepStrictEqual(JSON.parse(out), values.map((v) => [spending.isValidLimit(v), spending.isValidStop(v)]));
});

test('Save writes nothing for an invalid value and a dev save reports truthfully', () => {
  const calls = [];
  const hooks = (channel) => ({
    channel,
    save: (config) => { calls.push(['save', config]); return { success: true }; },
    reconcile: () => { calls.push(['reconcile']); return { success: false, error: 'Dev builds cannot install a persistent sync schedule.' }; },
  });

  const refused = saveSettings({ [LIMIT]: 12, [STOP]: 0 }, hooks('stable'));
  assert.deepStrictEqual([refused.ok, refused.field, calls.length], [false, STOP, 0]);

  const dev = saveSettings({ [LIMIT]: 5.25, [STOP]: 3, schedule: { enabled: true } }, hooks('dev'));
  assert.strictEqual(dev.ok, true);
  assert.notStrictEqual(dev.schedule.ok, false, 'a dev save is not reported as a schedule failure');
  assert.deepStrictEqual(calls.map((c) => c[0]), ['save']);
  assert.strictEqual(calls[0][1][LIMIT], 5.25);

  calls.length = 0;
  const stable = saveSettings({ [LIMIT]: 12, [STOP]: 2 }, hooks('stable'));
  assert.deepStrictEqual([stable.ok, stable.schedule.ok, calls.map((c) => c[0])], [true, false, ['save', 'reconcile']]);
});
