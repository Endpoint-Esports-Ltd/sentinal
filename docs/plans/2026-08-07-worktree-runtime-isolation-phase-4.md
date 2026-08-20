# Process Ownership — `runtime_up` / `runtime_stop`

Created: 2026-08-07
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature
Parent: 2026-08-07-worktree-runtime-isolation
Wave: 3
Depends: Phase 2, Phase 3

## Summary

**Goal:** Start runtimes in a process group Sentinal owns, record it in a **worktree-local pidfile**, and provide `runtime_stop` that terminates **only** that group. This is what makes "never `pkill -f`" actionable rather than merely advisory — the correct alternative has to exist and be easy.

**Context:** See master plan at `docs/plans/2026-08-07-worktree-runtime-isolation.md` (Phase 4, Wave 3). Resolves Tier 4b of GitHub issue #2. **Depends on Phase 2** (worktree identity) and **Phase 3** (the `up`/`down` commands). Decisions **D3** (Sentinal spawns, because it can only own PIDs it started) and **D5** (pidfile + process group, **not** a supervisor) apply.

## ⚠️ Divergence from issue #2 (D5)

The issue proposes "record PIDs/PGIDs started under a worktree **in Sentinal state**". Implemented literally that meant: `runtime_processes` table + migration V13 + warm registry in `SidecarContext` + `src/sidecar/runtime-routes.ts` + client methods + reconciliation sweep on sidecar start. That is a small reimplementation of `foreman`/`overmind`, and process supervision is unforgiving (zombie reaping, signal forwarding, cross-platform pgid semantics).

**A worktree-local pidfile plus a process group keeps 100% of the ownership property** — a group Sentinal started is still a group Sentinal owns — at roughly a third of the surface. Staleness is checked on read, so no sweep. The file lives in the worktree, so it dies with the worktree. The only capability lost is cross-project querying ("list all running runtimes"), which nothing needs.

**This also dissolves R7:** the sidecar self-terminating when no sessions are active (`src/mcp/server.ts:67`) is irrelevant to a detached process group tracked by a file.

**Explicitly NOT in this phase:** no migration, no new table, no `SidecarContext` change, no sidecar route file, no client method, no reconciliation sweep.

## Scope

### MCP domain

