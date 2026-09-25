# Hardening Sweep Implementation Plan

Created: 2026-09-24
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Bugfix

## Summary

**Goal:** Close findings #1–#10 from the Orca-support session: `quality_report` rewriting whole repos, missing lint config, the plugin ignoring `SENTINAL_HOME`, un-keyed notifications, raw project paths on sidecar routes (which also causes a wrong Stop block), un-scoped TDD writes, `specs.id` not project-qualified, the restore key/disk conflation, the migration ladder, noisy duplicate memories, oversized files, and E2E harness defects.

**Architecture:** Wave 1 splits the four near-limit files and makes independent fixes. Waves 2–4 build on the split files: canonical keys everywhere, then the key/disk split and `specs.id`, then notifications and server-side dedupe. Wave 5 is a lint cleanup pass and documentation. A one-off cleanup of the user's real database runs last, in the main context.

**Tech Stack:** TypeScript (strict), Bun 1.3.10, `bun:test`, SQLite + sqlite-vec, semantic-release.

## Scope

### In Scope

- **#1** `quality_report`: auto-fix only a given file; project-wide is check-only with a bounded report; honour tool exit codes; shipped prose updated.
- **#2** ESLint + Prettier as pinned devDependencies, flat config, `.prettierignore`, cheap findings fixed, flooding rules at warn. No CI gate.
- **#3** OpenCode plugin paths honour `SENTINAL_HOME`, read fresh.
- **#4** Notifications carry a canonical project for warning-level producers; `vector-init` joins the global allow-list.
- **#5** Sidecar read routes and `/spec/sync` canonicalize a supplied project; `syncFromPlanFile` canonicalizes at the single write point; raw-cwd callers fixed.
- **#6** `/tdd-state set` with no project infers it from the file path (hard requirement deferred).
- **#7** `specs.id` becomes a project-qualified opaque key (V14, no table rebuild); `restoreContext` splits storage key from workspace; migration runner runs every unrecorded step.
- **#8** "Fixed issue" capture trigger fixed; server-side dedupe for auto-captured observations; one-off merge of duplicates and deletion of provable false positives in the user's DB.
- **#9** `update.ts`, `slots.ts`, `migrations.ts`, `routes.ts` split by cohesion, public exports stable.
- **#10** Stop-guard false "orphaned" block (raw-path spec rows) fixed; E2E harness refuses a stale `dist/sentinal`, matches sandbox processes by environment, and replaces the whole-`~/.sentinal` hash with attributable-write checks.

### Out of Scope

