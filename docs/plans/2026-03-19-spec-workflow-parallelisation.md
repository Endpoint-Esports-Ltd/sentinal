# Spec Workflow Parallelisation Implementation Plan

Created: 2026-03-19
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Summary

**Goal:** Update spec workflow skills to plan tasks with explicit dependency waves for parallel execution, and update spec-implement to execute independent tasks concurrently via Agent tool with worktree isolation.
**Architecture:** Three-layer change: (1) spec-plan adds wave grouping to task structure, (2) spec-implement gains parallel execution engine using Agent tool with worktree isolation for independent tasks, (3) spec-master-plan/execute already have waves — align terminology. Both Claude Code (`targets/claude-code/commands/`) and OpenCode (`targets/opencode/skills/*/SKILL.md`) targets updated in lockstep. Templates updated to match.
**Tech Stack:** Markdown skill files only — no code changes.

## Scope

### In Scope

- `spec-plan` (both targets): Add wave/dependency grouping to Step 1.5 task planning + plan template
- `spec-implement` (both targets): Add parallel execution engine for independent tasks using Agent with worktree isolation
- `spec-master-plan` (both targets): Minor alignment — ensure child plan stubs inherit wave concepts
- `spec-master-execute` (both targets): Minor alignment — ensure subagent spawning uses worktree isolation
- `spec-verify` (both targets): No parallelism changes (user chose sequential verification)
- Templates (`templates/commands/`): Update simplified versions to reflect structural changes
- `spec.md` dispatcher: No changes needed (routing logic unchanged)
- **Cross-platform parity:** Claude Code commands (`targets/claude-code/commands/*.md`) and OpenCode skills (`targets/opencode/skills/*/SKILL.md`) are nearly identical — all changes apply to both

### Out of Scope

- Bugfix plan/verify/implement skills — intentionally sequential, no wave changes (per user clarification)
- Code changes (no `.ts` files modified)
- Verification parallelism (user chose sequential)

## Context for Implementer

> Write for an implementer who has never seen the codebase.

- **Patterns to follow:**
  - Existing wave structure in `targets/claude-code/commands/spec-master-plan.md:111-119` (Wave section format)
  - Existing `Task()` spawning in `targets/claude-code/commands/spec-master-execute.md:93-111` — note: uses `Task(subagent_type="general", ...)`, NOT `Agent()`. Task 3 must replace this with `Agent(isolation="worktree", ...)`
  - Task structure in `targets/claude-code/commands/spec-plan.md:165-190` (current task template)

- **Conventions:**
  - Sentinal is a cross-assistant tool — Claude Code and OpenCode must have feature parity
  - Claude Code skills live at `targets/claude-code/commands/<skill>.md`
  - OpenCode skills live at `targets/opencode/skills/<skill>/SKILL.md`
  - The two targets are nearly identical — only differences: frontmatter format (CC has `model:`, `user-invocable:`; OC has `name:`) and minor casing (`LSP` vs `lsp` in spec-implement)
  - Templates at `templates/commands/` are simplified versions with `{{ description }}` placeholders
  - `Skill()` invocations use single quotes: `Skill(skill='spec-implement', args='<plan-path>')`

- **Key files (Claude Code + OpenCode pairs):**
  - `targets/claude-code/commands/spec-plan.md` + `targets/opencode/skills/spec-plan/SKILL.md`
  - `targets/claude-code/commands/spec-implement.md` + `targets/opencode/skills/spec-implement/SKILL.md`
  - `targets/claude-code/commands/spec-master-plan.md` + `targets/opencode/skills/spec-master-plan/SKILL.md`
  - `targets/claude-code/commands/spec-master-execute.md` + `targets/opencode/skills/spec-master-execute/SKILL.md`
  - `targets/claude-code/commands/spec-verify.md` + `targets/opencode/skills/spec-verify/SKILL.md` (no changes — stays sequential)
  - `templates/commands/spec-plan.md` — Simplified planning template (83 lines)
  - `templates/commands/spec-implement.md` — Simplified implementation template (75 lines)

