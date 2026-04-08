# Sentinal MCP Server (Self-Hosted)

The only MCP server this repo configures at the project level is **`sentinal`** itself (see `targets/claude-code/.mcp.json` and `targets/opencode/opencode.json`). It's a single server exposing **26 tools across 6 domains**, all registered by `createSentinalServer()` in `src/mcp/server.ts:36`.

> **Note:** Sentinal *also* ships global MCP server configurations for `context7`, `web-search`, `grep-mcp`, and `web-fetch` — those are installed once into the user's Claude Code / OpenCode config by the installer and are NOT documented here.

## Invocation

```jsonc
// targets/claude-code/.mcp.json
{
  "mcpServers": {
    "sentinal": {
      "command": "sentinal",
      "args": ["mcp-server"]
    }
  }
}
```

Equivalent to running `sentinal mcp-server` or `bun run mcp` locally.

## Tool Catalog

### Memory Domain (`src/memory/mcp-tools.ts`) — 6 tools

| Tool              | Purpose                                                                     |
| ----------------- | --------------------------------------------------------------------------- |
| `memory_search`   | Semantic + keyword search over SQLite-vec vector store                      |
| `memory_timeline` | Chronological context around an anchor observation                          |
| `memory_get`      | Fetch full observation details by ID                                        |
| `memory_save`     | Save a decision/discovery/error/fix/pattern observation                     |
| `memory_maintain` | Maintenance ops (prune, reindex)                                            |
| `memory_stats`    | Database statistics (observation counts, project breakdown)                 |

### Spec Workflow Domain (`src/spec/mcp-tools.ts`) — 9 tools

| Tool               | Purpose                                             |
| ------------------ | --------------------------------------------------- |
| `spec_init`        | Get all workflow context in one call                |
| `spec_status`      | Current active plan, progress, remaining tasks      |
| `spec_register`    | Register/update a plan in the SQLite index          |
| `spec_plan_parse`  | Parse a plan .md file into structured metadata      |
| `spec_config`      | Read `SENTINAL_*` env config snapshot               |
| `spec_events`      | Recent lifecycle events for a spec                  |
| `spec_metrics`     | Per-task timing + plan duration                     |
| `spec_notify`      | Create a dashboard notification                     |
| `spec_wait_file`   | Block until a reviewer-output file appears          |

### TDD Domain (`src/tdd/mcp-tools.ts`) — 3 tools

| Tool             | Purpose                                        |
| ---------------- | ---------------------------------------------- |
| `tdd_status`     | Read TDD cycle state (per file or all active) |
| `tdd_set_state`  | Transition state: IDLE/TEST_WRITTEN/RED/GREEN |
| `tdd_clear`      | Clear state for a file or entire spec         |

### Worktree Domain (`src/worktree/mcp-tools.ts`) — 4 tools

| Tool               | Purpose                                        |
| ------------------ | ---------------------------------------------- |
| `worktree_detect`  | Find worktree for a plan slug                  |
| `worktree_create`  | Create a git worktree for a plan               |
| `worktree_diff`    | Summarize file changes, insertions, deletions  |
| `worktree_sync`    | Squash-merge worktree back to base (destructive)|

### Analysis Domain (`src/analysis/mcp-tools.ts`) — 3 tools

| Tool                | Purpose                                                                     |
| ------------------- | --------------------------------------------------------------------------- |
| `check_diagnostics` | Filtered TypeScript diagnostics with NEW/FIXED delta tracking               |
| `impact_analysis`   | Expected vs unexpected changes, file-length violations, LOW/MED/HIGH risk   |
| `quality_report`    | Run tsc/eslint/prettier via sidecar `/quality-check` endpoint               |

### Project Domain (`src/project/mcp-tools.ts`) — 1 tool

| Tool              | Purpose                                                            |
| ----------------- | ------------------------------------------------------------------ |
| `project_context` | Tech stack, directory layout, key commands, conventions (cached)   |

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
