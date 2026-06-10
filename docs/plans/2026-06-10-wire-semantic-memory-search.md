# Wire Semantic Memory Search Implementation Plan

Created: 2026-06-10
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Summary

**Goal:** Make `memory_search` actually perform semantic (hybrid vector+FTS) search — the entire embeddings stack exists and is unit-tested but is never constructed in production (memory #131); the sidecar is FTS5 keyword-only.

**Architecture:** The sidecar (the single warm process owning the DB) initializes the vector stack in the background after listening: `loadCustomSqlite()` → `EmbeddingService` → `VectorStore.initialize()` → `SearchOrchestrator` → late-injected into `MemoryService` via a new `setSearchBackends()`. Native deps (`sqlite-vec` dylib, `@xenova/transformers`) cannot live inside `bun --compile` binaries, so a new resolution module tries bare imports (source runs) then `~/.sentinal/deps/node_modules` (compiled binary), provisioned by a new `sentinal memory setup` command. Missing deps are loudly surfaced (sidecar log + `memory_stats` + notification) with the exact command to run.

**Tech Stack:** bun:sqlite + sqlite-vec (vec0 virtual table), @xenova/transformers (Xenova/all-MiniLM-L6-v2, 384-dim, already cached at `~/.sentinal/models/`), FTS5 fallback.

## Scope

### In Scope

1. Runtime native-dep resolution module with deps-dir fallback (`src/memory/native-deps.ts`)
2. `sentinal memory setup` command provisioning `~/.sentinal/deps`
3. Sidecar wiring: background vector init + late inject + `loadCustomSqlite()` before DB open
4. Backfill of existing observations (~130) after vector init
5. Observability: vector status in `memory_stats`, sidecar log alerts with setup hint, one-time notification when deps missing
6. `build:cli` marks the two packages external (they are currently tree-shaken away; once imported they must NOT be bundled)

### Out of Scope

- Changing the embedding model or search strategy algorithms (hybrid/vector/fts strategies are already implemented and tested)
- OpenCode plugin / Claude hooks changes (they consume the sidecar; no API change)
- Auto-provisioning deps without user action (explicit `sentinal memory setup` per user decision)
- `sentinal memory repair` vector-index rebuild (backfill covers the gap; full rebuild is follow-up)
- Windows support (vector search degrades to FTS there; matches existing `loadCustomSqlite` posture)

## Context for Implementer

> The whole semantic stack exists; this plan only wires, provisions, backfills, and observes.

- **Patterns to follow:**
  - `MemoryService` options injection: `src/memory/service.ts:30-51` — accepts `{ store, vectorStore, orchestrator }`; index-on-save already implemented at `service.ts:68-82`, delete cleanup at `:95-101`
  - Orchestrator construction: `src/memory/search/orchestrator.ts:31-47` — checks `vectorStore.isAvailable()` **at construction time**, so it must be built AFTER `await vectorStore.initialize()`
  - Graceful degradation + `getInitError()`: `src/memory/vector-store.ts:112-122`, `src/memory/embeddings.ts:52-73`
  - Sidecar logging: `logSidecar()` from `src/utils/file-log.ts` (creates dir, rotates)
  - Memory CLI subcommand dispatch: `src/memory/cli.ts:310` switch — add `setup` case; `repair` (`cli.ts:249`) shows the report-building style
- **Key files:**
  - `src/sidecar/server.ts:224` — `new MemoryService(store)` ← the integration gap
  - `src/memory/vector-store.ts:114-115` — `await import("sqlite-vec")` + `getLoadablePath()`: works only with node_modules; must go through the new resolution module
  - `src/memory/embeddings.ts:55` — `await import("@xenova/transformers")`: same; cacheDir already `~/.sentinal/models` (`embeddings.ts:61`), model already downloaded (23MB)
  - `src/memory/vector-store.ts:73-93` — `loadCustomSqlite()`: macOS needs `Database.setCustomSQLite(Homebrew)` **before any `Database` instance is created in the process**
  - `src/memory/store.ts:586` — `getRawDb()` exposes the Database for `VectorStore`
  - `src/memory/store.ts:414` `getStats()` + `src/memory/types.ts:114` `MemoryStats` + `src/memory/mcp-tools.ts:431` `memory_stats` formatting + sidecar stats route in `src/sidecar/routes.ts`
- **Gotchas:**
  - The compiled binary currently contains ZERO transformers/sqlite-vec code (tree-shaken — verified by `grep -c` on the binary). Importing them from the sidecar graph means `build:cli` (`package.json:39`) MUST add `--external @xenova/transformers --external sqlite-vec` or bundling breaks/balloons.
  - Vector rowid scheme: `observationId * 1000 + i` (`vector-store.ts:177`) — backfill detection can query distinct `observation_id` aux column from `observation_vectors`.
  - `bunfig.toml` test preload already loads Homebrew SQLite for tests — test infra needs no change.
  - The sidecar is spawned as its own process (`sentinal sidecar start`) — `loadCustomSqlite()` must run at the top of `startSidecar()` BEFORE `opts.store ?? new MemoryStore()` (`server.ts:216`). Verify no earlier `MemoryStore` is created on the `sidecar start` CLI path (e.g. update-check) — if one is, move/skip it for this subcommand.
  - Real DB is `~/.sentinal/memory.db` (`DB_CONSTANTS`), not `sentinal.db`.
- **Domain context:** Observations = persisted memories searched by the `memory_search` MCP tool. Search flows: MCP tool → sidecar `/search`-ish route → `MemoryService.search()` → orchestrator (if set) → hybrid/vector/fts strategy.

## Runtime Environment

- **Sidecar:** `sentinal sidecar start -d` (Unix socket `~/.sentinal/sidecar.sock`); health: `curl -s --unix-socket ~/.sentinal/sidecar.sock http://localhost/health`
- **Restart:** `kill $(cat ~/.sentinal/sidecar.pid)` then start again
- **Logs:** `~/.sentinal/sidecar.log` or `sentinal sidecar logs`

## Assumptions

- Model already on disk at `~/.sentinal/models/Xenova/all-MiniLM-L6-v2` (verified, 23MB) and `env.cacheDir` already points there — supported by `embeddings.ts:61` — Tasks 3, 4 depend on this
- `MemoryService.addObservation` index-on-save works once `vectorStore` is injected — supported by `service.ts:68-82` — Task 3 depends on this
- Homebrew SQLite present on this dev machine (test preload depends on it) — Tasks 3, 6
- `bun` or `npm` available on machines running `sentinal memory setup` — sentinal is bun-first per README — Task 2
- transformers + its onnxruntime native deps work when imported from a real on-disk node_modules by a compiled bun binary — **riskiest assumption**, see Pre-Mortem #1 — Tasks 1, 6

## Testing Strategy

- **Unit:** native-deps resolution order (injectable importers), setup command (injectable spawner), `setSearchBackends`, backfill selection logic, stats extension
- **Integration:** sidecar starts with vector init (source run, real model + Homebrew sqlite available locally) → semantic paraphrase query returns expected observation
- **Manual/E2E (Task 6):** restart real sidecar; keyword-free paraphrase via `memory_search` MCP must hit; `memory_stats` shows vector status; backfill indexes all existing observations; compiled `dist/sentinal` degrades loudly without deps and works after `sentinal memory setup`

## Risks and Mitigations

| Risk                                                              | Likelihood | Impact                          | Mitigation                                                                                      |
| ----------------------------------------------------------------- | ---------- | ------------------------------- | ----------------------------------------------------------------------------------------------- |
| transformers can't load inside compiled binary even from deps dir | Medium     | Compiled binaries stay FTS-only | Graceful degrade is loud (log + stats + notification); source-run sidecar fully works; document |
| Homebrew SQLite absent on user macs                               | Medium     | Vector unavailable on macOS     | Clear status message naming `brew install sqlite`; Linux unaffected                             |
| Backfill of 130 obs ties up sidecar event loop                    | Low        | Hook latency spikes             | Batch with yields (small batches + setTimeout(0)); log progress                                 |
| Model load slow on cold start                                     | Low        | First searches FTS-only         | By design (background init); strategy visible in stats                                          |

## Pre-Mortem

_Assume this plan failed. Most likely internal reasons:_

1. **Compiled-binary import of transformers fails** (Task 1/6) → Trigger: `resolveTransformers()` from `~/.sentinal/deps` throws inside `dist/sentinal` E2E (onnxruntime `.node` loading under bun-compiled runtime). Action if hit: ship source-run support + loud degrade for binaries; file follow-up spec for a spawn-based embedding worker.
2. **`loadCustomSqlite()` runs too late** (Task 3) → Trigger: `loadExtension` fails with "not authorized" on macOS despite Homebrew sqlite installed — means some `Database` was created before `setCustomSQLite` on the sidecar path. Action: trace and move the call earlier / guard the offending early store.
3. **Late-inject race or stale orchestrator** (Task 3) → Trigger: searches after init still report `fts` strategy in stats — means the injected orchestrator isn't the instance the route handler uses (ctx captured service reference vs new object). Action: mutate the existing service via setter (never replace the service object in ctx).

## Execution Waves

**Wave 1** — Foundation (sequential): Task 1 only — every other task consumes the resolution module.
**Wave 2** — Provisioning + wiring (parallel): Task 2 (`memory setup`, files: cli.ts + new setup.ts) and Task 3 (sidecar wiring, files: server.ts, service.ts, embeddings.ts, vector-store.ts) — no file overlap.
**Wave 3** — Backfill + observability (parallel): Task 4 (backfill, files: maintenance.ts + server.ts hook point) and Task 5 (stats/alerts, files: store.ts/types.ts/mcp-tools.ts/routes.ts) — no file overlap (Task 4's server.ts touch is the single call site added by Task 3; coordinate via wave order).
**Wave 4** — Verification: Task 6.

## Goal Verification

### Truths

1. `src/sidecar/server.ts` greps for `SearchOrchestrator` and `setSearchBackends` (wiring exists)
2. `package.json` `build:cli` line greps for `--external @xenova/transformers` and `--external sqlite-vec`
3. After sidecar restart (source run): `sqlite3 ~/.sentinal/memory.db ".tables"` includes `observation_vectors` and `SELECT COUNT(DISTINCT observation_id) FROM observation_vectors` ≥ 130 (backfill ran)
4. `memory_search` with a keyword-free paraphrase ("upgrading the tool leaves old extension files behind") returns observation #124 or #130
5. `memory_stats` output contains a vector status section (e.g. `Vector Search:` with available/count or the setup hint)
6. `src/memory/cli.ts` greps for `case "setup"` (command exists)

### Artifacts

| Artifact                    | Provides                                                               | Exports                                                                       |
| --------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `src/memory/native-deps.ts` | Runtime resolution of transformers + sqlite-vec with deps-dir fallback | `resolveTransformers`, `resolveSqliteVecPath`, `nativeDepsStatus`, `DEPS_DIR` |
| `src/memory/setup.ts`       | Provisioning logic for `~/.sentinal/deps`                              | `runMemorySetup(opts)` (injectable spawner)                                   |
| `src/memory/backfill.ts`    | Index unindexed observations in batches                                | `backfillVectors(store, vectorStore, log?)`                                   |
| `src/memory/service.ts`     | Late injection of search backends                                      | `setSearchBackends(vectorStore, orchestrator)`                                |
| `src/sidecar/server.ts`     | Background vector init + inject + backfill + alerts                    | (internal `initVectorSearch`)                                                 |

### Key Links

| From                         | To                                  | Via                | Pattern                  |
| ---------------------------- | ----------------------------------- | ------------------ | ------------------------ |
| `src/sidecar/server.ts`      | `src/memory/search/orchestrator.ts` | background init    | `new SearchOrchestrator` |
| `src/sidecar/server.ts`      | `src/memory/service.ts`             | late inject        | `setSearchBackends`      |
| `src/memory/vector-store.ts` | `src/memory/native-deps.ts`         | dylib resolution   | `resolveSqliteVecPath`   |
| `src/memory/embeddings.ts`   | `src/memory/native-deps.ts`         | module resolution  | `resolveTransformers`    |
| `src/memory/cli.ts`          | `src/memory/setup.ts`               | setup subcommand   | `runMemorySetup`         |
| `src/sidecar/server.ts`      | `src/memory/backfill.ts`            | post-init backfill | `backfillVectors`        |

## Progress Tracking

- [x] Task 1: Native-dep resolution module (Wave 1)
- [x] Task 2: `sentinal memory setup` command (Wave 2)
- [x] Task 3: Sidecar vector wiring + late inject (Wave 2)
- [x] Task 4: Observation backfill (Wave 3)
- [x] Task 5: Observability — stats, log alerts, notification (Wave 3)
- [x] Task 6: Verify (Wave 4)
      **Total Tasks:** 6 | **Completed:** 6 | **Remaining:** 0

## Verification Results (Task 6)

- Full suite: 1435 pass / 0 fail; tsc clean; build:all + build:cli green
- Source-run sidecar E2E: vector init "ready", backfill **132/132 indexed in ~6s**, idempotent on restart (0 unindexed); `/ping` stayed 36-92ms during backfill
- Semantic proof: all three keyword-free paraphrases that returned nothing pre-fix now hit the right observations (#124/#130, #128, #126); strategy = hybrid
- DB truth: 132 distinct observations, 733 vectors in `observation_vectors`
- Stats: `/memory/stats` returns `vector: { status: "ready", count: 733 }`; new renderer shows `### Vector Search` section; one-time "Vector search unavailable" notification verified on the degraded binary path
- Compiled binary E2E: degrades loudly with hint + resolution details; `memory setup` provisions deps (sqlite-vec resolves OK from deps dir)

## Pre-Mortem Outcomes

- **#1 CONFIRMED:** bun --compile binaries cannot resolve node_modules for external modules' bare imports (`@huggingface/jinja` from transformers' entry fails; `createRequire` also blocked). Followed documented action: source-run fully works, binaries degrade loudly, setup output explains the limitation honestly. **Follow-up spec needed:** spawn-based embedding worker or setup-time bundling so compiled-binary sidecars get semantic search.
- **#2 partially hit (two variants found and fixed):** `memory` missing from the CLI update-check skip list AND `runCli` opening MemoryStore before the `setup` case — both poisoned `Database.setCustomSQLite()`. Fixed: `memory` added to skipCommands (src/cli/index.ts); setup/help hoisted above store creation (src/memory/cli.ts).
- **#3 avoided** (setter mutates live service; verified via stats strategy).

## Deferred Issues

- Compiled-binary semantic search (Pre-Mortem #1) — follow-up spec: spawn-based embedding worker, or `memory setup` bundling transformers into a single-file .mjs via system bun
- Production note: the OpenCode plugin auto-spawns the compiled binary sidecar — until the follow-up lands, machines relying on auto-spawn get FTS + loud degrade; a source-run sidecar (`bun <repo>/src/cli/index.ts sidecar start -d`) provides full semantic search and is currently running on this machine

## Implementation Notes (Wave 2)

- Task 3 ctx fields for Tasks 4/5: `ctx.vectorState?: VectorSearchState` — `{ status: "disabled"|"initializing"|"ready"|"unavailable", vectorStore?, orchestrator?, error? }` (exported from server.ts)
- `initVectorSearch` also awaits `embeddings.initialize()` (gates indexObservation/search availability)
- server.ts now 532 lines (>400 warn) — consider splitting `src/sidecar/vector-init.ts` after Task 4's hook lands

## Implementation Tasks

### Task 1: Native-dep resolution module

**Objective:** Single module that resolves `@xenova/transformers` and the sqlite-vec loadable path, trying bare import first (source runs) then `~/.sentinal/deps/node_modules` (compiled binary), and reports status with a remediation hint.
**Dependencies:** None
**Wave:** 1

**Files:**

- Create: `src/memory/native-deps.ts`
- Test: `src/memory/native-deps.test.ts`
- Modify: `src/memory/embeddings.ts` (use `resolveTransformers`)
- Modify: `src/memory/vector-store.ts` (use `resolveSqliteVecPath`)

**Key Decisions / Notes:**

- `DEPS_DIR = join(homedir(), ".sentinal", "deps")`; fallback import via `pathToFileURL(join(DEPS_DIR, "node_modules", "@xenova/transformers", <pkg main>))` — read the package.json `main`/`module` field rather than hardcoding the entry file
- sqlite-vec fallback path: `join(DEPS_DIR, "node_modules", "sqlite-vec-" + platformPkg(), "vec0" + ext)` where platformPkg maps `darwin-arm64|darwin-x64|linux-x64|linux-arm64` and ext is `.dylib|.so`; primary path: `(await import("sqlite-vec")).getLoadablePath()`
- Injectable importer/fs for tests (same pattern as `runPostUpdateReinstall`'s injectable spawner, `src/cli/commands/update.ts`)
- `nativeDepsStatus()` returns `{ transformers: boolean; sqliteVec: boolean; hint: string | null }` with hint `"Run: sentinal memory setup"` when anything is missing

**Definition of Done:**

- [ ] Tests cover: bare import success path, deps-dir fallback path, both-missing status with hint
- [ ] `embeddings.ts` and `vector-store.ts` no longer import the packages directly
- [ ] Existing memory tests still pass (preload supplies node_modules path)
- [ ] **Early de-risk (review finding #1):** `package.json` `build:cli` gains `--external @xenova/transformers --external sqlite-vec` in THIS task, and `bun run build:cli` is smoke-tested: the compiled `dist/sentinal` must start (`dist/sentinal --version`) and `nativeDepsStatus()` inside it must report missing-with-hint rather than crash

**Verify:**

- `bun test src/memory/native-deps.test.ts src/memory/embeddings.test.ts src/memory/vector-store.test.ts`

### Task 2: `sentinal memory setup` command

**Objective:** Provision `~/.sentinal/deps` with the two packages so compiled binaries get vector search.
**Dependencies:** Task 1
**Wave:** 2

**Files:**

- Create: `src/memory/setup.ts`
- Test: `src/memory/setup.test.ts`
- Modify: `src/memory/cli.ts` (add `setup` case + help text)

**Key Decisions / Notes:**

- Write `~/.sentinal/deps/package.json` (`{"private": true}`), then spawn the first available of `bun add sqlite-vec@<ver> @xenova/transformers@<ver>` / `npm install --prefix` — pin versions matching root `package.json` to avoid drift
- After install, call `nativeDepsStatus()` and print result; exit non-zero if still unavailable
- Injectable spawner for tests; report style mirrors `repair` (`cli.ts:249`)
- Mention macOS Homebrew sqlite requirement in output when on darwin and `loadCustomSqlite()` fails
- **OS matrix:** Linux x64/arm64 fully supported with no extra prerequisites (system SQLite loads extensions; `vec0.so` from `sqlite-vec-linux-*`); macOS needs Homebrew SQLite (detected + messaged); Windows out of scope (no Windows release binaries exist). Platform map mirrors `getAssetName()` in `src/cli/commands/update.ts:67-77`

**Definition of Done:**

- [ ] `sentinal memory setup` (from source) completes and `nativeDepsStatus()` reports both available
- [ ] Failure modes (no bun/npm, install fails) produce actionable messages, non-zero exit
- [ ] Tests cover spawner selection, success, failure

**Verify:**

- `bun test src/memory/setup.test.ts`

### Task 3: Sidecar vector wiring + late inject

**Objective:** Sidecar initializes the vector stack in the background after listening and injects it into the live `MemoryService`; missing deps are loudly logged with the setup hint.
**Dependencies:** Task 1
**Wave:** 2

**Files:**

- Modify: `src/sidecar/server.ts` (loadCustomSqlite before store creation at :216; background `initVectorSearch()` after listen)
- Modify: `src/memory/service.ts` (add `setSearchBackends(vectorStore, orchestrator)`)
- Test: `src/sidecar/server.test.ts` (init + inject path), `src/memory/service.test.ts` (setter)

**Key Decisions / Notes:**

- `loadCustomSqlite()` (vector-store.ts:73) at top of `startSidecar()` BEFORE `opts.store ?? new MemoryStore()` (server.ts:223) — verify nothing earlier on the `sidecar start` CLI path opens a Database
- Background init (fire-and-forget, never blocks listen): create `EmbeddingService` → `new VectorStore(store.getRawDb(), embeddings)` → `await initialize()` → if available, `new SearchOrchestrator(store, vectorStore)` + `ctx.service.setSearchBackends(...)`; else `logSidecar` the init errors + `nativeDepsStatus().hint`
- Mutate the existing service instance (Pre-Mortem #3) — routes capture `ctx.service`
- Gate on new `opts.enableVectorSearch ?? true`; tests pass `false` to avoid model loads (keeps the 27ms test budget)
- **Subprocess guard (review finding #2):** ALSO honor env `SENTINAL_DISABLE_VECTOR_SEARCH=1` — subprocess-spawned sidecars in tests (e.g. CLI wiring tests) don't pass options and must not load the model or backfill against the real `~/.sentinal/memory.db`. Set this env in any test that spawns the sidecar/CLI as a subprocess

**Definition of Done:**

- [ ] Source-run sidecar logs `vector search ready (N vectors)` or a degrade reason with hint
- [ ] `service.search()` uses hybrid strategy after init (assert via orchestrator `getStrategyName`)
- [ ] Existing sidecar tests unaffected (vector init disabled in test options)

**Verify:**

- `bun test src/sidecar/server.test.ts src/memory/service.test.ts`

### Task 4: Observation backfill

**Objective:** After vector init, index all observations missing vectors, in small batches that don't starve the event loop.
**Dependencies:** Task 3
**Wave:** 3

**Files:**

- Create: `src/memory/backfill.ts`
- Test: `src/memory/backfill.test.ts`
- Modify: `src/sidecar/server.ts` (call after successful init — single line at the Task 3 hook point)

**Key Decisions / Notes:**

- Unindexed = `SELECT id FROM observations WHERE id NOT IN (SELECT DISTINCT observation_id FROM observation_vectors)` — vec0 aux-column DISTINCT is a less-trodden path (review suggestion): cover with a test; if it misbehaves, fall back to deriving observation IDs from `rowid / 1000`
- **One observation at a time** with `await new Promise(r => setTimeout(r, 25))` between each (review finding #3: a 5-obs batch ≈ 15 embeddings can block >100ms and starve hook routes); `logSidecar` start/end with counts
- Idempotent (re-running indexes nothing when complete); duplicate rowid inserts already skipped (`vector-store.ts:191`)

**Definition of Done:**

- [ ] Backfill indexes only missing observations; second run is a no-op
- [ ] Progress logged with counts
- [ ] Sidecar `/ping` stays responsive (<100ms) while a backfill is in flight (integration assertion or manual timing in Task 6)

**Verify:**

- `bun test src/memory/backfill.test.ts`

### Task 5: Observability — stats, alerts, notification

**Objective:** Make vector availability visible: `memory_stats` shows status/count/error + setup hint; sidecar creates a one-time notification when deps are missing.
**Dependencies:** Task 3
**Wave:** 3

**Files:**

- Modify: `src/memory/types.ts` (`MemoryStats` + `vector?: { available, count, initError, hint }`)
- Modify: `src/memory/service.ts` or `src/memory/store.ts` (stats assembly — service knows the vectorStore)
- Modify: `src/memory/mcp-tools.ts` (render vector section in `memory_stats`)
- Modify: `src/sidecar/routes.ts` (stats route returns extended stats; notification insert on degraded init — reuse existing notifications table via `ctx.store`)
- Test: `src/memory/mcp-tools.test.ts`, `src/sidecar/routes.test.ts` (or nearest existing suites)

**Key Decisions / Notes:**

- Stats must work in all three states: vector ready (show count), initializing (show "initializing"), unavailable (show initError + `Run: sentinal memory setup`)
- One-time notification: settings key `vector_deps_notified_<version>` to avoid spamming per restart

**Definition of Done:**

- [ ] `memory_stats` MCP output contains a `Vector Search` section in every state
- [ ] Degraded init inserts exactly one notification per version

**Verify:**

- `bun test src/memory/mcp-tools.test.ts src/sidecar/`

### Task 6: Verify

**Objective:** Full-suite + build + live E2E proof of semantic search.
**Dependencies:** Tasks 1-5
**Wave:** 4

**Files:** none (verification only; `package.json` `build:cli` externals land here if not already in Task 1)

**Definition of Done / Verify:**

- [ ] `bun test` green; `bunx tsc --noEmit` clean
- [ ] `package.json` `build:cli` includes `--external @xenova/transformers --external sqlite-vec`; `bun run build:all && bun run build:cli` succeed
- [ ] Restart sidecar (source or binary+deps): log shows vector ready; `sqlite3 ~/.sentinal/memory.db "SELECT COUNT(DISTINCT observation_id) FROM observation_vectors"` ≥ 130
- [ ] Keyword-free paraphrase ("upgrading the tool leaves old extension files behind") via `memory_search` returns obs #124/#130
- [ ] `memory_stats` shows vector section
- [ ] Compiled `dist/sentinal` without deps: sidecar log shows hint + notification; after `sentinal memory setup`: vector ready (or Pre-Mortem #1 documented + follow-up filed)
