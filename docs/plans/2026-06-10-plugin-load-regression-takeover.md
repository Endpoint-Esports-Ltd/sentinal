# v1.31.2 Plugin-Load Regression + Takeover Fixes Plan

Created: 2026-06-10
Status: IN_PROGRESS
Approved: Yes (user-directed: "fix the takeover defect"; regression fix implied — plugin currently disabled for all binary-mode OpenCode users)
Iterations: 0
Worktree: No
Type: Bugfix

## Summary

**Symptom (1) — CRITICAL regression in v1.31.2:** the OpenCode plugin silently does not load at all for binary installs. No TDD guard, no memory capture, no session tracking; zero log lines; no error anywhere. Found via live smoke: in-session Edit on a guarded file sailed through while the CLI dispatcher guard blocked.
**Symptom (2):** `sentinal serve` cannot take over a pre-1.31 dashboard ("no pid available") even when `~/.sentinal/server.pid` holds the valid pid; and `serve --background` prints "Dashboard started (PID: N)" even when the child immediately exited 1.

**Root Cause (1):** v1.31.2's "double-load fix" removed the `config.plugin` entry in binary mode, assuming directory auto-load covered it. **Wrong:** upstream `packages/opencode/src/config/plugin.ts` scans `{plugin,plugins}/*.{ts,js}` — **`.mjs` is excluded from the glob**, so `sentinal.mjs` was NEVER directory-auto-loaded. The config entry was the only load path; removing it disabled the plugin. (Verified live: a probe `.ts` in the same dir loads; `sentinal.mjs` does not.) The "double-load" evidence (multiple same-millisecond ensure lines) is actually **normal per-instance plugin init** — OpenCode creates multiple instances (main/subagent/compaction) per session, each initializing plugins.
**Root Cause (2a):** `src/dashboard/lifecycle.ts:218-221` — `decideServeStartup` only reads `pid` from the health response (absent in ≤1.30.x) and never falls back to the pid file.
**Root Cause (2b):** `src/cli/commands/serve.ts:106-122` — `startBackground` is fire-and-forget with stdio ignored; prints unconditional success.

## Behavior Contract

### Fix Property (C ⇒ P)

1. Binary-mode install/update writes the plugin file AND registers `./plugins/sentinal.mjs` in `config.plugin` (deduped) — plugin loads in fresh OpenCode sessions (ensure + Connected lines appear; TDD guard blocks in-session).
2. Version-mismatch takeover with no `health.pid` but a valid `server.pid` file → `takeover` with that pid (SIGTERM + start), not `takeover-no-pid`.
3. `serve --background` exits 0 and prints success ONLY when the child's `/api/health` answers with the current version within the startup window; otherwise exits 1 relaying the child's failure.

### Preservation Property (¬C ⇒ unchanged)

1. npm-mode entry unchanged; legacy/duplicate sentinal entries still deduped to exactly one; third-party plugin entries preserved.
2. `takeover-no-pid` still returned when BOTH health-pid and pid-file are unavailable/stale; same-version `exit` and clean `start` paths unchanged.
3. Foreground serve behavior unchanged.

## Fix Approach

**Files:** `src/cli/commands/install.ts` (+ test), `src/dashboard/lifecycle.ts` (+ test), `src/cli/commands/serve.ts` (+ test if present)
**Strategy:**
- `buildPluginList`: binary mode appends `pluginPath` again (filter legacy + append — for dedup), npm unchanged; update doc comment with the `.mjs`-glob discovery + upstream reference so this never regresses the other way
- `decideServeStartup`: add injectable `pidFileReadFn` (default: read+validate `~/.sentinal/server.pid`, `kill -0` aliveness) consulted when health lacks pid
- `startBackground`: pipe child stderr; poll health (up to ~5s) for `version === current`; race against child exit; truthful success/failure output + exit code
- Correct the historical record: append invalidation note to `2026-06-10-plugin-doubleload-version-read.md`; update memory
**Tests:** RED-first — install tests flip expectations back; lifecycle tests for pid-file fallback matrix (file valid / stale / missing); background covered via extracted pollable helper if cleanly testable, else live smoke

## Progress

- [x] Task 1: Restore plugin load path (install.ts) + correct records
- [x] Task 2: Takeover pid-file fallback + truthful --background
- [ ] Task 3: Verify (suite, builds, live smoke with REAL session restart)
      **Tasks:** 3 | **Done:** 0 | **Left:** 3

## Tasks

### Task 1: Restore plugin load path

**Objective:** RED (flip buildPluginList binary-mode tests to expect append) → fix helper + comments → GREEN; append invalidation note to the doubleload plan.
**Files:** `src/cli/commands/install.test.ts`, `src/cli/commands/install.ts`, `docs/plans/2026-06-10-plugin-doubleload-version-read.md`
**Verify:** `bun test src/cli/commands/install.test.ts`

### Task 2: Takeover fixes

**Objective:** RED tests for pid-file fallback in `decideServeStartup` → implement; truthful `--background` via health-poll/child-exit race.
**Files:** `src/dashboard/lifecycle.ts`, `src/dashboard/lifecycle.test.ts` (or wherever decideServeStartup tests live), `src/cli/commands/serve.ts`
**Verify:** `bun test src/dashboard/`

### Task 3: Verify

**Objective:** Full suite + tsc + builds + embed regen; deploy + REAL OpenCode session restart with behavioral probes (ensure line present, in-session TDD-guard block) — the check v1.31.2's verification skipped.
**Verify:** `bun test > /tmp/t.log 2>&1; echo $?` → 0; `bunx tsc --noEmit`; `bun run embed-assets`; live: plugin.debug.log init lines + in-session guard block after user restart

## Verification Results

- Tests: 1512/1512 (17 new: 6 buildPluginList rewrites + 4 pid-file fallback + 3 waitForDashboardHealthy + existing adjustments); tsc clean
- Live: `serve --background` with version mismatch performed a real takeover (SIGTERM via health pid) and reported truthful PID+version; same-version path reports "running" correctly
- User's Mac config restored by hand (plugin entry re-added) pending release

## Deferred Issues

- Takeover is direction-agnostic: an OLDER binary will take over a NEWER running dashboard (observed live — a local 1.31.1 build downgraded the 1.31.2 dashboard). In practice spawns use the installed binary, but a semver comparison gate (only newer replaces older) would be safer. Defer to a follow-up.
