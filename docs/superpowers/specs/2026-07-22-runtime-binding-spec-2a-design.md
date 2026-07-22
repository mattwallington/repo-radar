# Spec 2A — Packaged Python Runtime Binding (Repo Radar v1.0.27)

**Status:** rev 4 — addresses Codex R3 blockers 1–6 + minors. For Codex Round 4. Do NOT
implement or merge into `dev` before the Spec 1 (`feature/model-refresh-2026`)
dev-prerelease smoke completes.

**Branch:** `feature/runtime-binding-v1.0.27` (cut from `dev` @ `6621882`).

**Goal:** Guarantee that a given installed Repo Radar *build* (channel + version) always
runs its own bundled Python package against its own fully-resolved, version-bound
dependencies — on fresh install, upgrade, crash-recovery, and dev/stable coexistence, for
manual, scheduled, and CLI runs — so the Spec 1 model refresh (and future Python-side
changes) reach users. Sole production blocker for `v1.0.27`.

---

## 1. Scope

**In scope (2A):** dependency binding from a checked-in, hash-pinned, portable lock into a
channel+build-bound venv; interpreter binding (real executable, fingerprinted); source
binding (copy into a nonce-unique immutable generation); an ownership model (one activation
pointer per channel; stable is sole owner of the `repo-radar` CLI, the persistent schedule,
and schedule config; dev fully namespaced); a two-tier lock (per-channel **activation** lock
+ one **root execution** lock serializing the shared data plane across channels); crash-safe
activation via a published intent record + a single atomic pointer flip; verifiable identity
against a precomputed expected-distribution manifest; checked legacy **quiescence**; CLI
continuity; failure/offline hard-block (redacted, correct perms); scripted logic harness +
built-artifact packaged upgrade smoke.

**Out of scope (Spec 2B):** broader updater UX; signing/notarization; Electron upgrade; CI
release hardening beyond a lock-freshness check; dev/prod gate semantics; wheel vendoring for
offline first-run; **full data-plane namespacing** (2A uses stable-sole-schedule + a shared
root execution lock); **GC of successful previously-activated generations** (2A deletes only
incomplete/invalid never-activated generations).

---

## 2. As-is gaps (file:line on `dev` @ `6621882`)

`setup.sh` orphaned + global pip, no venv (`setup.sh:33-57`); no post-update hook
(`main.js:1851-1918`); prefers stale `~/.repo-radar/repo-radar` (`main.js:88`); manual
(`main.js:1028`) vs scheduled (`main.js:1547-1548`) interpreter divergence; no marker; no
channel namespacing; unsafe `getVersion()` fallback (`main.js:11-26`); `~/.local/bin/repo-radar`
public CLI (`setup.sh:37`); **the installed 1.0.26 wrapper has no self-check and honors no lock**.

---

## 3. Design

### 3.1 Ownership, layout, intent record

`channel` ∈ {`stable`,`dev`} from build metadata; **missing/malformed channel identity fails
closed** (never defaults to stable). Ownership (Codex R2-1/R3-2): **stable** solely owns the
`repo-radar` CLI, the persistent LaunchAgent, and **schedule configuration**; **dev** owns
`repo-radar-dev` and never persists schedule fields, invokes schedule IPC on shared config, or
installs a persistent schedule (dev scheduled sync is only a deliberately-installed transient
`com.user.repo-radar-dev` agent).

```
~/.repo-radar/
  .exec.lock.d/                       # ROOT execution lock (all sync children, both channels)
  <channel>/
    .activation.lock.d/               # per-channel provisioning/activation lock
    desired.json                      # published INTENT (atomic; the fail-closed transition)
    generations/
      <version>-<fingerprint>-<nonce>/  # IMMUTABLE, uniquely named; venv/ repo_radar/ repo-radar .runtime.json
    current -> generations/<...>      # single ACTIVATION POINTER (commit point)
    run-sync.sh                       # generic self-verifying runner (0700)
    provision.log                     # redacted (0600)
```

`desired.json` (per channel, atomically written temp+rename, schema-versioned) is the
Electron provisioner's authoritative statement of the current build's intent — channel,
complete build identity (`app.getVersion()` corroborated with bundled `VERSION`), and the
expected source/launcher/lock hashes + generation id. **Electron-less shell/CLI runners
validate `current` + its marker only against `desired.json`** (they have no app object,
Codex R3-3).

