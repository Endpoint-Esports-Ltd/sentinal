# Statusline Plugin Coexistence Check

Created: 2026-03-26
Status: VERIFIED
Approved: Yes
Iterations: 1
Worktree: No
Type: Feature

## Summary

**Goal:** Sentinal's statusline should detect if another statusline plugin (e.g., ccstatusline-usage) is active and disable itself to avoid conflicts.
**Architecture:** Add an exported `isStatuslineActive()` function that reads `~/.claude/settings.json` to check if the `statusLine.command` still points to sentinal. At runtime, if another plugin owns the statusline, output nothing. At install time, skip overwriting an existing non-sentinal statusline config.
**Tech Stack:** TypeScript, Bun, `node:fs`

## Scope

### In Scope

- Runtime detection: `sentinal statusline` outputs nothing if settings.json points to another plugin
- Install-time detection: `sentinal install claude` skips statusline config if another plugin is active
- Detection of known statusline packages (ccstatusline, ccstatusline-usage) as secondary signal

### Out of Scope

- Feature parity with ccstatusline-usage (colors, widgets, pace indicator)
- Automatic migration or re-activation of sentinal's statusline

## Context for Implementer

- **Patterns to follow:** `detectPlanTier()` in `src/cli/commands/statusline.ts:40-55` — exported pure function with tests
- **Conventions:** All exported functions in statusline.ts are tested in statusline.test.ts
- **Key files:**
  - `src/cli/commands/statusline.ts` — statusline command implementation
  - `src/cli/commands/install.ts:368-393` — `configureStatusline()` writes settings.json
  - `~/.claude/settings.json` — Claude Code settings with `statusLine.command`
- **Gotchas:** settings.json may contain JSONC (comments) — install.ts already uses `stripJsoncComments()`

## Assumptions

- `~/.claude/settings.json` is the authoritative source for which statusline is active — supported by Claude Code docs and `install.ts:370`
- The command field always contains the binary name (e.g., `sentinal`, `ccstatusline`) — supported by reading `settings.json`
- Tasks 1-2 depend on this assumption

## Testing Strategy

- Unit tests for `isStatuslineActive()` with mocked settings.json content
- Unit tests for install-time skip logic
- Manual verification with a real settings.json

## Pre-Mortem

_Assume this plan failed. Most likely internal reasons:_

1. **settings.json command path varies** (Task 1) → Trigger: `isStatuslineActive` returns false negative because the sentinal path uses symlinks, aliases, or relative paths that don't match a simple string check
2. **JSONC parsing not available in statusline runtime** (Task 1) → Trigger: settings.json has comments and `JSON.parse` fails silently, causing statusline to always yield

## Execution Waves

**Wave 1** — Detection + Runtime (parallel): Both tasks are independent — Task 1 adds the detection function to statusline.ts, Task 2 modifies install.ts. No shared files.

## Goal Verification

### Truths

1. `isStatuslineActive` returns `false` when settings.json command doesn't contain "sentinal"
2. `isStatuslineActive` returns `true` when settings.json command contains "sentinal"
3. `sentinal statusline` outputs empty string when another plugin is active
4. `sentinal install claude` skips statusline config when another plugin is detected
5. `isStatuslineActive` returns `true` when settings.json doesn't exist (default — sentinal is the expected plugin)

### Artifacts

| Artifact                            | Provides                     | Exports                            |
| ----------------------------------- | ---------------------------- | ---------------------------------- |
| src/cli/commands/statusline.ts      | Statusline runtime detection | `isStatuslineActive()`             |
| src/cli/commands/statusline.test.ts | Detection tests              | N/A                                |
| src/cli/commands/install.ts         | Install-time skip            | `configureStatusline()` (modified) |

### Key Links

| From                           | To                 | Via          | Pattern              |
| ------------------------------ | ------------------ | ------------ | -------------------- |
| statusline.ts action           | isStatuslineActive | early return | isStatuslineActive   |
| install.ts configureStatusline | settings.json      | read + check | statusLine.\*command |

## Progress Tracking

- [x] Task 1: Add `isStatuslineActive()` + runtime early-exit (Wave 1)
- [x] Task 2: Install-time detection — skip statusline config (Wave 1)
- [x] Task 3: Verify — full test suite + quality checks (Wave 2)
      **Total Tasks:** 3 | **Completed:** 3 | **Remaining:** 0

## Implementation Tasks

### Task 1: Runtime detection — `isStatuslineActive()`

**Objective:** Add exported function to detect if sentinal owns the statusline, and early-exit if not.
**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `src/cli/commands/statusline.ts`
- Modify: `src/cli/commands/statusline.test.ts`

**Key Decisions / Notes:**

- `isStatuslineActive(settingsPath?)` reads `~/.claude/settings.json`, strips JSONC comments using `stripJsoncComments` from `../../utils/shell.js` (already used in install.ts), then accesses the **nested** shape: `(settings as any).statusLine?.command` (real shape is `{ statusLine: { type: "command", command: "..." } }`)
- Returns `true` if: command contains "sentinal", or file doesn't exist, or file can't be parsed (safe default — don't break existing users)
- Returns `false` if: command exists and doesn't contain "sentinal"
- Also check for known packages: if command contains "ccstatusline" → definitely not sentinal
- In the action handler, add early return before any computation: `if (!isStatuslineActive()) return;`
- Accept optional `settingsPath` parameter for testability (default: `~/.claude/settings.json`)

**Definition of Done:**

- [ ] `isStatuslineActive` returns false when command is "npx ccstatusline-usage"
- [ ] `isStatuslineActive` returns true when command contains "sentinal statusline"
- [ ] `isStatuslineActive` returns true when settings.json missing
- [ ] statusline outputs nothing when another plugin active
- [ ] All existing tests still pass

**Verify:**

- `bun test src/cli/commands/statusline.test.ts`

### Task 2: Install-time detection — skip statusline config

**Objective:** Modify `configureStatusline()` to skip overwriting if another statusline plugin is configured.
**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `src/cli/commands/install.ts`

**Key Decisions / Notes:**

- Import and reuse `isStatuslineActive` from `statusline.ts` (single maintenance point for detection logic, both files in same directory)
- Before writing `settings.statusLine`, call `isStatuslineActive(settingsPath)` — if false, skip config
- If another plugin detected: log a warning via `warn()` and return `false` from `configureStatusline()`
- Change `configureStatusline()` to return `boolean` (true = configured, false = skipped)
- **Fix call site** at `install.ts:352-353`: the `ok("[OK] Statusline configured...")` message is outside the function — wrap it in a conditional: `if (configureStatusline()) { ok(...) } else { warn("Statusline skipped — another plugin is active") }`

**Definition of Done:**

- [ ] Install skips statusline config when another plugin is active
- [ ] Install logs informational message about skipped statusline
- [ ] Install still configures statusline when no existing config or sentinal config

**Verify:**

- `bun test src/cli/commands/install.test.ts` (if exists, otherwise manual)

### Task 3: Verify — full test suite + quality checks

**Objective:** Run full test suite + TypeScript checks
**Dependencies:** Task 1, Task 2
**Wave:** 2

**Definition of Done:**

- [ ] All tests pass
- [ ] No TypeScript errors

**Verify:**

- `bun test && npx tsc --noEmit`