- **Gotchas:**
  - Templates use `{{ description }}` placeholder in frontmatter — don't replace with actual descriptions
  - `spec-verify.md` is 433 lines — already at limit, no additions allowed (and none needed — stays sequential)
  - Agent with `isolation: "worktree"` creates a temporary git worktree — the agent gets an isolated repo copy
  - Plans must be reinstalled after changes via `sentinal install claude` + rebuild
  - **OpenCode frontmatter differs:** uses `name:` field instead of `model:` and `user-invocable:`. Preserve each target's frontmatter format when editing.
  - **OpenCode LSP casing:** uses lowercase `lsp()` instead of `LSP()` — preserve this when mirroring changes to spec-implement

- **Domain context:**
  - The spec workflow is: `/spec` dispatcher → planning skill → implementation skill → verification skill
  - Skills are markdown instructions loaded as system prompts — they guide Claude's behavior
  - "Waves" = groups of tasks that can execute in parallel. Wave N+1 starts after all Wave N tasks complete.
  - The Agent tool with `isolation: "worktree"` gives each subagent its own copy of the repo to avoid file conflicts

## Assumptions

- **Claude Code** supports `Agent(isolation="worktree")` for per-agent worktree isolation — Task 2 depends on this
- **OpenCode** uses `Task(subagent_type="general")` without per-task isolation; parallel tasks share the same working directory — Task 2 depends on this
- Plans with wave annotations are backward-compatible — existing plans without waves still work — Tasks 1, 2 depend on this
- The model executing spec-implement can correctly parse wave groupings from the plan file — Task 2 depends on this
- Worktree-based agents (Claude Code) can merge their changes back without conflicts when tasks truly don't share files — Task 2 depends on this
- Non-isolated parallel tasks (OpenCode) won't conflict because wave planning ensures tasks don't share files — Task 2 depends on this

## Testing Strategy

- **Manual:** Run `/spec` on a sample task after changes, verify plan includes wave groupings, verify implementation attempts parallel execution for Wave 1 tasks
- **Review:** Read through each modified skill file to confirm instructions are clear and unambiguous

## Risks and Mitigations

| Risk                                            | Likelihood | Impact | Mitigation                                                                                             |
| ----------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------ |
| Worktree Agent merges cause conflicts           | Medium     | High   | Plan explicitly states parallel tasks MUST NOT share files; implementer validates this during planning |
| Model ignores wave annotations                  | Low        | Medium | Instructions are explicit with examples; wave parsing is simple (read plan, group by wave)             |
| Parallel agents diverge from plan               | Medium     | Medium | Each agent gets the full plan as context; main orchestrator validates completion                       |
| Parallel agents concurrently update plan file   | Medium     | High   | Agent prompt explicitly says NOT to update checkboxes; orchestrator does it after wave completion      |
| Nested worktree from session worktree (CC only) | Low        | Medium | Agent isolation creates worktrees from repo root; pre-parallel commit checkpoint documented            |
| OpenCode parallel file conflicts (no isolation) | Medium     | High   | Wave planning enforces no shared files; OpenCode safety note emphasizes this constraint                |
| Backward incompatibility with existing plans    | Low        | Low    | Wave section is optional; old plans without waves execute sequentially (default behavior)              |

## Pre-Mortem

_Assume this plan failed. Most likely internal reasons:_

1. **Wave annotations are too complex for the planning model to generate consistently** (Task 1) — Trigger: Plans produced after the change don't include `## Execution Waves` section or have incorrect dependency analysis
2. **Parallel Agent execution instructions are ambiguous** (Task 2) — Trigger: spec-implement model falls back to sequential execution even when waves are present, or spawns agents without worktree isolation
3. **Merge conflicts from parallel worktree agents** (Task 2) — Trigger: Two agents modify the same file despite wave planning saying they shouldn't

