# Destructive worktree ops report "sidecar unreachable" on client timeout Fix Plan

Created: 2026-09-07
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Bugfix

Closes: #9

## Summary

**Symptom:** `worktree_cleanup(force=true)` returned
`POST /worktree/cleanup failed: sidecar at unix:~/.sentinal/sidecar.sock unreachable — The operation timed out. (23)`
twice, after the operation had **fully succeeded** (7 worktrees + 7 branches deleted, 6.3 GB freed).

**Trigger:** Any sidecar request whose server-side work exceeds the route's client timeout budget.
For `/worktree/*` that budget is a fixed 30 s; `rm -rf` of 6.3 GB across 7 `node_modules` trees
exceeds it. Idle-shutdown respawn (~8 s observed) is charged against the same budget.

**Root Cause:** `src/sidecar/client.ts:258-272` — `enrich()` hardcodes the word `unreachable` into
every fetch rejection, including `TimeoutError`. The timeout-vs-connect distinction **already exists**
24 lines above at `client.ts:234` (`err.name === "TimeoutError"`, used to decide retry-safety) but is
never passed to `enrich()`.

## Investigation

**Reproduced from first principles.** Bun's `AbortSignal.timeout` rejects `fetch` with
`DOMException { name: "TimeoutError", message: "The operation timed out.", code: 23 }`
(`code` 23 = `DOMException.TIMEOUT_ERR`). Substituted into the `enrich()` template at
`client.ts:269-271` this composes the reported string **character for character**, including the
`(23)`. The reporter's diagnosis was correct on every point.

Seven distinct defects, all confirmed by reading source and by live inspection on this machine:

| #   | Defect                                                                  | Location                                                             |
| --- | ----------------------------------------------------------------------- | -------------------------------------------------------------------- |
| RC1 | `enrich()` labels every rejection "unreachable"                         | `src/sidecar/client.ts:258-272`                                      |
| RC2 | `/worktree/` fixed at 30 s; no env override exists anywhere             | `src/sidecar/client.ts:35-50`                                        |
| RC3 | Zero `logSidecar` calls — no server-side audit trail                    | `src/sidecar/worktree-routes.ts`                                     |
| RC4 | `cleanupWorktrees` returns a bare `number` — nothing to reconcile       | `src/worktree/cleanup.ts:71-116`                                     |
| RC5 | `build:opencode` lacks `--define __SENTINAL_VERSION__`                  | `package.json:41`                                                    |
| RC6 | CLI `cleanup` has no `--force`, and passes **no options at all**        | `src/cli/commands/worktree.ts:257-274`                               |
| RC7 | `abandon` resolves only _active_ DB records, so orphans are unreachable | `src/worktree/mcp-tools.ts:123`, `src/sidecar/worktree-routes.ts:87` |

**Live verification on this machine (v1.36.3):**

- `rg -c "worktree" ~/.sentinal/sidecar.log` → **0** — confirms RC3 exactly as reported.
- `rg -o "sidecar is v.* but this client is v.*" ~/.sentinal/sidecar.log | sort -u` → **36×**
  `sidecar is v1.36.3 but this client is v0.0.0` — confirms RC5. `build:cli` passes the define;
  `build:opencode` does not, so the bundled plugin falls through `version.ts:36` to `"0.0.0"`.

**Why the message is wrong, not just unhelpful.** `fetchWithReconnect` (`client.ts:230-237`) already
reasons correctly about this case — it _refuses_ to retry a timeout precisely because "the request may
have REACHED the server". That knowledge is then discarded when the error is formatted. The client
knows the truth and tells the caller the opposite.

**Confidence: High** — traced end to end, and the exact error string reproduced in isolation.

## Behavior Contract

### Fix Property (C ⇒ P)

**When condition C holds:** a sidecar request rejects with `name === "TimeoutError"`.
**Property P must hold:** the resulting message (a) never contains the word `unreachable`,
(b) states the outcome is **unknown** and the operation may have completed, (c) names the elapsed
budget and the env var that raises it, and (d) for destructive routes, instructs the caller to
reconcile (`git worktree list`) before retrying.

### Preservation Property (!C ⇒ unchanged)

**When condition C does NOT hold:** the rejection is a genuine connection failure (ENOENT /
ECONNREFUSED / socket missing).
**Existing behavior preserved:** message keeps the current `unreachable` wording
(`src/sidecar/client.test.ts:613-626` must pass **unmodified**), and reconnect-and-retry behaviour at
`client.ts:238-253` is untouched. A successful `cleanup` still reports `cleaned` on the wire, so an
older bundled plugin reading only that field is unaffected.

