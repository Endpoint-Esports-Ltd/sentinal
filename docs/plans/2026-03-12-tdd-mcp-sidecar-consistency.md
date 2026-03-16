# TDD Guard MCP Tools & Sidecar Consistency Implementation Plan

Created: 2026-03-12
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Summary

**Goal:** Add TDD guard MCP tools (`tdd_status`, `tdd_set_state`, `tdd_clear`) so agents can manage TDD cycle state programmatically instead of shelling out `bun -e` inline scripts, and fix the sidecar inconsistency where spec/worktree MCP tools bypass the warm sidecar connection and open cold MemoryStore instances.

**Architecture:** New `src/tdd/mcp-tools.ts` module registers 3 TDD tools following the same sidecar-first pattern as memory tools (receive `{ client, store }`). Existing spec and worktree MCP tool signatures change from `(server, store)` to `(server, deps)` where `deps = { client?, store? }`. New sidecar endpoints are added for operations that don't yet have routes (spec events, worktree slug resolution, TDD state listing). The sidecar context gains `WorktreeStore`. MCP server version bumps to `0.4.0`.

**Tech Stack:** TypeScript, Bun, `@modelcontextprotocol/sdk`, Zod, `bun:sqlite`, SidecarClient

## Scope

### In Scope

- 3 new TDD MCP tools: `tdd_status`, `tdd_set_state`, `tdd_clear`
- New `src/tdd/` domain directory with `mcp-tools.ts` and `mcp-tools.test.ts`
- 4 new sidecar routes: `GET /spec/events`, `GET /worktree/resolve`, `GET /tdd-state/list`, `POST /tdd-state` clearForSpec action (exists but no client method)
- 4 new SidecarClient methods: `getSpecEvents`, `resolveWorktreeBySlug`, `listActiveTddStates`, `clearTddStatesForSpec`
- Refactor `registerSpecTools` to accept `{ client?, store? }` deps and use sidecar for DB ops
- Refactor `registerWorktreeTools` to accept `{ client?, store? }` deps and use sidecar for DB ops
- Update `createSentinalServer` to pass `{ client, store }` to all tool modules
- Add `WorktreeStore` to `SidecarContext`
- Update skill/command files to reference new TDD MCP tools
- Unit tests for all new tools, routes, and client methods
- Build + update cycle

### Out of Scope

