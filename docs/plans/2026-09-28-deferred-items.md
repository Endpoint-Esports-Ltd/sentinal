# Deferred Items Implementation Plan

Created: 2026-09-28
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Summary

**Goal:** Close the items deliberately deferred by the hardening sweep (`docs/plans/2026-09-24-hardening-sweep.md`) plus the Claude Code `plugin.json` version: TDD transitions scoped to the tests that actually ran, a hard 400 for project-less `/tdd-state set`, a CI gate (tsc + ESLint + Prettier, on pushes and PRs), all non-barrel source files under 400 lines, dead code/needless exports removed, and the release version baked into `plugin.json`.

**Architecture:** Wave 1 fixes the TDD race and the release bake, and splits the files nobody else touches. Wave 2 adds the hard 400 and splits `client-routes.ts` (both touch files Wave 1 changes). Wave 3 removes dead exports once the splits have moved code. Wave 4 updates the dev docs. Wave 5 formats the repo once and turns on the CI gate, so the gate starts green.

**Tech Stack:** TypeScript (strict), Bun 1.3.10, `bun:test`, GitHub Actions, semantic-release, ESLint 10.11 / Prettier 3.9.9 (pinned).

## Scope

### In Scope

- **A. TDD race.** A passing/failing test run transitions only the TDD rows of implementation files whose companion test ran; a run whose test files cannot be determined keeps today's project-wide behaviour. Auto-trackers never downgrade `RED_CONFIRMED` to `TEST_WRITTEN` when a test file is re-edited.
- **B. Hard 400.** `POST /tdd-state` `set` without a project → 400, a `sidecar.log` line, and one global notification per day naming the problem.
- **C. CI gate.** `bunx tsc --noEmit`, `bunx eslint .`, `bunx prettier --check .` in the `test` job; `pull_request` trigger (release stays push-only); Bun pinned; `typecheck`/`lint`/`format`/`format:check` package scripts; the 38 drifted files formatted once.
- **D. Splits.** Every non-test, non-barrel `src/` file over 400 lines: `spec/store.ts` 549, `memory/capture.ts` 536, `sessions/usage-stats.ts` 522, `sidecar/server.ts` 515, `memory/cli.ts` 494, `memory/service.ts` 469, `sidecar/client-routes.ts` 423, `memory/restore.ts` 416, `runtime/ownership.ts` 401. Behaviour-preserving, export surfaces unchanged.
- **E. Dead exports.** Delete truly dead functions; drop `export` from functions used only in their own file. Keep everything in `src/index.ts` (public API) and test-only helpers.
- **F. `plugin.json`.** The release bakes the version into `targets/claude-code/.claude-plugin/plugin.json` (and therefore the embedded copy binaries install), verified by the release build; `check-versions.sh` turns that row into a real check.

### Out of Scope

- Pruning `src/index.ts` public API (would be breaking → v2.0.0).
- The `file-changed` hook clearing by test path (a no-op, since rows are keyed by impl path) — noted, not changed: making it effective would add another clearing path.
- The changelog-audit master plan drift.
- The 166 unclear "Fixed issue" memories.

## Context for Implementer

> This checkout is a linked git worktree (Orca) of `/Users/evan/Projects/endpoint_esports/sentinal`. Read `.sentinal/rules/sentinal-project.md` (identity vs workspace) and `sentinal-testing.md` first.

### A — the race (verified)

- Only bulk writers: `bulkTddTransition` (`src/sidecar/tdd-routes.ts:49-80`, `confirm_red` promotes every `TEST_WRITTEN`, `confirm_green` DELETEs every `RED_CONFIRMED`, scoped by `project_path` and optional `spec_id`), served by `POST /tdd-state/transition` (`:99-140`); and the Claude Code hook `processTddTracking` (`src/hooks/tdd-tracker.ts`), Cases 2 (`:115-140`) and 3 (`:143-162`), which call `listActiveTddStates(specKey, project)` and transition every row.
- The plugin calls the route from `sidecarTddTrack` (`targets/opencode/plugins/sentinal.ts:317-365`) via `transitionTddState` (`sentinal-helpers.ts:271-287`) on EVERY bash tool call whose output matches `TEST_FAIL_INDICATORS` / `TEST_PASS_INDICATORS` (`src/memory/capture.ts:106-121`), with no session filter. Parallel sub-agents in one directory: agent B's passing `bun test b.test.ts` deletes agent A's RED row → A reads IDLE → the TDD guard blocks A.
- The command is available: plugin `input.args.command` (`sentinal.ts:707`, `:897`); Claude Code `tool_input.command`. Bun prints per-file headers (`src/x.test.ts:`) but not always (fixtures with only `Ran N tests across M files`).
- Rows store `test_file_path` when auto-tracked (`tdd-tracker.ts:92`, plugin `:335`); optional in `tdd_set_state`. Mapping helpers: `getImplPathForTest` (`src/utils/tdd.ts:167-196`), `getExpectedTestPaths` (`:114-153`), `isTestFile` (`:82-84`). Rows are keyed by absolute impl path.
- A deleted row reads back `IDLE` (`tdd-routes.ts:180`).
- ⛔ Never run `bun test` from an OpenCode session expecting it not to touch real TDD state until this ships — the running plugin transitions on every test run.

### B — hard 400 (verified)

