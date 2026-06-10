# Follow-up Fixes + README Refresh Implementation Plan

Created: 2026-06-10
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Summary

**Goal:** Fix the dashboard spawn/staleness issues found after the shutdown fix, remove dead references, and fully refresh README.md against the actual v1.30 product surface.
**Architecture:** Make `sentinal serve` idempotent and self-replacing (health probe at startup, version takeover, EADDRINUSE handling) so every spawn path is fixed at the source; the OpenCode plugin becomes a thin version-aware trigger. Docs refreshed per audit.
**Tech Stack:** Bun/TypeScript, OpenCode plugin (Node-compatible), bun:test.

## Scope

### In Scope

1. Idempotent `sentinal serve`: health probe → exit-0/repair-pid (same version), SIGTERM-takeover (older version), logged exit-1 on bind failure; `pid` field added to `/api/health`
2. OpenCode plugin: version-aware dashboard ensure (probe health, compare against binary `--version`, spawn only when absent/stale)
3. Remove dead `sentinal notify` CLI fallback from 4 shipped skill/command files
4. Dev-rules housekeeping: fix stale jest claim in `.sentinal/rules/sentinal-project.md`; correct MCP tool counts in `.sentinal/rules/sentinal-mcp-servers.md` (26→29; memory 6→7, worktree 4→6)
5. README.md full refresh per audit (P0–P2): CLI inventory, `sentinal update` procedure incl. ≤1.29.1 transition, `memory setup`/auto-setup/self-heal, dashboard + sidecar + logs, hook pipeline table, project structure, MCP tool catalog, sub-agents claim

### Out of Scope

- Implementing a real `sentinal notify` CLI command (user chose: fix skill text instead)
- Legacy `~/.claude/plugins/sentinal/` dir (removed manually during planning; no installer change)
- package.json changes (description has no jest reference — original claim was wrong)
- Plugin version check for the *sidecar* spawn path (sidecar already self-manages via socket probe)

## Context for Implementer

- **Bug being fixed (observed live):** when `server.pid` is missing but an old dashboard still holds port 41778, spawned `sentinal serve` crashes on EADDRINUSE *before* writing a pid file → plugin respawn loop (`respawn: serve` ×3 in plugin.debug.log), all silent. Also: plugin never restarts an old-version dashboard (served v1.29.1 for 11h after upgrade).
- **Patterns to follow:**
  - Health probe with timeout: `src/dashboard/lifecycle.ts:84-86` (`fetch(..., { signal: AbortSignal.timeout(1000) })`)
  - Lifecycle logging: `logDashboard()` from `src/utils/file-log.ts` (added in 1e7b422)
  - Health handler: `src/dashboard/routes/api.ts:25-27` returns `{ status, version }` — add `pid: process.pid`
  - Plugin spawn helper: `targets/opencode/plugins/sentinal.ts:175-199` (`autoStartProcess`), call site line 327
  - Test patterns: `spyOn(fileLogModule, "getLogDir")` + `spyOn(lifecycleModule, "getPidFilePath")` per `src/dashboard/lifecycle.test.ts` (logging suite)
- **Gotchas:**
  - `src/cli/embedded-assets.ts` is generated — never hand-edit; skill-file changes flow in via `bun run build:cli`
  - Plugin file is file-length-exempt but Node-compatible only (no Bun APIs); `fetch` + `AbortSignal.timeout` are fine (Node ≥18)
  - TDD guard: failing test before each impl edit; `tdd_set_state RED_CONFIRMED` per file
  - CLI action handlers aren't unit-testable directly — extract decision logic into `src/dashboard/lifecycle.ts` exported helpers
- **Domain context:** dashboard = detached `sentinal serve` process, PID at `~/.sentinal/server.pid`, port 41778 fixed. Spawned by Claude SessionStart hook (`autoStartDashboard`, already version-aware) and OpenCode plugin init (`autoStartProcess`, currently PID-liveness only).

## Runtime Environment

- **Start:** `sentinal serve` (foreground) / `--background`; port 41778; health: `curl http://127.0.0.1:41778/api/health`
- **Logs:** `~/.sentinal/dashboard.log`, `~/.sentinal/plugin.debug.log`

