# Worktree Slot + Isolated Config

Created: 2026-08-07
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature
Parent: 2026-08-07-worktree-runtime-isolation
Wave: 1

## Summary

**Goal:** Give every worktree an integer **slot**, unique among _active_ worktrees of the same project, released on cleanup — and use it to seed **isolated config** at creation time so the agent never needs to copy the repo-root `.env`. Sentinal needs no knowledge of what a project does with the number; the only guarantee is uniqueness while active, reuse only after release.

**Context:** See master plan at `docs/plans/2026-08-07-worktree-runtime-isolation.md` (Phase 2, Wave 1). Resolves Tier 2 of GitHub issue #2. Decisions **D1** (delivery = tool output + interpolation **and** a written env file; exclusion mechanism pending Task 1's spike), **D2** (uniqueness per project path), **D7** (slot 0 reserved) and **D8** (`.env.example` seeding) apply.

## ⚠️ Two additions beyond issue #2

**D7 — slot 0 is reserved for the main checkout; allocation starts at 1.** The issue allocates from a pool of _active worktree records_, but the developer's main checkout is **never a worktree record** — `store.countActive()` (`src/worktree/store.ts:139-154`) counts DB rows only. Without reserving 0, the first worktree receives the number the developer's own default stack is already using, which is precisely the collision this tier exists to prevent. The convention must be stated wherever the slot is surfaced.

**D8 — seed `.env` from `.env.example` at creation.** Incident step 3 was "copied the repo root `.env` into the worktree to get database config" — that is _why_ it hit live databases, and no tier in the issue addresses it. Git worktrees correctly do not inherit gitignored files; the agent worked around it. Seeding removes the motive.

## Scope

### Schema

- `migrateV12` in `src/memory/migrations.ts` — add `slot INTEGER` to `worktrees`. Follow the `migrateV5` worktrees DDL (`:276-311`) and the V11 idempotent-column guard pattern (`:56-61`).
- Dispatch line after `src/memory/migrations.ts:45`.
- Bump `DB_CONSTANTS.SCHEMA_VERSION` at `src/memory/types.ts:218` → `12`.
- **SQLite cannot `ALTER TABLE ADD COLUMN` with UNIQUE.** Uniqueness requires a partial unique index, e.g. `CREATE UNIQUE INDEX IF NOT EXISTS idx_wt_slot_active ON worktrees(project_path, slot) WHERE status = 'active'`. No partial-index precedent exists in that file.
- Test template: `src/memory/migrations-v11.test.ts` (temp dir, raw `Database`, `runMigrations`, `PRAGMA table_info`, `SCHEMA_VERSION` assertion).

### Allocator

- **New module `src/worktree/slots.ts`.** `manager.ts` is 542/600 lines — the allocator must not go there.
- **Allocation starts at 1. Slot 0 is reserved for the main checkout (D7)** and is never handed out. Test explicitly that no worktree can receive 0.
- `WorktreeStore` has no `listActiveSlots()`; only `countActive` (`store.ts:139-154`) which returns a bare count. A new query is needed.
- Allocation call sites: `manager.create()` — must sit **inside** the existing rollback envelope at `:124-140` — and `resolveWithReconcile()`'s second `store.insert()` at `:348-358` (easy to miss).
- Release exit paths (**6**): `abandon` `:302`, `squashMerge` `:270`, `cleanup` `:378`, `forceCleanupOrphans` `:444`, `resolveWithReconcile` self-heal `:319`, and `store.delete()` (`store.ts:129-136`) which bypasses `updateStatus` entirely. Centralising in `WorktreeStore.updateStatus` (`store.ts:107-119`) covers 5 of 6.

### Type / store plumbing

- `Worktree` + `WorktreeSchema` (`src/worktree/types.ts:22-36`)
- `RawWorktree` (`store.ts:18-30`) → `slot: number | null`
- `deserialize` (`store.ts:199-213`)
- the 9-column insert SQL + args (`store.ts:45-58`)
- `makeWorktree()` fixture (`store.test.ts:13`)
- new `SLOT_EXHAUSTED` code on `WorktreeError` (`types.ts:72-79`), with an actionable message pointing at `worktree_cleanup`

### Surfacing (D1)

- `worktree_create` / `worktree_detect` MCP output — these emit **Markdown, not JSON** (`src/worktree/mcp-tools.ts:126-135`, `:86-96`); add a `- **Slot:** N` bullet.
- CLI `--json` shapes (`src/cli/commands/worktree.ts:319-326` create, `:279-288` detect).
- Write a sourceable `KEY=VALUE` env file into the worktree containing `SENTINAL_WORKTREE_SLOT`. **No precedent exists** — nothing writes into a worktree today (R8). **The exclusion mechanism is NOT yet decided** — master D1/R8 require Task 1's spike first. Preferred candidate is the resolved `$GIT_DIR/info/exclude`, but expect it to fail (see Task 1). Settle path and format; **add a test proving it cannot be committed**.
- Slot range: derived solely from `WorktreeConfig.maxActive` (default 5, `types.ts:38-44`), **offset by the reserved slot 0**. The `runtime.json` `slots` override is **cut from v1** — `maxActive` is the single source of truth.
- Barrel export for `src/worktree/slots.ts` goes at the **end** of the worktree block in `src/index.ts` (`:198-201`, `:220-228`). Phase 3 also appends to this file — expect a trivial merge conflict; do not restructure.

### Isolated config seeding (D8)

At worktree creation, alongside the slot env file:

**⚠️ Ordering is load-bearing.** `git worktree add` (`:116-119`) runs _before_ the try block at `:124`, so at that point **no slot exists** and `${SENTINAL_WORKTREE_SLOT}` cannot be substituted. Correct order: (a) `git worktree add` → (b) allocate + `store.insert()` inside the try at `:124-140` → (c) **seed, inside the SAME try**, so the existing `git worktree remove --force` rollback covers a seeding failure. Seeding after the try would leave a DB row plus a half-written worktree with no compensating teardown.

**Failure semantics — distinguish the two cases explicitly:**

- **Missing `.env.example` / slot-free `.env.example`** → **warn and continue**; still return a working worktree (D8 requires this).
- **I/O failure while writing** → **throw**, rolling back both the worktree and the DB row.

0. **⛔ NEVER overwrite an existing `.env` in the worktree.** Seeding runs at `create` **and** via `resolveWithReconcile()` (`manager.ts:348-358`), which by nature operates on a directory that already exists and may already carry a hand-edited `.env`. Overwriting it is silent, unrecoverable loss of an untracked file. If present → skip and report.
1. If a seed source exists → copy into the worktree as `.env`, substituting `${SENTINAL_WORKTREE_SLOT}` where present. **Seed-source discovery must handle monorepos:** check the repo root **and** each workspace package root (`package.json` `workspaces`, `pnpm-workspace.yaml`). Issue #2's reporter describes their environment as "a TypeScript **monorepo with a multi-app dev stack**" — root-only discovery produces nothing for exactly the project shape that filed the issue.
2. **If `.env.example` is absent → warn loudly.** Silence is exactly what drives the agent back to copying the root `.env`. The warning must name the risk, not just note the absence.
3. If `.env.example` exists but contains no slot reference → seed it verbatim **and state plainly in the warning that the result is not isolated** (R11). A clean non-isolated starting point still beats the developer's live credentials, but must not read as a safety guarantee.
4. Both seeded files are excluded via **the mechanism Task 1 selects** (unverified — do not assume `.git/info/exclude`). **Test that neither can be committed.**