- `runtime_up` — spawn Phase 3's interpolated `up` command **detached into a new process group** (`setsid`-equivalent) + `unref()`, writing `pid` and `pgid` to a worktree-local pidfile, returning **after the `health` check passes** rather than holding the child.
- `runtime_stop` — `kill -- -$PGID` after a liveness + cmdline check. Flag as DESTRUCTIVE in the tool description (precedent: `worktree_cleanup`'s description at `src/worktree/mcp-tools.ts:293-298`).

### Lifecycle execution (D12) — execution half

Phase 3 owns the schema; **this phase owns the state machine**. Full rationale and prior-art comparison in the master plan's "The runtime lifecycle contract".

**⛔ Preflight — an occupied port is a hard failure. Never improvise a different port.** This is step 2 of the incident, and the guidance being replaced (`spec-verify.md:236`) implicitly authorises it.

| Condition                                                   | Action                                                                                                                                                                                          |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pidfile `state=ready`, alive, cmdline matches this worktree | **Reuse** — and flag the run `reused` so teardown leaves it alone                                                                                                                               |
| Pidfile `state=starting`, alive, cmdline matches            | Previous `runtime_up` interrupted mid-startup → tear that group down, then spawn fresh                                                                                                          |
| Pidfile alive, cmdline mismatch (PID reuse)                 | **Fail** — foreign process                                                                                                                                                                      |
| Pidfile leader dead **but recorded port still bound**       | Orphaned group (routine for `npm run` / shell wrappers without `exec`). `kill -- -$PGID` — the pgid outlives the leader — re-probe; if still bound, **fail** naming the pgid. **Do not spawn.** |
| Pidfile stale, port free                                    | Delete it, continue to spawn                                                                                                                                                                    |
| Port occupied, **no** pidfile                               | **Fail loudly.** Never re-port                                                                                                                                                                  |

This is strictly better than Playwright's `reuseExistingServer: !process.env.CI` heuristic, because the pidfile identifies _whose_ process holds the port.

**Startup:**

1. Spawn detached into a new pgid, with **stdout+stderr captured to the log file** (destination set by Phase 3).
2. **Write the pidfile IMMEDIATELY with `state=starting` — before readiness polling, not after.** Writing it only on success leaves the whole startup window (up to 60s) with a detached group and no ownership record, which is the orphan D5 exists to prevent; the next `runtime_up` would then hit "port occupied, no pidfile → fail" and **permanently wedge the worktree**. Flip to `state=ready` in place when the probe passes.
3. Poll the readiness probe every `pollIntervalMs` until `startupTimeoutMs`.
4. **Fail fast only on a NON-ZERO leader exit.** A **zero** exit means a detaching starter (`docker compose up -d`, `pm2 start`, any backgrounding script) — keep polling. Getting this wrong breaks the flagship `docker compose -p sentinal-${SLOT} up -d` case the master plan names as the right answer.
5. On readiness timeout → **run `down` first**, then fail, and **include a log tail in the failure message**.

**Detached runtimes need a different ownership story.** When `up` detaches, the spawned group is a one-shot CLI that has already exited — **the pgid owns nothing**, so `kill -- -$PGID` would silently succeed while the stack keeps running. Therefore:

- `down` is **REQUIRED** when `detached` (Phase 3 carries the flag or infers it from a zero-exit `up`); validation rejects `detached` without `down`.
- For container-backed runtimes the guarantee reduces to _"we ran the declared `down`"_, not _"we own the PIDs"_. Say so in the tool output.

**Teardown — runs on every exit path** (success, test failure, readiness timeout, partial start) — **but only for stacks this invocation started**:

1. **If the stack was `reused`, leave it running** and report that it was reused. Killing a stack we did not start is the same class of error as `pkill -f`. Playwright's `reuseExistingServer` — the prior art this improves on — behaves the same way.
2. `down` if declared, bounded by `graceMs`.
3. `signal` (default SIGTERM) → process group; wait `graceMs`; SIGKILL → process group.
4. Remove the pidfile. **`down` and `runtime_stop` must both be idempotent** — safe when nothing is running, and safe to call twice.

**`down` runs after a failed `up`.** A partial start still started things; compensating teardown is mandatory (`ExecStopPost` / `defer Terminate()` pattern). Testcontainers ships the Ryuk sidecar precisely because in-process cleanup cannot survive a SIGKILL — our equivalent guarantee is the durable pidfile plus the `abandon`/`squashMerge`/`cleanup` sweep below.

**Liveness re-check before declaring a pass.** After tests complete, verify the process group is still alive. "Tests green but the server died mid-run" is a false pass and must be reported as a failure.

- Staleness is evaluated **on read**: `process.kill(pid, 0)` plus a cmdline check that the process still references the worktree path.
- Registered in `createSentinalServer` alongside Phase 3's `runtime_config`.
- Pidfile logic in its own module, **not** in `manager.ts` (542/600 lines, R4).

### Stop-on-exit — all directory-removing paths, not just cleanup

`abandon` (`src/worktree/manager.ts:276`) and `squashMerge` (`:230`) are the **normal** end-of-spec exits and both remove the worktree from disk. A tracked process whose cwd has just been deleted is exactly the orphan this tier exists to prevent, and would be left running with a stale row pointing at a nonexistent path. `worktree_cleanup` is the _least_ likely of the three to be the real exit path.

Both must stop the owned process group (or hard-fail with an actionable message) **before** `git worktree remove`. Add one test per exit path, mirroring Phase 2's per-exit-path strategy for slot release.

### Persistence — a file, not a table

- **Worktree-local pidfile** holding `pid` and `pgid`. Precedent for the shape: `src/sidecar/lifecycle.ts` (`readSidecarPid` `:18-28`, `removeSidecarPid` `:30-37`, `cleanupSidecarFiles` with its PID-ownership guard `:211-231`) and `src/dashboard/lifecycle.ts`.
- Excluded from git the same way as Phase 2's env files — the worktree's `.git/info/exclude` (D1).
- **No migration.** V12 (Phase 2) remains the only schema change in this master plan.

### `worktree_cleanup` warning

Add a **5th guard** to `forceCleanupOrphans` (`src/worktree/manager.ts:401-450`; existing four: branch prefix `:415`, path inside project `:417`, not `currentWorktree` `:419`, not `isPlanActive` `:423`) plus a new `CleanupOptions` field (`:34-57`).

**Thread it from both entry points** — the MCP tool arg (`src/worktree/mcp-tools.ts:323-328`) _and_ the sidecar **request body** (`src/sidecar/worktree-routes.ts:82-105`). Never `process.cwd()` inside the sidecar: that is the sidecar's own cwd, not the caller's. This exact trap was caught by a prior plan review — see memory observations #422 and #424.

## Known Constraints

- **PID-reuse safety is mandatory.** The canonical pattern already exists at `tests/e2e/harness/sandbox.ts:321-335`: confirm the PID's command line still references the expected path before killing. Same ownership re-check appears at `src/sidecar/lifecycle.ts:211-231` and `src/sidecar/server.ts:455-466`. `isProcessAlive(pid)` via `process.kill(pid, 0)` is at `src/sidecar/lifecycle.ts:42-49`.
- **R7 — orphaning risk: dissolved by D5**, not merely mitigated. A detached process group tracked by a worktree-local file is unaffected by the sidecar's lifecycle. Detached-spawn precedent: `autoStartSidecar` at `src/sidecar/lifecycle.ts:161-175`.
- **R10 — catalog drift.** `.sentinal/rules/sentinal-mcp-servers.md` states "28 tools across 6 domains" and carries a post-add smoke-test checklist. Update counts and the domain table for `runtime_up` / `runtime_stop`, and run the checklist.
- **R4 — `manager.ts` is 542/600 lines.** Pidfile logic goes in its own module, not the manager. Consider finally splitting the git helpers out of `manager.ts` (already deferred once by `docs/plans/2026-07-24-worktree-cleanup-orphan-gap.md`).
- No general spawned-process registry exists today — only three independent single-PID-file managers (`src/sidecar/lifecycle.ts`, `src/dashboard/lifecycle.ts`, and `autoStartProcess`/`stopProcess` at `targets/opencode/plugins/sentinal.ts:188-233`). This phase makes a fourth, deliberately following the same shape rather than inventing a registry.
- Nearest existing "session still owns in-flight work" precedent: `src/hooks/stop-background.ts:22-27, 51-60`.
- **Cross-platform pgid semantics must be verified**, not assumed — `setsid`/`detached` behaviour and `kill -- -PGID` differ between macOS and Linux. Test on both or state the supported platform.
- Tests spawning subprocesses need an explicit `it(..., timeout)` matching the subprocess timeout (`bun test` default is 5s).

## Out of Scope

- **Blocking destructive commands.** Per D4 no guard is built at all — shell safety is user configuration, shipped as opt-out permission defaults in Phase 1. This phase's contribution to that problem is making the _correct alternative_ trivially available.

## Inherited from Phase 3 (do not rediscover mid-implementation)

- **⛔ Split `src/worktree/manager.ts` FIRST — it is a prerequisite task, not a constraint.** It sits at **582/600** and this phase must touch it for _both_ R11 population _and_ `runtime_up`/`runtime_stop`.
- **R11 population is three one-line edits.** Phase 3 landed the seam (`SeedOptions.sharedResources?: string[]` threaded into `notIsolatedWarning`, with tests for both paths) but **could not populate it** — the only three `seedWorktreeConfig` call sites are `manager.ts:171`, `:448`, `:485`. **DoD:** each passes `sharedResources: loadRuntimeConfig(worktreePath).sharedResources`, and a test asserts a seeded worktree's warning names the declared shared resources. Until then the seam has **zero production effect**.
- **Log contract is fixed:** `RUNTIME_LOG_RELATIVE_PATH = ".sentinal/runtime.log"`, `RUNTIME_LOG_TAIL_LINES = 50`, hidden via `excludeFromGit` — **never** `.git/info/exclude` (disproven; leaks into the main checkout).
- **Two expansion layers:** Sentinal's load-time substitution wins. Phase 4 should _additionally_ export `SENTINAL_WORKTREE_SLOT` into the spawn env for scripts invoked by `up` (purely additive).

## Master DoD Contribution

Steps 3, 4 and 5: pid/pgid recorded in worktree A's pidfile; `runtime_stop` in A terminates only A's process group while a process from worktree B survives; `abandon` and `squashMerge` stop the owned group before removing the directory.

---

## Post-Verification Corrections (2026-08-09)

The master-DoD verification pass found four claims in this plan that did not hold, plus one process error by the orchestrator. Recorded rather than quietly fixed:

1. **`src/sidecar/client.ts` was NOT "untouched at 582".** `main` has **573** lines; the file is 582 after a `Worktree` → `ResolvedWorktree` change (+11/−2) made in Phase 3 to carry `warnings`. Every "untouched at 582" assertion in this plan and in the orchestration was checking the wrong baseline — 582 was the *expectation*, never the starting point. The change itself is harmless and intended; the claim was false.
2. **Phase 4 was marked VERIFIED while the enumeration-safety fix was uncommitted.** The `GroupProbeResult` `members`-vs-`unknown` distinction — the fix for the review's only `must_fix` — existed solely in the working tree. A `worktree_sync` at that moment would have **silently discarded it** and shipped the `partial` version under a VERIFIED checkbox. Committed as `b8dc925`.
3. **The `.env` seeding path never runs the typo check `interpolate.ts` exists for.** A `.env.example` containing `${SENTINAL_WORKTREE_SLOTT}` is seeded **verbatim**, with only the generic "contains no `${SENTINAL_WORKTREE_SLOT}` placeholder" warning. `unknownSentinalTokens()` is applied to `runtime.json` fields only. DoD item 2's literal "no unsubstituted `${` token" is therefore **not** guaranteed on the seeding path.
4. **`src/runtime/preflight.ts` has no companion `preflight.test.ts`**, contrary to the repo's TDD rule. Covered indirectly via `lifecycle.test.ts` / `ownership.test.ts`, but not directly.
5. **`tests/e2e/permission-defaults.e2e.ts` — the only live proof of master DoD item 9 — is run by nothing.** It is absent from `package.json`'s `e2e` script and from `pre-release`. The unit test guards the *input* JSON; nothing in CI exercises the resolution the item turns on.

Items 3, 4 and 5 are **open** and are recorded in the master plan's residual risks or as follow-ups. Items 1 and 2 are resolved.

## Context for Implementer

> Waves 1 and 2 are landed and COMMITTED (HEAD `97a5de4`). **All line numbers below were re-verified against the worktree on 2026-08-08** — the stub's original numbers were pre-Phase-3 and are corrected here.

### ⛔ Corrections to this plan's earlier line numbers

| Earlier claim                                                     | Actual                                                                                          |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `manager.ts` 542/600                                              | **582/600**                                                                                     |
| `abandon` `:276`                                                  | **`:324-352`**; removes dir at `:332-335`, fallback `rmSync` `:339-340`                         |
| `squashMerge` `:230`                                              | **`:275-322`**; removes dir at `:315` (**no `--force`**); `git checkout base` at `:303`         |
| `forceCleanupOrphans` `:401-450`                                  | **`:524-581`**; removal at `:558-561`                                                           |
| guards `:415/:417/:419/:423`                                      | **`:546` / `:548` / `:550` / `:554`**                                                           |
| `CleanupOptions` `:34-57`                                         | **`:42-66`**                                                                                    |
| `worktree_cleanup` DESTRUCTIVE description `mcp-tools.ts:293-298` | **`:318-324`**; arg shape `:325-334`; direct call `:349-354`; sidecar call `:341-343`           |
| sidecar cleanup body `worktree-routes.ts:82-105`                  | **`:98-115`** (function `:94-117`)                                                              |
| `sandbox.ts:321-335`                                              | **`processBelongsToSandbox` `:320-331`**, `trySignal` `:333-339`                                |
| "three `seedWorktreeConfig` call sites"                           | `:171` is `seedWorktreeConfig`; **`:448` and `:485` are `seedNonFatally`** (same `SeedOptions`) |

### What Phase 3 already gives you — do not rebuild it

| Need                                                                       | Use                                                                                                    | Location                               |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| The whole contract, validated + **already slot-interpolated**              | `loadRuntimeConfig(projectPath): LoadedRuntimeConfig` — **never throws**; absent file is inert success | `src/runtime/loader.ts:134`            |
| Shared-resource names for R11                                              | `LoadedRuntimeConfig.sharedResources` (or `sharedResourceNames(config)`)                               | `loader.ts:47-72`, `schema.ts:298`     |
| Log path + tail length                                                     | `RUNTIME_LOG_RELATIVE_PATH = ".sentinal/runtime.log"`, `RUNTIME_LOG_TAIL_LINES = 50`                   | `src/runtime/schema.ts:77`, `:86`      |
| Hide pidfile + logfile from git                                            | `excludeFromGit(worktreePath, relPaths): ExcludeResult` — **never throws**                             | `src/worktree/git-exclude.ts:213`      |
| Liveness                                                                   | `isProcessAlive(pid)` — **exported** here (the sidecar copy is private)                                | `src/dashboard/lifecycle.ts:48-55`     |
| PID-reuse-safe ownership check                                             | `processBelongsToSandbox` pattern — `ps -o command= -p <pid>` and refuse to kill if unverifiable       | `tests/e2e/harness/sandbox.ts:320-331` |
| PID-ownership guard before deleting a pidfile                              | `cleanupSidecarFiles`                                                                                  | `src/sidecar/lifecycle.ts:211-218`     |
| Readiness-poll precedent (deadline + child-exit + final probe after death) | `waitForDashboardHealthy`                                                                              | `src/dashboard/lifecycle.ts:274-313`   |

**`RuntimeConfig` post-parse shape** (`schema.ts:267`): `detached` is **always present** (default `false`); `readiness.startupTimeoutMs` (60000) and `pollIntervalMs` (250) always present; `shutdown.signal` (`SIGTERM`) and `graceMs` (10000) always present. Two refinements are **already enforced** — `up` requires `readiness`, and **`detached: true` requires `down`** — so Phase 4 must not re-validate them.

### 🎯 `Bun.spawn` supports `detached` natively — no shell wrapper needed

`node_modules/bun-types/bun.d.ts:6494-6508`: on **POSIX it calls `setsid()`**, so the child becomes a session **and** process-group leader → **`pgid === pid`**. On **Windows it sets `UV_PROCESS_DETACHED` and creates NO process group.** Therefore:

- Spawn (note: `unref()` returns void, so **do not chain it** — `.pid` is the whole payload):
  ```ts
  const proc = Bun.spawn(cmd, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd,
    env,
  });
  const pid = proc.pid; // write the pidfile (state="starting") HERE,
  proc.unref(); // before the first readiness poll
  ```
- **⚠️ `bun.d.ts:6503-6504` — inside the very docblock that promises `setsid()` — warns: _"stdio may keep the parent process alive. Pass `stdio: ["ignore","ignore","ignore"]` … to prevent this."_** The shape above passes a real **file descriptor**, not a pipe, which is plausibly safe — but **that is an assumption, not a fact**, and if wrong the MCP server hangs on exit after every `runtime_up`. **Verify empirically (Task 3).** Fallback if it does hold the parent: spawn with all-ignore stdio and let the child redirect — `sh -c 'exec <cmd> >> <log> 2>&1'`.
- **Model `pgid` as `number | null`.** `bun.d.ts:6500-6501` says only that Windows _"allows the child to outlive the parent and receive signals independently"_ — it makes **no process-group guarantee**, so `pgid` must be modelled as `null` there rather than assumed absent _or_ present. (An earlier draft asserted Windows "creates NO process group"; that overreads the source.)
- There is **no `setsid`, no `kill -- -PGID`, no `killpg`, no `getpgid`** anywhere in the repo today. This is new ground; the three existing `detached: true` spawns (`src/opencode/dashboard-ensure.ts:141`, `targets/opencode/plugins/sentinal.ts:207`, `src/sidecar/self-heal.ts:84`) are all fire-and-forget with no pgid capture.

### ⛔ Hard constraints

- **`src/worktree/manager.ts` is 582/600.** Task 1 splits it **first**; nothing else may touch it until that lands.
- **`src/sidecar/client.ts` is 582/600 and must stay untouched** — D5 forbids a sidecar route anyway.
- **`src/runtime/mcp-tools.ts` is 212 lines. Adding both new tools there breaches 400** — put them in a sibling module and have `registerRuntimeTools` call it, so `src/mcp/server.ts:58` needs no change.
- `src/runtime/scaffold.ts` 379, `src/worktree/slots.ts` 402, `src/worktree/mcp-tools.ts` 365 — all near warn.
- **`tests/e2e/harness/sandbox.ts` (347) is NOT a `.test.ts`, so it is NOT length-exempt.**

### Testing

- `bun test` default timeout is **5s**. **Shrink the config in tests** (`startupTimeoutMs: 500`, `pollIntervalMs: 50`, `graceMs: 100`) rather than passing `it(..., 70_000)` — the defaults are 60s/250ms/10s.
- **The pidfile `state=starting` is itself a concurrency guard.** A timed-out test leaving one behind cascades into every later test in the describe — this is Pattern 2 in `.opencode/skills/sentinal-test-timing/SKILL.md`. Use a **fresh temp worktree per test** (`beforeEach` mkdtemp, as `manager.test.ts` does), never a shared fixture.
- Real-spawn precedent: `tests/e2e/permission-defaults.e2e.ts:196-234` (random high port, poll-with-deadline, `finally { proc.kill() }`). Note `.e2e.ts` is excluded from default discovery — Phase 4 needs **in-suite** tests too.

### Pre-existing defect found during recon

**`worktree_cleanup` never threads `currentWorktree`** — the sidecar path sends only `{ force }` (`mcp-tools.ts:341-343`) and the direct path omits it (`:349-354`). **Guard 3 ("never the caller's current worktree") is therefore dead in production today.** Task 5 adds guard 5 to the same function; fix guard 3 while you are there, or state explicitly why not.

## Assumptions

- `Bun.spawn({detached:true})` yields `pgid === pid` on POSIX — supported by `bun.d.ts:6494-6508`; **verify empirically in Task 3** — Tasks 3, 4.
- `.sentinal/`-relative paths hit `excludeFromGit` **tier 1 (inherited)** in a Sentinal-installed project, because `.sentinal/.gitignore` denies all with `*` (`src/memory/shared.ts:272-284`) — Task 2.
- `loadRuntimeConfig` never throws and returns interpolated commands — `loader.ts:22-28`, `:182-186` — Tasks 3, 4.

## Risks and Mitigations

| Risk                                                                                                                                                    | Likelihood | Impact     | Mitigation                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------- | --------------------------------------------------------------------------------------------------------------------- |
| **The R11 DoD is unimplementable as originally written** — the no-module-cycle guard forbids `src/worktree/**` importing `src/runtime/**` or the barrel | Certain    | High       | Task 6 injects as **data** via `sharedResourcesFor?: (worktreePath) => string[]`; the guard stays intact              |
| `manager.ts` trips the 600 block mid-phase                                                                                                              | High       | High       | Task 1 is a **gating prerequisite**; target ≈350 lines before any other task touches it                               |
| A test leaves a `state=starting` pidfile and cascades                                                                                                   | Medium     | Medium     | Fresh temp worktree per test; shrunk timeouts; assert cleanup in `afterEach`                                          |
| Killing a PID the worktree does not own                                                                                                                 | Medium     | **Severe** | Cmdline verification before every signal (`sandbox.ts:320-331`); **refuse to kill when ownership cannot be verified** |
| Windows silently doing the wrong thing                                                                                                                  | Medium     | Medium     | `pgid: number \| null`; `runtime_stop` degrades to the declared `down` and **says so in its output**                  |
| `squashMerge` failing because a live process holds files                                                                                                | Medium     | Medium     | Stop **before** `git checkout base` (`:303`), not just before `worktree remove` (`:315`)                              |

## Pre-Mortem

1. **The pidfile is written but the process is unkillable** (Task 4) → Trigger: `runtime_stop` reports success while `ps` still shows the tree. Cause: `pgid` captured as `pid` on a platform where `setsid()` did not run.
2. **Stop-on-exit deadlocks the exit path** (Task 5) → Trigger: `abandon` hangs for `graceMs` on every call, including worktrees that never started a runtime. The stop must be a **no-op fast path** when no pidfile exists.
3. **R11 injection silently no-ops** (Task 6) → Trigger: a seeded worktree's warning still says "may not be isolated" without naming resources, because one of the four construction sites was missed. Assert per-site.

## Execution Waves

**Wave 1** — Foundations: Task 1 (split `manager.ts`) and Task 2 (pidfile module). Disjoint — Task 1 is `src/worktree/`, Task 2 is new `src/runtime/`.
**Wave 2** — Engine + injection: Task 3 (`src/runtime/` spawn/readiness/teardown) and Task 6 (R11 wiring: `manager.ts`, `src/mcp/server.ts`, `src/worktree/mcp-tools.ts`, `src/sidecar/worktree-routes.ts`, `src/cli/commands/worktree.ts`). Disjoint.
**Wave 3** — Surface: Task 4 (MCP tools, `src/runtime/` + `src/index.ts`) and Task 5 (stop-on-exit + guard 5, `manager.ts`/`cleanup.ts` + worktree tool + sidecar route). Disjoint by file. **Neither may touch `targets/**` or `embedded-assets.ts`.** Per-task `Verify` commands are **advisory only** in this wave — the tree contains the other task's half-finished edits. Run the gate ONCE after both land:

```
bun test && bunx tsc --noEmit && test $(wc -l < src/worktree/manager.ts) -lt 400
```

**Wave 4** — Task 7 (docs) alone. It **regenerates `src/cli/embedded-assets.ts`** via `embed-assets`, so it cannot share a working directory with Tasks 4/5 (an earlier draft claimed Wave 3 "regenerates nothing" — false). It already depends on Task 4 anyway, so a solo wave costs nothing.

## Goal Verification

### Truths

1. `runtime_up` in worktree A writes `<A>/.sentinal/runtime.pid` containing a pid and (POSIX) a pgid, and the file is invisible to `git status`.
2. `runtime_stop` in A terminates A's process group; a process started from worktree B **survives**.
3. `runtime_up` on an occupied port with **no** pidfile **fails** — and no alternative port is attempted anywhere in the code path.
4. A leader exiting **non-zero** before readiness fails fast; a leader exiting **zero** (detaching starter) continues polling.
5. `abandon` and `squashMerge` on a worktree with a live owned group stop it **before** removing the directory.
6. `runtime_stop` refuses to signal a PID whose cmdline does not reference the worktree.
7. A seeded worktree whose `runtime.json` declares `"database": "shared"` produces a `notIsolatedWarning` naming `database`.
8. `src/worktree/manager.ts` is **under 400 lines**, and `src/worktree/**` still imports nothing from `src/runtime/**`.

### Artifacts

| Artifact                             | Provides                                              | Exports                                        |
| ------------------------------------ | ----------------------------------------------------- | ---------------------------------------------- |
| `src/worktree/cleanup.ts`            | Extracted cleanup + orphan pass + guard 5             | `CleanupOptions`, `cleanupWorktrees`           |
| `src/worktree/reconcile.ts`          | Extracted reconcile + slot assurance                  | `resolveWithReconcile`, `ensureSlot`           |
| `src/runtime/pidfile.ts`             | Read/write/stale-check the worktree pidfile           | `readPidfile`, `writePidfile`, `removePidfile` |
| `src/runtime/spawn.ts`               | Detached spawn into a new process group + log capture | `spawnDetached`                                |
| `src/runtime/readiness.ts`           | Poll `http`/`exec` probes with fail-fast              | `awaitReadiness`                               |
| `src/runtime/teardown.ts`            | `down` → SIGTERM → grace → SIGKILL, ownership-checked | `stopOwnedGroup`                               |
| `src/runtime/lifecycle-mcp-tools.ts` | `runtime_up` / `runtime_stop`                         | `registerRuntimeLifecycleTools`                |
| `src/runtime/preflight.ts`           | The D12 preflight matrix (added in Task 4, for length) | `preflight`                                    |
| `src/worktree/cleanup-mcp-tool.ts`   | `worktree_cleanup` (added in Task 5, for length)      | `registerWorktreeCleanupTool`                  |

### Key Links

| From                                 | To                          | Via           | Pattern                  |
| ------------------------------------ | --------------------------- | ------------- | ------------------------ |
| `src/runtime/lifecycle-mcp-tools.ts` | `src/runtime/spawn.ts`      | start         | `spawnDetached`          |
| `src/runtime/teardown.ts`            | `src/runtime/pidfile.ts`    | ownership     | `readPidfile`            |
| `src/worktree/manager.ts`            | runtime teardown            | stop-on-exit  | `stopOwned\|runtimeStop` |
| `src/mcp/server.ts`                  | `src/worktree/mcp-tools.ts` | R11 injection | `sharedResourcesFor`     |

## Progress Tracking

- [x] Task 1: Split `manager.ts` — GATING PREREQUISITE (Wave 1) — **255 lines** (A + B were not enough at 354; `create()` was extracted too, per the plan's own fallback)
- [x] Task 2: Worktree pidfile module + git exclusion (Wave 1) — plus `src/runtime/ownership.ts` (see note below)
- [x] Task 3: Spawn + readiness + teardown engine (Wave 2) — both empirical questions answered; see "Empirical results" below
- [x] Task 6: Manager DI — R11 shared resources + runtime stop hook (Wave 2) — **three** deps injected, not two; see the task's "Deviations"
- [x] Task 4: `runtime_up` / `runtime_stop` MCP tools (Wave 3) — plus `src/runtime/preflight.ts` (split for length); two real macOS bugs found, see the task's "Empirical findings"
- [x] Task 5: Stop-on-exit for abandon/squashMerge/cleanup + guard 5 (Wave 3) — `abandon`/`squashMerge` became **async**; a failed stop **aborts** the exit path
- [x] Task 7: Documentation + MCP catalog (**Wave 4**)

**Total Tasks:** 7 | **Completed:** 7 | **Remaining:** 0

## Implementation Tasks

### Task 1: Split `manager.ts` — GATING PREREQUISITE

**Objective:** Get `manager.ts` from 582 to **≤330 lines** so the rest of the phase has room. **No other task may touch it until this lands.** ⚠️ ≈350 is _not_ enough headroom: Task 6 adds ~10 lines at seed site `:171` and Task 5 adds ~20-30 to `abandon`/`squashMerge` (this codebase runs ~60% comment lines in those methods), which would land at ~390 against a 400 Truth. If A+B alone miss 330, also extract `create()`'s rollback envelope or the `squashMerge` conflict pre-checks.
**Dependencies:** None
**Wave:** 1

**Files:**

- Create: `src/worktree/cleanup.ts`, `src/worktree/reconcile.ts` (+ tests)
- Modify: `src/worktree/manager.ts`, `src/worktree/manager.test.ts`

**Key Decisions / Notes:**

- **Extract A → `cleanup.ts`:** `CleanupOptions` (`:42-66`) + `cleanup` (`:492-522`) + `forceCleanupOrphans` (`:524-581`) ≈ **114 lines**, net saving ≈106. Leave a 3-4 line delegating `cleanup()` on the manager. `CleanupOptions` has **zero external consumers** (`rg` matches only `manager.ts:43,498,534`; callers pass object literals) — but **re-export it from `manager.ts`** for hygiene.
- **Extract B → `reconcile.ts`:** `resolveWithReconcile` (`:354-457`) + private `ensureSlot` (`:459-490`) ≈ **136 lines**, net ≈126. Both are pure functions of `(store, config, …)`; `resolveWithReconcile` calls `ensureSlot` (`manager.ts:381`), which **moves with it** — no _other_ manager method is referenced. This carries 2 of the 3 R11 seed sites with it.
- **Do NOT extract `squashMerge`/`abandon`** — Task 5 edits both, and keeping them together with the other "stop before remove" site is clearer than a third module.
- Precedent for verbatim extraction: `diff-parse.ts:4` and `disk-scan.ts:5` both say "Extracted verbatim from `manager.ts`".
- Split `manager.test.ts` (1127 lines, exempt) along the same lines: `cleanup` `:314` + `cleanup(force)` `:343` → `cleanup.test.ts`; `resolveWithReconcile` `:444` + `slots` `:514` → `reconcile.test.ts`.

**Definition of Done:**

- [ ] `manager.ts` **≤330 lines** (not merely <400 — Wave 3 adds code back)
- [ ] Behaviour byte-identical — no logic changes, extraction only
- [ ] `CleanupOptions` still importable from `manager.ts`
- [ ] `src/worktree/**` still imports nothing from `src/runtime/**` (guard green)
- [ ] Full worktree + sidecar suites pass unchanged

**Verify:**

- `bun test src/worktree/ src/sidecar/worktree-routes.test.ts && bunx tsc --noEmit`
- `test $(wc -l < src/worktree/manager.ts) -lt 400`

---

### Task 2: Worktree pidfile module + git exclusion

**Objective:** A durable, ownership-verifiable record of what this worktree started. **This is the reaper record** — D5's entire substitute for a supervisor.
**Dependencies:** None
**Wave:** 1

**Files:**

- Create: `src/runtime/pidfile.ts`, `src/runtime/pidfile.test.ts`
- Modify: `src/runtime/schema.ts` (add `RUNTIME_PIDFILE_RELATIVE_PATH` beside `:77`; `schema.test.ts:41-45` already asserts the sibling constants — add a parallel assertion)

**Key Decisions / Notes:**

- Path: `<worktree>/.sentinal/runtime.pid`, beside Phase 2's `.sentinal/worktree.env`. Define the constant next to `RUNTIME_LOG_RELATIVE_PATH` (`schema.ts:77`).
- Shape: `{ pid, pgid: number | null, startedAt, command, state: "starting" | "ready" }`. **`pgid` is `null` on Windows** — model it, do not fake it.
- **⛔ Written on SPAWN with `state="starting"`, flipped to `"ready"` on probe success.** Writing only on success leaves the whole startup window with no ownership record — the orphan D5 exists to prevent — and then trips "port occupied, no pidfile → fail", wedging the worktree.
- **Ownership verification before any signal:** copy `processBelongsToSandbox` (`tests/e2e/harness/sandbox.ts:320-331`) — `ps -o command= -p <pid>`, and **return false (do not kill) if verification fails**. Liveness via the exported `isProcessAlive` (`src/dashboard/lifecycle.ts:48-55`).
- **PID-ownership guard before deleting the file:** re-read and refuse if a different pid now owns it (`src/sidecar/lifecycle.ts:211-218`).
- **⚠️ IMPLEMENTATION NOTE (2026-08-08) — `processBelongsToSandbox` does not generalise.** The plan says to copy `sandbox.ts:320-331`, which checks only `ps -o command=`. That works in the harness because the sandbox HOME appears in every command line it cares about. It **fails for a realistic `up`**: `npm run dev` execs into a `node` whose argv references the worktree nowhere, so a literal copy would report every runtime as "not owned" and `runtime_stop` would refuse to do anything, ever. Ownership therefore also probes the process's **cwd** (`/proc/<pid>/cwd` on Linux, `lsof -a -d cwd -p <pid> -Fn` on macOS/BSD), which is durable because `spawnDetached` starts the group inside the worktree and cwd is inherited. Either probe matching is proof; **neither matching, or either failing, is still a refusal.** This lives in a new `src/runtime/ownership.ts` (an addition to the plan's artifact table) so `pidfile.ts`, `teardown.ts` and the Task 4 orphan-reap all share one gate.
- Hide it with `excludeFromGit(worktreePath, [".sentinal/runtime.pid", ".sentinal/runtime.log"])`. In a Sentinal-installed project this hits **tier 1 (inherited)** and writes nothing, because `.sentinal/.gitignore` denies all with `*` (`src/memory/shared.ts:272-284`). **Surface `ExcludeResult.warnings` — do not swallow tier-3 refusals.**

**Definition of Done:**

- [ ] Round-trips `pid`/`pgid`/`state`; `pgid` is `null` on Windows
- [ ] A stale pidfile (dead pid) is detected as stale
- [ ] A live pid whose **cmdline does not match** the worktree is reported **not owned**
- [ ] Ownership unverifiable (e.g. no `ps`) → treated as **not owned**, never killed
- [ ] Neither pidfile nor logfile appears in `git status`; tier-3 warnings surfaced

**Verify:**

- `bun test src/runtime/pidfile.test.ts`

---

### Task 3: Spawn + readiness + teardown engine

**Objective:** The D12 state machine, as testable functions independent of MCP plumbing.
**Dependencies:** Task 2
**Wave:** 2

**Files:**

- Create: `src/runtime/spawn.ts`, `src/runtime/readiness.ts`, `src/runtime/teardown.ts` (+ tests)

**Key Decisions / Notes:**

- **Spawn:** `Bun.spawn(cmd, { detached: true, stdio: ["ignore", logFd, logFd], cwd, env })` then `.unref()`. POSIX `setsid()` ⇒ `pgid === pid` — **verify this empirically in a test rather than assuming it.** Also export `SENTINAL_WORKTREE_SLOT` into the spawn env (master D12; purely additive).
- **Logs:** capture stdout+stderr to `RUNTIME_LOG_RELATIVE_PATH` (`schema.ts:77`). **Log capture is a safety feature** — an agent facing a failed `up` with no logs improvises, which is the incident. Every failure return carries a `RUNTIME_LOG_TAIL_LINES`-line tail (`schema.ts:86`).
- **Readiness:** poll `readiness.target` every `pollIntervalMs` until `startupTimeoutMs`. Support `http` (status in `expectStatus`, default 2xx-3xx) and `exec` (exit 0) — those are the only two v1 types.
  - **Leader exits NON-ZERO → fail fast.** Do not wait out the budget.
  - **Leader exits ZERO → detaching starter → KEEP POLLING.** `docker compose up -d` exits 0 by design and is the flagship case.
  - Mirror `waitForDashboardHealthy` (`src/dashboard/lifecycle.ts:274-313`), including its **final probe after child death**.
- **Teardown:** run `down` if declared (bounded by `graceMs`) → `signal` to the group → wait `graceMs` → SIGKILL. **POSIX only.** On Windows, `pgid` is `null`: run `down` and say so in the output.
  - **Detached runtimes:** the spawned leader has already exited, so the pgid owns nothing — `down` is the real mechanism. Schema already enforces `detached ⇒ down`.
  - **⛔ Windows + `detached: false` + no `down` has NO teardown mechanism.** That config is schema-valid (the `detached ⇒ down` refinement does not fire), and on Windows `pgid` is `null`, so there is neither a group to signal nor a command to run. `runtime_stop` **MUST fail with an explicit unsupported-configuration error naming the pid** — never report success. Simpler alternative, consistent with Task 7's POSIX-only statement: have **`runtime_up` refuse to spawn** on Windows without a declared `down`. Pick one and state it.
  - **Never signal without ownership verification.**
  - **Idempotent:** safe when nothing is running, safe twice.
- **Liveness re-check (D12) is owned HERE.** Export `assertStillAlive(worktreePath): { alive: boolean; reason?: string }`. "Tests green but the server died mid-run" is a **false pass** and must be reportable as a failure. Without an exported surface this stays unowned prose.
- Tests: shrink to `startupTimeoutMs: 500`, `pollIntervalMs: 50`, `graceMs: 100`. Fresh temp worktree per test.

**Definition of Done:**

- [x] POSIX: spawned child's `pgid === pid` — **asserted, not assumed** (`spawn.test.ts`, cross-checked against `ps`)
- [x] Non-zero early exit fails fast (well under the budget); zero exit keeps polling
- [x] Readiness timeout runs `down`, then fails **with a log tail** — engine parts landed here (`awaitReadiness`, `stopOwnedGroup`, `readLogTail`); the **composition** is `runtime_up` and is asserted in Task 4
- [x] `stopOwnedGroup` kills the group; a process outside it survives
- [x] Teardown is idempotent and a no-op when no pidfile exists
- [x] **`assertStillAlive` reports a group that died mid-run as a failure, not a pass**
- [x] Windows path degrades to `down` and reports it
- [x] **Windows + `pgid === null` + no `down` → returns a FAILURE naming the pid, not a false success**
- [x] **A parent process that calls `spawnDetached` exits promptly** — asserted by spawning a fixture parent as a subprocess and awaiting its exit on a short deadline (guards the `bun.d.ts:6503` stdio warning)
- [x] **Dead leader + recorded pgid whose live members do NOT reference this worktree → refuses to signal**, and fails naming the pgid

**Empirical results (2026-08-09, Bun 1.3.10 / macOS arm64) — the two questions the plan refused to let the implementer assume:**

1. **`Bun.spawn({detached:true})` DOES yield `pgid === pid` on POSIX.** Confirmed against `ps -o pgid=`, and asserted permanently in `spawn.test.ts`. One caveat the plan did not anticipate: a leader that exits immediately (the `docker compose up -d` shape) can be reaped before `ps` answers, so `spawnDetached` falls back to `pid` on POSIX — `resolvePgid` itself stays honest and returns `null`. Safety is unaffected because every signal is ownership-verified independently.
2. **`stdio: ["ignore", logFd, logFd]` does NOT keep the parent alive.** A fixture parent exits in ~20ms while the detached child survives. The `bun.d.ts:6503-6504` warning applies to pipes, not to a real file descriptor. The documented `sh -c 'exec … >> log'` fallback was therefore **not needed**; `spawn.test.ts` re-measures this on every run so a Bun regression fails a test rather than hanging the MCP server.

**Deviations from the plan (all additive):**

- `maySignalGroup` and `listGroupMembers` were added to `src/runtime/ownership.ts` rather than kept private to `teardown.ts` — Task 4's orphan-reap preflight asks the identical question, and two copies of the refuse-to-signal rule is one copy too many. This also kept `teardown.ts` at **396** lines, under the 400 warn.

**Verify:**

- `bun test src/runtime/`

---

### Task 6: Manager dependency injection — R11 shared resources + runtime stop hook

**Objective:** Make Phase 3's `sharedResources` seam carry data **and** give the manager a runtime-stop hook — **without** breaking the no-module-cycle guard. **Both deps travel identical wiring, so they are injected in one pass** rather than split across waves (splitting them collided with Task 4's "server.ts unchanged" DoD in the same shared-directory wave).
**Dependencies:** Task 1
**Wave:** 2

