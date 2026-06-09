# Sidecar Lifecycle Logging & Log Rotation Implementation Plan

Created: 2026-06-09
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Summary

**Goal:** Make sidecar connectivity failures self-documenting by logging the four lifecycle transitions that were missing during the 2026-06-09 MCP-connectivity investigation, with size-capped log rotation and a `sentinal sidecar logs` command for bug reports.

**Architecture:** A new shared file-logger util (`src/utils/file-log.ts`, append + 10MB→`.1` rotation + tail) is used by three writers: the sidecar process (startup identity + shutdown reason → `~/.sentinal/sidecar.log`), the `SidecarClient` reconnect path (connection-lost/reconnected/respawn/give-up events → same `sidecar.log`, single place to diagnose connectivity), and the OpenCode plugin's existing `log()` (gains rotation, keeps `plugin.debug.log`). A CLI subcommand prints the tail of both files.

**Tech Stack:** Bun/TypeScript, node:fs only (the util must stay importable by hooks and `client.ts` — no `bun:sqlite`).

## Scope

### In Scope

- `src/utils/file-log.ts`: timestamped append, 10MB size cap with rotate-to-`.1`, `readLastLines` tail helper
- Sidecar: log startup identity (pid, transport, socket/port) and **shutdown reason** (grace-period / stale-activity with ages / idle-fallback / SIGTERM)
- `SidecarClient`: log reconnect lifecycle (connection lost on which request, respawn triggered, reconnected to which target, gave up after N attempts)
- OpenCode plugin: `log()` gains the shared rotation; `autoStartProcess` logs respawn triggers
- `sentinal sidecar logs` CLI subcommand (`-n/--lines`, `--file sidecar|plugin|all`)

### Out of Scope

- Per-request/verbose debug logging or a `SENTINAL_DEBUG` level toggle (rejected in scoping — would bury signal)
- Claude Code hook stdout/stderr logging changes
- Structured (JSON) log format — plain timestamped lines match the existing `plugin.debug.log` convention
- Dashboard/TUI surfacing of logs

## Context for Implementer

> Write for an implementer who has never seen the codebase.

- **Patterns to follow:**
  - Plugin's existing logger: `targets/opencode/plugins/sentinal.ts:158` — `log()` does `appendFileSync(path, "${iso-timestamp} ${message}\n")` inside try/catch that never throws. The new util generalizes exactly this.
  - Test-time path mocking: `src/sidecar/client.test.ts:336-344` spies on `pathsModule.getSidecarSocketPath` etc. The util must export a `getLogDir()` function so tests can `spyOn(fileLogModule, "getLogDir")` the same way.
  - Overridable static hook for tests: `SidecarClient.autoStartFn` (`src/sidecar/client.ts:24-37`) — added in the 2026-06-09 bugfix; reconnect log assertions piggyback on those existing reconnect tests.
- **Conventions:** `~/.sentinal` dir comes from `DB_CONSTANTS.DB_DIR` (`src/memory/types.ts:196`) joined to `homedir()` — see `src/sidecar/paths.ts:17`. Logging must NEVER throw (always try/catch, best-effort).
- **Key files:**
  - `src/sidecar/server.ts:104-171` — `enableSessionAwareShutdown`: the interval that decides shutdown; `doShutdown()` at line 118 currently exits **silently**. Three distinct exit reasons exist in the logic: grace period after last session (line 156), stale-activity fall-through (line 141), idle fallback (line 162).
  - `src/cli/commands/sidecar.ts:41-97` — foreground `start` action: writes PID file, `console.log`s startup info that is **discarded** because all three spawn paths use `stdio: "ignore"` (`lifecycle.ts:169`, plugin `autoStartProcess`, `startBackground`). This is why `sidecar.log` must be written by the sidecar itself.
  - `src/sidecar/client.ts:160-210` — `reconnect()` / `fetchWithReconnect()`: the four loggable client events live here.
  - `targets/opencode/plugins/sentinal.ts:154-190` — plugin `log()` + `autoStartProcess` (respawn trigger).