Phase 3's `isolation` map (D10) is the durable fix for case 3 — this phase's job is to remove the _motive_ for the copy, not to guarantee isolation. Until Phase 3 lands, case 3 can only produce a blanket warning; afterwards the same warning names the specific shared resources. **Write the case-3 warning so that Phase 3 can enrich it without restructuring the call site.**

## Known Constraints

- `manager.test.ts:40-46` uses a `testConfig` with `maxActive: 3` — the hook for slot-exhaustion tests.
- Sidecar handlers instantiate a fresh `WorktreeManager` per request (`worktree-routes.ts:59, 76, 93`), so allocator state **must** live in SQLite, not instance memory.
- `resolveBySlug` (`store.ts:162-195`) hardcodes `DEFAULT_WORKTREE_CONFIG.branchPrefix`, ignoring the manager's injected config — pre-existing divergence to be aware of.
- CLI `detect`/`sync` call `wtStore.resolveBySlug()` directly, bypassing `manager.resolveWithReconcile()` (`src/cli/commands/worktree.ts:270`, `:355`) — a second divergence.
- There is **no `/worktree/create` sidecar route** and no `createWorktree` client method; creation never goes through the sidecar.
- Pre-V12 rows have `slot = NULL`. No backfill; treat as unslotted and allocate lazily.

## Out of Scope

- Reading or interpolating `.sentinal/runtime.json` — Phase 3.
- Any PID tracking — Phase 4.

---

## Context for Implementer

> Written for someone who has never seen this codebase.

- **Runtime is Bun, tests are `bun test` (bun:test), not jest.** Import from `"bun:test"`.
- **`bunfig.toml` preloads `src/memory/test-preload.ts`** to load Homebrew SQLite before any `Database` is created — `sqlite-vec` will not load otherwise. Always run via `bun test`, never `bun <file>.test.ts`.
- **Migration system** lives in `src/memory/migrations.ts`: `runMigrations(db, dbPath)` at `:14-46` is a linear `if (currentVersion < N) migrateVN(db)` chain, currently through V11 (`:45`). Each `migrateVN` ends with `INSERT OR REPLACE INTO schema_version (version) VALUES (N)`. Version constant is `DB_CONSTANTS.SCHEMA_VERSION` at `src/memory/types.ts:218`.
- **New-column pattern** (copy V11 at `migrations.ts:56-61`): `PRAGMA table_info(<table>)` → `if (!cols.some(...)) ALTER TABLE ... ADD COLUMN ...` → `CREATE INDEX IF NOT EXISTS ...` → bump `schema_version`. Idempotent by construction.
- **⚠️ SQLite cannot `ALTER TABLE ADD COLUMN` with a UNIQUE constraint.** Uniqueness must come from a **partial unique index**. There is no partial-index precedent in this file.
- **⛔ `ready-to-merge` is a LIVE status, not a terminal one.** `WORKTREE_STATUSES` (`types.ts:11-16`) is `active | ready-to-merge | merged | abandoned`, and the codebase treats the first two as live: `store.ts:74`, `:180`, `:189` all select `status IN ('active','ready-to-merge')`, and `manager.ts:235` permits `squashMerge` from either. A `ready-to-merge` worktree still has its directory, its seeded `.env`, and (Phase 4) its running process group. **Scoping the index to `WHERE status = 'active'` would free its slot while it is still running** — handing slot N to a second worktree with colliding ports and DB names, which is the exact collision this phase exists to prevent. Define the live set once and use it everywhere: `LIVE_WORKTREE_STATUSES = ['active','ready-to-merge']`.
- **Known asymmetry:** `countActive` (`store.ts:139-154`) counts only `'active'`, so `maxActive` and slot capacity can disagree by the number of `ready-to-merge` rows. Inherited, not introduced — but the slot design amplifies it.
- **All four production `new WorktreeManager(...)` sites pass `DEFAULT_WORKTREE_CONFIG`** (maxActive 5): `mcp-tools.ts:48`, `cli/commands/worktree.ts:34`, `worktree-routes.ts:59/:76/:93`. Only `manager.test.ts:67` injects `testConfig`.
- **⚠️ CORRECTED after spec review (2026-08-08).** This plan originally said "`create()` checks `countActive >= maxActive` before allocating from the same bound, so **`SLOT_EXHAUSTED` is unreachable via `create()`** … do not write a `create()`-path exhaustion test; it can never go red." **That is false**, and it follows from the "Known asymmetry" note two lines above: `countActive` counts only `'active'` while the pool is scoped to the LIVE set. Fill the pool, move rows to `ready-to-merge`, and the `MAX_ACTIVE` guard passes while `findFreeSlot` returns `null` — `SLOT_EXHAUSTED` is thrown from `create()` and the rollback envelope removes the just-created git worktree. The thrown error is the **right** behaviour (its message names merge/abandon/`worktree_cleanup`, which is the actual remedy); only the "unreachable" claim was wrong. Covered by `manager.test.ts` → `slots > create() > "SLOT_EXHAUSTED IS reachable — ready-to-merge rows hold slots countActive does not count"`.
- **`src/worktree/manager.ts` is 542 lines against a 600-line hard block.** New logic goes in a new module. The file-length hook will refuse the edit otherwise.
- **Worktree tests use real temp git repos** — `initRepo` helper duplicated at `manager.test.ts:19-26`; `makeTmpDir()` from `src/test-helpers.ts`; wrap in `realpathSync()` (macOS `/var` → `/private/var`, and `manager.ts:486-499` compares realpaths).
- **`manager.test.ts:40-46`** defines a `testConfig` with `maxActive: 3` — that is the hook for capacity/exhaustion tests.
- **Sidecar handlers construct a fresh `WorktreeManager` per request** (`worktree-routes.ts:59, 76, 93`), so allocator state **must** live in SQLite, never in instance memory.

## Testing Strategy

- **Unit:** migration V12 (template: `src/memory/migrations-v11.test.ts`), allocator (`src/worktree/slots.test.ts`), store round-trip (`store.test.ts`), release-per-exit-path (`manager.test.ts`).
- **Integration:** real temp git repos for create → allocate → release across all six exit paths.
- **Spike:** Task 1 is empirical — `.git/info/exclude` behaviour in a linked worktree is unverified (R8).

## Assumptions

- The `worktrees` table has existed since V5 (`migrations.ts:276-311`); pre-V12 rows get `slot = NULL` — **no backfill**, treated as unslotted and allocated lazily — Tasks 2, 4 depend on this.
- V12 is the **only** schema migration in this master plan (D5 removed the previously-planned V13) — Task 2.
- `WorktreeConfig.maxActive` (default 5, `types.ts:38-44`) is the sole source of slot range; the `runtime.json` `slots` override was cut from v1 — Task 3.
- **Release is emergent from the index predicate — no code releases a slot.** `store.delete()` (`store.ts:129-136`) removes the row entirely (and thus the index entry) and has **zero production callers** — verified, all six are tests. Task 4 is verification-only.

## Risks and Mitigations

| Risk                                                                                        | Likelihood | Impact | Mitigation                                                                                                     |
| ------------------------------------------------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| **R8** — `.git/info/exclude` unusable in a linked worktree, or leaks into the main checkout | Medium     | High   | Task 1 is a **gating spike** with a stated fallback; asserts the main checkout is unaffected                   |
| Missed release path leaks a slot permanently; partial unique index then hard-fails `create` | Medium     | High   | Centralise in `updateStatus`; **one test per exit path**; `SLOT_EXHAUSTED` message suggests `worktree_cleanup` |
| `manager.ts` trips the 600-line block mid-task                                              | Medium     | Medium | Allocator in `src/worktree/slots.ts`; seeding in its own module; keep `manager.ts` diffs minimal               |
| Seeding clobbers a hand-edited `.env` via `resolveWithReconcile`                            | Medium     | High   | Rule 0: **never overwrite an existing `.env`** — skip and report                                               |
| Slot range off-by-one silently halves capacity                                              | Medium     | Medium | D7 fixes the range as `[1, maxActive]`, slot 0 uncounted; explicit capacity test with `maxActive: 3`           |

