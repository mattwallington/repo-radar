# Post-Upgrade Model-Update Notice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After an upgrade, a stable build shows a one-time, actionable-only modal telling a user their saved model was retired (and durably heals it) and/or that a same-tier newer model exists (one-click switch), without ever auto-changing a deliberate live choice.

**Architecture:** All decision logic is pure and lives in `menubar/model-notice.js` (+ a suggestion map in `menubar/model-policy.js`); `menubar/main.js` is thin wiring (a stable-only startup trigger, a hardened modal window with a restricted preload, and a single main-owned idempotent finalizer). The renderer sends only an *action*; main recomputes and validates every model id and owns persistence. Model writes go through one `persistConfig` primitive (save first, reconcile the LaunchAgent only after a successful save) shared with Settings.

**Tech Stack:** Electron (main + renderer), Node's built-in `node:test` and plain `assert` scripts (existing `menubar/__tests__/` conventions), CommonJS modules.

## Global Constraints

- `DEFAULT_MODEL = 'claude-sonnet-5'`; do not hardcode any other default. New/never-configured users get the default and see no notice.
- **Stable builds only.** Every notice path is a no-op unless `runtimeChannel === 'stable'`. Dev never reads or writes `model_notice_ack`.
- **Renderer sends only an action string** (`switch`|`keep`|`acknowledge`|`review`); it never supplies a model id. The main process recomputes and validates the target.
- **Acknowledgement = post-action signature:** `noticeSignature(computeModelNotice(resultingModel))`, distinct from the displayed signature used to gate/detect staleness.
- **`persistConfig` contract:** save first; on save failure return `{ok:false}` and DO NOT reconcile; reconcile the LaunchAgent only after a successful save; ack-only actions pass `reconcileSchedule:false`.
- **Finalization is main-owned + idempotent** (`_noticeFinalized`); the BrowserWindow `close` handler `preventDefault`s and finalizes, destroying only after persistence succeeds. `appIsQuitting` (set in `before-quit`) short-circuits it so a save failure can never trap `app.quit()`.
- **`MODEL_SUGGESTIONS`** is JS-only (no Python mirror), exactly the four normative rows below. Invariants: keys+values ∈ `KNOWN_MODEL_IDS`; every value is a selectable `settings.html` dropdown option; every value is GA (no `-preview`); no value is a `MODEL_MIGRATIONS` key; `providerForModel(key) === providerForModel(value)`; no self-map.
- **No Python changes.** `repo_radar/llm.py` is untouched.
- A model-write failure surfaces `dialog.showErrorBox` (NOT `surfaceRuntimeError`, which disables the runtime).

**Spec:** `docs/superpowers/specs/2026-07-23-model-update-notice-design.md` (rev 4, commit `2981472`).

---

## File Structure

- `menubar/model-policy.js` — **modify**: add `MODEL_SUGGESTIONS` + `suggestUpgrade`; export both.
- `menubar/model-notice.js` — **create**: pure logic — `computeModelNotice`, `noticeSignature`, `resolveNoticeAction`, `planFinalize`, `persistConfig`, `parseModelLabels`, `humanizeModelId`, `renderNoticeText`.
- `menubar/__tests__/model-policy.test.js` — **modify**: assert the four suggestion rows.
- `menubar/__tests__/drift-check.js` — **modify**: `MODEL_SUGGESTIONS` invariants (incl. dropdown membership + provider parity).
- `menubar/__tests__/model-notice.test.js` — **create**: full matrix for the pure logic.
- `menubar/renderer/model-update.html`, `menubar/renderer/model-update.js`, `menubar/renderer/model-update-preload.js` — **create**: thin display window.
- `menubar/main.js` — **modify**: `maybeShowModelNotice`, `finalizeModelNotice`, window creation, IPC (sender-bound), `before-quit`, and refactor `save-config` onto `persistConfig`.
- `menubar/__tests__/model-notice-wiring.test.js` — **create**: static assertions over `main.js` wiring.

---

## Task 0: Execution gate (do this before any code)

**Files:** none (branch hygiene + verification).

This branch (`feature/model-update-notice-v1.0.27`) was cut from the canonical `menubar/` structure that only reaches `dev` when Spec 2A merges. Do not start Task 1 until this gate passes.

