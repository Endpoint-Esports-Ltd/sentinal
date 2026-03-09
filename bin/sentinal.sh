#!/bin/sh
# Sentinal CLI shim
# Routes all commands through the unified CLI entry point under Bun
SCRIPT_DIR="$(cd "$(dirname "$(realpath "$0")")" && pwd)"
exec bun run "$SCRIPT_DIR/../src/cli/index.ts" "$@"