## Goal Verification

### Truths

1. `targets/claude-code/commands/spec-plan.md` contains `## Execution Waves` in the plan template section
2. `targets/claude-code/commands/spec-plan.md` contains instructions for grouping tasks by dependency wave
3. `targets/claude-code/commands/spec-implement.md` contains `isolation: "worktree"` in Agent spawning instructions
4. `targets/claude-code/commands/spec-implement.md` contains wave-based parallel execution loop
5. `targets/claude-code/commands/spec-master-plan.md` contains note about child plans including `## Execution Waves`
6. `targets/claude-code/commands/spec-master-execute.md` contains `Agent` with `isolation` and `worktree` (replacing old `Task` calls)
7. `targets/opencode/skills/spec-plan/SKILL.md` contains `## Execution Waves` (parity with Claude Code)
8. `targets/opencode/skills/spec-implement/SKILL.md` contains wave execution loop with `Task(subagent_type="general"`, Step 2.2c wave parsing, single-task fallback, and orchestrator-updates-checkboxes rule
9. `targets/opencode/skills/spec-master-execute/SKILL.md` retains `Task(subagent_type="general"` (OpenCode keeps existing pattern)
10. `targets/opencode/skills/spec-master-plan/SKILL.md` contains note about child plans including `## Execution Waves` (parity with Truth 5)
11. `templates/commands/spec-plan.md` contains wave grouping concept
12. `templates/commands/spec-implement.md` contains parallel execution concept

### Artifacts

| Artifact                                               | Provides                                        | Exports                                          |
| ------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------ |
| `targets/claude-code/commands/spec-plan.md`            | Wave-aware task planning instructions           | Plan template with `## Execution Waves`          |
| `targets/claude-code/commands/spec-implement.md`       | Parallel execution engine instructions          | Agent-based wave execution loop                  |
| `targets/claude-code/commands/spec-master-plan.md`     | Note for child plans to include execution waves | `## Execution Waves` reference                   |
| `targets/claude-code/commands/spec-master-execute.md`  | Aligned worktree isolation for subagents        | `Agent(isolation="worktree")` replacing `Task()` |
| `targets/opencode/skills/spec-plan/SKILL.md`           | OpenCode parity: wave-aware planning            | Same as CC spec-plan                             |
| `targets/opencode/skills/spec-implement/SKILL.md`      | OpenCode parity: parallel execution             | Same as CC spec-implement                        |
| `targets/opencode/skills/spec-master-plan/SKILL.md`    | OpenCode parity: child plan wave note           | Same as CC spec-master-plan                      |
| `targets/opencode/skills/spec-master-execute/SKILL.md` | OpenCode parity: worktree isolation             | Same as CC spec-master-execute                   |
| `templates/commands/spec-plan.md`                      | Simplified wave-aware planning                  | Plan template with waves                         |
| `templates/commands/spec-implement.md`                 | Simplified parallel execution                   | Wave-based execution concept                     |

### Key Links

| From              | To                | Via                     | Pattern                       |
| ----------------- | ----------------- | ----------------------- | ----------------------------- |
| spec-plan.md      | Plan template     | Execution Waves section | `## Execution Waves`          |
| spec-implement.md | Agent tool        | Worktree isolation      | `isolation.*worktree`         |
| spec-implement.md | Plan file         | Wave parsing            | `Wave \d+`                    |
| spec-plan.md      | spec-implement.md | Wave structure          | Tasks grouped by wave in both |

## Progress Tracking

- [x] Task 1: Add wave grouping to spec-plan
- [x] Task 2: Add parallel execution to spec-implement
- [x] Task 3: Align spec-master-plan and spec-master-execute
- [x] Task 4: Update simplified templates
      **Total Tasks:** 4 | **Completed:** 4 | **Remaining:** 0

## Execution Waves

