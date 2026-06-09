# MCP Tool Usage Counters & Power Management Implementation Plan

Created: 2026-03-13
Status: PENDING
Approved: No
Iterations: 0
Worktree: No
Type: Feature

## Summary

**Goal:** Track per-tool per-session MCP tool invocation counts with overall totals (surfaced on the dashboard), and inhibit OS power saving while AI sessions are actively running tool calls.
**Architecture:** New `tool_usage` SQLite table stores counts. A wrapper around `McpServer.tool()` transparently counts every invocation. A `PowerInhibitor` class manages `caffeinate` (macOS) / `systemd-inhibit` (Linux) with a 5-minute idle timeout. Dashboard gets new stat cards + a tool usage breakdown view.
**Tech Stack:** Bun SQLite, `Bun.spawn`/`child_process.spawn` for power commands, server-rendered HTML (htmx) for dashboard.

## Scope

### In Scope

- `tool_usage` table with migration (V8)
- `MemoryStore` CRUD methods for tool usage (increment, query by session, query totals)
- Wrapper around `McpServer.tool()` in `createSentinalServer()` that auto-increments counters
- Sidecar routes for tool usage delegation
- `SidecarClient` methods for tool usage
- Dashboard: stat cards for total tool calls, top tools breakdown
- Dashboard API endpoint: `/api/tool-usage`
- `PowerInhibitor` class (macOS `caffeinate` + Linux `systemd-inhibit`)
- Power inhibitor wired into MCP server's tool wrapper (start/reset on call, release after 5-min idle)
- OpenCode plugin: tool counting via existing `tool.execute.after` hook, power inhibitor via same hook
- Build, sign, update

### Out of Scope

- Full time-series analytics (per-day trend lines, charts)
- Windows power management support
- Per-tool-call latency tracking
- User-configurable idle timeout

## Context for Implementer

> Write for an implementer who has never seen the codebase.

- **Patterns to follow:**
  - DB migration: `src/memory/migrations.ts:193-210` (V7 example — `CREATE TABLE`, `INSERT schema_version`)
  - Store CRUD: `src/memory/store.ts:225-265` (session insert/end pattern with prepared statements)
  - Sidecar routes: `src/sidecar/routes.ts:39-134` (flat `if`-chain router, `ok()`/`fail()` response helpers)
  - SidecarClient methods: `src/sidecar/client.ts:210-224` (simple `post()`/`get()` wrappers)
  - MCP tool registration: `src/mcp/server.ts:47-51` (`registerXxxTools(server, deps)`)
  - Dashboard views: `src/dashboard/views/dashboard.ts:56-63` (`statCard()` helper)
  - Dashboard API: `src/dashboard/routes/api.ts:28-35` (`dashboardHandler` returns aggregated data)
  - Process spawning: `src/sidecar/lifecycle.ts:161-175` (`Bun.spawn` + `.unref()`)
  - Platform detection: `src/cli/commands/update.ts:55-65` (`process.platform`)

- **Conventions:**
  - All DB operations go through `MemoryStore` (never raw SQL in tools/routes)
  - Sidecar routes are flat `if` checks in `handleSidecarRequest()`
  - All sidecar responses use `ok(data)` / `fail(error, status)` helpers
  - Tools support dual mode: `if (client) { await client.xxx() } else { store!.xxx() }`
  - Types live in `src/memory/types.ts`
  - Tests use `bun:test` with `tmpdir()` + `MemoryStore(tmpDb)` pattern

- **Key files:**
  - `src/mcp/server.ts` — MCP server factory, `createSentinalServer()`, keepalive, cleanup
  - `src/memory/store.ts` — SQLite operations (663 lines, careful not to bloat)
  - `src/memory/migrations.ts` — Schema migrations V1-V7 (290 lines)
  - `src/memory/types.ts` — All type definitions including `MemoryStats`
  - `src/sidecar/routes.ts` — All sidecar HTTP routes (398 lines, near limit)
  - `src/sidecar/client.ts` — Client for sidecar communication (261 lines)
  - `src/dashboard/views/dashboard.ts` — Dashboard homepage (139 lines)
  - `src/dashboard/routes/api.ts` — Dashboard JSON API (163 lines)
  - `targets/opencode/plugins/sentinal.ts` — OpenCode plugin (542 lines, OVER limit)

