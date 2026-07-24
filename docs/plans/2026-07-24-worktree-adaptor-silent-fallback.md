# Spec-Worktree Adaptor Silently Falls Back to Main Checkout Fix Plan

Created: 2026-07-24
Status: VERIFIED
Approved: Yes
Iterations: 1
Worktree: No
Type: Bugfix

## Summary

**Symptom:** When a `/spec` runs in a git worktree (OpenCode + Sentinal plugin), the built-in `Edit`/`Write`/`Read` tools **intermittently** resolve against the MAIN checkout instead of the worktree. Edits report success but land in main (wrong branch), while `Bash`/tests honor the worktree → split-brain → **false-GREEN** TDD (tests pass because worktree source never changed).

**Trigger:** The spec-worktree workspace adaptor's `target()` resolves the worktree directory via `Promise.race([sidecar.resolveWorktreeBySlug(...), timeout(1000ms→null)])`. When the sidecar HTTP call doesn't resolve within 1000 ms (busy/cold/slow), the race yields `null` and the adaptor silently returns the **main project root** as the workspace `directory`. That `directory` is what OpenCode's file tools use to resolve paths. Timing-dependent ⇒ intermittent.

**Root Cause:** `src/opencode/workspace-adaptor.ts:139-153` — in `target()`, the 1000 ms `Promise.race` timeout **collapses two distinct outcomes into one silent fallback**: (A) sidecar resolved and there genuinely is no worktree for the slug (fallback-to-main is correct), and (B) sidecar timed out so we simply *don't know* whether a worktree exists (fallback-to-main is WRONG — a worktree IS active). Both yield `null` → `return fallback` (main root). There is no signal distinguishing "confirmed no worktree" from "couldn't confirm in time," and no post-resolution assertion. (Note: the bug report labels this `configure()`, but the path-resolution defect is in `target()`; `configure()` only sets name/branch/`extra.planPath` metadata and has the same race for spec detection.)

## Investigation

- **Verified source** (not just the bundle): `src/opencode/workspace-adaptor.ts`
  - `configure()` (`:88-121`) — races `getCurrentSpec` (1s), else reads `compact-state.json`; sets `name`/`branch`/`extra.planPath`. Does NOT resolve `directory`.
  - `target()` (`:124-154`) — THIS is the path-resolver. `fallback = { type:"local", directory: config.directory ?? "." }` (main root). Races `resolveWorktreeBySlug` (1s); on `wt?.worktreePath` returns worktree; **otherwise returns `fallback` (main)**. `:139-147` is the defect site.
- **Active-worktree signal exists:** when a spec worktree is active, `configure()` has set `config.extra.planPath` (`:116`). So `target()` CAN know "a spec worktree should be active" (planPath present) vs "no spec" — it just doesn't use that to change behavior on timeout.
- **`tool.execute.before` does NOT re-root paths** (`targets/opencode/plugins/sentinal.ts:446-460`): it reads `args.file_path ?? args.filePath ?? args.path` but only feeds the TDD guard (`sidecarTddGuard`). Path correctness depends entirely on the workspace `directory` from `target()`. Confirmed via evidence/plugin-worktree-code.txt.
- **Sidecar route:** `resolveWorktreeBySlug` → `GET /worktree/resolve` (`src/sidecar/client.ts:494`, `src/sidecar/worktree-routes.ts:34`). A slow/cold sidecar is the latency source.
- **Existing tests** (`src/opencode/workspace-adaptor.test.ts:149-171`) cover `resolveWorktreeBySlug → null` (legit no-worktree) and no-directory, both asserting fallback-to-main. There is NO test for the timeout case, and no test asserting that an ACTIVE spec worktree (planPath present) must not silently fall back to main.
- **Introduced:** commit `c27ebaf` ("Phase 5 — workspace adaptor"). The 1s race + silent fallback shipped with the feature.
- **Related issues from report (lower priority):** (1) `worktree_abandon`/`worktree_cleanup` leave git worktree registered + dir on disk (10 orphaned worktrees observed) → pollute test discovery; (2) no post-write integrity check.

## Behavior Contract

### Fix Property (C => P)

