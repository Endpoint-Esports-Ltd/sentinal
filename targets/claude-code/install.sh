#!/usr/bin/env bash
set -euo pipefail

SENTINAL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLAUDE_TARGET="$SENTINAL_ROOT/targets/claude-code"
MARKETPLACE_DIR="$HOME/.claude/plugins/sentinal-marketplace"
MARKETPLACE_NAME="sentinal-marketplace"
PLUGIN_NAME="sentinal"

echo "Sentinal for Claude Code — TypeScript/Angular/NestJS Quality Enforcement"
echo "========================================================================="
echo ""

# ── Prerequisites ────────────────────────────────────────────────────────────

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

if ! command -v bun &>/dev/null; then
  echo "ERROR: Bun is required. Install from https://bun.sh"
  exit 1
fi
echo "[OK] Bun v$(bun --version)"

if ! command -v claude &>/dev/null; then
  echo "ERROR: Claude Code CLI is required."
  echo "  Install: npm install -g @anthropic-ai/claude-code"
  exit 1
fi
echo "[OK] Claude Code CLI"

# ── Build ────────────────────────────────────────────────────────────────────

echo ""
echo "Installing dependencies..."
cd "$SENTINAL_ROOT"
bun install

echo ""
echo "Building hooks..."
bun run build

# ── Remove previous installation (if any) ────────────────────────────────────

# Silently uninstall existing plugin & marketplace to avoid conflicts
if claude plugin list 2>/dev/null | grep -q "$PLUGIN_NAME@$MARKETPLACE_NAME"; then
  echo ""
  echo "Removing previous Sentinal installation..."
  claude plugin uninstall "$PLUGIN_NAME@$MARKETPLACE_NAME" 2>/dev/null || true
fi

if claude plugin marketplace list 2>/dev/null | grep -q "$MARKETPLACE_NAME"; then
  claude plugin marketplace remove "$MARKETPLACE_NAME" 2>/dev/null || true
fi

# Clean previous marketplace directory
rm -rf "$MARKETPLACE_DIR"

# ── Create local marketplace ─────────────────────────────────────────────────

echo ""
echo "Creating local marketplace..."

PLUGIN_DIR="$MARKETPLACE_DIR/plugins/$PLUGIN_NAME"

mkdir -p "$MARKETPLACE_DIR/.claude-plugin"
mkdir -p "$PLUGIN_DIR"

# Write marketplace manifest
cat > "$MARKETPLACE_DIR/.claude-plugin/marketplace.json" <<EOF
{
  "name": "$MARKETPLACE_NAME",
  "owner": {
    "name": "Endpoint Esports"
  },
  "metadata": {
    "description": "Sentinal quality enforcement plugin for Claude Code"
  },
  "plugins": [
    {
      "name": "$PLUGIN_NAME",
      "source": "./plugins/$PLUGIN_NAME",
      "description": "Quality enforcement for TypeScript, Angular, and NestJS projects"
    }
  ]
}
EOF

# Copy the entire plugin (including dotfiles) into the marketplace
cp -r "$CLAUDE_TARGET/." "$PLUGIN_DIR/"

# Remove files that shouldn't be in the installed plugin
rm -f "$PLUGIN_DIR/install.sh"
rm -f "$PLUGIN_DIR/uninstall.sh"
rm -f "$PLUGIN_DIR/tsconfig.json"

echo "[OK] Marketplace created at $MARKETPLACE_DIR"

# ── Register & install ───────────────────────────────────────────────────────

echo ""
echo "Registering marketplace..."
claude plugin marketplace add "$MARKETPLACE_DIR"
echo "[OK] Marketplace registered: $MARKETPLACE_NAME"

echo ""
echo "Installing plugin..."
claude plugin install "$PLUGIN_NAME@$MARKETPLACE_NAME"
echo "[OK] Plugin installed: $PLUGIN_NAME@$MARKETPLACE_NAME"

# ── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "========================================================================="
echo "  Sentinal for Claude Code installed successfully!"
echo "========================================================================="
echo ""
echo "  Plugin: $PLUGIN_NAME@$MARKETPLACE_NAME"
echo ""
echo "  Available commands:"
echo "    /sentinal:spec              Spec-driven development workflow"
echo "    /sentinal:spec-plan         Feature planning phase"
echo "    /sentinal:spec-bugfix-plan  Bugfix planning phase"
echo "    /sentinal:spec-implement    TDD implementation phase"
echo "    /sentinal:spec-verify       Feature verification"
echo "    /sentinal:spec-bugfix-verify Bugfix verification"
echo "    /sentinal:sync              Sync project rules"
echo "    /sentinal:learn             Extract session knowledge"
echo ""
echo "  Restart Claude Code to activate the plugin."
echo ""
