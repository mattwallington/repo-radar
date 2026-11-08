#!/bin/bash
# release.sh - Release gates for Repo Radar. It no longer publishes: releases publish from GitHub
# Actions (see DEVELOPMENT.md, "Releasing").
# Usage: ./release.sh [--minor|--major|--dry-run|--help]
set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# ── Helpers ───────────────────────────────────────────────────────────────────

info()    { echo -e "${BLUE}[info]${NC}  $1"; }
success() { echo -e "${GREEN}[ok]${NC}    $1"; }
warn()    { echo -e "${YELLOW}[warn]${NC}  $1"; }
error()   { echo -e "${RED}[error]${NC} $1"; exit 1; }
step()    { echo -e "\n${BOLD}${CYAN}── $1 ──${NC}"; }
dry()     { echo -e "${YELLOW}[dry-run]${NC} $1"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DRY_RUN=false
BUMP_TYPE="patch"

# ── Parse args ────────────────────────────────────────────────────────────────

for arg in "$@"; do
  case "$arg" in
    --dry-run)  DRY_RUN=true ;;
    --minor)    BUMP_TYPE="minor" ;;
    --major)    BUMP_TYPE="major" ;;
    --help|-h)
      echo -e "${BOLD}Repo Radar Release Script${NC}"
      echo ""
      echo -e "${BOLD}Usage:${NC} ./release.sh [options]"
      echo ""
      echo "  Runs the release gates and works out the next version (a patch bump by default,"
      echo "  e.g. 1.0.4 -> 1.0.5). It changes nothing and publishes nothing."
      echo ""
      echo -e "${BOLD}Options:${NC}"
      echo "  --minor     Bump minor version (1.0.4 -> 1.1.0)"
      echo "  --major     Bump major version (1.0.4 -> 2.0.0)"
      echo "  --dry-run   Run every gate and show the next version without changing anything"
      echo "  --help, -h  Show this help message"
      echo ""
      echo -e "${BOLD}Publishing:${NC}"
      echo "  Releases publish from GitHub Actions to ReperioHealth/repo-radar-releases when main or"
      echo "  dev changes (see DEVELOPMENT.md, \"Releasing\"). This script no longer publishes: a run"
      echo "  without --dry-run runs the same gates, then refuses. Use ./build-local.sh to build and"
      echo "  verify a signed app without publishing."
      echo ""
      echo -e "${BOLD}Branches:${NC}"
      echo "  main   Production release (Repo Radar)"
      echo "  dev    Dev pre-release (Repo Radar Dev — separate app, orange icon)"
      echo ""
      echo -e "${BOLD}Requirements:${NC}"
      echo "  - Must be on main or dev branch"
      echo "  - GitHub CLI (gh) installed and authenticated"
      echo "  - Node.js and npm installed"
      echo "  - REPO_RADAR_RELEASE_PYTHON set to the absolute path of a release venv's python"
      echo ""
      echo -e "${BOLD}Preparing the release Python:${NC}"
      echo "  The model gates run in a dedicated venv installed from the checked-in lock that"
      echo "  matches its Python minor and architecture (resources/pydeps/cp3<minor>-<arch>.lock)."
      echo "  Do not install anything else into it. On an Apple Silicon Mac with Python 3.14:"
      echo ""
      echo "    dir=\$(mktemp -d /tmp/repo-radar-release-XXXXXX)"
      echo "    /opt/homebrew/bin/python3.14 -m venv \"\$dir/venv\""
      echo "    \"\$dir/venv/bin/python\" -m pip install --require-hashes -r resources/pydeps/cp314-arm64.lock"
      echo "    export REPO_RADAR_RELEASE_PYTHON=\"\$dir/venv/bin/python\""
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown argument:${NC} $arg"
      echo "Run ./release.sh --help for usage"
      exit 1
      ;;
  esac
done

# ── Preflight checks ─────────────────────────────────────────────────────────

step "Preflight checks"

# Check we're in the right directory
if [[ ! -f "$SCRIPT_DIR/menubar/package.json" ]]; then
  error "Must be run from the repo-radar root directory"
fi
cd "$SCRIPT_DIR"

# Check for required tools
for tool in gh node npm git; do
  if ! command -v "$tool" &>/dev/null; then
    error "$tool is not installed"
  fi
done
success "Required tools available"

# Check branch and determine release channel
CURRENT_BRANCH=$(git branch --show-current)
IS_DEV=false
if [[ "$CURRENT_BRANCH" == "dev" ]]; then
  IS_DEV=true
  info "Dev branch — the Repo Radar Dev channel"