**Wave 1** — Core changes (parallel): Tasks 1 and 2 modify different files (spec-plan.md vs spec-implement.md), can be done independently.
**Wave 2** — Alignment (parallel): Tasks 3 and 4 depend on the patterns established in Wave 1, but are independent of each other.

## Implementation Tasks

### Task 1: Add Wave Grouping to spec-plan

**Objective:** Update spec-plan (both targets) to instruct the planning model to group tasks into dependency-based execution waves and include an `## Execution Waves` section in generated plans.
**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `targets/claude-code/commands/spec-plan.md`
- Modify: `targets/opencode/skills/spec-plan/SKILL.md` (mirror same changes, preserve OC frontmatter)

**Key Decisions / Notes:**

- In **Step 1.5 (Implementation Planning)**, add instructions after the task structure template:
  - After defining all tasks, analyze dependencies to group tasks into waves
  - Wave 1 = tasks with no dependencies, Wave 2 = tasks depending only on Wave 1, etc.
  - Tasks in the same wave MUST NOT modify the same files (required for worktree isolation)
  - Add a constraint: if two tasks in the same wave share files, move one to the next wave
- Add to the **task structure template** a `**Wave:**` field alongside `**Dependencies:**`
- In **Step 1.6 (Write Full Plan)**, add `## Execution Waves` section to the plan template between `## Pre-Mortem` and `## Goal Verification`:

  ```markdown
  ## Execution Waves

  **Wave 1** — [label] (parallel): [rationale]
  **Wave 2** — [label] (parallel): [rationale]
  ```

- Update **Progress Tracking** format to show wave assignments:
  ```markdown
  - [ ] Task 1: [summary] (Wave 1)
  - [ ] Task 2: [summary] (Wave 1)
  - [ ] Task 3: [summary] (Wave 2)
  ```
- Add a validation rule: "If all tasks are in Wave 1 (no dependencies), that's fine — it means maximum parallelism"
- Add a fallback rule: "If wave analysis is unclear, default to sequential (each task in its own wave)"

**Definition of Done:**

- [ ] Step 1.5 contains wave grouping instructions with file-overlap constraint
- [ ] Task structure template includes `**Wave:**` field
- [ ] Step 1.6 plan template includes `## Execution Waves` section
- [ ] Progress Tracking format shows wave assignments
- [ ] Backward compatibility note: plans without waves default to sequential
- [ ] OpenCode `targets/opencode/skills/spec-plan/SKILL.md` has identical changes (minus frontmatter)

**Verify:**

- Read `targets/claude-code/commands/spec-plan.md` and confirm all sections present
- Read `targets/opencode/skills/spec-plan/SKILL.md` and confirm parity

### Task 2: Add Parallel Execution to spec-implement

**Objective:** Update spec-implement (both targets) to parse execution waves from the plan and execute independent tasks concurrently using Agent tool with worktree isolation.
**Dependencies:** None (can reference the wave format independently)
**Wave:** 1

**Files:**

- Modify: `targets/claude-code/commands/spec-implement.md`
- Modify: `targets/opencode/skills/spec-implement/SKILL.md` (mirror same changes, preserve OC frontmatter + lowercase `lsp()`)

**Key Decisions / Notes:**

- Replace the current sequential "TDD Loop (per task)" approach with a wave-based execution model
- Add a new **Step 2.2c: Parse Execution Waves** after Step 2.2b:
  - Read the plan's `## Execution Waves` section
  - If no `## Execution Waves` section exists: skip wave-based execution entirely and fall back to the original sequential per-task TDD loop (legacy path). Do NOT assign all tasks to Wave 1.
  - If waves section exists: group uncompleted tasks by wave number
- Modify **Step 2.3: TDD Loop** to become **Step 2.3: Wave Execution Loop**:
  - For each wave (1, 2, 3, ...):
    - If wave has 1 task: execute directly in main context (existing TDD loop)
    - If wave has 2+ tasks: spawn parallel Agents with worktree isolation
    - Wait for all agents in wave to complete
    - Validate all tasks completed successfully
    - Update plan checkboxes for completed tasks (Step 2.4)
    - Proceed to next wave
