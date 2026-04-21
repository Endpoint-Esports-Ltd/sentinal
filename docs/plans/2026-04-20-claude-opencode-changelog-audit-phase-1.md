# Phase 1: UX + Settings Polish

Created: 2026-04-20
Status: PENDING
Approved: No
Iterations: 0
Worktree: No
Type: Feature
Parent: 2026-04-20-claude-opencode-changelog-audit
Wave: 1

## Summary

**Goal:** Adopt the 14 remaining low-risk UX, settings, frontmatter, and doc items from the Claude Code + OpenCode changelog audit. Each item is ≤1h work; total effort ~2-3 days.

**Architecture:** Config, frontmatter, and doc-only changes across `targets/claude-code/`, `targets/opencode/`, `src/cli/commands/statusline.ts`, and `src/utils/file-length.ts`. No new subprocess code; no architectural shifts. Every change is additive — existing behaviors preserved.

**Tech Stack:** TypeScript (statusline + file-length only), YAML frontmatter, JSON settings, Markdown docs.

## Scope

### In Scope

**Already verified as NOT YET adopted** (exploration found these missing):

1. `workspace.git_worktree` surfacing in statusline output [CC-11]
2. Statusline `refreshInterval` setting [CC-12]
3. `hookSpecificOutput.sessionTitle` injection in UserPromptSubmit hook [CC-8]
4. `once: true` on `memory-restore` + `session-start` hook entries in `hooks.json`
5. `plansDirectory: "docs/plans"` setting in `settings.json`
6. `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: "10000"` in `settings.json.env`
7. `effort: xhigh` on `spec-plan.md` + `spec-master-plan.md` (Opus 4.7 tuning)
8. `${CLAUDE_PLUGIN_DATA}` env var support for memory DB location
9. `paths:` frontmatter on remaining OpenCode rules files (parity with Claude Code)
10. `claude plugin validate` in `package.json` scripts + CI (warn-only initially)
11. `isolation: worktree` + `memory: project` frontmatter on the `research.md` agent [CC-13, CC-14]
12. File-length exemption allowlist for `targets/opencode/plugins/sentinal.ts` in `src/utils/file-length.ts`
13. `.sentinal/rules/sentinal-testing.md` — document the `sentinal.ts` exemption explicitly
14. Doc-only tasks (batched): OpenCode `--dangerously-skip-permissions`, MDM guidance, `--agent` override, `opencode export --sanitize`, `.sentinal/` gitignore

### Out of Scope

- `isolation: worktree` on plan-reviewer / spec-reviewer agents (prior audit explicitly rejected — they read main tree)
- `memory` frontmatter on non-research agents (YAGNI — no clear use case today)
- OC-3 plugin `authorize` API (deferred per plan-reviewer; see master plan)
- OpenCode workspace adaptor (Phase 5 territory)

### Already Done (from prior audits — verified not to redo)

- `effort: high` on `spec-plan.md`, `spec-master-plan.md`, `spec-bugfix-plan.md`
- `paths:` on Claude Code rules: standards-{angular,backend,frontend,nestjs,typescript}.md + team-sharing.md
- `paths:` on OpenCode `team-sharing.md`
- Agent frontmatter `isolation`/`background`/`maxTurns`/`disallowedTools` basics

## Context for Implementer

> Read this before touching any file.

### Key files (and what's in them today)

| File | Current state | What changes |
|---|---|---|
| `src/cli/commands/statusline.ts` | 321 lines, parses rate_limits + context_window from session JSON | Add `workspace.git_worktree` field extraction + output |
| `targets/claude-code/settings.json` | 93 lines, has env + permissions.allow + spinnerTipsOverride | Add `statusLine.refreshInterval`, `plansDirectory`, env var |
| `targets/claude-code/hooks/hooks.json` | 100+ lines, defines all hooks | Add `once: true` to 2 entries; may touch UserPromptSubmit matcher |
| `src/hooks/prompt-context.ts` | Existing UserPromptSubmit hook | Add `hookSpecificOutput.sessionTitle` to output when active spec present |
| `src/utils/file-length.ts` | `TEST_PATTERNS` array, `isGeneratedFile`, `checkFileLength()` | Add `PATH_EXEMPTIONS` array, check in `checkFileLength` |
| `src/memory/config.ts` / `src/memory/store.ts` | Memory DB path resolution (`getDbPath()`) | Prefer `$CLAUDE_PLUGIN_DATA` over current default when set |
| `targets/claude-code/agents/research.md` | Existing agent | Add `isolation: worktree` + `memory: project` to frontmatter |
| `targets/claude-code/commands/spec-plan.md` | Has `effort: high` | Change to `effort: xhigh` (Opus 4.7 fallback: `high`) |
| `targets/claude-code/commands/spec-master-plan.md` | Has `effort: high` | Change to `effort: xhigh` |
| `targets/opencode/rules/standards-{angular,backend,frontend,nestjs,typescript}.md` | No `paths:` | Add `paths:` frontmatter mirroring Claude Code targets |
| `.sentinal/rules/sentinal-testing.md` | Current file-length rules | Add explicit exemption clause for `targets/opencode/plugins/sentinal.ts` |
| `package.json` | Current scripts | Add `"validate:plugin": "claude plugin validate targets/claude-code || true"` (warn-only) |
| `AGENTS.md` / `docs/` | User-facing docs | Add snippets for `--dangerously-skip-permissions`, MDM, `--agent`, sanitize, gitignore |