### 3.2 Base interpreter + generation identity

Resolve one base interpreter validated `>=3.10,<3.15` to its **real executable**
(`/opt/homebrew`→`/usr/local`→`pyenv which`→validated `PATH`), fingerprint =
{real exe, Python x.y.z, implementation/ABI, arch}. Each provision creates a **nonce-unique**
generation dir `<version>-<fingerprint>-<nonce>` (Codex R3-4) so a same-version rebuild,
source/lock change, or a tampered dir never collides with the destination; `desired.json`/
`current` reference the specific generation by name.

### 3.3 Locks, verification, crash-safe activation, quiescence

**Two locks (Codex R3-2), both = atomic lock-directory (`mkdir`; usable by Node, `/bin/sh`,
CLI):**
- **Root execution lock** `~/.repo-radar/.exec.lock.d` — held by ANY sync child (manual/
  scheduled/CLI, either channel) for its full lifetime; serializes the shared data plane
  (config/status/cache/pristine).
- **Per-channel activation lock** `~/.repo-radar/<channel>/.activation.lock.d` — held by
  provisioning through activation.

Global order (deadlock-free): if both are ever needed, acquire **root before channel**. Normal
flow holds only one (a sync holds root; provisioning holds channel), so they don't contend.

**Lock ownership + staleness (Codex R3-1).** The lock dir contains an owner record:
`{boot_session_token, pid, proc_start_token, nonce}` (boot session from `kern.boottime`;
`proc_start_token` from the process start time). Reclaim **only** when the owner is *provably
gone*: different boot session, or PID dead, or PID alive but `proc_start_token` mismatched
(PID reuse). **Age is diagnostic only — never a reclaim trigger** (a long sync keeps its lock).
A just-created dir without a complete owner record gets a short grace window; reclaim removes a
dir **only** by matching its nonce (never blindly `rmdir` a dir another process just recreated).

**Shell runner cleanup (Codex R3-1, verified).** `/bin/sh` `exec` replaces the shell, so a
post-`exec` EXIT trap never runs and would orphan the lock. Runners therefore **spawn + wait**
(not `exec`): start the child, forward signals (`TERM`/`INT`) to it, `wait`, release the lock
(nonce-matched), and return the child's exit status. (Alternatively a token-aware child helper
owns cleanup; the spec picks spawn+wait.)

**Expected-distribution verification (Codex R3-5).** "Installed set == locked set" is defined
against a **precomputed expected manifest** for the *selected environment*: evaluate the lock's
PEP 508 markers for the venv's (Python-minor, arch), yielding a canonical
`{name==version}` manifest, **plus an explicit bootstrap allow-list** (`pip`/`setuptools`/
`wheel` with recorded versions). Verification compares the venv's normalized installed set to
that expected manifest (not to a marker captured from the same install). Per-(Python-minor,
arch) locks + manifests are used when the graph differs (§3.6).

**Healthy predicate** (under the relevant lock): `realpath(current)` inside the channel
generations tree; `current` + its marker match **`desired.json`**; live
`hashTree(current/repo_radar)` + launcher hash == marker == bundle; venv installed set ==
expected manifest; interpreter fingerprint matches. Any miss → fail closed.

**Legacy quiescence (Codex R3-6) — a checked phase, not a request.** Before provisioning a new
build: synchronously `launchctl bootout`/unload the legacy `com.user.repo-radar`, then **verify
the job label is absent and its child has exited**; also detect a running legacy *manual* sync
(process scan for the legacy launcher/interpreter + legacy statusfile) and wait with timeout.
If quiescence cannot be proven, **fail closed without flipping `current`.**

**Crash-safe activation ordering** (single commit point = the atomic `current` flip):
1. Quiesce legacy (above); fail closed if not quiescent.
2. Install/refresh **generic** self-verifying dispatchers (CLI + `run-sync.sh`) and the
   stable LaunchAgent plist pointing at the generic `run-sync.sh` (fails closed until valid).
3. **Publish `desired.json`** (atomic) — the explicit fail-closed *intent* transition: after
   publish, until the flip, generic runners see `current`≠`desired` and fail closed.
4. **Provision** into the nonce-unique generation (adopt an already-complete generation only if
   its marker matches the *entire* desired identity, else build fresh): venv,
   `pip install --require-hashes -r <lock>`, copy source+launcher, smoke (import + exact-version
   asserts + installed-set == expected manifest), write `.runtime.json`.
