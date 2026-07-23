# Post-Upgrade Model-Update Notice — Design

**Status:** approved design, pre-implementation
**Target release:** v1.0.27 (ships alongside Spec 2A runtime binding)
**Branch:** `feature/model-update-notice-v1.0.27` (cut from the canonical `menubar/` structure; see §9 Sequencing)
**Date:** 2026-07-23 (rev 2 — Codex design-review corrections)

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
- `MODEL_MIGRATIONS` (retired id → current) lives in `menubar/model-policy.js` and is mirrored in
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
- Channel + version signals: `runtimeChannel` (`'stable'` | `'dev'` | `null`), `IS_DEV_BUILD`,
  `app.getVersion()`. Schedule-failure surfacing exists (`surfaceScheduleWarning`, Spec 2A).
- Existing extra windows use the `about`/`log-viewer` `BrowserWindow` pattern
  (`menubar/renderer/*.{html,js}`) with `nodeIntegration:true`/`contextIsolation:false`. The
  model-update window will NOT follow that; it uses a hardened preload (§7).

## 4. Decisions (from brainstorming + Codex design review)

1. **Behavior:** inform + one-click switch. Never auto-changes a live saved choice.
2. **Suggestion basis:** same tier, newer generation.
3. **UI surface:** custom branded modal window (chosen over a native `dialog.showMessageBox`).
   The renderer sends only an *action*; the main process owns and validates every model id (§7).
4. **Compound migration+suggestion is handled in one notice** (Codex — the two are NOT mutually
   exclusive; see §6).

## 5. `MODEL_SUGGESTIONS` — the new artifact (JS-only)

Add to `menubar/model-policy.js` (NOT mirrored to Python — no Python consumer):

```js
// Same-tier, newer-generation upgrade suggestions for the post-upgrade notice. UI policy only.
const MODEL_SUGGESTIONS = {
  'claude-sonnet-4-6': 'claude-sonnet-5',
  'claude-opus-4-7': 'claude-opus-4-8',
  'gemini/gemini-2.5-flash': 'gemini/gemini-3.5-flash',
  'gemini/gemini-2.5-flash-lite': 'gemini/gemini-3.1-flash-lite',
};

function suggestUpgrade(model) {
  return (model && MODEL_SUGGESTIONS[model]) || null;
}
```

Rules, asserted by `menubar/__tests__/drift-check.js` (JS-internal — no Python mirror):
- every key and value ∈ `KNOWN_MODEL_IDS`;
- **every value is a selectable option in `menubar/renderer/settings.html`'s model dropdown**
  (not merely a `KNOWN_MODEL_IDS` id) — so a switch lands on a model the user can also see and
  re-select (Codex minor);
- every value is GA (does not end in `-preview`);
- no value is itself a `MODEL_MIGRATIONS` key (targets must be current);
- no key equals its value.

`suggestUpgrade` is always evaluated on the **effective** (post-migration) model (§6), so it
covers both live-model users and just-migrated users. OpenAI is intentionally omitted initially
(`gpt-5.5` → `gpt-5.6-{luna,terra,sol}` tiering is ambiguous); rows are added as the catalog evolves.

## 6. Notice model (pure) — compound-aware

Computed from the **raw** saved id and its **effective** (migrated) id. Migration and suggestion
are **not** mutually exclusive: several retired ids migrate onto a suggestion key (e.g.
`gemini/gemini-2.0-flash → 2.5-flash → suggested 3.5-flash`;
`gemini/gemini-2.0-flash-lite → 2.5-flash-lite → suggested 3.1-flash-lite`;
`gemini/gemini-1.5-flash → 2.5-flash → 3.5-flash`). Those produce a **compound** notice.

```js
// returns null
//   | { kind:'migration',  from, effective }              retired -> effective (no newer same-tier)
//   | { kind:'suggestion', from, effective, suggested }   live (effective===from) -> newer same-tier
//   | { kind:'compound',   from, effective, suggested }   retired -> effective AND newer same-tier
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

// content signature — captures BOTH the mandatory migration target AND any suggested target, so a
// compound notice is a single distinct content that never re-prompts on the next launch.
function noticeSignature(n) {
  if (!n) return null;
  if (n.kind === 'compound')  return `compound:${n.from}>${n.effective}>${n.suggested}`;
  if (n.kind === 'migration') return `migration:${n.from}>${n.effective}`;
  return `suggestion:${n.effective}>${n.suggested}`;
}
```

