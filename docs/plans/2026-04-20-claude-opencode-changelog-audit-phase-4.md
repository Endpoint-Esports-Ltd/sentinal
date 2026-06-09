# Phase 4: Hook Transport Spike + Quick Wins

Created: 2026-04-20
Status: COMPLETE
Approved: Yes
Iterations: 1
Worktree: No
Type: Feature
Parent: 2026-04-20-claude-opencode-changelog-audit
Wave: 2

## Summary

**Goal:** Run empirical experiments to determine the optimal hook transport (MCP-tool vs HTTP vs current subprocess), establish a baseline benchmark, and ship the `alwaysLoad` quick win. Results gate the full Phase 4 implementation plan.

**Architecture:** This is a spike-only plan. No production hooks are converted. Experiments are run manually in a live Claude Code session. Findings are documented in a decision doc that drives the subsequent full Phase 4 plan.

**Tech Stack:** Claude Code hooks.json, `hyperfine` benchmarking, throwaway test configurations.

## Scope

### In Scope

- Empirical test of `type: "mcp_tool"` hooks (CC 2.1.118) against Sentinal's existing MCP server
- Empirical test of `type: "http"` hooks (CC 2.1.63) against sidecar HTTP endpoint
- Baseline benchmark of 4 hot-path subprocess hooks with `hyperfine`
- `alwaysLoad: true` config change for Sentinal's MCP server entries
- `args: string[]` exec form migration for existing `type: "command"` hooks
- Decision document recording all findings + architecture recommendation

### Out of Scope

- Converting production hooks to new transport (deferred to full Phase 4b plan)
- New sidecar routes for hook dispatch (only needed if HTTP wins over MCP-tool)
- Performance optimization of individual hook handlers
- Async hook transport experiments (low ROI — keep on subprocess)
- `continueOnBlock` adoption (Phase 5 concern)

## Context for Implementer

**Patterns to follow:**

- **hooks.json format:** `targets/claude-code/hooks/hooks.json:1` — all 21 hooks use `type: "command"`. The `type` field supports `"command"`, `"http"`, `"mcp_tool"`, `"prompt"`, and `"agent"`.
- **MCP tool hook format** (from CC docs):
  ```json
  {
    "type": "mcp_tool",
    "server": "sentinal",
    "tool": "tdd_status",
    "input": { "file_path": "${tool_input.file_path}" }
  }
  ```
  Tool's text content is processed like command stdout — if valid JSON, treated as a hook decision (block/allow/context). If server not connected or tool returns `isError: true`, non-blocking error, execution continues.
- **HTTP hook format** (from CC docs):
  ```json
  {
    "type": "http",
    "url": "http://localhost:PORT/hooks/tdd-guard",
    "headers": { "Authorization": "Bearer $TOKEN" },
    "allowedEnvVars": ["TOKEN"]
  }
  ```
  Posts event JSON as request body.
- **`.mcp.json`:** `targets/claude-code/.mcp.json:1` — minimal: `{ "command": "sentinal", "args": ["mcp-server"] }`. No `alwaysLoad` property exists yet.
- **Existing tools as hook candidates:** The Sentinal MCP server exposes `tdd_status`, `tdd_set_state`, `spec_status`, `check_diagnostics`, `quality_report`, `impact_analysis`, `project_context`, etc. — any of these could be invoked directly as `type: "mcp_tool"` hooks.

**Key files:**

- `targets/claude-code/hooks/hooks.json` (240 lines) — all 21 hook definitions
- `targets/claude-code/.mcp.json` (8 lines) — MCP server config
- `src/utils/hook-output.ts` — `HookInput` type definition + `hint()`/`denyExit()`/`output()` helpers
- `src/cli/commands/hook.ts` (497 lines) — CLI dispatch: `SHARED_HOOKS` and `CLAUDE_HOOKS` lookup tables

**Gotchas:**

