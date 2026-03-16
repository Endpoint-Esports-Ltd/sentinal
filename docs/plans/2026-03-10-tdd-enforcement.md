# TDD Enforcement + Spec Workflow Foundation

Created: 2026-03-10
Status: VERIFIED
Approved: No
Iterations: 0
Worktree: No
Type: Feature
Parent: docs/plans/2026-03-09-market research-parity.md

## Summary

**Goal:** Implement programmatic TDD enforcement during `/spec` workflows — blocking implementation file edits unless a failing test has been confirmed for the current task, and extending the spec/task data model to fully support the TDD lifecycle. This plan also builds the database and domain foundation that `PLAN-spec-workflow.md` envisioned but never implemented.

**What the current system lacks:**

- The `spec-implement.md` command template tells the AI to follow RED-GREEN-REFACTOR, but there is no programmatic enforcement — nothing blocks an AI from editing implementation files before writing a test
- The `spec_tasks` table only has `position`, `title`, `status` — no `test_strategy`, `definition_of_done`, `started_at`, `completed_at`, or `"failed"` status
- The `spec_events` table (planned in PLAN-spec-workflow.md) was never created
- `SpecStore` has no `getCurrentTask()` method
- The plan parser extracts only task title and checkbox status; rich task metadata (test strategy, DoD) is not parsed or persisted

**Architecture:**

- TDD state machine per-file: `IDLE → TEST_WRITTEN → RED_CONFIRMED → GREEN_CONFIRMED → IDLE`
- State stored in `tdd_cycles` SQLite table (V7 migration)
- Two new hooks: `tdd-tracker.ts` (PostToolUse — observes events) and `tdd-guard.ts` (PreToolUse — blocks edits)
- Guard uses a lightweight SQLite read (skip MemoryStore init overhead — bare Database open + single SELECT)
- Enforcement is scoped to active spec workflows only — no effect outside `/spec`
- OpenCode parity: equivalent logic in `targets/opencode/plugins/sentinal.ts`

**Key Design Decisions:**

- **Hard block** (deny, not advisory) — PreToolUse returns `permissionDecision: "deny"` + `process.exit(2)` for Claude Code; `throw new Error(...)` for OpenCode
- **All implementation files** — any non-test `.ts`/`.tsx` file is guarded during an active spec
- **Failing test confirmed** is the unlock trigger — a Bash command whose output matches `TEST_FAIL_INDICATORS` transitions state to `RED_CONFIRMED`, enabling implementation edits for that file
- **SQLite state** — `tdd_cycles` table in `~/.sentinal/memory.db`, not a JSON file
- **Spec-scoped enforcement** — guard is a no-op if `getCurrentSpec(projectPath)` returns null
- **Lightweight guard reads** — `tdd-guard.ts` opens a bare `bun:sqlite` Database (read-only) + single SELECT, skipping MemoryStore migration overhead (~2ms vs ~10ms)
- **Future optimization noted** — MCP server HTTP sidecar would eliminate per-hook DB overhead entirely; deferred to separate spec

**Session → Spec → Task relationship:**

- A session can have many specs (via `specs.session_id`, soft reference, no FK constraint)
- A spec has many tasks (via `spec_tasks.spec_id`, hard FK with cascade delete)
- `session_id` is written to specs during `syncFromPlanFile()` but currently never queried — this plan adds `getSpecsForSession()` and `getCurrentTask()` to formalize the chain

## Scope

### In Scope

- V7 migration: `tdd_cycles` table + `spec_events` table + extended `spec_tasks` columns
- Lightweight TDD state read function (bypass MemoryStore init)
- TDD state CRUD methods on `MemoryStore`
- `spec_events` logging methods on `MemoryStore`
- Extended `SpecTask` schema: `testStrategy`, `definitionOfDone`, `startedAt`, `completedAt`, `"failed"` status
- Extended `Spec` type: `IMPLEMENTING`, `VERIFYING`, `FAILED`, `DRAFT`, `PLANNING` status values
- Plan parser updates: extract `**Test Strategy:**` and `**Definition of Done:**` from task sections
- `SpecStore.getCurrentTask(specId)` — returns first `in-progress` task
- `SpecStore.getSpecsForSession(sessionId)` — reverse navigation from session to specs
- `src/hooks/tdd-tracker.ts` — PostToolUse hook (test file writes, test failures, test passes)
- `src/hooks/tdd-guard.ts` — PreToolUse hook (blocks implementation edits without RED_CONFIRMED)
- Register both hooks in `targets/claude-code/hooks/hooks.json`
- OpenCode parity in `targets/opencode/plugins/sentinal.ts`
- Update `templates/commands/spec-implement.md` to mention enforcement
- Regenerate commands for both targets
- Barrel exports in `src/index.ts`

### Out of Scope

- `SpecEngine` state machine (full `src/spec/engine.ts` with transition validation) — separate spec
- Phase modules (`src/spec/phases/implementation.ts`, `verification.ts`) — separate spec
- MCP server HTTP sidecar for hook DB access — separate spec
- `VALID_TRANSITIONS` enforcement — separate spec
- Verification loop-back — separate spec
- Auto-detection of spec type (`detectSpecType()`) — separate spec

## Context for Implementer

**TDD state machine per file:**

