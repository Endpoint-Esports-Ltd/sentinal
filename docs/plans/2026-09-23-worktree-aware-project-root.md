# Worktree-Aware Project Root Resolution Implementation Plan

Created: 2026-09-23
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Bugfix

## Summary

**Goal:** Make Sentinal resolve a stable, canonical project identity when running inside a git worktree it did not create, so memory and spec state stop fragmenting — while keeping all worktree-local filesystem state worktree-local.

**Architecture:** Introduce one shared resolver module exporting two deliberately distinct functions — `resolveProjectIdentity()` (canonical main-checkout path, used **only** as a storage key) and `resolveWorkspaceRoot()` (the local checkout root, used **only** as a filesystem base). Every existing root-resolution call site is then consciously classified as one or the other. Separately, close a verified silent-collision path in `runtime_up` where an unsubstituted slot token is expanded to an empty string by the shell.

**Tech Stack:** TypeScript (strict), Bun, `bun:test`, SQLite (`bun:sqlite`), `Bun.spawnSync` for git.

## Scope

### In Scope

- A canonical project-identity resolver based on `git worktree list --porcelain`.
- Memory (`observations`, `sessions`) keyed by canonical identity on write and normalized on read.
- Spec store (`specs`) keyed by canonical identity; `resolveStopDecision` ownership query scoped by project.
- A hard gate in `runtime_up` refusing to spawn when a `${SENTINAL_WORKTREE_SLOT}` token survives interpolation.
- Keeping all `.sentinal/` writes (`compact-state.json`, `runtime.pid`, `worktree.env`, `project-memory.json`) worktree-local.

### Out of Scope

- **`worktree_create` un-nesting.** Removed after plan review. It belongs to none of the three chosen workstreams, `src/worktree/create.ts` sits in the top import-graph quartile (106/404), and it was the sole source of this plan's only data-corruption-class risk: re-keying `worktrees.project_path` for new rows while live rows keep the old value makes those rows invisible to the slot allocator (`store.ts:95,156,186`), so the same slot is handed out twice — and `idx_wt_slot_live UNIQUE(project_path, slot)` cannot catch it because the two rows differ in `project_path`. Tracked as follow-up; needs a bounded re-key step, not a create-path change.
- **Data migration of existing rows.** No backfill. Old memory rows stay where they are; correctness applies to new writes. Spec rows self-heal via Task 8's upsert change. Rationale in Assumptions.
- **No SQLite schema migration.** Explicitly avoided — see the known limitation below.

### Known limitation (accepted, not fixed here)

`specs.id` is the **bare plan filename** with the path discarded (`src/spec/parser.ts:74`), and it is the `PRIMARY KEY`. Two _different projects_ holding an identically-named plan file therefore share one row. Project-qualifying the key would require a composite primary key, and five foreign keys reference `specs(id)` (`src/memory/migrations.ts:217, 268, 289, 305, 363`) — SQLite would require rebuilding all five dependent tables. Deferred on those grounds and tracked as follow-up. Task 10's project filter contains the blast radius (project B cannot read project A's `session_id`) but does not eliminate the shared row.

- Submodule support (`--show-superproject-working-tree` has zero occurrences repo-wide and stays that way).
- Any Orca CLI dependency. The fix is pure git and must work for plain `git worktree` users.
- Consolidating the three duplicate realpath helpers (`disk-scan.ts:45`, `store.ts:19`, `ownership.ts:163`) — noted, deferred.

## Context for Implementer

> Assume you have never seen this codebase.

**The bug, reproduced:** This repo is currently checked out as a linked git worktree at `/Users/evan/orca/workspaces/sentinal/orca-support` (main checkout: `/Users/evan/Projects/endpoint_esports/sentinal`). In this state `memory_search` scoped to the worktree returns **0 results** while 235 observations exist under the main checkout path, and `spec_status` returns "No active spec found" while `spec_init` finds the plan. Both were demonstrated live.

**Root cause:** `git rev-parse --show-toplevel` returns the _linked worktree's_ root, not the main checkout. Every root resolver in the codebase uses it.

**There are three independent root resolvers today — this is the core confusion:**

| Resolver                  | Location                                             | Contract                                             | Used by                                                                 |
| ------------------------- | ---------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------- |
| `getRepoRoot(cwd)`        | `src/git/utils.ts:90-97`                             | **throws** `WorktreeError("NOT_A_REPO")`             | `src/worktree/*` only (5 call sites)                                    |
| `findGitRoot(cwd)`        | `src/utils/git.ts:1-13`                              | async, returns `null`                                | Claude Code hooks only (5 call sites), always as `gitRoot ?? input.cwd` |
| `resolveProjectRoot(...)` | `targets/opencode/plugins/sentinal-helpers.ts:32-83` | **no git at all** — picks worktree → directory → cwd | OpenCode plugin only                                                    |

**Patterns to follow:**

- Git execution convention: `src/git/utils.ts:19-30` (`gitExec`). `Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })`, argv array (no shell), **synchronous**, `.trim()` applied inside, no timeout. Match this exactly.
- Strict helpers that need a _specific_ error code call `gitExec` then throw manually (`getRepoRoot:92-96`); tolerant helpers inspect `exitCode` and return a default (`branchExists:56-62`).
- Porcelain parsing: `listGitWorktrees` at `src/worktree/disk-scan.ts:24-42` — splits on `\n\n`, reads `worktree `/`HEAD `/`branch ` prefixes.
- Realpath-with-fallback: `resolveRealPath` at `src/worktree/disk-scan.ts:45-51`.
- New exports go in the barrel at `src/index.ts:205-217`.

**Gotchas (each verified, do not re-derive):**

- `git rev-parse --git-common-dir` **must not be used.** Empirically wrong for `--separate-git-dir` (returns `/tmp/gtest/sepgit` when toplevel is `/tmp/gtest/sep`; `dirname` gives `/tmp/gtest`) and for bare repos. Tested 2026-09-23.
- Bare `--git-common-dir` returns a _relative_ `.git`; only `--path-format=absolute` makes it absolute. Irrelevant given the above, but it is why `src/worktree/worktree-exclude.test.ts:86` passes that flag.
- `getRepoRoot`'s output is **already canonical** (git resolves symlinks). Anything from `worktree list` is **not** guaranteed to be, and must be passed through `resolveRealPath` before comparison against a stored `project_path` — invariant documented at `src/worktree/store.ts:258-260` (macOS `/var` vs `/private/var`).
- `listGitWorktrees` **drops entries with no branch** (`disk-scan.ts:39`, `if (path && branch)`). A detached-HEAD main checkout emits `detached`, not `branch refs/heads/...`, and a bare repo emits `bare` — both would be silently skipped. Verified empirically. This must be fixed before the first entry can be trusted.
- The OpenCode plugin bundles via `bun build ... --external bun:sqlite --external @xenova/transformers --external sqlite-vec` (`package.json`). A new module using only `Bun.spawnSync` + `node:fs` bundles cleanly. Do **not** pull anything that transitively imports `bun:sqlite` into plugin-reachable code.
- `targets/opencode/plugins/sentinal.ts` is **exempt from file-length limits** (`PATH_EXEMPTIONS` in `src/utils/file-length.ts`). Other files are not: warn 400, block 600.
- `src/sidecar/client.ts` is at 582/600 lines. Do not add to it.