### Patterns to follow

- **Statusline format:** `src/cli/commands/statusline.ts:133` — `formatStatusline()` returns space-separated pipe format. New `workspace.git_worktree` should be appended as `📁 <branch>` when present (use the worktree branch name, not path).
- **Settings.json extension:** `targets/claude-code/settings.json` — keep the JSON formatted as-is (no semicolons, 2-space indent); add new keys at the TOP-LEVEL (statusLine object, env object).
- **Frontmatter additions:** YAML frontmatter uses hyphens for list items. For `effort: xhigh`, preserve any other frontmatter keys verbatim.
- **File-length allowlist:** add near `TEST_PATTERNS` at `src/utils/file-length.ts`, use the same `PATH_EXEMPTIONS: ReadonlyArray<string>` pattern with absolute-path matching against the input.

### Gotchas

- **Embed-assets rebuild required:** After changes to `targets/claude-code/**` or `targets/opencode/**`, run `bun run embed-assets` to regenerate `src/cli/embedded-assets.ts`.
- **Statusline must never fail visibly** (`statusline.ts:317-319`). The new `workspace.git_worktree` code must be try/catch-wrapped.
- **hooks.json `once: true` semantics:** docs indicate the hook fires only on first matching event per session — verify with a test session that runs two `SessionStart` matches.
- **xhigh fallback:** changelog says non-Opus-4.7 models fall back to `high` automatically — no defensive code needed.
- **OpenCode `paths:` frontmatter:** OpenCode supports it but format parity with Claude Code is NOT guaranteed. Must verify OpenCode parses the same YAML (Sentinal prior audit notes OpenCode uses different config schema).

### Domain context

Sentinal is a dual-target plugin for Claude Code + OpenCode. All 14 items in this phase map to **shipped artifacts** (`targets/`) or **product behavior** (`src/`). Every change touches exactly one of:
- An end-user-facing file (rules, agents, commands in `targets/**/`)
- A single source-code function (`statusline.ts`, `file-length.ts`, `memory/config.ts`, `prompt-context.ts`, `hooks.json`)
- A CI/package.json script

All 14 items are independently testable, have no cross-dependencies, and can be committed in separate atomic commits.

## Assumptions

- Claude Code v2.1.97+ accepts `refreshInterval` as a statusLine setting key — supported by changelog entry — Task 2 depends on this.
- Claude Code v2.1.94+ parses `hookSpecificOutput.sessionTitle` from UserPromptSubmit hook output — supported by changelog — Task 3 depends on this.
- Claude Code v2.1.78+ reads `${CLAUDE_PLUGIN_DATA}` env var at plugin context load — supported by changelog; defaults safely when missing — Task 8 depends on this.
- OpenCode rules parse YAML frontmatter `paths:` field the same way Claude Code does — NEEDS VERIFICATION. If they diverge, Task 9 scope narrows to Claude Code only.
- `claude plugin validate` exits 0 on warning, non-zero only on error — supported by changelog entry 2.1.77 — Task 10 relies on this for "warn-only" CI gate.

## Testing Strategy

- **Unit tests** for `statusline.ts` (extract + format `git_worktree`), `file-length.ts` (PATH_EXEMPTIONS behavior), `memory/config.ts` (`$CLAUDE_PLUGIN_DATA` handling).
- **Integration tests** for `prompt-context.ts` (sessionTitle output when spec active).
- **Smoke tests** for `hooks.json` (parse + schema check via `claude plugin validate`).
- **Manual verification** for doc-only items: review rendering, link checks.
- Full `bun test` + `npx tsc --noEmit` + `bun run build:all` as the final gate per phase.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| OpenCode `paths:` frontmatter format differs from Claude Code | Medium | Low | Task 9 first verifies against one rules file; if broken, scope narrows |
| Statusline new field breaks existing terminals with narrow width | Low | Low | Append at end of existing format; existing short-circuit on empty `modelUsage` shows the pattern |
| `${CLAUDE_PLUGIN_DATA}` path doesn't exist or isn't writable | Medium | Medium | Fall back to existing `getDbPath()` if env var missing or path unwritable |
| `claude plugin validate` is strict and rejects existing frontmatter | Medium | Low | `--warn-only` flag in CI per master plan Pre-Mortem #9 |
| PATH_EXEMPTIONS allowlist is too permissive | Low | Medium | Absolute-path match only, exact string; no glob |
| OpenCode plugin line-count rule disagrees with our exemption | Low | Low | Document exemption in `.sentinal/rules/sentinal-testing.md` as authoritative |

