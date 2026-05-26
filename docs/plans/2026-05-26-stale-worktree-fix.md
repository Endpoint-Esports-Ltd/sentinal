# Stale Worktree Persistence Fix Plan

Created: 2026-05-26
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Bugfix

## Summary

**Symptom:** Worktree entries persist in Sentinal's MCP tools (e.g., `worktree_detect`) even after the worktree has been deleted from Git or via the `sentinal_worktree_delete` MCP tool (which doesn't exist).

**Trigger:** Deleting a worktree externally (via `git worktree remove`, `rm -rf`, or expecting an MCP delete tool), then querying worktree status through MCP. The SQLite `worktrees` table retains the row with `status = 'active'`.

**Root Cause:** The worktree MCP tool surface is incomplete — there are only 4 tools (`detect`, `create`, `diff`, `sync`) but no `abandon` or `cleanup` tool. Additionally, `worktree_detect` (`src/worktree/mcp-tools.ts:70-72`) trusts SQLite state without verifying that the worktree directory still exists on disk. When worktrees are deleted externally, the SQLite row stays `active` and `resolveBySlug()` returns it.

## Investigation

- `WorktreeStore.resolveBySlug()` (`src/worktree/store.ts:158-184`) queries SQLite with `status IN ('active', 'ready-to-merge')` — never checks disk
- `WorktreeManager.abandon()` (`src/worktree/manager.ts:253`) and `cleanup()` (`src/worktree/manager.ts:288`) exist but are only exposed via CLI commands, not MCP tools or sidecar routes
- `WorktreeStore.delete()` (`src/worktree/store.ts:125`) exists but is never called by any business logic
- The sidecar has only one worktree route: `GET /worktree/resolve` (`src/sidecar/routes.ts:109-110`)
- `routes.ts` is already at 400 lines (warn threshold) — new routes need a separate `worktree-routes.ts` file
- Existing pattern: domain-specific routes in `*-routes.ts` files (`quality-routes.ts`, `tdd-routes.ts`, etc.)
- No in-memory caching — all queries hit SQLite directly, so the fix is about data consistency, not cache invalidation

## Behavior Contract

### Fix Property (C => P)

**When condition C holds:** A worktree's directory no longer exists on disk (deleted externally or via abandon)
**Property P must hold:** `worktree_detect` reports "not found" (or auto-cleans the stale entry); `worktree_abandon` MCP tool allows explicit deletion; `worktree_cleanup` removes all stale entries

### Preservation Property (!C => unchanged)

**When condition C does NOT hold:** Worktree directory exists on disk and is active
**Existing behavior preserved:** `worktree_detect` returns the worktree info exactly as before; `worktree_create`, `worktree_diff`, `worktree_sync` unchanged

## Fix Approach

**Files:** 6 files to modify/create

| File                                  | Action                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `src/worktree/mcp-tools.ts`           | Add `worktree_abandon` and `worktree_cleanup` tools                       |
| `src/worktree/mcp-tools.test.ts`      | Tests for new tools + stale detection behavior                            |
| `src/sidecar/worktree-routes.ts`      | **New** — sidecar routes for abandon/cleanup                              |
| `src/sidecar/worktree-routes.test.ts` | **New** — tests for worktree sidecar routes                               |
| `src/sidecar/server.ts`               | Wire `handleWorktreeRequest` into the fetch chain                         |
| `src/sidecar/client.ts`               | Add `abandonWorktree()` and `cleanupWorktrees()` client methods           |
| `src/sidecar/routes.ts`               | Move `handleResolveWorktree` to `worktree-routes.ts`, replace with import |

**Strategy:**

1. **Add `worktree_abandon` MCP tool** — delegates to `manager.abandon(worktreeId)` via sidecar. Accepts worktree ID (from `worktree_detect` output). Resolves by slug first if only slug is provided.
2. **Add `worktree_cleanup` MCP tool** — delegates to `manager.cleanup()` via sidecar. Returns count of cleaned entries.
3. **Enhance `worktree_detect` with on-disk verification** — after resolving from SQLite, check `existsSync(wt.worktreePath)`. If missing, auto-run cleanup for that entry and return "not found" (self-healing detect).
4. **Create sidecar routes** — `POST /worktree/abandon`, `POST /worktree/cleanup` in new `worktree-routes.ts`. Move existing `GET /worktree/resolve` there too (reduces `routes.ts` line count).
5. **Add client methods** — `abandonWorktree(id)` and `cleanupWorktrees(projectPath)` on `SidecarClient`.

**Tests:** `src/worktree/mcp-tools.test.ts`, `src/sidecar/worktree-routes.test.ts`

## Progress

- [x] Task 1: Write tests for new MCP tools and sidecar routes
- [x] Task 2: Implement fix — add abandon/cleanup MCP tools, sidecar routes, self-healing detect
- [x] Task 3: Verify — full test suite + quality checks
      **Tasks:** 3 | **Done:** 3 | **Left:** 0

## Tasks

### Task 1: Write Tests

**Objective:** Write regression tests for the stale worktree bug and tests for new MCP tools/sidecar routes
**Files:**

- `src/worktree/mcp-tools.test.ts` — add tests for `worktree_abandon`, `worktree_cleanup`, and stale `worktree_detect` self-healing
- `src/sidecar/worktree-routes.test.ts` — new file for sidecar abandon/cleanup route tests
  **TDD:** Write failing tests first, verify they fail
  **Verify:** `bun test src/worktree/mcp-tools.test.ts src/sidecar/worktree-routes.test.ts`

### Task 2: Implement Fix

**Objective:** Add abandon/cleanup MCP tools, sidecar routes, self-healing detect
**Files:**

- `src/sidecar/worktree-routes.ts` — new: `handleWorktreeRequest` with `/worktree/resolve`, `/worktree/abandon`, `/worktree/cleanup`
- `src/sidecar/server.ts` — wire `handleWorktreeRequest` into fetch chain
- `src/sidecar/client.ts` — add `abandonWorktree()`, `cleanupWorktrees()` methods
- `src/sidecar/routes.ts` — remove `handleResolveWorktree` (moved to worktree-routes.ts), remove `/worktree/resolve` dispatch
- `src/worktree/mcp-tools.ts` — add `registerWorktreeAbandonTool`, `registerWorktreeCleanupTool`; enhance detect with disk check + self-healing
  **TDD:** Implement until all tests from Task 1 pass
  **Verify:** `bun test src/worktree/ src/sidecar/worktree-routes.test.ts`

### Task 3: Verify

**Objective:** Full test suite + quality checks
**Verify:** `bun test && bun run build:all`
