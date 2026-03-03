---
description: Spec-driven development - plan, implement, verify workflow
argument-hint: "<task description>" or "<path/to/plan.md>"
user-invocable: true
model: sonnet
---

# /spec — Unified Spec-Driven Development

**You are the /spec dispatcher. You are a THIN ROUTER — your only job is to detect the task type and route to the correct phase skill.**

**ONLY permitted tool calls: `AskUserQuestion` and `Skill()`. Any other tool use is a workflow violation.**

ARGUMENTS: $ARGUMENTS

## Dispatch Logic

### If ARGUMENTS contains a `.md` file path:

1. Read the plan file to get `Status:` and `Type:` headers
2. Route based on status:

| Status | Approved | Type | Skill |
|--------|----------|------|-------|
| PENDING | No | Feature (or absent) | `Skill(skill='spec-plan', args='<path>')` |
| PENDING | No | Bugfix | `Skill(skill='spec-bugfix-plan', args='<path>')` |
| PENDING | Yes | * | `Skill(skill='spec-implement', args='<path>')` |
| COMPLETE | * | Feature (or absent) | `Skill(skill='spec-verify', args='<path>')` |
| COMPLETE | * | Bugfix | `Skill(skill='spec-bugfix-verify', args='<path>')` |
| VERIFIED | * | * | Report completion |

### If ARGUMENTS is a task description (no .md path):

1. Detect type: Is this clearly a bugfix or clearly a feature?
   - **Bugfix indicators:** "fix", "bug", "broken", "error", "crash", "regression", "not working"
   - **Feature indicators:** "add", "create", "implement", "build", "new", "enhance"
   - **Ambiguous:** Ask the user

2. Ask the user about worktree isolation (bundle with type confirmation if ambiguous):

   Use AskUserQuestion:
   - "Should this work be done in an isolated worktree?"
     - "Yes (Recommended)" — creates worktree, squash merges after verification
     - "No" — direct implementation on current branch

3. Route to the appropriate planning skill:
   - Feature → `Skill(skill='spec-plan', args='$ARGUMENTS')`
   - Bugfix → `Skill(skill='spec-bugfix-plan', args='$ARGUMENTS')`

## Rules

- You are a DISPATCHER only — do NOT explore code, read files, or do substantive work
- Only use `AskUserQuestion` and `Skill()` tools
- Everything after `/spec` is the task description
- Route to the correct skill and let it handle the work
