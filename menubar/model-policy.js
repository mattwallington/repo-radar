// Mirror of repo_radar/llm.py policy. KEEP IN SYNC (drift-check.js guards it).
const DEFAULT_MODEL = 'claude-sonnet-5-5';

// Families and tiers, newest member first. A retired id migrates directly to the newest member of
// its own tier that is still known; see MODEL_TIERS in repo_radar/llm.py for the rule.
const MODEL_TIERS = {
  'claude-sonnet': [
    'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5',
    'claude-sonnet-4-5-20250929', 'claude-sonnet-4-20250514', 'claude-4-sonnet-20250514',
    'claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022', 'claude-3-5-sonnet-20240620',
    'claude-3-sonnet-20240229',
  ],
  'claude-opus': [
    'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6',
    'claude-opus-4-6-20260205', 'claude-opus-4-5', 'claude-opus-4-5-20251101', 'claude-opus-4-1',
    'claude-opus-4-1-20250805', 'claude-opus-4-20250514', 'claude-4-opus-20250514',
    'claude-3-opus-20240229',
  ],
  'claude-haiku': [
    'claude-haiku-5-5', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001',
    'claude-3-5-haiku-20241022', 'claude-3-haiku-20240307',
  ],
  'claude-fable': [
    'claude-fable-5-1', 'claude-fable-5',
  ],
  'openai-sol': [
    'gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4', 'gpt-5.2', 'gpt-5.1', 'gpt-5',
    'gpt-4.1', 'gpt-4o', 'o3', 'o1', 'o1-preview',
  ],
  'openai-astra': [
    'gpt-6-astra',
  ],
  'openai-terra': [
    'gpt-6.1-terra', 'gpt-5.6-terra', 'gpt-5.4-mini', 'gpt-5-mini', 'gpt-4.1-mini', 'gpt-4o-mini',
    'o4-mini', 'o3-mini', 'o1-mini', 'gpt-5.1-codex-mini', 'codex-mini-latest',
  ],
  'openai-luna': [
    'gpt-6-luna', 'gpt-5.6-luna', 'gpt-5.4-nano', 'gpt-5-nano', 'gpt-4.1-nano',
  ],
  'openai-pro': [
    'gpt-5.5-pro', 'gpt-5.4-pro', 'gpt-5.2-pro', 'o3-pro', 'o1-pro',
  ],
  'openai-codex': [
    'gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex', 'gpt-5-codex',
  ],
  'gemini-flash': [
    'gemini/gemini-3.8-flash', 'gemini/gemini-3.6-flash', 'gemini/gemini-3.5-flash',
    'gemini/gemini-3-flash-preview', 'gemini/gemini-2.5-flash', 'gemini/gemini-2.0-flash',
    'gemini/gemini-2.0-flash-001', 'gemini/gemini-2.0-flash-exp', 'gemini/gemini-1.5-flash',
  ],
  'gemini-flash-lite': [
    'gemini/gemini-3.5-flash-lite', 'gemini/gemini-3.1-flash-lite',
    'gemini/gemini-3.1-flash-lite-preview', 'gemini/gemini-2.5-flash-lite',
    'gemini/gemini-2.0-flash-lite',
  ],
  'gemini-pro': [
    'gemini/gemini-3.1-pro-preview', 'gemini/gemini-3-pro-preview', 'gemini/gemini-2.5-pro',
    'gemini/gemini-1.5-pro',
  ],
  'gemini-argon': [
    'gemini/gemini-4-argon',
  ],
};

// Floating aliases point at whatever the vendor currently serves, so they are not tier members.
const FLOATING_ALIASES = new Set(['gemini/gemini-flash-latest', 'gemini/gemini-flash-lite-latest', 'gemini/gemini-pro-latest']);

