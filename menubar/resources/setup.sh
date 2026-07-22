#!/bin/bash

# Setup script for Repo Radar
#
# NOT used by the app. Repo Radar self-provisions its own Python runtime on
# launch — it builds a per-channel, per-version virtualenv under
# ~/.repo-radar/<channel>/ from a checked-in, hash-pinned dependency lock, and
# every sync (manual, scheduled, or CLI) runs through that runtime. The app
# never invokes this script.
#
# This file is kept only as an optional manual aid (e.g. if you want a
# standalone `repo-radar` CLI outside of the app's own managed runtime). See
# menubar/SETUP.md for how the real, self-provisioning runtime works.
#
# This script installs the Python dependencies and sets up the sync script

set -e

# Colors
GREEN="\033[92m"
BLUE="\033[94m"
YELLOW="\033[93m"
RED="\033[91m"
BOLD="\033[1m"
RESET="\033[0m"

echo -e "${BOLD}Repo Radar - Setup${RESET}"
echo

# Determine the script location (works both when bundled and in development)
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
INSTALL_DIR="$HOME/.repo-radar"
BIN_DIR="$HOME/.local/bin"

echo -e "${BLUE}Installing to: ${INSTALL_DIR}${RESET}"
echo

# Create installation directory
mkdir -p "$INSTALL_DIR"
mkdir -p "$BIN_DIR"

# Copy Python script
echo -e "${BLUE}Installing sync script...${RESET}"
cp "$SCRIPT_DIR/repo-radar" "$INSTALL_DIR/repo-radar"
chmod +x "$INSTALL_DIR/repo-radar"

# Create symlink in user's bin directory
ln -sf "$INSTALL_DIR/repo-radar" "$BIN_DIR/repo-radar"

# Check for a supported Python 3 version
PYV=$(python3 -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null || echo "0.0")
PYMAJ=${PYV%%.*}; PYMIN=${PYV#*.}
if [ "$PYMAJ" -ne 3 ] || [ "$PYMIN" -lt 10 ] || [ "$PYMIN" -ge 15 ]; then
  echo "Repo Radar requires Python >=3.10,<3.15 (found $PYV). Install a supported Python 3 and retry." >&2
  exit 1
fi

echo -e "${GREEN}✓ Found Python ${PYV}${RESET}"

# Install Python dependencies
echo
echo -e "${BLUE}Installing Python dependencies...${RESET}"
echo "This may take a few minutes on first install."
echo

if python3 -m pip --version &> /dev/null; then
    python3 -m pip install -q -r "$SCRIPT_DIR/requirements.txt"
    echo -e "${GREEN}✓ Python dependencies installed${RESET}"
else
    echo -e "${RED}Error: pip not found${RESET}"
    echo "Please install pip or use a Python virtual environment"
    exit 1
fi

# Add to PATH if not already there
SHELL_RC="$HOME/.zshrc"
if [ -f "$HOME/.bashrc" ]; then
    SHELL_RC="$HOME/.bashrc"
fi

if ! grep -q "$BIN_DIR" "$SHELL_RC" 2>/dev/null; then
    echo >> "$SHELL_RC"
    echo "# Added by Repo Radar" >> "$SHELL_RC"
    echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> "$SHELL_RC"
    echo -e "${GREEN}✓ Added $BIN_DIR to PATH in $SHELL_RC${RESET}"
fi

echo
echo -e "${GREEN}${BOLD}✓ Setup complete!${RESET}"
echo
echo -e "${BLUE}Next steps:${RESET}"
echo "1. The menubar app will guide you through initial configuration"
echo "2. You'll need to provide your GitHub token"
echo "3. You'll need to provide your Anthropic API key (for metadata generation)"
echo "4. Configure which repositories to sync"
echo
echo -e "${BLUE}The sync script is now available at:${RESET}"
echo "  $INSTALL_DIR/repo-radar"
echo

