# Sentinal MCP Tools Intermittently Stop Functioning Fix Plan

Created: 2026-06-09
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Bugfix

## Summary

**Symptom:** Sentinal MCP tools intermittently fail with the generic error `Was there a typo in the url or port?` — typically after ~1 hour, across 3-5 concurrent OpenCode sessions on Linux. The same call succeeds later. Originally reported on `spec_register`, `spec_notify`, `worktree_*`; user has since confirmed `memory_save` fails the same way (losing session context/observations). **All MCP tool domains are affected** — they all delegate through the same cached `SidecarClient.get/post`. Secondary: worktree tools report "No active worktree found" while the worktree exists on disk.

**Trigger:** Sidecar process exits while MCP servers / OpenCode plugin instances hold a cached `SidecarClient` pointing at the dead transport.

**Root Cause (primary):** `src/mcp/server.ts:100` and `targets/opencode/plugins/sentinal.ts:337` resolve a `SidecarClient` **once at startup** and cache it for the process lifetime. The sidecar **legitimately self-terminates** via `enableSessionAwareShutdown` (`src/sidecar/server.ts:63-67`): 60s grace after last session ends, and — matching the "after an hour" report — `STALE_ACTIVITY_THRESHOLD_MS = 1h` treats live-but-idle sessions as crashed and shuts down. After that, every client-delegating tool call fails until some _other_ process happens to respawn the sidecar at the same socket path (which is why retries later succeed). `SidecarClient.get/post` (`src/sidecar/client.ts:118-143`) has no reconnect, no retry, and propagates Bun's raw fetch message (`Was there a typo in the url or port?` = ECONNREFUSED) which `mcpError` (`src/mcp/helpers.ts:14`) surfaces verbatim with no URL/errno/operation context.

**Root Cause (secondary, worktree drift):** the sidecar route `handleResolveWorktree` (`src/sidecar/worktree-routes.ts:52`) does no disk reconciliation, and `worktree_create` always writes through a _direct_ `MemoryStore` (`src/worktree/mcp-tools.ts:42,132`) even in client mode — so when transport fails mid-flow (or records go stale), the index diverges from disk and resolve answers "not found" for a worktree that exists.

## Investigation

- **Bug report:** `docs/bug_reports/2026-06-09-intermitent-mcp-issues/` — error is intermittent, identical call succeeds later; the report's claim that memory tools were "unaffected" was timing coincidence (all domains share the same client-delegation pattern; memory calls simply happened while the sidecar was up). User has since observed `memory_save` failing identically (`src/memory/mcp-tools.ts:294` → `client.addObservation` → same `post()` path), causing loss of captured context. The single client-level fix covers all 26 tools.
- **ps output:** sidecar respawned at 21:24 (`sentinal sidecar start` child of a _new_ mcp-server) while three mcp-server processes from 16:58-16:59 kept running with stale cached clients — exactly the cached-client + sidecar-churn pattern.
- **Debug log:** 1242 occurrences of `Was there a typo in the url or port?` since March. Tail shows `Connected to sidecar` immediately followed (same ms) by `Eager session insert failed: Was there a typo...` — health probe succeeds against a dying/respawning sidecar, next request hits a closed listener (`stopSidecar` calls `server.stop(true)` force-close).
- `"Was there a typo in the url or port?"` is Bun's native `fetch` `ConnectionRefused` message — confirms ECONNREFUSED, meaning **the request never reached the server, so retrying is always safe** (no idempotency concern).
- Shutdown design is intentional (avoid orphan sidecars); the bug is that **recovery is not transparent** — nothing reconnects or respawns on the next tool call.
- `autoStartSidecar()` (`src/sidecar/lifecycle.ts:161`) is only called at MCP-server startup and plugin init — never on failure.
- Working comparison: `withSidecarOrDirect` (`src/sidecar/client.ts:392`) degrades gracefully for hooks; MCP tools have no equivalent resilience.

## Behavior Contract

### Fix Property (C => P)

