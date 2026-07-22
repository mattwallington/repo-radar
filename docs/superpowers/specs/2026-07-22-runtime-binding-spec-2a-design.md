# Spec 2A — Packaged Python Runtime Binding (Repo Radar v1.0.27)

**Status:** rev 3 — addresses Codex R2 blockers 1–5 and acceptance additions. For Codex
Round 3. Do NOT implement or merge into `dev` before the Spec 1
(`feature/model-refresh-2026`) dev-prerelease smoke completes.

**Branch:** `feature/runtime-binding-v1.0.27` (cut from `dev` @ `6621882`).

**Goal:** Guarantee that a given installed Repo Radar *build* (channel + version) always
runs its own bundled Python package against its own fully-resolved, version-bound
dependencies — on fresh install, upgrade, crash-recovery, and dev/stable coexistence, for
manual ("Sync Now"), scheduled (LaunchAgent), and CLI runs — so the Spec 1 model refresh
(and every future Python-side change) actually reaches users. Sole production blocker for
`v1.0.27`.

---

## 1. Scope

### In scope (2A)
- **Dependency binding** from a **checked-in, hash-pinned, portable lock** into a
  channel+build-bound venv, on fresh install and every build change.
- **Interpreter binding:** resolve one base Python (`>=3.10,<3.15`) to its **real
  executable**, fingerprint it, run everything through the app-managed venv.
- **Source binding:** copy the shipped `repo_radar` into an **immutable generation
  directory** (version + fingerprint); always import that copy.
- **Ownership model:** exactly one **activation pointer** per channel; **stable** is the
  sole owner of the `repo-radar` CLI and the persistent user schedule; **dev** is fully
  namespaced and may not mutate stable's CLI or install a competing persistent schedule.
- **Crash-safe activation:** install generic self-verifying dispatchers first, migrate the
  legacy schedule, then flip **one atomic pointer** as the single commit point.
- **One real cross-process lock** (Node + `/bin/sh` + CLI) held for a child's full lifetime
  and through provisioning activation.
- **Verifiable runtime identity:** validate the **active payload** (hash the live copy,
  exact installed-distribution-set match, corroborated channel identity), not just an
  input-file hash.
- **CLI continuity**, **failure/offline hard-block** (redacted, restrictive perms),
  **scripted logic harness + built-artifact packaged upgrade smoke**.

### Out of scope (Spec 2B)
- Broader updater UX; signing/notarization; Electron upgrade.
- CI release hardening beyond a lock-freshness check; dev/prod gate channel semantics.
- Dependency **wheel vendoring** for offline first-run.
- Full old-runtime GC (2A GCs only abandoned staging/orphan generations).
- Namespacing the entire shared **data plane** (config schedule, status file, cache,
  pristine repos). 2A instead makes stable the sole persistent-schedule owner (below).

---

## 2. Current architecture (as-is) — gaps this spec closes

(file:line on `dev` @ `6621882`.)
1. `setup.sh` orphaned; global pip; no venv (`setup.sh:33-57`).
2. Deps not build-bound; auto-updater has no post-update hook (`main.js:1851-1918`).
3. `getSyncScriptPath()` prefers stale `~/.repo-radar/repo-radar` (`main.js:88-91`).
4. Manual (`/usr/bin/env python3`, pyenv-first, `main.js:1028`) vs scheduled (Homebrew after
   pyenv, `main.js:1547-1548`) interpreter divergence.
5. No runtime marker.
6. No channel namespacing; `~/.repo-radar`, `run-sync.sh`, `com.user.repo-radar`,
   `~/.local/bin/repo-radar` shared across builds.
7. Unsafe `getVersion()` fictitious fallback (`main.js:11-26`).
8. `~/.local/bin/repo-radar` CLI (`setup.sh:37`) is a public interface.
9. **The installed 1.0.26 LaunchAgent wrapper has no self-check** — the first upgrade cannot
   assume a stale wrapper fails closed.

---

## 3. Design

### 3.1 Channel ownership + immutable generations

`channel` ∈ {`stable`,`dev`} derived from build metadata (`build-info.json` CHANNEL,
`main.js:33-38`). **Missing/malformed channel identity fails closed** (no provision, no
activation, no schedule — surface an error); it never defaults to `stable`. Layout:

```
~/.repo-radar/<channel>/
  generations/
    <app-version>-<interp-fingerprint>/     # IMMUTABLE once complete
      venv/  repo_radar/  repo-radar  .runtime.json
  current -> generations/<...>              # the single ACTIVATION POINTER
  run-sync.sh                               # generic self-verifying runner (§3.4)
  .lock.d/                                  # atomic lock directory (§3.3)
  provision.log                             # redacted, 0600
```

