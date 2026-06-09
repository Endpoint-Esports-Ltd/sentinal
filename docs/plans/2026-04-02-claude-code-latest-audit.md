# Claude Code Latest Features Adoption

Created: 2026-04-02
Status: VERIFIED
Approved: Yes
Iterations: 2
Worktree: No
Type: Feature

## Summary

**Goal:** Adopt Claude Code's latest features (v2.1.63-2.1.90): fix statusline rate_limits field names, add `effort` frontmatter to spec skills, adopt native agent `isolation: worktree` + `background: true` + `maxTurns`/`disallowedTools`, and add conditional `if` field to hooks.
**Architecture:** Mostly frontmatter/config changes to existing skill and hook files, plus one bugfix in statusline.ts for rate_limits field name mismatch. Agent frontmatter enhancements are additive — existing behavior preserved.
**Tech Stack:** TypeScript, Bun, YAML frontmatter, JSON hooks config

## Scope

### In Scope

- **Bugfix:** Fix statusline `rate_limits` field names — Claude Code sends `five_hour.used_percentage` / `seven_day.used_percentage`, not `session_used_percentage` / `weekly_used_percentage`
- **Effort frontmatter:** Add `effort: high` to planning skills, keep implementation/verification at default
- **Agent frontmatter:** Add `isolation: worktree`, `background: true`, `maxTurns`, `disallowedTools` to agent definitions where appropriate
- **Conditional hooks:** Add `if` field to TDD guard, file checker, and memory observer hooks to make them more targeted
- **New hooks documented:** PostCompact, TaskCreated, InstructionsLoaded, PermissionDenied documented as available for future use (no implementation tasks — awareness only)

### Out of Scope

- Dynamic model switching at runtime (no hook exists)
- Persistent subagent memory (no native support)
- Context fork for spec phases (no native support)
- OpenCode changes (covered by separate plan: `2026-04-02-opencode-v1.3-parity.md`)
- Rewriting spec workflow to use native worktree agents (would require architectural changes)

## Platform Parity Analysis

All changes in this plan are Claude Code-specific features. OpenCode impact assessment:

| Change                            | OpenCode Impact                                                   | Parity                                                                                          |
| --------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `extractRateLimits` fix           | None — CLI statusline is Claude Code only                         | N/A                                                                                             |
| `effort:` frontmatter             | None — OpenCode SKILL.md only supports `name:` and `description:` | OpenCode variants are global/per-agent in `opencode.json`, not per-skill. No equivalent to add. |
| Agent `background:` / `maxTurns:` | None — Claude Code agent frontmatter only                         | OpenCode agents in `opencode.json` use different config schema                                  |
| Conditional `if` in hooks.json    | None — Claude Code hooks only                                     | OpenCode hooks use plugin SDK events, not JSON config                                           |

**No shared code or templates are modified.** The targets/ directories are fully independent — `targets/claude-code/` and `targets/opencode/` don't share any files or derive from the same templates. Adding Claude Code-specific frontmatter fields won't affect OpenCode files.

**OpenCode effort parity:** OpenCode manages reasoning effort via model `variants` (e.g., `{ "high": { "reasoningEffort": "high" } }`) configured in `opencode.json` at the global or per-agent level. This is outside Sentinal's plugin control — the user configures it in OpenCode's own config. No action needed in this plan.

## Context for Implementer

- **Key files:**
  - `src/cli/commands/statusline.ts` — rate_limits parsing at line ~61-77
  - `targets/claude-code/commands/*.md` — spec skill files with frontmatter
  - `targets/claude-code/agents/*.md` — agent definitions with frontmatter
  - `targets/claude-code/hooks/hooks.json` — hook configuration
  - `src/cli/embedded-assets.ts` — embedded copies of above (regenerated via `bun run embed-assets`)
- **Gotchas:**
  - After changing targets/ files, `bun run embed-assets` must be run to update embedded copies
  - The `if` field syntax uses permission rule patterns like `Write(*.ts)` or `Bash(bun test*)`
  - Agent frontmatter changes only take effect after reinstall (`sentinal install claude`)

## Assumptions

- Claude Code's `rate_limits` field uses `five_hour` and `seven_day` nested objects with `used_percentage` — supported by changelog and statusline docs — Task 1 depends on this
- `effort: high` frontmatter is respected by Claude Code v2.1.83+ — supported by changelog — Task 2 depends on this
- `if` field for hooks uses the same syntax as permission rules — supported by changelog example `Bash(git *)` — Task 4 depends on this