## Pre-Mortem

_Assume this phase failed. Most likely internal reasons:_

1. **The partial unique index makes `create` fail hard instead of degrading** (Task 3) → Trigger: a test that leaks a slot then sees `create` throw `SQLITE_CONSTRAINT` rather than a typed `SLOT_EXHAUSTED`. Catch the constraint and map it.
2. **`.git/info/exclude` writes land in the common dir** (Task 1) → Trigger: after seeding one worktree, `git status` in the **main checkout** shows changed ignore behaviour. Fall back to a worktree-local `.gitignore`.
3. **`resolveWithReconcile` allocates a second slot for an already-slotted worktree** (Task 3) → Trigger: reconcile an existing worktree and observe two active rows, or a slot count that exceeds the number of worktrees.

## Spike Findings

_Recorded 2026-08-07 from Task 1. Evidence: `src/worktree/worktree-exclude.test.ts` (9 tests, green). git 2.50.1 (Apple Git-155), macOS._

**The preferred candidate (`$GIT_DIR/info/exclude`) is REJECTED. R8 fired in the predicted direction.**

| Candidate                                        | Result                                                                                                                                                                                       | Evidence               |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Write to `git rev-parse --git-path info/exclude` | ❌ **Leaks into the main checkout.** In a linked worktree this resolves to `<repoRoot>/.git/info/exclude` — the _common_ dir — not `…/.git/worktrees/<name>/info/exclude`.                   | test `REJECTED (a)`    |
| Write to `<per-worktree gitdir>/info/exclude`    | ❌ **Not honoured.** No leak, but git never reads it: the file is written and `git check-ignore` still reports the path as not ignored, and `git status` still lists it.                     | test `REJECTED (b)`    |
| **Self-ignoring worktree-local `.gitignore`**    | ✅ **SELECTED.** Hides the files inside the worktree, `git status` clean, main checkout's `.git/info/exclude` byte-identical and its ignore behaviour unchanged. **Zero common-dir writes.** | tests `SELECTED: …` ×2 |

**Setup is genuinely a linked worktree:** `--git-dir` = `<root>/.git/worktrees/<name>`, `--git-common-dir` = `<root>/.git`; they differ, the former is nested under the latter, and `<worktree>/.git` is a _file_ beginning `gitdir:`.

### Selected mechanism (tiered — what Task 5 must implement)

1. **Pre-check `git check-ignore -q -- <path>` first.** If the repo's _committed_ `.gitignore` already covers the path, write nothing. This is the common case for `.env` in real projects.
2. Otherwise, if `<worktree>/.gitignore` is **untracked or absent** → create/append, and make it list **itself** (`/.gitignore`). Verified: `git status` in the worktree is empty, main checkout untouched.
3. Otherwise (`<worktree>/.gitignore` is **tracked**) → **refuse to modify it** and report the path as un-excluded. Proven necessary: appending to a tracked `.gitignore` does hide the target file but leaves `M .gitignore`, which `git add -A` would sweep into a commit.
4. For **sentinal-owned** files, prefer `<worktree>/.sentinal/` with a directory-scoped self-ignoring `.sentinal/.gitignore` containing `*` (which matches `.gitignore` itself). This works **even when the root `.gitignore` is tracked**, so the slot env file is always excludable. Hence the slot env file lives at `<worktree>/.sentinal/worktree.env`, not at the worktree root.

`isTracked` is `git ls-files --error-unmatch -- <path>` (exit 0 = tracked); the worktree's index is per-worktree so this is correctly scoped.

### Does _this_ repo's committed `.gitignore` cover `.env`?

**No.** Sentinal's root `.gitignore` is tracked and lists `node_modules/`, `dist/`, `src/cli/embedded-assets.ts`, `*.tsbuildinfo`, `.DS_Store`, `.opencode/package-lock.json`, `.idea/`, `docs/bug_reports/` — **no `.env` entry**. So on Sentinal itself, tier 3 applies to a seeded root `.env`: it would be visible in `git status` and Task 5 must warn rather than silently dirty a tracked file. `.sentinal/.gitignore` _is_ tracked here and starts with `*`, so tier 1 already covers `<worktree>/.sentinal/worktree.env`.

### Residual limitation (state plainly)

A project with a **tracked root `.gitignore` that does not cover `.env`** gets a seeded `.env` that is visible to `git status`. Sentinal will **not** silently modify a tracked file to fix that; it warns and names the one-line remedy (add `.env` to `.gitignore`). This is strictly better than the status quo, where the agent copies the root `.env` in — an equally-visible file pointing at live credentials.

### Master-plan correction requested (do not edit — reported per instructions)

`R8`'s mitigation still reads "Verify empirically that a pattern written to the resolved `$GIT_DIR/info/exclude` …". Both halves of that candidate are now **disproven**, and `D1`'s "Preferred candidate is the linked worktree's resolved `$GIT_DIR/info/exclude`" is likewise settled as rejected. The master's data-flow mermaid node also says `excluded via .git/info/exclude`. All three should say **self-ignoring worktree-local `.gitignore`**.

**Status at Task 5/6 completion: this correction has been APPLIED.** Master `D1`, `R8`, the mermaid node (`:258`), and `:328`/`:375` all now describe the tiered self-ignoring `.gitignore`. No further action.

## Master-plan corrections requested from Tasks 5 & 6 (reported, NOT applied)

1. **⚠️ Master `:357` (E2E Goal Verification, step 2) is unsatisfiable as written and contradicts the master's own `:375`.** It says "assert each worktree has seeded config derived from `.env.example`, not the root `.env`, and that **neither file can be committed**". The second clause is false for tier 3 — a project with a **tracked root `.gitignore` that does not cover `.env`** gets a seeded `.env` that _is_ committable, which `:375` already states plainly as an accepted residual limitation ("Sentinal's own repo is in exactly this state"). Written as-is, the E2E check fails on Sentinal itself. Suggested rewording: _"…and that the slot env file cannot be committed; the seeded `.env` cannot be committed **unless tier 3 applies**, in which case assert a warning was emitted naming the remedy."_

2. **Master `:330` should say `slot` **and** `slotNote` for the CLI `--json` shapes.** JSON cannot carry the slot-0 convention as prose, and the master requires the convention be stated at every surface (D7). `slotNote` is the field that does it.

3. **Master `:47` ("`create()` does exactly two side-effecting things") is now stale.** It describes the pre-change baseline in the _Current State_ section, so it is arguably correct as history — but if it is read as current, note that `create()` now also seeds config and writes into `worktreePath`, which is precisely the gap `:47` identified ("Slot delivery and config seeding are greenfield"). Consider marking it "as of 2026-08-07, before Phase 2".

## Execution Waves

**Wave 1** — Foundations (parallel): the exclusion spike (Task 1) and the schema migration (Task 2) are independent — one is empirical git behaviour, the other is SQLite DDL.
**Wave 2** — Allocation (Task 3) needs the column from Task 2.
**Wave 3** — Release (Task 4) needs allocation to exist; seeding + surfacing (Tasks 5, 6) need both the slot and the verified exclusion mechanism.

## Goal Verification

### Truths

