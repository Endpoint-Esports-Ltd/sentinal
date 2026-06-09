# Phase 2: Claude Code Lifecycle Hooks

Created: 2026-04-20
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature
Parent: 2026-04-20-claude-opencode-changelog-audit
Wave: 1

## Summary

**Goal:** Add 7 new Claude Code hook handlers, refactor 2 existing hooks to consume new CC API fields, and wire OpenCode parity for the 3 hooks with OC equivalents — expanding Sentinal's lifecycle coverage from 7 events / 14 hooks to 14 events / 21 hooks.

**Architecture:** Each new hook follows the established pattern: a testable pure function exported from `src/hooks/<name>.ts`, dispatched via `src/cli/commands/hook.ts`, wired into `targets/claude-code/hooks/hooks.json`, and (for 3 hooks) mapped to OpenCode equivalents in `targets/opencode/plugins/sentinal.ts`. The `HookInput` type in `src/utils/hook-output.ts` will be extended with all new optional fields.

**Tech Stack:** TypeScript (bun:test), sidecar HTTP routes for hooks needing state access.

## Scope

### In Scope

**7 new Claude Code hook handlers:**

1. `StopFailure` — persist partial progress on API error, notify dashboard (CC-only)
2. `ConfigChange` — detect disabled hooks, feed rules changes to memory (CC-only)
3. `InstructionsLoaded` — record which rules loaded per session (CC + OC parity)
4. `CwdChanged` — invalidate project-context cache (CC-only)
5. `FileChanged` — invalidate TDD state when tests modified externally (CC-only)
6. `PostCompact` — verify compacted context restored correctly (CC + OC parity)
7. `TaskCreated` — track background tasks in dashboard (CC + OC parity)

**2 existing hook refactors:** 8. `pre-edit-guide` — use structured `additionalContext` return, consume `effort.level` for guidance verbosity 9. `memory-observer` + `spec-stop-guard` — consume `last_assistant_message`, `agent_id`/`agent_type`, `duration_ms`

**Infrastructure:** 10. Extend `HookInput` type with all new optional fields 11. Wire all hooks into `hooks.json` and CLI dispatch 12. Add OpenCode parity for InstructionsLoaded, PostCompact, TaskCreated

### Out of Scope

- HTTP hooks conversion (Phase 4)
- `updatedToolOutput` adoption for file-checker (Phase 4 scope, when hooks move to HTTP)
- OpenCode `compaction.autocontinue` (Phase 3)
- Agent frontmatter hooks delivery mechanism (future, not required for this phase)
- Permission middleware / `continueOnBlock` (Phase 5)

## Context for Implementer

### Hook implementation pattern

Every hook follows this template (see `src/hooks/file-checker.ts:1-85` for the canonical example):

```typescript
import { readStdin, hint, output } from "../utils/hook-output.js";
import type { HookInput } from "../utils/hook-output.js";

// 1. Export testable pure function
export async function processMyHook(input: HookInput): Promise<string | null> {
  // Extract event-specific fields, do work, return context string or null
}

// 2. Main entry (Claude Code subprocess)
async function main(): Promise<void> {
  const input = await readStdin();
  const result = await processMyHook(input);
  if (result) output(hint("EventName", result));
}

// 3. Guard for direct execution only
if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(String(err));
    process.exit(1);
  });
}
```

### CLI dispatch pattern

`src/cli/commands/hook.ts:485-501` has two dispatch tables: `SHARED_HOOKS` (11 entries) and `CLAUDE_HOOKS` (3 entries). Each entry maps a name to an async function that dynamically imports the hook module, calls `readStdin()`, and invokes the exported handler. Add new hooks to the appropriate table.

**Warning:** `hook.ts` is 538 lines — near the 600-line block threshold. New dispatch wrappers should be minimal (~5 lines each). If the file exceeds 400 lines after changes, consider extracting the dispatch tables to a separate `hook-dispatch.ts`.

### hooks.json structure

`targets/claude-code/hooks/hooks.json` defines the pipeline. Each entry needs: event name, matcher (or empty for "match all"), an inner `hooks` array with `type: "command"`, `command: "sentinal hook <scope> <name>"`, and optional `timeout`, `async`, `once`, `if` fields.

