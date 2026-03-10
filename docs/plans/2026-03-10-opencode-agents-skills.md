# OpenCode Agents, Skills & Command Fixes

**Status:** VERIFIED
**Type:** Feature
**Approved:** Yes
**Worktree:** No
**Date:** 2026-03-10

## Goal

Add OpenCode-native agent definitions, convert commands to SKILL.md format, fix all broken cross-target references, add post-spec completion audit, and ensure plan-mode write compatibility.

## Background

OpenCode (opencode.ai by Anomaly) now supports a full agent/subagent system with:
- **Primary agents** (`build`, `plan`) — user-facing, switchable via Tab
- **Subagents** (`general`, `explore`) — invoked by LLM via `task` tool or by user via `@mention`
- **Custom agents** — markdown files in `~/.config/opencode/agents/` or `.opencode/agents/`
- **Skills** — `SKILL.md` files in `~/.config/opencode/skills/<name>/SKILL.md`
- **Task permissions** — `permission.task` controls which subagents an agent can invoke

Sentinal currently has no OpenCode agent definitions and its commands were copied verbatim from Claude Code without adapting terminology (`TaskCreate`/`TaskUpdate`, `Skill()`, `.claude/` paths).

## Scope

- **In scope:**
  - Create OpenCode agent definitions (`plan-reviewer`, `spec-reviewer`)
  - Convert OpenCode commands to SKILL.md format
  - Fix broken references in both Claude Code and OpenCode command files
  - Update installer and embedded assets system
  - Update opencode.json config template with agent + permission config
  - Add post-spec completion audit (cross-check .md checkboxes vs SQLite task states)
  - Ensure plan-mode write compatibility (reviewer agents can write findings, spec skills can write .md files)
  - Update uninstaller to revert all new artifacts (agents, skills, permissions)
- **Out of scope:**
  - Changing the core spec workflow logic
  - Adding new agents beyond the existing two
  - Plugin API changes (no custom tools, no new hooks)
  - Claude Code commands-to-skills conversion (Claude Code uses its own native `Skill()` system)

## Architecture

### Agent Definitions

OpenCode agents use markdown frontmatter with these fields:
```yaml
---
description: What the agent does (required)
mode: subagent
tools:
  write: false
  edit: false
  bash: false
permission:
  edit: deny
  bash: deny
---
```

Both `plan-reviewer` and `spec-reviewer` are review agents that read code and write findings to a JSON file. In OpenCode terms: `edit` and `bash` are disabled (deny), but `write` must stay enabled so the agent can create the findings JSON. Model is omitted so it inherits the user's default.

### Plan-Mode Write Compatibility

OpenCode's `plan` primary agent sets `write`/`edit`/`bash` to `ask` (prompt for approval). When running `/spec` in plan mode, the spec skills need to write/update `.md` plan files without being blocked. Two approaches:

1. **Permission overrides in opencode.json** — Add `permission.edit` rules that allow writes to `docs/plans/*.md` paths.
2. **Instruct the user** — The spec workflow commands already instruct the LLM to switch to build mode before making changes. Plan mode is for analysis only.

We'll use approach 1: add granular `edit` permissions for plan files in the config template. This ensures `/spec-plan` can create `docs/plans/*.md` files even when the user is in plan mode.

### Post-Spec Completion Audit

When a spec reaches `VERIFIED` status, the dispatcher (`spec.md`) currently just reports completion. We'll add a final audit step that:

1. Re-parses the plan `.md` file to extract task checkboxes (`[ ]` / `[x]`)
2. Queries `SpecStore` for the spec's task states in SQLite
3. Cross-references: if a task is marked `[x]` in the `.md` but still `pending`/`in-progress` in SQLite, update SQLite to `complete`
4. If a task is `complete` in SQLite but `[ ]` in the `.md`, update the `.md` checkbox to `[x]`
5. Reports any discrepancies found and fixed

This audit runs in both Claude Code (via the `spec.md` dispatcher) and OpenCode (same). It uses the existing `SpecStore.syncFromPlanFile()` for the `.md` → SQLite direction, and adds a new `SpecStore.auditCompletion()` method for the reverse check.

### Skills Conversion

