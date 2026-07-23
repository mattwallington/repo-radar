# Post-Upgrade Model-Update Notice — Design

**Status:** approved design, pre-implementation
**Target release:** v1.0.27 (ships alongside Spec 2A runtime binding)
**Branch:** `feature/model-update-notice-v1.0.27` (cut from the canonical `menubar/` structure; see §9 Sequencing)
**Date:** 2026-07-23 (rev 3 — Codex execution-contract corrections)

## 1. Problem

Repo Radar refreshes its LLM model catalog on app updates (Spec 1) and, with Spec 2A, that
refresh actually reaches an upgraded user's Python runtime. But an existing user with a
**saved** model choice (`config.ai_model`) is never told anything changed:

- If their saved model was **retired**, `migrateModel()` silently remaps it in memory at sync
  time (`menubar/main.js`, `repo_radar/llm.py:get_ai_model`), changing their cost/quality
  profile without consent, and the retired id is **not persisted** until they happen to open and
  save Settings.
- If a **newer model in their tier** ships, they keep their old one — new models only appear in
  the Settings dropdown, which they may never open.

New installs are fine (they start on `DEFAULT_MODEL = claude-sonnet-5`). The gap is **existing
users with an explicit saved choice**. This feature closes it with a one-time, *actionable-only*
notice after an upgrade.

## 2. Non-goals

- **No generic "catalog refreshed, go browse" nag.** We only interrupt when there is a concrete,
  relevant action for *this* user (a migration happened, or a same-tier upgrade exists).
- **No auto-switching of a deliberate choice.** The notice informs and offers a one-click switch;
  it never changes a live saved model on its own.
- **No Python changes.** Model *suggestions* are UI policy consumed only by the Electron layer.
  Python already migrates (`migrate_model`) and validates (`KNOWN_LIMITS`); it needs neither the
  suggestion map nor the notice.

## 3. Canonical facts (verified in `feature/runtime-binding-v1.0.27`)

- `DEFAULT_MODEL = 'claude-sonnet-5'` — `menubar/model-policy.js:2`, `repo_radar/llm.py:11`.
- `gpt-4o` / `gpt-4o-mini` are **live, supported** ids in `KNOWN_MODEL_IDS` — **not** migration keys.
- `MODEL_MIGRATIONS` (retired id → current) lives in `menubar/model-policy.js`, mirrored in
  `repo_radar/llm.py`; `menubar/__tests__/drift-check.js` enforces JS↔Python parity of
  `DEFAULT_MODEL`, `MODEL_MIGRATIONS`, and `KNOWN_MODEL_IDS`.
- `migrateModel(raw)` returns the migrated id or `raw` unchanged; applied in memory at every read
  of `config.ai_model`, and again in Python (`get_ai_model`). The retired id in `config.ai_model`
  is generally **not** rewritten to disk.
- **The scheduled sync embeds the model in the LaunchAgent.** `updateLaunchAgent(config)`
  (`menubar/main.js:1736`) writes `AI_MODEL = migrateModel(config.ai_model || DEFAULT_MODEL)` into
  the plist env (`:1851`). The Settings save path is `save-config` → `saveConfigToFile(config)`
  **then** `updateLaunchAgent(config)` (`:1966`–`:1971`). Writing `config.json` alone leaves the
  *scheduled* run on the old model even though Sync Now would use the new one.
- Config file: `path.join(CONFIG_DIR, 'config.json')`, **shared across channels** (dev/stable).
- Channel/version signals: `runtimeChannel` (`'stable'`|`'dev'`|`null`), `IS_DEV_BUILD`,
  `app.getVersion()`. Schedule-failure surfacing exists (`surfaceScheduleWarning`, Spec 2A).
- Existing extra windows (`about`/`log-viewer`) use `nodeIntegration:true`/`contextIsolation:false`.
  The model-update window will NOT; it uses a hardened preload (§7).

## 4. Decisions

1. **Behavior:** inform + one-click switch. Never auto-changes a live saved choice.
2. **Suggestion basis:** same tier, newer generation.
3. **UI surface:** custom branded modal window. The renderer sends only an *action*; the main
   process owns and validates every model id and owns finalization (§7).
4. **Compound migration+suggestion is handled in one notice** (the two are not mutually exclusive).

## 5. `MODEL_SUGGESTIONS` — the new artifact (JS-only, normative for v1.0.27)

Add to `menubar/model-policy.js` (NOT mirrored to Python). **The v1.0.27 shipped map is exactly
these four rows** (normative, not an implementation-time curation call):