## Testing Strategy

- Unit tests for updated `extractRateLimits` function
- Manual verification of frontmatter changes after reinstall
- Full test suite for regression

## Risks and Mitigations

| Risk                                            | Likelihood | Impact | Mitigation                                  |
| ----------------------------------------------- | ---------- | ------ | ------------------------------------------- |
| rate_limits field structure differs from docs   | Low        | High   | Test against real Claude Code session JSON  |
| effort frontmatter ignored on older Claude Code | Medium     | Low    | No harm — just unused metadata              |
| `if` field syntax wrong                         | Medium     | Medium | Test with one hook first, expand if working |

## Pre-Mortem

1. **rate_limits field names wrong again** (Task 1) → Trigger: statusline still shows 0% after fix because the real JSON nesting differs from docs
2. **if field breaks hooks entirely** (Task 4) → Trigger: TDD guard never fires because the `if` pattern doesn't match the actual tool invocation format

## Execution Waves

**Wave 1** — Quick wins (parallel): Task 1 (statusline bugfix) and Task 2 (effort frontmatter) don't share files.
**Wave 2** — Agent + hooks (parallel): Task 3 (agent frontmatter) and Task 4 (conditional hooks) modify different files.
**Wave 3** — Verify: Task 5 runs full test suite.

## Goal Verification

### Truths

1. `extractRateLimits` correctly parses `{ five_hour: { used_percentage: N }, seven_day: { used_percentage: N } }`
2. `spec-plan.md`, `spec-bugfix-plan.md`, and `spec-master-plan.md` contain `effort: high` in frontmatter
3. `research.md` contains `maxTurns: 30` in frontmatter
4. `hooks.json` file-checker hook has an `if` field targeting TypeScript file patterns
5. All existing tests pass after changes

### Artifacts

| Artifact                             | Provides                  | Exports                         |
| ------------------------------------ | ------------------------- | ------------------------------- |
| src/cli/commands/statusline.ts       | Fixed rate_limits parsing | `extractRateLimits()`           |
| targets/claude-code/commands/\*.md   | Updated skill frontmatter | effort field                    |
| targets/claude-code/agents/\*.md     | Updated agent frontmatter | isolation, background, maxTurns |
| targets/claude-code/hooks/hooks.json | Conditional hooks         | if field                        |

## Progress Tracking

- [x] Task 1: Fix statusline rate_limits field names (Wave 1)
- [x] Task 2: Add effort frontmatter to spec skills (Wave 1)
- [x] Task 3: Add agent frontmatter enhancements (Wave 2)
- [x] Task 4: Add conditional if to hooks (Wave 2)
- [x] Task 5: Verify — full test suite + quality checks (Wave 3)
      **Total Tasks:** 5 | **Completed:** 5 | **Remaining:** 0

## Implementation Tasks

### Task 1: Fix statusline rate_limits field names

**Objective:** Fix `extractRateLimits` to parse Claude Code's actual rate_limits field structure.
**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `src/cli/commands/statusline.ts`
- Modify: `src/cli/commands/statusline.test.ts`

**Key Decisions / Notes:**

- Claude Code sends: `{ rate_limits: { five_hour: { used_percentage: N, resets_at: "..." }, seven_day: { used_percentage: N, resets_at: "..." } } }`
- Our current code looks for `rate_limit.session_used_percentage` and `rate_limit.weekly_used_percentage` — wrong field names AND wrong nesting
- Update `extractRateLimits` to parse the correct nested structure
- Also extract `resets_at` if available for the reset countdown
- **No backward compat needed** — the old flat `rate_limit.session_used_percentage` format was based on an incorrect assumption from issue #32257. It was never the real Claude Code format. Replace entirely with the correct nested `rate_limits.five_hour.used_percentage` format.
- Top-level key is `rate_limits` (plural), not `rate_limit` (singular) — current code at line ~64 reads wrong key

**Definition of Done:**

- [ ] Top-level key renamed: function reads `rate_limits` (plural) from session JSON, not `rate_limit` (singular)
- [ ] `extractRateLimits` parses `five_hour.used_percentage` → `sessionPct`
- [ ] `extractRateLimits` parses `seven_day.used_percentage` → `weeklyPct` (used by model-scaling logic at lines ~280-286)
- [ ] All 5 existing test cases rewritten for new nested format (old flat format tests removed)
- [ ] New test for nested structure with both `five_hour` and `seven_day`
- [ ] Existing model-scaling logic still works with the new `weeklyPct` value

