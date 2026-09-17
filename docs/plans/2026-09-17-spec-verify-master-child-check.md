# Master Plans Report VERIFIED Without Their Children Being Verified — Fix Plan

Created: 2026-09-17
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Bugfix

## Summary

**Symptom:** A master plan's completion record and its children's actual `Status:` fields can disagree
arbitrarily, in either direction, and nothing detects it. `spec-master-execute` documents that the check
belongs to `spec-verify`; `spec-verify` does not implement it.

**Trigger:** Any master plan run. Live example in this repo:
`docs/plans/2026-04-20-claude-opencode-changelog-audit.md` reads
`**Total Phases:** 5 | **Completed:** 0 | **Remaining:** 5` with all five checkboxes `[ ]`, while its
children are 3× `VERIFIED` and 2× `COMPLETE`.

**Root Cause:** Three defects compound:

1. `targets/opencode/skills/spec-master-execute/SKILL.md:150-154` (and
   `targets/claude-code/commands/spec-master-execute.md:155`) delegate a check to `spec-verify` that
   `spec-verify` never implements — both target copies contain **zero** occurrences of
   `child`, `master`, `parent` or `sub-plan`.
2. `src/spec/mcp-tools.ts` — the master↔child relation is **parsed and persisted but never queried**.
   `Parent:`/`Wave:` are extracted at `src/spec/parser.ts:63-64`, written to SQLite at
   `src/spec/store.ts:161-162` behind migration V9 (`src/memory/migrations.ts:413,429-430`), and there
   is no `WHERE parent = ?` anywhere in the codebase. The sole consumer is a dashboard badge
   (`src/dashboard/views/specifications.ts:77`).
3. `src/spec/detect.ts:44` — `findActivePlan` short-circuits on `type === "master"`. Because a master's
   own task list is empty, `spec_status` (`src/spec/status-mcp-tools.ts:82`) and `spec_init` (`:150`)
   report `0/0 tasks (0%)` and **mask** every child's progress, so the drift is invisible between runs.

Defect 1 is where the symptom appears. Defects 2 and 3 are why it is never noticed.

## Investigation

### The two records, and why nothing reconciles them

| Record                              | Written by                                                               |
| ----------------------------------- | ------------------------------------------------------------------------ |
| a child's `Status:`                 | `spec-verify`, running on that child                                     |
| the master's `- [x] … — VERIFIED`   | `spec-master-execute` Step 4, from **subagent report prose**             |

`spec-master-execute` Step 3.6 reads "All VERIFIED → update master plan checkboxes" — but the VERIFIED
it acts on is what the subagent *said*, never what the child file *says*. Step 3.1 then selects the next
wave's work from those same checkboxes, so a single bad report corrupts resumption too.

### Field evidence — drift occurs in both directions

| Master                                        | Master's own record   | Actual children                  |
| --------------------------------------------- | --------------------- | -------------------------------- |
| `2026-04-20-claude-opencode-changelog-audit`  | `IN_PROGRESS`, 0/5    | 3× `VERIFIED`, 2× `COMPLETE`     |
| `2026-08-07-worktree-runtime-isolation`       | `VERIFIED`, 4/4       | 4× `VERIFIED` (consistent)       |

The live drift is the master lagging *behind* its children — the inverse of the direction PR #11
describes. A check that only looks for children lagging behind the master would not see it.

### Authoritative linkage already exists

Every real child carries an explicit back-link, which slug-globbing does not need to guess:

```
Status: VERIFIED
Type: Feature
Parent: 2026-04-20-claude-opencode-changelog-audit
Wave: 1
```

Globbing `<master-slug>-phase-*.md` instead is strictly worse: it matches
`2026-08-07-worktree-runtime-isolation-phase-1-spike.md`, which carries no `Parent:` and whose metadata
line is prose — `Status: COMPLETE — all three questions answered with evidence.` — so any naive
`grep '^Status:' | sed` yields a sentence that matches no known status and silently passes.

### Only `VERIFIED` may pass

`src/spec/types.ts:12-24` defines **11** statuses. Per the `/spec` dispatch table, `COMPLETE` means
*implemented, awaiting verification* — it routes back into `spec-verify`. So `COMPLETE`, `FAILED`,
`APPROVED`, `PLANNING`, `IMPLEMENTING` and `VERIFYING` must all fail a child check. `CANCELLED` is
terminal-but-not-verified (`types.ts:49-52`) and must be reported as an explicit exclusion rather than
counted as a pass.

