# Platform Parity & Infrastructure Implementation Plan

Created: 2026-03-16
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Summary

**Goal:** Close platform gaps and upgrade infrastructure: (1) detect cross-session conflicts at session start and per-file edit, (2) complete OpenCode TDD tracking with the RED_CONFIRMED and GREEN_CONFIRMED state transitions that are currently stubs, (3) replace tsc subprocess diagnostics with a warm LSP-based TypeScript language server managed by the sidecar for near-instant type checking.

**Architecture:** Three independent workstreams: Conflict detection adds a session-start check and per-file observation query to the session creation path + pre-edit hook. TDD parity adds a sidecar `/tdd-state/transition` endpoint for bulk state transitions and wires it into the OpenCode plugin. LSP diagnostics adds a persistent `typescript-language-server` process to the sidecar with an LSP client that replaces `Bun.spawn(["npx", "tsc", ...])` in both `check_diagnostics` and `quality-routes`.

**Tech Stack:** Bun, SQLite, LSP protocol (JSON-RPC over stdio), typescript-language-server, MCP SDK

## Scope

### In Scope
- Session-level conflict warning at session start (same project, different session)
- File-level conflict warning in pre-edit hook (file recently edited in another active session)
- OpenCode TDD RED_CONFIRMED bulk transition (currently a stub/TODO)
- OpenCode TDD GREEN_CONFIRMED/clear bulk transition (currently a stub/TODO)
- Sidecar `/tdd-state/transition` endpoint for bulk state changes
- LSP language server managed by sidecar (spawn, initialize, shutdown)
- Replace `runTsc()` in quality-routes with LSP `textDocument/diagnostic`
- Replace tsc subprocess in `check_diagnostics` with LSP query

### Out of Scope
- Automatic file-level conflict resolution (we warn, user decides)
- Cross-machine session awareness (sessions are per-sidecar/per-machine)
- LSP for eslint/prettier (only TypeScript diagnostics)
- Replacing the host tool's LSP server (we run our own for Sentinal diagnostics)
- OpenCode spec event logging for TDD (nice-to-have, not critical)
- Reducing store.ts line count (663 lines, tracked as tech debt — new methods go through service.ts or separate modules)

## Context for Implementer

> Write for an implementer who has never seen the codebase.

- **Patterns to follow:**
  - Session management: `src/memory/store.ts:229-294` — session CRUD, `getActiveSessions()`, `listSessions({ project })`
  - TDD tracker: `src/hooks/tdd-tracker.ts:62-137` — full Claude Code TDD state machine (TEST_WRITTEN → RED_CONFIRMED → GREEN_CONFIRMED)
  - Sidecar route: `src/sidecar/routes.ts:39-139` — router dispatch pattern
  - Quality checks: `src/sidecar/quality-routes.ts:166-221` — `runTsc()` subprocess with tsBuildInfo
  - Pre-edit hook: `src/hooks/pre-edit-guide.ts:44-85` — PreToolUse hint pattern

- **Conventions:**
  - Sidecar routes return `ok(data)` or `fail(message, status)` via JSON
  - TDD states: `IDLE → TEST_WRITTEN → RED_CONFIRMED → GREEN_CONFIRMED → (cleared)`
  - `tdd_cycles` table keyed by `file_path UNIQUE` — not session-scoped
  - PreToolUse hints: `hint("PreToolUse", text)` injects context without blocking
  - OpenCode plugin is at 591 lines — must stay under 600

- **Key files:**
  - `src/memory/store.ts` (663 lines, OVER limit) — session + TDD CRUD. New methods must go through service.ts.
  - `src/sidecar/routes.ts` (399 lines, at limit) — new routes must go in separate files
  - `src/sidecar/quality-routes.ts` (390 lines) — `runTsc()` to be replaced with LSP
  - `src/hooks/tdd-tracker.ts` (177 lines) — Claude Code TDD tracker (reference for OpenCode)
  - `targets/opencode/plugins/sentinal.ts` (591 lines) — TDD stub at lines 160-190
  - `src/analysis/mcp-tools.ts` (590 lines, near limit) — `check_diagnostics` tsc subprocess
  - `src/analysis/helpers.ts` (141 lines) — `parseTscOutput()` + diagnostics baseline

- **Gotchas:**
  - `store.ts` is at 663 lines — cannot add new methods. Use service.ts or a new module.
  - `analysis/mcp-tools.ts` is at 590 lines — replacing tsc subprocess with LSP call must not increase line count. The LSP client should live in a separate module.
  - `routes.ts` is at 399 lines — new routes go in separate files.
  - OpenCode TDD stubs at lines 180-188 have TODO comments — replace these stubs with actual sidecar calls.
  - The `typescript-language-server` npm package must be available. The sidecar should detect and warn if not installed.
  - LSP initialize handshake is async — the sidecar must handle the case where the LSP server isn't ready yet.

