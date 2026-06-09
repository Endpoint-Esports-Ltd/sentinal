# Decision: Phase 4 Hook Transport Architecture

**Date:** 2026-06-09  
**Status:** Decided  
**Deciders:** Evan

## Recommendation: MCP-tool for sync hot-path hooks; subprocess retained for async/full-payload hooks

---

## Context

Sentinal's 4 hot-path sync hooks (`tdd-guard`, `pre-edit-guide`, `file-checker`, `tool-redirect`) currently cost **~60–71ms each** due to Bun subprocess spawn overhead. Claude Code now supports three alternative hook transports: `type: "mcp_tool"` (CC 2.1.118), `type: "http"` (CC 2.1.63), and `type: "command"` with `args: []` exec form (CC 2.1.139).

The question was: which transport should the full Phase 4b implementation use?

---

## Benchmarks

| Transport             | Median latency | Cold-start       | Full HookInput? | Block/deny? |
| --------------------- | -------------- | ---------------- | --------------- | ----------- |
| subprocess (baseline) | ~65ms          | ~50ms            | Yes             | Yes         |
| HTTP (loopback)       | ~8.7ms         | 0 (sidecar warm) | Yes             | Yes         |
| MCP-tool (estimated)  | ~10–12ms       | 0 (MCP warm)     | Partial (vars)  | Yes         |
| HTTP (Unix socket)    | ~8.8ms         | 0 (sidecar warm) | Yes             | Yes         |

Both non-subprocess transports deliver a **~6–7× speedup**. The difference between them is negligible on latency.

Full data: `docs/benchmarks/phase4-baseline.json`, `docs/benchmarks/phase4-http-latency.json`  
Spike notes: `docs/spike-notes/phase4-mcp-tool-spike.md`, `docs/spike-notes/phase4-http-hook-spike.md`

---

## Decision Matrix

| MCP-tool works? | HTTP works? | Decision            |
| --------------- | ----------- | ------------------- |
| Yes             | Yes         | **Prefer MCP-tool** |

Both transports work. MCP-tool is preferred because:

1. **No port discovery problem.** HTTP hooks require a hardcoded port in `hooks.json`, but the sidecar binds a dynamic port at startup. MCP-tool hooks reach the MCP server by name (`"server": "sentinal"`) — always routable with no config drift.
2. **Server is already warm.** The Sentinal MCP server starts at CC session init. Zero additional setup needed (and `alwaysLoad: true` is now in `.mcp.json`).
3. **Variable substitution is sufficient for the hot-path hooks.** `tdd-guard`, `pre-edit-guide`, and `file-checker` need `${tool_input.file_path}`, `${session_id}`, and `${cwd}` — all available as MCP-tool hook input variables.

**HTTP hooks are Plan B** if MCP-tool proves unreliable in production (e.g. tool not available during the first few seconds of a session before MCP connects). The fixed-port approach (`--port 47123` sidecar start) would make HTTP viable.

---

## Hooks Classified by Transport Suitability

| Hook                        | Scope  | Current ms  | New transport  | Reason                                             |
| --------------------------- | ------ | ----------- | -------------- | -------------------------------------------------- |
| `tdd-guard`                 | shared | ~64ms       | **MCP-tool**   | Needs file_path + cwd; returns block/allow JSON    |
| `pre-edit-guide`            | shared | ~71ms       | **MCP-tool**   | Needs file_path + cwd; returns hint JSON           |
| `file-checker`              | claude | ~61ms       | **MCP-tool**   | Needs file_path; returns hints/block               |
| `tool-redirect`             | claude | ~60ms       | **subprocess** | Needs full tool_input (no vars for arbitrary keys) |
| `tdd-tracker`               | shared | N/A (async) | **subprocess** | Async — can't block; no benefit from MCP-tool      |
| `memory-observer`           | shared | N/A (async) | **subprocess** | Needs full tool_input + tool_response              |
| `context-monitor`           | shared | N/A (async) | **subprocess** | Async                                              |
| `prompt-context`            | shared | N/A         | **subprocess** | UserPromptSubmit; needs full prompt text           |
| `pre-compact`               | shared | N/A         | **subprocess** | Needs full transcript context                      |
| All session/lifecycle hooks | —      | N/A         | **subprocess** | Rare; no hot-path penalty                          |

**3 hooks converted to MCP-tool** (the three sync PreToolUse write hooks).  
**Remaining 11+ hooks stay on subprocess** — either async (can't block), need full payload, or are rare lifecycle events where spawn cost is irrelevant.

---

## New MCP Tools Required

The existing `tdd_status`, `check_diagnostics`, etc. return markdown text — not hook-decision JSON. Phase 4b needs thin hook-optimised MCP tools:

| New tool              | Input vars                       | Output                                        |
| --------------------- | -------------------------------- | --------------------------------------------- |
| `hook_tdd_guard`      | `file_path`, `cwd`, `session_id` | `{"decision":"block","reason":"..."}` or `{}` |
| `hook_pre_edit_guide` | `file_path`, `cwd`, `session_id` | `{"additionalContext":"..."}` or `{}`         |
| `hook_file_checker`   | `file_path`, `session_id`        | `{"additionalContext":"..."}` or `{}`         |

These are thin wrappers that reuse existing sidecar route logic and return the minimal JSON CC needs — not the human-readable markdown the current MCP tools return.

---

## Next Steps (Phase 4b Scope)

1. Add 3 new MCP tools (`hook_tdd_guard`, `hook_pre_edit_guide`, `hook_file_checker`) to `src/` — each calls the relevant sidecar endpoint and returns hook-decision JSON
2. Register them in `src/mcp/server.ts`
3. Update `targets/claude-code/hooks/hooks.json` — convert the 3 PreToolUse write hooks to `type: "mcp_tool"`
4. Keep all other hooks as `type: "command"` with `args: []` exec form (already done — Task 6)
5. Build + install + measure actual CC session latency with `sentinal sidecar logs` and CC hook timing

**Expected outcome:** PreToolUse write-hook overhead drops from ~196ms (3 × ~65ms sequential) to ~36ms (3 × ~12ms), with identical blocking/hinting behaviour.