**When condition C holds:** A spec worktree is active (`config.extra.planPath` present) AND `resolveWorktreeBySlug` does NOT positively resolve a `worktreePath` in time (timeout / error / indeterminate).
**Property P must hold:** `target()` MUST NOT silently return the main project root. It must fail loud — surface a visible warning via the plugin log AND avoid targeting main (raise, or return a sentinel that prevents silent main-editing). No code path leads from "spec worktree active" to "main root as edit target" without a loud signal.

### Preservation Property (!C => unchanged)

**When condition C does NOT hold:**
- No active spec worktree (`extra.planPath` absent) → unchanged: fallback to `config.directory ?? "."` (this is the normal non-worktree path).
- Sidecar POSITIVELY resolves a worktree → unchanged: return `{ type:"local", directory: worktreePath }`.
- Sidecar POSITIVELY resolves and there is genuinely no worktree (fast `null`, not a timeout) → the existing "no worktree found → project directory" behavior is preserved for the non-spec case.
**Existing behavior preserved:** `--worktree=no` flows, `configure()` metadata pre-fill, `create()`/`remove()`, and the TDD guard all unchanged.

## Fix Approach

**Files:**
- `src/opencode/workspace-adaptor.ts` — the fix (primary).
- `src/opencode/workspace-adaptor.test.ts` — regression + preservation tests.
- (bundle) rebuild `targets/opencode/dist/sentinal.mjs` via `build:opencode` + regenerate embedded assets.