- Moving `tdd-guard.ts` / `tdd-tracker.ts` hooks to `src/tdd/` (future refactor)
- Changing the TDD guard hook itself to use sidecar (guard's fast path is already ~2ms)
- Adding sidecar endpoints for worktree create/diff/sync git operations (no benefit — these are local git commands)
- Changing the `spec_wait_file` or `spec_config` tools (pure filesystem/env — no DB ops)

## Context for Implementer

> Write for an implementer who has never seen the codebase.

- **Sidecar-first pattern:** See `src/memory/mcp-tools.ts:28-49` — the `MemoryToolsDeps` interface and the ternary `client ? await client.method() : service!.method()` pattern. This is the gold standard; all tool modules should follow it.
- **SidecarClient transport:** `src/sidecar/client.ts:49-75` — tries Unix socket at `~/.sentinal/sidecar.sock` first, then HTTP port file fallback. All methods use internal `get()` / `post()` helpers.
- **Sidecar routes:** `src/sidecar/routes.ts:35-111` — pattern-matched `path + method` router. All handlers return `ok(data)` or `fail(error, status)`. Context provides `store`, `service`, `specStore`.
- **SidecarContext:** `src/sidecar/server.ts:23-27` — currently has `store: MemoryStore`, `service: MemoryService`, `specStore: SpecStore`. Does NOT have `WorktreeStore` — needs adding.
- **TDD state on MemoryStore:** `src/memory/store.ts:438-511` — `getTddState`, `setTddState`, `clearTddState`, `clearTddStatesForSpec`, `listActiveTddStates`. All synchronous.
- **TDD state types:** `src/memory/types.ts:193-222` — `TDD_CYCLE_STATES = ["IDLE", "TEST_WRITTEN", "RED_CONFIRMED", "GREEN_CONFIRMED"]`, `TddCycle` interface, `TddCycleState` type.
- **Existing TDD sidecar routes:** `GET /tdd-state` (single file), `POST /tdd-state` (set/clear/clearForSpec actions). Routes at `src/sidecar/routes.ts:62-67`.
- **Existing TDD client methods:** `getTddState`, `setTddState`, `clearTddState` at `src/sidecar/client.ts:126-146`. Missing: `clearTddStatesForSpec` (route exists), `listActiveTddStates` (neither exists).
- **MCP server wiring:** `src/mcp/server.ts:33-49` — `createSentinalServer` creates store/client, passes `{ client, store }` to memory tools but only `store` to spec/worktree tools.
- **captureTools test pattern:** Monkey-patch `McpServer.tool()` to intercept handler registrations, call handlers directly. See `src/worktree/mcp-tools.test.ts:40-56` and `src/spec/mcp-tools.test.ts`.
- **Conventions:** `.js` extensions in imports (ESM convention), `as const` for type narrowing, try/catch with `Error creating/detecting/etc: ${msg}` pattern for MCP tool error responses.

**Gotchas:**

- When sidecar is active, `store` is `null` in `createSentinalServer`. Tools must handle both code paths.
- `WorktreeManager` requires `WorktreeStore` which requires `MemoryStore`. In sidecar mode where `store` is null, worktree git operations need a local `WorktreeStore`+`MemoryStore` for non-DB git ops, but DB reads (slug resolution) should go through sidecar.
- The `spec_register` tool does file I/O (readFileSync/writeFileSync) THEN calls `specStore.syncFromPlanFile()`. Only the sync call should go through sidecar; file I/O stays direct.
- `spec_plan_parse` is pure file I/O with no DB ops — leave it direct, no sidecar routing needed.

## Assumptions

- The sidecar is the standard deployment model and is running in most agent sessions — supported by `autoStartSidecar()` in `src/mcp/server.ts:60` and the `withSidecarOrDirect` pattern used by hooks.
- Adding `WorktreeStore` to `SidecarContext` is safe — it's lightweight (just wraps `getRawDb()`) — supported by `src/worktree/store.ts:33-35`.
- The `spec_wait_file` and `spec_config` tools have no DB operations and don't need sidecar routing — supported by reading their implementations (pure fs.watch/env reads).
- Tests can mock sidecar client methods by passing a fake client object with matching method signatures — supported by the existing `MemoryToolsDeps` pattern.

## Testing Strategy

- **Unit tests for TDD MCP tools:** `src/tdd/mcp-tools.test.ts` — test all 3 tools with both sidecar (mock client) and direct (real MemoryStore) paths.
- **Unit tests for new sidecar routes:** Add to existing `src/sidecar/routes.test.ts` (or inline) — test the 3 new route handlers return correct JSON.
- **Unit tests for new SidecarClient methods:** Add to existing `src/sidecar/client.test.ts` — test the 4 new client methods make correct HTTP requests.
- **Integration test for sidecar consistency:** Verify that spec/worktree tools work in sidecar mode by passing a mock client to `registerSpecTools` / `registerWorktreeTools`.
- **Regression:** Full `bun test` + `npx tsc --noEmit` must pass.

## Risks and Mitigations

| Risk                                                                 | Likelihood | Impact | Mitigation                                                                                                                                       |
| -------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Worktree tools need MemoryStore for git ops even in sidecar mode     | High       | Medium | Create local MemoryStore for WorktreeManager only when client is set; DB reads go through sidecar                                                |
| SidecarClient and routes changes break existing hooks                | Low        | High   | Additive changes only — new endpoints, new client methods. Existing signatures unchanged.                                                        |
| routes.ts exceeds 400 lines                                          | Medium     | Low    | ~60 new lines → ~374 total. Monitor closely, split into route modules if needed.                                                                 |
| Breaking change to registerSpecTools/registerWorktreeTools signature | High       | Low    | Backwards-compat: accept both old `MemoryStore` and new `{ client, store }` deps. Use `'client' in deps` discriminator, not fragile duck-typing. |

## Pre-Mortem

_Assume this plan failed. Most likely internal reasons:_

1. **Worktree tools can't resolve slugs through sidecar** (Task 4) → Trigger: `worktree_detect` returns "not found" in sidecar mode because the sidecar's `WorktreeStore` is using a different DB instance than the one worktrees were inserted into. Verify: in integration test, insert worktree via sidecar store, then resolve via sidecar endpoint.
2. **Spec tools break backwards compatibility** (Task 5) → Trigger: `createSentinalServer` tests fail because `registerSpecTools` no longer accepts bare `MemoryStore`. Verify: ensure the backwards-compat `"insertSession" in deps` guard (or similar) is added.

## Goal Verification

### Truths

1. Calling `tdd_set_state` with `state: "RED_CONFIRMED"` allows the TDD guard to pass on the next edit attempt for that file
2. Calling `tdd_status` returns all active TDD cycle states for a spec or globally
3. Calling `tdd_clear` removes TDD state for a file, resetting the guard to its default blocking behavior
4. When the sidecar is running, `spec_notify` routes the `insertNotification` call through the sidecar (not a cold MemoryStore)
5. When the sidecar is running, `worktree_detect` resolves slugs through the sidecar (not a cold MemoryStore)
6. The `bun -e` inline script workaround for TDD bypass is no longer needed — agents can use `tdd_set_state` MCP tool instead
7. All existing tests continue to pass (no regressions from signature changes)

### Artifacts

- `src/tdd/mcp-tools.ts` — TDD MCP tools module
- `src/tdd/mcp-tools.test.ts` — TDD MCP tools tests
- `src/sidecar/routes.ts` — Updated with new endpoints
- `src/sidecar/client.ts` — Updated with new methods
- `src/spec/mcp-tools.ts` — Refactored to use sidecar-first pattern
- `src/worktree/mcp-tools.ts` — Refactored to use sidecar-first pattern
- `src/mcp/server.ts` — Updated wiring

### Key Links

1. `src/tdd/mcp-tools.ts` ↔ `src/sidecar/client.ts` (TDD tools delegate to sidecar)
2. `src/spec/mcp-tools.ts` ↔ `src/sidecar/client.ts` (spec tools now use sidecar for DB ops)
3. `src/worktree/mcp-tools.ts` ↔ `src/sidecar/client.ts` (worktree tools use sidecar for slug resolution)
4. `src/sidecar/routes.ts` ↔ `src/sidecar/server.ts` (new routes need WorktreeStore in context)
5. `src/mcp/server.ts` ↔ all tool modules (unified deps pattern)

## Progress Tracking

- [x] Task 1: Add new sidecar endpoints and client methods
- [x] Task 2: Add WorktreeStore to SidecarContext
- [x] Task 3: Create TDD MCP tools module
- [x] Task 4: Refactor worktree MCP tools for sidecar-first
- [x] Task 5: Refactor spec MCP tools for sidecar-first
- [x] Task 6: Update MCP server wiring
- [x] Task 7: Update skill/command files with TDD tool references
- [x] Task 8: Build, update, and verify
      **Total Tasks:** 8 | **Completed:** 8 | **Remaining:** 0

## Implementation Tasks

### Task 1: Add new sidecar endpoints and client methods

**Objective:** Add the missing sidecar routes and corresponding SidecarClient methods needed for TDD tools and sidecar-first refactor of spec/worktree tools.

**Dependencies:** None

**Files:**

- Modify: `src/sidecar/routes.ts` (~60 new lines)
- Modify: `src/sidecar/client.ts` (~40 new lines)
- Test: `src/sidecar/client.test.ts` (add tests for new methods)

**Key Decisions / Notes:**

- New routes follow the existing handler pattern in `src/sidecar/routes.ts:35-111`
- New endpoints:
  - `GET /tdd-state/list?spec_id=...` → calls `store.listActiveTddStates(specId)`, returns TddCycle array
  - `GET /spec/events?spec_id=...&limit=...` → calls `store.getSpecEvents(specId, limit)`, returns SpecEvent array
  - `GET /worktree/resolve?slug=...&project=...` → calls `wtStore.resolveBySlug(slug, project)`, returns Worktree or null
- New client methods: `listActiveTddStates(specId?)`, `clearTddStatesForSpec(specId)`, `getSpecEvents(specId, limit?)`, `resolveWorktreeBySlug(slug, project)`
- `clearTddStatesForSpec` only needs a client method — the route already exists via `POST /tdd-state { action: "clearForSpec" }`

**Definition of Done:**

- [ ] `GET /tdd-state/list` returns active TDD states (with optional spec_id filter)
- [ ] `GET /spec/events` returns spec events for a given spec_id
- [ ] `GET /worktree/resolve` returns worktree or null for a slug
- [ ] All 4 new client methods have type signatures matching the route responses
- [ ] Existing sidecar tests still pass
- [ ] No TypeScript errors

**Verify:**

- `bun test src/sidecar/client.test.ts`
- `npx tsc --noEmit`

---

### Task 2: Add WorktreeStore to SidecarContext

**Objective:** Include `WorktreeStore` in the sidecar context so the new `/worktree/resolve` route can access it.

**Dependencies:** None (can be done in parallel with Task 1)

**Files:**

- Modify: `src/sidecar/server.ts` (add `wtStore` to SidecarContext, create in `startSidecar`)
- Modify: `src/sidecar/routes.ts` (use `ctx.wtStore` in the worktree resolve handler from Task 1)

**Key Decisions / Notes:**

- `SidecarContext` at `src/sidecar/server.ts:23-27` gains `wtStore: WorktreeStore`
- `WorktreeStore` constructor takes `MemoryStore` — just call `new WorktreeStore(store)` after store creation at `src/sidecar/server.ts:54-57`
- Import `WorktreeStore` from `../worktree/store.js`

**Definition of Done:**

- [ ] `SidecarContext` has `wtStore: WorktreeStore` property
- [ ] `startSidecar()` creates WorktreeStore and includes it in context
- [ ] No TypeScript errors

**Verify:**

- `npx tsc --noEmit`
- `bun test src/sidecar/`

---

### Task 3: Create TDD MCP tools module

**Objective:** Create `src/tdd/mcp-tools.ts` with 3 tools: `tdd_status`, `tdd_set_state`, `tdd_clear`. Follow the sidecar-first pattern from `src/memory/mcp-tools.ts`.

**Dependencies:** Task 1 (needs `listActiveTddStates` and `clearTddStatesForSpec` client methods)

**Files:**

- Create: `src/tdd/mcp-tools.ts` (~150 lines)
- Create: `src/tdd/mcp-tools.test.ts` (~200 lines)

**Key Decisions / Notes:**

- `registerTddTools(server, deps: TddToolsDeps)` where `TddToolsDeps = { client?: SidecarClient | null; store?: MemoryStore | null }`
- Follow the pattern from `src/memory/mcp-tools.ts:28-49` — backwards compat check, then client/store ternary
- **`tdd_status`:** Parameters: `file_path` (optional), `spec_id` (optional). If `file_path` given: return single TddCycle. If `spec_id` given (or neither): return all active states via `listActiveTddStates`. Uses `client.getTddState()` or `client.listActiveTddStates()` in sidecar mode, `store.getTddState()` or `store.listActiveTddStates()` in direct mode.
- **`tdd_set_state`:** Parameters: `file_path` (required), `state` (required, enum of TDD_CYCLE_STATES), `spec_id` (optional), `test_file_path` (optional). Allows any state including `RED_CONFIRMED` bypass. Uses `client.setTddState()` or `store.setTddState()`.
- **`tdd_clear`:** Parameters: `file_path` (optional), `spec_id` (optional). If `file_path`: clear that file. If `spec_id`: clear all for spec. If neither: error. Uses `client.clearTddState()` / `client.clearTddStatesForSpec()` or `store.clearTddState()` / `store.clearTddStatesForSpec()`.
- Tests should cover both sidecar and direct paths using mock client objects

**Definition of Done:**

- [ ] `tdd_status` returns formatted TDD state (single file or list)
- [ ] `tdd_set_state` sets state for a file (including RED_CONFIRMED bypass)
- [ ] `tdd_clear` clears state for a file or spec
- [ ] All 3 tools work in sidecar mode (mock client) and direct mode (real MemoryStore)
- [ ] Tests pass: `bun test src/tdd/mcp-tools.test.ts`
- [ ] No TypeScript errors

**Verify:**

- `bun test src/tdd/mcp-tools.test.ts`
- `npx tsc --noEmit`

---

### Task 4: Refactor worktree MCP tools for sidecar-first

**Objective:** Change `registerWorktreeTools` to accept `{ client?, store? }` deps and use sidecar for slug resolution (DB reads). Git operations stay direct.

**Dependencies:** Task 1 (needs `resolveWorktreeBySlug` client method), Task 2 (needs WorktreeStore in sidecar context)

**Files:**

- Modify: `src/worktree/mcp-tools.ts` (~30 lines changed)
- Modify: `src/worktree/mcp-tools.test.ts` (add sidecar-mode tests)

**Key Decisions / Notes:**

- New signature: `registerWorktreeTools(server, deps: WorktreeToolsDeps | MemoryStore)` where `WorktreeToolsDeps = { client?: SidecarClient | null; store?: MemoryStore | null }`
- Add backwards-compat guard: check `'client' in deps || 'store' in deps` to distinguish deps object from bare MemoryStore (MemoryStore won't have these properties). This avoids fragile `"insertSession" in deps` duck-typing.
- For `worktree_detect`: use `client.resolveWorktreeBySlug(slug, project)` in sidecar mode, `wtStore.resolveBySlug(slug, project)` in direct mode
- For `worktree_diff` and `worktree_sync`: use sidecar for slug resolution, then direct `WorktreeManager` for git ops. This means in sidecar mode, we still need a local `WorktreeManager` — create one with a local `MemoryStore` (only for git operations, not for slug resolution DB reads)
- For `worktree_create`: `manager.create()` does both git ops AND DB insert internally. In sidecar mode the manager still writes to its own local store. This is acceptable because the sidecar will see the worktree on next resolve (same DB file). Alternatively, after creation, we could sync via sidecar — but the DB file is shared, so this is a non-issue.

**Definition of Done:**

- [ ] `registerWorktreeTools` accepts both `MemoryStore` (backwards compat) and `{ client, store }` deps
- [ ] `worktree_detect` uses sidecar for slug resolution when client available
- [ ] Existing worktree MCP tool tests still pass
- [ ] New tests verify sidecar-mode behavior with mock client
- [ ] No TypeScript errors

**Verify:**

- `bun test src/worktree/mcp-tools.test.ts`
- `npx tsc --noEmit`

---

### Task 5: Refactor spec MCP tools for sidecar-first

**Objective:** Change `registerSpecTools` to accept `{ client?, store? }` deps and use sidecar for DB operations (spec sync, notifications, events). File I/O stays direct.

**Dependencies:** Task 1 (needs `getSpecEvents` client method)

**Files:**

- Modify: `src/spec/mcp-tools.ts` (~40 lines changed)
- Modify: `src/spec/mcp-tools.test.ts` (add sidecar-mode tests)

**Key Decisions / Notes:**

- New signature: `registerSpecTools(server, deps: SpecToolsDeps | MemoryStore)` where `SpecToolsDeps = { client?: SidecarClient | null; store?: MemoryStore | null }`
- Add backwards-compat guard: check `'client' in deps || 'store' in deps` to distinguish deps object from bare MemoryStore. In direct mode, create `SpecStore` from `store` internally (preserving the current pattern at `src/spec/mcp-tools.ts:25-27`).
- **Existing client methods already available:** `client.syncSpec()` (line 198), `client.getCurrentSpec()` (line 202), `client.insertNotification()` (line 208). Only `client.getSpecEvents()` is new (added in Task 1).
- Tool-by-tool sidecar routing:
  - `spec_status`: `client.getCurrentSpec(project)` vs `specStore.getCurrentSpec(project)`
  - `spec_register`: file I/O stays direct, then `client.syncSpec(planPath, project)` vs `specStore.syncFromPlanFile(planPath, project)` for the DB sync
  - `spec_notify`: `client.insertNotification(notif)` vs `store.insertNotification(notif)`
  - `spec_events`: `client.getSpecEvents(specId, limit)` vs `store.getSpecEvents(specId, limit)`
  - `spec_wait_file`: no DB ops — stays fully direct (no change)
  - `spec_config`: no DB ops — stays fully direct (no change)
  - `spec_plan_parse`: no DB ops — stays fully direct (no change)

**Definition of Done:**

- [ ] `registerSpecTools` accepts both `MemoryStore` (backwards compat) and `{ client, store }` deps
- [ ] `spec_status`, `spec_register`, `spec_notify`, `spec_events` use sidecar when client available
- [ ] `spec_wait_file`, `spec_config`, `spec_plan_parse` remain direct-only (no change)
- [ ] Existing spec MCP tool tests still pass
- [ ] New tests verify sidecar-mode behavior with mock client
- [ ] No TypeScript errors

**Verify:**

- `bun test src/spec/mcp-tools.test.ts`
- `npx tsc --noEmit`

---

### Task 6: Update MCP server wiring

**Objective:** Update `createSentinalServer` to pass `{ client, store }` to all tool modules (spec, worktree, TDD) instead of just `store`.

**Dependencies:** Tasks 3, 4, 5

**Files:**

- Modify: `src/mcp/server.ts` (~10 lines changed)
- Modify: `src/index.ts` (add `registerTddTools` export)

**Key Decisions / Notes:**

- Change `registerSpecTools(server, store)` → `registerSpecTools(server, { client, store })`
- Change `registerWorktreeTools(server, store)` → `registerWorktreeTools(server, { client, store })`
- Add `registerTddTools(server, { client, store })`
- Import `registerTddTools` from `../tdd/mcp-tools.js`
- Bump server version to `0.4.0`
- Add exports to `src/index.ts`: `registerTddTools`, `TddToolsDeps`

**Definition of Done:**

- [ ] All 4 tool modules receive `{ client, store }` deps
- [ ] MCP server version is `0.4.0`
- [ ] `src/index.ts` exports `registerTddTools`
- [ ] Integration test verifies that `createSentinalServer` with a mock `SidecarClient` correctly wires spec/worktree/TDD tools to use the client for DB operations
- [ ] `bun test src/mcp/` passes
- [ ] No TypeScript errors

**Verify:**

- `bun test`
- `npx tsc --noEmit`

---

### Task 7: Update skill/command files with TDD tool references

**Objective:** Add TDD MCP tool references to skill and command files, and update the `bun -e` TDD bypass pattern to reference the new `tdd_set_state` tool.

**Dependencies:** Task 3 (TDD tools must exist)

**Files:**

- Modify: `targets/opencode/skills/spec-implement/SKILL.md`
- Modify: `targets/claude-code/commands/spec-implement.md`
- Modify: `targets/opencode/rules/cli-tools.md`
- Modify: `targets/claude-code/rules/cli-tools.md`
- Modify: `targets/opencode/rules/testing.md`
- Modify: `targets/claude-code/rules/testing.md`

**Key Decisions / Notes:**

- In `spec-implement` skill/command: add `tdd_set_state` as the preferred way to bypass TDD guard during RED phase, replacing the `bun -e` inline script pattern
- In `cli-tools.md` rules: add `tdd_status`, `tdd_set_state`, `tdd_clear` to the MCP tools table
- In `testing.md` rules: mention `tdd_status` for checking current TDD state
- Keep the `bun -e` pattern as a fallback in case MCP tools aren't available

**Definition of Done:**

- [ ] `spec-implement` skill/command references `tdd_set_state` as preferred bypass
- [ ] `cli-tools.md` includes all 3 TDD tools in the MCP tools table
- [ ] `testing.md` references `tdd_status` for checking state
- [ ] `bun -e` pattern remains as documented fallback

**Verify:**

- `grep -r 'tdd_set_state' targets/` returns matches in expected files

---

### Task 8: Build, update, and verify

**Objective:** Rebuild embedded assets, compile binary, sign, update installations, run full test suite.

**Dependencies:** All previous tasks

**Files:**

- Auto-generated: `src/cli/embedded-assets.ts`
- Binary: `dist/sentinal`

**Key Decisions / Notes:**

- Build: `bun run build:cli`
- Sign: `codesign -f -s - ~/.sentinal/bin/sentinal`
- Update: `sentinal update`
- Test: `bun test` (expect 2 pre-existing sidecar failures, rest pass)
- Typecheck: `npx tsc --noEmit`

**Definition of Done:**

- [ ] `bun run build:cli` succeeds
- [ ] Binary signed and installed
- [ ] `sentinal update` propagates changes
- [ ] `bun test` — zero new failures (2 pre-existing OK)
- [ ] `npx tsc --noEmit` — zero errors

**Verify:**

- `bun test`
- `npx tsc --noEmit`
- `sentinal --version`