1. `PRAGMA table_info(worktrees)` includes a `slot` column after `runMigrations`.
2. `DB_CONSTANTS.SCHEMA_VERSION === 12` in `src/memory/types.ts`.
3. Creating two worktrees in one project yields two distinct slots, **neither of which is 0**.
4. With `maxActive: 3`, three worktrees receive slots 1, 2, 3 and the fourth fails with `MAX_ACTIVE` (not `SLOT_EXHAUSTED`).
5. Abandoning a worktree frees its slot for reuse by the next `create`.
   5b. A **`ready-to-merge`** worktree does **not** free its slot — it is still live on disk.
6. The worktree `.env` contains the allocated slot value at **every position** where `.env.example` contained `${SENTINAL_WORKTREE_SLOT}`, and contains **no unsubstituted `${` token**. (The weaker "not byte-identical to the repo-root `.env`" passes trivially when the root has no `.env` at all.)
7. Neither the seeded `.env` nor the slot env file appears in `git status` inside the worktree, **and** the main checkout's ignore behaviour is unchanged.

### Artifacts

| Artifact                          | Provides                             | Exports                             |
| --------------------------------- | ------------------------------------ | ----------------------------------- |
| `src/worktree/slots.ts`           | Slot allocation + release            | `allocateSlot`, `releaseSlot`       |
| `src/worktree/worktree-config.ts` | `.env` seeding + exclusion mechanism | `seedWorktreeConfig`                |
| `src/memory/migrations.ts`        | V12 schema (slot column + index)     | `migrateV12` (internal)             |
| `src/worktree/store.ts`           | slot persistence + active-slot query | `listActiveSlots`, updated `insert` |

**As-built deltas to the table above:**

| Artifact                          | Planned                           | As built                                                                                                                                                                                      |
| --------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/worktree/slots.ts`           | `allocateSlot`, `releaseSlot`     | `allocateSlot`, `tryAllocateSlot`, `findFreeSlot`, `insertWithSlot`, `readSlotFromWorktree`, `formatSlot`. **No `releaseSlot`** — release is emergent from the partial unique index (Task 4). |
| `src/worktree/worktree-config.ts` | seeding **+ exclusion mechanism** | seeding only (`seedWorktreeConfig`, `seedNonFatally`, `discoverSeedSources`, `interpolateSlot`, `notIsolatedWarning`)                                                                         |
| **`src/worktree/git-exclude.ts`** | _(not planned)_                   | the exclusion mechanism, split out: `excludeFromGit`, `isIgnored`, `isTracked`. Reusable by Phase 4's pidfile.                                                                                |
| `src/worktree/store.ts`           | `listActiveSlots`                 | **`listLiveSlots`** (Task 3's rename) + `assignSlot`                                                                                                                                          |

**File sizes after Tasks 5-6** (warn 400 / block 600): `manager.ts` **565**, `mcp-tools.ts` **364**, `worktree-config.ts` **364**, `git-exclude.ts` **283**. ⚠️ `src/cli/commands/worktree.ts` went **406 → 426**, crossing the 400-line _warn_ threshold (it was already over before this task). No block; flagged for a future split.

**File sizes after the spec-review fixes (2026-08-08):** `manager.ts` **582** (⚠️ 18 lines of headroom — the mismatch check was deliberately pushed into `slots.ts` as `warnIfSlotMismatch` to keep it there), `slots.ts` **402** (over _warn_, no block), `worktree-config.ts` **297** (discovery extracted), **new** `seed-sources.ts` **177**, `mcp-tools.ts` **365**, `worktree-routes.ts` **113**.

### Key Links

| From                        | To                      | Via                  | Pattern         |
| --------------------------- | ----------------------- | -------------------- | --------------- |
| `src/worktree/manager.ts`   | `src/worktree/slots.ts` | allocation on create | `allocateSlot`  |
| `src/worktree/store.ts`     | `worktrees.slot`        | persistence          | `slot`          |
| `src/memory/migrations.ts`  | `schema_version`        | V12 bump             | `VALUES \(12\)` |
| `src/worktree/mcp-tools.ts` | slot value              | tool output          | `Slot`          |

## Progress Tracking

- [x] Task 1: `.git/info/exclude` spike — GATING (Wave 1)
- [x] Task 2: Migration V12 — slot column + partial unique index (Wave 1)
- [x] Task 3: Slot allocator (Wave 2)
- [x] Task 4: Slot release across all six exit paths (Wave 3)
- [x] Task 5: Isolated config seeding (Wave 3)
- [x] Task 6: Surface slot in tools + CLI (Wave 3)

**Total Tasks:** 6 | **Completed:** 6 | **Remaining:** 0

## Implementation Tasks

### Task 1: `.git/info/exclude` spike — GATING

**Objective:** Determine empirically how to exclude Sentinal-written files from git **inside a linked worktree, without affecting the main checkout**. Tasks 5 and 6 (and Phase 4's pidfile) all depend on the answer.
**Dependencies:** None
**Wave:** 1

**Files:**

- Create: `src/worktree/worktree-exclude.test.ts` (the spike **is** the test)
- Modify: this plan file (record findings under `## Spike Findings`)

**Key Decisions / Notes:**

- In a linked worktree, `.git` is a **file** containing `gitdir: …/.git/worktrees/<name>` — there is no `.git/info/` without resolving the gitdir first.
- Git resolves `info/` through the **common-dir** path list, so a naive write to the resolved gitdir's `info/exclude` likely lands in the **main checkout's** `.git/info/exclude`. **Expect the preferred candidate to fail.**
- **Make the test self-diagnosing, not just pass/fail.** Record `git rev-parse --git-dir` and `git rev-parse --git-common-dir` inside the worktree and assert they differ; then write the pattern and assert on **both** `git check-ignore -v <file>` inside the worktree **and** the byte content of the main checkout's `.git/info/exclude`. A bare "it leaked" gives the implementer nothing to choose a fallback from.
- **Check first whether the repo's committed `.gitignore` already covers `.env`** — very common. If so, only the slot env file needs a mechanism at all, which may make this whole problem smaller.
- **Fallbacks, in order:** (a) a **worktree-local `.gitignore` that lists itself** plus the two seeded files — the standard self-ignoring trick; leaves `git status` clean with **zero** common-dir writes; (b) an already-ignored filename prefix.

**Definition of Done:**

- [x] Test asserts `--git-dir` and `--git-common-dir` differ in a linked worktree (proves the setup is real)
- [x] Test proves the chosen mechanism hides the file **inside** the worktree (`git check-ignore -v`)
- [x] Test proves the **main checkout's** `.git/info/exclude` is byte-unchanged
- [x] Recorded whether the repo's committed `.gitignore` already covers `.env` — **it does not**
- [x] Chosen mechanism recorded in `## Spike Findings`; R8 master-plan correction **reported, not applied** (master plan is owned by the orchestrator)

**Verify:**

- `bun test src/worktree/worktree-exclude.test.ts`

---

### Task 2: Migration V12 — slot column + partial unique index

**Objective:** Add `worktrees.slot` with uniqueness scoped to active worktrees of one project.
**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `src/memory/migrations.ts` (add `migrateV12`; dispatch after `:45`)
- Modify: `src/memory/types.ts` (`SCHEMA_VERSION: 11` → `12` at `:218`)
- Create: `src/memory/migrations-v12.test.ts`

**Key Decisions / Notes:**