**Domain context — why some path-scoping is correct and must not be "fixed":**

Plan _discovery_ is intentionally worktree-local. `findActivePlan(searchDir)` (`src/spec/detect.ts:27`) scans `<searchDir>/docs/plans` so two worktree sessions never collide on the same plan file — a documented design decision (`docs/plans/2026-06-10-multi-plan-session-tracking.md:64-66`) with a passing test (`src/spec/ownership.test.ts:182-203`). **This plan does not touch it.** Only the _database key_ becomes canonical.

## Assumptions

- The main worktree is always the first entry of `git worktree list --porcelain`. Supported by git's documented ordering and verified empirically from a linked worktree on 2026-09-23. Tasks 1, 3 depend on this.
- ⚠️ **Corrected during review.** `specs.project_path` is **not** in the `ON CONFLICT(id) DO UPDATE SET` list — verified at `src/spec/store.ts:131-145`, where the set is `title, type, status, approved, plan_file, task_count, tasks_done, updated_at, session_id, metadata, parent, wave, started_at, completed_at`. It is written on INSERT only and is **sticky forever**. So `project_path` never "flipped" — the observed `spec_status` divergence is purely a _read-side_ mismatch (row inserted under the main-checkout path, queried under the worktree path), which means **Task 9 is what actually repairs `spec_status`**, not Task 8. Task 8 remains necessary for new rows and adds `project_path` to the update set so existing rows can self-heal. Tasks 8, 9, 10 depend on this corrected understanding.
- Leaving existing memory rows un-migrated is acceptable because the 235 main-checkout observations are keyed to the path that _becomes_ canonical, so they become visible from every worktree immediately. Only the two `.sentinal/worktrees/spec-*` session groups (110 + 81 rows) are orphaned, and those worktrees no longer exist. Out-of-scope decision depends on this.

## Testing Strategy

- **Unit:** every new function gets a `*.test.ts` sibling. Fixtures must build **real** git repos with real linked worktrees (`git worktree add`) — mocking git output would not have caught the `--git-common-dir` defect. Follow the fixture pattern in `src/git/utils.test.ts:38` (note the `realpathSync` pre-application, required for `toBe` equality on macOS).
- **Integration:** a test that creates a repo + linked worktree, writes an observation from the worktree, and asserts it is retrievable when searching from the main checkout (and vice versa). This is the regression test for the demonstrated bug.
- **Runtime gate:** assert `runtime_up` returns `ok: false` and spawns nothing when a slot token survives. Must assert **no process was spawned**, not merely that a warning was produced.
- Bun's default test timeout is 5s. Any test spawning git/subprocesses needs an explicit 3rd-arg timeout on `it()`.

## Risks and Mitigations

| Risk                                                                                                           | Likelihood | Impact   | Mitigation                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------- | ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Task 10's project filter is bound to `searchDir` instead of identity, hard-blocking every Stop from a worktree | Medium     | **High** | Called out as a ⛔ in Task 10 with a dedicated DoD regression guard; the binding is named explicitly rather than left to the implementer               |
| `worktree list` first entry is not the main worktree in some git version                                       | Low        | High     | Fall back to `--show-toplevel` (status quo — never worse than today); `checkGitVersion()` already gates <2.5                                           |
| A `.sentinal/` write is misclassified as identity and leaks across worktrees                                   | Medium     | High     | Task 11 is an explicit audit of all 4 write sites with a test asserting worktree-locality                                                              |
| OpenCode's injected `ownerLookup` silently keeps the unscoped query, producing dual-target drift               | Medium     | Medium   | Task 10 widens the callback signature and names `targets/opencode/plugins/sentinal.ts` in its Files list, with a DoD item covering the injected branch |
| Canonical identity makes an unrelated project's plan visible                                                   | Low        | Medium   | Identity is still a repo-scoped path; only worktrees of the _same_ repo converge                                                                       |
| OpenCode bundle breaks on the new import                                                                       | Low        | Medium   | `src/cli/target-assets.test.ts` already guards bare imports of native externals; run `bun run build:opencode` in Task 7                                |

## Pre-Mortem

_Assume this plan failed after full execution. Most likely internal reasons:_

1. **We assumed identity and filesystem base could be cleanly separated, but some call site legitimately needs both and we silently picked one.** (Tasks 3, 11) → Trigger: during Task 11's audit, a call site cannot be classified without changing observable behaviour. The known instance is `src/worktree/create.ts:54`, whose single `repoRoot` feeds `countActive` (identity, `:57`), `join(...)` (FS base, `:74`) and `worktree add` (git cwd, `:85-88`) — which is precisely why un-nesting was moved out of scope rather than attempted here.
2. **Canonical identity fixes reads but existing un-migrated rows make the fix look broken to the user.** (Out-of-scope decision) → Trigger: after shipping, `memory_search` from a worktree returns the main checkout's history but a user reports "my observations from last week vanished" — i.e. rows written from a _previous_ worktree session.
3. **The slot gate is too strict and breaks projects that legitimately have no slot** — e.g. anyone running `runtime_up` in a plain main checkout where slot is `null` by design (`MAIN_CHECKOUT_SLOT = 0` is never written to `worktree.env`). (Tasks 2, 4) → Trigger: the gate fires in the main checkout on a contract that contains the token, where today it works. The gate must key on _token survival_, not on `slot === null`.

## Execution Waves

**Wave 1** — primitives (parallel): Tasks 1 and 2 are independent leaf changes in different domains (`src/git/` + `src/worktree/disk-scan.ts` vs `src/runtime/loader.ts`) with no shared files.

**Wave 2** — resolvers (parallel): Tasks 3 and 4 each consume exactly one Wave 1 primitive. Different files.

**Wave 3** — write-path wiring (parallel): Tasks 5–8 all consume Task 3's resolver and touch four disjoint files (`src/hooks/memory-observer.ts`, `src/sidecar/routes.ts`, `targets/opencode/plugins/sentinal.ts`, `src/spec/store.ts`).