**Files:**

- Modify: `src/worktree/types.ts` (**`WorktreeConfig` gains both fields**), `src/worktree/manager.ts` + `reconcile.ts` (3 seed sites), `src/mcp/server.ts`, `src/worktree/mcp-tools.ts`, `src/sidecar/worktree-routes.ts`, `src/cli/commands/worktree.ts`

**Key Decisions / Notes:**

- **⛔ The DoD "three one-line edits calling `loadRuntimeConfig`" is UNIMPLEMENTABLE.** `src/runtime/no-module-cycle.test.ts:63-86` forbids any `src/worktree/**` file importing `src/runtime/**` _or the barrel_, recursively — and `src/worktree/mcp-tools.ts:62` constructs a manager while being inside the forbidden directory.
- **Inject as data:** add `sharedResourcesFor?: (worktreePath: string) => string[]` to the manager's config, defaulting to `() => []`. Thread it into all three seed sites: `manager.ts:171` (`seedWorktreeConfig`) and `:448`/`:485` (**`seedNonFatally`** — same `SeedOptions`), using each site's own path variable (`worktreePath`, `reregistered.worktreePath`, `wt.worktreePath`).
- Supply it from the **four construction sites outside `src/worktree/`**: `src/sidecar/worktree-routes.ts:62/:88/:105`, `src/cli/commands/worktree.ts:48`, and — because `src/worktree/mcp-tools.ts:62` cannot import it — as a **new dep threaded down from `src/mcp/server.ts:51`**.
- Resolver bodies: `sharedResourcesFor = (wt) => loadRuntimeConfig(wt).sharedResources`; `stopOwnedRuntime = (wt) => stopOwnedGroup(wt)` (Task 3). **Inject both together at all five sites** — Task 5 then consumes the hook without touching `src/mcp/server.ts` or `src/cli/commands/worktree.ts`.
- **`WorktreeConfig`/`DEFAULT_WORKTREE_CONFIG` live in `src/worktree/types.ts`** — that is where the two optional fields go, defaulting to `() => []` and a no-op.

