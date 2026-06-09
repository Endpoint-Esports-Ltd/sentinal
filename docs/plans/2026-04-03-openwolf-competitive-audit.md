# OpenWolf Competitive Audit — Sentinal Gap Analysis

Created: 2026-04-03
Status: PENDING
Approved: No
Iterations: 1
Worktree: No
Type: Feature

## Summary

**Goal:** Comprehensive competitive audit of OpenWolf vs Sentinal, identifying overlap, gaps, and strategic improvements — with implementation tasks for the four highest-value features to adopt natively.

**Architecture:** All new features integrate into Sentinal's existing architecture (SQLite store, MCP tools, sidecar API, hooks) with cross-platform parity for Claude Code and OpenCode.

**Tech Stack:** TypeScript, Bun, SQLite (via MemoryStore), MCP SDK, puppeteer-core (Design QC only)

---

## Competitive Matrix

### Feature Comparison

| Feature Area               | OpenWolf                                      | Sentinal                                                                                     | Winner   | Notes                                                                           |
| -------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------- |
| **Platform Support**       | Claude Code only                              | Claude Code + OpenCode                                                                       | Sentinal | OpenWolf has no OpenCode/Cursor support                                         |
| **Hook Coverage**          | 6 hooks (3 events)                            | 11 hooks (7 events)                                                                          | Sentinal | Sentinal covers UserPromptSubmit, PreCompact, SessionEnd                        |
| **Memory System**          | Flat files (cerebrum.md, memory.md)           | SQLite + vector search + embeddings                                                          | Sentinal | Sentinal has semantic search, quality scoring, sharing                          |
| **Token Tracking**         | Per-read/write char-ratio estimation          | Session-level usage stats                                                                    | OpenWolf | OpenWolf tracks per-operation; Sentinal only aggregate                          |
| **Read Optimization**      | Anatomy index + repeat-read blocking          | None                                                                                         | OpenWolf | Major gap — Sentinal has no read deduplication                                  |
| **Bug Tracking**           | Structured buglog.json (searchable)           | No structured bug observation type — current types: decision, discovery, error, fix, pattern | OpenWolf | Sentinal captures memories but no bug-specific workflow                         |
| **Mistake Prevention**     | Do-Not-Repeat in pre-write hook               | No pre-write enforcement of past mistakes                                                    | OpenWolf | Sentinal captures learnings but doesn't enforce them                            |
| **Visual QA**              | Design QC (screenshot capture + eval)         | None                                                                                         | OpenWolf | Sentinal has no visual evaluation capability                                    |
| **Spec Workflow**          | None                                          | Full spec-driven dev (plan→implement→verify)                                                 | Sentinal | OpenWolf has no structured development workflow                                 |
| **TDD Enforcement**        | None                                          | Guard + tracker (9 languages)                                                                | Sentinal | OpenWolf has no test enforcement                                                |
| **Code Quality**           | None                                          | TypeScript, NestJS, Angular checkers                                                         | Sentinal | OpenWolf has no static analysis                                                 |
| **Worktree Isolation**     | None                                          | Full worktree management + MCP tools                                                         | Sentinal | OpenWolf has no parallel execution support                                      |
| **Model Routing**          | None                                          | Configurable per-phase model selection                                                       | Sentinal | OpenWolf has no model control                                                   |
| **MCP Tools**              | None (hooks only)                             | 20+ tools (memory, spec, worktree, TDD, analysis, project)                                   | Sentinal | OpenWolf uses no MCP server                                                     |
| **Dashboard**              | Web dashboard (WebSocket, PM2)                | Web dashboard (sessions, memories, specs, settings)                                          | Tie      | Both have dashboards; OpenWolf has real-time updates                            |
| **Daemon/Cron**            | Background tasks (anatomy rescan, reflection) | Sidecar HTTP server (on-demand)                                                              | Tie      | Different approaches to persistence                                             |
| **UI Framework Knowledge** | Reframe (12 frameworks)                       | Rules system (coding standards)                                                              | Tie      | Different domains — OpenWolf has UI libraries, Sentinal has project conventions |
| **Session Persistence**    | memory.md (flat append-only)                  | SQLite sessions + context snapshots                                                          | Sentinal | Sentinal survives compaction with structured restore                            |
| **Project Intelligence**   | anatomy.md (file descriptions)                | project_context MCP tool                                                                     | Tie      | Different approaches — OpenWolf is file-level, Sentinal is project-level        |
| **Cross-Session Learning** | cerebrum.md (preferences, learnings)          | Memory observations + quality scoring                                                        | Sentinal | Sentinal has richer search and decay mechanics                                  |
| **Statusline**             | None                                          | Plan tier, usage stats, coexistence detection                                                | Sentinal | OpenWolf has no statusline                                                      |
| **LSP Integration**        | None                                          | LSP client for diagnostics                                                                   | Sentinal | OpenWolf has no LSP support                                                     |