- **Worktree nesting consideration (Claude Code only):** spec-implement Step 2.1b may have already `cd`'d into a session worktree. `Agent(isolation="worktree")` creates worktrees from the repo root, NOT from cwd. Add a note: "Before spawning parallel agents, commit all pending changes in the session worktree (`git add . && git commit -m 'wip: pre-parallel checkpoint'`). This ensures agents fork from a state that includes all prior task work."
- **Platform-specific agent spawning patterns:**
  - **Claude Code** — use `Agent(isolation="worktree")`:

    ```
    Agent(
      description="Implement Task N: <title>",
      isolation="worktree",
      prompt="""
      You are implementing a single task from a spec plan using TDD.

      **Plan file:** <plan-path>
      **Your task:** Task N: <title>
      **Task details:** [paste full task section from plan]

      Follow TDD: RED (failing test) → GREEN (minimal impl) → REFACTOR
      Use quality_report MCP tool after edits.
      Do NOT update the plan file checkboxes — the orchestrator will do this after the wave completes.
      """
    )
    ```

  - **OpenCode** — use `Task(subagent_type="general")` (no per-task isolation, tasks share working directory):

    ```
    Task(
      subagent_type="general",
      prompt="""
      You are implementing a single task from a spec plan using TDD.

      **Plan file:** <plan-path>
      **Your task:** Task N: <title>
      **Task details:** [paste full task section from plan]

      Follow TDD: RED (failing test) → GREEN (minimal impl) → REFACTOR
      Use quality_report MCP tool after edits.
      Do NOT update the plan file checkboxes — the orchestrator will do this after the wave completes.
      """
    )
    ```

  - **OpenCode safety note:** Since parallel tasks share the same directory (no worktree isolation), the file-overlap constraint in wave planning is even more critical. If two parallel tasks write to the same file, they will corrupt each other's changes.

- **Plan file update rule:** Parallel agents must NOT update plan checkboxes (concurrent writes cause merge conflicts on the plan file). The orchestrating main context updates all checkboxes after each wave completes.
- Add merge step after each wave: agents in worktree isolation auto-merge if they made changes
- Keep the existing constraint "NO sub-agents" but modify it: sub-agents are now allowed ONLY for parallel wave execution (not for research or other purposes)
- Keep Step 2.4 (Update Plan After EACH Task) — for single-task waves, update inline; for multi-task waves, orchestrator updates all checkboxes after wave completion
- Add error handling: if any agent in a wave fails, report the failure, ask user how to proceed (retry / skip / stop)

**Definition of Done:**

- [ ] Step 2.2c exists with wave parsing logic
- [ ] Step 2.3 is wave-based with parallel spawning
- [ ] Claude Code version uses `Agent(isolation="worktree")`
- [ ] OpenCode version uses `Task(subagent_type="general")` (no per-task isolation)
- [ ] Both versions: agent/task prompt does NOT update plan checkboxes; orchestrator updates after wave completion
- [ ] Single-task waves still execute in main context (both platforms)
- [ ] Backward compat: plans without waves bypass wave loop entirely (legacy sequential path)
- [ ] Error handling for agent/task failures documented
- [ ] Claude Code "NO sub-agents" constraint updated to allow Agents for parallel wave execution
- [ ] OpenCode "NO sub-agents" constraint updated to allow Task() calls for parallel wave execution
- [ ] OpenCode `targets/opencode/skills/spec-implement/SKILL.md` has equivalent changes with `Task()` pattern

**Verify:**

- Read `targets/claude-code/commands/spec-implement.md` and confirm wave execution structure
- Read `targets/opencode/skills/spec-implement/SKILL.md` and confirm parity

### Task 3: Align spec-master-plan and spec-master-execute

