#!/usr/bin/env bash
# Verify exactly what the next commit would contain: export the INDEX to a temp
# dir and run the repo's gates there. Exit 0 only if every gate passes.
# Usage: verify-index.sh [bun test args...]   (no args = full suite)
set -uo pipefail
R=$(git rev-parse --show-toplevel)
X=$(mktemp -d "${TMPDIR:-/tmp}/verify-index.XXXXXX")
trap 'rm -rf "$X"' EXIT
git -C "$R" checkout-index -a --prefix="$X/"
ln -s "$R/node_modules" "$X/node_modules"
cd "$X"
# Git-dependent tests (findGitRoot, isInsideGitRepo, .sentinal/.gitignore) need a repo.
git init -q . && git add -A >/dev/null 2>&1
# The package script, NOT scripts/embed-assets.mjs: it builds the plugin first.
bun run embed-assets >"$X/.embed.log" 2>&1 || { echo "FAIL embed-assets"; tail -5 "$X/.embed.log"; exit 1; }
fail=0
bunx tsc --noEmit >"$X/.tsc.log" 2>&1 && echo "ok   tsc (src)" || { echo "FAIL tsc (src)"; tail -5 "$X/.tsc.log"; fail=1; }
cat >"$X/tsconfig.plugin.json" <<'EOF'
{ "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": true, "allowImportingTsExtensions": true },
  "include": ["targets/opencode/plugins/sentinal.ts", "targets/opencode/plugins/sentinal-helpers.ts",
              "targets/opencode/plugins/sentinal.test.ts", "targets/opencode/plugins/sentinal-helpers.test.ts"] }
EOF
bunx tsc -p tsconfig.plugin.json >"$X/.ptsc.log" 2>&1 && echo "ok   tsc (plugin)" || { echo "FAIL tsc (plugin)"; tail -5 "$X/.ptsc.log"; fail=1; }
bun test "$@" >"$X/.test.log" 2>&1
summary=$(grep -E '^ *[0-9]+ (pass|fail)$' "$X/.test.log" | tr -s ' \n' ' ')
nfail=$(grep -E '^ *[0-9]+ fail$' "$X/.test.log" | tail -1 | tr -dc '0-9')
if [ "${nfail:-1}" = "0" ]; then echo "ok   tests:$summary"; else echo "FAIL tests:$summary"; grep -E '^\(fail\)' "$X/.test.log" | head -10; fail=1; fi
exit $fail
