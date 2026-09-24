---
name: sentinal-logical-commits
description: |
  Splitting a large, fully-verified working tree into several logical commits
  that EACH pass tsc, the plugin type-check and the full suite on their own.
  Use when: (1) the user asks to "commit as logical commits" after a multi-task
  /spec, (2) one file carries changes belonging to two or more commits,
  (3) `git apply --cached --unidiff-zero` staged a hunk at the END of a file or
  a staged file suddenly has a syntax error (e.g. TS1109) the worktree doesn't,
  (4) a commit verifies green in the worktree but you need proof it is green
  alone, (5) an exported-index check fails with TS2307 on embedded-assets.js or
  findGitRoot/isInsideGitRepo tests fail only in the export.
author: Claude Code
version: 1.0.0
---

# Logical Commits, Each Verified Standalone

## When to Use

The final tree is already verified (suite, tsc, smoke). You now want history
where every commit builds and passes by itself, without disturbing that tree.

## Solution

### 1. The working tree never changes

Stage into the **index only**. The worktree keeps the verified final state for
the whole process; if it is clean at the end, `HEAD` is byte-identical to what
you verified. Never `git add -p` (interactive) and never edit files to build an
intermediate version.

### 2. Map every changed file to exactly one commit

Write `NN|file file …` lines in dependency order (a commit may only use code
from earlier ones), then prove coverage:

```bash
cut -d'|' -f2 groups.txt | tr ' ' '\n' | sed '/^$/d' | sort > assigned
git status --porcelain | cut -c4- | sort > changed
uniq -d assigned                     # assigned twice   → must be empty
comm -13 assigned changed            # unassigned       → must be empty
comm -23 <(sort -u assigned) changed # assigned, unchanged → must be empty
```

### 3. A file that spans commits → stage a constructed blob

Build the intermediate content (final file minus the later commits' regions)
into a temp file, asserting each cut matches exactly once, then:

```bash
.sentinal/skills/sentinal-logical-commits/scripts/stage-blob.sh <path> <content-file>
```

⛔ **Do not select hunks with `git apply --cached --unidiff-zero`** when a kept
**pure-addition** hunk follows a skipped one. A zero-context addition has
nothing to anchor to and was placed at **end of file** (`store-sessions.ts` →
TS1109 in the export only). Hunks that contain `-` lines are content-anchored
and safe; blobs are always safe — default to blobs.

Cross-check: intermediate line counts should match what the implementing tasks
reported at that stage — an independent correctness signal.

### 4. Verify the index, then commit

```bash
.sentinal/skills/sentinal-logical-commits/scripts/verify-index.sh   # full suite
```

It exports the index (`git checkout-index`), symlinks `node_modules`, then:

- `git init` + `add` in the export — git-dependent tests fail without a repo;
- `bun run embed-assets` (the **package script**, which builds the plugin first —
  raw `scripts/embed-assets.mjs` leaves `embedded-assets.js` missing → TS2307);
- `tsc` on `src/`, a separate plugin-graph `tsc` (root tsconfig excludes `targets/`),
  and `bun test`. Exit 0 only if all pass.

A full run is ~4.5 min — longer than a tool call's timeout — so drive all
commits from a `nohup` script that stops at the first red and polls a log.
Commit only after a green verify; never commit then check.

### 5. Finish

`git status --short` must be empty. Fast-forward `main`, re-run the gates on
`main`, then push.

## Verification

- `verify-index.sh` exit 0 for every commit (log each summary line).
- Worktree clean after the last commit.
- Proven: staging a regression only in the index makes `verify-index.sh` fail
  while the worktree is green.

## When NOT to Use

- A single-purpose change — one commit, just verify the worktree.
- The tree isn't verified yet — finish verification first; this only reshapes
  history of a known-good tree.
- Rewriting already-pushed history.

## Example

v1.39.0: 50 changed files → 11 commits, each verified standalone
(3485 → 3721 pass). v1.38.0: 7 files split across commits via blobs; three blob
line counts matched the tasks' reported sizes exactly.

## References

- `scripts/stage-blob.sh`, `scripts/verify-index.sh`
- Memory #1561 (technique), #1676
