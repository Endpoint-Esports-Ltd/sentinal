# Statusline Plugin Shows Wrong Plan Tier Fix Plan

Created: 2026-03-19
Status: VERIFIED
Approved: Yes
Iterations: 1
Worktree: No
Type: Bugfix

## Summary

**Symptom:** Claude Code statusline shows "Max 5x" when the user has the "Max 20x" plan.
**Trigger:** Every statusline render — the plan tier defaults to `max_5x` when not manually configured.
**Root Cause:** `src/cli/commands/statusline.ts:107` — `planTier` defaults to `"max_5x"` and only reads from MemoryStore config. The session JSON from Claude Code includes `context_window.context_window_size` (1000000 for Max 20x plans, 200000 otherwise) but this is never used for auto-detection.

## Investigation

- `MemoryStore.getSetting("plan_tier")` returns `null` — never configured
- Claude Code session JSON schema confirmed via official docs: includes `context_window.context_window_size` field
- 1M context window size is exclusive to Max 20x plans (per Anthropic docs: "200000 by default, or 1000000 for models with extended context")
- No plan/tier/subscription field exists in the session JSON — `context_window_size` is the best available signal
- `usage.ts` has the same default-to-max_5x pattern (line 139) but does NOT receive session JSON via stdin — auto-detection is only possible in `statusline.ts`
- The existing code already reads `context_window.used_percentage` from the session JSON, confirming the `context_window` key structure

## Behavior Contract

### Fix Property (C => P)

**When condition C holds:** Session JSON contains `context_window.context_window_size >= 1000000` and no manual `plan_tier` config is set
**Property P must hold:** Statusline displays "Max 20x" (auto-detected from session JSON)

### Preservation Property (!C => unchanged)

**When condition C does NOT hold:** Manual `plan_tier` config is set, OR `context_window_size` < 1000000
**Existing behavior preserved:** Manual config takes precedence; smaller context windows default to "Max 5x"

## Fix Approach

**Files:** `src/cli/commands/statusline.ts`, `src/cli/commands/statusline.test.ts`
**Strategy:** Extract an exported `detectPlanTier(configValue, contextWindowSize)` function that:

1. If `configValue` is `"max_20x"` → return `"max_20x"` (manual override wins)
2. If `contextWindowSize >= 1000000` → return `"max_20x"` (auto-detect from session JSON)
3. Otherwise → return `"max_5x"` (default)

When auto-detection triggers (case 2) and no manual config exists, persist `"max_20x"` to MemoryStore via `setSetting("plan_tier", "max_20x")`. This way `usage.ts` and other commands that read from config also pick up the correct tier without needing session JSON.

The function is exported and unit-testable directly (matching the pattern of `buildProgressBar` and `formatStatusline`). `usage.ts` is out of scope for code changes — it automatically benefits from the persisted config.

**Tests:** Direct unit tests on `detectPlanTier` for: auto-detection, manual override, default fallback.

## Progress

- [x] Task 1: Fix — regression test + implement auto-detection
- [x] Task 2: Verify — full test suite + quality checks
      **Tasks:** 2 | **Done:** 2 | **Left:** 0

## Tasks

### Task 1: Fix

**Objective:** Write regression test for plan tier auto-detection, then implement the fix
**Files:**

- `src/cli/commands/statusline.ts` — extract exported `detectPlanTier(configValue, contextWindowSize)` function; call it in the action handler with the MemoryStore value and `sessionJson.context_window.context_window_size`; when auto-detected as max_20x and no config exists, persist via `store.setSetting("plan_tier", "max_20x")`
- `src/cli/commands/statusline.test.ts` — add `describe("detectPlanTier")` with tests for auto-detection, manual override, and default
  **TDD:** Write test for `detectPlanTier(null, 1000000) → "max_20x"` → verify FAILS → implement fix → verify PASS
  **Verify:** `bun test src/cli/commands/statusline.test.ts --verbose`

### Task 2: Verify

**Objective:** Full test suite + quality checks
**Verify:** `bun test && npx tsc --noEmit`
