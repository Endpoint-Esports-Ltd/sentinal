# File-Project Resolver + Per-Edit Wiring

Created: 2026-11-05
Status: VERIFIED
Approved: Yes
Iterations: 1
Worktree: No
Type: Feature
Parent: 2026-11-05-cross-project-scope
Wave: 1

## Summary

**Goal:** Add `resolveFileProject(filePath, session)` and make every per-file mechanism use the
edited file's own project on both targets: memory capture, pre-edit memory hints, TDD guard and
tracker, framework detection and the file-conflict check.
**Architecture:** One pure, `bun:sqlite`-free resolver in `src/project/` (fs walk-up to `.git`,
realpath comparison with the session workspace, one memoized git spawn only for foreign repos).
Claude Code hooks and the OpenCode plugin call it at each per-file site; the sidecar API is
unchanged (the "either project has a plan" rule is two existing lookups on the client side).
**Tech Stack:** TypeScript, Bun (`bun:test`), Claude Code hooks, OpenCode plugin.
**Master plan:** `docs/plans/2026-11-05-cross-project-scope.md` — read its Architecture → The
resolver and Context → "Cross-phase rules decided at master level" first.

## Scope

### In Scope

- `src/project/file-project.ts` (resolver) and `src/project/test-scope-projects.ts` (group a test
  run's files/dirs/effective cwd by project); `TestRunScope.cwd` (effective cwd after `cd`).
- Claude Code: `memory-observer`, `tool-failure-observer`, `tdd-guard`, `tdd-tracker`,
  `pre-edit-guide` (+ its dispatch and the conflict check in `src/cli/commands/hook.ts`),
  `file-checker` (+ its dispatch).
- OpenCode plugin: `sidecarTddGuard`, `sidecarTddTrack`, after-hook quality checks
  (`detectFramework`), after-hook memory capture, thrown-failure capture, `getPreEditGuide`,
  `apply_patch` path extraction, `compaction-autocontinue` RED-row filter.
- `metadata.sessionProject` on auto-captured observations.
- Dev docs: `.sentinal/rules/sentinal-project.md`; README "How It Works" note; latency measured.

### Out of Scope

- Loading a foreign project's **rules**, `related.json`, related-memory search, restore index
  (Phase 2). Making OpenCode's pre-edit hint model-visible (Phase 2, via `system.transform`).
- Cross-repo master plans / Orca (Phase 3).
- Migrating existing ops-keyed rows (decided: no migration).
- Session-level keys (sessions table, session conflict, restore, stop guard, prompt-context,
  plan discovery): these stay on the **session** project.

## Context for Implementer

- **Read first:** `.sentinal/rules/sentinal-project.md` § "Project Identity vs Workspace Root".
  `resolveProjectIdentity(dir)` (`src/project/identity.ts:69`) → storage key;
  `resolveWorkspaceRoot(dir)` (`:100`) → filesystem root. Both spawn git with the argument as
  cwd. ⛔ **Never pass a file path**: git fails and the fallback returns the file's own realpath
  as the "project" (`identity.ts:85`).
- **Memo:** `canonicalProjectKey(raw)` (`src/sidecar/project-key.ts:53`, 10 s TTL, 512 entries,
  imports only `identity.ts`) — reuse it for the foreign-repo identity; it is plugin-safe.
- **Realpath helper:** `resolveRealPath` (`src/worktree/disk-scan.ts`, already imported by
  `identity.ts`); `isInside` in the same module.
- **Resolver contract** (from the master plan):
  1. Start at `dirname(filePath)`; climb to the nearest existing directory; `realpath` it.
  2. Climb to the nearest ancestor with a `.git` entry (`existsSync(join(dir, ".git"))` — file
     or directory). Stop at the filesystem root.
  3. No `.git` → session roots, `foreign: false`.
  4. `realpath(repoTop) === session.workspace` (session workspace is already a realpath — make
     the resolver realpath it too, defensively) → session roots, `foreign: false`, **no spawn**.
  5. Else `identity = canonicalProjectKey(repoTop)`, `workspace = repoTop`,
     `foreign = identity !== session.identity` (another worktree of the same repo is not
     foreign but has its own `workspace`).
  6. Never throws; never returns `""`. Accept relative `filePath` by resolving against
     `session.workspace`.
  - Signature: `resolveFileProject(filePath: string, session: { identity: string; workspace:
    string }, deps?: { exists?, realpath?, identity? }): { identity: string; workspace: string;
    foreign: boolean }`. Plus `sessionRootsFromCwd(cwd)` → `{identity: resolveProjectIdentity(cwd),
    workspace: resolveWorkspaceRoot(cwd)}` for CC hooks (one place, so hooks do not each spawn
    git twice — call it once per hook invocation).
- **TDD rule (master decision 4):** guard enforces if the **file's** project OR the **session**
  project has an active spec. TDD state stays file-keyed (`getTddState(filePath)`).
  - CC `tdd-guard.ts:71`: check `getCurrentSpec(file.identity)`, and if null and
    `file.foreign`, `getCurrentSpec(session.identity)`.
  - OC `sidecarTddGuard` (`sentinal.ts:287-312`): `getTddState(filePath, file.identity)`; if
    `!hasActiveSpec && foreign`, `getTddState(filePath, session.identity)` — two requests only
    for foreign files; no sidecar change, so old sidecars work.
- **TDD tracker rule (master):** rows are written with the **file's** identity.
  - Edit of a test file: `project = resolveFileProject(testFile).identity`; `specKey` = that
    project's current spec, else the session's (`spec.key ?? spec.id`).
  - Bash runs: `groupTestScopeByProject(runScope, session)` (Task 1) returns one
    `{identity, scope}` per project: named files/dirs grouped by their own project; a run naming
    none is project-wide for the project of `runScope.cwd`. For each group: list rows with
    `listActiveTddStates(groupSpecKey, identity)` where `groupSpecKey` = that project's current
    spec key **only for the session project's own group**, and `null` (no spec filter) for every
    other group — a sibling row may carry the session's spec id (written before the sibling had
    a plan), so filtering a foreign group by the sibling's spec would strand it forever. The
    project filter already scopes the read. Then the existing filter/transition logic.
    (`listActiveTddStates` filters `spec_id = ?` only when a spec key is given,
    `src/memory/store.ts:249-270`.)
  - `setTddState` upsert overwrites `project_path` (`store.ts:211`), so the first write with the
    file's identity re-keys a legacy row correctly.
  - OC `sidecarTddTrack` (`sentinal.ts:327-397`) and the `transitionTddState` helper it calls
    (find it with `grep -n "transitionTddState" targets/opencode/plugins/*.ts`): same grouping; one `/tdd-state/transition` call per group
    (`projectPath` = group identity, `testFiles`/`testDirs` = group scope).
