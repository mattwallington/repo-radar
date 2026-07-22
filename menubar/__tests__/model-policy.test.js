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
console.log('model-policy OK:', Object.keys(MODEL_MIGRATIONS).length, 'migrations');
