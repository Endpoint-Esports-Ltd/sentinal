# Cross-Repo Master Plans

Created: 2026-11-05
Status: VERIFIED
Approved: Yes
Iterations: 1
Worktree: No
Type: Feature
Parent: 2026-11-05-cross-project-scope
Wave: 3

## Summary

**Goal:** A master plan in one project (e.g. ops) can run each phase in a worktree of the repo
that phase changes — Orca workers when available, subagents otherwise — with the child plan
living in that repo, a merge into that repo's base branch, and `spec_master_audit` finding it.
**Architecture:** A phase whose child plan carries `Repo: <path>` is **foreign**. Its child plan
is written at planning time as a **seed** in the master's `docs/plans/` (same filename and
`Parent:` link as today), so it can be planned and approved before any worktree exists. At
execution the coordinator creates the phase worktree in the foreign repo (Orca
`worktree create --repo path:<repo> --no-parent`, or `worktree_create(project=<repo>)`), copies
the seed into `<worktree>/docs/plans/`, records the copy's path in the seed (`Location:`), and
starts the worker there. The audit follows `Location:` to read the real status; after the merge
the coordinator points `Location:` at `<repo>/docs/plans/<file>` and mirrors the final status
onto the seed.
**Tech Stack:** TypeScript, Bun, Orca CLI 1.4.253, MCP, shipped skill/command prose.
**Master plan:** `docs/plans/2026-11-05-cross-project-scope.md` (Context → decision 6,
"Cross-repo child linkage", "Orca `--repo` / `--no-parent` are unverified"). **Depends on
Phases 1–2**: workers in a foreign worktree then get that repo's rules, memory and TDD scoping
natively (their cwd is that repo), and an ops coordinator touching foreign files is scoped by the
resolver.

## Scope

### In Scope

- Plan headers `Repo:`, `Base:`, `Master:`, `Location:` (parser + `spec_plan_parse` output).
- `orca_dispatch` task field `repo`; `prepareChildWorktree` passes `--repo path:<repo>
  --no-parent` (and never `--parent-worktree`) for a foreign repo; a clear error when Orca does
  not know the repo (`orca repo add`).
- `spec_master_audit` follows `Location:` for foreign children (verifies the copy's `Parent:` and
  `Master:`), reports the repo, and flags a seed/location status disagreement.
- Shipped `spec-master-plan` and `spec-master-execute` (both targets) for foreign phases, Orca and
  non-Orca paths; README; dev rules + `sentinal-orca-cli` skill.

### Out of Scope

