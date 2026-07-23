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
- `menubar/model-notice-controller.js` — **create**: dependency-injected coordinator (`createModelNoticeController(deps)`) holding all notice behavior (stable-only, dedup, sender rejection, finalize idempotency, save-failure, close/quit rules) so it is unit-testable with fakes.
- `menubar/__tests__/model-notice-controller.test.js` — **create**: behavioral tests with fake windows/senders/persistence/config.
- `menubar/main.js` — **modify**: thin glue — build the controller with real deps (config read, `saveConfigToFile`, `updateLaunchAgent`, real `BrowserWindow`), call `.maybe()` at stable startup, wire sender-bound IPC + `close` handler + `before-quit`, and refactor `save-config` onto `persistConfig`.
- `menubar/__tests__/model-notice-wiring.test.js` — **create**: a small static landmark (require + trigger + before-quit present); the behavior is proven by the controller test, not this one.

---

## Task 0: Execution gate (do this before any code)

**Files:** none (branch hygiene + verification).

This branch (`feature/model-update-notice-v1.0.27`) was cut from the canonical `menubar/` structure that only reaches `dev` when Spec 2A merges. Do not start Task 1 until this gate passes.

- [ ] **Step 1: Confirm Spec 2A merged to `dev` (ancestry + structure, not a message grep)**

Run:
```bash
cd ~/.claude-worktrees/repo-radar-model-notice && git fetch origin
# The runtime-binding work only reaches dev via Spec 2A. Prove it two ways:
git merge-base --is-ancestor 5874973 origin/dev && echo "spec2a-ancestor: yes" || echo "spec2a-ancestor: NO"
git cat-file -e origin/dev:menubar/runtime/quiesce.js 2>/dev/null && echo "menubar/runtime present on dev: yes" || echo "menubar/runtime present on dev: NO"
```
Expected: both print `yes`. `5874973` is the final Spec 2A round-9 commit; if review added later commits, substitute the actual merged Spec 2A head. If either prints `NO`, STOP — the gate is not met, stay parked.

- [ ] **Step 2: Rebase the notice branch onto fresh `dev`**

Run:
```bash
cd ~/.claude-worktrees/repo-radar-model-notice
git rebase origin/dev
```
Expected: rebase completes clean. Only this branch's own doc commits (the spec revs `851d055..2981472` **and** this plan commit `14bfc25`, plus any later plan edits) replay onto `dev`; there is no `menubar/` code on this branch yet, so there is nothing to conflict with the merged Spec 2A code. Resolve any doc conflict by keeping this branch's version.

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

## Task 6: `model-notice-controller.js` — dependency-injected coordinator

**Files:**
- Create: `menubar/model-notice-controller.js`
- Test: `menubar/__tests__/model-notice-controller.test.js`

**Interfaces:**
- Consumes: `computeModelNotice`, `noticeSignature`, `renderNoticeText`, `planFinalize`, `persistConfig` from `./model-notice`.
- Produces: `createModelNoticeController(deps) -> { maybe, getView, onAction, closeDecision, finalize, isFinalized }`.
  - `deps = { channel, readConfig, save, reconcile, labels, openWindow, showError, showScheduleWarning, isQuitting, openSettings }`.
  - `openWindow(notice, sig)` returns a window handle exposing `{ webContents, destroy() }`.
  - `maybe() -> windowHandle|null`; `getView(sender) -> renderNoticeText output|null`; `onAction(sender, action) -> void`; `closeDecision() -> 'allow'|'handle'` (pure); `finalize(action) -> void`; `isFinalized() -> boolean`.

All Electron/IO is injected, so behavior (stable-only, dedup, sender rejection, finalize idempotency, save-failure, quit escape) is unit-tested with fakes. `main.js` (Task 7) supplies the real deps.

- [ ] **Step 1: Write the failing behavioral test** — create `menubar/__tests__/model-notice-controller.test.js`:

```js
const test = require('node:test'); const assert = require('node:assert');
const { createModelNoticeController } = require('../model-notice-controller');

function harness(over = {}) {
  const state = {
    channel: 'stable', config: { ai_model: 'claude-sonnet-4-6' }, saved: [], reconciled: 0,
    errors: [], scheduleWarnings: [], settingsOpened: 0, quitting: false, windows: [],
    saveResult: { success: true }, reconcileResult: { success: true }, ...over,
  };
  const deps = {
    channel: state.channel,
    readConfig: () => ({ ...state.config }),
    save: (c) => { state.saved.push({ ...c }); state.config = { ...c }; return state.saveResult; },
    reconcile: () => { state.reconciled++; return state.reconcileResult; },
    labels: {},
    openWindow: () => { const w = { webContents: { id: state.windows.length + 1 }, destroyed: false, destroy() { this.destroyed = true; } }; state.windows.push(w); return w; },
    showError: (e) => state.errors.push(e),
    showScheduleWarning: (e) => state.scheduleWarnings.push(e),
    isQuitting: () => state.quitting,
    openSettings: () => { state.settingsOpened++; },
  };
  return { ctl: createModelNoticeController(deps), state };
}

test('maybe: dev build shows nothing (stable-only)', () => {
  const { ctl, state } = harness({ channel: 'dev' });
  assert.strictEqual(ctl.maybe(), null);
  assert.strictEqual(state.windows.length, 0);
});
test('maybe: dedup — a matching ack shows nothing', () => {
  const { ctl, state } = harness();
  state.config.model_notice_ack = 'suggestion:claude-sonnet-4-6>claude-sonnet-5';
  assert.strictEqual(ctl.maybe(), null);
  assert.strictEqual(state.windows.length, 0);
});
test('maybe: opens a window for an actionable notice', () => {
  const { ctl, state } = harness();
  assert.ok(ctl.maybe());
  assert.strictEqual(state.windows.length, 1);
});
test('onAction: foreign sender is rejected (no persist, not finalized)', () => {
  const { ctl, state } = harness();
  ctl.maybe();
  ctl.onAction({ id: 999 }, 'switch');
  assert.strictEqual(state.saved.length, 0);
  assert.strictEqual(ctl.isFinalized(), false);
});
test('onAction switch: persists suggested, reconciles, destroys, finalized', () => {
  const { ctl, state } = harness();
  const w = ctl.maybe();
  ctl.onAction(w.webContents, 'switch');
  assert.strictEqual(state.saved[0].ai_model, 'claude-sonnet-5');
  assert.strictEqual(state.reconciled, 1);
  assert.strictEqual(w.destroyed, true);
  assert.strictEqual(ctl.isFinalized(), true);
});
test('save failure: not finalized, error surfaced, window kept, never reconciled', () => {
  const { ctl, state } = harness({ saveResult: { success: false, error: 'disk full' } });
  const w = ctl.maybe();
  ctl.onAction(w.webContents, 'switch');
  assert.strictEqual(ctl.isFinalized(), false);
  assert.deepStrictEqual(state.errors, ['disk full']);
  assert.strictEqual(w.destroyed, false);
  assert.strictEqual(state.reconciled, 0);
});
test('idempotent: a second action after finalize does nothing', () => {
  const { ctl, state } = harness();
  const w = ctl.maybe();
  ctl.onAction(w.webContents, 'switch');
  ctl.onAction(w.webContents, 'switch');
  assert.strictEqual(state.saved.length, 1);
});
test('compound Keep: persists effective + acks resulting suggestion; re-run dedups', () => {
  const { ctl, state } = harness({ config: { ai_model: 'gemini/gemini-2.0-flash' } });
  const w = ctl.maybe();
  ctl.onAction(w.webContents, 'keep');
  assert.strictEqual(state.saved[0].ai_model, 'gemini/gemini-2.5-flash');
  assert.strictEqual(state.saved[0].model_notice_ack, 'suggestion:gemini/gemini-2.5-flash>gemini/gemini-3.5-flash');
  assert.strictEqual(ctl.maybe(), null, 'resulting config dedups the follow-on suggestion');
});
test('closeDecision is pure: handle normally, allow when finalized', () => {
  const { ctl } = harness();
  const w = ctl.maybe();
  assert.strictEqual(ctl.closeDecision(), 'handle');
  ctl.finalize('keep'); // suggestion close/keep is ack-only -> finalized
  assert.strictEqual(ctl.isFinalized(), true);
  assert.strictEqual(ctl.closeDecision(), 'allow');
});
test('quit escape: closeDecision allows close even when a failing save left it un-finalized', () => {
  const { ctl, state } = harness({ saveResult: { success: false, error: 'x' } });
  const w = ctl.maybe();
  ctl.finalize('switch');
  assert.strictEqual(ctl.isFinalized(), false);
  assert.strictEqual(ctl.closeDecision(), 'handle');
  state.quitting = true;
  assert.strictEqual(ctl.closeDecision(), 'allow');
});
test('getView: foreign sender gets null; the real sender gets the view', () => {
  const { ctl } = harness();
  const w = ctl.maybe();
  assert.strictEqual(ctl.getView({ id: 999 }), null);
  assert.ok(ctl.getView(w.webContents));
});
test('schedule-warning surfaced when reconcile fails (save still ok -> finalized)', () => {
  const { ctl, state } = harness({ reconcileResult: { success: false, error: 'no launchctl' } });
  const w = ctl.maybe();
  ctl.onAction(w.webContents, 'switch');
  assert.strictEqual(ctl.isFinalized(), true, 'schedule failure is non-fatal');
  assert.deepStrictEqual(state.scheduleWarnings, ['no launchctl']);
});
test('migration Review: persists effective (heals retired id) and opens Settings', () => {
  const { ctl, state } = harness({ config: { ai_model: 'claude-3-5-sonnet-20241022' } });
  const w = ctl.maybe();
  ctl.onAction(w.webContents, 'review');
  assert.strictEqual(state.saved[0].ai_model, 'claude-sonnet-5');
  assert.strictEqual(state.settingsOpened, 1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test menubar/__tests__/model-notice-controller.test.js`