- **Gotchas:**
  - `src/sidecar/client.ts` is imported by hooks — do NOT pull `bun:sqlite` (directly or transitively) into it or the new util. `node:fs`/`node:os`/`node:path` only.
  - The plugin (`targets/opencode/plugins/sentinal.ts`) is bundled by `build:opencode` with `--target node`; it already imports `src/sidecar/client.js`, so importing `src/utils/file-log.js` is supported. `src/cli/embedded-assets.ts` is **generated** from the built plugin — never hand-edit it.
  - Multiple processes append to `sidecar.log` concurrently. Line-sized `appendFileSync` on an `O_APPEND` fd is atomic enough; the rotation rename is best-effort and must be try/catch'd (a lost line during a rare concurrent rotation is acceptable).
  - `src/sidecar/server.ts` is 359 lines and `src/cli/commands/sidecar.ts` 212 — keep additions lean to stay under the 400 warn line. `client.ts` is already 510 (documented exemption rationale in the 2026-06-09 bugfix plan); add only ~10 lines.
- **Domain context:** The sidecar deliberately self-terminates (60s grace after sessions end; 1h stale-activity; 30min idle). The 2026-06-09 bugfix made clients heal transparently. This plan makes those transitions _visible_ so the next connectivity report can be diagnosed from logs alone.

## Assumptions

- `appendFileSync` with small line writes is effectively atomic across processes on macOS/Linux — supported by plugin's existing multi-session `log()` usage showing no interleaving corruption in 69k lines — Tasks 1-4 depend on this.
- 10MB cap with one `.1` backup generation is the agreed rotation policy (user choice) — Task 1 depends on this.
- Checking file size on every append (`statSync`) is cheap enough (~µs) for hook-path use — Task 3 depends on this; Pre-Mortem #1 covers the falsification.
- The plugin may import `src/utils/*` — supported by existing `src/sidecar/client.js` import at `sentinal.ts:60` — Task 4 depends on this.

## Testing Strategy

- **Unit:** `file-log.test.ts` — append creates file + timestamped line, rotation triggers at cap (use tiny injectable cap), `.1` replaced on second rotation, `readLastLines` returns last N, never throws on unwritable dir.
- **Integration:** `server.test.ts` — `enableSessionAwareShutdown` with short timers writes a shutdown-reason line; `client.test.ts` — existing reconnect scenarios additionally assert `sidecar.log` lines (log dir spied to tmp).
- **Manual:** `sentinal sidecar logs` against a real `~/.sentinal`.

## Risks and Mitigations

| Risk                                 | Likelihood | Impact | Mitigation                                                                                        |
| ------------------------------------ | ---------- | ------ | ------------------------------------------------------------------------------------------------- |
| Logging path adds latency to hooks   | Low        | Medium | Single `statSync` + `appendFileSync` per event; events are rare (lifecycle only, not per-request) |
| Concurrent rotation race loses lines | Low        | Low    | try/catch best-effort; only one generation kept; acceptable for debug logs                        |
| Plugin bundle breaks on Node target  | Low        | High   | util uses node:\* imports only; `build:opencode` run in verify task                               |

## Pre-Mortem

_Assume this plan failed. Most likely internal reasons:_

1. **Hook latency regression from per-append `statSync`** (Task 1/3) → Trigger: `hyperfine` on `sentinal hook shared pre-edit-guide` shows >5ms regression vs baseline. Fallback: cache size in module state, re-stat every 50 appends.
2. **Shutdown logging never fires because `doShutdown` paths don't know the reason** (Task 2) → Trigger: refactoring `doShutdown()` to accept a reason argument breaks the existing `onShutdown` test override contract in `server.test.ts`. Adapt the callback signature additively (`onShutdown?: (reason?: string) => void`).
3. **Plugin import of the util creates a circular/duplicate bundle** (Task 4) → Trigger: `build:opencode` warning about duplicate module or `sentinal.mjs` size jump >10KB. Fallback: inline the rotation logic in the plugin's `log()` (10 lines) instead of importing.

## Execution Waves

**Wave 1** — Foundation (single task): the logger util everything else imports.
**Wave 2** — Writers (parallel): sidecar server logging, client reconnect logging, plugin rotation — three disjoint file sets, all depend only on Task 1.
**Wave 3** — CLI (single task): `sidecar logs` subcommand touches `src/cli/commands/sidecar.ts`, which Task 2 also modifies — must follow Wave 2.