- `set` without project infers it (`tdd-routes.ts:204-220`, `inferProjectFromFile` `src/sidecar/project-key.ts:94-104`). Every current caller sends a project: MCP `tdd_set_state` since v1.38.0 (`src/tdd/mcp-tools.ts:149-158`), the plugin (`sentinal.ts:332-337`). CC hooks write the store directly. Only ≤1.37.1 clients would hit the 400; `sidecar.log` has no `inferred projectPath` line on this machine.
- Notification pattern to copy: `notifySkewOnce` (`src/sidecar/retire-notify.ts:40-73`, a settings key for once-only + `insertNotification` with `source`). `GLOBAL_NOTIFICATION_SOURCES` in `src/hooks/session-notifications.ts:30-33` (a NULL-project notice reaches the digest only if its source is listed).

### C — CI (verified)

- `.github/workflows/release.yml`: push to `main` only; `test` job = setup-bun `latest`, `bun install`, `bun scripts/check-embed-assets.mjs`, `bun test --timeout 30000`; `release` job `needs: test`. No tsc, no lint.
- `tsc` needs the generated, gitignored `src/cli/embedded-assets.ts` → run `bun run embed-assets` before it (check whether `check-embed-assets.mjs` already leaves it in place).
- Root tsconfig excludes `targets/`; the plugin graph has its own check (`.sentinal/skills/sentinal-opencode-api-source/scripts/typecheck-plugin.sh`).
- `bunx eslint .` → 0/0 today. `bunx prettier --list-different .` → 38 files (README hook table, 4 `.sentinal/skills/*/SKILL.md`, `scripts/pre-release.mjs`, 13 source, 16 tests, 8 e2e). None generated. `.prettierignore` already excludes generated output, CHANGELOG, `docs/**`.

### D — splits (verified)

- Keep `SpecStore.prototype.getCurrentSpec` a class method (spied in `src/hooks/tdd-guard.test.ts:554`, `tdd-tracker.test.ts:658`). Keep `server.ts` re-exporting `getSidecar{Pid,Socket,Port}Path` (spied via `serverModule` in `src/sidecar/lifecycle.test.ts:33,49-51`). `SidecarClient.connect`/`connectWithRetry` are spied statically — moving instance methods between `SidecarRoutes` layers is safe. `client-routes.ts` is imported only by `client.ts` (`SidecarClient extends SidecarRoutes`).
- `capture.ts` is imported by the plugin (`sentinal.ts:48-53`) and `src/index.ts` — keep re-exporting everything from it (it already re-exports `error-classifier`); the plugin bundle must stay self-contained.
- Candidate cuts (from exploration): store → row types/deserializers + timing queries + sync/heal; capture → patterns / `EventBuffer` / detectors+builders; usage-stats → types+pricing; server → session-aware shutdown/activity (`:107-292`); memory/cli → `run*` subcommands; service → dedupe path + search path; client-routes → domain layers (session/TDD, memory, spec, worktree/notification/quality) as an abstract-class chain; restore → markdown formatting; ownership → whatever cohesive helper brings it under 400.

### E — dead exports (verified list; re-check each with `rg` before removing)

- Truly dead (no reference anywhere but the definition, not in `index.ts`): `resetBinaryVersionCache` (`src/opencode/dashboard-ensure.ts:88`), `isGlobalInstall` (`src/utils/shell.ts:142`), `clearProjectContextCache` (`src/sidecar/project-routes.ts:70`).
- Used only in their own file (drop `export`): `buildImpactOutput` (`analysis/impact.ts`), `parseWaveValue` (`analysis/plan-files.ts`), `providerReach`, `providerModuleCount` (`analysis/reach.ts`), `sourceLabel` (`analysis/reach-sources.ts`), `deepEquals` (`cli/commands/uninstall-opencode-config.ts`), `probeDashboardHealth` (`dashboard/lifecycle.ts`), `specsListFragment` (`dashboard/views/specifications.ts`), `isErrorEvent` (`memory/capture.ts`), `runRepair` (`memory/cli.ts`), `canonicalizeSpecProject` (`memory/migrations-v14.ts`), `probeHttp`, `probeExec` (`runtime/readiness.ts`), `touchActivity` (`sidecar/server.ts`). Line numbers moved after Wave 1 — search by name.
- Keep: anything re-exported from `src/index.ts` (e.g. `rebuildVectorIndex`, `findSentinalBin`, `readPidFile`, `hasSlotPlaceholder`, `resetModelRouting`, `withSidecarOrDirect`); test-only helpers (`isInsideGitRepo`, `getSessionUsage`, `findLatestTag`, `getLastActivityTime`, `sha256Hex`, …).

### F — `plugin.json` (verified)

- `.releaserc.json` `prepareCmd`: `echo ${version} > VERSION && node scripts/release-build.mjs ${version}` runs BEFORE `@semantic-release/npm` bumps `package.json`. `release-build.mjs:48` `buildOpencode(version)`, `:49` embed-assets, `:53-60` `verifyBakedVersion(version, shippedPluginPaths())`. `@semantic-release/git` commits `package.json`, `VERSION`, `CHANGELOG.md`.
- `scripts/embed-assets.mjs:100-112` embeds `targets/claude-code/.claude-plugin/plugin.json` verbatim as `EMBEDDED_CC_PLUGIN_JSON` (installed by `install-claude.ts:322-327`); source installs copy `targets/claude-code` (`:166-173`). Nothing writes its version today.
- Tests: `src/cli/target-assets.test.ts:328-407` (bake + source-greps of `release-build.mjs` / `pre-release.mjs`), `src/cli/bundle-version-check.test.ts:87-123`.
- Readers: only `.sentinal/skills/sentinal-live-smoke/scripts/check-versions.sh:12-13,21` (currently "informational") and that skill's `SKILL.md:80`.

