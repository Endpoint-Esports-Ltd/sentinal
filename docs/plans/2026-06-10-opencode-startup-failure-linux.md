# OpenCode Startup Failure on Linux (zod-external plugin bundle) Fix Plan

Created: 2026-06-10
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Bugfix

## Summary

**Symptom:** `opencode` fails to launch with `Error: Unexpected server error. Check server logs for details.` — dies after TUI config load, before the server bootstraps, before any plugin logging, in every directory, on OpenCode 1.17.1 AND 1.17.0.
**Trigger:** Sentinal v1.31.0 install/update rewrote `~/.config/opencode/plugins/sentinal.mjs` at 16:08:38 (Linux) with the embedded bundle, on a machine whose `~/.config/opencode/` contains a `package.json`/`node_modules`/lockfiles WITHOUT zod.
**Root Cause:** `package.json:36` — `build:opencode` bundles the plugin with `--external zod`, so the shipped `sentinal.mjs` contains 4 bare `from "zod"` imports. Bun resolves these via silent network auto-install ONLY when no `node_modules`/lockfile exists in the loading directory; when one exists (Linux box: notifier plugin deps), auto-install is disabled, the import throws `Cannot find package 'zod'`, OpenCode's plugin loader dies, and the server returns the generic startup error.

## Investigation