```js
const MODEL_SUGGESTIONS = {
  'claude-sonnet-4-6': 'claude-sonnet-5',
  'claude-opus-4-7': 'claude-opus-4-8',
  'gemini/gemini-2.5-flash': 'gemini/gemini-3.5-flash',
  'gemini/gemini-2.5-flash-lite': 'gemini/gemini-3.1-flash-lite',
};
function suggestUpgrade(model) { return (model && MODEL_SUGGESTIONS[model]) || null; }
```

Rules, asserted by `menubar/__tests__/drift-check.js` (JS-internal — no Python mirror):
- every key and value ∈ `KNOWN_MODEL_IDS`;
- **every value is a selectable option in `menubar/renderer/settings.html`'s model dropdown**
  (so a switch lands on a model the user can also see and re-select);
- every value is GA (does not end in `-preview`);
- no value is itself a `MODEL_MIGRATIONS` key (targets must be current);
- no key equals its value.

`suggestUpgrade` is always evaluated on the **effective** (post-migration) model (§6), covering
both live-model and just-migrated users. OpenAI is intentionally omitted for v1.0.27 (`gpt-5.5` →
`gpt-5.6-{luna,terra,sol}` tiering is ambiguous). Future releases add rows; drift-check guards them.

## 6. Notice model + acknowledgement (pure)

Computed from the **raw** saved id and its **effective** (migrated) id. Migration and suggestion
are **not** mutually exclusive: several retired ids migrate onto a suggestion key (e.g.
`gemini/gemini-2.0-flash → 2.5-flash → suggested 3.5-flash`; `…2.0-flash-lite → 2.5-flash-lite →
3.1-flash-lite`; `…1.5-flash → 2.5-flash → 3.5-flash`) → a **compound** notice.

```js
// null | {kind:'migration', from, effective}
//      | {kind:'suggestion', from, effective, suggested}   (effective === from)
//      | {kind:'compound',  from, effective, suggested}
function computeModelNotice(rawModel) {
  if (!rawModel) return null;                    // never configured -> already on the default
  const effective = migrateModel(rawModel);
  const migrated  = effective !== rawModel;
  const suggested = suggestUpgrade(effective);   // evaluate on the EFFECTIVE model
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
```

### Displayed signature vs acknowledgement signature (Codex Important 1)

Two distinct uses of `noticeSignature`, and they are **not** the same value for compound actions:

- **Displayed signature** = `noticeSignature(computeModelNotice(config.ai_model))` at open time.
  Stored on the window; used to gate showing (step 3) and to detect staleness (§7).
- **Acknowledgement signature** = `noticeSignature(computeModelNotice(finalModel))` — the signature
  the *resulting* model would produce **after** the action. This is what we persist to
  `config.model_notice_ack`.

Why: a compound "Keep {effective}" sets `ai_model = effective`, whose next-launch notice is a pure
`suggestion:effective>suggested` — which would NOT match a stored *compound* signature and would
re-prompt. Persisting the **post-action** signature (the resulting `suggestion:…`) suppresses
exactly the offer the user just declined, while a genuinely newer suggestion (different signature)
still surfaces later. When the resulting notice is `null` (e.g. a Switch, or a migration onto a
clean model), the next launch returns early regardless, so any stored value is inert.

## 7. Trigger, persistence, ownership, hardening (main process)

At **stable-build** startup (after runtime bootstrap, tray ready), `maybeShowModelNotice()`:

1. **Stable-only.** `if (runtimeChannel !== 'stable') return;` — a dev prerelease never reads/writes
   the ack, so it can't stamp the shared `config.json` and suppress the next stable notice.
2. `const notice = computeModelNotice(config.ai_model); if (!notice) return;`
3. `if (config.model_notice_ack === noticeSignature(notice)) return;`
4. Open the modal (§8). Store the displayed signature and notice on the single window instance
   (`modelUpdateWindow._sig`, `._notice`). The renderer gets **display strings only**, never ids.

### `persistConfig` — the shared save-then-reconcile primitive (Codex Important 2)

One primitive, used by the notice **and** by Settings' `save-config`. It takes a **complete**
config object (so Settings' repositories, keys, and schedule edits are preserved — a model-only
helper cannot):

