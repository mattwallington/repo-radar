'use strict';
// The Settings spending values: one policy for the window and main's save, matching Python's, and a save
// that writes nothing when a value is invalid and reports a dev save truthfully. Also the weekly spend
// readout, which shows Python's own totals or "unavailable", never a made-up $0.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const spending = require('../spending-settings');
const { saveSettings, sameSchedule, DEV_SCHEDULE_KEPT } = require('../model-notice');
const { readSpendingSummary, writePrivateFileAtomic } = require('../spending-summary');

const LIMIT = spending.LIMIT_FIELD;
const STOP = spending.STOP_FIELD;
const ON = spending.WEEKLY_ENABLED_FIELD;
const CAP = spending.WEEKLY_CAP_FIELD;
const REPO = path.join(__dirname, '..', '..');
const WEEKLY = { [ON]: true, [CAP]: 75 };

test('typed input is parsed strictly and checked against the bounds', () => {
  const limit = (text) => spending.validateSpending({ ...WEEKLY, [LIMIT]: spending.parseLimitInput(text), [STOP]: 2 });
  const stop = (text) => spending.validateSpending({ ...WEEKLY, [LIMIT]: 12, [STOP]: spending.parseStopInput(text) });
  const cap = (text) => spending.validateSpending({ [LIMIT]: 12, [STOP]: 2, [ON]: true, [CAP]: spending.parseLimitInput(text) });
  for (const ok of ['12', '1', '100', '12.5', ' 99.99 ']) assert.strictEqual(limit(ok), null, ok);
  for (const bad of ['', ' ', '0', '0.99', '100.01', '12.345', '-5', '1e1', '12abc', '$12', 'NaN', 'Infinity']) {
    assert.strictEqual(limit(bad).field, LIMIT, bad);
  }
  for (const ok of ['1', '2', '10']) assert.strictEqual(stop(ok), null, ok);
  for (const bad of ['', '0', '11', '1.5', '2.0', '-1', 'two']) assert.strictEqual(stop(bad).field, STOP, bad);
  for (const ok of ['1', '75', '1000', '62.5']) assert.strictEqual(cap(ok), null, ok);
  for (const bad of ['', '0', '0.99', '1000.01', '75.001', '1,000', '$75']) assert.strictEqual(cap(bad).field, CAP, bad);
  // Config values must be real JSON numbers, not booleans or numeric strings.
  for (const bad of [true, '12', null, undefined, NaN, Infinity]) {
    assert.strictEqual(spending.validateSpending({ ...WEEKLY, [LIMIT]: bad, [STOP]: 2 }).field, LIMIT, String(bad));
    assert.strictEqual(spending.validateSpending({ ...WEEKLY, [LIMIT]: 12, [STOP]: bad }).field, STOP, String(bad));
    assert.strictEqual(spending.validateSpending({ [LIMIT]: 12, [STOP]: 2, [ON]: true, [CAP]: bad }).field, CAP, String(bad));
  }
  for (const bad of ['true', 1, null, undefined]) {   // only a literal boolean is saved
    assert.strictEqual(spending.validateSpending({ [LIMIT]: 12, [STOP]: 2, [ON]: bad, [CAP]: 75 }).field, ON, String(bad));
  }
  // What Settings shows: stored valid values, otherwise the defaults; and the actual rebuild age.
  // The weekly cap is on at $75 unless saved otherwise; a malformed flag stays on, only false turns it off.
  const defaults = { limitUsd: 12, failureStop: 2, weeklyEnabled: true, weeklyCapUsd: 75 };
  assert.deepStrictEqual(spending.effectiveSpending({}), defaults);
  assert.deepStrictEqual(spending.effectiveSpending({ [LIMIT]: 0, [STOP]: 0, [ON]: 'no', [CAP]: 0 }), defaults);
  assert.deepStrictEqual(spending.effectiveSpending({ [LIMIT]: 7.5, [STOP]: 4, [ON]: false, [CAP]: 120.5 }),
    { limitUsd: 7.5, failureStop: 4, weeklyEnabled: false, weeklyCapUsd: 120.5 });
  assert.strictEqual(spending.rebuildIntervalText({}), 'Full summaries are rebuilt every 7 days.');
  assert.strictEqual(spending.rebuildIntervalText({ incremental_full_rebuild_days: 3 }), 'Full summaries are rebuilt every 3 days.');
  assert.strictEqual(spending.rebuildIntervalText({ incremental_full_rebuild_days: 0 }), 'Full summaries are not rebuilt on a schedule.');
  assert.strictEqual(spending.rebuildIntervalText({ incremental_full_rebuild_days: '7' }), null);
});

