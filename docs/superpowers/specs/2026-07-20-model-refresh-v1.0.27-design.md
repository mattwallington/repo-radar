# Spec 1 — AI Model Refresh (Repo Radar v1.0.27)

**Date:** 2026-07-20 · **rev 2** (incorporates Codex spec review)
**Repo:** `mattwallington/repo-radar` (canonical) · **Branch:** `feature/model-refresh-2026` (off `dev` = `main` @ 1eb9c36)
**Ship target:** **v1.0.27** via `release.sh` — signed + notarized + dual-arch (arm64+x64), published to `mattwallington/repo-radar`, dev prerelease first.

First of two specs. **Spec 2 (separate):** updater/release hardening + Electron 32→current upgrade. Not covered here.

---

## 0. Compatibility cutoff (rev 2)
This release targets the **litellm 1.93.0-mapped catalog as of 2026-07-20**. Google shipped `gemini-3.6-flash` and `gemini-3.5-flash-lite` on 2026-07-21; litellm 1.93.0 does **not** map them, so they are **explicitly deferred** to a follow-up release (added once a litellm release maps them). Every ID this spec ships is recognized by litellm 1.93.0. This keeps the litellm-recognition invariant intact.

---

## 1. Goal & context
Refresh Repo Radar's selectable AI models from its April-2026 baseline (default `claude-sonnet-4-6`; catalog tops at Claude 4.6 / GPT-5.4 / Gemini 3.1) to current, and harden the surrounding policy: centralized provider detection, retired-model migration (unavailable IDs only), and a non-Gemini fallback guard.

Canonical already has unified `call_llm()` routing (Chat Completions vs Responses API), electron-updater, and a signed/notarized/dual-arch `release.sh`. **Python ships as source + runtime `pip install` (no PyInstaller)** — updating the litellm pin (and the Python floor, §6) is sufficient for the Python side.

**Non-goals (Spec 2):** updater hardening, signing-verification tightening, hermetic build, artifact↔source binding, Electron upgrade; no change to `call_llm`/`_needs_responses_api` routing.

---

## 2. Model catalog

### 2.1 Hard invariants (enforced by tests, §7)
1. Dropdown values ⊆ KNOWN_LIMITS.
2. Migration targets ⊆ KNOWN_LIMITS.
3. Migration keys ∩ KNOWN_LIMITS = ∅ (keys are **unavailable** models only).
4. Provider preserved across every migration (`provider_for_model(old) == provider_for_model(new)`).
5. DEFAULT_MODEL ∈ dropdown ∩ KNOWN_LIMITS.
6. Every KNOWN_LIMITS ID is recognized by litellm 1.93.0 (provider + mode), and its context equals litellm's — **except `gpt-5.3-codex`** (vendor-authoritative 400K; litellm reports 272K).

**Migration policy = "unavailable-only."** `MODEL_MIGRATIONS` keys are exclusively models whose vendor shutdown date has passed (would 404), verified as of the 2026-07-20 cutoff. Active-but-superseded models (e.g. Opus 4.5, Sonnet 4.5, `gpt-4o`, `gpt-4.1`, `o3`, `gpt-5.4`, `gemini-2.5-*`, `gemini-3-flash-preview`) are **not** migrated; they remain callable and stay in KNOWN_LIMITS (supported-but-unlisted). We do not proactively rewrite a user's choice of a still-valid model.

### 2.2 Default (rev 2 — explicit)
`DEFAULT_MODEL = 'claude-sonnet-5'`. **Only new/empty configurations receive Sonnet 5.** Existing users with a saved `claude-sonnet-4-6` (the old default) **stay on 4.6** — it's still active and is retained in KNOWN_LIMITS; it is not a migration key, so it is not rewritten. Sonnet 5 defaults to **high effort**; the dev-prerelease smoke (§8) must compare latency + cost vs 4.6 before the prod release.

