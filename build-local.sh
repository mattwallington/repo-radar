#!/bin/bash
# build-local.sh - Build a Reperio-signed, notarized Repo Radar locally. Never publishes.
# Usage: ./build-local.sh --version X.Y.Z[-dev.N] [--dry-run|--help]
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
error()   { echo -e "${RED}[error]${NC} $1" >&2; exit 1; }
step()    { echo -e "\n${BOLD}${CYAN}── $1 ──${NC}"; }
dry()     { echo -e "${YELLOW}[dry-run]${NC} $1"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DRY_RUN=false
NEW_VERSION=""

# The Reperio signing target. package.json carries the identity; these are checked against the result.
TEAM_ID="F8UY7565VM"
NOTARY_PROFILE="reperio-notary"

usage() {
  echo -e "${BOLD}Repo Radar local build${NC}"
  echo ""
  echo -e "${BOLD}Usage:${NC} ./build-local.sh --version X.Y.Z[-dev.N] [--dry-run]"
  echo ""
  echo "  Builds, signs (Reperio Health, team $TEAM_ID) and notarizes (keychain profile"
  echo "  $NOTARY_PROFILE) the arm64 and x64 apps from the current branch, then verifies them."
  echo "  It makes no git commit, tag, push or GitHub release, and never publishes."
  echo ""
  echo -e "${BOLD}Branches:${NC}"
  echo "  main   Repo Radar (stable). --version must be X.Y.Z"
  echo "  dev    Repo Radar Dev. --version must be X.Y.Z-dev.N"
  echo "  The version must be newer than VERSION in the checkout."
  echo ""
  echo -e "${BOLD}Options:${NC}"
  echo "  --version   The version to build (required)"
  echo "  --dry-run   Run every gate, then stop before installing or building"
  echo "  --help, -h  Show this help message"
  echo ""
  echo -e "${BOLD}Requirements:${NC}"
  echo "  - A clean checkout of main or dev"
  echo "  - REPO_RADAR_RELEASE_PYTHON set as for release.sh (./release.sh --help)"
  echo "  - The Reperio Developer ID certificate and the $NOTARY_PROFILE notarytool profile"
  echo "    in your login keychain"
}

# ── Parse args ────────────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      [[ $# -ge 2 ]] || error "--version needs a value"
      NEW_VERSION="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *)
      echo -e "${RED}Unknown argument:${NC} $1"
      echo "Run ./build-local.sh --help for usage"
      exit 1
      ;;
  esac
done

[[ -n "$NEW_VERSION" ]] || error "--version is required (see ./build-local.sh --help)"

# ── Preflight checks ─────────────────────────────────────────────────────────

step "Preflight checks"

if [[ ! -f "$SCRIPT_DIR/menubar/package.json" ]]; then
  error "Must be run from the repo-radar root directory"
fi
cd "$SCRIPT_DIR"

for tool in node npm git shasum xcrun codesign spctl; do
  if ! command -v "$tool" &>/dev/null; then
    error "$tool is not installed"
  fi
done
success "Required tools available"

# The channel follows the branch, as in release.sh. GitHub Actions checks out the triggering commit
# detached, so there the validated ref names the branch and HEAD must be that ref's commit.
if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  case "${GITHUB_REF:-}" in
    refs/heads/main|refs/heads/dev) CURRENT_BRANCH="${GITHUB_REF#refs/heads/}" ;;
    *) error "Releases build only from refs/heads/main or refs/heads/dev (got: ${GITHUB_REF:-none})" ;;
  esac
  [[ "$(git rev-parse HEAD)" == "${GITHUB_SHA:-}" ]] || error "Checkout is not the triggering commit ${GITHUB_SHA:-}"
else
  CURRENT_BRANCH=$(git branch --show-current)
fi
IS_DEV=false
if [[ "$CURRENT_BRANCH" == "dev" ]]; then
  IS_DEV=true
  info "Dev branch — will build Repo Radar Dev"
elif [[ "$CURRENT_BRANCH" == "main" ]]; then
  info "Main branch — will build Repo Radar"
else
  error "Must be on main or dev branch (currently on: $CURRENT_BRANCH)"
fi

# The build must match a commit: no changes, staged or not, and no untracked files, which
# electron-builder would package. Ignored build outputs and dependencies don't count.
GIT_STATUS=$(git status --porcelain --untracked-files=all) || error "Could not read git status"
if [[ -n "$GIT_STATUS" ]]; then
  error "You have uncommitted changes or untracked files. Commit, discard or remove them first."
fi
SOURCE_SHA=$(git rev-parse HEAD)
success "Clean checkout at $SOURCE_SHA"

CURRENT_VERSION=$(tr -d '[:space:]' < VERSION)
if $IS_DEV; then
  [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+-dev\.[0-9]+$ ]] || error "Dev builds need a version like 1.2.3-dev.202610271200 (got: $NEW_VERSION)"
