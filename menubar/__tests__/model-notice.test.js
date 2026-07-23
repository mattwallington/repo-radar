const test = require('node:test'); const assert = require('node:assert');
const { computeModelNotice, noticeSignature, parseModelLabels, humanizeModelId, renderNoticeText } = require('../model-notice');

test('computeModelNotice: null saved model -> null', () => {
  assert.strictEqual(computeModelNotice(null), null);
  assert.strictEqual(computeModelNotice(''), null);
});
test('computeModelNotice: live model, no suggestion -> null', () => {
  assert.strictEqual(computeModelNotice('claude-sonnet-5'), null);
});
test('computeModelNotice: live model with suggestion -> suggestion', () => {
  assert.deepStrictEqual(computeModelNotice('claude-sonnet-4-6'),
    { kind: 'suggestion', from: 'claude-sonnet-4-6', effective: 'claude-sonnet-4-6', suggested: 'claude-sonnet-5' });
});
test('computeModelNotice: retired model, clean target -> migration', () => {
  assert.deepStrictEqual(computeModelNotice('claude-3-5-sonnet-20241022'),
    { kind: 'migration', from: 'claude-3-5-sonnet-20241022', effective: 'claude-sonnet-5' });
});
test('computeModelNotice: retired model whose target has a suggestion -> compound', () => {
  assert.deepStrictEqual(computeModelNotice('gemini/gemini-2.0-flash'),
    { kind: 'compound', from: 'gemini/gemini-2.0-flash', effective: 'gemini/gemini-2.5-flash', suggested: 'gemini/gemini-3.5-flash' });
});
test('noticeSignature: distinct per kind and content', () => {
  assert.strictEqual(noticeSignature(null), null);
  assert.strictEqual(noticeSignature(computeModelNotice('claude-sonnet-4-6')), 'suggestion:claude-sonnet-4-6>claude-sonnet-5');
  assert.strictEqual(noticeSignature(computeModelNotice('claude-3-5-sonnet-20241022')), 'migration:claude-3-5-sonnet-20241022>claude-sonnet-5');
  assert.strictEqual(noticeSignature(computeModelNotice('gemini/gemini-2.0-flash')), 'compound:gemini/gemini-2.0-flash>gemini/gemini-2.5-flash>gemini/gemini-3.5-flash');
});
test('parseModelLabels + humanizeModelId: dropdown label, fallback to raw id', () => {
  const map = parseModelLabels('<select id="ai-model"><option value="claude-sonnet-5">Claude Sonnet 5</option></select>');
  assert.strictEqual(humanizeModelId('claude-sonnet-5', map), 'Claude Sonnet 5');
  assert.strictEqual(humanizeModelId('claude-3-5-sonnet-20241022', map), 'claude-3-5-sonnet-20241022'); // retired, not in map
});
test('renderNoticeText: compound buttons + humanized labels', () => {
  const map = { 'gemini/gemini-2.5-flash': 'Gemini 2.5 Flash', 'gemini/gemini-3.5-flash': 'Gemini 3.5 Flash' };
  const v = renderNoticeText(computeModelNotice('gemini/gemini-2.0-flash'), map);
  assert.deepStrictEqual(v.buttons.map(b => b.action), ['switch', 'keep', 'review']);
  assert.match(v.body, /Gemini 2\.5 Flash/);
  assert.match(v.body, /Gemini 3\.5 Flash/);
});
