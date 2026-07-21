# Spec 1 — AI Model Refresh (Repo Radar v1.0.27)

**Date:** 2026-07-20
**Repo:** `mattwallington/repo-radar` (canonical)
**Branch:** `feature/model-refresh-2026` (off `dev`, which = `main` @ 1eb9c36)
**Ship target:** **v1.0.27** (patch bump from 1.0.26), via the existing `release.sh` pipeline — signed + notarized + dual-arch (arm64 + x64), published to `mattwallington/repo-radar`, dev prerelease first.
**Status:** approved design; this is the written spec for paired review → implementation plan.

This is the first of two specs. **Spec 2 (separate, follow-up):** updater/release hardening (get-update-state pull+subscribe, dev IPC guards, inside-out signing verification, hermetic Python build, artifact↔source binding/immutability) and the Electron 32 → current upgrade. Not covered here.

---

## 1. Goal & context

Refresh Repo Radar's selectable AI models from its April-2026 baseline (default `claude-sonnet-4-6`; catalog tops out at Claude 4.6 / GPT-5.4 / Gemini 3.1) to the July-2026 current lineups, and harden the surrounding model policy (centralized provider detection, retired-model migration, a fallback-provider guard). Ship it as v1.0.27 through the existing release pipeline.

Canonical already has the hard parts the divergent local checkout lacked: a unified `call_llm()` that routes Chat Completions vs the OpenAI Responses API (`repo_radar/llm.py` `_needs_responses_api` / `call_llm`), a comprehensive `KNOWN_LIMITS`, electron-updater wired, and a signed/notarized/dual-arch `release.sh`. So this spec is a focused refresh, not a rebuild. **Python ships as source + runtime `pip install` (no PyInstaller)** — updating the litellm pin is sufficient for the Python side.

### Non-goals (Spec 2 / out of scope)
- Updater hardening, signing-verification tightening, hermetic build, artifact↔source binding.
- Electron 32 → current upgrade.
- Any change to `call_llm` / `_needs_responses_api` routing logic (it already works).

---

## 2. Model catalog

### 2.1 Hard invariants (enforced by tests — see §7)
1. **Dropdown values ⊆ KNOWN_LIMITS.**
2. **Migration targets ⊆ KNOWN_LIMITS.**
3. **Retired migration keys are disjoint from KNOWN_LIMITS** (shut-down IDs are migration keys only — never "known models" nor migration targets).
4. **Provider preserved across every migration** (`provider_for_model(old) == provider_for_model(new)`).
5. **DEFAULT_MODEL is present in both the dropdown and KNOWN_LIMITS.**

`KNOWN_LIMITS` = current, supported models (including supported-but-unlisted). The dropdown is a curated subset. `MODEL_MIGRATIONS` maps retired/shut-down IDs → current equivalents.

### 2.2 Context-window sourcing
Context windows come from **litellm 1.93.0 `get_model_info`**, **except where the vendor's own docs are authoritative** and disagree. Known override:
- **`gpt-5.3-codex` = 400000** (OpenAI docs) — litellm 1.93.0 reports 272K; use 400K and do **not** assert litellm equality for this ID.

Matt's clean litellm 1.93.0 check recognized all 14 core proposed IDs. Exact windows for any ID not enumerated below are set from litellm 1.93.0 at implementation and locked by the §7 tests.

### 2.3 Default
**`DEFAULT_MODEL = 'claude-sonnet-5'`** — preserves the existing provider + quality tier (was `claude-sonnet-4-6`). Note: **Sonnet 5 defaults to high effort**; the dev-prerelease smoke (§8) must compare latency + cost against 4.6 before the prod release.