### Cross-cutting gotchas

- Call `quality_report` only with `file`. Prettier/ESLint only on your own files until Task 10.
- After any `targets/` edit: `bun run embed-assets`; plugin type-check with the script above; `bun run build:opencode` + `bun test src/cli/target-assets.test.ts` (bundle self-containment).
- TDD guard: in parallel waves, set `RED_CONFIRMED` immediately before each write (the race this plan fixes resets it).
- Tests spawning git/subprocesses: explicit timeout 3rd arg. Never touch the real `~/.sentinal`.

## Assumptions

- Scoping to "tests that ran" can use the command's arguments first and runner file headers second — supported by the plugin/CC command fields and bun's header format; Task 1.
- A full-suite run (no test files named) passing means every RED test passed, so a project-wide clear is correct there — Task 1.
- No live client sends `set` without a project (≥1.38 everywhere; no inference log lines) — Task 2.
- Formatting the 38 drifted files changes whitespace only (Prettier) — Task 10; verified by `git diff -w` being empty apart from wrapped lines, and the full suite.

## Key Decisions

- **D1 — Transition scope.** `POST /tdd-state/transition` and `bulkTddTransition` take optional `testFiles: string[]` and `testDirs: string[]` (absolute). When either is non-empty, a row in scope transitions only if: its `test_file_path` is in `testFiles` or under a `testDirs` entry; or `getExpectedTestPaths(file_path)` intersects `testFiles` / falls under a dir; or `getImplPathForTest(t) === file_path` for some `t` (reverse mapping — covers `__tests__/`, `tests/` layouts the forward mapping misses). Both absent/empty → today's project-wide behaviour (old clients, unknown runs). Old sidecars ignore the fields (stay project-wide — acceptable).
- **D2 — Determining the scope (revised after review).** Pure `testRunScope({ command, cwd })` in `src/utils/test-run-scope.ts` returns `{ files: string[] | null; dirs: string[]; nameFiltered: boolean }`, from the **command only** (output headers are unreliable: absent, truncated, and a full run prints every file — using them would scope a full run):
  - Strip wrappers/runners: `bunx`/`npx`/`pnpm exec`/`yarn`, `npm|pnpm|yarn test [--]`, `bun test`, `bun run test`, `vitest [run]`, `jest`, `nx test <proj> --testFile=…` where recognisable; env prefixes and `cd x &&` chains (use the `cd` target as cwd).
  - Positional args that are test files → absolute `files`; existing directories → `dirs`; other positional args (bun/vitest substring filters) → treat as unknown → `files: null`.
  - No positional args (full suite) or an unrecognised command → `files: null` → **project-wide** (a passing full suite means every RED test passed).
  - `-t` / `--test-name-pattern` / `--grep` present → `nameFiltered: true`: a scoped `confirm_red` still applies; `confirm_green` is **skipped** (only some tests of those files ran).
  - Never returns an empty scope: if nothing resolves, `files: null`. The route treats `testFiles: []` exactly like absent.
- **D3 — No downgrade.** The auto-trackers (plugin Case 1, CC Case 1) skip setting `TEST_WRITTEN` when the impl row is already `RED_CONFIRMED`. Explicit `tdd_set_state` is unchanged.
- **D4 — Hard 400.** `set` without a project → 400 `MISSING_PROJECT_PATH`, `logSidecar("tdd-state set REJECTED: missing projectPath …")`, and at most one global notification per day (source `tdd-missing-project`, added to `GLOBAL_NOTIFICATION_SOURCES`) saying an old client (≤1.37.1) is running and to restart it. `inferProjectFromFile` removed if it has no other caller.
- **D5 — CI.** Order in `test`: install → `check-embed-assets` (it already runs the full `embed-assets` and leaves `src/cli/embedded-assets.ts` on disk) → `typecheck` → plugin type-check (confirm the script is portable to Linux bash) → `lint` → `format:check` → tests. `pull_request: branches: [main]` added; `release` job gains `if: github.event_name == 'push'`. Bun pinned to `1.3.10` in both jobs.
- **D6 — `plugin.json` bake.** `release-build.mjs` (and `pre-release.mjs`) write `version` into `targets/claude-code/.claude-plugin/plugin.json` BEFORE `buildOpencode`/`embed-assets`, then verify both the file and `EMBEDDED_CC_PLUGIN_JSON`; the file is added to `@semantic-release/git` assets. Claude Code uses the plugin version as its update/cache key (docs: "Version management"); Sentinal's local-directory marketplace loads in place, so a real version is harmless there and correct for copied installs — a frozen `0.1.0` is the worse state. `pre-release.mjs` uses `package.json`'s version, which equals the committed `plugin.json` after this change, so running it locally leaves no diff (assert in a test). No `version` is written to `marketplace.json` (plugin.json takes precedence).