### Sidecar integration

Hooks that need persistent state (memory, TDD, notifications) use `SidecarClient.connect()` → null means sidecar unavailable → fall back to direct store access or skip gracefully. See `src/hooks/pre-edit-guide.ts:60-90` for the pattern.

### OpenCode parity

For hooks with OC equivalents, the shared logic stays in `src/hooks/<name>.ts`. The OC plugin at `targets/opencode/plugins/sentinal.ts` imports and calls the same function from its event handler. The 3 hooks with OC equivalents:

- `InstructionsLoaded` → fires implicitly in `session.created` handler (line 801)
- `PostCompact` → `experimental.session.compacting` handler (line 664, post-phase)
- `TaskCreated` → detect subagent sessions in `session.created` handler (line 801)

### HookInput extension

Current `HookInput` (8 fields) in `src/utils/hook-output.ts:1-14`. Extend with all new optional fields. Each hook checks the fields it needs — no runtime validation, just TypeScript optionals.

### Key files

| File                                   | Lines | Role                                                |
| -------------------------------------- | ----- | --------------------------------------------------- |
| `src/utils/hook-output.ts`             | 70    | HookInput type + output helpers                     |
| `src/cli/commands/hook.ts`             | 538   | CLI dispatch (`sentinal hook shared/claude <name>`) |
| `targets/claude-code/hooks/hooks.json` | ~100  | Hook pipeline definition                            |
| `targets/opencode/plugins/sentinal.ts` | ~1008 | OpenCode plugin (exempt from line limits)           |
| `src/hooks/file-checker.ts`            | 85    | Template for new hooks                              |
| `src/hooks/pre-edit-guide.ts`          | 162   | Refactor target                                     |
| `src/hooks/spec-stop-guard.ts`         | 16    | Refactor target                                     |

### Gotchas

- `hook.ts` has `memory-observer` logic inlined (lines 144-229) rather than in a separate file. The refactor should extract it to `src/hooks/memory-observer.ts`.
- `StopFailure` hooks have exit codes and output ignored by Claude Code — the hook runs for side effects only (notifications, state persistence).
- `async: true` hooks cannot block or deny — they can only return `additionalContext`.
- `FileChanged` uses the `matcher` field as a literal filename watch list, not a regex.
- `CwdChanged` does not support matchers — always fires on every directory change.

## Assumptions

- Claude Code ≥2.1.84 is the minimum version for all 7 new events — supported by changelog entries — all tasks depend on this.
- The `HookInput` JSON shape matches the documented schemas from `code.claude.com/docs/en/hooks` — all tasks depend on this.
- `hook.ts` line count is safe: currently 538 lines. Task 10 (Wave 1) adds ~35 lines of dispatch entries (→ ~573). Task 9 (Wave 2) extracts ~85 lines of memory-observer inline code (→ ~488). Final state is well within limits. Temporary peak of ~573 is under the 600-line block threshold. Task 10 must NOT include the extraction — that's Task 9's job.
- OpenCode's `session.created` fires before the LLM starts processing — supported by current plugin behavior — Tasks 11 (OC parity) depend on this.

## Testing Strategy

- **Unit tests** for each new hook: 3+ test cases per hook (happy path, missing fields, edge cases). Tests import the exported pure function directly, feed it a mock `HookInput`, assert on return value.
- **Refactor tests**: existing tests for `pre-edit-guide`, `memory-observer`, `spec-stop-guard` updated to cover new fields.
- **Integration**: no E2E needed — hooks are pure functions consuming JSON and returning JSON. CLI dispatch is tested by existing hook dispatch tests.
- **Full gate**: `bun test src/hooks/ && bun test src/cli/commands/hook.test.ts && bunx tsc --noEmit`

## Risks and Mitigations

| Risk                                                | Likelihood | Impact | Mitigation                                                                                                          |
| --------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| `hook.ts` exceeds 600-line block threshold          | Medium     | Medium | Each new dispatch entry is ~5 lines. If 573+ is too close, extract dispatch tables to `hook-dispatch.ts` in Task 10 |
| CC hook event schemas change in future versions     | Low        | Medium | Each hook uses optional field access (`input.field_path ?? fallback`); graceful degradation on missing fields       |
| Sidecar unavailable when hooks fire                 | Medium     | Low    | All hooks have fallback to direct store access or silent no-op (established pattern)                                |
| OpenCode plugin grows too large with 3 new handlers | Low        | Low    | Plugin is exempt from line limits; new code is ~10-15 lines per handler (import + call)                             |