- [ ] **Step 1: Confirm Spec 2A merged to `dev`**

Run: `git -C ~/.claude-worktrees/repo-radar-model-notice fetch origin && git log --oneline origin/dev | grep -i "runtime.binding\|spec 2a\|runtime-binding" | head`
Expected: at least one commit line for the Spec 2A runtime-binding merge. If empty, STOP — the gate is not met.

- [ ] **Step 2: Rebase the notice branch onto fresh `dev`**

Run:
```bash
cd ~/.claude-worktrees/repo-radar-model-notice
git rebase origin/dev
```
Expected: rebase completes clean (only the four spec-doc commits `851d055..2981472` replay). Resolve any doc conflict by keeping the spec.

- [ ] **Step 3: Revalidate referenced functions + tests still exist with the referenced shapes**

Run:
```bash
cd ~/.claude-worktrees/repo-radar-model-notice
grep -nE "function saveConfigToFile|function updateLaunchAgent|surfaceScheduleWarning|resolveChannel|let runtimeChannel|dialog\.showErrorBox" menubar/main.js
grep -nE "DEFAULT_MODEL|MODEL_MIGRATIONS|KNOWN_MODEL_IDS|providerForModel|migrateModel" menubar/model-policy.js
node menubar/__tests__/model-policy.test.js && node menubar/__tests__/dropdown.test.js && node menubar/__tests__/drift-check.js
```
Expected: all greps hit; `saveConfigToFile`/`updateLaunchAgent` still return `{success, error}`; the three baseline tests print their `OK` lines. If a signature changed during Spec 2A review, note it and adjust the affected task's code before proceeding.

- [ ] **Step 4: Proceed to Task 1** (no commit for this task).

---

## Task 1: `MODEL_SUGGESTIONS` + `suggestUpgrade`

**Files:**
- Modify: `menubar/model-policy.js`
- Test: `menubar/__tests__/model-policy.test.js`

**Interfaces:**
- Consumes: `KNOWN_MODEL_IDS`, `MODEL_MIGRATIONS`, `providerForModel` (existing exports).
- Produces: `MODEL_SUGGESTIONS` (object), `suggestUpgrade(model) -> string|null`.

- [ ] **Step 1: Write the failing test** — append to `menubar/__tests__/model-policy.test.js` (plain `assert`, before the final `console.log`):

```js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node menubar/__tests__/model-policy.test.js`
Expected: throws `TypeError` / `AssertionError` (MODEL_SUGGESTIONS undefined).

- [ ] **Step 3: Implement** — in `menubar/model-policy.js`, add before `module.exports`:

```js
// Same-tier, newer-generation upgrade suggestions for the post-upgrade notice. UI policy only,
// JS-only (no Python consumer). Invariants enforced by menubar/__tests__/drift-check.js.
const MODEL_SUGGESTIONS = {
  'claude-sonnet-4-6': 'claude-sonnet-5',
  'claude-opus-4-7': 'claude-opus-4-8',
  'gemini/gemini-2.5-flash': 'gemini/gemini-3.5-flash',
  'gemini/gemini-2.5-flash-lite': 'gemini/gemini-3.1-flash-lite',
};

function suggestUpgrade(model) { return (model && MODEL_SUGGESTIONS[model]) || null; }
```

Then extend the exports line to include them:

```js
module.exports = { DEFAULT_MODEL, MODEL_MIGRATIONS, KNOWN_MODEL_IDS, MODEL_SUGGESTIONS, providerForModel, migrateModel, suggestUpgrade };
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node menubar/__tests__/model-policy.test.js`
Expected: prints `model-policy OK: ...`.

- [ ] **Step 5: Commit**

```bash
git add menubar/model-policy.js menubar/__tests__/model-policy.test.js
git commit -m "feat(model-notice): add MODEL_SUGGESTIONS + suggestUpgrade"
```

---

## Task 2: Suggestion-map invariants in drift-check

**Files:**
- Modify: `menubar/__tests__/drift-check.js`

