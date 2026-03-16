# Project Context & Pre-Edit Guidance Implementation Plan

Created: 2026-03-16
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Summary

**Goal:** Give LLMs structured project understanding via a `project_context` MCP tool backed by a sidecar-cached analysis, and inject file-specific memory + conventions as pre-edit guidance before Write/Edit/MultiEdit when relevant observations exist for the target file.

**Architecture:** Two independent features: (1) A `project_context` MCP tool that calls a new sidecar `/project-context` endpoint. The endpoint analyzes package.json, tsconfig, directory structure, and existing sync-generated rule files, caches the result in memory for the session. The MCP tool returns structured markdown. (2) A pre-edit guidance hook (`pre-edit-guide`) registered as a PreToolUse hook for Write/Edit/MultiEdit on Claude Code and in `tool.execute.before` on OpenCode. It queries the sidecar for file-specific observations and relevant project conventions, injecting them as a hint. Fires only when observations exist for the target file (silent otherwise).

**Tech Stack:** Bun, SQLite (via MemoryStore), sidecar HTTP routes, MCP SDK, Zod

## Scope

### In Scope

- `project_context` MCP tool returning structured project summary
- Sidecar `/project-context` endpoint with in-memory caching
- Live analysis: package.json, tsconfig.json, directory tree, framework detection
- Integration with existing sync-generated rule files (`.claude/rules/*-project.md`, `.opencode/rules/*-project.md`)
- Pre-edit guidance hook injecting file-specific memory observations
- Claude Code PreToolUse hook + OpenCode `tool.execute.before` integration
- Observation-gated triggering (silent when no relevant observations)

### Out of Scope

- Automatic project context generation on first session (future `/sync` enhancement)
- Real-time file watching for context invalidation (cache cleared per-session is sufficient)
- Changing existing `/sync` command behavior or output format

## Context for Implementer

> Write for an implementer who has never seen the codebase.

- **Patterns to follow:**
  - MCP tool registration: `src/analysis/mcp-tools.ts:46-55` — `registerAnalysisTools(server, deps)` pattern with sidecar-first, direct-fallback
  - Sidecar route: `src/sidecar/routes.ts:39-139` — router function dispatches by path+method to handler functions
  - Sidecar client method: `src/sidecar/client.ts:240-248` — `restoreContext()` shows GET with query params
  - PreToolUse hook: `src/hooks/tdd-guard.ts:43-74` — `processTddGuard()` returns `DenyOutput | null`, main reads stdin and outputs JSON
  - PostToolUse hint hook: `src/hooks/file-checker.ts:25-112` — returns `string | null`, uses `hint("PostToolUse", result)`
  - Hook registration: `src/cli/commands/hook.ts:354-370` — SHARED_HOOKS and CLAUDE_HOOKS maps
  - hooks.json config: `src/cli/embedded-assets.ts:5738-5757` — PreToolUse array with matcher + command
  - OpenCode `tool.execute.before`: `targets/opencode/plugins/sentinal.ts:258-288` — async handler, TDD guard and tool redirect

- **Conventions:**
  - Hooks output JSON via `output()` from `src/utils/hook-output.ts`
  - PreToolUse hooks can `deny()` (blocks tool) or `hint()` (injects context without blocking)
  - Sidecar routes return `ok(data)` or `fail(message, status)`
  - MCP tools return `{ content: [{ type: "text", text: "..." }] }`
  - File lengths: warn at 400, block at 600 (test files exempt)

- **Key files:**
  - `src/mcp/server.ts` (162 lines) — `createSentinalServer()` registers all MCP tool modules
  - `src/sidecar/routes.ts` (399 lines) — Sidecar route handler dispatch. NEAR 400-line limit.
  - `src/sidecar/client.ts` (346 lines) — Sidecar client with methods for each endpoint
  - `src/sidecar/server.ts` (271 lines) — Sidecar server startup, `SidecarContext` type
  - `src/cli/commands/hook.ts` (402 lines) — Hook dispatch. OVER 400-line limit.
  - `src/hooks/tdd-guard.ts` (101 lines) — The PreToolUse blocking pattern
  - `src/hooks/file-checker.ts` (129 lines) — The PostToolUse hint pattern
  - `src/cli/embedded-assets.ts` (~9500 lines) — Auto-generated, contains hooks.json. Rebuilt via `bun run embed-assets`.
  - `targets/opencode/plugins/sentinal.ts` (599 lines) — OpenCode plugin. AT 600-line limit.
  - `src/memory/restore.ts` (358 lines) — `restoreContext()`, `buildSemanticQuery()`
  - `src/checkers/detect.ts` — `detectPackageManager()`, `detectFramework()` utilities