### Why this is not fixable in prose

The diagnosis PR #11 offers — "a documented affordance nothing honours" — is correct and it is
self-applying: answering unenforced prose in one markdown file with unenforced prose in another leaves
zero tests able to fail when an agent skips the step. `src/spec/` already holds the parser, the store,
and the persisted relation; the check belongs there, where a regression test can hold it.

### PR #11 disposition

Close and supersede, with a review comment recording: the false suite claim
(PR states `2007 pass / 137 fail / 194 errors` "byte-identical to clean main"; clean `main` at `c4f3950`
is **3159 pass / 0 fail**, exit 0 — likely a missing sqlite-vec preload, see
`.sentinal/rules/sentinal-testing.md`), the incomplete fail-list, the slug-glob discovery, and the
prose-only enforcement. Its parity analysis was correct and is preserved here.

## Behavior Contract

### Fix Property (C => P)

**When condition C holds:** a plan with `Type: Master` is verified, and at least one of the following is
true — (a) a child's `Status:` is anything other than `VERIFIED`; (b) a child's `Status:` disagrees with
the master's Progress Tracking checkbox for that phase, **in either direction**; (c) a file matching
`<master-slug>-phase-*.md` exists with no `Parent:` back-link to the master.

**Property P must hold:** `spec_master_audit` returns a failing result naming the specific child, both
conflicting records, and which of (a)/(b)/(c) fired; `spec-verify` reports it as a `must_fix` and does
**not** set the master to `VERIFIED`.

### Preservation Property (!C => unchanged)

**When condition C does NOT hold:** the plan is not `Type: Master`, or every child is `VERIFIED` and
every checkbox agrees.

**Existing behavior preserved:** `spec-verify` runs byte-identically to today — Step 0b is skipped
entirely for non-master plans. `spec_status`/`spec_init` output for non-master plans is unchanged.
Cross-target parity for every command/skill pair holds at its current baseline.

## Fix Approach

**Files:**

- `src/spec/master-audit.ts` (new) — child resolution + reconciliation, pure functions over `parsePlanFile`
- `src/spec/master-audit.test.ts` (new)
- `src/spec/master-audit-mcp-tools.ts` (new) — registers `spec_master_audit`
- `src/spec/master-audit-mcp-tools.test.ts` (new)
- `src/spec/mcp-tools.ts` — call the new registrar from `registerSpecTools` (~2 lines)
- `src/spec/mcp-tools.registration.test.ts` — assert the tool is registered
- `src/spec/status-mcp-tools.ts` — master-aware aggregate in `spec_status` + `spec_init`
- `targets/claude-code/commands/spec-verify.md`, `targets/opencode/skills/spec-verify/SKILL.md`
- `targets/claude-code/commands/spec-master-execute.md`, `targets/opencode/skills/spec-master-execute/SKILL.md`
- `src/cli/__fixtures__/target-parity/*.diff` — regenerated
- `.sentinal/rules/sentinal-mcp-servers.md`, `README.md` — tool counts

**Strategy:**

Resolve children by scanning the plans dir for `Parent: <master-slug>` — the authoritative link — and
use the `<slug>-phase-*.md` glob only as a **second pass to surface orphans**, so an unlinked or
misnamed file becomes an explicit finding instead of a silent skip. Reconcile each child's parsed
`Status:` against the master's Progress Tracking checkbox and fail on any non-`VERIFIED` status or any
disagreement in either direction; report `CANCELLED` as an explicit exclusion. Then fix the source:
`spec-master-execute` Step 4 sets checkboxes from the child file's `Status:` rather than from subagent
report prose, and `spec_status`/`spec_init` surface the child aggregate so the drift is visible
continuously rather than only at final verification.

⛔ **Direct-fs only — do not add a sidecar route and do not derive state from `store`.** Per
`.opencode/skills/sentinal-sidecar-path-blindness/SKILL.md`, MCP tools receive `store: null` in
production whenever the sidecar is running; a tool built on `store` passes every test and does nothing
in the field — which is the same class of defect this plan fixes. The audit is a stateless read of plan
files derived from the tool's own arguments, so it follows the runtime domain's direct-only precedent
(`.sentinal/rules/sentinal-mcp-servers.md`).