## Plan Review (2026-09-28) — 1 must_fix, 7 should_fix, 4 consider

| Finding | Resolution |
| --- | --- |
| **must** D2 used output headers, so a full `bun test` (headers for every file) would be scoped, contradicting the DoD | D2 now derives scope from the command only; no file args → project-wide |
| should: `sidecarTddTrack` never receives the command | Task 1 plumbs command + cwd into it and into the CC tracker input |
| should: jest/vitest/npm wrappers not handled | Wrapper stripping + fixtures in D2 |
| should: `testFiles: []` could suppress RED on truncated output | Parser never returns `[]`; route treats `[]` as absent |
| should: `getExpectedTestPaths` misses `__tests__/`/`tests/` | Reverse mapping via `getImplPathForTest` + layout fixtures |
| should: Wave 1 tasks share build outputs | Orchestrator-only builds per wave; Task 3 moved to Wave 2 |
| should: `plugin.json` bake details | Verified against Claude Code docs; pre-release no-diff test; no marketplace version |
| should: `isErrorEvent`/`probeDashboardHealth` in `src/index.ts`? | Checked: not re-exported — removal stands |
| consider: `-t` filtered runs | `nameFiltered` skips `confirm_green` |
| consider: redundant CI embed step | Removed; `check-embed-assets` leaves the file |
| consider: `service-dedupe.ts` name clash | Renamed to `observation-dedupe.ts` |
| consider: `inferProjectFromFile` removal ripple | Tests/doc/rules listed in Tasks 2 and 9 |

Checked after review: `prettier --list-different .` lists nothing under `targets/`, `.github/`, `.opencode/`, `.claude/`, so formatting cannot move parity baselines; `tdd-routes.ts` is 259 lines before Tasks 1–2.

## Implementation Notes (Wave 1)

- Full suite 3,997 pass / 0 fail; tsc, plugin type-check, eslint, bundle guard, no-module-cycle green.
- Task 1: `src/utils/test-run-scope.ts` exports `testRunScope` plus the shared matcher (`rowMatchesTestScope`, `filterRowsByTestScope`); `tdd-routes.ts` 332; plugin `sidecarTddTrack` gets command + cwd (`args.workdir` or the checkout); D3 in both trackers. 14 mutants, one surviving mutant exposed a real bug (`echo | bun test x` ignored) — fixed. The race hit the agent itself mid-task.
- Task 4: `store.ts` 275 (+`store-rows.ts`, `store-sync.ts`), `service.ts` 340 (+`observation-dedupe.ts`, `observation-search.ts`), `restore.ts` 239 (+`restore-format.ts`); prototypes identical.
- Task 5: `capture.ts` 73 (+`capture-patterns.ts`, `capture-buffer.ts`, `capture-detectors.ts`), `memory/cli.ts` 205 (+`cli-commands.ts`), `usage-stats.ts` 371 (+`usage-pricing.ts`).
- Task 6: `server.ts` 286 (+`shutdown.ts`, which also took `stopSidecar` to avoid a cycle), `ownership.ts` 291 (+`ownership-probes.ts`, read-only probes; no signalling moved).
- ⚠️ Several agents wrote multi-hunk edits via Bash/python, which the TDD guard does not see; RED was set first each time, but this is a guard bypass worth noting.

## Implementation Notes (Wave 2)

- Full suite 4,026 pass / 0 fail; build, bundle guard, tsc, eslint green; embedded plugin.json carries 1.39.2.
- Task 2: 400 + log + once-per-day global notice (`src/sidecar/tdd-project-notify.ts`, settings key `tdd_missing_project_notified_day`, source `tdd-missing-project`); `inferProjectFromFile` removed. Also updated `server.test.ts` / `routes.test.ts` / `client.test.ts` calls that relied on inference. A mutation script briefly left a broken `tdd-routes.ts` in the shared tree (restored immediately).
- Task 3: `scripts/cc-plugin-version.mjs` (`bakePluginVersion`, `verifyPluginVersion`); both release scripts bake before build/embed and verify after; `plugin.json` 1.39.2; `.releaserc.json` git assets; `check-versions.sh` CC row is a real check (`0.1.0` = pre-bake install, informational); script tested with fake HOME + stubs.
- Task 7: `client-routes.ts` 148 + `client-routes-base.ts` 178, `-memory.ts` 105, `-spec.ts` 54 (class chain; method set identical).

## Implementation Notes (Waves 3–4)

- Task 8: re-verified with `rg` across src/targets/scripts/tests (and string uses). Deleted `resetBinaryVersionCache`, `isGlobalInstall`, `clearProjectContextCache` (no callers, not in `src/index.ts`). Dropped `export` from 13 in-file-only functions and removed the now-pointless re-exports of `isErrorEvent` (capture.ts) and `runRepair` (memory/cli.ts). `src/index.ts` untouched. tsc, eslint, full suite 4,026 / 0 green.
- Task 9: `sentinal-project.md` (CI gate, hard 400, scoped transitions, plugin.json bake, project-key line numbers), `sentinal-sidecar.md` (client-routes chain, shutdown.ts, tdd-project-notify.ts, transition scope, D4 400), `sentinal-testing.md` (race resolved, CI). The hardening-sweep plan's deferred issue is cross-referenced as resolved.