**Definition of Done:**

- [x] A worktree whose `runtime.json` declares `"database": "shared"` gets a warning **naming `database`**
- [x] With no `runtime.json`, the warning is **byte-identical to the Phase 2 baseline** (`create.test.ts` compares the two warning arrays with `toEqual`)
- [x] **All five** construction sites supply **both** deps — `worktree-routes.ts:64/:90/:107`, `cli/commands/worktree.ts:48`, and `worktree/mcp-tools.ts:62` via `src/mcp/server.ts:51`. Statically asserted in `src/runtime/worktree-deps.test.ts`
- [x] Behaviourally asserted at the **three seeding** sites — `worktree-routes.ts:64` (`worktree-routes.test.ts`, "names the runtime contract's shared resources"), `cli/commands/worktree.ts:48` (`cli/commands/worktree.test.ts`, real-binary spawn), `worktree/mcp-tools.ts:62` (`runtime/worktree-deps.test.ts` — it **cannot** live in `worktree/mcp-tools.test.ts`, which is inside the directory the cycle guard forbids from importing `src/runtime/`). `worktree-routes.ts:90` is `handleAbandonWorktree`: its `sharedResourcesFor` is asserted by construction only; **its `stopOwnedRuntime` is asserted behaviourally in Task 5** (`abandon` only grew a consumer there)
- [x] `src/worktree/**` still imports nothing from `src/runtime/**` (guard green)

