# Quick Mode, Pause/Resume & Performance Metrics Plan

Created: 2026-03-18
Status: VERIFIED
Approved: Yes
Iterations: 1
Worktree: No
Type: Feature

## Summary

**Goal:** Add three productivity features: (1) `/quick` command that runs the spec workflow with reviewers and approval disabled for small tasks, (2) `/pause` command that creates `.sentinal/continue-here.md` handoff files for cross-session resumption, and (3) per-plan + per-task performance metrics tracked in SQLite and exposed via MCP tool.

**Architecture:** `/quick` is a standalone command that sets env-var toggles to disable reviewers/approval then delegates to the spec-plan skill. `/pause` is a standalone command that writes a structured handoff file. Resume detection is added to the `/spec` dispatcher. Metrics adds `started_at`/`completed_at` columns to the `specs` table and surfaces timing data through `spec_status` and a new `spec_metrics` MCP tool.

**Tech Stack:** TypeScript (Bun), skill markdown files, SQLite migrations, MCP tools.

## Scope

### In Scope

- `--quick` flag on `/spec` dispatcher (both platforms) — skips plan reviewer, approval, spec reviewer
- `/quick` command runs spec workflow with plan reviewer, approval, and spec reviewer disabled
- `/pause` command (both platforms) — writes `.sentinal/continue-here.md` with exact next action, context, blockers
- Resume detection in spec dispatcher — detect `.sentinal/continue-here.md` on `/spec` invocation
- V10 migration: `started_at`/`completed_at` on `specs` table
- Log `phase_change` events from `syncFromPlanFile()` on status transitions
- Surface task timing (already has `started_at`/`completed_at`) in `spec_status` output
- New `spec_metrics` MCP tool for velocity and duration data

### Out of Scope

- `/resume` as a separate command (resume is handled by detecting continue-here.md in the dispatcher)
- Full GSD discussion/research flags (Sentinal already has exploration in spec-plan)
- Performance dashboards or visualizations
- Automatic velocity trend calculation (keep it simple — expose raw data)

## Context for Implementer

- **Patterns to follow:**
  - Spec dispatcher: `targets/*/commands/spec.md` — Section 0.1 (type detection + flag parsing)
  - Config toggles: `$SENTINAL_PLAN_REVIEWER_ENABLED` etc. — read by skills via `spec_init`
  - MCP tools: `src/spec/mcp-tools.ts` — `registerSpecInitTool()` pattern for new tools
  - SQLite migration: `src/memory/migrations.ts` — V8/V9 pattern with PRAGMA table_info guards
  - Handoff file: `.sentinal/continue-here.md` — matches GSD's `.continue-here.md` pattern

- **Key files:**
  - `targets/*/commands/spec.md` — Dispatcher (flag parsing + routing)
  - `targets/*/skills/spec-implement/SKILL.md` — Implementation skill (where metrics events get logged)
  - `src/spec/store.ts` — SpecStore (syncFromPlanFile, updateTaskStatus)
  - `src/spec/mcp-tools.ts` — MCP tool registration
  - `src/memory/migrations.ts` — Schema migrations
  - `src/memory/types.ts` — DB_CONSTANTS, SpecEvent, SPEC_EVENT_TYPES

- **Gotchas:**
  - `spec_tasks` already has `started_at`/`completed_at` from V7 — just need to surface them
  - `phase_change` event type exists in SPEC_EVENT_TYPES but is never logged from production code
  - The dispatcher env-var approach works because skills read toggles via `spec_init` at Step 0
  - `.sentinal/continue-here.md` must be in the `.sentinal/.gitignore` exceptions list

## Assumptions

- Setting `SENTINAL_PLAN_REVIEWER_ENABLED=false` etc. as env vars before skill loading effectively disables those phases — supported by existing spec_config/spec_init toggle reading — Tasks 1-2 depend on this
- `SpecStore.syncFromPlanFile()` is called on every `spec_register` — supported by `src/spec/store.ts:76` — Task 5 depends on this
- `spec_tasks.started_at/completed_at` are already populated by `updateTaskStatus()` — supported by V7 migration and `store.ts:232` — Task 6 depends on this

## Testing Strategy

- **Unit tests:** `spec_metrics` MCP tool with known timing data; `syncFromPlanFile` event logging; pause handoff file generation
- **Integration tests:** Dispatcher flag parsing (manual); resume detection (manual)
- **Regression:** Full test suite (`bun test`)

## Risks and Mitigations