## Pre-Mortem

_Assume this plan failed. Most likely internal reasons:_

1. **OpenCode `paths:` frontmatter not respected** (Task 9) → Trigger: after installing, OpenCode loads all rules regardless of the `paths:` field, or errors on the frontmatter. Mitigation: verify against one file first; if broken, narrow to CC-only and add a note in OpenCode rules docs.
2. **`hookSpecificOutput.sessionTitle` doesn't actually set the session title** (Task 3) → Trigger: output is parsed but title doesn't appear in the UI. Mitigation: test with a live Claude Code session in a dev project before marking task complete.
3. **File-length allowlist is bypassed by the hook call path** (Task 12) → Trigger: `checkFileLength()` respects allowlist but the hook (file-checker) computes length before calling it. Mitigation: grep `file-checker.ts` for `countLines(` / `readFileSync` and ensure allowlist gate runs first.
4. **Embed-assets build forgotten** → Trigger: targets/ changes don't appear in installed plugin. Mitigation: Task 13 (verify) runs `bun run embed-assets` + diff check.

## Execution Waves

**Wave 1 — All tasks in parallel.** Every task modifies a different file (or a different frontmatter field of different files). There is no file overlap. The two tasks that both touch `settings.json` (Task 2 refreshInterval + Task 5 plansDirectory + Task 6 timeout env) are consolidated into Task 2-combined.

## Goal Verification

### Truths

1. `src/cli/commands/statusline.ts` contains `git_worktree` reference in an `extract*` function (grep-verifiable: `git_worktree`).
2. `targets/claude-code/settings.json` contains `"refreshInterval":` key (grep-verifiable: `"refreshInterval":`).
3. `targets/claude-code/settings.json` env block contains `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` (grep-verifiable).
4. `targets/claude-code/settings.json` contains `"plansDirectory":` key (grep-verifiable).
5. `targets/claude-code/hooks/hooks.json` contains `"once": true` on memory-restore AND session-start entries (grep-verifiable: two matches).
6. `src/hooks/prompt-context.ts` outputs `hookSpecificOutput.sessionTitle` when active spec exists (grep-verifiable: `hookSpecificOutput.*sessionTitle` in source + test covers).
7. `targets/claude-code/commands/spec-plan.md` + `spec-master-plan.md` frontmatter contains `effort: xhigh` (grep-verifiable).
8. `src/memory/config.ts` or `store.ts` reads `process.env.CLAUDE_PLUGIN_DATA` (grep-verifiable).
9. All 5 OpenCode `standards-*.md` files contain `paths:` frontmatter (grep-verifiable: `paths:` appears in all 5).
10. `package.json` scripts block contains `validate:plugin` (grep-verifiable).
11. `targets/claude-code/agents/research.md` frontmatter contains `isolation: worktree` AND `memory: project` (grep-verifiable).
12. `src/utils/file-length.ts` contains `PATH_EXEMPTIONS` array with `sentinal.ts` entry (grep-verifiable: `PATH_EXEMPTIONS` + `sentinal\.ts`).
13. `.sentinal/rules/sentinal-testing.md` contains explicit exemption paragraph for `sentinal.ts` (grep-verifiable).
14. User-facing docs (AGENTS.md or dedicated docs file) reference `--dangerously-skip-permissions`, MDM, `--agent`, `--sanitize`, `.sentinal/` gitignore (grep-verifiable — 5 terms present).

### Artifacts

