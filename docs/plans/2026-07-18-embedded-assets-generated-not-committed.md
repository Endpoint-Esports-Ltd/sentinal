# Stop Committing Generated embedded-assets.ts (auto-generate + drift guard) Fix Plan

Created: 2026-07-18
Status: VERIFIED
Approved: Yes
Iterations: 1
Worktree: No
Type: Bugfix

## Summary

**Symptom:** `src/cli/embedded-assets.ts` is an auto-generated file that is checked into git and must be manually regenerated (`bun run embed-assets`) after any `targets/**` change. Forgetting this step ships stale assets to users — exactly how the `spec-master-plan` frontmatter bug reached production. The generated file also carries a `Generated at:` timestamp, so it produces noisy, non-reproducible diffs on every regeneration.

**Trigger:** Any edit under `targets/**` (skills, commands, rules, configs, plugin bundle) requires a human to remember to run `embed-assets` and commit the 80+ line regenerated artifact. There is no CI guard that the committed copy is in sync with `targets/`.

**Root Cause:** Process/architecture defect, not a code bug. `embedded-assets.ts` is a **generated artifact tracked in source control** (`git ls-files` confirms it's the ONLY generated file tracked — the sibling generated bundle `targets/opencode/dist/sentinal.mjs` is correctly gitignored via `dist/`). Every real consumer already regenerates it (`build:cli` → `embed-assets` at package.json:39; release via `scripts/release-build.mjs:38-40`), so the committed contents are **never authoritative for shipped binaries** — they only exist to satisfy import resolution for the source tree and `bun test`. Committing a regenerated-on-every-build file invites drift and was the delivery-path footgun behind the master-skill bug.

## Investigation

- **Consumption map (verified):**
  - Release binary — `scripts/release-build.mjs:38-40` runs `build:opencode` + `embed-assets` before `bun build --compile`. Committed copy irrelevant.
  - Local `build:cli` — package.json:39 prefixes `bun run embed-assets &&`. Committed copy irrelevant.
  - Dev/source install — `src/cli/commands/install.ts:383` `isBinaryMode()===false` branch copies from the **live `targets/` tree** (`copyDirRecursive`), NOT from `embedded-assets.ts`. Committed copy irrelevant.
  - The committed `embedded-assets.ts` is consumed by **nothing** except import resolution (compile) + the tests that assert on it.
- **Importers (must exist at compile/test time):** source — `src/cli/commands/install.ts:82`, `src/cli/commands/update.ts`; tests — `src/opencode/plugin-exports.test.ts`, `src/cli/target-assets.test.ts`, `src/utils/file-length.test.ts`. All import unconditionally; contents only matter in binary/bundled mode.
- **Non-reproducible by design:** `scripts/embed-assets.mjs:143` emits ` * Generated at: ${new Date().toISOString()}`. Re-running produces a timestamp-only diff every time (verified: two runs 2.3h apart differ solely on that line). ⚠️ **A naive `git diff --exit-code` drift guard would ALWAYS fail** — the timestamp MUST be removed from the generated output (or normalized) for "generate-then-compare" to be viable.
- **CI today:** `.github/workflows/release.yml:23-24` runs `bun install && bun test` with the file committed. The `test` job installs ONLY Bun (no `setup-node`). ⚠️ **`embed-assets` currently shells out to `node scripts/embed-assets.mjs` (package.json:38, release-build.mjs:40)** — if generation runs in the Bun-only test job it must use `bun scripts/embed-assets.mjs` instead, else it fails with node-not-found.
- **`bun test` does NOT run `pretest`.** CI runs `bun test` directly (not `bun run test`), so a `pretest` script never fires (reviewer-confirmed). The correct generation trigger for tests is the existing **`bunfig.toml` `[test] preload`** mechanism (already used for sqlite-vec via `src/memory/test-preload.ts`). A preload that generates-if-missing is the right hook.
- **🔴 npm publish is the critical constraint (reviewer-confirmed).** The package publishes RAW SOURCE (`exports["."] = "./src/index.ts"`), so the runtime REQUIRES `embedded-assets.ts` in the tarball (imported at `install.ts:82`). There is NO `files` field and NO `.npmignore`, so `@semantic-release/npm`'s `npm publish` falls back to `.gitignore` to filter tarball contents. **Verified via `npm pack --dry-run`: the tarball currently includes `src/cli/embedded-assets.ts` (993 KB).** Simply gitignoring it would EXCLUDE it from the published package and break `sentinal install` for every npm user. Therefore option (A) must ALSO (a) regenerate the file before pack (`prepack`/`prepare`), and (b) add an explicit `files` allowlist — npm `files` INCLUDES listed paths even when `.gitignore` would exclude them. Must re-verify with `npm pack --dry-run` after the change.
- **devDependencies DO exist** (package.json:13-21: typescript, @types/node, bun-types, semantic-release plugins). `embed-assets` only needs `bun build` + node/bun stdlib, so bootstrapping risk is LOW.
- **Determinism:** `readDir`/`readSkillDirs` already `.sort()` (embed-assets.mjs:32,46) — the `Generated at:` timestamp (line 143) is the ONLY nondeterminism source; removing it is necessary AND sufficient (reviewer-confirmed).
- **Double-generation is harmless:** `prepare` firing during release's `bun install` plus `release-build.mjs` regenerating is idempotent; `@semantic-release/git` assets (`package.json`, `VERSION`, `CHANGELOG.md`) correctly exclude `embedded-assets.ts`, so it's never re-committed.
- **`.gitignore` today:** `dist/`, `targets/claude-code/hooks/dist/`, `*.tsbuildinfo`, etc. `targets/opencode/dist/sentinal.mjs` already ignored via `dist/`. `embedded-assets.ts` is the lone tracked generated file.
- **Recurrence signal:** a prior plan `docs/plans/2026-06-10-update-stale-embedded-assets.md` addressed this exact staleness problem before — this structural fix removes the root footgun.
- **Prior fix (obs #372/#374):** the master-skill bug's "run embed-assets and commit it" step treated the committed artifact as the delivery path — it isn't. This plan removes the footgun that made that mistake possible.

## Behavior Contract

### Fix Property (C => P)

**When condition C holds:** A contributor edits `targets/**` and runs the normal dev flow (`bun install` / `bun test` / `bun run build:cli`) WITHOUT manually running `embed-assets`, OR CI runs on a fresh checkout where `embedded-assets.ts` is absent.
**Property P must hold:** (1) `embedded-assets.ts` is generated automatically before any compile/test/build consumes it, so imports resolve and shipped binaries always contain current `targets/` content; (2) the file is untracked (in `.gitignore`), so no stale copy can be committed; (3) a CI drift/freshness guard fails the build if generation would change anything meaningful (timestamp excluded).

### Preservation Property (!C => unchanged)

**When condition C does NOT hold:** Normal builds/releases where assets are up to date.
**Existing behavior preserved:** Release binaries, `build:cli`, and dev install all still embed identical `targets/` content (they already regenerate). All existing tests that import `EMBEDDED_*` constants still pass. The `deploy:opencode` and MCP/plugin runtime behavior is unchanged. No change to what users receive.

## Fix Approach

**Files:**

- `scripts/embed-assets.mjs` — remove the non-deterministic `Generated at:` timestamp line (make output reproducible). Keep the "AUTO-GENERATED, DO NOT EDIT" header.
- `package.json`:
  - Change `"embed-assets"` to call **`bun scripts/embed-assets.mjs`** (not `node ...`) so it runs in the Bun-only CI test job. (Also update `scripts/release-build.mjs:40` `execSync` to `bun scripts/embed-assets.mjs` for consistency — it currently runs under node during release, where node exists, but Bun-first is safer and uniform.)
  - Add `"prepare": "bun run embed-assets"` — runs on `bun install` (contributors + CI) AND before `npm publish`/`npm pack` (npm runs `prepare` during pack), so the tarball always contains a freshly generated file.
  - Add a **`"files"` allowlist** that INCLUDES `src/cli/embedded-assets.ts` (plus whatever the package currently ships — derive the current tarball contents from `npm pack --dry-run` and codify the needed paths: `src/`, `targets/`, `bin/`, etc.). npm `files` overrides `.gitignore` exclusions, so the generated file ships even though it's gitignored. **Re-verify with `npm pack --dry-run` that `embedded-assets.ts` is present and nothing required went missing.**
  - Do NOT rely on `pretest` — `bun test` does not run it (see Investigation). Test generation is handled by the bunfig preload below.
- `bunfig.toml` — add a generation preload to `[test] preload` (e.g. `./src/cli/embed-assets-preload.ts`) that generates `embedded-assets.ts` **if missing** (cheap existence check; skip if present to keep tests fast). Model on `src/memory/test-preload.ts`.
- `src/cli/embed-assets-preload.ts` (new) — the preload: if `src/cli/embedded-assets.ts` is absent, run the generator (import the generation logic or spawn `bun scripts/embed-assets.mjs`).
- `.gitignore` — add `src/cli/embedded-assets.ts`.
- `git rm --cached src/cli/embedded-assets.ts` — untrack, keep on disk.
- `.github/workflows/release.yml` — in the `test` job, add an explicit generation + **determinism guard** step BEFORE `bun test` (belt-and-suspenders even though `prepare` fires on install): run `bun run embed-assets` twice and assert byte-identical output, then a content-presence assertion (e.g. `EMBEDDED_OC_SKILLS` contains `name: spec-master-plan`). Git-diff drift guards are N/A now that the file is untracked.

**Strategy:** Mirror how `targets/opencode/dist/sentinal.mjs` is already handled (generated, gitignored, rebuilt by every consumer) — BUT because the npm package ships raw source, additionally guarantee the file lands in the published tarball via `prepare` (regenerate before pack) + `files` allowlist (include despite gitignore). Make the generator deterministic first so "generate then verify" is meaningful. Wire generation into `prepare` (install/pack) and the bunfig test preload so no human step is ever required.

**Tests:**

- New `src/cli/embed-assets.test.ts` asserting the generator is **deterministic** — two runs yield byte-identical output (guards against re-introducing a timestamp/nondeterminism). Capture the generated string twice and compare.
- Adapt the existing `target-assets.test.ts` `EMBEDDED_OC_SKILLS` sync assertion — now validates the freshly-generated (preload) copy rather than a committed one; ensure it still passes.
- Non-test verification: simulate a fresh checkout — `rm src/cli/embedded-assets.ts` then run `bun test` (preload regenerates) and separately `bun run embed-assets`; both must succeed. Plus `npm pack --dry-run` must list `embedded-assets.ts`.

**Defense-in-depth:** Four independent guarantees so the footgun cannot recur: (1) `.gitignore` — impossible to commit a stale copy; (2) `prepare` — regenerated on every install AND before npm pack; (3) bunfig test preload — regenerated before tests if missing; (4) CI determinism + content guard — build fails if generation breaks or drifts. The `files` allowlist ensures the published npm tarball is never missing the file despite the gitignore.

## Progress

- [x] Task 1: Make generator deterministic + untrack/ignore + wire lifecycle hooks + CI guard (with tests)
- [x] Task 2: Verify
      **Tasks:** 2 | **Done:** 2 | **Left:** 0

### Deviation (auto-fix, documented)

- **Used `prepack` instead of `prepare`** for the npm-tarball freshness guarantee. `prepare` runs on a consumer's `npm install` too (verified via npm docs), which would force generation (`bun build` + `targets/`) on end-user machines — a new footgun. `prepack` runs ONLY when the tarball is created (`npm pack`/`npm publish`), keeping the published tarball fresh without imposing generation on consumers (who receive the file via the `files` allowlist). Contributor/CI generation is handled by the bunfig test preload + `build:cli`/CI guard, so `prepare` was unnecessary.
- **Added `scripts/check-embed-assets.mjs`** (determinism + content guard) rather than inline YAML — cleaner and locally runnable.

## Tasks

### Task 1: Fix

**Objective:** Make `embed-assets` deterministic and Bun-run; untrack + gitignore the generated file while KEEPING it in the npm tarball via `prepare` + `files`; auto-generate before tests via a bunfig preload; guard determinism/content in CI.
**Files:** `scripts/embed-assets.mjs`, `scripts/release-build.mjs`, `package.json`, `bunfig.toml`, `src/cli/embed-assets-preload.ts` (new), `.gitignore`, `.github/workflows/release.yml`, `src/cli/embed-assets.test.ts` (new determinism test), `src/cli/target-assets.test.ts` (adapt embedded-sync assertion), and `git rm --cached src/cli/embedded-assets.ts`.
**TDD:**
1. **RED:** Add `src/cli/embed-assets.test.ts` asserting the generator produces byte-identical output across two runs (fails now due to the `Generated at:` timestamp).
2. **GREEN:** Remove the timestamp line from `scripts/embed-assets.mjs`; confirm the determinism test passes.
3. Switch `embed-assets` to `bun scripts/embed-assets.mjs` in package.json (and `release-build.mjs` execSync).
4. Add `src/cli/embedded-assets.ts` to `.gitignore`; `git rm --cached src/cli/embedded-assets.ts` (keep on disk).
5. Add `"prepare": "bun run embed-assets"` and a `"files"` allowlist to package.json that includes `src/cli/embedded-assets.ts`. **Run `npm pack --dry-run` and confirm the file is present AND no currently-shipped path was dropped** (compare against the pre-change dry-run inventory).
6. Add `src/cli/embed-assets-preload.ts` (generate-if-missing) and register it in `bunfig.toml` `[test] preload`.
7. Add the CI determinism + content guard step to `release.yml` `test` job (two-run byte compare + `EMBEDDED_OC_SKILLS` contains `name: spec-master-plan`).
8. Simulate a fresh checkout: `rm src/cli/embedded-assets.ts` → run `bun test` (preload regenerates) → green; confirm regenerated.
**Verify:** `bun test src/cli/embed-assets.test.ts src/cli/target-assets.test.ts --verbose`; `git check-ignore src/cli/embedded-assets.ts`; `npm pack --dry-run | grep embedded-assets`.

### Task 2: Verify

**Objective:** Full suite + type check + fresh-checkout simulation + npm-tarball verification + release-path sanity.
**Verify:**
- `bun test && bunx tsc --noEmit`
- Fresh-checkout: `rm src/cli/embedded-assets.ts && bun test` (preload regenerates, suite green)
- npm ship: `npm pack --dry-run` lists `src/cli/embedded-assets.ts`
- Ignore state: `git check-ignore src/cli/embedded-assets.ts` reports ignored; `git ls-files src/cli/embedded-assets.ts` is empty
- Determinism: run `bun run embed-assets` twice, `diff` the two outputs → identical
