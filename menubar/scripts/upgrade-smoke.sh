#!/bin/bash
# Spec 2A Definition-of-Done gate: built-artifact packaged upgrade smoke (spec §7b).
#
# THIS IS AN OPERATOR RUNBOOK SCRIPT. It cannot run in CI unattended: it builds a
# signed .app, drives launchd, and seeds an isolated HOME with a v1.0.26 install and
# RUNNING legacy children. Run it on a real Mac with signing available, one channel at
# a time, and read menubar/scripts/upgrade-smoke.md first.
#
# It gates the PRODUCTION release of v1.0.27 (spec §9). A PASS proves the model refresh
# (Spec 1) actually reaches an upgraded user's Python runtime.
set -uo pipefail
FAIL=0
step() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
check() { if eval "$2"; then printf '  \033[32mPASS\033[0m %s\n' "$1"; else printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=1; fi; }
note()  { printf '  \033[33mNOTE\033[0m %s\n' "$1"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHANNEL="${CHANNEL:-stable}"                 # test one channel per run
LABEL="com.user.repo-radar"; [ "$CHANNEL" = dev ] && LABEL="com.user.repo-radar-dev"
CLI="repo-radar"; [ "$CHANNEL" = dev ] && CLI="repo-radar-dev"

# ── 1. Build the stable .app locally (no publish) ─────────────────────────────
step "1. Build $CHANNEL v1.0.27 .app"
note "Run in $REPO_ROOT/menubar:  REPO_RADAR_CHANNEL=$CHANNEL npm run build:version && npx electron-builder --mac dir"
note "This produces a SIGNED app in menubar/dist/mac*/ . Notarization is only needed for distribution, not this smoke."
APP="$(find "$REPO_ROOT/menubar/dist" -maxdepth 2 -name 'Repo Radar*.app' 2>/dev/null | head -1)"
check "built .app exists" "[ -n \"$APP\" ] && [ -d \"$APP\" ]"
RES="$APP/Contents/Resources"
check "bundle carries resources/repo_radar + repo-radar + requirements + pydeps + VERSION" \
  "[ -d \"$RES/resources/repo_radar\" ] && [ -f \"$RES/resources/repo-radar\" ] && [ -d \"$RES/resources/pydeps\" ] && [ -f \"$RES/VERSION\" ]"
check "build-info.json carries channel=$CHANNEL" \
  "[ \"\$(node -e \"console.log(require('$RES/app/build-info.json').channel)\" 2>/dev/null || node -e \"console.log(require('$APP/Contents/Resources/app.asar/build-info.json').channel)\")\" = \"$CHANNEL\" ]"

# ── 2. Isolated HOME seeded with a v1.0.26 install + RUNNING legacy children ──
step "2. Seed isolated HOME with v1.0.26 state"
SMOKE_HOME="$(mktemp -d /tmp/rr-smoke-home.XXXXXX)"
note "Using isolated HOME=$SMOKE_HOME (never touches your real ~)."
mkdir -p "$SMOKE_HOME/.repo-radar" "$SMOKE_HOME/.local/bin" "$SMOKE_HOME/Library/LaunchAgents" "$SMOKE_HOME/.config/repo-radar"
# legacy launcher (1.0.26 shape: only the launcher, deps global)
cat > "$SMOKE_HOME/.repo-radar/repo-radar" <<'EOF'
#!/usr/bin/env python3
import sys
from repo_radar.cli import main
sys.exit(main())
EOF
chmod +x "$SMOKE_HOME/.repo-radar/repo-radar"
ln -sf "$SMOKE_HOME/.repo-radar/repo-radar" "$SMOKE_HOME/.local/bin/repo-radar"
note "Install a GLOBAL litellm==1.83.4 into the interpreter the legacy launcher would use, to prove the new runtime overrides it."
note "Seed a legacy $SMOKE_HOME/.config/repo-radar/run-sync.sh + LaunchAgent plist (the 1.0.26 wrapper, no self-check),"
note "load it, and start a long-running legacy MANUAL sync child — so quiescence has real jobs to stop."

# ── 3. Launch the built 1.0.27 app against SMOKE_HOME; assert §7b items ───────
step "3. First launch of 1.0.27 -> reconcile"
note "Launch:  HOME=$SMOKE_HOME open -n \"$APP\"   (or run its binary with env HOME set). Wait for ensureRuntime to finish."
note "The app must prove legacy quiescence BEFORE activating (check its logs / that the legacy job+child are gone)."

GEN="$SMOKE_HOME/.repo-radar/$CHANNEL/current"
VENV_PY="$GEN/venv/bin/python"
check "a generation is active (current symlink resolves)" "[ -L \"$GEN\" ]"
check "(item 2) manual sync imports bundled repo_radar from the generation" \
  "[ \"\$(HOME=$SMOKE_HOME PYTHONPATH=$GEN $VENV_PY -c 'import repo_radar,os;print(os.path.realpath(repo_radar.__file__).startswith(os.path.realpath(\"$GEN\")))')\" = True ]"
check "(item 2) DEFAULT_MODEL==claude-sonnet-5 from the new package" \
  "[ \"\$(HOME=$SMOKE_HOME PYTHONPATH=$GEN $VENV_PY -c 'import repo_radar.llm as l;print(l.DEFAULT_MODEL)')\" = claude-sonnet-5 ]"
check "(item 3) venv litellm==1.93.0 despite seeded global 1.83.4" \
  "[ \"\$($VENV_PY -c 'import importlib.metadata as m;print(m.version(\"litellm\"))')\" = 1.93.0 ]"
check "(item 4) migrate_model('gpt-5.2-codex')==gpt-5.3-codex from the runtime" \
  "[ \"\$(PYTHONPATH=$GEN $VENV_PY -c 'import repo_radar.llm as l;print(l.migrate_model(\"gpt-5.2-codex\"))')\" = gpt-5.3-codex ]"
check "(item 4) get_fallback_model('o3') is None (non-Gemini guard)" \
  "[ \"\$(PYTHONPATH=$GEN $VENV_PY -c 'import repo_radar.llm as l;print(l.get_fallback_model(\"o3\"))')\" = None ]"
check "(item 4) KNOWN_LIMITS['gpt-5.4-mini']==1050000" \
  "[ \"\$(PYTHONPATH=$GEN $VENV_PY -c 'import repo_radar.llm as l;print(l.KNOWN_LIMITS[\"gpt-5.4-mini\"])')\" = 1050000 ]"
check "(item 5) $CLI --version == 1.0.27 (not 1.0.0), via the on-PATH dispatcher" \
  "[ -n \"\$(HOME=$SMOKE_HOME PATH=$SMOKE_HOME/.local/bin:\$PATH $CLI --version 2>/dev/null | grep -o 1\\.0\\.27)\" ]"

step "3b. Scheduled sync parity (launchctl)"
note "Trigger the scheduled run:  launchctl kickstart -k gui/\$(id -u)/$LABEL   (against HOME=$SMOKE_HOME)."
note "Assert the scheduled run also used $VENV_PY + litellm 1.93.0 (inspect its sync log under $SMOKE_HOME/Library/Logs/repo-radar/)."

# ── remaining §7b items are interactive / destructive; documented in the runbook ─
step "4. Remaining §7b assertions (see upgrade-smoke.md)"
note "(6) crash recovery after each cutover boundary + downgrade/rollback to a prior build"
note "(7) tamper current/repo_radar|venv|VERSION -> next launch rebuilds+flips, retains old"
note "(8) cross-channel root-lock serialization; killing a holder auto-releases"
note "(9) offline first-launch -> sync disabled + relaunch-to-retry; interrupted provision -> only staging orphan"
note "(10) MATRIX: run on native arm64 AND x86_64; installed set == checked-in expected manifest. UNCOVERED cells (cp311/cp314/all x86_64) currently fail closed — RELEASE BLOCKER, see resources/pydeps/README.md"
note "(11) dev/stable coexistence: dev fails closed vs unmanaged/unloaded-but-installed stable; dev transient agent removal leaves stable untouched"

step "Result"
rm -rf "$SMOKE_HOME" 2>/dev/null || true
if [ "$FAIL" = 0 ]; then printf '\033[32mAutomated checks PASSED\033[0m — complete the interactive items in upgrade-smoke.md before sign-off.\n'; else printf '\033[31mFAILURES above — do NOT release.\033[0m\n'; exit 1; fi