## Goal Verification

### Truths

1. `src/utils/file-log.ts` exists and contains the 10MB default cap — grep `10 \* 1024 \* 1024` in `src/utils/file-log.ts`
2. Sidecar logs shutdown reasons — grep `doShutdown\(` call sites in `src/sidecar/server.ts` all pass a reason argument, and `logSidecar\("shutting down` (or via reason interpolation) appears in the shutdown path
3. Client logs reconnect lifecycle — grep `logSidecar` in `src/sidecar/client.ts`
4. Plugin `log()` rotates — grep `rotateIfNeeded|maxBytes` in `targets/opencode/plugins/sentinal.ts`
5. CLI subcommand registered — grep `command\("logs"\)` in `src/cli/commands/sidecar.ts`
6. `bun test src/utils/file-log.test.ts` passes with rotation + tail coverage

### Artifacts

| Artifact                                          | Provides                                  | Exports                                                                                        |
| ------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/utils/file-log.ts`                           | Append/rotate/tail file logging           | `logToFile`, `logSidecar`, `readLastLines`, `getLogDir`, `SIDECAR_LOG_FILE`, `PLUGIN_LOG_FILE` |
| `src/sidecar/server.ts` (modified)                | Startup identity + shutdown reason lines  | `enableSessionAwareShutdown` (reason-aware)                                                    |
| `src/sidecar/client.ts` (modified)                | Reconnect lifecycle lines                 | (internal — no new exports)                                                                    |
| `targets/opencode/plugins/sentinal.ts` (modified) | Rotating plugin log + respawn breadcrumbs | (plugin entry)                                                                                 |
| `src/cli/commands/sidecar.ts` (modified)          | `sentinal sidecar logs`                   | `registerSidecarCommand` (extended)                                                            |

### Key Links

| From                                   | To                      | Via         | Pattern                                 |
| -------------------------------------- | ----------------------- | ----------- | --------------------------------------- |
| `src/sidecar/server.ts`                | `src/utils/file-log.ts` | import      | `from "../utils/file-log.js"`           |
| `src/sidecar/client.ts`                | `src/utils/file-log.ts` | import      | `from "../utils/file-log.js"`           |
| `targets/opencode/plugins/sentinal.ts` | `src/utils/file-log.ts` | import      | `from "../../../src/utils/file-log.js"` |
| `src/cli/commands/sidecar.ts`          | `src/utils/file-log.ts` | tail helper | `readLastLines`                         |

## Progress Tracking

- [x] Task 1: File logger util with rotation + tail (Wave 1)
- [x] Task 2: Sidecar startup/shutdown-reason logging (Wave 2)
- [x] Task 3: Client reconnect lifecycle logging (Wave 2)
- [x] Task 4: Plugin log rotation + respawn breadcrumbs (Wave 2)
- [x] Task 5: `sentinal sidecar logs` CLI subcommand (Wave 3)
- [x] Task 6: Verify (Wave 4)
      **Total Tasks:** 6 | **Completed:** 6 | **Remaining:** 0

## Implementation Tasks

### Task 1: File logger util with rotation + tail

**Objective:** Shared, never-throwing file logger: timestamped append, size-capped rotation to `.1`, last-N-lines reader.
**Dependencies:** None
**Wave:** 1

**Files:**

- Create: `src/utils/file-log.ts`
- Test: `src/utils/file-log.test.ts`

**Key Decisions / Notes:**

- API: `logToFile(fileName: string, message: string, opts?: { maxBytes?: number }): void` — resolves `getLogDir()` (default `join(homedir(), ".sentinal")`), mkdirs, rotates if current size > cap (default `10 * 1024 * 1024`), appends `"${new Date().toISOString()} ${message}\n"`. All in try/catch — never throws.
- Rotation: `renameSync(file, file + ".1")` (clobbers previous `.1`), then append starts a fresh file.
- `logSidecar(message)` = `logToFile(SIDECAR_LOG_FILE, message)` convenience used by server + client.
- `readLastLines(filePath: string, n: number): string[]` — read file (or return `[]` if missing), split, return last n non-empty lines. Fine to read whole file (≤10MB by construction).
- Export `getLogDir()` as a top-level exported function declaration (not a constant, not destructured at call sites) and have `logToFile`/`readLastLines` call it through the module namespace on every invocation — this is what makes the bun:test `spyOn(fileLogModule, "getLogDir")` pattern actually intercept (mirror `src/sidecar/paths.ts`, which is spied the same way in `client.test.ts:336`).
- node:\* imports only (hooks import this transitively via client.ts).

**Definition of Done:**

- [ ] All tests pass (`append creates dir+file`, `line is ISO-timestamped`, `rotation at tiny injectable cap moves content to .1`, `second rotation replaces .1`, `readLastLines returns exactly last N`, `missing file → []`, `unwritable dir does not throw`)
- [ ] No diagnostics errors
- [ ] No `bun:sqlite` in the import graph of `file-log.ts`

**Verify:**

- `bun test src/utils/file-log.test.ts`

### Task 2: Sidecar startup/shutdown-reason logging

**Objective:** The sidecar process writes its identity on start and the _reason_ on every shutdown path to `~/.sentinal/sidecar.log`.
**Dependencies:** Task 1
**Wave:** 2

**Files:**

- Modify: `src/sidecar/server.ts`
- Modify: `src/cli/commands/sidecar.ts` (start/restart actions + SIGTERM handler only — `logs` subcommand is Task 5)
- Test: `src/sidecar/server.test.ts`

**Key Decisions / Notes:**

- `enableSessionAwareShutdown` (`server.ts:104`): thread a reason string into `doShutdown(reason)`. ⚠️ There are only TWO `doShutdown()` call sites (grace at ~line 157, idle fallback at ~line 163) — the stale-activity branch (lines 141-143) is a comment-only fall-through into the grace path. To log the stale case distinctly (the most diagnostic one), capture stale context in the interval closure: when sessions exist but `activityAge >= staleActivityMs`, set `staleInfo = { count, activityAge }` before falling through (clear it otherwise), then compose the reason at the grace-path call site:
  - grace, no staleInfo → `shutting down: 0 active sessions for ${gracePeriodMs}ms`
  - grace, staleInfo set → `shutting down: ${count} session(s) stale — no HTTP activity for ${activityAge}ms (threshold ${staleActivityMs}ms)`
  - idle fallback → `shutting down: no sessions ever created, idle ${idleMs}ms`
  - Extend `onShutdown?: () => void` to `onShutdown?: (reason: string) => void` — additive, existing zero-arg callbacks remain valid.
- CLI start action (`sidecar.ts:69` after PID write): `logSidecar("started: pid=${pid} transport=${transport} port=${httpPort} socket=${socketPath}")`. SIGTERM/SIGINT handler: `logSidecar("shutting down: signal")`. Same for `restart`.
- `startSidecar`'s `alreadyRunning` branch (`server.ts:248`): `logSidecar("start skipped: live sidecar already on socket")`.
- Tests: existing `enableSessionAwareShutdown` tests in `server.test.ts` use `onShutdown` overrides — assert the reason argument; plus one test with spied `getLogDir` asserting a `shutting down:` line lands in the tmp log file.

**Definition of Done:**

- [ ] All tests pass; every `doShutdown` call site passes a distinct reason
- [ ] No diagnostics errors
- [ ] `server.ts` stays under 400 lines

**Verify:**

- `bun test src/sidecar/server.test.ts`

### Task 3: Client reconnect lifecycle logging

**Objective:** The self-healing client documents every heal: what failed, respawn trigger, what it reconnected to, or why it gave up.
**Dependencies:** Task 1
**Wave:** 2

**Files:**

- Modify: `src/sidecar/client.ts`
- Test: `src/sidecar/client.test.ts`

**Key Decisions / Notes:**

- In `fetchWithReconnect` catch: `logSidecar("client: connection lost (${method} ${path}) — reconnecting")`.
- In `reconnect()`: when `tryConnect` misses → `logSidecar("client: no live sidecar — respawn triggered")`; on success → `logSidecar("client: reconnected via ${target}")`; on exhaustion → `logSidecar("client: reconnect failed after ${attempts} attempts")`.
- Log ONLY in the reconnect path (zero overhead on healthy requests).
- Extend the existing `"SidecarClient self-healing reconnect"` describe block (`client.test.ts:461`): the log dir is already isolatable via the `pathsModule` spy pattern — add `spyOn(fileLogModule, "getLogDir")` to the same beforeEach and assert log lines after the restart/respawn/give-up scenarios.

**Definition of Done:**

- [ ] All tests pass; healthy-path tests confirm no log writes (file absent)
- [ ] No diagnostics errors
- [ ] ≤ ~15 lines added to `client.ts`

**Verify:**

- `bun test src/sidecar/client.test.ts`

### Task 4: Plugin log rotation + respawn breadcrumbs

**Objective:** `plugin.debug.log` stops growing unbounded; plugin records when it respawns the sidecar/dashboard.
**Dependencies:** Task 1
**Wave:** 2

**Files:**

- Modify: `targets/opencode/plugins/sentinal.ts`

**Key Decisions / Notes:**

- Replace `log()` body (`sentinal.ts:158`) with a call to `logToFile(PLUGIN_LOG_FILE, message)` imported from `../../../src/utils/file-log.js` (same import style as the existing `src/sidecar/client.js` import at line 60). Keep the function signature — 40+ call sites unchanged.
- `autoStartProcess` (`sentinal.ts:169`): log when actually spawning — `log("respawn: ${args.join(" ")} (pid file ${exists ? "stale" : "missing"}")`. Do NOT log the early-return (process alive) path — that fires constantly.
- Rotation behavior is covered by Task 1 tests; this task is wiring. Run `bun run build:opencode` to confirm the bundle builds and `sentinal-helpers.test.ts` still passes.
- File is length-exempt (`PATH_EXEMPTIONS`) — no length concern.

**Definition of Done:**

- [ ] `bun run build:opencode` succeeds
- [ ] `bun test targets/opencode/` passes
- [ ] No diagnostics errors introduced in the plugin (pre-existing TS2339 at lines 968/977 excluded — tracked in 2026-06-09 bugfix plan Deferred Issues)

**Verify:**

- `bun run build:opencode && bun test targets/opencode/`

### Task 5: `sentinal sidecar logs` CLI subcommand

**Objective:** One command to view recent sidecar + plugin log lines for bug reports.
**Dependencies:** Task 1, Task 2 (shares `src/cli/commands/sidecar.ts`)
**Wave:** 3

**Files:**

- Modify: `src/cli/commands/sidecar.ts`
- Test: `src/cli/commands/sidecar-logs.test.ts` (new — extract the printable-report builder as a pure function `buildLogsReport(opts): string` so it's testable without spawning the CLI)

**Key Decisions / Notes:**

- `sentinal sidecar logs [-n, --lines <n>] [--file <sidecar|plugin|all>]` — defaults `-n 50`, `--file all`.
- Output: `── sidecar.log (last N of M lines) ──` header per file, then lines; `（empty）`-style note when a file is missing.
- Uses `readLastLines` + `getLogDir` from Task 1 — no new file-reading logic.
- Keep `sidecar.ts` under 400 lines: the report builder may live in `src/cli/commands/sidecar-logs.ts` if the command file would exceed the limit.

**Definition of Done:**

- [ ] All tests pass (`last N lines`, `single-file filter`, `missing files handled`)
- [ ] No diagnostics errors
- [ ] `sentinal sidecar logs` runs against real `~/.sentinal` without error

**Verify:**

- `bun test src/cli/commands/sidecar-logs.test.ts && bun src/cli/index.ts sidecar logs -n 5`

### Task 6: Verify

**Objective:** Full suite + both-target sanity + manual smoke.
**Dependencies:** Tasks 1-5
**Wave:** 4

**Files:** None (verification only)

**Definition of Done:**

- [ ] `bun test` fully green
- [ ] `bunx tsc --noEmit` — no new errors in `src/` (baseline: 2 pre-existing in `targets/opencode/plugins/sentinal.ts`)
- [ ] `bun run build:opencode` succeeds
- [ ] Manual: start sidecar, kill it, observe `started:`/`shutting down:` lines via `sentinal sidecar logs`

**Verify:**

- `bun test && bunx tsc --noEmit && bun run build:opencode`