| Risk                                    | Likelihood | Impact | Mitigation                                                     |
| --------------------------------------- | ---------- | ------ | -------------------------------------------------------------- |
| Quick mode produces bad plans           | Medium     | Medium | Keep TDD and automated checks — only skip human/reviewer steps |
| Pause handoff file goes stale           | Low        | Low    | Include timestamp; resume should warn if >24h old              |
| Metrics overhead on every spec_register | Low        | Low    | One extra SELECT + INSERT per status change — negligible       |

## Pre-Mortem

1. **Quick mode skips too much** (Tasks 1-2) → Trigger: Quick plans lack enough context for the implementer, causing more fix iterations than saved time. Mitigated: quick mode still creates a plan file with tasks — it only skips the reviewer and approval, not the planning itself.

2. **Resume doesn't find continue-here.md** (Tasks 3-4) → Trigger: The file path changed, or `.sentinal/.gitignore` blocks it, or findActivePlan returns a different plan. Mitigated: resume detection checks for file existence before plan detection.

## Goal Verification

### Truths

1. `/quick <task>` sets SENTINAL_PLAN_REVIEWER_ENABLED=false, SENTINAL_PLAN_APPROVAL_ENABLED=false, SENTINAL_SPEC_REVIEWER_ENABLED=false before loading the planning skill
2. `/pause` creates `.sentinal/continue-here.md` with plan path, current task, next action, and timestamp
3. The spec dispatcher detects `.sentinal/continue-here.md` and offers to resume before starting new work
4. `specs` table has `started_at` and `completed_at` columns after V10 migration
5. `spec_status` output includes task timing when available
6. `spec_metrics` MCP tool returns plan duration and per-task timing data

### Artifacts

| Artifact                      | Provides      | Exports                              |
| ----------------------------- | ------------- | ------------------------------------ |
| `targets/*/commands/quick.md` | Quick command | `/quick` standalone command          |
| `targets/*/commands/pause.md` | Pause command | `/pause` skill                       |
| `src/spec/mcp-tools.ts`       | Metrics tool  | `spec_metrics` MCP tool              |
| `src/memory/migrations.ts`    | V10 migration | `started_at`/`completed_at` on specs |

### Key Links

| From               | To               | Via                  | Pattern                     |
| ------------------ | ---------------- | -------------------- | --------------------------- |
| spec.md dispatcher | spec_init        | toggle reading       | spec_init                   |
| spec.md dispatcher | continue-here.md | resume detection     | \.sentinal/continue-here    |
| syncFromPlanFile   | logSpecEvent     | phase_change logging | logSpecEvent.\*phase_change |
| spec_metrics       | SpecStore        | timing query         | started_at.\*completed_at   |

## Progress Tracking

- [x] Task 1: Create /quick command
- [x] Task 2: Update skill files for quick mode behavior
- [x] Task 3: Create /pause command
- [x] Task 4: Add resume detection to spec dispatcher
- [x] Task 5: V10 migration + phase_change event logging
- [x] Task 6: Create spec_metrics MCP tool + surface timing
- [x] Task 7: Embedded assets rebuild and tests

**Total Tasks:** 7 | **Completed:** 7 | **Remaining:** 0

## Implementation Tasks

### Task 1: Create /quick Command

**Objective:** Create a standalone `/quick` command that sets environment variables to disable reviewers and approval, then delegates to the spec workflow for the task description.

**Dependencies:** None

**Files:**

- Create: `targets/claude-code/commands/quick.md`
- Create: `targets/opencode/commands/quick.md`

**Key Decisions / Notes:**

- `/quick <task>` is a thin wrapper that:
  1. Sets env vars: `SENTINAL_PLAN_REVIEWER_ENABLED=false`, `SENTINAL_PLAN_APPROVAL_ENABLED=false`, `SENTINAL_SPEC_REVIEWER_ENABLED=false`
  2. Detects type (feature vs bugfix) using the same heuristics as the spec dispatcher
  3. Loads the appropriate planning skill with the task description
