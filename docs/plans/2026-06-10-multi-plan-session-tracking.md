# Multi-Plan Session Support: Session-Aware Stop-Guard + Liveness Tracking Fix Plan

Created: 2026-06-10
Status: COMPLETE
Approved: No
Iterations: 2
Worktree: Yes
Type: Bugfix

## Summary

**Symptom:** In a project with multiple concurrent Claude Code / OpenCode instances, the spec-stop-guard fires in Session B because Session A's unrelated plan is `IN_PROGRESS`. In Claude Code this becomes a loop (the agent is repeatedly denied `Stop` and re-prompted with "Active spec plan is IN_PROGRESS… Do NOT stop"), with no toggle to quiet it short of taking over the other session's plan.

**Trigger:** Two (or more) `/spec` sessions open on the same project (with or without worktree isolation). Any session that does NOT own the active plan tries to stop while another session's plan sits in an active status.

**Root Cause:** `src/spec/detect.ts:26` `findActivePlan()` scans `docs/plans/*.md` on the filesystem for ANY plan in an `ACTIVE_STATUS` and returns it. It has no concept of plan ownership. `src/hooks/spec-stop-guard.ts:14` `processSpecStopGuard()` then calls `shouldBlockStop(active.status)` and `denyExit()`s — **without ever consulting `input.session_id`** (which is always present on `HookInput`). So a session is blocked by a plan it does not own. Claude Code's exit-2 deny re-prompts the agent, producing the loop; OpenCode's `session.idle` handler (`targets/opencode/plugins/sentinal.ts:1113`) only logs a warning, so it does not loop but is equally session-blind.

A secondary gap: the user wants each session to "report when it is alive" with staleness checking. The `sessions` table tracks `start_time`/`end_time` only — there is **no `last_active` heartbeat**. `cleanupStaleSessions()` ages sessions by `start_time`, which wrongly marks long-lived sessions stale. Without a reliable liveness signal, "is the plan's owning session still alive?" cannot be answered, which is required for the "own/orphaned" blocking rule.

## Investigation

- `findActivePlan` (`src/spec/detect.ts:26-58`) — pure filesystem scan of `docs/plans/`, reverse-sorted, master-precedence. No DB, no session awareness. Used by **both** targets.
- `processSpecStopGuard` (`src/hooks/spec-stop-guard.ts:14-31`) — has `input.session_id` available but never uses it; calls `denyExit(reason)` on any active plan.
- OpenCode parity: `targets/opencode/plugins/sentinal.ts:1113` `session.idle` calls the same `findActivePlan` + `shouldBlockStop`; a live `sessionId` is in scope (captured at `session.created`, line ~880).
- **Ownership persistence already exists:** `specs.session_id` column (migration V5, `src/memory/migrations.ts:262`) + `idx_specs_session` (V7, line 249). `SpecStore.syncFromPlanFile(planFile, projectPath, sessionId?)` (`src/spec/store.ts:82`) persists it with `COALESCE(excluded.session_id, specs.session_id)` (preserve-on-null). `SpecStore.getSpecsForSession(sessionId)` (line 324) exists.
- **Ownership is dropped at the active-plan sync sites:** `src/cli/commands/hook.ts:232` (`client.syncSpec(active.filePath, input.cwd)`) and `:248` (`specStore.syncFromPlanFile(active.filePath, input.cwd)`) both omit `input.session_id`. So even though the column exists, the running session never stamps itself as owner during normal operation.
- **Liveness primitives exist but are start-time based:** `listSessions({active:true})` / `getActiveSessions()` use `end_time IS NULL` (`src/memory/store.ts:289-313`); `cleanupStaleSessions()` uses `start_time < cutoff` (line 315). `src/session/conflict.ts` already filters active sessions — the pattern to reuse.
- Sidecar surface: `SidecarClient.syncSpec(planPath, projectPath)` (`src/sidecar/client.ts:450`) has no session param yet. Schema is at V10 → new `last_active` column = migration V11.
- **Worktree plan-placement defect (contributing cause, user-reported):** The planning skills (`targets/{opencode,claude-code}/skills|commands` — `spec-plan` Step 1.1 line 94, `spec-bugfix-plan`, `spec-master-plan`) create the worktree first, then generate a **bare relative** `docs/plans/YYYY-MM-DD-<slug>.md` path and run `mkdir -p docs/plans` in the **current CWD (the main checkout)** — they never prefix the path with the worktree root returned by `worktree_create`. Result: a worktree session's plan file is frequently written into the **main checkout's** `docs/plans/`. A main-checkout session's `findActivePlan` then sees that plan and blocks — a direct structural contributor to the cross-session loop. (In this very run the plan was placed correctly only because it was written there by hand.)

