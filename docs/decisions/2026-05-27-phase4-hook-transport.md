# Decision: Phase 4 Hook Transport Architecture

**Date:** 2026-06-09  
**Status:** Decided  
**Deciders:** Evan

## Recommendation: MCP-tool for sync hot-path hooks; subprocess retained for async/full-payload hooks

> **Re-verified live 2026-10-12 (Claude Code 2.1.287).** The 2026-06-09 findings came from the CC
> docs and curl. The live re-run confirmed invocation, `${tool_input.*}` substitution, block and
> `additionalContext` for both transports (`${tool_input.file_path}`, `${session_id}`, `${cwd}` and
> `${hook_event_name}` all observed, on PreToolUse and PostToolUse), and **corrected two claims**: (1) a plugin-provided
> server must be referenced as **`plugin:sentinal:sentinal`** — `"sentinal"` is skipped as "not
> connected", even from the plugin's own `hooks.json`; (2) MCP-tool latency is measured, not
> estimated. Both transports **fail open** when their server is unavailable. Details:
> `docs/spike-notes/phase4-*-spike.md`. The recommendation stands.

---

## Context

Sentinal's 4 hot-path sync hooks (`tdd-guard`, `pre-edit-guide`, `file-checker`, `tool-redirect`) currently cost **~60–71ms each** due to Bun subprocess spawn overhead. Claude Code now supports three alternative hook transports: `type: "mcp_tool"` (CC 2.1.118), `type: "http"` (CC 2.1.63), and `type: "command"` with `args: []` exec form (CC 2.1.139).

The question was: which transport should the full Phase 4b implementation use?

---

## Benchmarks

| Transport             | Median latency | Cold-start       | Full HookInput? | Block/deny? |
| --------------------- | -------------- | ---------------- | --------------- | ----------- |
| subprocess (baseline) | ~65ms          | ~50ms            | Yes             | Yes         |
| HTTP (loopback, curl) | ~8.7ms         | 0 (sidecar warm) | Yes             | Yes         |
| HTTP hook (live CC)   | 2–7ms          | 0 (server warm)  | Yes (observed)  | Yes (obs.)  |
| MCP-tool (live CC)    | 2–4ms          | 0 (MCP warm)     | Partial (vars)  | Yes (obs.)  |
| HTTP (Unix socket)    | n/a            | —                | —               | —           |

The Unix-socket row is **not an option**: CC's HTTP hooks reject every Unix-socket URL form (observed;
the 8.8 ms was a curl measurement of the sidecar, not a hook).

Both non-subprocess transports are roughly **10–30× faster** than subprocess on the live samples
(2–7 ms vs ~64 ms). The live figures are 1–3 debug-log samples each, not hyperfine medians, so treat
the ratio as an order of magnitude. The difference between the two transports is negligible.

Full data: `docs/benchmarks/phase4-baseline.json`, `docs/benchmarks/phase4-http-latency.json`  
Spike notes: `docs/spike-notes/phase4-mcp-tool-spike.md`, `docs/spike-notes/phase4-http-hook-spike.md`

---

## Decision Matrix

| MCP-tool works? | HTTP works? | Decision            |
| --------------- | ----------- | ------------------- |
| Yes             | Yes         | **Prefer MCP-tool** |

Both transports work. MCP-tool is preferred because:

1. **No port discovery problem.** HTTP hooks require a hardcoded port in `hooks.json`, but the sidecar binds a dynamic port at startup. MCP-tool hooks reach the MCP server by name — but the name must be the **qualified** `"server": "plugin:sentinal:sentinal"` for the plugin install (observed 2026-10-12; `"sentinal"` is skipped and the hook fails open). A non-plugin install would register `sentinal`, so `hooks.json` targets the plugin install only.
2. **Server is already warm.** The Sentinal MCP server starts at CC session init. Zero additional setup needed (and `alwaysLoad: true` is now in `.mcp.json`).
3. **Variable substitution is sufficient for the converted hooks.** `pre-edit-guide` and `file-checker` need `${tool_input.file_path}`, `${session_id}`, and `${cwd}` — all observed substituted live (2026-10-12).

**Fail-open risk — decision (confirmed by Evan 2026-10-12).** Both transports turn an unreachable server into a non-blocking error and let the tool call proceed (observed), so a misnamed or disconnected server silently disables whatever hook it carries. Therefore:

- **`tdd-guard` stays on subprocess.** It is the only hook whose job is to *block*; trading a guard that can fail open by misconfiguration for ~60 ms is not worth it. Revisit only if Phase 4b demonstrates a fail-closed mechanism (e.g. CC adding a `failClosed` option) in a live session.
- **`pre-edit-guide` and `file-checker` move to MCP-tool.** Both are advisory: failing open loses a hint, never enforcement that has not already happened (file-checker runs after the write).
- Phase 4b must add a live smoke test that fails if any converted hook logs `mcp_tool hook skipped` — the observable symptom of a misnamed server.

**HTTP hooks are Plan B** if MCP-tool proves unreliable in production (e.g. tool not available during the first few seconds of a session before MCP connects). The fixed-port approach (`--port 47123` sidecar start) would make HTTP viable.

---

## Hooks Classified by Transport Suitability

| Hook                        | Scope  | Current ms  | New transport  | Reason                                             |
| --------------------------- | ------ | ----------- | -------------- | -------------------------------------------------- |
| `tdd-guard`                 | shared | ~64ms       | **subprocess** | Must block; MCP-tool/HTTP fail open (see above)    |
| `pre-edit-guide`            | shared | ~71ms       | **MCP-tool**   | Needs file_path + cwd; returns hint JSON           |
| `file-checker`              | claude | ~61ms       | **MCP-tool**   | **PostToolUse** (`if` filter, `continueOnBlock`); advisory |
| `tool-redirect`             | claude | ~60ms       | **subprocess** | Needs full tool_input (no vars for arbitrary keys) |
| `tdd-tracker`               | shared | N/A (async) | **subprocess** | Async — can't block; no benefit from MCP-tool      |
| `memory-observer`           | shared | N/A (async) | **subprocess** | Needs full tool_input + tool_response              |
| `context-monitor`           | shared | N/A (async) | **subprocess** | Async                                              |
| `prompt-context`            | shared | N/A         | **subprocess** | UserPromptSubmit; needs full prompt text           |
| `pre-compact`               | shared | N/A         | **subprocess** | Needs full transcript context                      |
| All session/lifecycle hooks | —      | N/A         | **subprocess** | Rare; no hot-path penalty                          |

**2 hooks converted to MCP-tool**: `pre-edit-guide` (PreToolUse) and `file-checker` (PostToolUse — `mcp_tool` on PostToolUse was observed working; whether `if` and `continueOnBlock` carry over to an `mcp_tool` entry is untested and is the first Phase 4b check).  
**Remaining 11+ hooks stay on subprocess** — either async (can't block), need full payload, or are rare lifecycle events where spawn cost is irrelevant.

---

## New MCP Tools Required

The existing `tdd_status`, `check_diagnostics`, etc. return markdown text — not hook-decision JSON. Phase 4b needs thin hook-optimised MCP tools:

| New tool              | Input vars                       | Output                                        |
| --------------------- | -------------------------------- | --------------------------------------------- |
| `hook_pre_edit_guide` | `file_path`, `cwd`, `session_id` | `{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"..."}}` or `{}` |
| `hook_file_checker`   | `file_path`, `session_id`        | `hookSpecificOutput` with `"hookEventName":"PostToolUse"`, or `{}` |

Plain text (what `tdd_status` returns today) is logged by CC but **not delivered** to the model, and
`hookSpecificOutput.hookEventName` must equal the firing event: a mismatched name is parsed, logged
as success and **silently dropped** (both observed).

These are thin wrappers that reuse existing sidecar route logic and return the minimal JSON CC needs — not the human-readable markdown the current MCP tools return.

---

## Next Steps (Phase 4b Scope)

1. Live check first: does an `mcp_tool` entry keep file-checker's `if` filter and `continueOnBlock`? If not, file-checker stays on subprocess too.
2. Add 2 new MCP tools (`hook_pre_edit_guide`, `hook_file_checker`) to `src/` — each calls the relevant sidecar endpoint and returns `hookSpecificOutput` JSON with the matching `hookEventName`
3. Register them in `src/mcp/server.ts`
4. Update `targets/claude-code/hooks/hooks.json` — convert `pre-edit-guide` (PreToolUse) and `file-checker` (PostToolUse) to `type: "mcp_tool"` with `"server": "plugin:sentinal:sentinal"`; `tdd-guard` stays a command hook
5. Keep all other hooks as `type: "command"` with `args: []` exec form (already done — Task 6)
6. Build + install + measure actual CC session latency with `sentinal sidecar logs` and CC hook timing, and fail the smoke test on any `mcp_tool hook skipped` line

**Expected outcome:** per Write, PreToolUse overhead drops from ~135ms (tdd-guard ~64 + pre-edit-guide ~71) to ~70ms (tdd-guard unchanged + 2–4ms), and PostToolUse file-checker from ~61ms to 2–4ms. Hinting behaviour is unchanged; blocking stays on subprocess.