- **Memory capture:** `projectPath = resolveFileProject(filePath, session).identity` when the
  event has a file path; for Bash with no file path, the project of the command's effective cwd
  (`testRunScope`-style `cd` parsing — expose `effectiveCwd(command, cwd)` from
  `src/utils/test-run-scope.ts`; OC also honours `args.workdir`); else the session identity. Add
  `metadata.sessionProject: session.identity` whenever the key differs. The CC event buffer stays
  under the session workspace (`memory-observer.ts:59-61`; it is per-session state, not a key).
  Sites: `memory-observer.ts:87`, `tool-failure-observer.ts:182`, OC `sentinal.ts:940-951`,
  `:974-987`, thrown failures `:546-562` (`failure.filePath`, `:455`).
- **Pre-edit hints:** `pre-edit-guide.ts:56-75` queries with `project: file.identity` (the direct
  fallback `getRecentForProject` must get the canonical identity, not raw cwd). OC
  `getPreEditGuide(sidecar, filePath, file.identity)` (`sentinal.ts:715`).
- **Conflict check:** `hook.ts:166-183` passes `file.identity` as `projectPath` to
  `detectFileConflict` (both sides are then file-keyed, since observations are).
- **Framework detection:** CC `hook.ts:129-132` → `processFileCheck(filePath, file.workspace)`
  (`file-checker.ts:57-59` uses its `cwd` arg for `detectFramework` + `runAngularChecks`). OC
  `sentinal.ts:768` → `detectFramework(file.workspace)`.
