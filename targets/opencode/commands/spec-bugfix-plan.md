---
description: Bugfix planning phase - analyze bug, design fix, get approval
argument-hint: <bug description> or <path/to/plan.md>
---

# Bugfix Planning Phase

**You are the spec-bugfix-plan skill. Your job: trace the bug to its root cause, create a Behavior Contract, and get user approval.**

ARGUMENTS: $ARGUMENTS

## Phase 1: Bug Analysis

1. Parse ARGUMENTS — bug description or existing plan path
2. **Reproduce:** Find the exact code path that triggers the bug
3. **Trace:** Follow the call chain from symptom to root cause
4. **Identify:** The exact file:line where the fix should be applied

## Phase 2: Behavior Contract

Define the contract that proves the fix works:

- **Fix Property (C => P):** When condition C holds, property P must be true
  - Example: "When user submits empty form, validation error is shown"
- **Preservation Property (!C => unchanged):** When condition C does NOT hold, existing behavior is unchanged
  - Example: "When user submits valid form, submission succeeds as before"

## Phase 3: Write the Plan

Create plan file at `docs/plans/YYYY-MM-DD-bugfix-<slug>.md`:

```markdown
# Bugfix: [Bug Description]

**Status:** PENDING
**Type:** Bugfix
**Approved:** No
**Worktree:** [Yes/No]
**Date:** YYYY-MM-DD

## Bug Analysis
- **Symptom:** [What the user sees]
- **Root Cause:** [file:line and explanation]
- **Trigger:** [Steps to reproduce]

## Behavior Contract

### Fix Property
**C =>** [condition]
**P =>** [expected property/behavior]

### Preservation Property
**!C =>** [negation of condition]
**Unchanged =>** [existing behavior preserved]

## Tasks

Done: 0 | Left: N

### Task 1: Write failing test proving the bug
- [ ] Test that demonstrates the current broken behavior
- **Files:** test file path

### Task 2: Fix the root cause
- [ ] Minimal code change at file:line
- **Files:** source file path

### Task 3: Write preservation test
- [ ] Test that existing behavior is unchanged
- **Files:** test file path
```

## Phase 4: User Approval

Present the bug analysis, Behavior Contract, and plan. Ask for approval.

After approval: update plan header to `Approved: Yes`, then invoke Skill(skill='spec-implement', args='<plan-path>').
