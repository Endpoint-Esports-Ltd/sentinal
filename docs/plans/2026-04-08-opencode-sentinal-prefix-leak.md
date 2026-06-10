# OpenCode `sentinal:` Prefix Leak Fix Plan

Created: 2026-04-08
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: Yes (squash-merged + cleaned up)
Type: Bugfix

## Summary

**Symptom:** OpenCode rule and skill files reference custom sub-agents with the `sentinal:` namespace prefix (`Task(subagent_type="sentinal:plan-reviewer")`, `Task(subagent_type="sentinal:spec-reviewer")`). The `sentinal:` prefix is a Claude Code plugin-marketplace namespace convention and is meaningless under OpenCode, which resolves sub-agents by the bare filename of files in `targets/opencode/agents/`.

**Trigger:** Any `/spec` invocation under OpenCode that reaches the plan-reviewer step (spec-plan Step 1.7) or spec-reviewer step (spec-verify Steps 3.1, 3.4). When the skill follows its own instructions, `Task(subagent_type="sentinal:plan-reviewer")` fails because no agent with that literal name exists. The review step is silently skipped, defeating the review pipeline for OpenCode users.

**Root Cause:** 5 locations across 3 OpenCode files use `sentinal:plan-reviewer` / `sentinal:spec-reviewer` where bare `plan-reviewer` / `spec-reviewer` is correct:

1. `targets/opencode/rules/task-and-workflow.md:67` — ``| `sentinal:plan-reviewer` |`` in the subagent_type column of the reviewers table
2. `targets/opencode/rules/task-and-workflow.md:68` — ``| `sentinal:spec-reviewer` |`` in the same table
3. `targets/opencode/skills/spec-plan/SKILL.md:358` — `subagent_type="sentinal:plan-reviewer",` in the Step 1.7 Task() launch snippet
4. `targets/opencode/skills/spec-verify/SKILL.md:17` — `Task(subagent_type="sentinal:spec-reviewer")` in the KEY CONSTRAINTS section
5. `targets/opencode/skills/spec-verify/SKILL.md:100` — `subagent_type="sentinal:spec-reviewer",` in the Step 3.1 Task() launch snippet

All 5 occurrences were introduced in commit `999cc5f` (2026-03-11) via mass mirroring of Claude Code text into OpenCode files without scrubbing the plugin-namespace prefix.

## Investigation

- **Architectural context:** Claude Code installs Sentinal as a plugin via `claude plugin install sentinal@sentinal-marketplace`, and its plugin system automatically namespaces everything the plugin supplies as `sentinal:<name>` — hence `sentinal:plan-reviewer`, `/sentinal:spec`, `sentinal:spec-implement` etc. are correct under Claude Code. OpenCode installs the plugin as a flat set of files in `~/.config/opencode/{agents,skills,commands,rules,plugins}/` with no namespacing; the filename (e.g., `plan-reviewer.md`) is the identifier.
- **Prior bugfix parallel:** `docs/plans/2026-04-03-skill-routing-bugfix.md` (VERIFIED) fixed the exact inverse of this bug — `Skill()` calls in `targets/claude-code/commands/*.md` were using bare names and needed the `sentinal:` prefix added. That plan's own Investigation section explicitly states _"OpenCode NOT affected: OpenCode skills use directory-based names ... bare names are correct for OpenCode"_ — confirming the architectural split, but that prior fix did not audit the inverse direction (prefix present where it shouldn't be).
- **Git blame:** All 5 strings (`sentinal:plan-reviewer`, `sentinal:spec-reviewer` across the 3 OpenCode files) first appeared in `999cc5f` (2026-03-11). The commit description mentions "Mirror all changes to OpenCode targets" — this is precisely the mirroring step that leaked the Claude-specific prefix.
- **Working example in OpenCode tree:** `targets/opencode/skills/spec-implement/SKILL.md:18,136` uses `Task(subagent_type="general")` — bare name, no prefix. This is the pattern `plan-reviewer` / `spec-reviewer` invocations should follow, since they're registered in `targets/opencode/agents/` with no `name:` field in frontmatter (filename is the identifier).
- **OpenCode agent file inspection:** `targets/opencode/agents/plan-reviewer.md` and `spec-reviewer.md` have YAML frontmatter with `description`, `mode: subagent`, `tools`, and `permission` fields — but **no `name:` field**. OpenCode's convention is that the filename (minus `.md`) is the agent identifier.
- **Parity with Claude Code:** There are 5 symmetric occurrences in Claude Code files (`targets/claude-code/commands/spec-plan.md:361`, `spec-verify.md:19,102`, `rules/task-and-workflow.md:67-68`) that **must stay unchanged** — Claude Code correctly needs the prefix.
- **Scope confirmation:** Outside `targets/opencode/`, other `sentinal:` references are legitimate (install.ts:432 prints user-facing Claude Code slash-command names, install.ts:738 is a JSON key for an MCP server entry, README.md:122 is a Claude Code quick-start instruction, embedded-assets.ts contains verbatim-mirrored content from both targets). Fixing the 3 source files in `targets/opencode/` automatically fixes `embedded-assets.ts` via `bun run embed-assets`.

