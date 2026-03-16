---
name: spec-bugfix-plan
description: Bugfix spec planning phase - investigate root cause, design fix, get approval
---

---

# /spec-bugfix-plan - Bugfix Planning Phase

**Phase 1 (bugfix).** Investigates root cause, creates lean fix plan, gets approval.

**Input:** Bug description (new) or plan path (continue unapproved)
**Output:** Approved bugfix plan at `docs/plans/YYYY-MM-DD-<slug>.md` with `Type: Bugfix`
**Next:** On approval → `Skill(skill='spec-implement', args='<plan-path>')`

---

## Iron Law

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

If you haven't completed Step 1.2, you cannot propose fixes. Symptom fixes are failure.

---

## Critical Constraints

- **NEVER write code during planning** — planning and implementation are separate phases
- **NEVER assume — verify by reading files.** Trace the bug to actual file:line.
- **Right-size the plan** — small bugs get lean plans. Don't over-engineer.
- **Plan file is source of truth** — survives across auto-compaction cycles
- **ALWAYS use `AskUserQuestion` tool** for clarifications — never list numbered questions in plain text
- **⛔ If `SENTINAL_PLAN_QUESTIONS_ENABLED` is `"false"` (from Step 0),** skip all `AskUserQuestion` calls. Make reasonable default assumptions and document them in the plan. Continue autonomously.

---

## Step 0: Read Toggle Configuration

**⛔ Run FIRST, before any other step.** Read all toggle env vars in a single Bash call:

**Preferred:** Use `spec_config` MCP tool (returns all toggles in one call).

```bash
echo "QUESTIONS=$SENTINAL_PLAN_QUESTIONS_ENABLED APPROVAL=$SENTINAL_PLAN_APPROVAL_ENABLED"
```

Reference these values throughout: Steps 1.2.1/1.2.5 (questions) and 1.5 (approval).

---

## Red Flags — STOP and Follow Process

If you catch yourself thinking any of these, STOP. Return to Step 1.2.

- "Quick fix for now, investigate later"
- "Just try changing X and see if it works"
- "It's probably X, let me fix that"
- "I don't fully understand but this might work"
- Proposing solutions before tracing data flow
- "One more fix attempt" (when already tried 2+)
- Each fix reveals a new problem in a different place

---

## Step 1.1: Create Plan File Header (FIRST)

1. **Parse worktree** from arguments: `--worktree=yes|no` (default: `No`). Strip flag.
2. **Create worktree early (if yes):**

   **Preferred:** Use `worktree_detect` / `worktree_create` MCP tools.

   Same pattern as spec-plan Step 1.1 using `sentinal worktree detect/create`.

3. **Generate filename:** `docs/plans/YYYY-MM-DD-<bug-slug>.md`
4. `mkdir -p docs/plans`
5. **Write header:**

   ```markdown
   # [Bug Description] Fix Plan

   Created: [Date]
   Status: PENDING
   Approved: No
   Iterations: 0
   Worktree: [Yes|No]
   Type: Bugfix

   > Investigating bug...

   ## Summary

   **Symptom:** [Bug description from user]

   ---

   _Tracing root cause..._
   ```

6. **Register:**

   **Preferred:** Use `spec_register` MCP tool with `plan_path` and optional `status` parameters.

   `sentinal register-plan "<plan_path>" "PENDING" 2>/dev/null || true`

---

## Step 1.2: Root Cause Investigation

**Complete each sub-step before the next. No shortcuts.**

### 1.2.1: Reproduce & Understand

1. Restate: **symptom** (what user observes), **trigger** (when/how), **expected behavior**
2. If too vague: `AskUserQuestion` with ONE focused question
3. Can you trigger it reliably? What are the exact steps?
4. If not reproducible: gather more data, don't guess

### 1.2.2: Check Recent Changes

- What changed that could cause this? `git log --oneline -10 -- <file>`, `git diff`
- New dependencies, config changes, Angular/NestJS version bumps?

### 1.2.3: Trace the Root Cause

Read as many files as needed. For each: read completely, trace execution path from user action to symptom, note specific lines where behavior diverges.

**Backward tracing technique (from symptom to source):**

1. Find where the error/wrong behavior appears — note file:line
2. What called this with the wrong value/state? Trace one level up.
3. Keep tracing until you find the **source** — where the bad data originates
4. **Fix at the source, not where the error appears**

**Multi-component systems (Angular + NestJS):** Before concluding, instrument at boundaries:

- What data enters each component? What exits?
- WHERE does it break? Run once to gather evidence, THEN investigate the failing component.

**Tools:** Vexor (`vexor search` — find by intent), Read/Grep/Glob (direct exploration)

### 1.2.4: Pattern Analysis

1. Find **working examples** — similar code in the codebase that works correctly
2. Compare: what's different between working and broken?
3. List every difference, however small — don't assume "that can't matter"

### 1.2.5: Root Cause Statement

State clearly:

- **Root cause:** `src/path/file.ts:lineN` — `functionName()` does X but should do Y
- **Why:** Explain WHY it causes the symptom (not just what's wrong)
- **Confidence:** High (traced fully) / Medium (strong hypothesis) / Low (needs more data)

If confidence is Low: gather more evidence. Don't guess.

**Escalation:** If 3+ hypotheses have failed, STOP — this is likely an architectural problem. `AskUserQuestion` to discuss with user before continuing.

---

## Step 1.3: Plan the Fix

### Gate Function — Before Planning

```
BEFORE writing the plan:
  1. Can I state the root cause with file:line? If NO → back to 1.2
  2. Can I explain WHY it causes the symptom? If NO → back to 1.2
  3. Is my confidence High or Medium? If LOW → back to 1.2
```

### Size the task structure

| Size                  | Criteria                         | Tasks                         |
| --------------------- | -------------------------------- | ----------------------------- |
| **Compact** (default) | ≤3 files, clear root cause       | 2: Fix (test + code) → Verify |
| **Full**              | 4+ files, multiple failure modes | 3: Tests → Fix → Verify       |

### Compact (most bugs)

**Task 1: Fix** — Write regression test → verify FAILS → implement fix → verify all PASS.
**Task 2: Verify** — Full test suite, TypeScript, lint.

### Full (complex bugs)

**Task 1: Write Tests** — regression + preservation tests (if fix touches shared code paths).
**Task 2: Implement Fix** — minimal fix at root cause.
**Task 3: Verify** — full suite, TypeScript, lint.

**Regression tests must exercise existing public entry points** — not internal helpers you plan to create. The test answers: "Under the bug condition, does the system produce the correct result?"

**Defense-in-depth:** When the bug was caused by invalid data flowing through multiple layers, plan validation at every layer:

| Layer              | Purpose                                           | Example                                        |
| ------------------ | ------------------------------------------------- | ---------------------------------------------- |
| Entry point        | Reject invalid input at API/component boundary    | NestJS DTO validation, Angular form validators |
| Business logic     | Ensure data makes sense for this operation        | Service-level guards                           |
| Environment guards | Prevent dangerous operations in specific contexts | Guards on destructive operations               |

---

## Step 1.4: Write the Bugfix Plan

**Save to:** `docs/plans/YYYY-MM-DD-<bug-name>.md`

```markdown
# [Bug Description] Fix Plan

Created: [Date]
Status: PENDING
Approved: No
Iterations: 0
Worktree: [Yes|No]
Type: Bugfix

## Summary

**Symptom:** [What user observes]
**Trigger:** [When/how it happens]
**Root Cause:** `src/path/file.ts:lineN` — [what's wrong and why]

## Investigation

- [Key findings from tracing — breadcrumb trail so implementer understands the bug]
- [Working example for comparison, if relevant]
- [Recent changes that may have caused it, if relevant]

## Behavior Contract

### Fix Property (C => P)

**When condition C holds:** [exact condition, e.g., "user submits empty form"]
**Property P must hold:** [expected behavior, e.g., "validation error is shown, form not submitted"]

### Preservation Property (!C => unchanged)

**When condition C does NOT hold:** [e.g., "user submits valid form"]
**Existing behavior preserved:** [e.g., "form submits successfully as before"]

## Fix Approach

**Files:** [files to modify]
**Strategy:** [how to fix — reference pattern from working code if applicable]
**Tests:** [test files to create/modify]
**Defense-in-depth:** [additional validation layers, if applicable — skip for isolated fixes]

## Progress

- [ ] Task 1: [title]
- [ ] Task 2: [title]
      **Tasks:** N | **Done:** 0 | **Left:** N

## Tasks

### Task 1: Fix

**Objective:** Write regression test → implement fix
**Files:** [list]
**TDD:** Write regression test → verify FAILS → implement fix → verify all PASS
**Verify:** `npx jest <test-path> --verbose` / `bun test <test-path>`

### Task 2: Verify

**Objective:** Full suite + quality checks
**Verify:** `bun test && npx tsc --noEmit && npx eslint .`
```

**Do NOT include:** Separate "Testing Strategy" section, "Goal Verification / Truths / Artifacts" sections, "Risks and Mitigations" table, "Prerequisites" section, per-task "Definition of Done" checklists, per-task "Dependencies" field. Keep it lean.

---

## Step 1.5: Get User Approval

**⛔ If `SENTINAL_PLAN_APPROVAL_ENABLED` is `"false"` (from Step 0),** skip this step: set `Approved: Yes` in the plan file automatically and immediately invoke `Skill(skill='spec-implement', args='<plan-path>')`. No AskUserQuestion.

**When `SENTINAL_PLAN_APPROVAL_ENABLED` is NOT `"false"`:**

0. Notify:
   ```bash
   sentinal notify plan_approval "Bugfix Plan Ready" "<plan-slug> — approval needed" --plan-path "<plan_path>" 2>/dev/null || true
   ```
1. Summarize: symptom → root cause → fix approach → task structure
2. AskUserQuestion: "Yes, proceed" | "No, let me edit"
3. **Yes:** Set `Approved: Yes`, invoke `Skill(skill='spec-implement', args='<plan-path>')`
   **No:** User edits, re-read, ask again. **Other feedback:** Incorporate, re-ask.

---

## Continuing Unapproved Bugfix Plans

When arguments end with `.md`: read plan, check Status/Approved. Resume from wherever planning left off: no investigation yet → Step 1.2. Has investigation, no tasks → Step 1.3. Complete but unapproved → Step 1.5.

ARGUMENTS: $ARGUMENTS