### 2.4 Dropdown (menubar/renderer/settings.html) — curated, grouped
- **Recommended:** `claude-sonnet-5` (default), `claude-opus-4-8`, `claude-haiku-4-5`, `gemini/gemini-3.5-flash`, `gemini/gemini-3.1-flash-lite`, `gpt-5.6-terra`, `gpt-5.6-luna`
- **Anthropic (other):** `claude-fable-5`, `claude-opus-4-7`, `claude-sonnet-4-6`
- **Google (other):** `gemini/gemini-3.1-pro-preview` *(label "Preview")*, `gemini/gemini-2.5-pro`, `gemini/gemini-2.5-flash`
- **OpenAI (other):** `gpt-5.6-sol`, `gpt-5.5`, `o3`
- **Advanced / Responses API** *(with explicit cost + latency warnings in the group label / help text):* `gpt-5.3-codex`, `gpt-5.5-pro`

Notes:
- **Do not invent `gpt-5.6-pro`** — GPT-5.6 Pro is a reasoning *mode* on Sol, not a model ID. Sol/Terra/Luna use Chat Completions.
- `gpt-5.3-codex` and `gpt-5.5-pro` are Responses-API models; canonical's `call_llm`/`_needs_responses_api` already route them. They go in the Advanced group so users understand the cost/latency profile.
- Gemini 3.5 Flash and 3.1 Flash-Lite are stable; **3.1 Pro is Preview** — label it.

### 2.5 KNOWN_LIMITS (current supported set)
All dropdown IDs above, plus supported-but-unlisted current models kept for context lookups + as migration targets. Confirmed values:
- Anthropic `1000000`: `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-5`, `claude-sonnet-4-6`; `200000`: `claude-haiku-4-5`
- Gemini `1048576`: `gemini/gemini-3.5-flash`, `gemini/gemini-3.1-flash-lite`, `gemini/gemini-3.1-pro-preview`, `gemini/gemini-2.5-pro`, `gemini/gemini-2.5-flash`, `gemini/gemini-2.5-flash-lite`
- OpenAI: `gpt-5.6-sol`/`gpt-5.6-terra`/`gpt-5.6-luna` `1050000`; `o3` `200000`; **`gpt-5.3-codex` `400000` (vendor)**; `gpt-5.5`, `gpt-5.5-pro` — windows per litellm 1.93.0 at implementation.

Retired IDs currently present in canonical's `KNOWN_LIMITS` (Claude 3.x/4.x/4.5, GPT-4.x, o1, older Gemini, etc.) are **removed from KNOWN_LIMITS** and, where a sensible current equivalent exists, added as `MODEL_MIGRATIONS` keys (§2.6). IDs with no safe successor are simply dropped.

### 2.6 MODEL_MIGRATIONS (retired key → current target; provider-preserving)
Representative entries (implementation finalizes the full set against the invariants + vendor deprecation status):
- **Anthropic:** `claude-sonnet-4-6`* is *kept* (still supported) — but `claude-sonnet-4-5*`/`claude-3-7-sonnet*`/`claude-3-5-sonnet*` → `claude-sonnet-5`; `claude-opus-4-5*`/`claude-opus-4-1*`/`claude-3-opus*` → `claude-opus-4-8`; `claude-haiku`-legacy → `claude-haiku-4-5`.
- **Google:** `gemini/gemini-3-pro-preview` → `gemini/gemini-3.1-pro-preview`; `gemini/gemini-3-flash-preview` → `gemini/gemini-3.5-flash`; `gemini/gemini-2.0-flash*` → `gemini/gemini-2.5-flash`; `gemini/gemini-1.5-*` → `gemini/gemini-2.5-*` (tier-preserving).
- **OpenAI:** `gpt-4o` → `gpt-5.6-terra`; `gpt-4o-mini` → `gpt-5.6-luna`; `gpt-4.1`/`gpt-4-turbo` → `gpt-5.6-terra`; `o1*` → `o3`; superseded `gpt-5.0/5.1/5.2/5.4` (whichever are retired) → `gpt-5.6-terra` (or `-luna` for mini/nano tiers).

Every entry: key ∉ KNOWN_LIMITS, target ∈ KNOWN_LIMITS, provider preserved.

---

## 3. Centralized model policy

Eliminate the scattered, drifting provider checks and default literals. Single source of truth per language, with cross-language parity tests.