- Making `/tdd-state` without a project a hard 400 (a later release).
- ESLint as a CI gate.
- Orca `orchestration` / other Orca hooks (#11–#13).
- The changelog-audit master plan drift.

## Context for Implementer

> This checkout is a linked git worktree of `/Users/evan/Projects/endpoint_esports/sentinal` (Orca). Read `.sentinal/rules/sentinal-project.md` first — identity → storage keys only; workspace → filesystem only.

### #1 facts (verified)

- `src/sidecar/quality-runners.ts`: `runEslint` `target = filePath ?? "."` (:251), always `eslint --fix` (:263). `runPrettier` (:299-356): `--check`, then `--write <target>` on ANY non-zero exit, and returns `ok:true, autoFixed:true` without reading `fix.exitCode`. `--check`'s file list is discarded (`errors: []`). ESLint `autoFixed` mtime check uses `existsSync(filePath)` relative to the sidecar cwd, not `projectPath`.
- Measured: `prettier --write .` on this repo would touch **85 files** (CHANGELOG, 41 docs, both shipped `verification.md`, `.sentinal/*.json`).
- Only live caller: the MCP tool `quality_report` (`src/analysis/mcp-tools.ts:256-333`, description :258 promises auto-fix; `file` "If omitted, project-wide" :261-266) and sidecar `/quality-check` (`quality-routes.ts:101-141`, default checks all three :44). Edit hooks no longer call it. `src/checkers/typescript.ts:8-82` is dead code (only its own test).
- Tests (`quality-routes.test.ts:70-139`, `client.test.ts:525-538`, `analysis/mcp-tools.test.ts:537-551`) run the REAL `bunx prettier/eslint --fix` on repo source files — network-dependent and potentially mutating. Replace with fake binaries (pattern: hung-dir `quality-routes.test.ts:197-214`).
- Shipped prose driving it: `targets/{claude-code,opencode}/rules/verification.md:81,85,89`, `development-practices.md:20,22`, `targets/claude-code/commands/spec-implement.md:153,197` / `targets/opencode/skills/spec-implement/SKILL.md:147,193` (sub-agent prompt with no file), `spec-bugfix-verify.md:56` / OC `SKILL.md:54` (eslint, no file → `eslint --fix .`). Stale "runs on every edit": README.md:48,379,410,421-423, `targets/claude-code/settings.json:19`, `src/cli/commands/install-constants.ts:69`.

### #2 facts (verified, measured in a temp dir)

- No eslint/prettier devDependency or config; `getToolCommand` falls back to unpinned `bunx`.
- Baseline (eslint 10.11, typescript-eslint 8.70, recommended, non-type-checked; ignoring dist, node_modules, `src/cli/embedded-assets.ts`, `targets/opencode/dist`, docs): **301 errors, 2 warnings, 93 files**. Tuned config (ignore `targets/opencode/tests/fixtures/**`; `no-unused-vars` with `^_` ignore patterns; `no-empty` `allowEmptyCatch`; tests: `no-explicit-any` + `no-require-imports` off) → **101 findings, 60 files**: unused-vars 66, no-require-imports 17 (mostly deliberate lazy requires — e.g. `client.ts:86`), no-useless-assignment 6, no-explicit-any 5, prefer-as-const 2, useless-escape 1, unused directives 4. `bun add` defaults to TypeScript 7 — pin typescript 5.

### #3 facts

- `targets/opencode/plugins/sentinal.ts:213` `SENTINAL_DIR = join(homedir(), ".sentinal")` at module load; used at :228 (sidecar pid), :240 (binary to spawn), :254 (pid read + unlink in `stopProcess`), :553 (`config.json`). `ensureDashboard` already uses `getSentinalBinPath()` (honours `SENTINAL_HOME`) — so today the dashboard and sidecar come from different trees when it's set.
- Fresh-reading helpers already in the bundle (no bundle growth): `getSentinalHome()` (`db-path.ts:34-40`), `getSidecarPidPath()` (`sidecar/paths.ts:22-32`), `getPidFilePath()` (`dashboard/lifecycle.ts:16-17`), `getSentinalBinPath()` (`dashboard-ensure.ts:28`), `getConfigPath()` (`memory/config.ts:56-58` — path only; `loadConfig` caches).
- Plugin tests don't stub the base dir: every init reads the REAL `~/.sentinal/sidecar.pid`/`config.json` and may spawn the REAL binary.

### #4 facts

- Route `handleInsertNotification` (`routes.ts:484-505`) drops `projectPath`; `SidecarClient.insertNotification` (`client-routes.ts:350-359`) has no field. Only the session-start digest reads `project_path` and filters only unread + project/global — no type filter.
- Producers: `spec_notify` (`src/spec/events-mcp-tools.ts:61` client, `:68` direct), `stop-failure.ts:29` (warning, API error), `config-change.ts:67` (warning; project-scoped only when `file_path` is inside the project's `.claude/`, else global), `vector-stats.ts:64` (`vector-init`, global warning), `retire-notify.ts:63` (global, allow-listed), `self-heal.ts:157` (global info), `routes.ts:224` + `session-end.ts:38` (info), `task-created.ts:23` (info). Hooks set no `source`.

### #5 / #10a facts — the Stop-guard bug

- `register-plan` (`src/cli/commands/register-plan.ts:22,47-51`) and Claude Code `pre-compact` (`src/hooks/pre-compact.ts:54` via sidecar, `:73-77` direct) store `specs.project_path` from the RAW path. Sidecar `/spec/sync` (`routes.ts:363-378`) does not normalize. Since v1.37.1 `resolveStopDecision` looks up the owner under `resolveProjectIdentity(searchDir)` (`ownership.ts:115-119`, `:171`). A raw `/var/…` (macOS tmp), subdirectory or linked-worktree key never matches → plan reads as ownerless → **Stop is blocked as "orphaned"**. Reproduced; re-registering with the realpath allows the Stop. Real impact: any Claude Code session whose compaction runs from a subdirectory/symlink/worktree.
- Other raw callers: `tdd-tracker.ts:77`, `tdd-guard.ts:68` call `getCurrentSpec(cwd)`; `hooks/memory-restore.ts:41` and `pre-compact.ts:51` send raw cwd to `/context`; `workspace-adaptor.ts:151` sends raw dir (and `""` → 400) to `/spec/current`.
- Read routes (`routes.ts`): `handleMemorySearch` :398, `handleMemoryTimeline` :416, `handleGetCurrentSpec` :390 (required), `handleGetTddState` :235 (optional), `handleListTddStates` :510 (no project param at all), `handleRestoreContext` :348 (required; ALSO a disk path — see #7B).
- ⛔ For READS, absent/blank means "all projects" — `normalizeProjectKey` (rejects blank) is wrong for reads. Use a read variant: blank → undefined, else `resolveProjectIdentity`. Do NOT normalize `/project-context` or `/config/compaction` (disk paths).
- Three near-copies of the blank-rejecting normalizer: `routes.ts:163`, `notification-routes.ts:36`, `tdd-routes.ts:86-92`.
- `SpecStore` comment (`status-mcp-tools.ts:139-143`) says it deliberately doesn't normalize to keep `/test/project` keys working. `resolveProjectIdentity` of a non-existent path returns `resolve(p)` — stable — but a real tmpdir becomes `/private/var/…`; tests that store raw then read via a route must use realpaths.

### #6 facts

- `handleSetTddState` (`routes.ts:250-308`): absent project on `set` → stored NULL and logged. Every current caller sends one; v1.37.1 and older plugin/`tdd_set_state` do not, and swallow a 400. `filePath` is absolute for all current callers.

### #7 facts

- **A.** Five FKs to `specs(id)` (migrations.ts :289 `spec_tasks` NOT NULL ON DELETE CASCADE + UNIQUE(spec_id, position); :340 `notifications`; :361 `tdd_cycles`; :377 `spec_events` NOT NULL; :435 `worktrees`), none ON UPDATE CASCADE; `foreign_keys = ON` on every connection (`store.ts:46`). `slug` column exists (= id today). **Rehearsed on a copy of the user's DB:** in one transaction with `PRAGMA defer_foreign_keys = ON`, rewriting `specs.id` and all five child columns from a temp map commits cleanly — 371 specs, 1,579 tasks, `foreign_key_check` empty. User DB: 7 distinct projects, 0 cross-repo filename collisions today, 1 misfiled row (`2026-03-12-stale-sidecar-cleanup` under passbot-platform), 1 under a deleted `.sentinal/worktrees/spec-*` path. Callers see the bare slug via `deserializeSpec` (`store.ts:533-547`) and compare it with parsed plans (`ownership.ts:118`, plugin `sentinal.ts:1425`, `spec_metrics` default) — keep `Spec.id` = slug in the API and add `key` + `projectPath`.
- **B.** `RestoreOptions.projectPath` (`restore.ts:21-34`, public via `src/index.ts:56-57`) is used as key (:85,:117,:121,:139,:205) AND disk path (`mergeSharedObservations` :152-183 → `readSharedMemory`). CC hooks send raw cwd (so in a worktree/subdir restore finds NO memories — a live bug); the plugin sends identity (so shared memory is read from the main checkout). `/context` = `GET ?project=&semanticQuery=`.
- **C.** `runMigrations` uses `MAX(version)` (migrations.ts :21-24, :36-48); V11 records unconditionally (:206). User DBs have no gaps.

### #8 facts (from the user's DB, 1,477 observations)

- "Fixed issue in X" = **775 rows (52%)**, all from the OpenCode plugin, rule `detectErrorFixSequence` (`capture.ts:196-215`). Defects: `ERROR_INDICATORS` includes `/\bfail\b/i` (:86), which matches every passing bun run's ` 0 fail` (147 rows' "error" is a passing run); `hasRecentError(5)` (:151-162) never consumes the error; the window includes the current event (callers push before analysing — `sentinal.ts:913-914`, `memory-observer.ts:64-65`); `.md` files count as fixes (103 rows); 6 are `(no output)`.
- Exact duplicate groups (same project/type/title/content): 175 groups, **480 redundant rows** — 233 "Fixed issue", 217 "Instructions loaded: CLAUDE.md" (hotspawn-community; the hook's rows have no `metadata.source`).
- Vectors: several chunk rows per observation keyed by aux `observation_id` (title, content, one per tag). Delete by `SELECT rowid … WHERE observation_id IN (…)`; verify with COUNT (vec0 `changes()` unreliable). Needs Homebrew SQLite + vec0.
- Existing dedupe (`service.ts:129-152`, `store-observations.ts:158-202`) is error-only and signature-only; sidecar takes it only when the client sends a signature (`routes.ts:341-345`); CC direct fallback always plain `addObservation` (`memory-observer.ts:116`).

### #9 facts

- Limits: warn 400, block 600 (`src/utils/file-length.ts:1-2`); tests exempt via `TEST_PATTERNS` (:4-10) — **gap: `*.e2e.ts`, `*.spec-e2e.ts`, `.test.tsx` are not exempt**. The TDD guard also doesn't treat `*.spec-e2e.ts` as a test.
- Proposed splits (keep every public export via re-exports from the original module):
  - `update.ts` (597) → `update-github.ts`, `update-check.ts`, `update-download.ts`, `update-reinstall.ts`; `update.ts` keeps `registerUpdateCommand`.
  - `slots.ts` (574) → `slot-env.ts` (constants, `readSlotFromWorktree`, `formatSlot` — breaks the `worktree-config.ts` ↔ `slots.ts` cycle so the lazy `require` can go), `slot-scope.ts`, `slot-pool.ts`, `slot-messages.ts`. ⛔ Keep `reslotLosers` with `tryAssignFreeSlot` (mutual calls; a TDZ bug already happened here).
  - `migrations.ts` (530) → `migration-helpers.ts`, `migrations-legacy.ts` (V1–V10, in order), `migrations-v11.ts`, `-v12.ts`, `-v13.ts`; `migrations.ts` keeps `runMigrations`.
  - `routes.ts` (524) → `memory-routes.ts` (`/observation`, `/context`, `/memory/*`), `session-routes.ts`, TDD get/set/list into `tdd-routes.ts`, spec routes into `spec-routes.ts`, `POST /notification` into `notification-routes.ts`, and `project-key.ts` (one normalizer + read variant). ⛔ Keep `handleSidecarRequest` as the dispatcher calling sub-handlers inside its existing try/catch (500-as-JSON; `routes.test.ts` drives it).

### #10b facts

- `tests/e2e/harness/sandbox.ts:106` prefers `dist/sentinal` if present — the user's is **v1.36.3 (Sep 7)**; the failing test passes against it and fails against HEAD source.
- `killSandboxProcesses` (:311-338) matches the command line, but sandbox sidecar/dashboard command lines don't contain the sandbox path (it's only in env) → 3 processes leaked in the exploration run and recreated deleted sandbox dirs.
- `snapshotRealDirs` (:280-296) hashes all of `~/.sentinal` (**506 MB**) every test and trips on any live write (`plugin.debug.log`, `memory.db-wal`).

### Cross-cutting gotchas

- `quality_report` is itself broken until Task 5 lands — until then call it ONLY with a `file` (it runs project-wide prettier `--write` otherwise).
- Root tsconfig excludes `targets/` — type-check the plugin with `.sentinal/skills/sentinal-opencode-api-source/scripts/typecheck-plugin.sh`.
- Editing `targets/*/rules|commands|skills` → one baseline-regenerating task per wave (`sentinal-parity-baselines`); run `bun run embed-assets` afterwards.
- `src/cli/embedded-assets.ts` is gitignored and regenerated.
- Test timeouts: explicit 3rd arg for anything spawning git or subprocesses.

## Assumptions

- A project-qualified `specs.id` with `Spec.id` = slug in the public shape leaves the plugin's parsed-id comparisons working unchanged — supported by the three compare sites all using parsed bare filenames. Task 13.
- Deferred FK rewrite works in the live migration path (connection opened by `MemoryStore` with `foreign_keys = ON`) — rehearsed on a copy; Task 13 must rehearse it through `runMigrations` itself.
- Old (≤1.38) sidecars keep running until retired; server-side changes must tolerate old clients and client changes must tolerate old sidecars (extra params ignored).

## Key Decisions

- **D1 — Project-wide `quality_report` is report-only.** Auto-fix applies only to an explicit `file`, resolved against the project and refused outside it. Prettier `--write` only on check exit 1 (unformatted), never on 2 (tool error).
- **D2 — ESLint: pinned devDependencies, tuned flat config, `no-unused-vars` and `no-explicit-any` start at warn; deliberate lazy `require`s get per-line disables with a reason.** No CI gate.
- **D3 — Reads fail open, writes normalize.** A supplied project is canonicalized on every route; an absent one on a read still means "all projects". `syncFromPlanFile` canonicalizes at the single write point.
- **D4 — `/tdd-state set` without a project infers it** from the nearest existing ancestor of `dirname(filePath)`; relative paths rejected. Hard 400 deferred.
- **D5 — Notifications:** project on `spec_notify`, `stop-failure`, `config-change` (project file only), each with a `source`; info producers stay NULL; `vector-init` added to `GLOBAL_NOTIFICATION_SOURCES`.
- **D6 — `specs.id` = `<canonicalProject>::<slug>`, opaque, never parsed; unique index on `(project_path, slug)`; API keeps `id` = slug and adds `key`.** Agent-supplied spec ids resolve via `resolveSpecKey(value, project?)`: exact key → (project, slug) → unique slug → ambiguous = refuse (or NULL for notifications). V14 rewrites keys with deferred FKs in one transaction, stripping `/.sentinal/worktrees/spec-*` suffixes from project paths.
- **D7 — Migration runner runs every unrecorded step** in order (set of recorded versions, not `MAX`); V11 records only after verification; silent when nothing to do.
- **D8 — Restore splits key and workspace:** `RestoreOptions.workspacePath?` (defaults to `projectPath`); `/context&workspace=`; the sidecar derives the key from `project` (canonical) and the workspace from `workspace ?? resolveWorkspaceRoot(project)`.
- **D9 — "Fixed issue" capture:** error indicators require non-zero counts; an error is consumed by the fix it produces; the current event is excluded; `.md`/`docs/` edits never count as fixes; a known exit code overrides text heuristics.
- **D10 — Server-side dedupe for auto-captures:** signature = sha1(type | title | normalized content) over 30 min; `type=fix` auto-captures also collapse same (project, title) within 5 min. `instructions-loaded` gets a dedupe key. Direct fallbacks use the deduped path.

## Plan Review (2026-09-24) — 3 must_fix, 6 should_fix, 3 consider

| Finding | Resolution |
| --- | --- |
| **must** Keeping `Spec.id` = slug means FK writers outside Task 13 (tdd-tracker, store TDD/events, stampPlanOwner, native-tdd-status, spec-metrics chain) send the slug where the key is required — TDD tracking would silently stop | Files added to Task 13; every FK writer uses `spec.key`, one test per writer |
| **must** `defer_foreign_keys` has no effect outside a transaction; `runMigrations` runs outside one | V14 opens its own transaction and sets the pragma first; tested |
| **must** Re-pointing a collision loser's tasks violates `UNIQUE(spec_id, position)` | Delete the loser's tasks/events; re-point only nullable references |
| should: canonical writes but raw reads miss on macOS tmp | Store reads canonicalize too |
| should: git spawn per plan file in `syncAll` | Resolve once per call |
| should: Task 11 needs `memory-observer.ts` and the plugin | Added; plugin ownership sequenced |
| should: Task 13 overlaps Task 12 on client-routes/plugin | Task 13 moved to its own wave |
| should: V14 string-only canonicalization leaves duplicates | `realpathSync` in V14 + runtime re-key for linked-worktree keys |
| should: Task 5 misses client types / index export | Added |
| should: Task 18 rule needs the classifier, must run after deploy, keepers need signatures | Adopted |
| consider: splits are spy-safe if moved code imports dependencies directly | Noted in Testing Strategy |
| consider: kill by sandbox pidfiles; row-count escape check | Adopted in Task 8 |
| consider: `.test.tsx` exemption not needed | Kept (harmless, one line) |

## Implementation Notes (Wave 1)

- Full suite after Wave 1: 3,777 pass / 0 fail; tsc clean.
- Task 5 added `src/sidecar/quality-lint.ts`, `quality-summary.ts`, `src/analysis/quality-format.ts` (+ tests) for length. The MCP tool runs project-wide eslint/prettier **in-process**, never via the sidecar, because a ≤1.38 sidecar would still run `--write .`/`--fix .`; with a `file` it sends an absolute resolved path. `client-routes.ts` unchanged.
- Task 1: the dispatcher now `await`s sub-handlers, so async throws become the same 500 JSON inside `handleSidecarRequest` (previously produced by the server's `errorHandler`).
- Task 2: `getVersionForUpdate` replaced by `getSentinalVersion` (identical resolution, cached).
- Task 8 added `tests/e2e/harness/real-escape.ts` and `sandbox-procs.ts` (sandbox.ts would have been 837 lines). DB row check counts only rows keyed to tmp paths / test session ids (table totals move with the live sidecar). The user's real DB already holds 5 `sessions` rows keyed to tmp paths (earlier escapes).

## Implementation Notes (Wave 2)

- Full suite after Wave 2: 3,850 pass / 0 fail; tsc + plugin type-check clean.
- Task 10: `canonicalProjectKey` (memoized `resolveProjectIdentity`, 10 s TTL, 512 entries) in `src/sidecar/project-key.ts`, used by routes and `SpecStore` (reads and writes). `/tdd-state set` without project infers from the nearest existing ancestor (an absolute path with no existing ancestor infers `/`). `/tdd-state/list?project=`. e2e "DIFFERENT LIVE session stops → ALLOWED" passes against HEAD source (mutation-checked). `src/spec/mcp-tools.test.ts` re-key test now plants the stale row with raw SQL. `store.ts` 573 / `client-routes.ts` 412 lines (were already over 400).
- Task 11: pure classifier `isErrorOutput(text, exitCode?)` in new `src/memory/error-classifier.ts` (Task 18 reuses it). Consumption is a `consumedBy` marker on the buffered event (persisted in CC's `<cwd>/.sentinal/event-buffer.json`, identity in the plugin), per rule. `capture.ts` 540 lines.
- Task 9: prose updated in both targets; only `spec-implement.diff` line headers moved. Dev rules `sentinal-hooks-development.md` / `sentinal-dual-target.md` still claim hooks run Prettier/ESLint → Task 17. Plugin header comment (`sentinal.ts:5`) claims auto quality checks on edit → fix in Task 12.

## Implementation Notes (Waves 3–4)

- **Task 12:** `RestoreOptions.workspacePath`; `/context&workspace=` (absent → `resolveWorkspaceRoot(raw project)`, so an old CC hook sending its raw worktree cwd gets canonical memories AND the worktree's shared memory, while the plugin's identity-only call is unchanged); client 3rd arg; both CC hooks and the plugin send identity + workspace. Real linked-worktree test with an uncommitted shared entry; mutation-checked. Plugin header comment fixed.
- **Task 13 — deviation (robustness):** instead of relying on every caller switching to `spec.key`, every store method that takes a spec id resolves it at the store boundary (`src/memory/spec-key.ts`, not `src/spec/` — avoids a memory→spec import cycle): `resolveSpecKey` (lookups; strict within a supplied project) and `resolveSpecKeyForWrite` (FK writers; project first, then a unique slug; ambiguous → refused: raw value passed through so the FK fails loudly, or NULL for notifications). Old plugins/agents sending a slug therefore still write the key. `tdd-tracker` uses `spec.key` (its test reproduced the review's predicted FK crash first).
- Worktree cleanup's `isPlanActive` uses the new project-blind `SpecStore.isSlugInProgress` — fail-safe for a destructive guard.
- `spec_metrics` / `/spec/metrics` / `client.getSpecMetrics` and both TDD list tools pass the project.
- V14 never throws out of the MemoryStore constructor: on failure it rolls back, logs, leaves the version unrecorded and retries next start; FK violations that predate V14 are baselined, not fatal. Runner D7: every unrecorded step above the lowest recorded version (a DB seeded at version N never recorded 1..N-1).
- `SpecStore.auditCompletion` moved to `src/spec/audit.ts` (length); `store.ts` 549 lines.
- `TddCycle.specId` / events now expose the stored key (round-trips exactly into `tdd_clear`).
- **Rehearsal on a copy of the real DB through `runMigrations`:** 179 ms; 371/371 specs re-keyed; tasks 1,597, events 369, notification links 98, worktree links 2 — all preserved; `foreign_key_check` empty; 0 orphan tasks; 7 → 6 projects (the deleted `.sentinal/worktrees/spec-*` row folded into sentinal); the misfiled `2026-03-12-stale-sidecar-cleanup` stays under passbot-platform (registered there; V14 does not guess); no slug collisions.

- Full suite after Wave 4: 3,894 pass / 0 fail; tsc + plugin type-check + bundle clean.

## Implementation Notes (Wave 5)

- Full suite after Wave 5: 3,953 pass / 0 fail; tsc + plugin type-check + bundle clean.
- **Task 14:** route `projectPath` optional (absent → NULL; blank → 400); client field optional; `spec_notify` gains optional `project` (defaults to the MCP server cwd's identity) and `source: "spec-notify"` — so its *info* notices now also reach that project's digest (visible change, per D5); `stop-failure` / `config-change` (in-workspace files only) set project + source; `vector-init` global. Plugin has no notification producer.
- **Task 15:** `src/memory/dedupe-signature.ts` (pure, exported for Task 18): signed when `source ∈ {auto-capture, auto-capture-failure}` or `dedupeKey` set; `sha1(type | normalizeVolatile(title) | key:<dedupeKey> or normalized content)`; a client error signature still wins. Normalizer also drops a capped section's partial last line (capture truncates at fixed lengths). 30 min signature window; auto-captured `fix` also collapses same (project, title) within 5 min; repeats bump `occurrences`/`lastSeen`, no re-embed. `/observation` always deduped; CC direct fallback too; `instructions-loaded` sends `source` + `dedupeKey: file_path`. `service.ts` 469 lines, `store-observations.ts` 400.

## Implementation Notes (Wave 6)

- **Task 16:** `bunx eslint .` → 0 errors, 0 warnings (was 23/70). Behaviour-preserving; 3 lazy `node:` requires in CLI-only files became static imports; deliberate lazy requires kept with reasoned disables (`sidecar/client.ts`, `sidecar/version.ts`, `runtime/ownership.ts`, `sidecar/lifecycle-start.ts`, `opencode/workspace-adaptor.ts`). Unused params removed from `registerSpecRegisterTool` / `registerSpecInitTool` (internal). Possibly-dead exports left (public API).
- **Task 17:** `.sentinal/rules/sentinal-{project,mcp-servers,sidecar,hooks-development,dual-target,testing}.md` and the `sentinal-e2e-harness` skill (1.2.0) updated; stale FK line numbers replaced; limitation 2 marked resolved.

## Verification (2026-09-25)

- Full suite 3,953 pass / 0 fail; `bunx tsc --noEmit` clean; plugin graph type-checks; `bunx eslint .` 0 errors / 0 warnings; OpenCode bundle guard green; `spec-workflow.e2e.ts` + harness self-tests 40 / 0 against HEAD source (no `dist/sentinal`).
- Truths: 1 (argv tests, Task 5) ✅ · 2 (eslint clean) ✅ · 3 (SENTINAL_HOME test) ✅ · 4 (raw-alias Stop ALLOW, unit + e2e) ✅ · 5 (two rows per same-named plan; V14 test + real-DB rehearsal) ✅ · 6 (linked-worktree `/context`) ✅ · 7 (no fix after passing run; 10 → 1 row) ✅ · 8 (splits < 400, exports unchanged) ✅ · 9 (DB cleanup) ⏳ Task 18, after deploy.
- Fix/preservation pairs: every fix has its negative case (blank project = all projects; identity-only `/context` unchanged; manual observations never deduped; genuinely different content not collapsed; ambiguous slug refused; other project's same-slug row untouched; exit-0 error text not an error; old clients without new params).

## Deferred Issues

- **Concurrent agents lose TDD state.** During Wave 1 each parallel agent's `RED_CONFIRMED` states were reset to IDLE by another agent's test run/clear within seconds (project-wide GREEN/clear transitions). Workaround: set state immediately before each write. Not in #1–#10 scope.

## Testing Strategy

- Real git fixtures for identity-sensitive tests; realpath temp dirs.
- Refactors (Tasks 1–4) must be behaviour-preserving: full suite green with **no test edits** other than import paths, and exported symbols unchanged (verified by an export-surface check). Moved code must import its dependencies from their modules directly (not bind them locally), so existing `spyOn(dependencyModule, …)` stubs still intercept.
- Mutation-test discriminating assertions.
- Each commit must pass standalone (`.sentinal/skills/sentinal-logical-commits`).

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| A file split changes behaviour or drops an export | Medium | High | No test edits besides imports; export-surface diff; full suite per split |
| V14 key rewrite corrupts FKs on a real DB | Low | **High** | Rehearse on a copy of the user's DB via `runMigrations`; verify-before-bump; `foreign_key_check`; backup (automatic) |
| Old sidecar + new clients during rollout | High | Medium | All new params optional; extra params ignored by old sidecars; old writers hit the new unique index loudly, not silently |
| Tightened capture heuristics drop real signal | Medium | Low | Counts in `occurrences`; TDD and build-fix rules keep working (tests) |
| DB cleanup deletes real memories | Low | **High** | Backup; dry-run with counts shown to the user first; rehearse on a copy; limit to exact duplicates and three provable false-positive classes |
| Lint pass edits the same files other tasks edit | High | Medium | Lint pass alone in Wave 5, after all code changes |
| Removing real-tool tests from `quality_*` loses coverage | Medium | Low | Fake binaries assert exact argv (`--write`/`--fix` presence) |

## Pre-Mortem

1. **The Stop still blocks from a subdirectory after the fix,** because some remaining writer stores a raw key (another caller of `syncFromPlanFile` we missed). (Task 10) → Trigger: the e2e "DIFFERENT LIVE session stops → ALLOWED" still fails against HEAD source. Guarded by canonicalizing inside `syncFromPlanFile` itself.
2. **V14 fails on a user DB with an unexpected shape** (e.g. a spec row whose project path no longer exists, or two rows that collide once keys are canonicalized). (Task 13) → Trigger: the rehearsal on the copy reports a unique-index conflict. Collisions must be resolved deterministically (keep newest `updated_at`, re-point children), not crash.
3. **The dedupe hides real repeats of a genuine failure.** (Task 15) → Trigger: `occurrences` never increments in tests because signatures differ by volatile content the normalizer missed.

## Execution Waves

**Wave 1** (parallel): Tasks 1, 2, 3, 4, 5, 6, 7, 8 — four pure splits plus four independent fixes, disjoint files.
**Wave 2** (parallel): Tasks 9, 10, 11.
**Wave 3**: Task 12.
**Wave 4**: Task 13 — alone: once its file list is complete it touches `client-routes.ts` and the plugin, which Task 12 also edits (review finding).
**Wave 5** (parallel): Tasks 14, 15.
**Wave 6** (parallel): Tasks 16, 17.
**Task 18** (DB cleanup) runs in the main context after verification.

Shared-file ownership across waves: `client-routes.ts` (T5 → T10 → T12 → T13 → T14), `memory-routes.ts` (T10 → T12 → T15), `spec/store.ts` (T10 → T13), `pre-compact.ts` (T10 → T12), `events-mcp-tools.ts` (T13 → T14), `memory-observer.ts` (T11 → T15), plugin (T7 → T11 → T12 → T13), `migrations*` (T4 → T13), `tdd-tracker.ts` (T10 → T13).

## Goal Verification

### Truths

1. A `quality_report` call without `file` never passes `--write` or `--fix` (fake-binary argv test), and lists unformatted files.
2. `bunx eslint .` runs with the repo config and exits 0 or with warnings only after Task 16.
3. With `SENTINAL_HOME` set, the plugin reads/spawns only under it (test).
4. A spec registered from a symlinked/subdirectory path is found by `resolveStopDecision` from the canonical root (unit test); the e2e ALLOW case passes against HEAD source.
5. `specs` rows have `id = <project>::<slug>` after V14; two projects with the same plan filename keep separate rows (test).
6. From a linked worktree, `/context` returns the canonical project's memories and reads shared memory from the worktree (test).
7. A passing bun run followed by edits produces no "Fixed issue" observation (test); ten identical auto-captures produce one row.
8. The four split files are each under 400 lines and every previously exported symbol is still exported from the same module path.
9. The user's DB has no exact-duplicate auto-capture groups and none of the three false-positive classes after Task 18.

## Progress Tracking

- [x] Task 1: Split `routes.ts` + shared project-key module (Wave 1)
- [x] Task 2: Split `update.ts` (Wave 1)
- [x] Task 3: Split `slots.ts` (Wave 1)
- [x] Task 4: Split `migrations.ts` (Wave 1)
- [x] Task 5: `quality_report` check-only project-wide (Wave 1)
- [x] Task 6: ESLint + Prettier config and devDependencies (Wave 1)
- [x] Task 7: Plugin honours `SENTINAL_HOME` (Wave 1)
- [x] Task 8: E2E harness fixes + test-file exemptions (Wave 1)
- [x] Task 9: Shipped prose for `quality_report` and stale docs (Wave 2)
- [x] Task 10: Canonical project keys on routes and spec writes; infer TDD project (Wave 2)
- [x] Task 11: Fix the "Fixed issue" capture trigger (Wave 2)
- [x] Task 12: Restore key/workspace split (Wave 3)
- [x] Task 13: Project-qualified `specs.id` (V14) + migration runner (Wave 4)
- [x] Task 14: Notifications carry a project (Wave 5)
- [x] Task 15: Server-side dedupe for auto-captured observations (Wave 5)
- [x] Task 16: Lint cleanup pass (Wave 6)
- [x] Task 17: Documentation (Wave 6)
- [ ] Task 18: One-off cleanup of the user's DB (main context)

**Total Tasks:** 18 | **Completed:** 17 | **Remaining:** 1

## Implementation Tasks

### Task 1: Split `routes.ts` + shared project-key module

**Objective:** Bring `src/sidecar/routes.ts` (524) under 400 lines by cohesion, and replace three normalizer copies with one module. Behaviour-preserving.
**Dependencies:** None
**Wave:** 1

**Files:**
- Modify: `src/sidecar/routes.ts`, `src/sidecar/spec-routes.ts`, `src/sidecar/tdd-routes.ts`, `src/sidecar/notification-routes.ts`
- Create: `src/sidecar/memory-routes.ts`, `src/sidecar/session-routes.ts`, `src/sidecar/project-key.ts`, `src/sidecar/project-key.test.ts`

**Key Decisions / Notes:**
- `project-key.ts`: `normalizeProjectKey(raw): string | null` (write variant — blank → null, caller 400s) and `normalizeProjectFilter(raw): string | undefined` (read variant — blank/absent → undefined). Only the write variant is used in this task; replace the copies at `routes.ts:163`, `notification-routes.ts:36`, `tdd-routes.ts:86-92`.
- Move handlers per the #9 facts. `handleSidecarRequest` stays the dispatcher calling sub-handlers (`Response | null`) inside its existing try/catch.
- No behaviour change, no test edits except imports. `routes.test.ts` must pass untouched.

**Definition of Done:**
- [ ] `routes.ts` < 400 lines; each new file < 400
- [ ] Full suite green; `routes.test.ts` unchanged
- [ ] One normalizer implementation (grep shows no copies)

**Verify:** `bun test src/sidecar/`

---

### Task 2: Split `update.ts`

**Objective:** Bring `src/cli/commands/update.ts` (597) under 400. Behaviour-preserving.
**Dependencies:** None
**Wave:** 1

**Files:**
- Modify: `src/cli/commands/update.ts`
- Create: `src/cli/commands/update-github.ts`, `src/cli/commands/update-check.ts`, `src/cli/commands/update-download.ts`, `src/cli/commands/update-reinstall.ts`

**Key Decisions / Notes:**
- Per #9 facts. `update.ts` keeps `registerUpdateCommand` and re-exports everything tests and `cli/index.ts` import. Add `normalizeReleaseVersion()` for the duplicated semver-string code (:197-200, :260-263). Replace `getVersionForUpdate` with `getSentinalVersion` only if tests confirm identical results; otherwise keep it.
- `update.test.ts` spies patch dependency modules, so they keep working — confirm.

**Definition of Done:**
- [ ] Every file < 400 lines
- [ ] `update.test.ts`, `install-gitignore.test.ts` pass with only import changes (ideally none)
- [ ] Export surface of `update.ts` unchanged

**Verify:** `bun test src/cli/`

---

### Task 3: Split `slots.ts`

**Objective:** Bring `src/worktree/slots.ts` (574) under 400 and remove the lazy-require cycle. Behaviour-preserving.
**Dependencies:** None
**Wave:** 1

**Files:**
- Modify: `src/worktree/slots.ts`, `src/worktree/worktree-config.ts`
- Create: `src/worktree/slot-env.ts`, `src/worktree/slot-scope.ts`, `src/worktree/slot-pool.ts`, `src/worktree/slot-messages.ts`

**Key Decisions / Notes:**
- Per #9 facts. `worktree-config.ts` imports from `slot-env.ts`, so the lazy `require` in `slots.ts` (:495-504) becomes a static import. ⛔ Keep `reslotLosers` with `tryAssignFreeSlot`. `slots.ts` re-exports everything; `src/index.ts:255-256` and 15 import sites unchanged. Check `src/runtime/no-module-cycle.test.ts` passes.

**Definition of Done:**
- [ ] Every file < 400 lines; no lazy `require` for the cycle
- [ ] `bun test src/worktree/ src/runtime/` green, no test edits besides imports

**Verify:** `bun test src/worktree/ src/runtime/`

---

### Task 4: Split `migrations.ts`

**Objective:** Bring `src/memory/migrations.ts` (530) under 400 with one module per modern migration. Behaviour-preserving (the runner fix is Task 13).
**Dependencies:** None
**Wave:** 1

**Files:**
- Modify: `src/memory/migrations.ts`
- Create: `src/memory/migration-helpers.ts`, `src/memory/migrations-legacy.ts`, `src/memory/migrations-v11.ts`, `src/memory/migrations-v12.ts`, `src/memory/migrations-v13.ts`

**Key Decisions / Notes:**
- Per #9 facts; V1–V10 back in numeric order. Only `runMigrations` is imported elsewhere. Pure move — identical SQL.

**Definition of Done:**
- [ ] Every file < 400 lines; `migrations*.test.ts` pass unchanged
- [ ] Full suite green (migrations reach ~49% of modules)

**Verify:** `bun test src/memory/ && bun test`

---

### Task 5: `quality_report` check-only project-wide

**Objective:** `quality_report` can never rewrite files it wasn't asked about, and reports useful results.
**Dependencies:** None
**Wave:** 1

**Files:**
- Modify: `src/sidecar/quality-runners.ts`, `src/sidecar/quality-routes.ts`, `src/analysis/mcp-tools.ts`, `src/sidecar/client-routes.ts` (result type/shape), `src/index.ts` (if it exports the checker)
- Delete: `src/checkers/typescript.ts`, `src/checkers/typescript.test.ts` (dead code — confirm no importer, including `src/index.ts`)
- Test: `src/sidecar/quality-runners.test.ts`, `src/sidecar/quality-routes.test.ts`, `src/analysis/mcp-tools.test.ts`, `src/sidecar/client.test.ts`

**Key Decisions / Notes:**
- D1. With `file`: resolve against `projectPath`, refuse outside it; prettier `--check` then `--write` only on exit 1; honour `fix.exitCode`; eslint `--fix`; fix the `autoFixed` mtime check to use the resolved path.
- Without `file`: prettier `--list-different .` (exit 1 = files, 2 = error) → first 20 files + total; eslint `--format json .` (no `--fix`) → error/warning totals, top rules, first N `file:line rule`. Add `fixMode: "file" | "none"`; keep `autoFixed`.
- Update the tool description and `file` field description ("auto-fixes only the given file; project-wide is report-only"), and rendering (`formatQualityReport`) to list files and real counts.
- Replace tests that run real `bunx prettier/eslint` on repo files with fake binaries (pattern `quality-routes.test.ts:197-214`) asserting exact argv. `getToolCommand` preference tests stay.

**Definition of Done:**
- [ ] No-file mode never passes `--write`/`--fix` (argv test); `--check` exit 2 does not report `autoFixed`
- [ ] A `file` outside the project is refused
- [ ] Rendered output lists unformatted files and real eslint counts
- [ ] No test runs a real formatter/linter against repo source
- [ ] No diagnostics errors

**Verify:** `bun test src/sidecar/quality-*.test.ts src/analysis/mcp-tools.test.ts src/sidecar/client.test.ts`

---

### Task 6: ESLint + Prettier config and devDependencies

**Objective:** Linting and formatting use pinned local tools and a real config.
**Dependencies:** None
**Wave:** 1

**Files:**
- Modify: `package.json`, `bun.lock`
- Create: `eslint.config.mjs`, `.prettierignore`

**Key Decisions / Notes:**
- D2. Pinned devDependencies: `eslint`, `typescript-eslint`, `@eslint/js`, `prettier` (current versions); keep `typescript` on 5.x (don't let `bun add` pull 7).
- Config per #2 facts (tuned); ignore `dist/**`, `node_modules/**`, `src/cli/embedded-assets.ts`, `targets/opencode/dist/**`, `targets/opencode/tests/fixtures/**`, `docs/**`. `no-unused-vars` and `no-explicit-any` at warn.
- `.prettierignore`: `CHANGELOG.md`, `docs/**`, `.sentinal/*.json`, `dist/**`, `targets/opencode/dist/**`, `src/cli/embedded-assets.ts`, `bun.lock`.
- Do NOT fix findings here (Task 16) and do NOT reformat files. Report counts: `bunx eslint . --format json` summary and `bunx prettier --list-different .` count.
- `getToolCommand` now resolves `node_modules/.bin/eslint|prettier` — confirm.

**Definition of Done:**
- [ ] `bunx eslint .` runs (exit 0/1, not 2) and the count is recorded in the plan
- [ ] `prettier --list-different .` excludes the ignored paths
- [ ] Full suite green

**Verify:** `bunx eslint . ; bunx prettier --list-different . | wc -l; bun test`

**Result (Wave 1):** eslint 10.11.0 / typescript-eslint 8.70.1 / @eslint/js 10.0.1 / prettier 3.9.9 pinned exact; typescript stays 5.9.3. `bunx eslint .` exit 1: 27 errors, 76 warnings, 62 of 468 files (unused-vars 67w, no-require-imports 17e, no-useless-assignment 7e, no-explicit-any 5w, unused directives 4w, prefer-as-const 2e, no-useless-escape 1e). Node/Bun globals declared for `.js/.mjs/.cjs`. `prettier --list-different .` = 41 files (pre-existing at HEAD).

---

### Task 7: Plugin honours `SENTINAL_HOME`

**Objective:** The OpenCode plugin reads and spawns only under `SENTINAL_HOME`, read fresh.
**Dependencies:** None
**Wave:** 1

**Files:**
- Modify: `targets/opencode/plugins/sentinal.ts`, `targets/opencode/plugins/sentinal.test.ts`

**Key Decisions / Notes:**
- Remove `SENTINAL_DIR` (:213) and resolve inside each function: sidecar pid `getSidecarPidPath()`, dashboard pid `getPidFilePath()`, binary `getSentinalBinPath()`, config `join(getSentinalHome(), "config.json")`. Update the stale comment at :550.
- Test with `SENTINAL_HOME` = temp dir containing a stale pid, a stub `bin/sentinal`, and `config.json` `{memory:{enabled:false}}`; assert spawn/read targets the temp tree and the real `~/.sentinal` is untouched.
- Plugin-graph type-check (`typecheck-plugin.sh`), `bun run build:opencode`, bundle guard.

**Definition of Done:**
- [ ] No `homedir()`-based Sentinal path remains in the plugin
- [ ] Test proves temp-tree usage
- [ ] Plugin type-check, build and bundle guard green

**Verify:** `bun test targets/opencode/plugins/ src/cli/target-assets.test.ts`

---

### Task 8: E2E harness fixes + test-file exemptions

**Objective:** E2E runs test the current code, clean up their processes, and don't trip on the user's live Sentinal.
**Dependencies:** None
**Wave:** 1

**Files:**
- Modify: `tests/e2e/harness/sandbox.ts`, `tests/e2e/harness/sandbox.spec-e2e.ts`, `src/utils/file-length.ts`, `src/utils/file-length.test.ts`, `src/utils/tdd.ts`, `src/utils/tdd.test.ts`

**Key Decisions / Notes:**
- Refuse a `dist/sentinal` whose `--version` differs from `package.json` or whose mtime predates the newest file under `src/` — with a message to run `bun run build:cli` or set `SENTINAL_E2E_BINARY`.
- `killSandboxProcesses`: primarily kill by the sandbox's own pidfiles (`<sandbox>/.sentinal/sidecar.pid`, `server.pid`); fall back to environment matching (`ps eww`, works for the user's own processes on macOS and Linux) for strays. Pass `SENTINAL_E2E_SANDBOX_ID`. Assert none survive.
- Replace `snapshotRealDirs`' whole-`~/.sentinal` hash per #10b: default mode checks attributable writes (appended log bytes containing the sandbox path/id; read-only DB rows keyed to sandbox paths or test session ids, plus a row-count comparison of the real DB's tables that tests could plausibly write, to catch escapes that don't log a sandbox path; hash only static user config); `SENTINAL_E2E_STRICT_ESCAPE=1` keeps a full check with stat-only for `bin/`, `deps/`, `models/`.
- `file-length.ts` `TEST_PATTERNS`: add `.e2e.ts`, `.spec-e2e.ts`, `.test.tsx`. `tdd.ts` `isTestFile`: recognise `.spec-e2e.ts` and `.e2e.ts`.
- The ALLOW e2e case will still fail until Task 10 — expected; record.

**Definition of Done:**
- [ ] Stale `dist/sentinal` refused (test)
- [ ] A sandbox sidecar started in a test is killed (test)
- [ ] Escape check passes with the user's live sidecar writing (manual run)
- [ ] Exemption/test-file patterns covered by tests

**Verify:** `bun test ./tests/e2e/harness/sandbox.spec-e2e.ts src/utils/`

---

### Task 9: Shipped prose for `quality_report` and stale docs

**Objective:** Agents are told to pass `file`, and nothing claims formatters run on every edit.
**Dependencies:** Task 5
**Wave:** 2

**Files:**
- Modify: `targets/{claude-code,opencode}/rules/verification.md`, `targets/{claude-code,opencode}/rules/development-practices.md`, `targets/claude-code/commands/spec-implement.md`, `targets/opencode/skills/spec-implement/SKILL.md`, `targets/claude-code/commands/spec-bugfix-verify.md`, `targets/opencode/skills/spec-bugfix-verify/SKILL.md`, `targets/claude-code/settings.json`, `src/cli/commands/install-constants.ts`, `README.md`, parity fixtures under `src/cli/__fixtures__/target-parity/`

**Key Decisions / Notes:**
- Identical edits in both targets (`sentinal-parity-baselines`): prettier first on the edited files, regenerate baselines ONCE, hunk counts unchanged, `spec-verify.diff` 0 bytes, then `bun run embed-assets`. Only baseline-regenerating task in Wave 2.
- verification.md / development-practices.md: "call `quality_report` with `file:` after editing that file; project-wide is report-only". Sub-agent prompt: pass the edited file. spec-bugfix-verify: project-wide lint is report-only.
- README :48, :379, :410, :421-423, settings.json :19, install-constants :69: remove "runs on every edit" claims.

**Definition of Done:**
- [ ] Both targets updated identically; parity green, hunk counts unchanged
- [ ] No shipped text claims auto-format on every edit

**Verify:** `bun test src/cli/target-parity.test.ts src/cli/target-assets.test.ts`

---

### Task 10: Canonical project keys on routes and spec writes; infer TDD project

**Objective:** Every supplied project is canonical before it keys storage; fixes the wrong "orphaned" Stop block.
**Dependencies:** Task 1
**Wave:** 2

**Files:**
- Modify: `src/sidecar/memory-routes.ts`, `src/sidecar/spec-routes.ts`, `src/sidecar/tdd-routes.ts`, `src/sidecar/project-key.ts`, `src/sidecar/client-routes.ts`, `src/spec/store.ts`, `src/cli/commands/register-plan.ts`, `src/hooks/pre-compact.ts`, `src/hooks/tdd-tracker.ts`, `src/hooks/tdd-guard.ts`, `src/opencode/workspace-adaptor.ts`
- Test: the corresponding `*.test.ts`, `src/spec/ownership.test.ts`

**Key Decisions / Notes:**
- D3. Read routes (`/memory/search`, `/memory/timeline`, `/spec/current`, `/tdd-state` GET, `/context` key only — workspace is Task 12) use `normalizeProjectFilter`. `/tdd-state/list` gains optional `project` → `listActiveTddStates(specId, identity)`; client `listActiveTddStates(specId, project?)`. `/spec/sync` uses the write variant (blank → 400).
- `syncFromPlanFile` canonicalizes `projectPath` itself (idempotent) — the single write point — ⛔ *and so do the store's project-keyed reads* (`getCurrentSpec`, `listSpecs` by project), otherwise a raw macOS tmpdir (`/var` vs `/private/var`) stored canonical is read back raw and misses (review finding). Update the `status-mcp-tools.ts` comment. Non-existent synthetic keys (`/test/project`) stay stable. `syncAll` (`store.ts:284`) loops over plan files: resolve the identity **once** and pass it, not one git spawn per file.
- Fix raw callers: `register-plan.ts`, `pre-compact.ts` (spec sync + `/context`), `tdd-tracker.ts:77`, `tdd-guard.ts:68`, `workspace-adaptor.ts:151` (identity; never send `""`).
- D4 (#6): `/tdd-state set` with no project infers from the nearest existing ancestor of `dirname(filePath)`; relative paths → 400; log "inferred projectPath". Update the stale comment.
- Regression test for #10a: register a spec under a symlinked/`/var` alias path, then `resolveStopDecision` from the canonical root allows a different live session's Stop. Run the e2e ALLOW case against HEAD source.

**Definition of Done:**
- [ ] Raw-alias registration no longer produces an "orphaned" block (unit + e2e against HEAD source)
- [ ] Read routes: supplied project canonicalized, absent = all (tests)
- [ ] `/tdd-state set` without project stores an inferred canonical project (test)
- [ ] No diagnostics errors

**Verify:** `bun test src/sidecar/ src/spec/ src/hooks/ && bun test ./tests/e2e/spec-workflow.e2e.ts`

---

### Task 11: Fix the "Fixed issue" capture trigger

**Objective:** Error→fix capture records real fixes only.
**Dependencies:** None (Wave 2 for file ownership)
**Wave:** 2

**Files:**
- Modify: `src/memory/capture.ts`, `src/hooks/memory-observer.ts`, `targets/opencode/plugins/sentinal.ts` *(added after review: both build the event buffer — `memory-observer.ts:52`, `sentinal.ts:478` — and both push before analysing)*
- Test: `src/memory/capture.test.ts`, `src/hooks/memory-observer.test.ts`, `targets/opencode/plugins/sentinal.test.ts`

**Key Decisions / Notes:**
- Determine first whether the CC buffer persists between hook invocations (per-cwd file) and whether the plugin keeps an in-memory buffer; "consume" must work in both (e.g. a consumed marker/timestamp stored in the buffer itself).
- D9: `ERROR_INDICATORS` — replace `/\bfail\b/i` with a non-zero-count form and review `/\bERROR\b/`, `/\bFAILED\b/i` against real passing output; a known exit code (0 = not an error) overrides text; `hasRecentError` excludes the current event; an error, once it produces a fix, is consumed (persisted in the buffer); edits to `*.md` and `docs/**` never count as fixes.
- Keep the build-fix and TDD-cycle rules working (tests). Use real runner outputs (bun pass/fail, tsc errors) as fixtures, including negative cases.

**Definition of Done:**
- [ ] Passing bun run + edits → no fix observation (test)
- [ ] One real error + 4 edits → one fix, not four (test)
- [ ] `.md` edit after an error → no fix (test)
- [ ] Existing TDD/build rules pass

**Verify:** `bun test src/memory/capture.test.ts src/hooks/memory-observer.test.ts`

---

### Task 12: Restore key/workspace split

**Objective:** Session-start and compaction restore find the canonical project's memories and read shared memory from the local checkout.
**Dependencies:** Task 10
**Wave:** 3

**Files:**
- Modify: `src/memory/restore.ts`, `src/sidecar/memory-routes.ts`, `src/sidecar/client-routes.ts`, `src/hooks/memory-restore.ts`, `src/hooks/pre-compact.ts`, `targets/opencode/plugins/sentinal.ts`
- Test: corresponding tests, `targets/opencode/plugins/sentinal.test.ts`

**Key Decisions / Notes:**
- D8. `RestoreOptions.workspacePath?` (defaults to `projectPath`, public API stable). `mergeSharedObservations(obs, key, workspace)`; `buildSemanticQuery` uses workspace for `findActivePlan`, key for queries. `/context` optional `workspace`; client third optional arg. Hooks' direct fallback resolves both. Plugin passes `projectWorkspace`.
- Test from a real linked worktree with an uncommitted shared-memory entry.

**Definition of Done:**
- [ ] From a linked worktree/subdir, restore returns canonical memories (was empty) (test)
- [ ] Shared memory read from the workspace (test)
- [ ] Old-client call (no workspace) still works (test)
- [ ] Plugin type-check + bundle green

**Verify:** `bun test src/memory/ src/sidecar/ src/hooks/ targets/opencode/plugins/`

---

### Task 13: Project-qualified `specs.id` (V14) + migration runner

**Objective:** Two projects with the same plan filename keep separate spec rows; migrations never skip a step.
**Dependencies:** Tasks 4, 10, 12
**Wave:** 4

**Files:**
- Modify: `src/memory/migrations.ts`, `src/memory/types.ts`, `src/spec/store.ts`, `src/spec/ownership.ts`, `src/spec/events-mcp-tools.ts`, `src/tdd/mcp-tools.ts`, `src/sidecar/tdd-routes.ts`, `src/sidecar/spec-routes.ts`, `src/worktree/cleanup-mcp-tool.ts`, `src/sidecar/worktree-routes.ts`, `src/dashboard/routes/api.ts`
- Modify *(added after review — FK writers that would otherwise send the slug where the key is required)*: `src/hooks/tdd-tracker.ts` (`getCurrentTask(spec.id)`, `specId: spec.id`, :82-153), `src/memory/store.ts` (TDD/event queries :229-292), `src/memory/store-sessions.ts` (`stampPlanOwner` :160), `src/opencode/native-tdd-status.ts` (agent `spec_id` :72-87), `src/sidecar/client-routes.ts` (spec-metrics chain :272-283), `targets/opencode/plugins/sentinal.ts` (verify the :1425 owner comparison still compares slugs)
- Create: `src/memory/migrations-v14.ts`, `src/spec/spec-key.ts` (+ tests)

**Key Decisions / Notes:**
- ⛔ *(Review must_fix.)* `runMigrations` runs outside any transaction (`store.ts:46-47`) and `defer_foreign_keys` only applies inside one (it resets at COMMIT; no effect in autocommit). V14 must open its own transaction and set `PRAGMA defer_foreign_keys = ON` as its **first statement**; a test proves the rewrite commits with `foreign_keys = ON`.
- ⛔ *(Review must_fix.)* Collision losers' `spec_tasks` would clash with `UNIQUE(spec_id, position)` if re-pointed: **delete** the loser's tasks and events; re-point only nullable references (`notifications`, `tdd_cycles`, `worktrees`).
- ⛔ *(Review must_fix.)* Every internal writer of a spec FK must use `spec.key`, not `spec.id` (the slug). Grep all `spec.id`/`specId` uses in the modified files and assert with a test per writer (TDD cycle row, event row, notification) that the FK value is the key.
- V14 canonicalizes project paths with `realpathSync` (cheap, no git) plus stripping `/.sentinal/worktrees/spec-*`. Linked-worktree keys it can't resolve are healed at runtime: when `syncFromPlanFile` creates key K and no row K exists, rows with the same slug whose `project_path` resolves (via `resolveProjectIdentity`) to the same identity are re-keyed in one deferred-FK transaction instead of leaving an orphan duplicate.
- D6 and D7. V14: build a key map `(project_path → canonical-by-string, stripping /.sentinal/worktrees/spec-* suffixes; no git in migrations) :: slug`; resolve collisions deterministically (keep newest `updated_at`; delete the loser's tasks/events; re-point its nullable references); `PRAGMA defer_foreign_keys = ON`; rewrite `specs.id` and the five child columns; create unique index `(project_path, slug)`; `foreign_key_check` empty; record only after verification.
- `Spec.id` stays the slug in returned objects; add `key` and `projectPath`. Internal FK writers use `key`. `resolveSpecKey(value, project?)` per D6 for every agent/route input listed in #7A. `ownership.ts:171` → `WHERE slug = ? AND project_path = ?`. Scope `isPlanActive` by project. `specs.parent` resolves by (project, slug). Dashboard shows project.
- Runner: read the set of recorded versions; run every missing step in order; V11 records only after verification; silent when nothing to do.
- ⛔ Rehearse V14 through `runMigrations` on a copy of the user's DB (`sqlite3 .backup`), report counts, `foreign_key_check`, and the misfiled/deleted-path rows' outcome.

**Definition of Done:**
- [ ] Same-filename plans in two projects → two rows; ownership and status resolve the right one (tests)
- [ ] Old bare-id writer after V14 fails loudly on the unique index, not silently (test)
- [ ] Runner runs a missing middle step (test); silent otherwise
- [ ] Rehearsal on a copy of the real DB: success, FK check clean, counts reported
- [ ] Full suite green

**Verify:** `bun test src/memory/ src/spec/ src/tdd/ src/sidecar/ src/worktree/ && bun test`

---

### Task 14: Notifications carry a project

**Objective:** Warning-level notifications reach the right project's session-start digest.
**Dependencies:** Tasks 1, 13
**Wave:** 5

**Files:**
- Modify: `src/sidecar/notification-routes.ts`, `src/sidecar/client-routes.ts`, `src/spec/events-mcp-tools.ts`, `src/hooks/stop-failure.ts`, `src/hooks/config-change.ts`, `src/hooks/session-notifications.ts`
- Test: corresponding tests, `src/hooks/session-notifications.test.ts`

**Key Decisions / Notes:**
- D5. Route: `projectPath` absent → NULL (back-compatible); present → write-variant normalize (blank → 400). Client field optional. Producers set project + `source` (`spec-notify`, `stop-failure`, `config-change`); config-change only when `file_path` is inside `resolveWorkspaceRoot(cwd)`. Info producers unchanged. Add `vector-init` to `GLOBAL_NOTIFICATION_SOURCES` (update the pinning test).

**Definition of Done:**
- [ ] Project warning appears in that project's digest and not another's (test)
- [ ] Old client without `projectPath` still works (test)
- [ ] `vector-init` surfaces globally

**Verify:** `bun test src/sidecar/ src/hooks/ src/spec/`

---

### Task 15: Server-side dedupe for auto-captured observations

**Objective:** Repeated auto-captures become one row with a count, for every client version.
**Dependencies:** Tasks 1, 11
**Wave:** 5

**Files:**
- Modify: `src/memory/service.ts`, `src/memory/store-observations.ts`, `src/sidecar/memory-routes.ts`, `src/hooks/memory-observer.ts`, `src/hooks/instructions-loaded.ts`
- Test: corresponding tests

**Key Decisions / Notes:**
- D10. Generalize to `findRecentBySignature(project, type, signature, since)` and `recordRepeat` (keep error names as aliases). Service computes the signature when `metadata.source === "auto-capture"` or `metadata.dedupeKey` is set, with a normalizer stripping durations, counts, hex/hashes, bun banners, temp paths. `type=fix` auto-captures also collapse same (project, title) within 5 min. Route always calls the deduped path. CC direct fallback uses it. `instructions-loaded` sets a `dedupeKey` (and `source`).
- Pre-Mortem 3: tests with real volatile output variants.

**Definition of Done:**
- [ ] 10 identical auto-captures → 1 row, `occurrences: 10` (test), via sidecar and direct paths
- [ ] Volatile-only differences collapse; genuinely different content doesn't (tests)
- [ ] No re-embed on repeat

**Verify:** `bun test src/memory/ src/sidecar/ src/hooks/`

---

### Task 16: Lint cleanup pass

**Objective:** Repo lints clean of errors; warnings triaged.
**Dependencies:** All code tasks
**Wave:** 6

**Files:** any `src/**`, `targets/**/*.ts`, `tests/**` with findings (report the list); `eslint.config.mjs` if a rule needs tuning.

**Key Decisions / Notes:**
- Fix real dead code (unused vars/imports), `no-useless-assignment`, `prefer-as-const`, `no-useless-escape`, misplaced directives (e.g. `workspace-adaptor.ts:316`). Deliberate lazy `require`s get `// eslint-disable-next-line @typescript-eslint/no-require-imports -- <reason>`. Leave `no-explicit-any` warnings in implementation only where justified.
- Behaviour-preserving: full suite + plugin type-check green. No formatting sweep.

**Definition of Done:**
- [ ] `bunx eslint .` reports 0 errors; remaining warnings listed in the plan
- [ ] Full suite green

**Verify:** `bunx eslint . && bun test`

---

### Task 17: Documentation

**Objective:** Rules reflect the new behaviour.
**Dependencies:** All code tasks
**Wave:** 6

**Files:** `.sentinal/rules/sentinal-project.md`, `.sentinal/rules/sentinal-mcp-servers.md`, `.sentinal/rules/sentinal-sidecar.md`

**Key Decisions / Notes:**
- Record D1, D3, D6 (spec keys, `resolveSpecKey`), D7, D8, D10; update the stale FK line numbers and "Known limitations"; update the sidecar route table (`project-key.ts`, new route modules). `sentinal-mcp-servers.md`: `quality_report` semantics.

**Definition of Done:** [ ] Each decision reflected; no stale limitation remains.

---

### Task 18: One-off cleanup of the user's DB

**Objective:** Remove duplicate and provably false auto-captured memories from `~/.sentinal/memory.db`.
**Dependencies:** Verification complete
**Runs in:** main context, not a subagent.

**Key Decisions / Notes:**
- Consistent backup (`sqlite3 .backup`), rehearse on a copy, **dry-run first and show the user the counts** before touching the live DB.
- In one transaction (Homebrew SQLite + vec0):
  1. Delete provable false positives: "Fixed issue in" rows whose "Error" section is a passing run (non-zero pass, zero fail, no other error line), whose file is `*.md`/`docs/**`, or whose error is `(no output)`.
  2. Merge exact-duplicate groups (same project/type/title/content) among auto-captures and "Instructions loaded:" rows: keep the oldest, `metadata.occurrences` = sum, `lastSeen` = max, `mergedIds`.
  3. Delete losers' vectors by aux `observation_id` chunk rows (before the observations), then the observations. Assert counts; FTS via triggers.
- Leave the 14 `/test/project` rows for the user's decision (report them).
- ⛔ *(Review.)* The false-positive rule is not expressible in SQL: implement it as a TypeScript script that **reuses Task 11's classifier** on each row's stored "Error" section, so the definition matches the shipped code exactly.
- Run only **after** the new plugin is deployed and the sidecar restarted — otherwise the old plugin recreates duplicates immediately.
- Merged keepers get the Task 15 dedupe signature in metadata, so later repeats increment them instead of inserting.

**Definition of Done:**
- [ ] Backup exists; rehearsal and dry-run counts shown to the user and approved
- [ ] No exact-duplicate groups or listed false-positive classes remain; vector/FTS counts consistent; `PRAGMA quick_check` ok