```
IDLE ──(write test file)──> TEST_WRITTEN ──(test fails)──> RED_CONFIRMED ──(impl edit allowed)
  ^                                                                                    │
  └──────────────────────────────(test passes)──────────────────────────────────────┘
                               GREEN_CONFIRMED (auto-resets to IDLE for next cycle)
```

**State transitions triggered by:**

- `IDLE → TEST_WRITTEN`: Write/Edit tool on a file where `isTestFile(path)` returns true
- `TEST_WRITTEN → RED_CONFIRMED`: Bash tool output matches `TEST_FAIL_INDICATORS`
- `RED_CONFIRMED → GREEN_CONFIRMED`: Bash tool output matches `TEST_PASS_INDICATORS` (after impl edits)
- `GREEN_CONFIRMED → IDLE`: Automatic (task cycle complete, ready for next task)

**Guard logic (tdd-guard.ts):**

1. Read `tool_name` and `tool_input.file_path` from PreToolUse stdin
2. If `tool_name` not in `["Write", "Edit", "MultiEdit"]` → pass through (no-op)
3. If `isTestFile(file_path)` → pass through (test file writes always allowed)
4. Open `~/.sentinal/memory.db` read-only, query `tdd_cycles` for this file's state
5. If no active spec in project (`getCurrentSpec`) → pass through (guard is scoped to specs)
6. If state is `RED_CONFIRMED` → pass through (test is failing, implementation allowed)
7. Otherwise → `deny()` + `process.exit(2)` with message explaining what to do

**Tracker logic (tdd-tracker.ts):**

1. Read `tool_name`, `tool_input`, `tool_response` from PostToolUse stdin
2. Match against patterns:
   - Write/Edit to test file → upsert `tdd_cycles` row with `TEST_WRITTEN`
   - Bash output with `TEST_FAIL_INDICATORS` → update `tdd_cycles` to `RED_CONFIRMED`
   - Bash output with `TEST_PASS_INDICATORS` + prior impl edits in buffer → update to `GREEN_CONFIRMED`
3. Log to `spec_events` if active spec exists
4. Reuse `TEST_FAIL_INDICATORS`, `TEST_PASS_INDICATORS`, `isEditTool()` from `src/memory/capture.ts`
5. Reuse `isTestFile()` from `src/utils/tdd.ts`

**Performance:**

- Guard uses bare `new Database(path, { readonly: true })` + `db.query("SELECT state FROM tdd_cycles WHERE file_path = ?").get(path)` + `db.close()` — ~2ms
- Does NOT use `new MemoryStore()` (which runs migrations, PRAGMA, schema version checks) — ~10ms
- Tracker uses full `MemoryStore` (needs write access + migration safety) — acceptable since PostToolUse is advisory-only in terms of latency

**Reuse patterns:**

- `TEST_FAIL_INDICATORS`, `TEST_PASS_INDICATORS`, `isEditTool()` → `src/memory/capture.ts`
- `isTestFile()`, `SKIP_TEST_PATTERNS` → `src/utils/tdd.ts`
- `deny()`, `readStdin()`, `output()` → `src/utils/hook-output.ts`
- `getCurrentSpec()` → `src/spec/store.ts`

**Plan markdown format for rich tasks** (parser must support):

```markdown
### 1. Create User entity and migration

- **Status:** VERIFIED
- **Test Strategy:** Unit test entity validation, integration test migration
- **Definition of Done:** Entity created, migration runs, tests pass
```

**Existing patterns to follow:**

- All hooks: `export function process...()` for testable logic + `async function main()` + `if (import.meta.main) { main().catch(console.error) }`
- PreToolUse denial: return `deny(reason)` + `process.exit(2)` (see `src/hooks/tool-redirect.ts`)
- PostToolUse observation: return nothing or `hint()` (advisory only, no blocking)
- MemoryStore CRUD: methods directly on `MemoryStore` class (not separate service classes)
- Tests: `:memory:` SQLite for all DB tests, co-located `.test.ts` files

## Progress Tracking

- [x] Task 1: V7 migration — tdd_cycles + spec_events + extended spec_tasks
- [x] Task 2: TDD state CRUD + spec_events logging on MemoryStore
- [x] Task 3: Extended SpecTask types + plan parser updates + getCurrentTask()
- [x] Task 4: Spec relationship helpers + getSpecsForSession()
- [x] Task 5: tdd-tracker.ts PostToolUse hook
- [x] Task 6: tdd-guard.ts PreToolUse hook
- [x] Task 7: OpenCode plugin integration
- [x] Task 8: Template updates + barrel exports + regenerate commands

**Total Tasks:** 8 | **Completed:** 8 | **Partial:** 0 | **Remaining:** 0

## Implementation Tasks

### Task 1: V7 Migration — tdd_cycles + spec_events + Extended spec_tasks

**Objective:** Add three schema changes in a single V7 migration: (1) `tdd_cycles` table for TDD state tracking, (2) `spec_events` table for event logging, (3) new columns on `spec_tasks`.

**Dependencies:** None

**Files:**

- Modify: `src/memory/migrations.ts` — Add `migrateV7()` function, register in `runMigrations()`
- Modify: `src/memory/types.ts` — Bump `SCHEMA_VERSION` to 7, add `RawTddCycle`, `RawSpecEvent` types

