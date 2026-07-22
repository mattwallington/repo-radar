# Spec 2A — Packaged Python Runtime Binding (Repo Radar v1.0.27)

**Status:** rev 5 — addresses Codex R4 blockers 1–3 + minors. Locking, desired-state
ordering, and dev/legacy interaction are the last-touched sections; the dependency-lock
design is settled (Codex R4). For Codex Round 5. Do NOT implement or merge into `dev`
before the Spec 1 (`feature/model-refresh-2026`) dev-prerelease smoke completes.

**Branch:** `feature/runtime-binding-v1.0.27` (cut from `dev` @ `6621882`).

**Goal:** Guarantee that a given installed Repo Radar *build* (channel + version) always
runs its own bundled Python package against its own fully-resolved, version-bound
dependencies — on fresh install, upgrade, rollback, crash-recovery, and dev/stable
coexistence, for manual, scheduled, and CLI runs. Sole production blocker for `v1.0.27`.

---

## 1. Scope

**In scope (2A):** dependency binding from checked-in, hash-pinned, per-environment lock(s)
into a channel+build-bound venv; interpreter binding (real executable, fingerprinted); source
binding (copy into a nonce-unique immutable generation); ownership (one activation pointer per
channel; **stable** solely owns the `repo-radar` CLI, the persistent schedule, schedule config,
and legacy migration; **dev** fully namespaced); kernel-backed locking (a root **execution**
lock across channels + a per-channel **activation** lock, via `/usr/bin/lockf -k`); crash-safe
activation via a published intent record (`desired.json`) whose publication is the first
fallible mutation, plus one atomic pointer flip; verifiable identity against a real-install
expected-distribution manifest; CLI continuity; failure/offline hard-block; scripted logic
harness + built-artifact packaged upgrade smoke.

**Out of scope (Spec 2B):** broader updater UX; signing/notarization; Electron upgrade; CI
release hardening beyond a lock-freshness check; dev/prod gate semantics; wheel vendoring;
full data-plane namespacing (2A: stable-sole-schedule + shared root execution lock); GC of
successful previously-activated generations.

---

## 2. As-is gaps (`dev` @ `6621882`)

`setup.sh` orphaned + global pip (`setup.sh:33-57`); no post-update hook (`main.js:1851-1918`);
prefers stale `~/.repo-radar/repo-radar` (`main.js:88`); manual (`:1028`) vs scheduled
(`:1547-1548`) interpreter divergence; no marker; no channel namespacing; unsafe `getVersion()`
fallback (`:11-26`); `~/.local/bin/repo-radar` public CLI (`setup.sh:37`); **the installed
1.0.26 wrapper has no self-check and honors no lock**.

---

## 3. Design

### 3.1 Ownership, layout, intent record

`channel` ∈ {`stable`,`dev`} from build metadata; **missing/malformed channel identity fails
closed**. **Stable** solely owns `~/.local/bin/repo-radar`, the persistent LaunchAgent
(`com.user.repo-radar`), schedule configuration, and **all legacy (1.0.26) migration/quiescence**
(Codex R4-3). **Dev** owns `repo-radar-dev`, never writes `repo-radar`, never persists schedule
fields / invokes schedule IPC on shared config, and installs no persistent schedule (dev
scheduled sync = a deliberately-installed transient `com.user.repo-radar-dev` agent only).

```
~/.repo-radar/
  .exec.lock                          # ROOT execution lock file (lockf -k); all sync children
  <channel>/
    .activation.lock                  # per-channel provisioning/activation lock file (lockf -k)
    desired.json                      # published INTENT (atomic; first fallible mutation)
    generations/<version>-<fingerprint>-<nonce>/   # IMMUTABLE, unique; venv/ repo_radar/ repo-radar .runtime.json
    current -> generations/<...>      # single ACTIVATION POINTER (commit point)
    run-sync.sh                       # generic self-verifying runner (0700)
    provision.log                     # redacted (0600)
```

`desired.json` (per channel, atomic temp+rename, schema-versioned) is the Electron provisioner's
authoritative intent: channel, complete build identity (`app.getVersion()` corroborated with
bundled `VERSION`), target generation id, and expected source/launcher/lock hashes.
**Electron-less shell/CLI runners validate `current` + its marker only against `desired.json`.**
An unsupported/incompatible `desired.json` schema fails closed.

