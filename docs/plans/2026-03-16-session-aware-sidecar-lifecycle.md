# Session-Aware Sidecar Lifecycle Implementation Plan

Created: 2026-03-16
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Summary

**Goal:** Replace the 5-minute idle timeout with session-aware shutdown so the sidecar stays alive while any assistant session is active (preserving warm LSP server, project context cache, tsBuildInfo), and shuts down ~60 seconds after the last session ends. Remove the MCP keepalive ping which is no longer needed.

**Architecture:** Replace `enableIdleShutdown()` with `enableSessionAwareShutdown()` that checks `store.getActiveSessions()` every 30 seconds. When active sessions exist, the sidecar stays alive indefinitely. When no sessions are active for 60 consecutive seconds, the sidecar shuts down. Hybrid fallback: if no sessions have ever been created (manual start, debugging), fall back to a 30-minute idle timeout based on HTTP request activity.

**Tech Stack:** Bun, SQLite (MemoryStore), existing sidecar infrastructure

## Scope

### In Scope
- Replace `enableIdleShutdown()` with `enableSessionAwareShutdown()` in `server.ts`
- Hybrid mode: session-aware when sessions exist, 30-min idle fallback otherwise
- Update CLI `sidecar start` and `sidecar restart` to use new shutdown function
- Remove `startKeepalive()` from MCP server (no longer needed)
- Update CLI console messages to reflect new behavior
- Update existing tests for the new shutdown logic

### Out of Scope
- Changing how sessions are created or ended (existing hooks/plugin handle this)
- Changing the OpenCode `session.deleted` auto-stop logic (it already checks active sessions and explicitly stops the sidecar — this is a complementary safety net)
- Changing the MCP `registerMcpCleanupHandlers` (it already checks active sessions)
- Making the shutdown timing configurable via CLI flags (can be added later)

## Context for Implementer

> Write for an implementer who has never seen the codebase.

- **Patterns to follow:**
  - Current idle shutdown: `src/sidecar/server.ts:88-115` — `enableIdleShutdown()` uses `setInterval` to check `lastActivityTime`
  - Session queries: `src/memory/store.ts:271-273` — `getActiveSessions()` returns sessions where `end_time IS NULL`
  - MCP keepalive: `src/mcp/server.ts:69-87` — `startKeepalive()` pings sidecar every 2 min

- **Key files:**
  - `src/sidecar/server.ts` (280 lines) — `enableIdleShutdown()`, `touchActivity()`, `SidecarStartResult`
  - `src/sidecar/server.test.ts` — tests for `enableIdleShutdown`
  - `src/mcp/server.ts` (164 lines) — `startKeepalive()`, `main()`, `registerMcpCleanupHandlers()`
  - `src/mcp/server.test.ts` — tests for `startKeepalive`
  - `src/cli/commands/sidecar.ts` (208 lines) — `sidecar start` and `sidecar restart` subcommands call `enableIdleShutdown()`

- **Gotchas:**
  - `enableIdleShutdown` is exported and tested in `server.test.ts` — rename/replace must update tests
  - The `touchActivity()` function is still needed for the hybrid idle fallback (manual start path)
  - `SidecarStartResult` includes `ctx` which has `store` — the new function needs `result.ctx.store` to query sessions
  - The MCP keepalive removal must also remove the `stopKeepalive` cleanup handlers in `mcp/server.ts:139-141`
  - `sidecar.ts` has two call sites for `enableIdleShutdown`: line 84 (start) and line 166 (restart)
  - The interval must be `.unref()`'d to not keep the process alive when it's the only timer

- **Domain context:**
  - The sidecar now holds expensive warm state: LSP server process (~100-300MB), project context cache, tsBuildInfo, vector store embeddings
  - The MCP keepalive existed solely to prevent the 5-min idle timeout from killing the sidecar during long sessions where no MCP tools are called. With session-aware shutdown, this is unnecessary.
  - Both OpenCode (via `session.deleted`) and Claude Code (via `registerMcpCleanupHandlers`) already explicitly stop the sidecar when they detect zero active sessions. The session-aware shutdown is a complementary safety net for cases where clients crash without signaling.

## Assumptions

- `store.getActiveSessions()` is fast enough to call every 30s (~1ms SQLite query) — supported by: it's a simple `WHERE end_time IS NULL` query on a small table — Task 1 depends on this
- Stale sessions (from crashes) are cleaned up on sidecar startup via `cleanupStaleSessionsOnStartup()` at `server.ts:156` — supported by: 24-hour threshold in `STALE_SESSION_THRESHOLD_MS` — Task 1 depends on this
- The `SidecarStartResult.ctx.store` is available and open for the lifetime of the sidecar — supported by: the store is created in `startSidecar()` and closed in `stopSidecar()` — Task 1 depends on this

## Testing Strategy