### Strategic Assessment

**OpenWolf's strengths** are narrow but deep: token optimization through anatomy-based read avoidance, structured bug tracking, visual QA, and explicit mistake enforcement. These are all single-purpose, file-based systems with zero external dependencies.

**Sentinal's strengths** are broad and architectural: multi-platform support, SQLite-backed persistence, MCP tool ecosystem, structured development workflows, and code quality enforcement. Sentinal is a development intelligence platform; OpenWolf is a token optimizer with memory.

**Key gaps in Sentinal** (worth closing):

1. **No per-operation token tracking** — can't tell users which reads/writes are wasteful
2. **No read deduplication** — repeated reads aren't detected or warned about
3. **No structured bug log** — bug fixes captured as generic observations, not searchable by error/tag
4. **No visual QA** — no screenshot capture for UI evaluation
5. **No pre-write mistake enforcement** — past mistakes are remembered but not enforced

**Key gaps in OpenWolf** (Sentinal advantages to maintain):

1. No OpenCode support — single-platform lock-in
2. No MCP tools — hooks only, no interactive tooling
3. No spec workflow — no structured planning or implementation
4. No TDD enforcement — no test-writing requirements
5. No quality checkers — no TypeScript/NestJS/Angular validation
6. Flat-file state — no search, no vector embeddings, no quality scoring

---

## Scope

### In Scope

1. **Token Tracking & Read Optimization** — Per-operation token estimation, repeated-read detection, anatomy-style file index
2. **Bug Log** — Structured bug observation type with searchable fields (error, root_cause, fix, tags)
3. **Design QC** — Screenshot capture of dev server routes for inline visual evaluation
4. **Do-Not-Repeat Enforcement** — Pre-write hook queries memory for known mistakes related to the target file

### Out of Scope