- Repos that are not git repos, or remote/Orca-host repos (`--project`/`--host`).
- Auto-registering repos in Orca (`orca repo add` is reported, not run, since it changes the
  user's Orca setup).
- Changing `worktree_ensure` / `worktree_sync` (they already take `project`; verified below).

## Context for Implementer

- **Verified Orca CLI (1.4.253, `orca worktree create --help`):** `--repo <selector>` accepts
  `path:<path>` (also `id:`/`name:`); `--no-parent` forces no lineage; `--parent-worktree` and
  `--no-parent` express lineage; "If `--repo` is omitted, Orca infers the repo from the current
  Orca-managed worktree"; `--setup run|skip|inherit`. Orca only knows repos in `orca repo list`
  (`orca repo add` registers one). **Not yet verified:** the JSON shape returned for a foreign
  repo, the error for an unregistered repo, and whether `--no-parent` combines with
  `--setup skip` — Task 1 records these live.
- **Current code:** `prepareChildWorktree` (`src/orca/dispatch.ts:174-211`) runs
  `worktree create --name --base-branch --parent-worktree <parent ?? "current"> --setup skip`,
  then falls back to   `worktree show --worktree name:<name>` when the result has no path —
  ⛔ that fallback is ambiguous across repos: for a foreign repo use `worktree list --json` and
  select the entry whose path is under the target repo's worktree area and whose name matches
  (worktree ids are `<repo-id>::<path>`, `dispatch-core.ts:42`), never a bare name lookup. The only caller is
  `src/orca/mcp-tools.ts:307-319`; schema `dispatchTaskSchema` at `:142-160`; `prepare-child`
  requires `name` + `base_branch` (`:174-178`).
- **Adopt / merge already take `project`:** `worktree_ensure({plan_slug, path, base, owner:
  "external", project: <repo>})` validates the path is a worktree of `project`'s repo
  (`src/worktree/adopt.ts:251-257`), runs that repo's `.sentinal/runtime.json` `setup`.
  `worktree_sync({plan_slug, project: <repo>})` merges in the checkout holding the base branch,
  else the repo's main checkout, and refuses a dirty one (`DIRTY_MAIN_CHECKOUT`). So a foreign
  merge lands on **the user's repo checkout** — the prose must say so and tell the coordinator to
  check it is clean and on the base branch first.
- **Plan headers** (`src/spec/parser-header.ts:36-37` regex list; `RawMetadata`; surfaced via
  `src/spec/parser.ts:63` and `spec_plan_parse`):
  - `Repo:` — absolute path, or a `related.json` name (Phase 2 `loadRelatedProjects`), of the
    repo the phase changes. Absent = the master's repo (today's behaviour).
  - `Base:` — base branch in that repo (default: the branch checked out in its main checkout).
  - `Master:` — the master plan's path **relative to its own repo root** (e.g.
    `docs/plans/2026-11-05-x.md`), written into the **copy**. Informational only (never compared
    as an absolute path: a coordinator in a linked/Orca worktree would write a worktree path, and
    absolute paths committed into another repo are machine-specific).
  - `Location:` — where the live child plan is, written into the **seed** by the coordinator:
    an **absolute** path while the phase runs (inside its worktree), then, after the merge, the
    path **relative to the seed's `Repo:`** (`docs/plans/<file>`), so the committed seed stays
    portable for teammates (`Repo:` itself should be a `related.json` name or a path relative to
    the master repo when possible).
  - **Authority:** the seed → `Location:` direction is the link. The copy's `Parent:` must equal
    the master slug (a finding otherwise); `Master:` is not checked.
  Add them to the `Key: Value` regex and the metadata type; keep the bold legacy format as is.
