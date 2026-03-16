# Sidecar Server + Session Tracking Fix

Created: 2026-03-10
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature
Parent: docs/plans/2026-03-10-tdd-enforcement.md

## Summary

**Goal:** Fix the session tracking bug (no sessions in dashboard/CLI despite active OpenCode usage) and introduce a long-lived sidecar server that eliminates per-hook cold-start overhead, provides a single authoritative DB connection, and serves as the backbone for all hook/plugin/MCP communication.

**Two phases:**

1. **Phase 1 (Bug Fix):** Diagnose and fix why the OpenCode plugin fails to create sessions. Add logging to silent `catch {}` blocks. Ensure `memory_save` MCP tool associates observations with real sessions when one exists.
2. **Phase 2 (Sidecar):** Create a dedicated sidecar process (`sentinal sidecar`) that holds a warm `MemoryStore` and listens on a Unix domain socket (macOS/Linux) with HTTP localhost fallback. Hooks, the MCP server, and the OpenCode plugin delegate all DB operations to the sidecar instead of opening their own SQLite connections.

**Current problem (5 cold starts per Write tool use):**
Each Claude Code hook invocation spawns a new Bun process, imports modules, opens SQLite, does work, and exits. For a single Write tool, 5 hook processes are spawned (1 PreToolUse + 4 PostToolUse). Each `new MemoryStore()` takes ~5-10ms. The OpenCode plugin avoids this by holding an in-process store, but its silent error handling means failures go undetected.

**After sidecar:**
Hooks call `fetch()` to a warm Unix socket (~0.1ms) or HTTP localhost (~1-2ms). One process, one DB connection, one source of truth for sessions. The MCP server delegates its DB operations to the sidecar instead of opening its own `MemoryStore`.

## Scope

### In Scope

- Fix OpenCode plugin silent session creation failures (Phase 1)
- Fix MCP `memory_save` to use real session ID when available (Phase 1)
- Create `sentinal sidecar` CLI command (long-lived background process)
- Sidecar serves on Unix domain socket (`~/.sentinal/sidecar.sock`) with HTTP fallback
- Sidecar API endpoints for: session CRUD, TDD state, memory observation, memory restore, spec sync
- Sidecar client module (`src/sidecar/client.ts`) used by hooks, MCP server, and OpenCode plugin
- Sidecar lifecycle management (PID file, auto-start, graceful shutdown)
- Migrate hooks from direct `MemoryStore` access to sidecar client
- Migrate MCP server from direct `MemoryStore` to sidecar client
- OpenCode plugin optionally delegates to sidecar (with in-process fallback)

### Out of Scope

- Merging sidecar with dashboard server (separate processes by design choice)
- Replacing the MCP stdio transport (clients require stdio; sidecar is for DB access only)
- Authentication/TLS on the sidecar (localhost-only, same-user)
- Windows support for Unix sockets (HTTP fallback covers this)

## Context for Implementer

**Why a separate process from the dashboard:**
The dashboard serves HTML views and is user-facing. Its lifecycle is tied to "at least one active session exists" (stopped when last session ends). The sidecar must be more resilient -- it should survive dashboard restarts and should not be affected by UI concerns. Hooks depend on the sidecar for correctness (TDD guard blocking); the dashboard is supplementary.

**Why Unix socket over TCP:**
Unix domain sockets avoid TCP overhead (no handshake, no port allocation, no firewall rules). `Bun.serve({ unix: path })` and `fetch(url, { unix: path })` are both natively supported. Latency is ~0.1ms vs ~1-2ms for localhost TCP. The socket file at `~/.sentinal/sidecar.sock` also acts as a natural existence check.

**Session tracking bug root cause (to be confirmed in Phase 1):**
The OpenCode plugin at `targets/opencode/plugins/sentinal.ts:104-108` creates a `MemoryStore` inside a `try/catch` that silently swallows errors. If `bun:sqlite` fails (DB locked, permissions, path issue), `memoryStore` stays `null`. The `session.created` event handler at line 375 checks `if (memoryStore)` before calling `insertSession()` -- so sessions are never created. Additionally, OpenCode may not emit `session.created` events at all, or may use a different event type string.

