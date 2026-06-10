# Plugin Double-Load + Version-Read Validation Fix Plan

Created: 2026-06-10
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Bugfix

## Summary

**Symptom (1):** OpenCode loads the Sentinal plugin TWICE per session — doubled hooks, sidecar sessions, dashboard-ensure spawns (proven by doubled log pairs ~180ms apart in Linux logs since March).
**Symptom (2):** `dashboard ensure: version mismatch (running=1.30.0 current=undefined)` — plugin treated a mid-update binary's literal `"undefined"` stdout as a valid version, triggering a pointless respawn.
**Root Cause (1):** `src/cli/commands/install.ts` binary mode BOTH writes `~/.config/opencode/plugins/sentinal.mjs` (auto-loaded by OpenCode's plugins-directory scan) AND appends `./plugins/sentinal.mjs` to `config.plugin` (line ~808) — same module registered through two load paths. NPM mode legitimately needs the config entry (`@endpoint/sentinal/opencode-plugin` package ref, no file in plugins/).
**Root Cause (2):** `targets/opencode/plugins/sentinal.ts:188` — `getBinaryVersion()` returns `stdout.trim()` unvalidated; a binary mid-replace printed `undefined`, and the `?? "unknown"` guard can't catch a literal string.

## Behavior Contract

### Fix Property (C ⇒ P)

1. When installing in **binary mode**: `config.plugin` contains NO sentinal entry (legacy `./plugins/sentinal.mjs` entries from prior installs are removed); the plugin loads exactly once via directory auto-load.
2. When `sentinal --version` emits anything that isn't `MAJOR.MINOR.PATCH...`: `getBinaryVersion()` returns `null` (ensure logs `current=unknown`, skips version-mismatch respawn).

### Preservation Property (¬C ⇒ unchanged)

1. **NPM mode** still appends `@endpoint/sentinal/opencode-plugin` to `config.plugin` (only load path in that mode); non-sentinal plugin entries always preserved in order; fresh-config branch omits `plugin` key in binary mode.
2. Valid semver stdout (e.g. `1.31.1`, `1.31.1-beta.1`) returned unchanged; cache semantics (`undefined` sentinel / `null` failure) untouched.

## Fix Approach

**Files:** `src/cli/commands/install.ts` (+ test), `targets/opencode/plugins/sentinal.ts` (+ test)
**Strategy:**
- Extract pure `buildPluginList(existing, binary, pluginPath)` helper in install.ts (repo's testable-function convention): filters `sentinal`-containing entries; binary mode returns filtered list (or `undefined` when empty → key removed/omitted); npm mode appends `pluginPath`. Wire into both config branches (existing-config + fresh-config).
- Extract pure `parseBinaryVersion(stdout)` in sentinal.ts: trim → match `/^\d+\.\d+\.\d+/` → string or null; use in `getBinaryVersion()`.
**Tests:** RED-first unit tests for both helpers; uninstall path unaffected (its sentinal-entry cleanup still valid for legacy installs).

## Progress

- [x] Task 1: Fix both defects (TDD)
- [x] Task 2: Verify
      **Tasks:** 2 | **Done:** 2 | **Left:** 0

## Tasks

### Task 1: Fix

**Objective:** RED tests for `buildPluginList` + `parseBinaryVersion` → implement → GREEN.
**Files:** `src/cli/commands/install.test.ts`, `src/cli/commands/install.ts`, `targets/opencode/plugins/sentinal.test.ts`, `targets/opencode/plugins/sentinal.ts`
**TDD:** Failing tests first (both helpers don't exist) → RED_CONFIRMED → implement + wire call sites → GREEN.
**Verify:** `bun test src/cli/commands/install.test.ts targets/opencode/plugins/sentinal.test.ts`

### Task 2: Verify

**Objective:** Full suite + tsc + builds + embed regen (install.ts changes don't affect embedded assets content, but plugin .ts does — regen required).
**Verify:** `bun test > /tmp/t.log 2>&1; echo $?` → 0; `bunx tsc --noEmit`; `bun run embed-assets && bun run build:all`; fresh-install sandbox shows single-load config (no sentinal in `config.plugin`)

## Verification Results

- **Tests:** 1507/1507 pass (11 new: 7 buildPluginList + 4 parseBinaryVersion); tsc clean; build:all + build:cli ok; embedded assets regenerated
- **Fresh-install sandbox (binary mode):** `plugin` key omitted from opencode.json; sentinal.mjs in plugins/ → single load path
- **Legacy-upgrade sandbox:** existing `["./plugins/sentinal.mjs", "opencode-wakatime"]` → `["opencode-wakatime"]` after install; third-party entries preserved
- **parseBinaryVersion:** literal "undefined"/garbage/empty → null (no bogus respawn); semver + prerelease/build suffixes accepted