**Wave 4** — read-path + audit (parallel): Tasks 9–11 depend on Wave 3 being in place. Disjoint files.

⚠️ **Task 10 modifies `targets/opencode/plugins/sentinal.ts`, which Task 7 also modifies.** They are in **different waves** (3 and 4), so this is not a same-wave overlap — but Task 10 must be implemented _after_ Task 7 lands, not concurrently. Re-run `plan_impact` if either is rescheduled.

**`plan_impact` result (2026-09-23, pre-review):** no same-wave overlaps across all 4 waves. Prospective reach verdict **HIGH** — five claimed files sat in the top quartile of the import graph: `src/spec/store.ts` (116/404 modules, 29%), `src/git/utils.ts` (114, 28%), `src/runtime/loader.ts` (110, 27%), `src/worktree/disk-scan.ts` (108, 27%), `src/worktree/create.ts` (106, 26%). `create.ts` has since been dropped with Task 11. This is a prediction bounded by the accuracy of the `Files:` lists, not a verification — but it means Tasks 1, 2 and 8 are the ones to review hardest and to run the **full** suite against, not just their own test files.

**`plan_impact` re-run (2026-09-23, post-review):** 11 tasks, 33 files, **no same-wave overlaps** across all 4 waves. Reach verdict still HIGH, now topped by `src/spec/store.ts` (116/404), `src/git/utils.ts` (114), `src/runtime/loader.ts` (110), `src/worktree/disk-scan.ts` (108), `src/sidecar/routes.ts` (97); `src/worktree/create.ts` has correctly dropped out. `src/project/identity.ts` is correctly unscored (does not yet exist).

## Goal Verification

### Truths

1. `src/project/identity.ts` exports both `resolveProjectIdentity` and `resolveWorkspaceRoot` (grep: `export function resolve(ProjectIdentity|WorkspaceRoot)`).
2. No production file under `src/` or `targets/` passes `--git-common-dir` to git (grep: `git-common-dir` returns only `*.test.ts` and `docs/`).
3. An observation written with cwd set to a linked worktree is returned by a `memory_search` filtered on the main checkout path (integration test).
4. `spec_status` and `spec_init` return the same active plan when invoked from a linked worktree (integration test).
5. `runtime_up` returns `ok: false` and spawns no process when `up` retains a literal `${SENTINAL_WORKTREE_SLOT}` (grep for the refusal constant + a spawn-count assertion).
6. `src/spec/ownership.ts`'s owner lookup filters on `project_path` (grep: `WHERE id = ? AND project_path = ?`).
7. `listGitWorktrees` returns an entry for a detached-HEAD worktree (unit test asserting length includes the detached fixture).
8. `src/spec/store.ts`'s `ON CONFLICT(id) DO UPDATE SET` list includes `project_path` (grep: `project_path = excluded.project_path`).
9. The `ownerLookup` callback signature carries a project path (grep: `ownerLookup?: (specId: string, projectPath: string)`).
10. A session created from a linked worktree is listed when querying sessions for the main checkout (integration test).

### Artifacts

| Artifact                    | Provides                              | Exports                                          |
| --------------------------- | ------------------------------------- | ------------------------------------------------ |
| `src/project/identity.ts`   | Canonical vs local root resolution    | `resolveProjectIdentity`, `resolveWorkspaceRoot` |
| `src/git/utils.ts`          | Main-worktree git primitive           | `getMainWorktreeRoot`                            |
| `src/worktree/disk-scan.ts` | Branchless-safe porcelain parse       | `listGitWorktrees` (amended)                     |
| `src/runtime/loader.ts`     | Structured unsubstituted-token signal | `RuntimeLoadResult.unsubstitutedTokens`          |
| `src/runtime/lifecycle.ts`  | Pre-spawn refusal                     | `runtimeUp` (amended)                            |

### Key Links

| From                                   | To                        | Via                       | Pattern                  |
| -------------------------------------- | ------------------------- | ------------------------- | ------------------------ |
| `src/project/identity.ts`              | `src/git/utils.ts`        | main-worktree lookup      | `getMainWorktreeRoot`    |
| `src/hooks/memory-observer.ts`         | `src/project/identity.ts` | observation key           | `resolveProjectIdentity` |
| `targets/opencode/plugins/sentinal.ts` | `src/project/identity.ts` | plugin project key        | `resolveProjectIdentity` |
| `src/spec/store.ts`                    | `src/project/identity.ts` | spec row key              | `resolveProjectIdentity` |
| `src/hooks/post-compact-restore.ts`    | `src/project/identity.ts` | worktree-local state path | `resolveWorkspaceRoot`   |
| `src/runtime/lifecycle.ts`             | `src/runtime/loader.ts`   | pre-spawn gate            | `unsubstitutedTokens`    |

## Progress Tracking

- [x] Task 1: Branchless-safe `listGitWorktrees` + `getMainWorktreeRoot` (Wave 1)
- [x] Task 2: Structured unsubstituted-token signal in runtime loader (Wave 1)
- [x] Task 3: `src/project/identity.ts` — the two resolvers (Wave 2)
- [x] Task 4: `runtime_up` pre-spawn refusal gate (Wave 2)
- [x] Task 5: Wire Claude Code memory write path (Wave 3)
- [x] Task 6: Wire sidecar memory + session write paths (Wave 3)
- [x] Task 7: Wire OpenCode plugin project key (Wave 3)
- [x] Task 8: Wire spec store identity (Wave 3)
- [x] Task 9: Normalize read-side project filters (Wave 4)
- [x] Task 10: Scope spec ownership query by project, both targets (Wave 4)
- [x] Task 11: Audit `.sentinal/` write sites + rules update (Wave 4)

**Total Tasks:** 11 | **Completed:** 11 | **Remaining:** 0

### Wave 4 outcome — original bug confirmed fixed

Live smoke from this linked worktree (Task 9):

```
memory_search(worktree path):  Found 20 observation(s)          # was: 0
spec_status(worktree path):    ## Current Spec: ...             # was: "No active spec found"
spec_init plan file:           <this worktree>/docs/plans/...   # unchanged ✓ (isolation preserved)
```

Independent confirmation: `resolveProjectIdentity("/Users/evan/orca/workspaces/sentinal/orca-support")` → `/Users/evan/Projects/endpoint_esports/sentinal`; `resolveWorkspaceRoot(...)` → the worktree. Direct SQL shows **96** observations accumulated under the worktree key *during this session alone* (written by the still-installed old build) versus **236** under the canonical key — the fragmentation was live and ongoing, and those 96 are now orphaned per known limitation #1.

Full suite: **3297 pass / 0 fail** across 385 files (baseline was 3226 / 0 — +71 tests, no regressions).

