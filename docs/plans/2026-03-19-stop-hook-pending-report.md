# Stop Hook Blocks on PENDING Plans Fix Plan

Created: 2026-03-19
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Bugfix

## Summary

**Symptom:** The stop hook fires "Active spec plan is PENDING (awaiting implementation)" and blocks session exit, even when the user just VERIFIED a different plan.
**Trigger:** Any plan in `docs/plans/` with status PENDING causes the stop hook to block session exit.
**Root Cause:** `src/spec/detect.ts:68` — `shouldBlockStop("PENDING")` blocks on PENDING status. PENDING plans are not actively being worked on — only IN_PROGRESS and COMPLETE plans represent active work. The active plan lifecycle is: PENDING → IN_PROGRESS (implementation starts) → COMPLETE → VERIFIED. The stop guard should only block during IN_PROGRESS and COMPLETE.

## Investigation

- `findActivePlan()` at `src/spec/detect.ts:26` scans `docs/plans/` reverse-alphabetically, returns the first plan in `ACTIVE_STATUSES`
- `shouldBlockStop()` at `src/spec/detect.ts:66` blocks on PENDING and COMPLETE, allows IN_PROGRESS and VERIFIED
- PENDING plans have not started implementation — blocking exit for them is wrong
- IN_PROGRESS = actively being implemented (always has Approved: Yes)
- COMPLETE = implemented, awaiting verification
- Both IN_PROGRESS and COMPLETE represent interrupted work that should block exit

## Behavior Contract

### Fix Property (C => P)

**When condition C holds:** A plan has status PENDING
**Property P must hold:** The stop hook does NOT block session exit

### Preservation Property (!C => unchanged)

**When condition C does NOT hold:** A plan has status IN_PROGRESS or COMPLETE
**Existing behavior preserved:** The stop hook blocks session exit as before

## Fix Approach

**Files:** `src/spec/detect.ts`
**Strategy:** Remove the PENDING case from `shouldBlockStop()`. Add IN_PROGRESS as a blocking status (it's currently allowed through — this is also a bug since actively implementing plans should block exit). Keep COMPLETE as blocking.
**Tests:** `src/hooks/spec-stop-guard.test.ts`

## Progress

- [x] Task 1: Fix shouldBlockStop to remove PENDING and add IN_PROGRESS
- [x] Task 2: Verify
      **Tasks:** 2 | **Done:** 2 | **Left:** 0

## Tasks

### Task 1: Fix shouldBlockStop

**Objective:** Remove PENDING from blocking statuses, add IN_PROGRESS as blocking. Update tests.
**Files:**

- Modify: `src/spec/detect.ts:66-73` — remove PENDING case, add IN_PROGRESS case
- Modify: `src/hooks/spec-stop-guard.test.ts` — update expectations
  **TDD:** Write test for PENDING → not blocked, IN_PROGRESS → blocked → verify FAILS → fix → verify PASS
  **Verify:** `bun test src/hooks/spec-stop-guard.test.ts`

### Task 2: Verify

**Objective:** Full suite + quality checks
**Verify:** `bun test && npx tsc --noEmit`
