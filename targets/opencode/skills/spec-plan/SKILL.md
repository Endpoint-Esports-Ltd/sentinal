---
name: spec-plan
description: Spec planning phase - explore codebase, design plan, get approval
---

# /spec-plan - Planning Phase

**Phase 1 of the /spec workflow.** Explores codebase, designs implementation plan, verifies it, gets user approval.

**Input:** Task description (new) or plan path (continue unapproved)
**Output:** Approved plan at `docs/plans/YYYY-MM-DD-<slug>.md`
**Next:** On approval → `Skill(skill='spec-implement', args='<plan-path>')`

---

## ⛔ Critical Constraints

- **NO sub-agents during planning** except Step 1.7 (plan-reviewer, when enabled)
- **Run plan-reviewer when enabled** — it runs for every feature spec when `$SENTINAL_PLAN_REVIEWER_ENABLED` is not `"false"`. Context level is NOT a valid reason to skip.
- **NEVER write code during planning** — planning and implementation are separate phases
- **NEVER assume — verify by reading files**
- **ONLY stopping point is plan approval** — everything else is automatic
- **Re-read plan after user edits** — before asking for approval again
- **Plan file is source of truth** — survives across auto-compaction cycles
- **Quality over speed** — never rush due to context pressure

---

## Step 0: Read Toggle Configuration

**⛔ Run FIRST, before any other step.**

**Preferred:** Use `spec_init` MCP tool (returns config toggles, active plan state, and current task in one call).

```bash
echo "QUESTIONS=$SENTINAL_PLAN_QUESTIONS_ENABLED REVIEWER=$SENTINAL_PLAN_REVIEWER_ENABLED APPROVAL=$SENTINAL_PLAN_APPROVAL_ENABLED"
```

Reference these values throughout: Steps 1.2/1.3b/1.4 (questions), 1.7 (reviewer), 1.8 (approval).

**Quick mode detection:** If `plan_reviewer_enabled`, `approval_enabled`, AND `spec_reviewer_enabled` are ALL `"false"`, this is a quick task (invoked via `/quick`). Use a lighter plan template in Step 1.6:
- Skip `## Risks and Mitigations`, `## Pre-Mortem`, `## Context for Implementer` sections
- Keep `## Summary`, `## Scope`, `## Goal Verification`, `## Implementation Tasks`
- Exploration and questions still run normally

---

## Asking User Questions

**⛔ If `SENTINAL_PLAN_QUESTIONS_ENABLED` is `"false"`,** skip ALL `AskUserQuestion` calls in Steps 1.2, 1.3b, and 1.4. Make reasonable default choices, document under "Autonomous Decisions". Continue immediately.

**⛔ ALWAYS use the `AskUserQuestion` tool** (when questions are enabled) — never list numbered questions in plain text.

**⛔ Default is to ASK, not skip.** Every plan benefits from at least one round of user alignment.

**Questions batched into max 2 interactions:** Batch 1 (before exploration) clarifies task/scope/priorities. Batch 2 (after exploration) resolves architecture/design decisions.

**Principles:** Present options with trade-offs. Start open, narrow down. 1-2 focused questions beat 4 vague ones.

## Extending Existing Plans

When adding tasks to an existing plan: load it, parse structure, verify compatibility, mark new tasks with `[NEW]`, update totals. If original + new > 12 tasks, suggest splitting.

## ⚠️ Migration/Refactoring Tasks

**When replacing existing code, complete a Feature Inventory BEFORE creating tasks:**

1. List ALL files being replaced with their functions/classes
2. Map EVERY function to a task — no row may be "Not mapped"
3. Every row needs a Task # or explicit "Out of Scope" with user confirmation

---

## Creating New Plans

### Step 1.1: Create Plan File Header (FIRST)

1. **Parse worktree** from arguments: `--worktree=yes|no` (default: `Yes`). Strip flag from task description.

2. **Create worktree early (if yes):**

   **Preferred:** Use `worktree_detect` / `worktree_create` MCP tools.

   ```bash
   sentinal worktree detect --json <plan_slug>
   # If not found:
   sentinal worktree create --json <plan_slug>
   # Returns: {"path": "...", "branch": "spec/<slug>", "base_branch": "main"}
   ```

   If creation fails: continue without worktree, set to `No`.

3. **Generate filename:** `docs/plans/YYYY-MM-DD-<feature-slug>.md` — slug from first 3-4 words.

4. `mkdir -p docs/plans`

5. **Write initial header:**

   ```markdown
   # [Feature Name] Implementation Plan

   Created: [Date]
   Status: PENDING
   Approved: No
   Iterations: 0
   Worktree: [Yes|No]
   Type: Feature

   > Planning in progress...
   ```

6. **Register plan:**

   **Preferred:** Use `spec_register` MCP tool with `plan_path` and optional `status` parameters.

   `sentinal register-plan "<plan_path>" "PENDING" 2>/dev/null || true`