Expected: FAIL — cannot find module `../model-notice-controller`.

- [ ] **Step 3: Implement** — create `menubar/model-notice-controller.js`:

```js
'use strict';
const { computeModelNotice, noticeSignature, renderNoticeText, planFinalize, persistConfig } = require('./model-notice');

// Dependency-injected coordinator. All Electron/IO is injected so behavior is unit-testable.
function createModelNoticeController(deps) {
  let win = null;
  let finalized = false;

  function maybe() {
    if (deps.channel !== 'stable') return null;
    const config = deps.readConfig();
    const notice = computeModelNotice(config.ai_model);
    if (!notice) return null;
    const sig = noticeSignature(notice);
    if (config.model_notice_ack === sig) return null;
    finalized = false;
    win = deps.openWindow(notice, sig);
    win.sig = sig; win.notice = notice;
    return win;
  }

  function getView(sender) {
    if (!win || sender !== win.webContents) return null;
    return renderNoticeText(win.notice, deps.labels);
  }

  function finalize(action) {
    if (finalized || !win) return;
    const plan = planFinalize(action, deps.readConfig(), win.sig);
    if (plan.staleOrGone) { finalized = true; win.destroy(); win = null; return; }
    if (!plan.valid) return; // disallowed/invalid target: ignore, do NOT finalize
    const res = persistConfig(plan.nextConfig, { reconcileSchedule: plan.reconcileSchedule, save: deps.save, reconcile: deps.reconcile });
    if (!res.ok) { deps.showError(res.error); return; } // benign; keep window, ack unchanged, re-shows next launch
    if (res.schedule && res.schedule.ok === false) deps.showScheduleWarning(res.schedule.error);
    finalized = true; win.destroy(); win = null;
    if (plan.openSettings) deps.openSettings();
  }

  function onAction(sender, action) {
    if (!win || sender !== win.webContents) return; // foreign sender rejected
    if (typeof action !== 'string') return;
    finalize(action);
  }

  // Pure decision for main's `close` handler: 'handle' -> preventDefault + finalize('close').
  function closeDecision() {
    if (finalized || deps.isQuitting()) return 'allow'; // done, or quitting (never trap app.quit)
    return 'handle';
  }

  return { maybe, getView, onAction, closeDecision, finalize, isFinalized: () => finalized };
}

module.exports = { createModelNoticeController };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test menubar/__tests__/model-notice-controller.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add menubar/model-notice-controller.js menubar/__tests__/model-notice-controller.test.js
git commit -m "feat(model-notice): DI notice controller with behavioral tests"
```

