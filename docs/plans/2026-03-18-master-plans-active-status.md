# Master Plans & Active Status Implementation Plan

Created: 2026-03-18
Status: COMPLETE
Approved: Yes
Iterations: 1
Worktree: No
Type: Feature

## Summary

**Goal:** Fix the plan status lifecycle so active plans use `IN_PROGRESS` instead of the overloaded `PENDING+Approved:Yes`, and introduce master plans that can spawn parallel child plan execution via waves — with architecture diagrams, overarching goals, and high-level context in the master plan while child plans contain specific implementation tasks.

**Architecture:** Two independent but complementary changes: (1) Wire `IN_PROGRESS` into the spec-implement skill, dispatcher, stop guard, and prompt-context so the active implementation phase has its own status. (2) Add `Type: Master` plans with a `## Phases` section listing child plans organized into waves, a new `spec-master-plan` skill for creating master plans, and a new `spec-master-execute` skill that processes waves sequentially and spawns subagents per child plan within each wave.

**Tech Stack:** TypeScript (Bun), Sentinal spec parser, MCP tools, Claude Code/OpenCode skill files, subagent orchestration.

## Scope

### In Scope

- **Status lifecycle:** Set `IN_PROGRESS` when spec-implement begins; update dispatcher, stop guard, prompt-context, and all skill files
- **Master plan type:** New `Type: Master` with `Parent:` and `Wave:` metadata fields in parser
- **Master plan format:** Architecture diagrams, overarching goal, high-level context, `## Phases` section with wave assignments
- **Child plan format:** Regular plans with `Parent:` and `Wave:` header fields
- **Master plan skill:** `spec-master-plan` for creating master plans with phases
- **Master execution skill:** `spec-master-execute` that processes waves sequentially, spawning subagents per child plan
- **Dispatcher routing:** `Type: Master` routes to appropriate master skills
- **findActivePlan changes:** Master plans detected and tracked alongside child plans

### Out of Scope

- Full GSD-style hierarchy (Milestones, REQUIREMENTS.md, ROADMAP.md, STATE.md, .planning/ directory)
- Research/context phases per GSD workflow
- Checkpoint/human-verify tasks within subagent execution
- UI dashboard changes for master plan visualization
- Migration of existing plans to new format

## Context for Implementer

> Write for an implementer who has never seen the codebase.

- **Patterns to follow:**
  - Spec types: `src/spec/types.ts:12-52` — `SPEC_STATUSES`, `ACTIVE_STATUSES`, `TERMINAL_STATUSES`, `SpecType`
  - Plan parser: `src/spec/parser.ts:79-113` — `extractMetadata()` parses first 20 lines for `Key: Value` fields
  - Status detection: `src/spec/detect.ts:25-62` — `findActivePlan()` scans `docs/plans/`, `shouldBlockStop()` gates stopping
  - MCP tools: `src/spec/mcp-tools.ts:60-112` — `spec_register` with status override via regex replace
  - Skill files: `targets/opencode/skills/spec-implement/SKILL.md` and `targets/claude-code/commands/spec-implement.md` — identical content
  - Dispatcher: `targets/opencode/commands/spec.md` and `targets/claude-code/commands/spec.md` — Section 0.2 routing table

- **Conventions:**
  - Skill/command files are maintained in `targets/` (source of truth) and embedded via `bun run embed-assets`
  - Claude Code commands go in `targets/claude-code/commands/<name>.md`
  - OpenCode skills go in `targets/opencode/skills/<name>/SKILL.md`
  - Both must have identical content
  - Parser only scans first 20 lines for metadata (beyond that is plan body)
  - `IN_PROGRESS` already exists in `SPEC_STATUSES` and `ACTIVE_STATUSES` — no type changes needed

- **Key files:**
  - `src/spec/types.ts` — Status/type definitions, ACTIVE_STATUSES (40 lines)
  - `src/spec/parser.ts` — Plan file parser, metadata extraction (378 lines)
  - `src/spec/detect.ts` — findActivePlan, shouldBlockStop (62 lines)
  - `src/spec/store.ts` — SpecStore SQLite operations (includes spec_tasks table)
  - `src/spec/mcp-tools.ts` — spec_register, spec_status, spec_plan_parse MCP tools
  - `src/hooks/spec-stop-guard.ts` — Stop guard hook (17 lines)
  - `src/hooks/prompt-context.ts` — UserPromptSubmit context injection
  - `targets/*/commands/spec.md` — Dispatcher (Section 0.2 routing table)
  - `targets/*/commands/spec-implement.md` / `targets/*/skills/spec-implement/SKILL.md` — Implementation skill
  - `targets/*/commands/spec-plan.md` / `targets/*/skills/spec-plan/SKILL.md` — Planning skill