**Interfaces:**
- Consumes: `MODEL_SUGGESTIONS`, `KNOWN_MODEL_IDS`, `MODEL_MIGRATIONS`, `providerForModel` from `../model-policy`; the `settings.html` dropdown values.
- Produces: nothing (a guard test).

- [ ] **Step 1: Write the failing invariants** — append to `menubar/__tests__/drift-check.js` (after the existing provider-parity loop, before any final log). Add `MODEL_SUGGESTIONS` to the require at the top and `fs` if not present:

```js
const fs = require('fs');
const { MODEL_SUGGESTIONS } = require('../model-policy');

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
```

- [ ] **Step 2: Run to verify it passes** (the four normative rows already comply, so this is a green guard)

Run: `node menubar/__tests__/drift-check.js`
Expected: prints the existing drift output plus `MODEL_SUGGESTIONS invariants OK: 4 rows`.

- [ ] **Step 3: Prove the guard bites** — temporarily add a bad row to `MODEL_SUGGESTIONS` in `menubar/model-policy.js`, e.g. `'claude-sonnet-4-6': 'gemini/gemini-3.5-flash'`, run `node menubar/__tests__/drift-check.js`, confirm it throws `suggestion crosses provider`, then revert the bad row.

- [ ] **Step 4: Commit**

```bash
git add menubar/__tests__/drift-check.js
git commit -m "test(model-notice): assert MODEL_SUGGESTIONS invariants (dropdown, GA, provider parity)"
```

---

## Task 3: `model-notice.js` — notice computation + display

**Files:**
- Create: `menubar/model-notice.js`
- Test: `menubar/__tests__/model-notice.test.js`

**Interfaces:**
- Consumes: `migrateModel`, `suggestUpgrade` from `./model-policy`.
- Produces:
  - `computeModelNotice(rawModel) -> null | {kind:'migration', from, effective} | {kind:'suggestion', from, effective, suggested} | {kind:'compound', from, effective, suggested}`
  - `noticeSignature(notice) -> string|null`
  - `parseModelLabels(html) -> { [id]: label }`
  - `humanizeModelId(id, labelMap) -> string`
  - `renderNoticeText(notice, labelMap) -> { title, body, buttons: Array<{action, label}> }`

- [ ] **Step 1: Write the failing test** — create `menubar/__tests__/model-notice.test.js`:

```js
const test = require('node:test'); const assert = require('node:assert');
const { computeModelNotice, noticeSignature, parseModelLabels, humanizeModelId, renderNoticeText } = require('../model-notice');

test('computeModelNotice: null saved model -> null', () => {
  assert.strictEqual(computeModelNotice(null), null);
  assert.strictEqual(computeModelNotice(''), null);
});
test('computeModelNotice: live model, no suggestion -> null', () => {
  assert.strictEqual(computeModelNotice('claude-sonnet-5'), null);
});
test('computeModelNotice: live model with suggestion -> suggestion', () => {
  assert.deepStrictEqual(computeModelNotice('claude-sonnet-4-6'),
    { kind: 'suggestion', from: 'claude-sonnet-4-6', effective: 'claude-sonnet-4-6', suggested: 'claude-sonnet-5' });
});
test('computeModelNotice: retired model, clean target -> migration', () => {
  assert.deepStrictEqual(computeModelNotice('claude-3-5-sonnet-20241022'),
    { kind: 'migration', from: 'claude-3-5-sonnet-20241022', effective: 'claude-sonnet-5' });
});
test('computeModelNotice: retired model whose target has a suggestion -> compound', () => {
  assert.deepStrictEqual(computeModelNotice('gemini/gemini-2.0-flash'),
    { kind: 'compound', from: 'gemini/gemini-2.0-flash', effective: 'gemini/gemini-2.5-flash', suggested: 'gemini/gemini-3.5-flash' });
});
test('noticeSignature: distinct per kind and content', () => {
  assert.strictEqual(noticeSignature(null), null);
  assert.strictEqual(noticeSignature(computeModelNotice('claude-sonnet-4-6')), 'suggestion:claude-sonnet-4-6>claude-sonnet-5');
  assert.strictEqual(noticeSignature(computeModelNotice('claude-3-5-sonnet-20241022')), 'migration:claude-3-5-sonnet-20241022>claude-sonnet-5');
  assert.strictEqual(noticeSignature(computeModelNotice('gemini/gemini-2.0-flash')), 'compound:gemini/gemini-2.0-flash>gemini/gemini-2.5-flash>gemini/gemini-3.5-flash');
});
test('parseModelLabels + humanizeModelId: dropdown label, fallback to raw id', () => {
  const map = parseModelLabels('<select id="ai-model"><option value="claude-sonnet-5">Claude Sonnet 5</option></select>');
  assert.strictEqual(humanizeModelId('claude-sonnet-5', map), 'Claude Sonnet 5');
  assert.strictEqual(humanizeModelId('claude-3-5-sonnet-20241022', map), 'claude-3-5-sonnet-20241022'); // retired, not in map
});
test('renderNoticeText: compound buttons + humanized labels', () => {
  const map = { 'gemini/gemini-2.5-flash': 'Gemini 2.5 Flash', 'gemini/gemini-3.5-flash': 'Gemini 3.5 Flash' };
  const v = renderNoticeText(computeModelNotice('gemini/gemini-2.0-flash'), map);
  assert.deepStrictEqual(v.buttons.map(b => b.action), ['switch', 'keep', 'review']);
  assert.match(v.body, /Gemini 2\.5 Flash/);
  assert.match(v.body, /Gemini 3\.5 Flash/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test menubar/__tests__/model-notice.test.js`
