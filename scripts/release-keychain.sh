#!/bin/bash
# release-keychain.sh - Load Reperio signing and notarization credentials into a throwaway keychain.
# Runs only on a disposable GitHub-hosted macOS runner. Never run it on a developer Mac: it replaces
# the user's keychain search list.
#
# Reads MACOS_CERTIFICATE_P12_BASE64, MACOS_CERTIFICATE_PASSWORD, ASC_API_KEY_P8, ASC_API_KEY_ID and
# ASC_API_ISSUER_ID from the environment. Imports the Developer ID certificate, rebuilds the
# reperio-notary notarytool profile in the same keychain, and exports CSC_KEYCHAIN for electron-builder.
# The workflow's cleanup step deletes the keychain on every exit.
set -euo pipefail

[[ "${GITHUB_ACTIONS:-}" == "true" && "${RUNNER_ENVIRONMENT:-}" == "github-hosted" ]] || {
  echo "release-keychain.sh runs only on GitHub-hosted runners" >&2; exit 1; }
[[ "${GITHUB_REPOSITORY:-}" == "ReperioHealth/repo-radar" ]] || {
  echo "release-keychain.sh runs only for ReperioHealth/repo-radar" >&2; exit 1; }
case "${GITHUB_REF:-}" in
  refs/heads/main|refs/heads/dev) ;;
  *) echo "release-keychain.sh runs only for main or dev" >&2; exit 1 ;;
esac
for name in MACOS_CERTIFICATE_P12_BASE64 MACOS_CERTIFICATE_PASSWORD ASC_API_KEY_P8 ASC_API_KEY_ID ASC_API_ISSUER_ID; do
  [[ -n "${!name:-}" ]] || { echo "$name is not set" >&2; exit 1; }
done

umask 077
keychain="$RUNNER_TEMP/repo-radar-release.keychain-db"
certificate="$RUNNER_TEMP/repo-radar-certificate.p12"
api_key="$RUNNER_TEMP/repo-radar-notary.p8"
trap 'rm -f -- "$certificate" "$api_key"' EXIT

keychain_password=$(openssl rand -hex 32)
node -e 'require("fs").writeFileSync(process.argv[1], Buffer.from(process.env.MACOS_CERTIFICATE_P12_BASE64, "base64"))' "$certificate"
printf '%s\n' "$ASC_API_KEY_P8" > "$api_key"

security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security list-keychains -d user -s "$keychain"
security default-keychain -d user -s "$keychain"
security import "$certificate" -P "$MACOS_CERTIFICATE_PASSWORD" -x -A -t cert -f pkcs12 -k "$keychain"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" >/dev/null
xcrun notarytool store-credentials reperio-notary --key "$api_key" --key-id "$ASC_API_KEY_ID" \
  --issuer "$ASC_API_ISSUER_ID" --keychain "$keychain" >/dev/null

security find-identity -v -p codesigning "$keychain" | grep -q 'Developer ID Application: Reperio Health, Inc. (F8UY7565VM)' || {
  echo "The certificate is not the Reperio Developer ID Application identity" >&2; exit 1; }
echo "CSC_KEYCHAIN=$keychain" >> "$GITHUB_ENV"
echo "Release keychain ready"
