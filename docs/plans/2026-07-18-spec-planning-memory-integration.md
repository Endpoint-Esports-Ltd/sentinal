# Wire Sentinal Memory into Spec Planning Skills Implementation Plan

Created: 2026-07-18
Status: VERIFIED
Approved: Yes
Iterations: 3
Worktree: No
Type: Feature

## Summary

**Goal:** Make the spec skills explicitly recall prior context via `memory_search` — and persist high-value discoveries/decisions via `memory_save` — at the points where recall pays off most: (a) before planning/designing, and (b) at runtime PIVOT moments during implementation (fix-attempt limit, library/architecture pivot, invalidated assumption, hypothesis-exhaustion escalation, failed master phase). Today the spec skills make zero explicit use of memory; they rely on a passive rule + ambient session-start injection.

**Architecture:** Documentation/prompt change only — edit skill/command markdown in BOTH targets, regenerate embedded assets, add a structural regression test. No runtime code.

**Tech Stack:** Markdown skills (OpenCode `skills/`, Claude Code `commands/`), `scripts/embed-assets.mjs`, `bun test` structural assertions.

## Recall/Save Point Map (all 6, both targets)

| # | Skill · anchor | Moment | Action added | Type |
| - | -------------- | ------ | ------------ | ---- |
| 1 | spec-plan · before Task Understanding (1.2) | Start of planning | `memory_search` recall; `memory_save` decision at finalize | decision |
| 2 | spec-bugfix-plan · before Root Cause Investigation (1.2) + Check Recent Changes (1.2.2) | Start of root-cause tracing | `memory_search` prior error/fix in area; save fix decision at finalize | fix |
| 3 | spec-master-plan · before Task Understanding (1.2) | Start of master planning | `memory_search` prior architecture/phase decisions; save at finalize | decision |
| 4 | spec-implement · Fix attempt limit (3 tries → blocked) | About to defer a stuck test/issue | `memory_search` "seen this failure?"; `memory_save` the blocker as `error` | error |
| 5 | spec-implement · Deviation "Ask user" (library/API/architecture pivot) | About to stop and pivot | `memory_search` prior decisions on that lib/arch before escalating; save pivot outcome | decision |
| 6 | spec-implement · Surprise discovery / invalidated assumption | Behavior contradicts plan | `memory_search` "did a past session hit this?"; `memory_save` the discovery | discovery |
| 7 | spec-bugfix-plan · Escalation (3+ hypotheses failed → architectural) | About to declare architectural problem | `memory_search` prior error/decision on subsystem before escalating | (recall only) |
| 8 | spec-master-execute · Phase failed (retry/skip/stop) | Child phase failed | `memory_search` prior occurrences of this failure/phase; save outcome | error |

> Note: the map lists 8 rows because #1/#2/#3 (planning recall) and #4-#8 (pivot recall) — the user's "all 6 recall points" = the 6 distinct MOMENTS (planning×3 collapse to the 3 planning skills; pivots = fix-limit, deviation-pivot, surprise, bugfix-escalation, master-phase-fail). Every one is implemented; rows above enumerate each concrete insertion.

## Scope

### In Scope

