const assert = require('assert');
const { DEFAULT_MODEL, MODEL_MIGRATIONS, KNOWN_MODEL_IDS, providerForModel, migrateModel } = require('../model-policy');

assert.strictEqual(DEFAULT_MODEL, 'claude-sonnet-5');
assert.ok(KNOWN_MODEL_IDS.has('claude-sonnet-5'));
assert.strictEqual(providerForModel('gemini/gemini-3.5-flash'), 'gemini');
assert.strictEqual(providerForModel('claude-sonnet-5'), 'anthropic');
assert.strictEqual(providerForModel('gpt-5.6-terra'), 'openai');
assert.strictEqual(providerForModel('o3'), 'openai');
assert.strictEqual(providerForModel('chatgpt-4o-latest'), 'openai');
assert.strictEqual(providerForModel('mystery'), null);
for (const [oldId, newId] of Object.entries(MODEL_MIGRATIONS)) {
  assert.strictEqual(migrateModel(oldId), newId, `migrate ${oldId}`);
  assert.ok(KNOWN_MODEL_IDS.has(newId), `target ${newId} in KNOWN_MODEL_IDS`);
}
assert.strictEqual(migrateModel('claude-sonnet-5'), 'claude-sonnet-5');

const { MODEL_SUGGESTIONS, suggestUpgrade } = require('../model-policy');
assert.deepStrictEqual(MODEL_SUGGESTIONS, {
  'claude-sonnet-4-6': 'claude-sonnet-5',
  'claude-opus-4-7': 'claude-opus-5',
  'claude-opus-4-8': 'claude-opus-5',
  'gemini/gemini-2.5-flash': 'gemini/gemini-3.6-flash',
  'gemini/gemini-3.5-flash': 'gemini/gemini-3.6-flash',
  'gemini/gemini-2.5-flash-lite': 'gemini/gemini-3.1-flash-lite',
}, 'MODEL_SUGGESTIONS must be exactly the six normative rows');
assert.strictEqual(suggestUpgrade('gemini/gemini-2.5-flash'), 'gemini/gemini-3.6-flash');
assert.strictEqual(suggestUpgrade('claude-sonnet-5'), null, 'newest-in-tier has no suggestion');
assert.strictEqual(suggestUpgrade('claude-opus-5'), null, 'newest-in-tier has no suggestion');
// No suggestion target may itself have a suggestion — otherwise a user is walked forward one
// notice per launch instead of landing on the current best in tier in a single step.
for (const to of Object.values(MODEL_SUGGESTIONS)) {
  assert.strictEqual(suggestUpgrade(to), null, `suggestion target is not terminal: ${to}`);
}
assert.strictEqual(suggestUpgrade(null), null);

console.log('model-policy OK:', Object.keys(MODEL_MIGRATIONS).length, 'migrations');