// Exact mirror of Python model_catalog.MODEL_CAPS (max_input, max_output only; drift-check
// enforces equality). KNOWN_MODEL_IDS is derived from this, so a model can never be "known" here
// without also carrying its window values.
const MODEL_CAPS = {
  'claude-fable-5': { max_input: 1000000, max_output: 128000 },
  'claude-fable-5-1': { max_input: 1000000, max_output: 128000 },
  'claude-haiku-4-5': { max_input: 200000, max_output: 64000 },
  'claude-haiku-4-5-20251001': { max_input: 200000, max_output: 64000 },
  'claude-haiku-5-5': { max_input: 1000000, max_output: 128000 },
  'claude-opus-4-5': { max_input: 200000, max_output: 64000 },
  'claude-opus-4-5-20251101': { max_input: 200000, max_output: 64000 },
  'claude-opus-4-6': { max_input: 1000000, max_output: 128000 },
  'claude-opus-4-7': { max_input: 1000000, max_output: 128000 },
  'claude-opus-4-8': { max_input: 1000000, max_output: 128000 },
  'claude-opus-5': { max_input: 1000000, max_output: 128000 },
  'claude-opus-5-5': { max_input: 1000000, max_output: 128000 },
  'claude-sonnet-4-5': { max_input: 200000, max_output: 64000 },
  'claude-sonnet-4-5-20250929': { max_input: 200000, max_output: 64000 },
  'claude-sonnet-4-6': { max_input: 1000000, max_output: 128000 },
  'claude-sonnet-5': { max_input: 1000000, max_output: 128000 },
  'claude-sonnet-5-5': { max_input: 1000000, max_output: 128000 },
  'gemini/gemini-2.5-flash': { max_input: 1048576, max_output: 65536 },
  'gemini/gemini-2.5-flash-lite': { max_input: 1048576, max_output: 65536 },
  'gemini/gemini-2.5-pro': { max_input: 1048576, max_output: 65536 },
  'gemini/gemini-3-flash-preview': { max_input: 1048576, max_output: 65536 },
  'gemini/gemini-3.1-flash-lite': { max_input: 1048576, max_output: 65536 },
  'gemini/gemini-3.1-pro-preview': { max_input: 1048576, max_output: 65536 },
  'gemini/gemini-3.5-flash': { max_input: 1048576, max_output: 65536 },
  'gemini/gemini-3.5-flash-lite': { max_input: 1048576, max_output: 65536 },
  'gemini/gemini-3.6-flash': { max_input: 1048576, max_output: 65536 },
  'gemini/gemini-3.8-flash': { max_input: 1048576, max_output: 65536 },
  'gemini/gemini-4-argon': { max_input: 1048576, max_output: 65536 },
  'gemini/gemini-flash-latest': { max_input: 1048576, max_output: 65536 },
  'gemini/gemini-flash-lite-latest': { max_input: 1048576, max_output: 65536 },
  'gemini/gemini-pro-latest': { max_input: 1048576, max_output: 65536 },
  'gpt-4.1': { max_input: 1047576, max_output: 32768 },
  'gpt-4.1-mini': { max_input: 1047576, max_output: 32768 },
  'gpt-4o': { max_input: 128000, max_output: 16384 },
  'gpt-4o-mini': { max_input: 128000, max_output: 16384 },
  'gpt-5': { max_input: 272000, max_output: 128000 },
  'gpt-5-mini': { max_input: 272000, max_output: 128000 },
  'gpt-5-nano': { max_input: 272000, max_output: 128000 },
  'gpt-5.1': { max_input: 272000, max_output: 128000 },
  'gpt-5.2': { max_input: 272000, max_output: 128000 },
  'gpt-5.2-pro': { max_input: 272000, max_output: 128000 },
  'gpt-5.3-codex': { max_input: 272000, max_output: 128000 },
  'gpt-5.4': { max_input: 1050000, max_output: 128000 },
  'gpt-5.4-mini': { max_input: 272000, max_output: 128000 },
  'gpt-5.4-nano': { max_input: 272000, max_output: 128000 },
  'gpt-5.4-pro': { max_input: 1050000, max_output: 128000 },
  'gpt-5.5': { max_input: 1050000, max_output: 128000 },
  'gpt-5.5-pro': { max_input: 1050000, max_output: 128000 },
  'gpt-5.6-luna': { max_input: 922000, max_output: 128000 },
  'gpt-5.6-sol': { max_input: 922000, max_output: 128000 },
  'gpt-5.6-terra': { max_input: 922000, max_output: 128000 },
  'gpt-6-astra': { max_input: 922000, max_output: 128000 },
  'gpt-6-luna': { max_input: 922000, max_output: 128000 },
  'gpt-6-sol': { max_input: 922000, max_output: 128000 },
  'gpt-6.1-sol': { max_input: 922000, max_output: 128000 },
  'gpt-6.1-terra': { max_input: 922000, max_output: 128000 },
  'o3': { max_input: 200000, max_output: 100000 },
  'o3-pro': { max_input: 200000, max_output: 100000 },
};

