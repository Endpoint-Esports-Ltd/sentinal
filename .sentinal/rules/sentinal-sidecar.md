# Sidecar Architecture

The sidecar is a **long-lived background HTTP server** that holds a warm `MemoryStore`, `SpecStore`, `WorktreeStore`, and `LspClient`. Hooks, the MCP server, and the OpenCode plugin all connect via `SidecarClient` instead of opening their own SQLite handles, which would cost ~100ms of cold-start per invocation.

## Why It Exists

| Without sidecar                                           | With sidecar                     |
| --------------------------------------------------------- | -------------------------------- |
| Every hook spawns → opens SQLite → loads sqlite-vec → ... | Hooks reuse a warm Unix socket   |
| ~100-300ms per hook                                       | ~5-15ms per hook                 |
| `@xenova/transformers` model reloaded per invocation      | Model stays resident             |
| No LSP state                                              | LSP client persists across edits |

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
├── client-routes.ts      # SidecarRoutes — one method per endpoint (SidecarClient extends it)
├── routes.ts             # handleSidecarRequest: /health, /ping + dispatch to the sub-handlers below
├── session-routes.ts     # /session, /session/:id/end, /session/active|touch|alive
├── memory-routes.ts      # /observation, /context, /memory/search|timeline|get|update|delete|stats
├── tdd-routes.ts         # /tdd-state (GET/POST), /tdd-state/list, /tdd-state/transition
├── spec-routes.ts        # /spec/sync, /spec/current, /spec/events, /spec/metrics
├── notification-routes.ts# POST /notification, GET /notifications/session, POST /notifications/read
├── project-key.ts        # THE project-key normalizer (canonical / write / read / infer-from-file)
├── quality-routes.ts     # /quality-check (+ quality-runners.ts, quality-lint.ts, quality-summary.ts)
├── project-routes.ts     # /project-context
├── config-routes.ts      # Config snapshot endpoint
├── worktree-routes.ts    # /worktree/*
├── retire-routes.ts      # /retire
├── lsp-client.ts         # LSP wrapper (TypeScript language server)
├── observation-queue.ts  # Async memory observation queue
└── response.ts           # JSON response helpers
```

### Dispatch

`server.ts`'s `fetchHandler` tries the standalone handlers first (retire, notification reads,
quality, project-context, `/tdd-state/transition`, `/spec/metrics`, config, worktree), then falls
through to `handleSidecarRequest` (`routes.ts`). That dispatcher serves `/health` and `/ping` and
then **`await`s** each sub-handler (`session`, `tdd`, `memory`, `spec`, `POST /notification`)
**inside its own try/catch**, so an async throw becomes a 500 JSON (`Internal error: …`) there
rather than in the server's `errorHandler`. Sub-handlers return `Response | null` (null = not mine).
The handler list is built per request so `spyOn(module, …)` stubs still intercept.

### Project keys on routes (D3/D4 — `project-key.ts`)

- **Write routes** (`POST /observation`, `/session`, `/spec/sync`, `/tdd-state/transition`,
  `POST /tdd-state` with a project, `POST /notification` with a project) use `normalizeProjectKey`: blank → 400
  `MISSING_PROJECT_PATH`, else canonical identity.
- **Read routes** (`/memory/search`, `/memory/timeline`, `/spec/current`, `GET /tdd-state`,
  `/tdd-state/list`, `/spec/metrics`, `/context`'s key) use `normalizeProjectFilter`: absent/blank
  = all projects, supplied = canonical. **Reads fail open.**
- `POST /tdd-state` `set` **without** a project infers it from the file (`inferProjectFromFile`) and
  logs it; a relative `filePath` is a 400. Hard 400 for an absent project is deferred.
- Never normalize `/project-context` or `/config/compaction` — they take **disk** paths.
- ⛔ Never resolve a blank value: `resolveProjectIdentity("")` uses the sidecar's own cwd.

## SidecarClient Usage

```ts
import { SidecarClient } from "../sidecar/client.js";

// In MCP server startup (src/mcp/server.ts:131-134): auto-start + retry
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

| Route              | Method   | Module                   | Purpose                                                                                                |
| ------------------ | -------- | ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `/health`          | GET      | `routes.ts`              | Liveness probe                                                                                         |
| `/ping`            | GET      | `routes.ts`              | Fast no-op                                                                                             |
| `/session`         | POST     | `session-routes.ts`      | Create session record                                                                                  |
| `/session/:id/end` | POST     | `session-routes.ts`      | End session                                                                                            |
| `/tdd-state`       | GET/POST | `tdd-routes.ts`          | Read/update TDD cycle state; `set` without `projectPath` infers it (D4)                                |
| `/tdd-state/list`  | GET      | `tdd-routes.ts`          | Active cycles; optional `spec_id`, `project` (canonical; absent = all projects)                        |
| `/observation`     | POST     | `memory-routes.ts`       | Add an observation — always the deduped path (D10)                                                     |
| `/context`         | GET      | `memory-routes.ts`       | `?project=&semanticQuery=&workspace=` — key from `project`, shared memory from `workspace` (D8)        |
| `/spec/metrics`    | GET      | `spec-routes.ts`         | `?spec_id=&project=` — `project` disambiguates a shared slug (D6)                                      |
| `/notification`    | POST     | `notification-routes.ts` | Create notification; optional `projectPath` (absent → global `NULL`, blank → 400, else canonical — D5) |
| `/quality-check`   | POST     | `quality-routes.ts`      | tsc/eslint/prettier; with `filePath` fixes that file only, else report-only (D1)                       |
| `/project-context` | GET      | `project-routes.ts`      | Project metadata + conventions (disk path — not normalized)                                            |

Full list: see the module headers of `src/sidecar/*-routes.ts` and `routes.ts`.

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

**Gotcha:** the MCP server's cleanup handler only stops the sidecar if `store.getActiveSessions().length === 0`. See `src/mcp/server.ts:95-106` (in client mode — `store` is `null` — it never stops the sidecar). This avoids killing the sidecar while other Claude Code or OpenCode processes are still using it.

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
2. Wire it in: either add the sub-handler to `handleSidecarRequest`'s list in `routes.ts` (gets its try/catch → 500 JSON), or to `server.ts`'s `fetchHandler` chain for a standalone handler. Normalize any project through `project-key.ts` (write vs read variant).
3. Add the client method to `src/sidecar/client-routes.ts` (`SidecarRoutes`; `client.ts` is near its length limit). New params must be optional — old sidecars ignore them.
4. Write tests in `src/sidecar/<route>-routes.test.ts` — use `buildForTest(baseUrl)` for client construction against a test server.
5. **Do NOT** import `bun:sqlite` (or anything pulling it in) into `client.ts` or `paths.ts` — hooks that only need the client shouldn't pay that cost. That's why `paths.ts` is factored out of `server.ts`.
