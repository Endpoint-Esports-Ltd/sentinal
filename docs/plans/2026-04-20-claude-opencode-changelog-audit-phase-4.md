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

**⛔ Gate:** If this spike fails, the rest of Phase 4 is blocked. Escalate to user for Plan B.

1. **Verify `type: "http"` feature:** Read the Claude Code v2.1.63 changelog entry. Write a throwaway hook entry pointing at a dev server that returns `{"continue": true}` and confirm Claude Code invokes it with a JSON HookInput body.
2. **Verify payload shape:** Confirm the HTTP request body matches our existing `HookInput` type from `src/utils/hook-output.ts:1`. Document any differences.
3. **Verify async semantics:** Test whether `async: true` hooks support HTTP transport. If not, leave async hooks on subprocess (tdd-tracker, memory-observer, context-monitor).
4. **Verify transport:** Can hooks.json point at a Unix socket path (`unix:~/.sentinal/sidecar.sock`) or is it HTTP URL only? Document.

**Success criteria:** The dev server receives a POST with parseable HookInput JSON and its response (with appropriate status code and body) correctly shapes Claude Code's continuation behavior.

**On failure:** Fall back to **Plan B — Warm Worker**: sidecar pre-spawns a pool of Bun processes kept warm for hook invocation. Claude Code still spawns `sentinal hook shared <name>` but the process is a thin client connecting to the warm pool via Unix socket. Slower than true HTTP but still significant win over cold Bun starts.

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

- Async hooks (tdd-tracker, memory-observer, context-monitor) — keep on subprocess unless spike (Task 0.3) confirms async HTTP support.
- SessionStart, SessionEnd, PreCompact — fire once per session. Keep as subprocess (ROI low).
- OpenCode equivalent — OpenCode handlers are already in-process (plugin), no HTTP conversion needed.