## 7. Trigger, ownership, and hardening (main process)

At **stable-build** startup (after runtime bootstrap, tray ready), `maybeShowModelNotice()`:

1. **Stable-only.** `if (runtimeChannel !== 'stable') return;` — a dev prerelease neither shows
   the notice nor reads/writes the ack, so it can't stamp the shared `config.json` and suppress
   the next stable notice.
2. Load config; `const notice = computeModelNotice(config.ai_model);` `if (!notice) return;`
3. `const sig = noticeSignature(notice); if (config.model_notice_ack === sig) return;`
4. Open the modal (§8). Store `sig` and `notice` on the single window instance
   (`modelUpdateWindow._sig`, `._notice`). The renderer is passed **display strings only** (kind +
   humanized labels), never raw ids.

### Shared save-and-reconcile helper (Codex Important 1)

All model *writes* go through one helper used by Settings too, so the scheduled-sync plist is
regenerated with the new `AI_MODEL` — never `config.json` alone:

```js
// writes ai_model (+ ack) AND regenerates the LaunchAgent; surfaces schedule failures.
function applyModelSelection(newModel, ackSig) {
  const config = readConfig();
  if (newModel) config.ai_model = newModel;      // validated by caller (below)
  config.model_notice_ack = ackSig;
  const saved = saveConfigToFile(config);        // existing path
  const sched = updateLaunchAgent(config);       // existing path — regenerates AI_MODEL in the plist
  if (!sched || sched.success === false) surfaceScheduleWarning(sched && sched.error);
  return saved;
}
```
Ack-only writes (a pure-suggestion `keep`/`review`/close, where `ai_model` is unchanged and live)
call the same helper with `newModel = null`; it still reconciles idempotently.

### Action handling (IPC `model-notice:action`, `{ action }` only — no model id from the renderer)

On every action, main.js (Codex Important 3 + 4):

1. **Sender check:** `event.sender === modelUpdateWindow.webContents`, else ignore (rejects any
   foreign renderer emitting the global event).
2. **Reload + re-bind:** re-read `config.json` from disk; `const cur = computeModelNotice(config.ai_model)`.
   If `noticeSignature(cur) !== modelUpdateWindow._sig` → **stale** (e.g. Settings changed the
   model while open): close the window, write nothing.
3. **Allow-list per kind:** `migration → {acknowledge, review}`; `suggestion → {switch, keep, review}`;
   `compound → {switch, keep, review}`. Reject anything else without writing.
4. **Apply**, then finalize (§8) — each terminal path is idempotent:
   - `switch` (suggestion/compound): target = `cur.suggested`; assert ∈ `KNOWN_MODEL_IDS` and in
     the dropdown; `applyModelSelection(cur.suggested, _sig)`.
   - `keep`: for **suggestion** (live), ack only — `applyModelSelection(null, _sig)`. For
     **compound** (retired raw), persist the migrated model — `applyModelSelection(cur.effective, _sig)`.
   - `acknowledge` (migration): a retired model can't be "kept" — persist the effective model:
     `applyModelSelection(cur.effective, _sig)`.
   - `review`: for **migration/compound**, FIRST persist the effective model
     (`applyModelSelection(cur.effective, _sig)`) — Codex Important 4: Review/close must durably
     heal the retired id — then open Settings with that model selected. For **suggestion** (live),
     ack only, then open Settings.
   - **window close** (chrome or programmatic): the conservative terminal action — `keep` for
     suggestion, else persist-effective — via the same idempotent finalize.

The target id is always recomputed and validated in main.js; the renderer only ever names an
action from the allow-list.

### Renderer isolation (Codex Important 3)

The model-update window uses a **restricted preload bridge**: `contextIsolation: true`,
`nodeIntegration: false`, `preload: menubar/renderer/model-update-preload.js`. The preload exposes
via `contextBridge` exactly: `getNotice()` (invoke → display strings) and `sendAction(action)`
(send an allow-listed action string). No `require`, no arbitrary IPC.

## 8. UI — custom branded modal

New window `menubar/renderer/model-update.{html,js}` + `model-update-preload.js`, styled with the
shared `theme.css`. Standard small titled window (title "Repo Radar — Models") with an explicit
in-content **Close** control; it is **not** frameless (Codex minor — frameless conflicted with
"close via chrome"). A single `finalize(action)` guarded by a `finalized` flag makes every path
(button, Close control, window `close` event) idempotent — one write, no double-apply.