OpenCode skills use `SKILL.md` files with frontmatter:
```yaml
---
name: skill-name
description: What this skill does
---
```

The `/spec` workflow sub-phase commands (`spec-plan`, `spec-implement`, `spec-verify`, `spec-bugfix-plan`, `spec-bugfix-verify`) will be converted from `commands/*.md` to `skills/<name>/SKILL.md` format. The `spec.md` dispatcher will route using the `skill` tool (e.g. `skill({ name: "spec-plan" })`) instead of `/spec-plan $ARGUMENTS`.

Commands and skills coexist in OpenCode. The dispatcher (`spec`) stays as a command (since the user invokes it with `/spec`), and the sub-phases become skills (since the dispatcher invokes them programmatically). `sync` and `learn` stay as commands because the user invokes them directly with `/sync` and `/learn`.

### Broken References to Fix

| File | Line | Current (broken) | Fix |
|------|------|-------------------|-----|
| Both `spec-implement.md` | 22 | `TaskCreate` | `todowrite` |
| Both `spec-implement.md` | 66 | `TaskUpdate` | `todowrite` |
| OC `spec-plan.md` | 70 | "launch the `plan-reviewer` sub-agent in background" | Use task tool or `@plan-reviewer` mention |
| OC `spec-verify.md` | 14 | "Launch the `spec-reviewer` sub-agent" | Same |
| OC `sync.md` | 11,17 | `.claude/rules/` | `.opencode/rules/` |
| OC `learn.md` | 38-39 | `.claude/skills/` | `.opencode/skills/` |
| CC `spec-plan.md` | 70 | "launch the `plan-reviewer` sub-agent in background" | Use `Task(plan-reviewer:...)` syntax |
| CC `spec-verify.md` | 14 | "Launch the `spec-reviewer` sub-agent" | Use `Task(spec-reviewer:...)` syntax |

## Tasks

Done: 9 | Left: 0

### Task 1: Create OpenCode agent definitions
- [x] Create `targets/opencode/agents/plan-reviewer.md` with OpenCode frontmatter format
- [x] Create `targets/opencode/agents/spec-reviewer.md` with OpenCode frontmatter format
- **Files:** create `targets/opencode/agents/plan-reviewer.md`, `targets/opencode/agents/spec-reviewer.md`
- **DoD:** Both agents have correct OpenCode YAML frontmatter (`description`, `mode: subagent`, `tools: { edit: false, bash: false }`, `permission: { edit: deny, bash: deny }`). `write` stays enabled so agents can create findings JSON. Review instructions body adapted from Claude Code originals

### Task 2: Convert OpenCode sub-phase commands to SKILL.md format
- [x] Create `targets/opencode/skills/spec-plan/SKILL.md` from `commands/spec-plan.md`
- [x] Create `targets/opencode/skills/spec-implement/SKILL.md` from `commands/spec-implement.md`
- [x] Create `targets/opencode/skills/spec-verify/SKILL.md` from `commands/spec-verify.md`
- [x] Create `targets/opencode/skills/spec-bugfix-plan/SKILL.md` from `commands/spec-bugfix-plan.md`
- [x] Create `targets/opencode/skills/spec-bugfix-verify/SKILL.md` from `commands/spec-bugfix-verify.md`
- [x] Remove the corresponding `commands/*.md` files for the 5 converted sub-phases
- [x] Keep `commands/spec.md` (dispatcher), `commands/sync.md`, and `commands/learn.md` as commands
- **Files:** create `targets/opencode/skills/*/SKILL.md`, remove 5 files from `targets/opencode/commands/`
- **DoD:** Skills have valid OpenCode frontmatter (`name`, `description`). Dispatcher (`spec.md`) updated to invoke skills via skill tool syntax instead of `/spec-plan $ARGUMENTS`

### Task 3: Fix broken references in OpenCode command/skill files
- [x] `spec-plan` (now skill): line 70 — "launch plan-reviewer sub-agent" → use task tool or `@plan-reviewer` mention
- [x] `spec-verify` (now skill): lines 14, 52 — "Launch spec-reviewer sub-agent" → same
- [x] `spec-implement` (now skill): lines 22, 66 — `TaskCreate`/`TaskUpdate` → `todowrite`
- [x] `sync.md`: lines 11, 17 — `.claude/rules/` → `.opencode/rules/`
- [x] `learn.md`: lines 38-39 — `.claude/skills/` → `.opencode/skills/`
- **Files:** modify skills and commands under `targets/opencode/`
- **DoD:** No references to Claude Code-specific tools (`TaskCreate`, `TaskUpdate`, `Skill()`) or paths (`.claude/`) remain in OpenCode files

