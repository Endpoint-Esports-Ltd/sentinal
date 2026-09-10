## Research Tools

### Search Priority

**⛔ Vexor first, always.** Finds by intent, not exact text. Instant results (<0.3s). Run via Bash.

**Recall before re-deriving:** for anything that may have been decided/solved before (a design choice, a past bug, an established pattern), also run `memory_search` — recalling a prior decision is cheaper than re-deriving it. Best-effort; if empty, continue.

**Fallback chain:** Vexor (`vexor "query"`) → Grep/Glob (exact patterns) → Explore sub-agent (multi-step reasoning only)

Full Vexor reference in `cli-tools.md`. Full MCP tool reference in `mcp-servers.md`.

### Tool Selection Guide

| Need                         | Tool                        | Notes                                              |
| ---------------------------- | --------------------------- | -------------------------------------------------- |
| **Codebase search**          | **Vexor** (`vexor "query"`) | Always first. Semantic, by intent. Run via Bash.   |
| Exact pattern / known symbol | Grep / Glob                 | Only after Vexor misses                            |
| Library/framework docs       | Context7 (MCP)              | `resolve-library-id` → `query-docs`                |
| Production code examples     | grep-mcp (MCP)              | Literal code patterns, not keywords                |
| Web search                   | web-search (MCP)            | DuckDuckGo/Bing/Exa                                |
| Full web page                | web-fetch (MCP)             | Playwright-based, handles JS                       |
| GitHub README                | web-search (MCP)            | `fetchGithubReadme`                                |
| GitHub operations            | `gh` CLI                    | Authenticated, `--json` + `--jq`                   |
| Past work / decisions        | memory_search (MCP)         | `memory_search` → `memory_timeline` → `memory_get` |

### ⛔ Explore Agent

**NEVER use Agent(subagent_type="Explore") as a first choice — blocked by hook.** Explore spawns a sub-agent that duplicates what Vexor does instantly. Run multiple `vexor` calls instead. Only consider Explore after Vexor AND Grep/Glob both fail AND you need multi-step reasoning across many files.

### ⛔ Web Search/Fetch

**NEVER use built-in `WebFetch` or `WebSearch` — blocked by hook.** Use MCP alternatives via `ToolSearch`:

| Need          | ToolSearch query     |
| ------------- | -------------------- |
| Web search    | `+web-search search` |
| GitHub README | `+web-search fetch`  |
| Fetch page    | `+web-fetch fetch`   |
