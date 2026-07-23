# Post-Upgrade Model-Update Notice — Design

**Status:** approved design, pre-implementation
**Target release:** v1.0.27 (ships alongside Spec 2A runtime binding)
**Branch:** `feature/model-update-notice-v1.0.27` (cut from the canonical `menubar/` structure; see §9 Sequencing)
**Date:** 2026-07-23

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
  `repo_radar/llm.py`; `drift-check.js` enforces JS↔Python parity of `DEFAULT_MODEL`,
  `MODEL_MIGRATIONS`, and `KNOWN_MODEL_IDS`.
- `migrateModel(raw)` returns the migrated id or `raw` unchanged; it is applied in memory at every
  read of `config.ai_model` (`menubar/main.js` sync/env paths) and again in Python
  (`get_ai_model`). The retired id in `config.ai_model` is generally **not** rewritten to disk.
- Config file: `path.join(CONFIG_DIR, 'config.json')`, **shared across channels** (dev/stable).
- Channel + version signals: `runtimeChannel` (`'stable'` | `'dev'` | `null`, from
  `resolveChannel`), `IS_DEV_BUILD`, `app.getVersion()`.
- `dialog.showMessageBox` is already used in ~6 places; existing extra windows follow the
  `about` / `log-viewer` `BrowserWindow` pattern (`menubar/renderer/about.{html,js}`,
  `menubar/renderer/log-viewer.{html,js}`).

## 4. Decisions (from brainstorming)

1. **Behavior:** inform + one-click switch. Never auto-changes a live saved choice.
2. **Suggestion basis:** same tier, newer generation (respects why the user chose their tier).
3. **UI surface:** custom branded modal window (chosen over a native `dialog.showMessageBox`).
   Because this reintroduces a renderer surface, the main process re-validates every action
   (§7) — the renderer never supplies a model id.

## 5. `MODEL_SUGGESTIONS` — the new artifact (JS-only)

Add to `menubar/model-policy.js` (NOT mirrored to Python — no Python consumer):

```js
// Same-tier, newer-generation upgrade suggestions for the post-upgrade notice. UI policy only.
// Keys and values MUST be ids in KNOWN_MODEL_IDS; every value MUST be a GA model (never a
// *-preview) and MUST NOT itself be a MODEL_MIGRATIONS key. Self-checked by drift-check.js.
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

Rules (asserted by `drift-check.js`, JS-internal — no Python mirror):
- every key and value ∈ `KNOWN_MODEL_IDS`;
- every value is GA (does not end in `-preview`);
- no value is itself a `MODEL_MIGRATIONS` key (targets must be current);
- no key equals its value.

OpenAI is intentionally omitted initially (`gpt-5.5` → `gpt-5.6-{luna,terra,sol}` tiering is
ambiguous); rows are added as the catalog evolves.

## 6. Notice model (pure, main-process)

A pure function computes what, if anything, to show — from the **raw** saved id and its
**effective** (migrated) id:

```js
// returns null | { kind:'migration', from, to } | { kind:'suggestion', from, to }
function computeModelNotice(rawModel) {
  if (!rawModel) return null;                       // never configured -> already on the default
  const effective = migrateModel(rawModel);
  if (effective !== rawModel) return { kind: 'migration', from: rawModel, to: effective };
  const target = suggestUpgrade(rawModel);
  if (target) return { kind: 'suggestion', from: rawModel, to: target };
  return null;
}