- **Gotchas:**
  - `routes.ts` is at 399 lines — new route handler should be in a separate file (like `quality-routes.ts`), wired in via `server.ts`
  - `hook.ts` is at 402 lines — the new hook runner function should be minimal, delegating to a new file
  - OpenCode plugin is at 599 lines — any additions must be extremely minimal (1-3 lines in before handler, delegate to helper)
  - `embedded-assets.ts` is auto-generated — after changing templates (hooks.json), run `bun run embed-assets`
  - Pre-edit hints in Claude Code use `hint("PreToolUse", ...)` — this injects context WITHOUT blocking the tool call
  - The sidecar route dispatch in `server.ts:141-232` calls `handleQualityRequest()` for `/quality-check` path — follow same pattern for `/project-context`

- **Domain context:**
  - `project_context` is called 1-2x per session by the LLM (not on every tool call). Low frequency, can be ~100ms.
  - Pre-edit guidance runs on every Write/Edit/MultiEdit but returns quickly (skip) when no observations exist for the file. Must be fast (<50ms for the skip path).
  - The sidecar caches project context in memory for the session. Cache key is project path.
  - Existing framework detection (`detectPackageManager`, `detectFramework`) is already available in `src/checkers/detect.ts`.

## Assumptions

- `detectFramework()` and `detectPackageManager()` in `src/checkers/detect.ts` are fast enough for live analysis (~5ms) — supported by: they read package.json and check for config files — Task 1 depends on this
- PreToolUse hint hooks do not block tool execution in Claude Code — supported by: `hint()` returns `hookSpecificOutput` which injects context without `permissionDecision: deny` — Task 4 depends on this
- The sidecar has sufficient memory to cache project context for multiple projects simultaneously — supported by: the analysis result is ~2-5KB of text per project — Task 2 depends on this
- Observations queried by file path will return quickly from SQLite FTS — supported by: file_paths are stored as JSON arrays, existing search uses FTS5 — Task 4 depends on this

## Testing Strategy

- **Unit tests:** `src/project/context.test.ts` — test project analysis (mock filesystem)
- **Unit tests:** `src/hooks/pre-edit-guide.test.ts` — test pre-edit guidance logic
- **Unit tests:** `src/project/mcp-tools.test.ts` — test MCP tool registration
- **Integration:** Full sidecar flow via sidecar.test.ts or manual verification
- **Existing tests:** Full suite must pass after all changes

## Risks and Mitigations

| Risk                                                      | Likelihood | Impact | Mitigation                                                                                        |
| --------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------- |
| Pre-edit hook adds latency to every Write/Edit            | Medium     | Medium | Skip path (<5ms) when no observations exist. Only query sidecar when file has known observations. |
| Project analysis returns stale data after package changes | Low        | Low    | Cache per-session only. User can call `project_context` again to refresh.                         |
| Sync rule files don't exist (user never ran /sync)        | Medium     | Low    | Live analysis is always available. Rule files are supplementary.                                  |
| OpenCode plugin exceeds 600-line limit                    | High       | Medium | Delegate all logic to imported helper functions. Plugin only adds 2-3 lines.                      |
| routes.ts exceeds 400-line limit                          | High       | Medium | New routes go in a separate `project-routes.ts` file, wired in via server.ts.                     |

## Pre-Mortem

_Assume this plan failed. Most likely internal reasons:_

1. **Pre-edit guidance is too noisy or too slow** (Task 4) — Trigger: LLMs start ignoring the hints because they fire too often or contain irrelevant information. Mitigation: strict observation-gated triggering — only fire when there are observations specifically about the target file (not general project observations).

2. **Project context analysis returns unhelpful generic information** (Task 1) — Trigger: the structured summary just says "TypeScript project with Jest" which the LLM already infers from the code. Mitigation: include specific conventions, file patterns, and recent architectural decisions from memory observations. The value is in project-specific details, not generic framework info.

3. **Cache invalidation causes stale project context** (Task 2) — Trigger: user adds a dependency or changes tsconfig, but project_context returns old data. Mitigation: cache is per-session only, and the MCP tool can accept a `refresh` parameter to force re-analysis.

