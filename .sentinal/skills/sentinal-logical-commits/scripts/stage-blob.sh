#!/usr/bin/env bash
# Stage arbitrary content as <path> in the git INDEX only. The working tree is
# never touched, so it keeps holding the fully verified final state.
# Usage: stage-blob.sh <repo-relative-path> <file-with-intended-content>
set -euo pipefail
[ $# -eq 2 ] || { echo "usage: $0 <path> <content-file>" >&2; exit 2; }
sha=$(git hash-object -w -- "$2")
git update-index --add --cacheinfo "100644,$sha,$1"
echo "staged $1 <- $2 ($(wc -l < "$2" | tr -d ' ') lines, blob ${sha:0:10})"