// content signature — the acknowledgment is keyed to the notice CONTENT, not the app version,
// so "Keep" suppresses only THIS exact suggestion; a new suggestion/migration re-surfaces.
function noticeSignature(n) { return n ? `${n.kind}:${n.from}>${n.to}` : null; }
```

Priority: a retired model (migration) takes precedence over a suggestion. The two are mutually
exclusive per launch (migration targets are current-gen and therefore have no suggestion). If a
migration target later gains a same-tier successor, that suggestion surfaces on a *later* launch
under its own signature — no compound notices.

## 7. Trigger + main-process ownership

At stable-build startup (after runtime bootstrap, tray ready), `maybeShowModelNotice()`:

1. **Stable-only.** `if (runtimeChannel !== 'stable') return;` — a dev prerelease neither shows
   the notice nor reads/writes the ack, so it can never stamp the shared `config.json` and
   suppress the next stable notice.
2. Load `config`; `const notice = computeModelNotice(config.ai_model);` `if (!notice) return;`
3. `const sig = noticeSignature(notice); if (config.model_notice_ack === sig) return;`
4. Open the modal (§8), passing only display strings (`kind`, human labels for `from`/`to`).

Action handling (IPC `model-notice-action` with `{ action }` — **no model id from the renderer**):

- **`switch`** (suggestion only): main.js **recomputes** `computeModelNotice(config.ai_model)`,
  asserts `notice.kind === 'suggestion'`, asserts `notice.to ∈ KNOWN_MODEL_IDS`, then writes
  `config.ai_model = notice.to` via the existing save path and sets `config.model_notice_ack = sig`.
- **`keep`** (suggestion only): leave `ai_model` unchanged; set `config.model_notice_ack = sig`.
- **`acknowledge`** (migration): a retired model cannot be "kept" — persist the effective model
  (`config.ai_model = notice.to`, recomputed + validated as above), making the in-memory migration
  durable and removing the dead id from config; set `config.model_notice_ack = sig`.
- **`review`**: open the existing Settings window; set `config.model_notice_ack = sig`.

Every terminal action stamps `model_notice_ack`, so the same content never re-appears. The main
process is the sole authority on the target id; the renderer contributes only the chosen action.

## 8. UI — custom branded modal

New isolated window `menubar/renderer/model-update.{html,js}`, styled to match
`about`/`log-viewer` (shared `theme.css`). Two render shapes from the passed notice:

- **Migration:** "Your model **{from}** was retired — you're now on **{to}**." Buttons:
  **OK** (`acknowledge`) · **Review Models…** (`review`).
- **Suggestion:** "A newer model in your tier is available: **{from}** → **{to}**." Buttons:
  **Switch** (`switch`) · **Keep {from}** (`keep`) · **Review Models…** (`review`).

The window is frameless/small, centered, single-purpose; closing it via the window chrome is
treated as the conservative no-op action (`keep` for suggestion, `acknowledge` for migration —
i.e. the same ack is written so it does not reopen). Labels are humanized via a small id→label
map derived from the Settings dropdown.

## 9. Sequencing (Codex point 9)

Implementation lands on **its own branch**, and does **not** reopen the reviewed
`feature/runtime-binding-v1.0.27` branch. The canonical `menubar/` structure this design targets
only reaches `dev` when Spec 2A merges, so:

- This design branch (`feature/model-update-notice-v1.0.27`) is cut from the canonical structure
  now to capture the spec.
- **Implementation waits until Spec 2A merges to `dev`**, then this branch is rebased onto fresh
  `dev` before the writing-plans → subagent-driven implementation begins.
- Both features ship in **v1.0.27**.

## 10. Files

- **Modify** `menubar/model-policy.js` — add `MODEL_SUGGESTIONS`, `suggestUpgrade`; export both.
- **Modify** `menubar/drift-check.js` — add the JS-internal `MODEL_SUGGESTIONS` self-consistency
  assertions (§5). No Python mirror.
- **Modify** `menubar/main.js` — `computeModelNotice`/`noticeSignature` (or a small
  `menubar/model-notice.js` module), `maybeShowModelNotice()` at stable startup, the
  `model-notice-action` IPC handler with recompute+validate, and the modal window creation.
- **Create** `menubar/renderer/model-update.html`, `menubar/renderer/model-update.js`.
- **Modify** config schema usage — add `model_notice_ack` (string) to `config.json` (written only
  by the notice paths; absent by default).

## 11. Testing

- **Pure unit tests** (no Electron): `suggestUpgrade`, `computeModelNotice` (migration /
  suggestion / none / null-saved-model cases), `noticeSignature`.
- **Target validation:** a `switch`/`acknowledge` never writes a target ∉ `KNOWN_MODEL_IDS`
  (assert the recompute+validate guard rejects a tampered/stale target).
- **Ack dedup:** a matching `model_notice_ack` suppresses the notice; a different signature
  re-surfaces it.
- **Channel guard:** `maybeShowModelNotice` is a no-op when `runtimeChannel !== 'stable'`.
- **drift-check:** the `MODEL_SUGGESTIONS` self-consistency assertions (all ids known, GA targets,
  no migration-key targets, no self-maps).

## 12. Open items

- Exact initial `MODEL_SUGGESTIONS` rows are a curation call (§5 lists the clear same-tier GA
  upgrades in today's catalog); reviewed at implementation time against the live dropdown.
- Whether the migration notice should *also* fold in a suggestion when the migrated target has one
  (currently: no — handled on a later launch). Kept simple by default.