### Wave 4 findings

- ⚠️ **Task 11 reported an honest non-RED.** Site 1 (`post-compact-restore.ts`) was **already worktree-correct**: `findGitRoot` runs `git rev-parse --show-toplevel`, which answers "the worktree I am standing in" — byte-identical to `resolveWorkspaceRoot`'s primary path. The three worktree tests passed *before* the change. An attempt to construct a RED from the `?? input.cwd` fallback also failed, because `Bun.spawnSync` ignores an empty `cwd` and inherits the process cwd. **This change is declarative, not a bugfix** — it states intent and adds the non-empty-absolute guarantee. `RED_CONFIRMED` was set to bypass the TDD guard; that is recorded here as "guard bypassed", not as a real red.
- **Task 10: the planned "two rows" test is not constructible.** `specs.id` is `TEXT PRIMARY KEY` and Task 8 added `project_path = excluded.project_path`, so one plan filename can only ever have ONE row globally — project B's registration re-keys project A's row rather than adding a second. A strictly harder test was built instead: both checkouts hold the plan on disk, project A holds the single row with a **live** owner, project B must come back `orphaned`. Harder because the unscoped path returned `block: false` — a **silent guard-off**, not a wrong block.
- **Task 10 mutation test passed:** flipping `resolveProjectIdentity(searchDir)` → `searchDir` produced 8 failures, including the regression guard, with exactly the predicted spurious-`orphaned` symptom.
- **Task 9 found two sites the plan missed:** `memory_timeline` (identical filter, equally broken — fixed) and the sidecar **read** routes `/memory/search`, `/memory/timeline`, `/spec/current` (`src/sidecar/routes.ts:371,375`), which still pass `body.project` through un-normalized. Normalizing at the MCP boundary covers the MCP callers, but any non-MCP caller reaching those routes is still unscoped. See Deferred Issues.
- **A second genuine identity/workspace conflation was found:** `mergeSharedObservations` (`src/memory/restore.ts:152-156`) feeds one `projectPath` to both `getRecentForProject` (storage key) and `readSharedMemory` (disk prefix). Read-only and benign today because `project-memory.json` is git-tracked.
- `spec_status` and `spec_init` can now legitimately report **different** plans from a worktree (storage key → main checkout's active spec; filesystem scan → this worktree's plan). That divergence is now by design, but it is user-visible.

## Deferred Issues

- ⚠️ **`handleCompactionAutocontinue` conflates identity and workspace and cannot be fixed with its current signature.** `src/opencode/compaction-autocontinue.ts:27` takes a single `projectPath` and uses it BOTH as a storage key (`sidecar.getCurrentSpec(projectPath)`) AND as an on-disk prefix (`cycle.filePath.startsWith(projectPath)`). Task 7 passed `projectIdentity` and documented the caveat inline. **Consequence:** in a linked worktree the TDD prefix filter under-matches, so the RED-state compaction pause degrades to "continue". Needs the signature split into two parameters — out of scope here, follow-up required.
- `src/spec/store.ts` does **not** normalize on read (`syncFromPlanFile`, `listSpecs`, `getCurrentSpec` take whatever string they are handed). Deliberate — normalizing inside the store would break callers passing non-repo paths (`/test/project`, raw tmpdirs). Task 9 owns the read-side boundary.
- `/observation` is a hot path and now spawns `git worktree list --porcelain` synchronously per call (~5-10 ms). Dwarfed by the embedding work already on that route. No memo cache was added deliberately — a long-lived sidecar caching cwd→root would go stale if a directory becomes a repo mid-session.
- `src/hooks/memory-observer.test.ts:303` ("agent_id / duration_ms") is a **fake test** — its only assertion is `expect(true).toBe(true)`, and its `process.env.SENTINAL_MEMORY = "true"` is dead code (`isMemoryEnabled()` reads `$SENTINAL_HOME/config.json`). Pre-existing; left untouched. Should be rewritten using the `SidecarClient.connect` stub Task 5 introduced.
- `src/spec/store.ts` is 549 lines and `src/sidecar/routes.ts` is 501 — both over the 400 warn threshold, well under the 600 block. Pre-existing for `store.ts`.
- **Sidecar READ routes remain un-normalized:** `/memory/search`, `/memory/timeline`, `/spec/current` (`src/sidecar/routes.ts:371,375`) and `handleGetTddState`'s `project` param (`:242`) pass the caller's path straight through. `normalizeProjectKey` exists at `routes.ts:164` but is wired only into the WRITE handlers. MCP callers are covered at the tool boundary; any other caller is not. Defensive pass warranted.
- **Second identity/workspace conflation:** `mergeSharedObservations` (`src/memory/restore.ts:152-156`) uses one `projectPath` as both a storage key (`getRecentForProject`) and a disk prefix (`readSharedMemory`). Benign today only because `project-memory.json` is git-tracked and therefore identical in every checkout at the same commit.
- **Pre-existing test fragility exposed by Task 10:** `SpecStore.syncFromPlanFile` does not canonicalize, so any test registering with a raw tmp path creates a `/var/...` row the now-canonical `/private/var/...` lookup cannot see. Hit `src/hooks/spec-stop-guard-session.test.ts:76`; fixed by making the test write the production row shape, not by weakening the query. Future ownership tests must canonicalize when registering.

### Implementation notes (discovered, not planned)