- **Gotchas:**
  - `sidecar/routes.ts` is 398 lines — tool-usage routes MUST be extracted to `src/sidecar/tool-usage-routes.ts` to stay under 400.
  - `targets/opencode/plugins/sentinal.ts` is already 542 lines — any additions need to be extracted, not inlined.
  - `memory/store.ts` is 663 lines — tool usage methods MUST go in a new `src/memory/tool-usage-store.ts` with thin delegation from `MemoryStore`.
  - The MCP SDK's `McpServer.tool()` has multiple overload signatures (2, 3, or 4 args). The wrapper MUST handle all variants by detecting the handler as the last function-typed argument.
  - Power inhibitor processes (`caffeinate`, `systemd-inhibit`) must be properly cleaned up on process exit to avoid orphaned processes. Write PID to `~/.sentinal/inhibitor.pid` and check/kill on startup for crash recovery.
  - `systemd-inhibit` on Linux requires a blocking mode (it wraps a command) — use `systemd-inhibit --what=idle:sleep sleep infinity` and kill the process to release.
  - The OpenCode plugin runs in Node.js (not Bun) — `PowerInhibitor` MUST use `child_process.spawn` (not `Bun.spawn`). Use runtime detection: `typeof Bun !== "undefined" ? Bun.spawn : require("child_process").spawn`.

- **Domain context:**
  - The sidecar is a long-lived background process holding a warm SQLite DB. MCP tools delegate to it via HTTP.
  - The dashboard is a separate HTTP server (Bun.serve) that reads the same SQLite DB.
  - Sessions are created by hooks (Claude Code) or the OpenCode plugin. A session maps to one AI conversation.

## Assumptions

- `caffeinate` is available on all macOS systems (ships with macOS) — Tasks 4, 5 depend on this
- `systemd-inhibit` is available on Linux systems with systemd (most modern distros) — Task 4 depends on this
- `McpServer.tool()` can be wrapped by replacing the handler argument before calling the original method — Tasks 2, 3 depend on this
- The dashboard auto-refreshes every 5s via htmx, so tool usage will appear without manual refresh — Task 6 depends on this
- The OpenCode plugin runs in Node.js, so `PowerInhibitor` must use `child_process.spawn` for compatibility — Task 4, 5 depend on this

## Testing Strategy

- **Unit:** `MemoryStore` tool usage CRUD, `PowerInhibitor` lifecycle (mock spawn), tool wrapper counting logic
- **Integration:** Full MCP server with wrapped tools → verify counters increment in store
- **Manual:** Dashboard visual check (stat cards appear, data refreshes)

## Risks and Mitigations

| Risk                                            | Likelihood | Impact | Mitigation                                                          |
| ----------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------- |
| `systemd-inhibit` not available on some Linux   | Low        | Low    | Graceful fallback: log warning, skip inhibitor                      |
| Tool wrapper adds latency to every tool call    | Low        | Medium | Counting is a single INSERT OR UPDATE — sub-ms                      |
| `sidecar/routes.ts` exceeds 400 lines           | High       | Medium | Extract to `src/sidecar/tool-usage-routes.ts`                       |
| OpenCode plugin already 542 lines               | High       | Medium | Minimal additions (2 lines), PowerInhibitor lives in own module     |
| Orphaned caffeinate/systemd-inhibit after crash | Medium     | High   | PID file at `~/.sentinal/inhibitor.pid`, cleaned up on construction |

## Pre-Mortem

_Assume this plan failed. Most likely internal reasons:_

1. **Tool wrapper breaks SDK internals** (Task 2) — Trigger: `McpServer.tool()` has hidden side effects or the SDK validates handlers in unexpected ways. Observable: type errors or runtime exceptions when registering tools.
2. **Power inhibitor orphans processes** (Task 4) — Trigger: MCP server crashes without cleanup. Observable: `ps aux | grep caffeinate` shows orphaned processes after session ends.
3. **Counter writes contend with sidecar SQLite** (Task 3) — Trigger: High-frequency tool calls cause WAL contention. Observable: "database is locked" errors in tool responses.

## Goal Verification

### Truths

1. After running a session with 10+ tool calls, `tool_usage` table contains rows with correct per-tool counts for that session
2. Dashboard homepage shows total tool invocations and a breakdown of top tools
3. `/api/tool-usage` returns JSON with per-session and overall aggregations
4. During active tool execution, `caffeinate` (macOS) or `systemd-inhibit` (Linux) process is running
5. After 5 minutes of no tool calls, the power inhibitor process is terminated
6. On session end / MCP server exit, power inhibitor is cleaned up

### Artifacts

