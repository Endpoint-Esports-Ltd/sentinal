# Hook Integration Completion — Context Bar, Permissions, Tests

**Parent Plan:** `docs/plans/2026-03-09-market research-parity.md` Task 6
**Status:** VERIFIED
**Approved:** Yes
**Created:** 2026-03-09

## Summary

Complete the remaining 3 items from parent plan Task 6 (Hook Integration) that do NOT depend on the dashboard (Task 8):

1. Context bar visualization (`▓`/`░` blocks with token count)
2. `Bash(sentinal:*)` permission in Claude Code settings
3. `session-start.test.ts` — missing test file

Dashboard-dependent items (session-end notifications, server kill, pre-compact notification events) are deferred to Task 8/9.

## Implementation Tasks

- [x] Task 1: Context bar visualization
- [x] Task 2: Bash(sentinal:*) permission
- [x] Task 3: Session-start hook tests
- [x] Task 4: OpenCode context monitoring parity

### Task 1: Context Bar Visualization

**Objective:** Add a visual context bar to the context monitor hook output.

**Files:**
- Modify: `src/hooks/context-monitor.ts` — Add `formatContextBar()`, update `getContextWarning()` signature
- Modify: `src/hooks/context-monitor.test.ts` — Add bar formatting tests, update existing tests

**Implementation Details:**
- Add `formatContextBar(percent: number, tokens: number, width?: number): string`
  - Default bar width: 20 characters
  - `▓` for used portion, `░` for remaining
  - Format: `Context: [▓▓▓▓▓▓▓▓░░░░░░░░░░░░] 80% | ~133k tokens`
  - Token display: format as `~Nk` for thousands
- Update `getContextWarning(usage: ContextUsage): string | null` (accept full object instead of just percent)
  - Prepend the context bar line before the warning text
  - Return format: `{bar}\n{warning_message}`
- Update `main()` to pass full `ContextUsage` object to `getContextWarning()`

**Tests (update `context-monitor.test.ts`):**
- `formatContextBar` at 0%, 50%, 80%, 95%, 100%
- Bar character count matches width parameter
- `getContextWarning` includes bar line in output when warning triggers
- Existing threshold tests updated for new signature

**Definition of Done:**
- [x] `formatContextBar()` renders correct block characters
- [x] `getContextWarning()` accepts `ContextUsage` and prepends bar
- [x] All context-monitor tests pass

### Task 2: Bash(sentinal:*) Permission

**Objective:** Allow Claude Code to run `sentinal` CLI commands without permission prompts.

**Files:**
- Modify: `targets/claude-code/settings.json` — Add `"Bash(sentinal:*)"` to `permissions.allow`

**Implementation Details:**
- Add `"Bash(sentinal:*)"` after the existing `Bash(vexor:*)` entry
- This allows commands like `sentinal register-plan`, `sentinal worktree list`, etc.

**Definition of Done:**
- [x] `Bash(sentinal:*)` present in permissions allow list

### Task 3: Session-Start Hook Tests

**Objective:** Create missing test file for the session-start hook.

**Files:**
- Modify: `src/hooks/session-start.ts` — Export `detectAssistant()` for direct testing
- Create: `src/hooks/session-start.test.ts`

**Implementation Details:**
- Export `detectAssistant()` as a named export (pure function, safe to expose)
- Tests:
  1. `detectAssistant()` returns `"claude-code"` when `CLAUDE_PLUGIN_ROOT` is set
  2. `detectAssistant()` returns `"opencode"` when `CLAUDE_PLUGIN_ROOT` is unset
  3. Verify session insertion via `MemoryStore` with mocked stdin (integration-style)
  4. Graceful handling of missing/invalid stdin (no throw)

**Definition of Done:**
- [x] `detectAssistant` exported from `session-start.ts`
- [x] All 6 tests pass
- [x] No regressions in existing tests

### Task 4: OpenCode Context Monitoring Parity

**Objective:** Add context usage monitoring to the OpenCode plugin using the SDK session messages API.

**Files:**
- Create: `src/sessions/context-display.ts` — Shared formatting functions (extracted from hook)
- Create: `src/sessions/context-display.test.ts` — 14 tests
- Create: `src/sessions/token-usage.ts` — SDK-based token aggregation for OpenCode
- Create: `src/sessions/token-usage.test.ts` — 14 tests
- Modify: `src/hooks/context-monitor.ts` — Import from shared module instead of inline
- Modify: `src/index.ts` — Export shared display + token-usage functions
- Modify: `targets/opencode/plugins/sentinal.ts` — Add context monitoring
- Modify: `targets/opencode/types/opencode-plugin.d.ts` — Extend PluginClient with session.messages()

**Implementation Details:**
- Extracted `formatTokens()`, `formatContextBar()`, `getContextWarning()` to shared `src/sessions/context-display.ts`
- Created `aggregateTokenUsage(messages)` — uses most recent assistant message's `input + cache.read` for context window fill
- OpenCode plugin calls `client.session.messages()` every 5 tool calls (throttled via `CONTEXT_CHECK_INTERVAL`)
- Uses same `getContextWarning()` thresholds (80/90/95%) and visual bar as Claude Code
- More accurate than Claude Code's file-size estimation — uses actual API-reported token counts

**Definition of Done:**
- [x] Shared context display functions extracted and tested
- [x] Token usage aggregation tested (14 tests)
- [x] OpenCode plugin monitors context via SDK
- [x] Claude Code hook refactored to use shared imports
- [x] All barrel exports updated

## Verify

```bash
bun test src/sessions/ src/hooks/ --timeout 10000
```