## Implementation Notes (Wave 5)

- 38 drifted files formatted. Not whitespace-only (Prettier also adds trailing commas, drops redundant parens, leading `|` on unions, `*`→`_` emphasis), so equivalence was proven differently: all 32 formatted `.ts`/`.mjs` files transpile (`bun build --no-bundle --minify-whitespace --minify-syntax`) to byte-identical output before and after.
- New `tsconfig.plugin.json` (the plugin graph, defined once) + scripts `typecheck`, `typecheck:plugin`, `lint`, `format`, `format:check`. `typecheck-plugin.sh` and `verify-index.sh` now use it; `verify-index.sh` also runs eslint + prettier when the commit defines `format:check`.
- Workflow: `pull_request` trigger; `release` job `if: github.event_name == 'push'`; Bun pinned 1.3.10; `bun install --frozen-lockfile`; gates as D5 (the separate embed step dropped — `check-embed-assets` leaves the file).
- Simulated CI on a clean export (git ls-files, no embedded-assets.ts): every step green, tests 4,026 / 0. A deliberately unformatted file makes `format:check` exit 1.

## Spec Review (2026-09-28) — 0 must_fix, 2 should_fix, 4 suggestions

| Finding | Resolution |
| --- | --- |
| should: a bare test filename (`bun test tdd-routes.test.ts`, bun's substring filter) resolved to a non-existent path → a non-empty scope matching no row → RED never confirmed / GREEN never cleared | A test-file arg counts only if it exists; otherwise project-wide. Fixture files created in the tests that assumed non-existent paths |
| should: `contents: write` at workflow level now also applied to same-repo PR runs | Top-level `contents: read`; write permissions only on the push-only release job |
| suggestion: `cd -` / `cd ~` / `cd $DIR` joined literally | Unresolvable `cd` → project-wide |
| suggestion: scoped transition lookup outside the transaction; writes filter only by file_path | Kept: `file_path` is UNIQUE, so scope cannot widen (reviewer agrees) |
| suggestion: plugin cwd without `workdir` is the workspace root | Kept: OpenCode runs bash in the session directory (= workspace) unless `workdir` is given |
| suggestion: blank/null project on `set` rejected without the log line | Kept per D4 (absent only); blank has always been a plain 400 |

## Verification (2026-09-28)

- Full suite 4,028 pass / 0 fail; `typecheck`, `typecheck:plugin`, `lint` (0/0), `format:check` clean; bundle guard green; simulated CI on a clean export green.
- Truths: 1 (race, route/CC/plugin tests) ✅ · 2 (400, test) ✅ · 3 (workflow grep) ✅ · 4 (eslint + prettier exit 0) ✅ · 5 (no non-test `src/` file > 400 except `src/index.ts` 401 barrel and generated `embedded-assets.ts`) ✅ · 6 (bake + verify tests) ✅ · 7 (removed functions gone; `src/index.ts` untouched) ✅.
- Not verified: the first real GitHub Actions run of the new gate (after push); a real release baking `plugin.json` (next release).

## Testing Strategy

- Task 1: unit tests for `testRunScope` with real bun/vitest output shapes (headers present, absent, truncated; relative/absolute/dir args; `bun test` with no args); route + store tests that a scoped transition leaves other files' rows untouched (the race reproduced: A RED, B's test passes → A still RED); plugin + CC hook tests end to end; old-client call without `testFiles` unchanged. Mutation-check.
- Task 2: route 400 + log + once-per-day notification; notification surfaces globally.
- Splits: no test edits except imports; export surfaces compared before/after; full suite.
- Task 10: the new CI commands run locally green; a deliberately unformatted file makes `format:check` exit 1.
- Every commit verified standalone (`.sentinal/skills/sentinal-logical-commits`).

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Scoped transitions miss a legitimate transition (e.g. test in a non-companion location) | Medium | Medium | Rows with an explicit `test_file_path` match exactly; unknown runs stay project-wide; tests with real layouts |
| Hard 400 breaks an old client silently | Low | Medium | Log line + daily global notification; user is on 1.39.x everywhere |
| A split changes behaviour | Low | High | Pure moves, re-exports, no test edits, full suite, export-surface diff |
| Formatting commit hides a behaviour change | Low | Medium | Formatting alone in its own commit; `git diff -w --stat` review; full suite |
| CI tsc fails because generated `embedded-assets.ts` is missing | Medium | Medium | Generate before tsc; run the exact CI command list locally |
| Release bake of `plugin.json` fails the release | Low | High | Mirror in `pre-release.mjs` and a test that runs the bake step on a temp copy |

## Pre-Mortem

1. **Agents still lose RED state** because the plugin sends no `testFiles` (command unavailable in that code path) and falls back to project-wide. (Task 1) → Trigger: the plugin test that runs `bun test b.test.ts` through `tool.execute.after` still clears A's row.
2. **A split creates an import cycle or breaks the plugin bundle** (capture.ts is bundled into the plugin). (Task 5) → Trigger: `src/runtime/no-module-cycle.test.ts` or `target-assets.test.ts` fails.
3. **CI red on first run** because a gate command behaves differently on Linux (paths/case) or Bun pin. (Task 10) → Trigger: GitHub run fails on the lint/format step; mitigate by running the exact step list locally and watching the first CI run.

