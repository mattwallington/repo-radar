const test = require('node:test'); const assert = require('node:assert');
const { computeModelNotice, noticeSignature, parseModelLabels, humanizeModelId, renderNoticeText } = require('../model-notice');

test('computeModelNotice: null saved model -> null', () => {
  assert.strictEqual(computeModelNotice(null), null);
  assert.strictEqual(computeModelNotice(''), null);
});
test('computeModelNotice: live model, no suggestion -> null', () => {
  assert.strictEqual(computeModelNotice('claude-sonnet-5-5'), null);
});
test('computeModelNotice: live model with suggestion -> suggestion', () => {
  assert.deepStrictEqual(computeModelNotice('claude-sonnet-4-6'),
    { kind: 'suggestion', from: 'claude-sonnet-4-6', effective: 'claude-sonnet-4-6', suggested: 'claude-sonnet-5-5' });
});
test('Sonnet 4.5, retiring Nov 30, is offered Sonnet 5.5; Keep preserves the selection', () => {
  const n = computeModelNotice('claude-sonnet-4-5');
  assert.deepStrictEqual(n, { kind: 'suggestion', from: 'claude-sonnet-4-5', effective: 'claude-sonnet-4-5', suggested: 'claude-sonnet-5-5' });
  const r = require('../model-notice').planFinalize('keep', { ai_model: 'claude-sonnet-4-5', repositories: [1] }, noticeSignature(n));
  assert.strictEqual(r.nextConfig.ai_model, 'claude-sonnet-4-5');
  assert.deepStrictEqual(r.nextConfig.repositories, [1]);
  assert.strictEqual(r.reconcileSchedule, false);
  assert.strictEqual(computeModelNotice('gpt-5.3-codex'), null, 'newest of its tier: nothing to suggest');
});
test('computeModelNotice: retired model, clean target -> migration', () => {
  assert.deepStrictEqual(computeModelNotice('claude-3-5-sonnet-20241022'),
    { kind: 'migration', from: 'claude-3-5-sonnet-20241022', effective: 'claude-sonnet-5-5' });
});
test('computeModelNotice: retired model lands on its tier\'s newest member -> plain migration', () => {
  // Migration targets are always the newest in tier, so they never carry a follow-on suggestion.
  assert.deepStrictEqual(computeModelNotice('gemini/gemini-2.0-flash'),
    { kind: 'migration', from: 'gemini/gemini-2.0-flash', effective: 'gemini/gemini-3.8-flash' });
});
test('noticeSignature: distinct per kind and content', () => {
  assert.strictEqual(noticeSignature(null), null);
  assert.strictEqual(noticeSignature(computeModelNotice('claude-sonnet-4-6')), 'suggestion:claude-sonnet-4-6>claude-sonnet-5-5');
  assert.strictEqual(noticeSignature(computeModelNotice('claude-3-5-sonnet-20241022')), 'migration:claude-3-5-sonnet-20241022>claude-sonnet-5-5');
});
test('parseModelLabels + humanizeModelId: dropdown label, fallback to raw id', () => {
  const map = parseModelLabels('<select id="ai-model"><option value="claude-sonnet-5-5">Claude Sonnet 5.5</option></select>');
  assert.strictEqual(humanizeModelId('claude-sonnet-5-5', map), 'Claude Sonnet 5.5');
  assert.strictEqual(humanizeModelId('claude-3-5-sonnet-20241022', map), 'claude-3-5-sonnet-20241022'); // retired, not in map
});
test('renderNoticeText: suggestion buttons + humanized labels', () => {
  const map = { 'gemini/gemini-3.6-flash': 'Gemini 3.6 Flash', 'gemini/gemini-3.8-flash': 'Gemini 3.8 Flash' };
  const v = renderNoticeText(computeModelNotice('gemini/gemini-3.6-flash'), map);
  assert.deepStrictEqual(v.buttons.map(b => b.action), ['switch', 'keep', 'review']);
  assert.match(v.body, /Gemini 3\.6 Flash/);
  assert.match(v.body, /Gemini 3\.8 Flash/);
});

const { resolveNoticeAction, planFinalize, persistConfig } = require('../model-notice');

test('resolveNoticeAction: per-kind allow-list + close mapping + disallowed', () => {
  const sug = computeModelNotice('claude-sonnet-4-6');
  assert.deepStrictEqual(resolveNoticeAction('switch', sug), { finalModel: 'claude-sonnet-5-5', openSettings: false });
  assert.deepStrictEqual(resolveNoticeAction('keep', sug), { finalModel: null, openSettings: false });
  assert.deepStrictEqual(resolveNoticeAction('close', sug), { finalModel: null, openSettings: false });
  assert.deepStrictEqual(resolveNoticeAction('review', sug), { finalModel: null, openSettings: true });
  assert.strictEqual(resolveNoticeAction('acknowledge', sug), null, 'acknowledge not valid for suggestion');

  const mig = computeModelNotice('claude-3-5-sonnet-20241022');
  assert.deepStrictEqual(resolveNoticeAction('acknowledge', mig), { finalModel: 'claude-sonnet-5-5', openSettings: false });
  assert.deepStrictEqual(resolveNoticeAction('close', mig), { finalModel: 'claude-sonnet-5-5', openSettings: false });
  assert.strictEqual(resolveNoticeAction('switch', mig), null, 'switch not valid for migration');
});