- **Domain context:**
  - Cross-session conflicts occur in multi-agent workflows (e.g., two Claude Code instances on the same project) or when a user has both Claude Code and OpenCode open.
  - TDD tracking is essential for the spec workflow — without RED_CONFIRMED transitions in OpenCode, the TDD guard blocks all implementation edits permanently after a test is written.
  - LSP diagnostics replace the slowest part of the quality check pipeline. Current tsc subprocess takes 2-30s; LSP can deliver results in 100-500ms.

## Assumptions

- `typescript-language-server` is installed globally or locally in projects that use TypeScript — supported by: it's a dependency of both Claude Code and OpenCode LSP configs — Task 5 depends on this
- The sidecar has sufficient memory to hold a TypeScript language server process — supported by: typical tsserver uses 100-300MB, sidecar already holds SQLite + vector store — Task 5 depends on this
- `store.listSessions({ project, active: true })` works for per-project session queries — supported by: `listSessions` accepts `{ project }` filter at `store.ts:275` — Task 1 depends on this
- The OpenCode plugin `output.args.output` contains test runner output for TDD detection — supported by: the existing TEST_FAIL/PASS regex matching at `sentinal.ts:178` works — Task 3 depends on this

## Testing Strategy

- **Unit tests:** `src/session/conflict.test.ts` — test conflict detection logic
- **Unit tests:** `src/sidecar/tdd-routes.test.ts` — test bulk TDD transition endpoint
- **Unit tests:** `src/sidecar/lsp-client.test.ts` — test LSP client initialization and diagnostics
- **Integration:** Full memory + sidecar test suite
- **Existing tests:** All 263+ tests must pass

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| LSP server crashes or becomes unresponsive | Medium | Medium | Fallback to tsc subprocess. Restart LSP on crash. Timeout on requests. |
| typescript-language-server not installed | Medium | Low | Detect at sidecar startup, warn user, fallback to tsc subprocess. |
| Cross-session conflict false positives | Low | Low | Only warn, never block. Sessions from same project only. |
| OpenCode TDD stub replacement breaks existing behavior | Low | Medium | Test parity with Claude Code TDD tracker. MCP tools remain as escape hatch. |
| LSP memory overhead on large projects | Medium | Medium | Lazy initialization — only spawn LSP server on first diagnostics request. Kill after idle timeout. |

## Pre-Mortem

*Assume this plan failed. Most likely internal reasons:*

1. **LSP server initialization too slow or flaky** (Task 5) — Trigger: the first `check_diagnostics` call takes 10+ seconds because the LSP server needs to index the project. Mitigation: lazy spawn + warm-up on sidecar start. Cache the server across diagnostic calls. Fall back to tsc subprocess if LSP not ready within 5s.

2. **OpenCode TDD transitions fire on wrong output** (Task 3) — Trigger: TEST_FAIL_INDICATORS match normal non-test output, causing false RED_CONFIRMED transitions. Mitigation: require both test runner invocation AND failure indicators (match the tool command, not just output).

3. **File-level conflict detection is too noisy** (Task 2) — Trigger: every file edit in a shared project fires a warning because the sidecar stores recent observations per-file. Mitigation: only warn when the other session is truly concurrent (active, not ended). Use a recency window (last 5 minutes).

## Goal Verification

### Truths
1. Starting a session on a project with an existing active session shows a conflict warning
2. Editing a file that another active session recently edited shows a per-file warning
3. OpenCode TDD correctly transitions to RED_CONFIRMED when tests fail
4. OpenCode TDD correctly clears state (GREEN_CONFIRMED) when tests pass
5. `check_diagnostics` uses LSP for TypeScript diagnostics instead of tsc subprocess
6. LSP diagnostics fall back to tsc subprocess when the language server is unavailable
7. All existing tests continue to pass

### Artifacts
- `src/session/conflict.ts` (new) — conflict detection logic
- `src/session/conflict.test.ts` (new) — tests
- `src/sidecar/tdd-routes.ts` (new) — bulk TDD transition endpoint
- `src/sidecar/lsp-client.ts` (new) — LSP client for diagnostics
- `src/sidecar/lsp-client.test.ts` (new) — tests
- `targets/opencode/plugins/sentinal.ts` (modified) — TDD stubs replaced
- `src/sidecar/quality-routes.ts` (modified) — LSP-based runTsc replacement
- `src/analysis/mcp-tools.ts` (modified) — check_diagnostics uses LSP