## Execution Waves

**Wave 1** (parallel): Tasks 1, 4, 5, 6 — the race fix and splits of files no other Wave 1 task touches.
**Wave 2** (parallel): Tasks 2, 3, 7 — Task 2 edits `tdd-routes.ts` after Task 1; Task 7 splits `client-routes.ts` after Task 1 changed it; Task 3 moved here because it rewrites `plugin.json`, an input of `embed-assets`, which Wave 1 tasks rebuild.

⛔ **Shared build outputs.** `bun run build:opencode` / `bun run embed-assets` write `targets/opencode/dist/` and `src/cli/embedded-assets.ts`, which no `Files:` list declares. In a parallel wave, **tasks must not run them**; the orchestrator runs them (plus the plugin type-check and `target-assets.test.ts` bundle guard) once after each wave. Tasks may run `typecheck-plugin.sh` (read-only).
**Wave 3**: Task 8 — dead exports, after the splits moved code (touches capture, cli, server).
**Wave 4**: Task 9 — dev docs.
**Wave 5**: Task 10 — format the repo once and turn on the CI gate, last, so it starts green.

## Goal Verification

### Truths

1. With A's impl row `RED_CONFIRMED` and B's row `RED_CONFIRMED`, a passing `bun test <B's test>` leaves A's row `RED_CONFIRMED` (route, CC hook and plugin tests).
2. `POST /tdd-state {action:"set"}` without a project returns 400 and writes nothing (test).
3. `.github/workflows/release.yml` runs `typecheck`, `lint` and `format:check` in `test`, has a `pull_request` trigger, and `release` runs only on push (grep-verifiable).
4. `bunx prettier --check .` and `bunx eslint .` exit 0.
5. No non-test `src/*.ts` other than `src/index.ts` and `src/cli/embedded-assets.ts` exceeds 400 lines (`find … | wc -l`).
6. `release-build.mjs` writes and verifies the version in `targets/claude-code/.claude-plugin/plugin.json` (test).
7. The removed functions have no remaining definition; every export of `src/index.ts` is unchanged (export-surface diff).

### Artifacts

| Artifact | Provides | Exports |
| --- | --- | --- |
| `src/utils/test-run-scope.ts` | Test files a run covered | `testRunScope` |
| `src/sidecar/tdd-routes.ts` | Scoped transitions, hard 400 | `bulkTddTransition` (+`testFiles`) |
| `.github/workflows/release.yml` | CI gate | — |
| `scripts/release-build.mjs` | `plugin.json` bake | — |

### Key Links

| From | To | Via | Pattern |
| --- | --- | --- | --- |
| `targets/opencode/plugins/sentinal.ts` | `/tdd-state/transition` | `transitionTddState(…, testFiles)` | `testRunScope` |
| `src/hooks/tdd-tracker.ts` | `src/utils/test-run-scope.ts` | scoped bulk transition | `testRunScope` |
| `.github/workflows/release.yml` | `package.json` scripts | CI steps | `format:check` |

## Progress Tracking

- [x] Task 1: TDD transitions scoped to the tests that ran; no RED downgrade (Wave 1)
- [x] Task 2: Hard 400 for project-less `/tdd-state set` with a loud warning (Wave 2)
- [x] Task 3: Bake the release version into `plugin.json` (Wave 2)
- [x] Task 4: Split `spec/store.ts`, `memory/service.ts`, `memory/restore.ts` (Wave 1)
- [x] Task 5: Split `memory/capture.ts`, `memory/cli.ts`, `sessions/usage-stats.ts` (Wave 1)
- [x] Task 6: Split `sidecar/server.ts`, `runtime/ownership.ts` (Wave 1)
- [x] Task 7: Split `sidecar/client-routes.ts` (Wave 2)
- [x] Task 8: Remove dead code and needless exports (Wave 3)
- [x] Task 9: Dev docs (Wave 4)
- [x] Task 10: Format once + CI gate (Wave 5)

**Total Tasks:** 10 | **Completed:** 10 | **Remaining:** 0

## Implementation Tasks

### Task 1: TDD transitions scoped to the tests that ran; no RED downgrade

**Objective:** One agent's test run no longer clears or promotes another agent's TDD rows.
**Dependencies:** None
**Wave:** 1

**Files:**
- Create: `src/utils/test-run-scope.ts`, `src/utils/test-run-scope.test.ts`
- Modify: `src/sidecar/tdd-routes.ts` (body type + `bulkTddTransition`), `src/sidecar/client-routes.ts` (`tddTransition` gains optional `testFiles`/`testDirs`), `targets/opencode/plugins/sentinal-helpers.ts` (`transitionTddState` signature), `targets/opencode/plugins/sentinal.ts` (`sidecarTddTrack` gains the command + cwd — today it takes none and the only `args.command` read is at ~:897, AFTER the tracker call at ~:842), `src/hooks/tdd-tracker.ts` (`TddTrackerInput` + `trackerInputFromHook` carry `tool_input.command`; dispatcher `src/cli/commands/hook.ts:38-41`)
- Test: `src/sidecar/tdd-routes.test.ts`, `src/sidecar/client.test.ts`, `targets/opencode/plugins/sentinal-helpers.test.ts`, `targets/opencode/plugins/sentinal.test.ts`, `src/hooks/tdd-tracker.test.ts`

