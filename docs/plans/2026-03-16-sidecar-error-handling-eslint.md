# Sidecar Error Handling & ESLint Resolution Plan

Created: 2026-03-16
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Bugfix

## Summary

**Goal:** Fix two issues discovered during integration testing: (1) SQLite errors in sidecar routes return Bun's HTML error page instead of JSON, and (2) ESLint quality checks fail because `bunx` temp-installs eslint with missing transitive dependencies.

**Architecture:** Add a global error handler to `Bun.serve` + try/catch in `handleSetTddState`, and upgrade `getRunner()` to prefer local `node_modules/.bin/` binaries before falling back to `bunx`/`npx`.

**Tech Stack:** Bun.serve error handler, SQLite error handling, Node.js `existsSync` for binary resolution.

## Scope

### In Scope

- Sidecar `Bun.serve` error handler returning JSON instead of HTML
- Try/catch in `handleSetTddState` for clearer SQLite constraint error messages
- `getRunner()` upgraded to check `node_modules/.bin/` for local eslint/prettier before using bunx/npx
- Tests for both fixes

### Out of Scope

- Adding eslint/prettier as sentinal devDependencies (these are target-project tools)
- Refactoring quality-routes.ts to reduce line count
- Changing `detectPackageManager` detection logic

## Context for Implementer

- **Sidecar server:** `src/sidecar/server.ts:263-300` — `fetchHandler` dispatches to route handlers. `Bun.serve` at lines 277-283 (unix+http) and 293-298 (http-only) do NOT specify an `error` handler, so Bun's default renders HTML.
- **TDD set state:** `src/sidecar/routes.ts:219-250` — `handleSetTddState` calls `ctx.store.setTddState()` at line 238 without try/catch. The top-level catch at line 139 should work, but Bun's error handler intercepts synchronous throws from `bun:sqlite` before the async catch can handle them.
- **Quality runner:** `src/sidecar/quality-routes.ts:70-73` — `getRunner()` returns `bunx` or `npx` based on lockfile detection. It never checks for local `node_modules/.bin/` binaries, so if eslint isn't installed locally, `bunx` creates a temp install that may have broken transitive deps.
- **Patterns to follow:** `handleCreateSession` (routes.ts:158-178) wraps `store.insertSession()` in its own try/catch for UNIQUE constraint — same pattern needed for setTddState FOREIGN KEY.
- **Test patterns:** `src/sidecar/server.test.ts` uses `startSidecar({store, port: 0, httpOnly: true})` with `get()`/`post()` helpers. `src/sidecar/quality-routes.test.ts` has the same pattern.

## Assumptions

- Bun.serve's default error handler renders HTML when an uncaught exception escapes the `fetch` callback — supported by observed behavior during integration test — Tasks 1, 2 depend on this.
- Target projects using sentinal will typically have eslint/prettier in their own `node_modules/.bin/` — supported by standard dev toolchain patterns — Task 3 depends on this.

## Testing Strategy

- **Task 1:** Test that a POST to `/tdd-state` with an invalid spec_id returns a JSON error response (not HTML), with status 500 and `ok: false`.
- **Task 2:** Test that `Bun.serve` error handler returns JSON for uncaught errors.
- **Task 3:** Test `getRunner()` prefers local binary when it exists, falls back to bunx/npx otherwise.

## Risks and Mitigations

| Risk                                        | Likelihood | Impact | Mitigation                                          |
| ------------------------------------------- | ---------- | ------ | --------------------------------------------------- |
| Bun.serve `error` handler signature changes | Low        | Low    | Handler is documented in Bun docs, simple signature |
| Local binary detection breaks on Windows    | Low        | Low    | sentinal targets macOS/Linux only                   |

## Pre-Mortem

1. **The Bun.serve error handler doesn't catch all errors** (Task 1) -> Trigger: integration test still shows HTML for a different error path. Mitigated by also adding route-level try/catch.
2. **Local binary path differs on some systems** (Task 3) -> Trigger: `existsSync` returns false for a valid binary. Mitigated by using `join(projectPath, 'node_modules', '.bin', toolName)` which is standard across all platforms.

## Goal Verification

### Truths

1. A POST to `/tdd-state` with an invalid `specId` returns `{"ok": false, "error": "..."}` with status 500
2. Any uncaught error in the sidecar fetch handler returns JSON, not HTML
3. ESLint quality check uses local `node_modules/.bin/eslint` when available
4. When no local binary exists, falls back to `bunx`/`npx` as before