**Ownership (Codex R2-1):**
- **CLI:** stable owns `~/.local/bin/repo-radar`; dev owns `~/.local/bin/repo-radar-dev`.
  A dev build never writes/replaces the stable `repo-radar` command.
- **Schedule:** **stable is the sole owner of the persistent user LaunchAgent**
  (`com.user.repo-radar`) that syncs the shared data plane (config schedule, status file,
  cache, pristine repos). **Dev does not infer/install a persistent schedule from shared
  config**; dev scheduled sync, if ever needed, is an explicit, clearly-namespaced,
  transient smoke agent (`com.user.repo-radar-dev`) a tester sets up deliberately — never
  auto-derived. This prevents two schedules racing on shared files (separate status ports
  do not prevent filesystem races). Fully namespacing the data plane is broader → Spec 2B.

Generation directories are **immutable and uniquely named** (`<version>-<fingerprint>`), so a
crash leaves a distinctly-named partial dir (GC'd as orphan), and a retry either **adopts** an
already-complete matching generation (after full validation, §3.3) or builds a fresh one —
never mutates a live generation.

### 3.2 Base interpreter selection + fingerprint (D3)

Resolve one base interpreter validated `>=3.10,<3.15`, to its **real executable**: probe
`/opt/homebrew/bin/python3`, `/usr/local/bin/python3`, then `pyenv which python3` (real
`~/.pyenv/versions/<x>/bin/python3`, not the shim), then a validated `PATH` `python3`. Probe
each with `python -c '...'` capturing version + `sys.implementation` + `platform.machine()`.
The venv is created from the winner; its own `bin/python` is used thereafter. The
**fingerprint** (real exe path, Python x.y.z, implementation/ABI tag, arch) is part of the
generation name and the marker; a changed fingerprint yields a new generation.

### 3.3 Cross-process lock, verification, crash-safe activation

**Lock protocol (Codex R2-3).** One mechanism usable by Electron (Node), `/bin/sh`, and the
CLI: **atomic lock-directory** `~/.repo-radar/<channel>/.lock.d` acquired via `mkdir` (atomic
create; `EEXIST` = held), containing `owner.pid`+`started_at` for **stale-owner recovery**
(dead PID or age > threshold → reclaim). Held for the **entire child lifetime** by any runner
(manual/scheduled/CLI) and **through activation** by provisioning. A generic runner acquires
the lock, resolves interpreter **and** launcher from `current` **once** under the lock,
verifies (below), execs the child **without releasing**, and cleans up on child exit — no
resolve→exec cutover window.

**Healthy predicate (Codex R2-4) — validates the ACTIVE payload, not just inputs.** A build's
`current` is valid iff, under the lock:
- `realpath(current)` is inside `~/.repo-radar/<channel>/generations/`;
- channel identity corroborated by build metadata **and** `app.getVersion()` (authoritative;
  fictitious fallback removed); missing/conflicting → fail closed;
- live `hashTree(current/repo_radar)` + launcher hash **equal** the marker **and** the bundled
  payload hash;
- the venv's **normalized installed distribution set exactly equals** the locked set
  (name==version for every dist; no extras, no substitutions — stronger than `pip check`);
- interpreter fingerprint of `current/venv/bin/python` matches the marker.
A **channel-level desired-state** (target = current build's identity) means an old healthy
`current` is **not** treated as valid after the new build's provisioning fails — it fails
closed (§6), never silently serves the previous generation to the new app.

**Crash-safe activation ordering (Codex R2-2).** Commit point = one atomic pointer flip, done
last:
1. Install/refresh **generic** self-verifying dispatchers: the CLI dispatcher(s) and
   `run-sync.sh`. They resolve `current` at run time and **fail closed** whenever the healthy
   predicate fails — so they are safe even before any valid `current` exists, and need no
   per-version rewrite.
2. **Migrate the legacy schedule:** `launchctl unload` the old `com.user.repo-radar` and
   repoint its plist at the new generic `run-sync.sh` (which fails closed until activation).
   This removes the **non-self-checking 1.0.26 wrapper** before a new generation exists.
3. **Provision** into `generations/<version>-<fingerprint>/` (adopt-if-complete-and-valid,
   else build fresh): create venv, `pip install --require-hashes -r <lock>`, copy source +
   launcher, smoke (import + exact-version asserts + installed-set capture), write
   `.runtime.json`.
4. **Flip `current`** atomically (temp symlink + `rename(2)` in the same dir — atomic on
   macOS) to the new generation. **This is the sole commit point.**
Install the stable `repo-radar` CLI dispatcher (generic, step 1) before retiring the legacy
launcher (§3.5). A crash after any step is safe: dispatchers fail closed until `current` is a
validated generation; orphan/partial generations are GC'd; retry adopts a complete-valid
generation or rebuilds.

**Reconcile entry:** `ensureRuntime()` runs early at startup and after
`update-downloaded`→relaunch; when the predicate already holds it is a fast no-op (no pip).

### 3.4 Manual / scheduled / CLI parity (one generic runner)

All three paths use the same runner contract (§3.3 lock + resolve-once + verify + exec-holding-
lock):
- **Manual** (`main.js`): acquire lock; resolve `current`; verify; `spawn(pythonBin,[launcher,
  'sync','--status-server'],{env:{…,PYTHONPATH:sourceDir}})`; release on exit.
- **Scheduled** (`run-sync.sh`, written atomically, generic): `#!/bin/sh` acquires the same
  lock-dir, resolves+verifies `current`, `exec`s the absolute venv python + launcher, traps to
  release. Fails closed (exit non-zero, logs) on any predicate failure — including the first
  upgrade before activation.
- **CLI** (`repo-radar` dispatcher): identical acquire→verify→exec-holding-lock.
Because provisioning holds the lock through the `current` flip, a runner sees either the old
generation fully or the new one fully — never a torn state. Concurrent runs serialize on the
lock (one sync at a time across the shared data plane).

### 3.5 Legacy migration + CLI continuity (Codex R2-1/R1-4)

- Stable installs the generic `repo-radar` dispatcher into `~/.local/bin` (atomic
  write) **before** retiring any legacy launcher; dev installs only `repo-radar-dev`.
- Retire a legacy top-level `~/.repo-radar/repo-radar` to `~/.repo-radar/legacy-<ts>/` only
  after the stable dispatcher is in place and the first activation succeeds.
- CLI invocation is in the acceptance matrix (§7).

### 3.6 Dependency lock — checked-in, hash-pinned, portable (Codex R2-5)

- The resolved lock is **checked into source control**, generated with `pip-compile
  --generate-hashes` (or `uv pip compile --generate-hashes`) — real `--require-hashes` input,
  covering direct + transitive deps. `pip freeze` is insufficient (no hashes).
- **Dependency updates regenerate the lock explicitly** (a documented make/skill step); the
  **build only verifies freshness** (lock resolves from current `requirements.txt`) and bundles
  it. No per-build re-resolution (reproducibility).
- **Portability decision (tested, not assumed):** target matrix = CPython 3.10–3.14 × {x86_64,
  arm64}. Produce **one universal lock** with environment markers + all-platform wheel hashes
  **iff** it installs cleanly (`--require-hashes`) across the full matrix in test; **otherwise
  per-Python-minor locks** (arch covered by multi-hash wheels), selected at provision by the
  resolved interpreter's fingerprint. If neither is clean, **narrow the supported interpreter
  matrix** and state it. The matrix install test (§7) decides and guards this.

---

## 4. Components / files (implementation preview)

- **New** `menubar/runtime-manager.js`: `ensureRuntime()`, generic-runner (`runSync`/dispatcher
  emit), `resolveBaseInterpreter()`, `authoritativeIdentity()`, lock-dir acquire/release +
  stale recovery, `provision()` (staging gen + hashed install + source copy + smoke + installed-
  set capture), payload+dist-set validation, atomic activation, legacy migration + CLI
  dispatcher, redacted logging, orphan-generation GC. Argument-array `spawn` only.
- `menubar/main.js`: call `ensureRuntime()`; replace `getSyncScriptPath()`/manual spawn with the
  runner; channel-namespace + stable-sole-owner the LaunchAgent; emit generic `run-sync.sh`;
  remove fictitious `getVersion()` fallback (fail closed); wire failure surface.
- **Repo:** checked-in `requirements.lock` (or per-minor locks) + a lock-freshness check;
  bundle the lock + `resources/repo_radar` via `extraResources`.
- `menubar/resources/setup.sh`: retired as an app dependency.
- **New tests** (§7).

## 5. Data flow

Fresh install / upgrade / crash-retry all funnel through §3.3's ordering: generic dispatchers +
migrated schedule first (fail-closed), provision an immutable generation, then the single
`current` flip. Upgrade from 1.0.26: the legacy non-self-checking wrapper is unloaded/repointed
(step 2) before a new generation is committed, so it cannot run the new bundle against the old
runtime. dev + stable each own their `<channel>/` tree; stable alone owns the persistent
schedule and `repo-radar`. Steady state: predicate holds → no pip → sync.

## 6. Failure / offline

Hard-block (D6): on any provisioning/validation failure the **new build's** sync/CLI fail closed
(never serve the old generation to the new app, per §3.3 desired-state); visible + actionable
(notification + error window, cause, **redacted** pip-log tail, Retry, remediation). All
`~/.repo-radar/**` created user-only (`0700`/`0600`); credentials in index URLs redacted before
storing/displaying (Codex R1-6).

## 7. Acceptance (sign-off bar)

**7a. Scripted logic harness** (temp `$HOME`, fast): interpreter resolution + gating;
authoritative-identity + channel fail-closed; lock-dir acquire/stale-recovery + hold-for-child-
lifetime (paused sync vs concurrent provisioning, both directions, Codex R2-3); healthy predicate
(active-payload hash, exact installed-set, desired-state); crash injection after **each** step of
§3.3 (including the verbatim 1.0.26 wrapper/bootstrap state) → recovery; adopt-vs-rebuild of an
existing generation; redaction.

**7b. Built-artifact packaged upgrade smoke** (locally built `.app`; resourcesPath, launchd,
signed paths with spaces, real identity):
1. Seed 1.0.26 state (legacy `~/.repo-radar/repo-radar`, the **verbatim 1.0.26 wrapper**, global
   `litellm==1.83.4`, no generations); install/run built 1.0.27.
2. Manual **and** `launchctl`-driven scheduled sync import `repo_radar` from
   `current/repo_radar`; `llm.DEFAULT_MODEL=='claude-sonnet-5'`.
3. Both envs: `sys.executable==current/venv/bin/python`, `litellm==1.93.0` (despite seeded 1.83.4).
4. `migrate_model('gpt-5.2-codex')=='gpt-5.3-codex'`, `get_fallback_model('o3') is None`,
   `KNOWN_LIMITS['gpt-5.4-mini']==1050000`.
5. **CLI continuity:** `repo-radar` on `PATH` runs the new runtime; dev build does **not** replace
   it and installs no duplicate production schedule.
6. **Crash recovery** after each cutover boundary → consistent state, sync works after relaunch.
7. **Tamper:** mutate `current/repo_radar` or the venv's installed set → next reconcile forces
   reprovision (fails the active-payload/installed-set check).
8. **Lock lifetime:** a sync holds the lock across its complete lifetime (concurrent provision
   waits; no torn cutover).
9. **Offline** provisioning → hard-block + Retry recovery; **partial/interrupted** provision →
   prior runtime intact, only orphan staging to GC.
10. **Clean hashed install across the declared matrix** (CPython 3.10–3.14 × x86_64/arm64) per the
    §3.6 decision.

SIP/quarantine + per-user `$HOME` isolation covered by 7b.

## 8. Resolved mechanics / decisions

- **Activation:** a single atomic `current` flip is the only commit point; generic self-verifying
  dispatchers + legacy-schedule migration precede it.
- **Lock:** atomic lock-directory with PID/stale recovery, held for child lifetime and through
  activation; used identically by Electron, `/bin/sh`, CLI.
- **Ownership:** stable is sole owner of `repo-radar` + the persistent schedule; dev fully
  namespaced (`repo-radar-dev`, no auto persistent schedule); missing channel identity fails closed.
- **Lock artifact:** checked-in, `--generate-hashes`, portable-by-test (universal or per-minor);
  build verifies freshness only.
- D1 (JS provisioning, retire setup.sh), D3 (Homebrew→real pyenv exe→PATH, fingerprinted),
  D4 (async provision + central gate + fail-closed runner), D6 (hard-block), D7 (2A GCs only
  orphan/staging generations) — resolved.

## 9. Definition of done (production unblock)

`v1.0.27` is unblocked when §7b passes on a real 1.0.26 upgrade: manual, scheduled, and CLI runs
provably use the bundled 1.0.27 `repo_radar` + `litellm==1.93.0` from the channel+version
generation; the single-pointer activation is crash-safe at every boundary (incl. the verbatim
1.0.26 wrapper); the one cross-process lock serializes runs and provisioning; the CLI keeps
working; stable/dev coexist with no shared-CLI or duplicate-schedule mutation; tampered payloads
force reprovision; and the hashed lock installs cleanly across the declared matrix. Spec 2B
deferred.