- `src/memory/migrations.ts` — V8 migration with `tool_usage` table
- `src/memory/tool-usage-store.ts` — `ToolUsageStore` class with `increment()`, `getBySession()`, `getTotals()`
- `src/memory/store.ts` — thin `toolUsage` property delegation
- `src/mcp/server.ts` — `wrapServerWithCounting()` wrapper + PowerInhibitor integration
- `src/power/inhibitor.ts` — `PowerInhibitor` class (cross-platform, PID file protection)
- `src/sidecar/tool-usage-routes.ts` — extracted tool-usage route handlers
- `src/sidecar/routes.ts` — 3-line dispatches to tool-usage-routes
- `src/sidecar/client.ts` — `incrementToolUsage()`, `getToolUsageBySession()`, `getToolUsageTotals()` methods
- `src/dashboard/views/dashboard.ts` — new stat cards for tool usage
- `src/dashboard/routes/api.ts` — `/api/tool-usage` endpoint

### Key Links

1. `McpServer.tool()` → `wrapToolWithCounting()` → `store.incrementToolUsage()` — every tool call hits the counter
2. `wrapToolWithCounting()` → `PowerInhibitor.touch()` — every tool call resets the idle timer
3. `store.incrementToolUsage()` ↔ `SidecarClient.incrementToolUsage()` ↔ sidecar route — dual-mode counting
4. `dashboardHandler()` → `store.getToolUsageTotals()` → dashboard view — stats appear on homepage
5. `PowerInhibitor` → `Bun.spawn("caffeinate")` / `spawn("systemd-inhibit")` → process lifecycle

## Progress Tracking

- [ ] Task 1: Schema migration + MemoryStore methods
- [ ] Task 2: MCP tool wrapper with counting
- [ ] Task 3: Sidecar routes + SidecarClient methods
- [ ] Task 4: PowerInhibitor class
- [ ] Task 5: Wire power inhibitor into MCP server + OpenCode plugin
- [ ] Task 6: Dashboard integration
- [ ] Task 7: Build, sign, update
      **Total Tasks:** 7 | **Completed:** 0 | **Remaining:** 7

## Implementation Tasks

### Task 1: Schema Migration + MemoryStore Methods

**Objective:** Create the `tool_usage` table and store-level CRUD for tracking tool invocations.
**Dependencies:** None

**Files:**

- Modify: `src/memory/migrations.ts`
- Create: `src/memory/tool-usage-store.ts`
- Modify: `src/memory/store.ts` (thin delegation only — 3 one-liner methods)
- Modify: `src/memory/types.ts`
- Test: `src/memory/tool-usage-store.test.ts`

**Key Decisions / Notes:**

- Add V8 migration creating `tool_usage` table:
  ```sql
  CREATE TABLE tool_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    call_count INTEGER NOT NULL DEFAULT 0,
    last_called_at INTEGER NOT NULL,
    UNIQUE(session_id, tool_name)
  );
  CREATE INDEX idx_tu_session ON tool_usage(session_id);
  CREATE INDEX idx_tu_tool ON tool_usage(tool_name);
  ```
- Create `src/memory/tool-usage-store.ts` with a `ToolUsageStore` class that takes the `db` instance from `MemoryStore`:
  - `increment(sessionId, toolName)` — uses `INSERT ... ON CONFLICT(session_id, tool_name) DO UPDATE SET call_count = call_count + 1, last_called_at = ?`
  - `getBySession(sessionId)` — returns `ToolUsage[]`
  - `getTotals()` — returns `ToolUsageTotals[]` aggregated across all sessions
- In `MemoryStore`: expose `toolUsage` as a lazy property returning `ToolUsageStore(this.db)`. Add 3 thin delegation methods for backward compatibility if needed.
- Add `ToolUsage` and `ToolUsageTotals` types to `types.ts`
- `store.ts` is 663 lines — this approach adds only ~5 lines (property + delegations), keeping it under control.

**Definition of Done:**

- [ ] V8 migration creates table and indexes
- [ ] `ToolUsageStore.increment` correctly inserts or updates
- [ ] `ToolUsageStore.getBySession` returns per-session breakdown
- [ ] `ToolUsageStore.getTotals` returns cross-session aggregation
- [ ] All tests pass

**Verify:**

- `bun test src/memory/tool-usage-store.test.ts`

### Task 2: MCP Tool Wrapper with Counting

**Objective:** Wrap `McpServer.tool()` so every tool invocation is automatically counted.
**Dependencies:** Task 1

**Files:**

- Modify: `src/mcp/server.ts`
- Test: `src/mcp/server.test.ts`

**Key Decisions / Notes:**