⛔ **`src/spec/mcp-tools.ts` is at 332 lines** — the 400-line warn threshold forbids putting the tool
there. New sibling file, matching the existing `status-mcp-tools.ts` / `events-mcp-tools.ts` split.

⛔ **All four `targets/` edits and the baseline regeneration must stay in one task.** Per
`.opencode/skills/sentinal-parity-baselines/SKILL.md`, `UPDATE_PARITY_BASELINES=1` rewrites the *entire*
fixture directory, so concurrent tasks touching `targets/` silently poison each other's baseline while
the checks still pass. Both target copies of each file must receive a byte-identical body so
`spec-verify.diff` stays 0 bytes and `spec-master-execute.diff` stays at its current 1388 bytes.

⛔ Per `.opencode/skills/sentinal-schema-prose-drift/SKILL.md`, the `spec_master_audit` zod schema and
the literal payload shown in the shipped `spec-verify` prose must be written in the same task.

**Tests:** `src/spec/master-audit.test.ts`, `src/spec/master-audit-mcp-tools.test.ts`,
`src/spec/mcp-tools.registration.test.ts`, `src/spec/status-mcp-tools` coverage,
`src/cli/target-parity.test.ts`.

**Defense-in-depth:**

| Layer                                   | Purpose                                                                 |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `spec-master-execute` Step 4 (source)   | Never write a checkbox that the child file does not support             |
| `spec_master_audit` (detection)         | Fail verification on any non-`VERIFIED` child or any disagreement       |
| `spec_status` / `spec_init` (visibility)| Surface child aggregate continuously, so drift cannot sit unobserved    |

## Progress

- [x] Task 1: Core master/child reconciliation logic
- [x] Task 2: `spec_master_audit` MCP tool
- [x] Task 3: Master-aware `spec_status` / `spec_init`
- [x] Task 4: Wire both targets + regenerate parity baselines + doc counts
- [x] Task 5: Verify
      **Tasks:** 5 | **Done:** 5 | **Left:** 0

## Verification Results

| Check                              | Result                                                              |
| ---------------------------------- | ------------------------------------------------------------------- |
| Full suite (clean `main` baseline) | 3159 pass / 0 fail, exit 0                                          |
| Full suite (after)                 | **3197 pass / 0 fail, exit 0** — +38 tests, zero regressions        |
| `npx tsc --noEmit`                 | clean                                                               |
| `bun run build:all`                | both targets build, exit 0                                          |
| Parity hunk counts                 | unchanged on every pair; `spec-verify.diff` still **0 bytes**       |
| `spec-master-execute.diff`         | 3 hunks / 1388 bytes — unchanged; only the `@@` offset shifted      |
| Cross-target raw diff              | `spec-verify` 24 lines, `spec-master-execute` 29 — both as at HEAD  |
| End-to-end via real MCP `Client`   | `spec_master_audit` advertised and correct with `store: null`       |

### Behavior Contract audit

| Property                                  | Proving test                                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| C(a) non-VERIFIED child → fail            | `it.each` over all 9 non-terminal statuses; plus the `COMPLETE`-child-with-unchecked-box case            |
| C(b) disagreement, master-ahead           | "master claims VERIFIED but the child reads PENDING"                                                     |
| C(b) disagreement, child-ahead            | "child is VERIFIED but the master checkbox is unchecked" — the live direction                            |
| C(c) orphan                               | "should FAIL on an orphan rather than silently skipping it"                                              |
| P: reported as must_fix, blocks VERIFIED  | `spec_master_audit` renders `FAIL` + `must_fix`; Step 0b prose forbids setting VERIFIED while any stands |
| !C non-master unchanged                   | `spec_status`/`spec_init` preservation tests; `auditMasterPlan` throws on non-master                     |
| !C all-verified-and-agreeing passes       | "should pass when every child is VERIFIED and every checkbox agrees"                                     |
| !C shipped prose parity unchanged         | `spec-verify.diff` still 0 bytes; all 12 fixtures at their pre-edit hunk counts and byte sizes           |

⛔ A `prettier --write` on `README.md` reformatted ~140 unrelated lines, because the repo is not
prettier-clean at HEAD. Reverted and re-applied surgically — README is now a 6-line diff. Noted here
because the same trap applies to any future doc-count bump.