**When condition C holds:** the sidecar is down or has restarted while a process holds a cached `SidecarClient`, and a request fails at the connection level (ECONNREFUSED/socket gone).
**Property P must hold:** the client transparently re-resolves the transport (respawning the sidecar via `autoStartSidecar()` if needed) and retries the request; the call succeeds without the caller seeing an error. If reconnection genuinely fails after bounded retries, the error message includes the HTTP method, request path, transport target (socket path or URL), and the underlying cause.

**When condition C2 holds:** a worktree exists on disk but its index record is missing/stale.
**Property P2:** `worktree_detect`/`worktree_diff`/`worktree_sync` reconcile against `git worktree list` on disk, treat the on-disk worktree as authoritative, re-register it, and return it instead of "not found".

### Preservation Property (!C => unchanged)

**When the sidecar is healthy:** requests behave exactly as before — single fetch, no added latency, no behavior change. Hooks using `SidecarClient.connect()` still get `null` when the sidecar is absent and degrade gracefully. Session-aware shutdown timing is unchanged.

## Fix Approach

**Files:** `src/sidecar/client.ts`, `src/sidecar/client.test.ts`, `src/worktree/manager.ts`, `src/worktree/manager.test.ts`, `src/sidecar/worktree-routes.ts`, `src/sidecar/worktree-routes.test.ts`, `src/worktree/mcp-tools.ts`, `src/worktree/mcp-tools.test.ts`

**Strategy:**

1. **Self-healing `SidecarClient`** (fixes MCP server AND OpenCode plugin in one place, since both cache the instance):
   - In `get()`/`post()`, catch connection-level fetch failures (ECONNREFUSED / `ConnectionRefused` / socket errors — NOT HTTP-level or `body.ok=false` errors).
   - On failure: re-run transport resolution (`tryConnect()`); if no live sidecar, call `autoStartSidecar()` (import from `lifecycle.ts` — no `bun:sqlite` cost) and poll briefly (bounded, ~10 × 200ms like `connectWithRetry`); update the instance's `baseUrl`/`fetchOpts` in place; retry the request once.
   - Safe to retry: connection-refused means the request never reached the server.
   - If still failing: throw enriched error, e.g. `POST /session failed: unix:~/.sentinal/sidecar.sock (and HTTP fallback) unreachable — ConnectionRefused`. Tool handlers' existing `mcpError` prefixes then produce actionable messages, satisfying the diagnosability expectation.
   - `baseUrl`/`fetchOpts` become mutable private fields (currently `readonly`).
2. **Worktree disk reconciliation:** add `WorktreeManager.resolveWithReconcile(slug, projectPath)` — DB lookup first; on miss, scan `git worktree list --porcelain` in the project for a worktree whose branch/path matches the slug; if found on disk, upsert an active record and return it. Use it in the sidecar route `handleResolveWorktree` and the direct-mode paths in `src/worktree/mcp-tools.ts` (detect/diff/sync/abandon), keeping the existing dir-missing → mark-abandoned self-heal.
3. **Intentionally NOT changed:** session-aware shutdown thresholds (design is sound once recovery is transparent); `src/mcp/server.ts` startup flow (a healed client makes the cached reference recover in place); the OpenCode plugin (same reason — shared client fix covers it).

**Tests:** `client.test.ts` (reconnect-and-retry after server restart at same socket/port; enriched error after exhausted retries; healthy path unchanged), `manager.test.ts` (reconcile finds on-disk worktree missing from index), `worktree-routes.test.ts` + `mcp-tools.test.ts` (resolve returns reconciled worktree instead of "not found").

## Progress

- [x] Task 1: SidecarClient reconnect + enriched errors
- [x] Task 2: Worktree disk reconciliation
- [x] Task 3: Verify
      **Tasks:** 3 | **Done:** 3 | **Left:** 0

**Task 3 notes:** Full suite 1331 pass / 0 fail (clean-tree baseline had 26 pre-existing failures — see below). Project-wide tsc: 0 errors. Prettier: clean. `build:opencode` succeeds (bundles the fixed client.ts into sentinal.mjs).

## Deferred Issues