- Create `wrapServerWithCounting(server, deps)` that replaces `server.tool` with a proxy:
  ```typescript
  const originalTool = server.tool.bind(server);
  server.tool = (name, ...rest) => {
    // rest may be [description, schema, handler] or [description, handler]
    // Find the handler (last arg), wrap it
    const handler = rest[rest.length - 1];
    const wrappedHandler = async (...args) => {
      incrementCounter(name); // fire-and-forget
      return handler(...args);
    };
    rest[rest.length - 1] = wrappedHandler;
    return originalTool(name, ...rest);
  };
  ```
- Call `wrapServerWithCounting()` in `createSentinalServer()` BEFORE the `registerXxxTools()` calls
- The counter increment should be fire-and-forget (no await) to avoid adding latency
- Pass `sessionId` from the MCP tool call context. Note: the SDK provides session info via the handler's extra argument. If session ID is unavailable, use a fallback `"mcp-<pid>"`.
- In dual mode: if `client`, POST to sidecar; if direct, call `store.incrementToolUsage()`

**Definition of Done:**

- [ ] Every registered MCP tool call increments a counter
- [ ] Wrapper correctly handles all `McpServer.tool()` overload signatures (2-arg, 3-arg, 4-arg forms)
- [ ] Counter increments are fire-and-forget (no added latency)
- [ ] Counting works in both sidecar and direct mode
- [ ] Test cases cover each overload variant
- [ ] All tests pass

**Verify:**

- `bun test src/mcp/server.test.ts`

### Task 3: Sidecar Routes + SidecarClient Methods

**Objective:** Add sidecar HTTP routes so the MCP server can delegate counter writes/reads.
**Dependencies:** Task 1

**Files:**

- Create: `src/sidecar/tool-usage-routes.ts`
- Modify: `src/sidecar/routes.ts` (3 one-line dispatches to the new file)
- Modify: `src/sidecar/client.ts`
- Test: `src/sidecar/tool-usage-routes.test.ts`

**Key Decisions / Notes:**

- Create `src/sidecar/tool-usage-routes.ts` with exported handler functions:
  - `handleIncrementToolUsage(req, ctx)` — body `{ sessionId, toolName }` → `ctx.store.toolUsage.increment()`
  - `handleGetToolUsage(url, ctx)` — query `?session_id=X` → `ctx.store.toolUsage.getBySession()`
  - `handleGetToolUsageTotals(ctx)` — `ctx.store.toolUsage.getTotals()`
- In `routes.ts`: add 3 `if` lines dispatching to the new handlers. This adds only ~6 lines to routes.ts (imports + if-lines), keeping it under 400.
- Add `SidecarClient` methods: `incrementToolUsage()`, `getToolUsageBySession()`, `getToolUsageTotals()`

**Definition of Done:**

- [ ] Three sidecar routes responding correctly
- [ ] `SidecarClient` has matching methods
- [ ] All tests pass

**Verify:**

- `bun test src/sidecar/`

### Task 4: PowerInhibitor Class

**Objective:** Create a cross-platform power saving inhibitor using `caffeinate` (macOS) and `systemd-inhibit` (Linux).
**Dependencies:** None

**Files:**

- Create: `src/power/inhibitor.ts`
- Test: `src/power/inhibitor.test.ts`

**Key Decisions / Notes:**

- `PowerInhibitor` class with methods:
  - `touch()` — start inhibiting (if not already) and reset idle timer
  - `release()` — stop inhibiting immediately, clear timer
  - `isActive()` — check if currently inhibiting
- Use runtime-agnostic spawn: detect `typeof Bun !== "undefined"` → use `Bun.spawn`, else use `child_process.spawn`. This ensures the class works in both the MCP server (Bun) and the OpenCode plugin (Node.js).
- On macOS: spawn `["caffeinate", "-di"]` — inhibit display + system idle sleep. Kill the process to release.
- On Linux: spawn `["systemd-inhibit", "--what=idle:sleep", "--who=sentinal", "--why=AI session active", "sleep", "infinity"]` — kill to release.
- On unknown platform or command not found: log a warning, return a no-op inhibitor
- 5-minute idle timer: `setTimeout` that calls `release()`. `touch()` clears and resets it.
- The spawned process `.unref()` is NOT called — we want to keep a reference to kill it.
- On `release()`: `process.kill()` the child process, clear the timer.
- **Orphan process protection:** On construction, check `~/.sentinal/inhibitor.pid`. If it exists and the PID is alive, kill it. On spawn, write the child PID to this file. On release, delete the file.
- Export `DEFAULT_INHIBIT_IDLE_MS = 5 * 60 * 1000`

**Definition of Done:**

