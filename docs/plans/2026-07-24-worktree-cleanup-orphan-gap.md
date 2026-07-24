# worktree_cleanup Cannot Remove Orphaned Worktrees Whose Directory Still Exists Fix Plan

Created: 2026-07-24
Status: VERIFIED
Approved: Yes
Iterations: 1
Worktree: No
Type: Bugfix

## Summary

**Symptom:** Orphaned `sentinal/spec-*` git worktrees accumulate on disk (report observed 10 via `git worktree list`) from crashed/abandoned `/spec` sessions. They pollute test discovery (e.g. vitest picking up a stale worktree's spec files). `worktree_cleanup` does NOT remove them.

**Trigger:** A worktree is created (`git worktree add` + DB insert) but the session ends without calling `abandon()` (crash, kill, or a `/spec` that never syncs/abandons). The worktree directory, its git registration, and (often) its DB `active` record all persist. `worktree_cleanup` then can't remove it.

**Root Cause:** `src/worktree/manager.ts` `cleanup()` only cleans a worktree when its **directory no longer exists** (`if (!existsSync(wt.worktreePath)) shouldClean = true`). It has a blind spot for the far more common orphan: **directory still present**. Two orphan classes are un-cleanable:
1. **DB-`active` + dir-present** (abandoned/crashed session) — `shouldClean` stays false → skipped; only `git worktree prune` (which removes only already-deleted worktrees) is ever run.
2. **git-only, no DB record** (crash between `git worktree add` at `manager.ts:51` and DB insert at `:60`) — `cleanup()` iterates the DB's `active` list, so it never even sees these.

The tool's own contract documents the limitation: `worktree_cleanup` = "Clean up all stale worktrees whose directories **no longer exist**" (`mcp-tools.ts:291`). So this is a capability gap, not a regression.

## Investigation

- **`cleanup()`** (`src/worktree/manager.ts`): iterates `store.listAll("active")`; sets `shouldClean` only when `!existsSync(wt.worktreePath)`; then `git worktree prune` + `git branch -D` + mark abandoned. Present-directory orphans never qualify.
- **`abandon(id)`** (`manager.ts:250-277`): CORRECT — `git worktree remove --force` (fallback `rmSync` + prune) + `git branch -D` + mark abandoned. But requires an explicit worktree ID; nothing calls it for orphaned worktrees.
- **`create()` order** (`manager.ts:51,60`): `git worktree add` FIRST, DB insert SECOND → a crash in between leaves a git-only worktree with no DB record (orphan class 2).
- **`listGitWorktrees(repoRoot)`** (`manager.ts:379-397`): already exists — parses `git worktree list --porcelain` into `{ path, head, branch }`, skipping the main checkout. This is the reconciliation source `cleanup()` needs but doesn't use. Used today only by `resolveWithReconcile` (`:307`).
- **MCP `worktree_cleanup`** (`mcp-tools.ts:284-315`): delegates to `client.cleanupWorktrees(projectPath)` (sidecar) or `manager.cleanup()`. Both share the same limitation.
- **Sidecar route** `cleanupWorktrees` mirrors `manager.cleanup()` — will need the same fix behind it (verify during impl whether the sidecar calls `manager.cleanup()` directly or reimplements).
- **Prior related fix:** the sibling worktree edit-leak fix (2026-07-24, memory #420) is unrelated but confirms this subsystem is actively being hardened.

## ⚠️ Critical safety findings (plan-review, verified — drove a redesign)

The initial draft was UNSAFE. Verified against source:
- **`cleanup()` takes NO arguments** (`manager.ts:341` — `cleanup(): number`) and iterates `store.listAll("active")` **globally across ALL projects**. My "exclude the current working directory" gate was unimplementable, and behind the long-lived sidecar (`worktree-routes.ts:87`), `process.cwd()` = the SIDECAR's cwd, not the user's → the gate would exclude NOTHING while appearing safe. **Data-loss trap.**
- A **live IN_PROGRESS `/spec`** and a crashed orphan are indistinguishable by `active` + present-dir + `sentinal/spec-*` alone → must cross-reference plan status.
- The tool's contract is "dirs no longer exist"; making default cleanup destructive to present dirs is a surprising, unflagged destructive change.

**Consequences (redesign):**
1. Orphan removal is **OPT-IN** via a new `force` flag — default `cleanup()` keeps its exact current (dir-gone-only) behavior. No silent contract change.
2. The caller's real **cwd/project must be threaded** from BOTH entry points (MCP tool arg + sidecar request body) — never trust the sidecar's cwd. Scope removal to that project.
3. **Mandatory plan-status check:** only remove a present-dir sentinal worktree whose plan is VERIFIED/abandoned/absent — NEVER one whose plan is IN_PROGRESS (cross-reference SpecStore).
4. Extra ownership guard for git-only orphans: path must be inside the given project `directory`.

## Behavior Contract

### Fix Property (C => P)

**When condition C holds:** `worktree_cleanup` is invoked **with `force: true`** and a target project, and there exists a stale sentinal worktree in that project — a `sentinal/spec-*` git worktree, inside the project directory, whose plan is NOT IN_PROGRESS (VERIFIED/abandoned/no-plan), AND which is not the caller's current worktree.
**Property P must hold:** it is removed fully — `git worktree remove --force` (fallback `rmSync` + prune), `git branch -D`, DB reconciled (mark abandoned if a record exists; no-op if git-only) — and counted. Both orphan classes (DB-active-present; git-only) handled.

### Preservation Property (!C => unchanged)

**When condition C does NOT hold:**
- **`force` NOT set (default):** behavior is BYTE-IDENTICAL to today — only dir-gone worktrees cleaned. This is the primary preservation guarantee.
- Even with `force`: a worktree whose plan is IN_PROGRESS, a non-`sentinal/spec-*` branch, the main checkout, a path outside the target project, or the caller's current worktree → NEVER removed.
- `abandon(id)` unchanged.

## Fix Approach

**Files:**
- `src/worktree/manager.ts` — `cleanup()` gains `(opts?: { force?; projectPath?; currentWorktree?; isPlanActive? })`; default path unchanged.
- `src/worktree/mcp-tools.ts` — `worktree_cleanup` gains a `force` param + thread the real `project` (already accepts `project`); pass an `isPlanActive` resolver.
- `src/sidecar/worktree-routes.ts` + `src/sidecar/client.ts` `cleanupWorktrees` — thread `force`/`project`/cwd through the request body (do NOT use sidecar cwd). Confirmed single-point: sidecar calls `manager.cleanup()` at `worktree-routes.ts:87`.
- `src/worktree/manager.test.ts` — regression + preservation tests.

**Strategy:**
1. **Default unchanged.** `cleanup()` without `force` = today's dir-gone-only pass. Zero contract change.
2. **`force` pass (opt-in):** scoped to the given `projectPath`, enumerate `listGitWorktrees(projectPath)`; for each `sentinal/spec-*` worktree whose path is inside `projectPath`:
   - **Skip if plan IN_PROGRESS** (inject an `isPlanActive(slug)` predicate resolved via SpecStore/spec status — MANDATORY gate).
   - **Skip if it is the caller's `currentWorktree`** (threaded from the real caller, not sidecar cwd).
   - Otherwise remove fully (git remove --force → fallback rmSync+prune → branch -D) + DB reconcile. Catches DB-active-present (DB pass) and git-only (git-list pass).
3. **Threading cwd/project:** MCP tool already takes `project`; add `force`; determine `currentWorktree` from the tool's invocation context (or accept it as a param). Sidecar route reads them from the request body. NEVER `process.cwd()` inside the sidecar.
4. **Idempotent/best-effort:** one failed removal doesn't abort; count only successes.

**Tests (bun test — NOT jest, REAL temp git repo — reviewer confirmed the right approach):**
- **Default (no force) unchanged:** present-dir orphan is NOT removed; dir-gone orphan IS. (Locks the preservation guarantee.)
- **force + class 1 (DB-active + present, plan not active):** removed; dir gone; `git worktree list` no longer shows it. FAILS on current code.
- **force + class 2 (git-only, no DB, inside project):** removed. FAILS on current code.
- **Safety — IN_PROGRESS plan:** force set but `isPlanActive`→true → NOT removed.
- **Safety — current worktree:** force set but it's the caller's currentWorktree → NOT removed.
- **Safety — non-sentinal branch (`feature/x`):** NOT touched.
- **Safety — path outside project:** a `sentinal/spec-*` worktree in another project dir → NOT touched by this project's cleanup.
- Real `git init` + `git worktree add` + `git worktree list` assertions (like `worktree-routes.test.ts`).

**Defense-in-depth:** four independent guards prevent over-deletion — (1) opt-in `force`, (2) real-caller cwd exclusion, (3) mandatory IN_PROGRESS-plan exclusion, (4) branch-pattern + inside-project ownership. Any one failing still leaves the others.

## Progress

- [x] Task 1: Write RED tests — default-unchanged, force+both classes, all 4 safety gates (real git repo)
- [x] Task 2: Implement opt-in `force` cleanup + cwd/project threading + IN_PROGRESS gate + tool/sidecar wiring
- [x] Task 3: Verify (full suite, tsc, real-git behavioral, both MCP paths, bundle)
      **Tasks:** 3 | **Done:** 3 | **Left:** 0

## Deferred Issues

- `src/worktree/manager.ts` is 542 lines (over the 400 warn threshold, under the 600 block). It was ALREADY 440 (over warn) before this fix; the force-cleanup pass + helpers added ~100. Splitting the git-worktree helpers (`listGitWorktrees`, `resolveRealPath`, `isInside`, diff parsing) into a `worktree-git.ts` module is a reasonable follow-up refactor but is OUT OF SCOPE for this bugfix (pre-existing length, no behavior change).

### Task 3 Evidence
- Full suite 1706/0; full tsc clean; prettier clean.
- Real-git behavioral tests: force removes present-dir orphans (class 1 + 2); all 4 safety gates hold (IN_PROGRESS, current-worktree, non-sentinal, outside-project); default (no force) byte-unchanged.
- Both MCP paths wired: sidecar route reads force/project/currentWorktree from the request body (never sidecar cwd) + IN_PROGRESS guard via ctx.specStore; direct path builds the guard from the injected store.
- Delivery: fix ships in the `sentinal` BINARY (MCP server + sidecar), confirmed via compile (6 markers). The OpenCode plugin bundle does not use the worktree manager (correct); embed guard passes.

## Tasks

### Task 1: Write Tests

**Objective:** Encode the redesign as failing/locking tests in a REAL temp git repo.
**Files:** `src/worktree/manager.test.ts`
**TDD:** Add a `cleanup() — orphaned present-dir worktrees (force)` describe:
- default (no force): present-dir orphan NOT removed; dir-gone orphan IS (locks preservation).
- force + class 1 (DB-active+present, plan not active): removed → FAILS on current code.
- force + class 2 (git-only, inside project): removed → FAILS on current code.
- safety: IN_PROGRESS plan (isPlanActive→true) NOT removed; caller's currentWorktree NOT removed; `feature/x` branch NOT touched; worktree outside project NOT touched.
Use `git init` + `git worktree add` + `git worktree list` assertions. Run → confirm the two force-class tests FAIL.
**Verify:** `bun test src/worktree/manager.test.ts --verbose`

### Task 2: Implement Fix

**Objective:** Add opt-in orphan cleanup without changing default behavior, with all 4 safety guards, wired through the MCP tool and sidecar (real caller cwd/project, never sidecar cwd).
**Files:** `src/worktree/manager.ts` (`cleanup(opts?)`), `src/worktree/mcp-tools.ts` (`force` param + `isPlanActive` resolver + thread `project`/currentWorktree), `src/sidecar/worktree-routes.ts` + `src/sidecar/client.ts` (`cleanupWorktrees` threads `force`/`project`/currentWorktree via request body).
**TDD:** Implement to green. Default path byte-unchanged. `isPlanActive` resolved via SpecStore/spec status. Confirm sidecar passes the REAL caller cwd (from request), not `process.cwd()`.
**Verify:** `bun test src/worktree/manager.test.ts --verbose`

### Task 3: Verify

**Objective:** Full suite + quality + real-git behavioral + both MCP paths + bundle.
**Verify:** `bun test && bunx tsc --noEmit`; confirm default cleanup unchanged AND `force` removes present-dir orphans via both the direct `manager.cleanup()` and the sidecar `cleanupWorktrees` path; `bun run build:opencode && bun run embed-assets && bun scripts/check-embed-assets.mjs` (fix ships in the bundle).
