# Phase 4: HTTP Hooks Architecture

Created: 2026-04-20
Status: PENDING
Approved: No
Iterations: 0
Worktree: No
Type: Feature
Parent: 2026-04-20-claude-opencode-changelog-audit
Wave: 2

> Awaiting detailed planning. Run `/spec <this-file>` to plan this phase.

## Summary

**Goal:** Convert Sentinal's hot-path Claude Code hooks from subprocess-spawn to sidecar HTTP POST, targeting ≥50% reduction in median PreToolUse hook latency against a measured baseline.

**Context:** See master plan at `docs/plans/2026-04-20-claude-opencode-changelog-audit.md`. **Depends on:** Phases 1, 2, 3 being stable.

---

## Pre-work (Task 0 — Day 1 Spike)

**⛔ Gate:** If this spike fails, the rest of Phase 4 is blocked. Escalate to user for Plan B/C.

1. **⚠️ NEW: Evaluate `type: "mcp_tool"` hooks (CC 2.1.118):** Claude Code now supports hooks that invoke MCP tools directly. Since Sentinal already runs an MCP server with 26+ tools, this could be a **superior alternative to HTTP hooks**. Write a throwaway hook entry of `type: "mcp_tool"` that invokes a Sentinal MCP tool (e.g., `sentinal_tdd_status`) and verify: (a) HookInput is passed as tool input, (b) tool response shapes Claude Code's continuation behavior, (c) latency is comparable to or better than subprocess. **If MCP-tool hooks work, this may eliminate `src/sidecar/hook-routes.ts` entirely and simplify Phase 4 from 5 tasks to ~3.**
2. **Verify `type: "http"` feature:** Read the Claude Code v2.1.63 changelog entry. Write a throwaway hook entry pointing at a dev server that returns `{"continue": true}` and confirm Claude Code invokes it with a JSON HookInput body.
3. **Verify payload shape:** Confirm the HTTP/MCP request body matches our existing `HookInput` type from `src/utils/hook-output.ts:1`. Document any differences.
4. **Verify async semantics:** Test whether `async: true` hooks support HTTP and/or MCP transport. If not, leave async hooks on subprocess (tdd-tracker, memory-observer, context-monitor).
5. **Verify transport:** Can hooks.json point at a Unix socket path (`unix:~/.sentinal/sidecar.sock`) or is it HTTP URL only? Document.

**Decision matrix after spike:**

| MCP-tool hooks work? | HTTP hooks work? | Decision |
|----------------------|------------------|----------|
| Yes | Yes | Prefer MCP-tool (no new routes needed) |
| Yes | No | Use MCP-tool exclusively |
| No | Yes | Use HTTP as originally planned |
| No | No | Fall back to Plan B (warm worker) |

**On full failure:** Fall back to **Plan B — Warm Worker**: sidecar pre-spawns a pool of Bun processes kept warm for hook invocation. Claude Code still spawns `sentinal hook shared <name>` but the process is a thin client connecting to the warm pool via Unix socket. Slower than true HTTP but still significant win over cold Bun starts.

---

## Pre-work (Task 0b — Baseline Benchmark)

Before refactoring, run `hyperfine` against current hot-path hooks:

```bash
hyperfine --warmup 3 --runs 20 \
  -n "tdd-guard"       'echo "{}" | sentinal hook shared tdd-guard' \
  -n "pre-edit-guide"  'echo "{}" | sentinal hook shared pre-edit-guide' \
  -n "file-checker"    'echo "{}" | sentinal hook shared file-checker' \
  -n "tool-redirect"   'echo "{}" | sentinal hook claude tool-redirect' \
  --export-json baseline.json
```

Record medians and stddev. These become the baseline in Goal Verification. Target: post-refactor median ≤ 0.5 × baseline for each.

---

## Scope (post-spike)

### Task 1 — Sidecar HTTP route module

`src/sidecar/hook-routes.ts` exporting `handleHookRequest(req, ctx)`:

- Parses HookInput from request body
- Dispatches to the correct handler from `src/hooks/*.ts`
- Returns HookOutput JSON as response body
- Reuses the existing `readStdin → handler → hint/deny/output` pipeline in `src/utils/hook-output.ts`

### Task 2 — HTTP Contract specification