**MCP `memory_save` session ID problem:**
`src/memory/mcp-tools.ts:173` generates synthetic session IDs (`mcp-${Date.now()}`) instead of using the real session. This means MCP-saved observations are orphaned from the session that created them. The MCP server has no way to know the current session ID because it's a separate stdio process with no shared state. The sidecar solves this: it knows the active session and can inject the real session ID.

**File length constraints:**

- `src/memory/store.ts` is already 663 lines (over 600 limit). The sidecar should _reduce_ code here by moving session/TDD CRUD into sidecar endpoints, not add to it.
- `targets/opencode/plugins/sentinal.ts` is 597 lines (near limit). Moving DB operations to sidecar client calls will reduce its size.
- `src/cli/commands/hook.ts` is 379 lines. Replacing `MemoryStore` instantiation with sidecar `fetch()` calls will simplify hook functions.

**Bun.serve Unix socket API:**

```typescript
// Server
const server = Bun.serve({
  unix: "/path/to/socket.sock",
  fetch(req) {
    return new Response("ok");
  },
});

// Client
const res = await fetch("http://localhost/api/endpoint", {
  unix: "/path/to/socket.sock",
});
```

**Existing lifecycle pattern (reusable from dashboard):**

- PID file: `~/.sentinal/sidecar.pid`
- Socket file: `~/.sentinal/sidecar.sock`
- Auto-start: `autoStartSidecar()` -- same pattern as `autoStartDashboard()` in `src/dashboard/lifecycle.ts`
- Singleton: check PID + socket file existence before starting

**Hooks that need sidecar (DB access):**

| Hook              | Current DB Access                                           | Sidecar Endpoint Needed               |
| ----------------- | ----------------------------------------------------------- | ------------------------------------- |
| `session-start`   | Write: `insertSession()`                                    | `POST /session`                       |
| `session-end`     | Write: `endSession()`, `insertNotification()`               | `POST /session/:id/end`               |
| `memory-observer` | Write: `addObservation()`                                   | `POST /observation`                   |
| `memory-restore`  | Read: `restoreContext()`                                    | `GET /context?project=...`            |
| `tdd-guard`       | Read: `readTddState()`, `getCurrentSpec()`                  | `GET /tdd-state?file=...&project=...` |
| `tdd-tracker`     | Write: `setTddState()`, `clearTddState()`, `logSpecEvent()` | `POST /tdd-state`                     |
| `pre-compact`     | Read+Write: `restoreContext()`, `syncFromPlanFile()`        | `GET /context` + `POST /spec/sync`    |

**Hooks that DON'T need sidecar (no DB access):**

- `post-compact-restore` -- reads JSON file only
- `tool-redirect` -- pure logic, no DB
- `file-checker` -- runs tsc/eslint, no DB
- `context-monitor` -- reads transcript file size, no DB
- `spec-stop-guard` -- reads plan files, no DB

**Fallback strategy:**
If the sidecar is not running and auto-start fails, hooks fall back to direct `MemoryStore` access (current behavior). This ensures hooks never fail silently just because the sidecar is down. The sidecar is an optimization, not a hard dependency -- except for session tracking, where the sidecar becomes the authoritative session manager.

## Progress Tracking

### Phase 1: Session Tracking Bug Fix

- [x] Task 1: Diagnose OpenCode plugin session creation failure
- [x] Task 2: Fix MCP `memory_save` to use real session ID when available

### Phase 2: Sidecar Server

- [x] Task 3: Create sidecar server with Unix socket + HTTP fallback
- [x] Task 4: Create sidecar client module
- [x] Task 5: Sidecar lifecycle management (PID, auto-start, shutdown)
- [x] Task 6: Migrate hooks to use sidecar client
- [x] Task 7: Migrate MCP server to use sidecar client
- [x] Task 8: OpenCode plugin sidecar integration

**Total Tasks:** 8 | **Completed:** 8 | **Partial:** 0 | **Remaining:** 0

## Implementation Tasks

### Phase 1: Session Tracking Bug Fix

### Task 1: Diagnose and fix OpenCode plugin session creation failure

**Objective:** Determine why the OpenCode plugin fails to create sessions in `~/.sentinal/memory.db` and fix the root cause. The sessions table currently has 0 rows despite active usage.

**Files:**

