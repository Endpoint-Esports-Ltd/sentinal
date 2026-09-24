# Orca Support Follow-ups Implementation Plan

Created: 2026-09-24
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Bugfix

## Summary

**Goal:** Close the remaining Orca-support findings: recover stranded data, fix four release/update defects, make Sentinal capture tool failures (repairing Claude Code TDD detection on the way), and stop `worktree_create` nesting worktrees inside worktrees.

**Architecture:** Four independent workstreams. **A** is a one-off, backed-up data repair on the user's database plus a guard so tests can never write to the real `SENTINAL_HOME` again. **B** fixes the release build, `sidecar restart`, the V13 message and `sentinal update`. **C** adds a bundle-safe failure classifier with signature de-duplication, wires Claude Code's `PostToolUseFailure` (and fixes the hooks that read Bash output from a field that does not exist), and — after a spike — the OpenCode equivalents. **D** keys the worktree slot pool on the canonical project, re-keying live rows lazily inside the allocator's existing transaction.

**Tech Stack:** TypeScript (strict), Bun, `bun:test`, SQLite + sqlite-vec, semantic-release.

## Scope

### In Scope

- **A** Re-key the user's 97 Orca-worktree observations (and their 391 vectors, 18 sessions, 1 spec) to the canonical project; delete 205 test-leaked observations; prevent tests writing to the real `SENTINAL_HOME`.
- **B** Plugin bundle gets the release version; `sidecar restart` backgrounds by default; V13 message drops "(D1)" and names the backup; `sentinal update` warns when the running sidecar is older.
- **C** `error` observations for failed tool calls, de-duplicated, both targets; Claude Code hooks read real Bash output; Claude Code TDD tracker sees failing test runs.
- **D** `worktree_create` bases off the main checkout; slot pool keyed on the canonical project; live rows re-keyed safely; `baseCommit` records the base branch.

### Out of Scope

- A shipped `memory rekey` command. Data shows only this user has stranded **observations** (97, all Orca). The 303 rows under deleted `.sentinal/worktrees/spec-*` paths are **sessions** — ended history that neither conflict detection nor ownership reads. User decision.
- `PermissionRequest` / `SubagentStart` / `TeammateIdle` hooks; Orca `orchestration` for `spec-master-execute`.
- `mergeSharedObservations` conflation; `specs.id` project qualification; `/tdd-state` requiring a project; the migration-ladder retry weakness; un-normalized sidecar read routes. All recorded earlier, unchanged.
- `targets/claude-code/.claude-plugin/plugin.json` hard-coded `"0.1.0"` — a different defect (never bumped at all), noted only.

## Context for Implementer

> Assume you have never seen this codebase. This checkout is itself a linked git worktree (Orca) of `/Users/evan/Projects/endpoint_esports/sentinal` — a useful live fixture.

**Established rules that still apply** (`.sentinal/rules/sentinal-project.md`): `resolveProjectIdentity()` → storage keys only; `resolveWorkspaceRoot()` → filesystem writes only. Workstream D deliberately writes under the identity root once (new worktrees live under `<main>/.sentinal/worktrees/`) — document it as an exception.

### Workstream B facts (verified)

- **Plugin version.** `.releaserc.json:9-15` runs `@semantic-release/exec` (`prepareCmd` → `scripts/release-build.mjs`) BEFORE `@semantic-release/npm` bumps `package.json`. `release-build.mjs:47,54` gives CLI binaries an explicit `--define`, but `:39` runs `bun run build:opencode`, whose define reads `package.json` (`package.json:36`) — still the previous version. `:40` then embeds that bundle. Installed 1.38.0 plugin returns `"1.37.1"`. Since `b0a907c` (2026-03-10).
  - Effect: `noteVersionSkew` (`src/sidecar/client.ts:202-219`) logs a false mismatch on every plugin connect and, worse, sees a genuinely stale sidecar as equal. Compiled-binary readers are unaffected.
  - Existing test `src/cli/target-assets.test.ts:321-329` compares the bundle against `package.json` — the same stale source — so it cannot catch this, and it **currently fails in this worktree** because local `dist/` came from a release build. Test pattern to copy: `src/sidecar/retire-check.test.ts:220-251` (build with a given `--define` into a temp dir).
  - `scripts/pre-release.mjs:44-63` calls the same build; keep it consistent. Do not use `${VAR:-default}` inside a `package.json` script (not portable); prefer a small `.mjs` build script.
- **`sidecar restart`** (`src/cli/commands/sidecar.ts:158-211`): without `-d` the restart process **becomes** the sidecar and blocks; interrupting it kills the sidecar. With `-d`, `startBackground` (`:249-264`) spawns **without `detached`**, so a tool runner killing its process group kills it too. The restart sleeps a fixed 200ms (`:168`) instead of waiting for the old PID, and the old process's `stopSidecar` can delete the NEW sidecar's socket if slow (`server.ts:504-521`). The foreground path skips `assessSidecarStart` and ignores `alreadyRunning` (`:183` would throw). No tests exist for restart. Advice to run it: `README.md:91`, `src/sidecar/retire-notify.ts:58` (surfaced to agents at SessionStart), `src/sidecar/client.ts:211`; pinned by `retire-notify.test.ts:77,82`.
- **V13 message** (`src/memory/migrations.ts:101-105`): `backupDatabase(dbPath)` (`maintenance.ts:109-127`, always `${dbPath}.bak`) is called at `migrations.ts:26-33` but its return value is discarded. Tests: `migrations.test.ts:321-336,338-349,352-368,387-394`.
- **Update warning** (`src/cli/commands/update.ts`): the `update` process is the OLD binary; it runs `<new-binary> update --reinstall-plugins` (`:447-458,481`) which executes `reinstallPlugins()` in the NEW binary (`:523-529`) — the natural place to compare, since `getSentinalVersion()` there is the new version. Fallback path runs the old binary in-process (`:497`); `downloadAndInstall` returns a boolean (`:361`), losing `remoteVersion`. Query the sidecar with `SidecarClient.connect()` + `health()` — **never** `connectWithRetry`/autostart. Connecting from the new compiled binary also triggers `noteVersionSkew` → `requestRetire`, so the update itself starts healing the stale sidecar.

### Workstream C facts (verified against https://code.claude.com/docs/en/hooks)

