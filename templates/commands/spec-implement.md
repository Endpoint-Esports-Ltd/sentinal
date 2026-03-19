---
description: { { description } }
argument-hint: <path/to/plan.md>
---

# Implementation Phase

**You are the spec-implement skill. Execute each task in the plan using strict TDD.**

> **Model:** Sonnet recommended for implementation phases. Switch with /model if needed.

> **TDD Enforcement Active:** Sentinal hooks enforce RED-GREEN-REFACTOR automatically.
> Editing an implementation file without a confirmed failing test will be **blocked**.
> You MUST write a test, run it to confirm it FAILS, then edit the implementation.

ARGUMENTS: $ARGUMENTS

## Setup

1. Read the plan file from ARGUMENTS
2. Verify `Status: PENDING` and `Approved: Yes`
3. Create tasks from the plan using TaskCreate
4. **Parse Execution Waves:** Read `## Execution Waves` section. If present, group tasks by wave. If absent, fall back to sequential execution (legacy path).
5. Start with Wave 1 (or the first uncompleted task if no waves)

## Wave Execution

If the plan has `## Execution Waves`:

- **Single-task wave:** Execute in main context using the TDD Loop below
- **Multi-task wave:** Spawn parallel subagents (one per task, all in single message). Each subagent follows TDD independently. Wait for all to complete before proceeding to next wave.
- **After each wave:** Update plan checkboxes for all completed tasks. Parallel subagents must NOT update checkboxes themselves.
- **If no waves section:** Execute all tasks sequentially using the TDD Loop below

## TDD Loop (per task)

### 1. RED — Write Failing Test

- Write the minimal test that captures the desired behavior
- For Angular: use `TestBed`, component harness, or Playwright
- For NestJS: use `@nestjs/testing`, mock repositories
- **Naming:** `describe("ComponentName", () => { it("should behavior when condition") })`

### 2. VERIFY RED

Run the test and confirm it FAILS because the feature doesn't exist:

- Jest: `npx jest --testPathPattern=<test-file> --verbose`
- Vitest: `npx vitest run <test-file>`
- Angular: `npx ng test --include=<test-file> --watch=false`
- Bun: `bun test <test-file>`

Expected: FAIL with meaningful error (not syntax error)

### 3. GREEN — Write Minimal Implementation

- Write the simplest code that passes the test
- Follow the coding standards rules (they'll be enforced by hooks automatically)
- No extras, no refactoring — just make it pass

### 4. VERIFY GREEN

Run ALL tests, not just the new one. Expected: ALL tests PASS

### 5. REFACTOR (if needed)

- Clean up code while keeping tests green
- Extract shared logic, improve naming, remove duplication
- Run tests again to confirm still green

### 6. Update Plan

After each task completes:

- Update plan file: `[ ]` → `[x]`
- Increment Done count, decrement Left count
- Mark task as completed via TaskUpdate

## Completion

After all tasks complete:

- Update plan `Status:` to `COMPLETE`
- The dispatcher will route to the appropriate verification skill
