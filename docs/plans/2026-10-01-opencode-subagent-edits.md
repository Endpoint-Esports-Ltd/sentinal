# OpenCode Subagent Edit Permissions (spec-task agent + doc allowances) Implementation Plan

Created: 2026-10-01
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Summary

**Goal:** Sentinal's OpenCode subagents stop asking "Permission required — Edit …" during
`/spec` work. This is options 1 and 2, chosen by the user on 2026-10-01:

1. The shipped top-level `edit` allowances add `.sentinal/rules/**`, `.sentinal/skills/**` and
   `docs/**` (today only `docs/plans/**`), so documentation edits by any agent stop prompting.
2. A new Sentinal agent, **`spec-task`** (`targets/opencode/agents/spec-task.md`), with
   `edit: "*": allow`, is used **only** by Sentinal's wave execution: `spec-implement`'s parallel
   tasks and `spec-master-execute`'s child-plan subagents, instead of `general`. `general` keeps
   the user's top-level `ask`.

**Why:** in the user's config (written from `targets/opencode/opencode.json`), `general` has no
agent rules, so it falls back to the top-level `edit: {"*": "ask", docs/plans: allow}`.
`build`'s `"*": "allow"` is not inherited; a probe on 2026-10-01 showed the subagent's rule list
stopping before it. "Allow always" lasts for one session only, and each subagent is a new
session.

**Architecture:** prose and config only, plus one installer test. Claude Code is unaffected:
its waves use `Agent(isolation="worktree")`, which runs in the parent's permission mode.

## Scope

### In Scope

- `targets/opencode/opencode.json`: top-level `permission.edit` gains `".sentinal/rules/**":
  "allow"`, `".sentinal/skills/**": "allow"` and `"docs/**": "allow"`. The `plan` agent's own
  edit block gains the same entries, so plan mode can also update rules and docs. The installer
  merges these into existing configs additively (`deepMergeAdditive`), so a re-install adds the
  keys and keeps the user's values.
- `targets/opencode/agents/spec-task.md`: `mode: subagent`; a description saying it is
  Sentinal's wave-task executor; `permission`: `edit: {"*": "allow"}`, `bash` inherited (no
  override), and `task`: `explore` / `general` / `spec-task` / `plan-reviewer` /
  `spec-reviewer` allowed, because a child-plan subagent runs `/spec` and starts its own wave
  subagents and reviewers. `skill: allow`.
- `targets/opencode/skills/spec-implement/SKILL.md` (constraints line + the wave `Task(...)`)
  and `targets/opencode/skills/spec-master-execute/SKILL.md` (the subagent spawn):
  `subagent_type="spec-task"`. Each adds one sentence: "`spec-task` edits without prompts;
  the plan's per-task file lists and the same-wave no-overlap rule keep tasks apart."
- The `build` agent's `task` permission in the shipped config allows `spec-task`.
- **Worker access (the previous plan):** `WORKER_AGENTS` in `src/orca/worker-access.ts` adds
  `spec-task`, so an Orca worker's `spec-task` subagents keep the read-only denies for the
  coordinator and main checkouts.
- Tests:
  - `src/cli/target-assets.test.ts`: `spec-task.md` exists with `mode: subagent` and
    `edit "*": allow`; `opencode.json` has the three allowances; no OpenCode prose still spawns
    `general` for wave tasks.
  - `src/orca/worker-access.test.ts`: the deny also appears under `spec-task`.
- Parity regenerated once; `embed-assets`.
- Dev docs: `.sentinal/rules/sentinal-project.md` (one sentence) and
  `sentinal-targets-vs-src.md`, if it lists the agents.
- A live check: an OpenCode `Task(subagent_type="spec-task")` edit in this repo gets no prompt,
  and a `general` edit outside the allowances still prompts.

### Out of Scope

- Changing what `general` may do.
- Claude Code permissions.
- Narrowing `spec-task` to a task's own files: OpenCode can't express per-task paths.

## Context for Implementer

- Shipped config: `targets/opencode/opencode.json:6-55` (`permission`, `agent.build`,
  `agent.plan`).
- Installer merge: `src/cli/commands/install-opencode-config.ts` (`deepMergeAdditive` for
  `permission`; agent blocks merge the same way, so check `agentConfig` handling). Agents are
  installed as flat files from `targets/opencode/agents/` (`install-opencode.ts:225`, embedded
  as `EMBEDDED_OC_AGENTS` by `embed-assets`).
- Existing agent format: `targets/opencode/agents/spec-reviewer.md` (frontmatter with
  `mode: subagent`, `permission`).
- Parity: the `subagent_type="general"` lines are already OpenCode-only lines in the existing
  `spec-implement.diff` / `spec-master-execute.diff` hunks, so the hunk counts should not change.
- Gotchas: TDD for `worker-access.ts`; prose files are exempt.

## Assumptions

- OpenCode loads `~/.config/opencode/agents/spec-task.md` and `Task(subagent_type="spec-task")`
  resolves it (the same mechanism as `spec-reviewer`). Tasks 2 and 4 depend on this.