## Pre-Mortem

_Assume this plan failed after full execution. Most likely internal reasons:_

1. **StopFailure hook silently fails to persist partial progress** (Task 1) — Trigger: sidecar is down during an API error (the exact time you most need persistence). Mitigation: StopFailure must have direct-store fallback, not just sidecar path.
2. **ConfigChange hook floods memory with noise** (Task 2) — Trigger: every settings.json auto-save creates a memory observation, drowning useful observations. Mitigation: only capture observations for `.sentinal/rules/*.md` changes, not every config change; use debounce if needed.
3. **FileChanged hook invalidates TDD state too aggressively** (Task 5) — Trigger: file watcher fires on `git checkout` touching test files, clearing TDD state mid-cycle. Mitigation: only invalidate for the specific test file that changed, not all TDD state; check if the change was external (not from a Claude Code tool).

## Execution Waves

**Wave 1 — Infrastructure + Independent Hooks (parallel):** Tasks 1-9 each modify different files (`src/hooks/<name>.ts` + test). Task 10 (HookInput + hooks.json + dispatch) touches shared files but is a prerequisite.

Given `hook.ts` is a shared dependency for dispatch wiring, the execution order is:

- **Wave 1:** Task 10 (infrastructure: HookInput type, hooks.json entries, CLI dispatch)
- **Wave 2:** Tasks 1-9 (all hook implementations, parallel — each in its own `src/hooks/<name>.ts`)
- **Wave 3:** Task 11 (OpenCode parity — touches `sentinal.ts`, depends on shared logic from Wave 2)

## Goal Verification

### Truths

1. `src/utils/hook-output.ts` contains `error?:`, `last_assistant_message?:`, `agent_id?:`, `agent_type?:`, `duration_ms?:`, `file_path?:` in the `HookInput` interface (grep-verifiable).
2. `targets/claude-code/hooks/hooks.json` contains entries for `StopFailure`, `ConfigChange`, `InstructionsLoaded`, `CwdChanged`, `FileChanged`, `PostCompact`, `TaskCreated` (grep-verifiable: 7 new event names).
3. `src/hooks/stop-failure.ts` exports `processStopFailure` (grep-verifiable).
4. `src/hooks/config-change.ts` exports `processConfigChange` (grep-verifiable).
5. `src/hooks/instructions-loaded.ts` exports `processInstructionsLoaded` (grep-verifiable).
6. `src/hooks/cwd-changed.ts` exports `processCwdChanged` (grep-verifiable).
7. `src/hooks/file-changed.ts` exports `processFileChanged` (grep-verifiable).
8. `src/hooks/post-compact.ts` exports `processPostCompact` (grep-verifiable).
9. `src/hooks/task-created.ts` exports `processTaskCreated` (grep-verifiable).
10. `bun test src/hooks/stop-failure.test.ts && bun test src/hooks/config-change.test.ts && bun test src/hooks/instructions-loaded.test.ts && bun test src/hooks/cwd-changed.test.ts && bun test src/hooks/file-changed.test.ts && bun test src/hooks/post-compact.test.ts && bun test src/hooks/task-created.test.ts` all pass.
11. `src/hooks/spec-stop-guard.ts` contains `last_assistant_message` reference (grep-verifiable).
12. `targets/opencode/plugins/sentinal.ts` imports from `instructions-loaded`, `post-compact`, or `task-created` (grep-verifiable).

### Artifacts