## Assumptions

- OpenCode plugin runtime is Node ≥18 (global `fetch`, `AbortSignal.timeout`) — supported by existing fetch use in SidecarClient — Tasks 2
- Adding `pid` to `/api/health` is backward compatible (consumers ignore extra fields) — Tasks 1, 2
- Spawning `binPath --version` once at plugin init is acceptable (~50ms, async) — Task 2
- Actual MCP tool count is 29 (memory 7, spec 9, worktree 6, tdd 3, analysis 3, project 1) — re-verify by grepping `server.tool(` registrations before writing docs — Tasks 4, 5

## Testing Strategy

- Unit: serve-startup decision helper (probe outcomes → start/exit/takeover), health pid field, plugin load smoke
- Integration: two `startServer` instances → second resolves via takeover/exit path
- Manual: live smoke — kill dashboard, run `sentinal serve` twice; second invocation exits 0 "already running"; `dashboard.log` entries present

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Port-release race during takeover (SIGTERM old → bind new) | Medium | Startup failure | Retry bind ~3× with 200ms delay; covered by unit test with injected waiter |
| README numbers drift (tool counts, hook counts) | Medium | Stale docs again | Grep-verify every count cited during Task 5; cite none that can't be grepped |
| Plugin change breaks load | Low | All hooks dead | Existing load-smoke test in sentinal.test.ts; extend for new helper |

## Pre-Mortem

_Assume this plan failed. Most likely internal reasons:_

1. **Takeover kill uses health pid but old dashboard pre-dates pid-in-health** (Task 1) → Trigger: health JSON lacks `pid` field during live smoke → fall back to pid file, else log + exit 1 with clear message (manual kill instruction)
2. **`--version` spawn in plugin hangs OpenCode init** (Task 2) → Trigger: plugin init noticeably slow → make ensureDashboard fully async fire-and-forget (never await in plugin factory)
3. **README refresh introduces claims tests can't verify** (Task 5) → Trigger: Goal Verification greps fail → only document grep-confirmed commands/flags

## Execution Waves

**Wave 1** — Task 1 (serve idempotence, src-side foundation)
**Wave 2** — Task 2 (plugin, depends on health `pid` field from Task 1)
**Wave 3** — Task 3 + Task 4 (independent doc fixes; trivial, run sequentially in main context)
**Wave 4** — Task 5 (README — written after code lands so it documents reality)
**Wave 5** — Task 6 (verify)

## Goal Verification

### Truths

1. `rg "pid: process.pid" src/dashboard/routes/api.ts` matches (health exposes pid)
2. `curl -s http://127.0.0.1:41778/api/health` returns JSON containing `"pid":` (runtime)
3. `rg "api/health" targets/opencode/plugins/sentinal.ts` AND `rg -- "--version" targets/opencode/plugins/sentinal.ts` both match (probe + version comparison present) and `rg 'autoStartProcess\("server.pid", "serve"\)' targets/opencode/plugins/sentinal.ts` does NOT match
4. `rg -l "sentinal notify" targets/ --glob '!**/dist/**'` returns no files AND `rg -c "sentinal notify" src/cli/embedded-assets.ts` returns 0 (after `bun run build:cli` regeneration)
5. `rg "sentinal update" README.md` and `rg "memory setup" README.md` both match
6. `rg "29 tools" .sentinal/rules/sentinal-mcp-servers.md` matches
7. Running `sentinal serve` while a same-version dashboard is live exits 0 without a second process (live smoke)

### Artifacts

| Artifact | Provides | Exports |
| --- | --- | --- |
| src/dashboard/lifecycle.ts | startup decision helper + health probe | `probeDashboardHealth()`, `decideServeStartup()` (names final at impl) |
| src/dashboard/routes/api.ts | health with pid | healthHandler |
| src/cli/commands/serve.ts | idempotent serve startup | registerServeCommand |
| targets/opencode/plugins/sentinal.ts | version-aware dashboard ensure | ensureDashboard (internal) |
| README.md | refreshed docs | — |
| .sentinal/rules/sentinal-{project,mcp-servers}.md | corrected dev rules | — |