- **MCP-tool hooks use variable substitution** — `${tool_input.file_path}`, `${session_id}`, etc. The exact variables available need to be tested empirically (CC docs show `tool_input.*` but don't exhaustively list all fields).
- **MCP-tool hook response is parsed from tool text content** — the MCP tool must return JSON text that CC can parse as a hook decision. This is different from the structured MCP response format — it's the `.content[0].text` field.
- **If the named MCP server is not connected, the hook produces a non-blocking error.** This is both a risk (hooks silently fail) and a benefit (graceful degradation).
- **HTTP hooks require a running HTTP server** — the sidecar must be up and serving on a known port/socket for HTTP hooks to fire.
- **`alwaysLoad: true`** ensures MCP tools are available from session start — without it, tools may not be available until CC discovers them through tool search.

**Domain context:**

- **Hot-path hooks** are the 4 highest-frequency sync hooks: 3 write/edit hooks (`tdd-guard`, `pre-edit-guide`, `file-checker`) + 1 tool-intercept hook (`tool-redirect` — fires on Bash/WebSearch/Grep). Currently ~50-200ms each due to subprocess spawn. Target: ≤50% of baseline.
- **MCP-tool hooks** invoke tools on an already-running MCP server. Since Sentinal's MCP server is already started by CC at session init, there's no cold-start penalty. The tool receives the hook event as input and returns text that CC parses as a hook decision.
- **HTTP hooks** POST the hook event JSON to a URL. This requires the sidecar to be running and serving HTTP. Port discovery adds complexity (unless Unix socket URLs are supported).

## Assumptions

- Claude Code supports `type: "mcp_tool"` hooks on the current installed version — supported by CC 2.1.118 changelog and Context7 docs showing exact format. Tasks 1, 2 depend on this.
- Claude Code supports `type: "http"` hooks — supported by CC 2.1.63 changelog and Context7 docs. Task 3 depends on this.
- `alwaysLoad: true` is a recognized `.mcp.json` property — supported by CC 2.1.121 changelog. Task 5 depends on this.
- MCP-tool hook response is parsed from tool's text content as JSON — supported by CC docs: "The tool's text content in an MCP tool hook is processed like command-hook stdout". Task 1 depends on this.

## Testing Strategy

- **Manual empirical testing:** Each spike experiment is run in a live CC session
- **Benchmark:** `hyperfine` with 20 runs, 3 warmup, JSON export
- **Integration:** `alwaysLoad` and `args` changes verified by `bun run build:claude` + CC session test

## Risks and Mitigations

| Risk                                                       | Likelihood | Impact | Mitigation                                                                    |
| ---------------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------- |
| MCP-tool hooks not available on installed CC version       | Low        | High   | Check `claude --version` before spike; update if needed                       |
| MCP-tool hook can't return block/deny decisions            | Medium     | High   | Test deny scenario explicitly in spike; fall back to HTTP                     |
| HTTP hooks require port that's hard to resolve dynamically | Medium     | Medium | Test Unix socket URL; if not supported, document port-file approach           |
| `alwaysLoad` property not recognized                       | Low        | Low    | Check CC docs version; omit if not supported (tools still work, just delayed) |

## Pre-Mortem

_Assume this plan failed. Most likely internal reasons:_

1. **MCP-tool hook fires but Sentinal MCP server hasn't loaded tools yet** (Task 1) → Trigger: hook returns `isError: true` or silent no-op on first edit of session. Root cause: `alwaysLoad` not set or CC defers tool loading. Fix: ensure Task 5 (`alwaysLoad`) lands first.
2. **HTTP hook can't reach sidecar because port isn't known at hooks.json write time** (Task 3) → Trigger: HTTP hook returns 500 / connection refused. Root cause: sidecar port is dynamic, hooks.json is static. Fix: use Unix socket URL, or use MCP-tool instead.
3. **hyperfine can't benchmark MCP-tool hooks because they only fire inside CC** (Task 4) → Trigger: can't measure latency outside CC context. Fix: use CC's built-in hook timing logs, or instrument the MCP tool with timestamps.

## Execution Waves

**Wave 1** — Benchmark + quick wins (parallel): Baseline benchmark and `alwaysLoad`/`args` config changes are independent.
**Wave 2** — Spike experiments (sequential): MCP-tool test → HTTP test → findings comparison. Must be done inside CC.
**Wave 3** — Decision doc: Synthesize all findings into architecture recommendation.

## Goal Verification

### Truths

1. `docs/decisions/2026-05-27-phase4-hook-transport.md` exists with a clear architecture recommendation (MCP-tool, HTTP, or Plan B)
2. Baseline benchmark JSON exists at `docs/benchmarks/phase4-baseline.json` with median latencies for 4 hot-path hooks
3. `targets/claude-code/.mcp.json` contains `"alwaysLoad": true` for the sentinal server
4. All `type: "command"` hooks in `hooks.json` use `"args": [...]` exec form instead of bare `"command": "..."` string
5. MCP-tool spike results documented with: (a) whether it invoked, (b) response parsing, (c) block/deny behavior, (d) observed latency
6. HTTP spike results documented with: (a) whether it invoked, (b) payload shape match, (c) Unix socket support, (d) observed latency

### Artifacts

| Artifact                                             | Provides              | Exports                   |
| ---------------------------------------------------- | --------------------- | ------------------------- |
| `docs/decisions/2026-05-27-phase4-hook-transport.md` | Architecture decision | Recommendation + findings |
| `docs/benchmarks/phase4-baseline.json`               | Latency data          | Median/stddev for 4 hooks |
| `targets/claude-code/.mcp.json` (modified)           | MCP config            | `alwaysLoad: true`        |
| `targets/claude-code/hooks/hooks.json` (modified)    | Hook config           | `args: [...]` exec form   |

### Key Links

| From         | To                  | Via                         | Pattern            |
| ------------ | ------------------- | --------------------------- | ------------------ |
| `.mcp.json`  | sentinal MCP server | config                      | `alwaysLoad.*true` |
| `hooks.json` | sentinal CLI        | args exec form              | `"args":\s*\[`     |
| Decision doc | Phase 4b plan       | architecture recommendation | `Recommendation:`  |

## Progress Tracking

- [x] Task 1: MCP-tool hook spike experiment (Wave 2)
- [x] Task 2: MCP-tool hook deny/block test (Wave 2)
- [x] Task 3: HTTP hook spike experiment (Wave 2)
- [x] Task 4: Baseline benchmark with hyperfine (Wave 1)
- [x] Task 5: Add `alwaysLoad: true` to .mcp.json (Wave 1)
- [x] Task 6: Migrate hooks.json to `args: []` exec form (Wave 1)
- [x] Task 7: Write findings decision doc (Wave 3)
      **Total Tasks:** 7 | **Completed:** 7 | **Remaining:** 0

## Implementation Tasks

### Task 1: MCP-tool Hook Spike — Basic Invocation

**Objective:** Verify that `type: "mcp_tool"` hooks actually work in Claude Code by pointing a throwaway hook at Sentinal's existing `tdd_status` MCP tool.

**Dependencies:** None
**Wave:** 2

**Files:**

- Modify (temporarily): `targets/claude-code/hooks/hooks.json` — add a throwaway MCP-tool hook entry
- Create: `docs/spike-notes/phase4-mcp-tool-spike.md` — findings

**Key Decisions / Notes:**

- Add a temporary `PreToolUse` hook entry that fires on `Read` (low-impact, fires often enough to test):
  ```json
  {
    "matcher": "Read",
    "hooks": [
      {
        "type": "mcp_tool",
        "server": "sentinal",
        "tool": "tdd_status",
        "input": {}
      }
    ]
  }
  ```
- Open a Claude Code session, trigger a Read tool call, observe:
  1. Does CC invoke the MCP tool?
  2. What input does the tool receive? (check sidecar logs or add logging to the tool)
  3. Does the tool's text response get parsed as a hook decision?
  4. What's the observed latency? (check CC's hook timing in verbose mode)
