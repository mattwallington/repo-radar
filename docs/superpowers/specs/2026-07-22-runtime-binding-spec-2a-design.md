# Spec 2A — Packaged Python Runtime Binding (Repo Radar v1.0.27)

**Status:** rev 7 — addresses Codex R6 (the `VERSION`-in-generation invariant + wording minors).
Codex R6: the architecture is converged and, with the `VERSION` invariant added, "no further
architectural review should be needed." For a final Codex plan-ready confirmation. Do NOT implement
or merge into `dev` before the Spec 1 (`feature/model-refresh-2026`) dev-prerelease smoke completes.

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
lock across channels + a per-channel **activation** lock, via `/usr/bin/lockf` in fd mode); crash-safe
activation via a published intent record (`desired.json`) whose publication is the first
managed-update / activation-intent mutation, plus one atomic pointer flip; verifiable identity against a real-install
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
  .exec.lock                          # ROOT execution lock file (lockf, fd mode); all sync children
  <channel>/
    .activation.lock                  # per-channel provisioning/activation lock file (lockf, fd mode)
    desired.json                      # published INTENT (atomic; first managed-update/activation-intent mutation)
    generations/<version>-<fingerprint>-<nonce>/   # IMMUTABLE, unique; venv/ repo_radar/ repo-radar VERSION .runtime.json
    current -> generations/<...>      # single ACTIVATION POINTER (commit point)
    run-sync.sh                       # generic self-verifying runner (0700)
    provision.log                     # redacted (0600)
