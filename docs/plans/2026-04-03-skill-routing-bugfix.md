# Skill Routing & Worktree Question Bugfix Plan

Created: 2026-04-03
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Bugfix

## Summary

**Symptom:** `Skill(skill='spec-plan')` returns "Unknown skill: spec-plan" in Claude Code. Worktree question may not appear due to cascading failure. All skill chaining between spec phases is broken.

**Trigger:** Running `/spec` or any skill that chains to another (e.g., spec-plan → spec-implement → spec-verify). The Skill tool call fails immediately.

**Root Cause:** All `Skill(skill='...')` calls in `targets/claude-code/commands/*.md` use bare names (e.g., `spec-plan`) but Claude Code's plugin system namespaces skills as `sentinal:<skill-name>`. The Skill tool requires the fully-qualified name `sentinal:spec-plan`.

## Investigation

- **Confirmed:** System-reminder lists all skills with `sentinal:` prefix (e.g., `sentinal:spec-plan`, `sentinal:spec-implement`, etc.)
- **Confirmed:** Install output (install.ts:388) shows commands as `/sentinal:spec`, `/sentinal:sync`, `/sentinal:learn`
- **Confirmed:** Plugin installed via `claude plugin install sentinal@sentinal-marketplace` — the `sentinal` plugin name becomes the namespace prefix
- **Pattern comparison:** Agent sub-types correctly use the prefix: `subagent_type="sentinal:spec-reviewer"` (spec-verify.md:19,102). Only `Skill()` calls are missing it.
- **OpenCode NOT affected:** OpenCode skills use directory-based names (`skills/spec-plan/SKILL.md` with `name: spec-plan`) — bare names are correct for OpenCode. OpenCode's spec.md dispatcher uses "Load skill `spec-plan`" not `Skill()` tool.
- **Worktree question:** The spec.md instructions for the worktree question are correctly structured. The issue is a cascade — when Skill() fails, the workflow breaks. Fixing Skill() routing should fix the worktree flow.
- **Installed plugin stale:** Missing `effort: high` from commit e61ca4d — user needs `sentinal install claude` after fix.

## Behavior Contract

### Fix Property (C => P)

**When condition C holds:** Any Claude Code skill invokes `Skill(skill='<name>')` to chain to another skill
**Property P must hold:** The skill name resolves correctly and the target skill loads

### Preservation Property (!C => unchanged)

**When condition C does NOT hold:** OpenCode skill files, agent subagent_type references, non-Skill tool calls
**Existing behavior preserved:** OpenCode bare names unchanged, agent references already correct

## Fix Approach

**Files:** 9 Claude Code command .md files
**Strategy:** Replace all `Skill(skill='<bare-name>'` with `Skill(skill='sentinal:<bare-name>'` in Claude Code commands. Leave OpenCode skill files untouched (bare names are correct there).
**Tests:** Manual verification — run `/sentinal:spec` in Claude Code and confirm skill chaining works.

**Affected call sites (18 total):**

| File                                                  | Bare Names Used                                     |
| ----------------------------------------------------- | --------------------------------------------------- |
| `targets/claude-code/commands/spec.md`                | `spec-plan`, `spec-bugfix-plan`, `spec-master-plan` |
| `targets/claude-code/commands/spec-plan.md`           | `spec-implement` (×3)                               |
| `targets/claude-code/commands/spec-bugfix-plan.md`    | `spec-implement` (×3)                               |
| `targets/claude-code/commands/spec-implement.md`      | `spec-bugfix-verify`, `spec-verify`                 |
| `targets/claude-code/commands/spec-verify.md`         | `spec-implement` (×2)                               |
| `targets/claude-code/commands/spec-bugfix-verify.md`  | `spec-implement`                                    |
| `targets/claude-code/commands/spec-master-plan.md`    | `spec-master-execute` (×2)                          |
| `targets/claude-code/commands/spec-master-execute.md` | `spec-verify`                                       |
| `targets/claude-code/commands/sync.md`                | `learn`                                             |

## Progress

- [x] Task 1: Add `sentinal:` prefix to all Skill() calls in Claude Code commands
- [x] Task 2: Verify — reinstall plugin and test skill chaining

**Tasks:** 2 | **Done:** 2 | **Left:** 0

## Tasks

### Task 1: Fix — Add `sentinal:` prefix to all Skill() calls

**Objective:** Update all 18 `Skill(skill='<bare-name>')` references in Claude Code command files to use `Skill(skill='sentinal:<name>')`.
**Files:**

- `targets/claude-code/commands/spec.md`
- `targets/claude-code/commands/spec-plan.md`
- `targets/claude-code/commands/spec-bugfix-plan.md`
- `targets/claude-code/commands/spec-implement.md`
- `targets/claude-code/commands/spec-verify.md`
- `targets/claude-code/commands/spec-bugfix-verify.md`
- `targets/claude-code/commands/spec-master-plan.md`
- `targets/claude-code/commands/spec-master-execute.md`
- `targets/claude-code/commands/sync.md`

**TDD:** No automated tests for .md content. Manual verification: after reinstall, run `/sentinal:spec test task` and confirm it chains to `sentinal:spec-plan` successfully.
**Verify:** `grep -r "Skill(skill='" targets/claude-code/commands/ | grep -v sentinal:` should return 0 results.

### Task 2: Verify — Reinstall and test

**Objective:** Run `sentinal install claude` to deploy fixed files, then test skill chaining.
**Verify:** `bun run embed-assets && sentinal install claude` — then manually test `/sentinal:spec` in a new Claude Code session.