**Key Decisions / Notes:**
- D1, D2, D3. Matching happens in `bulkTddTransition` (server side) so the plugin bundle only ships the pure parser. The CC hook passes the same set to its store-side selection.
- Reproduce the race first as a failing test at each layer (route, plugin through `tool.execute.after`, CC hook).
- Keep `confirm_red`/`confirm_green` semantics otherwise identical; empty/absent scope → project-wide; `nameFiltered` → skip `confirm_green`.
- Parser fixtures: `bun test a.test.ts`, `bun test src/x/`, `bun test` (full), `bun test -t name a.test.ts`, `bun test foo` (substring filter → unknown), `npx vitest run src/a.spec.ts`, `npm test -- src/a.spec.ts`, `npx jest path`, `cd sub && bun test x.test.ts`, `FOO=1 bun test x.test.ts`, non-test commands.
- Matching fixtures: companion `x.test.ts`↔`x.ts`, `__tests__/x.test.ts`, `tests/x.test.ts`, `.spec.ts`, rows written by `tdd_set_state` with and without `test_file_path`.

**Definition of Done:**
- [ ] Truth 1 at route, plugin and CC-hook level; mutation-checked
- [ ] A full `bun test` (no args) still transitions project-wide; a `-t`-filtered passing run does not confirm GREEN
- [ ] Re-editing a test never downgrades RED (both auto-trackers)
- [ ] Plugin type-check, build and bundle guard green

**Verify:** `bun test src/utils/test-run-scope.test.ts src/sidecar/ src/hooks/tdd-tracker.test.ts targets/opencode/plugins/ src/cli/target-assets.test.ts`

---

### Task 2: Hard 400 for project-less `/tdd-state set`

**Objective:** A write without a project is refused, visibly.
**Dependencies:** Task 1
**Wave:** 2

**Files:**
- Modify: `src/sidecar/tdd-routes.ts`, `src/sidecar/project-key.ts` (remove `inferProjectFromFile` if unused), `src/hooks/session-notifications.ts`
- Create: `src/sidecar/tdd-project-notify.ts` (+ test) if the notify helper doesn't fit in `tdd-routes.ts` under 400 lines
- Test: `src/sidecar/tdd-routes.test.ts` (replace the inference test ~:478), `src/sidecar/project-key.test.ts` (drop the `inferProjectFromFile` describe), `src/hooks/session-notifications.test.ts`, `src/sidecar/client.test.ts` (a client test relied on inference for `/src/a.ts`)

**Key Decisions / Notes:**
- D4. Follow `notifySkewOnce` (settings key with a date for once-per-day). Update tests that asserted inference. Also remove the `project-key.ts:24` doc mention; Task 9 updates the rule text (`sentinal-project.md`, `sentinal-sidecar.md` describe D4 inference).

**Definition of Done:**
- [ ] Truth 2; log line written; one notification per day, surfacing globally (tests)
- [ ] Every current caller still succeeds (plugin + `tdd_set_state` tests)

**Verify:** `bun test src/sidecar/ src/hooks/session-notifications.test.ts src/tdd/`

---

### Task 3: Bake the release version into `plugin.json`

**Objective:** Installed Claude Code plugins report the release version.
**Dependencies:** None
**Wave:** 2

**Files:**
- Modify: `scripts/release-build.mjs`, `scripts/pre-release.mjs`, `.releaserc.json`, `targets/claude-code/.claude-plugin/plugin.json` (set to current version 1.39.2), `src/cli/target-assets.test.ts`, `.sentinal/skills/sentinal-live-smoke/scripts/check-versions.sh`, `.sentinal/skills/sentinal-live-smoke/SKILL.md`
- Possibly: `scripts/build-opencode.mjs` (`verifyBakedVersion` / `shippedPluginPaths`) and `src/cli/bundle-version-check.test.ts`

**Key Decisions / Notes:**
- D6. The write must precede `buildOpencode`/`embed-assets`. Test the bake on a temp copy (no writes to the real repo file during tests). `check-versions.sh`: the CC row becomes a real check once the installed plugin carries a version.

**Definition of Done:**
- [ ] Truth 6; release build fails if either copy lacks the version (test)
- [ ] `plugin.json` in git assets

**Verify:** `bun test src/cli/target-assets.test.ts src/cli/bundle-version-check.test.ts`

---

### Task 4: Split `spec/store.ts`, `memory/service.ts`, `memory/restore.ts`

**Objective:** Each under 400 lines, behaviour-preserving.
**Dependencies:** None
**Wave:** 1

**Files:**
- Modify: `src/spec/store.ts`, `src/memory/service.ts`, `src/memory/restore.ts`
- Create: new sibling modules as needed (e.g. `src/spec/store-rows.ts`, `src/spec/store-timing.ts`, `src/memory/observation-dedupe.ts`, `src/memory/observation-search.ts` (not `service-dedupe.ts` — `service-dedupe.test.ts` already exists and tests `service.ts`), `src/memory/restore-format.ts`)

**Key Decisions / Notes:** Keep `SpecStore`'s public methods (esp. `getCurrentSpec`) on the class; move bodies to helpers taking the db. Re-export moved public symbols. No test edits besides imports.

