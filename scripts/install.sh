#!/bin/sh
# Sentinal Installer
#
# Downloads the latest sentinal binary from GitHub Releases, verifies its
# SHA-256 against the release's checksums.txt, and installs it to
# ~/.sentinal/bin/sentinal. Sets up PATH, alias, and shell completions for
# bash, zsh, and fish.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Endpoint-Esports-Ltd/sentinal/main/scripts/install.sh | sh
#
# A token is optional: if GITHUB_TOKEN (or GH_TOKEN) is set it is used for the
# GitHub API requests, which raises GitHub's unauthenticated limit of 60
# requests per hour.

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

# ─── Token (optional) ────────────────────────────────────────────────────────

TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"

RELEASE_FILE="$BIN_DIR/.sentinal.release.$$"
DOWNLOAD_FILE="$BIN_DIR/.sentinal.download.$$"
CHECKSUMS_FILE="$BIN_DIR/.sentinal.checksums.$$"

cleanup() { rm -f "$RELEASE_FILE" "$DOWNLOAD_FILE" "$CHECKSUMS_FILE"; }
trap cleanup EXIT
trap 'cleanup; exit 1' INT TERM

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

# get_release_status <use-token: 1|0> — writes the body to $RELEASE_FILE and
# prints the HTTP status code ("000" when curl itself failed).
get_release_status() {
  if [ "$1" = 1 ]; then
    curl -sSL -H "Authorization: token $TOKEN" -H "Accept: application/vnd.github+json" \
      -w '%{http_code}' -o "$RELEASE_FILE" "$API_BASE/repos/$REPO/releases/latest" \
      || true
  else
    curl -sSL -H "Accept: application/vnd.github+json" \
      -w '%{http_code}' -o "$RELEASE_FILE" "$API_BASE/repos/$REPO/releases/latest" \
      || true
  fi
}

fetch_release() {
  info "Fetching latest release..."
  mkdir -p "$BIN_DIR"

  STATUS=""
  if [ -n "$TOKEN" ]; then
    STATUS="$(get_release_status 1)"
    case "$STATUS" in
      401|403)
        err "GitHub refused the token request (HTTP $STATUS: invalid/expired token or rate limit); retrying without it."
        TOKEN=""
        ;;
    esac
  fi
  if [ -z "$TOKEN" ]; then
    STATUS="$(get_release_status 0)"
  fi

  case "$STATUS" in
    200) ;;
    403|429) die "GitHub API rate limit hit (HTTP $STATUS). Set GITHUB_TOKEN to raise the limit, or try again later." ;;
    000|"") die "Failed to reach the GitHub API. Check your network connection." ;;
    *)   die "Failed to fetch release info (HTTP $STATUS)." ;;
  esac

  # Normalise to one key per line, for both pretty-printed and compact JSON.
  RELEASE_JSON="$(tr ',{}' '\n\n\n' < "$RELEASE_FILE")"

  TAG="$(printf '%s\n' "$RELEASE_JSON" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"//' | sed 's/".*//')"
  [ -z "$TAG" ] && die "Could not parse release tag from API response."

  VERSION="${TAG#v}"
  info "Latest version: $VERSION ($TAG)"
}

# public_url <asset-name> — the asset's browser_download_url, matched exactly.
public_url() {
  printf '%s\n' "$RELEASE_JSON" \
    | grep "\"browser_download_url\"[[:space:]]*:[[:space:]]*\"[^\"]*/$1\"" \
    | head -1 \
    | sed 's/.*"browser_download_url"[[:space:]]*:[[:space:]]*"//' | sed 's/".*//'
}

# api_url <asset-name> — the asset's API URL (.../releases/assets/<id>): the last
# releases/assets "url" seen before that asset's browser_download_url.
api_url() {
  printf '%s\n' "$RELEASE_JSON" | awk -v n="$1" '
    /"url"[[:space:]]*:/ && /\/releases\/assets\// {
      u = $0
      sub(/.*"url"[[:space:]]*:[[:space:]]*"/, "", u)
      sub(/".*/, "", u)
      last = u
    }
    /"browser_download_url"[[:space:]]*:/ {
      b = $0
      sub(/.*"browser_download_url"[[:space:]]*:[[:space:]]*"/, "", b)
      sub(/".*/, "", b)
      k = length(b) - length(n)
      if (k > 0 && substr(b, k) == "/" n) { print last; exit }
    }'
}

# download_asset <asset-name> <output-file>
download_asset() {
  if [ -n "$TOKEN" ]; then
    URL="$(api_url "$1")"
    [ -z "$URL" ] && die "No $1 found in release $TAG."
    curl -fsSL \
      -H "Authorization: token $TOKEN" \
      -H "Accept: application/octet-stream" \
      -o "$2" "$URL"
  else
    URL="$(public_url "$1")"
    [ -z "$URL" ] && die "No $1 found in release $TAG."
    curl -fsSL -o "$2" "$URL"
  fi
}

# sha256_of <file> — prints the lowercase hex digest.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}' | tr '[:upper:]' '[:lower:]'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}' | tr '[:upper:]' '[:lower:]'
  else
    return 1
  fi
}

# ─── Download binary ─────────────────────────────────────────────────────────

download_binary() {
  info "Downloading $ASSET_NAME..."
  mkdir -p "$BIN_DIR"

  download_asset "$ASSET_NAME" "$DOWNLOAD_FILE" || die "Failed to download binary."
  download_asset "checksums.txt" "$CHECKSUMS_FILE" || die "Failed to download checksums.txt."

  EXPECTED="$(awk -v n="$ASSET_NAME" '$2 == n || $2 == "*" n { print $1; exit }' "$CHECKSUMS_FILE" | tr '[:upper:]' '[:lower:]')"
  [ -z "$EXPECTED" ] && die "No checksum for $ASSET_NAME in checksums.txt."

  ACTUAL="$(sha256_of "$DOWNLOAD_FILE")" \
    || die "Cannot verify the checksum: neither sha256sum nor shasum is installed."
  [ -z "$ACTUAL" ] && die "Cannot verify the checksum: hashing $DOWNLOAD_FILE failed."

  if [ "$ACTUAL" != "$EXPECTED" ]; then
    die "Checksum mismatch for $ASSET_NAME (expected $EXPECTED, got $ACTUAL). Not installing."
  fi

  chmod +x "$DOWNLOAD_FILE"
  mv -f "$DOWNLOAD_FILE" "$BIN_PATH"
  ok "Installed sentinal v$VERSION to $BIN_PATH (checksum verified)"
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
