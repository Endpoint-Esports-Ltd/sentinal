# `sentinal update` Deploys Stale Embedded Assets Fix Plan

Created: 2026-06-10
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Bugfix

## Summary

**Symptom:** After `sentinal update` upgrades the binary, the OpenCode plugin (`~/.config/opencode/plugins/sentinal.mjs`) and Claude Code assets (hooks.json, commands, rules, agents, skills) remain at the OLD version. Observed live during the v1.28.0 → v1.29.0 upgrade: binary reported 1.29.0 but the deployed plugin was the stale 66KB pre-Phase-3 bundle missing the workspace adaptor, and hooks.json lacked the Phase 4 args exec form.

**Trigger:** Every `sentinal update` that downloads a new binary.

**Root Cause:** `src/cli/commands/update.ts:446` — the update action calls `reinstallPlugins()` (line 361) **in-process** after swapping the binary on disk (line 327). `reinstallPlugins()` calls `installClaudeCode()` / `installOpenCode()` imported from `./install.js`, and those functions extract assets from `src/cli/embedded-assets.ts` — which was **baked into the OLD binary at its build time**. Replacing the file on disk does not change the running process's code, so the freshly written assets are the old version's.

## Investigation

- `downloadAndInstall()` (update.ts:214-350) atomically replaces `~/.sentinal/bin/sentinal` — correct.
- `registerUpdateCommand` action (update.ts:441-454): `downloadAndInstall()` → `reinstallPlugins()` — the reinstall is the last step and runs in the old process.
- `reinstallPlugins()` (update.ts:361-406): detect targets → `uninstallClaudeCode()` + `installClaudeCode()`, `uninstallOpenCode({preserveBinary})` + `installOpenCode(false, true)` — all in-process imports.
- Install functions ship assets from `embedded-assets.ts` (generated at build by `scripts/embed-assets.mjs`; the binary embeds `targets/opencode/dist/sentinal.mjs`, hooks.json, commands, rules).
- Confirmed empirically (memory #124): after update to 1.29.0, deployed plugin grep for `sentinal-spec-worktree` = 0 matches; re-running `sentinal install opencode` from the NEW binary deployed the correct 90KB bundle.
- Working example for comparison: invoking `sentinal install opencode` as a fresh process always uses that binary's own embedded assets — the fix is to make the update flow do exactly this with the new binary.

## Behavior Contract

### Fix Property (C => P)

**When condition C holds:** `sentinal update` successfully downloads and installs a new binary to `~/.sentinal/bin/sentinal`
**Property P must hold:** the post-update plugin reinstall executes **the new binary as a subprocess** (`<BIN_PATH> update --reinstall-plugins`), so deployed assets come from the new version's embedded assets

### Preservation Property (!C => unchanged)

**When condition C does NOT hold:**

- `--check` mode: unchanged (no install, no reinstall)
- Download fails: unchanged (exit 1, no reinstall)
- Already up to date: reinstall still runs (now via subprocess — same version, identical assets)
- Subprocess spawn fails (e.g. binary missing when running from source): **fall back to in-process `reinstallPlugins()`** with a warning — current behavior preserved as degraded path
- Reinstall failures remain non-fatal: binary update already succeeded, user is told to run `sentinal install` manually

## Fix Approach

**Files:** `src/cli/commands/update.ts`, `src/cli/commands/update.test.ts`

**Strategy:**

1. Add a hidden `--reinstall-plugins` option to the `update` command: when set, run ONLY `reinstallPlugins()` and return (no download, no recursion — guards infinite spawn loops by construction).
2. Extract `runPostUpdateReinstall(opts?)` with an injectable spawner (default `Bun.spawnSync`/`child_process.spawnSync` with `stdio: "inherit"`):
   - If `BIN_PATH` exists → spawn `BIN_PATH update --reinstall-plugins`; on exit 0 → done.
   - If spawn fails / non-zero / binary missing → warn + fall back to in-process `reinstallPlugins()`.
3. Update the action handler: replace the direct `reinstallPlugins()` call (line 446) with `runPostUpdateReinstall()`.

**Tests** (follow existing `spyOn` patterns in update.test.ts):

- `runPostUpdateReinstall` spawns `[BIN_PATH, "update", "--reinstall-plugins"]` when the binary exists; in-process `reinstallPlugins` is NOT called.
- Falls back to in-process `reinstallPlugins()` when the spawner throws or returns non-zero.
- Falls back when `BIN_PATH` does not exist.

**Notes:** CLI-shared code only — no target wiring (hooks.json / opencode plugin) involved. No sidecar routes. Single file + its test ⇒ Compact plan.

## Progress

- [x] Task 1: Fix
- [x] Task 2: Verify
      **Tasks:** 2 | **Done:** 2 | **Left:** 0

## Verification Notes

- Full suite: 1379 pass / 0 fail; tsc clean; prettier clean (ESLint config absent repo-wide — pre-existing)
- Live smoke (flag path): `bun src/cli/index.ts update --reinstall-plugins` ran reinstall-only ✓
- Live smoke (full path): update spawned `<new-binary> update --reinstall-plugins`; v1.29.1 predates the flag → subprocess exited 1 → fallback warning printed → in-process reinstall completed ✓ (validates BOTH the spawn wiring and the fallback path live)
- Transition note: users updating FROM versions before this fix still hit the stale-assets bug one final time (their old binary lacks runPostUpdateReinstall). Unavoidable; the manual `sentinal install` double-tap applies once more.

## Tasks

### Task 1: Fix

**Objective:** Regression tests for subprocess reinstall + fallback, then implement `runPostUpdateReinstall` and the hidden flag
**Files:** `src/cli/commands/update.ts`, `src/cli/commands/update.test.ts`
**TDD:** Write regression tests → verify FAIL → implement → verify all PASS
**Verify:** `bun test src/cli/commands/update.test.ts`

### Task 2: Verify

**Objective:** Full suite + quality checks + live smoke
**Verify:** `bun test && bunx tsc --noEmit`; live smoke: `sentinal update` (already up to date path) should spawn the reinstall subprocess and deploy assets identical to `sentinal install`