Render shapes:
- **migration:** "Your model **{from}** was retired — you're now on **{effective}**."
  Buttons: **OK** (`acknowledge`) · **Review Models…** (`review`).
- **suggestion:** "A newer model in your tier is available: **{from}** → **{suggested}**."
  Buttons: **Switch** (`switch`) · **Keep {from}** (`keep`) · **Review Models…** (`review`).
- **compound:** "Your model **{from}** was retired — you're now on **{effective}**. A newer model
  in its tier is also available: **{effective}** → **{suggested}**." Buttons: **Switch to
  {suggested}** (`switch`) · **Keep {effective}** (`keep`) · **Review Models…** (`review`).

Labels are humanized via an id→label map derived from the Settings dropdown.

## 9. Sequencing (Codex point 9)

Implementation lands on **its own branch**, and does **not** reopen the reviewed
`feature/runtime-binding-v1.0.27` branch. The canonical `menubar/` structure this design targets
only reaches `dev` when Spec 2A merges, so:

- This design branch (`feature/model-update-notice-v1.0.27`) is cut from the canonical structure
  now to capture the spec.
- **Implementation waits until Spec 2A merges to `dev`**, then this branch rebases onto fresh
  `dev` before writing-plans → subagent-driven implementation begins.
- Both features ship in **v1.0.27**.

## 10. Files

- **Modify** `menubar/model-policy.js` — add `MODEL_SUGGESTIONS`, `suggestUpgrade`; export both.
- **Modify** `menubar/__tests__/drift-check.js` — add the `MODEL_SUGGESTIONS` self-consistency
  assertions (§5), including dropdown membership of every target. No Python mirror.
- **Create** `menubar/model-notice.js` — pure `computeModelNotice`, `noticeSignature` (+ the id→label helper).
- **Modify** `menubar/main.js` — `maybeShowModelNotice()` at stable startup; the `applyModelSelection`
  shared save-and-reconcile helper (also used to refactor the Settings `save-config` path onto it);
  the hardened `model-notice:action` / `model-notice:get` IPC handlers; the modal window creation.
- **Create** `menubar/renderer/model-update.html`, `menubar/renderer/model-update.js`,
  `menubar/renderer/model-update-preload.js`.
- **Config schema:** add `model_notice_ack` (string) to `config.json`, written only by the notice
  paths (absent by default).

## 11. Testing

- **Pure unit tests** (`menubar/model-notice.js`, no Electron): `computeModelNotice` for migration,
  suggestion, **compound (the real Gemini chains)**, none, and null-saved-model; `noticeSignature`
  for all three kinds; `suggestUpgrade`.
- **Scheduled-model regeneration:** a switch/acknowledge routes through `applyModelSelection` so the
  LaunchAgent env `AI_MODEL` is regenerated (not `config.json` alone) — assert `updateLaunchAgent`
  is invoked with the new model, and a schedule failure surfaces `surfaceScheduleWarning`.
- **Migration Review persistence:** a migration/compound `review` persists `config.ai_model =
  effective` before opening Settings (retired id is durably healed even if Settings is closed unsaved).
- **IPC hardening:** an action from a foreign `event.sender` is ignored; a stale action (recomputed
  signature ≠ the window's stored signature) writes nothing and closes; an out-of-allow-list action
  for the notice kind is rejected.
- **Ack dedup + channel guard:** a matching `model_notice_ack` suppresses the notice; a different
  signature re-surfaces it; `maybeShowModelNotice` is a no-op when `runtimeChannel !== 'stable'`.
- **drift-check:** the `MODEL_SUGGESTIONS` self-consistency assertions (all ids known + dropdown-listed,
  GA targets, no migration-key targets, no self-maps).

## 12. Open items

- Exact initial `MODEL_SUGGESTIONS` rows are a curation call (§5 lists the clear same-tier GA
  upgrades in today's catalog); reviewed at implementation time against the live dropdown.
- Whether to refactor the existing Settings `save-config` handler onto `applyModelSelection` in the
  same change (recommended — one save-and-reconcile path) or leave Settings untouched and only add
  the helper for the notice. Default: refactor, since it removes the divergence risk Codex flagged.