| Artifact | Provides | Exports |
|---|---|---|
| `src/cli/commands/statusline.ts` (modified) | Statusline with worktree branch surfaced | `formatStatusline()` + `extractWorktree()` helper |
| `targets/claude-code/settings.json` (modified) | 3 new config keys | N/A (JSON data) |
| `targets/claude-code/hooks/hooks.json` (modified) | `once: true` on 2 hook entries | N/A (JSON data) |
| `src/hooks/prompt-context.ts` (modified) | sessionTitle on UserPromptSubmit | `handlePromptContext()` returning HookOutput with hookSpecificOutput.sessionTitle |
| `src/utils/file-length.ts` (modified) | Path-exemption allowlist | `checkFileLength()` + new `PATH_EXEMPTIONS` constant |
| `src/memory/config.ts` (modified) | CLAUDE_PLUGIN_DATA env var honored | `getDbPath()` |
| `src/memory/config.test.ts` (modified) | Unit tests for env var path | Test suite |
| `src/cli/commands/statusline.test.ts` (modified) | Unit tests for worktree extraction | Test suite |
| `src/utils/file-length.test.ts` (modified) | Unit tests for PATH_EXEMPTIONS | Test suite |
| `src/hooks/prompt-context.test.ts` (modified) | Unit test for sessionTitle output | Test suite |
| `targets/claude-code/commands/spec-plan.md` (modified) | Frontmatter `effort: xhigh` | Skill definition |
| `targets/claude-code/commands/spec-master-plan.md` (modified) | Frontmatter `effort: xhigh` | Skill definition |
| `targets/claude-code/agents/research.md` (modified) | Worktree isolation + project memory | Agent definition |
| `targets/opencode/rules/standards-angular.md` (modified) | `paths:` frontmatter | Rule file |
| `targets/opencode/rules/standards-backend.md` (modified) | `paths:` frontmatter | Rule file |
| `targets/opencode/rules/standards-frontend.md` (modified) | `paths:` frontmatter | Rule file |
| `targets/opencode/rules/standards-nestjs.md` (modified) | `paths:` frontmatter | Rule file |
| `targets/opencode/rules/standards-typescript.md` (modified) | `paths:` frontmatter | Rule file |
| `.sentinal/rules/sentinal-testing.md` (modified) | File-length exemption documented | Dev rule |
| `package.json` (modified) | `validate:plugin` script | N/A (package metadata) |
| `docs/changelog-adoptions-phase1.md` (new) | User-facing docs snippets | Documentation |

### Key Links

| From | To | Via | Pattern |
|---|---|---|---|
| `src/cli/commands/statusline.ts` | Claude Code session JSON | reads `session.workspace.git_worktree` | `workspace.*git_worktree` |
| `src/hooks/prompt-context.ts` | Claude Code hook output contract | `hookSpecificOutput.sessionTitle` | `hookSpecificOutput.*sessionTitle` |
| `targets/claude-code/hooks/hooks.json` | `sentinal hook shared memory-restore` | `command` field | `memory-restore` |
| `src/utils/file-length.ts` | `sentinal.ts` exemption | `PATH_EXEMPTIONS` array | `sentinal\.ts` |
| `targets/claude-code/settings.json` | `docs/plans/` | `plansDirectory` setting value | `"plansDirectory".*docs/plans` |
| `.sentinal/rules/sentinal-testing.md` | `sentinal.ts` exemption rationale | prose paragraph | `sentinal\.ts.*exempt` |

## Progress Tracking

- [ ] Task 1: Statusline `workspace.git_worktree` (Wave 1)
- [ ] Task 2: settings.json additions — refreshInterval + plansDirectory + SESSIONEND_HOOKS timeout (Wave 1)
- [ ] Task 3: UserPromptSubmit sessionTitle injection (Wave 1)
- [ ] Task 4: hooks.json `once: true` on memory-restore + session-start (Wave 1)
- [ ] Task 5: effort: xhigh on spec-plan + spec-master-plan (Wave 1)
- [ ] Task 6: `${CLAUDE_PLUGIN_DATA}` env var support in memory config (Wave 1)
- [ ] Task 7: OpenCode rules `paths:` frontmatter parity (Wave 1)
- [ ] Task 8: `claude plugin validate` in package.json scripts (warn-only) (Wave 1)
- [ ] Task 9: research agent — isolation: worktree + memory: project (Wave 1)
- [ ] Task 10: File-length PATH_EXEMPTIONS in src/utils/file-length.ts (Wave 1)
- [ ] Task 11: `.sentinal/rules/sentinal-testing.md` exemption doc (Wave 1)
- [ ] Task 12: User-facing docs for OpenCode CLI flags + MDM + gitignore (Wave 1)
- [ ] Task 13: Embed-assets regen + full verification (Wave 2 — sequential final)

**Total Tasks:** 13 | **Completed:** 0 | **Remaining:** 13

## Implementation Tasks

### Task 1: Statusline `workspace.git_worktree`

**Objective:** Surface the worktree branch (when present) in the statusline output.
**Dependencies:** None
**Wave:** 1

**Files:**
- Modify: `src/cli/commands/statusline.ts`
- Modify: `src/cli/commands/statusline.test.ts`

**Key Decisions / Notes:**
- Input shape from changelog v2.1.97/2.1.98: `session.workspace.git_worktree = { name, path, branch, originalRepoDir }` when active.
- New helper: `extractWorktree(sessionJson): { branch: string } | null` — returns `null` if field absent or malformed.
- Format: append `📁 <branch>` to statusline when present. When a worktree is active AND branch differs from `main`, highlight. When no worktree, omit.
- Must not break narrow terminals — append at end; existing format already soft-fails on missing fields.
- Wrap in try/catch per statusline.ts:316-319 (never fail visibly).