```js
// Save FIRST; stop on save failure; reconcile the schedule only AFTER a successful save.
function persistConfig(config, { reconcileSchedule }) {
  const saved = saveConfigToFile(config);
  if (!saved || saved.success === false) return { ok: false, stage: 'save', error: saved && saved.error };
  if (!reconcileSchedule) return { ok: true, schedule: { ok: true, skipped: true } };
  const s = updateLaunchAgent(config);            // regenerates the plist AI_MODEL
  return { ok: true, schedule: { ok: !(!s || s.success === false), error: s && s.error } };
}
```
Contract: never reconcile the LaunchAgent when the save failed (that could point the scheduled run
at an unsaved model); ack-only actions pass `reconcileSchedule:false`; a schedule-only failure
(`ok:true, schedule.ok:false`) is non-fatal and surfaces `surfaceScheduleWarning`.

### Main-owned idempotent finalizer (Codex Important 3)

Finalization lives in **main.js**, never in the renderer — a renderer `finalized` flag cannot
guarantee a native close persists a migration before the renderer is destroyed.

```js
let _noticeFinalized = false;
function finalizeModelNotice(action) {          // action ∈ allow-list ∪ {'close'}
  if (_noticeFinalized) return;
  const win = modelUpdateWindow;
  const config = readConfig();                  // reload from disk
  const cur = computeModelNotice(config.ai_model);
  if (!cur || noticeSignature(cur) !== win._sig) { _noticeFinalized = true; win.destroy(); return; } // stale/gone: no write
  const plan = resolveNoticeAction(action, cur); // {finalModel|null, openSettings} per allow-list; null if disallowed
  if (!plan) return;                             // disallowed action: ignore, do NOT finalize
  const originalModel = config.ai_model;
  if (plan.finalModel) {
    if (!KNOWN_MODEL_IDS.has(plan.finalModel)) return; // never write an invalid id
    config.ai_model = plan.finalModel;
  }
  config.model_notice_ack = noticeSignature(computeModelNotice(config.ai_model)) || '';
  const res = persistConfig(config, { reconcileSchedule: config.ai_model !== originalModel });
  // save failed: surface a benign error (dialog/notification — NOT surfaceRuntimeError, which
  // would disable the whole runtime), keep the window open, leave the ack unchanged so the notice
  // re-shows next launch. Do NOT finalize.
  if (!res.ok) { dialog.showErrorBox('Repo Radar', `Could not save model change: ${res.error || 'unknown error'}`); return; }
  if (!res.schedule.ok) surfaceScheduleWarning(res.schedule.error);
  _noticeFinalized = true;
  win.destroy();
  if (plan.openSettings) openSettingsWindow(config.ai_model);
}
```
`resolveNoticeAction` enforces the **per-kind allow-list** and the conservative `'close'` mapping:
- `migration` → `{acknowledge, review, close}`; `acknowledge`/`review`/`close` all set
  `finalModel = effective` (durably heal the retired id); `review` also `openSettings`.
- `suggestion` → `{switch, keep, review, close}`; `switch` sets `finalModel = suggested`;
  `keep`/`review`/`close` set `finalModel = null` (ack-only, live model unchanged); `review` opens Settings.
- `compound` → `{switch, keep, review, close}`; `switch` → `finalModel = suggested`;
  `keep`/`review`/`close` → `finalModel = effective`; `review` opens Settings.
Any action not in the notice's list returns `null` (ignored, no write).

### IPC + close wiring

- Action IPC (`model-notice:action`, `{action}` only): verify `event.sender ===
  modelUpdateWindow.webContents`, then `finalizeModelNotice(action)`.
- `model-notice:get` (renderer fetches display strings): **also** verify `event.sender ===
  modelUpdateWindow.webContents` (Codex minor).
- BrowserWindow `close`: `win.on('close', (e) => { if (_noticeFinalized) return; e.preventDefault();
  finalizeModelNotice('close'); });` — the native close is *prevented*, the conservative action is
  persisted by main, and the window is destroyed only after persistence succeeds. Button IPC and
  the native close therefore share the one authoritative finalizer (race-safe, idempotent).

### Renderer isolation

`contextIsolation: true`, `nodeIntegration: false`, `preload: menubar/renderer/model-update-preload.js`.
The preload exposes via `contextBridge` exactly `getNotice()` and `sendAction(action)` — no
`require`, no arbitrary IPC.

## 8. UI — custom branded modal

`menubar/renderer/model-update.{html,js}` + `model-update-preload.js`, styled with `theme.css`.
Standard small titled window ("Repo Radar — Models") with an in-content **Close** control — **not**
frameless. The renderer merely calls `sendAction(...)`; it holds no finalize state. All
idempotency and persistence live in main (§7). Render shapes:

- **migration:** "Your model **{from}** was retired — you're now on **{effective}**."
  Buttons: **OK** (`acknowledge`) · **Review Models…** (`review`).
- **suggestion:** "A newer model in your tier is available: **{from}** → **{suggested}**."
  Buttons: **Switch** (`switch`) · **Keep {from}** (`keep`) · **Review Models…** (`review`).
- **compound:** "Your model **{from}** was retired — you're now on **{effective}**. A newer model
  in its tier is also available: **{effective}** → **{suggested}**."
  Buttons: **Switch to {suggested}** (`switch`) · **Keep {effective}** (`keep`) · **Review Models…** (`review`).

Labels are humanized via an id→label map derived from the Settings dropdown.

## 9. Sequencing (Codex point 9)

Implementation lands on **its own branch** and does not reopen the reviewed
`feature/runtime-binding-v1.0.27` branch. The canonical `menubar/` structure only reaches `dev`
when Spec 2A merges, so this design branch is cut from that structure now to capture the spec;
**implementation waits until Spec 2A merges to `dev`**, then rebases onto fresh `dev` before
writing-plans → subagent-driven implementation. Both features ship in **v1.0.27**.

## 10. Files

- **Modify** `menubar/model-policy.js` — add `MODEL_SUGGESTIONS`, `suggestUpgrade`; export both.
- **Modify** `menubar/__tests__/drift-check.js` — `MODEL_SUGGESTIONS` self-consistency (§5),
  including dropdown membership of every target.
- **Create** `menubar/model-notice.js` — pure `computeModelNotice`, `noticeSignature`, `resolveNoticeAction`, id→label helper.
- **Modify** `menubar/main.js` — `maybeShowModelNotice()` at stable startup; the `persistConfig`
  primitive (refactor the Settings `save-config` handler onto it — required, not optional, per
  Important 2); `finalizeModelNotice`; hardened `model-notice:get`/`model-notice:action` handlers;
  the modal window + `close` handler.
- **Create** `menubar/renderer/model-update.html`, `menubar/renderer/model-update.js`,
  `menubar/renderer/model-update-preload.js`.
- **Config schema:** add `model_notice_ack` (string) to `config.json`, written only by the notice paths.

## 11. Testing

- **Pure unit tests** (`menubar/model-notice.js`): `computeModelNotice` (migration / suggestion /
  compound / none / null); `noticeSignature`; `resolveNoticeAction` per kind (allow-list + `close`
  mapping + disallowed → null); `suggestUpgrade`.
- **Compound Keep → next launch (Important 1 regression):** compound `keep` persists `ai_model =
  effective` and `model_notice_ack = suggestion:effective>suggested`; a *second*
  `maybeShowModelNotice` with that config does **not** re-prompt.
- **Persistence failure (Important 2):** `saveConfigToFile` failure → `persistConfig` returns
  `{ok:false}`, `updateLaunchAgent` is **not** called, the window is **not** finalized, and
  `model_notice_ack` is unchanged (re-shows next launch).
- **Scheduled regeneration:** a switch/acknowledge/compound-keep routes through `persistConfig`
  with `reconcileSchedule:true` → `updateLaunchAgent` invoked with the new model; a pure-suggestion
  keep passes `reconcileSchedule:false`; a schedule-only failure surfaces `surfaceScheduleWarning`.
- **Migration Review persistence:** migration/compound `review` persists `ai_model = effective`
  before opening Settings (retired id healed even if Settings is closed unsaved).
- **Native-close/button race (Important 3):** a `close` and a button action resolve to a single
  finalize (idempotent `_noticeFinalized`); the native close persists via main before destroy.
- **IPC hardening:** a foreign `event.sender` is ignored on both `model-notice:action` and
  `model-notice:get`; a stale action (recomputed signature ≠ window `_sig`) writes nothing and
  closes; an out-of-allow-list action is ignored.
- **Channel guard + drift-check:** `maybeShowModelNotice` no-ops when `runtimeChannel !== 'stable'`;
  the `MODEL_SUGGESTIONS` self-consistency assertions pass (all four normative rows).

## 12. Future maintenance

`MODEL_SUGGESTIONS` gains rows as the catalog evolves; `drift-check.js` guards validity (ids known,
dropdown-listed, GA, non-migration targets, no self-maps). No open design questions remain for v1.0.27.
