#!/bin/sh
# Sentinal Installer
#
# Downloads the latest sentinal binary from GitHub Releases and installs it
# to ~/.sentinal/bin/sentinal. Sets up PATH, alias, and shell completions
# for bash, zsh, and fish.
#
# Requires a GitHub token with `repo` scope (private repository).
#
# Usage:
#   export GITHUB_TOKEN=ghp_xxx
#   curl -fsSL -H "Authorization: token $GITHUB_TOKEN" \
#     https://raw.githubusercontent.com/Endpoint-Esports-Ltd/sentinal/main/scripts/install.sh | sh

set -e

REPO="Endpoint-Esports-Ltd/sentinal"
API_BASE="https://api.github.com"
BIN_DIR="$HOME/.sentinal/bin"
BIN_PATH="$BIN_DIR/sentinal"
MARKER_START="# --- sentinal start ---"
MARKER_END="# --- sentinal end ---"

# ─── Helpers ──────────────────────────────────────────────────────────────────

info() { printf '  \033[1;34m>\033[0m %s\n' "$1"; }
ok()   { printf '  \033[1;32m✓\033[0m %s\n' "$1"; }
err()  { printf '  \033[1;31m✗\033[0m %s\n' "$1" >&2; }
die()  { err "$1"; exit 1; }

# ─── Token ────────────────────────────────────────────────────────────────────

TOKEN="${GITHUB_TOKEN:-$GH_TOKEN}"
if [ -z "$TOKEN" ]; then
  die "GITHUB_TOKEN or GH_TOKEN must be set. Create a PAT with 'repo' scope at https://github.com/settings/tokens"
fi

AUTH_HEADER="Authorization: token $TOKEN"

# ─── Platform detection ──────────────────────────────────────────────────────

detect_platform() {
  OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
  ARCH="$(uname -m)"

  case "$OS" in
    linux)  OS="linux" ;;
    darwin) OS="darwin" ;;
    *)      die "Unsupported OS: $OS. Supported: linux, darwin" ;;
  esac

  case "$ARCH" in
    x86_64|amd64)  ARCH="x64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *)             die "Unsupported architecture: $ARCH. Supported: x64, arm64" ;;
  esac

  ASSET_NAME="sentinal-${OS}-${ARCH}"
  info "Detected platform: ${OS}-${ARCH}"
}

# ─── Fetch latest release ────────────────────────────────────────────────────

fetch_release() {
  info "Fetching latest release..."
  RELEASE_JSON="$(curl -fsSL -H "$AUTH_HEADER" "$API_BASE/repos/$REPO/releases/latest")" \
    || die "Failed to fetch release info. Check your token has 'repo' scope."

  TAG="$(printf '%s' "$RELEASE_JSON" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"//' | sed 's/".*//')"
  [ -z "$TAG" ] && die "Could not parse release tag from API response."

  VERSION="${TAG#v}"
  info "Latest version: $VERSION ($TAG)"
}

# ─── Download binary ─────────────────────────────────────────────────────────

download_binary() {
  # Extract the asset ID for our platform binary
  ASSET_ID="$(printf '%s' "$RELEASE_JSON" | grep -B3 "\"name\": \"$ASSET_NAME\"" | grep '"id"' | head -1 | sed 's/[^0-9]//g')"
  [ -z "$ASSET_ID" ] && die "No binary found for $ASSET_NAME in release $TAG."

  info "Downloading $ASSET_NAME..."
  mkdir -p "$BIN_DIR"

  curl -fsSL \
    -H "$AUTH_HEADER" \
    -H "Accept: application/octet-stream" \
    "$API_BASE/repos/$REPO/releases/assets/$ASSET_ID" \
    -o "$BIN_PATH" \
    || die "Failed to download binary."

  chmod +x "$BIN_PATH"
  ok "Installed sentinal v$VERSION to $BIN_PATH"
}

# ─── Shell integration ───────────────────────────────────────────────────────