### 3.1 Python — `repo_radar/llm.py` (module level)
- `DEFAULT_MODEL` (constant), `KNOWN_LIMITS` (promote to module-level dict), `MODEL_MIGRATIONS` (dict).
- `provider_for_model(model) -> 'gemini' | 'anthropic' | 'openai' | None` — handles bare + prefixed IDs and the full o-series (`o1`/`o3`/`o4`), `codex`, `chatgpt/`, `openai/` (superset of today's `sync.py` logic).
- `migrate_model(model) -> str` — `MODEL_MIGRATIONS.get(model, model)`.
- `get_model_context_window` reads the module-level `KNOWN_LIMITS`.
- **Consumers updated to use these:** all three `repo_radar/modes/sync.py` detection clusters (`:753-758`, `:1397-1404`, `:1427-1432`) → `provider_for_model()`; `repo_radar/ui.py:35-38` help text (fix the invalid `claude-sonnet-4-6-1m` default reference) → `DEFAULT_MODEL`.

### 3.2 JavaScript — new `menubar/model-policy.js` (CommonJS)
Exports `DEFAULT_MODEL`, `MODEL_MIGRATIONS`, `providerForModel(model)`, `migrateModel(model)` — mirror of the Python policy. `require()`d by `menubar/main.js` and `menubar/renderer/settings.js` (renderer runs with nodeIntegration; verify the require path resolves, else fall back to a `<script>` include).
- `settings.js:408-414` + `:460-475` and `main.js:889-905` → `providerForModel()` (fixes the o1-only drift for o3/o4/codex/chatgpt).
- Update `settings.html:50` help text ("For GPT and o1 models" → "GPT and o-series").

### 3.3 Cross-language parity
A test asserts the JS and Python `MODEL_MIGRATIONS` and `DEFAULT_MODEL` agree key-for-key/value-for-value, and that `providerForModel`/`provider_for_model` classify an identical fixture set identically (§7).

---

## 4. Migration boundaries (every place a saved `ai_model` is read)
Today a stale `ai_model` persists in `~/.config/repo-radar/config.json` and is exported to both sync paths until the user re-Saves — then errors at call time (or Gemini-fallbacks). Fix at every boundary:
1. **Python `get_ai_model()`** — migrate the env value (`migrate_model(os.environ.get('AI_MODEL', DEFAULT_MODEL))`). This covers **existing LaunchAgent wrappers** that already export a stale `AI_MODEL`.
2. **`menubar/main.js`** — migrate before the pre-sync provider validation (`:889-905`) **and** before exporting `AI_MODEL` to the spawned sync (`:1014`) and into the regenerated LaunchAgent wrapper (`:1523-1539`), so scheduled runs get the migrated value.
3. **`menubar/renderer/settings.js`** — on load (`:83`): `select.value = migrateModel(saved)`; if the migrated value isn't an `<option>`, fall back to `DEFAULT_MODEL`. On Save: persist `migrateModel(selected)` so `config.json` self-heals.

---

## 5. Fallback-provider guard (now in scope)
`get_fallback_model()` returns the Gemini chain head for any non-Gemini model (`llm.py:39-41`; `test_llm.py:40-42` asserts this as intentional). But Settings only requires the *selected* provider's key, so a rate-limited Claude/OpenAI request can switch to Gemini **without a Gemini key** and fail. Since this spec already changes the fallback chain + provider policy:
- **Change `get_fallback_model()` to return `None` for non-Gemini models** (guard on `provider_for_model(current) != 'gemini'`), and only advance within the chain for Gemini models.
- **Update the retry tests** (`test_llm.py:40-42` and the `sync.py` retry sites `:922, :1000, :1126` behavior) to expect `None` for non-Gemini and no cross-provider switch.

`GEMINI_FALLBACK_CHAIN` is refreshed to current GA Gemini tiers (drop shut-down 2.0/preview-only where appropriate; keep separate-quota flash/pro tiers).

---

## 6. litellm pin + docs
- **`requirements.txt` and `pyproject.toml`: `litellm==1.83.4` → `litellm==1.93.0`** (exact pin, matching the repo's existing pin policy). Runtime pip install (`setup.sh`) delivers it; no binary rebuild.
- Update model references / stale wording in: **`menubar/SETUP.md`** (model table + manual install command), **`menubar/resources/setup.sh`** (stale "Gemini API key" default wording), **`README.md`** (default-model mention), **`repo_radar/ui.py`** (invalid `claude-sonnet-4-6-1m`).

---

## 7. Tests (`repo_radar/tests/` — pytest; new JS asserts)
- **`test_llm.py`** updated in lockstep with the new catalog: context-window assertions for the new IDs (using vendor 400K for `gpt-5.3-codex`, not litellm's 272K); fallback-chain assertions for the refreshed chain; **non-Gemini → `None`** (replacing the old chain-head assertion); `migrate_model` covers **every** `MODEL_MIGRATIONS` row + pass-through of a current ID.
- **Invariant tests:** dropdown ⊆ KNOWN_LIMITS; migration targets ⊆ KNOWN_LIMITS; migration keys ∩ KNOWN_LIMITS = ∅; provider preserved across every migration; DEFAULT_MODEL ∈ dropdown ∩ KNOWN_LIMITS.
- **`provider_for_model`** table test (gemini/anthropic/openai bare+prefixed, o3/o4/codex/chatgpt, unknown → None).
- **JS `menubar/__tests__/model-policy.test.js`** (plain `node` assert): `providerForModel` + `migrateModel` over the same fixtures + all migration rows.
- **Cross-language parity test** (§3.3): JS `MODEL_MIGRATIONS`/`DEFAULT_MODEL` == Python's; identical provider classification on a shared fixture set.
- litellm-recognition check (implementation/CI-local): every KNOWN_LIMITS ID resolves under litellm 1.93.0 (provider + mode), context asserted equal to KNOWN_LIMITS **except `gpt-5.3-codex`** (vendor-authoritative 400K).

---

## 8. Release flow (existing pipeline)
1. Implement on `feature/model-refresh-2026`; all tests green.
2. Merge → `dev`; run `./release.sh` on `dev` → **dev prerelease** (`-dev.<ts>`, `--prerelease`). **Smoke:** install the dev DMG, verify the dropdown renders the new groups, provider-key highlighting works for an o-series model, migration self-heals a stale `config.json`, a real sync runs on `claude-sonnet-5`, and **compare latency + cost vs `claude-sonnet-4-6`** (Sonnet 5 high-effort default).
3. Merge → `main`; run `./release.sh` on `main` → **v1.0.27** (signed, notarized, dual-arch, `latest-mac.yml` published). electron-updater delivers it to installed ≤1.0.26 apps.

Version is naturally `1.0.27` (VERSION 1.0.26 + patch). The divergent local tree's "1.0.38" is irrelevant and never distributed.

---

## 9. File-change summary
- `repo_radar/llm.py` — module-level `DEFAULT_MODEL`/`KNOWN_LIMITS`/`MODEL_MIGRATIONS`, `provider_for_model`, `migrate_model`, migrated `get_ai_model`, non-Gemini fallback guard, refreshed chain.
- `repo_radar/modes/sync.py` — 3 detection clusters → `provider_for_model`.
- `repo_radar/ui.py` — help text → `DEFAULT_MODEL` (fix invalid id).
- `menubar/model-policy.js` — **new** shared JS policy.
- `menubar/main.js` — require policy; migrate before validation/export/LaunchAgent; unify default.
- `menubar/renderer/settings.html` — new dropdown groups + help text.
- `menubar/renderer/settings.js` — require policy; migrate on load/save; provider detection.
- `requirements.txt`, `pyproject.toml` — `litellm==1.93.0`.
- `menubar/SETUP.md`, `menubar/resources/setup.sh`, `README.md` — model/wording updates.
- `repo_radar/tests/test_llm.py` (+ new invariant/provider/parity tests), `menubar/__tests__/model-policy.test.js`, cross-language drift check — **new/updated**.
