#!/bin/bash
# release.sh - Full release workflow for Repo Radar
# Usage: ./release.sh [--dry-run] <patch|minor|major|X.Y.Z>
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

# ── Parse args ────────────────────────────────────────────────────────────────

BUMP_TYPE=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    patch|minor|major) BUMP_TYPE="$arg" ;;
    *)
      # Check if it looks like a semver (X.Y.Z)
      if [[ "$arg" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        BUMP_TYPE="$arg"
      else
        echo -e "${BOLD}Usage:${NC} ./release.sh [--dry-run] <patch|minor|major|X.Y.Z>"
        echo ""
        echo "  patch   Bump patch version (1.0.0 -> 1.0.1)"
        echo "  minor   Bump minor version (1.0.0 -> 1.1.0)"
        echo "  major   Bump major version (1.0.0 -> 2.0.0)"
        echo "  X.Y.Z   Set explicit version"
        echo ""
        echo "  --dry-run  Show what would happen without doing it"
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$BUMP_TYPE" ]]; then
  echo -e "${BOLD}Usage:${NC} ./release.sh [--dry-run] <patch|minor|major|X.Y.Z>"
  exit 1
fi

# ── Preflight checks ─────────────────────────────────────────────────────────

step "Preflight checks"

# Check we're in the right directory
if [[ ! -f "$SCRIPT_DIR/menubar/package.json" ]]; then
  error "Must be run from the repo-radar root directory"
fi
cd "$SCRIPT_DIR"

# Check for required tools
if ! command -v gh &>/dev/null; then
  error "GitHub CLI (gh) is not installed. Install with: brew install gh"
fi

if ! command -v node &>/dev/null; then
  error "Node.js is not installed"
fi

if ! command -v npm &>/dev/null; then
  error "npm is not installed"
fi

if ! command -v git &>/dev/null; then
  error "git is not installed"
fi

success "Required tools available"

# Check we're on main branch
CURRENT_BRANCH=$(git branch --show-current)
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  error "Must be on main branch (currently on: $CURRENT_BRANCH)"
fi
success "On main branch"

# Check for uncommitted changes
if ! git diff --quiet || ! git diff --cached --quiet; then
  error "Working directory has uncommitted changes. Commit or stash them first."
fi

# Check for untracked files (warn only)
UNTRACKED=$(git ls-files --others --exclude-standard)
if [[ -n "$UNTRACKED" ]]; then
  warn "Untracked files detected (these will NOT be included in the release):"
  echo "$UNTRACKED" | head -10 | sed 's/^/         /'
  UNTRACKED_COUNT=$(echo "$UNTRACKED" | wc -l | tr -d ' ')
  if [[ "$UNTRACKED_COUNT" -gt 10 ]]; then
    echo "         ... and $((UNTRACKED_COUNT - 10)) more"
  fi
fi

success "Working directory clean"

# Check gh auth status
if ! gh auth status &>/dev/null; then
  error "Not authenticated with GitHub CLI. Run: gh auth login"
fi
success "GitHub CLI authenticated"

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

info "Current version: ${BOLD}$CURRENT_VERSION${NC}"

# Parse current version
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

# Calculate new version
if [[ "$BUMP_TYPE" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  NEW_VERSION="$BUMP_TYPE"
else
  case "$BUMP_TYPE" in
    patch) NEW_VERSION="$MAJOR.$MINOR.$((PATCH + 1))" ;;
    minor) NEW_VERSION="$MAJOR.$((MINOR + 1)).0" ;;
    major) NEW_VERSION="$((MAJOR + 1)).0.0" ;;
  esac
fi

success "New version: ${BOLD}$NEW_VERSION${NC}"

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
  dry "Attach arm64 and x64 zip files"
  dry "Push commit and tag to origin"
  echo ""
  info "No changes were made. Remove --dry-run to execute."
  exit 0
fi

# ── Confirmation ──────────────────────────────────────────────────────────────

step "Confirmation"

echo ""
echo -e "  Version:  ${BOLD}$CURRENT_VERSION${NC} -> ${BOLD}${GREEN}$NEW_VERSION${NC}"
echo -e "  Tag:      ${BOLD}v$NEW_VERSION${NC}"
echo -e "  Branch:   ${BOLD}$CURRENT_BRANCH${NC}"
echo ""
read -p "$(echo -e "${YELLOW}Proceed with release? (y/N):${NC} ")" CONFIRM
if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
  info "Release cancelled."
  exit 0
fi

# ── Update version files ─────────────────────────────────────────────────────

step "Updating version files"

# Update VERSION file
echo "$NEW_VERSION" > "$VERSION_FILE"
success "Updated VERSION -> $NEW_VERSION"

# Update package.json
# Use node for reliable JSON manipulation
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('menubar/package.json', 'utf8'));
  pkg.version = '$NEW_VERSION';
  fs.writeFileSync('menubar/package.json', JSON.stringify(pkg, null, 2) + '\n');
