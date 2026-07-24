// Mirror of repo_radar/llm.py policy. KEEP IN SYNC (drift-check.js guards it).
const DEFAULT_MODEL = 'claude-sonnet-5';

const MODEL_MIGRATIONS = {
  // Anthropic
  'claude-3-7-sonnet-20250219': 'claude-sonnet-5',
  'claude-3-5-sonnet-20241022': 'claude-sonnet-5',
  'claude-3-5-sonnet-20240620': 'claude-sonnet-5',
  'claude-3-sonnet-20240229': 'claude-sonnet-5',
  'claude-3-5-haiku-20241022': 'claude-haiku-4-5',
  'claude-3-haiku-20240307': 'claude-haiku-4-5',
  'claude-3-opus-20240229': 'claude-opus-4-8',
  'claude-opus-4-20250514': 'claude-opus-4-8',
  'claude-4-opus-20250514': 'claude-opus-4-8',
  'claude-sonnet-4-20250514': 'claude-sonnet-5',
  'claude-4-sonnet-20250514': 'claude-sonnet-5',
  // OpenAI
  'o1-preview': 'o3',
  'o1-mini': 'o3',
  'codex-mini-latest': 'gpt-5.4-mini',
  'gpt-5-codex': 'gpt-5.3-codex',
  'gpt-5.1-codex': 'gpt-5.3-codex',
  'gpt-5.1-codex-max': 'gpt-5.3-codex',
  'gpt-5.2-codex': 'gpt-5.3-codex',
  'gpt-5.1-codex-mini': 'gpt-5.4-mini',
  // Google
  'gemini/gemini-2.0-flash': 'gemini/gemini-2.5-flash',
  'gemini/gemini-2.0-flash-001': 'gemini/gemini-2.5-flash',
  'gemini/gemini-2.0-flash-exp': 'gemini/gemini-2.5-flash',
  'gemini/gemini-2.0-flash-lite': 'gemini/gemini-2.5-flash-lite',
  'gemini/gemini-3-pro-preview': 'gemini/gemini-3.1-pro-preview',
  'gemini/gemini-3.1-flash-lite-preview': 'gemini/gemini-3.1-flash-lite',
  'gemini/gemini-1.5-pro': 'gemini/gemini-2.5-pro',
  'gemini/gemini-1.5-flash': 'gemini/gemini-2.5-flash',
};

// Exact mirror of Python KNOWN_LIMITS keys (drift-check enforces equality).
const KNOWN_MODEL_IDS = new Set([
  'claude-fable-5',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-1',
  'claude-opus-4-1-20250805',
  'claude-opus-4-5',
  'claude-opus-4-5-20251101',
  'claude-opus-4-6',
  'claude-opus-4-6-20260205',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-sonnet-4-5',
  'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-6',
  'claude-sonnet-5',
  'gemini/gemini-2.5-flash',
  'gemini/gemini-2.5-flash-lite',
  'gemini/gemini-2.5-pro',
  'gemini/gemini-3-flash-preview',
  'gemini/gemini-3.1-flash-lite',
  'gemini/gemini-3.1-pro-preview',
  'gemini/gemini-3.5-flash',
  'gemini/gemini-flash-latest',
  'gemini/gemini-flash-lite-latest',
  'gemini/gemini-pro-latest',
  'gpt-4-turbo',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-5',
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-5.1',
  'gpt-5.2',
  'gpt-5.2-pro',
  'gpt-5.3-codex',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.4-pro',
  'gpt-5.5',
  'gpt-5.5-pro',
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'o1',
  'o1-pro',
  'o3',
  'o3-mini',
  'o3-pro',
  'o4-mini',
]);

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
const MODEL_SUGGESTIONS = {
  'claude-sonnet-4-6': 'claude-sonnet-5',
  'claude-opus-4-7': 'claude-opus-4-8',
  'gemini/gemini-2.5-flash': 'gemini/gemini-3.5-flash',
  'gemini/gemini-2.5-flash-lite': 'gemini/gemini-3.1-flash-lite',
};

function suggestUpgrade(model) { return (model && MODEL_SUGGESTIONS[model]) || null; }

module.exports = { DEFAULT_MODEL, MODEL_MIGRATIONS, KNOWN_MODEL_IDS, MODEL_SUGGESTIONS, providerForModel, migrateModel, suggestUpgrade };
