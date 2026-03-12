# MCP Spec Workflow Tools Implementation Plan

Created: 2026-03-12
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Summary
**Goal:** Add ~10 new MCP tools to the sentinal MCP server that eliminate Bash shell-outs during the spec workflow, add missing worktree CLI subcommands (`detect`, `create`, `sync`), and update all skill/command files to reference the new MCP tools instead of Bash invocations.

**Architecture:** New tools are registered in `src/spec/mcp-tools.ts` (spec tools) and a new `src/worktree/mcp-tools.ts` (worktree tools). The worktree domain is moved from `src/git/worktree-*.ts` to `src/worktree/` for clean separation. Both MCP modules receive the shared `MemoryStore` from the MCP server and construct their domain stores internally. Missing CLI subcommands are added to `src/cli/commands/worktree.ts` using a slug-resolution helper. All `SENTINAL_*` env vars are renamed to `SENTINAL_*` across all skill/command files. All 10+ skill/command files are updated to document MCP tool equivalents alongside the existing Bash patterns.

**Tech Stack:** TypeScript, Bun, `@modelcontextprotocol/sdk`, Zod, `bun:sqlite`, `node:fs` (for file watching)

## Scope
### In Scope
- 6 new spec MCP tools: `spec_register`, `spec_wait_file`, `spec_config`, `spec_plan_parse`, `spec_notify`, `spec_events`
- 4 new worktree MCP tools: `worktree_detect`, `worktree_create`, `worktree_diff`, `worktree_sync`
- 3 missing CLI subcommands: `worktree detect`, `worktree create`, `worktree sync`
- Slug-resolution helper for worktree commands (plan slug → worktree ID)
- Move worktree domain from `src/git/worktree-*.ts` to `src/worktree/` (manager.ts, store.ts, types.ts, mcp-tools.ts)
- Rename all `SENTINAL_*` env vars to `SENTINAL_*` across 16 target `.md` files
- Update all 10+ skill/command `.md` files to document MCP tool usage
- Unit tests for all new tools and CLI subcommands
- Build + update cycle to propagate changes

### Out of Scope
- Removing existing Bash patterns from skills (skills keep both MCP and Bash as fallback)
- Sidecar-mode delegation for new tools (direct `MemoryStore` only, matching existing `spec_status` pattern)
- Template-based skill/command deduplication (separate effort)
- `worktree cleanup` targeted-by-slug variant (the `cd` requirement makes this inherently Bash)
- `spec_get_project_slug` tool (only 2 call sites, low impact)

## Context for Implementer
> Write for an implementer who has never seen the codebase.

- **Patterns to follow:**
  - MCP tool registration: `src/spec/mcp-tools.ts:24-68` — `server.tool(name, description, zodSchema, asyncHandler)` pattern. Handler returns `{ content: [{ type: "text", text: string }] }`.
  - Store construction: `src/spec/mcp-tools.ts:16-20` — `registerSpecTools(server, store)` creates `SpecStore` from `MemoryStore`, then registers individual tools.
  - CLI subcommand: `src/cli/commands/worktree.ts:45-78` — commander `.command().description().argument().option().action()` pattern.
  - Error handling in CLI: `src/cli/commands/worktree.ts:28-36` — `handleError()` with JSON fallback.
  - WorktreeStore lookup by slug: `src/worktree/store.ts:59-65` — `getBySpecId(specId)` finds active worktree by spec ID (which matches the plan slug from `slugFromFilename()`).

- **Conventions:**
  - MCP tool names: `spec_*` prefix for spec tools, `worktree_*` prefix for worktree tools (worktrees are generic, not spec-specific)
  - All MCP tools return text-only: `{ content: [{ type: "text", text: ... }] }` — format as markdown for readability
  - Zod schemas for parameters: `z.string().describe("...")`, `z.number().optional().describe("...")`
  - CLI output: plain text by default, `--json` flag for structured output
  - CLI slug resolution: all worktree subcommands that accept `<slug>` resolve via `getBySpecId()` to find the worktree ID

