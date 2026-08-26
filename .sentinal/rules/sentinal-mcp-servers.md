# Sentinal MCP Server (Self-Hosted)

The only MCP server this repo configures at the project level is **`sentinal`** itself (see `targets/claude-code/.mcp.json` and `targets/opencode/opencode.json`). It's a single server exposing **36 tools across 7 domains**, all registered by `createSentinalServer()` in `src/mcp/server.ts:36`.

> ⚠️ This count was previously stated as "28 tools across 6 domains" and was already wrong before the runtime domain existed — the real pre-Phase-3 figure was **31 across 6** (the Memory table below was missing `memory_update`, `memory_delete` and `memory_share`). `src/mcp/server.test.ts` now asserts registration, so a domain that is never wired in is caught; the COUNT is still hand-maintained.

> **Note:** Sentinal _also_ ships global MCP server configurations for `context7`, `web-search`, `grep-mcp`, and `web-fetch` — those are installed once into the user's Claude Code / OpenCode config by the installer and are NOT documented here.

## Invocation

```jsonc
// targets/claude-code/.mcp.json
{
  "mcpServers": {
    "sentinal": {
      "command": "sentinal",
      "args": ["mcp-server"],
    },
  },
}
```

Equivalent to running `sentinal mcp-server` or `bun run mcp` locally.

## Tool Catalog

### Memory Domain (`src/memory/mcp-tools.ts`) — 9 tools

| Tool              | Purpose                                                     |
| ----------------- | ----------------------------------------------------------- |
| `memory_search`   | Semantic + keyword search over SQLite-vec vector store      |
| `memory_timeline` | Chronological context around an anchor observation          |
| `memory_get`      | Fetch full observation details by ID                        |
| `memory_save`     | Save a decision/discovery/error/fix/pattern observation     |
| `memory_update`   | Correct/supersede an observation in place, refreshing it    |
| `memory_delete`   | Delete an observation (destructive, unrecoverable)          |
| `memory_share`    | Promote observations to `.sentinal/project-memory.json`     |
| `memory_maintain` | Maintenance ops (prune, reindex)                            |
| `memory_stats`    | Database statistics (observation counts, project breakdown) |

### Spec Workflow Domain (`src/spec/mcp-tools.ts`) — 9 tools

| Tool              | Purpose                                        |
| ----------------- | ---------------------------------------------- |
| `spec_init`       | Get all workflow context in one call           |
| `spec_status`     | Current active plan, progress, remaining tasks |
| `spec_register`   | Register/update a plan in the SQLite index     |
| `spec_plan_parse` | Parse a plan .md file into structured metadata |
| `spec_config`     | Read `SENTINAL_*` env config snapshot          |
| `spec_events`     | Recent lifecycle events for a spec             |
| `spec_metrics`    | Per-task timing + plan duration                |
| `spec_notify`     | Create a dashboard notification                |
| `spec_wait_file`  | Block until a reviewer-output file appears     |

### TDD Domain (`src/tdd/mcp-tools.ts`) — 3 tools

| Tool            | Purpose                                       |
| --------------- | --------------------------------------------- |
| `tdd_status`    | Read TDD cycle state (per file or all active) |
| `tdd_set_state` | Transition state: IDLE/TEST_WRITTEN/RED/GREEN |
| `tdd_clear`     | Clear state for a file or entire spec         |

### Worktree Domain (`src/worktree/mcp-tools.ts`) — 6 tools

| Tool               | Purpose                                          |
| ------------------ | ------------------------------------------------ |
| `worktree_detect`  | Find worktree for a plan slug                    |
| `worktree_create`  | Create a git worktree for a plan                 |
| `worktree_diff`    | Summarize file changes, insertions, deletions    |
| `worktree_sync`    | Squash-merge worktree back to base (destructive) |
| `worktree_abandon` | Remove worktree from disk and mark abandoned     |
| `worktree_cleanup` | Clean up all stale worktrees missing from disk   |

### Analysis Domain (`src/analysis/mcp-tools.ts`) — 4 tools

| Tool                | Purpose                                                                              |
| ------------------- | ------------------------------------------------------------------------------------ |
| `check_diagnostics` | Filtered TypeScript diagnostics with NEW/FIXED delta tracking                        |
| `impact_analysis`   | Expected vs unexpected changes, file-length violations, LOW/MED/HIGH risk            |
| `plan_impact`       | **Prospective** — same-wave file-overlap detection + reach on a plan's claimed files |
| `quality_report`    | Run tsc/eslint/prettier via sidecar `/quality-check` endpoint                        |

`plan_impact` is the prospective counterpart to `impact_analysis`, which is driven by
`git diff --name-only HEAD` and therefore answers "0 files changed" during planning. Its two halves
have **different epistemic standing and the output says so** (D4): same-wave overlap detection is
deterministic on the plan text, needs no injected `reach` and no code-graph tool, and is the only
enforcement of `spec-plan.md`'s otherwise prose-only rule; prospective reach is bounded by the
accuracy of the plan's `Files:` prediction and is rendered as a hint.