- Modify: `targets/opencode/plugins/sentinal.ts` -- Add diagnostic logging to all `catch {}` blocks, fix session creation

**Investigation steps:**

1. Add `console.error()` logging to the `catch {}` block at line 107-109 (MemoryStore init)
2. Add `console.error()` logging to the event handler at line 369 to confirm whether `session.created` fires
3. Add `console.error()` logging to the `catch {}` block at line 386 (insertSession failure)
4. Run OpenCode with the plugin and check stderr output
5. Based on findings, fix the root cause (one of: event type mismatch, MemoryStore init failure, race condition)

**Likely fixes needed:**

- If `session.created` never fires: check OpenCode's plugin event types, possibly use a different lifecycle hook or the plugin initialization itself to create the session
- If `MemoryStore` init fails: log the actual error, potentially add retry logic or lazy initialization
- If insertSession throws: log the error, check for schema mismatches

**Definition of Done:**

- [ ] All silent `catch {}` blocks in the OpenCode plugin have diagnostic `console.error()` logging
- [ ] Root cause identified and documented
- [ ] Sessions are successfully created when OpenCode starts with the sentinal plugin
- [ ] `sentinal sessions list` shows the current OpenCode session
- [ ] Dashboard shows session data at localhost:41778
- [ ] All tests pass

---

### Task 2: Fix MCP `memory_save` to use real session ID when available

**Objective:** When a real session exists (created by hooks or plugin), `memory_save` should associate observations with that session instead of generating synthetic `mcp-<timestamp>` IDs.

**Files:**

- Modify: `src/memory/mcp-tools.ts` -- `memory_save` handler uses active session ID when available
- Modify: `src/mcp/server.ts` -- Pass store reference to tool registration for session lookup

**Approach:**
The MCP server holds a `MemoryStore` instance. When `memory_save` is called, query `store.getActiveSessions()` -- if exactly one session exists for the current project, use its ID. If zero or multiple, fall back to `mcp-${Date.now()}`.

```typescript
// In memory_save handler:
const activeSessions = store.getActiveSessions();
const sessionId =
  activeSessions.length === 1 ? activeSessions[0].id : `mcp-${Date.now()}`;
```

**Definition of Done:**

- [ ] `memory_save` uses real session ID when exactly one active session exists
- [ ] `memory_save` falls back to `mcp-<timestamp>` when no active session or multiple active sessions
- [ ] Observations created via MCP during an active session appear under that session in the dashboard
- [ ] Existing `memory_save` behavior unchanged when no sessions exist
- [ ] All tests pass

---

### Phase 2: Sidecar Server

### Task 3: Create sidecar server with Unix socket + HTTP fallback

**Objective:** Create a lightweight HTTP server that holds a warm `MemoryStore` and exposes API endpoints for all DB operations needed by hooks, MCP server, and plugins.

**Files:**

- Create: `src/sidecar/server.ts` -- Main sidecar server (~200 lines)
- Create: `src/sidecar/routes.ts` -- API endpoint handlers (~250 lines)
- Create: `src/sidecar/server.test.ts` -- Server tests

**Server configuration:**

- Primary transport: Unix domain socket at `~/.sentinal/sidecar.sock`
- Fallback: HTTP on `127.0.0.1` with dynamic port, written to `~/.sentinal/sidecar.port`
- On macOS/Linux: use Unix socket; write port file as fallback info
- Socket file deleted on graceful shutdown; stale socket files cleaned on startup

**API endpoints (all JSON request/response):**

| Method | Path               | Purpose                      | Used by                          |
| ------ | ------------------ | ---------------------------- | -------------------------------- |
| `GET`  | `/health`          | Liveness check               | Client connection test           |
| `POST` | `/session`         | Create session               | session-start hook, OC plugin    |
| `POST` | `/session/:id/end` | End session + notification   | session-end hook, OC plugin      |
| `GET`  | `/session/active`  | List active sessions         | session-end, MCP memory_save     |
| `GET`  | `/tdd-state`       | Read TDD state for file      | tdd-guard hook                   |
| `POST` | `/tdd-state`       | Set/clear TDD state          | tdd-tracker hook, OC plugin      |
| `POST` | `/observation`     | Create observation           | memory-observer hook, OC plugin  |
| `GET`  | `/context`         | Restore memory context       | memory-restore hook, pre-compact |
| `POST` | `/spec/sync`       | Sync spec from plan file     | pre-compact hook                 |
| `GET`  | `/spec/current`    | Get current spec for project | tdd-guard, tdd-tracker           |
| `POST` | `/notification`    | Insert notification          | session-end hook                 |

