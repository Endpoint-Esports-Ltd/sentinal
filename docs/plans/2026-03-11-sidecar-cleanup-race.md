# Orphaned Sidecar Cleanup Race Fix

Created: 2026-03-11
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Bugfix

## Summary
**Symptom:** When an orphaned sidecar process receives SIGTERM, it deletes the *current* sidecar's PID/port/socket files, breaking MCP connectivity for the active sidecar.

**Trigger:** A newer sidecar replaces an orphan (writes its own PID/port/socket files). The orphan then receives SIGTERM (from `stopSidecarProcess()` or manual kill), and its shutdown handler calls `stopSidecar()` which unconditionally deletes all artifact files — including the ones the new sidecar just wrote.

**Root Cause:** `stopSidecar()` in `src/sidecar/server.ts:114-116` and `cleanupSidecarFiles()` in `src/sidecar/lifecycle.ts:149-154` unconditionally delete all sidecar artifact files without checking whether the PID file still refers to the dying process.

## Investigation
- **Two cleanup paths exist:** `stopSidecar()` (called by the sidecar's own SIGTERM handler in `sidecar.ts:70-73`) and `stopSidecarProcess()` → `cleanupSidecarFiles()` (called externally by session-end handlers, CLI stop command).
- Both paths delete PID/socket/port files unconditionally — neither reads the PID file to verify ownership.
- The PID file is written by the CLI start command (`sidecar.ts:61`) with `process.pid`. A newer sidecar overwrites this with its own PID.
- After the orphan's cleanup runs, the active sidecar keeps running but has no PID file (invisible to `isSidecarRunning()`), no port file (unreachable by HTTP clients like OpenCode's Node.js runtime), and potentially no socket file.
- The orphan-creation race itself is already fixed — `startSidecar()` probes the Unix socket before replacing it. But orphans from before the fix (or edge cases) can still trigger this.
- Dashboard lifecycle (`src/dashboard/lifecycle.ts`) has the same unconditional cleanup pattern but doesn't suffer because it only manages one PID file.

## Behavior Contract

### Fix Property (C => P)
**When condition C holds:** A sidecar process receives SIGTERM and its PID does NOT match the PID currently in `sidecar.pid`
**Property P must hold:** The process shuts down its own server and store but does NOT delete any artifact files (PID, socket, port)

### Preservation Property (!C => unchanged)
**When condition C does NOT hold:** A sidecar process receives SIGTERM and its PID DOES match the PID in `sidecar.pid` (or no PID file exists)
**Existing behavior preserved:** The process shuts down and deletes all artifact files as before

## Fix Approach
**Files:** `src/sidecar/server.ts`, `src/sidecar/lifecycle.ts`
**Strategy:**
1. **`stopSidecar()` (server.ts:114-116):** Before deleting artifact files, read `sidecar.pid`. Only delete if the PID matches `process.pid`. If the PID file is missing or contains a different PID, skip file cleanup (another sidecar owns them).
2. **`cleanupSidecarFiles()` (lifecycle.ts:149-154):** Add optional `expectedPid?: number` parameter. When provided, read the PID file first and skip ALL cleanup if the PID doesn't match. When not provided, keep existing unconditional behavior (used by `isSidecarRunning()` for stale cleanup).
3. **`stopSidecarProcess()` (lifecycle.ts:125-142):** Pass the `pid` variable it already has to `cleanupSidecarFiles(pid)`.

**Tests:** `src/sidecar/server.test.ts`, `src/sidecar/lifecycle.test.ts`

## Progress
- [x] Task 1: Fix with regression test
- [x] Task 2: Verify
**Tasks:** 2 | **Done:** 2 | **Left:** 0

## Tasks

### Task 1: Fix with regression test
**Objective:** Write regression test demonstrating the race, then implement PID-guarded cleanup
**Files:** `src/sidecar/server.ts`, `src/sidecar/lifecycle.ts`, `src/sidecar/server.test.ts`, `src/sidecar/lifecycle.test.ts`
**TDD:**
1. Write regression test: start sidecar, overwrite PID file with a different PID (simulating a newer sidecar), call `stopSidecar()`, assert the PID/port files still exist with the newer PID's content.
2. Verify test FAILS (current code unconditionally deletes).
3. Implement fix: PID-guarded cleanup in `stopSidecar()` and `cleanupSidecarFiles()`.
4. Verify test PASSES along with all existing tests.
**Verify:** `bun test src/sidecar/`

### Task 2: Verify
**Objective:** Full test suite + type checking
**Verify:** `bun test && npx tsc --noEmit`
