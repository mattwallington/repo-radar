const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');
const { MODEL_MIGRATIONS, KNOWN_MODEL_IDS, DEFAULT_MODEL, providerForModel } = require('../model-policy');
const root = path.join(__dirname, '..', '..');
const py = process.platform === 'win32' ? 'python' : 'python3';

// Synthetic provider fixtures — identical list on both sides.
const FIXTURES = ['anthropic/claude-x', 'openai/gpt-x', 'chatgpt/foo', 'chatgpt-4o-latest',
                  'o3', 'o4-mini', 'codex-mini-latest', 'gemini/gemini-x', 'gemini-x', 'mystery', ''];

const out = execFileSync(py, ['-c',
  "import sys,json;sys.path.insert(0,'.');from repo_radar import llm;" +
  "fx=json.loads(sys.argv[1]);" +
  "ids=sorted(set(llm.KNOWN_LIMITS)|set(llm.MODEL_MIGRATIONS)|set(fx));" +
  "print(json.dumps({'d':llm.DEFAULT_MODEL,'m':llm.MODEL_MIGRATIONS,'k':sorted(llm.KNOWN_LIMITS)," +
  "'prov':{i:llm.provider_for_model(i) for i in ids}}))",
  JSON.stringify(FIXTURES)],
  { cwd: root, encoding: 'utf8' });
const p = JSON.parse(out);

assert.strictEqual(DEFAULT_MODEL, p.d, 'DEFAULT_MODEL drift');
assert.deepStrictEqual(Object.keys(MODEL_MIGRATIONS).sort(), Object.keys(p.m).sort(), 'migration key drift');
for (const k of Object.keys(MODEL_MIGRATIONS)) assert.strictEqual(MODEL_MIGRATIONS[k], p.m[k], `migration value drift ${k}`);
assert.deepStrictEqual([...KNOWN_MODEL_IDS].sort(), p.k, 'KNOWN_MODEL_IDS drift');

// Provider parity over KNOWN ∪ MIGRATIONS ∪ synthetic fixtures.
for (const [id, pyProv] of Object.entries(p.prov)) {
  const jsProv = providerForModel(id);
  assert.strictEqual(jsProv === undefined ? null : jsProv, pyProv, `provider drift for ${JSON.stringify(id)}: js=${jsProv} py=${pyProv}`);
}
console.log('drift OK:', p.k.length, 'known,', Object.keys(p.m).length, 'migrations,', Object.keys(p.prov).length, 'provider fixtures');