- NOT a flag on `/spec` — it's a completely separate command
- The skills already check these toggles in Step 0 via `spec_init` — setting the env vars is sufficient
- The command should detect type (feature/bugfix) but skip the worktree question (quick tasks don't use worktrees — always pass `--worktree=no`)
- Follow the same frontmatter pattern as other commands (description, argument-hint)

**Definition of Done:**

- [ ] Both command files created with identical content
- [ ] /quick sets the three env vars to "false"
- [ ] Type detection (feature/bugfix) works
- [ ] Worktree always set to No

**Verify:** Manual: invoke `/quick add a test` and verify spec_init shows toggles as disabled

---

### Task 2: Update Skill Files for Quick Mode Behavior

**Objective:** Add quick mode awareness to spec-plan and spec-implement so they behave correctly when reviewers and approval are disabled.

**Dependencies:** Task 1

**Files:**

- Modify: `targets/opencode/skills/spec-plan/SKILL.md`
- Modify: `targets/claude-code/commands/spec-plan.md`

**Key Decisions / Notes:**

- The skills already handle disabled toggles (Step 0 reads config, conditional sections skip when "false")
- Only change needed: add a note in Step 0 that when all three toggles are false (quick mode), the planning phase should use a lighter plan template:
  - Skip Risks, Pre-Mortem, and Context for Implementer sections (the full plan template is overkill for small tasks)
  - Exploration and questions still run normally — quick mode only skips reviewers and approval
- No changes needed to spec-implement or spec-verify — they already respect the toggles

**Definition of Done:**

- [ ] Both spec-plan files have quick mode conciseness guidance
- [ ] Both files identical in content
- [ ] No changes to spec-implement or spec-verify needed

**Verify:** diff both files to confirm identical

---

### Task 3: Create /pause Command

**Objective:** Create a `/pause` command that saves the current spec workflow context to `.sentinal/continue-here.md` for cross-session resumption.

**Dependencies:** None

**Files:**

- Create: `targets/claude-code/commands/pause.md`
- Create: `targets/opencode/commands/pause.md`

**Key Decisions / Notes:**

- The command reads the active plan (via `spec_init`), identifies the current task, and writes a handoff file
- Handoff file format (following GSD pattern):

  ```markdown
  # Continue Here

  Created: [timestamp]
  Plan: [plan file path]
  Status: [current status]
  Current Task: [task N: title]

  ## Next Action

  [Exact next step — e.g., "Write test for Task 3", "Run spec-verify"]

  ## Context

  [Key decisions, files being modified, errors being debugged]

  ## Blockers

  [Any blockers or open questions]
  ```

- After writing the file, commit as WIP: `git add -A && git commit -m "wip: pause at Task N"`
- File location: `.sentinal/continue-here.md`
- Verify `.sentinal/.gitignore` allows this file — add `!continue-here.md` exception if needed
- The command should ask the user for "Next Action" and "Blockers" context via AskUserQuestion

**Definition of Done:**

- [ ] Both command files created with identical content
- [ ] Handoff file includes plan path, current task, next action, context, blockers, timestamp
- [ ] WIP commit created after writing handoff file

**Verify:** Manual: invoke `/pause` with an active plan, verify continue-here.md content

---

### Task 4: Add Resume Detection to Spec Dispatcher

**Objective:** When `/spec` is invoked, check for `.sentinal/continue-here.md` first and offer to resume if found.

**Dependencies:** Task 3

**Files:**

- Modify: `targets/opencode/commands/spec.md`
- Modify: `targets/claude-code/commands/spec.md`

**Key Decisions / Notes:**

- Add at the very beginning of Section 0.1 (before type detection):
  ```
  IF .sentinal/continue-here.md exists:
    → Read the file
    → Show: "Found paused work: [plan title] at [current task]"
    → AskUserQuestion: "Resume paused work?" / "Start new task (discard pause)"
    → If resume: read plan path from handoff, delete continue-here.md, dispatch by status
    → If new: delete continue-here.md, continue with new task
  ```
- Warn if handoff file is >24h old: "Paused work is from [date] — context may be stale"
- Delete continue-here.md after either choice (it's consumed)

**Definition of Done:**

- [ ] Both dispatchers check for continue-here.md before type detection
- [ ] Resume shows plan title, current task, and age
- [ ] Stale warning for >24h old handoff files
- [ ] File deleted after consumption

**Verify:** Manual: create a continue-here.md, invoke `/spec`, verify resume prompt

---

### Task 5: V10 Migration + Phase Change Event Logging

**Objective:** Add `started_at` and `completed_at` columns to the `specs` table, update `syncFromPlanFile()` to log `phase_change` events on status transitions, and set timing fields.

**Dependencies:** None

**Files:**

- Modify: `src/memory/migrations.ts` — V10 migration
- Modify: `src/memory/types.ts` — SCHEMA_VERSION bump
- Modify: `src/spec/store.ts` — syncFromPlanFile event logging + timing
- Modify: `src/spec/types.ts` — SpecSchema startedAt/completedAt
- Test: `src/memory/migrations.test.ts` — V10 migration test
- Test: `src/spec/store.test.ts` — phase change event test (if exists)

**Key Decisions / Notes:**

- V10 adds `started_at INTEGER` and `completed_at INTEGER` to `specs` table
- Guard with table existence check (same pattern as V9)
- **CRITICAL: Fix syncFromPlanFile upsert pattern** — the current `INSERT OR REPLACE` on `specs` destroys any columns not in the INSERT list (it deletes + re-inserts). Change to `INSERT...ON CONFLICT(id) DO UPDATE` with `COALESCE` to preserve timing columns:
  ```sql
  INSERT INTO specs (..., started_at, completed_at) VALUES (...)
  ON CONFLICT(id) DO UPDATE SET
    status = excluded.status,
    ...,
    started_at = COALESCE(excluded.started_at, specs.started_at),
    completed_at = COALESCE(excluded.completed_at, specs.completed_at)
  ```
- **CRITICAL: Fix spec_tasks sync** — the current `DELETE FROM spec_tasks WHERE spec_id = ?` + re-insert destroys `started_at`/`completed_at` set by `updateTaskStatus()`. Change to `INSERT...ON CONFLICT(spec_id, position) DO UPDATE` preserving timing columns.
- **Old status lookup:** Before upsert, `SELECT status, started_at, completed_at FROM specs WHERE id = ?` to detect status transitions
- When transitioning TO `IN_PROGRESS`: set `started_at = Date.now()`
- When transitioning TO `VERIFIED`: set `completed_at = Date.now()`
- Log a `phase_change` event with `{ from: oldStatus, to: newStatus }` details
- Add `startedAt` and `completedAt` as optional fields in SpecSchema
- Update SCHEMA_VERSION to 10

**Definition of Done:**

- [ ] V10 migration adds started_at/completed_at to specs
- [ ] SCHEMA_VERSION is 10
- [ ] specs upsert uses ON CONFLICT DO UPDATE preserving started_at/completed_at
- [ ] spec_tasks sync uses ON CONFLICT DO UPDATE preserving started_at/completed_at
- [ ] Old status fetched before upsert for comparison
- [ ] syncFromPlanFile logs phase_change events on status transitions
- [ ] started_at set on IN_PROGRESS transition, completed_at on VERIFIED
- [ ] Migration test passes
- [ ] All existing tests pass

**Verify:** `bun test src/memory/migrations.test.ts && bun test src/spec/`

---

### Task 6: Create spec_metrics MCP Tool + Surface Timing

**Objective:** Create a `spec_metrics` MCP tool that returns plan duration and per-task timing data. Also surface existing task timing in `spec_status` output.

**Dependencies:** Task 5

**Files:**

- Modify: `src/spec/mcp-tools.ts` — new spec_metrics tool + enhance spec_status
- Test: `src/spec/mcp-tools.test.ts` — spec_metrics tests

**Key Decisions / Notes:**

- `spec_metrics` parameters: `project` (required), `spec_id` (optional — defaults to active spec)
- Output format:

  ```
  ## Spec Metrics: [title]

  ### Plan Timing
  - Started: [date] | Completed: [date] | Duration: [Xh Ym]

  ### Task Timing
  | Task | Started | Completed | Duration |
  |------|---------|-----------|----------|
  | 1: Setup | 10:00 | 10:15 | 15m |
  | 2: Implement | 10:16 | 11:02 | 46m |

  ### Summary
  - Total tasks: N | Average: Xm | Longest: Task Y (Zm)
  ```

- For `spec_status`: append task timing when `started_at`/`completed_at` are available
- Retrieve data via SpecStore (existing `getCurrentSpec` + new timing query)

**Definition of Done:**

- [ ] spec_metrics tool registered and returns timing data
- [ ] spec_status shows task timing when available
- [ ] Tests cover: plan with timing, plan without timing, no active plan
- [ ] All tests pass

**Verify:** `bun test src/spec/mcp-tools.test.ts`

---

### Task 7: Embedded Assets Rebuild and Tests

**Dependencies:** Tasks 1-6

**Files:**

- Regenerate: `src/cli/embedded-assets.ts`

**Definition of Done:**

- [ ] `bun run embed-assets` completes
- [ ] `bun run build:cli` completes
- [ ] `bun test` passes (0 failures)
- [ ] CLI binary codesigned

**Verify:** `bun run embed-assets && bun run build:cli && bun test`