**Key design:**

- Single `MemoryStore` instance, created at startup, shared across all requests
- `SpecStore` wrapping the same `MemoryStore`
- Request routing via `if/else` URL matching (same pattern as dashboard `server.ts`)
- All endpoints return `{ ok: true, data: ... }` or `{ ok: false, error: "..." }`
- Graceful shutdown: close MemoryStore, delete socket file, delete PID file

**Definition of Done:**

- [ ] Sidecar server starts and listens on Unix socket
- [ ] All 11 API endpoints respond correctly
- [ ] Socket file created at `~/.sentinal/sidecar.sock`
- [ ] Port file created at `~/.sentinal/sidecar.port` as fallback
- [ ] Graceful shutdown cleans up socket + PID files
- [ ] Stale socket file cleaned on startup
- [ ] All endpoints tested with mock MemoryStore

---

### Task 4: Create sidecar client module

**Objective:** Create a client module that hooks, MCP server, and the OpenCode plugin use to communicate with the sidecar. Handles connection, transport selection, and fallback to direct DB access.

**Files:**

- Create: `src/sidecar/client.ts` -- Sidecar client (~150 lines)
- Create: `src/sidecar/client.test.ts` -- Client tests

**Client API:**

```typescript
export class SidecarClient {
  // Connection
  static async connect(): Promise<SidecarClient | null>; // Returns null if sidecar not running

  // Sessions
  async createSession(session: SessionInput): Promise<Session>;
  async endSession(id: string, summary?: string): Promise<void>;
  async getActiveSessions(): Promise<Session[]>;

  // TDD State
  async getTddState(
    filePath: string,
    projectPath: string,
  ): Promise<TddGuardResult>;
  async setTddState(opts: TddStateInput): Promise<void>;
  async clearTddState(filePath: string): Promise<void>;

  // Memory
  async addObservation(obs: ObservationInput): Promise<Observation>;
  async restoreContext(projectPath: string): Promise<RestoreResult>;

  // Specs
  async syncSpec(planPath: string, projectPath: string): Promise<void>;
  async getCurrentSpec(projectPath: string): Promise<Spec | null>;

  // Notifications
  async insertNotification(notif: NotificationInput): Promise<void>;
}
```

**Transport selection:**

1. Check if `~/.sentinal/sidecar.sock` exists -> use `fetch(url, { unix: socketPath })`
2. Check if `~/.sentinal/sidecar.port` exists -> use `fetch("http://127.0.0.1:${port}/...")`
3. Neither exists -> return `null` (sidecar not running)

**Fallback wrapper:**

```typescript
// Convenience for hooks -- try sidecar, fall back to direct DB
export async function withSidecarOrDirect<T>(
  sidecarFn: (client: SidecarClient) => Promise<T>,
  directFn: () => T | Promise<T>,
): Promise<T> {
  const client = await SidecarClient.connect();
  if (client) return sidecarFn(client);
  return directFn();
}
```

**Definition of Done:**