**Definition of Done:**
- [ ] `extractWorktree()` helper added, tested with 3 cases (present, absent, malformed)
- [ ] `formatStatusline()` appends worktree segment when `workspaceBranch` is set
- [ ] `registerStatuslineCommand` action reads + passes `workspaceBranch` to formatter
- [ ] Unit tests added, all pass
- [ ] `bun run build:cli` succeeds

**Verify:**
- `bun test src/cli/commands/statusline.test.ts --verbose`
- `echo '{"workspace":{"git_worktree":{"branch":"feature/foo"}}}' | bun run src/cli/index.ts statusline` → output contains `📁 feature/foo`

### Task 2: settings.json additions (refreshInterval + plansDirectory + SESSIONEND_HOOKS timeout)

**Objective:** Add 3 Claude Code settings as a single atomic settings.json update.
**Dependencies:** None
**Wave:** 1

**Files:**
- Modify: `targets/claude-code/settings.json`
- Modify: `src/cli/target-assets.test.ts` (add assertions for new keys)

**Key Decisions / Notes:**
- Add to top-level: `"statusLine": { "refreshInterval": 30 }` (30 seconds — enough for context% drift, cheap to re-run)
- Add to top-level: `"plansDirectory": "docs/plans"` (aligns Claude's `/plan` with Sentinal's spec layout)
- Add to `env`: `"CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS": "10000"` (matches the 10s timeout in hooks.json session-end)
- Preserve all existing keys (permissions, alwaysThinkingEnabled, respectGitignore, spinnerTipsOverride) byte-for-byte.

**Definition of Done:**
- [ ] JSON parses cleanly
- [ ] All 3 new keys present at correct paths
- [ ] Existing keys untouched (diff review)
- [ ] `src/cli/target-assets.test.ts` asserts on new keys

**Verify:**
- `jq '.statusLine.refreshInterval, .plansDirectory, .env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS' targets/claude-code/settings.json` → outputs `30`, `"docs/plans"`, `"10000"` respectively
- `bun test src/cli/target-assets.test.ts`

### Task 3: UserPromptSubmit `sessionTitle` injection

**Objective:** When a spec plan is active, set the session title via `hookSpecificOutput.sessionTitle`.
**Dependencies:** None
**Wave:** 1

**Files:**
- Modify: `src/hooks/prompt-context.ts`
- Modify: `src/hooks/prompt-context.test.ts`

**Key Decisions / Notes:**
- Look for active spec via `SpecStore.getCurrentSpec(projectPath)` or `SidecarClient.specStatus()`.
- Title format: `spec:<spec-slug>` (e.g., `spec:2026-04-20-changelog-audit`). Truncate to 80 chars if needed.
- Only set when a spec is PENDING or IN_PROGRESS (not VERIFIED — those are done).
- Always include the existing behavior (the prompt-context additionalContext) — the sessionTitle is purely additive on the same output.

**Definition of Done:**
- [ ] Hook output contains `hookSpecificOutput: { sessionTitle: "spec:..." }` when active spec exists
- [ ] No `hookSpecificOutput` field when no active spec
- [ ] Existing additionalContext behavior preserved
- [ ] Unit test covers all 3 states (active spec, no spec, verified spec)

**Verify:**
- `bun test src/hooks/prompt-context.test.ts --verbose`

### Task 4: hooks.json `once: true` on session-start handlers

**Objective:** Mark `memory-restore` + `session-start` hooks as once-per-session to match actual semantics.
**Dependencies:** None
**Wave:** 1

**Files:**
- Modify: `targets/claude-code/hooks/hooks.json`
- Modify: `src/cli/target-assets.test.ts` (add assertion)

**Key Decisions / Notes:**
- Both hooks currently run on every SessionStart matcher hit — but they do session-init work that should run exactly once. `once: true` is the native semantic (changelog 2.1.0).
- Does NOT apply to `post-compact-restore` (that one is on SessionStart+compact matcher and legitimately fires per compact event).

**Definition of Done:**
- [ ] `hooks.json` SessionStart entries for `memory-restore` and `session-start` commands have `"once": true`
- [ ] JSON parses cleanly
- [ ] Test asserts field presence

**Verify:**
- `jq '.hooks.SessionStart[] | select(.hooks[].command | contains("memory-restore") or contains("session-start")) | .once' targets/claude-code/hooks/hooks.json` → prints `true` twice
- `bun test src/cli/target-assets.test.ts`

### Task 5: `effort: xhigh` on plan skills (Opus 4.7 tuning)

**Objective:** Upgrade `spec-plan.md` and `spec-master-plan.md` to `effort: xhigh` per Claude Code 2.1.111.
**Dependencies:** None
**Wave:** 1

**Files:**
- Modify: `targets/claude-code/commands/spec-plan.md`
- Modify: `targets/claude-code/commands/spec-master-plan.md`

