# Statusline Usage Data Mismatch Fix Plan

Created: 2026-03-20
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Bugfix

## Summary

**Symptom:** The statusline shows usage percentages that don't match Claude Code's `/usage` command.
**Trigger:** Every statusline render — all usage numbers (session %, model %) are independently calculated and diverge from Claude Code's server-side data.
**Root Cause:** `src/cli/commands/statusline.ts:158-184` — The statusline independently calculates session and weekly usage from JSONL logs using estimated pricing, estimated plan limits, and a wrong window size (4h vs 5h). Since March 8, 2026, Claude Code exposes accurate server-side `rate_limit` data in the statusline JSON (`rate_limit.session_used_percentage`, `rate_limit.weekly_used_percentage`) but the statusline ignores it entirely.

## Investigation

- Sentinal's `usage-stats.ts` uses `SESSION_WINDOW_MS = 4 * 60 * 60 * 1000` (4h) but Claude Code uses a 5-hour rolling window
- Plan limits (`$200`/`$800` weekly) are estimates, not official Anthropic numbers
- Token pricing is hardcoded and may not match Anthropic's internal cost accounting
- Claude Code issue #32257 (COMPLETED March 8, 2026) added `rate_limit` to statusline JSON: `{ session_used_percentage, session_remaining_percentage, weekly_used_percentage, weekly_remaining_percentage }`
- The session JSON already reaches the statusline via stdin — just needs to be parsed
- Per-model breakdown should be kept (log-based) alongside the accurate totals from `rate_limit`

## Behavior Contract

### Fix Property (C => P)

**When condition C holds:** Session JSON contains `rate_limit.session_used_percentage` and `rate_limit.weekly_used_percentage`
**Property P must hold:** Statusline displays session % and weekly model % from Claude Code's server-side data instead of independent calculation

### Preservation Property (!C => unchanged)

**When condition C does NOT hold:** Session JSON has no `rate_limit` field (older Claude Code version or missing data)
**Existing behavior preserved:** Falls back to log-based independent calculation (current behavior)

## Fix Approach

**Files:** `src/cli/commands/statusline.ts`, `src/cli/commands/statusline.test.ts`
**Strategy:**

1. Parse `rate_limit` from session JSON: `session_used_percentage` and `weekly_used_percentage`
2. When `rate_limit` data is present: use `session_used_percentage` for the session bar, use `weekly_used_percentage` for the weekly/model section total
3. Keep per-model log-based breakdown but scale percentages to match the `weekly_used_percentage` total (so model breakdown proportions come from logs but the total matches Claude Code)
4. When `rate_limit` is absent: fall back to current log-based calculation (backward compatibility)
5. Also fix `SESSION_WINDOW_MS` in `usage-stats.ts` from 4h to 5h for the fallback path

**Tests:** Add tests for `formatStatusline` with rate_limit data, fallback without rate_limit data.

## Progress

- [x] Task 1: Fix — regression test + implement rate_limit parsing
- [x] Task 2: Verify — full test suite + quality checks
      **Tasks:** 2 | **Done:** 2 | **Left:** 0

## Tasks

### Task 1: Fix

**Objective:** Write regression test for rate_limit parsing, then implement the fix
**Files:**

- `src/cli/commands/statusline.ts` — parse `rate_limit` from session JSON, use for session/weekly percentages, keep per-model breakdown from logs scaled to match, fall back to log-based when absent
- `src/cli/commands/statusline.test.ts` — add tests for rate_limit data path and fallback path
- `src/sessions/usage-stats.ts` — fix `SESSION_WINDOW_MS` from 4h to 5h
  **TDD:** Write test verifying session % comes from `rate_limit.session_used_percentage` → verify FAILS → implement → verify PASS
  **Verify:** `bun test src/cli/commands/statusline.test.ts --verbose`

### Task 2: Verify

**Objective:** Full test suite + quality checks
**Verify:** `bun test && npx tsc --noEmit`