- **OC `apply_patch`:** args are `{patchText}` only. Add `patchFilePaths(patchText)` in
  `src/opencode/patch-paths.ts` (parse `*** Add File: `, `*** Update File: `,
  `*** Delete File: `, `*** Move to: ` lines; resolve relative to the session workspace). In
  `tool.execute.before`/`after`, treat `apply_patch` (and `patch`) as an edit tool and run the
  per-file guard/checks for each path (guard: block if any path is blocked). ⚠️ This is a
  **behaviour change for same-repo users too**: `apply_patch` edits were silently unguarded and
  unchecked before (approved in the master plan's cross-phase rules). Task 5 tests a same-repo
  patch being guarded and the README notes it.
- **OC compaction autocontinue** (`src/opencode/compaction-autocontinue.ts:55-58`): RED rows are
  kept when inside the session workspace **or** their file belongs to a project this session
  touched. The plugin keeps a `Set` of foreign identities it resolved (`touchedProjects`) and
  passes it in; keep the filter function pure.
- **CC hooks are fresh processes** — compute `sessionRootsFromCwd(input.cwd)` at most once per
  hook, and **lazily**: `tdd-guard` keeps its current fast paths first (`isGuardedFile`, then the
  file-keyed `readTddState` → `RED_CONFIRMED` returns) and resolves projects only when it might
  block. `sessionRootsFromCwd` spawns git twice; the same-repo short-circuit in the resolver
  needs only the workspace, so compute the session identity only when the file turns out
  foreign or a spec lookup needs it.
- **Signatures stay compatible (Wave 2 shares `hook.ts`).** `hook.ts` is owned by Task 4, but it
  dispatches Tasks 2 and 3's hooks. Tasks 2 and 3 must keep `processTddGuard`,
  `processTddTracking`, the observers' exported functions and their input types
  **source-compatible** (new fields optional, derived internally from `cwd` + file path), so
  `hook.ts` and the public `src/index.ts` exports need no change from them.
- **Signature changes and their callers:** `processPreEditGuide` gains an optional `project`
  (callers: `hook.ts` `runPreEditGuide`, its own `main` in `pre-edit-guide.ts`; default stays
  derived from `cwd`). `TestRunScope.cwd` is **optional** in the type (every producer sets it;
  hand-built literals elsewhere stay valid). `processFileCheck(filePath, cwd)` keeps its
  signature; callers pass the file's workspace.
- **Intentional same-repo change:** pre-edit-guide's direct fallback and the conflict check
  switch from the raw cwd to the canonical identity. From the repo root nothing changes; from a
  subdirectory or linked worktree they now find the project's rows (they missed them before).
  Task 4 adds a subdirectory test documenting this.
- **OpenCode plugin** roots are fixed at init (`sentinal.ts:507-512`): session =
  `{identity: projectIdentity, workspace: projectWorkspace}`.
- **Gotchas:** keep `src/project/*.ts` free of `bun:sqlite` (bundled into the plugin;
  `src/cli/target-assets.test.ts` guards the bundle). After editing the plugin run
  `bun run typecheck:plugin` and `bun run build:opencode`. File-length limits apply to `src/**`
  (plugin file exempt). TDD guard applies to this repo's `src/**`: failing test first, then
  `tdd_set_state RED_CONFIRMED`.

## Assumptions

- `.git` presence identifies a repo top for linked worktrees and submodules (both use a `.git`
  file) — verified convention; Tasks 1, 2-5.
- `canonicalProjectKey(repoTop)` returns the main checkout for a linked worktree
  (`identity.ts:69-87` uses `git worktree list` first entry) — Tasks 1, 5.
- No sidecar route change is needed: `GET /tdd-state` already takes a project
  (`tdd-routes.ts:245-258`); write routes canonicalize any supplied project — Tasks 3, 5.
- `listActiveTddStates(null, project)` returns the project's rows regardless of spec
  (`store.ts:249-270`) — Tasks 3, 5.

## Testing Strategy

- Unit: resolver with real temp git repos (`git init` in `mkdtempSync` dirs: session repo,
  sibling repo, linked worktree via `git worktree add`, nested submodule-style `.git` file, file
  outside any repo, non-existent new directory, symlinked checkout path).
- Unit per hook / helper with injected session roots and temp repos; existing test patterns:
  `src/hooks/tdd-guard.test.ts`, `tdd-tracker.test.ts`, `memory-observer.test.ts`,
  `pre-edit-guide.test.ts`, `file-checker.test.ts`, `targets/opencode/plugins/sentinal-helpers.test.ts`.
- Regression: every existing hook test still passes unchanged (same-repo path must be identical).
- Latency: `hyperfine --warmup 3` on `sentinal hook shared tdd-guard` (built `dist/sentinal`) with
  a same-repo file and a sibling-repo file; record numbers in the plan.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Same-repo path regresses (extra spawn or key change) | Med | High | Same-repo short-circuit before any spawn; existing tests unchanged; hyperfine check |
| Foreign spawn makes sync PreToolUse hooks slow | Low | Med | Only foreign files pay one git spawn; measured |
| Per-project grouping splits a run wrongly (relative paths, `cd`) | Med | Med | Grouping resolves the already-absolute paths `testRunScope` produces; tests for `cd ../b && bun test x.test.ts` |
| Legacy rows keyed to ops never transition | Low | Low | First write with file identity re-keys (`store.ts:211`); documented |
| `apply_patch` parse misses a format variant | Med | Low | Unknown lines ignored; a patch with no parsed path behaves as today |

## Pre-Mortem

1. **Realpath mismatch makes everything foreign** (Task 1) → Trigger: the macOS temp-dir test
   (`/var/folders` vs `/private/var/folders`) reports `foreign: true` for a session-repo file.
2. **Two specs in play give rows the wrong spec_id so GREEN never clears them** (Task 3) →
   Trigger: test "only session project has a plan, sibling test passes" leaves the sibling row
   RED.
3. **OC plugin bundle pulls `bun:sqlite`** via a new import (Task 5) → Trigger:
   `bun test src/cli/target-assets.test.ts` fails on the self-contained-bundle check.

## Execution Waves

**Wave 1** — Foundation: Task 1 (resolver + grouping + effective cwd). Every other task imports it.
**Wave 2** — Wiring (parallel): Tasks 2, 3, 4, 5 touch disjoint files (CC capture / CC TDD /
CC edit-time checks / OpenCode plugin).
**Wave 3** — Docs + measurement: Task 6.

## Goal Verification

### Truths

1. `src/project/file-project.ts` exports `resolveFileProject` and `sessionRootsFromCwd`; it
   imports nothing that reaches `bun:sqlite` (`bun test src/cli/target-assets.test.ts` passes).
2. A test creates repos A and B: from session A, `resolveFileProject(B/src/x.ts)` returns B's
   identity with `foreign: true`; `A/src/x.ts` returns A's with `foreign: false` and makes no git
   spawn (injected spy).
3. `memory-observer` test: an edit of `B/src/x.ts` from cwd A posts `projectPath` = B identity and
   `metadata.sessionProject` = A identity.
4. `tdd-guard` test: blocks `B/src/x.ts` (no RED) when only B has an active spec, and when only A
   has one; allows when neither does.
5. `tdd-tracker` test: from cwd A, `cd ../b && bun test src/x.test.ts` failing output turns B's
   TEST_WRITTEN row RED; a passing run clears it.
6. `grep -n "detectFramework(file" src/hooks/file-checker.ts src/cli/commands/hook.ts targets/opencode/plugins/sentinal.ts`
   (or equivalent) shows framework detection on the file's workspace in both targets.
7. `bun test`, `bun run typecheck`, `bun run typecheck:plugin`, `bun run lint`,
   `bun run format:check` pass.

### Artifacts

| Artifact | Provides | Exports |
| --- | --- | --- |
| `src/project/file-project.ts` | File → owning project | `resolveFileProject`, `sessionRootsFromCwd`, `FileProject` |
| `src/project/test-scope-projects.ts` | Test run → per-project scopes | `groupTestScopeByProject` |
| `src/utils/test-run-scope.ts` | Effective cwd | `TestRunScope.cwd`, `effectiveCwd` |
| `src/opencode/patch-paths.ts` | `apply_patch` file list | `patchFilePaths` |

### Key Links

| From | To | Via | Pattern |
| --- | --- | --- | --- |
| `src/hooks/tdd-guard.ts` | resolver | active-spec check | `resolveFileProject` |
| `src/hooks/tdd-tracker.ts` | grouping | bulk transitions | `groupTestScopeByProject` |
| `src/hooks/memory-observer.ts` | resolver | observation key | `resolveFileProject` |
| `src/cli/commands/hook.ts` | resolver | conflict + file-checker cwd | `resolveFileProject` |
| `targets/opencode/plugins/sentinal.ts` | resolver | all OC per-file sites | `resolveFileProject` |

## Progress Tracking

- [x] Task 1: Resolver, test-scope grouping, effective cwd (Wave 1)
- [x] Task 2: CC memory capture keyed by file project (Wave 2)
- [x] Task 3: CC TDD guard + tracker per project (Wave 2)
- [x] Task 4: CC pre-edit hints, conflict check, framework detection (Wave 2)
- [x] Task 5: OpenCode plugin wiring + apply_patch + autocontinue (Wave 2)
- [x] Task 6: Docs + latency measurement (Wave 3)

**Total Tasks:** 6 | **Completed:** 6 | **Remaining:** 0

## Implementation Notes

- **Latency** (Task 6; `bun run build:cli`, `hyperfine --warmup 3 --runs 30`, macOS, slow path of
  `sentinal hook shared tdd-guard` — guarded file, IDLE, no active spec; `SENTINAL_HOME` isolated;
  baseline = `e2cfc82` built the same way). Medians:

  | Edited file | Before | After |
  | --- | --- | --- |
  | same repo (`A/src/x.ts`, cwd A) | 113.7 ms | 115.0 ms |
  | sibling repo (`B/src/x.ts`, cwd A) | 112.7 ms | 130.1 ms |

- **Deviation (auto-fix, perf):** the first measurement showed the same-repo path +15 ms (129 ms):
  `sessionRootsFromCwd` resolved the workspace with `git rev-parse` before the short-circuit
  could compare. It now finds the workspace on the filesystem (nearest `.git` above the realpath'd
  cwd — the same walk the resolver does for files, so the two compare like with like) and falls
  back to `resolveWorkspaceRoot` only outside a checkout. The sibling path pays one git spawn
  (B's identity) plus the session identity for the either-project spec check.
- **Added helpers beyond the plan's artifact list:** `src/project/capture-project.ts`
  (`captureProject` — shared observation key for CC observers and the OC plugin),
  `preEditHookContext` (`pre-edit-guide.ts`, conflict + hint keyed once — `hook.ts` dispatches it),
  `fileCheckForEdit` (`file-checker.ts`, resolves the file's workspace only for Angular files),
  `tddGuardLookup` / `transitionTddStateByProject` (`sentinal-helpers.ts`), `toolFilePaths`
  (`patch-paths.ts`). `src/session/conflict.ts` changed only in its doc comment.
- OC pre-edit hint lookups do not mark a project as "touched" (only edits, test runs and captures
  do); `touchedProjects` feeds compaction autocontinue only.

## Implementation Tasks

### Task 1: Resolver, test-scope grouping, effective cwd

**Objective:** Provide the file → project resolver and the helpers every wiring task needs.
**Dependencies:** None
**Wave:** 1

**Files:**

- Create: `src/project/file-project.ts`, `src/project/file-project.test.ts`
- Create: `src/project/test-scope-projects.ts`, `src/project/test-scope-projects.test.ts`
- Modify: `src/utils/test-run-scope.ts` (add `cwd` to `TestRunScope`; export
  `effectiveCwd(command, cwd)`), `src/utils/test-run-scope.test.ts`

**Key Decisions / Notes:**

- Follow the resolver contract in Context for Implementer exactly; deps injectable for tests.
- `groupTestScopeByProject(scope, session, resolve = resolveFileProject)` →
  `Array<{ identity: string; workspace: string; scope: TestScopeInput }>`: files and dirs grouped
  by resolved identity; project-wide (`files === null`) → one group for `scope.cwd`'s project
  (resolve a directory by treating it as `join(dir, ".")`-style start — make the resolver accept
  directories too). Preserve `nameFiltered`.
- `effectiveCwd`: reuse the existing `segments(tokenize())` + `cd` handling; return `null` when
  the shell must resolve it (`~`, `$`, `-`).
- `PROJECT_WIDE` results carry `cwd` too.

**Definition of Done:**

- [x] Truths 1 and 2 hold
- [x] Tests cover: sibling repo, linked worktree of the session repo (`foreign: false`, own
      workspace), submodule-style `.git` file, outside any repo, new non-existent dir, symlinked
      session path, relative path
- [x] `testRunScope` returns `cwd` (post-`cd`) in every branch; existing tests unchanged

**Verify:**

- `bun test src/project/ src/utils/test-run-scope.test.ts src/cli/target-assets.test.ts`
- `bun run typecheck && bun run typecheck:plugin`

### Task 2: CC memory capture keyed by file project

**Objective:** Auto-captured observations are stored under the edited file's project.
**Dependencies:** Task 1
**Wave:** 2

**Files:**

- Modify: `src/hooks/memory-observer.ts`, `src/hooks/tool-failure-observer.ts`
- Test: `src/hooks/memory-observer.test.ts`, `src/hooks/tool-failure-observer.test.ts`

**Key Decisions / Notes:**

- Key = file project, else Bash effective-cwd project, else session (Context → Memory capture).
- `metadata.sessionProject` only when it differs from the key (keeps same-repo payloads
  byte-identical — existing tests must not change).
- Event buffer path unchanged.

**Definition of Done:**

- [x] Truth 3 holds; tool-failure equivalent (failed Edit on `B/x.ts`, failed
      `cd ../b && bun test`) keyed to B
- [x] Same-repo payloads unchanged (existing assertions pass)

**Verify:**

- `bun test src/hooks/memory-observer.test.ts src/hooks/tool-failure-observer.test.ts`

### Task 3: CC TDD guard + tracker per project

**Objective:** TDD gating and tracking follow the file's project (either-project rule).
**Dependencies:** Task 1
**Wave:** 2

**Files:**

- Modify: `src/hooks/tdd-guard.ts`, `src/hooks/tdd-tracker.ts`
- Test: `src/hooks/tdd-guard.test.ts`, `src/hooks/tdd-tracker.test.ts`

**Key Decisions / Notes:**

- Guard: Context → TDD rule. Tracker: Context → TDD tracker rule (per-group spec key or `null`).
- The `GREEN` skip for `nameFiltered` applies to every group.
- Keep the spec-event logging per group's spec.

**Definition of Done:**

- [x] Truths 4 and 5 hold
- [x] Mixed run `bun test a/x.test.ts ../b/y.test.ts` transitions each project's row under its
      own key; an unrelated project's RED row is untouched
- [x] Ordering test: B row written while only A had a plan (spec_id = A's), then B gets its own
      plan → a passing B run still clears the row
- [x] Guard fast paths unchanged: an unguarded or `RED_CONFIRMED` file spawns no git (spy)
- [x] Existing tests unchanged

**Verify:**

- `bun test src/hooks/tdd-guard.test.ts src/hooks/tdd-tracker.test.ts`

### Task 4: CC pre-edit hints, conflict check, framework detection

**Objective:** Edit-time context and checks use the file's project.
**Dependencies:** Task 1
**Wave:** 2

**Files:**

- Modify: `src/hooks/pre-edit-guide.ts`, `src/cli/commands/hook.ts` (`runPreEditGuide`,
  `runFileChecker`), `src/hooks/file-checker.ts` (standalone `main` path)
- Test: `src/hooks/pre-edit-guide.test.ts`, `src/cli/commands/hook.test.ts`,
  `src/hooks/file-checker.test.ts`

**Key Decisions / Notes:**

- `processPreEditGuide` takes the project identity to search (rename field or add `project`);
  direct fallback uses the canonical identity.
- `detectFileConflict(store, filePath, file.identity, session_id)`.
- `processFileCheck(filePath, file.workspace)`.

**Definition of Done:**

- [x] Editing `B/x.ts` from cwd A searches B's memories (test with injected client capturing
      the `project` param)
- [x] Angular repo B detected from session A (`angular.json` only in B) — test with
      `runAngularChecks` stubbed
- [x] Conflict check queries B's identity
- [x] Subdirectory test: from `A/src` as cwd, the pre-edit fallback and conflict check use A's
      canonical identity (documented same-repo fix)

**Verify:**

- `bun test src/hooks/pre-edit-guide.test.ts src/cli/commands/hook.test.ts src/hooks/file-checker.test.ts`

### Task 5: OpenCode plugin wiring + apply_patch + autocontinue

**Objective:** The OpenCode plugin applies the same per-file rules.
**Dependencies:** Task 1
**Wave:** 2

**Files:**

- Modify: `targets/opencode/plugins/sentinal.ts`, `targets/opencode/plugins/sentinal-helpers.ts`,
  `src/opencode/compaction-autocontinue.ts`
- Create: `src/opencode/patch-paths.ts`, `src/opencode/patch-paths.test.ts`
- Test: `targets/opencode/plugins/sentinal-helpers.test.ts`,
  `targets/opencode/plugins/sentinal.test.ts`, `src/opencode/compaction-autocontinue.test.ts`

**Key Decisions / Notes:**

- Sites and rules: Context → TDD rule (OC), TDD tracker rule (OC), Memory capture, Pre-edit,
  Framework detection, `apply_patch`, compaction autocontinue.
- `touchedProjects: Set<string>` of foreign identities, filled wherever the resolver returns
  `foreign: true`.
- Move testable logic into `sentinal-helpers.ts` / `src/opencode/*` (plugin file is exempt from
  length limits but should stay a thin wiring layer).
- After edits: `bun run typecheck:plugin`, `bun run build:opencode`.

**Definition of Done:**

- [x] Helper tests: guard (either rule, two lookups only for foreign), tracker grouping (one
      transition call per project), capture key + `sessionProject`, `patchFilePaths`
- [x] Autocontinue keeps a RED row of a touched foreign project
- [x] A same-repo `apply_patch` of a guarded file is TDD-guarded (new behaviour, tested)
- [x] `bun run typecheck:plugin` and `bun test src/cli/target-assets.test.ts` pass

**Verify:**

- `bun test targets/opencode/plugins/ src/opencode/ src/cli/target-assets.test.ts`

### Task 6: Docs + latency measurement

**Objective:** Document the resolver for developers and users; measure hook latency.
**Dependencies:** Tasks 2, 3, 4, 5
**Wave:** 3

**Files:**

- Modify: `.sentinal/rules/sentinal-project.md` (new subsection under Project Identity vs
  Workspace Root: the third resolver, its rule — file-scoped keys for per-file rows, session
  keys for session-level state — and the site list), `README.md` (How It Works: a short
  "Working across repositories" paragraph), this plan (measurements)

**Key Decisions / Notes:**

- `bun run build:cli`, then `hyperfine --warmup 3` piping a PreToolUse payload into
  `./dist/sentinal hook shared tdd-guard` for a same-repo and a sibling-repo file. Record medians.
- `bunx prettier --write README.md`.

**Definition of Done:**

- [x] Rule doc and README updated; measurements recorded here
- [x] Truth 7 holds (full suite + all gates)

**Verify:**

- `bun test && bun run typecheck && bun run typecheck:plugin && bun run lint && bun run format:check`