## Goal Verification

### Truths

1. `project_context` MCP tool returns a structured project summary including tech stack, directory structure, and conventions
2. Project analysis reads package.json, tsconfig.json, and directory tree from the filesystem
3. Existing sync-generated rule files are included in the project context when available
4. Sidecar caches project context in memory with per-project cache key
5. Pre-edit guidance hook injects file-specific memory observations before Write/Edit/MultiEdit
6. Pre-edit guidance is silent (returns nothing) when no observations exist for the target file
7. Pre-edit guidance works on both Claude Code (PreToolUse hook) and OpenCode (tool.execute.before)

### Artifacts

- `src/project/context.ts` (new) — project analysis logic
- `src/project/context.test.ts` (new) — tests
- `src/project/mcp-tools.ts` (new) — `project_context` MCP tool registration
- `src/sidecar/project-routes.ts` (new) — `/project-context` endpoint
- `src/hooks/pre-edit-guide.ts` (new) — pre-edit guidance hook
- `src/hooks/pre-edit-guide.test.ts` (new) — tests
- `src/sidecar/client.ts` (modified) — `projectContext()` method
- `src/mcp/server.ts` (modified) — register project context tools
- `src/sidecar/server.ts` (modified) — wire project-routes
- `src/cli/commands/hook.ts` (modified) — register pre-edit-guide hook
- `templates/claude/hooks.json` (modified) — add PreToolUse hook entry
- `targets/opencode/plugins/sentinal.ts` (modified) — add pre-edit guide in before handler

### Key Links

- `project_context` MCP tool ← calls sidecar `/project-context` ← `analyzeProject()` + cache
- `pre-edit-guide` hook ← queries sidecar for file observations ← returns hint or nothing
- hooks.json ← PreToolUse matcher for Write|Edit|MultiEdit ← `sentinal hook shared pre-edit-guide`

## Progress Tracking

- [x] Task 1: Create project analysis module
- [x] Task 2: Add sidecar `/project-context` endpoint with caching
- [x] Task 3: Create `project_context` MCP tool
- [x] Task 4: Create pre-edit guidance hook
- [x] Task 5: Wire hooks into Claude Code and OpenCode

**Total Tasks:** 5 | **Completed:** 5 | **Remaining:** 0

## Implementation Tasks

### Task 1: Create project analysis module

**Objective:** Build the core project analysis function that reads package.json, tsconfig.json, directory tree, framework info, and existing sync-generated rule files to produce a structured project summary.

**Dependencies:** None

**Files:**

- Create: `src/project/context.ts`
- Create: `src/project/context.test.ts`

**Key Decisions / Notes:**

- **Function signature:** `analyzeProject(projectPath: string): ProjectContext`
- **`ProjectContext` type:**
  ```ts
  interface ProjectContext {
    name: string; // from package.json name or directory basename
    techStack: TechStack; // framework, language, packageManager, testRunner
    structure: string[]; // top-level directory listing with annotations
    conventions: string[]; // discovered conventions (from rules + analysis)
    commands: Record<string, string>; // build, test, lint, dev from package.json scripts
    rulesContent: string | null; // content of sync-generated rules file if exists
    analyzedAt: number; // timestamp for cache freshness
  }
  ```
- **Tech stack detection:** Use existing `detectPackageManager()` and `detectFramework()` from `src/checkers/detect.ts`
- **Directory tree:** Read top-level directories + `src/` one level deep. Annotate common patterns (e.g., "components/", "services/", "hooks/")
- **Rules file discovery:** Check `.claude/rules/*-project.md` and `.opencode/rules/*-project.md`. Read first match.
- **Conventions discovery:** Parse tsconfig for strict mode, paths. Check for `.prettierrc`, `.eslintrc`. Detect monorepo (workspaces in package.json).
- **Keep it fast:** All synchronous file reads. Target <50ms total.
- **Output format:** `formatProjectContext(ctx: ProjectContext): string` — formats as markdown for MCP tool output.

**Definition of Done:**

- [ ] `analyzeProject()` reads package.json and extracts name, scripts, dependencies
- [ ] Tech stack detected (framework, packageManager, testRunner)
- [ ] Directory structure captured (top-level + src/ one level)
- [ ] Sync-generated rules files included when present
- [ ] `formatProjectContext()` produces readable markdown
- [ ] Tests verify analysis with mock filesystem

