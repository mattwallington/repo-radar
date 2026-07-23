# Spec 2A packaged upgrade smoke — runbook (spec §7b, the v1.0.27 DoD gate)

`upgrade-smoke.sh` automates the *checkable* assertions; several §7b items are interactive
(launchd, crash injection, offline, two-arch matrix) and are listed here. Run on a real Mac
with signing available. **This gate must pass on a real 1.0.26→1.0.27 upgrade before the
production release** — it is what proves the Spec 1 model refresh actually reaches an
upgraded user's Python runtime.

## Prereqs
- Signing identity available (the app builds signed in `dir` mode; notarization not needed for the smoke).
- Native **arm64** and **x86_64** Macs (or an equivalent) — the matrix item (10) must run on both.
- Do every step against an **isolated `HOME`** (the script uses `mktemp -d`) so your real `~/.repo-radar`, `~/.local/bin/repo-radar`, and `com.user.repo-radar` LaunchAgent are never touched.

## Run (two-mode: seed → launch → verify)
```
cd menubar
REPO_RADAR_CHANNEL=stable npm run build:version
npx electron-builder --mac dir                     # signed .app in menubar/dist/mac*/
APP="$(find dist -maxdepth 2 -name 'Repo Radar*.app' | head -1)"
H="$(mktemp -d /tmp/rr-smoke.XXXXXX)"              # isolated HOME — never your real ~

bash scripts/upgrade-smoke.sh --seed --home "$H"   # create the v1.0.26 starting state
# then complete the seed detail below (global litellm 1.83.4, legacy agent + running children),
HOME="$H" open -n "$APP"                            # launch 1.0.27; let ensureRuntime finish
bash scripts/upgrade-smoke.sh --verify --home "$H" --app "$APP"   # automated assertions
```
Repeat with `--channel dev` on a separate isolated HOME for the coexistence item.

## Seed detail (step 2) — the 1.0.26 starting state
1. `~/.repo-radar/repo-radar` — the verbatim 1.0.26 launcher (the script writes it).
2. A **global** `litellm==1.83.4` in the interpreter the legacy launcher resolves (`python3 -m pip install litellm==1.83.4`) — item 3 proves the new runtime overrides it.
3. The legacy scheduled wrapper `~/.config/repo-radar/run-sync.sh` + `~/Library/LaunchAgents/com.user.repo-radar.plist` (the 1.0.26 shape — **no self-check, honors no lock**); `launchctl bootstrap gui/$(id -u) …` it.
4. Start a **running legacy scheduled child** (`launchctl kickstart`) AND a **running legacy manual child** (`HOME=$SMOKE_HOME python3 ~/.repo-radar/repo-radar sync &`) so quiescence has real jobs to prove it stops.

## Interactive assertions (complete these — the script only NOTEs them)
- **(1) quiescence:** the app must boot out the legacy job, verify its label absent + child exited, before it flips `current`. If it can't quiesce, it must fail closed (no flip).
- **(3b) scheduled parity:** `launchctl kickstart -k gui/$(id -u)/com.user.repo-radar`; confirm the scheduled sync used `current/venv/bin/python` + `litellm==1.93.0` (its log under `$HOME/Library/Logs/repo-radar/`).
- **(6) crash recovery:** kill the app during provisioning and at each cutover boundary (after publish-desired, after provision, before/after the `current` flip); relaunch; assert it recovers to a consistent state and sync works. Then install an older build (rollback) and confirm it reports+runs the older version.
- **(7) tamper:** modify `current/repo_radar`, the venv's installed set, or `current/VERSION`; relaunch; assert a **replacement** generation is built + flipped and the old (tampered) one is retained, not mutated pre-flip.
- **(8) lock:** start a sync, then start another (manual + scheduled) — the second must serialize (exit 75 / wait). `kill -9` the holder and confirm the kernel auto-releases the lock so the next acquires.
- **(9) offline:** disconnect the network before first launch after an update; assert provisioning fails **closed** (sync disabled), the app surfaces the failure, and a **relaunch** (the current retry path — there is no in-app Retry button yet, see Residuals) recovers once online. Interrupt a provision mid-build; assert only a `*.staging-*` orphan remains and the prior runtime is intact.
- **(10) MATRIX:** run the smoke on **native arm64 and x86_64** and assert the venv's installed set equals the **checked-in expected manifest** for that `(python-minor, arch)`. All **10 cells** (CPython 3.10–3.14 × arm64/x86_64) are now generated and content-validated (`release.sh` preflight runs `pydeps.js --assert-matrix`); an interpreter outside the matrix still fails closed by design. See `resources/pydeps/README.md`.
- **(11) dev/stable coexistence:** with an **unmanaged or unloaded-but-installed** legacy stable present, a **dev** build must fail closed (require isolated HOME) rather than share the data plane. A deliberately-installed transient `com.user.repo-radar-dev` agent, once removed, must leave stable's plist/config untouched.

## Residuals to fold in before/with release
- **No in-app "Retry" button** — `runtimeDisabled` clears only on app relaunch (Task 14). Spec §6 called for a Retry action; today it's relaunch-to-retry. UX polish, not a correctness gap.
- **Matrix coverage** (item 10) is the hard release blocker — decide *cover the cells* vs *narrow the matrix* before shipping.

## Sign-off
All automated checks PASS **and** every interactive item above verified on both arches → Spec 2A DoD met → v1.0.27 production release is unblocked (subject to the Spec 1 07-23 lifecycle gate + vendor-date re-verify).