⛔ Reach is scored on **on-disk existence, never the verb**. `countTransitiveImporters` has no node
for a file that does not exist, and half this repo's plan corpus uses an inline `**Files:**` form
that states no verb at all — keying on `Create:` would score a plan of mostly-new files as LOW.
Non-existent targets are reported separately and explicitly unscored.

### Runtime Domain (`src/runtime/mcp-tools.ts` + `lifecycle-mcp-tools.ts`) — 4 tools

| Tool             | Purpose                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| `runtime_config` | Resolve/validate/interpolate `.sentinal/runtime.json` (up, readiness, down, isolation)          |
| `runtime_init`   | DRAFT a contract from compose/package.json/Procfile — never writes it                           |
| `runtime_up`     | Spawn `up` detached into an owned process group, write the pidfile, poll `readiness`            |
| `runtime_stop`   | **DESTRUCTIVE** — `down`, then SIGTERM→grace→SIGKILL to **that group only**, ownership-verified |

`runtime_up` / `runtime_stop` live in the sibling `src/runtime/lifecycle-mcp-tools.ts` (with the
preflight in `src/runtime/preflight.ts`) purely for length — `mcp-tools.ts` would have breached 400.
`registerRuntimeTools` calls `registerRuntimeLifecycleTools`, so `src/mcp/server.ts` needs no change
and the "one registration function per domain" rule below still holds.

⛔ **Direct-only, and deliberately so.** Unlike every other domain, `registerRuntimeTools` ignores its
`{client, store}` deps: this is a stateless fs read of a path derived from the tool's own `project`
argument, so the sidecar's warm SQLite/embedding/LSP state buys nothing. (`src/sidecar/client.ts` at
582/600 lines is a second, independent reason.) Do not "fix" the unused deps by adding a route. The
same holds for the two lifecycle tools: the ownership record is a **worktree-local pidfile**, checked
for staleness on read, so there is nothing warm to keep and no sweep to run (D5).

⛔ **`runtime_stop` is the only thing in the codebase that signals a process group**, and it asks
`src/runtime/ownership.ts` first, every time. **Never add a second signalling path.** If ownership
cannot be verified it must REFUSE — an unverifiable PID may have been recycled onto someone else's
process, which is the failure `pkill -f` embodies and this tool exists to replace.

### Project Domain (`src/project/mcp-tools.ts`) — 1 tool

| Tool              | Purpose                                                          |
| ----------------- | ---------------------------------------------------------------- |
| `project_context` | Tech stack, directory layout, key commands, conventions (cached) |

## Design Rules

1. **All tool modules take `{ client, store }`.** If `client` (a `SidecarClient`) is provided, delegate to the sidecar to avoid hot SQLite open. Fall back to direct `store` only when no client is available.
2. **Tools are registered once per server.** `createSentinalServer()` calls all six `registerXxxTools()` functions; adding a new tool means editing the matching `src/<domain>/mcp-tools.ts` and nothing else.
3. **MCP tool names use `snake_case`** (e.g., `memory_search`, not `memorySearch` or `memory-search`). The MCP client prefixes them as `sentinal_<tool>` when surfacing to the agent.
4. **Read-only tools first.** Destructive tools (`worktree_sync`, `memory_maintain`) must be flagged clearly in their description for safety review.

## Testing MCP Tools

```bash
# Start the server manually and send a JSON-RPC request via stdio
bun run mcp

# Or drive it through the sidecar (since tools delegate when client is set)
bun test src/memory/mcp-tools.test.ts
bun test src/spec/mcp-tools.test.ts
```

## Smoke Test Checklist After Adding a Tool

- [ ] Tool registered in `src/<domain>/mcp-tools.ts`
- [ ] Tool appears in `createSentinalServer()` registration chain (via the domain's `registerXxxTools` function)
- [ ] Unit test added in `src/<domain>/mcp-tools.test.ts`
- [ ] Sidecar path added if the tool needs new HTTP routes (see `sentinal-sidecar.md`)
- [ ] Tool respects `{ client, store }` injection pattern
- [ ] Name uses `snake_case`
- [ ] **Counts above updated** — the domain table AND the header figure. Both are hand-maintained; `src/mcp/server.test.ts` asserts that a tool is registered, not how many there are.
- [ ] **`README.md`'s "Sentinal MCP Tool Catalog" updated too** — it carries the same figure and the same per-domain table, and the two drift independently.

### Run record — `runtime_up` / `runtime_stop` (2026-08-09)

| Item                        | Result                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| Registered in the domain    | ✅ `lifecycle-mcp-tools.ts`, called by `registerRuntimeTools` (`mcp-tools.ts:52`)                      |
| In `createSentinalServer()` | ✅ via `registerRuntimeTools` (`src/mcp/server.ts:67`) — asserted in `src/mcp/server.test.ts:92-93`    |
| Unit test                   | ✅ `src/runtime/lifecycle-mcp-tools.test.ts` (registration, idempotence, refusal, DESTRUCTIVE wording) |
| Sidecar route               | ➖ **None, by design (D5).** The ownership record is a worktree-local pidfile, not sidecar state       |
| `{client, store}` injection | ➖ Domain is direct-only, as documented above                                                          |
| `snake_case`                | ✅                                                                                                     |
| Counts updated              | ✅ header 33→35, Runtime table 2→4, and the same two in `README.md`                                    |
