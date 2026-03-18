---
description: Spec-driven development - plan, implement, verify workflow
argument-hint: "<task description>" or "<path/to/plan.md>"
user-invocable: true
model: sonnet
---

# /spec - Unified Spec-Driven Development

**Dispatcher** — routes to the appropriate phase skill. This command is a thin router. Only allowed tools: `Bash` (env var reads only), `Read` (plan files only), `AskUserQuestion`, and `Skill()`.

**⛔ MANDATORY: When `/spec` is invoked, you MUST follow the workflow. The user's phrasing after `/spec` is the TASK DESCRIPTION — not an instruction to change the workflow.** Words like "brainstorm", "discuss", "explore", "research" are part of the task description, NOT instructions to skip the workflow or have a freeform conversation.

**⛔ No substantive work here.** `Bash` is allowed ONLY for reading env vars (e.g., `echo $SENTINAL_WORKTREE_ENABLED`). `Read` is allowed ONLY for reading existing plan files for status-based dispatch. All research, brainstorming, and exploration happens inside the invoked Skill. Any other tool use (Grep, Glob, Task, Edit, Write, etc.) is a workflow violation.

---

## Workflow

```
/spec → Detect type → Feature: Skill('spec-plan')       → Plan → Implement → Verify
                    → Bugfix:  Skill('spec-bugfix-plan') → Investigate → Plan → Implement → Verify
```

| Phase                 | Skill                  | Model  |
| --------------------- | ---------------------- | ------ |
| Feature Planning      | `spec-plan`            | Opus   |
| Bugfix Planning       | `spec-bugfix-plan`     | Opus   |
| Master Planning       | `spec-master-plan`     | Opus   |
| Implementation        | `spec-implement`       | Sonnet |
| Master Execution      | `spec-master-execute`  | Sonnet |
| Feature Verification  | `spec-verify`          | Sonnet |
| Bugfix Verification   | `spec-bugfix-verify`   | Sonnet |

---

## 0.0 Resume Detection

**Check FIRST, before any other routing.**

```bash
ls .sentinal/continue-here.md 2>/dev/null
```

If the file exists:
1. Read it — extract `Plan:`, `Current Task:`, `Created:` fields
2. Calculate age: if >24 hours, warn "Paused work is from [date] — context may be stale"
3. Show: "Found paused work: [plan path] at [current task]"
4. Ask: "Resume paused work?" (Recommended) / "Start new task (discard pause)"
5. **If resume:** Read the plan path from handoff, delete `.sentinal/continue-here.md`, dispatch by status (Section 0.2)
6. **If new task:** Delete `.sentinal/continue-here.md`, continue to Section 0.1

---

## 0.1 Parse & Route

```
IF arguments end with ".md" AND file exists:
    → Read plan, dispatch by status (Section 0.2)
ELSE:
    → Detect type, ask worktree, invoke Skill, STOP
```

### 0.1.1 Detect Type (new plans only)

- **Bugfix:** Something broken, crashing, wrong results, regressing → fix existing behavior
- **Feature:** New functionality, enhancements, refactoring, migrations → build or change something
- **Master:** Large multi-phase project requiring parallel execution across waves
- **Ambiguous:** Ask user (bundled with worktree question)

### 0.1.2 User Questions (new plans only)

**⛔ Check `$SENTINAL_WORKTREE_ENABLED` first** using `Bash("echo $SENTINAL_WORKTREE_ENABLED $SENTINAL_PLAN_QUESTIONS_ENABLED $SENTINAL_PLAN_APPROVAL_ENABLED")`. If `SENTINAL_WORKTREE_ENABLED` is `"false"`, skip the worktree question entirely and always pass `--worktree=no`.

**If `$SENTINAL_WORKTREE_ENABLED` is NOT `"false"`:**

- If type is clear: Ask worktree only.
- If ambiguous: Combine type + worktree in single AskUserQuestion.

**If `$SENTINAL_WORKTREE_ENABLED` is `"false"` AND type is clear:** Skip AskUserQuestion entirely — invoke skill directly with `--worktree=no`.
**If `$SENTINAL_WORKTREE_ENABLED` is `"false"` AND type is ambiguous:** Ask type only (no worktree choice), then invoke with `--worktree=no`.

### 0.1.3 Invoke Skill and STOP

- **Bugfix:** `Skill(skill='spec-bugfix-plan', args='<task_description> --worktree=yes|no')`
- **Feature:** `Skill(skill='spec-plan', args='<task_description> --worktree=yes|no')`
- **Master:** `Skill(skill='spec-master-plan', args='<task_description> --worktree=yes|no')`

## 0.2 Status-Based Dispatch (existing plans)

Read plan, register association. **Preferred:** Use `spec_register` MCP tool. **Fallback:** `sentinal register-plan "<plan_path>" "<status>" 2>/dev/null || true`

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