Run against the repo's two real masters, the tool reports exactly the diagnosed drift:
`2026-04-20-claude-opencode-changelog-audit` → FAIL, 3/5, two `COMPLETE` children plus three
checkbox disagreements in the child-ahead-of-master direction;
`2026-08-07-worktree-runtime-isolation` → 4/4 VERIFIED but FAIL on the `-phase-1-spike` orphan,
whose prose `Status:` line a slug-glob check would have passed silently.

## Deferred Issues

- **No ESLint config in the repo.** `quality_report`'s eslint check returns garbled
  output ("Oops! Something went wrong!") because there is no `eslint.config.*` and no
  `lint` script in `package.json`. Pre-existing and unrelated to this plan; `tsc --noEmit`
  and `prettier` both run clean. Verification used tsc + prettier + `bun test`.
- **The live drift itself is left intact, deliberately.** `…changelog-audit` phases 4 and 5 are
  genuinely `COMPLETE` and not verified — marking them `VERIFIED` to silence the new audit would
  reproduce the exact defect this plan fixes. They need a real `/spec` verification run. Likewise
  `…worktree-runtime-isolation-phase-1-spike.md` should gain a `Parent:` link or be renamed off the
  `-phase-N` convention. Both are pre-existing plan state, not regressions from this change.
- **PR #11 to be closed as superseded**, with its six findings recorded in a review comment.

## Tasks

### Task 1: Core master/child reconciliation logic

**Objective:** `src/spec/master-audit.ts` — resolve children via `Parent:`, detect orphans via the phase
glob, parse the master's Progress Tracking checkboxes, and reconcile. Only `VERIFIED` passes;
`CANCELLED` is reported as an explicit exclusion; disagreement is detected in **both** directions.
**Files:** `src/spec/master-audit.ts`, `src/spec/master-audit.test.ts`
**TDD:** Write failing tests first, using the repo's real plans as fixtures — the `COMPLETE` children of
`2026-04-20-claude-opencode-changelog-audit` (must FAIL) and the consistent
`2026-08-07-worktree-runtime-isolation` tree (must PASS), plus the `-phase-1-spike.md` prose-status file
(must be reported as an orphan, never silently passed).
**Verify:** `bun test src/spec/master-audit.test.ts`

### Task 2: `spec_master_audit` MCP tool

**Objective:** Register the tool in a new `src/spec/master-audit-mcp-tools.ts`, called from
`registerSpecTools`. Direct-fs; ignore `store`.
**Files:** `src/spec/master-audit-mcp-tools.ts`, `src/spec/master-audit-mcp-tools.test.ts`,
`src/spec/mcp-tools.ts`, `src/spec/mcp-tools.registration.test.ts`
**TDD:** Test registration, the failing-audit output shape, and that the tool works with `store: null`.
**Verify:** `bun test src/spec/`

### Task 3: Master-aware `spec_status` / `spec_init`

**Objective:** When the active plan is `Type: Master`, report the child aggregate (N/M VERIFIED, plus any
disagreement) instead of the master's own misleading `0/0 tasks (0%)`. Non-master output unchanged.
**Files:** `src/spec/status-mcp-tools.ts` + its tests
**TDD:** Assert the master aggregate renders, and assert byte-identical output for a feature plan.
**Verify:** `bun test src/spec/`

### Task 4: Wire both targets + regenerate parity baselines + doc counts

**Objective:** `spec-verify` gains a Step 0b that **calls `spec_master_audit`** (no inline shell glob).
`spec-master-execute` Step 4 sets checkboxes from the child file's `Status:`, not from subagent prose.
Both targets receive byte-identical bodies. Update the tool counts (36→37 total, Spec domain 9→10) in
`.sentinal/rules/sentinal-mcp-servers.md` **and** `README.md` — they drift independently.
**Files:** the four `targets/` files, `src/cli/__fixtures__/target-parity/*.diff`,
`.sentinal/rules/sentinal-mcp-servers.md`, `README.md`
**Verify:** `bun test src/cli/target-parity.test.ts` — and confirm `spec-verify.diff` is still 0 bytes
and `spec-master-execute.diff` still 1388 bytes before regenerating anything.

### Task 5: Verify

**Objective:** Full suite + quality checks, and run the new audit against both real master plans in
`docs/plans/` to confirm it reports the known live drift.
**Verify:** `bun test && bun run build:all` — the suite must return **3159+ pass / 0 fail**, matching the
measured clean-`main` baseline at `c4f3950`. Any nonzero failure count is a regression, not a
pre-existing condition.