**Verify:**

- `bun test src/cli/commands/statusline.test.ts`

### Task 2: Add effort frontmatter to spec skills

**Objective:** Add `effort: high` to planning-phase skills for better reasoning depth.
**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `targets/claude-code/commands/spec-plan.md` — add `effort: high`
- Modify: `targets/claude-code/commands/spec-bugfix-plan.md` — add `effort: high`
- Modify: `targets/claude-code/commands/spec-master-plan.md` — add `effort: high`

**Key Decisions / Notes:**

- Only planning phases get `effort: high` — they benefit most from deeper reasoning
- Implementation and verification phases use default effort — they're more mechanical
- The `effort` field goes in the YAML frontmatter between `---` markers, after `model:`

**Definition of Done:**

- [ ] All three planning skills have `effort: high` in frontmatter
- [ ] Implementation/verification skills do NOT have effort set (use default)

**Verify:**

- `grep "effort: high" targets/claude-code/commands/spec-*plan*.md`

### Task 3: Add agent frontmatter enhancements

**Objective:** Add `background: true`, `maxTurns`, and `disallowedTools` to agent definitions.
**Dependencies:** None
**Wave:** 2

**Files:**

- Modify: `targets/claude-code/agents/research.md` — add `maxTurns: 30`

**Key Decisions / Notes:**

- `background: true` already exists in `plan-reviewer.md` (line 6) and `spec-reviewer.md` (line 6) — no changes needed there
- `maxTurns: 30` for research agent prevents runaway research loops
- Don't add `isolation: worktree` to reviewers — they read files from the current working tree, not an isolated copy
- Don't add `disallowedTools` to reviewers — they need Read/Grep/Glob/Write (for output)

**Definition of Done:**

- [ ] research.md has `maxTurns: 30`
- [ ] plan-reviewer.md and spec-reviewer.md confirmed to already have `background: true` (no changes needed)

**Verify:**

- `grep -l "background: true" targets/claude-code/agents/*.md`

### Task 4: Add conditional if to hooks

**Objective:** Make hooks more targeted using the `if` field to reduce unnecessary hook invocations.
**Dependencies:** None
**Wave:** 2

**Files:**

- Modify: `targets/claude-code/hooks/hooks.json`

**Key Decisions / Notes:**

- The TDD guard supports **multi-language** files: `.ts`, `.tsx`, `.js`, `.jsx`, `.go`, `.py`, `.rs`, `.c`, `.cpp` (see `src/utils/tdd.ts` IMPL_EXTENSIONS)
- The `if` field must cover ALL guarded extensions, not just TypeScript. A compound pattern matching all implementation file types would be very long.
- **Revised approach:** Instead of adding `if` for file filtering, add `if` to skip the TDD guard when there's no active spec (the guard is only useful during spec workflows). This is a more impactful optimization — the guard subprocess is skipped entirely for non-spec edits.
- Actually, the TDD guard internally checks `isGuardedFile()` which returns false for non-implementation files. The subprocess overhead (~50-200ms per call) is the real cost. The `if` field syntax may not support "has active spec" conditions — it only matches tool invocation patterns.
- **Final approach:** Be conservative — skip the `if` field for TDD guard (complexity vs benefit is poor given multi-language support). Instead, add `if` to the **file-checker** hook (PostToolUse) to only fire for TS/TSX files since it only checks TypeScript patterns.
- Test by editing a .md file — file-checker should NOT fire.

**Definition of Done:**

- [ ] File-checker hook (PostToolUse) has `if` field targeting TypeScript file patterns
- [ ] TDD guard unchanged (multi-language support makes file filtering impractical)
- [ ] **Hard gate:** Manual verification confirms file-checker fires for .ts files and does NOT fire for .md files. If `if` syntax fails, revert and document as deferred.

**Verify:**

- Manual: Edit a .ts file — TDD guard fires. Edit a .md file — TDD guard does NOT fire. If this fails, revert.

### Task 5: Verify — full test suite + quality checks

**Objective:** Run full test suite + TypeScript checks + regenerate embedded assets
**Dependencies:** Tasks 1-4
**Wave:** 3

**Definition of Done:**

- [ ] All tests pass
- [ ] No TypeScript errors
- [ ] `bun run embed-assets` succeeds (if embedded assets script exists)

**Verify:**

- `bun test && npx tsc --noEmit`
