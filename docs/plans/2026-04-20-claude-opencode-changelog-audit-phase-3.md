# Phase 3: OpenCode Plugin Hooks

Created: 2026-04-20
Status: PENDING
Approved: No
Iterations: 0
Worktree: No
Type: Feature
Parent: 2026-04-20-claude-opencode-changelog-audit
Wave: 1

> Awaiting detailed planning. Run `/spec <this-file>` to plan this phase.

## Summary

**Goal:** Adopt OpenCode's new experimental and core plugin hooks from April 2026. Extract handler logic to `src/opencode/*.ts` for testability and DRY — but `sentinal.ts` length is NOT a gate (file is exempt from block thresholds per master plan).

**Context:** See master plan at `docs/plans/2026-04-20-claude-opencode-changelog-audit.md`.

---

## Scope

### Task 1 — `compaction.autocontinue` hook [OC-1]

File: `src/opencode/compaction-autocontinue.ts` (new)

Extend the existing compaction story:
- Pause if TDD is RED (use `tdd_status` MCP tool / SidecarClient)
- Force `spec_status` re-check before auto-continuation
- Insert resume-from-task directive when an active spec is in progress

Wire into plugin: `import { handleCompactionAutocontinue } from "src/opencode/compaction-autocontinue.js"`; register as `"compaction.autocontinue": handleCompactionAutocontinue`.

Test: `src/opencode/compaction-autocontinue.test.ts` with three scenarios (RED TDD, active spec, idle state).

### Task 2 — `preserve_recent_tokens` awareness [OC-7]

Modify `src/opencode/compacting.ts` (from Task 0 extraction) to:
- Read `preserve_recent_tokens` config value via sidecar `/config` endpoint
- Shrink our injected context proportionally (we don't need to duplicate what's already preserved verbatim)
- Log observation when value differs from default

Test: mock the config endpoint at 3 different values (default, 0, large), assert injection size adapts.

### Task 3 — `--dangerously-skip-permissions` integration [OC-5]

Update `src/cli/commands/spec/` runner(s) — specifically `spec-master-execute` dispatcher — to append `--dangerously-skip-permissions` when invoking `opencode run -p ...` in non-interactive contexts.

Test: unit test of the command-builder function; assert flag is appended in CI mode, omitted interactively.

### Task 4 — Native plugin tool with metadata return [OC-2]

Register **one** exemplar native OpenCode tool that returns `metadata`:

**Chosen tool: `sentinal_tdd_status_native`** (complements the existing MCP tool with a native version that surfaces TDD state transitions in the OpenCode UI).

Metadata shape:
```typescript
{
  metadata: {
    sentinal: {
      tdd_state: "IDLE" | "TEST_WRITTEN" | "RED_CONFIRMED" | "GREEN_CONFIRMED",
      cycle_duration_ms?: number,
      spec_task?: string,
    }
  }
}
```

File: `src/opencode/native-tools/tdd-status.ts` + test.

### Task 5 — Plugin `authorize` API (deferred per plan-reviewer)

**Not implemented this phase** — master plan marks OC-3 as "future work if cloud-sync memory is ever built". Replace with a one-page deferred-decision note at `docs/decisions/2026-04-20-opencode-authorize-api.md` recording: what it enables, why it's deferred (no cloud-sync feature exists today), and when to revisit (if/when cloud sync is prioritized).

---

## Completion criteria

- All four tasks shipped and tested
- Every new handler has logic in `src/opencode/*.ts` and is registered via import in sentinal.ts (DRY / testability)
- sentinal.ts line count is NOT a gate — grows only by the minimum needed for imports and registration