else
  [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || error "Stable builds need a version like 1.2.3 (got: $NEW_VERSION)"
fi
# Its base must be newer than the checkout's, so the build can't be mistaken for an older release.
node -e '
  const parse = (v) => v.split("-")[0].split(".").map(Number);
  const [a, b] = [parse(process.argv[1]), parse(process.argv[2])];
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) process.exit(a[i] > b[i] ? 0 : 1); }
  process.exit(1);
' "$NEW_VERSION" "$CURRENT_VERSION" || error "Version $NEW_VERSION must be newer than VERSION ($CURRENT_VERSION)"
success "Version: ${BOLD}$NEW_VERSION${NC} (checkout: $CURRENT_VERSION)"

# The same gates as release.sh: verified release Python, model lifecycle, model windows, lock matrix.
RELEASE_PY="${REPO_RADAR_RELEASE_PYTHON:-}"
if [[ -z "$RELEASE_PY" ]]; then
  error "REPO_RADAR_RELEASE_PYTHON is not set. Point it at a release venv's python installed from the matching resources/pydeps lock (see ./release.sh --help)."
fi
node scripts/check_release_python.js "$RELEASE_PY" || {
  echo "Build blocked: REPO_RADAR_RELEASE_PYTHON is not a usable release venv. Recreate it from the matching resources/pydeps lock (see ./release.sh --help)." >&2
  exit 1
}
success "Release Python verified: $RELEASE_PY"

BUILD_DATE=$(date +%Y-%m-%d)
"$RELEASE_PY" -I -B scripts/check_model_lifecycle.py --target-date "$BUILD_DATE" || {
  echo "Build blocked: model lifecycle gate failed. Re-verify vendor deprecation pages and amend repo_radar/model_lifecycle.json + the model maps." >&2
  exit 1
}

"$RELEASE_PY" -I -B scripts/check_model_windows.py --target-date "$BUILD_DATE" || {
  echo "Build blocked: model window gate failed. Re-verify vendor windows; fix repo_radar/model_catalog.py or add a bound override." >&2
  exit 1
}

node menubar/scripts/pydeps.js --assert-matrix || {
  echo "Build blocked: dependency-lock matrix incomplete (see resources/pydeps/). Generate the missing cells or narrow the supported Python matrix." >&2
  exit 1
}
success "Release gates passed"

# Build identity, as release.sh sets it for each channel.
CHANNEL="stable"
APP_ID="com.mattwallington.repo-radar"
PRODUCT_NAME="Repo Radar"
ICON="assets/icon.icns"
FEED="latest-mac.yml"
if $IS_DEV; then
  CHANNEL="dev"
  APP_ID="com.mattwallington.repo-radar-dev"
  PRODUCT_NAME="Repo Radar Dev"
  ICON="assets/icon-dev.icns"
  FEED="dev-mac.yml"
fi

DIST_DIR="$SCRIPT_DIR/menubar/dist"

if $DRY_RUN; then
  step "Dry run summary"
  dry "Write VERSION ($NEW_VERSION) for the build, then restore it ($CURRENT_VERSION)"
  dry "Write menubar/build-info.json: version $NEW_VERSION, channel $CHANNEL, commit $SOURCE_SHA"
  dry "Remove menubar/dist and run npm ci in menubar"
  dry "electron-builder --mac --arm64 --x64 --publish never: $PRODUCT_NAME ($APP_ID)"
  dry "Notarize with APPLE_KEYCHAIN_PROFILE=$NOTARY_PROFILE only; fail if notarization is skipped"
  dry "Verify each app: team $TEAM_ID, bundle ID, codesign, spctl, stapler, update feed settings"
  dry "Check that $FEED describes both ZIPs and both DMGs"
  dry "Print artifact SHA-256s"
  echo ""
  info "No changes were made. Remove --dry-run to build."
  exit 0
fi

# ── Stage version files ──────────────────────────────────────────────────────

step "Staging version files"

# VERSION is bundled into the app, so it must match for the build. Restore it however we exit.
restore_version() { git -C "$SCRIPT_DIR" checkout -- VERSION; }
trap restore_version EXIT
echo "$NEW_VERSION" > VERSION
success "VERSION -> $NEW_VERSION (restored when the build ends)"

# package.json is not edited: the version and Dev identity are passed to electron-builder below.
node -e '
  const fs = require("fs");
  const [version, channel, commit] = process.argv.slice(1);
  fs.writeFileSync("menubar/build-info.json", JSON.stringify({
    version, channel, commit,
    buildDate: new Date().toISOString(),
    buildTimestamp: Date.now()
  }, null, 2));
' "$NEW_VERSION" "$CHANNEL" "$SOURCE_SHA"
success "Wrote menubar/build-info.json ($CHANNEL)"

# ── Build ─────────────────────────────────────────────────────────────────────

step "Building $PRODUCT_NAME $NEW_VERSION"

# Stale outputs from an earlier build must not pass the checks below.
rm -rf "$DIST_DIR"

info "Installing dependencies..."
(cd menubar && npm ci)