**Key Decisions / Notes:**
- Change `effort: high` → `effort: xhigh` in frontmatter only.
- Non-Opus-4.7 models fall back to `high` automatically per changelog — no defensive code needed.
- **Do NOT touch `spec-bugfix-plan.md`** — bugfixes are usually mechanical root-cause tracing; `high` is appropriate.

**Definition of Done:**
- [ ] Both files have `effort: xhigh` in frontmatter
- [ ] No other frontmatter changes
- [ ] No body text changes

**Verify:**
- `grep "^effort: xhigh" targets/claude-code/commands/spec-plan.md targets/claude-code/commands/spec-master-plan.md` → 2 matches

### Task 6: `${CLAUDE_PLUGIN_DATA}` env var support in memory config

**Objective:** Use Claude Code's plugin-data dir for memory DB when the env var is set.
**Dependencies:** None
**Wave:** 1

**Files:**
- Modify: `src/memory/config.ts` (or wherever `getDbPath()` lives)
- Modify: `src/memory/config.test.ts`

**Key Decisions / Notes:**
- Check `process.env.CLAUDE_PLUGIN_DATA` first. If set AND path is writable, use `${CLAUDE_PLUGIN_DATA}/sentinal.db`.
- Fall back to current default (likely `.sentinal/memory.db` in project or `~/.sentinal/memory.db`) if env var absent OR path not writable.
- Writability check: try `fs.accessSync(path, fs.constants.W_OK)` with fallback on exception.
- This is OPT-IN via env var; no migration of existing DBs (they stay at their current location until user moves them).

**Definition of Done:**
- [ ] `getDbPath()` prefers `$CLAUDE_PLUGIN_DATA` when set and writable
- [ ] Falls back to existing path when env var absent or path unwritable
- [ ] 3 test cases: env var unset, env var set to writable, env var set to unwritable

**Verify:**
- `bun test src/memory/config.test.ts --verbose`

### Task 7: OpenCode rules `paths:` frontmatter parity

**Objective:** Add `paths:` frontmatter to 5 OpenCode standards rules, mirroring Claude Code versions — with a verification-first guard to avoid reworking 5 files if OpenCode doesn't parse the field.

**Dependencies:** None (but Task 7a must complete before 7b)
**Wave:** 1

**Files:**
- Modify: `targets/opencode/rules/standards-angular.md`
- Modify: `targets/opencode/rules/standards-backend.md`
- Modify: `targets/opencode/rules/standards-frontend.md`
- Modify: `targets/opencode/rules/standards-nestjs.md`
- Modify: `targets/opencode/rules/standards-typescript.md`
- (conditional) Create: `.sentinal/rules/sentinal-opencode-rules.md` — only if verification fails

**Sequential sub-steps:**

**7a — 5-minute pre-check (before any edits):**
- Run `rg -i 'paths' targets/opencode/plugins/sentinal.ts` and `rg -i 'frontmatter' targets/opencode/plugins/sentinal.ts`
- Search OpenCode docs or plugin SDK types (`@opencode-ai/plugin`) for a `paths` rule-loader field
- **Expected outcome paths:**
  - **Parse evidence found** → proceed to 7b (full 5-file adoption)
  - **No evidence found OR explicit docs say "OpenCode rules load globally"** → proceed to 7c (docs-only divergence note)

**7b — Full adoption (only if 7a confirmed):**
- Start with ONE file: `standards-typescript.md`. Copy the `paths:` YAML block exactly from `targets/claude-code/rules/standards-typescript.md`.
- Install into dev project (`bun run install:opencode`). Open a matching `.ts` file AND a non-matching file (e.g., a `.md`). Confirm rule loads for the match and is suppressed for the non-match.
- If confirmed: propagate to the remaining 4 files.
- If NOT confirmed at this stage: revert the typescript.md edit; fall through to 7c.

**7c — Divergence documentation path:**
- Revert any edits made to OpenCode rules
- Create `.sentinal/rules/sentinal-opencode-rules.md` with:
  - A clear statement: "OpenCode rules do not support `paths:` frontmatter (as of v1.3.x). Claude Code rules DO support it. This is a target-specific divergence."
  - Cross-reference to `targets/claude-code/rules/` for developers reading CC rules
- Mark Task 7 complete — scope is now the divergence note, not file edits.

**Key Decisions / Notes:**
- Copy `paths:` YAML block exactly from the corresponding `targets/claude-code/rules/standards-*.md` file.
- Preserve all other frontmatter fields.
- The 7a pre-check is ~5 minutes and prevents a 5-file revert cycle.