"
success "Updated menubar/package.json -> $NEW_VERSION"

# ── Git commit and tag ────────────────────────────────────────────────────────

step "Creating git commit and tag"

git add VERSION menubar/package.json
git commit -m "release: v$NEW_VERSION"
success "Committed: release: v$NEW_VERSION"

git tag "v$NEW_VERSION"
success "Tagged: v$NEW_VERSION"

# ── Build ─────────────────────────────────────────────────────────────────────

step "Building Electron app"

info "Installing dependencies..."
cd "$SCRIPT_DIR/menubar"
npm install

info "Building for macOS (arm64 + x64)..."
npx electron-builder --mac --arm64 --x64

cd "$SCRIPT_DIR"
success "Build complete"

# ── Create installer zips ─────────────────────────────────────────────────────

step "Creating distribution packages"

node menubar/scripts/create-installer.js
success "Distribution packages created"

# ── Find zip files ────────────────────────────────────────────────────────────

step "Locating release artifacts"

DIST_DIR="$SCRIPT_DIR/menubar/dist"
ARM64_ZIP=$(find "$DIST_DIR" -maxdepth 1 -name "*arm64*.zip" -type f | sort | tail -1)
X64_ZIP=$(find "$DIST_DIR" -maxdepth 1 -name "*x64*.zip" -type f | sort | tail -1)

ASSETS=()
if [[ -n "$ARM64_ZIP" ]]; then
  success "Found arm64: $(basename "$ARM64_ZIP")"
  ASSETS+=("$ARM64_ZIP")
else
  warn "No arm64 zip found in dist/"
fi

if [[ -n "$X64_ZIP" ]]; then
  success "Found x64: $(basename "$X64_ZIP")"
  ASSETS+=("$X64_ZIP")
else
  warn "No x64 zip found in dist/"
fi

if [[ ${#ASSETS[@]} -eq 0 ]]; then
  error "No zip files found in $DIST_DIR - build may have failed"
fi

# ── Push ──────────────────────────────────────────────────────────────────────

step "Pushing to remote"

git push origin main
git push origin "v$NEW_VERSION"
success "Pushed commit and tag to origin"

# ── Create GitHub release ─────────────────────────────────────────────────────

step "Creating GitHub release"

gh release create "v$NEW_VERSION" \
  --title "Repo Radar v$NEW_VERSION" \
  --generate-notes \
  ${ASSETS[@]}

success "GitHub release created: Repo Radar v$NEW_VERSION"

# ── Done ──────────────────────────────────────────────────────────────────────

step "Release complete!"

echo ""
echo -e "  ${GREEN}${BOLD}Repo Radar v$NEW_VERSION has been released!${NC}"
echo ""
echo -e "  GitHub: $(gh browse --no-browser 2>/dev/null || echo 'https://github.com/mattwallington/repo-radar')/releases/tag/v$NEW_VERSION"
echo ""
