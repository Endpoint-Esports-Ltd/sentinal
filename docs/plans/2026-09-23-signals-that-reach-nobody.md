# Signals That Reach Nobody Implementation Plan

Created: 2026-09-23
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Bugfix

## Summary

**Goal:** Fix four defects that share one shape — a signal is produced correctly and then reaches nobody, or a safety guard silently disarms itself.

**Architecture:** Four independent workstreams. (A) `handleCompactionAutocontinue` stops conflating identity with workspace. (B) A stale sidecar detects itself and retires **when safe**, reusing the existing session-aware shutdown loop rather than hard-killing. (C) Notifications become visible to the agent, not just the dashboard. (D) `tdd_cycles` gains a project column so a cross-project bulk transition can no longer delete another project's RED state.

**Tech Stack:** TypeScript (strict), Bun, `bun:test`, SQLite (`bun:sqlite`), `Bun.spawn` for git/binary probes.

## Scope

### In Scope

- Split `handleCompactionAutocontinue(sidecar, projectPath)` into `{identity, workspace}`; replace `.startsWith()` with `isInside()`.
- Sidecar self-detects staleness (binary mtime → confirm via `--version`) and retires after the existing grace period, never while sessions are live.
- A `/retire` route so a skew-detecting client can request the same, fire-and-forget.
- Skew surfaced through **three** channels: `logSidecar`, a once-per-version `insertNotification`, and a new SessionStart consumer that shows unread notifications to the agent.
- `tdd_cycles.project_path` (migration V13), populated by all three writers, enforced on `bulkTddTransition`, and used to scope the readers.

### Out of Scope