## Fix Approach

**Strategy:** classify the failure at the point where the distinction is already known, then widen the
destructive endpoints from "return a count" to "return what was acted on", so a retry is a _verified_
no-op rather than a hopeful one.

**File-length constraints (Sentinal enforces these on itself):**

- `src/cli/commands/worktree.ts` is **428 lines — already past the 400 warn**. RC6/RC7 must land in a
  new sibling `src/cli/commands/worktree-cleanup.ts`, not in it.
- `src/worktree/manager.ts` is at **398** — it must not grow; `cleanup()` stays a delegating one-liner.
- `src/sidecar/client.ts` is at **346** — error classification goes in a new dependency-light sibling
  `src/sidecar/client-errors.ts` (client.ts is hook-reachable and must stay light).

**Wire compatibility:** every response gains fields additively. `cleaned` stays.

## Progress

- [x] Task 1: Classify timeout vs connect failure (RC1)
- [x] Task 2: Timeout budget + `SENTINAL_SIDECAR_TIMEOUT_MS` (RC2)
- [x] Task 3: Server-side worktree audit logging (RC3)
- [x] Task 4: Report the acted-on set (RC4)
- [x] Task 5: Idempotency keys for destructive routes (RC4b)
- [x] Task 6: Bake the version into the OpenCode bundle (RC5)
- [x] Task 7: CLI parity + orphan-reaching abandon (RC6, RC7)
- [x] Task 8: Verify
      **Tasks:** 8 | **Done:** 8 | **Left:** 0

## Deferred Issues

