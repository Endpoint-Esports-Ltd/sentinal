---
description: Bugfix verification phase - Behavior Contract audit, tests, process compliance
argument-hint: "<path/to/plan.md>"
user-invocable: false
model: sonnet
---

# Bugfix Verification Phase

**You are the spec-bugfix-verify skill. Verify the bugfix satisfies the Behavior Contract.**

ARGUMENTS: $ARGUMENTS

## Phase 1: Behavior Contract Audit

Read the plan file and verify:

1. **Fix Property (C => P):** Is there a test that proves the fix works?
   - Run the specific test — must PASS
   - The test must cover the exact condition C and verify property P

2. **Preservation Property (!C => unchanged):** Is there a test that proves existing behavior is preserved?
   - Run the specific test — must PASS
   - The test must cover the negation of condition C

## Phase 2: Full Test Suite

Run the complete test suite:
- All tests pass (0 failures)
- No regressions introduced

## Phase 3: Process Compliance

Verify:
- Root cause was traced (not just symptom patched)
- Fix is at the source, not where the error appeared
- Minimal code change (no scope creep)
- Tests match the Behavior Contract exactly

## Phase 4: Decision

- **All checks pass:** Set plan `Status: VERIFIED`
- **Issues found:** Set plan `Status: PENDING`, fix the issues, return to implementation

## Phase 5: Worktree Sync (if applicable)

Same as feature verification — ask for merge approval if in worktree mode.