### Key Links

| From | To | Via | Pattern |
| --- | --- | --- | --- |
| src/cli/commands/serve.ts | src/dashboard/lifecycle.ts | startup decision | `decideServeStartup\|probeDashboardHealth` |
| targets/opencode/plugins/sentinal.ts | /api/health | version probe | `api/health` |
| README.md | update command | docs | `sentinal update` |

## Progress Tracking

- [x] Task 1: Idempotent serve + health pid (Wave 1)
- [x] Task 2: Plugin version-aware dashboard ensure (Wave 2)
- [x] Task 3: Remove dead `sentinal notify` references (Wave 3)
- [x] Task 4: Dev-rules housekeeping (Wave 3)
- [x] Task 5: README full refresh (Wave 4)
- [x] Task 6: Verify (Wave 5)
      **Total Tasks:** 6 | **Completed:** 0 | **Remaining:** 6

## Implementation Tasks

### Task 1: Idempotent serve + health pid

**Objective:** `sentinal serve` startup becomes safe under every pid-file/port state: same-version live → exit 0 + repair pid file; older-version live → SIGTERM takeover (health pid, pid-file fallback) with bind retry; bind failure → `logDashboard` + exit 1.
**Dependencies:** None
**Wave:** 1

**Files:**

- Modify: `src/dashboard/routes/api.ts` (healthHandler + pid)
- Modify: `src/dashboard/lifecycle.ts` (probe + startup-decision helpers, exported for tests)
- Modify: `src/cli/commands/serve.ts` (use helpers; log every outcome)
- Test: `src/dashboard/server.test.ts` (health pid), `src/dashboard/lifecycle.test.ts` (decision matrix: no-response/same-version/older-version/probe-error; pid repair; takeover kill called)

**Key Decisions / Notes:**

- Probe `http://127.0.0.1:41778/api/health` with `AbortSignal.timeout(1000)`; connection-refused = not running (fast path)
- Decision helper is pure-ish with injected `kill`/`waiter` fns so tests never signal real processes
- Bind retry: up to 3 attempts, 200ms apart, only in takeover path
- Takeover edge cases in test matrix: kill throws ESRCH (process already gone → proceed to bind); health alive but lacks `pid` field (old ≤1.30.1 dashboard) AND no pid file → cannot take over
- **Old-dashboard dead-end (reviewer should_fix):** when takeover is needed but no pid is obtainable, exit 1 with an actionable message on stderr + dashboard.log: `dashboard: cannot stop old dashboard (no pid available) — run: lsof -ti :41778 | xargs kill`

**Definition of Done:**

- [ ] `/api/health` returns `pid`
- [ ] Decision matrix unit-tested (6+ cases incl. ESRCH and no-pid-available) and serve.ts consumes the helper
- [ ] No-pid-available failure prints the exact manual remediation command (test asserts message content)
- [ ] All outcomes logged to dashboard.log
- [ ] All tests pass, zero tsc errors

**Verify:**

- `bun test src/dashboard/server.test.ts src/dashboard/lifecycle.test.ts`

### Task 2: Plugin version-aware dashboard ensure

**Objective:** Replace blind `autoStartProcess("server.pid", "serve")` with async `ensureDashboard()`: health probe → spawn if absent; if alive, compare health version to binary version (`spawn(binPath, ["--version"])`, once) → spawn on mismatch (idempotent serve performs the takeover). Never blocks plugin init.
**Dependencies:** Task 1
**Wave:** 2

**Files:**

- Modify: `targets/opencode/plugins/sentinal.ts`
- Test: `targets/opencode/plugins/sentinal.test.ts` (load smoke still passes; ensureDashboard logic via exported helper or injected fetch/spawn)

**Key Decisions / Notes:**

- Fire-and-forget from plugin factory (`void ensureDashboard()` in try/catch) — Pre-Mortem #2
- Keep `autoStartProcess` untouched for the sidecar path
- Log decisions to plugin.debug.log (`dashboard ensure: ...`)