- **Audit** (`src/spec/master-audit.ts`, direct-fs, no deps — keep it so; see
  `.sentinal/rules/sentinal-mcp-servers.md` § `spec_master_audit`): in `resolveChildPlans`, for a
  child whose seed has `Repo:` **and** `Location:`, resolve `Location:` (absolute, or relative
  to the seed's `Repo:` — a `Repo:` that is a `related.json` name is resolved with Phase 2's
  `loadRelatedProjects(<master workspace>)`, a relative path against the master's workspace),
  read status from it when that file exists and its `Parent:` equals the master slug; otherwise
  report a finding (`foreign-location-missing` / `foreign-link-mismatch`).
  A seed with `Repo:` but no `Location:` uses the seed's own status (not started). When both
  exist and the seed's status differs from the location's, add `foreign-status-disagrees`
  (the coordinator mirrors the final status). Report `repo` per child in the table. Never scan
  another repo's `docs/plans` by slug.
- **Prose** — `targets/opencode/skills/spec-master-plan/SKILL.md` +
  `targets/claude-code/commands/spec-master-plan.md` (`spec-master-plan.diff` MUST stay 0 bytes:
  edit both identically) and `targets/opencode/skills/spec-master-execute/SKILL.md` +
  `targets/claude-code/commands/spec-master-execute.md` (keep the existing diff unchanged except
  for intended lines). Line refs from exploration: phase table OC `:146-159`, child stub
  `:178-207`; execute Orca Mode `:137-255`, dispatch `:151-174`, adopt `:176-180`, start `:181`,
  merge `:198-205` (CC files are +3 lines).
  - **Planning:** add an optional `Repo` (and `Base`) column to the phase table; for a foreign
    phase write the seed with `Repo:`/`Base:` headers; suggest repos from `.sentinal/related.json`.
  - **Execution, Orca:** before dispatch, check each foreign repo is in `orca repo list` (else
    stop and ask the user to `orca repo add --path <repo>`), is clean, and its base is known.
    `orca_dispatch` task: `worktree: "prepare-child"`, `repo: <abs path>`, `name`,
    `base_branch: <Base>`. Then `worktree_ensure({…, project: <repo>})`; copy the seed into
    `<path>/docs/plans/` adding `Master: <master path relative to its repo>`, and **commit it in
    the phase worktree** (`git -C <path> add docs/plans/<file> && git -C <path> commit -m
    "docs(spec): add <slug> plan"`) — `worktree_sync` merges only commits, so an uncommitted copy
    would never reach `<repo>/docs/plans/`; write the absolute `Location:` into the seed and
    **commit the seed in the master's checkout immediately** (every seed rewrite is committed at
    once — a dirty master checkout blocks the next same-repo merge); start the worker with the
    copy's path in the brief, and the brief's Constraints say "commit your plan file and its
    `.spec-review.json` with your work". On VERIFIED: `worktree_sync({plan_slug, project:
    <repo>})`, then set the seed's `Location:` to `docs/plans/<file>` (relative to `Repo:`) and
    its `Status:` to the copy's, and commit; then release / abandon (`project: <repo>`) / remove
    as today. On Skip/Stop of a foreign phase set the seed to `Status: CANCELLED` and commit.
  - **Execution, subagents (no Orca):** `worktree_create({plan_slug, project: <repo>})`, same
    copy/commit/`Location:` steps, then run the phase **without worktree isolation of the
    coordinator's repo** (Claude Code: a plain `Agent`/Task subagent, never
    `isolation: "worktree"`, which would create a worktree of the master's repo; OpenCode:
    `spec-task`), briefed with the worktree path and told to use absolute paths and
    `cd <path> && …` for every command. Phase 1's resolver keeps memory/TDD keyed to the repo.
    ⚠️ **Permissions:** editing outside the session directory prompts — OpenCode
    `external_directory` ("Allow always" lasts one session) and Claude Code's working-directory
    rule. The prose tells the coordinator to say so up front and suggests the durable fix:
    OpenCode `"permission": {"external_directory": {"<repo>/**": "allow"}}` in the project's
    `opencode.json`; Claude Code `--add-dir <repo>` or `permissions.additionalDirectories`. Orca
    pre-warmed workers avoid this (their cwd is the foreign worktree; the master plan is
    readable through `orcaWorkerDirs`) — so Orca is the recommended path for foreign phases.
  - **Master repo record:** the seed (in the master's `docs/plans/`) is the record of a phase's
    repo; the master's phase table shows the repo for humans only and is not parsed.
  - Run `spec_master_audit` after each wave as today.
- **Parity:** regenerate baselines once
  (`UPDATE_PARITY_BASELINES=1 bun test src/cli/target-parity.test.ts`), then
  `git diff --stat src/cli/__fixtures__/target-parity/` must show only the intended diff files
  (`spec-master-plan.diff` still 0 bytes). Use the `sentinal-parity-baselines` and
  `sentinal-schema-prose-drift` skills.
- **Gotchas:** never run the real `orca` binary in tests — inject the runner and replay fixtures
  in `src/orca/__fixtures__/` (Task 1 records new ones). `src/orca/mcp-tools.ts` is 333 lines:
  if the change pushes it near 400, move the prepare-child call into `dispatch.ts`. TDD guard
  applies to `src/**`.

## Assumptions

- `worktree_ensure` / `worktree_sync` / `worktree_create` with `project=<repo>` work for a repo
  other than the MCP server's cwd (`adopt.ts:251-257`; `mcp-tools.ts` resolves `project ??
  process.cwd()`) — Tasks 4, 5. Task 1 also smoke-tests `worktree_ensure` with a foreign repo.
- `orca worktree create --repo path:<p> --no-parent --setup skip --json` returns a worktree with
  `path` like the same-repo case — Tasks 1, 2.
- Pre-warmed OpenCode workers can read the coordinator's checkout (the master plan) without a
  prompt (`orcaWorkerDirs`, `src/mcp/server.ts`) — Task 5.

## Testing Strategy

- Live (Task 1, manual, recorded): two throwaway git repos registered in Orca; create, show, and
  remove a worktree in the second from the first; capture JSON into fixtures; then
  `orca repo` cleanup (remove the throwaway repos from Orca if `orca repo` supports removal, else
  document).
- Unit: parser headers; `prepareChildWorktree` argv with/without `repo` (fixture runner);
  `orca_dispatch` schema; audit with temp dirs (seed only, seed + location, link mismatch,
  missing location, status disagreement, merged location).
- Parity test; full suite.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Orca `--repo` behaves differently than assumed | Med | High | Task 1 verifies live first; Task 2 coded against recorded fixtures |
| Foreign merge lands on a dirty or wrong-branch user checkout | Med | High | Prose: pre-flight clean + base check; `worktree_sync` already refuses dirty |
| Seed and copy drift | Med | Med | Audit `foreign-status-disagrees`; coordinator mirrors status |
| Unregistered repo stalls the run | Med | Low | Pre-flight `orca repo list`; ask the user |
| Seed's PENDING status keeps ops "active" for the TDD guard | Low | Low | Master is IN_PROGRESS anyway during execution; seeds mirror final status |

## Pre-Mortem

1. **`worktree show --worktree name:<n>` fallback picks a same-named worktree in the coordinator's
   repo** (Task 2) → Trigger: Task 1's live run shows `create` returning no path for a foreign
   repo.
2. **Audit passes while the foreign child never ran** because the seed was marked VERIFIED by
   hand (Task 4) → Trigger: the test "seed VERIFIED, no Location" passes the audit. (It must fail:
   a seed with `Repo:` and status VERIFIED but no `Location:` is `foreign-location-missing`.)
3. **Parity baseline churn** from editing master prose in one target only (Task 5) → Trigger:
   `spec-master-plan.diff` non-empty after regeneration.

## Execution Waves

**Wave 1** — Facts and format (parallel): Task 1 (live Orca verification, fixtures, skill notes),
Task 3 (plan headers). Disjoint files.
**Wave 2** — Code (parallel): Task 2 (Orca `repo`, depends on Task 1), Task 4 (audit, depends on
Task 3). Disjoint files.
**Wave 3** — Prose + docs: Task 5 (depends on Tasks 2, 4).

## Goal Verification

### Truths

1. `src/orca/__fixtures__/` contains recorded `worktree-create-foreign-repo` JSON from Task 1, and
   `.claude/skills/sentinal-orca-cli/SKILL.md` documents `--repo path:` / `--no-parent` results.
2. A `prepareChildWorktree` test with `repo` asserts argv contains `--repo path:<repo>` and
   `--no-parent` and not `--parent-worktree`; without `repo` the argv is unchanged.
3. `spec_plan_parse` of a plan with `Repo:`/`Base:`/`Master:`/`Location:` returns them.
4. Audit tests: seed+valid Location reads the Location status and reports the repo; seed VERIFIED
   without Location fails (`foreign-location-missing`); a copy whose `Parent:` differs fails
   (`foreign-link-mismatch`).
5. `grep -n "repo:" targets/opencode/skills/spec-master-execute/SKILL.md targets/claude-code/commands/spec-master-execute.md`
   shows the foreign-repo dispatch in both; `spec-master-plan.diff` is 0 bytes.
6. All gates pass: `bun test`, `bun run typecheck`, `bun run typecheck:plugin`, `bun run lint`,
   `bun run format:check`.

### Artifacts

| Artifact | Provides | Exports |
| --- | --- | --- |
| `src/orca/dispatch.ts` | Foreign-repo child worktree | `prepareChildWorktree({repo?})` |
| `src/orca/mcp-tools.ts` | `repo` on dispatch tasks | `orca_dispatch` |
| `src/spec/parser-header.ts` | New headers | `RawMetadata.repo/base/master/location` |
| `src/spec/master-audit.ts` | Foreign child resolution | `resolveChildPlans`, `auditMasterPlan` |
| `targets/*/…/spec-master-{plan,execute}` | Cross-repo workflow prose | — |

### Key Links

| From | To | Via | Pattern |
| --- | --- | --- | --- |
| `src/orca/mcp-tools.ts` | `prepareChildWorktree` | `repo` passthrough | `repo:` |
| `src/orca/dispatch.ts` | Orca CLI | foreign repo selector | `path:\$\{` |
| `src/spec/master-audit.ts` | child copy | `Location:` | `location` |
| `spec-master-execute` prose | `worktree_sync` | foreign merge | `project: <repo>` |

## Progress Tracking

- [x] Task 1: Live Orca verification + fixtures + skill notes (Wave 1)
- [x] Task 3: Plan headers Repo/Base/Master/Location (Wave 1)
- [x] Task 2: orca_dispatch `repo` + prepareChildWorktree `--repo` (Wave 2)
- [x] Task 4: spec_master_audit follows Location (Wave 2)
- [x] Task 5: Master plan/execute prose, parity, README, dev rules (Wave 3)

**Total Tasks:** 5 | **Completed:** 5 | **Remaining:** 0

## Deferred Issues

From the spec review (suggestions, non-blocking):

- A relative `Location:` (after a merge) resolves against `Repo:` as written — normally the
  repo's main checkout. If the base branch is checked out in a linked worktree, the merge lands
  there and the audit reports `foreign-location-missing` until that branch reaches the main
  checkout.
- ✅ **Resolved 2026-11-09** (`docs/plans/2026-11-09-related-main-checkout.md`): a relative `Repo:` now resolves against the master repo's main checkout. Was: it resolved against the master's repo root found by walking up to `.git`; from a
  linked/Orca worktree nested inside the repo (`.orca/worktrees/…`), `../api` points elsewhere
  than from the main checkout. The prose recommends a `related.json` name for this reason.

Done from the review: the audit's resolver was renamed `resolveSeedRepo` (it clashed with
`src/orca/dispatch-worktree.ts` `resolveRepoDir`), and an unreadable `Location:` now names a
missing repo directory.

## Implementation Tasks

### Task 1: Live Orca verification + fixtures + skill notes

**Objective:** Establish how Orca behaves for a worktree in another registered repo.
**Dependencies:** None (Phases 1–2 complete)
**Wave:** 1

**Files:**

- Create: `src/orca/__fixtures__/worktree-create-foreign-repo.json`,
  `src/orca/__fixtures__/worktree-create-unregistered-repo.json` (and any `worktree show` shape
  needed)
- Modify: `.claude/skills/sentinal-orca-cli/SKILL.md`

**Key Decisions / Notes:**

- ⛔ **This changes the user's real Orca app state.** Before anything, ask the user (via the
  question tool, or the coordinator's `ask` as an Orca worker) for permission to register two
  throwaway repos in Orca, and check whether `orca repo` has a removal command
  (`orca repo --help`, `orca repo remove --help`); if repos cannot be removed, say so in the
  question.
- Snapshot first: `orca repo list --json > before-repos.json`, `orca worktree list --json >
  before-wts.json` (in `$TMPDIR`); diff after cleanup and record the diff in the skill notes.
- Two throwaway repos under `$TMPDIR`, created with `git init -b main` and one commit each;
  `orca repo add --path` them; **every** create passes both `--repo path:<B>` and `--no-parent`
  (an omitted `--repo` would infer this real repo): `orca worktree create --repo path:<B>
  --name sentinal-repo-probe --no-parent --setup skip --base-branch main --json`. Also try an
  unregistered repo (expect an error) and `--no-parent` with `--parent-worktree` (expect a usage
  error). Remove the probe worktree with `orca worktree rm --worktree path:<p>` and the repos
  from Orca if the CLI allows; record anything that could not be cleaned.
- Also smoke-test `worktree_ensure({plan_slug, path, base, owner: "external", project: <B>})`
  via `bun src/cli/index.ts worktree ensure … -p <B>` and record the result.
- Redact nothing sensitive is expected; still check fixtures for tokens/paths under `$HOME`.

**Definition of Done:**

- [ ] Truth 1; fixtures are real captured output (not hand-written)
- [ ] Skill documents: selector forms, `--no-parent` behaviour, unregistered-repo error,
      `worktree show` disambiguation, cleanup

**Verify:**

- `ls src/orca/__fixtures__/worktree-create-foreign-repo.json && grep -n "\-\-repo" .claude/skills/sentinal-orca-cli/SKILL.md`

### Task 3: Plan headers Repo/Base/Master/Location

**Objective:** Plans can declare a foreign repo and the audit can follow a copy.
**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `src/spec/parser-header.ts`, `src/spec/parser.ts`, `src/spec/types.ts` (if the parsed
  spec type needs the fields)
- Test: `src/spec/parser.test.ts` (or `parser-header.test.ts` if it exists)

**Key Decisions / Notes:** Context → Plan headers. `Repo:` stays a raw string (resolution of a
`related.json` name happens in prose / audit, not the parser). `spec_plan_parse` output includes
the fields when present.

**Definition of Done:**

- [ ] Truth 3; existing parser tests and the parser corpus test (`src/spec/parser.test.ts`
      "spec-parser corpus") unchanged

**Verify:**

- `bun test src/spec/`

### Task 2: orca_dispatch `repo` + prepareChildWorktree `--repo`

**Objective:** Orca child worktrees can be created in another repo.
**Dependencies:** Task 1
**Wave:** 2

**Files:**

- Modify: `src/orca/dispatch.ts`, `src/orca/mcp-tools.ts`
- Test: `src/orca/mcp-tools.test.ts`, `src/orca/dispatch.test.ts` (create if absent)

**Key Decisions / Notes:**

- Schema: `repo: z.string().optional().describe("prepare-child: absolute path of another repo
  to create the worktree in (must be registered in Orca)")`; validate absolute + exists.
- argv per Context; `worktree show` fallback disambiguated per Task 1's findings.
- Unregistered-repo error from Orca → a failure message naming `orca repo add --path <repo>`.

**Definition of Done:**

- [ ] Truth 2; unregistered-repo fixture yields the named hint
- [ ] Existing Orca tests unchanged

**Verify:**

- `bun test src/orca/`

### Task 4: spec_master_audit follows Location

**Objective:** The audit verifies foreign children where they actually live.
**Dependencies:** Task 3
**Wave:** 2

**Files:**

- Modify: `src/spec/master-audit.ts`, `src/spec/master-audit-mcp-tools.ts` (table shows repo)
- Create: `src/spec/master-audit-foreign.ts`, `src/spec/master-audit-foreign.test.ts`
- Test: `src/spec/master-audit.test.ts`, `src/spec/master-audit-mcp-tools.test.ts`

**Key Decisions / Notes:** Context → Audit. Stay direct-fs, no store. `master-audit.ts` is 395
lines — move the foreign-resolution helpers to `src/spec/master-audit-foreign.ts` (+ test) to stay
under 400.

**Definition of Done:**

- [ ] Truth 4; all existing audit tests unchanged
- [ ] Relative `Location:` resolved against an absolute `Repo:`, a relative `Repo:` and a
      `related.json` name; a `CANCELLED` seed is reported as excluded (like same-repo children)
- [ ] Review-evidence warning (`no-review-evidence`) looks for `<slug>.spec-review.json` beside
      the **Location** file for foreign children

**Verify:**

- `bun test src/spec/master-audit.test.ts src/spec/master-audit-mcp-tools.test.ts`

### Task 5: Master plan/execute prose, parity, README, dev rules

**Objective:** The shipped workflow uses foreign phases end to end.
**Dependencies:** Tasks 2, 4
**Wave:** 3

**Files:**

- Modify: `targets/opencode/skills/spec-master-plan/SKILL.md`,
  `targets/claude-code/commands/spec-master-plan.md`,
  `targets/opencode/skills/spec-master-execute/SKILL.md`,
  `targets/claude-code/commands/spec-master-execute.md`,
  `src/cli/__fixtures__/target-parity/*` (regenerated), `README.md`,
  `.sentinal/rules/sentinal-mcp-servers.md` (orca_dispatch `repo`, audit foreign children),
  `.sentinal/rules/sentinal-project.md` (Orca orchestration paragraph)

**Key Decisions / Notes:** Context → Prose and Parity. Keep each target's text identical where the
baseline says so.

**Definition of Done:**

- [ ] Truth 5; parity test passes with only intended fixture changes
- [ ] README: "Cross-repo master plans" subsection (Orca + non-Orca, merge lands in the repo's
      checkout, `orca repo add`)
- [ ] Truth 6

**Verify:**

- `bun test src/cli/target-parity.test.ts && bun test && bun run typecheck && bun run typecheck:plugin && bun run lint && bun run format:check`