**Deviations from the plan (both additive, both to avoid Task 5 having to edit `src/mcp/server.ts` or `src/cli/commands/worktree.ts`):**

1. **A THIRD dep is injected, not two.** Guard 5 needs `ownsLiveRuntime` (`src/runtime/pidfile.ts`), and `src/worktree/cleanup.ts` cannot import it any more than `manager.ts` can. Threading it in Task 5 would have meant editing the two files Task 5 is barred from. All three now travel the identical wiring in one pass, exactly as the plan argued for the first two.
2. **The resolver bodies live in one place, `src/runtime/worktree-deps.ts`.** Five inline copies of three resolvers is fifteen chances to drift. `runtimeWorktreeConfig()` is the sole production supplier; `worktree-deps.test.ts` asserts statically that every site calls it, which is a sharper guard against Pre-Mortem #3 than five behavioural tests could be.

**Verify:**

- `bun test src/worktree/ src/runtime/no-module-cycle.test.ts src/sidecar/ src/cli/commands/worktree.test.ts`

---

### Task 4: `runtime_up` / `runtime_stop` MCP tools

**Objective:** Expose the engine, with the preflight matrix that makes "never improvise a port" structural rather than advisory.
**Dependencies:** Task 3
**Wave:** 3

**Files:**

- Create: `src/runtime/lifecycle-mcp-tools.ts` (+ test)
- Modify: `src/runtime/mcp-tools.ts` (delegate only), `src/index.ts` (append after `:306`)