- **Gotchas:**
  - `IN_PROGRESS` is already in `ACTIVE_STATUSES` but the dispatcher has no row for it — must add
  - Parser `normalizeStatus()` already recognizes `IN_PROGRESS` — no parser change needed for status
  - The parser's `extractMetadata()` only scans for specific keys — `Parent` and `Wave` must be added to the regex
  - `SpecType` is currently `"feature" | "bugfix"` — must add `"master"`
  - `findActivePlan()` returns the first active plan (newest date first) — with master+child plans, multiple active plans may exist; need to decide precedence
  - `shouldBlockStop()` only checks status, not type — master plans in PENDING should still block
  - All skill files exist in TWO locations (claude-code + opencode) — both must be updated identically
  - After modifying targets/, run `bun run embed-assets` to rebuild `src/cli/embedded-assets.ts`

- **Domain context:**
  - A "master plan" is a high-level plan that contains architecture, goals, and phase organization but NO implementation tasks
  - "Phases" are child plans — regular Sentinal plans with tasks, linked to a master via `Parent:` header
  - "Waves" are groups of phases that can execute in parallel. Wave 1 runs first, then Wave 2, etc. Within a wave, all phases execute concurrently via subagents
  - The master plan's status tracks overall progress. Child plans have independent statuses.

## Assumptions

- `IN_PROGRESS` status works correctly with `findActivePlan()` — supported by `ACTIVE_STATUSES` array including it — Tasks 1-3 depend on this
- The spec parser's `extractMetadata()` can be extended to parse `Parent:` and `Wave:` without breaking existing plans — supported by the regex approach that only matches known keys — Tasks 5-6 depend on this
- Claude Code's `Task()` tool supports spawning multiple subagents within the same wave — supported by existing subagent usage in spec-plan (plan-reviewer) and spec-verify (spec-reviewer) — Tasks 8-9 depend on this
- `SpecType` can be extended to `"master"` without breaking existing dispatch logic — supported by the dispatcher checking type explicitly in the routing table — Tasks 4, 7-9 depend on this

## Testing Strategy

- **Unit tests:** Parser tests for new `Parent:`, `Wave:`, `Type: Master` fields; stop guard tests for `IN_PROGRESS` behavior; findActivePlan tests with master+child plans; prompt-context tests for IN_PROGRESS display
- **Integration tests:** `spec_register` with IN_PROGRESS status override; spec_plan_parse with master plan format
- **Manual verification:** End-to-end master plan creation and wave execution

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Multiple active plans confuse findActivePlan | Medium | High | Master plans take precedence; child plans are found via parent link, not independent scan |
| Subagent spawning fails mid-wave | Low | Medium | Wave execution is resumable — skip child plans already at VERIFIED status |
| IN_PROGRESS breaks existing plan workflows | Low | Low | IN_PROGRESS was already in ACTIVE_STATUSES; only new code sets it |
| Master plan format too rigid | Medium | Medium | Keep it minimal — just phases section with wave assignments, no complex YAML frontmatter |

## Pre-Mortem

_Assume this plan failed. Most likely internal reasons:_

1. **findActivePlan returns child plan instead of master** (Tasks 5-6) → Trigger: When a master plan has IN_PROGRESS children, `findActivePlan()` might return a child plan (alphabetically later) instead of the master. The stop guard and prompt-context would show child plan status, confusing the user. Mitigated: add `Type: Master` plans at higher priority in findActivePlan, or have child plans be invisible to findActivePlan when their parent is active.

2. **Wave execution loses context after compaction** (Task 9) → Trigger: During a long wave execution, auto-compaction clears the master plan state. The orchestrator doesn't know which waves completed. Mitigated: master plan's `## Phases` section has checkboxes that get updated per child plan completion, and spec_register syncs state to SQLite.

