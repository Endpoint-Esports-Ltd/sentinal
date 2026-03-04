#!/usr/bin/env bash
#
# Sentinal for Claude Code - Uninstallation Script
#
# This script removes Sentinal quality enforcement plugin from Claude Code.
#
# Usage:
#   ./uninstall.sh
#

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PLUGIN_DEST="$HOME/.claude/plugins/sentinal"

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
echo "║   Uninstalling Sentinal for Claude Code                           ║"
echo "║                                                                    ║"
echo "╚════════════════════════════════════════════════════════════════════╝"
echo -e "${NC}"
echo ""

# Check if plugin exists
if [[ ! -d "$PLUGIN_DEST" ]]; then
  echo -e "${YELLOW}Sentinal plugin not found at $PLUGIN_DEST${NC}"
  echo "Nothing to uninstall."
  exit 0
fi

# Remove plugin directory
echo -e "${YELLOW}Removing Sentinal plugin...${NC}"
rm -rf "$PLUGIN_DEST"
echo -e "${GREEN}✓ Plugin removed: $PLUGIN_DEST${NC}"

echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Sentinal for Claude Code uninstalled successfully!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${BLUE}Note:${NC} You may also want to remove Sentinal from Claude Code settings:"
echo "  claude plugins remove sentinal"
echo ""