**Definition of Done:**
- [ ] Task 7a pre-check performed and outcome documented in the task's commit message
- [ ] EITHER: All 5 OpenCode standards files have `paths:` block matching Claude Code counterpart (7b path)
- [ ] OR: `.sentinal/rules/sentinal-opencode-rules.md` exists documenting the divergence (7c path)
- [ ] Dev-project test performed (only under 7b) confirms OpenCode respects the frontmatter

**Verify:**
- Under 7b path: `grep -l "^paths:" targets/opencode/rules/standards-*.md | wc -l` → `5`
- Under 7c path: `grep -l "OpenCode rules do not support.*paths" .sentinal/rules/sentinal-opencode-rules.md` → match

### Task 8: `claude plugin validate` in package.json (warn-only)

**Objective:** Add CI-friendly plugin validation command.
**Dependencies:** None
**Wave:** 1

**Files:**
- Modify: `package.json`

**Key Decisions / Notes:**
- Add to `scripts`: `"validate:plugin": "claude plugin validate targets/claude-code 2>&1 | tee /tmp/sentinal-plugin-validate.log || true"`.
- The `|| true` makes it warn-only — it prints validation output but never fails CI.
- CI job config (`.github/workflows/`) out of scope for this task — can be wired in a follow-up. Just add the script entry.

**Definition of Done:**
- [ ] `validate:plugin` script entry exists in package.json
- [ ] Running `bun run validate:plugin` executes without failing

**Verify:**
- `jq '.scripts."validate:plugin"' package.json` → prints the command
- `bun run validate:plugin` → exits 0 (warn-only)

### Task 9: research agent — isolation + memory frontmatter

**Objective:** Add `isolation: worktree` + `memory: project` to research.md agent frontmatter.
**Dependencies:** None
**Wave:** 1

**Files:**
- Modify: `targets/claude-code/agents/research.md`
- (Optional) Modify: `targets/opencode/agents/research.md` if it exists

**Key Decisions / Notes:**
- `isolation: worktree` — research agent is stateless reader; isolating in worktree prevents any accidental writes to main tree. Safe default.
- `memory: project` — project-scoped memory for research queries. Distinct from Sentinal's memory store; complementary.
- Preserve existing frontmatter (description, tools, etc.).

**Definition of Done:**
- [ ] `research.md` frontmatter has `isolation: worktree` and `memory: project`
- [ ] No other frontmatter changes
- [ ] Agent still loads after reinstall (`sentinal install claude-code`)

**Verify:**
- `grep -E "^(isolation|memory):" targets/claude-code/agents/research.md` → 2 matches

### Task 10: File-length PATH_EXEMPTIONS

**Objective:** Allow `targets/opencode/plugins/sentinal.ts` to bypass file-length checks.
**Dependencies:** None
**Wave:** 1

**Files:**
- Modify: `src/utils/file-length.ts`
- Modify: `src/utils/file-length.test.ts`

**Key Decisions / Notes:**
- Add constant near `TEST_PATTERNS`:
  ```ts
  const PATH_EXEMPTIONS: ReadonlyArray<string> = [
    "targets/opencode/plugins/sentinal.ts",
  ];
  ```
- In `checkFileLength(filePath, ...)`, add check:
  ```ts
  if (PATH_EXEMPTIONS.some((exempt) => filePath.endsWith(exempt))) {
    return null;
  }
  ```
- Use `endsWith` (not exact match) to handle both absolute and relative paths.
- Test: `sentinal.ts` at 1008 lines returns `null` (no warning, no block).