## Behavior Contract

### Fix Property (C ⇒ P)

**When condition C holds:** A user runs `/spec <task>` under OpenCode with `$SENTINAL_PLAN_REVIEWER_ENABLED` or `$SENTINAL_SPEC_REVIEWER_ENABLED` not set to `"false"` (i.e., review is enabled).
**Property P must hold:**

1. The rule file `targets/opencode/rules/task-and-workflow.md` has a `subagent_type` column showing bare `` `plan-reviewer` `` and `` `spec-reviewer` `` (no `sentinal:` prefix) for the two reviewer rows.
2. The skill files `targets/opencode/skills/spec-plan/SKILL.md` and `targets/opencode/skills/spec-verify/SKILL.md` contain `Task(subagent_type="plan-reviewer")` / `Task(subagent_type="spec-reviewer")` — bare names, no prefix.
3. A structural regression test (`src/cli/target-assets.test.ts`) scans every `.md` file under `targets/opencode/` and asserts that NONE contain the strings `sentinal:plan-reviewer` or `sentinal:spec-reviewer`.
4. `src/cli/embedded-assets.ts` (regenerated via `bun run embed-assets`) reflects the updated OpenCode content.

### Preservation Property (¬C ⇒ unchanged)

**When condition C does NOT hold** (Claude Code side, or non-reviewer `sentinal:` usages):

1. **All 5 Claude Code occurrences** of `sentinal:plan-reviewer` / `sentinal:spec-reviewer` in `targets/claude-code/` remain unchanged — Claude Code requires the prefix.
2. **All other legitimate `sentinal:` uses** stay unchanged:
   - `src/cli/commands/install.ts:432` — user-facing Claude Code slash command names (`/sentinal:spec, /sentinal:sync, /sentinal:learn`)
   - `src/cli/commands/install.ts:738` — JSON key for the `sentinal` MCP server entry
   - `README.md:122` — Claude Code quick-start instructions
   - Any `"Bash(sentinal:*)"` permission patterns in embedded configs
   - Any `Skill(skill='sentinal:<name>')` calls in `targets/claude-code/commands/*.md` (these were correctly added by the 2026-04-03 bugfix)
3. The `targets/opencode/agents/plan-reviewer.md` and `spec-reviewer.md` agent files themselves are not modified — their filenames already are the correct identifiers.
4. All existing unit tests continue to pass (1137+ passing baseline from the previous session).

## Fix Approach

**Files to modify:**