test('Python enforces the same bounds', () => {
  const values = [1, 12, 12.5, 99.99, 1.01, 100, 0, 0.5, 100.01, 12.345, 12.000000001, 2, 10, 11, 1.5, 75, 999.99,
    1000, 1000.01];
  const out = execFileSync('python3', ['-c',
    'import sys,json;sys.path.insert(0,".");from repo_radar import config as c;v=json.loads(sys.argv[1]);' +
    'print(json.dumps([[c.valid_incremental_update_limit(x),c.valid_incremental_failure_stop(x),c.valid_weekly_cap(x)] for x in v]))',
    JSON.stringify(values)], { cwd: REPO, encoding: 'utf8' });
  assert.deepStrictEqual(JSON.parse(out),
    values.map((v) => [spending.isValidLimit(v), spending.isValidStop(v), spending.isValidWeeklyCap(v)]));
  // The weekly policy each sync reads matches what Settings shows for the same saved values.
  const saved = [{}, { [ON]: false, [CAP]: 40 }, { [ON]: 'off', [CAP]: 0 }, { [ON]: true, [CAP]: 1000.01 }];
  const policies = JSON.parse(execFileSync('python3', ['-c',
    'import sys,json;sys.path.insert(0,".");from repo_radar import config as c;' +
    'print(json.dumps([c.weekly_spending_policy(x)[:2] for x in json.loads(sys.argv[1])]))',
    JSON.stringify(saved)], { cwd: REPO, encoding: 'utf8' }));
  assert.deepStrictEqual(policies, saved.map((x) => {
    const e = spending.effectiveSpending(x);
    return [e.weeklyEnabled, e.weeklyCapUsd];
  }));
  // Whole cents exactly: two-decimal amounts pass, a value a hair off a cent doesn't.
  assert.deepStrictEqual([99.99, 1.01, 12.000000001].map(spending.isValidLimit), [true, true, false]);
});

