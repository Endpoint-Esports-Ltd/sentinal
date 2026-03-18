# GSD Techniques Tier 1 + Compound Init Implementation Plan

Created: 2026-03-18
Status: VERIFIED
Approved: Yes
Iterations: 1
Worktree: No
Type: Feature

## Summary

**Goal:** Add 5 GSD-inspired quality guards to the spec workflow (analysis paralysis guard, fix attempt limit, deviation rules, stub detection, structured must_haves) and create a compound init MCP tool that returns all workflow context in a single call.

**Architecture:** Items 1-5 are pure skill-file edits (markdown) to spec-implement and spec-verify/spec-plan. Item 6 is a new `spec_init` MCP tool that combines spec_status + spec_config + project_context into one response, eliminating 5-10 file reads per workflow start.

## Scope

### In Scope
- Analysis paralysis guard in spec-implement (5+ consecutive reads without writes)
- Fix attempt limit in spec-implement (3 auto-fix attempts per task max)
- Deviation rules in spec-implement (auto-fix vs ask-user decision framework)
- Stub detection patterns in spec-verify
- Structured must_haves format in spec-plan (truths/artifacts/key_links)
- New `spec_init` MCP tool returning combined workflow context

### Out of Scope
- Quick mode, pause/resume, parallel research, model routing, config system

## Progress Tracking

- [x] Task 1: Add analysis paralysis guard, fix attempt limit, and deviation rules to spec-implement
- [x] Task 2: Add stub detection patterns to spec-verify
- [x] Task 3: Formalize must_haves format in spec-plan
- [x] Task 4: Create spec_init compound MCP tool
- [x] Task 5: Embedded assets rebuild and tests

**Total Tasks:** 5 | **Completed:** 5 | **Remaining:** 0

## Implementation Tasks

### Task 1: Add Guards and Rules to spec-implement

**Objective:** Add analysis paralysis guard (5+ reads without writes), fix attempt limit (3 per task), and deviation rules (auto-fix vs ask) to the spec-implement skill.

**Files:**
- Modify: `targets/opencode/skills/spec-implement/SKILL.md`
- Modify: `targets/claude-code/commands/spec-implement.md`

**Key Decisions / Notes:**
- Add after Step 2.3 item 6 (TDD Flow) as new items in the TDD loop
- Analysis paralysis guard: "If you have made 5+ consecutive Read/Grep/Glob/Search calls without any Write/Edit/Bash command, STOP. State in one sentence why you haven't written anything yet. If blocked, report the blocker and move to next task."
- Fix attempt limit: "After 3 auto-fix attempts on the same test/issue within a task, STOP fixing. Document the remaining issue in the plan, mark task as blocked, and continue to the next task."
- Deviation rules as a new section before the TDD loop:
  - Auto-fix: bugs, wrong types, missing error handling, broken imports, missing validation
  - Ask user: new DB tables, switching libraries, changing API contracts, architectural changes
  - Scope boundary: only fix issues caused by current task. Pre-existing issues → note in plan.

**Verify:** diff both skill files to confirm identical content

---

### Task 2: Add Stub Detection to spec-verify

**Objective:** Add three-level artifact verification (Exists → Substantive → Wired) and stub detection patterns to the spec-verify skill.

**Files:**
- Modify: `targets/opencode/skills/spec-verify/SKILL.md`
- Modify: `targets/claude-code/commands/spec-verify.md`

**Key Decisions / Notes:**
- Add to Step 3.8 (Per-Task DoD Audit) or as a new Step 3.8a
- Three-level check:
  1. **Exists:** File is present on disk
  2. **Substantive:** File is NOT a stub. Stub patterns to flag:
     - `return null` / `return undefined` as only return
     - `return <div>Placeholder</div>` or `return <div>TODO</div>`
     - Empty function bodies `() => {}`
     - `throw new Error("Not implemented")`
     - `console.log("TODO")` as only content
     - `Response.json({ message: "Not implemented" })`
  3. **Wired:** File is imported/used by at least one other file (grep for import path)
- For each plan artifact in Goal Verification: run all three levels
- Report findings in the verification summary

**Verify:** diff both skill files to confirm identical content

---

### Task 3: Formalize must_haves Format in spec-plan

**Objective:** Update the spec-plan template to use structured, verifiable must_haves instead of free-text Goal Verification.

**Files:**
- Modify: `targets/opencode/skills/spec-plan/SKILL.md`
- Modify: `targets/claude-code/commands/spec-plan.md`

**Key Decisions / Notes:**
- Enhance the existing `## Goal Verification` section in the plan template (Step 1.6)
- Truths: each must be **grep-verifiable** or **curl-testable** — not vague prose
  - Good: "GET /api/users returns 200 with JSON array"
  - Bad: "API works correctly"
- Artifacts: each must specify `path`, `provides` (what it delivers), and `exports` (public API)
  - Example: `- path: src/auth/login.ts | provides: Login endpoint | exports: POST /api/auth/login`
- Key Links: each must specify `from`, `to`, `via` (how they connect), and `pattern` (grep-verifiable)
  - Example: `- from: src/auth/login.ts | to: prisma.user | via: credential lookup | pattern: prisma\.user\.findUnique`
- Update Step 1.5.1 to produce this structured format
- The plan-reviewer already checks Goal Verification — structured format makes its job easier

**Verify:** diff both skill files to confirm identical content

---

### Task 4: Create spec_init Compound MCP Tool

**Objective:** Create a new `spec_init` MCP tool that returns all workflow context in a single call — active plan state, config toggles, project context, and current task info.

**Dependencies:** None

**Files:**
- Modify: `src/spec/mcp-tools.ts`
- Modify: `src/spec/mcp-tools.test.ts`

**Key Decisions / Notes:**
- Combines output from: `spec_status` (active plan + tasks) + `spec_config` (toggles) + `findActivePlan()` (filesystem detection)
- Returns a single markdown response with all sections
- Parameters: `project` (required)
- Output format:
  ```
  ## Spec Workflow Context
  
  ### Active Plan
  - Title, Status, Type, Approved, Progress %, Current Task
  - Plan File path
  
  ### Configuration
  - All SENTINAL_* toggles
  
  ### Current Task
  - Task N: Title (status)
  - Definition of Done items
  
  ### Remaining Tasks
  - List of pending/in-progress tasks
  ```
- Fast path: if no active plan, return just config section
- This replaces the need to call spec_status + spec_config + spec_plan_parse separately

**Verify:** `bun test src/spec/mcp-tools.test.ts`

---

### Task 5: Embedded Assets Rebuild and Tests

**Dependencies:** Tasks 1-4

**Files:**
- Regenerate: `src/cli/embedded-assets.ts`

**Verify:** `bun run embed-assets && bun run build:cli && bun test`