**Schema:**

```sql
-- TDD state tracking per file path
CREATE TABLE IF NOT EXISTS tdd_cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL UNIQUE,
  spec_id TEXT REFERENCES specs(id),
  task_position INTEGER,
  state TEXT NOT NULL DEFAULT 'IDLE',
    -- 'IDLE' | 'TEST_WRITTEN' | 'RED_CONFIRMED' | 'GREEN_CONFIRMED'
  test_file_path TEXT,
  last_fail_output TEXT,
  updated_at INTEGER NOT NULL
);

-- Event log for spec phase changes, task updates, TDD cycle events
CREATE TABLE IF NOT EXISTS spec_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spec_id TEXT NOT NULL REFERENCES specs(id),
  session_id TEXT,
  timestamp INTEGER NOT NULL,
  event_type TEXT NOT NULL,
    -- 'phase_change' | 'task_update' | 'tdd_cycle' | 'verification' | 'note'
  details TEXT NOT NULL  -- JSON
);

-- Extended spec_tasks columns (idempotent via PRAGMA table_info check)
ALTER TABLE spec_tasks ADD COLUMN description TEXT;
ALTER TABLE spec_tasks ADD COLUMN test_strategy TEXT;
ALTER TABLE spec_tasks ADD COLUMN definition_of_done TEXT;
ALTER TABLE spec_tasks ADD COLUMN started_at INTEGER;
ALTER TABLE spec_tasks ADD COLUMN completed_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_tdd_cycles_file ON tdd_cycles(file_path);
CREATE INDEX IF NOT EXISTS idx_tdd_cycles_spec ON tdd_cycles(spec_id);
CREATE INDEX IF NOT EXISTS idx_spec_events_spec ON spec_events(spec_id);
CREATE INDEX IF NOT EXISTS idx_spec_events_type ON spec_events(event_type);
```

**Key Notes:**

- `ALTER TABLE` must use idempotent pattern — check `PRAGMA table_info(spec_tasks)` first; skip columns that already exist (same pattern used in V4 for `transcript_path`)
- `tdd_cycles.file_path` is UNIQUE — one state row per implementation file, upserted on change
- `spec_events.details` is JSON — flexible schema for different event types
- `task_position` on `tdd_cycles` links to the spec task being worked on (not a FK — task positions can change)

**Definition of Done:**

- [x] `migrateV7()` creates all 3 tables/columns when run on a V6 database
- [x] Migration is idempotent — running twice on a V7 database is a no-op
- [x] `SCHEMA_VERSION` bumped to 7 in `DB_CONSTANTS`
- [x] `RawTddCycle` and `RawSpecEvent` types defined in `types.ts`
- [x] `"failed"` added to `TaskStatus` enum in `src/spec/types.ts`
- [x] All existing tests still pass

**Verify:**

```bash
bun test src/memory/store.test.ts
```

---

### Task 2: TDD State CRUD + spec_events Logging on MemoryStore

**Objective:** Add methods to `MemoryStore` for reading/writing TDD cycle state and logging spec events. Also create the lightweight read-only state reader used by the guard hook.

**Dependencies:** Task 1

**Files:**

- Modify: `src/memory/store.ts` — Add TDD state methods + spec_events methods
- Create: `src/memory/tdd-state.ts` — Lightweight read-only state reader (bare SQLite, no MemoryStore)
- Create: `src/memory/tdd-state.test.ts` — Tests for both full CRUD and lightweight reader

**Methods to add to MemoryStore:**

```typescript
// TDD Cycle CRUD
getTddState(filePath: string): TddCycle | null
setTddState(opts: {
  filePath: string;
  state: TddCycleState;
  specId?: string;
  taskPosition?: number;
  testFilePath?: string;
  lastFailOutput?: string;
}): void
clearTddState(filePath: string): void
clearTddStatesForSpec(specId: string): void
listActiveTddStates(specId?: string): TddCycle[]

// Spec Events
logSpecEvent(opts: {
  specId: string;
  sessionId?: string;
  eventType: SpecEventType;
  details: Record<string, unknown>;
}): void
getSpecEvents(specId: string, limit?: number): SpecEvent[]
```

**Types to add to `src/memory/types.ts`:**

```typescript
export type TddCycleState =
  | "IDLE"
  | "TEST_WRITTEN"
  | "RED_CONFIRMED"
  | "GREEN_CONFIRMED";

export type SpecEventType =
  | "phase_change"
  | "task_update"
  | "tdd_cycle"
  | "verification"
  | "note";

export interface TddCycle {
  id: number;
  filePath: string;
  specId: string | null;
  taskPosition: number | null;
  state: TddCycleState;
  testFilePath: string | null;
  lastFailOutput: string | null;
  updatedAt: number;
}

export interface SpecEvent {
  id: number;
  specId: string;
  sessionId: string | null;
  timestamp: number;
  eventType: SpecEventType;
  details: Record<string, unknown>;
}
```

**Lightweight reader (`src/memory/tdd-state.ts`):**

