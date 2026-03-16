# Sidecar Idle Shutdown Mid-Session Fix Plan

Created: 2026-03-12
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Bugfix

## Summary

**Symptom:** During a long spec-implement session, MCP tool calls (e.g., `spec_register`) fail with a "Sidecar offline" error after the session has been running for several minutes without tool use.
**Trigger:** Any MCP session that goes >5 minutes between MCP tool calls (common during long AI thinking/editing phases).
**Root Cause:** `src/sidecar/server.ts:90-106` — `enableIdleShutdown()` fires after 5 minutes of no HTTP requests to the sidecar, calling `process.exit(0)`. The MCP server never sends keep-alive pings, so the sidecar shuts itself down mid-session.

## Investigation

- `enableIdleShutdown()` in `src/sidecar/server.ts:80-107` starts a 30-second interval. When `Date.now() - lastActivityTime >= 5 * 60 * 1000`, it calls `stopSidecar()` + `process.exit(0)`.
- `touchActivity()` is called on every incoming HTTP request (`src/sidecar/server.ts:178-181`). No requests → timer ticks to completion.
- The `/ping` keep-alive endpoint was added in `src/sidecar/routes.ts:54` but nothing calls it.
- `SidecarClient` in `src/sidecar/client.ts` has no `ping()` method and no keep-alive logic.
- The MCP `main()` in `src/mcp/server.ts:89-111` calls `SidecarClient.connect()` once and then never touches the sidecar again until a tool call arrives.
- `autoStartSidecar()` (line 95) is fire-and-forget. If the sidecar hasn't started yet, `connect()` returns `null`. `connectWithRetry()` already exists (`src/sidecar/client.ts:38-50`) for this case but is not used in `main()`.
- During spec-implement, the AI may go many minutes editing files and thinking without invoking any MCP tool → no HTTP activity → sidecar idle-shuts down.

## Behavior Contract

### Fix Property (C => P)

**When condition C holds:** MCP server has an active sidecar `client` and the session has been running longer than 5 minutes without tool calls.
**Property P must hold:** The sidecar remains running. `spec_register` and other MCP tools continue to succeed.

### Preservation Property (!C => unchanged)

**When condition C does NOT hold:** No sidecar client (direct mode), or sidecar idle-shuts down after MCP server has also exited.
**Existing behavior preserved:** Sidecar still exits after 5 minutes of genuine idle (no MCP server connected), cleanup handlers still fire on MCP exit.

## Fix Approach

**Files:** `src/sidecar/client.ts`, `src/mcp/server.ts`
**Strategy:**

1. Add a `ping()` method to `SidecarClient` that calls `GET /ping`. (Preferred over reusing `health()` — `/ping` returns minimal JSON, avoiding the health endpoint's serialization overhead.)
2. Add a `startKeepalive(client, intervalMs)` function to `src/mcp/server.ts` that calls `client.ping()` every 2 minutes. Returns a cleanup function.
3. Switch `main()` from `SidecarClient.connect()` to `SidecarClient.connectWithRetry()` so that fire-and-forget `autoStartSidecar()` races are handled gracefully.
4. In `main()`, after getting a live client, call `startKeepalive(client)`. Store the returned cleanup and call it in the exit handlers and on MCP server disconnect.
   **Tests:** `src/mcp/server.test.ts` — test `startKeepalive` calls ping at interval, and that its returned cleanup function clears the timer.
   **Defense-in-depth:** None needed — the ping loop is the targeted fix.

## Progress

- [x] Task 1: Fix
- [x] Task 2: Verify
      **Tasks:** 2 | **Done:** 2 | **Left:** 0

## Tasks

### Task 1: Fix

**Objective:** Write regression test → implement keep-alive ping loop
**Files:**

- Modify: `src/sidecar/client.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/mcp/server.test.ts`
  **TDD:** Write test for `startKeepalive` → verify FAILS → implement → verify all PASS
  **Verify:** `bun test src/mcp/server.test.ts`

### Task 2: Verify

**Objective:** Full suite + quality checks
**Verify:** `bun test && npx tsc --noEmit`