### 2.3 Dropdown (18 IDs) — `menubar/renderer/settings.html`, grouped
- **Recommended (7):** `claude-sonnet-5` (default), `claude-opus-4-8`, `claude-haiku-4-5`, `gemini/gemini-3.5-flash`, `gemini/gemini-3.1-flash-lite`, `gpt-5.6-terra`, `gpt-5.6-luna`
- **Anthropic (other, 3):** `claude-fable-5`, `claude-opus-4-7`, `claude-sonnet-4-6`
- **Google (other, 3):** `gemini/gemini-3.1-pro-preview` *(label "Preview")*, `gemini/gemini-2.5-pro`, `gemini/gemini-2.5-flash`
- **OpenAI (other, 3):** `gpt-5.6-sol`, `gpt-5.5`, `o3`
- **Advanced / Responses API (2)** *(explicit cost + latency warning in the group label/help):* `gpt-5.3-codex`, `gpt-5.5-pro`

Notes: no invented `gpt-5.6-pro` (Pro is a reasoning *mode* on Sol, not an ID; Sol/Terra/Luna are Chat Completions). `gpt-5.3-codex` + `gpt-5.5-pro` route via the Responses API (canonical's `call_llm` already handles them). 3.5 Flash + 3.1 Flash-Lite are stable; 3.1 Pro is Preview.

### 2.4 KNOWN_LIMITS (19 IDs — dropdown + supported-but-unlisted; all litellm-1.93.0-verified)
Windows (verified by Codex under litellm 1.93.0 except the codex override):
- **Anthropic `1000000`:** `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-sonnet-5`, `claude-sonnet-4-6`; **`200000`:** `claude-haiku-4-5`
- **Gemini `1048576`:** `gemini/gemini-3.5-flash`, `gemini/gemini-3.1-flash-lite`, `gemini/gemini-3.1-pro-preview`, `gemini/gemini-2.5-pro`, `gemini/gemini-2.5-flash`, `gemini/gemini-2.5-flash-lite`
- **OpenAI:** `gpt-5.6-sol`/`gpt-5.6-terra`/`gpt-5.6-luna`/`gpt-5.5`/`gpt-5.5-pro` **`1050000`**; `o3` `200000`; **`gpt-5.3-codex` `400000` (vendor override)**

(`gemini/gemini-2.5-flash-lite` is unlisted but kept for the fallback chain + as a migration target. `claude-opus-4-6` may be retained as unlisted if desired; not required.)

### 2.5 MODEL_MIGRATIONS (literal; keys = confirmed-shutdown as of 2026-07-20; targets ∈ KNOWN_LIMITS; provider preserved)
**Anthropic (retired → current):**
- `claude-3-7-sonnet-20250219`, `claude-3-5-sonnet-20241022`, `claude-3-5-sonnet-20240620`, `claude-3-sonnet-20240229` → `claude-sonnet-5`
- `claude-3-5-haiku-20241022`, `claude-3-haiku-20240307` → `claude-haiku-4-5`
- `claude-3-opus-20240229` → `claude-opus-4-8`
- `claude-opus-4-20250514`, `claude-4-opus-20250514` → `claude-opus-4-8`
- `claude-sonnet-4-20250514`, `claude-4-sonnet-20250514` → `claude-sonnet-5`

**OpenAI (retired → current):**
- `o1-preview`, `o1-mini` → `o3`

**Google (retired → current, tier-preserving):**
- `gemini/gemini-2.0-flash`, `gemini/gemini-2.0-flash-001` → `gemini/gemini-2.5-flash`
- `gemini/gemini-2.0-flash-lite` → `gemini/gemini-2.5-flash-lite`
- `gemini/gemini-3-pro-preview` → `gemini/gemini-3.1-pro-preview`
- `gemini/gemini-3.1-flash-lite-preview` → `gemini/gemini-3.1-flash-lite`
- `gemini/gemini-1.5-pro` → `gemini/gemini-2.5-pro`
- `gemini/gemini-1.5-flash` → `gemini/gemini-2.5-flash`

Implementation re-verifies each key's shutdown status against the vendor deprecation pages at build time; any key whose model is still active is dropped from the map (kept in KNOWN_LIMITS instead). `gemini/gemini-3-flash-preview` is **active** (no shutdown date) → **not** migrated; retained in KNOWN_LIMITS if still offered, else simply removed from the dropdown.

---

## 3. Centralized model policy
### 3.1 Python — `repo_radar/llm.py` (module level)
`DEFAULT_MODEL`, `KNOWN_LIMITS`, `MODEL_MIGRATIONS`, `provider_for_model(model)`, `migrate_model(model)`. `provider_for_model` handles bare + prefixed IDs, the full o-series (`o1`/`o3`/`o4`), `codex`, `openai/`, and **both `chatgpt/` and `chatgpt-`**. Consumers: all three `sync.py` clusters (`:753-758`,`:1397-1404`,`:1427-1432`) + `ui.py:35-38` (fix invalid `claude-sonnet-4-6-1m`).

### 3.2 JavaScript — new `menubar/model-policy.js` (**CommonJS**, committed — no `<script>` fallback)
Exports `DEFAULT_MODEL`, `MODEL_MIGRATIONS`, `providerForModel`, `migrateModel`; `require('../model-policy')` from `main.js` and `renderer/settings.js` (valid under this renderer/nodeIntegration + packaging config). `providerForModel` handles `chatgpt-` and `chatgpt/`. Replaces `settings.js:408-414`,`:460-475` and `main.js:889-905`; fix `settings.html:50` help text.

### 3.3 Cross-language parity test: JS `MODEL_MIGRATIONS`/`DEFAULT_MODEL` == Python's; identical provider classification on a shared fixture set.

---

## 4. Migration boundaries + healing semantics (rev 2)
**Healing model:** migration is applied at **runtime everywhere** (so a stale/retired saved ID never reaches litellm), and the persisted `config.json` value is **rewritten only on Settings Save** (not on app open or sync). The dev smoke (§8) must include opening Settings and clicking Save to exercise persistence.
1. **Python `get_ai_model()`** — `migrate_model(env AI_MODEL or DEFAULT_MODEL)`; covers existing LaunchAgent wrappers exporting a stale value.
2. **`menubar/main.js`** — `migrateModel` before pre-sync validation (`:889-905`), before exporting `AI_MODEL` to the spawned sync (`:1014`), and into the regenerated LaunchAgent wrapper (`:1523-1539`).
3. **`settings.js`** — on load (`:83`): `m = migrateModel(saved)`; if `m` ∈ dropdown → select it; else if `m` ∈ KNOWN_LIMITS (valid-but-unlisted) → **preserve** it (don't reset to default); else → `DEFAULT_MODEL`. On Save: persist `migrateModel(selected)`.

---

## 5. Non-Gemini fallback guard (in scope) + exact chain
`get_fallback_model()` returns the Gemini chain head for any non-Gemini model (`llm.py:39-41`, asserted in `test_llm.py:40-42`), so a rate-limited Claude/OpenAI request can switch to Gemini without a Gemini key. **Change it to return `None` when `provider_for_model(current) != 'gemini'`**; only advance within the chain for Gemini. Update `test_llm.py:40-42` (non-Gemini → `None`) and confirm the three retry sites (`sync.py:922/1000/1126`) — Codex verified `None` simply retries the selected model (no loop, no cross-provider switch).

**Exact `GEMINI_FALLBACK_CHAIN` (rev 2; all active + litellm-1.93.0-mapped, newest→oldest, separate quotas):**
```
gemini/gemini-3.5-flash
gemini/gemini-3.1-flash-lite
gemini/gemini-2.5-flash
gemini/gemini-2.5-flash-lite
```
(Drops the retired `gemini-3-pro-preview` / `gemini-2.0-flash` currently in the chain. The Preview `3.1-pro` is offered in the dropdown but intentionally not in the fallback chain.)

---

## 6. litellm pin + Python floor + docs (rev 2)
- **`requirements.txt` + `pyproject.toml`: `litellm==1.83.4` → `litellm==1.93.0`.**
- **litellm 1.93.0 requires Python ≥3.10,<3.15.** Repo Radar currently declares `>=3.8` (`pyproject.toml:11`) and `setup.sh:39` only checks `python3` exists (permits 3.8). **Raise the floor to 3.10:** set `requires-python = ">=3.10"`, add a **numeric version guard** in `menubar/resources/setup.sh` (fail with a clear message on <3.10), and install via **`python3 -m pip`**. Test setup in a clean Python 3.10 env.
- Update model refs / stale wording: `menubar/SETUP.md` (model table + manual install command), `menubar/resources/setup.sh` (stale "Gemini API key" default), `README.md`, `repo_radar/ui.py`, and **`CHANGELOG.md`** (AGENTS.md requires a CHANGELOG entry for both dev and prod releases; `release.sh` stages only version files, so this is a manual edit committed with the feature work).

---

## 7. Tests (`repo_radar/tests/` pytest; JS node-assert)
- `test_llm.py`: window assertions for the 19-ID matrix (vendor 400K for `gpt-5.3-codex`); refreshed fallback chain (exact IDs, §5); **non-Gemini → `None`**; `migrate_model` covers **every** row + pass-through of a current ID.
- **Invariant tests** (§2.1 all six), incl. "every KNOWN_LIMITS ID recognized by litellm 1.93.0, context == KNOWN_LIMITS except `gpt-5.3-codex`."
- `provider_for_model` table (gemini/anthropic/openai bare+prefixed, o3/o4/codex, `chatgpt-`+`chatgpt/`, unknown→None).
- JS `menubar/__tests__/model-policy.test.js` (`providerForModel` + all `migrateModel` rows) + cross-language parity/drift check (§3.3).

---

## 8. Release flow (rev 2 — corrected versioning)
A dev release rewrites `VERSION` to `1.0.27-dev.<ts>`; `release.sh:133` strips the suffix and increments patch, so merging the *dev release commit* into main would yield **1.0.28**. Correct flow:
1. Implement on `feature/model-refresh-2026`; all tests green; **update `CHANGELOG.md`**.
2. Merge feature → `dev`; `./release.sh` on `dev` → **`1.0.27-dev.<ts>`** prerelease. **Smoke:** install dev DMG; dropdown groups render; provider-key highlight works for an o-series model; migration self-heals a stale `config.json` (open Settings → Save); a real sync runs on `claude-sonnet-5`; **compare latency + cost vs `claude-sonnet-4-6`**.
3. Merge the **feature changes — not the dev release commit** — into `main` (VERSION stays `1.0.26`).
4. `./release.sh` on `main` → **v1.0.27** (signed, notarized, dual-arch, `latest-mac.yml` published).
5. **Reconcile `main` back into `dev`.**

---

## 9. File-change summary
`repo_radar/llm.py` (module-level policy + `provider_for_model`/`migrate_model` + migrated `get_ai_model` + non-Gemini fallback guard + exact chain) · `repo_radar/modes/sync.py` (3 clusters → `provider_for_model`) · `repo_radar/ui.py` (fix invalid default) · **new** `menubar/model-policy.js` · `menubar/main.js` (require policy; migrate at all boundaries; unify default) · `menubar/renderer/settings.html` (18-ID grouped dropdown + Advanced warnings + help text) · `menubar/renderer/settings.js` (require policy; migrate load/save with valid-but-unlisted preservation; provider detection) · `requirements.txt` + `pyproject.toml` (`litellm==1.93.0`, `requires-python>=3.10`) · `menubar/resources/setup.sh` (numeric 3.10 guard, `python3 -m pip`, wording) · `menubar/SETUP.md` · `README.md` · **`CHANGELOG.md`** · `repo_radar/tests/test_llm.py` (+ invariant/provider tests) · **new** `menubar/__tests__/model-policy.test.js` + cross-language drift check.
