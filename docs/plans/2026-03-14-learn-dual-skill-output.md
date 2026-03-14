# /learn and /sync Dual-Write Skills to Both Platforms Fix Plan

Created: 2026-03-14
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Bugfix

## Summary
**Symptom:** `/learn` and `/sync` commands only generate skills to `.claude/skills/`, regardless of which assistant is running. OpenCode discovers skills from `.opencode/skills/` — so skills created by OpenCode users are invisible to OpenCode, and skills created by Claude Code users are invisible to OpenCode teammates.
**Trigger:** Any `/learn` or `/sync` invocation that creates or updates skills.
**Root Cause:** All command files hardcode `.claude/skills/` as the sole output path. The OpenCode migration copied Claude Code's commands verbatim without updating paths, and the design never included dual-write.

## Investigation
- `targets/opencode/commands/learn.md` — 6 references to `.claude/skills/` (lines 44, 64, 141-142, 155, 201)
- `targets/opencode/commands/sync.md` — 6 references to `.claude/skills/` (lines 34, 40, 158, 178, 245, 495)
- `targets/claude-code/commands/learn.md` — 6 references to `.claude/skills/` (lines 45, 65, 142-143, 156, 202)
- `targets/claude-code/commands/sync.md` — 6 references to `.claude/skills/` (lines 35, 40, 159, 179, 246, 496)
- `templates/commands/learn.md` — 2 references to `.claude/skills/` (lines 38, 39)
- OpenCode discovers skills from `.opencode/skills/{name}/SKILL.md` (project-local) or `~/.config/opencode/skills/{name}/SKILL.md` (global)
- Claude Code discovers skills from `.claude/skills/{name}/SKILL.md`
- The SKILL.md file format is compatible between both — same YAML frontmatter (`name`, `description`) and markdown body
- Claude Code uses `{slug}-{name}` as the directory name; OpenCode uses just `{name}` — but both formats work since the directory name is not parsed, only the frontmatter `name:` field matters

## Behavior Contract

### Fix Property (C => P)
**When condition C holds:** User runs `/learn` or `/sync` and a skill is created or updated.
**Property P must hold:** The skill file is written to BOTH `.claude/skills/{slug}-{name}/SKILL.md` AND `.opencode/skills/{slug}-{name}/SKILL.md` with identical content. Both Claude Code and OpenCode teammates can discover the skill.

### Preservation Property (!C => unchanged)
**When condition C does NOT hold:** No skills are being created/updated (e.g., `/learn` finds nothing extractable).
**Existing behavior preserved:** No skill files are created. Rules output (`.claude/rules/`) is unchanged.

## Fix Approach
**Files:**
- `targets/claude-code/commands/learn.md`
- `targets/claude-code/commands/sync.md`
- `targets/opencode/commands/learn.md`
- `targets/opencode/commands/sync.md`
- `templates/commands/learn.md`

**Strategy:** In all five files, update skill output instructions to write to BOTH paths simultaneously:
1. Add a "Dual-Write Skills" section to Phase 0 / Reference explaining that skills must be written to both `.claude/skills/{slug}-{name}/SKILL.md` and `.opencode/skills/{slug}-{name}/SKILL.md` with identical content.
2. Update all references to `.claude/skills/` to mention both paths. The primary instruction is "write to both", with the specific paths listed.
3. Update the `ls`/`grep` discovery commands (Phase 2 in learn, Phase 1 in sync) to check both directories.
4. Update the Phase 12 summary in sync and the example in learn to reference both paths.

**Tests:** No TypeScript tests — these are markdown prompt files. Verification is visual: grep for `.claude/skills/` to ensure all solo references are replaced with dual-write instructions.

## Progress
- [x] Task 1: Fix
- [x] Task 2: Verify
**Tasks:** 2 | **Done:** 2 | **Left:** 0

## Tasks

### Task 1: Fix
**Objective:** Update all five command files to dual-write skills
**Files:**
- Modify: `targets/claude-code/commands/learn.md`
- Modify: `targets/claude-code/commands/sync.md`
- Modify: `targets/opencode/commands/learn.md`
- Modify: `targets/opencode/commands/sync.md`
- Modify: `templates/commands/learn.md`
**TDD:** N/A (prompt files, not code). Verify by grepping that no solo `.claude/skills/` references remain that don't also mention `.opencode/skills/`.
**Verify:** `grep -n '\.claude/skills/' targets/*/commands/learn.md targets/*/commands/sync.md templates/commands/learn.md` — every match should be accompanied by a corresponding `.opencode/skills/` reference.

### Task 2: Verify
**Objective:** Build to embed updated assets + full test suite
**Verify:** `bun run build:cli && bun test && npx tsc --noEmit`