3. **Dispatcher routing ambiguity with master plans** (Task 7) → Trigger: A master plan at `PENDING + Approved: Yes` should route to `spec-master-execute` not `spec-implement`. But the dispatcher currently routes by (Status, Approved, Type) — if the master type check is missed, it goes to regular implementation. Mitigated: check Type before Status in the routing logic.

## Goal Verification

### Truths

1. When spec-implement starts, the plan status changes from PENDING to IN_PROGRESS (observable in the plan file header)
2. The dispatcher correctly routes IN_PROGRESS plans back to spec-implement (for resume after compaction)
3. The stop guard does NOT block on IN_PROGRESS status
4. The prompt-context shows "IN_PROGRESS" (not "PENDING") during active implementation
5. A master plan with Type: Master can be created with architecture, goals, and phase listings
6. Child plans linked via Parent: header are executed by subagents during master plan execution
7. Waves execute sequentially — Wave 2 does not start until all Wave 1 child plans are VERIFIED
8. Within a wave, child plans execute in parallel via separate subagents

### Artifacts

| Truth | Supporting Artifact |
|-------|-------------------|
| 1 | Modified `spec-implement` skill (both targets) |
| 2 | Modified `spec.md` dispatcher (both targets) |
| 3 | `src/spec/detect.ts` — `shouldBlockStop()` unchanged for IN_PROGRESS |
| 4 | Modified `src/hooks/prompt-context.ts` — shows current status |
| 5 | New `spec-master-plan` skill (both targets) |
| 6 | Modified parser — `Parent:`, `Wave:` fields; new `spec-master-execute` skill |
| 7-8 | New `spec-master-execute` skill with wave-sequential, phase-parallel logic |

### Key Links

- `spec-implement` skill → `spec_register` MCP tool → plan file status regex replace
- `spec.md` dispatcher → `findActivePlan()` → `parsePlanFile()` → `normalizeStatus()`
- `spec-master-execute` skill → `Task()` subagent spawning → child `spec-implement` → `spec-verify`
- Parser `extractMetadata()` → `Parent:` / `Wave:` fields → `Spec` type → `SpecStore`

## Progress Tracking

- [x] Task 1: Wire IN_PROGRESS status into spec-implement skill
- [x] Task 2: Update dispatcher routing table for IN_PROGRESS
- [x] Task 3: Update prompt-context for IN_PROGRESS display
- [x] Task 4: Add Master type to spec types and parser
- [x] Task 5: Add Parent and Wave metadata fields to parser
- [x] Task 6: Create spec-master-plan skill
- [x] Task 7: Update dispatcher for Master plan routing (combined with Task 2)
- [x] Task 8: Create spec-master-execute skill
- [x] Task 9: Embedded assets rebuild and integration test

**Total Tasks:** 9 | **Completed:** 9 | **Remaining:** 0

## Implementation Tasks

### Task 1: Wire IN_PROGRESS Status into spec-implement Skill

**Objective:** When spec-implement begins working on a plan, set its status to `IN_PROGRESS` via `spec_register`. This replaces the ambiguous `PENDING + Approved: Yes` state during active implementation.

**Dependencies:** None

**Files:**

- Modify: `targets/opencode/skills/spec-implement/SKILL.md`
- Modify: `targets/claude-code/commands/spec-implement.md`
- Modify: `src/hooks/spec-stop-guard.test.ts`

**Key Decisions / Notes:**

- Add a new step after Step 2.1 (Read Plan) and before Step 2.2 (Set Up Task List):
  ```
  ### Step 2.1c: Set Active Status
  Set `Status: IN_PROGRESS` in the plan file.
  **Preferred:** Use `spec_register` MCP tool with `plan_path` and `status: "IN_PROGRESS"`.
  **Fallback:** `sentinal register-plan "<plan_path>" "IN_PROGRESS" 2>/dev/null || true`
  ```
