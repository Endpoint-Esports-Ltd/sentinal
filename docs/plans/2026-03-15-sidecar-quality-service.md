# Sidecar Quality Service Implementation Plan

Created: 2026-03-15
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Summary

**Goal:** Move TypeScript, ESLint, and Prettier quality checks from per-edit subprocess spawning into the sidecar as a warm service with incremental type-checking, reducing per-edit latency from 5-35 seconds to under 2 seconds.

**Architecture:** New sidecar route handler (`quality-routes.ts`) with a `POST /quality-check` endpoint that accepts a project path + optional file path, runs tsc (with `--incremental` via tsbuildinfo caching), eslint, and prettier as async subprocesses with timeouts, and returns structured results. A new `quality_report` MCP tool provides the AI with batch quality checking. The Claude Code file-checker hook and OpenCode plugin are updated to call the sidecar instead of spawning their own subprocesses.

**Tech Stack:** Bun.spawn (async), TypeScript `--incremental --tsBuildInfoFile`, ESLint `--fix`, Prettier `--check/--write`, sidecar HTTP routes

## Scope

### In Scope

- New `POST /quality-check` sidecar endpoint (single-file and project-wide modes)
- Incremental tsc via `--tsBuildInfoFile` caching in `~/.sentinal/tsbuildinfo/`
- ESLint and Prettier subprocess execution with timeouts
- `quality_report` MCP tool for batch quality checking
- Update file-checker hook to delegate to sidecar
- Update OpenCode plugin to delegate to sidecar
- Structured JSON responses with per-tool results

### Out of Scope

- In-process TypeScript API (future optimization)
- In-process ESLint/Prettier API (future optimization)
- Angular `ng build --dry-run` (keep as-is — rare and already has timeout)
- NestJS/Angular content checks (keep as-is — these are already instant regex checks)
- File length checks (keep as-is — already instant)
- Companion test file checks (keep as-is — already instant)

## Context for Implementer

> Write for an implementer who has never seen the codebase.

- **Patterns to follow:**
  - Route handler pattern: `src/sidecar/routes.ts:39-139` — manual URL matching, `ok()` / `fail()` helpers
  - Sidecar context: `src/sidecar/server.ts:32-39` — `SidecarContext` holds stores, accessed by route handlers
  - Client method pattern: `src/sidecar/client.ts:195-208` — `this.post("/endpoint", body)` / `this.get("/endpoint?q=v")`
  - MCP tool registration: `src/analysis/mcp-tools.ts:51-185` — `registerAnalysisTools()` with Zod schemas
  - Subprocess execution: `Bun.spawn()` with timeout via `Promise.race` — see `src/analysis/mcp-tools.ts:68-90`

- **Conventions:**
  - Route files: keep under 400 lines. `routes.ts` is already at 398 — new routes MUST go in `quality-routes.ts`
  - Error responses: `{ ok: false, error: "message" }` — never throw from route handlers
  - Subprocess timeouts: always use `Promise.race` with `proc.kill()` fallback
  - Package manager detection: `detectPackageManager()` in `src/checkers/detect.ts:33-38` — returns `"bun" | "pnpm" | "yarn" | "npm"`

- **Key files:**
  - `src/hooks/file-checker.ts` (76 lines) — Current quality check entry point for Claude Code hooks. Runs tsc/eslint/prettier via `Bun.spawnSync()`. No timeouts.
  - `src/checkers/typescript.ts` (76 lines) — Prettier, ESLint, tsc subprocess wrappers. Uses `Bun.spawnSync()`. Auto-fixes prettier/eslint. Full project tsc.
  - `src/sidecar/routes.ts` (398 lines) — Existing route handler. At 400-line limit — DO NOT add routes here.
  - `src/sidecar/server.ts` (267 lines) — Server startup, `SidecarContext`, Unix socket + HTTP.
  - `src/sidecar/client.ts` (294 lines) — `SidecarClient` HTTP client. Add new methods here.
  - `src/analysis/mcp-tools.ts` (320 lines) — `check_diagnostics` and `impact_analysis` MCP tools.
  - `targets/opencode/plugins/sentinal.ts` (589 lines) — OpenCode plugin. tsc at line 358. No eslint/prettier currently.