- **Bash `tool_response` is `{stdout, stderr, interrupted, …}` — there is no `output` field.** Three readers use `tool_response.output`: `src/hooks/memory-observer.ts:40`, `src/hooks/tdd-tracker.ts:173`, `src/cli/commands/hook.ts:44`. The only test (`memory-observer.test.ts:165-205`) feeds a made-up `{output}` shape.
- **`PostToolUse` fires only on success; a non-zero Bash exit fires `PostToolUseFailure`**, which Sentinal does not register. Payload: common fields + `tool_name`, `tool_input`, `tool_use_id`, `error` (string; Bash's first line is `Exit code N`, then interleaved stdout/stderr; may be middle-truncated with `... [N characters truncated] ...`; may be a bare message), optional `is_interrupt`, optional `duration_ms`. It does **not** fire for schema/validation rejections or permission denials. Output: `additionalContext` only — an async capture hook is appropriate.
- **Consequence in production:** `spec_events` holds 21 `tdd_cycle` rows, all `phase: "test_written"`; the tracker's `red_confirmed` (`tdd-tracker.ts:125`) and `green_confirmed` (`:148`) have **never fired**. The Claude Code error→fix capture rules have never seen a failed command either.
- **The 22 existing `error` observations were all saved manually** via `memory_save`. No auto-capture rule in `src/memory/capture.ts` returns `type: "error"`; `ERROR_INDICATORS` (`:82-93`) is used only to detect error→fix sequences.
- **Redaction:** `MemoryService.addObservation` sanitizes only `title` and `content` (`src/memory/service.ts:73-84` → `sanitize.ts:117-129`). Never put raw error or command text into `metadata` or `tags`.
- **No existing de-duplication** for auto-captured observations. Precedents: `instructions-loaded.ts:39-70` (search + title match), `src/sidecar/idempotency.ts` (TTL records in `settings`). Recommended: a `metadata.signature` hash and a direct indexed query (`idx_obs_project`, `idx_obs_type` exist).
- **OpenCode.** `tool.execute.after` (`targets/opencode/plugins/sentinal.ts:527-761`) already reads `metadata.exit` for bash (`:708-714`); non-zero exits arrive there. **Tools that throw skip the after hook entirely** (upstream `packages/opencode/src/session/tools.ts:102-131`); per upstream they surface on the plugin `event` hook as `message.part.updated` with `part.type === "tool"` and `part.state.status === "error"` (`@opencode-ai/sdk` `ToolStateError`, `types.gen.d.ts:248-274`). Unconfirmed on the installed OpenCode 1.18.32 — hence Task 8's spike. The plugin's local `event` type (`sentinal.ts:151-163`) is too narrow to read `properties.part`. Sentinal's own guard errors (`[Sentinal TDD Guard] …`, `sentinal.ts:272,500,617`) would appear as tool errors and must be excluded by prefix.

### Workstream D facts (verified)

- **User's DB has no live worktrees** (63 rows: 44 merged, 19 abandoned; all four `project_path` values are main checkouts). The re-key logic matters only for other users — test it thoroughly regardless.
- Writers of `worktrees.project_path`: `create.ts:54,109` and **`reconcile.ts:73,110`** (a second writer). No UPDATE ever touches the column.
- Readers filtering on it: `store.ts:94-104` `listForProject`, `:152-167` `countActive`, `:182-193` `listLiveSlots` (used by `slots.ts:112,191,254`), `:230-268` `resolveBySlug` (compares `canonicalPath` in TS, `:261-264`); index `idx_wt_slot_live` on `(project_path, slot)` WHERE live (`migrations.ts:164-166`).
- ⛔ `wt.projectPath` is ALSO used as a git working directory for merge, abandon and cleanup (`manager.ts:124-149,270-314,339-367`; `merge-guards.ts:138-211`; `cleanup.ts:139-141`) and as the seed root (`reconcile.ts:184`). After this change those operations run in the **main checkout** — the intended home per the "MAIN checkout" wording in `merge-guards.ts:120-173`, and today they fail from a linked worktree whenever `main` is checked out in the main checkout.
- A naive one-statement UPDATE of colliding live rows onto one key **fails safely** (the unique index raises and the transaction rolls back). The hazard is only mixed keys.
- The runtime reads the slot from each worktree's `.sentinal/worktree.env` (`src/runtime/loader.ts:195`), not the DB; seeded `.env` files are never overwritten (`worktree-config.ts:304-307`).
- `create.ts:67` records `getCurrentCommit(repoRoot)` — the HEAD of the invoking checkout — as `baseCommit`, although the worktree branches from `base`.
- Fixture for real linked worktrees: `src/project/identity.test.ts:10-17,34-61` (`realpathSync(makeTmpDir())`, `git init -b main`, `git worktree add`, 15s timeouts).

### Workstream A facts (verified)

- Stranded: `observations` 97; `observation_vectors` (vec0, aux column `+project`) 391 covering all 97; `sessions` 18 (one with `end_time IS NULL`); `specs` 1. FTS has no project column. Embeddings do not include the project — **no re-embedding needed**.
- **sqlite-vec 0.1.7-alpha.2 supports `UPDATE … SET project = ?` on the auxiliary column in place** (verified on an in-memory table). vec0's `changes()` is unreliable (reported 10 for 2 rows) — verify with `COUNT(*)` before/after.
- `/usr/bin/sqlite3` cannot load vec0. Use `/opt/homebrew/opt/sqlite/bin/sqlite3 -cmd ".load <repo>/node_modules/sqlite-vec-darwin-arm64/vec0"`, or Bun with `Database.setCustomSQLite(<brew libsqlite3>)` + `loadExtension` as `vector-store.ts:64-125` does.
- Test pollution: 205 observations with `project_path LIKE '/var/folders/%sentinal-test-%'`, last written 2026-09-01.

### Cross-cutting gotchas

- `quality_report` runs prettier **project-wide with auto-fix** — always pass a `file`. ESLint cannot run (no config). Use `bunx tsc --noEmit` **and** a separate plugin-graph check (root tsconfig excludes `targets/`; needs `typeRoots` + `allowImportingTsExtensions`, see the previous plan).
- `src/cli/embedded-assets.ts` is gitignored and regenerated; re-run `bun run embed-assets` after any `targets/` edit.
- Test timeouts: default 5s; git- and subprocess-spawning tests need an explicit 3rd argument.

## Assumptions

- `worktrees` live rows are few enough to load in full inside the allocator's transaction — supported by `resolveBySlug` already doing so (`store.ts:247-265`). Task 12.
- A live row's `worktree_path` still exists on disk, so `getMainWorktreeRoot(row.worktree_path)` answers its canonical project — supported by reconcile self-healing rows whose directory is gone. Task 12.
- OpenCode delivers `message.part.updated` to plugins — **unverified; Task 8 decides.** Task 14.
- Deleting the 205 leaked rows loses nothing real — every one has a `sentinal-test-*` temp path and a synthetic title. Task 1.

## Key Decisions

- **D1 — The data repair is a one-off, not shipped code** (user decision, supported by data: stranded observations exist only for this user).
- **D2 — Tool failures are captured as `error` observations only when they carry information.** Excluded: interrupts, Sentinal's own guard errors, "no match" exits (`grep`/`rg`/`diff`/`test`/`which` exit 1), and assertion-only test failures (the TDD cycle already records those as `fix`/`pattern`). Infrastructure failures inside a test run (`Cannot find module`, `SyntaxError`, `error TS…`) ARE captured.
- **D3 — De-duplicate by signature over a 30-minute window**, querying the observations table (no new table, survives sidecar restarts). A repeat increments `metadata.occurrences` rather than inserting.
- **D4 — Slot collision revealed by a re-key: the longest-held live row keeps the slot; the loser is re-slotted through the EXISTING path, with a loud warning.** *(Revised after review, user re-confirmed.)* The original "loser gets NULL + warning" could not hold: reconcile's `ensureSlot` (`reconcile.ts:62,162`) re-assigns a free slot on the next `worktree_detect`, and my claim that `runtime_up` would refuse the loser was false — the runtime reads ports from the loser's seeded `.env`, which is never overwritten. The collision already exists before the re-key (both worktrees hold the same slot in different pools); re-keying only reveals it. So: inside the transaction the loser is set to `slot = NULL` **before** any re-key UPDATE (otherwise the unique index error is misread as a lost race — see Task 12); after commit it is re-slotted by the same `tryAssignFreeSlot` + `worktree.env` rewrite path `ensureSlot` uses, and the existing `warnIfSlotMismatch` wording tells the user to re-seed its `.env`. The transient NULL is a deliberate exception to "nothing in production writes slot = NULL" (`store.ts:198-204`, `slots.ts:17-23`) and must be documented there.
- **D5 — Squash-merge, abandon and cleanup now operate in the main checkout.** This is identical to invoking them from the main checkout today. Squash-merge already records the original branch and restores it in a `finally` (H3, `manager.ts:268-308`), and refuses a dirty main checkout (`merge-guards.ts:120-173`). What changes is only that the main checkout's HEAD moves *temporarily* during a merge started from a linked worktree. Accepted, tested and documented; a `base` already checked out in another linked worktree must produce a clear error.
- **D6 — Re-keying is lazy, inside `BEGIN IMMEDIATE`, never a migration.** Migrations run in every `MemoryStore` constructor (hooks included) and cannot reason about filesystem state.

## Plan Review (2026-09-24) — 5 must_fix, 5 should_fix, 2 consider

| Finding | Resolution |
| --- | --- |
| **must** `updateObservation` replaces metadata, resets timestamp/quality, re-embeds the vector each call | Task 7 uses a dedicated `json_set` counter update |
| **must** D4 "NULL slot" can't hold: `ensureSlot` re-slots; `.env` keeps the winner's ports; my `runtime_up` claim was false | D4 revised; user re-confirmed "re-slot via existing path + warning" |
| **must** git subprocess per row inside `BEGIN IMMEDIATE`, across all projects | Task 12: one `worktree list` before the transaction, repo-scoped, SQL-only inside |
| **must** canonical writes (Wave 2) before canonical readers (Wave 4) → duplicate rows | Task 13 absorbs reconcile/manager/cleanup; `resolveBySlug` moves to Task 12 |
| **must** version check read only `dist/`; binaries ship the embedded copy; npm `prepack` rebuilds too | Task 3 asserts `embedded-assets.ts` as well and resolves the tarball path |
| should: re-key before nulling → unique error misread as `SLOT_RACE` forever | Task 12 nulls losers first; test for no `SLOT_RACE` |
| should: D5 moves a clean main checkout's HEAD | Verified H3 already restores the original branch (`manager.ts:268-308`); D5 rewritten and tested in Task 13 |
| should: vectors are chunk rows keyed by aux `observation_id`, not rowid | Task 1 corrected; rehearse on a copy |
| should: preload guard may miss a leak via the real sidecar | Verified `paths.ts` uses `getSentinalHome()`, so the guard covers it; asserted in Task 2 |
| should: incomplete Files lists; possible Task 2/7 overlap | Lists completed; Task 2 moved to Wave 2; `plan_impact` re-run |
| consider (2) | Recorded; no plan change |

Confirmed by review: Bash `tool_response` really is `{stdout, stderr, …}` in real transcripts; Pre-Mortem 1 does not occur.

## Testing Strategy

- Real git fixtures for every identity-sensitive test (no mocked git output).
- Claude Code hook tests must use the **documented** payload shapes: Bash `tool_response: {stdout, stderr, interrupted}`; `PostToolUseFailure` with `error: "Exit code 1\n…"`, `is_interrupt`, `tool_use_id`, `duration_ms`.
- Mutation-test every discriminating assertion.
- Each commit must pass standalone (tsc, plugin-graph tsc, full suite).

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Data repair corrupts the user's DB | Low | **High** | Backup first; one transaction; counts asserted before/after; run in the main context, never a subagent |
| Failure capture floods memory (retry loops) | High | Medium | D2 exclusions + D3 signature dedupe; a test drives 10 identical failures and asserts 1 row |
| Raw secrets land in memory from failure text | Medium | High | Failure text only in `title`/`content` (redacted); a test asserts `metadata`/`tags` never contain the error string |
| New `PostToolUseFailure` TDD routing double-fires with `PostToolUse` | Low | Medium | Mutually exclusive by definition (success vs failure); test both events for one command |
| Re-key assigns the same slot twice | Low | **High** | Re-key and allocation in one `BEGIN IMMEDIATE`; unique index as backstop; concurrency test |
| Re-key holds the write lock while spawning git per row | High (as first designed) | High | *Revised:* one `git worktree list --porcelain` for this repo **before** the transaction; only SQL inside it |
| Re-key UPDATE order raises the unique index, misread as a lost race → permanent "retry" | Medium | High | NULL losers first, then re-key; test that a colliding pair never yields `SLOT_RACE` |
| Canonical writes land before canonical reads → duplicate rows | High (as first designed) | High | *Revised:* create, reconcile, manager and cleanup change together in Task 13; `resolveBySlug` in Task 12 |
| Squash-merge temporarily moves the main checkout's HEAD | Medium | Medium | H3 already restores the original branch and refuses a dirty tree; tested; documented |
| Restart change breaks users relying on foreground restart | Low | Low | `--foreground` flag; documented |

## Pre-Mortem

1. **We fixed the readers but the Claude Code TDD tracker still never confirms RED**, because the failing test run's text arrives in `error` on `PostToolUseFailure` with an `Exit code 1` prefix that `TEST_FAIL_INDICATORS` doesn't match. (Tasks 11) → Trigger: a real failing `bun test` through the new route leaves the cycle in TEST_WRITTEN.
2. **The plugin version fix passes tests but the next release still ships a stale bundle**, because `release-build.mjs` isn't the only caller or the assertion checks the wrong file. (Task 3) → Trigger: after release, the installed plugin's `getSentinalVersion()` ≠ the release tag. Mitigated by the in-release assertion.
3. **Failure capture silently captures nothing on OpenCode**, because `message.part.updated` doesn't reach plugins on 1.18.32. (Tasks 8, 14) → Trigger: the spike logs zero error events for a deliberately failing tool.

## Execution Waves

**Wave 1** (parallel, disjoint files): Tasks 3, 4, 5, 6, 7, 8, 12.
**Wave 2** (parallel): Tasks 2 (moved: the leaking test may be a memory test file that Task 7 edits), 9 (after 4), 10 (after 6, 7), 13 (after 12).
**Wave 3** (parallel): Tasks 11 (after 10), 14 (after 6, 7, 8).
**Wave 4**: Task 15 (docs only, after all).

*Revised after review:* Task 13 now owns every canonical reader and writer of the slot pool (create, reconcile, manager, cleanup) so no commit ever writes canonical keys that its readers cannot find; `resolveBySlug`'s comparison moved into Task 12. Task 15 is documentation only.
**Task 1 (data repair)** runs in the **main context** immediately after approval, before any code task, because it must happen while this worktree exists and should not be delegated. It intentionally has no `**Wave:**` field.

**`plan_impact` (2026-09-24):** 15 tasks, 51 files, **no same-wave overlaps**; Task 1 correctly unassessed. Reach HIGH, led by `src/memory/store-observations.ts` (206/418, 49%) and `src/memory/migrations.ts` (205, 49%), then the worktree cluster at 26–32%. Tasks 5, 7 and 12 must run the full suite. ⚠️ Lesson from the previous plan: this result is only as good as the `Files:` lists — each implementer must report any file they had to touch outside their list, and the orchestrator re-checks overlaps before each wave.

## Goal Verification

### Truths

1. `SELECT COUNT(*) FROM observations WHERE project_path='/Users/evan/orca/workspaces/sentinal/orca-support'` = 0 and the canonical project has 342+97 = 439; vectors likewise 0 / 2315.
2. `SELECT COUNT(*) FROM observations WHERE project_path LIKE '/var/folders/%sentinal-test-%'` = 0.
3. A bundle built for version `X` contains `return "X"` in `getSentinalVersion` (test), and `release-build.mjs` fails the release when it does not.
4. `sentinal sidecar restart` returns immediately and the sidecar survives the invoking process exiting.
5. The V13 message contains no `(D1)` and names the backup path.
6. `sentinal update` prints a stale-sidecar line when the running sidecar is older.
7. A real failing `bun test` in a Claude Code hook fixture moves a TEST_WRITTEN cycle to RED_CONFIRMED.
8. 10 identical tool failures produce exactly 1 `error` observation with `occurrences: 10`.
9. `worktree_create` from a linked worktree creates under `<main>/.sentinal/worktrees/` and stores the canonical project.

### Artifacts

| Artifact | Provides | Exports |
| --- | --- | --- |
| `scripts/build-opencode.mjs` | Versioned plugin build | CLI `<version> [outfile]` |
| `src/memory/tool-failure.ts` | Bundle-safe failure classifier | `classifyToolFailure` |
| `src/hooks/tool-failure-observer.ts` | CC `PostToolUseFailure` capture | `processToolFailure` |
| `src/cli/commands/sidecar-restart.ts` (or equivalent) | Testable restart | `runRestart` |

### Key Links

| From | To | Via | Pattern |
| --- | --- | --- | --- |
| `targets/claude-code/hooks/hooks.json` | `tool-failure-observer` | `PostToolUseFailure` | `PostToolUseFailure` |
| `src/sidecar/routes.ts` | dedupe | observation insert | `addObservationDeduped` |
| `scripts/release-build.mjs` | `scripts/build-opencode.mjs` | versioned build | `build-opencode` |
| `src/worktree/slots.ts` | `src/project/identity.ts` | canonical pool key | `resolveProjectIdentity\|getMainWorktreeRoot` |

## Progress Tracking

- [x] Task 1: One-off data repair (main context, first)
- [x] Task 3: Plugin bundle gets the release version (Wave 1)
- [x] Task 4: `sidecar restart` backgrounds by default (Wave 1)
- [x] Task 5: V13 message wording + backup path (Wave 1)
- [x] Task 6: Bundle-safe failure classifier (Wave 1)
- [x] Task 7: Signature de-duplication for error observations (Wave 1)
- [x] Task 8: OpenCode tool-error event spike (Wave 1)
- [x] Task 12: Canonical slot pool + lazy re-key (Wave 1)
- [x] Task 2: Tests can never write to the real SENTINAL_HOME (Wave 2)
- [x] Task 9: `sentinal update` warns about a stale sidecar (Wave 2)
- [x] Task 10: Claude Code hooks read real Bash output (Wave 2)
- [x] Task 13: Un-nesting — create, reconcile, manager, cleanup (Wave 2)
- [x] Task 11: Claude Code PostToolUseFailure capture + TDD routing (Wave 3)
- [x] Task 14: OpenCode failure capture (Wave 3)
- [x] Task 15: Documentation (Wave 4)

**Total Tasks:** 15 | **Completed:** 15 | **Remaining:** 0

### Implementation notes

**Task 1 — done (2026-09-24 15:55).**
- Consistent online backup via SQLite's backup API: `~/.sentinal/memory.db.pre-rekey-20260924-155532` (22 MB). Rehearsed on a copy first, with every assertion passing, then run live.
- Live result (one `BEGIN IMMEDIATE`, all counts asserted): observations Orca 97 → 0, canonical 347 → 444; vectors Orca 391 → 0, canonical 1,952 → 2,343; sessions 18 moved; specs 1 moved; **205 test-leaked observations and their 820 vector chunks deleted** (total observations 1,564 → 1,359, vectors 8,174 → 7,354). No canonical observation is left without a vector; FTS rows match (444/444). `PRAGMA quick_check` ok; the live sidecar stayed healthy throughout.
- Verified in production: `memory_search` scoped to the Orca worktree path returns results.
- A KNN self-match check first looked like a failure. It wasn't: many auto-captured observations have **byte-identical embeddings** (e.g. repeated "Fixed issue in <file>" titles and tags), so ties at distance 0.0000 crowd the top-k. The content chunk found itself among the exact matches, identically in the original backup.

**Wave 1 — 3481 → 3601 pass / 0 fail across 401 files; `tsc` clean.** Every changed file was inside its task's list.

- **Task 3:** `scripts/build-opencode.mjs <version> [outfile]` (version required; no silent package.json fallback), exporting `readBakedVersion` / `verifyBakedVersion`. `release-build.mjs` builds with the release version and **fails the release** unless both `targets/opencode/dist/sentinal.mjs` and `src/cli/embedded-assets.ts` bake it. A simulated release (package.json 1.38.0, release 1.39.0) is rejected on the old path and passes on the new one. ✅ **The npm tarball was already correct:** `@semantic-release/npm` bumps `package.json` in *prepare* and publishes later, so `prepack` → `build:opencode` reads the bumped version. The bug affected only the prepare-time bundle — i.e. what the **binaries** embed. The stale test the plan said "currently fails" did not, because local `dist/` had since been rebuilt.
- **Task 4:** `runRestart(opts, deps)` fully injectable. `Bun.spawn({detached:true})` **does** give a new process group on Bun 1.3.10 (probed). Waits ≤10s for the old PID (refuses to start a second sidecar if it won't exit — closes the socket race), then ≤15s for `/health`. `start -d` was the same process-group bug in the same file and was fixed too. Isolated manual check (temp `SENTINAL_HOME`, user's sidecar PID 6571 untouched): restart returned in <1s with a new PID in its own group. ⚠️ **Found:** `sidecar stop` recognises a sidecar only if its argv contains `sidecar start` (`looksLikeSidecarArgv`, `src/sidecar/lifecycle.ts:205`), so one started by `restart --foreground` cannot be stopped — it says "not running", deletes the pidfile, and leaves the process alive. Pre-existing for the old foreground restart. **Added to Task 9.**
- **Task 5:** message is now `database upgraded to schema v13: cleared N TDD cycle record(s) from before per-project tracking — TDD state restarts for those files. Backup: <db>.bak`, or `(backup unavailable)`.
- **Task 6:** `classifyToolFailure` (391 lines), only import `node:crypto` — bundle check clean. Skip reasons: `interrupted`, `sentinal-guard`, `no-match-exit`, `empty-output`, `assertion-only-test-failure`. The assertion exclusion applies **only when the command is a known test runner** (so `npm run lint` failing with "test failed" is still captured). Tool name is lowercased in the signature, so Claude Code's `Bash` and OpenCode's `bash` share signatures across targets.
- **Task 7:** `findRecentErrorBySignature(project, sig, sinceMs)`, `recordErrorRepeat(id, lastSeen)` (json_set only), `addObservationDeduped` (dedupe requires `type === "error"` **and** a signature), route returns `{...observation, deduplicated}`. FTS trigger rewrites identical content on a metadata-only update — harmless, tested. ⚠️ **The direct fallbacks do NOT dedupe** — `memory-observer.ts:119` and `write-mcp-tools.ts:86` call `addObservation` themselves. **Task 11 must use `addObservationDeduped` in its direct fallback.** `service.ts` is now 430 lines.
- **Task 12:** `resolveSlotScope(projectPath, lister?)` → `{key, roots}` computed **before** the transaction; `store.unifyLiveKeys(key, roots)` inside it (NULL losers first, then re-key); losers re-slotted after commit via `tryAssignFreeSlot` + `seedNonFatally` + `warnIfSlotMismatch`. `seedNonFatally` is loaded lazily to avoid an import cycle with `worktree-config.ts`. `resolveBySlug` matches any of the repo's roots. Mutation-tested five ways. ⚠️ **Two consequences the plan did not anticipate:**
  1. `insertWithSlot` now **stores new rows under the canonical key itself**, so `create.ts:109` and `reconcile.ts:110` already write canonical keys without being edited (Task 13's edits there become explicit rather than functional).
  2. Existing live rows are re-keyed to the main checkout as soon as an allocation runs, so D5 (merge/abandon/cleanup in the main checkout) is live from this commit, before Task 13's D5 tests. Same release, acceptable; Task 13 adds the tests.
  - `ensureSlot` does not yet forward `AssignSlotResult.notices` — **added to Task 13.** `slots.ts` is now **574 lines** (warn 400, block 600).

**Wave 2 — 3601 → 3676 pass / 0 fail across 405 files; `tsc` clean.**

- ⛔ **Task 10 found a second production bug, and it was fixed in the main context before Wave 3.** `TEST_FAIL_INDICATORS[0]` was `/\d+\s+fail/i`. Every *passing* bun run prints ` 0 fail`, so it matched as a failure; the tracker checks failure first and returns, so **GREEN has never fired for bun users on Claude Code or OpenCode** (the plugin imports the same indicators, `sentinal.ts:313,323`). The plan review had retired Pre-Mortem 1 on the strength of this very pattern matching ` 1 fail` — true, and incomplete. Fix (`src/memory/capture.ts`): both indicators now require a non-zero count (`/\b[1-9]\d*\s+fail/i`, `/\b[1-9]\d*\s+pass/i`), so an all-failing ` 0 pass` isn't read as a pass either. Four new indicator tests with real runner summaries; Task 10's `it.failing` regression test ("a real passing bun run moves RED_CONFIRMED → cleared") now passes and is a plain `it`. Mutation: restoring `\d+` fails 2 tests. Done in the main context because every Wave 3 task depends on it.
- **Task 10:** `bashOutputOf(input)` in `hook-output.ts` (stdout+stderr → legacy `output` → `error` only when `tool_name` is set, so StopFailure's `error: "rate_limit"` is ignored → legacy `tool_input.output`), and `trackerInputFromHook(input)` exported from `tdd-tracker.ts` — Task 11 can pass a `PostToolUseFailure` payload straight through. The made-up `{output}` fixtures were replaced by tests that run the real functions; `hook.test.ts` spawns the real `sentinal hook shared tdd-tracker`. Seven mutants, all caught.
- **Task 2:** the leak was `memory-observer.test.ts:305` ("should include agent_id and duration_ms…"), which built an unused temp store and then called the real observer → the user's live sidecar or default DB, one row per full-suite run, 2026-05-26 → 2026-09-01. **Already fixed by `e3f9194` (2026-09-02)**, which redirected `SENTINAL_HOME` in the preload — but that guard had three gaps, now closed:
  1. the preload imported `vector-store.js` before setting the env var, freezing `DEPS_DIR` to the real `~/.sentinal`;
  2. no cleanup — **495 temp homes (≈1 GB)** had accumulated, mostly each holding a fresh 23 MB model download (now a shared read-only-copied model cache; a 24h sweep; per-run cleanup in `afterAll`, since `process.on("exit")` never fires under `bun test`);
  3. it broke the E2E harness since 2026-09-02 — sandboxes inherited the runner's temp home and shared one DB; `spec-workflow.e2e.ts` went 0/4 → 3/4.
  - A pre-set `SENTINAL_HOME` is honoured only if it is under the system temp dir and not inside `~/.sentinal` (a developer's exported value may be their real store).
  - Touched outside its list: `tests/e2e/harness/sandbox.ts` and `sandbox.spec-e2e.ts` (no wave overlap). The TDD guard does not recognise `*.spec-e2e.ts` as a test file.
- **Task 9:** warning text: `Running sidecar is vX (installed vY). It will retire when no sessions are active, or run 'sentinal sidecar restart' to switch now.` Uses `connect()` only, 3s cap, never throws. `downloadAndInstall` now returns the installed version. `looksLikeSidecarArgv` accepts `sidecar restart` as whole consecutive words. ⚠️ `update.ts` is now **597 lines** — 3 under the block; the next change there needs a split.
- **Task 13:** create/reconcile/cleanup/manager all key on the main checkout. `baseCommit` from `git rev-parse --verify <base>^{commit}` and the worktree is created from that exact commit. Cleanup guard 2 accepts `<any checkout>/<config.directory>`, so previously nested worktrees are reclaimable; the Orca-style branch is still refused. `ensureSlot` forwards `notices`. Touched outside its list (no wave overlap): `merge-guards.ts` (`inMainCheckout`, `assertBaseFreeForMerge`) and `types.ts` (new error code `BASE_CHECKED_OUT`).
  - **D5 turned out to need its own fix:** because re-keying is lazy, a legacy row merged before any allocation still ran in the linked worktree and failed with `'main' is already used by worktree`. `inMainCheckout(row)` derives the main checkout from the worktree directory, independent of the stored key.
  - A `base` checked out in another linked worktree used to fail *after* the runtime had been stopped; it is now refused up front with `BASE_CHECKED_OUT` ("Nothing has been merged").
  - Behaviour change: `manager.list()` on a non-repo path returns `[]` instead of throwing `NOT_A_REPO`.
  - 20 mutants, 19 caught; the survivor (dropping `inMainCheckout` from `abandon`) is behaviour-equivalent because `git worktree remove` works from any checkout.

**Waves 3–4 — 3721 pass / 0 fail across 407 files; `tsc` clean; plugin-graph `tsc` clean; bundle clean and bakes `1.38.0`.**

- **Task 11:** `processToolFailure` (`src/hooks/tool-failure-observer.ts`). Two `PostToolUseFailure` groups in `hooks.json`: `tdd-tracker` on `Bash`, and `tool-failure-observer` on the **anchored** matcher `^(Bash|Write|Edit|MultiEdit|Read|Grep|Glob|WebFetch|mcp__.*)$` — unanchored, a regex matcher would also fire for `NotebookEdit`, `BashOutput` and `ReadMcpResourceTool`. Direct fallback uses `addObservationDeduped`. Pre-Mortem 1 closed end-to-end: a real failing `bun test`, fed as `error: "Exit code 1\n…"` through the spawned `sentinal hook shared tdd-tracker`, moves TEST_WRITTEN → RED_CONFIRMED.
  - ⛔ **Redaction must happen before classification.** The classifier truncates titles at 120 characters, and a secret truncated below the redactor's minimum token length slips through. The hook redacts first; tested.
  - Excluded classes are not pushed to the event buffer (a following edit is not a "fix"); assertion-only test failures are, so a failing test followed by an edit is captured as a fix.
  - `memory-observer.test.ts:305` (the historical leak source) now asserts `agent_id`, `agent_type`, `duration_ms` and `last_assistant_message` reach the metadata.
  - 16 mutants, all caught.
- **Task 14:** Bash non-zero exits in `tool.execute.after`; thrown failures via `message.part.updated` error parts (spike GO). Exclusions: interrupts, the abort marker, the user's own permission decisions, `[Sentinal`. De-duplicated on `part.id` (bounded set of 500), never `callID`. The local event type was widened; the SDK union is not used.
  - Found during GREEN: awaiting the failure send before `eventBuffer.push` let the next tool call's event overtake the current one and broke error→fix detection (an existing test caught it). The failure is now sent after the heuristic capture.
  - 11 of 13 mutants caught; the two survivors are deliberately double-checked conditions (removing one copy changes nothing).
- **Task 15:** rules file rewritten — the "110 + 81" claim corrected (sessions, not observations); the `handleCompactionAutocontinue` conflation removed (fixed in v1.38.0); the "`worktree_create` still nests" limitation replaced by how the canonical slot pool works; new sections on verified Claude Code hook payloads, OpenCode tool failures, and the release-build ordering. README: restart is background by default. Also corrected a now-stale comment in `native-deps.test.ts` (flagged by Task 2) and strengthened it into an assertion that `DEPS_DIR` resolves under the isolated test home.

### Task 8 spike findings — **GO** for Task 14's thrown-failure half

Real OpenCode 1.18.32 (`opencode serve`) in an isolated temp HOME, driven over HTTP by a local fake OpenAI-compatible model returning scripted tool calls (no credentials copied); a throwaway plugin logged every event. All spike processes killed by PID, temp dirs deleted.

| Case | `tool.execute.after` | Final tool part | `state.error` |
| --- | --- | --- | --- |
| edit, oldString not found | **no** | `error` | `Could not find oldString in the file. It must match exactly, …` |
| read of a missing file | **no** | `error` | `File not found: <abs path>` |
| edit, schema-invalid args | **no** | `error` | `The edit tool was called with invalid arguments: SchemaError(…)` |
| bash denied by rule | **no** | `error` | `The user has specified a rule which prevents you from using this specific tool call. …` |
| bash `ask` rejected | **no** | `error` | `The user rejected permission to use this specific tool call.` |
| abort during a permission prompt | **no** | `error`, `metadata.interrupted: true` | `Tool execution aborted` |
| plugin throws in `tool.execute.before` | **no** | `error` | `[Sentinal TDD Guard] …` (verbatim) |
| bash `exit 3` / `ls /nope` / aborted `sleep` | yes, `metadata.exit` 3 / 1 / null | **`completed`** | — |

- **No double-capture:** bash failures always finish `completed` via `tool.execute.after`; thrown failures never reach it. Each error part was emitted exactly once.
- **Shape to code against:** `event.type === "message.part.updated" && properties.part.type === "tool" && properties.part.state.status === "error"`; read `part.tool`, `part.id`, `part.callID`, `part.sessionID`, `part.state.input`, `part.state.error`, `part.state.metadata`. The real `properties` is `{sessionID, part, time}`, **not** the SDK 1.4.7 typing — widen the local type, don't trust the SDK union.
- **Exclude:** `[Sentinal` prefix; `metadata.interrupted`; and the user's own permission decisions ("The user rejected permission…", "The user has specified a rule which prevents you…") — user choices, not tool failures.
- **De-duplicate on `part.id`** (`prt_…`), never `callID` alone — the provider-issued `callID` repeated across two parts in the spike.
- Not observed: TUI / `opencode run` entry points (same in-process loop as `serve`), real provider call IDs, MCP and `task` subagent errors.

## Verification (2026-09-24)

| Gate | Result |
| --- | --- |
| Full suite (final tree) | **3721 pass / 0 fail**, 407 files (baseline 3481; +240 tests) |
| `bunx tsc --noEmit` | clean |
| Plugin-graph `tsc` (out-of-repo tsconfig) | clean |
| Bundle | builds; no `bun:sqlite` / `sqlite-vec` / `@xenova`; bakes `1.38.0`; embedded copy regenerated |
| Parity fixtures | unchanged |
| Test rows leaked into the real DB during the full run | **0** |

**Live smoke — the real CLI and hook dispatcher, isolated `SENTINAL_HOME`, user's sidecar (PID 6571) untouched before and after:**

1. `sentinal sidecar restart` returned in ~1s with exit 0; the old PID exited; the new sidecar answered `/health` and runs in **its own process group** (detached).
2. Three identical `PostToolUseFailure` payloads through `sentinal hook shared tool-failure-observer` → **one** `error` row, `occurrences: 3`, keyed to the canonical project; title `node build.js failed: Cannot find module 'left-pad' [REDACTED:…]` — the embedded API key was redacted, and no error text reached `metadata` or `tags`.
3. An assertion-only `bun test` failure → excluded (no new row).
4. TDD tracker through the dispatcher on the documented payload shapes: test write → `TEST_WRITTEN`; failing run delivered as `PostToolUseFailure` → `RED_CONFIRMED`; passing run with bun's real `{stdout: " 1 pass\n 0 fail"}` → **cleared (GREEN)**. Before this plan none of those three transitions ever happened on Claude Code.
5. The update-time staleness helper printed the warning for a differing version and nothing when versions matched.

Process compliance: every root cause traced to source (release plugin ordering, foreground restart, discarded backup path, nonexistent `output` field, unregistered failure event, zero-count indicators, per-checkout slot keys); fixes at the source; every discriminating assertion mutation-tested.

## Deferred Issues

- `memory-observer.test.ts:305` (the historical leak source) still asserts nothing (`expect(true)`); harmless now that the preload isolates it. **Added to Task 11.**
- E2E: "DIFFERENT LIVE session stops → ALLOWED" in `spec-workflow.e2e.ts` fails identically on a clean HEAD (pre-existing stop-guard/session-start issue). `assertNoRealEscape` hashes all of `~/.sentinal` and trips whenever the user's live sidecar writes, so it is unreliable on a developer machine.
- `update.ts` 597 lines, `slots.ts` 574, `migrations.ts` 530, `routes.ts` 524, `service.ts` 430, `manager.ts` 399 — all under the 600 block; `update.ts` must be split before its next change.

- **Auto-capture writes large numbers of near-identical `fix` observations** ("Fixed issue in <file>", identical tags → identical embeddings). They crowd semantic search with exact ties. Task 7's de-duplication covers only `error` observations; extending it to auto-captured `fix` rows is a separate change.

## Implementation Tasks

### Task 1: One-off data repair

**Objective:** Recover the 97 stranded observations and remove 205 test-leaked ones from the user's real database.
**Dependencies:** None — run first, in the main context.

**Files:** none committed. Scratch script outside the repo.

**Key Decisions / Notes:**

- Back up `~/.sentinal/memory.db` with its `-wal`/`-shm` to a timestamped path first.
- Open with Homebrew SQLite + vec0 loaded (see Workstream A facts). Set a `busy_timeout`; the live sidecar holds a WAL connection.
- One `BEGIN IMMEDIATE` transaction:
  - re-key `observations`, `observation_vectors.project`, `sessions`, `specs` from the Orca path to `/Users/evan/Projects/endpoint_esports/sentinal`;
  - delete the 205 `sentinal-test-*` observations **and their vectors**. *(Corrected after review.)* Vectors are **not** keyed by observation id: `observation_vectors(rowid, embedding, +observation_id, field_type, project, timestamp)` has an explicit rowid and several chunk rows per observation, with `observation_id` an auxiliary column (`vector-store.ts:137-138,182`). So: first `SELECT rowid FROM observation_vectors WHERE observation_id IN (SELECT id FROM observations WHERE project_path LIKE '/var/folders/%sentinal-test-%')`, record the count, then `DELETE … WHERE rowid IN (…)`, **before** deleting the observations (the subquery needs them). No FK blocks or cascades. FTS is maintained by triggers. Rehearse on a copy of the DB first.
- Assert every count before and after (`changes()` is unreliable on vec0). Roll back on any mismatch.
- Afterwards, `memory_search` scoped to this worktree must return the recovered rows via canonicalization, and a vector query must still find them.

**Definition of Done:**

- [ ] Backup exists
- [ ] Orca-keyed counts are 0 in all four tables; canonical counts rose by exactly 97 / 391 / 18 / 1
- [ ] Test-leaked observations and their vectors are 0
- [ ] A semantic search finds a recovered observation

---

### Task 2: Tests can never write to the real SENTINAL_HOME

**Objective:** Find how 205 test observations reached `~/.sentinal/memory.db`, and make it impossible.
**Dependencies:** Task 7 (may share a memory test file)
**Wave:** 2

**Files:**

- Modify: `src/memory/test-preload.ts` (or `bunfig.toml` preload)
- Test: `src/memory/test-isolation.test.ts` (create)

**Key Decisions / Notes:**

- Identify the leaking test(s): titles `Fixed issue in foo.ts`, project paths `…/sentinal-test-<ts>-<rand>`. Grep for the `sentinal-test-` prefix and for code paths that open a `MemoryStore` with no explicit path (default `getDbPath()` → `$SENTINAL_HOME/memory.db`). Determine whether it is already fixed (last row 2026-09-01) and record the answer.
- Guard: the test preload sets `SENTINAL_HOME` to a per-run temp directory **unless** already set, so any test that forgets an explicit path writes to a temp DB. Check the E2E harness (`.opencode/skills/sentinal-e2e-harness`) sets its own and is unaffected.
- The test asserts, under `bun test`, that `getDbPath()` is not under the real home.
- ✅ *Checked after review:* `src/sidecar/paths.ts:8-27` derives the sidecar socket, port and pid paths from `getSentinalHome()`, so the same redirection also stops a test from reaching the user's **running sidecar** — the other plausible leak path. Assert that too.
- If the leaking test file is one Task 7 already modified, that is why this task moved to Wave 2; report any file touched outside this list.

**Definition of Done:**

- [ ] Leak source identified (or confirmed already fixed) and recorded in the plan
- [ ] Under `bun test`, the default DB path is a temp path (test)
- [ ] Under `bun test`, `getSidecarSocketPath()` / `getSidecarPortPath()` are under the temp home, and `SidecarClient.connect()` returns null when no test sidecar runs (test)
- [ ] Full suite green
- [ ] No diagnostics errors

**Verify:** `bun test src/memory/test-isolation.test.ts && bun test`

---

### Task 3: Plugin bundle gets the release version

**Objective:** Every release's OpenCode plugin reports that release's version.
**Dependencies:** None
**Wave:** 1

**Files:**

- Create: `scripts/build-opencode.mjs`
- Modify: `package.json`, `scripts/release-build.mjs`, `scripts/pre-release.mjs`
- Test: `src/cli/target-assets.test.ts`

**Key Decisions / Notes:**

- `scripts/build-opencode.mjs <version> [outfile]` runs the existing `bun build` command with the same externals and an explicit `--define __SENTINAL_VERSION__`. `package.json` `build:opencode` calls it with the `package.json` version (local behaviour unchanged).
- `release-build.mjs:39` calls it with the release `version`. ⛔ *(Corrected after review.)* The check must cover what actually ships: the binaries embed the plugin through `src/cli/embedded-assets.ts` (written by `release-build.mjs:40`), not the `dist/` file. So after embedding, assert **both** `targets/opencode/dist/sentinal.mjs` and `src/cli/embedded-assets.ts` contain the release version's baked `getSentinalVersion`, and exit non-zero otherwise. This runs on every real release, which no unit test can.
- **Second path to a stale bundle:** the npm publish runs `prepack` → `embed-assets` → `build:opencode` (`package.json:38,54`), and `files` includes `targets/`, so the tarball carries its own rebuilt bundle. Determine which version that rebuild sees (the npm plugin bumps `package.json` before publishing, so it may already be correct) and make it consistent — route `embed-assets` through `build-opencode.mjs` too. Record the answer.
- `pre-release.mjs` passes its version consistently.
- Replace the test at `target-assets.test.ts:321-329` (compares against the stale source; currently failing locally) with one that builds to a temp outfile with version `9.9.9-test` and asserts the baked `getSentinalVersion` returns it. Keep the externals/purity assertions.
- Do not move plugin order in `.releaserc.json` as the fix — implicit ordering is what broke.

**Definition of Done:**

- [ ] Temp build with `9.9.9-test` bakes `9.9.9-test` (test)
- [ ] `release-build.mjs` fails when the bundle **or the embedded copy** lacks the version (unit-tested helper)
- [ ] The npm-tarball bundle's version path is determined and made consistent
- [ ] `bun run build:opencode` still works locally; bundle purity unchanged
- [ ] No diagnostics errors

**Verify:** `bun test src/cli/target-assets.test.ts && bun run build:opencode`

---

### Task 4: `sidecar restart` backgrounds by default

**Objective:** `restart` replaces the sidecar and returns, and the new sidecar survives the invoking process.
**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `src/cli/commands/sidecar.ts`
- Create: `src/cli/commands/sidecar-restart.ts` (extracted, injectable)
- Modify: `src/sidecar/retire-notify.ts`, `src/sidecar/retire-notify.test.ts` (only if wording changes)
- Test: `src/cli/commands/sidecar-restart.test.ts`

**Key Decisions / Notes:**

- Default background; add `--foreground` for the current behaviour. Keep `-d` accepted as a no-op alias.
- Wait for the old PID to exit (`isProcessAlive`, `lifecycle.ts:43`) with a timeout, instead of the fixed 200ms sleep — this also closes the race where the old process deletes the new socket.
- Spawn **detached** so a process-group kill of the invoker does not take the sidecar down. Confirm whether `Bun.spawn` honours `detached`; otherwise use `node:child_process` `spawn(…, {detached:true, stdio:"ignore"}).unref()` as the plugin does (`targets/opencode/plugins/sentinal.ts:220`).
- Reuse the `start` path so `assessSidecarStart` and `alreadyRunning` handling apply; in foreground mode, fix the `alreadyRunning` TypeError (`:183`).
- Extract the action into `runRestart({stop, waitForExit, spawnBackground, startForeground})` so it is unit-testable without real processes.
- With background as the default, the existing advice text ("run `sentinal sidecar restart`") becomes correct; leave it unless a test needs updating.

**Definition of Done:**

- [ ] Default restart spawns in the background, detached, and returns (unit test with injected spawn)
- [ ] It waits for the old PID to exit before starting (unit test)
- [ ] `--foreground` preserves the old behaviour
- [ ] Manual check: `sentinal sidecar restart` (from source) returns within seconds and `/health` answers afterwards; record PIDs; kill only the PID you started
- [ ] No diagnostics errors

**Verify:** `bun test src/cli/commands/sidecar-restart.test.ts`

---

### Task 5: V13 message wording + backup path

**Objective:** The migration message is intelligible and names the backup.
**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `src/memory/migrations.ts`
- Test: `src/memory/migrations.test.ts`

**Key Decisions / Notes:**

- Capture `backupDatabase(dbPath)`'s return value (`migrations.ts:26-33`) and pass it to `migrateV13`.
- Suggested text: `[sentinal] database upgraded to schema v13: cleared N TDD cycle record(s) from before per-project tracking — TDD state restarts for those files. Backup: <path>` — `(backup unavailable)` when null. No `(D1)`.
- Keep it on stderr (hooks own stdout). Update the assertions at `:334-335`; assert the `.bak` path appears.

**Definition of Done:**

- [ ] Message has no internal label and names the backup (test)
- [ ] Existing "not printed on re-run / fresh DB" tests still pass
- [ ] No diagnostics errors

**Verify:** `bun test src/memory/migrations.test.ts`

---

### Task 6: Bundle-safe failure classifier

**Objective:** One shared function decides whether a tool failure is worth remembering and how.
**Dependencies:** None
**Wave:** 1

**Files:**

- Create: `src/memory/tool-failure.ts`
- Test: `src/memory/tool-failure.test.ts`

**Key Decisions / Notes:**

- `classifyToolFailure({toolName, command?, filePath?, error, exitCode?, interrupted?}) → {capture: boolean, skipReason?, signature, title, content, tags, exitCode?}`.
- Parse the exit code from a leading `Exit code N` line (Claude Code) or take it from the caller (OpenCode `metadata.exit`).
- D2 exclusions: interrupts; errors starting with `[Sentinal`; exit 1 from `grep`/`rg`/`diff`/`cmp`/`test`/`[`/`which`/`command -v`/`pgrep`/`git diff --exit-code`; exit 1 with empty output; assertion-only test-runner failures (reuse `TEST_FAIL_INDICATORS`, `capture.ts:103-110`) **unless** the text shows an infrastructure failure (`Cannot find module`, `SyntaxError`, `error TS\d+`, missing native module).
- Signature: `sha1(toolName | first two command tokens or file basename | first meaningful error line with paths, numbers, hex, line:col and timestamps normalized)`, via `node:crypto`.
- Content: command or file path + up to ~1,500 chars of the error; tolerate the `... [N characters truncated] ...` marker. Title short and specific.
- ⛔ **Bundle-safe:** no import that reaches `bun:sqlite` — it is bundled into the OpenCode plugin (Task 14). Verify with a `bun build --target node` of the module.

**Definition of Done:**

- [ ] Each exclusion class has a test; each capture class has a test
- [ ] Two failures differing only in paths/line numbers share a signature; different root errors do not
- [ ] Module bundles without `bun:sqlite`
- [ ] No diagnostics errors

**Verify:** `bun test src/memory/tool-failure.test.ts`

---

### Task 7: Signature de-duplication for error observations

**Objective:** Repeated identical failures produce one observation with a count, not a flood.
**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `src/memory/store-observations.ts`, `src/memory/service.ts`, `src/sidecar/routes.ts`
- Test: `src/memory/service.test.ts` (or the existing service/store test file), `src/sidecar/routes.test.ts`

**Key Decisions / Notes:**

- Store: `findRecentErrorBySignature(projectPath, signature, sinceMs)` — `type='error' AND json_extract(metadata,'$.signature') = ? AND project_path = ? AND timestamp > ?`, newest first, limit 1.
- Service: `addObservationDeduped(obs)` — when `metadata.signature` is present and a match exists inside 30 minutes, record the repeat; otherwise insert with `occurrences: 1`.
- ⛔ *(Corrected after review.)* **Do NOT reuse `updateObservation` to record a repeat.** It replaces metadata wholesale (`store-observations.ts:112`), resets the timestamp and quality score (`:131-133`), and **deletes and re-embeds the vector on every call** (`service.ts:161-172`) — ten identical failures would mean ten embedding runs. Add a dedicated store method, e.g. `recordErrorRepeat(id, lastSeen)`, that only runs `UPDATE observations SET metadata = json_set(metadata, '$.occurrences', COALESCE(json_extract(metadata,'$.occurrences'),1)+1, '$.lastSeen', ?) WHERE id = ?`. Timestamp unchanged, so the 30-minute window is fixed from first sight, not sliding. FTS is unaffected (metadata is not indexed) — confirm against the `observations_au` trigger.
- Route: `handleAddObservation` (`routes.ts:~310-340`) calls the deduped path when `metadata.signature` is present, so the sidecar path, the direct fallback and the OpenCode offline queue all get dedupe. `routes.ts` is 518 lines — keep additions minimal or place logic in the service.

**Definition of Done:**

- [ ] 10 identical signed failures → 1 row, `occurrences: 10` (test)
- [ ] Recording a repeat does not re-embed or delete vectors, and does not change the timestamp (test)
- [ ] A failure outside the window inserts a new row (test)
- [ ] Unsigned observations are unaffected
- [ ] No diagnostics errors

**Verify:** the modified test files

---

### Task 8: OpenCode tool-error event spike

**Objective:** Establish from observation, not upstream source, whether and how OpenCode 1.18.32 surfaces thrown tool failures to plugins.
**Dependencies:** None
**Wave:** 1

**Files:** none shipped. Record findings in the plan.

**Key Decisions / Notes:**

- Use the isolated E2E harness (`.opencode/skills/sentinal-e2e-harness/SKILL.md`) with the real `opencode` binary in a temp HOME — **never** the user's real OpenCode config.
- Load a throwaway plugin that logs every `event` whose `type` is `message.part.updated` with a tool part, plus `tool.execute.after` inputs. Trigger: a failing edit (non-matching old string), a read of a missing file, and a failing bash command.
- Record: whether `message.part.updated` with `state.status === "error"` reaches plugins; the exact `error` strings; how interrupts and permission rejections appear; whether a failing bash also arrives there (double-capture risk with `tool.execute.after`); the `callID` for de-duplication.
- If events do not reach plugins, record that and Task 14 drops the thrown-failure half.

**Definition of Done:**

- [ ] Findings with real captured payloads recorded in the plan
- [ ] Go / no-go for Task 14's event half stated explicitly

---

### Task 9: `sentinal update` warns about a stale sidecar

**Objective:** Finishing an update tells the user when the running sidecar is still the old version.
**Dependencies:** Task 4 (the advised command must be safe)
**Wave:** 2

**Files:**

- Modify: `src/cli/commands/update.ts`, `src/sidecar/lifecycle.ts` *(added during implementation: `looksLikeSidecarArgv`)*
- Create: `src/cli/commands/sidecar-staleness.ts` (helper)
- Test: `src/cli/commands/sidecar-staleness.test.ts`

**Key Decisions / Notes:**

- `warnIfSidecarStale(expectedVersion, {connect})`: `SidecarClient.connect()` (never autostart) → `health()`; if `version` exists and differs, print one line: `Running sidecar is vX (installed vY). It will retire when no sessions are active, or run 'sentinal sidecar restart' to switch now.` Skip silently when no sidecar or no version.
- Call it at the end of the `--reinstall-plugins` branch (`update.ts:523-529`) with `getSentinalVersion()` (the new version there). Change `downloadAndInstall` to return the installed version so the in-process fallback (`:497`) can warn with it.
- Note in a comment: connecting from the new compiled binary also triggers `noteVersionSkew` → `requestRetire`, so the update now starts healing on its own.
- Optionally call from `runInstallAction` (`install.ts:116-124`).
- *(Added during implementation, from Task 4.)* `looksLikeSidecarArgv` (`src/sidecar/lifecycle.ts:205`) only recognises `sidecar start`, so a sidecar started by `restart --foreground` cannot be stopped: `sidecar stop` reports "not running", deletes the pidfile and leaves it running. Make it also accept `sidecar restart`, with a test.

**Definition of Done:**

- [ ] Stale → one warning line; equal → nothing; no sidecar → nothing; no version → nothing (tests with injected connect)
- [ ] Never autostarts a sidecar (test)
- [ ] No diagnostics errors

**Verify:** `bun test src/cli/commands/sidecar-staleness.test.ts`

---

### Task 10: Claude Code hooks read real Bash output

**Objective:** Every Claude Code hook that reads Bash output reads the documented fields.
**Dependencies:** Tasks 6, 7
**Wave:** 2

**Files:**

- Modify: `src/utils/hook-output.ts`, `src/hooks/memory-observer.ts`, `src/hooks/tdd-tracker.ts`, `src/cli/commands/hook.ts`
- Test: `src/hooks/memory-observer.test.ts`, `src/hooks/tdd-tracker.test.ts`, `src/cli/commands/hook.test.ts`

**Key Decisions / Notes:**

- Widen `HookInput`: `tool_response` → `{stdout?, stderr?, interrupted?, output?}`; add `tool_use_id?`, `is_interrupt?`.
- One helper, `bashOutputOf(input)`: `stdout` + `stderr` joined, falling back to `output` for older payloads, **and to `input.error` for a `PostToolUseFailure` payload** (Task 11 routes those to the tracker). Put it in `src/utils/hook-output.ts`. Use it at all three readers (`memory-observer.ts:40`, `tdd-tracker.ts:173`, `hook.ts:44`).
- ✅ *Confirmed by review against real transcripts in `~/.claude/projects`:* Bash results are `{stdout, stderr, interrupted, isImage, noOutputExpected}` — no `output`. And Pre-Mortem 1 is **retired**: `TEST_FAIL_INDICATORS` includes `/\d+\s+fail/i`, which matches bun's ` 1 fail` summary regardless of a leading `Exit code 1` line.
- Replace the made-up `{output}` fixture in `memory-observer.test.ts:165-205` with the documented shape. Keep one legacy-shape test.
- Note: after this, a **successful** test run on Claude Code reaches the tracker's GREEN path for the first time. Verify with a real passing test-output string.

**Definition of Done:**

- [ ] With `{stdout, stderr}`, memory-observer and tdd-tracker receive the output (tests)
- [ ] A passing test run's stdout moves a RED cycle to GREEN (test)
- [ ] Legacy `{output}` still works
- [ ] No diagnostics errors

**Verify:** the three test files

---

### Task 11: Claude Code PostToolUseFailure capture + TDD routing

**Objective:** Failed tool calls on Claude Code become de-duplicated `error` observations, and failing test runs reach the TDD tracker.
**Dependencies:** Task 10
**Wave:** 3

**Files:**

- Create: `src/hooks/tool-failure-observer.ts`, `src/hooks/tool-failure-observer.test.ts`
- Modify: `targets/claude-code/hooks/hooks.json`, `src/cli/commands/hook.ts`, `src/hooks/tdd-tracker.ts`
- Read (for the event-buffer push): the buffer helper used by `src/hooks/memory-observer.ts:52-69` — reuse it; do not modify `memory-observer.ts` (Task 10's file, earlier wave)
- Test: `src/hooks/tdd-tracker.test.ts`

**Key Decisions / Notes:**

- New async hook on `PostToolUseFailure`: build input from the payload → `classifyToolFailure` → if `capture`, send an `error` observation with `metadata: {source: "auto-capture-failure", signature, toolName, exitCode, occurrences}` via the sidecar (deduped by Task 7), falling back to direct `MemoryService`. Project: `resolveProjectIdentity(input.cwd)`. Also push a `success:false` event into the event buffer so error→fix detection works on Claude Code.
- ⛔ Error text goes in `content`/`title` only (redacted). Test that `metadata` and `tags` never contain it.
- Register the TDD tracker on `PostToolUseFailure` for `Bash`; it reads the text via Task 10's `bashOutputOf`, which falls back to `input.error`. (Pre-Mortem 1 retired by review — the indicators match.) `PostToolUse` and `PostToolUseFailure` are mutually exclusive for one call, so there is no double-fire; test both events anyway.
- hooks.json: add `PostToolUseFailure` entries (`async: true`, explicit `timeout`), mirroring existing async entries (`hooks.json:99-110`). Dispatcher entries in `SHARED_HOOKS` (`hook.ts:239-258`).
- `hook.ts` is also modified by Task 10 (Wave 2) — this task is Wave 3, so no same-wave overlap.

**Definition of Done:**

- [ ] A failing command payload produces one `error` observation; a repeat increments `occurrences` (tests)
- [ ] Excluded classes produce nothing (tests)
- [ ] A real failing `bun test` error moves TEST_WRITTEN → RED_CONFIRMED (test)
- [ ] Secrets in the error text are redacted and never in metadata/tags (test)
- [ ] hooks.json validates; no diagnostics errors

**Verify:** the new and modified test files

---

### Task 12: Canonical slot pool + lazy re-key

**Objective:** The slot allocator sees every live worktree of a repo regardless of the key it was stored under, and re-keys them safely.
**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `src/worktree/slots.ts`, `src/worktree/store.ts`
- Test: `src/worktree/slots.test.ts`, `src/worktree/store.test.ts`

**Key Decisions / Notes:**

- ⛔ *(Revised after review — lock hold.)* **No git subprocess inside the transaction.** `BEGIN IMMEDIATE` also runs on the read-only `worktree_detect` path, so spawning git per row while holding the write lock would stall every other writer, hooks included. **Before** the transaction, run `git worktree list --porcelain` once for the target repo (`listGitWorktrees`, now branchless-safe) to get the set R of this repo's checkout roots and worktree paths. Inside the transaction, use only SQL.
- ⛔ **Scope to this repo, not all projects.** The live rows to consider are those whose `project_path` is in R or whose `worktree_path` is in R — never other repos' rows.
- ⛔ *(Revised after review — update order.)* Within the transaction: (1) compute collision groups on `(K, slot)`; (2) UPDATE every **loser** to `slot = NULL` first; (3) then re-key the remaining rows to K. Re-keying before nulling raises the unique index, which `isSlotRace` (`slots.ts:301-310`) misclassifies as a lost race, so `insertWithSlot` retries and throws `SLOT_RACE` ("transient: retry") for a deterministic failure — forever.
- **D4:** the oldest `created_at` keeps the slot. After commit, re-slot each loser through the existing `tryAssignFreeSlot` + `worktree.env` rewrite path used by `ensureSlot`, emitting the existing `warnIfSlotMismatch` wording. Update the "nothing writes slot = NULL" comments (`store.ts:198-204`, `slots.ts:17-23`) to record this transient exception.
- `countActive` must count the same canonical set (called from `create.ts:57`; the call site itself changes in Task 13).
- `resolveBySlug` (`store.ts:261-264`) must compare against the caller's canonical identity, keeping `canonicalPath` on the row side — moved here from Task 15 so canonical reads land no later than canonical writes.
- Do not touch merged/abandoned rows.
- Tests: two live rows under different legacy keys for the same repo → both re-keyed, distinct slots preserved; a colliding pair → oldest keeps the slot, loser re-slotted with the mismatch warning, **no `SLOT_RACE` on either path**; rows of another repo untouched; a new allocation after re-key never reuses a live slot; concurrent allocations never double-allocate; `resolveBySlug` from a linked worktree finds a canonically-keyed row.

**Definition of Done:**

- [ ] Mixed-key live rows are unified under the canonical key in the allocating transaction, with no git spawned inside it (test)
- [ ] Collision rule per D4, with no `SLOT_RACE` (test)
- [ ] Another repo's rows are untouched (test)
- [ ] `resolveBySlug` matches canonically from a linked worktree (test)
- [ ] No slot is ever allocated twice, including concurrently (test)
- [ ] Existing slot/store tests pass
- [ ] No diagnostics errors

**Verify:** `bun test src/worktree/`

---

### Task 13: Un-nesting — create, reconcile, manager, cleanup

**Objective:** Every writer and reader of the slot pool uses the canonical project, in one change, so new worktrees land under the main checkout from any checkout and nothing duplicates.
**Dependencies:** Task 12
**Wave:** 2

*(Restructured after review.)* Originally only `create.ts` changed here and the readers waited until Wave 4, so for two waves `worktree_detect` from a linked worktree would have missed canonical rows and **re-registered duplicates** — breaking "each commit passes standalone". All canonical readers and writers now change together.

**Files:**

- Modify: `src/worktree/create.ts`, `src/worktree/reconcile.ts`, `src/worktree/manager.ts`, `src/worktree/cleanup.ts`
- Test: `src/worktree/create.test.ts`, `src/worktree/reconcile.test.ts`, `src/worktree/manager.test.ts`, `src/worktree/cleanup.test.ts`

**Key Decisions / Notes:**

- `create.ts`: `resolveProjectIdentity(projectPath)` for the pool key (`:57`), the directory (`:74` — documented exception to "identity is for keys only"), the stored `projectPath` (`:109`), the seed root (`:124`) and the `git worktree add` cwd. Fix `baseCommit` (`:67`): `rev-parse <base>`, not the invoking checkout's HEAD.
- `reconcile.ts:73,110`: store identity (the second writer).
- `manager.ts:88` (`list`) and the cleanup default pass (`cleanup.ts:124-134`) scope by identity; `cleanup.ts:271` resolves via Task 12's canonical `resolveBySlug`.
- Cleanup guard 2 (`cleanup.ts:228`): also accept worktrees inside `<any worktree root of this repo>/<config.directory>`, so ones nested by earlier versions can be reclaimed. Confirm the Orca worktree stays refused (guard 1, branch prefix `sentinal/spec-`).
- **D5 tests** (moved here from Wave 4): squash-merge started from a linked worktree runs in the main checkout, refuses a dirty main checkout, restores a clean main checkout that was on another branch, and gives a clear error when `base` is checked out in another linked worktree.
- Use the real linked-worktree fixture (`src/project/identity.test.ts:10-17,34-61`).

**Definition of Done:**

- [ ] Created from a linked worktree → under the main checkout, canonical key (test)
- [ ] `baseCommit` is the base branch's commit (test)
- [ ] Reconcile from a linked worktree finds the existing canonical row — no duplicate (test)
- [ ] Cleanup from a linked worktree finds canonical rows; previously nested worktrees are reclaimable; the Orca-style worktree is refused (tests)
- [ ] D5 behaviours above (tests)
- [ ] No diagnostics errors

**Verify:** `bun test src/worktree/`

---

### Task 14: OpenCode failure capture

**Objective:** Failed tool calls on OpenCode become de-duplicated `error` observations.
**Dependencies:** Tasks 6, 7, 8
**Wave:** 3

**Files:**

- Modify: `targets/opencode/plugins/sentinal.ts`
- Test: `targets/opencode/plugins/sentinal.test.ts`

**Key Decisions / Notes:**

- Bash: in `tool.execute.after`, when `metadata.exit` is a non-zero number, call `classifyToolFailure` alongside the existing `analyzeEvent`; send via `sidecar.addObservation` or `ObservationQueue.enqueue`.
- Thrown failures (**only if Task 8 said go**): handle the `event` hook for the shape Task 8 recorded; exclude `[Sentinal` prefixes and interrupts; de-duplicate by `callID`; widen the local event type. If Task 8 found bash failures also arrive as events, avoid double capture.
- Project: `projectIdentity`. Plugin-graph type-check required (root tsc excludes `targets/`).

**Definition of Done:**

- [ ] A non-zero bash exit produces one `error` observation (test)
- [ ] Thrown-failure half implemented per Task 8, or explicitly dropped with the reason recorded
- [ ] `bun run build:opencode` succeeds; bundle guard passes; plugin-graph tsc clean
- [ ] No diagnostics errors

**Verify:** `bun test targets/opencode/plugins/ src/cli/target-assets.test.ts && bun run build:opencode`

---

### Task 15: Documentation

**Objective:** The documentation matches the shipped behaviour.
**Dependencies:** All other tasks
**Wave:** 4

*(Restructured after review: the code that used to be here moved into Tasks 12 and 13.)*

**Files:**

- Modify: `.sentinal/rules/sentinal-project.md`, `README.md`

**Key Decisions / Notes:**

- Rules file: remove "`worktree_create` still bases off the invoking checkout" from the known limitations; **correct the "110 + 81 rows" line — they were sessions, not observations**; record D4 (re-key collisions) and D5 (squash-merge/abandon/cleanup run in the main checkout, original branch restored); add the Claude Code Bash-output and `PostToolUseFailure` facts; note the plugin-version release fix and its in-release assertion.
- README (`:91`): restart is background by default; mention `--foreground`.
- Docs only — no `targets/` edits, so no parity baseline regeneration.

**Definition of Done:**

- [ ] Every item above is reflected in the two files
- [ ] Full suite green, `tsc` clean

**Verify:** `bun test`