| File                                           | Change                                                                                                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `targets/opencode/rules/task-and-workflow.md`  | Lines 67-68: `` `sentinal:plan-reviewer` `` → `` `plan-reviewer` ``, `` `sentinal:spec-reviewer` `` → `` `spec-reviewer` ``                         |
| `targets/opencode/skills/spec-plan/SKILL.md`   | Line 358: `subagent_type="sentinal:plan-reviewer"` → `subagent_type="plan-reviewer"`                                                                |
| `targets/opencode/skills/spec-verify/SKILL.md` | Lines 17, 100: `sentinal:spec-reviewer` → `spec-reviewer` (both occurrences)                                                                        |
| `src/cli/target-assets.test.ts` (new)          | Structural regression test — reads every `.md` under `targets/opencode/` and asserts `sentinal:plan-reviewer` / `sentinal:spec-reviewer` are absent |
| `src/cli/embedded-assets.ts`                   | **Auto-regenerated** via `bun run embed-assets` — not hand-edited                                                                                   |

**Strategy:**

1. **TDD regression test first:** Create `src/cli/target-assets.test.ts` with 2 tests:
   - Test 1: Walk every `.md` file under `targets/opencode/` and assert none contain `sentinal:plan-reviewer`. Test 2: same for `sentinal:spec-reviewer`. Both tests should **initially FAIL** (RED) because the 5 leaked occurrences still exist.
   - Run `bun test src/cli/target-assets.test.ts` — verify the 2 tests FAIL, noting the exact files where they found the prefix.
2. **Set TDD guard state to RED_CONFIRMED** for the 3 OpenCode files being edited.
3. **Fix the 3 OpenCode files:** Make the 5 string replacements (one per occurrence). Verbatim replacements — no surrounding text changes.
4. **Run the regression tests** — they should now PASS (GREEN). No OpenCode file contains the buggy strings.
5. **Set TDD state to GREEN_CONFIRMED.**
6. **Verify Claude Code is unchanged** — run `rg 'sentinal:(plan|spec)-reviewer' targets/claude-code/` and confirm all 5 Claude Code occurrences still exist.
7. **Regenerate embedded-assets.ts** via `bun run embed-assets`. The count of `sentinal:plan-reviewer` / `sentinal:spec-reviewer` in `embedded-assets.ts` should drop by 5 (from 10 to 5 — only the Claude Code half remains).

**Tests (TDD):**

- **`src/cli/target-assets.test.ts`** (new) — 2 RED tests:
  1. `"targets/opencode/**/*.md does not contain sentinal:plan-reviewer"` — walks `targets/opencode/` recursively, filters `.md` files, asserts `!content.includes("sentinal:plan-reviewer")` for each. On failure, reports the file path.
  2. `"targets/opencode/**/*.md does not contain sentinal:spec-reviewer"` — same pattern for the other prefix.
  3. **Optional third test:** `"targets/claude-code/**/*.md still contains sentinal:plan-reviewer"` — a preservation assertion that prevents the opposite drift in future mirrors (failing if a future refactor accidentally strips the prefix from Claude Code, which is the inverse of this bug).

The tests have no mocking — they read the real asset files from disk. Pattern is deliberately simple because the test is a structural invariant, not a unit test.

**Defense-in-depth:** The structural test IS the defense layer. Without it, a future mass mirror from Claude Code into OpenCode files would silently reintroduce the leak. The test adds ~30 lines of scanner code and catches the whole class of bug automatically.

## Progress

- [x] Task 1: Fix (regression test + string replacements + embed regen)
- [x] Task 2: Verify

**Tasks:** 2 | **Done:** 2 | **Left:** 0

## Verification Results

- **Full test suite:** 1142/1142 passing (1137 baseline + 5 new target-assets tests)
- **Type check:** `tsc --noEmit` — 0 errors
- **OpenCode side clean:** `rg 'sentinal:(plan|spec)-reviewer' targets/opencode/` returns 0 matches
- **Claude Code parity preserved:** All 5 symmetric occurrences still present (spec-plan.md:361, spec-verify.md:19,102, task-and-workflow.md:67,68)
- **embedded-assets.ts:** Count dropped from 10 → 5 (exactly the 5 OpenCode occurrences removed)
- **Impact analysis:** LOW risk, 0 unexpected changes
- **Regression guard:** New structural test `src/cli/target-assets.test.ts` will catch any future mass-mirror drift at CI time