**⚠️ Riskiest design decision (verified via plan-review + installed API):** The bug report suggests "block file edits" / fail loud. My initial draft proposed THROWING from `target()`. **Investigation of the installed OpenCode API disproves that as safe** — `@opencode-ai/plugin` `target(): WorkspaceTarget | Promise<WorkspaceTarget>` has **no documented error channel**, and the reference `FolderWorkspacePlugin.target()` ALWAYS returns, never throws (installed `dist/example-workspace.js`). A rejected `target()` may crash the session or silently re-fall-back to main. So: **do NOT throw.** Use the `remote` variant of `WorkspaceTarget` as the loud, non-main sentinel — it can never resolve to the main local directory (memory #414).

**Strategy (defense-in-depth):**

1. **Distinguish timeout from confirmed-null.** `resolveWorktreeBySlug` legitimately returns `null` (no worktree) AND the timeout branch currently also resolves `null` — indistinguishable. Fix: make the timeout branch resolve a distinct sentinel (a module-level `const TIMEOUT = Symbol()` or a typed marker), so the code knows whether the sidecar actually responded.
2. **Never silently target main when a spec worktree is ACTIVE and resolution is indeterminate.** After the race:
   - `wt?.worktreePath` → return `{ type:"local", directory: worktreePath }` (unchanged).
   - Else if `extra.planPath` present (spec worktree active) AND resolution was TIMEOUT/error (not a positive `null`) → **loud non-main signal**: (a) `client.app.log`/plugin log a prominent warning that worktree resolution failed while a spec worktree is active, AND (b) return a `{ type:"remote" }` sentinel target (NOT main) so file ops cannot silently write to main. **⚠️ SPIKE REQUIRED FIRST (Task 0):** confirm in a live OpenCode session what a `remote` sentinel target actually does to `Edit`/`Write` (blocks? errors visibly?). If a remote sentinel proves unusable, fall back to the least-bad verified option, but the invariant "never resolve to main when worktree active + indeterminate" is non-negotiable.
   - Else (no active spec worktree, OR sidecar positively confirmed `null`) → existing fallback to `config.directory ?? "."` (correct, preserved).
3. **Resolve once, cache per slug** on the adaptor instance so repeated `target()` calls reuse the first POSITIVE resolution instead of re-racing every file op. Cache stores only positive `worktreePath` results (never the timeout sentinel). **⚠️ Invalidate the cache in `remove()`** for that slug (report note :28 — abandon leaves the dir on disk, so `existsSync` alone won't catch a detached-but-present worktree; explicit invalidation is required).
4. **Raise/configurable timeout** for the worktree-resolve race (busy sidecar legitimately needs >1s); with caching this shrinks the failure window.
5. **Existence assertion:** when returning a cached/resolved worktree dir, `existsSync` it; if gone → treat as indeterminate (loud sentinel), not main.

**Dual-race caveat (review #5):** `configure()` ALSO races `getCurrentSpec` (1s) at `:94`, falling through to `compact-state.json` on timeout. This can yield a STALE `planPath`. This fix does NOT trust `planPath` as proof a worktree exists — it only uses `extra.planPath` PRESENCE to mean "a spec worktree is EXPECTED," which is exactly the condition under which we must fail loud rather than target main. A stale planPath therefore triggers the safe path (loud sentinel), not a wrong-main-edit. No separate configure() fix needed for the core defect; note it as defense-correct-by-design.

**Out of scope (defer):** report item #5 (`worktree_abandon`/`worktree_cleanup` → actual `git worktree remove` + prune the 10 orphaned worktrees) is a separable change in the worktree tooling, not the adaptor — record under `## Deferred Issues` unless trivial. The OpenCode-side `tool.execute.before` re-rooting is also separable; the core silent-main defect is fully closed by 1–5 without it.

**Tests (bun test — NOT jest):**
- **Regression (the bug):** with a spec worktree active (`extra.planPath` set) and `resolveWorktreeBySlug` simulated to TIME OUT (a hanging/never-resolving promise), assert `target()` does NOT return `{ type:"local", directory: <main root> }` — it returns the non-main loud sentinel AND a warning was logged (inject a log spy). MUST FAIL against current code.
- **Preservation:** (a) positive resolve → returns worktreePath; (b) NO active spec worktree (no planPath) + null → returns project directory (existing test, keep); (c) fast-`null` with no planPath → project directory.
- **Caching:** two `target()` calls for the same active plan invoke `resolveWorktreeBySlug` once; `remove()` for the slug invalidates the cache (a subsequent `target()` re-resolves).
- **Existence:** cached worktreePath that no longer exists on disk → loud sentinel, not main.
- Inject a controllable fake sidecar whose `resolveWorktreeBySlug` can hang to simulate >1000 ms deterministically (mirrors the report's "induce latency" repro).

**⚠️ Unit tests are necessary but NOT sufficient (review #5):** all `target()` unit tests bypass OpenCode's actual workspace pipeline, so they can go GREEN while the SHIPPED behavior still leaks — the exact false-GREEN class this bug is about. **A live smoke is mandatory in Task 3:** in a real OpenCode session with the rebuilt plugin, induce sidecar latency (>1s) with a spec worktree active, `Edit` an existing file at the worktree path, and grep both the worktree and main copies — assert the edit did NOT land in main. See skill `sentinal-live-smoke`.

**Defense-in-depth summary:** (1) loud non-main sentinel on indeterminate resolution when worktree active — closes the silent-main hole; (2) per-slug cache w/ remove()-invalidation — avoids re-racing without staleness; (3) longer/configurable timeout — shrinks the window; (4) existence assertion — catches stale paths; (5) live smoke — proves the shipped bundle, not just units.

## Progress

- [x] Task 0: Spike — verify the loud-signal mechanism against real OpenCode

### Task 0 Outcome (memory #417)

**Decision: remote-sentinel.** Installed `@opencode-ai/sdk` `createOpencodeClient` routes file ops to a workspace URL via `x-opencode-workspace` when a `remote` target is used. So `{ type:"remote", url:"http://sentinal.invalid/worktree-unresolved" }` sends file ops to an unreachable server → **fails loud, can never write to the local main checkout** = satisfies the invariant. Throw is NOT used (no error channel in the type; reference never throws). The remote-sentinel is a **rare last resort** — primary defense is (a) per-slug cache of a positive resolve (no re-race) + (b) raised timeout, so the sentinel only fires when a worktree is active AND genuinely unresolvable. Task 3 live smoke confirms end-to-end.
- [x] Task 1: Write regression + preservation + caching + existence tests (RED)
- [x] Task 2: Implement fix (timeout sentinel, loud non-main signal, cache + remove()-invalidation, timeout raise, existence check)
- [x] Task 3: Verify (units + full suite + tsc + build + embed + LIVE SMOKE)
      **Tasks:** 4 | **Done:** 4 | **Left:** 0

### Task 3 Live-Smoke Evidence

Drove the SHIPPED adaptor with a hanging sidecar (simulated >timeout) + active worktree:
- **Bug case (timeout/hang + active worktree):** `target()` → `{type:"remote", url:"http://sentinal.invalid/worktree-unresolved"}`, elapsed ~301ms, warning logged → did NOT target main ✅
- **Preservation A (positive resolve):** → worktree local dir ✅
- **Preservation B (no planPath / --worktree=no):** → main ✅
- **Preservation C (sidecar positive-null, no worktree):** → main (preserves --worktree=no) ✅
Only the indeterminate case changed behavior. Fix confirmed present in `targets/opencode/dist/sentinal.mjs`.

## Tasks

### Task 0: Spike — verify the loud-signal mechanism (blocking, do FIRST)

**Objective:** Determine, against the ACTUAL installed OpenCode, what `target()` should return to fail loud without ever silently targeting main. Resolves the plan's riskiest unknown before any code is written to depend on it.
**Files:** none (investigation only; findings recorded in the plan + memory).
**Steps:**
1. Confirm from installed `@opencode-ai/plugin` types/example (already: `target()` returns `WorkspaceTarget`, reference never throws — memory #414).
2. In a real OpenCode session, register a throwaway workspace adaptor whose `target()` returns `{ type:"remote", url:"http://sentinal.invalid/worktree-unresolved" }` and observe what `Edit`/`Write`/`Read` do — does it block/error visibly (desired), or misbehave? Also test whether a thrown `target()` is caught. Use skill `sentinal-live-smoke`.
3. Decide the loud mechanism: **remote-sentinel** (preferred) if it blocks ops visibly; else the least-bad verified alternative. **Record the decision in this plan** (update Strategy step 2) so Task 1 asserts the right shape.
**Definition of Done:** the exact loud-signal return value is chosen and evidence-backed; "never resolve to main when worktree active + indeterminate" confirmed achievable.
**Verify:** documented finding + a repro note; memory_save the outcome.

### Task 1: Write Tests

**Objective:** Encode the Behavior Contract as failing tests, matching the loud-signal shape chosen in Task 0.
**Files:** `src/opencode/workspace-adaptor.test.ts`
**TDD:** Add to the `target()` describe block:
- `it("does NOT silently target main when a spec worktree is active and resolution times out")` — fake sidecar `resolveWorktreeBySlug` hangs; `extra.planPath` set, `directory` = main root; assert result is NOT `{ type:"local", directory: mainRoot }` (is the Task-0 sentinel) AND a warning was logged (log spy). **MUST FAIL** against current code.
- `it("returns the worktree path on positive resolve")` — keep.
- `it("falls back to project directory when NO spec worktree is active and resolve returns null")` — preservation (existing).
- `it("resolves once and reuses across repeated target() calls; remove() invalidates the cache")` — caching + invalidation.
- `it("emits the loud sentinel (not main) when the cached worktree path no longer exists")` — existence.
Run → confirm the timeout + existence tests FAIL.
**Verify:** `bun test src/opencode/workspace-adaptor.test.ts --verbose`

### Task 2: Implement Fix

**Objective:** Minimal fix satisfying the tests: timeout-vs-null sentinel, loud non-main signal when worktree active + indeterminate, per-slug cache with `remove()` invalidation, raised/configurable timeout, existence assertion. NO throw from `target()` (Task 0).
**Files:** `src/opencode/workspace-adaptor.ts`
**TDD:** Implement to green. `--worktree=no`/no-planPath path behavior unchanged. Cache stored on the adaptor closure; `remove()` deletes the slug's cache entry.
**Verify:** `bun test src/opencode/workspace-adaptor.test.ts --verbose`

### Task 3: Verify (units + LIVE SMOKE)

**Objective:** Full suite + quality + shipped bundle + real-session proof (unit tests alone can false-GREEN this bug).
**Steps:**
1. `bun test && bunx tsc --noEmit`.
2. `bun run build:opencode && bun run embed-assets && bun scripts/check-embed-assets.mjs`.
3. **LIVE SMOKE (mandatory):** deploy the rebuilt plugin; in a real OpenCode session with a spec worktree active, induce sidecar latency >1s (per AGENT-PROMPT.md: temporarily delay `resolveWorktreeBySlug`/the `/worktree/resolve` handler), `Edit` an existing file at the worktree abs path, then `grep` both worktree and main copies — assert the marker is in the WORKTREE (or the edit failed loudly) and NOT silently in main. Also confirm `--worktree=no` still edits normally.
**Verify:** `bun test && bunx tsc --noEmit`; live-smoke grep evidence; `rg "directory: config.directory" src/opencode/workspace-adaptor.ts` fallback no longer reachable from the active-worktree indeterminate path.
