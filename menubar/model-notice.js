'use strict';
const { migrateModel, suggestUpgrade } = require('./model-policy');

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

module.exports = { computeModelNotice, noticeSignature, parseModelLabels, humanizeModelId, renderNoticeText };