```typescript
// Used by tdd-guard.ts — bare SQLite open, no MemoryStore init overhead
import { Database } from "bun:sqlite";
import { getDbPath } from "./store.js";
import type { TddCycleState } from "./types.js";

export function readTddState(filePath: string): TddCycleState {
  let db: Database | null = null;
  try {
    db = new Database(getDbPath(), { readonly: true });
    const row = db
      .query<
        { state: string },
        [string]
      >("SELECT state FROM tdd_cycles WHERE file_path = ?")
      .get(filePath);
    return (row?.state as TddCycleState) ?? "IDLE";
  } catch {
    return "IDLE"; // DB doesn't exist yet = no active TDD state
  } finally {
    db?.close();
  }
}
```

**Key Notes:**

- `setTddState` uses `INSERT OR REPLACE` (upsert on `file_path` UNIQUE constraint)
- `clearTddStatesForSpec` is called when a spec is cancelled or completed to clean up state
- The lightweight reader catches all errors and returns `"IDLE"` as default — if the DB doesn't exist or migration hasn't run yet, guard should not block
- `getDbPath()` must be exported from `store.ts` (check if already exported; add if not)

**Definition of Done:**

- [x] All 7 `MemoryStore` methods pass unit tests (`:memory:` SQLite)
- [x] `readTddState()` returns `"IDLE"` for unknown paths and when DB missing
- [x] `readTddState()` returns correct state for known paths
- [x] `logSpecEvent()` stores JSON-serialized details correctly
- [x] `getSpecEvents()` returns events in descending timestamp order
- [x] All tests pass

**Verify:**

```bash
bun test src/memory/tdd-state.test.ts
```

---

### Task 3: Extended SpecTask Types + Plan Parser Updates + getCurrentTask()

**Objective:** Extend `SpecTask` with rich metadata fields, update the plan parser to extract `Test Strategy` and `Definition of Done` from task sections, add `"failed"` to `TaskStatus`, and add `getCurrentTask()` to `SpecStore`.

**Dependencies:** Task 1

**Files:**

- Modify: `src/spec/types.ts` — Extend `SpecTaskSchema`, add `"failed"` to `TaskStatus`, add new `SpecStatus` values
- Modify: `src/spec/parser.ts` — Parse `**Test Strategy:**` and `**Definition of Done:**` from task blocks
- Modify: `src/spec/store.ts` — Update `syncFromPlanFile()` to persist new fields; add `getCurrentTask()`, `updateTaskStatus()`
- Modify: `src/spec/parser.test.ts` — Tests for new parser fields
- Modify: `src/spec/store.test.ts` — Tests for new store methods

**Type changes (`src/spec/types.ts`):**

```typescript
// Add to TASK_STATUSES:
export const TASK_STATUSES = [
  "pending",
  "in-progress",
  "complete",
  "failed",
] as const;

// Add to SPEC_STATUSES:
export const SPEC_STATUSES = [
  "PENDING",
  "IN_PROGRESS",
  "COMPLETE",
  "VERIFIED",
  "CANCELLED",
  "APPROVED",
  "DRAFT",
  "PLANNING",
  "IMPLEMENTING",
  "VERIFYING",
  "FAILED",
] as const;

// Extended SpecTaskSchema:
export const SpecTaskSchema = z.object({
  position: z.number().int().min(1),
  title: z.string().min(1),
  status: z.enum(TASK_STATUSES),
  description: z.string().optional(),
  testStrategy: z.string().optional(),
  definitionOfDone: z.string().optional(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
});
```

**Parser changes (`src/spec/parser.ts`):**

The existing parser reads task lines like `- [ ] Title` or `- [x] Title` from `## Progress Tracking` or `## Implementation Tasks` sections. It must also parse richer task blocks like:

```markdown
### 1. Create User entity and migration

- **Status:** pending
- **Test Strategy:** Unit test entity validation, integration test migration
- **Definition of Done:** Entity created, migration runs, tests pass
```

Parse rules:

- Task header: `### N. Title` (numbered heading) — position = N, title = rest
- `**Status:**` line → maps to `status` (normalize: "complete" → "complete", "in-progress" → "in-progress", "pending" → "pending", "failed" → "failed")
- `**Test Strategy:**` line → `testStrategy`
- `**Definition of Done:**` line → `definitionOfDone`
- Existing checkbox format `- [x] Title` still supported (simpler format for Progress Tracking sections)
- Parser must handle both formats in the same document (checkbox tasks in Progress Tracking, rich tasks in Implementation Tasks)

**New SpecStore methods:**

```typescript
// Returns the first task with status "in-progress", or first "pending" if none in-progress
getCurrentTask(specId: string): SpecTask | null

// Updates a single task's status (and started_at/completed_at timestamps)
updateTaskStatus(
  specId: string,
  position: number,
  status: TaskStatus,
  opts?: { startedAt?: number; completedAt?: number }
): void

// Get tasks for a spec (make public — currently private as getTasksForSpec)
getTasksForSpec(specId: string): SpecTask[]
```

**Key Notes:**

- `syncFromPlanFile()` must persist `testStrategy`, `definitionOfDone` to `spec_tasks` — update the `INSERT OR REPLACE` statement
- `getCurrentTask()` logic: `SELECT * FROM spec_tasks WHERE spec_id = ? AND status = 'in-progress' ORDER BY position LIMIT 1`; fallback to first `pending` task if none in-progress
- The parser should be purely additive — existing plan files without rich task metadata must continue to parse correctly