| Artifact                                          | Provides                    | Exports                                    |
| ------------------------------------------------- | --------------------------- | ------------------------------------------ |
| `src/utils/hook-output.ts` (modified)             | Extended HookInput type     | `HookInput` with 15+ new optional fields   |
| `src/hooks/stop-failure.ts` (new)                 | StopFailure handler         | `processStopFailure()`                     |
| `src/hooks/config-change.ts` (new)                | ConfigChange handler        | `processConfigChange()`                    |
| `src/hooks/instructions-loaded.ts` (new)          | InstructionsLoaded handler  | `processInstructionsLoaded()`              |
| `src/hooks/cwd-changed.ts` (new)                  | CwdChanged handler          | `processCwdChanged()`                      |
| `src/hooks/file-changed.ts` (new)                 | FileChanged handler         | `processFileChanged()`                     |
| `src/hooks/post-compact.ts` (new)                 | PostCompact handler         | `processPostCompact()`                     |
| `src/hooks/task-created.ts` (new)                 | TaskCreated handler         | `processTaskCreated()`                     |
| `src/hooks/memory-observer.ts` (new)              | Extracted from hook.ts      | `processMemoryObserver()`                  |
| `src/hooks/pre-edit-guide.ts` (modified)          | Refactored output           | `processPreEditGuide()` (unchanged export) |
| `src/hooks/spec-stop-guard.ts` (modified)         | Consumes new fields         | `processSpecStopGuard()`                   |
| `src/cli/commands/hook.ts` (modified)             | 7 new dispatch entries      | Updated `SHARED_HOOKS` + `CLAUDE_HOOKS`    |
| `targets/claude-code/hooks/hooks.json` (modified) | 7 new hook pipeline entries | N/A (JSON data)                            |
| `targets/opencode/plugins/sentinal.ts` (modified) | 3 OC parity handlers        | N/A (plugin handlers)                      |

### Key Links

| From                                   | To                                 | Via                                 | Pattern                       |
| -------------------------------------- | ---------------------------------- | ----------------------------------- | ----------------------------- |
| `targets/claude-code/hooks/hooks.json` | `src/hooks/stop-failure.ts`        | `sentinal hook shared stop-failure` | `"stop-failure"`              |
| `src/cli/commands/hook.ts`             | `src/hooks/stop-failure.ts`        | dynamic import + dispatch           | `import.*stop-failure`        |
| `src/hooks/stop-failure.ts`            | `src/sidecar/client.ts`            | sidecar notification                | `SidecarClient`               |
| `targets/opencode/plugins/sentinal.ts` | `src/hooks/instructions-loaded.ts` | import                              | `import.*instructions-loaded` |
| `src/hooks/memory-observer.ts`         | `src/sidecar/client.ts`            | observation posting                 | `SidecarClient`               |

## Progress Tracking

- [x] Task 10: Infrastructure — HookInput type extension + hooks.json + CLI dispatch (Wave 1)
- [x] Task 1: StopFailure hook (Wave 2)
- [x] Task 2: ConfigChange hook (Wave 2)
- [x] Task 3: InstructionsLoaded hook (Wave 2)
- [x] Task 4: CwdChanged hook (Wave 2)
- [x] Task 5: FileChanged hook (Wave 2)
- [x] Task 6: PostCompact hook (Wave 2)
- [x] Task 7: TaskCreated hook (Wave 2)
- [x] Task 8: pre-edit-guide refactor (Wave 2)
- [x] Task 9: memory-observer + spec-stop-guard refactor (Wave 2)
- [x] Task 11: OpenCode parity for InstructionsLoaded, PostCompact, TaskCreated (Wave 3)
      **Total Tasks:** 11 | **Completed:** 11 | **Remaining:** 0

## Implementation Tasks

### Task 10: Infrastructure — HookInput Extension + hooks.json + CLI Dispatch

**Objective:** Extend the HookInput type with all new event fields, add 7 hook entries to hooks.json, and add 7 dispatch entries to hook.ts.
**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `src/utils/hook-output.ts`
- Modify: `targets/claude-code/hooks/hooks.json`
- Modify: `src/cli/commands/hook.ts`

**Key Decisions / Notes:**

- **HookInput extension** (`hook-output.ts:1-14`): Add these optional fields:
  ```typescript
  // StopFailure
  error?: string;
  error_details?: string;
  // Stop/StopFailure/SubagentStop
  last_assistant_message?: string;
  stop_hook_active?: boolean;
  agent_id?: string;
  agent_type?: string;
  background_tasks?: unknown[];
  session_crons?: unknown[];
  // ConfigChange
  source?: string;
  // InstructionsLoaded
  file_path?: string;
  memory_type?: string;
  load_reason?: string;
  // CwdChanged
  old_cwd?: string;
  new_cwd?: string;
  // FileChanged
  event?: string; // "change" | "create" | "delete"
  // TaskCreated
  task_id?: string;
  task_subject?: string;
  task_description?: string;
  teammate_name?: string;
  team_name?: string;
  // PostToolUse (new in 2.1.119)
  duration_ms?: number;
  // Effort (new in 2.1.133)
  effort?: { level?: string };
  ```
