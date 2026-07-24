'use strict';
const { migrateModel, suggestUpgrade, KNOWN_MODEL_IDS } = require('./model-policy');

// Compound-aware notice: migration and suggestion are NOT mutually exclusive (several retired
// ids migrate onto a suggestion key). suggestUpgrade is evaluated on the EFFECTIVE model.
function computeModelNotice(rawModel) {
  if (!rawModel) return null;
  const effective = migrateModel(rawModel);
  const migrated = effective !== rawModel;
  const suggested = suggestUpgrade(effective);
  if (migrated && suggested) return { kind: 'compound',   from: rawModel, effective, suggested };
  if (migrated)              return { kind: 'migration',  from: rawModel, effective };
  if (suggested)             return { kind: 'suggestion', from: rawModel, effective, suggested };
  return null;
}

function noticeSignature(n) {
  if (!n) return null;
  if (n.kind === 'compound')  return `compound:${n.from}>${n.effective}>${n.suggested}`;
  if (n.kind === 'migration') return `migration:${n.from}>${n.effective}`;
  return `suggestion:${n.effective}>${n.suggested}`;
}

// Build {id: label} from settings.html's ai-model dropdown (value -> visible text).
function parseModelLabels(html) {
  const map = {};
  const start = html.indexOf('id="ai-model"');
  if (start < 0) return map;
  const body = html.slice(start, html.indexOf('</select>', start));
  for (const m of body.matchAll(/<option value="([^"]+)"[^>]*>([^<]*)<\/option>/g)) {
    map[m[1]] = m[2].trim();
  }
  return map;
}

// Retired ids are not dropdown options -> fall back to the raw id string.
function humanizeModelId(id, labelMap) { return (labelMap && labelMap[id]) || id; }

function renderNoticeText(notice, labelMap) {
  const L = (id) => humanizeModelId(id, labelMap);
  if (notice.kind === 'migration') {
    return {
      title: 'A model was retired',
      body: `Your model ${L(notice.from)} was retired — you're now on ${L(notice.effective)}.`,
      buttons: [{ action: 'acknowledge', label: 'OK' }, { action: 'review', label: 'Review Models…' }],
    };
  }
  if (notice.kind === 'suggestion') {
    return {
      title: 'A newer model is available',
      body: `A newer model in your tier is available: ${L(notice.from)} → ${L(notice.suggested)}.`,
      buttons: [
        { action: 'switch', label: 'Switch' },
        { action: 'keep', label: `Keep ${L(notice.from)}` },
        { action: 'review', label: 'Review Models…' },
      ],
    };
  }
  // compound
  return {
    title: 'Your model was updated',
    body: `Your model ${L(notice.from)} was retired — you're now on ${L(notice.effective)}. ` +
          `A newer model in its tier is also available: ${L(notice.effective)} → ${L(notice.suggested)}.`,
    buttons: [
      { action: 'switch', label: `Switch to ${L(notice.suggested)}` },
      { action: 'keep', label: `Keep ${L(notice.effective)}` },
      { action: 'review', label: 'Review Models…' },
    ],
  };
}

// Per-kind allow-list + conservative 'close' mapping. Returns null for a disallowed action.
function resolveNoticeAction(action, notice) {
  const eff = notice.effective, sug = notice.suggested;
  if (notice.kind === 'migration') {
    if (action === 'acknowledge' || action === 'close') return { finalModel: eff, openSettings: false };
    if (action === 'review') return { finalModel: eff, openSettings: true };
    return null;
  }
  if (notice.kind === 'suggestion') {
    if (action === 'switch') return { finalModel: sug, openSettings: false };
    if (action === 'keep' || action === 'close') return { finalModel: null, openSettings: false };
    if (action === 'review') return { finalModel: null, openSettings: true };
    return null;
  }
  if (notice.kind === 'compound') {
    if (action === 'switch') return { finalModel: sug, openSettings: false };
    if (action === 'keep' || action === 'close') return { finalModel: eff, openSettings: false };
    if (action === 'review') return { finalModel: eff, openSettings: true };
    return null;
  }
  return null;
}

// Pure finalize plan. `expectedSig` is the signature the window displayed (staleness guard).
function planFinalize(action, diskConfig, expectedSig) {
  const cur = computeModelNotice(diskConfig.ai_model);
  if (!cur || noticeSignature(cur) !== expectedSig) return { staleOrGone: true, valid: false };
  const resolved = resolveNoticeAction(action, cur);
  if (!resolved) return { staleOrGone: false, valid: false };
  if (resolved.finalModel && !KNOWN_MODEL_IDS.has(resolved.finalModel)) return { staleOrGone: false, valid: false, invalidTarget: true };
  const original = diskConfig.ai_model;
  const nextConfig = { ...diskConfig };
  if (resolved.finalModel) nextConfig.ai_model = resolved.finalModel;
  nextConfig.model_notice_ack = noticeSignature(computeModelNotice(nextConfig.ai_model)) || '';
  return { staleOrGone: false, valid: true, nextConfig, reconcileSchedule: nextConfig.ai_model !== original, openSettings: resolved.openSettings };
}

// Save first; stop on save failure; reconcile the schedule ONLY after a successful save.
function persistConfig(config, { reconcileSchedule, save, reconcile }) {
  const saved = save(config);
  if (!saved || saved.success === false) return { ok: false, stage: 'save', error: saved && saved.error };
  if (!reconcileSchedule) return { ok: true, schedule: { ok: true, skipped: true } };
  const s = reconcile(config);
  return { ok: true, schedule: { ok: !(!s || s.success === false), error: s && s.error } };
}

module.exports = { computeModelNotice, noticeSignature, parseModelLabels, humanizeModelId, renderNoticeText, resolveNoticeAction, planFinalize, persistConfig };
