# Phase 4 Spike: MCP-tool Hook Transport

**Date:** 2026-06-09 (desk research) — **re-run live 2026-10-12** on Claude Code 2.1.287  
**Context:** This spike evaluates `type: "mcp_tool"` hooks for replacing subprocess hooks on the hot path.

## Method

The 2026-06-09 version could not run a live Claude Code session and took its findings from the CC
docs. Everything below was **observed** on 2026-10-12 in headless sessions
(`claude -p --settings <throwaway> --debug-file <log>`) in a throwaway git repo outside this
checkout, with the installed Sentinal plugin (1.44.0) providing the MCP server. Evidence is the CC
debug log (`Hooks: mcp_tool calling …`, `Hook PreToolUse:… success/error`), the model's reply, and
the files left on disk. Nothing in this repo was modified; there is nothing to revert.

- **Task 1** — a `PreToolUse` `Read` hook calling Sentinal's `tdd_status`, first from `--settings`,
  then from a **copy of the plugin's own `hooks.json`** loaded with `--plugin-dir` (installed plugin
  disabled for that run only).
- **Task 2** — a `PreToolUse` `Write` hook calling a throwaway stdio MCP server (`--mcp-config`;
  plan option C instead of modifying `tdd_status`, so nothing needed reverting) whose tool returns
  block JSON for `blocked.txt` and hint JSON otherwise.

## Findings

### Invocation — works, but ONLY with the qualified server name

```json
{
  "type": "mcp_tool",
  "server": "plugin:sentinal:sentinal",
  "tool": "tdd_status",
  "input": { "file_path": "${tool_input.file_path}" }
}
```

⛔ **A server provided by a plugin is registered as `plugin:<plugin>:<server>`.** With
`"server": "sentinal"` the hook is skipped — `Hooks: mcp_tool hook skipped — MCP server 'sentinal'
not connected` — **including when the hook is declared in the plugin's own `hooks.json`**. Plugin
hooks get no plugin-scoped name resolution. A non-plugin install (a project/user `.mcp.json` entry
named `sentinal`) would instead need `"sentinal"`, so one `hooks.json` cannot serve both.

With the qualified name: `Hooks: mcp_tool calling plugin:sentinal:sentinal/tdd_status with 1
arg(s)`. The MCP server connected ~170 ms after session start, well before the first tool call.

### Input Shape — confirmed

`${tool_input.file_path}` is substituted: `tdd_status` received the absolute path
(`…/work/note.txt`) and answered `IDLE (active spec: false)` for it. A follow-up run on a
**PostToolUse** `Write` hook passed `${tool_input.file_path}`, `${session_id}` (equal to the
session's id), `${cwd}` and `${hook_event_name}` (`PostToolUse`) — all four substituted. Only the
variables placed in `input` are passed — the tool never sees the full hook payload.

### Response Parsing — JSON only

- **Plain text is NOT delivered.** `tdd_status`'s markdown answer was logged as the hook's success
  output, but the model reported receiving no hook context. Existing tools cannot be reused as-is.
- `{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"…"}}` → **delivered**:
  the model quoted `MCP-HOOK-CONTEXT-MARKER` verbatim. Same on PostToolUse.
- ⛔ `hookEventName` **must equal the firing event.** A PostToolUse hook answering
  `"hookEventName":"PreToolUse"` was logged as `success` and dropped without any warning; with
  `"PostToolUse"` the debug log showed `provided additionalContext` and the model quoted it.

### Block/Deny Behavior — confirmed

`{"continue": true, "decision": "block", "reason": "MCP-HOOK-BLOCKED: …"}` → the Write was
**blocked** (`blocked.txt` never created) and the model saw
`PreToolUse:Write hook error: MCP-HOOK-BLOCKED: spike deliberately blocked`.

⚠️ **Fails open.** A hook whose server is not connected exits `status code 1` — a non-blocking
error — and the tool call proceeds. A guard moved to `mcp_tool` is silently disabled whenever the
MCP server is absent or misnamed (exactly what the unqualified name does).

### Observed Latency

From debug-log timestamps, `mcp_tool calling …` → `Hook … success`: **4 ms** (`tdd_status`, via the
sidecar) and **2–4 ms** (throwaway server). The 2026-06-09 projection was ~10–12 ms; the subprocess
baseline is ~64 ms (`docs/benchmarks/phase4-baseline.json`).

### Conclusion

MCP-tool hooks work, block, and hint, at single-digit milliseconds. Phase 4b must:

1. Reference the server as **`plugin:sentinal:sentinal`** in the plugin's `hooks.json`.
2. Add tools that return **hook-decision JSON** (plain text is dropped).
3. Accept, or mitigate, **fail-open** behaviour for `tdd-guard` when the server is unavailable.
4. Keep `alwaysLoad: true` in `.mcp.json` (done — Task 5).

**Recommendation: viable for the 3 sync hot-path hooks** (tdd-guard, pre-edit-guide, file-checker).
