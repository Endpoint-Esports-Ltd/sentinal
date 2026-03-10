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

| Status | Approved | Type | Next Action |
|--------|----------|------|-------------|
| PENDING | No | Feature (or absent) | Load skill `spec-plan` with $ARGUMENTS |
| PENDING | No | Bugfix | Load skill `spec-bugfix-plan` with $ARGUMENTS |
| PENDING | Yes | * | Load skill `spec-implement` with $ARGUMENTS |
| COMPLETE | * | Feature (or absent) | Load skill `spec-verify` with $ARGUMENTS |
| COMPLETE | * | Bugfix | Load skill `spec-bugfix-verify` with $ARGUMENTS |
| VERIFIED | * | * | Run completion audit, then report completion |

### If ARGUMENTS is a task description (no .md path):

1. Detect type: Is this clearly a bugfix or clearly a feature?
   - **Bugfix indicators:** "fix", "bug", "broken", "error", "crash", "regression", "not working"
   - **Feature indicators:** "add", "create", "implement", "build", "new", "enhance"
   - **Ambiguous:** Ask the user

2. Ask the user about worktree isolation:
   - "Yes (Recommended)" - creates worktree, squash merges after verification
   - "No" - direct implementation on current branch

3. Route to the appropriate planning skill:
   - Feature → Load skill `spec-plan` with $ARGUMENTS
   - Bugfix → Load skill `spec-bugfix-plan` with $ARGUMENTS

### Completion Audit (VERIFIED status)

When a spec reaches VERIFIED, run the `spec_status` MCP tool to check for any task state discrepancies between the plan `.md` file and the stored task states. Report:
- Total tasks and how many are marked complete
- Any tasks that are checked in the `.md` but not marked complete in the store (or vice versa)
- Final status summary

## Rules

- You are a DISPATCHER only - do NOT explore code, read files, or do substantive work
- Only use the `question` tool and the `skill` tool to route to sub-phases
- Everything after `/spec` is the task description
- Route to the correct skill and let it handle the work