**Definition of Done:**

- [ ] Blind serve spawn call site gone; sidecar call site unchanged
- [ ] Plugin load smoke green; `bun run build:opencode` clean
- [ ] All tests pass

**Verify:**

- `bun test targets/opencode/plugins/sentinal.test.ts && bun run build:opencode`

### Task 3: Remove dead `sentinal notify` references

**Objective:** Delete the nonexistent `sentinal notify ...` CLI fallback lines from shipped skills/commands (MCP `spec_notify` remains the only documented path).
**Dependencies:** None
**Wave:** 3

**Files:**

- Modify: `targets/opencode/skills/spec-bugfix-plan/SKILL.md`, `targets/opencode/skills/spec-verify/SKILL.md`, `targets/claude-code/commands/spec-bugfix-plan.md`, `targets/claude-code/commands/spec-verify.md`

**Definition of Done:**

- [ ] `rg -l "sentinal notify" targets/ --glob '!**/dist/**'` empty
- [ ] `bun run build:cli` run after the edits; regenerated `src/cli/embedded-assets.ts` contains zero `sentinal notify` matches and is committed (reviewer should_fix — embedded copies ship in the binary)
- [ ] Surrounding instructions still read coherently (MCP-tool-only)

**Verify:**

- `rg -l "sentinal notify" targets/ --glob '!**/dist/**' | wc -l` → 0 && `rg -c "sentinal notify" src/cli/embedded-assets.ts || echo 0` → 0

### Task 4: Dev-rules housekeeping

**Objective:** Correct `.sentinal/rules/sentinal-project.md` (drop the false "jest description is stale" note) and `.sentinal/rules/sentinal-mcp-servers.md` (29 tools; memory 7 incl. `memory_share`, worktree 6 incl. abandon/cleanup — re-verify counts by grepping `server.tool(`/register calls first).
**Dependencies:** None
**Wave:** 3

**Files:**

- Modify: `.sentinal/rules/sentinal-project.md`, `.sentinal/rules/sentinal-mcp-servers.md`

**Definition of Done:**

- [ ] Counts match grep-verified registrations
- [ ] No remaining stale-jest claim

**Verify:**

- `rg "29" .sentinal/rules/sentinal-mcp-servers.md`

### Task 5: README full refresh

**Objective:** Apply audit P0–P2: rewrite CLI section (~20 commands, grouped); new "Updating" section (`sentinal update`, `--check`, 24h background check, v1.30+ auto plugin reinstall, ≤1.29.1 manual-reinstall transition note **including the one-time stale-dashboard remediation**: old dashboards pre-dating pid-in-health may need `lsof -ti :41778 | xargs kill` once); new "Semantic memory search" coverage (`memory setup`, auto-setup at install/update, `SENTINAL_NO_AUTO_SETUP=1`, sidecar self-heal); dashboard (`serve`, 41778, dashboard.log) + sidecar (`logs --file sidecar|plugin|dashboard|all`, session-aware shutdown incl. dashboard); fix project structure, hook pipeline table (18 hooks via `sentinal hook` dispatcher), MCP catalog (29 tools/6 domains), sub-agents-not-Claude-only, TDD guard wording, binary-first install framing.
**Dependencies:** Tasks 1–4 (document final behavior)
**Wave:** 4

**Files:**

- Modify: `README.md`

**Definition of Done:**

- [ ] Every audit P0 item addressed; P1/P2 covered
- [ ] Every count/flag cited is grep-verified against source
- [ ] Truths 5 greps pass

**Verify:**

- `rg "sentinal update" README.md && rg "memory setup" README.md`

### Task 6: Verify

**Objective:** Full suite + quality + builds + live smoke (serve idempotence, takeover from a stale dashboard if reproducible, dashboard.log/plugin.debug.log entries; Goal Verification truths).
**Dependencies:** Tasks 1–5
**Wave:** 5

**Verify:**

- `bun test > /tmp/t.log 2>&1; echo $?` → 0, `bunx tsc --noEmit`, `bun run build:all && bun run build:cli`
