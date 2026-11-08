## Sentinal Memory & Learning

### Memory MCP Tools

Sentinal provides these MCP tools for direct memory operations:

| Tool              | Purpose                                                                      |
| ----------------- | ---------------------------------------------------------------------------- |
| `memory_save`     | Save observations (decisions, discoveries, errors, fixes, patterns)          |
| `memory_search`   | Semantic + keyword search across observations                                |
| `memory_get`      | Retrieve full observation details by ID                                      |
| `memory_update`   | Correct/supersede an existing observation in place by ID (refreshes recency) |
| `memory_delete`   | Delete an observation by ID (destructive — removes it from search)           |
| `memory_timeline` | Chronological context around an observation                                  |
| `memory_stats`    | Database statistics (totals, breakdowns by type/project)                     |
| `memory_share`    | Promote observations to shared `.sentinal/project-memory.json` (committable) |

**Recall before you start.** At the beginning of any non-trivial task — and again at a pivot point (a stuck fix, a library/architecture decision, an invalidated assumption) — run `memory_search` for prior decisions, bugs, and patterns in that area. Recalling a past decision is cheaper than re-deriving it. Best-effort: if empty or unavailable, continue.

**Save proactively.** Use `memory_save` for decisions, discoveries, error patterns, and fixes worth preserving across sessions (types: `decision`, `discovery`, `error`, `fix`, `pattern`).

**Correct in place — don't stack corrections.** When a saved observation turns out wrong or outdated, prefer `memory_update(id, …)` (find the `id` via `memory_search`) over saving a new "CORRECTION" observation. Updating fixes the fact AND refreshes its recency + quality so the corrected version ranks fresh and the stale original stops surfacing. Use `memory_delete(id)` to remove now-redundant corrections. Endless CORRECTION chains bloat search and re-surface the very text you meant to retire.

**Team sharing:** Use `memory_share` to promote valuable observations to `.sentinal/project-memory.json` — this file is committed to git and automatically restored for all team members.

See also `mcp-servers.md` → the `memory` tools (`memory_search` → `memory_timeline` → `memory_get`) for the 3-step read workflow.

Use `<private>` tags to exclude content from storage. Web viewer at the Sentinal dashboard.

---

### Working in another repository

A session may edit files in other git repositories. Sentinal keys each file's memories, TDD state and hints by **that file's** repository, and the first time you edit a file in another repository its `.sentinal/rules` are added to your context (once per session; again after compaction).

- Pass that repository's path as `project` to `memory_save`, `memory_search`, `quality_report` and `spec_register` when the work is about it.
- `memory_search({query, scope: "related"})` searches this project plus the projects declared in its `.sentinal/related.json`; `scope: "all"` searches every project.
- Declare related repositories in `.sentinal/related.json` (committed): `{ "projects": [{ "name": "api", "path": "../api" }] }` — `path` relative to this checkout or absolute. Session start lists them, plus undeclared repositories this project's sessions saved memories for.

---

### Keeping memory fresh

Observations lose quality with age so stale facts sink in search. This happens automatically — you rarely need to touch it.

- **Quality decays with age**, per type (rough half-life ordering): `decision` (slowest) → `discovery` → `pattern` → `fix` → `error` (fastest). Scores never fall below `0.1`, so nothing becomes unfindable — it just ranks lower. `memory_update` resets an observation's age (and quality), making a corrected fact fresh again.
- **Decay auto-runs ~daily.** The Sentinal sidecar runs a throttled decay pass on startup (at most once per 24h), so freshness is maintained with no action from you.
- **Manual controls (CLI):**

  ```bash
  sentinal memory decay --dry-run          # preview decay, write nothing
  sentinal memory maintain stats           # DB stats
  sentinal memory maintain prune --older-than 180d          # dry-run (default): shows what WOULD be pruned
  sentinal memory maintain prune --older-than 180d --apply  # actually delete (destructive, unrecoverable)
  ```

  `prune` is destructive and defaults to a dry-run — it only deletes with `--apply`.

---

### Online Learning System

**Evaluate sessions for extractable knowledge. Only act when valuable.**

At ~80%+ context (when `/learn check` reminder fires):

1. Does this session have a non-obvious solution OR repeatable workflow?
2. **YES** → Invoke `Skill(learn)` before auto-compaction
3. **NO** → Proceed silently, no mention needed

**Triggers for automatic `Skill(learn)` invocation:**

- Non-obvious debugging (solution wasn't in docs)
- Workarounds for limitations
- Undocumented tool/API integration
- Multi-step workflow that will recur
- External service queries (Jira, GitHub, Confluence)

**Don't extract:** Simple tasks, single-step fixes, knowledge in official docs, unverified solutions.