detect_shell() {
  SHELL_NAME=""
  SHELL_CONFIG=""

  case "${SHELL:-}" in
    */zsh)  SHELL_NAME="zsh";  SHELL_CONFIG="$HOME/.zshrc" ;;
    */bash) SHELL_NAME="bash"; SHELL_CONFIG="$HOME/.bashrc" ;;
    */fish) SHELL_NAME="fish"; SHELL_CONFIG="$HOME/.config/fish/config.fish" ;;
    *)
      # Fallback: check common shells
      if [ -f "$HOME/.zshrc" ]; then
        SHELL_NAME="zsh"; SHELL_CONFIG="$HOME/.zshrc"
      elif [ -f "$HOME/.bashrc" ]; then
        SHELL_NAME="bash"; SHELL_CONFIG="$HOME/.bashrc"
      fi
      ;;
  esac
}

generate_block() {
  if [ "$SHELL_NAME" = "fish" ]; then
    printf '%s\n%s\n%s\n%s\n%s' \
      "$MARKER_START" \
      "fish_add_path -g $BIN_DIR" \
      "alias snt sentinal" \
      "sentinal completion fish | source" \
      "$MARKER_END"
  else
    printf '%s\n%s\n%s\n%s\n%s' \
      "$MARKER_START" \
      "export PATH=\"$BIN_DIR:\$PATH\"" \
      "alias snt=\"sentinal\"" \
      "eval \"\$(sentinal completion \$(basename \"\$SHELL\"))\"" \
      "$MARKER_END"
  fi
}

setup_shell() {
  detect_shell

  if [ -z "$SHELL_NAME" ]; then
    info "Could not detect shell. Add $BIN_DIR to your PATH manually."
    info "Then run: sentinal shell-init"
    return
  fi

  BLOCK="$(generate_block)"

  # Ensure parent directory exists (for fish)
  mkdir -p "$(dirname "$SHELL_CONFIG")"

  if [ -f "$SHELL_CONFIG" ]; then
    EXISTING="$(cat "$SHELL_CONFIG")"
  else
    EXISTING=""
  fi

  # Check if block already exists and is current
  if printf '%s' "$EXISTING" | grep -qF "$MARKER_START"; then
    # Replace existing block
    BEFORE="$(printf '%s' "$EXISTING" | sed "/$MARKER_START/,\$d")"
    AFTER="$(printf '%s' "$EXISTING" | sed "1,/$MARKER_END/d")"
    printf '%s\n%s\n%s\n' "$BEFORE" "$BLOCK" "$AFTER" > "$SHELL_CONFIG"
    ok "Updated shell config: $SHELL_CONFIG"
  else
    # Append new block
    printf '\n%s\n' "$BLOCK" >> "$SHELL_CONFIG"
    ok "Added PATH, alias, and completions to $SHELL_CONFIG"
  fi
}

# ─── macOS codesign note ─────────────────────────────────────────────────────

codesign_hint() {
  if [ "$(uname -s)" = "Darwin" ]; then
    info "macOS: If the binary is blocked by Gatekeeper, run:"
    info "  codesign -s - $BIN_PATH"
  fi
}

# ─── Main ─────────────────────────────────────────────────────────────────────

main() {
  printf '\n  \033[1mSentinal Installer\033[0m\n\n'

  detect_platform
  fetch_release
  download_binary
  setup_shell
  codesign_hint

  printf '\n  \033[1;32mDone!\033[0m Restart your shell or run:\n'
  if [ "$SHELL_NAME" = "fish" ]; then
    printf '    source %s\n' "$SHELL_CONFIG"
  elif [ -n "$SHELL_CONFIG" ]; then
    printf '    source %s\n' "$SHELL_CONFIG"
  fi
  printf '\n  Then install for your AI assistant:\n'
  printf '    sentinal install claude     # Claude Code\n'
  printf '    sentinal install opencode   # OpenCode\n'
  printf '    sentinal install both       # Both\n\n'
}

main