- **Key files:**
  - `src/mcp/server.ts` (81 lines) — MCP server factory, wires tool modules. Must add new `registerWorktreeTools()` call.
  - `src/spec/mcp-tools.ts` (69 lines) — Currently only `spec_status`. Will grow to ~250 lines with 6 new tools.
  - `src/spec/store.ts` — `SpecStore` with `syncFromPlanFile()`, `getCurrentSpec()`, `getSpec()`, etc.
  - `src/spec/parser.ts` — `parsePlanFile()`, `parsePlanContent()`, `slugFromFilename()`
  - `src/memory/store.ts` — `MemoryStore` with notification CRUD (`insertNotification`, `getNotifications`), settings, spec events (`logSpecEvent`, `getSpecEvents`)
  - `src/worktree/manager.ts` (313 lines) — `WorktreeManager` with `create()`, `list()`, `status()`, `diff()`, `squashMerge()`, `abandon()`, `cleanup()`
  - `src/worktree/store.ts` (145 lines) — `WorktreeStore` with `getBySpecId()` (the slug→worktree resolver)
  - `src/cli/commands/worktree.ts` (211 lines) — CLI subcommands. Missing: `detect`, `create`, `sync`.
  - `src/cli/commands/register-plan.ts` (72 lines) — CLI `register-plan` command (takes `<path>` only, status arg silently ignored)

- **Gotchas:**
  - `register-plan` CLI takes only `<path>` as positional arg. The second `"PENDING"` argument in skill invocations is silently ignored by Commander. The `spec_register` MCP tool should accept an explicit `status` parameter and update the plan file's `Status:` line before syncing, so it's authoritative.
  - `WorktreeManager.create()` takes `specId` (which is the plan slug from `slugFromFilename`), NOT a worktree ID. Other methods (`diff`, `squashMerge`, `abandon`) take worktree IDs. The slug→ID resolution layer must use `WorktreeStore.getBySpecId()`.
  - The `embedded-assets.ts` file is auto-generated by `bun run build:cli`. Skill/command file changes only propagate after a build.
  - `fs.watch()` on macOS uses FSEvents which is reliable for file creation but may not fire for writes to existing files. Use `fs.watchFile()` as fallback for polling.
  - MCP tools run in the MCP server process, which persists across tool calls. The `MemoryStore` stays open — no per-call overhead.
  - Worktree `create` involves git operations (`git worktree add`, `git checkout -b`) that can take seconds. The MCP tool must be async.
  - The `spec_config` tool reads `SENTINAL_*` environment variables from the MCP server's process environment. These are renamed from the old `SENTINAL_*` prefix. The env vars are set by OpenCode/Claude Code console settings before launching the MCP server.

- **Domain context:**
  - The spec workflow has 4 phases: plan → implement → verify → (loop or done). Each phase invokes sentinal CLI commands via Bash for plan registration, worktree management, and notification.
  - Skills (OpenCode) and commands (Claude Code) are nearly identical `.md` files that instruct the agent. Both need updating.
  - "MCP tool" = a function exposed via the Model Context Protocol that the agent can call directly, without spawning a subprocess.

## Assumptions
- `WorktreeStore.getBySpecId(specId)` correctly resolves a plan slug to the active worktree — supported by: `src/worktree/store.ts:60-65` uses `spec_id` column matching — Tasks 5-8 depend on this
- `SENTINAL_*` environment variables are available in the MCP server process environment — supported by: OpenCode/Claude Code set env vars before launching MCP servers — Task 3 depends on this
- `fs.watch()` on macOS fires reliably for new file creation — supported by: macOS FSEvents is robust for file creation events — Task 2 depends on this (with poll fallback)
- `parsePlanFile()` can be called from MCP tools without disk I/O issues — supported by: it uses synchronous `readFileSync` which is fine in async MCP handlers — Task 4 depends on this
- The skill `.md` files are instructions for agents, not executable code — updating them to reference MCP tools is documentation only, not a code change — Task 10 depends on this

## Testing Strategy
- Unit tests for each MCP tool handler (mock stores, verify return format)
- Unit tests for new CLI subcommands (mock manager, verify output)
- Unit tests for slug resolution helper
- Unit tests for `spec_wait_file` with temp files (create file during wait, verify detection)
- Integration: build + `sentinal update` + verify tools appear in MCP server

