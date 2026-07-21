# Spec 1 — AI Model Refresh (Repo Radar v1.0.27)

**Date:** 2026-07-20 · **rev 3** (incorporates Codex spec reviews R1+R2)
**Repo:** `mattwallington/repo-radar` (canonical) · **Branch:** `feature/model-refresh-2026` (off `dev` = `main` @ 1eb9c36)
**Ship target:** **v1.0.27** via `release.sh` — signed + notarized + dual-arch (arm64+x64), published to `mattwallington/repo-radar`, dev prerelease first.

First of two specs. **Spec 2 (separate):** updater/release hardening + Electron 32→current. Not covered here.

---

## 0. Two cutoffs (rev 3)
- **New-model *addition* cutoff — frozen:** only models mapped by **litellm 1.93.0** as of 2026-07-20 may be *added*. Google's 2026-07-21 `gemini-3.6-flash` / `gemini-3.5-flash-lite` (unmapped by 1.93.0) are **deferred** to a follow-up.
- **Shutdown *safety* cutoff — current at release:** a model that has *become unavailable* by the actual release date must be a migration key, not a KNOWN_LIMITS entry. A **release gate** (§8) queries the vendor deprecation pages at build time and **fails the release** if any KNOWN_LIMITS ID is no longer callable — forcing a spec/code amendment rather than a call-time failure. Vendor lifecycle changes require an amendment, never silent implementation-time discretion.

---

## 1. Goal & context
Refresh Repo Radar's selectable AI models from its April-2026 baseline (default `claude-sonnet-4-6`; catalog tops at Claude 4.6 / GPT-5.4 / Gemini 3.1) to current, and harden the surrounding policy: centralized provider detection, retired-model migration (unavailable IDs only), non-Gemini fallback guard. Canonical already has unified `call_llm()` routing (Chat vs Responses API), electron-updater, and a signed/notarized/dual-arch `release.sh`. **Python ships as source + runtime `pip` (no PyInstaller).**

**Non-goals (Spec 2):** updater/build hardening, Electron upgrade; no change to `call_llm`/`_needs_responses_api`.

---

## 2. Model catalog

### 2.1 Hard invariants (enforced by tests §7 + release gate §8)
1. Dropdown values ⊆ KNOWN_LIMITS.
2. Migration targets ⊆ KNOWN_LIMITS.
3. Migration keys ∩ KNOWN_LIMITS = ∅.
4. Provider preserved across every migration.
5. DEFAULT_MODEL ∈ dropdown ∩ KNOWN_LIMITS.
6. Every KNOWN_LIMITS ID is (a) recognized by litellm 1.93.0 (provider+mode) and (b) **still callable at release** (§8 gate). Context == litellm's, **except `gpt-5.3-codex`** = 400000 (vendor over litellm's 272K).

**Migration policy = unavailable-only, deterministic.** `MODEL_MIGRATIONS` keys are *exactly* the enumerated IDs in §2.5 (models whose vendor shutdown date is ≤ release date). Still-callable models — even if superseded (Opus 4.5, Sonnet 4.5, Opus 4.1, `gpt-4o`, `gpt-4.1`, `o3`, `gpt-5.4`, `gemini-2.5-*`, `gemini-3-flash-preview`, …) — are **never** migration keys; they remain in KNOWN_LIMITS so a saved value is preserved, never proactively rewritten.

### 2.2 Default + grandfathering (explicit)
`DEFAULT_MODEL = 'claude-sonnet-5'`. **Only new/empty configs get Sonnet 5.** A saved `claude-sonnet-4-6` (old default) **stays on 4.6** — still callable, in KNOWN_LIMITS, not a migration key. Sonnet 5 defaults to **high effort** → dev smoke (§8) compares latency+cost vs 4.6.

### 2.3 Dropdown (18 IDs) — grouped in `settings.html`
- **Recommended (7):** `claude-sonnet-5` (default), `claude-opus-4-8`, `claude-haiku-4-5`, `gemini/gemini-3.5-flash`, `gemini/gemini-3.1-flash-lite`, `gpt-5.6-terra`, `gpt-5.6-luna`
- **Anthropic other (3):** `claude-fable-5`, `claude-opus-4-7`, `claude-sonnet-4-6`
- **Google other (3):** `gemini/gemini-3.1-pro-preview` *(Preview)*, `gemini/gemini-2.5-pro`, `gemini/gemini-2.5-flash`
- **OpenAI other (3):** `gpt-5.6-sol`, `gpt-5.5`, `o3`
- **Advanced / Responses API (2)** *(cost+latency warning):* `gpt-5.3-codex`, `gpt-5.5-pro`