- **`src/worktree/manager.ts` is at 401 lines — 1 over the 400 soft warn** (it was 398 before this
  plan; `cleanup()`'s new return type needed a type import and a docstring line). This is a WARN,
  not the 600-line block. The honest fix is a cohesion split, as was done when `cleanup.ts` and
  `diff-parse.ts` were extracted from this same file — that is a separate change and is not
  smuggled into a bugfix. Shaving comments to land on 399 was rejected: it would hide a true signal
  that the file is full.

- **26 pre-existing files fail `prettier --check`** (e.g. `src/spec/ownership.test.ts`,
  `src/worktree/create.test.ts`), and **`README.md` is one of them at HEAD**. None are touched by
  this plan. Not reformatted here — an unrelated whitespace diff would bury the actual fix.
  ⚠️ Running `prettier --write README.md` during Task 5 silently reformatted **68 lines of
  pre-existing tables** I never edited; that was reverted in verification and the two additions
  re-applied by hand. The README diff is now **22 insertions, 0 deletions**. Lesson: never
  `prettier --write` a file that was already unformatted at HEAD.

- **Flaky under load, not a regression:** `src/sidecar/server.test.ts` →
  "should pass stale-activity reason to onShutdown with count and age info" failed once in a
  602-test combined run, then passed on rerun of the identical set, and passes in isolation both
  with and without these changes. It is a time-based assertion of the class documented in
  `.sentinal/rules/sentinal-testing.md`. Pre-existing; not investigated further here.

### Findings that CORRECT the issue report

- **`worktree_sync` is NOT exposed to this failure mode.** The issue lists it as an inferred risk
  sharing "the same client path". It does not: there is no `/worktree/sync` sidecar route, and
  `registerWorktreeSyncTool` calls `manager.squashMerge()` **directly in the MCP process**
  (`src/worktree/mcp-tools.ts:279`) — the client is used only to _resolve_ the worktree. A client
  read timeout therefore cannot misreport a squash merge. The reporter flagged this as inferred
  rather than observed and was right to hedge. Idempotency keys were added to `cleanup` and
  `abandon`, which are the real exposure; `/worktree/sync` remains in `DESTRUCTIVE_PATHS` purely so
  that wiring such a route later cannot silently miss the reconcile warning.

### Deviations from the plan

- **`warnings` is NOT duplicated into `CleanupResult`.** The plan said
  `{ cleaned, removed, warnings }`, but `warnings` is already an out-param collector on
  `CleanupOptions` that the routes and the MCP tool read. Returning it as well would create two
  sources of truth for the same list. `CleanupResult` is `{ cleaned, removed }`; `cleaned` is
  derived as `removed.length` so the two cannot drift.

- **ESLint is neither installed nor configured in this repo.** There is no `eslint.config.*` and
  `eslint` is absent from dependencies (only `typescript` is present); `npx eslint .` downloads
  ESLint 10 and exits on "couldn't find eslint.config.\*". Pre-existing and out of scope — the
  global standard notes formatting is handled by the editor's formatter system. Task 8's verify
  command has been corrected to drop it; `tsc --noEmit` + `prettier --check` are the real gates.

## Tasks

### Task 1: Classify timeout vs connect failure (RC1)

**Objective:** A timeout must never be reported as "unreachable".
**Files:** `src/sidecar/client-errors.ts` (new), `src/sidecar/client-errors.test.ts` (new),
`src/sidecar/client.ts`
**Approach:** New `classifySidecarFailure(err, method, path, target, budgetMs)` returning the enriched
`Error`. Timeout branch: outcome-unknown wording + budget + `SENTINAL_SIDECAR_TIMEOUT_MS` +, for
`/worktree/{cleanup,sync,abandon}`, the `git worktree list` reconcile instruction. Connect branch:
current wording verbatim. `enrich()` delegates; `client.ts` net line count must not rise materially.
**TDD:** Test asserts a `TimeoutError` message contains "may still be running" and does **not** match
`/unreachable/`; a separate test asserts the connect-failure message is byte-identical to today's.
**Verify:** `bun test src/sidecar/client-errors.test.ts src/sidecar/client.test.ts`

### Task 2: Timeout budget + env override (RC2)

**Objective:** Make the budget adequate and configurable.
**Files:** `src/sidecar/client.ts`, `src/sidecar/client.test.ts`
**Approach:** Raise `/worktree/` to 180 s (matching `/quality-check`, the existing precedent for
"cost scales with work"). Add `SENTINAL_SIDECAR_TIMEOUT_MS` honoured by `requestTimeoutMsFor` as a
global override. Invalid/non-numeric values are ignored, not fatal.
**TDD:** Existing assertion `requestTimeoutMsFor("/worktree/cleanup") >= 30_000`
(`client.test.ts:771`) must still pass. New tests: override applied; garbage ignored; `/ping` still
2 s absent the override.
**Verify:** `bun test src/sidecar/client.test.ts`

### Task 3: Server-side worktree audit logging (RC3)

**Objective:** Make it possible to answer "did it run?" from the log alone.
**Files:** `src/sidecar/worktree-routes.ts`, `src/sidecar/worktree-routes.test.ts`
**Approach:** `logSidecar` at start and end of all three handlers — route, project, `force`, outcome
(count + duration) or error. This is the single highest-value change for diagnosing the next
ambiguous client error.
**TDD:** Inject a log sink; assert start and end records for cleanup, including `force`.
**Verify:** `bun test src/sidecar/worktree-routes.test.ts`

### Task 4: Report the acted-on set (RC4)

**Objective:** A retry can be _verified_ as a no-op.
**Files:** `src/worktree/cleanup.ts`, `src/worktree/manager.ts`, `src/sidecar/worktree-routes.ts`,
`src/sidecar/client-routes.ts`, `src/worktree/cleanup-mcp-tool.ts`, plus the matching `.test.ts` files
**Approach:** `cleanupWorktrees` returns `{ cleaned, removed: Array<{path, branch, slug}>, warnings }`.
⛔ **`cleaned` is retained on the wire and in the return type** — the deployed OpenCode plugin bundle
reads it. MCP output lists what was removed instead of only a count, which alone would have made the
reported success obvious.
**TDD:** Assert `removed[]` names each path+branch; assert a second call returns `cleaned: 0` with an
empty `removed[]`; assert the response still carries `cleaned`.
**Verify:** `bun test src/worktree/ src/sidecar/worktree-routes.test.ts`

### Task 5: Idempotency keys for destructive routes (RC4b)

**Objective:** A replayed destructive request returns the original outcome instead of re-executing.
**Files:** `src/sidecar/idempotency.ts` (new) + test, `src/sidecar/worktree-routes.ts`,
`src/sidecar/client-routes.ts`, `src/worktree/cleanup-mcp-tool.ts`, `src/worktree/mcp-tools.ts`,
`README.md`, `.sentinal/rules/sentinal-mcp-servers.md`
**Approach:** Optional `idempotency_key` on `cleanup`/`sync`/`abandon`. Result cached via
`MemoryStore.getSetting/setSetting` (`store.ts:52-59`) under a namespaced, TTL-stamped key; a repeat
within TTL returns the stored result flagged `replayed: true`. Absent a key, behaviour is exactly
as today.
⛔ **Schema/prose drift:** per `.claude/skills/sentinal-schema-prose-drift`, the zod change and the
shipped docs describing it MUST land in this same task. Constraints go in `.describe()` (JSON-Schema
drops `.refine()`). Bind any cross-check to `Schema.shape`, never `src.includes("idempotency_key")`.
**TDD:** Same key twice ⇒ one execution, second flagged `replayed`. Different keys ⇒ two executions.
No key ⇒ unchanged. Expired key ⇒ re-executes.
**Verify:** `bun test src/sidecar/idempotency.test.ts src/worktree/`

### Task 6: Bake the version into the OpenCode bundle (RC5)

**Objective:** Stop the false `v0.0.0` skew warning that masks genuine mismatches.
**Files:** `package.json`, `src/cli/target-assets.test.ts`
**Approach:** Add `--define __SENTINAL_VERSION__` to `build:opencode`, mirroring `build:cli`
(`package.json:41`). Removes 36 false warnings/session on this machine alone.
**TDD:** Assert the built `targets/opencode/dist/sentinal.mjs` contains the real version and not the
`"0.0.0"` fallback path.
**Verify:** `bun run build:opencode && bun test src/cli/target-assets.test.ts`

### Task 7: CLI parity + orphan-reaching abandon (RC6, RC7)

**Objective:** Make the CLI a genuine fallback when the MCP path is failing.
**Files:** `src/cli/commands/worktree-cleanup.ts` (new) + test, `src/cli/commands/worktree.ts`
(remove the two commands, register the new module), `src/worktree/mcp-tools.ts`
**Approach:** Move `cleanup`/`abandon` into the new module; add `--force`, `--project`,
`--current-worktree`. `createManager()` already supplies `runtimeWorktreeConfig()`, so guard 5 is
satisfied — but `projectPath`, `currentWorktree` and `isPlanActive` (via `SpecStore`) **must** be
threaded, or `--force` silently refuses (`cleanup.ts:161-172`). For RC7, `abandon` falls back to
resolving an on-disk orphan by slug when no active DB record exists.
⛔ Today's CLI calls `manager.cleanup()` with **no options whatsoever**; adding `--force` without
threading these guards would be strictly more dangerous than the current bug.
**TDD:** `--force` removes an orphan in a temp repo; `--force` refuses to remove the current
worktree; `abandon` reaches a DB-less orphan.
**Verify:** `bun test src/cli/commands/worktree-cleanup.test.ts src/worktree/`

### Task 8: Verify

**Objective:** Full suite + quality + both targets.
**Verify:** `bun test && npx tsc --noEmit && npx prettier --check <changed> && bun run build:all`
(`npx eslint .` dropped — ESLint is not installed or configured in this repo; see Deferred Issues.)
**Also:** re-check `README.md` and `.sentinal/rules/sentinal-mcp-servers.md` tool-catalog tables
(hand-maintained, drift independently), and confirm `src/cli/commands/worktree.ts` is back under 400
lines.

### Results

| Check                              | Result                                                              |
| ---------------------------------- | ------------------------------------------------------------------- |
| `bun test`                         | ✅ **3159 pass / 0 fail** across 375 files                          |
| `npx tsc --noEmit`                 | ✅ 0 errors                                                         |
| `npx prettier --check` (changed)   | ✅ all changed files clean                                          |
| `bun run build:all`                | ✅ both targets build                                               |
| `bun run build:cli`                | ✅ binary builds; `--version` → 1.36.3; `--force` present           |
| Tool-catalog counts                | ✅ unchanged — no tools added, only optional params                 |
| `src/cli/commands/worktree.ts`     | ✅ **394 lines** (was 428 — under the warn for the first time)      |
| Live sidecar E2E (isolated `HOME`) | ✅ audit log populated; retry returned `replayed: true` in **0 ms** |

**Live end-to-end evidence** (real sidecar, isolated `SENTINAL_HOME`):

```
1st call -> {"ok":true,"data":{"cleaned":0,"removed":[]}}
retry    -> {"ok":true,"data":{"cleaned":0,"removed":[],"replayed":true}}

worktree: POST /worktree/cleanup start project=… force=false current=(none)
worktree: POST /worktree/cleanup ok cleaned=0 skipped=0 in 25ms
worktree: POST /worktree/cleanup start project=… force=false current=(none)
worktree: POST /worktree/cleanup ok cleaned=0 skipped=0 REPLAYED (idempotency key hit) in 0ms
```

`rg -c worktree ~/.sentinal/sidecar.log` returned **0** on the reporter's machine; it now returns
start/outcome/duration records. The `in 0ms` on the replay is the proof the work was not repeated.