- A subagent's own `permission.edit` replaces the top-level `ask` for that agent; the last
  matching rule wins, and agent rules come last. Task 4 verifies it live.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| `spec-task` edits outside its task's files | Low | Unintended changes | Same as today's build agent; the plan's file lists, same-wave no-overlap, TDD guard and spec review |
| Existing installs keep `general` until re-install | High | Prompts continue | The installer copies the agent and merges config on `sentinal install opencode`; the release note says to re-install |
| Worker denies don't reach `spec-task` | Low | A worker edits the main checkout | `WORKER_AGENTS` includes `spec-task`; unit test |

## Execution Waves

**Wave 1:** Task 1 (config + agent + worker-access list + tests).
**Wave 2:** Task 2 (prose + parity + embed) and Task 3 (dev docs), on disjoint files.
**Wave 3:** Task 4 (re-install locally + live check).

## Goal Verification

### Truths

1. `targets/opencode/agents/spec-task.md` exists with `mode: subagent` and `"*": allow` under
   `edit`.
2. `targets/opencode/opencode.json` `permission.edit` has `.sentinal/rules/**`,
   `.sentinal/skills/**` and `docs/**` set to `allow`.
3. `rg -n 'subagent_type="general"' targets/opencode/skills/spec-implement
   targets/opencode/skills/spec-master-execute` is empty.
4. `WORKER_AGENTS` includes `spec-task`, and the worker-access test asserts the deny there.
5. Live: a `spec-task` edit of a `src/` file gets no prompt.

## Progress Tracking

- [x] Task 1: Config, `spec-task` agent, worker-access list, tests (Wave 1)
- [x] Task 2: OpenCode prose uses `spec-task` + parity + embed (Wave 2)
- [x] Task 3: Dev docs (Wave 2)
- [x] Task 4: Re-install locally + live check (Wave 3)

**Total Tasks:** 4 | **Completed:** 4 | **Remaining:** 0

## Live Verification

Task 4, 2026-10-01, OpenCode 1.18.34. The user's `~/.config/opencode` was updated with the
shipped permission and agent keys (merged with the installer's `deepMergeAdditive`; every other
key unchanged) and `agents/spec-task.md`. Backup:
`~/.config/opencode/opencode.jsonc.pre-spec-task-20261002-132254`. Fresh OpenCode sessions ran in
throwaway Orca worktrees (`agent-probe`, `agent-probe2`, both removed).

| Case | Prompt | File written |
| ---- | ------ | ------------ |
| `spec-task` subagent writes `src/agent-probe-a.json` | ✅ none | ✅ yes |
| `general` subagent writes `.sentinal/rules/agent-probe.md` (doc allowance) | ✅ none | ✅ yes |
| `general` subagent writes `src/agent-probe-b.json` (control) | ✅ prompted, as intended | — |

**Note:** a `spec-task` write of a `.ts` implementation file with no test was refused by
Sentinal's TDD guard rather than prompting. The permission passed and the guard did its job; real
wave tasks write the test first.

## Implementation Tasks

### Task 1: Config, agent, worker-access list

**Dependencies:** None
**Wave:** 1

**Files:** `targets/opencode/opencode.json`; `targets/opencode/agents/spec-task.md` (new);
`src/orca/worker-access.ts` and its test; `src/cli/target-assets.test.ts`.

**Definition of Done:**

- [ ] Truths 1, 2 and 4 hold; `bun test src/cli/target-assets.test.ts src/orca/worker-access.test.ts`
      passes.

### Task 2: Prose

**Dependencies:** Task 1
**Wave:** 2

**Files:** `targets/opencode/skills/spec-implement/SKILL.md`,
`targets/opencode/skills/spec-master-execute/SKILL.md`; one parity regeneration;
`embed-assets`.

**Definition of Done:**

- [ ] Truth 3 holds; hunk counts are unchanged; `bun test src/cli/` passes.

### Task 3: Dev docs

**Dependencies:** Task 1
**Wave:** 2

**Files:** `.sentinal/rules/sentinal-project.md`, and `.sentinal/rules/sentinal-targets-vs-src.md`
if it lists the shipped agents.

**Definition of Done:**

- [ ] `bunx prettier --check` passes on the touched files.

### Task 4: Live check

**Dependencies:** Tasks 1–3
**Wave:** 3

Run `bun run deploy:opencode` (or `sentinal install opencode` from the source tree) so the user's
config gains the allowances and `spec-task.md`, keeping a backup of
`~/.config/opencode/opencode.jsonc` first. Then, in a fresh OpenCode session in a throwaway
worktree of this repo:

- `Task(subagent_type="spec-task")` edits a `src/` file → no prompt;
- `general` edits `.sentinal/rules/x.md` → no prompt;
- `general` edits a `src/` file → prompts (unchanged behaviour).

Record the results and clean up.

**Definition of Done:**

- [ ] All three results are recorded, the backup path is noted, and no throwaway files remain.
