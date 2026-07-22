# Spec 2A — Packaged Python Runtime Binding (Repo Radar v1.0.27)

**Status:** rev 2 — addresses Codex R1 blockers 1–6 and resolves open decisions
D1/D3/D4/D6/D7. For Codex Round 2. Do NOT implement or merge into `dev` before the
Spec 1 (`feature/model-refresh-2026`) dev-prerelease smoke completes.

**Branch:** `feature/runtime-binding-v1.0.27` (cut from `dev` @ `6621882`).

**Goal:** Guarantee that a given installed Repo Radar app *build* (channel + version)
always runs its *own* bundled Python package against its *own* fully-resolved,
version-bound dependencies — on fresh installs, upgrades, and dev/stable coexistence,
for both manual ("Sync Now") and scheduled (LaunchAgent) syncs — so the Spec 1 model
refresh (and every future Python-side change) actually reaches users. Sole production
blocker for `v1.0.27`.

**Why a separate spec (2A):** Spec 1 refreshed the Python code and pinned
`litellm==1.93.0`, but nothing binds the running interpreter + installed deps to the
installed build. Codex flagged this as production-blocking. Pre-existing
updater-architecture gap, deliberately split from the model refresh.

---

## 1. Scope

### In scope (2A)
- **Dependency binding:** provision the app's dependencies from a **fully-resolved lock**
  into a **channel+version-bound, app-managed venv**, on fresh install and every build change.
- **Interpreter binding:** resolve ONE base Python 3 (`>=3.10,<3.15`) to its **real
  executable** (not a shim), fingerprint it, and always run syncs through the
  app-managed venv interpreter — never a `PATH`-resolved bare `python3`.
- **Source binding:** copy the shipped `repo_radar` package into the versioned runtime
  (version/hash-bound), so it stays coherent while the `.app` is swapped; always import
  that copy.
- **Channel isolation:** namespace runtime pointers, wrappers, and LaunchAgent identity
  by channel (stable vs dev) so the two builds never fight over one runtime/schedule.
- **Manual/scheduled parity + fail-closed scheduling:** both sync paths use the same
  interpreter/package/deps; the scheduled wrapper self-verifies build+runtime identity
  before running and fails closed on mismatch (launchd cannot be stopped by Electron state).
- **Transactional reconcile:** stage → smoke → atomic cutover under a cross-process lock,
  on launch and after auto-update; verifiable runtime identity (not just an input-file hash).
- **Legacy `~/.repo-radar` migration with CLI continuity:** retire a manually-installed
  launcher without breaking the `repo-radar` command on `PATH`.
- **Failure/offline behavior:** fail visibly + actionably (hard-block, redacted logs,
  restrictive perms); never silently run stale/missing deps.
- **Acceptance:** a scripted logic harness AND a **built-artifact packaged upgrade smoke**
  (Section 7).

### Out of scope (Spec 2B)
- Broader updater UX (channels UI, progress, rollback UX beyond runtime safety).
- Code signing / notarization changes; Electron version upgrade.
- `release.sh` / CI release hardening; dev-vs-prod gate channel semantics.
- Dependency **wheel vendoring** for fully-offline first-run (2A uses pip-at-provision
  against a resolved lock; locking does **not** require vendoring).
- Complete old-runtime garbage collection (2A deletes only abandoned staging dirs).

---

## 2. Current architecture (as-is) — gaps this spec closes

(file:line on `dev` @ `6621882`.)

1. **`setup.sh` orphaned** — bundled (`menubar/package.json:84-85`), never invoked; copies
   only the launcher; `pip install`s deps **globally** (no venv/`--target`) — `setup.sh:33-57`.
2. **Deps not build-bound** — `litellm==1.93.0` reaches a machine only via manual setup.sh
   or Troubleshooting pip; nothing re-installs on update (auto-updater has **no post-update
   hook**, `main.js:1851-1918`). `.app` swap updates bundled source + `VERSION`; site-packages
   untouched.
3. **`getSyncScriptPath()` prefers stale `~/.repo-radar/repo-radar`** (`main.js:88-91`).
4. **Manual vs scheduled interpreter divergence** — manual `/usr/bin/env python3`, pyenv-first
   (`main.js:963-969,1028`); wrapper prepends `/usr/local/bin:/opt/homebrew/bin` *after* pyenv
   (`main.js:1547-1548`) → different `python3` possible.
5. **No runtime marker** — staleness undetectable.
6. **No channel namespacing** — `~/.repo-radar`, `run-sync.sh`, LaunchAgent
   `com.user.repo-radar` are shared across stable and dev builds.
7. **Unsafe version identity** — `getVersion()` falls back to a fictitious default
   (`main.js:11-26`); unusable as authoritative runtime identity.