### Task 4: Fix broken references in Claude Code command files
- [x] `spec-implement.md`: lines 22, 66 — `TaskCreate`/`TaskUpdate` → `TodoWrite`
- [x] `spec-plan.md`: line 70 — "launch plan-reviewer sub-agent" → `Task(plan-reviewer:...)`
- [x] `spec-verify.md`: lines 14, 52 — "Launch spec-reviewer sub-agent" → `Task(spec-reviewer:...)`
- **Files:** modify `targets/claude-code/commands/spec-implement.md`, `targets/claude-code/commands/spec-plan.md`, `targets/claude-code/commands/spec-verify.md`
- **DoD:** Claude Code commands use correct Claude Code tool names (`TodoWrite`, `Task()`)

### Task 5: Update opencode.json config template
- [x] Add `permission.task` section allowing sentinal agents
- [x] Add `permission.skill` section allowing sentinal skills
- [x] Add `permission.edit` granular rules allowing writes to `docs/plans/*.md` and plan-related paths
- **Files:** modify `targets/opencode/opencode.json`
- **DoD:** Config template includes task/skill permissions and plan-file write permissions. Users can run `/spec` in plan mode and still create/update plan files

### Task 6: Add post-spec completion audit
- [x] Add `SpecStore.auditCompletion(specId)` method that cross-checks `.md` checkboxes vs SQLite task states
- [x] If `.md` has `[x]` but SQLite has `pending`/`in-progress` → update SQLite to `complete`
- [x] If SQLite has `complete` but `.md` has `[ ]` → update the `.md` checkbox to `[x]` and rewrite the file
- [x] Update both `spec.md` dispatchers (Claude Code and OpenCode) to run the audit when status is `VERIFIED`
- [x] Add unit tests for `auditCompletion()` covering: all-in-sync, md-ahead-of-sqlite, sqlite-ahead-of-md, mixed states
- **Files:** modify `src/spec/store.ts`, create or modify test in `src/spec/store.test.ts`, modify `targets/*/commands/spec.md`
- **DoD:** When `/spec` reaches VERIFIED, it reports any discrepancies found and fixed. Both `.md` file and SQLite are in sync. Tests cover all audit scenarios

### Task 7: Update installer and embedded assets
- [x] Update `scripts/embed-assets.mjs` to read `targets/opencode/agents/*.md` and `targets/opencode/skills/*/SKILL.md`
- [x] Add `EMBEDDED_OC_AGENTS` and `EMBEDDED_OC_SKILLS` exports to `embedded-assets.ts`
- [x] Update `installOpenCode()` in `install.ts` to create `agents/` and `skills/` directories and write agent + skill files (both npm and binary mode)
- [x] Regenerate `embedded-assets.ts`
- **Files:** modify `scripts/embed-assets.mjs`, `src/cli/embedded-assets.ts` (auto-generated), `src/cli/commands/install.ts`
- **DoD:** `sentinal install opencode` deploys agent definitions and skill files. Binary mode extracts from embedded constants. Skill directories follow OpenCode's `skills/<name>/SKILL.md` convention

### Task 8: Update uninstaller to revert new artifacts
- [x] Add `AGENT_FILES` constant listing agent filenames (`plan-reviewer.md`, `spec-reviewer.md`)
- [x] Add `SKILL_DIRS` constant listing skill directory names (`spec-plan`, `spec-implement`, `spec-verify`, `spec-bugfix-plan`, `spec-bugfix-verify`)
- [x] In `uninstallOpenCode()`: remove agent files from `agents/` directory, clean up empty `agents/` dir
- [x] In `uninstallOpenCode()`: remove skill directories (each `skills/<name>/` recursively), clean up empty `skills/` dir
- [x] In `uninstallOpenCode()`: remove sentinal-specific `permission.task`, `permission.skill`, and `permission.edit` entries from opencode config
- [x] Update detection logic: check for agent/skill files as additional install indicators (in auto-detect mode)
- [x] Claude Code: no changes needed — `removeDirIfExists(MARKETPLACE_DIR)` already removes the entire plugin dir recursively including agents, commands, rules, hooks
- **Files:** modify `src/cli/commands/uninstall.ts`
- **DoD:** `sentinal uninstall opencode` removes all agents, skills, permissions, commands, rules, plugin files, MCP entries, and config entries. Empty directories are cleaned up. No sentinal artifacts remain after uninstall

