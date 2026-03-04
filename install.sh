#!/usr/bin/env bash
#
# Sentinal Installer
#
# Automatically detects Claude Code or OpenCode and installs the appropriate plugin.
# Usage:
#   ./install.sh           # Auto-detect and install
#   ./install.sh claude   # Force Claude Code installation
#   ./install.sh opencode # Force OpenCode installation
#   ./install.sh --help   # Show help
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

show_help() {
  echo "Sentinal Installer"
  echo ""
  echo "Usage: $0 [options]"
  echo ""
  echo "Options:"
  echo "  claude      Install for Claude Code only"
  echo "  opencode   Install for OpenCode only"
  echo "  both       Install for both assistants"
  echo "  --help     Show this help message"
  echo ""
  echo "With no option, automatically detects available assistants."
}

detect_assistants() {
  local claude_found=false
  local opencode_found=false

  if command -v claude &>/dev/null; then
    claude_found=true
  fi

  if command -v opencode &>/dev/null; then
    opencode_found=true
  fi

  echo "$claude_found,$opencode_found"
}

install_claude() {
  echo -e "${BLUE}Installing for Claude Code...${NC}"
  bash "$SCRIPT_DIR/targets/claude-code/install.sh"
}

install_opencode() {
  echo -e "${BLUE}Installing for OpenCode...${NC}"
  bash "$SCRIPT_DIR/targets/opencode/install.sh"
}

# Parse arguments
TARGET="${1:-auto}"

case "$TARGET" in
  --help|-h)
    show_help
    exit 0
    ;;
  claude)
    install_claude
    exit 0
    ;;
  opencode)
    install_opencode
    exit 0
    ;;
  both)
    install_claude
    echo ""
    install_opencode
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
echo "║                                                                    ║"
echo "╚════════════════════════════════════════════════════════════════════╝"
echo -e "${NC}"
echo ""

# Check for assistants
echo -e "${YELLOW}Detecting AI assistants...${NC}"

HAS_CLAUDE=false
HAS_OPENCODE=false

if command -v claude &>/dev/null; then
  HAS_CLAUDE=true
  echo -e "${GREEN}✓${NC} Claude Code found"
else
  echo -e "${YELLOW}!${NC} Claude Code not found"
fi

if command -v opencode &>/dev/null; then
  HAS_OPENCODE=true
  echo -e "${GREEN}✓${NC} OpenCode found"
else
  echo -e "${YELLOW}!${NC} OpenCode not found"
fi

echo ""

if [ "$HAS_CLAUDE" = false ] && [ "$HAS_OPENCODE" = false ]; then
  echo -e "${RED}Error: No AI assistant detected${NC}"
  echo ""
  echo "Please install at least one of:"
  echo "  - Claude Code: https://claude.com/download"
  echo "  - OpenCode: https://opencode.ai"
  exit 1
fi

# If only one assistant, install for that one
if [ "$HAS_CLAUDE" = true ] && [ "$HAS_OPENCODE" = false ]; then
  echo -e "${YELLOW}Only Claude Code detected. Installing for Claude Code...${NC}"
  install_claude
elif [ "$HAS_CLAUDE" = false ] && [ "$HAS_OPENCODE" = true ]; then
  echo -e "${YELLOW}Only OpenCode detected. Installing for OpenCode...${NC}"
  install_opencode
else
  # Both assistants found - ask user
  echo -e "${YELLOW}Both Claude Code and OpenCode detected.${NC}"
  echo ""
  echo "Select installation target:"
  echo ""
  echo "  1) Claude Code only"
  echo "  2) OpenCode only"
  echo "  3) Both assistants"
  echo "  4) Cancel"
  echo ""
  
  read -p "Enter your choice [1-4]: " choice
  
  case "$choice" in
    1)
      install_claude
      ;;
    2)
      install_opencode
      ;;
    3)
      echo ""
      install_claude
      echo ""
      install_opencode
      ;;
    *)
      echo "Installation cancelled."
      exit 0
      ;;
  esac
fi

echo ""
echo -e "${GREEN}Installation complete!${NC}"