## Risks and Mitigations
| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `fs.watch()` doesn't fire on some OS/filesystem combos | Low | Medium | Poll fallback at 2s interval. Tool returns either way. |
| MCP tool count bloat confuses agents | Low | Low | All tools are `spec_*` prefixed and have clear descriptions |
| WorktreeManager git operations slow in MCP context | Medium | Low | These are inherently slow (git ops). MCP eliminates process spawn overhead only. |
| Skill file updates cause agent behavior regression | Low | Medium | Skills keep Bash as fallback; MCP is documented as preferred alternative |
| `spec_register` status override could desync plan file and SQLite | Medium | Medium | Tool writes status to plan file first, then syncs — file is always authoritative |

## Pre-Mortem
*Assume this plan failed. Most likely internal reasons:*
1. **`spec_wait_file` fs.watch() never fires and poll fallback timeout is too aggressive** (Task 2) → Trigger: reviewer output file exists on disk but tool returns timeout. Fix: increase poll frequency, add stat-based detection alongside watch.
2. **Slug resolution returns null for plans created before worktree system existed** (Task 5) → Trigger: `worktree_detect` returns "not found" for a plan that has a worktree. Fix: fall back to listing all worktrees and matching by branch name pattern `spec/<slug>*`.
3. **`spec_register` writes status to plan file but `syncFromPlanFile` re-parses and overwrites with old status** (Task 1) → Trigger: plan status in SQLite doesn't match what was passed. Fix: write status to file first, then sync reads the updated file.

## Goal Verification
### Truths
1. Calling `spec_register` MCP tool registers a plan and updates its status without spawning a subprocess
2. Calling `spec_wait_file` blocks until a file appears, returning in a single tool call instead of 30-100 poll iterations
3. Calling `spec_config` returns all toggle env vars in one MCP call
4. Calling `worktree_detect` with a plan slug returns the worktree info or null
5. Calling `worktree_create` with a plan slug creates a worktree and returns `{path, branch, baseBranch}`
6. Running `sentinal worktree detect <slug>` from CLI works (not a phantom command)
7. Running `sentinal worktree create <slug>` from CLI works (not a phantom command)
8. All 10 skill/command files reference the new MCP tools as the preferred invocation method

### Artifacts
- Modified: `src/mcp/server.ts`, `src/spec/mcp-tools.ts`
- Created: `src/worktree/` directory with `manager.ts`, `store.ts`, `types.ts`, `mcp-tools.ts`
- Removed: `src/git/worktree-manager.ts`, `src/git/worktree-store.ts` (moved to `src/worktree/`)
- Modified: `src/cli/commands/worktree.ts`
- Modified: 16+ target `.md` files (`SENTINAL_*` → `SENTINAL_*` rename + MCP tool references)
- Created: `src/spec/mcp-tools.test.ts`, `src/worktree/mcp-tools.test.ts`
- Modified: `src/cli/embedded-assets.ts` (auto-generated after build)

### Key Links
1. `src/mcp/server.ts` → imports `registerSpecTools` + `registerWorktreeTools` → registers all MCP tools
2. `src/spec/mcp-tools.ts` → `SpecStore` + `MemoryStore` → `spec_register`, `spec_config`, `spec_plan_parse`, `spec_notify`, `spec_events`, `spec_wait_file`
3. `src/worktree/mcp-tools.ts` → `WorktreeManager` + `WorktreeStore` → `worktree_detect`, `worktree_create`, `worktree_diff`, `worktree_sync`
4. `src/cli/commands/worktree.ts` → imports from `src/worktree/` → `detect`, `create`, `sync` subcommands
5. Skills/commands → `SENTINAL_*` env vars (renamed from `SENTINAL_*`) → reference MCP tools as preferred, Bash as fallback

## Progress Tracking
- [x] Task 1: Add `spec_register` MCP tool
- [x] Task 2: Add `spec_wait_file` MCP tool
- [x] Task 3: Add `spec_config` MCP tool
- [x] Task 4: Add `spec_plan_parse`, `spec_notify`, `spec_events` MCP tools
- [x] Task 5: Move worktree domain from `src/git/` to `src/worktree/`
- [x] Task 6: Add slug resolution helper to worktree system
- [x] Task 7: Add `worktree_detect` and `worktree_create` MCP tools
- [x] Task 8: Add `worktree_diff` and `worktree_sync` MCP tools
- [x] Task 9: Add missing CLI subcommands (`detect`, `create`, `sync`)
- [x] Task 10: Wire new tool modules into MCP server
- [x] Task 11: Rename `SENTINAL_*` → `SENTINAL_*` env vars + update skill/command files to reference MCP tools
- [x] Task 12: Build, update, and verify
**Total Tasks:** 12 | **Completed:** 12 | **Remaining:** 0