No invented `gpt-5.6-pro` (it's a Sol reasoning mode). Sol/Terra/Luna = Chat Completions; `gpt-5.3-codex`+`gpt-5.5-pro` = Responses (canonical's `call_llm` routes them).

### 2.4 KNOWN_LIMITS — deterministic union (rev 3)
**KNOWN_LIMITS = (canonical's current `repo_radar/llm.py` KNOWN_LIMITS set) − (the §2.5 migration keys) + (the new IDs below).** This makes it the exact union of {new models} ∪ {still-callable historically-shipped values} ∪ {migration targets}, so any model selectable in a shipped version that is still callable is preserved (satisfies invariant + §4 preservation). No "optional" entries.

- **New IDs added** (all litellm-1.93.0-recognized): Anthropic `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-sonnet-5` (all `1000000`); OpenAI `gpt-5.6-sol`/`gpt-5.6-terra`/`gpt-5.6-luna`/`gpt-5.5`/`gpt-5.5-pro` (all `1050000`); Gemini `gemini/gemini-3.5-flash`, `gemini/gemini-3.1-flash-lite` (`1048576`).
- **Retained from canonical** (still callable — NOT removed): `claude-opus-4-6`(+dated), `claude-sonnet-4-6`, `claude-opus-4-5`(+dated), `claude-sonnet-4-5`(+dated), `claude-haiku-4-5`(+dated), `claude-opus-4-1`(+dated, active through Aug 5 2026); `gemini/gemini-3.1-pro-preview`, `gemini/gemini-3-flash-preview` (no shutdown date), `gemini/gemini-2.5-pro`/`-flash`/`-flash-lite`, the `gemini-*-latest` aliases; OpenAI `gpt-5.4`(+pro/mini/nano), `gpt-5.3-codex`, `gpt-5.1`, `gpt-5`(+mini/nano), `gpt-4.1`(+mini/nano), `gpt-4o`(+mini), `gpt-4-turbo` (active through Oct 2026), `o4-mini`, `o3`(+mini/pro), `o1`(+pro). **Removed** (→ §2.5 migration keys): `codex-mini-latest` (retired Feb 2026) and the pre-5.3 codex variants `gpt-5-codex`/`gpt-5.1-codex`/`-max`/`-mini`/`gpt-5.2-codex` (shut down 2026-07-23).
- **Context values:** litellm 1.93.0's value for every ID, except `gpt-5.3-codex` = 400000. The §7 litellm matrix runs over the **full** resulting set; the §8 gate re-checks callability at release.

### 2.5 MODEL_MIGRATIONS — literal, deterministic (unavailable-only; **provider preserved** per invariant 4; same-tier target where one exists, documented exceptions)
**Anthropic:** `claude-3-7-sonnet-20250219`, `claude-3-5-sonnet-20241022`, `claude-3-5-sonnet-20240620`, `claude-3-sonnet-20240229` → `claude-sonnet-5`; `claude-3-5-haiku-20241022`, `claude-3-haiku-20240307` → `claude-haiku-4-5`; `claude-3-opus-20240229`, `claude-opus-4-20250514`, `claude-4-opus-20250514` → `claude-opus-4-8`; `claude-sonnet-4-20250514`, `claude-4-sonnet-20250514` → `claude-sonnet-5`.
**OpenAI:**
- `o1-preview`, `o1-mini` → `o3`.
- **`codex-mini-latest` → `gpt-5.4-mini`** — retired 2026-02-12 (mini tier preserved).
- **Codex IDs shutting down 2026-07-23** — `gpt-5-codex`, `gpt-5.1-codex`, `gpt-5.1-codex-max`, `gpt-5.2-codex` → **`gpt-5.3-codex`**; `gpt-5.1-codex-mini` → **`gpt-5.4-mini`** (mini tier; mapping the mini variant to `gpt-5.3-codex` would raise litellm cost ~7×). **v1.0.27's target release date is ≥ 2026-07-23, so these five are migration keys and are removed from KNOWN_LIMITS.** *Documented deviation:* OpenAI's own recommended successor for the four full codex IDs is `gpt-5.5`; Repo Radar deliberately keeps codex users on the current codex model (`gpt-5.3-codex`) instead — an app-specific choice. All mappings preserve provider (OpenAI).
**Google:** `gemini/gemini-2.0-flash`, `gemini/gemini-2.0-flash-001`, `gemini/gemini-2.0-flash-exp` → `gemini/gemini-2.5-flash`; `gemini/gemini-2.0-flash-lite` → `gemini/gemini-2.5-flash-lite`; `gemini/gemini-3-pro-preview` → `gemini/gemini-3.1-pro-preview`; `gemini/gemini-3.1-flash-lite-preview` → `gemini/gemini-3.1-flash-lite`; `gemini/gemini-1.5-pro` → `gemini/gemini-2.5-pro`; `gemini/gemini-1.5-flash` → `gemini/gemini-2.5-flash`.

This map is fixed at approval. The §8 gate enforces that these keys are unavailable and every KNOWN_LIMITS ID is available; any drift **fails the release** and requires a spec amendment.

---

## 3. Centralized model policy
### 3.1 Python — `repo_radar/llm.py` (module level)
`DEFAULT_MODEL`, `KNOWN_LIMITS`, `MODEL_MIGRATIONS`, `provider_for_model(model)`, `migrate_model(model)`. `provider_for_model` handles bare + prefixed IDs, o-series (`o1`/`o3`/`o4`), `codex`, `openai/`, `chatgpt/` **and** `chatgpt-`. Consumers: `sync.py` `:753-758`/`:1397-1404`/`:1427-1432` + `ui.py:35-38` (fix invalid `claude-sonnet-4-6-1m`).

### 3.2 JavaScript — new `menubar/model-policy.js` (CommonJS; committed)
Exports `DEFAULT_MODEL`, `MODEL_MIGRATIONS`, **`KNOWN_MODEL_IDS`** (a Set mirroring Python's KNOWN_LIMITS keys, covered by the drift test), `providerForModel`, `migrateModel`. Require paths (rev 3, corrected):
- `menubar/main.js` → `require('./model-policy')`
- `menubar/renderer/settings.js` → `require('../model-policy')`
Replaces `settings.js:408-414`/`:460-475` + `main.js:889-905`; fixes `settings.html:50` help text. `providerForModel` handles `chatgpt-`+`chatgpt/`.

### 3.3 Cross-language parity/drift test: JS `MODEL_MIGRATIONS`/`DEFAULT_MODEL`/`KNOWN_MODEL_IDS` == Python's; identical provider classification on a shared fixture.

---

## 4. Migration boundaries + healing (rev 3)
Migration runs at **runtime everywhere** (a stale/retired ID never reaches litellm); `config.json` is persisted **only on Settings Save**; smoke includes Save.
1. **Python `get_ai_model()`** — `migrate_model(env AI_MODEL or DEFAULT_MODEL)` (covers LaunchAgent wrappers).
2. **`main.js`** — `migrateModel` before pre-sync validation (`:889-905`), before `AI_MODEL` export (`:1014`), and into the regenerated LaunchAgent wrapper (`:1523-1539`).
3. **`settings.js`** — on load (`:83`): `m = migrateModel(saved)`. If `m` ∈ dropdown → select it. **Else if `m` ∈ `KNOWN_MODEL_IDS` (valid-but-unlisted) → dynamically insert a clearly-labelled `<option>` ("Saved model — still supported") with value `m` and select it**, so a later Save persists `m` (an unlisted value assigned to a `<select>` otherwise selects nothing — this insertion is required). Else → `DEFAULT_MODEL`. On Save: persist `migrateModel(selected)`.

---

## 5. Non-Gemini fallback guard + exact chain
Change `get_fallback_model()` to return `None` when `provider_for_model(current) != 'gemini'` (was returning the Gemini chain head — `test_llm.py:40-42`). Update that test (non-Gemini → `None`); the three retry sites (`sync.py:922/1000/1126`) then simply retry the selected model (Codex-verified: no loop, no cross-provider switch).
**Exact `GEMINI_FALLBACK_CHAIN`** (active + litellm-1.93.0-mapped, newest→oldest, separate quotas):
```
gemini/gemini-3.5-flash
gemini/gemini-3.1-flash-lite
gemini/gemini-2.5-flash
gemini/gemini-2.5-flash-lite
```

---

## 6. litellm pin + Python floor + docs (rev 3)
- `requirements.txt` + `pyproject.toml`: `litellm==1.83.4` → **`litellm==1.93.0`**.
- litellm 1.93.0 requires **Python ≥3.10,<3.15** → set `requires-python = ">=3.10,<3.15"`; add a **numeric guard in `menubar/resources/setup.sh` checking both bounds** (fail clearly on <3.10 or ≥3.15); install via **`python3 -m pip`**. Test setup in a clean 3.10 env.
- Update: `menubar/SETUP.md` (model table + manual install), `menubar/resources/setup.sh` (stale "Gemini API key" wording), `README.md`, `repo_radar/ui.py`, **`CHANGELOG.md`** (AGENTS.md requires an entry for dev + prod releases; `release.sh` stages only version files, so CHANGELOG is a manual edit committed with the feature work).

---

## 7. Tests (`repo_radar/tests/` pytest; JS node-assert)
- `test_llm.py`: window assertions over the **full** KNOWN_LIMITS union (vendor 400K for `gpt-5.3-codex`); exact fallback chain (§5); non-Gemini → `None`; `migrate_model` covers **every** row + pass-through of a current ID.
- **Invariant tests** (§2.1 1–6), incl. the litellm-1.93.0 matrix over the full KNOWN_LIMITS (provider+mode; context == litellm except `gpt-5.3-codex`).
- `provider_for_model` table (all providers, o3/o4/codex, `chatgpt-`+`chatgpt/`, unknown→None).
- JS `menubar/__tests__/model-policy.test.js` + cross-language drift (`MODEL_MIGRATIONS`/`DEFAULT_MODEL`/`KNOWN_MODEL_IDS`).

---

## 8. Release flow + shutdown gate (rev 3)
**Shutdown gate** (new) — no live scraping. A **checked-in lifecycle manifest** (`repo_radar/model_lifecycle.json`) records, for every KNOWN_LIMITS ID and every `MODEL_MIGRATIONS` key: `{id, status, shutdown_date | null, source_url}`. The automated gate (a pytest run by `release.sh` preflight) takes an explicit **`TARGET_RELEASE_DATE`** and **fails the release** if (a) any KNOWN_LIMITS ID has a `shutdown_date ≤ TARGET_RELEASE_DATE`, or (b) any migration key has `shutdown_date > TARGET_RELEASE_DATE` or is missing/marked active. Before each release the operator **manually re-verifies the linked vendor pages** and, on any vendor drift, commits a manifest amendment (and any resulting KNOWN_LIMITS/MODEL_MIGRATIONS change) — release stays blocked until the manifest and maps agree. Live vendor availability is never trusted at build time; the manifest + human re-verification is the source of truth.

**Versioning flow** (dev release bumps `VERSION`→`1.0.27-dev.<ts>`; `release.sh:133` strips + increments, so merging the *dev release commit* to main yields 1.0.28):
1. Implement on `feature/model-refresh-2026`; tests + shutdown gate green; update `CHANGELOG.md`.
2. Merge feature → `dev`; `./release.sh` on `dev` → `1.0.27-dev.<ts>` prerelease. **Smoke:** dev DMG installs; dropdown groups render; o-series provider-key highlight works; migration self-heals a stale `config.json` (open Settings → Save; verify a valid-but-unlisted saved value is preserved, not reset); real sync on `claude-sonnet-5`; **latency+cost vs `claude-sonnet-4-6`**.
3. Merge the **feature changes — not the dev release commit** — into `main` (VERSION stays `1.0.26`).
4. `./release.sh` on `main` → **v1.0.27** (signed, notarized, dual-arch, `latest-mac.yml` published).
5. **Reconcile `main` → `dev`**, resolving the `VERSION` / `menubar/package.json` / `menubar/package-lock.json` conflicts **to main's stable `1.0.27` values**.

---

## 9. File-change summary
`repo_radar/llm.py` (module-level policy incl. `KNOWN_LIMITS` union + `provider_for_model`/`migrate_model` + migrated `get_ai_model` + non-Gemini guard + exact chain) · `repo_radar/modes/sync.py` (3 clusters → `provider_for_model`) · `repo_radar/ui.py` · **new** `menubar/model-policy.js` (incl. `KNOWN_MODEL_IDS`) · `menubar/main.js` (`require('./model-policy')`; migrate all boundaries; unify default) · `menubar/renderer/settings.html` (18-ID grouped dropdown + Advanced warnings + help) · `menubar/renderer/settings.js` (`require('../model-policy')`; migrate load/save with valid-but-unlisted `<option>` insertion; provider detection) · `requirements.txt` + `pyproject.toml` (`litellm==1.93.0`, `requires-python>=3.10,<3.15`) · `menubar/resources/setup.sh` (both-bounds guard, `python3 -m pip`, wording) · `menubar/SETUP.md` · `README.md` · **`CHANGELOG.md`** · **new** `repo_radar/model_lifecycle.json` (lifecycle manifest) · `release.sh` (invoke the manifest shutdown gate) · `repo_radar/tests/test_llm.py` (+ invariant/provider tests) · **new** `repo_radar/tests/test_lifecycle_gate.py` (manifest vs TARGET_RELEASE_DATE) · **new** `menubar/__tests__/model-policy.test.js` + drift check.
