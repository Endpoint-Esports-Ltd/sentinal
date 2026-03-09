#!/usr/bin/env bash
set -euo pipefail

SENTINAL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLAUDE_TARGET="$SENTINAL_ROOT/targets/claude-code"
PLUGIN_DEST="$HOME/.claude/plugins/sentinal"

echo "Sentinal — TypeScript/Angular/NestJS Guard for Claude Code"
echo "==========================================================="
echo ""

# Check Node.js 18+
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js is required (v18+). Install from https://nodejs.org"
  exit 1
fi

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: Node.js 18+ required (found v$(node -v))"
  exit 1
fi
echo "[OK] Node.js v$(node -v | tr -d 'v')"

# Check Bun
if ! command -v bun &>/dev/null; then
  echo "ERROR: Bun is required. Install from https://bun.sh"
  exit 1
fi
echo "[OK] Bun v$(bun --version)"

# Install dependencies
echo ""
echo "Installing dependencies..."
cd "$SENTINAL_ROOT"
bun install

# Build TypeScript hooks
echo ""
echo "Building hooks..."
bun run build

# Install plugin
echo ""
echo "Installing plugin to $PLUGIN_DEST..."
rm -rf "$PLUGIN_DEST"
mkdir -p "$PLUGIN_DEST"

# Copy plugin structure from targets/claude-code
cp -r "$CLAUDE_TARGET/"* "$PLUGIN_DEST/"

echo ""
echo "Sentinal installed successfully!"
echo ""
echo "Plugin location: $PLUGIN_DEST"
echo ""
echo "To activate, add to your Claude Code settings:"
echo "  claude plugins add $PLUGIN_DEST"
