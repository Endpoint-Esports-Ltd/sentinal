## Sentinal MCP Servers

MCP tools are lazy-loaded via `ToolSearch`. Discover tools by keyword, then call them directly.

```
ToolSearch(query="keyword")        # Discover and load tools by keyword
ToolSearch(query="+server keyword") # Require a specific server prefix
ToolSearch(query="select:full_tool_name") # Load a specific tool by exact name
```

All Sentinal MCP servers use the `mcp__plugin_sentinal_` prefix. Tools are available immediately after ToolSearch returns them.

---

### mem-search — Persistent Memory

**Purpose:** Search past work, decisions, and context across sessions.

**3-step workflow (token-efficient — never skip to step 3):**

| Step | Tool | Purpose |
|------|------|---------|
| 1 | `search` | Find observations → returns index with IDs |
| 2 | `timeline` | Get chronological context around an anchor ID |
| 3 | `get_observations` | Fetch full details for specific IDs only |

| Tool | Key Params |
|------|------------|
| `search` | `query`, `limit`, `type`, `project`, `dateStart`, `dateEnd` |
| `timeline` | `anchor` (ID) or `query`, `depth_before`, `depth_after` |
| `get_observations` | `ids` (array, required) |
| `save_memory` | `text` (required), `title`, `project` |

**Types:** `bugfix`, `feature`, `refactor`, `discovery`, `decision`, `change`

```
ToolSearch(query="+mem-search search")

mcp__plugin_sentinal_mem-search__search(query="authentication flow", limit=5)
mcp__plugin_sentinal_mem-search__timeline(anchor=22865, depth_before=3, depth_after=3)
mcp__plugin_sentinal_mem-search__get_observations(ids=[22865, 22866])
mcp__plugin_sentinal_mem-search__save_memory(text="Important finding", title="Short title")
```

---

### context7 — Library Documentation

**Purpose:** Fetch up-to-date docs and code examples for any library/framework.

**2-step workflow:**

| Step | Tool | Purpose |
|------|------|---------|
| 1 | `resolve-library-id` | Find library ID from name |
| 2 | `query-docs` | Query docs using the resolved ID |

```
ToolSearch(query="+context7 resolve")

mcp__plugin_sentinal_context7__resolve-library-id(libraryName="nestjs", query="how to use guards")
# → returns libraryId like "/npm/@nestjs/core"
mcp__plugin_sentinal_context7__query-docs(libraryId="/npm/@nestjs/core", query="how to create and use guards")
```

Use descriptive queries. Max 3 calls per question per tool.

---

### web-search — Web Search

**Purpose:** Search the web via DuckDuckGo, Bing, or Exa (no API keys needed).

| Tool | Purpose | Key Params |
|------|---------|------------|
| `search` | Web search | `query` (required), `limit` (1-50), `engines` (duckduckgo/bing/exa) |
| `fetchGithubReadme` | Fetch GitHub repo README | `url` |

```
ToolSearch(query="+web-search search")

mcp__plugin_sentinal_web-search__search(query="Angular 20 signals best practices", limit=5)
mcp__plugin_sentinal_web-search__fetchGithubReadme(url="https://github.com/nestjs/nest")
```

---

### grep-mcp — GitHub Code Search

**Purpose:** Find real-world code examples from public repositories.

**Single tool:** `searchGitHub`

| Param | Type | Description |
|-------|------|-------------|
| `query` | string (required) | Literal code pattern |
| `language` | string[] | Filter by language: `["TypeScript"]` |
| `repo` | string | Filter by repo |
| `path` | string | Filter by file path |
| `useRegexp` | boolean | Regex mode |

```
ToolSearch(query="+grep-mcp searchGitHub")

mcp__plugin_sentinal_grep-mcp__searchGitHub(query="@Injectable()", language=["TypeScript"])
mcp__plugin_sentinal_grep-mcp__searchGitHub(query="standalone: true", language=["TypeScript"])
```

---

### web-fetch — Web Page Fetching

**Purpose:** Fetch full web pages via Playwright (no truncation, handles JS-rendered pages).

```
ToolSearch(query="+web-fetch fetch")

mcp__plugin_sentinal_web-fetch__fetch_url(url="https://docs.nestjs.com/guards")
```

---

### Tool Selection Quick Reference

| Need | Server/Tool | Reference |
|------|-------------|-----------|
| **Codebase search** | **Vexor** (`vexor "query"`) | `cli-tools.md` |
| Past work / decisions | mem-search | `search` → `timeline` → `get_observations` |
| Library/framework docs | context7 | `resolve-library-id` → `query-docs` |
| Web search | web-search | `search` |
| GitHub README | web-search | `fetchGithubReadme` |
| Production code examples | grep-mcp | `searchGitHub` |
| Full web page content | web-fetch | `fetch_url` / `fetch_urls` |