---

## Task 7: Main-process glue

**Files:**
- Modify: `menubar/main.js`
- Test: `menubar/__tests__/model-notice-wiring.test.js` (create — static landmark only)

**Interfaces:**
- Consumes: `createModelNoticeController` (Task 6); `parseModelLabels` (Task 3); `persistConfig` (Task 4); existing `saveConfigToFile` (`main.js:1690`), `updateLaunchAgent` (`:1736`), `surfaceScheduleWarning`, `runtimeChannel`, `CONFIG_DIR` (`:118`), `dialog`, `BrowserWindow`, `ipcMain`, `app`, `showSettingsWindow` (`:1514`), `fs`/`path`.
- Produces: the running feature.

- [ ] **Step 1: Add requires + module state** near the top requires of `menubar/main.js`:

```js
const { createModelNoticeController } = require('./model-notice-controller');
const { parseModelLabels, persistConfig } = require('./model-notice');
let appIsQuitting = false;
let modelNoticeController = null;
const MODEL_LABELS = parseModelLabels(fs.readFileSync(path.join(__dirname, 'renderer', 'settings.html'), 'utf8'));
```

- [ ] **Step 2: Add the quit flag** — with the other `app.on(...)` handlers:

```js
app.on('before-quit', () => { appIsQuitting = true; });
```

- [ ] **Step 3: Add the disk read + window opener + controller builder** near `surfaceScheduleWarning`:

```js
function _readModelConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'config.json'), 'utf8')); }
  catch (e) { return {}; }
}

function _openModelUpdateWindow(notice, sig) {
  const win = new BrowserWindow({
    width: 460, height: 220, resizable: false, minimizable: false, maximizable: false,
    fullscreenable: false, title: 'Repo Radar — Models', show: false,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(__dirname, 'renderer', 'model-update-preload.js'),
    },
  });
  win.on('close', (e) => {
    if (!modelNoticeController || modelNoticeController.closeDecision() === 'allow') return;
    e.preventDefault();
    modelNoticeController.finalize('close');
  });
  win.loadFile(path.join(__dirname, 'renderer', 'model-update.html'));
  win.once('ready-to-show', () => win.show());
  return win;
}

function buildModelNoticeController() {
  modelNoticeController = createModelNoticeController({
    channel: runtimeChannel,
    readConfig: _readModelConfig,
    save: saveConfigToFile,
    reconcile: updateLaunchAgent,
    labels: MODEL_LABELS,
    openWindow: _openModelUpdateWindow,
    showError: (err) => dialog.showErrorBox('Repo Radar', `Could not save model change: ${err || 'unknown error'}`),
    showScheduleWarning: (err) => surfaceScheduleWarning(err),
    isQuitting: () => appIsQuitting,
    openSettings: () => showSettingsWindow(),
  });
  return modelNoticeController;
}
```

- [ ] **Step 4: Add the sender-bound IPC handlers** — with the other `ipcMain` registrations:

```js
ipcMain.handle('model-notice:get', (event) => modelNoticeController ? modelNoticeController.getView(event.sender) : null);
ipcMain.on('model-notice:action', (event, action) => { if (modelNoticeController) modelNoticeController.onAction(event.sender, action); });
```

- [ ] **Step 5: Trigger at stable startup** — inside `app.whenReady().then(async () => { ... })`, AFTER runtime bootstrap + tray setup:

```js
  buildModelNoticeController();
  modelNoticeController.maybe();
```

- [ ] **Step 6: Route Settings' save through the shared primitive** — in the `ipcMain.on('save-config', ...)` handler, replace the `saveConfigToFile(config)` + `updateLaunchAgent(config)` sequence with:

```js
  const res = persistConfig(config, { reconcileSchedule: true, save: saveConfigToFile, reconcile: updateLaunchAgent });
  const result = res.ok ? { success: true } : { success: false, error: res.error };
  if (res.ok && res.schedule && res.schedule.ok === false) surfaceScheduleWarning(res.schedule.error);
```

Keep the handler's existing reply — `settingsWindow.webContents.send('config-saved', result.success, result.error)` (main.js:1983), NOT `event.reply`; only the save+reconcile call changes so both paths share one primitive.

- [ ] **Step 7: Write the static landmark test** — create `menubar/__tests__/model-notice-wiring.test.js`:

```js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

// Landmark only — the BEHAVIOR is proven by model-notice-controller.test.js.
assert.ok(/require\(['"]\.\/model-notice-controller['"]\)/.test(src), 'requires the controller');
assert.ok(/before-quit['"]\s*,\s*\(\)\s*=>\s*\{\s*appIsQuitting = true/.test(src), 'before-quit sets appIsQuitting');
assert.ok(/modelNoticeController\.maybe\(\)/.test(src), 'trigger is called at startup');
assert.ok(/persistConfig\(config, \{ reconcileSchedule: true/.test(src), 'save-config uses persistConfig');
assert.ok(/event\.sender/.test(src) === false || /getView\(event\.sender\)/.test(src), 'IPC forwards sender to the controller for binding');
console.log('model-notice wiring landmark OK');
```

- [ ] **Step 8: Run the landmark + parse check**

Run: `node menubar/__tests__/model-notice-wiring.test.js && node --check menubar/main.js`
Expected: `model-notice wiring landmark OK` and a clean parse.

- [ ] **Step 9: Commit**

```bash
git add menubar/main.js menubar/__tests__/model-notice-wiring.test.js
git commit -m "feat(model-notice): wire DI controller into main (startup trigger, IPC, close/quit, shared save)"
```

---

## Task 8: Full release-gate verification + isolated smoke

**Files:** none (verification).

- [ ] **Step 1: Parse-check every changed/created JS file**

Run:
```bash
cd ~/.claude-worktrees/repo-radar-model-notice
for f in menubar/model-policy.js menubar/model-notice.js menubar/model-notice-controller.js menubar/main.js \
         menubar/renderer/model-update.js menubar/renderer/model-update-preload.js; do node --check "$f" || exit 1; done
echo "parse OK"
```
Expected: `parse OK`.

- [ ] **Step 2: Run the model-notice unit + landmark suites**

Run:
```bash
node menubar/__tests__/model-policy.test.js
node menubar/__tests__/dropdown.test.js
node menubar/__tests__/drift-check.js
node menubar/__tests__/model-notice-wiring.test.js
node --test menubar/__tests__/model-notice.test.js menubar/__tests__/model-notice-controller.test.js
```
Expected: each script prints its `OK` line; `node --test` reports `pass` with `fail 0`.

- [ ] **Step 3: Run the inherited Spec 2A + release gates (must stay green after this feature)**

Run:
```bash
# Spec 2A runtime suite + its main wiring
node --test menubar/runtime/__tests__/*.test.js
node menubar/__tests__/main-runtime-wiring.test.js
# dependency matrix preflight (Spec 2A release gate)
node menubar/scripts/pydeps.js --assert-matrix
# Python package tests via the PROJECT venv (the suite includes the litellm 1.93.0 assertion,
# so the system python3 is wrong here) — repo_radar is untouched, but prove no regression
.venv/bin/python -m pytest repo_radar/tests -q
```
Expected: runtime suite `fail 0`; `main-runtime-wiring` prints OK; `--assert-matrix` validates all 10 cells; pytest passes. If `pydeps.js`/the lifecycle gate has a different invocation on merged `dev`, use the one the Spec 2A release checklist documents (Task 0 revalidation surfaces the exact commands).

- [ ] **Step 4: Run the release lifecycle gate**

Run the model-lifecycle gate explicitly:

