const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { MODEL_MIGRATIONS, KNOWN_MODEL_IDS, DEFAULT_MODEL, providerForModel, MODEL_SUGGESTIONS } = require('../model-policy');
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

// Parse the selectable ai-model dropdown values from settings.html.
const _html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'settings.html'), 'utf8');
const _sel = _html.slice(_html.indexOf('id="ai-model"'));
const _selBody = _sel.slice(0, _sel.indexOf('</select>'));
const DROPDOWN = new Set([..._selBody.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]));

for (const [from, to] of Object.entries(MODEL_SUGGESTIONS)) {
  assert.ok(KNOWN_MODEL_IDS.has(from), `suggestion key not in KNOWN_MODEL_IDS: ${from}`);
  assert.ok(KNOWN_MODEL_IDS.has(to), `suggestion target not in KNOWN_MODEL_IDS: ${to}`);
  assert.ok(DROPDOWN.has(to), `suggestion target not a settings.html dropdown option: ${to}`);
  assert.ok(!to.endsWith('-preview'), `suggestion target must be GA (not preview): ${to}`);
  assert.ok(!(to in MODEL_MIGRATIONS), `suggestion target must be current (not a migration key): ${to}`);
  assert.strictEqual(providerForModel(from), providerForModel(to), `suggestion crosses provider: ${from} -> ${to}`);
  assert.notStrictEqual(from, to, `suggestion is a self-map: ${from}`);
}
console.log('MODEL_SUGGESTIONS invariants OK:', Object.keys(MODEL_SUGGESTIONS).length, 'rows');

// ── run-receipt protocol parity across the language boundary ─────────────────────────────
// The receipt is a contract between Python (writer) and Electron (reader), so its constants and
// its qualification rule exist in both languages. This review cycle showed repeatedly that
// independent per-language tests are not enough: the qualification rule agreed in JS and
// disagreed in Python, and each suite passed. Compare them directly.
{
  const rr = require('../run-receipt');
  const pyOut = execFileSync(py, ['-c',
    "import sys,json;sys.path.insert(0,'.');from repo_radar import receipts as r;" +
    "combos=[(c,m) for c in r.VALID_CHANNELS for m in r.VALID_MODES];" +
    "print(json.dumps({'schema':r.RECEIPT_SCHEMA,'exit':r.EXIT_SKIPPED_NO_WORK," +
    "'sched':r.SCHEDULING_CHANNEL,'triggers':sorted(r.VALID_TRIGGERS)," +
    "'channels':sorted(r.VALID_CHANNELS),'modes':sorted(r.VALID_MODES)," +
    "'table':{f'{c}|{m}': r.qualifies_for_schedule(c,m) for c,m in combos}}))"],
    { cwd: root, encoding: 'utf8' });
  const pr = JSON.parse(pyOut);

  assert.strictEqual(rr.SCHEMA, pr.schema, 'receipt SCHEMA drift');
  assert.strictEqual(rr.EXIT_SKIPPED_NO_WORK, pr.exit, 'EXIT_SKIPPED_NO_WORK drift');
  assert.strictEqual(rr.SCHEDULING_CHANNEL, pr.sched, 'SCHEDULING_CHANNEL drift');
  assert.deepStrictEqual([...rr.VALID_TRIGGERS].sort(), pr.triggers, 'VALID_TRIGGERS drift');
  assert.deepStrictEqual([...rr.VALID_CHANNELS].sort(), pr.channels, 'VALID_CHANNELS drift');
  assert.deepStrictEqual([...rr.VALID_MODES].sort(), pr.modes, 'VALID_MODES drift');

  // The truth table, every channel x mode. This is the assertion that would have caught Python
  // persisting qualifiesForSchedule=true for a full DEV run while JS derived false.
  let compared = 0;
  for (const [key, pyValue] of Object.entries(pr.table)) {
    const [channel, mode] = key.split('|');
    const jsValue = rr.qualifiesForSchedule({ channel, mode, trigger: 'scheduled' });
    assert.strictEqual(jsValue, pyValue,
      `qualification drift for ${channel}/${mode}: js=${jsValue} py=${pyValue}`);
    compared += 1;
  }
  assert.strictEqual(compared, pr.channels.length * pr.modes.length,
    'every channel x mode combination must be compared');

  // Stats key names cross the language boundary too, and this one has a spelling trap: Python's
  // in-process stats dict uses snake_case (index_dropped) while the receipt it writes uses
  // camelCase (indexDropped). JS reads the first off the live status-server payload and the
  // second off the receipt. Assert against a receipt Python ACTUALLY WROTE rather than a
  // hand-built fixture, so a rename on either side fails here instead of silently reading
  // undefined and reporting an incomplete index as a clean sync.
  const written = JSON.parse(execFileSync(py, ['-c',
    "import sys,json,tempfile,pathlib;sys.path.insert(0,'.');" +
    "from repo_radar import receipts as r;" +
    "d=pathlib.Path(tempfile.mkdtemp());" +
    "p=r.write_receipt(d,trigger='scheduled',started_at='2026-07-30T00:00:00+00:00'," +
    "stats={'total':1,'errors':0,'index_dropped':2},channel='stable',mode='full');" +
    "print(p.read_text())"], { cwd: root, encoding: 'utf8' }));
  assert.strictEqual(written.stats.indexDropped, 2,
    'Python must write stats.indexDropped (camelCase) — JS reads exactly this key');
  assert.strictEqual(rr.indexDroppedOf(written), 2, 'JS must read the count Python wrote');
  assert.strictEqual(written.errorFree, false,
    'an incomplete index must make the run not error-free, even with zero per-repo errors');
  assert.strictEqual(rr.runSucceeded(written), false, 'JS must agree the run did not succeed');
  assert.strictEqual(written.completed, true,
    'the run still COMPLETED — marking it otherwise would trigger a redundant paid catch-up');
  assert.ok(rr.validateReceipt(written), 'a real Python receipt must pass JS validation');

  console.log(`run-receipt parity OK: ${compared} qualification combos, ${pr.triggers.length} triggers,`
    + ` schema ${pr.schema}, exit ${pr.exit}, indexDropped round-trip verified`);
}
