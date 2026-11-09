# Relative related.json / Repo: Paths Break in Linked Worktrees Fix Plan

Created: 2026-11-09
Status: IN_PROGRESS
Approved: Yes
Iterations: 0
Worktree: No
Type: Bugfix

## Summary

**Symptom:** In a linked worktree of a repo whose `.sentinal/related.json` lists siblings by
relative path (e.g. `server-ops/.orca/worktrees/<name>` with `"../deployr-stack"`), every related
project reports `exists: false`: no `scope:"related"` search, no restore index entries, no
foreign-rules lookup by name. A master plan's relative `Repo: ../api` seed has the same problem
in `spec_master_audit` (Phase 3 deferred issue).
**Trigger:** Any session/audit whose checkout is a linked worktree not located next to the main
checkout (Orca's in-repo `workspaceDir: .orca/worktrees`, Sentinal's `.sentinal/worktrees/spec-*`).
**Root Cause:** `src/project/related.ts:150-151` resolves a relative `path` against the
**workspace** (the local checkout) — `resolve(workspace, entry.path)`. Siblings live next to the
repo's **main checkout**, so from a linked worktree the path points inside the repo.
`src/spec/master-audit-foreign.ts:78` (`resolveSeedRepo`) falls back to
`resolve(masterWorkspace, repo)` with the same mistake.

## Investigation

- Live: server-ops main checkout resolves all six entries; its `.sentinal/.gitignore` comment
  written by `/sync` already says "paths relative to the MAIN checkout, not .orca worktrees" —
  the documented intent the loader does not follow.
- The main checkout is what `resolveProjectIdentity` returns (`git worktree list` first entry),
  so it is the same from every worktree.
- Fast path: when `<workspace>/.git` is a **directory**, the workspace is the main checkout (no
  git spawn needed). Only a `.git` **file** (linked worktree / submodule) needs the git lookup.
- The audit deliberately avoids git spawns (`identity: (p) => p`); one spawn in the
  linked-worktree case only is acceptable there.
- Callers: `src/memory/restore.ts:175`, `src/memory/mcp-tools.ts:180`,
  `src/spec/master-audit-foreign.ts:75`.

## Behavior Contract

### Fix Property (C => P)

**When** the declaring checkout is a linked worktree, **a relative `related.json` path or
relative `Repo:` resolves against the repo's main checkout**, so `../sibling` finds the sibling.

### Preservation Property (!C => unchanged)

From the main checkout (`.git` directory) and for absolute paths, results are identical and no
git process is spawned beyond today's identity calls. `related.json` is still **read** from the
local workspace.

## Fix Approach

**Files:** `src/project/related.ts` (+ test), `src/spec/master-audit-foreign.ts` (+ test),
`targets/*` prose only if it states the old base (check `sync.md`, master-plan skills), README
`related.json` paragraph, `.sentinal/rules/sentinal-project.md` (one line), Phase 3 plan's
Deferred Issues (mark the `Repo:` item resolved).
**Strategy:** add `relativeBase(workspace, deps)` in `related.ts`: `.git` directory → workspace;
otherwise `deps.mainCheckout?.(workspace) ?? resolveProjectIdentity(workspace)` (never throws;
falls back to the workspace). Use it for relative entries. Export it and use it in
`resolveSeedRepo`'s relative fallback (the `related.json` name lookup already benefits).
**Tests:** real temp repos with `git worktree add` into `<main>/.orca/worktrees/x`; sibling repo
next to main. Loader from the worktree finds the sibling (`exists: true`); from main unchanged;
absolute unchanged; spawn spy shows no main-checkout lookup when `.git` is a directory.
`resolveSeedRepo("../api", <worktree>)` → the sibling.

## Progress

- [x] Task 1: Fix
- [x] Task 2: Verify

**Tasks:** 2 | **Done:** 2 | **Left:** 0

## Tasks

### Task 1: Fix

**Objective:** Regression tests (linked worktree) → FAIL → resolve against main checkout → PASS.
**Verify:** `bun test src/project/related.test.ts src/spec/master-audit-foreign.test.ts`

### Task 2: Verify

**Verify:** `bun test && bun run typecheck && bun run typecheck:plugin && bun run lint && bun run format:check`

## Verification Notes

- `bun test` 4815 pass / 0 fail; typecheck, plugin typecheck, lint, format:check clean; parity
  baselines unchanged (identical `sync.md` edit in both targets).
- Live: a throwaway linked worktree of `server-ops` (removed afterwards) resolves all six
  `related.json` entries (`exists: true`, rules for deployr-stack and baseplate).