Expected: FAIL — cannot find module `../model-notice`.

- [ ] **Step 3: Implement** — create `menubar/model-notice.js`:

```js
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test menubar/__tests__/model-notice.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add menubar/model-notice.js menubar/__tests__/model-notice.test.js
git commit -m "feat(model-notice): compute-notice + signature + display rendering (pure)"
```

---

## Task 4: `model-notice.js` — action resolution, finalize plan, persist primitive

**Files:**
- Modify: `menubar/model-notice.js`
- Test: `menubar/__tests__/model-notice.test.js`

**Interfaces:**
- Consumes: `KNOWN_MODEL_IDS` from `./model-policy`; `computeModelNotice`, `noticeSignature` (Task 3).
- Produces:
  - `resolveNoticeAction(action, notice) -> null | { finalModel: string|null, openSettings: boolean }`
  - `planFinalize(action, diskConfig, expectedSig) -> { staleOrGone, valid, nextConfig?, reconcileSchedule?, openSettings?, invalidTarget? }`
  - `persistConfig(config, { reconcileSchedule, save, reconcile }) -> { ok, stage?, error?, schedule?: {ok, error, skipped} }`

- [ ] **Step 1: Write the failing test** — append to `menubar/__tests__/model-notice.test.js`:

```js
const { resolveNoticeAction, planFinalize, persistConfig } = require('../model-notice');

test('resolveNoticeAction: per-kind allow-list + close mapping + disallowed', () => {
  const sug = computeModelNotice('claude-sonnet-4-6');
  assert.deepStrictEqual(resolveNoticeAction('switch', sug), { finalModel: 'claude-sonnet-5', openSettings: false });
  assert.deepStrictEqual(resolveNoticeAction('keep', sug), { finalModel: null, openSettings: false });
  assert.deepStrictEqual(resolveNoticeAction('close', sug), { finalModel: null, openSettings: false });
  assert.deepStrictEqual(resolveNoticeAction('review', sug), { finalModel: null, openSettings: true });
  assert.strictEqual(resolveNoticeAction('acknowledge', sug), null, 'acknowledge not valid for suggestion');

  const mig = computeModelNotice('claude-3-5-sonnet-20241022');
  assert.deepStrictEqual(resolveNoticeAction('acknowledge', mig), { finalModel: 'claude-sonnet-5', openSettings: false });
  assert.deepStrictEqual(resolveNoticeAction('close', mig), { finalModel: 'claude-sonnet-5', openSettings: false });
  assert.strictEqual(resolveNoticeAction('switch', mig), null, 'switch not valid for migration');

  const cmp = computeModelNotice('gemini/gemini-2.0-flash');
  assert.deepStrictEqual(resolveNoticeAction('keep', cmp), { finalModel: 'gemini/gemini-2.5-flash', openSettings: false });
  assert.deepStrictEqual(resolveNoticeAction('switch', cmp), { finalModel: 'gemini/gemini-3.5-flash', openSettings: false });
});

test('planFinalize: stale when displayed signature no longer matches disk', () => {
  const cfg = { ai_model: 'claude-sonnet-4-6' };
  const r = planFinalize('switch', cfg, 'suggestion:SOMETHING>ELSE');
  assert.strictEqual(r.staleOrGone, true);
  assert.strictEqual(r.valid, false);
});

test('planFinalize: compound Keep persists effective + acks the resulting suggestion (no re-prompt)', () => {
  const cfg = { ai_model: 'gemini/gemini-2.0-flash', repositories: [1, 2] };
  const sig = noticeSignature(computeModelNotice(cfg.ai_model));
  const r = planFinalize('keep', cfg, sig);
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.nextConfig.ai_model, 'gemini/gemini-2.5-flash');
  assert.strictEqual(r.nextConfig.model_notice_ack, 'suggestion:gemini/gemini-2.5-flash>gemini/gemini-3.5-flash');
  assert.strictEqual(r.reconcileSchedule, true, 'model changed retired->effective');
  assert.deepStrictEqual(r.nextConfig.repositories, [1, 2], 'preserves full config');
  // next launch with the resulting config must NOT re-prompt (ack matches its own notice)
  const next = computeModelNotice(r.nextConfig.ai_model);
  assert.strictEqual(r.nextConfig.model_notice_ack, noticeSignature(next));
});

test('planFinalize: suggestion Keep is ack-only (no model change, no reconcile)', () => {
  const cfg = { ai_model: 'claude-sonnet-4-6' };
  const sig = noticeSignature(computeModelNotice(cfg.ai_model));
  const r = planFinalize('keep', cfg, sig);
  assert.strictEqual(r.nextConfig.ai_model, 'claude-sonnet-4-6');
  assert.strictEqual(r.reconcileSchedule, false);
  assert.strictEqual(r.nextConfig.model_notice_ack, 'suggestion:claude-sonnet-4-6>claude-sonnet-5');
});

test('persistConfig: save first; on save failure DO NOT reconcile', () => {
  let reconciled = false;
  const res = persistConfig({ ai_model: 'x' }, {
    reconcileSchedule: true,
    save: () => ({ success: false, error: 'disk full' }),
    reconcile: () => { reconciled = true; return { success: true }; },
  });
  assert.deepStrictEqual(res, { ok: false, stage: 'save', error: 'disk full' });
  assert.strictEqual(reconciled, false, 'never reconcile after a failed save');
});

test('persistConfig: ack-only skips reconcile; schedule failure is non-fatal', () => {
  assert.deepStrictEqual(persistConfig({}, { reconcileSchedule: false, save: () => ({ success: true }), reconcile: () => { throw new Error('should not run'); } }),
    { ok: true, schedule: { ok: true, skipped: true } });
  const res = persistConfig({}, { reconcileSchedule: true, save: () => ({ success: true }), reconcile: () => ({ success: false, error: 'no launchctl' }) });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.schedule.ok, false);
  assert.strictEqual(res.schedule.error, 'no launchctl');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test menubar/__tests__/model-notice.test.js`