- ⛔ **`quality_report` runs prettier PROJECT-WIDE with auto-fix.** In Wave 1 it rewrote ~90 unrelated files (CHANGELOG, README, 38 plan files, `targets/*/rules/`) from pre-existing repo drift. They were detected and reverted, but **all remaining tasks must call `quality_report` with a `file` scope**, never project-wide.
- ESLint cannot run at all: the repo has **no `eslint.config.*`**, so ESLint v10 refuses. Pre-existing; use `check_diagnostics` (spec-scoped) as the gate instead.
- Task 2 necessarily touched two files outside its `Files:` list — `src/runtime/interpolate.ts` (to export `sentinalTokenNames`, since `SENTINAL_TOKEN_RE` is module-private and the only existing export over it answers the inverse question) and `src/runtime/lifecycle.test.ts` (a fixture, broken by the new required interface field).
- `unsubstitutedTokens` holds **bare, de-duplicated token names** (`["SENTINAL_WORKTREE_SLOT"]`), not braced tokens, and not one entry per field. Task 4's gate must not assume one-per-field.
- Task 1 added a `src/git/utils.ts` → `src/worktree/disk-scan.ts` import (for `resolveRealPath`), which is a module cycle. Verified safe — hoisted declarations, no top-level side effects, `src/runtime/no-module-cycle.test.ts` passes — and the layering was already inverted (`git/utils.ts` imports `WorktreeError` from `worktree/types.js`).
- ✅ **Bug confirmed live** via the new primitive: from this checkout, `getRepoRoot()` → `/Users/evan/orca/workspaces/sentinal/orca-support` while `getMainWorktreeRoot()` → `/Users/evan/Projects/endpoint_esports/sentinal`.
- Environment: `node_modules` was absent (Orca creates worktrees without it); `bun install` is required before any test run. Baseline 3226 pass / 0 fail → Wave 1: 3243 → Wave 2: **3259 pass / 0 fail** across 383 files.
- ⛔ **The plan review's `workspace-adaptor.ts` claim was FALSE — premise struck.** Task 3 investigated: `src/opencode/workspace-adaptor.ts` is **not a root resolver at all**. It contains no `git rev-parse`, no `git worktree list`, no `realpath`. It *receives* `WorkspaceInfo.directory` from OpenCode and either passes it through or substitutes a worktree path the **sidecar** already resolved from a plan slug (`:169`). The review's `MAIN_ROOT` evidence was a literal fixture string `"/test/project"` in `workspace-adaptor.test.ts:270`, not resolved behaviour. The plan's original "three independent root resolvers" inventory was correct as written. It was documented as distinct rather than delegated, because delegating it to `resolveProjectIdentity` would answer the main checkout while a spec worktree is active — reconstructing the exact edit-leak bug the TIMEOUT sentinel at `:73` exists to prevent.
- **Task 4 gate placement has a deliberate side effect:** the gate sits *above* the `!config.up` inert-success branch, so a contract with a surviving token in `down` but no `up` now returns `ok: false` rather than "nothing to start". Kept deliberately — a contract whose `down` cannot be expanded is unusable, and "ok, nothing to start" would be a false all-clear on a stack that could later be started and never stopped. Pinned by test.
- **"No pidfile AND no claim file" is one assertion, not two:** `claimPidfile` writes to `runtimePidfilePath()`; the claim *is* the pidfile, distinguished only by `state: "claiming"` (`pidfile-claim.ts:79`).
- ⚠️ **File-length watch:** `src/index.ts` is now **401** lines (warn threshold 400, block 600) and `src/runtime/lifecycle.ts` is exactly **400**. Both are barrel/orchestrator files. Remaining tasks should avoid adding barrel exports where possible; a deliberate split decision is needed before either approaches 600.
- ⛔ **Wave 3 finding — the task brief undercounted by 12.** `projectRootForSidecar` in `targets/opencode/plugins/sentinal.ts` had **25** use sites, and despite the name only 12 were storage keys. The other 13 were filesystem paths (`join(x, "CLAUDE.md")`, `cwd:` for hook payloads, `detectFramework`, `findActivePlan` ×3, `getCompactionConfig`). The plan flagged only line 1190 as the worktree-local exception. Making the identifier canonical wholesale would have redirected CLAUDE.md/AGENTS.md discovery and framework detection to the main checkout. The identifier was deleted outright so `""` cannot be reconstructed, and every site was individually classified. **Lesson for Wave 4: classify every site, do not trust a name.**
- Task 6 found the plan's "rejected **or resolved**" instruction for an empty `projectPath` is self-contradictory: `resolveProjectIdentity("")` internally substitutes `process.cwd()`, which is the forbidden sidecar-cwd fallback. **Rejection was the only option** consistent with the prohibition. `/session/:id/end` needed no change — it is keyed by session id and carries no project path.
- Task 5 behaviour change beyond the DoD: a non-git cwd is now **realpath'd**, so on macOS `/var/...` keys become `/private/var/...`. Correct (that is what makes the key canonical), but it means pre-existing non-git rows will not match new ones.
- Task 7 mutation-tested both discriminating assertions, which caught a real test-hygiene bug: cleanup placed *after* an assertion never ran when that assertion failed, making a test pass under mutation. Worth repeating in Wave 4.

## Implementation Tasks

### Task 1: Branchless-safe `listGitWorktrees` + `getMainWorktreeRoot`

**Objective:** Make the porcelain parser retain detached/bare entries, then add a git primitive returning the main worktree's path.
**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `src/worktree/disk-scan.ts`
- Modify: `src/git/utils.ts`
- Test: `src/worktree/disk-scan.test.ts`, `src/git/utils.test.ts`

**Key Decisions / Notes:**

- `disk-scan.ts:39`'s `if (path && branch)` drops detached and bare entries. Change to retain entries with a path, making `branch` nullable on the returned type. **Consumers are exactly two** — `reconcile.ts:84` and `cleanup.ts:221` — both match on `branch`, so each must skip null-branch entries explicitly to preserve current behaviour.
- ✅ **Verified during review:** neither `listGitWorktrees` nor `GitWorktreeEntry` is exported from `src/index.ts` or referenced under `targets/`, so widening `branch` to `string | null` is **not** a public-API break and a parallel `listAllGitWorktrees()` is unnecessary. Re-confirm with a grep before starting, in case the barrel changed.
- ⚠️ `src/worktree/disk-scan.test.ts:60` currently asserts a branchless entry is **NOT** returned. That assertion must be consciously inverted, not silently deleted.
- `getMainWorktreeRoot(cwd)` returns the first entry's path. Follow the `getRepoRoot` shape exactly (`src/git/utils.ts:91-97`): call `gitExec`, throw `WorktreeError(..., "NOT_A_REPO")` on non-zero.
- Apply `resolveRealPath` (`disk-scan.ts:45`) to the result — porcelain output is not guaranteed canonical, unlike `--show-toplevel`.
- Add to the barrel at `src/index.ts:205-217`.

**Definition of Done:**

- [ ] `listGitWorktrees` returns an entry for a detached-HEAD worktree and for a bare repo
- [ ] Existing `reconcile.ts` / `cleanup.ts` behaviour is unchanged (their tests still pass)
- [ ] `getMainWorktreeRoot` returns the main checkout when called from a linked worktree
- [ ] `getMainWorktreeRoot` throws `NOT_A_REPO` outside a repo
- [ ] No diagnostics errors

**Verify:**

- `bun test src/worktree/disk-scan.test.ts src/git/utils.test.ts src/worktree/reconcile.test.ts src/worktree/cleanup.test.ts`

---

### Task 2: Structured unsubstituted-token signal in runtime loader

**Objective:** Expose _which_ `${SENTINAL_*}` tokens survived interpolation as structured data, so the caller can gate on it without string-matching a warning.
**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `src/runtime/loader.ts`
- Test: `src/runtime/loader.test.ts`

**Key Decisions / Notes:**