### Artifacts

- `src/sidecar/server.ts` — Bun.serve error handler
- `src/sidecar/routes.ts` — try/catch in handleSetTddState
- `src/sidecar/quality-routes.ts` — improved getRunner with local binary detection
- `src/sidecar/server.test.ts` — tests for error handling
- `src/sidecar/quality-routes.test.ts` — tests for getRunner

### Key Links

- `Bun.serve` error handler -> `fetchHandler` -> `handleSidecarRequest`
- `getRunner()` -> `runEslint()` / `runPrettier()`

## Progress Tracking

- [x] Task 1: Sidecar error handler & TDD route try/catch
- [x] Task 2: Local binary resolution for eslint/prettier
      **Total Tasks:** 2 | **Completed:** 2 | **Remaining:** 0

## Implementation Tasks

### Task 1: Sidecar Error Handler & TDD Route Try/Catch

**Objective:** Ensure all sidecar HTTP errors return JSON responses, not Bun's default HTML error page. Add route-level try/catch for SQLite constraint errors in TDD state handler.

**Dependencies:** None

**Files:**

- Modify: `src/sidecar/server.ts` (add `error` handler to both `Bun.serve` calls)
- Modify: `src/sidecar/routes.ts` (wrap `store.setTddState()` in try/catch)
- Test: `src/sidecar/server.test.ts`

**Key Decisions / Notes:**

- Add `error(err)` handler to all `Bun.serve` calls in `startSidecar()` (lines 277, 279, 293). Handler returns `Response.json({ ok: false, error: message }, { status: 500 })`.
- In `handleSetTddState` (routes.ts:237-245), wrap the `ctx.store.setTddState()` call in try/catch. Catch SQLite FOREIGN KEY errors and return `fail("FOREIGN KEY constraint failed: spec_id does not exist", 400)`.
- Pattern to follow: `handleCreateSession` at routes.ts:158-178 which catches UNIQUE constraint.

**Definition of Done:**

- [ ] `Bun.serve` calls include `error` handler returning JSON
- [ ] POST `/tdd-state` with invalid specId returns `{"ok": false, "error": "..."}` as JSON
- [ ] All existing tests still pass
- [ ] New test verifying JSON error response for invalid specId
- [ ] Bun.serve error handler verified as defense-in-depth (may not be independently testable since fetch handler has its own try/catch)

**Verify:**

- `bun test src/sidecar/server.test.ts`

### Task 2: Local Binary Resolution for ESLint/Prettier

**Objective:** Upgrade `getRunner()` in quality-routes.ts to check for local `node_modules/.bin/` binaries before falling back to `bunx`/`npx`. This avoids broken transitive dependencies in `bunx` temp-installs.

**Dependencies:** None

**Files:**

- Modify: `src/sidecar/quality-routes.ts` (upgrade `getRunner()` to `getToolCommand()`)
- Test: `src/sidecar/quality-routes.test.ts`

**Key Decisions / Notes:**

- Replace `getRunner(projectPath)` with `getToolCommand(projectPath, toolName)` that returns the full command prefix. Resolution order:
  1. Check `join(projectPath, 'node_modules', '.bin', toolName)` — if exists, return it directly (no bunx/npx wrapper)
  2. Fall back to `bunx <toolName>` or `npx <toolName>` based on package manager
- Update callers in `runTsc()` (line 172,188), `runEslint()` (line 230,243), `runPrettier()` (line 285,289,314) to use `getToolCommand(projectPath, 'tsc')` / `getToolCommand(projectPath, 'eslint')` / `getToolCommand(projectPath, 'prettier')`.
- `getToolCommand(projectPath, toolName)` returns `string[]` — the full command prefix including the tool name. Local: `['/abs/path/node_modules/.bin/eslint']`. Fallback: `['bunx', 'eslint']`. Callers spread it: `[...getToolCommand(projectPath, 'eslint'), '--fix', target]`.
- `runTsc` at line 172 also uses `getRunner()` — update it to use `getToolCommand(projectPath, 'tsc')` with the same spread pattern for the `cmd` array.

**Definition of Done:**

- [ ] `getToolCommand()` checks local binary first, falls back to bunx/npx
- [ ] ESLint and Prettier runners use new resolution
- [ ] Test verifying local binary is preferred when it exists
- [ ] Test verifying fallback to bunx/npx when no local binary
- [ ] All existing tests still pass

**Verify:**

- `bun test src/sidecar/quality-routes.test.ts`
