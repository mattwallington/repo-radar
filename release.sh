#!/bin/bash
# release.sh - Full release workflow for Repo Radar
# Usage: ./release.sh [--minor|--major|--dry-run|--help]
# Default: patch bump (1.0.4 -> 1.0.5)
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
      echo "  With no arguments, bumps the patch version and releases."
      echo "  e.g. 1.0.4 -> 1.0.5"
      echo ""
      echo -e "${BOLD}Options:${NC}"
      echo "  --minor     Bump minor version (1.0.4 -> 1.1.0)"
      echo "  --major     Bump major version (1.0.4 -> 2.0.0)"
      echo "  --dry-run   Show what would happen without doing it"
      echo "  --help, -h  Show this help message"
      echo ""
      echo -e "${BOLD}What it does:${NC}"
      echo "  1. Bumps the version (VERSION + package.json)"
      echo "  2. Commits the version bump and creates a git tag"
      echo "  3. Builds the Electron app (arm64 + x64)"
      echo "  4. Pushes to GitHub"
      echo "  5. Creates a GitHub Release with artifacts"
      echo ""
      echo -e "${BOLD}Branches:${NC}"
      echo "  main   Production release (Repo Radar)"
      echo "  dev    Dev pre-release (Repo Radar Dev — separate app, orange icon)"
      echo ""
      echo -e "${BOLD}Requirements:${NC}"
      echo "  - Must be on main or dev branch"
      echo "  - GitHub CLI (gh) installed and authenticated"
      echo "  - Node.js and npm installed"
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
  info "Dev branch — will build Repo Radar Dev and create pre-release"
elif [[ "$CURRENT_BRANCH" == "main" ]]; then
  info "Main branch — production release"
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
  dry "Update VERSION file: $CURRENT_VERSION -> $NEW_VERSION"
  dry "Update menubar/package.json version: $NEW_VERSION"
  dry "Git commit: release: v$NEW_VERSION"
  dry "Git tag: v$NEW_VERSION"
  dry "Build Electron app (arm64 + x64)"
  dry "Run create-installer script"
  dry "Create GitHub release: Repo Radar v$NEW_VERSION"
  dry "Attach arm64 and x64 zip files + latest-mac.yml"
  dry "Push commit and tag to origin"
  echo ""
  info "No changes were made. Remove --dry-run to execute."
  exit 0
fi

# ── Update version files ─────────────────────────────────────────────────────

step "Updating version files"

echo "$NEW_VERSION" > "$VERSION_FILE"
success "Updated VERSION -> $NEW_VERSION"

# Update version in package.json (but NOT appId/productName — those are build-time only)
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('menubar/package.json', 'utf8'));
  pkg.version = '$NEW_VERSION';
  fs.writeFileSync('menubar/package.json', JSON.stringify(pkg, null, 2) + '\n');
"
success "Updated menubar/package.json -> $NEW_VERSION"

# Sync package-lock.json version
cd "$SCRIPT_DIR/menubar" && npm install --package-lock-only --silent
cd "$SCRIPT_DIR"
success "Updated menubar/package-lock.json -> $NEW_VERSION"

# ── Git commit and tag ────────────────────────────────────────────────────────

step "Creating git commit and tag"

git add VERSION menubar/package.json menubar/package-lock.json
git commit -m "release: v$NEW_VERSION"
success "Committed: release: v$NEW_VERSION"

git tag "v$NEW_VERSION"
success "Tagged: v$NEW_VERSION"

# ── Build ─────────────────────────────────────────────────────────────────────

step "Building Electron app"

# Write build-info.json with channel (consumed by the app at runtime)
CHANNEL="stable"
if $IS_DEV; then CHANNEL="dev"; fi
node -e "
  const fs = require('fs');
  fs.writeFileSync('menubar/build-info.json', JSON.stringify({
    version: '$NEW_VERSION',
    channel: '$CHANNEL',
    buildDate: new Date().toISOString(),
    buildTimestamp: Date.now()
  }, null, 2));