## Tasks

### Task 1: Fix

**Objective:** Write RED regression test, apply 5 string replacements in 3 OpenCode files, run GREEN, regenerate embedded-assets, confirm Claude Code parity untouched.

**Files:**

- `src/cli/target-assets.test.ts` (new, regression guard)
- `targets/opencode/rules/task-and-workflow.md`
- `targets/opencode/skills/spec-plan/SKILL.md`
- `targets/opencode/skills/spec-verify/SKILL.md`
- `src/cli/embedded-assets.ts` (regenerated, not hand-edited)

**TDD:**

1. Create `src/cli/target-assets.test.ts` with the 2 (or 3) regression tests walking `targets/opencode/` recursively. Do NOT edit any other file yet.
2. Run `bun test src/cli/target-assets.test.ts` — confirm 2 tests FAIL (RED). Capture the failing output to confirm each test correctly reports the offending files.
3. Set TDD state RED_CONFIRMED for all 3 OpenCode files being edited.
4. Apply the 5 string replacements:
   - `targets/opencode/rules/task-and-workflow.md` line 67: `` `sentinal:plan-reviewer` `` → `` `plan-reviewer` ``
   - `targets/opencode/rules/task-and-workflow.md` line 68: `` `sentinal:spec-reviewer` `` → `` `spec-reviewer` ``
   - `targets/opencode/skills/spec-plan/SKILL.md` line 358: `subagent_type="sentinal:plan-reviewer"` → `subagent_type="plan-reviewer"`
   - `targets/opencode/skills/spec-verify/SKILL.md` line 17: `"sentinal:spec-reviewer"` → `"spec-reviewer"`
   - `targets/opencode/skills/spec-verify/SKILL.md` line 100: `subagent_type="sentinal:spec-reviewer"` → `subagent_type="spec-reviewer"`
5. Run `bun test src/cli/target-assets.test.ts` — confirm tests PASS (GREEN).
6. Set TDD state GREEN_CONFIRMED.
7. Verify Claude Code parity: `rg -c 'sentinal:(plan|spec)-reviewer' targets/claude-code/` should return 5 (unchanged).
8. Run `bun run embed-assets` to regenerate `src/cli/embedded-assets.ts`.
9. Verify the count drop: `rg -c 'sentinal:(plan|spec)-reviewer' src/cli/embedded-assets.ts` should show 5 matches (Claude Code half only), down from 10.

**Verify:**

```bash
bun test src/cli/target-assets.test.ts --verbose
rg -n 'sentinal:(plan|spec)-reviewer' targets/opencode/    # must be empty
rg -c 'sentinal:(plan|spec)-reviewer' targets/claude-code/ # must be 5
rg -c 'sentinal:(plan|spec)-reviewer' src/cli/embedded-assets.ts  # must be ~5
bunx tsc --noEmit
```

### Task 2: Verify

**Objective:** Full test suite, type check, impact analysis, rule integrity spot-check.

**Verify:**

```bash
# Full test suite — no regressions in the 1137+ baseline
bun test

# Type check — the new test file uses node:fs APIs
bunx tsc --noEmit

# Impact analysis — confirm changes match plan scope
# (use sentinal_impact_analysis MCP tool)

# Rule integrity: every Claude Code file still has correct `sentinal:` reviewer references
rg -c 'sentinal:plan-reviewer' targets/claude-code/rules/task-and-workflow.md  # must be 1
rg -c 'sentinal:spec-reviewer' targets/claude-code/rules/task-and-workflow.md  # must be 1
rg -c 'sentinal:plan-reviewer' targets/claude-code/commands/spec-plan.md       # must be 1
rg -c 'sentinal:spec-reviewer' targets/claude-code/commands/spec-verify.md     # must be 2

# Embed regeneration is idempotent (run twice, expect no second diff beyond timestamp)
bun run embed-assets
git diff --stat src/cli/embedded-assets.ts  # content diff already applied, only timestamp should drift
```