8. **`repo-radar` CLI is a public interface** — `~/.local/bin/repo-radar` symlink created by
   setup.sh (`setup.sh:37`); silently removing it breaks existing users.

---

## 3. Design

### 3.1 Channel + version namespaced, self-contained runtime

`channel` ∈ {`stable`,`dev`} derived from build metadata (`build-info.json` CHANNEL,
`main.js:33-38,130-153`). Everything runtime-related is namespaced by channel and version;
the versioned runtime **contains its own copy of the source** so it cannot skew against the
`.app` being replaced (Codex R1-2 strong rec):

```
~/.repo-radar/
  <channel>/                         # "stable" | "dev"
    runtimes/
      <app-version>/                 # e.g. 1.0.27
        venv/                        # venv from the resolved base interpreter
        repo_radar/                  # COPY of bundled resources/repo_radar (hash-bound)
        repo-radar                   # copy of the launcher
        .runtime.json                # fingerprint marker (§3.3)
    current -> runtimes/<app-version>
    run-sync.sh                      # scheduled wrapper (self-verifying, §3.4)
    provision.log                    # redacted (§6)
```

LaunchAgent identity is per channel: label `com.user.repo-radar` (stable) /
`com.user.repo-radar-dev` (dev); plist
`~/Library/LaunchAgents/com.user.repo-radar[-dev].plist`; wrapper
`~/.repo-radar/<channel>/run-sync.sh`. Stable and dev thus never mutate each other's
runtime, pointer, wrapper, or schedule. `~/.config/repo-radar/config.json` (credentials)
stays shared and unchanged.

### 3.2 Base interpreter selection + fingerprint (D3)

Resolve ONE base interpreter, validated `>=3.10,<3.15`, and **resolve it to its real
executable** (follow shims): probe order —
1. `/opt/homebrew/bin/python3`, then `/usr/local/bin/python3` (explicit, stable)
2. a pyenv interpreter resolved via `pyenv which python3` to the real
   `~/.pyenv/versions/<x>/bin/python3` (**not** the shim)
3. validated `python3` on the app launch `PATH`

Each candidate is probed with `python -c 'print(sys.version_info, sys.implementation.name,
platform.machine())'`. The venv is created from the winner; thereafter the venv's own
`bin/python` is used forever (immune to `PATH`/shim retargeting). The marker records an
**interpreter fingerprint**: real executable path, Python version, implementation/ABI tag,
architecture. On each launch the base+venv interpreter is revalidated (still exists,
same fingerprint); a changed fingerprint forces reprovision.

### 3.3 Transactional reconcile (lock → stage → smoke → atomic cutover)

`ensureRuntime()` runs early in startup and after `update-downloaded`→relaunch. It is the
single reconciliation point and is **cross-process-safe**:

```
identity = authoritativeIdentity()          # app.getVersion(); REQUIRE bundled VERSION match
                                             # (Codex R1-3); missing/conflicting → fail closed
lock = acquireExclusive(~/.repo-radar/<channel>/.lock)   # flock; scheduled wrapper honors it too
marker = read(current/.runtime.json)
if marker.ok
   and marker.identity == identity
   and marker.lock_sha256 == sha256(resources/requirements.lock)
   and marker.source_sha256 == hashTree(resources/repo_radar)
   and marker.interp_fingerprint == probe(venv python)
   and `pip check` clean:
       → up-to-date; ensure `current`/wrapper/CLI point here; release lock; done
else:
       stage = runtimes/<version>.staging-<pid>/
       create venv (from §3.2 base); pip install --require-hashes -r resources/requirements.lock
       copy resources/repo_radar -> stage/repo_radar ; copy launcher
       SMOKE: import repo_radar; assert exact critical versions
              (litellm==1.93.0, …) via importlib.metadata; run `pip check`;
              record installed distribution set (name==version list)
       write stage/.runtime.json{ ok, identity, lock_sha256, source_sha256,
                                  interp_fingerprint, dist_set, provisioned_at }
       ATOMIC CUTOVER: rename(stage -> runtimes/<version>); atomically repoint `current`;
              atomically (tmp+rename) write run-sync.sh (§3.4); update CLI dispatcher (§3.5)
       on any failure: leave prior runtime intact; write failure state; surface (§6)
       release lock
```

- **Idempotent + fast when healthy** (marker + hashes + `pip check`; no pip).
- **Identity is authoritative** (app.getVersion() ∧ bundled VERSION match); the fictitious
  `getVersion()` fallback is removed and made fail-closed.
- **Dependency identity is real:** installs from a resolved, hash-pinned lock (§3.6);
  the marker records the installed distribution set, not just an input-file hash.
