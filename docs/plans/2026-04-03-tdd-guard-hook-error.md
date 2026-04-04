# TDD Guard Hook Error Fix Plan

Created: 2026-04-03
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Bugfix

## Summary

**Symptom:** `Error: PreToolUse:Edit hook error: [sentinal hook shared tdd-guard]: No stderr output`
**Trigger:** Any Edit/Write/MultiEdit on a guarded implementation file when a spec is active — the TDD guard correctly denies but Claude Code treats it as an error instead of a denial.
**Root Cause:** `src/utils/hook-output.ts:58` — `output()` writes deny/block JSON to `process.stdout`, but Claude Code's exit code 2 hook protocol expects the denial reason on `process.stderr`. Claude Code sees exit 2, checks stderr, finds nothing, reports "No stderr output".

## Investigation

- **Confirmed:** `output()` function writes JSON to `process.stdout.write(JSON.stringify(data))` — always stdout regardless of deny/block/hint
- **Confirmed:** Claude Code hook protocol: exit 2 = deny, reason read from stderr. Our hooks write reason to stdout + exit 2 = mismatch.
- **6 call sites affected:** `hook.ts:34,292,410`, `tdd-guard.ts:97`, `spec-stop-guard.ts:12`, `tool-redirect.ts:61`
- **All follow same pattern:** `output(denyResult); process.exit(2);` — writes JSON to stdout, but Claude Code ignores stdout on exit 2
- **OpenCode NOT affected:** OpenCode plugin doesn't use exit code 2 — it returns results via plugin hooks API directly
- Claude Code docs: "Exit code 2 denies the elicitation and shows **stderr** to the user"

## Behavior Contract

### Fix Property (C => P)

**When condition C holds:** A hook denies/blocks a tool use (exit code 2)
**Property P must hold:** The denial reason appears on stderr so Claude Code displays it correctly

### Preservation Property (!C => unchanged)

**When condition C does NOT hold:** Hook allows (exit 0) or provides hints (stdout JSON, exit 0)
**Existing behavior preserved:** Allow and hint paths use stdout + exit 0, which is correct

## Fix Approach

**Files:** `src/utils/hook-output.ts`, `src/utils/hook-output.test.ts`
**Strategy:** Add a `denyToStderr(reason)` function that writes the reason to `process.stderr`. Update `output()` callers that are followed by `process.exit(2)` to also write the reason to stderr. Alternatively, modify the deny path to write stderr instead of (or in addition to) stdout.

The cleanest approach: when exiting with code 2, write the human-readable reason to stderr. Keep the JSON on stdout for any tooling that reads it. This way both Claude Code (reads stderr) and programmatic consumers (read stdout) are served.

**Tests:** Unit test for the new stderr output function. Integration test verifying exit code 2 produces stderr output.

## Progress

- [x] Task 1: Fix deny/block hooks to write reason to stderr on exit 2
- [x] Task 2: Verify — full test suite + manual hook test

**Tasks:** 2 | **Done:** 2 | **Left:** 0

## Tasks

### Task 1: Fix — Write denial reason to stderr on exit 2

**Objective:** Add stderr output for all deny/block paths that use exit code 2.
**Files:**
- `src/utils/hook-output.ts` — add `denyStderr(reason: string)` that writes to `process.stderr`
- `src/cli/commands/hook.ts` — update all 3 exit(2) sites to write reason to stderr
- `src/hooks/tdd-guard.ts` — update exit(2) site
- `src/hooks/spec-stop-guard.ts` — update exit(2) site
- `src/hooks/tool-redirect.ts` — update exit(2) site
- `src/utils/hook-output.test.ts` — test the new stderr function

**TDD:** Write test for `denyStderr()` → verify → implement fix → verify all pass
**Verify:** `bun test src/utils/hook-output.test.ts`

### Task 2: Verify — Full suite + manual test

**Objective:** Full test suite + manually test hook exit code 2 produces stderr output
**Verify:** `bun test && echo '{"session_id":"t","transcript_path":"/tmp","cwd":"'$(pwd)'","permission_mode":"d","hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":"src/memory/store.ts"}}' | sentinal hook shared tdd-guard 2>&1`
