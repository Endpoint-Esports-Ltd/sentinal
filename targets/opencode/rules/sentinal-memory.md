## Sentinal Memory & Learning

### Memory Tools

See `mcp-servers.md` → mem-search for the 3-step search workflow and tool reference.

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