- **Gotchas:**
  - `routes.ts` is at 398 lines — any additions push it over the 400-line warning. New route handler files must be wired into the server's fetch handler.
  - The sidecar fetch handler is a single function in `server.ts:130-135` that calls `handleSidecarRequest()`. Adding a second route handler file requires modifying the dispatch logic.
  - The OpenCode plugin runs in Node.js (not Bun). It can only reach the sidecar via HTTP. Any new sidecar methods must also have HTTP endpoints.
  - `Bun.spawnSync()` has no timeout support. Always use `Bun.spawn()` (async) with `Promise.race` for new subprocess work.
  - tsc outputs errors to **stdout** (not stderr). eslint and prettier output to **stderr**.
  - `--incremental` requires `--tsBuildInfoFile` path when used with `--noEmit`. The tsbuildinfo file must persist across sidecar restarts.
  - The `SidecarContext` does not store project paths. Quality check requests must include the project path.

- **Domain context:**
  - Quality checks run on every file edit (Write/Edit/MultiEdit/patch). This is the hottest code path in Sentinal.
  - The current per-edit latency is dominated by tsc (3-30s). Incremental tsc with tsbuildinfo should reduce subsequent runs to ~500ms-2s.
  - The MCP `check_diagnostics` tool already runs tsc and parses output — the new `quality_report` tool should complement it (not replace it) by including eslint/prettier and supporting single-file mode.

## Assumptions

- `tsc --noEmit --incremental --tsBuildInfoFile <path>` works on TypeScript 5.0+ (Sentinal targets modern TS) — supported by TypeScript 5.0 release notes — Tasks 1, 2, 3 depend on this
- The project's `node_modules/.bin/tsc` is available for subprocess execution — supported by: current code uses `npx tsc` which resolves through node_modules — Tasks 1, 2 depend on this
- A single tsbuildinfo file per project is sufficient (no monorepo project references) — supported by: current `tsc --noEmit` already runs at project root level — Task 1 depends on this
- The sidecar process has permission to write to `~/.sentinal/tsbuildinfo/` — supported by: sidecar already writes to `~/.sentinal/` for port files, pid files, and memory DB — Task 1 depends on this

## Testing Strategy

- **Unit tests:** `src/sidecar/quality-routes.test.ts` — test the quality check handler with mocked subprocesses
- **Integration tests:** Test via `SidecarClient.qualityCheck()` against a running test sidecar
- **MCP tool tests:** `src/analysis/mcp-tools.test.ts` — extend with `quality_report` tests
- **Existing tests:** Full suite must pass after hook/plugin changes

## Risks and Mitigations

| Risk                                                                      | Likelihood | Impact | Mitigation                                                                                             |
| ------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------ |
| tsc `--incremental` with `--noEmit` not available in project's TS version | Low        | High   | Check TS version at runtime; fall back to non-incremental                                              |
| tsbuildinfo stale after branch switch or major refactor                   | Medium     | Low    | Clear tsbuildinfo on known triggers (git branch change, package.json change). Fallback: full re-check. |
| eslint/prettier config resolution fails in sidecar context                | Low        | Medium | Run with explicit `--config` path if default resolution fails                                          |
| Sidecar quality check times out for very large projects                   | Medium     | Medium | Configurable timeout (default 30s), partial results on timeout                                         |
| Hook/plugin change breaks existing quality checks                         | Low        | High   | Keep old subprocess path as fallback; gradually migrate                                                |

## Pre-Mortem

_Assume this plan failed. Most likely internal reasons:_

1. **tsbuildinfo doesn't actually speed up subsequent runs** (Task 1) — Trigger: second run of tsc with tsbuildinfo takes >3s (same as without). This could happen if the tsbuildinfo file is invalidated between runs, or if `--noEmit` mode doesn't produce a usable tsbuildinfo. Check during Task 1 implementation by measuring before/after latency.

2. **Sidecar subprocess pool causes resource exhaustion** (Task 2) — Trigger: concurrent quality check requests from multiple hook invocations spawn too many subprocesses, leading to OOM or file descriptor exhaustion. Mitigation: add a concurrency limiter (semaphore) in the quality handler.

3. **Hook migration breaks the feedback loop** (Task 5) — Trigger: the file-checker hook returns quality results in a different format than before, causing the AI to misinterpret them. Check by comparing old and new output for the same file edit.

