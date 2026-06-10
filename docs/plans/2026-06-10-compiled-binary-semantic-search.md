# Compiled-Binary Semantic Search (Setup-Time Bundling) Implementation Plan

Created: 2026-06-10
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Summary

**Goal:** Semantic vector search works in compiled sentinal binaries (the default install) with zero required user action — closing the gap left by 2026-06-10-wire-semantic-memory-search (compiled bins degrade to FTS because `bun --compile` can't resolve node_modules for external modules' bare imports).

**Architecture:** `sentinal memory setup` gains a bundling step: it flattens `@xenova/transformers` into a single self-contained `~/.sentinal/deps/bundle/transformers.bundle.mjs` (sharp stubbed — text pipelines never need image support) and copies `onnxruntime-node/bin` to the sibling `~/.sentinal/deps/bin/` so the bundle's relative native require resolves on disk. `native-deps.ts` gains a bundle-import fallback that works inside compiled binaries. Provisioning is fully automatic: install/update run setup as a visible non-fatal step, and a vector-degraded sidecar self-heals by spawning setup in the background and re-initializing on success.

**Tech Stack:** Bun.build (plugin API, primary bundler via system bun) / npx esbuild CLI (fallback: `--alias:sharp=<stub> --external:*.node` + createRequire banner), onnxruntime-node native backend, existing vector stack.

**SPIKE-PROVEN (all in /var/folders/.../spike-bundle, 2026-06-10):** a compiled test binary imported both bundle variants by file URL and produced identical 384-dim embeddings (`first: 0.0668`). Residual bare imports in the bundle are Node builtins only (fs, path, crypto, worker_threads...) which compiled bins resolve natively. Critical details proven: (1) sharp must be aliased to a stub or its loader throws eagerly; (2) the `.node` requires must stay EXTERNAL with the `bin/` tree copied as a sibling — esbuild's `--loader:.node=copy` breaks `@rpath/libonnxruntime.dylib` resolution; (3) esbuild's ESM output needs the createRequire banner.

## Scope

### In Scope

1. Bundle builder inside `memory setup` (bun primary, esbuild fallback) + idempotency (fast no-op when provisioned)
2. `native-deps.ts` bundle-import resolution path (compiled-binary compatible)
3. Auto-setup at install + update (visible, non-fatal, env opt-out)
4. Sidecar self-heal: degraded init with missing deps → background setup spawn → re-init + success notification
5. E2E: compiled binary full cycle degrade → auto-provision → semantic search

### Out of Scope

- Image/audio pipelines (sharp stays stubbed; feature-extraction only)
- Brew-installing SQLite on macOS (still a prerequisite for vec0 loading; existing message stands)
- Windows (no release binaries exist)
- Changing the embedding model or bundling the model weights (downloaded by transformers on first embed to `~/.sentinal/models`, already wired)

## Context for Implementer

- **Patterns to follow:**
  - Injectable spawner: `src/memory/setup.ts` (`runMemorySetup` opts) and `src/cli/commands/update.ts` (`runPostUpdateReinstall`)
  - Resolution chain with error capture: `src/memory/native-deps.ts` (`resolveTransformers`, `ResolveOptions.errors`)
  - Degrade handling + state: `src/sidecar/vector-init.ts` (`initVectorSearch`, `markVectorUnavailable`, `ctx.vectorState`)
  - One-time guards via settings keys: `src/sidecar/vector-stats.ts` (`VECTOR_DEPS_NOTIFIED_KEY`)
- **Key files:**
  - `src/memory/setup.ts` — install flow; bundling step slots after the install + before status verification
  - `src/memory/native-deps.ts` — `DEPS_DIR`, `resolveTransformers` (add bundle path between bare import and node_modules entry — the bundle is the only variant that works in compiled bins)
  - `src/sidecar/vector-init.ts` — degrade path for self-heal hook; `InitVectorSearchDeps` for test injection
  - `src/cli/commands/install.ts` (`installClaudeCode`/`installOpenCode`), `src/cli/commands/update.ts` (`--reinstall-plugins` mode) — auto-setup call sites
  - `src/cli/commands/update.ts:36-37` — `BIN_DIR`/`BIN_PATH` for the self-heal spawn target