```

`desired.json` (per channel, atomic temp+rename, schema-versioned) is the Electron provisioner's
authoritative intent: channel, complete build identity (`app.getVersion()` corroborated with
bundled `VERSION`), target generation id, and expected source/launcher/**VERSION**/lock hashes.
**Electron-less shell/CLI runners validate `current` + its marker only against `desired.json`.**
An unsupported/incompatible `desired.json` schema fails closed.

### 3.2 Base interpreter + generation identity

Resolve one base interpreter validated `>=3.10,<3.15` to its **real executable**
(`/opt/homebrew`→`/usr/local`→`pyenv which`→validated `PATH`); fingerprint = {real exe, Python
x.y.z, implementation/ABI, arch}. Each provision creates a **nonce-unique** generation
`<version>-<fingerprint>-<nonce>`, so same-version rebuilds, source/lock changes, and tampered
dirs never collide the destination; `desired.json`/`current` reference the generation by name.

### 3.3 Locking, activation transitions, verification, quiescence

**Locks — kernel-backed `lockf` in file-descriptor mode (Codex R5-1).** Plain
`lockf <file> <command>` couples the lock to the *lockf* process, not the worker: killing the
lockf parent releases the lock while its child keeps running (Codex verified) — a cancelled
sync could then run unprotected against the shared data plane. So the lock is held on an
**inherited file descriptor** that rides the eventual worker across `exec`, so the lock lifetime
== the worker's lifetime and the kernel releases it only when the worker dies:
```sh
exec 9>"$lock_path"           # open the persistent lock file on fd 9
/usr/bin/lockf -t "$policy" 9 || exit $?   # lock fd 9 (or exit 75 = EX_TEMPFAIL on timeout)
# … resolve + verify current INSIDE the lock (below) …
exec "$python" "$launcher" "$@"            # inherits locked fd 9; lock == python's lifetime
```
The Node provisioning helper uses the same fd-mode shape. Two persistent lock files:
- **Root execution lock** `~/.repo-radar/.exec.lock` — every sync child (manual/scheduled/CLI,
  either channel) runs under it, serializing the shared data plane.
- **Per-channel activation lock** `~/.repo-radar/<channel>/.activation.lock` — provisioning holds
  it through activation.
Disjoint in normal flow → no deadlock; if both are ever required, order **root before channel**.
A sync child that needs provisioning **must not wait on it while holding root** — it queues the
request and the provisioner runs after the child exits. **Lock policy (Codex R5 minor):** sync
entry points acquire with `-t 0` (non-blocking); exit `75` = "another sync is running" (scheduled
runs log a benign skip; manual/CLI surface a "busy" notice). Managed activation waits on the root
lock **asynchronously with visible status/cancellation**, never a silent hang. (Diagnostics-only
metadata, if any, uses `kern.bootsessionuuid`.)

**Two activation transitions (Codex R4-2).** `desired.json` publication is the **first
managed-update mutation** (and, after a legacy bootstrap, the **first activation-intent
mutation**) so a newly-installed build can never keep serving the previous runtime:
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
2. **Publish `desired.json`** (atomic) — fail-closed intent transition; first managed-update /
   activation-intent mutation.
3. **Provision** the nonce-unique generation (adopt an already-complete generation only if its
   marker matches the *entire* desired identity, else build fresh): venv,
   `pip install --require-hashes -r <lock>`, **copy bundled source + launcher + `VERSION`** into the
   generation root (Codex R6-1: `repo_radar/__init__.py` reads `../VERSION`, i.e. `<current>/VERSION`;
   without it the package silently reports `1.0.0`), smoke (import + exact-version
   asserts + installed-set == expected manifest), write `.runtime.json`.
4. **Flip `current`** atomically (temp symlink + `rename(2)`, same dir). Commit point.
Crash before step 2 → old `desired` still governs (legacy bootstrap: none yet → fail closed);
crash between 2 and 4 → runners fail closed; nonce dirs avoid collisions; retry adopts a
complete-matching generation or rebuilds. `ensureRuntime()` runs at startup + after
`update-downloaded`→relaunch; a no-op when healthy.

**Verification.** Under the appropriate lock, a runtime is valid iff: `realpath(current)` inside
the channel generations tree; `current` + marker match `desired.json`; live
`hashTree(current/repo_radar)` + launcher hash + **`current/VERSION` value/hash** == marker ==
bundle (and the runtime's `repo-radar --version` must equal `app.getVersion()`); the venv's normalized
installed set == the **expected manifest** for its (Python-minor, arch); interpreter fingerprint
matches. Any miss → fail closed. A **channel desired-state** ensures a healthy *old* `current` is
never accepted for a *new* build whose provisioning failed.

**Legacy quiescence — stable-only, checked (Codex R4-3/R3-6).** Only the **stable** channel
migrates/quiesces the installed 1.0.26 stable jobs: synchronously `launchctl bootout`, verify the
label is absent **and** the child has exited, detect a running legacy *manual* sync (process scan
+ legacy statusfile), wait with timeout, else **fail closed without flipping `current`**. A **dev**
build must never touch the stable legacy agent. **Dev may share the real data plane only when
stable is provably *managed*** — i.e. stable has a compatible managed runtime/dispatcher that
demonstrably honors the root lock (Codex R5-3). Proving "no LaunchAgent is currently loaded" is
insufficient: an unloaded-but-installed 1.0.26 stable app, or a legacy manual sync, can start after
the check and ignores the root lock. Dev's detection is **read-only** — inspect stable's
`desired.json`/dispatcher identity, the plist, `launchctl print gui/$UID/com.user.repo-radar`, the
installed stable `VERSION`, and running legacy processes — and **any legacy stable install/state or
detection ambiguity means "unmanaged" → dev fails closed** with actionable guidance (upgrade stable
first, or run dev in an isolated `HOME`/test user).

### 3.4 Manual / scheduled / CLI parity (generic runner)

One generic runner for all three, in strict **lock-first-then-resolve** order (Codex R5-2): it
**acquires the root execution lock first** (fd-mode, §3.3), and **only after acquisition** does it
resolve `realpath(current)`, read `desired.json`, and validate the marker/payload against the
healthy predicate — failing closed on any mismatch. **No `current` path is interpolated into the
command before the lock is held**, so a managed update that publishes+flips while the runner was
blocked on the lock is seen *after* acquisition: the runner then resolves the new generation, not a
stale pre-lock one. It then `exec`s `<current>/venv/bin/python <current>/repo-radar sync
--status-server` with `PYTHONPATH=<current>` (the generation root that *contains* `repo_radar/`,
so `import repo_radar` resolves and its `../VERSION` lookup finds `<current>/VERSION`; executing
`<current>/repo-radar` already puts `<current>` on `sys.path`, so PYTHONPATH is belt-and-braces),
inheriting the locked fd so the lock ==
the worker's lifetime. A generation a running sync resolved stays retained (2A GC never removes
activated generations), so a concurrent flip cannot pull it out from under an in-flight sync.
Concurrent runs (any channel) serialize on the root lock. The scheduled `run-sync.sh` is generic
(no per-version rewrite).

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
`quiesceLegacyStable()`, `provision()` (nonce gen + hashed install + source + launcher + **VERSION**
copy + smoke + installed-set vs expected manifest), atomic activation, legacy migration + CLI
dispatcher, redacted
logging, incomplete/invalid-generation GC. `menubar/main.js`: call `ensureRuntime()`; replace spawn
with the `lockf` runner; channel-namespace + stable-sole-own the schedule; emit generic `run-sync.sh`;
drop the fictitious `getVersion()` fallback; dev hard-block vs unmanaged legacy. **Repo:** checked-in
per-env lock(s) + expected manifests + freshness check, bundled via `extraResources`. `setup.sh`
retired as an app dependency.

## 5. Data flow

Legacy bootstrap and managed update/rollback both make `desired.json` publication the first
managed-update / activation-intent mutation, then provision the nonce generation, then flip `current`. Stable alone migrates the legacy
1.0.26 jobs and owns the schedule + `repo-radar`; dev is namespaced and hard-blocks on **any
unmanaged or ambiguous stable state** (not merely a *loaded* legacy agent). Every sync child (either
channel) serializes on the root `lockf` lock.
Steady state: predicate holds → no pip → sync.

## 6. Failure / offline

Hard-block (D6): on any provisioning/validation/quiescence/schema failure the **new build's** sync/CLI
fail closed (never serve the old generation to the new build); visible + actionable (notification +
error window, cause, **redacted** pip-log tail, Retry, remediation). Perms: directories + executables
(`run-sync.sh`, dispatchers) `0700`; data files (`desired.json`, `.runtime.json`, logs) `0600`.

## 7. Acceptance

**7a. Scripted logic harness** (temp `$HOME`): interpreter resolution/gating; authoritative identity +
`desired.json` publish/atomicity/schema-fail-closed; **`lockf` fd-mode mutual exclusion** — lock rides
the worker's inherited descriptor: killing the **outer runner** leaves **no** Python descendant active
while another acquisition succeeds (Codex R5-1), `-t 0` returns `75` when busy, long-running holder not
reclaimed; **lock-first-then-resolve** — pause a runner immediately before lock acquisition, complete a
managed update (publish B → flip), then prove the runner resolves generation **B, not A**, after
acquiring (Codex R5-2); root-vs-activation ordering + sync-triggered-provision-stays-async; healthy
predicate incl. installed-set ==
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
5. **CLI + version identity (Codex R6-1):** `repo-radar` runs the new runtime and
   `repo-radar --version` (and the help banner) == `app.getVersion()` — **not `1.0.0`** — because the
   generation carries `current/VERSION`; **upgrade and rollback both report the activated version**.
6. **Crash recovery** after each cutover boundary; **downgrade/rollback** to a prior managed build.
7. **Tamper** (source, venv set, **or `current/VERSION`**) → next reconcile builds a replacement
   generation, flips, retains the old (no active-gen mutation pre-flip).
8. **Lock lifetime + cross-channel serialization:** stable-scheduled vs another sync contend on the
   root lock (both directions); killing a holder auto-releases.
9. **Offline** → hard-block + Retry; **partial/interrupted** provision → prior runtime intact, only an
   orphan generation to GC.
10. **Matrix hashed install** across CPython 3.10–3.14 × **native** arm64/x86_64, installed set == the
    checked-in expected manifest (§3.6).
11. **dev/stable coexistence:** run the dev transient-agent test **only after stable is provably
    managed** (both runtimes honor the root lock); a deliberately-installed transient
    `com.user.repo-radar-dev` agent, once removed, is proven to have never changed stable's
    plist/config. Verify dev **fails closed** not only when a legacy stable agent is *loaded* but also
    when it is **unloaded-but-installed** or detection is **ambiguous** (Codex R5-3) — dev requires an
    isolated `HOME` in those cases.

SIP/quarantine + per-user `$HOME` isolation covered by 7b.

## 8. Resolved mechanics

Locks = kernel-backed `lockf` in **fd mode** (root execution + per-channel activation), the lock
riding the worker's inherited descriptor so its lifetime == the worker's and the kernel releases on
death — no owner records or stale recovery; runners acquire **before** resolving `current`. Activation = publish `desired.json` (first managed-update /
activation-intent mutation) → provision nonce generation → single atomic `current` flip; two transition flavors (legacy bootstrap,
managed update/rollback), direction-agnostic on compatible schemas, else fail closed. Verification =
active-payload hashing (source + launcher + **`VERSION`**, so `repo-radar --version` ==
`app.getVersion()`) + installed-set vs a real-install expected manifest. Ownership = stable sole
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