**Key Decisions / Notes:**

- **Sibling module — `mcp-tools.ts` is 212 lines and both tools would breach 400.** `registerRuntimeTools` calls `registerRuntimeLifecycleTools(server)`, so **`src/mcp/server.ts:58` needs no change**; extend `src/mcp/server.test.ts:80-87`'s domain assertion.
- **Required `project` arg, never `process.cwd()`** — follow the runtime module's convention (`mcp-tools.ts:132`), not `src/worktree/mcp-tools.ts`'s `project ?? process.cwd()`.
- Flag `runtime_stop` **DESTRUCTIVE** in its description (precedent: `src/worktree/mcp-tools.ts:318-324`).
- **⛔ Preflight matrix — an occupied port is a hard failure. Never re-port.**

  | Condition                                        | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
  | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Pidfile `state=ready`, alive, cmdline matches    | **Reuse**, flag the run `reused`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
  | Pidfile `state=starting`, alive, cmdline matches | Previous `runtime_up` interrupted → tear that group down, spawn fresh                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
  | Pidfile alive, cmdline mismatch                  | **Fail** — foreign process                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
  | Leader dead but recorded port still bound        | Orphan. **⛔ Verify a live GROUP MEMBER first** — the leader is dead, so leader-PID verification is structurally impossible, and PGIDs are drawn from the same wrapping PID space as PIDs, so a dead leader's pgid can already belong to an unrelated group. Enumerate members (`ps -o pid=,pgid=,command= -A`, or `ps -o pid=,command= -g <pgid>`) and require **at least one whose command line references this worktree**. Only then `kill -- -$PGID`, re-probe; still bound → **fail naming the pgid**. **If zero members verify, REFUSE to signal and fail.** Do not spawn |
  | Pidfile stale, port free                         | Delete, spawn                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
  | Port occupied, **no** pidfile                    | **Fail loudly.** Never re-port                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