LOG_DIR=$(mktemp -d "${TMPDIR:-/tmp}/repo-radar-build-XXXXXX")
BUILDER_LOG="$LOG_DIR/electron-builder.log"

# Only the builder's environment changes: the keychain profile is the one notary credential.
# electron-builder 24 prefers APPLE_ID or the APPLE_API_* trio over the profile, and with no
# credential at all it skips notarization and still exits 0.
info "Building for macOS (arm64 + x64), log: $BUILDER_LOG"
(cd menubar && env -u APPLE_ID -u APPLE_APP_SPECIFIC_PASSWORD -u APPLE_API_KEY -u APPLE_API_KEY_ID \
    -u APPLE_API_ISSUER -u APPLE_TEAM_ID -u APPLE_KEYCHAIN APPLE_KEYCHAIN_PROFILE="$NOTARY_PROFILE" \
  ./node_modules/.bin/electron-builder --mac --arm64 --x64 --publish never \
    -c.appId="$APP_ID" -c.productName="$PRODUCT_NAME" -c.mac.icon="$ICON" \
    -c.extraMetadata.version="$NEW_VERSION") 2>&1 | tee "$BUILDER_LOG"

if grep -qi 'skipped macOS notarization' "$BUILDER_LOG"; then
  error "Notarization was skipped. Check that the $NOTARY_PROFILE profile is in your login keychain. Do not distribute this build."
fi
NOTARIZED=$(grep -ci 'notarization successful' "$BUILDER_LOG" || true)
if [[ "$NOTARIZED" -lt 2 ]]; then
  error "Expected notarization of both apps, but electron-builder reported $NOTARIZED. Do not distribute this build."
fi
success "electron-builder notarized $NOTARIZED apps"

# ── Verify ────────────────────────────────────────────────────────────────────

step "Verifying the apps"

for app in "$DIST_DIR/mac-arm64/$PRODUCT_NAME.app" "$DIST_DIR/mac/$PRODUCT_NAME.app"; do
  [[ -d "$app" ]] || error "Missing app: $app"
  team=$(codesign -dv "$app" 2>&1 | sed -n 's/^TeamIdentifier=//p')
  [[ "$team" == "$TEAM_ID" ]] || error "$app is signed by team '$team', expected $TEAM_ID"
  bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")
  [[ "$bundle_id" == "$APP_ID" ]] || error "$app has bundle ID '$bundle_id', expected $APP_ID"
  app_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")
  [[ "$app_version" == "$NEW_VERSION" ]] || error "$app has version '$app_version', expected $NEW_VERSION"
  codesign --verify --deep --strict "$app" || error "codesign verification failed: $app"
  spctl -a -vv "$app" || error "Gatekeeper assessment failed: $app"
  xcrun stapler validate "$app" || error "No stapled notarization ticket: $app"
  node menubar/scripts/release-artifacts.js check-app-update "$app" "$CHANNEL" || error "Wrong update feed settings: $app"
  success "$(basename "$(dirname "$app")")/$(basename "$app"): team $team, $bundle_id $app_version"
done

# ── Artifacts ─────────────────────────────────────────────────────────────────

step "Artifacts"

# electron-builder names its feed latest-mac.yml. Dev apps look for dev-mac.yml in Dev releases.
if $IS_DEV; then
  mv "$DIST_DIR/latest-mac.yml" "$DIST_DIR/$FEED" || error "electron-builder wrote no latest-mac.yml"
fi
node menubar/scripts/release-artifacts.js check-feed --dir "$DIST_DIR" --version "$NEW_VERSION" --channel "$CHANNEL" \
  || error "$FEED does not match the built artifacts"

# Artifact prefix is always "repo-radar" (the npm package name, used by ${name} in artifactName)
ARTIFACTS=()
for arch in arm64 x64; do
  for ext in dmg zip; do
    f="$DIST_DIR/repo-radar-$NEW_VERSION-$arch-mac.$ext"
    [[ -f "$f" ]] || error "Missing artifact: $f"
    ARTIFACTS+=("$f")
  done
done
for f in "$DIST_DIR"/*.blockmap "$DIST_DIR/$FEED"; do
  [[ -f "$f" ]] && ARTIFACTS+=("$f")
done

(cd "$DIST_DIR" && shasum -a 256 "${ARTIFACTS[@]##*/}")

echo ""
echo -e "  ${GREEN}${BOLD}$PRODUCT_NAME $NEW_VERSION built, signed and notarized.${NC} Not published."
echo "  Source: $SOURCE_SHA ($CURRENT_BRANCH)   Builder log: $BUILDER_LOG"
echo "  The DMGs themselves are not notarized yet; the apps inside them are, and are stapled."
echo "  To sign and notarize the DMGs: node menubar/scripts/release-dmg.js --dir menubar/dist --version $NEW_VERSION"
echo "  Install: quit $PRODUCT_NAME, open the DMG for your Mac and replace /Applications/$PRODUCT_NAME.app."