const KNOWN_MODEL_IDS = new Set(Object.keys(MODEL_CAPS));

function newestInTier(tier) { return MODEL_TIERS[tier].find((m) => KNOWN_MODEL_IDS.has(m)) || null; }

function deriveMigrations(tiers, known) {
  const out = {};
  for (const members of Object.values(tiers)) {
    const target = members.find((m) => known.has(m));
    if (!target) continue;
    for (const m of members) if (!known.has(m)) out[m] = target;
  }
  return out;
}

const MODEL_MIGRATIONS = deriveMigrations(MODEL_TIERS, KNOWN_MODEL_IDS);

function providerForModel(model) {
  if (!model) return null;
  if (model.startsWith('gemini/') || model.startsWith('gemini-')) return 'gemini';
  if (model.startsWith('claude') || model.startsWith('anthropic/')) return 'anthropic';
  if (model.startsWith('gpt') || model.startsWith('openai/') || model.startsWith('chatgpt/')
      || model.startsWith('chatgpt-') || model.startsWith('codex') || /^o\d/.test(model)) return 'openai';
  return null;
}

function migrateModel(model) { return (model && MODEL_MIGRATIONS[model]) || model; }

// Same-tier, newer-generation upgrade suggestions for the post-upgrade notice. UI policy only,
// JS-only (no Python consumer). Invariants enforced by menubar/__tests__/drift-check.js.
// Targets are always the CURRENT best in tier, never an intermediate generation — otherwise a
// user two generations back gets walked forward one notice per launch (4.7 -> 4.8, then 4.8 -> 5).
const MODEL_SUGGESTIONS = {
  'claude-sonnet-5': 'claude-sonnet-5-5',
  'claude-sonnet-4-6': 'claude-sonnet-5-5',
  'claude-opus-5': 'claude-opus-5-5',
  'claude-opus-4-8': 'claude-opus-5-5',
  'claude-opus-4-7': 'claude-opus-5-5',
  'claude-haiku-4-5': 'claude-haiku-5-5',
  'claude-fable-5': 'claude-fable-5-1',
  'gemini/gemini-3.6-flash': 'gemini/gemini-3.8-flash',
  'gemini/gemini-3.5-flash': 'gemini/gemini-3.8-flash',
  'gemini/gemini-2.5-flash': 'gemini/gemini-3.8-flash',
  'gemini/gemini-3.1-flash-lite': 'gemini/gemini-3.5-flash-lite',
  'gemini/gemini-2.5-flash-lite': 'gemini/gemini-3.5-flash-lite',
  'gpt-5.6-sol': 'gpt-6.1-sol',
  'gpt-5.6-terra': 'gpt-6.1-terra',
  'gpt-5.6-luna': 'gpt-6-luna',
  // Models with an announced shutdown, offered their tier's newest model ahead of it.
  'claude-sonnet-4-5': 'claude-sonnet-5-5',
  'claude-sonnet-4-5-20250929': 'claude-sonnet-5-5',
  'gpt-5': 'gpt-6.1-sol',
  'gpt-5.1': 'gpt-6.1-sol',
  'gpt-4.1': 'gpt-6.1-sol',
  'gpt-4o': 'gpt-6.1-sol',
  'o3': 'gpt-6.1-sol',
  'gpt-5-mini': 'gpt-6.1-terra',
  'gpt-4.1-mini': 'gpt-6.1-terra',
  'gpt-4o-mini': 'gpt-6.1-terra',
  'gpt-5-nano': 'gpt-6-luna',
  'gpt-5.4-nano': 'gpt-6-luna',
  'o3-pro': 'gpt-5.5-pro',
  'gemini/gemini-3-flash-preview': 'gemini/gemini-3.8-flash',
  // gpt-5.3-codex has none: it is already the newest of its tier, and a suggestion never crosses tiers.
};

function suggestUpgrade(model) { return (model && MODEL_SUGGESTIONS[model]) || null; }

module.exports = {
  DEFAULT_MODEL, MODEL_TIERS, FLOATING_ALIASES, MODEL_MIGRATIONS, MODEL_CAPS, KNOWN_MODEL_IDS, MODEL_SUGGESTIONS,
  providerForModel, migrateModel, suggestUpgrade, newestInTier, deriveMigrations,
};
