#!/usr/bin/env bash
# Stage, verify standalone, and commit a list of logical commit groups.
# Usage (from the repo root, DETACHED — a full run outlives any tool call):
#   (nohup caffeinate -ims .sentinal/skills/sentinal-logical-commits/scripts/drive-commits.sh <dir> </dev/null >/dev/null 2>&1 &)
# <dir> holds:
#   groups.txt   lines `NN|path path …` in dependency order
#   msg/NN       the commit message for group NN (first line = subject)
#   blobs/NN     optional lines `repo/path|/abs/content-file` staged as blobs
#                (a file whose intermediate content differs from the worktree)
# Progress goes to <dir>/drive.log: `=== NN`, verify output, `COMMITTED NN <sha>`,
# `STOP at NN` on the first red, `ALL DONE` at the end. Re-running skips groups
# whose subject is already in the last 30 commits.
set -uo pipefail
D=${1:?usage: drive-commits.sh <dir>}
S="$(git rev-parse --show-toplevel)/.sentinal/skills/sentinal-logical-commits/scripts"
LOG="$D/drive.log"
while IFS='|' read -r n files; do
  [ -z "$n" ] && continue
  if git log --format=%s -30 | grep -qxF "$(head -1 "$D/msg/$n")"; then echo "skip $n" >>"$LOG"; continue; fi
  git reset -q
  for f in $files; do
    if [ -e "$f" ]; then git add -- "$f"; else git rm -q --cached -- "$f"; fi
  done
  if [ -f "$D/blobs/$n" ]; then
    while IFS='|' read -r path content; do
      [ -n "$path" ] && "$S/stage-blob.sh" "$path" "$content" >>"$LOG"
    done <"$D/blobs/$n"
  fi
  echo "=== $n $(date +%T) $(git diff --cached --name-only | wc -l | tr -d ' ') files" >>"$LOG"
  if "$S/verify-index.sh" >>"$LOG" 2>&1; then
    git commit -q -F "$D/msg/$n" && echo "COMMITTED $n $(git rev-parse --short HEAD)" >>"$LOG"
  else
    echo "STOP at $n" >>"$LOG"; exit 1
  fi
done <"$D/groups.txt"
echo "ALL DONE" >>"$LOG"
