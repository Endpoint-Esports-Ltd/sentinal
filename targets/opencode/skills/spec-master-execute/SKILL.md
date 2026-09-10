---
name: spec-master-execute
description: Master plan execution - orchestrate wave-based parallel child plan execution
---

# /spec-master-execute - Master Plan Execution

**Thin orchestrator** that executes a master plan's child phases in wave order, spawning subagents per child plan within each wave for parallel execution. Never does implementation work itself.

**Input:** Approved master plan file (`Type: Master`, `Approved: Yes`)
**Output:** All child plans VERIFIED, master plan status → COMPLETE
**Next:** Chain to `spec-verify` for master plan verification

---

## ⛔ Critical Constraints

- **Thin orchestrator only** — spawn subagents, track progress, never implement
- **Wave ordering is strict** — Wave N+1 starts only after ALL Wave N plans are VERIFIED
- **Resumable** — re-running skips VERIFIED child plans automatically
- **Plan file is source of truth** — re-read after auto-compaction
- **Never stop mid-wave** — complete the current wave before pausing

---

## Step 1: Read Master Plan & Set Active Status

1. **Read the master plan** — parse `## Phases` section
2. **Set status:** Use `spec_register` MCP tool with `status: "IN_PROGRESS"`
3. **Parse phases:** Extract child plan paths, wave assignments, and current status
4. **Report state:** "Master plan has N phases across M waves. K already verified."

### Phase Parsing

The `## Phases` section uses a table format:

```markdown
| Phase | Wave | Title       | Objective            | Dependencies |
| ----- | ---- | ----------- | -------------------- | ------------ |
| 1     | 1    | Data Models | Core database schema | None         |
| 2     | 1    | Auth System | JWT auth + sessions  | None         |
| 3     | 2    | API Layer   | REST endpoints       | Phases 1, 2  |
```

Map phase numbers to child plan files: `docs/plans/YYYY-MM-DD-<master-slug>-phase-N.md`

The `## Progress Tracking` section tracks completion:

```markdown
- [x] Phase 1: Data Models (Wave 1) — VERIFIED
- [ ] Phase 2: Auth System (Wave 1) — IN_PROGRESS
- [ ] Phase 3: API Layer (Wave 2) — PENDING
```

---

## Step 2: Pre-Flight Checks

For each child plan:

1. **File exists:** Verify the child plan `.md` file exists
2. **Has tasks:** Check if the child plan has `## Implementation Tasks` (not just a stub)
3. **Not a stub:** If child plan only has `> Awaiting detailed planning...`, it needs planning first

**If any child plan is a stub (no tasks):**

- Report: "Phase N needs planning. Run `/spec <child-plan.md>` to plan it first."
- Ask user: "Plan all stub phases now?" → If yes, sequentially invoke `spec-plan` for each stub
- Do NOT proceed to wave execution until all child plans have tasks

---

## Step 3: Wave Execution

```
FOR each wave (1, 2, 3, ...):
  1. Collect child plans in this wave that are NOT yet VERIFIED
  2. IF none remaining → skip wave (already complete)
  3. Report: "Starting Wave N: [phase list]"
  4. FOR each child plan in the wave (PARALLEL):
     → Spawn subagent to execute the child plan
  5. Wait for ALL subagents in this wave to complete
  6. Check results:
     - All VERIFIED → update master plan checkboxes, proceed to next wave
     - Any FAILED → report failure, ask user how to proceed
  7. Update master plan `## Progress Tracking` checkboxes
```

### Spawning Subagents

For each child plan in the current wave, spawn a subagent:

```
Task(
  subagent_type="general",
  prompt="""
  Execute the spec workflow for this child plan.

  **Plan file:** <child-plan-path>
  **Master plan:** <master-plan-path>

  1. Read the plan file
  2. If Status is PENDING + Approved: Yes → run /spec <child-plan-path> (implements + verifies)
  3. If Status is IN_PROGRESS → resume /spec <child-plan-path>
  4. If Status is COMPLETE → run verification only
  5. If Status is VERIFIED → report done, no work needed

  The child plan should end at Status: VERIFIED when all tasks pass verification.
  Report the final status when done.
  """
)
```

**Spawn all subagents for a wave in a single message** to enable parallel execution.

### Failure Handling

If a child plan fails (verification rejects, or subagent reports errors):

1. Read the child plan to understand what failed
2. **Recall (Memory):** Run `memory_search` for prior occurrences of this failure/phase pattern — a past session may have hit and resolved it, which can inform the retry/skip/stop decision. Then `memory_save` the failure (type `error`: phase, symptom, cause if known) for future recall. Best-effort — the orchestrator (not the subagent) does this; if memory is empty or errors, continue immediately, never block the user prompt.
3. Report to user: "Phase N failed: [reason]"
4. Ask: "Retry this phase?" / "Skip and continue?" / "Stop execution?"
5. If retry: re-spawn the subagent for that plan
6. If skip: mark as skipped, continue to next wave (dependent phases may also fail)
7. If stop: leave master plan at IN_PROGRESS for later resume

---

## Step 4: Update Progress

After each wave completes, update the master plan:

1. Read current master plan content
2. Update `## Progress Tracking` checkboxes:
   - `- [x] Phase N: Title (Wave M) — VERIFIED` for completed phases
   - `- [ ] Phase N: Title (Wave M) — IN_PROGRESS` for active phases
3. Update counts: `**Total Phases:** N | **Completed:** K | **Remaining:** N-K`

---

## Step 5: Completion

When ALL waves are complete (all child plans VERIFIED):

1. Set master plan `Status: COMPLETE`
2. Use `spec_register` MCP tool with `status: "COMPLETE"`
3. **Chain to verification:** Load `Skill(skill='spec-verify', args='<master-plan-path>')`

The verification phase for master plans checks:

- All child plans are VERIFIED
- No regression between phases (integration check)
- Overall goal is achieved

---

## Unattended Execution

When running sub-phases in headless or CI contexts using `opencode run -p "..."`, append `--dangerously-skip-permissions` to avoid interactive permission prompts blocking the process.

```bash
# Headless sub-phase dispatch (CI / automated testing only)
opencode run --dangerously-skip-permissions -p "Execute spec plan: <child-plan-path>"
```

**Rules:**

- **Only use in non-interactive contexts** — CI pipelines, automated testing, scheduled runs
- **Never use when a human is actively reviewing** — the flag suppresses all permission dialogs
- **Document in commit messages** — note when a run used `--dangerously-skip-permissions`

When spawning subagents via `Task()` (the primary pattern), the flag is not needed — subagents inherit the parent's permission context. This flag is only relevant when invoking `opencode run` as a CLI subprocess from scripts or CI.

---

## Resume Support

When this skill is invoked for a master plan already at IN_PROGRESS:

1. Read master plan and check `## Progress Tracking`
2. Determine which waves are complete (all phases checked)
3. Resume from the first incomplete wave
4. Report: "Resuming from Wave N (Waves 1-M already complete)"

ARGUMENTS: $ARGUMENTS
