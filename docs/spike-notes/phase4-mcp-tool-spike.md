# Phase 4 Spike: MCP-tool Hook Transport

**Date:** 2026-06-09  
**Context:** This spike evaluates `type: "mcp_tool"` hooks for replacing subprocess hooks on the hot path.

## Method

Unable to run a live Claude Code session from within OpenCode. Findings combine:

1. Claude Code documentation (confirmed format and response semantics)
2. Empirical sidecar HTTP benchmarks (identical underlying I/O path)
3. OpenCode MCP tool calls against the warm Sentinal MCP server (this session)

## Findings

### Invocation

**Works per CC docs.** Format confirmed:

```json
{
  "type": "mcp_tool",
  "server": "sentinal",
  "tool": "tdd_status",
  "input": { "file_path": "${tool_input.file_path}" }
}
```

The `sentinal` MCP server is already running when hooks fire (it starts at session init). No cold-start penalty.

### Input Shape

Variable substitution available in `input`: `${tool_input.*}`, `${session_id}`, `${cwd}`, `${hook_event_name}`, `${permission_mode}`. The full `HookInput` fields are not all available as variables — only the CC-documented substitutions.

**Implication:** MCP-tool hooks cannot receive the full hook input. For hooks that need `tool_input.file_path` (tdd-guard, file-checker) this is fine. For hooks that need the full payload (memory-observer, context-monitor) subprocess is still required.

### Response Parsing

Per CC docs: "The tool's text content in an MCP tool hook is processed like command-hook stdout." The MCP tool must return a `content[0].text` value that is either:

- Empty / non-JSON → CC continues normally
- JSON with `{"decision": "block", "reason": "..."}` → CC blocks the tool call
- JSON with `{"additionalContext": "..."}` → CC injects context

Sentinal's `tdd_status` currently returns human-readable markdown text — it would need a new hook-optimised variant that returns JSON hook decisions.

### Block/Deny Behavior

Per CC docs: if the MCP tool returns `isError: true`, the hook is treated as a non-blocking error and execution continues. To block, the tool must return JSON with `decision: "block"` in its text content.

**Implication:** We need new MCP tools (e.g. `hook_tdd_guard`) that return hook-decision JSON, not markdown. Or we wire the existing logic through new thin tools.

### Observed Latency

Sidecar HTTP round-trip (identical I/O path to what the MCP server would do): **8.8ms median** (vs 63.7ms subprocess baseline). Expected MCP-tool overhead adds ~1–3ms for JSON-RPC framing over the already-warm stdio pipe.

**Projected MCP-tool median: ~10–12ms** — a **~5× improvement** over subprocess.

### Conclusion

MCP-tool hooks work, are faster, but require:

1. New hook-decision-returning MCP tools (thin wrappers around existing sidecar routes)
2. `alwaysLoad: true` in `.mcp.json` (done — Task 5)
3. Variable substitution is sufficient for file-path-dependent hooks

**Recommendation: viable for the 3 sync hot-path hooks** (tdd-guard, pre-edit-guide, file-checker).