### 3.2 Base interpreter + generation identity

Resolve one base interpreter validated `>=3.10,<3.15` to its **real executable**
(`/opt/homebrew`→`/usr/local`→`pyenv which`→validated `PATH`); fingerprint = {real exe, Python
x.y.z, implementation/ABI, arch}. Each provision creates a **nonce-unique** generation
`<version>-<fingerprint>-<nonce>`, so same-version rebuilds, source/lock changes, and tampered
dirs never collide the destination; `desired.json`/`current` reference the generation by name.

### 3.3 Locking, activation transitions, verification, quiescence

**Locks — kernel-backed `lockf -k` (Codex R4-1).** macOS `/usr/bin/lockf -k <lockfile> <command>`
takes an exclusive advisory lock for the command's lifetime and the **kernel auto-releases it if
the holder dies** — eliminating owner records, stale-owner recovery, the ownerless-init window,
and the `exec`/trap problem entirely. Two persistent lock files:
- **Root execution lock** `~/.repo-radar/.exec.lock` — every sync child (manual/scheduled/CLI,
  either channel) runs *through* `lockf -k -t <timeout>`, serializing the shared data plane.
- **Per-channel activation lock** `~/.repo-radar/<channel>/.activation.lock` — provisioning runs
  its critical section through `lockf -k`.
Disjoint in normal flow (a sync holds root; provisioning holds channel) → no deadlock; if both
are ever required, order **root before channel**. A sync child that needs provisioning **must
not wait on it while holding root** — it queues the request and the provisioner runs after the
child exits (Codex R4 pt c). `bin/sh`/CLI acquire the same way (`lockf -k … <python> <launcher>
…`); Electron runs helpers under `lockf`. (Diagnostics-only metadata, if any, uses
`kern.bootsessionuuid`, not formatted `kern.boottime`.)

**Two activation transitions (Codex R4-2).** Publication of `desired.json` is the **first
fallible state mutation** so a newly-installed build can never keep serving the previous runtime:
- **Legacy 1.0.26 bootstrap** (no `desired.json`, non-cooperating legacy jobs): stable quiesces
  the legacy jobs (below) → installs generic dispatchers + repoints the schedule → **publishes the
  first `desired.json`**. Before publication there is no `desired.json`, so generic dispatchers
  fail closed (nothing runs) — safe on crash.
- **Already-managed update / rollback** (generic dispatchers already installed): acquire root
  then channel lock, **wait for any in-flight sync**, **publish the new `desired.json` first**,
  then provision, then flip. After publication and until the flip, runners see `current`≠`desired`
  and **fail closed** — so the interval after the `.app` is replaced never serves the prior
  build's Python. **Direction-agnostic** (upgrade or rollback) when schemas are compatible;
  incompatible schema fails closed.

**Crash-safe ordering** (commit point = the atomic `current` flip, last):
1. (legacy bootstrap only) quiesce legacy; install generic dispatchers + repoint schedule.
2. **Publish `desired.json`** (atomic) — fail-closed intent transition; first fallible mutation.
3. **Provision** the nonce-unique generation (adopt an already-complete generation only if its
   marker matches the *entire* desired identity, else build fresh): venv,
   `pip install --require-hashes -r <lock>`, copy source+launcher, smoke (import + exact-version
   asserts + installed-set == expected manifest), write `.runtime.json`.
4. **Flip `current`** atomically (temp symlink + `rename(2)`, same dir). Commit point.
Crash before step 2 → old `desired` still governs (legacy bootstrap: none yet → fail closed);
crash between 2 and 4 → runners fail closed; nonce dirs avoid collisions; retry adopts a
complete-matching generation or rebuilds. `ensureRuntime()` runs at startup + after
`update-downloaded`→relaunch; a no-op when healthy.

**Verification.** Under the appropriate lock, a runtime is valid iff: `realpath(current)` inside
the channel generations tree; `current` + marker match `desired.json`; live
`hashTree(current/repo_radar)` + launcher hash == marker == bundle; the venv's normalized
installed set == the **expected manifest** for its (Python-minor, arch); interpreter fingerprint
matches. Any miss → fail closed. A **channel desired-state** ensures a healthy *old* `current` is
never accepted for a *new* build whose provisioning failed.

