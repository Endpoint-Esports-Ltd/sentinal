#!/bin/sh
# Sentinal Memory MCP Server shim
# Ensures the MCP server runs under Bun (required for bun:sqlite)
SCRIPT_DIR="$(cd "$(dirname "$(realpath "$0")")" && pwd)"
exec bun run "$SCRIPT_DIR/../src/memory/mcp-server.ts" "$@"