**Definition of Done:**
- [ ] `PATH_EXEMPTIONS` constant added
- [ ] `checkFileLength()` early-returns for exempt paths (before test + generated checks is fine)
- [ ] Test case for `sentinal.ts` at 1200 lines returns `null`
- [ ] Test case for random 1200-line file still blocks
- [ ] **Pre-Mortem #3 mitigation:** `grep -E "countLines|readFileSync.*split.*\\\\n|split\\(['\\\"]\\\\n" src/hooks/file-checker.ts` — confirm file-checker either delegates to `checkFileLength()` or consults `PATH_EXEMPTIONS` before reporting a block. If it has an independent length-computation code path, add the allowlist check there too.
- [ ] **Integration test:** feed a synthetic HookInput for `targets/opencode/plugins/sentinal.ts` through the file-checker hook directly (`src/hooks/file-checker.ts`'s exported handler), assert no block/warn output is produced.

**Verify:**
- `bun test src/utils/file-length.test.ts --verbose`
- `bun test src/hooks/file-checker.test.ts --verbose` (includes the integration test above)
- `grep "PATH_EXEMPTIONS" src/utils/file-length.ts` → at least 2 matches (declaration + usage)

### Task 11: `.sentinal/rules/sentinal-testing.md` exemption doc

**Objective:** Codify the `sentinal.ts` file-length exemption in dev rules.
**Dependencies:** Task 10 (code change done first)
**Wave:** 1

**Files:**
- Modify: `.sentinal/rules/sentinal-testing.md`

**Key Decisions / Notes:**
- Add a paragraph under the "File-Length Limits" section explaining:
  - The exemption: `targets/opencode/plugins/sentinal.ts`
  - The rationale: single-file plugin format is an OpenCode platform constraint, not a code smell.
  - The DRY principle: shared logic should be extracted to `src/opencode/*.ts` for testability/reuse, but not solely to reduce line count.
  - Enforced by: `PATH_EXEMPTIONS` in `src/utils/file-length.ts`.

**Definition of Done:**
- [ ] Paragraph added
- [ ] References `PATH_EXEMPTIONS` constant by name for cross-ref

**Verify:**
- `grep -E "sentinal\.ts.*exempt|exempt.*sentinal\.ts" .sentinal/rules/sentinal-testing.md` → 1+ matches

### Task 12: User-facing docs — OpenCode CLI flags + MDM + gitignore

**Objective:** Single doc file capturing 5 small OpenCode adoption notes.
**Dependencies:** None
**Wave:** 1

**Files:**
- Create: `docs/changelog-adoptions-phase1.md`

**Key Decisions / Notes:**
- One file, 5 short sections:
  1. `opencode run --dangerously-skip-permissions` — use for CI / spec-master runs
  2. macOS MDM guidance — how to pin Sentinal settings via MDM profiles
  3. `--agent` CLI flag — overriding session's saved agent on resume
  4. `opencode export --sanitize` — companion to `/learn`
  5. `.sentinal/` gitignore — ergonomics note (exclude runtime state, include plans)
- Each section: 1-3 paragraphs max.
- Link from `README.md` and/or `AGENTS.md` in a follow-up (not required this task).

**Definition of Done:**
- [ ] `docs/changelog-adoptions-phase1.md` exists
- [ ] All 5 topics covered
- [ ] No stub/TODO markers
- [ ] Grep-verifiable mentions for each feature name

**Verify:**
- `grep -E "dangerously-skip-permissions|MDM|--agent|--sanitize|\.sentinal/" docs/changelog-adoptions-phase1.md | wc -l` → ≥5

### Task 13: Embed-assets regen + full verification

**Objective:** Final step — regenerate embedded assets, run full test suite, tsc, and quality checks.
**Dependencies:** ALL prior tasks (Wave 2 sequential)
**Wave:** 2

**Files:**
- Regenerated: `src/cli/embedded-assets.ts` (auto)

**Key Decisions / Notes:**
- `bun run embed-assets` must be run because `targets/**/*.md` and `settings.json` changes won't reach installed plugins without re-embedding.
- Expected diff: embedded-assets.ts line count increases slightly; no other source changes.
- Full regression suite: `bun test` (all), `bunx tsc --noEmit`, `bun run build:all`.
- Manual sanity: fresh install in a test project, verify statusline shows new field, hooks still fire, settings load.

**Definition of Done:**

**Pre-embed validation checkpoint** (catches bad inputs before the 11k-line auto-generated diff):
- [ ] `jq . targets/claude-code/settings.json > /dev/null` — JSON parses cleanly
- [ ] `jq . targets/claude-code/hooks/hooks.json > /dev/null` — JSON parses cleanly
- [ ] `bun run validate:plugin` — exits 0 (warn-only) with no hard errors

**Embed + automated gates:**
- [ ] `bun run embed-assets` runs successfully
- [ ] `src/cli/embedded-assets.ts` diff only reflects intended target changes (review before commit)
- [ ] `bun test` passes (all tests)
- [ ] `bunx tsc --noEmit` clean
- [ ] `bun run build:all` succeeds

**Manual smoke tests** (de-risks Pre-Mortem #1, #2 — these cannot be caught by automation):
- [ ] Install Phase 1 build into a dev Claude Code project (`bun run install:claude-code`) and open a fresh session. Confirm statusline shows `📁 <branch>` when a git worktree is active (use `git worktree add` to create one for the test).
- [ ] In the same dev session, submit a prompt while a spec is active (any `PENDING`/`IN_PROGRESS` plan). Confirm the session title displays as `spec:<slug>` in Claude Code's UI.
- [ ] Open any `.ts` file matching an OpenCode `paths:` pattern (e.g., a `*.component.ts` for angular rules) and confirm the rule loads. If OpenCode does not honor `paths:` (Task 7 escape path triggered), confirm the divergence is documented in `.sentinal/rules/sentinal-opencode-rules.md`.

**Verify:**
- **Sequential gate order:** `jq . ... && bun run validate:plugin && bun run embed-assets && bun test && bunx tsc --noEmit && bun run build:all`
- Manual smoke tests performed in a separate dev project with captured screenshots or terminal output pasted into the task commit message.

ARGUMENTS: $ARGUMENTS