**Request (POST `/hooks/<name>`):**

```json
// Body: HookInput (same as stdin today)
{
  "session_id": "...",
  "transcript_path": "...",
  "cwd": "...",
  "hook_event_name": "PreToolUse",
  "tool_name": "Write",
  "tool_input": { ... },
  "agent_id": "main",
  "agent_type": "main-thread",
  "last_assistant_message": "..."
}
```

**Response:**

- `200` + `{"continue": true}` → allow, no context
- `200` + `{"continue": true, "additionalContext": "..."}` → allow with hint
- `200` + `{"continue": false, "decision": "block", "reason": "..."}` → deny (equivalent to exit 2 + stderr today)
- `200` + `{"permissionDecision": "defer"}` → Phase 5 integration
- `500` → sidecar error, Claude Code should fall through to subprocess fallback

### Task 3 — hooks.json conversion

Convert at least 4 hot-path hooks to `type: "http"`:

- `tdd-guard` (PreToolUse Write/Edit/MultiEdit)
- `pre-edit-guide` (same matcher)
- `file-checker` (PostToolUse + `if` matcher)
- `tool-redirect` (PreToolUse Bash/WebSearch/...)

Each must have subprocess fallback (confirmed pattern from spike).

### Task 4 — Port/socket resolution

**Preferred:** Unix socket path `~/.sentinal/sidecar.sock` (no port race).

**Fallback:** If Claude Code doesn't accept Unix socket URLs, use a wrapper hook script that:

1. Reads `~/.sentinal/sidecar.port`
2. If missing, auto-starts sidecar synchronously
3. Forwards to HTTP

### Task 5 — Post-refactor benchmark + regression test

- Re-run hyperfine against new HTTP hooks (warm + cold-sidecar cases)
- Record post-refactor numbers next to baseline
- Integration test: kill sidecar mid-session, confirm fallback fires without user-visible failure

---

## Deferred

- Async hooks (tdd-tracker, memory-observer, context-monitor) — keep on subprocess unless spike (Task 0.3/0.4) confirms async HTTP/MCP support.
- SessionStart, SessionEnd, PreCompact — fire once per session. Keep as subprocess (ROI low).
- OpenCode equivalent — OpenCode handlers are already in-process (plugin), no HTTP conversion needed.

---

## Investigate During Planning (from 2026-05-26 re-audit, CC 2.1.117–2.1.142)

These items were discovered after the original stub was written. Evaluate and incorporate during detailed planning.

### CRITICAL: `type: "mcp_tool"` hooks (CC 2.1.118)

This is the single most impactful finding. See updated Task 0 spike above. If MCP-tool hooks work, the entire architecture simplifies:

- **Eliminated:** `src/sidecar/hook-routes.ts`, HTTP route module (Task 1)
- **Eliminated:** Port/socket resolution logic (Task 4)
- **Simplified:** hooks.json conversion (Task 3) — entries point at MCP tools instead of HTTP URLs
- **Preserved:** Baseline benchmark (Task 0b) and post-refactor benchmark (Task 5)

The MCP server already handles authentication, error handling, and response serialization. This eliminates Pre-Mortem items 6 (HTTP hooks don't exist), 7 (async HTTP undefined), and 8 (port-file race).

### MEDIUM: `args: string[]` exec form (CC 2.1.139)

Hooks now support `args: string[]` which spawns the command directly without shell interpretation. This eliminates shell-quoting issues in subprocess fallback declarations. Use this for any remaining subprocess-type hooks.

### MEDIUM: `alwaysLoad: true` for MCP server config (CC 2.1.121)

New MCP server config option ensures all tools are available immediately without tool-search deferral. Add `"alwaysLoad": true` to Sentinal's `.mcp.json` entries in both `targets/claude-code/.mcp.json` and `targets/opencode/opencode.json`. This is a quick win that should land as a standalone change or as part of Phase 4.

### LOW: `continueOnBlock` on PostToolUse (CC 2.1.139)

New hook config option feeds the rejection reason back to Claude instead of hard-blocking. While primarily a Phase 5 concern (permission middleware), Phase 4's `file-checker` hook conversion should note this option — it enables a "warn Claude, don't block" mode for non-critical file-length violations.
