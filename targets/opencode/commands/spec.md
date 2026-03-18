---
description: Spec-driven development - plan, implement, verify workflow
argument-hint: "<task description>" or "<path/to/plan.md>"
---

# /spec - Unified Spec-Driven Development

**Dispatcher** — routes to the appropriate phase skill.

**⛔ MANDATORY: When `/spec` is invoked, follow the workflow. The user's phrasing after `/spec` is the TASK DESCRIPTION.** You are a thin router only — do no substantive work here.

---

## Workflow

| Phase                 | Skill                  | When                       |
| --------------------- | ---------------------- | -------------------------- |
| Feature Planning      | `spec-plan`            | New feature task           |
| Bugfix Planning       | `spec-bugfix-plan`     | Bug/crash/regression       |
| Master Planning       | `spec-master-plan`     | Multi-phase project        |
| Implementation        | `spec-implement`       | Plan approved              |
| Master Execution      | `spec-master-execute`  | Master plan approved       |
| Feature Verification  | `spec-verify`          | Feature complete           |
| Bugfix Verification   | `spec-bugfix-verify`   | Bugfix complete            |

---

## 0.1 Parse & Route

```
IF arguments end with ".md" AND file exists:
    → Read plan, dispatch by status (Section 0.2)
ELSE:
    → Detect type, ask worktree, load skill, STOP
```

### 0.1.1 Detect Type (new plans only)

- **Bugfix:** Something broken, crashing, wrong results, regressing
- **Feature:** New functionality, enhancements, refactoring, migrations
- **Master:** Large multi-phase project requiring parallel execution across waves
- **Ambiguous:** Ask user

### 0.1.2 User Questions (new plans only)

Check `$SENTINAL_WORKTREE_ENABLED`. If `"false"`, skip worktree question and pass `--worktree=no`.

If type is clear and worktree enabled: ask worktree only.
If ambiguous: combine type + worktree in single question.
If worktree disabled and type clear: skip all questions, load skill with `--worktree=no`.

### 0.1.3 Load Skill and STOP

- **Bugfix:** Load skill `spec-bugfix-plan` with `<task_description> --worktree=yes|no`
- **Feature:** Load skill `spec-plan` with `<task_description> --worktree=yes|no`
- **Master:** Load skill `spec-master-plan` with `<task_description> --worktree=yes|no`

## 0.2 Status-Based Dispatch (existing plans)

Read plan. Register: **Preferred:** Use `spec_register` MCP tool. **Fallback:** `sentinal register-plan "<plan_path>" "<status>" 2>/dev/null || true`

| Status      | Approved | Type           | Skill                   |
| ----------- | -------- | -------------- | ----------------------- |
| PENDING     | No       | Feature/absent | `spec-plan`             |
| PENDING     | No       | Bugfix         | `spec-bugfix-plan`      |
| PENDING     | No       | Master         | `spec-master-plan`      |
| PENDING     | Yes      | Feature/Bugfix | `spec-implement`        |
| PENDING     | Yes      | Master         | `spec-master-execute`   |
| IN_PROGRESS | \*       | Feature/Bugfix | `spec-implement`        |
| IN_PROGRESS | \*       | Master         | `spec-master-execute`   |
| COMPLETE    | \*       | Feature/absent | `spec-verify`           |
| COMPLETE    | \*       | Bugfix         | `spec-bugfix-verify`    |
| COMPLETE    | \*       | Master         | `spec-verify`           |
| VERIFIED    | \*       | \*             | Report completion, done |

ARGUMENTS: $ARGUMENTS