Expected: FAIL — `resolveNoticeAction`/`planFinalize`/`persistConfig` are not exported.

- [ ] **Step 3: Implement** — in `menubar/model-notice.js`, add `KNOWN_MODEL_IDS` to the top require and append these functions before `module.exports`:

```js
const { KNOWN_MODEL_IDS } = require('./model-policy');

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
```

Extend `module.exports` to add `resolveNoticeAction, planFinalize, persistConfig`.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test menubar/__tests__/model-notice.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add menubar/model-notice.js menubar/__tests__/model-notice.test.js
git commit -m "feat(model-notice): action allow-list, finalize plan, save-then-reconcile primitive"
```

---

## Task 5: Renderer window (thin display)

**Files:**
- Create: `menubar/renderer/model-update.html`, `menubar/renderer/model-update.js`, `menubar/renderer/model-update-preload.js`

**Interfaces:**
- Consumes (from main, Task 6): IPC `model-notice:get` (returns `renderNoticeText` output) and `model-notice:action` (accepts an action string). The preload is the only bridge.
- Produces: a window whose renderer holds no finalize state — it renders `getNotice()` and calls `sendAction(...)`.

- [ ] **Step 1: Create the preload** — `menubar/renderer/model-update-preload.js`:

```js
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('modelNotice', {
  getNotice: () => ipcRenderer.invoke('model-notice:get'),
  sendAction: (action) => ipcRenderer.send('model-notice:action', String(action)),
});
```

- [ ] **Step 2: Create the HTML** — `menubar/renderer/model-update.html`:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self';" />
  <link rel="stylesheet" href="theme.css" />
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; padding: 20px; }
    #title { font-size: 15px; font-weight: 600; margin-bottom: 8px; }
    #body { font-size: 13px; line-height: 1.5; margin-bottom: 18px; }
    #buttons { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    button { padding: 6px 14px; font-size: 13px; cursor: pointer; }
    #close { margin-left: auto; background: transparent; border: none; opacity: 0.6; }
  </style>
</head>
<body>
  <div id="title"></div>
  <div id="body"></div>
  <div id="buttons"><button id="close" type="button">Close</button></div>
  <script src="model-update.js"></script>
</body>
</html>
```