## Behavior Contract

### Fix Property (C => P)

**When condition C holds:** Session B requests `Stop`/`session.idle`, and the only active plan(s) in `docs/plans/` are owned by a *different, currently-alive* session (Session A) — not by B.
**Property P must hold:** The stop-guard does NOT block Session B. Session B stops cleanly with no deny/loop.

**Second fix property:** When the active plan is owned by the **current** session, OR is unowned, OR its owner session is **stale/dead**, the stop-guard still blocks (preserving the original safety behavior — a session must not abandon its own in-progress plan).

### Preservation Property (!C => unchanged)

**When condition C does NOT hold (single-session, the common case):** A session with its own active plan is blocked from stopping exactly as before. The deny reason text for owned/orphaned plans is unchanged. No new blocking is introduced for single-session users.

### Degrade-to-Block Property (fail-safe)

The decision must resolve to **block** (preserving today's behavior) in every failure mode — it must never silently allow a stop because ownership/liveness could not be determined:

1. Sidecar unreachable (`SidecarClient.connect()` → null) → fall back to direct `SpecStore`; if that resolves cleanly, use it.
2. Sidecar null **and** direct `SpecStore` throws (DB locked/corrupt/missing) → **block**.
3. Sidecar **reachable but** the ownership route throws or returns a malformed/empty payload → **block**.

The new client method wraps errors so the hook's `catch` defaults to block. Each of the three paths has a test.

## Design Decisions (from plan review — iteration 1)

- **`resolveStopDecision` is READ-ONLY.** It never writes ownership. Ownership is established *only* at sync/register sites (Fix Approach step 5). Consequence: the guard reads ownership that can lag the filesystem by at most one sync cycle. This is made safe by the degrade-to-block fail-safe — a not-yet-stamped plan reads as unowned → **block** (the safe direction), never a spurious allow. Two concurrent live sessions both seeing the same unowned plan therefore both deterministically **block** (no claim race, no write contention). A regression test asserts this.
- **No adoption-on-stop.** We do NOT atomically claim orphans inside the guard. "Orphaned/stale-owner → block" means *this* session is allowed to resume/adopt via the normal `/spec` flow, which stamps ownership through the sync path — not via a hidden write in the stop decision.
- **Staleness window = 45 minutes** (`SESSION_LIVENESS_WINDOW_MS`). `last_active` is bumped on **every** hook that already touches the session in `hook.ts` (PostToolUse-frequent) **and** explicitly on the Stop/idle decision path, so an about-to-stop session counts as alive while its own decision runs. 45 min comfortably exceeds normal think/idle gaps between tool calls while still releasing a truly-dead owner's plan within a reasonable window. Boundary tests cover just-inside / just-outside.
- **`isSessionAlive` is the SOLE liveness authority for the guard.** `cleanupStaleSessions()` (start_time-based) is left **as-is** and explicitly out of scope — it only flips `end_time` for abandoned sessions and is not consulted by the decision. This avoids a dual-source-of-truth. (Documented; not changed.)
- **CC vs OC root divergence is accepted and documented.** CC resolves the candidate via `findGitRoot(input.cwd)` (`spec-stop-guard.ts:20`); OC uses `projectRootForSidecar` (`sentinal.ts:1114`). Both feed the *same* `resolveStopDecision`. Task 3 asserts both targets pass equivalent roots in the common case; the divergence is only observable in nested-git/monorepo edge cases and is noted, not normalized, to keep the fix minimal.

### Worktree vs Same-Checkout Scope

The reported loop is **primarily a same-checkout multi-session** problem: two sessions in the *same* working copy share one `docs/plans/`, so `findActivePlan` returns the same file for both and the non-owner gets blocked. **Worktree sessions are largely insulated already** — each worktree has its own `docs/plans/`, and `findGitRoot` inside a worktree resolves to the worktree root, so two worktree sessions scan **disjoint** plan dirs and never collide on the same plan file.

Ownership rows live in the shared memory DB keyed by `project_path`. **The fix must confirm and assert** that the `project_path` passed to `syncFromPlanFile` is the *checkout root the session actually operates in* (worktree root for worktree sessions, main checkout otherwise), so a worktree session is never blocked by a main-checkout plan and vice-versa. A test with two distinct `searchDir`/`project_path` values proves no cross-worktree blocking.

## Fix Approach

**Strategy:** Make plan-stop decisions session-aware using the existing `specs.session_id` ownership column plus a new liveness signal, and stamp ownership at the points where a session registers/advances its active plan. Apply the user-approved rules: (1) **block only own/orphaned plans** — never block when a different *live* session owns the plan; (2) **assign ownership on register + status change**; (3) **add a `last_active` heartbeat column** for staleness.

Core moves:

1. **Liveness (migration V11 + store):** Add `sessions.last_active INTEGER`. Add `MemoryStore.touchSession(id)` to bump `last_active = now`. Add `isSessionAlive(id, withinMs)` (alive = `end_time IS NULL` AND `last_active` within recency window; fall back to `start_time` when `last_active` is null for pre-V11 rows). Bump `last_active` from the existing session-touch path in `src/cli/commands/hook.ts` (where `insertSession`/session upsert already runs per hook).

2. **Ownership decision logic (new, in `src/spec/detect.ts` or a new `src/spec/ownership.ts` if `detect.ts` would exceed limits):** `resolveStopDecision({ active, currentSessionId, store })` returning block/allow. Rule:
   - No active plan → allow.
   - Plan `session_id` == `currentSessionId` → block (own plan).
   - Plan `session_id` is null/empty → block (orphaned/unowned — claimable by this session).
   - Plan `session_id` is a *different* session that is **alive** → **allow** (the fix).
   - Plan `session_id` is a *different* session that is **stale/dead** → block (orphaned; this session may adopt it).
   - Keep `findActivePlan` (filesystem) for the candidate; read ownership/liveness from the store (specs.session_id + sessions liveness). When no store/sidecar is reachable, **degrade to current behavior** (block on active) so we never silently disable the guard.

3. **Stop-guard wiring (CC):** `processSpecStopGuard` connects via `SidecarClient.connect()` (sibling hooks already do — `src/hooks/memory-observer.ts` etc.), resolves ownership via the sidecar (preferred) or direct `SpecStore` fallback, threads `input.session_id`, and only `denyExit`s when the decision says block. Sidecar gets a `specStopDecision`/ownership lookup route + client method (or extend `syncSpec` path) as needed.

4. **OpenCode parity:** `session.idle` handler uses the same ownership resolution with its in-scope `sessionId`; only logs the warning when the decision is block.

5. **Ownership stamping (ALL sync sites — must be exhaustive):** Thread `session_id`/`sessionId` into every active-plan sync:
   - `src/cli/commands/hook.ts:232` (`client.syncSpec(...)`) and `:248` (`specStore.syncFromPlanFile(...)`) — CC path.
   - `targets/opencode/plugins/sentinal.ts:723` (`sidecar.syncSpec(active.filePath, projectRootForSidecar)` in `experimental.session.compacting`) — **third site found in review**; thread the module-level `sessionId` (declared ~`sentinal.ts:327`). Without this, an OC session that compacts re-syncs its plan and, due to `COALESCE(excluded.session_id, specs.session_id)`, leaves ownership null/stale.
   - `/spec` register path: `src/spec/mcp-tools.ts:114/124` (`syncSpec`/`syncFromPlanFile` called with no session arg) — stamp the registering session where a session id is available (e.g. `SENTINAL_SESSION_ID`).
   - Extend `SidecarClient.syncSpec(planPath, projectPath, sessionId?)` + its route to persist it.
   - The IN_PROGRESS transition already records the owning session via the `phase_change` path in `syncFromPlanFile` once `sessionId` is threaded.

**Files:**
- `src/memory/migrations.ts` — add `migrateV11` (`last_active` column + bump `SCHEMA_VERSION`).
- `src/memory/types.ts` — `SCHEMA_VERSION` bump; `Session.lastActive`; liveness window constant.
- `src/memory/store.ts` — `touchSession`, `isSessionAlive`, deserialize `last_active`, persist on insert/update.
- `src/spec/detect.ts` (or new `src/spec/ownership.ts` if length-bound) — `resolveStopDecision` + helpers.
- `src/hooks/spec-stop-guard.ts` — session-aware, sidecar/store-backed decision.
- `src/cli/commands/hook.ts` — thread `session_id` into sync sites (`:232`, `:248`); bump `last_active` on session touch + on the Stop decision path.
- `src/spec/mcp-tools.ts` — stamp registering session at the `/spec` register path (`:114`/`:124`).
- `src/sidecar/client.ts` + `src/sidecar/routes.ts` — ownership/decision route + `syncSpec(planPath, projectPath, sessionId?)` session param.
- `targets/opencode/plugins/sentinal.ts` — session-aware `session.idle` (`:1113`) **and** ownership stamping at the compaction sync site (`:723`).

**Tests:**
- `src/spec/detect.test.ts` / `src/spec/ownership.test.ts` — full decision matrix (own / unowned / other-live / other-stale / no-plan); **concurrent-orphan race**: two distinct session ids resolving the same unowned plan BOTH return block (read-only, deterministic); **cross-worktree**: two distinct `searchDir`/`project_path` values → a worktree session is NOT blocked by a main-checkout plan and vice-versa.
- `src/memory/store.test.ts` — `touchSession`, `isSessionAlive` (just-inside / just-outside 45-min window, null `last_active` fallback to `start_time`).
- `src/memory/migrations.test.ts` — V11 adds `last_active`, idempotent (re-run no-op), preserves existing rows.
- `src/hooks/spec-stop-guard.test.ts` — does NOT block when a different live session owns the plan; DOES block own/orphaned/stale-owner; **three degrade paths** (sidecar null + SpecStore ok; sidecar null + SpecStore throws → block; sidecar route throws/malformed → block).
- `src/cli/commands/hook.test.ts` — sync sites (`:232`/`:248`) stamp `session_id`; session touch bumps `last_active`.
- `src/sidecar/*-routes.test.ts` — new ownership route (incl. malformed-payload → caller blocks) + `syncSpec` session threading.

**Defense-in-depth:** Decision logic fails safe — any error resolving ownership/liveness falls back to the original "block on active plan" behavior, so a broken DB/sidecar can never silently disable the stop-guard.

## Progress

- [x] Task 1: Write regression + unit tests (RED)
- [x] Task 2: Implement liveness + ownership + session-aware guard (GREEN)
- [x] Task 3: Worktree-scoped plan placement (skills + resolver)
- [x] Task 4: Verify (full suite, tsc, lint, both targets build, live-smoke)
      **Tasks:** 4 | **Done:** 4 | **Left:** 0

## Tasks

### Task 1: Write Tests

**Objective:** Encode the behavior contract as failing tests against existing public entry points before any implementation.
**Files:** `src/spec/detect.test.ts` (or `src/spec/ownership.test.ts`), `src/memory/store.test.ts`, `src/memory/migrations.test.ts`, `src/hooks/spec-stop-guard.test.ts`, `src/cli/commands/hook.test.ts`
**TDD:** Write the decision-matrix + liveness + stamping tests → run → verify they FAIL (functions/columns don't exist yet). Tests must exercise the real entry points (`processSpecStopGuard`, `MemoryStore`, `runMigrations`), not yet-to-exist internals.
**Verify:** `bun test src/spec src/memory/store.test.ts src/memory/migrations.test.ts src/hooks/spec-stop-guard.test.ts` → expect failures.

### Task 2: Implement Fix

**Objective:** Minimal implementation at the root cause to make Task 1 tests pass.
**Files:** `src/memory/migrations.ts`, `src/memory/types.ts`, `src/memory/store.ts`, `src/spec/detect.ts` (+ `src/spec/ownership.ts` if needed), `src/hooks/spec-stop-guard.ts`, `src/cli/commands/hook.ts`, `src/sidecar/client.ts`, `src/sidecar/routes.ts`, `targets/opencode/plugins/sentinal.ts`
**TDD:** Implement V11 migration + liveness store methods → ownership decision → session-aware CC guard → ownership stamping + sidecar route → OpenCode parity. Re-run Task 1 tests to GREEN. Respect the 400-line warn / 600-line block limit — split `detect.ts` into `ownership.ts` if it would exceed 400.
**Verify:** `bun test src/spec src/memory src/hooks/spec-stop-guard.test.ts src/cli/commands/hook.test.ts src/sidecar`

### Task 3: Worktree-Scoped Plan Placement

**Objective:** Ensure a plan created under a worktree is written to **that worktree's** `docs/plans/`, never the main checkout's — removing the structural trigger where a main-checkout session blocks on a worktree session's plan.
**Files:**
- `src/spec/plans-dir.ts` (new) — `resolvePlansDir({ worktreePath })`: returns `<worktreePath>/docs/plans` when a worktree path is provided, else `<cwd>/docs/plans`. Small, pure, testable. Export a `resolvePlanFilePath(slug, date, worktreePath)` convenience.
- `src/index.ts` — barrel export the resolver so skills/CLI can rely on it.
- `targets/opencode/skills/spec-plan/SKILL.md`, `targets/opencode/skills/spec-bugfix-plan/SKILL.md`, `targets/opencode/skills/spec-master-plan/SKILL.md` — Step 1.1: after `worktree_create`, set the plan path **under the returned worktree `path`** (e.g. `<worktree.path>/docs/plans/...`), `mkdir -p` that dir, and write/register there. Add an explicit instruction + example.
- `targets/claude-code/commands/spec.md` (and any CC plan-phase command/agent that mirrors Step 1.1) — same instruction, kept in sync per dual-target rule.
**TDD:** Unit-test `resolvePlansDir`/`resolvePlanFilePath` (worktree path given → worktree dir; absent → cwd dir). Skill `.md` edits are instruction changes (no unit test) but MUST be consistent across all targets; verify by grep that every plan-creation skill references the worktree-scoped path and none emit a bare `docs/plans` write when a worktree exists.
**Verify:** `bun test src/spec/plans-dir.test.ts` + `rg -n "docs/plans" targets/*/skills/spec-*plan*/SKILL.md targets/*/commands/spec.md` shows worktree-scoped guidance everywhere.

### Task 4: Verify

**Objective:** Full regression + quality gates + dual-target build + live-smoke that the actual CC loop is broken.
**Live-smoke (compiled CC dispatcher, not just the exported fn):** After `bun run build:all`, seed a plan owned by a *foreign live* session in a temp project, then pipe a `HookInput` (current session != owner) through the real `sentinal hook shared spec-stop-guard` dispatcher and assert **exit 0 / no deny** — proving the compiled path (not only `processSpecStopGuard`) allows the stop. Contrast: an own/orphaned plan still exits 2. (Per the repo's `sentinal-live-smoke` rule — unit tests can pass while the compiled dispatcher stays old.)
**Verify:** `bun test && npx tsc --noEmit && bun run build:all` + the live-smoke above.