- **`bun run build:claude` fails on a clean tree** (pre-existing, unrelated to this fix): `src/index.ts:243` references `targets/opencode/plugins/sentinal.ts` which violates the claude tsconfig `rootDir: src`, plus two TS2339 errors in the plugin (`parentSessionId`, `title`). Comes from in-flight changelog-audit working-tree changes. Until fixed, Claude Code hook dist won't rebuild with this fix; the OpenCode target builds fine.
- **Fixed inline (test infra, was masking this plan's regression tests):** 5 hook test files used `mock.module("../sidecar/client.js", ...)` which leaks across test files in the same bun process and gutted `SidecarClient` for `client.test.ts` (26 pre-existing full-suite failures). Converted to restorable `spyOn(SidecarClient, "connect")` in task-created/instructions-loaded/config-change/stop-failure/file-changed tests.

**Task 2 notes:** Found a sharper root cause for the drift during RED: `store.resolveBySlug` branch fallback used hardcoded `spec/<slug>%` but the default branch prefix is `sentinal/spec-` (types.ts:41) — and since `manager.create` inserts `spec_id=NULL` (linkSpec runs after spec_register, which was failing due to the connectivity bug), the fallback NEVER matched real branches → "not found" with the worktree on disk and a valid DB row. Fixed: resolveBySlug now matches both the configured default prefix and the legacy `spec/` prefix. Added `WorktreeManager.resolveWithReconcile` (DB → disk-gone self-heal → `git worktree list --porcelain` scan → re-register active record); wired into sidecar `/worktree/resolve` route and all direct-mode tool paths (detect/diff/sync/abandon). Updated 3 pre-existing diff/sync test fixtures to create worktree dirs on disk (resolution is now disk-authoritative by design).

**Task 1 notes:** Implemented `fetchWithReconnect` in `src/sidecar/client.ts` — on connection-level fetch failure: re-resolve transport via `tryConnect()`, respawn via overridable `SidecarClient.autoStartFn` (defaults to `autoStartSidecar()`), poll (`reconnectAttempts` × `reconnectDelayMs`), heal `baseUrl`/`fetchOpts` in place, retry once. Errors enriched with method + path + transport target + cause/code. Discovered + fixed during TDD: probe clients inside `tryConnect()` must be non-reconnecting, otherwise a stale socket file causes unbounded recursion (health → reconnect → tryConnect → health). `buildForTest` clients stay non-reconnecting. Note: repo has no ESLint config — quality gate is tsc + prettier + bun test (all clean). client.ts now 509 lines (warn threshold; was already 403 pre-change — cohesive, not split).

## Tasks

### Task 1: SidecarClient reconnect + enriched errors

**Objective:** Make cached `SidecarClient` instances survive sidecar restarts; surface actionable errors when truly unreachable.
**Files:** `src/sidecar/client.ts`, `src/sidecar/client.test.ts`
**TDD:** Write failing tests — (a) request after test-server restart succeeds via reconnect (exercise `addObservation`, the `memory_save` path, as the regression case), (b) request with no server respawns/retries then throws an error containing method + path + target, (c) healthy-path single-fetch behavior preserved, (d) `autoStartSidecar` spawn is injectable/disabled in tests → verify FAIL → implement → all PASS.
**Verify:** `bun test src/sidecar/client.test.ts`

### Task 2: Worktree disk reconciliation

**Objective:** Resolve-by-slug treats on-disk worktrees as authoritative; "not found" only when truly absent.
**Files:** `src/worktree/manager.ts`, `src/worktree/manager.test.ts`, `src/sidecar/worktree-routes.ts`, `src/sidecar/worktree-routes.test.ts`, `src/worktree/mcp-tools.ts`, `src/worktree/mcp-tools.test.ts`
**TDD:** Write failing tests for `resolveWithReconcile` (index miss + worktree on disk → re-registered and returned; true miss → null) and route/tool integration → verify FAIL → implement → all PASS.
**Verify:** `bun test src/worktree/ src/sidecar/worktree-routes.test.ts`

### Task 3: Verify

**Objective:** Full suite + quality checks + both targets build.
**Verify:** `bun test && bun run build:all` + tsc/eslint via quality_report