- **A reused stack is NEVER torn down.** Killing what we did not start is the same error class as `pkill -f`; Playwright's `reuseExistingServer` behaves the same way.
- Absent `runtime.json` → inert, actionable message, **no error**.

**Definition of Done:**

- [x] Each preflight row has a test (`lifecycle.test.ts`, one `it` per row, plus two against a **real** detached server)
- [x] Occupied port + no pidfile → **fails, and no alternative port is attempted anywhere in the path** — asserted behaviourally (stub + real squatter), and by a source scan of `src/runtime/*.ts` for port arithmetic / free-port search
- [x] Interrupted startup (`state=starting`) recovers automatically on the next call
- [x] A reused stack is left running and reported as reused (`stop` is asserted **not** called; the real-server test adopts a live stack twice)
- [x] `runtime_stop` is idempotent
- [x] `src/runtime/mcp-tools.ts` stays under 400 (**216**); `src/mcp/server.ts` **untouched by this task** (Task 6 edited it in Wave 2, as planned)

**Deviations from the plan (additive):**

- **`preflight.ts` was split out of `lifecycle.ts`.** The composed module was 515 lines — past the 400 warn. The preflight is also where every dangerous decision is made, and a decision function that also spawns cannot be tested exhaustively. `lifecycle.ts` re-exports its public surface, so callers still have one entry point.
- **`inspectPidfile` now honours an injected `isAlive`.** `isAlive` moved from `GroupProbes` up to `OwnershipProbes`. Without it the `stale` vs `owned` branches — orphan-reap vs reuse, the two most consequential outcomes here — could only be exercised by finding a real PID on the host in the right state. An **unknowable** liveness is treated as **alive**, deliberately: "dead" is what unlocks the group reap.

**Two empirical findings the plan did not anticipate (both were real bugs, caught by the real-server tests):**

1. **A bind-only port probe is WRONG on macOS.** `listen(P, "127.0.0.1")` **succeeds** while a `Bun.serve` holds `0.0.0.0:P`, because BSD's `SO_REUSEADDR` (which Node sets by default) permits binding a more-specific address over a wildcard one. The probe reported "free" for a port that was in use, `runtime_up` proceeded, and the project's own `up` would have died with `EADDRINUSE` — leaving the agent in exactly the state issue #2 says it improvises out of. `isPortBound` now **connects first** (a successful connection is proof) and falls back to the bind probe.
2. **Ownership verification must resolve symlinks.** On macOS `/var` → `/private/var`, so a worktree handed to us as `/var/folders/…` has a cwd reported by `lsof` as `/private/var/folders/…`. Comparing literally made ownership unprovable, and unprovable means refuse — `runtime_stop` declined to stop a process it had demonstrably started moments earlier. `processBelongsToWorktree` now compares against both forms. This widens nothing: the two strings name the same directory.

**Verify:**

- `bun test src/runtime/ src/mcp/server.test.ts`

---

### Task 5: Stop-on-exit + `worktree_cleanup` guard 5

**Objective:** Never delete a worktree directory out from under a process it owns.
**Dependencies:** Task 1, Task 3, Task 6
**Wave:** 3

**Files:**

- Modify: `src/worktree/manager.ts` (`abandon`, `squashMerge`), `src/worktree/cleanup.ts` (guard 5), `src/worktree/mcp-tools.ts`, `src/sidecar/worktree-routes.ts` (+ tests)

**Key Decisions / Notes:**

- **Insertion points (re-verified):**
  - `abandon` — before the `existsSync` block at `:331` (removal `:332-335`, fallback `rmSync` `:339-340`).
  - `squashMerge` — **before `git checkout base` at `:303`**, not merely before `worktree remove` at `:315`. A live process holding files can make the checkout itself fail.
  - `forceCleanupOrphans` — **guard 5**, after guard 4 (`:554`) and before removal at `:558`.
- **⛔ Must be a no-op fast path when no pidfile exists** — otherwise every `abandon` pays `graceMs`. This is Pre-Mortem #2.
- **The stop-hook DI is already wired by Task 6** (Wave 2) at all five construction sites, so this task **consumes** `config.stopOwnedRuntime` and does **not** edit `src/mcp/server.ts` or `src/cli/commands/worktree.ts`. That is why Task 4's "server.ts unchanged" DoD still holds in the same wave. **Do not import `src/runtime/` from `src/worktree/`.**
- Thread the new `CleanupOptions` field from **both** entry points — the MCP tool arg (`mcp-tools.ts:349-354`) and the sidecar **request body** (`worktree-routes.ts:98-115`), **never `process.cwd()`**.
- **⛔ `src/sidecar/client.ts` does NOT need editing** (a review claimed it did). `cleanupWorktrees` at `client.ts:531-540` **already accepts and forwards `currentWorktree`**, and `worktree-routes.ts:100-104` already reads it from the body. **The gap is purely caller-side.** Guard 5's input is likewise **derived server-side** — the sidecar route reads the worktree's own pidfile — so it needs **no new wire field**. `client.ts` stays at 582/600, untouched.
- **Also fix the pre-existing defect:** the caller at `mcp-tools.ts:341-343` sends only `{ force }` and `:349-354` omits `currentWorktree`, so **guard 3 is dead in production**. One-line fix on each path.

**Definition of Done:**

