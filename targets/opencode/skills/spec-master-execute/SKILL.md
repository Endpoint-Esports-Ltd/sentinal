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
- **Orca Mode never deletes an Orca worktree through Sentinal** — adopted worktrees are released, and only `orca_remove_worktree` removes them

---

## Step 0: Choose the Execution Mode

Call `orca_status({ scope: "master", agent: "<worker agent>", plan_path: "<master-plan-path>" })`.
The worker agent is the coordinator's own: `claude` on Claude Code, `opencode` on OpenCode
(a plan may override it).

- **`mode: "subagents"`** — continue with Step 1 and spawn subagents exactly as described below.
  Say the one-line `reason` so the user knows why Orca was not used.
- **`mode: "orca"`** — continue with Step 1, but run each wave with **Orca Mode** (Step 3). The
  reply also reports the worker agent's login: if `auth.ok` is false, tell the user (e.g. "run
  `/login`, or use the `opencode` agent") and fall back to subagents rather than start workers that
  will stall.

The mode is decided once per run. The master plan header `Orchestration: orca|subagents` and the
`SENTINAL_ORCHESTRATION` setting (`auto` | `orca` | `subagents`) control it; `auto` uses Orca only
when this session runs inside an Orca terminal.

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

### Orca Mode

Each child plan runs as a supervised **Orca worker** in its own Orca worktree, which Sentinal
adopts. You coordinate through the `orca_*` and `worktree_*` MCP tools; never call the `orca` CLI
for lifecycle steps yourself.

**Per wave:**

1. **Commit your own edits first.** Child phases merge into the branch this session has checked
   out, and a merge is refused while that checkout has uncommitted tracked changes (the master
   plan's checkboxes, for example). Commit them before each wave's merges.
2. **Dispatch.** `orca_dispatch({ objective, agent, tasks })` with one task per child plan:
   `key` = the phase, `title` = the phase title, `worktree: "prepare-child"`,
   `name: "spec-<child-plan-slug>"`, `base_branch` = this session's branch, `deps` = the task keys
   (or ids) of the phases this one depends on. The `spec` text must be self-contained:

   ```
   Target: this worktree only. Run the spec workflow for <child-plan-path> (Phase N of master
   plan <master-plan-path>): read the plan; PENDING + Approved: Yes or IN_PROGRESS → run
   /spec <child-plan-path> to completion; COMPLETE → run verification only; VERIFIED → nothing
   to do. Constraints: work only in this worktree; commit your work on this branch; do not
   merge, push, or edit the master plan. Observable acceptance: the child plan file reads
   Status: VERIFIED. Report with worker_done exactly once: --outcome succeeded when the plan
   reads VERIFIED, otherwise --outcome failed with the plan's Status and the blocker.
   ```

   The reply returns each task's `task_id` and the prepared worktree `path`; nothing is started yet.

3. **Adopt.** For each prepared worktree: `worktree_ensure({ plan_slug: "<child-plan-slug>",
path, base: <this session's branch>, owner: "external" })`. This gives it a slot, seeds its
   config and runs the project's `setup` (dependency install). Report any setup warning.
4. **Start.** `orca_start({ task_id, worktree: { path }, agent })` for each task. If it returns
   `pending`, call it again with the same `request_id`; if `blocked`, its dependencies are still
   running — start it once they settle; if `refused` or `failed`, treat the phase as failed.
5. **Wait.** Loop `orca_wait({ run_id })` (it returns within ~50 s; a timeout is a checkpoint, not
   a failure). For each `worker_done` that is not marked `replayed` (a replayed one was
   already settled — Orca re-sends a batch until it is acked; skip it):
   - Read the **child plan file**. Only `Status: VERIFIED` counts, whatever the report says.
   - If VERIFIED: `worktree_sync({ plan_slug })` squash-merges the phase into this session's
     branch; then `orca_release({ dispatch_id })`, `worktree_abandon({ plan_slug })` (for an
     adopted worktree this _releases_ it: slot freed, seeded files removed, nothing deleted) and
     `orca_remove_worktree({ path })`.
   - Otherwise treat it as a failed phase (below).
     Then `orca_ack({ delivery_id })` before the next `orca_wait` (an un-acked batch is re-sent). Start
     any task that has become ready.
6. **Stalls.** If `orca_wait` reports a stall (the worker's agent exited, hit a login error, or went
   idle without reporting): `orca_stop({ dispatch_id, evidence_id })`, then handle it as a failed
   phase and ask the user. Never stop, release or remove a worker on anything weaker than a
   reported stall.
7. The wave is done when every task in it has settled; update progress (Step 4) and continue.

**Resuming** in a new session: a Run is bound to the terminal that created it. Pass the Run's
id (`run_id`, from the earlier `orca_dispatch` reply) to `orca_dispatch` to bind it to this
terminal before waiting on it; otherwise `orca_wait` reports `consumer_fenced`.

**On Skip or Stop** for a failed phase, still release its worktree through Sentinal
(`worktree_abandon`) before `orca_remove_worktree`, so no slot stays reserved. On Retry, dispatch
the phase again (a new task) into the same prepared worktree with `worktree: { path }`.

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
2. **Read each child plan's `Status:` field from the child FILE.**
   ⛔ Never set a checkbox from what a subagent reported. The report is prose; the child file is the
   record `spec-verify` actually writes. Setting `— VERIFIED` from a report is how a master comes to
   claim phases that were never verified, and Step 3.1 then selects the next wave from those same
   checkboxes, so one bad report also corrupts resumption.
3. Update `## Progress Tracking` checkboxes **to match the child files**:
   - `- [x] Phase N: Title (Wave M) — VERIFIED` — only when that child's file reads `Status: VERIFIED`
   - `- [ ] Phase N: Title (Wave M) — <STATUS>` — for every other status, including `COMPLETE`, which
     means implemented and awaiting verification
4. Update counts: `**Total Phases:** N | **Completed:** K | **Remaining:** N-K`
5. **Confirm the result reconciles** with `spec_master_audit({ plan_path: "<master-plan-path>" })`. Any
   `must_fix` it reports is a disagreement you just wrote, or one you failed to clear — resolve it
   before starting the next wave.

---

## Step 5: Completion

When ALL waves are complete (all child plans VERIFIED):

1. Set master plan `Status: COMPLETE`
2. Use `spec_register` MCP tool with `status: "COMPLETE"`
3. **Chain to verification:** Load `Skill(skill='spec-verify', args='<master-plan-path>')`

The verification phase for master plans checks, in `spec-verify` **Step 0b**:

- All child plans are VERIFIED — via `spec_master_audit`, which resolves children by their `Parent:`
  back-link and treats a child/checkbox disagreement in either direction as a finding
- No regression between phases (one full-suite run over the merged result)
- Overall goal is achieved (the master's own `## Definition of Done`, audited against the tree)

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