```bash
python3 scripts/check_model_lifecycle.py --target-date 2026-07-23
```
Expected: green output (no retired/expired model in the shipped catalog for the target date). Update `--target-date` to the actual release date if it differs.

- [ ] **Step 5: Isolated, non-destructive manual smoke — NEVER against your own account**

The app resolves config, LaunchAgents, and the launchctl gui domain from the running user. A temp `$HOME` isolates files but NOT the launchctl gui domain, so a real run would rewrite your config and load the production `com.user.repo-radar` label. Run the smoke in a **dedicated macOS test user account** (separate gui domain) — or a VM — with the packaged **stable** artifact. Do not run it as Matt's user. **Creating and deleting that test account is an explicit operator action — the plan does not script it.**

In the test account, seed a config with an **enabled schedule** (otherwise `updateLaunchAgent` writes no plist, so the plist assertion below would inspect a file that never gets created):
```bash
# compound (migration + suggestion), WITH a schedule so the LaunchAgent plist is generated:
mkdir -p ~/.config/repo-radar
printf '{"ai_model":"gemini/gemini-2.0-flash","schedule":{"enabled":true,"type":"daily","hour":9,"minute":0}}' > ~/.config/repo-radar/config.json
# launch the packaged STABLE Repo Radar.app in this account
```
Verify: the modal shows the compound copy; **Keep** writes `ai_model=gemini/gemini-2.5-flash` and `model_notice_ack=suggestion:gemini/gemini-2.5-flash>gemini/gemini-3.5-flash` to `~/.config/repo-radar/config.json`; because the schedule is enabled, the plist **file** reflects the new model — `plutil -p ~/Library/LaunchAgents/com.user.repo-radar.plist | grep AI_MODEL`; a relaunch shows **no** notice (dedup). Repeat with `ai_model=claude-sonnet-4-6` (pure suggestion → **Switch** → `claude-sonnet-5`) and `ai_model=claude-3-5-sonnet-20241022` (pure migration → **OK** persists `claude-sonnet-5`), keeping the schedule block. (If you test without an enabled schedule, skip the plist assertion — no plist is written by design.) Tear down by removing the test account's `~/.config/repo-radar` + `~/Library/LaunchAgents/com.user.repo-radar.plist`; deleting the account itself is a manual operator step.

- [ ] **Step 6: Dev-suppression smoke** — in the test account with a packaged **dev** build and a compound `ai_model`, launch and confirm **no** notice appears and `model_notice_ack` is NOT written.

- [ ] **Step 7: Final** — no commit unless a smoke surfaced a fix. The feature is complete; hand off to the final whole-branch review (superpowers:requesting-code-review) + a Codex code-review brief before merging to `dev`.

---

## Self-review notes (already applied)

- **Spec coverage:** §5 map+invariants → Tasks 1–2; §6 compute/signature/ack → Tasks 3–4; §7 trigger/persistConfig/finalizer/IPC/quit-escape → Tasks 4,6,7; §8 modal → Task 5; §11 tests → Tasks 3,4,6,8. Stable-only, sender-binding, provider-parity, dropdown membership, label fallback, compound-Keep-next-launch, save-failure, quit-escape, dedup all have explicit tests (pure or DI-controller behavioral).
- **Testability (Codex):** all main-process behavior lives in the DI `model-notice-controller` and is tested with fakes; `main.js` is thin glue with only a static landmark test.
- **Non-destructive verification (Codex):** the manual smoke runs in a dedicated macOS test account (not Matt's), reads the plist file rather than loading the production label, and never writes the real `~/.config/repo-radar/config.json`.
- **Full gate (Codex):** Task 8 runs the runtime suite, `main-runtime-wiring`, Python tests, `pydeps.js --assert-matrix`, the lifecycle gate, and per-file parse checks — not just the model-notice tests.
- **Type consistency:** controller/`planFinalize`/`persistConfig`/`renderNoticeText`/`computeModelNotice` signatures match across Tasks 3–7.
- **Sequencing:** Task 0 gates on Spec-2A-merged (ancestry + file check) → rebase → revalidate before any code.