- **Unit tests:** Update `src/sidecar/server.test.ts` — test `enableSessionAwareShutdown()` with mock store
- **Unit tests:** Update `src/mcp/server.test.ts` — remove `startKeepalive` tests
- **Integration:** Full sidecar test suite must pass

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Stale sessions keep sidecar alive forever | Low | Medium | `cleanupStaleSessionsOnStartup()` handles 24h-old sessions. The 30-min idle fallback catches the rest. |
| No sessions created = sidecar stays 30 min | Low | Low | Acceptable for manual/debug use. User can always Ctrl+C. |
| `getActiveSessions()` slow on large DB | Very Low | Low | Sessions table is small (tens of rows). Index on `end_time IS NULL`. |

## Pre-Mortem

*Assume this plan failed. Most likely internal reasons:*

1. **Sidecar shuts down prematurely during a long Claude Code session** (Task 1) — Trigger: the session hook created a session but the MCP server didn't start fast enough, so the sidecar sees zero sessions and shuts down. Mitigation: the 60-second grace period before shutdown prevents race conditions. Additionally, `touchActivity()` still runs on every request, and the hybrid fallback prevents premature shutdown when no sessions exist.

2. **Removing keepalive breaks MCP server connectivity** (Task 3) — Trigger: without the keepalive, the sidecar's TCP connection drops due to OS-level TCP keepalive timeouts, and subsequent MCP calls fail. Mitigation: the sidecar uses Unix sockets (not TCP keepalive-dependent) for local communication. HTTP fallback connections are short-lived (one request per connection). The keepalive was for the idle timeout, not TCP health.

## Goal Verification

### Truths
1. Sidecar stays alive while any session is active (no 5-minute shutdown)
2. Sidecar shuts down ~60s after the last session ends
3. Manual start without sessions falls back to 30-minute idle timeout
4. MCP keepalive ping is removed from MCP server
5. All existing tests pass (with updated assertions)

### Artifacts
- `src/sidecar/server.ts` (modified) — `enableSessionAwareShutdown()` replaces `enableIdleShutdown()`
- `src/sidecar/server.test.ts` (modified) — updated tests
- `src/mcp/server.ts` (modified) — keepalive removed
- `src/mcp/server.test.ts` (modified) — keepalive tests removed
- `src/cli/commands/sidecar.ts` (modified) — updated call sites and messages

### Key Links
- `enableSessionAwareShutdown()` ← queries `store.getActiveSessions()` every 30s ← shuts down when zero for 60s
- `sidecar start/restart` ← calls `enableSessionAwareShutdown()` instead of `enableIdleShutdown()`
- MCP `main()` ← no longer calls `startKeepalive()` ← simpler cleanup handlers

## Progress Tracking

- [x] Task 1: Replace enableIdleShutdown with enableSessionAwareShutdown
- [x] Task 2: Update CLI sidecar command call sites and messages
- [x] Task 3: Remove keepalive ping from MCP server

**Total Tasks:** 4 | **Completed:** 4 | **Remaining:** 0

## Implementation Tasks

### Task 1: Replace enableIdleShutdown with enableSessionAwareShutdown

**Objective:** Create `enableSessionAwareShutdown()` that keeps the sidecar alive while sessions are active and shuts down 60s after the last session ends. Hybrid fallback to 30-min idle when no sessions have ever existed.

**Dependencies:** None

**Files:**
- Modify: `src/sidecar/server.ts`

**Key Decisions / Notes:**
- **Replace `enableIdleShutdown()`** with `enableSessionAwareShutdown()`. Keep the same function signature pattern (`result: SidecarStartResult, opts?`) and return a cleanup function.
- **Algorithm:**
  ```
  every 30s:
    activeSessions = store.getActiveSessions()
    if activeSessions.length > 0:
      // Check for staleness: if all "active" sessions have no recent HTTP activity
      // for 1 hour, treat them as effectively dead (crashed client)
      if Date.now() - lastActivityTime >= STALE_ACTIVITY_THRESHOLD:
        // All sessions are likely stale — allow shutdown
        (fall through to noSessionSince logic below)
      else:
        sessionsEverSeen = true
        noSessionSince = null   // reset the grace timer
        continue
    if sessionsEverSeen:
      if noSessionSince == null:
        noSessionSince = Date.now()   // start grace timer
      elif Date.now() - noSessionSince >= SESSION_GRACE_PERIOD_MS:
        shutdown()   // no sessions for 60s
    else:
      // No sessions ever seen — hybrid idle fallback
      if Date.now() - lastActivityTime >= FALLBACK_IDLE_TIMEOUT_MS:
        shutdown()
  ```
- **Options type:** `SessionAwareShutdownOptions` with configurable `gracePeriodMs` (default 60s), `fallbackIdleMs` (default 30 min), `staleActivityMs` (default 1h), `checkIntervalMs` (default 30s), and `onShutdown` callback (for testing). Mirrors the existing `IdleShutdownOptions` pattern.
- **Stale activity check:** If sessions exist but `lastActivityTime` is >1 hour old (no HTTP requests from any client), those sessions are from a crashed client. Allow shutdown to proceed. This prevents a stale <24h session from keeping the sidecar alive indefinitely.
- **Keep `touchActivity()`** — still called on every request for both the hybrid idle fallback and the stale activity check.
- **Keep `DEFAULT_CHECK_INTERVAL_MS`** (30s) — reused.
- **New constants:** `SESSION_GRACE_PERIOD_MS = 60_000`, `FALLBACK_IDLE_TIMEOUT_MS = 30 * 60 * 1000`, `STALE_ACTIVITY_THRESHOLD_MS = 60 * 60 * 1000`

