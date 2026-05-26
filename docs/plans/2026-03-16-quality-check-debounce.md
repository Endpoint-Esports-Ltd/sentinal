# Quality Check Debounce Implementation Plan

Created: 2026-03-16
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Summary

**Goal:** Eliminate the 2-30 second latency per file edit by making ALL quality checks (tsc, eslint, prettier) on-demand only. Per-edit hooks retain only instant checks (file length, companion test, NestJS patterns). Quality checks run via `quality_report` or `check_diagnostics` MCP tools when the AI finishes editing a file. Expected: ~90-95% reduction in per-edit latency.

**Architecture:** Remove all sidecar quality check calls and subprocess fallbacks from the file-checker hook (Claude Code) and OpenCode plugin's `tool.execute.after` handler. Keep only the instant structural checks (~5ms). Update rules, skills, and AGENTS.md to instruct AI to call `quality_report` after finishing a file.

**Tech Stack:** Sentinal hooks, OpenCode plugin, sidecar quality routes.

## Scope

### In Scope

- Remove ALL quality check calls (tsc, eslint, prettier) from per-edit hooks
- Keep instant structural checks: file length, companion test, NestJS patterns
- Update rules/skills/AGENTS.md to instruct on-demand `quality_report` usage
- Remove subprocess fallbacks (runTypeScriptChecks, npx tsc --noEmit)

### Out of Scope

- Timer-based debounce (decided against — fully on-demand)
- Hook consolidation (Finding 6 — separate spec)
- Context token optimizations (Findings 2, 3, 5 — separate spec)
- Changes to the sidecar quality endpoint itself (it stays as-is for on-demand use)

## Context for Implementer

- **Claude Code file-checker:** `src/hooks/file-checker.ts:62-108` — calls `sidecar.qualityCheck({ checks: ["tsc", "eslint", "prettier"] })` on every Write/Edit. Remove the entire sidecar quality check block (lines 62-91) and the fallback block (lines 93-108). Keep lines 35-59 (file length, NestJS, companion test) and lines 104-108 (Angular checks).
- **OpenCode plugin:** `targets/opencode/plugins/sentinal.ts:514-554` — same sidecar call + `npx tsc --noEmit` fallback. Remove the entire quality check section. Keep the structural checks above it (lines 459-512: file length, NestJS, Angular, companion test).
- **Rules to update:** `verification.md`, `development-practices.md` (both targets)
- **Skills to update:** `spec-implement` (both targets — step 2.3 item 9)
- **AGENTS.md:** `~/.config/Claude/AGENTS.md` — Quality Enforcement section

## Assumptions

- AI assistants will reliably call `quality_report` when instructed by rules/skills — supported by current behavior where they follow rule instructions — Task 3 depends on this.
- Instant structural checks (file length, companion test, NestJS) take <5ms — supported by direct observation — Tasks 1, 2 depend on this.
- The sidecar quality endpoint remains available for on-demand use via MCP tools — no changes needed — all tasks depend on this.

## Testing Strategy

- Update existing tests for `processFileCheck()` to verify quality checks are no longer called
- Run full test suite to verify no regressions
- Manual integration test: edit a file, verify near-instant response

## Risks and Mitigations

| Risk                             | Likelihood | Impact | Mitigation                                                              |
| -------------------------------- | ---------- | ------ | ----------------------------------------------------------------------- |
| AI forgets to run quality checks | Medium     | Medium | Rules + skills explicitly instruct. spec-implement step 9 is mandatory. |
| Unformatted code committed       | Low        | Low    | `quality_report` formats on-demand. Pre-commit hooks can catch this.    |
| Type errors accumulate           | Low        | Medium | `check_diagnostics` is fast (incremental). Called after each file.      |

## Pre-Mortem

1. **AI never calls quality_report, ships unformatted + broken types** (Task 3) -> Trigger: First task after changes shows AI completing without any quality check. Mitigated by strong language in rules + mandatory step in spec-implement.
2. **Existing tests expect quality check results in processFileCheck output** (Task 1) -> Trigger: Tests fail because they assert on tsc/eslint/prettier messages. Mitigated by updating tests to only expect structural check results.

## Goal Verification

### Truths

1. `file-checker.ts` makes NO sidecar quality check calls and NO subprocess quality calls
2. OpenCode plugin's `tool.execute.after` makes NO sidecar quality check calls and NO subprocess quality calls
3. Both still perform instant structural checks (file length, companion test, NestJS/Angular patterns)
4. Rules and skills explicitly instruct calling `quality_report` after finishing a file
5. AGENTS.md updated to reflect on-demand quality checks
6. All existing tests pass

### Artifacts

- `src/hooks/file-checker.ts` — quality checks removed, structural checks retained
- `targets/opencode/plugins/sentinal.ts` — quality checks removed, structural checks retained
- `targets/*/rules/verification.md` — updated instruction
- `targets/*/rules/development-practices.md` — updated instruction
- `targets/*/skills|commands/spec-implement` — updated step 2.3
- `~/.config/Claude/AGENTS.md` — updated Quality Enforcement

### Key Links

- file-checker.ts: structural checks only (no sidecar dependency for per-edit)
- OpenCode plugin: structural checks only (no sidecar dependency for per-edit)
- quality_report MCP tool: on-demand quality checks (unchanged)
- verification.md + spec-implement -> AI behavior

## Progress Tracking