### Key Links
- Session start hook ← calls conflict detection ← queries active sessions for project
- Pre-edit hook ← calls file conflict check ← queries observations for file in other sessions
- OpenCode TDD tracker ← calls sidecar `/tdd-state/transition` ← bulk state transitions
- `check_diagnostics` ← calls LSP client ← typescript-language-server process

## Progress Tracking

- [x] Task 1: Add session-level conflict detection at session start
- [x] Task 2: Add file-level conflict detection in pre-edit hook
- [x] Task 3: Complete OpenCode TDD tracking (RED_CONFIRMED + GREEN_CONFIRMED)
- [x] Task 4: Add sidecar /tdd-state/transition endpoint
- [x] Task 5: Create LSP client module in sidecar
- [x] Task 6: Replace tsc subprocess with LSP diagnostics

**Total Tasks:** 6 | **Completed:** 6 | **Remaining:** 0

## Implementation Tasks

### Task 1: Add session-level conflict detection at session start

**Objective:** When a new session starts, check for existing active sessions on the same project. If found, inject a warning into the session start response.

**Dependencies:** None

**Files:**
- Create: `src/session/conflict.ts`
- Create: `src/session/conflict.test.ts`
- Modify: `src/hooks/session-start.ts` (inject conflict warning)
- Modify: `targets/opencode/plugins/sentinal.ts` (check after session creation)

**Key Decisions / Notes:**
- **Core function:** `detectSessionConflict(store: MemoryStore, projectPath: string, currentSessionId: string): SessionConflict | null`
  - Queries `store.listSessions({ project: projectPath, active: true })`
  - Filters out the current session by ID
  - Returns `{ conflictingSessions: Session[], message: string }` or null
- **Claude Code:** In `session-start.ts`, after `store.insertSession()`, call `detectSessionConflict()`. If conflict found, output as `hint("SessionStart", message)`.
- **OpenCode:** In `session.created` event handler, after session creation, call sidecar to check for conflicts. Log warning via `client.app.log()`.
- **Warning message format:** `"[Sentinal] Warning: Another active session exists for this project (session {id}, started {time}). Edits may conflict."`
- **OpenCode plugin impact:** ~5 lines addition (after session creation, before memory restore). Well within 600-line limit.

**Definition of Done:**
- [ ] `detectSessionConflict()` returns conflict info when another session exists
- [ ] Returns null when no conflicting sessions exist
- [ ] Claude Code session-start hook shows warning hint
- [ ] OpenCode plugin logs warning on session creation
- [ ] Tests verify conflict detection and no-conflict paths

**Verify:**
- `bun test src/session/conflict.test.ts`

---

### Task 2: Add file-level conflict detection in pre-edit hook

**Objective:** When a file is edited, check if another active session recently edited the same file (via observations). Inject a per-file warning if so.

**Dependencies:** Task 1

**Files:**
- Modify: `src/session/conflict.ts` (add file-level check)
- Modify: `src/session/conflict.test.ts`
- Modify: `src/hooks/pre-edit-guide.ts` (integrate file conflict check)

**Key Decisions / Notes:**
- **Core function:** `detectFileConflict(service: MemoryService, filePath: string, projectPath: string, currentSessionId: string): FileConflict | null`
  - Queries recent observations for the project that mention `filePath` in their `filePaths` array
  - Filters to observations from OTHER active sessions (not current)
  - Uses a recency window: only observations from the last 5 minutes count
  - Returns `{ sessionId: string, lastEditAt: number, message: string }` or null
- **Integration:** In `pre-edit-guide.ts`, after the existing observation query, also call `detectFileConflict()`. Append the conflict warning to the hint if found.
- **Query strategy:** Use direct SQL on the observations table: `SELECT DISTINCT session_id FROM observations WHERE project_path = ? AND file_paths LIKE ? AND session_id != ? AND timestamp > ? LIMIT 1`. The `file_paths` column stores JSON arrays, so use `LIKE '%<basename>%'` for the match. This avoids FTS overhead and is fast with the existing `idx_obs_project` index. The 5-minute recency window (`timestamp > now - 300000`) keeps the result set tiny.
- **Sidecar path:** Add the conflict check to the sidecar as part of a new `GET /session/file-conflict?project=<path>&file=<path>&session=<id>` endpoint in `src/sidecar/tdd-routes.ts` (reusing that file for session/conflict routes to keep routes.ts under limit).

**Definition of Done:**
- [ ] `detectFileConflict()` detects when another session recently edited the same file
- [ ] Returns null when no file conflicts exist
- [ ] Warning appears in pre-edit hint alongside observation context
- [ ] 5-minute recency window prevents stale warnings
- [ ] Tests verify file conflict detection