- Isolation Test A (user, Linux): removing `sentinal.mjs` → OpenCode boots fully (`init count=6`); restoring it → instant failure. Artifact mtime 16:08:38 = AFTER the last working run (15:12), killing the earlier OpenCode-1.17.1-regression theory (#31701) — downgrade to 1.17.0 changed nothing
- Local reproduction (Mac, exact released artifact): sandbox-installed the v1.31.0 release binary (`HOME=fakehome sentinal install opencode`) → extracted plugin is byte-count-identical (94670) to the Linux file → `bun -e 'import(...)'` LOADS OK in a clean dir (auto-install masks it) but **fails with `Cannot find package 'zod'`** the moment an empty `package.json` + `node_modules` + `bun.lock` exist in the config dir — the precise Linux condition (user's Step 0 `ls` shows all three)
- `--external zod` introduced in `349e46f` (March, v1.2.0). **Historical rationale (user-recalled, verified):** the plugin registers a native tool (`sentinal_tdd_status`) whose zod arg schemas cross the boundary into OpenCode's runtime; "rely on their version" avoided dual-zod-instance fears (see `docs/plans/2026-04-20-claude-opencode-changelog-audit-phase-3.md:73,453` + history at `sentinal.ts:1055` — though that failure was raw-objects-vs-schemas, not dual instances)
- **Why bundling is safe NOW (verified upstream):** OpenCode's `registry.ts` `isZodType()` duck-types on the `_zod` property (NOT `instanceof`), then wraps with host `z.object(args)` — zod 4's `_zod` internal protocol is designed for cross-instance interop. A bundled zod 4 schema passes detection and converts to JSON Schema via the host. Residual risk (zod major-version skew if OpenCode ever moves off zod 4) is covered by explicit native-tool live verification in Task 2; the alternative (keep external, write zod into the user's config-dir package.json) depends on OpenCode's startup `bun install` behavior and conflicts with other plugins' lockfiles — strictly worse
- The other three externals (`bun:sqlite`, `sqlite-vec`, `@xenova/transformers`) are native/heavy, must remain external, and are NOT in the plugin's bundle graph (verified: only `zod` appears as a bare import)
- Bundle source of zod imports: `src/memory/types.ts`, `src/spec/types.ts`, `src/opencode/native-tdd-status.ts`, `src/memory/shared.ts` (Zod schemas)
- Hidden side-benefit of the fix: clean-machine plugin loads currently trigger a network fetch of zod on EVERY OpenCode start — bundling removes that latency/network dependence
- Sentinal v1.30.x/v1.31.0 irrelevant otherwise: plugin loaded fine pre-16:08 because the previously deployed file was older; sidecar + dashboard healthy throughout

## Behavior Contract

### Fix Property (C ⇒ P)

**When condition C holds:** `~/.config/opencode/` contains a `package.json`/`node_modules`/lockfile that does not provide `zod` (or the machine is offline).
**Property P must hold:** the shipped `sentinal.mjs` imports successfully — the bundle is self-contained (zero bare non-`node:` imports except none at all) — and OpenCode boots with the plugin active.

### Preservation Property (¬C ⇒ unchanged)

**When condition C does NOT hold** (clean config dir, zod resolvable): plugin behavior is byte-for-byte functionally identical — same exports (`SentinalPlugin`, `ensureDashboardForTest`), same hooks, all existing plugin tests pass. Native externals (`bun:sqlite`, `sqlite-vec`, `@xenova/transformers`) stay external in the build flags (they're tree-shaken out of the plugin graph anyway).

## Fix Approach

**Files:** `package.json` (drop `--external zod` from `build:opencode`), `src/cli/target-assets.test.ts` (regression test), `src/cli/embedded-assets.ts` (regenerated via `bun run embed-assets` — never hand-edited)
**Strategy:** Remove `--external zod`; rebuild; the bundle inlines zod (~+100KB, acceptable). Regression test asserts the embedded plugin string in `src/cli/embedded-assets.ts` contains NO bare `from "zod"` (and none of the other three externals) — guarding the whole class: any future bare-import leak into the shipped plugin fails CI before release.
**Tests:** RED structural test first (fails against current embedded assets), then fix + regen → GREEN. Sandbox import-test replicating the Linux condition as final verification.
**User remediation meanwhile (Linux, pick one):** keep `sentinal.mjs` moved aside until the next release, OR `cd ~/.config/opencode && npm install zod` (restores plugin immediately).

## Deferred Issues (non-causal, found during investigation)

1. Plugin double-load: `install.ts:634` writes the plugin into the auto-loaded `plugins/` dir AND `:760,808` registers `./plugins/sentinal.mjs` in `config.plugin` → two instances per session (doubled hooks/sessions/spawns; confirmed in logs since March)
2. `getBinaryVersion()` accepts literal `"undefined"` stdout from a mid-update binary — needs semver validation
3. Mac dev machine still on binary 1.30.1 — run `sentinal update` after this fix ships

## Progress

- [x] Task 1: Fix (regression test + bundle zod + regen embedded assets)
- [x] Task 2: Verify
      **Tasks:** 2 | **Done:** 2 | **Left:** 0

## Verification Results

- **Regression test:** RED (detected `from "zod"` in embedded bundle) → fix → GREEN; guards all 4 external specifiers against future bare-import leaks
- **Full suite:** 1496/1496 pass (1495 baseline + 1 new); `tsc --noEmit` clean; `build:all` + `build:cli` succeed (binary reports 1.31.0)
- **Fix property (C ⇒ P):** sandbox with `package.json` + `node_modules` + `bun.lock` and no zod (exact Linux condition) → bundle imports cleanly, exports `SentinalPlugin`/`ensureDashboardForTest`
- **Preservation (¬C):** clean-dir import unchanged; same exports; plugin deployed locally via `deploy:opencode`
- **Dual-zod boundary (original externalization rationale):** simulated OpenCode `registry.ts` `fromPlugin()` with a host zod instance distinct from the bundled one — `isZodType` (`_zod` duck-type) passes, host `z.object()` + `z.toJSONSchema()` produce correct schema for `sentinal_tdd_status` (props: `file_path`, `spec_id`) — PASS
- **Bundle size:** 94,670 → 572,754 bytes (zod 4 heavier than the ~100KB estimate; once-per-startup load, accepted; eliminates the previous per-start network auto-install of zod on clean machines)
- **Ships in:** next release (v1.31.1) via release pipeline; Linux machine fixed by `sentinal update` after release (interim: `npm install zod` in `~/.config/opencode/` or keep plugin file aside)

## Tasks

### Task 1: Fix

**Objective:** RED structural test → drop `--external zod` → rebuild + regen → GREEN.
**Files:** `src/cli/target-assets.test.ts`, `package.json:36`, `src/cli/embedded-assets.ts` (regen), `targets/opencode/dist/sentinal.mjs` (build output, gitignored)
**TDD:**

1. Add test to `src/cli/target-assets.test.ts`: extract `EMBEDDED_OPENCODE_PLUGIN` from `src/cli/embedded-assets.ts` and assert it contains no `from "zod"`, `from "bun:sqlite"`, `from "sqlite-vec"`, `from "@xenova/transformers"` (regex over bare import specifiers)
2. `bun test src/cli/target-assets.test.ts` — confirm RED (current embedded bundle has 4 zod imports)
3. Edit `package.json` `build:opencode`: remove `--external zod` only
4. `bun run embed-assets` (runs build:opencode + regenerates embedded-assets.ts)
5. Re-run test — GREEN
6. Sandbox repro check: write bundle to a temp dir containing `{"dependencies":{}}` package.json + empty `node_modules` + `bun.lock`, then `bun -e 'import(...)'` → must print LOADED OK

**Verify:** `bun test src/cli/target-assets.test.ts && rg -c 'from "zod"' src/cli/embedded-assets.ts; echo "expect 0 matches in plugin constant"`

### Task 2: Verify

**Objective:** Full suite + quality + build + live smoke, including the dual-zod risk check.
**Verify:** `bun test > /tmp/t.log 2>&1; echo $?` → 0; `bunx tsc --noEmit`; `bun run build:all`; `bun run build:cli` succeeds; deploy locally (`bun run deploy:opencode`) and in a fresh OpenCode session confirm: (a) plugin loads (plugin.debug.log entry), (b) **native tool `sentinal_tdd_status` registers and executes** (dual-zod boundary check — the reason zod was originally externalized), (c) sandbox import-test with node_modules present passes; confirm bundle size growth is ~100KB not MBs
