# spec-master-plan/execute Broken on OpenCode (missing `name:` frontmatter) Fix Plan

Created: 2026-07-18
Status: VERIFIED
Approved: Yes
Iterations: 1
Worktree: No
Type: Bugfix

## Summary

**Symptom:** The `/spec` master workflow does not work on OpenCode. When the `/spec` dispatcher routes a multi-phase project and calls `Skill(skill='spec-master-plan')` (or `spec-master-execute`), OpenCode reports the skill is not found / it silently never runs. Feature and bugfix flows work fine.

**Trigger:** Any `/spec` invocation classified as **Master** (multi-phase project) on OpenCode.

**Root Cause:** `targets/opencode/skills/spec-master-plan/SKILL.md:1-4` and `targets/opencode/skills/spec-master-execute/SKILL.md:1-3` are **missing the required `name:` frontmatter field**. Their frontmatter is `description:` + `argument-hint:` only — the latter copied from the Claude Code command template. OpenCode's skill schema requires `name` (lowercase, hyphen-separated, must match the folder name); skills failing validation are filtered out and never presented to the model, so `Skill(skill='spec-master-plan')` cannot resolve.

## Investigation

- **OpenCode skill schema is authoritative on this:** `@opencode-ai/sdk` v2 `types.gen.d.ts` `AppSkillsResponses` = `Array<{ name: string; description: string; location: string; content: string }>`. Official docs (`/anomalyco/opencode` skills.mdx): only `name`, `description`, `license`, `compatibility`, `metadata` recognized; `name` **required**, "must be lowercase, hyphen-separated, up to 64 chars, and match the skill's folder name"; **unknown fields ignored**; "skills without a [valid] description are filtered out and not presented to the model."
- **`argument-hint` has no function in an OpenCode skill and must be dropped.** OpenCode's `SkillTool.Parameters` = `Schema.Struct({ name })` — the Skill tool accepts ONLY a skill name; there is no argument-passing mechanism for skills at all. Args like `--worktree=yes` are threaded through the `/spec` **command** (which supports `$ARGUMENTS`/`$1`) into the prompt text, and the skill body reads them from context. `argument-hint` is a valid **command** field (used correctly in `targets/opencode/commands/spec.md`, `quick.md`) but is ignored on skills. No working OpenCode skill uses it.
- **Contrast (working skills):** all 5 functioning spec skills declare `name:` matching their folder — `spec-plan`, `spec-bugfix-plan`, `spec-implement`, `spec-verify`, `spec-bugfix-verify`. Only the 2 master skills lack `name:`.
- **Installed copies are broken too:** `~/.config/opencode/skills/spec-master-{plan,execute}/SKILL.md` also lack `name:` — real users are affected, not just the repo. **Delivery path (verified):** `sentinal install` writes skills from `EMBEDDED_OC_SKILLS` in `src/cli/embedded-assets.ts` (NOT from the live `targets/` tree). Therefore the fix only reaches users after `bun run embed-assets` regenerates `embedded-assets.ts` from `targets/`. `deploy:opencode` does NOT help — it only copies the plugin bundle `sentinal.mjs` to `~/.config/opencode/plugins/` and never touches `~/.config/opencode/skills/` (package.json:37). This missing embed step is exactly how the original bug reached users.
- **Introduced in commit `a21f4ad`** ("add IN_PROGRESS status lifecycle and master plans with wave execution") — the master feature was shipped by copying Claude Code command frontmatter into OpenCode skill files without adapting to the skill schema.
- **Claude Code impact (secondary, minor — NOT a hard failure):** CC master phases are **commands** (`targets/claude-code/commands/spec-master-{plan,execute}.md`), not skills. Their frontmatter (`description`/`argument-hint`/`model`/`effort`) is valid for CC's command system, so master resolves. But `spec-master-plan.md`/`spec-master-execute.md` are **missing `user-invocable: false`** that the working `spec-plan.md` has (`targets/claude-code/commands/spec-plan.md:4`) — so on CC the master phases may leak as user-typable slash commands instead of being dispatcher-only. Fix for parity/hygiene.

## Behavior Contract

### Fix Property (C => P)

**When condition C holds:** OpenCode enumerates installed skills / the model calls `Skill(skill='spec-master-plan')` or `Skill(skill='spec-master-execute')`.
**Property P must hold:** Both skills are present in the validated skill set with `name` equal to their folder name (`spec-master-plan`, `spec-master-execute`) and a non-empty `description`; the Skill invocation resolves and loads the skill body.

### Preservation Property (!C => unchanged)

