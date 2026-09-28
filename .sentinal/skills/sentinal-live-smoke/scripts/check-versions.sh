#!/usr/bin/env bash
# Is the new version actually RUNNING? Compares every independently-updated part.
# Exit 0 only if all four report the binary's version (a missing or pre-bake
# "0.1.0" Claude Code plugin.json is informational).
set -uo pipefail
H="${SENTINAL_HOME:-$HOME/.sentinal}"
want=$(sentinal --version 2>/dev/null | head -1)
side=$(curl -s --max-time 5 --unix-socket "$H/sidecar.sock" http://localhost/health 2>/dev/null \
       | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
spid=$(cat "$H/sidecar.pid" 2>/dev/null)
oc=$(grep -o 'return "[0-9][0-9.]*";' "$HOME/.config/opencode/plugins/sentinal.mjs" 2>/dev/null \
     | head -1 | tr -dc '0-9.')
ccver=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' \
     "$HOME/.claude/plugins/sentinal-marketplace/plugins/sentinal/.claude-plugin/plugin.json" 2>/dev/null | head -1)
row() { printf '%-22s %-10s %s\n' "$1" "${2:-<none>}" "$3"; }
# mark() runs inside $(...) — a subshell — so it cannot set `bad`; the check
# after each row does.
bad=0; mark() { [ "$1" = "$want" ] && echo ok || echo "$2"; }
row "binary"          "$want" "(reference)"
row "sidecar (pid ${spid:-?})" "$side" "$(mark "$side" '<- restart: sentinal sidecar restart')"; [ "$side" = "$want" ] || bad=1
row "opencode plugin" "$oc"   "$(mark "$oc" '<- redeploy: sentinal update --reinstall-plugins; then start a NEW session')"; [ "$oc" = "$want" ] || bad=1
# Releases bake the version into plugin.json since D6 (2026-09-28 plan). A
# missing install (OpenCode-only user) and the pre-bake "0.1.0" are
# informational; any other mismatch is a stale install.
if [ -z "$ccver" ]; then
  row "cc plugin.json" "$ccver" "(not installed)"
elif [ "$ccver" = "0.1.0" ]; then
  row "cc plugin.json" "$ccver" "(pre-bake install, informational — run: sentinal update)"
else
  row "cc plugin.json" "$ccver" "$(mark "$ccver" '<- reinstall: sentinal update --reinstall-plugins')"; [ "$ccver" = "$want" ] || bad=1
fi
[ "$bad" = 0 ] && echo "ALL RUNNING $want" || echo "MISMATCH — processes keep serving old code until restarted"
exit $bad