- **Exact spike recipes (copy these):**
  - Bun: script using `Bun.build({ entrypoints: [<deps>/node_modules/@xenova/transformers/src/transformers.js], target: "node", format: "esm", plugins: [stub plugin: onResolve /^sharp$/ → namespace stub; onLoad → "export default null;"] })`, written to a temp file and spawned via system `bun` (compiled binaries cannot run Bun.build in-process — they'd need the bundler at runtime; ALWAYS spawn)
  - esbuild: `npx -y esbuild <entry> --bundle --format=esm --platform=node --alias:sharp=<stubfile> --external:*.node "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" --outfile=<out>`
  - Native layout: `cp -R <deps>/node_modules/onnxruntime-node/bin <deps>/bin` — the bundle at `<deps>/bundle/transformers.bundle.mjs` requires `../bin/napi-v3/<platform>/<arch>/onnxruntime_binding.node`
- **Gotchas:**
  - Bundle MUST live one directory below deps root (`<deps>/bundle/`) for the `../bin/` relative require to land on `<deps>/bin/`
  - sharp stub must default-export null (`export default null;`) — transformers does `(await import('sharp')).default`
  - `memory` is in the CLI update-check skip list and setup is hoisted above MemoryStore creation (both required for `setCustomSQLite`) — do not regress
  - Setup runs on EVERY install/update once Task 2 lands — idempotency (skip install when versions match, skip bundle when fresh) is a hard requirement, not an optimization
  - Self-heal must only trigger for missing-deps degrades, never for Homebrew-SQLite-missing on macOS (setup can't fix that)
  - Subprocess tests: set `SENTINAL_DISABLE_VECTOR_SEARCH=1` / `SENTINAL_NO_AUTO_SETUP=1` to avoid model loads and surprise installs

## Runtime Environment

- Sidecar: `sentinal sidecar start -d` (compiled) or `bun src/cli/index.ts sidecar start -d` (source); health via `curl -s --unix-socket ~/.sentinal/sidecar.sock http://localhost/health`
- Logs: `sentinal sidecar logs` / `~/.sentinal/sidecar.log`
- Current machine state: `~/.sentinal/deps` populated from the prior spec's setup; model at `~/.sentinal/models`; source sidecar running with 737 vectors

## Assumptions

- Spike results hold for the real `runMemorySetup` integration (same inputs, same machine) — Tasks 1, 4
- `onnxruntime-node/bin` tree (~50MB all platforms; per-platform subset viable later) copies cleanly — Task 1
- System `bun` or `npx` available wherever auto-setup runs (bun is a sentinal prerequisite; npx ships with npm) — Tasks 1, 2, 3
- Self-heal spawn target is `process.execPath` with compiled-ness detection (`typeof __SENTINAL_VERSION__ !== "undefined"` — only build-time defines set it); self-heal is skipped in source runs. NEVER spawn BIN_PATH: it can hold an OLDER binary than the running sidecar, which would provision stale pinned versions and permanently fail freshness (review finding #1; the memory #124 class of bug) — Task 3
- Model auto-downloads on first embed when absent (env.allowRemoteModels already true) — Task 4 fresh-machine path

## Testing Strategy

- **Unit:** bundle builder (injectable spawners — assert bun-first/esbuild-fallback command lines, layout creation), native-deps bundle resolution order, setup idempotency, self-heal gating (once-only, missing-deps-only, env opt-out)
- **Integration:** real bundle build via system bun in a temp deps dir (slow test, explicit timeout per `sentinal-test-timing`), import + embed smoke under bun
- **E2E (Task 4):** compiled `dist/sentinal`: wipe `<tmp test HOME>` deps → binary sidecar starts degraded → self-heal provisions → re-init → `vector search ready` → semantic query correct; plus install/update visible-step check

## Risks and Mitigations

| Risk                                                                                              | Likelihood | Impact                                  | Mitigation                                                                                                                        |
| ------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| transformers/onnxruntime version bump changes internal layout (entry path, bin tree, sharp usage) | Medium     | Bundle build breaks on future setups    | Versions pinned from root package.json (existing setup behavior); bundle build verifies with an import+embed smoke after building |
| Self-heal loops (setup succeeds but init still fails)                                             | Low        | Repeated 150MB installs                 | Once-per-process guard + settings-key backoff; only re-init once                                                                  |
| Auto-setup network cost surprises users                                                           | Medium     | ~150MB on first install/update          | Visible step with sizes printed; `SENTINAL_NO_AUTO_SETUP=1` opt-out; fast no-op when provisioned                                  |
| Backfill+model download on fresh machines delays first semantic results                           | Low        | Minutes of FTS-only after first install | By design (background); status visible in memory_stats                                                                            |

## Pre-Mortem

1. **Bundle smoke passes under bun but compiled binary still fails** (Task 1/4) → Trigger: E2E binary logs transformers error despite fresh bundle. The spike proved the import path, but the REAL flow adds EmbeddingService config — if it sets env fields the bundle's env object lacks, init throws. Action: assert env surface in the smoke test; keep `ResolveOptions.errors` verbose.
2. **Auto-setup at install runs inside the OLD binary during update** (Task 2) → Trigger: update path provisions with old pinned versions then new binary re-bundles every time (idempotency thrash). Action: setup invoked from the `--reinstall-plugins` mode only (new binary), never the pre-swap process; bundle freshness check compares against installed package version, not mtime alone.
3. **Self-heal spawn storms on permanently-broken machines** (Task 3) → Trigger: every sidecar restart spawns a doomed 150MB install attempt. Action: settings-key backoff (`vector_autosetup_attempted_<version>`) — one attempt per version, manual `sentinal memory setup` always available.

## Execution Waves

**Wave 1** — Task 1 (bundle builder + resolution + idempotency): foundation everything consumes.
**Wave 2** — Task 2 (auto-setup at install/update) ∥ Task 3 (sidecar self-heal): disjoint files (install/update commands vs vector-init/self-heal helper).
**Wave 3** — Task 4 (verify).

## Goal Verification

### Truths

1. `src/memory/setup-bundle.ts` exists and `src/memory/setup.ts` greps `buildTransformersBundle`
2. `src/memory/native-deps.ts` greps `bundle/transformers.bundle.mjs` (resolution path)
3. After `dist/sentinal memory setup`: `~/.sentinal/deps/bundle/transformers.bundle.mjs` and `~/.sentinal/deps/bin/napi-v3` exist; setup re-run completes <2s (idempotent no-op)
4. Compiled-binary sidecar logs `vector search ready` and a keyword-free semantic query via memory_search returns the expected observation
5. `src/cli/commands/install.ts` and the update `--reinstall-plugins` path grep a `runMemorySetup`/auto-setup invocation
6. Degraded init with missing deps spawns self-heal setup exactly once (test assertion); `SENTINAL_NO_AUTO_SETUP=1` suppresses it

### Artifacts

| Artifact                                                  | Provides                                                                         | Exports                                                |
| --------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `src/memory/setup-bundle.ts`                              | Bundle build (bun→esbuild fallback), bin-tree copy, freshness check, embed smoke | `buildTransformersBundle`, `isBundleFresh`             |
| `src/memory/native-deps.ts`                               | Bundle-import resolution between bare and node_modules paths                     | `resolveTransformers` (extended), `BUNDLE_PATH` helper |
| `src/memory/setup.ts`                                     | Bundling step in setup + idempotent fast path                                    | `runMemorySetup` (extended)                            |
| `src/sidecar/vector-init.ts` + `src/sidecar/self-heal.ts` | Degrade-triggered background auto-setup + re-init                                | `maybeSelfHealVectorDeps`                              |
| `src/cli/commands/install.ts` / `update.ts`               | Auto-setup at install/update                                                     | (wiring)                                               |

### Key Links

| From                          | To                           | Via                    | Pattern                            |
| ----------------------------- | ---------------------------- | ---------------------- | ---------------------------------- |
| `src/memory/setup.ts`         | `src/memory/setup-bundle.ts` | bundling step          | `buildTransformersBundle`          |
| `src/memory/native-deps.ts`   | deps bundle                  | file-URL import        | `bundle/transformers\.bundle\.mjs` |
| `src/sidecar/vector-init.ts`  | `src/sidecar/self-heal.ts`   | degrade hook           | `maybeSelfHealVectorDeps`          |
| `src/cli/commands/update.ts`  | `src/memory/setup.ts`        | reinstall-plugins mode | `runMemorySetup\|memory.*setup`    |
| `src/cli/commands/install.ts` | `src/memory/setup.ts`        | install step           | `runMemorySetup\|memory.*setup`    |

## Progress Tracking

- [x] Task 1: Bundle builder + resolution + idempotency (Wave 1)
- [x] Task 2: Auto-setup at install/update (Wave 2)
- [x] Task 3: Sidecar self-heal (Wave 2)
- [x] Task 4: Verify (Wave 3)
      **Total Tasks:** 4 | **Completed:** 4 | **Remaining:** 0

## Verification Results (Task 4)

- Full suite: 1472 pass / 0 fail; tsc clean; build:all + build:cli green
- Truth 3: `dist/sentinal memory setup` (compiled, cwd /tmp) → bundle + bin/napi-v3 layout, "Setup complete" in 2.07s; re-run "Already provisioned" in **0.11s**
- Truth 4: compiled-binary sidecar → `vector search ready (752 vectors)`; `memory_stats` vector `status: ready`; semantic paraphrase ("old memories retrieved by meaning rather than matching words") → obs #131 through the compiled binary
- Self-heal E2E (deps hidden + backoff cleared): degrade 10:10:31 → "attempting automatic setup" → ready 10:10:34 + "automatic setup succeeded" + "Semantic search enabled" notification — **zero-touch cycle proven live in 3s**
- Truths 1/2/5/6: artifacts + wiring verified by unit/integration tests (setup-bundle 8, self-heal 11, auto-setup 5+3+1 suites)

## Implementation Tasks

### Task 1: Bundle builder + resolution + idempotency

**Objective:** `memory setup` produces a compiled-binary-loadable transformers bundle; `native-deps` resolves it; repeat setups are fast no-ops.
**Dependencies:** None
**Wave:** 1

**Files:**

- Create: `src/memory/setup-bundle.ts`, `src/memory/setup-bundle.test.ts`
- Modify: `src/memory/setup.ts` (bundling step + skip-when-fresh install short-circuit), `src/memory/native-deps.ts` (+ bundle path in `resolveTransformers`, errors captured), `src/memory/setup.test.ts`, `src/memory/native-deps.test.ts`

**Key Decisions / Notes:**

- `buildTransformersBundle({ depsDir, spawner })`: write bun build script (embedded template string) to `<depsDir>/.build-bundle.ts` → spawn `bun <script>`; on bun-missing/non-zero → esbuild CLI fallback (exact flags in Context). Then `cp -R onnxruntime-node/bin <depsDir>/bin`, write `<depsDir>/bundle/.bundle-meta.json` ({ transformersVersion, builtAt, bundler }).
- `isBundleFresh(depsDir)`: bundle exists AND meta.transformersVersion === installed package version.
- **Concurrency lock (review finding #2):** `runMemorySetup` acquires `<depsDir>/.setup.lock` (writes PID; treats locks older than 10 min as stale). A concurrent runner (install foreground vs sidecar self-heal background) skips with "setup already running (pid N)" — freshness only protects against COMPLETED runs, not in-flight overlap.
- Post-build smoke: spawn `bun -e "import(<bundle>).then(m => m.pipeline ? process.exit(0) : process.exit(1))"` (cheap import check; full embed smoke only in integration test).
- `resolveTransformers` order: bare import → **bundle file URL** → node_modules entry. Bundle errors go into `errors` with prefix `transformers bundle import:`.
- Setup install short-circuit: when `nativeDepsStatus` reports both available AND `isBundleFresh` → print "already provisioned" and return ok fast.

**Definition of Done:**

- [ ] Unit tests: bun-first command assembly, esbuild fallback assembly, bin copy, meta write, freshness logic, resolution order, fast no-op
- [ ] Integration test (explicit 120s timeout): real bundle in tmp deps dir via system bun; import smoke passes
- [ ] `bun test src/memory/` green; tsc clean

**Verify:**

- `bun test src/memory/setup-bundle.test.ts src/memory/native-deps.test.ts src/memory/setup.test.ts`

### Task 2: Auto-setup at install/update

**Objective:** Fresh installs and updates provision semantic search automatically as a visible, non-fatal step.
**Dependencies:** Task 1
**Wave:** 2

**Files:**

- Modify: `src/cli/commands/install.ts` (in the `install` COMMAND ACTION only — after install steps complete), `src/cli/commands/update.ts` (in the `--reinstall-plugins` MODE only — executes in the NEW binary per Pre-Mortem #2)
- Test: `src/cli/commands/update.test.ts`, install-side test in nearest existing suite

**Key Decisions / Notes:**

- **⛔ Dispatcher-level wiring only (review finding #3):** do NOT call setup inside `installClaudeCode()`/`installOpenCode()` — the update reinstall mode calls both functions (update.ts:383/398), which would triple-run setup per update. Exactly one setup call per user-facing command: once in the `install` action, once in the `--reinstall-plugins` mode after both reinstalls.
- Honor `SENTINAL_NO_AUTO_SETUP=1` (skip with one log line). Failures print the manual command and continue (never fail an install for semantic search).
- Idempotency + lock from Task 1 make repeat/concurrent runs safe and ~free.
- Audit existing subprocess-spawning tests (hook.test.ts CLI wiring, sidecar lifecycle) and set `SENTINAL_NO_AUTO_SETUP=1` where they exercise install/update paths (review suggestion).

**Definition of Done:**

- [ ] Tests: install invokes setup (mockable seam), update reinstall mode invokes setup, opt-out env respected, failure non-fatal
- [ ] `sentinal install opencode` from source visibly runs the (no-op) setup step

**Verify:**

- `bun test src/cli/commands/update.test.ts src/cli/`

### Task 3: Sidecar self-heal

**Objective:** A vector-degraded sidecar with missing deps provisions itself in the background and re-initializes — zero user action.
**Dependencies:** Task 1
**Wave:** 2

**Files:**

- Create: `src/sidecar/self-heal.ts`, `src/sidecar/self-heal.test.ts`
- Modify: `src/sidecar/vector-init.ts` (call `maybeSelfHealVectorDeps` from the degrade path)

**Key Decisions / Notes:**

- `maybeSelfHealVectorDeps(ctx, state, opts)`: gate on (a) degrade errors indicating missing deps (`SETUP_HINT` present / errors mention "not available"), NOT Homebrew-sqlite failures; (b) `SENTINAL_NO_AUTO_SETUP` unset; (c) settings-key backoff `vector_autosetup_attempted_<version>` unset — **written at attempt START, not completion** (Pre-Mortem #3 / review suggestion: a crashed attempt must not retry-loop); (d) running as a compiled binary (`typeof __SENTINAL_VERSION__ !== "undefined"`); spawn target is **`process.execPath`** (the running binary itself — NEVER BIN_PATH, which can be older; review finding #1).
- Spawn `process.execPath memory setup` detached with output to sidecar log; on exit 0 → `initVectorSearch(ctx)` again (single retry) → success log + notification "Semantic search enabled" (insertNotification, type info).
- Injectable spawner + initRetry for tests.

**Definition of Done:**

- [ ] Tests: triggers once on missing-deps degrade; backoff key prevents repeats; env opt-out; non-deps degrade (e.g. extension load error w/o hint) does NOT trigger; success path re-inits + notifies
- [ ] `bun test src/sidecar/` green

**Verify:**

- `bun test src/sidecar/self-heal.test.ts src/sidecar/server.test.ts`

### Task 4: Verify

**Objective:** Full-suite + builds + compiled-binary E2E of the complete zero-touch cycle.
**Dependencies:** Tasks 1-3
**Wave:** 3

**Definition of Done / Verify:**

- [ ] `bun test` green; `bunx tsc --noEmit` clean; `bun run build:all && bun run build:cli` green
- [ ] Truth 3: `dist/sentinal memory setup` produces bundle + bin layout; re-run <2s
- [ ] Truth 4: compiled-binary sidecar reaches `vector search ready`; keyword-free paraphrase returns expected observation through it
- [ ] Self-heal E2E: with deps renamed away + backoff key cleared, compiled-binary sidecar degrade → auto-setup → ready (or honest documented failure)
- [ ] memory_stats reflects ready state via the compiled binary
