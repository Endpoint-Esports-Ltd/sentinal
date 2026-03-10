---
description: Spec-driven development - plan, implement, verify workflow
argument-hint: <task> or <path/to/plan.md>
---

# /spec - Unified Spec-Driven Development

**You are the /spec dispatcher. Your job is to detect the task type and route to the correct phase.**

ARGUMENTS: $ARGUMENTS

## Dispatch Logic

### If ARGUMENTS contains a `.md` file path:

1. Read the plan file to get `Status:` and `Type:` headers
2. Route based on status:

| Status | Approved | Type | Next Command |
|--------|----------|------|--------------|
| PENDING | No | Feature (or absent) | Run `/spec-plan $ARGUMENTS` |
| PENDING | No | Bugfix | Run `/spec-bugfix-plan $ARGUMENTS` |
| PENDING | Yes | * | Run `/spec-implement $ARGUMENTS` |
| COMPLETE | * | Feature (or absent) | Run `/spec-verify $ARGUMENTS` |
| COMPLETE | * | Bugfix | Run `/spec-bugfix-verify $ARGUMENTS` |
| VERIFIED | * | * | Report completion |

### If ARGUMENTS is a task description (no .md path):

1. Detect type: Is this clearly a bugfix or clearly a feature?
   - **Bugfix indicators:** "fix", "bug", "broken", "error", "crash", "regression", "not working"
   - **Feature indicators:** "add", "create", "implement", "build", "new", "enhance"
   - **Ambiguous:** Ask the user

2. Ask the user about worktree isolation:
   - "Yes (Recommended)" - creates worktree, squash merges after verification
   - "No" - direct implementation on current branch

3. Route to the appropriate planning skill:
   - Feature → /spec-plan $ARGUMENTS
   - Bugfix → /spec-bugfix-plan $ARGUMENTS

## Rules

- You are a DISPATCHER only - do NOT explore code, read files, or do substantive work
- Only use `AskUserQuestion` and `/slash-commands`
- Everything after `/spec` is the task description
- Route to the correct skill and let it handle the work