- **hooks.json entries** — 7 new entries. Use these configurations:
  | Event | Matcher | Scope | Timeout | Async |
  |-------|---------|-------|---------|-------|
  | `StopFailure` | (empty — match all) | shared | 5s | no (output ignored anyway) |
  | `ConfigChange` | `project_settings\|skills` | shared | 5s | yes |
  | `InstructionsLoaded` | (empty) | shared | 5s | yes |
  | `CwdChanged` | (no matcher support) | shared | 5s | no |
  | `FileChanged` | `.envrc\|*.test.ts\|*.spec.ts` | shared | 5s | yes |
  | `PostCompact` | (empty) | shared | 5s | no |
  | `TaskCreated` | (no matcher support) | shared | 5s | yes |
- **CLI dispatch** — Add 7 entries to `SHARED_HOOKS` in `hook.ts`. Each is a ~5-line async function that dynamically imports the hook module.
- **Matcher verification** — Matcher syntax differs per event type. `FileChanged` uses literal filename matching (not regex); `ConfigChange` uses source-type matching (`project_settings|skills`); `CwdChanged` and `TaskCreated` don't support matchers at all. Verify each matcher against CC docs during implementation. If a matcher doesn't work as expected, fall back to filtering inside the hook handler instead.

**Definition of Done:**

- [ ] HookInput has all new optional fields with JSDoc comments
- [ ] hooks.json has 7 new entries (total: 21 entries)
- [ ] hook.ts has 7 new entries in SHARED_HOOKS (total: 18 shared + 3 claude = 21)
- [ ] `bunx tsc --noEmit` passes
- [ ] hook.ts stays under 600 lines

**Verify:**

- `grep -c "hook_event_name" targets/claude-code/hooks/hooks.json` → 21+ (7 events × 3 entries avg)
- `grep -c "StopFailure\|ConfigChange\|InstructionsLoaded\|CwdChanged\|FileChanged\|PostCompact\|TaskCreated" targets/claude-code/hooks/hooks.json` → 7
- `wc -l src/cli/commands/hook.ts` → <600

---

### Task 1: StopFailure Hook

**Objective:** When a turn ends from an API error, persist partial spec progress and notify the dashboard.
**Dependencies:** Task 10
**Wave:** 2

**Files:**

- Create: `src/hooks/stop-failure.ts`
- Create: `src/hooks/stop-failure.test.ts`

**Key Decisions / Notes:**

- **Input fields:** `error` (rate_limit, authentication_failed, etc.), `error_details` (HTTP status text), `last_assistant_message`.
- **Behavior:**
  1. If an active spec is in progress (`SidecarClient.specStatus()`), save a memory observation of type `error` with the error details + last assistant message snippet.
  2. Send a dashboard notification (`SidecarClient.insertNotification()`) with `type: "warning"`, title: `"API Error: {error}"`.
  3. Do NOT mark any spec task as complete — the model bailed, not finished.
- **No blocking:** StopFailure output is ignored by CC — this hook is side-effect only.
- **Sidecar fallback:** If sidecar unavailable, log to stderr and exit 0 (silent degradation).
- **Pattern:** Follow `file-checker.ts` template.

**Definition of Done:**

- [ ] `processStopFailure()` exported from `src/hooks/stop-failure.ts`
- [ ] 3 test cases: with active spec, without active spec, sidecar unavailable
- [ ] All tests pass

**Verify:** `bun test src/hooks/stop-failure.test.ts`

---

### Task 2: ConfigChange Hook

**Objective:** Detect when Sentinal hooks get disabled mid-session; feed rules changes to memory.
**Dependencies:** Task 10
**Wave:** 2

**Files:**

- Create: `src/hooks/config-change.ts`
- Create: `src/hooks/config-change.test.ts`