**Verify:**

- `bun test src/project/context.test.ts`

---

### Task 2: Add sidecar `/project-context` endpoint with caching

**Objective:** Add a `/project-context` sidecar endpoint that calls `analyzeProject()` and caches the result per project path. Support a `refresh` query parameter to force re-analysis.

**Dependencies:** Task 1

**Files:**

- Create: `src/sidecar/project-routes.ts`
- Modify: `src/sidecar/server.ts` (wire handler, add cache to SidecarContext)
- Modify: `src/sidecar/client.ts` (add `projectContext()` method)

**Key Decisions / Notes:**

- **Route:** `GET /project-context?project=<path>&refresh=<bool>`
- **Cache:** `Map<string, ProjectContext>` held on `SidecarContext`. Cleared on sidecar restart (per-session).
- **Cache key:** Normalized project path (use `path.resolve()`)
- **Handler location:** New `src/sidecar/project-routes.ts` (~60 lines) — keeps `routes.ts` under limit.
- **Wiring:** In `server.ts` fetch handler, check for `/project-context` path before routing to `handleSidecarRequest`. Follow the same pattern as `handleQualityRequest`.
- **Client method:** `projectContext(projectPath: string, refresh?: boolean): Promise<ProjectContext>`
- **Line count:** `routes.ts` stays unchanged (399 lines). `server.ts` grows by ~3 lines (import + route check). `client.ts` grows by ~8 lines.

**Definition of Done:**

- [ ] `GET /project-context` returns analyzed project context
- [ ] Response is cached per project path
- [ ] `refresh=true` forces re-analysis
- [ ] Client has `projectContext()` method
- [ ] Handler is in separate `project-routes.ts` file

**Verify:**

- `bun test src/sidecar/`

---

### Task 3: Create `project_context` MCP tool

**Objective:** Register a `project_context` MCP tool that calls the sidecar (or direct analysis) and returns a formatted project summary.

**Dependencies:** Task 1, Task 2

**Files:**

- Create: `src/project/mcp-tools.ts`
- Create: `src/project/mcp-tools.test.ts`
- Modify: `src/mcp/server.ts` (import and register)

**Key Decisions / Notes:**

- **Tool name:** `project_context`
- **Description:** "Get a structured project summary including tech stack, directory layout, key commands, and conventions. Call once per session for project understanding."
- **Parameters:**
  - `project` (required, string): Project root path
  - `refresh` (optional, boolean): Force re-analysis (ignores cache)
- **Handler:** Sidecar-first → fallback to direct `analyzeProject()` + `formatProjectContext()`
- **Registration:** New `registerProjectTools(server, deps)` in `src/project/mcp-tools.ts`. Called from `createSentinalServer()`.
- **Line impact:** `server.ts` grows by 2 lines (import + register call). New file ~60 lines.

**Definition of Done:**

- [ ] `project_context` tool registered on MCP server
- [ ] Returns formatted markdown with tech stack, structure, commands, conventions
- [ ] Routes through sidecar when available, falls back to direct
- [ ] `refresh` parameter forces cache invalidation
- [ ] Tests verify tool registration, sidecar-first with direct fallback, and refresh parameter

**Verify:**

- `bun test src/project/`

---

### Task 4: Create pre-edit guidance hook

**Objective:** Build a hook that injects file-specific memory observations and project conventions as a hint before Write/Edit/MultiEdit. Only fires when relevant observations exist for the target file.

**Dependencies:** None (uses existing MemoryStore/service)

**Files:**

- Create: `src/hooks/pre-edit-guide.ts`
- Create: `src/hooks/pre-edit-guide.test.ts`

**Key Decisions / Notes:**

- **Core function:** `processPreEditGuide(input: PreEditInput): Promise<string | null>`
  - `PreEditInput`: `{ filePath: string; cwd: string }`
  - Returns formatted hint string or `null` (silent skip)
- **Observation query approach:** Use existing sidecar `POST /memory/search` (via `client.memorySearch()`) with the file basename as query and project filter. The sidecar search endpoint already exists — no new endpoint needed.
  - Call: `client.memorySearch({ query: basename(filePath), project: cwd, limit: 10 })`
  - **Client-side filter:** After getting results, filter to observations whose `filePaths` array contains the exact target file path (full path match, not basename). The search response shape from `client.memorySearch()` returns `Array<{ id, title, type, timestamp, score, estimatedTokens, snippet, tags, filePaths }>`. Use: `results.filter(r => r.filePaths.some(fp => fp === filePath || filePath.endsWith(fp)))`.
  - If 0 results after filter, return `null` immediately (silent skip).
  - Fallback (no sidecar): use direct `service.search()` with same query/filter.
