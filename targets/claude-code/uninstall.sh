#!/usr/bin/env bash
set -euo pipefail

MARKETPLACE_DIR="$HOME/.claude/plugins/sentinal-marketplace"
MARKETPLACE_NAME="sentinal-marketplace"
PLUGIN_NAME="sentinal"

echo "Sentinal for Claude Code — Uninstaller"
echo "======================================="
echo ""

if ! command -v claude &>/dev/null; then
  echo "ERROR: Claude Code CLI not found. Cannot uninstall."
  exit 1
fi

# ── Uninstall plugin ─────────────────────────────────────────────────────────

FOUND_SOMETHING=false

if claude plugin list 2>/dev/null | grep -q "$PLUGIN_NAME@$MARKETPLACE_NAME"; then
  echo "Uninstalling plugin..."
  claude plugin uninstall "$PLUGIN_NAME@$MARKETPLACE_NAME"
  echo "[OK] Plugin uninstalled: $PLUGIN_NAME@$MARKETPLACE_NAME"
  FOUND_SOMETHING=true
else
  echo "[--] Plugin not installed, skipping."
fi

# ── Remove marketplace ───────────────────────────────────────────────────────

if claude plugin marketplace list 2>/dev/null | grep -q "$MARKETPLACE_NAME"; then
  echo "Removing marketplace..."
  claude plugin marketplace remove "$MARKETPLACE_NAME"
  echo "[OK] Marketplace removed: $MARKETPLACE_NAME"
  FOUND_SOMETHING=true
else
  echo "[--] Marketplace not registered, skipping."
fi

# ── Clean up local marketplace directory ─────────────────────────────────────

if [[ -d "$MARKETPLACE_DIR" ]]; then
  echo "Removing marketplace directory..."
  rm -rf "$MARKETPLACE_DIR"
  echo "[OK] Removed: $MARKETPLACE_DIR"
  FOUND_SOMETHING=true
else
  echo "[--] Marketplace directory not found, skipping."
fi

# ── Done ─────────────────────────────────────────────────────────────────────

echo ""
if [[ "$FOUND_SOMETHING" == true ]]; then
  echo "======================================="
  echo "  Sentinal for Claude Code uninstalled."
  echo "======================================="
  echo ""
  echo "  Restart Claude Code to complete removal."
else
  echo "  Nothing to uninstall — Sentinal was not found."
fi
echo ""
