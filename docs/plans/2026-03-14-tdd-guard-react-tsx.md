# TDD Guard React/TSX Support Fix Plan

Created: 2026-03-14
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Bugfix

## Summary
**Symptom:** The TDD Guard blocks `.tsx` test files (e.g., `Button.test.tsx`) as if they were implementation files, and never generates companion test paths for `.tsx` implementations (e.g., `Button.tsx`). The full TDD cycle is broken for React components.
**Trigger:** Any edit to a `.tsx` file — whether test or implementation — during an active spec.
**Root Cause:** `src/utils/tdd.ts` has two bugs:
1. `isTestFile()` (line 1) — `TEST_FILE_PATTERNS` only includes `.spec.ts`, `.test.ts`, `.spec.js`, `.test.js`. Missing: `.spec.tsx`, `.test.tsx`, `.spec.jsx`, `.test.jsx`. So `Button.test.tsx` is not recognized as a test file.
2. `getExpectedTestPaths()` (line 26) — only accepts files ending in `.ts` or `.js`. Since `"Button.tsx".endsWith(".ts")` is `false`, `.tsx` files return `[]` — no companion test paths generated.

## Investigation
- `tdd-guard.ts:57` correctly gates on `/\.(ts|tsx)$/` — `.tsx` files ARE subject to the guard. But `isTestFile()` at line 51 fails to exempt `.test.tsx` files, so they get blocked.
- `tdd-tracker.ts:73` calls `isTestFile()` to detect test writes → `TEST_WRITTEN` state. Since `.test.tsx` returns `false`, writing a React test file never transitions the TDD state. The guard stays at `IDLE` forever.
- `tdd-tracker.ts:47` (`getImplPathForTest`) already handles `.tsx`/`.jsx` correctly — asymmetry with the forward direction.
- `file-checker.ts:34-38` calls `getExpectedTestPaths()` — never warns about missing tests for `.tsx` files.
- OpenCode plugin `sentinal.ts:141,173` reuses `isTestFile()` from the same module — same bugs apply.
- Existing test at `tdd-guard.test.ts:88` asserts `.test.tsx` passes through, but for the wrong reason (no active spec in default DB, not because it's recognized as a test file).

## Behavior Contract

### Fix Property (C => P)
**When condition C holds:** A `.tsx`/`.jsx` file is processed by the TDD guard, tracker, or file-checker.
**Property P must hold:** `.test.tsx`/`.spec.tsx`/`.test.jsx`/`.spec.jsx` files are recognized as test files. `getExpectedTestPaths("foo.tsx")` returns `["foo.spec.tsx", "foo.test.tsx"]`. TDD state transitions work for React test files.

### Preservation Property (!C => unchanged)
**When condition C does NOT hold:** A `.ts`/`.js` file is processed.
**Existing behavior preserved:** All existing `.ts`/`.js` test detection, path generation, and TDD cycling works identically.

## Fix Approach
**Files:** `src/utils/tdd.ts` (root cause — both bugs)
**Strategy:**
1. Add `.tsx`/`.jsx` patterns to `TEST_FILE_PATTERNS`: `/\.spec\.tsx$/`, `/\.test\.tsx$/`, `/\.spec\.jsx$/`, `/\.test\.jsx$/`
2. Extend `getExpectedTestPaths()` to handle `.tsx` and `.jsx` extensions (same algorithm, additional extension check)
**Tests:** `src/utils/tdd.test.ts` — add test cases for `.tsx`/`.jsx` in `isTestFile()` and `getExpectedTestPaths()`

## Progress
- [x] Task 1: Fix
- [x] Task 2: Verify
**Tasks:** 2 | **Done:** 2 | **Left:** 0

## Tasks

### Task 1: Fix
**Objective:** Write regression tests for `.tsx`/`.jsx` → verify FAIL → implement fix → verify PASS
**Files:**
- Modify: `src/utils/tdd.ts`
- Modify: `src/utils/tdd.test.ts`
**TDD:** Write tests for `isTestFile("foo.test.tsx")`, `getExpectedTestPaths("foo.tsx")`, etc. → verify FAILS → fix `TEST_FILE_PATTERNS` and `getExpectedTestPaths()` → verify all PASS
**Verify:** `bun test src/utils/tdd.test.ts`

### Task 2: Verify
**Objective:** Full suite + quality checks + rebuild embedded assets
**Verify:** `bun run build:cli && bun test && npx tsc --noEmit`
