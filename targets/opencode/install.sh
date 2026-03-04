#!/usr/bin/env bash
#
# Sentinal for OpenCode - Installation Script
#
# This script installs Sentinal quality enforcement plugin for OpenCode TUI.
# It can be run from anywhere - it will detect the Sentinal source directory.
#
# Usage:
#   ./install.sh           # Install globally
#   ./install.sh --local   # Install to current project only
#

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Detect script location (works even when called via symlink)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SENTINAL_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"

# OpenCode configuration directories
OPENCODE_GLOBAL_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
OPENCODE_GLOBAL_PLUGINS="$OPENCODE_GLOBAL_CONFIG/plugins"
OPENCODE_GLOBAL_COMMANDS="$OPENCODE_GLOBAL_CONFIG/commands"
OPENCODE_GLOBAL_RULES="$OPENCODE_GLOBAL_CONFIG/rules"
OPENCODE_GLOBAL_TOOLS="$OPENCODE_GLOBAL_CONFIG/tools"
SENTINAL_SHARED_LIB="$SENTINAL_ROOT/src"

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
echo "║   Quality Enforcement for TypeScript, Angular, and NestJS         ║"
echo "║   OpenCode Edition                                                 ║"
echo "║                                                                    ║"
echo "╚════════════════════════════════════════════════════════════════════╝"
echo -e "${NC}"
echo ""

# Check prerequisites
echo -e "${YELLOW}Checking prerequisites...${NC}"

# Check for OpenCode
if ! command -v opencode &> /dev/null; then
  echo -e "${RED}✗ OpenCode not found${NC}"
  echo ""
  echo "Install OpenCode from https://opencode.ai:"
  echo "  curl -fsSL https://opencode.ai/install | bash"
  echo ""
  exit 1
fi
echo -e "${GREEN}✓ OpenCode found${NC}"

# Check for Bun (required for plugin execution)
if ! command -v bun &> /dev/null; then
  echo -e "${YELLOW}! Bun not found (optional but recommended)${NC}"
  echo "  Install from https://bun.sh for best performance"
else
  echo -e "${GREEN}✓ Bun found${NC}"
fi

# Check for Node.js (fallback)
if ! command -v node &> /dev/null; then
  echo -e "${RED}✗ Node.js not found${NC}"
  echo "  Install Node.js 18+ from https://nodejs.org"
  exit 1
fi
echo -e "${GREEN}✓ Node.js found${NC}"

echo ""

# Determine target directories
if [[ "$INSTALL_MODE" == "local" ]]; then
  TARGET_DIR="$(pwd)/.opencode"
  PLUGINS_DIR="$TARGET_DIR/plugins"
  COMMANDS_DIR="$TARGET_DIR/commands"
  RULES_DIR="$TARGET_DIR/rules"
  TOOLS_DIR="$TARGET_DIR/tools"
  echo -e "${BLUE}Installing to current project: $TARGET_DIR${NC}"
else
  TARGET_DIR="$OPENCODE_GLOBAL_CONFIG"
  PLUGINS_DIR="$OPENCODE_GLOBAL_PLUGINS"
  COMMANDS_DIR="$OPENCODE_GLOBAL_COMMANDS"
  RULES_DIR="$OPENCODE_GLOBAL_RULES"
  TOOLS_DIR="$OPENCODE_GLOBAL_TOOLS"
  echo -e "${BLUE}Installing globally: $TARGET_DIR${NC}"
fi

echo ""

# Create directories
echo -e "${YELLOW}Creating directories...${NC}"
mkdir -p "$PLUGINS_DIR"
mkdir -p "$COMMANDS_DIR"
mkdir -p "$RULES_DIR"
mkdir -p "$TOOLS_DIR"
mkdir -p "$TARGET_DIR/src"
echo -e "${GREEN}✓ Directories created${NC}"

# Install shared library (required by plugin)
echo -e "${YELLOW}Installing shared library...${NC}"
cp -r "$SENTINAL_SHARED_LIB" "$TARGET_DIR/"
echo -e "${GREEN}✓ Shared library installed: $TARGET_DIR/src${NC}"

# Install plugin
echo -e "${YELLOW}Installing Sentinal plugin...${NC}"
cp "$SCRIPT_DIR/plugins/sentinal.ts" "$PLUGINS_DIR/"
echo -e "${GREEN}✓ Plugin installed: $PLUGINS_DIR/sentinal.ts${NC}"

# Install commands
echo -e "${YELLOW}Installing commands...${NC}"
for cmd in "$SCRIPT_DIR/commands/"*.md; do
  if [[ -f "$cmd" ]]; then
    cp "$cmd" "$COMMANDS_DIR/"
    echo -e "  ${GREEN}✓${NC} $(basename "$cmd")"
  fi
done

# Install rules
echo -e "${YELLOW}Installing rules...${NC}"
for rule in "$SCRIPT_DIR/rules/"*.md; do
  if [[ -f "$rule" ]]; then
    cp "$rule" "$RULES_DIR/"
    echo -e "  ${GREEN}✓${NC} $(basename "$rule")"
  fi
