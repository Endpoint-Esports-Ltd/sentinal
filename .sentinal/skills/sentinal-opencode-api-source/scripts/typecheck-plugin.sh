#!/usr/bin/env bash
# Type-check the OpenCode plugin graph. The root tsconfig includes only src/**,
# so `bunx tsc --noEmit` and check_diagnostics NEVER see targets/.
set -uo pipefail
R=$(git rev-parse --show-toplevel)
T=$(mktemp -d "${TMPDIR:-/tmp}/plugin-tsc.XXXXXX"); trap 'rm -rf "$T"' EXIT
P="$R/targets/opencode/plugins"
cat >"$T/tsconfig.json" <<EOF
{ "extends": "$R/tsconfig.json",
  "compilerOptions": { "noEmit": true, "allowImportingTsExtensions": true,
    "typeRoots": ["$R/node_modules", "$R/node_modules/@types"] },
  "include": ["$P/sentinal.ts", "$P/sentinal-helpers.ts", "$P/sentinal.test.ts", "$P/sentinal-helpers.test.ts"] }
EOF
cd "$R" && bunx tsc -p "$T/tsconfig.json" && echo "ok plugin graph type-checks"