- Record findings in `docs/spike-notes/phase4-mcp-tool-spike.md`
- **Revert the hooks.json change** after testing — this is throwaway

**Definition of Done:**

- [ ] MCP-tool hook entry added to hooks.json and tested in live CC session
- [ ] Findings doc records: invocation success, input shape, response parsing, latency
- [ ] hooks.json reverted to original state

**Verify:**

- Manual CC session test + findings doc review

---

### Task 2: MCP-tool Hook Spike — Block/Deny Behavior

**Objective:** Test whether an MCP-tool hook can block a tool invocation by returning a deny decision.

**Dependencies:** Task 1 (basic invocation works)
**Wave:** 2

**Files:**

- Modify (temporarily): Sentinal MCP server or add a throwaway test tool
- Update: `docs/spike-notes/phase4-mcp-tool-spike.md` — add deny test findings

**Key Decisions / Notes:**

- We need a tool that returns JSON like `{"continue": false, "decision": "block", "reason": "Spike test: deliberately blocked"}` as its text content.
- Option A: Temporarily modify `tdd_status` to return block JSON when a specific flag is set
- Option B: Register a throwaway `spike_test_block` tool in the MCP server
- Option C: Create a separate throwaway MCP server with one tool
- **Prefer Option A** — least setup, revert after test
- Test: trigger a Write tool call with the blocking hook active, verify CC blocks the operation and shows the reason
- Also test: what happens when the tool returns `{"continue": true, "additionalContext": "This is a hint"}` — does the hint show up in Claude's context?
- Record findings including the exact JSON format CC expects

**Definition of Done:**

- [ ] Deny behavior tested — CC blocks tool call when tool returns block JSON
- [ ] Hint behavior tested — CC receives additionalContext from tool
- [ ] Findings doc updated with deny/hint test results
- [ ] All temporary changes reverted