- Copy the V11 idempotent-column pattern at `migrations.ts:56-61` (table-exists guard → `PRAGMA table_info` → conditional `ALTER TABLE` → index → version bump).
- **Uniqueness must be a partial unique index** — `ALTER TABLE ADD COLUMN` cannot carry UNIQUE. **The predicate must cover the LIVE set, not just `active`:** `CREATE UNIQUE INDEX IF NOT EXISTS idx_wt_slot_live ON worktrees(project_path, slot) WHERE status IN ('active','ready-to-merge')`. A literal `IN` list is a legal deterministic partial-index expression in SQLite. Scoping to `'active'` alone frees the slot of a live `ready-to-merge` worktree — see Context. No partial-index precedent in this file.
- **⚠️ The V11 guard pattern bumps `schema_version` unconditionally** (`migrations.ts:64`) even if its `if (tables.length > 0)` guard skipped the work. Copied verbatim, a DB could permanently record version 12 with **no slot column and no index**, and the migration can never re-run. Keep the guard for the `ALTER TABLE`, but either move `CREATE UNIQUE INDEX IF NOT EXISTS` outside it or assert the column exists before bumping.
- Pre-V12 rows get `slot = NULL`; **no backfill**. This is safe **only because SQLite treats NULLs as distinct in unique indexes** — N pre-V12 live rows with `slot = NULL` coexist. Assert it (see DoD).
- Test template: `src/memory/migrations-v11.test.ts` (temp dir, raw `new Database(path, {create:true})`, `runMigrations`, `PRAGMA table_info`, `SCHEMA_VERSION` assertion).

**Definition of Done:**

- [x] `slot` column present after migration; re-running `runMigrations` is a no-op
- [x] Partial unique index exists and **rejects** two `active` rows with the same `(project_path, slot)`
- [x] It **rejects** two `ready-to-merge` rows sharing a slot, **and** one `active` + one `ready-to-merge` sharing a slot
- [x] It **permits** the same slot when one row is terminal (`merged` / `abandoned`)
- [x] **Three `active` rows with `slot = NULL` in one project all insert successfully** — SQLite treats NULLs as distinct in unique indexes, and this is the single property that makes the no-backfill decision safe
- [x] **The version bump is not reached unless both the slot column and the index exist** (plus a partial-DB test proving the missing-table guard leaves the version at 11 so the migration retries)
- [x] `SCHEMA_VERSION === 12`
- [x] Existing `src/memory/migrations.test.ts` still passes

**Predicate mutation check (proves the `ready-to-merge` fix is load-bearing):** temporarily replacing the predicate with `WHERE status = 'active'` turns **3** V12 tests red — `creates the partial unique index over the live set` (SQL text) plus the two _behavioural_ ones, `rejects two ready-to-merge rows sharing a slot` and `rejects one active + one ready-to-merge sharing a slot`. Restored predicate: 17 pass / 0 fail.

**Collateral fix:** `src/memory/migrations-v11.test.ts` pinned the _global_ `DB_CONSTANTS.SCHEMA_VERSION` to `11` in two places. Those assertions are version-brittle by construction (every future migration breaks them), so they now assert `>= 11` / `=== DB_CONSTANTS.SCHEMA_VERSION`; the V12 suite owns the exact-value assertion.

**Verify:**

- `bun test src/memory/migrations-v12.test.ts src/memory/migrations.test.ts`

---

### Task 3: Slot allocator

**Objective:** Allocate the lowest free slot in `[1, maxActive]` per project, reserving 0 for the main checkout (D7).
**Dependencies:** Task 2
**Wave:** 2

**Files:**

