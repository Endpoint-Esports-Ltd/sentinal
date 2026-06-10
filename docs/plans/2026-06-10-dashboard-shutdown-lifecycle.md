# Dashboard Not Shutting Down With Last Sentinal Instance — Fix Plan

Created: 2026-06-10
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Bugfix

## Summary

**Symptom:** The dashboard process (`sentinal serve`, port 41778) keeps running after the last Sentinal instance shuts down. Live evidence on this machine: dashboard up 11h24m (still serving v1.29.1) while the sidecar was only 14m old — the sidecar has cycled while the dashboard survived as an orphan. Additionally, the dashboard serve lifecycle is entirely unlogged (no `~/.sentinal/*.log` coverage), unlike sidecar/plugin components.

**Trigger:** Any shutdown that goes through the sidecar's session-aware watchdog instead of explicit session-end events: app quit without SessionEnd/session.deleted, client crash, idle abandonment, stale sessions.

**Root Cause:** `src/sidecar/server.ts:158-167` — `doShutdown()` in `enableSessionAwareShutdown()` stops only the sidecar (`stopSidecar` + `process.exit`), never the dashboard. Same for the foreground signal handler `src/cli/commands/sidecar.ts:94-99`. The ONLY dashboard stop paths are explicit session-end events (`runSessionEnd` in `src/cli/commands/hook.ts:97-134` for Claude Code; `session.deleted` handler in `targets/opencode/plugins/sentinal.ts:1063-1078` for OpenCode), both gated on `activeSessions.length === 0`. When those events never fire (the common crash/quit/idle case), the sidecar's watchdog correctly shuts the sidecar down — and orphans the dashboard, which has no watchdog, no session awareness, and no other stop trigger.

## Investigation

- Dashboard is a detached `Bun.serve()` process (`src/dashboard/server.ts:39-53`) run as `sentinal serve` (`src/cli/commands/serve.ts:23-68`), PID tracked at `~/.sentinal/server.pid` (`src/dashboard/lifecycle.ts:13-17`).
- Auto-started by: Claude Code SessionStart (`src/cli/commands/hook.ts:57-66` → `autoStartDashboard`), and OpenCode plugin init (`targets/opencode/plugins/sentinal.ts:319-329` → `autoStartProcess("server.pid", "serve")`).
- All stop paths audited: `stopServer()` (`src/dashboard/lifecycle.ts:147-164`) is called only from `runSessionEnd`, the legacy `src/hooks/session-end.ts`, the plugin `session.deleted` handler, and the version-mismatch restart inside `autoStartDashboard`. None of the sidecar's own shutdown paths (`doShutdown`, signal handlers, `stopSidecarProcess`, MCP cleanup `src/mcp/server.ts:67-87`) touch it.
- Working comparison: the sidecar itself has a robust safety net (`enableSessionAwareShutdown`, `src/sidecar/server.ts:143-219` — 60s grace after last session, 30min idle fallback, 1h stale-activity detection). The dashboard lacks all of it; tying the dashboard's fate to the sidecar's watchdog decision fixes the orphan at the source.
- Logging: `src/utils/file-log.ts` provides `logToFile`/`logSidecar` (10MB rotation, node:* only). The dashboard has zero log calls — `serve.ts` only `console.log`s into discarded stdio. Log viewer `src/cli/commands/sidecar-logs.ts:63-68` renders sidecar + plugin logs and needs a new filter entry for a dashboard log.
- Side finding (out of scope, noted only): the plugin's `autoStartProcess` does no version check, so an old-version dashboard is never restarted by OpenCode (why this one still served 1.29.1). The Claude Code path (`autoStartDashboard(getVersion())`) does handle it.

## Behavior Contract

### Fix Property (C => P)

**When condition C holds:** the sidecar shuts down with no live sessions — via session-aware watchdog (grace period, idle fallback, stale sessions) or via SIGTERM/SIGINT with 0 active sessions.
**Property P must hold:** the dashboard process is also terminated (SIGTERM via `stopServer()`), and both the stop attempt and the dashboard's own start/stop are written to `~/.sentinal/dashboard.log`.

### Preservation Property (!C => unchanged)

**When condition C does NOT hold:** sessions are still active (e.g., sidecar killed externally while another assistant session lives).
**Existing behavior preserved:** dashboard stays up; existing session-end stop paths (`runSessionEnd`, plugin `session.deleted`) behave exactly as before; existing sidecar shutdown tests (which inject `onShutdown`) never touch real PID files.

## Fix Approach