- OpenWolf coexistence detection (already handled by statusline coexistence)
- Reframe/UI framework knowledge base (not aligned with Sentinal's project-agnostic approach)
- Daemon/cron system (Sentinal uses sidecar on-demand instead)
- Token ledger lifetime stats (can be derived from session data already in SQLite)
- Identity/persona file (Sentinal uses rules system instead)

---

## Context for Implementer

> Write for an implementer who has never seen the codebase.

- **Hook architecture:** Hooks are defined in `targets/claude-code/hooks/hooks.json` and implemented in `src/hooks/`. Each hook is a CLI command (`sentinal hook shared <name>` or `sentinal hook claude <name>`). Shared hooks work on both platforms via sidecar API; claude-specific hooks use Claude Code features.
- **Memory system:** `src/memory/store.ts` (MemoryStore) is a SQLite database. Observations are the core data type with fields: type, content, context, quality_score. MCP tools registered in `src/memory/mcp-tools.ts`. Service layer in `src/memory/service.ts`.
- **MCP tools pattern:** Each domain has `mcp-tools.ts` that registers tools on the McpServer. Tools accept `{client, store}` deps — client for sidecar proxy, store for direct DB access.
- **Sidecar:** HTTP server in `src/sidecar/server.ts` with route handlers (`*-routes.ts`). Client in `src/sidecar/client.ts`. Routes return JSON via `ok()` / `err()` helpers from `response.ts`.
- **OpenCode plugin:** `targets/opencode/plugins/sentinal.ts` — TypeScript plugin using sidecar HTTP API (no bun:sqlite). Must maintain feature parity with Claude Code hooks.
- **Testing:** Bun test runner. Tests co-located with source (`*.test.ts`). Use `MemoryStore(":memory:")` for test isolation.
- **Key convention:** All observation types are in `src/memory/types.ts` OBSERVATION_TYPES array.

---

## Assumptions

- Claude Code's PreToolUse hook for Read operations provides the file path being read — supported by existing tool-redirect hook in `src/hooks/tool-redirect.ts` which receives tool input — Tasks 1-2 depend on this
- The `puppeteer-core` package can be an optional peer dependency without affecting non-Design QC users — supported by OpenWolf's same approach — Task 5 depends on this
- Memory search by type + context is fast enough for pre-write enforcement (<50ms) — supported by existing SQLite FTS indexes in MemoryStore — Task 7 depends on this

---

## Testing Strategy

- **Unit tests** for each new module (token tracker, bug log tools, screenshot capture, DNR enforcement)
- **Integration tests** for hook→sidecar→store flow on token tracking and DNR
- **Manual verification** for Design QC (requires running dev server)
- **Cross-platform tests** for OpenCode plugin parity (token tracking, bug log)

---

## Risks and Mitigations

| Risk                                                  | Likelihood | Impact | Mitigation                                                                                      |
| ----------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------- |
| PreToolUse Read hook adds latency to every file read  | Medium     | High   | Use async tracking (fire-and-forget), keep pre-read warning sync but fast (<10ms)               |
| puppeteer-core dependency bloats install              | Low        | Medium | Make it optional — only required for Design QC, lazy-import with clear error message            |
| Token estimation accuracy (char-ratio) insufficient   | Low        | Low    | Same approach as OpenWolf (~15% accuracy) — good enough for waste detection                     |
| DNR enforcement false positives blocking valid writes | Medium     | Medium | Warn-only mode by default, with config option to block. Show matched rule so user can override. |

---

## Pre-Mortem

_Assume this plan failed. Most likely internal reasons:_

1. **Token tracking adds too much overhead to every Read/Write** (Tasks 1-2) → Trigger: hook execution time exceeds 50ms on average, causing noticeable lag in Claude's responses
2. **DNR enforcement matches are too noisy/irrelevant** (Task 7) → Trigger: more than 30% of pre-write warnings are dismissed by users as false positives in first week of use
3. **Design QC screenshot capture fails on common dev server setups** (Task 5) → Trigger: puppeteer fails to connect on >50% of tested project configurations (non-standard ports, auth-gated pages, SSR hydration timing)

---

## Execution Waves

**Wave 1** — Foundation (parallel): Token tracking store + bug log observation type are independent schema additions with no shared files

- Task 1: Token tracking schema + store methods
- Task 3: Bug log observation type + MCP tools

**Wave 2** — Hooks (parallel): Read optimization hook and bug log sidecar route are independent once store is ready

- Task 2: Read optimization hook (depends on Task 1)
- Task 4: Bug log sidecar route + OpenCode parity (depends on Task 3)

**Wave 3** — Visual QA (sequential): Design QC is self-contained

- Task 5: Design QC capture engine
- Task 6: Design QC MCP tool + hook integration (depends on Task 5)

**Wave 4** — Enforcement (sequential): DNR needs memory system familiarity from earlier waves

- Task 7: Do-Not-Repeat enforcement hook (depends on Wave 1-2 patterns)

---

## Goal Verification

### Truths

1. `src/memory/store.ts` contains a `token_usage` table with columns for session_id, file_path, operation, estimated_tokens, timestamp
2. `src/hooks/token-tracker.ts` exists and is registered in `targets/claude-code/hooks/hooks.json` under PostToolUse for Read|Write|Edit
3. `src/memory/types.ts` OBSERVATION_TYPES array contains `"bug_fix"`, `"mistake"`, and `"learning"` entries
4. MCP tool `sentinal__bug_search` is callable and returns structured results with error_message, root_cause, fix, tags fields
5. `src/analysis/design-qc.ts` exists and exports a `captureScreenshots` function
6. `src/hooks/dnr-guard.ts` exists and is registered in `targets/claude-code/hooks/hooks.json` under PreToolUse for Write|Edit|MultiEdit
7. OpenCode plugin (`targets/opencode/plugins/sentinal.ts`) handles token tracking events via sidecar API

### Artifacts

| Artifact                          | Provides                                        | Exports                                                    |
| --------------------------------- | ----------------------------------------------- | ---------------------------------------------------------- |
| `src/memory/store.ts` (modified)  | Token usage table + query methods               | `logTokenUsage()`, `getTokenUsage()`, `getRepeatedReads()` |
| `src/hooks/token-tracker.ts`      | PostToolUse hook for token estimation           | CLI command handler                                        |
| `src/hooks/read-advisor.ts`       | PreToolUse hook for read deduplication warnings | CLI command handler                                        |
| `src/memory/types.ts` (modified)  | Bug fix observation type                        | `"bug_fix"` in OBSERVATION_TYPES                           |
| `src/memory/bug-log.ts`           | Bug log query/search helpers                    | `searchBugs()`, `formatBugEntry()`                         |
| `src/sidecar/bug-routes.ts`       | Sidecar HTTP endpoints for bug log              | `handleBugRequest()`                                       |
| `src/analysis/design-qc.ts`       | Screenshot capture engine                       | `captureScreenshots()`, `detectDevServer()`                |
| `src/analysis/design-qc-tools.ts` | MCP tool + sidecar integration                  | `registerDesignQcTools()`                                  |
| `src/hooks/dnr-guard.ts`          | Pre-write mistake enforcement                   | CLI command handler                                        |

### Key Links

| From                                   | To                      | Via                        | Pattern                     |
| -------------------------------------- | ----------------------- | -------------------------- | --------------------------- |
| `src/hooks/token-tracker.ts`           | `src/sidecar/client.ts` | sidecar API call           | `client\.post.*token`       |
| `src/hooks/read-advisor.ts`            | `src/sidecar/client.ts` | repeated-read query        | `client\.get.*repeated`     |
| `src/memory/bug-log.ts`                | `src/memory/store.ts`   | SQLite query               | `store\.searchObservations` |
| `src/sidecar/bug-routes.ts`            | `src/memory/bug-log.ts` | route handler              | `import.*bug-log`           |
| `src/analysis/design-qc.ts`            | puppeteer-core          | screenshot capture         | `puppeteer\.launch`         |
| `src/hooks/dnr-guard.ts`               | `src/sidecar/client.ts` | memory query for DNR rules | `client\.get.*dnr\|mistake` |
| `targets/opencode/plugins/sentinal.ts` | sidecar                 | token tracking parity      | `fetch.*token`              |

---

## Progress Tracking

- [ ] Task 1: Token tracking schema + store methods (Wave 1)
- [ ] Task 2: Read optimization hooks — token tracker + read advisor (Wave 2)
- [ ] Task 3: Bug log observation type + MCP tools (Wave 1)
- [ ] Task 4: Bug log sidecar route + OpenCode parity (Wave 2)
- [ ] Task 5: Design QC capture engine (Wave 3)
- [ ] Task 6: Design QC MCP tool + hook integration (Wave 3)
- [ ] Task 7: Do-Not-Repeat enforcement hook (Wave 4)

**Total Tasks:** 7 | **Completed:** 0 | **Remaining:** 7

---

## Implementation Tasks

### Task 1: Token Tracking Schema + Store Methods

**Objective:** Add a `token_usage` table to MemoryStore and methods to log per-operation token estimates and query for waste patterns (repeated reads, large reads).

**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `src/memory/store.ts` — add migration for `token_usage` table, add `logTokenUsage()`, `getTokenUsage()`, `getRepeatedReads()`, `getSessionTokenSummary()` methods
- Modify: `src/memory/migrations.ts` — add migration entry for `token_usage` table
- Test: `src/memory/store.test.ts` — add tests for new methods

**Key Decisions / Notes:**

- Token estimation uses character-to-token ratios (same as OpenWolf): code 3.5 chars/token, prose 4.0, mixed 3.75
- Table schema: `id INTEGER PRIMARY KEY, session_id TEXT, file_path TEXT, operation TEXT CHECK(operation IN ('read','write','edit')), estimated_tokens INTEGER, char_count INTEGER, timestamp TEXT DEFAULT CURRENT_TIMESTAMP`
- `getRepeatedReads(sessionId)` returns files read more than once in current session with count and total tokens
- `getSessionTokenSummary(sessionId)` returns aggregate read/write token counts

**Definition of Done:**

- [ ] `token_usage` table created by migration
- [ ] `logTokenUsage()` inserts records
- [ ] `getRepeatedReads()` returns duplicates correctly in tests
- [ ] `getSessionTokenSummary()` returns correct aggregates
- [ ] All tests pass
- [ ] No diagnostics errors

**Verify:**

- `bun test src/memory/store.test.ts`

---

### Task 2: Read Optimization Hooks — Token Tracker + Read Advisor

**Objective:** Add PostToolUse hook that logs token usage for Read/Write/Edit operations, and a PreToolUse hook that warns when a file has already been read in the current session.

**Dependencies:** Task 1
**Wave:** 2

**Files:**

- Create: `src/hooks/token-tracker.ts` — PostToolUse hook: estimates tokens from tool output size, logs via sidecar
- Create: `src/hooks/read-advisor.ts` — PreToolUse hook: checks sidecar for repeated reads, returns warning if file already read
- Modify: `targets/claude-code/hooks/hooks.json` — register both hooks
- Modify: `src/sidecar/routes.ts` or create `src/sidecar/token-routes.ts` — add `POST /tokens/log` and `GET /tokens/repeated-reads/:sessionId` endpoints
- Modify: `src/sidecar/client.ts` — add `logTokenUsage()` and `getRepeatedReads()` methods
- Modify: `targets/opencode/plugins/sentinal.ts` — add PostToolUse token tracking via sidecar
- Test: `src/hooks/token-tracker.test.ts`
- Test: `src/hooks/read-advisor.test.ts`

**Key Decisions / Notes:**

- Token tracker is async (fire-and-forget) to avoid latency — pattern: `src/hooks/memory-observer.ts:async:true`
- Read advisor is sync but fast (<10ms) — only a sidecar GET call
- Read advisor outputs a warning message (not a block) — user sees "File already read this session (3 times, ~1.2K tokens). Consider using the anatomy summary instead."
- Follow existing hook patterns in `src/hooks/tdd-guard.ts` for PreToolUse and `src/hooks/tdd-tracker.ts` for PostToolUse
- OpenCode plugin: add token tracking to **both** read and write PostToolUse handlers (not just write), fire-and-forget sidecar call. Verify which OpenCode plugin hook event names correspond to file-read operations.

**Definition of Done:**

- [ ] Token tracker hook logs usage for Read/Write/Edit operations
- [ ] Read advisor hook warns on repeated reads
- [ ] Both hooks registered in hooks.json
- [ ] Sidecar endpoints respond correctly
- [ ] OpenCode plugin tracks token usage for both read and write events
- [ ] All tests pass
- [ ] No diagnostics errors

**Verify:**

- `bun test src/hooks/token-tracker.test.ts`
- `bun test src/hooks/read-advisor.test.ts`

---

### Task 3: Bug Log Observation Type + MCP Tools

**Objective:** Add a structured `bug_fix` observation type to the memory system with dedicated search/save MCP tools that support error message, root cause, fix description, and tags.

**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `src/memory/types.ts` — add `"bug_fix"`, `"mistake"`, and `"learning"` to OBSERVATION_TYPES (current types are: decision, discovery, error, fix, pattern — none of the three exist yet)
- Create: `src/memory/bug-log.ts` — helper functions: `searchBugs(store, query)`, `formatBugEntry(obs)`, `parseBugMetadata(content)` — extracts structured fields from observation content using a standard format
- Modify: `src/memory/mcp-tools.ts` — add `sentinal__bug_search` and `sentinal__bug_save` MCP tools
- Test: `src/memory/bug-log.test.ts`

**Key Decisions / Notes:**

- Bug observations stored as regular observations with type `"bug_fix"` — no new table needed
- Content format: structured markdown with `Error:`, `Root Cause:`, `Fix:`, `Tags:` sections — parsed by `parseBugMetadata()`
- `bug_search` MCP tool accepts `query` (free text) and optional `tags` filter, returns structured results
- `bug_save` MCP tool accepts `error_message`, `root_cause`, `fix`, `tags[]`, `file_path` — formats into standard content and saves as observation
- Follow pattern of existing `memory_save` tool for save semantics

**Definition of Done:**

- [ ] `"bug_fix"`, `"mistake"`, and `"learning"` added to OBSERVATION_TYPES
- [ ] `bug_search` MCP tool returns structured bug entries
- [ ] `bug_save` MCP tool creates properly formatted observations
- [ ] Search by tag works correctly
- [ ] All tests pass
- [ ] No diagnostics errors

**Verify:**

- `bun test src/memory/bug-log.test.ts`
- `bun test src/memory/mcp-tools.test.ts`

---

### Task 4: Bug Log Sidecar Route + OpenCode Parity

**Objective:** Expose bug log search/save via sidecar HTTP API so the OpenCode plugin can access it, and add bug log handlers to the OpenCode plugin.

**Dependencies:** Task 3
**Wave:** 2

**Files:**

- Create: `src/sidecar/bug-routes.ts` — `POST /bugs/search` and `POST /bugs/save` endpoints
- Modify: `src/sidecar/server.ts` — wire bug-routes dispatch
- Modify: `src/sidecar/client.ts` — add `searchBugs()` and `saveBug()` methods
- Modify: `targets/opencode/plugins/sentinal.ts` — add bug log tools to OpenCode plugin
- Test: `src/sidecar/bug-routes.test.ts`

**Key Decisions / Notes:**

- Follow pattern of `src/sidecar/quality-routes.ts` for route structure
- OpenCode plugin exposes bug tools via `tools` array — `sentinal_bug_search` and `sentinal_bug_save`
- Uses same structured format as MCP tools in Task 3

**Definition of Done:**

- [ ] Sidecar endpoints respond correctly for search and save
- [ ] Client methods work
- [ ] OpenCode plugin has bug log tools
- [ ] All tests pass
- [ ] No diagnostics errors

**Verify:**

- `bun test src/sidecar/bug-routes.test.ts`

---

### Task 5: Design QC Capture Engine

**Objective:** Build a screenshot capture engine that detects running dev servers, discovers routes, and captures full-page sectioned screenshots using puppeteer-core.

**Dependencies:** None (but Wave 3 for scheduling)
**Wave:** 3

**Files:**

- Create: `src/analysis/design-qc.ts` — exports `detectDevServer()`, `discoverRoutes(projectPath)`, `captureScreenshots(options)`, `captureRoute(page, url, outputDir)`
- Create: `src/analysis/design-qc.test.ts`

**Key Decisions / Notes:**

- `detectDevServer()` probes ports [3000, 5173, 4321, 8080, 4200, 8000] with HTTP HEAD requests, returns first responding
- `discoverRoutes(projectPath)` scans for common route file patterns: Next.js `app/**/page.tsx`, Angular `*-routing.module.ts`, file-based routers
- `captureScreenshots(options)` takes `{baseUrl, routes, outputDir, viewports}` — captures desktop (1440x900) and mobile (375x812)
- Screenshots saved as JPEG (quality 80) in `.sentinal/design-qc/` organized by route path
- Sectioned capture: full-page screenshot split into viewport-height sections (same as OpenWolf)
- puppeteer-core is a lazy import — `await import("puppeteer-core")` with clear error message if not installed
- Chrome detection: check `CHROME_PATH` env, then common paths (/Applications/Google Chrome.app, etc.)

**Definition of Done:**

- [ ] `detectDevServer()` finds running server on standard ports
- [ ] `discoverRoutes()` finds routes for at least Next.js and Angular projects
- [ ] `captureScreenshots()` produces JPEG files in correct directory structure
- [ ] Graceful error when puppeteer-core not installed
- [ ] All tests pass (unit tests mock puppeteer)
- [ ] No diagnostics errors

**Verify:**

- `bun test src/analysis/design-qc.test.ts`

---

### Task 6: Design QC MCP Tool + Hook Integration

**Objective:** Expose Design QC as an MCP tool and optionally as a CLI command, so Claude can capture and evaluate UI screenshots inline.

**Dependencies:** Task 5
**Wave:** 3

**Files:**

- Modify: `src/analysis/mcp-tools.ts` — add `sentinal__design_qc` MCP tool (triggers capture, returns screenshot file paths for Claude to read)
- Modify: `src/sidecar/routes.ts` or create `src/sidecar/design-qc-routes.ts` — `POST /design-qc/capture` endpoint
- Modify: `src/sidecar/client.ts` — add `captureDesignQc()` method
- Create: `targets/claude-code/commands/design-qc.md` — Claude Code slash command for Design QC
- Modify: `targets/opencode/plugins/sentinal.ts` — add `sentinal_design_qc` tool that triggers capture via sidecar API
- Test: `src/analysis/mcp-tools.test.ts` (add Design QC tool tests)

**Key Decisions / Notes:**

- MCP tool returns list of captured screenshot paths — Claude then reads them inline using its vision capabilities
- Slash command (`/design-qc`) provides a guided workflow: detect server → discover routes → capture → present for evaluation
- OpenCode: tool exposed via plugin tools array, captures via sidecar API
- No automated evaluation — capture only, let the user ask Claude to evaluate (same as OpenWolf's design philosophy)

**Definition of Done:**

- [ ] MCP tool `sentinal__design_qc` triggers capture and returns file paths
- [ ] Sidecar endpoint works
- [ ] Slash command exists for Claude Code
- [ ] OpenCode plugin exposes `sentinal_design_qc` tool via sidecar API
- [ ] All tests pass
- [ ] No diagnostics errors

**Verify:**

- `bun test src/analysis/mcp-tools.test.ts`

---

### Task 7: Do-Not-Repeat Enforcement Hook

**Objective:** Add a PreToolUse hook for Write/Edit/MultiEdit that queries memory for known mistakes related to the target file or pattern, and warns the user before the write proceeds.

**Dependencies:** Wave 1-2 patterns established
**Wave:** 4

**Files:**

- Create: `src/hooks/dnr-guard.ts` — PreToolUse hook: extracts target file path from tool input, queries sidecar for DNR observations matching the file or its directory, returns warning if matches found
- Modify: `targets/claude-code/hooks/hooks.json` — register dnr-guard under PreToolUse for Write|Edit|MultiEdit
- Modify: `src/sidecar/routes.ts` or use existing memory routes — `GET /memory/dnr?file_path=...` endpoint
- Modify: `src/sidecar/client.ts` — add `getDnrWarnings(filePath)` method
- Modify: `targets/opencode/plugins/sentinal.ts` — add DNR check in PreToolUse write handler
- Create: `src/memory/dnr.ts` — helper to query observations of type `"mistake"`, `"bug_fix"`, `"learning"` that mention the target file path or its parent directory (all three types added in Task 3)
- Modify: `src/memory/config.ts` — extend `MemoryConfig` interface with `dnr: { blockMode: boolean }` field, add to `DEFAULT_CONFIG` with default `false`
- Test: `src/hooks/dnr-guard.test.ts`
- Test: `src/memory/dnr.test.ts`
- Test: `src/memory/config.test.ts` — add test verifying DNR default is warn-only

**Key Decisions / Notes:**

- DNR guard is **warn-only by default** — outputs a message like "⚠ Known issue with this file: [description]. Previously fixed in [date]." but does not block the write
- Configuration option in `src/memory/config.ts` (`dnr.blockMode`) to make it blocking (returns `{"decision": "block", "reason": "..."}`). MemoryConfig interface must be extended with this field.
- Queries observations where `context` field contains the file path and type is one of: `"mistake"`, `"bug_fix"`, `"learning"`
- Must be fast (<50ms) — uses SQLite FTS index, not vector search
- Follow pattern of `src/hooks/tdd-guard.ts` for PreToolUse hook structure
- OpenCode plugin: add to `PreToolUse.write` handler array

**Definition of Done:**

- [ ] DNR guard hook queries memory for file-related mistakes
- [ ] Warning message includes the matched observation content and date
- [ ] Hook registered in hooks.json for Write|Edit|MultiEdit
- [ ] Sidecar endpoint returns relevant DNR warnings
- [ ] OpenCode plugin has equivalent enforcement
- [ ] Warn-only is default behavior
- [ ] All tests pass
- [ ] No diagnostics errors

**Verify:**

- `bun test src/hooks/dnr-guard.test.ts`
- `bun test src/memory/dnr.test.ts`

---

## Runtime Environment

- **Sidecar:** `sentinal serve` — HTTP server on dynamic port (stored in `.sentinal/sidecar.port`)
- **MCP Server:** `sentinal mcp-server` — stdio transport
- **Dashboard:** `sentinal dashboard` — web UI
- **Design QC:** Requires running dev server on standard port + Chrome/Chromium installed
