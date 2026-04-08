# Sidecar Architecture

The sidecar is a **long-lived background HTTP server** that holds a warm `MemoryStore`, `SpecStore`, `WorktreeStore`, and `LspClient`. Hooks, the MCP server, and the OpenCode plugin all connect via `SidecarClient` instead of opening their own SQLite handles, which would cost ~100ms of cold-start per invocation.

## Why It Exists

| Without sidecar                                           | With sidecar                      |
| --------------------------------------------------------- | --------------------------------- |
| Every hook spawns → opens SQLite → loads sqlite-vec → ... | Hooks reuse a warm Unix socket    |
| ~100-300ms per hook                                       | ~5-15ms per hook                  |
| `@xenova/transformers` model reloaded per invocation      | Model stays resident              |
| No LSP state                                              | LSP client persists across edits  |

## Transport

- **Unix domain socket** (primary): `~/.sentinal/sidecar.sock`
- **HTTP localhost** (fallback when Unix socket unavailable): port stored in `~/.sentinal/sidecar.port`
- PID tracked in `~/.sentinal/sidecar.pid`

Path helpers: `src/sidecar/paths.ts` (`getSidecarSocketPath`, `getSidecarPortPath`, `getSidecarPidPath`).

## Key Files

```
src/sidecar/
├── paths.ts              # Socket/port/PID file paths
├── server.ts             # Long-running HTTP server (startSidecar)
├── lifecycle.ts          # auto-start, status check, graceful stop
├── client.ts             # SidecarClient (used by hooks + MCP + plugin)
├── routes.ts             # Core routes (/health, /session, /tdd-state, ...)
├── quality-routes.ts     # /quality-check (tsc/eslint/prettier)
├── project-routes.ts     # /project-context
├── config-routes.ts      # Config snapshot endpoint
├── tdd-routes.ts         # TDD cycle state transitions
├── lsp-client.ts         # LSP wrapper (TypeScript language server)
├── observation-queue.ts  # Async memory observation queue
└── response.ts           # JSON response helpers
```

## SidecarClient Usage

```ts
import { SidecarClient } from "../sidecar/client.js";

// In MCP server startup (src/mcp/server.ts:97-100): auto-start + retry
autoStartSidecar();
const client = await SidecarClient.connectWithRetry();

// In a Claude Code hook (one-shot): try once, fall back to null
const client = await SidecarClient.connect();
if (!client) {
  // Sidecar not running — hook should gracefully degrade
  return;
}

// Query
const status = await client.specStatus(projectPath);
```

`SidecarClient.connect()` returns `null` if the sidecar is unavailable — **hooks must handle this without erroring**. Never throw because the sidecar is down.

## Available Routes (partial)

| Route                          | Method | Purpose                                     |
| ------------------------------ | ------ | ------------------------------------------- |
| `/health`                      | GET    | Liveness probe                              |
| `/ping`                        | GET    | Fast no-op                                  |
| `/session`                     | POST   | Create session record                       |
| `/session/:id/end`             | POST   | End session                                 |
| `/tdd-state`                   | GET/POST | Read/update TDD cycle state                 |
| `/observation`                 | POST   | Enqueue memory observation                  |
| `/context`                     | GET    | Memory context for session                  |
| `/notification`                | POST   | Create notification                         |
| `/quality-check`               | POST   | Run tsc/eslint/prettier (subprocess)        |
| `/project-context`             | GET    | Project metadata + conventions              |

Full list: see `src/sidecar/routes.ts`, `quality-routes.ts`, `project-routes.ts`, `config-routes.ts`, `tdd-routes.ts`.

## Lifecycle

```
autoStartSidecar()      # fire-and-forget; spawns detached sidecar process
  ↓
writes sidecar.pid
  ↓
server listens on Unix socket + port fallback
  ↓
hooks/MCP connect via SidecarClient
  ↓
stopSidecarProcess()    # called on MCP server SIGTERM/SIGINT if no active sessions
```

**Gotcha:** the MCP server's cleanup handler only stops the sidecar if `store.getActiveSessions().length === 0`. See `src/mcp/server.ts:67`. This avoids killing the sidecar while other Claude Code or OpenCode processes are still using it.

## Debugging

```bash
# Is the sidecar running?
cat ~/.sentinal/sidecar.pid
kill -0 $(cat ~/.sentinal/sidecar.pid) && echo "alive"

# Logs
tail -f ~/.sentinal/sidecar.log
tail -f ~/.sentinal/plugin.debug.log   # OpenCode plugin side

# Health check (port mode)
curl -s http://127.0.0.1:$(cat ~/.sentinal/sidecar.port)/health

# Health check (Unix socket mode — requires curl --unix-socket)
curl -s --unix-socket ~/.sentinal/sidecar.sock http://localhost/health

# Force restart
kill $(cat ~/.sentinal/sidecar.pid); rm ~/.sentinal/sidecar.{sock,port,pid}
```

## Adding a New Route

1. Create the handler in the appropriate `src/sidecar/*-routes.ts` file (or a new one if it's a new domain).
2. Wire it into the router (`server.ts` dispatches based on path prefix).
3. Add the client method to `src/sidecar/client.ts`.
4. Write tests in `src/sidecar/<route>-routes.test.ts` — use `buildForTest(baseUrl)` for client construction against a test server.
5. **Do NOT** import `bun:sqlite` (or anything pulling it in) into `client.ts` or `paths.ts` — hooks that only need the client shouldn't pay that cost. That's why `paths.ts` is factored out of `server.ts`.