**Key Decisions / Notes:**

- **Input fields:** `source` (project_settings, skills, etc.), `file_path`.
- **Behavior:**
  1. If `file_path` matches `.sentinal/rules/*.md` or `CLAUDE.md`, save a memory observation of type `discovery` noting which rule file changed.
  2. If `file_path` matches `**/settings.json` or `**/hooks.json`, check if `disableAllHooks` was set. If so, warn via dashboard notification.
  3. **Volume control:** The path filter (only `.sentinal/rules/*.md` and `CLAUDE.md`) limits observations to a handful of files per session — no additional dedup mechanism needed. If a rules file is edited multiple times in one session, each observation is useful context.
- **async: true** in hooks.json — this hook cannot block.
- **Matcher:** `project_settings|skills` — only fires on project settings and skills changes, not user-level settings.

**Definition of Done:**

- [ ] `processConfigChange()` exported from `src/hooks/config-change.ts`
- [ ] 3 test cases: rules file change, hooks disabled detection, non-sentinal config change (no-op)
- [ ] All tests pass

**Verify:** `bun test src/hooks/config-change.test.ts`

---

### Task 3: InstructionsLoaded Hook

**Objective:** Record which rules/instructions files loaded per session — powers `/sync` decisions.
**Dependencies:** Task 10
**Wave:** 2

**Files:**

- Create: `src/hooks/instructions-loaded.ts`
- Create: `src/hooks/instructions-loaded.test.ts`

**Key Decisions / Notes:**

- **Input fields:** `file_path`, `memory_type` (Project, User, etc.), `load_reason` (session_start, nested_traversal, path_glob_match, include, compact).
- **Behavior:**
  1. Save a memory observation of type `discovery` recording: file loaded, memory_type, load_reason.
  2. Only capture on `load_reason === "session_start"` or `"path_glob_match"` — skip `compact` (re-load) and `include` (transitive) to avoid noise.
- **async: true** — non-blocking.

**Definition of Done:**

- [ ] `processInstructionsLoaded()` exported
- [ ] 3 test cases: session_start load, compact load (skipped), path_glob_match load
- [ ] All tests pass

**Verify:** `bun test src/hooks/instructions-loaded.test.ts`

---

### Task 4: CwdChanged Hook

**Objective:** Invalidate the project-context cache when the working directory changes.
**Dependencies:** Task 10
**Wave:** 2

**Files:**

- Create: `src/hooks/cwd-changed.ts`
- Create: `src/hooks/cwd-changed.test.ts`
- Modify: `src/sidecar/project-routes.ts` (add `POST /project-context/invalidate` route)
- Modify: `src/sidecar/client.ts` (add `invalidateProjectContext()` method)

**Key Decisions / Notes:**

- **Input fields:** `old_cwd`, `new_cwd`.
- **Behavior:**
  1. Call sidecar `POST /project-context/invalidate` via `SidecarClient.invalidateProjectContext()` to clear the in-memory project context cache.
  2. If no sidecar, no-op (cache will be stale but will refresh on next explicit query).
- **Simplest hook** — just a cache invalidation trigger.
- **New sidecar route:** `POST /project-context/invalidate` in `project-routes.ts` — clears the cached project context so the next `GET /project-context` re-analyzes. If `project-routes.ts` already has a cache mechanism, use its built-in invalidation. If the project context is computed fresh on every request (no cache), this route can be a no-op and Task 4 becomes even simpler.

**Definition of Done:**

- [ ] `processCwdChanged()` exported
- [ ] 2 test cases: with sidecar (invalidation called), without sidecar (silent no-op)
- [ ] All tests pass

**Verify:** `bun test src/hooks/cwd-changed.test.ts`

---

### Task 5: FileChanged Hook

**Objective:** Invalidate TDD tracker state when test files are modified externally.
**Dependencies:** Task 10
**Wave:** 2

**Files:**

- Create: `src/hooks/file-changed.ts`
- Create: `src/hooks/file-changed.test.ts`

**Key Decisions / Notes:**