- [ ] **Step 3: Create the renderer script** — `menubar/renderer/model-update.js`:

```js
'use strict';
(async function () {
  const view = await window.modelNotice.getNotice();
  if (!view) { window.close(); return; }
  document.getElementById('title').textContent = view.title;
  document.getElementById('body').textContent = view.body;
  const bar = document.getElementById('buttons');
  const close = document.getElementById('close');
  for (const b of view.buttons) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = b.label;
    btn.addEventListener('click', () => window.modelNotice.sendAction(b.action));
    bar.insertBefore(btn, close);
  }
  // The custom Close control triggers the native window close, which main finalizes conservatively.
  close.addEventListener('click', () => window.close());
})();
```

- [ ] **Step 4: Verify the renderer files load as valid JS** (no test harness for DOM; syntax check the scripts)

Run: `node --check menubar/renderer/model-update.js && node --check menubar/renderer/model-update-preload.js && echo "renderer scripts parse"`
Expected: `renderer scripts parse`. (Behavioral rendering logic — `renderNoticeText` — is already unit-tested in Task 3.)

- [ ] **Step 5: Commit**

```bash
git add menubar/renderer/model-update.html menubar/renderer/model-update.js menubar/renderer/model-update-preload.js
git commit -m "feat(model-notice): thin branded modal window (restricted preload)"
```

---

## Task 6: Main-process wiring

**Files:**
- Modify: `menubar/main.js`
- Test: `menubar/__tests__/model-notice-wiring.test.js` (create)

**Interfaces:**
- Consumes: `computeModelNotice`, `noticeSignature`, `renderNoticeText`, `parseModelLabels`, `planFinalize`, `persistConfig` from `./model-notice`; existing `saveConfigToFile` (`main.js:1690`), `updateLaunchAgent` (`:1736`), `surfaceScheduleWarning`, `runtimeChannel`, `CONFIG_DIR` (`:118`), `dialog`, `BrowserWindow`, `ipcMain`, `app`, `showSettingsWindow` (`:1514`), and `fs`/`path` (already required).
- Produces: the running feature.

- [ ] **Step 1: Add requires + module state** near the top of `menubar/main.js` (with the other requires):

```js
const { computeModelNotice, noticeSignature, renderNoticeText, parseModelLabels, planFinalize, persistConfig } = require('./model-notice');
let modelUpdateWindow = null;
let _noticeFinalized = false;
let appIsQuitting = false;
const MODEL_LABELS = parseModelLabels(fs.readFileSync(path.join(__dirname, 'renderer', 'settings.html'), 'utf8'));
```

- [ ] **Step 2: Add the quit flag** — register in the existing app lifecycle wiring (near the other `app.on(...)` handlers):

```js
app.on('before-quit', () => { appIsQuitting = true; });
```