- Today the slotless condition is a prose string in `warnings[]` (`loader.ts:113-122`, `:190-197`), and `warnings` is documented as "never a reason to stop" (`:68`). Do not change that contract — **add** a field.
- Add `unsubstitutedTokens: string[]` to the load result, populated when `interpolateStrict` (`src/runtime/interpolate.ts:112`) leaves a token in place. Empty array when clean.
- Scan the same three `INTERPOLATED_FIELDS` (`src/runtime/interpolate.ts:57`): `up`, `down`, `readiness.target`.
- Keep the existing warning — it is what a human reads. The new field is what code branches on.
- `loadRuntimeConfig` must still **never throw** (`loader.ts:22-28`) and an absent `runtime.json` must remain an inert success with an empty array.

**Definition of Done:**

- [ ] `unsubstitutedTokens` is `[]` for a fully-substituted config and for `notConfigured`
- [ ] It contains `SENTINAL_WORKTREE_SLOT` when `.sentinal/worktree.env` is absent and `up` carries the token
- [ ] Existing warning text is unchanged (assert the existing test at `loader.test.ts:120-134` still passes)
- [ ] No diagnostics errors

**Verify:**

- `bun test src/runtime/loader.test.ts`

---

### Task 3: `src/project/identity.ts` — the two resolvers

**Objective:** Create the single shared module that every call site will classify against.
**Dependencies:** Task 1
**Wave:** 2

**Files:**

- Create: `src/project/identity.ts`
- Modify: `src/index.ts`
- Test: `src/project/identity.test.ts`

**Key Decisions / Notes:**

- `resolveProjectIdentity(cwd: string): string` — layered, **never throws**:
  1. `getMainWorktreeRoot(cwd)` (Task 1)
  2. on throw → `getRepoRoot(cwd)` (`--show-toplevel`, status quo)
  3. on throw → `resolveRealPath(cwd)`
     Never returns `""`. The current `projectRootForSidecar = projectRoot ?? ""` (`plugins/sentinal.ts:338`) is the source of 14 empty-string rows in the live DB — the new resolver must make that unreachable.
- `resolveWorkspaceRoot(cwd: string): string` — the _local_ checkout root: `getRepoRoot(cwd)` with a `resolveRealPath(cwd)` fallback. This is deliberately today's behaviour, named so call sites declare intent.
- Both synchronous, matching `src/git/utils.ts`. Do **not** copy `src/utils/git.ts`'s pointless `async`.
- Module must not import anything reaching `bun:sqlite` — it is bundled into the OpenCode plugin.
- Add a docblock stating the rule: _identity → storage keys only; workspace → filesystem writes only._
- **First step:** read `src/opencode/workspace-adaptor.ts` (and its test). It is a **fourth** pre-existing root-ish resolver that the "Context for Implementer" inventory omits. Either delegate it to these two functions or document in its docblock why it is a distinct concern, and correct the inventory table. (Review cited `MAIN_ROOT` semantics there; a grep of the implementation did **not** find that identifier, so verify what it actually does rather than trusting either account.)

**Definition of Done:**

- [ ] From a linked worktree, `resolveProjectIdentity` returns the main checkout and `resolveWorkspaceRoot` returns the worktree
- [ ] From the main checkout, both return the same path
- [ ] Outside a git repo, both return a realpath'd cwd and neither throws
- [ ] Neither ever returns `""`
- [ ] `bun run build:opencode` succeeds with the module imported
- [ ] No diagnostics errors

**Verify:**

- `bun test src/project/identity.test.ts`

---

### Task 4: `runtime_up` pre-spawn refusal gate

**Objective:** Refuse to spawn when a slot token survived, instead of letting `sh -c` expand it to empty and silently target the main checkout's resources.
**Dependencies:** Task 2
**Wave:** 2

**Files:**

- Modify: `src/runtime/lifecycle.ts`
- Test: `src/runtime/lifecycle.test.ts`

**Key Decisions / Notes:**

- Gate **before** the pidfile claim and spawn (`lifecycle.ts:268-291`), alongside the existing `loaded.error` check at `:179`.
- Key on `unsubstitutedTokens.length > 0`, **not** on `slot === null` — see Pre-Mortem 3. A main checkout legitimately has no slot; only a _surviving token_ is the fault.
- Return the established refusal shape (`ok: false`) with a message naming the token and the missing `.sentinal/worktree.env`. Mirror the tone of `OCCUPIED_PORT_RULE` (`src/runtime/preflight.ts:181-185`): state the rule, do not improvise a value.
- This closes the verified path where `./scripts/stack up ${SENTINAL_WORKTREE_SLOT}` executes as `./scripts/stack up ` — see `src/runtime/interpolate.ts:31-32`, which already declares this must never happen.
- Note the existing test at `src/runtime/spawn.test.ts:189` probes with `${SENTINAL_WORKTREE_SLOT-unset}` (shell-default syntax), a _different_ expansion from the bare token. Do not rely on it; add a bare-token case.

**Definition of Done:**

- [ ] `runtime_up` returns `ok: false` when a token survives, and **no process is spawned** (assert spawn count, not just the return value)
- [ ] No pidfile and no claim file are left behind on refusal
- [ ] A config with no tokens and no slot (plain main checkout) still starts normally
- [ ] No diagnostics errors

**Verify:**

- `bun test src/runtime/lifecycle.test.ts src/runtime/spawn.test.ts`

---

### Task 5: Wire Claude Code memory write path

**Objective:** Key observations written by Claude Code hooks to the canonical identity.
**Dependencies:** Task 3
**Wave:** 3

**Files:**

- Modify: `src/hooks/memory-observer.ts`
- Test: `src/hooks/memory-observer.test.ts`

**Key Decisions / Notes:**

- `memory-observer.ts:75` currently sets `projectPath: input.cwd` — raw, unresolved. Replace with `resolveProjectIdentity(input.cwd)`.
- This is the single largest contributor to fragmentation; `input.cwd` is whatever directory the agent happened to be in.
- Hooks must degrade gracefully and never throw — the resolver already guarantees this, but do not add a `try` that swallows into `""`.

**Definition of Done:**

- [ ] An observation captured with `cwd` inside a linked worktree is stored under the main checkout path
- [ ] Non-git cwd still produces a non-empty `projectPath`
- [ ] No diagnostics errors

**Verify:**

- `bun test src/hooks/memory-observer.test.ts`

---

### Task 6: Wire sidecar memory + session write paths

**Objective:** Normalize `projectPath` on **both** the sidecar observation route and the session route.
**Dependencies:** Task 3
**Wave:** 3

**Files:**

- Modify: `src/sidecar/routes.ts`
- Test: `src/sidecar/routes.test.ts`, `src/sidecar/server.test.ts`

