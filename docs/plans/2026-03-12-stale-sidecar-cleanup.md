# Stale Sidecar Processes on macOS Fix Plan

Created: 2026-03-12
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Bugfix

## Summary

**Symptom:** On macOS, sidecar processes are not cleaned up when OpenCode, Claude Code, and MCP servers are closed, leading to multiple stale sidecars accumulating.

## Root Cause

Three failure modes contribute to stale sidecar processes:

### RC1: MCP server has no cleanup handler (PRIMARY)

`src/mcp/server.ts:main()` calls `autoStartSidecar()` at line 62 but never registers `SIGTERM`/`SIGINT` handlers and has no cleanup when the stdio transport disconnects. When the host (Claude Code or OpenCode) exits, it kills the MCP server process, but nothing stops the sidecar. This is the most common entrypoint — every Claude Code and OpenCode session spawns an MCP server.

### RC2: Session tracking gets out of sync (SECONDARY)

Both `session-end` hook and OpenCode's `session.deleted` event rely on `activeSessions.length === 0` to stop the sidecar. If a session starts but its end event never fires (host crash, force-quit, or the MCP path which has no session tracking), the session stays "active" in the DB forever, preventing cleanup.

### RC3: PID-based liveness check is unreliable (MINOR)

`isSidecarRunning()` uses `kill(pid, 0)` which can false-positive on recycled PIDs after a crash. This is rare on macOS (large PID space) but theoretically causes auto-start to incorrectly skip.

## Fix Strategy

Focus on making the sidecar **self-terminating** when no clients are connected, rather than relying on external processes to stop it. This is robust against all three root causes.

## Tasks

### Task 1: Add idle auto-shutdown to sidecar server

- [x] 1.1: Add a heartbeat/client-tracking system to `src/sidecar/server.ts`
  - Track last activity timestamp on every incoming request via `handleSidecarRequest`
  - Add configurable idle timeout (default: 5 minutes)
  - Start a periodic check interval (every 30s) that calls `stopSidecar()` + `process.exit(0)` if idle time exceeds the timeout
- [x] 1.2: Add a `/ping` endpoint to `src/sidecar/routes.ts` that clients can call to keep the sidecar alive (lightweight, returns 200)
- [x] 1.3: Write tests for idle shutdown logic in `src/sidecar/server.test.ts`

### Task 2: Add process exit cleanup to MCP server

- [x] 2.1: In `src/mcp/server.ts:main()`, register `SIGTERM` and `SIGINT` handlers that call `stopSidecarProcess()` if no other active sessions exist
- [x] 2.2: Register a `process.on('exit')` handler as a last-resort cleanup signal
- [x] 2.3: Write tests for MCP server cleanup in `src/mcp/server.test.ts`

### Task 3: Add stale session cleanup

- [x] 3.1: In `src/sidecar/server.ts`, add a startup routine that marks any sessions older than 24h as ended (prevents permanent session leak)
- [x] 3.2: Integrated into `startSidecar()` — cleanup runs on every sidecar startup + idle shutdown handles the "all sessions ended" case
- [x] 3.3: Write tests for stale session cleanup

### Task 4: Harden PID management

- [x] 4.1: In `startSidecar()`, write PID file atomically with `process.pid` immediately after bind succeeds (verified — already done in sidecar.ts:61)
- [x] 4.2: Added `isSidecarReachable()` async function with HTTP/Unix socket probe fallback in `lifecycle.ts`
- [x] 4.3: Write tests for hardened PID checks — 4 tests covering no PID, stale PID, alive-but-not-sidecar, and real sidecar

## Files to Modify

| File                            | Change                                                    |
| ------------------------------- | --------------------------------------------------------- |
| `src/sidecar/server.ts`         | Idle tracking, auto-shutdown timer, stale session cleanup |
| `src/sidecar/routes.ts`         | `/ping` endpoint                                          |
| `src/sidecar/lifecycle.ts`      | Hardened liveness check with socket probe                 |
| `src/mcp/server.ts`             | SIGTERM/SIGINT handlers with sidecar cleanup              |
| `src/sidecar/server.test.ts`    | Tests for idle shutdown, stale sessions                   |
| `src/mcp/server.test.ts`        | Tests for cleanup handlers                                |
| `src/sidecar/lifecycle.test.ts` | Tests for hardened PID check                              |

## Risks

- **Idle timeout too aggressive:** If set too short, sidecar restarts frequently causing cold-start latency. Mitigate: 5min default, `/ping` keep-alive from active clients.
- **Cleanup races:** MCP server exit + sidecar self-terminate could race. Mitigate: `cleanupSidecarFiles(expectedPid)` guard already handles this.
- **Test complexity:** Sidecar idle tests need timers. Mitigate: Use `jest.useFakeTimers()` or short timeout values in tests.
