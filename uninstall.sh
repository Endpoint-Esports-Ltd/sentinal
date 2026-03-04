#!/usr/bin/env bash
#
# Sentinal Uninstaller
#
# Automatically detects Claude Code or OpenCode and uninstalls the appropriate plugin.
# Usage:
#   ./uninstall.sh           # Auto-detect and uninstall
#   ./uninstall.sh claude    # Force Claude Code uninstallation
#   ./uninstall.sh opencode  # Force OpenCode uninstallation
#   ./uninstall.sh --help    # Show help
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

show_help() {
  echo "Sentinal Uninstaller"
  echo ""
  echo "Usage: $0 [options]"
  echo ""
  echo "Options:"
  echo "  claude      Uninstall from Claude Code only"
  echo "  opencode    Uninstall from OpenCode only"
  echo "  both        Uninstall from both assistants"
  echo "  --help      Show this help message"
  echo ""
  echo "With no option, automatically detects installed plugins."
}

uninstall_claude() {
  echo -e "${BLUE}Uninstalling from Claude Code...${NC}"
  bash "$SCRIPT_DIR/targets/claude-code/uninstall.sh"
}

uninstall_opencode() {
  echo -e "${BLUE}Uninstalling from OpenCode...${NC}"
  bash "$SCRIPT_DIR/targets/opencode/uninstall.sh"
}

# Parse arguments
TARGET="${1:-auto}"

case "$TARGET" in
  --help|-h)
    show_help
    exit 0
    ;;
  claude)
    uninstall_claude
    exit 0
    ;;
  opencode)
    uninstall_opencode
    exit 0
    ;;
  both)
    uninstall_claude
    echo ""
    uninstall_opencode
    exit 0
    ;;
  auto)
    # Auto-detect
    ;;
  *)
    echo -e "${RED}Unknown option: $TARGET${NC}"
    show_help
    exit 1
    ;;
esac

# Auto-detection mode
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
echo "║   Quality Enforcement for TypeScript, Angular, and NestJS         ║"
echo "║   Uninstaller                                                      ║"
echo "║                                                                    ║"
echo "╚════════════════════════════════════════════════════════════════════╝"
echo -e "${NC}"
echo ""

# Check for installed plugins
echo -e "${YELLOW}Detecting Sentinal installations...${NC}"

CLAUDE_PLUGIN="$HOME/.claude/plugins/sentinal"
OPENCODE_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
OPENCODE_PLUGIN="$OPENCODE_CONFIG/plugins/sentinal.ts"

HAS_CLAUDE=false
HAS_OPENCODE=false

if [[ -d "$CLAUDE_PLUGIN" ]]; then
  HAS_CLAUDE=true
  echo -e "${GREEN}✓${NC} Claude Code plugin found"
else
  echo -e "${YELLOW}!${NC} Claude Code plugin not found"
fi

if [[ -f "$OPENCODE_PLUGIN" ]]; then
  HAS_OPENCODE=true
  echo -e "${GREEN}✓${NC} OpenCode plugin found"
else
  echo -e "${YELLOW}!${NC} OpenCode plugin not found"
fi

echo ""

if [ "$HAS_CLAUDE" = false ] && [ "$HAS_OPENCODE" = false ]; then
  echo -e "${YELLOW}No Sentinal installations detected.${NC}"
  echo "Nothing to uninstall."
  exit 0
fi

# If only one installation, uninstall that one
if [ "$HAS_CLAUDE" = true ] && [ "$HAS_OPENCODE" = false ]; then
  echo -e "${YELLOW}Only Claude Code installation detected.${NC}"
  uninstall_claude
elif [ "$HAS_CLAUDE" = false ] && [ "$HAS_OPENCODE" = true ]; then
  echo -e "${YELLOW}Only OpenCode installation detected.${NC}"
  uninstall_opencode
else
  # Both installations found - ask user
  echo -e "${YELLOW}Both Claude Code and OpenCode installations detected.${NC}"
  echo ""
  echo "Select uninstallation target:"
  echo ""
  echo "  1) Claude Code only"
  echo "  2) OpenCode only"
  echo "  3) Both assistants"
  echo "  4) Cancel"
  echo ""
  
  read -p "Enter your choice [1-4]: " choice
  
  case "$choice" in
    1)
      uninstall_claude
      ;;
    2)
      uninstall_opencode
      ;;
    3)
      echo ""
      uninstall_claude
      echo ""
      uninstall_opencode
      ;;
    *)
      echo "Uninstallation cancelled."
      exit 0
      ;;
  esac
fi

echo ""
echo -e "${GREEN}Uninstallation complete!${NC}"