- Both skill files (opencode + claude-code) must be updated identically
- The stop guard already does NOT block on IN_PROGRESS (falls through to `return null`), so no stop guard code change needed — but add a test to confirm this behavior explicitly
- When verification fails and loops back to spec-implement, the status goes PENDING → IN_PROGRESS again (via spec-implement's new step)

**Definition of Done:**

- [ ] Both spec-implement skill files include Step 2.1c setting IN_PROGRESS
- [ ] spec-stop-guard.test.ts has explicit test for IN_PROGRESS not blocking
- [ ] All existing tests pass

**Verify:**

- `bun test src/hooks/spec-stop-guard.test.ts`

---

### Task 2: Update Dispatcher Routing Table for IN_PROGRESS

**Objective:** Add `IN_PROGRESS` row to the dispatcher's Section 0.2 routing table so resumed plans at IN_PROGRESS status correctly route to spec-implement.

**Dependencies:** Task 1

**Files:**

- Modify: `targets/opencode/commands/spec.md`
- Modify: `targets/claude-code/commands/spec.md`

**Key Decisions / Notes:**

- Add to the Section 0.2 table:
  ```
  | IN_PROGRESS | * | Feature/absent | `spec-implement` |
  | IN_PROGRESS | * | Bugfix         | `spec-implement` |
  | IN_PROGRESS | * | Master         | `spec-master-execute` |
  ```
- IN_PROGRESS always routes to implementation (or master execution for master plans)
- The Approved field is irrelevant for IN_PROGRESS — a plan can only reach IN_PROGRESS if it was previously approved

**Definition of Done:**

- [ ] Both dispatcher files include IN_PROGRESS routing rows
- [ ] Master type routing included (for Task 7 forward-compatibility)

**Verify:**

- Manual: read both dispatcher files and confirm routing table is correct

---

### Task 3: Update prompt-context for IN_PROGRESS Display

**Objective:** Ensure the `buildSpecContext()` function correctly displays `IN_PROGRESS` status in the UserPromptSubmit context injection, providing clear state awareness during implementation.

**Dependencies:** Task 1

**Files:**

- Modify: `src/hooks/prompt-context.ts` (if needed)
- Modify: `src/hooks/prompt-context.test.ts`

**Key Decisions / Notes:**

- `buildSpecContext()` already displays `spec.status` dynamically — it will show `IN_PROGRESS` without code changes
- Add a test with an `IN_PROGRESS` plan to confirm the output includes "IN_PROGRESS"
- Also update the OpenCode plugin's compaction handler context format to show status correctly (already dynamic, just verify)

**Definition of Done:**

- [ ] Test added for IN_PROGRESS plan in prompt-context.test.ts
- [ ] Verified buildSpecContext shows "IN_PROGRESS" for active plans
- [ ] All tests pass

**Verify:**

- `bun test src/hooks/prompt-context.test.ts`

---

### Task 4: Add Master Type to Spec Types and Parser

**Objective:** Extend `SpecType` to include `"master"` and update the parser to recognize `Type: Master` plans.

**Dependencies:** None

**Files:**

- Modify: `src/spec/types.ts`
- Modify: `src/spec/parser.ts`
- Modify: `src/spec/parser.test.ts`
- Modify: `src/spec/detect.ts` (findActivePlan master-priority logic)
- Modify: `src/spec/detect.test.ts` or create if needed

**Key Decisions / Notes:**

- In `types.ts`: add `"master"` to the `SPEC_TYPES` const array: `export const SPEC_TYPES = ["feature", "bugfix", "master"] as const`. The `SpecType` type is derived from this array via `(typeof SPEC_TYPES)[number]`, so it updates automatically. The `SpecSchema` Zod enum also derives from this array.
- In `parser.ts` line ~40: update type normalization:
  ```typescript
  const type = meta.type?.toLowerCase() === "bugfix" ? "bugfix"
    : meta.type?.toLowerCase() === "master" ? "master"
    : "feature";
  ```
- Modify `findActivePlan()` in `detect.ts` to prioritize `Type: Master` plans when multiple active plans exist. Scan all active plans; if a master is found, return it. Otherwise return the most recent child. Add a unit test with master + child plans both active.
- Add parser tests for `Type: Master` plans
- Master plans should be valid with zero tasks (they have phases, not tasks)

**Definition of Done:**

- [ ] `"master"` added to `SPEC_TYPES` array (SpecType and SpecSchema derive automatically)
- [ ] Parser recognizes `Type: Master`
- [ ] `findActivePlan()` prioritizes master plans over child plans
- [ ] Parser test covers master type
- [ ] detect.ts test covers master+child plan coexistence
- [ ] No TypeScript errors

**Verify:**

- `bun test src/spec/parser.test.ts`

---

### Task 5: Add Parent and Wave Metadata Fields to Parser

**Objective:** Extend the parser to extract `Parent:` and `Wave:` fields from plan file headers, enabling child plans to link back to their master plan and declare their wave assignment.

**Dependencies:** Task 4

**Files:**

- Modify: `src/spec/types.ts`
- Modify: `src/spec/parser.ts`
- Modify: `src/spec/parser.test.ts`
- Modify: `src/spec/store.ts` (add parent/wave columns to specs table)

**Key Decisions / Notes:**

- In `types.ts`: add `parent: z.string().optional()` and `wave: z.number().int().optional()` to `SpecSchema`.
- In `store.ts`: add `parent TEXT` and `wave INTEGER` columns to the `specs` table schema. Update `syncFromPlanFile()` to persist these fields. Add a migration for existing databases (ALTER TABLE ADD COLUMN with defaults). The `Spec` type is `z.infer<typeof SpecSchema>` — it updates automatically.
- In `parser.ts` `extractMetadata()`: add `Parent` and `Wave` to the regex alternation:
  ```
  /^(Status|Type|Approved|Created|Iterations|Worktree|Parent|Wave):\s*(.+)$/i
  ```
- In `RawMetadata` interface: add `parent?: string` and `wave?: string`
- In `parsePlanContent()`: parse wave as integer: `const wave = meta.wave ? parseInt(meta.wave, 10) : undefined`
- Parent is the master plan's slug (filename without date prefix and .md extension), not a file path
- Add parser tests for plans with `Parent:` and `Wave:` fields
- Existing plans without these fields should continue to parse correctly (fields are optional)

**Definition of Done:**

- [ ] `SpecSchema` includes optional `parent` (string) and `wave` (int) fields (Spec type derives automatically)
- [ ] Parser extracts `Parent:` and `Wave:` from plan headers
- [ ] Parser tests cover plans with and without Parent/Wave fields
- [ ] Existing plan tests still pass
- [ ] No TypeScript errors

**Verify:**

- `bun test src/spec/parser.test.ts`

---

### Task 6: Create spec-master-plan Skill

**Objective:** Create a new skill for planning master plans — high-level plans that contain architecture, overarching goals, context, and a list of child phases organized into waves.

**Dependencies:** Tasks 4, 5

**Files:**

- Create: `targets/claude-code/commands/spec-master-plan.md`
- Create: `targets/opencode/skills/spec-master-plan/SKILL.md`

**Key Decisions / Notes:**

- The skill documents the master plan template format and guides the AI through creating one
- Master plan header includes `Type: Master`
- Master plan body includes:
  - `## Goal` — overarching objective (1-3 sentences)
  - `## Architecture` — Mermaid diagrams (primary format, rendered by GitHub) showing component relationships, data flow, and system boundaries. Example:
    ````
    ```mermaid
    graph TD
      A[Master Plan] --> B[Phase 1: Models]
      A --> C[Phase 2: APIs]
      B --> D[Phase 3: UI]
      C --> D
    ```
    ````
  - `## Context` — domain knowledge, constraints, key decisions that apply across all phases
  - `## Waves` — explanation of wave ordering and dependency rationale
  - `## Phases` — table listing each child plan with wave assignment, title, objective, dependencies
  - `## Progress Tracking` — checkboxes for each phase (not tasks)
- The skill creates the master plan file AND generates stub child plan files with `Parent:` and `Wave:` headers
- Child plans are created as PENDING + Approved: No — they need individual planning via spec-plan
- OR child plans can be created with full tasks if the scope is clear enough
- The skill uses the same question/exploration/review flow as spec-plan
- **Verification:** diff claude-code and opencode versions to confirm identical content

**Definition of Done:**

- [ ] Both skill files created with identical content
- [ ] Master plan template includes Goal, Architecture, Context, Waves, Phases sections
- [ ] Child plan stub generation with Parent/Wave fields
- [ ] Follows existing spec-plan patterns (questions, exploration, reviewer)

**Verify:**

- Manual: read both skill files, verify consistent format

---

### Task 7: Update Dispatcher for Master Plan Routing

**Objective:** Update the `/spec` dispatcher to detect `Type: Master` plans and route to appropriate skills.

**Dependencies:** Tasks 2, 6

**Files:**

- Modify: `targets/opencode/commands/spec.md`
- Modify: `targets/claude-code/commands/spec.md`

**Key Decisions / Notes:**

- Add Master-specific rows to Section 0.2 dispatch table:
  ```
  | PENDING     | No  | Master | `spec-master-plan`    |
  | PENDING     | Yes | Master | `spec-master-execute` |
  | IN_PROGRESS | *   | Master | `spec-master-execute` |
  | COMPLETE    | *   | Master | `spec-verify`         |
  ```
- Section 0.1.1 (Detect Type) needs a new bullet: "**Master:** Large multi-phase project, parallel execution needed"
- When a user says `/spec <task>` and the task clearly needs multiple phases, the dispatcher should ask if they want a master plan vs regular plan

**Definition of Done:**

- [ ] Both dispatcher files include Master plan routing rows
- [ ] Type detection includes Master option
- [ ] Routing table is complete and unambiguous

**Verify:**

- Manual: trace through dispatcher with each status/type combination

---

### Task 8: Create spec-master-execute Skill

**Objective:** Create the orchestrator skill that executes a master plan's child phases in wave order, spawning subagents per child plan within each wave for parallel execution.

**Dependencies:** Tasks 6, 7

**Files:**

- Create: `targets/claude-code/commands/spec-master-execute.md`
- Create: `targets/opencode/skills/spec-master-execute/SKILL.md`

**Key Decisions / Notes:**

- The skill is a **thin orchestrator** — it spawns subagents and tracks progress, never does implementation itself
- Wave execution algorithm:
  1. Read master plan, parse `## Phases` section
  2. Set master plan status to `IN_PROGRESS`
  3. Group child plans by wave number
  4. For each wave (sequential):
     a. Filter to child plans not yet VERIFIED
     b. For each child plan in the wave, spawn a subagent:
        ```
        Task(subagent_type="general", prompt="Execute /spec <child-plan-path>")
        ```
     c. Wait for all subagents in the wave to complete
     d. Check each child plan's status — if any failed, report and ask user how to proceed
     e. Update master plan progress checkboxes
  5. After all waves complete, set master plan status to `COMPLETE`
  6. Chain to spec-verify for the master plan
- Resumability: re-running skips VERIFIED child plans automatically
- Context management: the orchestrator stays thin, subagents get fresh context
- Each subagent runs the full `/spec <child-plan.md>` cycle (implement + verify)
- The master plan's `## Phases` section uses checkboxes:
  ```
  - [x] Phase 1: User model (Wave 1) — VERIFIED
  - [x] Phase 2: Product model (Wave 1) — VERIFIED
  - [ ] Phase 3: Orders API (Wave 2) — PENDING
  ```

**Definition of Done:**

- [ ] Both skill files created with identical content
- [ ] Wave-sequential, phase-parallel execution model documented
- [ ] Subagent spawning pattern for child plan execution
- [ ] Progress tracking via master plan checkboxes
- [ ] Resume support (skip VERIFIED child plans)
- [ ] Error handling (child plan failure mid-wave)

**Verify:**

- Manual: trace through skill with a sample 2-wave, 3-phase master plan

---

### Task 9: Embedded Assets Rebuild and Integration Test

**Objective:** Rebuild embedded assets to include all new/modified skill files, rebuild CLI binary, and run full integration test.

**Dependencies:** Tasks 1-8

**Files:**

- Regenerate: `src/cli/embedded-assets.ts` (via `bun run embed-assets`)
- Modify: `src/cli/commands/install.ts` (verify new skills are registered — check if install.ts has a skill manifest)

**Key Decisions / Notes:**

- Run `bun run embed-assets` to regenerate all embedded config from `targets/`
- Check `install.ts` for any skill/command registration manifest. If new skills (spec-master-plan, spec-master-execute) must be explicitly listed, add them. This is a required DoD item, not conditional.
- Run `bun run build:cli` to rebuild the CLI binary
- Run `codesign -f -s - ~/.sentinal/bin/sentinal` after rebuild
- Verify new skills appear in embedded assets
- Run full test suite
- Manual integration test: create a simple master plan and verify dispatcher routing

**Definition of Done:**

- [ ] `bun run embed-assets` includes new skills (spec-master-plan, spec-master-execute)
- [ ] New skills registered in install.ts (if applicable)
- [ ] `bun run build:cli` completes without errors
- [ ] `bun test` passes (no regressions)
- [ ] No TypeScript errors
- [ ] CLI binary codesigned

**Verify:**

- `bun run embed-assets && bun run build:cli && bun test`
- `codesign -f -s - ~/.sentinal/bin/sentinal`
