const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { KNOWN_MODEL_IDS, DEFAULT_MODEL } = require('../model-policy');

const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'settings.html'), 'utf8');
// scope to the ai-model select
const sel = html.slice(html.indexOf('id="ai-model"'));
const selBody = sel.slice(0, sel.indexOf('</select>'));

const groups = (selBody.match(/<optgroup/g) || []).length;
assert.strictEqual(groups, 5, `expected 5 optgroups, got ${groups}`);

const EXPECTED = [
  'claude-sonnet-5','claude-opus-4-8','claude-haiku-4-5','gemini/gemini-3.5-flash','gemini/gemini-3.1-flash-lite','gpt-5.6-terra','gpt-5.6-luna',
  'claude-fable-5','claude-opus-4-7','claude-sonnet-4-6',
  'gemini/gemini-3.1-pro-preview','gemini/gemini-2.5-pro','gemini/gemini-2.5-flash',
  'gpt-5.6-sol','gpt-5.5','o3',
  'gpt-5.3-codex','gpt-5.5-pro',
];
const values = [...selBody.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
assert.strictEqual(values.length, 18, `expected 18 options, got ${values.length}`);
assert.deepStrictEqual(values.slice().sort(), EXPECTED.slice().sort(), 'dropdown value set mismatch');
for (const v of values) assert.ok(KNOWN_MODEL_IDS.has(v), `dropdown value not in KNOWN_MODEL_IDS: ${v}`);
assert.ok(EXPECTED.includes(DEFAULT_MODEL), 'DEFAULT_MODEL must be a dropdown option');
// default selected
const defOpt = selBody.match(new RegExp(`<option value="${DEFAULT_MODEL}"[^>]*selected`));
assert.ok(defOpt, `DEFAULT_MODEL (${DEFAULT_MODEL}) must be the pre-selected option`);
console.log('dropdown OK: 18 options, 5 groups,', DEFAULT_MODEL, 'selected');
