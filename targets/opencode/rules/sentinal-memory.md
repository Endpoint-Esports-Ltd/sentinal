## Sentinal Memory & Learning

### Memory MCP Tools

Sentinal provides these MCP tools for direct memory operations:

| Tool              | Purpose                                                                      |
| ----------------- | ---------------------------------------------------------------------------- |
| `memory_save`     | Save observations (decisions, discoveries, errors, fixes, patterns)          |
| `memory_search`   | Semantic + keyword search across observations                                |
| `memory_get`      | Retrieve full observation details by ID                                      |
| `memory_timeline` | Chronological context around an observation                                  |
| `memory_stats`    | Database statistics (totals, breakdowns by type/project)                     |
| `memory_share`    | Promote observations to shared `.sentinal/project-memory.json` (committable) |

**Use `memory_save` proactively** for decisions, discoveries, error patterns, and fixes worth preserving across sessions. Use `memory_search` before starting work to check for relevant past context.

**Team sharing:** Use `memory_share` to promote valuable observations to `.sentinal/project-memory.json` — this file is committed to git and automatically restored for all team members.

See also `mcp-servers.md` → mem-search for the external 3-step search workflow.

Use `<private>` tags to exclude content from storage. Web viewer at the Sentinal dashboard.

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