- **Input fields:** `file_path`, `event` ("change", "create", "delete").
- **Matcher in hooks.json:** `.envrc|*.test.ts|*.spec.ts` — only watches test files and envrc.
- **Behavior:**
  1. If `file_path` matches `*.test.ts` or `*.spec.ts`: clear TDD state for the corresponding implementation file via sidecar `POST /tdd-state` with action `clear`.
  2. If `file_path` matches `.envrc`: no-op for now (placeholder for future direnv integration).
- **Guard against self-triggered changes:** If the hook fires from a Claude Code tool edit, the TDD tracker already handles it. Add a debounce check — if a TDD state transition happened within the last 2 seconds for this file, skip.
- **async: true** — non-blocking.

**Definition of Done:**

- [ ] `processFileChanged()` exported
- [ ] 3 test cases: test file changed (TDD cleared), non-test file (no-op), envrc (no-op)
- [ ] All tests pass

**Verify:** `bun test src/hooks/file-changed.test.ts`

---

### Task 6: PostCompact Hook

**Objective:** Verify compacted context was restored correctly; re-inject critical rules if missing.
**Dependencies:** Task 10
**Wave:** 2

**Files:**

- Create: `src/hooks/post-compact.ts` (new file — distinct from existing `post-compact-restore.ts`)
- Create: `src/hooks/post-compact.test.ts`

**Key Decisions / Notes:**

- **Input fields:** Standard fields only (session_id, cwd, hook_event_name). Matcher values: `manual`, `auto`.
- **Distinct from `post-compact-restore.ts`:** The existing file handles the `SessionStart` event with a `compact` matcher (restoring state on session resume after compaction). This new file handles the `PostCompact` lifecycle event which fires immediately after compaction completes — a different event with different semantics.
- **Behavior:**
  1. Read `.sentinal/compact-state.json` — verify it exists and contains the expected fields (active plan slug, memory context hash).
  2. If compact-state.json is missing or corrupt, re-create it from current spec status + memory context.
  3. Return `additionalContext` with a brief summary: "Context restored: spec {slug}, {N} memory observations available."
- **Not async** — PostCompact can return additionalContext.

**Definition of Done:**

- [ ] `processPostCompact()` exported from `src/hooks/post-compact.ts`
- [ ] 3 test cases: compact-state present, compact-state missing, compact-state corrupt
- [ ] All tests pass

**Verify:** `bun test src/hooks/post-compact.test.ts`

---

### Task 7: TaskCreated Hook

**Objective:** Track background tasks in the Sentinal dashboard.
**Dependencies:** Task 10
**Wave:** 2

**Files:**

- Create: `src/hooks/task-created.ts`
- Create: `src/hooks/task-created.test.ts`

**Key Decisions / Notes:**

- **Input fields:** `task_id`, `task_subject`, `task_description`, `teammate_name`, `team_name`.
- **Behavior:**
  1. Send a dashboard notification: `type: "info"`, title: `"Task: {task_subject}"`, message: `"{task_description}"`.
  2. If an active spec exists, record the task as a memory observation of type `discovery` for traceability.
- **async: true** — non-blocking, fire-and-forget.

**Definition of Done:**

- [ ] `processTaskCreated()` exported
- [ ] 3 test cases: with active spec, without active spec, missing optional fields
- [ ] All tests pass

**Verify:** `bun test src/hooks/task-created.test.ts`

---

### Task 8: pre-edit-guide Refactor

**Objective:** Consume `effort.level` for guidance verbosity; ensure structured `additionalContext` output.
**Dependencies:** Task 10
**Wave:** 2

**Files:**

- Modify: `src/hooks/pre-edit-guide.ts`
- Modify: `src/hooks/pre-edit-guide.test.ts`

**Key Decisions / Notes:**

- **Current behavior:** Already uses `output(hint("PreToolUse", result))` which returns `additionalContext`. This is correct — keep it.
- **New behavior:**
  1. Read `input.effort?.level` from the extended HookInput.
  2. If `effort.level === "low"` or `"medium"`: truncate guidance to max 3 observations, shorter format.
  3. If `effort.level === "xhigh"` or `"high"` (or absent): current behavior (max 5 observations, full format).
- **Minimal change** — add effort-aware truncation, not a structural rewrite.

**Definition of Done:**

- [ ] `processPreEditGuide()` respects `effort.level`
- [ ] 2 new test cases: low effort (shorter), xhigh effort (full)
- [ ] Existing tests still pass