- `mergeSharedObservations` (`src/memory/restore.ts:152-183`) — same conflation, but fixing it changes `RestoreOptions` (a public API re-exported from `src/index.ts:56`) **and** the `/context` HTTP contract, which is a cross-process wire change needing skew handling. Read-only and currently benign because `project-memory.json` is git-tracked. Already tracked in two places.
- The un-normalized sidecar **read** routes (`/memory/search`, `/memory/timeline`, `/spec/current`, `handleGetTddState`'s `project`). Tracked separately.
- `worktree_create` un-nesting. Still blocked on the slot re-key hazard.
- Consolidating `isInside` (`disk-scan.ts:68`) with its near-duplicate `isUnder` (`ownership.ts:148`). They differ deliberately — `isUnder` is non-strict and its callers realpath separately. Consolidation debt, noted only.

## Context for Implementer

> Assume you have never seen this codebase.

**The unifying defect:** in every case below, the producing side is correct and the consuming side never receives it.

### Workstream A — compaction conflation

`src/opencode/compaction-autocontinue.ts:27` takes one `projectPath` and uses it twice with incompatible meanings:

- `:39` — `cycle.filePath.startsWith(projectPath)` is an **on-disk prefix** → needs the workspace root.
- `:54` — `sidecar.getCurrentSpec(projectPath)` is a **storage key** → needs the canonical identity.

v1.37.1 passed `identity`, so `:39` under-matches in any linked worktree, `tddStates` is empty, `hasRedState` is false, and the RED-state pause at `:44` never fires. The guard fails **open** — and a filter matching nothing is indistinguishable from "nothing is red".

The caller already has both values. `targets/opencode/plugins/sentinal.ts:338-343` destructures `{root, reason, identity: projectIdentity, workspace: projectWorkspace}` from `resolvePluginRoots`, and the `"compaction.autocontinue"` handler at `:1231` sits in the same closure. There is a stale ⚠️ caveat comment at `:1226-1230` to delete.

### Workstream B — the retire machinery

`enableSessionAwareShutdown` (`src/sidecar/server.ts:143-248`) already shuts down 60s after the last session ends. The interval body has an **early `return` at `:220`** when sessions are active with fresh HTTP activity.

⛔ **The retire check MUST be placed *after* that early return** — anywhere before it bypasses the active-session guard entirely. Do not call `doShutdown` from a route handler, and do not flip `sessionsEverSeen` (that permanently disables the idle fallback because `noSessionSince` is never initialised).

The flag must be settable from outside the closure. Use a field on `SidecarContext` (`server.ts:72-83`) — the route handler already receives `ctx`, and this matches how `ctx.vectorState` is written by a background task and read at `routes.ts:451`. The alternative (changing the return type of `enableSessionAwareShutdown`) breaks two call sites.

`if (interval.unref) interval.unref()` at `:245` — the timer does **not** hold the event loop open; `Bun.serve` does. So a retire path that stops the servers and *then* waits for the timer will never fire.

### Workstream C — notifications reach nobody

`insertNotification` (`src/memory/store-sessions.ts:181-204`) works fine. But grepping for `getNotifications|getUnreadNotificationCount` outside `src/dashboard/` and tests returns **zero production hits**. The only consumers are `src/dashboard/routes/api.ts:111-116` and `views/dashboard.ts:115-118`.

⚠️ `notifications.spec_id` is a **real FK to `specs(id)`** (`migrations.ts:261-277`). Passing a non-existent spec id throws `FOREIGN KEY constraint failed`. Leave it null.

### Workstream D — `tdd_cycles` has no project column

`migrations.ts:285-299` (V7): `file_path TEXT NOT NULL UNIQUE` — **globally unique across every project**, with no project qualifier. Consequently `bulkTddTransition` (`src/sidecar/tdd-routes.ts:33-52`) runs `UPDATE ... WHERE state='TEST_WRITTEN'` and `DELETE ... WHERE state='RED_CONFIRMED'` across every project on the machine, and the OpenCode plugin always calls it **without** a specId (`sentinal.ts:306,316`).

Three writers, none of which normalize the path today:

| Writer | Path source |
| --- | --- |
| `targets/opencode/plugins/sentinal.ts:292-296` | raw OpenCode tool arg |
| `src/hooks/tdd-tracker.ts:71-77` | raw `tool_input.file_path` |
| `src/sidecar/routes.ts:267-276` | `body.filePath` passthrough |

**Patterns to follow:**

- Once-per-version notification guard: `notifyVectorUnavailableOnce` (`src/sidecar/vector-stats.ts:56-71`) — check settings key → set key → notify. Tested at `routes.test.ts:83-103` by calling 3× and asserting exactly 1.
- Version-scoped backoff written at attempt **START** so a crash cannot retry-loop: `self-heal.ts:51,112-119`.
- Injectable seams for untestable gates: `SelfHealOptions` (`self-heal.ts:61-68`) — `spawner`, `forceCompiled`.
- Shutdown-loop tests with injected timers: `SessionAwareShutdownOptions` (`server.ts:123-142`) and the 14 tests at `server.test.ts:658-1133`. Convention is sub-100ms values plus `await setTimeout(150)`.
- New route modules are split per domain (`spec-routes.ts:10-11` says why). `routes.ts` is already **501** lines.

**Gotchas (verified — do not re-derive):**

- `isInside(x, x) === false` — it is **strict** (`disk-scan.test.ts:119`). Fine here because `filePath` is always a file, but assert it rather than assume.
- `resolveRealPath` falls back to `resolve()`, which resolves a **relative** path against the *sidecar's* cwd. Relative `tdd_cycles` rows (they exist — `tdd-guard.test.ts:347`) will be silently excluded. That is the fail-open direction and matches today's behaviour; pin it with an explicit test.
- Importing `isInside` into `compaction-autocontinue.ts` is **bundle-safe and adds zero modules**: `src/project/identity.ts:34` already imports `disk-scan.js`, and `resolveRealPath` is already in the built bundle at `targets/opencode/dist/sentinal.mjs:15705`. `zod` is bundled, not external (`package.json:36` externalizes only `bun:sqlite`, `@xenova/transformers`, `sqlite-vec`).
- `getBinaryVersion()` (`dashboard-ensure.ts:66-85`) caches **permanently** in a module-level `_cachedBinaryVersion` (`:65`). A long-lived sidecar would cache at boot and never see the upgrade. There is a `resetBinaryVersionCache()` test hook at `:88-90`.
- Use `getSentinalBinPath()` (`dashboard-ensure.ts:28-30`), which honours `SENTINAL_HOME`. Do **not** use `BIN_PATH` from `update.ts:40-41` — it hardcodes `homedir()` and would make tests touch the real install.
- `getSentinalVersion()` returns three different things depending on context: the build-define when compiled, the repo `package.json` version in a source run (`version.ts:25-34`), while `self-heal.ts:40-45` and `vector-stats.ts:22-27` both return `"dev"` for the same question. Skew reported from a source-run MCP server is expected noise.
- `noteVersionSkew` is called on the `probe` client (`client.ts:145,171`), which has `reconnectEnabled = false`. Good — a retiring sidecar dropping the connection must not cause a respawn storm. It runs on the hot path of every hook, so any POST must be **fire-and-forget** with `.catch(() => {})`, never awaited.
- Tests must pass `enableVectorSearch: false` to `startSidecar` (`server.ts:92-97`) to avoid loading the `@xenova` model.
- `quality_report` runs prettier **project-wide with auto-fix** — always pass a `file` scope. ESLint cannot run at all (no `eslint.config.*`); use `check_diagnostics` as the type gate.

## Assumptions

- The retire flag on `SidecarContext` is readable by the interval closure because `enableSessionAwareShutdown` receives `result.ctx` (`server.ts:199`). Tasks 5 depends on this; verify before building.
- Clearing pre-migration `tdd_cycles` rows is safe — see Decision D1 below. Task 2 depends on this.
- `cycle.filePath` is absolute in practice for both targets, so an `isInside` workspace test is meaningful. Supported by the three writers all receiving absolute tool args. Tasks 1, 7 depend on this; the relative case is handled as fail-open.
- A SessionStart notification consumer will not spam, because the skew notification is once-per-version settings-guarded and notifications are marked read on display. Task 11 depends on this.

## Key Decisions

**D1 — Pre-migration `tdd_cycles` rows are DELETED by migration V13, not backfilled with NULL.** *(rationale corrected after review)*

Backfill is impossible — there is no project signal on the row beyond the path, and paths may be relative.

⚠️ The original rationale claimed such rows would be "permanently stranded — nothing could ever transition or delete them". **That is false and has been corrected.** Only `bulkTddTransition` gains the project filter; `setTddState` upserts on the `file_path` UNIQUE key (V7, `migrations.ts:285-299`) and would repopulate `project_path` on the next write, and per-file clears carry no project clause.

The conclusion nevertheless stands, on the surviving half of the argument, which review **verified**: `RED_CONFIRMED` is the TDD guard's **bypass** state, not a blocking one (`src/hooks/tdd-guard.test.ts:345` — *"returns null when state is RED_CONFIRMED (allowed)"*; `src/tdd/mcp-tools.ts:107` — *"Use state RED_CONFIRMED to bypass the TDD guard"*). So a NULL-project RED row that is never re-written leaves that file **permanently exempt from TDD enforcement**. Deleting is the fail-closed direction, and is low-cost because `tdd_cycles` is transient in-flight session state, not durable history.

**D2 — Retire reuses the existing grace period rather than introducing a shorter one.** A stale sidecar is a correctness annoyance, not a hazard. Fewer knobs, and the existing 14 shutdown tests stay meaningful.

**D3 — The client requests retire; it never waits for it.** `noteVersionSkew` fires from short-lived hook processes that exit milliseconds later. The sidecar owns the "when safe" decision entirely; the request must be idempotent.

**D4 — Retire is STOP-ONLY. It does not respawn.** *(added after review)*

`doShutdown` (`server.ts:169-195`) ends in `stopSidecar(...)` + `process.exit(0)`; nothing restarts the process. The user's wording was "restart itself", so this gap must be stated rather than implied.

⚠️ **The autostart that makes stop-only safe is NOT uniform.** `SidecarClient.connect()` returns `null` when no sidecar is live and hooks must degrade silently (`.sentinal/rules/sentinal-sidecar.md`). Only `connectWithRetry()` (`src/mcp/server.ts:134`) calls `autoStartSidecar()`, and `SidecarClient.reconnect()` calls `autoStartFn()` for an already-cached client. So:

- Long-lived consumers (MCP server, OpenCode plugin) **will** respawn the new binary.
- A **hook-only** workload calling a fresh `connect()` gets `null` and runs degraded until some long-lived consumer starts.

Task 5 must **measure** this rather than assume it, and record the answer. If the measurement shows hook-only workloads stay degraded for an unacceptable window, escalate — do not silently accept it.

**D5 — Workstream B is INERT for the upgrade that installs it.** *(added after review)*

The sidecar that needs to retire is by definition running pre-change code: it has neither the `detectBinaryStaleness` interval nor the `/retire` route, so the client's request hits `handleSidecarRequest` — the only handler that returns 404 — and the self-check cannot run. **Workstream B produces value only from upgrade N+1 onward.** This is unavoidable, not a defect, but it means B does nothing for the failure that motivated it. Goal Verification truth 7 is therefore written against a *simulated* mtime change, not a real upgrade.

**D6 — Reads fail OPEN, writes fail CLOSED, and this asymmetry is deliberate.** *(added after review)*

Task 6 keeps `listActiveTddStates` returning everything when given no project (back-compat), while Task 7 makes the project **required** on `bulkTddTransition` and rejects a request without one. Those look contradictory. They are not: an unscoped *read* over-reports, which is visible and harmless; an unscoped *destructive write* silently deletes another project's state, which is the bug being fixed. An implementer must not "harmonise" these.

## Testing Strategy

- **Unit:** every new module gets a `*.test.ts` sibling.
- **The RED test for Workstream A requires a real two-worktree git fixture.** The pattern already exists at `targets/opencode/plugins/sentinal.test.ts:524-554` (`git init` + `git worktree add`, `realpathSync` on the tmpdir for macOS skew, asserting `roots.identity !== roots.workspace`). Reuse it. Synthetic string literals **cannot** catch this bug — see Risks.
- **Mutation-test the discriminating assertions.** Flip `workspace`↔`identity` and confirm the test fails. This caught real test-hygiene bugs twice in the previous plan.
- Bun's default timeout is 5s. Any test spawning git or `sentinal --version` (3s `spawnSync`) needs an explicit 3rd-arg timeout.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Retire check placed before the `:220` early return, killing the sidecar mid-session | Medium | **High** | Called out as ⛔ in Task 5 with a dedicated DoD test mirroring `server.test.ts:705-733` ("stays alive when active sessions exist") |
| **`/retire` POSTs call `touchActivity()`, resetting the idle timer they depend on** — the harder a client asks for retirement, the longer it is deferred | **High** | **High** | Task 5 places the retire branch before `if (sessionsEverSeen)` with its own grace accounting, never in the idle-fallback branch; DoD asserts retirement occurs *while requests are still arriving* |
| Task 7's required-project 400 is swallowed by two layers of `catch {}` in the plugin, so a plumbing miss breaks TDD tracking **silently** | **High** | **High** | Task 7 must `logSidecar` the rejection; Task 12 must replace the swallowing catch with a plugin-debug-log write and prove the round trip returns a `count` |
| A SessionStart consumer surfaces and silently marks-read **other projects'** notifications | High | Medium | `notifications.project_path` added in the same V13 migration; Task 11 forbidden from using the argument-less `markAllNotificationsRead()` |
| `src/cli/embedded-assets.ts` not regenerated, so the installer ships pre-change plugin code while every test passes | Medium | High | Task 12 runs `bun run embed-assets` and Goal Verification truth 9 asserts the regenerated content |
| V13 deletes rows a user cared about | Low | Medium | D1 rationale; migration logs the count; `tdd_cycles` is transient by design |
| `bulkTddTransition` gaining a required project param strands callers that pass none | Medium | High | Task 7 must update all callers in the same task; the OpenCode plugin's two call sites (`sentinal.ts:306,316`) are in Task 12 |
| Existing compaction tests keep passing because the mock discards the argument | **High** | High | `makeMockSidecar` names it `_projectPath` (`compaction-autocontinue.test.ts:12-16`). Task 1 must first make the mock **capture** both arguments, or the RED will be unobservable |
| SessionStart consumer adds latency to every session | Medium | Medium | One indexed `getNotifications({unread:true, limit})` read; Task 11 measures it |

## Pre-Mortem

_Assume this plan failed after full execution:_

1. **We fixed the compaction signature but the guard still never fires, because `cycle.filePath` rows are not actually absolute in the real OpenCode path.** (Tasks 1, 12) → Trigger: the new two-worktree test passes with synthesized absolute rows, but a live smoke shows `tddStates` still empty. Check what `sidecarTddTrack` actually wrote before assuming.
2. **The retire flag works in tests but never fires in production, because the sidecar is a compiled binary and the self-check gate keys on `__SENTINAL_VERSION__` being defined — inverted from `self-heal.ts`'s intent.** (Tasks 3, 5) → Trigger: `sentinal sidecar logs` shows no retire line after an upgrade that demonstrably changed the binary mtime.
3. **V13 clears `tdd_cycles` and a subsequent bug re-strands rows with NULL project_path, because one of the three writers was missed.** (Tasks 2, 6, 9, 12) → Trigger: `SELECT COUNT(*) FROM tdd_cycles WHERE project_path IS NULL` is non-zero after any new TDD activity.

## Execution Waves

**Wave 1** — leaf modules (parallel): Tasks 1–4 are independent and touch four disjoint files, two of them new.

**Wave 2** — sidecar + store wiring (parallel): Tasks 5 and 6 consume Wave 1 and own `src/sidecar/server.ts` and the `src/memory/store*.ts` pair respectively.

**Wave 3** — TDD consumers (parallel): Tasks 7, 9, 10. ⛔ **Task 7 owns `src/sidecar/client-routes.ts` in this wave.**

**Wave 4** — client + target wiring (parallel): Tasks 8, 11, 12.

⛔ **Wave rebalanced after review.** Task 8 was moved from Wave 3 to Wave 4 because Task 7 must also edit `src/sidecar/client-routes.ts` (to thread the project through `tddTransition` at `:129-133`) — a same-wave overlap the original `plan_impact` run could not detect, because Task 7's `Files:` list omitted the file. **This is the failure mode `plan_impact` cannot protect against: it checks the plan text, so a wrong `Files:` list produces a confident false negative.**

⛔ Task 12 is the **sole owner** of `targets/opencode/plugins/sentinal.ts` and `sentinal-helpers.ts`, making four edits there; splitting it would create a same-wave overlap in the files most likely to conflict.

**`plan_impact` (2026-09-23, pre-review):** 12 tasks, 32 files, reported **no same-wave overlaps**. Reach verdict **HIGH**, materially higher than the preceding plan: `src/memory/types.ts` **241/408 modules (59%)**, `src/memory/migrations.ts` and `src/memory/store.ts` **197 (48%)** each, then the sidecar cluster (`server.ts`, `tdd-routes.ts`, `client.ts`, `client-routes.ts`, `routes.ts`) at 98 (24%). That concentration is Workstreams C and D — a schema change is inherently broad. **Tasks 2 and 6 must run the full suite, not just their own test files**, and are the two to review hardest.

⚠️ **That "no overlaps" result was a false negative** — see the Wave 3/4 note above.

**`plan_impact` re-run (2026-09-23, post-review):** 12 tasks, **36** files (the four newly-named: `client-routes.ts`, `store-sessions.ts`, `sentinal-helpers.ts`, `embedded-assets.ts`), **no same-wave overlaps** across all 4 waves — now a trustworthy result rather than an artefact of an incomplete list. Reach still HIGH, with `src/memory/store-sessions.ts` newly surfacing at **199/408 (49%)** because Workstream C's notification columns land there. Tasks 2 and 6 remain the two to review hardest and must run the full suite.

## Goal Verification

### Truths

1. `src/opencode/compaction-autocontinue.ts` exports a function taking two distinct roots (grep: `identity` and `workspace` in the signature).
2. No production file matches a project root with a raw prefix test — grep `startsWith(projectPath)` across `src/` and `targets/` **excluding `*.test.ts` AND `src/cli/embedded-assets.ts`**, which is a generated bundle copy and will contain the old text until regenerated.
3. `tdd_cycles` and `notifications` both have a `project_path` column (`PRAGMA table_info`).
4. `bulkTddTransition`'s SQL contains `project_path = ?` (grep in `src/sidecar/tdd-routes.ts`).
5. `SCHEMA_VERSION` is 13 (`src/memory/types.ts`).
6. A `/retire` route exists and is reachable (`curl --unix-socket ... http://localhost/retire` returns `ok`).
7. `sentinal sidecar logs` contains a retire line after a **simulated** binary-mtime change. ⚠️ Per D5 this cannot be verified against a real upgrade — the currently-running sidecar predates the feature.
8. A SessionStart hook reads notifications — grep `getNotifications` outside `src/dashboard/`, **excluding `src/cli/embedded-assets.ts`**.
9. `src/cli/embedded-assets.ts` has been regenerated and contains the new code. ⚠️ *Corrected during verification:* grep for **runtime identifiers** (`listSessionNotifications`, `notifications/session`, the new `cli-tools.md` prose), never for a TypeScript type such as `CompactionRoots` — types are erased from the JS bundle, so that grep can never match and would report a false failure. Re-run `embed-assets` after **any** `targets/` edit, rules included: verification found the copy stale because `cli-tools.md` was edited after the last regeneration.
10. `bulkTddTransition` rejects a request with no project, and that rejection is logged (grep `logSidecar` in the 400 path).

### Artifacts

| Artifact | Provides | Exports |
| --- | --- | --- |
| `src/opencode/compaction-autocontinue.ts` | Identity/workspace-correct autocontinue | `handleCompactionAutocontinue` |
| `src/sidecar/retire-check.ts` | Binary-staleness detection | `detectBinaryStaleness` |
| `src/sidecar/retire-notify.ts` | Once-per-version skew signal | `notifySkewOnce` |
| `src/sidecar/retire-routes.ts` | `/retire` endpoint | `handleRetireRequest` |
| `src/memory/migrations.ts` | V13 project-scoped TDD cycles | `runMigrations` |

### Key Links

| From | To | Via | Pattern |
| --- | --- | --- | --- |
| `targets/opencode/plugins/sentinal.ts` | `compaction-autocontinue.ts` | both roots passed | `projectWorkspace` |
| `src/sidecar/server.ts` | `retire-check.ts` | staleness poll | `detectBinaryStaleness` |
| `src/sidecar/client.ts` | `/retire` | skew-triggered request | `requestRetire` |
| `src/sidecar/tdd-routes.ts` | `tdd_cycles` | project-scoped bulk op | `project_path = ?` |
| `src/hooks/session-start.ts` | `store.getNotifications` | agent-visible signal | `getNotifications` |

## Progress Tracking

- [x] Task 1: Split compaction signature + isInside (Wave 1)
- [x] Task 2: Migration V13 — `tdd_cycles.project_path` (Wave 1)
- [x] Task 3: `retire-check.ts` — binary staleness detection (Wave 1)
- [x] Task 4: `retire-notify.ts` — once-per-version skew signal (Wave 1)
- [x] Task 5: Sidecar retire wiring + `/retire` route (Wave 2)
- [x] Task 6: Store writes `tdd_cycles.project_path` (Wave 2)
- [x] Task 7: `bulkTddTransition` project scoping + client route (Wave 3)
- [x] Task 9: TDD write paths populate project (Wave 3)
- [x] Task 10: TDD readers project-scoped + shipped prose (Wave 3)
- [x] Task 8: Client `/retire` request on skew (Wave 4)
- [x] Task 11: SessionStart notification consumer (Wave 4)
- [x] Task 12: OpenCode plugin wiring — 4 edits (Wave 4)

**Total Tasks:** 12 | **Completed:** 12 | **Remaining:** 0

### Implementation notes (discovered, not planned)

**Wave 1 — 3297 → 3339 pass / 0 fail; `tsc --noEmit` clean.**

- ⛔ **`check_diagnostics` and the root `tsc` cannot see `targets/`** — the root `tsconfig.json` includes only `src/**/*.ts`. Task 1's signature change produces exactly one type error, at `targets/opencode/plugins/sentinal.ts:1235` (`string` not assignable to `CompactionRoots`), which neither gate reports. It was found only via a temporary tsconfig. **Task 12 cannot rely on the project's diagnostics gate to catch a mistake at that call site** — it must type-check the plugin graph explicitly. `bun run build:opencode` does not type-check either.
- Task 1's RED was weaker than planned: old code handed the new object compares against `"[object Object]"` and fails open, so the RED came from the signature change. The actual bug is proven instead by **mutation** — swapping workspace↔identity fails 3 tests; restoring raw `startsWith` fails 2 (the `/project-evil` sibling and strictness).
- **Task 2 found a pre-existing migration-ladder flaw:** "don't bump the version when the guard skips" does *not* guarantee a retry, because the ladder reads `MAX(version)`. If V12's guard skips but V13 succeeds, the stored version becomes 13 and V12 never re-runs. Low risk — the tables those guards check are created by V5–V7 earlier in the same run — but the documented retry property is weaker than stated. Deferred.
- V13 keys its delete on `project_path IS NULL`, so a re-run cannot remove rows written after V13. The delete count logs to **stderr** via `console.error`, deliberately: `runMigrations` runs inside `MemoryStore`, which hooks open, and hooks write JSON to stdout.
- `src/memory/migrations-v12.test.ts` (outside Task 2's list) had 3 tests assuming 12 was the latest version; updated to assert V12's work, not that it is the maximum.
- `src/memory/migrations.ts` is now **528 lines** (warn 400, block 600).
- Task 3: stale is a **one-way latch** — once confirmed, `check()` does no further stat or spawn, so the retire decision cannot flap even on a rollback. A spawn failure keeps the old mtime so the next tick retries once the install finishes. The compiled-gate polarity (Pre-Mortem 2) is proven with a real `bun build --define __SENTINAL_VERSION__` test, because `forceCompiled` alone cannot prove the production direction.
- `dashboard-ensure.ts` is not strictly `node:*`-only — it reaches `zod` via `db-path.ts` → `types.ts`. Irrelevant inside the sidecar.
- Task 4's settings key is scoped by **installed** version only, and the function takes both versions as parameters rather than reading one — Task 5 chooses the source (use Task 3's `StalenessResult`, not the permanently-cached `getBinaryVersion()`).

**Wave 2 — 3339 → 3373 pass / 0 fail; `tsc --noEmit` clean.**

- **Task 5 retire placement (final line numbers):** staleness tick `server.ts:224` (only ever *sets* the flag) → active-and-fresh early return `:247` → **retire branch `:257-266`**, reusing `noSessionSince` and never reading `lastActivityTime` → `if (sessionsEverSeen)` `:267`. `/retire` registered at `:420`, before the other handlers; `handleSidecarRequest` stays last.
- **Placement mutation-proven three ways:** top of interval body fails the two "does NOT retire while sessions are active" tests; inside `if (sessionsEverSeen)` fails never-seen, stale-binary, D4 and "repeated POSTs do not defer"; gated on the idle timer fails "repeated POSTs do not defer".
- ✅ **D4 MEASURED** (the plan required this be recorded, not assumed). After a retire, a fresh `SidecarClient.connect()` returns **`null`** and `autoStartFn` is called **0 times** — `connect()` is only `tryConnect()` (`client.ts:111-113`). However, the degraded window is small in practice:
  - A retire can only fire when no session is both active and fresh.
  - **A new session respawns the sidecar via SessionStart**, which calls `autoStartSidecar()` at `src/cli/commands/hook.ts:63` — **the plan missed this path**. A SessionStart arriving during the grace period makes a session active, resetting the retire clock.
  - The genuine gap is a **stale** session (row open, no HTTP activity for 1h): its later hooks get `null` and fall back to direct `MemoryStore` via `withSidecarOrDirect` (`client.ts:368`) — slower, but functional — until the next SessionStart or until the MCP server's cached client `reconnect()`s. **The existing session-aware shutdown already has this identical gap**; retire adds no new one. Not escalated.
- ⚠️ **D4 wording was wrong:** `connectWithRetry()` does not itself call `autoStartSidecar()` — the caller does (`src/mcp/server.ts:131`). The OpenCode plugin (`sentinal.ts:389`) calls `connectWithRetry` with no explicit autostart and respawns only via `reconnect()`.
- `server.ts` is now **520 lines** (was already 478, over the 400 warn).
- **Task 6 ON CONFLICT:** `project_path = COALESCE(excluded.project_path, project_path)` — a write supplying a project overwrites (and so backfills a NULL row); a write omitting one keeps the stored value, so a project-less writer cannot un-scope a row. Both directions tested.
- **The bulk-transition SQL is raw** in `src/sidecar/tdd-routes.ts:33-52` via `store.getRawDb()`, not a store method — so Task 7 adds the `AND project_path = ?` there.
- ⚠️ **`tdd_cycles.spec_id` is ALSO a real FK to `specs(id)`** — the plan warned only about `notifications`. Tests using a spec id must insert a `specs` row first. Relevant to Tasks 7 and 9.
- Notification store tests live in `src/memory/notifications.test.ts`, not `store.test.ts`. `getUnreadNotificationCount()` stays global (pinned by test); Task 11 needs no scoped variant — it uses `getNotifications({unread:true, projectPath, limit})` plus per-id `markNotificationRead`.
- One tsc-spawning test timed out at the 5s default under full-suite load during Task 6's run; it passed 2/2 in isolation and did not recur on the combined run. Pre-existing timing sensitivity, unrelated.

**Wave 3 — `tsc --noEmit` clean.**

- **Task 7 wire contract (for Task 12):** `POST /tdd-state/transition` body `{ action: "confirm_red" | "confirm_green", projectPath: string, specId?: string }`. `projectPath` required, normalized sidecar-side with `resolveProjectIdentity` (blank rejected *before* resolving). Client call: `sidecar.tddTransition(action, specId, projectPath)`, `specId` positional and may be `undefined`. Returns `{ count }`. Missing project → 400 plus exactly one `logSidecar` line: *"tdd-transition REJECTED: missing projectPath (action=…, specId=…) — refusing an unscoped sweep across every project"*. `bulkTddTransition`'s third param became a scope object (sole caller is the route). Mutation: removing the project clause fails 7 tests; removing the log fails 8.
- ⚠️ **`sentinal-helpers.test.ts:33-56` did NOT fail**, contrary to the plan's expectation — `sentinal-helpers.ts:248-253` declares its own local `TddTransitionSidecar` interface with the old two-arg signature, and the test mocks it. Neither tests nor `tsc` (which excludes `targets/`) will prompt the change. **Task 12 must update that interface on its own initiative.**
- ⚠️ **The plugin's bulk transitions are broken in production between Task 7 and Task 12** — they send no project, get a 400, and it is swallowed. The sidecar log line is the only signal. Expected; closed by Task 12.
- ⛔ **Gap found by Task 9 — NULL-project rows are still writable.** POST `/tdd-state` accepts an absent project (single-row upsert, not a bulk destructive write — defensible under D6, and requiring it would silently break the plugin and `tdd_set_state`, which send none). But combined with Task 7 this has a sharp consequence: **a NULL-project RED row is never cleared by `confirm_green`, so it stays in the guard's bypass state.** Each such write is logged. Closure requires every writer to send a project:
  - `client-routes.ts` `setTddState`'s options type has no `projectPath` (it already spreads `...opts`, so the fix is type-only) → **added to Task 8**, which owns that file in Wave 4.
  - The `tdd_set_state` MCP tool (`src/tdd/mcp-tools.ts:147-149`) sends none → **added to Task 8** (no Wave 4 task owns that file).
  - The plugin (`sentinal.ts:292`) sends none → already Task 12 edit 2.
  - Once all three send it, the route can be made to require it — **deferred**, recorded in Deferred Issues.
- **Task 9 found a hidden cross-project write path the plan never listed:** the Claude Code tracker's RED and GREEN steps read `listActiveTddStates` **unscoped**. On RED, supplying a project would have *re-keyed other projects' rows* (COALESCE overwrites); on GREEN it **deleted other projects' RED rows** — the same class Task 7 fixes. Both reads are now project-scoped. The tracker writes the store directly, not via the client.
- `file_path` is deliberately **not** canonicalized — it stays the raw worktree path, which is what Task 1's `isInside(workspace)` expects. Only the project is canonical.
- Pre-existing test quirk: `PASS_OUTPUT` in `tdd-tracker.test.ts` contains `"0 fail"`, which matches `/\d+\s+fail/`, so the real tracker classifies it as a *failure*. Older tests never called the real function. Left as-is.
- **Task 10:** the store path filters in SQL; the **client path — the one production takes, since `store` is `null` whenever the sidecar runs** — fetches then filters client-side via `scopeCyclesToProject`, because `/tdd-state/list` takes no project. Rows with `projectPath: null` are dropped; rows with **no `projectPath` key at all** (only a pre-V13 sidecar sends those) are **kept** — fail-open per D6, rather than a silently empty answer. The native tool resolves identity from the `context.directory` it already receives, so no plugin change was needed. Mutation-tested five ways; one initially survived because the test directory was already canonical, fixed by adding a subdirectory-of-a-real-repo case.
- **Shipped prose found, NOT edited** (touches cross-target parity baselines): `targets/claude-code/rules/cli-tools.md:19` and `targets/opencode/rules/cli-tools.md:19` say *"Get TDD cycle state for file or list all"* — now inaccurate. Handled after Wave 4 as a single sequential edit to both targets plus a parity baseline regeneration.
- `src/sidecar/routes.ts` is now **518 lines**.

**Wave 4 — 3481 pass / 0 fail across 395 files (baseline 3297 → +184 tests); `tsc --noEmit` clean; plugin graph type-checks clean.**

- **Task 8:** `requestRetire()` is fire-and-forget on the non-reconnecting probe (`/retire` has a 1s budget). Version fields: `runningVersion` = sidecar's `/health` version (stale), `installedVersion` = client's own. **Two gates the plan did not specify, both added and tested:**
  - **Compiled-client only.** A source/dev run reports the repo's `package.json` version, so without this a dev checkout would retire the user's production sidecar.
  - ⛔ **Client must be NEWER than the sidecar** (`isNewerVersion`). Without it, an *older* client (e.g. a stale OpenCode plugin bundle) retires a *newer* sidecar, which respawns from the same installed binary, still skews, and **loops**. Rollbacks are left to the sidecar's own binary-staleness check. Side effect: pre-release versions never trigger a retire (`parseSemver` rejects them).
  - Mutation: awaiting the call failed the hang test (connect took 1006ms vs <400ms); removing either gate failed its tests. `client.ts` ended at **398** lines — it was 374, not ~582 as the plan assumed.
  - `tdd_set_state` had no `project` param; one was added and both paths now send a canonical project. `setTddState`'s client type gained `projectPath?`.
- **Task 11 read path:** direct store (`new MemoryStore()`, no sqlite-vec, ~0.3ms) rather than the sidecar, because the sidecar had no notification read route. Measured latency **~22ms median / 28ms p95**, of which ~19ms is `resolveProjectIdentity` spawning git.
  - ⛔ **Global-notification resolution:** skew notifications carry NULL project (a stale sidecar affects every project), so a project filter that excludes NULL rows would **never show the skew warning — the main motivation for this task**. Resolved with an explicit allow-list, `GLOBAL_NOTIFICATION_SOURCES = ["sidecar-retire"]`, and a new store method `getUnreadGlobalNotifications(sources, limit)`. Other NULL-project rows (history, `session-end`, `self-heal`, vector-unavailable) are neither shown nor marked read.
  - ⚠️ **The plan's cited SessionStart path was wrong.** The live path is the dispatcher `src/cli/commands/hook.ts runSessionStart`; `session-start.ts main()` runs only standalone. Without the `hook.ts` change nothing would have reached users. The dispatcher also never emitted the session-conflict hint the plan cited as the shape to follow.
  - A hook can now run the V13 migration: opening the store runs pending migrations, and the first SessionStart on the new binary may be what does it (the backup runs first). Pre-existing behaviour of the dispatcher's fallback and pre-edit-guide.
- ⛔ **Task 12 edit 4 could not be done as specified, and the specified design would have reproduced this plan's own defect.** The plugin cannot open the store (no `bun:sqlite` in its bundle) and the sidecar had no notification read route. Worse, the plan said to surface notifications in `session.created` — but the plugin's own comment (`sentinal.ts:971-975`) records that `client.app.log()` writes to the **TUI log panel, not the LLM context**. Logging the digest there would be a signal that reaches nobody. Delivered instead:
  - New `src/sidecar/notification-routes.ts`: `GET /notifications/session?project=&limit=` (side-effect free; blank project → 400, never the sidecar's cwd) and `POST /notifications/read {id}` (one id; **deliberately no mark-all route**). Registered in `fetchHandler`.
  - `SidecarRoutes.listSessionNotifications` / `markNotificationRead`.
  - A shared `listSessionNotificationCandidates` in `src/hooks/session-notifications.ts`, used by **both** the Claude Code hook and the new route, so the targets cannot drift on eligibility — asserted by a spy test.
  - The plugin surfaces lazily in **`experimental.chat.system.transform`** — the channel that actually reaches the model (it is what injects the `[Sentinal] Active plan:` line). Surfaced and marked read **once per session**, claimed before the await so concurrent turns cannot double-mark, then **re-injected every turn** because the system prompt is rebuilt each turn. An old sidecar that 404s yields nothing, silently.
  - Mutation: keying by workspace instead of identity fails 2 tests; re-surfacing every turn fails 1; widening the shared query to all projects fails 3.
- **Task 12 edits 1–3:** `transitionTddState` now returns `{count} | null` (the integration DoD needs a count to assert). Helper argument order is `(sidecar, action, projectPath, specId?)`; the wire call stays `(action, specId, projectPath)`. Seven mutants, all caught.
- ⛔ **The plugin graph is invisible to the project's type gates.** Root `tsconfig.json` includes only `src/**`, so neither `bunx tsc --noEmit` nor `check_diagnostics` sees `targets/`. Verified with an out-of-repo tsconfig (needs `typeRoots` pointed back at the repo's `node_modules` and `allowImportingTsExtensions` for a pre-existing `./sentinal.ts` import at `sentinal.test.ts:8`). Proven to actually check by injecting a type error at `:904` and seeing it reported. **Result: 0 errors.**
- ⚠️ **Review finding 11 was partly wrong.** `src/cli/embedded-assets.ts` is **gitignored** and regenerated by `scripts/release-build.mjs:40` (and `build:cli` runs `embed-assets` first), so a release cannot ship stale plugin code. Regenerating it locally matters only for local runs and this plan's grep-based checks. It now contains the new code and `SCHEMA_VERSION: 13`.
- **Shipped prose:** `targets/{claude-code,opencode}/rules/cli-tools.md` updated identically (`tdd_status` → "list all in the current project"). The pair was byte-identical but **unguarded**, so `cli-tools.md` was added to `IDENTICAL_RULES`; proven by appending drift to one copy and seeing the test fail. Every parity fixture is byte-identical before and after regeneration; `spec-verify.diff` still 0 bytes.
- The Claude Code hook refactor onto the shared query hit a TDD-guard limitation: it permits edits only in `RED_CONFIRMED`, with no refactor state, so a behaviour-preserving refactor is blocked. Resolved honestly by writing a real failing test for the actual requirement (both targets must use one query) rather than bypassing the guard.
- `src/sidecar/client-routes.ts` is **407** lines (just over the 400 warn); `server.ts` **523**.

## Verification (2026-09-23)

| Gate | Result |
| --- | --- |
| Full suite | **3481 pass / 0 fail**, 395 files (baseline 3297 / 0; +184 tests) |
| `bunx tsc --noEmit` (src) | exit 0 |
| Plugin graph type-check (out-of-repo tsconfig; root tsc excludes `targets/`) | exit 0 — proven live by an injected error being reported |
| Every task's `Verify:` command, aggregated | 571 pass / 0 fail, 22 files |
| `build:opencode` + bundle purity | 0.61 MB; no `bun:sqlite` / `sqlite-vec` / `@xenova` |
| Parity | every fixture byte-identical; `spec-verify.diff` 0 bytes; new `cli-tools.md` guard proven by injected drift |
| ESLint | cannot run — repo has no `eslint.config.*` (pre-existing) |

**Live smoke — the working-tree sidecar in an isolated `SENTINAL_HOME`** (separate DB, pid, port; `--http-only`; shared nothing with the developer's installed 1.37.1 sidecar, which was confirmed untouched before and after):

- **D** — `POST /tdd-state/transition` with no project → 400. Seeded RED rows in two projects; a transition sent with the **worktree** path normalized to the canonical project and deleted exactly `count: 1`; **the other project's RED row survived.**
- **C** — `GET /notifications/session` with a blank project → 400; bad mark-read id → 400; the skew notification surfaced as an allow-listed global row.
- **B** — `POST /retire` accepted and notified on the client-triggered path. ⛔ **Then, while 14 further `/retire` POSTs arrived at 5s intervals, the process retired itself after 70s** (60s grace + tick), logging *"shutting down: retiring (client request) — no active sessions for 60000ms"*. This is the review's self-defeating-loop finding proven closed in a real process, not only in a unit test. The process exited on its own; nothing was signalled.

**Behaviour Contract**

- *Fix (C ⇒ P):* in a linked worktree, a RED cycle under the workspace pauses autocontinue (real two-worktree fixture, plugin and module level); a project-scoped bulk transition leaves another project's RED state intact (unit, integration, and live); a stale sidecar retires when idle even under continuous requests (unit and live); unread project and skew notifications reach the model via the system prompt.
- *Preservation (¬C ⇒ unchanged):* identity == workspace in a main checkout, so the original eight compaction tests pass unchanged; the sidecar does **not** retire while sessions are active and fresh (mutation-proven three ways); unscoped TDD reads still return everything (D6 back-compat); no notifications → SessionStart output unchanged; an old sidecar without the new routes is silent.

## Deferred Issues

- ⚠️ **No producer writes a project onto a notification yet.** `POST /notification` (`routes.ts:~482-498`) drops `projectPath`, and none of the `insertNotification` callers (stop-failure, config-change, task-created, session-end, `spec_notify`, self-heal, vector-stats) set one. So the **per-project half** of the new SessionStart consumer surfaces nothing today; only the global skew warning does. The consumer, filter, route and store are all ready — only the producers need updating.
- **POST `/tdd-state` still accepts an absent project.** Now that every known writer sends one (the Claude Code tracker, the OpenCode plugin, and `tdd_set_state`), the route could be made to require it, closing the NULL-project-row gap permanently. Deferred rather than done blind: an unknown external caller would get a 400 that the plugin-style `catch {}` could swallow.
- **Migration-ladder retry property is weaker than documented.** "Don't bump the version when the guard skips" does not guarantee a retry, because the ladder reads `MAX(version)` — if V12's guard skips but V13 succeeds, V12 never re-runs. Low risk today.
- **Sidecar READ routes are still un-normalized** (`/memory/search`, `/memory/timeline`, `/spec/current`, `/tdd-state/list`) — carried from the preceding plan. `/tdd-state/list` also takes no project, which is why Task 10 filters client-side.
- `mergeSharedObservations` identity/workspace conflation — carried from the preceding plan, unchanged.
- File-length pressure: `migrations.ts` 528, `server.ts` 523, `routes.ts` 518, `client-routes.ts` 407 — all over the 400 warn, under the 600 block.
- The plugin's init still autostarts the sidecar via a hardcoded `homedir()/.sentinal` path that ignores `SENTINAL_HOME` (only its logging honours it). Pre-existing test-hygiene issue.
- Pre-existing test quirk: `PASS_OUTPUT` in `tdd-tracker.test.ts` contains `"0 fail"`, which the real tracker classifies as a failure.

## Implementation Tasks

### Task 1: Split compaction signature + isInside

**Objective:** Stop conflating identity with workspace, and harden the prefix match.
**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `src/opencode/compaction-autocontinue.ts`
- Test: `src/opencode/compaction-autocontinue.test.ts`

**Key Decisions / Notes:**

- Change the signature to take two named roots — e.g. `(sidecar, roots: { identity: string; workspace: string })`. `:39` uses `workspace`, `:54` uses `identity`.
- Add `import { isInside } from "../worktree/disk-scan.js"` and replace `cycle.filePath.startsWith(projectPath)` with `isInside(cycle.filePath, workspace)`. Verified bundle-safe: `src/project/identity.ts:34` already imports that module and `resolveRealPath` is already in the built bundle.
- ⛔ **Fix the mock FIRST or the RED is unobservable.** `makeMockSidecar` (`compaction-autocontinue.test.ts:12-16`) names the argument `_projectPath` and discards it. Make it capture both arguments so tests can assert *which* root reached the sidecar.
- Add the failing case the existing suite cannot express: a `filePath` under the **workspace** while `identity` is a different root — today that returns `shouldContinue: true`. Use the real two-worktree fixture from `targets/opencode/plugins/sentinal.test.ts:524-554`.
- Assert the two `isInside` edge cases explicitly: strictness (`isInside(x, x) === false`) and a relative `filePath` being excluded (fail-open, matching today).
- Keep the module docblock constraint (`:8`, no `bun:sqlite`) accurate — this adds the module's first runtime import.

**Definition of Done:**

- [ ] A RED-state cycle under the workspace pauses autocontinue when identity ≠ workspace
- [ ] The mock captures and the test asserts which root each sidecar call received
- [ ] Strictness and relative-path cases asserted
- [ ] Mutation test: swapping `workspace`↔`identity` fails the new test
- [ ] No diagnostics errors

**Verify:**

- `bun test src/opencode/compaction-autocontinue.test.ts`

---

### Task 2: Migration V13 — `tdd_cycles.project_path`

**Objective:** Give `tdd_cycles` a project column so cross-project operations become expressible.
**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `src/memory/migrations.ts`
- Modify: `src/memory/types.ts`
- Test: `src/memory/migrations.test.ts`

**Key Decisions / Notes:**

- Add `project_path TEXT` (nullable at the column level) plus an index. Bump `SCHEMA_VERSION` to 13 (`types.ts:218`) and add the `if (currentVersion < 13) migrateV13(db)` rung — the ladder is a hardcoded `if` chain (`migrations.ts:35-46`), you must add the line manually.
- ⛔ **Follow `migrateV12`'s pattern, not `migrateV11`'s.** V12 (`:84-88,103-115`) deliberately does **not** bump the version when its guard skips or its artifacts fail verification, so it retries next run. V11 (`:134`) bumps unconditionally — the anti-pattern V12's own comment calls out.
- Guard with `PRAGMA table_info(tdd_cycles)` for idempotency, as the existing migrations do (`:90-95`, `:317-336`).
- **D1: DELETE all pre-existing `tdd_cycles` rows** in the same migration. Read D1 in Key Decisions — the rationale was corrected after review; the load-bearing half is that `RED_CONFIRMED` is the guard's **bypass** state, so a surviving NULL-project RED row leaves that file permanently exempt from TDD enforcement. Log the deleted count.
- ⚠️ **Also add `project_path TEXT` to `notifications`** in this same migration (added after review). The table has no project column (`migrations.ts:261-277`), which would make Task 11's SessionStart consumer surface — and silently mark read — other projects' notifications. Index it. Existing notification rows may keep `project_path` NULL: they are historical, non-destructive, and Task 11 filters them out rather than acting on them.
- Migrations are forward-only with no rollback; `backupDatabase` already runs before applying (`:27-33`).

**Definition of Done:**

- [ ] `PRAGMA table_info(tdd_cycles)` shows `project_path`
- [ ] `PRAGMA table_info(notifications)` shows `project_path`
- [ ] Re-running migrations is a no-op (idempotent)
- [ ] Pre-existing `tdd_cycles` rows are removed and the count logged
- [ ] Pre-existing `notifications` rows survive with NULL project
- [ ] `SCHEMA_VERSION === 13`
- [ ] Version is not bumped when the guard skips
- [ ] No diagnostics errors

**Verify:**

- `bun test src/memory/migrations.test.ts`

---

### Task 3: `retire-check.ts` — binary staleness detection

**Objective:** Let the sidecar answer "has my installed binary been replaced by a different version?" cheaply.
**Dependencies:** None
**Wave:** 1

**Files:**

- Create: `src/sidecar/retire-check.ts`
- Test: `src/sidecar/retire-check.test.ts`

**Key Decisions / Notes:**

- Two-stage, per the design decision: snapshot `statSync(getSentinalBinPath()).mtimeMs` at construction; on each poll compare. **Only when mtime changed**, spawn `--version` once to confirm a genuine version difference. This avoids a 3s `spawnSync` on every 30s tick.
- Use `getSentinalBinPath()` (`src/opencode/dashboard-ensure.ts:28-30`) — it honours `SENTINAL_HOME`. ⛔ Not `BIN_PATH` from `update.ts:40-41`, which hardcodes `homedir()` and would make tests reach the real install.
- Reuse `parseBinaryVersion` (`dashboard-ensure.ts:42-59`) — it accepts only bare `MAJOR.MINOR.PATCH[-+suffix]` because a mid-update binary once printed the literal string `undefined` (`:37-40`). Do **not** reuse `getBinaryVersion()` directly: it caches permanently (`:65`), which defeats the entire purpose here.
- Inject the seams the way `SelfHealOptions` does (`self-heal.ts:61-68`): a `spawner`, a `statter`, and a `forceCompiled` override. Tests run from source where `__SENTINAL_VERSION__` is undefined (`self-heal.test.ts:175`), so the compiled gate must be overridable.
- Never throw — a failed stat or spawn means "not stale", the conservative answer.
- Honour a `SENTINAL_NO_AUTO_RETIRE=1` kill switch, mirroring `SENTINAL_NO_AUTO_SETUP` (`self-heal.ts:105`).

**Definition of Done:**

- [ ] Unchanged mtime → not stale, and **no spawn occurs** (assert spawn count)
- [ ] Changed mtime + different version → stale
- [ ] Changed mtime + same version → not stale
- [ ] Missing binary / spawn failure / unparseable output → not stale, no throw
- [ ] `SENTINAL_NO_AUTO_RETIRE=1` → never stale
- [ ] No diagnostics errors

**Verify:**

- `bun test src/sidecar/retire-check.test.ts`

---

### Task 4: `retire-notify.ts` — once-per-version skew signal

**Objective:** Emit the skew signal through channels that actually reach a human.
**Dependencies:** None
**Wave:** 1

**Files:**

- Create: `src/sidecar/retire-notify.ts`
- Test: `src/sidecar/retire-notify.test.ts`

**Key Decisions / Notes:**

- Copy the shape of `notifyVectorUnavailableOnce` (`src/sidecar/vector-stats.ts:56-71`): check a version-scoped settings key → set it → `insertNotification` → return whether it fired. Its test (`routes.test.ts:83-103`) calls 3× and asserts exactly 1 notification; mirror that.
- Write the settings key **at attempt start**, per `self-heal.ts:51,112-119`, so a crash cannot retry-loop.
- Emit `logSidecar` **as well as** the notification — `sentinal sidecar logs` (`src/cli/commands/sidecar.ts:215-232`) is the only channel visible without the dashboard.
- ⚠️ Leave `specId` **null**. It is a real FK to `specs(id)` (`migrations.ts:261-277`); a non-existent id throws `FOREIGN KEY constraint failed`.
- Notification should name both versions and the remedy (`sentinal sidecar restart`), matching the tone of the existing skew log line at `client.ts:192-194`.
- Take a structural-subset context like `SelfHealContext` (`self-heal.ts:56-59`) rather than the full `SidecarContext`, so it is trivially testable.

**Definition of Done:**

- [ ] Fires exactly once per version across repeated calls
- [ ] Writes both a notification and a sidecar log line
- [ ] `specId` is null
- [ ] A store failure is swallowed (best-effort, never throws)
- [ ] No diagnostics errors

**Verify:**

- `bun test src/sidecar/retire-notify.test.ts`

---

### Task 5: Sidecar retire wiring + `/retire` route

**Objective:** Make the sidecar retire when safe, reusing the existing shutdown loop.
**Dependencies:** Tasks 3, 4
**Wave:** 2

**Files:**

- Modify: `src/sidecar/server.ts`
- Create: `src/sidecar/retire-routes.ts`
- Test: `src/sidecar/server.test.ts`, `src/sidecar/retire-routes.test.ts`

**Key Decisions / Notes:**

- Add a retire flag to `SidecarContext` (`server.ts:72-83`), matching how `ctx.vectorState` is written by a background task and read at `routes.ts:451`. ⛔ Do **not** change the return type of `enableSessionAwareShutdown` — that breaks `src/cli/commands/sidecar.ts:102` and `:200`.
- ⛔ **Placement is the entire risk of this task, and "after line 220" is necessary but NOT sufficient.** Review identified a three-way fork, and the original plan picked none of them:
  - At `:226`, immediately after the early return → bypasses the grace period, contradicting D2.
  - Inside `if (sessionsEverSeen)` (`:227-235`) → correct for normal use, but a sidecar that **never saw a session never retires**.
  - In the `else` idle-fallback branch (`:236-242`) → **self-defeating.** That gate is `Date.now() - lastActivityTime >= fallbackIdleMs`, and `touchActivity()` runs on *every* incoming request (`:113-116`, called at `:379`). Task 8 fires `/retire` from `noteVersionSkew` on the hot path of every hook — so each request resets the very timer retirement depends on. The harder the client asks, the longer it is deferred.
  - ✅ **Required placement: immediately BEFORE the `if (sessionsEverSeen)` test at `:227`, with the retire branch doing its own grace accounting by reusing `noSessionSince` rather than short-circuiting it.** That reaches both the seen and never-seen cases, and preserves D2.
- Do not call `doShutdown` from the route handler, and do not flip `sessionsEverSeen`.
- Wire `detectBinaryStaleness` (Task 3) into the same interval so self-detection and client-request converge on one flag, and call `notifySkewOnce` (Task 4) when it flips.
- ⚠️ **The `/retire` route handler must ALSO call `notifySkewOnce`** (added after review). Wiring it only into the self-detection branch means a client-detected skew retires **silently** — leaving the user's requested "combination of all three" un-unified.
- **D4 — measure the autostart claim, do not assume it.** Retire is stop-only. `SidecarClient.connect()` returns `null` without autostarting; only `connectWithRetry()` and `reconnect()` call `autoStartFn()`. Record what a hook-only workload actually experiences after a retire and write the answer into the plan.
- New route file, not `routes.ts` — that file is at **501/600** lines and the codebase splits routes per domain (`spec-routes.ts:10-11`). Register in `fetchHandler` (`server.ts:378-394`); note `handleSidecarRequest` must stay **last** because it is the only handler that returns 404.
- D3: the route is idempotent and returns immediately; it never waits for the retirement.
- Preserve the `stopDashboardFn` contract (`server.ts:134-141,180-188`): when omitted **and** `onShutdown` is also omitted → real `stopServer()`; when omitted but `onShutdown` is set → no-op, which protects tests from touching real PID files.

**Definition of Done:**

- [ ] `/retire` sets the flag and returns ok without blocking
- [ ] Retire **does not** shut down while sessions are active with fresh activity — test mirrors `server.test.ts:705-733`
- [ ] Retire shuts down once sessions are absent, with a distinct reason string
- [ ] **A sidecar with `sessionsEverSeen === false` still retires** within the grace period once stale
- [ ] **Repeated `/retire` POSTs do not indefinitely defer shutdown** — assert retirement occurs while requests are still arriving
- [ ] A detected stale binary triggers the same path and notifies once
- [ ] A **client-triggered** retire also notifies (not just the self-detected path)
- [ ] Calling `/retire` repeatedly is harmless
- [ ] D4 measured: what a fresh `SidecarClient.connect()` from a hook sees after a retire is recorded in the plan
- [ ] No diagnostics errors

**Verify:**

- `bun test src/sidecar/server.test.ts src/sidecar/retire-routes.test.ts`

---

### Task 6: Store writes `tdd_cycles.project_path`

**Objective:** Give the store layer a project-aware TDD write and read.
**Dependencies:** Task 2
**Wave:** 2

**Files:**

- Modify: `src/memory/store.ts`
- Modify: `src/memory/store-sessions.ts`
- Modify: `src/memory/types.ts`
- Test: `src/memory/store.test.ts`

**Key Decisions / Notes:**

- Add `projectPath` to the TDD upsert and to the `TddCycle` type (`types.ts:234`); map `project_path` in the deserializer (`store.ts:282-293`).
- Give `listActiveTddStates` an optional project filter alongside the existing `specId` (`store.ts:224-240`). Today with no `specId` the query is completely unscoped.
- ⚠️ **Also plumb the notifications project** (added after review): `insertNotification` (`store-sessions.ts:181-204`) accepts an optional `projectPath`, and `getNotifications` (`:213`) accepts an optional project filter. Task 11 depends on both.
- ⛔ **Read the D6 decision before touching `listActiveTddStates`.** Reads deliberately fail OPEN (no project → return everything) while Task 7's write fails CLOSED. This asymmetry is intentional; do not harmonise them.
- Normalize with `resolveProjectIdentity` at the **boundary**, not inside the store — the store must keep accepting synthetic paths (`/test/project`) that existing tests rely on. Mirrors the deliberate `SpecStore` choice from the previous plan.
- Do not change `file_path`'s UNIQUE constraint; scoping is additive.

**Definition of Done:**

- [ ] A cycle written with a project is retrievable filtered by that project
- [ ] `listActiveTddStates` with no project still returns everything (back-compat, per D6)
- [ ] `insertNotification` records a project; `getNotifications` can filter by it
- [ ] A notification with a NULL project is excluded by a project-filtered read
- [ ] Existing store tests pass unchanged
- [ ] No diagnostics errors

**Verify:**

- `bun test src/memory/store.test.ts`

---

### Task 7: `bulkTddTransition` project scoping

**Objective:** Stop one project's bulk transition deleting another project's RED state.
**Dependencies:** Tasks 2, 6
**Wave:** 3

**Files:**

- Modify: `src/sidecar/tdd-routes.ts`
- Modify: `src/sidecar/client-routes.ts`
- Test: `src/sidecar/tdd-routes.test.ts`

**Key Decisions / Notes:**

- ⛔ **The call chain is FOUR hops, and the original plan named the wrong files.** Verified after review:

  `targets/opencode/plugins/sentinal.ts:306,316` → `transitionTddState()` at **`targets/opencode/plugins/sentinal-helpers.ts:259-269`** → `sidecar.tddTransition(action, specId)` at **`src/sidecar/client-routes.ts:129-133`** → POST `/tdd-state/transition` → `handleTddTransitionRequest` (`tdd-routes.ts:60-82`) → `bulkTddTransition` (`:26`).

  `bulkTddTransition` has exactly **one** production caller (`tdd-routes.ts:76`). There is no CLI caller and no Claude Code caller — `src/hooks/tdd-tracker.ts` does per-cycle updates at `:95-128`, not the bulk route. **This task owns the middle two hops; Task 12 owns the plugin two.**
- `bulkTddTransition` (`:33-52`) currently runs `UPDATE ... WHERE state='TEST_WRITTEN'` and `DELETE ... WHERE state='RED_CONFIRMED'` with **no project clause**. Add `AND project_path = ?`.
- Extend `tddTransition(action, specId)` → `tddTransition(action, specId, projectPath)` in `client-routes.ts:129-133`.
- ⛔ **Make the project REQUIRED and fail closed.** An optional parameter reproduces the bug the moment a caller forgets it — exactly how this arose. A missing project must be a 400, not an unscoped sweep.
- ⚠️ **But the 400 is currently invisible** (added after review): `transitionTddState` wraps the call in `try { ... } catch { /* non-fatal */ }` (`sentinal-helpers.ts:259-269`) and `sidecarTddTrack` adds a second swallowing catch (`sentinal.ts:318-320`). A rejection would produce no log, no notification, no signal — reintroducing this plan's own defect shape. **The 400 path must `logSidecar` a distinct message naming the missing project.** Task 12 handles the plugin half.
- This is a **destructive** write path; the test must prove isolation directly: seed RED rows in two projects, transition one, assert the other survives.

**Definition of Done:**

- [ ] A bulk transition scoped to project A leaves project B's rows untouched (explicit two-project test)
- [ ] A request with no project is rejected, not treated as "all"
- [ ] The rejection emits a distinct `logSidecar` line naming the missing project
- [ ] `tddTransition`'s new signature is covered by a client test
- [ ] No diagnostics errors

**Verify:**

- `bun test src/sidecar/tdd-routes.test.ts src/sidecar/client.test.ts`

---

### Task 8: Client `/retire` request on skew

**Objective:** Let a skew-detecting client ask the stale sidecar to retire.
**Dependencies:** Tasks 5, 7
**Wave:** 4

⛔ **Moved from Wave 3 after review.** Task 7 must also edit `src/sidecar/client-routes.ts` (threading the project through `tddTransition`), which would have been a same-wave overlap with this task's `requestRetire()` addition to the same file.

⚠️ **Scope added during implementation (Wave 3 gap):** this task also owns two small TDD-plumbing edits, because it is the only Wave 4 owner of `client-routes.ts` and no Wave 4 task owns `src/tdd/mcp-tools.ts`:
1. Add `projectPath?: string` to `setTddState`'s options type in `src/sidecar/client-routes.ts` (the method already spreads `...opts`, so it is type-only).
2. Make the `tdd_set_state` MCP tool (`src/tdd/mcp-tools.ts:~140-150`) send `resolveProjectIdentity(project ?? process.cwd())` on **both** the client and store paths.

Additional Files: `src/tdd/mcp-tools.ts`, `src/tdd/mcp-tools.test.ts`.

**Files:**

- Modify: `src/sidecar/client.ts`
- Modify: `src/sidecar/client-routes.ts`
- Test: `src/sidecar/client.test.ts`

**Key Decisions / Notes:**

- Add a public `requestRetire()` to `SidecarRoutes` (`client-routes.ts`, alongside `insertNotification` at `:339`) — `post` is `protected`, so it cannot be called from `client.ts` directly.
- Call it from `noteVersionSkew` (`client.ts:187-195`). ⛔ **Fire-and-forget with `.catch(() => {})` — never `await`.** `tryConnect` is on the hot path of every hook invocation, and the default unmatched-path budget is `DEFAULT_REQUEST_TIMEOUT_MS = 2_000` (`client.ts:45`).
- Preserve the documented policy (`client.ts:181-186`): skew must **never refuse the connection**. This heals rather than refusing, which is consistent — state that in the docstring so the next reader does not think the rule was broken.
- The probe has `reconnectEnabled = false` (`:98`, built at `:140`/`:169`), so a retiring sidecar dropping the connection will not trigger a respawn storm. Keep it that way.
- Consider adding `/retire` to `REQUEST_TIMEOUTS` (`:41-44`) with a short budget.

**Definition of Done:**

- [ ] Skew triggers exactly one retire request
- [ ] Matching versions trigger none
- [ ] A failing/slow `/retire` never delays or fails `tryConnect` (assert timing or that the promise is not awaited)
- [ ] The existing skew log line still emits
- [ ] No diagnostics errors

**Verify:**

- `bun test src/sidecar/client.test.ts`

---

### Task 9: TDD write paths populate project

**Objective:** Ensure both non-plugin writers record a project.
**Dependencies:** Task 6
**Wave:** 3

**Files:**

- Modify: `src/sidecar/routes.ts`
- Modify: `src/hooks/tdd-tracker.ts`
- Test: `src/sidecar/routes.test.ts`, `src/hooks/tdd-tracker.test.ts`

**Key Decisions / Notes:**

- `handleSetTddState` (`routes.ts:267-276`) passes `body.filePath` through; add the project and normalize it with the existing `normalizeProjectKey` (`routes.ts:162-166`), which is currently wired only into other write handlers.
- `src/hooks/tdd-tracker.ts:71-77` uses the raw `tool_input.file_path`; derive the project from `input.cwd` via `resolveProjectIdentity`.
- Pre-Mortem 3: after this task, `SELECT COUNT(*) FROM tdd_cycles WHERE project_path IS NULL` must be 0 for any newly written row. Add that as an assertion.
- The third writer is the OpenCode plugin — Task 12.

**Definition of Done:**

- [ ] A cycle written via `/tdd-state` records a normalized project
- [ ] A cycle written by the Claude Code tracker records a normalized project
- [ ] No newly written row has a NULL project
- [ ] No diagnostics errors

**Verify:**

- `bun test src/sidecar/routes.test.ts src/hooks/tdd-tracker.test.ts`

---

### Task 10: TDD readers project-scoped

**Objective:** Stop the agent-facing TDD status tools reporting other projects' cycles.
**Dependencies:** Task 6
**Wave:** 3

**Files:**

- Modify: `src/opencode/native-tdd-status.ts`
- Modify: `src/tdd/mcp-tools.ts`
- Test: `src/opencode/native-tdd-status.test.ts`, `src/tdd/mcp-tools.test.ts`

**Key Decisions / Notes:**

- `native-tdd-status.ts:62` calls `listActiveTddStates(specId ?? null)`, and the agent-facing `spec_id` arg is **optional** with a documented default of "lists all active TDD states" (`:16-18`). With no spec id it reports every project on the machine, rendered raw at `:66`. It has no `projectPath` in scope — it needs one.
- `src/tdd/mcp-tools.ts:76-77` has the same optionality on the MCP surface.
- These are **read** paths, so scoping is a behaviour change: the documented "lists all" default becomes "lists all in this project".
- ⛔ **Prose drift is wider than the tool description** (expanded after review). `.sentinal/skills/sentinal-schema-prose-drift` exists precisely because shipped prose drifts independently of source. The old semantics are ALSO carried in `.sentinal/rules/sentinal-mcp-servers.md` (which documents `tdd_status` as *"Read TDD cycle state (per file or all active)"*) and in generated copies inside `src/cli/embedded-assets.ts` (`:18933`, `:20292`, `:26796`, `:28213`). Update the rules file here; `embedded-assets.ts` is regenerated by Task 12.
- ⚠️ Per D6 this is a read path, so it fails **open** — an over-broad report is visible and harmless. Do not make the project required here.

**Definition of Done:**

- [ ] With no spec id, only the current project's cycles are reported
- [ ] Tool descriptions match the new behaviour
- [ ] `.sentinal/rules/sentinal-mcp-servers.md` updated to match
- [ ] No diagnostics errors

**Verify:**

- `bun test src/opencode/native-tdd-status.test.ts src/tdd/mcp-tools.test.ts`

---

### Task 11: SessionStart notification consumer

**Objective:** Make notifications reach the agent, not just the dashboard.
**Dependencies:** Task 4
**Wave:** 4

**Files:**

- Modify: `src/hooks/session-start.ts`
- Test: `src/hooks/session-start.test.ts`

**Key Decisions / Notes:**

- `src/hooks/session-start.ts` is 58 lines and already emits `hint()` for session conflicts (`:42-45`) — follow that shape.
- Read unread notifications via the sidecar (the hook already connects) and surface a bounded summary. Cap the count and truncate; a session-start hook must stay fast.
- ⛔ **Filter by project** using `resolveProjectIdentity(input.cwd)` and the project filter Task 6 adds. Without it this hook surfaces notifications produced while working in *other* projects — `notifications` had no project column before V13.
- ⛔ **NEVER call `markAllNotificationsRead()`** (`store-sessions.ts:239`) — it takes no arguments and is **global**, so a session start in project A would mark project B's unseen notifications read and zero the dashboard's unread badge. Use per-id `markNotificationRead` (`:235`) for exactly the ids surfaced.
- Rows with a NULL project (pre-V13 historical) are excluded, not acted on.
- Degrade silently when the sidecar is unavailable — `SidecarClient.connect()` returns `null` and hooks must never throw.
- This closes the general gap, not just the skew case: today **nothing** outside `src/dashboard/` reads notifications.

**Definition of Done:**

- [ ] Unread notifications for **this project** appear in SessionStart output
- [ ] A notification created for project B does not appear in, and is not marked read by, a SessionStart in project A
- [ ] The dashboard unread count is unaffected by notifications this hook did not surface
- [ ] Surfaced notifications do not repeat on the next session
- [ ] No notifications → output unchanged from today
- [ ] Sidecar unavailable → no throw, no output change
- [ ] No diagnostics errors

**Verify:**

- `bun test src/hooks/session-start.test.ts`

---

### Task 12: OpenCode plugin wiring — 4 edits

**Objective:** Land all plugin-side changes in one task, since these files are the highest-conflict surface.
**Dependencies:** Tasks 1, 7, 11
**Wave:** 4

**Files:**

- Modify: `targets/opencode/plugins/sentinal.ts`
- Modify: `targets/opencode/plugins/sentinal-helpers.ts`
- Modify: `src/cli/embedded-assets.ts` (regenerated, not hand-edited)
- Test: `targets/opencode/plugins/sentinal.test.ts`, `targets/opencode/plugins/sentinal-helpers.test.ts`

**Key Decisions / Notes:**

Four edits, all owned by this task:

1. **Compaction caller** (`sentinal.ts:1233-1236`): pass both roots. `projectWorkspace` is already in scope from the destructure at `:342` — no plumbing needed. Delete the now-stale ⚠️ caveat comment at `:1226-1230`.
2. **TDD plumbing — four hops, not one** (corrected after review). Thread a `projectPath` into `sidecarTddTrack`'s signature from its call site, pass it to `setTddState` (`sentinal.ts:292`) **and** to both `transitionTddState` calls (`:306`, `:316`). Then extend `transitionTddState` and the `TddTransitionSidecar` interface in **`sentinal-helpers.ts:259-269`** to forward it. `sentinal-helpers.test.ts:33-56` asserts the `tddTransition` signature and must be updated. ⛔ Task 7 makes the project **required** — missing any hop breaks TDD tracking.
3. **Stop swallowing the failure** (added after review). `transitionTddState`'s `catch { /* non-fatal */ }` and `sidecarTddTrack`'s catch at `sentinal.ts:318-320` would hide Task 7's 400 entirely. Write to the plugin debug log (`~/.sentinal/plugin.debug.log`) instead of swallowing.
4. **SessionStart notifications**: mirror Task 11's Claude Code behaviour in `session.created`, including the project filter and the per-id read-marking prohibition. See `.sentinal/rules/sentinal-dual-target.md`.

- ⚠️ **Run `bun run embed-assets`** (added after review). `src/cli/embedded-assets.ts` holds a generated copy of the plugin bundle — `:16309` is the current compaction code and `:15942` the current `tddTransition`. Nothing else in this plan regenerates it, so without this the CLI installer ships pre-change plugin code while every test passes.
- `sentinal.ts` is **exempt** from file-length limits (`PATH_EXEMPTIONS`); `sentinal-helpers.ts` is **not**.
- There is currently **no test at all** for the `"compaction.autocontinue"` handler. Add one; roots-aware wiring precedents are `session.created` (`:635-644`) and `session.idle` (`:646-666`).

**Definition of Done:**

- [ ] Compaction handler passes workspace for the disk filter and identity for the spec lookup (asserted, not assumed)
- [ ] Plugin-written TDD cycles carry a project; both `transitionTddState` calls forward one through all four hops
- [ ] An **integration-level** test drives the real helper against a real route and asserts a `count` is returned — not merely that the call did not throw
- [ ] A rejected transition is written to the plugin debug log, not swallowed
- [ ] `session.created` surfaces notifications, project-filtered, matching the Claude Code hook
- [ ] `bun run embed-assets` run and `embedded-assets.ts` contains the new compaction code
- [ ] `bun run build:opencode` succeeds and the bundle guard passes
- [ ] No diagnostics errors

**Verify:**

- `bun test targets/opencode/plugins/ src/cli/target-assets.test.ts && bun run build:opencode && bun run embed-assets`
