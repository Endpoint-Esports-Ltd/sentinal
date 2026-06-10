# Market Research Feature Parity Implementation Plan

Created: 2026-03-11
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Summary

**Goal:** Achieve full feature parity according to market research across commands, rules, and agents — while adapting all references to Sentinal branding (Vexor for semantic search, `sentinal` as the CLI name).

**Architecture:** This is primarily a content upgrade — rewriting markdown command/rule/agent files to match the depth and structure identified by market research. The embed-assets script automatically picks up new files from `targets/claude-code/` directories, so no build system changes are needed. OpenCode targets need parallel updates (commands → commands, skills → skills).

**Tech Stack:** Markdown (commands, rules, agents), TypeScript (embed-assets verification), Bun (test runner)

## Scope

### In Scope

- Upgrade 8 Claude Code commands to full market research reference depth (~479 → ~2,000 lines)
- Add 11 new workflow/tool rules to `targets/claude-code/rules/` (~1,100 lines)
- Upgrade 2 agent definitions (plan-reviewer, spec-reviewer)
- Update 5 OpenCode skills and 3 OpenCode commands to match
- Update 2 OpenCode agents to match
- Verify embed-assets picks up all new files
- Verify install process deploys everything correctly
  - Adapt all references to Sentinal branding: `sentinal` CLI, `Vexor` for semantic search, `~/.sentinal/` paths

### Out of Scope

- New TypeScript hook implementations (existing hooks are already at parity)
- Team sharing features (not part of Sentinal)
- License management (not part of Sentinal)
- Dashboard changes (existing dashboard is already functional)
- Changes to existing coding standard rules (standards-angular/backend/frontend/nestjs/typescript are fine)

## Context for Implementer

> Write for an implementer who has never seen the codebase.