- [ ] **Step 3: Add the finalizer + trigger + window** — add these functions in `menubar/main.js` (near `surfaceScheduleWarning`):

```js
function _readConfigFromDisk() {
  try { return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'config.json'), 'utf8')); }
  catch (e) { return {}; }
}

// The ONE authoritative, idempotent finalizer (renderer owns no finalize state).
function finalizeModelNotice(action) {
  if (_noticeFinalized || !modelUpdateWindow) return;
  const win = modelUpdateWindow;
  const plan = planFinalize(action, _readConfigFromDisk(), win._sig);
  if (plan.staleOrGone) { _noticeFinalized = true; win.destroy(); return; }
  if (!plan.valid) return; // disallowed/invalid: ignore, do NOT finalize
  const res = persistConfig(plan.nextConfig, { reconcileSchedule: plan.reconcileSchedule, save: saveConfigToFile, reconcile: updateLaunchAgent });
  if (!res.ok) { // benign error; keep window open, ack unchanged, re-shows next launch. NOT surfaceRuntimeError.
    dialog.showErrorBox('Repo Radar', `Could not save model change: ${res.error || 'unknown error'}`);
    return;
  }
  if (res.schedule && res.schedule.ok === false) surfaceScheduleWarning(res.schedule.error);
  _noticeFinalized = true;
  win.destroy();
  if (plan.openSettings) showSettingsWindow(); // existing opener at menubar/main.js:1514
}

function openModelUpdateWindow(notice, sig) {
  _noticeFinalized = false;
  const win = new BrowserWindow({
    width: 460, height: 220, resizable: false, minimizable: false, maximizable: false,
    fullscreenable: false, title: 'Repo Radar — Models', show: false,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(__dirname, 'renderer', 'model-update-preload.js'),
    },
  });
  win._sig = sig; win._notice = notice;
  win.on('close', (e) => { if (_noticeFinalized || appIsQuitting) return; e.preventDefault(); finalizeModelNotice('close'); });
  win.on('closed', () => { if (modelUpdateWindow === win) modelUpdateWindow = null; });
  win.loadFile(path.join(__dirname, 'renderer', 'model-update.html'));
  win.once('ready-to-show', () => win.show());
  modelUpdateWindow = win;
}

// Stable-only, actionable-only, once per notice content.
function maybeShowModelNotice() {
  if (runtimeChannel !== 'stable') return;
  const config = _readConfigFromDisk();
  const notice = computeModelNotice(config.ai_model);
  if (!notice) return;
  const sig = noticeSignature(notice);
  if (config.model_notice_ack === sig) return;
  openModelUpdateWindow(notice, sig);
}
```

- [ ] **Step 4: Add the sender-bound IPC handlers** — near the other `ipcMain` registrations:

```js
ipcMain.handle('model-notice:get', (event) => {
  if (!modelUpdateWindow || event.sender !== modelUpdateWindow.webContents) return null;
  return renderNoticeText(modelUpdateWindow._notice, MODEL_LABELS);
});
ipcMain.on('model-notice:action', (event, action) => {
  if (!modelUpdateWindow || event.sender !== modelUpdateWindow.webContents) return;
  if (typeof action !== 'string') return;
  finalizeModelNotice(action);
});
```

- [ ] **Step 5: Call the trigger at stable startup** — inside the existing `app.whenReady().then(async () => { ... })`, AFTER the runtime bootstrap + tray are set up, add:

```js
  maybeShowModelNotice();
```

- [ ] **Step 6: Route Settings' save through the shared primitive** — in the `ipcMain.on('save-config', ...)` handler, replace the direct `saveConfigToFile(config)` + `updateLaunchAgent(config)` sequence with:

```js
  const res = persistConfig(config, { reconcileSchedule: true, save: saveConfigToFile, reconcile: updateLaunchAgent });
  const result = res.ok ? { success: true } : { success: false, error: res.error };
  // preserve the existing reply + schedule-warning behavior:
  if (res.ok && res.schedule && res.schedule.ok === false) surfaceScheduleWarning(res.schedule.error);
```