**Definition of Done:**

- [x] `parsePlanFile()` extracts `testStrategy` and `definitionOfDone` from `### N. Title` task sections
- [x] `parsePlanFile()` still correctly parses checkbox-style `- [x] Title` tasks
- [x] `syncFromPlanFile()` persists `testStrategy`, `definitionOfDone` to `spec_tasks`
- [x] `getCurrentTask()` returns `in-progress` task or first `pending` task
- [x] `"failed"` is a valid `TaskStatus`
- [x] New `SpecStatus` values (`DRAFT`, `PLANNING`, `IMPLEMENTING`, `VERIFYING`, `FAILED`) are valid
- [x] All parser tests pass (including new rich-format tests)
- [x] All store tests pass

**Verify:**

```bash
bun test src/spec/
```

---

### Task 4: Spec Relationship Helpers + getSpecsForSession()

**Objective:** Formalize the session → spec → task relationship by adding query methods that complete the navigation chain, and add a proper FK index from specs to sessions.

**Dependencies:** Task 1, Task 3

**Files:**

- Modify: `src/spec/store.ts` — Add `getSpecsForSession()`, `getSpecWithTasks()`
- Modify: `src/memory/migrations.ts` — Add index `idx_specs_session` in V7 migration
- Modify: `src/spec/store.test.ts` — Tests for new methods

**New SpecStore methods:**

```typescript
// All specs associated with a session (via specs.session_id)
getSpecsForSession(sessionId: string): Spec[]

// Get spec by ID with tasks pre-loaded (currently, getSpec() loads tasks separately)
getSpecWithTasks(specId: string): Spec | null
```

**Migration addition (append to `migrateV7()`):**

```sql
CREATE INDEX IF NOT EXISTS idx_specs_session ON specs(session_id);
```

**Key Notes:**

- `getSpecsForSession()` is the missing reverse-navigation path — previously `specs.session_id` was written but never queried
- This is used by the TDD guard to determine which spec is active for a session (complementing `getCurrentSpec(projectPath)` which uses recency-ordering rather than session affinity)
- `getSpecWithTasks()` is a convenience wrapper — internally calls `getSpec()` + `getTasksForSpec()`, returning a fully hydrated `Spec`

**Definition of Done:**

- [x] `getSpecsForSession(sessionId)` returns all specs with matching `session_id`
- [x] `getSpecsForSession()` returns empty array (not null) when no specs found
- [x] `getSpecWithTasks()` returns spec with `tasks` array populated
- [x] Index `idx_specs_session` created in V7 migration
- [x] All tests pass

**Verify:**

```bash
bun test src/spec/store.test.ts
```

---

### Task 5: tdd-tracker.ts PostToolUse Hook

**Objective:** Implement the PostToolUse hook that observes events and updates TDD state in SQLite. It tracks test file writes, test failures, and test passes — feeding state transitions that the guard hook reads.

**Dependencies:** Task 2, Task 3

**Files:**

- Create: `src/hooks/tdd-tracker.ts` — PostToolUse hook
- Create: `src/hooks/tdd-tracker.test.ts` — Unit tests
- Modify: `targets/claude-code/hooks/hooks.json` — Register tdd-tracker for Write|Edit|MultiEdit|Bash

**Hook logic:**

```typescript
export async function processTddTracking(input: HookInput): Promise<void> {
  const toolName = input.tool_name;
  const filePath = input.tool_input?.file_path as string | undefined;
  const output = input.tool_response?.output as string | undefined;

  const store = new MemoryStore();
  try {
    // Case 1: Test file written/edited
    if (isEditTool(toolName) && filePath && isTestFile(filePath)) {
      const spec = getActiveSpec(store, input.cwd);
      const task = spec ? store.getCurrentTask(spec.id) : null; // via SpecStore
      store.setTddState({
        filePath: getImplPathForTest(filePath) ?? filePath, // track impl file, not test file
        state: "TEST_WRITTEN",
        specId: spec?.id,
        taskPosition: task?.position,
        testFilePath: filePath,
      });
      if (spec) {
        store.logSpecEvent({
          specId: spec.id,
          sessionId: input.session_id,
          eventType: "tdd_cycle",
          details: {
            phase: "test_written",
            testFile: filePath,
            task: task?.position,
          },
        });
      }
    }

    // Case 2: Bash output shows test failure
    if (toolName === "Bash" && output && hasTestFailure(output)) {
      // Find the most recent impl file being worked on for this spec
      const spec = getActiveSpec(store, input.cwd);
      const states = store.listActiveTddStates(spec?.id);
      for (const cycle of states) {
        if (cycle.state === "TEST_WRITTEN") {
          store.setTddState({
            filePath: cycle.filePath,
            state: "RED_CONFIRMED",
            lastFailOutput: output.slice(0, 2000), // truncate
          });
        }
      }
      if (spec) {
        store.logSpecEvent({
          specId: spec.id,
          sessionId: input.session_id,
          eventType: "tdd_cycle",
          details: { phase: "red_confirmed" },
        });
      }
    }

    // Case 3: Bash output shows test pass (after RED_CONFIRMED)
    if (toolName === "Bash" && output && hasTestPass(output)) {
      const spec = getActiveSpec(store, input.cwd);
      const states = store.listActiveTddStates(spec?.id);
      for (const cycle of states) {
        if (cycle.state === "RED_CONFIRMED") {
          store.setTddState({
            filePath: cycle.filePath,
            state: "GREEN_CONFIRMED",
          });
          // Auto-advance to IDLE (cycle complete)
          store.clearTddState(cycle.filePath);
        }
      }
      if (spec) {
        store.logSpecEvent({
          specId: spec.id,
          sessionId: input.session_id,
          eventType: "tdd_cycle",
          details: { phase: "green_confirmed" },
        });
      }
    }
  } finally {
    store.close();
  }
}
```