- [x] `abandon` and `squashMerge` stop the owned group **before** touching the directory (and before `git checkout base`) — asserted by a hook that records `git rev-parse HEAD` and `existsSync(worktreePath)` at the moment it runs
- [x] With no pidfile, both are a **fast no-op** — no `graceMs` delay. Proved by an **unmocked-call** assertion, not only a timing bound: see "The fast path is proved by absence, not by a stopwatch" below
- [x] `worktree_cleanup --force` warns and skips a worktree owning live processes
- [x] Guard 5 threaded from both entry points; **guard 3's `currentWorktree` gap fixed** (caller-side only — `client.ts:531-540` already forwards it)
- [x] `src/sidecar/client.ts` **untouched** and still 582 lines
- [x] One test per exit path — `abandon` (success + refusal), `squashMerge` (success + refusal), `forceCleanupOrphans` (5 tests), plus a **real detached process group** killed through the real sidecar route (`worktree-routes.test.ts`)
- [x] `src/worktree/**` imports nothing from `src/runtime/**` (guard green)

**The fast path is proved by absence, not by a stopwatch:**

A timing bound alone is a weak assertion — it passes on a fast machine against an implementation that does real work. The worktree declares `down: touch <sentinel>` with `graceMs: 20000`; with no pidfile `stopOwnedGroup` returns *before the contract is even loaded*, so the sentinel never appears. That observation is exact and machine-speed-independent. Both halves (sentinel + timing) are asserted, and all three fast-path tests were confirmed to **fail** when the `verdict.kind === "absent"` short-circuit is disabled — they are not vacuous.

⛔ This test **cannot** live in `manager.test.ts`: `src/worktree/**` may not import `src/runtime/**` (the guard walks test files too), so the only hook available there is a stub, and a stub short-circuits because it was written to. It lives in `src/runtime/worktree-deps.test.ts`, on the runtime side of the boundary. `manager.test.ts`'s own no-op test was **relabelled** to say honestly that it covers only the un-injected branch.

**Deviations from the plan:**

1. **`abandon` and `squashMerge` are now `async`.** Unavoidable: `stopOwnedRuntime` returns a `Promise`, and "stop **before** the directory is touched" is an ordering requirement that only `await` can express. This forced a consequential edit to **`src/cli/commands/worktree.ts`** (3 sites: `merge`, `abandon`, `sync` — `async` on the Commander action + `await` on the call), which this task was told not to touch. The prohibition existed to avoid a **file conflict with Tasks 4 and 6 inside Wave 3**; both were already landed and committed before this task ran, so the conflict could not occur. No DI wiring was changed there. Without the `await`, `store.close()` in the `finally` would have run before the abandon completed and a refusal would have surfaced as an unhandled rejection instead of a non-zero exit.
2. **A failed stop ABORTS the exit path** (new `WorktreeError` code `RUNTIME_STOP_FAILED`). The plan said "stop the owned group (or hard-fail with an actionable message) before `git worktree remove`" but never fixed which. Proceeding with the removal after a refusal would produce exactly the orphan this tier exists to prevent — a live process with a deleted working directory — so "could not stop it" is never a licence to delete it. `squashMerge` aborts before `git checkout`, leaving the main checkout untouched.
3. **`client.cleanupWorktrees`'s declared return type is widened at the point of use**, not in `client.ts`. The sidecar now returns `warnings` alongside `cleaned`, but `client.ts` is pinned at 582 lines by this task's own DoD, so `src/worktree/mcp-tools.ts` casts. The declared type was already narrower than the payload the client forwards.
4. **`worktree_cleanup` moved to a new `src/worktree/cleanup-mcp-tool.ts`.** The guard-3 fix plus warning surfacing took `mcp-tools.ts` from 385 to 418 — past the 400 warn the plan had already flagged it as approaching. Same precedent and same reason as Task 4's `lifecycle-mcp-tools.ts` split. The registration chain is unchanged (`registerWorktreeTools` calls it), so `src/mcp/server.ts` is still untouched. Result: `mcp-tools.ts` **329**, `cleanup-mcp-tool.ts` **110**.
5. **`CleanupOptions.warnings` is a collector, not a return value.** A cleanup that skips silently reads as "there was nothing to do", and the obvious next move for an agent reading `Cleaned up 0 stale worktrees.` is to `rm -rf` the directory by hand — the exact orphan guard 5 just prevented. Threaded through the MCP tool output and the sidecar response body (additively, so older clients reading only `cleaned` are unaffected).

**Defects found in the in-flight test scaffolding (kept, but corrected):**

- **Four `expect(promise).rejects.toThrow(...)` calls were not awaited.** An unawaited `.rejects` assertion never runs, so two of them (`abandon`/`squashMerge` refusal) would have passed against an implementation that removed the directory anyway — the precise bug they exist to catch. Fixed, and the two `await Bun.sleep(10)` waits they were paired with are now unnecessary and removed.
- Four `WorktreeManager.prototype` monkey-patches still returned sync values against the now-async signatures (caught by `tsc`, not by `bun test`).

**Verify:**

- `bun test src/worktree/ src/sidecar/worktree-routes.test.ts src/runtime/worktree-deps.test.ts`

---

### Task 7: Documentation + MCP catalog

**Objective:** Document the lifecycle for project authors and keep the catalog honest.
**Dependencies:** Task 4
**Wave:** 4

**Files:**

- Modify: `README.md`, `.sentinal/rules/sentinal-mcp-servers.md`, `targets/*/rules/verification.md` (**byte-identical — in `IDENTICAL_RULES`**)

**Key Decisions / Notes:**

- Catalog now reads "33 tools across 7 domains" (`.sentinal/rules/sentinal-mcp-servers.md:3`) → **35 across 7**; add two rows to the runtime table (`:86-87`) and run the smoke-test checklist.
- Document the lifecycle contract for authors: `up`/`down`/`readiness`/`shutdown`/`detached`, the log path, and **the "never improvise a port" rule with its reason** (a free port proves nothing about what is behind it).
- State the POSIX-only limitation and the Windows degradation plainly.
- **`targets/*/rules/verification.md` must stay byte-identical** across targets.
- `bun run embed-assets` after any `targets/**` edit.

**Definition of Done:**

- [x] Lifecycle documented where a project author will read it — `README.md` gains "Running the lifecycle — `runtime_up` / `runtime_stop`" **inside** the existing Runtime Contract section, so an author reading how to declare the contract reads how it is executed in the same pass
- [x] Catalog reports 35 tools / 7 domains; smoke-test checklist run — results recorded in a run-record table in `.sentinal/rules/sentinal-mcp-servers.md`
- [x] POSIX-only limitation stated — in `README.md` and in the shipped `verification.md`, each with the Windows degradation (`down` becomes the only mechanism) and the explicit-failure case
- [x] Both `verification.md` copies byte-identical (`cmp` clean; `target-parity.test.ts` `IDENTICAL_RULES` green)

**What changed in the shipped `verification.md`:**

Rule 1 now names `runtime_up` as the thing that runs the lifecycle, rather than describing the steps for the agent to perform by hand. Rule 3 was "record the PID you start" — an instruction with no supported mechanism behind it; it now names `runtime_stop` as the correct alternative to `pkill -f` **and keeps the record-the-PID rule for anything started outside the contract**. Rule 4 keeps "never switch ports" and now carries the reason (*a free port proves nothing about what is behind it*) plus the fact that `runtime_up` enforces it structurally. Rule 5 (liveness re-check — "green against a stack that died mid-run is a false pass") is new; it was owned prose in Task 3 with `assertStillAlive` and no reader.

⚠️ **The two catalog figures drift independently.** `README.md` and `.sentinal/rules/sentinal-mcp-servers.md` each carry the count and a per-domain table, and `src/mcp/server.test.ts` asserts only that a tool *is registered*, never how many exist. Two checklist items were added to the rule file to catch this next time.

**Deviation:** the smoke-test checklist's "Sidecar path added if the tool needs new HTTP routes" is recorded as **N/A, by design** rather than skipped — D5's whole argument is that the ownership record is a worktree-local pidfile, so there is deliberately no route to add.

**Verify:**

- `bun run embed-assets && bun test src/cli/`
- `diff -q targets/claude-code/rules/verification.md targets/opencode/rules/verification.md`