5. **Flip `current`** atomically (temp symlink + `rename(2)`, same dir). Commit point.
Crash at any step is safe: dispatchers fail closed until `current`==`desired`==a validated
generation; a crash before publish leaves old `desired` (old runtime still valid for the old
build); a crash between publish and flip fails closed (no runtime served); nonce-unique dirs
avoid destination collisions; retry adopts a complete-matching generation or rebuilds.
`ensureRuntime()` runs at startup + after `update-downloaded`→relaunch; a no-op when healthy.

### 3.4 Manual / scheduled / CLI parity (generic runner)

All three use one runner: acquire **root execution lock** (own-record + stale recovery) →
resolve `current` + validate against `desired.json` and the healthy predicate **once** under
the lock → **spawn+wait** the child (`current/venv/bin/python current/repo-radar sync
--status-server`, `PYTHONPATH=current/repo_radar`) forwarding signals → release lock (nonce
match) → return child status. No `exec`; no resolve→run window; concurrent runs (any channel)
serialize on the root lock. The scheduled `run-sync.sh` is generic (no per-version rewrite) and
fails closed whenever the predicate fails — including the first upgrade before activation.

### 3.5 Legacy migration + CLI continuity

Stable installs the generic `repo-radar` dispatcher (atomic) **before** retiring any legacy
launcher; dev installs only `repo-radar-dev` and never writes `repo-radar`. Retire legacy
`~/.repo-radar/repo-radar` → `~/.repo-radar/legacy-<ts>/` only after the stable dispatcher is in
place and the first activation succeeds. CLI invocation is in §7.

### 3.6 Dependency lock(s) — checked-in, hash-pinned, per-environment

- Checked-in, `--generate-hashes` lock(s) (`pip freeze` insufficient). Dependency updates
  regenerate explicitly (documented step); the **build only verifies freshness** and bundles.
- **Environment matrix:** CPython 3.10–3.14 × {x86_64, arm64}. Produce **per-(Python-minor,
  arch)** locks **and** their precomputed expected-distribution manifests when the resolved
  graph differs across the matrix; a single universal lock+manifest is used only if it is proven
  clean across the whole matrix by the §7 test. Provision selects the lock/manifest by the
  resolved interpreter fingerprint. Bootstrap tooling (`pip`/`setuptools`/`wheel`) is pinned or
  allow-listed with recorded versions. The matrix install test runs on **native (or equivalent)
  arm64 and x86_64** and compares the installed set to the **expected manifest**, not a
  self-captured marker.

---

## 4. Components / files (implementation preview)

**New** `menubar/runtime-manager.js`: `ensureRuntime()`, generic-runner emit + Node runner,
`resolveBaseInterpreter()`, `authoritativeIdentity()` + `publishDesired()`, lock-dir
acquire/release with owner-tuple + stale recovery, `quiesceLegacy()`, `provision()` (nonce gen +
hashed install + source copy + smoke + installed-set vs expected manifest), atomic activation,
legacy migration + CLI dispatcher, redacted logging, orphan/invalid-generation GC. `menubar/
main.js`: call `ensureRuntime()`; replace spawn with the runner; channel-namespace + stable-sole-
own the schedule; emit generic `run-sync.sh` (spawn+wait); drop fictitious `getVersion()`
fallback. **Repo:** checked-in per-env lock(s) + expected manifests + freshness check; bundle via
`extraResources`. `setup.sh` retired as an app dependency.

## 5. Data flow

Fresh/upgrade/crash-retry funnel through §3.3: quiesce legacy → generic dispatchers + migrated
schedule → publish `desired.json` → provision nonce generation → single `current` flip. The
1.0.26 wrapper/manual sync is proven quiescent before a new generation is committed. dev+stable
each own their `<channel>/` tree; stable alone owns the schedule + `repo-radar`; every sync
child (either channel) serializes on the root execution lock. Steady state: predicate holds →
no pip → sync.

## 6. Failure / offline

Hard-block (D6): on any provisioning/validation/quiescence failure the **new build's** sync/CLI
fail closed (never serve the old generation to the new build, per `desired.json`); visible +
actionable (notification + error window, cause, **redacted** pip-log tail, Retry, remediation).
Perms (Codex minor): directories and executables (`run-sync.sh`, dispatchers) `0700`; data files
(`desired.json`, `.runtime.json`, logs) `0600`; all under `~/.repo-radar`.

