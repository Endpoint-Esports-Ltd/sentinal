#!/usr/bin/env bash
# Type-check the OpenCode plugin graph. The root tsconfig includes only src/**,
# so `bunx tsc --noEmit` and check_diagnostics NEVER see targets/. The graph is
# defined once, in tsconfig.plugin.json (also what CI runs: `bun run typecheck:plugin`).
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" && bunx tsc -p tsconfig.plugin.json && echo "ok plugin graph type-checks"