- [ ] `SidecarClient.connect()` returns client when sidecar running, null when not
- [ ] Unix socket transport works on macOS/Linux
- [ ] HTTP fallback transport works when socket unavailable
- [ ] All client methods make correct API calls and parse responses
- [ ] `withSidecarOrDirect()` correctly falls back to direct function
- [ ] Client handles connection errors gracefully (returns null, doesn't throw)
- [ ] All tests pass

---

### Task 5: Sidecar lifecycle management

**Objective:** Create lifecycle management for the sidecar: PID file tracking, auto-start on first hook/MCP invocation, graceful shutdown on last session end.

**Files:**

- Create: `src/sidecar/lifecycle.ts` -- Lifecycle management (~100 lines)
- Create: `src/sidecar/lifecycle.test.ts` -- Lifecycle tests
- Modify: `src/cli/index.ts` -- Register `sentinal sidecar` command

**Lifecycle pattern (mirrors `src/dashboard/lifecycle.ts`):**

- PID file: `~/.sentinal/sidecar.pid`
- Socket file: `~/.sentinal/sidecar.sock` (also acts as running indicator)
- `isSidecarRunning()`: check PID file + `kill(pid, 0)` + socket file exists
- `autoStartSidecar()`: idempotent -- spawn `sentinal sidecar` as detached background process
- `stopSidecar()`: send SIGTERM, clean up PID + socket files

**CLI command:**

```
sentinal sidecar          # Start in foreground (for development/debugging)
sentinal sidecar -d       # Start in background (detached)
sentinal sidecar --stop   # Stop running sidecar
sentinal sidecar --status # Show running status
```

**Auto-start integration points:**

- `runSessionStart()` in `src/cli/commands/hook.ts` -- auto-start sidecar (alongside existing dashboard auto-start)
- `SentinalPlugin` in `targets/opencode/plugins/sentinal.ts` -- auto-start sidecar on plugin init
- `main()` in `src/mcp/server.ts` -- auto-start sidecar on MCP server start

**Shutdown:**

- `runSessionEnd()` -- when last active session ends, stop sidecar (alongside existing dashboard stop)

**Definition of Done:**

- [ ] `sentinal sidecar` starts server in foreground with PID file
- [ ] `sentinal sidecar -d` starts detached background process
- [ ] `sentinal sidecar --stop` gracefully stops running sidecar
- [ ] `sentinal sidecar --status` reports running/stopped
- [ ] `autoStartSidecar()` is idempotent and non-fatal
- [ ] Stale PID files cleaned up automatically
- [ ] Sidecar added to CLI update-check skip list
- [ ] All tests pass

---

### Task 6: Migrate hooks to use sidecar client

**Objective:** Replace direct `MemoryStore` access in hook functions with sidecar client calls, falling back to direct access when sidecar is unavailable.

**Files:**

- Modify: `src/cli/commands/hook.ts` -- Replace MemoryStore usage with `withSidecarOrDirect()`

**Hooks to migrate (7 hooks with DB access):**

| Hook                | Current Code                                                            | Sidecar Code                                    |
| ------------------- | ----------------------------------------------------------------------- | ----------------------------------------------- |
| `runSessionStart`   | `new MemoryStore()` + `insertSession()`                                 | `client.createSession()`                        |
| `runSessionEnd`     | `new MemoryStore()` + `endSession()` + `insertNotification()`           | `client.endSession()`                           |
| `runMemoryObserver` | `new MemoryStore()` + `MemoryService` + `addObservation()`              | `client.addObservation()`                       |
| `runMemoryRestore`  | `new MemoryStore()` + `MemoryService` + `restoreContext()`              | `client.restoreContext()`                       |
| `runTddGuard`       | `processTddGuard()` (uses lightweight reader + conditional MemoryStore) | `client.getTddState()`                          |
| `runTddTracker`     | `processTddTracking()` (uses MemoryStore internally)                    | `client.setTddState()`                          |
| `runPreCompact`     | `new MemoryStore()` + `restoreContext()` + `syncFromPlanFile()`         | `client.restoreContext()` + `client.syncSpec()` |

**Hooks unchanged (5 hooks, no DB access):**

- `runPostCompactRestore`, `runToolRedirect`, `runFileChecker`, `runContextMonitor`, `runSpecStopGuard`

**Pattern for each migrated hook:**

```typescript
async function runSessionStart(): Promise<void> {
  const input = await readStdin();
  const { detectAssistant } = await import("../../hooks/session-start.js");

  await withSidecarOrDirect(
    async (client) => {
      await client.createSession({
        id: input.session_id,
        projectPath: input.cwd,
        assistant: detectAssistant(),
        transcriptPath: input.transcript_path ?? null,
      });
    },
    async () => {
      // Direct fallback -- current behavior
      const { MemoryStore } = await import("../../memory/store.js");
      const store = new MemoryStore();
      store.insertSession({ ... });
      store.close();
    },
  );

  const { autoStartDashboard } = await import("../../dashboard/lifecycle.js");
  autoStartDashboard();
}
```

**Benefits:**

- Hooks with sidecar: no `MemoryStore` import, no SQLite open/close, ~0.1ms per call
- Hooks without sidecar: identical to current behavior (graceful fallback)
- `hook.ts` file length should decrease slightly (fewer imports, simpler functions)

**Definition of Done:**

- [ ] All 7 DB-accessing hooks use `withSidecarOrDirect()` pattern
- [ ] Sidecar path: no `MemoryStore` instantiation in hook process
- [ ] Fallback path: identical behavior to current implementation
- [ ] Auto-start sidecar called from `runSessionStart()`
- [ ] Stop sidecar called from `runSessionEnd()` when last session ends
- [ ] All tests pass (both sidecar and fallback paths)
- [ ] `hook.ts` stays under 400 lines

---

### Task 7: Migrate MCP server to use sidecar client

**Objective:** The MCP server delegates all `MemoryStore` operations to the sidecar instead of opening its own database connection. This eliminates one more independent SQLite opener and ensures MCP observations are associated with real sessions.

**Files:**

- Modify: `src/mcp/server.ts` -- Use sidecar client instead of direct MemoryStore
- Modify: `src/memory/mcp-tools.ts` -- Tools use sidecar client for DB operations

**Approach:**
The MCP server must still use stdio transport (required by OpenCode/Claude Code). But instead of creating its own `MemoryStore`, it connects to the sidecar for all DB operations.

```typescript
// src/mcp/server.ts -- modified main()
export async function main(): Promise<void> {
  if (!isMemoryEnabled()) {
    process.exit(0);
  }

  const { autoStartSidecar } = await import("../sidecar/lifecycle.js");
  autoStartSidecar();

  // Try sidecar first, fall back to direct MemoryStore
  const client = await SidecarClient.connect();
  const store = client ? null : new MemoryStore();

  const { server } = createSentinalServer({ client, store });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

**Session ID resolution for `memory_save`:**
When using sidecar, `memory_save` calls `client.getActiveSessions()` to find the current session ID (implemented in Task 2's approach but now delegated to the sidecar).

**Definition of Done:**

- [ ] MCP server connects to sidecar when available
- [ ] MCP server falls back to direct MemoryStore when sidecar unavailable
- [ ] `memory_save` uses real session ID via sidecar's active session lookup
- [ ] All 5 memory tools + 1 spec tool work through sidecar
- [ ] MCP server auto-starts sidecar on launch
- [ ] All tests pass

---

### Task 8: OpenCode plugin sidecar integration

**Objective:** The OpenCode plugin optionally delegates DB operations to the sidecar while keeping its in-process `MemoryStore` as fallback. This makes the plugin more resilient (sidecar handles session creation authoritatively) and reduces the plugin's direct DB dependency.

**Files:**

- Modify: `targets/opencode/plugins/sentinal.ts` -- Add sidecar client as preferred path, keep MemoryStore as fallback

**Approach:**
The OpenCode plugin already has an in-process `MemoryStore` that works well. The sidecar integration is additive:

1. On plugin init, try to connect to sidecar
2. If sidecar available, prefer it for session CRUD and observation writes
3. Keep in-process `MemoryStore` for local reads (TDD state, spec queries) where latency matters
4. If sidecar unavailable, use in-process store for everything (current behavior)

```typescript
// In plugin initialization:
let sidecarClient: SidecarClient | null = null;
try {
  sidecarClient = await SidecarClient.connect();
} catch {
  // Sidecar unavailable -- use in-process store
}

// In session.created handler:
if (sidecarClient) {
  await sidecarClient.createSession({ ... });
} else if (memoryStore) {
  memoryStore.insertSession({ ... });
}
```

**Key benefit:** Even if `memoryStore` init fails (the current bug), the sidecar can still handle session creation. This provides defense-in-depth for the session tracking problem.

**File length concern:** `sentinal.ts` is at 597 lines. This migration should be a net reduction because:

- Session CRUD becomes `sidecarClient.createSession()` instead of `memoryStore.insertSession({ ...8 fields... })`
- Observation writes become `sidecarClient.addObservation()` instead of multi-line `service.addObservation({ ...10 fields... })`
- TDD state changes become `sidecarClient.setTddState()` instead of multi-line `memoryStore.setTddState({ ...6 fields... })`

**Definition of Done:**

- [ ] Plugin connects to sidecar on initialization (non-fatal if unavailable)
- [ ] Session creation uses sidecar when available, in-process store as fallback
- [ ] Session deletion uses sidecar when available
- [ ] Observation writes use sidecar when available
- [ ] TDD guard/tracker use sidecar when available
- [ ] Plugin still functions fully without sidecar (current behavior preserved)
- [ ] `sentinal.ts` stays under 600 lines (ideally reduced)
- [ ] All tests pass

## Testing Strategy

- **Task 1:** Manual testing with OpenCode -- check stderr for diagnostic output, verify sessions appear in DB
- **Task 2:** Unit test `memory_save` with mock store containing 0, 1, and 2 active sessions
- **Task 3:** Integration test sidecar server -- start server, make HTTP calls to all endpoints, verify responses
- **Task 4:** Unit test client -- mock fetch responses, test transport selection (socket vs HTTP), test fallback
- **Task 5:** Unit test lifecycle -- PID file operations, running detection, auto-start spawn
- **Task 6:** Unit test hooks -- mock sidecar client responses, verify correct API calls; test fallback to direct DB
- **Task 7:** Unit test MCP tools -- mock sidecar client, verify tools work through client
- **Task 8:** Integration test plugin -- mock sidecar client, verify session creation works through both paths

## Architecture Notes

### Process Landscape (After)

```
                    +---------------------+
                    |   Sidecar Server    |
                    |  (~/.sentinal/      |
                    |   sidecar.sock)     |
                    |                     |
                    |  MemoryStore (warm) |
                    |  SpecStore          |
                    +------+--------------+
                           |
              +------------+------------+
              |            |            |
     +--------v---+  +-----v----+  +---v--------------+
     | Claude Code|  | OpenCode |  |  MCP Server      |
     |   Hooks    |  |  Plugin  |  |  (stdio, no DB)  |
     | (subprocess|  |(in-proc) |  |                  |
     |  per-hook) |  |          |  |                  |
     +------------+  +----------+  +------------------+

                    +--------------------+
                    |  Dashboard Server  |
                    |  (port 41778)      |
                    |  Own MemoryStore   |
                    +--------------------+
```

The dashboard keeps its own `MemoryStore` for now (it only does reads for display). Future work could migrate it to the sidecar too, but it's not a priority since the dashboard has no cold-start problem.

### Fallback Chain

```
Hook invocation
  +-- Try Unix socket (~/.sentinal/sidecar.sock)
  |     +-- Success: fetch() to sidecar (~0.1ms)
  +-- Try HTTP fallback (~/.sentinal/sidecar.port)
  |     +-- Success: fetch() to localhost (~1-2ms)
  +-- Direct MemoryStore fallback
        +-- Open SQLite, do work, close (~5-10ms)
```

### Session Tracking Flow (After Fix)

```
Session starts (Claude Code or OpenCode)
  +-- Hook/plugin calls sidecar: POST /session
  |     +-- Sidecar inserts into sessions table
  |     +-- Returns session ID
  |
  +-- MCP memory_save called
  |     +-- MCP server asks sidecar: GET /session/active
  |     +-- Sidecar returns active session
  |     +-- Observation created with real session ID
  |
  +-- Dashboard reads sessions table
        +-- Shows session + associated observations
```

## Risks and Mitigations

| Risk                                                                 | Likelihood | Impact | Mitigation                                                                    |
| -------------------------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------- |
| Sidecar process dies mid-session                                     | Low        | Medium | Auto-restart on next hook invocation; direct DB fallback ensures no data loss |
| Unix socket permissions prevent access                               | Low        | Low    | Socket created with user permissions; HTTP fallback available                 |
| Socket file left behind after crash                                  | Medium     | Low    | Startup cleans stale socket files (check PID liveness)                        |
| Sidecar adds latency instead of reducing it                          | Low        | Low    | Benchmark: Unix socket fetch should be <1ms vs 5-10ms for MemoryStore init    |
| Multiple sidecar instances started (race condition)                  | Low        | Medium | PID file + socket file as mutex; second instance detects existing and exits   |
| OpenCode plugin can't reach sidecar (different filesystem namespace) | Low        | Low    | Plugin runs on same machine; socket path is absolute                          |
| Dashboard and sidecar both write to same DB                          | Medium     | Low    | WAL mode handles concurrent writers; both use same MemoryStore API            |