**Legacy quiescence — stable-only, checked (Codex R4-3/R3-6).** Only the **stable** channel
migrates/quiesces the installed 1.0.26 stable jobs: synchronously `launchctl bootout`, verify the
label is absent **and** the child has exited, detect a running legacy *manual* sync (process scan
+ legacy statusfile), wait with timeout, else **fail closed without flipping `current`**. A **dev**
build must never touch the stable legacy agent; while an unmanaged 1.0.26 stable agent is loaded
(and thus ignores the root lock), **dev hard-blocks shared-data-plane sync with actionable
guidance** (upgrade stable first, or run dev in an isolated `HOME`).

### 3.4 Manual / scheduled / CLI parity (generic runner)

One runner for all three: resolve `realpath(current)` once; validate against `desired.json` +
the healthy predicate (fail closed otherwise); then run the child **through** `lockf -k -t <T>
~/.repo-radar/.exec.lock`: `<current>/venv/bin/python <current>/repo-radar sync --status-server`
with `PYTHONPATH=<current>/repo_radar`. `lockf` holds the root lock for the child's lifetime and
the kernel releases it on exit/death — no `exec`/trap hazard, no manual release. A generation a
running sync resolved stays retained (2A GC never removes activated generations), so a concurrent
`current` flip cannot pull it out from under an in-flight sync. Concurrent runs (any channel)
serialize on the root lock. The scheduled `run-sync.sh` is generic (no per-version rewrite).

### 3.5 Legacy migration + CLI continuity

Stable installs the generic `repo-radar` dispatcher (atomic) **before** retiring any legacy
launcher; dev installs only `repo-radar-dev`. Retire legacy `~/.repo-radar/repo-radar` →
`~/.repo-radar/legacy-<ts>/` only after the stable dispatcher is in place and the first activation
succeeds. CLI invocation is in §7.

### 3.6 Dependency lock(s) + expected manifests (settled; Codex R4 minor)

Checked-in, `--generate-hashes` lock(s) (`pip freeze` insufficient); dependency updates regenerate
explicitly; the build only **verifies freshness** and bundles. Matrix = CPython 3.10–3.14 ×
{x86_64, arm64}; **per-(Python-minor, arch) locks when the resolved graph differs**, else one
universal lock proven clean across the matrix. Requested **extras are explicit lock inputs**.
Each **expected-distribution manifest is generated and checked in from an actual clean,
hash-locked install on the target environment** (not static marker evaluation alone, which can
miss platform-specific wheel metadata), with bootstrap tooling (`pip`/`setuptools`/`wheel`)
pinned or allow-listed at recorded versions. Provision selects lock+manifest by interpreter
fingerprint; freshness verification independently recreates and compares the manifest.

---

## 4. Components / files (implementation preview)

**New** `menubar/runtime-manager.js`: `ensureRuntime()` (both transitions), generic-runner emit +
Node runner (via `lockf`), `resolveBaseInterpreter()`, `authoritativeIdentity()`/`publishDesired()`,
`quiesceLegacyStable()`, `provision()` (nonce gen + hashed install + source copy + smoke +
installed-set vs expected manifest), atomic activation, legacy migration + CLI dispatcher, redacted
logging, incomplete/invalid-generation GC. `menubar/main.js`: call `ensureRuntime()`; replace spawn
with the `lockf` runner; channel-namespace + stable-sole-own the schedule; emit generic `run-sync.sh`;
drop the fictitious `getVersion()` fallback; dev hard-block vs unmanaged legacy. **Repo:** checked-in
per-env lock(s) + expected manifests + freshness check, bundled via `extraResources`. `setup.sh`
retired as an app dependency.

## 5. Data flow

Legacy bootstrap and managed update/rollback both make `desired.json` publication the first fallible
mutation, then provision the nonce generation, then flip `current`. Stable alone migrates the legacy
1.0.26 jobs and owns the schedule + `repo-radar`; dev is namespaced and hard-blocks while an unmanaged
legacy stable agent is loaded. Every sync child (either channel) serializes on the root `lockf` lock.
Steady state: predicate holds → no pip → sync.

## 6. Failure / offline

Hard-block (D6): on any provisioning/validation/quiescence/schema failure the **new build's** sync/CLI
fail closed (never serve the old generation to the new build); visible + actionable (notification +
error window, cause, **redacted** pip-log tail, Retry, remediation). Perms: directories + executables
(`run-sync.sh`, dispatchers) `0700`; data files (`desired.json`, `.runtime.json`, logs) `0600`.

