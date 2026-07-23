#!/bin/bash
# Spec 2A packaged upgrade smoke — a real two-mode operator tool (Codex Minor 9).
# It does NOT self-fabricate an isolated HOME and check the untouched result; instead:
#
#   upgrade-smoke.sh --seed  --home <DIR>              # create a v1.0.26 starting state
#   ( operator launches the built 1.0.27 .app with HOME=<DIR>, lets ensureRuntime run )
#   upgrade-smoke.sh --verify --home <DIR> --app <APP> [--channel stable]
#                                                       # assert the automated §7b items
#
# The interactive/destructive items (launchd parity, crash injection, offline, the
# native-arch matrix, dev/stable coexistence) are in menubar/scripts/upgrade-smoke.md.
# This tool gates the PRODUCTION release (spec §9) — run it on a real signed build.
set -uo pipefail
MODE="" HOME_DIR="" APP="" CHANNEL="stable"
while [ $# -gt 0 ]; do case "$1" in
  --seed) MODE=seed;; --verify) MODE=verify;;
  --home) HOME_DIR="$2"; shift;; --app) APP="$2"; shift;; --channel) CHANNEL="$2"; shift;;
  *) echo "unknown arg: $1" >&2; exit 2;; esac; shift; done
[ -n "$MODE" ] && [ -n "$HOME_DIR" ] || { echo "usage: --seed|--verify --home <DIR> [--app <APP>] [--channel stable|dev]" >&2; exit 2; }
LABEL="com.user.repo-radar"; [ "$CHANNEL" = dev ] && LABEL="com.user.repo-radar-dev"
CLI="repo-radar"; [ "$CHANNEL" = dev ] && CLI="repo-radar-dev"

if [ "$MODE" = seed ]; then
  # A verbatim v1.0.26 starting state: legacy launcher on PATH, a stale global litellm,
  # and (optionally) the legacy LaunchAgent — so quiescence has real jobs to stop.
  mkdir -p "$HOME_DIR/.repo-radar" "$HOME_DIR/.local/bin" "$HOME_DIR/Library/LaunchAgents" "$HOME_DIR/.config/repo-radar"
  cat > "$HOME_DIR/.repo-radar/repo-radar" <<'EOF'
#!/usr/bin/env python3
import sys
from repo_radar.cli import main
sys.exit(main())
EOF
  chmod +x "$HOME_DIR/.repo-radar/repo-radar"
  ln -sf "$HOME_DIR/.repo-radar/repo-radar" "$HOME_DIR/.local/bin/repo-radar"
  echo "Seeded v1.0.26 state in $HOME_DIR."
  echo "Next: install a global litellm==1.83.4 into the interpreter the legacy launcher resolves,"
  echo "      seed+load the legacy $LABEL LaunchAgent (see upgrade-smoke.md), start a running legacy"
  echo "      manual sync, then launch the built 1.0.27 app with HOME=$HOME_DIR and re-run with --verify."
  exit 0
fi

# --verify
[ -n "$APP" ] && [ -d "$APP" ] || { echo "--verify needs --app <path to built .app>" >&2; exit 2; }
FAIL=0
pass(){ printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad(){ printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=1; }
chk(){ if eval "$2"; then pass "$1"; else bad "$1"; fi; }
RES="$APP/Contents/Resources"
GEN="$HOME_DIR/.repo-radar/$CHANNEL/current"; VENV_PY="$GEN/venv/bin/python"

echo "== bundle =="
chk "bundle carries repo_radar + repo-radar + verify.py + pydeps + VERSION" \
  "[ -d \"$RES/resources/repo_radar\" ] && [ -f \"$RES/resources/repo-radar\" ] && [ -f \"$RES/resources/verify.py\" ] && [ -d \"$RES/resources/pydeps\" ] && [ -f \"$RES/VERSION\" ]"

echo "== runtime activation =="
chk "a generation is active (current resolves)" "[ -L \"$GEN\" ]"
chk "desired.json is ACTIVE" "[ \"\$(node -e \"console.log(require('$HOME_DIR/.repo-radar/$CHANNEL/desired.json').status)\" 2>/dev/null)\" = active ]"
chk "manual + scheduled runtime = the versioned venv, litellm 1.93.0 (over any seeded 1.83.4)" \
  "[ \"\$($VENV_PY -c 'import importlib.metadata as m;print(m.version(\"litellm\"))' 2>/dev/null)\" = 1.93.0 ]"
chk "bundled repo_radar imported from the generation, DEFAULT_MODEL=claude-sonnet-5" \
  "[ \"\$(PYTHONPATH=$GEN $VENV_PY -c 'import repo_radar.llm as l;print(l.DEFAULT_MODEL)' 2>/dev/null)\" = claude-sonnet-5 ]"
chk "migration/fallback/context execute from the new package" \
  "[ \"\$(PYTHONPATH=$GEN $VENV_PY -c 'import repo_radar.llm as l;print(l.migrate_model(\"gpt-5.2-codex\"),l.get_fallback_model(\"o3\"),l.KNOWN_LIMITS[\"gpt-5.4-mini\"])' 2>/dev/null)\" = 'gpt-5.3-codex None 1050000' ]"
chk "$CLI --version reports the app version (not 1.0.0), via the on-PATH dispatcher" \
  "HOME=$HOME_DIR PATH=$HOME_DIR/.local/bin:\$PATH $CLI --version 2>/dev/null | grep -qF \"\$(cat \"$RES/VERSION\")\""
chk "the shipped verify.py passes the full predicate on the active generation" \
  "$VENV_PY \"$GEN/verify.py\" \"$GEN\" \"$HOME_DIR/.repo-radar/$CHANNEL/desired.json\" \"$GEN/manifest.json\""

echo
echo "Interactive items still required before sign-off (upgrade-smoke.md):"
echo "  launchd scheduled-sync parity; crash recovery per cutover boundary; downgrade/rollback;"
echo "  tamper->replacement; cross-channel lock serialization + kill-releases; offline hard-block+retry;"
echo "  native arm64 AND x86_64 matrix; dev/stable coexistence (dev fails closed vs unmanaged stable)."
echo
[ "$FAIL" = 0 ] && { echo -e "\033[32mAutomated verify PASSED\033[0m — complete the interactive items, then sign off."; exit 0; } \
                || { echo -e "\033[31mVERIFY FAILED — do NOT release.\033[0m"; exit 1; }