**Verify:**
- `bun test src/session/conflict.test.ts`
- `bun test src/hooks/pre-edit-guide.test.ts`

---

### Task 3: Complete OpenCode TDD tracking (RED_CONFIRMED + GREEN_CONFIRMED)

**Objective:** Replace the stub/TODO code in the OpenCode plugin's `sidecarTddTrack` function with actual sidecar calls for RED_CONFIRMED and GREEN_CONFIRMED state transitions.

**Dependencies:** Task 4 (needs the sidecar endpoint)

**Files:**
- Modify: `targets/opencode/plugins/sentinal.ts` (replace stubs at lines 180-188)
- Modify: `targets/opencode/plugins/sentinal-helpers.ts` (add TDD transition helper)
- Create: `targets/opencode/plugins/sentinal-helpers.test.ts` (test TDD transition helper)

**Key Decisions / Notes:**
- **RED_CONFIRMED stub (line 180-183):** Replace with call to sidecar `POST /tdd-state/transition` with `{ action: "confirm_red", specId }`. This transitions all TEST_WRITTEN states to RED_CONFIRMED for the current spec.
- **GREEN_CONFIRMED stub (line 186-188):** Replace with call to sidecar `POST /tdd-state/transition` with `{ action: "confirm_green", specId }`. This clears all RED_CONFIRMED states for the current spec.
- **specId resolution:** The OpenCode plugin needs to know the current spec ID. Use the sidecar `GET /spec/current?project=<path>` endpoint (already exists).
- **Extract to helpers:** Move the TDD transition logic to `sentinal-helpers.ts` as `transitionTddState(sidecar, action, specId)` to keep the plugin under 600 lines. The session conflict check from Task 1 should also be extracted to helpers (not inline in sentinal.ts) to avoid pushing the plugin toward 600 lines before this task runs.
- **Line count:** Replace ~8 lines of stubs with ~8 lines of actual calls. Net zero change.

**Definition of Done:**
- [ ] OpenCode TDD transitions from TEST_WRITTEN to RED_CONFIRMED when tests fail
- [ ] OpenCode TDD clears state when tests pass (GREEN_CONFIRMED)
- [ ] TDD guard unblocks implementation edits after RED_CONFIRMED transition
- [ ] OpenCode plugin stays under 600 lines
- [ ] Tests verify transitionTddState() makes correct sidecar calls

**Verify:**
- `bun test targets/opencode/plugins/sentinal-helpers.test.ts`
- `bun run embed-assets && bun run build:cli`

---

### Task 4: Add sidecar /tdd-state/transition endpoint

**Objective:** Create a sidecar endpoint for bulk TDD state transitions (confirm_red, confirm_green). Used by the OpenCode plugin.

**Dependencies:** None

**Files:**
- Create: `src/sidecar/tdd-routes.ts`
- Modify: `src/sidecar/server.ts` (wire handler)
- Modify: `src/sidecar/client.ts` (add `tddTransition()` method)

**Key Decisions / Notes:**
- **Route:** `POST /tdd-state/transition`
- **Body:** `{ action: "confirm_red" | "confirm_green", specId?: string }`
- **`confirm_red`:** Queries all TDD states with `state = "TEST_WRITTEN"`. For each, sets `state = "RED_CONFIRMED"`. Returns count of transitioned states.
- **`confirm_green`:** Queries all TDD states with `state = "RED_CONFIRMED"`. Clears (deletes) each. Returns count of cleared states.
- **Handler location:** New `src/sidecar/tdd-routes.ts` (~60 lines). Wired in `server.ts` fetch handler (same pattern as quality-routes and project-routes).
- **Client method:** `tddTransition(action: string, specId?: string): Promise<{ count: number }>`
- **Store access:** Uses `store.getRawDb()` for direct queries since the existing `setTddState()` and `clearTddState()` methods are per-file, not bulk.

**Definition of Done:**
- [ ] `POST /tdd-state/transition` with `confirm_red` transitions TEST_WRITTEN → RED_CONFIRMED
- [ ] `POST /tdd-state/transition` with `confirm_green` clears RED_CONFIRMED states
- [ ] Client has `tddTransition()` method
- [ ] Returns count of affected states
- [ ] Tests verify both transitions

**Verify:**
- `bun test src/sidecar/`

---

### Task 5: Create LSP client module in sidecar

**Objective:** Build an LSP client that manages a persistent `typescript-language-server` process and can request diagnostics for TypeScript files.

**Dependencies:** None

