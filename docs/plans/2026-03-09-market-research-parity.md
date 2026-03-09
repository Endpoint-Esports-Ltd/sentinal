# market research Feature Parity Implementation Plan

Created: 2026-03-09
Status: IN PROGRESS
Approved: No
Iterations: 1
Worktree: No
Type: Feature

## Summary

**Goal:** Build a standalone Sentinal ecosystem that eliminates all market research dependencies — a `sentinal` CLI binary, persistent memory system with SQLite, console dashboard (htmx), model routing, session management, auto-updater, shell integration, and installer improvements.

**Architecture:** The `sentinal` CLI binary (compiled via `bun build --compile`) becomes the central process — managing sessions, memory, worktrees, and serving the console dashboard. All data stored in SQLite via `bun:sqlite` (Bun's built-in SQLite module) at `~/.sentinal/sentinal.db`. The CLI replaces every `competitor-cli` binary reference. Dashboard served as static HTML + htmx with JSON API endpoints, built into the CLI's `serve` command.

**Tech Stack:** TypeScript, Bun (compile + runtime), bun:sqlite (storage — built-in, no native module compilation needed), htmx (dashboard), commander.js (CLI parsing)

## Scope

### In Scope
- `sentinal` CLI binary with all commands (check-context, register-plan, worktree, sessions, serve, greet, notify, update)
- SQLite-backed persistent memory (observations: CRUD, search, timeline)
- Memory MCP server (replaces legacy's mem-search backend)
- Session management (tracking, parallel sessions, lifecycle)
- Context monitor rescaling (effective 0-100% with compaction buffer)
- Console dashboard (Dashboard, Specifications, Memories, Sessions, Settings views)
- Model routing configuration (advisory hints per phase)
- Auto-updater (git-based tag comparison)
- Shell integration (bash/zsh/fish aliases)
- SessionEnd hook (session cleanup, dashboard notifications)
- Dev Container support (.devcontainer/ generation)
- One-line curl installer
- Installer rollback on failure
- Conditional rule activation (file glob patterns)

### Out of Scope
- License/registration system (explicitly excluded)
- VS Code extension support (explicitly excluded)
- Team asset sharing via `sx` (deferred — needs separate spec)
- Usage tracking / token cost analytics (deferred — requires API key integration)

## Context for Implementer

> Write for an implementer who has never seen the codebase.

**Patterns to follow:**
- Hooks in `src/hooks/*.ts` follow a pattern: import utils, export testable function, async `main()` at bottom with `if (import.meta.main)` guard (`src/hooks/context-monitor.ts:10-21`)
- Checkers in `src/checkers/*.ts` export pure functions, tested via Bun test (`src/checkers/detect.ts`)
- Utils in `src/utils/*.ts` are small, focused modules (`src/utils/hook-output.ts` — 56 lines)
- Tests co-located as `*.test.ts` next to source files
- Build output goes to `plugin/hooks/dist/` via `tsc`

**Conventions:**
- ESM modules (`"type": "module"` in package.json)
- `.js` extensions in imports (TypeScript compiles ESM)
- `Bun.spawnSync` for subprocess calls in hooks
- JSON protocol for hook I/O (stdin → process → stdout)
- kebab-case filenames

**Key files:**
- `src/hooks/context-monitor.ts` — Currently calls `~/.legacy/bin/legacy check-context --json` (line 12) — must be replaced
- `src/hooks/session-end.ts` — No-op placeholder (8 lines) — must implement
- `targets/claude-code/hooks/hooks.json` — Hook pipeline definition
- `targets/claude-code/settings.json` — Permissions and env vars
- `targets/claude-code/.mcp.json` — MCP server config (needs mem-search addition)
- `package.json` — Build scripts, dependencies
- `tsconfig.json` — TypeScript config (output to `plugin/hooks/dist/`)
- `src/cli/commands/install.ts` — Unified installer (replaced shell scripts)
- `src/cli/commands/uninstall.ts` — Unified uninstaller (replaced shell scripts)

**Gotchas:**
- Hooks receive input via stdin JSON (see `HookInput` interface in `src/utils/hook-output.ts:1-9`)
- `transcript_path` in hook input points to Claude Code's conversation file — useful for context estimation
- The plugin uses `${CLAUDE_PLUGIN_ROOT}` variable in hooks.json for path resolution
- `bun build --compile` creates a single native binary. Using `bun:sqlite` (built-in) avoids native module issues entirely — no external SQLite dependency to bundle
- OpenCode target (`targets/opencode/`) also needs updates when CLI changes, but its plugin architecture differs

**Domain context:**
- market research's `check-context` returns `{"percent": N}` where N is 0-100 raw context usage
- Claude Code reserves ~16.5% as compaction buffer, triggering at ~83.5% raw
- Effective % rescales: `effective = raw / 0.835 * 100`, capped at 100
- Sessions are per-Claude-Code-instance, identified by `session_id` from hook input
- Observations (memory) are typed: bugfix, feature, refactor, discovery, decision, change

## Runtime Environment

- **Start command:** `sentinal serve` (dashboard) or `sentinal` (launch Claude Code)
- **Port:** 41778 (avoid conflict with legacy's 41777)
- **Health check:** `GET /api/health`
- **Database:** `~/.sentinal/sentinal.db` (SQLite)

## Progress Tracking

- [~] Task 1: CLI binary scaffold + build pipeline (partial — CLI dispatcher, greet, install, uninstall, spec, build:cli done; serve, run, tsconfig.cli.json, build separation remaining)
- [~] Task 2: SQLite database module + schema (partial — observations/sessions/specs/spec_tasks/settings tables, migrations v1+v2+v3, WAL done; plans table remaining)
- [x] Task 3: Memory system (observations CRUD, search, timeline)
- [~] Task 4: Session management + check-context (partial — session insert/end in SQLite via hooks, context estimation function with rescaling done; CLI commands `sessions`/`check-context`, active session listing, stale cleanup, transcript_path storage remaining)
- [ ] Task 5: Plan registration + worktree commands
- [~] Task 6: Hook integration — replace legacy dependency + context rescaling (partial — legacy refs removed, native context estimation, rescaling, session-start/end hooks done; context bar visualization, `Bash(sentinal:*)` permission, session-start test, notification on session-end, server kill on last session remaining)
- [x] Task 7: Memory MCP server (refactored to src/mcp/server.ts with modular tool registration; 5 memory tools + spec_status tool)
- [ ] Task 8: Console dashboard — server + layout + Dashboard view
- [ ] Task 9: Console dashboard — Specs, Memories, Sessions, Settings views
- [x] Task 10: Model routing configuration
- [ ] Task 11: Shell integration + auto-updater
- [~] Task 12: Installer improvements (curl, rollback, devcontainer, conditional rules) (partial — conditional rule activation done; shell scripts replaced by TypeScript CLI; curl installer, rollback, devcontainer remaining)

**Total Tasks:** 12 | **Completed:** 3 | **Partial:** 5 | **Remaining:** 4

## Implementation Tasks

### Task 1: CLI Binary Scaffold + Build Pipeline

**Objective:** Create the `sentinal` CLI entry point with commander.js, configure Bun compilation, and set up the binary distribution path at `~/.sentinal/bin/sentinal`.

**Dependencies:** None

**Files:**
- Create: `src/cli/index.ts` — Main entry point with commander
- Create: `src/cli/commands/serve.ts` — Placeholder serve command
- Create: `src/cli/commands/greet.ts` — ASCII art greeting
- Create: `src/cli/commands/run.ts` — Launch Claude Code with sentinal plugin
- Modify: `package.json` — Add commander.js, build:cli script (no native module deps — bun:sqlite is built-in)
- Modify: `tsconfig.json` — Exclude CLI directories from hooks build (src/cli/, src/db/, src/memory/, src/sessions/, src/config/, src/worktree/, src/mcp/, src/dashboard/)
- Create: `tsconfig.cli.json` — Separate config for CLI compilation targeting src/cli/ and shared modules

**Key Decisions / Notes:**
- Use `commander` (npm) for CLI parsing — mature, TypeScript-friendly
- Binary compiled via `bun build --compile src/cli/index.ts --outfile dist/sentinal`
- `sentinal` command (no args) = `sentinal run` = launch claude with `--plugin` flag
- `sentinal greet` outputs ASCII banner similar to `install.sh:96-106`
- All commands support `--json` flag for structured output
- **Build separation:** `tsconfig.json` (existing) only compiles hooks/checkers/utils to `plugin/hooks/dist/`. `tsconfig.cli.json` targets CLI modules. `bun run build` = hooks only. `bun run build:cli` = `bun build --compile` (no tsc needed — Bun handles TS natively for CLI).
- **Install pipeline fix:** `targets/claude-code/install.sh` must copy `plugin/hooks/dist/` into the cache directory so `${CLAUDE_PLUGIN_ROOT}/hooks/dist/hooks/*.js` resolves correctly at runtime. Currently only `targets/claude-code/*` is copied, which omits built JS files.

**Definition of Done:**
- [x] `bun run build:cli` produces a working binary at `dist/sentinal`
- [x] `./dist/sentinal --help` shows available commands
- [x] `./dist/sentinal greet` outputs ASCII banner
- [x] `./dist/sentinal --version` shows version from package.json (compile-time injection via `--define`)
- [ ] `bun run build` only outputs hook-related files to `plugin/hooks/dist/` — no CLI files present
- [x] After running `install.sh`, `bun ${CACHE_DIR}/hooks/dist/hooks/context-monitor.js` completes without error
- [x] All tests pass
- [ ] No diagnostics errors

**What was implemented (differs from plan):**
- `src/cli/index.ts` — Commander.js dispatcher with commands: `mcp-server`, `memory`, `greet`, `spec`, `install`, `uninstall`
- `src/cli/commands/spec.ts` — `sentinal spec list/current/sync` subcommands for spec workflow management
- `src/cli/commands/greet.ts` — ASCII art banner with version display
- `src/cli/commands/install.ts` — Full install logic for Claude Code (marketplace-based) and OpenCode (global + local); replaces all 3 install shell scripts; auto-detects assistants; interactive prompt via `node:readline`; native JSON config merging (no `jq` dependency); string-aware JSONC comment stripping
- `src/cli/commands/uninstall.ts` — Full uninstall logic for both targets; replaces all 3 uninstall shell scripts; detects installed artifacts; config cleanup with "effectively empty" check
- `src/utils/shell.ts` — Shell utility helpers: `commandExists`, `run` (Bun.spawnSync wrapper), `resolveAssetsDir`, `resolveSentinalRoot`, `isGlobalInstall`, `copyDirRecursive`, `promptMenu`, `stripJsoncComments`, ANSI color helpers
- `bin/sentinal.sh` — Shell shim for development use
- `package.json` — `"sentinal"` bin entry, `build:cli` script with `--define __SENTINAL_VERSION__`, `cli` dev script; install:claude-code and install:opencode scripts updated to use TypeScript CLI
- Version injection: compile-time `--define` for binary, runtime `package.json` read for source
- `__SENTINAL_CLI` env var prevents sub-module main guards from double-executing in compiled binary
- All 6 shell scripts deleted: `install.sh`, `uninstall.sh`, `targets/claude-code/install.sh`, `targets/claude-code/uninstall.sh`, `targets/opencode/install.sh`, `targets/opencode/uninstall.sh`

**Not yet implemented from plan:**
- `src/cli/commands/serve.ts` — Placeholder serve command (depends on Task 8)
- `src/cli/commands/run.ts` — Launch Claude Code with sentinal plugin
- `tsconfig.cli.json` — Separate config for CLI compilation (not needed yet — Bun handles TS natively)
- Build separation: hooks build still compiles all of `src/` including CLI files

**Verify:**
```bash
bun run build:cli && ./dist/sentinal --help && ./dist/sentinal greet
```

---

### Task 2: SQLite Database Module + Schema

**Objective:** Create the SQLite database layer with schema for observations, sessions, and settings. Include migration support for future schema changes.

**Dependencies:** Task 1

**Files:**
- Create: `src/db/database.ts` — Database connection manager (singleton, lazy init)
- Create: `src/db/schema.ts` — Table creation SQL, migration runner
- Create: `src/db/types.ts` — TypeScript interfaces for DB records
- Create: `src/db/database.test.ts` — Database tests
- Create: `src/db/schema.test.ts` — Schema migration tests

**Key Decisions / Notes:**
- Database at `~/.sentinal/sentinal.db`
- Use `bun:sqlite` (Bun's built-in SQLite module — synchronous API, no native compilation, bundles into compiled binary seamlessly)
- Schema version tracked in a `_migrations` table
- Tables: `observations`, `sessions`, `plans`, `settings`
- `observations` schema: id (INTEGER PK), type (TEXT), title (TEXT), text (TEXT), project (TEXT), created_at (TEXT ISO), tags (TEXT JSON array)
- `sessions` schema: id (TEXT PK = session_id from Claude), project (TEXT), started_at (TEXT), ended_at (TEXT nullable), transcript_path (TEXT), status (TEXT: active/ended)
- `plans` schema: id (INTEGER PK), path (TEXT), status (TEXT), session_id (TEXT FK), registered_at (TEXT)
- `settings` schema: key (TEXT PK), value (TEXT JSON)
- WAL mode for concurrent reads
- Indices on `observations(type)`, `observations(project)`, `observations(created_at)`, `sessions(status)`

**Definition of Done:**
- [x] Database created at `~/.sentinal/sentinal.db` on first access (actual path: `~/.sentinal/memory.db`)
- [~] All tables created with correct schemas (`observations`, `sessions`, `observations_fts`, `specs`, `spec_tasks` done via v1+v2 migrations; `settings` done via v3 migration; `plans` table not yet created)
- [x] Migration runner handles version upgrades (`schema_version` table with sequential migration functions)
- [x] WAL mode enabled (`PRAGMA journal_mode = WAL` in store constructor)
- [x] Unit tests verify table creation, basic CRUD, migration ordering (`store.test.ts` — 261 lines)
- [ ] No diagnostics errors

**What was implemented (differs from plan):**
- Database module lives at `src/memory/store.ts` (not `src/db/database.ts` as planned)
- Types at `src/memory/types.ts` (not `src/db/types.ts`)
- DB filename is `memory.db` (not `sentinal.db`)
- Uses `schema_version` table (not `_migrations`)
- FTS5 virtual table with sync triggers included in schema
- Vector store support via `sqlite-vec` extension
- V2 migration adds `specs` and `spec_tasks` tables (for spec workflow tracking)

**Not yet implemented from plan:**
- `plans` table (id, path, status, session_id, registered_at) — needed for Task 5 (note: `specs` table partially covers this)

**Verify:**
```bash
bun test src/memory/store.test.ts
```

---

### Task 3: Memory System (Observations CRUD, Search, Timeline)

**Objective:** Implement the observation storage layer with full-text search and timeline querying — the core of the persistent memory system.

**Dependencies:** Task 2

**Files:**
- Create: `src/memory/observations.ts` — CRUD operations, search, timeline
- Create: `src/memory/types.ts` — Observation types, query interfaces
- Create: `src/memory/observations.test.ts` — Full test coverage

**Key Decisions / Notes:**
- SQLite FTS5 for full-text search on `title` and `text` columns
- `search(query, opts)` → returns observation summaries (id, title, type, created_at) — lightweight index
- `timeline(anchor, depth_before, depth_after)` → returns observations around an anchor ID, chronologically sorted
- `getObservations(ids)` → returns full observation details for specific IDs
- `saveObservation(text, title?, project?, type?)` → creates new observation
- Types: bugfix, feature, refactor, discovery, decision, change
- Follow the 3-step workflow: search → timeline → get_observations (token-efficient)
- Project auto-detected from git remote or cwd basename

**Definition of Done:**
- [x] `saveObservation` stores with auto-generated ID and timestamp (AUTOINCREMENT PK; timestamp caller-provided)
- [x] `search` returns ranked results using FTS5 (`searchFTS()` with MATCH and rank ordering)
- [x] `timeline` returns chronological context around an anchor (`getTimelineAround()` with before/after)
- [x] `getObservations` returns full details for specific IDs (`SELECT * WHERE id IN (...)`)
- [x] Search filters by type, project, date range (`buildFilterClauses()` supports all)
- [x] Tests cover: save/retrieve, search ranking, timeline ordering, empty results, date filtering (`store.test.ts` + `service.test.ts`)
- [ ] No diagnostics errors (pre-existing Bun type LSP issues only)

**What was implemented (differs from plan):**
- Implementation lives in `src/memory/` (not separate `src/memory/observations.ts`)
- `store.ts` handles storage, `service.ts` handles business logic
- Observation types are `decision, discovery, error, fix, pattern` (plan said `bugfix, feature, refactor, discovery, decision, change`)
- Additional features beyond plan: vector similarity search (`vector-store.ts`, `embeddings.ts`), search orchestrator with hybrid/vector/FTS strategies, content sanitization, maintenance utilities (rebuild FTS/vector index, backup, integrity check)
- CLI for memory management: `cli.ts` with search, list, get, export, stats, prune, repair commands

**Verify:**
```bash
bun test src/memory/
```

---

### Task 4: Session Management + check-context

**Objective:** Implement session lifecycle tracking in SQLite and the `sentinal check-context` command that estimates context window usage from transcript file size.

**Dependencies:** Task 2

**Files:**
- Create: `src/sessions/manager.ts` — Session CRUD, lifecycle
- Create: `src/sessions/context.ts` — Context usage estimation from transcript
- Create: `src/cli/commands/sessions.ts` — `sentinal sessions` command
- Create: `src/cli/commands/check-context.ts` — `sentinal check-context --json` command
- Create: `src/sessions/manager.test.ts`
- Create: `src/sessions/context.test.ts`

**Key Decisions / Notes:**
- Session created on first hook invocation for a given `session_id`
- `startSession(session_id, project, transcript_path)` — upserts session record
- `endSession(session_id)` — sets ended_at, status=ended
- `getActiveSessions()` — returns sessions where status=active
- `sentinal sessions --json` returns `{"count": N, "sessions": [...]}`
- `sentinal check-context --json` reads transcript file, estimates tokens:
  - Read file size in bytes
  - Approximate: 1 token ≈ 3 bytes (conservative for mixed code/prose — more accurate than 4 bytes)
  - Context window: 200K tokens (default, configurable via `sentinal config set context_window 200000`)
  - Bytes-per-token ratio configurable via `sentinal config set bytes_per_token 3` for user tuning
  - Return `{"percent": Math.round(estimatedTokens / maxTokens * 100)}`
- Transcript path stored in session record on creation
- Stale session cleanup: sessions older than 24h without activity marked as ended

**Definition of Done:**
- [~] Sessions created/updated/ended correctly in SQLite (insert/end works via hooks; no `status` column, no `transcript_path` storage, no `getActiveSessions()` query)
- [ ] `sentinal sessions --json` returns count and session list
- [ ] `sentinal check-context --json` returns `{"percent": N}`
- [x] Context estimation works with real transcript files (`src/sessions/context.ts` — file size based, env-var configurable, rescaling applied)
- [ ] Stale session cleanup runs on `sessions` command
- [x] All tests pass (`src/sessions/context.test.ts` — 7 tests; session CRUD tested in `src/memory/store.test.ts`)
- [ ] No diagnostics errors

**What was implemented (differs from plan):**
- Session CRUD lives in `src/memory/store.ts` (not a standalone `src/sessions/manager.ts`) — `insertSession()`, `endSession()`, `getSession()`
- Session start/end hooks: `src/hooks/session-start.ts` and `src/hooks/session-end.ts` call the store methods
- `src/sessions/context.ts` (63 lines) — `estimateContextUsage(transcriptPath)` with file-size estimation, bytes-per-token ratio (default 3), context window (default 200K), compaction buffer rescaling (raw / 0.835)
- `src/sessions/context.test.ts` (99 lines) — 7 tests covering missing file, empty file, known size, cap at 100%, env var overrides
- OpenCode plugin parity: session insert/end integrated into `targets/opencode/plugins/sentinal.ts` event handlers
- Context estimation used by `src/hooks/context-monitor.ts` (replaces broken `legacy check-context` dependency)

**Not yet implemented from plan:**
- `src/sessions/manager.ts` — Standalone session manager module (CRUD lives in store.ts instead)
- `src/cli/commands/sessions.ts` — `sentinal sessions --json` command
- `src/cli/commands/check-context.ts` — `sentinal check-context --json` command
- `getActiveSessions()` method — No way to list sessions where `end_time IS NULL`
- `transcript_path` storage in sessions table
- `status` column in sessions table (`active`/`ended` — currently implied by `end_time IS NULL`)
- Stale session cleanup (24h threshold)

**Verify:**
```bash
bun test src/sessions/ && ./dist/sentinal check-context --json
```

---

### Task 5: Plan Registration + Worktree Commands

**Objective:** Implement `sentinal register-plan` and `sentinal worktree` subcommands that manage spec plans and git worktrees.

**Dependencies:** Task 2, Task 4

**Files:**
- Create: `src/cli/commands/register-plan.ts` — Plan registration
- Create: `src/cli/commands/worktree.ts` — Worktree management (create, detect, diff, sync, cleanup, status)
- Create: `src/cli/commands/notify.ts` — Send notifications (stored in SQLite for dashboard polling)
- Create: `src/worktree/manager.ts` — Git worktree operations
- Create: `src/worktree/manager.test.ts`

**Key Decisions / Notes:**
- `sentinal register-plan <path> <status>` — upserts plan in SQLite, associates with current session
- `sentinal worktree create --json <slug>` — creates git worktree at `.worktrees/spec-<slug>-<hash>/`
- `sentinal worktree detect --json <slug>` — checks if worktree exists
- `sentinal worktree diff --json <slug>` — lists changed files in worktree
- `sentinal worktree sync --json <slug>` — squash merges worktree to base branch
- `sentinal worktree cleanup --json <slug>` — removes worktree and branch
- `sentinal worktree status --json` — shows active worktree for current session
- `sentinal notify <type> <title> <message> --plan-path <path>` — stores notification in SQLite
- All worktree operations shell out to `git worktree` commands
- Notifications table: id, type, title, message, plan_path, created_at, read (boolean)

**Definition of Done:**
- [ ] `sentinal register-plan` stores plan status in SQLite
- [ ] All worktree subcommands work (create, detect, diff, sync, cleanup, status)
- [ ] `sentinal notify` stores notifications retrievable by dashboard
- [ ] JSON output works for all commands
- [ ] Tests cover plan registration, worktree operations (mocked git)
- [ ] No diagnostics errors

**Verify:**
```bash
bun test src/worktree/ && ./dist/sentinal register-plan "/tmp/test.md" "PENDING" && ./dist/sentinal worktree status --json
```

---

### Task 6: Hook Integration — Replace legacy Dependency + Context Rescaling

**Objective:** Update all hooks to use `sentinal` CLI instead of `competitor-cli`, implement context rescaling to effective 0-100% range, and implement the SessionEnd hook.

**Dependencies:** Task 4

**Files:**
- Modify: `src/hooks/context-monitor.ts` — Replace `legacy check-context` with `sentinal check-context`, add rescaling
- Modify: `src/hooks/session-end.ts` — Implement session cleanup and notification
- Modify: `src/hooks/pre-compact.ts` — Save session state to SQLite (via `sentinal notify` or `sentinal session update`) in addition to compact-state.json, so dashboard and memory search can surface compaction events
- Modify: `targets/claude-code/hooks/hooks.json` — Add SessionStart session tracking hook (all starts, not just compact)
- Modify: `targets/claude-code/settings.json` — Add `Bash(sentinal:*)` to permissions allow list
- Create: `src/hooks/session-start.ts` — Register session on startup
- Create: `src/hooks/session-start.test.ts`

**Key Decisions / Notes:**
- Context rescaling formula: `effective = Math.min(100, Math.round(raw / 83.5 * 100))`
- Warning thresholds change to effective %: 80% effective, 90% effective, 95%+ effective
- Status bar visualization: `▓` blocks for used, `░` for remaining, final `▓` for compaction buffer
- `session-start.ts` hook: reads `session_id` and `transcript_path` from stdin, calls `sentinal session start <id> --transcript <path> --project <cwd>`
- `session-end.ts` hook: calls `sentinal session end <id>`, sends notification to dashboard. If no active sessions remain after ending, kill dashboard server via PID file.
- `pre-compact.ts`: continues writing compact-state.json (fast local fallback) AND saves state to SQLite via `sentinal notify compaction "Pre-compact" "<plan_path>" --plan-path <plan_path>` so dashboard surfaces it
- Replace `~/.legacy/bin/legacy` with `~/.sentinal/bin/sentinal` in all hook code
- Update hooks.json to add SessionStart hook (not matcher "compact" — all starts)

**Definition of Done:**
- [x] No references to `~/.legacy/bin/legacy` remain in hook source code
- [x] Context monitor uses native estimation with valid rescaled percentage (calls `estimateContextUsage()` directly instead of shelling out)
- [x] SessionStart hook registers sessions in SQLite (`src/hooks/session-start.ts` — `store.insertSession()`)
- [~] SessionEnd hook ends sessions, sends notification, kills server if last session (ends session done; notification and server kill not implemented)
- [~] pre-compact.ts saves state to both compact-state.json AND SQLite (JSON file + spec sync to SQLite via `SpecStore.syncFromPlanFile()` done; compact event notification to SQLite not done)
- [ ] Context bar visualization includes buffer indicator
- [ ] `Bash(sentinal:*)` added to settings.json permissions
- [x] All existing tests pass, new hook tests added (`context-monitor.test.ts` recalibrated for 80/90/95% thresholds — 6 tests; `spec-stop-guard.test.ts` — 4 tests)
- [ ] No diagnostics errors
- [ ] `src/hooks/session-start.test.ts` created

**What was implemented (differs from plan):**
- `src/hooks/context-monitor.ts` — REWRITTEN: replaced `legacy check-context` with native `estimateContextUsage()` from `src/sessions/context.ts`. Thresholds: 80%/90%/95% effective. Plain text warnings (no visualization bar).
- `src/hooks/session-start.ts` — NEW: reads `session_id`/`cwd` from stdin, calls `store.insertSession()` directly (not via CLI subcommand as plan specified)
- `src/hooks/session-end.ts` — Updated: calls `store.endSession()` + cleans up event buffer file
- `src/hooks/pre-compact.ts` — Refactored: uses shared `findActivePlan()` from `src/spec/detect.ts`, syncs active spec to SQLite via `SpecStore.syncFromPlanFile()`, writes compact-state.json
- `src/hooks/spec-stop-guard.ts` — Refactored: uses shared `findActivePlan()` + `shouldBlockStop()` from `src/spec/detect.ts`
- `targets/claude-code/hooks/hooks.json` — SessionStart hook added (non-compact entry); memory-observer matcher includes `Bash`
- OpenCode parity: all hook features mirrored in `targets/opencode/plugins/sentinal.ts` (session tracking, spec detection, bash memory capture)

**Not yet implemented from plan:**
- Context bar visualization (`▓`/`░` blocks with buffer indicator)
- `Bash(sentinal:*)` permission in `targets/claude-code/settings.json`
- `src/hooks/session-start.test.ts` — test file for session start hook
- Notification on session end (dashboard integration, depends on Task 8)
- Kill dashboard server on last session end (depends on Task 8)

**Verify:**
```bash
bun test src/hooks/ && echo '{"session_id":"test","transcript_path":"/dev/null","cwd":"/tmp","permission_mode":"default","hook_event_name":"PostToolUse"}' | bun src/hooks/context-monitor.ts; echo "exit: $?"
```

---

### Task 7: Memory MCP Server

**Objective:** Create a standalone MCP server backed by the SQLite memory system, compatible with Claude Code's MCP protocol. This replaces legacy's mem-search backend.

**Dependencies:** Task 3

**Files:**
- Create: `src/mcp/memory-server.ts` — MCP server with search, timeline, get_observations, save_memory tools
- Create: `src/mcp/types.ts` — MCP protocol types
- Modify: `targets/claude-code/.mcp.json` — Add mem-search server pointing to sentinal's MCP
- Modify: `targets/opencode/opencode.json` — Add mem-search server

**Key Decisions / Notes:**
- Use `@modelcontextprotocol/sdk` for MCP server implementation (standard SDK)
- Server runs via `bun src/mcp/memory-server.ts` (stdio transport)
- 4 tools exposed: `search`, `timeline`, `get_observations`, `save_memory`
- Tool schemas match legacy's mem-search API for compatibility with existing rules
- `search` params: query (required), limit, type, project, dateStart, dateEnd
- `timeline` params: anchor (ID) or query, depth_before, depth_after
- `get_observations` params: ids (array, required)
- `save_memory` params: text (required), title, project, type
- Server reads/writes to same `~/.sentinal/sentinal.db` as CLI

**Definition of Done:**
- [x] MCP server starts and responds to initialize/list_tools (verified with JSON-RPC initialize)
- [x] All tools callable and return correct data (5 tools: `memory_search`, `memory_timeline`, `memory_get`, `memory_save`, `memory_stats` — plan said 4, `memory_stats` is an addition)
- [x] Server configured in `.mcp.json` for both targets (Claude Code: `"sentinal": { "command": "sentinal", "args": ["mcp-server"] }`; OpenCode: `sentinal mcp-server`)
- [x] Compatible with existing workflow (MCP SDK handles protocol automatically)
- [x] Integration test: save → search → timeline → get works end-to-end (`src/mcp/server.test.ts` — 20 tests)
- [ ] No diagnostics errors (pre-existing Bun type LSP issues only)

**What was implemented (differs from plan):**
- Originally built at `src/memory/mcp-server.ts`; subsequently refactored to `src/mcp/server.ts` as a universal MCP entrypoint with modular tool registration
- `src/mcp/server.ts` (67 lines) — `createSentinalServer()`, server name `"sentinal"` v0.2.0
- `src/memory/mcp-tools.ts` (233 lines) — 5 memory tools extracted: `registerMemoryTools(server, store)`
- `src/spec/mcp-tools.ts` (70 lines) — `registerSpecTools()` with `spec_status` tool (6th tool added)
- No separate `src/mcp/types.ts` — uses `@modelcontextprotocol/sdk` types directly
- 6 tools total: `memory_search`, `memory_timeline`, `memory_get`, `memory_save`, `memory_stats`, `spec_status`
- Server invocation via unified CLI: `sentinal mcp-server` routes to `main()` export
- `main()` exported for CLI dispatcher; `__SENTINAL_CLI` env var prevents double-execution in compiled binary
- `isMemoryEnabled()` config check before startup (opt-out via `~/.sentinal/config.json`)
- Old files deleted: `src/memory/mcp-server.ts`, `src/memory/mcp-server.test.ts`, `bin/sentinal-memory.sh`

**Verify:**
```bash
echo '{"jsonrpc":"2.0","method":"initialize","params":{"capabilities":{}},"id":1}' | bun src/cli/index.ts mcp-server
```

---

### Task 8: Console Dashboard — Server + Layout + Dashboard View

**Objective:** Build the HTTP server into the `sentinal serve` command and create the dashboard layout with the main Dashboard view showing workspace status, active sessions, spec progress, and recent activity.

**Dependencies:** Task 4, Task 5

**Files:**
- Create: `src/dashboard/server.ts` — HTTP server (Bun.serve), API routes, static file serving
- Create: `src/dashboard/routes/api.ts` — JSON API endpoints
- Create: `src/dashboard/views/layout.ts` — HTML layout template (header, nav, footer)
- Create: `src/dashboard/views/dashboard.ts` — Dashboard view (workspace status, sessions, specs)
- Create: `src/dashboard/static/styles.css` — Minimal CSS (Tailwind CDN or utility classes)
- Modify: `src/cli/commands/serve.ts` — Wire up server start

**Key Decisions / Notes:**
- Server uses `Bun.serve()` — no external HTTP framework needed
- HTML generated server-side as template strings (no build step)
- htmx loaded from CDN: `<script src="https://unpkg.com/htmx.org@2"></script>`
- Tailwind loaded from CDN: `<script src="https://cdn.tailwindcss.com"></script>`
- API endpoints: `GET /api/health`, `GET /api/dashboard`, `GET /api/sessions`, `GET /api/specs`, `GET /api/notifications`
- Dashboard view shows: active session count, recent specs with status, notifications, git branch info
- Auto-refresh via htmx polling: `hx-trigger="every 5s"`
- Port 41778 (configurable via `--port` flag)
- Navigation: Dashboard | Specifications | Memories | Sessions | Settings
- **Lifecycle management:** `sentinal serve` writes PID to `~/.sentinal/server.pid` on start. Before starting, checks if PID file exists and process is alive — if so, exits cleanly with message "Dashboard already running on port 41778". `sentinal run` auto-starts `sentinal serve` as a background process (detached). SessionEnd hook (Task 6) kills server via PID file when last session ends.
- **Bundle htmx/tailwind as fallback:** Include htmx.min.js as string literal in server code for air-gapped environments. CDN is primary, inline fallback if CDN fetch fails.

**Definition of Done:**
- [ ] `sentinal serve` starts HTTP server on port 41778
- [ ] Starting `sentinal serve` when server already running detects existing process and exits with message
- [ ] PID file written to `~/.sentinal/server.pid` on start, removed on stop
- [ ] `GET /` returns dashboard HTML with htmx
- [ ] Dashboard shows active sessions, recent specs, notifications
- [ ] Navigation links work between views (even if other views are placeholder)
- [ ] `GET /api/health` returns `{"status": "ok"}`
- [ ] Auto-refresh works via htmx polling
- [ ] All tests pass
- [ ] No diagnostics errors

**Verify:**
```bash
./dist/sentinal serve & sleep 2 && curl -s http://localhost:41778/api/health && kill %1
```

---

### Task 9: Console Dashboard — Specs, Memories, Sessions, Settings Views

**Objective:** Implement the remaining 4 dashboard views: Specifications (plan tracking), Memories (observation browser), Sessions (active/past sessions), Settings (model routing, preferences).

**Dependencies:** Task 8

**Files:**
- Create: `src/dashboard/views/specifications.ts` — Specs view with task progress, status
- Create: `src/dashboard/views/memories.ts` — Memories view with type filters, search
- Create: `src/dashboard/views/sessions.ts` — Sessions view with active/past, duration
- Create: `src/dashboard/views/settings.ts` — Settings view with model routing config
- Modify: `src/dashboard/routes/api.ts` — Add API endpoints for each view's data
- Create: `src/dashboard/views/partials/` — Shared HTML partials (tables, cards, filters)

**Key Decisions / Notes:**
- **Specifications:** Primary data source is the `plans` table in SQLite (populated by `sentinal register-plan` in Task 5). Falls back to reading plan files from `docs/plans/` for plans not in SQLite. Parsed plan metadata cached in server memory (Map with 10s TTL) to avoid repeated disk I/O on 5s polling. Shows task checkboxes, iteration count, phase (plan/implement/verify). Filterable by status.
- **Memories:** Lists observations from SQLite. Search bar uses htmx `hx-get` with query param. Type filter chips. Expandable observation detail. Pagination.
- **Sessions:** Table with session ID, project, start time, duration, status. Active sessions highlighted. Sort by recency.
- **Settings:** Form for model routing preferences (stored in SQLite settings table). Fields: planning_model, implementation_model, verification_model. Extended context toggle. Save via htmx POST.
- All views use htmx for partial page updates — no full page reloads
- API endpoints: `GET /api/specs`, `GET /api/memories?q=&type=&page=`, `GET /api/sessions`, `GET/POST /api/settings`
- Spec detail API: `GET /api/specs/:filename` returns parsed plan data

**Definition of Done:**
- [ ] All 4 views render with real data from SQLite/filesystem
- [ ] Specifications view shows plan status, task progress, iterations
- [ ] Memories view supports search and type filtering
- [ ] Sessions view shows active vs past sessions with duration
- [ ] Settings view saves and loads model routing preferences
- [ ] Navigation between all views works without full page reload
- [ ] All tests pass
- [ ] No diagnostics errors

**Verify:**
```bash
./dist/sentinal serve & sleep 2 && curl -s http://localhost:41778/api/specs && curl -s http://localhost:41778/api/memories && kill %1
```

---

### Task 10: Model Routing Configuration

**Objective:** Create a configuration system for model preferences per phase, with advisory hints injected into commands/rules.

**Dependencies:** Task 2

**Files:**
- Create: `src/config/settings.ts` — Settings manager (read/write from SQLite)
- Create: `src/config/model-routing.ts` — Model routing logic and hint generation
- Create: `src/config/settings.test.ts`
- Modify: `templates/commands/spec-plan.md` — Add model routing hint at top
- Modify: `templates/commands/spec-implement.md` — Add model routing hint
- Modify: `templates/commands/spec-verify.md` — Add model routing hint

**Key Decisions / Notes:**
- Default routing: Opus for planning, Sonnet for implementation/verification
- Settings stored in SQLite `settings` table: `model_routing` key with JSON value
- Schema: `{ planning: "opus", implementation: "sonnet", verification: "sonnet", plan_reviewer: "sonnet", spec_reviewer: "sonnet" }`
- Commands include static advisory text based on defaults: "Recommended model: Claude Opus 4.6 — switch with /model before proceeding". These are baked into templates as static text (not dynamically read from SQLite at command time). If user changes model routing via `sentinal config`, the settings view in the dashboard reflects the change, but command text stays as defaults. This is acceptable because Claude Code doesn't support forced routing — the hints are just reminders.
- `sentinal config get model_routing` / `sentinal config set model_routing.planning opus`
- No enforcement — Claude Code doesn't support forced model switching via plugins
- Regenerate commands after template changes via `node scripts/generate-commands.js`

**Definition of Done:**
- [x] Settings manager reads/writes model routing from SQLite (`MemoryStore.getSetting/setSetting/deleteSetting/listSettings` + `getModelRouting/setModelRouting/resetModelRouting`)
- [x] Default model routing set on first access (Zod defaults: opus for planning, sonnet for rest)
- [x] Command templates include model routing hints (all 10 templates — 4 Opus planning, 6 Sonnet implement/verify)
- [x] `sentinal config` subcommand works for get/set (`sentinal config list/get/set/reset` with `--json` and dot-path support)
- [x] Generated commands (both targets) include model hints (Claude Code + OpenCode, all spec-* commands)
- [x] Tests cover settings CRUD and default initialization (9 settings tests + 9 model-routing tests = 18 new tests)
- [ ] No diagnostics errors

**What was implemented:**
- `src/memory/types.ts` — `SCHEMA_VERSION` bumped from 2 to 3
- `src/memory/store.ts` — `migrateV3()` creating `settings` table, plus `getSetting/setSetting/deleteSetting/listSettings` CRUD methods
- `src/config/types.ts` — `ModelRouting` interface, `ModelRoutingSchema` (Zod), `DEFAULT_MODEL_ROUTING`, `MODEL_ROUTING_KEY`
- `src/config/model-routing.ts` — `getModelRouting()`, `setModelRouting()`, `resetModelRouting()` convenience accessors
- `src/config/model-routing.test.ts` — 9 tests
- `src/memory/store.test.ts` — 9 new settings CRUD tests
- `src/cli/commands/config.ts` — `registerConfigCommand(program)` with list/get/set/reset subcommands, `--json` flag, dot-path notation
- `src/cli/index.ts` — Registered config command
- `src/index.ts` — Barrel exports for all config types and functions
- All 10 command templates updated with model hints (both `targets/claude-code/commands/` and `targets/opencode/commands/`)
- Detailed plan: `docs/plans/2026-03-09-model-routing-config.md` (Status: COMPLETE)

**Verify:**
```bash
bun test src/config/ && ./dist/sentinal config get model_routing --json
```

---

### Task 11: Shell Integration + Auto-Updater

**Objective:** Add shell aliases for `sentinal` command and implement git-based auto-update checking on CLI launch.

**Dependencies:** Task 1

**Files:**
- Create: `src/cli/commands/update.ts` — Auto-updater (git fetch, tag compare, pull + rebuild)
- Create: `src/cli/shell-integration.ts` — Generate shell config for bash/zsh/fish
- Modify: `src/cli/commands/run.ts` — Add update check before launching Claude
- Modify: `targets/claude-code/install.sh` — Add shell integration step
- Create: `src/cli/update.test.ts`

**Key Decisions / Notes:**
- On `sentinal` / `sentinal run`: check remote tags (max once per 24h, cached in SQLite)
- Compare current version (from package.json) with latest git tag
- If newer version available: show changelog summary, prompt "Press u to update, any key to continue"
- Expected tag format: `vMAJOR.MINOR.PATCH` (e.g., `v0.2.0`). Pre-release tags (e.g., `v1.0.0-beta.1`) are excluded from comparison.
- Update check handles missing remote tags gracefully (skip check, no error)
- `sentinal update` does: `git pull origin main && bun install && bun run build:cli` (note: `bun install` runs before build to pick up new deps)
- `sentinal run --skip-update-check` bypasses the check
- Shell integration: add `alias sentinal="~/.sentinal/bin/sentinal"` to shell config
- Detect shell from `$SHELL` env var
- Support: `~/.bashrc`, `~/.zshrc`, `~/.config/fish/config.fish`
- Idempotent: check if alias already exists before adding
- Also add alias `snt` as shortcut

**Definition of Done:**
- [ ] `sentinal update` pulls latest and rebuilds
- [ ] Update check runs on `sentinal` launch (max once per 24h)
- [ ] `sentinal run --skip-update-check` works
- [ ] Shell integration adds aliases to detected shell config
- [ ] Installer runs shell integration automatically
- [ ] Tests cover: version comparison, update check caching, shell detection, missing remote tags (no error)
- [ ] No diagnostics errors

**Verify:**
```bash
./dist/sentinal update --check && ./dist/sentinal run --help
```

---

### Task 12: Installer Improvements (Curl, Rollback, DevContainer, Conditional Rules)

**Objective:** Add one-line curl installation, installer rollback on failure, dev container generation, and conditional rule activation by file glob.

**Dependencies:** Task 1, Task 11

**Files:**
- Create: `install-remote.sh` — Curl-installable script (clone + run install.sh)
- Modify: `install.sh` — Add rollback tracking (trap ERR), step progress
- Modify: `targets/claude-code/install.sh` — Add rollback, step tracking, shell integration call
- Create: `src/cli/commands/devcontainer.ts` — Generate `.devcontainer/` config
- Modify: `targets/claude-code/rules/*.md` — Add `globs:` frontmatter for conditional activation

**Key Decisions / Notes:**
- **Curl installer:** URL uses the project's actual GitHub repo (must be set before Task 12 — read from package.json `repository` field or hardcode). Script runs only via HTTPS.
  - Clones repo to `~/.sentinal/source/`, runs `install.sh`, builds CLI
  - Validates git remote matches expected origin (or prints warning if running from fork)
  - Supports `VERSION` env var for specific version
- **Rollback:** Track completed steps in array. On `trap ERR`, undo in reverse order.
  - Steps: deps install → build → marketplace → cache → registry → settings → shell
  - Each step has an undo function (rm dirs, restore JSON backups)
  - Backup JSON files before modification: `cp settings.json settings.json.bak`
- **DevContainer:** `sentinal devcontainer` generates `.devcontainer/devcontainer.json`
  - Includes: Node.js 22, Bun, required extensions, postCreateCommand for install
  - Template based on current project detection (Angular, NestJS, etc.)
- **Conditional rules:** Add `globs:` field to rule markdown frontmatter
  - e.g., `globs: "*.ts,*.tsx"` in `standards-typescript.md`
  - Claude Code supports this natively in `.claude/rules/` files
  - Only applies to target rules, not template rules

**Definition of Done:**
- [ ] `install-remote.sh` works when piped from curl
- [ ] Installer rolls back cleanly on any step failure
- [ ] `sentinal devcontainer` generates valid `.devcontainer/devcontainer.json`
- [x] Rules have conditional activation frontmatter (implemented as `paths:` frontmatter — the actual Claude Code format — in all 5 rule files under `targets/claude-code/rules/`)
- [ ] Tests cover: rollback simulation, devcontainer output validation
- [ ] No diagnostics errors

**Verify:**
```bash
./dist/sentinal devcontainer && cat .devcontainer/devcontainer.json
```

---

## Assumptions

- Bun's `bun build --compile` supports the project's dependencies (commander is pure JS, bun:sqlite is built-in — no native modules to bundle) — supported by Bun 1.0+ docs — Tasks 1, 4, 5, 8 depend on this
- `bun:sqlite` is available in compiled Bun binaries — supported by Bun docs (built-in module, ships with runtime) — Tasks 2, 3, 7 depend on this
- Claude Code's `transcript_path` in hook input is a readable file whose size correlates with token usage — supported by hook protocol docs — Task 4, 6 depend on this
- Claude Code supports `globs:` frontmatter in rule files for conditional activation — supported by Claude Code docs — Task 12 depends on this
- htmx + Tailwind CDN approach works without a build step — supported by htmx design philosophy — Tasks 8, 9 depend on this
- Git remote origin is configured (for auto-updater tag comparison) — typical for any project. Missing tags handled gracefully — Task 11 depends on this

## Testing Strategy

- **Unit tests:** All modules in `src/db/`, `src/memory/`, `src/sessions/`, `src/config/`, `src/worktree/`, `src/mcp/` have co-located `.test.ts` files
- **Integration tests:** CLI commands tested via subprocess execution (`bun run src/cli/index.ts <args>`)
- **Database tests:** Use temporary in-memory SQLite (`:memory:`) for fast, isolated tests
- **Hook tests:** Existing pattern — mock stdin JSON, assert stdout JSON
- **Dashboard tests:** API endpoint tests via fetch against test server
- **Manual verification:** Build binary, run `sentinal serve`, verify dashboard in browser

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `bun build --compile` fails with commander dependency | Low | Medium | Commander is pure JS, should bundle fine. Fallback: ship as `bun run` script. |
| Transcript file format changes across Claude Code versions | Low | Medium | Graceful degradation: if parse fails, return 0% and log warning |
| htmx CDN unavailable in air-gapped environments | Low | Low | Bundle htmx.min.js as string literal in server code (Task 8) |
| Context rescaling formula doesn't match Claude Code's actual behavior | Medium | Medium | Make compaction threshold and bytes-per-token ratio configurable via `sentinal config`. Default 83.5% threshold, 3 bytes/token. |
| Context estimation accuracy varies with content type (code vs prose) | Medium | Low | Configurable bytes-per-token ratio. Users can tune based on observed accuracy. Target: within 30 percentage points of actual. |

## Pre-Mortem

*Assume this plan failed. Most likely internal reasons:*

1. **Bun compiled binary missing bun:sqlite at runtime** (Task 1-2) → Trigger: `bun build --compile` produces binary but `import { Database } from "bun:sqlite"` throws at runtime. Adaptation: verify in Task 2 that compiled binary can open/query a database; if fails, ship as `bun run` script instead of compiled binary (still fast, just requires Bun installed).

2. **Context estimation from transcript file size is wildly inaccurate** (Task 4, 6) → Trigger: estimated % differs from Claude Code's actual usage by >20 percentage points, causing premature or missed warnings. Adaptation: add calibration — on compaction events, record actual raw % alongside estimate, build correction factor over time.

3. **MCP server protocol incompatibility** (Task 7) → Trigger: Claude Code can't discover tools from the sentinal mem-search MCP server, or tool calls fail with protocol errors. Adaptation: verify against @modelcontextprotocol/sdk examples, test with Claude Code's MCP inspector tool.

## Goal Verification

### Truths
1. Running `sentinal` from any directory launches Claude Code with the sentinal plugin active
2. The `sentinal check-context --json` command returns accurate context usage percentage
3. The console dashboard at `http://localhost:41778` shows real-time session and spec data
4. Persistent memory survives across sessions — observations saved in one session are searchable in the next
5. No references to `~/.legacy/bin/legacy` exist in any source file
6. The installer works from a fresh `curl | bash` invocation on a machine with only Node.js and Bun

### Artifacts
1. `dist/sentinal` — compiled CLI binary
2. `~/.sentinal/memory.db` — SQLite database (plan said `sentinal.db`, actual is `memory.db`)
3. `src/mcp/server.ts` — Universal MCP server entrypoint (plan said `src/mcp/memory-server.ts`)
4. `src/dashboard/server.ts` — Dashboard HTTP server (not yet implemented)
5. `src/cli/commands/` — All CLI commands
6. `install-remote.sh` — Curl-installable script (not yet implemented)

### Key Links
1. CLI binary → SQLite database (all commands read/write)
2. Hooks → CLI binary (hooks shell out to `sentinal` commands)
3. MCP server → SQLite database (shared memory store)
4. Dashboard → SQLite database (reads for display)
5. Installer → CLI build pipeline (builds binary, sets up aliases)

## Open Questions

*None — all resolved during planning:*
- Dashboard lifecycle: Auto-start as background process from `sentinal run`, managed via PID file at `~/.sentinal/server.pid`. Killed by SessionEnd hook when last session ends. Duplicate start detection prevents port conflicts.

## Deferred Ideas

- **Usage tracking / token cost analytics** — Requires API key integration or parsing Claude Code billing. Separate spec.
- **Team asset sharing (sx equivalent)** — Complex multi-user system. Separate spec.
- **WebSocket real-time updates** — htmx polling (5s) is sufficient for MVP. Upgrade to WebSocket later if needed.
