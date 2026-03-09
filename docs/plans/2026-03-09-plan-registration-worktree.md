# Plan Registration + Worktree Commands

Created: 2026-03-09
Status: COMPLETE
Approved: Yes
Iterations: 1
Worktree: No
Type: Feature

## Summary

**Goal:** Implement plan registration (associating spec/plan files with sessions) and full git worktree lifecycle management, enabling isolated branch development per spec.

**Architecture:** Reuse the existing `specs` table (add `session_id` column) rather than creating a separate `plans` table. Create `worktrees` table for tracking worktree state. All worktree operations shell out to `git worktree` commands via `Bun.spawnSync`. Extract migrations from `MemoryStore` into a dedicated module to make room within the 600-line limit.

**Parent Task:** Task 5 from `docs/plans/2026-03-09-market research-parity.md`

**Deferred:** `sentinal notify` command and `notifications` table deferred to Tasks 8/9 (dashboard), since there is no consumer until the dashboard exists.

## Progress Tracking

- [x] Task 1: Extract migrations + raw row types from MemoryStore
- [x] Task 2: Schema migration V5 — session_id on specs + worktrees table
- [x] Task 3: Git utilities + worktree types
- [x] Task 4: WorktreeStore — SQLite persistence
- [x] Task 5: WorktreeManager — full lifecycle
- [x] Task 6: Register-plan CLI command
- [x] Task 7: Worktree CLI commands
- [x] Task 8: Barrel exports, integration, parent plan update

## Implementation Tasks

### Task 1: Extract Migrations + Raw Row Types from MemoryStore

**Objective:** Move migration functions and raw DB row types out of `src/memory/store.ts` to bring it well under the 600-line limit.

**Files:**
- Create: `src/memory/migrations.ts`
- Create: `src/memory/migrations.test.ts`
- Modify: `src/memory/store.ts`
- Modify: `src/memory/types.ts`

### Task 2: Schema Migration V5

**Objective:** Add `session_id` + `metadata` columns to specs table, create worktrees table.

**Files:**
- Modify: `src/memory/migrations.ts`
- Modify: `src/memory/types.ts`
- Modify: `src/spec/store.ts`
- Modify: `src/spec/types.ts`
- Modify: `src/spec/store.test.ts`

### Task 3: Git Utilities + Worktree Types

**Objective:** Create git helper functions and TypeScript type definitions.

**Files:**
- Create: `src/git/types.ts`
- Create: `src/git/utils.ts`
- Create: `src/git/utils.test.ts`

### Task 4: WorktreeStore — SQLite Persistence

**Objective:** CRUD for worktrees table.

**Files:**
- Create: `src/git/worktree-store.ts`
- Create: `src/git/worktree-store.test.ts`

### Task 5: WorktreeManager — Full Lifecycle

**Objective:** Core business logic for worktree create, merge, abandon, cleanup.

**Files:**
- Create: `src/git/worktree-manager.ts`
- Create: `src/git/worktree-manager.test.ts`

### Task 6: Register-Plan CLI Command

**Objective:** `sentinal register-plan` command.

**Files:**
- Create: `src/cli/commands/register-plan.ts`
- Modify: `src/cli/index.ts`

### Task 7: Worktree CLI Commands

**Objective:** `sentinal worktree` command group with 6 subcommands.

**Files:**
- Create: `src/cli/commands/worktree.ts`
- Modify: `src/cli/index.ts`

### Task 8: Barrel Exports + Integration

**Objective:** Wire everything together, verify tests, update parent plan.

**Files:**
- Modify: `src/index.ts`
- Modify: `src/cli/index.ts`
- Modify: `src/memory/config.ts`
- Modify: `docs/plans/2026-03-09-market research-parity.md`