**Files:** `src/sidecar/server.ts`, `src/cli/commands/sidecar.ts`, `src/utils/file-log.ts`, `src/dashboard/lifecycle.ts`, `src/cli/commands/serve.ts`, `src/cli/commands/sidecar-logs.ts`, `targets/opencode/plugins/sentinal.ts` (log line on stop), + tests.

**Strategy:**

1. **Shutdown fix (root cause):**
   - `enableSessionAwareShutdown`: add `stopDashboardFn?: () => void` to `SessionAwareShutdownOptions`. In `doShutdown`, call it (wrapped in try/catch, logged). Default resolution: when `opts.onShutdown` is injected (test mode) and no `stopDashboardFn` given → no-op (protects existing tests and dev machines from killing a real dashboard); production path (no `onShutdown`) → real `stopServer` from `src/dashboard/lifecycle.js`. Import is safe — `dashboard/lifecycle.ts` is node:fs-only, no `bun:sqlite`.
   - Foreground signal handler (`sidecar.ts:94-99`): before `stopSidecar`, if `result.ctx.store.getActiveSessions().length === 0` (try/catch), call `stopServer()` and log. Covers `stopSidecarProcess()`-initiated SIGTERM (MCP cleanup, `sentinal sidecar stop`).
2. **Lifecycle logging (same pattern as sidecar):**
   - `file-log.ts`: add `DASHBOARD_LOG_FILE = "dashboard.log"` + `logDashboard(message)`.
   - `serve.ts`: log `dashboard: started pid=... port=... version=...`, `dashboard: shutting down: signal`, startup failure.
   - `dashboard/lifecycle.ts`: log in `autoStartDashboard` (spawn, version-mismatch restart, skip reasons) and `stopServer` (SIGTERM sent pid=N / stale pid cleaned / no pid file).
   - `sidecar-logs.ts`: add dashboard log to the viewer filter.
   - Plugin `session.deleted` path: add `log("stopDashboard: ...")` line (plugin.debug.log) — rebuild embedded assets via `bun run build:all`, never hand-edit `src/cli/embedded-assets.ts`.

**Tests:** extend `src/sidecar/server.test.ts` (watchdog calls `stopDashboardFn` on shutdown; not called while sessions active), `src/dashboard/lifecycle.test.ts` (stopServer/autoStart logging via `spyOn(fileLogModule, "getLogDir")` pattern), `src/utils/file-log.test.ts` (logDashboard), `src/cli/commands/sidecar-logs.test.ts` (new filter).

## Progress

- [x] Task 1: Shutdown fix — sidecar watchdog stops dashboard
- [x] Task 2: Dashboard lifecycle logging
- [ ] Task 3: Verify
      **Tasks:** 3 | **Done:** 2 | **Left:** 1

## Tasks

### Task 1: Shutdown fix — sidecar watchdog stops dashboard

**Objective:** Regression test + fix so `doShutdown` and the sidecar signal handler stop the dashboard when no sessions are live.
**Files:** `src/sidecar/server.ts`, `src/sidecar/server.test.ts`, `src/cli/commands/sidecar.ts`
**TDD:** Write regression test (watchdog shutdown invokes injected `stopDashboardFn`; preservation: not invoked while sessions active; existing `onShutdown` tests untouched) → verify FAILS → implement → verify all PASS.
**Verify:** `bun test src/sidecar/server.test.ts`

### Task 2: Dashboard lifecycle logging

**Objective:** `dashboard.log` coverage for start/stop/auto-start decisions, mirroring `logSidecar` patterns; viewer integration; plugin stop log line.
**Files:** `src/utils/file-log.ts`, `src/cli/commands/serve.ts`, `src/dashboard/lifecycle.ts`, `src/cli/commands/sidecar-logs.ts`, `targets/opencode/plugins/sentinal.ts`, matching test files
**TDD:** Tests for `logDashboard`, `stopServer` logging, viewer filter → FAIL → implement → PASS.
**Verify:** `bun test src/utils/file-log.test.ts src/dashboard/lifecycle.test.ts src/cli/commands/sidecar-logs.test.ts`

### Task 3: Verify

**Objective:** Full suite + quality checks + builds + live smoke (per sentinal-live-smoke skill: confirm orphaned dashboard gets stopped by a sidecar watchdog cycle; check `~/.sentinal/dashboard.log` lines appear).
**Verify:** `bun test > /tmp/t.log 2>&1; echo $?` (must be 0) && `npx tsc --noEmit` && `bun run build:all`
