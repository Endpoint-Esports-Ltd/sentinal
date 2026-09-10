# Audit High-Severity Remediation Implementation Plan

Created: 2026-09-01
Status: VERIFIED
Approved: Yes
Iterations: 1
Worktree: Yes
Type: Feature

## Summary

**Goal:** Fix the 10 verified findings from the v1.36.1 codebase audit (memory #610): 1 CRITICAL (the OpenCode plugin's dead after-hook), 8 HIGH, and the newly found instructions-loaded memory spam (H9).

**Architecture:** All fixes are in `src/` and `targets/opencode/plugins/` — **no shipped command/rule prose changes, so no parity-baseline regeneration anywhere in this plan.** Two waves of file-disjoint tasks. One pre-requisite split (`memory/store.ts` is 836 lines, over the 600 hard block, and H6 must edit it).

**Tech Stack:** TypeScript (strict), Bun + `bun test`, zod 4, `@modelcontextprotocol/sdk`, `@opencode-ai/plugin`.

## Scope

### In Scope

| ID | Finding | Site |
| --- | --- | --- |
| C1 | OpenCode `tool.execute.after` reads `output.args` (doesn't exist) — quality gate, TDD tracking, memory capture all dead on OpenCode | `targets/opencode/plugins/sentinal.ts:509,640,657-659,671` + wrong local `.d.ts` |
| H1 | MCP cleanup kills the shared sidecar unconditionally in production; signal handlers never exit | `src/mcp/server.ts:84-98` |
| H2 | `spec_metrics` always "No spec found." under the sidecar — no timing route exists | `src/spec/events-mcp-tools.ts:129,150-153` |
| H3 | `squashMerge` commits the user's unrelated staged changes; never restores the original branch | `src/worktree/manager.ts:245-251` |
| H4 | `resolveBySlug` global cross-project fallback + unanchored LIKE | `src/worktree/store.ts:226-247` |
| H5 | No PID start-time verification — recycled PID passes ownership | `src/runtime/ownership.ts:181-203`, `pidfile.ts` |
| H6 | Tests write to the real user DB — no env seam in `getDbPath()`/sidecar paths | `src/memory/store.ts:43-49`, `src/sidecar/paths.ts` |
| H7 | `configureStatusline` wipes `~/.claude/settings.json` on parse failure | `src/cli/commands/install-claude.ts:258-283` |
| H8 | Quality-check wedge → permanent 429; `SidecarClient` has no request timeouts | `src/sidecar/quality-routes.ts:112-115`, `client.ts:238-263` |
| H9 | `instructions-loaded` hook saves an undeduplicated `discovery` observation per session — pollutes memory and dilutes search | `src/hooks/instructions-loaded.ts:44-53` |

Plus, riding along in files already in scope: the plugin's dead `fetch` hint (OpenCode's tool is `webfetch`) and `multiedit` missing from `QUALITY_TOOLS` (both 1-line, both in C1's file).

### Out of Scope

- **All MEDIUM/LOW audit findings not listed above** (dashboard CORS, plan-parser fences, update permission reverts, LSP re-rooting, binary checksum, dispatcher/hook drift, observation-queue locking, …). Recorded in memory #610; they get their own passes.
- **Known open issues #3, #4, #5, #6** — separate work. (H5 narrows part of #5's blast radius but does not close it.)
- Splitting `src/cli/commands/uninstall.ts` (691) — not touched by any task here.
- Any change to risk scoring, thresholds, or reach semantics.

## Context for Implementer

> Written for someone who has never seen this codebase.

**Verified design facts (checked in this session, not assumed):**

1. **C1 is handler-position-sensitive.** Per the installed `@opencode-ai/plugin` types: the **before**-hook receives writable `output.args` (that is its API for rewriting args); the **after**-hook receives `args` on **`input`**, and its `output` is `{title, output, metadata}`. So `sentinal.ts:453` (before-handler) may be CORRECT while `:509,640,657-659,671` (after-handler) are broken. **Fix by handler, not by grep-and-replace.** The repo's hand-written `targets/opencode/types/opencode-plugin.d.ts:113-115,164-167` codifies the wrong after-shape — fix it too, or tsc will fight the correct code.
2. **H1's ingredients already exist.** `SidecarClient.getActiveSessions()` → `GET /session/active` (`client-routes.ts:61`, `routes.ts:59`). `stopSidecarProcess()` is **sync** (`lifecycle.ts:183`). Signal handlers may be async and then `process.exit()`; the `exit`-event handler must stay sync. The sidecar also has its own session-aware idle shutdown (`server.ts:196-247`) — the simplest correct fix is: **in client mode, the MCP server never stops the sidecar at all** and relies on the sidecar's own lifecycle; in direct-store mode keep today's check. Signal handlers must re-raise/exit after cleanup.
3. **H6 is blocked until `store.ts` is split.** `src/memory/store.ts` is **836 lines — over the 600 hard block**; the file-length hook refuses edits. A dead, divergent `getDbPath` duplicate already exists at `src/memory/config.ts:37-59` (implements the documented `CLAUDE_PLUGIN_DATA` relocation; nothing imports it). The split should extract path resolution into one small module that becomes the single source of truth, absorbing/deleting the dead duplicate. All 41 `new MemoryStore()` default constructions funnel through `getDbPath()`, so one env seam covers everything. `src/memory/test-preload.ts` (11 lines) is preloaded for **every** `bun test` run via `bunfig.toml` — the natural place to set the override.
4. **File-length tripwires in scope:** `ownership.ts` **399** (1 from warn), `pidfile.ts` 388, `quality-routes.ts` **450** (over warn), `routes.ts` **461** (over warn). H5 and H8/H2 additions must either stay tiny or split by cohesion (`src/sidecar/` already has the precedent: one routes file per domain).
5. **No parity fixtures are touched by this plan.** Nothing edits `targets/*/commands` or `targets/*/rules`. C1 edits the plugin, which requires `bun run embed-assets` (the plugin is bundled into embedded assets) but no baseline regeneration.
6. **The TDD guard blocks pure extractions and brand-new modules** (6 sightings). Use `tdd_set_state` → `RED_CONFIRMED` with a rationale after genuine RED; never write a fake failing test. For pure moves, existing tests passing unmodified is the checkpoint.
7. **Never run `bunx prettier --write` project-wide or call `quality_report`** (~85 unrelated files would reformat). `--check`/`--write` on touched files only.
8. **Test the production shape.** Three of these bugs (H1, H2, and v1.36.0's impact_analysis) shipped because tests exercised the direct-store path while production runs client-mode. Every regression test here that involves `{client, store}` must use `{client, store: null}` through the production entry point.

## Assumptions

- **The installed `@opencode-ai/plugin` package types are the authoritative contract** (per the `sentinal-opencode-api-source` skill). C1's fix is written against them; if OpenCode changes the shape again, the new pinning test — not the hand-written `.d.ts` — is the tripwire. Task 1 depends on this.
- **The sidecar's session-aware idle shutdown works as documented** (`server.ts:196-247`, verified coherent by the audit). H1's "client mode never stops the sidecar" design leans on it. Task 2 depends on this.
- **`memory/store.ts` splits cleanly by cohesion** (836 lines: path resolution, CRUD, sessions, spec-event serialization, prune). If the split turns out tangled, the fallback is extracting ONLY `getDbPath` + constructor path logic (small move) and leaving the rest for a future pass — enough to unblock H6. Task 6a depends on this.
- **H9's dedup can be decided at implementation time** between (a) skip-if-recent-duplicate and (b) a non-`discovery` type excluded from default listing. The task carries both options with a recommendation; neither changes the store schema.

## Testing Strategy

- Per-fix regression test that **fails before the fix**, through the real entry point: the plugin handler functions for C1 (invoked with the SDK's true shapes), `registerMcpCleanupHandlers` for H1, a real `Client`/`InMemoryTransport` for H2, `WorktreeManager`/`WorktreeStore` on fixture repos for H3/H4, `inspectPidfile` with a forged pidfile for H5, tmp-HOME env for H6/H7, a hanging fake subprocess for H8, and `processInstructionsLoaded` called twice for H9.
- **Pure-move checkpoint** for the store split: existing `store.test.ts` (and every memory test) passes **unmodified**.
- Full suite ≥ **2795 pass / 0 fail**; `bunx tsc --noEmit` clean; `bun run build:all` clean (C1 changes the bundled plugin).

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| C1 fix wakes up long-dead code paths (quality gate, TDD transitions) with latent bugs of their own | **High** | Medium — OpenCode users suddenly see blocks/warnings | Test each awakened path explicitly; the 600-line block and TDD transitions get dedicated cases. Release notes must say the gate is now live |
| H1 redesign leaves orphaned sidecars | Low | Low | The sidecar's own idle shutdown (verified) is the backstop; direct-store mode keeps the explicit stop |
| store.ts split breaks 41 call sites | Low | High | Pure move, barrel re-export from `store.ts`, all memory tests unmodified as the gate |
| H5 start-time comparison false-positives (clock skew, `ps` format drift) | Medium | Medium — refuses to stop a genuinely-owned stack | Compare with tolerance (±2s), treat parse failure as `unknown` (refuse-and-keep-pidfile, never kill) — matches the module's existing fail-closed doctrine |
| H8's grandchild-kill needs process groups; Bun's `proc.kill()` semantics differ per platform | Medium | Medium | Race the stderr read against a deadline as the primary fix (always works); group-kill as best-effort hardening |
| Six parallel agents in Wave 2 collide | Low | High | File-disjointness verified per task below; no shared fixtures; no parity regeneration exists in this plan |

## Pre-Mortem

1. **C1's fix reveals the after-hook was also load-bearing for something that relied on it being dead** (e.g. the 600-block now fires on the plugin's own exempt file) → Trigger: plugin tests fail on `PATH_EXEMPTIONS` cases. The exemption logic lives in `src/utils/file-length.ts` and must be honoured by the plugin path too.
2. **The store split is not actually a pure move** (hidden module-level state, import cycles) → Trigger: any memory test needs modification. Fall back to the minimal `getDbPath`-only extraction (Assumption 3).
3. **H5's `ps -o lstart=` output is unparseable on some locale/platform** → Trigger: the comparison test fails on CI (ubuntu). Use `ps -o etimes=`/epoch arithmetic instead of parsing locale-dependent `lstart` strings.
4. **H2's route addition pushes `routes.ts` (461) toward the block** → split a `spec-routes.ts` sibling instead, following the existing per-domain routes pattern.

## Execution Waves

**Wave 1** — five file-disjoint tasks: 1 (plugin), 2 (mcp/server), 3 (worktree manager+guards), 4 (worktree store), 6a (memory store split).
**Wave 2** — six file-disjoint tasks, one gated on Wave 1: 5 (runtime, no deps), 6b (env seam, needs 6a), 7 (install-claude, no deps), 8 (sidecar quality+client, no deps), 9 (spec_metrics route, no deps), 10 (instructions-loaded, no deps). Placed in Wave 2 purely to cap concurrent agents and keep Wave 1 focused on the destructive/critical set.

**⚠️ Task 6b lands LAST in Wave 2** (or its landing is announced): `test-preload.ts` is preloaded for every `bun test` run, so the moment 6b's commit appears, concurrent agents' suites stop finding a live sidecar at the old path — expected behaviour, but mid-wave agents should treat sudden sidecar-fallback test shifts as 6b's arrival, not their own regression.

**File-disjointness:** verified — no file appears in two tasks. No task regenerates parity baselines (none exist in scope). Only Task 1 touches `targets/`; only Task 1 requires `bun run build:all` verification.

## Goal Verification

### Truths

1. A test invokes the plugin's after-handler with the SDK-true shape (`input.args` populated, `output` = `{title, output, metadata}`) and asserts the quality gate fires on a 650-line file — fails before C1's fix.
2. A test invokes `registerMcpCleanupHandlers` in client mode (`store: null`) and asserts `stopSidecarProcess` is NOT called; and in direct mode with 0 sessions, that it IS.
3. `spec_metrics` through a real `Client` with `{client, store: null}` returns timing for a registered spec — fails before H2's fix.
4. `squashMerge` refuses when the main checkout has staged changes (new guard), and a test asserts the user's original branch is restored after a successful merge.
5. `resolveBySlug("add", projectA)` does NOT return project B's `add-auth` worktree — both the cross-project and prefix-collision cases pinned.
6. A forged pidfile whose PID belongs to a live process with a different start time is classified `stale`, not `owned`.
7. `SENTINAL_DB_PATH` (or equivalent) redirects `getDbPath()` and sidecar paths; `test-preload.ts` sets it; a test asserts the resolved path is NOT under the real `~/.sentinal` during tests.
8. `configureStatusline` on an unparseable settings file leaves the file byte-unchanged and reports a warning.
9. A quality-check whose subprocess never closes stderr still releases `activeChecks` within the timeout budget; `SidecarClient.get/post` abort within a bounded time against a hanging server.
10. `processInstructionsLoaded` called twice for the same file+project produces one stored observation (or zero `discovery`-typed rows, per the chosen design).
11. `bun test` ≥ 2795 pass / 0 fail; `bunx tsc --noEmit` clean; `bun run build:all` clean; every touched non-test file < 600 lines (and new files < 400).

### Artifacts

| Artifact | Provides |
| --- | --- |
| `targets/opencode/plugins/sentinal.ts` (fixed after-handler) + corrected `types/opencode-plugin.d.ts` | C1 |
| `src/mcp/server.ts` (client-aware cleanup + exiting signal handlers) | H1 |
| `src/sidecar/spec-routes.ts` (or route in existing file) + `client-routes.ts` method + client-first `spec_metrics` | H2 |
| `src/worktree/merge-guards.ts` + `manager.ts` (main-checkout preflight, branch restore) | H3 |
| `src/worktree/store.ts` (scoped, anchored resolution) | H4 |
| `src/runtime/pidfile.ts` + `ownership.ts` (start-time capture + comparison) | H5 |
| `src/memory/db-path.ts` (or similar) + slimmed `store.ts` + env seam + `test-preload.ts` setting it | H6 |
| `src/cli/commands/install-claude.ts` (non-destructive statusline path) | H7 |
| `src/sidecar/quality-routes.ts` (bounded stderr read) + `client.ts` (request timeouts) | H8 |
| `src/hooks/instructions-loaded.ts` (deduplicated) | H9 |

## Progress Tracking

- [x] Task 1: C1 — fix the OpenCode after-handler + local `.d.ts` (+ `webfetch`, `multiedit`) (Wave 1) — `0f5b23c`, 7 RED→17 pass
- [x] Task 2: H1 — client-aware MCP cleanup + exiting signal handlers (Wave 1) — `0897cec`, idle-fallback tests CITED (already existed at sidecar/server.test.ts:740,758,905,1015)
- [x] Task 3: H3 — squashMerge main-checkout preflight + branch restore (Wave 1) — `87e425b`, +15 tests, DIRTY_MAIN_CHECKOUT added to types.ts (small ownership deviation, unclaimed file)
- [x] Task 4: H4 — scoped, anchored resolveBySlug (Wave 1) — `e03180c`, exact-equality anchoring (NOT the plan's suggested boundary-LIKE — see notes)
- [x] Task 6a: split `src/memory/store.ts` (836 → 291/294/297/65) (Wave 1) — `4a6f10f`, inverted-inheritance chain, tests byte-unchanged
- [x] Task 5: H5 — PID start-time verification (Wave 2) — `2eb30ce`, new proc-start.ts (184), ownership.ts UNTOUCHED at 399
- [x] Task 6b: H6 — DB/sidecar path env seam + test-preload isolation (Wave 2) — `9fb3c84`, SENTINAL_HOME, +6 tests, main DB byte-identical across suite run
- [x] Task 7: H7 — non-destructive configureStatusline (Wave 2) — `61d4caa`, discriminated-union return, +6 tests
- [x] Task 8: H8 — quality-check wedge + SidecarClient timeouts (Wave 2) — `2aa3aae`, quality-routes split 145/375, 3-tier timeout map
- [x] Task 9: H2 — spec_metrics sidecar route (Wave 2) — `edac26b`, GET /spec/metrics, spec-routes.ts 70 lines
- [x] Task 10: H9 — instructions-loaded dedup (Wave 2) — `57e02ee`, touch-not-skip, exact-title match

**Total Tasks:** 11 | **Completed:** 11 | **Remaining:** 0

**Final: 2878 pass / 0 fail** (baseline at plan start 2795, +83). tsc clean.

### Wave 2 outcomes

- **⚠️ Pre-Mortem 3 FIRED — the plan's `ps -o etimes=` direction was WRONG:** BSD `ps` (macOS) rejects `etimes` outright. POSIX **`etime`** (`[[dd-]hh:]mm:ss`) works on both platforms and is still locale-independent. Used with a strict-regex parser. The plan's "works on both" claim in Task 5 requirement 5 was unverified and false.
- **Task 8's flat-2s default was wrong in practice:** embedding routes (`/observation`, `/memory/*`) load `@xenova/transformers` cold (>2s) and worktree routes run git — a 30s middle tier was required. Deviation documented; map structure unchanged.
- **`spec_wait_file` verdict: does not use SidecarClient at all** (pure fs-watch) — client timeouts cannot affect it.
- **H9 nuance:** `SearchResult` carries no `project` field, so project scoping is delegated to the server-side filter; exact-title equality applied client-side. Touch (content-only update) chosen over skip — the store's UPDATE refreshes timestamp+quality, keeping the /sync signal fresh.
- **User remedy for existing pollution (NOT executed):** search "Instructions loaded" (type discovery), `memory_delete` duplicates keeping newest per title — MCP path preferred over raw SQL (raw SQL bypasses vector-index cleanup). The hook self-heals from the first post-fix load.
- **Task 5 note:** existing owned-verdict tests needed `startTimeOf: () => Date.now()` stubs (fake PIDs would fail the real `ps` check — the fail-closed behaviour working as designed).

## Deferred Issues (appended)

- **Remaining `homedir()/.sentinal` write paths NOT yet routed through `getSentinalHome()`** (spec-review corrected the original two-file list — the DB and sidecar socket, the two observed pollution vectors, ARE sealed; these are logs/state/caches): `src/utils/file-log.ts:42` (**highest value — provably writes the real `sidecar.log` during every suite run** on client reconnects), `src/sidecar/observation-queue.ts:18` (QUEUE_DIR), `src/sidecar/quality-runners.ts:53-54` (tsbuildinfo), `src/memory/auto-decay.ts:45` (last-decay.json), `src/memory/embeddings.ts:67` (models cache), `src/memory/native-deps.ts:25`, `src/dashboard/lifecycle.ts:17,137` (dashboard pidfile), `src/opencode/dashboard-ensure.ts:23`. Route all through `getSentinalHome()` in a follow-up; until then `test-preload.ts`'s isolation claim covers the store and sidecar, not logs/decay-state.
- `src/memory/config.ts:56` `getConfigPath` reads the real `~/.sentinal/config.json` during tests (read-only influence).

### Wave 1 outcomes that change later tasks

- **Wave-end state: 2829 pass / 0 fail, tsc clean.** Mid-wave "failures"/"tsc errors" reported by agents were other agents' in-flight RED tests in the shared tree — expected, resolved at commit.
- **Bash exit info location found (Task 1):** OpenCode's shell tool returns `metadata: { output, exit, truncated, outputPath? }` — exit is **`metadata.exit`** and can be `null` on abort/timeout. Implementation reads `metadata.exit ?? exitCode ?? exit_code` behind the existing typeof-number guard.
- **The before-hook's `output.args` was confirmed CORRECT** and left alone, now pinned by a test.
- **⚠️ Task 4 found the plan's suggested anchoring WRONG:** branches are always exactly `${prefix}${slug}` (only row id and path carry `-<hash>`), so a `${slug}-%` boundary pattern would have re-admitted the `add`/`add-auth` collision. Exact equality used. ALSO found: `project_path` is stored as a realpath (`/private/var/...`) while callers pass symlink aliases (`/var/...`) — the old global fallback was silently papering over this; scope comparison now canonicalises both sides (pinned).
- **`reconcile.ts:82` has the same prefix-collision defect** (`startsWith` should be `===`) — REPORTED, not fixed (unowned this wave). **Add to Deferred Issues.**
- **Task 6a: `config.ts`'s getDbPath was NOT fully dead** — `config.test.ts:79-106` imports and asserts it (test files byte-frozen). Absorbed as `getPluginAwareDbPath()` in `db-path.ts` (unwired), `config.ts` re-exports for its test. CLAUDE_PLUGIN_DATA still NOT enabled — 6b's call.
- **Plugin tests stub `SidecarClient.connectWithRetry` + neutralise `ObservationQueue`** — the factory has no injection seam; extenders beware.
- **squashMerge gained an optional `warnings?: string[]` collector param** (repo's established channel) rather than a return-type change — wiring warnings into MCP/CLI surfaces is follow-up outside this plan.

## Deferred Issues

- `src/worktree/reconcile.ts:82` — `w.branch.startsWith(wanted)` has the same prefix-collision defect Task 4 fixed in `store.ts`; should be exact equality. Found+reported by Task 4, file unowned in this plan.

## Implementation Tasks

### Task 1: C1 — fix the OpenCode after-handler + local `.d.ts`

**Objective:** Make the after-hook read the shapes OpenCode actually sends, waking the quality gate, TDD transitions and memory capture on OpenCode.
**Dependencies:** None
**Wave:** 1

**Files:**
- Modify: `targets/opencode/plugins/sentinal.ts`, `targets/opencode/types/opencode-plugin.d.ts`
- Modify/Create: the plugin's test file(s) under `targets/opencode/tests/` (or wherever `sentinal.test.ts` lives — locate first)

**Key Decisions / Notes:**
- **⛔ Handler-position-sensitive (Context fact 1).** Before-hook: `output.args` is correct (writable args) — verify against the installed types and leave it if so. After-hook: take `args` from `input`, bash output from `output.output`. Sites: `:509` (filePath), `:640,657-659,671` (bash output/exitCode). There is no `output.stdout`/`stderr`/`exitCode` — derive what's derivable from `output.output` and `output.metadata`, and verify against the installed `.d.ts` what metadata carries for bash.
- **Fix the hand-written `.d.ts`** to match the installed package. The mutation-style assertion (handler reads `input.args`, breaks when reverted) is the REQUIRED pin; comparing against `~/.opencode/node_modules/@opencode-ai/plugin` on disk is best-effort/stretch — do not burn budget on filesystem gymnastics if the path varies.
- Ride-alongs in the same file: `tool === "fetch"` → `webfetch` (`:475`); add `multiedit` to `QUALITY_TOOLS` (`:496`).
- **Test the awakened paths** (Risk 1): 650-line file → block message; `PATH_EXEMPTIONS` file (the plugin itself) → no block; failing-test bash output → TEST_WRITTEN→RED_CONFIRMED transition; green test run → state clear.
- This file is length-exempt (`PATH_EXEMPTIONS`) — correctness only.
- `bun run embed-assets && bun run build:all` after — the plugin is bundled.

**Definition of Done:**
- [ ] After-handler reads `input.args` / `output.output`; before-handler verified against installed types and left correct
- [ ] Local `.d.ts` matches the installed package shape
- [ ] Tests: quality gate fires (fails before fix), exemption respected, TDD transitions fire on test output, `webfetch` hint matches
- [ ] `bun run build:all` clean; full suite green

**Verify:** `bun test targets/opencode/ src/opencode/ 2>/dev/null || bun test && bun run build:all`

---

### Task 2: H1 — client-aware MCP cleanup + exiting signal handlers

**Objective:** Stop the MCP server from killing the shared sidecar out from under other sessions, and make SIGTERM/SIGINT actually terminate the process.
**Dependencies:** None
**Wave:** 1

**Files:**
- Modify: `src/mcp/server.ts`, `src/mcp/server.test.ts`

**Key Decisions / Notes:**
- **Design (Context fact 2):** client mode (`store === null`) → **never** call `stopSidecarProcess()`; the sidecar's session-aware idle shutdown owns its lifecycle. Direct-store mode → keep the 0-active-sessions check. This is simpler and safer than threading an async session query into an exit path.
- Signal handlers: run cleanup, then `process.exit(143/130)` (or re-raise). The `exit`-event handler stays sync and keeps the same guard.
- Deduplicate the double `exit` registration (`:98` + `:119`) while there.
- **⛔ Test the production shape** (Context fact 8): `{client: <stub>, store: null}` asserts no stop; `{store: <with 0 sessions>}` asserts stop; `{store: <with 1 session>}` asserts no stop.

**Definition of Done:**
- [ ] Client mode never stops the sidecar — test fails before fix
- [ ] SIGTERM handler exits the process (assert via spawned subprocess or handler inspection)
- [ ] Direct-mode behaviour unchanged, both branches tested
- [ ] The sidecar's sessions-never-seen idle fallback (`src/sidecar/server.ts:235-241`) has a test — it is now the sole lifecycle mechanism for MCP-only users, i.e. load-bearing
- [ ] Full suite green; `server.ts` < 400

**Verify:** `bun test src/mcp/ src/sidecar/server.test.ts 2>/dev/null || bun test src/mcp/ src/sidecar/`

---

### Task 3: H3 — squashMerge main-checkout preflight + branch restore

**Objective:** Refuse to merge into a dirty main checkout, and put the user back on the branch they were on.
**Dependencies:** None
**Wave:** 1

**Files:**
- Modify: `src/worktree/manager.ts`, `src/worktree/merge-guards.ts`, their test files

**Key Decisions / Notes:**
- New preflight in `merge-guards.ts`: `git status --porcelain` on `wt.projectPath` — any output → refuse with a distinct error code (`DIRTY_MAIN_CHECKOUT`), mirroring the existing `DIRTY_WORKTREE` shape and message quality (say exactly what to do: commit or stash).
- Capture `git branch --show-current` on `projectPath` **before** `checkout baseBranch`; restore it in a `finally`-style path after commit (and on failure after the checkout succeeded). If the original branch WAS the base branch, no-op.
- Keep the existing stop-before-checkout ordering comment intact — it is load-bearing.
- Fixture-repo tests: staged-changes-refusal (fails before fix), untracked-only (decide and document: porcelain includes untracked — refuse or allow? Recommend refuse only on staged/modified tracked, allow untracked, since untracked files can't be committed by `git commit -m`), branch-restore on success, branch-restore on post-checkout failure.

**Definition of Done:**
- [ ] Staged changes in the main checkout → refusal naming the remedy — fails before fix
- [ ] Original branch restored after success and after mid-merge failure
- [ ] Untracked-files policy decided, documented in the guard, and tested
- [ ] Full suite green; both files < 400

**Verify:** `bun test src/worktree/`

---

### Task 4: H4 — scoped, anchored resolveBySlug

**Objective:** A slug lookup scoped to a project must never act on another project's worktree, and a slug must not prefix-match a longer slug.
**Dependencies:** None
**Wave:** 1

**Files:**
- Modify: `src/worktree/store.ts`, `src/worktree/store.test.ts` (locate the actual test file first)

**Key Decisions / Notes:**
- When `projectPath` is provided and the scoped query misses → **return null.** The global fallback runs only when no scope was given (audit F2's fix direction). Check callers first (`rg -n 'resolveBySlug' src/`) — if any caller depends on cross-project fallback, surface it in the report rather than silently changing it.
- Anchor the match: branch equals `${prefix}${slug}` OR starts with `${prefix}${slug}-` followed by the hex suffix worktree IDs carry — not bare `${slug}%`. Same for the `spec/` legacy prefix and `reconcile.ts`'s `startsWith` if it shares the defect (check `src/worktree/reconcile.ts:82`; fix in the same task ONLY if it's the same file's helper — otherwise report it).
- Tests: same slug in two projects resolves per-project; `add` does not match `add-auth`; unscoped lookup still finds globally.

**Definition of Done:**
- [ ] Cross-project test fails before fix, passes after
- [ ] Prefix-collision test (`add` vs `add-auth`) passes
- [ ] Unscoped behaviour preserved and tested
- [ ] Full suite green

**Verify:** `bun test src/worktree/`

---

### Task 6a: Split `src/memory/store.ts` (836 → editable)

**Objective:** Pure move to get `store.ts` under the 600 hard block (target < 400 per piece) and extract path resolution into a single module — the seam H6 needs.
**Dependencies:** None
**Wave:** 1

**Files:**
- Modify: `src/memory/store.ts`
- Create: sibling(s) — at minimum `src/memory/db-path.ts` (path resolution); more by cohesion (serialization, prune/maintenance) as needed
- Delete or absorb: the dead `getDbPath` duplicate in `src/memory/config.ts:37-59`

**Key Decisions / Notes:**
- **⛔ PURE MOVE.** Every existing memory test passes **unmodified** — that is the checkpoint (`git diff --exit-code` on all pre-existing test files).
- `db-path.ts` becomes the single source of truth for DB location; absorb the documented `CLAUDE_PLUGIN_DATA` behaviour from the dead duplicate **only if** doing so is behaviour-preserving for current callers (it currently never runs — enabling it is H6b's decision, not this task's). Default: move the logic, keep `store.ts`'s current behaviour byte-equivalent, delete the dead copy, and leave a note.
- Keep `MemoryStore` a single class; re-export anything moved so the 41 external construction sites and all imports are untouched (`src/index.ts` barrel included).
- Follow the split precedents: `spec/mcp-tools.ts` (parent keeps entry point) and `sidecar/client.ts` (inverted inheritance) — pick whichever yields the smallest diff.
- Do NOT add the env override here — that is Task 6b, with its own RED test.

**Definition of Done:**
- [ ] `store.ts` < 600 (ideally < 400); every new sibling < 400
- [ ] All pre-existing memory tests byte-unchanged and passing
- [ ] Dead `config.ts` duplicate removed; no caller broken (`rg 'memory/config'`)
- [ ] `src/index.ts` exports unchanged
- [ ] Full suite green; tsc clean

**Verify:** `git diff --exit-code -- 'src/memory/*.test.ts' && bun test src/memory/ && bun test`

---

### Task 5: H5 — PID start-time verification

**Objective:** A recycled PID must classify as `stale`, never `owned` — closing the window where preflight/teardown could signal an innocent process group.
**Dependencies:** None (Wave 2 for concurrency capping only)
**Wave:** 2

**Files:**
- Modify: `src/runtime/pidfile.ts`, `src/runtime/ownership.ts` (or a new small sibling — `ownership.ts` is at **399 lines**, 1 from warn), `src/runtime/lifecycle.ts` (capture at spawn), their tests

**Key Decisions / Notes:**
- **Capture:** already done — `startedAt` (see closed schema question below). **Compare** using `ps -o etimes= -p <pid>` (elapsed seconds, locale-independent) → compute epoch start; do NOT parse locale-dependent `lstart` strings (Pre-Mortem 3).
- **Compare:** in `inspectPidfile`/ownership verification, re-read the live process's start time; mismatch beyond tolerance → `stale` (refuse-and-keep-pidfile for signalling paths; eligible for stale-cleanup paths). Parse failure → `unknown`, which per the module's existing doctrine refuses to signal. **Never kill on uncertainty.**
- **Schema question CLOSED (review-verified):** the pidfile is written IMMEDIATELY after spawn, BEFORE readiness polling (`lifecycle.ts:231-238`), so `startedAt` is within spawn latency (~ms) of true process start. **Reuse `startedAt`; widen tolerance to ±5s** (`ps -o etimes=` has 1s granularity plus rounding at both capture and compare — document the math in a comment). If the RED test still flakes, add a ps-derived field at spawn. Older pidfiles predating the check → treat as today (no comparison) so existing running stacks are not orphaned by the upgrade; say so in a comment.
- If `ownership.ts` needs > ~1 line net growth, extract the comparison helper to a new `src/runtime/proc-start.ts` rather than breaching the warn.
- Tests: forged pidfile pointing at a live process (the test's own subprocess) with a mismatched start time → `stale`; matching → unchanged classification; missing field → legacy behaviour; `ps` failure → `unknown`.

**Definition of Done:**
- [ ] Recycled-PID test fails before fix, passes after
- [ ] Parse-failure and legacy-pidfile paths fail closed (refuse, keep pidfile)
- [ ] `ownership.ts` ≤ 400 or helper extracted
- [ ] Full suite green (CI is ubuntu — no macOS-only `ps` flags)

**Verify:** `bun test src/runtime/`

---

### Task 6b: H6 — DB/sidecar path env seam + test isolation

**Objective:** Stop every `bun test` run from writing junk into the real user database.
**Dependencies:** Task 6a
**Wave:** 2

**Files:**
- Modify: `src/memory/db-path.ts` (from 6a), `src/sidecar/paths.ts`, `src/memory/test-preload.ts`, plus a test
- Possibly modify: `src/memory/tdd-state.ts`, `src/dashboard/views/settings.ts` (the other `getDbPath` references — verify they route through the new module)

**Key Decisions / Notes:**
- One env var — `SENTINAL_HOME` (redirects the whole `~/.sentinal` tree: DB, sidecar socket/port/pid, logs) is strictly better than a DB-only override, because the observed pollution arrived **via the live sidecar socket** as well as direct opens. `db-path.ts` and `sidecar/paths.ts` both honour it.
- `test-preload.ts` sets `SENTINAL_HOME` to a per-run temp dir **before any Database construction** (it already runs first via `bunfig.toml`). Preserve its existing sqlite-vec setup.
- **⚠️ Consequence:** tests that previously found a live sidecar will now find none (different socket path) and exercise direct-mode fallbacks. That is the correct behaviour, but expect some test output changes — any test that *asserted* on real-sidecar behaviour was broken by definition; fix those honestly, don't special-case them.
- Decide and document whether `CLAUDE_PLUGIN_DATA` (the dead duplicate's documented behaviour) is enabled now or left for later — recommend later, one seam at a time.
- Add a guard test: during tests, `resolveDbPath()` must NOT be under `os.homedir()/.sentinal`.

**Definition of Done:**
- [ ] `SENTINAL_HOME` honoured by both path modules — test fails before fix
- [ ] `test-preload.ts` isolates every test run; guard test asserts non-real path
- [ ] **Guard test is the authoritative check:** with `SENTINAL_HOME` set, `resolveDbPath()` AND every sidecar path (socket/port/pid) resolve outside `os.homedir()/.sentinal` — deterministic, CI-safe
- [ ] One-off manual verification (sidecar STOPPED first): mtime/row-count of the real DB unchanged across a suite run — a note in the report, not an automated gate
- [ ] Sidecar tests that relied on the real socket fixed honestly

**Verify:** `bun test && bun -e 'console.log(process.env.SENTINAL_HOME ?? "unset in normal shell — correct")'`

---

### Task 7: H7 — non-destructive configureStatusline

**Objective:** A corrupt or JSONC settings file must never be replaced with `{statusLine}`.
**Dependencies:** None
**Wave:** 2

**Files:**
- Modify: `src/cli/commands/install-claude.ts`, its test file

**Key Decisions / Notes:**
- Parse failure → **skip** statusline configuration with a visible warning naming the file and the parse error; never write. (Fix direction from the audit; "start fresh" is the bug.)
- On success: write a sibling `.bak` before modifying (the repo's migration path already has this discipline — `migrations.ts:27-33`).
- Do not attempt comment-preserving JSONC editing here — out of scope; skipping is safe.
- Tests: truncated JSON → file byte-unchanged + warning; valid file → statusline added, everything else preserved, `.bak` exists.

**Definition of Done:**
- [ ] Corrupt-file test: byte-unchanged, warning, exit success — fails before fix
- [ ] Valid-file path preserves all other keys and writes `.bak`
- [ ] Full suite green; file < 400

**Verify:** `bun test src/cli/commands/install-claude.test.ts 2>/dev/null || bun test src/cli/`

---

### Task 8: H8 — quality-check wedge + SidecarClient timeouts

**Objective:** A hung subprocess must never permanently 429 a project, and a hung sidecar must never stall hooks to their full timeout.
**Dependencies:** None
**Wave:** 2

**Files:**
- Modify: `src/sidecar/quality-routes.ts` (**450 — over warn; keep net growth ≤ ~10 lines or split**), `src/sidecar/client.ts`, their tests

**Key Decisions / Notes:**
- **Primary fix:** race the post-kill stderr/stdout reads against a short deadline (`Promise.race` with ~2s); on loss, proceed with whatever was captured. This alone unwedges `activeChecks` (the `finally` runs).
- **Hardening:** attempt group termination for the bunx/npx fallback (spawn with detached+negative-PID kill, or walk children) — best-effort, platform-guarded, never the correctness mechanism (Risk table).
- **Client timeouts — path-based map inside `client.ts`'s concrete `get`/`post`, and NOTHING else.** A path-pattern → timeout map (`/quality-check` → long budget, default ~2s), no signature changes. **⛔ Do NOT edit `client-routes.ts` — Task 9 owns it this wave**; the abstract `get`/`post` signatures and `qualityCheck()` live there, so any "per-call override" design collides mid-wave. Follow the `AbortSignal.timeout` pattern at `lifecycle.ts:98`. ⛔ Do not break `spec_wait_file`'s long-poll (check which route it uses; size the map accordingly).
- Tests: fake subprocess that ignores SIGTERM and holds stderr → route returns within budget and `activeChecks` is released (429 on the SECOND call fails before fix, passes after); client `get` against a never-responding server → rejects within bound. Remember the repo's subprocess-test rule: explicit `it(..., timeout)` matching the subprocess timeout (`sentinal-test-timing` skill).

**Definition of Done:**
- [ ] Wedge regression: second quality-check for the same project succeeds after a hung first — fails before fix
- [ ] `activeChecks` released on every path
- [ ] Client timeouts bounded, long-poll routes unharmed
- [ ] `quality-routes.ts` < 600 (split if the fix needs room); full suite green

**Verify:** `bun test src/sidecar/`

---

### Task 9: H2 — spec_metrics sidecar route

**Objective:** `spec_metrics` returns real timing in the production (sidecar) configuration.
**Dependencies:** None
**Wave:** 2

**Files:**
- Modify: `src/spec/events-mcp-tools.ts`, `src/sidecar/client-routes.ts`
- Create or modify: `src/sidecar/spec-routes.ts` (new sibling — `routes.ts` is 461, over warn; follow the per-domain routes precedent) + wire into the router in `src/sidecar/server.ts`
- Tests: `src/sidecar/spec-routes.test.ts` (use `buildForTest(baseUrl)`), extend the events-mcp-tools test

**Key Decisions / Notes:**
- Read `spec_metrics`'s handler first to enumerate exactly which store reads it needs (spec row + task timing + events), then expose ONE route returning that shape — don't invent a general query surface.
- Client-first in the tool: `client.getSpecMetrics(...)` when present, `specStore` fallback for direct mode — the same pattern every healthy spec tool already follows in that file.
- **⛔ RED on the production shape** (Context fact 8): real `Client`/`InMemoryTransport`, `{client, store: null}`, registered spec → currently "No spec found." — that's the failing assertion.
- **⛔ `src/sidecar/client-routes.ts` do-not-import rule:** no `bun:sqlite` reachable (verify by bundling, per the `sentinal-parity-baselines`-adjacent precedent: `bun build --target=bun` + grep).

**Definition of Done:**
- [ ] Production-shape test fails before, passes after
- [ ] Direct-store mode unchanged
- [ ] New route file < 400; `server.ts` wiring minimal; no `bun:sqlite` reachable from client files
- [ ] Full suite green

**Verify:** `bun test src/sidecar/ src/spec/`

---

### Task 10: H9 — instructions-loaded dedup

**Objective:** Loading CLAUDE.md must not append an observation per session forever.
**Dependencies:** None
**Wave:** 2

**Files:**
- Modify: `src/hooks/instructions-loaded.ts`, its test (create if none exists — check first)

**Key Decisions / Notes:**
- **Option A (recommended), mechanism mandated:** the client has NO exact-match lookup (verified: only ranked `memorySearch({query, project, type, limit})`, `memoryGet(ids)`, `addObservation`, `updateObservation`). So: call `memorySearch({query: title, project: cwd, type: "discovery", limit: 10})` and apply a **client-side exact title+project equality filter** over the results; any exact match within the window (e.g. 30 days) is the duplicate — skip, or `updateObservation`-touch it. If the RED test shows ranked search failing to surface the exact duplicate, fall back to adding a tiny exact-lookup route — decide in the task, not silently.
- **Option B:** stop typing these as `discovery` (they pollute semantic search); use tags-only or a dedicated low-rank type. Requires deciding list/search default behaviour — bigger blast radius. Take A unless implementation reveals A is expensive on the hook's hot path (it's async fire-and-forget, so a lookup is acceptable).
- Whichever is chosen: the fix must also consider the **existing** pollution — do NOT mass-delete in this task (destructive; user data), but report the count and the `sentinal memory prune`-based remedy in the task output for the user to run deliberately.
- Tests: two calls same file+project → one row; different files → two rows; sidecar-down → silent no-op preserved.

**Definition of Done:**
- [ ] Duplicate-call test fails before fix (two rows), passes after (one)
- [ ] Different-file and sidecar-down behaviour preserved
- [ ] Existing-pollution remedy reported, not auto-executed
- [ ] Full suite green

**Verify:** `bun test src/hooks/`