- [ ] macOS spawns `caffeinate -di`, kills on release
- [ ] Linux spawns `systemd-inhibit ... sleep infinity`, kills on release
- [ ] Unknown platform returns no-op (no crash)
- [ ] Idle timer releases after 5 minutes of no `touch()`
- [ ] `touch()` resets the idle timer
- [ ] Orphan PID is killed on construction if stale file exists
- [ ] PID file is written on spawn, deleted on release
- [ ] Works in both Bun and Node.js runtimes
- [ ] All tests pass (mock spawn)

**Verify:**

- `bun test src/power/inhibitor.test.ts`

### Task 5: Wire Power Inhibitor into MCP Server + OpenCode Plugin

**Objective:** Integrate the power inhibitor so it activates on tool calls and cleans up on exit.
**Dependencies:** Task 2, Task 4

**Files:**

- Modify: `src/mcp/server.ts`
- Modify: `targets/opencode/plugins/sentinal.ts`
- Test: `src/mcp/server.test.ts`

**Key Decisions / Notes:**

- In `createSentinalServer()`: accept an optional `PowerInhibitor` in the options. Pass it into the tool wrapper. Each tool call does `inhibitor.touch()`.
- Modify `registerMcpCleanupHandlers()` to accept an optional `PowerInhibitor` parameter. Call `inhibitor.release()` in the cleanup function BEFORE the sidecar check. This centralizes all exit cleanup in one place — no duplicate `process.on` handlers.
- In `main()`: create `PowerInhibitor`, pass to both `createSentinalServer()` and `registerMcpCleanupHandlers()`.
- In the OpenCode plugin: create a `PowerInhibitor` in the init function. The plugin is bundled with `bun build --target node`, which includes `src/power/inhibitor.ts` in the bundle. Since `PowerInhibitor` uses runtime-agnostic spawn (Task 4), it works in the Node.js runtime. In `tool.execute.before`, call `inhibitor.touch()`. On `session.deleted`, call `inhibitor.release()`.
- The OpenCode plugin is 542 lines — additions are minimal (2 lines: one `touch()` call, one `release()` call) plus the import.

**Definition of Done:**

- [ ] MCP server tool calls trigger `inhibitor.touch()`
- [ ] `registerMcpCleanupHandlers()` releases the inhibitor on exit
- [ ] OpenCode plugin tool hooks trigger `inhibitor.touch()`
- [ ] OpenCode plugin session end cleans up the inhibitor
- [ ] All tests pass

**Verify:**

- `bun test src/mcp/server.test.ts`

### Task 6: Dashboard Integration

**Objective:** Surface tool usage data on the dashboard homepage and add an API endpoint.
**Dependencies:** Task 1, Task 3

**Files:**

- Modify: `src/dashboard/routes/api.ts`
- Modify: `src/dashboard/views/dashboard.ts`
- Modify: `src/dashboard/server.ts` (add `/api/tool-usage` route)
- Test: `src/dashboard/routes/api.test.ts` (if exists)

**Key Decisions / Notes:**

- Add `/api/tool-usage` endpoint returning `{ totals: [{toolName, totalCalls}], bySesion: {...} }` — queries `store.getToolUsageTotals()`
- In `dashboardHandler()`: add `toolUsage: store.getToolUsageTotals()` to the response
- In `dashboardFragment()`: add a stat card for "Total Tool Calls" (sum of all) and a card showing top 5 tools by usage
- Top tools card: simple list with tool name + count, no chart needed
- Follow existing `statCard()` pattern at `dashboard.ts:56-63`

**Definition of Done:**

- [ ] `/api/tool-usage` returns correct JSON
- [ ] Dashboard homepage shows total tool calls stat card
- [ ] Dashboard homepage shows top 5 tools breakdown
- [ ] New stat cards are inside the htmx polling region (`#dashboard-content` div with `hx-get="/fragments/dashboard"`) so they auto-refresh
- [ ] All tests pass

**Verify:**

- `bun test src/dashboard/`

### Task 7: Build, Sign, Update

**Objective:** Rebuild the CLI binary with all changes and install it.
**Dependencies:** Tasks 1-6

**Files:**

- Modify: `src/cli/embedded-assets.ts` (auto-generated by build)

**Key Decisions / Notes:**

- `bun run build:cli` → rebuilds everything
- `codesign -f -s - ~/.sentinal/bin/sentinal` → re-sign the binary
- `sentinal install opencode && sentinal install claude` → reinstall plugins
- Verify: `sentinal mcp-server` starts without errors

**Definition of Done:**

- [ ] Build succeeds with zero errors
- [ ] Binary is signed
- [ ] Plugins reinstalled

**Verify:**

- `bun run build:cli`
