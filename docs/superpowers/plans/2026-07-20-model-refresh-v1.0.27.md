# Repo Radar — AI Model Refresh v1.0.27 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh Repo Radar's selectable AI models to the current (July-2026) lineups with centralized model policy, unavailable-only migration, and a non-Gemini fallback guard, shipped as v1.0.27.

**Architecture:** A single source-of-truth model policy per language (Python module-level in `repo_radar/llm.py`; a new `menubar/model-policy.js` for the Electron side), a checked-in lifecycle manifest + stdlib release gate, and migration applied at every boundary a saved `ai_model` is read. Canonical already routes Chat-Completions vs Responses API and has a signed/notarized/dual-arch `release.sh`; Python ships as source + runtime pip.

**Tech Stack:** Python 3.10+ (litellm 1.93.0, pytest for dev tests, stdlib for the release gate), Node/Electron 32 (CommonJS, `node --test`/plain assert), electron-builder + `release.sh`.

**Spec:** `docs/superpowers/plans/../specs/2026-07-20-model-refresh-v1.0.27-design.md` (rev 4). Read it before starting.

## Global Constraints
- **Python floor:** `requires-python = ">=3.10,<3.15"` (litellm 1.93.0 requirement). Install via `python3 -m pip`.
- **litellm:** exactly `litellm==1.93.0` in `requirements.txt` and `pyproject.toml`.
- **App identity is fixed:** `appId = com.mattwallington.repo-radar`, `productName = Repo Radar`. Never change these.
- **Default model:** `claude-sonnet-5`. Only new/empty configs receive it; a saved `claude-sonnet-4-6` stays on 4.6.
- **Catalog invariants (must always hold):** dropdown ⊆ KNOWN_LIMITS; migration targets ⊆ KNOWN_LIMITS; migration keys ∩ KNOWN_LIMITS = ∅; provider preserved across every migration; DEFAULT_MODEL ∈ dropdown ∩ KNOWN_LIMITS.
- **`gpt-5.3-codex` context = 400000** (vendor-authoritative; litellm reports 272K — do not assert litellm equality for this one ID).
- **Migration policy = unavailable-only, literal, fixed at approval.** Only IDs with a vendor shutdown_date ≤ release date are migration keys.
- **Provider detection** must handle `gemini/`, `claude`/`anthropic/`, and `gpt`/`openai/`/o-series (`o1`/`o3`/`o4`)/`codex`/`chatgpt/`/`chatgpt-`.
- **Release gate is stdlib-only** — no pytest dependency on the release path.
- **Commit discipline:** stage by exact path (never `git add -A`). All work on `feature/model-refresh-2026`.
- **Release window:** target release date is **≥ 2026-07-23** (five codex keys die that day). All gate verifications use `--target-date 2026-07-23`; the July-21-fails case is an *expected* failure (proves the gate blocks a premature release).

---

## Prerequisites — dev environment (do first)
The worktree's system `python3` lacks `pytest` and litellm 1.93.0, and a Python 3.10 interpreter may be absent. Before Task 1, provision a dev venv used by every `.venv/bin/python -m pytest` / matrix step below:
```bash
cd /Users/matt/.claude-worktrees/repo-radar-model-refresh
# Ensure a 3.10–3.14 python exists (pyenv: `pyenv install 3.10.14 && pyenv local 3.10.14`, or `brew install python@3.12`).
python3.12 -m venv .venv           # or python3.10/3.11/3.13/3.14 — any in [3.10,3.15)
.venv/bin/python -m pip install -U pip
.venv/bin/python -m pip install -r requirements.txt pytest   # requirements pins litellm==1.93.0 after Task 7
```
> `.venv/` is gitignored (verify) — never commit it. Run all pytest and the litellm-matrix test with `.venv/bin/python -m pytest ...`. The **release gate** (`scripts/check_model_lifecycle.py`) is stdlib-only and runs under any `python3`, not the venv.

---

## File Structure
- `repo_radar/model_lifecycle.json` — **new.** Lifecycle manifest: one row per KNOWN_LIMITS id + migration key.
- `scripts/check_model_lifecycle.py` — **new.** stdlib release gate.
- `repo_radar/llm.py` — **modify.** Module-level `DEFAULT_MODEL`, `KNOWN_LIMITS`, `MODEL_MIGRATIONS`, `provider_for_model`, `migrate_model`; migrate `get_ai_model`; non-Gemini fallback guard; refreshed chain.
- `repo_radar/modes/sync.py` — **modify.** 3 provider-detection clusters → `provider_for_model`.
- `repo_radar/ui.py` — **modify.** Help text default → `DEFAULT_MODEL` (fix invalid `claude-sonnet-4-6-1m`).
- `menubar/model-policy.js` — **new.** CommonJS mirror: `DEFAULT_MODEL`, `MODEL_MIGRATIONS`, `KNOWN_MODEL_IDS`, `providerForModel`, `migrateModel`.
- `menubar/main.js` — **modify.** require policy; migrate at validation/export/LaunchAgent; unify default.
- `menubar/renderer/settings.html` — **modify.** 18-ID grouped dropdown + Advanced warnings + help text.
- `menubar/renderer/settings.js` — **modify.** require policy; migrate load/save + valid-but-unlisted `<option>` insertion; provider detection.
- `requirements.txt`, `pyproject.toml` — **modify.** litellm pin + Python floor.
- `menubar/resources/setup.sh` — **modify.** both-bounds Python guard, `python3 -m pip`, wording.
- `menubar/SETUP.md`, `README.md`, `CHANGELOG.md` — **modify.** model tables + entry.
- `release.sh` — **modify.** invoke the gate in preflight.
- `repo_radar/tests/test_llm.py` — **modify.** Update assertions.
- `repo_radar/tests/test_lifecycle_gate.py`, `repo_radar/tests/test_litellm_matrix.py`, `menubar/__tests__/model-policy.test.js`, `menubar/__tests__/drift-check.js`, `menubar/__tests__/dropdown.test.js` — **new.**

---

## Task 1: Python model policy core (llm.py)

**Files:**
- Modify: `repo_radar/llm.py` (`get_ai_model`, `GEMINI_FALLBACK_CHAIN`, `get_fallback_model`, `get_model_context_window`; add `DEFAULT_MODEL`, `KNOWN_LIMITS` module-level, `MODEL_MIGRATIONS`, `provider_for_model`, `migrate_model`)
- Test: `repo_radar/tests/test_llm.py`

**Interfaces — Produces:**
- `DEFAULT_MODEL: str = 'claude-sonnet-5'`
- `KNOWN_LIMITS: dict[str,int]` (module level)
- `MODEL_MIGRATIONS: dict[str,str]`
- `provider_for_model(model: str) -> str | None`  (`'gemini'|'anthropic'|'openai'|None`)
- `migrate_model(model: str) -> str`
- `get_ai_model() -> str` (now migrated)
- `get_fallback_model(current: str) -> str | None` (None for non-Gemini)

- [ ] **Step 1: Write failing tests for the new policy functions**