**Objective:** Update master plan skills (both targets) to use worktree isolation for subagents and align wave terminology with the feature plan wave concept.
**Dependencies:** Task 1, Task 2 (uses patterns from both)
**Wave:** 2

**Files:**

- Modify: `targets/claude-code/commands/spec-master-execute.md`
- Modify: `targets/claude-code/commands/spec-master-plan.md` (minor)
- Modify: `targets/opencode/skills/spec-master-execute/SKILL.md` (mirror execute changes)
- Modify: `targets/opencode/skills/spec-master-plan/SKILL.md` (mirror plan changes)

**Key Decisions / Notes:**

- In `spec-master-execute.md` (Claude Code version):
  - The Claude Code file currently uses `Task(subagent_type="general", ...)` at lines 93-111. **Replace** with `Agent(isolation="worktree")`:
    ```
    Agent(
      description="Execute Phase N: <title>",
      isolation="worktree",
      prompt="""..."""
    )
    ```
  - The Agent prompt structure should match the existing Task prompt content
  - Add note: child plan execution in worktree isolation means each phase gets clean repo state
- In `spec-master-execute/SKILL.md` (OpenCode version):
  - Keep the existing `Task(subagent_type="general", ...)` pattern (OpenCode doesn't support `Agent()`)
  - Add note about wave-level parallelism via multiple `Task()` calls in one message (already present)
  - No isolation change needed — OpenCode already works this way
- Keep existing wave semantics in both (they already have waves)
- In `spec-master-plan.md`:
  - Add a note in Step 1.5 (Master Plan Structure) under the Phases section: "Each child plan should include an `## Execution Waves` section to enable parallel task execution within that phase"
  - No structural changes needed — master plans already have waves at the phase level

**Definition of Done:**

- [ ] Claude Code `spec-master-execute.md` uses `Agent(isolation="worktree")` instead of `Task(subagent_type="general")`
- [ ] OpenCode `spec-master-execute/SKILL.md` keeps `Task()` pattern (no isolation change needed)
- [ ] Both `spec-master-plan` files contain note about child plans including `## Execution Waves`
- [ ] Existing wave semantics preserved in both platforms

**Verify:**

- Read Claude Code files and confirm `isolation: "worktree"` present in execute, wave note in plan
- Read OpenCode files and confirm parity

### Task 4: Update Simplified Templates

**Objective:** Update the simplified template versions to reflect wave grouping and parallel execution concepts.
**Dependencies:** Task 1, Task 2 (mirrors their changes)
**Wave:** 2

**Files:**

- Modify: `templates/commands/spec-plan.md`
- Modify: `templates/commands/spec-implement.md`

**Key Decisions / Notes:**

- Templates are simplified versions — add the concepts but not the full detail
- In `templates/commands/spec-plan.md`:
  - Add `## Execution Waves` to the plan template in Phase 3
  - Add `**Wave:**` to the task structure
  - Add brief instruction about grouping independent tasks into waves
- In `templates/commands/spec-implement.md`:
  - Update the TDD Loop section to mention wave-based execution
  - Reference parallel execution generically: "spawn parallel subagents per wave" — do NOT name `Agent()` or `Task()` specifically (templates are platform-neutral; platform-specific tool names belong only in `targets/` files)
  - Keep it concise (templates are ~80 lines)
- `templates/commands/spec-verify.md` — NO changes (verification stays sequential)

**Definition of Done:**

- [ ] `templates/commands/spec-plan.md` includes wave concepts
- [ ] `templates/commands/spec-implement.md` includes parallel execution concept
- [ ] Template does not mention `Agent()` or `Task()` by name (platform-neutral)
- [ ] Templates remain concise (under 100 lines each)
- [ ] `{{ description }}` placeholders preserved in frontmatter

**Verify:**

- Read both template files and confirm wave/parallel concepts present
- Confirm both template files are under 100 lines after edits