**Do this FIRST** — before any exploration or questions.

---

### Step 1.2: Task Understanding, Discuss & Clarify

1. Restate the task in your own words — core problem, assumptions
2. Identify gray areas (layout/interactions for UI, response shape for API, schema for data)
3. **Ask Batch 1 questions** → use `AskUserQuestion` with each question as a separate entry with predefined options. Even when task seems clear, ask about scope boundaries or priority trade-offs.

### Step 1.3: Exploration

**Explore systematically, one area at a time.**

| Tool               | When                                      |
| ------------------ | ----------------------------------------- |
| **Context7**       | Library/framework docs                    |
| **Vexor**          | Semantic code search by intent (via Bash) |
| **grep-mcp**       | Real-world GitHub examples                |
| **Read/Grep/Glob** | Direct file exploration                   |

**Areas (in order):** Architecture → Similar Features → Dependencies → Tests

For each: document hypotheses, note full file paths, track unanswered questions.

### Step 1.3b: Present Findings & Scope Selection — CONDITIONAL

**Only when exploration revealed multiple possible directions or scope is ambiguous.**

1. List discovered gaps/opportunities
2. Present 2-3 approaches with trade-offs and recommendation
3. `AskUserQuestion(multiSelect: true)` — let user pick which items to include

### Step 1.4: Design Decisions

**⛔ Do NOT skip this step.** After exploration, there are always design choices to validate. For each decision, propose 2-3 concrete approaches with trade-offs and recommendation. Use `AskUserQuestion` (Batch 2).

Frame each decision as **"X at the cost of Y"** — never recommend without stating what it costs.

### Step 1.5: Implementation Planning

**Task Granularity:** Each task: independently testable, focused (2-4 files max), verifiable.

**Task Structure:**

```markdown
### Task N: [Component Name]

**Objective:** [1-2 sentences]
**Dependencies:** [None | Task X, Task Y]
**Wave:** [1 | 2 | ...]

**Files:**

- Create: `exact/path/to/file.ts`
- Modify: `exact/path/to/existing.ts`
- Test: `exact/path/to/test.spec.ts`

**Key Decisions / Notes:**

- [Technical approach, pattern to follow with file:line ref]

**Definition of Done:**

- [ ] All tests pass
- [ ] No diagnostics errors
- [ ] [Verifiable criterion]

**Verify:**

- `bun test path/to/test.spec.ts`
```

**DoD must be verifiable.** ✅ "GET /api/users?role=admin returns only admin users" ❌ "Feature works correctly"

**Zero-context assumption:** Assume implementer knows nothing. Provide exact file paths, explain domain concepts, reference similar patterns.

**Assumptions:** After creating tasks, write `## Assumptions` — one bullet per assumption: what you assume, which finding supports it, which task numbers depend on it.

#### Step 1.5.0: Execution Wave Grouping

**After defining all tasks, group them into execution waves for parallel implementation.**

1. **Analyze dependencies:** Wave 1 = tasks with no dependencies. Wave 2 = tasks depending only on Wave 1 tasks. Wave N = tasks depending only on Wave 1..N-1 tasks.
2. **Check file overlap:** Tasks in the same wave MUST NOT modify the same files. If two tasks in the same wave share files, move one to the next wave. This is required for worktree-isolated parallel execution.
3. **Assign `**Wave:**` field** to each task.
4. **Write `## Execution Waves` section** (see Step 1.6 template).
5. **Update Progress Tracking** to show wave assignments: `- [ ] Task 1: [summary] (Wave 1)`

**Rules:**
- If all tasks are in Wave 1 (no dependencies, no shared files), that's fine — maximum parallelism.
- If wave analysis is unclear, default to sequential: each task in its own wave.
- Single-task waves are normal and expected.

#### Step 1.5.1: Goal Verification Criteria (must_haves)

After creating tasks, derive **structured, verifiable** criteria for the `## Goal Verification` section:

1. **State the goal** (1 sentence)

2. **Derive 3-7 Truths** — each must be **grep-verifiable** or **curl-testable**, never vague prose:
   - ✅ `GET /api/users returns 200 with JSON array` (curl-testable)
   - ✅ `src/auth/login.ts contains bcrypt.compare call` (grep-verifiable)
   - ❌ `Authentication works correctly` (vague — not falsifiable)

3. **List Artifacts** — each with `path`, `provides`, and `exports`:
   ```
   | Artifact | Provides | Exports |
   |----------|----------|---------|
   | src/auth/login.ts | Login endpoint | POST /api/auth/login |
   | src/auth/guard.ts | Auth middleware | AuthGuard class |
   ```

4. **List Key Links** — each with `from`, `to`, `via`, and `pattern` (grep-verifiable):
   ```
   | From | To | Via | Pattern |
   |------|----|-----|---------|
   | src/auth/login.ts | prisma.user | credential lookup | prisma\.user\.findUnique |
   | src/router.ts | src/auth/login.ts | route registration | import.*login |
   ```
   Key links prove artifacts are **wired together**, not just created in isolation.