- **Hint format when observations exist:**
  ```
  [Sentinal] Context for <filename>:
  - [decision] 2026-03-15: Chose SQLite for storage
  - [error] 2026-03-14: Race condition in token refresh (FIXED)
  - [pattern] Always use class-validator on DTOs
  ```
- **Hook output:** `hint("PreToolUse", text)` — injects context without blocking
- **Performance:** The fast path (no observations) must be <10ms. Use sidecar when available (avoids MemoryStore cold start). When no sidecar, open store, query, close (~5ms for SQLite read).

**Definition of Done:**

- [ ] `processPreEditGuide()` returns file-specific observations as formatted hint
- [ ] Returns `null` (silent) when no observations exist for the file
- [ ] Fast path: <10ms when no observations
- [ ] Works via sidecar (memory search) with direct fallback
- [ ] Tests verify: observation found returns hint, no observation returns null

**Verify:**

- `bun test src/hooks/pre-edit-guide.test.ts`

---

### Task 5: Wire hooks into Claude Code and OpenCode

**Objective:** Register the pre-edit guidance hook in Claude Code's hooks.json and OpenCode's plugin `tool.execute.before`.

**Dependencies:** Task 4

**Files:**

- Modify: `src/cli/commands/hook.ts` (add `pre-edit-guide` to SHARED_HOOKS)
- Modify: `templates/claude/hooks.json` (add PreToolUse entry for Write|Edit|MultiEdit)
- Modify: `targets/opencode/plugins/sentinal.ts` (add pre-edit guide call in before handler)
- Run: `bun run embed-assets` (regenerates embedded-assets.ts)

**Key Decisions / Notes:**

- **Claude Code:** Add a new PreToolUse entry in hooks.json:
  ```json
  {
    "matcher": "Write|Edit|MultiEdit",
    "hooks": [
      {
        "type": "command",
        "command": "sentinal hook shared pre-edit-guide",
        "timeout": 5
      }
    ]
  }
  ```
  Place AFTER the tdd-guard entry (TDD guard runs first, if it denies, pre-edit guide doesn't run).
- **hook.ts:** Add `"pre-edit-guide": runPreEditGuide` to SHARED_HOOKS. The runner function reads stdin, extracts file_path, calls `processPreEditGuide()`, outputs hint if non-null. ~15 lines.
- **OpenCode plugin refactor-first:** The plugin is at 599 lines — there is zero margin. BEFORE adding the pre-edit guide call, extract the grep/fetch hint logic (lines 269-287, ~19 lines) into a helper module `targets/opencode/plugins/sentinal-helpers.ts`. This brings the plugin down to ~580 lines, leaving room for the pre-edit guide addition.
- **OpenCode plugin pre-edit:** After refactoring, add a pre-edit guide call in `tool.execute.before` after the TDD guard block:
  ```ts
  if (sidecar && typeof filePath === "string") {
    const guide = await getPreEditGuide(sidecar, filePath, projectRoot);
    if (guide)
      await client.app.log({
        body: { service: "sentinal", level: "info", message: guide },
      });
  }
  ```
  `getPreEditGuide()` is imported from the helpers file.
- **hook.ts line count:** Currently 402 lines. Adding ~15 lines pushes to ~417. Extract the new function into `pre-edit-guide.ts` and just add a 2-line import+registration in hook.ts.
- **After template changes:** Run `bun run embed-assets` to rebuild `src/cli/embedded-assets.ts`.

**Definition of Done:**

- [ ] Pre-edit guidance fires on Write/Edit/MultiEdit in Claude Code
- [ ] Pre-edit guidance fires in OpenCode plugin before handler
- [ ] TDD guard runs before pre-edit guidance (correct ordering)
- [ ] OpenCode plugin stays under 595 lines after changes
- [ ] `bun run embed-assets` succeeds and embedded hooks.json is updated
- [ ] Full test suite passes

**Verify:**

- `bun test src/hooks/ src/cli/`
- `bun run embed-assets`
- `bun run build:cli`