**Definition of Done:**
- [ ] Every touched/new file < 400; export surfaces unchanged
- [ ] `bun test src/spec/ src/memory/ src/hooks/ src/sidecar/` green

**Verify:** `bun test src/spec/ src/memory/ src/hooks/ src/sidecar/`

---

### Task 5: Split `memory/capture.ts`, `memory/cli.ts`, `sessions/usage-stats.ts`

**Objective:** Each under 400 lines, behaviour-preserving.
**Dependencies:** None
**Wave:** 1

**Files:**
- Modify: `src/memory/capture.ts`, `src/memory/cli.ts`, `src/sessions/usage-stats.ts`
- Create: e.g. `src/memory/capture-patterns.ts`, `src/memory/capture-detectors.ts`, `src/memory/cli-commands.ts`, `src/sessions/usage-pricing.ts`

**Key Decisions / Notes:** `capture.ts` keeps re-exporting everything (plugin + `src/index.ts` import it); new modules must not pull zod/`bun:sqlite` into the plugin bundle. Pre-Mortem 2.

**Definition of Done:**
- [ ] Every file < 400; export surfaces unchanged; bundle guard + `no-module-cycle` green
- [ ] Scoped suites green

**Verify:** `bun test src/memory/ src/sessions/ src/cli/ src/hooks/ targets/opencode/plugins/ src/runtime/no-module-cycle.test.ts` (after `bun run build:opencode`)

---

### Task 6: Split `sidecar/server.ts`, `runtime/ownership.ts`

**Objective:** Each under 400 lines, behaviour-preserving.
**Dependencies:** None
**Wave:** 1

**Files:**
- Modify: `src/sidecar/server.ts`, `src/runtime/ownership.ts`
- Create: e.g. `src/sidecar/shutdown.ts`, a cohesive helper module beside `ownership.ts`

**Key Decisions / Notes:** `server.ts` keeps re-exporting the path getters and everything moved. `ownership.ts` is the only code that may signal process groups — do not add a signalling path; move only non-signalling helpers.

**Definition of Done:**
- [ ] Both < 400; export surfaces unchanged; `bun test src/sidecar/ src/runtime/` green

**Verify:** `bun test src/sidecar/ src/runtime/`

---

### Task 7: Split `sidecar/client-routes.ts`

**Objective:** Under 400 lines.
**Dependencies:** Task 1
**Wave:** 2

**Files:**
- Modify: `src/sidecar/client-routes.ts`, `src/sidecar/client.ts` (only if the extends chain changes)
- Create: domain layers, e.g. `src/sidecar/client-routes-memory.ts`, `client-routes-spec.ts`, `client-routes-worktree.ts`

**Key Decisions / Notes:** Abstract-class chain so `SidecarClient extends SidecarRoutes` keeps every method; `client.ts` must not import `bun:sqlite`. `client.ts` is itself near its limit.

**Definition of Done:**
- [ ] Every file < 400; `SidecarClient` method set unchanged (compare `Object.getOwnPropertyNames` up the prototype chain)
- [ ] `bun test src/sidecar/ src/hooks/ targets/opencode/plugins/` green; bundle guard green

**Verify:** `bun test src/sidecar/ src/hooks/ targets/opencode/plugins/ src/cli/target-assets.test.ts`

---

### Task 8: Remove dead code and needless exports

**Objective:** No dead functions; `export` only where something imports it.
**Dependencies:** Tasks 4–7
**Wave:** 3

**Files:** the modules listed under "E" (search by name; several moved in Wave 1–2).

**Key Decisions / Notes:** Re-verify each with `rg` across `src/ targets/ scripts/ tests/` first. Never touch `src/index.ts` exports or test-only helpers. Behaviour-preserving.

**Definition of Done:**
- [ ] Truth 7; tsc, eslint, full suite green

**Verify:** `bunx tsc --noEmit && bunx eslint . && bun test`

---

### Task 9: Dev docs

**Objective:** Rules describe the new behaviour.
**Dependencies:** Tasks 1–8
**Wave:** 4

**Files:** `.sentinal/rules/sentinal-project.md`, `sentinal-sidecar.md`, `sentinal-mcp-servers.md` (tdd notes), `sentinal-testing.md` (TDD race gone; CI gate), `sentinal-hooks-development.md` if hook behaviour text changes.

**Definition of Done:** [ ] D1–D6 recorded; the "Deferred Issues" of the hardening-sweep plan cross-referenced as resolved; line refs current.

---

### Task 10: Format once + CI gate

**Objective:** CI fails on type errors, lint errors and unformatted files, for pushes and PRs.
**Dependencies:** Tasks 1–9
**Wave:** 5

**Files:**
- Modify: `.github/workflows/release.yml`, `package.json` (scripts), and every file `prettier --list-different .` lists (formatting only)

**Key Decisions / Notes:**
- D5. Formatting in a separate commit from the workflow/scripts change. Check `git diff -w` shows only wrapping changes. Run the exact CI step list locally (from a clean export of the index, like `verify-index.sh`) before pushing. Watch the first CI run.

**Definition of Done:**
- [ ] Truths 3, 4; local CI step list green; full suite green
- [ ] A deliberately unformatted temp file makes `bun run format:check` exit 1 (then removed)

**Verify:** `bun run typecheck && bun run lint && bun run format:check && bun test`