## Goal Verification

### Truths

1. Quality checks run through the sidecar endpoint, not as direct subprocesses from hooks
2. tsc uses `--incremental` with a persisted tsbuildinfo file for faster subsequent runs
3. eslint and prettier run as async subprocesses with configurable timeouts
4. The `quality_report` MCP tool returns structured results for single files and project-wide checks
5. The Claude Code file-checker hook delegates to the sidecar when available
6. The OpenCode plugin delegates quality checks to the sidecar
7. All subprocesses have timeout protection

### Artifacts

- `src/sidecar/quality-routes.ts` (new) — Quality check route handler
- `src/sidecar/quality-routes.test.ts` (new) — Tests
- `src/sidecar/client.ts` (modified) — New `qualityCheck()` method
- `src/hooks/file-checker.ts` (modified) — Delegate to sidecar
- `targets/opencode/plugins/sentinal.ts` (modified) — Delegate to sidecar
- `src/analysis/mcp-tools.ts` (modified) — New `quality_report` tool

### Key Links

- `POST /quality-check` sidecar endpoint ← called by SidecarClient.qualityCheck()
- `SidecarClient.qualityCheck()` ← called by file-checker hook and OpenCode plugin
- `quality_report` MCP tool ← called by LLM for batch checking
- tsbuildinfo cache at `~/.sentinal/tsbuildinfo/<project-hash>.tsbuildinfo` ← persists across sidecar restarts

## Progress Tracking

- [x] Task 1: Create quality check sidecar endpoint
- [x] Task 2: Add concurrency control and timeout management
- [x] Task 3: Create `quality_report` MCP tool
- [x] Task 4: Add `qualityCheck()` to SidecarClient
- [x] Task 5: Update file-checker hook to use sidecar
- [x] Task 6: Update OpenCode plugin to use sidecar

**Total Tasks:** 6 | **Completed:** 6 | **Remaining:** 0

## Implementation Tasks

### Task 1: Create quality check sidecar endpoint

**Objective:** Add a `POST /quality-check` endpoint to the sidecar that runs tsc (incremental), eslint, and prettier as async subprocesses and returns structured results.

**Dependencies:** None

**Files:**

- Create: `src/sidecar/quality-routes.ts`
- Create: `src/sidecar/quality-routes.test.ts`
- Modify: `src/sidecar/server.ts` (wire new route handler into fetch dispatch)

**Key Decisions / Notes:**

- **New file `quality-routes.ts`** — routes.ts is at 398 lines, can't add more. Create a separate route handler file.
- **Dispatch wiring in `server.ts`:** Modify `fetchHandler` at `server.ts:197-199` to check `url.pathname.startsWith("/quality")` and route to `handleQualityRequest(req, ctx)`, else fall through to `handleSidecarRequest(req, ctx)`. This is a 3-line change.
- **tsc single-file clarification:** tsc always runs project-wide (type-checking requires the full project graph). The `filePath` parameter only scopes eslint/prettier. tsc runs the same regardless.
- **tsbuildinfo invalidation:** On each quality check, stat `package.json` and `tsconfig.json` mtime. Cache their mtimes alongside the tsbuildinfo. If either changed since last run, delete the tsbuildinfo to force a full rebuild.
- **Request shape:**
  ```json
  {
    "projectPath": "/abs/path/to/project",
    "filePath": "/abs/path/to/file.ts", // optional, for single-file mode
    "checks": ["tsc", "eslint", "prettier"], // optional, default all
    "timeout": 30000 // optional, default 30s per check
  }
  ```
- **Response shape:**
  ```json
  {
    "tsc": {
      "ok": true,
      "errors": [],
      "incremental": true,
      "durationMs": 1200
    },
    "eslint": {
      "ok": true,
      "errors": [],
      "autoFixed": false,
      "durationMs": 150
    },
    "prettier": {
      "ok": true,
      "errors": [],
      "autoFixed": true,
      "durationMs": 80
    }
  }
  ```