Helper `getImplPathForTest(testFilePath)`: given `src/foo/bar.test.ts`, returns `src/foo/bar.ts`. Given `src/foo/bar.spec.ts`, returns `src/foo/bar.ts`. Returns null if mapping is ambiguous.

Helper `hasTestFailure(output)`: reuses `TEST_FAIL_INDICATORS` from `src/memory/capture.ts` — at least 1 indicator must match.

Helper `hasTestPass(output)`: reuses `TEST_PASS_INDICATORS` from `src/memory/capture.ts` — at least 1 indicator must match.

**hooks.json addition:**

```json
{
  "type": "PostToolUse",
  "matcher": "Write|Edit|MultiEdit|Bash",
  "hooks": [
    {
      "type": "command",
      "command": "bun \"${CLAUDE_PLUGIN_ROOT}/hooks/dist/hooks/tdd-tracker.js\"",
      "timeout": 10
    }
  ]
}
```

**Key Notes:**

- PostToolUse cannot block — it only updates state; the guard reads state on the next PreToolUse
- If no active spec → tracker runs but logs nothing (no spec to associate with)
- `getCurrentTask()` is via `SpecStore` — instantiate with the open `MemoryStore`
- Tracker should never throw/crash — wrap everything in try/catch; errors are silent

**Definition of Done:**

- [x] `processTddTracking()` exports a testable function
- [x] Test file Write/Edit → state transitions to `TEST_WRITTEN`
- [x] Bash with test failure → state transitions to `RED_CONFIRMED`
- [x] Bash with test pass + prior `RED_CONFIRMED` → state clears (cycle complete)
- [x] No active spec → no state changes, no errors
- [x] `spec_events` logged for each transition when spec is active
- [x] Hook registered in `hooks.json`
- [x] All tests pass

**Verify:**

```bash
bun test src/hooks/tdd-tracker.test.ts
```

---

### Task 6: tdd-guard.ts PreToolUse Hook

**Objective:** Implement the PreToolUse hook that blocks implementation file edits when TDD state is not `RED_CONFIRMED`. Uses the lightweight SQLite reader to minimize latency.

**Dependencies:** Task 2, Task 3

**Files:**

- Create: `src/hooks/tdd-guard.ts` — PreToolUse hook
- Create: `src/hooks/tdd-guard.test.ts` — Unit tests
- Modify: `targets/claude-code/hooks/hooks.json` — Register tdd-guard for Write|Edit|MultiEdit

**Hook logic:**

```typescript
export function processTddGuard(input: HookInput): DenyOutput | null {
  const toolName = input.tool_name;
  const filePath = input.tool_input?.file_path as string | undefined;

  // Only guard Write/Edit/MultiEdit
  if (!["Write", "Edit", "MultiEdit"].includes(toolName)) return null;
  if (!filePath) return null;

  // Test files always allowed
  if (isTestFile(filePath)) return null;

  // Only TypeScript/TSX implementation files
  if (!/\.(ts|tsx)$/.test(filePath)) return null;

  // Check if active spec exists for this project (lightweight check first)
  const state = readTddState(filePath); // lightweight: ~2ms

  // If no state record → check if spec is active (more expensive)
  // Only open MemoryStore if we might need to block
  if (state === "RED_CONFIRMED") return null; // allowed

  // Now check if there's an active spec — if not, don't block
  const store = new MemoryStore();
  try {
    const specStore = new SpecStore(store);
    const spec = specStore.getCurrentSpec(input.cwd);
    if (!spec) return null; // no active spec = no enforcement
  } finally {
    store.close();
  }

  // Active spec exists and state is not RED_CONFIRMED — block
  const stateDesc =
    {
      IDLE: "no test has been written yet",
      TEST_WRITTEN:
        "the test has been written but not confirmed to fail yet — run the test first",
      GREEN_CONFIRMED:
        "the previous cycle is complete — write a new failing test for the next requirement",
    }[state] ?? "TDD state is unknown";

  return deny(
    `[Sentinal TDD Guard] Cannot edit implementation file: ${stateDesc}.\n` +
      `Follow RED-GREEN-REFACTOR:\n` +
      `  1. Write a failing test in the companion test file\n` +
      `  2. Run the test and confirm it FAILS\n` +
      `  3. Then edit the implementation to make it pass`,
  );
}
```

**hooks.json addition:**

```json
{
  "type": "PreToolUse",
  "matcher": "Write|Edit|MultiEdit",
  "hooks": [
    {
      "type": "command",
      "command": "bun \"${CLAUDE_PLUGIN_ROOT}/hooks/dist/hooks/tdd-guard.js\"",
      "timeout": 5
    }
  ]
}
```