"

# For dev builds, temporarily swap appId and productName for the build
if $IS_DEV; then
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('menubar/package.json', 'utf8'));
    pkg.build.appId = 'com.mattwallington.repo-radar-dev';
    pkg.build.productName = 'Repo Radar Dev';
    fs.writeFileSync('menubar/package.json', JSON.stringify(pkg, null, 2) + '\n');
  "
  success "Temporarily set appId/productName for dev build"
fi

info "Installing dependencies..."
cd "$SCRIPT_DIR/menubar"
npm install

info "Building for macOS (arm64 + x64)..."
npx electron-builder --mac --arm64 --x64

cd "$SCRIPT_DIR"
success "Build complete"

# Revert temporary dev changes to package.json
if $IS_DEV; then
  git checkout menubar/package.json
  success "Reverted package.json to committed state"
fi

# ── Create installer zips ─────────────────────────────────────────────────────

step "Creating distribution packages"

node menubar/scripts/create-installer.js
success "Distribution packages created"

# ── Find zip files ────────────────────────────────────────────────────────────

step "Locating release artifacts"

DIST_DIR="$SCRIPT_DIR/menubar/dist"

ASSETS=()

# Artifact name prefix matches electron-builder's ${name} from package.json
if $IS_DEV; then
  ART_PREFIX="repo-radar-dev"
else
  ART_PREFIX="repo-radar"
fi

# Zips (for auto-updater and manual download)
for f in "$DIST_DIR/$ART_PREFIX-$NEW_VERSION-arm64-mac.zip" \
         "$DIST_DIR/$ART_PREFIX-$NEW_VERSION-mac.zip"; do
  if [[ -f "$f" ]]; then
    success "Found: $(basename "$f")"
    ASSETS+=("$f")
  else
    warn "Missing: $(basename "$f")"
  fi
done

# DMGs (for manual download)
for f in "$DIST_DIR/$ART_PREFIX-$NEW_VERSION-arm64.dmg" \
         "$DIST_DIR/$ART_PREFIX-$NEW_VERSION.dmg"; do
  if [[ -f "$f" ]]; then
    success "Found: $(basename "$f")"
    ASSETS+=("$f")
  fi
done

# Update manifest (required for electron-updater)
LATEST_YML="$DIST_DIR/latest-mac.yml"
if [[ -f "$LATEST_YML" ]]; then
  success "Found: latest-mac.yml"
  ASSETS+=("$LATEST_YML")
else
  warn "Missing latest-mac.yml (auto-updater won't work)"
fi

if [[ ${#ASSETS[@]} -eq 0 ]]; then
  error "No release artifacts found in $DIST_DIR - build may have failed"
fi

# ── Push ──────────────────────────────────────────────────────────────────────

step "Pushing to remote"

git push origin "$CURRENT_BRANCH"
git push origin "v$NEW_VERSION"
success "Pushed commit and tag to origin"

# ── Create GitHub release ─────────────────────────────────────────────────────

step "Creating GitHub release"

RELEASE_ARGS=(
  "v$NEW_VERSION"
  --title "Repo Radar v$NEW_VERSION"
  --generate-notes
)

if $IS_DEV; then
  RELEASE_ARGS+=(--prerelease)
fi

gh release create "${RELEASE_ARGS[@]}" "${ASSETS[@]}"

if $IS_DEV; then
  success "GitHub pre-release created: Repo Radar Dev v$NEW_VERSION"
else
  success "GitHub release created: Repo Radar v$NEW_VERSION"
fi

# ── Done ──────────────────────────────────────────────────────────────────────

step "Release complete!"

echo ""
echo -e "  ${GREEN}${BOLD}Repo Radar v$NEW_VERSION has been released!${NC}"
echo ""
echo -e "  GitHub: $(gh browse --no-browser 2>/dev/null || echo 'https://github.com/mattwallington/repo-radar')/releases/tag/v$NEW_VERSION"
echo ""