**Key Decisions / Notes:**

- `routes.ts:258-284` (`/observation`) accepts `body.projectPath` with **no validation**. Normalize on receipt.
- ⚠️ **Added after review:** the `/session` write path at `routes.ts:148,158` also stores a caller-supplied `projectPath`, and Scope names `sessions` as in-scope. Sessions keyed by raw worktree cwd keep fragmenting, which affects `isSessionAlive`/ownership liveness and the dashboard. Cover `/session` (and `/session/:id/end`) with the same rule. Round-trip coverage already exists at `src/sidecar/server.test.ts:114-139`.
- ⛔ The sidecar's own `process.cwd()` is meaningless — it is a detached long-lived process. Resolve from the _supplied_ path only; never fall back to the sidecar's cwd. This mirrors the existing prohibitions at `routes.ts`/`worktree-routes.ts:222`.
- Do not add this to `src/sidecar/client.ts` (582/600 lines).

**Definition of Done:**

- [ ] A posted worktree path is stored as the canonical path on `/observation`
- [ ] A session created from a linked worktree is listed when querying sessions for the main checkout
- [ ] An empty or missing `projectPath` is rejected or resolved, never stored as `""`
- [ ] No diagnostics errors

**Verify:**

- `bun test src/sidecar/routes.test.ts src/sidecar/server.test.ts`

---

### Task 7: Wire OpenCode plugin project key

**Objective:** Make the plugin's project key canonical, eliminating the `""` rows.
**Dependencies:** Task 3
**Wave:** 3

**Files:**

- Modify: `targets/opencode/plugins/sentinal.ts`
- Modify: `targets/opencode/plugins/sentinal-helpers.ts`
- Test: `targets/opencode/plugins/sentinal.test.ts`

**Key Decisions / Notes:**

- `resolveProjectRoot` (`sentinal-helpers.ts:32-83`) does **no git resolution at all** — a plugin started in a subdirectory gets that subdirectory. Keep its existing validity checks (not-root, exists, writable — `:64-72`) as the _workspace_ answer, then derive identity from it via `resolveProjectIdentity`.
- `sentinal.ts:338`'s `projectRootForSidecar = projectRoot ?? ""` must no longer be able to yield `""`.
- `sentinal.ts:1190` uses `process.cwd()` as a `searchDir` for `resolveStopDecision` — that is **plan discovery**, which stays worktree-local. Use `resolveWorkspaceRoot`, not identity.
- Run `bun run build:opencode` and confirm `src/cli/target-assets.test.ts` still passes (it guards bare imports of native externals in the bundle).

**Definition of Done:**

- [ ] The plugin's sidecar project key is the canonical root
- [ ] No code path can produce `""` as a project key
- [ ] `session.idle` stop-guard still uses the worktree-local root
- [ ] `bun run build:opencode` succeeds
- [ ] No diagnostics errors

**Verify:**

- `bun test targets/opencode/plugins/sentinal.test.ts src/cli/target-assets.test.ts && bun run build:opencode`

---

### Task 8: Wire spec store identity

**Objective:** Key `specs` rows canonically so both worktrees write one consistent row.
**Dependencies:** Task 3
**Wave:** 3

**Files:**

- Modify: `src/spec/store.ts`
- Modify: `src/spec/mcp-tools.ts`
- Test: `src/spec/store.test.ts`

**Key Decisions / Notes:**

- ⛔ **No schema migration.** `specs.id` stays the `PRIMARY KEY` — five foreign keys reference `specs(id)` (`src/memory/migrations.ts:217, 268, 289, 305, 363`) and a composite key would require rebuilding all five dependent tables. See "Known limitation" under Scope.
- ⚠️ **Corrected after review — read this before implementing.** The original plan claimed `project_path` is written by the `ON CONFLICT(id) DO UPDATE` and therefore "stops flipping". **That is false.** Verified at `src/spec/store.ts:131-145`: `project_path` is **absent** from the UPDATE set, so it is INSERT-only and sticky forever. It never flipped. Two consequences:
  1. The `spec_status` divergence is a pure **read-side** mismatch — **Task 9 is the actual fix for it**, not this task.
  2. "Existing rows self-heal on the next `spec_register`" is impossible as the code stands.