**Main function pattern:**

```typescript
async function main() {
  const input = await readStdin();
  const result = processTddGuard(input);
  if (result) {
    output(result);
    process.exit(2); // deny
  }
}

if (import.meta.main) {
  main().catch(console.error);
}
```

**Key Notes:**

- Fast path: if `readTddState()` returns `RED_CONFIRMED`, return null immediately without opening MemoryStore
- Slow path: open MemoryStore only when we might need to block (state is IDLE/TEST_WRITTEN/GREEN_CONFIRMED)
- `MultiEdit` tool_input has multiple file paths — check all of them; block if any is not allowed
- The deny message must be actionable — tell the AI exactly what to do next

**Definition of Done:**

- [x] `processTddGuard()` exports a testable function
- [x] Returns null (pass) for: test files, non-TS files, no active spec, `RED_CONFIRMED` state
- [x] Returns `DenyOutput` for: implementation `.ts`/`.tsx` files with active spec and non-RED state
- [x] Deny message clearly explains what state was found and what to do
- [x] `IDLE` → blocked with "no test has been written yet"
- [x] `TEST_WRITTEN` → blocked with "confirm it fails first"
- [x] `GREEN_CONFIRMED` → blocked with "write next failing test"
- [x] Hook registered in `hooks.json` before existing Write|Edit|MultiEdit handlers
- [x] All tests pass

**Verify:**

```bash
bun test src/hooks/tdd-guard.test.ts
```

---

### Task 7: OpenCode Plugin Integration

**Objective:** Add TDD tracking and enforcement to `targets/opencode/plugins/sentinal.ts` — equivalent behavior to the Claude Code hooks but using OpenCode's in-process plugin API.

**Dependencies:** Task 2, Task 5, Task 6

**Files:**

- Modify: `targets/opencode/plugins/sentinal.ts` — Add TDD guard to `tool.execute.before`, TDD tracker to `tool.execute.after`

**In-process advantage:** OpenCode runs the plugin in-process alongside the AI loop. The `MemoryStore` instance is shared across all tool executions in a session — instantiate once in the plugin's initialization and reuse throughout. No DB open/close overhead per tool call.

**Guard (tool.execute.before):**

```typescript
// Add to tool.execute.before handler:
if (["write", "edit", "patch"].includes(tool) && params?.filePath) {
  const filePath = params.filePath as string;
  if (!isTestFile(filePath) && /\.(ts|tsx)$/.test(filePath)) {
    const spec = specStore.getCurrentSpec(cwd);
    if (spec) {
      const state = store.getTddState(filePath);
      if (!state || state.state !== "RED_CONFIRMED") {
        const stateStr = state?.state ?? "IDLE";
        throw new Error(
          `[Sentinal TDD Guard] Cannot edit implementation file: ${stateStr}.\n` +
            `Write a failing test first, confirm it fails, then implement.`,
        );
      }
    }
  }
}
```

**Tracker (tool.execute.after):**

```typescript
// Add to tool.execute.after handler:
if (["write", "edit", "patch"].includes(tool) && params?.filePath) {
  if (isTestFile(params.filePath)) {
    // Track test file write
    store.setTddState({ filePath: getImplPath(params.filePath), state: "TEST_WRITTEN", ... });
  }
}
if (tool === "bash" && result?.output) {
  if (hasTestFailure(result.output)) {
    // Transition TEST_WRITTEN → RED_CONFIRMED
    for (const cycle of store.listActiveTddStates(activeSpec?.id)) {
      if (cycle.state === "TEST_WRITTEN") {
        store.setTddState({ filePath: cycle.filePath, state: "RED_CONFIRMED", ... });
      }
    }
  }
  if (hasTestPass(result.output)) {
    // Transition RED_CONFIRMED → IDLE (cycle complete)
    for (const cycle of store.listActiveTddStates(activeSpec?.id)) {
      if (cycle.state === "RED_CONFIRMED") {
        store.clearTddState(cycle.filePath);
      }
    }
  }
}
```

**Key Notes:**

- OpenCode uses `throw new Error(...)` in `tool.execute.before` to block tool execution
- The shared `MemoryStore` instance means `getTddState()` uses full MemoryStore (not the lightweight reader) — acceptable since there's no per-call open/close overhead
- Use the same `isTestFile()`, `hasTestFailure()`, `hasTestPass()` helpers as the Claude Code hooks
- Import shared logic from `@endpoint/sentinal` package path

**Definition of Done:**

- [x] `tool.execute.before` blocks implementation edits when not `RED_CONFIRMED`
- [x] `tool.execute.after` tracks test writes, failures, passes
- [x] Shared `MemoryStore` instance reused (not re-instantiated per tool call)
- [x] Error message matches Claude Code guard message
- [x] Both guard and tracker are gated on active spec existing
- [x] All existing OpenCode plugin tests still pass

**Verify:**

```bash
bun test targets/opencode/
```

---

### Task 8: Template Updates + Barrel Exports + Regenerate Commands

**Objective:** Update the `spec-implement.md` template to document TDD enforcement, add all new public types and functions to `src/index.ts`, and regenerate command files for both targets.

**Dependencies:** Task 5, Task 6, Task 7

