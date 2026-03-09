---
description: {{description}}
argument-hint: <path/to/plan.md>
---

# Feature Verification Phase

**You are the spec-verify skill. Verify the implementation meets the plan's requirements.**

ARGUMENTS: $ARGUMENTS

## Phase 1: Launch Spec Reviewer (Background)

Launch the `spec-reviewer` sub-agent with the plan file path. It will write findings to a JSON file.

## Phase 2: Automated Checks

Run these checks in sequence:

1. **All tests pass:**
   - Auto-detect test runner and run full suite
   - Expected: 0 failures

2. **TypeScript compiles:**
   - `npx tsc --noEmit`
   - Expected: 0 errors

3. **Linting passes:**
   - `npx eslint .`
   - Expected: 0 errors

4. **Angular build (if applicable):**
   - `npx ng build`
   - Expected: Build succeeds

5. **NestJS build (if applicable):**
   - `npx nest build`
   - Expected: Build succeeds

## Phase 3: E2E Verification (if UI changes)

Use Playwright to verify the feature works in the running app:

1. Start the dev server
2. Navigate to the relevant page
3. Interact with the new feature
4. Verify expected UI state
5. Close the browser

## Phase 4: Process Findings

1. Read the spec-reviewer JSON findings
2. Fix all `must_fix` and `should_fix` items
3. Implement `suggestion` items if quick
4. If fixes were needed: set plan `Status: PENDING`, re-run implementation
5. If no fixes needed: set plan `Status: VERIFIED`

## Phase 5: Worktree Sync (if applicable)

If `Worktree: Yes` in the plan:
1. Ask user for approval to merge
2. Squash merge the worktree branch into the main branch
3. Clean up the worktree