#### Step 1.5.2: Pre-Mortem & Falsification Signals

**Assume this plan failed after full execution. Why?** Write 2-3 failure scenarios with observable trigger conditions checked during implementation.

**This is distinct from Risks** (external dependencies) and from **Goal Verification truths** (what success looks like). Pre-Mortem covers _internal approach validity_.

Example: Risk = "Redis is unavailable" | Pre-Mortem = "We assumed sessions are stateless but they're not — trigger: session data can't round-trip through the new format in first integration test"

Write these to the `## Pre-Mortem` section.

### Step 1.6: Write Full Plan

**Required sections:**

```markdown
# [Feature Name] Implementation Plan

Created: [Date]
Status: PENDING
Approved: No
Iterations: 0
Worktree: [Yes|No]
Type: Feature

## Summary

**Goal:** [One sentence]
**Architecture:** [2-3 sentences]
**Tech Stack:** [Key technologies]

## Scope

### In Scope

### Out of Scope

## Context for Implementer

> Write for an implementer who has never seen the codebase.

- **Patterns to follow:** [file:line references]
- **Conventions:** [naming, organization, error handling]
- **Key files:** [important files with descriptions]
- **Gotchas:** [non-obvious dependencies]
- **Domain context:** [business logic needed to understand task]

## Runtime Environment (only if project has a running service)

- **Start command / Port / Deploy path / Health check / Restart procedure**

## Assumptions

- [What you assume] — supported by [finding/file:line] — Tasks N, M depend on this

## Testing Strategy

- Unit / Integration / Manual verification

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |

## Pre-Mortem

_Assume this plan failed. Most likely internal reasons:_

1. **[Failure scenario]** (Task N) → Trigger: [observable condition]
2. **[Failure scenario]** (Task N) → Trigger: [observable condition]

## Execution Waves

**Wave 1** — [label] (parallel): [rationale for why these tasks are independent]
**Wave 2** — [label] (parallel): [rationale — depends on Wave 1 because...]

## Goal Verification

### Truths
1. [grep-verifiable or curl-testable statement]
2. [grep-verifiable or curl-testable statement]

### Artifacts
| Artifact | Provides | Exports |
|----------|----------|---------|
| [exact file path] | [what it delivers] | [public API/exports] |

### Key Links
| From | To | Via | Pattern |
|------|----|-----|---------|
| [source file] | [target] | [connection type] | [grep pattern] |

## Progress Tracking

- [ ] Task 1: [summary] (Wave 1)
- [ ] Task 2: [summary] (Wave 1)
- [ ] Task 3: [summary] (Wave 2)
      **Total Tasks:** N | **Completed:** 0 | **Remaining:** N

## Implementation Tasks

[Tasks from Step 1.5]
```

### Step 1.7: Plan Verification

**⛔ If `SENTINAL_PLAN_REVIEWER_ENABLED` is `"false"`,** skip this step entirely.

**When enabled:** Launch plan-reviewer for every feature spec.

**Derive output path from plan path** (replace `.md` with `.plan-review.json`):

```bash
PLAN_PATH="<plan-path>"
OUTPUT_PATH="${PLAN_PATH%.md}.plan-review.json"
rm -f "$OUTPUT_PATH"
```

```
Task(
  subagent_type="sentinal:plan-reviewer",
  run_in_background=true,
  prompt="""
  **Plan file:** <plan-path>
  **User request:** <original task description>
  **Clarifications:** <any Q&A>
  **Output path:** <absolute path to .plan-review.json>

  Review for alignment with requirements AND adversarial risks.
  Write findings JSON to output_path using Write tool.
  """
)
```

**Wait for results:**

**Preferred:** Use `spec_wait_file` MCP tool with `file_path` and `timeout_seconds`.

```bash
OUTPUT_PATH="<plan-review-json-path>"
for i in $(seq 1 30); do [ -f "$OUTPUT_PATH" ] && echo "READY" && break; sleep 10; done
```

Then Read the file once. Fix findings: must_fix → should_fix immediately.

### Step 1.8: Get User Approval

**⛔ If `SENTINAL_PLAN_APPROVAL_ENABLED` is `"false"`,** skip: set `Approved: Yes` automatically and invoke `Skill(skill='spec-implement', args='<plan-path>')`.

**When enabled:**

1. Summarize: goal, key tasks, approach
2. AskUserQuestion: "Yes, proceed" or "No, I need to make changes"
3. **If "Yes":** Set `Approved: Yes`, invoke `Skill(skill='spec-implement', args='<plan-path>')`
4. **If "No":** Tell user to edit plan, wait for "ready", re-read, ask again

ARGUMENTS: $ARGUMENTS
