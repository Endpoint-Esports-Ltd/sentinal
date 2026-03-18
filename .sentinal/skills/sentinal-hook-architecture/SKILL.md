---
name: sentinal-hook-architecture
description: |
  Decision framework for where to implement new sidecar-dependent functionality.
  Use when: (1) adding a new feature that needs sidecar access (DB, spec state, TDD),
  (2) deciding between MCP tool, Claude Code hook, or OpenCode plugin handler,
  (3) evaluating performance trade-offs for new hook/tool implementations.
author: Claude Code
version: 1.0.0
---

# Hook Architecture Decision Framework

## When to Use

- Adding new functionality that needs sidecar access (SQLite, spec state, TDD, memory)
- Deciding where to put new event-reactive logic
- Optimizing existing hooks for performance

## Decision Matrix

| Need | Best Path | Why |
|------|-----------|-----|
| **React to tool calls** (intercept/block/hint) | Claude Code hook / OpenCode `tool.execute.before`/`after` | Only hooks can intercept before execution |
| **On-demand sidecar query** (user or AI initiated) | MCP tool | ~5-20ms, long-lived connection, no process spawn |
| **Side-effect after tool call** (logging, tracking) | OpenCode plugin async phase / Claude Code async hook | Fire-and-forget, non-blocking |
| **Session lifecycle** (start, end, compaction) | Claude Code hook / OpenCode `event` handler | Platform-specific lifecycle events |
| **Context injection** (every prompt or compaction) | Claude Code `UserPromptSubmit` hook / OpenCode `session.compacting` | Platform-specific injection APIs |

## Performance by Path

| Path | Per-Call Overhead | Process Model | Connection |
|------|------------------|---------------|------------|
| **OpenCode plugin** | ~1-5ms | In-process (same Node.js runtime) | Single SidecarClient, closure-captured |
| **MCP tool** (both platforms) | ~5-20ms | Long-running child process (stdio) | Single SidecarClient at startup |
| **Claude Code hook** | ~50-200ms | NEW child process per event | New SidecarClient.connect() each time |

### Claude Code Hook Overhead Breakdown

- Process spawn: ~30-80ms (Bun compiled binary cold start)
- CLI/Commander init: ~10-30ms
- Dynamic import: ~2-5ms
- SidecarClient.connect(): ~5-15ms (existsSync + health probe)
- Event buffer file I/O: ~5-10ms
- Actual sidecar request: ~2-5ms

### Key Architectural Differences

| Aspect | OpenCode Plugin | Claude Code Hooks |
|--------|----------------|-------------------|
| Execution | In-process function call | Shell command -> new process |
| State | Closure variables persist across calls | Serialized to disk per invocation |
| Sidecar client | Created once, reused via closure | Fresh connect() per hook |
| Event buffer | In-memory, never touches disk | File-backed `event-buffer.json` |
| Compaction | Direct `output.context.push()` | File-mediated via `compact-state.json` |

## Gotchas

1. **OpenCode `tool.execute.after` tool names** — `input.tool` uses OpenCode built-in names (`"write"`, `"edit"`, `"bash"`). MCP tool calls have different names (e.g., `"sentinal_memory_search"`). The `MEMORY_TOOLS` filter won't match MCP tools.

2. **Claude Code `"async": true`** — Async hooks CAN return `additionalContext` (delivered next turn) but CANNOT return `decision`, `permissionDecision`, or `continue`.

3. **Claude Code `UserPromptSubmit`** — Does NOT support matchers. Fires on every prompt. Keep fast (<50ms).

4. **OpenCode `session.created`** — `client.app.log()` writes to TUI panel only, NOT LLM context. To inject into LLM context, write to `compact-state.json` for the compaction handler to pick up.

5. **Subagent `mcpServers` frontmatter** — Claude Code supports inline MCP server definitions in subagent `.md` frontmatter. OpenCode does NOT support per-agent MCP scoping.

## Verification

When adding a new hook/tool, verify:

```bash
# Check sidecar is receiving requests
tail -f ~/.sentinal/plugin.debug.log  # OpenCode plugin log
tail -f ~/.sentinal/sidecar.log       # Sidecar log

# Check sidecar health
curl -s http://127.0.0.1:$(cat ~/.sentinal/sidecar.port)/health

# Verify TDD state
curl -s "http://127.0.0.1:$(cat ~/.sentinal/sidecar.port)/tdd-state?file=<path>"
```

## When NOT to Use

- Choosing between frontend frameworks or libraries
- Non-sidecar functionality (pure file checks, formatting)
- OpenCode-only or Claude Code-only features (no cross-platform decision needed)
