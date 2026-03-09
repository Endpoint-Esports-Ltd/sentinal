#!/usr/bin/env bash
#
# Sentinal for OpenCode - Uninstallation Script
#
# This script removes Sentinal quality enforcement plugin from OpenCode TUI.
#
# Usage:
#   ./uninstall.sh           # Uninstall globally
#   ./uninstall.sh --local   # Uninstall from current project only
#

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Detect script location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# OpenCode configuration directories
OPENCODE_GLOBAL_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
OPENCODE_GLOBAL_PLUGINS="$OPENCODE_GLOBAL_CONFIG/plugins"
OPENCODE_GLOBAL_COMMANDS="$OPENCODE_GLOBAL_CONFIG/commands"
OPENCODE_GLOBAL_RULES="$OPENCODE_GLOBAL_CONFIG/rules"
OPENCODE_GLOBAL_TOOLS="$OPENCODE_GLOBAL_CONFIG/tools"

# Parse arguments
INSTALL_MODE="global"
if [[ "${1:-}" == "--local" ]]; then
  INSTALL_MODE="local"
fi

echo -e "${BLUE}"
echo "╔════════════════════════════════════════════════════════════════════╗"
echo "║                                                                    ║"
echo "║   ███████╗███████╗███╗   ██╗████████╗██╗███╗   ██╗ █████╗ ██╗     ║"
echo "║   ██╔════╝██╔════╝████╗  ██║╚══██╔══╝██║████╗  ██║██╔══██╗██║     ║"
echo "║   ███████╗█████╗  ██╔██╗ ██║   ██║   ██║██╔██╗ ██║███████║██║     ║"
echo "║   ╚════██║██╔══╝  ██║╚██╗██║   ██║   ██║██║╚██╗██║██╔══██║██║     ║"
echo "║   ███████║███████╗██║ ╚████║   ██║   ██║██║ ╚████║██║  ██║███████╗║"
echo "║   ╚══════╝╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝╚══════╝║"
echo "║                                                                    ║"
echo "║   Uninstalling Sentinal for OpenCode                              ║"
echo "║                                                                    ║"
echo "╚════════════════════════════════════════════════════════════════════╝"
echo -e "${NC}"
echo ""

# Determine target directories
if [[ "$INSTALL_MODE" == "local" ]]; then
  TARGET_DIR="$(pwd)/.opencode"
  PLUGINS_DIR="$TARGET_DIR/plugins"
  COMMANDS_DIR="$TARGET_DIR/commands"
  RULES_DIR="$TARGET_DIR/rules"
  TOOLS_DIR="$TARGET_DIR/tools"
  echo -e "${BLUE}Uninstalling from current project: $TARGET_DIR${NC}"
else
  TARGET_DIR="$OPENCODE_GLOBAL_CONFIG"
  PLUGINS_DIR="$OPENCODE_GLOBAL_PLUGINS"
  COMMANDS_DIR="$OPENCODE_GLOBAL_COMMANDS"
  RULES_DIR="$OPENCODE_GLOBAL_RULES"
  TOOLS_DIR="$OPENCODE_GLOBAL_TOOLS"
  echo -e "${BLUE}Uninstalling globally: $TARGET_DIR${NC}"
fi

echo ""

# Remove plugin
echo -e "${YELLOW}Removing Sentinal plugin...${NC}"
if [[ -f "$PLUGINS_DIR/sentinal.ts" ]]; then
  rm -f "$PLUGINS_DIR/sentinal.ts"
  echo -e "${GREEN}✓ Plugin removed${NC}"
else
  echo -e "${YELLOW}! Plugin not found${NC}"
fi

# Remove commands
echo -e "${YELLOW}Removing commands...${NC}"
if [[ -d "$COMMANDS_DIR" ]]; then
  for cmd in spec spec-plan spec-implement spec-verify spec-bugfix-plan spec-bugfix-verify sync learn; do
    if [[ -f "$COMMANDS_DIR/$cmd.md" ]]; then
      rm -f "$COMMANDS_DIR/$cmd.md"
      echo -e "  ${GREEN}✓${NC} $cmd.md"
    fi
  done
fi

# Remove rules
echo -e "${YELLOW}Removing rules...${NC}"
if [[ -d "$RULES_DIR" ]]; then
  for rule in standards-typescript standards-angular standards-nestjs standards-frontend standards-backend; do
    if [[ -f "$RULES_DIR/$rule.md" ]]; then
      rm -f "$RULES_DIR/$rule.md"
      echo -e "  ${GREEN}✓${NC} $rule.md"
    fi
  done
fi

# Remove tools
echo -e "${YELLOW}Removing custom tools...${NC}"
if [[ -f "$TOOLS_DIR/sentinal-check.ts" ]]; then
  rm -f "$TOOLS_DIR/sentinal-check.ts"
  echo -e "${GREEN}✓ Tool removed${NC}"
else
  echo -e "${YELLOW}! Tool not found${NC}"
fi

