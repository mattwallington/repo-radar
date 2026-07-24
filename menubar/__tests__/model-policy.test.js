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
  'claude-opus-4-7': 'claude-opus-4-8',
  'gemini/gemini-2.5-flash': 'gemini/gemini-3.5-flash',
  'gemini/gemini-2.5-flash-lite': 'gemini/gemini-3.1-flash-lite',
}, 'MODEL_SUGGESTIONS must be exactly the four normative rows');
assert.strictEqual(suggestUpgrade('gemini/gemini-2.5-flash'), 'gemini/gemini-3.5-flash');
assert.strictEqual(suggestUpgrade('claude-sonnet-5'), null, 'newest-in-tier has no suggestion');
assert.strictEqual(suggestUpgrade(null), null);

console.log('model-policy OK:', Object.keys(MODEL_MIGRATIONS).length, 'migrations');