- All state files/dirs created with user-only perms (§6).

### 3.4 Manual/scheduled parity + fail-closed scheduled wrapper

A single `getRuntime(channel)` returns `{ pythonBin, sourceDir, launcher }` resolved
through `current`, used by BOTH paths:

- **Manual** (`main.js`): `spawn(runtime.pythonBin, [runtime.launcher, 'sync',
  '--status-server'], { env:{…, PYTHONPATH: runtime.sourceDir}, … })`. Absolute interpreter,
  no `/usr/bin/env python3`.
- **Scheduled wrapper** (`run-sync.sh`, written atomically): runs an **absolute** interpreter
  and, before exec, **self-verifies and fails closed** (Codex R1-2) — launchd cannot be
  gated by Electron state:
  ```sh
  #!/bin/sh
  # honor the reconcile lock; skip if a provision or sync holds it
  # read current/.runtime.json; require identity.app_version == installed VERSION
  #   and source_sha256 == hashTree(current/repo_radar); else log + exit non-zero (no sync)
  exec '<current>/venv/bin/python' '<current>/repo-radar' sync --status-server
  ```
  A stale wrapper left by a half-finished update thus refuses to run the wrong runtime
  against the new bundle. Manual entry points are centrally gated the same way (D4).
- **In-flight sync:** the exclusive lock serializes provision vs. sync; a sync already
  running keeps its own resolved runtime for its lifetime; a new run re-resolves `current`.

### 3.5 Legacy migration WITH CLI continuity (Codex R1-4)

The `repo-radar` command on `PATH` is a public interface and must not break:

- After a **successful** provision, atomically replace `~/.local/bin/repo-radar` with a
  small **stable dispatcher** that execs the active runtime:
  `exec "$HOME/.repo-radar/<channel>/current/venv/bin/python"
   "$HOME/.repo-radar/<channel>/current/repo-radar" "$@"`.
- Only then retire a legacy top-level `~/.repo-radar/repo-radar` to
  `~/.repo-radar/legacy-<ts>/` (recoverable), never before the replacement is healthy.
- CLI invocation is part of the acceptance matrix (§7).

### 3.6 Resolved dependency lock (build-time)

To make "pinned" a real guarantee (Codex R1-3), the build produces a fully-resolved,
hash-pinned lock `resources/requirements.lock` (e.g. `pip-compile`/`pip freeze` of
`requirements.txt` on the target Python), covering direct **and** transitive deps.
Provisioning installs with `--require-hashes -r requirements.lock`. The loose
`requirements.txt` remains the human-edited source; the lock is the provisioning input and
is bundled via `extraResources`. Regenerating the lock is a build step (a Spec 2A task),
not manual.

---

## 4. Components / files (implementation preview — not the review sign-off)

- **New** `menubar/runtime-manager.js` (CommonJS, D1 — JS orchestration, retire setup.sh):
  `ensureRuntime()`, `getRuntime()`, `authoritativeIdentity()`, `resolveBaseInterpreter()`,
  `provision()` (staging + venv + hashed pip + source copy + smoke + `pip check`),
  atomic cutover, lock (`flock`), marker read/write, hashing, legacy migration + CLI dispatcher,
  redacted logging. Argument-array `spawn` only.
- `menubar/main.js`: call `ensureRuntime()` in startup + after update; replace
  `getSyncScriptPath()`/manual spawn with `getRuntime()`; channel-namespace the LaunchAgent
  (label/plist/wrapper); emit the self-verifying wrapper; remove the fictitious `getVersion()`
  fallback (fail closed); wire failure → notification/error surface.
- **Build:** generate + bundle `resources/requirements.lock`; keep `resources/repo_radar`,
  `resources/requirements.txt` bundling (`menubar/package.json:82-108`).
- `menubar/resources/setup.sh`: retired as an app dependency (kept only as an optional manual
  aid, or removed).
- **New tests** (Section 7).

---

## 5. Data flow

- **Fresh install:** launch → `ensureRuntime()` no marker → stage+provision
  `stable/runtimes/1.0.27` (venv, hashed deps, source copy, smoke) → atomic cutover →
  CLI dispatcher installed → syncs use it.
- **Upgrade 1.0.26→1.0.27:** `.app` replaced → relaunch → new VERSION ≠ marker → stage new
  runtime → atomic cutover → wrapper regenerated → both sync paths import bundled 1.0.27
  `repo_radar` against `litellm==1.93.0`. If the old LaunchAgent fires mid-update, the stale
  wrapper **fails closed** (identity mismatch).
- **dev + stable coexistence:** each channel provisions under `~/.repo-radar/<channel>/…`
  and owns `com.user.repo-radar[-dev]`; neither repoints or reschedules the other.