**Files:**

- Modify: `templates/commands/spec-implement.md` — Add enforcement notice
- Modify: `src/index.ts` — Export new types and functions
- Modify: `targets/claude-code/commands/spec-implement.md` — Regenerate
- Modify: `targets/opencode/commands/spec-implement.md` — Regenerate

**Template addition (add after the "Model" hint at the top of spec-implement.md):**

```markdown
> **TDD Enforcement Active:** During active specs, Sentinal enforces RED-GREEN-REFACTOR
> programmatically. Implementation file edits will be blocked until you:
>
> 1. Write a failing test in the companion test file
> 2. Run the test and see it FAIL
> 3. The guard automatically unlocks once failure is confirmed
```

**Barrel exports to add (`src/index.ts`):**

```typescript
// TDD state
export { readTddState } from "./memory/tdd-state.js";
export type {
  TddCycle,
  TddCycleState,
  SpecEvent,
  SpecEventType,
} from "./memory/types.js";

// Spec store new methods (already exported via SpecStore class)
// No additional exports needed — methods are on the SpecStore instance
```

**Definition of Done:**

- [x] `spec-implement.md` template mentions TDD enforcement with clear instructions
- [x] Regenerated commands in both `targets/claude-code/commands/` and `targets/opencode/commands/`
- [x] `readTddState`, `TddCycle`, `TddCycleState`, `SpecEvent`, `SpecEventType` exported from `src/index.ts`
- [x] All tests pass
- [x] `bun run build:claude` succeeds

**Verify:**

```bash
bun test && bun run build:claude
```

---

## Testing Strategy

- **Migration tests:** Verify V7 runs on V6 database; idempotency check
- **TDD state tests:** All state transitions via `MemoryStore` CRUD; lightweight reader on missing/existing DB
- **Parser tests:** Rich task format (test strategy, DoD) + existing checkbox format in same document
- **Store tests:** `getCurrentTask()` with in-progress/pending/no tasks; `getSpecsForSession()`
- **Hook tests:** Mock `HookInput`, assert output — patterns from `src/hooks/tool-redirect.test.ts`
  - Guard: returns null for allowed cases, `DenyOutput` for blocked cases
  - Tracker: correct state transitions per tool/output combination
- **OpenCode tests:** Plugin handler assertions for TDD guard and tracker

**Target test count:** ~50 new tests across all tasks

## Architecture Notes

### Why Lightweight SQLite Reader for Guard

The TDD guard runs on every Write/Edit/MultiEdit PreToolUse event — potentially dozens of times per session. The full `MemoryStore` constructor:

1. Resolves DB path
2. Opens `bun:sqlite` Database
3. Runs `PRAGMA journal_mode = WAL`
4. Runs `PRAGMA foreign_keys = ON`
5. Calls `runMigrations()` (reads `schema_version` table, compares to constant)

That's ~5-10ms per invocation. The lightweight reader:

1. Opens Database read-only
2. Runs single `SELECT state FROM tdd_cycles WHERE file_path = ?`
3. Closes

That's ~1-2ms. Over a session with 100 file edits, this saves 300-800ms of unnecessary overhead.

The tracker uses full `MemoryStore` because it needs write access and migration safety — this is acceptable since PostToolUse is fire-and-forget (latency doesn't block the AI).

### Future Optimization: MCP HTTP Sidecar

The MCP server (`sentinal mcp-server`) runs for the entire session with a warm DB connection. If hooks could call a local HTTP endpoint on the MCP server, all DB access would be near-instant. This requires:

1. MCP server listens on a local HTTP port alongside stdio transport
2. Hooks call `fetch("http://localhost:PORT/api/tdd-state?file=...")` instead of opening SQLite
3. Port written to `~/.sentinal/mcp.port` on server start

This is a significant refactor affecting all hooks. Deferred to a separate spec. The lightweight reader is the pragmatic bridge until then.

### Spec/Plan Equivalence

A **plan** (markdown file) and a **spec** (SQLite record) are two representations of the same thing:

- `/spec-plan` creates the markdown file → `syncFromPlanFile()` creates the SQLite record
- `sentinal register-plan <path>` is the CLI equivalent of `syncFromPlanFile()`
- A session can work on many specs; `specs.session_id` tracks which session last synced a spec
- The TDD guard uses `getCurrentSpec(projectPath)` (recency-based) as the primary spec lookup during enforcement — it doesn't require session affinity

## Risks and Mitigations

| Risk                                                              | Likelihood | Impact | Mitigation                                                                  |
| ----------------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------- |
| Guard blocks AI in a loop (can't write test OR impl)              | Low        | High   | Guard allows test file writes always; deny message explains exact next step |
| False positives from TEST_FAIL_INDICATORS on non-test Bash output | Medium     | Low    | Requires at least 1 pattern match; PostToolUse only (no blocking)           |
| DB lock contention between tracker (write) and guard (read)       | Low        | Medium | WAL mode allows concurrent readers; reader uses readonly flag               |
| Guard overhead slows development workflow                         | Low        | Low    | Lightweight reader targets ~2ms; only runs during active spec               |
| OpenCode plugin shared state causes cross-spec contamination      | Low        | Medium | `listActiveTddStates(spec.id)` scopes state to current spec                 |