(Keep the handler's existing `event.reply('config-saved', ...)` semantics; only the save+reconcile call changes so both paths share one primitive.)

- [ ] **Step 7: Write the wiring assertions** — create `menubar/__tests__/model-notice-wiring.test.js`:

```js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

assert.ok(/require\(['"]\.\/model-notice['"]\)/.test(src), 'main.js requires ./model-notice');
assert.ok(/runtimeChannel !== 'stable'/.test(src), 'maybeShowModelNotice is stable-only');
assert.ok(/appIsQuitting/.test(src) && /before-quit/.test(src), 'before-quit sets appIsQuitting');
assert.ok(/event\.sender !== modelUpdateWindow\.webContents/.test(src), 'IPC handlers are sender-bound');
assert.ok(/e\.preventDefault\(\);\s*finalizeModelNotice\('close'\)/.test(src), 'close handler finalizes via main');
assert.ok(/persistConfig\(config, \{ reconcileSchedule: true/.test(src), 'save-config routes through persistConfig');
assert.ok(/maybeShowModelNotice\(\)/.test(src), 'trigger is called at startup');
console.log('model-notice wiring OK');
```

- [ ] **Step 8: Run the wiring test + parse check**

Run: `node menubar/__tests__/model-notice-wiring.test.js && node --check menubar/main.js`
Expected: `model-notice wiring OK` and a clean parse.

- [ ] **Step 9: Commit**

```bash
git add menubar/main.js menubar/__tests__/model-notice-wiring.test.js
git commit -m "feat(model-notice): stable startup trigger, hardened modal + IPC, shared persistConfig save path"
```

---

## Task 7: Full-suite verification + manual smoke

**Files:** none (verification).

- [ ] **Step 1: Run the whole menubar test set**

Run:
```bash
cd ~/.claude-worktrees/repo-radar-model-notice
node menubar/__tests__/model-policy.test.js
node menubar/__tests__/dropdown.test.js
node menubar/__tests__/drift-check.js
node menubar/__tests__/model-notice-wiring.test.js
node --test menubar/__tests__/model-notice.test.js
```
Expected: every script prints its `OK` line and `node --test` reports `pass` with `fail 0`.

- [ ] **Step 2: Manual smoke on a stable-channel dev run** — seed a saved model, confirm the notice, each action, and dedup:

```bash
# migration+suggestion (compound):
mkdir -p ~/.config/repo-radar && printf '{"ai_model":"gemini/gemini-2.0-flash"}' > ~/.config/repo-radar/config.json
```
Launch the app on the **stable** channel. Verify: the modal shows the compound copy; **Keep** persists `ai_model=gemini/gemini-2.5-flash` and `model_notice_ack=suggestion:gemini/gemini-2.5-flash>gemini/gemini-3.5-flash` in `~/.config/repo-radar/config.json`; relaunch shows **no** notice (dedup); the LaunchAgent plist env `AI_MODEL` matches the new model (`plutil -p ~/Library/LaunchAgents/com.user.repo-radar.plist | grep AI_MODEL` or the channel's plist). Repeat with `ai_model` set to `claude-sonnet-4-6` (pure suggestion → Switch) and `claude-3-5-sonnet-20241022` (pure migration → OK).

- [ ] **Step 3: Confirm dev suppression** — on a **dev** build with a compound `ai_model`, launch and verify **no** notice appears and `model_notice_ack` is NOT written.

- [ ] **Step 4: Final commit (if the smoke required any fix)** — otherwise nothing to commit; the feature is complete.

---

## Self-review notes (already applied)

- **Spec coverage:** §5 map+invariants → Tasks 1–2; §6 compute/signature/ack → Tasks 3–4; §7 trigger/persistConfig/finalizer/IPC/quit-escape → Tasks 4,6; §8 modal → Task 5; §11 tests → Tasks 3,4,6,7. Stable-only, sender-binding, provider-parity, dropdown membership, label fallback, compound-Keep-next-launch all have explicit tests.
- **Type consistency:** `computeModelNotice`/`noticeSignature`/`resolveNoticeAction`/`planFinalize`/`persistConfig`/`renderNoticeText` signatures are identical across the task that defines them and Task 6's wiring.
- **Sequencing:** Task 0 enforces Spec-2A-merged → rebase → revalidate before any code.