done

# Install custom tool
echo -e "${YELLOW}Installing custom tools...${NC}"
if [[ -f "$SCRIPT_DIR/tools/sentinal-check.ts" ]]; then
  cp "$SCRIPT_DIR/tools/sentinal-check.ts" "$TOOLS_DIR/"
  echo -e "  ${GREEN}✓${NC} sentinal-check.ts"
fi

# Create/update AGENTS.md
echo -e "${YELLOW}Creating AGENTS.md...${NC}"
if [[ "$INSTALL_MODE" == "global" ]]; then
  cat > "$TARGET_DIR/AGENTS.md" << 'EOF'
# Sentinal Global Standards

This file is automatically loaded by OpenCode for all projects.

## Quality Enforcement

Sentinal automatically enforces quality standards on every file edit:
- **File length:** Warn at 400 lines, block at 600 lines (test files exempt)
- **TDD:** Check for companion test files on implementation files
- **NestJS:** Validate decorators on controllers, DTOs, and entities
- **TypeScript:** Run tsc --noEmit for type checking

Note: Prettier and ESLint are handled automatically by OpenCode's built-in formatter system.

## Commands

- `/spec <task>` - Start a spec-driven plan-implement-verify workflow
- `/spec <plan.md>` - Resume an existing plan
- `/sync` - Analyze codebase and generate project-specific rules
- `/learn` - Extract reusable knowledge from this session

## Rule Files

The following rule files are loaded based on project context. Read them on a need-to-know basis:

- `standards-typescript.md` - TypeScript best practices
- `standards-angular.md` - Angular 17+ patterns (signals, control flow, standalone)
- `standards-nestjs.md` - NestJS patterns (DTOs, guards, Swagger)
- `standards-frontend.md` - Tailwind CSS, accessibility, responsive design
- `standards-backend.md` - REST API, security, database patterns
EOF
  echo -e "${GREEN}✓ Global AGENTS.md created${NC}"
else
  # For local installs, append to existing AGENTS.md if it exists
  if [[ -f "$(pwd)/AGENTS.md" ]]; then
    echo "" >> "$(pwd)/AGENTS.md"
    echo "## Sentinal Quality Enforcement" >> "$(pwd)/AGENTS.md"
    echo "" >> "$(pwd)/AGENTS.md"
    echo "This project uses Sentinal for quality enforcement. See \`.opencode/rules/\` for coding standards." >> "$(pwd)/AGENTS.md"
    echo -e "${GREEN}✓ Updated existing AGENTS.md${NC}"
  else
    cat > "$(pwd)/AGENTS.md" << 'EOF'
# Project Name

TODO: Add project description.

## Sentinal Quality Enforcement

This project uses Sentinal for quality enforcement. See `.opencode/rules/` for coding standards.

## Commands

- `/spec <task>` - Start a spec-driven plan-implement-verify workflow
- `/sync` - Analyze codebase and generate project-specific rules
EOF
    echo -e "${GREEN}✓ Created AGENTS.md${NC}"
  fi
fi

# Create opencode.json config if global install
if [[ "$INSTALL_MODE" == "global" ]]; then
  echo -e "${YELLOW}Creating OpenCode configuration...${NC}"
  
  if [[ -f "$TARGET_DIR/opencode.json" ]]; then
    echo -e "${YELLOW}! Existing opencode.json found - not overwriting${NC}"
    echo "  To use Sentinal MCP servers, manually merge from:"
    echo "  $SCRIPT_DIR/opencode.json"
  else
    cp "$SCRIPT_DIR/opencode.json" "$TARGET_DIR/"
    echo -e "${GREEN}✓ OpenCode configuration created${NC}"
  fi
fi

echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Sentinal for OpenCode installed successfully!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${BLUE}What was installed:${NC}"
echo "  • Plugin:   $PLUGINS_DIR/sentinal.ts"
echo "  • Commands: $COMMANDS_DIR/*.md"
echo "  • Rules:    $RULES_DIR/*.md"
echo "  • Tools:    $TOOLS_DIR/sentinal-check.ts"
if [[ "$INSTALL_MODE" == "global" ]]; then
  echo "  • Config:   $TARGET_DIR/opencode.json"
fi
echo ""
echo -e "${BLUE}Get started:${NC}"
echo "  1. Navigate to a project:  cd /path/to/project"
echo "  2. Run OpenCode:           opencode"
echo "  3. Initialize project:     /init"
echo "  4. Sync project rules:     /sync"
echo "  5. Start a workflow:       /spec 'add user authentication'"
echo ""
echo -e "${BLUE}Features:${NC}"
echo "  • Automatic quality checks on every file edit"
echo "  • TypeScript, Angular 17+, and NestJS standards"
echo "  • Spec-driven development with /spec workflow"
echo "  • File length enforcement (400 warn, 600 block)"
echo "  • TDD enforcement with companion test file checks"
echo ""
