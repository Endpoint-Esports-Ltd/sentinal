# Memory Observation Parity Plan

Created: 2026-03-15
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Summary

**Goal:** Bring Claude Code and OpenCode memory observation systems to parity by fixing divergences found during comparison, adding resilience (offline queue), and cleaning up dead code.

**Architecture:** Four focused changes: (1) add missing tool name to OpenCode's capture filter, (2) delete dead standalone file, (3) create a new `ObservationQueue` utility that serializes pending observations to `~/.sentinal/observation-queue.json` when the sidecar is unavailable and drains them lazily on reconnection, (4) document an architectural constraint in the plugin.

**Tech Stack:** TypeScript, Node.js-compatible (no bun:sqlite), JSON file persistence

## Scope

### In Scope
- Add `multiedit` to OpenCode plugin `MEMORY_TOOLS` list
- Delete dead `src/hooks/memory-observer.ts`
- Create `src/sidecar/observation-queue.ts` with multi-project queue support
- Integrate queue into OpenCode plugin's auto-capture and session lifecycle
- Document `client.app.log()` limitation in plugin comments
- Update README directory listing

### Out of Scope
- Changing how `client.app.log()` works (OpenCode API limitation)
- Making `success` field accurate in Claude Code hooks (requires Claude Code API changes)
- Adding sidecar reconnection logic (would require refactoring the plugin's sidecar lifecycle)
- Compact state path divergence between `findGitRoot()` and `projectRoot` (cosmetic, rarely differs)

## Context for Implementer

> Write for an implementer who has never seen the codebase.

- **Patterns to follow:**
  - Queue file persistence: follows the same read-modify-write pattern as `event-buffer.json` in `hook.ts:136-148`
  - Path conventions: use `DB_CONSTANTS.DB_DIR` (`.sentinal`) under `homedir()` — see `src/sidecar/paths.ts:17-27`
  - Import boundaries: the OpenCode plugin bundles via `bun build` and excludes `bun:sqlite`, `zod`, etc. New files imported by the plugin MUST use only Node.js-compatible APIs (`fs`, `path`, `os`).

- **Conventions:**
  - Error handling in plugin: always catch and `log()` to `plugin.debug.log`, never throw
  - Plugin file is at 559 lines (400-line warning, 600-line block) — new logic MUST go in a separate file

- **Key files:**
  - `targets/opencode/plugins/sentinal.ts` — OpenCode plugin (559 lines). Memory capture at lines 378-418, session lifecycle at lines 461-540
  - `src/hooks/memory-observer.ts` — Dead code to delete (126 lines). Superseded by `hook.ts:runMemoryObserver()`
  - `src/hooks/memory-observer.test.ts` — Tests capture patterns, does NOT import the standalone file. Keep this.
  - `src/sidecar/paths.ts` — Shared path helpers for `~/.sentinal/` directory
  - `src/sidecar/client.ts:197-208` — `addObservation()` payload shape
  - `src/memory/capture.ts:353-356` — `isEditTool()` includes `multiedit`

- **Gotchas:**
  - The plugin runs in Node.js (NOT Bun). No `bun:sqlite`, no `{ unix: socketPath }` fetch.
  - Multiple plugin instances can run concurrently (different projects). The queue file at `~/.sentinal/` is shared.
  - The `embed-assets` script must be run after plugin changes: `bun run embed-assets`

- **Domain context:**
  - `MEMORY_TOOLS` controls which tool names trigger auto-capture heuristic evaluation. If a tool is not in this list, the `tool.execute.after` handler returns early before reaching the memory capture block.
  - `multiedit` is OpenCode's batch-edit tool. It's functionally equivalent to `Edit` for capture purposes.
  - The observation queue is a last-resort buffer. In normal operation, sidecar is available and observations go directly to it. The queue is only used when sidecar is down mid-session.

## Assumptions

- `multiedit` events have the same `output.args` shape as `edit` events (filePath, content) — supported by `isEditTool()` in `capture.ts:355` already handling it — Task 1 depends on this
- The `observation-queue.json` file is small enough that read-modify-write is safe without file locking — supported by: cap of 50 entries, each ~500 bytes = ~25KB max — Task 3 depends on this
- `src/hooks/memory-observer.ts` is not used as a standalone entry point by any deployment — supported by: grep shows no code imports, hooks.json routes to `sentinal hook shared memory-observer` which dispatches to `hook.ts:runMemoryObserver()` — Task 2 depends on this

## Testing Strategy

- **Unit tests:** `src/sidecar/observation-queue.test.ts` — enqueue/drain/cap/multi-project/corruption
- **Existing tests:** Run full suite to ensure no regressions from deletion of `memory-observer.ts`
- **Type check:** `tsc --noEmit` must pass

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Concurrent writes corrupt queue file | Low | Medium | Read-modify-write with corruption recovery (fresh start) |
| Queue grows unbounded | Low | Low | Hard cap of 50 entries, oldest dropped |
| Dead file deletion breaks something | Very Low | High | Verified zero code imports, tests don't import it |

## Pre-Mortem

*Assume this plan failed. Most likely internal reasons:*

1. **Queue file gets corrupted by concurrent plugin instances** (Task 3) — Trigger: two projects simultaneously try to enqueue and one overwrites the other's changes. Mitigation: the queue is append-only in practice (most tool calls succeed), and corruption triggers fresh start, losing at most the queued entries.

2. **`multiedit` tool name doesn't match what OpenCode actually sends** (Task 1) — Trigger: the tool name in `input.tool` for batch edits is something else like `multi_edit` or `batch_edit`. Check: add logging on first deployment to confirm actual tool names.

## Goal Verification

### Truths
1. `multiedit` tool events trigger auto-capture heuristic evaluation in the OpenCode plugin
2. `src/hooks/memory-observer.ts` no longer exists in the codebase
3. When sidecar is unavailable, observations are queued to `~/.sentinal/observation-queue.json` instead of being lost
4. Queued observations are drained when sidecar becomes available on next session start
5. Queue supports entries from multiple projects simultaneously
6. Queue file is capped at 50 entries

### Artifacts
- `src/sidecar/observation-queue.ts` (new)
- `src/sidecar/observation-queue.test.ts` (new)
- `targets/opencode/plugins/sentinal.ts` (modified — import queue, integrate at capture + session lifecycle)
- `src/hooks/memory-observer.ts` (deleted)

### Key Links
- `ObservationQueue.enqueue()` ← called from plugin's `tool.execute.after` catch block
- `ObservationQueue.drain(sendFn)` ← called from plugin's `session.created` handler and plugin init, guarded by `draining` flag
- `MEMORY_TOOLS` list ← gates which tool events reach `analyzeEvent()`

## Progress Tracking

- [x] Task 1: Add `multiedit` to OpenCode MEMORY_TOOLS
- [x] Task 2: Delete dead `memory-observer.ts`
- [x] Task 3: Create ObservationQueue utility
- [x] Task 4: Integrate queue into OpenCode plugin
- [x] Task 5: Document `client.app.log()` limitation

**Total Tasks:** 5 | **Completed:** 5 | **Remaining:** 0

## Implementation Tasks

### Task 1: Add `multiedit` to OpenCode MEMORY_TOOLS

**Objective:** Include `multiedit` in the tool name filter so that batch-edit events trigger auto-capture heuristic evaluation.

**Dependencies:** None

**Files:**
- Modify: `targets/opencode/plugins/sentinal.ts` (line 280)

**Key Decisions / Notes:**
- Add `"multiedit"` to the `MEMORY_TOOLS` array at line 280
- `isEditTool()` in `capture.ts:353-356` already includes `"multiedit"`, so heuristics will work correctly once events reach `analyzeEvent()`
- One-line change

**Definition of Done:**
- [ ] `MEMORY_TOOLS` includes `"multiedit"`
- [ ] Full test suite passes
- [ ] No TypeScript errors

**Verify:**
- `bun test`

---

### Task 2: Delete dead `memory-observer.ts`

**Objective:** Remove the superseded standalone memory observer file and update the README.

**Dependencies:** None

**Files:**
- Delete: `src/hooks/memory-observer.ts`
- Modify: `README.md` (remove directory listing reference at line 190)

**Key Decisions / Notes:**
- Keep `src/hooks/memory-observer.test.ts` — it tests `EventBuffer`, `analyzeEvent()`, and `MemoryService` patterns used by `hook.ts:runMemoryObserver()`. None of its imports reference the standalone file.
- The standalone file's functionality was inlined into `hook.ts:113-183` during the plugin-hook-consolidation (2026-03-10). It has two divergences from the current code: reads `toolInput.output` instead of `tool_response.output`, and truncates to 1000 chars instead of 2000.
- Verify no imports exist (already confirmed via grep)

**Definition of Done:**
- [ ] `src/hooks/memory-observer.ts` does not exist
- [ ] README no longer references the file
- [ ] Full test suite passes (no broken imports)
- [ ] No TypeScript errors

**Verify:**
- `bun test`
- `grep -r "memory-observer.ts" src/`

---

### Task 3: Create ObservationQueue utility

**Objective:** Create a JSON-file-backed queue for observations that can't be sent to the sidecar. Must handle entries from multiple projects/sessions.

**Dependencies:** None

**Files:**
- Create: `src/sidecar/observation-queue.ts`
- Create: `src/sidecar/observation-queue.test.ts`

**Key Decisions / Notes:**
- **File location:** `~/.sentinal/observation-queue.json` — uses `DB_CONSTANTS.DB_DIR` under `homedir()`, consistent with other sidecar files in `paths.ts`
- **Queue format:** JSON array of observation payloads. Each entry already contains `projectPath` and `sessionId`, so multi-project is naturally handled without extra fields.
- **Cap:** 50 entries total (global, not per-project). When full, drop oldest entry and log warning.
- **API:**
  - `enqueue(payload, log?)` — read file, append, write. If file is corrupted, start fresh. Optional `log` callback for plugin debug logging.
  - `drain(sendFn, log?)` — accepts a callback `sendFn: (obs) => Promise<void>` instead of a SidecarClient (keeps the module decoupled, avoids transitive bun:sqlite deps). Read file, call `sendFn` for each entry, remove successfully sent entries, write remaining back. Returns `{ sent: number, failed: number, remaining: number }`.
  - `pending(projectPath?)` — return count, optionally filtered by project.
- **Concurrency:** Read-modify-write with `writeFileSync`. If concurrent writes corrupt the file, the `try/catch` on JSON.parse starts fresh (same pattern as `event-buffer.json`).
- **Node.js compatibility:** Only uses `fs`, `path`, `os` — no `bun:sqlite`, no Zod, no SidecarClient import.
- **Export a `getQueuePath()` function** for testability (can be mocked via `spyOn`)

**Definition of Done:**
- [ ] `enqueue()` appends to queue file, respects 50-entry cap
- [ ] `drain(sendFn)` sends all queued entries via callback, returns counts
- [ ] `drain()` handles partial failures (some entries fail, others succeed)
- [ ] Queue entries from different projects coexist correctly
- [ ] Corrupted queue file is handled gracefully (fresh start)
- [ ] All tests pass

**Verify:**
- `bun test src/sidecar/observation-queue.test.ts`

---

### Task 4: Integrate queue into OpenCode plugin

**Objective:** Wire the ObservationQueue into the plugin's auto-capture and session lifecycle so observations are queued instead of lost when sidecar is unavailable.

**Dependencies:** Task 3

**Files:**
- Modify: `targets/opencode/plugins/sentinal.ts`

**Key Decisions / Notes:**
- **Import:** Add `import { ObservationQueue } from "../../../src/sidecar/observation-queue.js";`
- **Drain guard:** Add `let draining = false;` flag in plugin scope to prevent concurrent drain calls (reviewer finding: plugin init and session.created can fire in quick succession, causing double-sends)
- **Integration point 1 — memory capture (lines 378-418):**
  - Change the guard from `if (sidecar && sessionId)` to `if (sessionId)` — still need sessionId, but sidecar is now optional
  - If sidecar is available, try `sidecar.addObservation()` as before
  - In the catch block (or if sidecar is null), call `ObservationQueue.enqueue(obsPayload, log)` instead of just logging
  - Log: `"observation queued (sidecar unavailable): <title>"`
- **Integration point 2 — plugin init (after sidecar connect, ~line 222):**
  - If sidecar connected and `!draining`, set `draining = true`, call `ObservationQueue.drain((obs) => sidecar.addObservation(obs), log)`, set `draining = false`. Log results: `"drained N queued observations"`
- **Integration point 3 — session.created (after sidecar session create, ~line 476):**
  - If sidecar is available and `!draining`, drain with the same pattern
- **Line count budget:** Adds ~18 lines (import + drain guard + 3 integration points). Plugin goes from 559 → ~577, still under 600.

**Definition of Done:**
- [ ] Auto-capture observations are queued when sidecar is null
- [ ] Auto-capture observations are queued when `addObservation()` throws
- [ ] Queued observations are drained on plugin init when sidecar is available
- [ ] Queued observations are drained on `session.created` when sidecar is available
- [ ] Concurrent drain calls are guarded by `draining` flag
- [ ] Debug log shows queue/drain activity
- [ ] Plugin file stays under 600 lines
- [ ] `bun run embed-assets` succeeds
- [ ] Full test suite passes

**Verify:**
- `bun test`
- `wc -l targets/opencode/plugins/sentinal.ts`

---

### Task 5: Document `client.app.log()` limitation

**Objective:** Add a comment explaining that memory restore on `session.created` uses `client.app.log()` which writes to the TUI log panel, not the LLM's context window. Memory is properly injected during compaction.

**Dependencies:** None

**Files:**
- Modify: `targets/opencode/plugins/sentinal.ts` (near line 482)

**Key Decisions / Notes:**
- Add a 3-line comment above the `client.app.log()` call explaining:
  - `client.app.log()` writes to OpenCode's TUI log panel, not the LLM context
  - Memory is properly injected into LLM context during compaction via `output.context.push()`
  - This log serves as a diagnostic indicator
- No code change — the compaction path already works correctly

**Definition of Done:**
- [ ] Comment present near the `client.app.log()` memory restore call
- [ ] No TypeScript errors

**Verify:**
- `bun test`