- [x] Task 1: Remove quality checks from Claude Code file-checker hook
- [x] Task 2: Remove quality checks from OpenCode plugin per-edit handler
- [x] Task 3: Update rules, skills, and AGENTS.md for on-demand quality checks
      **Total Tasks:** 3 | **Completed:** 3 | **Remaining:** 0

## Implementation Tasks

### Task 1: Remove Quality Checks from Claude Code File-Checker Hook

**Objective:** Remove all tsc/eslint/prettier calls from the per-edit file-checker hook. Retain only instant structural checks.

**Dependencies:** None

**Files:**

- Modify: `src/hooks/file-checker.ts`
- Test: `src/hooks/file-checker.test.ts`

**Key Decisions / Notes:**

- Remove the entire sidecar quality check block (lines 62-91): the `SidecarClient.connect()` call, `client.qualityCheck()`, and all result handling for tsc/eslint/prettier.
- Remove the entire fallback block (lines 93-101): `runTypeScriptChecks()` call and its result handling.
- Keep lines 35-59: file length check, NestJS pattern check, companion test check.
- Keep Angular check (lines 104-108) — this is a structural check (pattern detection), not a subprocess quality check.
- Remove imports that are no longer needed: `SidecarClient`, `runTypeScriptChecks`, `detectPackageManager`, `getRunnerCommand`.
- The function signature and return type stay the same — it still returns `string | null` with any structural issues found.

**Definition of Done:**

- [ ] `processFileCheck()` does NOT call sidecar or spawn quality subprocesses
- [ ] `processFileCheck()` still checks file length, NestJS patterns, companion tests, Angular patterns
- [ ] Existing tests pass (updated to reflect removal of quality check assertions)
- [ ] Zero TypeScript errors

**Verify:**

- `bun test src/hooks/file-checker.test.ts`

### Task 2: Remove Quality Checks from OpenCode Plugin Per-Edit Handler

**Objective:** Remove all tsc/eslint/prettier calls from the OpenCode plugin's `tool.execute.after` handler. Retain only instant structural checks.

**Dependencies:** None

**Files:**

- Modify: `targets/opencode/plugins/sentinal.ts` (lines 514-554 in `tool.execute.after`)

**Key Decisions / Notes:**

- Remove the sidecar quality check block (lines 514-554): the `sidecar.qualityCheck()` call, all result handling for tsc/eslint/prettier, and the `npx tsc --noEmit` fallback.
- Keep the structural checks above it (lines 459-512): file length, NestJS patterns, Angular patterns, companion test check.
- Keep the issue reporting (lines 556-568): `client.app.log()` for structural issues and the `shouldBlock` throw.
- This file is at 884 lines. Removing ~40 lines of quality check code helps but doesn't fix the fundamental size issue.
- Remove unused imports if any (`$` template tag from bun if only used for tsc fallback).

**Definition of Done:**

- [ ] OpenCode plugin `tool.execute.after` does NOT call sidecar quality checks
- [ ] OpenCode plugin `tool.execute.after` does NOT run `npx tsc --noEmit`
- [ ] Plugin still checks file length, NestJS/Angular patterns, companion tests
- [ ] Rebuild embedded assets: `bun run embed-assets`
- [ ] Grep confirms no quality check calls in tool.execute.after block

**Verify:**

- `bun run embed-assets`
- Grep: no `qualityCheck` or `tsc --noEmit` in the tool.execute.after section

### Task 3: Update Rules, Skills, and AGENTS.md for On-Demand Quality Checks

**Objective:** Update all instructional files so AI assistants know quality checks (tsc, eslint, prettier) are now on-demand only, and they MUST call `quality_report` after finishing edits to a file.

**Dependencies:** None

**Files:**

- Modify: `targets/claude-code/rules/verification.md`
- Modify: `targets/opencode/rules/verification.md`
- Modify: `targets/claude-code/rules/development-practices.md`
- Modify: `targets/opencode/rules/development-practices.md`
- Modify: `targets/opencode/skills/spec-implement/SKILL.md` (step 2.3 item 9)
- Modify: `targets/claude-code/commands/spec-implement.md` (step 2.3 item 9)
- Modify: `~/.config/Claude/AGENTS.md` (Quality Enforcement section)

**Key Decisions / Notes:**

- In `verification.md` — update the "Sentinal Quality Tools" section: "Quality checks (tsc, eslint, prettier) do NOT run automatically on every edit. Sentinal only performs instant structural checks (file length, companion tests) per edit. You MUST call `quality_report` MCP tool after finishing edits to each file to run tsc + eslint + prettier."
- In `development-practices.md` — update the "Diagnostics" line: "Quality checks are on-demand. Call `quality_report` after completing changes to each file. Call `check_diagnostics` for TypeScript-only checks."
- In `spec-implement` (both targets) — update step 2.3 item 9: "**Run quality checks** — `quality_report` MCP tool. Quality checks do NOT run automatically on edit. You MUST call this after completing edits to each file. Zero errors required."
- In AGENTS.md — update Quality Enforcement: "**Quality checks (tsc, eslint, prettier):** On-demand only via `quality_report` MCP tool. NOT automatic on every edit. Only instant structural checks (file length, companion tests) run per edit."

**Definition of Done:**

- [ ] verification.md (both targets) explicitly states all quality checks are on-demand
- [ ] development-practices.md (both targets) explicitly states all quality checks are on-demand
- [ ] spec-implement skill/command (both targets) has updated step 2.3 item 9
- [ ] AGENTS.md updated with on-demand quality check language
- [ ] Language is clear, actionable, and uses strong directive ("MUST")

**Verify:**

- Read the updated files and confirm clarity
