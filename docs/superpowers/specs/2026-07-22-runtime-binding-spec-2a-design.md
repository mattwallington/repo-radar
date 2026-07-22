# Spec 2A — Packaged Python Runtime Binding (Repo Radar v1.0.27)

**Status:** Draft (rev 1) — for Codex review. Do NOT implement or merge into `dev`
before the Spec 1 (`feature/model-refresh-2026`) dev-prerelease smoke completes.

**Branch:** `feature/runtime-binding-v1.0.27` (cut from `dev` @ `6621882`).

**Goal:** Guarantee that a given installed Repo Radar app version always runs its
*own* bundled Python package against its *own* pinned dependencies — on both fresh
installs and upgrades, and for both manual ("Sync Now") and scheduled (LaunchAgent)
syncs — so that the Spec 1 model refresh (and every future Python-side change)
actually reaches users. This is the sole production blocker for `v1.0.27`.

**Why this is a separate spec (2A):** Spec 1 refreshed the Python *code* and pinned
`litellm==1.93.0`, but the app has no mechanism that binds the running Python
interpreter + installed dependencies to the installed app version. Codex's
whole-branch review flagged this as an Important, production-blocking defect. It is
a pre-existing updater-architecture gap, deliberately split out from the model
refresh.

---

## 1. Scope

### In scope (2A)
- **Dependency binding:** provision the app's pinned dependencies (`requirements.txt`,
  `litellm==1.93.0`, …) into an **app-version-bound, app-managed location**, on fresh
  install and on every version change.
- **Interpreter binding:** select and record ONE base Python 3 interpreter
  (validated `>=3.10,<3.15`), and always run syncs through the app-managed runtime's
  interpreter — never a bare `python3` whose resolution depends on ambient `PATH`.
- **Source binding:** always import the bundled `repo_radar` package that ships with
  the installed `.app`, never a stale copy.
- **Legacy `~/.repo-radar` migration:** stop preferring a manually-installed
  `~/.repo-radar/repo-radar` launcher that can shadow the version-matched runtime;
  migrate/retire it cleanly.
- **Manual/scheduled parity:** both the Electron `spawn` path and the LaunchAgent
  `run-sync.sh` wrapper must use the **same** interpreter, same package, same deps.
- **Reconcile lifecycle:** detect a stale/missing runtime (via a persisted marker)
  and (re)provision — on launch and after auto-update.
- **Failure/offline behavior:** when provisioning cannot complete (offline, pip
  failure, no valid interpreter), fail **visibly and actionably**; never silently run
  stale or missing dependencies.
- **Upgrade-from-v1.0.26 acceptance matrix** (Section 7) proving all of the above.

### Out of scope (deferred to Spec 2B)
- Broader auto-updater UX (channels, progress UI, rollback UX beyond runtime).
- Code signing / notarization changes.
- Electron version upgrade.
- `release.sh` / CI release hardening, and the dev-vs-prod gate channel semantics.
- Vendoring dependency wheels for fully offline first-run (noted as a 2B option;
  2A uses pip-at-provision).

---

## 2. Current architecture (as-is) — the gaps this spec closes

(From the architecture map; file:line refer to `dev` @ `6621882`.)

1. **`setup.sh` is orphaned.** Bundled (`menubar/package.json:84-85`) but never invoked
   by the app, installer, or build. It copies only the thin launcher to
   `~/.repo-radar/repo-radar`, does **not** copy the `repo_radar/` package, and
   `pip install`s deps **globally** (no venv, no `--target`) — `setup.sh:33-57`.
2. **Deps are not app-version-bound.** `litellm==1.93.0` reaches a machine only if a
   user manually runs setup.sh or the Troubleshooting `pip install`. Nothing
   re-installs on update — `main.js` auto-updater has **no post-update hook**
   (`main.js:1851-1918`). The `.app` swap updates bundled `resources/repo_radar` +
   `VERSION`, but site-packages `litellm` is untouched.
3. **`getSyncScriptPath()` prefers stale `~/.repo-radar/repo-radar`** over the bundled,
   version-matched copy (`main.js:88-91`).