## 7. Acceptance

**7a. Scripted logic harness** (temp `$HOME`): interpreter resolution/gating; authoritative identity +
`desired.json` publish/atomicity/schema-fail-closed; **`lockf` mutual exclusion incl. auto-release when
the holder is killed** (regresses the exec/trap orphan and the long-sync-not-reclaimed case) + root-vs-
activation ordering + sync-triggered-provision-stays-async; healthy predicate incl. installed-set ==
expected manifest + bootstrap allow-list; **transition ordering** crash cases — before publish, between
publish and flip, **crash-before-dispatcher-refresh**, and **downgrade/rollback**; nonce generation
collision (same-version/different-source; **tampered active generation → build replacement, flip, then
retain old as non-adoptable — never mutate the active generation before its replacement is committed**,
Codex R4 minor); redaction.

**7b. Built-artifact packaged upgrade smoke** (locally built **stable** `.app`, isolated upgrade
environment; resourcesPath, launchd, signed paths with spaces, real identity):
1. Seed 1.0.26 stable state incl. the verbatim 1.0.26 wrapper and **a running legacy scheduled child
   AND a running legacy manual child**; install/run built 1.0.27 → quiescence proven before activation.
2–4. Manual + `launchctl` scheduled sync import `repo_radar` from `current/repo_radar`;
   `DEFAULT_MODEL=='claude-sonnet-5'`; both envs `sys.executable==current/venv/bin/python` +
   `litellm==1.93.0`; `migrate_model('gpt-5.2-codex')=='gpt-5.3-codex'`, `get_fallback_model('o3') is
   None`, `KNOWN_LIMITS['gpt-5.4-mini']==1050000`.
5. **CLI:** `repo-radar` runs the new runtime.
6. **Crash recovery** after each cutover boundary; **downgrade/rollback** to a prior managed build.
7. **Tamper** → next reconcile builds a replacement generation, flips, retains the old (no active-gen
   mutation pre-flip).
8. **Lock lifetime + cross-channel serialization:** stable-scheduled vs another sync contend on the
   root lock (both directions); killing a holder auto-releases.
9. **Offline** → hard-block + Retry; **partial/interrupted** provision → prior runtime intact, only an
   orphan generation to GC.
10. **Matrix hashed install** across CPython 3.10–3.14 × **native** arm64/x86_64, installed set == the
    checked-in expected manifest (§3.6).
11. **dev/stable coexistence:** run the dev transient-agent test **only after both runtimes honor the
    root lock**; a deliberately-installed transient `com.user.repo-radar-dev` agent, once removed, is
    proven to have never changed stable's plist/config; verify dev **hard-blocks** while an unmanaged
    legacy stable agent is loaded.

SIP/quarantine + per-user `$HOME` isolation covered by 7b.

## 8. Resolved mechanics

Locks = kernel-backed `lockf -k` (root execution + per-channel activation), auto-released on death —
no owner records or stale recovery. Activation = publish `desired.json` (first fallible mutation) →
provision nonce generation → single atomic `current` flip; two transition flavors (legacy bootstrap,
managed update/rollback), direction-agnostic on compatible schemas, else fail closed. Verification =
active-payload hashing + installed-set vs a real-install expected manifest. Ownership = stable sole
owner of `repo-radar` + schedule + config + legacy migration; dev namespaced and hard-blocks vs an
unmanaged legacy stable agent; channel-missing fails closed. Generations = nonce-unique immutable
dirs. GC = only incomplete/invalid never-activated generations (retain activated); no refcount/grace
needed. D1/D3/D4/D6/D7 resolved. Dependency-lock design settled (Codex R4).

## 9. Definition of done

`v1.0.27` is unblocked when §7b passes on a real 1.0.26 stable upgrade (incl. running legacy children)
in an isolated environment: manual, scheduled, and CLI runs provably use the bundled 1.0.27
`repo_radar` + `litellm==1.93.0` from the channel+version generation; activation is crash-safe at every
boundary and for downgrade/rollback; `lockf` serializes provisioning and all data-plane syncs with
kernel auto-release; the CLI keeps working; stable/dev coexist with dev hard-blocking against an
unmanaged legacy agent; tampered payloads force a replacement generation without pre-flip mutation; and
the hashed lock installs clean across the declared matrix against the checked-in expected manifest.
Spec 2B deferred.