# Remove @endpoint/sentinal package
echo -e "${YELLOW}Removing @endpoint/sentinal package...${NC}"
if command -v bun &> /dev/null && bun pm ls 2>/dev/null | grep -q "@endpoint/sentinal"; then
  bun remove @endpoint/sentinal 2>/dev/null || true
  echo -e "${GREEN}✓ @endpoint/sentinal removed${NC}"
else
  echo -e "${YELLOW}! @endpoint/sentinal not found or bun unavailable${NC}"
fi

# Remove AGENTS.md (only if global and it appears to be Sentinal's)
if [[ "$INSTALL_MODE" == "global" ]]; then
  echo -e "${YELLOW}Removing AGENTS.md...${NC}"
  if [[ -f "$TARGET_DIR/AGENTS.md" ]]; then
    if grep -q "Sentinal Global Standards" "$TARGET_DIR/AGENTS.md" 2>/dev/null; then
      rm -f "$TARGET_DIR/AGENTS.md"
      echo -e "${GREEN}✓ AGENTS.md removed${NC}"
    else
      echo -e "${YELLOW}! AGENTS.md not created by Sentinal, skipping${NC}"
    fi
  fi
fi

# Remove Sentinal entries from opencode.json / opencode.jsonc
echo -e "${YELLOW}Cleaning opencode config...${NC}"
if [[ "$INSTALL_MODE" == "local" ]]; then
  CONFIG_DIR="$(pwd)"
  PLUGIN_PATH=".opencode/plugins/sentinal.ts"
else
  CONFIG_DIR="$TARGET_DIR"
  PLUGIN_PATH="$OPENCODE_GLOBAL_PLUGINS/sentinal.ts"
fi

# Find the config file
CONFIG_FILE=""
if [[ -f "$CONFIG_DIR/opencode.json" ]]; then
  CONFIG_FILE="$CONFIG_DIR/opencode.json"
elif [[ -f "$CONFIG_DIR/opencode.jsonc" ]]; then
  CONFIG_FILE="$CONFIG_DIR/opencode.jsonc"
fi

if [[ -n "$CONFIG_FILE" ]] && command -v jq &> /dev/null; then
  # Read content (strip comments for .jsonc)
  if [[ "$CONFIG_FILE" == *.jsonc ]]; then
    CONFIG_CONTENT=$(sed 's|//.*$||' "$CONFIG_FILE" | sed '/^\s*$/d')
  else
    CONFIG_CONTENT=$(cat "$CONFIG_FILE")
  fi

  if echo "$CONFIG_CONTENT" | jq empty 2>/dev/null; then
    UPDATED="$CONFIG_CONTENT"

    # Remove Sentinal plugin from plugin array
    UPDATED=$(echo "$UPDATED" | jq --arg p "$PLUGIN_PATH" '.plugin = ([(.plugin // [])[] | select(. != $p)])')

    # Remove Sentinal MCP servers
    SENTINAL_MCP_KEYS=("context7" "web-search" "grep-mcp" "web-fetch" "sentinal-memory")
    for key in "${SENTINAL_MCP_KEYS[@]}"; do
      UPDATED=$(echo "$UPDATED" | jq --arg k "$key" 'if .mcp then .mcp |= del(.[$k]) else . end')
    done

    # Check if config is now essentially empty (only schema, empty plugin, empty mcp, empty lsp)
    REMAINING=$(echo "$UPDATED" | jq '[
      (if (.plugin // []) | length > 0 then 1 else 0 end),
      (if (.mcp // {}) | keys | length > 0 then 1 else 0 end),
      (if (del(."$schema") | del(.plugin) | del(.mcp) | del(.lsp)) | keys | length > 0 then 1 else 0 end)
    ] | add')

    if [[ "$REMAINING" == "0" ]]; then
      rm -f "$CONFIG_FILE"
      echo -e "${GREEN}✓ Config was Sentinal-only, removed: $CONFIG_FILE${NC}"
    else
      echo "$UPDATED" | jq '.' > "$CONFIG_FILE"
      echo -e "${GREEN}✓ Sentinal entries removed from config${NC}"
    fi
  else
    echo -e "${YELLOW}! Config has invalid JSON, skipping: $CONFIG_FILE${NC}"
  fi
elif [[ -n "$CONFIG_FILE" ]]; then
  echo -e "${YELLOW}! jq not found, cannot clean config. Manually remove Sentinal entries from: $CONFIG_FILE${NC}"
else
  echo -e "${YELLOW}! No opencode config found${NC}"
fi

# Clean up empty directories
echo -e "${YELLOW}Cleaning up empty directories...${NC}"
for dir in "$PLUGINS_DIR" "$COMMANDS_DIR" "$RULES_DIR" "$TOOLS_DIR"; do
  if [[ -d "$dir" ]] && [[ -z "$(ls -A "$dir" 2>/dev/null)" ]]; then
    rmdir "$dir" 2>/dev/null || true
  fi
done
echo -e "${GREEN}✓ Cleanup complete${NC}"

echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Sentinal for OpenCode uninstalled successfully!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════════════════${NC}"
echo ""
