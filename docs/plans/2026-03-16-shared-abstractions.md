# Shared Abstractions Implementation Plan

Created: 2026-03-16
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Summary

**Goal:** Extract duplicated utility functions into shared modules to reduce ~400 lines of boilerplate across sidecar routes, MCP tools, and tests.

**Architecture:** Create 3 new shared modules: sidecar response helpers, MCP text/error helpers, and test setup helpers. Mechanically replace duplicate code in all consumers with imports from the shared modules.

**Tech Stack:** TypeScript, Bun test framework, MCP SDK.

## Scope

### In Scope

- Extract sidecar response helpers (`json`, `ok`, `fail`, `readBody`) into shared module
- Extract MCP tool text/error response helpers into shared module
- Extract test setup helpers (`makeTmpDir`, `captureTools`) into shared module
- Update all consuming files to import from shared modules

### Out of Scope

- P2 abstractions (TDD guard/tracker decision logic, pre-edit formatting, OpenCode plugin)
- Shared `McpToolsDeps` interface (deferred — each module's deps are subtly different)
- CLI `withStore()` wrapper
- Any behavioral changes — this is purely structural refactoring

## Context for Implementer

- **Sidecar response helpers:** `routes.ts:18-35` and `quality-routes.ts:91-108` have identical `json()`, `ok()`, `fail()`, `readBody()` functions. `project-routes.ts` and `tdd-routes.ts` use inline `Response.json()` — should be migrated to use the shared helpers for consistency.
- **MCP text pattern:** `{ content: [{ type: "text" as const, text: ... }] }` appears 46 times across 4 mcp-tools files (tdd:12, spec:14, worktree:12, analysis:8). Error catch blocks repeat `err instanceof Error ? err.message : String(err)` with a prefix string 19+ times.
- **Test helpers:** `makeTmpDir()` appears in 19 test files with only the prefix string varying. `captureTools()` appears in 4 MCP test files with identical logic (monkey-patching McpServer).
- **Patterns to follow:** Existing shared utilities live in `src/utils/` (e.g., `src/utils/tdd.ts`). For sidecar-specific helpers, `src/sidecar/` is appropriate. For test helpers, `src/test-helpers.ts` at root level.
- **Conventions:** All imports use `.js` extension (ESM). Exports are named, not default.

## Assumptions

- The 4 `json()`/`ok()`/`fail()`/`readBody()` functions are pure utilities with no shared state — supported by reading routes.ts:18-35 and quality-routes.ts:91-108 — Task 1 depends on this.
- All 46 MCP text response patterns follow the same shape — supported by grep count — Task 2 depends on this.
- All 19 `makeTmpDir()` implementations are identical except the prefix — supported by grep — Task 3 depends on this.
- All 4 `captureTools()` implementations follow the same monkey-patch pattern — supported by reading the test files — Task 3 depends on this.

## Testing Strategy

- **No new tests needed** — this is a mechanical refactoring. All existing tests must continue to pass unchanged.
- Run `bun test` after each task to verify no regressions.

## Risks and Mitigations

| Risk                                              | Likelihood | Impact | Mitigation                                          |
| ------------------------------------------------- | ---------- | ------ | --------------------------------------------------- |
| Circular imports from shared modules              | Low        | Medium | Place helpers in leaf modules with no upstream deps |
| Subtle behavioral differences in "identical" code | Low        | Low    | Verify each replacement compiles and tests pass     |

## Pre-Mortem

1. **Import path breaks after extraction** (all tasks) -> Trigger: TypeScript errors on first `bun test` after moving helpers. Mitigated by running `check_diagnostics` after each task.
2. **Shared test helper breaks test isolation** (Task 3) -> Trigger: Tests that depended on a specific tmpDir prefix start failing. Mitigated by keeping the optional prefix parameter.

## Goal Verification

### Truths

1. `json()`, `ok()`, `fail()`, `readBody()` exist in exactly one location (`src/sidecar/response.ts`)
2. No MCP tool file contains `{ type: "text" as const, text: ... }` boilerplate — all use `mcpText()` helper
3. No test file contains a local `makeTmpDir()` or `captureTools()` function
4. All 1061+ existing tests pass

### Artifacts

- `src/sidecar/response.ts` — sidecar response helpers
- `src/mcp/helpers.ts` — MCP text/error helpers
- `src/test-helpers.ts` — test setup helpers

### Key Links

- `response.ts` <- `routes.ts`, `quality-routes.ts`, `project-routes.ts`, `tdd-routes.ts`
- `mcp/helpers.ts` <- `tdd/mcp-tools.ts`, `spec/mcp-tools.ts`, `worktree/mcp-tools.ts`, `analysis/mcp-tools.ts`
- `test-helpers.ts` <- 19 test files (makeTmpDir) + 4 test files (captureTools)

## Progress Tracking

- [x] Task 1: Extract sidecar response helpers
- [x] Task 2: Extract MCP text/error helpers
- [x] Task 3: Extract test setup helpers
      **Total Tasks:** 3 | **Completed:** 3 | **Remaining:** 0

## Implementation Tasks

### Task 1: Extract Sidecar Response Helpers

**Objective:** Create `src/sidecar/response.ts` with the 4 response helpers and update all sidecar route files to import from it.

**Dependencies:** None

**Files:**

- Create: `src/sidecar/response.ts`
- Modify: `src/sidecar/routes.ts` (remove local helpers, add import)
- Modify: `src/sidecar/quality-routes.ts` (remove local helpers, add import)
- Modify: `src/sidecar/project-routes.ts` (replace inline Response.json with ok/fail)
- Modify: `src/sidecar/tdd-routes.ts` (replace inline Response.json with ok/fail)

**Key Decisions / Notes:**

- Export: `json()`, `ok()`, `fail()`, `readBody()`
- `project-routes.ts` uses `Response.json({ ok: true, data: ... })` — replace with `ok(data)` and `fail(msg, status)`
- `tdd-routes.ts` uses `Response.json({ ok: true, data: result })` — replace with `ok(result)` and `fail(msg, status)`
- Keep both `json()` (low-level) and `ok()`/`fail()` (high-level) since some callers may need custom status codes
- `server.ts` uses `Response.json()` only in the `errorHandler` (defense-in-depth for Bun.serve) — this is intentionally excluded since it runs outside the normal route handler context

**Definition of Done:**

- [ ] `src/sidecar/response.ts` exists with all 4 helpers exported
- [ ] No local `json()`/`ok()`/`fail()`/`readBody()` in any route file
- [ ] All sidecar route files import from `./response.js`
- [ ] `bun test src/sidecar/` passes
- [ ] Zero TypeScript errors

**Verify:**

- `bun test src/sidecar/`

### Task 2: Extract MCP Text/Error Helpers

**Objective:** Create `src/mcp/helpers.ts` with `mcpText()` and `mcpError()` helpers and update all 4 MCP tool files to use them.

**Dependencies:** None

**Files:**

- Create: `src/mcp/helpers.ts`
- Modify: `src/tdd/mcp-tools.ts` (12 replacements)
- Modify: `src/spec/mcp-tools.ts` (14 replacements)
- Modify: `src/worktree/mcp-tools.ts` (12 replacements)
- Modify: `src/analysis/mcp-tools.ts` (8 replacements)
- Modify: `src/memory/mcp-tools.ts` (replacements for text/error patterns)
- Test: existing tests in each module

**Key Decisions / Notes:**

- `mcpText(text: string)` returns `{ content: [{ type: "text" as const, text }] }`
- `mcpError(prefix: string, err: unknown)` extracts message and returns `mcpText(\`${prefix}: ${msg}\`)`
- Replace all `return { content: [{ type: "text" as const, text: ... }] }` with `return mcpText(...)`
- Replace all catch blocks with `return mcpError("Error doing X", err)`
- Include `memory/mcp-tools.ts` — replacing inline boilerplate with imports will reduce its line count significantly (currently 506 lines)

**Definition of Done:**

- [ ] `src/mcp/helpers.ts` exists with `mcpText()` and `mcpError()` exported
- [ ] No MCP tool file contains inline `{ type: "text" as const, text: ... }` boilerplate
- [ ] `bun test src/tdd/ src/spec/ src/worktree/ src/analysis/ src/memory/mcp-tools.test.ts` passes
- [ ] Zero TypeScript errors

**Verify:**

- `bun test src/tdd/mcp-tools.test.ts src/spec/mcp-tools.test.ts src/worktree/mcp-tools.test.ts src/analysis/mcp-tools.test.ts src/memory/mcp-tools.test.ts`

### Task 3: Extract Test Setup Helpers

**Objective:** Create `src/test-helpers.ts` with `makeTmpDir()` and `captureTools()` and update all 19+ test files to import from it.

**Dependencies:** None

**Files:**

- Create: `src/test-helpers.ts`
- Modify: 19 test files containing `makeTmpDir()` (see list below)
- Modify: 4 test files containing `captureTools()` (tdd, spec, worktree, analysis mcp-tools.test.ts)

**Test files with makeTmpDir:**
`src/git/utils.test.ts`, `src/tdd/mcp-tools.test.ts`, `src/mcp/server.test.ts`, `src/sidecar/lifecycle.test.ts`, `src/analysis/mcp-tools.test.ts`, `src/dashboard/lifecycle.test.ts`, `src/worktree/mcp-tools.test.ts`, `src/spec/mcp-tools.test.ts`, `src/worktree/manager.test.ts`, `src/spec/store.test.ts`, `src/sidecar/server.test.ts`, `src/worktree/store.test.ts`, `src/memory/migrations.test.ts`, `src/sidecar/client.test.ts`, `src/hooks/memory-observer.test.ts`, `src/hooks/tdd-tracker.test.ts`, `src/hooks/tdd-guard.test.ts`, `src/cli/commands/worktree.test.ts`, `src/cli/commands/uninstall.test.ts`

**Key Decisions / Notes:**

- `makeTmpDir(prefix = "sentinal-test")` — accepts optional prefix, returns `join(tmpdir(), \`${prefix}-${Date.now()}-${random}\`)`. Callers can pass their module name or use the default.
- `captureTools` is generic over the deps type: `captureTools<D>(registerFn: (server: McpServer, deps: D) => void, deps: D): Map<string, ToolHandler>`. Each call site passes its module-specific deps type and register function. Check the worktree variant which may take `(store: MemoryStore)` directly rather than a deps object — if so, wrap with an inline adapter.
- Each test file removal: delete the local function, add `import { makeTmpDir } from "../test-helpers.js"` (adjust relative path), keep all other code identical.

**Definition of Done:**

- [ ] `src/test-helpers.ts` exists with `makeTmpDir()` and `captureTools()` exported
- [ ] No test file contains a local `makeTmpDir()` function
- [ ] No MCP test file contains a local `captureTools()` function
- [ ] `bun test` (full suite) passes
- [ ] Zero TypeScript errors

**Verify:**

- `bun test`