- **tsc incremental:** Run `tsc --noEmit --incremental --tsBuildInfoFile ~/.sentinal/tsbuildinfo/<hash>.tsbuildinfo`. Hash the project path (same approach as `check_diagnostics` uses for its baseline cache — see `src/analysis/helpers.ts:47-49`). Create `~/.sentinal/tsbuildinfo/` directory on first run.
- **Package manager detection:** Use `detectPackageManager(projectPath)` from `src/checkers/detect.ts`. Map to runner: bun → `bunx`, else `npx`.
- **Subprocess execution:** Use `Bun.spawn()` (async) with `Promise.race` timeout pattern from `src/analysis/mcp-tools.ts:68-90`.
- **Error parsing for tsc:** Use `parseTscOutput()` from `src/analysis/helpers.ts:55-68`.
- **eslint:** Run `<runner> eslint --fix <filePath>` or `<runner> eslint --fix .` for project-wide. Parse stderr.
- **prettier:** Run `<runner> prettier --check <filePath>` first. If issues found, run `<runner> prettier --write <filePath>`. Parse stderr.

**Definition of Done:**

- [ ] `POST /quality-check` endpoint returns structured results
- [ ] tsc uses `--incremental` with persisted tsbuildinfo file
- [ ] Second tsc run is measurably faster than first (target: <3s for typical project)
- [ ] eslint and prettier run with auto-fix
- [ ] All checks have timeout protection
- [ ] Tests cover: tsc success, tsc errors, eslint fix, prettier fix, timeout, missing tools

**Verify:**

- `bun test src/sidecar/quality-routes.test.ts`

---

### Task 2: Add concurrency control and timeout management

**Objective:** Prevent multiple concurrent quality checks from exhausting resources. Add a semaphore that limits concurrent subprocess spawning.

**Dependencies:** Task 1

**Files:**

- Modify: `src/sidecar/quality-routes.ts`

**Key Decisions / Notes:**

- Use a simple counting semaphore (not a full async queue). Max 2 concurrent quality checks (one per project is typical; 2 allows some overlap).
- When the semaphore is full, return a `429 Too Many Requests` with a helpful message.
- Each individual check (tsc, eslint, prettier) has its own timeout (default 30s). The overall request has no additional timeout — it's bounded by the sum of individual timeouts.
- Track active quality checks in a module-level `Set<string>` keyed by `projectPath` to prevent duplicate checks for the same project.

**Definition of Done:**

- [ ] Concurrent quality check requests are limited to 2
- [ ] Duplicate requests for the same project are rejected
- [ ] 429 response includes retry guidance
- [ ] Tests verify concurrency limiting

**Verify:**

- `bun test src/sidecar/quality-routes.test.ts`

---

### Task 3: Create `quality_report` MCP tool

**Objective:** Register a `quality_report` MCP tool that provides the AI with batch quality checking via structured JSON.

**Dependencies:** Task 1

**Files:**

- Modify: `src/analysis/mcp-tools.ts`

**Key Decisions / Notes:**

- Register as part of `registerAnalysisTools()` alongside `check_diagnostics` and `impact_analysis`.
- **Parameters:**
  - `project` (required, string) — absolute path to project root
  - `file` (optional, string) — specific file to check. If omitted, project-wide.
  - `checks` (optional, array of "tsc"|"eslint"|"prettier") — which checks to run. Default: all.
  - `timeout_ms` (optional, number) — per-check timeout. Default: 30000.
- **Execution:** Call `SidecarClient.qualityCheck()` if sidecar available. Fallback: if sidecar unavailable, call the quality check handler function directly (same-process, no HTTP round-trip). Extract the async subprocess logic from `quality-routes.ts` into a shared `runQualityChecks()` function that both the route handler and MCP tool can call. Do NOT fall back to `Bun.spawnSync` — always use the async subprocess path with timeouts.
- **Return format:** Markdown text with structured sections:

  ```
  ## Quality Report
  **Project:** /path/to/project
  **File:** /path/to/file.ts (or "Project-wide")

  ### TypeScript (1.2s, incremental)
  - 0 errors

  ### ESLint (0.15s)
  - Auto-fixed 2 issues

  ### Prettier (0.08s, auto-fixed)
  - Formatted 1 file
  ```

**Definition of Done:**

- [ ] `quality_report` tool registered with Zod schema
- [ ] Supports both single-file and project-wide modes
- [ ] Returns structured markdown with timing info
- [ ] Falls back to direct execution when sidecar unavailable
- [ ] Tests cover: sidecar path, direct fallback, single file, project-wide