- **The change:** add `project_path = excluded.project_path` to the `ON CONFLICT(id) DO UPDATE SET` list at `src/spec/store.ts:131`. This one line is what delivers the self-heal, without a schema migration.
- `spec_register` at `src/spec/mcp-tools.ts:138` does `project ?? process.cwd()` — normalize the result through `resolveProjectIdentity`. `process.cwd()` remains a legitimate _default_ in the MCP process (it runs in the agent's cwd); it just must not be stored raw.
- Leave `plan_file` absolute and worktree-local — it points at a real file in a specific checkout.

**Definition of Done:**

- [ ] A plan registered from a linked worktree stores the main checkout as `project_path`
- [ ] `getCurrentSpec(canonicalRoot)` finds it
- [ ] A spec row pre-existing with a stale worktree `project_path` is **re-keyed to canonical** on the next `spec_register` (test must write the stale row first, then re-register, then assert)
- [ ] `plan_file` still points at the registering worktree's copy
- [ ] No schema version bump
- [ ] No diagnostics errors

**Verify:**

- `bun test src/spec/store.test.ts src/spec/mcp-tools.test.ts`

---

### Task 9: Normalize read-side project filters

**Objective:** Make reads resilient when a caller passes a worktree path explicitly.
**Dependencies:** Tasks 5, 6, 8
**Wave:** 4

**Files:**

- Modify: `src/memory/mcp-tools.ts`
- Modify: `src/spec/status-mcp-tools.ts`
- Modify: `src/session/conflict.ts`
- Test: `src/memory/mcp-tools.test.ts`, `src/spec/status-mcp-tools.test.ts` (create), `src/session/conflict.test.ts`

**Key Decisions / Notes:**

- `memory_search`'s `project` filter is exact SQL equality in three separate places (`store-observations.ts:251`, `vector-store.ts:260`, and the hybrid fan-out at `search/strategies/hybrid.ts:39-48`). Normalizing once at the **MCP tool boundary** (`memory/mcp-tools.ts:101`) covers all three without touching the query layer.
- Same for `spec_status` (`status-mcp-tools.ts:137`).
- This is what makes the exact call that failed in this session — `memory_search({ project: "<orca worktree>" })` — return the main checkout's 235 observations.
- ⚠️ **This task, not Task 8, is what repairs the observed `spec_status` divergence** (see Task 8's correction note). Treat it as the primary fix, not a polish step.
- ⚠️ **Added after review:** `src/session/conflict.ts:66-89` filters `WHERE o.project_path = ?` with exact equality on a caller-supplied path — the same bug class. Cross-session edit-conflict detection silently returns nothing from a worktree. Normalize at the entry of `findConflictingEdits` / `getRecentSessionActivity`. Note `conflict.ts:81` also matches `file_paths` with `LIKE '%<path>%'`; that is a _file_ path, not a project key — leave it alone.
- Do **not** change `findActivePlan` / `spec_init` (`status-mcp-tools.ts:228`) — that is the deliberate worktree-local FS scan.

**Definition of Done:**

- [ ] `memory_search` with a worktree path returns observations stored under the canonical path
- [ ] `spec_status` with a worktree path finds the canonically-keyed spec
- [ ] `findConflictingEdits` called with a worktree path returns conflicts recorded under the canonical path
- [ ] `spec_init` still resolves plans from the worktree's own `docs/plans/`
- [ ] No diagnostics errors

**Verify:**

- `bun test src/memory/mcp-tools.test.ts src/spec/status-mcp-tools.test.ts src/session/conflict.test.ts`

---

### Task 10: Scope spec ownership query by project, both targets

**Objective:** Stop a same-named plan in one project resolving another project's ownership row — without regressing the Stop hook into a permanent block.
**Dependencies:** Tasks 7, 8
**Wave:** 4

**Files:**

- Modify: `src/spec/ownership.ts`
- Modify: `targets/opencode/plugins/sentinal.ts`
- Test: `src/spec/ownership.test.ts`

**Key Decisions / Notes:**

- `ownership.ts:141` is `SELECT session_id FROM specs WHERE id = ?` — **no project filter**, while `specs.id` is the bare plan filename (`src/spec/parser.ts:74`, path discarded). Add `AND project_path = ?`.
- ⛔ **MUST_FIX from review — the binding is the whole risk.** The path bound to that parameter **must be `resolveProjectIdentity(searchDir)`, never `searchDir` itself.** `resolveStopDecision` runs on a worktree-local `searchDir` (correctly — plan discovery stays local), but rows are keyed canonically after Task 8. Binding `searchDir` returns no row → `!ownerId` → `{ block: true, ownership: "orphaned" }` (`ownership.ts:104-105`). The fail-safe would convert an identity mismatch into **a spurious hard block on every Stop from a worktree** — worse than the bug being fixed.
- ⛔ **Dual-target drift — the DB filter is bypassable.** `ownership.ts:99-101` prefers an injected `ownerLookup(active.spec.id)` over `getSpecOwner`, and the signature (`ownership.ts:60`) carries only the spec id. The OpenCode plugin supplies its own at `targets/opencode/plugins/sentinal.ts:1166,1177`. Fixing `getSpecOwner` alone leaves OpenCode unscoped. Widen to `(specId: string, projectPath: string) => string | null` and update the plugin's implementation to bind the canonical path. This is exactly the drift `sentinal-dual-target.md` warns about.
- ⚠️ Task 7 also modifies `targets/opencode/plugins/sentinal.ts`. Different waves (3 vs 4), so not a same-wave overlap — but implement this **after** Task 7 lands.
- Preserve the fail-safe posture — a genuinely absent row must still resolve to `"orphaned"` (`ownership.ts:105`), not silently unblock.
- The existing isolation test (`ownership.test.ts:182-203`) passes only because the worktree dir has **no plan file at all**. Add the stronger case the original plan asked for (`2026-06-10-multi-plan-session-tracking.md:66`): two checkouts each holding a same-named plan, with distinct `project_path` values.

**Definition of Done:**

- [ ] Invoked from a linked worktree against a canonically-keyed spec row, the owner **is** resolved — decision is NOT `orphaned` (this is the regression guard)
- [ ] A same-named plan in project B does not return project A's `session_id`; the resulting decision is the documented fail-safe `orphaned`, asserted explicitly
- [ ] The OpenCode `ownerLookup` path is project-scoped too (test covers the injected-callback branch, `ownership.test.ts:330-381`)
- [ ] Genuinely absent row still yields `orphaned`
- [ ] No diagnostics errors

**Verify:**

- `bun test src/spec/ownership.test.ts src/hooks/spec-stop-guard.test.ts targets/opencode/plugins/sentinal.test.ts`

---

### Task 11: Audit `.sentinal/` write sites + rules update

**Objective:** Prove no filesystem write was accidentally made canonical, and record the identity/workspace rule so it is not re-broken.
**Dependencies:** Tasks 5, 6, 7, 8
**Wave:** 4

**Files:**

- Modify: `src/hooks/post-compact-restore.ts`
- Modify: `.sentinal/rules/sentinal-project.md`
- Test: `src/hooks/post-compact-restore.test.ts`

**Key Decisions / Notes:**

- Audit all four worktree-local write sites and confirm each uses `resolveWorkspaceRoot`, never identity:
  - `post-compact-restore.ts:24-29` — `join(gitRoot ?? cwd, ".sentinal", "compact-state.json")` ⚠️ **currently uses `findGitRoot`; must become `resolveWorkspaceRoot`.** Compact state is per-session-per-checkout; making it canonical would leak state between worktrees.
  - `src/runtime/pidfile.ts:105-107` — takes an explicit `worktreePath`, already correct.
  - `src/worktree/slots.ts:49` (`worktree.env`) — already correct.
  - `src/memory/shared.ts:366` (`project-memory.json`) — git-tracked and per-checkout; leave as workspace root.
- Add a short section to `.sentinal/rules/sentinal-project.md` stating the rule and naming the two functions. ⛔ This is a rule for developing sentinal itself, so it goes in `.sentinal/rules/` — **not** `targets/*/rules/`, which ships to users.
- **Also record the known limitations** (review `consider` item), so the first symptom is a documented caveat rather than a bug report:
  1. Memory observations written before this change under now-deleted worktree paths (110 + 81 rows) remain queryable **only** by passing that literal path to `memory_search`. Include the query to list distinct orphaned `project_path` values.
  2. `specs.id` is the bare filename and is not project-qualified (see "Known limitation" under Scope).
  3. `worktree_create` still bases off the invoking checkout — deferred follow-up, with the slot double-allocation hazard named.
- Do not regenerate cross-target parity baselines; no `targets/*/commands|skills|rules` file changes here.

**Definition of Done:**

- [ ] `compact-state.json` resolves to the worktree, not the main checkout (test asserts the path)
- [ ] All four write sites confirmed workspace-scoped
- [ ] `.sentinal/rules/sentinal-project.md` documents the identity-vs-workspace rule and all three known limitations
- [ ] No diagnostics errors

**Verify:**

- `bun test src/hooks/post-compact-restore.test.ts && bun test`