**Definition of Done:**
- [ ] `enableSessionAwareShutdown()` keeps sidecar alive while sessions exist
- [ ] Shuts down after 60s with zero active sessions
- [ ] Falls back to 30-min idle when no sessions have ever been created
- [ ] Stale activity check: shuts down when sessions exist but no HTTP activity for 1h
- [ ] Returns a cleanup function that clears the interval
- [ ] Options type supports configurable timings and onShutdown callback for testing

**Verify:**
- `bun test src/sidecar/server.test.ts`

---

### Task 2: Update CLI sidecar command call sites and messages

**Objective:** Switch `sidecar start` and `sidecar restart` from `enableIdleShutdown()` to `enableSessionAwareShutdown()`. Update console messages.

**Dependencies:** Task 1

**Files:**
- Modify: `src/cli/commands/sidecar.ts`

**Key Decisions / Notes:**
- **Two call sites:** Line 84 (`sidecar start`) and line 166 (`sidecar restart`).
- **Update import:** `enableIdleShutdown` → `enableSessionAwareShutdown`
- **Update messages:**
  - Line 81: `"Press Ctrl+C to stop (auto-shutdown after 5 min idle)"` → `"Press Ctrl+C to stop (auto-shutdown when no sessions active)"`
- **No functional change to the SIGTERM/SIGINT handlers** — they still call `stopSidecar()` directly.

**Definition of Done:**
- [ ] Both call sites use `enableSessionAwareShutdown()`
- [ ] Console messages reflect session-aware behavior
- [ ] `sidecar start` and `sidecar restart` work correctly

**Verify:**
- `bun run build:cli`

---

### Task 3: Remove keepalive ping from MCP server

**Objective:** Remove `startKeepalive()` and its usage from the MCP server since the sidecar no longer shuts down on idle while sessions are active.

**Dependencies:** Task 1

**Files:**
- Modify: `src/mcp/server.ts`

**Key Decisions / Notes:**
- **Remove `startKeepalive()` function** (lines 69-87)
- **Remove `DEFAULT_KEEPALIVE_INTERVAL_MS` constant** (line 61)
- **Remove from `main()`:**
  - Line 135: `const stopKeepalive = startKeepalive(client);` — delete
  - Line 139: `process.on("SIGTERM", stopKeepalive);` — delete
  - Line 140: `process.on("SIGINT", stopKeepalive);` — delete
  - Line 141: `process.on("exit", () => { stopKeepalive(); cleanup(); });` → `process.on("exit", cleanup);`
- **Keep `registerMcpCleanupHandlers()`** — still needed for session-aware sidecar stop on MCP exit.
- **Line count reduction:** ~30 lines removed, bringing `mcp/server.ts` from 164 to ~134.

**Definition of Done:**
- [ ] `startKeepalive()` function removed
- [ ] No keepalive references in `main()`
- [ ] Cleanup handlers simplified (no stopKeepalive in exit handler)
- [ ] MCP server still starts and connects correctly

**Verify:**
- `bun test src/mcp/server.test.ts`

---

### Task 4: Update tests

**Objective:** Update tests in `server.test.ts` and `mcp/server.test.ts` to reflect the new shutdown behavior and removed keepalive.

**Dependencies:** Tasks 1, 2, 3

**Files:**
- Modify: `src/sidecar/server.test.ts`
- Modify: `src/mcp/server.test.ts`

**Key Decisions / Notes:**
- **`server.test.ts`:** Replace `enableIdleShutdown` tests with `enableSessionAwareShutdown` tests:
  - Test: shuts down when no sessions active for grace period
  - Test: stays alive when sessions are active
  - Test: transition flow — sessions exist, all end, grace period elapses, shutdown fires
  - Test: hybrid fallback to idle timeout when no sessions ever created
  - Test: stale activity check — sessions exist but no HTTP activity for threshold
  - Test: returns a cleanup function
  - Use a mock store that returns configurable active sessions via `onShutdown` callback
- **`mcp/server.test.ts`:** Remove the `startKeepalive` describe block (lines 549-600):
  - "should ping the sidecar at regular intervals"
  - "should handle ping errors silently"
  - "should return no-op when client is null"
  - "should be stoppable via the returned function"
- **Keep `registerMcpCleanupHandlers` tests** — they still apply.

**Definition of Done:**
- [ ] `enableSessionAwareShutdown` tests cover session-aware and hybrid paths
- [ ] `startKeepalive` tests removed
- [ ] All tests pass
- [ ] No TypeScript errors

**Verify:**
- `bun test src/sidecar/server.test.ts src/mcp/server.test.ts`