## 7. Acceptance

**7a. Scripted logic harness** (temp `$HOME`): interpreter resolution/gating; authoritative
identity + `desired.json` publish/atomicity + channel fail-closed; **lock owner-tuple + stale
recovery** (dead PID, PID reuse via start-token, reboot via boot session, long-running owner NOT
reclaimed, grace for ownerless new dir, nonce-matched removal); **shell runner releases the lock
after the child exits** (regression for the `exec`/trap bug) + signal forwarding; root-exec vs
per-channel-activation ordering; healthy predicate incl. **installed-set == expected manifest**
and bootstrap allow-list; **desired-state ordering** crash cases (before/after publish, between
publish and flip); nonce-unique **generation collision** (same-version/different-source,
tampered generation → quarantine+rebuild); redaction.

**7b. Built-artifact packaged upgrade smoke** (locally built `.app`; resourcesPath, launchd,
signed paths with spaces, real identity):
1. Seed 1.0.26 state incl. the **verbatim 1.0.26 wrapper** and **an already-running legacy
   scheduled child AND an already-running legacy manual child** (Codex R3-6); install/run built
   1.0.27 → quiescence proven before activation.
2–4. Manual + `launchctl` scheduled sync import `repo_radar` from `current/repo_radar`;
   `DEFAULT_MODEL=='claude-sonnet-5'`; both envs `sys.executable==current/venv/bin/python` +
   `litellm==1.93.0`; `migrate_model('gpt-5.2-codex')=='gpt-5.3-codex'`, `get_fallback_model('o3')
   is None`, `KNOWN_LIMITS['gpt-5.4-mini']==1050000`.
5. **CLI:** `repo-radar` runs the new runtime; **dev build never replaces `repo-radar` nor
   installs a persistent schedule**; a deliberately-installed transient `com.user.repo-radar-dev`
   agent, once removed, is proven to have never changed stable's plist/config.
6. **Crash recovery** after each cutover boundary → consistent state; sync works after relaunch.
7. **Tamper** `current/repo_radar` or the venv set → next reconcile reprovisions.
8. **Lock lifetime + cross-channel serialization:** a stable-scheduled sync and a dev-manual sync
   contend on the root execution lock (both directions); no concurrent data-plane access; no torn
   cutover.
9. **Offline** → hard-block + Retry recovery; **partial/interrupted** provision → prior runtime
   intact, only orphan generation to GC.
10. **Matrix hashed install** across CPython 3.10–3.14 × native arm64/x86_64, installed set
    compared to the **expected manifest** per §3.6.

SIP/quarantine + per-user `$HOME` isolation covered by 7b.

## 8. Resolved mechanics

Activation = single atomic `current` flip after `desired.json` publication (the fail-closed
intent transition), generic dispatchers, and proven legacy quiescence. Locks = two atomic
lock-directories (root execution + per-channel activation) with a boot-session/PID/start-token/
nonce owner tuple, provable-death staleness, and spawn+wait shell cleanup. Verification =
active-payload hashing + installed-set vs precomputed expected manifest. Ownership = stable sole
owner of `repo-radar` + schedule (+ config); dev namespaced; channel-missing fails closed.
Generations = nonce-unique immutable dirs. **GC (Codex minor): 2A deletes only incomplete/invalid
never-activated generations while holding the channel activation lock, and retains every complete
previously-activated generation; with that + a correctly-held lock, no refcount/grace is needed —
successful-runtime GC is 2B.** D1/D3/D4/D6/D7 resolved.

## 9. Definition of done

`v1.0.27` is unblocked when §7b passes on a real 1.0.26 upgrade (incl. running legacy children):
manual, scheduled, and CLI runs provably use the bundled 1.0.27 `repo_radar` + `litellm==1.93.0`
from the channel+version generation; activation is crash-safe at every boundary; the two locks
serialize provisioning and all data-plane syncs with safe ownership/recovery and correct shell
cleanup; the CLI keeps working; stable/dev coexist with no shared-CLI/schedule mutation; tampered
payloads force reprovision; and the hashed lock installs clean across the declared matrix against
the expected manifest. Spec 2B deferred.