**Verify:** `bun test src/hooks/pre-edit-guide.test.ts`

---

### Task 9: memory-observer + spec-stop-guard Refactor

**Objective:** Consume `last_assistant_message`, `agent_id`/`agent_type`, `duration_ms` in existing hooks.
**Dependencies:** Task 10
**Wave:** 2

**Files:**

- Create: `src/hooks/memory-observer.ts` (extract from `src/cli/commands/hook.ts:144-229`)
- Modify: `src/hooks/memory-observer.test.ts`
- Modify: `src/hooks/spec-stop-guard.ts`
- Modify: `src/hooks/spec-stop-guard.test.ts`
- Modify: `src/cli/commands/hook.ts` (replace inline code with import)

**Key Decisions / Notes:**

- **memory-observer extraction:** Move the `runMemoryObserver` implementation from `hook.ts:144-229` into a new `src/hooks/memory-observer.ts` with an exported `processMemoryObserver()`. The `hook.ts` entry becomes a thin dynamic-import wrapper. This also reduces `hook.ts` line count.
- **memory-observer new fields:**
  1. Include `agent_id` and `agent_type` in the observation payload (memory attribution).
  2. Include `duration_ms` in the observation metadata (tool timing).
  3. Include a truncated snippet of `last_assistant_message` (max 200 chars) in the observation for context.
- **spec-stop-guard new fields:**
  1. Read `last_assistant_message` — include a snippet in the deny reason so the user sees what Claude was saying when it tried to stop.
  2. Read `agent_id` — if the stop is from a subagent (`agent_type !== "main"`), always allow it to stop (don't block subagents from completing).

**Definition of Done:**

- [ ] `processMemoryObserver()` extracted to `src/hooks/memory-observer.ts`
- [ ] memory-observer includes `agent_id`, `agent_type`, `duration_ms` in observations
- [ ] spec-stop-guard uses `last_assistant_message` in deny reason and `agent_type` for subagent bypass
- [ ] All existing + new tests pass
- [ ] `hook.ts` line count reduced by ~80 lines (inline code replaced with import)

**Verify:**

- `bun test src/hooks/memory-observer.test.ts`
- `bun test src/hooks/spec-stop-guard.test.ts`

---

### Task 11: OpenCode Parity — InstructionsLoaded, PostCompact, TaskCreated

**Objective:** Wire the 3 hooks with OpenCode equivalents into `sentinal.ts`.
**Dependencies:** Tasks 3, 6, 7
**Wave:** 3

**Files:**

- Modify: `targets/opencode/plugins/sentinal.ts`
- Modify: `targets/opencode/plugins/sentinal-helpers.ts` (if helper extraction is cleaner)

**Key Decisions / Notes:**

- **InstructionsLoaded → `session.created`** (line 801): After existing session setup, call `processInstructionsLoaded()` with a synthetic input containing the loaded rules files from the session init.
- **PostCompact → `experimental.session.compacting`** (line 664): After existing compaction logic, call `processPostCompact()` to verify state was preserved.
- **TaskCreated → `session.created`** (line 801): When `session.created` fires and the session appears to be a subagent (check `session.parentSessionId` or similar), call `processTaskCreated()`.
- **Import pattern:** Add imports from `../../src/hooks/<name>.js` at the top of `sentinal.ts`.
- **Minimal additions:** Each handler is ~5-10 lines of wrapper code calling the shared function.

**Definition of Done:**

- [ ] `sentinal.ts` imports and calls `processInstructionsLoaded`, `processPostCompact`, `processTaskCreated`
- [ ] `bun run build:opencode` succeeds
- [ ] Existing OpenCode plugin tests still pass
- [ ] 3 new test cases added to `targets/opencode/plugins/sentinal-helpers.test.ts` (or `sentinal.test.ts` if it exists): (1) InstructionsLoaded fires on session.created, (2) PostCompact fires on session.compacting, (3) TaskCreated fires for subagent sessions

**Verify:**

- `grep "instructions-loaded\|post-compact\|task-created" targets/opencode/plugins/sentinal.ts` → 3+ matches
- `bun run build:opencode`
- `bun test targets/opencode/plugins/`