**When condition C does NOT hold:** Feature/bugfix `/spec` flows and all 5 already-working spec skills.
**Existing behavior preserved:** Every existing OpenCode skill keeps a `name:` matching its folder; the `/spec` command files (`spec.md`, `quick.md`) keep their valid `argument-hint:`; Claude Code command behavior is unchanged except the added `user-invocable: false` on the two master commands.

## Fix Approach

**Files:**

- `targets/opencode/skills/spec-master-plan/SKILL.md` — add `name: spec-master-plan`; remove the (ignored) `argument-hint:` line.
- `targets/opencode/skills/spec-master-execute/SKILL.md` — add `name: spec-master-execute`; remove the (ignored) `argument-hint:` line.
- `targets/claude-code/commands/spec-master-plan.md` — add `user-invocable: false` (parity with `spec-plan.md`).
- `targets/claude-code/commands/spec-master-execute.md` — add `user-invocable: false` (parity).
- `src/cli/target-assets.test.ts` — add regression test (see below).

**Strategy:** Frontmatter-only edit. Match the exact shape of a known-good skill:

```yaml
---
name: spec-master-plan
description: Master plan creation - multi-phase project with waves and parallel execution
---
```

(Drop `argument-hint` — it is unused/ignored on OpenCode skills, and keeping it invites the same copy-paste confusion that caused this bug.)

**Tests:** Extend `src/cli/target-assets.test.ts` (the existing home for target-asset structural invariants; reuse its `walkMarkdown` helper). Add a `describe` block that walks every `targets/opencode/skills/*/SKILL.md` and asserts: (1) frontmatter has a non-empty `name:`, (2) `name` equals the parent folder name, (3) no skill declares `argument-hint:` (skill-invalid field). Add a preservation assertion that `targets/opencode/commands/spec.md` still declares `argument-hint:` (valid on commands). Additionally, assert the **embedded** copy is in sync — `EMBEDDED_OC_SKILLS` (from `embedded-assets.ts`) contains `name: spec-master-plan` and `name: spec-master-execute` — since that embedded copy is the actual delivery path to users. This test FAILS before the fix (master skills missing `name`, present `argument-hint`) and PASSES after (once `embed-assets` is run).

**Embed & delivery (MANDATORY — post-edit, before verify):** After editing `targets/`, run `bun run embed-assets` to regenerate `src/cli/embedded-assets.ts` (this is what `sentinal install` ships from — see Investigation). Without this step the shipped/installed copy stays broken even after merge. No plugin runtime change, so the bundled behavior is unaffected; the change is purely the embedded skill/command assets. Existing users pick up the fix on their next `sentinal install`/update.

**Defense-in-depth:** The regression test IS the defense — it structurally guards every OpenCode skill's frontmatter (both source AND embedded copy) so any future copy-paste from a command template (or a new skill added without `name`, or a forgotten `embed-assets`) fails CI immediately.

## Progress

- [x] Task 1: Fix frontmatter + regression test
- [x] Task 2: Verify
      **Tasks:** 2 | **Done:** 2 | **Left:** 0

## Tasks

### Task 1: Fix

**Objective:** Write the regression test → confirm it FAILS → fix the frontmatter on both OpenCode master skills (add `name`, drop `argument-hint`) → add `user-invocable: false` to both CC master commands → run `embed-assets` → confirm all tests PASS.
**Files:** `src/cli/target-assets.test.ts`, `targets/opencode/skills/spec-master-plan/SKILL.md`, `targets/opencode/skills/spec-master-execute/SKILL.md`, `targets/claude-code/commands/spec-master-plan.md`, `targets/claude-code/commands/spec-master-execute.md` (+ regenerated `src/cli/embedded-assets.ts`)
**TDD:**
1. Add the OpenCode-skill frontmatter validation `describe` to `target-assets.test.ts` (source-tree checks + embedded-copy sync assertion on `EMBEDDED_OC_SKILLS`).
2. Run `bun test src/cli/target-assets.test.ts` → verify it FAILS on the 2 master skills (missing `name` / has `argument-hint`) AND on the embedded-sync assertion.
3. Apply the 4 frontmatter edits.
4. Run `bun run embed-assets` to regenerate `embedded-assets.ts`.
5. Re-run `bun test src/cli/target-assets.test.ts` → verify all PASS.
**Should-fix (verify, no code):** Confirm the CC `/spec` dispatcher still routes `Skill(skill='sentinal:spec-master-plan')` after adding `user-invocable: false` (5 working precedents make this low-risk — just confirm no dispatcher assumption breaks).
**Verify:** `bun test src/cli/target-assets.test.ts --verbose`

### Task 2: Verify

**Objective:** Full suite + quality checks. (No plugin runtime change → no `deploy:opencode` needed; the delivery path is the embedded assets regenerated in Task 1.)
**Verify:** `bun test && npx tsc --noEmit`