- **Steady state:** marker + hashes + `pip check` pass → no pip → sync.

---

## 6. Failure / offline behavior

- **Hard-block (D6):** on provisioning failure (offline, pip/build error, hash mismatch, no
  valid interpreter, identity conflict), the prior runtime is left intact but the **new**
  build's sync is **disabled**; never run stale/missing deps. A previous runtime cannot
  satisfy version binding, so it is retained only for rollback — not used as a fallback.
- **Visible + actionable:** menubar notification + error window with cause, redacted log tail,
  a **Retry setup** action, and remediation (check network; install Python 3.10–3.14).
- **Security (Codex R1-6):** redact credentials in index URLs from any stored/displayed pip
  output; create all `~/.repo-radar/**` state with user-only perms (dirs `0700`, files `0600`).

---

## 7. Acceptance (sign-off bar)

### 7a. Scripted logic harness (fast, no packaging)
Unit-tests the pure logic in a temp `$HOME`: `resolveBaseInterpreter()` version gating +
real-exe resolution; authoritative-identity fail-closed; marker read/write + staleness
decision (identity, lock hash, source hash, interp fingerprint, `pip check`); lock/atomic
cutover ordering; legacy detection + CLI-dispatcher generation; redaction. An integration
variant actually stages a venv + hashed install and asserts idempotence (second run = no pip)
and the offline failure path.

### 7b. Built-artifact packaged upgrade smoke (production sign-off, Codex R1-5)
Against the **locally built** `.app` (exercises `process.resourcesPath`, signed paths with
spaces, launchd, real identity):
1. Seed a v1.0.26 state (`~/.repo-radar/repo-radar` legacy launcher, a global/site
   `litellm==1.83.4`, no `runtimes/`), install/run the built **1.0.27** app.
2. **Bundled import:** manual AND `launchctl`-driven scheduled sync both import
   `repo_radar` from the versioned runtime copy (assert `repo_radar.__file__` under
   `~/.repo-radar/<channel>/current/repo_radar`, and `llm.DEFAULT_MODEL=='claude-sonnet-5'`).
3. **Interpreter + litellm parity:** in BOTH envs `sys.executable ==
   .../current/venv/bin/python` and `importlib.metadata.version('litellm')=='1.93.0'`
   despite the seeded 1.83.4.
4. **New behavior:** from the runtime, `migrate_model('gpt-5.2-codex')=='gpt-5.3-codex'`,
   `get_fallback_model('o3') is None`, `KNOWN_LIMITS['gpt-5.4-mini']==1050000`.
5. **CLI continuity:** `repo-radar --version`/a no-op subcommand on `PATH` runs the new
   runtime (dispatcher), not a dangling path.
6. **Fail-closed under update race:** with a stale wrapper + mismatched identity, the
   scheduled wrapper exits non-zero and runs no sync.
7. **Offline provisioning:** PyPI unreachable → provisioning fails → sync disabled, error
   surface + Retry; retry after "network restored" recovers.
8. **Partial/interrupted provision:** killing mid-provision leaves the prior runtime intact
   and only a `*.staging-*` dir to GC; next launch recovers cleanly.
9. **dev + stable coexistence:** both installed; each syncs its own runtime; neither
   repoints/reschedules the other.

SIP/quarantine and per-user `$HOME` isolation are covered by 7b (real packaged app).

---

## 8. Resolved decisions (were open in rev 1)

- **D1 — provisioning primitive:** provision in JS via argument-array `spawn`; retire
  `setup.sh`. One orchestrator owns state, errors, and cutover.
- **D3 — base interpreter:** explicit Homebrew/`/usr/local` first, then a pyenv interpreter
  resolved to its **real executable** (not the shim), then validated `PATH` fallback;
  fingerprint + revalidate.
- **D4 — provision timing:** provision **asynchronously** (Electron stays responsive) but
  centrally gate every manual/missed-sync entry point and make the scheduled wrapper
  fail-closed until the marker is `ok`.
- **D6 — failure fallback:** hard-block + notify. No continuing on a previous runtime.
- **D7 — GC:** in 2A delete only abandoned `*.staging-*` dirs; retain successful old runtimes
  (rollback). Full runtime GC → Spec 2B.

---

## 9. Definition of done (production unblock)

`v1.0.27` is unblocked when §7b passes on a real upgrade from an installed 1.0.26: manual and
scheduled syncs provably run the bundled 1.0.27 `repo_radar` against `litellm==1.93.0` from
the channel+version runtime; the scheduled wrapper fails closed on identity mismatch; the
`repo-radar` CLI keeps working; dev/stable coexist without interference; and provisioning
failures are visible, redacted, and actionable. Spec 2B items remain deferred.