**Verify:**

- Manual CC session test + findings doc review

---

### Task 3: HTTP Hook Spike — Basic Invocation

**Objective:** Verify that `type: "http"` hooks work by pointing a throwaway hook at the sidecar's health endpoint (or a temp endpoint).

**Dependencies:** None
**Wave:** 2

**Files:**

- Modify (temporarily): `targets/claude-code/hooks/hooks.json` — add HTTP hook entry
- Update: `docs/spike-notes/phase4-http-hook-spike.md` — findings

**Key Decisions / Notes:**

- Start the sidecar manually: `sentinal mcp-server` (or ensure it's running from a CC session)
- Read port from `~/.sentinal/sidecar.port`
- Add a temporary `PreToolUse` hook:
  ```json
  {
    "matcher": "Read",
    "hooks": [
      {
        "type": "http",
        "url": "http://127.0.0.1:PORT/health"
      }
    ]
  }
  ```
- Test: does CC POST to the URL? What's the request body shape? Does the /health response (`{"status": "running"}`) get parsed as a hook decision?
- Also test Unix socket URL if possible: `http+unix:///path/to/sidecar.sock/health`
- Record: request payload, response handling, latency, Unix socket support
- **Revert hooks.json** after testing

**Definition of Done:**

- [ ] HTTP hook entry added and tested in live CC session
- [ ] Request body shape documented — matches HookInput or differs?
- [ ] Unix socket URL support tested (works / doesn't work)
- [ ] Findings doc records all results
- [ ] hooks.json reverted

**Verify:**

- Manual CC session test + findings doc review

---

### Task 4: Baseline Benchmark with Hyperfine

**Objective:** Measure current subprocess hook latency for the 4 hot-path hooks to establish a benchmark baseline.

**Dependencies:** None
**Wave:** 1

**Files:**

- Create: `docs/benchmarks/phase4-baseline.json` — hyperfine JSON export
- Create: `docs/benchmarks/phase4-baseline.md` — human-readable summary

**Key Decisions / Notes:**

- Use a realistic HookInput payload (not empty `{}`) to measure actual code paths:
  ```bash
  INPUT='{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"src/test.ts","content":"x"},"cwd":"/tmp","session_id":"bench","transcript_path":"","permission_mode":"default"}'
  hyperfine --warmup 3 --runs 20 \
    -n "tdd-guard"       "echo '$INPUT' | sentinal hook shared tdd-guard" \
    -n "pre-edit-guide"  "echo '$INPUT' | sentinal hook shared pre-edit-guide" \
    -n "file-checker"    "echo '$INPUT' | sentinal hook claude file-checker" \
    -n "tool-redirect"   "echo '$INPUT' | sentinal hook claude tool-redirect" \
    --export-json docs/benchmarks/phase4-baseline.json
  ```
- Extract medians and stddevs into a summary table in the .md file
- Expected: 50-200ms per hook (Bun subprocess spawn overhead)
- Note: `echo "{}"` would trigger early-exit fast paths in some hooks, underreporting real latency
- This is the baseline against which post-refactor performance is compared
- `docs/benchmarks/` directory may not exist — create it

**Definition of Done:**

- [ ] `docs/benchmarks/phase4-baseline.json` exists with hyperfine results
- [ ] `docs/benchmarks/phase4-baseline.md` has a summary table with median/stddev
- [ ] All 4 hooks benchmarked

**Verify:**

- `cat docs/benchmarks/phase4-baseline.md`

---

### Task 5: Add `alwaysLoad: true` to .mcp.json

**Objective:** Ensure Sentinal's MCP tools are available from session start by adding `alwaysLoad: true` to the MCP server config.

**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `targets/claude-code/.mcp.json`

**Key Decisions / Notes:**

- Current config:
  ```json
  {
    "mcpServers": {
      "sentinal": { "command": "sentinal", "args": ["mcp-server"] }
    }
  }
  ```
- Add `alwaysLoad`:
  ```json
  {
    "mcpServers": {
      "sentinal": {
        "command": "sentinal",
        "args": ["mcp-server"],
        "alwaysLoad": true
      }
    }
  }
  ```
- This is a prerequisite for MCP-tool hooks — without it, tools may not be available when hooks fire early in a session
- No test needed — verified by CC behavior (tools appear immediately in session)
- Do NOT add to `targets/opencode/opencode.json` — OpenCode has a different config format and this property may not be recognized

**Definition of Done:**

- [ ] `targets/claude-code/.mcp.json` has `"alwaysLoad": true` on the sentinal server entry
- [ ] No other MCP server entries affected

**Verify:**

- `cat targets/claude-code/.mcp.json`

---

### Task 6: Migrate hooks.json to `args: []` Exec Form

**Objective:** Convert all `type: "command"` hooks from bare `"command": "sentinal hook ..."` strings to `"command": "sentinal"` + `"args": ["hook", "shared", "<name>"]` exec form.

**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `targets/claude-code/hooks/hooks.json`

**Key Decisions / Notes:**

- CC 2.1.139 added `args: string[]` support. The exec form spawns the command directly without shell interpretation — eliminates shell-quoting edge cases and is marginally faster.
- For each of the 21 hooks, change:
  ```json
  { "type": "command", "command": "sentinal hook shared tdd-guard", ... }
  ```
  to:
  ```json
  { "type": "command", "command": "sentinal", "args": ["hook", "shared", "tdd-guard"], ... }
  ```
- The 3 `claude`-scope hooks use `"args": ["hook", "claude", "<name>"]`
- This is backward-compatible — if CC doesn't recognize `args`, it falls back to `command` string parsing
- No tests needed — verified by CC session behavior
- **Do not change any other hook properties** (matcher, async, timeout, if, etc.)

**Definition of Done:**

- [ ] All 21 hooks in hooks.json use `"command": "sentinal"` + `"args": [...]` format
- [ ] No other hook properties changed
- [ ] JSON is valid
- [ ] At least one hook verified in live CC session (30-second smoke test: trigger a Write, confirm tdd-guard fires)

**Verify:**

- `cat targets/claude-code/hooks/hooks.json | python3 -m json.tool` (valid JSON check)
- Live CC session: edit a file, confirm hook fires in CC output

---

### Task 7: Write Findings Decision Doc

**Objective:** Synthesize all spike findings into an architecture decision document that gates the full Phase 4 implementation.

**Dependencies:** Tasks 1, 2, 3, 4 (all spike results needed)
**Wave:** 3

**Files:**

- Create: `docs/decisions/2026-05-27-phase4-hook-transport.md`

**Key Decisions / Notes:**

- Document:
  1. **MCP-tool hook findings:** Does it work? Input shape? Response parsing? Block/deny? Latency vs baseline?
  2. **HTTP hook findings:** Does it work? Payload shape? Unix socket? Latency vs baseline?
  3. **Baseline benchmark:** Median/stddev for 4 hooks
  4. **Architecture recommendation:** Which transport to use for full Phase 4 implementation, based on the decision matrix from the stub:
     | MCP-tool works? | HTTP works? | Decision |
     |-----------------|-------------|----------|
     | Yes | Yes | Prefer MCP-tool |
     | Yes | No | MCP-tool only |
     | No | Yes | HTTP |
     | No | No | Plan B (warm worker) |
  5. **Next steps:** What the full Phase 4b plan should contain (tasks, hooks to convert, timeline)
- This doc is the input for creating the full Phase 4b implementation plan via `/spec`

**Definition of Done:**

- [ ] Decision doc exists with all 5 sections
- [ ] Clear recommendation with rationale
- [ ] Next steps actionable enough to create a follow-up plan

**Verify:**

- Visual review of `docs/decisions/2026-05-27-phase4-hook-transport.md`

---

## Investigation Resolutions

| Item                                    | Resolution                                                                                                                                                                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `type: "mcp_tool"` hooks (CC 2.1.118)   | **Confirmed in CC docs.** Format: `{ "type": "mcp_tool", "server": "sentinal", "tool": "<name>", "input": { ... } }`. Variable substitution supported: `${tool_input.file_path}`. Tool text content parsed as hook decision. Requires empirical validation (Tasks 1, 2). |
| `args: string[]` exec form (CC 2.1.139) | **Confirmed in CC docs.** Adopted as Task 6 — converts all 21 hooks to exec form.                                                                                                                                                                                        |
| `alwaysLoad: true` (CC 2.1.121)         | **Confirmed in CC docs.** Adopted as Task 5 — adds to `.mcp.json`.                                                                                                                                                                                                       |
| `continueOnBlock` (CC 2.1.139)          | **Deferred.** Phase 5 concern. Noted in findings for future reference.                                                                                                                                                                                                   |
| `type: "http"` hooks (CC 2.1.63)        | **Confirmed in CC docs.** Format: `{ "type": "http", "url": "...", "headers": { ... } }`. Requires empirical validation (Task 3).                                                                                                                                        |