4. **Manual vs scheduled interpreter divergence.** Manual spawns `/usr/bin/env python3`
   with pyenv shims first (`main.js:963-969,1028`); the LaunchAgent wrapper prepends
   `/usr/local/bin:/opt/homebrew/bin` *after* pyenv (`main.js:1547-1548`), so a
   different `python3` (different site-packages) can win. → "Sync Now" and scheduled
   syncs can use different litellm versions.
5. **No runtime version marker** (`main.js` / `setup.sh` write none) → staleness is
   undetectable.

---

## 3. Design

### 3.1 App-managed versioned runtime (chosen approach)

On launch, the app ensures a **versioned runtime** exists for the current app version
and provisions it if missing/stale. Layout under the existing `~/.repo-radar/`
convention (already removed on uninstall, `main.js:620-629`):

```
~/.repo-radar/
  runtimes/
    <app-version>/                 e.g. 1.0.27
      venv/                        python venv created from the chosen base python3
      .provisioned.json            marker: {app_version, requirements_sha256,
                                             python_version, base_interpreter,
                                             provisioned_at, status}
  current -> runtimes/<app-version>   (symlink to the active runtime)
```

- The **package** imported at runtime is always the bundled `resources/repo_radar`
  (ships with the `.app`, so it is inherently version-matched). `PYTHONPATH` points at
  the bundled `resources/` directory, exactly as today for the bundled case — we do
  **not** copy the package into `~/.repo-radar` (avoids a second stale-source path).
- The **interpreter** is always `~/.repo-radar/runtimes/<version>/venv/bin/python`.
- The **dependencies** live in that venv, installed from the bundled
  `resources/requirements.txt` (`litellm==1.93.0`, …).

**Why a versioned venv (not vendored wheels, not global pip):** it binds deps to the
app version, isolates from ambient site-packages, is rollback-friendly (old version's
venv remains until GC), and is far cheaper to build than vendoring litellm's transitive
tree. The cost — pip needs network at provision time — is handled by Section 6.

### 3.2 Interpreter selection (base python for the venv)