test('Save writes nothing for an invalid value and a dev save reports truthfully', () => {
  const calls = [];
  const hooks = (channel, scheduleKept = false) => ({
    channel,
    save: (config) => { calls.push(['save', config]); return { success: true, scheduleKept }; },
    reconcile: () => { calls.push(['reconcile']); return { success: false, error: 'Dev builds cannot install a persistent sync schedule.' }; },
  });

  const refused = saveSettings({ ...WEEKLY, [LIMIT]: 12, [STOP]: 0 }, hooks('stable'));
  assert.deepStrictEqual([refused.ok, refused.field, calls.length], [false, STOP, 0]);
  const overCap = saveSettings({ [LIMIT]: 12, [STOP]: 2, [ON]: true, [CAP]: 1000.5 }, hooks('stable'));
  assert.deepStrictEqual([overCap.ok, overCap.field, calls.length], [false, CAP, 0]);
  // With the limit off the amount stays editable and is still checked and kept: an invalid amount saves
  // nothing, the corrected one saves with the limit still off.
  assert.ok(!/weekly-cap[^\n]*\.disabled|\.disabled\s*=\s*!document\.getElementById\(SPENDING_INPUTS\[spending\.WEEKLY/.test(
    fs.readFileSync(path.join(__dirname, '..', 'renderer', 'settings.js'), 'utf8')), 'the weekly amount is never disabled');
  const offInvalid = saveSettings({ [LIMIT]: 12, [STOP]: 2, [ON]: false, [CAP]: spending.parseLimitInput('60.555') },
    hooks('stable'));
  assert.deepStrictEqual([offInvalid.ok, offInvalid.field, calls.length], [false, CAP, 0]);
  const offFixed = saveSettings({ [LIMIT]: 12, [STOP]: 2, [ON]: false, [CAP]: spending.parseLimitInput('60.55') },
    hooks('stable'));
  assert.ok(offFixed.ok);
  assert.deepStrictEqual([calls[0][1][ON], calls[0][1][CAP]], [false, 60.55]);
  calls.length = 0;

  const dev = saveSettings({ ...WEEKLY, [LIMIT]: 5.25, [STOP]: 3, schedule: { enabled: true } }, hooks('dev'));
  assert.strictEqual(dev.ok, true);
  assert.notStrictEqual(dev.schedule.ok, false, 'a dev save is not reported as a schedule failure');
  assert.deepStrictEqual(calls.map((c) => c[0]), ['save']);
  assert.strictEqual(calls[0][1][LIMIT], 5.25);
  assert.strictEqual(dev.notice, undefined);
  // A dev save that kept a stored schedule differing from the window's says so instead of plain success.
  assert.strictEqual(saveSettings({ ...WEEKLY, [LIMIT]: 12, [STOP]: 2 }, hooks('dev', true)).notice, DEV_SCHEDULE_KEPT);
  assert.strictEqual(saveSettings({ ...WEEKLY, [LIMIT]: 12, [STOP]: 2 }, hooks('stable', true)).notice, undefined);
  const daily = { enabled: true, type: 'daily', time: '09:00', interval: 6, days: [] };
  assert.ok(sameSchedule(daily, { days: [], interval: 6, time: '09:00', type: 'daily', enabled: true }));
  assert.ok(sameSchedule(undefined, { enabled: false, type: 'daily' }));
  assert.ok(!sameSchedule({ ...daily, time: '10:00' }, daily) && !sameSchedule(daily, undefined));

  calls.length = 0;
  const stable = saveSettings({ ...WEEKLY, [LIMIT]: 12, [STOP]: 2 }, hooks('stable'));
  assert.deepStrictEqual([stable.ok, stable.schedule.ok, calls.map((c) => c[0])], [true, false, ['save', 'reconcile']]);
});

test('Save and reopen, and the readout shows the same totals Python enforces', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-spend-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configDir = path.join(home, '.config', 'repo-radar');
  fs.mkdirSync(configDir, { recursive: true });
  const configFile = path.join(configDir, 'config.json');

  // Save writes the whole file atomically and owner-only; reopening shows exactly what was saved.
  fs.writeFileSync(configFile, JSON.stringify({ repositories: [] }), { mode: 0o644 });
  writePrivateFileAtomic(configFile, JSON.stringify({ ...WEEKLY, [CAP]: 60.5, [LIMIT]: 12, [STOP]: 2 }));
  assert.strictEqual(fs.statSync(configFile).mode & 0o777, 0o600);
  assert.deepStrictEqual(fs.readdirSync(configDir), ['config.json']);
  const reopened = spending.effectiveSpending(JSON.parse(fs.readFileSync(configFile, 'utf8')));
  assert.deepStrictEqual([reopened.weeklyEnabled, reopened.weeklyCapUsd], [true, 60.5]);

  const runner = { python: 'python3', cwd: REPO, env: { PYTHONPATH: REPO, HOME: home, PATH: process.env.PATH } };
  const python = (code) => execFileSync('python3', ['-c', code], { cwd: REPO, env: runner.env, encoding: 'utf8' });
  assert.strictEqual(spending.spendLine(await readSpendingSummary(runner)), 'Tracking starts with the next sync');
  assert.ok(!fs.existsSync(path.join(configDir, 'spending')), 'opening Settings creates no spending record');

  // A sync admits and settles through Python; Settings shows Python's own aggregate of that record.
  python('from repo_radar import spending as sp\n' +
    'h = sp.Spending("stable").admit("o/r", "m", "full", 40)\n' +
    'a, b = h.reserve([3, 2])\nh.settle(a, 8.4)\nh.close()\n' +
    'sp.Spending("dev").admit("o/s", "m", "incremental", 2)\n');
  const expected = JSON.parse(python('import json\nfrom repo_radar import spending as sp\nprint(json.dumps(sp.summary()))'));
  const shown = await readSpendingSummary(runner);
  assert.deepStrictEqual([shown.recordedUsd, shown.reservedUsd, shown.availableUsd, shown.capUsd],
    [expected.recorded_usd, expected.reserved_usd, expected.available_usd, 60.5]);
  assert.deepStrictEqual([shown.recordedUsd, shown.reservedUsd, shown.availableUsd], [8.4, 4, 48.1]);
  assert.match(spending.spendLine(shown),
    /^\$8\.40 recorded since \w{3} \d+, \d{4} · \$4\.00 reserved\/uncertain · \$48\.10 available of \$60\.50 · resets Monday 00:00 UTC\.$/);
  assert.match(spending.spendLine({ ...shown, enabled: false, availableUsd: null }), / · Weekly limit off · /);

  // Anything that can't be read is unavailable, never $0: a damaged record, a broken runtime, bad output.
  fs.writeFileSync(path.join(configDir, 'spending', 'ledger.json'), '{"schema": "other"}');
  assert.strictEqual(spending.spendLine(await readSpendingSummary(runner)), 'Spend unavailable');
  assert.strictEqual(spending.spendLine(await readSpendingSummary(null)), 'Spend unavailable');
  assert.strictEqual(spending.spendLine(await readSpendingSummary({ ...runner, python: path.join(home, 'missing') })),
    'Spend unavailable');
  const lying = (_p, _a, _o, done) => done(null, JSON.stringify({ status: 'ready', enabled: true, cap_usd: 75 }));
  assert.deepStrictEqual(await readSpendingSummary(runner, { run: lying }), { status: 'unavailable' });
});

test('an enabled schedule the LaunchAgent cannot run is refused on its own field', () => {
  const { parseIntervalInput, validateSchedule } = require('../schedule-settings');
  const at = (s) => (validateSchedule({ enabled: true, days: [1], time: '09:00', ...s }) || {}).input || null;
  assert.strictEqual(at({ type: 'daily' }), null);
  assert.strictEqual(at({ type: 'daily', time: '' }), 'schedule-time');            // used to become 09:00
  assert.strictEqual(at({ type: 'weekly', days: [] }), 'schedule-days');
  assert.strictEqual(at({ type: 'weekly', time: '' }), 'schedule-weekly-time');
  for (const ok of ['1', '6', '24']) assert.strictEqual(at({ type: 'hourly', interval: parseIntervalInput(ok) }), null, ok);
  for (const bad of ['', '0', '25', '-3', '2.5', 'six']) {
    assert.strictEqual(at({ type: 'hourly', interval: parseIntervalInput(bad) }), 'schedule-interval', bad);
  }
  assert.strictEqual(validateSchedule({ enabled: false, type: 'weekly', days: [], time: '' }), null);
});
