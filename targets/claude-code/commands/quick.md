---
description: Quick spec workflow - skip reviewers and approval for small tasks
argument-hint: "<task description>"
---

# /quick - Quick Spec Workflow

**Lightweight spec workflow for small tasks.** Same structure as `/spec` but skips plan reviewer, approval, and spec reviewer. Keeps exploration, TDD, and automated checks.

**Use when:** The task is small, well-understood, and doesn't need review ceremony. Examples: "add a field to this DTO", "fix this import", "update this test".

**Use `/spec` instead when:** The task is complex, has architectural implications, or you want quality review.

---

## Process

### Step 1: Set Quick Mode Toggles

```bash
export SENTINAL_PLAN_REVIEWER_ENABLED=false
export SENTINAL_PLAN_APPROVAL_ENABLED=false
export SENTINAL_SPEC_REVIEWER_ENABLED=false
```

### Step 2: Detect Type

- **Bugfix indicators:** "fix", "bug", "broken", "error", "crash", "regression", "not working"
- **Feature indicators:** "add", "create", "implement", "build", "new", "enhance", "refactor", "update"
- **Ambiguous:** Ask user

### Step 3: Load Planning Skill

- **Bugfix:** Load skill `spec-bugfix-plan` with `<task_description> --worktree=no`
- **Feature:** Load skill `spec-plan` with `<task_description> --worktree=no`

The planning skill will read the toggles via `spec_init` and automatically:

- Skip the plan reviewer (Step 1.7)
- Skip approval (Step 1.8) — auto-approves and chains to implementation
- Skip the spec reviewer in verification

Quick tasks never use worktrees — they're too small to justify the overhead.

ARGUMENTS: $ARGUMENTS