**Verify:**

- `bun test src/analysis/mcp-tools.test.ts`

---

### Task 4: Add `qualityCheck()` to SidecarClient

**Objective:** Add an HTTP client method to SidecarClient for calling the quality check endpoint.

**Dependencies:** Task 1

**Files:**

- Modify: `src/sidecar/client.ts`

**Key Decisions / Notes:**

- Add `async qualityCheck(opts)` method following the pattern of `addObservation()` at `client.ts:197-208`.
- **Parameters:** `{ projectPath: string, filePath?: string, checks?: string[], timeout?: number }`
- **Returns:** The structured response from `POST /quality-check`
- Type the response: `QualityCheckResult` with per-tool results.
- Export the `QualityCheckResult` type so the hook and plugin can use it.

**Definition of Done:**

- [ ] `SidecarClient.qualityCheck()` calls `POST /quality-check`
- [ ] Response is properly typed
- [ ] Method is exported and usable from hooks and plugin

**Verify:**

- `bun test src/sidecar/client.test.ts`

---

### Task 5: Update file-checker hook to use sidecar

**Objective:** Change the Claude Code file-checker hook to delegate tsc/eslint/prettier to the sidecar instead of spawning subprocesses directly.

**Dependencies:** Task 4

**Files:**

- Modify: `src/hooks/file-checker.ts`
- Modify: `src/hooks/file-checker.test.ts`

**Key Decisions / Notes:**

- **SidecarClient import and connection:** Import `SidecarClient` from `../sidecar/client.js`. Use `SidecarClient.connect()` (NOT `connectWithRetry`) with a short implicit timeout (~500ms) to avoid adding latency when sidecar is down. Wrap in try/catch and fall back to `runTypeScriptChecks()`.
- **Keep non-TS checks local:** File length, NestJS patterns, companion test file — these are all instant (<5ms) and don't need the sidecar. Only tsc/eslint/prettier move to sidecar.
- **Output format:** Must produce the same hint string format as before, so the AI sees consistent feedback. Map the structured sidecar response back to the existing message format.
- The hook currently uses `Bun.spawnSync()` (synchronous). The sidecar call is async. The hook already uses `async function processFileCheck()` — no change needed for async support.

**Definition of Done:**

- [ ] Hook delegates tsc/eslint/prettier to sidecar when available
- [ ] Falls back to direct subprocess when sidecar unavailable
- [ ] Output format is identical to previous behavior
- [ ] Tests verify both sidecar and fallback paths

**Verify:**

- `bun test src/hooks/file-checker.test.ts`

---

### Task 6: Update OpenCode plugin to use sidecar

**Objective:** Change the OpenCode plugin's quality checks to use the sidecar endpoint instead of inline subprocess execution.

**Dependencies:** Task 4

**Files:**

- Modify: `targets/opencode/plugins/sentinal.ts`

**Key Decisions / Notes:**

- The plugin already has a `sidecar: SidecarClient | null` variable. Use `sidecar.qualityCheck()` when available.
- **Currently only runs tsc** (line 358). With the sidecar, it can now also get eslint and prettier — call sidecar with `checks: ["tsc", "eslint", "prettier"]` to enable all three. This is intentional scope expansion: OpenCode previously skipped eslint/prettier due to subprocess overhead, which the sidecar eliminates.
- **Fallback:** If sidecar is null, fall back to the existing `$\`npx tsc --noEmit\`` subprocess (keep current behavior as fallback).
- **Output format:** Map sidecar response to the existing issues array format. The plugin formats issues at lines 367-374 for `client.app.log()` and the blocking check.
- **Line count:** Plugin is at 589 lines. This change should net ~0 lines (replacing inline tsc with sidecar call).

**Definition of Done:**

- [ ] Plugin delegates quality checks to sidecar when available
- [ ] Falls back to inline tsc subprocess when sidecar unavailable
- [ ] eslint and prettier now run for OpenCode (previously skipped)
- [ ] Plugin file stays under 600 lines
- [ ] `bun run embed-assets` succeeds

**Verify:**

- `bun test`
- `wc -l targets/opencode/plugins/sentinal.ts`