elif [[ "$CURRENT_BRANCH" == "main" ]]; then
  info "Main branch — the production channel"
else
  error "Must be on main or dev branch (currently on: $CURRENT_BRANCH)"
fi

# Check gh auth status
if ! gh auth status &>/dev/null; then
  error "Not authenticated with GitHub CLI. Run: gh auth login"
fi
success "GitHub CLI authenticated"

# Check for staged changes (these would accidentally go into the release commit)
if ! git diff --cached --quiet; then
  error "You have staged changes. Commit or unstage them first."
fi
success "No staged changes"

# The Python gates run in a dedicated, verified release venv, never the ambient python3.
RELEASE_PY="${REPO_RADAR_RELEASE_PYTHON:-}"
if [[ -z "$RELEASE_PY" ]]; then
  error "REPO_RADAR_RELEASE_PYTHON is not set. Point it at a release venv's python installed from the matching resources/pydeps lock (see ./release.sh --help)."
fi
node scripts/check_release_python.js "$RELEASE_PY" || {
  echo "Release blocked: REPO_RADAR_RELEASE_PYTHON is not a usable release venv. Recreate it from the matching resources/pydeps lock (see ./release.sh --help)." >&2
  exit 1
}
success "Release Python verified: $RELEASE_PY"

RELEASE_DATE=$(date +%Y-%m-%d)
"$RELEASE_PY" -I -B scripts/check_model_lifecycle.py --target-date "$RELEASE_DATE" || {
  echo "Release blocked: model lifecycle gate failed. Re-verify vendor deprecation pages and amend repo_radar/model_lifecycle.json + the model maps." >&2
  exit 1
}

"$RELEASE_PY" -I -B scripts/check_model_windows.py --target-date "$RELEASE_DATE" || {
  echo "Release blocked: model window gate failed. Re-verify vendor windows; fix repo_radar/model_catalog.py or add a bound override." >&2
  exit 1; }

# Spec 2A runtime-binding: the full dependency-lock matrix must be present (the app
# fails closed on an uncovered interpreter, so a partial matrix ships a broken runtime).
node menubar/scripts/pydeps.js --assert-matrix || {
  echo "Release blocked: dependency-lock matrix incomplete (see resources/pydeps/). Generate the missing cells or narrow the supported Python matrix." >&2
  exit 1
}

# ── Version calculation ───────────────────────────────────────────────────────

step "Version calculation"

VERSION_FILE="$SCRIPT_DIR/VERSION"

# Read current version
if [[ -f "$VERSION_FILE" ]]; then
  CURRENT_VERSION=$(cat "$VERSION_FILE" | tr -d '[:space:]')
else
  CURRENT_VERSION="0.0.0"
  warn "No VERSION file found, starting from 0.0.0"
fi

# Strip any existing pre-release suffix for base version
BASE_VERSION="${CURRENT_VERSION%%-*}"

# Parse base version
IFS='.' read -r MAJOR MINOR PATCH <<< "$BASE_VERSION"

# Calculate new version
case "$BUMP_TYPE" in
  patch) NEW_VERSION="$MAJOR.$MINOR.$((PATCH + 1))" ;;
  minor) NEW_VERSION="$MAJOR.$((MINOR + 1)).0" ;;
  major) NEW_VERSION="$((MAJOR + 1)).0.0" ;;
esac

# For dev builds, add -dev.N suffix using build number
if $IS_DEV; then
  DEV_BUILD=$(date +%Y%m%d%H%M)
  NEW_VERSION="${NEW_VERSION}-dev.${DEV_BUILD}"
fi

info "Current version: ${BOLD}$CURRENT_VERSION${NC}"
DEV_LABEL=""
if $IS_DEV; then DEV_LABEL=", dev channel"; fi
success "New version:     ${BOLD}$NEW_VERSION${NC} ($BUMP_TYPE$DEV_LABEL)"

# ── Dry run summary ──────────────────────────────────────────────────────────

if $DRY_RUN; then
  step "Dry run summary"
  dry "All gates passed for v$NEW_VERSION"
  dry "This script no longer publishes: a run without --dry-run stops here and changes nothing"
  echo ""
  info "No changes were made. To build a signed app without publishing, use ./build-local.sh."
  exit 0
fi

# ── No local publishing ──────────────────────────────────────────────────────

# Releases publish from GitHub Actions; this script only runs the gates.
echo -e "${RED}[error]${NC} release.sh no longer publishes: releases publish from GitHub Actions to ReperioHealth/repo-radar-releases." >&2
echo "  Use ./build-local.sh to build and verify a signed app without publishing (see README, \"Building a signed app locally\")." >&2
exit 1