- **Patterns to follow:** Compare the market-research reference version of `spec-plan.md` (~375 lines) with `targets/claude-code/commands/spec-plan.md` (Sentinal's current version, 76 lines). The full version has env var toggle reading, AskUserQuestion integration, detailed plan templates with pre-mortem and goal verification sections.

- **Conventions:**
  - Claude Code commands go in `targets/claude-code/commands/*.md` with YAML frontmatter
  - Claude Code rules go in `targets/claude-code/rules/*.md` with optional `globs` frontmatter for conditional loading
  - OpenCode commands go in `targets/opencode/commands/*.md`
  - OpenCode skills go in `targets/opencode/skills/<name>/SKILL.md`
  - Templates go in `templates/commands/*.md` and `templates/rules/*.md`

- **Key files:**
  - `scripts/embed-assets.mjs` — Auto-reads all `*.md` from targets dirs, generates `src/cli/embedded-assets.ts`
  - `src/cli/commands/install.ts` — Deploys embedded assets or copies from targets/ into Claude Code plugin directory
  - `targets/claude-code/hooks/hooks.json` — Hook wiring configuration
  - `targets/claude-code/settings.json` — Claude Code settings (permissions, env vars)

- **Gotchas:**
  - The `embed-assets.mjs` script must be re-run after adding new files (`bun run embed-assets`)
  - Template files use `{{variable}}` syntax that gets replaced by `scripts/generate-commands.js`
  - Rules with `globs` frontmatter only load when matching files are open (used for coding standards)
  - OpenCode skills use a different structure than Claude Code commands (subdirectories with SKILL.md)

- **Domain context:**
  - Sentinal uses `sentinal` CLI binary
  - Sentinal uses `Vexor` for semantic code search
  - Sentinal stores data in `~/.sentinal/`
  - Sentinal's MCP tools use prefix `mcp__plugin_sentinal_`
  - Env vars like `$SENTINAL_WORKTREE_ENABLED` control feature toggles

## Assumptions

- Embed-assets script auto-discovers new files in targets directories — supported by reading `scripts/embed-assets.mjs:28-34` — All tasks depend on this
- Existing hooks are at functional parity with the market research reference — supported by comparing hooks.json configurations — Tasks 1-9 depend on this
- OpenCode skills follow the same content structure as Claude Code commands — supported by comparing existing files — Tasks 7-8 depend on this
- Rules without `globs` frontmatter load every session — supported by Claude Code plugin docs — Task 1-2 depend on this

## Testing Strategy

- **Unit:** Verify embed-assets generates correct output with new files
- **Integration:** Run `sentinal install claude` (dry-run or test environment) and verify all files deploy
- **Manual:** Run `bun run embed-assets` and verify the generated `embedded-assets.ts` includes all new rules/commands
- **E2E:** Start a Claude Code session with the updated plugin and verify rules/commands load

## Risks and Mitigations

| Risk                                                 | Likelihood | Impact | Mitigation                                                           |
| ---------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------- |
| Rules too large for context window                   | Low        | Medium | Keep rules concise; use conditional loading (`globs`) where possible |
| Command depth causes slower skill loading            | Low        | Low    | Claude Code loads commands on-demand; only the invoked command loads |
| Branding inconsistencies (missed legacy references) | Medium     | Low    | Grep for legacy tool names after all changes                       |
| OpenCode skills diverge from Claude Code commands    | Medium     | Medium | Update both targets in the same task                                 |

## Pre-Mortem

_Assume this plan failed. Most likely internal reasons:_

1. **Rules reference tools that don't exist in Sentinal** (Tasks 1-2) → Trigger: A rule references legacy tool commands instead of Sentinal equivalents. Check: grep all new files for legacy tool names after creation.
2. **Commands reference wrong hook entry points** (Tasks 3-6) → Trigger: A command uses a legacy Python hook pattern instead of `sentinal hook ...`. Check: grep for "uv run" and ".py" in commands.
3. **Embed-assets fails silently on new files** (Task 10) → Trigger: New rules don't appear in `embedded-assets.ts`. Check: count rules in generated file vs files in directory.

## Goal Verification

### Truths

1. All 8 Claude Code commands match the market research reference depth (line count within 20%)
2. All 12 new rules exist in `targets/claude-code/rules/` (17 total including 5 existing standards) and are non-empty
3. Both agents have detailed review phases and structured output
4. OpenCode targets match Claude Code targets in content
5. `bun run embed-assets` succeeds and includes all new files
6. No references to legacy branding or paths remain in Sentinal's target files
7. `bun test` passes with 0 failures

### Artifacts

- 12 new rule files in `targets/claude-code/rules/` (17 total)
- 8 upgraded command files in `targets/claude-code/commands/`
- 2 upgraded agent files in `targets/claude-code/agents/`
- 5 upgraded skill files in `targets/opencode/skills/`
- 3 upgraded command files in `targets/opencode/commands/`
- 2 upgraded agent files in `targets/opencode/agents/`
- Updated `templates/commands/` and `templates/rules/`

### Key Links

- Rules → loaded by Claude Code plugin every session → affect all AI behavior
- Commands → invoked via `/sentinal:spec` etc. → drive the spec workflow
- Agents → launched as sub-agents by commands → provide review feedback
- Embed-assets → bakes files into binary → used by install process

## Progress Tracking

- [x] Task 1: Add core workflow rules
- [x] Task 2: Add tool reference rules
- [x] Task 3: Add task-and-workflow rule
- [x] Task 4: Upgrade spec.md command
- [x] Task 5: Upgrade spec-plan.md command
- [x] Task 6: Upgrade spec-implement.md command
- [x] Task 7: Upgrade spec-verify.md command
- [x] Task 8: Upgrade bugfix commands
- [x] Task 9: Upgrade learn.md and sync.md commands
- [x] Task 10: Upgrade agents
- [x] Task 11: Update OpenCode targets
- [x] Task 12: Verify embed-assets and branding

**Total Tasks:** 12 | **Completed:** 12 | **Remaining:** 0

## Implementation Tasks

### Task 1: Add Core Workflow Rules

**Objective:** Create 6 core workflow rule files adapted from the market research reference, with Sentinal branding.

**Dependencies:** None

**Files:**

- Create: `targets/claude-code/rules/testing.md`
- Create: `targets/claude-code/rules/verification.md`
- Create: `targets/claude-code/rules/development-practices.md`
- Create: `targets/claude-code/rules/context-management.md`
- Create: `targets/claude-code/rules/code-review-reception.md`
- Create: `targets/claude-code/rules/sentinal-memory.md`

**Key Decisions / Notes:**

- Adapt from market research reference rule equivalents
- Apply Sentinal branding: Vexor for semantic search, `sentinal` CLI, `~/.sentinal/` paths
- `testing.md` includes TDD workflow, test strategy, coverage requirements, property-based testing
- `verification.md` includes execution verification, evidence-based claims, stop signals
- `development-practices.md` includes search priority (Vexor first), debugging methodology, git rules, constraint classification
- `context-management.md` covers auto-compaction handling (short, ~40 lines)
- `code-review-reception.md` covers how to receive and process code review feedback
- `sentinal-memory.md` covers the online learning system and memory tools

**Definition of Done:**

- [ ] All 6 files created with content adapted from market research reference
- [ ] No legacy tool or path references in any file
- [ ] Each file has appropriate frontmatter (no `globs` — these load every session)
- [ ] Content is functionally equivalent to the market research reference rules

**Verify:**

- `ls targets/claude-code/rules/ | wc -l` → should be 11 (5 existing + 6 new)
- Grep the 6 new rule files for legacy tool names → should return nothing

---

### Task 2: Add Tool Reference Rules

**Objective:** Create 5 tool reference rule files for Sentinal's tool ecosystem.

**Dependencies:** None

**Files:**

- Create: `targets/claude-code/rules/research-tools.md`
- Create: `targets/claude-code/rules/cli-tools.md`
- Create: `targets/claude-code/rules/mcp-servers.md`
- Create: `targets/claude-code/rules/playwright-cli.md`
- Create: `targets/claude-code/rules/team-sharing.md`

**Key Decisions / Notes:**

- `cli-tools.md` documents the `sentinal` CLI binary and `Vexor` semantic search
- `mcp-servers.md` documents Sentinal's MCP servers with `mcp__plugin_sentinal_` prefix
- `research-tools.md` establishes Vexor as the primary search tool with fallback chain
- `playwright-cli.md` can be copied mostly as-is (browser automation is tool-agnostic) with session isolation using `$SENTINAL_SESSION_ID`
- `team-sharing.md` is a placeholder noting Sentinal doesn't have team features but documenting how to share `.claude/` assets manually

**Definition of Done:**

- [ ] All 5 files created with content adapted from market research reference
- [ ] `cli-tools.md` references `sentinal` CLI commands and `vexor` for search
- [ ] `mcp-servers.md` uses `mcp__plugin_sentinal_` prefix throughout
- [ ] No legacy tool or path references

**Verify:**

- `ls targets/claude-code/rules/ | wc -l` → should be 16 (5 existing + 6 new from Task 1 + 5 new from Task 2)
- `grep -rli "probe\b" targets/claude-code/rules/` → should return nothing

---

### Task 3: Add Task-and-Workflow Rule

**Objective:** Create the largest and most important workflow rule — covers task management, /spec orchestration, deviation handling, plan registration.

**Dependencies:** None

**Files:**

- Create: `targets/claude-code/rules/task-and-workflow.md`

**Key Decisions / Notes:**

- This is 192 lines in the market research reference — the most complex rule
- Covers: plan mode guidance, task complexity triage, task management, sub-agent usage, /spec workflow overview, deviation handling, plan registration, worktree isolation
- Must reference `sentinal register-plan`, `sentinal worktree`, `sentinal check-context`
- Must reference Sentinal's sub-agent types: `sentinal:plan-reviewer` and `sentinal:spec-reviewer` (confirmed: plugin.json name is "sentinal", agents are namespaced as `plugin-name:agent-name`)
- The /spec workflow section should reference `Skill('spec-plan')`, `Skill('spec-implement')`, etc.

**Definition of Done:**

- [ ] File created with full task management, /spec orchestration, and deviation handling
- [ ] All CLI references use `sentinal` commands
- [ ] Workflow dispatch table matches Sentinal's command structure
- [ ] Content is functionally equivalent to the market research reference task-and-workflow.md

**Verify:**

- `wc -l targets/claude-code/rules/task-and-workflow.md` → should be ~180-200 lines
- `grep "sentinal" targets/claude-code/rules/task-and-workflow.md | wc -l` → multiple hits
- `ls targets/claude-code/rules/ | wc -l` → should be 17 (5 existing + 6 from Task 1 + 5 from Task 2 + 1 from Task 3)

---

### Task 4: Upgrade spec.md Command

**Objective:** Upgrade the /spec dispatcher command to match market research reference depth — add env var toggle reading, structured dispatch logic, and detailed constraints.

**Dependencies:** Tasks 1-3 (rules must exist for commands to reference)

**Files:**

- Modify: `targets/claude-code/commands/spec.md`

**Key Decisions / Notes:**

- Current: 48 lines. Target: ~80 lines (matching market research reference)
- Add: env var toggle checking (`$SENTINAL_WORKTREE_ENABLED`, `$SENTINAL_PLAN_QUESTIONS_ENABLED`, `$SENTINAL_PLAN_APPROVAL_ENABLED`)
- Add: detailed dispatch constraints (⛔ No substantive work here)
- Add: model routing table (Opus for planning, Sonnet for implementation)
- Add: proper YAML frontmatter with `user-invocable: true` and `model: sonnet`

**Definition of Done:**

- [ ] Command has proper YAML frontmatter (description, argument-hint, user-invocable, model)
- [ ] Includes env var toggle reading step
- [ ] Includes model routing table
- [ ] Includes dispatch constraints matching market research reference

**Verify:**

- `wc -l targets/claude-code/commands/spec.md` → should be ~75-85 lines

---

### Task 5: Upgrade spec-plan.md Command

**Objective:** Upgrade the feature planning command to full market research reference depth — the biggest single command upgrade.

**Dependencies:** Tasks 1-3

**Files:**

- Modify: `targets/claude-code/commands/spec-plan.md`

**Key Decisions / Notes:**

- Current: 76 lines. Target: ~375 lines (matching market research reference)
- Add: Step 0 (toggle configuration reading)
- Add: AskUserQuestion integration with batched questions
- Add: Detailed plan template with all sections (Summary, Scope, Context for Implementer, Runtime Environment, Assumptions, Testing Strategy, Risks, Pre-Mortem, Goal Verification, Progress Tracking, Implementation Tasks)
- Add: Plan verification step with plan-reviewer sub-agent
- Add: Plan approval gate with AskUserQuestion
- Add: Migration/refactoring Feature Inventory workflow
- Add: Worktree creation during planning
- Add: Notification hooks (`sentinal notify`)
- Add: YAML frontmatter with `model: opus` and `user-invocable: false`

**Definition of Done:**

- [ ] Command has all 8 steps from the market research reference spec-plan (Step 0 through Step 1.8)
- [ ] Includes detailed plan template with all required sections
- [ ] Includes AskUserQuestion integration
- [ ] All CLI references use `sentinal` commands
- [ ] Line count is ~350-380 lines

**Verify:**

- `wc -l targets/claude-code/commands/spec-plan.md` → should be ~350-380

---

### Task 6: Upgrade spec-implement.md Command

**Objective:** Upgrade the TDD implementation command with worktree detection, task management, pre-mortem checks, and migration support.

**Dependencies:** Tasks 1-3

**Files:**

- Modify: `targets/claude-code/commands/spec-implement.md`

**Key Decisions / Notes:**

- Current: 72 lines. Target: ~134 lines (matching market research reference)
- Add: Critical constraints section (no sub-agents, TDD mandatory, never skip tasks, plan is source of truth)
- Add: Feedback loop awareness (multiple implementation cycles)
- Add: Step 2.1b (Worktree detection/resumption using `sentinal worktree`)
- Add: Step 2.2 (Task list setup with TaskCreate/TaskUpdate)
- Add: Step 2.3 expanded TDD loop with pre-mortem checks, call chain analysis, assumption checking
- Add: Step 2.5 completion with plan registration and type-aware dispatch
- Add: Migration/refactoring additions
- Add: YAML frontmatter with `model: sonnet`

**Definition of Done:**

- [ ] Command has all steps (2.1 through 2.5) matching market research reference
- [ ] Includes worktree detection via `sentinal worktree`
- [ ] Includes pre-mortem and assumption checking during TDD loop
- [ ] All CLI references use `sentinal` commands

**Verify:**

- `wc -l targets/claude-code/commands/spec-implement.md` → should be ~130-140

---

### Task 7: Upgrade spec-verify.md Command

**Objective:** Upgrade the feature verification command with runtime profile classification, Phase A/B structure, E2E testing, and regression checks.

**Dependencies:** Tasks 1-3

**Files:**

- Modify: `targets/claude-code/commands/spec-verify.md`

**Key Decisions / Notes:**

- Current: 63 lines. Target: ~360 lines (matching market research reference)
- Add: Step 0 (toggle configuration for spec reviewer)
- Add: Step 3.0 (Runtime profile classification: Minimal/API/Full)
- Add: Phase A (Finalize code) — launch reviewer, automated checks, feature parity, collect results, fix
- Add: Phase B (Verify running program) — build, program execution, per-task DoD audit, E2E with playwright-cli
- Add: Final phase — regression check, worktree sync, post-merge verification, status update
- Add: Detailed spec-reviewer launch instructions with Task(subagent_type=...)
- Add: Bash polling for reviewer results (not TaskOutput)
- Replace any legacy path references with `sentinal`

**Definition of Done:**

- [ ] Command has all verification phases matching market research reference
- [ ] Includes runtime profile classification
- [ ] Includes Phase A (code finalization) and Phase B (runtime verification)
- [ ] Includes spec-reviewer sub-agent launch
- [ ] All CLI references use `sentinal` commands

**Verify:**

- `wc -l targets/claude-code/commands/spec-verify.md` → should be ~350-370

---

### Task 8: Upgrade Bugfix Commands

**Objective:** Upgrade both bugfix commands (spec-bugfix-plan.md, spec-bugfix-verify.md) to match market research reference depth.

**Dependencies:** Tasks 1-3

**Files:**

- Modify: `targets/claude-code/commands/spec-bugfix-plan.md`
- Modify: `targets/claude-code/commands/spec-bugfix-verify.md`

**Key Decisions / Notes:**

- spec-bugfix-plan: Current 77 lines → Target ~257 lines. Add: Step 0 (toggles), systematic investigation phases, Behavior Contract with formal notation, worktree creation, plan-reviewer for complex bugs, notification hooks, approval gate
- spec-bugfix-verify: Current 45 lines → Target ~90 lines. Add: Step 0 (toggles), detailed Behavior Contract audit, regression test confirmation, defense-in-depth validation, quality checks without sub-agents


**Definition of Done:**

- [ ] spec-bugfix-plan.md has systematic investigation, Behavior Contract, and approval gate
- [ ] spec-bugfix-verify.md has detailed verification without sub-agents
- [ ] Both commands reference `sentinal` CLI

**Verify:**

- `wc -l targets/claude-code/commands/spec-bugfix-plan.md` → ~250-260
- `wc -l targets/claude-code/commands/spec-bugfix-verify.md` → ~85-95

---

### Task 9: Upgrade learn.md and sync.md Commands

**Objective:** Upgrade the learn and sync utility commands to full market research reference depth.

**Dependencies:** Tasks 1-3

**Files:**

- Modify: `targets/claude-code/commands/learn.md`
- Modify: `targets/claude-code/commands/sync.md`

**Key Decisions / Notes:**

- learn.md: Current 71 lines → Target ~211 lines. Add: Detailed extraction criteria, skill creation workflow, quality assessment rubric, automatic trigger conditions, session evaluation checklist
- sync.md: Current 27 lines → Target ~549 lines. Add: Comprehensive codebase exploration phases, framework detection, monorepo support, rule generation templates, MCP documentation generation, coding standards activation, skills discovery, verification output

**Definition of Done:**

- [ ] learn.md has detailed extraction criteria and skill creation workflow
- [ ] sync.md has comprehensive codebase exploration and rule generation
- [ ] Both reference Sentinal-specific tools and conventions

**Verify:**

- `wc -l targets/claude-code/commands/learn.md` → ~200-220
- `wc -l targets/claude-code/commands/sync.md` → ~540-560

---

### Task 10: Upgrade Agents

**Objective:** Upgrade both agent definitions with more detailed review phases and structured output.

**Dependencies:** None

**Files:**

- Modify: `targets/claude-code/agents/plan-reviewer.md`
- Modify: `targets/claude-code/agents/spec-reviewer.md`

**Key Decisions / Notes:**

- plan-reviewer: Add detailed completeness checklist, architecture review criteria, adversarial review prompts, YAGNI check, risk assessment criteria
- spec-reviewer: Add three-phase review (compliance, quality, goal), Angular/NestJS-specific checks, security audit checklist, confidence-based filtering
- Both: Keep YAML frontmatter consistent with current format (name, description, tools, model, background, permissionMode)

**Definition of Done:**

- [ ] plan-reviewer has detailed review checklist and adversarial prompts
- [ ] spec-reviewer has three-phase review with confidence-based filtering
- [ ] Both reference Angular/NestJS/TypeScript-specific quality criteria

**Verify:**

- `wc -l targets/claude-code/agents/plan-reviewer.md` → ~60-80 lines
- `wc -l targets/claude-code/agents/spec-reviewer.md` → ~70-90 lines

---

### Task 11: Update OpenCode Targets

**Objective:** Update OpenCode commands, skills, and agents to match the upgraded Claude Code versions.

**Dependencies:** Tasks 1-10 (all Claude Code upgrades complete)

**Files:**

- Modify: `targets/opencode/commands/spec.md`
- Modify: `targets/opencode/commands/learn.md`
- Modify: `targets/opencode/commands/sync.md`
- Modify: `targets/opencode/skills/spec-plan/SKILL.md`
- Modify: `targets/opencode/skills/spec-implement/SKILL.md`
- Modify: `targets/opencode/skills/spec-verify/SKILL.md`
- Modify: `targets/opencode/skills/spec-bugfix-plan/SKILL.md`
- Modify: `targets/opencode/skills/spec-bugfix-verify/SKILL.md`
- Modify: `targets/opencode/agents/plan-reviewer.md`
- Modify: `targets/opencode/agents/spec-reviewer.md`
- Create: `targets/opencode/rules/testing.md` (+ all 11 new rules)

**Key Decisions / Notes:**

- OpenCode commands and skills should mirror Claude Code commands in content
- OpenCode uses different tool names (e.g., `activate_skill` instead of `Skill`)
- OpenCode rules follow the same markdown format
- Copy all 11 new rules from Claude Code targets to OpenCode targets

**Definition of Done:**

- [ ] All 5 OpenCode skills match their Claude Code command equivalents
- [ ] All 3 OpenCode commands match their Claude Code equivalents
- [ ] Both OpenCode agents match their Claude Code equivalents
- [ ] All 12 new rules copied to `targets/opencode/rules/`
- [ ] OpenCode-specific tool references maintained where different

**Verify:**

- `diff <(ls targets/claude-code/rules/) <(ls targets/opencode/rules/)` → should be identical
- `ls targets/opencode/rules/ | wc -l` → 17
- After `bun run embed-assets` (Task 12), confirm OpenCode rules appear: `grep -c "standards-angular" src/cli/embedded-assets.ts` → should return >1

---

### Task 12: Verify Embed-Assets and Branding

**Objective:** Run embed-assets, verify all files are included, grep for branding inconsistencies, run tests.

**Dependencies:** Tasks 1-11

**Files:**

- None created/modified (verification only)

**Key Decisions / Notes:**

- Run `bun run embed-assets` and verify output
- Count rules, commands, agents in generated `src/cli/embedded-assets.ts`
- Grep entire `targets/` directory for leftover `competitor-cli` / `probe` references
- Run `bun test` to ensure nothing is broken
- Update `templates/commands/` and `templates/rules/` to match targets if they're out of sync

**Definition of Done:**

- [ ] `bun run embed-assets` succeeds
- [ ] Generated `embedded-assets.ts` includes all 17 rules, 8 commands, 2 agents for Claude Code
- [ ] Grep of `targets/claude-code/ targets/opencode/` for legacy tool names returns no matches
- [ ] `bun test` passes with 0 failures
- [ ] Template files in `templates/` are updated to match targets

**Verify:**

- `bun run embed-assets 2>&1 | tail -20`
- `bun test`
- `grep -rn "\\bprobe\\b" targets/claude-code/ targets/opencode/ | head -20` → empty

## Open Questions

None — scope is clear from user responses.

## Deferred Ideas

- Add Sentinal-specific coding standards for Tailwind CSS (beyond what standards-frontend.md covers)
- Add stack-specific knowledge rules for Angular 20+ signals, new control flow, etc. (existing standards-angular.md may need updates as Angular evolves)
- Consider adding a `/babysit-prs` command equivalent if needed