- **5 skills, both targets (10 files):** `spec-plan`, `spec-bugfix-plan`, `spec-master-plan`, `spec-implement`, `spec-master-execute`.
- **Planning recall (points 1-3):** a "Recall Prior Context" `memory_search` step BEFORE exploration/investigation + a lean `memory_save` (finalized decision) at plan finalization — fires on BOTH interactive "Yes" AND auto-approve (`SENTINAL_PLAN_APPROVAL_ENABLED=false`, e.g. `/quick`).
- **Pivot recall (points 4-8):** `memory_search` at each runtime pivot moment (fix-attempt limit, library/architecture "Ask user" pivot, invalidated-assumption surprise, bugfix 3+-hypotheses escalation, master phase-fail) + `memory_save` of the discovery/blocker where it closes the loop (fix-limit → `error`; pivot → `decision`; surprise → `discovery`; phase-fail → `error`). Bugfix-escalation is recall-only (the plan's root-cause statement + finalize-save already cover the write side).
- Best-effort degradation language (memory unavailable/empty ⇒ note + continue, never block) at EVERY insertion.
- Regenerate `src/cli/embedded-assets.ts` (via `embed-assets`); add a regression test covering all insertions.

### Out of Scope

- `spec-verify`, `spec-bugfix-verify` (verification phases) — recall adds little at pure pass/fail verification; defer.
- `/quick` needs NO separate edit: it reuses the same `spec-plan`/`spec-bugfix-plan`/`spec-implement` skills (quick.md:34-35), so it inherits all recall automatically. The auto-approve save gap is handled by the fires-on-both-branches design.
- Changing the `memory-restore` hook or the shipped `sentinal-memory` rule.
- Any change to memory tool implementations.

## Context for Implementer

> Sentinal ships as extensions for BOTH Claude Code and OpenCode. Planning phases live in DIFFERENT files per target:
>
> - **OpenCode:** `targets/opencode/skills/<name>/SKILL.md`
> - **Claude Code:** `targets/claude-code/commands/<name>.md`
>
> Both must stay in sync (see `.sentinal/rules/sentinal-dual-target.md`).

- **Insertion point for search:** immediately AFTER the "Create Plan File Header" step and BEFORE the first exploration/investigation step, so recalled context feeds questions + design.
  - `spec-plan`: after Step 1.1, before Step 1.2 (Task Understanding) — targets/opencode/skills/spec-plan/SKILL.md:127.
  - `spec-bugfix-plan`: after Step 1.1, before Step 1.2 (Root Cause Investigation) — targets/opencode/skills/spec-bugfix-plan/SKILL.md:112.
  - `spec-master-plan`: after Step 1.1, before Step 1.2 (Task Understanding) — targets/opencode/skills/spec-master-plan/SKILL.md:60.
- **Insertion point for planning save:** the approval step — `spec-plan` Step 1.8, `spec-master-plan` Step 1.8, `spec-bugfix-plan` Step 1.5. ⚠️ The save must fire on BOTH branches of that step: the interactive "Yes" path AND the `SENTINAL_PLAN_APPROVAL_ENABLED="false"` auto-approve path. `/quick` sets that toggle false and auto-approves (targets/opencode/commands/quick.md:22,40) reusing these same skills — gating save only on human "Yes" would mean `/quick` never saves. Phrase as "when the plan is finalized (approved or auto-approved), before invoking spec-implement, `memory_save` …".
- **Pivot insertion points (exact, both targets — line numbers match per target):**
  - `spec-implement` Fix-attempt-limit: OC `SKILL.md:113`, CC `spec-implement.md:115` — add recall BEFORE deferring + save the blocker as `error`.
  - `spec-implement` Deviation "Ask user" pivot: OC `:110`/CC `:112` (the table row) — add recall before escalating a library/API/architecture pivot + save the pivot decision.
  - `spec-implement` Surprise discovery: OC `:181`/CC `:185` — add recall + save `discovery` when an assumption is invalidated.
  - `spec-bugfix-plan` Check Recent Changes: OC `:123`/CC `:126` — fold recall into recent-change tracing (complements git log).
  - `spec-bugfix-plan` Escalation: OC `:162`/CC `:165` — recall prior error/decision on the subsystem before declaring architectural (recall-only).
  - `spec-master-execute` Phase-fail: OC `:120-122`/CC `:123-125` — recall prior occurrences before retry/skip/stop + save the failure as `error`.
- **spec-implement/master-execute have NO approval-style step** — pivot saves are inline at the moment (best-effort), not gated on any toggle.
- **Style to match:** the `learn` command's memory reference — `targets/opencode/commands/learn.md:165` ("Also persist to Sentinal memory using `memory_save` MCP tool with `type`, `tags`, `project`… Use `memory_search` first…"). Reference the MCP tool by snake_case name; state WHEN and WHY.
- **Memory tools are real & functional:** hybrid vector+FTS memory_search runs in the sidecar (memory obs #135; #131 notes prod path is FTS5). `memory_search` / `memory_save` are registered MCP tools (src/memory/mcp-tools.ts).
- **Delivery path:** after editing `targets/`, run `bun run embed-assets` — `sentinal install` ships skills from `EMBEDDED_OC_SKILLS`, not the live tree (memory obs #374). The generated file is now gitignored + regenerated by preload/prepack (this session's prior fix), so tests regenerate it automatically.
- **Gotcha:** OpenCode SKILL.md requires `name:` frontmatter matching folder (obs #372) — do NOT disturb existing frontmatter when editing.

## Assumptions

- The 5 planning+implement+master-execute skills are the right places — supported by the audit (0 memory refs in any spec skill) and the recall-point analysis. Tasks 1-5 depend on this.
- `memory_search` accepts a free-text `query` + optional `project`; `memory_save` takes `title`/`content`/`type`/`project`(+tags) — supported by src/memory/mcp-tools.ts:78 + this session's usage. All tasks depend on this.
- Regenerated embedded-assets stays deterministic (prior fix) so the regression test is stable — supported by this session's determinism work. Task 6 depends on this.
- Pivot saves at spec-implement/master-execute are inline/best-effort (those skills have no approval toggle to gate on). Tasks 4-5 depend on this.

## Testing Strategy

- **Structural regression test** (`bun test`, target-assets style) — for each of the 10 skill/command files, assert the file contains the memory instructions relevant to that skill:
  - planning (spec-plan/bugfix-plan/master-plan): `memory_search` present AND positioned before the anchor step (depth-agnostic, per-file anchor map, fail-loud); `memory_save` present.
  - spec-implement: `memory_search` present near fix-limit + deviation + surprise anchors; `memory_save` present.
  - spec-master-execute: `memory_search` present near the phase-fail anchor.
  - Delivery guard: `EMBEDDED_OC_SKILLS` for the 5 skills contains `memory_search`.
- **Manual:** re-read one planning and one pivot insertion end-to-end for coherence.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| Prescriptive memory steps add friction | Med | Low | Lean (1 search / 1 save per point); best-effort language so they never block |
| Memory store noise from saves | Med | Low | Save only high-signal points (finalized decision, blocker, pivot, discovery) — not exploration chatter |
| Pivot recall slows the "NEVER stop during implementation" flow | Med | Med | Phrase as a single fast best-effort call; explicitly "if empty/errors, continue immediately" — must not become a stall |
| Drift across the 10 target files | Med | Med | Regression test asserts all 10 + embedded copy |
| Forgotten embed-assets ⇒ stale install | Low | Med | Preload/prepack auto-regenerate (prior fix); test asserts embedded copy |

## Pre-Mortem

1. **Instruction present but ignored at runtime** (Tasks 1-5) → Trigger: step buried/soft. Mitigation: emphasis matching existing mandatory steps, placed at the exact pivot anchor.
2. **Pivot recall conflicts with "never stop" rule** (Tasks 4-5) → Trigger: agent stalls waiting on memory. Mitigation: explicit "best-effort, single call, continue on empty/error" wording; recall is additive, not a gate.
3. **Search placed after questions/decisions** (Tasks 1-3) → Trigger: recalled context can't inform them. Mitigation: insert strictly before the anchor step.
4. **Only OpenCode edited, Claude Code missed** → Trigger: partial dual-target edit. Mitigation: test asserts BOTH targets + embedded copy for all 5 skills.

## Execution Waves

**Wave 1** — skill edits (parallel-safe; each task edits distinct files, no overlap): Tasks 1-5 (spec-plan, spec-bugfix-plan, spec-master-plan, spec-implement, spec-master-execute — each in both targets).
**Wave 2** — delivery + guard (depends on all Wave-1 content): Task 6 regenerates embedded assets and adds the regression test.

## Goal Verification

### Truths

1. Each of the 5 skills in `targets/opencode/skills/{spec-plan,spec-bugfix-plan,spec-master-plan,spec-implement,spec-master-execute}/SKILL.md` contains `memory_search` (grep-verifiable).
2. Each of the 5 in `targets/claude-code/commands/{...}.md` contains `memory_search` (grep-verifiable).
3. Planning skills (spec-plan/bugfix-plan/master-plan) contain `memory_save` at finalize; spec-implement contains `memory_save` at a pivot; both targets (grep-verifiable).
4. In the 3 planning files, `memory_search` appears BEFORE the anchor step (depth-agnostic position-verified).
5. `EMBEDDED_OC_SKILLS` for all 5 skills contains `memory_search` (after embed-assets).
6. `bun test src/cli/spec-memory-integration.test.ts` passes; full `bun test` green; `bunx tsc --noEmit` clean.

### Artifacts

| Artifact | Provides | Exports |
| -------- | -------- | ------- |
| targets/opencode/skills/spec-plan/SKILL.md | Feature planning w/ memory recall+save | (skill) |
| targets/opencode/skills/spec-bugfix-plan/SKILL.md | Bugfix planning w/ memory recall+save | (skill) |
| targets/opencode/skills/spec-master-plan/SKILL.md | Master planning w/ memory recall+save | (skill) |
| targets/claude-code/commands/spec-plan.md | CC feature planning (same) | (command) |
| targets/claude-code/commands/spec-bugfix-plan.md | CC bugfix planning (same) | (command) |
| targets/claude-code/commands/spec-master-plan.md | CC master planning (same) | (command) |
| targets/opencode/skills/spec-implement/SKILL.md | Pivot recall+save (fix-limit/pivot/surprise) | (skill) |
| targets/claude-code/commands/spec-implement.md | CC implement (same) | (command) |
| targets/opencode/skills/spec-master-execute/SKILL.md | Phase-fail recall+save | (skill) |
| targets/claude-code/commands/spec-master-execute.md | CC master-execute (same) | (command) |
| src/cli/spec-memory-integration.test.ts | Regression guard | test |

### Key Links

| From | To | Via | Pattern |
| ---- | -- | --- | ------- |
| spec-plan SKILL.md | memory MCP | recall step | memory_search |
| spec-plan SKILL.md | memory MCP | approval save | memory_save |
| src/cli/embedded-assets.ts | targets skills | embed-assets regen | memory_search |

## Progress Tracking

- [x] Task 1: Add memory recall+save to spec-plan (both targets) (Wave 1)
- [x] Task 2: Add memory recall+save to spec-bugfix-plan (recall+escalation-recall) (both targets) (Wave 1)
- [x] Task 3: Add memory recall+save to spec-master-plan (both targets) (Wave 1)
- [x] Task 4: Add pivot recall+save to spec-implement (fix-limit, deviation-pivot, surprise) (both targets) (Wave 1)
- [x] Task 5: Add phase-fail recall to spec-master-execute (both targets) (Wave 1)
- [x] Task 6: Regenerate embedded assets + regression test + verify (Wave 2)
      **Total Tasks:** 6 | **Completed:** 6 | **Remaining:** 0

## Implementation Tasks

### Task 1: spec-plan memory integration (both targets)

**Objective:** Add a "Recall Prior Context" (`memory_search`) step before exploration and a lean `memory_save` at approval, in both the OpenCode skill and Claude Code command.
**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `targets/opencode/skills/spec-plan/SKILL.md`
- Modify: `targets/claude-code/commands/spec-plan.md`

**Key Decisions / Notes:**

- Insert search step after "Create Plan File Header", before "Task Understanding". Language: "Run `memory_search` (MCP) for the task's prior decisions, past bugs, and established patterns in this area; fold any hits into your questions and design. Best-effort: if memory is unavailable or empty, note it and continue — never block." Reference tool by snake_case name, mirror `learn.md:165` style.
- At approval (Step 1.8, on "Yes"): "Save the approved approach with `memory_save` (type `decision`) — one concise observation (chosen approach + why + key files), so future `memory_search` recalls it. Best-effort."

**Definition of Done:**

- [ ] Both files contain a memory_search step before exploration and a memory_save at approval
- [ ] No frontmatter disturbed; steps read coherently
- [ ] `bun test` green

**Verify:** `rg -n "memory_search|memory_save" targets/opencode/skills/spec-plan/SKILL.md targets/claude-code/commands/spec-plan.md`

### Task 2: spec-bugfix-plan memory integration (both targets)

**Objective:** Same pattern, adapted for bugfix — recall prior root causes / recent-change patterns before Root Cause Investigation; save the fix decision at approval.
**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `targets/opencode/skills/spec-bugfix-plan/SKILL.md`
- Modify: `targets/claude-code/commands/spec-bugfix-plan.md`

**Key Decisions / Notes:**

- Insert search step after "Create Plan File Header" (Step 1.1), before "Root Cause Investigation" (Step 1.2). Emphasize recalling prior `error`/`fix` observations for this area ("has this bug/class been seen before?"). Also reference it inside "Check Recent Changes" (1.2.2, OC:123/CC:126) as a complement to `git log`.
- **Escalation recall (point 7):** at "Escalation: If 3+ hypotheses have failed" (OC:162/CC:165), add: before declaring an architectural problem, `memory_search` prior `error`/`decision` observations on this subsystem — the architectural truth may already be recorded. Recall-only, best-effort.
- Save at approval (Step 1.5): `memory_save` the root cause + fix approach (type `fix`), best-effort, fires on approve AND auto-approve.

**Definition of Done:**

- [ ] Both files contain search-before-investigation, escalation-recall, and save-at-finalize
- [ ] `bun test` green

**Verify:** `rg -n "memory_search|memory_save" targets/opencode/skills/spec-bugfix-plan/SKILL.md targets/claude-code/commands/spec-bugfix-plan.md`

### Task 3: spec-master-plan memory integration (both targets)

**Objective:** Same pattern for master planning — recall prior architecture/phase decisions before exploration; save the master decision at approval.
**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `targets/opencode/skills/spec-master-plan/SKILL.md`
- Modify: `targets/claude-code/commands/spec-master-plan.md`

**Key Decisions / Notes:**

- Insert search step after "Create Master Plan File Header" (Step 1.1), before "Task Understanding" (Step 1.2).
- Save at approval (Step 1.8).
- Do NOT disturb the `name:` frontmatter (obs #372).

**Definition of Done:**

- [ ] Both files contain search-before-exploration + save-at-approval
- [ ] Frontmatter intact (`name:` present, matches folder)
- [ ] `bun test` green

**Verify:** `rg -n "memory_search|memory_save|^name:" targets/opencode/skills/spec-master-plan/SKILL.md targets/claude-code/commands/spec-master-plan.md`

### Task 4: spec-implement pivot recall+save (both targets)

**Objective:** Add best-effort `memory_search` recall (+ `memory_save`) at the three runtime pivot moments where recall saves the most wasted effort.
**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `targets/opencode/skills/spec-implement/SKILL.md`
- Modify: `targets/claude-code/commands/spec-implement.md`

**Key Decisions / Notes:**

- **Fix-attempt limit (OC:113/CC:115):** before deferring after 3 attempts, add "`memory_search` for this exact failure/error — a known fix or workaround may exist." Then "if the search did NOT already surface this exact blocker, `memory_save` it as type `error` (symptom + what was tried)." ⚠️ **Dedup:** gate the save on the recall — do not re-save an `error` the search just returned (this step is re-entrant via the verify→implement loop and fires per-task, so unguarded saves would duplicate). Best-effort.
- **Deviation "Ask user" pivot (OC:110/CC:112 table row):** before stopping to ask the user about a library/API/architecture pivot, "`memory_search` prior `decision`/`discovery` on that library/subsystem — the pivot may already have a recorded answer." On resolution, `memory_save` the pivot `decision`. Best-effort.
- **Surprise discovery / invalidated assumption (OC:181/CC:185):** add "`memory_search` whether a past session already hit this contradiction; `memory_save` the `discovery` (invalidated assumption + actual behavior)." Best-effort.
- ⛔ **Must not violate "NEVER stop during implementation" (line 23):** phrase each as a single fast best-effort call — "if empty or errors, continue immediately." Recall is additive, never a stall or a gate. (Note: `memory_search` is itself a tool call, so it satisfies the "next action must be a tool call" rule — reviewer-confirmed no conflict.)
- ⚠️ **Edit bottom-up:** this task inserts at 3 anchors in the same file (lines 181 → 113 → 110). Apply edits from the LOWEST anchor upward (surprise → fix-limit → deviation) so earlier line numbers don't shift under later insertions. Or match by heading/anchor text rather than line number.

**Definition of Done:**

- [ ] Both files contain `memory_search` at all three pivot anchors + `memory_save` at fix-limit/pivot/surprise
- [ ] Wording explicitly preserves the never-stop flow (continue on empty/error)
- [ ] `bun test` green

**Verify:** `rg -n "memory_search|memory_save" targets/opencode/skills/spec-implement/SKILL.md targets/claude-code/commands/spec-implement.md`

### Task 5: spec-master-execute phase-fail recall (both targets)

**Objective:** Add best-effort recall (+ save) when a child phase fails, before the retry/skip/stop decision.
**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `targets/opencode/skills/spec-master-execute/SKILL.md`
- Modify: `targets/claude-code/commands/spec-master-execute.md`

**Key Decisions / Notes:**

- At phase-fail handling (OC:120-122/CC:123-125, "Read the child plan to understand what failed" → "Ask: Retry/Skip/Stop"): insert "`memory_search` for prior occurrences of this failure/phase pattern to inform the retry/skip/stop decision; `memory_save` the failure as type `error`." Best-effort, never block the user prompt.
- Do NOT disturb the `name:` frontmatter (obs #372) if present.

**Definition of Done:**

- [ ] Both files contain `memory_search` at the phase-fail anchor + a `memory_save` of the failure
- [ ] Frontmatter intact
- [ ] `bun test` green

**Verify:** `rg -n "memory_search|memory_save" targets/opencode/skills/spec-master-execute/SKILL.md targets/claude-code/commands/spec-master-execute.md`

### Task 6: Regenerate embedded assets + regression test + verify

**Objective:** Ship the change (embed-assets) and guard it with a structural test.
**Dependencies:** Task 1, 2, 3, 4, 5
**Wave:** 2

**Files:**

- Create: `src/cli/spec-memory-integration.test.ts`
- Regenerate: `src/cli/embedded-assets.ts` (via `bun run embed-assets`)

**Key Decisions / Notes:**

- TDD: write the test FIRST (RED if run before Tasks 1-5; otherwise guards regression). Assertions:
  - **All 5 skills × both targets (10 files):** each contains `memory_search`.
  - **Planning (3 skills × 2):** `memory_search` positioned BEFORE the anchor step + contains `memory_save`.
  - **spec-implement (×2):** contains `memory_search` AND `memory_save` (pivot points).
  - **spec-master-execute (×2):** contains `memory_search`.
  - **Delivery guard:** `EMBEDDED_OC_SKILLS` for all 5 skills contains `memory_search`.
- ⚠️ **Heading structure is NOT uniform** (reviewer-confirmed): planning skills differ — `spec-plan` uses `### Step`, `spec-master-plan` uses `## Step`; anchor name differs — `Task Understanding` (spec-plan/master) vs `Root Cause Investigation` (bugfix). Use a **per-file anchor map** `{ file → anchorRegex }` with a **depth-agnostic regex** (e.g. `/^#{2,3}\s.*(Task Understanding|Root Cause Investigation)/m`). **Fail loud** if an anchor regex doesn't match (future heading rename → clear error, not silent pass). Assert `indexOf(memory_search) < index(anchorMatch)`. Position assertion applies to the 3 PLANNING files only; pivot skills assert presence, not position.
- Model the test on `src/cli/target-assets.test.ts` (readFileSync + REPO_ROOT; import `EMBEDDED_OC_SKILLS` — importable despite the gitignored file, since the test preload regenerates it from the prior generated-not-committed change).
- **Run `bun run embed-assets` fresh** after Tasks 1-5 and before the delivery-path assertion.

**Definition of Done:**

- [ ] `bun test src/cli/spec-memory-integration.test.ts` passes
- [ ] Full `bun test` green; `bunx tsc --noEmit` clean
- [ ] Embedded copy contains the new instructions

**Verify:** `bun test src/cli/spec-memory-integration.test.ts --verbose && bun test && bunx tsc --noEmit`