Add to `repo_radar/tests/test_llm.py`:
```python
from repo_radar import llm

def test_default_model():
    assert llm.DEFAULT_MODEL == 'claude-sonnet-5'
    assert llm.DEFAULT_MODEL in llm.KNOWN_LIMITS

def test_provider_for_model():
    assert llm.provider_for_model('gemini/gemini-3.5-flash') == 'gemini'
    assert llm.provider_for_model('claude-sonnet-5') == 'anthropic'
    assert llm.provider_for_model('anthropic/claude-opus-4-8') == 'anthropic'
    assert llm.provider_for_model('gpt-5.6-terra') == 'openai'
    assert llm.provider_for_model('o3') == 'openai'
    assert llm.provider_for_model('o4-mini') == 'openai'
    assert llm.provider_for_model('gpt-5.3-codex') == 'openai'
    assert llm.provider_for_model('chatgpt-4o-latest') == 'openai'
    assert llm.provider_for_model('chatgpt/foo') == 'openai'
    assert llm.provider_for_model('mystery-model') is None
    assert llm.provider_for_model('') is None

def test_migrate_model_every_row_and_passthrough():
    for old, new in llm.MODEL_MIGRATIONS.items():
        assert llm.migrate_model(old) == new, old
    assert llm.migrate_model('claude-sonnet-5') == 'claude-sonnet-5'
    assert llm.migrate_model(llm.DEFAULT_MODEL) == llm.DEFAULT_MODEL

def test_invariants():
    known = set(llm.KNOWN_LIMITS)
    keys = set(llm.MODEL_MIGRATIONS)
    targets = set(llm.MODEL_MIGRATIONS.values())
    assert targets <= known, targets - known                 # inv 2
    assert keys.isdisjoint(known), keys & known              # inv 3
    for old, new in llm.MODEL_MIGRATIONS.items():             # inv 4
        assert llm.provider_for_model(old) == llm.provider_for_model(new), old

def test_fallback_guard_non_gemini_returns_none():
    assert llm.get_fallback_model('claude-sonnet-5') is None
    assert llm.get_fallback_model('o3') is None
    assert llm.get_fallback_model('gpt-5.6-terra') is None

def test_fallback_chain_gemini():
    chain = llm.GEMINI_FALLBACK_CHAIN
    assert chain[0] == 'gemini/gemini-3.5-flash'
    for i in range(len(chain) - 1):
        assert llm.get_fallback_model(chain[i]) == chain[i + 1]
    assert llm.get_fallback_model(chain[-1]) is None

def test_get_ai_model_migrates(monkeypatch):
    monkeypatch.setenv('AI_MODEL', 'gpt-5.2-codex')
    assert llm.get_ai_model() == 'gpt-5.3-codex'
    monkeypatch.delenv('AI_MODEL', raising=False)
    assert llm.get_ai_model() == llm.DEFAULT_MODEL
```
Also update the existing window assertions in `test_llm.py` (were `claude-sonnet-4-6`/`gpt-5.4`/`o3`/`gemini-3.1-pro-preview`): keep those (all retained + active), and add `assert llm.get_model_context_window('gpt-5.3-codex') == 400000` and `assert llm.get_model_context_window('claude-sonnet-5') == 1000000`. Remove/replace the old `test` at lines 40-42 that asserted unknown→chain-head (now non-Gemini→None is covered above; unknown *Gemini-shaped* model still returns chain head — keep a targeted assertion: `assert llm.get_fallback_model('gemini/gemini-99') == 'gemini/gemini-3.5-flash'`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/matt/.claude-worktrees/repo-radar-model-refresh && .venv/bin/python -m pytest repo_radar/tests/test_llm.py -q`
Expected: FAIL (AttributeError: module has no attribute `DEFAULT_MODEL` / `provider_for_model`, etc.)

- [ ] **Step 3: Implement the policy in `repo_radar/llm.py`**

At module top (after imports), add:
```python
import re

DEFAULT_MODEL = 'claude-sonnet-5'
```
Replace `get_ai_model` (currently `llm.py:11-13`):
```python
def get_ai_model():
    """Get the AI model from env or default, migrating retired ids."""
    return migrate_model(os.environ.get('AI_MODEL', DEFAULT_MODEL))
```
Replace `GEMINI_FALLBACK_CHAIN` (currently `:17-24`) with the exact chain:
```python
GEMINI_FALLBACK_CHAIN = [
    'gemini/gemini-3.5-flash',
    'gemini/gemini-3.1-flash-lite',
    'gemini/gemini-2.5-flash',
    'gemini/gemini-2.5-flash-lite',
]
```
Replace `get_fallback_model` (currently `:26-43`) with the guarded version:
```python
def get_fallback_model(current_model):
    """Next Gemini fallback model, or None. Non-Gemini models have no fallback
    (returning a Gemini model here would switch providers and fail auth)."""
    if provider_for_model(current_model) != 'gemini':
        return None
    try:
        i = GEMINI_FALLBACK_CHAIN.index(current_model)
        return GEMINI_FALLBACK_CHAIN[i + 1] if i < len(GEMINI_FALLBACK_CHAIN) - 1 else None
    except ValueError:
        return GEMINI_FALLBACK_CHAIN[0]
```
Promote `KNOWN_LIMITS` to module level: take the **existing** dict from inside `get_model_context_window` (`:52-131`), lift it out as a module-level `KNOWN_LIMITS = {...}`, and apply these deltas:
- **Remove** these keys (they become migration keys): `claude-3-7-sonnet-20250219`, `claude-3-5-sonnet-20241022`, `claude-3-haiku-20240307`, `claude-3-opus-20240229`, `claude-opus-4-20250514`, `claude-4-opus-20250514`, `claude-sonnet-4-20250514`, `claude-4-sonnet-20250514`, `gemini/gemini-3-pro-preview`, `gemini/gemini-3.1-flash-lite-preview`, `gemini/gemini-2.0-flash`, `gemini/gemini-2.0-flash-001`, `gemini/gemini-2.0-flash-lite`, `codex-mini-latest`, `gpt-5-codex`, `gpt-5.1-codex`, `gpt-5.1-codex-max`, `gpt-5.1-codex-mini`, `gpt-5.2-codex`.
- **Add** these keys: `"claude-fable-5": 1000000`, `"claude-opus-4-8": 1000000`, `"claude-opus-4-7": 1000000`, `"claude-sonnet-5": 1000000`, `"gpt-5.6-sol": 1050000`, `"gpt-5.6-terra": 1050000`, `"gpt-5.6-luna": 1050000`, `"gpt-5.5": 1050000`, `"gpt-5.5-pro": 1050000`, `"gemini/gemini-3.5-flash": 1048576`, `"gemini/gemini-3.1-flash-lite": 1048576`.
- Ensure `"gpt-5.3-codex": 400000` (canonical had 272K — change it to 400000).

Then simplify `get_model_context_window` to read the module-level dict:
```python
def get_model_context_window(model):
    return KNOWN_LIMITS.get(model, 128000)
```
Add `MODEL_MIGRATIONS` (module level) — copy the literal map from spec §2.5:
```python
MODEL_MIGRATIONS = {
    # Anthropic
    "claude-3-7-sonnet-20250219": "claude-sonnet-5",
    "claude-3-5-sonnet-20241022": "claude-sonnet-5",
    "claude-3-5-sonnet-20240620": "claude-sonnet-5",
    "claude-3-sonnet-20240229": "claude-sonnet-5",
    "claude-3-5-haiku-20241022": "claude-haiku-4-5",
    "claude-3-haiku-20240307": "claude-haiku-4-5",
    "claude-3-opus-20240229": "claude-opus-4-8",
    "claude-opus-4-20250514": "claude-opus-4-8",
    "claude-4-opus-20250514": "claude-opus-4-8",
    "claude-sonnet-4-20250514": "claude-sonnet-5",
    "claude-4-sonnet-20250514": "claude-sonnet-5",
    # OpenAI
    "o1-preview": "o3",
    "o1-mini": "o3",
    "codex-mini-latest": "gpt-5.4-mini",
    "gpt-5-codex": "gpt-5.3-codex",
    "gpt-5.1-codex": "gpt-5.3-codex",
    "gpt-5.1-codex-max": "gpt-5.3-codex",
    "gpt-5.2-codex": "gpt-5.3-codex",
    "gpt-5.1-codex-mini": "gpt-5.4-mini",
    # Google
    "gemini/gemini-2.0-flash": "gemini/gemini-2.5-flash",
    "gemini/gemini-2.0-flash-001": "gemini/gemini-2.5-flash",
    "gemini/gemini-2.0-flash-exp": "gemini/gemini-2.5-flash",
    "gemini/gemini-2.0-flash-lite": "gemini/gemini-2.5-flash-lite",
    "gemini/gemini-3-pro-preview": "gemini/gemini-3.1-pro-preview",
    "gemini/gemini-3.1-flash-lite-preview": "gemini/gemini-3.1-flash-lite",
    "gemini/gemini-1.5-pro": "gemini/gemini-2.5-pro",
    "gemini/gemini-1.5-flash": "gemini/gemini-2.5-flash",
}


def migrate_model(model):
    return MODEL_MIGRATIONS.get(model, model)


def provider_for_model(model):
    if not model:
        return None
    if model.startswith('gemini/') or model.startswith('gemini-'):
        return 'gemini'
    if model.startswith('claude') or model.startswith('anthropic/'):
        return 'anthropic'
    if (model.startswith('gpt') or model.startswith('openai/') or model.startswith('chatgpt/')
            or model.startswith('chatgpt-') or model.startswith('codex') or re.match(r'^o\d', model)):
        return 'openai'
    return None
```
> **Note:** `KNOWN_LIMITS` must be defined *before* `get_model_context_window`, and `MODEL_MIGRATIONS`/`provider_for_model`/`migrate_model` before `get_ai_model`/`get_fallback_model` call them. Order the module accordingly.

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest repo_radar/tests/test_llm.py -q`
Expected: PASS (all tests). If `gpt-5.1-codex-mini`→`gpt-5.4-mini` fails the provider invariant, both are `openai` — it passes.

- [ ] **Step 5: Commit**

```bash
git add repo_radar/llm.py repo_radar/tests/test_llm.py
git commit -m "feat(llm): centralized model policy, refreshed catalog, non-Gemini fallback guard"
```

---

## Task 2: Lifecycle manifest + stdlib release gate

**Files:**
- Create: `repo_radar/model_lifecycle.json`
- Create: `scripts/check_model_lifecycle.py`
- Test: `repo_radar/tests/test_lifecycle_gate.py`

**Interfaces — Produces:** CLI `python3 scripts/check_model_lifecycle.py --target-date YYYY-MM-DD` (exit 0 pass / non-zero + stderr on fail); importable `check(manifest_path, known_ids, migration_keys, target_date) -> list[str]` (returns list of failures).

- [ ] **Step 1: Write the failing gate test**

`repo_radar/tests/test_lifecycle_gate.py`:
```python
import json, subprocess, sys, datetime, tempfile, os
from pathlib import Path
from repo_radar import llm
from scripts import check_model_lifecycle as gate

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "repo_radar" / "model_lifecycle.json"
JUL23 = datetime.date(2026, 7, 23)
OK = "https://example.com/x"

def _tmp(rows):
    f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    json.dump(rows, f); f.close(); return f.name

def _run(rows, known, migs, target=JUL23):
    p = _tmp(rows)
    try:
        return gate.check(p, set(known), set(migs), target)
    finally:
        os.unlink(p)

def test_real_manifest_exact_set_and_passes_at_release():
    rows = json.loads(MANIFEST.read_text())
    ids = [r["id"] for r in rows]
    assert len(ids) == len(set(ids)), "duplicate ids in manifest"
    assert set(ids) == set(llm.KNOWN_LIMITS) | set(llm.MODEL_MIGRATIONS)
    assert gate.check(str(MANIFEST), set(llm.KNOWN_LIMITS), set(llm.MODEL_MIGRATIONS), JUL23) == []

def test_happy_row_passes():
    assert _run(
        [{"id": "k", "status": "active", "shutdown_date": None, "source_url": OK},
         {"id": "m", "status": "retired", "shutdown_date": "2026-07-01", "source_url": OK}],
        {"k"}, {"m"}) == []

def test_failures_are_returned_not_raised():
    cases = [
        # (rows, known, migs, substring-in-some-failure)
        ([{"id":"k","status":"active","shutdown_date":None,"source_url":OK},
          {"id":"k","status":"retired","shutdown_date":"2026-01-01","source_url":OK}], {"k"}, set(), "duplicate"),
        ([], {"k"}, set(), "missing"),                                                    # missing row
        ([{"id":"x","status":"active","shutdown_date":None,"source_url":OK}], set(), set(), "extra"),
        ([{"id":"k","status":"retired","shutdown_date":None,"source_url":OK}], {"k"}, set(), "status=active"),
        ([{"id":"m","status":"active","shutdown_date":"2026-07-01","source_url":OK}], set(), {"m"}, "status=retired"),
        ([{"id":"k","status":"active","shutdown_date":"2026-07-01","source_url":OK}], {"k"}, set(), "<= target"),  # known dies before target
        ([{"id":"m","status":"retired","shutdown_date":None,"source_url":OK}], set(), {"m"}, "not on/before"),      # migration key null
        ([{"id":"m","status":"retired","shutdown_date":"2026-08-01","source_url":OK}], set(), {"m"}, "not on/before"),# future
        ([{"id":"k","status":"active","shutdown_date":"nope","source_url":OK}], {"k"}, set(), None),                # malformed date -> some failure, no raise
        ([{"id":"k","status":"active","shutdown_date":None,"source_url":"http://x"}], {"k"}, set(), "source_url"),  # non-https
        ([{"id":"k","status":"active","source_url":OK}], {"k"}, set(), None),                                       # missing shutdown_date key -> failure, no raise
    ]
    for rows, known, migs, sub in cases:
        fails = _run(rows, known, migs)   # must not raise
        assert fails, (rows, "expected failures")
        if sub:
            assert any(sub in f for f in fails), (sub, fails)

def test_cli_requires_iso_date():
    p = subprocess.run([sys.executable, str(ROOT / "scripts" / "check_model_lifecycle.py"),
                        "--target-date", "not-a-date"], capture_output=True, text=True)
    assert p.returncode != 0 and "invalid" in p.stderr.lower()
```

- [ ] **Step 2: Run to verify it fails**

Run: `.venv/bin/python -m pytest repo_radar/tests/test_lifecycle_gate.py -q`
Expected: FAIL (no `scripts/check_model_lifecycle.py`, no manifest).

- [ ] **Step 3: Write the manifest from the checked source table**

`repo_radar/model_lifecycle.json` has one row per id in `llm.KNOWN_LIMITS` ∪ `llm.MODEL_MIGRATIONS`. Generate mechanically from the two tables below, then **the operator manually re-verifies each date against its `source_url` before commit** (§8). Source URLs: Anthropic `A = https://platform.claude.com/docs/en/about-claude/model-deprecations`; OpenAI `O = https://developers.openai.com/api/docs/deprecations`; Google `G = https://ai.google.dev/gemini-api/docs/deprecations`.

**(a) Migration keys → `status:"retired"`, exact `shutdown_date` (all ≤ 2026-07-23):**
| id | shutdown_date | src |
|---|---|---|
| claude-3-7-sonnet-20250219 | 2026-02-19 | A |
| claude-3-5-sonnet-20241022 | 2025-10-28 | A |
| claude-3-5-sonnet-20240620 | 2025-10-28 | A |
| claude-3-sonnet-20240229 | 2025-07-21 | A |
| claude-3-5-haiku-20241022 | 2026-02-19 | A |
| claude-3-haiku-20240307 | 2026-04-19 | A |
| claude-3-opus-20240229 | 2026-01-05 | A |
| claude-opus-4-20250514 | 2026-06-15 | A |
| claude-4-opus-20250514 | 2026-06-15 | A |
| claude-sonnet-4-20250514 | 2026-06-15 | A |
| claude-4-sonnet-20250514 | 2026-06-15 | A |
| o1-preview | 2025-07-28 | O |
| o1-mini | 2025-10-27 | O |
| codex-mini-latest | 2026-02-12 | O |
| gpt-5-codex | 2026-07-23 | O |
| gpt-5.1-codex | 2026-07-23 | O |
| gpt-5.1-codex-max | 2026-07-23 | O |
| gpt-5.1-codex-mini | 2026-07-23 | O |
| gpt-5.2-codex | 2026-07-23 | O |
| gemini/gemini-2.0-flash | 2026-06-01 | G |
| gemini/gemini-2.0-flash-001 | 2026-06-01 | G |
| gemini/gemini-2.0-flash-exp | 2026-06-01 | G |
| gemini/gemini-2.0-flash-lite | 2026-06-01 | G |
| gemini/gemini-3-pro-preview | 2026-03-09 | G |
| gemini/gemini-3.1-flash-lite-preview | 2026-05-25 | G |
| gemini/gemini-1.5-pro | 2025-09-24 | G |
| gemini/gemini-1.5-flash | 2025-09-24 | G |

**(b) KNOWN_LIMITS → `status:"active"`.** `shutdown_date` is a **future** date for the deprecated-but-active ones, else `null`:
| id (or family) | shutdown_date | src |
|---|---|---|
| claude-opus-4-1, claude-opus-4-1-20250805 | 2026-08-05 | A |
| gemini/gemini-2.5-pro, -flash, -flash-lite | 2026-10-16 | G |
| gpt-4-turbo | 2026-10-23 | O |
| o1, o1-pro | 2026-10-23 | O |
| o3, o3-mini, o3-pro | 2026-12-11 | O |
| gpt-5, gpt-5-mini, gpt-5-nano | 2026-12-11 | O |
| *all other KNOWN_LIMITS ids* (fable-5, opus-4-8/4-7/4-6, sonnet-5/4-6, opus-4-5, sonnet-4-5, haiku-4-5, gpt-5.6-*, gpt-5.5(+pro), gpt-5.4(+*), gpt-5.3-codex, gpt-5.1, gpt-4.1(+*), gpt-4o(+mini), o4-mini, gemini-3.5-flash, gemini-3.1-flash-lite, gemini-3.1-pro-preview, gemini-3-flash-preview, gemini-*-latest) | null | vendor page |

Row shape: `{"id": <id>, "status": "active"|"retired", "shutdown_date": "YYYY-MM-DD"|null, "source_url": <A|O|G>}`. **Any date the operator cannot confirm on the linked page blocks the release** (§8) — do not invent.

- [ ] **Step 4: Write the stdlib gate**

`scripts/check_model_lifecycle.py`:
```python
#!/usr/bin/env python3
"""Stdlib-only release gate: verify the model lifecycle manifest against a target date."""
import argparse, json, sys, datetime
from pathlib import Path


def _parsed(sd):
    try:
        return datetime.date.fromisoformat(sd)
    except (TypeError, ValueError):
        return None


def check(manifest_path, known_ids, migration_keys, target_date):
    """Return a list of failure strings (never raises for malformed rows)."""
    failures = []
    try:
        rows = json.loads(Path(manifest_path).read_text())
    except Exception as e:
        return [f"manifest unreadable: {e}"]
    if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
        return ["manifest must be a JSON array of objects"]
    ids = [r.get("id") for r in rows]
    if len(ids) != len(set(ids)):
        failures.append("duplicate ids in manifest")
    manifest_ids = set(ids)
    expected = set(known_ids) | set(migration_keys)
    if expected - manifest_ids:
        failures.append(f"manifest missing ids: {sorted(expected - manifest_ids)}")
    if manifest_ids - expected:
        failures.append(f"manifest has extra ids: {sorted(manifest_ids - expected)}")
    by_id = {r.get("id"): r for r in rows}
    for r in rows:
        rid = r.get("id", "<no-id>")
        url = r.get("source_url")
        if not (isinstance(url, str) and url.startswith("https://")):
            failures.append(f"{rid}: source_url must be non-empty https")
        if "shutdown_date" not in r:
            failures.append(f"{rid}: missing shutdown_date key")
    for kid in known_ids:
        r = by_id.get(kid)
        if not r:
            continue
        if r.get("status") != "active":
            failures.append(f"{kid}: KNOWN model must be status=active")
        sd = r.get("shutdown_date")
        if sd is not None:
            d = _parsed(sd)
            if d is None:
                failures.append(f"{kid}: malformed shutdown_date {sd!r}")
            elif d <= target_date:
                failures.append(f"{kid}: KNOWN model shutdown {sd} <= target {target_date}")
    for mk in migration_keys:
        r = by_id.get(mk)
        if not r:
            continue
        if r.get("status") != "retired":
            failures.append(f"{mk}: migration key must be status=retired")
        sd = r.get("shutdown_date")
        d = _parsed(sd) if sd is not None else None
        if sd is not None and d is None:
            failures.append(f"{mk}: malformed shutdown_date {sd!r}")
        elif d is None or d > target_date:
            failures.append(f"{mk}: migration key shutdown {sd} not on/before target {target_date}")
    return failures


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target-date", required=True)
    a = ap.parse_args()
    try:
        target = datetime.date.fromisoformat(a.target_date)
    except ValueError:
        print(f"invalid --target-date (want YYYY-MM-DD): {a.target_date}", file=sys.stderr)
        return 2
    root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(root))
    from repo_radar import llm
    failures = check(str(root / "repo_radar" / "model_lifecycle.json"),
                     set(llm.KNOWN_LIMITS), set(llm.MODEL_MIGRATIONS), target)
    if failures:
        print("MODEL LIFECYCLE GATE FAILED:", file=sys.stderr)
        for f in failures:
            print("  -", f, file=sys.stderr)
        return 1
    print(f"model lifecycle gate OK ({len(llm.KNOWN_LIMITS)} known, {len(llm.MODEL_MIGRATIONS)} migrations) for {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```
Add empty `scripts/__init__.py` if `from scripts import` needs it (create it so the test import works).

- [ ] **Step 5: Run tests + the CLI to verify pass**

Run:
```bash
.venv/bin/python -m pytest repo_radar/tests/test_lifecycle_gate.py -q
python3 scripts/check_model_lifecycle.py --target-date 2026-07-23
```
Expected: pytest PASS; CLI prints "model lifecycle gate OK ..." and exits 0.

- [ ] **Step 6: Commit**

```bash
git add repo_radar/model_lifecycle.json scripts/check_model_lifecycle.py scripts/__init__.py repo_radar/tests/test_lifecycle_gate.py
git commit -m "feat(release): model lifecycle manifest + stdlib shutdown gate"
```

---

## Task 3: Route Python provider detection through the policy

**Files:**
- Modify: `repo_radar/modes/sync.py` (clusters at `:753-758`, `:1397-1404`, `:1427-1432`)
- Modify: `repo_radar/ui.py` (`:35-38`)

**Interfaces — Consumes:** `provider_for_model`, `DEFAULT_MODEL` from `repo_radar.llm`.

- [ ] **Step 1: Write the failing test**

Add to `repo_radar/tests/test_modes.py` (or create `test_sync_provider.py`):
```python
import repo_radar.modes.sync as sync
import inspect

def test_sync_all_three_clusters_use_provider_for_model():
    src = inspect.getsource(sync)
    # all three detection clusters replaced (>=3 calls), and the old model-shaped
    # startswith branches gone entirely (so no cluster silently remains).
    assert src.count("provider_for_model(") >= 3
    for old in ("startswith('o1')", "startswith('gpt')", "startswith('claude')", "startswith('gemini/')"):
        assert old not in src, f"stale provider branch remains: {old}"
```

- [ ] **Step 2: Run to verify fail**

Run: `.venv/bin/python -m pytest repo_radar/tests/test_modes.py -q -k provider`
Expected: FAIL (`provider_for_model(` not yet in sync.py).

- [ ] **Step 3: Edit the three clusters**

Import at top of `sync.py`: add `provider_for_model` to the `from repo_radar.llm import ...` (or `from repo_radar import llm`). Replace each cluster's `if model.startswith('gemini/'): ... elif model.startswith('claude'): ... elif model.startswith('gpt') or ...o1/o3/o4/chatgpt/codex...:` with:
```python
provider = provider_for_model(model)
if provider == 'gemini':
    ... GEMINI_API_KEY ...
elif provider == 'anthropic':
    ... ANTHROPIC_API_KEY ...
elif provider == 'openai':
    ... OPENAI_API_KEY ...
```
Preserve each cluster's surrounding message/return logic (`:753-758` sets `api_key_missing`; `:1397-1404` and `:1427-1432` build warning strings). In `ui.py:35-38` replace the literal `claude-sonnet-4-6-1m` default in help text with `DEFAULT_MODEL` (import it).

- [ ] **Step 4: Run tests to verify pass**

Run: `.venv/bin/python -m pytest repo_radar/tests/ -q`
Expected: PASS (full suite).

- [ ] **Step 5: Commit**

```bash
git add repo_radar/modes/sync.py repo_radar/ui.py repo_radar/tests/test_modes.py
git commit -m "refactor(python): route provider detection through provider_for_model"
```

---

## Task 4: JS model policy module (`menubar/model-policy.js`)

**Files:**
- Create: `menubar/model-policy.js`
- Create: `menubar/__tests__/model-policy.test.js`
- Create: `menubar/__tests__/drift-check.js`

**Interfaces — Produces (CommonJS):** `{ DEFAULT_MODEL, MODEL_MIGRATIONS, KNOWN_MODEL_IDS (Set), providerForModel(model), migrateModel(model) }`.

- [ ] **Step 1: Write the failing JS test**

`menubar/__tests__/model-policy.test.js`:
```js
const assert = require('assert');
const { DEFAULT_MODEL, MODEL_MIGRATIONS, KNOWN_MODEL_IDS, providerForModel, migrateModel } = require('../model-policy');

assert.strictEqual(DEFAULT_MODEL, 'claude-sonnet-5');
assert.ok(KNOWN_MODEL_IDS.has('claude-sonnet-5'));
assert.strictEqual(providerForModel('gemini/gemini-3.5-flash'), 'gemini');
assert.strictEqual(providerForModel('claude-sonnet-5'), 'anthropic');
assert.strictEqual(providerForModel('gpt-5.6-terra'), 'openai');
assert.strictEqual(providerForModel('o3'), 'openai');
assert.strictEqual(providerForModel('chatgpt-4o-latest'), 'openai');
assert.strictEqual(providerForModel('mystery'), null);
for (const [oldId, newId] of Object.entries(MODEL_MIGRATIONS)) {
  assert.strictEqual(migrateModel(oldId), newId, `migrate ${oldId}`);
  assert.ok(KNOWN_MODEL_IDS.has(newId), `target ${newId} in KNOWN_MODEL_IDS`);
}
assert.strictEqual(migrateModel('claude-sonnet-5'), 'claude-sonnet-5');
console.log('model-policy OK:', Object.keys(MODEL_MIGRATIONS).length, 'migrations');
```

- [ ] **Step 2: Run to verify fail**

Run: `cd /Users/matt/.claude-worktrees/repo-radar-model-refresh && node menubar/__tests__/model-policy.test.js`
Expected: FAIL (Cannot find module '../model-policy').

- [ ] **Step 3: Write `menubar/model-policy.js`**

```js
// Mirror of repo_radar/llm.py policy. KEEP IN SYNC (drift-check.js guards it).
const DEFAULT_MODEL = 'claude-sonnet-5';

const MODEL_MIGRATIONS = {
  // Anthropic
  'claude-3-7-sonnet-20250219': 'claude-sonnet-5',
  'claude-3-5-sonnet-20241022': 'claude-sonnet-5',
  'claude-3-5-sonnet-20240620': 'claude-sonnet-5',
  'claude-3-sonnet-20240229': 'claude-sonnet-5',
  'claude-3-5-haiku-20241022': 'claude-haiku-4-5',
  'claude-3-haiku-20240307': 'claude-haiku-4-5',
  'claude-3-opus-20240229': 'claude-opus-4-8',
  'claude-opus-4-20250514': 'claude-opus-4-8',
  'claude-4-opus-20250514': 'claude-opus-4-8',
  'claude-sonnet-4-20250514': 'claude-sonnet-5',
  'claude-4-sonnet-20250514': 'claude-sonnet-5',
  // OpenAI
  'o1-preview': 'o3',
  'o1-mini': 'o3',
  'codex-mini-latest': 'gpt-5.4-mini',
  'gpt-5-codex': 'gpt-5.3-codex',
  'gpt-5.1-codex': 'gpt-5.3-codex',
  'gpt-5.1-codex-max': 'gpt-5.3-codex',
  'gpt-5.2-codex': 'gpt-5.3-codex',
  'gpt-5.1-codex-mini': 'gpt-5.4-mini',
  // Google
  'gemini/gemini-2.0-flash': 'gemini/gemini-2.5-flash',
  'gemini/gemini-2.0-flash-001': 'gemini/gemini-2.5-flash',
  'gemini/gemini-2.0-flash-exp': 'gemini/gemini-2.5-flash',
  'gemini/gemini-2.0-flash-lite': 'gemini/gemini-2.5-flash-lite',
  'gemini/gemini-3-pro-preview': 'gemini/gemini-3.1-pro-preview',
  'gemini/gemini-3.1-flash-lite-preview': 'gemini/gemini-3.1-flash-lite',
  'gemini/gemini-1.5-pro': 'gemini/gemini-2.5-pro',
  'gemini/gemini-1.5-flash': 'gemini/gemini-2.5-flash',
};

// Exact mirror of Python KNOWN_LIMITS keys (drift-check enforces equality).
const KNOWN_MODEL_IDS = new Set([
  /* PASTE the exact key list produced by:
     python3 -c "import sys;sys.path.insert(0,'.');from repo_radar import llm;print('\n'.join(sorted(llm.KNOWN_LIMITS)))"
     — every KNOWN_LIMITS key, one per quoted entry. */
]);

function providerForModel(model) {
  if (!model) return null;
  if (model.startsWith('gemini/') || model.startsWith('gemini-')) return 'gemini';
  if (model.startsWith('claude') || model.startsWith('anthropic/')) return 'anthropic';
  if (model.startsWith('gpt') || model.startsWith('openai/') || model.startsWith('chatgpt/')
      || model.startsWith('chatgpt-') || model.startsWith('codex') || /^o\d/.test(model)) return 'openai';
  return null;
}

function migrateModel(model) { return (model && MODEL_MIGRATIONS[model]) || model; }

module.exports = { DEFAULT_MODEL, MODEL_MIGRATIONS, KNOWN_MODEL_IDS, providerForModel, migrateModel };
```
Populate `KNOWN_MODEL_IDS` by running the shown Python one-liner and pasting each key as a quoted array entry.

- [ ] **Step 4: Write the drift check `menubar/__tests__/drift-check.js`**

```js
const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');
const { MODEL_MIGRATIONS, KNOWN_MODEL_IDS, DEFAULT_MODEL } = require('../model-policy');
const root = path.join(__dirname, '..', '..');
const py = process.platform === 'win32' ? 'python' : 'python3';
const out = execFileSync(py, ['-c',
  "import sys,json;sys.path.insert(0,'.');from repo_radar import llm;print(json.dumps({'d':llm.DEFAULT_MODEL,'m':llm.MODEL_MIGRATIONS,'k':sorted(llm.KNOWN_LIMITS)}))"],
  { cwd: root, encoding: 'utf8' });
const p = JSON.parse(out);
assert.strictEqual(DEFAULT_MODEL, p.d, 'DEFAULT_MODEL drift');
assert.deepStrictEqual(Object.keys(MODEL_MIGRATIONS).sort(), Object.keys(p.m).sort(), 'migration key drift');
for (const k of Object.keys(MODEL_MIGRATIONS)) assert.strictEqual(MODEL_MIGRATIONS[k], p.m[k], `migration value drift ${k}`);
assert.deepStrictEqual([...KNOWN_MODEL_IDS].sort(), p.k, 'KNOWN_MODEL_IDS drift');
console.log('drift OK:', p.k.length, 'known,', Object.keys(p.m).length, 'migrations');
```

- [ ] **Step 5: Run both to verify pass**

Run:
```bash
node menubar/__tests__/model-policy.test.js
node menubar/__tests__/drift-check.js
```
Expected: both print OK.

- [ ] **Step 6: Commit**

```bash
git add menubar/model-policy.js menubar/__tests__/model-policy.test.js menubar/__tests__/drift-check.js
git commit -m "feat(menubar): shared JS model-policy + cross-language drift check"
```

---

## Task 5: Wire the JS consumers (main.js + settings.js)

**Files:**
- Modify: `menubar/main.js` (require at top; `:889-905` validation; `~:1005-1007` AI_MODEL export; `:1523-1539` LaunchAgent wrapper)
- Modify: `menubar/renderer/settings.js` (require at top; config default `:11`; `:83` load; `:408-414` + `:460-475` provider; save handler)

**Interfaces — Consumes:** `providerForModel`, `migrateModel`, `DEFAULT_MODEL`, `KNOWN_MODEL_IDS` from `model-policy`.

- [ ] **Step 1: Add requires + migrate at every boundary (main.js)**

Near the top of `menubar/main.js` add: `const { providerForModel, migrateModel, DEFAULT_MODEL } = require('./model-policy');`
- `:889` replace the stray default `'gemini/gemini-3-pro-preview'` and detection: `const model = migrateModel(config.ai_model || DEFAULT_MODEL); const provider = providerForModel(model);` then `if (provider === 'gemini') {...} else if (provider === 'anthropic') {...} else if (provider === 'openai') {...}`.
- `~:1005-1007` (grep `shellEnv.AI_MODEL` to confirm the exact line) where `AI_MODEL` is exported to the spawned sync: `shellEnv.AI_MODEL = migrateModel(config.ai_model || DEFAULT_MODEL);`
- `:1523-1539` in the LaunchAgent `run-sync.sh` generation: **preserve the file's existing shell-escaping pattern** (the wrapper already single-quotes exported values). Compute `const aiModel = migrateModel(config.ai_model || DEFAULT_MODEL);` and emit the export using the **same single-quote form already used for the API keys** in that block (e.g. `export AI_MODEL='${aiModel}'` matching the surrounding `export GEMINI_API_KEY='...'` lines) — do NOT switch to double quotes (would allow `$`/backtick/`"` in a saved value to alter the wrapper). Model IDs are `[a-z0-9._/-]`, but keep the escape for consistency + safety.

- [ ] **Step 2: Add requires + migrate load/save (settings.js)**

Near the top add: `const { providerForModel, migrateModel, DEFAULT_MODEL, KNOWN_MODEL_IDS } = require('../model-policy');`
- **`:11` config-object default** — the fallback `configData = { ..., ai_model: 'claude-sonnet-4-6', ... }` must become `ai_model: DEFAULT_MODEL` (else a first-run/empty config defaults to 4.6, since 4.6 is valid+unmigrated and never reaches `DEFAULT_MODEL`).
- `:408-414` and `:460-475`: replace the `startsWith('gpt')||startsWith('o1')` branches with `const p = providerForModel(model); if (p === 'gemini') requiredProvider='gemini'; else if (p==='anthropic') requiredProvider='anthropic'; else if (p==='openai') requiredProvider='openai';` (and the save-validation equivalent).
- `:83` load block — replace `aiModelSelect.value = configData.ai_model` with:
```js
const select = document.getElementById('ai-model');
const migrated = migrateModel(configData.ai_model || DEFAULT_MODEL);
if ([...select.options].some(o => o.value === migrated)) {
  select.value = migrated;
} else if (KNOWN_MODEL_IDS.has(migrated)) {
  const opt = document.createElement('option');
  opt.value = migrated; opt.textContent = `${migrated} — Saved model (still supported)`;
  select.appendChild(opt); select.value = migrated;
} else {
  select.value = DEFAULT_MODEL;
}
```
- **Save handler** (a *different* callback — the `select` above is scoped to `renderForm()`): re-query the element and persist migrated — `const sel = document.getElementById('ai-model'); configData.ai_model = migrateModel(sel.value || DEFAULT_MODEL);` before writing config.

- [ ] **Step 3: Verify parse + require resolution**

Run:
```bash
node --check menubar/main.js && node --check menubar/renderer/settings.js
node -e "require('./menubar/model-policy'); console.log('main require ok')"
(cd menubar/renderer && node -e "require('../model-policy'); console.log('renderer require ok')")
```
Expected: all clean/ok.

- [ ] **Step 4: Commit**

```bash
git add menubar/main.js menubar/renderer/settings.js
git commit -m "feat(menubar): route consumers through model-policy; migrate at all boundaries"
```

---

## Task 6: Refresh the settings dropdown (settings.html)

**Files:** Modify `menubar/renderer/settings.html` (the `<select id="ai-model">` optgroups + the OpenAI key help text `:50`).

- [ ] **Step 1: Replace the `<optgroup>` set** with the 18 IDs grouped per spec §2.3 (Recommended 7 / Anthropic 3 / Google 3 / OpenAI 3 / Advanced-Responses 2). Label `gemini/gemini-3.1-pro-preview` "(Preview)"; give the Advanced group a label like "Advanced — Responses API (higher cost/latency)". Set `claude-sonnet-5` as the pre-selected option. Update `:50` help "For GPT and o1 models" → "For GPT and o-series models".

- [ ] **Step 2: Assert the dropdown structure executably** (`menubar/__tests__/dropdown.test.js`)

```js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { KNOWN_MODEL_IDS, DEFAULT_MODEL } = require('../model-policy');

const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'settings.html'), 'utf8');
// scope to the ai-model select
const sel = html.slice(html.indexOf('id="ai-model"'));
const selBody = sel.slice(0, sel.indexOf('</select>'));

const groups = (selBody.match(/<optgroup/g) || []).length;
assert.strictEqual(groups, 5, `expected 5 optgroups, got ${groups}`);

const EXPECTED = [
  'claude-sonnet-5','claude-opus-4-8','claude-haiku-4-5','gemini/gemini-3.5-flash','gemini/gemini-3.1-flash-lite','gpt-5.6-terra','gpt-5.6-luna',
  'claude-fable-5','claude-opus-4-7','claude-sonnet-4-6',
  'gemini/gemini-3.1-pro-preview','gemini/gemini-2.5-pro','gemini/gemini-2.5-flash',
  'gpt-5.6-sol','gpt-5.5','o3',
  'gpt-5.3-codex','gpt-5.5-pro',
];
const values = [...selBody.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
assert.strictEqual(values.length, 18, `expected 18 options, got ${values.length}`);
assert.deepStrictEqual(values.slice().sort(), EXPECTED.slice().sort(), 'dropdown value set mismatch');
for (const v of values) assert.ok(KNOWN_MODEL_IDS.has(v), `dropdown value not in KNOWN_MODEL_IDS: ${v}`);
assert.ok(EXPECTED.includes(DEFAULT_MODEL), 'DEFAULT_MODEL must be a dropdown option');
// default selected
const defOpt = selBody.match(new RegExp(`<option value="${DEFAULT_MODEL}"[^>]*selected`));
assert.ok(defOpt, `DEFAULT_MODEL (${DEFAULT_MODEL}) must be the pre-selected option`);
console.log('dropdown OK: 18 options, 5 groups,', DEFAULT_MODEL, 'selected');
```
Run: `node menubar/__tests__/dropdown.test.js` → Expected: "dropdown OK: 18 options, 5 groups, claude-sonnet-5 selected". Commit this test with the HTML in Step 3.

- [ ] **Step 3: Commit**

```bash
git add menubar/renderer/settings.html menubar/__tests__/dropdown.test.js
git commit -m "feat(menubar): refresh AI-model dropdown to current lineups (+structure test)"
```

---

## Task 7: litellm pin + Python floor + setup guard

**Files:** Modify `requirements.txt`, `pyproject.toml`, `menubar/resources/setup.sh`.

- [ ] **Step 1: Pin deps**

- `requirements.txt`: `litellm==1.83.4` → `litellm==1.93.0`.
- `pyproject.toml`: `litellm==1.83.4` → `litellm==1.93.0`; `requires-python` → `">=3.10,<3.15"`.

- [ ] **Step 2: Add a both-bounds numeric guard to `menubar/resources/setup.sh`**

Replace the `python3` existence check (`~:39`) with:
```bash
PYV=$(python3 -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null || echo "0.0")
PYMAJ=${PYV%%.*}; PYMIN=${PYV#*.}
if [ "$PYMAJ" -ne 3 ] || [ "$PYMIN" -lt 10 ] || [ "$PYMIN" -ge 15 ]; then
  echo "Repo Radar requires Python >=3.10,<3.15 (found $PYV). Install a supported Python 3 and retry." >&2
  exit 1
fi
```
Check for pip via **`python3 -m pip`** (not a separate `pip3` binary), and make the install **resource-relative**: `python3 -m pip install -q -r "$SCRIPT_DIR/requirements.txt"` (setup.sh runs from an install path, not the repo root). Fix the stale "Gemini API key" default wording if present.

- [ ] **Step 3: Write the litellm 1.93.0 full-matrix test** (`repo_radar/tests/test_litellm_matrix.py`)

This is the spec §2.1 invariant 6 check (dev-time; requires litellm 1.93.0 in `.venv`):
```python
import pytest
from repo_radar import llm
litellm = pytest.importorskip("litellm")

def test_every_known_model_resolves_on_litellm_1_93():
    import importlib.metadata as md
    assert tuple(int(x) for x in md.version("litellm").split(".")[:2]) >= (1, 93)
    for mid, ctx in llm.KNOWN_LIMITS.items():
        info = litellm.get_model_info(mid)          # raises if unknown -> test fails loudly
        assert info.get("litellm_provider") == llm.provider_for_model(mid), (mid, info.get("litellm_provider"))
        assert info.get("mode") in ("chat", "responses"), (mid, info.get("mode"))
        if mid == "gpt-5.3-codex":
            continue                                 # vendor 400K != litellm 272K, per spec
        assert info.get("max_input_tokens") == ctx, (mid, info.get("max_input_tokens"), ctx)
```

- [ ] **Step 4: Verify**

```bash
.venv/bin/python -m pytest repo_radar/tests/test_litellm_matrix.py -q   # needs litellm 1.93.0 in .venv
python3.12 -m venv /tmp/rr312 && /tmp/rr312/bin/python -m pip install -q -r requirements.txt && /tmp/rr312/bin/python -c "import importlib.metadata as m;print('litellm',m.version('litellm'))"
bash -n menubar/resources/setup.sh
```
Expected: matrix test PASS; clean-venv install prints `litellm 1.93.0`; `bash -n` clean. (Use whichever 3.10–3.14 interpreter is installed.)

- [ ] **Step 5: Commit**

```bash
git add requirements.txt pyproject.toml menubar/resources/setup.sh repo_radar/tests/test_litellm_matrix.py
git commit -m "build: pin litellm==1.93.0, Python >=3.10,<3.15 guard, full-matrix test"
```

---

## Task 8: Docs + CHANGELOG

**Files:** Modify `menubar/SETUP.md`, `README.md`, `CHANGELOG.md`.

- [ ] **Step 1: Update the model tables + default references** in `menubar/SETUP.md` and `README.md` to the new dropdown/default; update the manual install command to `python3 -m pip install -r requirements.txt`.

- [ ] **Step 2: Add a `CHANGELOG.md` entry** for v1.0.27 summarizing: refreshed model catalog (current Anthropic/OpenAI/Gemini), retired-model auto-migration, non-Gemini fallback fix, litellm 1.93.0 + Python 3.10 floor.

- [ ] **Step 3: Commit**

```bash
git add menubar/SETUP.md README.md CHANGELOG.md
git commit -m "docs: model tables, install command, CHANGELOG for v1.0.27"
```

---

## Task 9: Wire the shutdown gate into release.sh

**Files:** Modify `release.sh` (preflight section, `~:76-116`).

- [ ] **Step 1: Invoke the gate in preflight**

After the existing preflight checks, before version calc, add:
```bash
RELEASE_DATE=$(date +%Y-%m-%d)
python3 scripts/check_model_lifecycle.py --target-date "$RELEASE_DATE" || {
  echo "Release blocked: model lifecycle gate failed. Re-verify vendor deprecation pages and amend repo_radar/model_lifecycle.json + the model maps." >&2
  exit 1
}
```

- [ ] **Step 2: Verify — gate is green at the release window, red before it**

`release.sh` keeps `$(date +%Y-%m-%d)` (real date) so a genuine early release correctly blocks. Verify both directions explicitly:
```bash
bash -n release.sh
python3 scripts/check_model_lifecycle.py --target-date 2026-07-23   # PASS (codex keys retired on/before target)
python3 scripts/check_model_lifecycle.py --target-date 2026-07-21 ; echo "exit=$?"   # EXPECTED FAIL (codex keys still active) -> exit=1
```
Expected: `bash -n` clean; the 07-23 gate prints OK (exit 0); the 07-21 gate prints the codex-key failures and `exit=1` — that's the gate correctly refusing a pre-2026-07-23 release.

- [ ] **Step 3: Commit**

```bash
git add release.sh
git commit -m "feat(release): gate the release on the model lifecycle manifest"
```

---

## Task 10: Full green + integration check

- [ ] **Step 1: Run the full suites**

```bash
.venv/bin/python -m pytest repo_radar/tests/ -q          # incl. test_llm, test_lifecycle_gate, test_litellm_matrix
node menubar/__tests__/model-policy.test.js && node menubar/__tests__/drift-check.js && node menubar/__tests__/dropdown.test.js
node --check menubar/main.js && node --check menubar/renderer/settings.js
python3 scripts/check_model_lifecycle.py --target-date 2026-07-23
```
Expected: pytest all pass (incl. the 19-ID litellm matrix); JS tests OK; parse clean; gate OK at the 2026-07-23 release window.

- [ ] **Step 2: Manual settings smoke** (deferred to dev prerelease per spec §8, but sanity now): confirm `menubar/renderer/settings.html` renders the **five** option groups and that a config with a retired `ai_model` (e.g. `gpt-5.2-codex`) loads as its migrated value (`gpt-5.3-codex`).

- [ ] **Step 3:** No commit — this is verification only. Proceed to the spec's §8 release flow (merge to `dev`, dev prerelease + smoke incl. Sonnet 5 vs 4.6 latency/cost, then `main` → v1.0.27, reconcile `main`→`dev`).

---

## Self-Review Notes
- **Spec coverage:** §2.1 invariants → Task 1 tests + Task 2 gate; §2.3 dropdown → Task 6; §2.4 KNOWN_LIMITS union → Task 1; §2.5 migrations → Task 1/4; §3 centralization → Tasks 1/3/4/5; §4 boundaries → Tasks 1 (get_ai_model), 5 (main.js + settings.js); §5 fallback → Task 1; §6 litellm/floor/docs → Tasks 7/8; §7 tests → Tasks 1/2/4; §8 gate + release → Tasks 2/9 + §8 flow.
- **Type consistency:** `provider_for_model`/`providerForModel`, `migrate_model`/`migrateModel`, `KNOWN_LIMITS`/`KNOWN_MODEL_IDS`, `DEFAULT_MODEL` used consistently across tasks.
- **litellm matrix:** the full-catalog provider/mode/context check (spec §2.1 inv 6) is `repo_radar/tests/test_litellm_matrix.py` (Task 7, gated on litellm 1.93.0 in `.venv`), and runs in Task 10's suite — not just spot assertions.
- **Retained legacy windows:** come from canonical's existing `KNOWN_LIMITS` (already literal in `llm.py`); Task 1 applies deltas rather than re-typing them, and the matrix test + Task 2 gate verify the result.
- **Two "generate-then-commit" spots** (both deterministic + guarded): `KNOWN_MODEL_IDS` paste in Task 4 (drift-tested vs Python) and the lifecycle manifest in Task 2 (built from the checked source table + operator vendor re-verification, gate-enforced).