### Task 9: Type check, test, and verify
- [x] `npx tsc --noEmit` — 0 errors
- [x] `bun test` — all tests pass (676 pass, 0 fail)
- [x] `bun build --compile` — binary compiles successfully
- [ ] Manually verify: `sentinal install opencode --bundled` creates agents/ and skills/ directories with correct content
- **Files:** (verification only)
- **DoD:** All checks pass. Embedded assets include new exports. Binary compiles and runs

## Risks

1. **OpenCode skill discovery** — Skills must follow exact naming: `skills/<name>/SKILL.md` (case-sensitive). If the directory structure is wrong, skills won't be discovered. Mitigation: verify with `opencode` after install.

2. **Dispatcher routing change** — Changing `spec.md` from `/spec-plan $ARGUMENTS` to skill invocation syntax changes how the LLM interprets the instruction. If the LLM doesn't reliably call the `skill` tool, the workflow breaks. Mitigation: test with a real OpenCode session. Fallback: keep commands alongside skills as a safety net during rollout.

3. **Agent frontmatter compatibility** — The agent markdown format may evolve in newer OpenCode versions. The current format (`description`, `mode`, `tools`, `permission`) is documented as of the current version. Mitigation: minimal frontmatter, avoid undocumented fields.

4. **Embedded assets file size** — Adding agents and skills increases `embedded-assets.ts`. Current: 3499 lines. Expected increase: ~200-300 lines (agents are short, skills are the existing command content moved). Well within acceptable bounds.

5. **Audit `.md` rewriting** — The audit step rewrites the plan `.md` file to fix unchecked boxes. Must preserve all other content (frontmatter, prose, formatting). Mitigation: use a targeted regex replacement (`- [ ]` → `- [x]`) keyed by task title, not a full file rewrite. Test with varied plan formats.

6. **Plan-mode permissions** — Granular `permission.edit` rules in `opencode.json` allow writes to `docs/plans/*.md`. If the user's project stores plans elsewhere, this won't help. Mitigation: document the convention and make the path pattern configurable in future.

## Goal Verification

1. `sentinal install opencode` (npm mode) creates:
   - `~/.config/opencode/agents/plan-reviewer.md`
   - `~/.config/opencode/agents/spec-reviewer.md`
   - `~/.config/opencode/skills/spec-plan/SKILL.md`
   - `~/.config/opencode/skills/spec-implement/SKILL.md`
   - `~/.config/opencode/skills/spec-verify/SKILL.md`
   - `~/.config/opencode/skills/spec-bugfix-plan/SKILL.md`
   - `~/.config/opencode/skills/spec-bugfix-verify/SKILL.md`
   - Updated `opencode.json` with `permission` sections (task, skill, edit for plan files)
2. `sentinal install opencode --bundled` (binary mode) creates the same files from embedded assets
3. No `.claude/` path references remain in any OpenCode file
4. No `TaskCreate`/`TaskUpdate` references remain in any file (either target)
5. Claude Code commands use correct `TodoWrite` and `Task()` syntax
6. Post-spec audit: when spec reaches VERIFIED, `.md` checkboxes and SQLite task states are cross-checked and synchronized. `auditCompletion()` unit tests pass for all scenarios
7. Plan-mode writes: `opencode.json` permissions allow creating/editing `docs/plans/*.md` files from plan mode
8. Uninstaller: `sentinal uninstall opencode` removes all agents from `agents/`, all skills from `skills/`, all permission entries from config, in addition to existing commands/rules/plugin/MCP cleanup. No sentinal artifacts remain
9. All tests pass, TypeScript compiles, binary builds