**Files:**
- Create: `src/sidecar/lsp-client.ts`
- Create: `src/sidecar/lsp-client.test.ts`

**Key Decisions / Notes:**
- **Architecture:** The LSP client is a singleton per project. Spawns `typescript-language-server --stdio` as a child process. Communicates via JSON-RPC over stdin/stdout.
- **Lifecycle:**
  - **Lazy init:** Don't spawn until first diagnostics request
  - **Warm-up:** On first request, send `initialize` → `initialized` → `textDocument/didOpen` sequence
  - **Idle timeout:** Kill server after 10 minutes of inactivity (reuse sidecar's idle tracking pattern)
  - **Crash recovery:** If the server process exits, next request re-spawns it
- **Core API:**
  - `getDiagnostics(projectPath: string, filePaths?: string[]): Promise<Diagnostic[]>`
  - `Diagnostic`: `{ file: string, line: number, column: number, message: string, severity: "error" | "warning" }`
- **LSP protocol implementation:**
  - Use raw JSON-RPC over stdio (no heavy LSP library needed)
  - Messages: `Content-Length: N\r\n\r\n{json}`
  - **Push-based diagnostics (not pull-based):** `typescript-language-server` uses `textDocument/publishDiagnostics` notifications (pushed after file open/change), NOT the pull-based `textDocument/diagnostic` request which isn't widely supported. Flow: send `textDocument/didOpen` for target files → collect `textDocument/publishDiagnostics` notifications → aggregate results.
  - Requests needed: `initialize`, `initialized`, `textDocument/didOpen`, `textDocument/didClose`
  - Listen for: `textDocument/publishDiagnostics` notification (pushed by server)
- **Fallback:** Export a `isLspAvailable()` function that checks if `typescript-language-server` is installed. Callers use tsc subprocess fallback when false.
- **Line count target:** ~200 lines for the LSP client module.

**Definition of Done:**
- [ ] LSP client spawns typescript-language-server on first request
- [ ] `getDiagnostics()` returns structured diagnostics for a project
- [ ] Server is killed after idle timeout
- [ ] Crash recovery: re-spawns on next request if process died
- [ ] `isLspAvailable()` checks for typescript-language-server
- [ ] Tests verify initialization, diagnostics, and fallback

**Verify:**
- `bun test src/sidecar/lsp-client.test.ts`

---

### Task 6: Replace tsc subprocess with LSP diagnostics

**Objective:** Wire the LSP client into `check_diagnostics` and `quality-routes` to replace the tsc subprocess for TypeScript type checking.

**Dependencies:** Task 5

**Files:**
- Modify: `src/sidecar/quality-routes.ts` (replace `runTsc()` with LSP)
- Modify: `src/analysis/mcp-tools.ts` (update `check_diagnostics` to use LSP)
- Modify: `src/sidecar/server.ts` (add LSP client to SidecarContext)

**Key Decisions / Notes:**
- **quality-routes.ts `runTsc()` replacement:**
  - Add `runTscLsp(ctx: SidecarContext, projectPath: string): Promise<ToolResult>` that calls `ctx.lspClient.getDiagnostics(projectPath)`
  - Convert LSP `Diagnostic[]` to the existing `ToolResult` format (`{ ok, errors }`)
  - If LSP unavailable or fails, fall back to existing `runTsc()` (subprocess)
  - This should REDUCE line count (LSP call is simpler than subprocess management)
- **check_diagnostics replacement:**
  - In the MCP tool handler, try LSP first via sidecar client
  - Fall back to tsc subprocess if sidecar/LSP unavailable
  - Keep the existing baseline/delta tracking — only the data source changes
  - The existing `parseTscOutput()` is no longer needed for LSP path (diagnostics are already structured)
- **SidecarContext addition:** Add `lspClient?: LspClient` to `SidecarContext`. Lazy-initialized on first diagnostics request.
- **Line count:** `quality-routes.ts` is at 390 lines. Replacing `runTsc()` (~55 lines) with `runTscLsp()` (~20 lines) should net decrease. `mcp-tools.ts` at 590 lines — adding LSP path (~10 lines) with fallback is tight but feasible.

**Definition of Done:**
- [ ] `check_diagnostics` MCP tool uses LSP for diagnostics when available
- [ ] Quality check route uses LSP for tsc diagnostics when available
- [ ] Falls back to tsc subprocess when LSP is unavailable
- [ ] Tests verify fallback from LSP to tsc when isLspAvailable() returns false
- [ ] Existing baseline/delta tracking still works
- [ ] Diagnostics results are equivalent (same errors reported)

**Verify:**
- `bun test src/analysis/ src/sidecar/`
- `bun run build:cli`