Provisioning resolves ONE base interpreter, validates `>=3.10,<3.15` (reusing
setup.sh's guard logic), records its absolute path in the marker, and creates the venv
from it. Resolution order (first valid wins), each probed by running
`python -c 'sys.version_info'`:
1. `~/.pyenv/shims/python3`
2. `/opt/homebrew/bin/python3`
3. `/usr/local/bin/python3`
4. `python3` on the app's launch `PATH`

The venv's own `bin/python` is then used forever after — immune to later `PATH`
changes. This single resolved interpreter is what BOTH sync paths use (§3.4), closing
the manual/scheduled divergence.

**Open decision D3 (for review):** whether to prefer a Homebrew/system python over a
pyenv shim (pyenv shims can retarget under the user's feet). Draft prefers pyenv first
to match today's manual-sync behavior; Codex may argue for a stabler base.

### 3.3 Reconcile lifecycle

A `ensureRuntime()` step runs early in app startup (before sync is enabled) and is the
single reconciliation point (covers upgrades too, since `quitAndInstall` restarts the
app into the new version):

```
appVersion = getVersion()
marker = read(~/.repo-radar/runtimes/<appVersion>/.provisioned.json)
reqHash = sha256(bundled resources/requirements.txt)
if marker.status == "ok"
   and marker.app_version == appVersion
   and marker.requirements_sha256 == reqHash
   and venv python still runnable:
       → up-to-date; point `current` symlink at it; done
else:
       → provision(appVersion): create/refresh venv, pip install -r bundled
         requirements.txt, run a smoke import, write marker{status:ok}, repoint
         `current`, regenerate run-sync.sh (§3.4).
       → on failure: write marker{status:failed, error}, surface actionable error (§6).
```

- Provisioning is **idempotent** and **fast when up-to-date** (marker + hash compare, no
  pip). It only pip-installs on a version/requirements change or a missing/broken venv.
- After a successful (re)provision, the app **regenerates the LaunchAgent wrapper**
  (`run-sync.sh`) so scheduled syncs pick up the new interpreter/runtime immediately.

**Open decision D4 (for review):** run provisioning synchronously on the first launch
after an update (blocking sync until done, with a visible "Setting up…" state) vs. in
the background with sync disabled until ready. Draft: background provision, sync
disabled with a clear status until the marker flips to `ok`.

### 3.4 Manual/scheduled parity

Introduce a single `getRuntime()` that returns
`{ pythonBin, syncScript, pythonPath }` from the active runtime, used by BOTH paths:

- **Manual** (`main.js` sync spawn): replace `spawn('/usr/bin/env', ['python3', …])`
  with `spawn(runtime.pythonBin, [runtime.syncScript, 'sync', '--status-server'], …)`,
  `PYTHONPATH = runtime.pythonPath` (bundled `resources/`).
- **Scheduled** (`run-sync.sh` generation): emit
  `exec '<runtime.pythonBin>' '<runtime.syncScript>' sync --status-server` — an
  **absolute interpreter path**, no `PATH`-based `python3` resolution, no pyenv/Homebrew
  prepend logic. Same `PYTHONPATH`.

Both now provably use the identical interpreter + deps. (Credential-freshness divergence
— scheduled bakes a snapshot, `main.js:1523-1538` — is a **separate** pre-existing issue;
noted, but only in-scope here to the extent the regenerated wrapper keeps working.)

### 3.5 Legacy `~/.repo-radar/repo-radar` migration

- `getSyncScriptPath()` no longer prefers a bare `~/.repo-radar/repo-radar` launcher.
  Resolution becomes: bundled `resources/repo-radar` (version-matched) → dev fallback.
  The app-managed runtime supersedes any manual install.
- If a legacy top-level `~/.repo-radar/repo-radar` (and PATH symlink
  `~/.local/bin/repo-radar`) exists from a prior manual setup.sh run, `ensureRuntime()`
  retires it (move to `~/.repo-radar/legacy-<timestamp>/` rather than delete, so a
  user's manual customization is recoverable) and logs the migration. The new
  `runtimes/` tree coexists under the same `~/.repo-radar/` root.

---

## 4. Components / files to touch (implementation preview — not part of review sign-off)

- **New** `menubar/runtime-manager.js` (CommonJS): `ensureRuntime()`, `getRuntime()`,
  `provision()`, `resolveBaseInterpreter()`, marker read/write, requirements hashing,
  legacy migration. Pure-ish logic + `child_process` for venv/pip.
- `menubar/main.js`: call `ensureRuntime()` in startup; replace `getSyncScriptPath()`
  preference + the manual spawn to use `getRuntime()`; regenerate `run-sync.sh` via
  `getRuntime()`; wire the failure state to a notification/error surface.
- `menubar/resources/setup.sh`: repurpose as the provisioning primitive the app invokes
  (create venv + pip install into a target dir), OR retire it in favor of in-JS
  provisioning. **Open decision D1.**
- `menubar/package.json`: ensure `resources/requirements.txt` + `resources/repo_radar`
  bundling stays correct (already present, `:82-108`).
- **New tests** (Section 7).

---

## 5. Data flow

- **Fresh install (no `~/.repo-radar`):** launch → `ensureRuntime()` finds no marker →
  provision `runtimes/1.0.27/venv` → pip install `litellm==1.93.0` … → smoke import →
  marker ok → syncs use the venv.
- **Upgrade from 1.0.26:** old `.app` replaced by 1.0.27 (deps untouched, possibly
  litellm 1.83.4 global / none) → relaunch → `ensureRuntime()` sees no
  `runtimes/1.0.27` marker (or a 1.0.26 marker) → provisions 1.0.27 venv →
  regenerates `run-sync.sh` → both sync paths now import bundled 1.0.27 `repo_radar`
  against `litellm==1.93.0`.
- **Steady state:** launch → marker matches version + reqs hash + venv healthy → no
  pip, instant → sync.

---

## 6. Failure / offline behavior

Provisioning can fail: offline (pip can't reach PyPI), pip resolution/build error, or
no interpreter in `[3.10,3.15)`.

- **Never silently run stale/missing deps.** On failure, the marker is written
  `status:failed` with the captured error, and sync is **disabled**.
- **Visible + actionable:** a menubar notification + the existing error window surface
  the failure with (a) the cause (offline / pip error / no valid python), (b) the
  captured pip log tail, (c) a **Retry setup** action, and (d) remediation text
  (check network; install a supported Python 3.10–3.14).
- **Last-good fallback — Open decision D6:** if a previous version's runtime venv exists
  and imports cleanly, do we (i) hard-block until 1.0.27 provisions, or (ii) allow
  continuing on the previous runtime with a persistent "running previous version's
  Python runtime" warning? Draft leans (i) block-and-notify for correctness (the whole
  point is version binding), with the previous venv retained only for quick rollback.

---

## 7. Acceptance matrix — upgrade from v1.0.26 (the review sign-off bar)

A scripted integration harness simulates a v1.0.26 install and an upgrade to 1.0.27,
then proves each item. The harness seeds a fake `$HOME` with: a legacy
`~/.repo-radar/repo-radar` launcher, a global/site python with `litellm==1.83.4`, and no
`runtimes/` tree; then runs `ensureRuntime()` for app version 1.0.27 against the bundled
1.0.27 resources.

1. **Bundled package import.** Both the manual-spawn env and the scheduled
   `run-sync.sh` env import `repo_radar` from the bundled `resources/repo_radar`
   (assert `repo_radar.__file__` under the app resources, and a 1.0.27-only symbol,
   e.g. `repo_radar.llm.DEFAULT_MODEL == 'claude-sonnet-5'`).
2. **Interpreter + litellm parity.** In BOTH sync environments,
   `sys.executable == ~/.repo-radar/runtimes/1.0.27/venv/bin/python` and
   `importlib.metadata.version('litellm') == '1.93.0'` — despite the seeded global
   `litellm==1.83.4`.
3. **New Python behavior executes.** From the provisioned runtime,
   `repo_radar.llm.migrate_model('gpt-5.2-codex') == 'gpt-5.3-codex'`,
   `get_fallback_model('o3') is None` (non-Gemini guard), and a context-window value
   corrected in Spec 1 (`gpt-5.4-mini == 1050000`) all resolve from the new package.
4. **Failure/offline is visible + actionable.** With PyPI unreachable (simulated),
   provisioning fails → marker `status:failed`, sync disabled, an error surface with the
   cause + Retry is produced; no sync runs against missing/stale deps.

Additional required checks:
- **Legacy migration:** the pre-existing `~/.repo-radar/repo-radar` is retired to
  `legacy-<ts>/` and no longer shadows the runtime; `getSyncScriptPath()` resolves to the
  bundled launcher.
- **Idempotence:** a second `ensureRuntime()` with an unchanged version/reqs performs no
  pip install (marker+hash short-circuit).

### Testing strategy
- **Unit (Node):** `resolveBaseInterpreter()` version gating, marker read/write,
  requirements hashing, staleness decision, legacy-path detection — pure logic, fast.
- **Integration (scripted):** the upgrade harness above, driving `ensureRuntime()` in a
  temp `$HOME`; asserts items 1–4 + migration + idempotence by actually creating a venv
  and pip-installing (network-gated; a `--offline` variant asserts item 4).
- **Manual smoke checklist:** the Electron UI surfaces (notification, error window,
  Retry) exercised once on a real upgrade over an installed 1.0.26.

---

## 8. Open decisions (for Codex + Matt)

- **D1 — provisioning primitive:** repurpose `setup.sh` as the venv+pip primitive the app
  invokes, vs. do provisioning entirely in JS (`child_process`). Trade-off: reuse vs. one
  less shell dependency + easier error capture.
- **D3 — base interpreter preference:** pyenv-shim-first (matches today) vs. Homebrew/
  system-first (stabler base).
- **D4 — provision timing:** background (sync disabled until ready) vs. blocking
  "Setting up…" on first launch after update.
- **D6 — failure fallback:** hard-block-and-notify vs. continue-on-previous-runtime-with-
  warning.
- **D7 — old-runtime GC:** when/whether to delete `runtimes/<old-version>` (keep N-1 for
  rollback? delete on successful new provision?).

---

## 9. Definition of done (production unblock)

`v1.0.27` production release is unblocked when: the acceptance matrix (Section 7) passes
on a real upgrade from an installed 1.0.26, manual and scheduled syncs both provably run
the bundled 1.0.27 `repo_radar` against `litellm==1.93.0` from the app-managed venv, and
provisioning failures are visible + actionable. Spec 2B items remain deferred.