test('planFinalize: stale when displayed signature no longer matches disk', () => {
  const cfg = { ai_model: 'claude-sonnet-4-6' };
  const r = planFinalize('switch', cfg, 'suggestion:SOMETHING>ELSE');
  assert.strictEqual(r.staleOrGone, true);
  assert.strictEqual(r.valid, false);
});

test('planFinalize: migration acknowledge persists effective and does not re-prompt', () => {
  const cfg = { ai_model: 'gemini/gemini-2.0-flash', repositories: [1, 2] };
  const sig = noticeSignature(computeModelNotice(cfg.ai_model));
  const r = planFinalize('acknowledge', cfg, sig);
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.nextConfig.ai_model, 'gemini/gemini-3.8-flash');
  assert.strictEqual(r.reconcileSchedule, true, 'model changed retired->effective');
  assert.deepStrictEqual(r.nextConfig.repositories, [1, 2], 'preserves full config');
  assert.strictEqual(computeModelNotice(r.nextConfig.ai_model), null, 'next launch shows nothing');
});

test('planFinalize: suggestion Keep is ack-only (no model change, no reconcile)', () => {
  const cfg = { ai_model: 'claude-sonnet-4-6' };
  const sig = noticeSignature(computeModelNotice(cfg.ai_model));
  const r = planFinalize('keep', cfg, sig);
  assert.strictEqual(r.nextConfig.ai_model, 'claude-sonnet-4-6');
  assert.strictEqual(r.reconcileSchedule, false);
  assert.strictEqual(r.nextConfig.model_notice_ack, 'suggestion:claude-sonnet-4-6>claude-sonnet-5-5');
});

test('persistConfig: save first; on save failure DO NOT reconcile', () => {
  let reconciled = false;
  const res = persistConfig({ ai_model: 'x' }, {
    reconcileSchedule: true,
    save: () => ({ success: false, error: 'disk full' }),
    reconcile: () => { reconciled = true; return { success: true }; },
  });
  assert.deepStrictEqual(res, { ok: false, stage: 'save', error: 'disk full' });
  assert.strictEqual(reconciled, false, 'never reconcile after a failed save');
});

test('persistConfig: ack-only skips reconcile; schedule failure is non-fatal', () => {
  assert.deepStrictEqual(persistConfig({}, { reconcileSchedule: false, save: () => ({ success: true }), reconcile: () => { throw new Error('should not run'); } }),
    { ok: true, schedule: { ok: true, skipped: true } });
  const res = persistConfig({}, { reconcileSchedule: true, save: () => ({ success: true }), reconcile: () => ({ success: false, error: 'no launchctl' }) });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.schedule.ok, false);
  assert.strictEqual(res.schedule.error, 'no launchctl');
});

// OpenAI shut these down 2026-10-23. Each stored selection gets a plain migration notice to the
// newest model of its own tier, and finalizing it persists that without touching the rest of the config.
const RETIRED_2026_10_23 = {
  'gpt-4.1-nano': 'gpt-6-luna',
  'o4-mini': 'gpt-6.1-terra',
  'o1': 'gpt-6.1-sol',
  'o3-mini': 'gpt-6.1-terra',
  'o1-pro': 'gpt-5.5-pro',
};
for (const [from, effective] of Object.entries(RETIRED_2026_10_23)) {
  test(`October 2026 retirement ${from} -> ${effective}: migration notice, finalize preserves settings`, () => {
    const { migrateModel } = require('../model-policy');
    assert.strictEqual(migrateModel(from), effective, 'launch policy runs the replacement');
    const notice = computeModelNotice(from);
    assert.deepStrictEqual(notice, { kind: 'migration', from, effective });
    const cfg = { ai_model: from, repositories: [1, 2], openai_api_key_set: true };
    const r = planFinalize('acknowledge', cfg, noticeSignature(notice));
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.nextConfig.ai_model, effective);
    assert.strictEqual(r.reconcileSchedule, true);
    assert.deepStrictEqual(r.nextConfig.repositories, [1, 2]);
    assert.strictEqual(r.nextConfig.openai_api_key_set, true);
  });
}

test('Gemini 2.5 Pro is still served: stays selected, no notice', () => {
  const { migrateModel } = require('../model-policy');
  assert.strictEqual(migrateModel('gemini/gemini-2.5-pro'), 'gemini/gemini-2.5-pro');
  assert.strictEqual(computeModelNotice('gemini/gemini-2.5-pro'), null);
});