- Create: `src/worktree/slots.ts`
- Create: `src/worktree/slots.test.ts`
- Modify: `src/worktree/store.ts` (add `listActiveSlots(projectPath)`; add `slot` to `RawWorktree` `:18-30`, the 9-column `insert` `:45-58`, and `deserialize` `:199-213`)
- Modify: `src/worktree/types.ts` (`Worktree` + `WorktreeSchema` `:22-36`; add `SLOT_EXHAUSTED` to `WorktreeError` `:72-79`)
- Modify: `src/worktree/manager.ts` (allocate inside the rollback envelope `:124-140`, **and** in `resolveWithReconcile`'s second insert `:348-358`)

**Key Decisions / Notes:**

- **Lazy allocation for pre-V12 rows:** master `:396` claims a null-slot live worktree is "allocated lazily on next resolve". Implement it here — when `resolveWithReconcile` returns a live row (`manager.ts:317`) whose `slot` is `null`, allocate before returning. Otherwise a pre-V12 worktree keeps `slot = null` forever and the master's claim is false.
- **⛔ Slot 0 is reserved for the developer's main checkout and is never allocated.** Range is the closed interval `[1, maxActive]`; slot 0 is **not** counted against `maxActive`, so capacity is unchanged (default 5 → slots 1-5).
- Allocator lives in `slots.ts`, **not** `manager.ts` (542/600 lines).
- Allocation must be **inside** the existing try/catch at `manager.ts:124-140` so a failed insert releases the slot.
- `resolveWithReconcile` (`:348-358`) is a second, easy-to-miss allocation site — it re-registers an on-disk worktree that lost its DB row.
- **⚠️ `resolveWithReconcile` has NO `maxActive` guard.** `create()` checks capacity at `:84-90`; the reconcile insert does not. It can therefore ask for a slot when `[1, maxActive]` is fully taken — making reconcile the **only realistic source of `SLOT_EXHAUSTED`**. It sits on the `worktree_detect` path (`mcp-tools.ts:80`), so **it must NOT throw**: a read-shaped "where is my worktree" call must not hard-fail. Return the worktree with `slot = null` plus a warning instead.
- **The control flow matters:** when the DB row exists **and** the directory exists, the method returns at `:317` without reaching the insert — there is nothing to guard there. The path that reaches `:348` is the one where `:319` just marked the old row `abandoned`, or where there was no row at all. So "reuse the prior slot" is a **deliberate lookup** of the row just abandoned, not an avoidance of double-allocation.
- Prefer reading the slot back from the worktree's **own env file** as the authoritative recovery source — that value is what the directory's seeded `.env` was written against, so any other choice hands the directory a slot contradicting its own on-disk config.
- State lives in SQLite only — sidecar handlers build a fresh manager per request.
- **⚠️ Allocate-then-insert is NOT atomic.** `listActiveSlots()` (SELECT) and `store.insert()` (INSERT) are separate statements, and the CLI (`worktree.ts:34`), MCP server (`mcp-tools.ts:48`) and sidecar all open the same DB file. Two processes can read the same lowest-free slot and both try to insert it. **Wrap allocate + insert in a single `BEGIN IMMEDIATE` transaction** — Bun's `db.transaction()` defaults to DEFERRED, so specify IMMEDIATE explicitly.
- **⛔ Do NOT map `SQLITE_CONSTRAINT` to `SLOT_EXHAUSTED`.** A constraint violation here is a **lost race** — transient, and the suggested remedy (`worktree_cleanup`) would tell the user to delete healthy worktrees to fix a condition that resolves itself. Retry the allocate+insert 2-3 times, then surface a **distinct** error. Reserve `SLOT_EXHAUSTED` for the allocator determining from **data** that no slot is free.
- Update the `makeWorktree()` fixture at `store.test.ts:13`.

**Definition of Done:**

- [x] Two worktrees in one project get distinct slots; **no worktree ever receives 0**
- [x] With `maxActive: 3` (`manager.test.ts:40-46`): slots 1, 2, 3 allocated; the 4th fails with `MAX_ACTIVE`, not `SLOT_EXHAUSTED`
- [x] Two different projects may both hold slot 1 (D2)
- [x] Failed `store.insert` releases the slot (rollback test)
- [x] **Two allocations racing on the same project produce two distinct slots, never a `SLOT_EXHAUSTED`** — see note below on how the race is staged
- [x] `resolveWithReconcile` returning an existing **live** row (`:317`) performs no allocation _when the row already has a slot_; when `slot IS NULL` (pre-V12) it allocates lazily, per the master's assumption at `:398`
- [x] `resolveWithReconcile` re-registering an on-disk worktree (`:348-358`) **reuses the slot of the row it just abandoned at `:319`** when that slot is free; allocates fresh only when there was no prior row
- [x] When no slot is free, reconcile returns `slot = null` **with a warning — it does NOT throw `SLOT_EXHAUSTED` from a detect path**
- [x] `manager.ts` stays under 600 lines — **521** (see split below)

**How the race test is staged (and what it does _not_ prove).** A genuine concurrent race cannot be staged inside the `BEGIN IMMEDIATE` transaction: a second connection writing while we hold the write lock fails with `SQLITE_BUSY`, which is the lock working correctly. The realistic sequence is that a competitor **commits before we take the lock** and our snapshot of free slots is stale, so the test does exactly that — competitor inserts from a second connection immediately before `runImmediate`, and `listLiveSlots` returns the pre-commit view. This proves the retry path and the `SLOT_RACE` (not `SLOT_EXHAUSTED`) classification deterministically. It does **not** exercise true OS-level parallelism; cross-process visibility is covered separately by a two-`MemoryStore`-on-one-file test.

**`manager.ts` split (R4).** Wiring the allocator pushed `manager.ts` to **610** lines, over the 600-line hard block. Per R4's suggestion the git helpers were extracted verbatim into two new cohesive modules with their own tests: `src/worktree/disk-scan.ts` (`listGitWorktrees`, `resolveRealPath`, `isInside`) and `src/worktree/diff-parse.ts` (`parseNumstat`). `manager.ts` is now **521**, leaving headroom for Task 5's seeding call and Phase 4.

**Deviation from the plan's Artifacts table.** The store query is named **`listLiveSlots`**, not `listActiveSlots`. Naming it "active" would directly contradict this plan's own Context section ("Define the live set once … `LIVE_WORKTREE_STATUSES`") and is precisely the `active` vs `live` confusion the phase exists to prevent. `LIVE_WORKTREE_STATUSES` is exported from `src/worktree/types.ts`.

**Second error code added beyond the plan.** `WorktreeError` gains **`SLOT_RACE`** as well as `SLOT_EXHAUSTED`, because the plan requires a "distinct error" for an exhausted retry budget and reserving `SLOT_EXHAUSTED` for a data-determined empty pool.

**Verify:**

- `bun test src/worktree/`

---

### Task 4: Prove slot release on every exit path — VERIFICATION ONLY

**Objective:** Prove a slot returns to the pool on every transition out of the **live** set, **with no code written to release it**. Release is emergent from the index predicate, not something to implement.
**Dependencies:** Task 3
**Wave:** 3

**Files:**

- Modify: `src/worktree/slots.test.ts`, `src/worktree/manager.test.ts`, `src/worktree/store.test.ts` — **tests only**

**Key Decisions / Notes:**

- **⛔ Do NOT write explicit release code.** If `slot` is a plain column and `listActiveSlots` filters on the live-status predicate, **every** exit path frees the slot automatically — including `store.delete()`, which removes the row and therefore the index entry. There is nothing to centralise in `updateStatus`.
- **Writing `SET slot = NULL` on release would be actively harmful:** it destroys the record of which slot a merged/abandoned worktree held, which is exactly what lets `resolveWithReconcile` recover a prior slot (Task 3).
- **`WorktreeStore.delete()` has ZERO production callers** — verified: every caller is a test (`manager.test.ts:380,455`, `store.test.ts:161,166`, `mcp-tools.test.ts:107`, `worktree-routes.test.ts:97`). Test it for completeness, but it is not a risk.
- If a test **disproves** the emergent-release property, only then add explicit release — do not plan for it up front.

**Definition of Done:**

- [x] One explicit test per exit path (6 total) asserting the slot is reusable afterwards: `abandon`, `squashMerge`, `cleanup`, `forceCleanupOrphans`, `resolveWithReconcile` self-heal, `store.delete()` — all in `manager.test.ts` → `describe("release is emergent — one test per exit path")`, mirrored at store level in `slots.test.ts`
- [x] **A `ready-to-merge` worktree does NOT release its slot** — asserted three ways: `listLiveSlots` still reports it, the next `create` gets slot 2, and the DB itself rejects a colliding insert
- [x] A slot freed by `abandon` is handed to the next `create`
- [x] **No production code _releases_ a slot** — the emergent-release property held; nothing was added
- [x] Full worktree suite green (170 pass with `src/sidecar/worktree-routes.test.ts`)

**⚠️ One DoD criterion was NOT satisfiable as literally written, and was narrowed deliberately.**
"**No production code writes `slot` after insert**" cannot hold alongside Task 3's own mandate (and master assumption `:398`) that a pre-V12 `slot = NULL` row is "allocated **lazily on next resolve**" — lazy allocation _is_ a write after insert. `WorktreeStore.assignSlot(id, slot)` therefore exists and is called from `WorktreeManager.ensureSlot`.

What was actually verified is the criterion's **intent**, which the surrounding notes make explicit: **no production code ever writes `slot = NULL`, i.e. nothing releases a slot.** `assignSlot` only fills a null slot; the terminal-row tests assert the slot value survives `abandon`/`squashMerge` untouched, which is what makes reconcile's slot recovery possible. Release remains purely emergent from the index predicate. `store.delete()`'s zero-production-caller status was re-confirmed and it was tested for completeness only.

**Verify:**

- `bun test src/worktree/ src/sidecar/worktree-routes.test.ts`

---

### Task 5: Isolated config seeding

**Objective:** Seed per-slot config into a new worktree so the agent never needs to copy the repo-root `.env` (D8) — the root cause of the incident's database exposure.
**Dependencies:** Task 1, Task 3
**Wave:** 3

**Files:**

- Create: `src/worktree/worktree-config.ts`
- Create: `src/worktree/worktree-config.test.ts`
- Modify: `src/worktree/manager.ts` — **call after `store.insert()` succeeds, INSIDE the rollback envelope at `:124-140`**

**Key Decisions / Notes:**

Rules, in order:

0. **⛔ NEVER overwrite an existing `.env` in the worktree.** Seeding runs at `create` **and** via `resolveWithReconcile` (`:348-358`), which operates on directories that may already carry a hand-edited `.env`. If present → skip and report.
1. Seed source discovery must handle **monorepos**: repo root **and** each workspace package root (`package.json` `workspaces`, `pnpm-workspace.yaml`). Issue #2's reporter runs "a TypeScript monorepo with a multi-app dev stack" — root-only discovery produces nothing for exactly that shape.
2. **If no `.env.example` is found → warn loudly**, never silently. Silence is what drives the agent back to copying the root `.env`.
3. If found but slot-free → seed verbatim **and state in the warning that the result is not isolated** (R11). Write this warning at a call site Phase 3 can later enrich with named resources.
4. Also write the sourceable slot env file containing `SENTINAL_WORKTREE_SLOT`.
5. Exclude both files using **Task 1's verified mechanism**.

**Definition of Done:**

- [x] Worktree `.env` is derived from `.env.example`, **not** byte-identical to the repo-root `.env` — asserted the strong form (Truth 6): every `${SENTINAL_WORKTREE_SLOT}` substituted, no placeholder left
- [x] An existing worktree `.env` is never overwritten (**three** paths tested: unit, `create` where `.env` came from HEAD, and reconcile's re-registering insert)
- [x] Monorepo layout discovers a package-level `.env.example` — `package.json` `workspaces` (array **and** `{packages:[]}`) plus `pnpm-workspace.yaml`; `node_modules` excluded
- [x] Missing `.env.example` produces a loud warning (asserts it names the _risk_, not just the absence)
- [x] Slot-free `.env.example` produces a "not isolated" warning
- [x] Neither file shows in `git status` inside the worktree; main checkout unaffected (asserted at unit level **and** through `manager.create()`)
- [x] **A slotless worktree (pre-V12, `slot = null`) skips the slot env file and warns** rather than writing `SENTINAL_WORKTREE_SLOT=null`
- [x] `manager.ts` stays under 600 lines — **565**

**Implementation notes / deviations.**

**The mechanism landed in its own module: `src/worktree/git-exclude.ts`** (`excludeFromGit`, `isIgnored`, `isTracked`), not inline in `worktree-config.ts`. The spike's tiers are git behaviour, reusable by Phase 4's pidfile, and separately testable — `git-exclude.test.ts` covers all three tiers, idempotency, the directory-scoped nested case, common-dir non-interference, and non-repo degradation.

**The governing ignore file is the one in the path's own directory**, not always the worktree root. `.sentinal/worktree.env` is therefore handled by `.sentinal/.gitignore` and never touches the root `.gitignore` — which is what makes the Sentinal-owned file excludable even when tier 3 fires for `.env`. Entries are anchored (`/<basename>`) so a directory-scoped file cannot over-ignore a package's real sources; the spike's blanket `*` was deliberately **not** adopted for arbitrary package directories.

**`create()` gained a 4th parameter, `warnings?: string[]`.** Seeding produces non-fatal warnings that must reach a human/LLM, and `create` had no channel for them. All existing call sites are unaffected (optional trailing param).

**⚠️ `WorktreeStore.delete()` now has ONE production caller.** Task 4 recorded it as having zero. Seeding runs _after_ `store.insert()` inside the rollback envelope, so a seeding I/O failure must undo the row as well as the git worktree — the catch at `manager.ts` now calls `this.store.delete(id)` (guarded). Without it the plan's own "rolling back both the worktree and the DB row" is false. Task 4's substantive claim is untouched: nothing _releases_ a slot, and no code writes `slot = NULL`.

**Read paths use `seedNonFatally`, not `seedWorktreeConfig`.** `resolveWithReconcile` and the lazy-allocation path in `ensureSlot` sit on `worktree_detect`; an I/O error there is downgraded to a warning. Only `create()` uses the throwing form, because only `create()` has a rollback envelope. The helper lives in `worktree-config.ts` rather than as a private manager method, which also kept `manager.ts` at 565 rather than 583.

**Seeding also runs on the lazy null → slot transition** (`ensureSlot`), not only at `create` and the reconcile insert. A pre-V12 directory has no `.sentinal/worktree.env`; without this it would never get one. It is bounded — the transition happens once per row.

**`.env.example` is the only filename treated as a seed source.** `.env.sample` / `.env.template` were considered and rejected as untested surface the plan does not ask for.

**Testing seam:** `SeedOptions.writeFile` exists solely to stage an I/O failure deterministically (a `chmod`-based test would pass vacuously when the suite runs as root). Production callers omit it.

**Verify:**

- `bun test src/worktree/worktree-config.test.ts` — ✅ 21 pass / 0 fail
- (also) `bun test src/worktree/git-exclude.test.ts` — ✅ 10 pass / 0 fail

---

### Task 6: Surface slot in tools + CLI

**Objective:** Expose the slot wherever a caller can act on it (D1), and state the slot-0 convention at every surface.
**Dependencies:** Task 3
**Wave:** 3

**Files:**

- Modify: `src/worktree/mcp-tools.ts` (`worktree_detect` `:86-96`, `worktree_create` `:126-135`)
- Modify: `src/cli/commands/worktree.ts` (`detect --json` `:279-288`, `create --json` `:319-326`)
- Modify: `src/index.ts` (barrel export for `slots.ts` — **append** at the end of the worktree block `:198-201`/`:220-228`; do not restructure)
- Verify: `src/sidecar/worktree-routes.ts` detect response carries `slot` (it serialises the `Worktree`, so **confirm rather than assume**) — a third consumer alongside the MCP tool and the CLI
- Modify: `src/worktree/mcp-tools.test.ts`, `src/cli/commands/worktree.test.ts`, `src/sidecar/worktree-routes.test.ts`

**Key Decisions / Notes:**

- **The MCP tools emit Markdown, not JSON** — add a `- **Slot:** N` bullet, do not change the response format.
- The CLI `--json` shapes **are** JSON — add a `slot` field there.
- State the reservation wherever the slot appears: _"slot 0 is the main checkout"_.
- Phase 3 also appends to `src/index.ts`; expect a trivial merge conflict, do not restructure the file.

**Definition of Done:**

- [x] `worktree_create` / `worktree_detect` output includes the slot — a `- **Slot:** N (slot 0 is the main checkout)` bullet in the existing Markdown
- [x] CLI `--json` output includes `slot`
- [x] Slot-0 convention documented at each surface (MCP Markdown, CLI `--json`, CLI human output)
- [x] **A null slot renders as `not assigned (pre-V12 worktree)`, never `null`** — asserted in `slots.test.ts` (`formatSlot`, incl. `undefined`) and end-to-end through `worktree_create`
- [x] Sidecar `/worktree/resolve` response carries the slot — **confirmed, not assumed**: the new `worktree-routes.test.ts` case went green with **no production change**, proving `deserialize` → `ok(wt)` already carries it
- [x] `bun test src/worktree/ src/cli/commands/worktree.test.ts` passes

**Implementation notes / deviations.**

**`--json` carries TWO fields, `slot` and `slotNote`.** JSON has nowhere to put prose, and a bare `slot: 1` leaves a consumer unable to tell whether 0 is free. `slotNote` carries `formatSlot()`'s text. Both come from one helper, `slotFields()`, so the two `--json` shapes cannot drift.

**Warnings are surfaced alongside the slot** — `worktree_create`/`worktree_detect` append a `### Warnings` section, and CLI `create --json` gains a `warnings` array (human mode writes them to **stderr** so piping stays clean). This is what makes Task 5's "warn loudly" real rather than a value returned into a void. ~~⚠️ **Known gap:** `worktree_detect` in **sidecar-client mode** surfaces no warnings.~~ **CLOSED by the spec-review fixes (2026-08-08)** — see "Post-Review Fixes" below. `/worktree/resolve` now returns `ResolvedWorktree` (`Worktree` + optional `warnings`).

**`formatSlot` already existed** (added in Task 3, unexported and untested). It is now tested and exported.

**Barrel exports** were appended at the end of the worktree block in `src/index.ts` as instructed — `slots.ts`, `worktree-config.ts`, `git-exclude.ts`, plus `LIVE_WORKTREE_STATUSES` (Task 3 added it to `types.ts` but never exported it).

**Verify:**

- `bun test src/worktree/ src/cli/commands/worktree.test.ts` — ✅ 210 pass / 0 fail
- (also) `bun test src/sidecar/worktree-routes.test.ts` — ✅ green

---

## Post-Review Fixes (2026-08-08)

_All `must_fix` and `should_fix` findings from `…-phase-2.spec-review.json`, plus the four suggestions. Every fix has a test that was confirmed RED before the implementation landed._

### 1. must_fix — `ensureSlot` was non-atomic and could throw from the detect path ✅ FIXED

`ensureSlot` did `tryAllocateSlot` (SELECT) then `store.assignSlot` (UPDATE) as two statements with **no transaction, no retry, no catch** — the identical read-then-write race `insertWithSlot` guards on the insert path. A concurrent detect raised a raw `SQLITE_CONSTRAINT_UNIQUE` out of `resolveWithReconcile`, which this plan and master D12 both state must never hard-fail for slot reasons.

- **New:** `slots.ts` → `tryAssignFreeSlot(store, id, projectPath, maxActive): { slot, warning? }` — `listLiveSlots` + `assignSlot` inside one `runImmediate` (`BEGIN IMMEDIATE`), retried `SLOT_INSERT_ATTEMPTS` times on `isSlotRace`, **never throws**. A lost retry budget degrades to `slot = null` + `slotRaceWarning` (transient wording, no `worktree_cleanup` suggestion); any non-race failure degrades to `assignFailedWarning`.
- `manager.ensureSlot` now calls it and pushes the warning; `tryAllocateSlot`/`noFreeSlotWarning` are no longer imported by `manager.ts`.
- **Tests** (`manager.test.ts` → `slots > lazy allocation is atomic (ensureSlot)`), staged like `slots.test.ts`'s lost-race test — a competitor row committed from a **second connection** plus a proxied store whose `listLiveSlots` returns the pre-commit view:
  1. _"⛔ does NOT throw when a competitor took the slot between the SELECT and the UPDATE"_ — every attempt stale → no throw, `slot = null`, warning present, row uncorrupted. **RED before the fix with `SQLiteError: UNIQUE constraint failed: worktrees.project_path, worktrees.slot`.**
  2. _"RETRIES a lost race and still assigns a distinct slot"_ — only the first attempt stale → slot 2 assigned and persisted. **RED before the fix** (the first attempt threw).

### 2. should_fix — the "SLOT_EXHAUSTED is unreachable" comment was false ✅ FIXED

Comment corrected in `manager.ts` (and in the stale `MAX_ACTIVE` test comment, and in Context for Implementer above). The branch is now covered by _"SLOT_EXHAUSTED IS reachable — ready-to-merge rows hold slots countActive does not count"_, which also asserts the rollback removed the git worktree and left no DB row.

⚠️ **This test passed on first run** — the code was already correct; what was wrong was the comment and the absence of coverage. The `MAX_ACTIVE` guard was **deliberately not** changed to count the live set: `SLOT_EXHAUSTED`'s message names merge/abandon/`worktree_cleanup`, which is the correct remedy when `ready-to-merge` rows hold the pool, whereas `MAX_ACTIVE`'s wording would be misleading there.

### 3. should_fix — sidecar-mode `worktree_detect` discarded warnings ✅ FIXED (response shape changed, additively)

**Decision: fix it.** D8's "warn loudly" and R11's not-isolated warning were unenforced on the **default** production path, which defeats the phase's stated purpose. The response-shape change is additive, so it is not the invasive kind:

- **New type** `ResolvedWorktree extends Worktree { warnings?: string[] }` (`types.ts`, exported from `src/index.ts`).
- `worktree-routes.ts` `/worktree/resolve` passes a collector into `resolveWithReconcile` and returns `{ ...wt, warnings }` — the field is **omitted when empty**, so every existing consumer (`SidecarClient`, the OpenCode plugin's `workspace-adaptor`, the CLI) is byte-compatible.
- `SidecarClient.resolveWorktreeBySlug` returns `ResolvedWorktree | null`; `mcp-tools.ts` `worktree_detect` merges `wt.warnings` into its collector, so both modes render the same `### Warnings` section.
- **Tests:** `worktree-routes.test.ts` _"carries seeding/slot WARNINGS in the response"_ (round trip, RED before), `mcp-tools.test.ts` _"worktree_detect SURFACES the warnings the sidecar computed"_ (RED before).
- **Not changed:** `worktree_diff` / `worktree_sync` / `worktree_abandon` also call `resolveWorktreeBySlug` but do not render warnings — they are action tools whose output is the action's result, and the review scoped this to `detect`.

### 4. Suggestions — all four actioned ✅

| Suggestion                                         | Fix                                                                                                                                                                                                                                                                                                                                                                                             | Test (RED first)                                                                                                                                                                          |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An unreadable `.env.example` destroys the worktree | `seedWorktreeConfig` wraps the source `readFileSync` in try/catch → `unreadableSeedWarning` + `continue`. The `write(...)` call stays unguarded, so genuine **write** failures are still fatal.                                                                                                                                                                                                 | `worktree-config.test.ts` _"treats an UNREADABLE .env.example like a missing one"_                                                                                                        |
| `formatSlot(null)` misattributes the cause         | Now `not assigned (pre-V12 record, or no free slot — see warnings)`. The "never renders the token `null`" invariant is preserved.                                                                                                                                                                                                                                                               | `slots.test.ts` ×2, `mcp-tools.test.ts` assertion updated                                                                                                                                 |
| `Bun.Glob` descends into `node_modules`            | Discovery extracted to **new `src/worktree/seed-sources.ts`**, which walks from each pattern's _literal prefix_, prunes `node_modules` and dot-dirs, caps `**` at `MAX_GLOB_DEPTH = 4`, and matches with `Bun.Glob.match()`. Also fixes a real correctness bug: one unreadable dir under `node_modules` made `scanSync` throw `EACCES`, dropping the **whole pattern** and discovering nothing. | `worktree-config.test.ts` _"does NOT descend into node_modules when expanding a `**` pattern"_ (EACCES landmine; skipped as root) + _"still finds a NESTED package under a `**` pattern"_ |
| `.env` vs `worktree.env` slot disagreement         | `resolveWithReconcile` reads the on-disk slot once and calls `warnIfSlotMismatch` (in `slots.ts`) when the assigned slot differs — names **both** numbers and two remedies.                                                                                                                                                                                                                     | `manager.test.ts` _"WARNS when the directory's own slot file disagrees…"_ (RED) + a negative case asserting no false positive                                                             |

### Collateral: the Task 5 rollback test was re-staged

`manager.test.ts` _"an I/O failure while seeding rolls back BOTH the worktree and the DB row"_ previously staged its failure with an unreadable `.env.example` — which fix 4a deliberately makes non-fatal. It now commits a **directory** at `.sentinal/worktree.env/`, so `git worktree add` checks it out and the slot-file `writeFileSync` hits `EISDIR`: a genuine **write** failure, which is the case the plan's failure semantics actually scope to "throw".

### Verify

- `bun test src/worktree/ src/memory/ src/sidecar/` — ✅ 803 pass / 0 fail
- `bunx tsc --noEmit` — ✅ clean
- `bun test` (full suite) — ✅ 1951 pass / 0 fail

### Master-plan correction requested (reported, NOT applied)

**Master `:72` (D7) repeats the false unreachability claim:** _"`create()` checks `maxActive` before allocating from the same bound, so `SLOT_EXHAUSTED` is unreachable via `create()` — it exists for the reconcile path (no capacity guard) and lost races."_ It **is** reachable from `create()`, because `countActive` counts only `'active'` while the slot pool covers the LIVE set (`'active'` + `'ready-to-merge'`) — master `:394` (R3) already states that asymmetry, so the two passages contradict each other. Suggested rewording: _"`create()` checks `maxActive` first, so `SLOT_EXHAUSTED` is reached from `create()` only when `ready-to-merge` rows hold slots that `countActive` does not count; it is otherwise raised by the reconcile path (no capacity guard) and lost races."_