## Implementation Tasks

### Task 1: Add `spec_register` MCP tool

**Objective:** Create an MCP tool that registers/updates a plan in SQLite, replacing `sentinal register-plan` Bash calls.

**Dependencies:** None

**Files:**
- Modify: `src/spec/mcp-tools.ts`
- Test: `src/spec/mcp-tools.test.ts`

**Key Decisions / Notes:**
- Add `registerSpecRegisterTool(server, specStore, memoryStore)` function
- Parameters: `plan_path` (string, required), `project` (string, optional — defaults to CWD), `status` (string, optional — if provided, update the plan file's `Status:` line before syncing)
- Status update logic: if `status` is provided, read plan file → regex replace `Status: <old>` with `Status: <new>` → write back → then call `specStore.syncFromPlanFile()`. This ensures the file (source of truth) is authoritative.
- Follow existing `registerSpecStatusTool` pattern at `src/spec/mcp-tools.ts:24-68`
- Return formatted text: `Registered: <id> (<status>, <done>/<total> tasks)`
- Call `registerSpecRegisterTool(server, specStore, effectiveStore)` inside `registerSpecTools()`

**Definition of Done:**
- [ ] MCP tool `spec_register` is callable with `plan_path` and optional `status`
- [ ] When `status` is provided, the plan file's `Status:` line is updated before sync
- [ ] SQLite spec record matches the plan file after sync
- [ ] Returns formatted status text
- [ ] Unit test: register a plan file, verify return text
- [ ] Unit test: register with status override, verify file is updated

**Verify:**
- `bun test src/spec/mcp-tools.test.ts`

### Task 2: Add `spec_wait_file` MCP tool

**Objective:** Create an MCP tool that waits for a file to appear on disk, replacing the polling loops that burn 30-100 bash calls.

**Dependencies:** None

**Files:**
- Modify: `src/spec/mcp-tools.ts`
- Test: `src/spec/mcp-tools.test.ts`

**Key Decisions / Notes:**
- Add `registerSpecWaitFileTool(server)` function (no store dependency — pure filesystem)
- Parameters: `file_path` (string, required), `timeout_seconds` (number, optional, default 300)
- Implementation:
  1. If file already exists → return immediately with `"READY: <file_path>"`
  2. Set up `fs.watch()` on the parent directory, watching for the target filename
  3. Set up a poll fallback: `setInterval()` every 2 seconds checking `existsSync()`
  4. Set up a timeout: `setTimeout()` at `timeout_seconds * 1000`
  5. Return a Promise that resolves on first detection or rejects on timeout
  6. Clean up all watchers/intervals/timeouts in finally block
- Return `"READY: <file_path>"` on success, `"TIMEOUT: <file_path> not found after <N>s"` on timeout
- Use `fs.watch(dirname, ...)` not `fs.watchFile()` — watch the directory for new file creation
- The watcher callback checks if the created file matches `basename(file_path)`

**Definition of Done:**
- [ ] MCP tool `spec_wait_file` blocks until file appears or timeout
- [ ] Returns immediately if file already exists
- [ ] Falls back to polling if `fs.watch()` fails
- [ ] Cleans up watchers on completion
- [ ] Unit test: file already exists → immediate return
- [ ] Unit test: file created after 1s → detected within 3s
- [ ] Unit test: timeout scenario → returns TIMEOUT message

**Verify:**
- `bun test src/spec/mcp-tools.test.ts`

### Task 3: Add `spec_config` MCP tool

**Objective:** Create an MCP tool that returns all spec workflow toggle configuration in one call, replacing `echo $SENTINAL_*` Bash invocations.

**Dependencies:** None

**Files:**
- Modify: `src/spec/mcp-tools.ts`
- Test: `src/spec/mcp-tools.test.ts`

**Key Decisions / Notes:**
- Add `registerSpecConfigTool(server)` function (no store dependency — reads env vars)
- Parameters: none (or optional `key` to get a specific toggle)
- Read from `process.env`:
  - `SENTINAL_PLAN_QUESTIONS_ENABLED` → `questions_enabled`
  - `SENTINAL_PLAN_REVIEWER_ENABLED` → `plan_reviewer_enabled`
  - `SENTINAL_PLAN_APPROVAL_ENABLED` → `approval_enabled`
  - `SENTINAL_SPEC_REVIEWER_ENABLED` → `spec_reviewer_enabled`
  - `SENTINAL_WORKTREE_ENABLED` → `worktree_enabled`
  - `SENTINAL_SESSION_ID` → `session_id`
- Return formatted text block with all values (or "unset" for undefined)
- Empty string and undefined both mean "enabled" (default-on)

**Definition of Done:**
- [ ] MCP tool `spec_config` returns all toggle values
- [ ] Unset env vars are reported as "unset (default: enabled)"
- [ ] `"false"` values are reported as "disabled"
- [ ] Unit test: with env vars set → correct output
- [ ] Unit test: with no env vars → all defaults

**Verify:**
- `bun test src/spec/mcp-tools.test.ts`

### Task 4: Add `spec_plan_parse`, `spec_notify`, `spec_events` MCP tools

**Objective:** Add three smaller MCP tools that provide plan metadata, notification support, and TDD event history.

**Dependencies:** None

**Files:**
- Modify: `src/spec/mcp-tools.ts`
- Test: `src/spec/mcp-tools.test.ts`

**Key Decisions / Notes:**

**`spec_plan_parse`:**
- Parameters: `plan_path` (string, required)
- Calls `parsePlanFile(plan_path)` from `src/spec/parser.ts`
- Returns formatted text with: id, title, status, type, approved, task count, task list, metadata (iterations, worktree)
- Also returns derived info: slug (from `slugFromFilename`), plan-review output path (`${path%.md}.plan-review.json`), spec-review output path (`${path%.md}.spec-review.json`)

**`spec_notify`:**
- Parameters: `type` (enum: info/warning/error/success), `title` (string), `message` (string, optional), `spec_id` (string, optional)
- Calls `memoryStore.insertNotification({ type, title, message, specId })`
- Returns: `"Notification created: <title>"`

**`spec_events`:**
- Parameters: `spec_id` (string, required), `limit` (number, optional, default 20)
- Calls `memoryStore.getSpecEvents(spec_id, limit)`
- Returns formatted list of events with timestamps, types, and details

**Definition of Done:**
- [ ] `spec_plan_parse` returns structured plan metadata including derived paths
- [ ] `spec_notify` creates a notification in SQLite
- [ ] `spec_events` returns event history for a spec
- [ ] Unit test for each tool

**Verify:**
- `bun test src/spec/mcp-tools.test.ts`

### Task 5: Move worktree domain from `src/git/` to `src/worktree/`

**Objective:** Relocate worktree files from `src/git/` to a dedicated `src/worktree/` directory and update all imports throughout the codebase.

**Dependencies:** None

**Files:**
- Move: `src/git/worktree-manager.ts` → `src/worktree/manager.ts`
- Move: `src/git/worktree-store.ts` → `src/worktree/store.ts`
- Move: `src/git/types.ts` → `src/worktree/types.ts` (if worktree-specific; or keep shared types in `src/git/`)
- Move: `src/git/utils.ts` → stays in `src/git/` (shared git utilities used by worktree manager)
- Update imports in: `src/cli/commands/worktree.ts`, `src/mcp/server.ts`, any other files importing from `src/git/worktree-*`

**Key Decisions / Notes:**
- The `src/git/` directory may still contain shared git utilities (`utils.ts`, `types.ts`) used by the worktree manager. Only move worktree-specific files.
- Check for `src/git/types.ts` — if it contains both worktree types and general git types, extract worktree types into `src/worktree/types.ts` and leave git types in place.
- Run `rg 'from.*git/worktree' src/` to find all import paths that need updating
- The rename is `worktree-manager.ts` → `manager.ts`, `worktree-store.ts` → `store.ts` (drop the `worktree-` prefix since the directory provides namespace)

**Definition of Done:**
- [ ] `src/worktree/` directory exists with `manager.ts`, `store.ts`, `types.ts`
- [ ] All imports updated (`src/git/worktree-*` → `src/worktree/*`)
- [ ] `src/git/worktree-*.ts` files removed
- [ ] No TypeScript errors
- [ ] All existing tests pass

**Verify:**
- `npx tsc --noEmit`
- `bun test`

### Task 6: Add slug resolution helper to worktree system

**Objective:** Add a `resolveBySlug(slug, projectPath)` method to `WorktreeStore` or a standalone helper that resolves a plan slug to a worktree, bridging the gap between skills (which use slugs) and the manager (which uses worktree IDs).

**Dependencies:** Task 5 (worktree move)

**Files:**
- Modify: `src/worktree/store.ts`
- Test: `src/worktree/store.test.ts` (create if needed, or add to existing)

**Key Decisions / Notes:**
- The `getBySpecId(specId)` method already does slug→worktree resolution (plan slug = spec ID)
- Add a public convenience method `resolveBySlug(slug: string, projectPath?: string): Worktree | null` that:
  1. Calls `getBySpecId(slug)` first (exact match on `spec_id`)
  2. If not found and `projectPath` is provided, fall back to listing active worktrees for the project and matching by branch name pattern `spec/<slug>*`
- This handles edge cases where the `spec_id` wasn't set at creation time
- Export this method for use by both CLI and MCP tools

**Definition of Done:**
- [ ] `resolveBySlug()` method exists on `WorktreeStore`
- [ ] Returns worktree when slug matches `spec_id`
- [ ] Falls back to branch name pattern matching
- [ ] Returns null when no match
- [ ] Unit test: exact match by spec_id
- [ ] Unit test: branch name fallback
- [ ] Unit test: no match returns null

**Verify:**
- `bun test src/worktree/store.test.ts`

### Task 7: Add `worktree_detect` and `worktree_create` MCP tools

**Objective:** Create MCP tools for detecting and creating worktrees by plan slug.

**Dependencies:** Task 5 (worktree move), Task 6 (slug resolution)

**Files:**
- Create: `src/worktree/mcp-tools.ts`
- Test: `src/worktree/mcp-tools.test.ts`

**Key Decisions / Notes:**

**`worktree_detect`:**
- Parameters: `plan_slug` (string, required), `project` (string, optional, default CWD)
- Uses `worktreeStore.resolveBySlug(plan_slug, project)`
- If found: return formatted text with `path`, `branch`, `baseBranch`, `status`
- If not found: return `"No active worktree found for slug: <slug>"`

**`worktree_create`:**
- Parameters: `plan_slug` (string, required), `project` (string, optional, default CWD), `base_branch` (string, optional)
- Calls `worktreeManager.create(plan_slug, project, base_branch)`
- Returns formatted text with `path`, `branch` (`branchName`), `baseBranch`

**Registration pattern:**
- Create `registerWorktreeTools(server: McpServer, store: MemoryStore | null)` in new file
- Internally create `WorktreeStore`, `WorktreeManager` from the store
- Register individual tools

**Definition of Done:**
- [ ] `worktree_detect` returns worktree info or "not found"
- [ ] `worktree_create` creates a worktree and returns info
- [ ] Both handle errors gracefully (return error text, not throw)
- [ ] Unit tests for both tools

**Verify:**
- `bun test src/worktree/mcp-tools.test.ts`

### Task 8: Add `worktree_diff` and `worktree_sync` MCP tools

**Objective:** Create MCP tools for diffing and syncing (squash-merge) worktrees by plan slug.

**Dependencies:** Task 6 (slug resolution), Task 7 (worktree MCP module structure)

**Files:**
- Modify: `src/worktree/mcp-tools.ts`
- Test: `src/worktree/mcp-tools.test.ts`

**Key Decisions / Notes:**

**`worktree_diff`:**
- Parameters: `plan_slug` (string, required), `project` (string, optional)
- Resolve slug → worktree ID via `resolveBySlug()`
- Call `worktreeManager.diff(worktreeId)`
- Return formatted diff summary (files changed, insertions, deletions)

**`worktree_sync`:**
- Parameters: `plan_slug` (string, required), `project` (string, optional), `message` (string, optional)
- Resolve slug → worktree ID
- **Check `worktreeManager.hasConflicts(worktreeId)` first** — if conflicts, return error text without merging (mirrors CLI `merge` command at `worktree.ts:144-153`)
- Call `worktreeManager.squashMerge(worktreeId, message)`
- Return: `"Merged: <commit_hash> (branch: <branch>, base: <baseBranch>)"`
- Note: this is destructive (removes worktree after merge). The tool description should make this clear.

**Definition of Done:**
- [ ] `worktree_diff` returns formatted diff summary
- [ ] `worktree_sync` checks `hasConflicts()` before merging and returns error if conflicts exist
- [ ] `worktree_sync` squash-merges and returns commit hash
- [ ] Both resolve slugs correctly
- [ ] Both handle "not found" gracefully
- [ ] Unit tests for both tools

**Verify:**
- `bun test src/worktree/mcp-tools.test.ts`

### Task 9: Add missing CLI subcommands (`detect`, `create`, `sync`)

**Objective:** Add the three missing worktree CLI subcommands that skills currently reference as phantom commands.

**Dependencies:** Task 5 (worktree move), Task 6 (slug resolution)

**Files:**
- Modify: `src/cli/commands/worktree.ts`

**Key Decisions / Notes:**

**`sentinal worktree detect <slug> [--project <path>] [--json]`:**
- Uses `worktreeStore.resolveBySlug(slug, projectPath)`
- JSON output: `{ "path": "...", "branch": "...", "baseBranch": "...", "status": "..." }` or `{ "found": false }`
- Plain output: `Worktree found: <path> (branch: <branch>)` or `No worktree found for: <slug>`

**`sentinal worktree create <slug> [--project <path>] [--base <branch>] [--json]`:**
- Calls `manager.create(slug, projectPath, baseBranch)`
- JSON output: `{ "path": "...", "branch": "...", "baseBranch": "..." }`
- Plain output: `Created worktree: <path> (branch: <branch>)`

**`sentinal worktree sync <slug> [-m <message>] [--json]`:**
- Resolves slug → worktree ID
- Calls `manager.squashMerge(worktreeId, message)`
- JSON output: `{ "commit": "...", "branch": "...", "baseBranch": "..." }`
- Plain output: `Merged: <commit> (branch: <branch> → <baseBranch>)`

- Update the command description to include the new subcommands
- Add a shared `resolveSlug(slug, projectPath, store)` helper at the top of the file

**Definition of Done:**
- [ ] `sentinal worktree detect <slug> --json` works
- [ ] `sentinal worktree create <slug> --json` works
- [ ] `sentinal worktree sync <slug> --json` works
- [ ] All three have plain text and JSON output modes
- [ ] Unit tests for detect, create, sync with mocked manager
- [ ] No TypeScript errors

**Verify:**
- `bun test src/cli/commands/worktree.test.ts`
- `npx tsc --noEmit`

### Task 10: Wire new tool modules into MCP server

**Objective:** Import and register the new tool modules in the MCP server factory.

**Dependencies:** Tasks 1-4 (spec tools), Tasks 7-8 (worktree tools)

**Files:**
- Modify: `src/mcp/server.ts`

**Key Decisions / Notes:**
- Import `registerWorktreeTools` from `../worktree/mcp-tools.js`
- Add call: `registerWorktreeTools(server, store)` after existing `registerSpecTools()` call
- The spec tools (Tasks 1-4) are already registered inside `registerSpecTools()` — no additional wiring needed for those
- Bump server version from `"0.2.0"` to `"0.3.0"`

**Definition of Done:**
- [ ] `src/mcp/server.ts` imports and calls `registerWorktreeTools`
- [ ] Server version bumped
- [ ] No TypeScript errors
- [ ] MCP server starts and lists all tools

**Verify:**
- `npx tsc --noEmit`

### Task 11: Rename `SENTINAL_*` → `SENTINAL_*` env vars + update skill/command files to reference MCP tools

**Objective:** Rename all `SENTINAL_*` environment variable references to `SENTINAL_*` across all target files, and add MCP tool references so agents know to use MCP tools instead of Bash.

**Dependencies:** Tasks 1-10

**Files:**
- Modify: `targets/opencode/skills/spec-plan/SKILL.md`
- Modify: `targets/opencode/skills/spec-implement/SKILL.md`
- Modify: `targets/opencode/skills/spec-verify/SKILL.md`
- Modify: `targets/opencode/skills/spec-bugfix-plan/SKILL.md`
- Modify: `targets/opencode/skills/spec-bugfix-verify/SKILL.md`
- Modify: `targets/claude-code/commands/spec-plan.md`
- Modify: `targets/claude-code/commands/spec-implement.md`
- Modify: `targets/claude-code/commands/spec-verify.md`
- Modify: `targets/claude-code/commands/spec-bugfix-plan.md`
- Modify: `targets/claude-code/commands/spec-bugfix-verify.md`

**Key Decisions / Notes:**

**Env var rename (`SENTINAL_*` → `SENTINAL_*`):**
- Bulk find-replace across 16 target `.md` files (skills, commands, rules)
- Mapping: `SENTINAL_PLAN_QUESTIONS_ENABLED` → `SENTINAL_PLAN_QUESTIONS_ENABLED`, `SENTINAL_PLAN_REVIEWER_ENABLED` → `SENTINAL_PLAN_REVIEWER_ENABLED`, `SENTINAL_PLAN_APPROVAL_ENABLED` → `SENTINAL_PLAN_APPROVAL_ENABLED`, `SENTINAL_SPEC_REVIEWER_ENABLED` → `SENTINAL_SPEC_REVIEWER_ENABLED`, `SENTINAL_WORKTREE_ENABLED` → `SENTINAL_WORKTREE_ENABLED`, `SENTINAL_SESSION_ID` → `SENTINAL_SESSION_ID`
- Also update `targets/opencode/commands/spec.md` (OpenCode dispatcher) which references these
- No TypeScript source code reads these env vars directly — only the `.md` target files and the auto-generated `embedded-assets.ts` (rebuilt from targets)

**MCP tool references:**
- For each Bash invocation pattern, add a **"Preferred: MCP"** note above or below:
  ```markdown
  **Preferred:** Use `spec_register` MCP tool with `plan_path` and `status` parameters.
  **Fallback:** `sentinal register-plan "<plan_path>" 2>/dev/null || true`
  ```
- Update Step 0 in all files to note:
  ```markdown
  **Preferred:** Use `spec_config` MCP tool (returns all toggles in one call).
  **Fallback:** `echo "QUESTIONS=$SENTINAL_PLAN_QUESTIONS_ENABLED ..."`
  ```
- Update polling loops to note:
  ```markdown
  **Preferred:** Use `spec_wait_file` MCP tool with `file_path` and `timeout_seconds`.
  **Fallback:** `for i in $(seq 1 50); do [ -f "$OUTPUT_PATH" ] && ...`
  ```
- Update worktree sections to reference `worktree_detect`, `worktree_create`, etc.
- Keep existing Bash patterns as fallback — don't remove them
- Also update `targets/claude-code/commands/spec.md` (the dispatcher) and `targets/opencode/rules/cli-tools.md` + `targets/claude-code/rules/cli-tools.md` to list the new MCP tools

**Definition of Done:**
- [ ] All `SENTINAL_*` references renamed to `SENTINAL_*` across 16+ target files
- [ ] Zero `SENTINAL_` references remain in `targets/` (verify with `rg 'SENTINAL_' targets/`)
- [ ] All 10 skill/command files have MCP tool references
- [ ] `targets/claude-code/commands/spec.md` dispatcher updated
- [ ] `targets/opencode/commands/spec.md` dispatcher updated (if exists)
- [ ] `targets/opencode/rules/cli-tools.md` updated with new MCP tool list
- [ ] `targets/claude-code/rules/cli-tools.md` updated with new MCP tool list
- [ ] Bash patterns preserved as fallback
- [ ] No broken markdown

**Verify:**
- Visual inspection of all files

### Task 12: Build, update, and verify

**Objective:** Build the CLI, propagate changes, and verify everything works end-to-end.

**Dependencies:** Tasks 1-11

**Files:**
- Auto-generated: `src/cli/embedded-assets.ts`

**Key Decisions / Notes:**
- `bun run build:cli` — regenerates `embedded-assets.ts` from target files, compiles binary
- `codesign -f -s - ~/.sentinal/bin/sentinal` — re-sign the binary (macOS)
- `sentinal update` — propagate skill/command/rule changes to local installations
- Verify: start MCP server manually and list tools, or check `bun test` passes

**Definition of Done:**
- [ ] Build succeeds with zero errors
- [ ] Binary deployed and codesigned
- [ ] `sentinal update` propagates changes
- [ ] All tests pass
- [ ] `npx tsc --noEmit` clean

**Verify:**
- `bun run build:cli`
- `bun test`
- `npx tsc --noEmit`
