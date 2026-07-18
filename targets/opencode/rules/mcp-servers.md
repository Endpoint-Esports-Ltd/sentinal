## Sentinal MCP Servers

MCP tools are lazy-loaded via `ToolSearch`. Discover tools by keyword, then call them directly.

```
ToolSearch(query="keyword")        # Discover and load tools by keyword
ToolSearch(query="+server keyword") # Require a specific server prefix
ToolSearch(query="select:full_tool_name") # Load a specific tool by exact name
```

All Sentinal MCP servers use the `mcp__plugin_sentinal_` prefix. Tools are available immediately after ToolSearch returns them.

---

### memory — Persistent Memory (sentinal server)

**Purpose:** Recall past work, decisions, and context across sessions; persist new ones.

**3-step read workflow (token-efficient — never skip to step 3):**

| Step | Tool              | Purpose                                       |
| ---- | ----------------- | --------------------------------------------- |
| 1    | `memory_search`   | Find observations → returns index with IDs    |
| 2    | `memory_timeline` | Get chronological context around an anchor ID |
| 3    | `memory_get`      | Fetch full details for specific IDs only      |

| Tool              | Key Params                                               |
| ----------------- | -------------------------------------------------------- |
| `memory_search`   | `query` (required), `project`, `type`, `limit`           |
| `memory_timeline` | `anchor` (ID, required), `depth`, `project`              |
| `memory_get`      | `ids` (array, required)                                  |
| `memory_save`     | `title`, `content`, `type` (required), `project`, `tags` |
| `memory_stats`    | (none)                                                   |
| `memory_share`    | `ids`, `project`                                         |

**Observation types:** `decision`, `discovery`, `error`, `fix`, `pattern`.

```
memory_search(query="authentication flow", project="/path/to/repo", limit=5)
memory_timeline(anchor=22865, depth=3)
memory_get(ids=[22865, 22866])
memory_save(title="Short title", content="Important finding", type="discovery", project="/path/to/repo")
```

---

### context7 — Library Documentation

**Purpose:** Fetch up-to-date docs and code examples for any library/framework.

**2-step workflow:**

| Step | Tool                 | Purpose                          |
| ---- | -------------------- | -------------------------------- |
| 1    | `resolve-library-id` | Find library ID from name        |
| 2    | `query-docs`         | Query docs using the resolved ID |

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

| Tool                | Purpose                  | Key Params                                                          |
| ------------------- | ------------------------ | ------------------------------------------------------------------- |
| `search`            | Web search               | `query` (required), `limit` (1-50), `engines` (duckduckgo/bing/exa) |
| `fetchGithubReadme` | Fetch GitHub repo README | `url`                                                               |

```
ToolSearch(query="+web-search search")

mcp__plugin_sentinal_web-search__search(query="Angular 20 signals best practices", limit=5)
mcp__plugin_sentinal_web-search__fetchGithubReadme(url="https://github.com/nestjs/nest")
```

---

### grep-mcp — GitHub Code Search

**Purpose:** Find real-world code examples from public repositories.

**Single tool:** `searchGitHub`

| Param       | Type              | Description                          |
| ----------- | ----------------- | ------------------------------------ |
| `query`     | string (required) | Literal code pattern                 |
| `language`  | string[]          | Filter by language: `["TypeScript"]` |
| `repo`      | string            | Filter by repo                       |
| `path`      | string            | Filter by file path                  |
| `useRegexp` | boolean           | Regex mode                           |

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

| Need                     | Server/Tool                 | Reference                                          |
| ------------------------ | --------------------------- | -------------------------------------------------- |
| **Codebase search**      | **Vexor** (`vexor "query"`) | `cli-tools.md`                                     |
| Past work / decisions    | memory (sentinal)           | `memory_search` → `memory_timeline` → `memory_get` |
| Library/framework docs   | context7                    | `resolve-library-id` → `query-docs`                |
| Web search               | web-search                  | `search`                                           |
| GitHub README            | web-search                  | `fetchGithubReadme`                                |
| Production code examples | grep-mcp                    | `searchGitHub`                                     |
| Full web page content    | web-fetch                   | `fetch_url` / `fetch_urls`                         |
